//! The Whisper model file: where it lives, and getting it there.
//!
//! The engine is code compiled into the binary; the model is the trained
//! weights it runs, and they are far too big to bundle. So they are fetched
//! once, on first use, into `~/.nyra/models` — alongside `designs/`,
//! `worktrees/` and `devtools/`, which is where Nyra already keeps data as
//! opposed to settings.
//!
//! Only multilingual models are offered. The `.en` variants are more accurate
//! at English for their size, but they cannot transcribe Portuguese at all,
//! and pt-BR is a requirement rather than a nice-to-have.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::util;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub file: &'static str,
    pub label: &'static str,
    /// Exact `content-length`, so a truncated download is caught before the
    /// first confusing transcription rather than after it.
    pub bytes: u64,
    pub note: &'static str,
}

/// `large-v3-turbo` has 4 decoder layers instead of 32, so it is far faster for
/// a small accuracy cost, and across languages it lands around `large-v2`. The
/// documented turbo regressions are Thai and Cantonese; Portuguese is one of
/// Whisper's strongest languages. At 547 MB it is only ~80 MB more than
/// `small` and clearly better, which is why there is no middle option here.
pub const MODELS: &[ModelInfo] = &[
    ModelInfo {
        id: "turbo",
        file: "ggml-large-v3-turbo-q5_0.bin",
        label: "Turbo",
        bytes: 574_041_195,
        note: "Best accuracy. Recommended.",
    },
    ModelInfo {
        id: "base",
        file: "ggml-base.bin",
        label: "Base",
        bytes: 147_951_465,
        note: "Smaller download, noticeably weaker outside English.",
    },
];

pub const DEFAULT_MODEL: &str = "turbo";

pub fn find(id: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

fn resolve(id: &str) -> &'static ModelInfo {
    find(id).unwrap_or_else(|| find(DEFAULT_MODEL).expect("default model is in the catalogue"))
}

pub fn models_dir() -> PathBuf {
    util::home_dir().join(".nyra").join("models")
}

pub fn path_for(id: &str) -> PathBuf {
    models_dir().join(resolve(id).file)
}

/// A model counts as present only at exactly the right size. A half-written
/// file from a killed download would otherwise load and fail deep inside ggml
/// with nothing that points back here.
pub fn is_installed(id: &str) -> bool {
    let info = resolve(id);
    size_matches(std::fs::metadata(path_for(id)).ok().map(|m| m.len()), info.bytes)
}

/// The size rule on its own, so it can be tested without depending on what
/// happens to be downloaded on the machine running the suite.
fn size_matches(actual: Option<u64>, expected: u64) -> bool {
    actual == Some(expected)
}

fn url_for(info: &ModelInfo) -> String {
    format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{}",
        info.file
    )
}

/// Set while a download runs; clearing it is how Cancel is delivered.
static DOWNLOAD: Lazy<Mutex<Option<Arc<AtomicBool>>>> = Lazy::new(|| Mutex::new(None));

pub fn is_downloading() -> bool {
    DOWNLOAD.lock().is_some()
}

pub fn cancel_download() {
    if let Some(flag) = DOWNLOAD.lock().take() {
        flag.store(true, Ordering::Relaxed);
    }
}

fn emit(payload: serde_json::Value) {
    util::emit("dictation:event", payload);
}

/// Fetch a model, reporting progress as it goes.
///
/// Writes to `<file>.part` and renames only on a complete, correctly-sized
/// download, so an interrupted fetch can never be mistaken for a usable model.
pub async fn download(id: String) -> Result<(), String> {
    let info = resolve(&id);
    if is_installed(&id) {
        emit(json!({ "type": "model_ready", "model": info.id }));
        return Ok(());
    }
    if is_downloading() {
        return Err("a model download is already running".into());
    }

    let cancelled = Arc::new(AtomicBool::new(false));
    *DOWNLOAD.lock() = Some(cancelled.clone());

    let result = download_inner(info, &cancelled).await;

    DOWNLOAD.lock().take();

    match &result {
        Ok(()) => emit(json!({ "type": "model_ready", "model": info.id })),
        Err(e) if cancelled.load(Ordering::Relaxed) => {
            emit(json!({ "type": "model_cancelled", "model": info.id }));
            crate::logf!("dictation: download of {} cancelled ({e})", info.file);
        }
        Err(e) => emit(json!({
            "type": "model_failed",
            "model": info.id,
            "error": e,
        })),
    }
    result
}

