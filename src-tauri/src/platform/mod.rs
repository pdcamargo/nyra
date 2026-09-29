//! Everything that differs between operating systems, behind one surface.
//!
//! The rest of the backend does not write `#[cfg(unix)]` or `#[cfg(windows)]`
//! to stop a process, find a binary or pick a shell — it calls a function here.
//! Each OS gets one file implementing the same set of items, and the `pub use`
//! below is the contract: an OS file that is missing one fails to compile on
//! that OS, which is what `cargo xwin check --target x86_64-pc-windows-msvc`
//! catches from a Mac. A new OS is a new file, not a hunt through the tree.
//!
//! What belongs here is facts about the OS: how a process is stopped, where
//! tools get installed, what a shell is called. A *feature* that is wholly
//! different per OS — native spell checking, capturing the WKWebView — keeps
//! its own single `mod imp` switch in its own file, the way `spellcheck.rs`
//! does, rather than moving in here.

use std::collections::HashMap;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as imp;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as imp;

pub use imp::{
    canonical_dir, default_shell, executable_names, file_id, find_processes, force_kill,
    is_alive, listening_ports, log_dir, login_shell_path, on_shutdown_signal,
    private_open_options, process_table, restrict_to_owner, simplified, terminate,
    CLAUDE_INSTALLS, FALLBACK_BINS,
};

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/// A `std::process::Command` for `program`, ready for this OS.
///
/// Every child Nyra starts goes through here. On Windows that is what keeps a
/// console window from flashing up for every `git status`, and what turns an
/// npm `.cmd` shim into the `node` call it wraps — the shim goes through
/// `cmd.exe`, which cannot carry an argument with a newline in it, and the
/// system prompt Nyra passes Claude is several paragraphs long.
pub fn std_command(program: impl AsRef<OsStr>) -> std::process::Command {
    let (program, lead) = imp::launch(program.as_ref());
    let mut cmd = std::process::Command::new(program);
    cmd.args(lead);
    imp::detach_console(&mut cmd);
    cmd
}

/// [`std_command`], as a tokio command.
pub fn command(program: impl AsRef<OsStr>) -> tokio::process::Command {
    tokio::process::Command::from(std_command(program))
}

/// A PTY command for `program`: the terminal and `claude /login`. No console
/// flag here — a pseudo-console is exactly what a PTY child is meant to have.
pub fn pty_command(program: impl AsRef<OsStr>) -> portable_pty::CommandBuilder {
    let (program, lead) = imp::launch(program.as_ref());
    let mut cmd = portable_pty::CommandBuilder::new(program);
    cmd.args(lead);
    cmd
}

/// A command that runs `script` the way a flow's script node means it: in a
/// POSIX shell, where there is one.
pub fn script_command(script: &str) -> tokio::process::Command {
    tokio::process::Command::from(imp::script_command(script))
}

// ---------------------------------------------------------------------------
// Stopping
// ---------------------------------------------------------------------------

/// Ask `pid` to stop, and make sure of it once `grace` has passed.
///
/// The polite half is SIGTERM on Unix. Windows has nothing polite to send a
/// console process, so there the first step already ends it, along with its
/// children — which, unlike on Unix, do not go with it on their own.
pub fn terminate_then_kill(pid: u32, grace: Duration) -> std::io::Result<()> {
    terminate(pid)?;
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(grace).await;
        if is_alive(pid) {
            force_kill(pid);
        }
    });
    Ok(())
}

// ---------------------------------------------------------------------------
// The process table
// ---------------------------------------------------------------------------

/// One process, as `process_table` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcessRow {
    pub pid: i32,
    pub ppid: i32,
    /// Resident size in KB, or `None` where the OS would not say — on Windows,
    /// a protected process that cannot be opened. The row still counts for the
    /// tree: its children are still somebody's.
    pub resident_kb: Option<u64>,
}

/// `ps -axo pid=,ppid=,rss=` → rows.
///
/// Here rather than in `unix.rs` because it is plain text and its tests should
/// run everywhere. A line missing a column is dropped whole: half a row would
/// report the process and none of its memory.
#[cfg_attr(windows, allow(dead_code))]
pub fn parse_ps_rows(text: &str) -> Vec<ProcessRow> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse::<i32>().ok()?;
            let ppid = fields.next()?.parse::<i32>().ok()?;
            // macOS and Linux both report resident size in KB.
            let kb = fields.next()?.parse::<u64>().ok()?;
            Some(ProcessRow { pid, ppid, resident_kb: Some(kb) })
        })
        .collect()
}

