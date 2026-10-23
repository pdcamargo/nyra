//! One agent CLI handing work to another: Opus asking GPT-6.1-Sol to take a
//! look, or Codex asking Claude.
//!
//! Reached through the `nyra_agent` tool on Nyra's own MCP server, which both
//! CLIs already have, so neither needs to know the other exists. A spawn starts
//! a child: a Nyra chat with no window of its own, run through `agent::run`
//! like any other, so either provider can be either end. The tool answers at
//! once with the child's id and the parent waits on it in calls short enough
//! for every MCP client's timeout — Codex gives a tool a minute, and a child
//! can take ten.
//!
//! What the child does is drawn in the parent: its events come here instead of
//! going to the window (`agent::emit_event` asks [`parent_of`] first) and go on
//! to the parent as `delegate_progress`, which the renderer files under the
//! Agent row the spawn opened. Its approval prompts appear in the parent's
//! dialog and are answered back to the child (`agent::emit_permission`).
//!
//! One level only: a child cannot start children of its own.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};

use super::{emit_event, Provider, SpawnSettings, Turn};
use crate::util;

/// How long one `wait` may hold the call. Under every client's tool timeout —
/// Codex's default is 60 seconds — with room to answer.
const WAIT_DEFAULT: Duration = Duration::from_secs(45);
const WAIT_MAX: Duration = Duration::from_secs(50);
/// What a result hands back to the parent. The child's whole answer would land
/// in the parent's context; past this the middle goes.
const RESULT_LIMIT: usize = 16_000;
/// A tool's output as the parent's card shows it, live.
const PREVIEW_LIMIT: usize = 2_000;
/// How long a spawn holds for the child's CLI to say what it is running on,
/// so the receipt can name it. Codex says so as the thread opens and Claude as
/// it starts answering, both within seconds.
const RESOLVE_WAIT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq)]
enum Status {
    Running,
    Completed,
    Failed,
    Cancelled,
}

impl Status {
    fn as_str(&self) -> &'static str {
        match self {
            Status::Running => "running",
            Status::Completed => "completed",
            Status::Failed => "failed",
            Status::Cancelled => "cancelled",
        }
    }
}

struct Delegate {
    parent: String,
    provider: Provider,
    /// What the spawn asked for; empty is the CLI's default.
    model: String,
    effort: String,
    /// What it is actually on, once its CLI said.
    running_on: Option<RunningOn>,
    status: Status,
    /// Its last answer, or why it failed.
    result: String,
    /// What it is doing now, for a `wait` that comes back before it is done.
    activity: String,
    /// The child's own id with its CLI, to carry the conversation into `reply`.
    session_id: Option<String>,
    started: Instant,
    tokens: i64,
}

/// The model a child's CLI resolved its request to, and the effort it runs at.
#[derive(Clone, PartialEq)]
struct RunningOn {
    model: String,
    effort: Option<String>,
}

/// What a chat last ran with, so a child can start the way its parent did: the
/// same project, account and approval mode.
#[derive(Clone)]
struct Context {
    cwd: String,
    settings: SpawnSettings,
    worktree_name: Option<String>,
}

/// Children by their id, which is also their chat id.
static DELEGATES: Lazy<Mutex<HashMap<String, Delegate>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static CONTEXTS: Lazy<Mutex<HashMap<String, Context>>> = Lazy::new(|| Mutex::new(HashMap::new()));
/// Claude's models as each account's CLI last listed them, by config dir (`""`
/// for Default). Codex is asked fresh; Claude only says so as a process starts.
static CLAUDE_MODELS: Lazy<Mutex<HashMap<String, Value>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// The parent of a child chat; None for every chat with a window.
pub fn parent_of(chat_id: &str) -> Option<String> {
    DELEGATES.lock().get(chat_id).map(|d| d.parent.clone())
}

