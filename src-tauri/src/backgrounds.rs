//! Chat background images, copied into `~/.nyra/backgrounds/`.
//!
//! Copied rather than referenced, so moving or deleting the original does not
//! blank the chat, and settings hold only a file name — the store lives in
//! localStorage, which has no room for a picture. The renderer reads an image
//! back through `fs_ops::read_image`, the same path the transcript uses.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::{fs_ops, util};

const EXTENSIONS: [&str; 5] = ["png", "jpg", "jpeg", "gif", "webp"];

fn backgrounds_dir() -> PathBuf {
    util::home_dir().join(".nyra").join("backgrounds")
}

fn extension_of(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    EXTENSIONS.contains(&ext.as_str()).then_some(ext)
}

/// A name this module could have made: lowercase hex, a dot, a known
/// extension. The name becomes a path, so this is the whole of the traversal
/// defence — nothing with a slash or a second dot gets near `join`.
fn valid_name(name: &str) -> bool {
    let Some((stem, ext)) = name.split_once('.') else {
        return false;
    };
    !stem.is_empty()
        && stem.len() <= 32
        && stem.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c))
        && EXTENSIONS.contains(&ext)
}

fn import_into(dir: &Path, source: &Path) -> Result<String, String> {
    let ext = extension_of(source).ok_or("Pick a PNG, JPEG, GIF or WebP image.")?;
    let meta = fs::metadata(source).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Not a file.".into());
    }
    // `read_image` refuses anything bigger, so an import past it would be a
    // file that can never be shown.
    if meta.len() > fs_ops::MAX_IMAGE_BYTES {
        return Err(format!(
            "Image too large: {:.1} MB. Maximum is 10 MB.",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }
    fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let name = format!("{}.{ext}", util::rand_hex(8));
    fs::copy(source, dir.join(&name)).map_err(|e| format!("could not copy the image: {e}"))?;
    Ok(name)
}

fn delete_in(dir: &Path, name: &str) -> Result<(), String> {
    if !valid_name(name) {
        return Err(format!("not a background: {name}"));
    }
    match fs::remove_file(dir.join(name)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Copy a picked image in, returning `{ name }` to keep in settings.
#[tauri::command]
pub fn backgrounds_import(path: String) -> Value {
    match import_into(&backgrounds_dir(), Path::new(&path)) {
        Ok(name) => json!({ "name": name }),
        Err(e) => json!({ "error": e }),
    }
}

/// `{ base64, mediaType }`, or `{ error }` — `fs_read_image`'s shape.
#[tauri::command]
pub async fn backgrounds_read(name: String) -> Value {
    if !valid_name(&name) {
        return json!({ "error": format!("not a background: {name}") });
    }
    fs_ops::read_image(&backgrounds_dir().join(&name).to_string_lossy()).await
}

#[tauri::command]
pub fn backgrounds_delete(name: String) -> Value {
    match delete_in(&backgrounds_dir(), &name) {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyra-bg-test-{}-{}", std::process::id(), util::rand_hex(4)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn names_cannot_leave_the_folder() {
        assert!(valid_name("0a1b2c3d4e5f6789.png"));
        assert!(valid_name("deadbeef.jpeg"));
        assert!(!valid_name("../deadbeef.png"));
        assert!(!valid_name("dead/beef.png"));
        assert!(!valid_name("deadbeef.svg"));
        assert!(!valid_name("deadbeef.png.png"));
        assert!(!valid_name("DEADBEEF.png"));
        assert!(!valid_name(".png"));
    }

    #[test]
    fn imports_and_deletes() {
        let src_dir = scratch();
        let dir = scratch();
        let source = src_dir.join("Photo.JPG");
        fs::write(&source, b"not really a jpeg").unwrap();

        let name = import_into(&dir, &source).unwrap();
        assert!(valid_name(&name));
        assert!(name.ends_with(".jpg"));
        assert_eq!(fs::read(dir.join(&name)).unwrap(), b"not really a jpeg");

        delete_in(&dir, &name).unwrap();
        assert!(!dir.join(&name).exists());
        // Deleting twice is not an error: the renderer may race itself.
        delete_in(&dir, &name).unwrap();

        assert!(import_into(&dir, &src_dir.join("notes.txt")).is_err());
        let _ = fs::remove_dir_all(&src_dir);
        let _ = fs::remove_dir_all(&dir);
    }
}
