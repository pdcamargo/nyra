//! One `codex app-server` process and the JSON-RPC conversation with it.
//!
//! JSON-RPC 2.0 without the `"jsonrpc"` field, one message per line on stdio.
//! Requests carry an id and get a response; notifications do not; and the
//! server sends requests of its own — approvals — which the client answers by
//! id. Everything that is not a response to one of ours goes to `on_message`.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin};
use tokio::sync::{oneshot, Mutex as AsyncMutex};

use crate::{platform, util};

/// What the server sent that was not the answer to one of our requests.
pub enum Incoming {
    Notification { method: String, params: Value },
    /// Answer it with [`Server::reply`] under the same `id`.
    Request { id: Value, method: String, params: Value },
    /// The process is gone. Nothing else arrives after this.
    Exited { reason: String },
}

pub type Handler = Arc<dyn Fn(&Arc<Server>, Incoming) + Send + Sync>;

pub struct Server {
    stdin: AsyncMutex<ChildStdin>,
    child: Mutex<Option<Child>>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

/// How long anything but a turn may take to answer. A turn is not a request:
/// `turn/start` answers at once and the turn arrives as notifications.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// Lines of stderr kept for the log when the process dies.
const STDERR_TAIL: usize = 20;

impl Server {
    /// Start the process under `home` (None is the CLI's own `~/.codex`), hand
    /// everything it says to `on_message`, and finish the `initialize`
    /// handshake before returning it.
    pub async fn spawn(bin: &std::path::Path, home: Option<PathBuf>, on_message: Handler) -> Result<Arc<Server>, String> {
        let mut cmd = platform::command(bin);
        cmd.arg("app-server")
            .env_clear()
            .envs(util::clean_child_env())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if let Some(home) = &home {
            cmd.env("CODEX_HOME", home);
        }
        let mut child = cmd.spawn().map_err(|e| format!("Could not start Codex: {e}"))?;
        let stdout = child.stdout.take().ok_or("Codex has no stdout")?;
        let stderr = child.stderr.take().ok_or("Codex has no stderr")?;
        let stdin = child.stdin.take().ok_or("Codex has no stdin")?;

        let server = Arc::new(Server {
            stdin: AsyncMutex::new(stdin),
            child: Mutex::new(Some(child)),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
        });

        let tail: Arc<Mutex<VecDeque<String>>> = Arc::default();
        {
            let tail = tail.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut tail = tail.lock();
                    if tail.len() == STDERR_TAIL {
                        tail.pop_front();
                    }
                    tail.push_back(util::strip_ansi(&line));
                }
            });
        }

        let reader = server.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
                reader.dispatch(msg, &on_message);
            }
            // Whoever was waiting on an answer gets none.
            reader.pending.lock().clear();
            let tail: Vec<String> = tail.lock().iter().cloned().collect();
            if !tail.is_empty() {
                crate::logf!("codex app-server stderr:\n{}", tail.join("\n"));
            }
            // Not the last stderr line: that is whatever logged last, which is
            // as often one of the user's MCP servers failing as anything to do
            // with why the process went. The tail is in the log for that.
            on_message(&reader, Incoming::Exited { reason: "Codex stopped unexpectedly.".to_string() });
        });

        server
            .request(
                "initialize",
                json!({ "clientInfo": { "name": "nyra", "title": "Nyra", "version": env!("CARGO_PKG_VERSION") } }),
            )
            .await?;
        server.notify("initialized", json!({})).await?;
        Ok(server)
    }

    fn dispatch(self: &Arc<Self>, msg: Value, on_message: &Handler) {
        let method = msg.get("method").and_then(Value::as_str).map(str::to_string);
        match (method, msg.get("id")) {
            (None, Some(id)) => {
                let waiter = id.as_u64().and_then(|id| self.pending.lock().remove(&id));
                if let Some(tx) = waiter {
                    let _ = tx.send(msg);
                }
            }
            (Some(method), Some(id)) => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                on_message(self, Incoming::Request { id: id.clone(), method, params });
            }
            (Some(method), None) => {
                let params = msg.get("params").cloned().unwrap_or(Value::Null);
                on_message(self, Incoming::Notification { method, params });
            }
            (None, None) => {}
        }
    }

    async fn write(&self, msg: &Value) -> Result<(), String> {
        let mut line = msg.to_string();
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(|e| format!("Codex closed its input: {e}"))?;
        stdin.flush().await.map_err(|e| format!("Codex closed its input: {e}"))
    }

    /// Send a request and wait for its answer: the `result`, or the `error`
    /// message as the `Err`.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        if let Err(e) = self.write(&json!({ "id": id, "method": method, "params": params })).await {
            self.pending.lock().remove(&id);
            return Err(e);
        }
        let reply = match tokio::time::timeout(REQUEST_TIMEOUT, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => return Err("Codex stopped before answering".into()),
            Err(_) => {
                self.pending.lock().remove(&id);
                return Err(format!("Codex did not answer {method}"));
            }
        };
        match reply.get("error") {
            Some(error) => Err(error
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| error.to_string())),
            None => Ok(reply.get("result").cloned().unwrap_or(Value::Null)),
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({ "method": method, "params": params })).await
    }

    /// Answer one of the server's own requests.
    pub async fn reply(&self, id: Value, result: Result<Value, String>) {
        let msg = match result {
            Ok(result) => json!({ "id": id, "result": result }),
            Err(message) => json!({ "id": id, "error": { "code": -32601, "message": message } }),
        };
        if let Err(e) = self.write(&msg).await {
            crate::logf!("codex reply failed: {e}");
        }
    }

    pub fn kill(&self) {
        if let Some(mut child) = self.child.lock().take() {
            let _ = child.start_kill();
        }
    }
}
