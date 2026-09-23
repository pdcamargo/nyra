//! Filesystem helpers backing the renderer's `fs`, `system`, and attachment APIs.

use base64::Engine;
use once_cell::sync::Lazy;
use serde::Serialize;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::util;

/// Scratch dirs for attachments, scoped to this process.
///
/// The pid suffix is load-bearing. These were `nyra-images` and `nyra-files`,
/// shared by every running Nyra — and `cleanup_temp_dirs` below wipes them on
/// quit, which `shutdown` also runs on SIGTERM, which is what `tauri dev` sends
/// on every hot restart. So a dev rebuild deleted the installed app's staged
/// attachments, and every later attach in that app failed. Same shape as
/// `nyra-editors-{pid}` in `open_with.rs` and `nyra-title-{pid}` in `ai_title.rs`.
pub static IMAGES_DIR: Lazy<PathBuf> =
    Lazy::new(|| util::temp_dir().join(format!("nyra-images-{}", std::process::id())));
pub static FILES_DIR: Lazy<PathBuf> =
    Lazy::new(|| util::temp_dir().join(format!("nyra-files-{}", std::process::id())));

/// Scratch-dir names owned by exactly one instance, shaped `{prefix}{pid}`.
/// `nyra-devshots-` belongs to `devtools.rs`; it is swept here so there is one
/// place that knows what a per-instance scratch dir looks like.
const SCRATCH_PREFIXES: [&str; 3] = ["nyra-images-", "nyra-files-", "nyra-devshots-"];

// The un-suffixed `nyra-images` / `nyra-files` this replaced are deliberately
// left alone. A surviving one means either an older build is running right now
// or it was killed, and nothing here can tell those apart — so sweeping them
// would delete a live instance's staged attachments, which is the bug the pid
// suffix exists to fix. They are a few KB, and the OS reclaims $TMPDIR anyway.

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
const RENDERABLE_IMAGES: [(&str, &str); 5] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
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
        .ok_or_else(|| "Not a PNG, JPEG, GIF or WebP image.".to_string())
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

/// How many entries a directory browse offers. Wider than the fuzzy limit
/// because these are one level, already inside the directory you asked for, and
/// the popup scrolls.
const BROWSE_LIMIT: usize = 30;

/// A query that names a directory to open, split into the directory and the
/// fragment to filter its entries by.
///
/// `@../api` cannot go through `git ls-files`: it asks about a directory that is
/// not even in this repository, and no fuzzy match over tracked paths will ever
/// produce it. Anything with a path separator — or a bare `.` or `..`, or an
/// absolute or `~` path — is a directory to open; the rest of the query is the
/// fragment to filter what is inside it.
///
/// `~/code` keeps its own spelling in the answer. The user typed it, and a
/// readable path in the composer is the point; only the read underneath
/// expands it.
fn browse_split(query: &str) -> Option<(String, String)> {
    if query.is_empty() {
        return None;
    }
    let absolute = query.starts_with('/') || query.starts_with('~');
    if !absolute && !query.contains('/') && query != "." && query != ".." {
        return None;
    }
    let (dir, filter) = match query.rfind('/') {
        // A trailing slash names the directory itself: `@../` is "show me what
        // is next door".
        Some(at) if at + 1 == query.len() => (&query[..at], ""),
        Some(at) => (&query[..at], &query[at + 1..]),
        None => (query, ""),
    };
    // `/home` splits to an empty directory at the root, which is still a
    // directory worth reading.
    let dir = if dir.is_empty() && absolute { "/" } else { dir };
    Some((dir.to_string(), filter.to_string()))
}

/// Resolve a browse directory against the chat's cwd, expanding `~`.
fn browse_base(cwd: &str, dir: &str) -> PathBuf {
    if let Some(rest) = dir.strip_prefix("~/") {
        return util::home_dir().join(rest);
    }
    if dir == "~" {
        return util::home_dir();
    }
    if Path::new(dir).is_absolute() {
        return PathBuf::from(dir);
    }
    Path::new(cwd).join(dir)
}

/// One directory's entries, for a path-shaped `@` query.
///
/// Folders first and prefix matches first, both by name: while you are typing
/// `@../ap`, `api.v2/` should be the first row, not the twenty-ninth.
async fn browse_directory(cwd: &str, dir: &str, filter: &str) -> Vec<FileEntry> {
    let Ok(mut entries) = tokio::fs::read_dir(browse_base(cwd, dir)).await else {
        return Vec::new();
    };

    let needle = filter.to_lowercase();
    // Dot-entries are noise unless you are asking for one.
    let want_hidden = needle.starts_with('.');
    let mut found: Vec<(String, String, bool)> = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') && !want_hidden {
            continue;
        }
        let lower = name.to_lowercase();
        if !lower.contains(&needle) {
            continue;
        }
        let is_dir = entry.file_type().await.map(|t| t.is_dir()).unwrap_or(false);
        found.push((name, lower, is_dir));
    }

    // Stable sorts, so the alphabetical order survives inside each rank.
    found.sort_by(|a, b| a.1.cmp(&b.1));
    found.sort_by_key(|(_, lower, is_dir)| (!lower.starts_with(&needle), !*is_dir));

    // `dir` keeps the shape the user typed: `..`, `../api.v2`, `/tmp`, `~/dev`.
    let prefix = if dir == "/" { "" } else { dir };
    found
        .into_iter()
        .take(BROWSE_LIMIT)
        .map(|(name, _, is_dir)| FileEntry {
            path: format!("{prefix}/{name}{}", if is_dir { "/" } else { "" }),
            kind: if is_dir { "folder" } else { "file" },
        })
        .collect()
}

