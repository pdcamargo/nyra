//! The workflow DAG scheduler.
//!
//! Walks the graph node by node: fan-out branches run concurrently, `join` nodes
//! block until every incoming branch has arrived, and `loop` nodes re-run their
//! body chain until the condition goes false. Each branch is an async task that
//! may recursively drive its own successors.

use async_recursion::async_recursion;
use futures::future::join_all;
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::oneshot;

use super::helpers::{apply_extractor, evaluate_condition, interpolate};
use super::store;
use super::types::*;
use crate::claude;
use crate::settings::NyraSettings;
use crate::util;

const MAX_SUBWORKFLOW_DEPTH: usize = 3;
const SCRIPT_TIMEOUT: Duration = Duration::from_secs(120);

struct ExecState {
    aborted: bool,
    vars: HashMap<String, String>,
    node_states: HashMap<String, WorkflowNodeRunState>,
    node_tokens: HashMap<String, WorkflowTokenUsage>,
    total_tokens: WorkflowTokenUsage,
    pending_reviews: HashMap<String, oneshot::Sender<bool>>,
}

struct Exec {
    id: String,
    wf: WorkflowDefinition,
    cwd: String,
    settings: NyraSettings,
    input_values: HashMap<String, String>,
    depth: usize,
    triggered_by: TriggerSource,
    state: Mutex<ExecState>,
    /// Shared with sub-workflows so an abort cascades into their Claude sessions.
    active_sessions: Arc<Mutex<HashSet<String>>>,
}

type ExecRef = Arc<Exec>;

#[derive(Default)]
struct JoinCollector {
    outputs: Vec<String>,
    arrivals: usize,
    expected: usize,
}

type Visited = Arc<Mutex<HashSet<String>>>;
type Collectors = Arc<Mutex<HashMap<String, JoinCollector>>>;

static ACTIVE: Lazy<Mutex<HashMap<String, ExecRef>>> = Lazy::new(|| Mutex::new(HashMap::new()));
static COUNTER: AtomicU64 = AtomicU64::new(0);

fn send_event(event: Value) {
    util::emit("workflow:event", event);
}

fn clip(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

// ---- graph helpers ----

fn incoming_edges<'a>(wf: &'a WorkflowDefinition, node_id: &str) -> Vec<&'a WorkflowEdge> {
    wf.edges.iter().filter(|e| e.target == node_id).collect()
}

fn outgoing_edges<'a>(
    wf: &'a WorkflowDefinition,
    node_id: &str,
    handle: Option<&str>,
) -> Vec<&'a WorkflowEdge> {
    wf.edges
        .iter()
        .filter(|e| e.source == node_id && handle.is_none_or(|h| e.handle() == Some(h)))
        .collect()
}

fn find_start_nodes(wf: &WorkflowDefinition) -> Vec<&WorkflowNode> {
    let targets: HashSet<&str> = wf.edges.iter().map(|e| e.target.as_str()).collect();
    wf.nodes
        .iter()
        .filter(|n| !targets.contains(n.id.as_str()))
        .collect()
}

fn find_node<'a>(wf: &'a WorkflowDefinition, node_id: &str) -> Option<&'a WorkflowNode> {
    wf.nodes.iter().find(|n| n.id == node_id)
}

// ---- state transitions ----

fn mark_node_start(exec: &ExecRef, node_id: &str, iteration: Option<i64>) {
    exec.state.lock().node_states.insert(
        node_id.to_string(),
        WorkflowNodeRunState {
            node_id: node_id.to_string(),
            status: WorkflowNodeStatus::Running,
            output: None,
            error: None,
            started_at: Some(util::now_ms()),
            finished_at: None,
            iteration,
            tokens: None,
        },
    );
    send_event(json!({
        "type": "node:start",
        "executionId": exec.id,
        "nodeId": node_id,
        "iteration": iteration,
    }));
}

fn mark_node_done(exec: &ExecRef, node_id: &str, output: &str) {
    let iteration = {
        let mut state = exec.state.lock();
        let prev = state.node_states.get(node_id);
        let started_at = prev.and_then(|p| p.started_at).unwrap_or_else(util::now_ms);
        let iteration = prev.and_then(|p| p.iteration);
        let tokens = state.node_tokens.get(node_id).copied();
        state.node_states.insert(
            node_id.to_string(),
            WorkflowNodeRunState {
                node_id: node_id.to_string(),
                status: WorkflowNodeStatus::Done,
                output: Some(clip(output, 10_000)),
                error: None,
                started_at: Some(started_at),
                finished_at: Some(util::now_ms()),
                iteration,
                tokens,
            },
        );
        iteration
    };
    send_event(json!({
        "type": "node:done",
        "executionId": exec.id,
        "nodeId": node_id,
        "output": clip(output, 2000),
        "iteration": iteration,
    }));
}

