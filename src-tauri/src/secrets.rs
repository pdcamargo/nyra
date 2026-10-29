//! Secrets Claude asks for: an API key, a token, a password.
//!
//! Pasted into the chat, a key stays in the transcript for good, on disk in
//! `~/.claude/projects/` and in every summary of the conversation. So Claude
//! asks with `nyra_secret` instead, the user pastes into a masked field in the
//! composer, and Nyra writes the value where the project reads it. Claude hears
//! the variable's name and where it went, never the value.
//!
//! The value takes its own path. The tool call asks the window through
//! `ask_renderer`, and the window answers with what was saved and skipped, but
//! each value comes back separately through `secret_save`, which writes it and
//! forgets it. So the reply that becomes the tool result cannot carry one.
//!
//! Two places to put a secret:
//! - `env`, the default: a line in the project's `.env`, added or replaced.
//! - `file`: a private file under `~/.nyra/secrets/<chat>/`, for a CLI that
//!   takes a token on its command line. Swept after a day.
//!
//! Neither keeps the value from Claude if it goes looking: it can read `.env`
//! like any other file. This keeps it out of the chat, which is what was asked.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use crate::util;

/// Long enough to go and make a key on a provider's dashboard.
const ASK_TIMEOUT: Duration = Duration::from_secs(600);
/// How long a `file` secret is kept.
const FILE_LIFETIME: Duration = Duration::from_secs(24 * 60 * 60);
/// More than this in one call is a form, not a question.
const MAX_SECRETS: usize = 10;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Save {
    Env,
    File,
}

/// One request the window is showing, and what has been written for it so far.
struct Pending {
    names: Vec<String>,
    save: Save,
    /// The `.env` for `env`; the chat's folder for `file`.
    target: PathBuf,
    saved: Vec<Option<PathBuf>>,
}

static PENDING: Lazy<Mutex<HashMap<String, Pending>>> = Lazy::new(|| Mutex::new(HashMap::new()));

fn secrets_root() -> PathBuf {
    util::home_dir().join(".nyra").join("secrets")
}

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= 128
}

/// A chat id as a folder name. They are uuids, but this is a path.
fn safe_segment(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

pub fn tool_schema() -> Value {
    json!({
        "name": "nyra_secret",
        "description": "Ask the user for API keys or tokens in a private field, never in chat. You don't see the values: they go into the project's .env, or with save:\"file\" a private file for a CLI, and you get back where.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "secrets": {
                    "type": "array",
                    "description": "{ name: OPENAI_API_KEY, label, reason: what for and where to get it, placeholder? }",
                    "items": { "type": "object" }
                },
                "save": { "type": "string", "enum": ["env", "file"] },
                "env_file": { "type": "string", "description": "Defaults to .env in the chat's folder." }
            },
            "required": ["secrets"]
        }
    })
}

