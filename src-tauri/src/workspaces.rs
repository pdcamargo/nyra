//! Workspaces, as far as the filesystem is concerned.
//!
//! A workspace is the renderer's record — a name, a picture, its projects. What
//! lives here is the part that is a directory: `~/.nyra/workspaces/<id>/.claude`,
//! which every `claude` the workspace starts gets as `CLAUDE_CONFIG_DIR`, and
//! the one guarded way to remove it. Default has no directory here; it is
//! Claude's own `~/.claude`, and nothing in this file can touch it.
//!
//! The last component is `.claude` on purpose. Plan cards and memory chips
//! recognise Claude's own files by that component (`plan_file_path` and
//! `is_claude_owned_file` in `claude.rs`, `memoryWrites.ts`), so a directory
//! named anything else would quietly switch both off for the workspace.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::environment::Environment;
use crate::util;

/// The renderer's id for the workspace that is `~/.claude`.
pub const DEFAULT_ID: &str = "default";

/// `~/.nyra/workspaces`. Holds one directory per workspace and nothing else, so
/// the delete guard can demand a direct child of it.
pub fn root() -> PathBuf {
    util::home_dir().join(".nyra").join("workspaces")
}

/// Letters, digits and dashes — a UUID fits. An id becomes a path component, so
/// anything that could climb out of the root (`..`, a separator, a drive) is not
/// an id at all.
fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn config_dir_in(root: &Path, id: &str) -> PathBuf {
    root.join(id).join(".claude")
}

/// A workspace's Codex home: `.codex` beside its `.claude`, so one directory is
/// the whole of a workspace's accounts. None for Default, whose Codex is the
/// CLI's own `~/.codex`, and for a config dir that is not a workspace's.
///
/// A workspace that borrows another's Codex sign-in gets the lender's home
/// instead (None when that is Default). The whole home rather than a copy of
/// its `auth.json`: Codex refresh tokens are single-use, so two copies of one
/// stop working at the first refresh. One home also means one app-server for
/// both (`server_for` keys on it), so the two never race a refresh — at the
/// cost of sharing the lender's Codex threads and `config.toml` too.
pub fn codex_home_for(config_dir: Option<&str>) -> Option<PathBuf> {
    codex_home_in(&root(), config_dir)
}

fn codex_home_in(root: &Path, config_dir: Option<&str>) -> Option<PathBuf> {
    let dir = Path::new(config_dir?);
    if dir.file_name()? != ".claude" {
        return None;
    }
    if let Some(lender) = id_of(root, dir).and_then(|id| read_sign_in(root, &id).codex) {
        if let Some(lender) = lender_dir(root, &lender) {
            return lender.map(|d| d.with_file_name(".codex"));
        }
    }
    Some(dir.with_file_name(".codex"))
}

// ---- borrowing another workspace's sign-in ----
//
// A new workspace can use the sign-in of one that already has it, for Claude,
// for Codex, or both. Nothing secret is copied. Both CLIs rotate refresh tokens,
// so a copied login dies at its first refresh; instead the borrower is pointed
// at the lender's credential store, and the two share one login for real.
//
// Claude: `CLAUDE_SECURESTORAGE_CONFIG_DIR`, which moves the credential store
// (the file, the macOS Keychain item's name and the refresh lock) away from the
// config dir. Undocumented — the CLI sets it itself for agent-team teammates —
// and checked against 2.1.296: an empty config dir with it set reports the
// lender signed in, and "" means Default's store. Settings, skills, MCP and
// transcripts stay the borrower's own.
//
// Recorded in `<workspace>/sign-in.json` as the lender's id. Always the root
// lender: borrowing from a borrower records whoever it borrows from.

/// Which workspace each of a workspace's sign-ins comes from. None is its own.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct SignIn {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claude: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub codex: Option<String>,
}

fn sign_in_file(root: &Path, id: &str) -> PathBuf {
    root.join(id).join("sign-in.json")
}

