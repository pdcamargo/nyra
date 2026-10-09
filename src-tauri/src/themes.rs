//! User themes, one JSON file each in `~/.nyra/themes/`.
//!
//! Files rather than a settings key so a theme can be shared by sending it, and
//! so the folder is something a person can open and recognise. The renderer owns
//! the schema — it validates on read and on import — so this side lists raw
//! values verbatim, the way the flow store does, and never drops a field it does
//! not know about.
//!
//! Writes are atomic: dev and the installed app share `~/.nyra`, and a theme
//! half-written by one while the other lists the folder should read as the old
//! theme, not as a corrupt one.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::util;

fn themes_dir() -> PathBuf {
    util::home_dir().join(".nyra").join("themes")
}

/// Lowercase letters, digits and hyphens, starting with a letter or digit.
///
/// The id becomes a file name, so this is the whole of the path-traversal
/// defence: nothing with a dot or a slash in it gets near `join`.
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
}

fn list_in(dir: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        // A corrupt file is skipped, not fatal: the other themes still load.
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                out.push(value);
            }
        }
    }
    out
}

fn save_in(dir: &Path, id: &str, body: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err(format!("not a theme id: {id}"));
    }
    serde_json::from_str::<Value>(body).map_err(|e| format!("not JSON: {e}"))?;
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let target = dir.join(format!("{id}.json"));
    let tmp = dir.join(format!(".{id}.json.{}", util::rand_hex(6)));
    fs::write(&tmp, body).map_err(|e| format!("could not write the theme: {e}"))?;
    fs::rename(&tmp, &target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not save the theme: {e}")
    })?;
    Ok(target)
}

fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("not a theme id: {id}"));
    }
    match fs::remove_file(dir.join(format!("{id}.json"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn themes_list() -> Vec<Value> {
    list_in(&themes_dir())
}

#[tauri::command]
pub fn themes_save(id: String, body: String) -> Value {
    match save_in(&themes_dir(), &id, &body) {
        Ok(_) => {
            util::emit("nyra:themes-changed", json!({}));
            json!({ "success": true })
        }
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command]
pub fn themes_delete(id: String) -> Value {
    match delete_in(&themes_dir(), &id) {
        Ok(()) => {
            util::emit("nyra:themes-changed", json!({}));
            json!({ "success": true })
        }
        Err(e) => json!({ "error": e }),
    }
}

/// The folder, created if it is not there yet, so "Themes folder" always has
/// somewhere to open.
#[tauri::command]
pub fn themes_dir_path() -> Result<String, String> {
    let dir = themes_dir();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyra-themes-test-{}-{}", std::process::id(), util::rand_hex(4)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn ids_cannot_leave_the_folder() {
        assert!(valid_id("ember"));
        assert!(valid_id("rose-pine-2"));
        assert!(!valid_id(""));
        assert!(!valid_id("../ember"));
        assert!(!valid_id("a/b"));
        assert!(!valid_id("Ember"));
        assert!(!valid_id("-ember"));
        assert!(!valid_id(&"a".repeat(65)));
    }

    #[test]
    fn saves_lists_and_deletes() {
        let dir = scratch();
        save_in(&dir, "ember", r#"{"id":"ember","name":"Ember","extra":1}"#).unwrap();
        let listed = list_in(&dir);
        assert_eq!(listed.len(), 1);
        // Unknown fields survive the round trip.
        assert_eq!(listed[0]["extra"], 1);
        delete_in(&dir, "ember").unwrap();
        assert!(list_in(&dir).is_empty());
        // Deleting what is already gone is not an error.
        delete_in(&dir, "ember").unwrap();
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_bad_ids_and_bad_json_and_skips_corrupt_files() {
        let dir = scratch();
        assert!(save_in(&dir, "../x", "{}").is_err());
        assert!(save_in(&dir, "x", "not json").is_err());
        fs::write(dir.join("broken.json"), "{").unwrap();
        save_in(&dir, "fine", "{}").unwrap();
        assert_eq!(list_in(&dir).len(), 1);
        // No temp files left behind.
        let stray = fs::read_dir(&dir).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().starts_with('.')).count();
        assert_eq!(stray, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_folder_lists_nothing() {
        assert!(list_in(Path::new("/definitely/not/here/nyra-themes")).is_empty());
    }
}
