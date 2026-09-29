//! Windows: UI Automation for the tree and actions, SendInput for keys and
//! clicks, Windows.Graphics.Capture (PrintWindow as the fallback) and WIC for
//! pictures, the shell's AppsFolder for names, ShellExecuteEx to open things.
//!
//! **One thread.** Every primitive runs on a dedicated MTA thread that owns the
//! UIA client, the WIC factory and the D3D device, and is per-monitor DPI aware
//! — so UIA rects, window frames, SendInput and captures all agree on physical
//! pixels. A `Handle` is a UIA element; MTA objects are agile, and the worker
//! keeps the MTA alive, so one may be cloned and dropped on any thread.
//!
//! **What Windows needs that macOS does not.** Input goes to whatever window is
//! in front, not to a pid, so every key and click first raises its window and
//! then checks it really is in front, and sends nothing when it is not —
//! keystrokes landing in Nyra or a terminal is the silent failure this refuses.
//! A window of a higher integrity level than ours drops input and patterns
//! without saying so (UIPI), so those come back `blocked` from `list_windows`
//! and are refused again by every primitive that touches one.
//!
//! **Names.** An `AppId` is the executable's canonical path. The name is the
//! Start menu's (AppsFolder), because an exe's own description says things like
//! "Notepad.exe" and "Windows Terminal Host". The same index is what resolves
//! "Settings" to SystemSettings.exe, so the blocklist can refuse it by id.

#![allow(non_snake_case)]

use once_cell::sync::Lazy;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use ::windows::core::{Interface, BOOL, BSTR, HSTRING, PCWSTR, PWSTR};
use ::windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession};
use ::windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
use ::windows::Graphics::DirectX::DirectXPixelFormat;
use ::windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE, HWND, LPARAM, POINT, RECT, SIZE, WPARAM};
use ::windows::Win32::Graphics::Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};
use ::windows::Win32::Graphics::Direct3D11 as d3d;
use ::windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS};
use ::windows::Win32::Graphics::Dxgi::IDXGIDevice;
use ::windows::Win32::Graphics::Gdi as gdi;
use ::windows::Win32::Graphics::Imaging as wic;
use ::windows::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TOKEN_MANDATORY_LABEL, TOKEN_QUERY};
use ::windows::Win32::Storage::FileSystem::{GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW};
use ::windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use ::windows::Win32::System::Com as com;
use ::windows::Win32::System::Registry as reg;
use ::windows::Win32::System::SystemInformation::GetTickCount;
use ::windows::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken, QueryFullProcessImageNameW,
    PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use ::windows::Win32::System::Variant::{VariantClear, VARIANT, VT_BOOL, VT_BSTR, VT_I4};
use ::windows::Win32::System::WinRT::Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess};
use ::windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
use ::windows::Win32::UI::Accessibility as ua;
use ::windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
use ::windows::Win32::UI::Input::KeyboardAndMouse as kbm;
use ::windows::Win32::UI::Shell as shell;
use ::windows::Win32::UI::Shell::PropertiesSystem::PSGetPropertyKeyFromName;
use ::windows::Win32::UI::WindowsAndMessaging as wm;

use super::safety::{Chord, Key};
use super::*;

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

/// What one primitive may take, end to end, before the engine hears "no answer".
/// UIA's own timeouts bound each cross-process call well inside this; it is the
/// backstop for a whole tree walk against an app that answers slowly.
const WORKER_WAIT: Duration = Duration::from_secs(20);
/// Per UIA call, the same bound macOS sets on its messaging timeout.
const UIA_TIMEOUT_MS: u32 = 1500;
/// The most text read out of one document for the snapshot.
const MAX_TEXT: i32 = 2000;

type Job = Box<dyn FnOnce(&Com) + Send>;

/// Everything that lives on the worker thread and nowhere else.
struct Com {
    uia: ua::IUIAutomation,
    /// Element and Children, over the ControlView: one round trip per parent.
    cache: ua::IUIAutomationCacheRequest,
    wic: wic::IWICImagingFactory,
    gpu: RefCell<Option<Gpu>>,
    apps: RefCell<Option<(Instant, Rc<Vec<Entry>>)>>,
    names: RefCell<HashMap<String, String>>,
    canon: RefCell<HashMap<String, String>>,
}

struct Gpu {
    device: d3d::ID3D11Device,
    context: d3d::ID3D11DeviceContext,
    winrt: IDirect3DDevice,
}

static WORKER: Lazy<std::result::Result<mpsc::Sender<Job>, String>> = Lazy::new(|| {
    let (tx, rx) = mpsc::channel::<Job>();
    let (ready_tx, ready_rx) = mpsc::channel::<std::result::Result<(), String>>();
    std::thread::Builder::new()
        .name("nyra-desktop-uia".into())
        .spawn(move || {
            let com = match Com::start() {
                Ok(c) => {
                    let _ = ready_tx.send(Ok(()));
                    c
                }
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                    return;
                }
            };
            for job in rx {
                // A panic in one call must not take every later call with it.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| job(&com)));
            }
        })
        .map_err(|e| e.to_string())?;
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| "UI Automation did not start".to_string())??;
    Ok(tx)
});

impl Com {
    fn start() -> std::result::Result<Com, String> {
        unsafe {
            com::CoInitializeEx(None, com::COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| format!("COM would not start: {e}"))?;
            SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

            let uia: ua::IUIAutomation = com::CoCreateInstance(&ua::CUIAutomation8, None, com::CLSCTX_INPROC_SERVER)
                .or_else(|_| com::CoCreateInstance(&ua::CUIAutomation, None, com::CLSCTX_INPROC_SERVER))
                .map_err(|e| format!("UI Automation is not available: {e}"))?;
            if let Ok(two) = uia.cast::<ua::IUIAutomation2>() {
                let _ = two.SetConnectionTimeout(UIA_TIMEOUT_MS);
                let _ = two.SetTransactionTimeout(UIA_TIMEOUT_MS);
            }

            let cache = uia.CreateCacheRequest().map_err(|e| e.to_string())?;
            for p in PROPS {
                let _ = cache.AddProperty(*p);
            }
            let _ = cache.SetTreeScope(ua::TreeScope(ua::TreeScope_Element.0 | ua::TreeScope_Children.0));
            if let Ok(view) = uia.ControlViewCondition() {
                let _ = cache.SetTreeFilter(&view);
            }

            let wic: wic::IWICImagingFactory =
                com::CoCreateInstance(&wic::CLSID_WICImagingFactory, None, com::CLSCTX_INPROC_SERVER)
                    .map_err(|e| format!("WIC is not available: {e}"))?;

            Ok(Com {
                uia,
                cache,
                wic,
                gpu: RefCell::new(None),
                apps: RefCell::new(None),
                names: RefCell::new(HashMap::new()),
                canon: RefCell::new(HashMap::new()),
            })
        }
    }
}

/// Run `f` on the worker and wait for it, within `WORKER_WAIT`.
fn on_worker<T: Send + 'static>(f: impl FnOnce(&Com) -> T + Send + 'static) -> Result<T> {
    let tx = WORKER.as_ref().map_err(|e| DesktopError::Failed(e.clone()))?;
    let (reply_tx, reply_rx) = mpsc::sync_channel(1);
    tx.send(Box::new(move |c: &Com| {
        let _ = reply_tx.send(f(c));
    }))
    .map_err(|_| DesktopError::Failed("the desktop control thread has stopped".into()))?;
    reply_rx.recv_timeout(WORKER_WAIT).map_err(|e| match e {
        mpsc::RecvTimeoutError::Timeout => DesktopError::Failed("Windows did not answer in time".into()),
        mpsc::RecvTimeoutError::Disconnected => DesktopError::Failed("that call crashed inside desktop control".into()),
    })
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/// A kernel handle, closed on drop.
struct Owned(HANDLE);

impl Drop for Owned {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

/// A string the shell allocated, freed after reading.
unsafe fn take_pwstr(p: PWSTR) -> String {
    let s = p.to_string().unwrap_or_default();
    com::CoTaskMemFree(Some(p.0 as *const _));
    s
}

fn hwnd_of(key: &WindowKey) -> Option<HWND> {
    let hex = key.0.strip_prefix("hwnd:")?;
    let n = isize::from_str_radix(hex, 16).ok()?;
    Some(HWND(n as *mut _))
}

fn key_of(hwnd: HWND) -> WindowKey {
    WindowKey(format!("hwnd:{:x}", hwnd.0 as isize))
}

fn rect_of(r: RECT) -> Rect {
    Rect { x: r.left as f64, y: r.top as f64, w: (r.right - r.left) as f64, h: (r.bottom - r.top) as f64 }
}

/// What a UIA or COM failure means, in the engine's words.
fn uia_error(e: &::windows::core::Error) -> DesktopError {
    match e.code().0 as u32 {
        0x8004_0201 => DesktopError::Gone,                                               // UIA_E_ELEMENTNOTAVAILABLE
        0x8004_0200 => DesktopError::Failed("it is disabled".into()),                    // UIA_E_ELEMENTNOTENABLED
        0x8004_0204 => DesktopError::Unsupported("the element does not offer that".into()), // UIA_E_NOTSUPPORTED
        0x8013_1505 => DesktopError::Failed("the app did not answer in time".into()),    // UIA_E_TIMEOUT
        0x8013_1509 => DesktopError::Failed("the app refused that just now".into()),     // UIA_E_INVALIDOPERATION
        0x8007_0005 => DesktopError::Blocked(elevated()),                                // E_ACCESSDENIED
        _ => DesktopError::Failed(format!("the app refused ({})", e.message())),
    }
}

fn is_timeout(e: &::windows::core::Error) -> bool {
    e.code().0 as u32 == 0x8013_1505
}

// ---------------------------------------------------------------------------
// Processes and integrity
// ---------------------------------------------------------------------------

fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let h = Owned(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?);
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        QueryFullProcessImageNameW(h.0, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).ok()?;
        Some(String::from_utf16_lossy(&buf[..len as usize]))
    }
}

/// The mandatory-label RID of a process's token: 0x2000 medium, 0x3000 high.
unsafe fn token_integrity(process: HANDLE) -> Option<u32> {
    let mut token = HANDLE::default();
    OpenProcessToken(process, TOKEN_QUERY, &mut token).ok()?;
    let token = Owned(token);
    let mut len = 0u32;
    let _ = GetTokenInformation(token.0, TokenIntegrityLevel, None, 0, &mut len);
    if len == 0 {
        return None;
    }
    let mut buf = vec![0u8; len as usize];
    GetTokenInformation(token.0, TokenIntegrityLevel, Some(buf.as_mut_ptr() as *mut _), len, &mut len).ok()?;
    let label = &*(buf.as_ptr() as *const TOKEN_MANDATORY_LABEL);
    let sid = label.Label.Sid;
    let count = *GetSidSubAuthorityCount(sid);
    if count == 0 {
        return None;
    }
    Some(*GetSidSubAuthority(sid, (count - 1) as u32))
}

fn integrity(pid: u32) -> Option<u32> {
    unsafe {
        let h = Owned(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?);
        token_integrity(h.0)
    }
}

static OWN_INTEGRITY: Lazy<Option<u32>> = Lazy::new(|| unsafe { token_integrity(GetCurrentProcess()) });

fn elevated() -> Blocked {
    Blocked {
        reason: "that window runs as administrator and Nyra does not, so Windows would silently drop every key, click and action Nyra sent it".into(),
        fix: None,
    }
}

