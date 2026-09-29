//! Claude operating other apps: read a window's UI, press, type, open things.
//!
//! One OS-neutral half and one OS half, like `platform/`. Everything in this
//! directory other than `macos.rs`, `windows.rs` and `other.rs` is neutral:
//! the types, the snapshot text, ref bookkeeping, the allowlist, the blocklist
//! enforcement, the typing guard, the kill switch and the MCP server. None of it
//! knows an accessibility role name, a bundle id, a settings pane or a UIA
//! pattern. An app is an `AppId` the OS half wrote; this half compares and
//! stores it and never looks inside.
//!
//! **The contract is the `Backend` trait.** Each OS file has a `Native` that
//! implements it, and `pub use imp::Native` below is what makes a missing
//! primitive fail to compile on that OS — the same guarantee `platform/mod.rs`
//! gets from its `pub use`. The trait is also what lets every rule here run
//! against `fake.rs` in tests, with no UI on either OS.
//!
//! **Why the safety half is not optional.** On macOS every child process
//! inherits Nyra's TCC identity, so once Nyra holds Accessibility, any Bash a
//! chat runs can synthesise input too — the grant is much bigger than it looks.
//! Windows needs no grant at all. So these rules are the guard on both, and
//! they live here, once, rather than twice below the line:
//!
//! - a per-app allowlist the user answers in the renderer;
//! - a blocklist nobody can allow (`Backend::blocklist`, enforced here on every
//!   call, because a window's title can change under us);
//! - no reading or typing a secure field;
//! - no acting while the user is typing or moving the mouse;
//! - a kill switch (global Esc) that refuses the rest of the turn;
//! - sends, deletes, purchases and submits need `confirmed: true`.

pub mod indicator;
pub mod mcp;
mod safety;
mod snapshot;

#[cfg(test)]
mod fake;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as imp;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as imp;

#[cfg(not(any(target_os = "macos", windows)))]
mod other;
#[cfg(not(any(target_os = "macos", windows)))]
use other as imp;

pub use imp::Native;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use safety::Chord;
use snapshot::{RefEntry, WindowSeen};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// An app, as the OS half names it. A bundle id on macOS, an executable path
/// on Windows — which is exactly why nothing up here parses it.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
pub struct AppId(pub String);

#[derive(Debug, Clone)]
pub struct AppInfo {
    pub id: AppId,
    pub name: String,
    pub pid: u32,
    pub frontmost: bool,
}

/// A window, named by whatever the OS half can find it again with.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WindowKey(pub String);

#[derive(Debug, Clone)]
pub struct WindowInfo {
    pub key: WindowKey,
    pub title: String,
    pub frame: Option<Rect>,
    pub focused: bool,
    /// Set when this particular window cannot be driven — on Windows, one that
    /// runs elevated when Nyra does not. Per window, not per app, because the
    /// same app can have both kinds open.
    pub blocked: Option<Blocked>,
}

/// Screen coordinates, top-left origin, in the units the OS half clicks in.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub fn centre(&self) -> Point {
        Point { x: self.x + self.w / 2.0, y: self.y + self.h / 2.0 }
    }
    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.x && p.y >= self.y && p.x <= self.x + self.w && p.y <= self.y + self.h
    }
    pub fn intersects(&self, other: &Rect) -> bool {
        self.x < other.x + other.w
            && other.x < self.x + self.w
            && self.y < other.y + other.h
            && other.y < self.y + self.h
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

/// What an element is, in words both OSes can map into.
// The Windows stub constructs none of these yet; phase 3 does.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Role {
    Button,
    TextField,
    TextArea,
    Checkbox,
    Radio,
    MenuItem,
    MenuButton,
    Link,
    Text,
    Image,
    Group,
    List,
    Row,
    Cell,
    Tab,
    Toolbar,
    Slider,
    /// Anything else, already in plain words ("disclosure triangle").
    Other(String),
}

/// One element of a window's tree, as the OS half read it — unpruned.
#[derive(Debug, Clone)]
pub struct RawElement<H> {
    pub handle: H,
    pub role: Role,
    pub label: String,
    pub value: Option<String>,
    pub frame: Option<Rect>,
    pub enabled: bool,
    pub focused: bool,
    /// `Some(true)` when the OS says so. macOS has no such flag, so there it is
    /// `None` and the frame against the window decides.
    pub offscreen: Option<bool>,
    pub secure: bool,
    pub children: Vec<RawElement<H>>,
    /// The walk stopped here at its depth or node limit.
    pub children_truncated: bool,
}

/// How far the OS half may walk. Pushed down rather than applied afterwards,
/// because walking a large app's whole tree costs seconds.
// The Windows stub constructs none of these yet; phase 3 does.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub max_depth: usize,
    pub max_nodes: usize,
}

/// The verbs `perform` takes. Typing and keys are their own primitives because
/// they need different things of the OS.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Press,
    Focus,
    SetValue(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Target {
    App(String),
    Path(String),
    Url(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionKind {
    /// Reading other apps' UI and sending them input.
    ControlInput,
    /// Taking a picture of another app's window.
    CaptureScreen,
}

impl PermissionKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "controlInput" => Some(Self::ControlInput),
            "captureScreen" => Some(Self::CaptureScreen),
            _ => None,
        }
    }
}

