//! The small, non-secret account slice shown by Nyra's `/status` card.

use serde::Serialize;
use serde_json::Value;
use std::time::Duration;
use tokio::process::Command;

use crate::util;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub logged_in: bool,
    pub login_method: Option<String>,
    pub organization: Option<String>,
    pub email: Option<String>,
    pub error: Option<String>,
}

impl AccountStatus {
    fn unavailable(error: impl Into<String>) -> Self {
        Self {
            logged_in: false,
            login_method: None,
            organization: None,
            email: None,
            error: Some(error.into()),
        }
    }
}

/// Ask the configured Claude binary for its current login method. Its JSON does
/// not include account identity, so read only those two display fields from
/// Claude's own account cache when the binary confirms a live login.
pub async fn read(binary_path: &str) -> AccountStatus {
    let output = tokio::time::timeout(
        Duration::from_secs(8),
        Command::new(binary_path)
            .args(["auth", "status", "--json"])
            .env_clear()
            .envs(util::clean_child_env())
            .output(),
    )
    .await;

    let output = match output {
        Ok(Ok(output)) => output,
        Ok(Err(error)) => return AccountStatus::unavailable(error.to_string()),
        Err(_) => return AccountStatus::unavailable("Claude auth status timed out"),
    };
    if !output.status.success() {
        return AccountStatus::unavailable("Claude auth status is unavailable");
    }
    let Ok(auth) = serde_json::from_slice::<Value>(&output.stdout) else {
        return AccountStatus::unavailable("Claude auth status was not valid JSON");
    };

    let logged_in = auth.get("loggedIn").and_then(Value::as_bool).unwrap_or(false);
    let login_method = auth
        .get("authMethod")
        .and_then(Value::as_str)
        .filter(|method| *method != "none")
        .map(str::to_string);

    let account = if logged_in {
        tokio::fs::read(util::home_dir().join(".claude.json"))
            .await
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    } else {
        None
    };
    let account = account.as_ref().and_then(|value| value.get("oauthAccount"));

    AccountStatus {
        logged_in,
        login_method,
        organization: account
            .and_then(|value| value.get("organizationName"))
            .and_then(Value::as_str)
            .map(str::to_string),
        email: account
            .and_then(|value| value.get("emailAddress"))
            .and_then(Value::as_str)
            .map(str::to_string),
        error: None,
    }
}
