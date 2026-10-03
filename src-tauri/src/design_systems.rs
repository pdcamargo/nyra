//! Design systems: a folder of design files that share one theme and one set of
//! components.
//!
//! ```text
//! <root>/                       ~/.nyra/designs/systems/<slug>-<id>/  or  <repo>/design/
//!   nyra.design.json            manifest: format version, id, name, description
//!   tokens.json                 the theme, plus modes
//!   components/*.nyui.json      component families and their specimens
//!   patterns/*.nyui.json        compositions
//!   screens/*.nyui.json         product screens built from the system
//!   guidelines/*.md             principles, voice, the brief
//! ```
//!
//! Systems are registered in their own `systems.json`, never in `index.json`:
//! dev and the installed app share `~/.nyra`, and an older build rewriting
//! `index.json` would drop fields it does not know — a system's `root` among
//! them. A file of its own is one an older build never touches.
//!
//! The registry is how a system is *found*; its files are found by listing its
//! own three folders, never by scanning the disk. A list of files in the
//! manifest would drift the first time someone deleted one outside the app.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::util;

/// The registry file's own version.
pub const SCHEMA: u32 = 1;
/// The design format new files are written in. Kept equal to the package's
/// `FORMAT_VERSION`; a test on the TypeScript side reads this line.
pub const FORMAT: u32 = 2;

pub const MANIFEST: &str = "nyra.design.json";
pub const TOKENS: &str = "tokens.json";
pub const MEMBER_DIRS: [&str; 3] = ["components", "patterns", "screens"];
pub const GUIDELINES: &str = "guidelines";

/// The built-in theme as a `tokens.json`, generated from the package so the
/// two cannot disagree (`scripts/generate-default-tokens.mts`, tested).
const DEFAULT_TOKENS: &str = include_str!("../../packages/design/default-tokens.json");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemEntry {
    pub id: String,
    pub name: String,
    /// Absolute path of the folder holding `nyra.design.json`.
    pub root: PathBuf,
    /// The project the system belongs to.
    pub project: PathBuf,
    pub updated_at: String,
    /// Where it used to live. A chip in an old chat, or Claude writing from
    /// memory, still names these — and a write there is reported as "moved"
    /// rather than quietly starting a second system.
    #[serde(default)]
    pub previous_roots: Vec<PathBuf>,
    /// Keep `.claude/skills/<slug>-design-system/SKILL.md` in the repo current.
    #[serde(default)]
    pub project_skill: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct Registry {
    #[serde(default = "default_schema")]
    schema: u32,
    #[serde(default)]
    systems: Vec<SystemEntry>,
}

fn default_schema() -> u32 {
    SCHEMA
}

fn designs_root() -> PathBuf {
    util::home_dir().join(".nyra").join("designs")
}

fn registry_path(root: &Path) -> PathBuf {
    root.join("systems.json")
}

/// The registry, or an error when the file exists but cannot be read.
///
/// Unlike the design index, an unreadable registry is NOT treated as empty:
/// the next save would replace every system's location with nothing. Reads
/// fall back to empty; writes refuse.
fn load_in(root: &Path) -> Result<Registry, String> {
    match fs::read_to_string(registry_path(root)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Registry { schema: SCHEMA, systems: Vec::new() }),
        Err(e) => Err(format!("could not read {}: {e}", registry_path(root).display())),
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("{} is not valid ({e}); fix or remove it", registry_path(root).display())),
    }
}

fn save_in(root: &Path, reg: &Registry) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    let body = serde_json::to_string_pretty(reg).map_err(|e| e.to_string())?;
    let tmp = root.join(format!("systems.json.{}", util::rand_hex(6)));
    fs::write(&tmp, body).map_err(|e| format!("could not write the systems registry: {e}"))?;
    fs::rename(&tmp, registry_path(root)).map_err(|e| format!("could not replace the systems registry: {e}"))
}

fn announce() {
    util::emit("nyra:designs-changed", serde_json::json!({}));
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect();
    let joined = s.split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-");
    if joined.is_empty() { "system".into() } else { joined.chars().take(40).collect() }
}

/// A path as the disk spells it, so a prefix test works through symlinks and
/// on case-insensitive volumes. A file that does not exist yet — Claude about
/// to write it — is resolved through its folder.
fn canonical(path: &Path) -> PathBuf {
    if let Some(c) = crate::platform::canonical_dir(path) {
        return c;
    }
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => canonical(parent).join(name),
        _ => path.to_path_buf(),
    }
}

