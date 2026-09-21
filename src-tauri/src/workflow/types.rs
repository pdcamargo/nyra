//! Rust mirror of `src/shared/workflow-types.ts`.
//!
//! These are parsed *from* the JSON the renderer writes, never used as the
//! persistence format — `store.rs` round-trips the raw `Value` so a field the
//! renderer knows about and Rust doesn't is never silently dropped.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowNodeStatus {
    Idle,
    Running,
    Done,
    Failed,
    Skipped,
    AwaitingReview,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetVarSpec {
    pub name: String,
    #[serde(default)]
    pub extractor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum WorkflowNodeData {
    Prompt {
        #[serde(default)]
        prompt: String,
        #[serde(default)]
        system_prompt: Option<String>,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        allowed_tools: Option<Vec<String>>,
        #[serde(default)]
        set_vars: Option<Vec<SetVarSpec>>,
    },
    Condition {
        #[serde(default)]
        expression: String,
    },
    Script {
        #[serde(default)]
        command: String,
        /// How long to let it run, in milliseconds. Absent means the default.
        ///
        /// Exists because the default is deliberately short — a script node is
        /// usually a guard or a summary, and one that hangs should not hold a
        /// run open. But some steps legitimately take much longer than that:
        /// waiting on a build is the case this was added for, where the only
        /// honest answer is to sit there until it finishes.
        #[serde(default, rename = "timeoutMs")]
        timeout_ms: Option<u64>,
    },
    /// Pure fan-out — the outgoing edges define the branches.
    Parallel {},
    /// Waits for every incoming edge, then concatenates their outputs.
    Join {
        #[serde(default)]
        separator: Option<String>,
    },
    Loop {
        #[serde(default)]
        condition: String,
        #[serde(default)]
        max_iterations: i64,
    },
    HumanReview {
        #[serde(default)]
        message: Option<String>,
    },
    Subworkflow {
        #[serde(default)]
        workflow_id: String,
        #[serde(default)]
        input_mapping: Option<HashMap<String, String>>,
        #[serde(default)]
        capture_vars: Option<Vec<String>>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Position {
    #[serde(default)]
    pub x: f64,
    #[serde(default)]
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkflowNode {
    pub id: String,
    pub data: WorkflowNodeData,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub position: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEdge {
    #[serde(default)]
    pub id: String,
    pub source: String,
    pub target: String,
    /// Handle id on the source node — condition `yes`/`no`, loop `body`/`exit`.
    #[serde(default)]
    pub source_handle: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
}

impl WorkflowEdge {
    /// The handle an edge leaves by; `label` is the legacy fallback.
    pub fn handle(&self) -> Option<&str> {
        self.source_handle
            .as_deref()
            .or(self.label.as_deref())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowInputVar {
    pub key: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub placeholder: Option<String>,
    #[serde(default)]
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum WorkflowTrigger {
    Cron {
        id: String,
        #[serde(default)]
        enabled: bool,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        schedule: String,
        #[serde(default)]
        cwd: String,
        #[serde(default)]
        input_values: Option<HashMap<String, String>>,
    },
    FileWatcher {
        id: String,
        #[serde(default)]
        enabled: bool,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        paths: Vec<String>,
        #[serde(default)]
        cwd: String,
        #[serde(default)]
        events: Option<Vec<String>>,
        #[serde(default)]
        debounce_ms: Option<u64>,
        #[serde(default)]
        input_values: Option<HashMap<String, String>>,
    },
    Webhook {
        id: String,
        #[serde(default)]
        enabled: bool,
        #[serde(default)]
        name: Option<String>,
        #[serde(default)]
        token: String,
        #[serde(default)]
        cwd: String,
        #[serde(default)]
        input_values: Option<HashMap<String, String>>,
    },
}

impl WorkflowTrigger {
    pub fn id(&self) -> &str {
        match self {
            Self::Cron { id, .. } | Self::FileWatcher { id, .. } | Self::Webhook { id, .. } => id,
        }
    }
    pub fn enabled(&self) -> bool {
        match self {
            Self::Cron { enabled, .. }
            | Self::FileWatcher { enabled, .. }
            | Self::Webhook { enabled, .. } => *enabled,
        }
    }
    pub fn cwd(&self) -> &str {
        match self {
            Self::Cron { cwd, .. } | Self::FileWatcher { cwd, .. } | Self::Webhook { cwd, .. } => cwd,
        }
    }
    pub fn input_values(&self) -> HashMap<String, String> {
        match self {
            Self::Cron { input_values, .. }
            | Self::FileWatcher { input_values, .. }
            | Self::Webhook { input_values, .. } => input_values.clone().unwrap_or_default(),
        }
    }
    pub fn source(&self) -> TriggerSource {
        match self {
            Self::Cron { .. } => TriggerSource::Cron,
            Self::FileWatcher { .. } => TriggerSource::FileWatcher,
            Self::Webhook { .. } => TriggerSource::Webhook,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TriggerSource {
    Manual,
    Cron,
    FileWatcher,
    Webhook,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowDefinition {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub inputs: Option<Vec<WorkflowInputVar>>,
    #[serde(default)]
    pub nodes: Vec<WorkflowNode>,
    #[serde(default)]
    pub edges: Vec<WorkflowEdge>,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub is_template: Option<bool>,
    #[serde(default)]
    pub recent_cwds: Option<Vec<String>>,
    #[serde(default)]
    pub triggers: Option<Vec<WorkflowTrigger>>,
    #[serde(default)]
    pub marketplace_id: Option<String>,
    #[serde(default)]
    pub marketplace_version: Option<String>,
}

// ---- marketplace ----

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketplaceEntry {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub version: String,
    /// Path relative to the marketplace repo root.
    #[serde(default)]
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceIndex {
    #[serde(default)]
    pub schema_version: i64,
    #[serde(default)]
    pub updated_at: String,
    pub templates: Vec<MarketplaceEntry>,
}

// ---- runtime state ----

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowTokenUsage {
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_creation: i64,
}

impl std::ops::Add for WorkflowTokenUsage {
    type Output = Self;
    fn add(self, b: Self) -> Self {
        Self {
            input: self.input + b.input,
            output: self.output + b.output,
            cache_read: self.cache_read + b.cache_read,
            cache_creation: self.cache_creation + b.cache_creation,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowNodeRunState {
    pub node_id: String,
    pub status: WorkflowNodeStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub iteration: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<WorkflowTokenUsage>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionStatus {
    Done,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowExecutionRecord {
    pub id: String,
    pub workflow_id: String,
    #[serde(default)]
    pub workflow_name: String,
    pub status: ExecutionStatus,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub finished_at: i64,
    #[serde(default)]
    pub input_values: HashMap<String, String>,
    #[serde(default)]
    pub final_vars: HashMap<String, String>,
    #[serde(default)]
    pub node_states: HashMap<String, WorkflowNodeRunState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<WorkflowTokenUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub triggered_by: Option<TriggerSource>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopFailingNode {
    pub node_id: String,
    pub node_label: String,
    pub failures: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowMetrics {
    pub workflow_id: String,
    pub workflow_name: String,
    pub total_runs: i64,
    pub success_runs: i64,
    pub failed_runs: i64,
    pub aborted_runs: i64,
    pub avg_duration_ms: i64,
    pub total_tokens: WorkflowTokenUsage,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_status: Option<ExecutionStatus>,
    pub top_failing_nodes: Vec<TopFailingNode>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewRequest {
    pub execution_id: String,
    pub node_id: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    pub prev_output: String,
    pub vars: HashMap<String, String>,
}
