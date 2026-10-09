//! Discovery for `.claude/skills`, `.claude/agents` and `.claude/commands`,
//! global and per-project.

use serde::Serialize;
use std::path::Path;

use crate::environment::Environment;
use crate::util;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
    pub scope: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentInfo {
    pub name: String,
    pub description: String,
    pub scope: String,
}

/// A custom slash command — one `.md` file under `.claude/commands`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandInfo {
    /// What you type, without the slash. Nested directories namespace it the
    /// way the CLI reads them: `.claude/commands/git/sync.md` is `git:sync`.
    pub name: String,
    pub description: String,
    pub scope: String,
    pub file_path: String,
}

#[derive(Debug, Serialize)]
pub struct ScopedList<T> {
    pub global: Vec<T>,
    pub project: Vec<T>,
}

fn parse_skill_frontmatter(content: &str) -> (String, String) {
    let Some(rest) = content.strip_prefix("---\n") else {
        return (String::new(), content.to_string());
    };
    let Some(end) = rest.find("\n---\n") else {
        return (String::new(), content.to_string());
    };
    let yaml = &rest[..end];
    let body = &rest[end + 5..];
    (yaml_description(yaml), body.to_string())
}

/// `description:` out of a frontmatter block, in the three ways skills write it:
/// inline, quoted, or as a `>`/`|` block on the lines below. The block form is
/// common in skills from `npx skills`, and reading only the inline value showed
/// their description as a bare `>-`.
fn yaml_description(yaml: &str) -> String {
    let mut lines = yaml.lines();
    let Some(value) = lines.by_ref().find_map(|l| l.strip_prefix("description:")) else {
        return String::new();
    };
    let value = value.trim();
    let folded = value.starts_with('>');
    if folded || value.starts_with('|') {
        let block: Vec<&str> = lines
            .take_while(|l| l.trim().is_empty() || l.starts_with(' ') || l.starts_with('\t'))
            .map(str::trim)
            .collect();
        let joined = block.join(if folded { " " } else { "\n" });
        return joined.split_whitespace().collect::<Vec<_>>().join(" ").trim().to_string();
    }
    let unquoted = value
        .strip_prefix('"')
        .and_then(|v| v.strip_suffix('"'))
        .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')));
    unquoted.unwrap_or(value).to_string()
}

/// Whether `path` is a directory (or a file), *through* a symlink.
///
/// `DirEntry::file_type` reports the link itself, and `npx skills add` for more
/// than one agent keeps the real copy in `.agents/skills` and links it into
/// `.claude/skills` — so asking the entry dropped every skill installed that way.
async fn follows_to(path: &Path, dir: bool) -> bool {
    tokio::fs::metadata(path)
        .await
        .map(|m| if dir { m.is_dir() } else { m.is_file() })
        .unwrap_or(false)
}

async fn scan_agents_dir(dir: &Path, scope: &str) -> Vec<AgentInfo> {
    let mut agents = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return agents;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !file_name.ends_with(".md") {
            continue;
        }
        if !follows_to(&entry.path(), false).await {
            continue;
        }
        let name = file_name.trim_end_matches(".md").to_string();
        let description = match tokio::fs::read_to_string(entry.path()).await {
            Ok(content) => parse_skill_frontmatter(&content).0,
            Err(_) => String::new(),
        };
        agents.push(AgentInfo {
            name,
            description,
            scope: scope.to_string(),
        });
    }
    agents
}

async fn scan_skills_dir(dir: &Path, scope: &str) -> Vec<SkillInfo> {
    let mut skills = Vec::new();
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return skills;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        if !follows_to(&entry.path(), true).await {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let file_path = entry.path().join("SKILL.md");
        // A directory without SKILL.md just isn't a skill.
        let Ok(content) = tokio::fs::read_to_string(&file_path).await else {
            continue;
        };
        let (fm_description, body) = parse_skill_frontmatter(&content);
        let description = if fm_description.is_empty() {
            body.lines()
                .find(|l| !l.trim().is_empty())
                .unwrap_or_default()
                .trim_start_matches('#')
                .trim()
                .to_string()
        } else {
            fm_description
        };
        skills.push(SkillInfo {
            name,
            description,
            scope: scope.to_string(),
            file_path: file_path.to_string_lossy().to_string(),
        });
    }
    skills
}

