//! What this build of the CLI says an alias currently means.
//!
//! `--model opus` is resolved server-side, and until a turn has actually run
//! there is nothing in this app that knows what it will come back as. The CLI
//! does: it carries a model catalog, and in it an `aliases` table and a flat
//! `latest_per_family` map, sitting as plain data inside the bundle. Reading it
//! is how a model nobody has run yet still gets a version on its label, without
//! a number written down in our source that is wrong on release day.
//!
//! Scanned rather than parsed. The bundle is ~200MB of minified JavaScript and
//! the table is four fifths of the way in, so this streams it in chunks, stops
//! at the first match, and caches the answer against the binary's mtime — a CLI
//! update is a new mtime and re-reads. What it looks for are catalog field
//! names rather than minified identifiers, which is why this is worth doing at
//! all; if a later build moves them, the scan finds nothing, every label falls
//! back to a bare name, and that is exactly where they started.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::bytes::Regex;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;

/// Big enough that the read is sequential, small enough not to show up in RSS.
const CHUNK: usize = 4 * 1024 * 1024;
/// Carried between chunks so a table straddling a boundary is still found.
const OVERLAP: usize = 8 * 1024;

type Cached = (u64, i64, HashMap<String, String>);
static CACHE: Lazy<Mutex<Option<Cached>>> = Lazy::new(|| Mutex::new(None));

static TABLE: Lazy<Option<Regex>> =
    Lazy::new(|| Regex::new(r#"latest_per_family:\{([^{}]{0,600})\}"#).ok());
static PAIR: Lazy<Option<Regex>> = Lazy::new(|| Regex::new(r#"([a-z0-9_]+):"([^"]{1,80})""#).ok());

/// Family (`opus`) → the id this CLI would resolve that alias to today.
///
/// Empty whenever anything is off — no binary, an unreadable one, a build that
/// no longer carries the table. Every caller treats that as "nothing known",
/// which is a state the labels already handle.
pub fn alias_targets(binary: &str) -> HashMap<String, String> {
    let path = crate::claude::resolve_claude_binary(binary);
    let path = Path::new(&path);
    // Follows the symlink, so this is the versioned binary's own stamp: the
    // installer repoints ~/.local/bin/claude and the key moves with it.
    let Ok(meta) = std::fs::metadata(path) else {
        return HashMap::new();
    };
    let len = meta.len();
    let stamp = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default();

    let mut cache = CACHE.lock();
    if let Some((cached_len, cached_stamp, found)) = cache.as_ref() {
        if *cached_len == len && *cached_stamp == stamp {
            return found.clone();
        }
    }

    let found = scan(path).unwrap_or_default();
    crate::logf!(
        "Model catalog: {} alias target(s) from {}",
        found.len(),
        path.display()
    );
    *cache = Some((len, stamp, found.clone()));
    found
}

fn scan(path: &Path) -> Option<HashMap<String, String>> {
    let table = TABLE.as_ref()?;
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; CHUNK + OVERLAP];
    let mut carry = 0usize;

    loop {
        let read = file.read(&mut buf[carry..]).ok()?;
        if read == 0 {
            return None;
        }
        let filled = carry + read;
        if let Some(caps) = table.captures(&buf[..filled]) {
            return Some(pairs(caps.get(1)?.as_bytes()));
        }
        // Keep the tail, so a table split across two reads is seen whole.
        let keep = OVERLAP.min(filled);
        buf.copy_within(filled - keep..filled, 0);
        carry = keep;
    }
}

/// `fable:"claude-fable-5-1",opus:"claude-opus-5-5"` → a map of the two.
fn pairs(body: &[u8]) -> HashMap<String, String> {
    let Some(pair) = PAIR.as_ref() else {
        return HashMap::new();
    };
    pair.captures_iter(body)
        .filter_map(|c| {
            let key = String::from_utf8(c.get(1)?.as_bytes().to_vec()).ok()?;
            let value = String::from_utf8(c.get(2)?.as_bytes().to_vec()).ok()?;
            Some((key, value))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_table_out_of_a_bundle() {
        let dir = std::env::temp_dir().join(format!("nyra-catalog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("bundle.js");
        // Padded so the table lands past the first chunk, as it does for real.
        let mut body = vec![b'x'; CHUNK + 1024];
        body.extend_from_slice(
            br#"}],aliases:{opus:{default:"claude-opus-5-5"}},defaults:{},best:"fable","#,
        );
        body.extend_from_slice(
            br#"latest_per_family:{fable:"claude-fable-5-1",opus:"claude-opus-5-5",sonnet:"claude-sonnet-5",haiku:"claude-haiku-4-5"},alias_migration:"#,
        );
        std::fs::write(&file, &body).unwrap();

        let found = scan(&file).unwrap();
        assert_eq!(found.get("opus").map(String::as_str), Some("claude-opus-5-5"));
        assert_eq!(found.get("haiku").map(String::as_str), Some("claude-haiku-4-5"));
        assert_eq!(found.len(), 4);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn finds_a_table_split_across_two_reads() {
        let dir = std::env::temp_dir().join(format!("nyra-catalog-split-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("bundle.js");
        let table = br#"latest_per_family:{fable:"claude-fable-5-1",opus:"claude-opus-5-5"}"#;
        // Straddle the chunk boundary: half either side of CHUNK.
        let mut body = vec![b'x'; CHUNK - (table.len() / 2)];
        body.extend_from_slice(table);
        body.extend_from_slice(&vec![b'x'; 1024]);
        std::fs::write(&file, &body).unwrap();

        let found = scan(&file).unwrap();
        assert_eq!(found.get("opus").map(String::as_str), Some("claude-opus-5-5"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn says_nothing_when_the_table_is_gone() {
        let dir = std::env::temp_dir().join(format!("nyra-catalog-none-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("bundle.js");
        std::fs::write(&file, b"a bundle that no longer carries one").unwrap();
        assert!(scan(&file).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
