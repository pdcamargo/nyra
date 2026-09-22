//! Background-process registry.
//!
//! Claude runs `Bash(run_in_background: true)` children that outlive the turn
//! that started them. Claude reports them only as opaque `tool_use_id`s, so we
//! recover the real OS pid by matching the command line with `pgrep` and keep a
//! 2 s liveness poll going as a fallback for missing `task_updated` events.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::time::Duration;

use crate::util;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcStatus {
    Running,
    Exited,
    Killed,
    Orphaned,
    Untracked,
    Stopped,
}

/// What kind of background thing this is.
///
/// Both arrive as `task_type: "local_bash"` and both are long-running children
/// of the turn that started them, so the registry holds them together — but they
/// are not the same promise. A shell is doing work; a monitor is watching for
/// something and will interrupt you when it happens.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProcKind {
    Shell,
    Monitor,
}

impl Default for ProcKind {
    fn default() -> Self {
        Self::Shell
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgProcess {
    /// Claude's `tool_use_id` for the originating Bash call.
    pub shell_id: String,
    #[serde(default)]
    pub kind: ProcKind,
    /// Claude's task-registry id (e.g. "b407td0kk"); this is what users see.
    pub task_id: Option<String>,
    pub description: Option<String>,
    pub command: String,
    /// Path Claude streams background output to; we tail it.
    pub output_file: Option<String>,
    pub started_at: i64,
    pub ended_at: Option<i64>,
    pub pid: Option<i32>,
    pub status: ProcStatus,
    pub exit_code: Option<i32>,
    pub last_output: Option<String>,
    pub last_output_at: Option<i64>,
    /// TCP ports anything under this shell is listening on. Not persisted and
    /// not inferred from the log — see the port scanner below for why.
    #[serde(default)]
    pub ports: Vec<u16>,
    /// Byte size at the last tail read; lets the poller skip unchanged files.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_output_size: Option<u64>,
}

#[derive(Default)]
struct SessionState {
    by_shell_id: HashMap<String, BgProcess>,
    /// BashOutput tool_id → shellId, so its tool_result can be attributed.
    output_calls: HashMap<String, String>,
    claude_pid: Option<u32>,
}

static SESSIONS: Lazy<Mutex<HashMap<String, SessionState>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static POLLER: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

// ---- registration ----

pub fn attach_claude_pid(nyra_session_id: &str, pid: Option<u32>) {
    {
        let mut sessions = SESSIONS.lock();
        sessions
            .entry(nyra_session_id.to_string())
            .or_default()
            .claude_pid = pid;
    }
    ensure_poll_timer();
}

/// Claude finished its turn. The bash children keep running independently, so we
/// hold onto their pids and let the liveness poll notice when they die.
pub fn clear_session(nyra_session_id: &str) {
    let mut sessions = SESSIONS.lock();
    if let Some(s) = sessions.get_mut(nyra_session_id) {
        s.output_calls.clear();
    }
}

pub fn drop_session(nyra_session_id: &str) {
    SESSIONS.lock().remove(nyra_session_id);
    util::emit(
        "processes:update",
        serde_json::json!({ "nyraSessionId": nyra_session_id, "processes": [] }),
    );
}

pub fn list_processes(nyra_session_id: &str) -> Vec<BgProcess> {
    let sessions = SESSIONS.lock();
    let Some(s) = sessions.get(nyra_session_id) else {
        return Vec::new();
    };
    let mut out: Vec<BgProcess> = s.by_shell_id.values().cloned().collect();
    out.sort_by_key(|p| p.started_at);
    out
}

// ---- events coming out of the Claude stream ----

/// Called for every `tool_input`. Tracks backgrounded Bash calls and the
/// BashOutput/KillShell management calls that refer to them.
pub fn note_tool_input(
    nyra_session_id: &str,
    tool_id: &str,
    tool_name: &str,
    input: &Value,
) {
    let exists = {
        let sessions = SESSIONS.lock();
        sessions.contains_key(nyra_session_id)
    };
    if !exists {
        return;
    }

    match tool_name {
        "Bash" if input.get("run_in_background") == Some(&Value::Bool(true)) => {
            let command = input
                .get("command")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let proc = BgProcess {
                shell_id: tool_id.to_string(),
                kind: ProcKind::Shell,
                task_id: None,
                description: None,
                command: command.clone(),
                output_file: None,
                started_at: util::now_ms(),
                ended_at: None,
                pid: None,
                status: ProcStatus::Running,
                exit_code: None,
                last_output: None,
                last_output_at: None,
                last_output_size: None,
                ports: Vec::new(),
            };
            {
                let mut sessions = SESSIONS.lock();
                if let Some(s) = sessions.get_mut(nyra_session_id) {
                    s.by_shell_id.insert(tool_id.to_string(), proc);
                }
            }
            broadcast(nyra_session_id);

            // Claude forked the child just before this event; find it out of band.
            let sid = nyra_session_id.to_string();
            let tid = tool_id.to_string();
            tauri::async_runtime::spawn(async move {
                resolve_pid(&sid, &tid, &command).await;
                broadcast(&sid);
            });
        }
        // A Monitor is a background watch: it streams events from a long-running
        // command and interrupts the conversation on each one. It reaches the
        // registry the same way a backgrounded shell does — `task_started`,
        // `task_updated` and `task_notification` all key on `tool_use_id`, which
        // it has — but nothing here used to *create* the entry, so every one of
        // those arrived, found no row, and was dropped. Monitors were invisible.
        "Monitor" => {
            // A `ws` monitor has no command; the URL is the thing being watched.
            let command = input
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_string)
                .or_else(|| {
                    input
                        .get("ws")
                        .and_then(|w| w.get("url"))
                        .and_then(Value::as_str)
                        .map(str::to_string)
                })
                .unwrap_or_default();
            let description = input
                .get("description")
                .and_then(Value::as_str)
                .filter(|d| !d.is_empty())
                .map(str::to_string);
            let proc = BgProcess {
                shell_id: tool_id.to_string(),
                kind: ProcKind::Monitor,
                task_id: None,
                description,
                command: command.clone(),
                output_file: None,
                started_at: util::now_ms(),
                ended_at: None,
                pid: None,
                status: ProcStatus::Running,
                exit_code: None,
                last_output: None,
                last_output_at: None,
                last_output_size: None,
                ports: Vec::new(),
            };
            {
                let mut sessions = SESSIONS.lock();
                if let Some(s) = sessions.get_mut(nyra_session_id) {
                    s.by_shell_id.insert(tool_id.to_string(), proc);
                }
            }
            broadcast(nyra_session_id);

            // No pid hunt for a `ws` monitor — there is no child to find.
            if !command.is_empty() && input.get("ws").is_none() {
                let sid = nyra_session_id.to_string();
                let tid = tool_id.to_string();
                tauri::async_runtime::spawn(async move {
                    resolve_pid(&sid, &tid, &command).await;
                    broadcast(&sid);
                });
            }
        }
        "BashOutput" => {
            let shell_id = input
                .get("bash_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !shell_id.is_empty() {
                let mut sessions = SESSIONS.lock();
                if let Some(s) = sessions.get_mut(nyra_session_id) {
                    s.output_calls
                        .insert(tool_id.to_string(), shell_id.to_string());
                }
            }
        }
        "KillShell" => {
            let shell_id = input
                .get("shell_id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let changed = {
                let mut sessions = SESSIONS.lock();
                match sessions
                    .get_mut(nyra_session_id)
                    .and_then(|s| s.by_shell_id.get_mut(&shell_id))
                {
                    Some(p) if p.status == ProcStatus::Running => {
                        p.status = ProcStatus::Killed;
                        p.ended_at = Some(util::now_ms());
                        true
                    }
                    _ => false,
                }
            };
            if changed {
                broadcast(nyra_session_id);
            }
        }
        _ => {}
    }
}

/// Called for every `tool_result`. If it answers a BashOutput call we tracked,
/// attach the snippet to the originating shell.
pub fn note_tool_result(nyra_session_id: &str, tool_id: &str, content: &str) {
    let changed = {
        let mut sessions = SESSIONS.lock();
        let Some(s) = sessions.get_mut(nyra_session_id) else {
            return;
        };
        let Some(shell_id) = s.output_calls.remove(tool_id) else {
            return;
        };
        match s.by_shell_id.get_mut(&shell_id) {
            Some(p) => {
                p.last_output = Some(truncate_output(content));
                p.last_output_at = Some(util::now_ms());
                true
            }
            None => false,
        }
    };
    if changed {
        broadcast(nyra_session_id);
    }
}

/// `system/task_started` — enrich the tracked shell with Claude's own task id.
pub fn note_task_started(
    nyra_session_id: &str,
    tool_use_id: &str,
    task_id: &str,
    description: Option<&str>,
) {
    let changed = {
        let mut sessions = SESSIONS.lock();
        match sessions
            .get_mut(nyra_session_id)
            .and_then(|s| s.by_shell_id.get_mut(tool_use_id))
        {
            Some(p) => {
                p.task_id = Some(task_id.to_string());
                if let Some(d) = description.filter(|d| !d.is_empty()) {
                    p.description = Some(d.to_string());
                }
                true
            }
            None => false,
        }
    };
    if changed {
        broadcast(nyra_session_id);
    }
}

/// `system/task_updated` — Claude's own status wins over our polling.
pub fn note_task_updated(nyra_session_id: &str, tool_use_id: &str, patch: &Value) {
    let changed = {
        let mut sessions = SESSIONS.lock();
        match sessions
            .get_mut(nyra_session_id)
            .and_then(|s| s.by_shell_id.get_mut(tool_use_id))
        {
            Some(p) => {
                if let Some(status) = patch.get("status").and_then(Value::as_str) {
                    p.status = map_claude_status(status);
                }
                if let Some(end) = patch.get("end_time").and_then(Value::as_i64) {
                    p.ended_at = Some(end);
                }
                true
            }
            None => false,
        }
    };
    if changed {
        broadcast(nyra_session_id);
    }
}

/// `system/task_notification` — carries the file Claude streams task stdout to.
pub fn note_task_notification(
    nyra_session_id: &str,
    tool_use_id: &str,
    status: Option<&str>,
    output_file: Option<&str>,
) {
    let mut new_output_file: Option<String> = None;
    let mut changed = false;

    {
        let mut sessions = SESSIONS.lock();
        let Some(p) = sessions
            .get_mut(nyra_session_id)
            .and_then(|s| s.by_shell_id.get_mut(tool_use_id))
        else {
            return;
        };

        if let Some(f) = output_file.filter(|f| !f.is_empty()) {
            if p.output_file.as_deref() != Some(f) {
                p.output_file = Some(f.to_string());
                new_output_file = Some(f.to_string());
            }
        }

        if let Some(s) = status.filter(|s| !s.is_empty()) {
            let mapped = map_claude_status(s);
            // `task_notification(status=stopped)` lands after `task_updated(status=killed)`;
            // without this guard it would downgrade the more specific signal.
            if mapped != ProcStatus::Running && p.status == ProcStatus::Running {
                p.status = mapped;
            }
            if p.ended_at.is_none() && mapped != ProcStatus::Running {
                p.ended_at = Some(util::now_ms());
            }
            changed = true;
        }
    }

    if let Some(path) = new_output_file {
        let sid = nyra_session_id.to_string();
        let tid = tool_use_id.to_string();
        tauri::async_runtime::spawn(async move {
            if let Some((size, text)) = read_output_tail(&path, None) {
                {
                    let mut sessions = SESSIONS.lock();
                    if let Some(p) = sessions
                        .get_mut(&sid)
                        .and_then(|s| s.by_shell_id.get_mut(&tid))
                    {
                        p.last_output = Some(text);
                        p.last_output_size = Some(size);
                        p.last_output_at = Some(util::now_ms());
                    }
                }
                broadcast(&sid);
            }
        });
    }
    if changed {
        broadcast(nyra_session_id);
    }
}

/// Claude emits `running | killed | stopped` (and likely `completed`/`failed`).
/// Anything unrecognised collapses to `exited`.
pub fn map_claude_status(s: &str) -> ProcStatus {
    match s {
        "running" => ProcStatus::Running,
        "killed" => ProcStatus::Killed,
        "stopped" => ProcStatus::Stopped,
        "completed" | "failed" => ProcStatus::Exited,
        _ => ProcStatus::Exited,
    }
}

// ---- killing ----

pub fn kill_by_pid(pid: i32) -> Result<(), String> {
    if pid < 1 {
        return Err("invalid pid".into());
    }
    #[cfg(unix)]
    {
        if unsafe { libc::kill(pid, libc::SIGTERM) } != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // Escalate if it's still around in 3 s.
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(3)).await;
            if is_alive(pid) {
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        });
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err("unsupported platform".into())
    }
}

