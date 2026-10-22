//! The seam between Nyra and the agent CLIs it drives.
//!
//! Everything above this module — the Tauri commands, the workflow engine —
//! asks for a turn, a stop or a side question without knowing which CLI answers
//! it. Each CLI is an [`AgentBackend`]; the functions here pick one by
//! [`Provider`] and forward. What they all emit is the same: Nyra's own event
//! vocabulary on `claude:event`, which is the only thing the renderer reads.
//!
//! A chat's id is all that Stop, steering, a permission answer or a dispose
//! carry, so the backend that ran a chat's last turn is recorded here and those
//! go back to it.

use std::collections::HashMap;
use std::sync::Arc;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::oneshot;

pub mod codex;

use self::codex::Codex;
use crate::claude::Claude;
use crate::settings::SpawnSettings;
use crate::util;

/// Which CLI a chat runs on.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    #[default]
    Claude,
    Codex,
}

impl Provider {
    pub fn label(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "Codex",
        }
    }
}

/// One turn of a chat.
pub struct Turn {
    pub prompt: String,
    pub cwd: String,
    /// The CLI's own id for the conversation, to carry it into a new process.
    pub resume_session_id: Option<String>,
    /// Rewind to this point of that conversation before the prompt.
    pub resume_at: Option<String>,
    pub nyra_session_id: String,
    pub settings: SpawnSettings,
    pub worktree_name: Option<String>,
    /// Names the user message, for restoring the files a turn changed.
    pub checkpoint: Option<String>,
}

/// A chat's process, started before its first message.
pub struct Prewarm {
    pub cwd: String,
    pub resume_session_id: Option<String>,
    pub nyra_session_id: String,
    pub settings: SpawnSettings,
    pub worktree_name: Option<String>,
}

/// A side question: forked off the chat, read-only, gone on close.
pub struct SideAsk {
    pub side_id: String,
    pub nyra_session_id: String,
    pub cwd: String,
    pub resume_session_id: Option<String>,
    pub prompt: String,
    pub settings: SpawnSettings,
}

/// What a CLI has to do to run a Nyra chat. Implemented once per provider; a
/// provider missing any of it does not compile.
pub trait AgentBackend {
    /// Run a turn to its end. `Ok` carries the CLI's id for the conversation,
    /// which is what the next process resumes.
    async fn run(&self, turn: Turn) -> Result<Option<String>, String>;
    /// Start the chat's process ahead of its first message. Failures are the
    /// send's to report, so this one only logs them.
    async fn prewarm(&self, warm: Prewarm);
    /// Stop the running turn and keep the process.
    fn abort(&self, nyra_session_id: &str);
    fn abort_all(&self);
    /// Add to the running turn. `Some(id)` comes back in `steer_delivered`;
    /// `None` means there was no turn to steer.
    async fn steer(&self, nyra_session_id: &str, prompt: &str) -> Option<u64>;
    async fn respond_permission(&self, nyra_session_id: &str, approved: bool);
    /// Tear the chat's process down and wait until it is gone.
    async fn dispose(&self, nyra_session_id: &str) -> Result<(), String>;
    fn dispose_all(&self);
    async fn side_ask(&self, ask: SideAsk) -> Result<(), String>;
    fn side_close(&self, side_id: &str);
}

/// The backend that last ran each chat.
static OWNERS: Lazy<Mutex<HashMap<String, Provider>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn owner(nyra_session_id: &str) -> Option<Provider> {
    OWNERS.lock().get(nyra_session_id).copied()
}

/// Record who runs this chat now. A chat moving to another provider leaves its
/// old process behind, so that one is torn down first.
async fn claim(nyra_session_id: &str, provider: Provider) {
    let previous = OWNERS.lock().insert(nyra_session_id.to_string(), provider);
    if let Some(previous) = previous.filter(|p| *p != provider) {
        if let Err(e) = dispose_with(previous, nyra_session_id).await {
            crate::logf!("Disposing [{}] on {} failed: {e}", util::short(nyra_session_id), previous.label());
        }
    }
}

// ---- dispatch ----

pub async fn run(turn: Turn) -> Result<Option<String>, String> {
    let provider = turn.settings.provider;
    claim(&turn.nyra_session_id, provider).await;
    match provider {
        Provider::Claude => Claude.run(turn).await,
        Provider::Codex => Codex.run(turn).await,
    }
}

pub async fn prewarm(warm: Prewarm) {
    let provider = warm.settings.provider;
    claim(&warm.nyra_session_id, provider).await;
    match provider {
        Provider::Claude => Claude.prewarm(warm).await,
        Provider::Codex => Codex.prewarm(warm).await,
    }
}

/// Stop one chat's turn, or every chat's.
pub fn abort(nyra_session_id: Option<&str>) {
    let Some(id) = nyra_session_id else {
        Claude.abort_all();
        Codex.abort_all();
        return;
    };
    match owner(id).unwrap_or_default() {
        Provider::Claude => Claude.abort(id),
        Provider::Codex => Codex.abort(id),
    }
}

pub async fn steer(nyra_session_id: &str, prompt: &str) -> Option<u64> {
    match owner(nyra_session_id)? {
        Provider::Claude => Claude.steer(nyra_session_id, prompt).await,
        Provider::Codex => Codex.steer(nyra_session_id, prompt).await,
    }
}