/// Walk `.claude/commands`, including subdirectories, which the CLI treats as
/// namespaces rather than as ordinary folders.
fn scan_commands_dir<'a>(
    dir: std::path::PathBuf,
    scope: &'a str,
    prefix: String,
    out: &'a mut Vec<CommandInfo>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
    Box::pin(async move {
        let Ok(mut entries) = tokio::fs::read_dir(&dir).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let file_name = entry.file_name().to_string_lossy().to_string();
            let Ok(file_type) = entry.file_type().await else {
                continue;
            };
            if file_type.is_dir() {
                let nested = format!("{prefix}{file_name}:");
                scan_commands_dir(entry.path(), scope, nested, out).await;
                continue;
            }
            if !file_name.ends_with(".md") {
                continue;
            }
            let stem = file_name.trim_end_matches(".md");
            let content = tokio::fs::read_to_string(entry.path()).await.unwrap_or_default();
            let (fm_description, body) = parse_skill_frontmatter(&content);
            let description = if fm_description.is_empty() {
                // No frontmatter is normal for a command — the file *is* the
                // prompt. Its first real line is the best one-liner available.
                body.lines()
                    .find(|l| !l.trim().is_empty())
                    .unwrap_or_default()
                    .trim_start_matches('#')
                    .trim()
                    .chars()
                    .take(140)
                    .collect()
            } else {
                fm_description
            };
            out.push(CommandInfo {
                name: format!("{prefix}{stem}"),
                description,
                scope: scope.to_string(),
                file_path: entry.path().to_string_lossy().to_string(),
            });
        }
    })
}

pub async fn list_commands(cwd: &str, config_dir: Option<&Path>) -> ScopedList<CommandInfo> {
    let mut global = Vec::new();
    let mut project = Vec::new();
    scan_commands_dir(
        util::claude_dir(&Environment::of(cwd), config_dir).join("commands"),
        "global",
        String::new(),
        &mut global,
    )
    .await;
    scan_commands_dir(
        Path::new(cwd).join(".claude").join("commands"),
        "project",
        String::new(),
        &mut project,
    )
    .await;
    global.sort_by(|a, b| a.name.cmp(&b.name));
    project.sort_by(|a, b| a.name.cmp(&b.name));
    ScopedList { global, project }
}

pub async fn list_skills(cwd: &str, config_dir: Option<&Path>) -> ScopedList<SkillInfo> {
    // The global dirs are the workspace's, in the environment's config dir: a WSL
    // project lists the distro's whatever its workspace.
    let global_dir = util::claude_dir(&Environment::of(cwd), config_dir).join("skills");
    let project_dir = Path::new(cwd).join(".claude").join("skills");
    let (global, project) = tokio::join!(
        scan_skills_dir(&global_dir, "global"),
        scan_skills_dir(&project_dir, "project")
    );
    ScopedList { global, project }
}

pub async fn list_agents(cwd: &str, config_dir: Option<&Path>) -> ScopedList<AgentInfo> {
    let global_dir = util::claude_dir(&Environment::of(cwd), config_dir).join("agents");
    let project_dir = Path::new(cwd).join(".claude").join("agents");
    let (global, project) = tokio::join!(
        scan_agents_dir(&global_dir, "global"),
        scan_agents_dir(&project_dir, "project")
    );
    ScopedList { global, project }
}

pub async fn write_skill(
    scope: &str,
    name: &str,
    content: &str,
    cwd: &str,
    config_dir: Option<&Path>,
) -> Result<(), String> {
    // The name becomes a directory, so it must not traverse or contain separators.
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.chars().any(char::is_whitespace)
    {
        return Err("Invalid skill name. Use only letters, numbers, hyphens, and underscores.".into());
    }
    let base_dir = if scope == "global" {
        util::claude_dir(&Environment::of(cwd), config_dir).join("skills").join(name)
    } else {
        Path::new(cwd).join(".claude").join("skills").join(name)
    };
    tokio::fs::create_dir_all(&base_dir)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::write(base_dir.join("SKILL.md"), content)
        .await
        .map_err(|e| e.to_string())
}

