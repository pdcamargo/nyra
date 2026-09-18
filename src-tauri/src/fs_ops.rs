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

/// Hard refusal. Matches MAX_IMAGE_BYTES and file_extractor::MAX_FILE_SIZE, so
/// "too large" means the same number wherever it is said.
const MAX_PREVIEW_BYTES: u64 = 10 * 1024 * 1024;
/// What actually crosses the IPC boundary. Monaco is comfortable well past this;
/// the serde -> JSON -> structuredClone round trip is what is not.
const PREVIEW_BUDGET_BYTES: usize = 1024 * 1024;
const PREVIEW_BUDGET_LINES: usize = 20_000;
/// The window git uses to decide a blob is binary.
const BINARY_SNIFF_BYTES: usize = 8192;

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TextFileResult {
    pub content: String,
    /// `content` is a prefix. The viewer says so and points at "Open with" —
    /// this is a preview, not a pager for a 300 MB log.
    pub truncated: bool,
    pub total_bytes: u64,
    pub returned_bytes: usize,
    /// Invalid UTF-8 was replaced rather than refused. Plenty of real source is
    /// Latin-1, and a read-only view can show it honestly.
    pub lossy: bool,
    /// The stamp that was true for this content, so the poller has a baseline
    /// without a second round trip.
    pub mtime_ms: i64,
    pub ino: u64,
}

/// Why a preview did or did not happen.
///
/// A tagged union rather than `{ content, error }` so the renderer switches on a
/// name instead of string-matching an OS message.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ReadTextOutcome {
    Text(TextFileResult),
    Binary { size: u64 },
    TooLarge { size: u64, limit: u64 },
    /// Distinguished for the same reason `read_image` distinguishes it: a file
    /// Claude has not written yet is worth trying again.
    Missing,
    NotAFile,
    Error { message: String },
}

#[derive(Debug, Serialize, PartialEq, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub exists: bool,
    pub size: u64,
    pub mtime_ms: i64,
    /// 0 on Windows. Catches an atomic save whose replacement happens to land on
    /// the same size and the same coarse mtime.
    pub ino: u64,
}

fn validate_absolute(file_path: &str) -> Result<(), String> {
    if !Path::new(file_path).is_absolute() {
        return Err("File path must be absolute.".into());
    }
    Ok(())
}

/// Anything we refuse before opening the file. Pure, so the size ceiling is
/// tested without a 10 MB fixture.
fn preview_rejection(is_file: bool, len: u64) -> Option<ReadTextOutcome> {
    if !is_file {
        return Some(ReadTextOutcome::NotAFile);
    }
    if len > MAX_PREVIEW_BYTES {
        return Some(ReadTextOutcome::TooLarge { size: len, limit: MAX_PREVIEW_BYTES });
    }
    None
}

/// git's heuristic: a NUL in the first few KB. A UTF-16 BOM is called out too,
/// so a three-byte UTF-16 file answers the same way a long one would.
fn looks_binary(head: &[u8]) -> bool {
    if matches!(head, [0xFF, 0xFE, ..] | [0xFE, 0xFF, ..]) {
        return true;
    }
    head.iter().take(BINARY_SNIFF_BYTES).any(|b| *b == 0)
}

/// Cut to the budget at a line boundary.
///
/// The boundary matters: half a token is what makes a highlighter produce a
/// screenful of garbage for the rest of the file.
///
/// `more_follows` says `bytes` is a prefix of a longer file. It has to be told,
/// because the caller reads through a `.take()` — so filling the buffer exactly
/// looks identical to reaching the end, and guessing wrong there cuts the last
/// line in half on every file at or over the budget.
fn truncate_to_budget(
    bytes: &[u8],
    max_bytes: usize,
    max_lines: usize,
    more_follows: bool,
) -> (&[u8], bool) {
    let mut end = bytes.len().min(max_bytes);
    let mut hit_cap = end < bytes.len();

    let mut lines = 0usize;
    for (i, b) in bytes.iter().enumerate().take(end) {
        if *b == b'\n' {
            lines += 1;
            if lines >= max_lines {
                end = i + 1;
                hit_cap = true;
                break;
            }
        }
    }

    if !hit_cap && !more_follows {
        return (bytes, false);
    }
    // Back up to the last complete line, unless there is no newline to back up
    // to — a single enormous line is cut where the budget says.
    let cut = bytes[..end].iter().rposition(|b| *b == b'\n').map_or(end, |i| i + 1);
    (&bytes[..cut], true)
}

