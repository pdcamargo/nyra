//! The title Claude gives a conversation.
//!
//! A new chat is named after the first thing you typed into it, cut off at forty
//! characters. The CLI generates a real title a few seconds later — but it never
//! puts it on stdout. It appends `{"type":"ai-title","aiTitle":…}` to the
//! session transcript under `~/.claude/projects/<dir>/<id>.jsonl`, so reading
//! that file is the only way to get it.
//!
//! From CLI 2.1.278 a headless session no longer titles itself: the host has
//! to ask, and `claude.rs` does, with a `generate_session_title` control
//! request whose answer carries the title directly. This file is still how an
//! older CLI's title arrives, and how Claude's later revisions of it do.
//!
//! This tails the transcript for a while after a turn starts and reports a title
//! the moment one lands. Only the bytes nobody has read yet are scanned: these
//! files reach tens of megabytes, and walking one every second and a half to
//! find a record that is already known would be absurd.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How often the transcript is re-read while a title is still wanted.
const POLL_INTERVAL: Duration = Duration::from_millis(1500);

/// How many times one turn looks before giving up. The title lands within a few
/// seconds of the first prompt; past a minute it is not coming, and the next
/// turn looks again anyway.
const POLL_ATTEMPTS: usize = 40;

/// How much of a resumed conversation's transcript is worth reading on the first
/// pass. The record repeats every few turns, so a current one is always near the
/// end and the history in front of it has nothing to add.
const FIRST_PASS_TAIL: u64 = 512 * 1024;

/// Ceiling on a single pass, so a turn that wrote a great deal at once cannot
/// turn one poll into a multi-megabyte read.
const MAX_PASS: u64 = 4 * 1024 * 1024;

struct Tracker {
    claude_session_id: String,
    cwd: String,
    /// Resolved on first use and kept — see `locate`, which may have to search.
    path: Option<PathBuf>,
    /// How far into the transcript has been read.
    offset: u64,
    /// The last title reported, so a record that repeats stays quiet.
    title: Option<String>,
    /// Which poller is allowed to touch this tracker. A poller left over from a
    /// previous turn sees a bumped generation and stops rather than racing the
    /// current one.
    generation: u64,
    polling: bool,
}

static TRACKERS: Lazy<Mutex<HashMap<String, Tracker>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// What a session's stdout says about which transcript it is writing to.
///
/// Called for every line that carries a `session_id`, which is nearly all of
/// them: it is a map lookup and two string compares unless something changed.
/// A conversation Nyra has not seen before starts a poller — that is the path
/// where a brand new chat gets its title, seconds into its first turn.
pub fn observe(nyra_session_id: &str, cwd: &str, claude_session_id: &str) {
    {
        let mut trackers = TRACKERS.lock();
        if let Some(tracker) = trackers.get(nyra_session_id) {
            if tracker.claude_session_id == claude_session_id {
                return;
            }
        }
        // A different conversation under the same chat — a fresh session, or a
        // `--resume` that missed and started over. Nothing about the old
        // transcript applies to the new one.
        trackers.insert(
            nyra_session_id.to_string(),
            Tracker {
                claude_session_id: claude_session_id.to_string(),
                cwd: cwd.to_string(),
                path: None,
                offset: 0,
                title: None,
                generation: 0,
                polling: false,
            },
        );
    }
    arm(nyra_session_id);
}

/// Look again, because a turn just finished.
///
/// Two turns need this. A short one — "hi", one reply — can be over before the
/// title is written, and Claude revises the title of a long conversation as it
/// goes. Once per turn is the whole budget: a poller stops as soon as it has
/// something to say, so nothing is running between turns.
pub fn turn_ended(nyra_session_id: &str) {
    arm(nyra_session_id);
}

/// Drop what is known about a chat, and stop whatever is looking for its title.
pub fn forget(nyra_session_id: &str) {
    TRACKERS.lock().remove(nyra_session_id);
}

fn arm(nyra_session_id: &str) {
    let generation = {
        let mut trackers = TRACKERS.lock();
        let Some(tracker) = trackers.get_mut(nyra_session_id) else {
            return;
        };
        if tracker.polling {
            return;
        }
        tracker.polling = true;
        tracker.generation += 1;
        tracker.generation
    };

    let id = nyra_session_id.to_string();
    tauri::async_runtime::spawn(async move {
        poll(&id, generation).await;
    });
}

async fn poll(nyra_session_id: &str, generation: u64) {
    for _ in 0..POLL_ATTEMPTS {
        tokio::time::sleep(POLL_INTERVAL).await;
        match pass(nyra_session_id, generation) {
            Pass::Title(title) => {
                crate::logf!(
                    "AI title [{}]: {title}",
                    crate::util::short(nyra_session_id)
                );
                crate::claude::emit_event(
                    nyra_session_id,
                    json!({ "type": "ai_title", "title": title }),
                );
                break;
            }
            Pass::Stop => return,
            Pass::Nothing => {}
        }
    }
    let mut trackers = TRACKERS.lock();
    if let Some(tracker) = trackers.get_mut(nyra_session_id) {
        if tracker.generation == generation {
            tracker.polling = false;
        }
    }
}

enum Pass {
    /// Nothing new. Keep looking.
    Nothing,
    /// A title that has not been reported before.
    Title(String),
    /// This poller is finished — the chat went away, or a newer poller owns it.
    Stop,
}