fn mark_node_failed(exec: &ExecRef, node_id: &str, error: &str) {
    send_event(json!({
        "type": "node:failed",
        "executionId": exec.id,
        "nodeId": node_id,
        "error": clip(error, 2000),
    }));
    exec.state.lock().node_states.insert(
        node_id.to_string(),
        WorkflowNodeRunState {
            node_id: node_id.to_string(),
            status: WorkflowNodeStatus::Failed,
            output: None,
            error: Some(error.to_string()),
            started_at: None,
            finished_at: Some(util::now_ms()),
            iteration: None,
            tokens: None,
        },
    );
}

fn apply_set_vars(exec: &ExecRef, set_vars: &Option<Vec<SetVarSpec>>, output: &str) {
    let Some(specs) = set_vars else { return };
    for spec in specs {
        let name = spec.name.trim();
        if name.is_empty() {
            continue;
        }
        let value = apply_extractor(&spec.extractor, output);
        exec.state
            .lock()
            .vars
            .insert(name.to_string(), value.clone());
        send_event(json!({
            "type": "variable:set",
            "executionId": exec.id,
            "name": name,
            "value": value,
        }));
    }
}

fn is_aborted(exec: &ExecRef) -> bool {
    exec.state.lock().aborted
}

// ---- node executors ----

async fn execute_prompt_node(
    node: &WorkflowNode,
    prev_output: &str,
    exec: &ExecRef,
    iteration: i64,
) -> Result<String, String> {
    let WorkflowNodeData::Prompt {
        prompt,
        system_prompt,
        model,
        allowed_tools,
        set_vars,
    } = &node.data
    else {
        return Err("Not a prompt node".into());
    };

    let (vars, input_values) = {
        let state = exec.state.lock();
        (state.vars.clone(), exec.input_values.clone())
    };
    let resolved = interpolate(prompt, prev_output, &input_values, &vars);
    crate::log!(
        "workflow",
        "Prompt node \"{}\" iter={iteration}: length={}",
        node.label,
        resolved.len()
    );

    let nyra_session_id = format!(
        "wf-{}-{}-{iteration}-{}",
        exec.id,
        node.id,
        util::now_ms()
    );
    exec.active_sessions.lock().insert(nyra_session_id.clone());

    let node_settings = NyraSettings {
        // Workflow runs are unattended: a permission prompt would deadlock them.
        skip_permissions: true,
        plan_mode: false,
        model: model.clone().filter(|m| !m.is_empty()).unwrap_or_else(|| exec.settings.model.clone()),
        system_prompt: system_prompt.clone().unwrap_or_default(),
        allowed_tools: allowed_tools.clone().filter(|t| !t.is_empty()),
        ..exec.settings.clone()
    };

    // Token usage accrues per node and rolls up to the execution total.
    {
        let exec = exec.clone();
        let node_id = node.id.clone();
        claude::on_claude_usage(
            &nyra_session_id,
            Arc::new(move |u: claude::Usage| {
                let delta = WorkflowTokenUsage {
                    input: u.input_tokens,
                    output: u.output_tokens,
                    cache_read: u.cache_read_input_tokens,
                    cache_creation: u.cache_creation_input_tokens,
                };
                let mut state = exec.state.lock();
                let entry = state.node_tokens.entry(node_id.clone()).or_default();
                *entry = *entry + delta;
                state.total_tokens = state.total_tokens + delta;
            }),
        );
    }

    let rx = claude::on_claude_result(&nyra_session_id);
    let run = tauri::async_runtime::spawn(claude::run_claude(
        resolved,
        exec.cwd.clone(),
        None,
        nyra_session_id.clone(),
        node_settings.spawn(),
        None,
    ));

    let outcome = match rx.await {
        Ok((result, is_error)) => {
            if is_error {
                Err(result)
            } else {
                Ok(result)
            }
        }
        // The sink was dropped: the session died before producing a result. The
        // spawned call carries the real reason.
        Err(_) => match run.await {
            Ok(Err(e)) => Err(e),
            Ok(Ok(_)) => Err("Claude session ended without a result".to_string()),
            Err(e) => Err(format!("Claude task failed: {e}")),
        },
    };

    exec.active_sessions.lock().remove(&nyra_session_id);
    claude::off_claude_usage(&nyra_session_id);

    let output = outcome?;
    apply_set_vars(exec, set_vars, &output);
    Ok(output)
}

