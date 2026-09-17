//! Integrated-terminal PTY manager.
//!
//! One shell per panel id. Output is coalesced on a single 16 ms tick shared by
//! every terminal, so a `yes`-style firehose can't flood the IPC bridge with one
//! message per read.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Duration;

use crate::util;

struct TerminalEntry {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    buffer: Arc<Mutex<String>>,
}

static TERMINALS: Lazy<Mutex<HashMap<String, TerminalEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static FLUSHER: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

fn ensure_flusher() {
    {
        let mut started = FLUSHER.lock();
        if *started {
            return;
        }
        *started = true;
    }
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(16));
        loop {
            ticker.tick().await;
            flush_all();
        }
    });
}

fn flush_all() {
    let pending: Vec<(String, String)> = {
        let terminals = TERMINALS.lock();
        terminals
            .iter()
            .filter_map(|(id, entry)| {
                let mut buf = entry.buffer.lock();
                if buf.is_empty() {
                    None
                } else {
                    Some((id.clone(), std::mem::take(&mut *buf)))
                }
            })
            .collect()
    };
    for (id, data) in pending {
        util::emit("terminal:data", json!({ "id": id, "data": data }));
    }
}

pub fn spawn_terminal(id: &str, cwd: &str) -> Result<u32, String> {
    kill_terminal(id);
    ensure_flusher();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(&shell);
    let dir = if cwd.is_empty() {
        util::home_dir()
    } else {
        std::path::PathBuf::from(cwd)
    };
    cmd.cwd(dir);
    for (k, v) in util::clean_child_env() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn {shell}: {e}"))?;
    drop(pair.slave);

    let pid = child.process_id().unwrap_or(0);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader failed: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer failed: {e}"))?;

    let buffer = Arc::new(Mutex::new(String::new()));
    let child = Arc::new(Mutex::new(child));

    TERMINALS.lock().insert(
        id.to_string(),
        TerminalEntry {
            master: pair.master,
            writer,
            child: child.clone(),
            buffer: buffer.clone(),
        },
    );

    // portable-pty's reader is blocking, so it gets a real thread rather than a
    // task that would park a runtime worker forever.
    let read_id = id.to_string();
    std::thread::spawn(move || {
        let mut decoder = util::Utf8Decoder::default();
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = decoder.push(&chunk[..n]);
                    if !text.is_empty() {
                        buffer.lock().push_str(&text);
                    }
                }
            }
        }

        let exit_code = child
            .lock()
            .wait()
            .map(|s| s.exit_code() as i32)
            .unwrap_or(-1);

        flush_all(); // don't lose the tail
        TERMINALS.lock().remove(&read_id);
        util::emit(
            "terminal:exit",
            json!({ "id": read_id, "exitCode": exit_code }),
        );
    });

    Ok(pid)
}

pub fn write_terminal(id: &str, data: &str) {
    let mut terminals = TERMINALS.lock();
    if let Some(entry) = terminals.get_mut(id) {
        let _ = entry.writer.write_all(data.as_bytes());
        let _ = entry.writer.flush();
    }
}

pub fn resize_terminal(id: &str, cols: u16, rows: u16) {
    let terminals = TERMINALS.lock();
    if let Some(entry) = terminals.get(id) {
        let _ = entry.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

pub fn kill_terminal(id: &str) {
    let entry = TERMINALS.lock().remove(id);
    if let Some(entry) = entry {
        let _ = entry.child.lock().kill();
    }
}

pub fn kill_all_terminals() {
    let all: Vec<TerminalEntry> = TERMINALS.lock().drain().map(|(_, v)| v).collect();
    for entry in all {
        let _ = entry.child.lock().kill();
    }
}
