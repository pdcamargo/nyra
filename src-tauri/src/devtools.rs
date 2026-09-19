//! Inspecting a running Nyra from outside it.
//!
//! Nyra is used to develop Nyra, which means a dev instance and the installed
//! app run side by side and there is no way to see into the dev one. Loading the
//! renderer in a normal browser tab is not it — there is no Tauri IPC there, so
//! the app does not work and the bug does not reproduce.
//!
//! So: go at the real webview. Two primitives, both reaching the live
//! `WKWebView` through `with_webview`.
//!
//! `takeSnapshotWithConfiguration` is the screenshot, and the reason is
//! specific: it is an IPC round-trip that makes the WebContent process
//! software-re-render the page, not a window-server capture. No Screen
//! Recording permission is involved, and it works while the window is occluded,
//! behind other windows, or not frontmost. The cost is that
//! hardware-accelerated layers — WebGL, `<video>`, likely the browser panel's
//! screencast canvas — come back blank, and the image is web content, so the
//! traffic lights and the window's rounded corners are outside it.
//!
//! `evaluateJavaScript` is the other half, and it deliberately does not go
//! through the renderer. An event round-trip would need the renderer to be
//! healthy enough to answer — which is exactly the state you are trying to
//! inspect when you reach for this.

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

use crate::util;

/// Screenshots land here rather than in `fs_ops::IMAGES_DIR`, which
/// `cleanup_temp_dirs` wipes — and the point of this module is that another
/// instance is running. Same `{name}-{pid}` shape, so `sweep_orphan_dirs`
/// reaps it.
pub static DEVSHOTS_DIR: Lazy<PathBuf> =
    Lazy::new(|| util::temp_dir().join(format!("nyra-devshots-{}", std::process::id())));

/// Keep a session's worth, not a month's.
const MAX_SHOTS_KEPT: usize = 40;

/// The main thread may be the thing that is wedged, so nothing here waits
/// forever. Generous, because a suspended WebContent process can be slow to
/// answer before it answers correctly.
const CALL_TIMEOUT: Duration = Duration::from_secs(10);

/// Whether this instance answers the debug routes at all.
///
/// A runtime check rather than `#[cfg(debug_assertions)]` so the macOS code
/// below stays type-checked in release, and so the shipped build can be
/// inspected too when you need to ask whether release really looks like this.
pub fn dev_enabled() -> bool {
    cfg!(debug_assertions) || std::env::var("NYRA_DEVTOOLS").as_deref() == Ok("1")
}

#[derive(Debug, Serialize)]
pub struct Shot {
    pub path: String,
    pub width: i64,
    pub height: i64,
    pub bytes: usize,
}

/// Capture the window and write it out. Returns the path, because a retina PNG
/// is megabytes and a tool result is not the place for those bytes — the caller
/// renders it with `![](path)`, which `fs_read_image` already resolves.
pub async fn capture_to_file(max_width_px: Option<u32>) -> Result<Shot, String> {
    let (png, width, height) = capture(max_width_px).await?;
    util::ensure_dir(&DEVSHOTS_DIR).map_err(|e| e.to_string())?;
    let name = format!("{}-{}.png", util::now_ms(), util::rand_suffix(4));
    let path = DEVSHOTS_DIR.join(name);
    let bytes = png.len();
    tokio::fs::write(&path, png).await.map_err(|e| e.to_string())?;
    prune_shots().await;
    Ok(Shot {
        path: path.to_string_lossy().to_string(),
        width,
        height,
        bytes,
    })
}

/// Drop the oldest shots past the cap. Age-based, not shutdown-based — the
/// whole point is that this directory outlives the turn that wrote to it.
async fn prune_shots() {
    let Ok(mut entries) = std::fs::read_dir(&*DEVSHOTS_DIR) else {
        return;
    };
    let mut shots: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    while let Some(Ok(entry)) = entries.next() {
        let modified = entry.metadata().and_then(|m| m.modified());
        if let Ok(modified) = modified {
            shots.push((modified, entry.path()));
        }
    }
    if shots.len() <= MAX_SHOTS_KEPT {
        return;
    }
    shots.sort_by_key(|(t, _)| *t);
    for (_, path) in shots.iter().take(shots.len() - MAX_SHOTS_KEPT) {
        let _ = std::fs::remove_file(path);
    }
}

