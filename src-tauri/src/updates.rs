//! Checking for, and installing, a new Nyra.
//!
//! The renderer never talks to the plugin directly — it asks through
//! `window.api`, same as everything else, so the update path is one command
//! rather than a second bridge with its own rules.

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

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

/// Download and install it, then restart into the new one.
///
/// Tauri replaces the bundle in place rather than handing the download to a
/// browser, so macOS does not quarantine it — the Gatekeeper prompt is a
/// first-install problem, not an every-update one.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else {
        return Err("No update available".into());
    };
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}