fn read_sign_in(root: &Path, id: &str) -> SignIn {
    if !valid_id(id) {
        return SignIn::default();
    }
    fs::read_to_string(sign_in_file(root, id))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// The workspace a config dir is, when it is one of ours.
fn id_of(root: &Path, config_dir: &Path) -> Option<String> {
    if config_dir.file_name()? != ".claude" {
        return None;
    }
    let workspace = config_dir.parent()?;
    if workspace.parent()? != root {
        return None;
    }
    let id = workspace.file_name()?.to_string_lossy().into_owned();
    valid_id(&id).then_some(id)
}

/// A lender's config dir: `Some(None)` for Default, `Some(Some(dir))` for a
/// workspace that still exists, and None for one that does not — a borrower
/// whose lender has gone falls back to its own, signed-out store.
fn lender_dir(root: &Path, lender: &str) -> Option<Option<PathBuf>> {
    if lender == DEFAULT_ID {
        return Some(None);
    }
    let dir = config_dir_in(root, lender);
    (valid_id(lender) && dir.is_dir()).then_some(Some(dir))
}

/// What a borrowing workspace's `claude` gets as
/// `CLAUDE_SECURESTORAGE_CONFIG_DIR`: the lender's config dir written exactly
/// as its own `CLAUDE_CONFIG_DIR` is (the Keychain item's name is a hash of
/// that string), or "" for Default. None for a workspace with its own sign-in.
pub fn claude_store_for(config_dir: &Path) -> Option<String> {
    claude_store_in(&root(), config_dir)
}

fn claude_store_in(root: &Path, config_dir: &Path) -> Option<String> {
    let lender = read_sign_in(root, &id_of(root, config_dir)?).claude?;
    Some(lender_dir(root, &lender)?.map_or_else(String::new, |d| d.to_string_lossy().into_owned()))
}

/// The ids of every workspace borrowing a sign-in from `id`.
pub fn borrowers_of(id: &str) -> Vec<String> {
    borrowers_in(&root(), id)
}

fn borrowers_in(root: &Path, id: &str) -> Vec<String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<String> = entries
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|other| other != id && valid_id(other))
        .filter(|other| {
            let sign_in = read_sign_in(root, other);
            sign_in.claude.as_deref() == Some(id) || sign_in.codex.as_deref() == Some(id)
        })
        .collect();
    out.sort();
    out
}

/// A workspace's sign-ins, for the renderer.
pub fn sign_in(id: &str) -> SignIn {
    read_sign_in(&root(), id)
}

/// `requested`, checked and flattened: each lender must be Default or a
/// workspace that exists, and one that borrows itself is replaced by its own
/// lender, so a chain never forms.
fn resolve_sign_in(root: &Path, id: &str, requested: &SignIn) -> Result<SignIn, String> {
    let resolve = |lender: &Option<String>, of: fn(&SignIn) -> &Option<String>| -> Result<Option<String>, String> {
        let Some(lender) = lender else { return Ok(None) };
        if lender == id {
            return Err("A workspace can't borrow its own sign-in.".into());
        }
        if lender_dir(root, lender).is_none() {
            return Err(format!("{lender:?} is not a workspace to share a sign-in with."));
        }
        Ok(Some(of(&read_sign_in(root, lender)).clone().unwrap_or_else(|| lender.clone())))
    };
    Ok(SignIn {
        claude: resolve(&requested.claude, |s| &s.claude)?,
        codex: resolve(&requested.codex, |s| &s.codex)?,
    })
}

/// The lender's account details, so the borrower names its account before the
/// first `auth status`, and a `claude` run in its terminal skips onboarding.
/// Only what identifies the account; no tokens are in this file.
fn copy_account_details(lender: Option<&Path>, to: &Path) {
    let from = util::claude_json(&Environment::Host, lender);
    let Some(Value::Object(source)) = fs::read_to_string(from).ok().and_then(|raw| serde_json::from_str(&raw).ok())
    else {
        return;
    };
    let mut details = Map::new();
    for key in ["oauthAccount", "hasCompletedOnboarding"] {
        if let Some(value) = source.get(key) {
            details.insert(key.to_string(), value.clone());
        }
    }
    if details.is_empty() {
        return;
    }
    if let Ok(body) = serde_json::to_string_pretty(&Value::Object(details)) {
        let _ = fs::write(to.join(".claude.json"), format!("{body}\n"));
    }
}