/// Ask, wait for the answer, and say where each secret went.
pub async fn tool(chat_id: &str, args: Value, cwd: Option<String>) -> Result<String, String> {
    sweep(&secrets_root(), SystemTime::now());

    let raw = args
        .get("secrets")
        .and_then(Value::as_array)
        .filter(|a| !a.is_empty())
        .ok_or("nyra_secret needs `secrets`: a list of { name, label, reason }.")?;
    if raw.len() > MAX_SECRETS {
        return Err(format!("Ask for at most {MAX_SECRETS} secrets at once."));
    }
    let mut seen = HashSet::new();
    let mut asked = Vec::new();
    for (i, s) in raw.iter().enumerate() {
        let field = |k: &str| s.get(k).and_then(Value::as_str).map(str::trim).unwrap_or("").to_string();
        let name = field("name");
        if !valid_name(&name) {
            return Err(format!(
                "Secret {} needs a `name` that works as a variable, like OPENAI_API_KEY.",
                i + 1
            ));
        }
        if !seen.insert(name.clone()) {
            return Err(format!("{name} is asked for twice."));
        }
        let label = Some(field("label")).filter(|l| !l.is_empty()).unwrap_or_else(|| name.clone());
        asked.push(json!({
            "name": name,
            "label": label,
            "reason": field("reason"),
            "placeholder": field("placeholder"),
        }));
    }
    let names: Vec<String> = asked.iter().map(|s| s["name"].as_str().unwrap_or("").to_string()).collect();

    let save = match args.get("save").and_then(Value::as_str) {
        None | Some("env") => Save::Env,
        Some("file") => Save::File,
        Some(other) => return Err(format!("`save` is \"env\" or \"file\", not \"{other}\".")),
    };
    let target = match save {
        Save::Env => {
            let file = args.get("env_file").and_then(Value::as_str).unwrap_or(".env");
            let file = Path::new(file);
            if file.is_absolute() {
                file.to_path_buf()
            } else {
                let cwd = cwd.ok_or(
                    "This chat has no folder to put a .env in. Pass an absolute `env_file`, or use save:\"file\".",
                )?;
                Path::new(&cwd).join(file)
            }
        }
        Save::File => secrets_root().join(safe_segment(chat_id)),
    };

    let request_id = util::rand_hex(8);
    PENDING.lock().insert(
        request_id.clone(),
        Pending { saved: vec![None; names.len()], names: names.clone(), save, target: target.clone() },
    );

    let focused = util::main_window().and_then(|w| w.is_focused().ok()).unwrap_or(false);
    if !focused {
        let what = if names.len() == 1 {
            asked[0]["label"].as_str().unwrap_or("a secret").to_string()
        } else {
            format!("{} secrets", names.len())
        };
        crate::notify_user::notify(&format!("Claude needs {what}"), "Paste it in Nyra.", chat_id);
    }

    let answer = crate::app_mcp::ask_renderer_within(
        ASK_TIMEOUT,
        "secret.request",
        json!({
            "chatId": chat_id,
            "requestId": request_id,
            "secrets": asked,
            "save": if save == Save::Env { "env" } else { "file" },
            "target": target.to_string_lossy(),
        }),
    )
    .await;

    let pending = PENDING.lock().remove(&request_id);
    let Some(pending) = pending else {
        return Err("The secret request was lost.".into());
    };
    let (outcome, skipped): (&str, HashSet<usize>) = match &answer {
        Ok(v) => (
            match v.get("outcome").and_then(Value::as_str) {
                Some("done") => "done",
                Some("cancelled") => "cancelled",
                _ => "timed_out",
            },
            v.get("skipped")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_u64).map(|i| i as usize).collect())
                .unwrap_or_default(),
        ),
        Err(_) => ("timed_out", HashSet::new()),
    };
    Ok(summary(&pending, outcome, &skipped, ignored_by_git(&pending)))
}

/// What Claude reads back. One `NAME: what happened` line per secret, which the
/// transcript card parses, then what Claude needs to know to use them.
fn summary(p: &Pending, outcome: &str, skipped: &HashSet<usize>, ignored: Option<bool>) -> String {
    let mut lines = Vec::new();
    for (i, name) in p.names.iter().enumerate() {
        let what = match &p.saved[i] {
            Some(path) => format!("saved to {}", path.display()),
            None if skipped.contains(&i) => "skipped".into(),
            None if outcome == "cancelled" => "cancelled".into(),
            None if outcome == "timed_out" => "no answer".into(),
            None => "skipped".into(),
        };
        lines.push(format!("{name}: {what}"));
    }
    let any_saved = p.saved.iter().any(Option::is_some);
    let mut notes = Vec::new();
    match outcome {
        "cancelled" => notes.push("The user cancelled the request.".to_string()),
        "timed_out" => notes.push("Nobody answered within 10 minutes.".to_string()),
        _ => {}
    }
    if any_saved {
        if p.save == Save::Env && ignored == Some(false) {
            notes.push(format!(
                "{} is not in .gitignore. Add it before anything is committed.",
                p.target.display()
            ));
        }
        if p.save == Save::File {
            notes.push(
                "Each file holds only the value. Read it inside the command that needs it, like TOKEN=\"$(cat <path>)\" wrangler deploy. The files are deleted after 24 hours."
                    .to_string(),
            );
        }
        notes.push("You were not shown the values. Don't print them or read them back into this chat.".to_string());
    }
    if notes.is_empty() {
        lines.join("\n")
    } else {
        format!("{}\n\n{}", lines.join("\n"), notes.join("\n"))
    }
}

