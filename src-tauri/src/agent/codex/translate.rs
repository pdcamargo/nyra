//! Codex's app-server notifications, as Nyra's events.
//!
//! Pure apart from reading files: a chat's [`Translator`] takes what the server
//! said and returns what to emit, so the mapping is testable against the
//! shapes a real 0.163 build sends. Tool calls take Claude's names and input
//! shapes — Bash, Edit, Write, WebSearch, `mcp__server__tool` — which are what
//! every card in the renderer already knows how to draw.

use std::collections::HashMap;

use serde_json::{json, Value};

use crate::agent::Usage;

pub enum Out {
    Event(Value),
    Usage(Usage),
    /// The turn is over; nothing more for it arrives after this.
    Finished(Finish),
}

#[derive(Debug, PartialEq, Eq)]
pub enum TurnStatus {
    Completed,
    Interrupted,
    Failed,
}

#[derive(Debug)]
pub struct Finish {
    pub status: TurnStatus,
    /// The final answer, or the reason it failed.
    pub text: String,
}

/// One file of a patch, held from the moment it is proposed until it lands.
#[derive(Debug, Clone)]
struct PendingFile {
    path: String,
    /// The file before the patch; None when the patch creates it.
    before: Option<String>,
    diff: String,
}

/// What the permission dialog shows for one of the server's approval requests.
#[derive(Debug, PartialEq)]
pub struct Approval {
    pub tool_id: String,
    pub tool_name: String,
    pub input: Value,
    pub original: Option<String>,
    pub kind: ApprovalKind,
}

/// How an answer to an approval is worded: commands and patches take a
/// decision, an MCP server's elicitation an action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalKind {
    Decision,
    Elicitation,
}

impl ApprovalKind {
    pub fn answer(self, approved: bool) -> Value {
        match (self, approved) {
            (ApprovalKind::Decision, true) => json!({ "decision": "accept" }),
            (ApprovalKind::Decision, false) => json!({ "decision": "decline" }),
            (ApprovalKind::Elicitation, true) => json!({ "action": "accept", "content": {}, "_meta": null }),
            (ApprovalKind::Elicitation, false) => json!({ "action": "decline", "content": null, "_meta": null }),
        }
    }
}

#[derive(Default)]
pub struct Translator {
    final_text: String,
    last_error: Option<String>,
    /// Commands announced and not completed. Codex abandons an attempt when it
    /// retries outside its sandbox, and that one never completes.
    open_commands: Vec<String>,
    /// Patches proposed and not yet applied, by item id.
    patches: HashMap<String, Vec<PendingFile>>,
    context_window: Option<i64>,
    /// Subagents still running, by the thread each runs in: the id of the
    /// card that started it. The card closes when a later call reports the
    /// agent done — `spawnAgent` itself returns as soon as the agent starts.
    agents: HashMap<String, String>,
    /// Each running subagent's latest message, by its thread: what its card
    /// reports when it is done.
    agent_messages: HashMap<String, String>,
}

impl Translator {
    pub fn turn_started(&mut self) {
        self.final_text.clear();
        self.last_error = None;
    }

    /// `read` is how a file's current contents are got, so a patch card can
    /// diff the whole file rather than the hunk.
    pub fn notification(&mut self, method: &str, params: &Value, read: &dyn Fn(&str) -> Option<String>) -> Vec<Out> {
        let item = params.get("item").unwrap_or(&Value::Null);
        match method {
            "item/started" => self.item_started(item, read),
            "item/completed" => self.item_completed(item, read),
            "item/agentMessage/delta" => {
                let text = str_at(params, "delta");
                if text.is_empty() {
                    Vec::new()
                } else {
                    vec![event(json!({ "type": "assistant_delta", "text": text }))]
                }
            }
            "thread/tokenUsage/updated" => self.token_usage(params.get("tokenUsage").unwrap_or(&Value::Null)),
            "thread/name/updated" => match params.get("threadName").and_then(Value::as_str).filter(|n| !n.trim().is_empty()) {
                Some(name) => vec![event(json!({ "type": "ai_title", "title": name, "fresh": true }))],
                None => Vec::new(),
            },
            "error" => {
                // Reported again by the turn that failed; kept for when that
                // one arrives without a message of its own.
                if params.get("willRetry").and_then(Value::as_bool) != Some(true) {
                    self.last_error = params.pointer("/error/message").and_then(Value::as_str).map(str::to_string);
                }
                Vec::new()
            }
            "turn/completed" => self.turn_completed(params.get("turn").unwrap_or(&Value::Null)),
            _ => Vec::new(),
        }
    }

