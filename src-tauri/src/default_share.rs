//! Default's own skills and instructions, in every workspace.
//!
//! A workspace is its own `CLAUDE_CONFIG_DIR`, so a `claude` started in one
//! never looks in `~/.claude`. Whatever someone wrote for themselves there — a
//! skill, a slash command, an agent, a rule, their global CLAUDE.md — stopped
//! existing the moment they switched workspace. The CLAUDE.md only seemed to
//! survive: the CLI, walking up from a project under the home directory, found
//! `~/.claude/CLAUDE.md` and read it as a *project* file. A project anywhere
//! else got nothing.
//!
//! So before a workspace's `claude` starts, each entry of Default's `skills`,
//! `commands`, `agents`, `output-styles` and `rules` gets a link in the
//! workspace, and the workspace's CLAUDE.md gets one line importing Default's.
//! Links rather than copies, so an edit in Default is in every workspace at
//! once. Checked against CLI 2.1.306: it lists a linked skill, loads it, and
//! reads the files beside its SKILL.md through the link; and the import is
//! deduped against the walk-up copy, so a project under home reads it once.
//!
//! Three rules:
//!
//! 1. **The workspace's own entry wins.** A real file or folder already there
//!    under the same name is never touched, and nothing is linked over it.
//! 2. **Only what we made is ours to take back.** Every link — or, on Windows
//!    without symlinks, every copy of a file — is recorded, and only a recorded
//!    entry that is still a link, or a copy nobody has edited, is removed. A
//!    link someone replaced with a real file, or an edited copy, is theirs.
//! 3. **Nyra's own files stay out of it.** The skills and the agent Nyra ships
//!    are kept per home by `managed_skills`, each with its own record, and the
//!    CLI's `skills/synced` holds the claude.ai organisation's skills for the
//!    account Default is signed in with, which need not be the workspace's.
//!
//! On unless a workspace turns it off, which takes back everything recorded.
//! The setting and the record are `<workspace>/default-share.json`, read here,
//! so a flow a trigger starts with no window open still honours the setting.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use crate::environment::Environment;
use crate::managed_skills::{Home, BUNDLED, FILES};
use crate::{platform, util};

/// The folders of a config dir whose entries are shared, one link per entry.
const KINDS: &[&str] = &["skills", "commands", "agents", "output-styles", "rules"];

/// The line a workspace's CLAUDE.md imports Default's with. `~` rather than a
/// full path: the CLI expands it itself on every OS, and it is the line a
/// person would have typed.
const IMPORT_LINE: &str = "@~/.claude/CLAUDE.md";

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    /// None until someone chooses, which is on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    enabled: Option<bool>,
    /// What we put in the workspace, by `<kind>/<name>`.
    #[serde(default)]
    entries: BTreeMap<String, Shared>,
    /// Whether the import line in the workspace's CLAUDE.md is the one we added.
    #[serde(default)]
    claude_md: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum Shared {
    Link,
    /// A file copied where no link could be made, with the hash of what we
    /// wrote — the way to tell our copy from one someone has since edited.
    Copy { hash: String },
}

/// Passed in rather than worked out from `$HOME`, so the tests can run the
/// real loop, the part that removes things, against a temp directory.
struct Paths {
    /// Default's config dir, `~/.claude`.
    default: PathBuf,
    /// The workspace's.
    workspace: PathBuf,
    record: PathBuf,
}

impl Paths {
    /// None for anything but a workspace's config dir. This writes into the
    /// directory it is handed, so Default, or a `CLAUDE_CONFIG_DIR` someone
    /// exported, never gets that far.
    fn for_workspace(config_dir: &Path) -> Option<Self> {
        if !crate::workspaces::is_workspace_dir(config_dir) {
            return None;
        }
        Some(Self {
            default: util::claude_dir(&Environment::Host, None),
            workspace: config_dir.to_path_buf(),
            record: config_dir.parent()?.join("default-share.json"),
        })
    }
}

/// Two chats starting in one workspace at once would otherwise both find a
/// skill missing and race to link it.
static LOCK: Mutex<()> = Mutex::new(());

