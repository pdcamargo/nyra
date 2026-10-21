//! File checkpoints: putting a chat's files back the way a version left them.
//!
//! Two halves, because the CLI only ever records half of it.
//!
//! The CLI's own checkpoints (on with `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING`,
//! see `claude::cli_command`) snapshot every file Claude edits *before* the edit,
//! filed under the uuid of the user message whose turn made it. Rewinding to one
//! puts every file Claude touched since back as it was when that message arrived,
//! and deletes the ones it created. Reliable, but only ever backwards: nothing is
//! recorded at the *end* of a turn, so a version's own result is gone the moment
//! something rewinds past it.
//!
//! Captures are the other half: a copy of the files a version is about to lose,
//! taken whenever it stops being the one on disk. Restoring that version later is
//! a rewind to before whatever replaced it, then the capture written back over it.
//!
//! The rewind runs in a process of its own, forked off the conversation that last
//! touched the disk and persisting nothing, so the chat's own process and
//! transcript are never involved. Bash changes are tracked by neither half.
//!
//! On disk, per chat: `~/.nyra/checkpoints/<chat>/blobs/<sha256>` holds each
//! file's content once, and `captures/<id>.json` lists a capture's paths with
//! the blob each had, or none for a file that did not exist.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{ChildStdin, ChildStdout};

use crate::claude::{cli_command, resolve_claude_binary, settings_for_spawn};
use crate::environment::Environment;
use crate::settings::SpawnSettings;
use crate::util;

/// A CLI that has to resume a long transcript before it answers. Generous: the
/// alternative to waiting is telling the user their files did not come back.
const REWIND_TIMEOUT: Duration = Duration::from_secs(60);

fn root() -> PathBuf {
    util::home_dir().join(".nyra").join("checkpoints")
}

#[derive(Serialize, Deserialize)]
struct Entry {
    /// As the chat's environment names it, which is how the renderer knows it.
    path: String,
    /// None when there was no file to copy.
    blob: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    files: Vec<Entry>,
}

fn hash(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

/// One path per file, however many spellings of it came in: Claude's tool calls
/// and the CLI's rewind report write the same file with different separators.
fn same_file_key(host: &Path) -> String {
    let s = host.to_string_lossy().replace('\\', "/");
    if cfg!(windows) { s.to_lowercase() } else { s }
}

fn read(env: &Environment, path: &str) -> Option<Vec<u8>> {
    std::fs::read(env.to_host(path)).ok()
}

/// What each path holds right now, by its content hash; None for no file.
pub fn hashes(cwd: &str, paths: &[String]) -> HashMap<String, Option<String>> {
    let env = Environment::of(cwd);
    paths.iter().map(|p| (p.clone(), read(&env, p).map(|b| hash(&b)))).collect()
}

/// Copy `paths` as they are now. Answers the capture's id and what each path
/// held, by hash, keyed by every spelling it was given under.
fn capture_in(dir: &Path, env: &Environment, paths: &[String]) -> Result<(String, HashMap<String, Option<String>>), String> {
    let blobs = dir.join("blobs");
    let captures = dir.join("captures");
    std::fs::create_dir_all(&blobs).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&captures).map_err(|e| e.to_string())?;

    let mut seen: HashMap<String, Option<String>> = HashMap::new();
    let mut files = Vec::new();
    let mut held = HashMap::new();
    for path in paths {
        let key = same_file_key(&env.to_host(path));
        let blob = match seen.get(&key) {
            Some(blob) => blob.clone(),
            None => {
                let blob = match read(env, path) {
                    Some(bytes) => {
                        let h = hash(&bytes);
                        let at = blobs.join(&h);
                        if !at.exists() {
                            std::fs::write(&at, &bytes).map_err(|e| e.to_string())?;
                        }
                        Some(h)
                    }
                    None => None,
                };
                seen.insert(key, blob.clone());
                files.push(Entry { path: path.clone(), blob: blob.clone() });
                blob
            }
        };
        held.insert(path.clone(), blob);
    }

    let id = format!("{}-{}", util::now_ms(), util::rand_suffix(6));
    let manifest = serde_json::to_vec_pretty(&Manifest { files }).map_err(|e| e.to_string())?;
    std::fs::write(captures.join(format!("{id}.json")), manifest).map_err(|e| e.to_string())?;
    Ok((id, held))
}