    fn item_started(&mut self, item: &Value, read: &dyn Fn(&str) -> Option<String>) -> Vec<Out> {
        let id = str_at(item, "id");
        match str_at(item, "type") {
            "agentMessage" => vec![event(json!({ "type": "assistant_delta", "text": "", "reset": true }))],
            "reasoning" => vec![event(json!({ "type": "thinking", "thinking": "" }))],
            "commandExecution" => {
                self.open_commands.push(id.to_string());
                announce(id, "Bash", json!({ "command": display_command(item) }), None)
            }
            "fileChange" => {
                // Read now, before the patch lands, so the card has both sides.
                let files = item
                    .get("changes")
                    .and_then(Value::as_array)
                    .map(|changes| {
                        changes
                            .iter()
                            .map(|c| {
                                let path = str_at(c, "path").to_string();
                                let added = c.pointer("/kind/type").and_then(Value::as_str) == Some("add");
                                PendingFile {
                                    before: if added { None } else { read(&path) },
                                    path,
                                    diff: str_at(c, "diff").to_string(),
                                }
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                self.patches.insert(id.to_string(), files);
                Vec::new()
            }
            "mcpToolCall" => {
                let name = format!("mcp__{}__{}", str_at(item, "server"), str_at(item, "tool"));
                let args = item.get("arguments").cloned().unwrap_or(json!({}));
                announce(id, &name, args, None)
            }
            "webSearch" => announce(id, "WebSearch", json!({ "query": str_at(item, "query") }), None),
            // Only the spawn gets a card. The rest — wait, send input, close —
            // are the parent tending its agents, which the agent's own card
            // already reports the outcome of.
            "collabAgentToolCall" if str_at(item, "tool") == "spawnAgent" => {
                let prompt = str_at(item, "prompt");
                let description: String = prompt.lines().next().unwrap_or("Subagent").chars().take(60).collect();
                let model = item.get("model").and_then(Value::as_str).unwrap_or("codex");
                announce(id, "Agent", json!({ "description": description, "subagent_type": model, "prompt": prompt }), None)
            }
            "imageView" => announce(id, "Read", json!({ "file_path": str_at(item, "path") }), None),
            _ => Vec::new(),
        }
    }

    fn item_completed(&mut self, item: &Value, read: &dyn Fn(&str) -> Option<String>) -> Vec<Out> {
        let id = str_at(item, "id");
        let status = str_at(item, "status");
        match str_at(item, "type") {
            "agentMessage" => {
                let text = str_at(item, "text");
                if text.trim().is_empty() {
                    return Vec::new();
                }
                self.final_text = text.to_string();
                vec![event(json!({ "type": "assistant_text", "text": text }))]
            }
            "commandExecution" => {
                self.open_commands.retain(|c| c != id);
                let output = str_at(item, "aggregatedOutput");
                let failed = status != "completed" || item.get("exitCode").and_then(Value::as_i64).is_some_and(|c| c != 0);
                let content = if status == "declined" { "Declined" } else { output };
                vec![result(id, content, failed)]
            }
            "fileChange" => {
                let files = self.patches.remove(id).unwrap_or_default();
                let many = files.len() > 1;
                let mut out = Vec::new();
                for (i, file) in files.into_iter().enumerate() {
                    let tool_id = if many { format!("{id}#{i}") } else { id.to_string() };
                    let after = read(&file.path).unwrap_or_default();
                    // An existing file is an Edit of the whole of it, so the card
                    // reads "Edited" and diffs before against after.
                    out.extend(match file.before {
                        Some(before) => announce(
                            &tool_id,
                            "Edit",
                            json!({ "file_path": file.path, "old_string": before, "new_string": after }),
                            None,
                        ),
                        None => announce(&tool_id, "Write", json!({ "file_path": file.path, "content": after }), Some(String::new())),
                    });
                    let (content, failed) = match status {
                        "completed" => ("Applied", false),
                        "declined" => ("Declined", true),
                        _ => ("Failed", true),
                    };
                    out.push(result(&tool_id, content, failed));
                }
                out
            }
            "mcpToolCall" => {
                let error = item.pointer("/error/message").and_then(Value::as_str);
                let content = match error {
                    Some(e) => e.to_string(),
                    None => item
                        .pointer("/result/content")
                        .and_then(Value::as_array)
                        .map(|parts| parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"))
                        .unwrap_or_default(),
                };
                vec![result(id, &content, error.is_some())]
            }
            "webSearch" | "imageView" => vec![result(id, "", false)],
            "collabAgentToolCall" => self.agents_settled(id, item),
            "subAgentActivity" => self.sub_agent_activity(item),
            "contextCompaction" => vec![event(json!({ "type": "compact_boundary", "trigger": "manual" }))],
            _ => Vec::new(),
        }
    }

    /// What a subagent said last, from its own thread. Its card shows it.
    pub fn child_message(&mut self, thread: &str, text: &str) {
        if self.agents.contains_key(thread) && !text.trim().is_empty() {
            self.agent_messages.insert(thread.to_string(), text.to_string());
        }
    }

    /// Codex's multi-agent v2: one item when an agent starts, one when it ends.
    /// The card is keyed by the agent's thread, which is all the two share.
    fn sub_agent_activity(&mut self, item: &Value) -> Vec<Out> {
        let thread = str_at(item, "agentThreadId");
        let card = format!("agent-{thread}");
        match str_at(item, "kind") {
            "started" => {
                if self.agents.contains_key(thread) {
                    return Vec::new();
                }
                self.agents.insert(thread.to_string(), card.clone());
                // `/root/count_notes` → "count notes": the name Codex gave it.
                let name = str_at(item, "agentPath").rsplit('/').next().unwrap_or_default().replace(['_', '-'], " ");
                let model = item.get("model").and_then(Value::as_str).unwrap_or("codex");
                let description = if name.trim().is_empty() { "Subagent".to_string() } else { name };
                announce(&card, "Agent", json!({ "description": description, "subagent_type": model }), None)
            }
            kind => match self.agents.remove(thread) {
                Some(card) => {
                    let said = self.agent_messages.remove(thread).unwrap_or_else(|| kind.to_string());
                    vec![result(&card, &said, kind != "completed")]
                }
                None => Vec::new(),
            },
        }
    }

    /// A collab call finished: a spawn registers the agents it started, and any
    /// call that reports an agent finished closes that agent's card.
    fn agents_settled(&mut self, id: &str, item: &Value) -> Vec<Out> {
        let mut out = Vec::new();
        if str_at(item, "tool") == "spawnAgent" {
            if str_at(item, "status") == "failed" {
                return vec![result(id, "Codex could not start this agent.", true)];
            }
            for thread in item.get("receiverThreadIds").and_then(Value::as_array).into_iter().flatten() {
                if let Some(thread) = thread.as_str() {
                    self.agents.insert(thread.to_string(), id.to_string());
                }
            }
        }
        let states = item.get("agentsStates").and_then(Value::as_object);
        for (thread, state) in states.into_iter().flatten() {
            let status = str_at(state, "status");
            if !matches!(status, "completed" | "errored" | "interrupted" | "shutdown" | "notFound") {
                continue;
            }
            if let Some(card) = self.agents.remove(thread) {
                let message = state.get("message").and_then(Value::as_str).unwrap_or(status);
                out.push(result(&card, message, status != "completed"));
            }
        }
        out
    }

    /// Per model call, like Claude's per-message usage. `last.inputTokens`
    /// counts cached input too, so the cached share is split out to match
    /// Anthropic's buckets.
    fn token_usage(&mut self, usage: &Value) -> Vec<Out> {
        let last = usage.get("last").unwrap_or(&Value::Null);
        let num = |k: &str| last.get(k).and_then(Value::as_i64).unwrap_or(0);
        let (input, cached, written, output) =
            (num("inputTokens"), num("cachedInputTokens"), num("cacheWriteInputTokens"), num("outputTokens"));
        let normalized = Usage {
            input_tokens: (input - cached - written).max(0),
            output_tokens: output,
            cache_creation_input_tokens: written,
            cache_read_input_tokens: cached,
        };
        let mut out = vec![
            event(json!({
                "type": "usage",
                "input_tokens": normalized.input_tokens,
                "output_tokens": normalized.output_tokens,
                "cache_creation_input_tokens": normalized.cache_creation_input_tokens,
                "cache_read_input_tokens": normalized.cache_read_input_tokens,
                // What the next call reads back: all of this one's input and output.
                "context_tokens": input + output,
            })),
            Out::Usage(normalized),
        ];
        if let Some(window) = usage.get("modelContextWindow").and_then(Value::as_i64) {
            if self.context_window.replace(window) != Some(window) {
                out.push(event(json!({ "type": "context_window", "tokens": window })));
            }
        }
        out
    }

    fn turn_completed(&mut self, turn: &Value) -> Vec<Out> {
        let mut out: Vec<Out> = std::mem::take(&mut self.open_commands)
            .into_iter()
            .map(|id| result(&id, "Not run: Codex retried it another way.", false))
            .collect();
        self.patches.clear();
        let (status, text) = match str_at(turn, "status") {
            "interrupted" => (TurnStatus::Interrupted, String::new()),
            "failed" => {
                let reason = turn
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .or_else(|| self.last_error.take())
                    .unwrap_or_else(|| "Codex could not finish this turn.".to_string());
                (TurnStatus::Failed, reason)
            }
            _ => (TurnStatus::Completed, std::mem::take(&mut self.final_text)),
        };
        out.push(Out::Finished(Finish { status, text }));
        out
    }

    /// The card for one of the server's approval requests. None for a request
    /// Nyra has no dialog for.
    pub fn approval(&self, method: &str, params: &Value) -> Option<Approval> {
        let item = str_at(params, "itemId").to_string();
        match method {
            "item/commandExecution/requestApproval" => {
                let mut input = json!({ "command": display_command(params) });
                if let Some(reason) = params.get("reason").and_then(Value::as_str) {
                    input["description"] = json!(reason);
                }
                Some(Approval { tool_id: item, tool_name: "Bash".into(), input, original: None, kind: ApprovalKind::Decision })
            }
            "item/fileChange/requestApproval" => {
                // The dialog shows one file; a patch over several is rare and
                // the cards that follow it show them all.
                let file = self.patches.get(&item).and_then(|files| files.first());
                let Some(file) = file else {
                    return Some(Approval { tool_id: item, tool_name: "Edit".into(), input: json!({}), original: None, kind: ApprovalKind::Decision });
                };
                Some(match &file.before {
                    None => Approval {
                        tool_id: item,
                        tool_name: "Write".into(),
                        input: json!({ "file_path": file.path, "content": file.diff }),
                        original: None,
                        kind: ApprovalKind::Decision,
                    },
                    Some(before) => {
                        let (old, new) = split_unified_diff(&file.diff);
                        Approval {
                            tool_id: item,
                            tool_name: "Edit".into(),
                            input: json!({ "file_path": file.path, "old_string": old, "new_string": new }),
                            original: Some(before.clone()),
                            kind: ApprovalKind::Decision,
                        }
                    }
                })
            }
            // An MCP server asking before one of its tools runs. Shown as the
            // tool it is about, named the way Claude names MCP tools, so the
            // dialog and "always allow" treat both CLIs' calls alike.
            "mcpServer/elicitation/request" => {
                let server = str_at(params, "serverName");
                let meta = params.get("_meta").unwrap_or(&Value::Null);
                // 0.163 names the tool only in the message: `Allow the nyra-app
                // MCP server to run tool "nyra_agent"?`
                let message = str_at(params, "message");
                let tool = message.split("tool \"").nth(1).and_then(|rest| rest.split('"').next()).unwrap_or_default();
                let tool_name = if tool.is_empty() { format!("mcp__{server}") } else { format!("mcp__{server}__{tool}") };
                // The call's own arguments, as the dialog shows any tool's input.
                let input = meta
                    .get("tool_params")
                    .filter(|p| p.is_object())
                    .cloned()
                    .unwrap_or_else(|| json!({ "message": message }));
                Some(Approval {
                    tool_id: format!("elicitation-{}", params.get("elicitationId").and_then(Value::as_str).unwrap_or(server)),
                    tool_name,
                    input,
                    original: None,
                    kind: ApprovalKind::Elicitation,
                })
            }
            _ => None,
        }
    }
}

/// An account's Codex limits as the `rate_limit` event Claude's arrive as.
///
/// Codex reports windows by length — your plan's might be five hours, a week,
/// or only the week — so each is keyed by it, `codex_10080` for the weekly,
/// and the menu names them from that. A rolling update can leave a window out;
/// one left out is not sent, so the reading already held stands. None when the
/// snapshot carries no window at all.
pub fn rate_limit_event(snapshot: &Value) -> Option<Value> {
    let mut windows = serde_json::Map::new();
    let mut tightest: Option<(String, f64, i64)> = None;
    for slot in ["primary", "secondary"] {
        let Some(window) = snapshot.get(slot).filter(|w| w.is_object()) else { continue };
        let (Some(used), Some(resets_at)) = (
            window.get("usedPercent").and_then(Value::as_f64),
            window.get("resetsAt").and_then(Value::as_i64),
        ) else {
            continue;
        };
        let minutes = window.get("windowDurationMins").and_then(Value::as_i64).unwrap_or(0);
        let key = format!("codex_{minutes}");
        windows.insert(key.clone(), json!({ "resetsAt": resets_at, "utilization": used / 100.0 }));
        if tightest.as_ref().is_none_or(|(_, u, _)| used > *u) {
            tightest = Some((key, used, resets_at));
        }
    }
    let (key, _, resets_at) = tightest?;
    let limited = snapshot.get("rateLimitReachedType").is_some_and(|t| !t.is_null());
    Some(json!({
        "type": "rate_limit",
        "status": if limited { "throttled" } else { "allowed" },
        "resetsAt": resets_at,
        "rateLimitType": key,
        "windows": windows,
    }))
}

fn event(value: Value) -> Out {
    Out::Event(value)
}

fn announce(tool_id: &str, tool_name: &str, input: Value, original: Option<String>) -> Vec<Out> {
    let mut input_event = json!({ "type": "tool_input", "tool_id": tool_id, "tool_name": tool_name, "input": input });
    if let Some(original) = original {
        input_event["originalContent"] = json!(original);
    }
    vec![
        event(json!({ "type": "tool_start", "tool_id": tool_id, "tool_name": tool_name })),
        event(input_event),
    ]
}

fn result(tool_id: &str, content: &str, is_error: bool) -> Out {
    event(json!({ "type": "tool_result", "tool_id": tool_id, "content": content, "is_error": is_error }))
}

fn str_at<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// What the user would have typed. `command` arrives wrapped in the shell Codex
/// picked — `pwsh.exe -Command 'git status'` — and the parsed actions carry it bare.
fn display_command(item: &Value) -> String {
    let actions: Vec<&str> = item
        .get("commandActions")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.get("command").and_then(Value::as_str)).collect())
        .unwrap_or_default();
    if actions.is_empty() {
        str_at(item, "command").to_string()
    } else {
        actions.join(" && ")
    }
}

/// A unified diff's two sides, for the Edit card of a patch not yet applied.
fn split_unified_diff(diff: &str) -> (String, String) {
    let (mut old, mut new) = (Vec::new(), Vec::new());
    // Codex's diffs keep the file's own line endings, CRLF on Windows.
    for line in diff.lines().map(|l| l.strip_suffix('\r').unwrap_or(l)) {
        if line.starts_with("---") || line.starts_with("+++") || line.starts_with("@@") {
            continue;
        }
        match line.chars().next() {
            Some('-') => old.push(&line[1..]),
            Some('+') => new.push(&line[1..]),
            Some(' ') => {
                old.push(&line[1..]);
                new.push(&line[1..]);
            }
            _ => {}
        }
    }
    // Whole lines, each with its end, or the last one reads as changed.
    let lines = |side: Vec<&str>| side.iter().map(|l| format!("{l}\n")).collect::<String>();
    (lines(old), lines(new))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn events(out: &[Out]) -> Vec<Value> {
        out.iter()
            .filter_map(|o| match o {
                Out::Event(v) => Some(v.clone()),
                _ => None,
            })
            .collect()
    }

    fn types(out: &[Out]) -> Vec<String> {
        events(out).iter().map(|e| e["type"].as_str().unwrap().to_string()).collect()
    }

    fn no_files(_: &str) -> Option<String> {
        None
    }

    // As 0.163 sends them on Windows, trimmed to the fields that are read.
    fn command(status: &str, exit: Option<i64>) -> Value {
        json!({
            "type": "commandExecution",
            "id": "exec-1",
            "command": "\"C:\\\\Windows\\\\pwsh.exe\" -Command 'git status'",
            "commandActions": [{ "type": "unknown", "command": "git status" }],
            "status": status,
            "aggregatedOutput": "On branch master\n",
            "exitCode": exit,
        })
    }

    #[test]
    fn a_command_is_a_bash_card_with_the_bare_command() {
        let mut t = Translator::default();
        let started = t.notification("item/started", &json!({ "item": command("inProgress", None) }), &no_files);
        let started = events(&started);
        assert_eq!(started[0], json!({ "type": "tool_start", "tool_id": "exec-1", "tool_name": "Bash" }));
        assert_eq!(started[1]["input"], json!({ "command": "git status" }));

        let done = events(&t.notification("item/completed", &json!({ "item": command("completed", Some(0)) }), &no_files));
        assert_eq!(done[0], json!({ "type": "tool_result", "tool_id": "exec-1", "content": "On branch master\n", "is_error": false }));
    }

    #[test]
    fn a_nonzero_exit_is_an_error() {
        let mut t = Translator::default();
        let done = events(&t.notification("item/completed", &json!({ "item": command("failed", Some(1)) }), &no_files));
        assert_eq!(done[0]["is_error"], true);
    }

    #[test]
    fn a_command_abandoned_for_a_retry_is_closed_when_the_turn_ends() {
        let mut t = Translator::default();
        t.notification("item/started", &json!({ "item": command("inProgress", None) }), &no_files);
        let out = t.notification("turn/completed", &json!({ "turn": { "status": "completed" } }), &no_files);
        assert_eq!(types(&out), ["tool_result"]);
        assert!(matches!(out.last(), Some(Out::Finished(Finish { status: TurnStatus::Completed, .. }))));
    }

    #[test]
    fn text_streams_then_lands_and_is_the_turns_answer() {
        let mut t = Translator::default();
        let start = t.notification("item/started", &json!({ "item": { "type": "agentMessage", "id": "m", "text": "" } }), &no_files);
        assert_eq!(events(&start)[0], json!({ "type": "assistant_delta", "text": "", "reset": true }));
        let delta = t.notification("item/agentMessage/delta", &json!({ "delta": "DO" }), &no_files);
        assert_eq!(events(&delta)[0], json!({ "type": "assistant_delta", "text": "DO" }));
        let done = t.notification("item/completed", &json!({ "item": { "type": "agentMessage", "id": "m", "text": "DONE" } }), &no_files);
        assert_eq!(events(&done)[0], json!({ "type": "assistant_text", "text": "DONE" }));
        let end = t.notification("turn/completed", &json!({ "turn": { "status": "completed" } }), &no_files);
        match end.last() {
            Some(Out::Finished(f)) => assert_eq!(f.text, "DONE"),
            _ => panic!("no finish"),
        }
    }

    #[test]
    fn a_patch_to_an_existing_file_is_an_edit_of_the_whole_file() {
        let mut t = Translator::default();
        let change = json!({ "path": "C:\\w\\README.md", "kind": { "type": "update", "move_path": null }, "diff": "@@ -1 +1,2 @@\n # scratch\r\n+edited\r\n" });
        let before = |_: &str| Some("# scratch\r\n".to_string());
        t.notification("item/started", &json!({ "item": { "type": "fileChange", "id": "p", "changes": [change], "status": "inProgress" } }), &before);

        let ask = t.approval("item/fileChange/requestApproval", &json!({ "itemId": "p" })).unwrap();
        assert_eq!(ask.tool_name, "Edit");
        assert_eq!(ask.input["old_string"], "# scratch\n");
        assert_eq!(ask.input["new_string"], "# scratch\nedited\n");

        let after = |_: &str| Some("# scratch\r\nedited\r\n".to_string());
        let done = events(&t.notification("item/completed", &json!({ "item": { "type": "fileChange", "id": "p", "status": "completed" } }), &after));
        assert_eq!(done[1]["tool_name"], "Edit");
        assert_eq!(done[1]["input"]["old_string"], "# scratch\r\n");
        assert_eq!(done[1]["input"]["new_string"], "# scratch\r\nedited\r\n");
        assert_eq!(done[2]["content"], "Applied");
    }

    #[test]
    fn a_patch_that_creates_a_file_is_a_write() {
        let mut t = Translator::default();
        let change = json!({ "path": "notes.txt", "kind": { "type": "add" }, "diff": "one\ntwo\n" });
        t.notification("item/started", &json!({ "item": { "type": "fileChange", "id": "p", "changes": [change] } }), &no_files);
        assert_eq!(t.approval("item/fileChange/requestApproval", &json!({ "itemId": "p" })).unwrap().tool_name, "Write");
        let written = |_: &str| Some("one\ntwo\n".to_string());
        let done = events(&t.notification("item/completed", &json!({ "item": { "type": "fileChange", "id": "p", "status": "completed" } }), &written));
        assert_eq!(done[1]["tool_name"], "Write");
        assert_eq!(done[1]["input"]["content"], "one\ntwo\n");
    }

    #[test]
    fn usage_splits_the_cached_share_out_and_reports_the_window_once() {
        let mut t = Translator::default();
        let usage = json!({ "tokenUsage": { "last": { "inputTokens": 16526, "cachedInputTokens": 13440, "cacheWriteInputTokens": 0, "outputTokens": 75 }, "modelContextWindow": 828400 } });
        let first = events(&t.notification("thread/tokenUsage/updated", &usage, &no_files));
        assert_eq!(first[0]["input_tokens"], 3086);
        assert_eq!(first[0]["cache_read_input_tokens"], 13440);
        assert_eq!(first[0]["context_tokens"], 16601);
        assert_eq!(first[1], json!({ "type": "context_window", "tokens": 828400 }));
        let second = events(&t.notification("thread/tokenUsage/updated", &usage, &no_files));
        assert_eq!(second.len(), 1);
    }

    #[test]
    fn a_failed_turn_carries_the_error_it_reported() {
        let mut t = Translator::default();
        t.notification("error", &json!({ "error": { "message": "usage limit reached" }, "willRetry": false }), &no_files);
        let out = t.notification("turn/completed", &json!({ "turn": { "status": "failed", "error": null } }), &no_files);
        match out.last() {
            Some(Out::Finished(f)) => {
                assert_eq!(f.status, TurnStatus::Failed);
                assert_eq!(f.text, "usage limit reached");
            }
            _ => panic!("no finish"),
        }
    }

    #[test]
    fn an_mcp_call_is_named_the_way_claude_names_them() {
        let mut t = Translator::default();
        let call = json!({ "item": { "type": "mcpToolCall", "id": "c", "server": "nyra-app", "tool": "nyra_ui", "arguments": { "action": "state" } } });
        assert_eq!(events(&t.notification("item/started", &call, &no_files))[0]["tool_name"], "mcp__nyra-app__nyra_ui");
    }

    #[test]
    fn a_subagent_is_an_agent_card_that_closes_when_it_is_reported_done() {
        let mut t = Translator::default();
        let spawn = |status: &str| json!({ "item": {
            "type": "collabAgentToolCall", "id": "s1", "tool": "spawnAgent", "status": status,
            "senderThreadId": "parent", "receiverThreadIds": ["child"], "prompt": "Survey the tests\nin detail",
            "model": "gpt-6-luna", "agentsStates": { "child": { "status": "running", "message": null } }
        } });
        let started = events(&t.notification("item/started", &spawn("inProgress"), &no_files));
        assert_eq!(started[1]["tool_name"], "Agent");
        assert_eq!(started[1]["input"]["description"], "Survey the tests");
        assert_eq!(started[1]["input"]["subagent_type"], "gpt-6-luna");

        // The spawn returns while the agent is still at work: nothing closes.
        assert!(events(&t.notification("item/completed", &spawn("completed"), &no_files)).is_empty());

        let wait = json!({ "item": {
            "type": "collabAgentToolCall", "id": "w1", "tool": "wait", "status": "completed",
            "receiverThreadIds": ["child"], "agentsStates": { "child": { "status": "completed", "message": "12 tests, all green" } }
        } });
        assert!(events(&t.notification("item/started", &wait, &no_files)).is_empty(), "a wait gets no card");
        let done = events(&t.notification("item/completed", &wait, &no_files));
        assert_eq!(done[0], json!({ "type": "tool_result", "tool_id": "s1", "content": "12 tests, all green", "is_error": false }));
    }

    #[test]
    fn codex_limits_arrive_as_claudes_rate_limit_event() {
        // As 0.163 reports a plan with only a weekly window.
        let snapshot = json!({ "limitId": "codex", "primary": { "usedPercent": 37.0, "windowDurationMins": 10080, "resetsAt": 1793300169 },
            "secondary": null, "rateLimitReachedType": null });
        assert_eq!(
            rate_limit_event(&snapshot),
            Some(json!({ "type": "rate_limit", "status": "allowed", "resetsAt": 1793300169, "rateLimitType": "codex_10080",
                "windows": { "codex_10080": { "resetsAt": 1793300169, "utilization": 0.37 } } }))
        );
        assert_eq!(rate_limit_event(&json!({ "primary": null, "secondary": null })), None);
    }

    #[test]
    fn a_v2_subagent_opens_a_card_and_reports_its_last_message() {
        let mut t = Translator::default();
        let activity = |kind: &str| json!({ "item": { "type": "subAgentActivity", "id": format!("a-{kind}"), "kind": kind,
            "model": "gpt-6.1-sol", "agentThreadId": "child", "agentPath": "/root/count_notes" } });
        let opened = events(&t.notification("item/completed", &activity("started"), &no_files));
        assert_eq!(opened[1]["tool_id"], "agent-child");
        assert_eq!(opened[1]["input"], json!({ "description": "count notes", "subagent_type": "gpt-6.1-sol" }));

        t.child_message("child", "notes.txt has 4 lines.");
        let closed = events(&t.notification("item/completed", &activity("completed"), &no_files));
        assert_eq!(closed[0], json!({ "type": "tool_result", "tool_id": "agent-child", "content": "notes.txt has 4 lines.", "is_error": false }));
        // Codex interrupts an agent that already finished; nothing is left to close.
        assert!(events(&t.notification("item/completed", &activity("interrupted"), &no_files)).is_empty());
    }

    #[test]
    fn an_mcp_elicitation_is_a_prompt_for_the_tool_it_names() {
        let t = Translator::default();
        // As 0.163 asks before an MCP tool call, trimmed.
        let params = json!({ "serverName": "nyra-app", "mode": "form", "requestedSchema": { "type": "object", "properties": {} },
            "message": "Allow the nyra-app MCP server to run tool \"nyra_agent\"?",
            "_meta": { "codex_approval_kind": "mcp_tool_call", "tool_params": { "action": "spawn", "provider": "claude" } } });
        let ask = t.approval("mcpServer/elicitation/request", &params).unwrap();
        assert_eq!(ask.tool_name, "mcp__nyra-app__nyra_agent");
        assert_eq!(ask.input, json!({ "action": "spawn", "provider": "claude" }));
        assert_eq!(ask.kind.answer(true), json!({ "action": "accept", "content": {}, "_meta": null }));
        assert_eq!(ApprovalKind::Decision.answer(false), json!({ "decision": "decline" }));
    }

    #[test]
    fn a_unified_diff_splits_into_both_sides() {
        assert_eq!(split_unified_diff("@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail\n"), ("keep\nold\ntail\n".into(), "keep\nnew\ntail\n".into()));
    }
}
