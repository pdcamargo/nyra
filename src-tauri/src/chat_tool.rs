//! `nyra_chat`: Claude starting a chat of its own, and looking at the others.
//!
//! A chat started here is not a delegate. `nyra_agent` hands work to a hidden
//! child that answers to the chat that made it; this makes a real chat in the
//! sidebar that belongs to the user from its first message. So every start is
//! the user's call, made in the asking chat's composer, with the whole prompt a
//! click away in the side panel. There is no "always": each one is a process
//! and a bill.
//!
//! Reading other chats is status only — title, state, what is running, what it
//! is waiting on — and never their messages, with one exception: a chat may
//! read the last reply of a chat it started, which is how it finds out whether
//! the work it handed off is done. Chats in the same project are open to each
//! other; another project in the same workspace asks once; another workspace is
//! another Claude account and is not listed at all. Those rules live in the
//! renderer, which owns projects and chats; Rust only carries the question.

use serde_json::{json, Value};
use std::time::Duration;

use crate::util;

/// Long enough to read a prompt and think about it, the same as `nyra_secret`.
const START_TIMEOUT: Duration = Duration::from_secs(600);
/// A read may stop to ask about another project, which the window holds for
/// up to two minutes. A read that does not ask answers at once.
const READ_TIMEOUT: Duration = Duration::from_secs(125);

pub fn tool_schema() -> Value {
    json!({
        "name": "nyra_chat",
        "description": "Start a new Nyra chat (the user approves each), or check on other chats: list/status give state, never messages; read gives the last reply of a chat you started.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "action": { "type": "string", "enum": ["start", "list", "status", "read", "projects"] },
                "title": { "type": "string" },
                "reason": { "type": "string", "description": "Why a separate chat, one line." },
                "prompt": { "type": "string", "description": "Its first message. It sees none of this chat." },
                "model": { "type": "string" },
                "effort": { "type": "string" },
                "plan_mode": { "type": "boolean" },
                "project": { "type": "string", "description": "Name, from projects." },
                "chat": { "type": "string", "description": "Id, from list." }
            },
            "required": ["action"]
        }
    })
}

fn arg(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

pub async fn tool(chat_id: &str, args: Value) -> Result<String, String> {
    let action = arg(&args, "action").ok_or("nyra_chat needs an action.")?;
    match action.as_str() {
        "start" => start(chat_id, &args).await,
        "list" => read_op("chat.list", json!({ "chatId": chat_id, "project": arg(&args, "project") })).await,
        "status" | "read" => {
            let chat = arg(&args, "chat")
                .ok_or_else(|| format!("nyra_chat action:\"{action}\" needs `chat`, an id from action:\"list\"."))?;
            read_op(&format!("chat.{action}"), json!({ "chatId": chat_id, "chat": chat })).await
        }
        "projects" => read_op("chat.projects", json!({ "chatId": chat_id })).await,
        other => Err(format!("Unknown action '{other}'. nyra_chat takes start, list, status, read or projects.")),
    }
}

/// The arguments of a start, checked before anyone is asked.
fn start_request(chat_id: &str, args: &Value) -> Result<Value, String> {
    let title = arg(args, "title").ok_or("nyra_chat start needs a `title`: a few words naming the work.")?;
    let prompt = arg(args, "prompt").ok_or(
        "nyra_chat start needs a `prompt`: the new chat's first message, in full. It sees none of this conversation.",
    )?;
    let effort = arg(args, "effort");
    if let Some(e) = &effort {
        if !crate::claude::CLAUDE_EFFORTS.contains(&e.as_str()) {
            return Err(format!(
                "`effort` is one of {}, not \"{e}\".",
                crate::claude::CLAUDE_EFFORTS.join(", ")
            ));
        }
    }
    Ok(json!({
        "chatId": chat_id,
        "title": title,
        "reason": arg(args, "reason").unwrap_or_default(),
        "prompt": prompt,
        "model": arg(args, "model"),
        "effort": effort,
        "planMode": args.get("plan_mode").and_then(Value::as_bool).unwrap_or(false),
        "project": arg(args, "project"),
    }))
}

async fn start(chat_id: &str, args: &Value) -> Result<String, String> {
    let request = start_request(chat_id, args)?;

    let focused = util::main_window().and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if !focused {
        let title = request["title"].as_str().unwrap_or("a new chat");
        crate::notify_user::notify("Claude wants to start a chat", title, chat_id);
    }

    let answer = crate::app_mcp::ask_renderer_within(START_TIMEOUT, "chat.start", request).await;
    match answer {
        Ok(v) => start_summary(&v),
        Err(_) => Ok(pretty(&json!({
            "outcome": "no_answer",
            "note": "Nobody answered within 10 minutes. Carry on without it, or ask again later."
        }))),
    }
}

/// What Claude reads back. JSON, because the transcript card reads it too.
fn start_summary(answer: &Value) -> Result<String, String> {
    if answer.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(answer
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the chat could not be started")
            .to_string());
    }
    let mut out = answer.clone();
    if let Value::Object(map) = &mut out {
        map.remove("ok");
        let note = match map.get("outcome").and_then(Value::as_str) {
            Some("started") => {
                "Started. It runs on its own; check on it with action:\"status\", and once it is idle, action:\"read\" gives its last reply."
            }
            Some("declined") if map.get("message").is_some_and(|m| m.as_str().is_some_and(|s| !s.is_empty())) => {
                "The user declined, and said why in `message`. Act on that rather than asking again."
            }
            Some("declined") => "The user declined. Don't ask again for the same work unless they bring it up.",
            _ => "The request was withdrawn before anyone answered.",
        };
        map.insert("note".into(), json!(note));
    }
    Ok(pretty(&out))
}