async fn execute_script_node(
    node: &WorkflowNode,
    prev_output: &str,
    exec: &ExecRef,
) -> Result<String, String> {
    let WorkflowNodeData::Script { command } = &node.data else {
        return Err("Not a script node".into());
    };
    let (vars, input_values) = {
        let state = exec.state.lock();
        (state.vars.clone(), exec.input_values.clone())
    };
    let cmd = interpolate(command, prev_output, &input_values, &vars);

    let output = tokio::time::timeout(
        SCRIPT_TIMEOUT,
        tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&cmd)
            .current_dir(&exec.cwd)
            .output(),
    )
    .await
    .map_err(|_| format!("Script timed out after {}s", SCRIPT_TIMEOUT.as_secs()))?
    .map_err(|e| e.to_string())?;

    if output.status.success() {
        return Ok(String::from_utf8_lossy(&output.stdout).to_string());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    Err(if stderr.trim().is_empty() {
        format!("Script exited with code {}", output.status.code().unwrap_or(-1))
    } else {
        stderr
    })
}

async fn execute_subworkflow_node(
    node: &WorkflowNode,
    prev_output: &str,
    exec: &ExecRef,
) -> Result<String, String> {
    let WorkflowNodeData::Subworkflow {
        workflow_id,
        input_mapping,
        capture_vars,
    } = &node.data
    else {
        return Err("Not a subworkflow node".into());
    };

    if exec.depth >= MAX_SUBWORKFLOW_DEPTH {
        return Err(format!(
            "Sub-workflow depth limit ({MAX_SUBWORKFLOW_DEPTH}) exceeded"
        ));
    }

    let child = store::load_workflow_typed(workflow_id)
        .await
        .ok_or_else(|| format!("Sub-workflow not found: {workflow_id}"))?;

    // Resolve the child's inputs from the parent's context.
    let (vars, input_values) = {
        let state = exec.state.lock();
        (state.vars.clone(), exec.input_values.clone())
    };
    let mut child_inputs: HashMap<String, String> = HashMap::new();
    for (key, template) in input_mapping.clone().unwrap_or_default() {
        child_inputs.insert(key, interpolate(&template, prev_output, &input_values, &vars));
    }
    // Anything unmapped falls back to the child's own default.
    for inp in child.inputs.clone().unwrap_or_default() {
        if let Some(default) = inp.default_value.filter(|d| !d.is_empty()) {
            child_inputs.entry(inp.key).or_insert(default);
        }
    }

    let (output, final_vars) = run_child_workflow(child, child_inputs, exec).await?;

    // Copy the named child vars back into the parent (or all of them by default).
    let to_copy: Vec<String> = match capture_vars {
        Some(names) if !names.is_empty() => names.clone(),
        _ => final_vars.keys().cloned().collect(),
    };
    for name in to_copy {
        if let Some(value) = final_vars.get(&name) {
            exec.state.lock().vars.insert(name.clone(), value.clone());
            send_event(json!({
                "type": "variable:set",
                "executionId": exec.id,
                "name": name,
                "value": value,
            }));
        }
    }

    Ok(output)
}

async fn wait_for_review(
    node: &WorkflowNode,
    prev_output: &str,
    exec: &ExecRef,
) -> Result<bool, String> {
    let WorkflowNodeData::HumanReview { message } = &node.data else {
        return Err("Not a humanReview node".into());
    };

    let request = ReviewRequest {
        execution_id: exec.id.clone(),
        node_id: node.id.clone(),
        label: node.label.clone(),
        message: message.clone(),
        prev_output: clip(prev_output, 5000),
        vars: exec.state.lock().vars.clone(),
    };
    send_event(json!({
        "type": "node:awaiting-review",
        "executionId": exec.id,
        "nodeId": node.id,
        "request": request,
    }));

    let (tx, rx) = oneshot::channel();
    exec.state
        .lock()
        .pending_reviews
        .insert(node.id.clone(), tx);
    // A dropped sender means the run was aborted — treat that as a rejection.
    Ok(rx.await.unwrap_or(false))
}

// ---- scheduler ----

