//! Skills Nyra ships, installs into `~/.claude/skills`, and keeps current.
//!
//! Flows are useless if the model has never heard of them, and the schema is
//! too long to carry in every system prompt. A skill is the right shape: it
//! loads only when someone asks for a flow. But a skill is a file in the user's
//! home directory, which makes this a sync problem rather than a copy.
//!
//! Three rules, in the order they matter:
//!
//! 1. **A file we wrote, unchanged, is ours to update.** We record the hash of
//!    the bytes we wrote. If the file still hashes to that, nobody has touched
//!    it, so shipping a new version overwrites it silently.
//! 2. **A file anyone edited is theirs forever.** The moment the hash diverges
//!    we mark it adopted and never write to that path again. Losing someone's
//!    edits to a file they own is worse than shipping them a stale skill.
//! 3. **A deletion is an answer.** If we installed it and it is gone, the user
//!    said no. We record that and stop, rather than resurrecting it on every
//!    launch. `restore()` is the way back, so the decision stays reversible.
//!
//! The bundled copy is this repo's own `.claude/skills/<name>/SKILL.md`, pulled
//! in with `include_str!`. One file serves both jobs, so the copy we develop
//! against and the copy we ship cannot drift.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::util;

/// A skill compiled into the binary.
pub struct Bundled {
    pub name: &'static str,
    pub content: &'static str,
}

pub const BUNDLED: &[Bundled] = &[
    Bundled {
        name: "write-a-flow",
        content: include_str!("../../.claude/skills/write-a-flow/SKILL.md"),
    },
    // The app's own geography. Split from `write-a-flow` because the questions
    // are different — one is "compose a graph", the other is "what is this
    // panel called and where does Nyra keep things" — and a skill loads on its
    // description, so two narrow ones fire more accurately than one wide one.
    Bundled {
        name: "nyra-app",
        content: include_str!("../../.claude/skills/nyra-app/SKILL.md"),
    },
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Status {
    /// We wrote it, and it is still byte-for-byte what we wrote.
    Managed,
    /// Edited by someone, or already present the first time we looked. Ours to
    /// read and never to write.
    Adopted,
    /// We installed it once; it is gone. Left gone until `restore()`.
    Removed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Record {
    pub status: Status,
    /// sha256 of the bytes we last wrote (`Managed`) or last saw (`Adopted`).
    #[serde(default)]
    pub hash: String,
}

type State = BTreeMap<String, Record>;

/// What `sync` should do about one skill. Split out from the IO so the rule —
/// the part that can quietly destroy someone's work — is directly testable.
#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    /// Never seen before: write it.
    Install,
    /// Ours, untouched, and we now ship different bytes: overwrite.
    Update,
    /// Already exactly what we ship, however it got there. Record only.
    MarkManaged,
    /// Someone else's content. Record only; never write this path again.
    Adopt(String),
    /// We installed it and it is gone. Record only.
    MarkRemoved,
    Nothing,
}

fn sha256(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    format!("{:x}", h.finalize())
}

pub fn decide(disk: Option<&str>, record: Option<&Record>, bundled_hash: &str) -> Action {
    let Some(disk) = disk else {
        return match record {
            None => Action::Install,
            // Already recorded as gone — do not keep re-deciding it.
            Some(r) if r.status == Status::Removed => Action::Nothing,
            Some(_) => Action::MarkRemoved,
        };
    };

    let on_disk = sha256(disk);

    // Identical to what we ship. Reached when the state file was lost, or when
    // someone edited the skill and then undid it. Either way there is nothing
    // to write and it is safe to call ours again.
    if on_disk == bundled_hash {
        return match record {
            Some(r) if r.status == Status::Managed && r.hash == bundled_hash => Action::Nothing,
            _ => Action::MarkManaged,
        };
    }

    match record {
        // Ours, untouched since we wrote it, and the bundle has moved on.
        Some(r) if r.status == Status::Managed && r.hash == on_disk => Action::Update,
        // Already known to be theirs, and the content has not changed since we
        // last looked — nothing to re-record.
        Some(r) if r.status == Status::Adopted && r.hash == on_disk => Action::Nothing,
        // Everything else is content we did not write: adopt it.
        _ => Action::Adopt(on_disk),
    }
}

/// Where the two files live. Passed in rather than read from `$HOME` so the
/// tests can exercise the real read/decide/write loop — the part that can
/// overwrite someone's file — against a temp directory.
pub struct Paths {
    pub skills_root: PathBuf,
    pub state_file: PathBuf,
}

impl Paths {
    fn real() -> Self {
        Self {
            skills_root: util::home_dir().join(".claude").join("skills"),
            state_file: util::home_dir().join(".nyra").join("managed-skills.json"),
        }
    }

    fn skill(&self, name: &str) -> PathBuf {
        self.skills_root.join(name).join("SKILL.md")
    }
}

async fn read_state(paths: &Paths) -> State {
    match tokio::fs::read_to_string(&paths.state_file).await {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(_) => State::new(),
    }
}

async fn write_state(paths: &Paths, state: &State) {
    if let Some(dir) = paths.state_file.parent() {
        if tokio::fs::create_dir_all(dir).await.is_err() {
            return;
        }
    }
    match serde_json::to_string_pretty(state) {
        Ok(raw) => {
            if let Err(e) = tokio::fs::write(&paths.state_file, raw).await {
                crate::logf!("managed-skills: could not record state: {e}");
            }
        }
        Err(e) => crate::logf!("managed-skills: could not serialise state: {e}"),
    }
}

async fn write_skill(paths: &Paths, name: &str, content: &str) -> Result<(), String> {
    let path = paths.skill(name);
    if let Some(dir) = path.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| e.to_string())?;
    }
    tokio::fs::write(&path, content)
        .await
        .map_err(|e| e.to_string())
}

