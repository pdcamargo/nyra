//! Loopback HTTP endpoint for webhook triggers.
//!
//! Bound to 127.0.0.1 only — never the network. A trigger's token is the whole
//! authorisation story, so the socket must not be reachable off-box.

use axum::extract::{Path, Query};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::{Json, Router};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::workflow::triggers;

/// 64 KB — plenty for a small JSON payload of trigger inputs.
const MAX_BODY_BYTES: usize = 64 * 1024;

/// MCP carries tool arguments, which can be a page's worth of text.
const MAX_MCP_BYTES: usize = 4 * 1024 * 1024;

static PORT: Lazy<Mutex<Option<u16>>> = Lazy::new(|| Mutex::new(None));
static SHUTDOWN: Lazy<Mutex<Option<tokio::sync::oneshot::Sender<()>>>> =
    Lazy::new(|| Mutex::new(None));

#[derive(Deserialize)]
struct TokenQuery {
    #[serde(default)]
    token: String,
}

/// Unauthenticated on purpose, and it stays that way: this is how a client
/// tells two running instances apart before it knows anything about either.
/// It carries identity, never the devtools token.
async fn health() -> impl IntoResponse {
    let port = port().unwrap_or(0);
    (StatusCode::OK, Json(crate::devtools::identity(port)))
}

/// Coerce a flat JSON object into the `Record<string, string>` the engine wants.
fn body_to_inputs(body: &[u8]) -> HashMap<String, String> {
    if body.is_empty() {
        return HashMap::new();
    }
    let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(body) else {
        return HashMap::new();
    };
    map.into_iter()
        .map(|(k, v)| {
            let value = match v {
                Value::String(s) => s,
                other => other.to_string(),
            };
            (k, value)
        })
        .collect()
}

async fn webhook(
    Path((workflow_id, trigger_id)): Path<(String, String)>,
    Query(query): Query<TokenQuery>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if query.token.is_empty() {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Missing token" })));
    }
    if body.len() > MAX_BODY_BYTES {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(json!({ "error": "Body too large" })),
        );
    }

    match triggers::fire_webhook(&workflow_id, &trigger_id, &query.token, body_to_inputs(&body)) {
        Ok(()) => (StatusCode::ACCEPTED, Json(json!({ "accepted": true }))),
        Err(e) => (StatusCode::UNAUTHORIZED, Json(json!({ "error": e }))),
    }
}

/// Claude's end of the browser tools.
///
/// The whole of MCP's streamable-HTTP transport we need: a POST carrying one
/// JSON-RPC message, answered with one JSON-RPC response. There is no SSE
/// stream because nothing here is server-initiated — the browser tools only
/// ever answer. Serving it from Nyra rather than the sidecar is what makes a
/// sidecar restart invisible to a session already holding this URL.
async fn browser_mcp(
    method: axum::http::Method,
    Path(chat_id): Path<String>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    // After initialising, an MCP client opens a GET for a server-to-client SSE
    // stream, and sends DELETE to end a session. We offer neither — nothing
    // here is server-initiated — and the spec's answer for that is 405. A 404
    // would read as "wrong URL" and take the client down with it.
    if method != axum::http::Method::POST {
        return (
            StatusCode::METHOD_NOT_ALLOWED,
            Json(json!({ "error": "This endpoint answers POST only" })),
        )
            .into_response();
    }

    let token = headers.get("x-nyra-token").and_then(|v| v.to_str().ok());
    if token != Some(crate::browser::mcp_token()) {
        return (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorised" }))).into_response();
    }
    if body.len() > MAX_MCP_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": "Body too large" }))).into_response();
    }
    let Ok(message) = serde_json::from_slice::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Malformed JSON-RPC" }))).into_response();
    };

    match crate::browser::mcp_message(&chat_id, message).await {
        // A notification has no reply, and MCP wants 202 rather than an empty body.
        Ok(Value::Null) => StatusCode::ACCEPTED.into_response(),
        Ok(response) => (StatusCode::OK, Json(response)).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
            .into_response(),
    }
}

/// 8 KB. An expression, not a program — and unlike `/browser/mcp` there is no
/// page of tool arguments to carry.
const MAX_EVAL_BYTES: usize = 8 * 1024;

/// Guard for the debug routes.
///
/// The token is a **header**, never a query parameter, and that is load-bearing
/// rather than stylistic. Any web page can POST cross-origin to a loopback port
/// without a preflight so long as the request stays CORS-simple; requiring a
/// custom header is what forces the preflight, which this server answers 405,
/// so the browser never sends the request at all. `/webhook` can afford
/// `?token=` because it only fires a trigger. This one evaluates arbitrary JS.
fn dev_guard(method: &axum::http::Method, headers: &HeaderMap) -> Option<Response> {
    if !crate::devtools::dev_enabled() {
        // 404, not 403: a release instance should look like it has no such
        // route, because it does not.
        return Some((StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" }))).into_response());
    }
    if method != axum::http::Method::POST {
        return Some(
            (
                StatusCode::METHOD_NOT_ALLOWED,
                Json(json!({ "error": "This endpoint answers POST only" })),
            )
                .into_response(),
        );
    }
    let token = headers.get("x-nyra-token").and_then(|v| v.to_str().ok());
    if token != Some(crate::devtools::token()) {
        return Some(
            (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Unauthorised" }))).into_response(),
        );
    }
    None
}

/// Evaluate an expression in this instance's renderer.
async fn dev_eval(
    method: axum::http::Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if let Some(refusal) = dev_guard(&method, &headers) {
        return refusal;
    }
    if body.len() > MAX_EVAL_BYTES {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(json!({ "error": "Body too large" })))
            .into_response();
    }
    let code = match serde_json::from_slice::<Value>(&body) {
        Ok(v) => v.get("code").and_then(Value::as_str).unwrap_or_default().to_string(),
        Err(_) => return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Malformed JSON" }))).into_response(),
    };
    if code.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(json!({ "error": "No code to evaluate" }))).into_response();
    }

    match crate::devtools::eval_js(&code).await {
        // The page already answered in JSON; pass it through rather than
        // wrapping a string in another string.
        Ok(value) => match serde_json::from_str::<Value>(&value) {
            Ok(parsed) => (StatusCode::OK, Json(parsed)).into_response(),
            Err(_) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "ok": false, "error": "the page did not answer with JSON" })),
            )
                .into_response(),
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "ok": false, "error": e })))
            .into_response(),
    }
}

