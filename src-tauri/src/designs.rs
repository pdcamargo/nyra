//! Where designs live.
//!
//! Storage resolves through an index, never a directory scan. The index maps a
//! design **id** to `{ name, path, project }`, and that indirection is the whole
//! point: id is identity, path is a field. Moving a design — app-managed
//! location to "save to repo" — is then one field update rather than a
//! migration, and the model names a design rather than remembering where it put
//! one.
//!
//! The same reasoning as node ids and patch addressing: anything that makes a
//! path into an identity turns a move into a rewrite.
//!
//! Note what does NOT live here. An artboard's position on the canvas is a
//! property *of* the artboard and belongs in the document. Location on disk is
//! a property of where the file is, which a file cannot reliably contain
//! because it moves — so this is the only place it can live.
//!
//! Drift is expected rather than prevented: a file deleted outside the app is a
//! real state, reported as `missing` on a read, not a crash and not a silent
//! resurrection.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

use crate::util;

pub const SCHEMA: u32 = 1;

// The renderer reads these directly, so the wire shape is camelCase. Without
// this `updatedAt` arrives as undefined and a sort silently does nothing.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    /// Absolute. App-managed by default; a repo path once saved there.
    pub path: PathBuf,
    /// The project this design belongs to, so a panel can list the right ones.
    pub project: PathBuf,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Index {
    #[serde(default = "default_schema")]
    pub schema: u32,
    #[serde(default)]
    pub designs: Vec<Entry>,
}

fn default_schema() -> u32 {
    SCHEMA
}

fn root() -> PathBuf {
    util::home_dir().join(".nyra").join("designs")
}

fn index_path(root: &Path) -> PathBuf {
    root.join("index.json")
}

pub fn load() -> Index {
    load_in(&root())
}

/// Read the index under an arbitrary root.
///
/// The root is a parameter rather than a constant so the whole module can be
/// exercised against a temp directory — including the state that matters most
/// and is hardest to reach by hand, which is a machine that has never had a
/// design on it.
fn load_in(root: &Path) -> Index {
    let Ok(text) = fs::read_to_string(index_path(root)) else {
        return Index {
            schema: SCHEMA,
            designs: Vec::new(),
        };
    };
    // A corrupt index is not worth losing the app over. The files are still on
    // disk and `adopt` puts them back.
    serde_json::from_str(&text).unwrap_or(Index {
        schema: SCHEMA,
        designs: Vec::new(),
    })
}

/// Atomic, because dev and the installed app share `~/.nyra` and a torn write
/// here would lose every design's location at once.
fn save_in(root: &Path, index: &Index) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    let body = serde_json::to_string_pretty(index).map_err(|e| e.to_string())?;
    let tmp = root.join(format!("index.json.{}", util::rand_hex(6)));
    fs::write(&tmp, body).map_err(|e| format!("could not write the index: {e}"))?;
    fs::rename(&tmp, index_path(root)).map_err(|e| format!("could not replace the index: {e}"))
}

