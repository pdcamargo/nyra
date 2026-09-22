//! The Whisper backend.
//!
//! Loads a ggml model, holds it while dictation is in use, and lets it go once
//! it isn't — `large-v3-turbo` at q5 is around 1.5 GB resident, which is not
//! something to keep alive for the rest of the session because somebody
//! dictated one sentence an hour ago.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::time::{Duration, Instant};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

use super::model;

/// Whisper consumes at most the last 224 tokens of the prompt.
const MAX_PROMPT_TOKENS: usize = 224;

/// Drop a segment the model itself thinks is probably not speech.
const NO_SPEECH_THRESHOLD: f32 = 0.6;

/// How long an unused model stays resident.
const IDLE_UNLOAD: Duration = Duration::from_secs(120);

struct Loaded {
    ctx: WhisperContext,
    model_id: String,
    last_used: Instant,
}

static LOADED: Lazy<Mutex<Option<Loaded>>> = Lazy::new(|| Mutex::new(None));

/// Transcription boilerplate Whisper emits over silence, because it was trained
/// on subtitled video where quiet stretches carry the credits.
///
/// Portuguese is the worst affected of the languages this supports, and
/// "Legendas pela comunidade Amara.org" appearing in the composer after a
/// recording where nobody spoke is the single most visible way this feature can
/// embarrass itself. Matched against the *whole* transcript only, never a
/// substring: somebody dictating a sentence that happens to contain one of
/// these should keep it.
const HALLUCINATIONS: &[&str] = &[
    "legendas pela comunidade amara.org",
    "legendado pela comunidade amara.org",
    "legendas pela comunidade amara org",
    "subtitles by the amara.org community",
    "subtítulos realizados por la comunidad de amara.org",
    "thank you.",
    "thanks for watching!",
    "you",
    "obrigado.",
    "tchau!",
];

fn normalise(text: &str) -> String {
    text.trim()
        .trim_matches(|c: char| c == '"' || c == '\'' || c == '♪' || c == '[' || c == ']')
        .trim()
        .to_lowercase()
}

/// True when the transcript is nothing but a known silence artefact.
pub fn is_hallucination(text: &str) -> bool {
    let normalised = normalise(text);
    normalised.is_empty() || HALLUCINATIONS.contains(&normalised.as_str())
}

/// Ensure the requested model is loaded, replacing a different one if needed.
fn with_context<T>(model_id: &str, f: impl FnOnce(&WhisperContext) -> T) -> Result<T, String> {
    let mut guard = LOADED.lock();

    let needs_load = match guard.as_ref() {
        Some(loaded) => loaded.model_id != model_id,
        None => true,
    };

    if needs_load {
        let path = model::path_for(model_id);
        if !model::is_installed(model_id) {
            return Err("the speech model is not downloaded yet".into());
        }
        // Dropped before the new one is built, so two models are never
        // resident at once — that would be 3 GB for a model switch.
        *guard = None;

        let params = WhisperContextParameters::default();
        let ctx = WhisperContext::new_with_params(&path, params)
            .map_err(|e| format!("could not load the speech model: {e}"))?;
        *guard = Some(Loaded {
            ctx,
            model_id: model_id.to_string(),
            last_used: Instant::now(),
        });
        start_reaper();
    }

    let loaded = guard.as_mut().expect("just loaded");
    loaded.last_used = Instant::now();
    Ok(f(&loaded.ctx))
}

/// Free the model now.
pub fn unload() {
    *LOADED.lock() = None;
}

static REAPER: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

fn start_reaper() {
    {
        let mut running = REAPER.lock();
        if *running {
            return;
        }
        *running = true;
    }
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(30));
        loop {
            ticker.tick().await;
            // `try_lock`, because `with_context` holds this for the whole of a
            // transcription. Blocking here would park a runtime worker for a
            // couple of seconds to ask a question that can just as well wait
            // for the next tick.
            let Some(mut guard) = LOADED.try_lock() else {
                continue;
            };
            let idle = guard
                .as_ref()
                .map(|l| l.last_used.elapsed() >= IDLE_UNLOAD)
                .unwrap_or(false);
            if idle {
                *guard = None;
            }
        }
    });
}

