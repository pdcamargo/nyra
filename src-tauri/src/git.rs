//! Thin wrappers over the `git` CLI for the branch pill and worktree dialog.

use serde_json::{json, Value};
use std::time::Duration;
use tokio::process::Command;

async fn git(cwd: &str, args: &[&str], timeout_ms: u64) -> Result<std::process::Output, String> {
    tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        Command::new("git").args(args).current_dir(cwd).output(),
    )
    .await
    .map_err(|_| "git timed out".to_string())?
    .map_err(|e| e.to_string())
}

pub async fn branch(cwd: &str) -> String {
    match git(cwd, &["branch", "--show-current"], 3000).await {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => String::new(),
    }
}

/// Local branch names, most recently committed first — the order a branch
/// picker wants, since the branch you reach for is usually the one you last
/// touched. The current branch is included; callers mark it themselves.
pub async fn branch_list(cwd: &str) -> Vec<String> {
    match git(
        cwd,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)",
            "refs/heads",
        ],
        5000,
    )
    .await
    {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// Check out a branch, creating it first when `create` is set.
///
/// This mutates the user's checkout, so it is only ever reached from an explicit
/// menu choice. Git's own refusal (dirty tree, name already taken) is surfaced
/// rather than swallowed — it is the only thing that can tell the user why.
pub async fn checkout(cwd: &str, branch_name: &str, create: bool) -> Value {
    let args: Vec<&str> = if create {
        vec!["checkout", "-b", branch_name]
    } else {
        vec!["checkout", branch_name]
    };
    match git(cwd, &args, 15000).await {
        Ok(out) if out.status.success() => json!({ "success": true }),
        Ok(out) => json!({
            "success": false,
            "error": String::from_utf8_lossy(&out.stderr).trim(),
        }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}

pub async fn is_repo(cwd: &str) -> bool {
    matches!(
        git(cwd, &["rev-parse", "--is-inside-work-tree"], 3000).await,
        Ok(out) if out.status.success()
    )
}

pub async fn worktree_create(cwd: &str, branch_name: &str) -> Value {
    let safe: String = branch_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    let worktree_path = std::path::Path::new(cwd)
        .join("..")
        .join(format!(".nyra-worktree-{safe}"))
        .to_string_lossy()
        .to_string();

    match git(cwd, &["worktree", "add", "-b", branch_name, &worktree_path], 10_000).await {
        Ok(out) if out.status.success() => json!({ "path": worktree_path, "branch": branch_name }),
        first => {
            // `-b` fails when the branch already exists; retry checking it out.
            match git(cwd, &["worktree", "add", &worktree_path, branch_name], 10_000).await {
                Ok(out) if out.status.success() => {
                    json!({ "path": worktree_path, "branch": branch_name })
                }
                Ok(out) => json!({
                    "path": "",
                    "branch": branch_name,
                    "error": String::from_utf8_lossy(&out.stderr).trim(),
                }),
                Err(e) => {
                    let _ = first;
                    json!({ "path": "", "branch": branch_name, "error": e })
                }
            }
        }
    }
}

/// The main working tree of whatever repo `cwd` belongs to.
///
/// `git worktree list --porcelain` always lists the main worktree first. This is
/// the only reliable way back to it from inside a linked worktree — the previous
/// approach derived it by string-substituting the worktree path out of the cwd,
/// which yields the worktree itself and silently broke both merge and remove.
pub async fn main_worktree_root(cwd: &str) -> Option<String> {
    let out = git(cwd, &["worktree", "list", "--porcelain"], 5000).await.ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|line| line.strip_prefix("worktree ").map(str::to_string))
}

/// Merge a worktree's branch back into the main working tree.
///
/// `cwd` may be anywhere inside the repo, including the worktree being merged.
pub async fn worktree_merge(cwd: &str, branch_name: &str) -> Value {
    let Some(root) = main_worktree_root(cwd).await else {
        return json!({ "success": false, "error": "Not inside a git repository" });
    };

    // Merging a branch into itself reports "Already up to date" and exits 0, which
    // is exactly how the old button claimed success without ever merging.
    let target = branch(&root).await;
    if target == branch_name {
        return json!({
            "success": false,
            "error": format!("The main worktree is already on '{branch_name}' — check it out elsewhere first"),
        });
    }

    match git(&root, &["merge", branch_name], 15_000).await {
        Ok(out) if out.status.success() => json!({ "success": true, "into": target }),
        Ok(out) => {
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let msg = if stderr.is_empty() {
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            } else {
                stderr
            };
            json!({ "success": false, "error": msg })
        }
        Err(e) => json!({ "success": false, "error": e }),
    }
}

/// Remove a worktree. Git refuses to remove the worktree you are standing in, so
/// this always runs from the main working tree.
pub async fn worktree_remove(cwd: &str, worktree_path: &str) -> Value {
    let root = main_worktree_root(cwd)
        .await
        .unwrap_or_else(|| cwd.to_string());
    match git(&root, &["worktree", "remove", worktree_path, "--force"], 10_000).await {
        Ok(out) if out.status.success() => json!({ "success": true }),
        Ok(out) => json!({
            "success": false,
            "error": String::from_utf8_lossy(&out.stderr).trim(),
        }),
        Err(e) => json!({ "success": false, "error": e }),
    }
}


// ---- managed worktrees ----

/// Where Codex-style managed worktrees live. Beside the workflow store, not
/// beside the project — the old `<project>/../.nyra-worktree-<branch>` location
/// littered the parent directory of every repo you touched.
pub fn worktrees_root() -> std::path::PathBuf {
    crate::util::home_dir().join(".nyra").join("worktrees")
}

fn slug(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = true;
    for c in input.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "x".to_string()
    } else {
        trimmed.chars().take(40).collect()
    }
}

/// FNV-1a. Deterministic across runs, which `DefaultHasher` only accidentally is,
/// and a worktree directory has to keep the same name between app launches.
fn short_hash(input: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in input.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:08x}")[..8].to_string()
}

