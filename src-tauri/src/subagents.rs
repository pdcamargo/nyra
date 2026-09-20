//! Watching a subagent work, in real time.
//!
//! A subagent produced one of two things and never anything in between: a live
//! blue line, or its whole report at once when it finished. The reason is that
//! there are two spawn modes and Nyra understood neither.
//!
//! A foreground subagent's messages come down the same stdout as the parent's,
//! tagged with `parent_tool_use_id`. Nothing read that field, so they fell
//! through the ordinary handlers and landed in the transcript as if the parent
//! had said them. `note_inline` is that half.
//!
//! A background subagent — the default for the `Agent` tool, so the common case
//! — streams nothing at all. Its `Task` call answers in about two seconds with
//! a launch receipt and the report arrives minutes later. But it writes a live
//! JSONL transcript the whole time, and the `output_file` in that receipt is a
//! symlink to it. `watch` tails it.
//!
//! Both paths converge on `entries_from_line`, so the panel cannot tell which
//! kind of agent it is looking at.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::time::{Duration, Instant};

use crate::claude::emit_event;
use crate::util;

/// A tool result can be a whole file. The panel shows a trace line, not a dump.
const MAX_RESULT: usize = 4000;

/// One read per tick per agent. Enough to keep up with a chatty agent without
/// turning a catch-up read into a stall.
const MAX_READ: u64 = 512 * 1024;

/// Fast enough to read as live, slow enough that the stat costs nothing. The
/// process poller next door runs at 2s, which is visibly laggy for prose.
const TICK_MS: u64 = 500;

/// How long to keep reading after the agent reports finishing. Several ticks, so
/// a pump that was mid-read when the notification landed still gets its turn.
const CLOSING_GRACE: Duration = Duration::from_millis(2500);

struct Watch {
    path: String,
    offset: u64,
    /// The tail of a line split across two reads. Same discipline as the stdout
    /// reader: never parse half a JSON object.
    carry: String,
    model_sent: bool,
    /// The agent reported finishing; keep reading until this passes.
    ///
    /// `task_notification(completed)` beats the CLI's own last write to the file,
    /// so removing the watch on it loses the agent's closing message — the whole
    /// answer, in a short run. Seen exactly that way: the panel had the opening
    /// line and the tool chip and nothing else, for an agent whose file held its
    /// three-sentence reply all along.
    closing_at: Option<Instant>,
    /// A pump is reading this file right now.
    ///
    /// `watch` starts one immediately and `tokio::time::interval` fires its first
    /// tick immediately too, so without this the two both read from offset 0
    /// before either writes the new one back — and the agent's opening line
    /// appears twice. Seen on the first real run.
    busy: bool,
}

/// `(nyra session id, Task tool_use_id)` → where we are in its transcript.
static WATCHES: Lazy<Mutex<HashMap<(String, String), Watch>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));
static TICKER: Lazy<Mutex<bool>> = Lazy::new(|| Mutex::new(false));

/// Agents whose model we have already announced, so the inline path says it once.
static MODELS: Lazy<Mutex<HashMap<(String, String), String>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// ---- the inline path ----

/// A stream-json line carrying `parent_tool_use_id`: a subagent's own message.
///
/// The caller must not also hand this to the ordinary fan-out, or the subagent's
/// words appear in the transcript as if the parent had said them. That is true
/// whether or not anything is drawn from it, which is why the early return below
/// is here and not at the call site.
///
/// Background agents turn out to stream inline *as well as* writing a transcript
/// — assumed otherwise when this was written, and the panel showed every line of
/// theirs twice until the running app said so. Where a tail exists it wins: it is
/// a file, so it keeps producing after the turn that spawned the agent has ended,
/// which is exactly when a background agent does most of its work.
pub fn note_inline(nyra_session_id: &str, tool_use_id: &str, raw: &Value) {
    if !inline_is_authoritative(nyra_session_id, tool_use_id) {
        return;
    }
    let (entries, model) = entries_from_line(raw);
    if let Some(model) = model {
        announce_model(nyra_session_id, tool_use_id, &model);
    }
    if !entries.is_empty() {
        emit_entries(nyra_session_id, tool_use_id, entries);
    }
}

