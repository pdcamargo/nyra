//! macOS: the accessibility API (AXUIElement) for the tree and actions,
//! CGEvent for keys and as the click fallback, NSWorkspace for apps and
//! opening things.
//!
//! The AX and CGEvent calls are declared here directly rather than through a
//! binding crate: the surface is small, stable C, and the objc2 binding for
//! HIServices is not in the tree. NSWorkspace goes through `objc2::msg_send`,
//! the way `spellcheck.rs` talks to WebKit.
//!
//! Every AX call is bounded by a messaging timeout set once on the system-wide
//! element, so a hung app fails a call in about a second and a half rather than
//! the six-second default times every element in its tree.

#![allow(non_upper_case_globals, non_snake_case)]

use objc2::rc::{autoreleasepool, Retained};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSString;
use once_cell::sync::Lazy;
use std::ffi::{c_char, c_void};
use std::time::Duration;

use super::safety::{Chord, Key};
use super::*;

// ---------------------------------------------------------------------------
// FFI
// ---------------------------------------------------------------------------

type CFTypeRef = *const c_void;
type CFIndex = isize;
type AXError = i32;

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGPoint {
    x: f64,
    y: f64,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
struct CGSize {
    width: f64,
    height: f64,
}

#[repr(C)]
struct Opaque([u8; 0]);

const UTF8: u32 = 0x0800_0100;
const kCFNumberFloat64Type: CFIndex = 6;
const kAXValueCGPointType: u32 = 1;
const kAXValueCGSizeType: u32 = 2;
const kAXValueAXErrorType: u32 = 5;

const kAXErrorSuccess: AXError = 0;
const kAXErrorInvalidUIElement: AXError = -25202;
const kAXErrorCannotComplete: AXError = -25204;
const kAXErrorAttributeUnsupported: AXError = -25205;
const kAXErrorActionUnsupported: AXError = -25206;
const kAXErrorNotImplemented: AXError = -25208;
const kAXErrorAPIDisabled: AXError = -25211;
const kAXErrorNoValue: AXError = -25212;

const kCGHIDEventTap: u32 = 0;
const kCGEventSourceStateHIDSystemState: i32 = 1;
const kCGAnyInputEventType: u32 = u32::MAX;
const kCGEventLeftMouseDown: u32 = 1;
const kCGEventLeftMouseUp: u32 = 2;
const kCGEventMouseMoved: u32 = 5;
const kCGMouseEventClickState: u32 = 1;

const FLAG_SHIFT: u64 = 0x0002_0000;
const FLAG_CTRL: u64 = 0x0004_0000;
const FLAG_ALT: u64 = 0x0008_0000;
const FLAG_CMD: u64 = 0x0010_0000;

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(cf: CFTypeRef);
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFEqual(a: CFTypeRef, b: CFTypeRef) -> u8;
    fn CFStringGetTypeID() -> usize;
    fn CFNumberGetTypeID() -> usize;
    fn CFBooleanGetTypeID() -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFStringCreateWithBytes(
        alloc: CFTypeRef,
        bytes: *const u8,
        len: CFIndex,
        encoding: u32,
        external: u8,
    ) -> CFTypeRef;
    fn CFStringGetLength(s: CFTypeRef) -> CFIndex;
    fn CFStringGetMaximumSizeForEncoding(len: CFIndex, encoding: u32) -> CFIndex;
    fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: CFIndex, encoding: u32) -> u8;
    fn CFArrayGetCount(a: CFTypeRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(a: CFTypeRef, i: CFIndex) -> CFTypeRef;
    fn CFArrayCreate(alloc: CFTypeRef, values: *const CFTypeRef, n: CFIndex, callbacks: *const Opaque) -> CFTypeRef;
    fn CFBooleanGetValue(b: CFTypeRef) -> u8;
    fn CFNumberGetValue(n: CFTypeRef, kind: CFIndex, out: *mut c_void) -> u8;
    fn CFDictionaryCreate(
        alloc: CFTypeRef,
        keys: *const CFTypeRef,
        values: *const CFTypeRef,
        n: CFIndex,
        key_callbacks: *const Opaque,
        value_callbacks: *const Opaque,
    ) -> CFTypeRef;
    static kCFTypeArrayCallBacks: Opaque;
    static kCFTypeDictionaryKeyCallBacks: Opaque;
    static kCFTypeDictionaryValueCallBacks: Opaque;
    static kCFBooleanTrue: CFTypeRef;
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> u8;
    fn AXValueGetTypeID() -> usize;
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCreateSystemWide() -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(el: CFTypeRef, attr: CFTypeRef, out: *mut CFTypeRef) -> AXError;
    fn AXUIElementCopyMultipleAttributeValues(el: CFTypeRef, attrs: CFTypeRef, options: u32, out: *mut CFTypeRef) -> AXError;
    fn AXUIElementSetAttributeValue(el: CFTypeRef, attr: CFTypeRef, value: CFTypeRef) -> AXError;
    fn AXUIElementIsAttributeSettable(el: CFTypeRef, attr: CFTypeRef, out: *mut u8) -> AXError;
    fn AXUIElementPerformAction(el: CFTypeRef, action: CFTypeRef) -> AXError;
    fn AXUIElementCopyActionNames(el: CFTypeRef, out: *mut CFTypeRef) -> AXError;
    fn AXUIElementSetMessagingTimeout(el: CFTypeRef, seconds: f32) -> AXError;
    fn AXValueGetType(v: CFTypeRef) -> u32;
    fn AXValueGetValue(v: CFTypeRef, kind: u32, out: *mut c_void) -> u8;
    /// Private but long-standing (Hammerspoon, yabai): the CGWindowID behind
    /// an AX window, which is the one stable name a window has.
    fn _AXUIElementGetWindow(el: CFTypeRef, out: *mut u32) -> AXError;
    static kAXTrustedCheckOptionPrompt: CFTypeRef;

    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGEventSourceSecondsSinceLastEventType(state: i32, kind: u32) -> f64;
    fn CGEventCreate(source: CFTypeRef) -> CFTypeRef;
    fn CGEventGetLocation(ev: CFTypeRef) -> CGPoint;
    fn CGEventCreateKeyboardEvent(source: CFTypeRef, keycode: u16, down: bool) -> CFTypeRef;
    fn CGEventKeyboardSetUnicodeString(ev: CFTypeRef, len: usize, chars: *const u16);
    fn CGEventCreateMouseEvent(source: CFTypeRef, kind: u32, at: CGPoint, button: u32) -> CFTypeRef;
    fn CGEventSetIntegerValueField(ev: CFTypeRef, field: u32, value: i64);
    fn CGEventSetFlags(ev: CFTypeRef, flags: u64);
    fn CGEventPost(tap: u32, ev: CFTypeRef);
    fn CGEventPostToPid(pid: i32, ev: CFTypeRef);
    fn CGWarpMouseCursorPosition(to: CGPoint) -> i32;
    fn CGAssociateMouseAndMouseCursorPosition(connected: u32) -> i32;
}