/// `~/.nyra/worktrees/<project>-<hash>/<branch>-<rand>`.
///
/// Namespaced by project because a flat directory collides the moment two
/// projects both want a `main` worktree, and suffixed per worktree because the
/// branch slug alone maps `feat/pay` and `feat-pay` onto the same path.
pub fn managed_worktree_path(project_path: &str, branch_name: &str) -> String {
    let project = std::path::Path::new(project_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "project".into());
    worktrees_root()
        .join(format!("{}-{}", slug(&project), short_hash(project_path)))
        .join(format!("{}-{}", slug(branch_name), crate::util::rand_suffix(4)))
        .to_string_lossy()
        .to_string()
}

/// Every working tree of the repo `cwd` belongs to, main first.
pub async fn worktree_list(cwd: &str) -> Vec<Value> {
    let Ok(out) = git(cwd, &["worktree", "list", "--porcelain"], 5000).await else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut trees = Vec::new();
    let mut path = String::new();
    let mut branch_name = String::new();
    let mut detached = false;

    let flush = |path: &mut String, branch_name: &mut String, detached: &mut bool, trees: &mut Vec<Value>| {
        if path.is_empty() {
            return;
        }
        trees.push(json!({
            "path": path.clone(),
            "branch": branch_name.clone(),
            "detached": *detached,
        }));
        path.clear();
        branch_name.clear();
        *detached = false;
    };

    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut path, &mut branch_name, &mut detached, &mut trees);
            path = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch_name = rest.trim_start_matches("refs/heads/").to_string();
        } else if line.trim() == "detached" {
            detached = true;
        }
    }
    flush(&mut path, &mut branch_name, &mut detached, &mut trees);
    trees
}

/// Patterns naming ignored files that should still reach a new worktree.
///
/// Same filename Codex uses, so a repo already configured for it works here
/// untouched. Lines are git pathspecs; `..` is refused so a pattern can't reach
/// outside the checkout.
fn read_worktree_include(main: &str) -> Vec<String> {
    let path = std::path::Path::new(main).join(".worktreeinclude");
    let Ok(text) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter(|l| !l.contains("..") && !l.starts_with('/'))
        .map(str::to_string)
        .collect()
}