/// Capture this instance's window. Answers with a path, not pixels — a retina
/// PNG is megabytes, and the caller wants a path anyway to render it inline.
async fn dev_screenshot(
    method: axum::http::Method,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if let Some(refusal) = dev_guard(&method, &headers) {
        return refusal;
    }
    let max_width = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("maxWidth").and_then(Value::as_u64))
        .map(|w| w as u32);

    match crate::devtools::capture_to_file(max_width).await {
        Ok(shot) => (StatusCode::OK, Json(json!(shot))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": e }))).into_response(),
    }
}

async fn not_found() -> impl IntoResponse {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" })))
}

pub async fn start(preferred_port: u16) -> Option<u16> {
    let app = Router::new()
        .route("/health", get(health))
        .route("/webhook/{workflow_id}/{trigger_id}", any(webhook))
        .route("/browser/mcp/{chat_id}", any(browser_mcp))
        .route("/dev/eval", any(dev_eval))
        .route("/dev/screenshot", any(dev_screenshot))
        .fallback(not_found);

    // Walk forward from the preferred port when it's already taken.
    let mut listener = None;
    for port in preferred_port..preferred_port.saturating_add(11) {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => {
                listener = Some((l, port));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => continue,
            Err(e) => {
                crate::log!("webhook-server", "Failed to bind webhook server: {e}");
                return None;
            }
        }
    }
    let Some((listener, port)) = listener else {
        crate::log!("webhook-server", "No free port near {preferred_port}");
        return None;
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    *SHUTDOWN.lock() = Some(tx);
    *PORT.lock() = Some(port);

    tauri::async_runtime::spawn(async move {
        let server = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = rx.await;
        });
        if let Err(e) = server.await {
            crate::log!("webhook-server", "server error: {e}");
        }
    });

    crate::log!("webhook-server", "Listening on http://127.0.0.1:{port}");
    crate::devtools::register(port);
    Some(port)
}

pub fn port() -> Option<u16> {
    *PORT.lock()
}

pub fn stop() {
    if let Some(tx) = SHUTDOWN.lock().take() {
        let _ = tx.send(());
    }
    if let Some(port) = PORT.lock().take() {
        crate::devtools::unregister(port);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use axum::http::{HeaderValue, Method};

    fn with_token(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-nyra-token", HeaderValue::from_str(token).unwrap());
        headers
    }

    fn refusal(guard: Option<Response>) -> Option<StatusCode> {
        guard.map(|response| response.status())
    }

    /// The header requirement is what keeps a web page out.
    ///
    /// A cross-origin POST carrying only CORS-simple headers needs no preflight,
    /// so a page could otherwise reach this route on loopback and run arbitrary
    /// JS in the app. A custom header forces the preflight, which this server
    /// answers 405 — so the request is never sent. Hence: header, never `?token=`.
    #[test]
    fn dev_routes_demand_the_token_in_a_header() {
        assert_eq!(
            refusal(dev_guard(&Method::POST, &HeaderMap::new())),
            Some(StatusCode::UNAUTHORIZED),
            "a request with no token got through"
        );
        assert_eq!(
            refusal(dev_guard(&Method::POST, &with_token("not-the-token"))),
            Some(StatusCode::UNAUTHORIZED)
        );
        assert_eq!(
            refusal(dev_guard(&Method::POST, &with_token(crate::devtools::token()))),
            None,
            "the real token was refused"
        );
    }

    #[test]
    fn dev_routes_answer_405_to_anything_but_post() {
        let good = with_token(crate::devtools::token());
        assert_eq!(refusal(dev_guard(&Method::GET, &good)), Some(StatusCode::METHOD_NOT_ALLOWED));
        assert_eq!(refusal(dev_guard(&Method::DELETE, &good)), Some(StatusCode::METHOD_NOT_ALLOWED));
    }

    #[test]
    fn stringifies_non_string_body_values() {
        let inputs = body_to_inputs(br#"{"a":"x","b":2,"c":{"d":1}}"#);
        assert_eq!(inputs.get("a").unwrap(), "x");
        assert_eq!(inputs.get("b").unwrap(), "2");
        assert_eq!(inputs.get("c").unwrap(), r#"{"d":1}"#);
    }

    #[test]
    fn tolerates_an_empty_or_invalid_body() {
        assert!(body_to_inputs(b"").is_empty());
        assert!(body_to_inputs(b"not json").is_empty());
        assert!(body_to_inputs(b"[1,2,3]").is_empty());
    }
}
