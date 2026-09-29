//! Neither macOS nor Windows: Nyra does not ship here, but `platform/` builds
//! on any Unix, so this keeps the contract compiling. Every primitive refuses.

use super::safety::Chord;
use super::*;

const NOT_YET: &str = "desktop control is not supported on this OS";

const BLOCKLIST: &[BlockRule] = &[];
const WARNLIST: &[WarnRule] = &[];

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
    fn app_matches(&self, id: &AppId, pattern: &str) -> bool {
        id.0 == pattern
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
