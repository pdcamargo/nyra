//! The Tauri command surface.
//!
//! Every handler here is the direct counterpart of an `ipcMain.handle(...)` in
//! the Electron build, and returns the same JSON shape — the renderer's
//! `window.api` shim maps one to one onto these names.

use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::workflow::helpers::{build_marketplace_share_url, marketplace_repo_url};
use crate::workflow::types::{MarketplaceEntry, TriggerSource};
use crate::workflow::{engine, marketplace, store, triggers};
use crate::{browser, claude, file_extractor, fs_ops, git, hooks, login, mcp, memory, processes, skills};
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
            builder = builder
                .add_filter("All Supported", &ATTACHMENT_EXTENSIONS)
                .add_filter(
                    "Documents",
                    &["pdf", "docx", "doc", "xlsx", "xls", "pptx", "ppt", "csv", "txt"],
                )
                .add_filter(
                    "Code",
                    &["py", "js", "ts", "jsx", "tsx", "rb", "go", "rs", "java", "c", "cpp", "css", "sql"],
                )
                .add_filter("Images", &["png", "jpg", "jpeg", "gif", "webp"])
                .add_filter("All Files", &["*"]);
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

#[tauri::command]
pub async fn skills_write(scope: String, name: String, content: String, cwd: String) -> Value {
    match skills::write_skill(&scope, &name, &content, &cwd).await {
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

#[tauri::command]
pub async fn browser_configure(patch: Value) -> Value {
    browser::configure(patch).await
}

#[tauri::command]
pub async fn browser_install() -> Value {
    browser::install().await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn browser_open_chat(chat_id: String) -> Value {
    browser::open_chat(&chat_id).await
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
pub async fn browser_tab_history(chat_id: String, tab_id: String, action: String) -> Value {
    browser::tab_history(&chat_id, &tab_id, &action).await
}

#[tauri::command(rename_all = "camelCase")]
pub async fn browser_tab_list(chat_id: String) -> Value {
    browser::tab_list(&chat_id).await
}
