//! Workflow + execution-record persistence under `~/.nyra`.
//!
//! Definitions are stored and returned as raw `Value`s on purpose: the renderer
//! owns the schema, so round-tripping the JSON verbatim means a field it adds
//! can never be dropped by a Rust struct that predates it. The engine parses a
//! typed `WorkflowDefinition` out of the `Value` when it actually needs one.

use once_cell::sync::Lazy;
use serde_json::Value;
use std::path::PathBuf;

use super::helpers::aggregate_workflow_metrics;
use super::types::{WorkflowDefinition, WorkflowExecutionRecord, WorkflowMetrics};
use crate::util;

static DATA_DIR: Lazy<PathBuf> = Lazy::new(|| util::home_dir().join(".nyra"));
static WORKFLOW_DIR: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join("workflows"));
static EXECUTIONS_DIR: Lazy<PathBuf> = Lazy::new(|| DATA_DIR.join("workflow-executions"));

static BUILT_IN_TEMPLATES: Lazy<Vec<Value>> = Lazy::new(|| {
    serde_json::from_str(include_str!("templates.json")).unwrap_or_default()
});

/// Carry over workflows from a previous Nyra install, once, on first launch.
pub fn migrate_legacy_data_dir() {
    if DATA_DIR.exists() {
        return;
    }
    let legacy = util::home_dir().join(".nyra");
    if !legacy.exists() {
        return;
    }
    if let Err(e) = copy_dir_recursive(&legacy, &DATA_DIR) {
        crate::log!("store", "legacy data migration failed: {e}");
    } else {
        crate::log!("store", "migrated workflows from ~/.nyra to ~/.nyra");
    }
}

fn copy_dir_recursive(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            std::fs::copy(entry.path(), dest)?;
        }
    }
    Ok(())
}

async fn ensure_dir(dir: &PathBuf) {
    let _ = tokio::fs::create_dir_all(dir).await;
}

async fn read_json_dir(dir: &PathBuf) -> Vec<Value> {
    ensure_dir(dir).await;
    let mut out = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return out;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".json") {
            continue;
        }
        // Skip corrupt files rather than failing the whole listing.
        if let Ok(raw) = tokio::fs::read_to_string(entry.path()).await {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                out.push(value);
            }
        }
    }
    out
}

fn num(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0)
}

pub async fn list_workflows() -> Vec<Value> {
    let mut workflows = read_json_dir(&WORKFLOW_DIR).await;
    workflows.sort_by_key(|w| std::cmp::Reverse(num(w, "updatedAt")));
    workflows
}

pub async fn load_workflow(id: &str) -> Option<Value> {
    let path = WORKFLOW_DIR.join(format!("{id}.json"));
    if let Ok(raw) = tokio::fs::read_to_string(&path).await {
        if let Ok(value) = serde_json::from_str::<Value>(&raw) {
            return Some(value);
        }
    }
    // A subworkflow node may point straight at a built-in template.
    built_in_templates()
        .iter()
        .find(|t| t.get("id").and_then(Value::as_str) == Some(id))
        .cloned()
}

pub async fn load_workflow_typed(id: &str) -> Option<WorkflowDefinition> {
    let value = load_workflow(id).await?;
    match serde_json::from_value::<WorkflowDefinition>(value) {
        Ok(wf) => Some(wf),
        Err(e) => {
            crate::log!("store", "workflow {id} failed to parse: {e}");
            None
        }
    }
}

pub async fn save_workflow(mut wf: Value) -> Result<Value, String> {
    ensure_dir(&WORKFLOW_DIR).await;
    let id = wf
        .get("id")
        .and_then(Value::as_str)
        .ok_or("workflow is missing an id")?
        .to_string();
    if let Value::Object(map) = &mut wf {
        map.insert("updatedAt".into(), Value::from(util::now_ms()));
    }
    let body = serde_json::to_string_pretty(&wf).map_err(|e| e.to_string())?;
    tokio::fs::write(WORKFLOW_DIR.join(format!("{id}.json")), body)
        .await
        .map_err(|e| e.to_string())?;
    Ok(wf)
}

pub async fn delete_workflow(id: &str) -> Result<(), String> {
    let path = WORKFLOW_DIR.join(format!("{id}.json"));
    match tokio::fs::remove_file(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---- execution records ----

pub async fn save_execution_record(record: &WorkflowExecutionRecord) -> Result<(), String> {
    ensure_dir(&EXECUTIONS_DIR).await;
    let body = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    tokio::fs::write(EXECUTIONS_DIR.join(format!("{}.json", record.id)), body)
        .await
        .map_err(|e| e.to_string())
}

pub async fn list_execution_records(workflow_id: Option<&str>) -> Vec<WorkflowExecutionRecord> {
    let mut records: Vec<WorkflowExecutionRecord> = read_json_dir(&EXECUTIONS_DIR)
        .await
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .filter(|r: &WorkflowExecutionRecord| {
            workflow_id.is_none_or(|id| r.workflow_id == id)
        })
        .collect();
    records.sort_by_key(|r| std::cmp::Reverse(r.started_at));
    records
}

pub async fn load_execution_record(id: &str) -> Option<WorkflowExecutionRecord> {
    let raw = tokio::fs::read_to_string(EXECUTIONS_DIR.join(format!("{id}.json")))
        .await
        .ok()?;
    serde_json::from_str(&raw).ok()
}

pub async fn delete_execution_record(id: &str) -> Result<(), String> {
    match tokio::fs::remove_file(EXECUTIONS_DIR.join(format!("{id}.json"))).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

pub async fn compute_workflow_metrics(workflow_id: &str) -> Option<WorkflowMetrics> {
    let wf = load_workflow_typed(workflow_id).await?;
    let records = list_execution_records(Some(workflow_id)).await;
    Some(aggregate_workflow_metrics(&wf, &records))
}

pub fn built_in_templates() -> &'static [Value] {
    &BUILT_IN_TEMPLATES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ships_the_built_in_templates() {
        let templates = built_in_templates();
        assert_eq!(templates.len(), 8);
        for t in templates {
            assert!(t.get("id").and_then(Value::as_str).is_some());
            assert!(t.get("nodes").and_then(Value::as_array).is_some());
            assert!(t.get("edges").and_then(Value::as_array).is_some());
        }
    }

    #[test]
    fn every_template_parses_as_a_workflow_definition() {
        for t in built_in_templates() {
            let parsed: Result<WorkflowDefinition, _> = serde_json::from_value(t.clone());
            assert!(parsed.is_ok(), "template {t:?} failed: {:?}", parsed.err());
        }
    }
}