/// Whether git ignores the `.env`. `None` outside a repository, or when git is
/// not there to ask: no warning beats a wrong one.
fn ignored_by_git(p: &Pending) -> Option<bool> {
    if p.save != Save::Env || !p.saved.iter().any(Option::is_some) {
        return None;
    }
    let dir = p.target.parent()?;
    let out = crate::platform::std_command("git")
        .args(["check-ignore", "-q", "--"])
        .arg(&p.target)
        .current_dir(dir)
        .output()
        .ok()?;
    match out.status.code() {
        Some(0) => Some(true),
        Some(1) => Some(false),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Saving one
// ---------------------------------------------------------------------------

/// Write one secret of a pending request. Called by the window as each is
/// entered, so a failure shows on the field it belongs to and can be retried.
pub fn save(request_id: &str, index: usize, value: &str) -> Result<(), String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("Nothing to save.".into());
    }
    let (name, save, target) = {
        let pending = PENDING.lock();
        let p = pending.get(request_id).ok_or("This request has ended.")?;
        let name = p.names.get(index).ok_or("No such secret.")?.clone();
        (name, p.save, p.target.clone())
    };
    let written = match save {
        Save::Env => {
            write_env(&target, &name, value)?;
            target
        }
        Save::File => write_private(&target, &name, value)?,
    };
    if let Some(p) = PENDING.lock().get_mut(request_id) {
        p.saved[index] = Some(written);
    }
    Ok(())
}

/// `NAME=value`, replacing the line that already sets it or appended.
fn write_env(path: &Path, name: &str, value: &str) -> Result<(), String> {
    let existing = match fs::read_to_string(path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("Couldn’t read {}: {}", file_name(path), reason(&e))),
    };
    let next = upsert_env(existing.as_deref().unwrap_or(""), name, value);

    let dir = path.parent().ok_or("That .env has no folder.")?;
    fs::create_dir_all(dir).map_err(|e| format!("Couldn’t create {}: {}", dir.display(), reason(&e)))?;
    let tmp = dir.join(format!(".{}.{}", file_name(path), util::rand_hex(4)));
    let write = || -> std::io::Result<()> {
        fs::write(&tmp, &next)?;
        // Keep the mode a file already had; a new one is the owner's alone.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(path).map(|m| m.permissions().mode() & 0o777).unwrap_or(0o600);
            fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
        }
        fs::rename(&tmp, path)
    };
    write().map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("Couldn’t write {}: {}", file_name(path), reason(&e))
    })
}

fn upsert_env(text: &str, name: &str, value: &str) -> String {
    let line = format!("{name}={}", quote_env(value));
    let mut out = Vec::new();
    let mut replaced = false;
    for l in text.lines() {
        let rest = l.trim_start();
        let rest = rest.strip_prefix("export ").map(str::trim_start).unwrap_or(rest);
        let sets_it = rest
            .strip_prefix(name)
            .is_some_and(|after| after.trim_start().starts_with('='));
        if sets_it && !replaced {
            let export = if l.trim_start().starts_with("export ") { "export " } else { "" };
            out.push(format!("{export}{line}"));
            replaced = true;
        } else if !sets_it {
            out.push(l.to_string());
        }
    }
    if !replaced {
        out.push(line);
    }
    let mut joined = out.join("\n");
    joined.push('\n');
    joined
}

/// Bare when it is plainly safe, single quotes when it can be (literal in
/// dotenv, shells and python-dotenv alike), double quotes with escapes when it
/// holds a single quote or a line break.
fn quote_env(value: &str) -> String {
    let plain = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_-./:@+=~,".contains(c));
    if plain {
        value.to_string()
    } else if !value.contains('\'') && !value.contains('\n') {
        format!("'{value}'")
    } else {
        let escaped = value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('\n', "\\n");
        format!("\"{escaped}\"")
    }
}

/// The value alone, in a file only the user can read.
fn write_private(dir: &Path, name: &str, value: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Couldn’t create the secrets folder: {}", reason(&e)))?;
    let path = dir.join(name);
    let write = || -> std::io::Result<()> {
        let _ = fs::remove_file(&path);
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            options.mode(0o600);
            fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
        }
        use std::io::Write;
        options.open(&path)?.write_all(value.as_bytes())
    };
    write().map_err(|e| format!("Couldn’t write the secret file: {}", reason(&e)))?;
    Ok(path)
}

fn file_name(path: &Path) -> String {
    path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.display().to_string())
}

fn reason(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::PermissionDenied => "permission denied".into(),
        std::io::ErrorKind::NotFound => "the folder doesn’t exist".into(),
        _ => e.to_string(),
    }
}

