//! Codex CLI as one of Nyra's agent backends, over `codex app-server`.
//!
//! One server process per `CODEX_HOME`, shared by every chat that runs under
//! it, and one thread per chat. Sharing matters: ChatGPT refresh tokens rotate,
//! and two processes refreshing the same login log each other out.
//!
//! Nyra asks, Codex does not sandbox — the arrangement Nyra already has with
//! Claude. Every command and patch arrives as an approval request before it
//! runs, and goes to the same permission dialog. On Windows Codex's own sandbox
//! is not an option anyway: under `workspace-write` with a large workspace root
//! (a chat in `~`) it hangs without a word.

mod binary;
mod rpc;
mod side;
mod translate;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use self::rpc::{Incoming, Server};
use self::translate::{Out, TurnStatus, Translator};
use super::{emit_event, fail_before_turn, AgentBackend, Prewarm, Provider, SideAsk, Turn};
use crate::environment::Environment;
use crate::settings::SpawnSettings;
use crate::util;

pub struct Codex;

type TurnSender = oneshot::Sender<Result<Option<String>, String>>;

struct Chat {
    server: Arc<Server>,
    thread_id: String,
    /// What the thread was opened with that only an open can change: the
    /// instructions and the MCP servers. A turn can change the rest.
    fingerprint: String,
    turn_id: Option<String>,
    done: Option<TurnSender>,
    /// Stop pressed before `turn/start` had answered with the turn's id.
    abort_requested: bool,
    skip_permissions: bool,
    /// Approval requests waiting on the dialog, oldest first, by request id.
    approvals: VecDeque<(Value, translate::ApprovalKind)>,
    /// Turns ended to make way for a newer message; whatever they still send
    /// is dropped rather than read as the new turn's.
    replaced_turns: Vec<String>,
    translator: Translator,
}

/// Running servers, by the `CODEX_HOME` they run under.
static SERVERS: Lazy<Mutex<HashMap<Option<PathBuf>, Arc<Server>>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// Held while a server starts, so two chats opening at once share one.
static STARTING: Lazy<AsyncMutex<()>> = Lazy::new(|| AsyncMutex::new(()));
static CHATS: Lazy<Mutex<HashMap<String, Chat>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// Codex thread id to Nyra chat id, for routing what the server sends.
static THREADS: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// A subagent's thread to the chat that started it. Only its approvals go
/// there: what it says is its own, and would read as the parent's.
static CHILDREN: Lazy<Mutex<HashMap<String, String>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static STEERS: AtomicU64 = AtomicU64::new(0);

/// The `CODEX_HOME` a workspace's chats run under, from the config dir that
/// names its Claude account: a workspace's own `.codex`, or None for Default,
/// which is the CLI's own `~/.codex`.
pub(super) fn home_for(config_dir: Option<&str>) -> Option<PathBuf> {
    crate::workspaces::codex_home_for(config_dir)
}

pub(super) async fn server_for(home: Option<PathBuf>) -> Result<Arc<Server>, String> {
    let _starting = STARTING.lock().await;
    if let Some(server) = SERVERS.lock().get(&home).cloned() {
        return Ok(server);
    }
    // Codex will not start under a home that is not there yet: a workspace's is
    // made the first time anything there needs Codex.
    if let Some(home) = &home {
        std::fs::create_dir_all(home).map_err(|e| format!("Could not make {}: {e}", home.display()))?;
    }
    let install = tokio::task::spawn_blocking(binary::cached)
        .await
        .map_err(|e| format!("Could not look for Codex: {e}"))??;
    let server = Server::spawn(&install.path, home.clone(), Arc::new(on_message)).await?;
    SERVERS.lock().insert(home, server.clone());
    Ok(server)
}

fn chat_of(params: &Value) -> Option<String> {
    let thread = params.get("threadId").and_then(Value::as_str)?;
    THREADS.lock().get(thread).cloned()
}

fn thread_id_of(chat_id: &str) -> Option<String> {
    CHATS.lock().get(chat_id).map(|c| c.thread_id.clone())
}