/// A process whose command line contains what `find_processes` was asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FoundProcess {
    pub pid: i32,
    /// When it started, in Unix ms, where the OS would say.
    pub started_ms: Option<i64>,
}

/// `needle` as a `pgrep -f` pattern that matches it literally: `pgrep` takes
/// an extended regex, and a `(` or `[` in a command line would otherwise make
/// the pattern invalid, a `.` match anything.
#[cfg_attr(windows, allow(dead_code))]
pub fn pgrep_escape(needle: &str) -> String {
    let mut pattern = String::with_capacity(needle.len() * 2);
    for c in needle.chars() {
        if matches!(c, '\\' | '^' | '$' | '.' | '|' | '?' | '*' | '+' | '(' | ')' | '[' | ']' | '{' | '}') {
            pattern.push('\\');
        }
        pattern.push(c);
    }
    pattern
}

/// `ps -o lstart=` → Unix ms. Asked for in the C locale, so the shape is fixed:
/// "Thu May  1 19:14:32 2026".
#[cfg_attr(windows, allow(dead_code))]
pub fn parse_lstart_ms(s: &str) -> Option<i64> {
    use chrono::{Local, NaiveDateTime, TimeZone};
    // Collapse the space-padded day ("May  1" vs "May 11") so one format covers
    // both, and drop the leading weekday: chrono cross-checks it against the
    // date, which only adds a way to fail on input we don't need anyway.
    let fields: Vec<&str> = s.split_whitespace().collect();
    if fields.len() < 5 {
        return None;
    }
    let naive = NaiveDateTime::parse_from_str(&fields[1..].join(" "), "%b %d %H:%M:%S %Y").ok()?;
    Local
        .from_local_datetime(&naive)
        .single()
        .map(|dt| dt.timestamp_millis())
}

// ---------------------------------------------------------------------------
// Listening ports
// ---------------------------------------------------------------------------

/// `lsof -F pn` output → which ports each pid is listening on.
///
/// One field per line, `p` opening a new process block and `n` naming a
/// socket: `p1085`, `f14`, `n127.0.0.1:4201`. Parsed rather than column-split
/// because the human format pads and truncates the command name.
#[cfg_attr(windows, allow(dead_code))]
pub fn parse_lsof_ports(text: &str) -> HashMap<i32, Vec<u16>> {
    let mut by_pid: HashMap<i32, Vec<u16>> = HashMap::new();
    let mut current: Option<i32> = None;
    for line in text.lines() {
        let Some((tag, rest)) = line.split_at_checked(1) else {
            continue;
        };
        match tag {
            "p" => current = rest.trim().parse::<i32>().ok(),
            "n" => {
                let Some(pid) = current else { continue };
                // `127.0.0.1:4201`, `*:7000`, `[::1]:3000` — the port is what
                // follows the last colon in every form.
                let Some(port) = rest.rsplit(':').next().and_then(|p| p.trim().parse::<u16>().ok())
                else {
                    continue;
                };
                add_port(&mut by_pid, pid, port);
            }
            _ => {}
        }
    }
    by_pid
}

/// Record one listener, keeping each pid's ports deduped and lowest first. A
/// server bound on both IPv4 and IPv6 is two sockets and one port.
pub fn add_port(by_pid: &mut HashMap<i32, Vec<u16>>, pid: i32, port: u16) {
    let ports = by_pid.entry(pid).or_default();
    if let Err(at) = ports.binary_search(&port) {
        ports.insert(at, port);
    }
}

// ---------------------------------------------------------------------------
// Finding binaries
// ---------------------------------------------------------------------------

/// `which`, against the PATH Nyra resolved for its children rather than the one
/// it inherited.
pub fn which(name: &str) -> Option<PathBuf> {
    which_in(name, OsStr::new(&crate::util::child_path()))
}