pub fn kill_shell(nyra_session_id: &str, shell_id: &str) -> Result<(), String> {
    let pid = {
        let sessions = SESSIONS.lock();
        let s = sessions
            .get(nyra_session_id)
            .ok_or_else(|| "unknown session".to_string())?;
        let p = s
            .by_shell_id
            .get(shell_id)
            .ok_or_else(|| "unknown shell".to_string())?;
        p.pid.ok_or_else(|| "pid not resolved".to_string())?
    };
    kill_by_pid(pid)?;
    {
        let mut sessions = SESSIONS.lock();
        if let Some(p) = sessions
            .get_mut(nyra_session_id)
            .and_then(|s| s.by_shell_id.get_mut(shell_id))
        {
            p.status = ProcStatus::Killed;
            p.ended_at = Some(util::now_ms());
        }
    }
    broadcast(nyra_session_id);
    Ok(())
}

// ---- internals ----

fn broadcast(nyra_session_id: &str) {
    util::emit(
        "processes:update",
        serde_json::json!({
            "nyraSessionId": nyra_session_id,
            "processes": list_processes(nyra_session_id),
        }),
    );
}

fn ensure_poll_timer() {
    {
        let mut started = POLLER.lock();
        if *started {
            return;
        }
        *started = true;
    }
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(2));
        let mut tick: u64 = 0;
        loop {
            ticker.tick().await;
            poll_once().await;
            // Every other tick. A port appears once, when the server finishes
            // booting, so 4 s is well inside "it showed up immediately" — and
            // this is two process-table scans, unlike the rest of the poll.
            tick = tick.wrapping_add(1);
            if tick % 2 == 0 {
                scan_ports().await;
            }
        }
    });
}