fn lock() -> MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

/// Bring a workspace in line with Default, as a `claude` is about to start in
/// it. Quiet: a failure costs a missing skill, and is logged. Nothing for a
/// config dir that is not a workspace's, or in a passive dev instance, for the
/// reason `managed_skills::sync` is not run there.
pub fn sync(config_dir: &Path) {
    if crate::passive_dev() {
        return;
    }
    if let Some(paths) = Paths::for_workspace(config_dir) {
        reconcile(&paths);
    }
}

/// Every workspace, at launch.
pub fn sync_all() {
    for config_dir in crate::workspaces::config_roots() {
        sync(&config_dir);
    }
}

/// Whether a workspace shares Default's skills and instructions.
pub fn enabled(config_dir: &Path) -> bool {
    Paths::for_workspace(config_dir).is_some_and(|paths| read_record(&paths.record).enabled.unwrap_or(true))
}

/// Turn sharing on or off for a workspace, and act on it straight away.
pub fn set_enabled(config_dir: &Path, on: bool) -> Result<(), String> {
    let paths = Paths::for_workspace(config_dir).ok_or_else(|| "Not a workspace's config dir.".to_string())?;
    set_enabled_in(&paths, on)?;
    sync(config_dir);
    Ok(())
}

fn set_enabled_in(paths: &Paths, on: bool) -> Result<(), String> {
    let _guard = lock();
    let mut record = read_record(&paths.record);
    record.enabled = Some(on);
    write_record(&paths.record, &record)
}

/// The entries of a workspace that are Default's, as paths in the workspace:
/// how the skills and commands panels tell them apart. Empty for Default.
pub fn shared(config_dir: Option<&Path>) -> BTreeSet<PathBuf> {
    let Some(paths) = config_dir.and_then(Paths::for_workspace) else {
        return BTreeSet::new();
    };
    read_record(&paths.record)
        .entries
        .keys()
        .map(|rel| under(&paths.workspace, rel))
        .collect()
}

/// Whether `path` — a skill's SKILL.md, a command's file — is, or sits inside,
/// one of a workspace's shared entries. Deleting one from the workspace only
/// removes the link, which the next chat puts back, so the panels refuse.
pub fn is_shared_path(path: &Path) -> bool {
    let Some(config_dir) = path.ancestors().find(|a| a.file_name().is_some_and(|n| n == ".claude")) else {
        return false;
    };
    shared(Some(config_dir)).iter().any(|entry| path.starts_with(entry))
}

fn reconcile(paths: &Paths) {
    let _guard = lock();
    let mut record = read_record(&paths.record);
    let on = record.enabled.unwrap_or(true);
    let wanted = if on { eligible(&paths.default) } else { BTreeSet::new() };

    let mut changed = false;
    let mut rels: BTreeSet<String> = record.entries.keys().cloned().collect();
    rels.extend(wanted.iter().cloned());
    for rel in rels {
        let before = record.entries.get(&rel).cloned();
        let after = settle(paths, &rel, before.clone(), wanted.contains(&rel));
        if after != before {
            changed = true;
            match after {
                Some(shared) => record.entries.insert(rel, shared),
                None => record.entries.remove(&rel),
            };
        }
    }

    let claude_md = settle_claude_md(paths, record.claude_md, on);
    changed |= claude_md != record.claude_md;
    record.claude_md = claude_md;

    if changed {
        if let Err(e) = write_record(&paths.record, &record) {
            crate::logf!("Sharing Default with {}: {e}", paths.workspace.display());
        }
    }
}

/// `<kind>/<name>` for every entry of Default's that a workspace should have.
fn eligible(default: &Path) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for kind in KINDS {
        let Ok(entries) = fs::read_dir(default.join(kind)) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            // A dangling link in Default has nothing to share.
            if name.starts_with('.') || is_nyras(kind, &name) || fs::metadata(entry.path()).is_err() {
                continue;
            }
            out.insert(format!("{kind}/{name}"));
        }
    }
    out
}