fn within(root: &Path, path: &Path) -> bool {
    canonical(path).starts_with(canonical(root))
}

pub enum Location {
    /// `~/.nyra/designs/systems/<slug>-<id>/` — nothing lands in the repo.
    Nyra,
    /// A folder inside the project, `design/` unless said otherwise.
    Repo(PathBuf),
}

pub fn list(project: Option<&Path>) -> Vec<SystemEntry> {
    list_from(load_in(&designs_root()).map(|r| r.systems).unwrap_or_default(), project)
}

fn list_from(systems: Vec<SystemEntry>, project: Option<&Path>) -> Vec<SystemEntry> {
    let belongs = |s: &SystemEntry, p: &Path| s.project == p || within(p, &s.root);
    let mut all: Vec<SystemEntry> = match project {
        None => systems,
        Some(p) => match crate::git::linked_worktree(p) {
            // A worktree chat sees its project's systems, through the worktree.
            Some((wt, main)) => systems
                .into_iter()
                .filter_map(|s| {
                    if belongs(&s, &main) {
                        Some(seen_from(s, &wt, &main))
                    } else {
                        belongs(&s, p).then_some(s)
                    }
                })
                .collect(),
            None => systems.into_iter().filter(|s| belongs(s, p)).collect(),
        },
    };
    all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    all
}

/// A system as a linked worktree of its project sees it.
///
/// A repo system's folder is checked out in every worktree, and a chat in one
/// edits that copy — it is what lands on the chat's branch. So its root moves
/// to the same place inside the worktree, and the project to the worktree.
/// A system in Nyra's folder keeps its root: there is one copy of it.
fn seen_from(mut s: SystemEntry, wt: &Path, main: &Path) -> SystemEntry {
    let main_c = canonical(main);
    if let Ok(rel) = canonical(&s.root).strip_prefix(&main_c) {
        let there = wt.join(rel);
        if there.is_dir() {
            s.root = there;
        }
    }
    if canonical(&s.project) == main_c {
        s.project = wt.to_path_buf();
    }
    s
}

/// The `id` a system folder's manifest declares.
pub fn manifest_id(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join(MANIFEST)).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v["id"].as_str().map(str::to_string)
}

/// A system by id, read at `root` when the caller holds a different copy of
/// it — a worktree's. Any folder whose manifest carries the same id is a copy;
/// anything else is refused, so a root cannot be passed in to list an
/// unrelated folder.
pub fn entry_at(id: &str, root: Option<&Path>) -> Result<SystemEntry, String> {
    let entry = list(None).into_iter().find(|s| s.id == id).ok_or_else(|| format!("no design system {id}"))?;
    let Some(root) = root.filter(|r| canonical(r) != canonical(&entry.root)) else {
        return Ok(entry);
    };
    if manifest_id(root).as_deref() != Some(id) {
        return Err(format!("{} is not a copy of design system {id}", root.display()));
    }
    Ok(match crate::git::linked_worktree(root) {
        Some((wt, main)) => seen_from(entry, &wt, &main),
        None => SystemEntry { root: root.to_path_buf(), ..entry },
    })
}

/// An id, an exact name, then a partial one — newest first, scoped to the project.
pub fn resolve(needle: &str, project: Option<&Path>) -> Option<SystemEntry> {
    let all = list(project);
    if let Some(hit) = all.iter().find(|s| s.id == needle) {
        return Some(hit.clone());
    }
    let lower = needle.to_lowercase();
    all.iter()
        .find(|s| s.name.to_lowercase() == lower)
        .or_else(|| all.iter().find(|s| s.name.to_lowercase().contains(&lower)))
        .cloned()
}

/// The systems a chat working in `cwd` should know about: its project's, and
/// any whose folder it is inside or contains.
pub fn for_cwd(cwd: &Path) -> Vec<SystemEntry> {
    let reg = load_in(&designs_root()).map(|r| r.systems).unwrap_or_default();
    let near = |s: &SystemEntry, at: &Path| s.project == at || within(at, &s.root) || within(&s.root, at) || within(&s.project, at);
    match crate::git::linked_worktree(cwd) {
        Some((wt, main)) => {
            let there = cwd.strip_prefix(&wt).map(|rel| main.join(rel)).unwrap_or_else(|_| main.clone());
            reg.into_iter()
                .filter_map(|s| {
                    if near(&s, &there) {
                        Some(seen_from(s, &wt, &main))
                    } else {
                        near(&s, cwd).then_some(s)
                    }
                })
                .collect()
        }
        None => reg.into_iter().filter(|s| near(s, cwd)).collect(),
    }
}