/// NUL-separated `git ls-files` output.
async fn list_files(cwd: &str, args: &[&str]) -> Vec<String> {
    match git(cwd, args, 10_000).await {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
            .split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

/// Copy one file into the worktree, honouring Codex's two rules: symlinks are
/// skipped, and an existing file in the new checkout is never overwritten.
fn copy_into_worktree(main: &str, worktree: &str, rel: &str) -> bool {
    let src = std::path::Path::new(main).join(rel);
    let dst = std::path::Path::new(worktree).join(rel);
    if dst.exists() {
        return false;
    }
    match std::fs::symlink_metadata(&src) {
        Ok(meta) if meta.file_type().is_symlink() => return false,
        Ok(meta) if meta.is_dir() => return false,
        Ok(_) => {}
        Err(_) => return false,
    }
    if let Some(parent) = dst.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return false;
        }
    }
    std::fs::copy(&src, &dst).is_ok()
}

/// Carry the main checkout's work in progress into a fresh worktree.
///
/// `git worktree add` branches from a commit, so without this the agent reads an
/// older version of the files you are actively editing — the stale-work problem.
/// Three sources, matching Codex: tracked modifications as a patch, untracked
/// files that git would report in `status`, and ignored files only when
/// `.worktreeinclude` asks for them.
async fn seed_worktree(main: &str, worktree: &str) -> Value {
    let mut applied_patch = false;
    let mut copied = 0usize;

    // 1. Tracked modifications, staged or not.
    if let Ok(out) = git(main, &["diff", "HEAD", "--binary"], 15_000).await {
        if out.status.success() && !out.stdout.is_empty() {
            let patch = std::env::temp_dir()
                .join(format!("nyra-seed-{}.patch", crate::util::rand_suffix(8)));
            if std::fs::write(&patch, &out.stdout).is_ok() {
                let patch_arg = patch.to_string_lossy().to_string();
                if let Ok(apply) = git(
                    worktree,
                    &["apply", "--whitespace=nowarn", &patch_arg],
                    15_000,
                )
                .await
                {
                    applied_patch = apply.status.success();
                    if !applied_patch {
                        crate::logf!(
                            "worktree seed: patch did not apply cleanly: {}",
                            String::from_utf8_lossy(&apply.stderr).trim()
                        );
                    }
                }
                let _ = std::fs::remove_file(&patch);
            }
        }
    }

    // 2. Untracked files git would show in `status` — often the newest work.
    for rel in list_files(main, &["ls-files", "--others", "--exclude-standard", "-z"]).await {
        if copy_into_worktree(main, worktree, &rel) {
            copied += 1;
        }
    }

    // 3. Ignored files, but only the ones .worktreeinclude names. Without this a
    //    worktree starts with no .env and the project does not run.
    let patterns = read_worktree_include(main);
    if !patterns.is_empty() {
        let mut args: Vec<&str> = vec![
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "-z",
            "--",
        ];
        args.extend(patterns.iter().map(String::as_str));
        for rel in list_files(main, &args).await {
            if copy_into_worktree(main, worktree, &rel) {
                copied += 1;
            }
        }
    }

    json!({ "patchApplied": applied_patch, "filesCopied": copied })
}

/// Create a managed worktree for one chat.
///
/// `base_ref` empty means the current HEAD. Seeding only runs when the worktree
/// starts from the current HEAD — applying the main tree's diff on top of some
/// other branch is how you get conflicts you never asked for.
pub async fn worktree_create_managed(
    cwd: &str,
    branch_name: &str,
    base_ref: Option<&str>,
    seed: bool,
) -> Value {
    let Some(root) = main_worktree_root(cwd).await else {
        return json!({ "path": "", "branch": branch_name, "error": "Not inside a git repository" });
    };

    let dest = managed_worktree_path(&root, branch_name);
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return json!({ "path": "", "branch": branch_name, "error": e.to_string() });
        }
    }

    let base = base_ref.filter(|b| !b.is_empty()).unwrap_or("HEAD");
    let mut args = vec!["worktree", "add", "-b", branch_name, &dest, base];
    let mut out = git(&root, &args, 20_000).await;

    // `-b` fails when the branch already exists; check it out instead.
    if !matches!(&out, Ok(o) if o.status.success()) {
        args = vec!["worktree", "add", &dest, branch_name];
        out = git(&root, &args, 20_000).await;
    }

    match out {
        Ok(o) if o.status.success() => {
            let current = branch(&root).await;
            let seeded = if seed && (base == "HEAD" || base == current) {
                seed_worktree(&root, &dest).await
            } else {
                json!({ "patchApplied": false, "filesCopied": 0 })
            };
            json!({ "path": dest, "branch": branch_name, "managed": true, "seeded": seeded })
        }
        Ok(o) => json!({
            "path": "",
            "branch": branch_name,
            "error": String::from_utf8_lossy(&o.stderr).trim(),
        }),
        Err(e) => json!({ "path": "", "branch": branch_name, "error": e }),
    }
}

