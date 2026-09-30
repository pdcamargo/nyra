//! Carrying a conversation's files from one workspace's config dir to another.
//!
//! `--resume <id>` only finds `<config dir>/projects/<slug>/<id>.jsonl`. A chat
//! whose project moved to another workspace respawns under a config dir that
//! has never seen it, and a resume that misses does not fail: the CLI says "No
//! conversation found", `retry_without_resume` starts over, and the chat loses
//! its history without a word. So the file is brought across first.
//!
//! Two rules, and they differ on purpose:
//!
//! - **A transcript: the newest copy wins.** It is append-only, and each copy
//!   began as a copy of the other, so the newer one holds everything the older
//!   one does. A project moved A → B → A must resume from what it said in B,
//!   not from the stale copy A kept.
//! - **Memory is only ever added.** Those are separate notes the model wrote,
//!   not one growing file; overwriting the target's with the source's would
//!   throw one of them away.
//!
//! Nothing here moves or deletes a source file.

use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use crate::environment::Environment;
use crate::util;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Rule {
    NewestWins,
    AddOnly,
}

/// Make `session_id` resumable under `config_dir` (`None` is `~/.claude`).
///
/// Looked for by name in every config dir rather than at the slug `cwd`
/// flattens to, because a worktree chat writes under the worktree's path — the
/// same search `ai_title::locate` makes. The copy lands at the same slug in the
/// target, since the slug names the directory the CLI ran in, not the account.
///
/// Returns whether anything was copied. With no workspace directories on disk
/// there is only one place a transcript can be, and this returns at once.
pub fn ensure_resumable(config_dir: Option<&Path>, session_id: &str) -> io::Result<bool> {
    let workspaces = crate::workspaces::config_roots();
    if workspaces.is_empty() && config_dir.is_none() {
        return Ok(false);
    }
    let target = util::claude_dir(&Environment::Host, config_dir);
    let mut roots = vec![util::claude_dir(&Environment::Host, None)];
    roots.extend(workspaces);
    ensure_resumable_in(&roots, &target, session_id)
}

struct Found {
    root: PathBuf,
    slug: OsString,
    stamp: (SystemTime, u64),
}

pub(crate) fn ensure_resumable_in(roots: &[PathBuf], target: &Path, session_id: &str) -> io::Result<bool> {
    let file = format!("{session_id}.jsonl");
    let mut found: Vec<Found> = Vec::new();
    let mut searched: Vec<&Path> = roots.iter().map(PathBuf::as_path).collect();
    if !searched.iter().any(|root| same_dir(root, target)) {
        searched.push(target);
    }
    for root in searched {
        let Ok(entries) = fs::read_dir(root.join("projects")) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = fs::metadata(entry.path().join(&file)) else {
                continue;
            };
            if meta.is_file() {
                found.push(Found { root: root.to_path_buf(), slug: entry.file_name(), stamp: stamp(&meta)? });
            }
        }
    }

    let Some(newest) = found.iter().max_by_key(|f| f.stamp) else {
        return Ok(false);
    };
    if found.iter().any(|f| same_dir(&f.root, target) && f.stamp >= newest.stamp) {
        return Ok(false);
    }

    let from = newest.root.join("projects").join(&newest.slug);
    let to = target.join("projects").join(&newest.slug);
    copy_file(&from.join(&file), &to.join(&file), Rule::NewestWins)?;
    // Subagent transcripts and tool results the conversation points into.
    let side = from.join(session_id);
    if side.is_dir() {
        copy_tree(&side, &to.join(session_id), Rule::NewestWins)?;
    }
    let memory = from.join("memory");
    if memory.is_dir() {
        copy_tree(&memory, &to.join("memory"), Rule::AddOnly)?;
    }
    Ok(true)
}

