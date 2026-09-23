//! Everything Nyra knows about the MCP servers Claude Code has configured:
//! where each one is defined, whether this project is allowed to reach it, and
//! — only when asked — what tools it advertises.
//!
//! Three files hold these. `~/.claude/settings.json` and the top level of
//! `~/.claude.json` are global; `~/.claude.json`'s `projects` map is per
//! project, and `<cwd>/.mcp.json` is the checked-in one a team shares. Claude
//! Code resolves them in that order, first definition winning, and so do we.
//!
//! Values are the reason this module is careful. A server is defined by an
//! `env` or a `headers` block, and those routinely carry an API key. We read
//! them because a server cannot be started or reached without them, and we
//! never let one leave this process: `McpEntry` — the shape the renderer gets —
//! carries key *names* only, and every error path that could quote a value goes
//! through `redact` first.

use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::Manager;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::util;

/// One configured server, as the renderer sees it.
#[derive(Debug, Clone, Serialize)]
pub struct McpEntry {
    pub name: String,
    /// `stdio` | `http` | `sse` | `ws`. Taken from `type`, or from the presence
    /// of a URL — a config that only says `url` is the streamable-HTTP server
    /// the other transports gave way to.
    pub transport: String,
    /// `global` | `project`.
    pub scope: String,
    /// Which file defines it, written the way a user reads paths.
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Names, never values — enough to say "this one takes an API key".
    pub env_keys: Vec<String>,
    pub header_keys: Vec<String>,
    /// Whether Claude Code may connect to it in this project.
    pub disabled: bool,
}

/// A server with its secrets attached, for the two things that need them:
/// starting it, and reaching it. Deliberately not `Serialize`.
#[derive(Debug, Clone)]
struct RawServer {
    name: String,
    scope: String,
    source: String,
    transport: String,
    command: Option<String>,
    args: Vec<String>,
    url: Option<String>,
    env: BTreeMap<String, String>,
    headers: BTreeMap<String, String>,
    disabled: bool,
}

impl RawServer {
    fn entry(&self) -> McpEntry {
        McpEntry {
            name: self.name.clone(),
            transport: self.transport.clone(),
            scope: self.scope.clone(),
            source: self.source.clone(),
            command: self.command.clone(),
            args: (!self.args.is_empty()).then(|| self.args.clone()),
            url: self.url.clone(),
            env_keys: self.env.keys().cloned().collect(),
            header_keys: self.headers.keys().cloned().collect(),
            disabled: self.disabled,
        }
    }
}

// ---------------------------------------------------------------------------
// Reading the configuration
// ---------------------------------------------------------------------------

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn transport_of(cfg: &Value) -> String {
    if let Some(kind) = cfg.get("type").and_then(Value::as_str) {
        return kind.to_ascii_lowercase();
    }
    if cfg.get("url").and_then(Value::as_str).is_some() {
        return "http".to_string();
    }
    "stdio".to_string()
}

/// How a path reads in a one-line source label. The home directory is long and
/// identical on every row, so it becomes `~`.
fn display_path(path: &Path) -> String {
    let home = util::home_dir();
    match path.strip_prefix(&home) {
        Ok(rest) => format!("~/{}", rest.display()),
        Err(_) => path.display().to_string(),
    }
}

fn project_config<'a>(root: &'a Value, cwd: &str) -> Option<&'a Map<String, Value>> {
    root.get("projects")
        .and_then(Value::as_object)
        .and_then(|projects| projects.get(cwd))
        .and_then(Value::as_object)
}