fn is_nyras(kind: &str, name: &str) -> bool {
    let rel = format!("{kind}/{name}");
    (kind == "skills" && (name == "synced" || BUNDLED.iter().any(|b| b.name == name)))
        || FILES.iter().any(|f| f.home == Home::Claude && f.rel == rel)
}

fn under(base: &Path, rel: &str) -> PathBuf {
    let (kind, name) = rel.split_once('/').unwrap_or((rel, ""));
    base.join(kind).join(name)
}

/// One entry, brought to where it should be. Returns what the record should
/// say about it afterwards: None is "not ours".
fn settle(paths: &Paths, rel: &str, ours: Option<Shared>, wanted: bool) -> Option<Shared> {
    let source = under(&paths.default, rel);
    let at = under(&paths.workspace, rel);
    let Ok(here) = fs::symlink_metadata(&at) else {
        // Nothing there: ours or not, it is made again if it is wanted.
        return if wanted { make(&source, &at) } else { None };
    };
    match ours {
        Some(Shared::Link) if here.file_type().is_symlink() => {
            if wanted || !take_back(&at, platform::remove_link) {
                Some(Shared::Link)
            } else {
                None
            }
        }
        Some(Shared::Copy { hash }) if here.is_file() && hash_file(&at).as_deref() == Some(hash.as_str()) => {
            if !wanted {
                return (!take_back(&at, |p| fs::remove_file(p))).then_some(Shared::Copy { hash });
            }
            // Unedited, so ours to keep current.
            match hash_file(&source) {
                Some(now) if now != hash => match fs::copy(&source, &at) {
                    Ok(_) => Some(Shared::Copy { hash: now }),
                    Err(e) => {
                        crate::logf!("Could not refresh {}: {e}", at.display());
                        Some(Shared::Copy { hash })
                    }
                },
                _ => Some(Shared::Copy { hash }),
            }
        }
        // A link we have no record of is ours only if it already points at
        // Default's entry: left by an earlier run whose record was lost.
        None if wanted && here.file_type().is_symlink() && same_file(&at, &source) => Some(Shared::Link),
        // Someone else's: a workspace's own entry, a link of their own, or one
        // of ours they replaced or edited.
        _ => None,
    }
}

/// Link `at` to `source`, or copy a file where no link can be made.
fn make(source: &Path, at: &Path) -> Option<Shared> {
    if let Some(parent) = at.parent() {
        if let Err(e) = fs::create_dir_all(parent) {
            crate::logf!("Could not create {}: {e}", parent.display());
            return None;
        }
    }
    match platform::link_to(source, at) {
        Ok(()) => Some(Shared::Link),
        // Never copy over something that appeared in the meantime: `fs::copy`
        // onto a link writes through it.
        Err(_) if source.is_file() && fs::symlink_metadata(at).is_err() => match fs::copy(source, at) {
            Ok(_) => hash_file(at).map(|hash| Shared::Copy { hash }),
            Err(e) => {
                crate::logf!("Could not copy {} into {}: {e}", source.display(), at.display());
                None
            }
        },
        Err(e) => {
            crate::logf!("Could not link {} into {}: {e}", source.display(), at.display());
            None
        }
    }
}

/// Remove one of ours; whether it went.
fn take_back(at: &Path, remove: impl Fn(&Path) -> std::io::Result<()>) -> bool {
    match remove(at) {
        Ok(()) => true,
        Err(e) => {
            crate::logf!("Could not remove {}: {e}", at.display());
            false
        }
    }
}

