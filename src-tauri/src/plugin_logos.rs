//! Optional public logos for plugins that also have a Claude connector listing.
//!
//! Claude Code's install catalog has no icon field. The public connector page
//! does, so this reads its card markup once and pairs a connector slug with the
//! official asset URL. A changed page or an offline launch simply returns no
//! logos; the renderer keeps its letter badges.

use once_cell::sync::Lazy;
use parking_lot::RwLock;
use regex::Regex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const PAGE: &str = "https://claude.com/marketplace/connectors-plugins";
const ASSET_PREFIX: &str = "https://assets.claude.com/";
const MAX_HTML_BYTES: usize = 8 * 1024 * 1024;
const CACHE_FOR: Duration = Duration::from_secs(60 * 60);

static CACHE: Lazy<RwLock<Option<(Instant, HashMap<String, String>)>>> =
    Lazy::new(|| RwLock::new(None));

fn parse_logos(html: &str) -> HashMap<String, String> {
    let card = Regex::new(r#"<div class="[^"]*CardConnector[^"]*__card">"#).unwrap();
    let link = Regex::new(r#"<a href="/marketplace/connectors/([a-z0-9-]+)""#).unwrap();
    let image = Regex::new(r#"<img src="(https://assets\.claude\.com/[^"]+)""#).unwrap();
    let starts: Vec<usize> = card.find_iter(html).map(|hit| hit.start()).collect();
    let mut logos = HashMap::new();

    for (index, start) in starts.iter().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(html.len());
        let part = &html[*start..end];
        let Some(slug) = link.captures(part).and_then(|capture| capture.get(1)) else {
            continue;
        };
        let Some(url) = image.captures(part).and_then(|capture| capture.get(1)) else {
            continue;
        };
        let url = url.as_str().replace("&amp;", "&");
        if url.starts_with(ASSET_PREFIX) {
            logos.insert(slug.as_str().to_string(), url);
        }
    }
    logos
}

pub async fn list() -> HashMap<String, String> {
    if let Some((fetched, logos)) = CACHE.read().as_ref() {
        if fetched.elapsed() < CACHE_FOR {
            return logos.clone();
        }
    }

    let result = async {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .ok()?;
        let response = client.get(PAGE).send().await.ok()?.error_for_status().ok()?;
        if response.content_length().is_some_and(|bytes| bytes as usize > MAX_HTML_BYTES) {
            return None;
        }
        let bytes = response.bytes().await.ok()?;
        if bytes.len() > MAX_HTML_BYTES {
            return None;
        }
        Some(parse_logos(std::str::from_utf8(&bytes).ok()?))
    }
    .await;

    let logos = result.unwrap_or_default();
    // Cache successful reads. An offline launch retries on the next visit.
    if !logos.is_empty() {
        *CACHE.write() = Some((Instant::now(), logos.clone()));
    }
    logos
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_maps_official_connector_assets() {
        let html = r#"<div class="CardConnector-module__card"><img src="https://assets.claude.com/figma.svg?w=128&amp;fit=max"><a href="/marketplace/connectors/figma">Figma</a></div><div class="CardConnector-module__card"><img src="https://example.com/evil.svg"><a href="/marketplace/connectors/evil">Evil</a></div>"#;
        let logos = parse_logos(html);
        assert_eq!(logos.get("figma").map(String::as_str), Some("https://assets.claude.com/figma.svg?w=128&fit=max"));
        assert!(!logos.contains_key("evil"));
    }
}
