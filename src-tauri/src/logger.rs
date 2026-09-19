//! Shared buffered debug logger.
//!
//! Mirrors the Electron build's `src/main/logger.ts`: every module funnels into
//! one 200 ms-batched append so a chatty stream-json session doesn't turn into a
//! write syscall per event. Console echo is gated behind NYRA_DEBUG / debug builds.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::fs::OpenOptions;
use std::io::Write;
use std::time::Duration;

/// Split by profile, because a dev instance and the installed app run side by
/// side whenever Nyra is used to develop Nyra — and `init` truncates. On one
/// shared path, starting dev blanked the installed app's log mid-session, and
/// from then on both appended to it with no way to tell the two apart.
#[cfg(debug_assertions)]
pub const LOG_PATH: &str = "/tmp/nyra-debug-dev.log";
#[cfg(not(debug_assertions))]
pub const LOG_PATH: &str = "/tmp/nyra-debug.log";

static BUFFER: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));
/// Read once: `log_line` is on the path of every stream-json event.
static PID: Lazy<u32> = Lazy::new(std::process::id);
static FLUSHER: Lazy<()> = Lazy::new(|| {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(200));
        flush();
    });
});

fn console_enabled() -> bool {
    std::env::var("NYRA_DEBUG").as_deref() == Ok("1") || cfg!(debug_assertions)
}

/// Owner-only. `claude.rs` writes every stream-json event verbatim, so this file
/// holds whole conversations — prompts, tool inputs, tool results — and /tmp is
/// world-readable. The mode only applies when we create the file, so `init`
/// also fixes one an older build left at 0644.
#[cfg(unix)]
fn private(opts: &mut OpenOptions) -> &mut OpenOptions {
    use std::os::unix::fs::OpenOptionsExt;
    opts.mode(0o600)
}

#[cfg(not(unix))]
fn private(opts: &mut OpenOptions) -> &mut OpenOptions {
    opts
}

fn flush() {
    let batch: Vec<String> = {
        let mut buf = BUFFER.lock();
        if buf.is_empty() {
            return;
        }
        std::mem::take(&mut *buf)
    };
    if let Ok(mut f) = private(OpenOptions::new().create(true).append(true)).open(LOG_PATH) {
        let _ = f.write_all(batch.join("\n").as_bytes());
        let _ = f.write_all(b"\n");
    }
}

/// Append a line to the debug log (buffered).
///
/// The pid is in the prefix because `tauri dev` restarts the binary on every
/// Rust change and each restart appends to the same file — without it, one log
/// reads as a single confusing session rather than several.
pub fn log_line(msg: impl AsRef<str>) {
    let msg = msg.as_ref();
    Lazy::force(&FLUSHER);
    if console_enabled() {
        println!("{msg}");
    }
    BUFFER.lock().push(format!(
        "[{}] [pid:{}] {msg}",
        chrono::Utc::now().to_rfc3339(),
        *PID
    ));
}

/// Truncate the log so each launch starts fresh.
pub fn init() {
    let _ = private(OpenOptions::new().create(true).write(true).truncate(true)).open(LOG_PATH);
    // `mode` above only bites on create; an existing 0644 file needs this.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(LOG_PATH, std::fs::Permissions::from_mode(0o600));
    }
    Lazy::force(&FLUSHER);
}

/// `log!("workflow", "started {}", id)` — tagged, formatted line.
#[macro_export]
macro_rules! log {
    ($tag:expr, $($arg:tt)*) => {
        $crate::logger::log_line(format!("[{}] {}", $tag, format!($($arg)*)))
    };
}

/// Untagged formatted line.
#[macro_export]
macro_rules! logf {
    ($($arg:tt)*) => {
        $crate::logger::log_line(format!($($arg)*))
    };
}