/// The import line in the workspace's CLAUDE.md, there or not. Returns whether
/// the line is ours afterwards.
fn settle_claude_md(paths: &Paths, ours: bool, on: bool) -> bool {
    let file = paths.workspace.join("CLAUDE.md");
    // A CLAUDE.md that is a link is someone's own arrangement, likely to
    // Default's file itself; writing to it would edit whatever it points at.
    if fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_symlink()) {
        return false;
    }
    let text = match fs::read_to_string(&file) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => {
            crate::logf!("Could not read {}: {e}", file.display());
            return ours;
        }
    };
    let has = text.lines().any(|l| l.trim() == IMPORT_LINE);
    let wanted = on && paths.default.join("CLAUDE.md").is_file();
    let written = match (wanted, has) {
        // There already, whether we added it or they did.
        (true, true) => return ours,
        (true, false) if text.is_empty() => fs::write(&file, format!("{IMPORT_LINE}\n")),
        (true, false) => fs::write(&file, format!("{IMPORT_LINE}\n\n{text}")),
        (false, true) if ours => match without_import(&text) {
            rest if rest.trim().is_empty() => fs::remove_file(&file),
            rest => fs::write(&file, rest),
        },
        _ => return false,
    };
    match written {
        Ok(()) => wanted,
        Err(e) => {
            crate::logf!("Could not update {}: {e}", file.display());
            ours
        }
    }
}

/// `text` without the import line we added, and the blank line after it.
fn without_import(text: &str) -> String {
    for prefix in [format!("{IMPORT_LINE}\n\n"), format!("{IMPORT_LINE}\n")] {
        if let Some(rest) = text.strip_prefix(&prefix) {
            return rest.to_string();
        }
    }
    // Moved by hand: take the line out wherever it is.
    let mut rest = text.lines().filter(|l| l.trim() != IMPORT_LINE).collect::<Vec<_>>().join("\n");
    if text.ends_with('\n') && !rest.is_empty() {
        rest.push('\n');
    }
    rest
}

fn same_file(a: &Path, b: &Path) -> bool {
    matches!((fs::canonicalize(a), fs::canonicalize(b)), (Ok(a), Ok(b)) if a == b)
}

fn hash_file(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(format!("{:x}", Sha256::digest(&bytes)))
}