/// How to fix something, as a button: the renderer shows `label` and opens
/// `target` through `Backend::open`. Neutral on purpose — the renderer never
/// learns what a settings pane is.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Fix {
    pub label: String,
    pub target: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct PermissionEntry {
    pub kind: PermissionKind,
    pub granted: bool,
    pub reason: String,
    pub fix: Option<Fix>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Blocked {
    pub reason: String,
    pub fix: Option<Fix>,
}

// The Windows stub constructs none of these yet; phase 3 does.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Debug, Clone, PartialEq)]
pub enum DesktopError {
    /// Cannot be done, and a silent no-op would have been the alternative.
    Blocked(Blocked),
    /// The element or OS has no way to do this; the caller may fall back.
    Unsupported(String),
    /// The element or window no longer exists.
    Gone,
    Failed(String),
}

impl DesktopError {
    fn text(&self) -> String {
        match self {
            DesktopError::Blocked(b) => match &b.fix {
                Some(f) => format!("Blocked: {}. The user can fix this with \"{}\".", b.reason, f.label),
                None => format!("Blocked: {}.", b.reason),
            },
            DesktopError::Unsupported(why) => format!("Not supported: {why}."),
            DesktopError::Gone => "That window or element is gone. Take a new snapshot.".into(),
            DesktopError::Failed(why) => format!("Failed: {why}."),
        }
    }
}

/// Whether doing something brought a window to the front. Said in the result,
/// because the user's screen just changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Raised(pub bool);

/// An app nobody can allow. `id` is matched by `Backend::app_matches`; `name`
/// against the app's display name; `title`, when set, narrows it to windows
/// whose title contains it.
#[derive(Debug, Clone, Copy)]
pub struct BlockRule {
    pub id: Option<&'static str>,
    pub name: Option<&'static str>,
    pub title: Option<&'static str>,
    pub why: &'static str,
}

/// An app that is allowed, but whose allow prompt says what allowing it means.
#[derive(Debug, Clone, Copy)]
pub struct WarnRule {
    pub id: Option<&'static str>,
    pub name: Option<&'static str>,
    pub text: &'static str,
}

pub type Result<T> = std::result::Result<T, DesktopError>;

/// The primitives. Synchronous and blocking; the engine runs them through
/// `spawn_blocking`, and the OS half bounds how long any one can hang.
pub trait Backend: Send + Sync + 'static {
    type Handle: Clone + Send + Sync + 'static;

    fn blocklist(&self) -> &'static [BlockRule];
    fn warnlist(&self) -> &'static [WarnRule];
    /// Does `id` match a rule's `id` pattern? The OS half owns what an id looks
    /// like, so it owns matching one too.
    fn app_matches(&self, id: &AppId, pattern: &str) -> bool;
    /// What `mod` in a chord means here: cmd, or ctrl.
    fn mod_is_cmd(&self) -> bool;

    fn permissions(&self) -> Vec<PermissionEntry>;
    /// Ask the OS for it, prompting if it prompts. Returns whether it is held now.
    fn request_permission(&self, kind: PermissionKind) -> bool;

    fn list_apps(&self) -> Result<Vec<AppInfo>>;
    /// An app by name or id, running or not — what `open` would launch.
    fn find_app(&self, query: &str) -> Option<(AppId, String)>;
    fn list_windows(&self, app: &AppInfo) -> Result<Vec<WindowInfo>>;
    fn element_tree(
        &self,
        app: &AppInfo,
        window: &WindowKey,
        limits: Limits,
    ) -> Result<RawElement<Self::Handle>>;
    /// The app's menu bar, as a tree.
    fn menu_bar(&self, app: &AppInfo, limits: Limits) -> Result<RawElement<Self::Handle>>;
    fn is_alive(&self, handle: &Self::Handle) -> bool;
    fn is_secure(&self, handle: &Self::Handle) -> bool;
    fn read_value(&self, handle: &Self::Handle) -> Option<String>;

    fn perform(&self, handle: &Self::Handle, action: &Action) -> Result<Raised>;
    /// Insert `text` at the element's caret.
    fn type_text(&self, app: &AppInfo, handle: &Self::Handle, text: &str) -> Result<Raised>;
    fn press_keys(&self, app: &AppInfo, window: &WindowKey, chord: &Chord) -> Result<Raised>;
    /// A real click at a screen point. Moves the pointer.
    fn click_at(&self, app: &AppInfo, window: &WindowKey, point: Point) -> Result<Raised>;
    /// Phase 2: `desktop_screenshot` and the miniature.
    #[allow(dead_code)]
    fn capture_window(&self, app: &AppInfo, window: &WindowKey) -> Result<Vec<u8>>;
    /// Returns what it opened, in words.
    fn open(&self, target: &Target) -> Result<String>;
    /// Phase 2: which app the miniature should prefer.
    #[allow(dead_code)]
    fn frontmost(&self) -> Option<AppId>;
    fn seconds_since_user_input(&self) -> f64;
}

// ---------------------------------------------------------------------------
// The host: what the engine needs from the app around it
// ---------------------------------------------------------------------------

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Answer {
    ThisChat,
    Always,
    No,
}