/// Bring `~/.claude/skills` in line with what this build ships. Safe to call on
/// every launch; it writes only when rule 1 above says it may.
pub async fn sync() {
    sync_in(&Paths::real(), BUNDLED).await
}

async fn sync_in(paths: &Paths, bundled: &[Bundled]) {
    let mut state = read_state(paths).await;
    let mut dirty = false;

    for skill in bundled {
        let bundled_hash = sha256(skill.content);
        let disk = tokio::fs::read_to_string(paths.skill(skill.name)).await.ok();
        let action = decide(disk.as_deref(), state.get(skill.name), &bundled_hash);

        let record = match action {
            Action::Nothing => continue,
            Action::Install | Action::Update => {
                if let Err(e) = write_skill(paths, skill.name, skill.content).await {
                    crate::logf!("managed-skills: could not write {}: {e}", skill.name);
                    continue;
                }
                crate::logf!(
                    "managed-skills: {} {}",
                    if action == Action::Install {
                        "installed"
                    } else {
                        "updated"
                    },
                    skill.name
                );
                Record {
                    status: Status::Managed,
                    hash: bundled_hash,
                }
            }
            Action::MarkManaged => Record {
                status: Status::Managed,
                hash: bundled_hash,
            },
            Action::Adopt(hash) => {
                crate::logf!(
                    "managed-skills: {} was edited — leaving it alone from now on",
                    skill.name
                );
                Record {
                    status: Status::Adopted,
                    hash,
                }
            }
            Action::MarkRemoved => {
                crate::logf!(
                    "managed-skills: {} was deleted — not reinstalling it",
                    skill.name
                );
                Record {
                    status: Status::Removed,
                    hash: String::new(),
                }
            }
        };

        state.insert(skill.name.to_string(), record);
        dirty = true;
    }

    if dirty {
        write_state(paths, &state).await;
    }
}

/// Put one bundled skill back, whatever its current state. This is the way out
/// of both `Removed` and `Adopted`, so neither is a one-way door.
///
/// Deliberately one skill rather than all of them: restoring a deleted skill
/// must not overwrite a *different* skill the user has customised.
pub async fn restore(name: &str) -> Result<(), String> {
    restore_in(&Paths::real(), BUNDLED, name).await
}