/// Turn the vocabulary list into the prompt Whisper is conditioned on.
///
/// Bare identifiers, comma separated, with no English scaffolding around them:
/// the prompt biases output *language* as well as spelling, and a sentence of
/// English framing nudges a Portuguese utterance towards English.
pub fn build_prompt(vocabulary: &[String]) -> String {
    let mut seen = std::collections::HashSet::new();
    let terms: Vec<&str> = vocabulary
        .iter()
        .map(|t| t.trim())
        .filter(|t| !t.is_empty() && t.len() <= 64)
        .filter(|t| seen.insert(t.to_lowercase()))
        .collect();
    terms.join(", ")
}

#[derive(Debug, Clone)]
pub struct Options {
    pub model_id: String,
    /// `None` means auto-detect. Otherwise an ISO code such as `pt` or `en`.
    pub language: Option<String>,
    /// Terms to bias towards, **least** valuable first: Whisper keeps only the
    /// last 224 tokens, so the tail is what survives.
    pub vocabulary: Vec<String>,
    /// Interim passes run mid-utterance and are thrown away, so they trade
    /// accuracy for latency.
    pub interim: bool,
}

/// The `language` string whisper.cpp should get.
///
/// Split out so the "auto" path is covered by a test: getting this wrong is
/// silent, and costs every word of every recording.
pub fn language_param(language: &Option<String>) -> &str {
    match language.as_deref() {
        None | Some("") | Some("auto") => "auto",
        Some(code) => code,
    }
}

pub fn transcribe(pcm: &[f32], options: &Options) -> Result<String, String> {
    // Below a second there is nothing for the encoder to work with, and short
    // buffers are where hallucinations cluster.
    if pcm.len() < super::capture::TARGET_RATE as usize / 2 {
        return Ok(String::new());
    }

    with_context(&options.model_id, |ctx| {
        let mut state = ctx
            .create_state()
            .map_err(|e| format!("could not start the recogniser: {e}"))?;

        let prompt = build_prompt(&options.vocabulary);
        // Tokenise generously, then keep the tail. That enforces the 224-token
        // budget and the "most valuable last" ordering in one step.
        let prompt_tokens: Vec<i32> = if prompt.is_empty() {
            Vec::new()
        } else {
            let tokens = ctx.tokenize(&prompt, MAX_PROMPT_TOKENS * 4).unwrap_or_default();
            let start = tokens.len().saturating_sub(MAX_PROMPT_TOKENS);
            tokens[start..].to_vec()
        };

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });

        // Whisper's translate task renders any input as English. Left on, a
        // Portuguese utterance silently comes back in English — the most
        // confusing failure this feature has, so it is set explicitly rather
        // than left to a default.
        params.set_translate(false);

        // `set_language` defaults to "en", not to auto, so it must always be
        // set: unset means Portuguese is decoded as though it were English.
        //
        // Note what is NOT here: `set_detect_language(true)`. whisper-rs
        // documents it as equivalent to passing "auto", and it is not.
        // whisper.cpp reads it as "identify the language and stop":
        //
        //     if (params.detect_language) { return 0; }
        //
        // That returns zero segments and no error, so the recording looks
        // like it worked and produces nothing. Passing "auto" auto-detects
        // and then goes on to transcribe, which is what we want.
        params.set_language(Some(language_param(&options.language)));

        params.set_n_threads(recommended_threads());
        params.set_no_timestamps(true);
        params.set_suppress_blank(true);
        params.set_no_speech_thold(NO_SPEECH_THRESHOLD);
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);

        if options.interim {
            // Each interim pass stands alone, so it cannot inherit drift from
            // the last one, and one segment is all the line above the composer
            // can show anyway.
            params.set_no_context(true);
            params.set_single_segment(true);
        }

        if !prompt_tokens.is_empty() {
            params.set_tokens(&prompt_tokens);
        }

        state
            .full(params, pcm)
            .map_err(|e| format!("transcription failed: {e}"))?;

        let segments = state.full_n_segments();
        let mut out = String::new();
        let mut dropped = 0;
        for i in 0..segments {
            let Some(segment) = state.get_segment(i) else {
                continue;
            };
            if segment.no_speech_probability() > NO_SPEECH_THRESHOLD {
                dropped += 1;
                continue;
            }
            if let Ok(text) = segment.to_str_lossy() {
                out.push_str(&text);
            }
        }

        // An empty result is indistinguishable from a broken one at the UI, so
        // say which it was here. This is the line that would have named the
        // `detect_language` bug in seconds rather than after a session of
        // recordings that produced nothing.
        if out.trim().is_empty() {
            crate::logf!(
                "dictation: {:.1}s of audio produced no text ({segments} segments, {dropped} below the speech threshold)",
                pcm.len() as f32 / super::capture::TARGET_RATE as f32
            );
        }

        let trimmed = out.trim().to_string();
        if is_hallucination(&trimmed) {
            return Ok(String::new());
        }
        Ok(trimmed)
    })?
}

