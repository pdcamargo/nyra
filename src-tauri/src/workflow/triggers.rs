//! Automatic workflow triggers: cron schedules, file watchers, and webhooks.
//!
//! Watchers are pooled by (cwd, paths) so N triggers on the same paths share one
//! OS watch; each trigger then gets its own debounced listener fanned out from it.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use super::engine::execute_workflow;
use super::store;
use super::types::{TriggerSource, WorkflowDefinition, WorkflowTrigger};
use crate::util;

const MAX_FILE_WATCHERS: usize = 24;
const DEFAULT_DEBOUNCE_MS: u64 = 1000;

static READY: AtomicBool = AtomicBool::new(false);
static CRON_TASKS: Lazy<Mutex<Vec<tauri::async_runtime::JoinHandle<()>>>> =
    Lazy::new(|| Mutex::new(Vec::new()));
static WATCHER_POOL: Lazy<Mutex<HashMap<String, WatcherEntry>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static WEBHOOKS: Lazy<Mutex<HashMap<String, WebhookRegistration>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

#[derive(Clone)]
struct ListenerSpec {
    workflow_id: String,
    trigger: Arc<WorkflowTrigger>,
    patterns: Vec<glob::Pattern>,
    events: Vec<String>,
    debounce_ms: u64,
    /// Bumped on every matching change; the debounce task only fires if it is
    /// still the latest when it wakes.
    generation: Arc<AtomicU64>,
}

struct WatcherEntry {
    _watcher: RecommendedWatcher,
    listeners: Arc<Mutex<HashMap<String, ListenerSpec>>>,
}

#[derive(Clone)]
struct WebhookRegistration {
    workflow_id: String,
    token: String,
    cwd: String,
    input_values: HashMap<String, String>,
}

fn fire_trigger(
    workflow_id: &str,
    trigger: &WorkflowTrigger,
    source: TriggerSource,
    extra_inputs: Option<HashMap<String, String>>,
) {
    if !READY.load(Ordering::SeqCst) {
        return;
    }
    let cwd = trigger.cwd().to_string();
    let mut inputs = trigger.input_values();
    if let Some(extra) = extra_inputs {
        inputs.extend(extra);
    }
    crate::log!(
        "workflow-triggers",
        "Firing {source:?} trigger for workflow={workflow_id} cwd={cwd}"
    );

    let workflow_id = workflow_id.to_string();
    tauri::async_runtime::spawn(async move {
        let settings = util::settings();
        if let Err(e) =
            execute_workflow(&workflow_id, &cwd, settings, Some(inputs), Some(source)).await
        {
            crate::log!("workflow-triggers", "Trigger execution failed: {e}");
        }
    });
}

// ---- cron ----

fn register_cron(wf: &WorkflowDefinition, trigger: &WorkflowTrigger) {
    let WorkflowTrigger::Cron { schedule, cwd, .. } = trigger else {
        return;
    };
    if cwd.is_empty() {
        crate::log!(
            "workflow-triggers",
            "Cron trigger for {}/{} missing cwd; skipping",
            wf.name,
            trigger.id()
        );
        return;
    }

    let cron: croner::Cron = match schedule.parse() {
        Ok(c) => c,
        Err(e) => {
            crate::log!(
                "workflow-triggers",
                "Invalid cron schedule \"{schedule}\" for {}/{}: {e}",
                wf.name,
                trigger.id()
            );
            return;
        }
    };

    let workflow_id = wf.id.clone();
    let trigger = trigger.clone();
    let schedule_label = schedule.clone();
    let name = wf.name.clone();

    let handle = tauri::async_runtime::spawn(async move {
        loop {
            let now = chrono::Local::now();
            let Ok(next) = cron.find_next_occurrence(&now, false) else {
                crate::log!(
                    "workflow-triggers",
                    "Cron \"{schedule_label}\" has no further occurrences; stopping"
                );
                return;
            };
            let wait = (next - now).to_std().unwrap_or_default();
            tokio::time::sleep(wait).await;
            fire_trigger(&workflow_id, &trigger, TriggerSource::Cron, None);
            // Guard against a zero-length sleep spinning when the next occurrence
            // lands inside the same second we just fired in.
            tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        }
    });

    CRON_TASKS.lock().push(handle);
    crate::log!(
        "workflow-triggers",
        "Registered cron \"{schedule}\" for {name}"
    );
}

// ---- file watcher ----

/// The longest literal prefix of a glob — the deepest directory we can watch
/// without missing matches.
fn glob_base(cwd: &Path, pattern: &str) -> PathBuf {
    let mut base = cwd.to_path_buf();
    for segment in pattern.split('/') {
        if segment.contains(['*', '?', '[', '{']) {
            break;
        }
        if segment.is_empty() || segment == "." {
            continue;
        }
        base.push(segment);
    }
    // A pattern whose literal prefix is a file (no wildcards at all) still needs
    // its parent directory watched.
    if base.is_file() {
        base.parent().map(Path::to_path_buf).unwrap_or(base)
    } else {
        base
    }
}

