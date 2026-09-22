//! The Claude Code CLI runner.
//!
//! One long-lived `claude` child process per Nyra session, talked to over
//! `--input-format stream-json` on a real pipe. The process survives across turns
//! as long as the spawn-relevant settings don't change, so follow-up prompts skip
//! the cold start.
//!
//! Note this deliberately uses a plain pipe rather than a PTY: Claude rejects a
//! TTY stdin in stream-json mode with "Input must be provided either through
//! stdin or as a prompt argument". The PTY-backed paths are `login.rs` and
//! `terminal.rs`.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;
use tokio::sync::Mutex as AsyncMutex;

use crate::ai_title;
use crate::notify_user::notify;
use crate::processes;
use crate::settings::SpawnSettings;
use crate::subagents;
use crate::util;

/// Tools that require explicit user approval before running.
const PERMISSION_REQUIRED: [&str; 4] = ["Bash", "Edit", "Write", "ExitPlanMode"];

const MAX_LINE_BUFFER: usize = 1024 * 1024;
const MAX_EVENT_BUFFER: usize = 500;

// ---- binary resolution ----

/// macOS GUI apps don't inherit the shell `PATH`, so a bare `claude` often fails
/// to resolve in a packaged build. Probe the usual install locations first.
pub fn resolve_claude_binary(configured: &str) -> String {
    if configured.starts_with('/') {
        return configured.to_string();
    }
    let home = util::home_dir();
    let candidates: [PathBuf; 4] = [
        home.join(".local/bin/claude"),
        home.join(".npm-global/bin/claude"),
        PathBuf::from("/usr/local/bin/claude"),
        PathBuf::from("/opt/homebrew/bin/claude"),
    ];
    for candidate in candidates {
        if candidate.exists() {
            crate::logf!("Resolved claude binary: {}", candidate.display());
            return candidate.to_string_lossy().to_string();
        }
    }
    if configured.is_empty() {
        "claude".to_string()
    } else {
        configured.to_string()
    }
}

pub async fn check_binary(custom_path: Option<String>) -> Value {
    let configured = custom_path
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| util::settings().claude_binary_path);
    let binary = resolve_claude_binary(&configured);

    let run = tokio::time::timeout(
        Duration::from_secs(5),
        Command::new(&binary).arg("--version").output(),
    )
    .await;

    match run {
        Ok(Ok(out)) if out.status.success() => json!({
            "found": true,
            "path": binary,
            "version": String::from_utf8_lossy(&out.stdout).trim(),
        }),
        _ => json!({ "found": false, "path": binary }),
    }
}

pub fn is_auth_error(msg: &str) -> bool {
    if msg.is_empty() {
        return false;
    }
    static RE: Lazy<Regex> = Lazy::new(|| {
        Regex::new(r"(?i)\b401\b|authentication_error|invalid authentication|invalid api key|unauthorized")
            .unwrap()
    });
    RE.is_match(msg)
}

fn strip_ansi(s: &str) -> String {
    static CSI: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1B\[[\d;]*[a-zA-Z]").unwrap());
    static ESC: Lazy<Regex> = Lazy::new(|| Regex::new(r"\x1B[^\[]").unwrap());
    let s = CSI.replace_all(s, "");
    let s = ESC.replace_all(&s, "");
    s.replace('\r', "")
}

// ---- workflow-engine hooks ----

pub type UsageCallback = Arc<dyn Fn(Usage) + Send + Sync>;

#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
}

/// `(final text, is_error)` handed to whoever is awaiting a session's outcome.
type ResultSender = oneshot::Sender<(String, bool)>;

static RESULT_CALLBACKS: Lazy<Mutex<HashMap<String, ResultSender>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static USAGE_CALLBACKS: Lazy<Mutex<HashMap<String, UsageCallback>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Register a one-shot result sink for a session. Used by the workflow engine to
/// await a prompt node's final text instead of reading the renderer's events.
pub fn on_claude_result(nyra_session_id: &str) -> oneshot::Receiver<(String, bool)> {
    let (tx, rx) = oneshot::channel();
    RESULT_CALLBACKS.lock().insert(nyra_session_id.to_string(), tx);
    rx
}

pub fn on_claude_usage(nyra_session_id: &str, cb: UsageCallback) {
    USAGE_CALLBACKS.lock().insert(nyra_session_id.to_string(), cb);
}

pub fn off_claude_usage(nyra_session_id: &str) {
    USAGE_CALLBACKS.lock().remove(nyra_session_id);
}

/// Close out a session's result sink with an error.
///
/// The workflow engine blocks on this sink, so it has to fire exactly once for
/// every session — including the ones that die without ever emitting a `result`
/// event (abort, spawn failure, non-zero exit, permission denial).
fn fail_result_callback(nyra_session_id: &str, reason: &str) {
    if let Some(cb) = RESULT_CALLBACKS.lock().remove(nyra_session_id) {
        let _ = cb.send((reason.to_string(), true));
    }
}

// ---- session state ----

#[derive(Debug, Clone)]
struct PendingPermission {
    tool_id: String,
    tool_name: String,
    input: Value,
    original_content: Option<String>,
}

impl PendingPermission {
    fn to_json(&self) -> Value {
        json!({
            "tool_id": self.tool_id,
            "tool_name": self.tool_name,
            "input": self.input,
            "originalContent": self.original_content,
        })
    }
}

type TurnSender = oneshot::Sender<Result<Option<String>, String>>;

struct SessionInner {
    alive: bool,
    pid: Option<u32>,
    cwd: String,
    worktree_name: Option<String>,
    spawn_fingerprint: String,
    resume_session_id: Option<String>,
    settings: SpawnSettings,
    pending_permissions: VecDeque<PendingPermission>,
    waiting_for_permission: bool,
    pending_event_buffer: Vec<Value>,
    current_turn: Option<TurnSender>,
    turn_prompt: String,
    line_buffer: String,
    stale_resume_detected: bool,
    retry_in_flight: bool,
    /// tool_id -> path, for writes into `.claude/plans/` made while planning.
    /// Held only between a write being announced and its result arriving, which
    /// is the point the file is actually on disk and can be read back.
    plan_writes: HashMap<String, String>,
}

/// What answering one queued prompt did to the permission gate.
#[derive(Debug, PartialEq)]
enum GateState {
    /// More prompts are queued — stay parked.
    StillWaiting,
    /// Gate lowered; these buffered events need replaying in order.
    Cleared(Vec<Value>),
}

impl SessionInner {
    #[cfg(test)]
    fn for_test() -> Self {
        Self {
            alive: true,
            pid: None,
            cwd: "/tmp".into(),
            worktree_name: None,
            spawn_fingerprint: String::new(),
            resume_session_id: None,
            settings: SpawnSettings::default(),
            pending_permissions: VecDeque::new(),
            waiting_for_permission: false,
            pending_event_buffer: Vec::new(),
            current_turn: None,
            turn_prompt: String::new(),
            line_buffer: String::new(),
            stale_resume_detected: false,
            retry_in_flight: false,
            plan_writes: HashMap::new(),
        }
    }

    /// Re-read the settings that affect a turn rather than the process argv.
    ///
    /// The spawn fingerprint covers everything that reaches the command line, so
    /// changing one of those respawns the child anyway. `skip_permissions` and
    /// `auto_approve_tools` never reach argv — they gate prompts inside a live
    /// process — so they have to be refreshed on the snapshot instead, or a
    /// long-running session would answer with whatever was set when it spawned.
    fn refresh_runtime_settings(&mut self, next: &SpawnSettings) {
        self.settings.skip_permissions = next.skip_permissions;
        self.settings.auto_approve_tools = next.auto_approve_tools.clone();
    }

    /// Queue every prompt and park the stream in a single lock acquisition.
    ///
    /// This has to be atomic. Publishing a prompt before the gate is raised lets
    /// an instant auto-approval answer it, drain the queue, lower a gate that was
    /// never up — and then the loop raises it with nothing left to open it, which
    /// silently stalls the session forever.
    fn arm_permission_gate(&mut self, prompts: Vec<PendingPermission>) {
        self.pending_permissions.extend(prompts);
        self.waiting_for_permission = true;
    }

    fn take_pending_permission(&mut self) -> Option<PendingPermission> {
        self.pending_permissions.pop_front()
    }

    /// Lower the gate once nothing is queued, handing back the events to replay.
    fn release_gate_if_drained(&mut self) -> GateState {
        if !self.pending_permissions.is_empty() {
            return GateState::StillWaiting;
        }
        self.waiting_for_permission = false;
        GateState::Cleared(std::mem::take(&mut self.pending_event_buffer))
    }
}

struct Session {
    inner: Mutex<SessionInner>,
    stdin: AsyncMutex<Option<ChildStdin>>,
}

static SESSIONS: Lazy<Mutex<HashMap<String, Arc<Session>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

fn get_session(id: &str) -> Option<Arc<Session>> {
    SESSIONS.lock().get(id).cloned()
}

pub(crate) fn emit_event(nyra_session_id: &str, mut extra: Value) {
    if let Value::Object(map) = &mut extra {
        map.insert(
            "nyraSessionId".into(),
            Value::String(nyra_session_id.to_string()),
        );
    }
    util::emit("claude:event", extra);
}

// ---- lifecycle ----

fn kill_session_pty(sess: &Arc<Session>) {
    let pid = {
        let mut inner = sess.inner.lock();
        inner.alive = false;
        inner.pid
    };
    let Some(pid) = pid else { return };
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, libc::SIGTERM) };
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(500)).await;
            unsafe { libc::kill(pid as i32, libc::SIGKILL) };
        });
    }
}

/// SIGINT asks Claude to stop the current turn but stay alive for the next one.
pub fn abort_claude(nyra_session_id: Option<&str>) {
    let targets: Vec<(String, Arc<Session>)> = {
        let sessions = SESSIONS.lock();
        match nyra_session_id {
            Some(id) => sessions
                .get(id)
                .map(|s| vec![(id.to_string(), s.clone())])
                .unwrap_or_default(),
            None => sessions.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        }
    };

    for (id, sess) in targets {
        let (pid, turn) = {
            let mut inner = sess.inner.lock();
            let pid = if inner.alive { inner.pid } else { None };
            (pid, inner.current_turn.take())
        };
        #[cfg(unix)]
        if let Some(pid) = pid {
            unsafe { libc::kill(pid as i32, libc::SIGINT) };
        }
        if let Some(turn) = turn {
            let _ = turn.send(Err("Aborted by user".into()));
        }
        fail_result_callback(&id, "Aborted by user");
        emit_event(&id, json!({ "type": "stream_end" }));
    }
}

