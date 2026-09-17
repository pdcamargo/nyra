//! Filesystem helpers backing the renderer's `fs`, `system`, and attachment APIs.

use base64::Engine;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::util;

pub static IMAGES_DIR: Lazy<PathBuf> = Lazy::new(|| util::temp_dir().join("nyra-images"));
pub static FILES_DIR: Lazy<PathBuf> = Lazy::new(|| util::temp_dir().join("nyra-files"));

const EXT_MAP: [(&str, &str); 4] = [
    ("image/png", "png"),
    ("image/jpeg", "jpg"),
    ("image/gif", "gif"),
    ("image/webp", "webp"),
];

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub path: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
}

pub async fn read_file(file_path: &str) -> Value {
    match tokio::fs::read_to_string(file_path).await {
        Ok(content) => json!({ "content": content }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;

/// What the transcript will display inline. An allowlist rather than a content
/// sniff, because the path comes out of Claude's prose: `![x](/etc/passwd)` has
/// to fail before we read anything, not after. SVG stays out deliberately — it
/// is a script-execution surface inside an `<img>` and needs its own decision
/// about sanitising.
const RENDERABLE_IMAGES: [(&str, &str); 3] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
];

/// The policy half of `read_image`, split out so it is testable without a disk.
fn renderable_media_type(file_path: &str) -> Result<&'static str, String> {
    if !Path::new(file_path).is_absolute() {
        return Err("Image path must be absolute.".into());
    }
    let ext = Path::new(file_path)
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    RENDERABLE_IMAGES
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, media_type)| *media_type)
        .ok_or_else(|| "Not a PNG or JPEG.".to_string())
}

