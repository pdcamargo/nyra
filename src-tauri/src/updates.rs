//! Checking for, and installing, a new Nyra.
//!
//! The renderer never talks to the plugin directly — it asks through
//! `window.api`, same as everything else, so the update path is one command
//! rather than a second bridge with its own rules.
//!
//! Downloading and installing are separate steps. "Update automatically"
//! downloads in the background and parks the verified bytes here; they are
//! installed when Nyra quits, or sooner if the user presses Restart now. Nothing
//! restarts Nyra on its own, because a restart kills every running Claude turn.

use std::sync::Mutex;

use serde::Serialize;
use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};
use tauri_plugin_window_state::{AppHandleExt, StateFlags};

use crate::util;

/// A downloaded, signature-checked update waiting to be installed.
struct Staged {
    update: Update,
    bytes: Vec<u8>,
}

static STAGED: Mutex<Option<Staged>> = Mutex::new(None);

/// One download at a time. A second press of Update while the first is still
/// streaming would otherwise fetch the whole bundle twice.
static DOWNLOADING: Mutex<bool> = Mutex::new(false);

#[derive(Serialize)]
pub struct UpdateInfo {
    pub available: bool,
    pub version: String,
    pub notes: String,
    pub current: String,
}

/// Ask the release feed whether there is something newer.
///
/// An error here is worth seeing — a typo in the endpoint and a genuinely
/// unreachable network look identical from the app, and silently reporting "no
/// update" for both is how an updater quietly stops updating.
pub async fn check(app: &AppHandle) -> Result<UpdateInfo, String> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await.map_err(|e| e.to_string())? {
        Some(update) => Ok(UpdateInfo {
            available: true,
            version: update.version.clone(),
            notes: update.body.clone().unwrap_or_default(),
            current,
        }),
        None => Ok(UpdateInfo {
            available: false,
            version: current.clone(),
            notes: String::new(),
            current,
        }),
    }
}

/// Fetch the update and verify it, reporting progress as it streams.
///
/// `nyra:update-progress` carries the running byte count and the total when the
/// server sent one, which is what the toast's bar is drawn from.
async fn download(update: &Update) -> Result<Vec<u8>, String> {
    {
        let mut busy = DOWNLOADING.lock().unwrap_or_else(|e| e.into_inner());
        if *busy {
            return Err("An update is already downloading".into());
        }
        *busy = true;
    }
    let version = update.version.clone();
    let mut received: u64 = 0;
    let result = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                util::emit(
                    "nyra:update-progress",
                    json!({ "version": version, "received": received, "total": total }),
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string());
    *DOWNLOADING.lock().unwrap_or_else(|e| e.into_inner()) = false;
    result
}

/// Download in the background and hold it for the next quit.
///
/// Returns the version that is now staged. Staging the same version twice is a
/// no-op rather than a second download.
pub async fn stage(app: &AppHandle) -> Result<String, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("No update available".into());
    };
    if let Some(staged) = STAGED.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        if staged.update.version == update.version {
            return Ok(update.version.clone());
        }
    }
    let bytes = download(&update).await?;
    let version = update.version.clone();
    *STAGED.lock().unwrap_or_else(|e| e.into_inner()) = Some(Staged { update, bytes });
    Ok(version)
}

/// Install now and restart into the new one.
///
/// Uses the staged download when there is one, and fetches it otherwise.
///
/// Tauri replaces the bundle in place rather than handing the download to a
/// browser, so macOS does not quarantine it — the Gatekeeper prompt is a
/// first-install problem, not an every-update one.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let staged = STAGED.lock().unwrap_or_else(|e| e.into_inner()).take();
    let (update, bytes) = match staged {
        Some(Staged { update, bytes }) => (update, bytes),
        None => {
            let updater = app.updater().map_err(|e| e.to_string())?;
            let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
                return Err("No update available".into());
            };
            let bytes = download(&update).await?;
            (update, bytes)
        }
    };
    // Save before the handoff so a maximized window comes back maximized at its
    // prior normal size. On Windows `install` exits the process itself, so this
    // has to come first.
    if let Err(error) = app.save_window_state(StateFlags::SIZE | StateFlags::MAXIMIZED) {
        crate::log!("update", "Could not save window state before restart: {error}");
    }
    update.install(bytes).map_err(|e| e.to_string())?;
    app.restart();
}

/// Install whatever is staged, on the way out.
///
/// Called from `RunEvent::Exit`. The Windows installer is told not to relaunch:
/// the user quit, and Nyra reappearing a few seconds later would read as a
/// crash-and-restart. The new version is simply what opens next time.
pub fn install_staged_on_exit() {
    let Some(Staged { update, bytes }) = STAGED.lock().unwrap_or_else(|e| e.into_inner()).take()
    else {
        return;
    };
    let version = update.version.clone();
    if let Err(error) = update.restart_after_install(false).install(bytes) {
        crate::log!("update", "Could not install {version} on quit: {error}");
    }
}
