//! Keeping the computer awake while Claude works.
//!
//! Off by default (`keep_awake` in settings). When it is on, Nyra holds one
//! power assertion for as long as anything is still going: a chat mid-turn, a
//! Monitor or background shell Claude started, a background subagent, or a
//! flow. It is let go the moment none of them is.
//!
//! The busy count lives here rather than in the renderer. The renderer's own
//! idea of a running turn is fed by `Chat`, which is unmounted whenever the
//! main view is something else — so a turn that ended while the Flows canvas
//! was open would stay "running" there, and hold the machine awake for good.
//! Every event reaches `claude::emit_event` whatever is on screen, which is
//! where `note_event` is called from.
//!
//! Only idle sleep is prevented. Closing a laptop's lid still sleeps it on both
//! OSes — nothing in user space can stop that without root, and nothing here
//! tries — and the power settings themselves are never touched.

use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

use once_cell::sync::Lazy;
use parking_lot::{Condvar, Mutex};
use serde::Serialize;
use serde_json::Value;

use crate::util;

/// What the settings pane and the title bar chip show.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// An assertion is held right now.
    pub holding: bool,
    /// Something is running, whether or not it is being held for — the pane
    /// says "on battery" rather than "nothing is running" when this is set and
    /// `holding` is not.
    pub busy: bool,
    pub on_battery: bool,
    /// Chats mid-turn. A flow's own chats are counted as the flow.
    pub chats: usize,
    pub monitors: usize,
    /// Background shells and subagents.
    pub tasks: usize,
    pub flows: usize,
    /// When the current hold began, in ms since the epoch.
    pub since: Option<i64>,
}

#[derive(Default)]
struct Busy {
    /// Chats with a turn in flight, by Nyra session id.
    turns: HashSet<String>,
    /// The CLI's background roster per chat: task ids. Shells and monitors are
    /// in it too; they are told apart from subagents by the process registry.
    roster: HashMap<String, Vec<String>>,
    last_event: Option<Instant>,
}

static BUSY: Lazy<Mutex<Busy>> = Lazy::new(|| Mutex::new(Busy::default()));
static STATUS: Lazy<Mutex<Status>> = Lazy::new(|| Mutex::new(Status::default()));
static WAKE: Lazy<(Mutex<bool>, Condvar)> = Lazy::new(|| (Mutex::new(false), Condvar::new()));

/// How long a hold can rest on background work alone with no event from any
/// chat. A shell whose pid was never found stays "untracked" — live as far as
/// the registry knows — and this is what stops that keeping a Mac up all week.
const QUIET_LIMIT: Duration = Duration::from_secs(4 * 60 * 60);

/// Battery state is polled, not subscribed to; this is how stale it can get.
const TICK: Duration = Duration::from_secs(5);