fn read_record(path: &Path) -> Record {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_record(path: &Path, record: &Record) -> Result<(), String> {
    let body = serde_json::to_string_pretty(record).map_err(|e| e.to_string())?;
    fs::write(path, format!("{body}\n")).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Tmp(PathBuf);

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// A Default and a workspace side by side, the record where a real one
    /// keeps it.
    fn tmp(tag: &str) -> (Tmp, Paths) {
        let root = std::env::temp_dir().join(format!(
            "nyra-default-share-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let paths = Paths {
            default: root.join("home").join(".claude"),
            workspace: root.join("w1").join(".claude"),
            record: root.join("w1").join("default-share.json"),
        };
        fs::create_dir_all(&paths.default).unwrap();
        fs::create_dir_all(&paths.workspace).unwrap();
        (Tmp(root), paths)
    }

    fn put(base: &Path, rel: &str, content: &str) {
        let path = base.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    fn read(base: &Path, rel: &str) -> Option<String> {
        fs::read_to_string(base.join(rel)).ok()
    }

    fn exists(base: &Path, rel: &str) -> bool {
        fs::symlink_metadata(base.join(rel)).is_ok()
    }

    #[test]
    fn the_users_own_entries_are_shared_and_nyras_are_not() {
        let (_t, paths) = tmp("eligible");
        let d = &paths.default;
        put(d, "skills/mine/SKILL.md", "mine");
        put(d, "skills/mine/reference.md", "beside it");
        put(d, "skills/write-a-flow/SKILL.md", "bundled");
        put(d, "skills/synced/org/SKILL.md", "org");
        put(d, "skills/.trash/old/SKILL.md", "old");
        put(d, "agents/codex.md", "managed");
        put(d, "agents/helper.md", "helper");
        put(d, "commands/deploy.md", "deploy");
        put(d, "rules/style.md", "style");
        put(d, "output-styles/terse.md", "terse");

        reconcile(&paths);

        let w = &paths.workspace;
        assert_eq!(read(w, "skills/mine/SKILL.md").as_deref(), Some("mine"));
        assert_eq!(read(w, "skills/mine/reference.md").as_deref(), Some("beside it"));
        assert_eq!(read(w, "agents/helper.md").as_deref(), Some("helper"));
        assert_eq!(read(w, "commands/deploy.md").as_deref(), Some("deploy"));
        assert_eq!(read(w, "rules/style.md").as_deref(), Some("style"));
        assert_eq!(read(w, "output-styles/terse.md").as_deref(), Some("terse"));
        for rel in ["skills/write-a-flow", "skills/synced", "skills/.trash", "agents/codex.md"] {
            assert!(!exists(w, rel), "{rel} should not be shared");
        }
        assert_eq!(read_record(&paths.record).entries.len(), 5);
    }

    #[test]
    fn a_second_run_changes_nothing() {
        let (_t, paths) = tmp("idempotent");
        put(&paths.default, "skills/mine/SKILL.md", "mine");
        put(&paths.default, "CLAUDE.md", "rules");
        reconcile(&paths);
        let record = fs::read_to_string(&paths.record).unwrap();
        let claude_md = read(&paths.workspace, "CLAUDE.md");
        reconcile(&paths);
        assert_eq!(fs::read_to_string(&paths.record).unwrap(), record);
        assert_eq!(read(&paths.workspace, "CLAUDE.md"), claude_md);
    }

    #[test]
    fn an_edit_in_default_is_in_the_workspace() {
        let (_t, paths) = tmp("edit");
        put(&paths.default, "commands/deploy.md", "v1");
        reconcile(&paths);
        put(&paths.default, "commands/deploy.md", "v2");
        reconcile(&paths);
        assert_eq!(read(&paths.workspace, "commands/deploy.md").as_deref(), Some("v2"));
    }

    #[test]
    fn the_workspaces_own_entry_wins() {
        let (_t, paths) = tmp("own");
        put(&paths.default, "skills/mine/SKILL.md", "default's");
        put(&paths.workspace, "skills/mine/SKILL.md", "the workspace's");

        reconcile(&paths);
        assert_eq!(read(&paths.workspace, "skills/mine/SKILL.md").as_deref(), Some("the workspace's"));
        assert!(read_record(&paths.record).entries.is_empty());

        set_enabled_in(&paths, false).unwrap();
        reconcile(&paths);
        assert_eq!(read(&paths.workspace, "skills/mine/SKILL.md").as_deref(), Some("the workspace's"));
    }

    #[test]
    fn an_entry_gone_from_default_goes_from_the_workspace() {
        let (_t, paths) = tmp("gone");
        put(&paths.default, "skills/mine/SKILL.md", "mine");
        put(&paths.default, "commands/deploy.md", "deploy");
        reconcile(&paths);

        fs::remove_dir_all(paths.default.join("skills/mine")).unwrap();
        fs::remove_file(paths.default.join("commands/deploy.md")).unwrap();
        reconcile(&paths);

        assert!(!exists(&paths.workspace, "skills/mine"));
        assert!(!exists(&paths.workspace, "commands/deploy.md"));
        assert!(read_record(&paths.record).entries.is_empty());
    }

    #[test]
    fn a_link_removed_by_hand_comes_back() {
        let (_t, paths) = tmp("relink");
        put(&paths.default, "skills/mine/SKILL.md", "mine");
        reconcile(&paths);
        platform::remove_link(&paths.workspace.join("skills/mine")).unwrap();
        reconcile(&paths);
        assert_eq!(read(&paths.workspace, "skills/mine/SKILL.md").as_deref(), Some("mine"));
    }

    #[test]
    fn turning_it_off_takes_back_only_what_it_added() {
        let (_t, paths) = tmp("off");
        put(&paths.default, "skills/mine/SKILL.md", "mine");
        put(&paths.default, "CLAUDE.md", "global rules");
        put(&paths.workspace, "skills/own/SKILL.md", "own");
        put(&paths.workspace, "CLAUDE.md", "workspace rules\n");
        reconcile(&paths);
        assert!(exists(&paths.workspace, "skills/mine"));

        set_enabled_in(&paths, false).unwrap();
        reconcile(&paths);

        assert!(!exists(&paths.workspace, "skills/mine"));
        assert!(paths.default.join("skills/mine/SKILL.md").is_file(), "Default's own copy stays");
        assert_eq!(read(&paths.workspace, "skills/own/SKILL.md").as_deref(), Some("own"));
        assert_eq!(read(&paths.workspace, "CLAUDE.md").as_deref(), Some("workspace rules\n"));
    }

    #[test]
    fn claude_md_gets_one_import_line() {
        let (_t, paths) = tmp("import");
        put(&paths.default, "CLAUDE.md", "global rules");
        put(&paths.workspace, "CLAUDE.md", "workspace rules\n");

        reconcile(&paths);
        reconcile(&paths);
        assert_eq!(
            read(&paths.workspace, "CLAUDE.md").as_deref(),
            Some("@~/.claude/CLAUDE.md\n\nworkspace rules\n")
        );
    }

    #[test]
    fn a_workspace_without_claude_md_gets_one_holding_only_the_import() {
        let (_t, paths) = tmp("import-new");
        put(&paths.default, "CLAUDE.md", "global rules");
        reconcile(&paths);
        assert_eq!(read(&paths.workspace, "CLAUDE.md").as_deref(), Some("@~/.claude/CLAUDE.md\n"));

        // Default's goes, and so does the file we made for it.
        fs::remove_file(paths.default.join("CLAUDE.md")).unwrap();
        reconcile(&paths);
        assert!(!exists(&paths.workspace, "CLAUDE.md"));
    }

    #[test]
    fn nothing_to_import_writes_no_claude_md() {
        let (_t, paths) = tmp("import-none");
        reconcile(&paths);
        assert!(!exists(&paths.workspace, "CLAUDE.md"));
    }

    #[test]
    fn an_import_line_someone_wrote_is_never_removed() {
        let (_t, paths) = tmp("import-theirs");
        put(&paths.default, "CLAUDE.md", "global rules");
        put(&paths.workspace, "CLAUDE.md", "mine\n@~/.claude/CLAUDE.md\n");
        reconcile(&paths);
        set_enabled_in(&paths, false).unwrap();
        reconcile(&paths);
        assert_eq!(read(&paths.workspace, "CLAUDE.md").as_deref(), Some("mine\n@~/.claude/CLAUDE.md\n"));
    }

    #[test]
    fn an_import_line_moved_by_hand_still_comes_out() {
        assert_eq!(without_import("a\n@~/.claude/CLAUDE.md\nb\n"), "a\nb\n");
        assert_eq!(without_import("@~/.claude/CLAUDE.md\n\nkept\n"), "kept\n");
    }

    #[cfg(unix)]
    #[test]
    fn a_linked_claude_md_is_left_alone() {
        let (_t, paths) = tmp("import-link");
        put(&paths.default, "CLAUDE.md", "global rules");
        std::os::unix::fs::symlink(paths.default.join("CLAUDE.md"), paths.workspace.join("CLAUDE.md")).unwrap();
        reconcile(&paths);
        assert_eq!(read(&paths.default, "CLAUDE.md").as_deref(), Some("global rules"));
    }

    /// The copy a Windows machine without symlinks gets: kept current while
    /// nobody edits it, and the workspace's own once somebody does.
    #[test]
    fn a_copy_is_refreshed_until_someone_edits_it() {
        let (_t, paths) = tmp("copy");
        put(&paths.default, "commands/deploy.md", "v2");
        put(&paths.workspace, "commands/deploy.md", "v1");
        let mut record = Record::default();
        record
            .entries
            .insert("commands/deploy.md".into(), Shared::Copy { hash: hash_file(&paths.workspace.join("commands/deploy.md")).unwrap() });
        write_record(&paths.record, &record).unwrap();

        reconcile(&paths);
        assert_eq!(read(&paths.workspace, "commands/deploy.md").as_deref(), Some("v2"));

        put(&paths.workspace, "commands/deploy.md", "edited here");
        set_enabled_in(&paths, false).unwrap();
        reconcile(&paths);
        assert_eq!(read(&paths.workspace, "commands/deploy.md").as_deref(), Some("edited here"));
        assert!(read_record(&paths.record).entries.is_empty());
    }

    #[test]
    fn default_itself_is_never_a_workspace() {
        assert!(Paths::for_workspace(&util::home_dir().join(".claude")).is_none());
        assert!(Paths::for_workspace(Path::new("/tmp/elsewhere/.claude")).is_none());
    }
}
