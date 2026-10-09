//! What the OS lets Nyra do, for Settings → System.
//!
//! One row per grant a feature needs, in the renderer's words: this side says
//! which grants exist on this OS, where each stands, and what its button does.
//! Which grants exist is the OS difference, so it lives in the `imp` switch
//! below; the renderer never asks which OS it is on.
//!
//! Nothing here reads another app's data, so none of it raises a privacy
//! prompt by itself. The only prompts are the ones a button asks for.

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Allowed,
    Denied,
    /// Never answered. Only macOS has this for the microphone and notifications.
    #[cfg_attr(windows, allow(dead_code))]
    Unasked,
    /// This OS does not gate it.
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    NotRequired,
    /// Cannot be checked from this build — notifications in `tauri dev`, which
    /// has no app bundle to ask with.
    #[cfg_attr(windows, allow(dead_code))]
    Unavailable,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Access {
    /// `controlInput`, `captureScreen`, `desktop` (both, on an OS that gates
    /// neither), `microphone`, `notifications`.
    pub kind: &'static str,
    pub state: State,
    /// What the OS calls it, shown beside the feature.
    pub os_name: &'static str,
    /// The button, when there is something to do. `fix` does it.
    pub action: Option<String>,
    /// Asks rather than opens settings: drawn as the primary button.
    pub asks: bool,
}

pub async fn list() -> Vec<Access> {
    imp::list().await
}

pub async fn fix(kind: &str) -> Result<(), String> {
    imp::fix(kind).await
}

fn open(target: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let app = crate::util::app_handle().ok_or("no app")?;
    app.opener()
        .open_url(target, None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
mod imp {
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject, Bool};
    use objc2::msg_send;
    use objc2_foundation::{NSBundle, NSString};

    use super::{open, Access, State};
    use crate::desktop::PermissionKind;

    #[link(name = "AVFoundation", kind = "framework")]
    unsafe extern "C" {
        static AVMediaTypeAudio: &'static NSString;
    }

    const MIC_PANE: &str = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
    const NOTIFY_PANE: &str = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";

    pub async fn list() -> Vec<Access> {
        let desktop = crate::desktop::live().permissions().await;
        let mut out: Vec<Access> = desktop
            .into_iter()
            .map(|p| {
                let (kind, os_name) = match p.kind {
                    PermissionKind::ControlInput => ("controlInput", "Accessibility"),
                    PermissionKind::CaptureScreen => {
                        ("captureScreen", "Screen & System Audio Recording")
                    }
                };
                Access {
                    kind,
                    state: if p.granted { State::Allowed } else { State::Denied },
                    os_name,
                    action: (!p.granted).then(|| "Open System Settings".into()),
                    asks: false,
                }
            })
            .collect();

        out.push(match microphone() {
            0 => Access {
                kind: "microphone",
                state: State::Unasked,
                os_name: "Microphone",
                action: Some("Allow".into()),
                asks: can_ask_for_microphone(),
            },
            3 => allowed("microphone", "Microphone"),
            _ => denied("microphone", "Microphone"),
        });

        let notifications = tauri::async_runtime::spawn_blocking(crate::notify_user::authorization)
            .await
            .ok()
            .flatten();
        out.push(match notifications {
            None => Access {
                kind: "notifications",
                state: State::Unavailable,
                os_name: "Notifications",
                action: None,
                asks: false,
            },
            Some(0) => Access {
                kind: "notifications",
                state: State::Unasked,
                os_name: "Notifications",
                action: Some("Allow".into()),
                asks: true,
            },
            Some(1) => denied("notifications", "Notifications"),
            Some(_) => allowed("notifications", "Notifications"),
        });
        out
    }

    fn allowed(kind: &'static str, os_name: &'static str) -> Access {
        Access { kind, state: State::Allowed, os_name, action: None, asks: false }
    }

    fn denied(kind: &'static str, os_name: &'static str) -> Access {
        Access {
            kind,
            state: State::Denied,
            os_name,
            action: Some("Open System Settings".into()),
            asks: false,
        }
    }

    pub async fn fix(kind: &str) -> Result<(), String> {
        match kind {
            "controlInput" => crate::desktop::live().fix_permission(PermissionKind::ControlInput).await,
            "captureScreen" => crate::desktop::live().fix_permission(PermissionKind::CaptureScreen).await,
            "microphone" => {
                if microphone() == 0 && can_ask_for_microphone() {
                    request_microphone();
                    Ok(())
                } else {
                    open(MIC_PANE)
                }
            }
            "notifications" => {
                if crate::notify_user::authorization() == Some(0) {
                    crate::notify_user::request_authorization();
                    Ok(())
                } else {
                    open(NOTIFY_PANE)
                }
            }
            _ => Err("unknown permission".into()),
        }
    }

    fn capture_device() -> Option<&'static AnyClass> {
        AnyClass::get(c"AVCaptureDevice")
    }

    /// `AVAuthorizationStatus`: 0 not asked, 1 restricted, 2 denied, 3 allowed.
    fn microphone() -> isize {
        let Some(class) = capture_device() else { return 0 };
        // SAFETY: a class method taking a media type constant.
        unsafe { msg_send![class, authorizationStatusForMediaType: AVMediaTypeAudio] }
    }

    /// Asking without a usage string in Info.plist kills the process, and
    /// `tauri dev` has no Info.plist — so there, the button opens the pane.
    fn can_ask_for_microphone() -> bool {
        let key = NSString::from_str("NSMicrophoneUsageDescription");
        let value: Option<Retained<AnyObject>> =
            unsafe { msg_send![&*NSBundle::mainBundle(), objectForInfoDictionaryKey: &*key] };
        value.is_some()
    }

    fn request_microphone() {
        let Some(class) = capture_device() else { return };
        let done = block2::RcBlock::new(|granted: Bool| {
            crate::logf!("microphone: asked, granted={}", granted.as_bool());
        });
        // SAFETY: the completion block is copied by the callee.
        let _: () = unsafe {
            msg_send![class, requestAccessForMediaType: AVMediaTypeAudio, completionHandler: &*done]
        };
    }
}