/// Evaluate an expression in the renderer and hand back the JSON of its value.
pub async fn eval_js(src: &str) -> Result<String, String> {
    eval(&wrap_expression(src)).await
}

/// Force a JSON string out of the page, so no arbitrary `NSObject` ever has to
/// be bridged back across.
///
/// Indirect `eval` for global scope, and an explicit word about promises:
/// `evaluateJavaScript` answers synchronously, an agent writes `await` by
/// reflex, and `JSON.stringify(promise)` is a silent `{}`.
fn wrap_expression(src: &str) -> String {
    let literal = serde_json::Value::String(src.to_owned()).to_string();
    format!(
        "(function(){{try{{\
           var v=(0,eval)({literal});\
           if(v&&typeof v.then==='function')return JSON.stringify({{ok:false,\
             error:'expression returned a Promise — eval here is synchronous. \
Stash the result on a global inside .then() and read it back in a second call.'}});\
           return JSON.stringify({{ok:true,value:v}});\
         }}catch(e){{return JSON.stringify({{ok:false,error:String((e&&e.stack)||e)}})}}}})()"
    )
}

// ---------------------------------------------------------------------------
// Finding this instance from outside it
// ---------------------------------------------------------------------------
//
// Discovery is `GET /health` across the port range the webhook server walks —
// a dead port refuses in microseconds, so the probe is self-healing and needs
// no pid liveness check. `/health` is unauthenticated and says who we are;
// the token that actually opens the debug routes lives only in a 0600 file
// beside it.

/// One secret per run. Loopback is not a boundary — every process on the
/// machine can reach a loopback port, and these routes run arbitrary JS.
static TOKEN: Lazy<String> = Lazy::new(|| util::rand_hex(16));

pub fn token() -> &'static str {
    &TOKEN
}

fn registry_dir() -> PathBuf {
    util::home_dir().join(".nyra").join("devtools")
}

fn registry_file(port: u16) -> PathBuf {
    registry_dir().join(format!("{port}.json"))
}

/// Publish the token for whoever is about to inspect us.
///
/// Keyed by port rather than pid because the port is what a client has in hand
/// after `/health` answers, and `tauri dev` restarts the binary — and so the
/// pid — on every Rust change while the port stays put.
pub fn register(port: u16) {
    if !dev_enabled() {
        return;
    }
    let dir = registry_dir();
    if let Err(e) = util::ensure_dir(&dir) {
        crate::log!("devtools", "could not create {}: {e}", dir.display());
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }

    let path = registry_file(port);
    let body = serde_json::json!({ "port": port, "pid": std::process::id(), "token": *TOKEN });
    if write_private(&path, body.to_string().as_bytes()).is_err() {
        crate::log!("devtools", "could not write {}", path.display());
        return;
    }
    crate::log!("devtools", "inspectable on port {port} — token at {}", path.display());
}

pub fn unregister(port: u16) {
    let _ = std::fs::remove_file(registry_file(port));
}

/// Owner-only from the moment it exists — this file is the whole authorisation
/// story for a route that evaluates arbitrary JS.
fn write_private(path: &PathBuf, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut opts = std::fs::OpenOptions::new();
    opts.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)?.write_all(bytes)
}

/// What `/health` says about us. No token here — the route is unauthenticated,
/// and it only needs to carry enough to tell two running instances apart.
pub fn identity(port: u16) -> serde_json::Value {
    serde_json::json!({
        "ok": true,
        "pid": std::process::id(),
        "port": port,
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "version": env!("CARGO_PKG_VERSION"),
        "exe": std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        "logPath": crate::logger::LOG_PATH,
        "devtools": dev_enabled(),
    })
}

// ---------------------------------------------------------------------------
// The renderer's console
// ---------------------------------------------------------------------------
//
// Nothing captured the renderer's console before this. Rather than a second ring
// buffer with a second endpoint to read it from, the lines go into the backend's
// existing batched log — so renderer and backend interleave in causal order in
// one file, and the record survives the renderer crashing outright, which an
// in-memory ring does not.
//
// Which levels arrive is the renderer's call (`devlog.ts`): warnings, errors and
// the three error events always; `log`/`info`/`debug` only in a dev build, where
// they are worth their volume.