fn manifest_in(dir: &Path, id: &str) -> Result<Manifest, String> {
    let raw = std::fs::read(dir.join("captures").join(format!("{id}.json")))
        .map_err(|_| "This version's saved files are gone".to_string())?;
    serde_json::from_slice(&raw).map_err(|e| e.to_string())
}

/// Write a capture back: each file as it was, and gone where there was none.
fn apply_in(dir: &Path, env: &Environment, id: &str) -> Result<(), String> {
    for entry in manifest_in(dir, id)?.files {
        let host = env.to_host(&entry.path);
        match entry.blob {
            Some(blob) => {
                let bytes = std::fs::read(dir.join("blobs").join(&blob)).map_err(|e| e.to_string())?;
                if let Some(parent) = host.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                std::fs::write(&host, bytes).map_err(|e| format!("{}: {e}", entry.path))?;
            }
            None => {
                if host.exists() {
                    std::fs::remove_file(&host).map_err(|e| format!("{}: {e}", entry.path))?;
                }
            }
        }
    }
    Ok(())
}

/// Copy `paths` into a new capture for `chat_id`.
pub fn capture(chat_id: &str, cwd: &str, paths: &[String]) -> Value {
    match capture_in(&root().join(chat_id), &Environment::of(cwd), paths) {
        Ok((id, held)) => json!({ "capture": id, "before": held }),
        Err(e) => json!({ "error": e }),
    }
}

/// Forget a chat's captures, once the chat is gone for good.
pub fn discard(chat_id: &str) {
    let _ = std::fs::remove_dir_all(root().join(chat_id));
}

/// What a restore asks of the CLI and of the captures.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRequest {
    pub chat_id: String,
    pub cwd: String,
    /// The conversation whose turns last touched the disk.
    pub session_id: String,
    /// The user message uuid to rewind to.
    pub checkpoint: String,
    /// Every file the chat has edited: what is there now is copied first, so
    /// the version being replaced can come back.
    pub paths: Vec<String>,
    /// A capture to write over the rewound files, for a version's own result.
    pub overlay: Option<String>,
    #[serde(default)]
    pub settings: SpawnSettings,
}

/// Rewind the files to `checkpoint`, then write `overlay` over them, keeping a
/// copy of everything this overwrites.
///
/// Answers `{ capture, changed, before, overwritten }` — the copy's id, the
/// files the CLI rewound, each path's hash beforehand, and the paths that came
/// out different — or `{ error }` with nothing on disk touched.
pub async fn restore(req: RestoreRequest) -> Value {
    match restore_inner(req).await {
        Ok(v) => v,
        Err(e) => json!({ "error": e }),
    }
}

async fn restore_inner(req: RestoreRequest) -> Result<Value, String> {
    let env = Environment::of(&req.cwd);
    let dir = root().join(&req.chat_id);
    let mut cli = Rewinder::spawn(&env, &req).await?;

    let dry = cli.rewind(&req.checkpoint, true).await?;
    let changed: Vec<String> = dry
        .get("filesChanged")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();

    let mut paths = req.paths.clone();
    paths.extend(changed.iter().cloned());
    if let Some(overlay) = &req.overlay {
        paths.extend(manifest_in(&dir, overlay)?.files.into_iter().map(|e| e.path));
    }
    let (capture, before) = capture_in(&dir, &env, &paths)?;

    cli.rewind(&req.checkpoint, false).await?;
    drop(cli);
    if let Some(overlay) = &req.overlay {
        apply_in(&dir, &env, overlay)?;
    }

    let after = hashes(&req.cwd, &paths);
    let mut overwritten: Vec<&String> = paths.iter().filter(|p| before.get(*p) != after.get(*p)).collect();
    overwritten.sort();
    overwritten.dedup();
    Ok(json!({ "capture": capture, "changed": changed, "before": before, "overwritten": overwritten }))
}

