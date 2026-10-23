//! Side questions: a throwaway question asked beside a chat.
//!
//! Each thread is a process of its own, forked off the chat's transcript with
//! `--resume <id> --fork-session --no-session-persistence`. It sees everything
//! the chat has said, answers while the chat is mid-turn, and writes nothing:
//! not to the chat's transcript, and no transcript of its own. Follow-ups go to
//! the same process over stdin, so the thread keeps its context until the sheet
//! closes and the process goes with it.
//!
//! Not the CLI's `/btw`. Headless, `/btw` answers "isn't available in this
//! environment" — and records the question in the chat's transcript anyway,
//! where the next turn reads it. The renderer never lets it through.
//!
//! Events go to the renderer as `claude:side`, keyed by the thread's id:
//! `delta` (answer text), `tool` (it is looking something up), `done` (a turn
//! finished) and `exit` (the process is gone).

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdin;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::claude::{resolve_claude_binary, settings_for_side, side_spawn_args};
use crate::environment::Environment;
use crate::settings::SpawnSettings;
use crate::util;

struct Side {
    stdin: AsyncMutex<ChildStdin>,
    kill: Mutex<Option<oneshot::Sender<()>>>,
}

static SIDES: Lazy<Mutex<HashMap<String, Arc<Side>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn emit(side_id: &str, event: Value) {
    crate::agent::side_emit(side_id, event);
}

fn user_line(prompt: &str) -> String {
    let mut line = json!({ "type": "user", "message": { "role": "user", "content": prompt } }).to_string();
    line.push('\n');
    line
}

/// Ask in a thread: the first question spawns its process, a follow-up reuses it.
pub async fn ask(
    side_id: String,
    nyra_session_id: String,
    cwd: String,
    resume_session_id: Option<String>,
    prompt: String,
    settings: SpawnSettings,
) -> Result<(), String> {
    let existing = SIDES.lock().get(&side_id).cloned();
    let side = match existing {
        Some(side) => side,
        None => spawn(&side_id, &nyra_session_id, &cwd, resume_session_id.as_deref(), settings).await?,
    };
    let mut stdin = side.stdin.lock().await;
    stdin
        .write_all(user_line(&prompt).as_bytes())
        .await
        .map_err(|e| format!("The side question's process stopped taking input: {e}"))?;
    stdin.flush().await.map_err(|e| e.to_string())
}

/// End a thread and its process. Nothing to clean up on disk: it never wrote any.
pub fn close(side_id: &str) {
    if let Some(side) = SIDES.lock().remove(side_id) {
        if let Some(kill) = side.kill.lock().take() {
            let _ = kill.send(());
        }
    }
}

async fn spawn(
    side_id: &str,
    nyra_session_id: &str,
    cwd: &str,
    resume_session_id: Option<&str>,
    settings: SpawnSettings,
) -> Result<Arc<Side>, String> {
    let env = Environment::of(cwd);
    let settings = settings_for_side(cwd, settings);
    let claude_bin = match env.own_claude()? {
        Some(own) => own,
        None => {
            let configured = settings.claude_binary_path.clone();
            tokio::task::spawn_blocking(move || resolve_claude_binary(&configured))
                .await
                .map_err(|e| format!("Resolving the claude binary failed: {e}"))?
        }
    };
    let args = side_spawn_args(cwd, &settings, resume_session_id, nyra_session_id);
    crate::logf!(
        "Spawning side question [{}] for [{}]",
        util::short(side_id),
        util::short(nyra_session_id)
    );

    let mut child = env
        .command(&claude_bin, cwd)
        .args(&args)
        .env_clear()
        .envs(util::claude_child_env(settings.config_dir.as_deref().map(Path::new)))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn {claude_bin}: {e}"))?;

    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let (kill_tx, kill_rx) = oneshot::channel();
    let side = Arc::new(Side { stdin: AsyncMutex::new(stdin), kill: Mutex::new(Some(kill_tx)) });
    SIDES.lock().insert(side_id.to_string(), side.clone());

    {
        let id = side_id.to_string();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if !line.trim().is_empty() {
                    crate::logf!("side stderr [{}]: {}", util::short(&id), line.trim());
                }
            }
        });
    }

    {
        let id = side_id.to_string();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut kill_rx = kill_rx;
            let mut killed = false;
            loop {
                tokio::select! {
                    line = lines.next_line() => match line {
                        Ok(Some(line)) => {
                            if let Ok(raw) = serde_json::from_str::<Value>(&line) {
                                if let Some(event) = translate(&raw) {
                                    emit(&id, event);
                                }
                            }
                        }
                        _ => break,
                    },
                    _ = &mut kill_rx => {
                        killed = true;
                        let _ = child.start_kill();
                        break;
                    }
                }
            }
            let code = child.wait().await.ok().and_then(|s| s.code());
            // Closed on purpose, the thread is already gone from the renderer.
            if !killed {
                SIDES.lock().remove(&id);
                emit(&id, json!({ "type": "exit", "code": code }));
            }
        });
    }

    Ok(side)
}

/// One stream-json line as what the sheet needs, or nothing.
fn translate(raw: &Value) -> Option<Value> {
    match raw.get("type").and_then(Value::as_str)? {
        "stream_event" => {
            // A subagent's text is its own business.
            if raw.get("parent_tool_use_id").is_some_and(|p| !p.is_null()) {
                return None;
            }
            let event = raw.get("event")?;
            match event.get("type").and_then(Value::as_str)? {
                "content_block_start" => {
                    let block = event.get("content_block")?;
                    match block.get("type").and_then(Value::as_str)? {
                        // A new paragraph after a lookup, so the renderer can space it.
                        "text" => Some(json!({ "type": "block" })),
                        "tool_use" => Some(json!({
                            "type": "tool",
                            "name": block.get("name").and_then(Value::as_str).unwrap_or_default()
                        })),
                        _ => None,
                    }
                }
                "content_block_delta" => {
                    let delta = event.get("delta")?;
                    if delta.get("type").and_then(Value::as_str) != Some("text_delta") {
                        return None;
                    }
                    let text = delta.get("text").and_then(Value::as_str).unwrap_or_default();
                    (!text.is_empty()).then(|| json!({ "type": "delta", "text": text }))
                }
                _ => None,
            }
        }
        "result" => {
            let is_error = raw.get("is_error").and_then(Value::as_bool).unwrap_or(false);
            Some(json!({
                "type": "done",
                "isError": is_error,
                "result": raw.get("result").and_then(Value::as_str).unwrap_or_default(),
            }))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translates_text_tools_and_results() {
        let delta = json!({ "type": "stream_event", "parent_tool_use_id": null,
            "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "Hi" } } });
        assert_eq!(translate(&delta), Some(json!({ "type": "delta", "text": "Hi" })));

        let tool = json!({ "type": "stream_event",
            "event": { "type": "content_block_start", "content_block": { "type": "tool_use", "name": "Read" } } });
        assert_eq!(translate(&tool), Some(json!({ "type": "tool", "name": "Read" })));

        let result = json!({ "type": "result", "is_error": true, "result": "Not logged in" });
        assert_eq!(
            translate(&result),
            Some(json!({ "type": "done", "isError": true, "result": "Not logged in" }))
        );
    }

    #[test]
    fn ignores_subagents_and_everything_else() {
        let sub = json!({ "type": "stream_event", "parent_tool_use_id": "t1",
            "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "x" } } });
        assert_eq!(translate(&sub), None);
        assert_eq!(translate(&json!({ "type": "assistant" })), None);
        assert_eq!(translate(&json!({ "type": "system", "subtype": "init" })), None);
    }
}
