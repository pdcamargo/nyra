//! The app's own MCP server: Claude driving Nyra.
//!
//! A sibling of `/browser/mcp/{chat_id}`, and served the same way — one POST
//! carrying one JSON-RPC message, answered with one. The difference is who ends
//! up doing the work. The browser server relays to the sidecar because the
//! sidecar owns Playwright. Nothing here does: flows are files Rust already
//! reads, the updater is a Rust plugin, and the panels, the theme and the
//! command registry live in the renderer. So this one terminates here, and the
//! renderer half is reached through `ask_renderer` rather than a second process.
//!
//! The rule the browser's local tools already set still holds: the model asks,
//! the owner of the state changes it, and the UI finds out through the channel
//! it already had. Nothing is driven by synthesising input.
//!
//! **Three tools, on purpose.** Every schema here is in the context window of
//! every turn of every chat that has this attached, whether or not it is ever
//! used. So the catalogues — forty commands, the node types, the valid targets
//! — live in what a call *returns*, never in what it declares. `nyra_ui` with
//! `action: "commands"` is the menu; the schema just says the menu exists.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tokio::sync::oneshot;

use crate::util;
use crate::workflow::types::WorkflowDefinition;

/// One secret per run, like the browser's. Loopback is not a boundary — every
/// process on the machine can reach a loopback port, and this one changes the
/// user's app.
static MCP_TOKEN: Lazy<String> = Lazy::new(|| util::rand_hex(16));

pub fn mcp_token() -> &'static str {
    &MCP_TOKEN
}

/// The `--mcp-config` entry, or nothing if the loopback server never came up.
pub fn mcp_endpoint(chat_id: &str) -> Option<(String, String)> {
    let port = crate::webhook_server::port()?;
    Some((
        format!("http://127.0.0.1:{port}/app/mcp/{chat_id}"),
        MCP_TOKEN.clone(),
    ))
}

// ---------------------------------------------------------------------------
// Asking the window
// ---------------------------------------------------------------------------
//
// Rust could already shout at the renderer — `util::emit` — but never ask it
// anything. Every existing event is one-way, and the one place that needed an
// answer, `devtools::eval_js`, gets it by evaluating arbitrary JavaScript
// through a debug-only route that does not exist in a release build.
//
// This is the missing half, and deliberately the narrow version of it: a named
// op with a JSON payload, answered by one subscriber. No code crosses.

type Pending = Mutex<HashMap<String, oneshot::Sender<Value>>>;
static PENDING: Lazy<Pending> = Lazy::new(|| Mutex::new(HashMap::new()));

/// How long to wait for the window. Generous for a store read that takes
/// microseconds, short enough that a wedged renderer fails the tool rather than
/// hanging the turn behind it.
const RENDERER_TIMEOUT: Duration = Duration::from_secs(3);

/// Put a question to the renderer and wait for its answer.
pub async fn ask_renderer(op: &str, args: Value) -> Result<Value, String> {
    let request_id = util::rand_hex(8);
    let (tx, rx) = oneshot::channel();
    PENDING.lock().insert(request_id.clone(), tx);

    util::emit(
        "nyra:app-request",
        json!({ "requestId": request_id, "op": op, "args": args }),
    );

    match tokio::time::timeout(RENDERER_TIMEOUT, rx).await {
        Ok(Ok(value)) => Ok(value),
        // The sender was dropped — the window went away mid-question.
        Ok(Err(_)) => {
            PENDING.lock().remove(&request_id);
            Err("the Nyra window closed before it answered".into())
        }
        Err(_) => {
            PENDING.lock().remove(&request_id);
            Err(format!(
                "the Nyra window did not answer '{op}' within {}s",
                RENDERER_TIMEOUT.as_secs()
            ))
        }
    }
}

/// The renderer's reply, routed back to whoever is waiting. An id nobody is
/// waiting on is dropped rather than logged loudly: a late answer to a timed-out
/// question is expected, not a fault.
pub fn deliver_response(request_id: &str, result: Value) {
    if let Some(tx) = PENDING.lock().remove(request_id) {
        let _ = tx.send(result);
    }
}

