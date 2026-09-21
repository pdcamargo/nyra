//! Pure helpers shared by the workflow engine — the Rust counterpart of
//! `src/shared/workflowHelpers.ts`, which the renderer still uses for its own
//! preview/validation. Both sides must agree, so the tests below mirror the
//! TypeScript suite case for case.

use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;

use super::types::*;

pub const MARKETPLACE_OWNER: &str = "pdcamargo";
pub const MARKETPLACE_REPO: &str = "nyra-flows-marketplace";
pub const MARKETPLACE_BRANCH: &str = "main";

pub fn marketplace_raw_base() -> String {
    format!("https://raw.githubusercontent.com/{MARKETPLACE_OWNER}/{MARKETPLACE_REPO}/{MARKETPLACE_BRANCH}")
}

pub fn marketplace_repo_url() -> String {
    format!("https://github.com/{MARKETPLACE_OWNER}/{MARKETPLACE_REPO}")
}

/// Expand `{{prev.output}}`, `{{input.key}}` and `{{vars.name}}`. Unknown keys
/// resolve to an empty string.
pub fn interpolate(
    template: &str,
    prev_output: &str,
    input_values: &HashMap<String, String>,
    vars: &HashMap<String, String>,
) -> String {
    static PREV: Lazy<Regex> = Lazy::new(|| Regex::new(r"\{\{prev\.output\}\}").unwrap());
    static INPUT: Lazy<Regex> = Lazy::new(|| Regex::new(r"\{\{input\.(\w+)\}\}").unwrap());
    static VARS: Lazy<Regex> = Lazy::new(|| Regex::new(r"\{\{vars\.(\w+)\}\}").unwrap());

    // Closures rather than replacement strings, so a `$1` inside a node's output
    // is inserted literally instead of being read as a capture reference.
    let out = PREV.replace_all(template, |_: &regex::Captures| prev_output.to_string());
    let out = INPUT.replace_all(&out, |c: &regex::Captures| {
        input_values.get(&c[1]).cloned().unwrap_or_default()
    });
    let out = VARS.replace_all(&out, |c: &regex::Captures| {
        vars.get(&c[1]).cloned().unwrap_or_default()
    });
    out.into_owned()
}

/// Resolve an extractor against a node's output.
///
/// ```text
/// ""                      → raw output
/// "json:path.to.field"    → parse, then walk the dotted path
/// "regex:pattern"         → first capture group, else the whole match
/// "lines:N" / "lines:N-M" → 1-indexed inclusive slice
/// ```
/// Anything malformed or unmatched yields an empty string.
pub fn apply_extractor(extractor: &str, output: &str) -> String {
    let ext = extractor.trim();
    if ext.is_empty() {
        return output.to_string();
    }

    if let Some(path) = ext.strip_prefix("json:") {
        let Ok(parsed) = serde_json::from_str::<Value>(output) else {
            return String::new();
        };
        let mut cur = &parsed;
        for part in path.trim().split('.').filter(|p| !p.is_empty()) {
            match cur.get(part) {
                Some(next) => cur = next,
                None => return String::new(),
            }
        }
        return match cur {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        };
    }

    if let Some(pattern) = ext.strip_prefix("regex:") {
        // fancy-regex, not regex: these patterns are user-authored and often
        // lean on JS features like lookaround.
        let Ok(re) = fancy_regex::Regex::new(pattern) else {
            return String::new();
        };
        return match re.captures(output) {
            Ok(Some(caps)) => caps
                .get(1)
                .or_else(|| caps.get(0))
                .map(|m| m.as_str().to_string())
                .unwrap_or_default(),
            _ => String::new(),
        };
    }

    if let Some(range) = ext.strip_prefix("lines:") {
        let range = range.trim();
        let lines: Vec<&str> = range_split_lines(output);
        let (start_str, end_str) = match range.split_once('-') {
            Some((a, b)) => (a, Some(b)),
            None => (range, None),
        };
        let start = start_str.trim().parse::<usize>().unwrap_or(1).max(1);
        let end = match end_str {
            Some(e) => e.trim().parse::<usize>().unwrap_or(start).max(start),
            None => start,
        };
        let lo = (start - 1).min(lines.len());
        let hi = end.min(lines.len());
        return lines[lo..hi].join("\n");
    }

    output.to_string()
}