/// A CLI forked off a conversation for nothing but `rewind_files`. It is killed
/// when dropped, and was told to persist nothing.
struct Rewinder {
    _child: tokio::process::Child,
    stdin: ChildStdin,
    stdout: Lines<BufReader<ChildStdout>>,
    next: u32,
}

impl Rewinder {
    async fn spawn(env: &Environment, req: &RestoreRequest) -> Result<Self, String> {
        let settings = settings_for_spawn(&req.cwd, req.settings.clone());
        let claude_bin = match env.own_claude()? {
            Some(own) => own,
            None => {
                let configured = settings.claude_binary_path.clone();
                tokio::task::spawn_blocking(move || resolve_claude_binary(&configured))
                    .await
                    .map_err(|e| format!("Resolving the claude binary failed: {e}"))?
            }
        };
        let config_dir = settings.config_dir.as_deref().map(Path::new);
        // As `spawn_session` does: a resume that misses its transcript starts a
        // new conversation instead of failing, and that one has no checkpoints.
        if env.is_host() {
            let target = config_dir.map(Path::to_path_buf);
            let id = req.session_id.clone();
            let _ = tokio::task::spawn_blocking(move || crate::transcripts::ensure_resumable(target.as_deref(), &id)).await;
        }
        crate::logf!("Rewinding files for [{}] to {}", util::short(&req.chat_id), util::short(&req.checkpoint));
        let mut child = cli_command(env, &claude_bin, &req.cwd, config_dir)
            .args(rewind_args(&req.session_id))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Failed to spawn {claude_bin}: {e}"))?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("no stdout")?).lines();
        Ok(Self { _child: child, stdin, stdout, next: 0 })
    }

    /// Ask for a rewind, or with `dry_run` only what one would change. An
    /// answer the CLI could not act on comes back as the error.
    async fn rewind(&mut self, checkpoint: &str, dry_run: bool) -> Result<Value, String> {
        self.next += 1;
        let id = format!("nyra-rewind-{}", self.next);
        let line = format!("{}\n", rewind_request(&id, checkpoint, dry_run));
        self.stdin.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
        self.stdin.flush().await.map_err(|e| e.to_string())?;

        let wait = async {
            while let Ok(Some(line)) = self.stdout.next_line().await {
                let Ok(raw) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some(answer) = rewind_answer(&raw, &id) {
                    return answer;
                }
            }
            Err("Claude stopped before it could restore the files".to_string())
        };
        tokio::time::timeout(REWIND_TIMEOUT, wait)
            .await
            .map_err(|_| "Claude took too long to restore the files".to_string())?
    }
}

fn rewind_args(session_id: &str) -> Vec<String> {
    [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--resume",
        session_id,
        "--fork-session",
        "--no-session-persistence",
    ]
    .map(String::from)
    .to_vec()
}

fn rewind_request(id: &str, checkpoint: &str, dry_run: bool) -> Value {
    json!({
        "type": "control_request",
        "request_id": id,
        "request": { "subtype": "rewind_files", "user_message_id": checkpoint, "dry_run": dry_run }
    })
}

