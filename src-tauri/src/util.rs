//! Process-wide handles and small helpers shared by every backend module.
//!
//! The Electron build kept these as module-level singletons in the main process;
//! the equivalent here is a set of `Lazy` statics plus the `AppHandle` captured
//! during `setup`, which stands in for the old `mainWindow` reference.

use once_cell::sync::{Lazy, OnceCell};
use parking_lot::{Mutex, RwLock};
use rand::RngExt;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::platform;
use crate::settings::NyraSettings;

static APP: OnceCell<AppHandle> = OnceCell::new();
static SETTINGS: Lazy<RwLock<NyraSettings>> = Lazy::new(|| RwLock::new(NyraSettings::default()));
static CHILD_PATH: Lazy<Mutex<Option<String>>> = Lazy::new(|| Mutex::new(None));

pub fn set_app_handle(app: AppHandle) {
    let _ = APP.set(app);
}

pub fn app_handle() -> Option<&'static AppHandle> {
    APP.get()
}

pub fn main_window() -> Option<WebviewWindow> {
    APP.get().and_then(|a| a.get_webview_window("main"))
}

/// Fire an event at the renderer. Replaces `win.webContents.send(...)`.
pub fn emit<S: Serialize + Clone>(event: &str, payload: S) {
    if let Some(app) = APP.get() {
        if let Err(e) = app.emit(event, payload) {
            crate::logf!("emit({event}) failed: {e}");
        }
    }
}

pub fn settings() -> NyraSettings {
    SETTINGS.read().clone()
}

pub fn set_settings(next: NyraSettings) {
    *SETTINGS.write() = next;
}

pub fn home_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Past this many characters the CLI cuts a project directory's name and adds a
/// hash of the full path to keep it unique.
const PROJECT_DIR_NAME_MAX: usize = 200;

/// The directory the Claude CLI keeps a working directory's transcripts and
/// memory in: `~/.claude/projects/<cwd with every non-alphanumeric as ->`.
///
/// Every character, not only the separators. Read out of the 2.1.281 binary
/// (`replace(/[^a-zA-Z0-9]/g, "-")`), and visible on disk: `~/.claude/jobs` is
/// `-Users-x--claude-jobs`, and on Windows `C:\Users\x` is `C--Users-x`.
/// Swapping only `/` named a directory that does not exist for any path with a
/// dot in it, and for every path on Windows.
///
/// A name past the cap ends in a hash this does not reproduce, so that case is
/// found by its prefix among the directories that exist.
pub fn claude_project_dir(cwd: &str) -> PathBuf {
    let projects = home_dir().join(".claude").join("projects");
    let name: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if name.len() <= PROJECT_DIR_NAME_MAX {
        return projects.join(name);
    }
    let prefix = format!("{}-", &name[..PROJECT_DIR_NAME_MAX]);
    std::fs::read_dir(&projects)
        .ok()
        .and_then(|entries| {
            entries
                .flatten()
                .find(|entry| entry.file_name().to_string_lossy().starts_with(&prefix))
                .map(|entry| entry.path())
        })
        .unwrap_or_else(|| projects.join(&name[..PROJECT_DIR_NAME_MAX]))
}

pub fn temp_dir() -> PathBuf {
    std::env::temp_dir()
}

/// `mkdir -p`.
///
/// Deliberately not memoised. It was, and the cache short-circuited before
/// touching the filesystem — so once another instance deleted a scratch dir out
/// from under us, this returned `Ok` forever and every attachment in the
/// surviving process failed for the rest of its life. All three callers are on
/// the cold path of a user attaching a file; the saved syscall was worth nothing
/// and cost that.
pub fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Lowercase base36-ish suffix, matching `Math.random().toString(36).slice(2, 8)`.
pub fn rand_suffix(len: usize) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut rng = rand::rng();
    (0..len)
        .map(|_| ALPHABET[rng.random_range(0..ALPHABET.len())] as char)
        .collect()
}

pub fn rand_hex(bytes: usize) -> String {
    let mut rng = rand::rng();
    (0..bytes)
        .map(|_| format!("{:02x}", rng.random::<u8>()))
        .collect()
}

/// Short id used in log lines, mirroring `nyraSessionId.slice(0, 8)`.
pub fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