/// Insertions and deletions for a chat's changes.
///
/// `base` empty compares the working tree against HEAD — the right question for a
/// chat running in the main checkout. A worktree chat passes its base branch, and
/// gets everything the branch has done since it diverged, working tree included.
pub async fn diff_stat(cwd: &str, base: Option<&str>) -> Value {
    let target = match base.filter(|b| !b.is_empty()) {
        Some(base) => match git(cwd, &["merge-base", base, "HEAD"], 5000).await {
            Ok(out) if out.status.success() => {
                String::from_utf8_lossy(&out.stdout).trim().to_string()
            }
            _ => "HEAD".to_string(),
        },
        None => "HEAD".to_string(),
    };

    let Ok(out) = git(cwd, &["diff", "--shortstat", &target], 10_000).await else {
        return json!({ "insertions": 0, "deletions": 0, "filesChanged": 0 });
    };
    if !out.status.success() {
        return json!({ "insertions": 0, "deletions": 0, "filesChanged": 0 });
    }
    json!(parse_shortstat(&String::from_utf8_lossy(&out.stdout)))
}

/// `2 files changed, 10 insertions(+), 3 deletions(-)` → the three numbers.
fn parse_shortstat(text: &str) -> Value {
    let mut files = 0u64;
    let mut insertions = 0u64;
    let mut deletions = 0u64;
    let tokens: Vec<&str> = text.split_whitespace().collect();
    for (i, token) in tokens.iter().enumerate() {
        if i == 0 {
            continue;
        }
        let Ok(n) = tokens[i - 1].parse::<u64>() else {
            continue;
        };
        if token.starts_with("file") {
            files = n;
        } else if token.starts_with("insertion") {
            insertions = n;
        } else if token.starts_with("deletion") {
            deletions = n;
        }
    }
    json!({ "filesChanged": files, "insertions": insertions, "deletions": deletions })
}


/// Where a pruned worktree's work is parked so it can come back.
pub fn snapshots_root() -> std::path::PathBuf {
    crate::util::home_dir().join(".nyra").join("worktree-snapshots")
}

/// Save enough to reconstruct a managed worktree before deleting it.
///
/// Auto-pruning at a cap is destructive by default; the snapshot is what makes it
/// acceptable. Two pieces: a bundle of the commits the branch added since it
/// diverged, and a patch of whatever was never committed. The bundle is a range,
/// not the whole history — fifteen full-repo bundles would be gigabytes.
pub async fn worktree_snapshot(worktree_path: &str, branch_name: &str, session_id: &str) -> Value {
    let dest = snapshots_root().join(session_id);
    if let Err(e) = std::fs::create_dir_all(&dest) {
        return json!({ "success": false, "error": e.to_string() });
    }

    let mut bundled = false;
    if let Some(root) = main_worktree_root(worktree_path).await {
        let main_branch = branch(&root).await;
        if !main_branch.is_empty() && main_branch != branch_name {
            if let Ok(out) = git(worktree_path, &["merge-base", &main_branch, branch_name], 5000).await {
                if out.status.success() {
                    let base = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    let bundle = dest.join("branch.bundle").to_string_lossy().to_string();
                    let range = format!("{base}..{branch_name}");
                    bundled = matches!(
                        git(worktree_path, &["bundle", "create", &bundle, &range], 30_000).await,
                        Ok(o) if o.status.success()
                    );
                }
            }
        }
    }

    // `add -N` so brand-new files show up in the diff. The worktree is about to be
    // removed, so mutating its index costs nothing.
    let _ = git(worktree_path, &["add", "-AN"], 10_000).await;
    let mut patched = false;
    if let Ok(out) = git(worktree_path, &["diff", "HEAD", "--binary"], 15_000).await {
        if out.status.success() && !out.stdout.is_empty() {
            patched = std::fs::write(dest.join("uncommitted.patch"), &out.stdout).is_ok();
        }
    }

    let meta = json!({
        "branch": branch_name,
        "originalPath": worktree_path,
        "bundled": bundled,
        "patched": patched,
        "createdAt": crate::util::now_ms(),
    });
    let _ = std::fs::write(
        dest.join("meta.json"),
        serde_json::to_vec_pretty(&meta).unwrap_or_default(),
    );

    json!({ "success": true, "path": dest.to_string_lossy(), "bundled": bundled, "patched": patched })
}