/// Delete `file` secrets older than a day, and the folders they leave empty.
pub fn sweep(root: &Path, now: SystemTime) {
    let Ok(chats) = fs::read_dir(root) else { return };
    for chat in chats.flatten() {
        let dir = chat.path();
        if !dir.is_dir() {
            continue;
        }
        if let Ok(files) = fs::read_dir(&dir) {
            for f in files.flatten() {
                let old = f
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| now.duration_since(t).ok())
                    .is_some_and(|age| age > FILE_LIFETIME);
                if old {
                    let _ = fs::remove_file(f.path());
                }
            }
        }
        let _ = fs::remove_dir(&dir); // only succeeds once it is empty
    }
}

pub fn sweep_now() {
    sweep(&secrets_root(), SystemTime::now());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_a_new_variable_and_keeps_the_rest() {
        let out = upsert_env("# keys\nPORT=3000", "OPENAI_API_KEY", "sk-abc123");
        assert_eq!(out, "# keys\nPORT=3000\nOPENAI_API_KEY=sk-abc123\n");
        assert_eq!(upsert_env("", "A", "b"), "A=b\n");
    }

    #[test]
    fn replaces_the_line_that_already_sets_it_including_export() {
        let out = upsert_env("A=1\nexport KEY = old\nKEY=dupe\nB=2\n", "KEY", "new");
        assert_eq!(out, "A=1\nexport KEY=new\nB=2\n");
        // A longer name that starts with this one is a different variable.
        assert_eq!(upsert_env("KEY_ID=1\n", "KEY", "x"), "KEY_ID=1\nKEY=x\n");
    }

    #[test]
    fn quotes_only_when_the_value_needs_it() {
        assert_eq!(quote_env("sk-proj_ABC.def"), "sk-proj_ABC.def");
        assert_eq!(quote_env("p@ss word$1"), "'p@ss word$1'");
        assert_eq!(quote_env("it's"), "\"it's\"");
        assert_eq!(quote_env("a\nb\"c"), "\"a\\nb\\\"c\"");
    }

    #[test]
    fn a_name_has_to_work_as_a_variable() {
        assert!(valid_name("OPENAI_API_KEY") && valid_name("_x1"));
        assert!(!valid_name("") && !valid_name("1KEY") && !valid_name("A-B") && !valid_name("../x"));
    }

    fn pending(save: Save, saved: Vec<Option<&str>>) -> Pending {
        Pending {
            names: (0..saved.len()).map(|i| format!("K{i}")).collect(),
            save,
            target: PathBuf::from("/p/.env"),
            saved: saved.into_iter().map(|s| s.map(PathBuf::from)).collect(),
        }
    }

    #[test]
    fn the_summary_names_each_secret_and_never_a_value() {
        let p = pending(Save::Env, vec![Some("/p/.env"), None, None]);
        let out = summary(&p, "cancelled", &HashSet::from([1]), Some(false));
        assert!(out.starts_with("K0: saved to /p/.env\nK1: skipped\nK2: cancelled\n\n"));
        assert!(out.contains("not in .gitignore"));
        assert!(out.contains("The user cancelled"));

        let none = summary(&pending(Save::Env, vec![None]), "timed_out", &HashSet::new(), None);
        assert_eq!(none, "K0: no answer\n\nNobody answered within 10 minutes.");
    }

    #[test]
    fn saving_writes_the_env_and_records_where() {
        let dir = std::env::temp_dir().join(format!("nyra-secret-{}", util::rand_hex(4)));
        fs::create_dir_all(&dir).unwrap();
        let env = dir.join(".env");
        fs::write(&env, "PORT=1\n").unwrap();
        let id = util::rand_hex(8);
        PENDING.lock().insert(
            id.clone(),
            Pending { names: vec!["KEY".into()], save: Save::Env, target: env.clone(), saved: vec![None] },
        );
        assert!(save(&id, 0, "  ").is_err());
        save(&id, 0, "sk-1\n").unwrap();
        assert_eq!(fs::read_to_string(&env).unwrap(), "PORT=1\nKEY=sk-1\n");
        assert_eq!(PENDING.lock().remove(&id).unwrap().saved[0].as_deref(), Some(env.as_path()));
        assert!(save(&id, 0, "late").is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn a_private_file_is_the_owners_alone_and_swept_after_a_day() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("nyra-secrets-{}", util::rand_hex(4)));
        let path = write_private(&root.join("chat"), "TOKEN", "abc").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "abc");
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(root.join("chat")).unwrap().permissions().mode() & 0o777, 0o700);

        sweep(&root, SystemTime::now());
        assert!(path.exists());
        sweep(&root, SystemTime::now() + FILE_LIFETIME + Duration::from_secs(60));
        assert!(!path.exists() && !root.join("chat").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