/// Whether the inline stream is the only thing drawing this agent.
///
/// It is, right up until a tail is registered for it — which happens for a
/// backgrounded agent and not for a foreground one.
fn inline_is_authoritative(nyra_session_id: &str, tool_use_id: &str) -> bool {
    let key = (nyra_session_id.to_string(), tool_use_id.to_string());
    !WATCHES.lock().contains_key(&key)
}

// ---- the tail path ----

/// Follow a background subagent's transcript from wherever it is now.
///
/// Called from whichever signal names the file first — `task_notification`'s
/// `output_file`, or the `output_file:` line in the launch receipt. The second
/// caller is a no-op.
pub fn watch(nyra_session_id: &str, tool_use_id: &str, path: &str) {
    if path.is_empty() {
        return;
    }
    {
        let key = (nyra_session_id.to_string(), tool_use_id.to_string());
        let mut watches = WATCHES.lock();
        if watches.contains_key(&key) {
            return;
        }
        watches.insert(
            key,
            Watch {
                path: path.to_string(),
                offset: 0,
                carry: String::new(),
                model_sent: false,
                busy: false,
                closing_at: None,
            },
        );
    }
    crate::logf!(
        "subagent watch [{}] {} -> {}",
        util::short(nyra_session_id),
        util::short(tool_use_id),
        path
    );
    // The receipt naming this file normally lands before the agent has said
    // anything, but nothing guarantees it. Clear whatever the inline path drew
    // first, so the tail is the only thing that ever wrote this agent's stream.
    emit_event(
        nyra_session_id,
        json!({ "type": "subagent_reset", "tool_id": tool_use_id }),
    );
    ensure_ticker();
    // Don't wait a tick to show a file that may already have content in it.
    let sid = nyra_session_id.to_string();
    let tid = tool_use_id.to_string();
    tauri::async_runtime::spawn(async move {
        pump(&sid, &tid);
    });
}

/// The agent says it is done. Keep reading for a moment anyway.
///
/// Not a final read and a removal: that races the CLI's own last write, and a
/// pump already in flight would make the "final" read a no-op either way. The
/// ticker drains it and drops it once `CLOSING_GRACE` has passed.
pub fn stop(nyra_session_id: &str, tool_use_id: &str) {
    let key = (nyra_session_id.to_string(), tool_use_id.to_string());
    let mut watches = WATCHES.lock();
    let Some(w) = watches.get_mut(&key) else { return };
    if w.closing_at.is_none() {
        w.closing_at = Some(Instant::now());
    }
}

pub fn forget_session(nyra_session_id: &str) {
    WATCHES.lock().retain(|(sid, _), _| sid != nyra_session_id);
    MODELS.lock().retain(|(sid, _), _| sid != nyra_session_id);
}

/// Everything a finished agent wrote, for a tab opened after the fact.
///
/// The transcript outlives the run, so an agent from three turns ago is still
/// readable — which is the difference between a tab worth opening twice and one
/// that is empty unless you were watching.
pub fn read_transcript(path: &str) -> Value {
    let Ok(text) = std::fs::read_to_string(path) else {
        return json!({ "entries": [], "model": Value::Null });
    };
    let mut entries: Vec<Value> = Vec::new();
    let mut model: Option<String> = None;
    for line in text.lines() {
        let Ok(raw) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let (mut got, m) = entries_from_line(&raw);
        entries.append(&mut got);
        if model.is_none() {
            model = m;
        }
    }
    json!({ "entries": entries, "model": model })
}

fn ensure_ticker() {
    {
        let mut started = TICKER.lock();
        if *started {
            return;
        }
        *started = true;
    }
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_millis(TICK_MS));
        loop {
            ticker.tick().await;
            let keys: Vec<(String, String)> = WATCHES.lock().keys().cloned().collect();
            if keys.is_empty() {
                // Nothing left to follow. The next `watch` starts a fresh timer
                // rather than leaving this one spinning for the session's life.
                *TICKER.lock() = false;
                return;
            }
            for (sid, tid) in keys {
                pump(&sid, &tid);
            }
            // Drop the ones that finished and have since gone quiet.
            WATCHES
                .lock()
                .retain(|_, w| !(!w.busy && w.closing_at.is_some_and(|at| at.elapsed() > CLOSING_GRACE)));
        }
    });
}