/// The reply to request `id`, if this line is it. The CLI answers `success`
/// either way and puts the verdict in `canRewind`.
fn rewind_answer(raw: &Value, id: &str) -> Option<Result<Value, String>> {
    if raw.get("type").and_then(Value::as_str) != Some("control_response") {
        return None;
    }
    let response = raw.get("response")?;
    if response.get("request_id").and_then(Value::as_str) != Some(id) {
        return None;
    }
    if response.get("subtype").and_then(Value::as_str) == Some("error") {
        let error = response.get("error").and_then(Value::as_str).unwrap_or("Claude refused the rewind");
        return Some(Err(error.to_string()));
    }
    let body = response.get("response").cloned().unwrap_or(Value::Null);
    if body.get("canRewind").and_then(Value::as_bool) == Some(true) {
        Some(Ok(body))
    } else {
        let error = body.get("error").and_then(Value::as_str).unwrap_or("Claude could not restore the files");
        Some(Err(error.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("nyra-checkpoints-{tag}-{}", util::rand_suffix(8)));
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
        fn file(&self, name: &str) -> String {
            self.0.join(name).to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn a_capture_puts_files_back_and_removes_ones_that_were_not_there() {
        let work = TempDir::new("work");
        let store = TempDir::new("store");
        let (a, b) = (work.file("a.txt"), work.file("b.txt"));
        std::fs::write(&a, "one\n").unwrap();

        let (id, held) = capture_in(&store.0, &Environment::Host, &[a.clone(), b.clone()]).unwrap();
        assert_eq!(held[&a], Some(hash(b"one\n")));
        assert_eq!(held[&b], None);

        std::fs::write(&a, "two\n").unwrap();
        std::fs::write(&b, "new\n").unwrap();
        apply_in(&store.0, &Environment::Host, &id).unwrap();
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "one\n");
        assert!(!Path::new(&b).exists());
    }

    #[test]
    fn one_file_under_two_spellings_is_copied_once() {
        let work = TempDir::new("spell");
        let store = TempDir::new("spell-store");
        let a = work.file("a.txt");
        std::fs::write(&a, "x").unwrap();
        let other = a.replace('\\', "/");
        let (id, held) = capture_in(&store.0, &Environment::Host, &[a.clone(), other.clone()]).unwrap();
        assert_eq!(held[&a], held[&other]);
        let entries = manifest_in(&store.0, &id).unwrap().files;
        assert_eq!(entries.len(), if cfg!(windows) || a == other { 1 } else { 2 });
    }

    #[test]
    fn a_missing_capture_says_so() {
        let store = TempDir::new("missing");
        assert!(apply_in(&store.0, &Environment::Host, "nope").is_err());
    }

    #[test]
    fn the_rewind_request_is_one_control_request() {
        let req = rewind_request("nyra-rewind-1", "u-1", true);
        assert_eq!(req["type"], "control_request");
        assert_eq!(req["request"]["subtype"], "rewind_files");
        assert_eq!(req["request"]["user_message_id"], "u-1");
        assert_eq!(req["request"]["dry_run"], true);
    }

    #[test]
    fn reads_the_verdict_out_of_a_successful_reply() {
        let ok = json!({ "type": "control_response", "response": { "subtype": "success", "request_id": "r",
            "response": { "canRewind": true, "filesChanged": ["/a"] } } });
        assert_eq!(rewind_answer(&ok, "r").unwrap().unwrap()["filesChanged"][0], "/a");

        let refused = json!({ "type": "control_response", "response": { "subtype": "success", "request_id": "r",
            "response": { "canRewind": false, "error": "No file checkpoint found for this message." } } });
        assert_eq!(rewind_answer(&refused, "r").unwrap().unwrap_err(), "No file checkpoint found for this message.");

        assert!(rewind_answer(&ok, "other").is_none());
        assert!(rewind_answer(&json!({ "type": "assistant" }), "r").is_none());
    }

    #[test]
    fn the_rewind_process_forks_and_persists_nothing() {
        let args = rewind_args("abc");
        assert!(args.windows(2).any(|w| w == ["--resume", "abc"]));
        assert!(args.iter().any(|a| a == "--fork-session"));
        assert!(args.iter().any(|a| a == "--no-session-persistence"));
    }
}