/// Bring every project directory of `from_root` into `to_root`, under the same
/// two rules. For a workspace about to be deleted, when nothing will be left to
/// copy from at the next respawn: the whole of `projects/` rather than only the
/// slugs its chats are known by, so a worktree chat or a conversation started
/// in its terminal is not lost with it.
///
/// Stops at the first failure and names the file. A partial copy is left in
/// place: every file in it is either new to the target or a newer copy of one
/// it had, so it has lost nothing, and the caller changes nothing else.
pub fn merge_projects(from_root: &Path, to_root: &Path) -> Result<usize, String> {
    let from = from_root.join("projects");
    let to = to_root.join("projects");
    let entries = match fs::read_dir(&from) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(format!("Could not read {}: {e}", from.display())),
    };
    let mut slugs = 0;
    for entry in entries {
        let entry = entry.map_err(|e| format!("Could not read {}: {e}", from.display()))?;
        let source = entry.path();
        if !is_plain_dir(&source) {
            continue;
        }
        let dest = to.join(entry.file_name());
        for item in fs::read_dir(&source).map_err(|e| format!("Could not read {}: {e}", source.display()))? {
            let item = item.map_err(|e| format!("Could not read {}: {e}", source.display()))?;
            let path = item.path();
            let rule = if item.file_name() == "memory" { Rule::AddOnly } else { Rule::NewestWins };
            let result = if is_plain_dir(&path) {
                copy_tree(&path, &dest.join(item.file_name()), rule)
            } else if is_plain_file(&path) {
                copy_file(&path, &dest.join(item.file_name()), rule).map(|_| ())
            } else {
                Ok(())
            };
            result.map_err(|e| format!("Could not copy {}: {e}", path.display()))?;
        }
        slugs += 1;
    }
    Ok(slugs)
}

fn copy_tree(from: &Path, to: &Path, rule: Rule) -> io::Result<()> {
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let path = entry.path();
        let dest = to.join(entry.file_name());
        if is_plain_dir(&path) {
            copy_tree(&path, &dest, rule)?;
        } else if is_plain_file(&path) {
            copy_file(&path, &dest, rule)?;
        }
    }
    Ok(())
}

/// One file under `rule`. Written to a sibling first and renamed over, so a
/// crash mid-copy can never leave half a transcript where a whole one was, and
/// stamped with the source's time so the next comparison sees them as equal.
fn copy_file(from: &Path, to: &Path, rule: Rule) -> io::Result<bool> {
    let source = fs::metadata(from)?;
    if let Ok(existing) = fs::metadata(to) {
        let keep = match rule {
            Rule::AddOnly => true,
            Rule::NewestWins => stamp(&existing)? >= stamp(&source)?,
        };
        if keep {
            return Ok(false);
        }
    }
    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent)?;
    }
    let temp = to.with_file_name(format!(
        ".{}.nyra-{}",
        to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        std::process::id()
    ));
    fs::copy(from, &temp)?;
    let stamped = fs::OpenOptions::new()
        .write(true)
        .open(&temp)
        .and_then(|file| file.set_modified(source.modified()?));
    if let Err(e) = stamped.and_then(|()| fs::rename(&temp, to)) {
        let _ = fs::remove_file(&temp);
        return Err(e);
    }
    Ok(true)
}

/// Newer, then longer: two copies written in the same second are told apart by
/// which one kept going.
fn stamp(meta: &fs::Metadata) -> io::Result<(SystemTime, u64)> {
    Ok((meta.modified()?, meta.len()))
}

/// A real directory. A link is never followed: nothing under a config dir
/// should be one, and following one could copy from anywhere.
fn is_plain_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|m| m.is_dir()).unwrap_or(false)
}

fn is_plain_file(path: &Path) -> bool {
    fs::symlink_metadata(path).map(|m| m.is_file()).unwrap_or(false)
}