fn mtime_ms_of(meta: &std::fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(unix)]
fn ino_of(meta: &std::fs::Metadata) -> u64 {
    std::os::unix::fs::MetadataExt::ino(meta)
}

#[cfg(not(unix))]
fn ino_of(_meta: &std::fs::Metadata) -> u64 {
    0
}

/// A file's text, for the read-only preview.
///
/// Separate from `read_file` on purpose. That one backs the skill editor, which
/// reads, edits and writes back — a truncating read there would silently drop
/// the tail of somebody's file on save.
pub async fn read_text_file(file_path: &str) -> ReadTextOutcome {
    use tokio::io::AsyncReadExt;

    if let Err(message) = validate_absolute(file_path) {
        return ReadTextOutcome::Error { message };
    }

    let meta = match tokio::fs::metadata(file_path).await {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return ReadTextOutcome::Missing,
        Err(e) => return ReadTextOutcome::Error { message: e.to_string() },
    };
    if let Some(refused) = preview_rejection(meta.is_file(), meta.len()) {
        return refused;
    }

    // Bounded by the budget, never by the file: a 9 MB file passes the ceiling
    // above and would still be a 9 MB String and a 9 MB IPC message.
    let file = match tokio::fs::File::open(file_path).await {
        Ok(f) => f,
        Err(e) => return ReadTextOutcome::Error { message: e.to_string() },
    };
    let mut buf = Vec::new();
    if let Err(e) = file.take(PREVIEW_BUDGET_BYTES as u64).read_to_end(&mut buf).await {
        return ReadTextOutcome::Error { message: e.to_string() };
    }

    if looks_binary(&buf) {
        return ReadTextOutcome::Binary { size: meta.len() };
    }

    // `buf` stops at the budget, so a shorter buffer than the file means the
    // read was cut and the last line in it is probably half of one.
    let more_follows = (buf.len() as u64) < meta.len();
    let (kept, cut) =
        truncate_to_budget(&buf, PREVIEW_BUDGET_BYTES, PREVIEW_BUDGET_LINES, more_follows);
    let text = String::from_utf8_lossy(kept);
    let lossy = matches!(text, std::borrow::Cow::Owned(_));

    ReadTextOutcome::Text(TextFileResult {
        returned_bytes: kept.len(),
        // Reading less than the file is also truncation, even when the budget
        // landed on a line boundary exactly.
        truncated: cut || (kept.len() as u64) < meta.len(),
        total_bytes: meta.len(),
        lossy,
        mtime_ms: mtime_ms_of(&meta),
        ino: ino_of(&meta),
        content: text.into_owned(),
    })
}

