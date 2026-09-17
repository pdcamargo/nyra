//! Nyra — a desktop GUI for Claude Code, on Tauri.

mod claude;
mod commands;
mod file_extractor;
mod fs_ops;
mod git;
mod hooks;
pub mod logger;
mod login;
mod mcp;
mod memory;
mod notify_user;
mod processes;
mod settings;
mod skills;
mod terminal;
mod util;
mod webhook_server;
mod workflow;

use tauri::{Manager, RunEvent, WindowEvent};

/// Everything that must be torn down before the process goes away. Runs on
/// window close and again on exit, so it has to be idempotent.
fn shutdown() {
    terminal::kill_all_terminals();
    login::cancel_login();
    claude::dispose_all();
    workflow::triggers::stop_trigger_runtime();
    webhook_server::stop();
    fs_ops::cleanup_temp_dirs();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logger::init();
    workflow::store::migrate_legacy_data_dir();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            util::set_app_handle(app.handle().clone());

            // The window is configured hidden so the first paint is the app rather
            // than a blank rectangle; the frontend calls show() once React mounts.
            // This is the backstop: if the frontend never gets that far, showing a
            // broken window beats showing nothing at all.
            if let Some(window) = app.get_webview_window("main") {
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    if !window.is_visible().unwrap_or(true) {
                        crate::logf!("Frontend never signalled ready — showing window anyway");
                        let _ = window.show();
                    }
                });
            }

            tauri::async_runtime::spawn(async {
                webhook_server::start(8787).await;
                workflow::triggers::start_trigger_runtime().await;
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::Destroyed = event {
                if window.label() == "main" {
                    shutdown();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::claude_query,
            commands::claude_permission_response,
            commands::claude_abort,
            commands::claude_dispose,
            commands::claude_check_binary,
            commands::claude_save_image,
            commands::claude_save_temp_file,
            commands::claude_process_file,
            commands::dialog_pick_folder,
            commands::dialog_pick_file,
            commands::dialog_pick_files,
            commands::dialog_save_file,
            commands::agents_list,
            commands::skills_list,
            commands::skills_write,
            commands::skills_delete,
            commands::memory_list,
            commands::memory_read,
            commands::memory_write,
            commands::memory_delete,
            commands::settings_sync,
            commands::fs_read_file,
            commands::fs_revert_file,
            commands::fs_list_files,
            commands::system_homedir,
            commands::git_branch,
            commands::git_branch_list,
            commands::git_checkout,
            commands::git_is_repo,
            commands::git_main_worktree_root,
            commands::git_worktree_create,
            commands::git_worktree_create_managed,
            commands::git_worktree_list,
            commands::git_diff_stat,
            commands::git_worktree_snapshot,
            commands::git_worktree_restore,
            commands::git_snapshot_exists,
            commands::git_snapshot_discard,
            commands::git_worktree_merge,
            commands::git_worktree_remove,
            commands::mcp_list,
            commands::hooks_read,
            commands::hooks_write,
            commands::workflow_list,
            commands::workflow_load,
            commands::workflow_save,
            commands::workflow_delete,
            commands::workflow_templates,
            commands::workflow_run,
            commands::workflow_abort,
            commands::workflow_review_response,
            commands::workflow_executions_list,
            commands::workflow_executions_get,
            commands::workflow_executions_delete,
            commands::workflow_metrics,
            commands::workflow_trigger_test,
            commands::workflow_trigger_generate_token,
            commands::workflow_trigger_webhook_url,
            commands::workflow_export,
            commands::workflow_import,
            commands::marketplace_list,
            commands::marketplace_install,
            commands::marketplace_share,
            commands::marketplace_open,
            commands::processes_list,
            commands::processes_kill,
            commands::processes_clear,
            commands::login_start,
            commands::login_input,
            commands::login_resize,
            commands::login_cancel,
            commands::terminal_spawn,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Nyra")
        .run(|_app, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                shutdown();
            }
        });
}
