//! Claude's skills and commands, in a Codex chat.
//!
//! Both CLIs read the same `SKILL.md` — a name, a description, instructions —
//! so one skill folder can serve both. A Codex home's server is pointed at the
//! Claude skills beside it (Nyra's managed ones among them), which Codex then
//! lists and loads like its own. A project's `.claude/skills` is per project,
//! while extra roots are per server and so reach every project's chats; those
//! are named in each thread's instructions instead.
//!
//! What you type is the other half. `/name` in a Codex chat is a skill to use or
//! a Claude command to run, and [`expand`] writes it out as the message Codex
//! reads — Codex has no slash commands of its own to hand it to.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::rpc::Server;
use super::{home_for, server_for};
use crate::environment::Environment;
use crate::util;

/// Names the backend answers itself, which no skill or command may take over.
const RESERVED: &[&str] = &["compact"];

/// The Claude skills beside a Codex home: Default's `~/.claude/skills`, a
/// workspace's `.claude/skills` next to its `.codex`.
fn claude_skills_beside(home: Option<&Path>) -> PathBuf {
    match home {
        Some(home) => home.with_file_name(".claude").join("skills"),
        None => util::claude_dir(&Environment::Host, None).join("skills"),
    }
}

/// Point a new server at the Claude skills beside its home.
pub(super) async fn share_claude_skills(server: &Server, home: Option<&Path>) {
    let dir = claude_skills_beside(home);
    if !dir.is_dir() {
        return;
    }
    if let Err(e) = server.request("skills/extraRoots/set", json!({ "extraRoots": [dir] })).await {
        crate::logf!("codex: could not share Claude's skills from {}: {e}", dir.display());
    }
}

/// The project's own Claude skills, for its threads' instructions: what each
/// is for and where it is, which is how Codex presents its own skills too.
pub(super) async fn project_note(cwd: &str) -> String {
    let skills = crate::skills::list_skills(cwd, None).await.project;
    if skills.is_empty() {
        return String::new();
    }
    let rows: Vec<String> =
        skills.iter().map(|s| format!("- {}: {} ({})", s.name, s.description, s.file_path)).collect();
    format!(
        "\n\n## Project skills\n\nThis project keeps skills in `.claude/skills`, each a SKILL.md of instructions for one kind of task. When a task fits a description below, read that file before starting and follow it.\n\n{}",
        rows.join("\n")
    )
}

/// One skill a Codex chat can name.
struct Skill {
    name: String,
    description: String,
    path: String,
    /// `project` for the project's Claude skills; otherwise what Codex calls it:
    /// `user` (its own home and the shared Claude ones), `system`, `repo`.
    scope: String,
}

async fn skills(config_dir: Option<&str>, cwd: &str) -> Vec<Skill> {
    // The project's first, so one wins a name it shares with a global one, as
    // it would in Claude.
    let mut out: Vec<Skill> = crate::skills::list_skills(cwd, None)
        .await
        .project
        .into_iter()
        .map(|s| Skill { name: s.name, description: s.description, path: s.file_path, scope: "project".into() })
        .collect();
    let Ok(server) = server_for(home_for(config_dir)).await else { return out };
    let Ok(reply) = server.request("skills/list", json!({ "cwds": [cwd] })).await else { return out };
    let listed = reply.pointer("/data/0/skills").and_then(Value::as_array).cloned().unwrap_or_default();
    for s in listed {
        let text = |key: &str| s.get(key).and_then(Value::as_str).unwrap_or_default().to_string();
        let name = text("name");
        if name.is_empty() || s.get("enabled").and_then(Value::as_bool) == Some(false) || out.iter().any(|o| o.name == name) {
            continue;
        }
        out.push(Skill { name, description: text("description"), path: text("path"), scope: text("scope") });
    }
    out
}

/// The skills a Codex chat can name, for the composer and the Skills page.
pub async fn list(config_dir: Option<String>, cwd: &str) -> Value {
    let skills = skills(config_dir.as_deref(), cwd).await;
    let shared = claude_skills_beside(home_for(config_dir.as_deref()).as_deref());
    Value::Array(
        skills
            .into_iter()
            .map(|s| {
                // The ones Codex reads from Claude's folder, which the Skills
                // page already shows as Claude's.
                let from_claude = s.scope == "project" || Path::new(&s.path).starts_with(&shared);
                json!({ "name": s.name, "description": s.description, "filePath": s.path, "scope": s.scope, "fromClaude": from_claude })
            })
            .collect(),
    )
}

