//! Lazily-expanded directory listing for the side panel's file tree.
//!
//! One directory per call. `.gitignore` is applied by asking git rather than by
//! matching patterns ourselves, because git is the only thing that knows about
//! the index: a repo that ignores `.env*` but commits `.env.example` must still
//! show the example, and a pattern matcher cannot know that. The cost is one
//! process spawn per expansion, which is a click, not a keystroke.

use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::time::Duration;

/// Past this a directory is not something you browse. Shown as a count rather
/// than paged — there is no useful way to scroll 5000 siblings.
const MAX_DIR_ENTRIES: usize = 2000;

/// Matches the ceiling `git::git()` uses. A directory on a dead network mount
/// should report what it can, not hang the panel.
const GIT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    /// Base name only. The caller knows the directory it asked about and joins
    /// them itself; repeating the full path on every row is most of the payload
    /// for a directory of 800 files.
    pub name: String,
    #[serde(rename = "type")]
    pub kind: EntryKind,
    /// `kind` is the *target's* kind, so the chevron is right. This is only for
    /// the badge — we do not resolve where it points.
    pub symlink: bool,
    /// Lets the row that opens a file refuse a 500 MB one without a round trip.
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    /// Absolute, exactly as it was asked for. Deliberately not canonicalised: a
    /// managed worktree under ~/.nyra/worktrees must stay that path rather than
    /// collapsing onto the project checkout it was cut from.
    pub path: String,
    pub entries: Vec<DirEntryInfo>,
    pub truncated: bool,
    /// False when nothing was filtered, because there is no repo above `path`.
    /// The panel says so once rather than pretending .gitignore worked.
    pub ignore_applied: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl DirListing {
    fn failed(path: &str, message: impl Into<String>) -> Self {
        Self {
            path: path.to_string(),
            entries: Vec::new(),
            truncated: false,
            ignore_applied: false,
            error: Some(message.into()),
        }
    }
}

/// The policy half, split out so it is testable without a disk.
fn validate_dir_path(dir: &str) -> Result<(), String> {
    if dir.is_empty() {
        return Err("No directory given.".into());
    }
    if !Path::new(dir).is_absolute() {
        return Err("Directory path must be absolute.".into());
    }
    Ok(())
}

/// Never shown, and never reported by git either — it special-cases `.git`
/// outside the ignore machinery entirely. Matched by name rather than by type
/// because in a worktree `.git` is a file.
fn is_always_hidden(name: &str) -> bool {
    name == ".git"
}

/// What `git check-ignore --stdin -z` said.
///
/// The exit code is the whole subtlety. Git returns **1 when nothing matched**,
/// which is success with an empty answer, not failure — read it as an error and
/// every directory that happens to be clean shows `node_modules`.
fn parse_check_ignore(code: Option<i32>, stdout: &[u8]) -> Result<HashSet<String>, String> {
    match code {
        Some(0) => Ok(String::from_utf8_lossy(stdout)
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect()),
        // Nothing in the batch was ignored.
        Some(1) => Ok(HashSet::new()),
        // 128 is "not a git repository"; anything else is git being unhappy in a
        // way we cannot act on. Either way: filter nothing, and say so.
        _ => Err("not a git repository".into()),
    }
}

/// Which of these names git would ignore, and whether it could tell us at all.
async fn ignored_names(dir: &str, names: &[String]) -> (HashSet<String>, bool) {
    use tokio::io::AsyncWriteExt;

    if names.is_empty() {
        return (HashSet::new(), true);
    }

    // Bare base names in, with `current_dir` doing the locating — the same bare
    // names come back, so there is no prefix arithmetic to get wrong.
    let mut payload = Vec::new();
    for name in names {
        payload.extend_from_slice(name.as_bytes());
        payload.push(0);
    }

    let spawned = tokio::process::Command::new("git")
        .args(["check-ignore", "--stdin", "-z"])
        .current_dir(dir)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn();

    let mut child = match spawned {
        Ok(c) => c,
        Err(_) => return (HashSet::new(), false),
    };

    if let Some(mut stdin) = child.stdin.take() {
        // Failing to write is not fatal on its own — collect the output and let
        // the exit code speak.
        let _ = stdin.write_all(&payload).await;
        let _ = stdin.shutdown().await;
    }

    match tokio::time::timeout(GIT_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) => match parse_check_ignore(out.status.code(), &out.stdout) {
            Ok(set) => (set, true),
            Err(_) => (HashSet::new(), false),
        },
        // Timed out or could not be waited on: report the directory unfiltered
        // rather than reporting it empty.
        _ => (HashSet::new(), false),
    }
}

