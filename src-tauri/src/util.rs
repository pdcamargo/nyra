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
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::settings::NyraSettings;

static APP: OnceCell<AppHandle> = OnceCell::new();
static SETTINGS: Lazy<RwLock<NyraSettings>> = Lazy::new(|| RwLock::new(NyraSettings::default()));
static ENSURED_DIRS: Lazy<RwLock<HashSet<PathBuf>>> = Lazy::new(|| RwLock::new(HashSet::new()));
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

pub fn temp_dir() -> PathBuf {
    std::env::temp_dir()
}

/// `mkdir -p`, memoised so a hot path doesn't syscall on every call.
pub fn ensure_dir(dir: &Path) -> std::io::Result<()> {
    if ENSURED_DIRS.read().contains(dir) {
        return Ok(());
    }
    std::fs::create_dir_all(dir)?;
    ENSURED_DIRS.write().insert(dir.to_path_buf());
    Ok(())
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
// environment itself, which is what stdio MCP servers need.

/// Long enough for an interactive rc file that does real work, short enough
/// that a wedged shell doesn't hold the first spawn hostage.
const SHELL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);

const PATH_START: &str = "__NYRA_PATH_START__";
const PATH_END: &str = "__NYRA_PATH_END__";

/// Where developer tooling actually lives, for when the shell probe fails.
/// Missing directories are harmless — they just never match anything.
const FALLBACK_BINS: &[&str] = &[
    "~/.local/bin",
    "~/.local/share/fnm/aliases/default/bin",
    "~/.fnm/aliases/default/bin",
    "~/.volta/bin",
    "~/.bun/bin",
    "~/.cargo/bin",
    "~/.npm-global/bin",
    "~/Library/pnpm",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/local/sbin",
];

fn expand_home(entry: &str) -> String {
    match entry.strip_prefix("~/") {
        Some(rest) => home_dir().join(rest).to_string_lossy().to_string(),
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
fn push_entry(out: &mut Vec<String>, seen: &mut HashSet<String>, entry: &str) {
    let entry = entry.trim();
    if entry.is_empty() {
        return;
    }
    let expanded = expand_home(entry);
    if let Ok(real) = std::fs::canonicalize(&expanded) {
        let real = real.to_string_lossy().to_string();
        if seen.insert(real.clone()) {
            out.push(real);
        }
    }
    if seen.insert(expanded.clone()) {
        out.push(expanded);
    }
}

/// Ask the user's login shell what its PATH is.
///
/// Sentinel-delimited because an interactive shell prints whatever its rc files
/// feel like printing, and killed on timeout because the reader thread is
/// blocked on a pipe that will never close otherwise.
fn probe_login_shell_path() -> Option<String> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let script = format!("printf '%s%s%s' '{PATH_START}' \"$PATH\" '{PATH_END}'");

    let child = std::process::Command::new(&shell)
        .args(["-ilc", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let pid = child.id() as i32;

    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output().ok());
    });

    let output = match rx.recv_timeout(SHELL_PROBE_TIMEOUT) {
        Ok(Some(output)) => output,
        _ => {
            crate::log!("path", "login shell probe timed out or failed ({shell})");
            #[cfg(unix)]
            unsafe {
                libc::kill(pid, libc::SIGKILL)
            };
            return None;
        }
    };

    let text = String::from_utf8_lossy(&output.stdout);
    let start = text.find(PATH_START)? + PATH_START.len();
    let rest = &text[start..];
    let end = rest.find(PATH_END)?;
    let path = rest[..end].trim().to_string();
    (!path.is_empty()).then_some(path)
}

fn build_child_path() -> String {
    let mut out: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // The login shell first: it is the user's own answer to this question.
    if let Some(shell_path) = probe_login_shell_path() {
        for entry in shell_path.split(':') {
            push_entry(&mut out, &mut seen, entry);
        }
    }
    // Then what we inherited, so system tools never disappear.
    if let Ok(inherited) = std::env::var("PATH") {
        for entry in inherited.split(':') {
            push_entry(&mut out, &mut seen, entry);
        }
    }
    // Then the usual suspects, in case the probe told us nothing.
    for entry in FALLBACK_BINS {
        push_entry(&mut out, &mut seen, entry);
    }

    out.join(":")
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
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(k, _)| k != "CLAUDECODE" && k != "CLAUDE_CODE_SESSION_ID" && k != "PATH")
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

    #[test]
    fn child_path_carries_the_system_directories() {
        let path = build_child_path();
        assert!(path.split(':').any(|p| p == "/usr/bin"), "{path}");
        assert!(path.split(':').any(|p| p == "/bin"), "{path}");
    }

    #[test]
    fn debug_dump_child_path() {
        let path = build_child_path();
        for entry in path.split(':') {
            let has_node = std::path::Path::new(entry).join("node").exists();
            let has_npx = std::path::Path::new(entry).join("npx").exists();
            let has_bun = std::path::Path::new(entry).join("bun").exists();
            if has_node || has_npx || has_bun {
                eprintln!("TOOLS {entry}  node={has_node} npx={has_npx} bun={has_bun}");
            }
        }
        assert!(path.split(':').any(|e| std::path::Path::new(e).join("node").exists()), "no node on the resolved PATH");
        assert!(!path.contains("fnm_multishells"), "a per-shell fnm path survived canonicalisation");
    }

    #[test]
    fn short_clamps_to_available_length() {
        assert_eq!(short("abc"), "abc");
        assert_eq!(short("0123456789"), "01234567");
    }
}