#[derive(Debug, Deserialize)]
pub struct ConsoleLine {
    pub level: String,
    pub text: String,
}

/// Known levels only, so a tag can never carry anything but a word.
fn tag_for(level: &str) -> &'static str {
    match level {
        "error" => "renderer:error",
        "warn" => "renderer:warn",
        "info" => "renderer:info",
        "debug" => "renderer:debug",
        _ => "renderer:log",
    }
}

pub fn push_console_lines(lines: Vec<ConsoleLine>) {
    for line in lines {
        // One log line per console call, whatever the renderer sent: a raw
        // newline would both break `log-gaps.mjs`'s parse and let a line forge
        // a timestamp prefix for the one after it.
        let text = line.text.replace('\n', "\\n").replace('\r', "");
        crate::log!(tag_for(&line.level), "{text}");
    }
}

// ---------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------

#[cfg(target_os = "macos")]
async fn capture(max_width_px: Option<u32>) -> Result<(Vec<u8>, i64, i64), String> {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_foundation::{NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use std::cell::RefCell;

    let window = util::main_window().ok_or("no main window")?;
    let scale = window.scale_factor().unwrap_or(2.0);
    let (tx, rx) = tokio::sync::oneshot::channel();

    window
        .with_webview(move |webview| {
            // Borrowed, never `Retained::from_raw`: tauri hands out a
            // `Retained::into_raw` it never releases, so taking ownership here
            // would over-release and crash the app we are inspecting.
            let wk: &WKWebView = unsafe { &*(webview.inner() as *mut WKWebView) };

            // `snapshotWidth` is in points and the caller thinks in pixels.
            let config = max_width_px.map(|px| {
                let mtm = MainThreadMarker::new().expect("with_webview runs on the main thread");
                let config = unsafe { WKSnapshotConfiguration::new(mtm) };
                let points = (f64::from(px) / scale).max(1.0);
                unsafe { config.setSnapshotWidth(Some(&NSNumber::numberWithDouble(points))) };
                config
            });

            // A block is `Fn`, not `FnOnce`, so the sender has to be taken out
            // of somewhere. `RcBlock` and not `StackBlock` because the block
            // escapes and `oneshot::Sender` is not `Clone`.
            let slot = RefCell::new(Some(tx));
            let handler = RcBlock::new(move |image: *mut objc2_app_kit::NSImage, err: *mut NSError| {
                if let Some(tx) = slot.borrow_mut().take() {
                    // NSImage and NSData are !Send: encode here, on the main
                    // thread, and let only the bytes cross back.
                    let _ = tx.send(encode_png(image, err));
                }
            });

            // `None` means rect = bounds = the visible viewport at device
            // scale. There is no full-page option here; that is a PDF.
            unsafe { wk.takeSnapshotWithConfiguration_completionHandler(config.as_deref(), &handler) };
        })
        .map_err(|e| format!("could not reach the webview: {e}"))?;

    // `with_webview` off the main thread only *queues* the closure, so this
    // timeout covers both the dispatch and the snapshot itself. Without it, a
    // wedged main thread hangs the caller — and that is a state worth being
    // able to take a screenshot of.
    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("the snapshot handler was dropped without answering".into()),
        Err(_) => Err("snapshot timed out — the main thread or WebContent is wedged".into()),
    }
}

/// Runs on the main thread, inside the completion block.
#[cfg(target_os = "macos")]
fn encode_png(
    image: *mut objc2_app_kit::NSImage,
    err: *mut objc2_foundation::NSError,
) -> Result<(Vec<u8>, i64, i64), String> {
    use objc2::AnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    let Some(image) = (unsafe { image.as_ref() }) else {
        return Err(unsafe { err.as_ref() }
            .map(|e| e.localizedDescription().to_string())
            .unwrap_or_else(|| "takeSnapshot returned nothing and no error".into()));
    };

    // Null proposed rect and no reference context: hand back the backing
    // CGImage untouched. `image.size()` is points — sizing a bitmap from it is
    // the classic way to get a half-resolution screenshot on a retina display.
    let cg = unsafe { image.CGImageForProposedRect_context_hints(std::ptr::null_mut(), None, None) }
        .ok_or("the snapshot had no CGImage behind it")?;

    let rep = NSBitmapImageRep::initWithCGImage(NSBitmapImageRep::alloc(), &cg);
    // NSInteger is isize; the wire format is i64.
    let (width, height) = (rep.pixelsWide() as i64, rep.pixelsHigh() as i64);
    let data = unsafe {
        rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
    }
    .ok_or("PNG encoding failed")?;

    Ok((data.to_vec(), width, height))
}