pub fn dispose_session(nyra_session_id: &str) {
    let Some(sess) = SESSIONS.lock().remove(nyra_session_id) else {
        return;
    };
    kill_session_pty(&sess);
    USAGE_CALLBACKS.lock().remove(nyra_session_id);
    ai_title::forget(nyra_session_id);
    subagents::forget_session(nyra_session_id);
    fail_result_callback(nyra_session_id, "Session disposed");
}

pub fn dispose_all() {
    let all: Vec<Arc<Session>> = SESSIONS.lock().drain().map(|(_, v)| v).collect();
    for sess in all {
        kill_session_pty(&sess);
    }
    USAGE_CALLBACKS.lock().clear();
}

// ---- permissions ----

async fn capture_original_content(tool_name: &str, input: &Value) -> Option<String> {
    if tool_name != "Edit" && tool_name != "Write" {
        return None;
    }
    let file_path = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    if file_path.is_empty() {
        return None;
    }
    // `None` also covers "file doesn't exist yet", which is what a revert needs
    // to know to delete rather than restore.
    tokio::fs::read_to_string(file_path).await.ok()
}

async fn revert_file_change(info: &PendingPermission) {
    if info.tool_name != "Edit" && info.tool_name != "Write" {
        return;
    }
    let file_path = info
        .input
        .get("file_path")
        .or_else(|| info.input.get("path"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if file_path.is_empty() {
        return;
    }

    match &info.original_content {
        Some(original) => match tokio::fs::write(&file_path, original).await {
            Ok(()) => crate::logf!("Reverted file: {file_path}"),
            Err(e) => crate::logf!("Failed to revert {file_path}: {e}"),
        },
        None => {
            if tokio::fs::try_exists(&file_path).await.unwrap_or(false) {
                match tokio::fs::remove_file(&file_path).await {
                    Ok(()) => crate::logf!("Deleted new file: {file_path}"),
                    Err(e) => crate::logf!("Failed to revert {file_path}: {e}"),
                }
            }
        }
    }
}

pub async fn respond_permission(approved: bool, nyra_session_id: Option<String>) {
    let Some(nyra_session_id) = nyra_session_id else {
        return;
    };
    let Some(sess) = get_session(&nyra_session_id) else {
        return;
    };

    let tool_info = { sess.inner.lock().take_pending_permission() };
    let Some(tool_info) = tool_info else {
        // Answered with nothing queued. Shouldn't happen now the gate is armed
        // atomically, but if it ever does, unstick the stream rather than leaving
        // it parked on a prompt that will never arrive.
        let state = sess.inner.lock().release_gate_if_drained();
        if let GateState::Cleared(buffered) = state {
            crate::logf!(
                "Permission answered with an empty queue [{}] — releasing gate, replaying {} event(s)",
                util::short(&nyra_session_id),
                buffered.len()
            );
            for raw in buffered {
                handle_event(&raw, &nyra_session_id);
            }
        }
        return;
    };

    if approved {
        emit_event(
            &nyra_session_id,
            json!({
                "type": "tool_start",
                "tool_id": tool_info.tool_id,
                "tool_name": tool_info.tool_name,
            }),
        );
        emit_event(
            &nyra_session_id,
            json!({
                "type": "tool_input",
                "tool_id": tool_info.tool_id,
                "tool_name": tool_info.tool_name,
                "input": tool_info.input,
                "originalContent": tool_info.original_content,
            }),
        );
        processes::note_tool_input(
            &nyra_session_id,
            &tool_info.tool_id,
            &tool_info.tool_name,
            &tool_info.input,
        );

        // More approvals queued for this turn — wait for them before replaying.
        let (state, alive) = {
            let mut inner = sess.inner.lock();
            let state = inner.release_gate_if_drained();
            (state, inner.alive)
        };
        let GateState::Cleared(buffered) = state else {
            return; // more approvals queued for this turn
        };

        for raw in buffered {
            handle_event(&raw, &nyra_session_id);
        }

        // The child stays up across turns. If it died while we were waiting for
        // the answer, close out the stream so the next prompt respawns.
        if !alive {
            emit_event(&nyra_session_id, json!({ "type": "stream_end" }));
            SESSIONS.lock().remove(&nyra_session_id);
        }
        return;
    }

    crate::logf!(
        "Denying permission for {} [{}]",
        tool_info.tool_name,
        util::short(&nyra_session_id)
    );

    let remaining: Vec<PendingPermission> = {
        let mut inner = sess.inner.lock();
        inner.pending_permissions.drain(..).collect()
    };

    revert_file_change(&tool_info).await;
    for r in &remaining {
        revert_file_change(r).await;
    }

    let mut denied = json!({ "type": "tool_denied" });
    if let Value::Object(map) = &mut denied {
        if let Value::Object(info) = tool_info.to_json() {
            map.extend(info);
        }
    }
    emit_event(&nyra_session_id, denied);
    for r in &remaining {
        let mut ev = json!({ "type": "tool_denied" });
        if let (Value::Object(map), Value::Object(info)) = (&mut ev, r.to_json()) {
            map.extend(info);
        }
        emit_event(&nyra_session_id, ev);
    }
    emit_event(&nyra_session_id, json!({ "type": "stream_end" }));

    let turn = {
        let mut inner = sess.inner.lock();
        inner.pending_event_buffer.clear();
        inner.waiting_for_permission = false;
        inner.current_turn.take()
    };
    if let Some(turn) = turn {
        let _ = turn.send(Err("Permission denied".into()));
    }

    // Under `--permission-mode bypassPermissions` Claude has likely already run the
    // tool, so killing the process is the only way to cancel the rest of the turn's
    // queued tool calls. Background children from earlier turns are lost; the next
    // prompt respawns.
    dispose_session(&nyra_session_id);
}

// ---- event fan-out to the renderer ----

/// What the CLI sets `model` to when it answers a slash command itself.
const SYNTHETIC_MODEL: &str = "<synthetic>";

/// What `/goal` was pointed at, for a message that is the CLI acknowledging one.
///
/// Both halves of the test are load-bearing. The prefix alone would catch
/// Claude's own prose — a turn that ends "Goal set: ..." in a summary is
/// ordinary text — and `<synthetic>` alone covers every other slash command the
/// CLI answers, including `/goal` with no argument, which reports that no goal
/// is set and is an answer rather than a goal.
///
/// The goal lasts one turn. In `-p` the CLI does not carry it into the next one
/// or loop until it is met: sending `/goal x` and then `/goal` reports "No goal
/// set", and it does so even when the first turn failed to achieve x. So this is
/// a record of what a turn was aimed at, not the start of a session-long mode.
fn goal_condition(synthetic: bool, text: &str) -> Option<String> {
    if !synthetic {
        return None;
    }
    let condition = text.trim().strip_prefix("Goal set:")?.trim();
    if condition.is_empty() {
        return None;
    }
    Some(condition.to_string())
}

fn handle_event(raw: &Value, nyra_session_id: &str) {
    let event_type = raw.get("type").and_then(Value::as_str).unwrap_or_default();

    if event_type == "user" {
        let content = raw
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array);
        let Some(content) = content else { return };
        for block in content {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let result_content = match block.get("content") {
                Some(Value::Array(parts)) => parts
                    .iter()
                    .map(|c| c.get("text").and_then(Value::as_str).unwrap_or_default())
                    .collect::<String>(),
                Some(Value::String(s)) => s.clone(),
                _ => String::new(),
            };
            let tool_id = block
                .get("tool_use_id")
                .and_then(Value::as_str)
                .unwrap_or_default();
            emit_event(
                nyra_session_id,
                json!({ "type": "tool_result", "tool_id": tool_id, "content": result_content }),
            );
            processes::note_tool_result(nyra_session_id, tool_id, &result_content);
            // The launch receipt of a background subagent carries the same path
            // `task_notification` does, and gets here first. Whichever wins, the
            // other is a no-op.
            if let Some(path) = subagents::output_file_from_receipt(&result_content) {
                subagents::watch(nyra_session_id, tool_id, &path);
            }
            emit_plan_ready(nyra_session_id, tool_id);
        }
    }

    // Claude's prose, as it is written rather than all at once when the turn
    // ends. A long execution used to be silent from the first tool call to the
    // last, then say everything at once — the `result` event carries the whole
    // reply, and nothing before it carried any of it.
    if event_type == "assistant" {
        // `/goal` is answered by the CLI itself, not the model, and those
        // replies come back as an assistant message with the model set to
        // `<synthetic>`. That field is only visible here — the renderer is sent
        // text — so a goal has to be recognised on the way past.
        let synthetic = raw
            .get("message")
            .and_then(|m| m.get("model"))
            .and_then(Value::as_str)
            == Some(SYNTHETIC_MODEL);

        if let Some(content) = raw
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            for block in content {
                if block.get("type").and_then(Value::as_str) != Some("text") {
                    continue;
                }
                let text = block.get("text").and_then(Value::as_str).unwrap_or_default();
                if text.trim().is_empty() {
                    continue;
                }
                match goal_condition(synthetic, text) {
                    Some(condition) => emit_event(
                        nyra_session_id,
                        json!({ "type": "goal_set", "condition": condition }),
                    ),
                    None => emit_event(
                        nyra_session_id,
                        json!({ "type": "assistant_text", "text": text }),
                    ),
                }
            }
        }
    }

    if event_type == "result" {
        let result_text = raw.get("result").and_then(Value::as_str).unwrap_or_default();
        let is_error = raw
            .get("is_error")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        if let Some(cb) = RESULT_CALLBACKS.lock().remove(nyra_session_id) {
            let _ = cb.send((result_text.to_string(), is_error));
        }
        USAGE_CALLBACKS.lock().remove(nyra_session_id);
        // Claude is exiting; background bash children are orphaned but still
        // tracked by pid so they remain killable.
        processes::clear_session(nyra_session_id);

        emit_event(
            nyra_session_id,
            json!({
                "type": "result",
                "result": raw.get("result").cloned().unwrap_or(Value::String(String::new())),
                "session_id": raw.get("session_id").cloned().unwrap_or(Value::Null),
                "is_error": is_error,
            }),
        );
        emit_event(nyra_session_id, json!({ "type": "stream_end" }));

        if is_error {
            let err_text = if result_text.is_empty() {
                "Something went wrong"
            } else {
                result_text
            };
            if is_auth_error(err_text) {
                emit_event(
                    nyra_session_id,
                    json!({ "type": "auth_required", "message": clip(err_text, 200) }),
                );
            }
            notify("Task Failed", &clip(err_text, 80));
        } else {
            let text = clip(result_text, 80);
            notify(
                "Task Complete",
                if text.is_empty() {
                    "Claude finished your task"
                } else {
                    &text
                },
            );
        }
    }

    if event_type == "system" {
        match raw.get("subtype").and_then(Value::as_str) {
            Some("init") => emit_event(
                nyra_session_id,
                json!({
                    "type": "system",
                    "subtype": "init",
                    "mcp_servers": raw.get("mcp_servers").cloned().unwrap_or(json!([])),
                    "tools": raw.get("tools").cloned().unwrap_or(json!([])),
                    // What this CLI build actually supports. The composer used
                    // to complete from a list kept by hand here, which had
                    // drifted four commands behind the binary.
                    "slash_commands": raw.get("slash_commands").cloned().unwrap_or(json!([])),
                    // Which model the alias actually resolved to. `--model opus`
                    // asks for "the latest Opus", and only the CLI knows that is
                    // claude-opus-5-5 today — this event is the one place a
                    // version number can be put on a label without inventing it.
                    "model": raw.get("model").cloned().unwrap_or(Value::Null),
                }),
            ),
            Some("task_started") => processes::note_task_started(
                nyra_session_id,
                raw.get("tool_use_id").and_then(Value::as_str).unwrap_or_default(),
                raw.get("task_id").and_then(Value::as_str).unwrap_or_default(),
                raw.get("description").and_then(Value::as_str),
            ),
            Some("task_updated") => processes::note_task_updated(
                nyra_session_id,
                raw.get("tool_use_id").and_then(Value::as_str).unwrap_or_default(),
                raw.get("patch").unwrap_or(&json!({})),
            ),
            // Background subagents. The turn ends the moment they are spawned,
            // so without these the app goes quiet while three agents keep
            // working — and the only other signal, the Task tool's result, is a
            // handle that comes back in two seconds and looks like completion.
            Some("background_tasks_changed") => emit_event(
                nyra_session_id,
                json!({
                    "type": "background_tasks",
                    "tasks": raw.get("tasks").cloned().unwrap_or(json!([])),
                }),
            ),
            Some("task_progress") => emit_event(
                nyra_session_id,
                json!({
                    "type": "background_task_progress",
                    // `session_id` on these is the parent's, not the subagent's,
                    // and `description` is what it is doing rather than what it
                    // is — `task_id` is the only thing that names the agent.
                    "task_id": raw.get("task_id").and_then(Value::as_str).unwrap_or_default(),
                    // The Task call that spawned it — what `session.agents` is
                    // keyed by, so one signal can drive the roster and the tree.
                    "tool_use_id": raw.get("tool_use_id").and_then(Value::as_str).unwrap_or_default(),
                    "activity": raw.get("description").and_then(Value::as_str).unwrap_or_default(),
                    "duration_ms": raw.get("usage").and_then(|u| u.get("duration_ms")).and_then(Value::as_u64).unwrap_or(0),
                    "last_tool_name": raw.get("last_tool_name").and_then(Value::as_str).unwrap_or_default(),
                    "subagent_type": raw.get("subagent_type").and_then(Value::as_str).unwrap_or_default(),
                }),
            ),
            Some("task_notification") => {
                let tool_use_id = raw
                    .get("tool_use_id")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let output_file = raw.get("output_file").and_then(Value::as_str);
                let status = raw.get("status").and_then(Value::as_str);
                processes::note_task_notification(
                    nyra_session_id,
                    tool_use_id,
                    status,
                    output_file,
                );
                // `note_task_notification` looks this up in `by_shell_id`, which
                // only a backgrounded `Bash` ever populates — so for a `Task`
                // the lookup misses and the path was dropped on the floor. It is
                // the subagent's live transcript; follow it.
                if let Some(path) = output_file.filter(|p| !p.is_empty()) {
                    subagents::watch(nyra_session_id, tool_use_id, path);
                }
                if matches!(status, Some("completed") | Some("failed") | Some("killed")) {
                    subagents::stop(nyra_session_id, tool_use_id);
                }
            }
            _ => {}
        }
    }
    // `assistant` usage is pulled out in the read loop, before the tool logic, so
    // it is never missed when that path `continue`s.
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ---- spawning ----

/// Taught to every session, because this GUI can offer buttons and the headless
/// CLI has no `AskUserQuestion` to ask for them. The renderer lifts the block out
/// of the reply and renders it as a questionnaire; see `askBlocks.ts`.
///
/// Markdown rather than JSON: a model gets `- OAuth — no secrets` right every
/// time, and fumbles quoting often enough that a mangled question would simply
/// vanish.
const ASK_CONVENTION: &str = concat!(
    "\n\nWhen the user's answer would change what you do — which option to take, ",
    "which of several readings of the request is right — you may ask them with a ",
    "```nyra-ask fenced block, which Nyra renders as clickable choices. Inside it, ",
    "each question is a `## ` heading and each option a `- ` bullet with an optional ",
    "` — description`. Put `(multi)` in a heading to accept several answers, and a ",
    "`[Short label]` prefix for the chip. For example:\n",
    "```nyra-ask\n",
    "## [Auth] Which auth method?\n",
    "- OAuth — slower to build, nothing to store\n",
    "- API key — quicker, you own rotation\n",
    "```\n",
    "Rules: at most one block per message, at the end; never repeat those questions ",
    "in prose, because Nyra shows the block itself; never use it for something you ",
    "can settle yourself or find in the code; and prefer asking nothing at all to ",
    "asking about a decision the user has already made."
);

/// Claude can already produce a PNG — matplotlib, sharp, `screencapture`, a
/// headless-browser screenshot — and until now had no way to put one on screen.
/// The renderer resolves the path through `fs_read_image`; see `MarkdownRenderer.tsx`.
///
/// Display only, which is what the closing sentence is for: the bytes go to the
/// webview and never back into the conversation.
///
/// Narrow on purpose. A broad "you can show images" fires on prose that read fine
/// as text, and the render path is best-effort, so an instruction that
/// over-triggers costs more than one that under-triggers.
const IMAGE_CONVENTION: &str = concat!(
    "\n\nNyra shows images inline, so a PNG or JPEG you generate can be displayed ",
    "rather than described: write the file to disk, then reference it on its own line ",
    "as `![alt](/absolute/path.png)`. The path must be absolute and free of spaces, and ",
    "the file must already exist when you write that line. Use it for output that is ",
    "only legible as a picture — a chart you plotted, a screenshot you captured, a ",
    "rendered visual diff — and not to decorate an answer that reads fine as text. PNG ",
    "and JPEG only; other formats, including SVG, will not render. You cannot see what ",
    "Nyra displays, so if it matters whether the image came out right, read the file back."
);

/// Also taught to every session, and for the same reason: `TodoWrite`,
/// `TaskCreate` and the rest do not exist in the headless CLI either, so the
/// handlers Nyra already had for them could never fire. The renderer parses this
/// into the checklist above the composer; see `taskBlocks.ts`.
const TASKS_CONVENTION: &str = concat!(
    "\n\nWhen you start carrying out a plan, or any piece of work with more than ",
    "two or three steps, keep a checklist the user can watch. Write it as a ",
    "```nyra-tasks fenced block: one `- [ ] ` item per step, `- [x] ` for done and ",
    "`- [>] ` for the one you are on. For example:\n",
    "```nyra-tasks\n",
    "- [x] Read the render path\n",
    "- [>] Wire the image cache\n",
    "- [ ] Add the placeholder for a missing file\n",
    "```\n",
    "Restate the whole list, not a diff, each time something changes status — ",
    "Nyra replaces the list with what the block says. Put it out as you start, ",
    "and again as each step finishes. Skip it for a one-step answer, a question, ",
    "or anything conversational: a checklist of one item is noise."
);

/// Third of the fenced conventions, and taught for the same reason as the
/// checklist: nothing in the headless CLI reports a turn's file changes, so the
/// model has to say it. The renderer draws it as a card that links into the
/// Changes tab; see `changeBlocks.ts`.
///
/// Two clauses here are load-bearing rather than stylistic. The numbers must come
/// from `git diff --numstat` — Codex's equivalent card runs on turn telemetry and
/// disagrees with the repo, so it offers a review that opens empty. And `base:`
/// is what keeps a row clickable after the work is committed: it names the commit
/// the counts were true at, so the diff that opens is the one described.
const CHANGES_CONVENTION: &str = concat!(
    "\n\nWhen you finish a piece of work that changed two or more files, end your ",
    "reply with a ```nyra-changes fenced block so the user can see what moved. The ",
    "first line is `base: <short sha>` from `git rev-parse --short HEAD`; then one ",
    "`path | +N -M` line per file. For example:\n",
    "```nyra-changes\n",
    "base: 50cb2a4\n",
    "src/renderer/src/components/ComposerBar.tsx | +212 -23\n",
    "src-tauri/src/git.rs | +33 -2\n",
    "```\n",
    "Take the numbers from git rather than estimating them — each row opens a real ",
    "diff, and a count you guessed will not match what appears. `git diff --numstat` ",
    "alone is not enough: it cannot see a file git has never been told about, so a ",
    "turn that adds files would report none of them. This covers both:\n",
    "```sh\n",
    "git diff --numstat; git ls-files --others --exclude-standard | \\\n",
    "  while read -r f; do printf '%s\\t0\\t%s\\n' \"$(wc -l < \"$f\")\" \"$f\"; done\n",
    "```\n",
    "Write it once, when the work is done, not after each edit: a single changed ",
    "file is already visible in its tool card, and while you are still working the ",
    "checklist is the right surface. Skip it for a turn that only read things."
);

/// Taught only when the browser tools are actually attached.
///
/// The MCP tools describe themselves, so the model can work out *how* to click
/// something without being told. What it cannot work out is that the page is on
/// screen — that this is a surface the user is watching and can grab, rather
/// than a headless scratchpad that happens to render. That changes when it is
/// worth opening at all, and what to do when the page moves underneath it.
const BROWSER_CONVENTION: &str = concat!(
    "\n\nThis conversation has a real browser, and the user can see it. Pages you ",
    "open show up in their tab strip and in the Pinned Summary, and a miniature ",
    "floats over the chat when the panel is closed — so opening a page is a visible ",
    "act, not a private one. They can click and type in it while you work, so the ",
    "page may have moved since you last looked: take a fresh `browser_snapshot` ",
    "rather than trusting an old one. The browser belongs to this conversation ",
    "alone; other chats have their own and cannot see these tabs.\n",
    "Use it to look at your own work. When you change anything with a rendered ",
    "surface — a component, a stylesheet, a page served by a dev server — open it ",
    "and check, rather than describing what it should now do. `browser_snapshot` ",
    "reads the page as structured text and is the one to reach for by default; ",
    "`browser_take_screenshot` is for when the question is genuinely visual, and ",
    "it comes back as an image you can look at.\n",
    "The page renders at whatever size the panel gives it and reflows as the user ",
    "drags that panel, so a narrow panel is genuinely a narrow page rather than a ",
    "desktop layout scaled down \u{2014} which means the layout you are looking at is only ",
    "one of them. When the question is how something behaves at a particular size, set ",
    "that size rather than inferring it: `browser_device` takes a named device such as ",
    "`iphone-16-pro` or `ipad-mini`, `custom` with a width and a height, or `responsive` ",
    "to hand it back to the panel, and the tool itself lists the rest. A phone or tablet ",
    "also sets the pixel ratio, the mobile flag and touch, so the page serves its real ",
    "mobile layout rather than a narrow desktop one \u{2014} a bare width does not. Setting it ",
    "is visible: the panel reframes while the user watches and the size is labelled in ",
    "their address bar, so say why you are switching, and put it back to `responsive` ",
    "when you have finished looking. Close a tab when you are done with it: each one ",
    "costs real memory, and the user is looking at the list."
);

/// Taught only when the app tools are actually attached, on the same terms as
/// the browser.
///
/// The tools describe themselves, so this does not list them — what a schema
/// cannot say is that the thing on the other end is the window the user is
/// looking at. That is what makes reading before writing worth a sentence (a
/// toggle run blind closes as often as it opens), and what makes narrating the
/// change non-optional: a panel that moves on its own, unremarked, reads as a
/// glitch rather than as an answer.
///
/// `~/.nyra/` is here because it is the fact this whole thing was missing. A
/// session that knew the schema by heart still told people to export JSON and
/// import it by hand, because nothing ever said where the flows were.
const APP_CONVENTION: &str = concat!(
    "\n\nNyra is not just where this conversation is displayed — you can change it. ",
    "`nyra_ui` reads its state and runs any of its commands; `nyra_flow` reads and ",
    "writes the flows kept in `~/.nyra/workflows/`; `nyra_update` checks for a newer ",
    "version. Look before you act: `nyra_ui` with `action: \"state\"` says what is ",
    "already open, and running a toggle without knowing that closes as often as it ",
    "opens — pass `on` when you mean open. Then say what you changed, in one line, ",
    "naming it: \"I opened the terminal\", \"I turned on light mode\", \"I opened your ",
    "browser at example.com\". The user is watching that window, and a change nobody ",
    "mentions looks like a bug. Only change what was asked for — none of this is for ",
    "tidying up after yourself."
);

/// Everything Nyra has to teach a session about itself, plus whatever the user
/// added.
///
/// Split out because one clause here is conditional and that is exactly the kind
/// of thing that rots quietly: a session told it has a browser when it has none
/// will invent tool calls that fail, and a session with a browser and no mention
/// of it will never think to look at its own work.
fn compose_system_prompt(
    cwd: &str,
    user_prompt: &str,
    has_browser: bool,
    has_app: bool,
) -> String {
    let mut parts: Vec<&str> = vec![
        "You are running inside Nyra, a desktop GUI for Claude Code.",
        "Tool call results are NOT shown inline — they are hidden inside collapsible cards the user may not open.",
        "You MUST always include relevant output (file contents, command results, directory listings, etc.) directly in your text response.",
        "Never say \"here it is\" or \"see above\" without actually showing the content in your message.",
    ];
    let cwd_line = format!(
        "The current working directory is: {cwd}. When the user says \"your directory\" or \"this directory\", they mean this path."
    );
    parts.push(&cwd_line);
    parts.push(ASK_CONVENTION);
    parts.push(IMAGE_CONVENTION);
    parts.push(TASKS_CONVENTION);
    parts.push(CHANGES_CONVENTION);
    if has_browser {
        parts.push(BROWSER_CONVENTION);
    }
    if has_app {
        parts.push(APP_CONVENTION);
    }

    let nyra = parts.join(" ");
    if user_prompt.is_empty() {
        nyra
    } else {
        format!("{nyra}\n\n{user_prompt}")
    }
}

fn build_spawn_args(
    cwd: &str,
    settings: &SpawnSettings,
    worktree_name: Option<&str>,
    resume_session_id: Option<&str>,
    nyra_session_id: Option<&str>,
) -> (Vec<String>, String) {
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--input-format".into(),
        "stream-json".into(),
        "--output-format".into(),
        "stream-json".into(),
        "--verbose".into(),
    ];
    if !settings.model.is_empty() {
        args.push("--model".into());
        args.push(settings.model.clone());
    }

    // Resolved once: the same condition decides whether the tools are attached
    // and whether the prompt is allowed to talk about them. Teaching a browser
    // to a session that has none is worse than saying nothing.
    let browser_mcp = nyra_session_id
        .filter(|_| util::settings().browser_tools)
        .and_then(crate::browser::mcp_endpoint);

    // The same bargain for the app's own tools. A workflow node has no chat id
    // and no window to drive, so it gets neither these nor the browser.
    let app_mcp = nyra_session_id
        .filter(|_| util::settings().app_tools)
        .and_then(crate::app_mcp::mcp_endpoint);

    let full_system_prompt = compose_system_prompt(
        cwd,
        &settings.system_prompt,
        browser_mcp.is_some(),
        app_mcp.is_some(),
    );
    args.push("--append-system-prompt".into());
    args.push(full_system_prompt);

    if !settings.effort.is_empty() {
        args.push("--effort".into());
        args.push(settings.effort.clone());
    }
    if let Some(tools) = settings.allowed_tools.as_ref().filter(|t| !t.is_empty()) {
        args.push("--allowed-tools".into());
        args.push(tools.join(","));
    }
    args.push("--permission-mode".into());
    args.push(if settings.plan_mode {
        "plan".into()
    } else {
        "bypassPermissions".into()
    });
    if let Some(name) = worktree_name {
        args.push("--worktree".into());
        args.push(name.to_string());
    }

    // Carrying the conversation across a respawn. Every spawn-relevant setting is
    // in the fingerprint below, so changing one — plan mode, the model, the
    // effort — tears the child down and starts another. Without this the new
    // process begins blank while the transcript on screen says otherwise, and
    // the next message lands in a session that has never heard of it.
    //
    // The id stays out of the fingerprint on purpose: it names a conversation,
    // not a process shape, so it must never be the reason we respawn.
    if let Some(id) = resume_session_id {
        args.push("--resume".into());
        args.push(id.to_string());
    }

    // The chat's browser, on the same terms as --resume and for the same
    // reason: the URL names a conversation, not a process shape, so it must
    // never be what makes us respawn. Nyra serves it from a port that is up
    // before any of this, so it is live whether or not a browser ever is.
    let mut servers = serde_json::Map::new();
    if let Some((url, token)) = browser_mcp {
        servers.insert(
            "nyra-browser".into(),
            json!({ "type": "http", "url": url, "headers": { "x-nyra-token": token } }),
        );
    }
    if let Some((url, token)) = app_mcp {
        servers.insert(
            "nyra-app".into(),
            json!({ "type": "http", "url": url, "headers": { "x-nyra-token": token } }),
        );
    }
    if !servers.is_empty() {
        args.push("--mcp-config".into());
        args.push(json!({ "mcpServers": servers }).to_string());
    }

    let fingerprint = json!([
        cwd,
        settings.model,
        settings.effort,
        settings.allowed_tools,
        settings.plan_mode,
        settings.system_prompt,
        worktree_name
    ])
    .to_string();

    (args, fingerprint)
}