fn range_split_lines(s: &str) -> Vec<&str> {
    // Matches JS `split(/\r?\n/)`.
    s.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect()
}

/// Evaluate a condition expression with `output`, `vars` and `iteration` in
/// scope. Never throws — a bad expression is simply false, matching the
/// `new Function(...)` + try/catch the TypeScript engine used.
pub fn evaluate_condition(
    expression: &str,
    output: &str,
    vars: &HashMap<String, String>,
    iteration: i64,
) -> bool {
    use boa_engine::{Context, Source};

    let output_json = serde_json::to_string(output).unwrap_or_else(|_| "\"\"".into());
    let vars_json = serde_json::to_string(vars).unwrap_or_else(|_| "{}".into());
    // An IIFE gives the expression exactly the three bindings the TS version had,
    // without leaking them into a shared global scope between evaluations.
    let script = format!(
        "(function(output, vars, iteration) {{ return Boolean({expression}); }})({output_json}, {vars_json}, {iteration})"
    );

    let mut ctx = Context::default();
    match ctx.eval(Source::from_bytes(&script)) {
        Ok(value) => value.as_boolean().unwrap_or(false),
        Err(_) => false,
    }
}

/// Fold execution records into the summary the metrics panel renders.
pub fn aggregate_workflow_metrics(
    wf: &WorkflowDefinition,
    records: &[WorkflowExecutionRecord],
) -> WorkflowMetrics {
    let node_labels: HashMap<&str, &str> = wf
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), n.label.as_str()))
        .collect();

    let mut total_runs = 0i64;
    let mut success_runs = 0i64;
    let mut failed_runs = 0i64;
    let mut aborted_runs = 0i64;
    let mut total_duration = 0i64;
    let mut duration_count = 0i64;
    let mut total_tokens = WorkflowTokenUsage::default();
    let mut failure_counts: HashMap<String, i64> = HashMap::new();
    let mut last_run_at: Option<i64> = None;
    let mut last_status: Option<ExecutionStatus> = None;

    for rec in records {
        total_runs += 1;
        match rec.status {
            ExecutionStatus::Done => success_runs += 1,
            ExecutionStatus::Failed => failed_runs += 1,
            ExecutionStatus::Aborted => aborted_runs += 1,
        }

        total_duration += rec.finished_at - rec.started_at;
        duration_count += 1;

        if let Some(t) = rec.tokens {
            total_tokens = total_tokens + t;
        }

        if last_run_at.is_none_or(|prev| rec.started_at > prev) {
            last_run_at = Some(rec.started_at);
            last_status = Some(rec.status);
        }

        for ns in rec.node_states.values() {
            if ns.status == WorkflowNodeStatus::Failed {
                *failure_counts.entry(ns.node_id.clone()).or_insert(0) += 1;
            }
        }
    }

    let mut ranked: Vec<(String, i64)> = failure_counts.into_iter().collect();
    ranked.sort_by_key(|(_, failures)| std::cmp::Reverse(*failures));
    ranked.truncate(5);

    WorkflowMetrics {
        workflow_id: wf.id.clone(),
        workflow_name: wf.name.clone(),
        total_runs,
        success_runs,
        failed_runs,
        aborted_runs,
        avg_duration_ms: if duration_count == 0 {
            0
        } else {
            (total_duration as f64 / duration_count as f64).round() as i64
        },
        total_tokens,
        last_run_at,
        last_status,
        top_failing_nodes: ranked
            .into_iter()
            .map(|(node_id, failures)| TopFailingNode {
                node_label: node_labels
                    .get(node_id.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| node_id.clone()),
                node_id,
                failures,
            })
            .collect(),
    }
}

