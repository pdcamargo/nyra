//! Community workflow templates fetched from the nyra-flows-marketplace repo.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::time::Duration;

use super::helpers::marketplace_raw_base;
use super::store;
use super::types::{MarketplaceEntry, MarketplaceIndex};
use crate::util;

const FETCH_TIMEOUT: Duration = Duration::from_secs(8);
const CACHE_TTL_MS: i64 = 5 * 60 * 1000;

static CACHE: Lazy<Mutex<Option<(MarketplaceIndex, i64)>>> = Lazy::new(|| Mutex::new(None));

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("nyra/", env!("CARGO_PKG_VERSION")))
        .build()
        .unwrap_or_default()
});

pub async fn fetch_index(force_refresh: bool) -> Value {
    let now = util::now_ms();
    if !force_refresh {
        if let Some((index, fetched_at)) = CACHE.lock().as_ref() {
            if now - fetched_at < CACHE_TTL_MS {
                return json!({ "index": index });
            }
        }
    }

    let cached = || CACHE.lock().as_ref().map(|(i, _)| i.clone());
    let url = format!("{}/index.json", marketplace_raw_base());

    let response = match CLIENT.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = e.to_string();
            crate::log!("marketplace", "Index fetch failed: {msg}");
            // A stale index beats an empty list.
            return match cached() {
                Some(index) => json!({ "index": index, "error": format!("{msg} (using cached)") }),
                None => json!({ "error": msg }),
            };
        }
    };

    if !response.status().is_success() {
        let status = response.status().as_u16();
        return match cached() {
            Some(index) => json!({ "index": index, "error": format!("HTTP {status} (using cached)") }),
            None => json!({ "error": format!("HTTP {status}") }),
        };
    }

    match response.json::<MarketplaceIndex>().await {
        Ok(index) => {
            crate::log!(
                "marketplace",
                "Loaded {} templates from marketplace",
                index.templates.len()
            );
            *CACHE.lock() = Some((index.clone(), now));
            json!({ "index": index })
        }
        Err(_) => json!({ "error": "Marketplace index is malformed" }),
    }
}

pub async fn install_template(entry: MarketplaceEntry) -> Value {
    if entry.path.is_empty() || entry.id.is_empty() {
        return json!({ "error": "Invalid marketplace entry" });
    }
    // The path comes from a remote index — keep it repo-relative.
    if entry.path.contains("..") || entry.path.starts_with('/') {
        return json!({ "error": "Invalid template path" });
    }

    let url = format!("{}/{}", marketplace_raw_base(), entry.path);
    let response = match CLIENT.get(&url).send().await {
        Ok(r) => r,
        Err(e) => {
            crate::log!("marketplace", "Install failed for {}: {e}", entry.id);
            return json!({ "error": e.to_string() });
        }
    };
    if !response.status().is_success() {
        return json!({ "error": format!("HTTP {}", response.status().as_u16()) });
    }

    let mut template = match response.json::<Value>().await {
        Ok(v) => v,
        Err(e) => return json!({ "error": e.to_string() }),
    };
    let well_formed = template.get("nodes").and_then(Value::as_array).is_some()
        && template.get("edges").and_then(Value::as_array).is_some();
    if !well_formed {
        return json!({ "error": "Template JSON is malformed" });
    }

    // A fresh local id means re-installing never clobbers local edits; the
    // marketplace fields let the UI show installed / update-available state.
    let now = util::now_ms();
    if let Value::Object(map) = &mut template {
        map.insert(
            "id".into(),
            json!(format!("wf-mkt-{}-{now}", entry.id)),
        );
        map.insert("isTemplate".into(), json!(false));
        map.insert("createdAt".into(), json!(now));
        map.insert("updatedAt".into(), json!(now));
        map.insert("marketplaceId".into(), json!(entry.id));
        map.insert("marketplaceVersion".into(), json!(entry.version));
    }

    match store::save_workflow(template).await {
        Ok(workflow) => {
            crate::log!(
                "marketplace",
                "Installed marketplace template {} v{}",
                entry.id,
                entry.version
            );
            json!({ "workflow": workflow })
        }
        Err(e) => json!({ "error": e }),
    }
}