// ---------------------------------------------------------------------------
// PATH
// ---------------------------------------------------------------------------
//
// A GUI app launched from Finder inherits launchd's environment, whose PATH is
// `/usr/bin:/bin:/usr/sbin:/sbin` and nothing else. Every child we spawn — the
// Claude CLI, the integrated terminal, `claude /login` — goes through
// `clean_child_env`, so without this none of them can see `node`, `npx`, `bun`,
// `uv` or anything else a developer installed. `claude.rs` worked around it for
// the one binary it needed by probing absolute paths; this fixes the
// environment itself, which is what stdio MCP servers need. How each OS answers
// the question is `platform::login_shell_path` and `platform::FALLBACK_BINS`.

/// `~/a/b` → the home directory joined one component at a time, so the result
/// uses this OS's separator throughout and dedupes against what PATH already has.
pub fn expand_home(entry: &str) -> String {
    match entry.strip_prefix("~/") {
        Some(rest) => rest
            .split('/')
            .filter(|part| !part.is_empty())
            .fold(home_dir(), |acc, part| acc.join(part))
            .to_string_lossy()
            .to_string(),
        None => entry.to_string(),
    }
}

/// Add one PATH entry, canonical form first, deduped.
///
/// Version managers hand out per-shell directories: fnm's live at
/// `~/.local/state/fnm_multishells/<pid>_<timestamp>/bin`, named after the shell
/// that asked for one. Caching that for the life of the app means holding a path
/// that belonged to a shell which has since exited — a machine that has been up
/// a while accumulates thousands of them. The canonical target,
/// `~/.local/share/fnm/node-versions/<version>/installation/bin`, is stable, so
/// prefer it and keep the original behind it rather than betting on either.
///
/// An entry holding the list separator itself cannot be written back into a
/// PATH at all, so it is dropped rather than left to fail the whole join.
fn push_entry(out: &mut Vec<String>, seen: &mut HashSet<String>, entry: &str) {
    let entry = entry.trim();
    if entry.is_empty() || std::env::join_paths([entry]).is_err() {
        return;
    }
    let expanded = expand_home(entry);
    if let Some(real) = platform::canonical_dir(Path::new(&expanded)) {
        let real = real.to_string_lossy().to_string();
        if seen.insert(real.clone()) {
            out.push(real);
        }
    }
    if seen.insert(expanded.clone()) {
        out.push(expanded);
    }
}

fn push_path_list(out: &mut Vec<String>, seen: &mut HashSet<String>, list: &str) {
    for entry in std::env::split_paths(list) {
        push_entry(out, seen, &entry.to_string_lossy());
    }
}