async fn download_inner(info: &'static ModelInfo, cancelled: &AtomicBool) -> Result<(), String> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    let dir = models_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    let final_path = dir.join(info.file);
    let part_path = dir.join(format!("{}.part", info.file));

    let response = reqwest::Client::new()
        .get(url_for(info))
        .send()
        .await
        .map_err(|e| format!("could not reach the model host: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("the model host answered {}", response.status()));
    }
    let total = response.content_length().unwrap_or(info.bytes);

    let mut file = tokio::fs::File::create(&part_path)
        .await
        .map_err(|e| format!("could not write {part_path:?}: {e}"))?;

    let mut received: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut stream = response.bytes_stream();

    emit(json!({
        "type": "model_progress",
        "model": info.id,
        "received": 0,
        "total": total,
    }));

    while let Some(chunk) = stream.next().await {
        if cancelled.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("the download broke off: {e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("could not write {part_path:?}: {e}"))?;
        received += chunk.len() as u64;

        // ~10 Hz. A progress event per chunk would be thousands a second.
        if last_emit.elapsed() >= std::time::Duration::from_millis(100) {
            last_emit = std::time::Instant::now();
            emit(json!({
                "type": "model_progress",
                "model": info.id,
                "received": received,
                "total": total,
            }));
        }
    }

    file.flush()
        .await
        .map_err(|e| format!("could not finish writing {part_path:?}: {e}"))?;
    drop(file);

    if received != info.bytes {
        let _ = tokio::fs::remove_file(&part_path).await;
        return Err(format!(
            "expected {} bytes but got {received} — the download was truncated",
            info.bytes
        ));
    }

    tokio::fs::rename(&part_path, &final_path)
        .await
        .map_err(|e| format!("could not move the model into place: {e}"))?;

    emit(json!({
        "type": "model_progress",
        "model": info.id,
        "received": received,
        "total": total,
    }));
    Ok(())
}

/// What the renderer needs to decide between "offer the download dialog",
/// "show a progress bar" and "just record".
pub fn status(id: &str) -> serde_json::Value {
    let info = resolve(id);
    json!({
        "model": info.id,
        "installed": is_installed(info.id),
        "downloading": is_downloading(),
        "bytes": info.bytes,
        "label": info.label,
        "catalogue": MODELS,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_model_is_multilingual() {
        // A `.en` model cannot transcribe Portuguese at all, so one slipping
        // into the catalogue is a silent regression for half the users.
        for model in MODELS {
            assert!(
                !model.file.contains(".en."),
                "{} is English-only",
                model.file
            );
        }
    }

    #[test]
    fn default_model_exists() {
        assert!(find(DEFAULT_MODEL).is_some());
    }

    #[test]
    fn unknown_ids_fall_back_to_the_default() {
        assert_eq!(resolve("nonsense").id, DEFAULT_MODEL);
        assert_eq!(resolve("").id, DEFAULT_MODEL);
    }

    #[test]
    fn paths_land_under_the_nyra_models_dir() {
        let path = path_for("base");
        assert!(path.ends_with("ggml-base.bin"));
        assert!(path.starts_with(models_dir()));
    }

    /// Only an exact size counts as installed. A download killed partway
    /// through and renamed into place would otherwise load and fail deep
    /// inside ggml, with nothing pointing back here.
    #[test]
    fn only_an_exact_size_counts_as_installed() {
        assert!(size_matches(Some(574_041_195), 574_041_195));
        assert!(!size_matches(Some(574_041_194), 574_041_195));
        assert!(!size_matches(Some(0), 574_041_195));
        assert!(!size_matches(None, 574_041_195));
    }
}