/// "Codex · gpt-6.1-sol · high": who a prompt in the parent's dialog is from.
pub fn label_of(chat_id: &str) -> Option<String> {
    DELEGATES.lock().get(chat_id).map(label)
}

fn label(d: &Delegate) -> String {
    let (model, effort) = shown(d);
    [d.provider.label(), model.as_str(), effort.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty() && *part != "default")
        .collect::<Vec<_>>()
        .join(" · ")
}

/// The model and effort a child is on, as far as anyone knows yet: what its CLI
/// reported, else what was asked for, else "default".
fn shown(d: &Delegate) -> (String, String) {
    let or_default = |s: &str| if s.is_empty() { "default".to_string() } else { s.to_string() };
    match &d.running_on {
        Some(on) => (on.model.clone(), on.effort.clone().unwrap_or_else(|| or_default(&d.effort))),
        None => (or_default(&d.model), or_default(&d.effort)),
    }
}

/// Note what a chat runs with: every turn of every chat, and every prewarm.
pub fn remember(chat_id: &str, cwd: &str, settings: &SpawnSettings, worktree_name: Option<&String>) {
    CONTEXTS.lock().insert(
        chat_id.to_string(),
        Context { cwd: cwd.to_string(), settings: settings.clone(), worktree_name: worktree_name.cloned() },
    );
}

fn account_key(chat_id: &str) -> Option<String> {
    CONTEXTS.lock().get(chat_id).map(|c| c.settings.config_dir.clone().unwrap_or_default())
}

/// The models a Claude chat's CLI listed as it started, for the account it runs
/// under. See `claude::model_catalog`.
pub fn note_claude_models(chat_id: &str, catalog: Value) {
    if let Some(key) = account_key(chat_id) {
        CLAUDE_MODELS.lock().insert(key, catalog);
    }
}

/// Claude's models for an account: its CLI's own list, or the aliases before
/// any Claude chat under it has started this session.
fn claude_models(key: &str) -> Value {
    CLAUDE_MODELS.lock().get(key).cloned().unwrap_or_else(|| {
        let efforts = json!(crate::claude::CLAUDE_EFFORTS);
        Value::Array(
            ["default", "fable", "opus", "sonnet", "haiku"]
                .iter()
                .map(|m| json!({ "model": m, "is": "the latest of that family", "efforts": efforts }))
                .collect(),
        )
    })
}

/// The efforts a Claude model takes: its row's, matched by what `--model` was
/// given or what it resolved to. None when the list does not have it.
fn claude_efforts(key: &str, model: &str) -> Option<Vec<String>> {
    let wanted = if model.is_empty() { "default" } else { model };
    let models = claude_models(key);
    let row = models.as_array()?.iter().find(|m| m["model"] == wanted || m["is"] == wanted)?;
    Some(row["efforts"].as_array()?.iter().filter_map(|e| e.as_str().map(str::to_string)).collect())
}

/// The children a chat started and has not been told the end of.
fn children_of(parent: &str) -> Vec<String> {
    DELEGATES
        .lock()
        .iter()
        .filter(|(_, d)| d.parent == parent && d.status == Status::Running)
        .map(|(id, _)| id.clone())
        .collect()
}

/// Stop what a chat's children are doing: its own turn was stopped.
pub fn abort_children(parent: &str) {
    for child in children_of(parent) {
        cancel(&child);
    }
}

/// A chat going away takes its children with it.
pub async fn dispose_children(parent: &str) {
    let children: Vec<String> = DELEGATES.lock().iter().filter(|(_, d)| d.parent == parent).map(|(id, _)| id.clone()).collect();
    for child in children {
        cancel(&child);
        let _ = super::dispose_chat(&child).await;
        DELEGATES.lock().remove(&child);
        CONTEXTS.lock().remove(&child);
    }
    CONTEXTS.lock().remove(parent);
}

// ---- the tool ----