/// What the poller needs about one tracked shell, captured under the lock.
type PollRow = (String, Option<i32>, ProcStatus, Option<String>, Option<u64>);

async fn poll_once() {
    // Snapshot first so the lock isn't held across the file/pid syscalls below.
    let snapshot: Vec<(String, Vec<PollRow>)> = {
        let sessions = SESSIONS.lock();
        sessions
            .iter()
            .map(|(sid, st)| {
                (
                    sid.clone(),
                    st.by_shell_id
                        .values()
                        .map(|p| {
                            (
                                p.shell_id.clone(),
                                p.pid,
                                p.status,
                                p.output_file.clone(),
                                p.last_output_size,
                            )
                        })
                        .collect(),
                )
            })
            .collect()
    };

    for (session_id, procs) in snapshot {
        let mut changed = false;
        for (shell_id, pid, status, output_file, last_size) in procs {
            let active = matches!(status, ProcStatus::Running | ProcStatus::Orphaned);

            // Liveness by pid — the fallback when Claude never sends task_updated.
            if active {
                if let Some(pid) = pid {
                    if !is_alive(pid) {
                        let mut sessions = SESSIONS.lock();
                        if let Some(p) = sessions
                            .get_mut(&session_id)
                            .and_then(|s| s.by_shell_id.get_mut(&shell_id))
                        {
                            p.status = ProcStatus::Exited;
                            p.ended_at = Some(util::now_ms());
                            p.exit_code = None;
                            changed = true;
                        }
                    }
                }
            }

            // Tail Claude's output file while the job runs so the UI shows progress.
            if active {
                if let Some(path) = output_file {
                    if let Some((size, text)) = read_output_tail(&path, last_size) {
                        let mut emit_now = false;
                        {
                            let mut sessions = SESSIONS.lock();
                            if let Some(p) = sessions
                                .get_mut(&session_id)
                                .and_then(|s| s.by_shell_id.get_mut(&shell_id))
                            {
                                p.last_output_size = Some(size);
                                if p.last_output.as_deref() != Some(text.as_str()) {
                                    p.last_output = Some(text);
                                    p.last_output_at = Some(util::now_ms());
                                    emit_now = true;
                                }
                            }
                        }
                        if emit_now {
                            broadcast(&session_id);
                        }
                    }
                }
            }
        }
        if changed {
            broadcast(&session_id);
        }
    }
}