/// Enough to notice a file changed underneath an open preview.
///
/// Polled rather than watched: an inotify watch on a *file* survives on an
/// unlinked inode when an editor saves by writing a temp file and renaming over
/// it, so the preview would go quiet exactly when it mattered. A stat every
/// second and a half costs nothing and cannot miss that.
pub async fn stat_file(file_path: &str) -> FileStamp {
    match tokio::fs::metadata(file_path).await {
        Ok(meta) => FileStamp {
            exists: true,
            size: meta.len(),
            mtime_ms: mtime_ms_of(&meta),
            ino: ino_of(&meta),
        },
        Err(_) => FileStamp { exists: false, size: 0, mtime_ms: 0, ino: 0 },
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
    fn sniffs_binary_by_a_nul_in_the_head() {
        assert!(!looks_binary(b"fn main() {}"));
        assert!(!looks_binary(b""));
        assert!(looks_binary(b"\x7fELF\0\0\0"));
        assert!(looks_binary(&[0xFF, 0xFE, b'a']));
        assert!(looks_binary(&[0xFE, 0xFF, b'a']));
    }

    #[test]
    fn only_sniffs_the_window_it_says_it_does() {
        let mut early = vec![b'a'; BINARY_SNIFF_BYTES];
        early[BINARY_SNIFF_BYTES - 1] = 0;
        assert!(looks_binary(&early));

        let mut late = vec![b'a'; BINARY_SNIFF_BYTES + 8];
        late[BINARY_SNIFF_BYTES + 4] = 0;
        assert!(!looks_binary(&late));
    }

    #[test]
    fn truncates_to_a_line_boundary_not_mid_token() {
        let (kept, cut) = truncate_to_budget(b"alpha\nbravo\ncharlie\n", 9, 100, false);
        assert!(cut);
        assert_eq!(kept, b"alpha\n");
    }

    #[test]
    fn stops_at_the_line_cap_before_the_byte_cap() {
        let src = b"a\nb\nc\nd\ne\n";
        let (kept, cut) = truncate_to_budget(src, 1000, 2, false);
        assert!(cut);
        assert_eq!(kept, b"a\nb\n");
    }

    #[test]
    fn leaves_a_file_that_fits_alone() {
        let (kept, cut) = truncate_to_budget(b"alpha\nbravo\n", 1000, 100, false);
        assert!(!cut);
        assert_eq!(kept, b"alpha\nbravo\n");
    }

    #[test]
    fn handles_a_file_with_no_newline_at_all() {
        let (kept, cut) = truncate_to_budget(b"one very long line", 8, 100, false);
        assert!(cut);
        // Nothing to back up to, so it cuts at the budget rather than returning
        // nothing at all.
        assert_eq!(kept, b"one very");
    }

    // A codepoint straddling the cut must cost one replacement character, not a
    // panic — `from_utf8_lossy` is what makes the budget safe to apply to bytes.
    #[test]
    fn survives_a_multibyte_codepoint_across_the_boundary() {
        let src = "aé".as_bytes();
        let (kept, _) = truncate_to_budget(src, 2, 100, false);
        assert_eq!(String::from_utf8_lossy(kept), "a\u{fffd}");
    }

    // The renderer switches on `kind` and reads camelCase fields. Nothing else
    // checks that the wire shape matches the TypeScript union, so this does.
    #[test]
    fn serializes_the_shape_the_renderer_expects() {
        let text = serde_json::to_value(ReadTextOutcome::Text(TextFileResult {
            content: "hi".into(),
            truncated: true,
            total_bytes: 9,
            returned_bytes: 2,
            lossy: false,
            mtime_ms: 5,
            ino: 7,
        }))
        .unwrap();
        assert_eq!(text["kind"], "text");
        assert_eq!(text["totalBytes"], 9);
        assert_eq!(text["returnedBytes"], 2);
        assert_eq!(text["mtimeMs"], 5);

        let too_large = serde_json::to_value(ReadTextOutcome::TooLarge { size: 1, limit: 2 }).unwrap();
        assert_eq!(too_large["kind"], "tooLarge");

        assert_eq!(
            serde_json::to_value(ReadTextOutcome::NotAFile).unwrap()["kind"],
            "notAFile"
        );
        assert_eq!(
            serde_json::to_value(ReadTextOutcome::Missing).unwrap()["kind"],
            "missing"
        );

        let stamp = serde_json::to_value(FileStamp {
            exists: true,
            size: 3,
            mtime_ms: 4,
            ino: 5,
        })
        .unwrap();
        assert_eq!(stamp["mtimeMs"], 4);
        assert_eq!(stamp["exists"], true);
    }

    // The bug the real-file test caught: a buffer that exactly fills the budget
    // looks complete, but the caller only ever hands over a `.take()` prefix, so
    // the last line was being cut in half on every file at or over 1 MiB.
    #[test]
    fn cuts_back_to_a_line_when_the_buffer_is_only_a_prefix() {
        let (kept, cut) = truncate_to_budget(b"alpha\nbravo\nchar", 16, 100, true);
        assert!(cut);
        assert_eq!(kept, b"alpha\nbravo\n");
    }

    #[test]
    fn refuses_only_what_is_over_the_ceiling() {
        assert_eq!(preview_rejection(true, MAX_PREVIEW_BYTES), None);
        assert_eq!(
            preview_rejection(true, MAX_PREVIEW_BYTES + 1),
            Some(ReadTextOutcome::TooLarge {
                size: MAX_PREVIEW_BYTES + 1,
                limit: MAX_PREVIEW_BYTES
            })
        );
        assert_eq!(preview_rejection(false, 10), Some(ReadTextOutcome::NotAFile));
    }

    #[test]
    fn rejects_relative_paths() {
        assert!(renderable_media_type("out.png").is_err());
        assert!(renderable_media_type("./out.png").is_err());
        assert!(renderable_media_type("../out.png").is_err());
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("nyra-read-{tag}-{}", crate::util::rand_suffix(8)));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[tokio::test]
    async fn reads_a_source_file_whole() {
        let dir = scratch("text");
        let at = dir.join("a.ts");
        std::fs::write(&at, "export const x = 1\n").unwrap();

        match read_text_file(at.to_str().unwrap()).await {
            ReadTextOutcome::Text(result) => {
                assert_eq!(result.content, "export const x = 1\n");
                assert!(!result.truncated);
                assert!(!result.lossy);
                assert!(result.mtime_ms > 0);
            }
            other => panic!("expected text, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn refuses_a_binary_without_trying_to_decode_it() {
        let dir = scratch("bin");
        let at = dir.join("a.bin");
        std::fs::write(&at, [0x7f, b'E', b'L', b'F', 0, 0, 0, 1]).unwrap();

        assert!(matches!(
            read_text_file(at.to_str().unwrap()).await,
            ReadTextOutcome::Binary { .. }
        ));
        std::fs::remove_dir_all(&dir).ok();
    }

    // The point of the byte budget: a file far larger than it must come back
    // bounded, and must say that it did.
    #[tokio::test]
    async fn truncates_a_file_past_the_budget_and_admits_it() {
        let dir = scratch("big");
        let at = dir.join("big.txt");
        let line = "x".repeat(99);
        let body: String = std::iter::repeat(line.as_str())
            .take(PREVIEW_BUDGET_BYTES / 100 + 500)
            .collect::<Vec<_>>()
            .join("\n");
        std::fs::write(&at, &body).unwrap();

        match read_text_file(at.to_str().unwrap()).await {
            ReadTextOutcome::Text(result) => {
                assert!(result.truncated);
                assert!(result.returned_bytes <= PREVIEW_BUDGET_BYTES);
                assert!(result.total_bytes > result.returned_bytes as u64);
                // Cut on a line boundary, so the last line is whole.
                assert!(result.content.ends_with('\n'));
            }
            other => panic!("expected text, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn distinguishes_a_missing_file_from_a_directory() {
        let dir = scratch("missing");
        assert_eq!(
            read_text_file(dir.join("nope.ts").to_str().unwrap()).await,
            ReadTextOutcome::Missing
        );
        assert_eq!(
            read_text_file(dir.to_str().unwrap()).await,
            ReadTextOutcome::NotAFile
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn shows_latin1_rather_than_refusing_it() {
        let dir = scratch("lossy");
        let at = dir.join("a.txt");
        // 0xE9 is 'é' in Latin-1 and invalid on its own in UTF-8.
        std::fs::write(&at, [b'c', b'a', b'f', 0xE9, b'\n']).unwrap();

        match read_text_file(at.to_str().unwrap()).await {
            ReadTextOutcome::Text(result) => {
                assert!(result.lossy);
                assert!(result.content.starts_with("caf"));
            }
            other => panic!("expected text, got {other:?}"),
        }
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn stat_notices_a_file_appearing_and_changing() {
        let dir = scratch("stamp");
        let at = dir.join("a.txt");

        let before = stat_file(at.to_str().unwrap()).await;
        assert!(!before.exists);

        std::fs::write(&at, "one").unwrap();
        let after = stat_file(at.to_str().unwrap()).await;
        assert!(after.exists);
        assert_eq!(after.size, 3);

        std::fs::write(&at, "one more").unwrap();
        let grown = stat_file(at.to_str().unwrap()).await;
        assert_ne!(grown.size, after.size);

        std::fs::remove_dir_all(&dir).ok();
    }
}
