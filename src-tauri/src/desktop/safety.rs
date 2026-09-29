//! The rules, as pure functions: who is off limits, what counts as the user
//! being at the keyboard, which presses commit something irreversible. Pure so
//! each one is tested directly rather than through a fake UI.

use once_cell::sync::Lazy;
use regex::Regex;
use std::fmt;

use super::{AppId, AppInfo, BlockRule, Role, Target, WindowInfo};

pub const SECURE_REFUSAL: &str = "That is a password field. Nyra never types into one or reads one back, whoever asks. Tell the user to fill it in themselves.";

/// Why `app` can never be touched, or `None`.
///
/// `window_title` is `None` when the question is about the app as a whole, and
/// then only the rules without a title apply. With a title, the title-scoped
/// ones do too — which is why this runs on every call, not once per app.
pub fn block_reason(
    app: &AppInfo,
    window_title: Option<&str>,
    rules: &[BlockRule],
    matches: impl Fn(&AppId, &str) -> bool,
    own_pid: u32,
) -> Option<String> {
    if app.pid != 0 && app.pid == own_pid {
        return Some("it is Nyra itself".into());
    }
    for rule in rules {
        let by_id = rule.id.is_some_and(|p| matches(&app.id, p));
        let by_name = rule.name.is_some_and(|n| n.eq_ignore_ascii_case(app.name.trim()));
        if !(by_id || by_name) {
            continue;
        }
        match (rule.title, window_title) {
            (None, _) => return Some(rule.why.into()),
            (Some(t), Some(title)) if title.to_lowercase().contains(&t.to_lowercase()) => {
                return Some(rule.why.into())
            }
            _ => {}
        }
    }
    None
}

/// An app by what the model called it: its id, its exact name, or a name that
/// only one app contains.
pub fn pick_app(apps: &[AppInfo], query: &str) -> Option<AppInfo> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }
    if let Some(a) = apps.iter().find(|a| a.id.0 == q) {
        return Some(a.clone());
    }
    if let Some(a) = apps.iter().find(|a| a.name.eq_ignore_ascii_case(q)) {
        return Some(a.clone());
    }
    let lower = q.to_lowercase();
    let mut hits = apps.iter().filter(|a| a.name.to_lowercase().contains(&lower));
    match (hits.next(), hits.next()) {
        (Some(a), None) => Some(a.clone()),
        _ => None,
    }
}

/// A window by number (1-based, as `desktop_apps` prints them), exact title,
/// or a title only one window contains. No query means the focused window.
pub fn pick_window(windows: &[WindowInfo], query: Option<&str>) -> Option<WindowInfo> {
    let Some(q) = query.map(str::trim).filter(|q| !q.is_empty()) else {
        return windows.iter().find(|w| w.focused).or_else(|| windows.first()).cloned();
    };
    if let Ok(n) = q.trim_start_matches('#').parse::<usize>() {
        return n.checked_sub(1).and_then(|i| windows.get(i)).cloned();
    }
    if let Some(w) = windows.iter().find(|w| w.title.eq_ignore_ascii_case(q)) {
        return Some(w.clone());
    }
    let lower = q.to_lowercase();
    let mut hits = windows.iter().filter(|w| w.title.to_lowercase().contains(&lower));
    match (hits.next(), hits.next()) {
        (Some(w), None) => Some(w.clone()),
        _ => None,
    }
}

/// Is someone at the keyboard or mouse?
///
/// `idle` is the OS's time since the last input event — which on both OSes
/// includes events we synthesised. `since_ours` is how long ago we last did.
/// If the last input is no more recent than our own, it was ours.
pub fn user_active(idle: f64, since_ours: Option<f64>, quiet: f64) -> bool {
    if idle >= quiet {
        return false;
    }
    match since_ours {
        Some(ours) => idle < ours - 0.25,
        None => true,
    }
}

// ---------------------------------------------------------------------------
// Irreversible actions
// ---------------------------------------------------------------------------

