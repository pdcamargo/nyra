//! Voice dictation: speak into the composer, edit the transcript, then send.
//!
//! Capture is native (`capture`), transcription is local (`whisper`), and the
//! model is fetched once on first use (`model`). Nothing here talks to a
//! network service, so there is no key to hold and nothing to meter.
//!
//! The renderer drives three commands — start, stop, cancel — and everything
//! else arrives as `dictation:event`, the same shape the terminal and Claude
//! streams use.

pub mod capture;
pub mod model;
pub mod whisper;

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::util;

/// Which engine transcribes.
///
/// One variant today. The shape is here so that Apple's on-device
/// `SpeechAnalyzer` can be added without disturbing capture, the event
/// protocol or any of the UI — it is deliberately not surfaced to the user,
/// who should never have to hold an opinion about a speech engine.
///
/// Whoever adds the Apple arm: bias the vocabulary through
/// `DictationTranscriber` with `AnalysisContext.contextualStrings[.general]`.
/// `SpeechTranscriber`, which most examples reach for, accepts contextual
/// strings and silently ignores them.
enum Transcriber {
    Whisper,
}

impl Transcriber {
    fn transcribe(&self, pcm: &[f32], options: &whisper::Options) -> Result<String, String> {
        match self {
            Transcriber::Whisper => whisper::transcribe(pcm, options),
        }
    }
}

/// How often the level meter updates.
const LEVEL_INTERVAL: Duration = Duration::from_millis(50);

/// How often an interim pass may start. A pass over 20 s of audio takes about
/// two seconds on turbo, so passes are also gated on the previous one having
/// finished — this is a floor, not a promise.
const INTERIM_INTERVAL: Duration = Duration::from_millis(1200);

/// Interim passes look at the tail only. The full buffer is still what the
/// final transcription sees.
const INTERIM_WINDOW_SECONDS: usize = 10;

/// Any real input device has room tone above this, even in a quiet room. A
/// stream of exact zeros means the device is not actually feeding us audio —
/// permission refused, hardware muted, or the wrong input selected. All three
/// look identical from here, and all three deserve to be said out loud rather
/// than left to produce a recording of nothing.
const SIGNAL_FLOOR: f32 = 1e-5;

/// How long to wait before concluding the microphone is dead. Long enough that
/// a slow device start is not reported as a fault.
const NO_SIGNAL_AFTER: Duration = Duration::from_millis(1500);

/// Below this peak amplitude nothing was said, whatever the decoder claims.
/// This is the first line of defence against silence hallucination; the phrase
/// list in `whisper` is the second.
const SILENCE_PEAK: f32 = 0.012;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StartOptions {
    pub model: Option<String>,
    /// `None` or "auto" for detection; otherwise "pt", "en", …
    pub language: Option<String>,
    pub device: Option<String>,
    #[serde(default)]
    pub vocabulary: Vec<String>,
    #[serde(default)]
    pub live_transcript: bool,
}

struct Session {
    stop: Arc<AtomicBool>,
    options: whisper::Options,
}

static SESSION: Lazy<Mutex<Option<Session>>> = Lazy::new(|| Mutex::new(None));

fn emit(payload: serde_json::Value) {
    util::emit("dictation:event", payload);
}

pub fn is_recording() -> bool {
    SESSION.lock().is_some()
}

pub fn start(options: StartOptions) -> Result<(), String> {
    if is_recording() {
        return Err("already recording".into());
    }

    let model_id = options
        .model
        .clone()
        .unwrap_or_else(|| model::DEFAULT_MODEL.to_string());
    if !model::is_installed(&model_id) {
        return Err("the speech model is not downloaded yet".into());
    }

    capture::start(options.device.as_deref())?;

    let language = match options.language.as_deref() {
        None | Some("") | Some("auto") => None,
        Some(code) => Some(code.to_string()),
    };
    let whisper_options = whisper::Options {
        model_id,
        language,
        vocabulary: options.vocabulary.clone(),
        interim: false,
    };

    let stop = Arc::new(AtomicBool::new(false));
    *SESSION.lock() = Some(Session {
        stop: stop.clone(),
        options: whisper_options.clone(),
    });

    spawn_level_meter(stop.clone(), options.device.clone());
    if options.live_transcript {
        spawn_interim_loop(stop, whisper_options);
    }

    emit(json!({ "type": "recording_started" }));
    Ok(())
}

