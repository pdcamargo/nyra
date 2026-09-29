//! An in-memory desktop, for testing every rule above the OS line with no UI.

use parking_lot::Mutex;
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::safety::Chord;
use super::*;

pub type Tree = RawElement<u32>;

#[derive(Default)]
pub struct State {
    pub apps: Vec<AppInfo>,
    pub windows: HashMap<String, Vec<WindowInfo>>,
    pub trees: HashMap<(String, String), Tree>,
    pub dead: HashSet<u32>,
    pub values: HashMap<u32, String>,
    pub no_press: HashSet<u32>,
    pub log: Vec<String>,
    /// The last input event the "OS" saw — ours or the user's.
    pub last_input: Option<Instant>,
    pub granted: bool,
    /// Screen Recording, separately: the two are granted separately.
    pub capture: bool,
    pub requests: usize,
}

/// Just enough of a PNG for `png_size` to read.
pub fn png_header(w: u32, h: u32) -> Vec<u8> {
    let mut v = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec();
    v.extend_from_slice(&w.to_be_bytes());
    v.extend_from_slice(&h.to_be_bytes());
    v
}

#[derive(Clone, Default)]
pub struct Fake(pub Arc<Mutex<State>>);

const BLOCK: &[BlockRule] = &[
    BlockRule { id: Some("fake.keychain"), name: None, title: None, why: "it stores passwords" },
    BlockRule { id: Some("fake.settings"), name: None, title: Some("Privacy"), why: "privacy switches" },
];
const WARN: &[WarnRule] = &[WarnRule { id: Some("fake.finder"), name: None, text: "can move or delete any file" }];

impl Fake {
    fn find(&self, h: u32) -> Option<Tree> {
        fn walk(t: &Tree, h: u32) -> Option<Tree> {
            if t.handle == h {
                return Some(t.clone());
            }
            t.children.iter().find_map(|c| walk(c, h))
        }
        self.0.lock().trees.values().find_map(|t| walk(t, h))
    }
}

impl Backend for Fake {
    type Handle = u32;