#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn IsSecureEventInputEnabled() -> u8;
}

// ---------------------------------------------------------------------------
// Owned CF references
// ---------------------------------------------------------------------------

/// A retained CF object, released on drop.
pub struct Cf(CFTypeRef);

// SAFETY: CF objects are reference-counted with atomic retain/release, and the
// AX API may be called from any thread.
unsafe impl Send for Cf {}
unsafe impl Sync for Cf {}

impl Cf {
    /// Take ownership of a +1 reference from a Create/Copy call.
    fn owned(ptr: CFTypeRef) -> Option<Cf> {
        (!ptr.is_null()).then_some(Cf(ptr))
    }
    /// Retain a +0 reference, such as an array element.
    fn retained(ptr: CFTypeRef) -> Option<Cf> {
        (!ptr.is_null()).then(|| Cf(unsafe { CFRetain(ptr) }))
    }
    fn ptr(&self) -> CFTypeRef {
        self.0
    }
    fn type_id(&self) -> usize {
        unsafe { CFGetTypeID(self.0) }
    }
}

impl Clone for Cf {
    fn clone(&self) -> Self {
        Cf(unsafe { CFRetain(self.0) })
    }
}

impl Drop for Cf {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0) }
    }
}

fn cfstr(s: &str) -> Cf {
    let ptr = unsafe { CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as CFIndex, UTF8, 0) };
    Cf::owned(ptr).expect("CFStringCreateWithBytes")
}

fn string_of(v: &Cf) -> Option<String> {
    if v.type_id() != unsafe { CFStringGetTypeID() } {
        return None;
    }
    unsafe {
        let len = CFStringGetLength(v.ptr());
        let size = CFStringGetMaximumSizeForEncoding(len, UTF8) + 1;
        let mut buf = vec![0u8; size as usize];
        if CFStringGetCString(v.ptr(), buf.as_mut_ptr() as *mut c_char, size, UTF8) == 0 {
            return None;
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        Some(String::from_utf8_lossy(&buf[..end]).into_owned())
    }
}

fn bool_of(v: &Cf) -> Option<bool> {
    (v.type_id() == unsafe { CFBooleanGetTypeID() }).then(|| unsafe { CFBooleanGetValue(v.ptr()) != 0 })
}

fn number_of(v: &Cf) -> Option<f64> {
    if v.type_id() != unsafe { CFNumberGetTypeID() } {
        return None;
    }
    let mut out = 0f64;
    let ok = unsafe { CFNumberGetValue(v.ptr(), kCFNumberFloat64Type, &mut out as *mut f64 as *mut c_void) };
    (ok != 0).then_some(out)
}

fn array_of(v: &Cf) -> Option<Vec<Cf>> {
    if v.type_id() != unsafe { CFArrayGetTypeID() } {
        return None;
    }
    let n = unsafe { CFArrayGetCount(v.ptr()) };
    Some((0..n).filter_map(|i| Cf::retained(unsafe { CFArrayGetValueAtIndex(v.ptr(), i) })).collect())
}

fn is_ax_value(v: &Cf) -> bool {
    v.type_id() == unsafe { AXValueGetTypeID() }
}

fn point_of(v: &Cf) -> Option<CGPoint> {
    if !is_ax_value(v) || unsafe { AXValueGetType(v.ptr()) } != kAXValueCGPointType {
        return None;
    }
    let mut p = CGPoint::default();
    (unsafe { AXValueGetValue(v.ptr(), kAXValueCGPointType, &mut p as *mut _ as *mut c_void) } != 0).then_some(p)
}

fn size_of(v: &Cf) -> Option<CGSize> {
    if !is_ax_value(v) || unsafe { AXValueGetType(v.ptr()) } != kAXValueCGSizeType {
        return None;
    }
    let mut s = CGSize::default();
    (unsafe { AXValueGetValue(v.ptr(), kAXValueCGSizeType, &mut s as *mut _ as *mut c_void) } != 0).then_some(s)
}

/// A failed slot in a multiple-attribute copy comes back as an AXValue of the
/// error type rather than as nothing.
fn is_error_value(v: &Cf) -> bool {
    is_ax_value(v) && unsafe { AXValueGetType(v.ptr()) } == kAXValueAXErrorType
}

// ---------------------------------------------------------------------------
// AX helpers
// ---------------------------------------------------------------------------

/// Set once: every AX call is bounded, so a hung app cannot stall a turn.
static TIMEOUT_SET: Lazy<()> = Lazy::new(|| unsafe {
    if let Some(sys) = Cf::owned(AXUIElementCreateSystemWide()) {
        AXUIElementSetMessagingTimeout(sys.ptr(), 1.5);
    }
});

fn attr(el: &Cf, name: &str) -> std::result::Result<Cf, AXError> {
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(el.ptr(), cfstr(name).ptr(), &mut out) };
    if err != kAXErrorSuccess {
        return Err(err);
    }
    Cf::owned(out).ok_or(kAXErrorNoValue)
}

fn attr_string(el: &Cf, name: &str) -> Option<String> {
    attr(el, name).ok().as_ref().and_then(string_of)
}

fn settable(el: &Cf, name: &str) -> bool {
    let mut out = 0u8;
    let err = unsafe { AXUIElementIsAttributeSettable(el.ptr(), cfstr(name).ptr(), &mut out) };
    err == kAXErrorSuccess && out != 0
}

fn set_attr(el: &Cf, name: &str, value: &Cf) -> AXError {
    unsafe { AXUIElementSetAttributeValue(el.ptr(), cfstr(name).ptr(), value.ptr()) }
}

fn set_true(el: &Cf, name: &str) -> AXError {
    unsafe { AXUIElementSetAttributeValue(el.ptr(), cfstr(name).ptr(), kCFBooleanTrue) }
}