pub fn is_alive(pid: i32) -> bool {
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// Read only the last 4 KB of an append-only log via a positional read, so a
/// large file never lands in memory. `None` when unreadable or unchanged.
pub fn read_output_tail(path: &str, prev_size: Option<u64>) -> Option<(u64, String)> {
    const MAX: u64 = 4096;
    let meta = std::fs::metadata(path).ok()?;
    let size = meta.len();
    if prev_size == Some(size) {
        return None; // unchanged — skip the read
    }
    if size == 0 {
        return Some((0, String::new()));
    }
    let start = size.saturating_sub(MAX);
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((size - start) as usize);
    file.take(size - start).read_to_end(&mut buf).ok()?;
    Some((size, truncate_output(&String::from_utf8_lossy(&buf))))
}

async fn resolve_pid(nyra_session_id: &str, shell_id: &str, command: &str) {
    // Claude usually forks within a few hundred ms, but timing varies. Matching on
    // the command line (not the parent) still finds children that detached via
    // setsid/nohup.
    const DELAYS: [u64; 5] = [0, 200, 500, 1000, 2500];
    let snippet = command.chars().take(60).collect::<String>().trim().to_string();
    if snippet.is_empty() {
        mark_untracked(nyra_session_id, shell_id);
        return;
    }

    let started_at = util::now_ms();
    for d in DELAYS {
        if d > 0 {
            tokio::time::sleep(Duration::from_millis(d)).await;
        }
        {
            let sessions = SESSIONS.lock();
            match sessions
                .get(nyra_session_id)
                .and_then(|s| s.by_shell_id.get(shell_id))
            {
                None => return,                        // row gone
                Some(p) if p.pid.is_some() => return,  // already resolved
                _ => {}
            }
        }
        if let Some(pid) = find_recent_by_command(&snippet, started_at).await {
            {
                let mut sessions = SESSIONS.lock();
                if let Some(p) = sessions
                    .get_mut(nyra_session_id)
                    .and_then(|s| s.by_shell_id.get_mut(shell_id))
                {
                    p.pid = Some(pid);
                }
            }
            broadcast(nyra_session_id);
            return;
        }
    }

    mark_untracked(nyra_session_id, shell_id);
}

fn mark_untracked(nyra_session_id: &str, shell_id: &str) {
    let changed = {
        let mut sessions = SESSIONS.lock();
        match sessions
            .get_mut(nyra_session_id)
            .and_then(|s| s.by_shell_id.get_mut(shell_id))
        {
            Some(p) if p.pid.is_none() && p.status == ProcStatus::Running => {
                p.status = ProcStatus::Untracked;
                true
            }
            _ => false,
        }
    };
    if changed {
        broadcast(nyra_session_id);
    }
}

async fn find_recent_by_command(snippet: &str, our_start: i64) -> Option<i32> {
    let out = tokio::process::Command::new("pgrep")
        .args(["-f", snippet])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let own = std::process::id() as i32;
    let pids: Vec<i32> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| l.trim().parse::<i32>().ok())
        .filter(|p| *p != own)
        .collect();
    if pids.is_empty() {
        return None;
    }

    // Only accept a process that actually started around when we registered the
    // shell, so a long-lived process with the same command line isn't mistaken
    // for this one.
    let mut candidates: Vec<(i32, i64)> = Vec::new();
    for pid in pids {
        let Some(started) = read_start_time_ms(pid).await else {
            continue;
        };
        let age = started - our_start;
        // Slack on both sides: the child may predate our registration slightly.
        if age > -3000 && age < 10_000 {
            candidates.push((pid, age));
        }
    }
    candidates.sort_by_key(|(_, age)| age.abs());
    candidates.first().map(|(pid, _)| *pid)
}