#[async_recursion]
async fn run_from_node(
    node_id: String,
    prev_output: String,
    exec: ExecRef,
    visited: Visited,
    collectors: Collectors,
) -> Result<(), String> {
    if is_aborted(&exec) {
        return Ok(());
    }
    let Some(node) = find_node(&exec.wf, &node_id).cloned() else {
        return Ok(());
    };

    // A join accumulates its inputs and only continues once the last one lands.
    if matches!(node.data, WorkflowNodeData::Join { .. }) {
        let combined = {
            let expected = incoming_edges(&exec.wf, &node_id).len();
            let mut collectors = collectors.lock();
            let collector = collectors.entry(node_id.clone()).or_insert(JoinCollector {
                outputs: Vec::new(),
                arrivals: 0,
                expected,
            });
            collector.outputs.push(prev_output);
            collector.arrivals += 1;
            if collector.arrivals < collector.expected {
                None // wait for siblings
            } else {
                let separator = match &node.data {
                    WorkflowNodeData::Join { separator } => {
                        separator.clone().unwrap_or_else(|| "\n\n---\n\n".into())
                    }
                    _ => unreachable!(),
                };
                Some(collector.outputs.join(&separator))
            }
        };

        let Some(combined) = combined else {
            return Ok(());
        };
        mark_node_start(&exec, &node.id, None);
        mark_node_done(&exec, &node.id, &combined);
        return run_successors(&node.id, &combined, &exec, &visited, &collectors).await;
    }

    // Only `loop` nodes are allowed to be re-entered.
    let is_loop = matches!(node.data, WorkflowNodeData::Loop { .. });
    {
        let mut visited = visited.lock();
        if visited.contains(&node_id) && !is_loop {
            return Ok(());
        }
        visited.insert(node_id.clone());
    }

    let result = run_node_body(&node, &prev_output, &exec, &visited, &collectors).await;
    if let Err(err) = &result {
        mark_node_failed(&exec, &node.id, err);
    }
    result
}