/// The system a path belongs to, its path inside the system, and whether the
/// path was under a root the system has since moved away from.
pub fn system_of(path: &Path) -> Option<(SystemEntry, String, bool)> {
    system_of_seen(&load_in(&designs_root()).ok()?, path)
}

fn system_of_seen(reg: &Registry, path: &Path) -> Option<(SystemEntry, String, bool)> {
    if let Some(hit) = system_of_in(reg, path) {
        return Some(hit);
    }
    // A file in a worktree's copy of a repo system: the same file, in the main
    // checkout, is a member, and the worktree's copy is the one to read.
    let (wt, main) = crate::git::linked_worktree(path)?;
    let in_main = main.join(path.strip_prefix(&wt).ok()?);
    let (s, rel, moved) = system_of_in(reg, &in_main)?;
    Some((seen_from(s, &wt, &main), rel, moved))
}

fn system_of_in(reg: &Registry, path: &Path) -> Option<(SystemEntry, String, bool)> {
    let target = canonical(path);
    for s in &reg.systems {
        let root = canonical(&s.root);
        if let Ok(rel) = target.strip_prefix(&root) {
            return Some((s.clone(), rel_string(rel), false));
        }
    }
    for s in &reg.systems {
        for old in &s.previous_roots {
            if let Ok(rel) = target.strip_prefix(canonical(old)) {
                return Some((s.clone(), rel_string(rel), true));
            }
        }
    }
    None
}

/// Inside a system, paths are written with `/` on every OS: they appear in
/// documents, issues and comments, which travel between machines.
fn rel_string(rel: &Path) -> String {
    rel.components().map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/")
}

pub fn create(name: &str, project: &Path, location: Location) -> Result<SystemEntry, String> {
    let entry = create_in(&designs_root(), name, project, location)?;
    announce();
    Ok(entry)
}

fn create_in(root: &Path, name: &str, project: &Path, location: Location) -> Result<SystemEntry, String> {
    let mut reg = load_in(root)?;
    if let Some(taken) = reg
        .systems
        .iter()
        .find(|s| s.project == project && s.name.to_lowercase() == name.to_lowercase())
    {
        return Err(format!(
            "this project already has a design system named \"{}\" ({}, {}).",
            taken.name,
            taken.id,
            taken.root.display()
        ));
    }
    let id = format!("s_{}", util::rand_hex(5));
    // A system someone chose to keep in the repo is one they want the repo to
    // know about: the project skill starts on there, and never for Nyra's folder.
    let in_repo = matches!(location, Location::Repo(_));
    let dir = match location {
        Location::Nyra => root.join("systems").join(format!("{}-{id}", slug(name))),
        Location::Repo(rel) => {
            let dir = if rel.is_absolute() { rel } else { project.join(rel) };
            if canonical(&dir) == canonical(project) {
                return Err("a design system needs its own folder, not the project root (use design/)".into());
            }
            dir
        }
    };
    check_free(&reg, &dir)?;
    if dir.join(MANIFEST).exists() {
        return Err(format!(
            "{} is already a design system; adopt it instead of creating one.",
            dir.display()
        ));
    }
    if dir.exists() && fs::read_dir(&dir).map(|mut d| d.next().is_some()).unwrap_or(false) {
        return Err(format!("{} already exists and is not empty", dir.display()));
    }

    for sub in MEMBER_DIRS.iter().chain([GUIDELINES].iter()) {
        fs::create_dir_all(dir.join(sub)).map_err(|e| format!("could not create {}: {e}", dir.join(sub).display()))?;
    }
    let manifest = serde_json::json!({ "schema": FORMAT, "id": id, "name": name, "description": "" });
    write_new(&dir.join(MANIFEST), &format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap_or_default()))?;
    write_new(&dir.join(TOKENS), DEFAULT_TOKENS)?;

    let entry = SystemEntry {
        id,
        name: name.to_string(),
        root: dir,
        project: project.to_path_buf(),
        updated_at: now(),
        previous_roots: Vec::new(),
        project_skill: in_repo,
    };
    reg.systems.push(entry.clone());
    reg.schema = SCHEMA;
    save_in(root, &reg)?;
    Ok(entry)
}

