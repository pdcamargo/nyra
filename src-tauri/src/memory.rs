//! Claude memory files: the per-project memory directory plus the CLAUDE.md
//! anchors (global, project, and one per subagent).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::environment::Environment;
use crate::util;

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MemorySource {
    ProjectMemory,
    GlobalClaude,
    ProjectClaude,
    SubagentClaude,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFile {
    pub file_path: String,
    pub source: MemorySource,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory_type: Option<String>,
    pub exists: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_index: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListResult {
    pub project_memory_dir: String,
    pub files: Vec<MemoryFile>,
}

pub fn project_memory_dir(cwd: &str, config_dir: Option<&Path>) -> PathBuf {
    util::claude_project_dir(cwd, config_dir).join("memory")
}

/// Pull `description:` and `type:` out of a memory file's YAML frontmatter.
///
/// Lines are trimmed before the key is read, because the memory format nests
/// `type:` under `metadata:` — matching at the margin found the description and
/// nothing else, which is why the memory tab showed no type badges. The key is
/// compared whole so `node_type:`, which sits directly above it, is not taken
/// for it. Quotes come off the description: they are YAML's, not the author's.
pub fn parse_frontmatter(content: &str) -> (String, Option<String>) {
    let Some(rest) = content.strip_prefix("---\n") else {
        return (String::new(), None);
    };
    let Some(end) = rest.find("\n---") else {
        return (String::new(), None);
    };
    let yaml = &rest[..end];

    let mut description = String::new();
    let mut memory_type = None;
    for line in yaml.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "description" => description = unquote(value).to_string(),
            "type" => {
                let raw = value.to_lowercase();
                if matches!(raw.as_str(), "user" | "feedback" | "project" | "reference") {
                    memory_type = Some(raw);
                }
            }
            _ => {}
        }
    }
    (description, memory_type)
}

fn unquote(value: &str) -> &str {
    for q in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(q) && value.ends_with(q) {
            return &value[1..value.len() - 1];
        }
    }
    value
}

async fn build_memory_file(
    path: &Path,
    source: MemorySource,
    name: &str,
    is_index: Option<bool>,
    read_frontmatter: bool,
) -> MemoryFile {
    let meta = tokio::fs::metadata(path).await.ok();
    let exists = meta.is_some();
    let size = meta.as_ref().map(|m| m.len());
    let mtime = meta.as_ref().and_then(|m| m.modified().ok()).and_then(|t| {
        t.duration_since(std::time::UNIX_EPOCH)
            .ok()
            .map(|d| d.as_millis() as f64)
    });

    let mut file = MemoryFile {
        file_path: path.to_string_lossy().to_string(),
        source,
        name: name.to_string(),
        description: None,
        memory_type: None,
        exists,
        size,
        mtime,
        is_index,
    };

    if exists && read_frontmatter {
        if let Ok(content) = tokio::fs::read_to_string(path).await {
            let (description, memory_type) = parse_frontmatter(&content);
            if !description.is_empty() {
                file.description = Some(description);
            }
            if memory_type.is_some() {
                file.memory_type = memory_type;
            }
        }
    }
    file
}

pub async fn list_memory_files(cwd: &str, config_dir: Option<&Path>) -> MemoryListResult {
    let mem_dir = project_memory_dir(cwd, config_dir);
    let mut files = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(&mem_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") {
                continue;
            }
            if !entry.file_type().await.map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let is_index = name == "MEMORY.md";
            files.push(
                build_memory_file(
                    &mem_dir.join(&name),
                    MemorySource::ProjectMemory,
                    &name,
                    Some(is_index),
                    !is_index,
                )
                .await,
            );
        }
    }

    // The global one is the workspace's, in the environment's config dir: a WSL
    // chat reads the distro's whatever its workspace.
    files.push(
        build_memory_file(
            &util::claude_dir(&Environment::of(cwd), config_dir).join("CLAUDE.md"),
            MemorySource::GlobalClaude,
            "Global CLAUDE.md",
            None,
            false,
        )
        .await,
    );
    files.push(
        build_memory_file(
            &Path::new(cwd).join("CLAUDE.md"),
            MemorySource::ProjectClaude,
            "Project CLAUDE.md",
            None,
            false,
        )
        .await,
    );

    let agents_dir = Path::new(cwd).join(".claude").join("agents");
    if let Ok(mut entries) = tokio::fs::read_dir(&agents_dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") {
                continue;
            }
            if !entry.file_type().await.map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let agent_name = name.trim_end_matches(".md").to_string();
            files.push(
                build_memory_file(
                    &agents_dir.join(&name),
                    MemorySource::SubagentClaude,
                    &agent_name,
                    None,
                    false,
                )
                .await,
            );
        }
    }

    MemoryListResult {
        project_memory_dir: mem_dir.to_string_lossy().to_string(),
        files,
    }
}

/// Memory edits are confined to the project memory dir, the workspace's config
/// dir, and the project itself — the renderer supplies the path, so it can't be
/// trusted.
fn is_path_allowed(file_path: &str, cwd: &str, config_dir: Option<&Path>) -> bool {
    let env = Environment::of(cwd);
    let allowed = [
        project_memory_dir(cwd, config_dir),
        util::claude_dir(&env, config_dir),
        PathBuf::from(cwd),
    ];
    // By component, so it holds for either separator, and `..` is refused
    // outright: `<cwd>/../../etc/passwd` starts with `<cwd>` too.
    let path = Path::new(file_path);
    if path.components().any(|c| c == std::path::Component::ParentDir) {
        return false;
    }
    allowed.iter().any(|dir| env.is_within(dir, path))
}