/// `nyra_agent`, called from `parent`'s chat.
pub async fn tool(parent: &str, args: Value) -> Result<String, String> {
    let action = args.get("action").and_then(Value::as_str).unwrap_or_default();
    let id = args.get("agent_id").and_then(Value::as_str).map(str::to_string);
    let owned = |id: &Option<String>| -> Result<String, String> {
        let id = id.clone().ok_or("agent_id is required")?;
        match DELEGATES.lock().get(&id) {
            Some(d) if d.parent == parent => Ok(id),
            _ => Err(format!("No agent {id} was started from this chat.")),
        }
    };
    match action {
        "spawn" => spawn(parent, &args).await,
        "models" => Ok(models(parent).await),
        "wait" => {
            let id = owned(&id)?;
            let timeout = args
                .get("timeout_seconds")
                .and_then(Value::as_f64)
                .map(|s| Duration::from_secs_f64(s.max(1.0)).min(WAIT_MAX))
                .unwrap_or(WAIT_DEFAULT);
            Ok(wait(&id, timeout).await)
        }
        "reply" => {
            let id = owned(&id)?;
            let prompt = args.get("prompt").and_then(Value::as_str).filter(|p| !p.trim().is_empty()).ok_or("prompt is required")?;
            reply(&id, prompt)
        }
        "cancel" => {
            let id = owned(&id)?;
            cancel(&id);
            Ok(report(&id))
        }
        other => Err(format!("Unknown action '{other}'. Use models, spawn, wait, reply or cancel.")),
    }
}

/// What each CLI offers this chat's account: the names `model` takes, and the
/// efforts each of them takes.
async fn models(parent: &str) -> String {
    let (config_dir, cwd) = CONTEXTS
        .lock()
        .get(parent)
        .map(|c| (c.settings.config_dir.clone(), c.cwd.clone()))
        .unwrap_or_default();
    let codex = super::codex::models(config_dir.clone()).await;
    let codex = match codex.get("models").and_then(Value::as_array) {
        Some(models) => {
            // The config outranks the catalog on both: the model a spawn without
            // one gets, and the effort every model runs at without one.
            let (model, effort) = super::codex::configured(config_dir.clone(), &cwd).await;
            json!({
                "models": models
                    .iter()
                    .map(|m| {
                        let takes = |e: &str| m["efforts"].as_array().is_some_and(|all| all.iter().any(|x| x == e));
                        let default_effort = match &effort {
                            Some(e) if takes(e) => json!(e),
                            _ => m["defaultEffort"].clone(),
                        };
                        let default = match &model {
                            Some(id) => m["id"] == id.as_str(),
                            None => m["isDefault"] == true,
                        };
                        json!({ "model": m["id"], "is": m["displayName"], "efforts": m["efforts"], "default_effort": default_effort, "default": default })
                    })
                    .collect::<Vec<_>>(),
            })
        }
        None => json!({ "unavailable": codex.get("error").cloned().unwrap_or(json!("Codex did not answer")) }),
    };
    pretty(&json!({
        "claude": { "models": claude_models(&config_dir.unwrap_or_default()), "default_effort": "high" },
        "codex": codex,
        "note": "Pass model and effort to spawn only to choose; left out, each CLI uses its default.",
    }))
}