/// Every workspace config dir that exists — not Default's. Read from disk
/// rather than from the renderer, so the managed-skills sync and the transcript
/// search see workspaces a second instance created too.
pub fn config_roots() -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(root()) else {
        return Vec::new();
    };
    let mut roots: Vec<PathBuf> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter(|entry| valid_id(&entry.file_name().to_string_lossy()))
        .map(|entry| entry.path().join(".claude"))
        .filter(|dir| dir.is_dir())
        .collect();
    roots.sort();
    roots
}

/// Make a new workspace's config dir and return it — the value the renderer
/// stores as the workspace's `configDir`. `claude` would create it on first run
/// anyway; making it here is what lets the skills Nyra ships be in it before
/// the first chat, and lets the path come from one place.
///
/// `sign_in` names workspaces to borrow a sign-in from; see `SignIn`.
pub async fn create(id: &str, sign_in: &SignIn) -> Result<PathBuf, String> {
    if id == DEFAULT_ID || !valid_id(id) {
        return Err(format!("{id:?} is not a new workspace id."));
    }
    let root = root();
    let sign_in = resolve_sign_in(&root, id, sign_in)?;
    let dir = config_dir_in(&root, id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    if sign_in != SignIn::default() {
        let body = serde_json::to_string_pretty(&sign_in).map_err(|e| e.to_string())?;
        tokio::fs::write(sign_in_file(&root, id), format!("{body}\n"))
            .await
            .map_err(|e| format!("Could not record the shared sign-in: {e}"))?;
    }
    if let Some(lender) = &sign_in.claude {
        if let Some(lender) = lender_dir(&root, lender) {
            copy_account_details(lender.as_deref(), &dir);
        }
    }
    if !crate::passive_dev() {
        crate::managed_skills::sync_into(&dir).await;
    }
    Ok(dir)
}

/// The directory `delete` may remove for `id`, or why not.
///
/// The renderer only ever names a workspace; the path is worked out here and
/// has to be a real directory directly inside the canonical `root`. That rules
/// out Default, `~/.claude`, the root itself, and a link — a symlink or a
/// Windows junction — that would carry `remove_dir_all` somewhere else.
pub(crate) fn deletable_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id == DEFAULT_ID {
        return Err("The Default workspace can't be deleted.".into());
    }
    if !valid_id(id) {
        return Err(format!("{id:?} is not a workspace id."));
    }
    let dir = root.join(id);
    let meta = fs::symlink_metadata(&dir).map_err(|e| format!("No workspace at {}: {e}", dir.display()))?;
    // `is_symlink` covers junctions on Windows as well as symlinks.
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!("{} is not a plain directory; not deleting it.", dir.display()));
    }
    // And again with every link resolved, so nothing on the way can move it.
    let canonical_root = fs::canonicalize(root).map_err(|e| format!("{}: {e}", root.display()))?;
    let canonical_dir = fs::canonicalize(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    if canonical_dir.parent() != Some(canonical_root.as_path()) {
        return Err(format!("{} is not inside {}; not deleting it.", dir.display(), root.display()));
    }
    Ok(dir)
}

/// Remove `~/.nyra/workspaces/<id>/` and everything the workspace's account kept
/// in it. The renderer has already moved its chats, closed its terminals and
/// signed it out; this is the last step.
pub async fn delete(id: &str) -> Result<(), String> {
    // Its credential store is theirs too: deleting it would sign them out.
    let borrowers = borrowers_of(id);
    if !borrowers.is_empty() {
        return Err(format!("{} other workspace(s) use its sign-in.", borrowers.len()));
    }
    let dir = deletable_dir(&root(), id)?;
    tokio::fs::remove_dir_all(&dir)
        .await
        .map_err(|e| format!("Could not delete {}: {e}", dir.display()))
}

