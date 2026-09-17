//! Process-wide handles and small helpers shared by every backend module.
//!
//! The Electron build kept these as module-level singletons in the main process;
//! the equivalent here is a set of `Lazy` statics plus the `AppHandle` captured
//! during `setup`, which stands in for the old `mainWindow` reference.

use once_cell::sync::{Lazy, OnceCell};
use parking_lot::RwLock;
use rand::RngExt;
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::settings::NyraSettings;

static APP: OnceCell<AppHandle> = OnceCell::new();
static SETTINGS: Lazy<RwLock<NyraSettings>> = Lazy::new(|| RwLock::new(NyraSettings::default()));
static ENSURED_DIRS: Lazy<RwLock<HashSet<PathBuf>>> = Lazy::new(|| RwLock::new(HashSet::new()));

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

/// The environment Claude is spawned with. `CLAUDECODE`/`CLAUDE_CODE_SESSION_ID`
/// leak in when Nyra itself was launched from a Claude Code session and make the
/// child think it is a nested run.
pub fn clean_child_env() -> Vec<(String, String)> {
    std::env::vars()
        .filter(|(k, _)| k != "CLAUDECODE" && k != "CLAUDE_CODE_SESSION_ID")
        .collect()
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
    fn short_clamps_to_available_length() {
        assert_eq!(short("abc"), "abc");
        assert_eq!(short("0123456789"), "01234567");
    }
}
