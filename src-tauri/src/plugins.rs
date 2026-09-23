//! Claude Code's plugin marketplace, driven through Claude Code's own CLI.
//!
//! Nothing here reimplements a marketplace. `claude plugin` already knows how
//! to resolve a catalog, read a `plugin.json`, fetch a git subdirectory and
//! decide whether a marketplace-declared command may run; the only thing a GUI
//! can add is the reading and the asking. So every state change in this file is
//! a fixed argv against the configured binary, and the rest is parsing what
//! comes back.
//!
//! Three rules are load-bearing:
//!
//! * argv is built here, never passed through from the renderer. The renderer
//!   names an action; this file decides what `claude` is invoked with.
//! * `-y` is never passed. A marketplace that installs by declaring a shell
//!   command gets to say so, and a person gets to read it — the CLI hands back
//!   the command and the sha256 of its text, and that hash is the only thing
//!   that can authorise it afterwards. Answering that prompt for the user would
//!   turn "install a plugin" into "run whatever this catalog says".
//! * metadata comes from Claude Code's own catalog cache, not from guesswork.
//!   The CLI's `--available` list carries a description and an install count but
//!   no category, author, or component inventory; the cache has all of it,
//!   already resolved, for plugins that are only available and not yet fetched.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;

use crate::claude;
use crate::util;

/// Reading the catalogs is a few file reads after the CLI resolves them.
const CATALOG_TIMEOUT: Duration = Duration::from_secs(90);
/// Installing can clone a repository. Ten minutes is not a hang.
const ACTION_TIMEOUT: Duration = Duration::from_secs(600);

/// What the renderer asks for. One struct rather than eight commands: the
/// renderer names an action and this file owns the argv, so the whole surface
/// is one line in `invoke_handler`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAction {
    /// `install` | `update` | `enable` | `disable` | `uninstall` | `details`
    /// | `marketplace.add` | `marketplace.remove` | `marketplace.update`.
    pub action: String,
    /// The plugin id, `name@marketplace`.
    #[serde(default)]
    pub id: Option<String>,
    /// `user` (the default) | `project` | `local`.
    #[serde(default)]
    pub scope: Option<String>,
    /// A marketplace source for `marketplace.add`: URL, path, or `owner/repo`.
    #[serde(default)]
    pub source: Option<String>,
    /// The project directory a project-scoped action belongs to.
    #[serde(default)]
    pub cwd: Option<String>,
    /// The sha256 a previous run reported for a marketplace-declared command,
    /// echoed back only after a person has seen that command.
    #[serde(default)]
    pub accept_command: Option<String>,
}