// ---------------------------------------------------------------------------
// Validating a flow before it is written
// ---------------------------------------------------------------------------
//
// `workflow_import` checks that `id`, `nodes` and `edges` are *present* and
// nothing more, so `{"nodes": "hello"}` imports "successfully", draws an empty
// canvas, and fails at run time with "Workflow not found" — the typed parse only
// happens in `load_workflow_typed`. A person hand-importing a file hits that
// rarely. A model writing flows would hit it constantly, and the failure would
// arrive minutes later somewhere unrelated.
//
// So: parse it here, and say what is wrong in terms the writer can act on.

/// Handles a node type is allowed to send an edge out of. `None` means the node
/// has one unnamed output and a handle on it is a mistake.
fn legal_handles(node_type: &str) -> Option<&'static [&'static str]> {
    match node_type {
        "condition" => Some(&["yes", "no"]),
        "loop" => Some(&["body", "exit"]),
        _ => None,
    }
}

/// Every problem with a definition, not just the first — a model fixing one
/// error at a time round-trips once per mistake.
pub fn validate_flow(raw: &Value) -> Result<WorkflowDefinition, Vec<String>> {
    let mut errors = Vec::new();

    let Some(object) = raw.as_object() else {
        return Err(vec!["a flow must be a JSON object".into()]);
    };
    for key in ["id", "name", "nodes", "edges"] {
        if !object.contains_key(key) {
            errors.push(format!("missing required field '{key}'"));
        }
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    // The typed parse is the real gate: it is what the engine will do later, so
    // anything it rejects is a flow that would have saved and then failed.
    let definition: WorkflowDefinition = match serde_json::from_value(raw.clone()) {
        Ok(d) => d,
        Err(e) => {
            return Err(vec![format!(
                "does not match the flow schema: {e}. Read the write-a-flow skill for the node types and their fields."
            )])
        }
    };

    if definition.nodes.is_empty() {
        errors.push("a flow needs at least one node".into());
    }

    let ids: HashSet<&str> = definition.nodes.iter().map(|n| n.id.as_str()).collect();
    if ids.len() != definition.nodes.len() {
        errors.push("two nodes share an id; every node id must be unique".into());
    }

    for edge in &definition.edges {
        if !ids.contains(edge.source.as_str()) {
            errors.push(format!(
                "edge '{}' starts at '{}', which is not a node in this flow",
                edge.id, edge.source
            ));
        }
        if !ids.contains(edge.target.as_str()) {
            errors.push(format!(
                "edge '{}' ends at '{}', which is not a node in this flow",
                edge.id, edge.target
            ));
        }

        // A handle that names nothing is the quiet one: the edge saves, draws,
        // and is never taken, so the branch simply never runs.
        let Some(handle) = edge.handle() else { continue };
        let source_type = definition
            .nodes
            .iter()
            .find(|n| n.id == edge.source)
            .map(|n| node_type_name(n));
        let Some(source_type) = source_type else { continue };
        match legal_handles(source_type) {
            Some(allowed) if !allowed.contains(&handle) => errors.push(format!(
                "edge '{}' leaves a {source_type} node by '{handle}', but a {source_type} only has {}",
                edge.id,
                allowed.join(" and ")
            )),
            None => errors.push(format!(
                "edge '{}' leaves a {source_type} node by '{handle}', but only condition and loop nodes have named outputs",
                edge.id
            )),
            _ => {}
        }
    }

    if errors.is_empty() {
        Ok(definition)
    } else {
        Err(errors)
    }
}

/// The `type` discriminator as it appears in JSON, for error text.
fn node_type_name(node: &crate::workflow::types::WorkflowNode) -> &'static str {
    use crate::workflow::types::WorkflowNodeData as D;
    match node.data {
        D::Prompt { .. } => "prompt",
        D::Condition { .. } => "condition",
        D::Script { .. } => "script",
        D::Parallel { .. } => "parallel",
        D::Join { .. } => "join",
        D::Loop { .. } => "loop",
        D::HumanReview { .. } => "humanReview",
        D::Subworkflow { .. } => "subworkflow",
    }
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------
//
// Read these as a token budget. Every word is carried by every turn of every
// chat, so a description earns its place by preventing a wrong call, not by
// being complete. Anything that is a *list* belongs in a result.

fn tool_schemas() -> Value {
    json!([
        {
            "name": "nyra_ui",
            "description": "Read Nyra's state, or run one of its commands. Start with action:\"state\" — it is cheap and tells you what is already open, so you never toggle something shut. action:\"commands\" lists everything runnable.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["state", "commands", "run", "open_file"],
                        "description": "state: panels, theme, version, active flow. commands: the runnable list. run: execute one. open_file: show a file in the side panel."
                    },
                    "command": { "type": "string", "description": "Command id, for action:\"run\"." },
                    "on": {
                        "type": "boolean",
                        "description": "For action:\"run\": true to open/enable, false to close/disable. Omit to flip. Prefer setting it — a bare run on a toggle closes what you meant to open."
                    },
                    "path": { "type": "string", "description": "Absolute path, for action:\"open_file\"." }
                },
                "required": ["action"]
            }
        },
        {
            "name": "nyra_flow",
            "description": "Nyra Flows: saved graphs of headless Claude runs, stored at ~/.nyra/workflows/<id>.json. Write one here instead of telling the user to import JSON. Read the write-a-flow skill before composing a definition.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "action": {
                        "type": "string",
                        "enum": ["list", "read", "write", "run", "open", "delete"],
                        "description": "write: create or replace (validated). open: show it on screen. run: execute it and wait — a flow of real Claude turns can take minutes, so prefer open and let the user press Run."
                    },
                    "id": { "type": "string", "description": "Flow id. Omit on write to create a new one." },
                    "definition": { "type": "object", "description": "The whole flow JSON, for action:\"write\"." },
                    "cwd": { "type": "string", "description": "Directory to run in, for action:\"run\"." },
                    "inputs": { "type": "object", "description": "Input values, for action:\"run\"." }
                },
                "required": ["action"]
            }
        },
        {
            "name": "nyra_update",
            "description": "Check whether a newer Nyra has been released. Reports the version and gives you a link to offer — installing restarts the app, so the user presses it, never you.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

// ---------------------------------------------------------------------------
// JSON-RPC
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION: &str = "2024-11-05";

/// Handle one message. `Null` means it was a notification and there is nothing
/// to answer with — the route turns that into a 202.
pub async fn handle(message: Value) -> Value {
    let id = message.get("id").cloned();
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");

    // A notification carries no id and expects no reply.
    if id.is_none() {
        return Value::Null;
    }
    let id = id.unwrap();

    match method {
        "initialize" => reply(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "nyra-app", "version": env!("CARGO_PKG_VERSION") }
            }),
        ),
        "ping" => reply(id, json!({})),
        "tools/list" => reply(id, json!({ "tools": tool_schemas() })),
        "tools/call" => {
            let name = message
                .get("params")
                .and_then(|p| p.get("name"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let args = message
                .get("params")
                .and_then(|p| p.get("arguments"))
                .cloned()
                .unwrap_or_else(|| json!({}));

            match call_tool(name, args).await {
                // The call happened and did not work: an MCP tool error, not a
                // JSON-RPC one, so the model reads why and tries something else
                // rather than seeing a protocol fault.
                Err(why) => reply(
                    id,
                    json!({ "content": [{ "type": "text", "text": why }], "isError": true }),
                ),
                Ok(text) => reply(id, json!({ "content": [{ "type": "text", "text": text }] })),
            }
        }
        other => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Unknown method {other}") }
        }),
    }
}

