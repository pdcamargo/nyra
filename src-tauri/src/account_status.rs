//! The small, non-secret account slice shown by Nyra's `/status` card and the
//! usage row, per workspace.

use serde::Serialize;
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

use crate::environment::Environment;
use crate::util;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub logged_in: bool,
    pub login_method: Option<String>,
    pub organization: Option<String>,
    pub email: Option<String>,
    /// `oauthAccount.displayName`, else `fullName`, from the workspace's own
    /// `.claude.json` — `auth status` has no name. The renderer falls back to
    /// the email when neither is there.
    pub display_name: Option<String>,
    pub subscription_type: Option<String>,
    /// Where the CLI says this login lives: the workspace's dir, or `~/.claude`.
    pub config_directory: Option<String>,
    pub error: Option<String>,
}

impl AccountStatus {
    fn unavailable(error: impl Into<String>) -> Self {
        Self {
            logged_in: false,
            login_method: None,
            organization: None,
            email: None,
            display_name: None,
            subscription_type: None,
            config_directory: None,
            error: Some(error.into()),
        }
    }
}

fn text(value: Option<&Value>, key: &str) -> Option<String> {
    value
        .and_then(|v| v.get(key))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(str::to_string)
}

/// Ask the configured Claude binary who a workspace is signed in as.
///
/// `auth status --json` reports the login, the email, the organisation and the
/// plan, and it honours `CLAUDE_CONFIG_DIR`, so the answer is that workspace's.
/// A credential in the environment (`ANTHROPIC_API_KEY` and friends) outranks
/// every login, and this reports whatever the CLI says about it rather than
/// guessing. The display name is not in that JSON; it comes from the account
/// block the CLI keeps in the same workspace's `.claude.json`.
pub async fn read(binary_path: &str, config_dir: Option<&Path>) -> AccountStatus {
    let binary = crate::claude::resolve_claude_binary(binary_path);
    let output = tokio::time::timeout(
        Duration::from_secs(8),
        crate::platform::command(&binary)
            .args(["auth", "status", "--json"])
            .env_clear()
            .envs(util::claude_child_env(config_dir))
            .output(),
    )
    .await;

    let output = match output {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return AccountStatus::unavailable(error.to_string()),
        Err(_) => return AccountStatus::unavailable("Claude auth status timed out"),
    };
    let Ok(auth) = serde_json::from_slice::<Value>(&output.stdout) else {
        // Signed out answers with a non-zero exit and, depending on the build,
        // either JSON or nothing; only a missing answer is an error.
        return if output.status.success() {
            AccountStatus::unavailable("Claude auth status was not valid JSON")
        } else {
            AccountStatus { error: None, ..AccountStatus::unavailable("") }
        };
    };

    let logged_in = auth.get("loggedIn").and_then(Value::as_bool).unwrap_or(false);
    let login_method = text(Some(&auth), "authMethod").filter(|method| method != "none");

    let account = if logged_in {
        tokio::fs::read(util::claude_json(&Environment::Host, config_dir))
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    } else {
        None
    };
    let oauth = account.as_ref().and_then(|value| value.get("oauthAccount"));

    AccountStatus {
        logged_in,
        login_method,
        // Older builds printed neither; the account block has both.
        organization: text(Some(&auth), "orgName").or_else(|| text(oauth, "organizationName")),
        email: text(Some(&auth), "email").or_else(|| text(oauth, "emailAddress")),
        display_name: text(oauth, "displayName").or_else(|| text(oauth, "fullName")),
        subscription_type: text(Some(&auth), "subscriptionType"),
        config_directory: text(Some(&auth), "configDirectory"),
        error: None,
    }
}

/// `claude auth logout` for one workspace.
///
/// Deleting the directory is not enough on its own: on macOS the login lives in
/// the Keychain, keyed to the directory, and only the CLI removes it.
pub async fn logout(binary_path: &str, config_dir: Option<&Path>) -> Result<(), String> {
    let binary = crate::claude::resolve_claude_binary(binary_path);
    let output = tokio::time::timeout(
        Duration::from_secs(20),
        crate::platform::command(&binary)
            .args(["auth", "logout"])
            .env_clear()
            .envs(util::claude_child_env(config_dir))
            .stdin(std::process::Stdio::null())
            .output(),
    )
    .await
    .map_err(|_| "`claude auth logout` did not finish in 20s.".to_string())?
    .map_err(|e| format!("Could not run `{binary}`: {e}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    Err(stderr
        .lines()
        .chain(stdout.lines())
        .rfind(|line| !line.trim().is_empty())
        .unwrap_or("`claude auth logout` failed.")
        .to_string())
}