/// `which` over an explicit PATH value. Honours PATHEXT on Windows, so `node`
/// finds `node.exe` and `claude` finds `claude.cmd`.
pub fn which_in(name: &str, path: &OsStr) -> Option<PathBuf> {
    let names = executable_names(name);
    std::env::split_paths(path).find_map(|dir| {
        names
            .iter()
            .map(|n| dir.join(n))
            .find(|candidate| candidate.is_file())
    })
}

/// The script an npm `.cmd` shim runs, relative to the shim's directory.
///
/// Both generations of cmd-shim end in the same shape — the script quoted
/// against the shim's own directory, then `%*` — and that is the only quoted
/// path followed by `%*`, so the `node.exe` probe above it never matches:
///
/// ```text
/// "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
/// "%~dp0\node.exe"  "%~dp0\node_modules\npm\bin\npm-cli.js" %*
/// ```
///
/// Portable on purpose: it is plain text, and testable from any OS.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_npm_shim(text: &str) -> Option<String> {
    static SCRIPT: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
        regex::Regex::new(r#""%(?:dp0%|~dp0)\\([^"]+)"\s+%\*"#).unwrap()
    });
    let captures = SCRIPT.captures(text)?;
    let script = captures.get(1)?.as_str().trim();
    (!script.is_empty()).then(|| script.to_string())
}