fn action_names(el: &Cf) -> Vec<String> {
    let mut out: CFTypeRef = std::ptr::null();
    if unsafe { AXUIElementCopyActionNames(el.ptr(), &mut out) } != kAXErrorSuccess {
        return Vec::new();
    }
    Cf::owned(out)
        .as_ref()
        .and_then(array_of)
        .map(|names| names.iter().filter_map(string_of).collect())
        .unwrap_or_default()
}

fn accessibility_blocked() -> Blocked {
    Blocked {
        reason: "Nyra needs Accessibility permission to read and operate other apps".into(),
        fix: Some(Fix {
            label: "Open Accessibility settings".into(),
            target: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility".into(),
        }),
    }
}

fn ax_error(code: AXError) -> DesktopError {
    match code {
        kAXErrorAPIDisabled => DesktopError::Blocked(accessibility_blocked()),
        kAXErrorInvalidUIElement => DesktopError::Gone,
        kAXErrorAttributeUnsupported | kAXErrorActionUnsupported | kAXErrorNotImplemented => {
            DesktopError::Unsupported("the element does not offer that".into())
        }
        kAXErrorCannotComplete => DesktopError::Failed("the app did not answer in time".into()),
        other => DesktopError::Failed(format!("the app refused (accessibility error {other})")),
    }
}

fn app_element(pid: u32) -> Cf {
    Lazy::force(&TIMEOUT_SET);
    let el = Cf::owned(unsafe { AXUIElementCreateApplication(pid as i32) }).expect("AXUIElementCreateApplication");
    // Chromium and Electron build their tree only for a client that asks this
    // way. Everyone else ignores it.
    set_true(&el, "AXManualAccessibility");
    el
}

// ---------------------------------------------------------------------------
// Roles and the tree
// ---------------------------------------------------------------------------

/// What `element_tree` fetches per element, in one round trip. Order matters:
/// the indexes below read it back.
const ATTRS: [&str; 11] = [
    "AXRole",
    "AXSubrole",
    "AXTitle",
    "AXDescription",
    "AXValue",
    "AXPosition",
    "AXSize",
    "AXEnabled",
    "AXFocused",
    "AXChildren",
    "AXPlaceholderValue",
];

static ATTR_ARRAY: Lazy<Cf> = Lazy::new(|| {
    let strings: Vec<Cf> = ATTRS.iter().map(|a| cfstr(a)).collect();
    let ptrs: Vec<CFTypeRef> = strings.iter().map(Cf::ptr).collect();
    Cf::owned(unsafe { CFArrayCreate(std::ptr::null(), ptrs.as_ptr(), ptrs.len() as CFIndex, &kCFTypeArrayCallBacks) })
        .expect("CFArrayCreate")
});

fn multi(el: &Cf) -> std::result::Result<Vec<Option<Cf>>, AXError> {
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyMultipleAttributeValues(el.ptr(), ATTR_ARRAY.ptr(), 0, &mut out) };
    if err != kAXErrorSuccess {
        return Err(err);
    }
    let values = Cf::owned(out).as_ref().and_then(array_of).unwrap_or_default();
    Ok((0..ATTRS.len())
        .map(|i| values.get(i).filter(|v| !is_error_value(v)).cloned())
        .collect())
}

fn words(ax: &str) -> String {
    let name = ax.strip_prefix("AX").unwrap_or(ax);
    let mut out = String::new();
    for (i, c) in name.chars().enumerate() {
        if c.is_uppercase() && i > 0 {
            out.push(' ');
        }
        out.push(c.to_ascii_lowercase());
    }
    out
}

fn role_of(role: &str, subrole: &str) -> Role {
    match (role, subrole) {
        (_, "AXSecureTextField") => Role::TextField,
        (_, "AXTabButton") => Role::Tab,
        ("AXButton", _) => Role::Button,
        ("AXTextField" | "AXSearchField" | "AXComboBox", _) => Role::TextField,
        ("AXTextArea", _) => Role::TextArea,
        ("AXCheckBox", "AXToggle") => Role::Button,
        ("AXCheckBox", _) => Role::Checkbox,
        ("AXRadioButton", _) => Role::Radio,
        ("AXMenuItem" | "AXMenuBarItem", _) => Role::MenuItem,
        ("AXPopUpButton" | "AXMenuButton", _) => Role::MenuButton,
        ("AXLink", _) => Role::Link,
        ("AXStaticText" | "AXHeading", _) => Role::Text,
        ("AXImage", _) => Role::Image,
        ("AXGroup" | "AXScrollArea" | "AXSplitGroup" | "AXLayoutArea" | "AXLayoutItem" | "AXUnknown" | "AXWebArea"
        | "AXTabGroup" | "AXMenu" | "AXMenuBar", _) => Role::Group,
        ("AXList" | "AXOutline" | "AXTable" | "AXBrowser" | "AXGrid", _) => Role::List,
        ("AXRow", _) => Role::Row,
        ("AXCell", _) => Role::Cell,
        ("AXToolbar", _) => Role::Toolbar,
        ("AXSlider", _) => Role::Slider,
        ("AXWindow", _) => Role::Other("window".into()),
        (other, _) => Role::Other(words(other)),
    }
}

/// A value, as words. A checkbox's 0/1 is "off"/"on", not a number.
fn value_text(role: &Role, v: &Cf) -> Option<String> {
    if let Some(s) = string_of(v) {
        return Some(s);
    }
    if let Some(n) = number_of(v) {
        return Some(match role {
            Role::Checkbox | Role::Radio | Role::Button => match n as i64 {
                0 => "off".into(),
                1 => "on".into(),
                _ => "mixed".into(),
            },
            _ if n.fract() == 0.0 => format!("{}", n as i64),
            _ => format!("{n:.2}"),
        });
    }
    bool_of(v).map(|b| if b { "on".into() } else { "off".into() })
}

/// Window furniture: present in every document window, pressed by nobody who
/// is not dragging it. A TextEdit snapshot was fifteen lines of these under
/// the one text area that mattered.
const FURNITURE: &[&str] = &["AXScrollBar", "AXRuler", "AXRulerMarker", "AXValueIndicator", "AXGrowArea", "AXSplitter"];