/// Prefilled "new issue" URL for submitting a workflow to the marketplace.
/// Runtime-only fields are stripped so the embedded JSON is a clean template.
pub fn build_marketplace_share_url(workflow: &Value) -> String {
    let mut cleaned = workflow.clone();
    if let Value::Object(map) = &mut cleaned {
        map.insert("isTemplate".into(), Value::Bool(true));
        map.insert("createdAt".into(), Value::from(0));
        map.insert("updatedAt".into(), Value::from(0));
        map.remove("recentCwds");
        map.remove("marketplaceId");
        map.remove("marketplaceVersion");
    }
    let name = workflow
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default();

    let body = [
        "<!-- Submit a workflow to nyra-flows-marketplace -->".to_string(),
        String::new(),
        format!("**Suggested name:** {name}"),
        "**Description:** _add a one-liner_".to_string(),
        "**Tags:** _comma-separated_".to_string(),
        String::new(),
        "## Workflow JSON".to_string(),
        String::new(),
        "```json".to_string(),
        serde_json::to_string_pretty(&cleaned).unwrap_or_default(),
        "```".to_string(),
    ]
    .join("\n");

    let title = format!(
        "Submit workflow: {}",
        if name.is_empty() { "untitled" } else { name }
    );
    format!(
        "{}/issues/new?title={}&body={}",
        marketplace_repo_url(),
        form_urlencode(&title),
        form_urlencode(&body)
    )
}