fn register_file_watcher(wf: &WorkflowDefinition, trigger: &WorkflowTrigger) {
    let WorkflowTrigger::FileWatcher {
        paths,
        cwd,
        events,
        debounce_ms,
        ..
    } = trigger
    else {
        return;
    };
    if paths.is_empty() {
        return;
    }
    if cwd.is_empty() {
        crate::log!(
            "workflow-triggers",
            "File watcher for {}/{} missing cwd; skipping",
            wf.name,
            trigger.id()
        );
        return;
    }

    let mut sorted = paths.clone();
    sorted.sort();
    let key = serde_json::json!([cwd, sorted]).to_string();
    let listener_key = format!("{}:{}", wf.id, trigger.id());

    let mut pool = WATCHER_POOL.lock();
    if !pool.contains_key(&key) {
        if pool.len() >= MAX_FILE_WATCHERS {
            crate::log!(
                "workflow-triggers",
                "File-watcher cap ({MAX_FILE_WATCHERS}) reached; skipping {}/{} on {}",
                wf.name,
                trigger.id(),
                paths.join(", ")
            );
            return;
        }

        let listeners: Arc<Mutex<HashMap<String, ListenerSpec>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let cwd_path = PathBuf::from(cwd);
        let dispatch_listeners = listeners.clone();
        let dispatch_cwd = cwd_path.clone();

        let mut watcher = match notify::recommended_watcher(
            move |res: notify::Result<notify::Event>| {
                let Ok(event) = res else { return };
                let kind = match event.kind {
                    notify::EventKind::Create(_) => "add",
                    notify::EventKind::Modify(_) => "change",
                    notify::EventKind::Remove(_) => "unlink",
                    _ => return,
                };
                for path in &event.paths {
                    let relative = path
                        .strip_prefix(&dispatch_cwd)
                        .unwrap_or(path)
                        .to_string_lossy()
                        .to_string();
                    dispatch(&dispatch_listeners, kind, &relative);
                }
            },
        ) {
            Ok(w) => w,
            Err(e) => {
                crate::log!("workflow-triggers", "Failed to create watcher for {key}: {e}");
                return;
            }
        };

        let mut watched_any = false;
        let mut bases: Vec<PathBuf> = paths.iter().map(|p| glob_base(&cwd_path, p)).collect();
        bases.sort();
        bases.dedup();
        for base in bases {
            match watcher.watch(&base, RecursiveMode::Recursive) {
                Ok(()) => watched_any = true,
                Err(e) => crate::log!(
                    "workflow-triggers",
                    "Watcher error on {}: {e}",
                    base.display()
                ),
            }
        }
        if !watched_any {
            return;
        }

        pool.insert(
            key.clone(),
            WatcherEntry {
                _watcher: watcher,
                listeners,
            },
        );
    }

    let entry = pool.get(&key).expect("entry inserted above");
    let patterns: Vec<glob::Pattern> = paths
        .iter()
        .filter_map(|p| glob::Pattern::new(p).ok())
        .collect();

    entry.listeners.lock().insert(
        listener_key,
        ListenerSpec {
            workflow_id: wf.id.clone(),
            trigger: Arc::new(trigger.clone()),
            patterns,
            events: events.clone().unwrap_or_else(|| vec!["change".into()]),
            debounce_ms: debounce_ms.unwrap_or(DEFAULT_DEBOUNCE_MS),
            generation: Arc::new(AtomicU64::new(0)),
        },
    );

    crate::log!(
        "workflow-triggers",
        "Registered file watcher for {} on {} ({} trigger(s) sharing this watcher)",
        wf.name,
        paths.join(", "),
        entry.listeners.lock().len()
    );
}

fn dispatch(
    listeners: &Arc<Mutex<HashMap<String, ListenerSpec>>>,
    kind: &str,
    relative_path: &str,
) {
    let matching: Vec<ListenerSpec> = listeners
        .lock()
        .values()
        .filter(|spec| spec.events.iter().any(|e| e == kind))
        .filter(|spec| spec.patterns.iter().any(|p| p.matches(relative_path)))
        .cloned()
        .collect();

    for spec in matching {
        let generation = spec.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let kind = kind.to_string();
        let path = relative_path.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(spec.debounce_ms)).await;
            // A newer change landed while we slept — let that one fire instead.
            if spec.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            let extra = HashMap::from([
                ("trigger_event".to_string(), kind),
                ("trigger_path".to_string(), path),
            ]);
            fire_trigger(
                &spec.workflow_id,
                &spec.trigger,
                TriggerSource::FileWatcher,
                Some(extra),
            );
        });
    }
}

// ---- webhook ----