/// `None` for furniture, so the tree never carries it.
fn walk(el: &Cf, depth: usize, limits: Limits, count: &mut usize, keep_frames: bool) -> Option<RawElement<Handle>> {
    let v = multi(el).unwrap_or_else(|_| vec![None; ATTRS.len()]);
    let s = |i: usize| v[i].as_ref().and_then(string_of).unwrap_or_default();
    let ax_role = s(0);
    if FURNITURE.contains(&ax_role.as_str()) {
        return None;
    }
    let subrole = s(1);
    let role = role_of(&ax_role, &subrole);

    let mut label = s(2);
    if label.is_empty() {
        label = s(3);
    }
    let mut value = v[4].as_ref().and_then(|x| value_text(&role, x));
    // Static text carries its words as its value; they are its label.
    if role == Role::Text && label.is_empty() {
        label = value.take().unwrap_or_default();
    }
    if label.is_empty() {
        label = s(10);
    }
    // The title-bar buttons are named only by what they are.
    if label.is_empty() {
        label = match subrole.as_str() {
            "AXCloseButton" => "close".into(),
            "AXMinimizeButton" => "minimize".into(),
            "AXZoomButton" => "zoom".into(),
            "AXFullScreenButton" => "full screen".into(),
            _ => label,
        };
    }

    let frame = if keep_frames {
        match (v[5].as_ref().and_then(point_of), v[6].as_ref().and_then(size_of)) {
            (Some(p), Some(sz)) => Some(Rect { x: p.x, y: p.y, w: sz.width, h: sz.height }),
            _ => None,
        }
    } else {
        None
    };
    let secure = subrole == "AXSecureTextField";
    if secure {
        value = None;
    }

    let kids = v[9].as_ref().and_then(array_of).unwrap_or_default();
    let mut children = Vec::new();
    let mut children_truncated = false;
    if depth >= limits.max_depth {
        children_truncated = !kids.is_empty();
    } else {
        for kid in &kids {
            if *count >= limits.max_nodes {
                children_truncated = true;
                break;
            }
            *count += 1;
            children.extend(walk(kid, depth + 1, limits, count, keep_frames));
        }
    }

    Some(RawElement {
        handle: Handle(el.clone()),
        role,
        label,
        value,
        frame,
        enabled: v[7].as_ref().and_then(bool_of).unwrap_or(true),
        focused: v[8].as_ref().and_then(bool_of).unwrap_or(false),
        offscreen: None,
        secure,
        children,
        children_truncated,
    })
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

fn window_key(win: &Cf, index: usize, title: &str) -> WindowKey {
    let mut id = 0u32;
    if unsafe { _AXUIElementGetWindow(win.ptr(), &mut id) } == kAXErrorSuccess && id != 0 {
        WindowKey(format!("cg:{id}"))
    } else {
        WindowKey(format!("i:{index}:{title}"))
    }
}

fn frame_of(el: &Cf) -> Option<Rect> {
    let p = attr(el, "AXPosition").ok().as_ref().and_then(point_of)?;
    let s = attr(el, "AXSize").ok().as_ref().and_then(size_of)?;
    Some(Rect { x: p.x, y: p.y, w: s.width, h: s.height })
}

/// The app's windows, as (key, element, info). Minimised ones are left out:
/// nothing in them can be seen or pressed.
fn windows_of(app: &AppInfo) -> Result<Vec<(Cf, WindowInfo)>> {
    let el = app_element(app.pid);
    let list = match attr(&el, "AXWindows") {
        Ok(v) => array_of(&v).unwrap_or_default(),
        Err(kAXErrorNoValue) | Err(kAXErrorAttributeUnsupported) => Vec::new(),
        Err(e) => return Err(ax_error(e)),
    };
    let focused = attr(&el, "AXFocusedWindow").ok();
    let mut out = Vec::new();
    for (i, win) in list.into_iter().enumerate() {
        if attr(&win, "AXMinimized").ok().as_ref().and_then(bool_of) == Some(true) {
            continue;
        }
        let title = attr_string(&win, "AXTitle").unwrap_or_default();
        let is_focused = focused.as_ref().is_some_and(|f| unsafe { CFEqual(f.ptr(), win.ptr()) } != 0);
        let info = WindowInfo {
            key: window_key(&win, i, &title),
            title,
            frame: frame_of(&win),
            focused: is_focused,
            blocked: None,
        };
        out.push((win, info));
    }
    Ok(out)
}

fn find_window(app: &AppInfo, key: &WindowKey) -> Result<Cf> {
    windows_of(app)?
        .into_iter()
        .find(|(_, w)| &w.key == key)
        .map(|(el, _)| el)
        .ok_or(DesktopError::Gone)
}

// ---------------------------------------------------------------------------
// NSWorkspace
// ---------------------------------------------------------------------------

fn ns(s: &str) -> Retained<NSString> {
    NSString::from_str(s)
}

fn workspace() -> Retained<AnyObject> {
    unsafe { msg_send![class!(NSWorkspace), sharedWorkspace] }
}

fn running_app(pid: u32) -> Option<Retained<AnyObject>> {
    unsafe { msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid as i32] }
}

/// Bring `app` to the front, and the window with it. The user sees this, and
/// the result says so.
fn activate(app: &AppInfo, window: Option<&Cf>) {
    autoreleasepool(|_| {
        if let Some(running) = running_app(app.pid) {
            // NSApplicationActivateIgnoringOtherApps
            let _: bool = unsafe { msg_send![&*running, activateWithOptions: 2usize] };
        }
    });
    if let Some(win) = window {
        unsafe { AXUIElementPerformAction(win.ptr(), cfstr("AXRaise").ptr()) };
    }
    std::thread::sleep(Duration::from_millis(150));
}

fn path_for_app(query: &str) -> Option<String> {
    autoreleasepool(|_| unsafe {
        let ws = workspace();
        let looks_like_id = query.contains('.') && !query.contains(' ') && !query.ends_with(".app");
        if looks_like_id {
            let url: Option<Retained<AnyObject>> =
                msg_send![&*ws, URLForApplicationWithBundleIdentifier: &*ns(query)];
            if let Some(url) = url {
                let path: Option<Retained<NSString>> = msg_send![&*url, path];
                return path.map(|p| p.to_string());
            }
        }
        let path: Option<Retained<NSString>> = msg_send![&*ws, fullPathForApplication: &*ns(query)];
        path.map(|p| p.to_string())
    })
}