fn build_child_path() -> String {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // The login shell first: it is the user's own answer to this question.
    if let Some(shell_path) = platform::login_shell_path() {
        push_path_list(&mut out, &mut seen, &shell_path);
    }
    // Then what we inherited, so system tools never disappear.
    if let Ok(inherited) = std::env::var("PATH") {
        push_path_list(&mut out, &mut seen, &inherited);
    }
    // Then the usual suspects, in case the probe told us nothing.
    for entry in platform::FALLBACK_BINS {
        push_entry(&mut out, &mut seen, entry);
    }

    std::env::join_paths(&out)
        .map(|joined| joined.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// The PATH every child of Nyra gets. Probed once, then cached for the process.
pub fn child_path() -> String {
    let mut cache = CHILD_PATH.lock();
    if let Some(cached) = cache.as_ref() {
        return cached.clone();
    }
    let built = build_child_path();
    crate::log!("path", "child PATH: {built}");
    *cache = Some(built.clone());
    built
}

/// Warm the cache off the startup path, so the first spawn never waits on an
/// interactive shell. Safe to call more than once.
pub fn prime_path() {
    std::thread::spawn(|| {
        let _ = child_path();
    });
}

/// The environment Claude is spawned with. `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID`
/// leak in when Nyra itself was launched from a Claude Code session and make the
/// child think it is a nested run. PATH is replaced rather than inherited — see
/// the block above for why the inherited one is useless.
pub fn clean_child_env() -> Vec<(String, String)> {
    // Windows spells it `Path`, and treats the two as one variable.
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| {
            k != "CLAUDECODE" && k != "CLAUDE_CODE_SESSION_ID" && !k.eq_ignore_ascii_case("PATH")
        })
        .collect();
    env.push(("PATH".to_string(), child_path()));
    env
}

/// Incremental UTF-8 decoder for PTY output.
///
/// A read can land mid-code-point; decoding each chunk independently would turn
/// every split emoji or box-drawing glyph into a replacement char in the
/// terminal. This holds the incomplete tail back until the next read completes it.
#[derive(Default)]
pub struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        self.pending.extend_from_slice(bytes);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(s) => {
                    out.push_str(s);
                    self.pending.clear();
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&self.pending[..valid]) });
                    match e.error_len() {
                        // Truncated sequence — keep it for the next read.
                        None => {
                            self.pending.drain(..valid);
                            break;
                        }
                        // Genuinely invalid bytes — emit U+FFFD and move on.
                        Some(len) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + len);
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `ensure_dir` used to memoise, and the memo answered `Ok` for a directory
    /// another instance had since deleted — so every attachment in the surviving
    /// process failed until it was restarted.
    #[test]
    fn ensure_dir_recreates_a_directory_that_vanished() {
        let dir = temp_dir().join(format!("nyra-ensure-{}", rand_suffix(8)));
        ensure_dir(&dir).unwrap();
        assert!(dir.is_dir());

        std::fs::remove_dir_all(&dir).unwrap();
        assert!(!dir.exists());

        ensure_dir(&dir).unwrap();
        assert!(dir.is_dir(), "a vanished directory has to come back");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn decoder_joins_a_split_code_point() {
        let heart = "💜".as_bytes();
        let mut d = Utf8Decoder::default();
        assert_eq!(d.push(&heart[..2]), "");
        assert_eq!(d.push(&heart[2..]), "💜");
    }

    #[test]
    fn decoder_passes_ascii_straight_through() {
        let mut d = Utf8Decoder::default();
        assert_eq!(d.push(b"hello"), "hello");
    }

    #[test]
    fn decoder_replaces_invalid_bytes() {
        let mut d = Utf8Decoder::default();
        assert_eq!(d.push(&[0xFF, b'a']), "\u{FFFD}a");
    }

    #[test]
    fn path_entries_dedupe_and_keep_first_position() {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        push_entry(&mut out, &mut seen, "/usr/bin");
        push_entry(&mut out, &mut seen, "  ");
        push_entry(&mut out, &mut seen, "/usr/bin");
        assert_eq!(out, vec!["/usr/bin".to_string()]);
    }

    #[test]
    fn path_entries_expand_a_leading_tilde() {
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        push_entry(&mut out, &mut seen, "~/.some-bin-that-does-not-exist");
        assert_eq!(out.len(), 1);
        assert!(out[0].starts_with(home_dir().to_string_lossy().as_ref()));
        assert!(!out[0].contains('~'));
    }

    /// The ordering guarantee fnm depends on: a per-shell directory that is
    /// really a symlink resolves to its stable target, and the stable target
    /// comes first so that is what a lookup finds.
    #[cfg(unix)]
    #[test]
    fn path_entries_put_the_canonical_form_first() {
        let base = temp_dir().join(format!("nyra-path-{}", rand_suffix(8)));
        let real = base.join("real-bin");
        let link = base.join("link-bin");
        std::fs::create_dir_all(&real).unwrap();
        std::os::unix::fs::symlink(&real, &link).unwrap();

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        push_entry(&mut out, &mut seen, &link.to_string_lossy());

        let real = std::fs::canonicalize(&real).unwrap().to_string_lossy().to_string();
        assert_eq!(out.first().map(String::as_str), Some(real.as_str()));
        assert_eq!(out.len(), 2, "the original is kept behind the canonical form");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(unix)]
    #[test]
    fn child_path_carries_the_system_directories() {
        let path = build_child_path();
        let entries: Vec<PathBuf> = std::env::split_paths(&path).collect();
        assert!(entries.iter().any(|p| p == Path::new("/usr/bin")), "{path}");
        assert!(entries.iter().any(|p| p == Path::new("/bin")), "{path}");
    }

    #[test]
    fn an_entry_holding_the_separator_is_dropped() {
        let sep = if cfg!(windows) { ";" } else { ":" };
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        push_entry(&mut out, &mut seen, &format!("/a{sep}/b"));
        assert!(out.is_empty(), "{out:?}");
    }

    #[test]
    fn expand_home_joins_each_component() {
        let expanded = expand_home("~/a/b");
        assert_eq!(PathBuf::from(&expanded), home_dir().join("a").join("b"));
        assert_eq!(expand_home("/opt/x"), "/opt/x");
    }

    #[test]
    fn claude_project_dir_flattens_every_non_alphanumeric() {
        let projects = home_dir().join(".claude").join("projects");
        assert_eq!(
            claude_project_dir("/Users/x/.claude/jobs"),
            projects.join("-Users-x--claude-jobs")
        );
        assert_eq!(claude_project_dir(r"C:\Users\x\my_app"), projects.join("C--Users-x-my-app"));
    }

    #[test]
    fn short_clamps_to_available_length() {
        assert_eq!(short("abc"), "abc");
        assert_eq!(short("0123456789"), "01234567");
    }
}
