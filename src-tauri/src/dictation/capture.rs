//! Microphone capture, resampled to what Whisper wants.
//!
//! Capture is native rather than `getUserMedia` in the WebView. wry grants
//! media capture unconditionally, so the browser route would work, but it would
//! mean an AAC decoder (WebKit's `MediaRecorder` emits AAC, not Opus), a wider
//! CSP, and megabytes of audio crossing the IPC bridge per utterance. Going
//! through `cpal` avoids all three and is the same code path Linux and Windows
//! will want when the port lands.
//!
//! `cpal::Stream` is `!Send` on CoreAudio, so the stream lives and dies on its
//! own thread; everything shared with the rest of the app goes through the
//! `Arc`s in `Capture`.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// What Whisper is trained on. Everything is resampled to this before decoding.
pub const TARGET_RATE: u32 = 16_000;

/// Shared state between the capture thread and everyone else.
struct Capture {
    /// Mono f32 at the *device's* rate. Resampled on demand rather than in the
    /// audio callback, which must stay cheap.
    samples: Arc<Mutex<Vec<f32>>>,
    /// The device rate, needed to resample. Not assumed to be 48 kHz.
    rate: u32,
    /// Most recent RMS, as `f32::to_bits`, for the level meter.
    level: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
}

static CAPTURE: Lazy<Mutex<Option<Capture>>> = Lazy::new(|| Mutex::new(None));

/// Names of every input device, for the settings picker.
pub fn input_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|devices| {
            devices
                .filter_map(|d| d.description().ok().map(|desc| desc.name().to_string()))
                .collect()
        })
        .unwrap_or_default()
}

fn pick_device(preferred: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(name) = preferred.filter(|n| !n.is_empty()) {
        if let Ok(mut devices) = host.input_devices() {
            if let Some(found) =
                devices.find(|d| d.description().map(|desc| desc.name() == name).unwrap_or(false))
            {
                return Ok(found);
            }
        }
        // A device that has been unplugged since it was chosen should not stop
        // dictation working — fall through to the default and carry on.
        crate::logf!("dictation: input device {name:?} not found, using the default");
    }
    host.default_input_device()
        .ok_or_else(|| "no microphone available".to_string())
}

/// Begin capturing. Returns the device sample rate.
pub fn start(preferred_device: Option<&str>) -> Result<u32, String> {
    stop();

    let device = pick_device(preferred_device)?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("no usable input config: {e}"))?;
    let rate: u32 = supported.sample_rate().into();
    let channels = supported.channels() as usize;
    let format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();

    let samples = Arc::new(Mutex::new(Vec::<f32>::with_capacity(rate as usize * 8)));
    let level = Arc::new(AtomicU32::new(0));
    let stop_flag = Arc::new(AtomicBool::new(false));

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    {
        let samples = samples.clone();
        let level = level.clone();
        let stop_flag = stop_flag.clone();
        std::thread::Builder::new()
            .name("nyra-dictation-capture".into())
            .spawn(move || {
                let built = match format {
                    SampleFormat::F32 => build::<f32>(&device, &config, channels, &samples, &level),
                    SampleFormat::I16 => build::<i16>(&device, &config, channels, &samples, &level),
                    SampleFormat::I32 => build::<i32>(&device, &config, channels, &samples, &level),
                    SampleFormat::I8 => build::<i8>(&device, &config, channels, &samples, &level),
                    SampleFormat::U8 => build::<u8>(&device, &config, channels, &samples, &level),
                    SampleFormat::U16 => build::<u16>(&device, &config, channels, &samples, &level),
                    other => Err(format!("unsupported sample format {other:?}")),
                };

                let stream = match built {
                    Ok(stream) => stream,
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                if let Err(e) = stream.play() {
                    let _ = ready_tx.send(Err(format!("could not start the microphone: {e}")));
                    return;
                }
                let _ = ready_tx.send(Ok(()));

                while !stop_flag.load(Ordering::Relaxed) {
                    std::thread::sleep(Duration::from_millis(20));
                }
                drop(stream);
            })
            .map_err(|e| format!("could not start the capture thread: {e}"))?;
    }

    // Surface "the mic is refused or missing" as a failed start rather than as
    // a recording that silently produces nothing.
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => return Err("the microphone did not start in time".into()),
    }

    *CAPTURE.lock() = Some(Capture {
        samples,
        rate,
        level,
        stop: stop_flag,
    });
    Ok(rate)
}

fn build<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    channels: usize,
    samples: &Arc<Mutex<Vec<f32>>>,
    level: &Arc<AtomicU32>,
) -> Result<cpal::Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let samples = samples.clone();
    let level = level.clone();
    device
        .build_input_stream(
            config.clone(),
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let mut sum_sq = 0.0f32;
                let mut mono = Vec::with_capacity(data.len() / channels.max(1) + 1);
                for frame in data.chunks(channels.max(1)) {
                    // Downmix rather than take channel 0: some interfaces put
                    // the only live signal on the second channel.
                    let mut acc = 0.0f32;
                    for sample in frame {
                        acc += f32::from_sample(*sample);
                    }
                    let value = acc / frame.len() as f32;
                    sum_sq += value * value;
                    mono.push(value);
                }
                if !mono.is_empty() {
                    let rms = (sum_sq / mono.len() as f32).sqrt();
                    level.store(rms.to_bits(), Ordering::Relaxed);
                    samples.lock().extend_from_slice(&mono);
                }
            },
            move |err| crate::logf!("dictation: input stream error: {err}"),
            None,
        )
        .map_err(|e| format!("could not open the microphone: {e}"))
}