fn bundle_id_at(path: &str) -> Option<String> {
    autoreleasepool(|_| unsafe {
        let bundle: Option<Retained<AnyObject>> = msg_send![class!(NSBundle), bundleWithPath: &*ns(path)];
        let bundle = bundle?;
        let id: Option<Retained<NSString>> = msg_send![&*bundle, bundleIdentifier];
        id.map(|s| s.to_string())
    })
}

fn open_url(url: Retained<AnyObject>) -> bool {
    unsafe { msg_send![&*workspace(), openURL: &*url] }
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

/// ANSI virtual key codes. A character not here is sent as a Unicode string.
fn keycode(key: &Key) -> Option<u16> {
    Some(match key {
        Key::Return => 36,
        Key::Tab => 48,
        Key::Space => 49,
        Key::Delete => 51,
        Key::Escape => 53,
        Key::ForwardDelete => 117,
        Key::Home => 115,
        Key::End => 119,
        Key::PageUp => 116,
        Key::PageDown => 121,
        Key::Left => 123,
        Key::Right => 124,
        Key::Down => 125,
        Key::Up => 126,
        Key::F(n) => match n {
            1 => 122,
            2 => 120,
            3 => 99,
            4 => 118,
            5 => 96,
            6 => 97,
            7 => 98,
            8 => 100,
            9 => 101,
            10 => 109,
            11 => 103,
            12 => 111,
            _ => return None,
        },
        Key::Char(c) => match c {
            'a' => 0, 's' => 1, 'd' => 2, 'f' => 3, 'h' => 4, 'g' => 5, 'z' => 6, 'x' => 7,
            'c' => 8, 'v' => 9, 'b' => 11, 'q' => 12, 'w' => 13, 'e' => 14, 'r' => 15,
            'y' => 16, 't' => 17, '1' => 18, '2' => 19, '3' => 20, '4' => 21, '6' => 22,
            '5' => 23, '=' => 24, '9' => 25, '7' => 26, '-' => 27, '8' => 28, '0' => 29,
            ']' => 30, 'o' => 31, 'u' => 32, '[' => 33, 'i' => 34, 'p' => 35, 'l' => 37,
            'j' => 38, '\'' => 39, 'k' => 40, ';' => 41, '\\' => 42, ',' => 43, '/' => 44,
            'n' => 45, 'm' => 46, '.' => 47, '`' => 50,
            _ => return None,
        },
    })
}

fn secure_input_on() -> bool {
    unsafe { IsSecureEventInputEnabled() != 0 }
}

fn secure_input_blocked() -> DesktopError {
    DesktopError::Blocked(Blocked {
        reason: "secure keyboard entry is on (a password field has focus somewhere, or a terminal's Secure Keyboard Entry is enabled), so macOS would drop every keystroke".into(),
        fix: None,
    })
}

/// Keystrokes that insert `text`, posted to one app.
fn post_text(pid: u32, text: &str) {
    let units: Vec<u16> = text.encode_utf16().collect();
    for piece in units.chunks(16) {
        for down in [true, false] {
            let Some(ev) = Cf::owned(unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), 0, down) }) else {
                continue;
            };
            unsafe {
                CGEventKeyboardSetUnicodeString(ev.ptr(), piece.len(), piece.as_ptr());
                CGEventPostToPid(pid as i32, ev.ptr());
            }
        }
        std::thread::sleep(Duration::from_millis(8));
    }
}

// ---------------------------------------------------------------------------
// The lists
// ---------------------------------------------------------------------------

const TERMINAL: &str = "Claude already has a shell; driving a terminal window only reaches sessions it should not, like a sudo prompt or an ssh login";
const PASSWORDS: &str = "it is a password manager";

const BLOCKLIST: &[BlockRule] = &[
    BlockRule { id: Some("com.nyra.app"), name: Some("Nyra"), title: None, why: "it is Nyra itself" },
    BlockRule { id: Some("com.apple.keychainaccess"), name: Some("Keychain Access"), title: None, why: "it stores your passwords and certificates" },
    BlockRule { id: Some("com.apple.systempreferences"), name: Some("System Settings"), title: None, why: "System Settings holds the privacy and security switches that only you should flip (settings like dark mode are reachable with `defaults` or `osascript` instead)" },
    BlockRule { id: Some("com.apple.Passwords"), name: Some("Passwords"), title: None, why: PASSWORDS },
    BlockRule { id: Some("com.apple.SecurityAgent"), name: None, title: None, why: "it asks for your password or Touch ID" },
    BlockRule { id: Some("com.apple.LocalAuthentication.UIAgent"), name: None, title: None, why: "it asks for your password or Touch ID" },
    BlockRule { id: Some("com.apple.Terminal"), name: Some("Terminal"), title: None, why: TERMINAL },
    BlockRule { id: Some("com.googlecode.iterm2"), name: Some("iTerm2"), title: None, why: TERMINAL },
    BlockRule { id: Some("dev.warp.*"), name: Some("Warp"), title: None, why: TERMINAL },
    BlockRule { id: Some("com.mitchellh.ghostty"), name: Some("Ghostty"), title: None, why: TERMINAL },
    BlockRule { id: Some("net.kovidgoyal.kitty"), name: Some("kitty"), title: None, why: TERMINAL },
    BlockRule { id: Some("org.alacritty"), name: Some("Alacritty"), title: None, why: TERMINAL },
    BlockRule { id: Some("io.alacritty"), name: None, title: None, why: TERMINAL },
    BlockRule { id: Some("com.github.wez.wezterm"), name: Some("WezTerm"), title: None, why: TERMINAL },
    BlockRule { id: Some("co.zeit.hyper"), name: Some("Hyper"), title: None, why: TERMINAL },
    BlockRule { id: Some("com.1password.*"), name: Some("1Password"), title: None, why: PASSWORDS },
    BlockRule { id: Some("com.agilebits.onepassword*"), name: Some("1Password 7"), title: None, why: PASSWORDS },
    BlockRule { id: Some("com.bitwarden.desktop"), name: Some("Bitwarden"), title: None, why: PASSWORDS },
    BlockRule { id: Some("com.lastpass.*"), name: Some("LastPass"), title: None, why: PASSWORDS },
    BlockRule { id: Some("org.keepassxc.keepassxc"), name: Some("KeePassXC"), title: None, why: PASSWORDS },
    BlockRule { id: Some("in.sinew.Enpass*"), name: Some("Enpass"), title: None, why: PASSWORDS },
    BlockRule { id: Some("me.proton.pass*"), name: Some("Proton Pass"), title: None, why: PASSWORDS },
    BlockRule { id: Some("com.dashlane.*"), name: Some("Dashlane"), title: None, why: PASSWORDS },
    BlockRule { id: Some("com.keepersecurity.*"), name: Some("Keeper Password Manager"), title: None, why: PASSWORDS },
];