/// Servers this project is told to skip, and servers it has approved. Both
/// lists name `.mcp.json` servers, which is the only scope Claude Code asks a
/// project to decide about.
fn project_choices(root: &Value, cwd: &str) -> (Vec<String>, Vec<String>) {
    let names = |key: &str| -> Vec<String> {
        project_config(root, cwd)
            .and_then(|project| project.get(key))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    (
        names("disabledMcpjsonServers"),
        names("enabledMcpjsonServers"),
    )
}

fn collect(
    out: &mut Vec<RawServer>,
    servers: &Map<String, Value>,
    scope: &str,
    source: &str,
    disabled: &[String],
) {
    for (name, cfg) in servers {
        // First definition wins, matching Claude Code's own precedence.
        if out.iter().any(|r| &r.name == name) {
            continue;
        }
        out.push(RawServer {
            name: name.clone(),
            scope: scope.to_string(),
            source: source.to_string(),
            transport: transport_of(cfg),
            command: cfg
                .get("command")
                .and_then(Value::as_str)
                .map(str::to_string),
            args: cfg
                .get("args")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default(),
            url: cfg.get("url").and_then(Value::as_str).map(str::to_string),
            env: string_map(cfg.get("env")),
            headers: string_map(cfg.get("headers")),
            disabled: disabled.iter().any(|d| d == name),
        });
    }
}

fn servers_of(raw: &str) -> Option<Map<String, Value>> {
    let json: Value = serde_json::from_str(raw).ok()?;
    json.get("mcpServers").and_then(Value::as_object).cloned()
}

/// Every server this project can reach, in Claude Code's own precedence order.
async fn discover(cwd: &str) -> Vec<RawServer> {
    let home = util::home_dir();
    let settings_path = home.join(".claude").join("settings.json");
    let local_path = home.join(".claude.json");
    let project_path = Path::new(cwd).join(".mcp.json");

    let (settings_raw, local_raw, project_raw) = tokio::join!(
        tokio::fs::read_to_string(&settings_path),
        tokio::fs::read_to_string(&local_path),
        tokio::fs::read_to_string(&project_path),
    );

    let local_json: Option<Value> = local_raw
        .as_deref()
        .ok()
        .and_then(|raw| serde_json::from_str(raw).ok());
    let disabled = match local_json.as_ref() {
        Some(root) => project_choices(root, cwd).0,
        None => Vec::new(),
    };

    let mut out = Vec::new();

    if let Ok(raw) = &settings_raw {
        if let Some(servers) = servers_of(raw) {
            collect(
                &mut out,
                &servers,
                "global",
                &display_path(&settings_path),
                &[],
            );
        }
    }

    if let Ok(raw) = &local_raw {
        if let Some(servers) = servers_of(raw) {
            collect(
                &mut out,
                &servers,
                "global",
                &display_path(&local_path),
                &[],
            );
        }
    }

    if let Some(root) = local_json.as_ref() {
        if let Some(projects) = root.get("projects").and_then(Value::as_object) {
            for (proj_path, proj_cfg) in projects {
                if !cwd.starts_with(proj_path.as_str()) {
                    continue;
                }
                let Some(servers) = proj_cfg.get("mcpServers").and_then(Value::as_object) else {
                    continue;
                };
                // The project key is a path; its last segment is the name worth
                // showing, and the whole path would not fit on a row.
                let label = format!(
                    "{} · {}",
                    display_path(&local_path),
                    Path::new(proj_path)
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| proj_path.clone())
                );
                collect(&mut out, servers, "project", &label, &disabled);
            }
        }
    }

    if let Ok(raw) = &project_raw {
        if let Some(servers) = servers_of(raw) {
            collect(
                &mut out,
                &servers,
                "project",
                &display_path(&project_path),
                &disabled,
            );
        }
    }

    out
}

pub async fn list(cwd: &str) -> Vec<McpEntry> {
    discover(cwd).await.iter().map(RawServer::entry).collect()
}

// ---------------------------------------------------------------------------
// Per-project approval
// ---------------------------------------------------------------------------

/// Replace one key in the `projects.<cwd>` entry of `~/.claude.json`.
///
/// Editing a 130 KB file of somebody else's state deserves a light touch: we
/// mutate exactly one array, leave every other value in the parsed document
/// alone, and write through a sibling temp file so a crash mid-write cannot
/// leave the CLI holding half a config.
fn write_project_list(root: &mut Value, cwd: &str, key: &str, name: &str, present: bool) {
    let Some(root) = root.as_object_mut() else {
        return;
    };
    let projects = root
        .entry("projects".to_string())
        .or_insert_with(|| json!({}));
    let Some(projects) = projects.as_object_mut() else {
        return;
    };
    let project = projects.entry(cwd.to_string()).or_insert_with(|| json!({}));
    let Some(project) = project.as_object_mut() else {
        return;
    };

    let mut list: Vec<String> = project
        .get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    list.retain(|n| n != name);
    if present {
        list.push(name.to_string());
    }
    if list.is_empty() {
        project.remove(key);
    } else {
        project.insert(
            key.to_string(),
            Value::Array(list.into_iter().map(Value::String).collect()),
        );
    }
}

