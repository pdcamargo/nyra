//! OS notifications for turn completion and permission prompts.
//!
//! Only fires while the window is in the background, same as the Electron build.
//!
//! Through the notification plugin alone. It used to also shell out to
//! `osascript`, as insurance against an unsigned build dropping the plugin's
//! notification — but macOS attributes a notification to whoever posted it, and
//! `osascript`'s host is Script Editor. Clicking the notification opened Script
//! Editor, which then asked which script you meant. The plugin posts under
//! `com.nyra.app`, so clicking it opens Nyra, which is the entire point of
//! clicking it.

use tauri::UserAttentionType;
use tauri_plugin_notification::NotificationExt;

use crate::util;

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

    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        crate::logf!("notification failed: {e}");
    }
}