fn read_file(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

// ---- what the server says ----

fn on_message(server: &Arc<Server>, incoming: Incoming) {
    match incoming {
        Incoming::Notification { method, params } => on_notification(server, &method, &params),
        Incoming::Request { id, method, params } => {
            let server = server.clone();
            tauri::async_runtime::spawn(async move { on_request(server, id, method, params).await });
        }
        Incoming::Exited { reason } => on_exit(server, &reason),
    }
}

fn on_notification(server: &Arc<Server>, method: &str, params: &Value) {
    // A sign-in this server started, finished in the browser.
    if method == "account/login/completed" {
        util::emit("codex:login", params.clone());
        return;
    }
    // The account's, not a thread's: every chat on this server is that account.
    if method == "account/rateLimits/updated" {
        if let Some(event) = params.get("rateLimits").and_then(translate::rate_limit_event) {
            let chats: Vec<String> = CHATS.lock().iter().filter(|(_, c)| Arc::ptr_eq(&c.server, server)).map(|(id, _)| id.clone()).collect();
            for chat_id in chats {
                emit_event(&chat_id, event.clone());
            }
        }
        return;
    }
    if let Some(side_id) = side::side_of(params) {
        side::on_notification(&side_id, method, params);
        return;
    }
    let child = params.get("threadId").and_then(Value::as_str).and_then(|t| CHILDREN.lock().get(t).cloned());
    if let Some(parent) = child {
        // A subagent's patch, held by the parent so its approval can show the
        // diff. Nothing else of the child's is the parent's to show.
        let kind = params.pointer("/item/type").and_then(Value::as_str);
        let thread = params.get("threadId").and_then(Value::as_str).unwrap_or_default();
        if let Some(chat) = CHATS.lock().get_mut(&parent) {
            match (method, kind) {
                ("item/started", Some("fileChange")) => {
                    chat.translator.notification(method, params, &read_file);
                }
                // What it says last is what its card reports when it is done.
                ("item/completed", Some("agentMessage")) => {
                    let text = params.pointer("/item/text").and_then(Value::as_str).unwrap_or_default();
                    chat.translator.child_message(thread, text);
                }
                _ => {}
            }
        }
        return;
    }
    let Some(chat_id) = chat_of(params) else { return };
    // The threads a spawn started, so their approvals find their way here.
    if let Some(item) = params.get("item") {
        let children: Vec<&str> = match item.get("type").and_then(Value::as_str) {
            Some("collabAgentToolCall") => item.get("receiverThreadIds").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect(),
            Some("subAgentActivity") => item.get("agentThreadId").and_then(Value::as_str).into_iter().collect(),
            _ => Vec::new(),
        };
        for thread in children {
            CHILDREN.lock().insert(thread.to_string(), chat_id.clone());
        }
    }
    let outs = {
        let mut chats = CHATS.lock();
        let Some(chat) = chats.get_mut(&chat_id).filter(|c| Arc::ptr_eq(&c.server, server)) else { return };
        let turn = params.get("turnId").or_else(|| params.pointer("/turn/id")).and_then(Value::as_str);
        if let Some(turn) = turn.filter(|t| chat.replaced_turns.iter().any(|r| r == t)) {
            if method == "turn/completed" {
                let turn = turn.to_string();
                chat.replaced_turns.retain(|r| *r != turn);
            }
            return;
        }
        if method == "turn/started" && chat.turn_id.is_none() {
            chat.turn_id = params.pointer("/turn/id").and_then(Value::as_str).map(str::to_string);
        }
        chat.translator.notification(method, params, &read_file)
    };
    for out in outs {
        match out {
            Out::Event(event) => emit_event(&chat_id, event),
            Out::Usage(usage) => super::report_usage(&chat_id, usage),
            Out::Finished(finish) => finish_turn(&chat_id, finish),
        }
    }
}

async fn on_request(server: Arc<Server>, id: Value, method: String, params: Value) {
    if side::side_of(&params).is_some() {
        side::on_request(&server, id, &method).await;
        return;
    }
    // A subagent asks through the chat that started it.
    let child = params.get("threadId").and_then(Value::as_str).and_then(|t| CHILDREN.lock().get(t).cloned());
    let Some(chat_id) = chat_of(&params).or(child) else {
        server.reply(id, Err("Nyra has no chat for this thread".into())).await;
        return;
    };
    let (approval, skip) = {
        let chats = CHATS.lock();
        let Some(chat) = chats.get(&chat_id) else { return };
        (chat.translator.approval(&method, &params), chat.skip_permissions)
    };
    let Some(approval) = approval else {
        // Questions, elicitations, permission widening: no dialog for these yet.
        crate::logf!("codex: declining {method} for [{}]", util::short(&chat_id));
        server.reply(id, Err(format!("Nyra cannot answer {method} yet"))).await;
        return;
    };
    // Nyra's own tools run unasked, as they do for Claude: the user's gate is
    // for what a model does to their machine, not for it talking to Nyra.
    let nyras_own = method == "mcpServer/elicitation/request"
        && params.get("serverName").and_then(Value::as_str).is_some_and(|s| s.starts_with("nyra-"));
    if skip || nyras_own {
        server.reply(id, Ok(approval.kind.answer(true))).await;
        return;
    }
    if let Some(chat) = CHATS.lock().get_mut(&chat_id) {
        chat.approvals.push_back((id, approval.kind));
    }
    super::emit_permission(
        &chat_id,
        json!({
            "tool_id": approval.tool_id,
            "tool_name": approval.tool_name,
            "input": approval.input,
            "originalContent": approval.original,
        }),
    );
    crate::notify_user::notify("Permission Needed", &format!("Codex wants to use {}", approval.tool_name), &chat_id);
}

/// The process died: every chat it ran loses its turn, and resumes its thread
/// in a new process on the next message.
fn on_exit(server: &Arc<Server>, reason: &str) {
    crate::logf!("codex app-server exited: {reason}");
    SERVERS.lock().retain(|_, s| !Arc::ptr_eq(s, server));
    side::on_exit(server);
    let orphans: Vec<(String, Chat)> = {
        let mut chats = CHATS.lock();
        let ids: Vec<String> = chats.iter().filter(|(_, c)| Arc::ptr_eq(&c.server, server)).map(|(id, _)| id.clone()).collect();
        ids.into_iter().filter_map(|id| chats.remove(&id).map(|c| (id, c))).collect()
    };
    for (chat_id, chat) in orphans {
        THREADS.lock().remove(&chat.thread_id);
        if let Some(done) = chat.done {
            let message = format!("Codex stopped: {reason}");
            emit_event(&chat_id, json!({ "type": "error", "result": message }));
            emit_event(&chat_id, json!({ "type": "stream_end" }));
            super::fail_result(&chat_id, &message);
            crate::keep_awake::turn_ended(&chat_id);
            crate::desktop::turn_ended(&chat_id);
            let _ = done.send(Err(message));
        }
    }
}

fn finish_turn(chat_id: &str, finish: translate::Finish) {
    let (done, thread_id, turn_id) = {
        let mut chats = CHATS.lock();
        let Some(chat) = chats.get_mut(chat_id) else { return };
        chat.abort_requested = false;
        chat.approvals.clear();
        (chat.done.take(), chat.thread_id.clone(), chat.turn_id.take())
    };
    crate::keep_awake::turn_ended(chat_id);
    crate::desktop::turn_ended(chat_id);

    if finish.status == TurnStatus::Interrupted {
        emit_event(chat_id, json!({ "type": "stream_end" }));
        super::fail_result(chat_id, "Aborted by user");
        if let Some(done) = done {
            let _ = done.send(Err("Aborted by user".into()));
        }
        return;
    }

    let failed = finish.status == TurnStatus::Failed;
    // Where an edit of the next message rewinds to: this turn, in this thread.
    // Codex forks at a turn, so a finished turn is the anchor a message is.
    if let (false, Some(turn_id)) = (failed, turn_id) {
        emit_event(
            chat_id,
            json!({ "type": "anchor", "uuid": turn_id, "session_id": thread_id, "provider": "codex" }),
        );
    }
    emit_event(
        chat_id,
        json!({ "type": "result", "result": finish.text, "session_id": thread_id, "is_error": failed }),
    );
    emit_event(chat_id, json!({ "type": "stream_end" }));
    super::deliver_result(chat_id, &finish.text, failed);
    super::off_usage(chat_id);
    let summary: String = finish.text.chars().take(80).collect();
    match (failed, summary.is_empty()) {
        (true, _) => crate::notify_user::notify("Task Failed", &summary, chat_id),
        (false, true) => crate::notify_user::notify("Task Complete", "Codex finished your task", chat_id),
        (false, false) => crate::notify_user::notify("Task Complete", &summary, chat_id),
    }
    if let Some(done) = done {
        let _ = done.send(Ok(Some(thread_id)));
    }
}

// ---- opening a thread ----

/// The instructions and Nyra's own MCP servers, on the same terms Claude gets
/// them: each behind its setting, and only for a chat with a window to drive.
fn thread_config(chat_id: &str, cwd: &str, settings: &SpawnSettings) -> (String, Value) {
    let app = util::settings();
    let endpoints = [
        ("nyra-browser", app.browser_tools.then(|| crate::browser::mcp_endpoint(chat_id)).flatten()),
        ("nyra-app", app.app_tools.then(|| crate::app_mcp::mcp_endpoint(chat_id)).flatten()),
        ("nyra-desktop", app.desktop_tools.then(|| crate::desktop::mcp_endpoint(chat_id)).flatten()),
    ];
    let mut config = serde_json::Map::new();
    let has = |name: &str| endpoints.iter().any(|(n, e)| *n == name && e.is_some());
    for (name, endpoint) in &endpoints {
        if let Some((url, token)) = endpoint {
            config.insert(
                format!("mcp_servers.{name}"),
                json!({ "url": url, "http_headers": { "x-nyra-token": token } }),
            );
        }
    }
    let instructions = crate::claude::compose_system_prompt_for(
        Provider::Codex,
        cwd,
        &settings.system_prompt,
        has("nyra-browser"),
        has("nyra-app"),
        has("nyra-desktop"),
    );
    (instructions, Value::Object(config))
}

fn approval_policy(settings: &SpawnSettings) -> &'static str {
    if settings.skip_permissions {
        "never"
    } else {
        "untrusted"
    }
}