fn register_webhook(wf: &WorkflowDefinition, trigger: &WorkflowTrigger) {
    let WorkflowTrigger::Webhook { token, cwd, .. } = trigger else {
        return;
    };
    WEBHOOKS.lock().insert(
        format!("{}:{}", wf.id, trigger.id()),
        WebhookRegistration {
            workflow_id: wf.id.clone(),
            token: token.clone(),
            cwd: cwd.clone(),
            input_values: trigger.input_values(),
        },
    );
    crate::log!("workflow-triggers", "Registered webhook for {}", wf.name);
}

pub fn fire_webhook(
    workflow_id: &str,
    trigger_id: &str,
    token: &str,
    body_inputs: HashMap<String, String>,
) -> Result<(), String> {
    let reg = WEBHOOKS
        .lock()
        .get(&format!("{workflow_id}:{trigger_id}"))
        .cloned()
        .ok_or_else(|| "Webhook trigger not found".to_string())?;
    if reg.token != token {
        return Err("Invalid token".into());
    }
    if !READY.load(Ordering::SeqCst) {
        return Err("Runtime not ready".into());
    }

    let mut inputs = reg.input_values.clone();
    inputs.extend(body_inputs);
    crate::log!(
        "workflow-triggers",
        "Firing webhook trigger for workflow={workflow_id}"
    );

    let workflow_id = reg.workflow_id.clone();
    let cwd = reg.cwd.clone();
    tauri::async_runtime::spawn(async move {
        let settings = util::settings();
        if let Err(e) = execute_workflow(
            &workflow_id,
            &cwd,
            settings,
            Some(inputs),
            Some(TriggerSource::Webhook),
        )
        .await
        {
            crate::log!("workflow-triggers", "Webhook execution failed: {e}");
        }
    });
    Ok(())
}

// ---- lifecycle ----

fn clear_all() {
    for handle in CRON_TASKS.lock().drain(..) {
        handle.abort();
    }
    WATCHER_POOL.lock().clear(); // dropping the watchers unregisters them
    WEBHOOKS.lock().clear();
}

pub async fn refresh_triggers() {
    if !READY.load(Ordering::SeqCst) {
        return;
    }
    clear_all();

    for raw in store::list_workflows().await {
        let Ok(wf) = serde_json::from_value::<WorkflowDefinition>(raw) else {
            continue;
        };
        let Some(triggers) = wf.triggers.clone() else {
            continue;
        };
        for trigger in triggers.iter().filter(|t| t.enabled()) {
            match trigger {
                WorkflowTrigger::Cron { .. } => register_cron(&wf, trigger),
                WorkflowTrigger::FileWatcher { .. } => register_file_watcher(&wf, trigger),
                WorkflowTrigger::Webhook { .. } => register_webhook(&wf, trigger),
            }
        }
    }

    let watcher_triggers: usize = WATCHER_POOL
        .lock()
        .values()
        .map(|e| e.listeners.lock().len())
        .sum();
    crate::log!(
        "workflow-triggers",
        "Active triggers: {} cron, {watcher_triggers} file-watcher trigger(s) across {} pooled watcher(s), {} webhooks",
        CRON_TASKS.lock().len(),
        WATCHER_POOL.lock().len(),
        WEBHOOKS.lock().len()
    );
}

pub async fn start_trigger_runtime() {
    READY.store(true, Ordering::SeqCst);
    refresh_triggers().await;
}

pub fn stop_trigger_runtime() {
    clear_all();
    READY.store(false, Ordering::SeqCst);
}

pub async fn test_trigger(workflow_id: &str, trigger_id: &str) -> Result<(), String> {
    let wf = store::load_workflow_typed(workflow_id)
        .await
        .ok_or_else(|| "Workflow not found".to_string())?;
    let trigger = wf
        .triggers
        .unwrap_or_default()
        .into_iter()
        .find(|t| t.id() == trigger_id)
        .ok_or_else(|| "Trigger not found".to_string())?;
    fire_trigger(workflow_id, &trigger, trigger.source(), None);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_base_stops_at_the_first_wildcard() {
        let cwd = Path::new("/proj");
        assert_eq!(glob_base(cwd, "src/**/*.ts"), PathBuf::from("/proj/src"));
        assert_eq!(glob_base(cwd, "*.md"), PathBuf::from("/proj"));
        assert_eq!(glob_base(cwd, "a/b/c"), PathBuf::from("/proj/a/b/c"));
    }

    #[test]
    fn glob_patterns_match_paths_relative_to_cwd() {
        let p = glob::Pattern::new("src/**/*.ts").unwrap();
        assert!(p.matches("src/main/index.ts"));
        assert!(!p.matches("docs/readme.md"));
    }

    #[test]
    fn five_field_cron_expressions_parse() {
        let cron: Result<croner::Cron, _> = "*/15 * * * *".parse();
        assert!(cron.is_ok());
        let bad: Result<croner::Cron, _> = "not a schedule".parse();
        assert!(bad.is_err());
    }
}