#[cfg(target_os = "macos")]
async fn eval(script: &str) -> Result<String, String> {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_foundation::{NSError, NSString};
    use objc2_web_kit::WKWebView;
    use std::cell::RefCell;

    let window = util::main_window().ok_or("no main window")?;
    let script = script.to_owned();
    let (tx, rx) = tokio::sync::oneshot::channel();

    window
        .with_webview(move |webview| {
            let wk: &WKWebView = unsafe { &*(webview.inner() as *mut WKWebView) };
            let slot = RefCell::new(Some(tx));
            let handler = RcBlock::new(move |value: *mut AnyObject, err: *mut NSError| {
                let Some(tx) = slot.borrow_mut().take() else {
                    return;
                };
                // The wrapper always returns a string, so anything else means
                // the script never ran.
                let answer = unsafe { value.as_ref() }
                    .and_then(|v| v.downcast_ref::<NSString>())
                    .map(|s| Ok(s.to_string()))
                    .unwrap_or_else(|| {
                        Err(unsafe { err.as_ref() }
                            .map(|e| e.localizedDescription().to_string())
                            .unwrap_or_else(|| "the script returned nothing".into()))
                    });
                let _ = tx.send(answer);
            });
            let js = NSString::from_str(&script);
            // Note the `Option` here — `takeSnapshot` takes a bare reference.
            unsafe { wk.evaluateJavaScript_completionHandler(&js, Some(&handler)) };
        })
        .map_err(|e| format!("could not reach the webview: {e}"))?;

    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err("the eval handler was dropped without answering".into()),
        Err(_) => Err("eval timed out — the main thread is wedged".into()),
    }
}

// ---------------------------------------------------------------------------
// Everywhere else
// ---------------------------------------------------------------------------

#[cfg(not(target_os = "macos"))]
async fn capture(_max_width_px: Option<u32>) -> Result<(Vec<u8>, i64, i64), String> {
    Err("window capture is macOS-only — it goes through WKWebView".into())
}

#[cfg(not(target_os = "macos"))]
async fn eval(_script: &str) -> Result<String, String> {
    Err("eval is macOS-only — it goes through WKWebView".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devshots_dir_is_scoped_to_this_process() {
        let name = DEVSHOTS_DIR.file_name().unwrap().to_string_lossy().to_string();
        assert_eq!(name, format!("nyra-devshots-{}", std::process::id()));
    }

    #[test]
    fn wraps_an_expression_so_only_json_comes_back() {
        let wrapped = wrap_expression("document.title");
        assert!(wrapped.contains(r#"(0,eval)("document.title")"#));
        assert!(wrapped.contains("JSON.stringify({ok:true,value:v})"));
    }

    /// The source is user input arriving over a loopback POST; it has to reach
    /// the page as a *string literal*, not as spliced-in syntax.
    #[test]
    fn escapes_a_source_string_that_would_otherwise_break_out() {
        let wrapped = wrap_expression(r#"");alert("pwned"#);
        assert!(wrapped.contains(r#"(0,eval)("\");alert(\"pwned")"#));
    }

    #[test]
    fn folds_an_unknown_level_into_log_rather_than_echoing_it() {
        assert_eq!(tag_for("error"), "renderer:error");
        assert_eq!(tag_for("warn"), "renderer:warn");
        assert_eq!(tag_for("\n[pid:1] forged"), "renderer:log");
    }

    #[test]
    fn warns_instead_of_silently_stringifying_a_promise() {
        assert!(wrap_expression("fetch('/x')").contains("typeof v.then==='function'"));
    }
}