/// Fuzzy file lookup for the `@` mention autocomplete. Prefers `git ls-files`
/// (respects .gitignore, no deep traversal) and degrades to a shallow readdir.
pub async fn list_files(cwd: &str, query: &str) -> Vec<FileEntry> {
    if let Some((dir, filter)) = browse_split(query) {
        let browsed = browse_directory(cwd, &dir, &filter).await;
        if !browsed.is_empty() {
            return browsed;
        }
        // Nothing to open. The query may still name a path *inside* the repo —
        // `@src/comp` is a fine way to reach `src/components/…` — so fall
        // through to the fuzzy search rather than closing the popup.
    }
    fuzzy_list_files(cwd, query).await
}

async fn fuzzy_list_files(cwd: &str, query: &str) -> Vec<FileEntry> {
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

/// Wipe our own scratch dirs on quit, same as the Electron `will-quit` handler.
/// Ours only — see `IMAGES_DIR` for what wiping everyone's cost.
pub fn cleanup_temp_dirs() {
    let _ = std::fs::remove_dir_all(&*IMAGES_DIR);
    let _ = std::fs::remove_dir_all(&*FILES_DIR);
}

/// Scratch dirs whose owning process is gone.
///
/// Split out from `sweep_orphan_dirs` so the pid parsing and the liveness rule
/// are testable without a real process table.
fn orphan_dirs(root: &Path, alive: &dyn Fn(i32) -> bool) -> Vec<PathBuf> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let owner = SCRATCH_PREFIXES
            .iter()
            .find_map(|prefix| name.strip_prefix(prefix))
            .and_then(|pid| pid.parse::<i32>().ok());
        if let Some(pid) = owner {
            if !alive(pid) {
                out.push(entry.path());
            }
        }
    }
    out
}