/// Delete's first step: every conversation and memory note of workspace `id`,
/// copied into the target's config dir (`None` is Default's `~/.claude`) under
/// the rules in `transcripts.rs`. Returns how many project directories it read.
pub async fn copy_transcripts(id: &str, target: Option<PathBuf>) -> Result<usize, String> {
    if id == DEFAULT_ID || !valid_id(id) {
        return Err(format!("{id:?} is not a workspace to copy out of."));
    }
    let from = config_dir_in(&root(), id);
    let to = util::claude_dir(&Environment::Host, target.as_deref());
    tokio::task::spawn_blocking(move || crate::transcripts::merge_projects(&from, &to))
        .await
        .map_err(|e| e.to_string())?
}

// ---- which config dir a flow runs under ----
//
// A flow belongs to a project, and a project to a workspace — but projects live
// in the renderer, and a trigger fires from here with nobody asking it. So the
// renderer keeps this file current: project id → config dir (null for Default).
//
// Merged, never replaced. The dev build and the installed app both write it,
// each knowing only its own projects; replacing would have each erase the
// other's, and a flow would fire under the wrong account.

fn projects_file() -> PathBuf {
    util::home_dir().join(".nyra").join("workspace-projects.json")
}

fn read_projects(path: &Path) -> Map<String, Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|value| match value {
            Value::Object(map) => Some(map),
            _ => None,
        })
        .unwrap_or_default()
}

pub(crate) fn merge_projects_file(
    path: &Path,
    projects: &HashMap<String, Option<String>>,
    removed: &[String],
) -> Result<(), String> {
    let mut map = read_projects(path);
    for (id, dir) in projects {
        let dir = util::config_dir_arg(dir.clone());
        map.insert(id.clone(), dir.map_or(Value::Null, |d| Value::String(d.to_string_lossy().into_owned())));
    }
    for id in removed {
        map.remove(id);
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&Value::Object(map)).map_err(|e| e.to_string())?;
    let temp = path.with_extension(format!("json.nyra-{}", std::process::id()));
    fs::write(&temp, format!("{body}\n")).map_err(|e| e.to_string())?;
    fs::rename(&temp, path).map_err(|e| {
        let _ = fs::remove_file(&temp);
        e.to_string()
    })
}

pub fn sync_projects(projects: &HashMap<String, Option<String>>, removed: &[String]) -> Result<(), String> {
    merge_projects_file(&projects_file(), projects, removed)
}

pub(crate) fn config_dir_in_file(path: &Path, project_id: Option<&str>) -> Option<PathBuf> {
    let id = project_id.filter(|id| !id.is_empty())?;
    read_projects(path)
        .get(id)
        .and_then(Value::as_str)
        .and_then(|dir| util::config_dir_arg(Some(dir.to_string())))
}