fn format_user_message(prompt: &str) -> String {
    format!(
        "{}\n",
        json!({ "type": "user", "message": { "role": "user", "content": prompt } })
    )
}

/// Send a prompt to a live session and hand back the receiver for its turn.
async fn send_prompt_to_session(
    sess: &Arc<Session>,
    prompt: &str,
) -> Result<oneshot::Receiver<Result<Option<String>, String>>, String> {
    let (tx, rx) = oneshot::channel();
    {
        let mut inner = sess.inner.lock();
        inner.pending_permissions.clear();
        inner.waiting_for_permission = false;
        inner.pending_event_buffer.clear();
        inner.current_turn = Some(tx);
        inner.turn_prompt = prompt.to_string();
    }

    let payload = format_user_message(prompt);
    let mut guard = sess.stdin.lock().await;
    let write = match guard.as_mut() {
        Some(stdin) => stdin
            .write_all(payload.as_bytes())
            .await
            .and(stdin.flush().await),
        None => Err(std::io::Error::other("stdin closed")),
    };

    if let Err(err) = write {
        let mut inner = sess.inner.lock();
        inner.current_turn = None;
        inner.alive = false;
        return Err(format!("Failed to send prompt: {err}"));
    }
    Ok(rx)
}

/// Write a user message into a turn that is already running, so the model reads
/// it at its next step instead of after the result. Answers whether it went in.
///
/// Deliberately not `send_prompt_to_session`: that function *owns* a turn. It
/// parks a oneshot in `current_turn` and clears the permission and event state,
/// so calling it twice in one turn would drop the first sender on the floor —
/// its `run_claude` would never resolve — and reset bookkeeping mid-flight.
/// Steering writes the line and touches nothing else.
///
/// No turn in flight means there is nothing to steer: the CLI would open a fresh
/// turn nobody is listening for, while the UI still believes it is idle. Say so
/// and let the caller leave the message queued.
pub async fn steer_session(nyra_session_id: &str, prompt: &str) -> bool {
    let Some(sess) = get_session(nyra_session_id) else {
        return false;
    };
    {
        let inner = sess.inner.lock();
        if !inner.alive || inner.current_turn.is_none() {
            return false;
        }
    }

    let payload = format_user_message(prompt);
    let mut guard = sess.stdin.lock().await;
    let Some(stdin) = guard.as_mut() else {
        return false;
    };
    let wrote = stdin
        .write_all(payload.as_bytes())
        .await
        .and(stdin.flush().await);
    if let Err(err) = wrote {
        crate::logf!(
            "Steer failed for [{}]: {err}",
            util::short(nyra_session_id)
        );
        return false;
    }
    true
}