fn write_new(path: &Path, body: &str) -> Result<(), String> {
    fs::write(path, body).map_err(|e| format!("could not write {}: {e}", path.display()))
}

/// No system inside another, either way round: a file under both would belong
/// to two namespaces at once.
fn check_free(reg: &Registry, dir: &Path) -> Result<(), String> {
    for s in &reg.systems {
        if within(&s.root, dir) || within(dir, &s.root) {
            return Err(format!(
                "{} overlaps the design system \"{}\" at {}; systems cannot nest",
                dir.display(),
                s.name,
                s.root.display()
            ));
        }
    }
    Ok(())
}

/// Register a folder that already holds a `nyra.design.json` — one that came
/// with a repo, or one moved by hand.
pub fn adopt(dir: &Path, project: &Path) -> Result<SystemEntry, String> {
    let entry = adopt_in(&designs_root(), dir, project)?;
    announce();
    Ok(entry)
}

fn adopt_in(root: &Path, dir: &Path, project: &Path) -> Result<SystemEntry, String> {
    let manifest_path = dir.join(MANIFEST);
    let text = fs::read_to_string(&manifest_path).map_err(|_| format!("{} has no {MANIFEST}", dir.display()))?;
    let mut manifest: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("{} is not valid JSON: {e}", manifest_path.display()))?;

    let mut reg = load_in(root)?;
    if let Some(existing) = reg.systems.iter().find(|s| canonical(&s.root) == canonical(dir)) {
        return Ok(existing.clone());
    }
    check_free(&reg, dir)?;

    let name = manifest.get("name").and_then(|v| v.as_str()).unwrap_or("Design system").to_string();
    // The manifest id is a hint for reconnecting state, never the identity. A
    // copied folder carries its original's id; it gets one of its own.
    let hinted = manifest.get("id").and_then(|v| v.as_str()).map(str::to_string);
    let id = match hinted {
        Some(h) if h.starts_with("s_") && !reg.systems.iter().any(|s| s.id == h) => h,
        _ => {
            let fresh = format!("s_{}", util::rand_hex(5));
            manifest["id"] = serde_json::Value::String(fresh.clone());
            let body = format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap_or_default());
            fs::write(&manifest_path, body).map_err(|e| format!("could not update {}: {e}", manifest_path.display()))?;
            fresh
        }
    };
    let entry = SystemEntry {
        id,
        name,
        root: dir.to_path_buf(),
        project: project.to_path_buf(),
        updated_at: now(),
        previous_roots: Vec::new(),
        project_skill: false,
    };
    reg.systems.push(entry.clone());
    save_in(root, &reg)?;
    Ok(entry)
}

#[derive(Debug, Serialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FileInfo {
    /// Absolute.
    pub path: PathBuf,
    /// Inside the system, `/`-separated: `components/button.nyui.json`.
    pub rel: String,
    /// `component`, `pattern`, `screen`, `guideline`, `manifest`, `tokens`.
    pub kind: String,
    pub size: u64,
    pub mtime_ms: i64,
}

/// Every file the system is made of, with enough to notice a change. One call
/// per poll for the whole system, rather than a timer per file.
pub fn files(entry: &SystemEntry) -> Vec<FileInfo> {
    let info = |path: PathBuf, kind: &str| -> Option<FileInfo> {
        let meta = fs::metadata(&path).ok()?;
        if !meta.is_file() {
            return None;
        }
        let rel = rel_string(path.strip_prefix(&entry.root).ok()?);
        let mtime_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        Some(FileInfo { path, rel, kind: kind.to_string(), size: meta.len(), mtime_ms })
    };
    let mut out = Vec::new();
    out.extend(info(entry.root.join(MANIFEST), "manifest"));
    out.extend(info(entry.root.join(TOKENS), "tokens"));
    let listed = |dir: &str, suffix: &str| -> Vec<PathBuf> {
        let mut paths: Vec<PathBuf> = fs::read_dir(entry.root.join(dir))
            .map(|rd| rd.filter_map(|e| e.ok().map(|e| e.path())).collect())
            .unwrap_or_default();
        // `#` is what separates a path from an artboard in a chip, so a file
        // named with one could never be pointed at.
        paths.retain(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.ends_with(suffix) && !n.contains('#') && !n.starts_with('.'))
        });
        paths.sort();
        paths
    };
    for (dir, kind) in [("components", "component"), ("patterns", "pattern"), ("screens", "screen")] {
        out.extend(listed(dir, ".nyui.json").into_iter().filter_map(|p| info(p, kind)));
    }
    out.extend(listed(GUIDELINES, ".md").into_iter().filter_map(|p| info(p, "guideline")));
    out
}

