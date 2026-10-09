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
    // The project's own shell: the host's default one, or for a WSL project the
    // distro's login shell, started in the project directory inside it.
    let env = Environment::of(cwd);
    let mut cmd = env.shell_command(cwd);
    for (k, v) in terminal_env(&env, config_dir) {
        cmd.env(k, v);
    }
    start(id, cmd)
}

/// The programs a pasted install command may start. Anything else is refused
/// here, whatever the renderer asked for: this runs what someone pasted, and
/// "a terminal for installing skills" must not quietly become "a shell".
const INSTALLERS: &[&str] = &["npx", "claude"];

/// One install command — `npx skills add …` or `claude plugin …` — in a PTY,
/// under `id`, in `cwd`.
///
/// No shell in between: the argv is handed over as it is, so nothing in it is
/// ever parsed as `;` or `$(…)`. It still gets a PTY because both CLIs ask
/// questions (which skills, which scope) and draw them as a terminal UI. Output,
/// input, resize and exit are the terminal panel's own, keyed on `id`.
pub fn spawn_program(
    id: &str,
    cwd: &str,
    program: &str,
    args: &[String],
    claude_binary_path: &str,
    config_dir: Option<&Path>,
) -> Result<u32, String> {
    if !INSTALLERS.contains(&program) {
        return Err(format!("{program} is not an install command"));
    }
    let env = Environment::of(cwd);
    let program = if env.is_host() {
        if program == "claude" {
            crate::claude::resolve_claude_binary(claude_binary_path)
        } else {
            crate::platform::which(program)
                .ok_or_else(|| format!("{program} was not found. Is Node.js installed?"))?
                .to_string_lossy()
                .into_owned()
        }
    } else {
        program.to_string()
    };
    let mut cmd = env.pty_program(&program, cwd);
    cmd.args(args);
    for (k, v) in terminal_env(&env, config_dir) {
        cmd.env(k, v);
    }
    // A person answers this terminal. `npx skills` reads `AI_AGENT` — which
    // Claude Code sets for everything under it, Nyra too when it was started
    // from a Claude shell — and then picks every skill in the repo without
    // asking. The builder starts from Nyra's own environment, so these are
    // removed, not merely left out.
    for key in agent_markers() {
        cmd.env_remove(key);
    }
    start(id, cmd)
}

/// What tells a CLI it is being run by an agent rather than a person.
fn agent_markers() -> Vec<String> {
    std::env::vars()
        .map(|(k, _)| k)
        .filter(|k| {
            k == "AI_AGENT" || k == "CLAUDECODE" || k == "CLAUDE_PID" || k.starts_with("CLAUDE_CODE_")
        })
        .collect()
}

fn start(id: &str, cmd: portable_pty::CommandBuilder) -> Result<u32, String> {
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

    let program = cmd
        .get_argv()
        .first()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("Failed to spawn {program}: {e}"))?;
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
    fn only_the_two_installers_may_be_started() {
        for program in ["sh", "bash", "rm", "node", "/usr/bin/npx"] {
            let refused = spawn_program("t", "", program, &[], "claude", None);
            assert!(refused.is_err(), "{program} should be refused");
        }
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