/// Resume the chat's thread, or start one. A thread Codex no longer has is
/// replaced with a new one rather than failing the turn.
#[allow(clippy::too_many_arguments)]
async fn open_thread(
    server: &Server,
    chat_id: &str,
    resume: Option<String>,
    fork_at: Option<String>,
    cwd: &str,
    instructions: &str,
    config: &Value,
    settings: &SpawnSettings,
) -> Result<String, String> {
    let mut params = json!({
        "cwd": cwd,
        "approvalPolicy": approval_policy(settings),
        "sandbox": "danger-full-access",
        "developerInstructions": instructions,
        "config": config,
    });
    if !settings.model.is_empty() {
        params["model"] = json!(settings.model);
    }
    // An edit or a regenerate: a new thread holding the old one's turns up to
    // and including `fork_at`. The old thread is left as it was, so every other
    // message's anchor into it still holds. No fallback: carrying on anywhere
    // else would answer from the wrong place in the conversation.
    if let (Some(thread_id), Some(turn_id)) = (&resume, fork_at) {
        let mut fork_params = params.clone();
        fork_params["threadId"] = json!(thread_id);
        fork_params["lastTurnId"] = json!(turn_id);
        fork_params["excludeTurns"] = json!(true);
        let reply = server
            .request("thread/fork", fork_params)
            .await
            .map_err(|e| format!("Codex could not go back to that point: {e}"))?;
        return reply
            .pointer("/thread/id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Codex forked a thread without an id".into());
    }
    if let Some(thread_id) = resume {
        let mut resume_params = params.clone();
        resume_params["threadId"] = json!(thread_id);
        resume_params["excludeTurns"] = json!(true);
        match server.request("thread/resume", resume_params).await {
            Ok(reply) => {
                if let Some(id) = reply.pointer("/thread/id").and_then(Value::as_str) {
                    return Ok(id.to_string());
                }
            }
            Err(e) => {
                crate::logf!("codex resume of {thread_id} failed, starting fresh: {e}");
                emit_event(chat_id, json!({ "type": "session_reset", "reason": "Codex no longer has this conversation." }));
            }
        }
    }
    let reply = server.request("thread/start", params).await?;
    reply
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Codex started a thread without an id".into())
}

