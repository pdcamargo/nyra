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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgProcess {
    /// Claude's `tool_use_id` for the originating Bash call.
    pub shell_id: String,
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
        loop {
            ticker.tick().await;
            poll_once().await;
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

#[cfg(test)]
mod tests {
    use super::*;

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