async fn read_start_time_ms(pid: i32) -> Option<i64> {
    // macOS and most Linux distros: `ps -o lstart=` → "Thu May  1 19:14:32 2026".
    let out = tokio::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&out.stdout);
    parse_lstart_ms(raw.trim())
}

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

pub fn truncate_output(s: &str) -> String {
    const MAX_CHARS: usize = 2000;
    const MAX_LINES: usize = 20;
    let lines: Vec<&str> = s.split('\n').collect();
    let mut trimmed = if lines.len() > MAX_LINES {
        format!(
            "… (truncated)\n{}",
            lines[lines.len() - MAX_LINES..].join("\n")
        )
    } else {
        s.to_string()
    };
    if trimmed.chars().count() > MAX_CHARS {
        let tail: String = trimmed
            .chars()
            .skip(trimmed.chars().count() - MAX_CHARS)
            .collect();
        trimmed = format!("… (truncated)\n{tail}");
    }
    trimmed
}

// ---- listening ports ----
//
// What a backgrounded shell is *serving*, which is the one thing about it you
// actually want in the composer. `npm run dev` is not a useful label; `:5173`
// is, because you can click it.
//
// Read out of the kernel rather than out of the log. Scraping "Local:
// http://localhost:5173/" from the output tail was the obvious approach and it
// is wrong twice over: a server that prints nothing (or prints before we attach
// the tail, or scrolls past the 4 KB window) has no port, and a server that has
// exited still has its banner sitting in the file, so the port outlives the
// process that owned it. `lsof` cannot be stale — if it lists the port, someone
// is listening on it right now.
//
// Two whole-machine calls per scan, ~55 ms together on a 600-process machine,
// regardless of how many shells are tracked. Attribution is by process tree:
// the tracked pid is a shell, and the thing that binds the port is its
// grandchild (`sh` → `npm` → `node`), so the ports of every descendant roll up
// to the shell Claude started.

