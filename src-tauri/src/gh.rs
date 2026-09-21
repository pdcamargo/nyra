//! What the GitHub CLI can tell us about a PR.
//!
//! Nyra learns a PR's *number* by watching `gh pr create` go past in the
//! transcript; everything else — is it open, is it a draft, was it merged, what
//! is it called — has to be asked for. That matters because the chip is colour
//! coded the way GitHub itself is, so a wrong or missing state is a wrong
//! colour, and a wrong colour is read before the number is.
//!
//! `gh` is optional. Not installed, not authenticated, no network: every one of
//! those answers `{ error }` and the chip simply draws neutral. Nothing here is
//! on a path that has to succeed.

use serde_json::{json, Value};
use std::time::Duration;
use tokio::process::Command;

use crate::util;

/// Ask about one PR by URL.
///
/// By URL rather than by number-and-cwd, deliberately. The URL is what the
/// transcript actually yielded, it carries its own `owner/repo`, and `gh pr
/// view <url>` resolves from any working directory — which is what makes this
/// work for a chat that opened PRs in three different repos, and for one whose
/// worktree has since been pruned.
///
/// PATH is replaced rather than inherited: a GUI app launched from Finder gets
/// launchd's PATH, which has no `/opt/homebrew/bin`, so `gh` would simply not
/// be found. Same reason every other child of Nyra gets `util::child_path()`.
pub async fn pr_state(url: &str) -> Value {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return json!({ "error": "not a URL" });
    }

    let run = Command::new("gh")
        .args([
            "pr",
            "view",
            url,
            "--json",
            "state,isDraft,title,number",
        ])
        .env("PATH", util::child_path())
        .output();

    let out = match tokio::time::timeout(Duration::from_secs(10), run).await {
        Err(_) => return json!({ "error": "gh timed out" }),
        Ok(Err(e)) => return json!({ "error": e.to_string() }),
        Ok(Ok(out)) => out,
    };

    if !out.status.success() {
        return json!({ "error": String::from_utf8_lossy(&out.stderr).trim() });
    }

    match serde_json::from_slice::<Value>(&out.stdout) {
        Ok(v) => v,
        Err(e) => json!({ "error": e.to_string() }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn refuses_anything_that_is_not_a_url() {
        // The argument comes from a regex over tool output, so it is worth one
        // guard: `gh pr view` would otherwise happily take `42` — or a flag.
        for bad in ["42", "--version", "", "file:///etc/passwd"] {
            assert!(pr_state(bad).await.get("error").is_some(), "{bad} was accepted");
        }
    }
}
