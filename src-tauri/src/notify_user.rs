//! OS notifications for turn completion and permission prompts.
//!
//! Only fires while the window is in the background, same as the Electron build.
//!
//! Clicking one brings the window up and opens the chat that posted it. The
//! notification plugin can't do that on desktop: it shows through notify-rust and
//! drops the handle, so nothing ever hears the click. Windows posts through the
//! toast layer below it, and macOS through `UNUserNotificationCenter`, each with
//! its own way of reporting the click; everywhere else still goes through the
//! plugin, and a click there only does what the OS does.
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
        crate::logf!("notification skipped, turned off in settings: {title}");
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
        crate::logf!("notification skipped, window is focused: {title}");
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

/// Posted through `UNUserNotificationCenter`, whose delegate hears the click.
///
/// Not through notify-rust or the plugin: both use `NSUserNotificationCenter`,
/// deprecated since macOS 11, which neither waits for a click on a notification
/// without buttons nor posts as the real app — it swizzles the bundle id.
#[cfg(target_os = "macos")]
fn post(_app: &AppHandle, title: &str, body: &str, chat: String) {
    mac::post(title, body, &chat);
}

/// Registers the click handler. Call once at startup, so a click on a
/// notification left in Notification Center by an earlier turn still lands.
#[cfg(target_os = "macos")]
pub fn init() {
    mac::init();
}

#[cfg(not(target_os = "macos"))]
pub fn init() {}

#[cfg(target_os = "macos")]
mod mac {
    use std::sync::atomic::{AtomicU64, Ordering};

    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{define_class, msg_send, AllocAnyThread};
    use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
        UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
        UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };

    /// The chat rides in the request identifier, `{chat}#{n}`. The counter keeps
    /// two notifications for one chat from replacing each other.
    static NEXT: AtomicU64 = AtomicU64::new(0);

    define_class!(
        // SAFETY: NSObject has no subclassing requirements, and this has no Drop.
        #[unsafe(super = NSObject)]
        #[name = "NyraNotificationDelegate"]
        struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl UNUserNotificationCenterDelegate for Delegate {
            // Without this a notification posted while Nyra is the active app is
            // dropped — and it can be active with the main window unfocused.
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                done: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                done.call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                done: &DynBlock<dyn Fn()>,
            ) {
                let clicked = response
                    .actionIdentifier()
                    .isEqualToString(unsafe { UNNotificationDefaultActionIdentifier });
                let id = response.notification().request().identifier().to_string();
                if let (true, Some((chat, _))) = (clicked, id.rsplit_once('#')) {
                    super::open_chat(chat);
                }
                done.call(());
            }
        }
    );

    /// None outside an `.app`. The center raises for a process with no bundle,
    /// which is `tauri dev` — so dev gets the Dock bounce and nothing else.
    fn center() -> Option<Retained<UNUserNotificationCenter>> {
        let bundled = NSBundle::mainBundle().bundlePath().to_string().ends_with(".app");
        bundled.then(UNUserNotificationCenter::currentNotificationCenter)
    }

    pub fn init() {
        let Some(center) = center() else {
            crate::logf!("notifications: not in an .app bundle, so none will show");
            return;
        };
        let delegate: Retained<Delegate> = unsafe { msg_send![Delegate::alloc(), init] };
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        // The property is weak; the delegate lives as long as the process.
        std::mem::forget(delegate);
    }

    /// Asks for permission first, every time. Once answered that returns without
    /// a prompt, and the first notification after a fresh install is the one
    /// that asks, rather than a dialog at launch before anything has happened.
    pub fn post(title: &str, body: &str, chat: &str) {
        let Some(center) = center() else { return };

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        let id = format!("{chat}#{}", NEXT.fetch_add(1, Ordering::Relaxed));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&id),
            &content,
            None,
        );

        let poster = center.clone();
        let granted = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            if granted.as_bool() {
                crate::logf!("notification posted: {}", request.identifier());
                poster.addNotificationRequest_withCompletionHandler(&request, None);
            } else if let Some(error) = unsafe { error.as_ref() } {
                crate::logf!("notifications not allowed: {}", error.localizedDescription());
            } else {
                crate::logf!("notifications turned off for Nyra in System Settings");
            }
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &granted,
        );
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn post(app: &AppHandle, title: &str, body: &str, _chat: String) {
    use tauri_plugin_notification::NotificationExt;

    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        crate::logf!("notification failed: {e}");
    }
}