/// The prompt as Codex input: the text, plus every image the composer marked
/// in it, so the model sees the image rather than only its path.
pub(super) fn prompt_input(prompt: &str) -> Value {
    static IMAGE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[Image: ([^\]\r\n]+)\]").unwrap());
    let mut input = vec![json!({ "type": "text", "text": prompt, "text_elements": [] })];
    for path in IMAGE.captures_iter(prompt).map(|c| c[1].trim().to_string()) {
        if std::path::Path::new(&path).is_file() {
            input.push(json!({ "type": "localImage", "path": path }));
        }
    }
    Value::Array(input)
}

// ---- the backend ----

impl AgentBackend for Codex {
    async fn run(&self, turn: Turn) -> Result<Option<String>, String> {
        let Turn { prompt, cwd, resume_session_id, resume_at, nyra_session_id: chat_id, settings, .. } = turn;
        let fail = |reason: String| {
            fail_before_turn(&chat_id, &reason);
            Err(reason)
        };
        if !Environment::of(&cwd).is_host() {
            return fail("Codex chats in WSL projects are not supported yet.".into());
        }
        let server = match server_for(home_for(settings.config_dir.as_deref())).await {
            Ok(server) => server,
            Err(e) => return fail(e),
        };

        let (instructions, config) = thread_config(&chat_id, &cwd, &settings);
        let fingerprint = format!("{cwd}\n{instructions}\n{config}");
        let current = CHATS.lock().get(&chat_id).map(|c| {
            (c.thread_id.clone(), c.fingerprint == fingerprint && Arc::ptr_eq(&c.server, &server))
        });
        // A rewind always opens anew: it forks the thread at the turn it names.
        if resume_at.is_some() || current.as_ref().is_none_or(|(_, same)| !same) {
            // Opened anew; the thread it had, if any, is what it resumes.
            // A rewind forks the thread its anchor is in, which an earlier
            // rewind may have left behind; anything else carries on the live one.
            let live = current.map(|(thread, _)| thread);
            let resume = if resume_at.is_some() { resume_session_id.or(live) } else { live.or(resume_session_id) };
            if let Some(old) = CHATS.lock().remove(&chat_id) {
                THREADS.lock().remove(&old.thread_id);
            }
            let opened = open_thread(&server, &chat_id, resume, resume_at, &cwd, &instructions, &config, &settings).await;
            let thread_id = match opened {
                Ok(id) => id,
                Err(e) => return fail(e),
            };
            THREADS.lock().insert(thread_id.clone(), chat_id.clone());
            CHATS.lock().insert(
                chat_id.clone(),
                Chat {
                    server: server.clone(),
                    thread_id: thread_id.clone(),
                    fingerprint,
                    turn_id: None,
                    done: None,
                    abort_requested: false,
                    skip_permissions: settings.skip_permissions,
                    approvals: VecDeque::new(),
                    replaced_turns: Vec::new(),
                    translator: Translator::default(),
                },
            );
            // The id the renderer keeps, so the next process resumes this thread.
            emit_event(&chat_id, json!({ "type": "system", "subtype": "init", "session_id": thread_id }));
            // The account's limits as they stand, before a turn has moved them.
            let (server, chat) = (server.clone(), chat_id.clone());
            tauri::async_runtime::spawn(async move {
                if let Ok(reply) = server.request("account/rateLimits/read", json!({})).await {
                    if let Some(event) = reply.get("rateLimits").and_then(translate::rate_limit_event) {
                        emit_event(&chat, event);
                    }
                }
            });
        }

        // A turn still open here is one the renderer has lost track of — a
        // reload while it waited on an approval nobody can now see. Codex would
        // fold this message into it, so it ends first.
        let stale = {
            let mut chats = CHATS.lock();
            chats.get_mut(&chat_id).and_then(|chat| {
                let done = chat.done.take()?;
                chat.approvals.clear();
                let turn_id = chat.turn_id.take();
                chat.replaced_turns.extend(turn_id.clone());
                Some((done, turn_id))
            })
        };
        if let Some((done, turn_id)) = stale {
            let _ = done.send(Err("Replaced by a newer message".into()));
            if let Some(turn_id) = turn_id {
                interrupt(&server, &thread_id_of(&chat_id).unwrap_or_default(), &turn_id).await;
            }
        }

        let (tx, rx) = oneshot::channel();
        let thread_id = {
            let mut chats = CHATS.lock();
            let chat = chats.get_mut(&chat_id).ok_or("Codex chat vanished")?;
            chat.done = Some(tx);
            chat.turn_id = None;
            chat.abort_requested = false;
            chat.skip_permissions = settings.skip_permissions;
            chat.translator.turn_started();
            chat.thread_id.clone()
        };
        crate::desktop::turn_started(&chat_id);
        crate::keep_awake::turn_started(&chat_id);

        // `/compact` is Codex's own compaction rather than a message; it runs
        // as a turn, so it ends the way any turn does.
        let started = if prompt.trim() == "/compact" {
            server.request("thread/compact/start", json!({ "threadId": thread_id })).await
        } else {
            let mut params = json!({
                "threadId": thread_id,
                "input": prompt_input(&prompt),
                "approvalPolicy": approval_policy(&settings),
                "sandboxPolicy": { "type": "dangerFullAccess" },
                "summary": "auto",
            });
            if !settings.model.is_empty() {
                params["model"] = json!(settings.model);
            }
            if !settings.effort.is_empty() {
                params["effort"] = json!(settings.effort);
            }
            server.request("turn/start", params).await
        };

        match started {
            Ok(reply) => {
                let interrupt_now = {
                    let mut chats = CHATS.lock();
                    chats.get_mut(&chat_id).and_then(|chat| {
                        if let Some(id) = reply.pointer("/turn/id").and_then(Value::as_str) {
                            chat.turn_id = Some(id.to_string());
                        }
                        chat.abort_requested.then(|| chat.turn_id.clone()).flatten()
                    })
                };
                if let Some(turn_id) = interrupt_now {
                    interrupt(&server, &thread_id, &turn_id).await;
                }
            }
            Err(e) => {
                if let Some(chat) = CHATS.lock().get_mut(&chat_id) {
                    chat.done = None;
                }
                crate::keep_awake::turn_ended(&chat_id);
                crate::desktop::turn_ended(&chat_id);
                return fail(e);
            }
        }
        rx.await.unwrap_or_else(|_| Err("Codex stopped".into()))
    }

