//! The Chromium behind the browser panel.
//!
//! Nyra does not speak CDP. A Node sidecar owns Playwright, which owns one
//! headless Chromium for the whole app and one `BrowserContext` per chat; the
//! webview then holds its own CDP socket straight to that Chromium, so frames
//! and input never pass through here. This module's whole job is to start the
//! sidecar, keep it alive, and forward the handful of requests a raw CDP socket
//! cannot make for itself.
//!
//! Supervision follows `terminal.rs`: a reader task per pipe, exit detected on
//! EOF, and an event at the renderer either way. Nothing restarts
//! automatically — the next `ensure` starts a fresh one, which is the same
//! contract the terminal has.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{ChildStdin, Command};

use crate::util;

/// Node needs to boot, read its own port and answer. Generous because a cold
/// import of playwright-core is not instant on a slow disk.
const READY_TIMEOUT: Duration = Duration::from_secs(20);

struct Sidecar {
    port: u16,
    token: String,
    pid: u32,
    /// Holding stdin open is what keeps the sidecar alive. It watches for EOF
    /// and shuts Chromium down, so a Nyra that dies without saying anything
    /// still doesn't leak a headless browser.
    _stdin: ChildStdin,
}

static SIDECAR: Lazy<Mutex<Option<Sidecar>>> = Lazy::new(|| Mutex::new(None));
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
    let has_entry = |dir: &PathBuf| dir.join("src").join("index.mjs").is_file();

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

fn live_sidecar() -> Option<(u16, String)> {
    let guard = SIDECAR.lock();
    let sidecar = guard.as_ref()?;
    crate::processes::is_alive(sidecar.pid as i32).then(|| (sidecar.port, sidecar.token.clone()))
}

async fn ensure_sidecar() -> Result<(u16, String), String> {
    if let Some(live) = live_sidecar() {
        return Ok(live);
    }
    let _gate = START_GATE.lock().await;
    // Someone may have won the race to the gate.
    if let Some(live) = live_sidecar() {
        return Ok(live);
    }
    start_sidecar().await
}

async fn start_sidecar() -> Result<(u16, String), String> {
    let node = which("node").ok_or_else(|| {
        "Node.js is not installed, or not on the PATH Nyra can see.".to_string()
    })?;
    let dir = sidecar_dir().ok_or_else(|| "The browser sidecar is missing.".to_string())?;
    let token = util::rand_hex(16);

    let mut child = Command::new(&node)
        .arg(dir.join("src").join("index.mjs"))
        .arg("--token")
        .arg(&token)
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

    let (ready_tx, ready_rx) = tokio::sync::oneshot::channel::<u16>();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        let mut ready_tx = Some(ready_tx);
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(event) = serde_json::from_str::<Value>(&line) else {
                crate::log!("browser", "unparsed sidecar line: {line}");
                continue;
            };
            // `ready` is the handshake, not news — it resolves the start rather
            // than reaching the renderer.
            if event.get("type").and_then(Value::as_str) == Some("ready") {
                if let (Some(tx), Some(port)) = (
                    ready_tx.take(),
                    event.get("port").and_then(Value::as_u64),
                ) {
                    let _ = tx.send(port as u16);
                }
                continue;
            }
            util::emit("browser:event", event);
        }

        let exit_code = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1);
        SIDECAR.lock().take();
        crate::log!("browser", "sidecar exited ({exit_code})");
        util::emit(
            "browser:event",
            json!({ "type": "sidecar-exit", "exitCode": exit_code }),
        );
    });

    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            crate::log!("browser", "{line}");
        }
    });

    let port = tokio::time::timeout(READY_TIMEOUT, ready_rx)
        .await
        .map_err(|_| "The browser sidecar did not start in time.".to_string())?
        .map_err(|_| "The browser sidecar exited while starting.".to_string())?;

    crate::log!("browser", "sidecar ready on 127.0.0.1:{port} (pid {pid})");
    *SIDECAR.lock() = Some(Sidecar {
        port,
        token,
        pid,
        _stdin: stdin,
    });
    live_sidecar().ok_or_else(|| "The browser sidecar died on startup.".to_string())
}

/// Drop the sidecar. Idempotent, because `shutdown()` runs more than once.
pub fn stop() {
    let Some(sidecar) = SIDECAR.lock().take() else {
        return;
    };
    // Dropping stdin is the polite ask; the signal is the follow-up for a
    // sidecar that is wedged rather than listening.
    drop(sidecar._stdin);
    if sidecar.pid > 0 {
        let _ = crate::processes::kill_by_pid(sidecar.pid as i32);
    }
}