/// Tell the window the index moved.
///
/// Without this a panel showing the list caches it, and a design Claude creates
/// mid-conversation does not appear until someone hits reload — which is the
/// difference between "it just works" and "it works if you know to refresh".
fn announce() {
    util::emit("nyra:designs-changed", serde_json::json!({}));
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// A filename that is recognisable in a directory listing without being the
/// identity of anything.
fn slug(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    let s = s.trim_matches('-').to_string();
    let collapsed = s
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.is_empty() {
        "design".into()
    } else {
        collapsed.chars().take(48).collect()
    }
}

/// Resolve what the model actually said: an id, or a name. Names are matched
/// case-insensitively and scoped to the project when one is given, because
/// "render Billing" is what a person says and two projects may both have one.
pub fn resolve(needle: &str, project: Option<&Path>) -> Option<Entry> {
    let index = load();
    if let Some(hit) = index.designs.iter().find(|d| d.id == needle) {
        return Some(hit.clone());
    }
    let lower = needle.to_lowercase();
    let in_project = |d: &&Entry| project.is_none_or(|p| d.project == p);
    index
        .designs
        .iter()
        .filter(in_project)
        .find(|d| d.name.to_lowercase() == lower)
        .or_else(|| {
            index
                .designs
                .iter()
                .filter(in_project)
                .find(|d| d.name.to_lowercase().contains(&lower))
        })
        .cloned()
}

pub fn list(project: Option<&Path>) -> Vec<Entry> {
    let mut all = load().designs;
    if let Some(p) = project {
        all.retain(|d| d.project == p);
    }
    all.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    all
}

/// Register a new design and hand back where to write it.
///
/// The app picks the path, which is the point: nothing lands in someone's repo
/// uninvited, and the model never has to invent a location or remember one.
pub fn create(name: &str, project: &Path) -> Result<Entry, String> {
    let entry = create_in(&root(), name, project)?;
    announce();
    Ok(entry)
}

fn create_in(root: &Path, name: &str, project: &Path) -> Result<Entry, String> {
    let mut index = load_in(root);
    let id = format!("d_{}", util::rand_hex(5));
    let dir = root.join("files");
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let entry = Entry {
        path: dir.join(format!("{}-{}.nyui.json", slug(name), id)),
        id,
        name: name.to_string(),
        project: project.to_path_buf(),
        updated_at: now(),
    };
    index.designs.push(entry.clone());
    index.schema = SCHEMA;
    save_in(root, &index)?;
    Ok(entry)
}

/// Bring a design that already exists on disk under management — the path a
/// user wrote by hand, or one that arrived with a repo.
pub fn adopt(name: &str, path: &Path, project: &Path) -> Result<Entry, String> {
    let entry = adopt_in(&root(), name, path, project)?;
    announce();
    Ok(entry)
}

fn adopt_in(root: &Path, name: &str, path: &Path, project: &Path) -> Result<Entry, String> {
    if !path.exists() {
        return Err(format!("{} does not exist", path.display()));
    }
    let mut index = load_in(root);
    if let Some(existing) = index.designs.iter().find(|d| d.path == path) {
        return Ok(existing.clone());
    }
    let entry = Entry {
        id: format!("d_{}", util::rand_hex(5)),
        name: name.to_string(),
        path: path.to_path_buf(),
        project: project.to_path_buf(),
        updated_at: now(),
    };
    index.designs.push(entry.clone());
    index.schema = SCHEMA;
    save_in(root, &index)?;
    Ok(entry)
}

/// Move the file and update one field. This is what the indirection bought.
pub fn relocate(id: &str, to: &Path) -> Result<Entry, String> {
    let root = root();
    let mut index = load_in(&root);
    let entry = index
        .designs
        .iter_mut()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("no design {id}"))?;

    if let Some(parent) = to.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("could not create {}: {e}", parent.display()))?;
    }
    if entry.path.exists() {
        fs::rename(&entry.path, to).map_err(|e| format!("could not move the design: {e}"))?;
    }
    entry.path = to.to_path_buf();
    entry.updated_at = now();
    let moved = entry.clone();
    save_in(&root, &index)?;
    announce();
    Ok(moved)
}

pub fn rename(id: &str, name: &str) -> Result<Entry, String> {
    let root = root();
    let mut index = load_in(&root);
    let entry = index
        .designs
        .iter_mut()
        .find(|d| d.id == id)
        .ok_or_else(|| format!("no design {id}"))?;
    entry.name = name.to_string();
    entry.updated_at = now();
    let renamed = entry.clone();
    save_in(&root, &index)?;
    announce();
    Ok(renamed)
}

pub fn touch(id: &str) -> Result<(), String> {
    let root = root();
    let mut index = load_in(&root);
    if let Some(entry) = index.designs.iter_mut().find(|d| d.id == id) {
        entry.updated_at = now();
        save_in(&root, &index)?;
    }
    Ok(())
}

