//! OS notifications for turn completion and permission prompts.
//!
//! Only fires while the window is in the background, same as the Electron build.
//!
//! Clicking one brings the window up and opens the chat that posted it. The
//! notification plugin can't do that on desktop: it shows through notify-rust and
//! drops the handle, so nothing ever hears the click. Windows and macOS post
//! through the layer below it instead, each with its own way of reporting the
//! click; everywhere else still goes through the plugin, and a click there only
//! does what the OS does.
//!
//! Never through `osascript`. It used to be insurance against an unsigned build
//! dropping the plugin's notification, but macOS attributes a notification to
//! whoever posted it, and `osascript`'s host is Script Editor. Clicking the
//! notification opened Script Editor, which then asked which script you meant.

use serde_json::json;
use tauri::{AppHandle, UserAttentionType};

use crate::util;

/// Fire an OS notification for `nyra_session_id`'s chat. Returns immediately.
///
/// The window queries and the notification itself dispatch to the macOS main
/// thread. This is called from the stdout reader task, so doing it inline lets a
/// busy main thread stall the whole event stream for that session.
pub fn notify(title: &str, body: &str, nyra_session_id: &str) {
    if !util::settings().notifications {
        return;
    }
    let (title, body, chat) = (
        title.to_string(),
        body.to_string(),
        nyra_session_id.to_string(),
    );
    tauri::async_runtime::spawn(async move { notify_blocking(&title, &body, chat) });
}

fn notify_blocking(title: &str, body: &str, chat: String) {
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

    post(app, title, body, chat);
}

/// The notification was clicked: bring the window up on the chat behind it.
///
/// The renderer does the switching, workspace included — setting the active chat
/// is all it takes, the workspace followers handle the rest.
fn open_chat(chat: &str) {
    if let Some(w) = util::main_window() {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    util::emit("nyra:notification-clicked", json!({ "nyraSessionId": chat }));
}

/// A toast whose `Activated` callback opens the chat.
///
/// The callback is in-process, registered on the toast object Windows keeps
/// alive while the toast exists — so it also fires from Action Center after the
/// banner has gone, for as long as this process runs. No thread waits on it.
#[cfg(windows)]
fn post(app: &AppHandle, title: &str, body: &str, chat: String) {
    use tauri_winrt_notification::Toast;

    let toast = Toast::new(&toast_app_id(app))
        .title(title)
        .text1(body)
        .on_activated(move |_| {
            open_chat(&chat);
            Ok(())
        });
    if let Err(e) = toast.show() {
        crate::logf!("notification failed: {e:?}");
    }
}

/// Which app Windows files the toast under.
///
/// Only the installed app has a Start-menu shortcut registered under the
/// identifier, and a toast under an unregistered ID never shows — so a cargo
/// build borrows PowerShell's, the same test the plugin makes. The click still
/// comes back here: the callback is ours whoever the toast is filed under.
#[cfg(windows)]
fn toast_app_id(app: &AppHandle) -> String {
    use std::path::{Path, MAIN_SEPARATOR as SEP};

    let exe = tauri::utils::platform::current_exe().ok();
    let dir = exe
        .as_deref()
        .and_then(Path::parent)
        .map(|d| d.display().to_string())
        .unwrap_or_default();
    let cargo_build = dir.ends_with(&format!("{SEP}target{SEP}debug"))
        || dir.ends_with(&format!("{SEP}target{SEP}release"));
    if cargo_build {
        tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

/// Sent synchronously on a thread of its own, which blocks until the
/// notification is clicked or dismissed.
///
/// That wait is how notify-rust reports a click on macOS, and it can last as
/// long as the notification sits in Notification Center — so a dedicated thread,
/// not the async runtime's. The delegate it waits on is called on the main run
/// loop, which Tauri is already pumping.
#[cfg(target_os = "macos")]
fn post(app: &AppHandle, title: &str, body: &str, chat: String) {
    use std::sync::Once;

    // Attributes every notification to an app, once per process. `tauri dev`
    // has no bundle of its own, so it borrows Terminal's, as the plugin does.
    static APPLICATION: Once = Once::new();
    APPLICATION.call_once(|| {
        let bundle = if tauri::is_dev() {
            "com.apple.Terminal".to_string()
        } else {
            app.config().identifier.clone()
        };
        let _ = notify_rust::set_application(&bundle);
    });

    let mut notification = notify_rust::Notification::new();
    notification.summary(title).body(body);
    std::thread::spawn(move || match notification.show() {
        Ok(handle) => handle.wait_for_action(|action| {
            if action == "default" {
                open_chat(&chat);
            }
        }),
        Err(e) => crate::logf!("notification failed: {e}"),
    });
}

#[cfg(not(any(windows, target_os = "macos")))]
fn post(app: &AppHandle, title: &str, body: &str, _chat: String) {
    use tauri_plugin_notification::NotificationExt;

    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        crate::logf!("notification failed: {e}");
    }
}