pub trait Host: Send + Sync + 'static {
    /// Ask the user whether this chat may use `app`.
    fn ask_allow<'a>(
        &'a self,
        chat: &'a str,
        app: &'a AppInfo,
        warning: Option<&'static str>,
    ) -> BoxFuture<'a, std::result::Result<Answer, String>>;
    /// Answered "always" before, in settings.
    fn always_allowed(&self, id: &AppId) -> bool;
    /// The chat started (`Some(app)`) or stopped (`None`) controlling something.
    fn controlling(&self, chat: &str, app: Option<&str>);
    /// A permission is missing, and the user can fix it with a button.
    fn blocked(&self, chat: &str, kind: PermissionKind, blocked: &Blocked);
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/// What the OS half may walk, and what the snapshot prints of it.
const WALK: Limits = Limits { max_depth: 40, max_nodes: 2500 };

#[derive(Debug, Clone, Copy)]
pub struct GuardTiming {
    /// Input more recent than this means someone is at the keyboard.
    pub quiet: Duration,
    /// How long to wait for them to stop before giving up.
    pub wait: Duration,
    pub poll: Duration,
}

impl Default for GuardTiming {
    fn default() -> Self {
        Self {
            quiet: Duration::from_millis(1000),
            wait: Duration::from_millis(1500),
            poll: Duration::from_millis(100),
        }
    }
}

struct ChatState<H> {
    halted: bool,
    allowed: HashSet<AppId>,
    denied: HashSet<AppId>,
    next_ref: u32,
    snapshot_no: u32,
    refs: HashMap<u32, RefEntry<H>>,
    windows: HashMap<(AppId, WindowKey), WindowSeen>,
    controlling: Option<String>,
}

impl<H> Default for ChatState<H> {
    fn default() -> Self {
        Self {
            halted: false,
            allowed: HashSet::new(),
            denied: HashSet::new(),
            next_ref: 1,
            snapshot_no: 0,
            refs: HashMap::new(),
            windows: HashMap::new(),
            controlling: None,
        }
    }
}

/// How many snapshots' refs a chat keeps. Older ones re-resolve by path while
/// they are kept, and are simply unknown after.
const KEPT_SNAPSHOTS: u32 = 4;

pub struct Desktop<B: Backend, H: Host> {
    backend: Arc<B>,
    host: H,
    chats: Mutex<HashMap<String, ChatState<B::Handle>>>,
    /// One cursor, one keyboard: one action at a time, across every chat.
    busy: tokio::sync::Mutex<()>,
    /// When we last synthesised input. Both OSes count our own events as
    /// "user input", so without this the typing guard would block on itself.
    last_injection: Mutex<Option<Instant>>,
    /// Escape we sent ourselves, so the global Esc does not take it for the
    /// user's.
    last_injected_escape: Mutex<Option<Instant>>,
    prompted: Mutex<HashSet<PermissionKind>>,
    guard: GuardTiming,
}

/// What `desktop_act` was asked to do.
#[derive(Debug, Clone, Default)]
pub struct ActArgs {
    pub app: String,
    pub window: Option<String>,
    pub r#ref: Option<String>,
    pub action: String,
    pub text: Option<String>,
    pub keys: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub confirmed: bool,
}

type Out = std::result::Result<String, String>;

/// The closing line of anything that changed another app. The user is looking
/// at that app, not at the transcript.
const SAY_WHAT_YOU_DID: &str = "Take a new snapshot to see the result, and tell the user in one line what you did in";

impl<B: Backend, H: Host> Desktop<B, H> {
    pub fn new(backend: B, host: H, guard: GuardTiming) -> Self {
        Self {
            backend: Arc::new(backend),
            host,
            chats: Mutex::new(HashMap::new()),
            busy: tokio::sync::Mutex::new(()),
            last_injection: Mutex::new(None),
            last_injected_escape: Mutex::new(None),
            prompted: Mutex::new(HashSet::new()),
            guard,
        }
    }