/// `/name and the rest` → (`name`, `and the rest`). None for anything else.
fn split_command(text: &str) -> Option<(&str, &str)> {
    let rest = text.trim_start().strip_prefix('/')?;
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    let name = &rest[..end];
    let ok = !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'));
    ok.then(|| (name, rest[end..].trim()))
}

/// What a Codex chat sends for `/name …`: the skill or Claude command it names,
/// written out. Anything else goes as it was typed.
pub async fn expand(config_dir: Option<String>, cwd: &str, text: &str) -> String {
    let Some((name, args)) = split_command(text) else { return text.to_string() };
    if RESERVED.contains(&name) {
        return text.to_string();
    }
    if let Some(skill) = skills(config_dir.as_deref(), cwd).await.into_iter().find(|s| s.name == name) {
        if let Ok(content) = tokio::fs::read_to_string(&skill.path).await {
            return skill_message(&skill.name, &skill.path, &content, args);
        }
    }
    let commands = crate::skills::list_commands(cwd, config_dir.as_deref().map(Path::new)).await;
    let command = commands.project.into_iter().chain(commands.global).find(|c| c.name == name);
    if let Some(command) = command {
        if let Ok(content) = tokio::fs::read_to_string(&command.file_path).await {
            return command_message(&content, args);
        }
    }
    text.to_string()
}

/// A skill, loaded the way Claude loads one when it is named: its instructions
/// in the message, so Codex does not have to go and read them first.
fn skill_message(name: &str, path: &str, content: &str, args: &str) -> String {
    let body = crate::skills::body_of(content);
    let dir = Path::new(path).parent().map(|d| d.display().to_string()).unwrap_or_default();
    let mut out = format!(
        "Use the `{name}` skill for this. Its instructions are below, already loaded, so there is no need to open its file; any files they mention are relative to {dir}.\n\n<skill name=\"{name}\">\n{}\n</skill>",
        body.trim()
    );
    if !args.is_empty() {
        out.push_str("\n\n");
        out.push_str(args);
    }
    out
}

/// A Claude command, as Claude runs one: its text, with what followed its name
/// put where it asks — `$ARGUMENTS` for all of it, `$1`… for each word — or
/// added at the end when it asks for none.
fn command_message(content: &str, args: &str) -> String {
    let body = crate::skills::body_of(content).trim().to_string();
    let words: Vec<&str> = args.split_whitespace().collect();
    let mut out = body.replace("$ARGUMENTS", args);
    for i in (1..=9).rev() {
        out = out.replace(&format!("${i}"), words.get(i - 1).copied().unwrap_or(""));
    }
    if out == body && !args.is_empty() {
        out.push_str("\n\nARGUMENTS: ");
        out.push_str(args);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slash_name_is_split_from_what_follows_it() {
        assert_eq!(split_command("/review the parser"), Some(("review", "the parser")));
        assert_eq!(split_command("/git:sync"), Some(("git:sync", "")));
        assert_eq!(split_command("not a command"), None);
        assert_eq!(split_command("/ alone"), None);
        assert_eq!(split_command("/path/to/file"), None);
    }

    #[test]
    fn a_command_gets_its_arguments_where_it_asks() {
        let content = "---\ndescription: Fix an issue\n---\nFix issue $1 in $2. All of it: $ARGUMENTS\n";
        assert_eq!(command_message(content, "42 parser"), "Fix issue 42 in parser. All of it: 42 parser");
        // Asking for none, it still gets them.
        assert_eq!(command_message("Tidy the imports.", "src/lib"), "Tidy the imports.\n\nARGUMENTS: src/lib");
        assert_eq!(command_message("Tidy the imports.", ""), "Tidy the imports.");
    }

    #[test]
    fn a_skill_arrives_with_its_instructions_and_where_its_files_are() {
        let content = "---\nname: deploy\ndescription: Ship it\n---\nRun scripts/ship.sh.\n";
        let message = skill_message("deploy", "/repo/.claude/skills/deploy/SKILL.md", content, "to staging");
        assert!(message.contains("<skill name=\"deploy\">\nRun scripts/ship.sh.\n</skill>"), "{message}");
        assert!(message.contains("relative to /repo/.claude/skills/deploy"));
        assert!(message.ends_with("to staging"));
        assert!(!message.contains("description: Ship it"));
    }
}
