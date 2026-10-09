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
use std::collections::{HashMap, HashSet};
use std::io::{Read, Seek, SeekFrom};
use std::time::Duration;

use crate::platform;
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
    /// The pids that actually bound those ports, and which ports each one held.
    /// What lets a port outlive the shell it was found under: when that shell
    /// dies and its server is reparented away, the tree walk loses it, but the
    /// listener is still there by pid.
    #[serde(skip)]
    pub listeners: HashMap<i32, Vec<u16>>,
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
    crate::keep_awake::poke();
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
                listeners: HashMap::new(),
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
                listeners: HashMap::new(),
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
    let (changed, retry) = {
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
                // The hunt that `tool_input` started is timed from when the
                // call was announced, not from when the CLI got round to forking
                // it — hooks and its own checks sit in between, and past a few
                // seconds that hunt had already given up and called the shell
                // untracked. This event is the fork itself, so a second hunt
                // anchored here is looking at the right moment.
                // Shells only: a `ws` monitor has no child to find, and a hunt
                // for its URL would end by calling a live watch untracked.
                let retry = p.kind == ProcKind::Shell
                    && p.pid.is_none()
                    && matches!(p.status, ProcStatus::Running | ProcStatus::Untracked)
                    && !p.command.is_empty();
                (true, retry.then(|| p.command.clone()))
            }
            None => (false, None),
        }
    };
    if changed {
        broadcast(nyra_session_id);
    }
    if let Some(command) = retry {
        let sid = nyra_session_id.to_string();
        let tid = tool_use_id.to_string();
        tauri::async_runtime::spawn(async move {
            resolve_pid(&sid, &tid, &command).await;
            broadcast(&sid);
        });
    }
}