    async fn run<T: Send + 'static>(&self, f: impl FnOnce(&B) -> T + Send + 'static) -> T {
        let backend = self.backend.clone();
        match tokio::task::spawn_blocking(move || f(&backend)).await {
            Ok(v) => v,
            // A panic in an OS call is a bug, but it must not take the MCP
            // route down with it. Re-raise on this task instead of hiding it.
            Err(e) => std::panic::resume_unwind(e.into_panic()),
        }
    }

    fn with_chat<T>(&self, chat: &str, f: impl FnOnce(&mut ChatState<B::Handle>) -> T) -> T {
        let mut chats = self.chats.lock();
        f(chats.entry(chat.to_string()).or_default())
    }

    // ---- turn lifecycle -----------------------------------------------------

    /// A new user message: whatever Esc refused last turn is allowed again.
    pub fn turn_started(&self, chat: &str) {
        if let Some(state) = self.chats.lock().get_mut(chat) {
            state.halted = false;
        }
    }

    /// The turn is over, so nothing is being controlled any more.
    pub fn turn_ended(&self, chat: &str) {
        let was = self
            .chats
            .lock()
            .get_mut(chat)
            .and_then(|s| s.controlling.take());
        if was.is_some() {
            self.host.controlling(chat, None);
        }
    }

    pub fn forget(&self, chat: &str) {
        let was = self.chats.lock().remove(chat).and_then(|s| s.controlling);
        if was.is_some() {
            self.host.controlling(chat, None);
        }
    }

    /// The kill switch: every chat controlling something stops, and is refused
    /// for the rest of its turn. Returns the chats it stopped.
    pub fn halt_controlling(&self) -> Vec<String> {
        let stopped: Vec<String> = {
            let mut chats = self.chats.lock();
            chats
                .iter_mut()
                .filter(|(_, s)| s.controlling.is_some())
                .map(|(id, s)| {
                    s.halted = true;
                    s.controlling = None;
                    id.clone()
                })
                .collect()
        };
        for chat in &stopped {
            self.host.controlling(chat, None);
        }
        stopped
    }

    /// Whether an Esc that just arrived is one we sent.
    pub fn escape_was_ours(&self) -> bool {
        self.last_injected_escape
            .lock()
            .is_some_and(|at| at.elapsed() < Duration::from_millis(300))
    }

    #[cfg(test)]
    pub fn any_controlling(&self) -> bool {
        self.chats.lock().values().any(|s| s.controlling.is_some())
    }

    fn start_controlling(&self, chat: &str, app: &AppInfo) {
        let changed = self.with_chat(chat, |s| {
            let changed = s.controlling.as_deref() != Some(app.name.as_str());
            s.controlling = Some(app.name.clone());
            changed
        });
        if changed {
            self.host.controlling(chat, Some(&app.name));
        }
    }

    fn check_halted(&self, chat: &str) -> std::result::Result<(), String> {
        if self.with_chat(chat, |s| s.halted) {
            return Err(
                "The user stopped desktop control for this turn (Esc). Don't touch any app again until they send a new message; tell them where you stopped."
                    .into(),
            );
        }
        Ok(())
    }

    // ---- who may be touched -------------------------------------------------

    /// Why `app` (or this window of it) can never be touched, if it can't.
    fn block_reason(&self, app: &AppInfo, window_title: Option<&str>) -> Option<String> {
        safety::block_reason(
            app,
            window_title,
            self.backend.blocklist(),
            |id, p| self.backend.app_matches(id, p),
            std::process::id(),
        )
    }

    fn warning(&self, app: &AppInfo) -> Option<&'static str> {
        self.backend.warnlist().iter().find_map(|rule| {
            let by_id = rule.id.is_some_and(|p| self.backend.app_matches(&app.id, p));
            let by_name = rule.name.is_some_and(|n| n.eq_ignore_ascii_case(&app.name));
            (by_id || by_name).then_some(rule.text)
        })
    }

    fn allowed_state(&self, chat: &str, app: &AppInfo) -> Option<bool> {
        if self.host.always_allowed(&app.id) {
            return Some(true);
        }
        self.with_chat(chat, |s| {
            if s.allowed.contains(&app.id) {
                Some(true)
            } else if s.denied.contains(&app.id) {
                Some(false)
            } else {
                None
            }
        })
    }

    async fn ensure_allowed(&self, chat: &str, app: &AppInfo) -> std::result::Result<(), String> {
        match self.allowed_state(chat, app) {
            Some(true) => return Ok(()),
            Some(false) => {
                return Err(format!(
                    "The user said no to {} for this chat. Don't try it again unless they ask you to.",
                    app.name
                ))
            }
            None => {}
        }
        let warning = self.warning(app);
        match self.host.ask_allow(chat, app, warning).await {
            Ok(Answer::No) => {
                self.with_chat(chat, |s| s.denied.insert(app.id.clone()));
                Err(format!(
                    "The user said no to {} for this chat. Don't try it again unless they ask you to.",
                    app.name
                ))
            }
            Ok(_) => {
                // "Always" is written to settings by the renderer; remembering
                // it here as well means the next call does not race that sync.
                self.with_chat(chat, |s| s.allowed.insert(app.id.clone()));
                Ok(())
            }
            Err(e) => Err(format!(
                "Couldn't get the user's permission to use {}: {e}. Ask them in chat whether you may.",
                app.name
            )),
        }
    }

    /// Hold `kind`, prompting for it once per launch at most.
    async fn need(&self, chat: &str, kind: PermissionKind) -> std::result::Result<(), String> {
        let entries = self.run(|b| b.permissions()).await;
        // An OS with no such permission has no entry, and nothing to hold.
        let Some(entry) = entries.into_iter().find(|e| e.kind == kind) else {
            return Ok(());
        };
        if entry.granted {
            return Ok(());
        }
        let first = self.prompted.lock().insert(kind);
        if first && self.run(move |b| b.request_permission(kind)).await {
            return Ok(());
        }
        let blocked = Blocked { reason: entry.reason.clone(), fix: entry.fix.clone() };
        self.host.blocked(chat, kind, &blocked);
        Err(format!(
            "{} The user has been shown a button to fix it; tell them, and wait for them to say it's done.",
            DesktopError::Blocked(blocked).text()
        ))
    }

    // ---- finding things -----------------------------------------------------

    async fn resolve_app(&self, query: &str) -> std::result::Result<AppInfo, String> {
        let apps = self.run(|b| b.list_apps()).await.map_err(|e| e.text())?;
        safety::pick_app(&apps, query).ok_or_else(|| {
            format!(
                "No running app matches \"{query}\". Call desktop_apps for the list, or desktop_open it first."
            )
        })
    }

    async fn resolve_window(
        &self,
        app: &AppInfo,
        query: Option<&str>,
    ) -> std::result::Result<WindowInfo, String> {
        let a = app.clone();
        let windows = self.run(move |b| b.list_windows(&a)).await.map_err(|e| e.text())?;
        safety::pick_window(&windows, query).ok_or_else(|| match query {
            Some(q) => format!("{} has no window matching \"{q}\". Call desktop_apps for its windows.", app.name),
            None => format!("{} has no open windows. desktop_open it, or read its menu bar with window:\"menu\".", app.name),
        })
    }

    /// Everything a call must pass before it touches `app` at all.
    async fn admit(&self, chat: &str, query: &str) -> std::result::Result<AppInfo, String> {
        self.check_halted(chat)?;
        let app = self.resolve_app(query).await?;
        if let Some(why) = self.block_reason(&app, None) {
            return Err(refusal(&app.name, &why));
        }
        self.ensure_allowed(chat, &app).await?;
        self.need(chat, PermissionKind::ControlInput).await?;
        Ok(app)
    }

    async fn admit_window(
        &self,
        app: &AppInfo,
        query: Option<&str>,
    ) -> std::result::Result<WindowInfo, String> {
        let window = self.resolve_window(app, query).await?;
        // Checked on every call, not once: a title-scoped rule has to catch a
        // window that navigated into what it guards.
        if let Some(why) = self.block_reason(app, Some(&window.title)) {
            return Err(refusal(&app.name, &why));
        }
        if let Some(b) = &window.blocked {
            return Err(DesktopError::Blocked(b.clone()).text());
        }
        Ok(window)
    }

    // ---- the tools ------------------------------------------------------------

    pub async fn apps(&self, chat: &str) -> Out {
        self.check_halted(chat)?;
        let apps = self.run(|b| b.list_apps()).await.map_err(|e| e.text())?;
        let perms = self.run(|b| b.permissions()).await;
        let can_read = perms
            .iter()
            .find(|p| p.kind == PermissionKind::ControlInput)
            .is_none_or(|p| p.granted);

        let mut out = String::new();
        for app in &apps {
            if let Some(why) = self.block_reason(app, None) {
                out.push_str(&format!("{} — blocked: {why}\n", app.name));
                continue;
            }
            let access = match self.allowed_state(chat, app) {
                Some(true) => "allowed",
                Some(false) => "the user said no",
                None => "will ask the user",
            };
            let front = if app.frontmost { ", frontmost" } else { "" };
            out.push_str(&format!("{} — {access}{front}\n", app.name));
            if !can_read {
                continue;
            }
            let a = app.clone();
            let Ok(windows) = self.run(move |b| b.list_windows(&a)).await else { continue };
            for (i, w) in windows.iter().enumerate() {
                let title = if w.title.is_empty() { "(untitled)".to_string() } else { format!("\"{}\"", w.title) };
                let mut notes = Vec::new();
                if w.focused {
                    notes.push("focused".to_string());
                }
                if let Some(why) = self.block_reason(app, Some(&w.title)) {
                    notes.push(format!("blocked: {why}"));
                } else if let Some(b) = &w.blocked {
                    notes.push(format!("blocked: {}", b.reason));
                }
                let notes = if notes.is_empty() { String::new() } else { format!(" ({})", notes.join(", ")) };
                out.push_str(&format!("  {}. {title}{notes}\n", i + 1));
            }
        }
        if !can_read {
            if let Some(p) = perms.iter().find(|p| p.kind == PermissionKind::ControlInput) {
                out.push_str(&format!("\nWindows are hidden: {}\n", p.reason));
            }
        }
        out.push_str("\nPass an app's name as `app`, and a window's number or title as `window`.");
        Ok(out)
    }

    pub async fn snapshot(
        &self,
        chat: &str,
        app_query: &str,
        window_query: Option<&str>,
        root: Option<&str>,
    ) -> Out {
        let app = self.admit(chat, app_query).await?;
        let menu = window_query.is_some_and(|w| w.eq_ignore_ascii_case("menu"));

        let (key, title, frame) = if menu {
            (WindowKey("menu".into()), "menu bar".to_string(), None)
        } else {
            let w = self.admit_window(&app, window_query).await?;
            (w.key, w.title, w.frame)
        };

        let _busy = self.busy.lock().await;
        let a = app.clone();
        let k = key.clone();
        let tree = self
            .run(move |b| if menu { b.menu_bar(&a, WALK) } else { b.element_tree(&a, &k, WALK) })
            .await
            .map_err(|e| e.text())?;

        let root_path = match root {
            Some(r) => {
                let n = snapshot::parse_ref(r).ok_or_else(|| format!("\"{r}\" is not a ref; refs look like e12."))?;
                let entry = self.with_chat(chat, |s| s.refs.get(&n).map(|e| e.path.clone()));
                Some(entry.ok_or_else(|| format!("{r} is not from a recent snapshot. Take a new snapshot without root."))?)
            }
            None => None,
        };

        let text = self.with_chat(chat, |s| {
            s.snapshot_no += 1;
            let no = s.snapshot_no;
            let rendered = snapshot::render(
                &tree,
                frame.as_ref(),
                root_path.as_deref(),
                &mut s.next_ref,
                snapshot::Caps::default(),
            );
            let header = format!("{} — \"{}\" · snapshot {no}", app.name, title);
            for r in rendered.refs {
                s.refs.insert(r.number, RefEntry { snapshot: no, app: app.id.clone(), window: key.clone(), ..r.entry });
            }
            s.refs.retain(|_, e| e.snapshot + KEPT_SNAPSHOTS > no);
            s.windows.insert((app.id.clone(), key.clone()), WindowSeen { snapshot: no, ..rendered.seen });
            format!("{header}\n{}", rendered.text)
        });
        Ok(text)
    }

    /// A ref, turned back into something the OS half can act on.
    ///
    /// A ref from the latest snapshot of its window whose element still exists
    /// is used as it is. Anything else — an older snapshot, an element the app
    /// has since rebuilt — is found again by walking the window and matching
    /// role, label and path, and fails rather than guess when that is ambiguous.
    async fn resolve_ref(
        &self,
        chat: &str,
        app: &AppInfo,
        r: &str,
    ) -> std::result::Result<RefEntry<B::Handle>, String> {
        let n = snapshot::parse_ref(r).ok_or_else(|| format!("\"{r}\" is not a ref; refs look like e12."))?;
        let (entry, latest) = self.with_chat(chat, |s| {
            let entry = s.refs.get(&n).cloned();
            let latest = entry.as_ref().and_then(|e| {
                s.windows.get(&(e.app.clone(), e.window.clone())).map(|w| w.snapshot)
            });
            (entry, latest)
        });
        let entry = entry.ok_or_else(|| format!("{r} is not from a recent snapshot. Take a new snapshot."))?;
        if entry.app != app.id {
            return Err(format!("{r} belongs to another app, not {}.", app.name));
        }

        let handle = entry.handle.clone();
        let current = latest == Some(entry.snapshot) && self.run(move |b| b.is_alive(&handle)).await;
        if current {
            return Ok(entry);
        }

        let a = app.clone();
        let key = entry.window.clone();
        let menu = key.0 == "menu";
        let tree = self
            .run(move |b| if menu { b.menu_bar(&a, WALK) } else { b.element_tree(&a, &key, WALK) })
            .await
            .map_err(|e| e.text())?;
        match snapshot::find(&tree, &entry.path, &entry.role, &entry.label) {
            Some(found) => Ok(RefEntry {
                handle: found.handle.clone(),
                frame: found.frame,
                secure: found.secure,
                ..entry
            }),
            None => Err(format!(
                "{r} ({}) is no longer where it was in {}. Take a new snapshot.",
                snapshot::describe(&entry.role, &entry.label),
                app.name
            )),
        }
    }

    /// Wait for the user to stop typing or moving the mouse, briefly, then give
    /// up rather than fight them for the cursor.
    async fn wait_for_quiet(&self, chat: &str) -> std::result::Result<(), String> {
        let deadline = Instant::now() + self.guard.wait;
        loop {
            self.check_halted(chat)?;
            if !self.user_active().await {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(
                    "The user is using the keyboard or mouse right now. Don't fight them for it: wait until they stop, then try again, or tell them what you were about to do."
                        .into(),
                );
            }
            tokio::time::sleep(self.guard.poll).await;
        }
    }

    async fn user_active(&self) -> bool {
        let idle = self.run(|b| b.seconds_since_user_input()).await;
        let since_ours = self.last_injection.lock().map(|at| at.elapsed().as_secs_f64());
        safety::user_active(idle, since_ours, self.guard.quiet.as_secs_f64())
    }

    fn injected(&self) {
        *self.last_injection.lock() = Some(Instant::now());
    }

    pub async fn act(&self, chat: &str, args: ActArgs) -> Out {
        let app = self.admit(chat, &args.app).await?;
        let action = args.action.as_str();
        if !["press", "focus", "type", "set_value", "keys"].contains(&action) {
            return Err(format!(
                "desktop_act has no action \"{action}\". It has press, focus, type, set_value and keys."
            ));
        }

        // What we are acting on: a ref, or a point, or (for keys) just a window.
        let entry = match &args.r#ref {
            Some(r) => Some(self.resolve_ref(chat, &app, r).await?),
            None => None,
        };
        let window_query = args.window.as_deref();
        let window = match &entry {
            Some(e) if e.window.0 == "menu" => None,
            Some(e) => {
                // The ref names its window; check that one, not the focused one.
                let a = app.clone();
                let windows = self.run(move |b| b.list_windows(&a)).await.map_err(|e| e.text())?;
                let w = windows.into_iter().find(|w| w.key == e.window).ok_or_else(|| {
                    format!("The window {} was in has closed. Take a new snapshot.", snapshot::ref_name(e))
                })?;
                if let Some(why) = self.block_reason(&app, Some(&w.title)) {
                    return Err(refusal(&app.name, &why));
                }
                if let Some(b) = &w.blocked {
                    return Err(DesktopError::Blocked(b.clone()).text());
                }
                Some(w)
            }
            None => Some(self.admit_window(&app, window_query).await?),
        };
        let window_key = window.as_ref().map(|w| w.key.clone()).unwrap_or(WindowKey("menu".into()));
        let seen = self.with_chat(chat, |s| s.windows.get(&(app.id.clone(), window_key.clone())).cloned());

        // Irreversible things go through the user.
        let gate = match action {
            "press" => match &entry {
                Some(e) => e.irreversible.then(|| format!("press {}", snapshot::describe(&e.role, &e.label))),
                None => match (args.x, args.y, &window, &seen) {
                    (Some(x), Some(y), Some(w), Some(seen)) => w.frame.and_then(|f| {
                        let p = Point { x: f.x + x, y: f.y + y };
                        seen.danger.iter().find(|(r, _)| r.contains(p)).map(|(_, what)| format!("press {what}"))
                    }),
                    _ => None,
                },
            },
            "keys" => {
                let chord = safety::parse_chord(args.keys.as_deref().unwrap_or(""), self.backend.mod_is_cmd())?;
                seen.as_ref()
                    .and_then(|s| safety::keys_commit(&chord, s.focused_role.as_ref(), s.irreversible_any))
            }
            _ => None,
        };
        if let Some(what) = gate {
            if !args.confirmed {
                return Err(format!(
                    "That would {what} — it sends, deletes, buys or submits something. Ask the user first, and only once they've said yes, call again with confirmed:true."
                ));
            }
        }

        // Secure fields: never typed into, never set.
        if matches!(action, "type" | "set_value") {
            let Some(e) = &entry else {
                return Err(format!("{action} needs a ref: the field to put the text in."));
            };
            let h = e.handle.clone();
            if e.secure || self.run(move |b| b.is_secure(&h)).await {
                return Err(safety::SECURE_REFUSAL.into());
            }
        }
        if action == "keys" {
            let typing_chars = safety::parse_chord(args.keys.as_deref().unwrap_or(""), self.backend.mod_is_cmd())
                .map(|c| c.is_plain_char())
                .unwrap_or(false);
            if typing_chars && seen.as_ref().is_some_and(|s| s.focused_secure) {
                return Err(safety::SECURE_REFUSAL.into());
            }
        }

        let _busy = self.busy.lock().await;
        self.wait_for_quiet(chat).await?;
        self.start_controlling(chat, &app);

        let what = entry
            .as_ref()
            .map(|e| format!("{} {}", snapshot::ref_name(e), snapshot::describe(&e.role, &e.label)));
        let mut notes: Vec<String> = Vec::new();

        let did = match action {
            "press" | "focus" => {
                if let Some(e) = &entry {
                    let verb = if action == "press" { Action::Press } else { Action::Focus };
                    let h = e.handle.clone();
                    let v = verb.clone();
                    match self.run(move |b| b.perform(&h, &v)).await {
                        Ok(raised) => {
                            if raised.0 {
                                notes.push(format!("{} came to the front.", app.name));
                            }
                        }
                        Err(DesktopError::Unsupported(_)) if verb == Action::Press => {
                            // No press action: a real click at its centre.
                            let Some(frame) = e.frame else {
                                return Err(format!("{} can't be pressed and has no position to click.", what.unwrap_or_default()));
                            };
                            self.wait_for_quiet(chat).await?;
                            let (a, k, p) = (app.clone(), window_key.clone(), frame.centre());
                            let r = self.run(move |b| b.click_at(&a, &k, p)).await;
                            self.injected();
                            r.map_err(|e| e.text())?;
                            notes.push("It has no press action, so this was a real click at its centre, and the pointer moved.".into());
                        }
                        Err(e) => return Err(e.text()),
                    }
                    format!("{} {}", if action == "press" { "Pressed" } else { "Focused" }, what.clone().unwrap_or_default())
                } else if action == "press" {
                    let (Some(x), Some(y)) = (args.x, args.y) else {
                        return Err("press needs a ref, or x and y when the app's tree is no use.".into());
                    };
                    let Some(frame) = window.as_ref().and_then(|w| w.frame) else {
                        return Err("That window has no position to click in.".into());
                    };
                    let p = Point { x: frame.x + x, y: frame.y + y };
                    let (a, k) = (app.clone(), window_key.clone());
                    let r = self.run(move |b| b.click_at(&a, &k, p)).await;
                    self.injected();
                    r.map_err(|e| e.text())?;
                    notes.push("That was a real click, and the pointer moved.".into());
                    format!("Clicked at {x:.0},{y:.0}")
                } else {
                    return Err("focus needs a ref.".into());
                }
            }
            "set_value" => {
                let e = entry.as_ref().expect("checked above");
                let text = args.text.clone().ok_or("set_value needs text.")?;
                let (h, t) = (e.handle.clone(), text.clone());
                self.run(move |b| b.perform(&h, &Action::SetValue(t))).await.map_err(|e| e.text())?;
                if let Some(note) = self.read_back(e, &text).await {
                    notes.push(note);
                }
                format!("Set {} to \"{}\"", what.clone().unwrap_or_default(), snapshot::clip(&text, 60))
            }
            "type" => {
                let e = entry.as_ref().expect("checked above");
                let text = args.text.clone().ok_or("type needs text.")?;
                let mut raised = false;
                // In pieces, so Esc — or the user reaching for the keyboard —
                // stops it partway rather than after the whole paragraph.
                let chunks = safety::chunks(&text, 24);
                let mut typed = 0usize;
                for chunk in chunks {
                    if typed > 0 {
                        if let Err(e) = self.check_halted(chat) {
                            return Err(format!("Stopped after {typed} characters. {e}"));
                        }
                        if self.user_active().await {
                            return Err(format!(
                                "Stopped after {typed} characters: the user started using the keyboard or mouse."
                            ));
                        }
                    }
                    let (a, h, c) = (app.clone(), e.handle.clone(), chunk.to_string());
                    let r = self.run(move |b| b.type_text(&a, &h, &c)).await;
                    self.injected();
                    raised |= r.map_err(|e| e.text())?.0;
                    typed += chunk.chars().count();
                }
                if raised {
                    notes.push(format!("{} came to the front to take the keys.", app.name));
                }
                if let Some(note) = self.read_back(e, &text).await {
                    notes.push(note);
                }
                format!("Typed {typed} characters into {}", what.clone().unwrap_or_default())
            }
            "keys" => {
                let chord = safety::parse_chord(args.keys.as_deref().unwrap_or(""), self.backend.mod_is_cmd())?;
                if chord.is_escape() {
                    *self.last_injected_escape.lock() = Some(Instant::now());
                }
                let (a, k, c) = (app.clone(), window_key.clone(), chord.clone());
                let r = self.run(move |b| b.press_keys(&a, &k, &c)).await;
                self.injected();
                if r.as_ref().map_err(|e| e.text())?.0 {
                    notes.push(format!("{} came to the front to take the keys.", app.name));
                }
                format!("Pressed {}", args.keys.clone().unwrap_or_default())
            }
            _ => unreachable!("checked above"),
        };

        let mut out = format!("{did} in {}.", app.name);
        for n in notes {
            out.push(' ');
            out.push_str(&n);
        }
        out.push_str(&format!("\n{SAY_WHAT_YOU_DID} {}.", app.name));
        Ok(out)
    }

    /// Did the text land? Where the field can be read back, say so if not —
    /// a silently dropped keystroke otherwise reads as success.
    async fn read_back(&self, entry: &RefEntry<B::Handle>, text: &str) -> Option<String> {
        let h = entry.handle.clone();
        let value = self.run(move |b| b.read_value(&h)).await?;
        (!value.contains(text.trim())).then(|| {
            format!(
                "But the field now reads \"{}\", which doesn't contain what was typed. Take a snapshot and check.",
                snapshot::clip(&value, 80)
            )
        })
    }

    pub async fn open(&self, chat: &str, target: &str) -> Out {
        self.check_halted(chat)?;
        let target = safety::parse_target(target)?;
        if let Target::App(name) = &target {
            let n = name.clone();
            let found = self.run(move |b| b.find_app(&n)).await;
            let Some((id, display)) = found else {
                return Err(format!("No app called \"{name}\" is installed."));
            };
            let app = AppInfo { id, name: display, pid: 0, frontmost: false };
            if let Some(why) = self.block_reason(&app, None) {
                return Err(refusal(&app.name, &why));
            }
            self.ensure_allowed(chat, &app).await?;
            self.start_controlling(chat, &app);
        }
        let _busy = self.busy.lock().await;
        let t = target.clone();
        let opened = self.run(move |b| b.open(&t)).await.map_err(|e| e.text())?;
        Ok(format!(
            "Opened {opened}. Snapshot it before acting — it may still be loading. Tell the user in one line what you opened."
        ))
    }

    pub async fn permissions(&self) -> Vec<PermissionEntry> {
        self.run(|b| b.permissions()).await
    }

    pub async fn fix_permission(&self, kind: PermissionKind) -> std::result::Result<(), String> {
        let entries = self.run(|b| b.permissions()).await;
        let Some(entry) = entries.into_iter().find(|e| e.kind == kind) else {
            return Ok(());
        };
        if entry.granted {
            return Ok(());
        }
        // Prompting first registers Nyra in the list the user is about to see,
        // so the pane they land on has something to switch on.
        self.run(move |b| b.request_permission(kind)).await;
        if let Some(fix) = entry.fix {
            let t = Target::Url(fix.target);
            self.run(move |b| b.open(&t)).await.map_err(|e| e.text())?;
        }
        Ok(())
    }
}

