//! The engine's host inside Nyra: asking the user, telling the renderer, and
//! the two signs of control that work while you are looking at another app —
//! a tray icon, and a global Esc.
//!
//! Both only exist while a chat is controlling something. Esc in particular is
//! registered then and released at the end of the turn: a global hotkey
//! swallows the key everywhere, which is right for a kill switch (a page cannot
//! use the same Esc to dismiss a dialog) and wrong for every other minute of
//! the day.

use parking_lot::Mutex;
use serde_json::json;
use std::collections::BTreeMap;
use std::time::Duration;

use super::{AppId, AppInfo, Answer, Blocked, BoxFuture, Host, PermissionKind, Seen};
use crate::util;

const TRAY_ID: &str = "nyra-desktop-control";
const STOP_ITEM: &str = "nyra-desktop-stop";

/// Long enough to walk back to the window and read the question; short enough
/// that a turn nobody is watching fails instead of hanging.
const ASK_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct TauriHost {
    /// chat → the app it is controlling.
    controlling: Mutex<BTreeMap<String, String>>,
}

impl Host for TauriHost {
    fn ask_allow<'a>(
        &'a self,
        chat: &'a str,
        app: &'a AppInfo,
        warning: Option<&'static str>,
    ) -> BoxFuture<'a, Result<Answer, String>> {
        Box::pin(async move {
            let focused = util::main_window()
                .and_then(|w| w.is_focused().ok())
                .unwrap_or(false);
            if !focused {
                crate::notify_user::notify(
                    &format!("Claude wants to use {}", app.name),
                    "Answer in Nyra to let it, or not.",
                    chat,
                );
            }
            let answer = crate::app_mcp::ask_renderer_within(
                ASK_TIMEOUT,
                "desktop.allow",
                json!({
                    "chatId": chat,
                    "app": { "id": app.id.0, "name": app.name },
                    "warning": warning,
                }),
            )
            .await
            .map_err(|_| "they didn't answer within two minutes".to_string())?;
            match answer.get("answer").and_then(|v| v.as_str()) {
                Some("chat") => Ok(Answer::ThisChat),
                Some("always") => Ok(Answer::Always),
                Some("no") => Ok(Answer::No),
                _ => Err("the question was dismissed".into()),
            }
        })
    }

    fn always_allowed(&self, id: &AppId) -> bool {
        util::settings().desktop_allowed_apps.iter().any(|a| a == &id.0)
    }

    fn controlling(&self, chat: &str, app: Option<&str>) {
        let apps: Vec<String> = {
            let mut map = self.controlling.lock();
            match app {
                Some(a) => {
                    map.insert(chat.to_string(), a.to_string());
                }
                None => {
                    map.remove(chat);
                }
            }
            let mut apps: Vec<String> = map.values().cloned().collect();
            apps.dedup();
            apps
        };
        util::emit("nyra:desktop-activity", json!({ "chatId": chat, "app": app }));
        refresh(apps);
    }

    fn seen(&self, chat: &str, seen: &Seen) {
        let mut payload = serde_json::to_value(seen).unwrap_or_default();
        if let Some(map) = payload.as_object_mut() {
            map.insert("chatId".into(), json!(chat));
        }
        util::emit("nyra:desktop-seen", payload);
    }

    fn blocked(&self, chat: &str, kind: PermissionKind, blocked: &Blocked) {
        util::emit(
            "nyra:desktop-blocked",
            json!({ "chatId": chat, "kind": kind, "reason": blocked.reason, "fix": blocked.fix }),
        );
    }
}

/// Put the tray and the Esc key in step with what is being controlled.
fn refresh(apps: Vec<String>) {
    let Some(app) = util::app_handle() else { return };
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if apps.is_empty() {
            let _ = handle.remove_tray_by_id(TRAY_ID);
            release_escape(&handle);
            return;
        }
        let label = format!("Claude is using {}", apps.join(", "));
        match handle.tray_by_id(TRAY_ID) {
            Some(tray) => {
                let _ = tray.set_tooltip(Some(&label));
                let _ = tray.set_title(Some(&label));
            }
            None => build_tray(&handle, &label),
        }
        claim_escape(&handle);
    });
}

fn build_tray(app: &tauri::AppHandle, label: &str) {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let Ok(stop) = MenuItem::with_id(app, STOP_ITEM, "Stop desktop control (Esc)", true, None::<&str>) else {
        return;
    };
    let Ok(menu) = Menu::with_items(app, &[&stop]) else { return };
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip(label)
        .title(label)
        .menu(&menu)
        .on_menu_event(|_, event| {
            if event.id().as_ref() == STOP_ITEM {
                stop_all();
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    if let Err(e) = builder.build(app) {
        crate::log!("desktop", "could not show the tray indicator: {e}");
    }
}

fn escape() -> tauri_plugin_global_shortcut::Shortcut {
    tauri_plugin_global_shortcut::Shortcut::new(None, tauri_plugin_global_shortcut::Code::Escape)
}

fn claim_escape(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let shortcuts = app.global_shortcut();
    if shortcuts.is_registered(escape()) {
        return;
    }
    let result = shortcuts.on_shortcut(escape(), |_, _, event| {
        if event.state != ShortcutState::Pressed {
            return;
        }
        // An Escape Claude sent to close a menu is not the user reaching for
        // the kill switch.
        if super::live().escape_was_ours() {
            return;
        }
        stop_all();
    });
    if let Err(e) = result {
        crate::log!("desktop", "could not claim Esc as the kill switch: {e}");
    }
}

fn release_escape(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let shortcuts = app.global_shortcut();
    if shortcuts.is_registered(escape()) {
        let _ = shortcuts.unregister(escape());
    }
}

/// Esc, the tray's Stop, and the `desktop.stop` command all land here.
pub fn stop_all() {
    let stopped = super::live().halt_controlling();
    crate::log!("desktop", "desktop control stopped for {} chat(s)", stopped.len());
    util::emit("nyra:desktop-stopped", json!({ "chats": stopped }));
}
