//! Windows: UI Automation, SendInput, Windows.Graphics.Capture, ShellExecute.
//!
//! Phase 1 is this stub. It exists so the contract compiles on Windows —
//! `cargo xwin check` proves `Native` implements every primitive — and it
//! answers "not supported yet" from each, so the tools fail with a reason
//! rather than doing nothing.
//!
//! How each primitive maps, checked before the macOS side was written:
//!
//! - tree: a CacheRequest over the ControlView walker; `IsOffscreen` fills
//!   `offscreen`, `IsPassword` fills `secure`.
//! - `perform`: Press is Invoke, then Toggle, SelectionItem, ExpandCollapse;
//!   Focus is SetFocus; SetValue is ValuePattern. None of them → `Unsupported`,
//!   and the engine clicks the centre instead.
//! - `type_text`: UIA cannot insert at a caret, so Focus + SendInput with
//!   KEYEVENTF_UNICODE, which needs the window in front → `Raised(true)`.
//! - `press_keys`, `click_at`: SetForegroundWindow + SendInput.
//! - elevation: UIPI silently drops input and patterns sent to a window of a
//!   higher integrity level than ours. `list_windows` compares the owning
//!   process's TokenIntegrityLevel with Nyra's and sets `blocked`, so it is a
//!   refusal with a reason and never a silent no-op.
//! - `seconds_since_user_input`: GetLastInputInfo, which counts our own
//!   SendInput too — the engine discounts that.
//! - `permissions`: nothing to grant, so `[]`.

use super::safety::Chord;
use super::*;

const NOT_YET: &str = "desktop control is not supported on Windows yet";

/// Matched by executable file name, case-insensitively (see `app_matches`).
const BLOCKLIST: &[BlockRule] = &[
    BlockRule { id: Some("nyra.exe"), name: Some("Nyra"), title: None, why: "it is Nyra itself" },
    BlockRule { id: Some("consent.exe"), name: None, title: None, why: "it is a User Account Control prompt, which only you answer" },
    BlockRule { id: Some("CredentialUIBroker.exe"), name: None, title: None, why: "it asks for your Windows credentials" },
    BlockRule { id: Some("SecHealthUI.exe"), name: None, title: None, why: "Windows Security holds your protection settings" },
    BlockRule { id: Some("SystemSettings.exe"), name: None, title: None, why: "Settings holds privacy and security switches that only you should flip" },
    BlockRule { id: Some("explorer.exe"), name: None, title: Some("Credential Manager"), why: "Credential Manager stores your passwords" },
    BlockRule { id: Some("WindowsTerminal.exe"), name: None, title: None, why: "Claude already has a shell; driving a terminal window only reaches sessions it should not, like an elevated prompt or an ssh login" },
    BlockRule { id: Some("conhost.exe"), name: None, title: None, why: "Claude already has a shell; driving a terminal window only reaches sessions it should not" },
    BlockRule { id: Some("powershell_ise.exe"), name: None, title: None, why: "Claude already has a shell; driving a terminal window only reaches sessions it should not" },
    BlockRule { id: Some("1Password.exe"), name: None, title: None, why: "it is a password manager" },
    BlockRule { id: Some("Bitwarden.exe"), name: None, title: None, why: "it is a password manager" },
    BlockRule { id: Some("LastPass.exe"), name: None, title: None, why: "it is a password manager" },
    BlockRule { id: Some("KeePassXC.exe"), name: None, title: None, why: "it is a password manager" },
    BlockRule { id: Some("KeePass.exe"), name: None, title: None, why: "it is a password manager" },
    BlockRule { id: Some("Enpass.exe"), name: None, title: None, why: "it is a password manager" },
    BlockRule { id: Some("ProtonPass.exe"), name: None, title: None, why: "it is a password manager" },
    BlockRule { id: None, name: Some("Dashlane"), title: None, why: "it is a password manager" },
];

const WARNLIST: &[WarnRule] = &[
    WarnRule { id: Some("explorer.exe"), name: None, text: "File Explorer can read, move or delete any file" },
    WarnRule { id: Some("Code.exe"), name: None, text: "an editor can run code, the same as shell access" },
    WarnRule { id: Some("Cursor.exe"), name: None, text: "an editor can run code, the same as shell access" },
    WarnRule { id: Some("devenv.exe"), name: None, text: "an IDE can run code, the same as shell access" },
    WarnRule { id: Some("msedge.exe"), name: None, text: "for web pages, Nyra's own browser is the better tool" },
    WarnRule { id: Some("chrome.exe"), name: None, text: "for web pages, Nyra's own browser is the better tool" },
    WarnRule { id: Some("firefox.exe"), name: None, text: "for web pages, Nyra's own browser is the better tool" },
];

#[derive(Clone)]
pub struct Handle;

pub struct Native;

impl Native {
    pub fn new() -> Self {
        Native
    }
}

fn not_yet<T>() -> Result<T> {
    Err(DesktopError::Unsupported(NOT_YET.into()))
}

impl Backend for Native {
    type Handle = Handle;

