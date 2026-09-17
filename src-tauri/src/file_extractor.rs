//! Text extraction for prompt attachments.
//!
//! Replaces the Node stack (pdf-parse, mammoth, xlsx, jszip) with pure-Rust
//! equivalents, which also drops the DOMMatrix/ImageData shims pdfjs needed and
//! the ~28 MB per-arch native canvas module that came with them.

use base64::Engine;
use serde::Serialize;
use std::io::{Cursor, Read};
use std::path::Path;

use crate::fs_ops::FILES_DIR;
use crate::util;

const MAX_FILE_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
const MAX_TEXT_LENGTH: usize = 500_000;

const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "json", "yaml", "yml", "xml", "html", "htm", "csv", "tsv", "log", "env", "toml",
    "ini", "cfg", "sh", "bash", "zsh", "fish", "py", "js", "ts", "jsx", "tsx", "mjs", "cjs", "rb",
    "go", "rs", "java", "kt", "swift", "c", "cpp", "h", "hpp", "cs", "css", "scss", "less", "sass",
    "sql", "graphql", "gql", "r", "lua", "pl", "php", "dockerfile", "makefile", "gitignore", "tf",
    "hcl", "proto", "mdx", "rst", "tex", "bib",
];

const IMAGE_EXTENSIONS: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("svg", "image/svg+xml"),
    ("ico", "image/x-icon"),
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileResult {
    pub id: String,
    pub name: String,
    pub path: String,
    pub size: u64,
    pub category: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extracted_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base64: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media_type: Option<String>,
}

fn group_digits(n: usize) -> String {
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn truncate_text(text: &str, max_len: usize) -> String {
    if text.chars().count() <= max_len {
        return text.to_string();
    }
    let head: String = text.chars().take(max_len).collect();
    format!(
        "{head}\n\n[... truncated at {} characters]",
        group_digits(max_len)
    )
}

// ---- format-specific extractors ----

fn extract_pdf(bytes: &[u8]) -> Result<String, String> {
    pdf_extract::extract_text_from_mem(bytes).map_err(|e| e.to_string())
}

/// quick-xml surfaces `&amp;`, `&#233;` and friends as their own event rather than
/// inlining them in the surrounding text, so each one has to be resolved back.
fn resolve_entity(e: &quick_xml::events::BytesRef<'_>) -> String {
    if let Ok(Some(c)) = e.resolve_char_ref() {
        return c.to_string();
    }
    let name = e.xml10_content();
    quick_xml::escape::unescape(&format!("&{name};"))
        .map(|s| s.into_owned())
        .unwrap_or_default()
}

/// DOCX is a zip of XML. `word/document.xml` holds the body; a paragraph is a
/// `<w:p>` and its visible text is the concatenation of the `<w:t>` runs inside.
fn extract_docx(bytes: &[u8]) -> Result<String, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut xml = String::new();
    archive
        .by_name("word/document.xml")
        .map_err(|e| format!("not a docx: {e}"))?
        .read_to_string(&mut xml)
        .map_err(|e| e.to_string())?;

    let mut reader = Reader::from_str(&xml);
    reader.config_mut().trim_text(false);

    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_text = false;

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.local_name().as_ref() == "t" => in_text = true,
            Ok(Event::End(e)) => match e.local_name().as_ref() {
                "t" => in_text = false,
                "p" => paragraphs.push(std::mem::take(&mut current)),
                _ => {}
            },
            Ok(Event::Text(e)) if in_text => current.push_str(&e.xml10_content()),
            Ok(Event::GeneralRef(e)) if in_text => current.push_str(&resolve_entity(&e)),
            // `<w:br/>` and `<w:tab/>` carry layout meaning inside a paragraph.
            Ok(Event::Empty(e)) => match e.local_name().as_ref() {
                "br" => current.push('\n'),
                "tab" => current.push('\t'),
                _ => {}
            },
            Ok(Event::Eof) => break,
            Err(e) => return Err(e.to_string()),
            _ => {}
        }
    }
    if !current.is_empty() {
        paragraphs.push(current);
    }
    Ok(paragraphs.join("\n"))
}

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

