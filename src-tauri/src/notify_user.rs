//! OS notifications for turn completion and permission prompts.
//!
//! Only fires while the window is in the background, same as the Electron build.
//! We send through the notification plugin *and* `osascript`, because an unsigned
//! macOS build silently drops the former — the duplicate is cheap insurance.

use tauri::UserAttentionType;
use tauri_plugin_notification::NotificationExt;

use crate::util;

fn notify_via_osascript(title: &str, body: &str) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let script = format!(
        "display notification {} with title {}",
        serde_json::to_string(body).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(title).unwrap_or_else(|_| "\"\"".into())
    );
    std::thread::spawn(move || {
        let _ = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output();
    });
}

/// Fire an OS notification. Returns immediately.
///
/// The window queries and the notification itself dispatch to the macOS main
/// thread. This is called from the stdout reader task, so doing it inline lets a
/// busy main thread stall the whole event stream for that session.
pub fn notify(title: &str, body: &str) {
    if !util::settings().notifications {
        return;
    }
    let (title, body) = (title.to_string(), body.to_string());
    tauri::async_runtime::spawn(async move { notify_blocking(&title, &body) });
}

fn notify_blocking(title: &str, body: &str) {
    let Some(app) = util::app_handle() else { return };
    let window = util::main_window();

    // Foreground app? The user can already see what happened.
    let focused = window
        .as_ref()
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    if focused {
        return;
    }

    if let Some(w) = &window {
        let _ = w.request_user_attention(Some(UserAttentionType::Informational));
    }

    let _ = app
        .notification()
        .builder()
        .title(title)
        .body(body)
        .show();

    notify_via_osascript(title, body);
}