async fn run_node_body(
    node: &WorkflowNode,
    prev_output: &str,
    exec: &ExecRef,
    visited: &Visited,
    collectors: &Collectors,
) -> Result<(), String> {
    mark_node_start(exec, &node.id, None);

    match &node.data {
        WorkflowNodeData::Prompt { .. } => {
            let output = execute_prompt_node(node, prev_output, exec, 1).await?;
            mark_node_done(exec, &node.id, &output);
            run_successors(&node.id, &output, exec, visited, collectors).await
        }

        WorkflowNodeData::Script { .. } => {
            let output = execute_script_node(node, prev_output, exec).await?;
            mark_node_done(exec, &node.id, &output);
            run_successors(&node.id, &output, exec, visited, collectors).await
        }

        WorkflowNodeData::Parallel {} => {
            mark_node_done(exec, &node.id, prev_output);
            let branches: Vec<String> = outgoing_edges(&exec.wf, &node.id, None)
                .iter()
                .map(|e| e.target.clone())
                .collect();
            // Each branch gets its own visited set so siblings don't block each other.
            let base = visited.lock().clone();
            let futures = branches.into_iter().map(|target| {
                run_from_node(
                    target,
                    prev_output.to_string(),
                    exec.clone(),
                    Arc::new(Mutex::new(base.clone())),
                    collectors.clone(),
                )
            });
            first_error(join_all(futures).await)
        }

        WorkflowNodeData::Condition { expression } => {
            let (vars, iteration) = (exec.state.lock().vars.clone(), 1);
            let result = evaluate_condition(expression, prev_output, &vars, iteration);
            mark_node_done(exec, &node.id, if result { "yes" } else { "no" });

            let (taken, skipped) = if result { ("yes", "no") } else { ("no", "yes") };
            for edge in outgoing_edges(&exec.wf, &node.id, Some(skipped)) {
                send_event(json!({
                    "type": "node:skipped",
                    "executionId": exec.id,
                    "nodeId": edge.target,
                }));
                exec.state.lock().node_states.insert(
                    edge.target.clone(),
                    WorkflowNodeRunState {
                        node_id: edge.target.clone(),
                        status: WorkflowNodeStatus::Skipped,
                        output: None,
                        error: None,
                        started_at: None,
                        finished_at: Some(util::now_ms()),
                        iteration: None,
                        tokens: None,
                    },
                );
            }

            let next: Vec<String> = outgoing_edges(&exec.wf, &node.id, Some(taken))
                .iter()
                .map(|e| e.target.clone())
                .collect();
            let futures = next.into_iter().map(|target| {
                run_from_node(
                    target,
                    prev_output.to_string(),
                    exec.clone(),
                    visited.clone(),
                    collectors.clone(),
                )
            });
            first_error(join_all(futures).await)
        }

        WorkflowNodeData::Subworkflow { .. } => {
            let output = execute_subworkflow_node(node, prev_output, exec).await?;
            mark_node_done(exec, &node.id, &output);
            run_successors(&node.id, &output, exec, visited, collectors).await
        }

        WorkflowNodeData::HumanReview { .. } => {
            exec.state.lock().node_states.insert(
                node.id.clone(),
                WorkflowNodeRunState {
                    node_id: node.id.clone(),
                    status: WorkflowNodeStatus::AwaitingReview,
                    output: None,
                    error: None,
                    started_at: Some(util::now_ms()),
                    finished_at: None,
                    iteration: None,
                    tokens: None,
                },
            );
            let approved = wait_for_review(node, prev_output, exec).await?;
            if !approved {
                mark_node_done(exec, &node.id, "rejected");
                return Ok(()); // a rejection ends this branch
            }
            mark_node_done(exec, &node.id, "approved");
            run_successors(&node.id, prev_output, exec, visited, collectors).await
        }

        WorkflowNodeData::Loop {
            condition,
            max_iterations,
        } => {
            // Do-while: run the body chain, then test the condition.
            let mut current_output = prev_output.to_string();
            let mut iteration = 0i64;
            let max_iter = (*max_iterations).clamp(1, 1000);

            while iteration < max_iter && !is_aborted(exec) {
                iteration += 1;
                send_event(json!({
                    "type": "loop:iterate",
                    "executionId": exec.id,
                    "nodeId": node.id,
                    "iteration": iteration,
                }));
                mark_node_start(exec, &node.id, Some(iteration));

                // The body is walked as a linear chain; it ends when an edge points
                // back at the loop node or the chain runs out.
                let body_targets: Vec<String> = outgoing_edges(&exec.wf, &node.id, Some("body"))
                    .iter()
                    .map(|e| e.target.clone())
                    .collect();
                let body_visited: Visited = Arc::new(Mutex::new(HashSet::new()));
                for target in body_targets {
                    current_output =
                        run_loop_body(target, current_output, exec.clone(), body_visited.clone(), node.id.clone())
                            .await?;
                }

                let vars = exec.state.lock().vars.clone();
                if !evaluate_condition(condition, &current_output, &vars, iteration) {
                    break;
                }
            }

            mark_node_done(exec, &node.id, &current_output);
            let exits: Vec<String> = outgoing_edges(&exec.wf, &node.id, Some("exit"))
                .iter()
                .map(|e| e.target.clone())
                .collect();
            let futures = exits.into_iter().map(|target| {
                run_from_node(
                    target,
                    current_output.clone(),
                    exec.clone(),
                    visited.clone(),
                    collectors.clone(),
                )
            });
            first_error(join_all(futures).await)
        }

        WorkflowNodeData::Join { .. } => Ok(()), // handled before we get here
    }
}

#[async_recursion]
async fn run_loop_body(
    start_node_id: String,
    prev_output: String,
    exec: ExecRef,
    visited: Visited,
    loop_node_id: String,
) -> Result<String, String> {
    if is_aborted(&exec) {
        return Ok(prev_output);
    }
    // Back at the loop node — the body is complete.
    if start_node_id == loop_node_id {
        return Ok(prev_output);
    }
    let Some(node) = find_node(&exec.wf, &start_node_id).cloned() else {
        return Ok(prev_output);
    };
    {
        let mut visited = visited.lock();
        if visited.contains(&start_node_id) {
            return Ok(prev_output);
        }
        visited.insert(start_node_id.clone());
    }

    mark_node_start(&exec, &node.id, None);
    let output = match &node.data {
        WorkflowNodeData::Prompt { .. } => execute_prompt_node(&node, &prev_output, &exec, 1).await,
        WorkflowNodeData::Script { .. } => execute_script_node(&node, &prev_output, &exec).await,
        WorkflowNodeData::Condition { expression } => {
            let vars = exec.state.lock().vars.clone();
            Ok(if evaluate_condition(expression, &prev_output, &vars, 1) {
                "yes".to_string()
            } else {
                "no".to_string()
            })
        }
        _ => Ok(prev_output.clone()),
    };

    let output = match output {
        Ok(o) => o,
        Err(err) => {
            mark_node_failed(&exec, &node.id, &err);
            return Err(err);
        }
    };
    mark_node_done(&exec, &node.id, &output);

    // Linear chain — follow the first outgoing edge only.
    let Some(next) = outgoing_edges(&exec.wf, &node.id, None)
        .first()
        .map(|e| e.target.clone())
    else {
        return Ok(output);
    };
    run_loop_body(next, output, exec, visited, loop_node_id).await
}

