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

pub const LOG_PATH: &str = "/tmp/nyra-debug.log";

static BUFFER: Lazy<Mutex<Vec<String>>> = Lazy::new(|| Mutex::new(Vec::new()));
static FLUSHER: Lazy<()> = Lazy::new(|| {
    std::thread::spawn(|| loop {
        std::thread::sleep(Duration::from_millis(200));
        flush();
    });
});

fn console_enabled() -> bool {
    std::env::var("NYRA_DEBUG").as_deref() == Ok("1") || cfg!(debug_assertions)
}

fn flush() {
    let batch: Vec<String> = {
        let mut buf = BUFFER.lock();
        if buf.is_empty() {
            return;
        }
        std::mem::take(&mut *buf)
    };
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(LOG_PATH) {
        let _ = f.write_all(batch.join("\n").as_bytes());
        let _ = f.write_all(b"\n");
    }
}

/// Append a line to the debug log (buffered).
pub fn log_line(msg: impl AsRef<str>) {
    let msg = msg.as_ref();
    Lazy::force(&FLUSHER);
    if console_enabled() {
        println!("{msg}");
    }
    BUFFER
        .lock()
        .push(format!("[{}] {msg}", chrono::Utc::now().to_rfc3339()));
}

/// Truncate the log so each launch starts fresh.
pub fn init() {
    let _ = std::fs::write(LOG_PATH, b"");
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