/// `lsof -F` output → which ports each pid is listening on.
///
/// The `-F pn` format is one field per line, `p` opening a new process block and
/// `n` naming a socket: `p1085`, `f14`, `n127.0.0.1:4201`. Parsed rather than
/// column-split because the human format pads and truncates the command name.
pub fn parse_lsof_ports(text: &str) -> HashMap<i32, Vec<u16>> {
    let mut by_pid: HashMap<i32, Vec<u16>> = HashMap::new();
    let mut current: Option<i32> = None;
    for line in text.lines() {
        let (tag, rest) = match line.split_at_checked(1) {
            Some(pair) => pair,
            None => continue,
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
                let ports = by_pid.entry(pid).or_default();
                if !ports.contains(&port) {
                    ports.push(port);
                }
            }
            _ => {}
        }
    }
    for ports in by_pid.values_mut() {
        ports.sort_unstable();
    }
    by_pid
}

/// `ps -axo pid=,ppid=` → child → parent, for every process on the machine.
pub fn parse_parent_map(text: &str) -> HashMap<i32, i32> {
    let mut parents = HashMap::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        if let (Some(Ok(pid)), Some(Ok(ppid))) = (
            fields.next().map(str::parse::<i32>),
            fields.next().map(str::parse::<i32>),
        ) {
            parents.insert(pid, ppid);
        }
    }
    parents
}

/// The ports listening anywhere under each root, keyed by that root.
///
/// Walks upward from each listening pid rather than downward from each root:
/// there are a handful of listeners and hundreds of processes, and a `ppid` map
/// only goes that way. The walk is depth-capped so a `ppid` cycle — which should
/// not exist, but this runs every few seconds forever — cannot hang the poller.
pub fn roll_up_ports(
    roots: &[i32],
    parents: &HashMap<i32, i32>,
    listening: &HashMap<i32, Vec<u16>>,
) -> HashMap<i32, Vec<u16>> {
    const MAX_DEPTH: usize = 64;
    let mut out: HashMap<i32, Vec<u16>> = HashMap::new();
    for (pid, ports) in listening {
        let mut at = *pid;
        for _ in 0..MAX_DEPTH {
            if roots.contains(&at) {
                let bucket = out.entry(at).or_default();
                for port in ports {
                    if !bucket.contains(port) {
                        bucket.push(*port);
                    }
                }
                break;
            }
            match parents.get(&at) {
                Some(&parent) if parent > 1 && parent != at => at = parent,
                _ => break,
            }
        }
    }
    for ports in out.values_mut() {
        ports.sort_unstable();
    }
    out
}

async fn run_capture(program: &str, args: &[&str]) -> Option<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::process::Command::new(program).args(args).output(),
    )
    .await
    .ok()?
    .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// One scan across every session. `lsof` is absent on some minimal Linux