/// Latest RMS level, 0.0–1.0, for the meter on the mic button.
pub fn level() -> f32 {
    CAPTURE
        .lock()
        .as_ref()
        .map(|c| f32::from_bits(c.level.load(Ordering::Relaxed)))
        .unwrap_or(0.0)
}

/// A snapshot of everything captured so far, resampled to 16 kHz, without
/// stopping. This is what the interim passes read.
pub fn snapshot_16k() -> Option<Vec<f32>> {
    let (samples, rate) = {
        let guard = CAPTURE.lock();
        let capture = guard.as_ref()?;
        (capture.samples.clone(), capture.rate)
    };
    let raw = samples.lock().clone();
    Some(resample_to_16k(&raw, rate))
}

/// Stop capturing and return everything recorded, resampled to 16 kHz.
pub fn finish() -> Option<Vec<f32>> {
    let capture = CAPTURE.lock().take()?;
    capture.stop.store(true, Ordering::Relaxed);
    let raw = capture.samples.lock().clone();
    Some(resample_to_16k(&raw, capture.rate))
}

/// Stop capturing and throw the audio away.
pub fn stop() {
    if let Some(capture) = CAPTURE.lock().take() {
        capture.stop.store(true, Ordering::Relaxed);
    }
}

/// Peak absolute amplitude, used to decide whether anything was actually said.
pub fn peak(samples: &[f32]) -> f32 {
    samples.iter().fold(0.0f32, |peak, s| peak.max(s.abs()))
}

/// Band-limited resample to 16 kHz.
///
/// Naive decimation would alias speech harmonics down into the band Whisper
/// cares about, so this goes through rubato's FFT resampler rather than picking
/// every third sample. Input at exactly 16 kHz is passed through untouched.
pub fn resample_to_16k(input: &[f32], rate: u32) -> Vec<f32> {
    // Both re-exported by rubato, so neither needs to be a direct dependency.
    use rubato::audioadapter::Adapter;
    use rubato::audioadapter_buffers::direct::InterleavedSlice;
    use rubato::{Fft, FixedSync, Resampler};

    if input.is_empty() {
        return Vec::new();
    }
    if rate == TARGET_RATE {
        return input.to_vec();
    }

    let adapter = match InterleavedSlice::new(input, 1, input.len()) {
        Ok(adapter) => adapter,
        Err(e) => {
            crate::logf!("dictation: could not wrap {} samples: {e}", input.len());
            return Vec::new();
        }
    };

    let mut resampler =
        match Fft::<f32>::new(rate as usize, TARGET_RATE as usize, 1024, 1, FixedSync::Both) {
            Ok(resampler) => resampler,
            Err(e) => {
                crate::logf!("dictation: no resampler for {rate} Hz: {e}");
                return Vec::new();
            }
        };

    match resampler.process_all(&adapter, input.len(), None) {
        Ok(out) => (0..out.frames())
            .filter_map(|frame| out.read_sample(0, frame))
            .collect(),
        Err(e) => {
            crate::logf!("dictation: resampling {rate} Hz -> 16 kHz failed: {e}");
            Vec::new()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 440 Hz tone at 48 kHz should come back at 16 kHz with a third of the
    /// frames and its amplitude intact — the check that catches a resampler
    /// wired up to the wrong ratio, which would still "work" and transcribe
    /// everything as gibberish.
    #[test]
    fn resamples_48k_to_16k() {
        let rate = 48_000u32;
        let input: Vec<f32> = (0..rate)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin())
            .collect();

        let out = resample_to_16k(&input, rate);

        let expected = TARGET_RATE as usize;
        let drift = (out.len() as i64 - expected as i64).abs();
        assert!(drift < 64, "got {} frames, wanted about {expected}", out.len());
        // Skip the edges, where the anti-aliasing window tapers.
        let body = &out[1_000..out.len() - 1_000];
        assert!(peak(body) > 0.9, "tone was attenuated: peak {}", peak(body));
    }

    #[test]
    fn resamples_44_1k_to_16k() {
        let rate = 44_100u32;
        let input = vec![0.0f32; rate as usize];
        let out = resample_to_16k(&input, rate);
        let drift = (out.len() as i64 - TARGET_RATE as i64).abs();
        assert!(drift < 64, "got {} frames from 44.1 kHz", out.len());
    }

    /// 16 kHz in must be 16 kHz out, unchanged and un-resampled.
    #[test]
    fn passes_16k_through() {
        let input: Vec<f32> = (0..1000).map(|i| i as f32 / 1000.0).collect();
        assert_eq!(resample_to_16k(&input, TARGET_RATE), input);
    }

    #[test]
    fn empty_input_is_empty_output() {
        assert!(resample_to_16k(&[], 48_000).is_empty());
    }

    #[test]
    fn peak_finds_the_loudest_sample_either_way() {
        assert_eq!(peak(&[0.1, -0.7, 0.3]), 0.7);
        assert_eq!(peak(&[]), 0.0);
    }
}
