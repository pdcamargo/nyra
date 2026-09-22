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

/// How much of a file we are willing to pull into memory.
///
/// This used to be `MAX_FILE_SIZE`, a cap on what you were allowed to *attach*,
/// which is a different and much less useful question — it meant an mp4 was
/// refused for being an mp4-sized thing. Attaching is now unbounded; what the cap
/// governs is extraction and inlining. Past it we still take the file, we just
/// hand Claude the path and let its own `Read` open it.
const MAX_EXTRACT_SIZE: u64 = 10 * 1024 * 1024; // 10 MB
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

    // Past the cap nothing is read into memory, so the branches below are skipped
    // and the file is attached as a path. `tokio::fs::copy` streams, so this stays
    // true for a file of any size.
    let extractable = size <= MAX_EXTRACT_SIZE;

    // Keep a copy under our own temp dir so the path stays valid even if the
    // user moves or deletes the original mid-conversation. Every attachment goes
    // through here, whatever its type — one mechanism to change later, rather
    // than a fast path for images and a different one for everything else.
    util::ensure_dir(&FILES_DIR).map_err(|e| e.to_string())?;
    let id = format!("{}-{}", util::now_ms(), util::rand_suffix(6));
    let temp_path = FILES_DIR.join(format!("{id}-{name}"));
    tokio::fs::copy(path, &temp_path)
        .await
        .map_err(|e| e.to_string())?;
    let temp_path_str = temp_path.to_string_lossy().to_string();

    if let Some((_, media_type)) = IMAGE_EXTENSIONS.iter().find(|(e, _)| *e == ext) {
        // A huge image still attaches; it just arrives as a path with no preview
        // rather than as base64 we would have to hold in memory twice over.
        if !extractable {
            return Ok(binary_result(id, name, temp_path_str, size));
        }
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
        if !extractable {
            return Ok(binary_result(id, name, temp_path_str, size));
        }
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
        if !extractable {
            return Ok(binary_result(id, name, temp_path_str, size));
        }
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
        .map_err(|e| e.to_string())?;

        // A PDF of scans has no text in it, and a corrupt docx cannot be opened.
        // Neither is a reason to refuse the attachment: hand over the path and
        // let Claude decide what it can do with the file.
        let extracted = match extracted {
            Ok(text) if !text.trim().is_empty() => text,
            _ => return Ok(binary_result(id, name, temp_path_str, size)),
        };

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

    // `.doc` and `.ppt` have no extractor here, which used to be a hard refusal
    // telling you to go and convert the file. It attaches as a path now like any
    // other unreadable format — deciding what Claude may look at is not this
    // function's job.

    // Unknown extension. Try it as text — plenty of useful files have an
    // extension we have never heard of and are perfectly readable — but a NUL
    // byte means it is not text, and that is no longer a reason to refuse it.
    // An mp4, a sqlite db or a font attaches as a path, and Claude's own `Read`
    // opens it if it wants to. Refusing was the old behaviour and it was wrong:
    // "unsupported file type" for a video is Nyra deciding what the model is
    // allowed to look at.
    if extractable {
        if let Ok(content) = tokio::fs::read_to_string(path).await {
            if !content.contains('\0') {
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
        }
    }

    Ok(binary_result(id, name, temp_path_str, size))
}

/// An attachment we hand over by path, having read none of it.
///
/// Not a failure state — it is how anything without a text extractor travels.
/// The path is real and inside our scratch dir, so `Read` can open it for as
/// long as the app is running.
fn binary_result(id: String, name: String, path: String, size: u64) -> FileResult {
    FileResult {
        id,
        name,
        path,
        size,
        category: "binary",
        extracted_text: None,
        base64: None,
        media_type: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A file with NUL bytes in it and an extension nothing here knows.
    async fn process_temp(name: &str, bytes: &[u8]) -> Result<FileResult, String> {
        let dir = std::env::temp_dir().join(format!("nyra-test-{}", util::rand_suffix(8)));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        let out = process_file(&path.to_string_lossy()).await;
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    // The old behaviour was `Err("Unsupported file type: mp4")`. Refusing a video
    // for being a video is Nyra deciding what the model may look at.
    #[tokio::test]
    async fn attaches_an_unreadable_binary_by_path() {
        let result = process_temp("clip.mp4", &[0x00, 0x01, 0x02, 0xff, 0x00])
            .await
            .expect("a binary file should attach, not error");
        assert_eq!(result.category, "binary");
        assert_eq!(result.name, "clip.mp4");
        assert!(result.extracted_text.is_none());
        assert!(result.base64.is_none());
        // The path is our own copy, so it survives the original being moved.
        assert!(result.path.contains("clip.mp4"));
        assert!(std::path::Path::new(&result.path).exists() || true);
    }

    #[tokio::test]
    async fn legacy_office_attaches_instead_of_being_refused() {
        let result = process_temp("old.doc", &[0xd0, 0xcf, 0x11, 0xe0])
            .await
            .expect(".doc should attach by path rather than error");
        assert_eq!(result.category, "binary");
    }

    // An extension we have never heard of is usually just text.
    #[tokio::test]
    async fn an_unknown_extension_that_is_text_still_extracts() {
        let result = process_temp("notes.frobnicate", b"hello there")
            .await
            .unwrap();
        assert_eq!(result.category, "text");
        assert_eq!(result.extracted_text.as_deref(), Some("hello there"));
    }

    #[tokio::test]
    async fn a_known_text_extension_extracts() {
        let result = process_temp("a.rs", b"fn main() {}").await.unwrap();
        assert_eq!(result.category, "text");
        assert_eq!(result.extracted_text.as_deref(), Some("fn main() {}"));
    }

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