fn recommended_threads() -> std::ffi::c_int {
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    // Leave headroom: the UI, the Claude process and the sidecar all want a
    // core while this runs.
    cores.saturating_sub(2).clamp(2, 8) as std::ffi::c_int
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_silence_artefacts_are_dropped() {
        assert!(is_hallucination("Legendas pela comunidade Amara.org"));
        assert!(is_hallucination("  legendas pela comunidade amara.org  "));
        assert!(is_hallucination("Subtitles by the Amara.org community"));
        assert!(is_hallucination(""));
        assert!(is_hallucination("   "));
    }

    #[test]
    fn real_speech_survives() {
        assert!(!is_hallucination("refactor the ComposerBar to use IconButton"));
        assert!(!is_hallucination("adiciona um teste pro resampler"));
        // Only a whole-transcript match counts, so a real sentence that
        // mentions the artefact is kept.
        assert!(!is_hallucination(
            "add legendas pela comunidade amara.org to the blocklist"
        ));
    }

    #[test]
    fn prompt_drops_blanks_and_duplicates() {
        let vocab = vec![
            "  ".to_string(),
            "ComposerBar".to_string(),
            "composerbar".to_string(),
            "IconButton".to_string(),
        ];
        assert_eq!(build_prompt(&vocab), "ComposerBar, IconButton");
    }

    #[test]
    fn prompt_keeps_caller_order_so_the_best_terms_land_last() {
        let vocab = vec!["generic".to_string(), "Specific".to_string()];
        assert_eq!(build_prompt(&vocab), "generic, Specific");
    }

    #[test]
    fn prompt_is_empty_for_an_empty_vocabulary() {
        assert_eq!(build_prompt(&[]), "");
    }

    #[test]
    fn absurdly_long_terms_are_skipped() {
        let vocab = vec!["x".repeat(500), "ok".to_string()];
        assert_eq!(build_prompt(&vocab), "ok");
    }

    /// `set_detect_language(true)` makes whisper.cpp return after identifying
    /// the language, with zero segments and no error — so every recording
    /// comes back empty. Auto-detection has to go through the language string.
    #[test]
    fn auto_detection_goes_through_the_language_string() {
        assert_eq!(language_param(&None), "auto");
        assert_eq!(language_param(&Some(String::new())), "auto");
        assert_eq!(language_param(&Some("auto".into())), "auto");
    }

    #[test]
    fn an_explicit_language_is_passed_through() {
        assert_eq!(language_param(&Some("pt".into())), "pt");
        assert_eq!(language_param(&Some("en".into())), "en");
    }

    #[test]
    fn thread_count_leaves_headroom() {
        let n = recommended_threads();
        assert!((2..=8).contains(&n), "got {n} threads");
    }
}