/// `node <script>` for an npm shim at `shim`, when the script it names exists.
/// `node` is the one beside the shim if there is one, the way the shim picks it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn unwrap_npm_shim(shim: &Path) -> Option<(OsString, OsString)> {
    let text = std::fs::read_to_string(shim).ok()?;
    let relative = parse_npm_shim(&text)?;
    let dir = shim.parent()?;
    let script = relative
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .fold(dir.to_path_buf(), |acc, part| acc.join(part));
    if !script.is_file() {
        return None;
    }
    let local = dir.join(executable_names("node").into_iter().next()?);
    let node = if local.is_file() { local } else { which("node")? };
    Some((node.into_os_string(), script.into_os_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // The real table, not a fixture: Chat RAM read `--` on Windows for as long
    // as this went through a `ps` that is not there.
    #[test]
    fn the_process_table_finds_this_process_and_its_memory() {
        let rows = process_table().expect("a process table");
        let me = std::process::id() as i32;
        let row = rows.iter().find(|r| r.pid == me).expect("this process in it");
        assert!(row.resident_kb.unwrap_or(0) > 0);
        assert!(rows.iter().any(|r| r.pid == row.ppid), "its parent in it too");
    }

    #[test]
    fn escapes_regex_metacharacters_for_pgrep() {
        assert_eq!(
            pgrep_escape("npm run dev -- --host 0.0.0.0 (x) [y]+"),
            r"npm run dev -- --host 0\.0\.0\.0 \(x\) \[y\]\+"
        );
    }

    #[test]
    fn parses_ps_lstart() {
        // Space-padded single-digit day — the format `ps` actually emits.
        assert!(parse_lstart_ms("Fri May  1 19:14:32 2026").is_some());
        assert!(parse_lstart_ms("Mon May 11 19:14:32 2026").is_some());
        // Weekday mismatch is tolerated; we only care about the date/time.
        assert!(parse_lstart_ms("Thu May  1 19:14:32 2026").is_some());
        assert!(parse_lstart_ms("garbage").is_none());
        assert!(parse_lstart_ms("").is_none());
    }

    #[test]
    fn parses_lsof_field_output() {
        // Real shapes: loopback, wildcard, and IPv6 in brackets.
        let out = "p1085\nf14\nn127.0.0.1:4201\np675\nf9\nn*:7000\nf11\nn[::1]:5000\n";
        let by_pid = parse_lsof_ports(out);
        assert_eq!(by_pid.get(&1085), Some(&vec![4201]));
        assert_eq!(by_pid.get(&675), Some(&vec![5000, 7000]));
    }

    #[test]
    fn dedupes_the_two_rows_one_server_produces() {
        // A server bound on both IPv4 and IPv6 lists the same port twice.
        let out = "p900\nf4\nn*:50065\nf5\nn*:50065\n";
        assert_eq!(parse_lsof_ports(out).get(&900), Some(&vec![50065]));
    }

    #[test]
    fn ignores_lsof_lines_it_cannot_read() {
        let out = "\np-\nnnot-a-socket\np42\nn127.0.0.1:99999\nn127.0.0.1:8080\n";
        let by_pid = parse_lsof_ports(out);
        // 99999 does not fit a u16 and is dropped; the good row still lands.
        assert_eq!(by_pid.get(&42), Some(&vec![8080]));
    }

    // The real tables, not fixtures. On Windows these went through `lsof` and
    // `pgrep`, which are not there, so the port pill never appeared.
    #[test]
    fn finds_a_port_this_process_is_listening_on() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let Some(by_pid) = listening_ports() else {
            // A machine without `lsof` says so rather than failing the build.
            eprintln!("no listening-ports table on this machine");
            return;
        };
        let me = std::process::id() as i32;
        assert!(by_pid.get(&me).is_some_and(|ports| ports.contains(&port)), "{port} under {me}");
    }

    #[test]
    fn finds_a_child_by_its_command_line() {
        // A marker nothing else on the machine has, and a child that lives long
        // enough to be looked at.
        let marker = format!("nyra-find-{}", crate::util::rand_suffix(8));
        #[cfg(windows)]
        let mut child = std_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &format!("Start-Sleep 5 # {marker}")])
            .spawn()
            .unwrap();
        #[cfg(not(windows))]
        let mut child = std_command("sh")
            .args(["-c", &format!("sleep 5; : {marker}")])
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let found = find_processes(&marker);
        let _ = child.kill();
        let row = found.iter().find(|p| p.pid == child.id() as i32);
        let row = row.unwrap_or_else(|| panic!("child {} not in {found:?}", child.id()));
        let started = row.started_ms.expect("a start time");
        let age = crate::util::now_ms() - started;
        assert!((0..60_000).contains(&age), "started {age} ms ago");
    }

    #[test]
    fn parses_ps_rows_and_drops_a_short_line() {
        let rows = parse_ps_rows("    1     0  1234\n    7     1\n   42     1  2048\n");
        assert_eq!(
            rows,
            vec![
                ProcessRow { pid: 1, ppid: 0, resident_kb: Some(1234) },
                ProcessRow { pid: 42, ppid: 1, resident_kb: Some(2048) },
            ]
        );
    }

    #[test]
    fn reads_the_script_out_of_a_current_npm_shim() {
        let shim = r#"@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@anthropic-ai\claude-code\cli.js" %*
"#;
        assert_eq!(
            parse_npm_shim(shim).as_deref(),
            Some(r"node_modules\@anthropic-ai\claude-code\cli.js")
        );
    }

    #[test]
    fn reads_the_script_out_of_an_older_npm_shim() {
        let shim = "@IF EXIST \"%~dp0\\node.exe\" (\r\n  \"%~dp0\\node.exe\"  \"%~dp0\\node_modules\\npm\\bin\\npm-cli.js\" %*\r\n) ELSE (\r\n  node  \"%~dp0\\node_modules\\npm\\bin\\npm-cli.js\" %*\r\n)";
        assert_eq!(
            parse_npm_shim(shim).as_deref(),
            Some(r"node_modules\npm\bin\npm-cli.js")
        );
    }

    #[test]
    fn a_batch_file_that_is_not_a_shim_is_left_alone() {
        assert_eq!(parse_npm_shim("@echo off\r\necho hello %*\r\n"), None);
    }

    #[test]
    fn which_in_finds_a_file_and_skips_a_directory() {
        let base = std::env::temp_dir().join(format!("nyra-which-{}", crate::util::rand_suffix(8)));
        let bin = base.join("bin");
        std::fs::create_dir_all(bin.join(executable_names("tool").remove(0))).unwrap();
        let other = base.join("other");
        std::fs::create_dir_all(&other).unwrap();
        let file = other.join(executable_names("tool").remove(0));
        std::fs::write(&file, b"").unwrap();

        let path = std::env::join_paths([&bin, &other]).unwrap();
        assert_eq!(which_in("tool", &path), Some(file));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn simplified_drops_the_verbatim_prefix_node_cannot_read() {
        assert_eq!(simplified(Path::new(r"\\?\C:\a\b")), PathBuf::from(r"C:\a\b"));
    }

    #[test]
    fn our_own_process_is_alive() {
        assert!(is_alive(std::process::id()));
    }
}