    async fn prewarm(&self, warm: Prewarm) {
        // The server only: a thread opened for a chat nobody writes in is a
        // conversation in the user's Codex history that never happened.
        if !Environment::of(&warm.cwd).is_host() {
            return;
        }
        if let Err(e) = server_for(home_for(warm.settings.config_dir.as_deref())).await {
            crate::logf!("codex prewarm [{}]: {e}", util::short(&warm.nyra_session_id));
        }
    }

    fn abort(&self, nyra_session_id: &str) {
        let target = {
            let mut chats = CHATS.lock();
            let Some(chat) = chats.get_mut(nyra_session_id) else { return };
            match chat.turn_id.clone() {
                Some(turn_id) => Some((chat.server.clone(), chat.thread_id.clone(), turn_id)),
                None => {
                    // Not started yet: interrupted as soon as it has an id.
                    chat.abort_requested = chat.done.is_some();
                    None
                }
            }
        };
        if let Some((server, thread_id, turn_id)) = target {
            tauri::async_runtime::spawn(async move { interrupt(&server, &thread_id, &turn_id).await });
        }
    }

    fn abort_all(&self) {
        let ids: Vec<String> = CHATS.lock().keys().cloned().collect();
        for id in ids {
            self.abort(&id);
        }
    }

    async fn steer(&self, nyra_session_id: &str, prompt: &str) -> Option<u64> {
        let (server, thread_id, turn_id) = {
            let chats = CHATS.lock();
            let chat = chats.get(nyra_session_id)?;
            (chat.server.clone(), chat.thread_id.clone(), chat.turn_id.clone()?)
        };
        let params = json!({ "threadId": thread_id, "expectedTurnId": turn_id, "input": prompt_input(prompt) });
        if let Err(e) = server.request("turn/steer", params).await {
            crate::logf!("codex steer [{}]: {e}", util::short(nyra_session_id));
            return None;
        }
        let steer_id = STEERS.fetch_add(1, Ordering::Relaxed) + 1;
        // Codex takes a steer into the running turn on the spot. Said after
        // this returns: the renderer files the id it gets back first, and an
        // event that beat it there would find nothing to mark.
        let chat_id = nyra_session_id.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            emit_event(&chat_id, json!({ "type": "steer_delivered", "steer_id": steer_id }));
        });
        Some(steer_id)
    }

    async fn respond_permission(&self, nyra_session_id: &str, approved: bool) {
        let next = {
            let mut chats = CHATS.lock();
            chats.get_mut(nyra_session_id).and_then(|c| c.approvals.pop_front().map(|(id, kind)| (c.server.clone(), id, kind)))
        };
        let Some((server, id, kind)) = next else { return };
        server.reply(id, Ok(kind.answer(approved))).await;
    }

    async fn dispose(&self, nyra_session_id: &str) -> Result<(), String> {
        let Some(chat) = CHATS.lock().remove(nyra_session_id) else { return Ok(()) };
        THREADS.lock().remove(&chat.thread_id);
        if let Some(turn_id) = &chat.turn_id {
            interrupt(&chat.server, &chat.thread_id, turn_id).await;
        }
        if let Some(done) = chat.done {
            let _ = done.send(Err("Session disposed".into()));
        }
        super::fail_result(nyra_session_id, "Session disposed");
        super::off_usage(nyra_session_id);
        // Unloads the thread from the server; its history stays on disk.
        let _ = chat.server.request("thread/unsubscribe", json!({ "threadId": chat.thread_id })).await;
        Ok(())
    }

    fn dispose_all(&self) {
        CHATS.lock().clear();
        THREADS.lock().clear();
        for (_, server) in SERVERS.lock().drain() {
            server.kill();
        }
    }

    async fn side_ask(&self, ask: SideAsk) -> Result<(), String> {
        side::ask(ask).await
    }

    fn side_close(&self, side_id: &str) {
        side::close(side_id);
    }
}