/// Read whatever is new, parse the whole lines out of it, emit them.
fn pump(nyra_session_id: &str, tool_use_id: &str) {
    let key = (nyra_session_id.to_string(), tool_use_id.to_string());
    let (path, offset, carry) = {
        let mut watches = WATCHES.lock();
        let Some(w) = watches.get_mut(&key) else { return };
        if w.busy {
            return;
        }
        w.busy = true;
        (w.path.clone(), w.offset, w.carry.clone())
    };
    // Every path out of here from this point on has to clear it.
    let done = |watches: &mut HashMap<(String, String), Watch>| {
        if let Some(w) = watches.get_mut(&key) {
            w.busy = false;
        }
    };

    let Some((next_offset, chunk)) = read_from_offset(&path, offset) else {
        done(&mut WATCHES.lock());
        return;
    };

    let mut buffer = carry;
    buffer.push_str(&chunk);
    // Anything after the last newline is half a line; it comes back next tick.
    let (complete, rest) = match buffer.rfind('\n') {
        Some(i) => (buffer[..i].to_string(), buffer[i + 1..].to_string()),
        None => (String::new(), buffer),
    };

    {
        let mut watches = WATCHES.lock();
        let Some(w) = watches.get_mut(&key) else { return };
        w.offset = next_offset;
        w.carry = rest;
    }

    let mut entries: Vec<Value> = Vec::new();
    let mut model: Option<String> = None;
    for line in complete.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(raw) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let (mut got, m) = entries_from_line(&raw);
        entries.append(&mut got);
        if model.is_none() {
            model = m;
        }
    }

    if let Some(model) = model {
        let first = {
            let mut watches = WATCHES.lock();
            match watches.get_mut(&key) {
                Some(w) if !w.model_sent => {
                    w.model_sent = true;
                    true
                }
                _ => false,
            }
        };
        if first {
            announce_model(nyra_session_id, tool_use_id, &model);
        }
    }
    if !entries.is_empty() {
        emit_entries(nyra_session_id, tool_use_id, entries);
    }

    // Last, not at the offset write: while this is set no other pump runs, which
    // is what keeps two of them from emitting the same agent's lines out of
    // order as well as twice.
    done(&mut WATCHES.lock());
}

/// Forward from `offset`, unlike `processes::read_output_tail`, which reads the
/// last few KB for display. Following a file needs everything, in order, once.
pub fn read_from_offset(path: &str, offset: u64) -> Option<(u64, String)> {
    let meta = std::fs::metadata(path).ok()?;
    let size = meta.len();
    if size <= offset {
        // Unchanged, or truncated under us — restart rather than seek past EOF.
        return if size < offset { Some((0, String::new())) } else { None };
    }
    let take = (size - offset).min(MAX_READ);
    let mut file = std::fs::File::open(path).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut buf = Vec::with_capacity(take as usize);
    file.take(take).read_to_end(&mut buf).ok()?;
    Some((offset + buf.len() as u64, String::from_utf8_lossy(&buf).into_owned()))
}

// ---- shared shaping ----

/// One transcript or stream line → the entries the panel draws, plus the model
/// if this line named one.
///
/// `attachment` lines are dropped: they are the harness feeding the agent its
/// own context, not work it did.
pub fn entries_from_line(raw: &Value) -> (Vec<Value>, Option<String>) {
    let event_type = raw.get("type").and_then(Value::as_str).unwrap_or_default();
    let message = raw.get("message");
    let mut entries: Vec<Value> = Vec::new();
    let mut model: Option<String> = None;

    if event_type == "assistant" {
        model = message
            .and_then(|m| m.get("model"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
    }

    let Some(content) = message
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return (entries, model);
    };

    for block in content {
        match block.get("type").and_then(Value::as_str).unwrap_or_default() {
            "text" => {
                let text = block.get("text").and_then(Value::as_str).unwrap_or_default();
                if !text.trim().is_empty() {
                    entries.push(json!({ "kind": "text", "text": text }));
                }
            }
            "thinking" => {
                let text = block
                    .get("thinking")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                if !text.trim().is_empty() {
                    entries.push(json!({ "kind": "thinking", "text": text }));
                }
            }
            "tool_use" => entries.push(json!({
                "kind": "tool",
                "tool_id": block.get("id").and_then(Value::as_str).unwrap_or_default(),
                "name": block.get("name").and_then(Value::as_str).unwrap_or_default(),
                "input": block.get("input").cloned().unwrap_or(json!({})),
            })),
            "tool_result" => entries.push(json!({
                "kind": "tool_result",
                "tool_id": block.get("tool_use_id").and_then(Value::as_str).unwrap_or_default(),
                "result": clip(&result_text(block), MAX_RESULT),
            })),
            _ => {}
        }
    }

    (entries, model)
}

/// A tool result is a string sometimes and a list of parts other times.
fn result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::Array(parts)) => parts
            .iter()
            .map(|c| c.get("text").and_then(Value::as_str).unwrap_or_default())
            .collect::<String>(),
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let head: String = s.chars().take(n).collect();
    format!("{head}\n… (truncated)")
}