    fn blocklist(&self) -> &'static [BlockRule] {
        BLOCKLIST
    }
    fn warnlist(&self) -> &'static [WarnRule] {
        WARNLIST
    }
    /// An `AppId` here is an executable path; a rule names the file.
    fn app_matches(&self, id: &AppId, pattern: &str) -> bool {
        let file = id.0.rsplit(['\\', '/']).next().unwrap_or(&id.0);
        file.eq_ignore_ascii_case(pattern)
    }
    fn mod_is_cmd(&self) -> bool {
        false
    }
    fn permissions(&self) -> Vec<PermissionEntry> {
        Vec::new()
    }
    fn request_permission(&self, _kind: PermissionKind) -> bool {
        true
    }
    fn list_apps(&self) -> Result<Vec<AppInfo>> {
        not_yet()
    }
    fn find_app(&self, _query: &str) -> Option<(AppId, String)> {
        None
    }
    fn list_windows(&self, _app: &AppInfo) -> Result<Vec<WindowInfo>> {
        not_yet()
    }
    fn element_tree(&self, _app: &AppInfo, _window: &WindowKey, _limits: Limits) -> Result<RawElement<Handle>> {
        not_yet()
    }
    fn menu_bar(&self, _app: &AppInfo, _limits: Limits) -> Result<RawElement<Handle>> {
        not_yet()
    }
    fn is_alive(&self, _h: &Handle) -> bool {
        false
    }
    fn is_secure(&self, _h: &Handle) -> bool {
        // Unknown is treated as secure: refusing is the safe mistake.
        true
    }
    fn read_value(&self, _h: &Handle) -> Option<String> {
        None
    }
    fn perform(&self, _h: &Handle, _action: &Action) -> Result<Raised> {
        not_yet()
    }
    fn type_text(&self, _app: &AppInfo, _h: &Handle, _text: &str) -> Result<Raised> {
        not_yet()
    }
    fn press_keys(&self, _app: &AppInfo, _w: &WindowKey, _chord: &Chord) -> Result<Raised> {
        not_yet()
    }
    fn click_at(&self, _app: &AppInfo, _w: &WindowKey, _p: Point) -> Result<Raised> {
        not_yet()
    }
    fn capture_window(&self, _app: &AppInfo, _w: &WindowKey, _width: u32) -> Result<Vec<u8>> {
        not_yet()
    }
    fn app_icon(&self, _app: &AppInfo) -> Option<Vec<u8>> {
        None
    }
    fn open(&self, _target: &Target) -> Result<String> {
        not_yet()
    }
    fn seconds_since_user_input(&self) -> f64 {
        f64::MAX
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// The phase 3 finish line, on a real Windows machine: open Notepad, type a
    /// line, read it back, then be refused Settings and Windows Terminal. Moves
    /// real windows, so ignored and run by hand:
    /// `cargo test --lib drives_notepad_end_to_end -- --ignored --nocapture`.
    /// Until `windows.rs` is filled in it fails at the first step with "not
    /// supported yet", which is the point.
    #[tokio::test]
    #[ignore]
    async fn drives_notepad_end_to_end() {
        let d = Desktop::new(
            Native::new(),
            super::super::fake::AllowOnly(&["Notepad"]),
            GuardTiming::default(),
            SCRATCH_DIR.clone(),
        );
        let chat = "e2e";
        let say = |label: &str, r: &std::result::Result<String, String>| match r {
            Ok(t) => println!("--- {label}\n{t}\n"),
            Err(e) => println!("--- {label} (refused)\n{e}\n"),
        };

        let opened = d.open(chat, "Notepad").await;
        say("desktop_open Notepad", &opened);
        opened.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;

        let snap = d.snapshot(chat, "Notepad", None, None).await;
        say("desktop_snapshot", &snap);
        let snap = snap.unwrap();
        // Classic Notepad is an edit control, Windows 11's a document; either
        // way it is the one text area or text field in the window.
        let area = snap
            .lines()
            .find(|l| l.contains("] text area") || l.contains("] text field"))
            .and_then(|l| l.trim().split(']').next())
            .map(|r| r.trim_start_matches('[').to_string())
            .expect("a text area in Notepad");

        let line = "Typed by Claude through Nyra desktop control.";
        let typed = d
            .act(chat, ActArgs { app: "Notepad".into(), r#ref: Some(area), action: "type".into(), text: Some(line.into()), ..Default::default() })
            .await;
        say("desktop_act type", &typed);
        typed.unwrap();

        let again = d.snapshot(chat, "Notepad", None, None).await;
        say("desktop_snapshot again", &again);
        assert!(again.unwrap().contains(line), "the line did not read back");

        let shot = d.screenshot(chat, "Notepad", None).await;
        match &shot {
            Ok(s) => println!("--- desktop_screenshot\n{}\n", s.text),
            Err(e) => println!("--- desktop_screenshot (refused)\n{e}\n"),
        }
        assert!(shot.is_ok(), "no screenshot");

        for blocked in ["Settings", "Windows Terminal"] {
            let r = d.open(chat, blocked).await;
            say(&format!("desktop_open {blocked}"), &r);
            assert!(r.unwrap_err().contains("off limits"), "{blocked} was not refused");
        }

        d.turn_ended(chat);
    }
}