    fn blocklist(&self) -> &'static [BlockRule] {
        BLOCK
    }
    fn warnlist(&self) -> &'static [WarnRule] {
        WARN
    }
    fn app_matches(&self, id: &AppId, pattern: &str) -> bool {
        id.0 == pattern
    }
    fn mod_is_cmd(&self) -> bool {
        true
    }
    fn permissions(&self) -> Vec<PermissionEntry> {
        let s = self.0.lock();
        vec![
            PermissionEntry {
                kind: PermissionKind::ControlInput,
                granted: s.granted,
                reason: "Nyra needs Accessibility".into(),
                fix: Some(Fix { label: "Open Accessibility settings".into(), target: "fake://ax".into() }),
            },
            PermissionEntry {
                kind: PermissionKind::CaptureScreen,
                granted: s.capture,
                reason: "Nyra needs Screen Recording".into(),
                fix: Some(Fix { label: "Open Screen Recording settings".into(), target: "fake://sr".into() }),
            },
        ]
    }
    fn request_permission(&self, kind: PermissionKind) -> bool {
        let mut s = self.0.lock();
        s.requests += 1;
        match kind {
            PermissionKind::ControlInput => s.granted,
            PermissionKind::CaptureScreen => s.capture,
        }
    }
    fn list_apps(&self) -> Result<Vec<AppInfo>> {
        Ok(self.0.lock().apps.clone())
    }
    fn find_app(&self, query: &str) -> Option<(AppId, String)> {
        self.0
            .lock()
            .apps
            .iter()
            .find(|a| a.name.eq_ignore_ascii_case(query))
            .map(|a| (a.id.clone(), a.name.clone()))
    }
    fn list_windows(&self, app: &AppInfo) -> Result<Vec<WindowInfo>> {
        Ok(self.0.lock().windows.get(&app.id.0).cloned().unwrap_or_default())
    }
    fn element_tree(&self, app: &AppInfo, window: &WindowKey, _limits: Limits) -> Result<Tree> {
        self.0.lock().trees.get(&(app.id.0.clone(), window.0.clone())).cloned().ok_or(DesktopError::Gone)
    }
    fn menu_bar(&self, _app: &AppInfo, _limits: Limits) -> Result<Tree> {
        Err(DesktopError::Unsupported("no menu bar".into()))
    }
    fn is_alive(&self, h: &u32) -> bool {
        !self.0.lock().dead.contains(h)
    }
    fn is_secure(&self, h: &u32) -> bool {
        self.find(*h).is_some_and(|e| e.secure)
    }
    fn read_value(&self, h: &u32) -> Option<String> {
        self.0.lock().values.get(h).cloned()
    }
    fn perform(&self, h: &u32, action: &Action) -> Result<Raised> {
        let mut s = self.0.lock();
        if *action == Action::Press && s.no_press.contains(h) {
            return Err(DesktopError::Unsupported("no press".into()));
        }
        if let Action::SetValue(v) = action {
            s.values.insert(*h, v.clone());
        }
        s.log.push(format!("{action:?} {h}"));
        Ok(Raised(false))
    }
    fn type_text(&self, _app: &AppInfo, h: &u32, text: &str) -> Result<Raised> {
        let mut s = self.0.lock();
        s.values.entry(*h).or_default().push_str(text);
        s.log.push(format!("type {h} {text}"));
        // Both real OSes count synthesised input as input.
        s.last_input = Some(Instant::now());
        Ok(Raised(false))
    }
    fn press_keys(&self, _app: &AppInfo, _w: &WindowKey, chord: &Chord) -> Result<Raised> {
        let mut s = self.0.lock();
        s.log.push(format!("keys {chord}"));
        s.last_input = Some(Instant::now());
        Ok(Raised(true))
    }
    fn click_at(&self, _app: &AppInfo, _w: &WindowKey, p: Point) -> Result<Raised> {
        let mut s = self.0.lock();
        s.log.push(format!("click {:.0},{:.0}", p.x, p.y));
        s.last_input = Some(Instant::now());
        Ok(Raised(false))
    }
    fn capture_window(&self, _app: &AppInfo, _w: &WindowKey, width: u32) -> Result<Vec<u8>> {
        let mut s = self.0.lock();
        s.log.push(format!("capture {width}"));
        Ok(png_header(width, width * 3 / 4))
    }
    fn app_icon(&self, _app: &AppInfo) -> Option<Vec<u8>> {
        Some(png_header(64, 64))
    }
    fn open(&self, target: &Target) -> Result<String> {
        self.0.lock().log.push(format!("open {target:?}"));
        Ok(format!("{target:?}"))
    }
    fn seconds_since_user_input(&self) -> f64 {
        self.0.lock().last_input.map(|t| t.elapsed().as_secs_f64()).unwrap_or(100.0)
    }
}

#[derive(Default)]
pub struct HostState {
    pub answers: VecDeque<Answer>,
    pub asked: Vec<(String, String, Option<&'static str>)>,
    pub always: HashSet<String>,
    pub controlling: Vec<(String, Option<String>)>,
    pub blocked: Vec<Blocked>,
    pub seen: Vec<Seen>,
}

#[derive(Clone, Default)]
pub struct FakeHost(pub Arc<Mutex<HostState>>);

impl Host for FakeHost {
    fn ask_allow<'a>(
        &'a self,
        chat: &'a str,
        app: &'a AppInfo,
        warning: Option<&'static str>,
    ) -> BoxFuture<'a, std::result::Result<Answer, String>> {
        Box::pin(async move {
            let mut s = self.0.lock();
            s.asked.push((chat.to_string(), app.name.clone(), warning));
            let answer = s.answers.pop_front().ok_or_else(|| "nobody answered".to_string())?;
            // What the renderer does with "always": write it to settings.
            if answer == Answer::Always {
                s.always.insert(app.id.0.clone());
            }
            Ok(answer)
        })
    }
    fn always_allowed(&self, id: &AppId) -> bool {
        self.0.lock().always.contains(&id.0)
    }
    fn controlling(&self, chat: &str, app: Option<&str>) {
        self.0.lock().controlling.push((chat.to_string(), app.map(str::to_string)));
    }
    fn blocked(&self, _chat: &str, _kind: PermissionKind, blocked: &Blocked) {
        self.0.lock().blocked.push(blocked.clone());
    }
    fn seen(&self, _chat: &str, seen: &Seen) {
        self.0.lock().seen.push(seen.clone());
    }
}