/// Bytes for an image the transcript wants to show, as base64.
///
/// Read-only on purpose. `file_extractor::process_file` also returns base64 for
/// an image, but it copies the file into FILES_DIR on every call before it even
/// branches on type — right for an attachment, wrong for a transcript row that
/// remounts every time it scrolls past.
///
/// `missing` is flagged separately so the renderer can retry a file Claude has
/// not written yet without string-matching an OS error.
pub async fn read_image(file_path: &str) -> Value {
    let media_type = match renderable_media_type(file_path) {
        Ok(m) => m,
        Err(e) => return json!({ "error": e }),
    };
    let meta = match tokio::fs::metadata(file_path).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return json!({ "error": "Image not found.", "missing": true })
        }
        Err(e) => return json!({ "error": e.to_string() }),
    };
    if !meta.is_file() {
        return json!({ "error": "Not a file.", "missing": true });
    }
    if meta.len() > MAX_IMAGE_BYTES {
        // Same wording as the attachment extractor, so the placeholder reads the
        // same however the image reached the transcript.
        return json!({
            "error": format!(
                "Image too large: {:.1} MB. Maximum is 10 MB.",
                meta.len() as f64 / 1024.0 / 1024.0
            )
        });
    }
    match tokio::fs::read(file_path).await {
        Ok(bytes) => json!({
            "base64": base64::engine::general_purpose::STANDARD.encode(&bytes),
            "mediaType": media_type,
        }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// Undo a Claude edit: restore the captured original, or delete the file when it
/// didn't exist before.
pub async fn revert_file(file_path: &str, original_content: Option<String>) -> Value {
    let result = match original_content {
        Some(content) => tokio::fs::write(file_path, content).await,
        None => match tokio::fs::remove_file(file_path).await {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            other => other,
        },
    };
    match result {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// Fuzzy file lookup for the `@` mention autocomplete. Prefers `git ls-files`
/// (respects .gitignore, no deep traversal) and degrades to a shallow readdir.
pub async fn list_files(cwd: &str, query: &str) -> Vec<FileEntry> {
    let files: Vec<String> = match tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new("git")
            .args(["ls-files", "--cached", "--others", "--exclude-standard"])
            .current_dir(cwd)
            .output(),
    )
    .await
    {
        Ok(Ok(out)) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
        _ => {
            let mut entries = Vec::new();
            if let Ok(mut dir) = tokio::fs::read_dir(cwd).await {
                while let Ok(Some(e)) = dir.next_entry().await {
                    entries.push(e.file_name().to_string_lossy().to_string());
                    if entries.len() >= 500 {
                        break;
                    }
                }
            }
            entries
        }
    };

    const LIMIT: usize = 15;
    let q = query.to_lowercase();
    let mut results: Vec<FileEntry> = Vec::new();
    let mut seen_folders: std::collections::HashSet<String> = std::collections::HashSet::new();

    for file in files {
        if results.len() >= LIMIT {
            break;
        }
        if !file.to_lowercase().contains(&q) {
            continue;
        }
        // Surface matching ancestor folders alongside the file itself.
        let parts: Vec<&str> = file.split('/').collect();
        for i in 1..parts.len() {
            let folder = format!("{}/", parts[..i].join("/"));
            if seen_folders.contains(&folder) || !folder.to_lowercase().contains(&q) {
                continue;
            }
            seen_folders.insert(folder.clone());
            if results.len() < LIMIT {
                results.push(FileEntry {
                    path: folder,
                    kind: "folder",
                });
            }
        }
        results.push(FileEntry {
            path: file,
            kind: "file",
        });
    }

    results.truncate(LIMIT);
    results
}

pub async fn save_image(base64_data: &str, media_type: &str) -> Result<String, String> {
    let ext = EXT_MAP
        .iter()
        .find(|(m, _)| *m == media_type)
        .map(|(_, e)| *e)
        .unwrap_or("png");
    util::ensure_dir(&IMAGES_DIR).map_err(|e| e.to_string())?;
    let filename = format!("{}-{}.{ext}", util::now_ms(), util::rand_suffix(6));
    let file_path = IMAGES_DIR.join(filename);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .map_err(|e| e.to_string())?;
    tokio::fs::write(&file_path, bytes)
        .await
        .map_err(|e| e.to_string())?;
    Ok(file_path.to_string_lossy().to_string())
}

pub async fn save_temp_file(base64_data: &str, name: &str) -> Option<String> {
    util::ensure_dir(&FILES_DIR).ok()?;
    // Strip any path components — `name` comes from a browser drop event.
    let safe = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "file".into());
    let filename = format!("{}-{}-{safe}", util::now_ms(), util::rand_suffix(6));
    let file_path = FILES_DIR.join(filename);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data)
        .ok()?;
    tokio::fs::write(&file_path, bytes).await.ok()?;
    Some(file_path.to_string_lossy().to_string())
}

pub async fn write_text_file(file_path: &str, content: &str) -> Result<(), String> {
    tokio::fs::write(file_path, content)
        .await
        .map_err(|e| e.to_string())
}

/// Wipe the scratch dirs on quit, same as the Electron `will-quit` handler.
pub fn cleanup_temp_dirs() {
    let _ = std::fs::remove_dir_all(&*IMAGES_DIR);
    let _ = std::fs::remove_dir_all(&*FILES_DIR);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_png_and_jpeg_by_extension() {
        assert_eq!(renderable_media_type("/tmp/chart.png"), Ok("image/png"));
        assert_eq!(renderable_media_type("/tmp/shot.jpeg"), Ok("image/jpeg"));
        assert_eq!(renderable_media_type("/tmp/SHOT.JPG"), Ok("image/jpeg"));
    }

    #[test]
    fn rejects_non_images_before_touching_disk() {
        assert!(renderable_media_type("/etc/passwd").is_err());
        assert!(renderable_media_type("/tmp/diagram.svg").is_err());
        assert!(renderable_media_type("/tmp/anim.gif").is_err());
        assert!(renderable_media_type("/tmp/noextension").is_err());
    }

    #[test]
    fn rejects_relative_paths() {
        assert!(renderable_media_type("out.png").is_err());
        assert!(renderable_media_type("./out.png").is_err());
        assert!(renderable_media_type("../out.png").is_err());
    }
}
