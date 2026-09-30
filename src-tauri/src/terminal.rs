//! Integrated-terminal PTY manager.
//!
//! One shell per panel id. Output is coalesced on a single 16 ms tick shared by
//! every terminal, so a `yes`-style firehose can't flood the IPC bridge with one
//! message per read.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, Child, MasterPty, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use crate::environment::Environment;
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

/// What a terminal's shell starts with: Nyra's clean environment, a terminal
/// type, and — for a host shell in any workspace but Default — that workspace's
/// `CLAUDE_CONFIG_DIR`, so `claude`, `claude mcp add` or `/login` typed in it
/// act on the same account as the project's chats. Default sets nothing, as
/// before workspaces. A WSL shell never gets one: it is the distro's login
/// shell with the distro's own `~/.claude`.
fn terminal_env(env: &Environment, config_dir: Option<&Path>) -> Vec<(String, String)> {
    let mut vars = util::claude_child_env(config_dir.filter(|_| env.is_host()));
    vars.push(("TERM".into(), "xterm-256color".into()));
    vars
}

pub fn spawn_terminal(id: &str, cwd: &str, config_dir: Option<&Path>) -> Result<u32, String> {
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

    // The project's own shell: the host's default one, or for a WSL project the
    // distro's login shell, started in the project directory inside it.
    let env = Environment::of(cwd);
    let mut cmd = env.shell_command(cwd);
    let shell = cmd
        .get_argv()
        .first()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    for (k, v) in terminal_env(&env, config_dir) {
        cmd.env(k, v);
    }

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

#[cfg(test)]
mod tests {
    use super::*;

    fn config_dir_of(vars: &[(String, String)]) -> Vec<&str> {
        vars.iter()
            .filter(|(k, _)| k.eq_ignore_ascii_case(util::CLAUDE_CONFIG_DIR))
            .map(|(_, v)| v.as_str())
            .collect()
    }

    #[test]
    fn a_workspace_terminal_is_pointed_at_its_config_dir() {
        let dir = Path::new("/h/.nyra/workspaces/w1/.claude");
        let vars = terminal_env(&Environment::Host, Some(dir));
        assert_eq!(config_dir_of(&vars), vec![dir.to_str().unwrap()]);
        assert!(vars.iter().any(|(k, v)| k == "TERM" && v == "xterm-256color"));
    }

    #[test]
    fn a_default_terminal_sets_nothing_new() {
        let inherited = std::env::var(util::CLAUDE_CONFIG_DIR).ok();
        let vars = terminal_env(&Environment::Host, None);
        assert_eq!(config_dir_of(&vars), inherited.iter().map(String::as_str).collect::<Vec<_>>());
    }

    #[test]
    fn a_wsl_terminal_keeps_the_distros_own_claude() {
        let wsl = Environment::of(r"\\wsl.localhost\Ubuntu\home\me\repo");
        if wsl.is_host() {
            // Not a UNC path on this OS's reading; nothing to check.
            return;
        }
        let inherited = std::env::var(util::CLAUDE_CONFIG_DIR).ok();
        let vars = terminal_env(&wsl, Some(Path::new("/h/.nyra/workspaces/w1/.claude")));
        assert_eq!(config_dir_of(&vars), inherited.iter().map(String::as_str).collect::<Vec<_>>());
    }
}
