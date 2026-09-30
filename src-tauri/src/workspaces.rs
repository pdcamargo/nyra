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
pub async fn create(id: &str) -> Result<PathBuf, String> {
    if id == DEFAULT_ID || !valid_id(id) {
        return Err(format!("{id:?} is not a new workspace id."));
    }
    let dir = config_dir_in(&root(), id);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
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