/// images and on Windows; there it finds nothing and no port is ever shown,
/// which is the same as before this existed.
async fn scan_ports() {
    let roots: Vec<i32> = {
        let sessions = SESSIONS.lock();
        sessions
            .values()
            .flat_map(|s| s.by_shell_id.values())
            .filter(|p| matches!(p.status, ProcStatus::Running | ProcStatus::Orphaned))
            .filter_map(|p| p.pid)
            .collect()
    };
    if roots.is_empty() {
        return;
    }

    let Some(lsof) = run_capture("lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pn"]).await
    else {
        return;
    };
    let listening = parse_lsof_ports(&lsof);
    let parents = run_capture("ps", &["-axo", "pid=,ppid="])
        .await
        .map(|t| parse_parent_map(&t))
        .unwrap_or_default();
    let by_root = roll_up_ports(&roots, &parents, &listening);

    let mut touched: Vec<String> = Vec::new();
    {
        let mut sessions = SESSIONS.lock();
        for (sid, state) in sessions.iter_mut() {
            let mut changed = false;
            for proc in state.by_shell_id.values_mut() {
                let next = proc
                    .pid
                    .and_then(|pid| by_root.get(&pid).cloned())
                    .unwrap_or_default();
                // A dead shell keeps whatever it last served rather than
                // flickering to empty; the row is about to say "exited" anyway.
                if next.is_empty() && !matches!(proc.status, ProcStatus::Running | ProcStatus::Orphaned)
                {
                    continue;
                }
                if proc.ports != next {
                    proc.ports = next;
                    changed = true;
                }
            }
            if changed {
                touched.push(sid.clone());
            }
        }
    }
    for sid in touched {
        broadcast(&sid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A session the registry is willing to record against.
    fn with_session(id: &str) {
        SESSIONS.lock().entry(id.to_string()).or_default();
    }

    fn rows(id: &str) -> Vec<BgProcess> {
        list_processes(id)
    }

    // The bug: `task_started`, `task_updated` and `task_notification` all key on
    // `tool_use_id` and only ever *enrich* a row. Nothing created one for a
    // Monitor, so every event about a monitor arrived, found nothing, and was
    // dropped — monitors did not exist as far as Nyra was concerned.
    #[test]
    fn a_ws_monitor_is_recorded() {
        let sid = "s-monitor-ws";
        with_session(sid);
        note_tool_input(
            sid,
            "toolu_ws",
            "Monitor",
            &serde_json::json!({
                "ws": { "url": "wss://events.example.com/stream" },
                "description": "deploy events"
            }),
        );

        let rows = rows(sid);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].kind, ProcKind::Monitor);
        assert_eq!(rows[0].description.as_deref(), Some("deploy events"));
        // The URL is the thing being watched, so it stands in for the command.
        assert_eq!(rows[0].command, "wss://events.example.com/stream");
        assert_eq!(rows[0].status, ProcStatus::Running);
        drop_session(sid);
    }

    #[test]
    fn a_monitor_takes_the_task_id_that_follows_it() {
        let sid = "s-monitor-task";
        with_session(sid);
        note_tool_input(
            sid,
            "toolu_m",
            "Monitor",
            &serde_json::json!({ "ws": { "url": "wss://x/y" }, "description": "ticks" }),
        );
        note_task_started(sid, "toolu_m", "b0cbjibar", Some("tick watcher"));

        let rows = rows(sid);
        assert_eq!(rows[0].task_id.as_deref(), Some("b0cbjibar"));
        assert_eq!(rows[0].description.as_deref(), Some("tick watcher"));
        drop_session(sid);
    }

    #[test]
    fn a_finished_monitor_stops_being_live() {
        let sid = "s-monitor-done";
        with_session(sid);
        note_tool_input(
            sid,
            "toolu_d",
            "Monitor",
            &serde_json::json!({ "ws": { "url": "wss://x/y" } }),
        );
        note_task_updated(
            sid,
            "toolu_d",
            &serde_json::json!({ "status": "completed", "end_time": 1790108586337i64 }),
        );

        let rows = rows(sid);
        assert_eq!(rows[0].status, ProcStatus::Exited);
        assert!(rows[0].ended_at.is_some());
        drop_session(sid);
    }

    // A plain Bash call is still not a monitor, and a foreground one is still
    // not tracked at all.
    #[test]
    fn an_ordinary_bash_call_is_untouched() {
        let sid = "s-monitor-bash";
        with_session(sid);
        note_tool_input(
            sid,
            "toolu_fg",
            "Bash",
            &serde_json::json!({ "command": "ls" }),
        );
        assert!(rows(sid).is_empty());
        drop_session(sid);
    }

    #[test]
    fn maps_known_statuses() {
        assert_eq!(map_claude_status("running"), ProcStatus::Running);
        assert_eq!(map_claude_status("killed"), ProcStatus::Killed);
        assert_eq!(map_claude_status("stopped"), ProcStatus::Stopped);
        assert_eq!(map_claude_status("completed"), ProcStatus::Exited);
        assert_eq!(map_claude_status("failed"), ProcStatus::Exited);
    }

    #[test]
    fn falls_back_to_exited_for_unknown_values() {
        assert_eq!(map_claude_status("something-new"), ProcStatus::Exited);
        assert_eq!(map_claude_status(""), ProcStatus::Exited);
    }

    #[test]
    fn passes_short_content_through_unchanged() {
        assert_eq!(truncate_output("hello\nworld"), "hello\nworld");
    }

    #[test]
    fn truncates_by_line_count() {
        let input: Vec<String> = (1..=30).map(|i| format!("line{i}")).collect();
        let out = truncate_output(&input.join("\n"));
        assert!(out.starts_with("… (truncated)"));
        assert!(out.contains("line30"));
        assert!(!out.contains("line10\n"));
    }

    #[test]
    fn parses_ps_lstart() {
        // Space-padded and two-digit days, as `ps -o lstart=` emits them.
        assert!(parse_lstart_ms("Fri May  1 19:14:32 2026").is_some());
        assert!(parse_lstart_ms("Mon May 11 19:14:32 2026").is_some());
        // A weekday inconsistent with the date must not sink the parse.
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

    #[test]
    fn parses_the_ps_parent_map() {
        let parents = parse_parent_map("    1     0\n  325     1\n  400   325\n");
        assert_eq!(parents.get(&400), Some(&325));
        assert_eq!(parents.get(&1), Some(&0));
    }

    #[test]
    fn rolls_a_grandchilds_port_up_to_the_tracked_shell() {
        // sh(500) → npm(501) → node(502), and only node binds the port.
        let parents = HashMap::from([(502, 501), (501, 500), (500, 1)]);
        let listening = HashMap::from([(502, vec![5173])]);
        let rolled = roll_up_ports(&[500], &parents, &listening);
        assert_eq!(rolled.get(&500), Some(&vec![5173]));
    }

    #[test]
    fn keeps_two_shells_ports_apart() {
        let parents = HashMap::from([(601, 600), (701, 700)]);
        let listening = HashMap::from([(601, vec![3000]), (701, vec![8787])]);
        let rolled = roll_up_ports(&[600, 700], &parents, &listening);
        assert_eq!(rolled.get(&600), Some(&vec![3000]));
        assert_eq!(rolled.get(&700), Some(&vec![8787]));
    }

    #[test]
    fn collects_several_ports_under_one_shell() {
        // A dev server with an HMR socket, plus a sibling worker.
        let parents = HashMap::from([(801, 800), (802, 801)]);
        let listening = HashMap::from([(801, vec![5173]), (802, vec![24678])]);
        assert_eq!(
            roll_up_ports(&[800], &parents, &listening).get(&800),
            Some(&vec![5173, 24678])
        );
    }

    #[test]
    fn ignores_a_listener_that_is_not_ours() {
        let parents = HashMap::from([(901, 1)]);
        let listening = HashMap::from([(901, vec![7000])]);
        assert!(roll_up_ports(&[500], &parents, &listening).is_empty());
    }

    #[test]
    fn survives_a_cycle_in_the_parent_map() {
        // Should be impossible; the poller runs forever, so it must not hang.
        let parents = HashMap::from([(10, 11), (11, 10)]);
        let listening = HashMap::from([(10, vec![1234])]);
        assert!(roll_up_ports(&[999], &parents, &listening).is_empty());
    }

    #[test]
    fn tails_only_the_last_chunk_of_a_file() {
        let path = std::env::temp_dir().join(format!("nyra-tail-{}.log", util::rand_suffix(6)));
        let body: String = (1..=500).map(|i| format!("line{i}\n")).collect();
        std::fs::write(&path, &body).unwrap();
        let p = path.to_string_lossy().to_string();

        let (size, text) = read_output_tail(&p, None).unwrap();
        assert_eq!(size, body.len() as u64);
        assert!(text.contains("line500"));
        assert!(!text.contains("line1\n"));

        // Unchanged size short-circuits.
        assert!(read_output_tail(&p, Some(size)).is_none());
        std::fs::remove_file(&path).ok();
    }
}