/// Why these processes' windows cannot be driven, if they cannot. A level we
/// cannot read is refused too: that is what an elevated process looks like
/// from below, and refusing is the safe mistake.
fn integrity_block(pids: &[u32]) -> Option<Blocked> {
    let ours = (*OWN_INTEGRITY)?;
    for pid in pids {
        match integrity(*pid) {
            Some(level) if level <= ours => {}
            Some(_) => return Some(elevated()),
            None => {
                return Some(Blocked {
                    reason: "Windows won't let Nyra inspect the process behind that window, which usually means it runs as administrator".into(),
                    fix: None,
                })
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Top-level windows
// ---------------------------------------------------------------------------

/// A top-level window someone could switch to, and whose it is.
#[derive(Clone)]
struct Top {
    hwnd: HWND,
    /// The process whose UI this is. For a frame hosted by
    /// ApplicationFrameHost, that is the app inside it, not the host.
    pid: u32,
    /// Every process that draws part of it, for the integrity check.
    pids: Vec<u32>,
    title: String,
}

unsafe extern "system" fn collect_hwnd(hwnd: HWND, lparam: LPARAM) -> BOOL {
    let v = &mut *(lparam.0 as *mut Vec<isize>);
    v.push(hwnd.0 as isize);
    true.into()
}

fn class_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { wm::GetClassNameW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn title_of(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { wm::GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

fn pid_of(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { wm::GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

fn cloaked(hwnd: HWND) -> bool {
    let mut v = 0u32;
    let ok = unsafe { DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut v as *mut u32 as *mut _, 4) };
    ok.is_ok() && v != 0
}

/// The part of the window you can see: `GetWindowRect` includes the invisible
/// resize border, about 7px each side on Windows 10 and 11.
fn frame_of(hwnd: HWND) -> Option<Rect> {
    let mut r = RECT::default();
    let ok = unsafe {
        DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, &mut r as *mut RECT as *mut _, std::mem::size_of::<RECT>() as u32)
    };
    if ok.is_err() {
        unsafe { wm::GetWindowRect(hwnd, &mut r).ok()? };
    }
    Some(rect_of(r))
}

const SHELL_CLASSES: &[&str] = &["Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd"];

/// The windows Alt-Tab would offer, top of the z-order first.
fn top_windows() -> Vec<Top> {
    let mut all: Vec<isize> = Vec::new();
    unsafe {
        let _ = wm::EnumWindows(Some(collect_hwnd), LPARAM(&mut all as *mut Vec<isize> as isize));
    }
    let mut out = Vec::new();
    for raw in all {
        let hwnd = HWND(raw as *mut _);
        unsafe {
            if !wm::IsWindowVisible(hwnd).as_bool() || cloaked(hwnd) {
                continue;
            }
            let ex = wm::GetWindowLongPtrW(hwnd, wm::GWL_EXSTYLE) as u32;
            let app_window = ex & wm::WS_EX_APPWINDOW.0 != 0;
            if ex & wm::WS_EX_TOOLWINDOW.0 != 0 && !app_window {
                continue;
            }
            let owner = wm::GetWindow(hwnd, wm::GW_OWNER).unwrap_or_default();
            if !owner.is_invalid() && !app_window {
                continue;
            }
        }
        let title = title_of(hwnd);
        let class = class_of(hwnd);
        if title.is_empty() || SHELL_CLASSES.contains(&class.as_str()) {
            continue;
        }
        let frame_pid = pid_of(hwnd);
        let mut pids = vec![frame_pid];
        let pid = if class == "ApplicationFrameWindow" {
            let core = unsafe { wm::FindWindowExW(Some(hwnd), None, ::windows::core::w!("Windows.UI.Core.CoreWindow"), PCWSTR::null()) };
            match core {
                Ok(c) if !c.is_invalid() => {
                    let p = pid_of(c);
                    pids.push(p);
                    p
                }
                // A frame with nothing in it yet (or a suspended app): no one's.
                _ => continue,
            }
        } else {
            frame_pid
        };
        out.push(Top { hwnd, pid, pids, title });
    }
    out
}

fn windows_for(pid: u32) -> Vec<Top> {
    top_windows().into_iter().filter(|t| t.pid == pid).collect()
}

/// A window by key, checked to still be this app's: an HWND is reused.
fn find_window(app: &AppInfo, key: &WindowKey) -> Result<Top> {
    let hwnd = hwnd_of(key).ok_or(DesktopError::Gone)?;
    windows_for(app.pid).into_iter().find(|t| t.hwnd == hwnd).ok_or(DesktopError::Gone)
}

/// The window keys and clicks go to when the engine says "menu".
fn main_window(app: &AppInfo) -> Result<Top> {
    let fg = unsafe { wm::GetForegroundWindow() };
    let windows = windows_for(app.pid);
    windows
        .iter()
        .find(|t| t.hwnd == fg)
        .or_else(|| windows.iter().find(|t| unsafe { !wm::IsIconic(t.hwnd).as_bool() }))
        .cloned()
        .ok_or_else(|| DesktopError::Failed(format!("{} has no window to send that to", app.name)))
}

fn guard(top: &Top) -> Result<()> {
    match integrity_block(&top.pids) {
        Some(b) => Err(DesktopError::Blocked(b)),
        None => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// The apps index: AppsFolder names and the executables behind them
// ---------------------------------------------------------------------------

/// One entry of the Start menu's app list.
struct Entry {
    name: String,
    /// What `shell:AppsFolder\…` launches it by: an AUMID, or a shortcut's.
    aumid: String,
    exe: Option<String>,
    /// The exe is the app's own, not a shell folder mapped onto explorer.exe;
    /// only these name a running process.
    direct: bool,
}

const INDEX_TTL: Duration = Duration::from_secs(60);
const FILE_EXPLORER: &str = "Microsoft.Windows.Explorer";

impl Com {
    fn canonical(&self, path: &str) -> String {
        if let Some(hit) = self.canon.borrow().get(path) {
            return hit.clone();
        }
        let c = dunce::canonicalize(path).map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| path.to_string());
        self.canon.borrow_mut().insert(path.to_string(), c.clone());
        c
    }

    fn index(&self) -> Rc<Vec<Entry>> {
        if let Some((at, idx)) = &*self.apps.borrow() {
            if at.elapsed() < INDEX_TTL {
                return idx.clone();
            }
        }
        let idx = Rc::new(self.build_index());
        *self.apps.borrow_mut() = Some((Instant::now(), idx.clone()));
        idx
    }

    fn build_index(&self) -> Vec<Entry> {
        let key = |name: &str| unsafe {
            let mut k = ::windows::Win32::Foundation::PROPERTYKEY::default();
            PSGetPropertyKeyFromName(&HSTRING::from(name), &mut k).ok().map(|_| k)
        };
        let (Some(k_id), Some(k_install), Some(k_link)) = (
            key("System.AppUserModel.ID"),
            key("System.AppUserModel.PackageInstallPath"),
            key("System.Link.TargetParsingPath"),
        ) else {
            return Vec::new();
        };
        let get = |item: &shell::IShellItem2, k: &::windows::Win32::Foundation::PROPERTYKEY| unsafe {
            item.GetString(k).ok().map(|p| take_pwstr(p)).filter(|s| !s.is_empty())
        };

        let mut out = Vec::new();
        unsafe {
            let Ok(folder) = shell::SHCreateItemFromParsingName::<_, _, shell::IShellItem>(::windows::core::w!("shell:AppsFolder"), None) else {
                return out;
            };
            let Ok(items) = folder.BindToHandler::<_, shell::IEnumShellItems>(None, &shell::BHID_EnumItems) else {
                return out;
            };
            loop {
                let mut one: [Option<shell::IShellItem>; 1] = [None];
                let mut got = 0u32;
                if items.Next(&mut one, Some(&mut got)).is_err() || got == 0 {
                    break;
                }
                let Some(item) = one[0].take() else { break };
                let Ok(item) = item.cast::<shell::IShellItem2>() else { continue };
                let Ok(name) = item.GetDisplayName(shell::SIGDN_NORMALDISPLAY).map(|p| take_pwstr(p)) else { continue };
                let Some(aumid) = get(&item, &k_id) else { continue };

                let (exe, direct) = if let Some(install) = get(&item, &k_install) {
                    let app_id = aumid.rsplit('!').next().unwrap_or("");
                    let exe = std::fs::read_to_string(format!("{install}\\AppxManifest.xml"))
                        .ok()
                        .and_then(|xml| manifest_executable(&xml, app_id))
                        .map(|rel| self.canonical(&format!("{install}\\{rel}")));
                    (exe, true)
                } else if let Some(link) = get(&item, &k_link) {
                    link_exe(&link).map(|(p, d)| (Some(self.canonical(&p)), d)).unwrap_or((None, false))
                } else {
                    // A desktop app with no shortcut: its AUMID is its path,
                    // sometimes as {known folder}\rest.
                    match known_folder_path(&aumid) {
                        Some(p) if p.to_ascii_lowercase().ends_with(".exe") => (Some(self.canonical(&p)), true),
                        _ => (None, false),
                    }
                };
                // Every shortcut to explorer.exe is some folder ("Windows Software
                // Development Kit"); only File Explorer's own entry names it.
                let direct = match &exe {
                    Some(x) if stem(x).eq_ignore_ascii_case("explorer") => aumid.eq_ignore_ascii_case(FILE_EXPLORER),
                    _ => direct,
                };
                out.push(Entry { name, aumid, exe, direct });
            }
        }
        out
    }

    /// What to call a running executable.
    fn name_for(&self, exe: &str) -> String {
        if let Some(hit) = self.names.borrow().get(exe) {
            return hit.clone();
        }
        // Only when the Start menu agrees on one name: a folder shortcut that
        // targets explorer.exe, or a browser profile, is not the app's name.
        let mut names: Vec<String> = self
            .index()
            .iter()
            .filter(|e| e.direct && e.exe.as_deref().is_some_and(|x| x.eq_ignore_ascii_case(exe)))
            .map(|e| e.name.clone())
            .collect();
        names.sort();
        names.dedup();
        let from_index = (names.len() == 1).then(|| names.remove(0));
        let name = from_index
            .or_else(|| file_description(exe).filter(|d| !d.to_ascii_lowercase().ends_with(".exe")))
            .unwrap_or_else(|| stem(exe));
        self.names.borrow_mut().insert(exe.to_string(), name.clone());
        name
    }

    /// An app by what someone would call it, running or not.
    fn resolve(&self, query: &str) -> Option<Resolved> {
        let q = query.trim();
        if q.is_empty() {
            return None;
        }
        if (q.contains('\\') || q.contains(':')) && std::path::Path::new(q).is_file() {
            let exe = self.canonical(q);
            return Some(Resolved { name: self.name_for(&exe), launch: exe.clone(), exe });
        }
        let idx = self.index();
        let wanted = squash(q);
        let hit = idx
            .iter()
            .filter(|e| e.exe.is_some())
            .find(|e| e.name.eq_ignore_ascii_case(q))
            .or_else(|| {
                idx.iter().filter(|e| e.exe.is_some()).find(|e| {
                    squash(&e.name) == wanted || e.exe.as_deref().is_some_and(|x| e.direct && squash(&stem(x)) == wanted)
                })
            });
        if let Some(e) = hit {
            let exe = e.exe.clone().expect("filtered");
            return Some(Resolved { name: e.name.clone(), exe, launch: format!("shell:AppsFolder\\{}", e.aumid) });
        }
        let file = if q.to_ascii_lowercase().ends_with(".exe") { q.to_string() } else { format!("{q}.exe") };
        let found = app_paths(&file).or_else(|| {
            crate::platform::which(&file)
                .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("exe")))
                .map(|p| p.to_string_lossy().into_owned())
        })?;
        let exe = self.canonical(&found);
        Some(Resolved { name: self.name_for(&exe), launch: exe.clone(), exe })
    }
}

struct Resolved {
    exe: String,
    name: String,
    /// What ShellExecuteEx is handed.
    launch: String,
}

/// Lowercase, no spaces, no `.exe`: "Windows Terminal" and WindowsTerminal.exe
/// are the same app.
fn squash(s: &str) -> String {
    let s: String = s.chars().filter(|c| !c.is_whitespace()).collect::<String>().to_lowercase();
    s.strip_suffix(".exe").map(str::to_string).unwrap_or(s)
}

fn stem(path: &str) -> String {
    std::path::Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// The `Executable` of the `<Application>` whose `Id` is `app_id`.
fn manifest_executable(xml: &str, app_id: &str) -> Option<String> {
    static APP: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"(?s)<Application\s[^>]*>").unwrap());
    static ID: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r#"\sId="([^"]*)""#).unwrap());
    static EXE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r#"\sExecutable="([^"]*)""#).unwrap());
    APP.find_iter(xml).find_map(|m| {
        let tag = m.as_str();
        let id = ID.captures(tag)?.get(1)?.as_str();
        if !id.eq_ignore_ascii_case(app_id) {
            return None;
        }
        let exe = EXE.captures(tag)?.get(1)?.as_str();
        (!exe.contains('$')).then(|| exe.replace('/', "\\"))
    })
}

/// A shortcut's target as an executable, and whether it is the app's own.
fn link_exe(target: &str) -> Option<(String, bool)> {
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
    let lower = target.to_ascii_lowercase();
    if lower.ends_with(".exe") {
        return Some((target.to_string(), true));
    }
    // File Explorer, Control Panel and friends are shell folders explorer.exe shows.
    if target.starts_with("::{") {
        return Some((format!("{windir}\\explorer.exe"), false));
    }
    if lower.ends_with(".msc") {
        return Some((format!("{windir}\\System32\\mmc.exe"), false));
    }
    None
}

/// `{GUID}\rest` with the known folder filled in; anything else unchanged.
fn known_folder_path(s: &str) -> Option<String> {
    let Some(rest) = s.strip_prefix('{') else {
        return Some(s.to_string());
    };
    let (guid, tail) = rest.split_once('}')?;
    let n = u128::from_str_radix(&guid.replace('-', ""), 16).ok()?;
    let id = ::windows::core::GUID::from_u128(n);
    let base = unsafe { take_pwstr(shell::SHGetKnownFolderPath(&id, shell::KNOWN_FOLDER_FLAG(0), None).ok()?) };
    Some(format!("{base}{tail}"))
}

fn app_paths(file: &str) -> Option<String> {
    let sub = HSTRING::from(format!("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\{file}"));
    for root in [reg::HKEY_CURRENT_USER, reg::HKEY_LOCAL_MACHINE] {
        let mut buf = [0u16; 1024];
        let mut size = (buf.len() * 2) as u32;
        let r = unsafe {
            reg::RegGetValueW(
                root,
                &sub,
                PCWSTR::null(),
                reg::RRF_RT_REG_SZ | reg::RRF_RT_REG_EXPAND_SZ,
                None,
                Some(buf.as_mut_ptr() as *mut _),
                Some(&mut size),
            )
        };
        if r.is_ok() {
            let n = (size as usize / 2).saturating_sub(1);
            let s = String::from_utf16_lossy(&buf[..n]).trim().trim_matches('"').to_string();
            if std::path::Path::new(&s).is_file() {
                return Some(s);
            }
        }
    }
    None
}

fn file_description(path: &str) -> Option<String> {
    unsafe {
        let p = HSTRING::from(path);
        let size = GetFileVersionInfoSizeW(&p, None);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        GetFileVersionInfoW(&p, None, size, buf.as_mut_ptr() as *mut _).ok()?;
        let mut ptr = std::ptr::null_mut();
        let mut len = 0u32;
        if !VerQueryValueW(buf.as_ptr() as *const _, ::windows::core::w!("\\VarFileInfo\\Translation"), &mut ptr, &mut len).as_bool() || len < 4 {
            return None;
        }
        let lang = *(ptr as *const u16);
        let cp = *(ptr as *const u16).add(1);
        let q = HSTRING::from(format!("\\StringFileInfo\\{lang:04x}{cp:04x}\\FileDescription"));
        if !VerQueryValueW(buf.as_ptr() as *const _, &q, &mut ptr, &mut len).as_bool() || len == 0 {
            return None;
        }
        let units = std::slice::from_raw_parts(ptr as *const u16, len as usize);
        let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
        let s = String::from_utf16_lossy(&units[..end]).trim().to_string();
        (!s.is_empty()).then_some(s)
    }
}

// ---------------------------------------------------------------------------
// Opening things
// ---------------------------------------------------------------------------

/// Opening one of these runs it. An app is opened by name, so the engine can
/// check it against the blocklist and ask the user; a path would skip both.
const RUNS_CODE: &[&str] = &[
    "exe", "com", "bat", "cmd", "lnk", "url", "pif", "scr", "cpl", "msc", "msi", "msix", "msixbundle", "appx",
    "appxbundle", "appref-ms", "application", "hta", "js", "jse", "vbs", "vbe", "wsf", "wsh", "ps1", "psm1", "reg",
    "jar",
];

/// Other schemes are protocol handlers that start apps — `ms-settings:` is
/// Settings — and nothing here can check which.
const URL_SCHEMES: &[&str] = &["http", "https", "mailto", "tel"];

fn runs_code(path: &str) -> bool {
    std::path::Path::new(path)
        .extension()
        .map(|x| x.to_string_lossy().to_ascii_lowercase())
        .is_some_and(|x| RUNS_CODE.contains(&x.as_str()))
}

fn allowed_url(url: &str) -> bool {
    url.split_once(':').is_some_and(|(scheme, _)| URL_SCHEMES.iter().any(|s| s.eq_ignore_ascii_case(scheme)))
}

/// ShellExecuteEx on a short-lived STA thread: some shell handlers want one,
/// and none of this touches UIA.
fn shell_open(file: &str) -> Result<()> {
    let file = file.to_string();
    let joined = std::thread::spawn(move || unsafe {
        let _ = com::CoInitializeEx(None, com::COINIT_APARTMENTTHREADED | com::COINIT_DISABLE_OLE1DDE);
        let f = HSTRING::from(file.as_str());
        let mut info = shell::SHELLEXECUTEINFOW {
            cbSize: std::mem::size_of::<shell::SHELLEXECUTEINFOW>() as u32,
            fMask: shell::SEE_MASK_FLAG_NO_UI | shell::SEE_MASK_NOASYNC,
            lpFile: PCWSTR(f.as_ptr()),
            nShow: wm::SW_SHOWNORMAL.0,
            ..Default::default()
        };
        let r = shell::ShellExecuteExW(&mut info).map_err(|e| e.message());
        com::CoUninitialize();
        r
    })
    .join();
    match joined {
        Ok(Ok(())) => Ok(()),
        Ok(Err(why)) => Err(DesktopError::Failed(format!("Windows would not open it: {why}"))),
        Err(_) => Err(DesktopError::Failed("opening it crashed".into())),
    }
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

/// Cached per element, in one round trip per parent.
const PROPS: &[ua::UIA_PROPERTY_ID] = &[
    ua::UIA_ControlTypePropertyId,
    ua::UIA_NamePropertyId,
    ua::UIA_BoundingRectanglePropertyId,
    ua::UIA_IsEnabledPropertyId,
    ua::UIA_HasKeyboardFocusPropertyId,
    ua::UIA_IsOffscreenPropertyId,
    ua::UIA_IsPasswordPropertyId,
    ua::UIA_AutomationIdPropertyId,
    ua::UIA_IsValuePatternAvailablePropertyId,
    ua::UIA_ValueValuePropertyId,
    ua::UIA_ValueIsReadOnlyPropertyId,
    ua::UIA_IsTextPatternAvailablePropertyId,
    ua::UIA_IsTextEditPatternAvailablePropertyId,
    ua::UIA_IsTogglePatternAvailablePropertyId,
    ua::UIA_ToggleToggleStatePropertyId,
    ua::UIA_IsSelectionItemPatternAvailablePropertyId,
    ua::UIA_SelectionItemIsSelectedPropertyId,
];

enum Var {
    Str(String),
    Bool(bool),
    I4(i32),
    None,
}

fn cached(el: &ua::IUIAutomationElement, id: ua::UIA_PROPERTY_ID) -> Var {
    unsafe {
        let Ok(mut v) = el.GetCachedPropertyValue(id) else { return Var::None };
        let out = read_variant(&v);
        let _ = VariantClear(&mut v);
        out
    }
}

unsafe fn read_variant(v: &VARIANT) -> Var {
    let inner = &v.Anonymous.Anonymous;
    match inner.vt {
        VT_BSTR => Var::Str(inner.Anonymous.bstrVal.to_string()),
        VT_BOOL => Var::Bool(inner.Anonymous.boolVal.as_bool()),
        VT_I4 => Var::I4(inner.Anonymous.lVal),
        _ => Var::None,
    }
}

fn cached_bool(el: &ua::IUIAutomationElement, id: ua::UIA_PROPERTY_ID) -> Option<bool> {
    match cached(el, id) {
        Var::Bool(b) => Some(b),
        _ => None,
    }
}

fn cached_str(el: &ua::IUIAutomationElement, id: ua::UIA_PROPERTY_ID) -> Option<String> {
    match cached(el, id) {
        Var::Str(s) => Some(s),
        _ => None,
    }
}

/// A control type in neutral words. `None` is window furniture — present in
/// every document window and pressed by nobody who is not dragging it.
fn role_of(ct: ua::UIA_CONTROLTYPE_ID) -> Option<Role> {
    Some(match ct {
        ua::UIA_ScrollBarControlTypeId | ua::UIA_ThumbControlTypeId | ua::UIA_SeparatorControlTypeId => return None,
        ua::UIA_ButtonControlTypeId => Role::Button,
        ua::UIA_EditControlTypeId => Role::TextField,
        // Settled against editability in `walk`: a web page is a document too.
        ua::UIA_DocumentControlTypeId => Role::TextArea,
        ua::UIA_CheckBoxControlTypeId => Role::Checkbox,
        ua::UIA_RadioButtonControlTypeId => Role::Radio,
        ua::UIA_MenuItemControlTypeId => Role::MenuItem,
        ua::UIA_SplitButtonControlTypeId | ua::UIA_ComboBoxControlTypeId => Role::MenuButton,
        ua::UIA_HyperlinkControlTypeId => Role::Link,
        ua::UIA_TextControlTypeId => Role::Text,
        ua::UIA_ImageControlTypeId => Role::Image,
        ua::UIA_GroupControlTypeId
        | ua::UIA_PaneControlTypeId
        | ua::UIA_CustomControlTypeId
        | ua::UIA_TabControlTypeId
        | ua::UIA_MenuBarControlTypeId
        | ua::UIA_MenuControlTypeId
        | ua::UIA_TitleBarControlTypeId
        | ua::UIA_SemanticZoomControlTypeId
        | ua::UIA_AppBarControlTypeId => Role::Group,
        ua::UIA_ListControlTypeId | ua::UIA_TreeControlTypeId | ua::UIA_DataGridControlTypeId | ua::UIA_TableControlTypeId => {
            Role::List
        }
        ua::UIA_ListItemControlTypeId | ua::UIA_TreeItemControlTypeId | ua::UIA_DataItemControlTypeId => Role::Row,
        ua::UIA_TabItemControlTypeId => Role::Tab,
        ua::UIA_ToolBarControlTypeId => Role::Toolbar,
        ua::UIA_SliderControlTypeId => Role::Slider,
        ua::UIA_WindowControlTypeId => Role::Other("window".into()),
        // Fixed words, never LocalizedControlType: that one is localized.
        other => Role::Other(
            match other {
                ua::UIA_CalendarControlTypeId => "calendar",
                ua::UIA_ProgressBarControlTypeId => "progress bar",
                ua::UIA_SpinnerControlTypeId => "spinner",
                ua::UIA_StatusBarControlTypeId => "status bar",
                ua::UIA_ToolTipControlTypeId => "tooltip",
                ua::UIA_HeaderControlTypeId => "header",
                ua::UIA_HeaderItemControlTypeId => "header item",
                _ => "element",
            }
            .into(),
        ),
    })
}

/// Types whose children are never worth a round trip.
fn is_leafy(ct: ua::UIA_CONTROLTYPE_ID) -> bool {
    matches!(ct, ua::UIA_TextControlTypeId | ua::UIA_ImageControlTypeId | ua::UIA_ProgressBarControlTypeId)
}

fn children_of(el: &ua::IUIAutomationElement) -> Vec<ua::IUIAutomationElement> {
    unsafe {
        let Ok(arr) = el.GetCachedChildren() else { return Vec::new() };
        let n = arr.Length().unwrap_or(0);
        (0..n).filter_map(|i| arr.GetElement(i).ok()).collect()
    }
}

fn document_text(el: &ua::IUIAutomationElement) -> Option<String> {
    unsafe {
        let text: ua::IUIAutomationTextPattern = el.GetCurrentPatternAs(ua::UIA_TextPatternId).ok()?;
        let s = text.DocumentRange().ok()?.GetText(MAX_TEXT).ok()?.to_string();
        (!s.is_empty()).then_some(s)
    }
}

/// `el` has itself and its children cached. `None` for furniture.
fn walk(
    com: &Com,
    el: &ua::IUIAutomationElement,
    hwnd: HWND,
    depth: usize,
    limits: Limits,
    count: &mut usize,
) -> Option<RawElement<Handle>> {
    let ct = unsafe { el.CachedControlType() }.unwrap_or_default();
    let mut role = role_of(ct)?;
    let label = unsafe { el.CachedName() }.map(|s| s.to_string()).unwrap_or_default();
    let secure = cached_bool(el, ua::UIA_IsPasswordPropertyId).unwrap_or(false);
    let has_value = cached_bool(el, ua::UIA_IsValuePatternAvailablePropertyId).unwrap_or(false);
    let read_only = cached_bool(el, ua::UIA_ValueIsReadOnlyPropertyId).unwrap_or(true);

    if ct == ua::UIA_DocumentControlTypeId {
        let editable = (has_value && !read_only) || cached_bool(el, ua::UIA_IsTextEditPatternAvailablePropertyId).unwrap_or(false);
        if !editable {
            role = Role::Group;
        }
    }

    // A pattern's properties read as its defaults where it is missing — every
    // plain button would be a "mixed" toggle — so each is gated on its pattern.
    let toggles = cached_bool(el, ua::UIA_IsTogglePatternAvailablePropertyId).unwrap_or(false);
    let selects = cached_bool(el, ua::UIA_IsSelectionItemPatternAvailablePropertyId).unwrap_or(false);
    let mut value = if has_value { cached_str(el, ua::UIA_ValueValuePropertyId).filter(|v| !v.is_empty()) } else { None };
    if value.is_none() {
        value = match role {
            Role::Checkbox | Role::Button if toggles => match cached(el, ua::UIA_ToggleToggleStatePropertyId) {
                Var::I4(0) => Some("off".into()),
                Var::I4(1) => Some("on".into()),
                Var::I4(2) => Some("mixed".into()),
                _ => None,
            },
            Role::Radio if selects => cached_bool(el, ua::UIA_SelectionItemIsSelectedPropertyId).map(|b| if b { "on" } else { "off" }.into()),
            Role::Tab | Role::Row if selects => cached_bool(el, ua::UIA_SelectionItemIsSelectedPropertyId).and_then(|b| b.then(|| "selected".into())),
            Role::TextArea | Role::TextField if !secure && cached_bool(el, ua::UIA_IsTextPatternAvailablePropertyId).unwrap_or(false) => {
                document_text(el)
            }
            _ => None,
        };
    }
    if secure {
        value = None;
    }

    let frame = unsafe { el.CachedBoundingRectangle() }.ok().map(rect_of);

    let kids = children_of(el);
    let mut children = Vec::new();
    let mut children_truncated = false;
    if depth >= limits.max_depth {
        children_truncated = !kids.is_empty();
    } else {
        for kid in kids {
            if *count >= limits.max_nodes {
                children_truncated = true;
                break;
            }
            *count += 1;
            let kid_ct = unsafe { kid.CachedControlType() }.unwrap_or_default();
            let kid = if is_leafy(kid_ct) { kid } else { unsafe { kid.BuildUpdatedCache(&com.cache) }.unwrap_or(kid) };
            children.extend(walk(com, &kid, hwnd, depth + 1, limits, count));
        }
    }

    Some(RawElement {
        handle: Handle { el: Agile(el.clone()), hwnd: hwnd.0 as isize },
        role,
        label,
        value,
        frame,
        enabled: unsafe { el.CachedIsEnabled() }.map(|b| b.as_bool()).unwrap_or(true),
        focused: unsafe { el.CachedHasKeyboardFocus() }.map(|b| b.as_bool()).unwrap_or(false),
        offscreen: unsafe { el.CachedIsOffscreen() }.ok().map(|b| b.as_bool()),
        secure,
        children,
        children_truncated,
    })
}

/// The first menu bar under `el` that is the app's, not the title bar's system
/// menu, looking a few levels down and no further.
fn find_menu_bar(com: &Com, el: &ua::IUIAutomationElement, depth: usize, budget: &mut usize) -> Option<ua::IUIAutomationElement> {
    for kid in children_of(el) {
        if *budget == 0 {
            return None;
        }
        *budget -= 1;
        let ct = unsafe { kid.CachedControlType() }.unwrap_or_default();
        let id = cached_str(&kid, ua::UIA_AutomationIdPropertyId).unwrap_or_default();
        if ct == ua::UIA_MenuBarControlTypeId && id != "SystemMenuBar" {
            return unsafe { kid.BuildUpdatedCache(&com.cache) }.ok();
        }
        if depth < 4 && !is_leafy(ct) {
            if let Ok(full) = unsafe { kid.BuildUpdatedCache(&com.cache) } {
                if let Some(found) = find_menu_bar(com, &full, depth + 1, budget) {
                    return Some(found);
                }
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

fn is_front(hwnd: HWND) -> bool {
    let fg = unsafe { wm::GetForegroundWindow() };
    fg == hwnd || unsafe { wm::GetAncestor(fg, wm::GA_ROOT) } == hwnd
}

fn wait_front(hwnd: HWND, within: Duration) -> bool {
    let deadline = Instant::now() + within;
    loop {
        if is_front(hwnd) {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

/// Bring the window to the front, or fail having sent nothing. Returns whether
/// it moved. Windows limits who may take the foreground, so this tries the
/// plain call, then sharing the foreground thread's input state, then UIA.
fn raise(com: &Com, hwnd: HWND) -> Result<Raised> {
    if is_front(hwnd) {
        return Ok(Raised(false));
    }
    unsafe {
        if wm::IsIconic(hwnd).as_bool() {
            let _ = wm::ShowWindow(hwnd, wm::SW_RESTORE);
        }
        let _ = wm::SetForegroundWindow(hwnd);
        if wait_front(hwnd, Duration::from_millis(200)) {
            return Ok(Raised(true));
        }

        let fg = wm::GetForegroundWindow();
        let theirs = wm::GetWindowThreadProcessId(fg, None);
        let ours = GetCurrentThreadId();
        if theirs != 0 && theirs != ours && AttachThreadInput(ours, theirs, true).as_bool() {
            let _ = wm::BringWindowToTop(hwnd);
            let _ = wm::SetForegroundWindow(hwnd);
            let _ = AttachThreadInput(ours, theirs, false);
        }
        if wait_front(hwnd, Duration::from_millis(200)) {
            return Ok(Raised(true));
        }

        if let Ok(el) = com.uia.ElementFromHandle(hwnd) {
            let _ = el.SetFocus();
        }
        if wait_front(hwnd, Duration::from_millis(300)) {
            return Ok(Raised(true));
        }
    }
    Err(DesktopError::Failed(
        "Windows would not bring that window to the front, so nothing was sent: keys and clicks go to whichever window is in front, and that is someone else's".into(),
    ))
}

fn not_in_front() -> DesktopError {
    DesktopError::Failed("the window lost the front before the keys went out, so nothing was sent".into())
}

fn key_input(vk: u16, scan: u16, flags: kbm::KEYBD_EVENT_FLAGS) -> kbm::INPUT {
    kbm::INPUT {
        r#type: kbm::INPUT_KEYBOARD,
        Anonymous: kbm::INPUT_0 {
            ki: kbm::KEYBDINPUT { wVk: kbm::VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}

/// Down and up for a virtual key, with the scan code and extended bit apps read.
fn tap(vk: u16, extended: bool, out: &mut Vec<kbm::INPUT>) {
    let scan = unsafe { kbm::MapVirtualKeyW(vk as u32, kbm::MAPVK_VK_TO_VSC) } as u16;
    let ext = if extended { kbm::KEYEVENTF_EXTENDEDKEY } else { kbm::KEYBD_EVENT_FLAGS(0) };
    out.push(key_input(vk, scan, ext));
    out.push(key_input(vk, scan, ext | kbm::KEYEVENTF_KEYUP));
}

fn send(inputs: &[kbm::INPUT]) -> Result<()> {
    if inputs.is_empty() {
        return Ok(());
    }
    let sent = unsafe { kbm::SendInput(inputs, std::mem::size_of::<kbm::INPUT>() as i32) };
    if (sent as usize) < inputs.len() {
        return Err(DesktopError::Failed(
            "Windows dropped the input (a User Account Control prompt or the lock screen may be up)".into(),
        ));
    }
    Ok(())
}

/// Keystrokes that insert `text`. Line breaks and tabs are real keys; the rest
/// are Unicode packets, which ignore the keyboard layout.
fn text_inputs(text: &str) -> Vec<kbm::INPUT> {
    let mut out = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                tap(kbm::VK_RETURN.0, false, &mut out);
            }
            '\n' => tap(kbm::VK_RETURN.0, false, &mut out),
            '\t' => tap(kbm::VK_TAB.0, false, &mut out),
            _ => {
                let mut units = [0u16; 2];
                for u in c.encode_utf16(&mut units) {
                    out.push(key_input(0, *u, kbm::KEYEVENTF_UNICODE));
                    out.push(key_input(0, *u, kbm::KEYEVENTF_UNICODE | kbm::KEYEVENTF_KEYUP));
                }
            }
        }
    }
    out
}

/// A named key's virtual key, and whether it is an extended one.
fn named_vk(key: &Key) -> Option<(u16, bool)> {
    Some(match key {
        Key::Return => (kbm::VK_RETURN.0, false),
        Key::Tab => (kbm::VK_TAB.0, false),
        Key::Space => (kbm::VK_SPACE.0, false),
        Key::Delete => (kbm::VK_BACK.0, false),
        Key::Escape => (kbm::VK_ESCAPE.0, false),
        Key::ForwardDelete => (kbm::VK_DELETE.0, true),
        Key::Home => (kbm::VK_HOME.0, true),
        Key::End => (kbm::VK_END.0, true),
        Key::PageUp => (kbm::VK_PRIOR.0, true),
        Key::PageDown => (kbm::VK_NEXT.0, true),
        Key::Left => (kbm::VK_LEFT.0, true),
        Key::Right => (kbm::VK_RIGHT.0, true),
        Key::Up => (kbm::VK_UP.0, true),
        Key::Down => (kbm::VK_DOWN.0, true),
        Key::F(n) if (1..=24).contains(n) => (kbm::VK_F1.0 + (*n as u16 - 1), false),
        Key::F(_) => return None,
        Key::Char(c) if c.is_ascii_alphabetic() => (c.to_ascii_uppercase() as u16, false),
        Key::Char(c) if c.is_ascii_digit() => (*c as u16, false),
        Key::Char(_) => return None,
    })
}

/// Escape by message, to the window with focus. Nyra holds a bare Esc as its
/// global kill switch while in control, and a hotkey eats injected keys too —
/// SendInput's Escape would never reach the app.
fn post_escape(hwnd: HWND) -> Result<()> {
    unsafe {
        let thread = wm::GetWindowThreadProcessId(hwnd, None);
        let mut info = wm::GUITHREADINFO { cbSize: std::mem::size_of::<wm::GUITHREADINFO>() as u32, ..Default::default() };
        let target = if wm::GetGUIThreadInfo(thread, &mut info).is_ok() && !info.hwndFocus.is_invalid() {
            info.hwndFocus
        } else if !info.hwndActive.is_invalid() {
            info.hwndActive
        } else {
            hwnd
        };
        let scan = kbm::MapVirtualKeyW(kbm::VK_ESCAPE.0 as u32, kbm::MAPVK_VK_TO_VSC) as isize;
        let down = 1 | (scan << 16);
        let up = down | (1 << 30) | (1 << 31);
        wm::PostMessageW(Some(target), wm::WM_KEYDOWN, WPARAM(kbm::VK_ESCAPE.0 as usize), LPARAM(down))
            .and_then(|_| wm::PostMessageW(Some(target), wm::WM_KEYUP, WPARAM(kbm::VK_ESCAPE.0 as usize), LPARAM(up)))
            .map_err(|e| DesktopError::Failed(format!("Windows would not deliver Escape: {}", e.message())))
    }
}

/// Is the element, or something inside it, what has the keyboard?
fn has_focus(com: &Com, el: &ua::IUIAutomationElement) -> bool {
    unsafe {
        if el.CurrentHasKeyboardFocus().is_ok_and(|b| b.as_bool()) {
            return true;
        }
        let Ok(focused) = com.uia.GetFocusedElement() else { return false };
        if com.uia.CompareElements(&focused, el).is_ok_and(|b| b.as_bool()) {
            return true;
        }
        // Walk up from the focused element a little way: a document's caret
        // often lives in a child it draws.
        let Ok(walker) = com.uia.RawViewWalker() else { return false };
        let mut cur = focused;
        for _ in 0..6 {
            let Ok(parent) = walker.GetParentElement(&cur) else { return false };
            if com.uia.CompareElements(&parent, el).is_ok_and(|b| b.as_bool()) {
                return true;
            }
            cur = parent;
        }
        false
    }
}

/// What a field says now, for `settle`.
fn current_text(el: &ua::IUIAutomationElement) -> Option<String> {
    unsafe {
        el.GetCurrentPatternAs::<ua::IUIAutomationValuePattern>(ua::UIA_ValuePatternId)
            .and_then(|v| v.CurrentValue())
            .map(|s| s.to_string())
            .ok()
            .filter(|s| !s.is_empty())
            .or_else(|| document_text(el))
    }
}

/// Wait for the app to take what was just sent. SendInput only queues it — a
/// busy editor eats a few dozen characters a second — and until it has, a
/// read-back sees half the text, and Esc between chunks cannot stop what is
/// already queued. Done when the field stops changing, within a bound that
/// grows with the text.
fn settle(el: &ua::IUIAutomationElement, chars: usize) {
    let started = Instant::now();
    let deadline = started + Duration::from_millis((200 + 60 * chars as u64).min(4000));
    let Some(mut last) = current_text(el) else {
        // Nothing to watch: give it roughly a keystroke's worth each.
        std::thread::sleep(Duration::from_millis((10 * chars as u64).min(1000)));
        return;
    };
    let mut still = 0;
    while Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(40));
        let now = current_text(el).unwrap_or_default();
        if now == last {
            still += 1;
            if still >= 3 {
                return;
            }
        } else {
            still = 0;
            last = now;
        }
    }
}

fn focused_is_password(com: &Com) -> bool {
    unsafe {
        com.uia
            .GetFocusedElement()
            .and_then(|f| f.CurrentIsPassword())
            .map(|b| b.as_bool())
            // Unknown is treated as secure: refusing is the safe mistake.
            .unwrap_or(true)
    }
}

// ---------------------------------------------------------------------------
// Pictures
// ---------------------------------------------------------------------------

/// A BGRA image, top row first, 4 bytes a pixel, no padding.
struct Pixels {
    w: u32,
    h: u32,
    bgra: Vec<u8>,
}

impl Pixels {
    /// Nothing but black: what a protected or GPU surface gives a capture
    /// that cannot see it.
    fn is_black(&self) -> bool {
        let step = ((self.bgra.len() / 4) / 4096).max(1) * 4;
        self.bgra.chunks_exact(4).step_by(step / 4).all(|p| p[0] < 8 && p[1] < 8 && p[2] < 8)
    }

    fn crop(self, x: u32, y: u32, w: u32, h: u32) -> Pixels {
        let (x, y) = (x.min(self.w), y.min(self.h));
        let (w, h) = (w.min(self.w - x), h.min(self.h - y));
        if (x, y, w, h) == (0, 0, self.w, self.h) {
            return self;
        }
        let mut out = Vec::with_capacity((w * h * 4) as usize);
        for row in y..y + h {
            let start = ((row * self.w + x) * 4) as usize;
            out.extend_from_slice(&self.bgra[start..start + (w * 4) as usize]);
        }
        Pixels { w, h, bgra: out }
    }
}

impl Com {
    fn gpu(&self) -> ::windows::core::Result<std::cell::Ref<'_, Gpu>> {
        if self.gpu.borrow().is_none() {
            let made = unsafe { make_gpu() }?;
            *self.gpu.borrow_mut() = Some(made);
        }
        Ok(std::cell::Ref::map(self.gpu.borrow(), |g| g.as_ref().expect("just made")))
    }

    /// Windows.Graphics.Capture: the frame the compositor already drew, so
    /// OpenGL, Vulkan and DirectX windows come out as the user sees them.
    fn capture_wgc(&self, hwnd: HWND) -> ::windows::core::Result<Pixels> {
        if !GraphicsCaptureSession::IsSupported()? {
            return Err(::windows::core::Error::from(::windows::Win32::Foundation::E_NOTIMPL));
        }
        let result = (|| unsafe {
            let interop = ::windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
            let item: GraphicsCaptureItem = interop.CreateForWindow(hwnd)?;
            let size = item.Size()?;
            let gpu = self.gpu()?;
            let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&gpu.winrt, DirectXPixelFormat::B8G8R8A8UIntNormalized, 1, size)?;
            let session = pool.CreateCaptureSession(&item)?;
            let _ = session.SetIsCursorCaptureEnabled(false);
            // Windows 11 lets an app capture without the yellow border; 10 says no.
            let _ = session.SetIsBorderRequired(false);
            session.StartCapture()?;

            let deadline = Instant::now() + Duration::from_millis(1500);
            let frame = loop {
                match pool.TryGetNextFrame() {
                    Ok(f) => break Ok(f),
                    Err(e) if Instant::now() >= deadline => break Err(e),
                    Err(_) => std::thread::sleep(Duration::from_millis(10)),
                }
            };
            let pixels = frame.and_then(|frame| {
                let content = frame.ContentSize()?;
                let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
                let texture: d3d::ID3D11Texture2D = access.GetInterface()?;
                let px = read_texture(&gpu, &texture, content.Width.max(0) as u32, content.Height.max(0) as u32);
                let _ = frame.Close();
                px
            });
            let _ = session.Close();
            let _ = pool.Close();
            pixels
        })();
        if result.is_err() {
            // A lost device fails every later capture until it is made again.
            *self.gpu.borrow_mut() = None;
        }
        result
    }
}

unsafe fn make_gpu() -> ::windows::core::Result<Gpu> {
    let mut made = Err(::windows::core::Error::empty());
    for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
        let mut device = None;
        let mut context = None;
        made = d3d::D3D11CreateDevice(
            None,
            driver,
            HMODULE::default(),
            d3d::D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            d3d::D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map(|_| (device, context));
        if made.is_ok() {
            break;
        }
    }
    let (Some(device), Some(context)) = made? else {
        return Err(::windows::core::Error::empty());
    };
    let dxgi: IDXGIDevice = device.cast()?;
    let winrt: IDirect3DDevice = CreateDirect3D11DeviceFromDXGIDevice(&dxgi)?.cast()?;
    Ok(Gpu { device, context, winrt })
}

unsafe fn read_texture(gpu: &Gpu, texture: &d3d::ID3D11Texture2D, want_w: u32, want_h: u32) -> ::windows::core::Result<Pixels> {
    let mut desc = d3d::D3D11_TEXTURE2D_DESC::default();
    texture.GetDesc(&mut desc);
    desc.Usage = d3d::D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = d3d::D3D11_CPU_ACCESS_READ.0 as u32;
    desc.MiscFlags = 0;
    let mut staging = None;
    gpu.device.CreateTexture2D(&desc, None, Some(&mut staging))?;
    let staging = staging.ok_or_else(::windows::core::Error::empty)?;
    gpu.context.CopyResource(&staging, texture);

    let mut mapped = d3d::D3D11_MAPPED_SUBRESOURCE::default();
    gpu.context.Map(&staging, 0, d3d::D3D11_MAP_READ, 0, Some(&mut mapped))?;
    let w = want_w.min(desc.Width);
    let h = want_h.min(desc.Height);
    let mut bgra = Vec::with_capacity((w * h * 4) as usize);
    for row in 0..h {
        let src = (mapped.pData as *const u8).add((row * mapped.RowPitch) as usize);
        bgra.extend_from_slice(std::slice::from_raw_parts(src, (w * 4) as usize));
    }
    gpu.context.Unmap(&staging, 0);
    Ok(Pixels { w, h, bgra })
}

/// The window asked to draw itself into a bitmap. Right for GDI and
/// DirectComposition, often black for GPU apps — hence second.
fn capture_print(hwnd: HWND) -> Result<Pixels> {
    unsafe {
        if wm::IsHungAppWindow(hwnd).as_bool() {
            return Err(DesktopError::Failed("the app is not responding".into()));
        }
        let mut wr = RECT::default();
        wm::GetWindowRect(hwnd, &mut wr).map_err(|e| DesktopError::Failed(e.message()))?;
        let (w, h) = ((wr.right - wr.left).max(1), (wr.bottom - wr.top).max(1));

        let screen = gdi::GetDC(None);
        let mem = gdi::CreateCompatibleDC(Some(screen));
        let info = gdi::BITMAPINFO {
            bmiHeader: gdi::BITMAPINFOHEADER {
                biSize: std::mem::size_of::<gdi::BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: gdi::BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits = std::ptr::null_mut();
        let dib = gdi::CreateDIBSection(Some(mem), &info, gdi::DIB_RGB_COLORS, &mut bits, None, 0);
        let out = match dib {
            Ok(dib) => {
                let old = gdi::SelectObject(mem, dib.into());
                let ok = PrintWindow(hwnd, mem, PRINT_WINDOW_FLAGS(wm::PW_RENDERFULLCONTENT)).as_bool();
                let px = ok.then(|| {
                    let bgra = std::slice::from_raw_parts(bits as *const u8, (w * h * 4) as usize).to_vec();
                    Pixels { w: w as u32, h: h as u32, bgra }
                });
                gdi::SelectObject(mem, old);
                let _ = gdi::DeleteObject(dib.into());
                px.ok_or_else(|| DesktopError::Failed("Windows could not draw that window".into()))
            }
            Err(e) => Err(DesktopError::Failed(e.message())),
        };
        let _ = gdi::DeleteDC(mem);
        gdi::ReleaseDC(None, screen);

        // Down to the part that is visible, the same rect `frame` reports.
        let px = out?;
        match frame_of(hwnd) {
            Some(f) => {
                let x = (f.x as i32 - wr.left).max(0) as u32;
                let y = (f.y as i32 - wr.top).max(0) as u32;
                Ok(px.crop(x, y, f.w.max(1.0) as u32, f.h.max(1.0) as u32))
            }
            None => Ok(px),
        }
    }
}

impl Com {
    /// BGRA to PNG, `width` wide or narrower, through WIC.
    fn encode_png(&self, mut px: Pixels, width: Option<u32>) -> ::windows::core::Result<Vec<u8>> {
        // GDI leaves alpha at zero, which a PNG reads as transparent.
        for p in px.bgra.chunks_exact_mut(4) {
            p[3] = 255;
        }
        unsafe {
            let bitmap = self.wic.CreateBitmapFromMemory(px.w, px.h, &wic::GUID_WICPixelFormat32bppBGRA, px.w * 4, &px.bgra)?;
            let source: wic::IWICBitmapSource = match width {
                Some(w) if w > 0 && w < px.w => {
                    let h = ((px.h as f64) * (w as f64) / (px.w as f64)).round().max(1.0) as u32;
                    let scaler = self.wic.CreateBitmapScaler()?;
                    scaler.Initialize(&bitmap, w, h, wic::WICBitmapInterpolationModeFant)?;
                    scaler.cast()?
                }
                _ => bitmap.cast()?,
            };
            self.png_of(&source)
        }
    }

    unsafe fn png_of(&self, source: &wic::IWICBitmapSource) -> ::windows::core::Result<Vec<u8>> {
        let (mut w, mut h) = (0, 0);
        source.GetSize(&mut w, &mut h)?;
        let stream = shell::SHCreateMemStream(None).ok_or_else(::windows::core::Error::empty)?;
        let encoder = self.wic.CreateEncoder(&wic::GUID_ContainerFormatPng, std::ptr::null())?;
        encoder.Initialize(&stream, wic::WICBitmapEncoderNoCache)?;
        let mut frame = None;
        encoder.CreateNewFrame(&mut frame, std::ptr::null_mut())?;
        let frame = frame.ok_or_else(::windows::core::Error::empty)?;
        frame.Initialize(None)?;
        frame.SetSize(w, h)?;
        let mut format = wic::GUID_WICPixelFormat32bppBGRA;
        frame.SetPixelFormat(&mut format)?;
        frame.WriteSource(source, std::ptr::null())?;
        frame.Commit()?;
        encoder.Commit()?;

        let mut end = 0u64;
        stream.Seek(0, com::STREAM_SEEK_END, Some(&mut end))?;
        stream.Seek(0, com::STREAM_SEEK_SET, None)?;
        let mut out = vec![0u8; end as usize];
        let mut read = 0u32;
        stream.Read(out.as_mut_ptr() as *mut _, end as u32, Some(&mut read)).ok()?;
        out.truncate(read as usize);
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// The lists
// ---------------------------------------------------------------------------

const TERMINAL: &str = "Claude already has a shell; driving a terminal window only reaches sessions it should not, like an elevated prompt or an ssh login";
const PASSWORDS: &str = "it is a password manager";

/// Matched by executable file name, case-insensitively (see `app_matches`).
const BLOCKLIST: &[BlockRule] = &[
    BlockRule { id: Some("nyra.exe"), name: Some("Nyra"), title: None, why: "it is Nyra itself" },
    BlockRule { id: Some("consent.exe"), name: None, title: None, why: "it is a User Account Control prompt, which only you answer" },
    BlockRule { id: Some("CredentialUIBroker.exe"), name: None, title: None, why: "it asks for your Windows credentials" },
    BlockRule { id: Some("SecHealthUI.exe"), name: None, title: None, why: "Windows Security holds your protection settings" },
    BlockRule { id: Some("SystemSettings.exe"), name: None, title: None, why: "Settings holds privacy and security switches that only you should flip" },
    BlockRule { id: Some("explorer.exe"), name: None, title: Some("Credential Manager"), why: "Credential Manager stores your passwords" },
    BlockRule { id: Some("WindowsTerminal.exe"), name: None, title: None, why: TERMINAL },
    BlockRule { id: Some("OpenConsole.exe"), name: None, title: None, why: TERMINAL },
    BlockRule { id: Some("conhost.exe"), name: None, title: None, why: TERMINAL },
    // A classic console window can report the shell in it as its owner.
    BlockRule { id: Some("cmd.exe"), name: None, title: None, why: TERMINAL },
    BlockRule { id: Some("powershell.exe"), name: None, title: None, why: TERMINAL },
    BlockRule { id: Some("pwsh.exe"), name: None, title: None, why: TERMINAL },
    BlockRule { id: Some("powershell_ise.exe"), name: None, title: None, why: TERMINAL },
    BlockRule { id: Some("1Password.exe"), name: None, title: None, why: PASSWORDS },
    BlockRule { id: Some("Bitwarden.exe"), name: None, title: None, why: PASSWORDS },
    BlockRule { id: Some("LastPass.exe"), name: None, title: None, why: PASSWORDS },
    BlockRule { id: Some("KeePassXC.exe"), name: None, title: None, why: PASSWORDS },
    BlockRule { id: Some("KeePass.exe"), name: None, title: None, why: PASSWORDS },
    BlockRule { id: Some("Enpass.exe"), name: None, title: None, why: PASSWORDS },
    BlockRule { id: Some("ProtonPass.exe"), name: None, title: None, why: PASSWORDS },
    BlockRule { id: None, name: Some("Dashlane"), title: None, why: PASSWORDS },
];

const WARNLIST: &[WarnRule] = &[
    WarnRule { id: Some("explorer.exe"), name: None, text: "File Explorer can read, move or delete any file" },
    WarnRule { id: Some("Code.exe"), name: None, text: "an editor can run code, the same as shell access" },
    WarnRule { id: Some("Cursor.exe"), name: None, text: "an editor can run code, the same as shell access" },
    WarnRule { id: Some("devenv.exe"), name: None, text: "an IDE can run code, the same as shell access" },
    WarnRule { id: Some("msedge.exe"), name: None, text: "for web pages, Nyra's own browser is the better tool" },
    WarnRule { id: Some("chrome.exe"), name: None, text: "for web pages, Nyra's own browser is the better tool" },
    WarnRule { id: Some("firefox.exe"), name: None, text: "for web pages, Nyra's own browser is the better tool" },
];

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

/// A UIA element, and the top-level window it was read from.
#[derive(Clone)]
pub struct Handle {
    el: Agile,
    hwnd: isize,
}

impl Handle {
    fn hwnd(&self) -> HWND {
        HWND(self.hwnd as *mut _)
    }
}

#[derive(Clone)]
struct Agile(ua::IUIAutomationElement);

// SAFETY: UIA elements created on the MTA are agile proxies, callable from any
// MTA thread, and a thread with no apartment joins the process's implicit MTA —
// which the worker keeps alive for the life of the process. Every call is made
// on the worker anyway; other threads only clone and drop.
unsafe impl Send for Agile {}
unsafe impl Sync for Agile {}

pub struct Native;

impl Native {
    pub fn new() -> Self {
        Native
    }
}

/// The window a handle belongs to, still this app's, and not elevated.
fn handle_window(app: &AppInfo, h: &Handle) -> Result<Top> {
    let top = windows_for(app.pid).into_iter().find(|t| t.hwnd == h.hwnd()).ok_or(DesktopError::Gone)?;
    guard(&top)?;
    Ok(top)
}

impl Backend for Native {
    type Handle = Handle;

    fn blocklist(&self) -> &'static [BlockRule] {
        BLOCKLIST
    }
    fn warnlist(&self) -> &'static [WarnRule] {
        WARNLIST
    }
    /// An `AppId` here is an executable path; a rule names the file.
    fn app_matches(&self, id: &AppId, pattern: &str) -> bool {
        let file = id.0.rsplit(['\\', '/']).next().unwrap_or(&id.0);
        file.eq_ignore_ascii_case(pattern)
    }
    fn mod_is_cmd(&self) -> bool {
        false
    }

    /// Nothing to grant on Windows, but both are reported held rather than left
    /// out: the engine only takes the preview picture beside a snapshot when
    /// capture says granted. Elevation is per window, in `list_windows`.
    fn permissions(&self) -> Vec<PermissionEntry> {
        [PermissionKind::ControlInput, PermissionKind::CaptureScreen]
            .into_iter()
            .map(|kind| PermissionEntry { kind, granted: true, reason: "Windows needs no permission for this".into(), fix: None })
            .collect()
    }
    fn request_permission(&self, _kind: PermissionKind) -> bool {
        true
    }

    fn list_apps(&self) -> Result<Vec<AppInfo>> {
        on_worker(|c| {
            let fg = unsafe { wm::GetForegroundWindow() };
            let mut out: Vec<AppInfo> = Vec::new();
            for top in top_windows() {
                if let Some(app) = out.iter_mut().find(|a| a.pid == top.pid) {
                    app.frontmost |= top.hwnd == fg;
                    continue;
                }
                let Some(path) = process_path(top.pid) else { continue };
                let exe = c.canonical(&path);
                out.push(AppInfo { name: c.name_for(&exe), id: AppId(exe), pid: top.pid, frontmost: top.hwnd == fg });
            }
            out
        })
    }

    fn find_app(&self, query: &str) -> Option<(AppId, String)> {
        let q = query.to_string();
        on_worker(move |c| c.resolve(&q).map(|r| (AppId(r.exe), r.name))).ok().flatten()
    }

    fn list_windows(&self, app: &AppInfo) -> Result<Vec<WindowInfo>> {
        let pid = app.pid;
        on_worker(move |_| {
            let fg = unsafe { wm::GetForegroundWindow() };
            windows_for(pid)
                .into_iter()
                // Minimised windows are left out: nothing in them can be seen or pressed.
                .filter(|t| unsafe { !wm::IsIconic(t.hwnd).as_bool() })
                .map(|t| WindowInfo {
                    key: key_of(t.hwnd),
                    frame: frame_of(t.hwnd),
                    focused: t.hwnd == fg,
                    blocked: integrity_block(&t.pids),
                    title: t.title,
                })
                .collect()
        })
    }

    fn element_tree(&self, app: &AppInfo, window: &WindowKey, limits: Limits) -> Result<RawElement<Handle>> {
        let (app, window) = (app.clone(), window.clone());
        on_worker(move |c| {
            let top = find_window(&app, &window)?;
            guard(&top)?;
            let root = unsafe { c.uia.ElementFromHandleBuildCache(top.hwnd, &c.cache) }.map_err(|e| uia_error(&e))?;
            let mut count = 0;
            walk(c, &root, top.hwnd, 0, limits, &mut count).ok_or(DesktopError::Gone)
        })?
    }

    fn menu_bar(&self, app: &AppInfo, limits: Limits) -> Result<RawElement<Handle>> {
        let app = app.clone();
        on_worker(move |c| {
            let top = main_window(&app)?;
            guard(&top)?;
            let root = unsafe { c.uia.ElementFromHandleBuildCache(top.hwnd, &c.cache) }.map_err(|e| uia_error(&e))?;
            let mut budget = 400;
            let bar = find_menu_bar(c, &root, 0, &mut budget).ok_or_else(|| {
                DesktopError::Unsupported(format!("{} has no menu bar; its menus are in the window's tree", app.name))
            })?;
            let mut count = 0;
            walk(c, &bar, top.hwnd, 0, limits, &mut count).ok_or(DesktopError::Gone)
        })?
    }

    fn is_alive(&self, h: &Handle) -> bool {
        let h = h.clone();
        on_worker(move |_| unsafe {
            let h = h;
            wm::IsWindow(Some(h.hwnd())).as_bool() && h.el.0.CurrentProcessId().is_ok()
        })
        .unwrap_or(false)
    }

    fn is_secure(&self, h: &Handle) -> bool {
        let h = h.clone();
        // Unknown is treated as secure: refusing is the safe mistake.
        on_worker(move |_| {
            let h = h;
            unsafe { h.el.0.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(true)
        })
        .unwrap_or(true)
    }

    fn read_value(&self, h: &Handle) -> Option<String> {
        let h = h.clone();
        on_worker(move |_| unsafe {
            let h = h;
            if h.el.0.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(true) {
                return None;
            }
            current_text(&h.el.0)
        })
        .ok()
        .flatten()
    }

    fn perform(&self, h: &Handle, action: &Action) -> Result<Raised> {
        let (h, action) = (h.clone(), action.clone());
        on_worker(move |c| {
            let h = h;
            let el = &h.el.0;
            let pid = unsafe { el.CurrentProcessId() }.map_err(|e| uia_error(&e))?;
            if let Some(b) = integrity_block(&[pid as u32, pid_of(h.hwnd())]) {
                return Err(DesktopError::Blocked(b));
            }
            unsafe {
                match action {
                    Action::Press => {
                        if let Ok(p) = el.GetCurrentPatternAs::<ua::IUIAutomationInvokePattern>(ua::UIA_InvokePatternId) {
                            return match p.Invoke() {
                                Ok(()) => Ok(Raised(false)),
                                // A press that opens a modal dialog can block
                                // until it closes, so the call times out having worked.
                                Err(e) if is_timeout(&e) => Ok(Raised(false)),
                                Err(e) => Err(uia_error(&e)),
                            };
                        }
                        if let Ok(p) = el.GetCurrentPatternAs::<ua::IUIAutomationTogglePattern>(ua::UIA_TogglePatternId) {
                            return p.Toggle().map(|_| Raised(false)).map_err(|e| uia_error(&e));
                        }
                        if let Ok(p) = el.GetCurrentPatternAs::<ua::IUIAutomationSelectionItemPattern>(ua::UIA_SelectionItemPatternId) {
                            return p.Select().map(|_| Raised(false)).map_err(|e| uia_error(&e));
                        }
                        if let Ok(p) = el.GetCurrentPatternAs::<ua::IUIAutomationExpandCollapsePattern>(ua::UIA_ExpandCollapsePatternId) {
                            let collapsed = matches!(
                                p.CurrentExpandCollapseState(),
                                Ok(ua::ExpandCollapseState_Collapsed) | Ok(ua::ExpandCollapseState_PartiallyExpanded)
                            );
                            let r = if collapsed { p.Expand() } else { p.Collapse() };
                            return r.map(|_| Raised(false)).map_err(|e| uia_error(&e));
                        }
                        Err(DesktopError::Unsupported("it has no press action".into()))
                    }
                    Action::Focus => {
                        let was = is_front(h.hwnd());
                        el.SetFocus().map_err(|e| uia_error(&e))?;
                        Ok(Raised(!was && is_front(h.hwnd())))
                    }
                    Action::SetValue(text) => {
                        let p = el
                            .GetCurrentPatternAs::<ua::IUIAutomationValuePattern>(ua::UIA_ValuePatternId)
                            .map_err(|_| DesktopError::Unsupported("its value cannot be set".into()))?;
                        if p.CurrentIsReadOnly().map(|b| b.as_bool()).unwrap_or(true) {
                            return Err(DesktopError::Unsupported("its value cannot be set".into()));
                        }
                        let _ = c;
                        p.SetValue(&BSTR::from(text.as_str())).map(|_| Raised(false)).map_err(|e| uia_error(&e))
                    }
                }
            }
        })?
    }

    fn type_text(&self, app: &AppInfo, h: &Handle, text: &str) -> Result<Raised> {
        let (app, h, text) = (app.clone(), h.clone(), text.to_string());
        on_worker(move |c| {
            let h = h;
            let top = handle_window(&app, &h)?;
            let raised = raise(c, top.hwnd)?;
            let el = &h.el.0;
            if !has_focus(c, el) {
                unsafe { el.SetFocus() }.map_err(|e| uia_error(&e))?;
                let deadline = Instant::now() + Duration::from_millis(400);
                while !has_focus(c, el) {
                    if Instant::now() >= deadline {
                        return Err(DesktopError::Failed(
                            "the caret would not go into that field, so nothing was typed".into(),
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(20));
                }
            }
            if focused_is_password(c) {
                return Err(DesktopError::Blocked(Blocked { reason: "the focused field is a password field".into(), fix: None }));
            }
            if !is_front(top.hwnd) {
                return Err(not_in_front());
            }
            send(&text_inputs(&text))?;
            settle(el, text.chars().count());
            Ok(Raised(raised.0))
        })?
    }

    fn press_keys(&self, app: &AppInfo, window: &WindowKey, chord: &Chord) -> Result<Raised> {
        if chord.cmd {
            return Err(DesktopError::Unsupported(
                "the Windows key talks to the shell, not to the app — Win+R alone opens a Run box. Use ctrl, or mod, for an app's shortcuts".into(),
            ));
        }
        let (app, window, chord) = (app.clone(), window.clone(), chord.clone());
        on_worker(move |c| {
            let top = if window.0 == "menu" { main_window(&app)? } else { find_window(&app, &window)? };
            guard(&top)?;
            let raised = raise(c, top.hwnd)?;

            let bare = !chord.ctrl && !chord.alt && !chord.shift;
            if chord.is_escape() && bare {
                post_escape(top.hwnd)?;
                return Ok(raised);
            }

            let (mut ctrl, mut alt, mut shift) = (chord.ctrl, chord.alt, chord.shift);
            let mut inputs = Vec::new();
            let key = match named_vk(&chord.key) {
                Some(k) => Some(k),
                None => match chord.key {
                    Key::Char(ch) => {
                        let layout = unsafe { kbm::GetKeyboardLayout(wm::GetWindowThreadProcessId(top.hwnd, None)) };
                        let mut units = [0u16; 2];
                        let scan = match ch.encode_utf16(&mut units) {
                            [u] => unsafe { kbm::VkKeyScanExW(*u, layout) },
                            _ => -1,
                        };
                        if scan == -1 {
                            if !bare {
                                return Err(DesktopError::Unsupported(format!("no key on this keyboard layout types {ch}")));
                            }
                            // Nothing to hold a modifier with: the character itself.
                            inputs = text_inputs(&ch.to_string());
                            None
                        } else {
                            let state = (scan >> 8) & 0xff;
                            shift |= state & 1 != 0;
                            ctrl |= state & 2 != 0;
                            alt |= state & 4 != 0;
                            Some(((scan & 0xff) as u16, false))
                        }
                    }
                    _ => return Err(DesktopError::Unsupported(format!("Windows has no {chord} key"))),
                },
            };
            if let Some((vk, extended)) = key {
                let mods: Vec<u16> = [(ctrl, kbm::VK_CONTROL.0), (alt, kbm::VK_MENU.0), (shift, kbm::VK_SHIFT.0)]
                    .into_iter()
                    .filter(|(on, _)| *on)
                    .map(|(_, vk)| vk)
                    .collect();
                for m in &mods {
                    let scan = unsafe { kbm::MapVirtualKeyW(*m as u32, kbm::MAPVK_VK_TO_VSC) } as u16;
                    inputs.push(key_input(*m, scan, kbm::KEYBD_EVENT_FLAGS(0)));
                }
                tap(vk, extended, &mut inputs);
                for m in mods.iter().rev() {
                    let scan = unsafe { kbm::MapVirtualKeyW(*m as u32, kbm::MAPVK_VK_TO_VSC) } as u16;
                    inputs.push(key_input(*m, scan, kbm::KEYEVENTF_KEYUP));
                }
            }
            if !is_front(top.hwnd) {
                return Err(not_in_front());
            }
            send(&inputs)?;
            Ok(raised)
        })?
    }

    fn click_at(&self, app: &AppInfo, window: &WindowKey, point: Point) -> Result<Raised> {
        let (app, window) = (app.clone(), window.clone());
        on_worker(move |c| {
            let top = if window.0 == "menu" { main_window(&app)? } else { find_window(&app, &window)? };
            guard(&top)?;
            let raised = raise(c, top.hwnd)?;
            let (x, y) = (point.x.round() as i32, point.y.round() as i32);
            // Whatever is on top at that point gets the click; make sure it is ours.
            let under = unsafe { wm::GetAncestor(wm::WindowFromPoint(POINT { x, y }), wm::GA_ROOT) };
            let under_pid = pid_of(under);
            if under != top.hwnd && !top.pids.contains(&under_pid) {
                return Err(DesktopError::Failed(
                    "something else is on top of that point, so the click would land on it. Nothing was clicked".into(),
                ));
            }
            unsafe {
                let mut home = POINT::default();
                let had_home = wm::GetCursorPos(&mut home).is_ok();
                let vx = wm::GetSystemMetrics(wm::SM_XVIRTUALSCREEN);
                let vy = wm::GetSystemMetrics(wm::SM_YVIRTUALSCREEN);
                let vw = wm::GetSystemMetrics(wm::SM_CXVIRTUALSCREEN).max(2);
                let vh = wm::GetSystemMetrics(wm::SM_CYVIRTUALSCREEN).max(2);
                let nx = (((x - vx) as i64 * 65535) / (vw as i64 - 1)) as i32;
                let ny = (((y - vy) as i64 * 65535) / (vh as i64 - 1)) as i32;
                let mouse = |flags: kbm::MOUSE_EVENT_FLAGS| kbm::INPUT {
                    r#type: kbm::INPUT_MOUSE,
                    Anonymous: kbm::INPUT_0 {
                        mi: kbm::MOUSEINPUT {
                            dx: nx,
                            dy: ny,
                            mouseData: 0,
                            dwFlags: flags | kbm::MOUSEEVENTF_ABSOLUTE | kbm::MOUSEEVENTF_VIRTUALDESK,
                            time: 0,
                            dwExtraInfo: 0,
                        },
                    },
                };
                if !is_front(top.hwnd) {
                    return Err(not_in_front());
                }
                send(&[mouse(kbm::MOUSEEVENTF_MOVE)])?;
                std::thread::sleep(Duration::from_millis(30));
                send(&[mouse(kbm::MOUSEEVENTF_LEFTDOWN), mouse(kbm::MOUSEEVENTF_LEFTUP)])?;
                std::thread::sleep(Duration::from_millis(30));
                // Put the pointer back where the user left it.
                if had_home {
                    let _ = wm::SetCursorPos(home.x, home.y);
                }
            }
            Ok(raised)
        })?
    }

    fn capture_window(&self, app: &AppInfo, window: &WindowKey, width: u32) -> Result<Vec<u8>> {
        let (app, window) = (app.clone(), window.clone());
        on_worker(move |c| {
            let top = find_window(&app, &window)?;
            guard(&top)?;
            if unsafe { wm::IsIconic(top.hwnd).as_bool() } {
                return Err(DesktopError::Failed("it is minimised, so there is nothing on screen to capture".into()));
            }
            let px = match c.capture_wgc(top.hwnd) {
                Ok(px) if !px.is_black() => px,
                wgc => match capture_print(top.hwnd) {
                    Ok(px) if !px.is_black() => px,
                    Ok(_) => {
                        return Err(DesktopError::Failed(
                            "Windows gave back a black picture of it: the app draws in a way screen capture can't see, such as protected video".into(),
                        ))
                    }
                    Err(e) => {
                        return Err(match wgc {
                            Err(w) => DesktopError::Failed(format!("Windows could not capture that window ({})", w.message())),
                            Ok(_) => e,
                        })
                    }
                },
            };
            c.encode_png(px, Some(width)).map_err(|e| DesktopError::Failed(format!("could not make a PNG of it: {}", e.message())))
        })?
    }

    fn app_icon(&self, app: &AppInfo) -> Option<Vec<u8>> {
        let exe = app.id.0.clone();
        on_worker(move |c| unsafe {
            // The Start menu's picture where there is one: a packaged app's
            // exe often carries a generic icon, its tile does not.
            let aumid = c
                .index()
                .iter()
                .find(|e| e.direct && e.exe.as_deref().is_some_and(|x| x.eq_ignore_ascii_case(&exe)))
                .map(|e| format!("shell:AppsFolder\\{}", e.aumid));
            let factory: shell::IShellItemImageFactory = aumid
                .and_then(|a| shell::SHCreateItemFromParsingName(&HSTRING::from(a), None).ok())
                .or_else(|| shell::SHCreateItemFromParsingName(&HSTRING::from(exe.as_str()), None).ok())?;
            let bitmap = factory.GetImage(SIZE { cx: 64, cy: 64 }, shell::SIIGBF_ICONONLY).ok()?;
            let png = c
                .wic
                .CreateBitmapFromHBITMAP(bitmap, gdi::HPALETTE::default(), wic::WICBitmapUsePremultipliedAlpha)
                .and_then(|b| c.png_of(&b.cast()?));
            let _ = gdi::DeleteObject(bitmap.into());
            png.ok()
        })
        .ok()
        .flatten()
    }

    fn open(&self, target: &Target) -> Result<String> {
        match target {
            Target::App(name) => {
                let n = name.clone();
                let found = on_worker(move |c| c.resolve(&n).map(|r| (r.launch, r.name)))?;
                let (launch, display) =
                    found.ok_or_else(|| DesktopError::Failed(format!("no app called \"{name}\" is installed")))?;
                shell_open(&launch)?;
                Ok(display)
            }
            Target::Path(p) => {
                if !std::path::Path::new(p).exists() {
                    return Err(DesktopError::Failed(format!("{p} does not exist")));
                }
                if runs_code(p) {
                    return Err(DesktopError::Unsupported(format!(
                        "{p} is a program or a script, and opening it would run it. Open an app by its name instead, so Nyra can check it and ask the user"
                    )));
                }
                shell_open(p)?;
                Ok(p.clone())
            }
            Target::Url(u) => {
                if !allowed_url(u) {
                    return Err(DesktopError::Unsupported(
                        "Nyra only opens http, https, mailto and tel links on Windows: other schemes start apps, and it can't check which".into(),
                    ));
                }
                shell_open(u)?;
                Ok(u.clone())
            }
        }
    }

    fn seconds_since_user_input(&self) -> f64 {
        let mut info = kbm::LASTINPUTINFO { cbSize: std::mem::size_of::<kbm::LASTINPUTINFO>() as u32, dwTime: 0 };
        if !unsafe { kbm::GetLastInputInfo(&mut info) }.as_bool() {
            return f64::MAX;
        }
        unsafe { GetTickCount() }.wrapping_sub(info.dwTime) as f64 / 1000.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn maps_control_types_into_neutral_words() {
        assert_eq!(role_of(ua::UIA_ButtonControlTypeId), Some(Role::Button));
        assert_eq!(role_of(ua::UIA_EditControlTypeId), Some(Role::TextField));
        assert_eq!(role_of(ua::UIA_TabItemControlTypeId), Some(Role::Tab));
        assert_eq!(role_of(ua::UIA_ScrollBarControlTypeId), None, "furniture");
        assert_eq!(role_of(ua::UIA_StatusBarControlTypeId), Some(Role::Other("status bar".into())));
    }

    #[test]
    fn matches_executables_by_file_name() {
        let n = Native::new();
        let id = AppId(r"C:\Windows\ImmersiveControlPanel\SystemSettings.exe".into());
        assert!(n.app_matches(&id, "systemsettings.exe"));
        assert!(!n.app_matches(&id, "Settings.exe"));
    }

    #[test]
    fn reads_the_executable_out_of_a_manifest() {
        let xml = r#"<Applications>
            <Application Id="App" Executable="Notepad\Notepad.exe" EntryPoint="Windows.FullTrustApplication">
            <Application
                Executable="Other.exe" Id="Second">
        </Applications>"#;
        assert_eq!(manifest_executable(xml, "app").as_deref(), Some(r"Notepad\Notepad.exe"));
        assert_eq!(manifest_executable(xml, "Second").as_deref(), Some("Other.exe"));
        assert_eq!(manifest_executable(xml, "Missing"), None);
        assert_eq!(manifest_executable(r#"<Application Id="App" Executable="$targetnametoken$.exe">"#, "App"), None);
    }

    #[test]
    fn a_name_and_an_executable_are_the_same_app() {
        assert_eq!(squash("Windows Terminal"), "windowsterminal");
        assert_eq!(squash("WindowsTerminal.exe"), "windowsterminal");
        assert_eq!(stem(r"C:\x\Code.exe"), "Code");
    }

    #[test]
    fn maps_keys_to_virtual_keys() {
        assert_eq!(named_vk(&Key::Char('s')), Some((b'S' as u16, false)));
        assert_eq!(named_vk(&Key::Char('7')), Some((b'7' as u16, false)));
        assert_eq!(named_vk(&Key::Left), Some((kbm::VK_LEFT.0, true)));
        assert_eq!(named_vk(&Key::F(5)), Some((kbm::VK_F5.0, false)));
        // Punctuation depends on the layout, and is looked up there.
        assert_eq!(named_vk(&Key::Char(';')), None);
    }

    #[test]
    fn types_line_breaks_as_keys_and_the_rest_as_unicode() {
        let inputs = text_inputs("a\r\nb");
        // a down/up, Return down/up, b down/up.
        assert_eq!(inputs.len(), 6);
        let ki = |i: usize| unsafe { inputs[i].Anonymous.ki };
        assert_eq!(ki(0).wScan, 'a' as u16);
        assert!(ki(0).dwFlags.contains(kbm::KEYEVENTF_UNICODE));
        assert_eq!(ki(2).wVk, kbm::VK_RETURN);
        // A character outside the BMP is two packets, each pressed and released.
        assert_eq!(text_inputs("😀").len(), 4);
    }

    #[test]
    fn opens_only_what_it_can_check() {
        assert!(runs_code(r"C:\x\setup.EXE"));
        assert!(runs_code(r"C:\x\a.lnk"));
        assert!(!runs_code(r"C:\x\notes.txt"));
        assert!(allowed_url("https://x.dev"));
        assert!(allowed_url("mailto:a@b.c"));
        assert!(!allowed_url("ms-settings:privacy"));
        assert!(!allowed_url("file:///C:/x/setup.exe"));
    }

    #[test]
    fn crops_and_spots_a_black_picture() {
        let px = Pixels { w: 4, h: 2, bgra: (0..32).map(|i| if i < 16 { 0 } else { 200 }).collect() };
        assert!(!px.is_black());
        let top = px.crop(0, 0, 4, 1);
        assert_eq!((top.w, top.h), (4, 1));
        assert!(top.is_black());
        let right = Pixels { w: 4, h: 2, bgra: (0..32).map(|i| i as u8).collect() }.crop(2, 1, 9, 9);
        assert_eq!((right.w, right.h), (2, 1));
        assert_eq!(right.bgra, (24..32).map(|i| i as u8).collect::<Vec<_>>());
    }

    /// Reads real names without touching any app's UI. Ignored: CI has no
    /// Start menu worth the name.
    #[test]
    #[ignore]
    fn resolves_system_apps_to_the_executables_the_blocklist_names() {
        let n = Native::new();
        for (query, file) in [
            ("Settings", "SystemSettings.exe"),
            ("Windows Terminal", "WindowsTerminal.exe"),
            ("Terminal", "WindowsTerminal.exe"),
            ("Windows Security", "SecHealthUI.exe"),
            ("Notepad", "Notepad.exe"),
            ("Task Manager", "Taskmgr.exe"),
        ] {
            let (id, name) = n.find_app(query).unwrap_or_else(|| panic!("{query} was not found"));
            println!("  {query:>16} -> {name} · {}", id.0);
            assert!(n.app_matches(&id, file), "{query} resolved to {}", id.0);
        }
    }

    #[test]
    #[ignore]
    fn lists_real_apps_and_their_windows() {
        let n = Native::new();
        for app in n.list_apps().unwrap() {
            println!("{} ({}) pid {}{}", app.name, app.id.0, app.pid, if app.frontmost { " frontmost" } else { "" });
            for w in n.list_windows(&app).unwrap_or_default() {
                println!("    {:?} {:?}{}", w.title, w.frame, w.blocked.map(|b| format!(" blocked: {}", b.reason)).unwrap_or_default());
            }
        }
    }

    /// Drop this process to medium integrity. A process may always lower its
    /// own level, never raise it.
    fn lower_self_to_medium() {
        use ::windows::Win32::Security::{
            AllocateAndInitializeSid, FreeSid, GetLengthSid, SetTokenInformation, PSID,
            SID_AND_ATTRIBUTES, SID_IDENTIFIER_AUTHORITY, TOKEN_ADJUST_DEFAULT,
        };
        unsafe {
            let mut token = HANDLE::default();
            OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_DEFAULT | TOKEN_QUERY, &mut token).unwrap();
            let token = Owned(token);
            let authority = SID_IDENTIFIER_AUTHORITY { Value: [0, 0, 0, 0, 0, 16] };
            let mut sid = PSID::default();
            AllocateAndInitializeSid(&authority, 1, 0x2000, 0, 0, 0, 0, 0, 0, 0, &mut sid).unwrap();
            let label = TOKEN_MANDATORY_LABEL { Label: SID_AND_ATTRIBUTES { Sid: sid, Attributes: 0x20 /* SE_GROUP_INTEGRITY */ } };
            let size = std::mem::size_of::<TOKEN_MANDATORY_LABEL>() as u32 + GetLengthSid(sid);
            SetTokenInformation(token.0, TokenIntegrityLevel, &label as *const _ as *const _, size).unwrap();
            FreeSid(sid);
        }
    }

    /// An elevated window is refused, never silently dropped. Signed in as the
    /// built-in Administrator every process runs high, Nyra included, so there
    /// is nothing above it to refuse: this test lowers itself to medium first,
    /// then looks at Task Manager, which an administrator's Windows starts high.
    /// Needs Task Manager open and not minimised. Run it on its own — the
    /// level is read once per process.
    #[test]
    #[ignore]
    fn an_elevated_window_is_blocked_not_dropped() {
        lower_self_to_medium();
        assert_eq!(*OWN_INTEGRITY, Some(0x2000), "did not drop to medium");
        let n = Native::new();
        let tm = n
            .list_apps()
            .unwrap()
            .into_iter()
            .find(|a| n.app_matches(&a.id, "Taskmgr.exe"))
            .expect("Task Manager is not running");
        let w = n.list_windows(&tm).unwrap().into_iter().next().expect("Task Manager has no window that is not minimised");
        println!("  {:?}: {:?}", w.title, w.blocked.as_ref().map(|b| &b.reason));
        assert!(w.blocked.is_some(), "an elevated window was not marked blocked");

        let esc = Chord { cmd: false, ctrl: false, alt: false, shift: false, key: Key::Escape };
        let refused = |what: &str, r: Result<()>| {
            println!("  {what}: {:?}", r.as_ref().err());
            assert!(matches!(r, Err(DesktopError::Blocked(_))), "{what} was not refused as blocked");
        };
        refused("element_tree", n.element_tree(&tm, &w.key, Limits { max_depth: 3, max_nodes: 50 }).map(|_| ()));
        refused("press_keys", n.press_keys(&tm, &w.key, &esc).map(|_| ()));
        refused("click_at", n.click_at(&tm, &w.key, w.frame.unwrap().centre()).map(|_| ()));
        refused("capture_window", n.capture_window(&tm, &w.key, 400).map(|_| ()));
    }

    /// Captures one real window at a width, and reads a real icon.
    #[test]
    #[ignore]
    fn captures_a_real_window_and_an_icon() {
        let n = Native::new();
        let own = std::process::id();
        let (app, window) = n
            .list_apps()
            .unwrap()
            .into_iter()
            .filter(|a| a.pid != own && super::super::safety::block_reason(a, None, BLOCKLIST, |id, p| n.app_matches(id, p), own).is_none())
            .find_map(|a| {
                let w = n.list_windows(&a).ok()?.into_iter().find(|w| w.blocked.is_none() && w.frame.is_some_and(|f| f.w > 300.0))?;
                Some((a, w))
            })
            .expect("some allowed app with a window");
        let png = n.capture_window(&app, &window.key, 800).unwrap();
        let (w, h) = super::super::safety::png_size(&png).unwrap();
        println!("  {} — {:?}: {w}x{h}", app.name, window.title);
        assert!(w <= 800 && w >= 300, "{w}");
        let path = std::env::temp_dir().join("nyra-desktop-real-capture.png");
        std::fs::write(&path, &png).unwrap();
        println!("  saved {}", path.display());

        let icon = n.app_icon(&app).expect("an icon");
        let (iw, ih) = super::super::safety::png_size(&icon).unwrap();
        println!("  icon {iw}x{ih}, {} bytes", icon.len());
        assert!(iw <= 256 && ih <= 256);
    }

    /// The phase 3 finish line, on a real Windows machine: open Notepad, type a
    /// line, read it back, then be refused Settings and Windows Terminal. Moves
    /// real windows, so ignored and run by hand:
    /// `cargo test --lib drives_notepad_end_to_end -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn drives_notepad_end_to_end() {
        let d = Desktop::new(
            Native::new(),
            super::super::fake::AllowOnly(&["Notepad"]),
            GuardTiming::default(),
            SCRATCH_DIR.clone(),
        );
        let chat = "e2e";
        let say = |label: &str, r: &std::result::Result<String, String>| match r {
            Ok(t) => println!("--- {label}\n{t}\n"),
            Err(e) => println!("--- {label} (refused)\n{e}\n"),
        };

        let opened = d.open(chat, "Notepad").await;
        say("desktop_open Notepad", &opened);
        opened.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;

        // Windows 11 Notepad reopens the last session's tabs, unsaved ones
        // included: type into a new one, never into someone's file.
        let new_tab = d
            .act(chat, ActArgs { app: "Notepad".into(), action: "keys".into(), keys: Some("mod+n".into()), ..Default::default() })
            .await;
        say("keys mod+n", &new_tab);
        new_tab.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;

        let snap = d.snapshot(chat, "Notepad", None, None).await;
        say("desktop_snapshot", &snap);
        let snap = snap.unwrap();
        // Classic Notepad is an edit control, Windows 11's a document; either
        // way it is the one text area or text field in the window, and the
        // new tab's must be empty.
        let area = snap
            .lines()
            .find(|l| l.contains("] text area") || l.contains("] text field"))
            .and_then(|l| l.trim().split(']').next())
            .map(|r| r.trim_start_matches('[').to_string())
            .expect("a text area in Notepad");
        assert!(
            !snap.lines().any(|l| l.contains(&format!("[{area}]")) && l.contains(" = \"")),
            "{area} already has text in it: that is not a new tab, so nothing was typed"
        );

        let line = "Typed by Claude through Nyra desktop control.";
        let typed = d
            .act(chat, ActArgs { app: "Notepad".into(), r#ref: Some(area), action: "type".into(), text: Some(line.into()), ..Default::default() })
            .await;
        say("desktop_act type", &typed);
        typed.unwrap();

        let again = d.snapshot(chat, "Notepad", None, None).await;
        say("desktop_snapshot again", &again);
        assert!(again.unwrap().contains(line), "the line did not read back");

        let shot = d.screenshot(chat, "Notepad", None).await;
        match &shot {
            Ok(s) => println!("--- desktop_screenshot\n{}\n", s.text),
            Err(e) => println!("--- desktop_screenshot (refused)\n{e}\n"),
        }
        assert!(shot.is_ok(), "no screenshot");

        for blocked in ["Settings", "Windows Terminal"] {
            let r = d.open(chat, blocked).await;
            say(&format!("desktop_open {blocked}"), &r);
            assert!(r.unwrap_err().contains("off limits"), "{blocked} was not refused");
        }

        d.turn_ended(chat);
    }
}