async fn run_successors(
    node_id: &str,
    output: &str,
    exec: &ExecRef,
    visited: &Visited,
    collectors: &Collectors,
) -> Result<(), String> {
    let next: Vec<String> = outgoing_edges(&exec.wf, node_id, None)
        .iter()
        .map(|e| e.target.clone())
        .collect();
    let futures = next.into_iter().map(|target| {
        run_from_node(
            target,
            output.to_string(),
            exec.clone(),
            visited.clone(),
            collectors.clone(),
        )
    });
    first_error(join_all(futures).await)
}

fn first_error(results: Vec<Result<(), String>>) -> Result<(), String> {
    for r in results {
        r?;
    }
    Ok(())
}

// ---- public API ----

pub async fn execute_workflow(
    workflow_id: &str,
    cwd: &str,
    settings: NyraSettings,
    input_values: Option<HashMap<String, String>>,
    triggered_by: Option<TriggerSource>,
) -> Result<String, String> {
    let triggered_by = triggered_by.unwrap_or(TriggerSource::Manual);
    crate::log!(
        "workflow",
        "executeWorkflow: workflowId={workflow_id}, cwd={cwd}, triggeredBy={triggered_by:?}"
    );

    let wf = store::load_workflow_typed(workflow_id)
        .await
        .ok_or_else(|| format!("Workflow not found: {workflow_id}"))?;

    let execution_id = format!(
        "exec-{}-{}",
        COUNTER.fetch_add(1, Ordering::SeqCst) + 1,
        util::now_ms()
    );
    let started_at = util::now_ms();
    let wf_id = wf.id.clone();
    let wf_name = wf.name.clone();

    let exec: ExecRef = Arc::new(Exec {
        id: execution_id.clone(),
        wf,
        cwd: cwd.to_string(),
        settings,
        input_values: input_values.unwrap_or_default(),
        depth: 0,
        triggered_by,
        state: Mutex::new(ExecState {
            aborted: false,
            vars: HashMap::new(),
            node_states: HashMap::new(),
            node_tokens: HashMap::new(),
            total_tokens: WorkflowTokenUsage::default(),
            pending_reviews: HashMap::new(),
        }),
        active_sessions: Arc::new(Mutex::new(HashSet::new())),
    });
    ACTIVE.lock().insert(execution_id.clone(), exec.clone());

    record_recent_cwd(workflow_id, cwd).await;

    let start_nodes: Vec<String> = find_start_nodes(&exec.wf)
        .iter()
        .map(|n| n.id.clone())
        .collect();
    if start_nodes.is_empty() {
        ACTIVE.lock().remove(&execution_id);
        return Err("No start node found in workflow".into());
    }

    let collectors: Collectors = Arc::new(Mutex::new(HashMap::new()));
    let visited: Visited = Arc::new(Mutex::new(HashSet::new()));

    let results = join_all(start_nodes.into_iter().map(|id| {
        run_from_node(
            id,
            String::new(),
            exec.clone(),
            visited.clone(),
            collectors.clone(),
        )
    }))
    .await;

    let outcome = first_error(results);
    let (aborted, vars, node_states, total_tokens) = {
        let state = exec.state.lock();
        (
            state.aborted,
            state.vars.clone(),
            state.node_states.clone(),
            state.total_tokens,
        )
    };

    let record = WorkflowExecutionRecord {
        id: execution_id.clone(),
        workflow_id: wf_id,
        workflow_name: wf_name,
        // Abort wins over the failure it causes: cancelling a run kills its Claude
        // sessions, which surfaces as a failed node, but the user aborted it.
        status: match (&outcome, aborted) {
            (_, true) => ExecutionStatus::Aborted,
            (Err(_), false) => ExecutionStatus::Failed,
            (Ok(()), false) => ExecutionStatus::Done,
        },
        started_at,
        finished_at: util::now_ms(),
        input_values: exec.input_values.clone(),
        final_vars: vars,
        node_states,
        error: outcome.as_ref().err().cloned(),
        cwd: Some(cwd.to_string()),
        tokens: Some(total_tokens),
        triggered_by: Some(exec.triggered_by),
    };

    match (&outcome, aborted) {
        (_, true) => send_event(json!({
            "type": "execution:aborted",
            "executionId": execution_id,
            "record": record,
        })),
        (Err(err), false) => send_event(json!({
            "type": "execution:failed",
            "executionId": execution_id,
            "error": clip(err, 500),
            "record": record,
        })),
        (Ok(()), false) => send_event(json!({
            "type": "execution:done",
            "executionId": execution_id,
            "record": record,
        })),
    }

    ACTIVE.lock().remove(&execution_id);
    if let Err(e) = store::save_execution_record(&record).await {
        crate::log!("workflow", "saveExecutionRecord failed: {e}");
    }

    Ok(execution_id)
}