#[cfg(windows)]
mod imp {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Registry::{
        RegGetValueW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ,
    };

    use super::{open, Access, State};

    const CONSENT: &str =
        r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    pub async fn list() -> Vec<Access> {
        let mic_denied = [
            (HKEY_LOCAL_MACHINE, CONSENT.to_string()),
            (HKEY_CURRENT_USER, CONSENT.to_string()),
            // "Let desktop apps access your microphone" — the switch Nyra is under.
            (HKEY_CURRENT_USER, format!(r"{CONSENT}\NonPackaged")),
        ]
        .iter()
        .any(|(root, key)| reg_string(*root, key, "Value").as_deref() == Some("Deny"));

        let app_id = crate::util::app_handle()
            .map(|app| crate::notify_user::toast_app_id(&app))
            .unwrap_or_default();
        let toasts_off = reg_dword(
            HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\PushNotifications",
            "ToastEnabled",
        ) == Some(0)
            || reg_dword(
                HKEY_CURRENT_USER,
                &format!(r"Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\{app_id}"),
                "Enabled",
            ) == Some(0);

        vec![
            row("microphone", "Microphone", mic_denied),
            row("notifications", "Notifications", toasts_off),
            Access {
                kind: "desktop",
                state: State::NotRequired,
                os_name: "No Windows permission",
                action: None,
                asks: false,
            },
        ]
    }

    fn row(kind: &'static str, os_name: &'static str, denied: bool) -> Access {
        Access {
            kind,
            state: if denied { State::Denied } else { State::Allowed },
            os_name,
            action: denied.then(|| "Open privacy settings".into()),
            asks: false,
        }
    }

    pub async fn fix(kind: &str) -> Result<(), String> {
        match kind {
            "microphone" => open("ms-settings:privacy-microphone"),
            "notifications" => open("ms-settings:notifications"),
            _ => Err("unknown permission".into()),
        }
    }

    fn reg_string(root: HKEY, key: &str, value: &str) -> Option<String> {
        let (key, value) = (HSTRING::from(key), HSTRING::from(value));
        let mut buf = [0u16; 64];
        let mut len = (buf.len() * 2) as u32;
        unsafe {
            RegGetValueW(
                root,
                PCWSTR(key.as_ptr()),
                PCWSTR(value.as_ptr()),
                RRF_RT_REG_SZ,
                None,
                Some(buf.as_mut_ptr().cast()),
                Some(&mut len),
            )
            .ok()
            .ok()?;
        }
        let chars = (len as usize / 2).saturating_sub(1);
        Some(String::from_utf16_lossy(&buf[..chars]))
    }

    fn reg_dword(root: HKEY, key: &str, value: &str) -> Option<u32> {
        let (key, value) = (HSTRING::from(key), HSTRING::from(value));
        let mut out = 0u32;
        let mut len = 4u32;
        unsafe {
            RegGetValueW(
                root,
                PCWSTR(key.as_ptr()),
                PCWSTR(value.as_ptr()),
                RRF_RT_REG_DWORD,
                None,
                Some((&mut out as *mut u32).cast()),
                Some(&mut len),
            )
            .ok()
            .ok()?;
        }
        Some(out)
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    use super::Access;

    pub async fn list() -> Vec<Access> {
        Vec::new()
    }

    pub async fn fix(_kind: &str) -> Result<(), String> {
        Err("nothing to fix on this OS".into())
    }
}