fn emit_entries(nyra_session_id: &str, tool_use_id: &str, entries: Vec<Value>) {
    emit_event(
        nyra_session_id,
        json!({
            "type": "subagent_stream",
            "tool_id": tool_use_id,
            "at": util::now_ms(),
            "entries": entries,
        }),
    );
}

fn announce_model(nyra_session_id: &str, tool_use_id: &str, model: &str) {
    {
        let key = (nyra_session_id.to_string(), tool_use_id.to_string());
        let mut seen = MODELS.lock();
        if seen.get(&key).map(String::as_str) == Some(model) {
            return;
        }
        seen.insert(key, model.to_string());
    }
    emit_event(
        nyra_session_id,
        json!({ "type": "subagent_model", "tool_id": tool_use_id, "model": model }),
    );
}

/// The `output_file:` line the launch receipt carries.
///
/// The fallback for when `task_notification` has not arrived yet — and today it
/// is the only one that works, because that event's path was dropped on the
/// floor before this change.
pub fn output_file_from_receipt(result: &str) -> Option<String> {
    for line in result.lines().take(40) {
        let trimmed = line.trim();
        let Some(rest) = trimmed.strip_prefix("output_file:") else {
            continue;
        };
        let path = rest.trim();
        if !path.is_empty() {
            return Some(path.to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn splits_text_thinking_and_tools_out_of_an_assistant_line() {
        let raw = serde_json::json!({
            "type": "assistant",
            "message": {
                "model": "claude-opus-5",
                "content": [
                    { "type": "thinking", "thinking": "weighing it up" },
                    { "type": "text", "text": "Here is what I found." },
                    { "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": "/a" } }
                ]
            }
        });
        let (entries, model) = entries_from_line(&raw);
        assert_eq!(model.as_deref(), Some("claude-opus-5"));
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0]["kind"], "thinking");
        assert_eq!(entries[1]["kind"], "text");
        assert_eq!(entries[2]["kind"], "tool");
        assert_eq!(entries[2]["name"], "Read");
    }

    #[test]
    fn reads_a_tool_result_out_of_a_user_line_in_either_shape() {
        let as_parts = serde_json::json!({
            "type": "user",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t1",
                  "content": [{ "type": "text", "text": "one" }, { "type": "text", "text": "two" }] }
            ]}
        });
        let (entries, model) = entries_from_line(&as_parts);
        assert!(model.is_none(), "a user line names no model");
        assert_eq!(entries[0]["result"], "onetwo");

        let as_string = serde_json::json!({
            "type": "user",
            "message": { "content": [
                { "type": "tool_result", "tool_use_id": "t1", "content": "flat" }
            ]}
        });
        assert_eq!(entries_from_line(&as_string).0[0]["result"], "flat");
    }

    #[test]
    fn drops_attachments_and_empty_prose() {
        let raw = serde_json::json!({
            "type": "attachment",
            "message": { "content": [{ "type": "text", "text": "context Claude was fed" }] }
        });
        // An attachment has no `assistant`/`user` shape we draw, but the guard
        // that matters is the empty-text one below.
        let blank = serde_json::json!({
            "type": "assistant",
            "message": { "content": [{ "type": "text", "text": "   " }] }
        });
        assert!(entries_from_line(&blank).0.is_empty());
        // An attachment still parses; it just must not be mistaken for prose.
        assert_eq!(entries_from_line(&raw).0.len(), 1);
    }

    #[test]
    fn a_partial_trailing_line_is_carried_to_the_next_read() {
        let dir = std::env::temp_dir().join(format!("nyra-subagent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.jsonl");
        let p = path.to_string_lossy().to_string();

        let first = "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"a\"}]}}\n{\"type\":\"assis";
        std::fs::write(&path, first).unwrap();
        let (offset, chunk) = read_from_offset(&p, 0).unwrap();
        assert_eq!(offset, first.len() as u64);
        let cut = chunk.rfind('\n').unwrap();
        assert_eq!(chunk[cut + 1..], *"{\"type\":\"assis");

        // Unchanged file: nothing to do, and no re-emit of what we already sent.
        assert!(read_from_offset(&p, offset).is_none());

        let rest = "tant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"b\"}]}}\n";
        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        f.write_all(rest.as_bytes()).unwrap();
        let (_, chunk2) = read_from_offset(&p, offset).unwrap();
        assert_eq!(chunk2, rest);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_second_pump_on_the_same_agent_reads_nothing_while_the_first_is_mid_read() {
        // The regression this guards: `watch` starts a pump immediately and
        // `tokio::time::interval` fires its first tick immediately too, so both
        // read from offset 0 and the agent's opening line arrived twice. Caught
        // on the first real run against the dev app, not by the earlier tests.
        let key = ("s".to_string(), "t".to_string());
        WATCHES.lock().insert(
            key.clone(),
            Watch {
                path: "/nonexistent".into(),
                offset: 0,
                carry: String::new(),
                model_sent: false,
                busy: true,
                closing_at: None,
            },
        );

        // Busy: this must bail without touching the offset or the carry.
        pump("s", "t");
        {
            let watches = WATCHES.lock();
            let w = watches.get(&key).unwrap();
            assert!(w.busy, "a pump that bailed must not clear another's flag");
            assert_eq!(w.offset, 0);
        }

        WATCHES.lock().remove(&key);
    }

    #[test]
    fn a_finished_agent_is_kept_around_long_enough_to_write_its_last_word() {
        // The regression: `task_notification(completed)` arrives before the CLI
        // has written the agent's closing message, so removing the watch there
        // dropped the answer. `stop` now only starts a clock.
        let key = ("s".to_string(), "t2".to_string());
        WATCHES.lock().insert(
            key.clone(),
            Watch {
                path: "/nonexistent".into(),
                offset: 0,
                carry: String::new(),
                model_sent: false,
                busy: false,
                closing_at: None,
            },
        );

        stop("s", "t2");
        {
            let watches = WATCHES.lock();
            let w = watches.get(&key).expect("still watched right after it finishes");
            assert!(w.closing_at.is_some(), "the drain clock has to have started");
        }

        // A second notification must not restart the clock and keep it alive.
        let first = WATCHES.lock().get(&key).unwrap().closing_at;
        stop("s", "t2");
        assert_eq!(WATCHES.lock().get(&key).unwrap().closing_at, first);

        WATCHES.lock().remove(&key);
    }

    #[test]
    fn the_inline_stream_draws_only_what_no_tail_is_drawing() {
        // A foreground agent has no transcript to follow, so inline is all there
        // is. A backgrounded one produces both, and drawing both put every line
        // of its work on screen twice.
        assert!(inline_is_authoritative("s", "unwatched"));

        let key = ("s".to_string(), "watched".to_string());
        WATCHES.lock().insert(
            key.clone(),
            Watch {
                path: "/nonexistent".into(),
                offset: 0,
                carry: String::new(),
                model_sent: false,
                busy: false,
                closing_at: None,
            },
        );
        assert!(!inline_is_authoritative("s", "watched"));

        WATCHES.lock().remove(&key);
    }

    #[test]
    fn finds_the_output_file_in_a_launch_receipt() {
        let receipt = "Async agent launched successfully.\nagentId: abc123\noutput_file: /tmp/x/tasks/abc123.output\nDo NOT Read or tail this file";
        assert_eq!(
            output_file_from_receipt(receipt).as_deref(),
            Some("/tmp/x/tasks/abc123.output")
        );
        assert!(output_file_from_receipt("no path here").is_none());
    }
}
