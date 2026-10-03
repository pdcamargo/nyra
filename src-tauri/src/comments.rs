//! Comments pinned to designs.
//!
//! One file per *scope* — a design system, or a single draft — so a system's
//! comments show up on every file of it and in every chat on the project. Kept
//! in `~/.nyra/designs/comments/`, never in the user's repo: they are a
//! conversation about the design, not part of it.
//!
//! A comment anchors to an element, not a point: the renderer records the
//! node's resolved id, the authored address it came from (scope, id, file), and
//! where inside its box the pin sits. A point on its own goes stale the moment
//! Claude moves anything; the point is kept only as the fallback for when the
//! element is gone.
//!
//! A comment is a thread. Claude's note when it resolves one, and anything the
//! user writes back, are replies on it, so each round of "try this" and "not
//! quite" stays with the element it was about.

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::util;

fn dir() -> PathBuf {
    util::home_dir().join(".nyra").join("designs").join("comments")
}

/// `sys:s_ab12`, `design:d_cd34`, `path:<hash>` — the renderer decides; this
/// only keeps it a safe file name.
fn file_of(root: &Path, scope: &str) -> Result<PathBuf, String> {
    let safe: String = scope
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if safe.is_empty() || safe.len() > 80 {
        return Err(format!("not a comment scope: {scope}"));
    }
    Ok(root.join(format!("{safe}.json")))
}

fn announce(scope: &str) {
    util::emit("nyra:comments-changed", json!({ "scope": scope }));
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn load_in(root: &Path, scope: &str) -> Result<Value, String> {
    let path = file_of(root, scope)?;
    match fs::read_to_string(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({ "schema": 1, "scope": scope, "comments": [] })),
        Err(e) => Err(format!("could not read {}: {e}", path.display())),
        Ok(t) => serde_json::from_str(&t).map_err(|e| format!("{} is damaged: {e}", path.display())),
    }
}

