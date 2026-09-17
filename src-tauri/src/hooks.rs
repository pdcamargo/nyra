//! Read/write the `hooks` block of a Claude Code settings.json, leaving every
//! other key in the file untouched.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

use crate::util;

fn settings_path(scope: &str, cwd: &str) -> PathBuf {
    if scope == "global" {
        util::home_dir().join(".claude").join("settings.json")
    } else {
        Path::new(cwd).join(".claude").join("settings.json")
    }
}

pub async fn read(scope: &str, cwd: &str) -> Value {
    let path = settings_path(scope, cwd);
    let hooks = tokio::fs::read_to_string(&path)
        .await
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|json| json.get("hooks").cloned())
        .unwrap_or_else(|| json!({}));
    json!({ "hooks": hooks })
}

pub async fn write(scope: &str, hooks: Value, cwd: &str) -> Result<(), String> {
    let path = settings_path(scope, cwd);
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
