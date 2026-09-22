//! The Tauri command surface.
//!
//! Every handler here is the direct counterpart of an `ipcMain.handle(...)` in
//! the Electron build, and returns the same JSON shape — the renderer's
//! `window.api` shim maps one to one onto these names.

use crate::updates;
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::workflow::helpers::{build_marketplace_share_url, marketplace_repo_url};
use crate::workflow::types::{MarketplaceEntry, TriggerSource};
use crate::workflow::{engine, marketplace, store, triggers};
use crate::{
    browser, claude, devtools, dictation, file_extractor, file_tree, fs_ops, gh, git, hooks, login, mcp,
    memory, open_with, processes, skills, subagents,
};
use crate::{settings::NyraSettings, settings::SpawnSettings, terminal, util, webhook_server};

// ---- claude ----

#[tauri::command(rename_all = "camelCase")]
pub async fn claude_query(
    prompt: String,
    cwd: String,
    session_id: Option<String>,
    nyra_session_id: String,
    worktree_name: Option<String>,
    settings: Option<SpawnSettings>,
) -> Value {
    // The renderer owns this now, so a session in one project can run a different
    // model from one in another. Falling back to the global keeps every caller
    // that has no opinion — and any older renderer — working unchanged.
    let settings = settings.unwrap_or_else(|| util::settings().spawn());
    match claude::run_claude(
        prompt,
        cwd,
        session_id,
        nyra_session_id,
        settings,
        worktree_name,
    )
    .await
    {
        Ok(session_id) => json!({ "sessionId": session_id }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn claude_permission_response(approved: bool, nyra_session_id: Option<String>) {
    claude::respond_permission(approved, nyra_session_id).await;
}

#[tauri::command(rename_all = "camelCase")]
pub fn claude_abort(nyra_session_id: Option<String>) {
    claude::abort_claude(nyra_session_id.as_deref());
}

/// Steer the running turn. False when there was no turn to steer, so the caller
/// can leave the message in the queue rather than lose it.
#[tauri::command(rename_all = "camelCase")]
pub async fn claude_steer(prompt: String, nyra_session_id: String) -> bool {
    claude::steer_session(&nyra_session_id, &prompt).await
}

#[tauri::command(rename_all = "camelCase")]
pub fn claude_dispose(nyra_session_id: String) {
    claude::dispose_session(&nyra_session_id);
}

#[tauri::command(rename_all = "camelCase")]
pub async fn claude_check_binary(custom_path: Option<String>) -> Value {
    claude::check_binary(custom_path).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn claude_save_image(base64: String, media_type: String) -> Result<String, String> {
    fs_ops::save_image(&base64, &media_type).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn claude_save_temp_file(base64: String, name: String) -> Option<String> {
    fs_ops::save_temp_file(&base64, &name).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn claude_process_file(file_path: String) -> Value {
    match file_extractor::process_file(&file_path).await {
        Ok(result) => serde_json::to_value(result).unwrap_or_else(|e| json!({ "error": e.to_string() })),
        Err(e) => json!({ "error": e }),
    }
}

// ---- dialogs ----

async fn pick(app: &AppHandle, kind: PickKind) -> Value {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let mut builder = app.dialog().file().set_directory(util::home_dir());

    match kind {
        PickKind::Folder => {
            builder.pick_folder(move |p| {
                let _ = tx.send(p.map(|p| vec![p]));
            });
        }
        PickKind::Markdown => {
            builder = builder.add_filter("Markdown", &["md"]);
            builder.pick_file(move |p| {
                let _ = tx.send(p.map(|p| vec![p]));
            });
        }
        PickKind::Attachments => {
            // "All Files" first, because it is the default the dialog opens on
            // and there is no longer any such thing as an unsupported attachment
            // — a file with no text extractor travels as a path. The narrower
            // filters stay, as filters, for when you are hunting for a PDF.
            builder = builder
                .add_filter("All Files", &["*"])
                .add_filter("Documents and code", &ATTACHMENT_EXTENSIONS)
                .add_filter(
                    "Documents",
                    &["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "csv", "txt"],
                )
                .add_filter(
                    "Code",
                    &["py", "js", "ts", "jsx", "tsx", "rb", "go", "rs", "java", "c", "cpp", "css", "sql"],
                )
                .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"])
                .add_filter("Media", &["mp4", "mov", "m4v", "webm", "mp3", "m4a", "wav", "aac", "flac", "ogg"]);
            builder.pick_files(move |p| {
                let _ = tx.send(p);
            });
        }
    }

    let paths = rx.await.ok().flatten().unwrap_or_default();
    json!(paths
        .into_iter()
        .map(|p| p.to_string())
        .collect::<Vec<String>>())
}

enum PickKind {
    Folder,
    Markdown,
    Attachments,
}

const ATTACHMENT_EXTENSIONS: [&str; 44] = [
    "pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "csv", "txt", "md", "json", "yaml", "yml",
    "xml", "html", "htm", "log", "env", "toml", "ini", "cfg", "sh", "py", "js", "ts", "jsx", "tsx",
    "rb", "go", "rs", "java", "c", "cpp", "h", "hpp", "css", "scss", "sql", "png", "jpg", "jpeg",
    "gif", "webp", "svg",
];

#[tauri::command]
pub async fn dialog_pick_folder(app: AppHandle) -> Option<String> {
    pick(&app, PickKind::Folder)
        .await
        .as_array()
        .and_then(|a| a.first().cloned())
        .and_then(|v| v.as_str().map(str::to_string))
}

#[tauri::command]
pub async fn dialog_pick_file(app: AppHandle) -> Option<String> {
    pick(&app, PickKind::Markdown)
        .await
        .as_array()
        .and_then(|a| a.first().cloned())
        .and_then(|v| v.as_str().map(str::to_string))
}

#[tauri::command]
pub async fn dialog_pick_files(app: AppHandle) -> Option<Vec<String>> {
    let picked: Vec<String> = serde_json::from_value(pick(&app, PickKind::Attachments).await).ok()?;
    if picked.is_empty() {
        None
    } else {
        Some(picked)
    }
}

async fn save_dialog(app: &AppHandle, default_name: &str, filter: (&str, &[&str])) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(default_name)
        .add_filter(filter.0, filter.1)
        .save_file(move |p| {
            let _ = tx.send(p);
        });
    rx.await.ok().flatten().map(|p| p.to_string())
}

#[tauri::command(rename_all = "camelCase")]
pub async fn dialog_save_file(app: AppHandle, default_name: String, content: String) -> Value {
    let Some(path) = save_dialog(&app, &default_name, ("Markdown", &["md"])).await else {
        return json!({ "canceled": true });
    };
    match fs_ops::write_text_file(&path, &content).await {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    }
}

// ---- skills, agents, memory ----

#[tauri::command]
pub async fn agents_list(cwd: String) -> Value {
    json!(skills::list_agents(&cwd).await)
}

#[tauri::command]
pub async fn skills_list(cwd: String) -> Value {
    json!(skills::list_skills(&cwd).await)
}

/// The project's and the account's custom slash commands.
#[tauri::command]
pub async fn commands_list(cwd: String) -> Value {
    json!(skills::list_commands(&cwd).await)
}

#[tauri::command]
pub async fn skills_write(scope: String, name: String, content: String, cwd: String) -> Value {
    match skills::write_skill(&scope, &name, &content, &cwd).await {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn commands_delete(file_path: String) -> Value {
    match skills::delete_command(&file_path).await {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn skills_delete(file_path: String) -> Value {
    match skills::delete_skill(&file_path).await {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    }
}

/// Put Nyra's own skills back. The way out of a deletion or an edit, so neither
/// is permanent — destructive to a customised skill, so the UI confirms first.
#[tauri::command]
pub async fn skills_restore_bundled(name: String) -> Value {
    match crate::managed_skills::restore(&name).await {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    }
}

/// Which skills Nyra ships and whether it still updates each one, so a row can
/// distinguish "kept current" from "you edited this, updates stopped".
#[tauri::command]
pub async fn skills_bundled_names() -> Value {
    json!(crate::managed_skills::bundled_status().await)
}

#[tauri::command]
pub async fn memory_list(cwd: String) -> Value {
    json!(memory::list_memory_files(&cwd).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn memory_read(file_path: String, cwd: String) -> Value {
    match memory::read_memory_file(&file_path, &cwd).await {
        Ok(content) => json!({ "content": content }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn memory_write(file_path: String, content: String, cwd: String) -> Value {
    match memory::write_memory_file(&file_path, &content, &cwd).await {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn memory_delete(file_path: String, cwd: String) -> Value {
    match memory::delete_memory_file(&file_path, &cwd).await {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    }
}

// ---- settings, fs, system ----

#[tauri::command]
pub async fn settings_sync(settings: NyraSettings) {
    util::set_settings(settings);
}

#[tauri::command(rename_all = "camelCase")]
pub async fn fs_read_file(file_path: String) -> Value {
    fs_ops::read_file(&file_path).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn fs_read_image(file_path: String) -> Value {
    fs_ops::read_image(&file_path).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn fs_revert_file(file_path: String, original_content: Option<String>) -> Value {
    fs_ops::revert_file(&file_path, original_content).await
}

#[tauri::command]
pub async fn fs_list_files(cwd: String, query: String) -> Value {
    json!(fs_ops::list_files(&cwd, &query).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn fs_list_dir(dir_path: String) -> file_tree::DirListing {
    file_tree::list_dir(&dir_path).await
}

#[tauri::command]
pub async fn fs_list_project_files(cwd: String, limit: Option<usize>) -> file_tree::FileListResult {
    file_tree::list_files(&cwd, limit.unwrap_or(20_000)).await
}

#[tauri::command]
pub async fn fs_search_tree(cwd: String, query: String, limit: Option<usize>) -> file_tree::TreeSearchResult {
    file_tree::search_tree(&cwd, &query, limit.unwrap_or(200)).await
}

#[tauri::command]
pub fn fs_list_editors() -> Vec<open_with::EditorApp> {
    open_with::detect_editors()
}

/// `app_path` of None means the system default.
///
/// Sync, and guarded: `open_path` only checks the file exists when it is opening
/// with the default, so "Open with Zed" on a file that has been deleted would
/// otherwise launch Zed on nothing.
#[tauri::command(rename_all = "camelCase")]
pub fn fs_open_with(app: AppHandle, file_path: String, app_path: Option<String>) -> Value {
    if std::fs::metadata(&file_path).is_err() {
        return json!({ "error": "That file no longer exists." });
    }
    match app.opener().open_path(file_path, app_path) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "error": e.to_string() }),
    }
}

/// Show the file in Finder.
///
/// `reveal_item_in_dir` canonicalises first and so errors on a path that is
/// gone; falling back to the parent directory is more useful than an error
/// toast when a file was just deleted out from under the panel.
#[tauri::command(rename_all = "camelCase")]
pub fn fs_reveal(app: AppHandle, file_path: String) -> Value {
    if std::fs::metadata(&file_path).is_ok() {
        return match app.opener().reveal_item_in_dir(&file_path) {
            Ok(()) => json!({ "ok": true }),
            Err(e) => json!({ "error": e.to_string() }),
        };
    }
    match std::path::Path::new(&file_path).parent() {
        Some(parent) if parent.exists() => match app.opener().open_path(
            parent.to_string_lossy().to_string(),
            None::<String>,
        ) {
            Ok(()) => json!({ "ok": true }),
            Err(e) => json!({ "error": e.to_string() }),
        },
        _ => json!({ "error": "That file no longer exists." }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn fs_read_text_file(file_path: String) -> fs_ops::ReadTextOutcome {
    fs_ops::read_text_file(&file_path).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn fs_stat_file(file_path: String) -> fs_ops::FileStamp {
    fs_ops::stat_file(&file_path).await
}

#[tauri::command]
pub fn system_homedir() -> String {
    util::home_dir().to_string_lossy().to_string()
}

// ---- git ----

#[tauri::command]
pub async fn git_branch(cwd: String) -> String {
    git::branch(&cwd).await
}

#[tauri::command]
pub async fn git_checkout(cwd: String, branch: String, create: bool) -> serde_json::Value {
    git::checkout(&cwd, &branch, create).await
}

#[tauri::command]
pub async fn git_branch_list(cwd: String) -> Vec<String> {
    git::branch_list(&cwd).await
}

#[tauri::command]
pub async fn git_is_repo(cwd: String) -> bool {
    git::is_repo(&cwd).await
}

/// The main working tree of whatever repo `cwd` belongs to, or null.
///
/// Lets the renderer map a worktree session back to the project it belongs to
/// without string-substituting paths, which is the mistake `main_worktree_root`
/// was written to replace.
#[tauri::command]
pub async fn git_main_worktree_root(cwd: String) -> Option<String> {
    git::main_worktree_root(&cwd).await
}

#[tauri::command]
pub async fn git_worktree_create(cwd: String, branch: String) -> Value {
    git::worktree_create(&cwd, &branch).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn git_worktree_create_managed(
    cwd: String,
    branch: String,
    base_ref: Option<String>,
    seed: bool,
) -> Value {
    git::worktree_create_managed(&cwd, &branch, base_ref.as_deref(), seed).await
}

#[tauri::command]
pub async fn git_worktree_list(cwd: String) -> Vec<Value> {
    git::worktree_list(&cwd).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn git_diff_stat(cwd: String, base: Option<String>) -> Value {
    git::diff_stat(&cwd, base.as_deref()).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn git_diff_files(cwd: String, base: Option<String>) -> Value {
    git::diff_files(&cwd, base.as_deref()).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn git_diff_patch(
    cwd: String,
    base: Option<String>,
    path: String,
    untracked: bool,
    ignore_whitespace: bool,
) -> Value {
    git::diff_patch(&cwd, base.as_deref(), &path, untracked, ignore_whitespace).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn git_worktree_snapshot(
    worktree_path: String,
    branch: String,
    session_id: String,
) -> Value {
    git::worktree_snapshot(&worktree_path, &branch, &session_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn git_worktree_restore(cwd: String, session_id: String) -> Value {
    git::worktree_restore(&cwd, &session_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub fn git_snapshot_exists(session_id: String) -> bool {
    git::snapshot_exists(&session_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn git_snapshot_discard(session_id: String) {
    git::snapshot_discard(&session_id);
}

#[tauri::command]
pub async fn git_worktree_merge(cwd: String, branch: String) -> Value {
    git::worktree_merge(&cwd, &branch).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn git_worktree_remove(cwd: String, worktree_path: String) -> Value {
    git::worktree_remove(&cwd, &worktree_path).await
}

// ---- mcp, hooks ----

#[tauri::command]
pub async fn mcp_list(cwd: String) -> Value {
    json!(mcp::list(&cwd).await)
}

#[tauri::command]
pub async fn hooks_read(scope: String, cwd: String) -> Value {
    hooks::read(&scope, &cwd).await
}

#[tauri::command]
pub async fn hooks_write(scope: String, hooks: Value, cwd: String) -> Value {
    match hooks::write(&scope, hooks, &cwd).await {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    }
}

// ---- workflows ----

#[tauri::command]
pub async fn workflow_list() -> Vec<Value> {
    store::list_workflows().await
}

#[tauri::command]
pub async fn workflow_load(id: String) -> Option<Value> {
    store::load_workflow(&id).await
}

#[tauri::command]
pub async fn workflow_save(workflow: Value) -> Value {
    match store::save_workflow(workflow).await {
        Ok(_) => {
            triggers::refresh_triggers().await;
            json!({ "success": true })
        }
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command]
pub async fn workflow_delete(id: String) -> Value {
    match store::delete_workflow(&id).await {
        Ok(()) => {
            triggers::refresh_triggers().await;
            json!({ "success": true })
        }
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command]
pub fn workflow_templates() -> Vec<Value> {
    store::built_in_templates().to_vec()
}

#[tauri::command(rename_all = "camelCase")]
pub async fn workflow_run(
    workflow_id: String,
    cwd: String,
    input_values: Option<HashMap<String, String>>,
) -> Value {
    match engine::execute_workflow(
        &workflow_id,
        &cwd,
        util::settings(),
        input_values,
        Some(TriggerSource::Manual),
    )
    .await
    {
        Ok(execution_id) => json!({ "executionId": execution_id }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn workflow_abort(execution_id: String) -> Value {
    engine::abort_workflow(&execution_id);
    json!({ "success": true })
}

/// Stop whatever this flow is running, without needing an execution id.
#[tauri::command]
pub fn workflow_abort_flow(workflow_id: String) -> Value {
    json!({ "aborted": engine::abort_workflows_of(&workflow_id) })
}

#[tauri::command(rename_all = "camelCase")]
pub fn workflow_review_response(execution_id: String, node_id: String, approved: bool) -> Value {
    json!({ "ok": engine::respond_to_review(&execution_id, &node_id, approved) })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn workflow_executions_list(workflow_id: Option<String>) -> Value {
    json!(store::list_execution_records(workflow_id.as_deref()).await)
}

#[tauri::command]
pub async fn workflow_executions_get(id: String) -> Value {
    json!(store::load_execution_record(&id).await)
}

#[tauri::command]
pub async fn workflow_executions_delete(id: String) -> Value {
    match store::delete_execution_record(&id).await {
        Ok(()) => json!({ "success": true }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub async fn workflow_metrics(workflow_id: String) -> Value {
    json!(store::compute_workflow_metrics(&workflow_id).await)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn workflow_trigger_test(workflow_id: String, trigger_id: String) -> Value {
    match triggers::test_trigger(&workflow_id, &trigger_id).await {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command]
pub fn workflow_trigger_generate_token() -> Value {
    json!({ "token": util::rand_hex(24) })
}

#[tauri::command(rename_all = "camelCase")]
pub fn workflow_trigger_webhook_url(
    workflow_id: String,
    trigger_id: String,
    token: String,
) -> Value {
    match webhook_server::port() {
        Some(port) => json!({
            "url": format!("http://127.0.0.1:{port}/webhook/{workflow_id}/{trigger_id}?token={token}")
        }),
        None => json!({ "url": Value::Null }),
    }
}

#[tauri::command]
pub async fn workflow_export(app: AppHandle, workflow: Value) -> Value {
    let raw_name = workflow.get("name").and_then(Value::as_str).unwrap_or("");
    let safe: String = raw_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let default_name = format!(
        "{}.json",
        if safe.is_empty() { "workflow" } else { &safe }
    );

    let Some(path) = save_dialog(&app, &default_name, ("JSON", &["json"])).await else {
        return json!({ "canceled": true });
    };
    let body = serde_json::to_string_pretty(&workflow).unwrap_or_default();
    match fs_ops::write_text_file(&path, &body).await {
        Ok(()) => json!({ "success": true, "path": path }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command]
pub async fn workflow_import(app: AppHandle) -> Value {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("JSON", &["json"])
        .pick_file(move |p| {
            let _ = tx.send(p);
        });
    let Some(path) = rx.await.ok().flatten().map(|p| p.to_string()) else {
        return json!({ "canceled": true });
    };

    let raw = match tokio::fs::read_to_string(&path).await {
        Ok(raw) => raw,
        Err(e) => return json!({ "error": e.to_string() }),
    };
    let mut parsed = match serde_json::from_str::<Value>(&raw) {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }),
    };

    let valid = parsed.get("id").is_some()
        && parsed.get("nodes").is_some()
        && parsed.get("edges").is_some();
    if !valid {
        return json!({ "error": "Invalid workflow file — missing id, nodes, or edges" });
    }

    // Fresh id so importing never clobbers an existing workflow.
    let now = util::now_ms();
    if let Value::Object(map) = &mut parsed {
        map.insert("id".into(), json!(format!("wf-imported-{now}")));
        map.insert("isTemplate".into(), json!(false));
        map.insert("createdAt".into(), json!(now));
        map.insert("updatedAt".into(), json!(now));
    }

    match store::save_workflow(parsed).await {
        Ok(workflow) => json!({ "success": true, "workflow": workflow }),
        Err(e) => json!({ "error": e }),
    }
}

// ---- marketplace ----

#[tauri::command(rename_all = "camelCase")]
pub async fn marketplace_list(force_refresh: Option<bool>) -> Value {
    marketplace::fetch_index(force_refresh.unwrap_or(false)).await
}

#[tauri::command]
pub async fn marketplace_install(entry: MarketplaceEntry) -> Value {
    let result = marketplace::install_template(entry).await;
    if result.get("workflow").is_some() {
        triggers::refresh_triggers().await;
    }
    result
}

#[tauri::command]
pub fn marketplace_share(app: AppHandle, workflow: Value) -> Value {
    let url = build_marketplace_share_url(&workflow);
    let _ = app.opener().open_url(url, None::<&str>);
    json!({ "ok": true })
}

#[tauri::command]
pub fn marketplace_open(app: AppHandle) -> Value {
    let _ = app.opener().open_url(marketplace_repo_url(), None::<&str>);
    json!({ "ok": true })
}

// ---- pull requests ----

#[tauri::command]
pub async fn pr_state(url: String) -> Value {
    gh::pr_state(&url).await
}

/// Open a PR in the real browser, not Nyra's.
///
/// Nyra has a perfectly good browser panel, and it is the wrong one for this:
/// the sidecar runs its own profile, which is not signed in to GitHub, so a PR
/// opened there lands on a sign-in page. Your own browser already has the
/// session, the extensions and the tab you were going to leave it in.
///
/// Only http(s). The URL was recovered by a regex over tool output, and the
/// opener will happily hand a `file://` or a custom scheme to the OS.
#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Value {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return json!({ "ok": false, "error": "only http(s) URLs can be opened" });
    }
    match app.opener().open_url(url, None::<&str>) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

// ---- processes ----

#[tauri::command(rename_all = "camelCase")]
pub fn processes_list(nyra_session_id: String) -> Vec<processes::BgProcess> {
    processes::list_processes(&nyra_session_id)
}

#[tauri::command(rename_all = "camelCase")]
pub fn processes_kill(nyra_session_id: String, shell_id: String) -> Value {
    match processes::kill_shell(&nyra_session_id, &shell_id) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

#[tauri::command(rename_all = "camelCase")]
pub fn processes_clear(nyra_session_id: String) {
    processes::drop_session(&nyra_session_id);
}

// ---- subagents ----

/// Everything a subagent wrote, read off disk.
///
/// For a tab opened after the fact: the live stream only exists while the agent
/// runs, but its transcript outlives the session, so an agent from three turns
/// ago still has something to show.
#[tauri::command(rename_all = "camelCase")]
pub fn subagent_transcript(path: String) -> Value {
    subagents::read_transcript(&path)
}

// ---- login ----

#[tauri::command]
pub fn login_start() -> Value {
    match login::start_login(&util::settings().claude_binary_path) {
        Ok(pid) => json!({ "pid": pid }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command]
pub fn login_input(data: String) {
    login::write_login(&data);
}

#[tauri::command]
pub fn login_resize(cols: u16, rows: u16) {
    login::resize_login(cols, rows);
}

#[tauri::command]
pub fn login_cancel() {
    login::cancel_login();
}

// ---- dictation ----

#[tauri::command]
pub fn dictation_start(options: dictation::StartOptions) -> Value {
    match dictation::start(options) {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command]
pub fn dictation_stop() {
    dictation::stop();
}

#[tauri::command]
pub fn dictation_cancel() {
    dictation::cancel();
}

#[tauri::command]
pub fn dictation_status(model: Option<String>) -> Value {
    let model = model.unwrap_or_else(|| dictation::model::DEFAULT_MODEL.to_string());
    let mut status = dictation::model::status(&model);
    if let Value::Object(map) = &mut status {
        map.insert("recording".into(), Value::Bool(dictation::is_recording()));
        map.insert(
            "devices".into(),
            serde_json::to_value(dictation::capture::input_devices()).unwrap_or(Value::Null),
        );
    }
    status
}

#[tauri::command]
pub async fn dictation_model_download(model: String) -> Value {
    match dictation::model::download(model).await {
        Ok(()) => json!({ "ok": true }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command]
pub fn dictation_model_cancel() {
    dictation::model::cancel_download();
}

// ---- terminal ----

#[tauri::command]
pub fn terminal_spawn(id: String, cwd: String) -> Value {
    match terminal::spawn_terminal(&id, &cwd) {
        Ok(pid) => json!({ "pid": pid }),
        Err(e) => json!({ "error": e }),
    }
}

#[tauri::command]
pub fn terminal_write(id: String, data: String) {
    terminal::write_terminal(&id, &data);
}

#[tauri::command]
pub fn terminal_resize(id: String, cols: u16, rows: u16) {
    terminal::resize_terminal(&id, cols, rows);
}

#[tauri::command]
pub fn terminal_kill(id: String) {
    terminal::kill_terminal(&id);
}

// ---- browser ----

#[tauri::command]
pub async fn browser_status() -> Value {
    browser::status().await
}

// ---- designs ----

#[tauri::command]
pub async fn design_raster(request: Value) -> Value {
    browser::design_raster(request).await
}

#[tauri::command]
pub fn design_list(project: Option<String>) -> Value {
    let project = project.map(std::path::PathBuf::from);
    serde_json::json!(crate::designs::list(project.as_deref()))
}

#[tauri::command]
pub fn design_create(name: String, project: String) -> Value {
    match crate::designs::create(&name, std::path::Path::new(&project)) {
        Ok(entry) => serde_json::json!({ "ok": true, "design": entry }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
pub fn design_adopt(name: String, path: String, project: String) -> Value {
    match crate::designs::adopt(
        &name,
        std::path::Path::new(&path),
        std::path::Path::new(&project),
    ) {
        Ok(entry) => serde_json::json!({ "ok": true, "design": entry }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
pub fn design_relocate(id: String, to: String) -> Value {
    match crate::designs::relocate(&id, std::path::Path::new(&to)) {
        Ok(entry) => serde_json::json!({ "ok": true, "design": entry }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
pub fn design_rename(id: String, name: String) -> Value {
    match crate::designs::rename(&id, &name) {
        Ok(entry) => serde_json::json!({ "ok": true, "design": entry }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
pub fn design_forget(id: String, delete_file: Option<bool>) -> Value {
    match crate::designs::forget(&id, delete_file.unwrap_or(false)) {
        Ok(()) => serde_json::json!({ "ok": true }),
        Err(error) => serde_json::json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
pub async fn browser_configure(patch: Value) -> Value {
    browser::configure(patch).await
}

#[tauri::command]
pub async fn browser_install() -> Value {
    browser::install().await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn browser_open_chat(chat_id: String, host_dpr: Option<f64>) -> Value {
    browser::open_chat(&chat_id, host_dpr.unwrap_or(1.0)).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn browser_close_chat(chat_id: String) -> Value {
    browser::close_chat(&chat_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn browser_touch(chat_id: String) -> Value {
    browser::touch(&chat_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn browser_tab_create(chat_id: String, url: String) -> Value {
    browser::tab_create(&chat_id, &url).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn browser_tab_close(chat_id: String, tab_id: String) -> Value {
    browser::tab_close(&chat_id, &tab_id).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn browser_tab_navigate(chat_id: String, tab_id: String, url: String) -> Value {
    browser::tab_navigate(&chat_id, &tab_id, &url).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn browser_tab_set_viewport(
    chat_id: String,
    tab_id: String,
    id: String,
    width: Option<f64>,
    height: Option<f64>,
    by: Option<String>,
) -> Value {
    browser::tab_set_viewport(
        &chat_id,
        &tab_id,
        &id,
        width,
        height,
        by.as_deref().unwrap_or("user"),
    )
    .await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn browser_tab_history(chat_id: String, tab_id: String, action: String) -> Value {
    browser::tab_history(&chat_id, &tab_id, &action).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn browser_tab_list(chat_id: String) -> Value {
    browser::tab_list(&chat_id).await
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<updates::UpdateInfo, String> {
    updates::check(&app).await
}

#[tauri::command]
pub async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    updates::install(&app).await
}

#[tauri::command]
pub fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The renderer answering something `app_mcp::ask_renderer` asked it.
///
/// One command for every op rather than one each: the payload is already
/// opaque JSON by the time it gets here, and the thing that has to stay
/// narrow is who can ask, not what comes back.
#[tauri::command(rename_all = "camelCase")]
pub fn app_control_response(request_id: String, result: Value) {
    crate::app_mcp::deliver_response(&request_id, result);
}

// ---------------------------------------------------------------------------
// Devtools
// ---------------------------------------------------------------------------
//
// Exposed as commands as well as over HTTP so the pieces can be exercised from
// the renderer's own console — `with_webview`'s dispatch semantics are the part
// most likely to surprise, and debugging that through a socket is miserable.

#[tauri::command(rename_all = "camelCase")]
pub async fn devtools_screenshot(max_width: Option<u32>) -> Value {
    match devtools::capture_to_file(max_width).await {
        Ok(shot) => json!(shot),
        Err(error) => json!({ "error": error }),
    }
}

#[tauri::command]
pub async fn devtools_eval(code: String) -> Value {
    match devtools::eval_js(&code).await {
        Ok(value) => serde_json::from_str(&value)
            .unwrap_or_else(|_| json!({ "ok": false, "error": "the page did not answer with JSON" })),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

/// The renderer's console, batched. See `devlog.ts` — the lines land in the
/// same file as the backend's so the two read in causal order.
#[tauri::command]
pub async fn dev_log_push(lines: Vec<devtools::ConsoleLine>) {
    devtools::push_console_lines(lines);
}