/// The config dir a flow of `project_id` runs under. A flow with no project, or
/// one this file has not heard of, runs under Default.
pub fn config_dir_for_project(project_id: Option<&str>) -> Option<PathBuf> {
    config_dir_in_file(&projects_file(), project_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workspaces_codex_home_sits_beside_its_claude_dir() {
        let claude = Path::new("ws").join("abc").join(".claude");
        assert_eq!(codex_home_for(claude.to_str()), Some(Path::new("ws").join("abc").join(".codex")));
        assert_eq!(codex_home_for(None), None);
        assert_eq!(codex_home_for(Some("/somewhere/else")), None);
    }

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn tmp(tag: &str) -> Tmp {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("nyra-workspaces-{tag}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }

    /// A fake home: `.claude` beside `.nyra/workspaces/<one real workspace>`.
    fn home(tag: &str) -> (Tmp, PathBuf, PathBuf) {
        let t = tmp(tag);
        let claude = t.0.join(".claude");
        let root = t.0.join(".nyra").join("workspaces");
        fs::create_dir_all(claude.join("projects")).unwrap();
        fs::create_dir_all(root.join("w1").join(".claude")).unwrap();
        (t, root, claude)
    }

    /// `<root>/<id>/.claude` for each id, plus a sign-in marker where given.
    fn workspaces(tag: &str, ids: &[(&str, Option<&str>, Option<&str>)]) -> (Tmp, PathBuf) {
        let t = tmp(tag);
        let root = t.0.join("workspaces");
        for (id, claude, codex) in ids {
            fs::create_dir_all(config_dir_in(&root, id)).unwrap();
            let sign_in = SignIn { claude: claude.map(str::to_string), codex: codex.map(str::to_string) };
            if sign_in != SignIn::default() {
                fs::write(sign_in_file(&root, id), serde_json::to_string(&sign_in).unwrap()).unwrap();
            }
        }
        (t, root)
    }

    #[test]
    fn a_borrower_points_claude_at_the_lenders_store() {
        let (_t, root) = workspaces("store", &[("lend", None, None), ("borrow", Some("lend"), None), ("own", None, None)]);
        let lender = config_dir_in(&root, "lend");
        assert_eq!(
            claude_store_in(&root, &config_dir_in(&root, "borrow")),
            Some(lender.to_string_lossy().into_owned())
        );
        assert_eq!(claude_store_in(&root, &config_dir_in(&root, "own")), None);
        assert_eq!(claude_store_in(&root, &lender), None);
    }

    #[test]
    fn borrowing_from_default_is_the_empty_store() {
        let (_t, root) = workspaces("default-store", &[("borrow", Some(DEFAULT_ID), None)]);
        assert_eq!(claude_store_in(&root, &config_dir_in(&root, "borrow")), Some(String::new()));
    }

    #[test]
    fn a_lender_that_is_gone_leaves_the_borrower_its_own_store() {
        let (_t, root) = workspaces("gone", &[("borrow", Some("deleted"), Some("deleted"))]);
        let dir = config_dir_in(&root, "borrow");
        assert_eq!(claude_store_in(&root, &dir), None);
        assert_eq!(codex_home_in(&root, dir.to_str()), Some(root.join("borrow").join(".codex")));
    }

    #[test]
    fn a_borrower_runs_codex_in_the_lenders_home() {
        let (_t, root) = workspaces(
            "codex",
            &[("lend", None, None), ("borrow", None, Some("lend")), ("fromdefault", None, Some(DEFAULT_ID))],
        );
        let borrow = config_dir_in(&root, "borrow");
        assert_eq!(codex_home_in(&root, borrow.to_str()), Some(root.join("lend").join(".codex")));
        assert_eq!(codex_home_in(&root, config_dir_in(&root, "fromdefault").to_str()), None);
    }

    #[test]
    fn borrowing_from_a_borrower_records_the_root_lender() {
        let (_t, root) = workspaces("chain", &[("lend", None, None), ("middle", Some("lend"), None)]);
        let requested = SignIn { claude: Some("middle".into()), codex: Some("middle".into()) };
        let resolved = resolve_sign_in(&root, "new", &requested).unwrap();
        assert_eq!(resolved.claude.as_deref(), Some("lend"));
        assert_eq!(resolved.codex.as_deref(), Some("middle"));
    }

    #[test]
    fn a_lender_must_exist_and_must_not_be_itself() {
        let (_t, root) = workspaces("checks", &[("lend", None, None)]);
        let nobody = SignIn { claude: Some("nobody".into()), codex: None };
        assert!(resolve_sign_in(&root, "new", &nobody).is_err());
        let itself = SignIn { claude: None, codex: Some("lend".into()) };
        assert!(resolve_sign_in(&root, "lend", &itself).is_err());
        let climb = SignIn { claude: Some("../x".into()), codex: None };
        assert!(resolve_sign_in(&root, "new", &climb).is_err());
    }

    #[test]
    fn a_lender_knows_who_borrows_from_it() {
        let (_t, root) = workspaces(
            "borrowers",
            &[("lend", None, None), ("a", Some("lend"), None), ("b", None, Some("lend")), ("c", None, None)],
        );
        assert_eq!(borrowers_in(&root, "lend"), vec!["a".to_string(), "b".to_string()]);
        assert!(borrowers_in(&root, "c").is_empty());
    }

    #[test]
    fn only_a_workspaces_own_config_dir_is_one_of_ours() {
        let (_t, root) = workspaces("id", &[("w", None, None)]);
        assert_eq!(id_of(&root, &config_dir_in(&root, "w")).as_deref(), Some("w"));
        assert_eq!(id_of(&root, &root.join("w")), None);
        assert_eq!(id_of(&root, Path::new("/elsewhere/w/.claude")), None);
    }

    #[test]
    fn a_real_workspace_directory_may_be_deleted() {
        let (_t, root, _) = home("ok");
        assert_eq!(deletable_dir(&root, "w1").unwrap(), root.join("w1"));
    }

    #[test]
    fn default_is_never_deletable() {
        let (_t, root, _) = home("default");
        fs::create_dir_all(root.join("default")).unwrap();
        assert!(deletable_dir(&root, DEFAULT_ID).unwrap_err().contains("Default"));
    }

    #[test]
    fn the_default_claude_dir_cannot_be_named() {
        let (_t, root, claude) = home("claude");
        let absolute = claude.to_string_lossy().into_owned();
        for id in ["../../.claude", "..\\..\\.claude", ".claude", absolute.as_str()] {
            assert!(deletable_dir(&root, id).is_err(), "{id}");
        }
        assert!(claude.is_dir());
    }

    #[test]
    fn the_root_itself_is_not_a_workspace() {
        let (_t, root, _) = home("root");
        for id in ["", ".", "./", "w1/.."] {
            assert!(deletable_dir(&root, id).is_err(), "{id:?}");
        }
    }

    #[test]
    fn a_link_out_of_the_root_is_refused() {
        let (_t, root, claude) = home("link");
        let link = root.join("escape");
        if !make_dir_link(&claude, &link) {
            eprintln!("could not create a directory link here; skipping");
            return;
        }
        assert!(deletable_dir(&root, "escape").is_err());
        assert!(claude.join("projects").is_dir());
    }

    #[cfg(unix)]
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    /// A junction: unlike a directory symlink, it needs no Developer Mode.
    #[cfg(windows)]
    fn make_dir_link(target: &Path, link: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn the_projects_map_merges_rather_than_replaces() {
        let t = tmp("map");
        let file = t.0.join("workspace-projects.json");
        let work = "/h/.nyra/workspaces/w1/.claude".to_string();

        // The installed app's projects, then the dev build's: both survive.
        merge_projects_file(&file, &HashMap::from([("p1".into(), Some(work.clone()))]), &[]).unwrap();
        merge_projects_file(&file, &HashMap::from([("p2".into(), None)]), &[]).unwrap();
        assert_eq!(config_dir_in_file(&file, Some("p1")), Some(PathBuf::from(&work)));
        assert_eq!(config_dir_in_file(&file, Some("p2")), None);

        // Moved to Default, then removed.
        merge_projects_file(&file, &HashMap::from([("p1".into(), None)]), &[]).unwrap();
        assert_eq!(config_dir_in_file(&file, Some("p1")), None);
        merge_projects_file(&file, &HashMap::new(), &["p2".into()]).unwrap();
        assert!(!read_projects(&file).contains_key("p2"));
    }

    #[test]
    fn a_flow_without_a_known_project_runs_under_default() {
        let t = tmp("unknown");
        let file = t.0.join("workspace-projects.json");
        assert_eq!(config_dir_in_file(&file, None), None);
        assert_eq!(config_dir_in_file(&file, Some("nobody")), None);
    }
}