/// Rebuild a worktree from a snapshot, at a fresh managed path.
pub async fn worktree_restore(cwd: &str, session_id: &str) -> Value {
    let dir = snapshots_root().join(session_id);
    let Ok(meta_raw) = std::fs::read_to_string(dir.join("meta.json")) else {
        return json!({ "success": false, "error": "No snapshot for this chat" });
    };
    let meta: Value = serde_json::from_str(&meta_raw).unwrap_or_default();
    let branch_name = meta["branch"].as_str().unwrap_or_default().to_string();
    if branch_name.is_empty() {
        return json!({ "success": false, "error": "Snapshot is missing its branch" });
    }

    let Some(root) = main_worktree_root(cwd).await else {
        return json!({ "success": false, "error": "Not inside a git repository" });
    };

    // Same repo, so the bundle's base commit is already here — a range bundle is
    // all that's needed to bring the branch back.
    let bundle = dir.join("branch.bundle");
    if bundle.exists() {
        let bundle_arg = bundle.to_string_lossy().to_string();
        let refspec = format!("{branch_name}:{branch_name}");
        let _ = git(&root, &["fetch", &bundle_arg, &refspec], 30_000).await;
    }

    let dest = managed_worktree_path(&root, &branch_name);
    if let Some(parent) = std::path::Path::new(&dest).parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let added = git(&root, &["worktree", "add", &dest, &branch_name], 20_000).await;
    match added {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            return json!({ "success": false, "error": String::from_utf8_lossy(&o.stderr).trim() })
        }
        Err(e) => return json!({ "success": false, "error": e }),
    }

    let patch = dir.join("uncommitted.patch");
    if patch.exists() {
        let patch_arg = patch.to_string_lossy().to_string();
        let _ = git(&dest, &["apply", "--whitespace=nowarn", &patch_arg], 15_000).await;
    }

    json!({ "success": true, "path": dest, "branch": branch_name })
}

/// Forget a snapshot once its worktree is back, or its chat is gone for good.
pub fn snapshot_discard(session_id: &str) {
    let _ = std::fs::remove_dir_all(snapshots_root().join(session_id));
}

