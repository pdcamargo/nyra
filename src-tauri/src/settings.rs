//! Settings mirrored from the renderer's zustand store via the `settings_sync`
//! command. The Rust side never persists these — the renderer owns durability;
//! we only keep the live copy the Claude runner and trigger runtime read from.

use serde::{Deserialize, Serialize};

fn default_claude_binary() -> String {
    "claude".to_string()
}

fn default_true() -> bool {
    true
}

fn default_threshold() -> u32 {
    90
}

/// Matches Codex's default of the 15 most recent managed worktrees.
fn default_worktree_limit() -> u32 {
    15
}

fn default_theme() -> String {
    "dark".to_string()
}

fn default_font_size() -> String {
    "medium".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NyraSettings {
    /// "" = CLI default, otherwise a model id like `sonnet` / `opus` / `haiku`.
    pub model: String,
    pub skip_permissions: bool,
    pub notifications: bool,
    pub system_prompt: String,
    pub claude_binary_path: String,
    pub font_size: String,
    /// "" | low | medium | high | max
    pub effort: String,
    pub plan_mode: bool,
    pub auto_compact: bool,
    pub auto_compact_threshold: u32,
    pub onboarding_complete: bool,
    pub theme: String,
    /// When set, passed as `--allowed-tools`. Workflow prompt nodes use this.
    pub allowed_tools: Option<Vec<String>>,
    pub auto_approve_tools: Vec<String>,
    /// How many managed worktrees to keep before pruning the oldest idle one.
    pub worktree_limit: u32,
    /// Off means worktrees are only ever removed by hand.
    pub worktree_auto_delete: bool,
    /// Whether Claude gets the browser tools. On by default, but every chat
    /// carries their definitions whether or not it browses, so it is a switch
    /// rather than a given.
    pub browser_tools: bool,
    /// The floating miniature over the conversation.
    pub browser_pip: bool,
}

impl Default for NyraSettings {
    fn default() -> Self {
        Self {
            model: String::new(),
            skip_permissions: false,
            notifications: default_true(),
            system_prompt: String::new(),
            claude_binary_path: default_claude_binary(),
            font_size: default_font_size(),
            effort: String::new(),
            plan_mode: false,
            auto_compact: default_true(),
            auto_compact_threshold: default_threshold(),
            onboarding_complete: false,
            theme: default_theme(),
            allowed_tools: None,
            auto_approve_tools: Vec::new(),
            worktree_limit: default_worktree_limit(),
            worktree_auto_delete: default_true(),
            browser_tools: default_true(),
            browser_pip: default_true(),
        }
    }
}

/// The slice of settings that actually reaches a spawned Claude process.
///
/// These travel in the `claude_query` payload rather than being read back out of
/// the process-global at call time. With one global, two projects wanting
/// different models meant whichever renderer write landed last decided for both;
/// carrying them per call makes the choice belong to the session doing the asking.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SpawnSettings {
    /// "" = CLI default, otherwise a model id like `sonnet` / `opus` / `haiku`.
    pub model: String,
    /// "" | low | medium | high | max
    pub effort: String,
    pub system_prompt: String,
    pub plan_mode: bool,
    /// When set, passed as `--allowed-tools`. Workflow prompt nodes use this.
    pub allowed_tools: Option<Vec<String>>,
    pub claude_binary_path: String,
    pub skip_permissions: bool,
    pub auto_approve_tools: Vec<String>,
}

impl Default for SpawnSettings {
    fn default() -> Self {
        Self {
            model: String::new(),
            effort: String::new(),
            system_prompt: String::new(),
            plan_mode: false,
            allowed_tools: None,
            claude_binary_path: default_claude_binary(),
            skip_permissions: false,
            auto_approve_tools: Vec::new(),
        }
    }
}

impl NyraSettings {
    /// Project the global settings down to what a spawn needs. The fallback for
    /// callers that have no per-session settings of their own — workflow nodes,
    /// cron and webhook triggers.
    pub fn spawn(&self) -> SpawnSettings {
        SpawnSettings {
            model: self.model.clone(),
            effort: self.effort.clone(),
            system_prompt: self.system_prompt.clone(),
            plan_mode: self.plan_mode,
            allowed_tools: self.allowed_tools.clone(),
            claude_binary_path: self.claude_binary_path.clone(),
            skip_permissions: self.skip_permissions,
            auto_approve_tools: self.auto_approve_tools.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_projection_carries_every_spawn_relevant_field() {
        let full = NyraSettings {
            model: "opus".into(),
            effort: "high".into(),
            system_prompt: "be brief".into(),
            plan_mode: true,
            allowed_tools: Some(vec!["Read".into()]),
            claude_binary_path: "/opt/claude".into(),
            skip_permissions: true,
            auto_approve_tools: vec!["Bash".into()],
            ..NyraSettings::default()
        };
        let spawn = full.spawn();
        assert_eq!(spawn.model, "opus");
        assert_eq!(spawn.effort, "high");
        assert_eq!(spawn.system_prompt, "be brief");
        assert!(spawn.plan_mode);
        assert_eq!(spawn.allowed_tools, Some(vec!["Read".into()]));
        assert_eq!(spawn.claude_binary_path, "/opt/claude");
        assert!(spawn.skip_permissions);
        assert_eq!(spawn.auto_approve_tools, vec!["Bash".to_string()]);
    }

    #[test]
    fn spawn_settings_default_to_a_usable_binary() {
        // `#[serde(default)]` fills missing fields from here, so an empty payload
        // must not leave the runner with no binary to exec.
        assert_eq!(SpawnSettings::default().claude_binary_path, "claude");
    }
}