async fn interrupt(server: &Server, thread_id: &str, turn_id: &str) {
    if let Err(e) = server.request("turn/interrupt", json!({ "threadId": thread_id, "turnId": turn_id })).await {
        crate::logf!("codex interrupt failed: {e}");
    }
}

// ---- for the composer ----

/// What the model picker lists for Codex: the account's own models, each with
/// the efforts it takes. `{ available: false, error }` when there is no Codex
/// to ask, which the picker reads as "leave the section out".
pub async fn models(config_dir: Option<String>) -> Value {
    let server = match server_for(home_for(config_dir.as_deref())).await {
        Ok(server) => server,
        Err(error) => return json!({ "available": false, "error": error }),
    };
    match server.request("model/list", json!({})).await {
        Ok(reply) => {
            let models: Vec<Value> = reply
                .get("data")
                .and_then(Value::as_array)
                .map(|data| {
                    data.iter()
                        .filter(|m| m.get("hidden").and_then(Value::as_bool) != Some(true))
                        .map(|m| {
                            let efforts: Vec<Value> = m
                                .get("supportedReasoningEfforts")
                                .and_then(Value::as_array)
                                .map(|e| e.iter().filter_map(|x| x.get("reasoningEffort").cloned()).collect())
                                .unwrap_or_default();
                            json!({
                                "id": m.get("id").or_else(|| m.get("model")).cloned().unwrap_or(Value::Null),
                                "displayName": m.get("displayName").cloned().unwrap_or(Value::Null),
                                "description": m.get("description").cloned().unwrap_or(Value::Null),
                                "efforts": efforts,
                                "defaultEffort": m.get("defaultReasoningEffort").cloned().unwrap_or(Value::Null),
                                "isDefault": m.get("isDefault").cloned().unwrap_or(Value::Bool(false)),
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!({ "available": true, "models": models })
        }
        Err(error) => json!({ "available": false, "error": error }),
    }
}

// ---- accounts ----

/// Who a workspace's Codex is signed in as. `{ available: false, error }` when
/// there is no Codex to ask; `{ signedIn: false }` when it is there but nobody is.
pub async fn account(config_dir: Option<String>) -> Value {
    let server = match server_for(home_for(config_dir.as_deref())).await {
        Ok(server) => server,
        Err(error) => return json!({ "available": false, "error": error }),
    };
    match server.request("account/read", json!({})).await {
        Ok(reply) => match reply.get("account").filter(|a| !a.is_null()) {
            Some(account) => json!({
                "available": true,
                "signedIn": true,
                "kind": account.get("type").cloned().unwrap_or(Value::Null),
                "email": account.get("email").cloned().unwrap_or(Value::Null),
                "planType": account.get("planType").cloned().unwrap_or(Value::Null),
            }),
            None => json!({ "available": true, "signedIn": false }),
        },
        Err(error) => json!({ "available": false, "error": error }),
    }
}

/// Start a ChatGPT sign-in for a workspace's Codex. Answers the URL to open; the
/// outcome arrives later as `codex:login`, with the same `loginId`.
pub async fn login(config_dir: Option<String>) -> Result<Value, String> {
    let server = server_for(home_for(config_dir.as_deref())).await?;
    let reply = server.request("account/login/start", json!({ "type": "chatgpt" })).await?;
    Ok(json!({
        "loginId": reply.get("loginId").cloned().unwrap_or(Value::Null),
        "authUrl": reply.get("authUrl").cloned().unwrap_or(Value::Null),
    }))
}

pub async fn logout(config_dir: Option<String>) -> Result<(), String> {
    let server = server_for(home_for(config_dir.as_deref())).await?;
    server.request("account/logout", json!({})).await.map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_image_the_composer_marked_goes_along_as_an_image() {
        let dir = std::env::temp_dir().join(format!("nyra-codex-input-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let image = dir.join("shot.png");
        std::fs::write(&image, b"png").unwrap();
        let prompt = format!("what is this?\n\n[Image: {}]\n[Image: {}]", image.display(), dir.join("gone.png").display());
        let input = prompt_input(&prompt);
        let items = input.as_array().unwrap();
        assert_eq!(items[0]["type"], "text");
        assert_eq!(items.len(), 2, "only the image that exists is attached");
        assert_eq!(items[1], json!({ "type": "localImage", "path": image.display().to_string() }));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn skipping_permissions_is_codex_never_asking() {
        let mut settings = SpawnSettings::default();
        assert_eq!(approval_policy(&settings), "untrusted");
        settings.skip_permissions = true;
        assert_eq!(approval_policy(&settings), "never");
    }
}