fn reply(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

async fn call_tool(name: &str, args: Value) -> Result<String, String> {
    match name {
        "nyra_ui" => ui_tool(args).await,
        "nyra_flow" => flow_tool(args).await,
        "nyra_update" => update_tool().await,
        other => Err(format!(
            "Unknown tool '{other}'. This server offers nyra_ui, nyra_flow and nyra_update."
        )),
    }
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| value.to_string())
}

fn arg_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------
// nyra_ui
// ---------------------------------------------------------------------------

async fn ui_tool(args: Value) -> Result<String, String> {
    let action = arg_str(&args, "action").ok_or("nyra_ui needs an action.")?;
    match action.as_str() {
        "state" => {
            let mut state = ask_renderer("state", json!({})).await?;
            // The version is Rust's to know; folding it in here keeps the model
            // from a second call for a one-line fact.
            if let Value::Object(map) = &mut state {
                map.insert("version".into(), json!(env!("CARGO_PKG_VERSION")));
            }
            Ok(pretty(&state))
        }
        "commands" => {
            let list = ask_renderer("commands", json!({})).await?;
            Ok(format!(
                "{}\n\nRun one with action:\"run\". Pass `on` for anything with a `state` field, so \"open\" cannot close it.",
                pretty(&list)
            ))
        }
        "run" => {
            let command = arg_str(&args, "command")
                .ok_or("nyra_ui action:\"run\" needs a command id. Use action:\"commands\" for the list.")?;
            let outcome = ask_renderer(
                "run",
                json!({ "command": command, "on": args.get("on").cloned() }),
            )
            .await?;
            if outcome.get("ok").and_then(Value::as_bool) == Some(false) {
                return Err(outcome
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("the command did not run")
                    .to_string());
            }
            Ok(format!(
                "Ran {}.{}\n\nTell the user what you changed, in one line.",
                outcome.get("label").and_then(Value::as_str).unwrap_or(&command),
                match outcome.get("state").and_then(Value::as_bool) {
                    Some(true) => " It is now open.",
                    Some(false) => " It is now closed.",
                    None => "",
                }
            ))
        }
        "open_file" => {
            let path = arg_str(&args, "path")
                .ok_or("nyra_ui action:\"open_file\" needs an absolute path.")?;
            ask_renderer("open_file", json!({ "path": path })).await?;
            Ok(format!("Opened {path} in the side panel."))
        }
        other => Err(format!(
            "Unknown action '{other}'. nyra_ui takes state, commands, run or open_file."
        )),
    }
}

