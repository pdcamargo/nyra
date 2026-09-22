//! Red squiggles under misspellings, in every editable surface in the app.
//!
//! `spellcheck="true"` on the editable element — which is what `MarkdownEditor`
//! sets — only buys *on-demand* checking: the context menu finds mistakes, and
//! nothing is underlined while you type. Continuous checking is separate, and
//! it is UI-process-wide state in WebKit rather than anything a document can ask
//! for, so it has to be turned on from the Rust side.

#[cfg(target_os = "macos")]
mod imp {
    use objc2::runtime::AnyObject;
    use objc2::{msg_send, sel};
    use objc2_foundation::{NSDictionary, NSNumber, NSString, NSUserDefaults};

    /// WebKit's own key for "Check Spelling While Typing".
    const CONTINUOUS: &str = "WebContinuousSpellCheckingEnabled";

    /// Register continuous spell checking as on.
    ///
    /// WebKit initialises its text checker once, from this user default, before
    /// the first editable field is focused — which is why this runs at the top
    /// of `run()` rather than in `setup()`.
    ///
    /// It *registers* the default rather than writing it, so someone who turns
    /// "Check Spelling While Typing" off in the context menu stays off: WebKit
    /// persists that choice to this same key, and a written value beats a
    /// registered one. Nothing is written to disk, and nothing outside our own
    /// preference domain is read, so this raises no macOS privacy prompt.
    pub fn register_default() {
        let key = NSString::from_str(CONTINUOUS);
        let on = NSNumber::numberWithBool(true);
        let on: &AnyObject = &on;
        let registration = NSDictionary::<NSString, AnyObject>::from_slices(&[&*key], &[on]);

        // SAFETY: the registration domain takes exactly this — string keys to
        // property-list values.
        unsafe { NSUserDefaults::standardUserDefaults().registerDefaults(&registration) };
    }

    /// Backstop once the WKWebView exists: if the registered default didn't
    /// take, flip the switch on the view itself.
    ///
    /// Both selectors are WebKit private API, so neither is assumed. The state
    /// is only changed when it can first be *read* — toggling blind would turn
    /// continuous checking back off in the case where registering it worked.
    ///
    /// Must run on the main thread; `with_webview` guarantees that.
    pub fn sync_view(webview: *mut std::ffi::c_void) {
        if webview.is_null() {
            return;
        }
        // SAFETY: Tauri hands us this window's live WKWebView, on the main
        // thread. Every call below is guarded by `respondsToSelector:`.
        let view: &AnyObject = unsafe { &*(webview as *mut AnyObject) };

        let readable: bool =
            unsafe { msg_send![view, respondsToSelector: sel!(isContinuousSpellCheckingEnabled)] };
        if !readable {
            // Where this WebKit lands: the registered default is doing the
            // work, and there is no getter to confirm it from.
            crate::log!(
                "spellcheck",
                "no isContinuousSpellCheckingEnabled on WKWebView — left to the registered default"
            );
            return;
        }

        if unsafe { msg_send![view, isContinuousSpellCheckingEnabled] } {
            crate::log!("spellcheck", "continuous spell checking is on");
            return;
        }

        let togglable: bool =
            unsafe { msg_send![view, respondsToSelector: sel!(toggleContinuousSpellChecking:)] };
        if !togglable {
            crate::log!(
                "spellcheck",
                "continuous spell checking is off and the view will not toggle it"
            );
            return;
        }

        let _: () =
            unsafe { msg_send![view, toggleContinuousSpellChecking: std::ptr::null::<AnyObject>()] };
        let now: bool = unsafe { msg_send![view, isContinuousSpellCheckingEnabled] };
        crate::log!(
            "spellcheck",
            "toggled continuous spell checking on the view — now {}",
            if now { "on" } else { "still off" }
        );
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    /// Windows and Linux webviews spell-check from the element attribute alone.
    pub fn register_default() {}
    pub fn sync_view(_webview: *mut std::ffi::c_void) {}
}

pub use imp::{register_default, sync_view};