/// Reap scratch dirs left by instances that are gone.
///
/// Per-pid dirs are only cleaned by the process that owns them, so a SIGKILL —
/// or a crash — strands one. Without this, the fix for the shared-directory bug
/// would trade it for a slow leak of one directory per unclean exit.
pub fn sweep_orphan_dirs() {
    for dir in orphan_dirs(&util::temp_dir(), &|pid| crate::processes::is_alive(pid)) {
        crate::log!("temp-sweep", "Removing orphaned scratch dir {}", dir.display());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The reason the pid suffix exists: two instances must not be able to name
    /// — and so wipe — each other's scratch dirs.
    #[test]
    fn scratch_dirs_are_scoped_to_this_process() {
        let suffix = format!("-{}", std::process::id());
        for dir in [&*IMAGES_DIR, &*FILES_DIR] {
            let name = dir.file_name().unwrap().to_string_lossy().to_string();
            assert!(name.ends_with(&suffix), "{name} is not scoped to this process");
        }
        assert_ne!(*IMAGES_DIR, *FILES_DIR);
    }

    #[test]
    fn sweeps_dead_instances_and_nothing_else() {
        let root = util::temp_dir().join(format!("nyra-sweep-{}", util::rand_suffix(8)));
        std::fs::create_dir_all(&root).unwrap();
        let dir = |name: &str| {
            let path = root.join(name);
            std::fs::create_dir_all(&path).unwrap();
            path
        };

        let dead_images = dir("nyra-images-4242");
        let dead_shots = dir("nyra-devshots-4242");
        let legacy = dir("nyra-images");
        let live_files = dir("nyra-files-77");
        let another_module = dir("nyra-editors-77");
        let not_a_pid = dir("nyra-files-scratch");
        // A plain file wearing a scratch name must not trip the dir walk.
        std::fs::write(root.join("nyra-files-99"), b"not a directory").unwrap();

        // Only pid 77 is still running.
        let orphans = orphan_dirs(&root, &|pid| pid == 77);

        assert!(orphans.contains(&dead_images));
        assert!(orphans.contains(&dead_shots));
        assert!(!orphans.contains(&live_files), "wiped a live instance's dir");
        assert!(!orphans.contains(&another_module), "wiped a dir it does not own");
        assert!(!orphans.contains(&not_a_pid));
        // An older build that is still running owns this one, and nothing here
        // can tell that from one left by a build that was killed.
        assert!(!orphans.contains(&legacy), "wiped a pre-pid dir a running old build may own");
        assert_eq!(orphans.len(), 2, "swept something unexpected: {orphans:?}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_png_and_jpeg_by_extension() {
        assert_eq!(renderable_media_type("/tmp/chart.png"), Ok("image/png"));
        assert_eq!(renderable_media_type("/tmp/shot.jpeg"), Ok("image/jpeg"));
        assert_eq!(renderable_media_type("/tmp/SHOT.JPG"), Ok("image/jpeg"));
        assert_eq!(renderable_media_type("/tmp/anim.gif"), Ok("image/gif"));
        assert_eq!(renderable_media_type("/tmp/preview.webp"), Ok("image/webp"));
    }

    #[test]
    fn rejects_non_images_before_touching_disk() {
        assert!(renderable_media_type("/etc/passwd").is_err());
        assert!(renderable_media_type("/tmp/diagram.svg").is_err());
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

    #[test]
    fn splits_a_query_into_a_directory_and_a_filter() {
        // The report: sitting in one project folder, reaching for its sibling.
        assert_eq!(browse_split("../"), Some(("..".to_string(), String::new())));
        assert_eq!(
            browse_split("../api.v2/ro"),
            Some(("../api.v2".to_string(), "ro".to_string()))
        );
        assert_eq!(
            browse_split("../api.v2/routes.ts"),
            Some(("../api.v2".to_string(), "routes.ts".to_string()))
        );
        // A directory of this one is reachable the same way.
        assert_eq!(browse_split("src/"), Some(("src".to_string(), String::new())));
        assert_eq!(browse_split("./"), Some((".".to_string(), String::new())));
        assert_eq!(browse_split(".."), Some(("..".to_string(), String::new())));
        assert_eq!(browse_split("."), Some((".".to_string(), String::new())));
        // Absolute and home paths are directories with more ahead of them.
        assert_eq!(
            browse_split("/Users/pd/dev"),
            Some(("/Users/pd".to_string(), "dev".to_string()))
        );
        assert_eq!(browse_split("/Users/"), Some(("/Users".to_string(), String::new())));
        assert_eq!(browse_split("/"), Some(("/".to_string(), String::new())));
        assert_eq!(browse_split("~/dev/"), Some(("~/dev".to_string(), String::new())));
    }

    #[test]
    fn leaves_a_bare_name_to_the_fuzzy_search() {
        // No separator and no directory: these are filenames to match, and still
        // the common case — `@ChatInput` must not list a whole directory.
        for query in ["", "Chat", "chat", ".env", "src"] {
            assert_eq!(browse_split(query), None, "{query} should not browse");
        }
    }

    #[tokio::test]
    async fn browses_the_directory_next_door() {
        let root = scratch("browse");
        let here = root.join("mv-ui");
        let there = root.join("api.v2");
        std::fs::create_dir_all(&here).unwrap();
        std::fs::create_dir_all(there.join("routes")).unwrap();
        std::fs::write(there.join("README.md"), "x").unwrap();
        std::fs::write(there.join("server.ts"), "x").unwrap();
        std::fs::create_dir_all(there.join(".git")).unwrap();

        let found = list_files(here.to_str().unwrap(), "../api.v2/").await;

        // Folders first, then alphabetically — and the paths keep the `../` that
        // was typed, because that is what the composer shows and sends.
        assert_eq!(
            found.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            vec!["../api.v2/routes/", "../api.v2/README.md", "../api.v2/server.ts"]
        );
        assert_eq!(found[0].kind, "folder");
        assert_eq!(found[1].kind, "file");
        // `.git` is not offered unless it is asked for.
        assert!(!found.iter().any(|e| e.path.contains(".git")));

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn browse_filters_the_directory_by_what_you_have_typed() {
        let root = scratch("browsefilter");
        let here = root.join("mv-ui");
        let there = root.join("api.v2");
        std::fs::create_dir_all(&here).unwrap();
        std::fs::create_dir_all(there.join("routes")).unwrap();
        std::fs::create_dir_all(there.join("server")).unwrap();
        std::fs::write(there.join("notes.md"), "x").unwrap();

        let found = list_files(here.to_str().unwrap(), "../api.v2/serv").await;
        assert_eq!(
            found.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            vec!["../api.v2/server/"]
        );

        std::fs::remove_dir_all(&root).ok();
    }

    #[tokio::test]
    async fn a_path_that_is_not_a_directory_still_gets_the_fuzzy_search() {
        let root = scratch("browsefallback");
        // The fuzzy half is `git ls-files`, so this has to be a real repository
        // for the assertion to mean anything. Skipped, not failed, where git is
        // not installed.
        let inited = std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&root)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !inited {
            std::fs::remove_dir_all(&root).ok();
            return;
        }
        std::fs::create_dir_all(root.join("src/components")).unwrap();
        std::fs::write(root.join("src/components/Chat.tsx"), "x").unwrap();

        // `components` is not a directory at the root here, so browsing finds
        // nothing and the query falls through to the deep match it always had —
        // this is the `@components/Cha` case, which reached `src/components/`.
        let found = list_files(root.to_str().unwrap(), "components/Cha").await;
        assert_eq!(
            found.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(),
            vec!["src/components/Chat.tsx"]
        );

        std::fs::remove_dir_all(&root).ok();
    }
}
