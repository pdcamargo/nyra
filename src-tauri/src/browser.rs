//! The Chromium behind the browser panel.
//!
//! Nyra does not speak CDP. A Node sidecar owns Playwright, which owns one
//! headless Chromium for the whole app and one `BrowserContext` per chat; the
//! webview then holds its own CDP socket straight to that Chromium, so frames
//! and input never pass through here. This module starts the sidecar, keeps it
//! alive, and carries the handful of requests a raw CDP socket cannot make for
//! itself — launching the browser, and owning the context that scopes a chat.
//!
//! The wire is newline-delimited JSON over a pipe, the same shape `claude.rs`
//! uses for the Claude CLI and for the same reason: no port to bind, no token
//! to check, and the pipe closing is how we learn the child died.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;

use crate::util;

/// Enough for a cold `import playwright-core` on a slow disk.
const CALL_TIMEOUT: Duration = Duration::from_secs(90);
/// Chromium is a 182 MiB download on a connection we know nothing about.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);

type Reply = oneshot::Sender<Result<Value, String>>;

struct Sidecar {
    pid: u32,
    /// Also the kill switch: the sidecar shuts Chromium down when stdin hits
    /// EOF, so a Nyra that dies without saying anything still doesn't leak a
    /// browser.
    stdin: Arc<tokio::sync::Mutex<ChildStdin>>,
}

static SIDECAR: Lazy<Mutex<Option<Arc<Sidecar>>>> = Lazy::new(|| Mutex::new(None));
static PENDING: Lazy<Mutex<HashMap<u64, Reply>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// Two chats opening a browser at once must not race into two sidecars.
static START_GATE: Lazy<tokio::sync::Mutex<()>> = Lazy::new(|| tokio::sync::Mutex::new(()));

// ---------------------------------------------------------------------------
// Locating the pieces
// ---------------------------------------------------------------------------

/// `which`, against the PATH we resolved rather than the one we inherited.
fn which(name: &str) -> Option<PathBuf> {
    util::child_path().split(':').find_map(|dir| {
        let candidate = PathBuf::from(dir).join(name);
        candidate.is_file().then_some(candidate)
    })
}

