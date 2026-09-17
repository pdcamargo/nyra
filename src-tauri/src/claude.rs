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

use crate::notify_user::notify;
use crate::processes;
use crate::settings::SpawnSettings;
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

fn emit_event(nyra_session_id: &str, mut extra: Value) {
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
            Some("task_notification") => processes::note_task_notification(
                nyra_session_id,
                raw.get("tool_use_id").and_then(Value::as_str).unwrap_or_default(),
                raw.get("status").and_then(Value::as_str),
                raw.get("output_file").and_then(Value::as_str),
            ),
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

fn build_spawn_args(
    cwd: &str,
    settings: &SpawnSettings,
    worktree_name: Option<&str>,
) -> (Vec<String>, String) {
    // `--input-format stream-json` doesn't support `--resume` the way `--print`
    // does (it expects "deferred" sessions, which Nyra never creates). History
    // lives in Nyra's own store instead; each session gets a process that spans
    // turns but not app restarts.
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

    let nyra_system_prompt = [
        "You are running inside Nyra, a desktop GUI for Claude Code.",
        "Tool call results are NOT shown inline — they are hidden inside collapsible cards the user may not open.",
        "You MUST always include relevant output (file contents, command results, directory listings, etc.) directly in your text response.",
        "Never say \"here it is\" or \"see above\" without actually showing the content in your message.",
        &format!("The current working directory is: {cwd}. When the user says \"your directory\" or \"this directory\", they mean this path."),
    ]
    .join(" ");
    let full_system_prompt = if settings.system_prompt.is_empty() {
        nyra_system_prompt
    } else {
        format!("{nyra_system_prompt}\n\n{}", settings.system_prompt)
    };
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

    // The fingerprint deliberately excludes the resume id — resume only applies to
    // the first spawn after an app restart.
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

    let (_, fingerprint) = build_spawn_args(&cwd, &settings, worktree_name.as_deref());

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
    let (args, _) = build_spawn_args(cwd, settings, worktree_name);

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
        }),
        stdin: AsyncMutex::new(Some(stdin)),
    });

    SESSIONS
        .lock()
        .insert(nyra_session_id.to_string(), sess.clone());
    processes::attach_claude_pid(nyra_session_id, pid);

    // stderr: log only.
    {
        let session_id = nyra_session_id.to_string();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let text = line.trim();
                if !text.is_empty() {
                    crate::logf!("stderr [{}]: {}", util::short(&session_id), clip(text, 400));
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
                if inner.resume_session_id.is_some()
                    && trimmed.contains("No conversation found with session ID")
                {
                    inner.stale_resume_detected = true;
                }
            }
        }
    }
}

/// Returns true when the caller should stop feeding this session lines.
async fn dispatch_line(sess: &Arc<Session>, nyra_session_id: &str, raw: Value) -> bool {
    let event_type = raw.get("type").and_then(Value::as_str).unwrap_or_default();
    crate::logf!(
        "Event [{}]: {}",
        util::short(nyra_session_id),
        clip(&raw.to_string(), 200)
    );

    if event_type == "result" {
        let is_error = raw.get("is_error").and_then(Value::as_bool).unwrap_or(false);
        let should_retry = {
            let inner = sess.inner.lock();
            inner.resume_session_id.is_some() && inner.stale_resume_detected && is_error
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

    if event_type == "rate_limit_event" {
        if let Some(info) = raw.get("rate_limit_info") {
            emit_event(
                nyra_session_id,
                json!({
                    "type": "rate_limit",
                    "status": info.get("status").and_then(Value::as_str).unwrap_or("unknown"),
                    "resetsAt": info.get("resetsAt").and_then(Value::as_i64).unwrap_or(0),
                    "rateLimitType": info.get("rateLimitType").and_then(Value::as_str).unwrap_or("five_hour"),
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
    // Writing the plan file is plan mode's own plumbing, not a change to the
    // user's project. The CLI does not ask before writing it, and the plan is
    // approved as a whole at ExitPlanMode — prompting here asked twice for one
    // decision, the first time about a file the user never chose to touch.
    if is_plan_file(input) {
        return false;
    }
    !auto_approve.iter().any(|t| t == tool_name)
}

/// A path under Claude's own `plans` directory, whoever's home it lives in.
fn is_plan_file(input: &Value) -> bool {
    let path = input
        .get("file_path")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    path.contains("/.claude/plans/")
}

/// Announce the tool calls in an assistant message, gating any that need approval.
///
/// Returns true when the stream is now parked waiting on the user.
async fn process_tool_blocks(
    sess: &Arc<Session>,
    nyra_session_id: &str,
    tool_blocks: &[Value],
) -> bool {
    let (skip_permissions, auto_approve) = {
        let inner = sess.inner.lock();
        (
            inner.settings.skip_permissions,
            inner.settings.auto_approve_tools.clone(),
        )
    };

    // Capture original file contents up front regardless of which path a block
    // takes — a revert needs them whether the edit was approved or auto-approved.
    let mut prompts: Vec<PendingPermission> = Vec::new();
    let mut immediate: Vec<PendingPermission> = Vec::new();
    for block in tool_blocks {
        let tool_name = block.get("name").and_then(Value::as_str).unwrap_or_default();
        let input = block.get("input").cloned().unwrap_or(json!({}));
        let info = PendingPermission {
            tool_id: block.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            tool_name: tool_name.to_string(),
            input: input.clone(),
            original_content: capture_original_content(tool_name, &input).await,
        };
        if requires_prompt(tool_name, &input, skip_permissions, &auto_approve) {
            prompts.push(info);
        } else {
            immediate.push(info);
        }
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
        let (args, fp) = build_spawn_args("/tmp/x", &s, None);
        assert!(args.windows(2).any(|w| w == ["--model", "opus"]));
        assert!(args.windows(2).any(|w| w == ["--permission-mode", "plan"]));
        assert!(fp.contains("/tmp/x"));
    }

    #[test]
    fn fingerprint_ignores_prompt_but_tracks_worktree() {
        let s = SpawnSettings::default();
        let (_, a) = build_spawn_args("/tmp/x", &s, None);
        let (_, b) = build_spawn_args("/tmp/x", &s, Some("feat"));
        assert_ne!(a, b);
    }

    #[test]
    fn two_projects_asking_for_different_models_get_different_children() {
        // The whole point of carrying settings per call: same cwd, different
        // model must not reuse the live process.
        let a = SpawnSettings { model: "opus".into(), ..SpawnSettings::default() };
        let b = SpawnSettings { model: "haiku".into(), ..SpawnSettings::default() };
        let (_, fa) = build_spawn_args("/tmp/x", &a, None);
        let (_, fb) = build_spawn_args("/tmp/x", &b, None);
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
}