pub async fn run_claude(
    prompt: String,
    cwd: String,
    resume_session_id: Option<String>,
    nyra_session_id: String,
    settings: SpawnSettings,
    worktree_name: Option<String>,
) -> Result<Option<String>, String> {
    if prompt.trim().is_empty() {
        fail_result_callback(&nyra_session_id, "Empty prompt");
        return Err("Empty prompt".into());
    }

    let (_, fingerprint) =
        build_spawn_args(&cwd, &settings, worktree_name.as_deref(), None, None);

    // Reuse the live process when nothing spawn-relevant changed; otherwise tear
    // down and start fresh.
    let existing = get_session(&nyra_session_id);
    let reusable = existing.as_ref().is_some_and(|s| {
        let inner = s.inner.lock();
        inner.alive && inner.spawn_fingerprint == fingerprint
    });

    let sess = if reusable {
        existing.unwrap()
    } else {
        if existing.is_some() {
            dispose_session(&nyra_session_id);
        }
        match spawn_session(
            &cwd,
            resume_session_id,
            &nyra_session_id,
            &settings,
            worktree_name.as_deref(),
            fingerprint,
        )
        .await
        {
            Ok(sess) => sess,
            Err(e) => {
                fail_result_callback(&nyra_session_id, &e);
                return Err(e);
            }
        }
    };

    sess.inner.lock().refresh_runtime_settings(&settings);

    let rx = match send_prompt_to_session(&sess, &prompt).await {
        Ok(rx) => rx,
        Err(e) => {
            fail_result_callback(&nyra_session_id, &e);
            return Err(e);
        }
    };
    match rx.await {
        Ok(result) => result,
        Err(_) => Err("Claude session closed".into()),
    }
}