async fn read_op(op: &str, args: Value) -> Result<String, String> {
    let answer = crate::app_mcp::ask_renderer_within(READ_TIMEOUT, op, args).await?;
    if answer.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(answer
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Nyra could not answer")
            .to_string());
    }
    let mut out = answer;
    if let Value::Object(map) = &mut out {
        map.remove("ok");
    }
    Ok(pretty(&out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_start_is_checked_before_anyone_is_asked() {
        let no_title = start_request("c", &json!({ "prompt": "do it" })).unwrap_err();
        assert!(no_title.contains("title"), "{no_title}");
        let no_prompt = start_request("c", &json!({ "title": "Fix it" })).unwrap_err();
        assert!(no_prompt.contains("prompt"), "{no_prompt}");
        let bad_effort =
            start_request("c", &json!({ "title": "Fix it", "prompt": "do it", "effort": "ludicrous" })).unwrap_err();
        assert!(bad_effort.contains("xhigh"), "{bad_effort}");

        let ok = start_request(
            "c",
            &json!({ "title": " Fix it ", "prompt": "do it", "effort": "high", "plan_mode": true, "model": "" }),
        )
        .unwrap();
        assert_eq!(ok["title"], "Fix it");
        assert_eq!(ok["effort"], "high");
        assert_eq!(ok["planMode"], true);
        // An empty model is no model, so the chat gets the default.
        assert_eq!(ok["model"], Value::Null);
        assert_eq!(ok["chatId"], "c");
    }

    #[test]
    fn a_decline_with_a_message_says_to_act_on_it() {
        let declined = start_summary(&json!({ "ok": true, "outcome": "declined", "message": "Not yet" })).unwrap();
        assert!(declined.contains("said why"), "{declined}");
        let bare = start_summary(&json!({ "ok": true, "outcome": "declined" })).unwrap();
        assert!(bare.contains("Don't ask again"), "{bare}");
        let started = start_summary(&json!({ "ok": true, "outcome": "started", "chat": "x" })).unwrap();
        assert!(started.contains("action:\\\"read\\\""), "{started}");
        assert!(!started.contains("\"ok\""), "{started}");
        let refused = start_summary(&json!({ "ok": false, "error": "No project called web" })).unwrap_err();
        assert_eq!(refused, "No project called web");
    }

    #[tokio::test]
    async fn reads_say_what_they_need() {
        let no_chat = tool("c", json!({ "action": "status" })).await.unwrap_err();
        assert!(no_chat.contains("chat"), "{no_chat}");
        let no_chat = tool("c", json!({ "action": "read" })).await.unwrap_err();
        assert!(no_chat.contains("list"), "{no_chat}");
        let bogus = tool("c", json!({ "action": "fork" })).await.unwrap_err();
        assert!(bogus.contains("start, list"), "{bogus}");
    }
}
