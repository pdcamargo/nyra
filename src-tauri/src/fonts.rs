//! The font families installed on this machine.
//!
//! `fontdb` rather than `font-kit`: it is pure Rust over `ttf-parser`, which this
//! build already compiles for `lopdf`, so it costs almost nothing to add and
//! drags in no fontconfig / DirectWrite / CoreText system dependency — which
//! matters for the Linux and Windows ports. It is also the only one of the two
//! that reports whether a face is monospaced, which is what the code-font picker
//! filters on.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub name: String,
    pub monospaced: bool,
}

/// Enumerated once per run. Parsing every installed face is not free, and the
/// answer cannot change underneath us in a way worth chasing.
static FAMILIES: OnceLock<Vec<FontFamily>> = OnceLock::new();

fn enumerate() -> Vec<FontFamily> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();

    // Keyed on the lowercased name so the map dedupes across the four faces of a
    // family and sorts case-insensitively in one move.
    let mut seen: BTreeMap<String, FontFamily> = BTreeMap::new();
    for face in db.faces() {
        let Some((family, _)) = face.families.first() else {
            continue;
        };
        // Apple ships dotted-prefix system faces (".SF NS", ".LastResort") that
        // are not meant to be chosen by name.
        if family.starts_with('.') {
            continue;
        }
        seen.entry(family.to_lowercase())
            .and_modify(|existing| existing.monospaced |= face.monospaced)
            .or_insert_with(|| FontFamily {
                name: family.clone(),
                monospaced: face.monospaced,
            });
    }
    // The Database owns the font data; only the names are wanted past here.
    drop(db);
    seen.into_values().collect()
}

/// Every installed family, deduplicated and sorted.
#[tauri::command]
pub async fn fonts_list() -> Vec<FontFamily> {
    if let Some(cached) = FAMILIES.get() {
        return cached.clone();
    }
    // Off the IPC thread: this reads and parses every font file on the machine.
    let families = tauri::async_runtime::spawn_blocking(enumerate)
        .await
        .unwrap_or_default();
    FAMILIES.get_or_init(|| families).clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enumerates_the_machine_it_runs_on() {
        let families = enumerate();
        assert!(!families.is_empty(), "no system fonts found");
        assert!(
            families.iter().any(|f| f.monospaced),
            "expected at least one monospaced family"
        );
    }

    #[test]
    fn is_deduplicated_and_sorted_case_insensitively() {
        let families = enumerate();
        let lowered: Vec<String> = families.iter().map(|f| f.name.to_lowercase()).collect();

        let mut unique = lowered.clone();
        unique.dedup();
        assert_eq!(unique.len(), lowered.len(), "duplicate family names");

        let mut sorted = lowered.clone();
        sorted.sort();
        assert_eq!(sorted, lowered, "families are not sorted");
    }

    #[test]
    fn skips_apples_private_system_faces() {
        assert!(!enumerate().iter().any(|f| f.name.starts_with('.')));
    }
}