/// Packaged, the sidecar rides along in Resources. In development it is the
/// checkout this binary was built from.
fn sidecar_dir() -> Option<PathBuf> {
    let has_entry = |dir: &PathBuf| dir.join("index.mjs").is_file();

    if let Some(app) = util::app_handle() {
        if let Ok(dir) = app
            .path()
            .resolve("sidecar", tauri::path::BaseDirectory::Resource)
        {
            if has_entry(&dir) {
                return Some(dir);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent()?.join("sidecar");
    has_entry(&dev).then_some(dev)
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

fn live() -> Option<Arc<Sidecar>> {
    let guard = SIDECAR.lock();
    let sidecar = guard.as_ref()?;
    crate::processes::is_alive(sidecar.pid as i32).then(|| Arc::clone(sidecar))
}

async fn ensure() -> Result<Arc<Sidecar>, String> {
    if let Some(sidecar) = live() {
        return Ok(sidecar);
    }
    let _gate = START_GATE.lock().await;
    if let Some(sidecar) = live() {
        return Ok(sidecar);
    }
    start().await
}

/// Fail every in-flight call. A sidecar that died owes answers it will never
/// give, and a caller waiting on the timeout learns nothing useful.
fn drain_pending(reason: &str) {
    let pending: Vec<Reply> = PENDING.lock().drain().map(|(_, tx)| tx).collect();
    for tx in pending {
        let _ = tx.send(Err(reason.to_string()));
    }
}

async fn start() -> Result<Arc<Sidecar>, String> {
    let node = which("node")
        .ok_or_else(|| "Node.js is not installed, or not on the PATH Nyra can see.".to_string())?;
    let dir = sidecar_dir().ok_or_else(|| "The browser sidecar is missing.".to_string())?;

    let mut child = Command::new(&node)
        .arg(dir.join("index.mjs"))
        .current_dir(&dir)
        .env_clear()
        .envs(util::clean_child_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false)
        .spawn()
        .map_err(|e| format!("Failed to start the browser sidecar: {e}"))?;

    let pid = child.id().unwrap_or(0);
    let stdin = child.stdin.take().ok_or("sidecar has no stdin")?;
    let stdout = child.stdout.take().ok_or("sidecar has no stdout")?;
    let stderr = child.stderr.take().ok_or("sidecar has no stderr")?;

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                crate::log!("browser", "unparsed sidecar line: {line}");
                continue;
            };
            // A reply carries an id; anything else is news for the renderer.
            if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if let Some(tx) = PENDING.lock().remove(&id) {
                    let _ = tx.send(match message.get("error").and_then(Value::as_str) {
                        Some(error) => Err(error.to_string()),
                        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                    });
                }
                continue;
            }
            util::emit("browser:event", message);
        }

        let code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        SIDECAR.lock().take();
        drain_pending("The browser sidecar stopped.");
        crate::log!("browser", "sidecar exited ({code})");
        util::emit("browser:event", json!({ "event": "exit", "params": { "code": code } }));
    });

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            crate::log!("browser", "{line}");
        }
    });

    let sidecar = Arc::new(Sidecar {
        pid,
        stdin: Arc::new(tokio::sync::Mutex::new(stdin)),
    });
    *SIDECAR.lock() = Some(Arc::clone(&sidecar));
    crate::log!("browser", "sidecar started (pid {pid})");

    // Chromium answers a WebSocket with an unlisted Origin with a 403, and the
    // webview's origin is not the same in a packaged build as under the dev
    // server. Only the origin this build actually runs from is allowed: with a
    // wider list, a page the browser visits could open a socket to its own
    // debugging port and drive every chat's context.
    //
    // Written straight to the pipe rather than through `call`, which would
    // route back through `ensure` and make this function recursive. Nothing
    // waits on the reply; the reader drops an id nobody registered.
    let handshake = format!(
        "{}\n",
        json!({
            "id": NEXT_ID.fetch_add(1, Ordering::Relaxed),
            "method": "configure",
            "params": { "patch": { "allowedOrigins": allowed_origins() } }
        })
    );
    {
        let mut pipe = sidecar.stdin.lock().await;
        let _ = pipe.write_all(handshake.as_bytes()).await;
        let _ = pipe.flush().await;
    }

    Ok(sidecar)
}

/// Drop the sidecar. Idempotent, because `shutdown()` runs more than once.
pub fn stop() {
    let Some(sidecar) = SIDECAR.lock().take() else {
        return;
    };
    drain_pending("Nyra is shutting down.");
    if sidecar.pid > 0 {
        let _ = crate::processes::kill_by_pid(sidecar.pid as i32);
    }
}

/// Where the webview loads from, which is the only origin allowed to open a CDP
/// socket. Tauri serves `tauri://localhost` on macOS and `http://tauri.localhost`
/// on Windows; a debug build runs off the Vite dev server instead.
fn allowed_origins() -> Vec<String> {
    let mut origins = vec![
        "tauri://localhost".to_string(),
        "http://tauri.localhost".to_string(),
    ];
    if cfg!(debug_assertions) {
        origins.push("http://localhost:1420".to_string());
    }
    origins
}

// ---------------------------------------------------------------------------
// Talking to it
// ---------------------------------------------------------------------------

async fn call_with(timeout: Duration, method: &str, params: Value) -> Result<Value, String> {
    let sidecar = ensure().await?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let line = format!(
        "{}\n",
        json!({ "id": id, "method": method, "params": params })
    );

    let (tx, rx) = oneshot::channel();
    PENDING.lock().insert(id, tx);

    // Registered before the write, so a reply cannot arrive before there is
    // somewhere to put it.
    let write = {
        let mut stdin = sidecar.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.and(stdin.flush().await)
    };
    if let Err(e) = write {
        PENDING.lock().remove(&id);
        return Err(format!("The browser sidecar is not listening: {e}"));
    }

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("The browser sidecar stopped.".to_string()),
        Err(_) => {
            PENDING.lock().remove(&id);
            Err(format!("The browser did not answer `{method}` in time."))
        }
    }
}