fn spawn_level_meter(stop: Arc<AtomicBool>, device: Option<String>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(LEVEL_INTERVAL);
        let started = std::time::Instant::now();
        let mut heard = false;
        let mut warned = false;

        while !stop.load(Ordering::Relaxed) {
            ticker.tick().await;
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let level = capture::level();
            if level > SIGNAL_FLOOR {
                heard = true;
            }
            emit(json!({ "type": "level", "level": level }));

            // Said once, and only once: a recording that is going to produce
            // nothing should say so while it is still running, not after.
            if !heard && !warned && started.elapsed() >= NO_SIGNAL_AFTER {
                warned = true;
                emit(json!({
                    "type": "no_signal",
                    "device": device.clone().unwrap_or_else(|| "the default microphone".into()),
                }));
            }
        }
    });
}

fn spawn_interim_loop(stop: Arc<AtomicBool>, mut options: whisper::Options) {
    options.interim = true;
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(INTERIM_INTERVAL);
        // Whisper is not a streaming model: "live" means re-running over a
        // growing buffer. Passes never overlap, so on a slower model this
        // simply updates less often rather than queueing up work.
        while !stop.load(Ordering::Relaxed) {
            ticker.tick().await;
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let Some(samples) = capture::snapshot_16k() else {
                break;
            };
            let window = interim_window(&samples);
            if window.len() < capture::TARGET_RATE as usize || capture::peak(&window) < SILENCE_PEAK
            {
                continue;
            }

            let options = options.clone();
            let result =
                tauri::async_runtime::spawn_blocking(move || Transcriber::Whisper.transcribe(&window, &options))
                    .await;

            if stop.load(Ordering::Relaxed) {
                break;
            }
            match result {
                Ok(Ok(text)) if !text.is_empty() => {
                    emit(json!({ "type": "interim", "text": text }));
                }
                Ok(Err(e)) => crate::logf!("dictation: interim pass failed: {e}"),
                _ => {}
            }
        }
    });
}

/// The tail of the buffer that an interim pass looks at.
fn interim_window(samples: &[f32]) -> Vec<f32> {
    let window = capture::TARGET_RATE as usize * INTERIM_WINDOW_SECONDS;
    let start = samples.len().saturating_sub(window);
    samples[start..].to_vec()
}

/// Stop recording and transcribe what was captured.
pub fn stop() {
    let Some(session) = SESSION.lock().take() else {
        return;
    };
    session.stop.store(true, Ordering::Relaxed);

    let Some(samples) = capture::finish() else {
        emit(json!({ "type": "cancelled" }));
        return;
    };

    // Nothing was said. Returning early matters: this is exactly the input
    // that makes Whisper emit subtitle boilerplate.
    if samples.is_empty() || capture::peak(&samples) < SILENCE_PEAK {
        emit(json!({ "type": "transcript", "text": "" }));
        return;
    }

    emit(json!({ "type": "transcribing" }));
    let options = session.options;
    tauri::async_runtime::spawn(async move {
        let result =
            tauri::async_runtime::spawn_blocking(move || Transcriber::Whisper.transcribe(&samples, &options))
                .await;
        match result {
            Ok(Ok(text)) => emit(json!({ "type": "transcript", "text": text })),
            Ok(Err(e)) => emit(json!({ "type": "error", "error": e })),
            Err(e) => emit(json!({ "type": "error", "error": format!("transcription panicked: {e}") })),
        }
    });
}

/// Stop recording and throw the audio away.
pub fn cancel() {
    if let Some(session) = SESSION.lock().take() {
        session.stop.store(true, Ordering::Relaxed);
    }
    capture::stop();
    emit(json!({ "type": "cancelled" }));
}

/// Called on app shutdown.
pub fn dispose() {
    cancel();
    model::cancel_download();
    whisper::unload();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interim_window_takes_the_tail() {
        let rate = capture::TARGET_RATE as usize;
        let samples: Vec<f32> = (0..rate * 30).map(|i| i as f32).collect();
        let window = interim_window(&samples);
        assert_eq!(window.len(), rate * INTERIM_WINDOW_SECONDS);
        assert_eq!(*window.last().unwrap(), *samples.last().unwrap());
    }

    #[test]
    fn interim_window_of_a_short_buffer_is_the_whole_thing() {
        let samples = vec![0.5f32; 1000];
        assert_eq!(interim_window(&samples).len(), 1000);
    }

    /// The silence floor has to sit above room tone but below quiet speech, or
    /// it either lets hallucinations through or eats real dictation.
    #[test]
    fn silence_floor_is_between_room_tone_and_speech() {
        assert!(SILENCE_PEAK > 0.001, "would let room tone count as speech");
        assert!(SILENCE_PEAK < 0.05, "would swallow quiet speech");
    }
}