pub async fn respond_permission(nyra_session_id: &str, approved: bool) {
    match owner(nyra_session_id).unwrap_or_default() {
        Provider::Claude => Claude.respond_permission(nyra_session_id, approved).await,
        Provider::Codex => Codex.respond_permission(nyra_session_id, approved).await,
    }
}

pub async fn dispose(nyra_session_id: &str) -> Result<(), String> {
    let provider = OWNERS.lock().remove(nyra_session_id).unwrap_or_default();
    dispose_with(provider, nyra_session_id).await
}

async fn dispose_with(provider: Provider, nyra_session_id: &str) -> Result<(), String> {
    match provider {
        Provider::Claude => Claude.dispose(nyra_session_id).await,
        Provider::Codex => Codex.dispose(nyra_session_id).await,
    }
}

/// Everything, on the way out of the app.
pub fn dispose_all() {
    OWNERS.lock().clear();
    Claude.dispose_all();
    Codex.dispose_all();
}

/// A side question runs on the chat's own provider: it forks that conversation.
pub async fn side_ask(ask: SideAsk) -> Result<(), String> {
    match ask.settings.provider {
        Provider::Claude => Claude.side_ask(ask).await,
        Provider::Codex => Codex.side_ask(ask).await,
    }
}

pub fn side_close(side_id: &str) {
    Claude.side_close(side_id);
    Codex.side_close(side_id);
}

// ---- events ----

/// One of Nyra's events, for the renderer, tagged with the chat it belongs to.
/// Every backend emits through here.
pub fn emit_event(nyra_session_id: &str, mut extra: Value) {
    crate::keep_awake::note_event(nyra_session_id, &extra);
    if let Value::Object(map) = &mut extra {
        map.insert("nyraSessionId".into(), Value::String(nyra_session_id.to_string()));
    }
    util::emit("claude:event", extra);
}

/// A turn that failed before the CLI could start it. No `result` or exit is
/// coming to end the turn the renderer has already started, so it is ended
/// here the way a process exit ends one.
pub fn fail_before_turn(nyra_session_id: &str, reason: &str) {
    emit_event(nyra_session_id, serde_json::json!({ "type": "error", "result": reason }));
    emit_event(nyra_session_id, serde_json::json!({ "type": "stream_end" }));
    fail_result(nyra_session_id, reason);
}

// ---- outcomes, for the workflow engine ----

/// Tokens one model call spent, in Anthropic's four buckets. A provider that
/// counts differently splits its numbers into these.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_creation_input_tokens: i64,
    pub cache_read_input_tokens: i64,
}

pub type UsageCallback = Arc<dyn Fn(Usage) + Send + Sync>;

/// `(final text, is_error)` handed to whoever is awaiting a session's outcome.
type ResultSender = oneshot::Sender<(String, bool)>;

static RESULT_CALLBACKS: Lazy<Mutex<HashMap<String, ResultSender>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static USAGE_CALLBACKS: Lazy<Mutex<HashMap<String, UsageCallback>>> = Lazy::new(|| Mutex::new(HashMap::new()));

/// Register a one-shot result sink for a session. Used by the workflow engine to
/// await a prompt node's final text instead of reading the renderer's events.
pub fn on_result(nyra_session_id: &str) -> oneshot::Receiver<(String, bool)> {
    let (tx, rx) = oneshot::channel();
    RESULT_CALLBACKS.lock().insert(nyra_session_id.to_string(), tx);
    rx
}

pub fn on_usage(nyra_session_id: &str, cb: UsageCallback) {
    USAGE_CALLBACKS.lock().insert(nyra_session_id.to_string(), cb);
}

pub fn off_usage(nyra_session_id: &str) {
    USAGE_CALLBACKS.lock().remove(nyra_session_id);
}

pub fn clear_usage_callbacks() {
    USAGE_CALLBACKS.lock().clear();
}

pub fn report_usage(nyra_session_id: &str, usage: Usage) {
    let cb = USAGE_CALLBACKS.lock().get(nyra_session_id).cloned();
    if let Some(cb) = cb {
        cb(usage);
    }
}

/// The session's turn ended with this text.
pub fn deliver_result(nyra_session_id: &str, text: &str, is_error: bool) {
    if let Some(cb) = RESULT_CALLBACKS.lock().remove(nyra_session_id) {
        let _ = cb.send((text.to_string(), is_error));
    }
}

/// Close out a session's result sink with an error.
///
/// The workflow engine blocks on this sink, so it has to fire exactly once for
/// every session — including the ones that die without ever emitting a `result`
/// event (abort, spawn failure, non-zero exit, permission denial).
pub fn fail_result(nyra_session_id: &str, reason: &str) {
    deliver_result(nyra_session_id, reason, true);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_provider_is_its_lowercase_name_on_the_wire() {
        assert_eq!(serde_json::to_value(Provider::Codex).unwrap(), "codex");
        assert_eq!(serde_json::from_value::<Provider>("claude".into()).unwrap(), Provider::Claude);
    }

    #[test]
    fn settings_from_before_providers_run_on_claude() {
        let settings: SpawnSettings = serde_json::from_value(serde_json::json!({ "model": "opus" })).unwrap();
        assert_eq!(settings.provider, Provider::Claude);
    }

    #[test]
    fn a_result_sink_fires_once() {
        let mut rx = on_result("sink-once");
        deliver_result("sink-once", "done", false);
        fail_result("sink-once", "late");
        assert_eq!(rx.try_recv().unwrap(), ("done".to_string(), false));
    }
}
