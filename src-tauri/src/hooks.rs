//! Read/write the `hooks` block of a Claude Code settings.json, leaving every
//! other key in the file untouched.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::environment::Environment;
use crate::util;

fn settings_path(scope: &str, cwd: &str, config_dir: Option<&Path>) -> PathBuf {
    if scope == "global" {
        // The workspace's, in the environment's config dir: a WSL project's
        // global hooks are the distro's whatever its workspace.
        util::claude_dir(&Environment::of(cwd), config_dir).join("settings.json")
    } else {
        Path::new(cwd).join(".claude").join("settings.json")
    }
}

pub async fn read(scope: &str, cwd: &str, config_dir: Option<&Path>) -> Value {
    let path = settings_path(scope, cwd, config_dir);
    let hooks = tokio::fs::read_to_string(&path)
        .await
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|json| json.get("hooks").cloned())
        .unwrap_or_else(|| json!({}));
    json!({ "hooks": hooks })
}

pub async fn write(scope: &str, hooks: Value, cwd: &str, config_dir: Option<&Path>) -> Result<(), String> {
    let path = settings_path(scope, cwd, config_dir);
    let dir = path.parent().ok_or("bad settings path")?;
    tokio::fs::create_dir_all(dir)
        .await
        .map_err(|e| e.to_string())?;

    // Merge rather than replace — settings.json holds far more than hooks.
    let mut json = tokio::fs::read_to_string(&path)
        .await
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));

    let is_empty = hooks.as_object().is_none_or(serde_json::Map::is_empty);
    if let Value::Object(map) = &mut json {
        if is_empty {
            map.remove("hooks");
        } else {
            map.insert("hooks".into(), hooks);
        }
    }

    let body = format!(
        "{}\n",
        serde_json::to_string_pretty(&json).map_err(|e| e.to_string())?
    );
    tokio::fs::write(&path, body)
        .await
        .map_err(|e| e.to_string())
}