/// Push `cwd` to the front of the workflow's recents list (max 8).
async fn record_recent_cwd(workflow_id: &str, cwd: &str) {
    let Some(mut raw) = store::load_workflow(workflow_id).await else {
        return;
    };
    let current: Vec<String> = raw
        .get("recentCwds")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();

    let mut updated = vec![cwd.to_string()];
    updated.extend(current.iter().filter(|c| c.as_str() != cwd).cloned());
    updated.truncate(8);
    if updated == current {
        return;
    }
    if let Value::Object(map) = &mut raw {
        map.insert("recentCwds".into(), json!(updated));
    }
    if let Err(e) = store::save_workflow(raw).await {
        crate::log!("workflow", "recentCwds update failed: {e}");
    }
}

/// Run a sub-workflow inside a parent execution. Tokens bubble up and no
/// execution record is persisted — the child is part of the parent's run.
async fn run_child_workflow(
    wf: WorkflowDefinition,
    input_values: HashMap<String, String>,
    parent: &ExecRef,
) -> Result<(String, HashMap<String, String>), String> {
    let execution_id = format!(
        "exec-{}-{}-child",
        COUNTER.fetch_add(1, Ordering::SeqCst) + 1,
        util::now_ms()
    );
    let wf_name = wf.name.clone();

    let child: ExecRef = Arc::new(Exec {
        id: execution_id.clone(),
        wf,
        cwd: parent.cwd.clone(),
        settings: parent.settings.clone(),
        input_values,
        depth: parent.depth + 1,
        triggered_by: parent.triggered_by,
        state: Mutex::new(ExecState {
            aborted: is_aborted(parent),
            vars: HashMap::new(),
            node_states: HashMap::new(),
            node_tokens: HashMap::new(),
            total_tokens: WorkflowTokenUsage::default(),
            pending_reviews: HashMap::new(),
        }),
        // Shared, so aborting the parent reaches the child's Claude sessions.
        active_sessions: parent.active_sessions.clone(),
    });
    ACTIVE.lock().insert(execution_id.clone(), child.clone());

    let start_nodes: Vec<String> = find_start_nodes(&child.wf)
        .iter()
        .map(|n| n.id.clone())
        .collect();
    if start_nodes.is_empty() {
        ACTIVE.lock().remove(&execution_id);
        return Err(format!("Sub-workflow \"{wf_name}\" has no start node"));
    }

    let collectors: Collectors = Arc::new(Mutex::new(HashMap::new()));
    let visited: Visited = Arc::new(Mutex::new(HashSet::new()));

    let results = join_all(start_nodes.into_iter().map(|id| {
        run_from_node(
            id,
            String::new(),
            child.clone(),
            visited.clone(),
            collectors.clone(),
        )
    }))
    .await;
    let outcome = first_error(results);

    let (child_aborted, child_tokens, node_states, final_vars) = {
        let state = child.state.lock();
        (
            state.aborted,
            state.total_tokens,
            state.node_states.clone(),
            state.vars.clone(),
        )
    };

    ACTIVE.lock().remove(&execution_id);
    {
        let mut parent_state = parent.state.lock();
        parent_state.total_tokens = parent_state.total_tokens + child_tokens;
        if child_aborted {
            parent_state.aborted = true;
        }
    }
    outcome?;

    // The child's output is its terminal node's output.
    let output = find_terminal_node(&child.wf, &node_states)
        .and_then(|s| s.output.clone())
        .unwrap_or_default();
    Ok((output, final_vars))
}

fn find_terminal_node(
    wf: &WorkflowDefinition,
    node_states: &HashMap<String, WorkflowNodeRunState>,
) -> Option<WorkflowNodeRunState> {
    let has_outgoing: HashSet<&str> = wf.edges.iter().map(|e| e.source.as_str()).collect();
    let mut done: Vec<&WorkflowNodeRunState> = node_states
        .values()
        .filter(|s| s.status == WorkflowNodeStatus::Done)
        .collect();
    done.sort_by_key(|s| std::cmp::Reverse(s.finished_at.unwrap_or(0)));

    // Prefer a completed node with no successors; otherwise the most recent one.
    done.iter()
        .find(|s| !has_outgoing.contains(s.node_id.as_str()))
        .or_else(|| done.first())
        .map(|s| (*s).clone())
}

