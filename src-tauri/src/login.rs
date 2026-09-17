//! `claude /login` runner.
//!
//! This one *does* need a real PTY: the OAuth flow checks whether stdin is a TTY
//! and won't render its prompt otherwise. The renderer draws the output in an
//! xterm instance inside a modal and forwards keystrokes back.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::io::{Read, Write};
use std::sync::Arc;

use crate::claude::resolve_claude_binary;
use crate::util;

struct LoginSession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Arc<Mutex<Box<dyn Child + Send + Sync>>>,
    exited: Arc<Mutex<bool>>,
}

static ACTIVE: Lazy<Mutex<Option<LoginSession>>> = Lazy::new(|| Mutex::new(None));

pub fn start_login(claude_binary_path: &str) -> Result<u32, String> {
    // One login flow at a time.
    if ACTIVE
        .lock()
        .as_ref()
        .is_some_and(|s| !*s.exited.lock())
    {
        return Err("Login already in progress".into());
    }

    let bin = resolve_claude_binary(claude_binary_path);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("openpty failed: {e}"))?;

    let mut cmd = CommandBuilder::new(&bin);
    cmd.arg("/login");
    cmd.cwd(util::home_dir());
    for (k, v) in util::clean_child_env() {
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn claude: {e}"))?;
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

    let child = Arc::new(Mutex::new(child));
    let exited = Arc::new(Mutex::new(false));

    *ACTIVE.lock() = Some(LoginSession {
        master: pair.master,
        writer,
        child: child.clone(),
        exited: exited.clone(),
    });

    std::thread::spawn(move || {
        let mut decoder = util::Utf8Decoder::default();
        let mut transcript = String::new();
        let mut chunk = [0u8; 8192];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = decoder.push(&chunk[..n]);
                    if text.is_empty() {
                        continue;
                    }
                    transcript.push_str(&text);
                    util::emit("login:data", json!({ "data": text }));
                }
            }
        }

        let exit_code = child
            .lock()
            .wait()
            .map(|s| s.exit_code() as i32)
            .unwrap_or(-1);
        *exited.lock() = true;

        // The CLI has no machine-readable success signal here, so fall back to
        // the same transcript heuristic the Electron build used.
        let buf = transcript.to_lowercase();
        let success = exit_code == 0
            && (buf.contains("logged in")
                || buf.contains("login successful")
                || buf.contains("success"));

        util::emit(
            "login:exit",
            json!({ "exitCode": exit_code, "success": success }),
        );
        *ACTIVE.lock() = None;
    });

    Ok(pid)
}

pub fn write_login(data: &str) {
    let mut active = ACTIVE.lock();
    if let Some(sess) = active.as_mut() {
        if *sess.exited.lock() {
            return;
        }
        let _ = sess.writer.write_all(data.as_bytes());
        let _ = sess.writer.flush();
    }
}

pub fn resize_login(cols: u16, rows: u16) {
    let active = ACTIVE.lock();
    if let Some(sess) = active.as_ref() {
        if *sess.exited.lock() {
            return;
        }
        let _ = sess.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
}

pub fn cancel_login() {
    let sess = ACTIVE.lock().take();
    if let Some(sess) = sess {
        if !*sess.exited.lock() {
            let _ = sess.child.lock().kill();
        }
    }
}