const FILES: &str = "Finder can read, move or delete any file";
const CODE: &str = "an editor can run code, the same as shell access";
const WEB: &str = "for web pages, Nyra's own browser is the better tool";

const WARNLIST: &[WarnRule] = &[
    WarnRule { id: Some("com.apple.finder"), name: None, text: FILES },
    WarnRule { id: Some("com.microsoft.VSCode"), name: None, text: CODE },
    WarnRule { id: Some("com.todesktop.230313mzl4w4u92"), name: Some("Cursor"), text: CODE },
    WarnRule { id: Some("dev.zed.Zed*"), name: None, text: CODE },
    WarnRule { id: Some("com.apple.dt.Xcode"), name: None, text: CODE },
    WarnRule { id: Some("com.jetbrains.*"), name: None, text: CODE },
    WarnRule { id: Some("com.sublimetext.*"), name: None, text: CODE },
    WarnRule { id: Some("com.apple.Safari"), name: None, text: WEB },
    WarnRule { id: Some("com.google.Chrome*"), name: None, text: WEB },
    WarnRule { id: Some("org.mozilla.firefox"), name: None, text: WEB },
    WarnRule { id: Some("company.thebrowser.Browser"), name: None, text: WEB },
    WarnRule { id: Some("com.brave.Browser"), name: None, text: WEB },
    WarnRule { id: Some("com.microsoft.edgemac"), name: None, text: WEB },
];

// ---------------------------------------------------------------------------
// The backend
// ---------------------------------------------------------------------------

/// An AX element.
#[derive(Clone)]
pub struct Handle(Cf);

pub struct Native;

impl Native {
    pub fn new() -> Self {
        Native
    }
}

impl Backend for Native {
    type Handle = Handle;