// ---------------------------------------------------------------------------
// Building a desktop
// ---------------------------------------------------------------------------

pub fn el(handle: u32, role: Role, label: &str, children: Vec<Tree>) -> Tree {
    RawElement {
        handle,
        role,
        label: label.into(),
        value: None,
        frame: Some(Rect { x: 100.0 + handle as f64, y: 100.0, w: 40.0, h: 20.0 }),
        enabled: true,
        focused: false,
        offscreen: None,
        secure: false,
        children,
        children_truncated: false,
    }
}

pub fn root(children: Vec<Tree>) -> Tree {
    el(0, Role::Other("window".into()), "", children)
}

const FRAME: Rect = Rect { x: 0.0, y: 0.0, w: 1000.0, h: 800.0 };

pub fn window(key: &str, title: &str) -> WindowInfo {
    WindowInfo { key: WindowKey(key.into()), title: title.into(), frame: Some(FRAME), focused: true, blocked: None }
}

pub fn add_app(fake: &Fake, id: &str, name: &str, title: &str, tree: Tree) {
    let mut s = fake.0.lock();
    let pid = 100 + s.apps.len() as u32;
    s.apps.push(AppInfo { id: AppId(id.into()), name: name.into(), pid, frontmost: false });
    s.windows.insert(id.into(), vec![window("w1", title)]);
    s.trees.insert((id.into(), "w1".into()), tree);
}

pub fn quick() -> GuardTiming {
    GuardTiming {
        quiet: Duration::from_millis(1000),
        wait: Duration::from_millis(150),
        poll: Duration::from_millis(20),
    }
}

pub fn desktop() -> (Desktop<Fake, FakeHost>, Fake, FakeHost) {
    let fake = Fake::default();
    fake.0.lock().granted = true;
    let host = FakeHost::default();
    let scratch = std::env::temp_dir().join(format!("nyra-desktop-test-{}", crate::util::rand_hex(6)));
    (Desktop::new(fake.clone(), host.clone(), quick(), scratch), fake, host)
}

pub fn mail_tree() -> Tree {
    let mut to = el(2, Role::TextField, "To", vec![]);
    to.focused = true;
    let mut pw = el(3, Role::TextField, "Password", vec![]);
    pw.secure = true;
    root(vec![el(
        1,
        Role::Group,
        "",
        vec![to, pw, el(4, Role::Button, "Send", vec![]), el(5, Role::Button, "Bold", vec![])],
    )])
}