static IRREVERSIBLE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(
        r"(?i)\b(send|delete|remove|erase|discard|buy|purchase|pay|checkout|check out|place order|order now|submit|post|publish|transfer|empty trash|move to trash|move to bin|unsubscribe|confirm|deactivate|wipe|format)\b",
    )
    .unwrap()
});

/// Does pressing this send, delete, buy or submit something?
pub fn irreversible(role: &Role, label: &str) -> bool {
    matches!(role, Role::Button | Role::MenuItem | Role::Link) && IRREVERSIBLE.is_match(label)
}

// ---------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    Char(char),
    Return,
    Tab,
    Escape,
    Delete,
    ForwardDelete,
    Space,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    F(u8),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chord {
    pub cmd: bool,
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub key: Key,
}

impl Chord {
    pub fn is_plain_char(&self) -> bool {
        matches!(self.key, Key::Char(_) | Key::Space) && !self.cmd && !self.ctrl && !self.alt
    }
    pub fn is_escape(&self) -> bool {
        self.key == Key::Escape
    }
}

impl fmt::Display for Chord {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut parts: Vec<String> = Vec::new();
        if self.cmd {
            parts.push("cmd".into());
        }
        if self.ctrl {
            parts.push("ctrl".into());
        }
        if self.alt {
            parts.push("alt".into());
        }
        if self.shift {
            parts.push("shift".into());
        }
        parts.push(match &self.key {
            Key::Char(c) => c.to_string(),
            Key::F(n) => format!("f{n}"),
            other => format!("{other:?}").to_lowercase(),
        });
        write!(f, "{}", parts.join("+"))
    }
}

/// `cmd+shift+s`, `return`, `mod+w`. `mod` is cmd where cmd is the command key
/// and ctrl where it is not, so a skill can say one thing for both OSes.
pub fn parse_chord(s: &str, mod_is_cmd: bool) -> Result<Chord, String> {
    let s = s.trim();
    if s.is_empty() {
        return Err("keys needs a chord, like \"cmd+s\" or \"return\".".into());
    }
    let parts: Vec<&str> = if s == "+" { vec!["+"] } else { s.split('+').map(str::trim).collect() };
    let (key_part, mods) = parts.split_last().ok_or("keys needs a chord.")?;
    let mut chord = Chord { cmd: false, ctrl: false, alt: false, shift: false, key: Key::Return };
    for m in mods {
        match m.to_lowercase().as_str() {
            "cmd" | "command" | "meta" | "super" | "win" => chord.cmd = true,
            "ctrl" | "control" => chord.ctrl = true,
            "alt" | "option" | "opt" => chord.alt = true,
            "shift" => chord.shift = true,
            "mod" => {
                if mod_is_cmd {
                    chord.cmd = true
                } else {
                    chord.ctrl = true
                }
            }
            other => return Err(format!("\"{other}\" is not a modifier. Use cmd, ctrl, alt, shift or mod.")),
        }
    }
    let k = key_part.to_lowercase();
    chord.key = match k.as_str() {
        "return" | "enter" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "delete" | "backspace" => Key::Delete,
        "forwarddelete" | "del" => Key::ForwardDelete,
        "space" => Key::Space,
        "up" => Key::Up,
        "down" => Key::Down,
        "left" => Key::Left,
        "right" => Key::Right,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" => Key::PageUp,
        "pagedown" => Key::PageDown,
        f if f.len() >= 2 && f.starts_with('f') && f[1..].parse::<u8>().is_ok_and(|n| (1..=20).contains(&n)) => {
            Key::F(f[1..].parse().unwrap())
        }
        _ => {
            let mut chars = key_part.chars();
            match (chars.next(), chars.next()) {
                (Some(c), None) => Key::Char(c.to_ascii_lowercase()),
                _ => {
                    return Err(format!(
                        "\"{key_part}\" is not a key. Use a single character, or return, tab, escape, delete, space, up, down, left, right, home, end, pageup, pagedown, f1–f12. To type words, use action:\"type\"."
                    ))
                }
            }
        }
    };
    Ok(chord)
}