async fn restore_in(paths: &Paths, bundled: &[Bundled], name: &str) -> Result<(), String> {
    let skill = bundled
        .iter()
        .find(|s| s.name == name)
        .ok_or_else(|| format!("{name} is not a skill Nyra ships"))?;

    write_skill(paths, skill.name, skill.content).await?;

    let mut state = read_state(paths).await;
    state.insert(
        skill.name.to_string(),
        Record {
            status: Status::Managed,
            hash: sha256(skill.content),
        },
    );
    write_state(paths, &state).await;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledStatus {
    pub name: String,
    pub status: Status,
}

/// What this build ships and where each one stands, so the skills list can say
/// more than "Nyra put this here". The distinction that matters to a reader is
/// `managed` (we keep it current) versus `adopted` (you edited it, so we stopped)
/// — nothing else in the app records that, and silently stale is a bad surprise.
pub async fn bundled_status() -> Vec<BundledStatus> {
    bundled_status_in(&Paths::real(), BUNDLED).await
}

async fn bundled_status_in(paths: &Paths, bundled: &[Bundled]) -> Vec<BundledStatus> {
    let state = read_state(paths).await;
    bundled
        .iter()
        .map(|skill| BundledStatus {
            name: skill.name.to_string(),
            // No record yet means sync has not run this launch. We intend to
            // manage it, so that is the honest default.
            status: state
                .get(skill.name)
                .map(|r| r.status)
                .unwrap_or(Status::Managed),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUNDLE: &str = "shipped v2";

    fn hash(s: &str) -> String {
        sha256(s)
    }

    fn managed(of: &str) -> Record {
        Record {
            status: Status::Managed,
            hash: hash(of),
        }
    }

    #[test]
    fn installs_when_nothing_is_there() {
        assert_eq!(decide(None, None, &hash(BUNDLE)), Action::Install);
    }

    #[test]
    fn updates_a_file_we_wrote_and_nobody_touched() {
        // On disk is exactly the v1 we recorded writing; the bundle is now v2.
        let record = managed("shipped v1");
        assert_eq!(
            decide(Some("shipped v1"), Some(&record), &hash(BUNDLE)),
            Action::Update
        );
    }

    #[test]
    fn never_overwrites_an_edited_skill() {
        // We wrote v1; the file no longer hashes to it.
        let record = managed("shipped v1");
        let action = decide(Some("shipped v1 + my notes"), Some(&record), &hash(BUNDLE));
        assert_eq!(action, Action::Adopt(hash("shipped v1 + my notes")));
    }

    #[test]
    fn an_adopted_skill_stays_adopted_when_a_new_version_ships() {
        let record = Record {
            status: Status::Adopted,
            hash: hash("mine"),
        };
        // Nothing changed on disk since we adopted it, so there is nothing to do —
        // and critically, not an Update.
        assert_eq!(decide(Some("mine"), Some(&record), &hash(BUNDLE)), Action::Nothing);
    }

    #[test]
    fn adopts_a_file_that_was_already_there() {
        // No record: someone wrote their own write-a-flow before we ever ran.
        assert_eq!(
            decide(Some("theirs"), None, &hash(BUNDLE)),
            Action::Adopt(hash("theirs"))
        );
    }

    #[test]
    fn a_deletion_is_recorded_and_then_respected() {
        let record = managed(BUNDLE);
        assert_eq!(decide(None, Some(&record), &hash(BUNDLE)), Action::MarkRemoved);

        // Next launch: still gone, and we leave it gone.
        let removed = Record {
            status: Status::Removed,
            hash: String::new(),
        };
        assert_eq!(decide(None, Some(&removed), &hash(BUNDLE)), Action::Nothing);
    }

    #[test]
    fn reclaims_a_file_identical_to_ours_when_the_state_file_is_lost() {
        // ~/.nyra wiped, skill still present and unmodified.
        assert_eq!(decide(Some(BUNDLE), None, &hash(BUNDLE)), Action::MarkManaged);
    }

    #[test]
    fn an_edit_undone_becomes_ours_again() {
        let record = Record {
            status: Status::Adopted,
            hash: hash("mine"),
        };
        assert_eq!(
            decide(Some(BUNDLE), Some(&record), &hash(BUNDLE)),
            Action::MarkManaged
        );
    }

    #[test]
    fn steady_state_writes_nothing() {
        let record = managed(BUNDLE);
        assert_eq!(decide(Some(BUNDLE), Some(&record), &hash(BUNDLE)), Action::Nothing);
    }

    // --- The loop itself, against a real temp directory. `decide` above is the
    // rule; these cover the plumbing that actually overwrites files.

    struct Tmp(PathBuf);

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn tmp_paths(tag: &str) -> (Tmp, Paths) {
        let root = std::env::temp_dir().join(format!(
            "nyra-managed-skills-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let paths = Paths {
            skills_root: root.join("skills"),
            state_file: root.join("state.json"),
        };
        (Tmp(root), paths)
    }

    fn bundle(content: &'static str) -> Vec<Bundled> {
        vec![Bundled {
            name: "write-a-flow",
            content,
        }]
    }

    fn on_disk(paths: &Paths) -> Option<String> {
        std::fs::read_to_string(paths.skill("write-a-flow")).ok()
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn installs_then_updates_across_two_launches() {
        let (_tmp, paths) = tmp_paths("update");
        rt().block_on(async {
            sync_in(&paths, &bundle("v1")).await;
            assert_eq!(on_disk(&paths).as_deref(), Some("v1"), "first launch installs");

            // A later build ships different bytes; nobody touched the file.
            sync_in(&paths, &bundle("v2")).await;
            assert_eq!(on_disk(&paths).as_deref(), Some("v2"), "second launch updates");
        });
    }

    #[test]
    fn an_edit_survives_every_future_launch() {
        let (_tmp, paths) = tmp_paths("edit");
        rt().block_on(async {
            sync_in(&paths, &bundle("v1")).await;

            std::fs::write(paths.skill("write-a-flow"), "my own version").unwrap();

            // Two more launches, one of them shipping a new version.
            sync_in(&paths, &bundle("v1")).await;
            sync_in(&paths, &bundle("v2")).await;

            assert_eq!(
                on_disk(&paths).as_deref(),
                Some("my own version"),
                "an edited skill must never be overwritten"
            );
        });
    }

    #[test]
    fn a_deleted_skill_stays_deleted_even_when_a_new_version_ships() {
        let (_tmp, paths) = tmp_paths("delete");
        rt().block_on(async {
            sync_in(&paths, &bundle("v1")).await;
            std::fs::remove_dir_all(paths.skills_root.join("write-a-flow")).unwrap();

            sync_in(&paths, &bundle("v1")).await;
            sync_in(&paths, &bundle("v2")).await;

            assert!(on_disk(&paths).is_none(), "a deletion is an answer");
        });
    }

    #[test]
    fn restore_brings_back_a_deleted_skill_and_resumes_updating_it() {
        let (_tmp, paths) = tmp_paths("restore");
        rt().block_on(async {
            sync_in(&paths, &bundle("v1")).await;
            std::fs::remove_dir_all(paths.skills_root.join("write-a-flow")).unwrap();
            sync_in(&paths, &bundle("v1")).await; // records Removed

            restore_in(&paths, &bundle("v1"), "write-a-flow").await.unwrap();
            assert_eq!(on_disk(&paths).as_deref(), Some("v1"), "restore reinstalls");

            // And it is managed again, not stuck.
            sync_in(&paths, &bundle("v2")).await;
            assert_eq!(on_disk(&paths).as_deref(), Some("v2"), "updates resume after restore");
        });
    }

    #[test]
    fn restore_rescues_a_customised_skill_too() {
        let (_tmp, paths) = tmp_paths("restore-edit");
        rt().block_on(async {
            sync_in(&paths, &bundle("v1")).await;
            std::fs::write(paths.skill("write-a-flow"), "mine").unwrap();
            sync_in(&paths, &bundle("v1")).await; // records Adopted

            restore_in(&paths, &bundle("v1"), "write-a-flow").await.unwrap();
            assert_eq!(on_disk(&paths).as_deref(), Some("v1"));

            sync_in(&paths, &bundle("v2")).await;
            assert_eq!(on_disk(&paths).as_deref(), Some("v2"), "adopted is not a one-way door");
        });
    }

    #[test]
    fn reports_adopted_so_the_ui_can_say_updates_stopped() {
        let (_tmp, paths) = tmp_paths("status");
        rt().block_on(async {
            sync_in(&paths, &bundle("v1")).await;
            assert_eq!(
                bundled_status_in(&paths, &bundle("v1")).await[0].status,
                Status::Managed
            );

            std::fs::write(paths.skill("write-a-flow"), "mine").unwrap();
            sync_in(&paths, &bundle("v1")).await;

            assert_eq!(
                bundled_status_in(&paths, &bundle("v1")).await[0].status,
                Status::Adopted
            );
        });
    }

    #[test]
    fn restore_refuses_a_name_we_do_not_ship() {
        let (_tmp, paths) = tmp_paths("restore-unknown");
        rt().block_on(async {
            let err = restore_in(&paths, &bundle("v1"), "../../etc/passwd")
                .await
                .unwrap_err();
            assert!(err.contains("not a skill Nyra ships"), "got: {err}");
        });
    }

    #[test]
    fn the_bundled_skill_has_usable_frontmatter() {
        // include_str! means a broken skill ships silently otherwise.
        for skill in BUNDLED {
            assert!(
                skill.content.starts_with("---\n"),
                "{} has no frontmatter",
                skill.name
            );
            assert!(
                skill.content.contains(&format!("name: {}", skill.name)),
                "{} frontmatter name does not match its directory",
                skill.name
            );
            assert!(
                skill.content.contains("description:"),
                "{} has no description, so it will never trigger",
                skill.name
            );
        }
    }
}
