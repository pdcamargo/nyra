//! `/desktop/mcp/{chat_id}`: the desktop tools, over the same one-POST,
//! one-reply transport as `/app/mcp`.
//!
//! The schemas are a token budget, as they are in `app_mcp.rs`: they ride in
//! every turn of every chat that has these attached. So they say what each tool
//! is for and nothing more; the app list, the window list and what the tree
//! looks like all arrive in what a call returns.

use serde_json::{json, Value};

use super::{ActArgs, Backend, Desktop, Host};

const PROTOCOL_VERSION: &str = "2024-11-05";

pub fn tool_schemas() -> Value {
    json!([
        {
            "name": "desktop_apps",
            "description": "Apps running on this computer and their windows: which are blocked, which this chat may use. Start here.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "desktop_snapshot",
            "description": "Read a window as text with refs ([e12]) for desktop_act. The default way to look. Take a fresh one before acting: the user may have moved things.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": { "type": "string", "description": "Name from desktop_apps." },
                    "window": { "type": "string", "description": "Its number or title. Default: the focused window. \"menu\" reads the menu bar." },
                    "root": { "type": "string", "description": "A ref, to expand what the last snapshot cut off." }
                },
                "required": ["app"]
            }
        },
        {
            "name": "desktop_act",
            "description": "Act on a ref from a snapshot. Anything that sends, deletes, buys or submits needs the user's yes first, then confirmed:true.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "app": { "type": "string" },
                    "action": { "type": "string", "enum": ["press", "focus", "type", "set_value", "keys"] },
                    "ref": { "type": "string" },
                    "text": { "type": "string", "description": "For type and set_value." },
                    "keys": { "type": "string", "description": "For keys: \"cmd+s\", \"return\", \"mod+w\" (mod = cmd on macOS, ctrl on Windows)." },
                    "x": { "type": "number", "description": "With y, instead of ref, only when the tree is no use: a point in the window to press." },
                    "y": { "type": "number" },
                    "window": { "type": "string", "description": "For keys or x/y. Default: the focused window." },
                    "confirmed": { "type": "boolean", "description": "The user said yes to this send/delete/buy/submit." }
                },
                "required": ["app", "action"]
            }
        },
        {
            "name": "desktop_open",
            "description": "Open an app, a file or a URL.",
            "inputSchema": {
                "type": "object",
                "properties": { "target": { "type": "string", "description": "App name, absolute path, or URL." } },
                "required": ["target"]
            }
        }
    ])
}

fn reply(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn arg(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string).filter(|s| !s.is_empty())
}

pub async fn handle<B: Backend, H: Host>(desktop: &Desktop<B, H>, chat: &str, message: Value) -> Value {
    let Some(id) = message.get("id").cloned() else {
        return Value::Null;
    };
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    match method {
        "initialize" => reply(
            id,
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": { "tools": {} },
                "serverInfo": { "name": "nyra-desktop", "version": env!("CARGO_PKG_VERSION") }
            }),
        ),
        "ping" => reply(id, json!({})),
        "tools/list" => reply(id, json!({ "tools": tool_schemas() })),
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or(Value::Null);
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            match call(desktop, chat, name, &args).await {
                Ok(text) => reply(id, json!({ "content": [{ "type": "text", "text": text }] })),
                Err(why) => reply(
                    id,
                    json!({ "content": [{ "type": "text", "text": why }], "isError": true }),
                ),
            }
        }
        other => json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": format!("Unknown method {other}") }
        }),
    }
}

async fn call<B: Backend, H: Host>(
    desktop: &Desktop<B, H>,
    chat: &str,
    name: &str,
    args: &Value,
) -> Result<String, String> {
    match name {
        "desktop_apps" => desktop.apps(chat).await,
        "desktop_snapshot" => {
            let app = arg(args, "app").ok_or("desktop_snapshot needs an app. Call desktop_apps for the list.")?;
            desktop
                .snapshot(chat, &app, arg(args, "window").as_deref(), arg(args, "root").as_deref())
                .await
        }
        "desktop_act" => {
            let a = ActArgs {
                app: arg(args, "app").ok_or("desktop_act needs an app.")?,
                window: arg(args, "window"),
                r#ref: arg(args, "ref"),
                action: arg(args, "action").ok_or("desktop_act needs an action.")?,
                text: args.get("text").and_then(Value::as_str).map(str::to_string),
                keys: arg(args, "keys"),
                x: args.get("x").and_then(Value::as_f64),
                y: args.get("y").and_then(Value::as_f64),
                confirmed: args.get("confirmed").and_then(Value::as_bool).unwrap_or(false),
            };
            desktop.act(chat, a).await
        }
        "desktop_open" => {
            let target = arg(args, "target").ok_or("desktop_open needs a target.")?;
            desktop.open(chat, &target).await
        }
        other => Err(format!(
            "Unknown tool '{other}'. This server offers desktop_apps, desktop_snapshot, desktop_act and desktop_open."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::super::fake;
    use super::*;

    #[tokio::test]
    async fn lists_the_four_tools_inside_their_budget() {
        let (d, _, _) = fake::desktop();
        let listed = handle(&d, "c", json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await;
        let names: Vec<&str> = listed["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["desktop_apps", "desktop_snapshot", "desktop_act", "desktop_open"]);
        // In every turn of every chat that has them. Growth is a decision.
        let weight = serde_json::to_string(&tool_schemas()).unwrap().len();
        println!("  desktop schemas {weight:>5} chars  ~{:>4} tokens", weight / 4);
        assert!(weight < 2500, "desktop tool schemas grew to {weight} bytes");
    }

    #[tokio::test]
    async fn a_refusal_is_a_tool_error_the_model_can_read() {
        let (d, _, _) = fake::desktop();
        let answered = handle(
            &d,
            "c",
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                    "params": { "name": "desktop_snapshot", "arguments": { "app": "Nothing" } } }),
        )
        .await;
        assert!(answered.get("error").is_none());
        assert_eq!(answered["result"]["isError"], json!(true));
        let text = answered["result"]["content"][0]["text"].as_str().unwrap();
        assert!(text.contains("desktop_apps"), "{text}");
    }

    #[tokio::test]
    async fn a_notification_gets_no_reply_and_initialize_names_the_server() {
        let (d, _, _) = fake::desktop();
        assert_eq!(handle(&d, "c", json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await, Value::Null);
        let init = handle(&d, "c", json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize" })).await;
        assert_eq!(init["result"]["serverInfo"]["name"], json!("nyra-desktop"));
    }
}