/// Whether `effort` is one `model` takes, for a spawn: refused here with the
/// right names rather than failing inside the child.
async fn check_effort(provider: Provider, config_dir: Option<String>, cwd: &str, model: &str, effort: &str) -> Result<(), String> {
    let allowed = match provider {
        Provider::Claude => Some(
            claude_efforts(&config_dir.unwrap_or_default(), model)
                .unwrap_or_else(|| crate::claude::CLAUDE_EFFORTS.iter().map(|e| e.to_string()).collect()),
        ),
        Provider::Codex => {
            // No model is the config's, failing that the catalog's default.
            let configured = if model.is_empty() { super::codex::configured(config_dir.clone(), cwd).await.0 } else { None };
            let listed = super::codex::models(config_dir).await;
            listed.get("models").and_then(Value::as_array).and_then(|models| {
                let row = models.iter().find(|m| match (model, &configured) {
                    ("", Some(id)) => m["id"] == id.as_str(),
                    ("", None) => m["isDefault"] == true,
                    _ => m["id"] == model,
                })?;
                Some(row["efforts"].as_array()?.iter().filter_map(|e| e.as_str().map(str::to_string)).collect::<Vec<_>>())
            })
        }
    };
    let Some(allowed) = allowed else { return Ok(()) };
    let name = if model.is_empty() { "The default model" } else { model };
    if allowed.is_empty() {
        return Err(format!("{name} takes no effort. Leave effort out."));
    }
    if !allowed.iter().any(|e| e == effort) {
        return Err(format!("{name} takes effort {}, not \"{effort}\".", allowed.join(", ")));
    }
    Ok(())
}