    fn blocklist(&self) -> &'static [BlockRule] {
        BLOCKLIST
    }

    fn warnlist(&self) -> &'static [WarnRule] {
        WARNLIST
    }

    /// Bundle ids, case-insensitively, with a trailing `*` for a family.
    fn app_matches(&self, id: &AppId, pattern: &str) -> bool {
        let id = id.0.to_ascii_lowercase();
        let pattern = pattern.to_ascii_lowercase();
        match pattern.strip_suffix('*') {
            Some(prefix) => id.starts_with(prefix),
            None => id == pattern,
        }
    }

    fn mod_is_cmd(&self) -> bool {
        true
    }

    fn permissions(&self) -> Vec<PermissionEntry> {
        let ax = accessibility_blocked();
        vec![
            PermissionEntry {
                kind: PermissionKind::ControlInput,
                granted: unsafe { AXIsProcessTrusted() != 0 },
                reason: ax.reason,
                fix: ax.fix,
            },
            PermissionEntry {
                kind: PermissionKind::CaptureScreen,
                granted: unsafe { CGPreflightScreenCaptureAccess() },
                reason: "Nyra needs Screen Recording permission to take pictures of other apps' windows".into(),
                fix: Some(Fix {
                    label: "Open Screen Recording settings".into(),
                    target: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture".into(),
                }),
            },
        ]
    }

    fn request_permission(&self, kind: PermissionKind) -> bool {
        match kind {
            PermissionKind::ControlInput => unsafe {
                let key = kAXTrustedCheckOptionPrompt;
                let value = kCFBooleanTrue;
                let dict = Cf::owned(CFDictionaryCreate(
                    std::ptr::null(),
                    &key,
                    &value,
                    1,
                    &kCFTypeDictionaryKeyCallBacks,
                    &kCFTypeDictionaryValueCallBacks,
                ));
                match dict {
                    Some(d) => AXIsProcessTrustedWithOptions(d.ptr()) != 0,
                    None => AXIsProcessTrusted() != 0,
                }
            },
            PermissionKind::CaptureScreen => unsafe { CGRequestScreenCaptureAccess() },
        }
    }

    fn list_apps(&self) -> Result<Vec<AppInfo>> {
        autoreleasepool(|_| unsafe {
            let ws = workspace();
            let apps: Retained<AnyObject> = msg_send![&*ws, runningApplications];
            let n: usize = msg_send![&*apps, count];
            let mut out = Vec::new();
            for i in 0..n {
                let app: Retained<AnyObject> = msg_send![&*apps, objectAtIndex: i];
                // Regular apps only: the ones with a Dock icon and windows.
                let policy: isize = msg_send![&*app, activationPolicy];
                if policy != 0 {
                    continue;
                }
                let pid: i32 = msg_send![&*app, processIdentifier];
                let name: Option<Retained<NSString>> = msg_send![&*app, localizedName];
                let id: Option<Retained<NSString>> = msg_send![&*app, bundleIdentifier];
                let active: bool = msg_send![&*app, isActive];
                let name = name.map(|s| s.to_string()).unwrap_or_default();
                let id = id.map(|s| s.to_string()).unwrap_or_else(|| format!("pid:{pid}:{name}"));
                out.push(AppInfo { id: AppId(id), name, pid: pid as u32, frontmost: active });
            }
            Ok(out)
        })
    }

    fn find_app(&self, query: &str) -> Option<(AppId, String)> {
        let path = path_for_app(query)?;
        let name = std::path::Path::new(&path)
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| query.to_string());
        let id = bundle_id_at(&path).unwrap_or(path);
        Some((AppId(id), name))
    }

    fn list_windows(&self, app: &AppInfo) -> Result<Vec<WindowInfo>> {
        Ok(windows_of(app)?.into_iter().map(|(_, w)| w).collect())
    }

    fn element_tree(&self, app: &AppInfo, window: &WindowKey, limits: Limits) -> Result<RawElement<Handle>> {
        let win = find_window(app, window)?;
        let mut count = 0;
        walk(&win, 0, limits, &mut count, true).ok_or(DesktopError::Gone)
    }

    fn menu_bar(&self, app: &AppInfo, limits: Limits) -> Result<RawElement<Handle>> {
        let el = app_element(app.pid);
        let bar = attr(&el, "AXMenuBar").map_err(ax_error)?;
        let mut count = 0;
        // No frames: a closed menu's items have none worth pruning by, and they
        // are still pressable.
        walk(&bar, 0, limits, &mut count, false).ok_or(DesktopError::Gone)
    }

    fn is_alive(&self, h: &Handle) -> bool {
        !matches!(attr(&h.0, "AXRole"), Err(kAXErrorInvalidUIElement))
    }

    fn is_secure(&self, h: &Handle) -> bool {
        attr_string(&h.0, "AXSubrole").as_deref() == Some("AXSecureTextField")
    }

    fn read_value(&self, h: &Handle) -> Option<String> {
        if self.is_secure(h) {
            return None;
        }
        attr_string(&h.0, "AXValue")
    }

    fn perform(&self, h: &Handle, action: &Action) -> Result<Raised> {
        let el = &h.0;
        match action {
            Action::Press => {
                let names = action_names(el);
                let chosen = ["AXPress", "AXConfirm", "AXPick", "AXOpen"]
                    .into_iter()
                    .find(|a| names.iter().any(|n| n == a));
                let Some(name) = chosen else {
                    return Err(DesktopError::Unsupported("it has no press action".into()));
                };
                match unsafe { AXUIElementPerformAction(el.ptr(), cfstr(name).ptr()) } {
                    kAXErrorSuccess => Ok(Raised(false)),
                    // A press that opens a modal sheet blocks until the sheet
                    // closes, so the call times out having worked.
                    kAXErrorCannotComplete => Ok(Raised(false)),
                    e => Err(ax_error(e)),
                }
            }
            Action::Focus => match set_true(el, "AXFocused") {
                kAXErrorSuccess => Ok(Raised(false)),
                e => Err(ax_error(e)),
            },
            Action::SetValue(text) => {
                if !settable(el, "AXValue") {
                    return Err(DesktopError::Unsupported("its value cannot be set".into()));
                }
                match set_attr(el, "AXValue", &cfstr(text)) {
                    kAXErrorSuccess => Ok(Raised(false)),
                    e => Err(ax_error(e)),
                }
            }
        }
    }

    fn type_text(&self, app: &AppInfo, h: &Handle, text: &str) -> Result<Raised> {
        let el = &h.0;
        // Inserting at the caret through the tree needs no focus and sends no
        // keystrokes. Some apps accept it and ignore it, so check it landed.
        if settable(el, "AXSelectedText") {
            let before = attr_string(el, "AXValue");
            if set_attr(el, "AXSelectedText", &cfstr(text)) == kAXErrorSuccess {
                let after = attr_string(el, "AXValue");
                if before.is_none() || after != before {
                    return Ok(Raised(false));
                }
            }
        }
        if secure_input_on() {
            return Err(secure_input_blocked());
        }
        set_true(el, "AXFocused");
        post_text(app.pid, text);
        Ok(Raised(false))
    }

    fn press_keys(&self, app: &AppInfo, window: &WindowKey, chord: &Chord) -> Result<Raised> {
        if secure_input_on() {
            return Err(secure_input_blocked());
        }
        let win = if window.0 == "menu" { None } else { find_window(app, window).ok() };
        activate(app, win.as_ref());

        let mut flags = 0u64;
        if chord.cmd {
            flags |= FLAG_CMD;
        }
        if chord.ctrl {
            flags |= FLAG_CTRL;
        }
        if chord.alt {
            flags |= FLAG_ALT;
        }
        if chord.shift {
            flags |= FLAG_SHIFT;
        }
        let code = keycode(&chord.key);
        for down in [true, false] {
            let Some(ev) = Cf::owned(unsafe { CGEventCreateKeyboardEvent(std::ptr::null(), code.unwrap_or(0), down) }) else {
                return Err(DesktopError::Failed("could not create a key event".into()));
            };
            unsafe {
                if code.is_none() {
                    if let Key::Char(c) = chord.key {
                        let units: Vec<u16> = c.to_string().encode_utf16().collect();
                        CGEventKeyboardSetUnicodeString(ev.ptr(), units.len(), units.as_ptr());
                    }
                }
                CGEventSetFlags(ev.ptr(), flags);
                // Posted to the app rather than the system, so the global Esc
                // Nyra holds while in control never sees Claude's own Escape.
                CGEventPostToPid(app.pid as i32, ev.ptr());
            }
            std::thread::sleep(Duration::from_millis(12));
        }
        Ok(Raised(true))
    }

    fn click_at(&self, app: &AppInfo, window: &WindowKey, point: Point) -> Result<Raised> {
        let win = if window.0 == "menu" { None } else { find_window(app, window).ok() };
        activate(app, win.as_ref());
        let at = CGPoint { x: point.x, y: point.y };
        unsafe {
            // Put the pointer back where the user left it afterwards.
            let home = Cf::owned(CGEventCreate(std::ptr::null())).map(|e| CGEventGetLocation(e.ptr()));
            for kind in [kCGEventMouseMoved, kCGEventLeftMouseDown, kCGEventLeftMouseUp] {
                let Some(ev) = Cf::owned(CGEventCreateMouseEvent(std::ptr::null(), kind, at, 0)) else {
                    return Err(DesktopError::Failed("could not create a click".into()));
                };
                if kind != kCGEventMouseMoved {
                    CGEventSetIntegerValueField(ev.ptr(), kCGMouseEventClickState, 1);
                }
                CGEventPost(kCGHIDEventTap, ev.ptr());
                std::thread::sleep(Duration::from_millis(30));
            }
            if let Some(home) = home {
                CGWarpMouseCursorPosition(home);
                CGAssociateMouseAndMouseCursorPosition(1);
            }
        }
        Ok(Raised(true))
    }

    fn capture_window(&self, _app: &AppInfo, _window: &WindowKey) -> Result<Vec<u8>> {
        Err(DesktopError::Unsupported("window screenshots are not built yet".into()))
    }

    fn open(&self, target: &Target) -> Result<String> {
        autoreleasepool(|_| unsafe {
            let (url, what): (Option<Retained<AnyObject>>, String) = match target {
                Target::App(name) => {
                    let path = path_for_app(name)
                        .ok_or_else(|| DesktopError::Failed(format!("no app called \"{name}\" is installed")))?;
                    let what = std::path::Path::new(&path)
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| name.clone());
                    (msg_send![class!(NSURL), fileURLWithPath: &*ns(&path)], what)
                }
                Target::Path(p) => {
                    if !std::path::Path::new(p).exists() {
                        return Err(DesktopError::Failed(format!("{p} does not exist")));
                    }
                    (msg_send![class!(NSURL), fileURLWithPath: &*ns(p)], p.clone())
                }
                Target::Url(u) => (msg_send![class!(NSURL), URLWithString: &*ns(u)], u.clone()),
            };
            let url = url.ok_or_else(|| DesktopError::Failed("that is not something macOS can open".into()))?;
            if open_url(url) {
                Ok(what)
            } else {
                Err(DesktopError::Failed(format!("macOS would not open {what}")))
            }
        })
    }

    fn frontmost(&self) -> Option<AppId> {
        autoreleasepool(|_| unsafe {
            let app: Option<Retained<AnyObject>> = msg_send![&*workspace(), frontmostApplication];
            let id: Option<Retained<NSString>> = msg_send![&*app?, bundleIdentifier];
            id.map(|s| AppId(s.to_string()))
        })
    }

    fn seconds_since_user_input(&self) -> f64 {
        unsafe { CGEventSourceSecondsSinceLastEventType(kCGEventSourceStateHIDSystemState, kCGAnyInputEventType) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_roles_into_neutral_words() {
        assert_eq!(role_of("AXButton", ""), Role::Button);
        assert_eq!(role_of("AXTextField", "AXSecureTextField"), Role::TextField);
        assert_eq!(role_of("AXRadioButton", "AXTabButton"), Role::Tab);
        assert_eq!(role_of("AXDisclosureTriangle", ""), Role::Other("disclosure triangle".into()));
    }

    #[test]
    fn matches_bundle_ids_and_families() {
        let n = Native::new();
        assert!(n.app_matches(&AppId("com.1password.1password".into()), "com.1password.*"));
        assert!(n.app_matches(&AppId("com.apple.Terminal".into()), "com.apple.terminal"));
        assert!(!n.app_matches(&AppId("com.apple.TerminalX".into()), "com.apple.Terminal"));
    }

    /// Allows the apps it names and refuses the rest, printing what it is told.
    struct AllowOnly(&'static [&'static str]);

    impl Host for AllowOnly {
        fn ask_allow<'a>(
            &'a self,
            _chat: &'a str,
            app: &'a AppInfo,
            _warning: Option<&'static str>,
        ) -> BoxFuture<'a, std::result::Result<Answer, String>> {
            let yes = self.0.contains(&app.name.as_str());
            println!("  asked about {} -> {}", app.name, if yes { "this chat" } else { "no" });
            Box::pin(async move { Ok(if yes { Answer::ThisChat } else { Answer::No }) })
        }
        fn always_allowed(&self, _id: &AppId) -> bool {
            false
        }
        fn controlling(&self, _chat: &str, app: Option<&str>) {
            println!("  controlling: {app:?}");
        }
        fn blocked(&self, _chat: &str, kind: PermissionKind, b: &Blocked) {
            println!("  blocked {kind:?}: {}", b.reason);
        }
    }

    /// The phase 1 check on a real Mac: open TextEdit, type a line, read it
    /// back, then be refused Keychain Access. Needs Accessibility for whatever
    /// app runs it, and moves real windows — so ignored, and run by hand:
    /// `cargo test --lib drives_textedit_end_to_end -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn drives_textedit_end_to_end() {
        let d = Desktop::new(Native::new(), AllowOnly(&["TextEdit"]), GuardTiming::default());
        let chat = "e2e";
        let say = |label: &str, r: &std::result::Result<String, String>| match r {
            Ok(t) => println!("--- {label}\n{t}\n"),
            Err(e) => println!("--- {label} (refused)\n{e}\n"),
        };

        let opened = d.open(chat, "TextEdit").await;
        say("desktop_open TextEdit", &opened);
        opened.unwrap();
        tokio::time::sleep(Duration::from_secs(2)).await;

        let new_doc = d
            .act(chat, ActArgs { app: "TextEdit".into(), action: "keys".into(), keys: Some("cmd+n".into()), ..Default::default() })
            .await;
        say("keys cmd+n", &new_doc);
        new_doc.unwrap();
        tokio::time::sleep(Duration::from_secs(1)).await;

        let snap = d.snapshot(chat, "TextEdit", None, None).await;
        say("desktop_snapshot", &snap);
        let snap = snap.unwrap();
        let area = snap
            .lines()
            .find(|l| l.contains("] text area"))
            .and_then(|l| l.trim().split(']').next())
            .map(|r| r.trim_start_matches('[').to_string())
            .expect("a text area in the new document");

        let line = "Typed by Claude through Nyra desktop control.";
        let typed = d
            .act(chat, ActArgs { app: "TextEdit".into(), r#ref: Some(area), action: "type".into(), text: Some(line.into()), ..Default::default() })
            .await;
        say("desktop_act type", &typed);
        typed.unwrap();

        let again = d.snapshot(chat, "TextEdit", None, None).await;
        say("desktop_snapshot again", &again);
        assert!(again.unwrap().contains(line), "the line did not read back");

        let keychain = d.open(chat, "Keychain Access").await;
        say("desktop_open Keychain Access", &keychain);
        assert!(keychain.unwrap_err().contains("off limits"));

        let settings = d.open(chat, "System Settings").await;
        say("desktop_open System Settings", &settings);
        assert!(settings.unwrap_err().contains("off limits"));

        let terminal = d.open(chat, "Terminal").await;
        say("desktop_open Terminal", &terminal);
        assert!(terminal.unwrap_err().contains("off limits"));

        d.turn_ended(chat);
    }

    /// Preflight only: says whether the grants are held, and never prompts.
    #[test]
    #[ignore]
    fn reports_permissions_without_prompting() {
        for p in Native::new().permissions() {
            println!("{:?} granted={}", p.kind, p.granted);
        }
    }

    /// Reads this Mac's real app list without touching any app's UI. Needs no
    /// permission; ignored by default because CI has no window server.
    #[test]
    #[ignore]
    fn lists_real_apps() {
        let apps = Native::new().list_apps().unwrap();
        assert!(apps.iter().any(|a| a.id.0 == "com.apple.finder"), "{:?}", apps.iter().map(|a| &a.id).collect::<Vec<_>>());
    }
}