pub async fn delete_skill(file_path: &str) -> Result<(), String> {
    // `file_path` points at SKILL.md; the skill is the directory holding it.
    let dir = Path::new(file_path)
        .parent()
        .ok_or_else(|| "Invalid skill path".to_string())?;
    tokio::fs::remove_dir_all(dir)
        .await
        .map_err(|e| e.to_string())
}

/// Delete one custom slash command.
///
/// A command is a single `.md` file, where a skill is a whole directory — so
/// this removes a file and `delete_skill` removes a tree.
///
/// The path has to sit under a `.claude/commands` directory and end in `.md`.
/// This is reachable from a dialog with one click, and `remove_file` on whatever
/// string it was handed is a worse bug than a refusal.
pub async fn delete_command(file_path: &str) -> Result<(), String> {
    let path = Path::new(file_path);
    let under_commands = path.ancestors().any(|a| a.ends_with(".claude/commands"));
    if !under_commands || path.extension().and_then(|e| e.to_str()) != Some("md") {
        return Err("Not a custom command path".to_string());
    }
    tokio::fs::remove_file(path).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_description_from_frontmatter() {
        let (d, body) = parse_skill_frontmatter("---\nname: x\ndescription: Does a thing\n---\nBody here\n");
        assert_eq!(d, "Does a thing");
        assert_eq!(body, "Body here\n");
    }

    #[test]
    fn reads_a_block_or_quoted_description() {
        let folded = "---\nname: x\ndescription: >-\n  Design engineering principles\n  for polish.\nlicense: MIT\n---\nBody\n";
        assert_eq!(parse_skill_frontmatter(folded).0, "Design engineering principles for polish.");
        let literal = "---\ndescription: |\n  One line.\n---\n";
        assert_eq!(parse_skill_frontmatter(literal).0, "One line.");
        let quoted = "---\ndescription: \"Quoted: with a colon\"\n---\n";
        assert_eq!(parse_skill_frontmatter(quoted).0, "Quoted: with a colon");
    }

    #[test]
    fn returns_whole_content_when_frontmatter_is_absent() {
        let (d, body) = parse_skill_frontmatter("# Title\n");
        assert_eq!(d, "");
        assert_eq!(body, "# Title\n");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn lists_a_skill_that_is_a_symlink() {
        let dir = std::env::temp_dir().join(format!("nyra-skill-link-{}", std::process::id()));
        let real = dir.join(".agents/skills/linked");
        let skills = dir.join(".claude/skills");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::create_dir_all(&skills).unwrap();
        std::fs::write(real.join("SKILL.md"), "---\ndescription: Through a link\n---\n").unwrap();
        std::os::unix::fs::symlink("../../.agents/skills/linked", skills.join("linked")).unwrap();

        let found = scan_skills_dir(&skills, "project").await;

        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "linked");
        assert_eq!(found[0].description, "Through a link");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn refuses_to_delete_outside_a_commands_directory() {
        for path in [
            "/Users/someone/Documents/taxes.md",
            "/Users/someone/.claude/skills/thing/SKILL.md",
            "/Users/someone/.claude/commands/sync.sh",
        ] {
            assert!(delete_command(path).await.is_err(), "{path} should be refused");
        }
    }

    #[tokio::test]
    async fn deletes_a_command_file() {
        let dir = std::env::temp_dir().join(format!("nyra-cmd-{}", std::process::id()));
        let commands = dir.join(".claude/commands/git");
        std::fs::create_dir_all(&commands).unwrap();
        let file = commands.join("sync.md");
        std::fs::write(&file, "body").unwrap();

        delete_command(file.to_str().unwrap()).await.unwrap();

        assert!(!file.exists());
        std::fs::remove_dir_all(&dir).ok();
    }
}