async fn spawn(parent: &str, args: &Value) -> Result<String, String> {
    if parent_of(parent).is_some() {
        return Err("A delegated agent cannot start agents of its own.".into());
    }
    let provider: Provider = args
        .get("provider")
        .cloned()
        .ok_or("provider is required: \"claude\" or \"codex\"")
        .and_then(|p| serde_json::from_value(p).map_err(|_| "provider must be \"claude\" or \"codex\""))?;
    let prompt = args.get("prompt").and_then(Value::as_str).filter(|p| !p.trim().is_empty()).ok_or("prompt is required")?;
    let context = CONTEXTS.lock().get(parent).cloned().ok_or("This chat has not run a turn Nyra can start an agent from.")?;

    let model = args.get("model").and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let effort = args.get("effort").and_then(Value::as_str).unwrap_or_default().trim().to_lowercase();
    if !effort.is_empty() {
        check_effort(provider, context.settings.config_dir.clone(), &context.cwd, &model, &effort).await?;
    }
    let mut settings = context.settings.clone();
    settings.provider = provider;
    settings.model = model.clone();
    settings.effort = effort.clone();
    settings.plan_mode = false;
    settings.allowed_tools = None;

    let child = format!("delegate-{}", util::rand_hex(12));
    DELEGATES.lock().insert(
        child.clone(),
        Delegate {
            parent: parent.to_string(),
            provider,
            model,
            effort,
            running_on: None,
            status: Status::Running,
            result: String::new(),
            activity: "starting".into(),
            session_id: None,
            started: Instant::now(),
            tokens: 0,
        },
    );
    run_turn(&child, prompt.to_string(), Context { settings, ..context });

    // Held until the child's CLI names its model, so the receipt says what it
    // is really on rather than "default".
    let deadline = Instant::now() + RESOLVE_WAIT;
    loop {
        let settled = DELEGATES.lock().get(&child).is_none_or(|d| d.running_on.is_some() || d.status != Status::Running);
        if settled || Instant::now() >= deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let delegates = DELEGATES.lock();
    let d = delegates.get(&child).ok_or("The agent is gone.")?;
    let (model, effort) = shown(d);
    let mut out = json!({
        "agent_id": child,
        "agent": label(d),
        "model": model,
        "effort": effort,
        "status": d.status.as_str(),
    });
    if d.status == Status::Running {
        out["next"] = json!("Call nyra_agent with action:\"wait\" and this agent_id until status is no longer running. Do other work in between if you have any.");
    } else {
        out["result"] = json!(clip_middle(&d.result, RESULT_LIMIT));
    }
    Ok(pretty(&out))
}

/// One turn of the child, in the background. Its end is the result.
fn run_turn(child: &str, prompt: String, context: Context) {
    CONTEXTS.lock().insert(child.to_string(), context.clone());
    let child = child.to_string();
    let resume = DELEGATES.lock().get(&child).and_then(|d| d.session_id.clone());
    tauri::async_runtime::spawn(async move {
        let outcome = super::on_result(&child);
        let ran = super::run(Turn {
            prompt,
            cwd: context.cwd.clone(),
            resume_session_id: resume,
            resume_at: None,
            nyra_session_id: child.clone(),
            settings: context.settings.clone(),
            worktree_name: context.worktree_name.clone(),
            checkpoint: None,
        })
        .await;
        let (text, failed) = match outcome.await {
            Ok(result) => result,
            Err(_) => (ran.err().unwrap_or_else(|| "The agent stopped without an answer.".into()), true),
        };
        finish(&child, text, failed);
    });
}

fn finish(child: &str, text: String, failed: bool) {
    let (parent, status, tokens, elapsed, answer) = {
        let mut delegates = DELEGATES.lock();
        let Some(d) = delegates.get_mut(child) else { return };
        // A cancel already said how it ended.
        if d.status == Status::Running {
            d.status = if failed { Status::Failed } else { Status::Completed };
        }
        if !text.trim().is_empty() || d.result.is_empty() {
            d.result = text;
        }
        d.activity.clear();
        (d.parent.clone(), d.status.clone(), d.tokens, d.started.elapsed(), clip_middle(&d.result, PREVIEW_LIMIT * 2))
    };
    emit_event(
        &parent,
        json!({
            "type": "delegate_done",
            "agent_id": child,
            "status": status.as_str(),
            "duration_ms": elapsed.as_millis() as u64,
            "total_tokens": tokens,
            // What the agent's card reports: its answer, not the spawn's receipt.
            "result": answer,
        }),
    );
}

async fn wait(child: &str, timeout: Duration) -> String {
    let deadline = Instant::now() + timeout;
    loop {
        let running = DELEGATES.lock().get(child).is_some_and(|d| d.status == Status::Running);
        if !running || Instant::now() >= deadline {
            return report(child);
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn reply(child: &str, prompt: &str) -> Result<String, String> {
    {
        let mut delegates = DELEGATES.lock();
        let d = delegates.get_mut(child).ok_or("No such agent.")?;
        if d.status == Status::Running {
            return Err("That agent is still working. Wait for it before replying.".into());
        }
        d.status = Status::Running;
        d.result.clear();
        d.activity = "reading your reply".into();
    }
    let context = CONTEXTS.lock().get(child).cloned().ok_or("That agent's chat is gone.")?;
    run_turn(child, prompt.to_string(), context);
    Ok(report(child))
}

fn cancel(child: &str) {
    let was_running = {
        let mut delegates = DELEGATES.lock();
        match delegates.get_mut(child) {
            Some(d) if d.status == Status::Running => {
                d.status = Status::Cancelled;
                true
            }
            _ => false,
        }
    };
    if was_running {
        super::abort(Some(child));
    }
}

/// What the parent reads back: where the child is, and its answer once it has one.
fn report(child: &str) -> String {
    let delegates = DELEGATES.lock();
    let Some(d) = delegates.get(child) else {
        return pretty(&json!({ "agent_id": child, "status": "unknown" }));
    };
    let (model, effort) = shown(d);
    let mut out = json!({
        "agent_id": child,
        "agent": label(d),
        "model": model,
        "effort": effort,
        "status": d.status.as_str(),
        "elapsed_seconds": d.started.elapsed().as_secs(),
    });
    if d.status == Status::Running {
        out["activity"] = json!(d.activity);
        out["next"] = json!("Still working. Wait again, or reply later.");
    } else {
        out["result"] = json!(clip_middle(&d.result, RESULT_LIMIT));
    }
    pretty(&out)
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn clip_middle(text: &str, limit: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit {
        return text.to_string();
    }
    let half = limit / 2;
    let head: String = chars[..half].iter().collect();
    let tail: String = chars[chars.len() - half..].iter().collect();
    format!("{head}\n\n[… {} characters left out …]\n\n{tail}", chars.len() - limit)
}

// ---- the child's events ----

/// The child's CLI said what it is on. Codex names the effort too; Claude does
/// not, so its effort is the one asked for, or the model's default — `high`, or
/// none for a model that takes none.
fn note_running_on(child: &str, parent: &str, model: &str, effort: Option<&str>) {
    let Some((provider, requested)) = DELEGATES.lock().get(child).map(|d| (d.provider, d.effort.clone())) else { return };
    let effort = match (effort, provider) {
        (Some(e), _) => Some(e.to_string()),
        (None, _) if !requested.is_empty() => Some(requested),
        (None, Provider::Claude) => {
            let takes_none = claude_efforts(&account_key(child).unwrap_or_default(), model).is_some_and(|e| e.is_empty());
            Some(if takes_none { "none" } else { "high" }.to_string())
        }
        (None, Provider::Codex) => None,
    };
    let on = RunningOn { model: model.to_string(), effort };
    let event = {
        let mut delegates = DELEGATES.lock();
        let Some(d) = delegates.get_mut(child) else { return };
        if d.running_on.as_ref() == Some(&on) {
            return;
        }
        d.running_on = Some(on);
        let (model, effort) = shown(d);
        json!({ "type": "delegate_model", "agent_id": child, "provider": d.provider, "model": model, "effort": effort })
    };
    emit_event(parent, event);
}

/// One of the child's events, which would have gone to a window it does not
/// have. What the parent's card shows of it goes on to the parent.
pub fn on_child_event(child: &str, parent: &str, event: &Value) {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or_default();
    let str_of = |key: &str| event.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
    let entry = match kind {
        "assistant_text" => {
            let text = str_of("text");
            if let Some(d) = DELEGATES.lock().get_mut(child) {
                d.result = text.clone();
            }
            Some(json!({ "kind": "text", "text": text }))
        }
        "tool_input" => {
            let name = str_of("tool_name");
            if let Some(d) = DELEGATES.lock().get_mut(child) {
                d.activity = format!("running {name}");
            }
            Some(json!({ "kind": "tool", "tool_id": str_of("tool_id"), "name": name, "input": event.get("input").cloned().unwrap_or(json!({})) }))
        }
        "tool_result" => Some(json!({
            "kind": "tool_result",
            "tool_id": str_of("tool_id"),
            "result": clip_middle(&str_of("content"), PREVIEW_LIMIT),
            "is_error": event.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        })),
        "system" => {
            if let Some(id) = event.get("session_id").and_then(Value::as_str) {
                if let Some(d) = DELEGATES.lock().get_mut(child) {
                    d.session_id = Some(id.to_string());
                }
            }
            if let Some(model) = event.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
                note_running_on(child, parent, model, event.get("effort").and_then(Value::as_str));
            }
            None
        }
        "result" => {
            if let Some(id) = event.get("session_id").and_then(Value::as_str) {
                if let Some(d) = DELEGATES.lock().get_mut(child) {
                    d.session_id = Some(id.to_string());
                }
            }
            None
        }
        "usage" => {
            let n = |k: &str| event.get(k).and_then(Value::as_i64).unwrap_or(0);
            if let Some(d) = DELEGATES.lock().get_mut(child) {
                d.tokens += n("input_tokens") + n("output_tokens") + n("cache_creation_input_tokens") + n("cache_read_input_tokens");
            }
            None
        }
        _ => None,
    };
    if let Some(entry) = entry {
        emit_event(parent, json!({ "type": "delegate_progress", "agent_id": child, "entries": [entry] }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_long_answer_loses_its_middle_not_its_end() {
        let text = format!("{}{}", "a".repeat(10), "z".repeat(10));
        let clipped = clip_middle(&text, 8);
        assert!(clipped.starts_with("aaaa"));
        assert!(clipped.ends_with("zzzz"));
        assert!(clipped.contains("12 characters left out"));
        assert_eq!(clip_middle("short", 8), "short");
    }

    #[tokio::test]
    async fn a_child_cannot_spawn_and_an_unknown_agent_is_refused() {
        DELEGATES.lock().insert(
            "delegate-test".into(),
            Delegate {
                parent: "parent-test".into(),
                provider: Provider::Codex,
                model: "gpt-6.1-sol".into(),
                effort: String::new(),
                running_on: None,
                status: Status::Completed,
                result: "done".into(),
                activity: String::new(),
                session_id: None,
                started: Instant::now(),
                tokens: 0,
            },
        );
        let nested = tool("delegate-test", json!({ "action": "spawn", "provider": "claude", "prompt": "x" })).await;
        assert!(nested.unwrap_err().contains("cannot start agents"));

        let stranger = tool("someone-else", json!({ "action": "wait", "agent_id": "delegate-test" })).await;
        assert!(stranger.unwrap_err().contains("No agent"));

        let mine = tool("parent-test", json!({ "action": "wait", "agent_id": "delegate-test" })).await.unwrap();
        assert!(mine.contains("\"status\": \"completed\"") && mine.contains("\"result\": \"done\""));
        DELEGATES.lock().remove("delegate-test");
    }

    fn running(id: &str, provider: Provider, model: &str, effort: &str) {
        DELEGATES.lock().insert(
            id.into(),
            Delegate {
                parent: "parent-model".into(),
                provider,
                model: model.into(),
                effort: effort.into(),
                running_on: None,
                status: Status::Running,
                result: String::new(),
                activity: String::new(),
                session_id: None,
                started: Instant::now(),
                tokens: 0,
            },
        );
    }

    #[test]
    fn a_child_names_the_model_its_cli_resolved_not_the_request() {
        running("delegate-claude", Provider::Claude, "", "");
        assert_eq!(label_of("delegate-claude").unwrap(), "Claude");

        // Claude's init names the model; its effort is the default, high.
        emit_event("delegate-claude", json!({ "type": "system", "subtype": "init", "model": "claude-opus-5-5" }));
        assert_eq!(label_of("delegate-claude").unwrap(), "Claude · claude-opus-5-5 · high");

        // Codex's names both, and what it names outranks a guess.
        running("delegate-codex", Provider::Codex, "", "");
        emit_event("delegate-codex", json!({ "type": "system", "subtype": "init", "model": "gpt-6.1-sol", "effort": "medium" }));
        let report = report("delegate-codex");
        assert!(report.contains("\"model\": \"gpt-6.1-sol\"") && report.contains("\"effort\": \"medium\""), "{report}");

        DELEGATES.lock().remove("delegate-claude");
        DELEGATES.lock().remove("delegate-codex");
    }

    #[tokio::test]
    async fn an_effort_the_model_does_not_take_is_refused_with_the_ones_it_does() {
        CLAUDE_MODELS.lock().insert(
            "/effort-test".into(),
            json!([
                { "model": "opus", "is": "claude-opus-5-5", "efforts": ["low", "high", "max"] },
                { "model": "haiku", "is": "claude-haiku-5-5", "efforts": [] },
            ]),
        );
        let dir = Some("/effort-test".to_string());
        assert!(check_effort(Provider::Claude, dir.clone(), "/", "opus", "max").await.is_ok());
        let wrong = check_effort(Provider::Claude, dir.clone(), "/", "opus", "ultra").await.unwrap_err();
        assert!(wrong.contains("low, high, max"), "{wrong}");
        let none = check_effort(Provider::Claude, dir.clone(), "/", "haiku", "low").await.unwrap_err();
        assert!(none.contains("takes no effort"), "{none}");
        // A model the list does not name falls back to Claude's whole scale.
        assert!(check_effort(Provider::Claude, dir, "/", "claude-something-new", "xhigh").await.is_ok());
        CLAUDE_MODELS.lock().remove("/effort-test");
    }
}
