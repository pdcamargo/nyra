//! What a chat can ask about a flow run, in words a model reads.
//!
//! `nyra_flow` used to stop at "Finished. Execution X": a run was something a
//! chat could set going and then know nothing about. A run is linked to the
//! chat that started it now, so these answer the questions that chat has —
//! where is it, what did that step say, how did last week's go — and let it
//! carry a paused step on once the user has said so.
//!
//! A live run is read from the engine; a finished one from its record on disk.

use serde_json::{json, Value};
use std::collections::HashMap;

use crate::workflow::engine::{self, ReviewAnswer};
use crate::workflow::store;
use crate::workflow::types::{WorkflowExecutionRecord, WorkflowNodeRunState, WorkflowNodeStatus};

/// How much of a step's output `status` shows. `output` gives the whole thing.
const PREVIEW: usize = 240;

/// One run, live or finished, in one shape.
pub struct RunView {
    pub id: String,
    pub name: String,
    pub status: String,
    pub chat_id: Option<String>,
    /// Steps in reading order: id, label, kind.
    pub steps: Vec<(String, String, String)>,
    pub states: HashMap<String, WorkflowNodeRunState>,
    pub vars: HashMap<String, String>,
    pub waits: Vec<Value>,
    pub error: Option<String>,
}

fn steps_of(value: &Value) -> Vec<(String, String, String)> {
    value
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| {
                    let field = |k: &str| s.get(k).and_then(Value::as_str).unwrap_or("").to_string();
                    (field("id"), field("label"), field("type"))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub async fn view(run_id: &str) -> Option<RunView> {
    if let Some(live) = engine::snapshot(run_id) {
        return Some(RunView {
            id: run_id.to_string(),
            name: live["workflowName"].as_str().unwrap_or("").to_string(),
            status: if live["waits"].as_array().is_some_and(|w| !w.is_empty()) {
                "paused".into()
            } else {
                live["status"].as_str().unwrap_or("running").to_string()
            },
            chat_id: live["chatId"].as_str().map(str::to_string),
            steps: steps_of(&live["steps"]),
            states: serde_json::from_value(live["nodeStates"].clone()).unwrap_or_default(),
            vars: serde_json::from_value(live["vars"].clone()).unwrap_or_default(),
            waits: live["waits"].as_array().cloned().unwrap_or_default(),
            error: None,
        });
    }
    let record = store::load_execution_record(run_id).await?;
    Some(from_record(record).await)
}

async fn from_record(record: WorkflowExecutionRecord) -> RunView {
    // The flow as it is now, for the order and names of its steps. A flow
    // deleted since still has its record; its steps are then whatever ran.
    let steps = match store::load_workflow_typed(&record.workflow_id).await {
        Some(wf) => steps_of(&json!(engine::ordered_steps(&wf))),
        None => record
            .node_states
            .keys()
            .map(|id| (id.clone(), id.clone(), String::new()))
            .collect(),
    };
    RunView {
        id: record.id,
        name: record.workflow_name,
        status: serde_json::to_value(record.status)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default(),
        chat_id: record.chat_id,
        steps,
        states: record.node_states,
        vars: record.final_vars,
        waits: Vec::new(),
        error: record.error,
    }
}

/// The run a chat most likely means when it names none: the one of its own
/// still going, else the last one it had.
pub async fn latest_for_chat(chat_id: &str) -> Option<String> {
    if let Some(live) = engine::runs_of_chat(chat_id).first() {
        return live["executionId"].as_str().map(str::to_string);
    }
    store::list_execution_records(None)
        .await
        .into_iter()
        .find(|r| r.chat_id.as_deref() == Some(chat_id))
        .map(|r| r.id)
}

fn clip_line(s: &str, n: usize) -> String {
    let flat = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= n {
        flat
    } else {
        format!("{}…", flat.chars().take(n).collect::<String>())
    }
}

fn mark(state: Option<&WorkflowNodeRunState>) -> &'static str {
    match state.map(|s| &s.status) {
        Some(WorkflowNodeStatus::Done) => "done",
        Some(WorkflowNodeStatus::Running) => "running",
        Some(WorkflowNodeStatus::Failed) => "failed",
        Some(WorkflowNodeStatus::Skipped) => "skipped",
        Some(WorkflowNodeStatus::AwaitingReview) => "waiting",
        _ => "not reached",
    }
}

/// The run as a model should read it.
pub fn describe(run: &RunView, this_chat: &str) -> String {
    let mut out = format!("{} — run {} ({})\n", run.name, run.id, run.status);
    if let Some(error) = &run.error {
        out.push_str(&format!("Error: {}\n", clip_line(error, 400)));
    }
    out.push_str("Steps:\n");
    for (id, label, kind) in &run.steps {
        let state = run.states.get(id);
        let mut line = format!("  - {label} ({kind}): {}", mark(state));
        if let Some(output) = state.and_then(|s| s.output.as_deref()).filter(|o| !o.is_empty()) {
            line.push_str(&format!(" — {}", clip_line(output, PREVIEW)));
        }
        if let Some(error) = state.and_then(|s| s.error.as_deref()) {
            line.push_str(&format!(" — {}", clip_line(error, PREVIEW)));
        }
        out.push_str(&line);
        out.push('\n');
    }
    if !run.vars.is_empty() {
        let mut vars: Vec<_> = run.vars.iter().collect();
        vars.sort();
        let list: Vec<String> = vars.iter().map(|(k, v)| format!("{k}={}", clip_line(v, 80))).collect();
        out.push_str(&format!("Variables: {}\n", list.join(", ")));
    }
    for wait in &run.waits {
        let label = wait["label"].as_str().unwrap_or("a step");
        let here = run.chat_id.as_deref() == Some(this_chat);
        match wait["kind"].as_str() {
            Some("chat") => out.push_str(&format!(
                "Paused at {label}, a chat step{}. When the user says to carry on, call action:\"continue\" with run and the step's final output.\n",
                if here { " in this chat" } else { " in another chat" }
            )),
            _ => out.push_str(&format!(
                "Paused at {label}, waiting for a review. Answer it with action:\"continue\" (approve:false to reject) only if the user asked you to.\n"
            )),
        }
    }
    out.push_str("A step's whole output: action:\"output\" with run and step.");
    out
}

/// One step's whole output, by label or id.
pub fn step_output(run: &RunView, step: &str) -> Result<String, String> {
    let needle = step.trim().to_lowercase();
    let found = run
        .steps
        .iter()
        .find(|(id, label, _)| id.to_lowercase() == needle || label.to_lowercase() == needle)
        .or_else(|| run.steps.iter().find(|(_, label, _)| label.to_lowercase().contains(&needle)));
    let Some((id, label, _)) = found else {
        let names: Vec<&str> = run.steps.iter().map(|(_, l, _)| l.as_str()).collect();
        return Err(format!("No step '{step}' in {}. Its steps: {}.", run.name, names.join(", ")));
    };
    let state = run.states.get(id);
    match state.and_then(|s| s.output.clone().or_else(|| s.error.clone())) {
        Some(text) if !text.is_empty() => Ok(format!("{label} ({}):\n\n{text}", mark(state))),
        _ => Ok(format!("{label} has no output yet ({}).", mark(state))),
    }
}

/// A flow's past runs, newest first.
pub async fn history(workflow_id: &str) -> String {
    let records = store::list_execution_records(Some(workflow_id)).await;
    if records.is_empty() {
        return "No runs of that flow yet.".into();
    }
    let rows: Vec<String> = records
        .iter()
        .take(12)
        .map(|r| {
            let status = serde_json::to_value(r.status)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default();
            let secs = (r.finished_at - r.started_at).max(0) / 1000;
            let inputs: Vec<String> = r.input_values.iter().map(|(k, v)| format!("{k}={}", clip_line(v, 40))).collect();
            format!(
                "  - {} · {status} · started {} · {secs}s{}",
                r.id,
                r.started_at,
                if inputs.is_empty() { String::new() } else { format!(" · {}", inputs.join(", ")) }
            )
        })
        .collect();
    format!(
        "{} run(s), newest first (started is epoch ms):\n{}\nRead one with action:\"status\" or action:\"output\" and its run id.",
        records.len(),
        rows.join("\n")
    )
}

/// Carry a paused step on: a chat step continues with `output`, a review is
/// approved or rejected. Picks the run's paused step itself — there is
/// normally one, and a model guessing node ids is how a wrong one gets answered.
pub fn continue_run(run_id: &str, output: Option<String>, approve: bool) -> Result<String, String> {
    let live = engine::snapshot(run_id).ok_or_else(|| format!("Run {run_id} is not running."))?;
    let waits = live["waits"].as_array().cloned().unwrap_or_default();
    let wait = waits
        .iter()
        .find(|w| w["kind"] == "chat")
        .or_else(|| waits.first())
        .ok_or_else(|| format!("Run {run_id} is not paused; nothing to continue."))?;
    let node_id = wait["nodeId"].as_str().unwrap_or("");
    let label = wait["label"].as_str().unwrap_or("the step");
    let is_chat = wait["kind"] == "chat";
    if is_chat && approve && output.as_deref().is_none_or(|o| o.trim().is_empty()) {
        return Err(format!(
            "{label} is a chat step: pass `output`, the final version the next step should get."
        ));
    }
    let answer = ReviewAnswer { approved: approve, output };
    if !engine::respond_to_review(run_id, node_id, answer) {
        return Err(format!("{label} could not be answered; it may have just been."));
    }
    Ok(match (is_chat, approve) {
        (true, true) => format!("Continued past {label}. The run carries on and this chat hears when it ends."),
        (true, false) => format!("Stopped the run at {label}."),
        (false, true) => format!("Approved {label}."),
        (false, false) => format!("Rejected {label}; the run stops there."),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(id: &str, status: WorkflowNodeStatus, output: Option<&str>) -> WorkflowNodeRunState {
        WorkflowNodeRunState {
            node_id: id.into(),
            status,
            output: output.map(str::to_string),
            error: None,
            started_at: None,
            finished_at: None,
            iteration: None,
            tokens: None,
        }
    }

    fn paused_run() -> RunView {
        let steps = vec![
            ("a".to_string(), "Collect sessions".to_string(), "script".to_string()),
            ("b".to_string(), "Draft retrospective".to_string(), "prompt".to_string()),
            ("c".to_string(), "Review with you".to_string(), "chat".to_string()),
            ("d".to_string(), "Save to vault".to_string(), "script".to_string()),
        ];
        let mut states = HashMap::new();
        states.insert("a".into(), state("a", WorkflowNodeStatus::Done, Some("14 sessions")));
        states.insert("b".into(), state("b", WorkflowNodeStatus::Done, Some("Wins: grid. Misses: latency.")));
        states.insert("c".into(), state("c", WorkflowNodeStatus::AwaitingReview, None));
        RunView {
            id: "exec-1".into(),
            name: "Retrospective".into(),
            status: "paused".into(),
            chat_id: Some("chat-1".into()),
            steps,
            states,
            vars: HashMap::from([("week".to_string(), "2026-W43".to_string())]),
            waits: vec![json!({ "kind": "chat", "nodeId": "c", "label": "Review with you" })],
            error: None,
        }
    }

    #[test]
    fn status_reads_as_steps_in_order_with_what_is_waiting() {
        let text = describe(&paused_run(), "chat-1");
        let at = |s: &str| text.find(s).unwrap_or_else(|| panic!("missing {s:?} in:\n{text}"));
        assert!(at("Collect sessions (script): done — 14 sessions") < at("Draft retrospective"));
        assert!(text.contains("Save to vault (script): not reached"));
        assert!(text.contains("week=2026-W43"));
        assert!(text.contains("a chat step in this chat"), "it says the pause is this chat's");
    }

    #[test]
    fn a_pause_in_another_chat_says_so() {
        assert!(describe(&paused_run(), "someone-else").contains("in another chat"));
    }

    #[test]
    fn a_step_is_found_by_label_id_or_part_of_a_label() {
        let run = paused_run();
        assert!(step_output(&run, "draft retrospective").unwrap().contains("Wins: grid"));
        assert!(step_output(&run, "b").unwrap().contains("Wins: grid"));
        assert!(step_output(&run, "collect").unwrap().contains("14 sessions"));
        assert!(step_output(&run, "Save to vault").unwrap().contains("no output yet"));
        let missing = step_output(&run, "deploy").unwrap_err();
        assert!(missing.contains("Collect sessions, Draft retrospective"), "{missing}");
    }

    #[test]
    fn continuing_a_run_that_is_not_live_says_so() {
        assert!(continue_run("exec-nowhere", Some("x".into()), true).unwrap_err().contains("not running"));
    }
}