/// `system/task_updated` — Claude's own status wins over our polling.
///
/// Found by task id as well as by `tool_use_id`: the CLI sends this one with
/// only `task_id`, so a lookup by the other found nothing and a shell's end was
/// left to `task_notification` — which a row the pid hunt had given up on could
/// not take either.
pub fn note_task_updated(nyra_session_id: &str, tool_use_id: &str, task_id: &str, patch: &Value) {
    let changed = {
        let mut sessions = SESSIONS.lock();
        match sessions.get_mut(nyra_session_id).and_then(|s| {
            if !tool_use_id.is_empty() && s.by_shell_id.contains_key(tool_use_id) {
                return s.by_shell_id.get_mut(tool_use_id);
            }
            s.by_shell_id
                .values_mut()
                .find(|p| !task_id.is_empty() && p.task_id.as_deref() == Some(task_id))
        }) {
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

/// Background shells and monitors still going, for keep-awake. A shell that
/// has bound a port is a server: it is meant to run indefinitely and will not
/// report back, so it is left out — the same rule as the renderer's
/// `waitingOn`.
pub fn live_background() -> Vec<ProcKind> {
    SESSIONS
        .lock()
        .values()
        .flat_map(|s| s.by_shell_id.values())
        .filter(|p| is_live(p.status) && p.ports.is_empty())
        .map(|p| p.kind)
        .collect()
}

/// Every task id the registry holds, live or not. A roster entry with none of
/// these is a subagent.
pub fn known_task_ids() -> std::collections::HashSet<String> {
    SESSIONS
        .lock()
        .values()
        .flat_map(|s| s.by_shell_id.values())
        .filter_map(|p| p.task_id.clone())
        .collect()
}

/// Still going, as far as we know: untracked means its pid was never found, and
/// orphaned that its Claude went away while it did not.
fn is_live(status: ProcStatus) -> bool {
    matches!(status, ProcStatus::Running | ProcStatus::Untracked | ProcStatus::Orphaned)
}

/// The exit code in a notification's summary — `Background command "…" failed
/// with exit code 3`. The only place the CLI says it: `status` is just "failed".
fn exit_code_in(summary: &str) -> Option<i32> {
    let rest = &summary[summary.rfind("exit code ")? + "exit code ".len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit() || *c == '-').collect();
    digits.parse().ok()
}

/// `system/task_notification` — carries the file Claude streams task stdout to.
pub fn note_task_notification(
    nyra_session_id: &str,
    tool_use_id: &str,
    status: Option<&str>,
    output_file: Option<&str>,
    summary: Option<&str>,
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
            // without this guard it would downgrade the more specific signal. Any
            // live row can end, though — an untracked one used to stay that way.
            if mapped != ProcStatus::Running && is_live(p.status) {
                p.status = mapped;
            }
            if p.ended_at.is_none() && mapped != ProcStatus::Running {
                p.ended_at = Some(util::now_ms());
            }
            changed = true;
        }

        if p.exit_code.is_none() {
            if let Some(code) = summary.and_then(exit_code_in) {
                p.exit_code = Some(code);
                changed = true;
            }
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
    let pid = u32::try_from(pid)
        .ok()
        .filter(|p| *p >= 1)
        .ok_or_else(|| "invalid pid".to_string())?;
    // Escalate if it's still around in 3 s.
    platform::terminate_then_kill(pid, Duration::from_secs(3)).map_err(|e| e.to_string())
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
    crate::keep_awake::poke();
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
    u32::try_from(pid).is_ok_and(platform::is_alive)
}

// ---- memory ----

/// What one chat is holding in resident memory.
///
/// A measurement, not a bill: resident size counts shared pages in every process
/// that maps them, so the sum is bigger than what would be freed if the chat
/// went away. It is the right number for "which conversation is the heavy one",
/// which is the only question it gets asked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMemory {
    pub bytes: u64,
    /// How many processes that covered. Zero is "nothing of this chat is
    /// running", which is a different answer from a small number.
    pub processes: usize,
}

/// The process table as the two maps the walk needs: child → parent, and
/// pid → resident KB for every process whose size the OS would give.
///
/// The whole table in one read. A chat's tree is a dozen processes deep on a
/// busy turn, and the alternative is one syscall per pid.
pub fn process_maps(rows: &[platform::ProcessRow]) -> (HashMap<i32, i32>, HashMap<i32, u64>) {
    let mut parents = HashMap::new();
    let mut rss = HashMap::new();
    for row in rows {
        parents.insert(row.pid, row.ppid);
        if let Some(kb) = row.resident_kb {
            rss.insert(row.pid, kb);
        }
    }
    (parents, rss)
}

/// Resident bytes under `roots`, inclusive, with each pid counted once.
///
/// Downward, unlike the port roll-up, because the question is what a chat
/// started — and the only things it started are below it. Exactly why Nyra's own
/// memory and Chromium's are not in the answer: they hang off the app, not off a
/// chat's Claude process.
pub fn rss_under_roots(
    roots: &[i32],
    parents: &HashMap<i32, i32>,
    rss: &HashMap<i32, u64>,
) -> (u64, usize) {
    const MAX_DEPTH: usize = 64;
    let mut children: HashMap<i32, Vec<i32>> = HashMap::new();
    for (pid, parent) in parents {
        children.entry(*parent).or_default().push(*pid);
    }

    let mut seen: HashSet<i32> = HashSet::new();
    let mut bytes: u64 = 0;
    let mut counted: usize = 0;
    let mut stack: Vec<(i32, usize)> = roots.iter().map(|pid| (*pid, 0)).collect();
    while let Some((pid, depth)) = stack.pop() {
        // A pid cycle should not exist, but this walks a map the kernel wrote.
        if depth > MAX_DEPTH || !seen.insert(pid) {
            continue;
        }
        // A root that exited between the registry read and this one contributes
        // nothing rather than a made-up number.
        if let Some(kb) = rss.get(&pid) {
            bytes += kb * 1024;
            counted += 1;
        }
        if let Some(kids) = children.get(&pid) {
            for kid in kids {
                stack.push((*kid, depth + 1));
            }
        }
    }
    (bytes, counted)
}

/// The chat's process roots: its Claude PTY, plus every shell it left running.
///
/// Both, because both are the chat's: the PTY is what answers, and a background
/// shell is a child of it that outlives the turn that started it.
fn memory_roots(nyra_session_id: &str) -> Vec<i32> {
    let sessions = SESSIONS.lock();
    let Some(state) = sessions.get(nyra_session_id) else {
        return Vec::new();
    };
    let mut roots: Vec<i32> = Vec::new();
    if let Some(pid) = state.claude_pid {
        roots.push(pid as i32);
    }
    for proc in state.by_shell_id.values() {
        if !matches!(proc.status, ProcStatus::Running | ProcStatus::Orphaned) {
            continue;
        }
        if let Some(pid) = proc.pid {
            if !roots.contains(&pid) {
                roots.push(pid);
            }
        }
    }
    roots
}

/// Resident memory for one chat, or zeroes when nothing of it is running.
pub async fn session_memory(nyra_session_id: &str) -> SessionMemory {
    let roots = memory_roots(nyra_session_id);
    if roots.is_empty() {
        return SessionMemory {
            bytes: 0,
            processes: 0,
        };
    }
    // Off the runtime: on Unix this waits on `ps`, on Windows it opens every
    // process on the machine in turn.
    let table = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(platform::process_table),
    )
    .await;
    let Ok(Ok(Some(rows))) = table else {
        return SessionMemory {
            bytes: 0,
            processes: 0,
        };
    };
    let (parents, rss) = process_maps(&rows);
    let (bytes, processes) = rss_under_roots(&roots, &parents, &rss);
    SessionMemory { bytes, processes }
}

/// The summary card's Chat RAM row. Registered in `lib.rs` beside the other
/// `processes_*` commands.
#[tauri::command(rename_all = "camelCase")]
pub async fn processes_memory(nyra_session_id: String) -> SessionMemory {
    session_memory(&nyra_session_id).await
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
    let Some(needle) = command_needle(command) else {
        mark_untracked(nyra_session_id, shell_id);
        return;
    };

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
        if let Some(pid) = find_recent_by_command(&needle, started_at).await {
            {
                let mut sessions = SESSIONS.lock();
                if let Some(p) = sessions
                    .get_mut(nyra_session_id)
                    .and_then(|s| s.by_shell_id.get_mut(shell_id))
                {
                    p.pid = Some(pid);
                    // An earlier hunt may have given up on it while this one was
                    // still looking.
                    if p.status == ProcStatus::Untracked {
                        p.status = ProcStatus::Running;
                    }
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

/// The part of a command line that can be found in the process table as
/// written.
///
/// Not simply the first 60 characters, which failed on quoting. The CLI does
/// not run the command as written: it runs `zsh -c "… eval '<command>' …"` (and
/// `bash.exe -c "…"` on Windows), so every quote in the command is re-escaped
/// in the command line being searched, and a prefix that contained one no
/// longer appeared in it. The shell was marked untracked, and an untracked
/// shell has no pid to find its ports under.
///
/// So: the longest stretch with nothing in it that either quoting style would
/// escape — no quotes, backslashes, `$` or backticks — which survives the
/// wrapping unchanged. A literal; `platform::find_processes` makes it whatever
/// its search wants.
pub fn command_needle(command: &str) -> Option<String> {
    let longest = command
        .split(|c| matches!(c, '\'' | '"' | '\\' | '$' | '`' | '\n' | '\r'))
        .map(str::trim)
        .max_by_key(|run| run.chars().count())?;
    let run: String = longest.chars().take(60).collect();
    let run = run.trim();
    (!run.is_empty()).then(|| run.to_string())
}

async fn find_recent_by_command(needle: &str, our_start: i64) -> Option<i32> {
    let needle = needle.to_string();
    let found = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(move || platform::find_processes(&needle)),
    )
    .await
    .ok()?
    .ok()?;

    // Only accept a process that actually started around when we registered the
    // shell, so a long-lived process with the same command line isn't mistaken
    // for this one.
    let own = std::process::id() as i32;
    let mut candidates: Vec<(i32, i64)> = found
        .into_iter()
        .filter(|p| p.pid != own)
        .filter_map(|p| p.started_ms.map(|started| (p.pid, started - our_start)))
        // Slack on both sides: the child may predate our registration slightly.
        .filter(|(_, age)| *age > -3000 && *age < 10_000)
        .collect();
    candidates.sort_by_key(|(_, age)| age.abs());
    candidates.first().map(|(pid, _)| *pid)
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
// process that owned it. The kernel's table cannot be stale — if it lists the
// port, someone is listening on it right now. `platform::listening_ports` reads
// it: `lsof` on macOS, the TCP table itself on Windows.
//
// Two whole-machine reads per scan, ~55 ms together on a 600-process Mac,
// regardless of how many shells are tracked. Attribution is by process tree:
// the tracked pid is a shell, and the thing that binds the port is its
// grandchild (`sh` → `npm` → `node`), so the ports of every descendant roll up
// to the shell Claude started.

/// The listeners anywhere under each root, keyed by that root: which pid bound
/// which ports.
///
/// Walks upward from each listening pid rather than downward from each root:
/// there are a handful of listeners and hundreds of processes, and a `ppid` map
/// only goes that way. The walk is depth-capped so a `ppid` cycle — which should
/// not exist, but this runs every few seconds forever — cannot hang the poller.
pub fn roll_up_listeners(
    roots: &[i32],
    parents: &HashMap<i32, i32>,
    listening: &HashMap<i32, Vec<u16>>,
) -> HashMap<i32, HashMap<i32, Vec<u16>>> {
    const MAX_DEPTH: usize = 64;
    let mut out: HashMap<i32, HashMap<i32, Vec<u16>>> = HashMap::new();
    for (pid, ports) in listening {
        let mut at = *pid;
        for _ in 0..MAX_DEPTH {
            if roots.contains(&at) {
                out.entry(at).or_default().insert(*pid, ports.clone());
                break;
            }
            match parents.get(&at) {
                Some(&parent) if parent > 1 && parent != at => at = parent,
                _ => break,
            }
        }
    }
    out
}

/// Every port a set of listeners holds, deduped, lowest first.
pub fn ports_of(listeners: &HashMap<i32, Vec<u16>>) -> Vec<u16> {
    let mut ports: Vec<u16> = listeners.values().flatten().copied().collect();
    ports.sort_unstable();
    ports.dedup();
    ports
}

/// What a shell is serving after this scan.
///
/// `found` is what the tree walk turned up under its live pid. `remembered` is
/// what earlier scans did, and it is what keeps a server that has outlived its
/// shell — the CLI restarted and took the shell with it, say, and the server was
/// reparented to launchd — on the pill: the walk from that server no longer
/// reaches anything we track, but the server is still listening by pid.
///
/// A remembered listener only counts for the ports it was seen holding, so a
/// pid the kernel has since handed to something else, listening on something
/// else, is not claimed. Once the server stops listening it drops out, which is
/// what clears the pill.
pub fn next_listeners(
    found: Option<&HashMap<i32, Vec<u16>>>,
    remembered: &HashMap<i32, Vec<u16>>,
    listening: &HashMap<i32, Vec<u16>>,
) -> HashMap<i32, Vec<u16>> {
    let mut next: HashMap<i32, Vec<u16>> = HashMap::new();
    for (pid, seen) in remembered {
        let Some(now) = listening.get(pid) else { continue };
        let still: Vec<u16> = seen.iter().copied().filter(|p| now.contains(p)).collect();
        if !still.is_empty() {
            next.insert(*pid, still);
        }
    }
    if let Some(found) = found {
        for (pid, ports) in found {
            next.insert(*pid, ports.clone());
        }
    }
    next
}

/// One scan across every session. Where the OS cannot say what is listening —
/// a minimal Linux image without `lsof` — no port is ever shown, which is the
/// same as before this existed.
async fn scan_ports() {
    let has_work = {
        let sessions = SESSIONS.lock();
        sessions.values().flat_map(|s| s.by_shell_id.values()).any(|p| {
            !p.listeners.is_empty()
                || (p.pid.is_some() && matches!(p.status, ProcStatus::Running | ProcStatus::Orphaned))
        })
    };
    if !has_work {
        return;
    }

    // Both whole-machine reads block: `lsof` and `ps` on Unix, a TCP table and
    // a process snapshot on Windows.
    let tables = tokio::time::timeout(
        Duration::from_secs(5),
        tokio::task::spawn_blocking(|| (platform::listening_ports(), platform::process_table())),
    )
    .await;
    let Ok(Ok((Some(listening), rows))) = tables else {
        return;
    };
    let (parents, _) = process_maps(&rows.unwrap_or_default());

    let mut touched: Vec<String> = Vec::new();
    {
        let mut sessions = SESSIONS.lock();
        // Only a live shell is walked to: a dead one's pid may already belong
        // to something else, and its tree is gone either way.
        let roots: Vec<i32> = sessions
            .values()
            .flat_map(|s| s.by_shell_id.values())
            .filter(|p| matches!(p.status, ProcStatus::Running | ProcStatus::Orphaned))
            .filter_map(|p| p.pid)
            .collect();
        let by_root = roll_up_listeners(&roots, &parents, &listening);
        for (sid, state) in sessions.iter_mut() {
            let mut changed = false;
            for proc in state.by_shell_id.values_mut() {
                let found = proc
                    .pid
                    .filter(|_| matches!(proc.status, ProcStatus::Running | ProcStatus::Orphaned))
                    .and_then(|pid| by_root.get(&pid));
                let listeners = next_listeners(found, &proc.listeners, &listening);
                let ports = ports_of(&listeners);
                proc.listeners = listeners;
                if proc.ports != ports {
                    proc.ports = ports;
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

    /// What the memory tests start from: `ps` text, the way Unix reads it.
    fn parse_ps_table(text: &str) -> (HashMap<i32, i32>, HashMap<i32, u64>) {
        process_maps(&platform::parse_ps_rows(text))
    }

    #[test]
    fn a_process_the_os_would_not_size_still_parents_its_children() {
        // Windows: a protected process has no readable working set, but the
        // chat's processes under it are still the chat's.
        let rows = [
            platform::ProcessRow { pid: 10, ppid: 1, resident_kb: None },
            platform::ProcessRow { pid: 11, ppid: 10, resident_kb: Some(300) },
        ];
        let (parents, rss) = process_maps(&rows);
        assert_eq!(parents.get(&11), Some(&10));
        assert!(!rss.contains_key(&10));
        assert_eq!(rss_under_roots(&[10], &parents, &rss), (300 * 1024, 1));
    }

    /// The ports under each root, which is what the walk is for.
    fn roll_up_ports(
        roots: &[i32],
        parents: &HashMap<i32, i32>,
        listening: &HashMap<i32, Vec<u16>>,
    ) -> HashMap<i32, Vec<u16>> {
        roll_up_listeners(roots, parents, listening)
            .into_iter()
            .map(|(root, listeners)| (root, ports_of(&listeners)))
            .collect()
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
            "",
            &serde_json::json!({ "status": "completed", "end_time": 1790108586337i64 }),
        );

        let rows = rows(sid);
        assert_eq!(rows[0].status, ProcStatus::Exited);
        assert!(rows[0].ended_at.is_some());
        drop_session(sid);
    }

    // The CLI sends `task_updated` with a task id and no `tool_use_id`.
    #[test]
    fn a_task_update_finds_its_row_by_task_id() {
        let sid = "s-update-by-task";
        with_session(sid);
        note_tool_input(
            sid,
            "toolu_t",
            "Monitor",
            &serde_json::json!({ "ws": { "url": "wss://x/y" } }),
        );
        note_task_started(sid, "toolu_t", "bsrnpl2ao", None);
        note_task_updated(sid, "", "bsrnpl2ao", &serde_json::json!({ "status": "completed" }));

        assert_eq!(rows(sid)[0].status, ProcStatus::Exited);
        drop_session(sid);
    }

    // On Windows the pid hunt often gives up, and an untracked shell is still a
    // running one: its end has to land, with the code only the summary carries.
    #[test]
    fn an_untracked_shell_ends_with_its_exit_code() {
        let sid = "s-untracked-ends";
        with_session(sid);
        note_tool_input(
            sid,
            "toolu_u",
            "Monitor",
            &serde_json::json!({ "ws": { "url": "wss://x/y" } }),
        );
        SESSIONS.lock().get_mut(sid).unwrap().by_shell_id.get_mut("toolu_u").unwrap().status =
            ProcStatus::Untracked;
        note_task_notification(
            sid,
            "toolu_u",
            Some("failed"),
            None,
            Some("Background command \"Failing check\" failed with exit code 3"),
        );

        let rows = rows(sid);
        assert_eq!(rows[0].status, ProcStatus::Exited);
        assert_eq!(rows[0].exit_code, Some(3));
        drop_session(sid);
    }

    #[test]
    fn reads_the_exit_code_out_of_a_summary() {
        assert_eq!(exit_code_in("\"Wait\" completed (exit code 0)"), Some(0));
        assert_eq!(exit_code_in("\"Tick counter\" stream ended"), None);
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
    fn keeps_a_server_that_outlived_its_shell() {
        // The shell died and node was reparented away, so the walk finds
        // nothing — but node is still listening on the port it was seen on.
        let remembered = HashMap::from([(502, vec![4202])]);
        let listening = HashMap::from([(502, vec![4202])]);
        let next = next_listeners(None, &remembered, &listening);
        assert_eq!(ports_of(&next), vec![4202]);
    }

    #[test]
    fn lets_a_remembered_server_go_once_it_stops_listening() {
        let remembered = HashMap::from([(502, vec![4202])]);
        assert!(next_listeners(None, &remembered, &HashMap::new()).is_empty());
    }

    #[test]
    fn does_not_claim_a_reused_pid_listening_elsewhere() {
        // Same pid, different port: the kernel handed it to someone else.
        let remembered = HashMap::from([(502, vec![4202])]);
        let listening = HashMap::from([(502, vec![9000])]);
        assert!(next_listeners(None, &remembered, &listening).is_empty());
    }

    #[test]
    fn takes_a_live_shells_walk_as_the_answer() {
        let found = HashMap::from([(502, vec![5173, 24678])]);
        let remembered = HashMap::from([(502, vec![5173])]);
        let listening = HashMap::from([(502, vec![5173, 24678])]);
        let next = next_listeners(Some(&found), &remembered, &listening);
        assert_eq!(ports_of(&next), vec![5173, 24678]);
    }

    #[test]
    fn a_needle_skips_what_the_cli_re_quotes() {
        // `eval '…'` escapes the single quotes, so the run after them is the
        // one that appears in the command line unchanged.
        assert_eq!(
            command_needle("cd '/Users/me/My App' && npx nx serve portal --port 4202").as_deref(),
            Some("&& npx nx serve portal --port 4202")
        );
    }

    #[test]
    fn a_needle_is_literal() {
        // Escaping is the search's business, not the needle's.
        assert_eq!(
            command_needle("npm run dev -- --host 0.0.0.0 (x) [y]+").as_deref(),
            Some("npm run dev -- --host 0.0.0.0 (x) [y]+")
        );
    }

    #[test]
    fn a_needle_stops_at_a_dollar_and_is_capped() {
        let long = format!("PORT=$PORT {}", "a".repeat(100));
        assert_eq!(command_needle(&long).unwrap(), format!("PORT {}", "a".repeat(55)));
        assert!(command_needle("''").is_none());
    }

    #[test]
    fn parses_the_ps_resident_table() {
        let (parents, rss) = parse_ps_table("    1     0  1234\n   42     1  2048\n");
        assert_eq!(parents.get(&42), Some(&1));
        assert_eq!(rss.get(&42), Some(&2048));
        assert_eq!(rss.get(&1), Some(&1234));
    }

    #[test]
    fn skips_ps_lines_missing_a_column() {
        // A two-field line cannot say what anything costs, and half a row is
        // worse than none: it would report the process and none of its memory.
        let (parents, rss) = parse_ps_table("    7     1\n    8     1   512\n");
        assert!(!parents.contains_key(&7));
        assert_eq!(rss.get(&8), Some(&512));
    }

    #[test]
    fn counts_a_chats_tree_once_and_stops_at_its_roots() {
        // 10 is the chat's Claude process (100 KB) with a node child (200 KB);
        // 20 is a background shell (20 KB) with a worker of its own. 30 is
        // something else entirely — Nyra, or Chromium — and must not be in the
        // answer even though `ps` handed it over.
        let table = "10 1 100\n11 10 200\n12 11 50\n20 1 20\n21 20 50\n30 1 999";
        let (parents, rss) = parse_ps_table(table);
        let (bytes, count) = rss_under_roots(&[10, 20], &parents, &rss);
        assert_eq!(count, 5);
        assert_eq!(bytes, (100 + 200 + 50 + 20 + 50) * 1024);
    }

    #[test]
    fn counts_a_shared_descendant_once() {
        // Both roots parent the same child. Summing per root would bill it twice.
        let table = "10 1 100\n20 1 100\n30 10 400\n30 20 400";
        let (parents, rss) = parse_ps_table(table);
        let (bytes, count) = rss_under_roots(&[10, 20], &parents, &rss);
        assert_eq!(count, 3);
        assert_eq!(bytes, 600 * 1024);
    }

    #[test]
    fn a_root_that_has_exited_is_not_memory() {
        let (parents, rss) = parse_ps_table("   10     1   100\n");
        let (bytes, count) = rss_under_roots(&[10, 99], &parents, &rss);
        assert_eq!(count, 1);
        assert_eq!(bytes, 100 * 1024);
    }

    #[test]
    fn a_cycle_among_the_children_cannot_hang_the_walk() {
        let (parents, rss) = parse_ps_table("   10     1   100\n   11    10   100\n");
        let mut looped = parents.clone();
        looped.insert(10, 11);
        let (bytes, count) = rss_under_roots(&[10], &looped, &rss);
        assert_eq!(count, 2);
        assert_eq!(bytes, 200 * 1024);
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