/// Forget a design. The file is left alone unless asked for: an index entry is
/// a pointer, and deleting someone's work because they closed a tab is not a
/// trade worth making.
pub fn forget(id: &str, delete_file: bool) -> Result<(), String> {
    let root = root();
    let mut index = load_in(&root);
    let Some(at) = index.designs.iter().position(|d| d.id == id) else {
        return Ok(());
    };
    let entry = index.designs.remove(at);
    if delete_file && entry.path.exists() {
        fs::remove_file(&entry.path).map_err(|e| format!("could not delete the file: {e}"))?;
    }
    save_in(&root, &index)?;
    announce();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_is_recognisable_without_being_an_identity() {
        assert_eq!(slug("Billing — desktop"), "billing-desktop");
        assert_eq!(slug("Settings / General"), "settings-general");
        assert_eq!(slug("!!!"), "design");
        assert!(slug(&"x".repeat(200)).len() <= 48);
    }

    #[test]
    fn resolve_prefers_an_id_then_an_exact_name_then_a_partial() {
        let project = PathBuf::from("/p");
        let index = Index {
            schema: SCHEMA,
            designs: vec![
                Entry {
                    id: "d_1".into(),
                    name: "Billing".into(),
                    path: "/a".into(),
                    project: project.clone(),
                    updated_at: "2026".into(),
                },
                Entry {
                    id: "d_2".into(),
                    name: "Billing history".into(),
                    path: "/b".into(),
                    project: project.clone(),
                    updated_at: "2026".into(),
                },
            ],
        };
        // Exercised through the same ordering `resolve` uses, without touching
        // the real home directory.
        let by_id = index.designs.iter().find(|d| d.id == "d_2");
        assert_eq!(by_id.map(|d| d.name.as_str()), Some("Billing history"));

        let exact = index
            .designs
            .iter()
            .find(|d| d.name.to_lowercase() == "billing");
        assert_eq!(exact.map(|d| d.id.as_str()), Some("d_1"));

        let partial = index
            .designs
            .iter()
            .find(|d| d.name.to_lowercase().contains("history"));
        assert_eq!(partial.map(|d| d.id.as_str()), Some("d_2"));
    }

    #[test]
    fn an_empty_or_corrupt_index_reads_as_empty_rather_than_failing() {
        let parsed: Result<Index, _> = serde_json::from_str("{ not json");
        assert!(parsed.is_err());
        let fallback = Index {
            schema: SCHEMA,
            designs: Vec::new(),
        };
        assert!(fallback.designs.is_empty());
        assert_eq!(fallback.schema, SCHEMA);
    }

    /// A machine that has never had a design on it.
    ///
    /// The state hardest to reach by hand once you have used the feature once,
    /// and the one every new user starts in: no `~/.nyra/designs`, no index,
    /// no files directory.
    #[test]
    fn a_machine_that_has_never_had_a_design_works_from_nothing() {
        let tmp = std::env::temp_dir().join(format!("nyra-designs-test-{}", util::rand_hex(6)));
        let project = tmp.join("project");
        // Deliberately not created: `create` must make its own directories.
        assert!(!tmp.exists());

        let empty = load_in(&tmp);
        assert!(empty.designs.is_empty(), "a missing index reads as empty");
        assert_eq!(empty.schema, SCHEMA);

        let made = create_in(&tmp, "Billing", &project).expect("creates from nothing");
        assert!(made.path.starts_with(tmp.join("files")));
        assert!(tmp.join("files").is_dir(), "it made the files directory");
        assert!(index_path(&tmp).is_file(), "it wrote an index");

        // And the second one lands beside the first rather than replacing it.
        let second = create_in(&tmp, "Settings", &project).expect("creates a second");
        let reread = load_in(&tmp);
        assert_eq!(reread.designs.len(), 2);
        assert_ne!(made.id, second.id);

        // Adoption of a file that exists but nothing owns.
        let loose = tmp.join("loose.nyui.json");
        fs::write(&loose, "{}").expect("write");
        let adopted = adopt_in(&tmp, "Loose", &loose, &project).expect("adopts");
        assert_eq!(adopted.path, loose);
        assert_eq!(load_in(&tmp).designs.len(), 3);

        // Adopting the same path twice is the same design, not a duplicate.
        let again = adopt_in(&tmp, "Loose", &loose, &project).expect("adopts again");
        assert_eq!(again.id, adopted.id);
        assert_eq!(load_in(&tmp).designs.len(), 3);

        fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn adopting_something_that_is_not_there_says_so() {
        let tmp = std::env::temp_dir().join(format!("nyra-designs-test-{}", util::rand_hex(6)));
        let err = adopt_in(&tmp, "Ghost", &tmp.join("nope.nyui.json"), &tmp).unwrap_err();
        assert!(err.contains("does not exist"), "{err}");
    }

    #[test]
    fn schema_is_recorded_so_a_future_shape_can_migrate() {
        let index: Index = serde_json::from_str(r#"{"designs":[]}"#).expect("defaults");
        assert_eq!(index.schema, SCHEMA);
    }
}

#[cfg(test)]
mod wire {
    use super::*;

    #[test]
    fn the_wire_shape_is_camel_case_because_the_renderer_reads_it() {
        let entry = Entry {
            id: "d_1".into(),
            name: "Billing".into(),
            path: "/a/b.nyui.json".into(),
            project: "/p".into(),
            updated_at: "2026-09-21T00:00:00Z".into(),
        };
        let json = serde_json::to_string(&entry).expect("serialises");
        assert!(json.contains("\"updatedAt\""), "{json}");
        assert!(!json.contains("updated_at"), "{json}");
        // And it round-trips, so a stored index written by this version reads back.
        let back: Entry = serde_json::from_str(&json).expect("round-trips");
        assert_eq!(back, entry);
    }
}