/// Every event a chat emits. Mirrors how the renderer tells a turn has started
/// (including one the CLI started by itself, when a background task reported
/// back) and ended.
pub fn note_event(nyra_session_id: &str, event: &Value) {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or_default();
    let changed = {
        let mut busy = BUSY.lock();
        busy.last_event = Some(Instant::now());
        match kind {
            "tool_start" | "assistant_text" | "thinking" => {
                busy.turns.insert(nyra_session_id.to_string())
            }
            "result" | "error" => busy.turns.remove(nyra_session_id),
            "stream_end" => {
                let a = busy.turns.remove(nyra_session_id);
                let b = busy.roster.remove(nyra_session_id).is_some();
                a || b
            }
            "background_tasks" => {
                let ids: Vec<String> = event
                    .get("tasks")
                    .and_then(Value::as_array)
                    .map(|tasks| {
                        tasks
                            .iter()
                            .filter_map(|t| t.get("task_id").and_then(Value::as_str))
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();
                if ids.is_empty() {
                    busy.roster.remove(nyra_session_id).is_some()
                } else {
                    busy.roster.insert(nyra_session_id.to_string(), ids);
                    true
                }
            }
            _ => false,
        }
    };
    if changed {
        poke();
    }
}

/// A prompt was just sent. Counted from here rather than from the first
/// streamed token, which can be seconds away.
pub fn turn_started(nyra_session_id: &str) {
    if BUSY.lock().turns.insert(nyra_session_id.to_string()) {
        poke();
    }
}

pub fn turn_ended(nyra_session_id: &str) {
    if BUSY.lock().turns.remove(nyra_session_id) {
        poke();
    }
}

/// The chat is gone; nothing of it should keep the machine up.
pub fn forget(nyra_session_id: &str) {
    let mut busy = BUSY.lock();
    let a = busy.turns.remove(nyra_session_id);
    let b = busy.roster.remove(nyra_session_id).is_some();
    drop(busy);
    if a || b {
        poke();
    }
}

/// Recompute now rather than at the next tick: a setting changed, a flow
/// started, a background process exited.
pub fn poke() {
    let (lock, cvar) = &*WAKE;
    *lock.lock() = true;
    cvar.notify_one();
}

pub fn status() -> Status {
    STATUS.lock().clone()
}

/// The thread that owns the assertion. One thread, so there is only ever one
/// hold however many things are running, and so Windows' power request is
/// created and cleared from the same place.
pub fn start() {
    std::thread::Builder::new()
        .name("keep-awake".into())
        .spawn(run)
        .ok();
}

fn run() {
    let mut hold: Option<(imp::Hold, bool)> = None;
    let mut since: Option<i64> = None;
    loop {
        let settings = util::settings();
        let counts = count();
        let on_battery = imp::on_battery();
        let busy = counts.total() > 0;
        let quiet = BUSY
            .lock()
            .last_event
            .is_some_and(|t| t.elapsed() > QUIET_LIMIT);
        let want = settings.keep_awake
            && busy
            && !(settings.keep_awake_only_on_ac && on_battery)
            && !(quiet && counts.chats == 0 && counts.flows == 0);
        let display = settings.keep_awake_display;

        match (&hold, want) {
            (Some((_, held_display)), true) if *held_display == display => {}
            (_, true) => {
                // A change of the display switch is a new hold, not an edit.
                drop(hold.take());
                hold = imp::hold(display, REASON).map(|h| (h, display));
                if hold.is_none() {
                    crate::logf!("keep-awake: the OS refused the power assertion");
                }
                since = since.or_else(|| Some(chrono::Utc::now().timestamp_millis()));
            }
            (Some(_), false) => {
                hold = None;
                since = None;
            }
            (None, false) => since = None,
        }

        let next = Status {
            holding: hold.is_some(),
            busy,
            on_battery,
            chats: counts.chats,
            monitors: counts.monitors,
            tasks: counts.tasks,
            flows: counts.flows,
            since: if hold.is_some() { since } else { None },
        };
        let changed = {
            let mut current = STATUS.lock();
            let changed = *current != next;
            *current = next.clone();
            changed
        };
        if changed {
            util::emit("keep-awake:update", next);
        }

        let (lock, cvar) = &*WAKE;
        let mut woken = lock.lock();
        if !*woken {
            cvar.wait_for(&mut woken, TICK);
        }
        *woken = false;
    }
}

const REASON: &str = "Nyra: Claude is working";

#[derive(Debug, Default, PartialEq)]
struct Counts {
    chats: usize,
    monitors: usize,
    tasks: usize,
    flows: usize,
}

impl Counts {
    fn total(&self) -> usize {
        self.chats + self.monitors + self.tasks + self.flows
    }
}

fn count() -> Counts {
    let (flows, flow_chats) = crate::workflow::engine::running();
    let background = crate::processes::live_background();
    let known = crate::processes::known_task_ids();
    let busy = BUSY.lock();
    tally(&busy, flows, &flow_chats, &background, &known)
}

/// The counting itself, apart from where its inputs come from.
fn tally(
    busy: &Busy,
    flows: usize,
    flow_chats: &HashSet<String>,
    background: &[crate::processes::ProcKind],
    known_tasks: &HashSet<String>,
) -> Counts {
    use crate::processes::ProcKind;
    let chats = busy.turns.iter().filter(|id| !flow_chats.contains(*id)).count();
    let monitors = background.iter().filter(|k| **k == ProcKind::Monitor).count();
    let shells = background.len() - monitors;
    // A roster entry the process registry has never heard of is a subagent.
    let agents = busy
        .roster
        .values()
        .flatten()
        .filter(|id| !known_tasks.contains(*id))
        .count();
    Counts { chats, monitors, tasks: shells + agents, flows }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;

    use objc2::rc::Retained;
    use objc2_foundation::NSString;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOPMAssertionCreateWithName(
            kind: *const c_void,
            level: u32,
            name: *const c_void,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
        fn IOPSCopyPowerSourcesInfo() -> *const c_void;
        fn IOPSGetProvidingPowerSourceType(snapshot: *const c_void) -> *const c_void;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFRelease(cf: *const c_void);
    }

    const LEVEL_ON: u32 = 255;

    /// Assertion ids, released on drop. macOS also releases them if the
    /// process dies, so a crash never leaves a Mac unable to sleep.
    pub struct Hold(Vec<u32>);

    impl Drop for Hold {
        fn drop(&mut self) {
            for id in &self.0 {
                unsafe { IOPMAssertionRelease(*id) };
            }
        }
    }

    /// Shows in `pmset -g assertions` under Nyra's name, with `reason`.
    pub fn hold(display: bool, reason: &str) -> Option<Hold> {
        let name = NSString::from_str(reason);
        let mut kinds = vec!["PreventUserIdleSystemSleep"];
        if display {
            kinds.push("PreventUserIdleDisplaySleep");
        }
        let mut ids = Vec::new();
        for kind in kinds {
            let kind = NSString::from_str(kind);
            let mut id = 0u32;
            // SAFETY: NSString is toll-free bridged to CFString; both outlive
            // the call, which copies what it keeps.
            let rc = unsafe {
                IOPMAssertionCreateWithName(
                    Retained::as_ptr(&kind).cast(),
                    LEVEL_ON,
                    Retained::as_ptr(&name).cast(),
                    &mut id,
                )
            };
            if rc == 0 {
                ids.push(id);
            }
        }
        (!ids.is_empty()).then_some(Hold(ids))
    }

    /// A desktop Mac reports "AC Power", so this is false there.
    pub fn on_battery() -> bool {
        unsafe {
            let info = IOPSCopyPowerSourcesInfo();
            if info.is_null() {
                return false;
            }
            let kind = IOPSGetProvidingPowerSourceType(info);
            let battery =
                !kind.is_null() && (*kind.cast::<NSString>()).to_string() == "Battery Power";
            CFRelease(info);
            battery
        }
    }
}

#[cfg(windows)]
mod imp {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Power::{
        GetSystemPowerStatus, PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired,
        PowerRequestSystemRequired, PowerSetRequest, SYSTEM_POWER_STATUS,
    };
    use windows::Win32::System::Threading::{
        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
    };

    /// A power request rather than `SetThreadExecutionState`: that belongs to
    /// the calling thread and carries no reason, where this is a handle, and
    /// shows in `powercfg /requests` as Nyra with `reason`.
    pub struct Hold {
        handle: isize,
        display: bool,
    }

    impl Drop for Hold {
        fn drop(&mut self) {
            let handle = HANDLE(self.handle as *mut _);
            unsafe {
                if self.display {
                    let _ = PowerClearRequest(handle, PowerRequestDisplayRequired);
                }
                let _ = PowerClearRequest(handle, PowerRequestSystemRequired);
                let _ = CloseHandle(handle);
            }
        }
    }

    pub fn hold(display: bool, reason: &str) -> Option<Hold> {
        let mut wide: Vec<u16> = reason.encode_utf16().chain(Some(0)).collect();
        let context = REASON_CONTEXT {
            // POWER_REQUEST_CONTEXT_VERSION
            Version: 0,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 { SimpleReasonString: PWSTR(wide.as_mut_ptr()) },
        };
        unsafe {
            let handle = PowerCreateRequest(&context).ok()?;
            if PowerSetRequest(handle, PowerRequestSystemRequired).is_err() {
                let _ = CloseHandle(handle);
                return None;
            }
            // Display-required only means anything alongside system-required.
            let display = display && PowerSetRequest(handle, PowerRequestDisplayRequired).is_ok();
            Some(Hold { handle: handle.0 as isize, display })
        }
    }

    /// 0 is offline; 255 (unknown) counts as plugged in.
    pub fn on_battery() -> bool {
        let mut status = SYSTEM_POWER_STATUS::default();
        unsafe { GetSystemPowerStatus(&mut status).is_ok() && status.ACLineStatus == 0 }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    pub struct Hold;

    pub fn hold(_display: bool, _reason: &str) -> Option<Hold> {
        None
    }

    pub fn on_battery() -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::processes::ProcKind;
    use serde_json::json;

    fn busy() -> Busy {
        Busy::default()
    }

    #[test]
    fn a_flow_chat_is_counted_as_the_flow() {
        let mut b = busy();
        b.turns.insert("chat".into());
        b.turns.insert("flow-node".into());
        let flow_chats = HashSet::from(["flow-node".to_string()]);
        let c = tally(&b, 1, &flow_chats, &[], &HashSet::new());
        assert_eq!(c, Counts { chats: 1, monitors: 0, tasks: 0, flows: 1 });
    }

    #[test]
    fn subagents_are_roster_entries_the_registry_does_not_know() {
        let mut b = busy();
        b.roster.insert("chat".into(), vec!["shell1".into(), "agent1".into()]);
        let known = HashSet::from(["shell1".to_string()]);
        let c = tally(&b, 0, &HashSet::new(), &[ProcKind::Shell, ProcKind::Monitor], &known);
        // shell1 is counted once, as a shell; agent1 as a subagent.
        assert_eq!(c, Counts { chats: 0, monitors: 1, tasks: 2, flows: 0 });
    }

    #[test]
    fn events_start_and_end_turns() {
        let id = "keep-awake-test-chat";
        note_event(id, &json!({ "type": "assistant_text", "text": "hi" }));
        assert!(BUSY.lock().turns.contains(id));
        note_event(id, &json!({ "type": "background_tasks", "tasks": [{ "task_id": "t1" }] }));
        note_event(id, &json!({ "type": "result" }));
        assert!(!BUSY.lock().turns.contains(id));
        assert!(BUSY.lock().roster.contains_key(id));
        note_event(id, &json!({ "type": "stream_end" }));
        assert!(!BUSY.lock().roster.contains_key(id));
    }
}