pub async fn set_enabled(cwd: &str, name: &str, enabled: bool) -> Value {
    let path = util::home_dir().join(".claude.json");
    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(raw) => raw,
        Err(e) => {
            return json!({ "ok": false, "error": format!("Could not read ~/.claude.json: {e}") })
        }
    };
    let mut root: Value = match serde_json::from_str(&raw) {
        Ok(value) => value,
        Err(e) => {
            return json!({ "ok": false, "error": format!("~/.claude.json is not valid JSON: {e}") })
        }
    };

    // The two lists together are the whole decision, and the enabled one is the
    // answer: a name in both is enabled.
    write_project_list(&mut root, cwd, "disabledMcpjsonServers", name, !enabled);
    write_project_list(&mut root, cwd, "enabledMcpjsonServers", name, enabled);

    let Ok(serialized) = serde_json::to_string_pretty(&root) else {
        return json!({ "ok": false, "error": "Could not serialise ~/.claude.json." });
    };
    let temp = path.with_extension(format!("nyra-{}", std::process::id()));
    if let Err(e) = tokio::fs::write(&temp, format!("{serialized}\n")).await {
        return json!({ "ok": false, "error": format!("Could not write ~/.claude.json: {e}") });
    }
    if let Err(e) = tokio::fs::rename(&temp, &path).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return json!({ "ok": false, "error": format!("Could not replace ~/.claude.json: {e}") });
    }
    json!({ "ok": true, "name": name, "enabled": enabled })
}

// ---------------------------------------------------------------------------
// Asking a server what it exposes
// ---------------------------------------------------------------------------

/// Twenty seconds covers a cold `npx -y` against a warm cache and then some.
/// Past that the honest answer is that this server did not come up, and the
/// panel offers a retry instead of a spinner that never resolves.
const INSPECT_TIMEOUT: Duration = Duration::from_secs(20);