pub fn snapshot_exists(session_id: &str) -> bool {
    snapshots_root().join(session_id).join("meta.json").exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    /// A throwaway repo with one commit on `main`.
    struct TempRepo(PathBuf);

    impl TempRepo {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("nyra-git-{tag}-{}", crate::util::rand_suffix(8)));
            std::fs::create_dir_all(&dir).unwrap();
            let repo = TempRepo(dir);
            repo.git(&["init", "-b", "main"]);
            repo.git(&["config", "user.email", "test@nyra.local"]);
            repo.git(&["config", "user.name", "Nyra Test"]);
            std::fs::write(repo.path().join("README.md"), "base\n").unwrap();
            repo.git(&["add", "."]);
            repo.git(&["commit", "-m", "init"]);
            repo
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn git(&self, args: &[&str]) -> String {
            self.git_in(self.path(), args)
        }

        fn git_in(&self, cwd: &Path, args: &[&str]) -> String {
            let out = Command::new("git").args(args).current_dir(cwd).output().unwrap();
            assert!(out.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&out.stderr));
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn finds_the_main_worktree_from_inside_a_linked_one() {
        let repo = TempRepo::new("root");
        let wt = repo.path().parent().unwrap().join(format!("wt-{}", crate::util::rand_suffix(6)));
        repo.git(&["worktree", "add", "-b", "feat", wt.to_str().unwrap()]);

        let found = main_worktree_root(wt.to_str().unwrap()).await.unwrap();
        // macOS hands back /private/var for /var, so compare canonical paths.
        assert_eq!(
            std::fs::canonicalize(&found).unwrap(),
            std::fs::canonicalize(repo.path()).unwrap()
        );

        repo.git(&["worktree", "remove", wt.to_str().unwrap(), "--force"]);
    }

    #[tokio::test]
    async fn merges_a_worktree_branch_into_the_main_tree() {
        let repo = TempRepo::new("merge");
        let wt = repo.path().parent().unwrap().join(format!("wt-{}", crate::util::rand_suffix(6)));
        repo.git(&["worktree", "add", "-b", "feat", wt.to_str().unwrap()]);

        // Commit something only the worktree branch has.
        std::fs::write(wt.join("feature.txt"), "from the worktree\n").unwrap();
        repo.git_in(&wt, &["add", "."]);
        repo.git_in(&wt, &["commit", "-m", "add feature"]);
        assert!(!repo.path().join("feature.txt").exists());

        // Called with the worktree's own path — exactly what the UI passes.
        let result = worktree_merge(wt.to_str().unwrap(), "feat").await;

        assert_eq!(result["success"], serde_json::json!(true), "merge failed: {result}");
        assert_eq!(result["into"], serde_json::json!("main"));
        assert!(
            repo.path().join("feature.txt").exists(),
            "the commit never reached the main working tree"
        );

        repo.git(&["worktree", "remove", wt.to_str().unwrap(), "--force"]);
    }

    #[tokio::test]
    async fn refuses_to_merge_a_branch_into_itself() {
        // The old code resolved the target to the worktree itself, so git said
        // "Already up to date", exited 0, and the UI reported a successful merge
        // that had moved nothing.
        let repo = TempRepo::new("selfmerge");
        let result = worktree_merge(repo.path().to_str().unwrap(), "main").await;

        assert_eq!(result["success"], serde_json::json!(false));
        assert!(
            result["error"].as_str().unwrap().contains("already on"),
            "unexpected error: {result}"
        );
    }

    #[tokio::test]
    async fn removes_a_worktree_while_the_session_sits_inside_it() {
        let repo = TempRepo::new("remove");
        let wt = repo.path().parent().unwrap().join(format!("wt-{}", crate::util::rand_suffix(6)));
        repo.git(&["worktree", "add", "-b", "feat", wt.to_str().unwrap()]);
        assert!(wt.exists());

        // git refuses to remove the worktree you are standing in; the backend has
        // to run this from the main tree.
        let result = worktree_remove(wt.to_str().unwrap(), wt.to_str().unwrap()).await;

        assert_eq!(result["success"], serde_json::json!(true), "remove failed: {result}");
        assert!(!wt.exists(), "worktree directory is still on disk");
    }

    #[test]
    fn slugs_are_filesystem_safe_and_stable() {
        assert_eq!(slug("feat/payments"), "feat-payments");
        assert_eq!(slug("  Feature #42!! "), "feature-42");
        assert_eq!(slug("!!!"), "x");
        // Same input, same answer — the directory has to survive a relaunch.
        assert_eq!(short_hash("/Users/me/dev/nyra"), short_hash("/Users/me/dev/nyra"));
        assert_ne!(short_hash("/Users/me/dev/nyra"), short_hash("/Users/me/oss/nyra"));
    }

    #[test]
    fn managed_paths_are_namespaced_per_project() {
        // A flat worktrees dir collides the moment two projects both want `main`.
        let a = managed_worktree_path("/Users/me/work/api", "main");
        let b = managed_worktree_path("/Users/me/oss/api", "main");
        let parent = |p: &str| {
            std::path::Path::new(p).parent().unwrap().to_string_lossy().to_string()
        };
        assert_ne!(parent(&a), parent(&b));
        assert!(a.starts_with(&worktrees_root().to_string_lossy().to_string()));
    }

    #[test]
    fn managed_paths_separate_branches_that_slug_the_same() {
        // `feat/pay` and `feat-pay` both slug to `feat-pay`; the random suffix is
        // what stops them landing in one directory.
        let a = managed_worktree_path("/repo", "feat/pay");
        let b = managed_worktree_path("/repo", "feat-pay");
        assert_ne!(a, b);
    }

    #[test]
    fn parses_shortstat_output() {
        let v = parse_shortstat(" 2 files changed, 10 insertions(+), 3 deletions(-)\n");
        assert_eq!(v["filesChanged"], serde_json::json!(2));
        assert_eq!(v["insertions"], serde_json::json!(10));
        assert_eq!(v["deletions"], serde_json::json!(3));

        // Deletion-only and insertion-only diffs omit the other clause entirely.
        let only_del = parse_shortstat(" 1 file changed, 4 deletions(-)\n");
        assert_eq!(only_del["insertions"], serde_json::json!(0));
        assert_eq!(only_del["deletions"], serde_json::json!(4));

        // No changes at all: git prints nothing.
        let empty = parse_shortstat("");
        assert_eq!(empty["filesChanged"], serde_json::json!(0));
    }

    #[tokio::test]
    async fn lists_every_working_tree_main_first() {
        let repo = TempRepo::new("list");
        let wt = repo.path().parent().unwrap().join(format!("wt-{}", crate::util::rand_suffix(6)));
        repo.git(&["worktree", "add", "-b", "feat", wt.to_str().unwrap()]);

        let trees = worktree_list(repo.path().to_str().unwrap()).await;
        assert_eq!(trees.len(), 2, "expected main + linked: {trees:?}");
        assert_eq!(trees[0]["branch"], serde_json::json!("main"));
        assert_eq!(trees[1]["branch"], serde_json::json!("feat"));

        repo.git(&["worktree", "remove", wt.to_str().unwrap(), "--force"]);
    }

    #[tokio::test]
    async fn seeds_a_new_worktree_with_work_in_progress() {
        let repo = TempRepo::new("seed");

        // A tracked file edited but not committed.
        std::fs::write(repo.path().join("README.md"), "base\nedited in the main tree\n").unwrap();
        // A brand-new file that was never added.
        std::fs::write(repo.path().join("scratch.txt"), "new work\n").unwrap();
        // An ignored file the project needs, and one it does not.
        std::fs::write(repo.path().join(".gitignore"), ".env\nsecret.txt\n").unwrap();
        std::fs::write(repo.path().join(".env"), "TOKEN=abc\n").unwrap();
        std::fs::write(repo.path().join("secret.txt"), "do not copy\n").unwrap();
        std::fs::write(repo.path().join(".worktreeinclude"), "# needed to boot\n.env\n").unwrap();
        repo.git(&["add", ".gitignore", ".worktreeinclude"]);
        repo.git(&["commit", "-m", "ignore rules"]);

        let result = worktree_create_managed(
            repo.path().to_str().unwrap(),
            "feat/seeded",
            None,
            true,
        )
        .await;
        let dest = result["path"].as_str().unwrap_or_default().to_string();
        assert!(!dest.is_empty(), "create failed: {result}");
        let wt = std::path::Path::new(&dest);

        assert_eq!(
            std::fs::read_to_string(wt.join("README.md")).unwrap(),
            "base\nedited in the main tree\n",
            "tracked modifications did not follow the worktree"
        );
        assert!(wt.join("scratch.txt").exists(), "untracked work did not follow");
        assert_eq!(
            std::fs::read_to_string(wt.join(".env")).unwrap(),
            "TOKEN=abc\n",
            ".worktreeinclude did not bring .env across"
        );
        assert!(
            !wt.join("secret.txt").exists(),
            "an ignored file nobody asked for was copied"
        );

        repo.git(&["worktree", "remove", &dest, "--force"]);
        let _ = std::fs::remove_dir_all(wt.parent().unwrap());
    }

    #[tokio::test]
    async fn seeding_never_overwrites_a_file_the_checkout_already_has() {
        let repo = TempRepo::new("nooverwrite");
        // Committed on a second branch, so the worktree starts with content that
        // the main tree also has an untracked copy of.
        repo.git(&["checkout", "-b", "other"]);
        std::fs::write(repo.path().join("shared.txt"), "from the branch\n").unwrap();
        repo.git(&["add", "."]);
        repo.git(&["commit", "-m", "branch version"]);
        repo.git(&["checkout", "main"]);
        std::fs::write(repo.path().join("shared.txt"), "from the main tree\n").unwrap();

        let result =
            worktree_create_managed(repo.path().to_str().unwrap(), "other", None, true).await;
        let dest = result["path"].as_str().unwrap_or_default().to_string();
        assert!(!dest.is_empty(), "create failed: {result}");

        assert_eq!(
            std::fs::read_to_string(std::path::Path::new(&dest).join("shared.txt")).unwrap(),
            "from the branch\n",
            "the checkout's own file was clobbered by the seed"
        );

        repo.git(&["worktree", "remove", &dest, "--force"]);
        let _ = std::fs::remove_dir_all(std::path::Path::new(&dest).parent().unwrap());
    }

    #[tokio::test]
    async fn counts_changes_against_a_base() {
        let repo = TempRepo::new("diffstat");

        // Nothing changed yet.
        let clean = diff_stat(repo.path().to_str().unwrap(), None).await;
        assert_eq!(clean["insertions"], serde_json::json!(0));

        std::fs::write(repo.path().join("README.md"), "base\nplus one\nplus two\n").unwrap();
        let dirty = diff_stat(repo.path().to_str().unwrap(), None).await;
        assert_eq!(dirty["filesChanged"], serde_json::json!(1));
        assert_eq!(dirty["insertions"], serde_json::json!(2));
    }

    #[tokio::test]
    async fn snapshots_a_worktree_and_brings_it_back() {
        let repo = TempRepo::new("snapshot");
        let created =
            worktree_create_managed(repo.path().to_str().unwrap(), "feat/snap", None, false).await;
        let dest = created["path"].as_str().unwrap().to_string();

        // One commit, plus something never committed.
        std::fs::write(std::path::Path::new(&dest).join("committed.txt"), "kept\n").unwrap();
        repo.git_in(std::path::Path::new(&dest), &["add", "."]);
        repo.git_in(std::path::Path::new(&dest), &["commit", "-m", "work"]);
        std::fs::write(std::path::Path::new(&dest).join("in-flight.txt"), "not committed\n").unwrap();

        let session = format!("sess-{}", crate::util::rand_suffix(6));
        let snap = worktree_snapshot(&dest, "feat/snap", &session).await;
        assert_eq!(snap["success"], serde_json::json!(true), "snapshot failed: {snap}");
        assert!(snapshot_exists(&session));

        // Prune it the way the cap would.
        repo.git(&["worktree", "remove", &dest, "--force"]);
        repo.git(&["branch", "-D", "feat/snap"]);
        assert!(!std::path::Path::new(&dest).exists());

        let restored = worktree_restore(repo.path().to_str().unwrap(), &session).await;
        assert_eq!(restored["success"], serde_json::json!(true), "restore failed: {restored}");
        let back = restored["path"].as_str().unwrap().to_string();
        assert!(
            std::path::Path::new(&back).join("committed.txt").exists(),
            "the committed work did not come back"
        );
        assert!(
            std::path::Path::new(&back).join("in-flight.txt").exists(),
            "the uncommitted work did not come back"
        );

        repo.git(&["worktree", "remove", &back, "--force"]);
        snapshot_discard(&session);
        assert!(!snapshot_exists(&session));
        let _ = std::fs::remove_dir_all(std::path::Path::new(&back).parent().unwrap());
    }

    #[tokio::test]
    async fn reports_branch_and_repo_detection() {
        let repo = TempRepo::new("branch");
        assert_eq!(branch(repo.path().to_str().unwrap()).await, "main");
        assert!(is_repo(repo.path().to_str().unwrap()).await);

        let plain = std::env::temp_dir().join(format!("nyra-plain-{}", crate::util::rand_suffix(8)));
        std::fs::create_dir_all(&plain).unwrap();
        assert!(!is_repo(plain.to_str().unwrap()).await);
        std::fs::remove_dir_all(&plain).ok();
    }
}