fn save_in(root: &Path, scope: &str, doc: &Value) -> Result<(), String> {
    fs::create_dir_all(root).map_err(|e| format!("could not create {}: {e}", root.display()))?;
    let path = file_of(root, scope)?;
    let tmp = root.join(format!(".{}.{}", path.file_name().and_then(|n| n.to_str()).unwrap_or("c"), util::rand_hex(4)));
    fs::write(&tmp, serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?)
        .map_err(|e| format!("could not write the comments: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("could not save the comments: {e}"))
}

pub fn list(scope: &str) -> Result<Vec<Value>, String> {
    Ok(load_in(&dir(), scope)?["comments"].as_array().cloned().unwrap_or_default())
}

/// Add one, giving it an id and the next pin number in its scope. Numbers are
/// never reused, so "comment 4" means one thing for the life of the scope.
pub fn add(scope: &str, comment: Value) -> Result<Value, String> {
    let out = add_in(&dir(), scope, comment)?;
    announce(scope);
    Ok(out)
}

fn add_in(root: &Path, scope: &str, comment: Value) -> Result<Value, String> {
    let mut doc = load_in(root, scope)?;
    let mut c = comment.as_object().cloned().ok_or("a comment must be an object")?;
    let text = c.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if text.is_empty() {
        return Err("a comment needs text".into());
    }
    let n = doc["next"].as_u64().unwrap_or_else(|| doc["comments"].as_array().map_or(0, |a| a.len() as u64) + 1).max(1);
    c.insert("id".into(), json!(format!("c_{}", util::rand_hex(5))));
    c.insert("n".into(), json!(n));
    c.insert("text".into(), json!(text));
    c.insert("status".into(), json!("open"));
    c.insert("createdAt".into(), json!(now()));
    let added = Value::Object(c);
    doc["comments"].as_array_mut().ok_or("the comments file is damaged")?.push(added.clone());
    doc["next"] = json!(n + 1);
    save_in(root, scope, &doc)?;
    Ok(added)
}

/// Resolve (a note becomes a reply), reopen, reply, or change the text. Only
/// those fields. A reply from the user reopens the comment: it means the last
/// round did not settle it.
pub fn update(scope: &str, id: &str, change: &Value) -> Result<Value, String> {
    let out = update_in(&dir(), scope, id, change)?;
    announce(scope);
    Ok(out)
}

fn update_in(root: &Path, scope: &str, id: &str, change: &Value) -> Result<Value, String> {
    let mut doc = load_in(root, scope)?;
    let comments = doc["comments"].as_array_mut().ok_or("the comments file is damaged")?;
    let c = comments.iter_mut().find(|c| c["id"] == id).ok_or_else(|| format!("no comment {id}"))?;
    let reply = |c: &mut Value, by: &str, text: &str| {
        let r = json!({ "id": format!("r_{}", util::rand_hex(4)), "by": by, "text": text, "at": now() });
        match c["replies"].as_array_mut() {
            Some(all) => all.push(r),
            None => c["replies"] = json!([r]),
        }
    };
    let reopen = |c: &mut Value| {
        c["status"] = json!("open");
        if let Some(obj) = c.as_object_mut() {
            obj.remove("resolution");
        }
    };
    match change.get("status").and_then(Value::as_str) {
        Some("resolved") => {
            let by = change.get("by").and_then(Value::as_str).unwrap_or("you");
            c["status"] = json!("resolved");
            c["resolution"] = json!({ "by": by, "at": now() });
            if let Some(note) = change.get("note").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()) {
                reply(c, by, note);
            }
        }
        Some("open") => reopen(c),
        _ => {}
    }
    if let Some(r) = change.get("reply") {
        let text = r.get("text").and_then(Value::as_str).unwrap_or("").trim();
        if text.is_empty() {
            return Err("a reply needs text".into());
        }
        let by = r.get("by").and_then(Value::as_str).unwrap_or("you");
        reply(c, by, text);
        if by != "claude" {
            reopen(c);
        }
    }
    if let Some(text) = change.get("text").and_then(Value::as_str).filter(|t| !t.trim().is_empty()) {
        c["text"] = json!(text.trim());
    }
    let out = c.clone();
    save_in(root, scope, &doc)?;
    Ok(out)
}

pub fn delete(scope: &str, id: &str) -> Result<(), String> {
    let root = dir();
    let mut doc = load_in(&root, scope)?;
    if let Some(comments) = doc["comments"].as_array_mut() {
        comments.retain(|c| c["id"] != id);
    }
    save_in(&root, scope, &doc)?;
    announce(scope);
    Ok(())
}

/// The scope a comment id lives in. Ids are unique across scopes, so Claude can
/// resolve a comment by its id alone.
pub fn scope_of(id: &str) -> Option<String> {
    let rd = fs::read_dir(dir()).ok()?;
    for e in rd.flatten() {
        let Ok(text) = fs::read_to_string(e.path()) else { continue };
        let Ok(doc) = serde_json::from_str::<Value>(&text) else { continue };
        if doc["comments"].as_array().is_some_and(|a| a.iter().any(|c| c["id"] == id)) {
            return doc["scope"].as_str().map(str::to_string);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join(format!("nyra-comments-{}", util::rand_hex(6)));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn comments_get_ids_and_pin_numbers_that_are_never_reused() {
        let root = scratch();
        let a = add_in(&root, "sys:s_1", json!({ "text": "Too loud", "file": "/d/screens/a.nyui.json" })).unwrap();
        let b = add_in(&root, "sys:s_1", json!({ "text": "  Say Allow  " })).unwrap();
        assert_eq!((a["n"].as_u64(), b["n"].as_u64()), (Some(1), Some(2)));
        assert_eq!(b["text"], "Say Allow");
        assert_eq!(a["status"], "open");
        let mut doc = load_in(&root, "sys:s_1").unwrap();
        doc["comments"].as_array_mut().unwrap().remove(0);
        save_in(&root, "sys:s_1", &doc).unwrap();
        let c = add_in(&root, "sys:s_1", json!({ "text": "Third" })).unwrap();
        assert_eq!(c["n"].as_u64(), Some(3), "a deleted comment's number is not handed out again");
        assert!(add_in(&root, "sys:s_1", json!({ "text": "  " })).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_comment_is_a_thread_that_keeps_every_round() {
        let root = scratch();
        let a = add_in(&root, "design:d_1", json!({ "text": "Say Allow" })).unwrap();
        let id = a["id"].as_str().unwrap();
        let r = update_in(&root, "design:d_1", id, &json!({ "status": "resolved", "note": "Changed the label", "by": "claude" })).unwrap();
        assert_eq!(r["status"], "resolved");
        assert_eq!(r["resolution"]["by"], "claude");
        assert_eq!(r["replies"][0]["by"], "claude");
        assert_eq!(r["replies"][0]["text"], "Changed the label");
        // Reopening on its own says nothing and keeps the thread.
        let o = update_in(&root, "design:d_1", id, &json!({ "status": "open" })).unwrap();
        assert_eq!(o["status"], "open");
        assert!(o.get("resolution").is_none());
        assert_eq!(o["replies"].as_array().unwrap().len(), 1);
        // A reply from the user reopens a resolved comment and adds to the thread.
        update_in(&root, "design:d_1", id, &json!({ "status": "resolved", "note": "Shortened it", "by": "claude" })).unwrap();
        let back = update_in(&root, "design:d_1", id, &json!({ "reply": { "text": "  Still too long  ", "by": "you" } })).unwrap();
        assert_eq!(back["status"], "open");
        let thread: Vec<(&str, &str)> = back["replies"].as_array().unwrap().iter()
            .map(|r| (r["by"].as_str().unwrap(), r["text"].as_str().unwrap())).collect();
        assert_eq!(thread, [("claude", "Changed the label"), ("claude", "Shortened it"), ("you", "Still too long")]);
        assert!(update_in(&root, "design:d_1", id, &json!({ "reply": { "text": " " } })).is_err());
        assert!(update_in(&root, "design:d_1", "c_nope", &json!({})).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_scope_cannot_escape_the_comments_folder() {
        let root = scratch();
        let p = file_of(&root, "../../etc/passwd").unwrap();
        assert!(p.starts_with(&root));
        assert!(file_of(&root, "").is_err());
        fs::remove_dir_all(&root).ok();
    }
}