pub fn abort_workflow(execution_id: &str) {
    let Some(exec) = ACTIVE.lock().get(execution_id).cloned() else {
        return;
    };
    let sessions: Vec<String> = exec.active_sessions.lock().iter().cloned().collect();
    let reviews: Vec<oneshot::Sender<bool>> = {
        let mut state = exec.state.lock();
        state.aborted = true;
        state.pending_reviews.drain().map(|(_, tx)| tx).collect()
    };
    for session in sessions {
        claude::abort_claude(Some(&session));
    }
    for tx in reviews {
        let _ = tx.send(false);
    }
}

pub fn respond_to_review(execution_id: &str, node_id: &str, approved: bool) -> bool {
    let Some(exec) = ACTIVE.lock().get(execution_id).cloned() else {
        return false;
    };
    let tx = exec.state.lock().pending_reviews.remove(node_id);
    match tx {
        Some(tx) => tx.send(approved).is_ok(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wf_with_edges(edges: Vec<(&str, &str, Option<&str>)>, node_ids: &[&str]) -> WorkflowDefinition {
        WorkflowDefinition {
            id: "wf".into(),
            name: "wf".into(),
            description: None,
            inputs: None,
            nodes: node_ids
                .iter()
                .map(|id| WorkflowNode {
                    id: (*id).into(),
                    label: (*id).into(),
                    position: Position::default(),
                    data: WorkflowNodeData::Script { command: "true".into() },
                })
                .collect(),
            edges: edges
                .into_iter()
                .map(|(source, target, handle)| WorkflowEdge {
                    id: format!("{source}-{target}"),
                    source: source.into(),
                    target: target.into(),
                    source_handle: handle.map(str::to_string),
                    label: None,
                })
                .collect(),
            created_at: 0,
            updated_at: 0,
            is_template: None,
            recent_cwds: None,
            triggers: None,
            marketplace_id: None,
            marketplace_version: None,
        }
    }

    #[test]
    fn start_nodes_are_those_with_no_inbound_edge() {
        let wf = wf_with_edges(vec![("a", "b", None), ("b", "c", None)], &["a", "b", "c"]);
        let starts: Vec<&str> = find_start_nodes(&wf).iter().map(|n| n.id.as_str()).collect();
        assert_eq!(starts, vec!["a"]);
    }

    #[test]
    fn outgoing_edges_filter_by_handle() {
        let wf = wf_with_edges(
            vec![("a", "yes_target", Some("yes")), ("a", "no_target", Some("no"))],
            &["a", "yes_target", "no_target"],
        );
        let yes = outgoing_edges(&wf, "a", Some("yes"));
        assert_eq!(yes.len(), 1);
        assert_eq!(yes[0].target, "yes_target");
        assert_eq!(outgoing_edges(&wf, "a", None).len(), 2);
    }

    #[test]
    fn edge_handle_falls_back_to_label() {
        let edge = WorkflowEdge {
            id: "e".into(),
            source: "a".into(),
            target: "b".into(),
            source_handle: None,
            label: Some("yes".into()),
        };
        assert_eq!(edge.handle(), Some("yes"));
    }

    #[test]
    fn terminal_node_prefers_a_leaf() {
        let wf = wf_with_edges(vec![("a", "b", None)], &["a", "b"]);
        let mut states = HashMap::new();
        for (id, finished, output) in [("a", 100, "first"), ("b", 200, "last")] {
            states.insert(
                id.to_string(),
                WorkflowNodeRunState {
                    node_id: id.into(),
                    status: WorkflowNodeStatus::Done,
                    output: Some(output.into()),
                    error: None,
                    started_at: None,
                    finished_at: Some(finished),
                    iteration: None,
                    tokens: None,
                },
            );
        }
        assert_eq!(
            find_terminal_node(&wf, &states).unwrap().output.unwrap(),
            "last"
        );
    }

    #[test]
    fn first_error_surfaces_the_earliest_failure() {
        assert!(first_error(vec![Ok(()), Ok(())]).is_ok());
        assert_eq!(
            first_error(vec![Ok(()), Err("boom".into()), Err("later".into())]).unwrap_err(),
            "boom"
        );
    }
}
