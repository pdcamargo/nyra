//! Questionnaires: questions Claude asks to shape a design, and the answers.
//!
//! Kept on disk, one file each, so they outlive the tab they are answered in,
//! the chat that asked, and a restart: closing the tab, quitting Nyra or asking
//! "open the questionnaire again" all come back to the same answers. Never in
//! the user's repo — `~/.nyra/designs/questionnaires/`.
//!
//! Asking does not block Claude. The questions are written here, the tab opens,
//! and Claude ends its turn; the answers arrive later as a user message. A tool
//! that waited would hold the turn for as long as someone takes to think, and
//! would lose everything on a restart.
//!
//! Questions are kept as the JSON Claude sent, with only what the UI cannot do
//! without checked here. The renderer reads the rest leniently.
//!
//! Files someone adds to an answer (a logo, a screenshot) are copied into a
//! folder named after the questionnaire, so the answer still points at them
//! after the original is moved or deleted.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::util;

fn dir() -> PathBuf {
    util::home_dir().join(".nyra").join("designs").join("questionnaires")
}

fn file_of(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.json"))
}

fn valid_id(id: &str) -> bool {
    id.starts_with("q_") && id.len() <= 40 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn announce(id: &str) {
    util::emit("nyra:questionnaires-changed", json!({ "id": id }));
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn get(id: &str) -> Option<Value> {
    get_in(&dir(), id)
}

fn get_in(root: &Path, id: &str) -> Option<Value> {
    if !valid_id(id) {
        return None;
    }
    fs::read_to_string(file_of(root, id)).ok().and_then(|t| serde_json::from_str(&t).ok())
}

fn save_in(root: &Path, q: &Value) -> Result<(), String> {
    let id = q.get("id").and_then(Value::as_str).ok_or("a questionnaire needs an id")?;
    fs::create_dir_all(root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    let tmp = root.join(format!(".{id}.{}", util::rand_hex(4)));
    fs::write(&tmp, serde_json::to_string_pretty(q).map_err(|e| e.to_string())?)
        .map_err(|e| format!("could not write the questionnaire: {e}"))?;
    fs::rename(&tmp, file_of(root, id)).map_err(|e| format!("could not save the questionnaire: {e}"))
}

/// Give every question an id, and the fields the UI keys on a sane value.
/// Returns an error naming the first question that cannot be shown at all.
fn normalise(questions: &[Value], taken: &mut std::collections::HashSet<String>) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    for (i, q) in questions.iter().enumerate() {
        let Some(obj) = q.as_object() else {
            return Err(format!("question {} is not an object", i + 1));
        };
        let text = obj.get("question").and_then(Value::as_str).unwrap_or("").trim();
        if text.is_empty() {
            return Err(format!("question {} has no \"question\" text", i + 1));
        }
        let mut q = obj.clone();
        let id = q
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .filter(|id| !id.is_empty() && !taken.contains(id))
            .unwrap_or_else(|| {
                let mut n = taken.len() + 1;
                while taken.contains(&format!("q{n}")) {
                    n += 1;
                }
                format!("q{n}")
            });
        taken.insert(id.clone());
        q.insert("id".into(), json!(id));
        let has_options = q.get("options").and_then(Value::as_array).is_some_and(|o| !o.is_empty());
        let kind = q.get("kind").and_then(Value::as_str).unwrap_or(if has_options { "single" } else { "text" });
        let kind = match kind {
            "single" | "multi" | "text" | "scale" | "color" | "files" => kind,
            _ if has_options => "single",
            _ => "text",
        };
        if matches!(kind, "single" | "multi") && !has_options {
            return Err(format!("question {} (\"{text}\") is {kind} but has no options", i + 1));
        }
        q.insert("kind".into(), json!(kind));
        out.push(Value::Object(q));
    }
    Ok(out)
}

/// What a new design system's questionnaire always asks, whatever else Claude
/// does: what the product is and what to work from, then — in a git repo —
/// where the system lives. One open question closes it, after Claude's own.
fn system_brief(in_repo: bool, project: &str) -> (Vec<Value>, Vec<Value>) {
    let mut head = vec![
        json!({
            "id": "about", "section": "Brief", "chip": "Product", "kind": "text", "handBack": false,
            "question": "Tell me about the company and the product",
            "placeholder": "Who it is for, what it does, and how it should feel"
        }),
        json!({
            "id": "references", "section": "Brief", "chip": "Logo and references", "kind": "files",
            "question": "Add a logo, and anything else to work from",
            "placeholder": "Screenshots, brand guidelines, fonts, a product you like"
        }),
    ];
    if in_repo {
        let folder = Path::new(project).file_name().and_then(|n| n.to_str()).unwrap_or("repo");
        head.push(json!({
            "id": "location", "section": "Where it lives", "chip": "Location", "kind": "single", "handBack": "decide",
            "question": "Where should the design system live?",
            "why": format!("{folder} is a git repo, so the system can travel with the code"),
            "options": [
                { "label": "In this repo", "icon": "folder-git-2", "detail": format!("{folder}/design"), "suggested": true,
                  "description": "Committed with the code. Teammates, and Claude Code outside Nyra, get it too." },
                { "label": "In Nyra", "icon": "hard-drive", "detail": "~/.nyra/designs/systems",
                  "description": "Nothing is added to the repo. You can move it in later." }
            ]
        }));
    }
    let tail = vec![json!({
        "id": "notes", "section": "Anything else", "kind": "text", "handBack": false,
        "question": "Anything else I should know?",
        "placeholder": "Deadlines, constraints, things to avoid"
    })];
    (head, tail)
}

/// Ask: a new questionnaire, or another round on an existing one.
///
/// `brief` starts a new design system's questionnaire: `Some(in_repo)` puts
/// the questions every system needs around Claude's. Ignored for a round added
/// to an existing questionnaire, which asked them already.
pub fn ask(id: Option<&str>, title: &str, project: &str, chat_id: &str, questions: &[Value], brief: Option<bool>) -> Result<Value, String> {
    let q = ask_in(&dir(), id, title, project, chat_id, questions, brief)?;
    announce(q["id"].as_str().unwrap_or_default());
    Ok(q)
}

fn ask_in(
    root: &Path,
    id: Option<&str>,
    title: &str,
    project: &str,
    chat_id: &str,
    questions: &[Value],
    brief: Option<bool>,
) -> Result<Value, String> {
    let existing = id.and_then(|id| get_in(root, id));
    if id.is_some() && existing.is_none() {
        return Err(format!("no questionnaire {}", id.unwrap_or_default()));
    }
    let questions: Vec<Value> = match brief.filter(|_| existing.is_none()) {
        Some(in_repo) => {
            let (head, tail) = system_brief(in_repo, project);
            head.into_iter().chain(questions.iter().cloned()).chain(tail).collect()
        }
        None => questions.to_vec(),
    };
    let questions = questions.as_slice();
    let mut q = existing.unwrap_or_else(|| {
        json!({
            "id": format!("q_{}", util::rand_hex(5)),
            "title": title,
            "project": project,
            "chatId": chat_id,
            "createdAt": now(),
            "rounds": [],
            "answers": {},
            "sent": []
        })
    });
    if !questions.is_empty() {
        let mut taken: std::collections::HashSet<String> = q["rounds"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|r| r["questions"].as_array().cloned().unwrap_or_default())
            .filter_map(|x| x["id"].as_str().map(str::to_string))
            .collect();
        let added = normalise(questions, &mut taken)?;
        let rounds = q["rounds"].as_array_mut().ok_or("the questionnaire file is damaged")?;
        rounds.push(json!({ "at": now(), "questions": added }));
    }
    if !title.is_empty() {
        q["title"] = json!(title);
    }
    // The chat asking now is the one the answers go back to.
    q["chatId"] = json!(chat_id);
    q["updatedAt"] = json!(now());
    save_in(root, &q)?;
    Ok(q)
}

/// The renderer's autosave: replace the answers, and nothing else, so a round
/// Claude adds while someone is mid-answer is never written over.
pub fn set_answers(id: &str, answers: Value) -> Result<Value, String> {
    let root = dir();
    let mut q = get_in(&root, id).ok_or_else(|| format!("no questionnaire {id}"))?;
    q["answers"] = answers;
    q["updatedAt"] = json!(now());
    save_in(&root, &q)?;
    announce(id);
    Ok(q)
}

/// Record that answers went to Claude.
pub fn mark_sent(id: &str, count: u64) -> Result<Value, String> {
    let root = dir();
    let mut q = get_in(&root, id).ok_or_else(|| format!("no questionnaire {id}"))?;
    if let Some(sent) = q["sent"].as_array_mut() {
        sent.push(json!({ "at": now(), "count": count }));
    }
    q["updatedAt"] = json!(now());
    save_in(&root, &q)?;
    announce(id);
    Ok(q)
}

/// The folder a questionnaire's files are copied into.
fn files_dir(root: &Path, id: &str) -> PathBuf {
    root.join(id)
}

/// Above this a file is refused: it is a reference for Claude to read, and
/// Claude cannot read anything near this size anyway.
const MAX_FILE: u64 = 50 * 1024 * 1024;

/// A name not yet used in `dir`: `logo.png`, then `logo-2.png`.
fn free_name(dir: &Path, name: &str) -> String {
    let name = Path::new(name).file_name().and_then(|n| n.to_str()).filter(|n| !n.starts_with('.')).unwrap_or("file");
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let (stem, ext) = match name.rsplit_once('.') {
        Some((s, e)) if !s.is_empty() => (s, format!(".{e}")),
        _ => (name, String::new()),
    };
    (2..).map(|n| format!("{stem}-{n}{ext}")).find(|n| !dir.join(n).exists()).unwrap_or_else(|| name.to_string())
}

fn stored(path: &Path, size: u64) -> Value {
    json!({
        "name": path.file_name().and_then(|n| n.to_str()).unwrap_or_default(),
        "path": path.to_string_lossy(),
        "size": size
    })
}

/// Keep a copy of a file someone added to an answer. `bytes` for a drop or a
/// paste, which have no path; otherwise the file at `from` is copied.
pub fn add_file(id: &str, name: &str, from: Option<&Path>, bytes: Option<&[u8]>) -> Result<Value, String> {
    add_file_in(&dir(), id, name, from, bytes)
}

fn add_file_in(root: &Path, id: &str, name: &str, from: Option<&Path>, bytes: Option<&[u8]>) -> Result<Value, String> {
    if get_in(root, id).is_none() {
        return Err(format!("no questionnaire {id}"));
    }
    let size = match (from, bytes) {
        (_, Some(b)) => b.len() as u64,
        (Some(p), None) => fs::metadata(p).map_err(|e| format!("could not read {}: {e}", p.display()))?.len(),
        (None, None) => return Err("nothing to add".into()),
    };
    if size > MAX_FILE {
        return Err(format!("{name} is over {} MB", MAX_FILE / 1024 / 1024));
    }
    let dir = files_dir(root, id);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
    let to = dir.join(free_name(&dir, name));
    match (from, bytes) {
        (_, Some(b)) => fs::write(&to, b).map_err(|e| format!("could not save {name}: {e}"))?,
        (Some(p), None) => {
            fs::copy(p, &to).map_err(|e| format!("could not copy {}: {e}", p.display()))?;
        }
        (None, None) => unreachable!(),
    }
    Ok(stored(&to, size))
}

/// Delete a copy made by `add_file`. Anything outside the questionnaire's own
/// folder is refused, whatever the renderer passes.
pub fn remove_file(id: &str, path: &Path) -> Result<(), String> {
    remove_file_in(&dir(), id, path)
}

fn remove_file_in(root: &Path, id: &str, path: &Path) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("no questionnaire {id}"));
    }
    let dir = files_dir(root, id);
    if path.parent() != Some(dir.as_path()) {
        return Err("that file does not belong to this questionnaire".into());
    }
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("could not delete {}: {e}", path.display())),
        _ => Ok(()),
    }
}