// ---------------------------------------------------------------------------
// nyra_flow
// ---------------------------------------------------------------------------

/// How the model should refer to a flow in prose. Nyra renders this as a chip
/// that opens the flow; see `MarkdownRenderer.tsx`.
fn flow_link(id: &str, name: &str) -> String {
    format!("[{name}](nyra://flow/{id})")
}

async fn flow_tool(args: Value) -> Result<String, String> {
    use crate::workflow::store;

    let action = arg_str(&args, "action").ok_or("nyra_flow needs an action.")?;
    match action.as_str() {
        "list" => {
            let flows = store::list_workflows().await;
            if flows.is_empty() {
                return Ok("No flows yet. ~/.nyra/workflows/ is empty.".into());
            }
            let rows: Vec<Value> = flows
                .iter()
                .map(|f| {
                    json!({
                        "id": f.get("id").cloned().unwrap_or(Value::Null),
                        "name": f.get("name").cloned().unwrap_or(Value::Null),
                        "description": f.get("description").cloned().unwrap_or(Value::Null),
                        "nodes": f.get("nodes").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
                    })
                })
                .collect();
            Ok(format!(
                "{}\n\nStored at ~/.nyra/workflows/<id>.json. Link one as [Name](nyra://flow/<id>).",
                pretty(&json!(rows))
            ))
        }
        "read" => {
            let id = arg_str(&args, "id").ok_or("nyra_flow action:\"read\" needs an id.")?;
            let flow = store::load_workflow(&id)
                .await
                .ok_or_else(|| format!("No flow with id '{id}'. Use action:\"list\"."))?;
            Ok(pretty(&flow))
        }
        "write" => {
            let mut definition = args
                .get("definition")
                .cloned()
                .ok_or("nyra_flow action:\"write\" needs a `definition`. Read the write-a-flow skill first.")?;

            // A new flow gets an id and timestamps before validation, so the
            // model is never asked to invent either.
            let now = util::now_ms();
            if let Value::Object(map) = &mut definition {
                let id = arg_str(&args, "id")
                    .or_else(|| map.get("id").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_else(|| format!("wf-{now}"));
                map.insert("id".into(), json!(id));
                map.entry("createdAt").or_insert(json!(now));
                map.insert("updatedAt".into(), json!(now));
                map.entry("isTemplate").or_insert(json!(false));
            }

            let parsed = validate_flow(&definition).map_err(|errors| {
                format!(
                    "That flow will not load. Fix these and write again:\n{}",
                    errors.iter().map(|e| format!("  - {e}")).collect::<Vec<_>>().join("\n")
                )
            })?;

            // Through the command, not the store: `workflow_save` is also what
            // re-reads the triggers, and a flow saved behind its back would not
            // fire until the next launch.
            let saved = crate::commands::workflow_save(definition).await;
            if let Some(error) = saved.get("error").and_then(Value::as_str) {
                return Err(format!("Could not save: {error}"));
            }

            Ok(format!(
                "Saved to ~/.nyra/workflows/{id}.json.\n\nTell the user about it and link it as {link} — that renders as a chip they can click to open it. Use action:\"open\" as well if they should be looking at it now.",
                id = parsed.id,
                link = flow_link(&parsed.id, &parsed.name)
            ))
        }
        "open" => {
            let id = arg_str(&args, "id").ok_or("nyra_flow action:\"open\" needs an id.")?;
            let flow = store::load_workflow(&id)
                .await
                .ok_or_else(|| format!("No flow with id '{id}'. Use action:\"list\"."))?;
            ask_renderer("open_flow", json!({ "id": id })).await?;
            let name = flow.get("name").and_then(Value::as_str).unwrap_or(&id);
            Ok(format!(
                "Opened {name} in the Flows view. Say so — the user's screen just changed."
            ))
        }
        "run" => {
            let id = arg_str(&args, "id").ok_or("nyra_flow action:\"run\" needs an id.")?;
            let cwd = arg_str(&args, "cwd")
                .ok_or("nyra_flow action:\"run\" needs a `cwd` — the directory the flow's nodes run in.")?;
            let inputs: Option<HashMap<String, String>> = args
                .get("inputs")
                .and_then(|v| serde_json::from_value(v.clone()).ok());

            let result = crate::commands::workflow_run(id.clone(), cwd, inputs).await;
            if let Some(error) = result.get("error").and_then(Value::as_str) {
                return Err(format!("The run failed: {error}"));
            }
            Ok(format!(
                "Finished. Execution {}. The run is in the flow's History panel.",
                result.get("executionId").and_then(Value::as_str).unwrap_or("?")
            ))
        }
        "delete" => {
            let id = arg_str(&args, "id").ok_or("nyra_flow action:\"delete\" needs an id.")?;
            if store::load_workflow(&id).await.is_none() {
                return Err(format!("No flow with id '{id}'."));
            }
            let result = crate::commands::workflow_delete(id.clone()).await;
            if let Some(error) = result.get("error").and_then(Value::as_str) {
                return Err(format!("Could not delete: {error}"));
            }
            Ok(format!("Deleted {id}."))
        }
        other => Err(format!(
            "Unknown action '{other}'. nyra_flow takes list, read, write, run, open or delete."
        )),
    }
}

// ---------------------------------------------------------------------------
// nyra_update
// ---------------------------------------------------------------------------

/// Check only.
///
/// Installing calls `app.restart()`, which kills the CLI child that made this
/// call — the tool would never return and the reply would stop mid-sentence.
/// So the model reports, and the link it is handed is what the user presses.
async fn update_tool() -> Result<String, String> {
    let app = util::app_handle().ok_or("Nyra is still starting up.")?;
    let info = crate::updates::check(app).await?;

    if !info.available {
        return Ok(format!("Nyra {} is the latest version.", info.current));
    }

    // Light the badge the app already has, so this agrees with the UI.
    util::emit("nyra:update-available", json!({ "version": info.version }));

    Ok(format!(
        "Nyra {new} is out — this is {current}.{notes}\n\nOffer it as [update and restart](nyra://update): that renders as a button. Do not try to install it yourself; installing restarts Nyra and would cut this conversation off mid-reply.",
        new = info.version,
        current = info.current,
        notes = if info.notes.trim().is_empty() {
            String::new()
        } else {
            format!("\n\nRelease notes:\n{}", info.notes.trim())
        }
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, kind: &str) -> Value {
        json!({ "id": id, "label": id, "position": { "x": 0, "y": 0 }, "data": { "type": kind } })
    }

    fn flow(nodes: Value, edges: Value) -> Value {
        json!({ "id": "wf-1", "name": "T", "nodes": nodes, "edges": edges,
                "createdAt": 1, "updatedAt": 1 })
    }

    /// The load-bearing one. These eight ship inside the binary and are what a
    /// model will copy from, so a validator that rejects any of them is wrong
    /// about the schema rather than right about the flow.
    #[test]
    fn every_shipped_template_passes_its_own_validator() {
        let templates = crate::workflow::store::built_in_templates();
        assert_eq!(templates.len(), 8, "the template set changed");
        for template in templates {
            let id = template.get("id").and_then(Value::as_str).unwrap_or("?");
            if let Err(errors) = validate_flow(template) {
                panic!("built-in template {id} fails validation: {errors:?}");
            }
        }
    }

    /// What `workflow_import` lets through today: the three keys are present,
    /// so it saves, draws an empty canvas, and fails much later with
    /// "Workflow not found".
    #[test]
    fn rejects_the_shape_that_imports_and_then_fails_at_run_time() {
        let bad = json!({ "id": "wf-1", "name": "T", "nodes": "hello", "edges": [] });
        let errors = validate_flow(&bad).unwrap_err();
        assert!(errors[0].contains("does not match the flow schema"), "{errors:?}");
    }

    #[test]
    fn names_every_missing_field_at_once() {
        let errors = validate_flow(&json!({ "name": "T" })).unwrap_err();
        // One round trip per mistake is what this avoids.
        assert_eq!(errors.len(), 3);
        for field in ["id", "nodes", "edges"] {
            assert!(errors.iter().any(|e| e.contains(field)), "{field}: {errors:?}");
        }
    }

    #[test]
    fn catches_an_edge_that_goes_nowhere() {
        let f = flow(
            json!([node("a", "prompt")]),
            json!([{ "id": "e1", "source": "a", "target": "ghost" }]),
        );
        let errors = validate_flow(&f).unwrap_err();
        assert!(errors.iter().any(|e| e.contains("'ghost'")), "{errors:?}");
    }

    #[test]
    fn catches_a_branch_handle_the_engine_will_never_take() {
        // 'maybe' saves, draws, and is silently never followed.
        let f = flow(
            json!([node("c", "condition"), node("a", "prompt")]),
            json!([{ "id": "e1", "source": "c", "target": "a", "sourceHandle": "maybe" }]),
        );
        let errors = validate_flow(&f).unwrap_err();
        assert!(errors.iter().any(|e| e.contains("yes and no")), "{errors:?}");
    }

    #[test]
    fn catches_a_handle_on_a_node_that_has_no_branches() {
        let f = flow(
            json!([node("p", "prompt"), node("q", "prompt")]),
            json!([{ "id": "e1", "source": "p", "target": "q", "sourceHandle": "yes" }]),
        );
        let errors = validate_flow(&f).unwrap_err();
        assert!(
            errors.iter().any(|e| e.contains("only condition and loop")),
            "{errors:?}"
        );
    }

    #[test]
    fn accepts_the_handles_that_are_real() {
        for (kind, handles) in [("condition", ["yes", "no"]), ("loop", ["body", "exit"])] {
            for handle in handles {
                let f = flow(
                    json!([node("s", kind), node("t", "prompt")]),
                    json!([{ "id": "e1", "source": "s", "target": "t", "sourceHandle": handle }]),
                );
                assert!(validate_flow(&f).is_ok(), "{kind}/{handle}");
            }
        }
    }

    /// `label` is the legacy way of naming a handle and is still read by the
    /// engine, so the validator has to judge it the same way.
    #[test]
    fn judges_a_legacy_label_handle_like_a_real_one() {
        let f = flow(
            json!([node("c", "condition"), node("a", "prompt")]),
            json!([{ "id": "e1", "source": "c", "target": "a", "label": "maybe" }]),
        );
        assert!(validate_flow(&f).is_err());
    }

    #[test]
    fn catches_two_nodes_sharing_an_id() {
        let f = flow(json!([node("a", "prompt"), node("a", "script")]), json!([]));
        let errors = validate_flow(&f).unwrap_err();
        assert!(errors.iter().any(|e| e.contains("share an id")), "{errors:?}");
    }

    #[test]
    fn refuses_a_flow_with_no_nodes() {
        let errors = validate_flow(&flow(json!([]), json!([]))).unwrap_err();
        assert!(errors.iter().any(|e| e.contains("at least one node")), "{errors:?}");
    }

    /// The link form is what the model is told to write, and the renderer
    /// matches on it. Pinning it here means the two cannot drift silently.
    #[test]
    fn the_flow_link_is_the_scheme_the_renderer_parses() {
        assert_eq!(flow_link("wf-9", "Nightly"), "[Nightly](nyra://flow/wf-9)");
    }

    /// Both outcomes of the bridge, in one test on purpose: `PENDING` is a
    /// process-wide map, and as two tests they raced — whichever ran second
    /// picked "a parked request" off the map and answered the *other* one,
    /// so the timeout case passed and the delivery case hung.
    #[tokio::test]
    async fn the_bridge_delivers_an_answer_and_gives_up_without_one() {
        let waiting = tokio::spawn(async { ask_renderer("state", json!({})).await });
        // Long enough for the emit to land and the sender to park itself.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let id = PENDING.lock().keys().next().cloned().expect("a parked request");
        deliver_response(&id, json!({ "summaryOpen": true }));
        let answered = waiting.await.unwrap().unwrap();
        assert_eq!(answered.get("summaryOpen"), Some(&json!(true)));
        assert!(PENDING.lock().is_empty(), "the answered request was not cleared");

        // Nothing is listening now, so this is the path that keeps a wedged
        // window from holding the whole turn open behind it.
        let started = std::time::Instant::now();
        let gave_up = ask_renderer("state", json!({})).await;
        assert!(gave_up.unwrap_err().contains("did not answer"));
        assert!(started.elapsed() >= RENDERER_TIMEOUT);
        assert!(PENDING.lock().is_empty(), "the timed-out request was not cleared");
    }

    #[test]
    fn a_late_answer_to_a_forgotten_question_is_dropped() {
        deliver_response("never-asked", json!({ "ok": true }));
    }

    #[tokio::test]
    async fn tools_list_carries_exactly_the_three() {
        let listed = handle(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await;
        let tools = listed["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["nyra_ui", "nyra_flow", "nyra_update"]);
        // Every one of these rides in every turn, so the schemas stay small on
        // purpose. If this trips, move a catalogue into a result.
        let weight = serde_json::to_string(&tool_schemas()).unwrap().len();
        println!("  tool schemas    {weight:>5} chars  ~{:>4} tokens", weight / 4);
        assert!(weight < 3000, "tool schemas grew to {weight} bytes");
    }

    #[tokio::test]
    async fn an_unknown_tool_is_a_tool_error_not_a_protocol_error() {
        // The call happened; it just did not work. A JSON-RPC error would read
        // as a broken server and take the session down with it.
        let answered = handle(json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "nyra_teleport", "arguments": {} }
        }))
        .await;
        assert!(answered.get("error").is_none());
        assert_eq!(answered["result"]["isError"], json!(true));
        let text = answered["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("nyra_ui"), "the refusal should name what is offered");
    }

    #[tokio::test]
    async fn a_notification_gets_no_reply() {
        let answered = handle(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
        assert_eq!(answered, Value::Null);
    }

    #[tokio::test]
    async fn initialize_answers_with_the_servers_name() {
        let answered = handle(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" })).await;
        assert_eq!(answered["result"]["serverInfo"]["name"], json!("nyra-app"));
        assert!(answered["result"]["capabilities"]["tools"].is_object());
    }
}