/// Would this chord commit something, in a window that has a send/delete
/// button in it? Returns what it would do, for the refusal.
///
/// Without this, "focus the field, press Return" would get around the rule the
/// buttons are held to. It is deliberately narrow, so fixing a typo with
/// Delete or starting a new line in a text area never needs confirming.
pub fn keys_commit(chord: &Chord, focused: Option<&Role>, window_has_irreversible: bool) -> Option<String> {
    if !window_has_irreversible {
        return None;
    }
    let command = chord.cmd || chord.ctrl;
    let in_text = |roles: &[Role]| focused.is_some_and(|r| roles.contains(r));
    let commits = match chord.key {
        Key::Return => command || !in_text(&[Role::TextArea]),
        Key::Delete | Key::ForwardDelete => command || !in_text(&[Role::TextField, Role::TextArea]),
        _ => false,
    };
    commits.then(|| format!("press {chord}, which could send, delete or submit here"))
}

// ---------------------------------------------------------------------------
// Odds and ends
// ---------------------------------------------------------------------------

pub fn chunks(text: &str, size: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (count, (i, _)) in text.char_indices().enumerate() {
        if count > 0 && count % size == 0 {
            out.push(&text[start..i]);
            start = i;
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

pub fn parse_target(t: &str) -> Result<Target, String> {
    let t = t.trim();
    if t.is_empty() {
        return Err("desktop_open needs a target: an app name, an absolute path, or a URL.".into());
    }
    if t.contains("://") || t.starts_with("mailto:") || t.starts_with("tel:") {
        return Ok(Target::Url(t.to_string()));
    }
    if t.starts_with('~') {
        return Ok(Target::Path(crate::util::expand_home(t)));
    }
    if std::path::Path::new(t).is_absolute() || t.starts_with('/') {
        return Ok(Target::Path(t.to_string()));
    }
    Ok(Target::App(t.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str, name: &str, pid: u32) -> AppInfo {
        AppInfo { id: AppId(id.into()), name: name.into(), pid, frontmost: false }
    }

    const RULES: &[BlockRule] = &[
        BlockRule { id: Some("keychain"), name: None, title: None, why: "stores passwords" },
        BlockRule { id: None, name: Some("Vault"), title: None, why: "a password manager" },
        BlockRule { id: Some("explorer"), name: None, title: Some("Credential Manager"), why: "stores credentials" },
    ];

    fn eq(id: &AppId, p: &str) -> bool {
        id.0 == p
    }

    #[test]
    fn blocks_by_id_by_name_and_itself() {
        assert!(block_reason(&app("keychain", "Keychain", 5), None, RULES, eq, 1).is_some());
        assert!(block_reason(&app("x", "vault", 5), None, RULES, eq, 1).is_some());
        assert!(block_reason(&app("mail", "Mail", 1), None, RULES, eq, 1).unwrap().contains("Nyra"));
        assert!(block_reason(&app("mail", "Mail", 5), None, RULES, eq, 1).is_none());
    }

    #[test]
    fn a_title_rule_only_catches_the_window_it_names() {
        let explorer = app("explorer", "Explorer", 5);
        assert!(block_reason(&explorer, None, RULES, eq, 1).is_none());
        assert!(block_reason(&explorer, Some("Documents"), RULES, eq, 1).is_none());
        // A window that navigated into it is caught on the next call.
        assert!(block_reason(&explorer, Some("Control Panel > credential manager"), RULES, eq, 1).is_some());
    }

    #[test]
    fn picks_apps_and_windows_the_way_a_person_names_them() {
        let apps = vec![app("com.a.mail", "Mail", 2), app("com.a.maps", "Maps", 3), app("com.a.notes", "Notes", 4)];
        assert_eq!(pick_app(&apps, "mail").unwrap().pid, 2);
        assert_eq!(pick_app(&apps, "com.a.notes").unwrap().pid, 4);
        assert_eq!(pick_app(&apps, "not").unwrap().pid, 4);
        // "ma" is Mail and Maps: ambiguous, so nothing rather than a guess.
        assert!(pick_app(&apps, "ma").is_none());

        let w = |t: &str, focused: bool| WindowInfo {
            key: super::super::WindowKey(t.into()),
            title: t.into(),
            frame: None,
            focused,
            blocked: None,
        };
        let windows = vec![w("Inbox", false), w("New Message", true)];
        assert_eq!(pick_window(&windows, None).unwrap().title, "New Message");
        assert_eq!(pick_window(&windows, Some("1")).unwrap().title, "Inbox");
        assert_eq!(pick_window(&windows, Some("new")).unwrap().title, "New Message");
        assert!(pick_window(&windows, Some("9")).is_none());
    }

    #[test]
    fn our_own_input_is_not_the_user_typing() {
        // Nobody has touched anything for two seconds.
        assert!(!user_active(2.0, None, 1.0));
        // Input 0.2s ago and we have never injected: that is the user.
        assert!(user_active(0.2, None, 1.0));
        // Input 0.2s ago, and we injected 0.2s ago: that was us.
        assert!(!user_active(0.2, Some(0.2), 1.0));
        // We injected 0.8s ago, but something happened 0.1s ago: the user.
        assert!(user_active(0.1, Some(0.8), 1.0));
    }

    #[test]
    fn knows_a_send_button_from_a_harmless_one() {
        assert!(irreversible(&Role::Button, "Send"));
        assert!(irreversible(&Role::MenuItem, "Move to Trash"));
        assert!(irreversible(&Role::Button, "Place Order"));
        assert!(!irreversible(&Role::Button, "Sender details"), "a word boundary, not a substring");
        assert!(!irreversible(&Role::Button, "Bold"));
        // A text that says "Delete" is not something you press.
        assert!(!irreversible(&Role::Text, "Delete"));
    }

    #[test]
    fn parses_chords_and_resolves_mod_per_os() {
        let c = parse_chord("mod+shift+S", true).unwrap();
        assert!(c.cmd && c.shift && !c.ctrl);
        assert_eq!(c.key, Key::Char('s'));
        assert!(parse_chord("mod+s", false).unwrap().ctrl);
        assert_eq!(parse_chord("Return", true).unwrap().key, Key::Return);
        assert_eq!(parse_chord("f5", true).unwrap().key, Key::F(5));
        assert!(parse_chord("hyper+s", true).is_err());
        assert!(parse_chord("hello", true).unwrap_err().contains("action:\"type\""));
    }

    #[test]
    fn return_commits_only_where_it_could() {
        let ret = parse_chord("return", true).unwrap();
        let cmd_ret = parse_chord("cmd+return", true).unwrap();
        let del = parse_chord("delete", true).unwrap();
        // No send button in the window: nothing to gate.
        assert!(keys_commit(&cmd_ret, None, false).is_none());
        assert!(keys_commit(&cmd_ret, Some(&Role::TextArea), true).is_some());
        // A new line in the body of a message is not sending it.
        assert!(keys_commit(&ret, Some(&Role::TextArea), true).is_none());
        assert!(keys_commit(&ret, Some(&Role::TextField), true).is_some());
        // Fixing a typo is not deleting the message.
        assert!(keys_commit(&del, Some(&Role::TextField), true).is_none());
        assert!(keys_commit(&del, Some(&Role::List), true).is_some());
    }

    #[test]
    fn chunks_on_characters_not_bytes() {
        assert_eq!(chunks("abcdef", 4), vec!["abcd", "ef"]);
        assert_eq!(chunks("ééé", 2), vec!["éé", "é"]);
        assert!(chunks("", 4).is_empty());
    }

    #[test]
    fn tells_an_app_from_a_path_from_a_url() {
        assert_eq!(parse_target("Mail").unwrap(), Target::App("Mail".into()));
        assert_eq!(parse_target("https://x.dev").unwrap(), Target::Url("https://x.dev".into()));
        assert_eq!(parse_target("/tmp/a.txt").unwrap(), Target::Path("/tmp/a.txt".into()));
        assert!(matches!(parse_target("~/a.txt").unwrap(), Target::Path(p) if !p.starts_with('~')));
    }
}