/// Move a system to another folder: copy, check the copy, then delete the
/// original — `rename` cannot cross volumes, and a half-moved system is worse
/// than one that did not move. The old root is remembered.
pub fn relocate(id: &str, to: &Path) -> Result<SystemEntry, String> {
    let entry = relocate_in(&designs_root(), id, to)?;
    announce();
    Ok(entry)
}

fn relocate_in(root: &Path, id: &str, to: &Path) -> Result<SystemEntry, String> {
    let mut reg = load_in(root)?;
    let at = reg.systems.iter().position(|s| s.id == id).ok_or_else(|| format!("no design system {id}"))?;
    let from = reg.systems[at].root.clone();
    if to.exists() {
        return Err(format!("{} already exists; pick an empty location", to.display()));
    }
    let others = Registry { schema: SCHEMA, systems: reg.systems.iter().filter(|s| s.id != id).cloned().collect() };
    check_free(&others, to)?;

    copy_tree(&from, to).inspect_err(|_| {
        fs::remove_dir_all(to).ok();
    })?;
    if tree_size(&from) != tree_size(to) {
        fs::remove_dir_all(to).ok();
        return Err("the copy does not match the original; nothing was moved".into());
    }
    fs::remove_dir_all(&from).map_err(|e| format!("copied, but could not remove {}: {e}", from.display()))?;

    let entry = &mut reg.systems[at];
    entry.previous_roots.retain(|p| p != to);
    entry.previous_roots.push(from);
    entry.root = to.to_path_buf();
    entry.updated_at = now();
    let moved = entry.clone();
    save_in(root, &reg)?;
    Ok(moved)
}

fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("could not create {}: {e}", to.display()))?;
    for e in fs::read_dir(from).map_err(|e| format!("could not read {}: {e}", from.display()))? {
        let e = e.map_err(|e| e.to_string())?;
        let target = to.join(e.file_name());
        if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            copy_tree(&e.path(), &target)?;
        } else {
            fs::copy(e.path(), &target).map_err(|err| format!("could not copy {}: {err}", e.path().display()))?;
        }
    }
    Ok(())
}

/// Files and bytes under a folder — what "the copy matches" is checked by.
fn tree_size(dir: &Path) -> (u64, u64) {
    let mut files = 0;
    let mut bytes = 0;
    if let Ok(rd) = fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                let (f, b) = tree_size(&p);
                files += f;
                bytes += b;
            } else if let Ok(m) = e.metadata() {
                files += 1;
                bytes += m.len();
            }
        }
    }
    (files, bytes)
}

fn update(id: &str, change: impl FnOnce(&mut SystemEntry)) -> Result<SystemEntry, String> {
    let root = designs_root();
    let mut reg = load_in(&root)?;
    let entry = reg.systems.iter_mut().find(|s| s.id == id).ok_or_else(|| format!("no design system {id}"))?;
    change(entry);
    entry.updated_at = now();
    let out = entry.clone();
    save_in(&root, &reg)?;
    announce();
    Ok(out)
}

pub fn rename(id: &str, name: &str) -> Result<SystemEntry, String> {
    update(id, |s| s.name = name.to_string())
}

pub fn set_project_skill(id: &str, on: bool) -> Result<SystemEntry, String> {
    update(id, |s| s.project_skill = on)
}

/// Stop listing a system. Its files stay where they are.
pub fn forget(id: &str) -> Result<(), String> {
    let root = designs_root();
    let mut reg = load_in(&root)?;
    reg.systems.retain(|s| s.id != id);
    save_in(&root, &reg)?;
    announce();
    Ok(())
}

/// Where the repo-level skill for a system lives.
pub fn project_skill_path(entry: &SystemEntry) -> PathBuf {
    entry
        .project
        .join(".claude")
        .join("skills")
        .join(format!("{}-design-system", slug(&entry.name)))
        .join("SKILL.md")
}