fn pass(nyra_session_id: &str, generation: u64) -> Pass {
    // Everything the read needs, and then the lock goes: a file read is not
    // something to hold the rest of the app behind.
    let (path, offset, reported) = {
        let mut trackers = TRACKERS.lock();
        let Some(tracker) = trackers.get_mut(nyra_session_id) else {
            return Pass::Stop;
        };
        if tracker.generation != generation {
            return Pass::Stop;
        }
        let path = match tracker.path.clone() {
            Some(path) => path,
            None => {
                // The transcript does not exist until the CLI writes it, so a
                // miss here is normal on the first pass of a new chat.
                let Some(path) = locate(&tracker.cwd, &tracker.claude_session_id) else {
                    return Pass::Nothing;
                };
                tracker.path = Some(path.clone());
                path
            }
        };
        (path, tracker.offset, tracker.title.clone())
    };

    let Some((found, next_offset)) = read_titles(&path, offset) else {
        return Pass::Nothing;
    };

    let mut trackers = TRACKERS.lock();
    let Some(tracker) = trackers.get_mut(nyra_session_id) else {
        return Pass::Stop;
    };
    if tracker.generation != generation {
        return Pass::Stop;
    }
    tracker.offset = next_offset;
    match found {
        Some(title) if Some(&title) != reported.as_ref() => {
            tracker.title = Some(title.clone());
            Pass::Title(title)
        }
        _ => Pass::Nothing,
    }
}

/// Where the CLI is keeping this conversation.
///
/// The directory is the working directory with its separators flattened, which
/// is a guess worth making and not worth trusting: a chat running in a worktree
/// writes under the worktree's own path, and the flattening eats more than
/// slashes. So the guess is checked, and when it misses the file is looked for
/// by name among the project directories — two dozen `stat` calls, once.
fn locate(cwd: &str, claude_session_id: &str) -> Option<PathBuf> {
    let projects = crate::util::home_dir().join(".claude").join("projects");
    let file = format!("{claude_session_id}.jsonl");

    let guess = projects.join(cwd.replace('/', "-")).join(&file);
    if guess.is_file() {
        return Some(guess);
    }

    std::fs::read_dir(&projects)
        .ok()?
        .flatten()
        .map(|entry| entry.path().join(&file))
        .find(|candidate| candidate.is_file())
}

/// The last `ai-title` record in the bytes past `offset`, and where to resume.
fn read_titles(path: &Path, offset: u64) -> Option<(Option<String>, u64)> {
    let mut file = File::open(path).ok()?;
    let len = file.metadata().ok()?.len();

    // A transcript only grows, so a shorter file is a different one wearing the
    // same name. Start over rather than seek past its end.
    let mut start = if len < offset { 0 } else { offset };
    if len - start > MAX_PASS {
        start = len - FIRST_PASS_TAIL;
    }

    file.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::new();
    file.take(MAX_PASS).read_to_end(&mut buf).ok()?;

    // Whole lines only, and the cut is made on the bytes rather than on the
    // decoded text. The CLI may be mid-write, and half a record is not a record
    // — leaving the offset short means the rest is read next time. Decoding
    // first would put the offset out by however many bytes a lossy replacement
    // added, which the tail jump above can cause by landing inside a character.
    let end = buf.iter().rposition(|b| *b == b'\n')?;
    let text = String::from_utf8_lossy(&buf[..end]);
    Some((last_title(&text), start + end as u64 + 1))
}

/// The title from the last `ai-title` line in a slice of transcript.
///
/// A turn can append several, and the newest one is the answer. The cheap
/// substring test comes first because almost every line is something else and
/// parsing them all would be the expensive way to find that out.
fn last_title(text: &str) -> Option<String> {
    let mut title = None;
    for line in text.lines() {
        if !line.contains("\"ai-title\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if record.get("type").and_then(Value::as_str) != Some("ai-title") {
            continue;
        }
        let found = record
            .get("aiTitle")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty());
        if let Some(found) = found {
            title = Some(found.to_string());
        }
    }
    title
}

#[cfg(test)]
mod tests {
    use super::*;

    const RECORD: &str = r#"{"type":"ai-title","aiTitle":"Side panel file tabs","sessionId":"abc"}"#;

    #[test]
    fn reads_the_newest_title() {
        let text = format!(
            "{RECORD}\n{{\"type\":\"user\"}}\n{}\n",
            r#"{"type":"ai-title","aiTitle":"Render images in chat","sessionId":"abc"}"#
        );
        assert_eq!(last_title(&text).as_deref(), Some("Render images in chat"));
    }

    #[test]
    fn ignores_everything_that_is_not_a_title() {
        // Including a tool result that merely quotes one, which is how this very
        // feature was investigated.
        let text = format!(
            "{}\n{}\n",
            r#"{"type":"user","message":{"content":"grep ai-title found: \"ai-title\""}}"#,
            r#"{"type":"ai-title","aiTitle":"   ","sessionId":"abc"}"#
        );
        assert_eq!(last_title(&text), None);
    }

    #[test]
    fn a_half_written_record_waits_for_the_rest() {
        let dir = std::env::temp_dir().join(format!("nyra-title-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("partial.jsonl");

        let partial = &RECORD[..30];
        std::fs::write(&path, format!("{{\"type\":\"user\"}}\n{partial}")).unwrap();
        let (title, offset) = read_titles(&path, 0).unwrap();
        assert_eq!(title, None);

        // The rest of the line arrives, and the read resumes where it stopped.
        std::fs::write(&path, format!("{{\"type\":\"user\"}}\n{RECORD}\n")).unwrap();
        let (title, _) = read_titles(&path, offset).unwrap();
        assert_eq!(title.as_deref(), Some("Side panel file tabs"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
