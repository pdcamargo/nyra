//! Noticing skills, commands, agents and plugins that arrive from outside Nyra.
//!
//! The lists used to re-read only when Nyra itself wrote something, so a skill
//! installed with `npx skills add` in any terminal stayed invisible until a view
//! remounted. This watches the folders those lists are read from and emits
//! `nyra:library-changed` with which of them moved.
//!
//! The renderer says what to watch — the active workspace's config dir and its
//! projects — and says it again when either changes. Each root (`~/.claude`, or
//! a project's `.claude`) is watched by itself, without recursion, and only its
//! `skills`, `commands` and `agents` recursively. Never the whole of
//! `~/.claude`: `projects/` and `history.jsonl` are written on every turn.

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use once_cell::sync::Lazy;
use parking_lot::{Mutex, RwLock};
use serde_json::json;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::environment::Environment;
use crate::util;

/// Long enough that one `npx skills add`, which writes a folder of files, is
/// one event and not twelve.
const DEBOUNCE_MS: u64 = 300;

/// What a change is, by the folder it happened in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Kind {
    Skills,
    Commands,
    Agents,
    Plugins,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Skills => "skills",
            Kind::Commands => "commands",
            Kind::Agents => "agents",
            Kind::Plugins => "plugins",
        }
    }
}

const RECURSIVE: [(&str, Kind); 3] = [
    ("skills", Kind::Skills),
    ("commands", Kind::Commands),
    ("agents", Kind::Agents),
];

/// Which list a change under `root` belongs to, if any.
///
/// `plugins/` counts only for the two files that say what is installed and from
/// where — the CLI also unpacks whole plugins under `plugins/cache`. A
/// `settings.json` counts as plugins because enabling one is a write there.
pub fn classify(root: &Path, path: &Path) -> Option<Kind> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = rel.components().map(|c| c.as_os_str().to_string_lossy());
    let first = parts.next()?;
    if let Some((_, kind)) = RECURSIVE.iter().find(|(name, _)| *name == first) {
        return Some(*kind);
    }
    match (first.as_ref(), parts.next().as_deref(), parts.next()) {
        ("plugins", Some("installed_plugins.json" | "known_marketplaces.json"), None) => {
            Some(Kind::Plugins)
        }
        ("plugins", None, None) => Some(Kind::Plugins),
        ("settings.json" | "settings.local.json", None, None) => Some(Kind::Plugins),
        _ => None,
    }
}

/// The watches for one root, given what exists right now.
///
/// A root that does not exist yet is watched through its parent, so the first
/// install in a project — which creates `.claude` itself — is still seen.
fn plan(root: &Path) -> Vec<(PathBuf, RecursiveMode)> {
    if !root.is_dir() {
        return match root.parent().filter(|p| p.is_dir()) {
            Some(parent) => vec![(parent.to_path_buf(), RecursiveMode::NonRecursive)],
            None => Vec::new(),
        };
    }
    let mut out = vec![(root.to_path_buf(), RecursiveMode::NonRecursive)];
    for (name, _) in RECURSIVE {
        let dir = root.join(name);
        if dir.is_dir() {
            out.push((dir, RecursiveMode::Recursive));
        }
    }
    let plugins = root.join("plugins");
    if plugins.is_dir() {
        out.push((plugins, RecursiveMode::NonRecursive));
    }
    out
}

/// `root` with symlinks resolved, as far up as it exists.
///
/// FSEvents reports real paths, so a project under `/tmp` (`/private/tmp` on
/// macOS) or behind a symlinked folder reported every change at a path that
/// never matched the root, and nothing was ever announced. A root that does
/// not exist yet keeps its name under its resolved parent.
fn real(root: &Path) -> PathBuf {
    if let Ok(path) = std::fs::canonicalize(root) {
        return path;
    }
    match (root.parent().and_then(|p| std::fs::canonicalize(p).ok()), root.file_name()) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => root.to_path_buf(),
    }
}

/// The OS watcher and what it is watching. Only [`resync`] touches this, and
/// never from inside the event callback: notify's FSEvents backend restarts its
/// stream on every `watch` and waits for the event thread to stop, so taking
/// this lock in the callback — or calling `watch` from it — hung the whole app.
struct Watches {
    watcher: RecommendedWatcher,
    watching: HashMap<PathBuf, RecursiveMode>,
}

static WATCHES: Lazy<Mutex<Option<Watches>>> = Lazy::new(|| Mutex::new(None));
/// What the callback compares event paths with. Its own lock, held only to
/// read or replace the list, so the callback can never wait on a `watch`.
static ROOTS: Lazy<RwLock<Vec<PathBuf>>> = Lazy::new(|| RwLock::new(Vec::new()));
static PENDING: Lazy<Mutex<BTreeSet<Kind>>> = Lazy::new(|| Mutex::new(BTreeSet::new()));
static GENERATION: Lazy<Arc<AtomicU64>> = Lazy::new(|| Arc::new(AtomicU64::new(0)));

/// Watch exactly these roots from now on. Returns at once; the OS watches are
/// moved on a blocking worker, off the IPC thread.
pub fn set_roots(config_dir: Option<&Path>, projects: &[String]) {
    let mut roots = vec![util::claude_dir(&Environment::Host, config_dir)];
    for project in projects {
        // A WSL project's folders sit behind a network share the OS watcher
        // cannot see into; its lists still refresh when a view opens.
        if Environment::of(project).is_host() {
            roots.push(Path::new(project).join(".claude"));
        }
    }
    let mut roots: Vec<PathBuf> = roots.iter().map(|r| real(r)).collect();
    roots.sort();
    roots.dedup();
    *ROOTS.write() = roots;
    request_resync();
}