fn act(app: &str, r: Option<&str>, action: &str) -> ActArgs {
    ActArgs { app: app.into(), r#ref: r.map(str::to_string), action: action.into(), ..Default::default() }
}

fn ref_for(snapshot: &str, label: &str) -> String {
    let line = snapshot.lines().find(|l| l.contains(&format!("\"{label}\""))).expect(label);
    line.trim().split(']').next().unwrap().trim_start_matches('[').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (Desktop<Fake, FakeHost>, Fake, FakeHost) {
        let (d, fake, host) = desktop();
        add_app(&fake, "fake.mail", "Mail", "Inbox", mail_tree());
        (d, fake, host)
    }

    #[tokio::test]
    async fn the_first_touch_asks_and_this_chat_stays_in_this_chat() {
        let (d, _fake, host) = setup();
        host.0.lock().answers.push_back(Answer::ThisChat);
        d.snapshot("chat-a", "Mail", None, None).await.unwrap();
        // Asked once, and not again in the same chat.
        d.snapshot("chat-a", "Mail", None, None).await.unwrap();
        assert_eq!(host.0.lock().asked.len(), 1);

        // Another chat is asked for itself.
        host.0.lock().answers.push_back(Answer::No);
        let refused = d.snapshot("chat-b", "Mail", None, None).await.unwrap_err();
        assert!(refused.contains("said no"), "{refused}");
        // And "no" is remembered: refused again without a second question.
        d.snapshot("chat-b", "Mail", None, None).await.unwrap_err();
        assert_eq!(host.0.lock().asked.len(), 2);
    }

    #[tokio::test]
    async fn always_carries_to_every_chat() {
        let (d, _fake, host) = setup();
        host.0.lock().answers.push_back(Answer::Always);
        d.snapshot("chat-a", "Mail", None, None).await.unwrap();
        d.snapshot("chat-b", "Mail", None, None).await.unwrap();
        assert_eq!(host.0.lock().asked.len(), 1);
    }

    #[tokio::test]
    async fn no_answer_is_a_refusal_not_a_yes() {
        let (d, _fake, _host) = setup();
        let err = d.snapshot("chat-a", "Mail", None, None).await.unwrap_err();
        assert!(err.contains("Ask them in chat"), "{err}");
    }

    #[tokio::test]
    async fn the_blocklist_beats_always_and_is_never_asked_about() {
        let (d, fake, host) = setup();
        add_app(&fake, "fake.keychain", "Keychain Access", "Keychain", root(vec![]));
        host.0.lock().always.insert("fake.keychain".into());
        let err = d.snapshot("chat-a", "Keychain Access", None, None).await.unwrap_err();
        assert!(err.contains("off limits") && err.contains("passwords"), "{err}");
        assert!(host.0.lock().asked.is_empty());
        // Opening it is refused too.
        let err = d.open("chat-a", "Keychain Access").await.unwrap_err();
        assert!(err.contains("off limits"), "{err}");
    }

    #[tokio::test]
    async fn nyra_itself_is_off_limits() {
        let (d, fake, host) = setup();
        fake.0.lock().apps.push(AppInfo {
            id: AppId("whatever".into()),
            name: "Me".into(),
            pid: std::process::id(),
            frontmost: false,
        });
        host.0.lock().always.insert("whatever".into());
        let err = d.snapshot("chat-a", "Me", None, None).await.unwrap_err();
        assert!(err.contains("Nyra itself"), "{err}");
    }

    #[tokio::test]
    async fn a_window_that_navigates_into_a_blocked_pane_is_caught_on_the_next_call() {
        let (d, fake, host) = setup();
        add_app(&fake, "fake.settings", "Settings", "General", root(vec![el(9, Role::Button, "Wi-Fi", vec![])]));
        host.0.lock().always.insert("fake.settings".into());
        let snap = d.snapshot("c", "Settings", None, None).await.unwrap();
        let wifi = ref_for(&snap, "Wi-Fi");

        fake.0.lock().windows.get_mut("fake.settings").unwrap()[0].title = "Privacy & Security".into();
        let err = d.act("c", act("Settings", Some(&wifi), "press")).await.unwrap_err();
        assert!(err.contains("off limits"), "{err}");
        assert!(fake.0.lock().log.is_empty(), "it acted anyway");
    }

    #[tokio::test]
    async fn a_password_field_is_never_typed_into_or_set() {
        let (d, fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        let snap = d.snapshot("c", "Mail", None, None).await.unwrap();
        let pw = ref_for(&snap, "Password");
        for action in ["type", "set_value"] {
            let mut a = act("Mail", Some(&pw), action);
            a.text = Some("hunter2".into());
            let err = d.act("c", a).await.unwrap_err();
            assert!(err.contains("password field"), "{err}");
        }
        assert!(fake.0.lock().log.is_empty());
    }

    #[tokio::test]
    async fn send_needs_confirmation_and_bold_does_not() {
        let (d, fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        let snap = d.snapshot("c", "Mail", None, None).await.unwrap();
        assert!(snap.contains("button \"Send\" ⚠ irreversible"), "{snap}");

        let send = ref_for(&snap, "Send");
        let err = d.act("c", act("Mail", Some(&send), "press")).await.unwrap_err();
        assert!(err.contains("Ask the user first") && err.contains("confirmed:true"), "{err}");
        assert!(fake.0.lock().log.is_empty());

        let mut yes = act("Mail", Some(&send), "press");
        yes.confirmed = true;
        d.act("c", yes).await.unwrap();
        assert_eq!(fake.0.lock().log, vec!["Press 4"]);

        let bold = ref_for(&snap, "Bold");
        d.act("c", act("Mail", Some(&bold), "press")).await.unwrap();
    }

    #[tokio::test]
    async fn return_in_a_window_with_a_send_button_is_held_to_the_same_rule() {
        let (d, fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        d.snapshot("c", "Mail", None, None).await.unwrap();
        let mut keys = act("Mail", None, "keys");
        keys.keys = Some("cmd+return".into());
        let err = d.act("c", keys.clone()).await.unwrap_err();
        assert!(err.contains("confirmed:true"), "{err}");
        keys.confirmed = true;
        d.act("c", keys).await.unwrap();
        assert_eq!(fake.0.lock().log, vec!["keys cmd+return"]);
    }

    #[tokio::test]
    async fn a_coordinate_press_on_a_send_button_is_gated_too() {
        let (d, fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        d.snapshot("c", "Mail", None, None).await.unwrap();
        // Send (handle 4) sits at x 104..144, y 100..120.
        let mut a = act("Mail", None, "press");
        a.x = Some(110.0);
        a.y = Some(110.0);
        assert!(d.act("c", a.clone()).await.unwrap_err().contains("confirmed:true"));
        a.x = Some(600.0);
        d.act("c", a).await.unwrap();
        assert_eq!(fake.0.lock().log, vec!["click 600,110"]);
    }

    #[tokio::test]
    async fn waits_for_the_user_to_stop_typing_then_gives_up() {
        let (d, fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        let snap = d.snapshot("c", "Mail", None, None).await.unwrap();
        let to = ref_for(&snap, "To");

        // The user is typing.
        fake.0.lock().last_input = Some(Instant::now());
        let mut a = act("Mail", Some(&to), "type");
        a.text = Some("bob".into());
        let err = d.act("c", a.clone()).await.unwrap_err();
        assert!(err.contains("keyboard or mouse"), "{err}");
        assert!(fake.0.lock().log.is_empty());

        // They stopped a while ago.
        fake.0.lock().last_input = Some(Instant::now() - Duration::from_secs(5));
        d.act("c", a.clone()).await.unwrap();
        // Straight away again: the only recent input is our own, so go ahead.
        d.act("c", a).await.unwrap();
        assert_eq!(fake.0.lock().log.len(), 2);
    }

    #[tokio::test]
    async fn esc_refuses_the_rest_of_the_turn_and_the_next_turn_starts_clean() {
        let (d, fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        let snap = d.snapshot("c", "Mail", None, None).await.unwrap();
        let bold = ref_for(&snap, "Bold");
        d.act("c", act("Mail", Some(&bold), "press")).await.unwrap();
        assert!(d.any_controlling());
        assert_eq!(host.0.lock().controlling.last().unwrap().1.as_deref(), Some("Mail"));

        assert_eq!(d.halt_controlling(), vec!["c".to_string()]);
        assert!(!d.any_controlling());
        assert_eq!(host.0.lock().controlling.last().unwrap().1, None);
        for err in [
            d.act("c", act("Mail", Some(&bold), "press")).await.unwrap_err(),
            d.snapshot("c", "Mail", None, None).await.unwrap_err(),
            d.open("c", "Mail").await.unwrap_err(),
        ] {
            assert!(err.contains("stopped desktop control"), "{err}");
        }

        d.turn_started("c");
        d.snapshot("c", "Mail", None, None).await.unwrap();
        assert_eq!(fake.0.lock().log.len(), 1);
    }

    #[tokio::test]
    async fn the_end_of_a_turn_ends_control() {
        let (d, _fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        let snap = d.snapshot("c", "Mail", None, None).await.unwrap();
        d.act("c", act("Mail", Some(&ref_for(&snap, "Bold")), "press")).await.unwrap();
        d.turn_ended("c");
        assert!(!d.any_controlling());
        // Ending a turn is not Esc: the next call is fine.
        d.snapshot("c", "Mail", None, None).await.unwrap();
    }

    #[tokio::test]
    async fn an_old_ref_re_resolves_and_a_changed_one_fails() {
        let (d, fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        let first = d.snapshot("c", "Mail", None, None).await.unwrap();
        let bold = ref_for(&first, "Bold");
        d.snapshot("c", "Mail", None, None).await.unwrap();

        // From an older snapshot, but the element is where it was.
        d.act("c", act("Mail", Some(&bold), "press")).await.unwrap();
        assert_eq!(fake.0.lock().log, vec!["Press 5"]);

        // The app rebuilt its UI and the button is now "Italic".
        {
            let mut s = fake.0.lock();
            s.dead.insert(5);
            let tree = s.trees.get_mut(&("fake.mail".into(), "w1".into())).unwrap();
            tree.children[0].children[3] = el(6, Role::Button, "Italic", vec![]);
        }
        let err = d.act("c", act("Mail", Some(&bold), "press")).await.unwrap_err();
        assert!(err.contains("Take a new snapshot"), "{err}");
    }

    #[tokio::test]
    async fn an_unknown_ref_says_to_take_a_snapshot() {
        let (d, _fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        let err = d.act("c", act("Mail", Some("e999"), "press")).await.unwrap_err();
        assert!(err.contains("new snapshot"), "{err}");
    }

    #[tokio::test]
    async fn without_a_press_action_it_clicks_the_centre_and_says_so() {
        let (d, fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        fake.0.lock().no_press.insert(5);
        let snap = d.snapshot("c", "Mail", None, None).await.unwrap();
        let out = d.act("c", act("Mail", Some(&ref_for(&snap, "Bold")), "press")).await.unwrap();
        assert!(out.contains("real click"), "{out}");
        assert_eq!(fake.0.lock().log, vec!["click 125,110"]);
    }

    #[tokio::test]
    async fn typing_reads_back_and_the_result_names_the_app() {
        let (d, fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        let snap = d.snapshot("c", "Mail", None, None).await.unwrap();
        let mut a = act("Mail", Some(&ref_for(&snap, "To")), "type");
        a.text = Some("a line long enough to go in more than one chunk".into());
        let out = d.act("c", a).await.unwrap();
        assert!(out.contains("Typed 47 characters"), "{out}");
        assert!(out.contains("tell the user in one line what you did in Mail"), "{out}");
        assert!(!out.contains("doesn't contain"), "{out}");
        assert_eq!(fake.0.lock().values[&2], "a line long enough to go in more than one chunk");
    }

    #[tokio::test]
    async fn a_missing_permission_is_asked_for_once_and_explained() {
        let (d, fake, host) = setup();
        fake.0.lock().granted = false;
        host.0.lock().always.insert("fake.mail".into());
        let err = d.snapshot("c", "Mail", None, None).await.unwrap_err();
        assert!(err.contains("Accessibility") && err.contains("Open Accessibility settings"), "{err}");
        d.snapshot("c", "Mail", None, None).await.unwrap_err();
        assert_eq!(fake.0.lock().requests, 1, "prompted more than once");
        assert_eq!(host.0.lock().blocked.len(), 2);
    }

    #[tokio::test]
    async fn the_allow_prompt_carries_the_warning_for_broad_apps() {
        let (d, fake, host) = setup();
        add_app(&fake, "fake.finder", "Finder", "Home", root(vec![]));
        host.0.lock().answers.push_back(Answer::ThisChat);
        d.snapshot("c", "Finder", None, None).await.unwrap();
        assert_eq!(host.0.lock().asked[0].2, Some("can move or delete any file"));
    }

    #[tokio::test]
    async fn a_screenshot_needs_screen_recording_and_says_how_to_fix_it() {
        let (d, fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        let err = d.screenshot("c", "Mail", None).await.err().unwrap();
        assert!(err.contains("Screen Recording") && err.contains("Open Screen Recording settings"), "{err}");
        assert!(!fake.0.lock().log.iter().any(|l| l.starts_with("capture")), "captured without the permission");

        fake.0.lock().capture = true;
        let shot = d.screenshot("c", "Mail", None).await.unwrap();
        assert!(shot.text.contains("1000×750"), "{}", shot.text);
        assert!(shot.text.contains("x and y are pixels in this image"), "{}", shot.text);
        // What the miniature is told: the picture, the app, and its icon.
        let seen = host.0.lock().seen.last().cloned().unwrap();
        assert_eq!(seen.app, "Mail");
        assert!(seen.png.as_deref().is_some_and(|p| std::path::Path::new(p).is_file()));
        assert!(seen.icon.as_deref().is_some_and(|i| i.starts_with("data:image/png;base64,")));
    }

    #[tokio::test]
    async fn a_blocked_app_is_not_photographed_either() {
        let (d, fake, host) = setup();
        fake.0.lock().capture = true;
        add_app(&fake, "fake.keychain", "Keychain Access", "Keychain", root(vec![]));
        host.0.lock().always.insert("fake.keychain".into());
        assert!(d.screenshot("c", "Keychain Access", None).await.err().unwrap().contains("off limits"));
    }

    #[tokio::test]
    async fn x_and_y_are_read_in_the_screenshots_pixels() {
        let (d, fake, host) = setup();
        fake.0.lock().capture = true;
        host.0.lock().always.insert("fake.mail".into());
        // A window wider than a screenshot is sent at: every pixel is 2 points.
        fake.0.lock().windows.get_mut("fake.mail").unwrap()[0].frame = Some(Rect { x: 0.0, y: 0.0, w: 3136.0, h: 1600.0 });
        let shot = d.screenshot("c", "Mail", None).await.unwrap();
        assert!(shot.text.contains("1568×"), "{}", shot.text);

        let mut a = act("Mail", None, "press");
        a.x = Some(300.0);
        a.y = Some(200.0);
        d.act("c", a).await.unwrap();
        assert!(fake.0.lock().log.contains(&"click 600,400".to_string()), "{:?}", fake.0.lock().log);
    }

    #[tokio::test]
    async fn a_snapshot_previews_only_when_the_permission_is_already_held() {
        let (d, fake, host) = setup();
        host.0.lock().always.insert("fake.mail".into());
        d.snapshot("c", "Mail", None, None).await.unwrap();
        let seen = host.0.lock().seen.last().cloned().unwrap();
        // Told what was seen, with no picture, and nobody was asked for one.
        assert_eq!(seen.title, "Inbox");
        assert!(seen.png.is_none());
        assert_eq!(fake.0.lock().requests, 0);

        fake.0.lock().capture = true;
        d.snapshot("c", "Mail", None, None).await.unwrap();
        assert!(host.0.lock().seen.last().unwrap().png.is_some());
        assert!(fake.0.lock().log.contains(&"capture 600".to_string()));
    }

    #[tokio::test]
    async fn forgetting_a_chat_deletes_its_pictures() {
        let (d, fake, host) = setup();
        fake.0.lock().capture = true;
        host.0.lock().always.insert("fake.mail".into());
        d.screenshot("c", "Mail", None).await.unwrap();
        let png = host.0.lock().seen.last().unwrap().png.clone().unwrap();
        assert!(std::path::Path::new(&png).is_file());
        d.forget("c");
        assert!(!std::path::Path::new(&png).exists());
    }

    #[tokio::test]
    async fn apps_lists_what_is_blocked_and_what_is_allowed() {
        let (d, fake, host) = setup();
        add_app(&fake, "fake.keychain", "Keychain Access", "Keychain", root(vec![]));
        host.0.lock().always.insert("fake.mail".into());
        let out = d.apps("c").await.unwrap();
        assert!(out.contains("Mail — allowed"), "{out}");
        assert!(out.contains("1. \"Inbox\" (focused)"), "{out}");
        assert!(out.contains("Keychain Access — blocked"), "{out}");
    }
}