struct Outcome {
    ok: bool,
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

// ---------------------------------------------------------------------------
// Metadata: Claude Code's catalog cache, and the catalogs it was built from
// ---------------------------------------------------------------------------

/// The component inventory a plugin would add.
#[derive(Debug, Clone, Default, Serialize)]
struct Components {
    skills: Vec<String>,
    commands: Vec<String>,
    agents: Vec<String>,
    hooks: Vec<String>,
    #[serde(rename = "mcpServers")]
    mcp_servers: Vec<String>,
    #[serde(rename = "lspServers")]
    lsp_servers: Vec<String>,
}

impl Components {
    fn counts(&self) -> Value {
        json!({
            "skills": self.skills.len(),
            "commands": self.commands.len(),
            "agents": self.agents.len(),
            "hooks": self.hooks.len(),
            "mcpServers": self.mcp_servers.len(),
            "lspServers": self.lsp_servers.len(),
        })
    }
}

/// What a catalog knows about one plugin, whichever file it came from.
#[derive(Debug, Clone, Default)]
struct PluginMeta {
    display_name: Option<String>,
    description: Option<String>,
    category: Option<String>,
    author: Option<String>,
    homepage: Option<String>,
    keywords: Vec<String>,
    tags: Vec<String>,
    source: Option<String>,
    components: Option<Components>,
    /// `[{ model, alwaysOn, onInvoke }]`, when the catalog priced it.
    tokens: Vec<Value>,
    installs: Option<u64>,
    version: Option<String>,
}

/// Names out of either shape Claude Code uses for a component list: bare
/// strings (`hooks`, `mcpServers`) or `{ name, chars }` objects (skills).
fn names(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    entry
                        .as_str()
                        .map(str::to_string)
                        .or_else(|| text_at(entry, &["name"]))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn text_at(value: &Value, path: &[&str]) -> Option<String> {
    let mut cursor = value;
    for key in path {
        cursor = cursor.get(*key)?;
    }
    cursor.as_str().map(str::to_string)
}

fn string_list(value: &Value, key: &str) -> Vec<String> {
    names(value.get(key))
}

fn components_of(value: &Value) -> Components {
    Components {
        skills: names(value.get("skills")),
        commands: names(value.get("commands")),
        agents: names(value.get("agents")),
        hooks: names(value.get("hooks")),
        mcp_servers: names(value.get("mcpServers")),
        lsp_servers: names(value.get("lspServers")),
    }
}

/// Where a plugin actually comes from, in one line a person can read.
fn source_label(source: &Value) -> String {
    if let Some(text) = source.as_str() {
        return text.to_string();
    }
    if let Some(repo) = source.get("repo").and_then(Value::as_str) {
        return format!("github:{repo}");
    }
    if let Some(url) = source.get("url").and_then(Value::as_str) {
        return match source.get("path").and_then(Value::as_str) {
            Some(path) => format!("{url}#{path}"),
            None => url.to_string(),
        };
    }
    source
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("unknown source")
        .to_string()
}

/// One entry of `plugin-catalog-cache.json`.
fn meta_from_cache(entry: &Value) -> PluginMeta {
    let marketplace_entry = entry
        .get("marketplace_entry")
        .cloned()
        .unwrap_or(Value::Null);
    let tokens = entry
        .get("tokens")
        .and_then(Value::as_object)
        .map(|models| {
            models
                .iter()
                .map(|(model, price)| {
                    json!({
                        "model": model,
                        "alwaysOn": price.get("always_on").and_then(Value::as_u64),
                        "onInvoke": price.get("on_invoke").and_then(Value::as_u64),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    PluginMeta {
        display_name: text_at(&marketplace_entry, &["displayName"]),
        description: text_at(&marketplace_entry, &["description"]),
        category: text_at(&marketplace_entry, &["category"]),
        author: text_at(&marketplace_entry, &["author", "name"]),
        homepage: text_at(&marketplace_entry, &["homepage"]),
        keywords: string_list(&marketplace_entry, "keywords"),
        tags: string_list(&marketplace_entry, "tags"),
        source: marketplace_entry
            .get("source")
            .map(source_label)
            .filter(|label| label != "unknown source"),
        components: entry.get("components").map(components_of),
        tokens,
        installs: entry.get("unique_installs").and_then(Value::as_u64),
        version: text_at(entry, &["version"]),
    }
}

/// The metadata half of a `.claude-plugin/marketplace.json` entry, for a
/// marketplace the cache does not cover — a directory you added yourself.
fn meta_from_catalog(entry: &Value) -> PluginMeta {
    PluginMeta {
        display_name: text_at(entry, &["displayName"]),
        description: text_at(entry, &["description"]),
        category: text_at(entry, &["category"]),
        author: text_at(entry, &["author", "name"]),
        homepage: text_at(entry, &["homepage"]),
        keywords: string_list(entry, "keywords"),
        tags: string_list(entry, "tags"),
        source: entry.get("source").map(source_label),
        components: None,
        tokens: Vec::new(),
        installs: None,
        version: text_at(entry, &["version"]),
    }
}

/// `name@marketplace` → what the catalog knows, for every plugin in it.
///
/// Read from the cache Claude Code keeps at `~/.claude/plugins/`. That file is
/// five hundred kilobytes of already-resolved catalog, and its shape is the
/// reason the filter rail and the integrations row can be real: it is where
/// `category` and the per-plugin component list live, neither of which the
/// CLI's own `--available` output carries.
fn read_cache() -> BTreeMap<String, PluginMeta> {
    let path = util::home_dir()
        .join(".claude")
        .join("plugins")
        .join("plugin-catalog-cache.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return BTreeMap::new();
    };
    let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
        return BTreeMap::new();
    };
    let Some(plugins) = parsed
        .get("catalog")
        .and_then(|catalog| catalog.get("plugins"))
        .and_then(Value::as_object)
    else {
        return BTreeMap::new();
    };
    plugins
        .iter()
        .map(|(id, entry)| (id.clone(), meta_from_cache(entry)))
        .collect()
}

/// `name` → the entry a marketplace declares, read from its checkout.
fn read_catalog(install_location: &Path) -> BTreeMap<String, Value> {
    let candidates = [
        install_location
            .join(".claude-plugin")
            .join("marketplace.json"),
        install_location.join("marketplace.json"),
    ];
    for path in candidates {
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(plugins) = parsed.get("plugins").and_then(Value::as_array) else {
            continue;
        };
        return plugins
            .iter()
            .filter_map(|entry| {
                let name = entry.get("name").and_then(Value::as_str)?;
                Some((name.to_string(), entry.clone()))
            })
            .collect();
    }
    BTreeMap::new()
}

/// A relative catalog source is a directory already on disk, so its own
/// manifest can be read before anything is installed.
fn local_dir(install_location: &Path, source: &Value) -> Option<PathBuf> {
    let raw = source.as_str()?;
    if !(raw.starts_with("./") || raw.starts_with("../")) {
        return None;
    }
    let dir = install_location.join(raw.strip_prefix("./").unwrap_or(raw));
    dir.is_dir().then_some(dir)
}

/// Inventory for a plugin whose source is a directory we have: the real files,
/// counted the way a person would count them.
fn inventory_on_disk(dir: &Path) -> Components {
    let count = |sub: &str| -> Vec<String> {
        std::fs::read_dir(dir.join(sub))
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    };
    let manifest = std::fs::read_to_string(dir.join(".claude-plugin").join("plugin.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    Components {
        skills: count("skills"),
        commands: count("commands"),
        agents: count("agents"),
        hooks: count("hooks"),
        mcp_servers: manifest
            .as_ref()
            .and_then(|value| value.get("mcpServers"))
            .and_then(Value::as_object)
            .map(|servers| servers.keys().cloned().collect())
            .unwrap_or_default(),
        lsp_servers: manifest
            .as_ref()
            .and_then(|value| value.get("lspServers"))
            .and_then(Value::as_object)
            .map(|servers| servers.keys().cloned().collect())
            .unwrap_or_default(),
    }
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

/// Run `claude` with argv this file chose.
///
/// `stdin` is null on purpose. Several of these subcommands have an interactive
/// prompt, and a GUI that handed the CLI a live terminal would hang on a
/// question nobody can see.
async fn run(args: &[String], cwd: Option<&str>, timeout: Duration) -> Result<Outcome, String> {
    let binary = claude::resolve_claude_binary(&util::settings().claude_binary_path);
    let mut command = Command::new(&binary);
    command
        .args(args)
        .env_clear()
        .envs(util::clean_child_env())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Dropping the future is how a timeout ends, and a dropped child that
        // was still running would go on cloning into a cache nobody watches.
        .kill_on_drop(true);
    if let Some(cwd) = cwd.filter(|cwd| !cwd.is_empty()) {
        command.current_dir(cwd);
    }

    let child = command
        .spawn()
        .map_err(|e| format!("Could not run `{binary}`: {e}"))?;
    let output = match tokio::time::timeout(timeout, child.wait_with_output()).await {
        Ok(Ok(output)) => output,
        Ok(Err(e)) => return Err(format!("`{binary}` could not be read: {e}")),
        Err(_) => {
            return Ok(Outcome {
                ok: false,
                stdout: String::new(),
                stderr: format!(
                    "`claude {}` did not finish in {}s.",
                    args.join(" "),
                    timeout.as_secs()
                ),
                code: None,
            })
        }
    };

    Ok(Outcome {
        ok: output.status.success(),
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code(),
    })
}

/// Whatever JSON a `--json` run printed.
///
/// The two families disagree about shape: the list commands pretty-print a
/// whole document, and the action commands print one line. So this parses the
/// output as a whole first, and falls back to the last line that parses — which
/// also covers a CLI that warns to stdout before answering.
fn json_value(stdout: &str) -> Option<Value> {
    if let Ok(value) = serde_json::from_str::<Value>(stdout.trim()) {
        return Some(value);
    }
    stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
}

/// A message meant for a toast, not for a text view. A CLI that fails can put
/// its whole catalog on stderr, and pasting that into a panel helps nobody.
fn summarise(text: &str) -> String {
    let trimmed = text.trim();
    let mut out: String = trimmed.chars().take(400).collect();
    if trimmed.chars().count() > 400 {
        out.push('…');
    }
    out
}

/// A `shownCommand` block, which is the one thing we must never answer for the
/// user. Shape follows the CLI: `{ command, sha256 }` inside the JSON result.
fn shown_command(value: &Value) -> Option<(String, Option<String>)> {
    let block = value.get("shownCommand")?;
    let command = text_at(block, &["command"])?;
    Some((command, text_at(block, &["sha256"])))
}

/// `name@marketplace` split into its two halves.
pub fn split_id(id: &str) -> (String, Option<String>) {
    match id.split_once('@') {
        Some((name, marketplace)) if !marketplace.is_empty() => {
            (name.to_string(), Some(marketplace.to_string()))
        }
        _ => (id.to_string(), None),
    }
}

/// The one marketplace whose plugins Nyra marks as verified: the catalog
/// Anthropic publishes, which is the same list Claude Code itself recommends.
fn is_official(marketplace: &Value) -> bool {
    if marketplace.get("name").and_then(Value::as_str) == Some("claude-plugins-official") {
        return true;
    }
    marketplace
        .get("repo")
        .and_then(Value::as_str)
        .map(|repo| repo == "anthropics/claude-plugins-official")
        .unwrap_or(false)
}

fn marketplace_source_label(marketplace: &Value) -> String {
    if let Some(repo) = marketplace.get("repo").and_then(Value::as_str) {
        return format!("GitHub · {repo}");
    }
    if let Some(path) = marketplace.get("path").and_then(Value::as_str) {
        return format!("Directory · {path}");
    }
    marketplace
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or("Unknown source")
        .to_string()
}

fn title_case(id: &str) -> String {
    let mut chars = id.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

/// Sorting helpers. Free functions rather than closures because a closure
/// returning a borrowed `&str` invites a lifetime inference failure that reads
/// as a bug in the comparison.
fn count_of(row: &Value) -> u64 {
    row.get("count").and_then(Value::as_u64).unwrap_or(0)
}

fn label_of(row: &Value) -> &str {
    row.get("label").and_then(Value::as_str).unwrap_or("")
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

fn string_args(parts: &[&str]) -> Vec<String> {
    parts.iter().map(|part| part.to_string()).collect()
}

pub async fn catalog(cwd: Option<String>) -> Value {
    let dir = cwd.filter(|cwd| !cwd.is_empty());

    let listing = match run(
        &string_args(&["plugin", "list", "--json", "--available"]),
        dir.as_deref(),
        CATALOG_TIMEOUT,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => return json!({ "ok": false, "error": error }),
    };

    // Two shapes are in the wild: a bare array of installed plugins, and an
    // object with `installed` and `available`. Accept either rather than
    // requiring one version of the CLI.
    let (installed_raw, available_raw) = match json_value(&listing.stdout) {
        Some(Value::Object(map)) => (
            map.get("installed")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            map.get("available")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
        ),
        Some(Value::Array(list)) => (list, Vec::new()),
        _ => {
            let detail = summarise(if listing.stderr.trim().is_empty() {
                &listing.stdout
            } else {
                &listing.stderr
            });
            return json!({
                "ok": false,
                "error": if detail.is_empty() {
                    "Claude Code returned no plugin list.".to_string()
                } else {
                    detail
                }
            });
        }
    };

    let marketplaces_value = run(
        &string_args(&["plugin", "marketplace", "list", "--json"]),
        dir.as_deref(),
        CATALOG_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|outcome| json_value(&outcome.stdout))
    .unwrap_or_else(|| json!([]));
    let marketplace_list = marketplaces_value.as_array().cloned().unwrap_or_default();

    let cache = read_cache();

    // Fallbacks for a marketplace the cache does not cover, plus where each
    // marketplace keeps its checkout so a component list can be read on disk.
    let mut catalogs: BTreeMap<String, Value> = BTreeMap::new();
    let mut locations: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut rows: Vec<Value> = Vec::new();
    for marketplace in &marketplace_list {
        let name = marketplace
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let location = marketplace
            .get("installLocation")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let entries = Path::new(&location)
            .is_dir()
            .then(|| read_catalog(Path::new(&location)))
            .unwrap_or_default();
        for (plugin, entry) in entries {
            catalogs.insert(plugin, entry);
        }
        let path = PathBuf::from(&location);
        locations.insert(name.clone(), path);
        rows.push(json!({
            "name": name,
            "source": marketplace_source_label(marketplace),
            "location": location,
            "official": is_official(marketplace),
            "pluginCount": catalogs.len(),
        }));
    }

    let installed_by_name: BTreeMap<String, Value> = installed_raw
        .iter()
        .filter_map(|entry| {
            let id = entry.get("id").and_then(Value::as_str)?;
            Some((split_id(id).0, entry.clone()))
        })
        .collect();

    let string_at = |value: &Value, key: &str| -> Option<String> {
        value.get(key).and_then(Value::as_str).map(str::to_string)
    };

    let installed: Vec<Value> = installed_raw
        .iter()
        .map(|entry| {
            let id = entry.get("id").and_then(Value::as_str).unwrap_or_default();
            let (name, marketplace) = split_id(id);
            let meta = cache
                .get(id)
                .cloned()
                .or_else(|| catalogs.get(&name).map(meta_from_catalog))
                .unwrap_or_default();
            json!({
                "id": id,
                "name": name,
                "marketplace": marketplace,
                "version": string_at(entry, "version").or(meta.version),
                "scope": string_at(entry, "scope"),
                "enabled": entry.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                "installPath": string_at(entry, "installPath"),
                "installedAt": string_at(entry, "installedAt"),
                "lastUpdated": string_at(entry, "lastUpdated"),
                "description": meta.description,
                "category": meta.category,
                "author": meta.author,
                "components": meta.components.map(|c| c.counts()),
            })
        })
        .collect();

    let mut categories: BTreeMap<String, usize> = BTreeMap::new();
    let available: Vec<Value> = available_raw
        .iter()
        .map(|entry| {
            let id = text_at(entry, &["pluginId"])
                .or_else(|| text_at(entry, &["id"]))
                .unwrap_or_default();
            let (name, marketplace) = split_id(&id);
            let meta = cache
                .get(&id)
                .cloned()
                .or_else(|| catalogs.get(&name).map(meta_from_catalog))
                .unwrap_or_default();
            if let Some(category) = meta.category.as_deref() {
                *categories.entry(category.to_string()).or_default() += 1;
            }

            let installed_row = installed_by_name.get(&name);
            // An integration is a plugin that ships an MCP server. That is the
            // line Claude's own marketplace draws between its two rows, and it
            // is answered from the component list rather than from a name.
            let integration = meta
                .components
                .as_ref()
                .map(|components| !components.mcp_servers.is_empty())
                .or_else(|| {
                    installed_row
                        .and_then(|row| row.get("mcpServers"))
                        .and_then(Value::as_object)
                        .map(|servers| !servers.is_empty())
                })
                .or_else(|| {
                    meta.source
                        .as_deref()
                        .map(|source| source.contains("external_plugins"))
                })
                .unwrap_or(false);

            let components = meta.components.clone().or_else(|| {
                locations
                    .get(marketplace.as_deref().unwrap_or_default())
                    .and_then(|location| local_dir(location, entry.get("source")?))
                    .map(|dir| inventory_on_disk(&dir))
            });

            json!({
                "id": id,
                "name": name,
                "displayName": meta.display_name,
                "description": text_at(entry, &["description"]).or(meta.description),
                "marketplace": marketplace,
                "category": meta.category,
                "author": meta.author,
                "homepage": meta.homepage,
                "keywords": meta.keywords,
                "tags": meta.tags,
                "installCount": entry.get("installCount").and_then(Value::as_u64).or(meta.installs),
                "version": text_at(entry, &["version"]).or(meta.version),
                "kind": if integration { "integration" } else { "plugin" },
                "verified": marketplace.as_deref() == Some("claude-plugins-official"),
                "source": meta.source.unwrap_or_else(|| source_label(&entry.get("source").cloned().unwrap_or(Value::Null))),
                "components": components.map(|c| c.counts()),
                "tokens": meta.tokens,
                "installed": installed_row.is_some(),
                "enabled": installed_row
                    .and_then(|row| row.get("enabled"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                "installedVersion": installed_row
                    .and_then(|row| row.get("version"))
                    .and_then(Value::as_str),
                "installedScope": installed_row
                    .and_then(|row| row.get("scope"))
                    .and_then(Value::as_str),
            })
        })
        .collect();

    let mut category_rows: Vec<Value> = categories
        .into_iter()
        .map(|(id, count)| json!({ "id": id, "label": title_case(&id), "count": count }))
        .collect();
    // Most-populated first, because that is what makes the rail useful; the
    // label breaks ties so two equal categories do not shuffle between loads.
    category_rows.sort_by(|a, b| {
        count_of(b)
            .cmp(&count_of(a))
            .then_with(|| label_of(a).cmp(label_of(b)))
    });

    json!({
        "ok": true,
        "binary": claude::resolve_claude_binary(&util::settings().claude_binary_path),
        "installed": installed,
        "available": available,
        "marketplaces": rows,
        "categories": category_rows,
    })
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/// Turn a CLI outcome into the shape the panel renders.
///
/// A run that needs a marketplace-declared command is not a failure — it is the
/// CLI refusing to guess, and it is the one result that has to reach a person
/// rather than a retry loop.
fn settle(outcome: Outcome, args: &[String]) -> Value {
    let parsed = json_value(&outcome.stdout);
    if let Some((command, hash)) = parsed.as_ref().and_then(shown_command) {
        return json!({
            "ok": false,
            "needsConfirmation": true,
            "command": command,
            "sha256": hash,
            "message": "This marketplace installs by running a command of its own. Read it before allowing it."
        });
    }
    if outcome.ok {
        return json!({ "ok": true, "result": parsed, "output": outcome.stdout.trim() });
    }
    let detail = summarise(if outcome.stderr.trim().is_empty() {
        &outcome.stdout
    } else {
        &outcome.stderr
    });
    json!({
        "ok": false,
        "error": if detail.is_empty() {
            format!("`claude {}` failed.", args.join(" "))
        } else {
            detail
        },
        "code": outcome.code,
    })
}

fn args_for(action: &PluginAction) -> Result<Vec<String>, String> {
    let scope = action.scope.clone().unwrap_or_else(|| "user".to_string());
    let id = action
        .id
        .clone()
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "This action needs a plugin.".to_string())?;
    let accepted = action
        .accept_command
        .clone()
        .filter(|hash| !hash.is_empty());
    let mut args: Vec<String> = vec!["plugin".into()];

    match action.action.as_str() {
        "install" | "update" => {
            args.extend([
                action.action.clone(),
                id,
                "--scope".into(),
                scope,
                "--json".into(),
            ]);
            if let Some(hash) = accepted {
                args.extend(["--accept-command".into(), hash]);
            }
        }
        "enable" | "disable" => {
            args.extend([
                action.action.clone(),
                id,
                "--scope".into(),
                scope,
                "--json".into(),
            ]);
        }
        "uninstall" => args.extend(["uninstall".into(), id, "--json".into()]),
        _ => return Err(format!("`{}` is not a plugin action.", action.action)),
    }
    Ok(args)
}

/// The full component list for one plugin, before or after installing it.
///
/// Answered from Claude Code's own cache first: it already resolved this for
/// plugins that are only available, which is exactly the moment a person wants
/// to know what they are about to add.
async fn details(request: &PluginAction) -> Value {
    let Some(id) = request.id.clone().filter(|id| !id.is_empty()) else {
        return json!({ "ok": false, "error": "Which plugin?" });
    };
    let cache = read_cache();
    if let Some(meta) = cache.get(&id) {
        return json!({
            "ok": true,
            "id": id,
            "version": meta.version,
            "source": meta.source,
            "components": meta.components.clone().unwrap_or_default(),
            "tokens": meta.tokens,
            "resolved": true,
        });
    }

    // Not in the cache: a marketplace you added from a directory is on disk, so
    // its files can still be counted.
    let marketplaces = run(
        &string_args(&["plugin", "marketplace", "list", "--json"]),
        request.cwd.as_deref(),
        CATALOG_TIMEOUT,
    )
    .await
    .ok()
    .and_then(|outcome| json_value(&outcome.stdout))
    .unwrap_or_else(|| json!([]));
    let (name, marketplace) = split_id(&id);
    let Some(marketplace) = marketplace else {
        return json!({ "ok": false, "error": "That is not a plugin id." });
    };
    let Some(location) = marketplaces
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .find(|row| text_at(row, &["name"]).as_deref() == Some(&marketplace))
        })
        .and_then(|row| text_at(row, &["installLocation"]))
    else {
        return json!({ "ok": false, "error": "That marketplace is not configured." });
    };
    let entries = read_catalog(Path::new(&location));
    let Some(entry) = entries.get(&name) else {
        return json!({ "ok": false, "error": "That plugin is not in its marketplace." });
    };
    let source = entry.get("source").cloned().unwrap_or(Value::Null);
    match local_dir(Path::new(&location), &source) {
        Some(dir) => {
            let components = inventory_on_disk(&dir);
            json!({
                "ok": true,
                "id": id,
                "version": text_at(entry, &["version"]),
                "source": source_label(&source),
                "components": components,
                "tokens": [],
                "resolved": true,
            })
        }
        // A remote source we have not fetched. Saying so is the honest answer;
        // an invented inventory would be worse than none.
        None => json!({
            "ok": true,
            "id": id,
            "version": text_at(entry, &["version"]),
            "source": source_label(&source),
            "components": Value::Null,
            "tokens": [],
            "resolved": false,
        }),
    }
}

pub async fn action(request: PluginAction) -> Value {
    if request.action == "details" {
        return details(&request).await;
    }

    let cwd = request.cwd.clone().filter(|cwd| !cwd.is_empty());

    // Marketplace management is a separate subcommand tree with no `--json`.
    if request.action.starts_with("marketplace.") {
        let scope = request.scope.clone().unwrap_or_else(|| "user".to_string());
        let args: Vec<String> = match request.action.as_str() {
            "marketplace.add" => {
                let Some(source) = request.source.clone().filter(|s| !s.trim().is_empty()) else {
                    return json!({ "ok": false, "error": "A marketplace needs a source." });
                };
                vec![
                    "plugin".into(),
                    "marketplace".into(),
                    "add".into(),
                    source,
                    "--scope".into(),
                    scope,
                ]
            }
            "marketplace.remove" => {
                let Some(name) = request.id.clone().filter(|s| !s.is_empty()) else {
                    return json!({ "ok": false, "error": "Which marketplace?" });
                };
                vec![
                    "plugin".into(),
                    "marketplace".into(),
                    "remove".into(),
                    name,
                    "--scope".into(),
                    scope,
                ]
            }
            "marketplace.update" => {
                let mut args = string_args(&["plugin", "marketplace", "update"]);
                if let Some(name) = request.id.clone().filter(|s| !s.is_empty()) {
                    args.push(name);
                }
                args
            }
            other => return json!({ "ok": false, "error": format!("`{other}` is not an action.") }),
        };
        return match run(&args, cwd.as_deref(), ACTION_TIMEOUT).await {
            Ok(outcome) => settle(outcome, &args),
            Err(error) => json!({ "ok": false, "error": error }),
        };
    }

    let args = match args_for(&request) {
        Ok(args) => args,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    match run(&args, cwd.as_deref(), ACTION_TIMEOUT).await {
        Ok(outcome) => settle(outcome, &args),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "reads this machine's Claude Code catalogs; run by hand"]
    async fn smoke_against_the_real_catalogs() {
        let catalog = catalog(None).await;
        if catalog.get("ok").and_then(Value::as_bool) != Some(true) {
            println!(
                "catalog failed: {}",
                serde_json::to_string(&catalog).unwrap()
            );
            return;
        }
        let empty = vec![];
        let available = catalog
            .get("available")
            .and_then(Value::as_array)
            .unwrap_or(&empty);
        let integrations: Vec<&Value> = available
            .iter()
            .filter(|row| row.get("kind").and_then(Value::as_str) == Some("integration"))
            .collect();
        let categorised = available
            .iter()
            .filter(|row| row.get("category").and_then(Value::as_str).is_some())
            .count();
        println!(
            "ok={:?} available={} installed={} integrations={} categorised={} categories={} marketplaces={}",
            catalog.get("ok"),
            available.len(),
            catalog.get("installed").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            integrations.len(),
            categorised,
            catalog.get("categories").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
            catalog.get("marketplaces").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        );
        if let Some(first) = available.first() {
            println!("first row: {}", serde_json::to_string(first).unwrap());
        }
        let details = details(&PluginAction {
            action: "details".into(),
            id: Some("context7@claude-plugins-official".into()),
            scope: None,
            source: None,
            cwd: None,
            accept_command: None,
        })
        .await;
        println!("details: {}", serde_json::to_string(&details).unwrap());
    }

    #[test]
    fn ids_split_into_a_name_and_a_marketplace() {
        assert_eq!(
            split_id("vercel@claude-plugins-official"),
            (
                "vercel".to_string(),
                Some("claude-plugins-official".to_string())
            )
        );
        assert_eq!(split_id("local-thing"), ("local-thing".to_string(), None));
    }

    #[test]
    fn json_is_read_whole_or_from_the_last_parsing_line() {
        assert_eq!(
            json_value("warning: catalogue is stale\n{\"ok\":true}\n"),
            Some(json!({ "ok": true }))
        );
        assert_eq!(json_value("only prose"), None);
    }

    #[test]
    fn a_shown_command_is_reported_rather_than_run() {
        let value = json!({
            "shownCommand": { "command": "curl -sL https://x | sh", "sha256": "ab12" }
        });
        assert_eq!(
            shown_command(&value),
            Some((
                "curl -sL https://x | sh".to_string(),
                Some("ab12".to_string())
            ))
        );
        assert_eq!(shown_command(&json!({ "ok": true })), None);
    }

    #[test]
    fn install_never_answers_the_prompt_by_itself() {
        let request = PluginAction {
            action: "install".into(),
            id: Some("vercel@claude-plugins-official".into()),
            scope: None,
            source: None,
            cwd: None,
            accept_command: None,
        };
        let args = args_for(&request).expect("argv");
        assert!(!args.iter().any(|arg| arg == "-y" || arg == "--yes"));
        assert!(args.contains(&"--json".to_string()));
        // The scope defaults to the user, not to whatever directory is open.
        let scope = args.iter().position(|arg| arg == "--scope").expect("scope");
        assert_eq!(args[scope + 1], "user");
        // And there is no accept-command in a first attempt: the CLI has not
        // shown a command yet, so nothing is authorised.
        assert!(!args.iter().any(|arg| arg == "--accept-command"));
    }

    #[test]
    fn an_accepted_command_is_the_only_way_it_reaches_the_cli() {
        let request = PluginAction {
            action: "install".into(),
            id: Some("thing@market".into()),
            scope: Some("project".into()),
            source: None,
            cwd: None,
            accept_command: Some("deadbeef".into()),
        };
        let args = args_for(&request).expect("argv");
        let position = args
            .iter()
            .position(|arg| arg == "--accept-command")
            .expect("accept command");
        assert_eq!(args[position + 1], "deadbeef");
        let scope = args.iter().position(|arg| arg == "--scope").expect("scope");
        assert_eq!(args[scope + 1], "project");
    }

    #[test]
    fn the_component_list_is_read_from_either_shape_the_catalog_uses() {
        let entry = json!({
            "components": {
                "skills": [{ "name": "vercel-functions", "chars": { "always_on": 331 } }],
                "commands": ["deploy"],
                "agents": [],
                "hooks": ["SessionStart"],
                "mcpServers": ["vercel"],
                "lspServers": []
            },
            "tokens": { "claude-opus-4-7": { "always_on": 2904, "on_invoke": 0 } },
            "unique_installs": 1234,
            "version": "0.50.0",
            "marketplace_entry": {
                "category": "deployment",
                "author": { "name": "Vercel" },
                "homepage": "https://vercel.com",
                "source": { "source": "github", "repo": "vercel/vercel" }
            }
        });
        let meta = meta_from_cache(&entry);
        let components = meta.components.expect("components");
        assert_eq!(components.skills, vec!["vercel-functions".to_string()]);
        assert_eq!(components.commands, vec!["deploy".to_string()]);
        assert_eq!(components.mcp_servers, vec!["vercel".to_string()]);
        assert_eq!(meta.category.as_deref(), Some("deployment"));
        assert_eq!(meta.author.as_deref(), Some("Vercel"));
        assert_eq!(meta.source.as_deref(), Some("github:vercel/vercel"));
        assert_eq!(meta.installs, Some(1234));
        assert_eq!(meta.tokens.len(), 1);
        assert_eq!(
            components.counts(),
            json!({
                "skills": 1, "commands": 1, "agents": 0,
                "hooks": 1, "mcpServers": 1, "lspServers": 0
            })
        );
    }

    #[test]
    fn a_source_with_nothing_but_a_url_still_reads() {
        assert_eq!(
            source_label(&json!({
                "source": "git-subdir",
                "url": "https://github.com/a/b.git",
                "path": "plugins/x"
            })),
            "https://github.com/a/b.git#plugins/x"
        );
        assert_eq!(
            source_label(&json!("./external_plugins/linear")),
            "./external_plugins/linear"
        );
        assert_eq!(
            source_label(&json!({ "source": "github", "repo": "a/b" })),
            "github:a/b"
        );
    }

    #[test]
    fn only_the_published_catalog_counts_as_verified() {
        assert!(is_official(&json!({ "name": "claude-plugins-official" })));
        assert!(is_official(
            &json!({ "name": "renamed", "repo": "anthropics/claude-plugins-official" })
        ));
        assert!(!is_official(
            &json!({ "name": "mv", "repo": "MediaValet/mv" })
        ));
    }

    #[test]
    fn a_category_is_title_cased_for_the_rail() {
        assert_eq!(title_case("development"), "Development");
        assert_eq!(title_case(""), "");
    }

    #[test]
    fn an_unknown_action_names_itself_in_the_error() {
        let request = PluginAction {
            action: "format-the-disk".into(),
            id: Some("x".into()),
            scope: None,
            source: None,
            cwd: None,
            accept_command: None,
        };
        assert!(args_for(&request).unwrap_err().contains("format-the-disk"));
    }
}
