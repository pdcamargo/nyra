//! Which editors this machine actually has.
//!
//! Detection rather than a fixed menu, because a fixed menu is wrong on most
//! machines: this one has Xcode, Zed and TextEdit and none of VS Code, Cursor or
//! Sublime, so three of five hardcoded entries would do nothing when clicked.
//!
//! Probing bundle paths rather than asking LaunchServices: `mdfind` needs
//! Spotlight, which plenty of dev machines have off, and `lsregister -dump` is a
//! ~50 MB dump that takes seconds. A dozen `stat` calls costs nothing and finds
//! everything installed the normal way.

use once_cell::sync::Lazy;
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorApp {
    /// What the menu says.
    pub name: String,
    /// The bundle path, passed straight to `open -a`. A path rather than a name
    /// because two apps can share a display name and a path cannot be ambiguous.
    pub path: String,
}

/// Long enough that the probe is free, short enough that installing an editor
/// mid-session shows up without restarting Nyra.
const CACHE_TTL: Duration = Duration::from_secs(300);

static CACHE: Lazy<Mutex<Option<(Instant, Vec<EditorApp>)>>> = Lazy::new(|| Mutex::new(None));

/// Display name to bundle name, in menu order. Editors people actually open a
/// source file with; not a general "open with" list.
#[cfg(target_os = "macos")]
const CANDIDATES: [(&str, &str); 12] = [
    ("Visual Studio Code", "Visual Studio Code.app"),
    ("Cursor", "Cursor.app"),
    ("Windsurf", "Windsurf.app"),
    ("VSCodium", "VSCodium.app"),
    ("Zed", "Zed.app"),
    ("Sublime Text", "Sublime Text.app"),
    ("Nova", "Nova.app"),
    ("BBEdit", "BBEdit.app"),
    ("IntelliJ IDEA", "IntelliJ IDEA.app"),
    ("WebStorm", "WebStorm.app"),
    ("Xcode", "Xcode.app"),
    ("TextEdit", "TextEdit.app"),
];

/// Where a bundle might live, in priority order. `/System/Applications` matters:
/// TextEdit has lived there since Catalina, not in `/Applications`.
#[cfg(target_os = "macos")]
fn probe_roots() -> Vec<std::path::PathBuf> {
    let mut roots = vec![std::path::PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        roots.push(std::path::Path::new(&home).join("Applications"));
    }
    roots.push(std::path::PathBuf::from("/System/Applications"));
    roots
}

#[cfg(target_os = "macos")]
fn probe(roots: &[std::path::PathBuf]) -> Vec<EditorApp> {
    CANDIDATES
        .iter()
        .filter_map(|(name, bundle)| {
            roots.iter().find_map(|root| {
                let path = root.join(bundle);
                path.exists().then(|| EditorApp {
                    name: (*name).to_string(),
                    path: path.to_string_lossy().to_string(),
                })
            })
        })
        .collect()
}

/// Editors worth offering, memoised.
///
/// Empty off macOS, deliberately: the menu then collapses to the single "Open
/// with default application" entry, which works everywhere. Filling this in for
/// Linux means reading `.desktop` files under `/usr/share/applications` for
/// `MimeType=text/plain`; for Windows, `HKCR\.txt\OpenWithProgids`. Both are a
/// fill-in here rather than a refactor elsewhere.
#[cfg(target_os = "macos")]
pub fn detect_editors() -> Vec<EditorApp> {
    let mut cache = CACHE.lock().unwrap();
    if let Some((at, found)) = cache.as_ref() {
        if at.elapsed() < CACHE_TTL {
            return found.clone();
        }
    }
    let found = probe(&probe_roots());
    *cache = Some((Instant::now(), found.clone()));
    found
}

#[cfg(not(target_os = "macos"))]
pub fn detect_editors() -> Vec<EditorApp> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn finds_only_what_is_there_and_keeps_menu_order() {
        let dir = std::env::temp_dir().join(format!("nyra-editors-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("Zed.app")).unwrap();
        std::fs::create_dir_all(dir.join("Visual Studio Code.app")).unwrap();

        let found = probe(&[dir.clone()]);
        let names: Vec<&str> = found.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Visual Studio Code", "Zed"]);
        assert!(found[1].path.ends_with("Zed.app"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finds_nothing_in_an_empty_root() {
        let dir = std::env::temp_dir().join(format!("nyra-editors-empty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(probe(&[dir.clone()]).is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn looks_in_the_system_folder_too() {
        // TextEdit has not been in /Applications since Catalina, so a probe that
        // only looked there would miss the one editor every Mac has.
        assert!(probe_roots()
            .iter()
            .any(|r| r.ends_with("System/Applications")));
    }
}