fn extract_spreadsheet(path: &Path) -> Result<String, String> {
    use calamine::{open_workbook_auto, Reader};

    let mut workbook = open_workbook_auto(path).map_err(|e| e.to_string())?;
    let sheet_names = workbook.sheet_names().to_vec();
    let multi = sheet_names.len() > 1;
    let mut parts = Vec::new();

    for name in sheet_names {
        let Ok(range) = workbook.worksheet_range(&name) else {
            continue;
        };
        let csv: String = range
            .rows()
            .map(|row| {
                row.iter()
                    .map(|cell| csv_escape(&cell.to_string()))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .collect::<Vec<_>>()
            .join("\n");
        if multi {
            parts.push(format!("--- Sheet: {name} ---\n{csv}"));
        } else {
            parts.push(csv);
        }
    }
    Ok(parts.join("\n\n"))
}

/// PPTX is also a zip of XML; each `ppt/slides/slideN.xml` holds `<a:t>` runs.
fn extract_pptx(bytes: &[u8]) -> Result<String, String> {
    use quick_xml::events::Event;
    use quick_xml::Reader;

    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;

    let slide_re = regex::Regex::new(r"^ppt/slides/slide(\d+)\.xml$").unwrap();
    let mut slides: Vec<(u32, String)> = archive
        .file_names()
        .filter_map(|n| {
            slide_re
                .captures(n)
                .and_then(|c| c.get(1)?.as_str().parse::<u32>().ok())
                .map(|num| (num, n.to_string()))
        })
        .collect();
    slides.sort_by_key(|(num, _)| *num);

    let mut parts = Vec::new();
    for (num, file_name) in slides {
        let mut xml = String::new();
        let read = archive
            .by_name(&file_name)
            .map_err(|e| e.to_string())
            .and_then(|mut f| f.read_to_string(&mut xml).map_err(|e| e.to_string()));
        if read.is_err() {
            continue;
        }

        let mut reader = Reader::from_str(&xml);
        reader.config_mut().trim_text(false);
        let mut texts: Vec<String> = Vec::new();
        let mut current = String::new();
        let mut in_text = false;

        loop {
            match reader.read_event() {
                Ok(Event::Start(e)) if e.local_name().as_ref() == "t" => in_text = true,
                Ok(Event::End(e)) if e.local_name().as_ref() == "t" => {
                    in_text = false;
                    let text = std::mem::take(&mut current);
                    if !text.trim().is_empty() {
                        texts.push(text);
                    }
                }
                Ok(Event::Text(e)) if in_text => current.push_str(&e.xml10_content()),
                Ok(Event::GeneralRef(e)) if in_text => current.push_str(&resolve_entity(&e)),
                Ok(Event::Eof) => break,
                Err(_) => break,
                _ => {}
            }
        }

        if !texts.is_empty() {
            parts.push(format!("--- Slide {num} ---\n{}", texts.join(" ")));
        }
    }
    Ok(parts.join("\n\n"))
}

// ---- entry point ----

pub async fn process_file(file_path: &str) -> Result<FileResult, String> {
    let path = Path::new(file_path);
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();

    let meta = tokio::fs::metadata(path).await.map_err(|e| e.to_string())?;
    let size = meta.len();
    if size > MAX_FILE_SIZE {
        return Err(format!(
            "File too large: {name} ({:.1} MB). Maximum is 10 MB.",
            size as f64 / 1024.0 / 1024.0
        ));
    }

    // Keep a copy under our own temp dir so the path stays valid even if the
    // user moves or deletes the original mid-conversation.
    util::ensure_dir(&FILES_DIR).map_err(|e| e.to_string())?;
    let id = format!("{}-{}", util::now_ms(), util::rand_suffix(6));
    let temp_path = FILES_DIR.join(format!("{id}-{name}"));
    tokio::fs::copy(path, &temp_path)
        .await
        .map_err(|e| e.to_string())?;
    let temp_path_str = temp_path.to_string_lossy().to_string();

    if let Some((_, media_type)) = IMAGE_EXTENSIONS.iter().find(|(e, _)| *e == ext) {
        let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
        return Ok(FileResult {
            id,
            name,
            path: temp_path_str,
            size,
            category: "image",
            extracted_text: None,
            base64: Some(base64::engine::general_purpose::STANDARD.encode(&bytes)),
            media_type: Some(media_type.to_string()),
        });
    }

    if TEXT_EXTENSIONS.contains(&ext.as_str()) || ext.is_empty() || name.starts_with('.') {
        let content = tokio::fs::read_to_string(path)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(FileResult {
            id,
            name,
            path: temp_path_str,
            size,
            category: "text",
            extracted_text: Some(truncate_text(&content, MAX_TEXT_LENGTH)),
            base64: None,
            media_type: None,
        });
    }

    let document_kind = match ext.as_str() {
        "pdf" => Some("pdf"),
        "docx" => Some("docx"),
        "xlsx" | "xls" => Some("spreadsheet"),
        "pptx" => Some("pptx"),
        _ => None,
    };

    if let Some(kind) = document_kind {
        let owned_path = path.to_path_buf();
        // Extraction is CPU-bound and fully synchronous; keep it off the runtime.
        let extracted = tokio::task::spawn_blocking(move || -> Result<String, String> {
            match kind {
                "pdf" => extract_pdf(&std::fs::read(&owned_path).map_err(|e| e.to_string())?),
                "docx" => extract_docx(&std::fs::read(&owned_path).map_err(|e| e.to_string())?),
                "spreadsheet" => extract_spreadsheet(&owned_path),
                "pptx" => extract_pptx(&std::fs::read(&owned_path).map_err(|e| e.to_string())?),
                _ => Ok(String::new()),
            }
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("Failed to extract text from {name}: {e}"))?;

        if extracted.trim().is_empty() {
            return Err(format!("No text content found in {name}"));
        }

        return Ok(FileResult {
            id,
            name,
            path: temp_path_str,
            size,
            category: "document",
            extracted_text: Some(truncate_text(&extracted, MAX_TEXT_LENGTH)),
            base64: None,
            media_type: None,
        });
    }

    if matches!(ext.as_str(), "doc" | "ppt") {
        return Err(format!(
            "Legacy Office format (.{ext}) is not supported. Please convert to .{ext}x format."
        ));
    }

    // Unknown extension — try it as text, but reject anything that smells binary.
    match tokio::fs::read_to_string(path).await {
        Ok(content) if !content.contains('\0') => Ok(FileResult {
            id,
            name,
            path: temp_path_str,
            size,
            category: "text",
            extracted_text: Some(truncate_text(&content, MAX_TEXT_LENGTH)),
            base64: None,
            media_type: None,
        }),
        _ => Err(format!(
            "Unsupported file type: {}",
            if ext.is_empty() { &name } else { &ext }
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaves_short_text_alone() {
        assert_eq!(truncate_text("hello", 100), "hello");
    }

    #[test]
    fn appends_a_truncation_marker() {
        let out = truncate_text(&"a".repeat(20), 10);
        assert!(out.starts_with(&"a".repeat(10)));
        assert!(out.ends_with("[... truncated at 10 characters]"));
    }

    #[test]
    fn groups_digits_like_tolocalestring() {
        assert_eq!(group_digits(500_000), "500,000");
        assert_eq!(group_digits(999), "999");
        assert_eq!(group_digits(1_234_567), "1,234,567");
    }

    #[test]
    fn quotes_csv_values_that_need_it() {
        assert_eq!(csv_escape("plain"), "plain");
        assert_eq!(csv_escape("a,b"), "\"a,b\"");
        assert_eq!(csv_escape("say \"hi\""), "\"say \"\"hi\"\"\"");
    }
}