fn same_dir(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    struct Tmp(PathBuf);
    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn tmp(name: &str) -> Tmp {
        let nanos = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("nyra-transcripts-{name}-{nanos}"));
        fs::create_dir_all(&dir).unwrap();
        Tmp(dir)
    }
    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }
    fn age(path: &Path, secs_ago: u64) {
        let file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.set_modified(SystemTime::now() - Duration::from_secs(secs_ago)).unwrap();
    }

    #[test]
    fn a_moved_chat_is_copied_into_the_config_dir_it_now_runs_under() {
        let t = tmp("missing");
        let (default, work) = (t.0.join("default"), t.0.join("work"));
        write(&default.join("projects/-app/s1.jsonl"), "a\nb\n");
        write(&default.join("projects/-app/s1/subagents/x.jsonl"), "sub\n");
        write(&default.join("projects/-app/memory/MEMORY.md"), "- note\n");

        assert!(ensure_resumable_in(&[default.clone(), work.clone()], &work, "s1").unwrap());
        assert_eq!(fs::read_to_string(work.join("projects/-app/s1.jsonl")).unwrap(), "a\nb\n");
        assert!(work.join("projects/-app/s1/subagents/x.jsonl").is_file());
        assert!(work.join("projects/-app/memory/MEMORY.md").is_file());
        // Copied, never moved.
        assert!(default.join("projects/-app/s1.jsonl").is_file());
        // Already there and current: nothing more to do.
        assert!(!ensure_resumable_in(&[default, work.clone()], &work, "s1").unwrap());
    }

    #[test]
    fn the_newest_transcript_wins_when_a_project_comes_back() {
        let t = tmp("newest");
        let (default, work) = (t.0.join("default"), t.0.join("work"));
        // Moved to Work and continued there; Default kept the stale copy.
        write(&default.join("projects/-app/s1.jsonl"), "a\n");
        age(&default.join("projects/-app/s1.jsonl"), 600);
        write(&work.join("projects/-app/s1.jsonl"), "a\nb\nc\n");

        assert!(ensure_resumable_in(&[default.clone(), work.clone()], &default, "s1").unwrap());
        assert_eq!(fs::read_to_string(default.join("projects/-app/s1.jsonl")).unwrap(), "a\nb\nc\n");
    }

    #[test]
    fn memory_is_added_and_never_overwritten() {
        let t = tmp("memory");
        let (default, work) = (t.0.join("default"), t.0.join("work"));
        write(&default.join("projects/-app/s1.jsonl"), "a\n");
        write(&default.join("projects/-app/memory/MEMORY.md"), "default's index\n");
        write(&default.join("projects/-app/memory/new.md"), "only in default\n");
        write(&work.join("projects/-app/memory/MEMORY.md"), "work's index\n");
        age(&work.join("projects/-app/memory/MEMORY.md"), 600);

        ensure_resumable_in(&[default, work.clone()], &work, "s1").unwrap();
        assert_eq!(fs::read_to_string(work.join("projects/-app/memory/MEMORY.md")).unwrap(), "work's index\n");
        assert_eq!(fs::read_to_string(work.join("projects/-app/memory/new.md")).unwrap(), "only in default\n");
    }

    #[test]
    fn a_worktree_chat_is_found_by_name_under_its_own_slug() {
        let t = tmp("worktree");
        let (default, work) = (t.0.join("default"), t.0.join("work"));
        write(&default.join("projects/-app--claude-worktrees-fix/s9.jsonl"), "w\n");
        assert!(ensure_resumable_in(&[default, work.clone()], &work, "s9").unwrap());
        assert!(work.join("projects/-app--claude-worktrees-fix/s9.jsonl").is_file());
    }

    #[test]
    fn a_whole_workspace_merges_into_the_target_under_the_same_rules() {
        let t = tmp("merge");
        let (gone, target) = (t.0.join("gone"), t.0.join("target"));
        write(&gone.join("projects/-a/s1.jsonl"), "newer\n");
        write(&gone.join("projects/-a/memory/MEMORY.md"), "gone's\n");
        write(&gone.join("projects/-b/s2.jsonl"), "b\n");
        write(&target.join("projects/-a/s1.jsonl"), "old\n");
        age(&target.join("projects/-a/s1.jsonl"), 600);
        write(&target.join("projects/-a/memory/MEMORY.md"), "target's\n");

        assert_eq!(merge_projects(&gone, &target).unwrap(), 2);
        assert_eq!(fs::read_to_string(target.join("projects/-a/s1.jsonl")).unwrap(), "newer\n");
        assert_eq!(fs::read_to_string(target.join("projects/-a/memory/MEMORY.md")).unwrap(), "target's\n");
        assert!(target.join("projects/-b/s2.jsonl").is_file());
    }

    #[test]
    fn a_failed_merge_names_the_file() {
        let t = tmp("fail");
        let (gone, target) = (t.0.join("gone"), t.0.join("target"));
        write(&gone.join("projects/-a/s1.jsonl"), "x\n");
        // A file where the slug directory has to go.
        write(&target.join("projects/-a"), "not a directory");
        let err = merge_projects(&gone, &target).unwrap_err();
        assert!(err.contains("s1.jsonl"), "{err}");
    }

    #[test]
    fn nothing_to_merge_is_not_an_error() {
        let t = tmp("empty");
        assert_eq!(merge_projects(&t.0.join("nope"), &t.0.join("target")).unwrap(), 0);
    }
}