pub async fn read_memory_file(file_path: &str, cwd: &str, config_dir: Option<&Path>) -> Result<String, String> {
    if !is_path_allowed(file_path, cwd, config_dir) {
        return Err("Path not allowed".into());
    }
    tokio::fs::read_to_string(file_path)
        .await
        .map_err(|e| e.to_string())
}

pub async fn write_memory_file(
    file_path: &str,
    content: &str,
    cwd: &str,
    config_dir: Option<&Path>,
) -> Result<(), String> {
    if !is_path_allowed(file_path, cwd, config_dir) {
        return Err("Path not allowed".into());
    }
    if let Some(parent) = Path::new(file_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::write(file_path, content)
        .await
        .map_err(|e| e.to_string())
}

pub async fn delete_memory_file(file_path: &str, cwd: &str, config_dir: Option<&Path>) -> Result<(), String> {
    if !is_path_allowed(file_path, cwd, config_dir) {
        return Err("Path not allowed".into());
    }
    // Anchors are created by Claude Code itself; this API only removes entries.
    let base = Path::new(file_path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if base == "CLAUDE.md" || base == "MEMORY.md" {
        return Err("Cannot delete anchor files via this API".into());
    }
    tokio::fs::remove_file(file_path)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_description_and_type() {
        let (d, t) = parse_frontmatter("---\nname: x\ndescription: Hello there\ntype: feedback\n---\n\nbody");
        assert_eq!(d, "Hello there");
        assert_eq!(t.as_deref(), Some("feedback"));
    }

    #[test]
    fn reads_a_type_nested_under_metadata() {
        let (d, t) = parse_frontmatter(
            "---\nname: x\ndescription: \"Quoted, with a comma\"\nmetadata:\n  node_type: memory\n  type: project\n---\n\nbody",
        );
        assert_eq!(d, "Quoted, with a comma");
        assert_eq!(t.as_deref(), Some("project"));
    }

    #[test]
    fn ignores_unknown_types() {
        let (_, t) = parse_frontmatter("---\ntype: nonsense\n---\n");
        assert!(t.is_none());
    }

    #[test]
    fn handles_missing_frontmatter() {
        let (d, t) = parse_frontmatter("# Just a heading\n");
        assert_eq!(d, "");
        assert!(t.is_none());
    }

    #[test]
    fn confines_writes_to_allowed_roots() {
        let cwd = "/Users/x/proj";
        assert!(is_path_allowed("/Users/x/proj/CLAUDE.md", cwd, None));
        assert!(!is_path_allowed("/etc/passwd", cwd, None));
        assert!(!is_path_allowed("/Users/x/proj/../../../etc/passwd", cwd, None));
        assert!(!is_path_allowed("/Users/x/project-two/a.md", cwd, None));
    }

    #[test]
    fn a_workspace_edits_its_own_config_dir_and_not_the_default_one() {
        let cwd = "/Users/x/proj";
        let ws = Path::new("/Users/x/.nyra/workspaces/w1/.claude");
        assert!(is_path_allowed("/Users/x/.nyra/workspaces/w1/.claude/CLAUDE.md", cwd, Some(ws)));
        assert!(is_path_allowed(
            "/Users/x/.nyra/workspaces/w1/.claude/projects/-Users-x-proj/memory/a.md",
            cwd,
            Some(ws)
        ));
        let default_claude = util::home_dir().join(".claude").join("CLAUDE.md");
        assert!(!is_path_allowed(&default_claude.to_string_lossy(), cwd, Some(ws)));
    }

    // Windows only: these paths are `\\wsl.localhost\…` UNC paths, and on macOS
    // `std::path` does not split on `\`, so `file_name` and `..` both read wrong.
    // A macOS build never has a WSL project to begin with.
    #[cfg(windows)]
    #[test]
    fn a_wsl_chat_may_edit_the_distros_claude_dir_and_not_the_hosts() {
        crate::environment::wsl::set_probe_for_test(
            "MemTest",
            crate::environment::wsl::Probe { home: "/home/me".into(), ..Default::default() },
        );
        let cwd = r"\\wsl.localhost\MemTest\home\me\repo";
        assert!(is_path_allowed(r"\\wsl.localhost\MemTest\home\me\.claude\CLAUDE.md", cwd, None));
        assert!(is_path_allowed(r"\\wsl.localhost\memtest\home\me\repo\CLAUDE.md", cwd, None));
        assert!(is_path_allowed(
            r"\\wsl.localhost\MemTest\home\me\.claude\projects\-home-me-repo\memory\a.md",
            cwd,
            None
        ));
        let host_claude = util::home_dir().join(".claude").join("CLAUDE.md");
        assert!(!is_path_allowed(&host_claude.to_string_lossy(), cwd, None));
        assert!(!is_path_allowed(r"\\wsl.localhost\MemTest\home\me\repo\..\..\x", cwd, None));
    }

    #[test]
    fn encodes_the_project_dir_the_way_claude_does() {
        let dir = project_memory_dir("/Users/x/proj", None);
        assert!(dir.ends_with(Path::new("-Users-x-proj").join("memory")), "{}", dir.display());
    }
}