fn refusal(app: &str, why: &str) -> String {
    format!(
        "{app} is off limits: {why}. Nyra never lets Claude touch it, and the user cannot allow it. Don't try another route to it — not the shell, not a script. Tell the user what you needed and let them do it."
    )
}

// ---------------------------------------------------------------------------
// The live instance
// ---------------------------------------------------------------------------

pub type Live = Desktop<Native, indicator::TauriHost>;

static DESKTOP: Lazy<Live> =
    Lazy::new(|| Desktop::new(Native::new(), indicator::TauriHost::default(), GuardTiming::default()));

pub fn live() -> &'static Live {
    &DESKTOP
}

/// Loopback is not a boundary, and this one drives other apps.
static MCP_TOKEN: Lazy<String> = Lazy::new(|| crate::util::rand_hex(16));

pub fn mcp_token() -> &'static str {
    &MCP_TOKEN
}

pub fn mcp_endpoint(chat_id: &str) -> Option<(String, String)> {
    let port = crate::webhook_server::port()?;
    Some((
        format!("http://127.0.0.1:{port}/desktop/mcp/{chat_id}"),
        MCP_TOKEN.clone(),
    ))
}

/// Turn hooks for `claude.rs`. Cheap when this chat never touched anything:
/// the static is only built by the first desktop call or these.
pub fn turn_started(chat: &str) {
    if Lazy::get(&DESKTOP).is_some() {
        DESKTOP.turn_started(chat);
    }
}

pub fn turn_ended(chat: &str) {
    if Lazy::get(&DESKTOP).is_some() {
        DESKTOP.turn_ended(chat);
    }
}

pub fn forget(chat: &str) {
    if Lazy::get(&DESKTOP).is_some() {
        DESKTOP.forget(chat);
    }
}