async fn spawn_session(
    cwd: &str,
    resume_session_id: Option<String>,
    nyra_session_id: &str,
    settings: &SpawnSettings,
    worktree_name: Option<&str>,
    fingerprint: String,
) -> Result<Arc<Session>, String> {
    let claude_bin = resolve_claude_binary(&settings.claude_binary_path);
    let (args, _) = build_spawn_args(
        cwd,
        settings,
        worktree_name,
        resume_session_id.as_deref(),
        Some(nyra_session_id),
    );

    crate::logf!(
        "Spawning Claude [{}]: {claude_bin} {}",
        util::short(nyra_session_id),
        args.join(" ")
    );
    crate::logf!("CWD: {cwd}");

    let mut child = Command::new(&claude_bin)
        .args(&args)
        .current_dir(cwd)
        .env_clear()
        .envs(util::clean_child_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false)
        .spawn()
        .map_err(|e| format!("Failed to spawn {claude_bin}: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let pid = child.id();

    let sess = Arc::new(Session {
        inner: Mutex::new(SessionInner {
            alive: true,
            pid,
            cwd: cwd.to_string(),
            worktree_name: worktree_name.map(str::to_string),
            spawn_fingerprint: fingerprint,
            resume_session_id,
            settings: settings.clone(),
            pending_permissions: VecDeque::new(),
            waiting_for_permission: false,
            pending_event_buffer: Vec::new(),
            current_turn: None,
            turn_prompt: String::new(),
            line_buffer: String::new(),
            stale_resume_detected: false,
            retry_in_flight: false,
            plan_writes: HashMap::new(),
        }),
        stdin: AsyncMutex::new(Some(stdin)),
    });

    SESSIONS
        .lock()
        .insert(nyra_session_id.to_string(), sess.clone());
    processes::attach_claude_pid(nyra_session_id, pid);

    // stderr: logged, and watched for the one line that says our `--resume` names
    // a conversation the CLI has never heard of. It arrives here rather than on
    // stdout, so the retry has to be armed from this task — and because the two
    // are separate tasks it may lose the race with the result event, which is why
    // `stale_resume` below does not rely on it alone.
    {
        let session_id = nyra_session_id.to_string();
        let sess = sess.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let text = line.trim();
                if text.is_empty() {
                    continue;
                }
                crate::logf!("stderr [{}]: {}", util::short(&session_id), clip(text, 400));
                if text.contains(STALE_RESUME_MARKER) {
                    let mut inner = sess.inner.lock();
                    if inner.resume_session_id.is_some() {
                        inner.stale_resume_detected = true;
                    }
                }
            }
        });
    }

    // stdout: the stream-json event loop, then the exit handler.
    {
        let session_id = nyra_session_id.to_string();
        let sess = sess.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let mut chunk = vec![0u8; 16 * 1024];
            loop {
                use tokio::io::AsyncReadExt;
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let text = String::from_utf8_lossy(&chunk[..n]).to_string();
                        consume_stdout(&sess, &session_id, &text).await;
                    }
                }
            }
            let exit_code = child.wait().await.ok().and_then(|s| s.code());
            on_child_exit(&sess, &session_id, exit_code).await;
        });
    }

    Ok(sess)
}

/// Split a stdout chunk into whole JSON lines and dispatch each one.
async fn consume_stdout(sess: &Arc<Session>, nyra_session_id: &str, data: &str) {
    let lines: Vec<String> = {
        let mut inner = sess.inner.lock();
        inner.line_buffer.push_str(&strip_ansi(data));

        if inner.line_buffer.len() > MAX_LINE_BUFFER {
            crate::logf!("Line buffer exceeded {MAX_LINE_BUFFER} bytes, truncating");
            let keep = MAX_LINE_BUFFER / 2;
            let start = inner.line_buffer.len() - keep;
            // Never split a UTF-8 code point.
            let start = (start..inner.line_buffer.len())
                .find(|i| inner.line_buffer.is_char_boundary(*i))
                .unwrap_or(inner.line_buffer.len());
            inner.line_buffer = inner.line_buffer[start..].to_string();
        }

        let mut parts: Vec<String> = inner.line_buffer.split('\n').map(str::to_string).collect();
        inner.line_buffer = parts.pop().unwrap_or_default();
        parts
    };

    for line in lines {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(raw) => {
                if dispatch_line(sess, nyra_session_id, raw).await {
                    return; // session was torn down mid-chunk (stale-resume retry)
                }
            }
            Err(_) => {
                crate::logf!("Non-JSON line: {}", clip(trimmed, 120));
                let mut inner = sess.inner.lock();
                if inner.resume_session_id.is_some() && trimmed.contains(STALE_RESUME_MARKER) {
                    inner.stale_resume_detected = true;
                }
            }
        }
    }
}

/// What the CLI prints when `--resume` names a conversation it does not have.
const STALE_RESUME_MARKER: &str = "No conversation found with session ID";

/// Whether a failed turn is a `--resume` that missed, and so worth replaying
/// without one.
///
/// The marker itself lands on stderr while this decision is made from stdout, so
/// waiting for it would be a race. A resumed turn that failed without completing
/// a single turn is the same thing said on the channel we are already reading.
/// Over-reading it costs one extra spawn, because the replay carries no resume id
/// and so can never ask for a second.
fn stale_resume(resuming: bool, marker_seen: bool, is_error: bool, num_turns: Option<u64>) -> bool {
    resuming && is_error && (marker_seen || num_turns == Some(0))
}