// ---------------------------------------------------------------------------
// Talking to it
// ---------------------------------------------------------------------------

async fn request(method: reqwest::Method, path: &str, body: Value) -> Result<Value, String> {
    let (port, token) = ensure_sidecar().await?;
    let client = reqwest::Client::new();
    let mut req = client
        .request(method, format!("http://127.0.0.1:{port}{path}"))
        .header("x-nyra-token", token)
        .timeout(Duration::from_secs(60));
    if !body.is_null() {
        req = req.json(&body);
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("The browser sidecar did not answer: {e}"))?;
    let value: Value = res
        .json()
        .await
        .map_err(|e| format!("The browser sidecar sent nonsense: {e}"))?;
    match value.get("error").and_then(Value::as_str) {
        Some(err) => Err(err.to_string()),
        None => Ok(value),
    }
}

/// Start the sidecar if needed and report what it can see. Does **not** launch
/// Chromium — the panel asks this first so it can show a first-run state
/// instead of an error.
pub async fn status() -> Value {
    match request(reqwest::Method::GET, "/state", Value::Null).await {
        Ok(state) => json!({ "ok": true, "state": state }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

/// Give this chat a browser context, launching Chromium on the first ask.
pub async fn ensure(chat_id: &str) -> Value {
    let body = json!({ "chatId": chat_id });
    match request(reqwest::Method::POST, "/chat/ensure", body).await {
        Ok(value) => json!({ "ok": true, "browser": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

pub async fn release(chat_id: &str) -> Value {
    let body = json!({ "chatId": chat_id });
    match request(reqwest::Method::POST, "/chat/release", body).await {
        Ok(_) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

/// Keep this chat's context off the idle sweeper's list. The renderer calls it
/// while a surface for the chat is on screen.
pub async fn touch(chat_id: &str) -> Value {
    let body = json!({ "chatId": chat_id });
    match request(reqwest::Method::POST, "/chat/touch", body).await {
        Ok(value) => value,
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

pub async fn open_tab(chat_id: &str, url: &str) -> Value {
    let body = json!({ "chatId": chat_id, "url": url });
    match request(reqwest::Method::POST, "/chat/open-tab", body).await {
        Ok(_) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

/// Download the Chromium that Playwright expects.
///
/// `--no-shell` skips chromium-headless-shell, ~94 MB of a build we would never
/// launch: it follows the old headless codepath, which has no compositor and so
/// cannot screencast.
pub async fn install_chromium() -> Value {
    let Some(node) = which("node") else {
        return json!({ "ok": false, "error": "Node.js is not installed, or not on the PATH Nyra can see." });
    };
    let Some(dir) = sidecar_dir() else {
        return json!({ "ok": false, "error": "The browser sidecar is missing." });
    };

    let mut child = match Command::new(&node)
        .arg(dir.join("node_modules").join("playwright-core").join("cli.js"))
        .args(["install", "chromium", "--no-shell"])
        .current_dir(&dir)
        .env_clear()
        .envs(util::clean_child_env())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => return json!({ "ok": false, "error": format!("Could not start the download: {e}") }),
    };

    // Playwright draws its progress bar as whole lines, so percentages arrive
    // one per line rather than as carriage-return redraws.
    if let Some(stdout) = child.stdout.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let percent = line
                    .split('|')
                    .next_back()
                    .and_then(|tail| tail.trim().split('%').next())
                    .and_then(|n| n.trim().parse::<u8>().ok());
                util::emit(
                    "browser:event",
                    json!({ "type": "install-progress", "line": line, "percent": percent }),
                );
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                crate::log!("browser", "install: {line}");
            }
        });
    }

    match child.wait().await {
        Ok(s) if s.success() => json!({ "ok": true }),
        Ok(s) => json!({ "ok": false, "error": format!("The download failed ({}).", s.code().unwrap_or(-1)) }),
        Err(e) => json!({ "ok": false, "error": format!("The download failed: {e}") }),
    }
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
        // Packaging bug insurance: if this moves, the panel dies in release
        // builds only, which is the worst time to find out.
        let dir = sidecar_dir().expect("sidecar directory");
        assert!(dir.join("src").join("browser.mjs").is_file());
        assert!(dir.join("package.json").is_file());
    }
}