/// The sidecar's node script, from the same two locations the browser sidecar
/// resolves: packaged beside the app, and the repo in development.
fn script_path() -> Option<PathBuf> {
    if let Some(handle) = util::app_handle() {
        if let Ok(dir) = handle
            .path()
            .resolve("sidecar", tauri::path::BaseDirectory::Resource)
        {
            let candidate = dir.join("mcp-inspect.mjs");
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("sidecar")
        .join("mcp-inspect.mjs");
    dev.is_file().then_some(dev)
}

/// `which`, against the PATH the app resolved rather than the one it inherited.
fn which(name: &str) -> Option<PathBuf> {
    util::child_path().split(':').find_map(|dir| {
        let candidate = PathBuf::from(dir).join(name);
        candidate.is_file().then_some(candidate)
    })
}

/// Never let a configured secret reach a log, a toast, or the renderer.
///
/// An `env` value or a header value is the only secret in this flow, and both
/// are strings already in hand — so replacing every occurrence of each is exact
/// rather than a heuristic, and cannot miss a redaction it should have made.
fn redact(message: &str, secrets: &[&str]) -> String {
    let mut out = message.to_string();
    for secret in secrets {
        // Two characters is not a secret, it is the word "on".
        if secret.len() >= 4 && out.contains(secret) {
            out = out.replace(secret, "***");
        }
    }
    out
}

pub async fn inspect(cwd: &str, name: &str) -> Value {
    let servers = discover(cwd).await;
    let Some(server) = servers.into_iter().find(|s| s.name == name) else {
        return json!({
            "ok": false,
            "error": format!("No MCP server named `{name}` is configured here.")
        });
    };
    let Some(script) = script_path() else {
        return json!({ "ok": false, "error": "The MCP inspector script is missing from this build." });
    };
    let Some(node) = which("node") else {
        return json!({
            "ok": false,
            "error": "Node.js is not installed, or not on the PATH Nyra can see."
        });
    };

    let spec = json!({
        "transport": server.transport,
        "command": server.command,
        "args": server.args,
        "url": server.url,
        "env": server.env,
        "headers": server.headers,
        "cwd": cwd,
        "timeoutMs": INSPECT_TIMEOUT.as_millis() as u64,
    });

    let mut child = match Command::new(&node)
        .arg(&script)
        .current_dir(cwd)
        .env_clear()
        .envs(util::clean_child_env())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return json!({ "ok": false, "error": format!("Could not start the MCP inspector: {e}") })
        }
    };

    if let Some(mut stdin) = child.stdin.take() {
        let payload = format!("{spec}\n");
        if let Err(e) = stdin.write_all(payload.as_bytes()).await {
            return json!({
                "ok": false,
                "error": format!("Could not hand the server to the inspector: {e}")
            });
        }
        // Closing stdin is how the script knows there is nothing more coming.
        drop(stdin);
    }

    let secrets: Vec<&str> = server
        .env
        .values()
        .chain(server.headers.values())
        .map(String::as_str)
        .collect();

    let wait = async {
        let mut stdout = BufReader::new(child.stdout.take()?);
        let mut line = String::new();
        stdout.read_line(&mut line).await.ok()?;
        let _ = child.wait().await;
        // A script that could not print a line is a failure with nothing to
        // show; its stderr, which lands in the log, is where the reason is.
        if line.trim().is_empty() {
            return None;
        }
        serde_json::from_str::<Value>(&line).ok()
    };

    // Bound before the match: a future created in a `match` scrutinee lives
    // until the end of the match, which would keep `child` mutably borrowed in
    // the arm that has to kill it.
    let answer = tokio::time::timeout(INSPECT_TIMEOUT + Duration::from_secs(5), wait).await;
    match answer {
        Ok(Some(value)) if value.get("ok").and_then(Value::as_bool) == Some(true) => value,
        Ok(Some(value)) => {
            let error = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("The server did not answer.");
            json!({ "ok": false, "error": redact(error, &secrets) })
        }
        Ok(None) => json!({
            "ok": false,
            "error": redact(
                "The server did not come up in time. It may need `node` on PATH, or a credential that expired.",
                &secrets
            )
        }),
        Err(_) => {
            let _ = child.kill().await;
            json!({
                "ok": false,
                "error": "Asking this server for its tools timed out. Retry, or check that it starts on its own."
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn servers(raw: &str) -> Map<String, Value> {
        servers_of(raw).expect("mcpServers")
    }

    #[test]
    fn a_url_is_a_transport_even_when_type_is_absent() {
        assert_eq!(transport_of(&json!({ "url": "https://x/mcp" })), "http");
        assert_eq!(
            transport_of(&json!({ "type": "sse", "url": "https://x" })),
            "sse"
        );
        assert_eq!(transport_of(&json!({ "command": "npx" })), "stdio");
    }

    #[test]
    fn entries_report_key_names_and_never_values() {
        let raw = r#"{"mcpServers":{"sentry":{
            "command":"npx","args":["-y","sentry"],
            "env":{"SENTRY_TOKEN":"s3cret-value"},
            "headers":{"Authorization":"Bearer s3cret-value"}
        }}}"#;
        let mut out = Vec::new();
        collect(&mut out, &servers(raw), "global", "~/.claude.json", &[]);
        let entry = out[0].entry();
        assert_eq!(entry.env_keys, vec!["SENTRY_TOKEN".to_string()]);
        assert_eq!(entry.header_keys, vec!["Authorization".to_string()]);
        let serialized = serde_json::to_string(&entry).expect("serialize");
        assert!(!serialized.contains("s3cret-value"), "{serialized}");
    }

    #[test]
    fn the_first_definition_of_a_name_wins() {
        let mut out = Vec::new();
        collect(
            &mut out,
            &servers(r#"{"mcpServers":{"github":{"command":"gh-mcp"}}}"#),
            "global",
            "a",
            &[],
        );
        collect(
            &mut out,
            &servers(r#"{"mcpServers":{"github":{"command":"other"}}}"#),
            "project",
            "b",
            &[],
        );
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].source, "a");
    }

    #[test]
    fn a_disabled_server_is_marked_and_can_be_approved_again() {
        let mut root =
            json!({ "projects": { "/work/app": { "disabledMcpjsonServers": ["sentry"] } } });
        let (disabled, approved) = project_choices(&root, "/work/app");
        assert_eq!(disabled, vec!["sentry".to_string()]);
        assert!(approved.is_empty());

        write_project_list(
            &mut root,
            "/work/app",
            "enabledMcpjsonServers",
            "sentry",
            true,
        );
        write_project_list(
            &mut root,
            "/work/app",
            "disabledMcpjsonServers",
            "sentry",
            false,
        );
        let (disabled, approved) = project_choices(&root, "/work/app");
        assert!(disabled.is_empty());
        assert_eq!(approved, vec!["sentry".to_string()]);
    }

    #[test]
    fn an_empty_list_drops_its_key_rather_than_lingering() {
        let mut root =
            json!({ "projects": { "/work/app": { "disabledMcpjsonServers": ["sentry"] } } });
        write_project_list(
            &mut root,
            "/work/app",
            "disabledMcpjsonServers",
            "sentry",
            false,
        );
        assert!(root["projects"]["/work/app"]
            .get("disabledMcpjsonServers")
            .is_none());
    }

    #[test]
    fn redaction_replaces_a_secret_and_leaves_short_strings_alone() {
        assert_eq!(
            redact(
                "spawn failed for token abc123 while using ab",
                &["abc123", "ab"]
            ),
            "spawn failed for token *** while using ab"
        );
    }
}
