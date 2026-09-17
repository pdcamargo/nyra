//! Read-only view of the MCP servers Claude Code has configured, merged from the
//! three places it stores them.

use serde::Serialize;
use serde_json::Value;
use std::path::Path;

use crate::util;

#[derive(Debug, Clone, Serialize)]
pub struct McpEntry {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub scope: String,
}

fn push_servers(results: &mut Vec<McpEntry>, raw: Option<&str>, scope: &str) {
    let Some(raw) = raw else { return };
    let Ok(json) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let Some(servers) = json.get("mcpServers").and_then(Value::as_object) else {
        return;
    };
    collect(results, servers, scope);
}

fn collect(
    results: &mut Vec<McpEntry>,
    servers: &serde_json::Map<String, Value>,
    scope: &str,
) {
    for (name, cfg) in servers {
        // First definition wins, matching Claude Code's own precedence.
        if results.iter().any(|r| &r.name == name) {
            continue;
        }
        results.push(McpEntry {
            name: name.clone(),
            command: cfg.get("command").and_then(Value::as_str).map(str::to_string),
            args: cfg.get("args").and_then(Value::as_array).map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            }),
            url: cfg.get("url").and_then(Value::as_str).map(str::to_string),
            scope: scope.to_string(),
        });
    }
}

pub async fn list(cwd: &str) -> Vec<McpEntry> {
    let home = util::home_dir();
    let (global_raw, local_raw, project_raw) = tokio::join!(
        tokio::fs::read_to_string(home.join(".claude").join("settings.json")),
        tokio::fs::read_to_string(home.join(".claude.json")),
        tokio::fs::read_to_string(Path::new(cwd).join(".mcp.json")),
    );
    let global_raw = global_raw.ok();
    let local_raw = local_raw.ok();
    let project_raw = project_raw.ok();

    let mut results = Vec::new();

    // ~/.claude/settings.json → mcpServers
    push_servers(&mut results, global_raw.as_deref(), "global");
    // ~/.claude.json → mcpServers
    push_servers(&mut results, local_raw.as_deref(), "global");

    // ~/.claude.json → projects[<path>].mcpServers, for any ancestor of cwd
    if let Some(raw) = local_raw.as_deref() {
        if let Ok(json) = serde_json::from_str::<Value>(raw) {
            if let Some(projects) = json.get("projects").and_then(Value::as_object) {
                for (proj_path, proj_cfg) in projects {
                    if !cwd.starts_with(proj_path.as_str()) {
                        continue;
                    }
                    if let Some(servers) = proj_cfg.get("mcpServers").and_then(Value::as_object) {
                        collect(&mut results, servers, "project");
                    }
                }
            }
        }
    }

    // <cwd>/.mcp.json → mcpServers
    push_servers(&mut results, project_raw.as_deref(), "project");

    results
}