async fn call(method: &str, params: Value) -> Result<Value, String> {
    call_with(CALL_TIMEOUT, method, params).await
}

/// Rasterising an artboard is the one call that can legitimately take seconds:
/// the first one in a session pays for launching Chromium. The normal call
/// timeout is sized for driving a page that is already open.
const RASTER_TIMEOUT: Duration = Duration::from_secs(45);

/// HTML in, PNG path out. The sidecar owns the headless Chromium; the design
/// vocabulary lives entirely on the other side of this call, which is why the
/// parameter is a finished document rather than anything to parse.
pub async fn design_raster(params: Value) -> Value {
    settle(call_with(RASTER_TIMEOUT, "design.raster", params).await)
}


/// Every command answers `{ ok }` or `{ ok: false, error }` rather than
/// rejecting: the panel renders a failure as a state, and a rejected promise
/// would only become an unhandled one somewhere in the renderer.
fn settle(result: Result<Value, String>) -> Value {
    match result {
        Ok(Value::Object(map)) => {
            let mut out = serde_json::Map::new();
            out.insert("ok".into(), Value::Bool(true));
            out.extend(map);
            Value::Object(out)
        }
        Ok(other) => json!({ "ok": true, "result": other }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

/// Push the launch settings down. Starts the sidecar but launches nothing.
pub async fn configure(patch: Value) -> Value {
    settle(call("configure", json!({ "patch": patch })).await)
}

/// What the sidecar can see: whether a Chromium is on disk, and whether one is
/// running. Deliberately does not launch — the panel asks this first so it can
/// show a first-run state instead of an error.
pub async fn status() -> Value {
    settle(call("status", json!({})).await)
}

pub async fn install() -> Value {
    settle(call_with(INSTALL_TIMEOUT, "install", json!({})).await)
}

/// `host_dpr` decides what pages in this chat see as `devicePixelRatio`. It has
/// to travel with the open because Playwright takes it from context options and
/// offers no per-page setter, so the context cannot be built without it.
pub async fn open_chat(chat_id: &str, host_dpr: f64) -> Value {
    settle(call("chat.open", json!({ "chatId": chat_id, "hostDpr": host_dpr })).await)
}

pub async fn close_chat(chat_id: &str) -> Value {
    settle(call("chat.close", json!({ "chatId": chat_id })).await)
}

/// Keep this chat's context off the idle sweeper's list. The renderer pings it
/// while a surface for the chat is on screen.
pub async fn touch(chat_id: &str) -> Value {
    settle(call("chat.touch", json!({ "chatId": chat_id })).await)
}

pub async fn tab_create(chat_id: &str, url: &str) -> Value {
    settle(call("tab.create", json!({ "chatId": chat_id, "url": url })).await)
}

pub async fn tab_close(chat_id: &str, tab_id: &str) -> Value {
    settle(call("tab.close", json!({ "chatId": chat_id, "tabId": tab_id })).await)
}

pub async fn tab_navigate(chat_id: &str, tab_id: &str, url: &str) -> Value {
    settle(call("tab.navigate", json!({ "chatId": chat_id, "tabId": tab_id, "url": url })).await)
}

/// Render a tab at a size. The panel's own menu and the agent's tool both land
/// here, which is what keeps an agent-driven resize visible without a second
/// path to keep in step; `by` is only there so the panel can say who did it.
pub async fn tab_set_viewport(
    chat_id: &str,
    tab_id: &str,
    id: &str,
    width: Option<f64>,
    height: Option<f64>,
    by: &str,
) -> Value {
    settle(
        call(
            "tab.setViewport",
            json!({
                "chatId": chat_id,
                "tabId": tab_id,
                "id": id,
                "width": width,
                "height": height,
                "by": by,
            }),
        )
        .await,
    )
}

/// `back`, `forward` and `reload` differ only in the method name.
pub async fn tab_history(chat_id: &str, tab_id: &str, action: &str) -> Value {
    let method = match action {
        "back" => "tab.back",
        "forward" => "tab.forward",
        "reload" => "tab.reload",
        other => return json!({ "ok": false, "error": format!("unknown action {other}") }),
    };
    settle(call(method, json!({ "chatId": chat_id, "tabId": tab_id })).await)
}

/// A full-resolution still of a target, for the panel's idle sharpen.
///
/// Taken by the sidecar because only its session can take one safely. The
/// renderer's session has no metrics override, so a full-resolution shot from
/// there needs a clip, and a clipped capture emulates metrics for itself and
/// then restores what it found — which knocked the page's devicePixelRatio to 1
/// and put back sizes the sidecar had since changed.
pub async fn target_screenshot(target_id: &str) -> Value {
    settle(call("target.screenshot", json!({ "targetId": target_id })).await)
}

// ---------------------------------------------------------------------------
// The agent's half
// ---------------------------------------------------------------------------
//
// Claude reaches the browser through an MCP server per chat, which Nyra serves
// from its own loopback port and relays down this pipe. The endpoint belongs to
// Nyra rather than to the sidecar on purpose: Claude Code resolves MCP servers
// when a session starts, so the URL has to be live before anything is launched
// and has to survive the sidecar being restarted underneath it.

/// One secret per run. The port is loopback-only, but every process on the
/// machine can reach a loopback port, and this endpoint drives a browser.
static MCP_TOKEN: Lazy<String> = Lazy::new(|| util::rand_hex(16));

pub fn mcp_token() -> &'static str {
    &MCP_TOKEN
}

/// The `--mcp-config` Claude is spawned with, or nothing if the local server
/// never came up.
pub fn mcp_endpoint(chat_id: &str) -> Option<(String, String)> {
    let port = crate::webhook_server::port()?;
    Some((
        format!("http://127.0.0.1:{port}/browser/mcp/{chat_id}"),
        MCP_TOKEN.clone(),
    ))
}

/// Relay one JSON-RPC message. `Null` back means it was a notification and
/// there is nothing to answer with.
pub async fn mcp_message(chat_id: &str, message: Value) -> Result<Value, String> {
    let result = call("mcp.message", json!({ "chatId": chat_id, "message": message })).await?;
    Ok(result.get("message").cloned().unwrap_or(Value::Null))
}

pub async fn tab_list(chat_id: &str) -> Value {
    settle(call("tab.list", json!({ "chatId": chat_id })).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_finds_a_system_binary() {
        assert!(which("sh").is_some_and(|p| p.is_file()));
        assert!(which("definitely-not-a-real-binary-xyz").is_none());
    }

    #[test]
    fn the_sidecar_ships_with_the_checkout() {
        // Packaging-bug insurance: if this moves, the panel dies in release
        // builds only, which is the worst time to find out.
        let dir = sidecar_dir().expect("sidecar directory");
        assert!(dir.join("index.mjs").is_file());
        assert!(dir.join("package.json").is_file());
    }

    #[test]
    fn settle_flattens_a_result_and_marks_failure() {
        let ok = settle(Ok(json!({ "cdpUrl": "ws://x" })));
        assert_eq!(ok["ok"], json!(true));
        assert_eq!(ok["cdpUrl"], json!("ws://x"));

        let bad = settle(Err("nope".into()));
        assert_eq!(bad["ok"], json!(false));
        assert_eq!(bad["error"], json!("nope"));
    }

    #[test]
    fn history_rejects_an_action_it_does_not_know() {
        let out = tauri::async_runtime::block_on(tab_history("c", "t", "sideways"));
        assert_eq!(out["ok"], json!(false));
    }
}