/// Directories first, then case-insensitively by name. Sorted here so the panel
/// does not re-sort on every render, and stable on the raw name so `README` and
/// `readme` cannot swap places between two calls.
fn sort_entries(entries: &mut [DirEntryInfo]) {
    entries.sort_by(|a, b| {
        (a.kind == EntryKind::File)
            .cmp(&(b.kind == EntryKind::File))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
}

async fn read_entries(dir: &str) -> Result<(Vec<DirEntryInfo>, bool), String> {
    let mut reader = tokio::fs::read_dir(dir).await.map_err(|e| e.to_string())?;
    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let mut truncated = false;

    while let Ok(Some(entry)) = reader.next_entry().await {
        if entries.len() >= MAX_DIR_ENTRIES {
            truncated = true;
            break;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_always_hidden(&name) {
            continue;
        }

        // `file_type` is the lstat readdir already paid for. Only a symlink
        // needs a second look, to learn what it points at.
        let Ok(file_type) = entry.file_type().await else {
            continue;
        };
        let symlink = file_type.is_symlink();
        let (kind, size) = if symlink {
            match tokio::fs::metadata(entry.path()).await {
                Ok(meta) if meta.is_dir() => (EntryKind::Dir, 0),
                Ok(meta) => (EntryKind::File, meta.len()),
                // A broken link is still worth showing; it is just not a folder.
                Err(_) => (EntryKind::File, 0),
            }
        } else if file_type.is_dir() {
            (EntryKind::Dir, 0)
        } else {
            (EntryKind::File, entry.metadata().await.map(|m| m.len()).unwrap_or(0))
        };

        entries.push(DirEntryInfo { name, kind, symlink, size });
    }

    Ok((entries, truncated))
}

/// One directory, filtered and sorted.
pub async fn list_dir(dir: &str) -> DirListing {
    if let Err(message) = validate_dir_path(dir) {
        return DirListing::failed(dir, message);
    }

    let (mut entries, truncated) = match read_entries(dir).await {
        Ok(result) => result,
        Err(message) => return DirListing::failed(dir, message),
    };

    let names: Vec<String> = entries.iter().map(|e| e.name.clone()).collect();
    let (ignored, ignore_applied) = ignored_names(dir, &names).await;
    if !ignored.is_empty() {
        entries.retain(|e| !ignored.contains(&e.name));
    }
    sort_entries(&mut entries);

    DirListing {
        path: dir.to_string(),
        entries,
        truncated,
        ignore_applied,
        error: None,
    }
}

/// A flat search result. The filter box is a mode switch, not a tree filter: a
/// lazily-expanded tree only contains what you already opened, so filtering it
/// would match nothing in a fresh panel and look broken.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeSearchResult {
    /// Repo-relative, forward slashes, as `git ls-files` prints them.
    pub paths: Vec<String>,
    pub truncated: bool,
}

/// How well a path answers a query. Lower is better; None means no match.
///
/// A hit in the base name beats a hit in a directory, because typing "auth"
/// should find `useAuth.ts` before `src/auth/legacy/internal/util.ts`. An
/// earlier hit beats a later one, so a prefix wins over a suffix.
fn match_score(path: &str, needle_lower: &str) -> Option<u32> {
    let lower = path.to_lowercase();
    let at = lower.find(needle_lower)?;

    let name_start = lower.rfind('/').map_or(0, |i| i + 1);
    let in_name = at >= name_start;
    let offset = if in_name { at - name_start } else { at };

    // 0 for a base-name hit, 1000 for a directory one: no offset within a
    // directory path can outrank a name match.
    let base = if in_name { 0 } else { 1000 };
    Some(base + offset.min(999) as u32)
}

/// Every tracked-or-untracked path under `cwd` that matches, best first.
pub async fn search_tree(cwd: &str, query: &str, limit: usize) -> TreeSearchResult {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return TreeSearchResult { paths: Vec::new(), truncated: false };
    }

    let listed = match tokio::time::timeout(
        GIT_TIMEOUT,
        tokio::process::Command::new("git")
            .args(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
            .current_dir(cwd)
            .output(),
    )
    .await
    {
        Ok(Ok(out)) if out.status.success() => out.stdout,
        _ => return TreeSearchResult { paths: Vec::new(), truncated: false },
    };

    let text = String::from_utf8_lossy(&listed);
    let mut scored: Vec<(u32, &str)> = text
        .split('\0')
        .filter(|p| !p.is_empty())
        .filter_map(|p| match_score(p, &needle).map(|score| (score, p)))
        .collect();

    // Ties broken by path, so the same query twice gives the same order.
    scored.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(b.1)));

    let truncated = scored.len() > limit;
    TreeSearchResult {
        paths: scored.into_iter().take(limit).map(|(_, p)| p.to_string()).collect(),
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(name: &str, kind: EntryKind) -> DirEntryInfo {
        DirEntryInfo { name: name.into(), kind, symlink: false, size: 0 }
    }

    // The one that matters most. Git exits 1 when *nothing* in the batch was
    // ignored; treating that as failure shows node_modules in every clean
    // directory in the repo.
    #[test]
    fn empty_output_with_exit_1_means_nothing_ignored() {
        assert_eq!(parse_check_ignore(Some(1), b""), Ok(HashSet::new()));
    }

    #[test]
    fn reads_a_nul_separated_answer() {
        let got = parse_check_ignore(Some(0), b"target\0node_modules\0").unwrap();
        assert_eq!(got, HashSet::from(["target".into(), "node_modules".into()]));
    }

    #[test]
    fn tolerates_a_missing_trailing_nul_and_a_name_with_a_newline() {
        let got = parse_check_ignore(Some(0), b"we\nird\0last").unwrap();
        assert_eq!(got, HashSet::from(["we\nird".into(), "last".into()]));
    }

    #[test]
    fn outside_a_repo_is_an_error_not_an_empty_answer() {
        assert!(parse_check_ignore(Some(128), b"").is_err());
        assert!(parse_check_ignore(None, b"").is_err());
    }

    #[test]
    fn hides_the_git_directory_and_nothing_that_merely_looks_like_it() {
        assert!(is_always_hidden(".git"));
        assert!(!is_always_hidden(".github"));
        assert!(!is_always_hidden(".gitignore"));
        assert!(!is_always_hidden("git"));
    }

    #[test]
    fn sorts_directories_first_then_case_insensitively() {
        let mut entries = vec![
            entry("readme.md", EntryKind::File),
            entry("Zed", EntryKind::Dir),
            entry("README.md", EntryKind::File),
            entry("apple", EntryKind::Dir),
        ];
        sort_entries(&mut entries);
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["apple", "Zed", "README.md", "readme.md"]);
    }

    #[test]
    fn serializes_the_shape_the_renderer_expects() {
        let listing = DirListing {
            path: "/p".into(),
            entries: vec![entry("src", EntryKind::Dir)],
            truncated: false,
            ignore_applied: true,
            error: None,
        };
        let json = serde_json::to_value(&listing).unwrap();
        assert_eq!(json["ignoreApplied"], true);
        assert_eq!(json["entries"][0]["type"], "dir");
        assert_eq!(json["entries"][0]["name"], "src");
        // Absent rather than null, so `error` reads as optional on the far side.
        assert!(json.get("error").is_none());
    }

    #[test]
    fn ranks_a_name_hit_above_a_directory_hit() {
        let name = match_score("src/useAuth.ts", "auth").unwrap();
        let dir = match_score("src/auth/legacy/internal/util.ts", "auth").unwrap();
        assert!(name < dir);
    }

    #[test]
    fn ranks_an_earlier_hit_above_a_later_one() {
        let early = match_score("src/authorize.ts", "auth").unwrap();
        let late = match_score("src/reauthorize.ts", "auth").unwrap();
        assert!(early < late);
    }

    #[test]
    fn matches_without_regard_to_case_and_misses_cleanly() {
        assert!(match_score("src/UseAuth.ts", "auth").is_some());
        assert!(match_score("src/index.ts", "auth").is_none());
    }

    #[test]
    fn refuses_a_path_it_cannot_locate() {
        assert!(validate_dir_path("").is_err());
        assert!(validate_dir_path("src").is_err());
        assert!(validate_dir_path("./src").is_err());
        assert!(validate_dir_path("../src").is_err());
        assert!(validate_dir_path("/Users/x/project").is_ok());
    }
}