fn request_resync() {
    tauri::async_runtime::spawn_blocking(resync);
}

/// Bring the OS watches in line with what exists under the roots now.
fn resync() {
    let roots = ROOTS.read().clone();
    let want: HashMap<PathBuf, RecursiveMode> = roots.iter().flat_map(|r| plan(r)).collect();

    let mut guard = WATCHES.lock();
    if guard.is_none() {
        match notify::recommended_watcher(on_event) {
            Ok(watcher) => *guard = Some(Watches { watcher, watching: HashMap::new() }),
            Err(e) => {
                crate::log!("library-watch", "no watcher: {e}");
                return;
            }
        }
    }
    let state = guard.as_mut().expect("just set");
    let stale: Vec<PathBuf> = state
        .watching
        .iter()
        .filter(|(path, mode)| want.get(*path) != Some(mode))
        .map(|(path, _)| path.clone())
        .collect();
    for path in stale {
        let _ = state.watcher.unwatch(&path);
        state.watching.remove(&path);
    }
    for (path, mode) in want {
        if state.watching.contains_key(&path) {
            continue;
        }
        match state.watcher.watch(&path, mode) {
            Ok(()) => {
                state.watching.insert(path, mode);
            }
            Err(e) => crate::log!("library-watch", "watch {} failed: {e}", path.display()),
        }
    }
}

fn on_event(result: notify::Result<Event>) {
    let Ok(event) = result else { return };
    if event.kind.is_access() {
        return;
    }
    let mut kinds = BTreeSet::new();
    // A folder appearing or going away at the top — `.claude`, `skills` — moves
    // what has to be watched.
    let mut structural = false;
    {
        let roots = ROOTS.read();
        for path in &event.paths {
            for root in roots.iter() {
                if path == root {
                    structural = true;
                    kinds.extend([Kind::Skills, Kind::Commands, Kind::Agents, Kind::Plugins]);
                } else if let Some(kind) = classify(root, path) {
                    if path.parent() == Some(root.as_path()) {
                        structural = true;
                    }
                    kinds.insert(kind);
                }
            }
        }
    }
    if kinds.is_empty() {
        return;
    }
    if structural {
        request_resync();
    }
    PENDING.lock().extend(kinds);
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let latest = GENERATION.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(DEBOUNCE_MS)).await;
        if latest.load(Ordering::SeqCst) != generation {
            return;
        }
        let kinds: Vec<&str> = std::mem::take(&mut *PENDING.lock()).into_iter().map(Kind::as_str).collect();
        if !kinds.is_empty() {
            util::emit("nyra:library-changed", json!({ "kinds": kinds }));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_by_the_folder_a_change_is_in() {
        let root = Path::new("/h/.claude");
        let at = |rel: &str| classify(root, &root.join(rel));
        assert_eq!(at("skills/make-it/SKILL.md"), Some(Kind::Skills));
        assert_eq!(at("skills"), Some(Kind::Skills));
        assert_eq!(at("commands/git/sync.md"), Some(Kind::Commands));
        assert_eq!(at("agents/reviewer.md"), Some(Kind::Agents));
        assert_eq!(at("plugins/installed_plugins.json"), Some(Kind::Plugins));
        assert_eq!(at("plugins/known_marketplaces.json"), Some(Kind::Plugins));
        assert_eq!(at("settings.json"), Some(Kind::Plugins));
    }

    #[test]
    fn ignores_what_is_written_on_every_turn() {
        let root = Path::new("/h/.claude");
        let at = |rel: &str| classify(root, &root.join(rel));
        assert_eq!(at("history.jsonl"), None);
        assert_eq!(at("projects/-Users-me-repo/abc.jsonl"), None);
        assert_eq!(at("plugins/cache/foo/1.0.0/README.md"), None);
        assert_eq!(at("todos/x.json"), None);
        assert_eq!(classify(root, Path::new("/elsewhere/skills/x")), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_root_behind_a_symlink_is_compared_by_its_real_path() {
        let dir = std::env::temp_dir().join(format!("nyra-libwatch-link-{}", std::process::id()));
        let real_dir = dir.join("real");
        std::fs::create_dir_all(real_dir.join(".claude")).unwrap();
        std::os::unix::fs::symlink(&real_dir, dir.join("link")).unwrap();

        let resolved = real(&dir.join("link").join(".claude"));
        assert_eq!(resolved, std::fs::canonicalize(real_dir.join(".claude")).unwrap());
        // Not there yet: the name, under the resolved parent.
        let missing = real(&dir.join("link").join("nope"));
        assert_eq!(missing, std::fs::canonicalize(&real_dir).unwrap().join("nope"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_missing_root_is_watched_through_its_parent() {
        let dir = std::env::temp_dir().join(format!("nyra-libwatch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let root = dir.join(".claude");

        assert_eq!(plan(&root), vec![(dir.clone(), RecursiveMode::NonRecursive)]);

        std::fs::create_dir_all(root.join("skills")).unwrap();
        assert_eq!(
            plan(&root),
            vec![
                (root.clone(), RecursiveMode::NonRecursive),
                (root.join("skills"), RecursiveMode::Recursive),
            ]
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