/// Returns true when the caller should stop feeding this session lines.
async fn dispatch_line(sess: &Arc<Session>, nyra_session_id: &str, raw: Value) -> bool {
    let event_type = raw.get("type").and_then(Value::as_str).unwrap_or_default();
    crate::logf!(
        "Event [{}]: {}",
        util::short(nyra_session_id),
        clip(&raw.to_string(), 600)
    );

    // The CLI writes the title it generates into the transcript rather than onto
    // stdout, so every line is worth this much: which file to go and read.
    if let Some(claude_session_id) = raw.get("session_id").and_then(Value::as_str) {
        let cwd = sess.inner.lock().cwd.clone();
        crate::ai_title::observe(nyra_session_id, &cwd, claude_session_id);
    }

    if event_type == "result" {
        let is_error = raw.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        let should_retry = {
            let inner = sess.inner.lock();
            stale_resume(
                inner.resume_session_id.is_some(),
                inner.stale_resume_detected,
                is_error,
                raw.get("num_turns").and_then(Value::as_u64),
            )
        };
        if should_retry {
            retry_without_resume(sess, nyra_session_id);
            return true;
        }
        let turn = {
            let mut inner = sess.inner.lock();
            // The first result clears the resume — later turns continue the live process.
            inner.resume_session_id = None;
            inner.stale_resume_detected = false;
            inner.current_turn.take()
        };
        if let Some(turn) = turn {
            let session_id = raw
                .get("session_id")
                .and_then(Value::as_str)
                .map(str::to_string);
            let _ = turn.send(Ok(session_id));
        }
        crate::ai_title::turn_ended(nyra_session_id);
    }

    if event_type == "assistant" {
        if let Some(usage) = raw
            .get("message")
            .and_then(|m| m.get("usage"))
            .and_then(Value::as_object)
        {
            let num = |k: &str| usage.get(k).and_then(Value::as_i64).unwrap_or(0);
            let normalized = Usage {
                input_tokens: num("input_tokens"),
                output_tokens: num("output_tokens"),
                cache_creation_input_tokens: num("cache_creation_input_tokens"),
                cache_read_input_tokens: num("cache_read_input_tokens"),
            };
            emit_event(
                nyra_session_id,
                json!({
                    "type": "usage",
                    "input_tokens": normalized.input_tokens,
                    "output_tokens": normalized.output_tokens,
                    "cache_creation_input_tokens": normalized.cache_creation_input_tokens,
                    "cache_read_input_tokens": normalized.cache_read_input_tokens,
                }),
            );
            let cb = USAGE_CALLBACKS.lock().get(nyra_session_id).cloned();
            if let Some(cb) = cb {
                cb(normalized);
            }
        }
    }

    // A subagent's own messages, on the same stdout as the parent's and told
    // apart only by this field. Nothing read it, so a foreground subagent's
    // thinking and tool calls landed in the transcript as if the parent had said
    // them — while its own row in the summary stayed empty.
    //
    // Deliberately below the usage roll-up: a subagent's tokens are the
    // session's tokens, and the meter should say so.
    if let Some(parent) = raw
        .get("parent_tool_use_id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        subagents::note_inline(nyra_session_id, parent, &raw);
        return false;
    }

    if event_type == "rate_limit_event" {
        if let Some(info) = raw.get("rate_limit_info") {
            // `unifiedWindows` is where the numbers live — every window the
            // account has, each with its own reset and a 0..1 utilization.
            // Only the top-level status and reset used to be forwarded, so the
            // app could say when the limit lifts and never how much of it was
            // spent. The block is passed through whole rather than picked
            // apart: the CLI has added windows before and will again.
            emit_event(
                nyra_session_id,
                json!({
                    "type": "rate_limit",
                    "status": info.get("status").and_then(Value::as_str).unwrap_or("unknown"),
                    "resetsAt": info.get("resetsAt").and_then(Value::as_i64).unwrap_or(0),
                    "rateLimitType": info.get("rateLimitType").and_then(Value::as_str).unwrap_or("five_hour"),
                    "windows": info.get("unifiedWindows").cloned().unwrap_or(Value::Null),
                }),
            );
        }
    }

    if event_type == "assistant" {
        if let Some(content) = raw
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
        {
            if let Some(thinking) = content
                .iter()
                .find(|b| b.get("type").and_then(Value::as_str) == Some("thinking"))
            {
                emit_event(
                    nyra_session_id,
                    json!({
                        "type": "thinking",
                        "thinking": thinking.get("thinking").cloned().unwrap_or(Value::String(String::new())),
                    }),
                );
            }
        }
    }

    let waiting = sess.inner.lock().waiting_for_permission;
    if event_type == "assistant" && !waiting {
        let tool_blocks: Vec<Value> = raw
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
            .map(|c| {
                c.iter()
                    .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();

        if !tool_blocks.is_empty() {
            let should_skip = process_tool_blocks(sess, nyra_session_id, &tool_blocks).await;
            if !should_skip {
                let waiting = sess.inner.lock().waiting_for_permission;
                if waiting {
                    buffer_event(sess, raw);
                } else {
                    handle_event(&raw, nyra_session_id);
                }
            }
            return false;
        }
    }

    let (retrying, waiting) = {
        let inner = sess.inner.lock();
        (inner.retry_in_flight, inner.waiting_for_permission)
    };
    if retrying {
        return false;
    }
    if waiting {
        buffer_event(sess, raw);
    } else {
        handle_event(&raw, nyra_session_id);
    }
    false
}

fn buffer_event(sess: &Arc<Session>, raw: Value) {
    let mut inner = sess.inner.lock();
    if inner.pending_event_buffer.len() < MAX_EVENT_BUFFER {
        inner.pending_event_buffer.push(raw);
    }
}

/// Does this tool call need to stop and ask the user?
///
/// The backend owns this decision now. It used to prompt for every gated tool and
/// let the renderer auto-approve, which meant a fully auto-approved tool still
/// raised the gate, fired an OS notification, and cost a round trip before it
/// could run — a notification whose "Show" button opened an app with no dialog in
/// it, because the renderer had already answered.
///
/// `skip_permissions` and `auto_approve_tools` come from the session's own
/// snapshot, refreshed at the top of every turn by `refresh_runtime_settings`.
/// They used to be read from the process-global so that "always allow" took
/// effect mid-session; refreshing per turn keeps that while letting two projects
/// hold different answers.
fn requires_prompt(
    tool_name: &str,
    input: &Value,
    skip_permissions: bool,
    auto_approve: &[String],
) -> bool {
    if !PERMISSION_REQUIRED.contains(&tool_name) || skip_permissions {
        return false;
    }
    // Plan and memory files are plan mode's and memory's own plumbing, not a
    // change to the user's project. The CLI does not ask before writing either,
    // and a plan is approved as a whole on the card — prompting here asked twice
    // for one decision, the first time about a file the user never chose to
    // touch, and for a memory it asked about a file that is not theirs at all.
    if is_claude_owned_file(input) {
        return false;
    }
    !auto_approve.iter().any(|t| t == tool_name)
}

/// A path under Claude's own `plans` directory, whoever's home it lives in.
fn plan_file_path(input: &Value) -> Option<&str> {
    let path = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)?;
    path.contains("/.claude/plans/").then_some(path)
}

/// Claude's own bookkeeping, as opposed to the user's project.
///
/// Deliberately narrower than "anywhere under `.claude`": agent definitions,
/// settings and hooks all live there too, and a write to one of those is a
/// change the user should see coming. Plans and memories are Claude keeping its
/// own notes, which the CLI does not ask about either.
fn is_claude_owned_file(input: &Value) -> bool {
    let Some(path) = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
    else {
        return false;
    };
    path.contains("/.claude/plans/")
        || (path.contains("/.claude/projects/") && path.contains("/memory/"))
}

/// Turn a finished write into `.claude/plans/` into a plan the renderer can show.
///
/// Read from disk rather than from the tool input: a plan is as often edited as
/// written whole, and only the file has the complete text either way. A write
/// that failed leaves nothing to read, which is also the answer.
fn emit_plan_ready(nyra_session_id: &str, tool_id: &str) {
    let Some(path) = get_session(nyra_session_id)
        .and_then(|sess| sess.inner.lock().plan_writes.remove(tool_id))
    else {
        return;
    };
    match std::fs::read_to_string(&path) {
        Ok(plan) if !plan.trim().is_empty() => emit_event(
            nyra_session_id,
            json!({ "type": "plan_ready", "tool_id": tool_id, "path": path, "plan": plan }),
        ),
        Ok(_) => crate::logf!("Plan file {path} is empty — nothing to show"),
        Err(e) => crate::logf!("Plan file {path} could not be read: {e}"),
    }
}

/// Announce the tool calls in an assistant message, gating any that need approval.
///
/// Returns true when the stream is now parked waiting on the user.
async fn process_tool_blocks(
    sess: &Arc<Session>,
    nyra_session_id: &str,
    tool_blocks: &[Value],
) -> bool {
    let (skip_permissions, auto_approve, plan_mode) = {
        let inner = sess.inner.lock();
        (
            inner.settings.skip_permissions,
            inner.settings.auto_approve_tools.clone(),
            inner.settings.plan_mode,
        )
    };

    // Capture original file contents up front regardless of which path a block
    // takes — a revert needs them whether the edit was approved or auto-approved.
    let mut prompts: Vec<PendingPermission> = Vec::new();
    let mut immediate: Vec<PendingPermission> = Vec::new();
    let mut plan_writes: Vec<(String, String)> = Vec::new();
    for block in tool_blocks {
        let tool_name = block.get("name").and_then(Value::as_str).unwrap_or_default();
        let input = block.get("input").cloned().unwrap_or(json!({}));
        let info = PendingPermission {
            tool_id: block.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            tool_name: tool_name.to_string(),
            input: input.clone(),
            original_content: capture_original_content(tool_name, &input).await,
        };
        // Headless Claude has no ExitPlanMode — see `build_spawn_args`. What it
        // does instead is write the plan to `.claude/plans/`, so that write is
        // the signal a plan is ready. Only while planning: the same path gets
        // written during ordinary work too, and that is not a plan to approve.
        if plan_mode {
            if let Some(path) = plan_file_path(&input) {
                plan_writes.push((info.tool_id.clone(), path.to_string()));
            }
        }
        if requires_prompt(tool_name, &input, skip_permissions, &auto_approve) {
            prompts.push(info);
        } else {
            immediate.push(info);
        }
    }

    if !plan_writes.is_empty() {
        let mut inner = sess.inner.lock();
        inner.plan_writes.extend(plan_writes);
    }

    let announce = |info: &PendingPermission| {
        emit_event(
            nyra_session_id,
            json!({ "type": "tool_start", "tool_id": info.tool_id, "tool_name": info.tool_name }),
        );
        let mut ev = json!({
            "type": "tool_input",
            "tool_id": info.tool_id,
            "tool_name": info.tool_name,
            "input": info.input,
        });
        if let (Value::Object(map), Some(original)) = (&mut ev, &info.original_content) {
            map.insert("originalContent".into(), Value::String(original.clone()));
        }
        emit_event(nyra_session_id, ev);
        processes::note_tool_input(nyra_session_id, &info.tool_id, &info.tool_name, &info.input);
    };

    // Nothing to ask about — let the whole batch through without raising the gate.
    if prompts.is_empty() {
        for info in &immediate {
            announce(info);
        }
        return false;
    }

    // Arm before publishing: a prompt visible to the renderer before the gate is
    // up can be answered against a gate that does not exist yet.
    sess.inner.lock().arm_permission_gate(prompts.clone());

    for info in &immediate {
        announce(info);
    }
    for info in prompts {
        let mut payload = info.to_json();
        if let Value::Object(map) = &mut payload {
            map.insert(
                "nyraSessionId".into(),
                Value::String(nyra_session_id.to_string()),
            );
        }
        util::emit("claude:permission", payload);
        notify(
            "Permission Needed",
            &format!("Claude wants to use {}", info.tool_name),
        );
    }

    true
}

/// A `--resume` pointing at a session Claude no longer has. Kill, respawn without
/// it, and replay the prompt so the user never sees the failure.
fn retry_without_resume(sess: &Arc<Session>, nyra_session_id: &str) {
    let (saved_turn, prompt, cwd, worktree, settings) = {
        let mut inner = sess.inner.lock();
        if inner.retry_in_flight {
            return;
        }
        inner.retry_in_flight = true;
        (
            inner.current_turn.take(),
            inner.turn_prompt.clone(),
            inner.cwd.clone(),
            inner.worktree_name.clone(),
            inner.settings.clone(),
        )
    };

    crate::logf!(
        "Stale resume detected for [{}] — retrying without --resume",
        util::short(nyra_session_id)
    );

    kill_session_pty(sess);
    SESSIONS.lock().remove(nyra_session_id);
    USAGE_CALLBACKS.lock().remove(nyra_session_id);
    emit_event(
        nyra_session_id,
        json!({ "type": "session_reset", "reason": "stale_resume" }),
    );

    if let Some(turn) = saved_turn {
        let session_id = nyra_session_id.to_string();
        tauri::async_runtime::spawn(async move {
            let result = run_claude(prompt, cwd, None, session_id, settings, worktree).await;
            let _ = turn.send(result);
        });
    }
}

async fn on_child_exit(sess: &Arc<Session>, nyra_session_id: &str, exit_code: Option<i32>) {
    crate::logf!(
        "Claude [{}] exited with code: {exit_code:?}",
        util::short(nyra_session_id)
    );

    let leftover = {
        let mut inner = sess.inner.lock();
        inner.alive = false;
        if inner.retry_in_flight {
            return;
        }
        std::mem::take(&mut inner.line_buffer)
    };

    if !leftover.trim().is_empty() {
        match serde_json::from_str::<Value>(leftover.trim()) {
            Ok(raw) => {
                if raw.get("type").and_then(Value::as_str) == Some("result") {
                    let is_error = raw.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    let should_retry = {
                        let inner = sess.inner.lock();
                        inner.resume_session_id.is_some() && inner.stale_resume_detected && is_error
                    };
                    if should_retry {
                        retry_without_resume(sess, nyra_session_id);
                        return;
                    }
                    let turn = sess.inner.lock().current_turn.take();
                    if let Some(turn) = turn {
                        let _ = turn.send(Ok(raw
                            .get("session_id")
                            .and_then(Value::as_str)
                            .map(str::to_string)));
                    }
                }
                let waiting = sess.inner.lock().waiting_for_permission;
                if waiting {
                    buffer_event(sess, raw);
                } else if !sess.inner.lock().retry_in_flight {
                    handle_event(&raw, nyra_session_id);
                }
            }
            Err(_) => {
                let mut inner = sess.inner.lock();
                if inner.resume_session_id.is_some()
                    && leftover.contains("No conversation found with session ID")
                {
                    inner.stale_resume_detected = true;
                }
            }
        }
    }

    let (stale, waiting, has_open_turn) = {
        let inner = sess.inner.lock();
        (
            inner.resume_session_id.is_some() && inner.stale_resume_detected,
            inner.waiting_for_permission,
            inner.current_turn.is_some(),
        )
    };

    if stale && exit_code != Some(0) && has_open_turn {
        retry_without_resume(sess, nyra_session_id);
        return;
    }

    if waiting {
        crate::logf!("Process exited while waiting for permission — session kept alive for user response");
        return;
    }

    let turn = sess.inner.lock().current_turn.take();
    if let Some(turn) = turn {
        let err_msg = format!("Claude exited with code {}", exit_code.unwrap_or(-1));
        emit_event(nyra_session_id, json!({ "type": "error", "result": err_msg }));
        emit_event(nyra_session_id, json!({ "type": "stream_end" }));
        fail_result_callback(nyra_session_id, &err_msg);
        let _ = turn.send(Err(err_msg));
    }

    SESSIONS.lock().remove(nyra_session_id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approved(tools: &[&str]) -> Vec<String> {
        tools.iter().map(|t| t.to_string()).collect()
    }

    #[test]
    fn a_synthetic_goal_acknowledgement_is_a_goal() {
        assert_eq!(
            goal_condition(true, "Goal set: every test in this repo passes"),
            Some("every test in this repo passes".to_string())
        );
    }

    #[test]
    fn claudes_own_prose_is_never_a_goal() {
        // The model writing about a goal is ordinary text, however it starts.
        assert_eq!(goal_condition(false, "Goal set: every test passes"), None);
        assert_eq!(goal_condition(false, "Goal met: a.txt now says hello"), None);
    }

    #[test]
    fn the_other_synthetic_replies_stay_prose() {
        // `/goal` with no argument reports the current goal. That is an answer,
        // not a goal being set.
        assert_eq!(
            goal_condition(true, "No goal set. Usage: `/goal <condition>`"),
            None
        );
        assert_eq!(goal_condition(true, "Goal set:"), None);
        assert_eq!(goal_condition(true, "Goal set:    "), None);
    }

    #[test]
    fn ungated_tools_never_prompt() {
        assert!(!requires_prompt("Read", &json!({}), false, &[]));
        assert!(!requires_prompt("Grep", &json!({}), false, &[]));
    }

    #[test]
    fn gated_tools_prompt_by_default() {
        for tool in ["Bash", "Edit", "Write", "ExitPlanMode"] {
            assert!(requires_prompt(tool, &json!({}), false, &[]), "{tool} should prompt");
        }
    }

    #[test]
    fn skip_permissions_silences_everything() {
        assert!(!requires_prompt("Bash", &json!({}), true, &[]));
    }

    #[test]
    fn writing_the_plan_file_does_not_prompt() {
        // Plan mode writes its plan file through Write. The CLI never asks, and
        // the plan is approved at ExitPlanMode, so asking here made the user
        // approve a file they never chose to touch before seeing the plan.
        let plan = json!({ "file_path": "/Users/x/.claude/plans/some-plan.md" });
        assert!(!requires_prompt("Write", &plan, false, &[]));

        // A write anywhere else still prompts.
        let project = json!({ "file_path": "/Users/x/dev/app/src/main.rs" });
        assert!(requires_prompt("Write", &project, false, &[]));
    }

    #[test]
    fn an_auto_approved_tool_does_not_prompt() {
        // The regression: the backend used to prompt regardless, so an
        // auto-approved Bash still raised the gate and fired an OS notification
        // for a dialog the renderer had already dismissed.
        assert!(!requires_prompt("Bash", &json!({}), false, &approved(&["Bash"])));
        // Auto-approving one tool must not silence the others.
        assert!(requires_prompt("Edit", &json!({}), false, &approved(&["Bash"])));
    }

    #[test]
    fn auto_approval_matches_exactly() {
        assert!(requires_prompt("Bash", &json!({}), false, &approved(&["bash"])));
        assert!(requires_prompt("Bash", &json!({}), false, &approved(&["BashOutput"])));
    }

    fn prompt(tool: &str) -> PendingPermission {
        PendingPermission {
            tool_id: format!("id-{tool}"),
            tool_name: tool.into(),
            input: json!({}),
            original_content: None,
        }
    }

    #[test]
    fn arming_the_gate_queues_and_parks_together() {
        let mut inner = SessionInner::for_test();
        inner.arm_permission_gate(vec![prompt("Bash")]);
        // Both halves must land in one step — a prompt visible to the renderer
        // while the gate is still down is what stalled the stream.
        assert!(inner.waiting_for_permission);
        assert_eq!(inner.pending_permissions.len(), 1);
    }

    #[test]
    fn answering_the_last_prompt_lowers_the_gate_and_returns_the_backlog() {
        let mut inner = SessionInner::for_test();
        inner.arm_permission_gate(vec![prompt("Bash")]);
        inner.pending_event_buffer = vec![json!({"type": "assistant"})];

        assert!(inner.take_pending_permission().is_some());
        let state = inner.release_gate_if_drained();

        assert!(!inner.waiting_for_permission);
        match state {
            GateState::Cleared(buffered) => assert_eq!(buffered.len(), 1),
            other => panic!("expected the gate to clear, got {other:?}"),
        }
        assert!(inner.pending_event_buffer.is_empty(), "backlog handed over, not copied");
    }

    #[test]
    fn the_gate_stays_up_while_prompts_remain() {
        let mut inner = SessionInner::for_test();
        inner.arm_permission_gate(vec![prompt("Bash"), prompt("Edit")]);

        inner.take_pending_permission().unwrap();
        assert_eq!(inner.release_gate_if_drained(), GateState::StillWaiting);
        assert!(inner.waiting_for_permission);
    }

    #[test]
    fn a_gate_left_up_with_an_empty_queue_self_heals() {
        // The stall this fixes: an instant auto-approval answered a prompt before
        // the gate finished being raised, so the queue emptied and the flag was
        // then set with nothing left to clear it. Every later event was buffered
        // and the session went silent while the token counter kept climbing.
        let mut inner = SessionInner::for_test();
        inner.waiting_for_permission = true;
        inner.pending_event_buffer = vec![json!({"type": "assistant"}), json!({"type": "result"})];

        assert!(inner.take_pending_permission().is_none());
        let state = inner.release_gate_if_drained();

        assert!(!inner.waiting_for_permission, "must not stay parked forever");
        match state {
            GateState::Cleared(buffered) => assert_eq!(buffered.len(), 2, "backlog must be replayed"),
            other => panic!("expected the gate to clear, got {other:?}"),
        }
    }

    #[test]
    fn draining_a_multi_prompt_turn_clears_exactly_once() {
        let mut inner = SessionInner::for_test();
        inner.arm_permission_gate(vec![prompt("Bash"), prompt("Write"), prompt("Edit")]);

        let mut cleared = 0;
        while inner.take_pending_permission().is_some() {
            if matches!(inner.release_gate_if_drained(), GateState::Cleared(_)) {
                cleared += 1;
            }
        }
        assert_eq!(cleared, 1);
        assert!(!inner.waiting_for_permission);
    }

    #[test]
    fn detects_auth_errors() {
        assert!(is_auth_error("API Error: 401 Unauthorized"));
        assert!(is_auth_error("authentication_error"));
        assert!(is_auth_error("Invalid API key"));
        assert!(is_auth_error("invalid authentication provided"));
    }

    #[test]
    fn ignores_unrelated_errors() {
        assert!(!is_auth_error("ENOENT: no such file"));
        assert!(!is_auth_error("500 Internal Server Error"));
        assert!(!is_auth_error(""));
        // A bare 4010 must not trip the \b401\b word boundary.
        assert!(!is_auth_error("error code 4010"));
    }

    #[test]
    fn strips_ansi_and_carriage_returns() {
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m\r\n"), "red\n");
    }

    #[test]
    fn spawn_args_carry_model_and_permission_mode() {
        let s = SpawnSettings {
            model: "opus".into(),
            plan_mode: true,
            ..SpawnSettings::default()
        };
        let (args, fp) = build_spawn_args("/tmp/x", &s, None, None, None);
        assert!(args.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "plan"]));
        assert!(fp.contains("/tmp/x"));
    }

    #[test]
    fn a_resume_that_missed_is_replayed_without_one() {
        // The marker arrives on stderr, so the stdout side must decide without it.
        assert!(stale_resume(true, false, true, Some(0)));
        assert!(stale_resume(true, true, true, None));

        // A turn that actually ran and then failed is a real error, not a bad
        // resume — replaying it would repeat whatever went wrong.
        assert!(!stale_resume(true, false, true, Some(3)));
        // Nothing to retry when we never asked to resume, or nothing failed.
        assert!(!stale_resume(false, true, true, Some(0)));
        assert!(!stale_resume(true, true, false, Some(0)));
    }

    fn test_session(plan_mode: bool) -> Arc<Session> {
        let mut inner = SessionInner::for_test();
        inner.settings.plan_mode = plan_mode;
        Arc::new(Session {
            inner: Mutex::new(inner),
            stdin: AsyncMutex::new(None),
        })
    }

    #[tokio::test]
    async fn steering_needs_a_turn_already_running() {
        // Nothing here to steer into.
        assert!(!steer_session("never-spawned", "hello").await);

        let sess = test_session(false);
        SESSIONS.lock().insert("steer1".into(), sess.clone());

        // Alive but idle: the line would open a turn nobody is waiting on, so the
        // caller is told no and keeps the message queued.
        assert!(!steer_session("steer1", "hello").await);

        // A turn in flight, but the pipe is gone — still no.
        let (tx, _rx) = oneshot::channel();
        sess.inner.lock().current_turn = Some(tx);
        assert!(!steer_session("steer1", "hello").await);

        // Steering must not disturb the turn it writes into.
        assert!(sess.inner.lock().current_turn.is_some());
        assert!(sess.inner.lock().turn_prompt.is_empty());

        SESSIONS.lock().remove("steer1");
    }

    #[tokio::test]
    async fn a_plan_write_becomes_a_plan_ready() {
        let dir = std::env::temp_dir().join("nyra-plan-test/.claude/plans");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("p.md");
        std::fs::write(&path, "# A plan\n\nDo the thing.").unwrap();

        let sess = test_session(true);
        SESSIONS.lock().insert("s1".into(), sess.clone());

        let block = json!({
            "type": "tool_use",
            "id": "toolu_1",
            "name": "Write",
            "input": { "file_path": path.to_str().unwrap(), "content": "# A plan" }
        });
        process_tool_blocks(&sess, "s1", &[block]).await;

        assert_eq!(
            sess.inner.lock().plan_writes.get("toolu_1").map(String::as_str),
            Some(path.to_str().unwrap()),
            "the write should have been noted against its tool id"
        );

        // The result is what says the file is on disk; it also consumes the note.
        emit_plan_ready("s1", "toolu_1");
        assert!(sess.inner.lock().plan_writes.is_empty());
        SESSIONS.lock().remove("s1");
    }

    #[tokio::test]
    async fn a_plan_write_outside_plan_mode_is_just_a_write() {
        let sess = test_session(false);
        let block = json!({
            "type": "tool_use",
            "id": "toolu_2",
            "name": "Write",
            "input": { "file_path": "/tmp/x/.claude/plans/p.md", "content": "x" }
        });
        process_tool_blocks(&sess, "s2", &[block]).await;
        assert!(sess.inner.lock().plan_writes.is_empty());
    }

    #[test]
    fn claude_keeps_its_own_notes_without_asking() {
        let owned = |p: &str| is_claude_owned_file(&json!({ "file_path": p }));
        assert!(owned("/Users/x/.claude/plans/p.md"));
        assert!(owned("/Users/x/.claude/projects/-Users-x-repo/memory/a-fact.md"));
        assert!(owned("/Users/x/.claude/projects/-Users-x-repo/memory/MEMORY.md"));

        // Everything else under .claude is configuration the user owns, and a
        // write to it is a change they should be asked about.
        assert!(!owned("/Users/x/.claude/settings.json"));
        assert!(!owned("/Users/x/.claude/agents/reviewer.md"));
        assert!(!owned("/Users/x/.claude/CLAUDE.md"));
        // A project file that merely mentions memory is not memory.
        assert!(!owned("/repo/src/memory/store.ts"));
        assert!(!owned("/repo/plans/p.md"));
    }

    #[test]
    fn plan_paths_are_recognised_under_any_home() {
        let plan = json!({ "file_path": "/Users/someone/.claude/plans/x.md" });
        assert_eq!(
            plan_file_path(&plan),
            Some("/Users/someone/.claude/plans/x.md")
        );
        // `path` is the key some tools use instead of `file_path`.
        assert!(plan_file_path(&json!({ "path": "/home/u/.claude/plans/y.md" })).is_some());
        // Ordinary work is not a plan, and neither is a lookalike directory.
        assert!(plan_file_path(&json!({ "file_path": "/repo/src/main.rs" })).is_none());
        assert!(plan_file_path(&json!({ "file_path": "/repo/plans/z.md" })).is_none());
        assert!(plan_file_path(&json!({})).is_none());
    }

    #[test]
    fn resume_id_reaches_argv_but_never_the_fingerprint() {
        // A respawn mid-conversation has to carry the session, and must not be
        // *caused* by it — two spawns that differ only in resume id are the
        // same process shape and must reuse the live child.
        let s = SpawnSettings::default();
        let (args, fp) = build_spawn_args("/tmp/x", &s, None, Some("abc-123"), None);
        assert!(args.windows(2).any(|w| w == ["--resume", "abc-123"]));

        let (bare, bare_fp) = build_spawn_args("/tmp/x", &s, None, None, None);
        assert!(!bare.iter().any(|a| a == "--resume"));
        assert_eq!(fp, bare_fp);
    }

    #[test]
    fn fingerprint_ignores_prompt_but_tracks_worktree() {
        let s = SpawnSettings::default();
        let (_, a) = build_spawn_args("/tmp/x", &s, None, None, None);
        let (_, b) = build_spawn_args("/tmp/x", &s, Some("feat"), None, None);
        assert_ne!(a, b);
    }

    #[test]
    fn two_projects_asking_for_different_models_get_different_children() {
        // The whole point of carrying settings per call: same cwd, different
        // model must not reuse the live process.
        let a = SpawnSettings { model: "opus".into(), ..SpawnSettings::default() };
        let b = SpawnSettings { model: "haiku".into(), ..SpawnSettings::default() };
        let (_, fa) = build_spawn_args("/tmp/x", &a, None, None, None);
        let (_, fb) = build_spawn_args("/tmp/x", &b, None, None, None);
        assert_ne!(fa, fb);
    }

    #[test]
    fn refreshing_runtime_settings_leaves_the_spawn_identity_alone() {
        let mut inner = SessionInner::for_test();
        inner.settings.model = "opus".into();
        inner.settings.skip_permissions = false;

        inner.refresh_runtime_settings(&SpawnSettings {
            model: "haiku".into(),
            skip_permissions: true,
            auto_approve_tools: vec!["Bash".into()],
            ..SpawnSettings::default()
        });

        // Runtime gating follows the new turn...
        assert!(inner.settings.skip_permissions);
        assert_eq!(inner.settings.auto_approve_tools, vec!["Bash".to_string()]);
        // ...but the model the child was actually spawned with does not change
        // under it. A different model respawns via the fingerprint instead.
        assert_eq!(inner.settings.model, "opus");
    }

    #[test]
    fn a_turn_can_flip_auto_approve_without_respawning() {
        let mut inner = SessionInner::for_test();
        assert!(requires_prompt(
            "Bash",
            &json!({}),
            inner.settings.skip_permissions,
            &inner.settings.auto_approve_tools
        ));

        inner.refresh_runtime_settings(&SpawnSettings {
            auto_approve_tools: vec!["Bash".into()],
            ..SpawnSettings::default()
        });

        assert!(!requires_prompt(
            "Bash",
            &json!({}),
            inner.settings.skip_permissions,
            &inner.settings.auto_approve_tools
        ));
    }

    #[test]
    fn the_browser_is_only_taught_to_a_session_that_has_one() {
        let with = compose_system_prompt("/tmp/x", "", true, false);
        let without = compose_system_prompt("/tmp/x", "", false, false);

        assert!(with.contains("This conversation has a real browser"));
        // The failure that matters: a session with no browser tools must not be
        // told it has a browser, or it will invent calls that cannot work.
        assert!(!without.contains("real browser"));
        assert!(!without.contains("browser_snapshot"));

        // A tool name is the part that must never leak to a session that has no
        // tools. This suite stayed green through the whole viewport rewrite
        // without asserting anything about it, which is exactly the quiet rot
        // the conditional clause was split out to avoid.
        assert!(with.contains("browser_device"));
        assert!(!without.contains("browser_device"));
        // The viewport is no longer fixed, and saying so is the point: a model
        // told it is looking at a desktop layout will not think to check a
        // narrow one.
        assert!(with.contains("reflows as the user"));
        assert!(!with.contains("1280x800"));

        // Everything else is taught either way.
        for shared in [
            "```nyra-ask",
            "```nyra-tasks",
            "```nyra-changes",
            "![alt](/absolute/path.png)",
        ] {
            assert!(with.contains(shared), "{shared}");
            assert!(without.contains(shared), "{shared}");
        }
    }

    /// The same rule as the browser, and it earns its own test for the same
    /// reason: a session told it can drive Nyra when it cannot will call three
    /// tools that do not exist and report changes that never happened.
    #[test]
    fn the_app_tools_are_only_taught_to_a_session_that_has_them() {
        let with = compose_system_prompt("/tmp/x", "", false, true);
        let without = compose_system_prompt("/tmp/x", "", false, false);

        for name in ["nyra_ui", "nyra_flow", "nyra_update"] {
            assert!(with.contains(name), "{name} missing when attached");
            assert!(!without.contains(name), "{name} leaked to a session without them");
        }

        // The fact the whole thing exists to carry. A session that knew the flow
        // schema by heart still sent people to Flows → ⋯ → Import, because
        // nothing ever told it where the files were.
        assert!(with.contains("~/.nyra/workflows/"));
        assert!(!without.contains(".nyra"));

        // Look before you act, and say what you did: the two clauses that are
        // about this being a window someone is watching rather than a headless
        // scratchpad.
        assert!(with.contains("Look before you act"));
        assert!(with.contains("say what you changed"));
    }

    /// Measured, not estimated.
    ///
    /// Everything `compose_system_prompt` returns is carried by every request of
    /// every turn, so a convention that doubles is a bill the user pays forever
    /// without seeing it. The numbers print on `--nocapture`; the assertion is
    /// there so growth has to be a decision rather than a drift.
    #[test]
    fn the_app_convention_stays_inside_its_budget() {
        let base = compose_system_prompt("/tmp/x", "", false, false);
        let with_app = compose_system_prompt("/tmp/x", "", false, true);
        let with_both = compose_system_prompt("/tmp/x", "", true, true);

        let added = with_app.len() - base.len();
        // ~4 chars a token is close enough for a budget, and stable.
        println!("  base            {:>5} chars  ~{:>4} tokens", base.len(), base.len() / 4);
        println!("  + app tools     {:>5} chars  ~{:>4} tokens", added, added / 4);
        println!("  + both          {:>5} chars  ~{:>4} tokens", with_both.len(), with_both.len() / 4);

        assert!(
            added < 1200,
            "the app convention grew to {added} chars (~{} tokens)",
            added / 4
        );
    }

    /// The two halves are independent. Nothing reads well if turning the browser
    /// off silently takes the app tools with it.
    #[test]
    fn the_browser_and_the_app_are_taught_independently() {
        let app_only = compose_system_prompt("/tmp/x", "", false, true);
        let browser_only = compose_system_prompt("/tmp/x", "", true, false);

        assert!(app_only.contains("nyra_ui"));
        assert!(!app_only.contains("browser_device"));
        assert!(browser_only.contains("browser_device"));
        assert!(!browser_only.contains("nyra_ui"));
    }

    /// The gap a second agent caught while testing the card: `git diff --numstat`
    /// cannot see a file git has never been told about, so a turn that adds files
    /// would summarise none of them. The convention has to say so.
    #[test]
    fn the_changes_convention_covers_files_git_has_never_seen() {
        let composed = compose_system_prompt("/tmp/x", "", false, false);
        assert!(composed.contains("git diff --numstat"));
        assert!(composed.contains("git ls-files --others --exclude-standard"));
        assert!(composed.contains("base: <short sha>"));
    }

    #[test]
    fn the_users_own_prompt_comes_last() {
        let composed = compose_system_prompt("/tmp/x", "Always speak in haiku.", true, true);
        assert!(composed.ends_with("Always speak in haiku."));
        assert!(composed.contains("running inside Nyra"));
    }
}