/// `application/x-www-form-urlencoded`, matching `URLSearchParams.toString()`.
fn form_urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'*' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The shapes the expression field warns about, proved against the engine.
    ///
    /// The canvas tells people a trailing `//` comment makes a condition always
    /// false, and that a statement cannot go where an expression must. Those are
    /// claims about *this* function, so they are asserted here rather than left
    /// as reasoning in a lint module on the other side of the bridge.
    #[test]
    fn expression_shapes_the_editor_warns_about() {
        let no_vars = HashMap::new();

        // Baseline: the same expression without the comment is true.
        assert!(evaluate_condition("true", "", &no_vars, 1));

        // The wrapper is built on one line, so a line comment eats the `); }})`
        // that follows it.
        assert!(
            !evaluate_condition("true // looks fine", "", &no_vars, 1),
            "a trailing line comment must swallow the rest of the line"
        );

        // A block comment does not, which is what the warning tells people to use.
        assert!(evaluate_condition("true /* fine */", "", &no_vars, 1));

        // Statement forms land inside Boolean(...) and fail to parse.
        assert!(!evaluate_condition("return true", "", &no_vars, 1));
        assert!(!evaluate_condition("const ok = true", "", &no_vars, 1));
        assert!(!evaluate_condition("true;", "", &no_vars, 1));

        // A leading comment is genuinely fine, which is why the editor stopped
        // flagging it.
        assert!(evaluate_condition("// why\ntrue", "", &no_vars, 1));

        // And an empty expression is Boolean() — false, not an error.
        assert!(!evaluate_condition("", "", &no_vars, 1));
    }

    fn map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn substitutes_all_three_placeholder_kinds() {
        let out = interpolate(
            "prev={{prev.output}} in={{input.company}} var={{vars.count}}",
            "OUT",
            &map(&[("company", "Acme")]),
            &map(&[("count", "3")]),
        );
        assert_eq!(out, "prev=OUT in=Acme var=3");
    }

    #[test]
    fn returns_the_template_unchanged_without_placeholders() {
        assert_eq!(interpolate("plain text", "OUT", &map(&[]), &map(&[])), "plain text");
    }

    #[test]
    fn replaces_every_occurrence_not_just_the_first() {
        let out = interpolate("{{prev.output}}-{{prev.output}}", "x", &map(&[]), &map(&[]));
        assert_eq!(out, "x-x");
    }

    #[test]
    fn leaves_malformed_placeholders_alone() {
        let out = interpolate("{{prev.outputs}} {{ input.a }} {{vars.}}", "X", &map(&[("a", "A")]), &map(&[]));
        assert_eq!(out, "{{prev.outputs}} {{ input.a }} {{vars.}}");
    }

    #[test]
    fn unknown_extractor_prefixes_fall_through_to_raw_output() {
        assert_eq!(apply_extractor("nonsense:whatever", "hello"), "hello");
    }

    #[test]
    fn lines_extractor_normalises_crlf() {
        assert_eq!(apply_extractor("lines:2", "a\r\nb\r\nc"), "b");
    }

    #[test]
    fn resolves_unknown_keys_to_empty() {
        let out = interpolate("[{{input.nope}}][{{vars.nope}}]", "", &map(&[]), &map(&[]));
        assert_eq!(out, "[][]");
    }

    #[test]
    fn inserts_dollar_sequences_literally() {
        let out = interpolate("{{prev.output}}", "$1 and $&", &map(&[]), &map(&[]));
        assert_eq!(out, "$1 and $&");
    }

    #[test]
    fn empty_extractor_returns_raw_output() {
        assert_eq!(apply_extractor("", "hello"), "hello");
        assert_eq!(apply_extractor("   ", "hello"), "hello");
    }

    #[test]
    fn json_extractor_walks_a_dotted_path() {
        let json = r#"{"a":{"b":{"c":"deep"}}}"#;
        assert_eq!(apply_extractor("json:a.b.c", json), "deep");
        assert_eq!(apply_extractor("json:a.b", json), r#"{"c":"deep"}"#);
        assert_eq!(apply_extractor("json:a.missing", json), "");
        assert_eq!(apply_extractor("json:a", "not json"), "");
    }

    #[test]
    fn regex_extractor_prefers_the_first_group() {
        assert_eq!(apply_extractor(r"regex:v(\d+)", "version v42 here"), "42");
        assert_eq!(apply_extractor(r"regex:\d+", "version v42"), "42");
        assert_eq!(apply_extractor(r"regex:zzz", "nope"), "");
        assert_eq!(apply_extractor("regex:[unclosed", "x"), "");
    }

    #[test]
    fn lines_extractor_is_one_indexed_and_inclusive() {
        let text = "a\nb\nc\nd\ne";
        assert_eq!(apply_extractor("lines:2", text), "b");
        assert_eq!(apply_extractor("lines:2-4", text), "b\nc\nd");
        assert_eq!(apply_extractor("lines:4-99", text), "d\ne");
        assert_eq!(apply_extractor("lines:99", text), "");
    }

    #[test]
    fn evaluates_truthy_expressions() {
        assert!(evaluate_condition("output.includes('bug')", "has a bug", &map(&[]), 1));
        assert!(!evaluate_condition("output.includes('bug')", "all clean", &map(&[]), 1));
    }

    #[test]
    fn exposes_vars_and_iteration() {
        assert!(evaluate_condition("vars.status === 'ok'", "", &map(&[("status", "ok")]), 1));
        assert!(evaluate_condition("iteration < 3", "", &map(&[]), 2));
        assert!(!evaluate_condition("iteration < 3", "", &map(&[]), 3));
    }

    #[test]
    fn returns_false_instead_of_throwing() {
        assert!(!evaluate_condition("this is not valid js !!!", "", &map(&[]), 1));
        assert!(!evaluate_condition("missingGlobal.foo", "", &map(&[]), 1));
        assert!(!evaluate_condition("", "", &map(&[]), 1));
    }

    #[test]
    fn quotes_in_output_cannot_break_out_of_the_expression() {
        // A naive string-concat eval would let this terminate the literal early.
        let hostile = "\"; throw new Error('pwned'); //";
        assert!(evaluate_condition("output.length > 0", hostile, &map(&[]), 1));
    }

    #[test]
    fn aggregates_runs_and_failures() {
        let wf = WorkflowDefinition {
            id: "wf1".into(),
            name: "Test".into(),
            description: None,
            inputs: None,
            nodes: vec![WorkflowNode {
                id: "n1".into(),
                label: "First".into(),
                position: Position::default(),
                data: WorkflowNodeData::Script { command: "true".into(), timeout_ms: None },
            }],
            edges: vec![],
            created_at: 0,
            updated_at: 0,
            is_template: None,
            recent_cwds: None,
            triggers: None,
            marketplace_id: None,
            marketplace_version: None,
        };
        let rec = |id: &str, status, started: i64, finished: i64, failed_node: Option<&str>| {
            let mut node_states = HashMap::new();
            if let Some(n) = failed_node {
                node_states.insert(
                    n.to_string(),
                    WorkflowNodeRunState {
                        node_id: n.to_string(),
                        status: WorkflowNodeStatus::Failed,
                        output: None,
                        error: None,
                        started_at: None,
                        finished_at: None,
                        iteration: None,
                        tokens: None,
                    },
                );
            }
            WorkflowExecutionRecord {
                id: id.into(),
                workflow_id: "wf1".into(),
                workflow_name: "Test".into(),
                status,
                started_at: started,
                finished_at: finished,
                input_values: HashMap::new(),
                final_vars: HashMap::new(),
                node_states,
                error: None,
                cwd: None,
                tokens: Some(WorkflowTokenUsage { input: 10, output: 5, cache_read: 1, cache_creation: 2 }),
                triggered_by: None,
            }
        };

        let records = vec![
            rec("e1", ExecutionStatus::Done, 0, 1000, None),
            rec("e2", ExecutionStatus::Failed, 2000, 4000, Some("n1")),
            rec("e3", ExecutionStatus::Aborted, 1000, 1500, None),
        ];
        let m = aggregate_workflow_metrics(&wf, &records);

        assert_eq!(m.total_runs, 3);
        assert_eq!(m.success_runs, 1);
        assert_eq!(m.failed_runs, 1);
        assert_eq!(m.aborted_runs, 1);
        assert_eq!(m.avg_duration_ms, 1167); // (1000 + 2000 + 500) / 3
        assert_eq!(m.total_tokens.input, 30);
        assert_eq!(m.last_run_at, Some(2000));
        assert_eq!(m.last_status, Some(ExecutionStatus::Failed));
        assert_eq!(m.top_failing_nodes.len(), 1);
        assert_eq!(m.top_failing_nodes[0].node_label, "First");
    }

    #[test]
    fn metrics_are_zero_for_an_empty_history() {
        let wf = WorkflowDefinition {
            id: "wf1".into(), name: "Test".into(), description: None, inputs: None,
            nodes: vec![], edges: vec![], created_at: 0, updated_at: 0, is_template: None,
            recent_cwds: None, triggers: None, marketplace_id: None, marketplace_version: None,
        };
        let m = aggregate_workflow_metrics(&wf, &[]);
        assert_eq!(m.total_runs, 0);
        assert_eq!(m.avg_duration_ms, 0);
        assert_eq!(m.total_tokens, WorkflowTokenUsage::default());
        assert!(m.last_run_at.is_none());
        assert!(m.top_failing_nodes.is_empty());
    }

    #[test]
    fn failing_node_label_falls_back_to_its_id() {
        let wf = WorkflowDefinition {
            id: "wf1".into(), name: "Test".into(), description: None, inputs: None,
            nodes: vec![], edges: vec![], created_at: 0, updated_at: 0, is_template: None,
            recent_cwds: None, triggers: None, marketplace_id: None, marketplace_version: None,
        };
        let mut node_states = HashMap::new();
        node_states.insert("ghost".to_string(), WorkflowNodeRunState {
            node_id: "ghost".into(), status: WorkflowNodeStatus::Failed, output: None, error: None,
            started_at: None, finished_at: None, iteration: None, tokens: None,
        });
        let rec = WorkflowExecutionRecord {
            id: "e1".into(), workflow_id: "wf1".into(), workflow_name: "Test".into(),
            status: ExecutionStatus::Failed, started_at: 0, finished_at: 10,
            input_values: HashMap::new(), final_vars: HashMap::new(), node_states,
            error: None, cwd: None, tokens: None, triggered_by: None,
        };
        let m = aggregate_workflow_metrics(&wf, &[rec]);
        assert_eq!(m.top_failing_nodes[0].node_label, "ghost");
    }

    #[test]
    fn share_url_falls_back_to_untitled() {
        let url = build_marketplace_share_url(&serde_json::json!({ "id": "wf1", "name": "" }));
        assert!(url.contains("Submit+workflow%3A+untitled"));
    }

    #[test]
    fn share_url_embeds_the_json_with_reset_timestamps() {
        let wf = serde_json::json!({ "id": "wf1", "name": "Flow", "createdAt": 99, "updatedAt": 99 });
        let url = build_marketplace_share_url(&wf);
        // Percent-encoded `"createdAt": 0`
        assert!(url.contains("%22createdAt%22%3A+0"));
        assert!(url.contains("%22isTemplate%22%3A+true"));
    }

    #[test]
    fn share_url_strips_runtime_fields() {
        let wf = serde_json::json!({
            "id": "wf1",
            "name": "My Flow",
            "recentCwds": ["/tmp"],
            "marketplaceId": "x",
            "createdAt": 123,
        });
        let url = build_marketplace_share_url(&wf);
        assert!(url.starts_with("https://github.com/pdcamargo/nyra-flows-marketplace/issues/new?"));
        assert!(url.contains("Submit+workflow%3A+My+Flow"));
        assert!(!url.contains("recentCwds"));
        assert!(!url.contains("marketplaceId"));
    }
}