/// Write the system's digest as a skill in its repo, so plain Claude Code —
/// and anyone who clones the repo — knows the system too. Only for a system
/// that lives in its project and has opted in; a system in Nyra's folder never
/// writes into a repo.
pub fn write_project_skill(id: &str, content: &str, root: Option<&Path>) -> Result<Option<PathBuf>, String> {
    let entry = entry_at(id, root)?;
    if !entry.project_skill || !within(&entry.project, &entry.root) {
        return Ok(None);
    }
    let path = project_skill_path(&entry);
    if fs::read_to_string(&path).ok().as_deref() == Some(content) {
        return Ok(Some(path));
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    fs::write(&path, content).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    Ok(Some(path))
}

/// The `name` a design document gives itself, read from its first few
/// kilobytes — a design can be tens of megabytes, and the name comes first.
/// The first `"name"` key is the document's in every file Nyra writes; a file
/// written otherwise may name an artboard instead, which is still a fair name.
fn doc_name(path: &Path) -> Option<String> {
    use std::io::Read;
    let mut head = vec![0u8; 16 * 1024];
    let n = fs::File::open(path).ok()?.read(&mut head).ok()?;
    let text = String::from_utf8_lossy(&head[..n]);
    let re = regex::Regex::new(r#""name"\s*:\s*"((?:[^"\\]|\\.){1,120})""#).ok()?;
    let raw = re.captures(&text)?.get(1)?.as_str();
    let name: String = serde_json::from_str(&format!("\"{raw}\"")).ok()?;
    let name = name.trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// What `discover` found in a project.
#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Discovered {
    /// Systems now registered for the project, including ones adopted just now.
    pub systems: Vec<SystemEntry>,
    /// Loose design files (outside any system) now in the design index.
    pub designs: usize,
}

/// Find the design work a project already has, so neither the user nor Claude
/// has to go looking: every committed or untracked-but-not-ignored
/// `nyra.design.json` becomes a system, and every loose `.nyui.json` outside a
/// system a draft. Bounded by `git ls-files`, never a walk of the disk.
pub async fn discover(project: &Path) -> Discovered {
    let cwd = project.to_string_lossy().to_string();
    let manifests = crate::git::project_files(&cwd, &["*nyra.design.json"]).await;
    let mut adopted_any = false;
    for m in &manifests {
        let manifest = Path::new(m);
        let Some(dir) = manifest.parent() else { continue };
        if manifest.file_name().and_then(|n| n.to_str()) != Some(MANIFEST) {
            continue;
        }
        let known = load_in(&designs_root()).map(|r| r.systems.iter().any(|s| canonical(&s.root) == canonical(dir))).unwrap_or(true);
        if !known && adopt_in(&designs_root(), dir, project).is_ok() {
            adopted_any = true;
        }
    }

    let systems = list(Some(project));
    let loose = crate::git::project_files(&cwd, &["*.nyui.json"]).await;
    // Known files are skipped before adopting, not by it: adopt announces a
    // change either way, and a launch that found nothing new should say nothing.
    let known: Vec<PathBuf> = crate::designs::list(None).into_iter().map(|d| d.path).collect();
    let mut designs = 0;
    for path in loose.iter().map(PathBuf::from) {
        if systems.iter().any(|s| within(&s.root, &path)) || known.iter().any(|k| crate::designs::same_file(k, &path)) {
            continue;
        }
        let name = doc_name(&path).unwrap_or_else(|| {
            path.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.trim_end_matches(".nyui.json").replace(['-', '_'], " "))
                .unwrap_or_else(|| "Design".into())
        });
        if crate::designs::adopt(&name, &path, project).is_ok() {
            designs += 1;
        }
    }
    if adopted_any {
        announce();
    }
    Discovered { systems, designs }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyra-systems-{tag}-{}", util::rand_hex(6)));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn the_default_tokens_are_the_current_format() {
        let v: serde_json::Value = serde_json::from_str(DEFAULT_TOKENS).unwrap();
        assert_eq!(v["schema"], FORMAT);
        assert!(v["font"]["body"].is_object());
        assert_eq!(v["color"]["transparent"], "transparent");
    }

    #[test]
    fn creates_a_system_in_nyras_folder_with_its_skeleton() {
        let root = scratch("nyra");
        let project = scratch("proj");
        let s = create_in(&root, "Closeup", &project, Location::Nyra).unwrap();
        assert!(s.id.starts_with("s_"));
        assert!(s.root.starts_with(root.join("systems")));
        for f in [MANIFEST, TOKENS, "components", "patterns", "screens", "guidelines"] {
            assert!(s.root.join(f).exists(), "{f}");
        }
        let manifest: serde_json::Value = serde_json::from_str(&fs::read_to_string(s.root.join(MANIFEST)).unwrap()).unwrap();
        assert_eq!(manifest["id"], s.id.as_str());
        assert_eq!(manifest["schema"], FORMAT);
        // Nothing landed in the project.
        assert_eq!(fs::read_dir(&project).unwrap().count(), 0);
        assert!(create_in(&root, "closeup", &project, Location::Nyra).is_err());
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn a_repo_system_gets_its_own_folder_never_the_root() {
        let root = scratch("repo-reg");
        let project = scratch("repo");
        let s = create_in(&root, "Closeup", &project, Location::Repo("design".into())).unwrap();
        assert_eq!(s.root, project.join("design"));
        assert!(s.project_skill, "a repo system teaches the repo by default");
        assert!(create_in(&root, "Other", &project, Location::Repo(".".into())).is_err());
        // Nested either way is refused.
        assert!(create_in(&root, "Inner", &project, Location::Repo("design/inner".into())).is_err());
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn membership_is_by_folder_and_remembers_a_move() {
        let root = scratch("member");
        let project = scratch("member-proj");
        let s = create_in(&root, "Closeup", &project, Location::Nyra).unwrap();
        let reg = load_in(&root).unwrap();
        let file = s.root.join("components").join("button.nyui.json");
        let (hit, rel, moved) = system_of_in(&reg, &file).unwrap();
        assert_eq!(hit.id, s.id);
        assert_eq!(rel, "components/button.nyui.json");
        assert!(!moved);
        assert!(system_of_in(&reg, &project.join("x.nyui.json")).is_none());

        let to = project.join("design");
        let after = relocate_in(&root, &s.id, &to).unwrap();
        assert_eq!(after.root, to);
        assert!(!s.root.exists());
        assert!(to.join(MANIFEST).exists());
        let reg = load_in(&root).unwrap();
        let (_, _, moved) = system_of_in(&reg, &file).unwrap();
        assert!(moved, "a path under the old root is reported as moved");
        // Moving onto something that exists is refused.
        fs::create_dir_all(project.join("taken")).unwrap();
        assert!(relocate_in(&root, &s.id, &project.join("taken")).is_err());
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn lists_only_its_own_three_folders_and_guidelines() {
        let root = scratch("files");
        let project = scratch("files-proj");
        let s = create_in(&root, "Closeup", &project, Location::Nyra).unwrap();
        fs::write(s.root.join("components/button.nyui.json"), "{}").unwrap();
        fs::write(s.root.join("screens/editor.nyui.json"), "{}").unwrap();
        fs::write(s.root.join("screens/notes.txt"), "x").unwrap();
        fs::write(s.root.join("screens/bad#name.nyui.json"), "{}").unwrap();
        fs::create_dir_all(s.root.join("components/deep")).unwrap();
        fs::write(s.root.join("components/deep/hidden.nyui.json"), "{}").unwrap();
        fs::write(s.root.join("guidelines/brief.md"), "# Brief").unwrap();
        let rels: Vec<(String, String)> = files(&s).into_iter().map(|f| (f.rel, f.kind)).collect();
        assert_eq!(
            rels,
            vec![
                ("nyra.design.json".into(), "manifest".into()),
                ("tokens.json".into(), "tokens".into()),
                ("components/button.nyui.json".into(), "component".into()),
                ("screens/editor.nyui.json".into(), "screen".into()),
                ("guidelines/brief.md".into(), "guideline".into()),
            ]
        );
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn adopting_a_copy_gives_it_an_id_of_its_own() {
        let root = scratch("adopt");
        let project = scratch("adopt-proj");
        let s = create_in(&root, "Closeup", &project, Location::Nyra).unwrap();
        let copy = project.join("design");
        copy_tree(&s.root, &copy).unwrap();
        let adopted = adopt_in(&root, &copy, &project).unwrap();
        assert_ne!(adopted.id, s.id);
        let manifest: serde_json::Value = serde_json::from_str(&fs::read_to_string(copy.join(MANIFEST)).unwrap()).unwrap();
        assert_eq!(manifest["id"], adopted.id.as_str());
        // Adopting the same folder again is the same system.
        assert_eq!(adopt_in(&root, &copy, &project).unwrap().id, adopted.id);
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn an_unreadable_registry_is_never_overwritten() {
        let root = scratch("corrupt");
        fs::write(registry_path(&root), "{ not json").unwrap();
        let project = scratch("corrupt-proj");
        assert!(create_in(&root, "X", &project, Location::Nyra).is_err());
        assert_eq!(fs::read_to_string(registry_path(&root)).unwrap(), "{ not json");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&project).ok();
    }

    #[test]
    fn the_wire_shape_is_camel_case() {
        let e = SystemEntry {
            id: "s_1".into(),
            name: "N".into(),
            root: "/r".into(),
            project: "/p".into(),
            updated_at: "t".into(),
            previous_roots: vec![],
            project_skill: true,
        };
        let v = serde_json::to_value(&e).unwrap();
        assert!(v.get("updatedAt").is_some());
        assert!(v.get("previousRoots").is_some());
        assert!(v.get("projectSkill").is_some());
    }

    #[test]
    fn a_worktree_chat_sees_its_projects_systems_in_its_own_checkout() {
        let base = scratch("wt");
        let main = base.join("repo");
        let wt = base.join("trees").join("feat");
        fs::create_dir_all(main.join(".git").join("worktrees").join("feat")).unwrap();
        for at in [&main, &wt] {
            fs::create_dir_all(at.join("design").join("screens")).unwrap();
        }
        fs::write(wt.join(".git"), format!("gitdir: {}\n", main.join(".git").join("worktrees").join("feat").display())).unwrap();
        let repo_system = SystemEntry {
            id: "s_repo".into(),
            name: "Closeup".into(),
            root: main.join("design"),
            project: main.clone(),
            updated_at: String::new(),
            previous_roots: vec![],
            project_skill: true,
        };
        let nyra_system = SystemEntry {
            id: "s_nyra".into(),
            root: base.join("nyra-folder").join("closeup-s_nyra"),
            ..repo_system.clone()
        };
        let elsewhere = SystemEntry { id: "s_other".into(), project: base.join("other"), root: base.join("other").join("design"), ..repo_system.clone() };

        let seen = list_from(vec![repo_system.clone(), nyra_system.clone(), elsewhere], Some(&wt));
        let ids: Vec<&str> = seen.iter().map(|s| s.id.as_str()).collect();
        assert_eq!(ids.len(), 2, "the worktree sees its project's two systems, not another project's: {ids:?}");
        let repo = seen.iter().find(|s| s.id == "s_repo").unwrap();
        assert_eq!(repo.root, wt.join("design"), "a repo system is read from the worktree's checkout");
        assert_eq!(repo.project, wt);
        let nyra = seen.iter().find(|s| s.id == "s_nyra").unwrap();
        assert_eq!(nyra.root, nyra_system.root, "Nyra's folder has one copy, wherever the chat is");

        let reg = Registry { schema: SCHEMA, systems: vec![repo_system] };
        let file = wt.join("design").join("screens").join("settings.nyui.json");
        let (s, rel, moved) = system_of_seen(&reg, &file).unwrap();
        assert_eq!((s.id.as_str(), rel.as_str(), moved), ("s_repo", "screens/settings.nyui.json", false));
        assert_eq!(s.root, wt.join("design"));
        fs::remove_dir_all(&base).ok();
    }
    #[test]
    fn a_found_design_is_named_by_its_own_name() {
        let dir = scratch("name");
        let a = dir.join("settings-full.nyui.json");
        fs::write(&a, "{\n  \"schema\": 2,\n  \"name\": \"Settings \\u2014 \\\"full\\\"\",\n  \"artboards\": []\n}").unwrap();
        assert_eq!(doc_name(&a).as_deref(), Some("Settings \u{2014} \"full\""));
        let b = dir.join("blank.nyui.json");
        fs::write(&b, "{ \"schema\": 2, \"name\": \"   \" }").unwrap();
        assert_eq!(doc_name(&b), None, "a blank name falls back to the file name");
        assert_eq!(doc_name(&dir.join("missing.nyui.json")), None);
        fs::remove_dir_all(&dir).ok();
    }
}