/// Questionnaires for a project, newest first, without their questions.
pub fn list(project: Option<&str>) -> Vec<Value> {
    let Ok(rd) = fs::read_dir(dir()) else { return Vec::new() };
    let mut out: Vec<Value> = rd
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|q| project.is_none_or(|p| q["project"].as_str() == Some(p)))
        .map(|q| {
            let total: usize = q["rounds"].as_array().map(|r| r.iter().map(|x| x["questions"].as_array().map_or(0, Vec::len)).sum()).unwrap_or(0);
            json!({
                "id": q["id"], "title": q["title"], "project": q["project"], "chatId": q["chatId"],
                "updatedAt": q["updatedAt"], "questions": total,
                "answered": q["answers"].as_object().map_or(0, |a| a.len())
            })
        })
        .collect();
    out.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("nyra-q-{}", util::rand_hex(6)));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn asking_writes_a_questionnaire_and_names_every_question() {
        let root = scratch();
        let q = ask_in(
            &root,
            None,
            "Closeup design system",
            "/p",
            "chat-1",
            &[
                json!({ "question": "Which colour leads?", "options": [{ "label": "Violet" }, { "label": "Blue" }] }),
                json!({ "id": "radius", "question": "How round?", "kind": "scale", "scale": { "min": 0, "max": 16 } }),
                json!({ "question": "Anything to avoid?" }),
            ],
            None,
        )
        .unwrap();
        let id = q["id"].as_str().unwrap();
        assert!(id.starts_with("q_"));
        let qs = q["rounds"][0]["questions"].as_array().unwrap();
        assert_eq!(qs.iter().map(|x| x["id"].as_str().unwrap()).collect::<Vec<_>>(), ["q1", "radius", "q3"]);
        assert_eq!(qs.iter().map(|x| x["kind"].as_str().unwrap()).collect::<Vec<_>>(), ["single", "scale", "text"]);
        assert_eq!(get_in(&root, id).unwrap()["title"], "Closeup design system");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_second_round_keeps_the_answers_and_never_reuses_an_id() {
        let root = scratch();
        let q = ask_in(&root, None, "T", "/p", "c", &[json!({ "question": "One?" })], None).unwrap();
        let id = q["id"].as_str().unwrap().to_string();
        let mut saved = get_in(&root, &id).unwrap();
        saved["answers"] = json!({ "q1": { "kind": "typed", "text": "yes" } });
        save_in(&root, &saved).unwrap();
        let q = ask_in(&root, Some(&id), "", "/p", "c2", &[json!({ "id": "q1", "question": "Two?" })], None).unwrap();
        assert_eq!(q["rounds"].as_array().unwrap().len(), 2);
        assert_eq!(q["rounds"][1]["questions"][0]["id"], "q2");
        assert_eq!(q["answers"]["q1"]["text"], "yes");
        assert_eq!(q["chatId"], "c2");
        assert!(ask_in(&root, Some("q_nope"), "", "/p", "c", &[], None).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn refuses_a_question_it_cannot_show() {
        let root = scratch();
        assert!(ask_in(&root, None, "T", "/p", "c", &[json!({ "options": [] })], None).is_err());
        assert!(ask_in(&root, None, "T", "/p", "c", &[json!({ "question": "Pick", "kind": "multi" })], None).is_err());
        assert!(get_in(&root, "../etc").is_none());
        fs::remove_dir_all(&root).ok();
    }
    #[test]
    fn a_new_system_asks_the_brief_first_and_anything_else_last() {
        let root = scratch();
        let ids = |q: &Value| -> Vec<String> {
            q["rounds"].as_array().unwrap().iter()
                .flat_map(|r| r["questions"].as_array().unwrap().iter().map(|x| x["id"].as_str().unwrap().to_string()))
                .collect()
        };
        let mine = [json!({ "id": "accent", "question": "Which colour leads?", "kind": "color" })];
        let q = ask_in(&root, None, "Acme design system", "/p", "c", &mine, Some(true)).unwrap();
        assert_eq!(ids(&q), ["about", "references", "location", "accent", "notes"]);
        assert_eq!(q["rounds"][0]["questions"][1]["kind"], "files");
        // Outside a git repo there is nowhere else for it to live.
        let q = ask_in(&root, None, "Acme design system", "/p", "c", &mine, Some(false)).unwrap();
        assert_eq!(ids(&q), ["about", "references", "accent", "notes"]);
        // A later round adds only what Claude asks.
        let id = q["id"].as_str().unwrap().to_string();
        let more = [json!({ "id": "motion", "question": "How lively?" })];
        let q = ask_in(&root, Some(&id), "", "/p", "c", &more, Some(false)).unwrap();
        assert_eq!(ids(&q), ["about", "references", "accent", "notes", "motion"]);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn added_files_are_copies_kept_beside_the_questionnaire() {
        let root = scratch();
        let q = ask_in(&root, None, "T", "/p", "c", &[json!({ "question": "Logo?", "kind": "files" })], None).unwrap();
        let id = q["id"].as_str().unwrap().to_string();
        let src = root.join("logo.svg");
        fs::write(&src, "<svg/>").unwrap();
        let a = add_file_in(&root, &id, "logo.svg", Some(&src), None).unwrap();
        let b = add_file_in(&root, &id, "../../logo.svg", None, Some(b"<svg/>")).unwrap();
        assert_eq!(a["name"], "logo.svg");
        assert_eq!(b["name"], "logo-2.svg");
        let kept = PathBuf::from(b["path"].as_str().unwrap());
        assert_eq!(kept.parent().unwrap(), root.join(&id));
        // The original can go; the answer still has its copy.
        fs::remove_file(&src).unwrap();
        assert!(PathBuf::from(a["path"].as_str().unwrap()).exists());
        // Only its own files can be deleted through it, and listing skips the folder.
        assert!(remove_file_in(&root, &id, &root.join(format!("{id}.json"))).is_err());
        remove_file_in(&root, &id, &kept).unwrap();
        assert!(!kept.exists());
        assert!(add_file_in(&root, "q_nope", "x", None, Some(b"x")).is_err());
        fs::remove_dir_all(&root).ok();
    }
}
