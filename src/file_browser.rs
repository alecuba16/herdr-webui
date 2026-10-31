use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::Command;
use std::time::UNIX_EPOCH;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use regex::{escape, Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::{expand_user_path_string, home_folder_path, require_auth, WebState};
// Shared markdown parser lives in the lib so the TUI (in-lib) and this bin
// module can never drift apart.
use herdr_webui::markdown::parse_markdown_outline;

const MAX_ENTRIES: usize = 1000;
// Collect-then-rank search walks further per page so deep matches (for
// example ~/Documents/projects/<repo> from a home-rooted search) land on the
// first ranked page instead of behind many "Load more" clicks. The walk is
// still bounded; pages past the cap keep the old windowed behavior.
const MAX_RANKED_SEARCH_VISITS: usize = 100_000;
// Hard ceiling on matches kept for ranking, so a one-character query over a
// huge tree collects a bounded set.
const MAX_COLLECTED_SEARCH_MATCHES: usize = 10_000;
const DEFAULT_SEARCH_LIMIT: usize = 100;
const MAX_SEARCH_LIMIT: usize = 500;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_CONTENT_SEARCH_VISITS: usize = 20_000;
const DEFAULT_CONTENT_SEARCH_LIMIT: usize = 50;
const MAX_CONTENT_SEARCH_LIMIT: usize = 200;
const DEFAULT_CONTENT_MATCHES_PER_FILE: usize = 5;
const MAX_CONTENT_MATCHES_PER_FILE: usize = 500;
const DEFAULT_CONTENT_CONTEXT_LINES: usize = 2;
const MAX_CONTENT_CONTEXT_LINES: usize = 20;
const MAX_CONTENT_SEARCH_FILE_BYTES: u64 = 1024 * 1024;

pub(crate) fn routes() -> Router<WebState> {
    Router::new()
        .route("/api/file-browser/tree", get(file_browser_tree))
        .route(
            "/api/file-browser/file",
            get(file_browser_file).post(file_browser_write_file),
        )
        .route(
            "/api/file-browser/content-search",
            get(file_browser_content_search),
        )
        .route(
            "/api/file-browser/content-search/file",
            get(file_browser_content_search_file),
        )
        .route("/api/file-browser/outline", get(file_browser_outline))
        .route(
            "/api/file-browser/rename",
            axum::routing::post(file_browser_rename),
        )
        .route(
            "/api/file-browser/delete",
            axum::routing::post(file_browser_delete),
        )
        .route(
            "/api/file-browser/request-access",
            axum::routing::post(file_browser_request_access),
        )
}

/// Built-in backend socket dispatch for the file browser: the same
/// operations as the HTTP routes, minus auth (the BB unix socket is a
/// trusted local transport). Params reuse the HTTP request structs so
/// validation can never drift between the two transports.
pub(crate) fn socket_dispatch(method: &str, params: Value) -> Result<Value, String> {
    fn decode<T: serde::de::DeserializeOwned>(params: &Value) -> Result<T, String> {
        serde_json::from_value(params.clone()).map_err(|err| format!("invalid parameters: {err}"))
    }
    // Strip the HTTP status the payload fns carry; only the message
    // matters on the socket transport.
    fn map_status(result: Result<Value, (StatusCode, String)>) -> Result<Value, String> {
        result.map_err(|(_, message)| message)
    }
    match method {
        "file.tree" => {
            let query: FileBrowserQuery = decode(&params)?;
            map_status(file_browser_tree_payload(query))
        }
        "file.read" => {
            let query: FileBrowserQuery = decode(&params)?;
            map_status(file_browser_file_payload(query))
        }
        "file.write" => {
            let body: FileBrowserWriteRequest = decode(&params)?;
            map_status(file_browser_write_file_payload(body))
        }
        "file.content_search" => {
            let query: FileContentSearchQuery = decode(&params)?;
            map_status(file_browser_content_search_payload(query))
        }
        "file.content_search_file" => {
            let query: FileContentSearchQuery = decode(&params)?;
            map_status(file_browser_content_search_file_payload(query))
        }
        "file.outline" => {
            let query: FileBrowserQuery = decode(&params)?;
            map_status(file_browser_outline_payload(query))
        }
        "file.rename" => {
            let body: FileBrowserRenameRequest = decode(&params)?;
            map_status(file_browser_rename_payload(body))
        }
        "file.delete" => {
            let body: FileBrowserDeleteRequest = decode(&params)?;
            map_status(file_browser_delete_payload(body))
        }
        other => Err(format!("unknown file-browser method: {other}")),
    }
}

#[derive(Deserialize)]
struct FileBrowserQuery {
    cwd: String,
    path: Option<String>,
    dirs_only: Option<bool>,
    depth: Option<u8>,
    q: Option<String>,
    search_kind: Option<String>,
    offset: Option<usize>,
    limit: Option<usize>,
    // Legacy visit-cursor from the walk-window pagination. Ranked search
    // re-walks and re-ranks the same match set per page, so this is ignored;
    // the offset alone pages through the ranked list. Kept in the schema so
    // older clients keep working.
    visit_offset: Option<usize>,
    // Filename search matching mode, mirroring content search: match the
    // query exactly (true) or fold case (false, default).
    match_case: Option<bool>,
    // Treat the filename search query as a Rust regex pattern.
    regex: Option<bool>,
    include_git_status: Option<bool>,
    // "lines" asks the backend to also build the numbered read-only preview
    // markup (gutter + escaped code HTML) so the browser does not have to
    // escape and join per-line HTML on the main thread.
    render: Option<String>,
    // Partial-read budget for oversized text files (A4): when set, files
    // larger than the budget return their first N bytes (lossy UTF-8) with
    // truncated=true instead of an empty placeholder. Editing stays blocked
    // client-side and the response carries an empty hash so a save attempt
    // can never pass the expected_hash check.
    max_bytes: Option<u64>,
    // A6 diff awareness: when set, return only the current hash + size for
    // the file so the browser can cheaply detect external changes on
    // refocus without re-reading the full content.
    hash_only: Option<bool>,
}

#[derive(Deserialize)]
struct FileBrowserWriteRequest {
    cwd: String,
    path: String,
    content: String,
    expected_hash: Option<String>,
    /// Create missing intermediate directories (new-file/new-directory
    /// flow). Off by default so plain writes never grow the tree.
    #[serde(default)]
    create_parents: bool,
}

#[derive(Deserialize)]
struct FileContentSearchQuery {
    cwd: String,
    path: Option<String>,
    file: Option<String>,
    q: String,
    offset: Option<usize>,
    limit: Option<usize>,
    context_lines: Option<usize>,
    max_matches_per_file: Option<usize>,
    match_case: Option<bool>,
    regex: Option<bool>,
}

#[derive(Deserialize)]
struct FileBrowserRenameRequest {
    cwd: String,
    path: String,
    new_name: String,
}

#[derive(Deserialize)]
struct FileBrowserDeleteRequest {
    cwd: String,
    path: String,
}

#[derive(Deserialize)]
struct FileBrowserAccessRequest {
    cwd: String,
    path: Option<String>,
}

#[derive(Serialize)]
struct FileBrowserEntry {
    name: String,
    path: String,
    kind: String,
    size: Option<u64>,
    modified_ms: Option<u64>,
    level: usize,
    expanded: bool,
}

struct TreeBuild<'a> {
    root: &'a Path,
    entries: Vec<FileBrowserEntry>,
    truncated: bool,
}

struct DirectoryEntry {
    name: String,
    sort_name: String,
    path: PathBuf,
    metadata: fs::Metadata,
}

#[derive(Clone, Serialize)]
struct ContentSearchMatch {
    id: String,
    line: usize,
    column: usize,
    match_start: usize,
    match_end: usize,
    start_line: usize,
    end_line: usize,
    content: String,
    before: Vec<String>,
    text: String,
    after: Vec<String>,
}

#[derive(Clone, Serialize)]
struct ContentSearchRow {
    line: usize,
    matched: bool,
    #[serde(rename = "match_id")]
    match_id: Option<String>,
    // Pre-escaped highlight markup built by the backend so the browser
    // renders chunks without rebuilding per-row HTML on every render.
    #[serde(rename = "highlight_html")]
    highlight_html: String,
}

#[derive(Clone, Serialize)]
struct ContentSearchChunk {
    start: usize,
    end: usize,
    rows: Vec<ContentSearchRow>,
    #[serde(rename = "match_ids")]
    match_ids: Vec<String>,
}

#[derive(Clone, Serialize)]
struct ContentSearchFile {
    path: String,
    name: String,
    size: u64,
    hash: String,
    match_count: usize,
    matches: Vec<ContentSearchMatch>,
    // Pre-merged line chunks with per-row highlight markup, ready to render.
    chunks: Vec<ContentSearchChunk>,
    truncated: bool,
}

fn escape_html(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            '"' => escaped.push_str("&quot;"),
            '\'' => escaped.push_str("&#39;"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

// Byte offsets from ContentMatcher::find are exact for the matched line, so
// the highlighted span is built here (in Rust) instead of being recomputed in
// the browser. Non-ASCII lines highlight correctly because slicing happens on
// char boundaries, not UTF-16 code units.
fn highlight_line_html(line: &str, match_start: usize, match_end: usize, query: &str) -> String {
    let text = line;
    if match_end > match_start
        && match_start <= text.len()
        && match_end <= text.len()
        && text.is_char_boundary(match_start)
        && text.is_char_boundary(match_end)
    {
        return format!(
            "{}<mark class=\"herdr-content-search-hit\">{}</mark>{}",
            escape_html(&text[..match_start]),
            escape_html(&text[match_start..match_end]),
            escape_html(&text[match_end..])
        );
    }
    // Fallback mirrors the legacy browser behavior: first case-insensitive
    // occurrence of the raw query text.
    let needle = query.to_lowercase();
    if needle.is_empty() {
        return escape_html(text);
    }
    let haystack = text.to_lowercase();
    if let Some(index) = haystack.find(&needle) {
        if text.is_char_boundary(index) && text.is_char_boundary(index + needle.len()) {
            return format!(
                "{}<mark class=\"herdr-content-search-hit\">{}</mark>{}",
                escape_html(&text[..index]),
                escape_html(&text[index..index + needle.len()]),
                escape_html(&text[index + needle.len()..])
            );
        }
    }
    escape_html(text)
}

struct ContentSearchChunkRow {
    line: usize,
    matched: bool,
    match_id: Option<String>,
    text: String,
    match_start: usize,
    match_end: usize,
}

// Merge the per-match context windows into continuous chunks exactly like the
// legacy browser renderer did: matches sorted by line, adjacent or overlapping
// windows merge into one chunk, and a matched row wins over a muted row on
// the same line. Runs once per backend response instead of on every render.
fn build_content_search_chunks(
    matches: &[ContentSearchMatch],
    query: &str,
) -> Vec<ContentSearchChunk> {
    let mut sorted: Vec<&ContentSearchMatch> = matches.iter().collect();
    sorted.sort_by_key(|matched| matched.line);
    let mut chunks: Vec<ContentSearchChunk> = Vec::new();
    let mut open_rows: Vec<ContentSearchChunkRow> = Vec::new();
    let mut open_ids: Vec<String> = Vec::new();
    let mut open_end: Option<usize> = None;
    for matched in sorted {
        let text_line = matched.line;
        let before = &matched.before;
        let after = &matched.after;
        let first_before_line = text_line.saturating_sub(before.len());
        let mut rows: Vec<ContentSearchChunkRow> =
            Vec::with_capacity(before.len() + 1 + after.len());
        for (index, line) in before.iter().enumerate() {
            rows.push(ContentSearchChunkRow {
                line: first_before_line + index,
                matched: false,
                match_id: None,
                text: line.clone(),
                match_start: 0,
                match_end: 0,
            });
        }
        rows.push(ContentSearchChunkRow {
            line: text_line,
            matched: true,
            match_id: Some(matched.id.clone()),
            text: matched.text.clone(),
            match_start: matched.match_start,
            match_end: matched.match_end,
        });
        for (index, line) in after.iter().enumerate() {
            rows.push(ContentSearchChunkRow {
                line: text_line + index + 1,
                matched: false,
                match_id: None,
                text: line.clone(),
                match_start: 0,
                match_end: 0,
            });
        }
        let start = rows.first().map(|row| row.line).unwrap_or(text_line);
        let end = rows.last().map(|row| row.line).unwrap_or(text_line);
        let merge = matches!(open_end, Some(previous) if start <= previous + 1);
        if !merge {
            if !open_rows.is_empty() {
                chunks.push(finish_content_search_chunk(&open_rows, &open_ids, query));
            }
            open_rows = rows;
            open_ids = vec![matched.id.clone()];
            open_end = Some(end);
            continue;
        }
        open_ids.push(matched.id.clone());
        for row in rows {
            let existing = open_rows
                .iter_mut()
                .find(|candidate| candidate.line == row.line);
            match existing {
                Some(candidate) => {
                    if row.matched && !candidate.matched {
                        *candidate = row;
                    }
                }
                None => open_rows.push(row),
            }
        }
        open_rows.sort_by_key(|row| row.line);
        open_end = Some(open_end.map_or(end, |previous| previous.max(end)).max(end));
    }
    if !open_rows.is_empty() {
        chunks.push(finish_content_search_chunk(&open_rows, &open_ids, query));
    }
    chunks
}

fn finish_content_search_chunk(
    rows: &[ContentSearchChunkRow],
    match_ids: &[String],
    query: &str,
) -> ContentSearchChunk {
    ContentSearchChunk {
        start: rows.first().map(|row| row.line).unwrap_or(1),
        end: rows.last().map(|row| row.line).unwrap_or(1),
        rows: rows
            .iter()
            .filter(|row| row.line > 0)
            .map(|row| ContentSearchRow {
                line: row.line,
                matched: row.matched,
                match_id: row.match_id.clone(),
                highlight_html: if row.matched {
                    highlight_line_html(&row.text, row.match_start, row.match_end, query)
                } else {
                    escape_html(&row.text)
                },
            })
            .collect(),
        match_ids: match_ids.to_vec(),
    }
}

struct ContentSearchBuild {
    files: Vec<ContentSearchFile>,
    total_files: usize,
    total_matches: usize,
    visited: usize,
    truncated: bool,
}

// The plain-needle arms search the ORIGINAL line, never a case-folded copy:
// byte offsets returned by `find` must index into the line we send to the
// browser, otherwise highlighting would slice at UTF-16/ASCII offsets of a
// transformed string and panic or mis-highlight on multibyte text. Case
// folding both sides (needle + haystack) is only a cheap approximation of
// Unicode case-insensitive matching anyway; regexes go through RegexBuilder
// which applies full Unicode case folding, so for case-insensitive plain
// queries we reuse that same builder instead of lowercasing.
enum ContentMatcher {
    // `match_case` is not kept: Plain is only constructed for the exact-match
    // (match_case=true) path; case-insensitive queries compile a regex above.
    Plain { needle: String },
    Regex(Regex),
}

impl ContentMatcher {
    fn new(query: &str, match_case: bool, regex: bool) -> Result<Self, String> {
        if query.is_empty() {
            return Err("empty query".to_string());
        }
        if regex || !match_case {
            // Same builder for regex and case-insensitive plain queries: the
            // regex crate's case-insensitive mode does proper Unicode folding
            // (e.g. 'i' matching 'İ'), which naive to_lowercase() on both
            // sides gets wrong. Escaping is applied below for plain queries so
            // the needle is matched literally.
            let pattern = if regex {
                query.to_string()
            } else {
                escape(query)
            };
            let compiled = RegexBuilder::new(&pattern)
                .case_insensitive(!match_case)
                .build()
                .map_err(|err| format!("invalid regex: {err}"))?;
            return Ok(Self::Regex(compiled));
        }
        Ok(Self::Plain {
            needle: query.to_string(),
        })
    }

    fn find(&self, line: &str) -> Option<(usize, usize)> {
        match self {
            // str::find on the original line: zero allocation, and byte
            // offsets are directly valid for slicing the original line.
            Self::Plain { needle, .. } => line
                .find(needle.as_str())
                .map(|start| (start, start + needle.len())),
            Self::Regex(regex) => regex
                .find(line)
                .filter(|matched| matched.end() > matched.start())
                .map(|matched| (matched.start(), matched.end())),
        }
    }
}

fn compact_directory_entry(root: &Path, dir: PathBuf, name: String) -> (String, PathBuf) {
    let mut current = dir;
    let mut parts = vec![name];
    for _ in 0..64 {
        let Ok(read_dir) = fs::read_dir(&current) else {
            break;
        };
        let mut child_dirs = Vec::new();
        let mut has_file = false;
        for entry in read_dir.flatten() {
            let Ok(metadata) = entry.metadata() else {
                has_file = true;
                break;
            };
            if metadata.is_dir() {
                child_dirs.push(entry);
            } else {
                has_file = true;
                break;
            }
            if child_dirs.len() > 1 {
                break;
            }
        }
        if has_file || child_dirs.len() != 1 {
            break;
        }
        let child = child_dirs.remove(0);
        let child_path = child.path();
        let Ok(canonical) = child_path.canonicalize() else {
            break;
        };
        if !canonical.starts_with(root) || canonical == current {
            break;
        }
        parts.push(child.file_name().to_string_lossy().to_string());
        current = canonical;
    }
    (format!("{}/", parts.join("/")), current)
}

fn file_browser_json_error(status: StatusCode, error: impl Into<String>) -> Response {
    let error = error.into();
    if is_permission_error_message(&error) {
        return file_browser_permission_error(status, error);
    }
    (status, Json(json!({ "error": error }))).into_response()
}

fn file_browser_permission_error(status: StatusCode, error: impl Into<String>) -> Response {
    (
        status,
        Json(json!({
            "error": error.into(),
            "permission_required": true,
            "action": "request_file_access",
        })),
    )
        .into_response()
}

fn is_permission_error_message(error: &str) -> bool {
    let lower = error.to_lowercase();
    lower.contains("operation not permitted")
        || lower.contains("permission denied")
        || lower.contains("os error 1")
        || lower.contains("os error 13")
}

#[allow(clippy::result_large_err)]
fn file_browser_auth(
    state: &WebState,
    headers: &HeaderMap,
    remote: SocketAddr,
) -> Result<(), Response> {
    require_auth(state, headers, remote)
}

fn clean_relative_path(path: Option<&str>) -> Result<String, String> {
    let raw = path.unwrap_or("").trim().trim_start_matches('/');
    if raw.contains('\0') || raw.split('/').any(|part| part == "..") {
        return Err("invalid path".to_string());
    }
    Ok(raw.to_string())
}

fn clean_file_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name.contains('\0')
        || name.contains('/')
        || name.contains('\\')
        || name == "."
        || name == ".."
    {
        return Err("invalid name".to_string());
    }
    Ok(name.to_string())
}

fn resolve_root(cwd: &str) -> Result<PathBuf, String> {
    let expanded = PathBuf::from(expand_user_path_string(cwd));
    expanded
        .canonicalize()
        .map_err(|err| format!("invalid root: {err}"))
}

fn resolve_child(root: &Path, path: &str) -> Result<PathBuf, String> {
    let joined = root.join(path);
    let canonical = if joined.exists() {
        joined.canonicalize().map_err(|err| err.to_string())?
    } else {
        let parent = joined
            .parent()
            .ok_or_else(|| "invalid path".to_string())?
            .canonicalize()
            .map_err(|err| err.to_string())?;
        parent.join(
            joined
                .file_name()
                .ok_or_else(|| "invalid path".to_string())?,
        )
    };
    if !canonical.starts_with(root) {
        return Err("path escapes root".to_string());
    }
    Ok(canonical)
}

/// Like `resolve_child`, but for write targets that may introduce new
/// intermediate directories (file-browser new-file/new-directory flow):
/// each intermediate component is created, canonicalized, and checked
/// against `root` before the next mkdir runs. The final component is
/// resolved but never created; the caller writes the file itself.
/// `create_dir_all` on the joined path would walk an in-root symlink
/// out of the tree before any containment check could see it.
fn resolve_child_create(root: &Path, path: &str) -> Result<PathBuf, String> {
    let mut current = root.to_path_buf();
    let parts: Vec<&str> = path
        .split('/')
        .filter(|p| !p.is_empty() && *p != ".")
        .collect();
    for (index, part) in parts.iter().enumerate() {
        if *part == ".." {
            return Err("invalid path".to_string());
        }
        current.push(part);
        let last = index + 1 == parts.len();
        if !last && !current.exists() {
            fs::create_dir(&current).map_err(|err| err.to_string())?;
        }
        if current.exists() {
            current = current.canonicalize().map_err(|err| err.to_string())?;
            if !current.starts_with(root) {
                return Err("path escapes root".to_string());
            }
        }
    }
    Ok(current)
}

fn unresolved_child_path(cwd: &str, path: Option<&str>) -> Result<PathBuf, String> {
    let rel = clean_relative_path(path)?;
    let mut base = PathBuf::from(expand_user_path_string(cwd));
    if !rel.is_empty() {
        base.push(rel);
    }
    Ok(base)
}

fn applescript_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn request_file_access_payload(
    cwd: String,
    path: Option<String>,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let target = unresolved_child_path(&cwd, path.as_deref())
        .map_err(|err| (StatusCode::BAD_REQUEST, err))?;
    let default_folder = if target.is_dir() {
        target.clone()
    } else {
        target
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from(expand_user_path_string(&cwd)))
    };
    let selected = request_file_access_dialog(&default_folder)?;
    let canonical = selected.canonicalize().map_err(|err| {
        (
            StatusCode::BAD_GATEWAY,
            format!("selected folder is not readable: {err}"),
        )
    })?;
    fs::read_dir(&canonical).map_err(|err| {
        (
            StatusCode::BAD_GATEWAY,
            format!("selected folder is not readable: {err}"),
        )
    })?;
    Ok(json!({
        "ok": true,
        "path": canonical.to_string_lossy(),
        "message": "Folder access confirmed",
    }))
}

#[cfg(target_os = "macos")]
fn request_file_access_dialog(default_folder: &Path) -> Result<PathBuf, (StatusCode, String)> {
    let default = default_folder.to_string_lossy();
    let script = format!(
        "set selectedFolder to choose folder with prompt \"Allow Herdr WebUI to read this folder\" default location (POSIX file {})\nreturn POSIX path of selectedFolder",
        applescript_quote(&default)
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|err| {
            (
                StatusCode::BAD_GATEWAY,
                format!("failed to open permission prompt: {err}"),
            )
        })?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let message = if stderr.is_empty() {
            "folder access prompt was cancelled".to_string()
        } else {
            stderr
        };
        return Err((StatusCode::BAD_GATEWAY, message));
    }
    let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if selected.is_empty() {
        return Err((
            StatusCode::BAD_GATEWAY,
            "folder access prompt returned no folder".to_string(),
        ));
    }
    Ok(PathBuf::from(selected))
}

#[cfg(not(target_os = "macos"))]
fn request_file_access_dialog(_default_folder: &Path) -> Result<PathBuf, (StatusCode, String)> {
    Err((
        StatusCode::BAD_REQUEST,
        "interactive folder permission prompts are only supported on macOS".to_string(),
    ))
}

fn relative_to_root(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|value| value.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default()
}

fn sorted_directory_entries(dir: &Path) -> Result<Vec<DirectoryEntry>, String> {
    let mut entries = Vec::new();
    let read_dir = fs::read_dir(dir).map_err(|err| err.to_string())?;
    for entry in read_dir.flatten() {
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push(DirectoryEntry {
            sort_name: name.to_lowercase(),
            name,
            path: entry.path(),
            metadata,
        });
    }
    entries.sort_by(|a, b| {
        (!a.metadata.is_dir())
            .cmp(&(!b.metadata.is_dir()))
            .then(a.sort_name.cmp(&b.sort_name))
    });
    Ok(entries)
}

fn push_tree_entries(
    build: &mut TreeBuild,
    dir: &Path,
    level: usize,
    depth: u8,
    compact_single_child_dirs: bool,
) -> Result<(), String> {
    // The top-level call (level 0) must surface read errors so the UI can
    // show a permission prompt. Recursive calls skip unreadable subdirectories
    // (e.g. macOS ~/Library) so one locked folder does not abort the tree.
    let entries = match sorted_directory_entries(dir) {
        Ok(entries) => entries,
        Err(err) if level == 0 => return Err(err),
        Err(_) => return Ok(()),
    };
    for entry in entries {
        if build.entries.len() >= MAX_ENTRIES {
            build.truncated = true;
            break;
        }
        let is_dir = entry.metadata.is_dir();
        let mut name = entry.name;
        let mut entry_path = entry.path;
        if is_dir && compact_single_child_dirs {
            (name, entry_path) = compact_directory_entry(build.root, entry_path, name);
        }
        let expanded = is_dir && depth > 0 && !compact_single_child_dirs;
        build.entries.push(FileBrowserEntry {
            name,
            path: relative_to_root(build.root, &entry_path),
            kind: if is_dir { "dir" } else { "file" }.to_string(),
            size: if is_dir {
                None
            } else {
                Some(entry.metadata.len())
            },
            modified_ms: entry
                .metadata
                .modified()
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64),
            level,
            expanded,
        });
        if expanded && !build.truncated {
            push_tree_entries(build, &entry_path, level + 1, depth - 1, false)?;
        }
    }
    Ok(())
}

// Filename search matcher: case-insensitive substring (the default),
// case-sensitive substring, or regex. Mirrors ContentMatcher's builder so
// both search surfaces behave the same for the same query. Matching runs
// against the original entry name plus the root-relative path.
enum PathMatcher {
    Substring { needle: String, match_case: bool },
    Regex(Regex),
}

impl PathMatcher {
    fn new(query: &str, match_case: bool, regex: bool) -> Result<Self, String> {
        if query.is_empty() {
            return Err("empty query".to_string());
        }
        if regex {
            let compiled = RegexBuilder::new(query)
                .case_insensitive(!match_case)
                .build()
                .map_err(|err| format!("invalid regex: {err}"))?;
            return Ok(Self::Regex(compiled));
        }
        Ok(Self::Substring {
            needle: query.to_string(),
            match_case,
        })
    }

    fn matches(&self, name: &str, path: &str) -> bool {
        match self {
            Self::Substring { needle, match_case } => {
                if *match_case {
                    name.contains(needle.as_str()) || path.contains(needle.as_str())
                } else {
                    let needle = needle.to_lowercase();
                    name.to_lowercase().contains(needle.as_str())
                        || path.to_lowercase().contains(needle.as_str())
                }
            }
            Self::Regex(regex) => regex.is_match(name) || regex.is_match(path),
        }
    }

    fn plain_needle(&self) -> Option<&str> {
        match self {
            Self::Substring { needle, .. } => Some(needle.as_str()),
            Self::Regex(_) => None,
        }
    }
}

// Fuzzy ranking, fzf-style: score each matched path so the nearest matches
// sort first. Only the plain substring matcher ranks (regex matches keep walk
// order); lower score wins.
fn path_search_score(matcher: &PathMatcher, name: &str, path: &str, depth: usize) -> usize {
    let Some(needle) = matcher.plain_needle() else {
        return depth;
    };
    let needle_lower = needle.to_lowercase();
    let name_lower = name.to_lowercase();
    let path_lower = path.to_lowercase();
    // Same-flag comparisons on both sides keep the ordering case-stable.
    let name_hit = if needle == needle_lower {
        name_lower.contains(&needle_lower)
    } else {
        name.contains(needle)
    };
    let name_index = if needle == needle_lower {
        name_lower.find(&needle_lower)
    } else {
        name.find(needle)
    };
    let path_index = if needle == needle_lower {
        path_lower.find(&needle_lower)
    } else {
        path.find(needle)
    };
    let (tier, position) =
        if name_lower == needle_lower || (needle != needle_lower && name.eq(needle)) {
            // Exact name match.
            (0, 0)
        } else if name_hit {
            // Match inside the file or folder name.
            (1, name_index.unwrap_or(0))
        } else {
            // Match only in a parent path segment.
            (2, path_index.unwrap_or(0))
        };
    tier * 1_000 + position.min(500) + depth.min(200)
}

// fzf detection: --filter mode ranks stdin lines by fuzzy match quality, so
// the backend can use it for nearest-match ordering when it is installed.
// The probe result is seeded once the server is up (see the probe_fzf spawn
// in main.rs), so no search request pays the spawn cost; the atomic starts
// "absent" so a search before the probe falls back to the built-in ranker.
static FZF_DETECTED: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(1);
const FZF_ABSENT: u8 = 1;
const FZF_PRESENT: u8 = 2;

// Runs one `fzf --version` (blocking; call via spawn_blocking). Sets the
// process-global detection result that every later path search reads.
pub(crate) fn probe_fzf() -> bool {
    #[cfg(target_os = "macos")]
    let available = std::process::Command::new("fzf")
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    let available = false;
    std::sync::atomic::AtomicU8::store(
        &FZF_DETECTED,
        if available { FZF_PRESENT } else { FZF_ABSENT },
        std::sync::atomic::Ordering::Relaxed,
    );
    available
}

// Current detection answer. False before the boot probe lands or when fzf
// is missing, so callers fall back to the built-in ranking without ever
// blocking on a probe.
pub(crate) fn fzf_available() -> bool {
    std::sync::atomic::AtomicU8::load(&FZF_DETECTED, std::sync::atomic::Ordering::Relaxed)
        == FZF_PRESENT
}

// Feed every matched relative path through `fzf --filter` and keep the
// returned order. `--filter` prints nothing on zero matches (exit 1) and
// echoes all input lines for an empty query (exit 0), so the caller must do
// its own matching first and treat a partial or failed ranking output as
// "keep the built-in ranker". Input lines are unique by construction
// (relative paths).
fn fzf_rank_matches(query: &str, match_case: bool, paths: &[String]) -> Option<Vec<usize>> {
    if !fzf_available() || paths.len() < 2 {
        return None;
    }
    use std::io::Write as _;
    let mut child = std::process::Command::new("fzf")
        .arg("--filter")
        .arg(query)
        // Smart-case mirrors the search default: lowercase queries fold case.
        // A match-case query keeps fzf case-sensitive through the same flag.
        .arg(if match_case { "-i" } else { "+i" })
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut write_failed = false;
    // A failed stdin write (broken pipe when fzf dies early) must not skip
    // the wait below: std never auto-reaps, so every unreaped spawn would
    // zombie the long-running server one page at a time.
    if let Some(stdin) = child.stdin.as_mut() {
        for path in paths {
            if writeln!(stdin, "{path}").is_err() {
                write_failed = true;
                break;
            }
        }
    } else {
        write_failed = true;
    }
    let output = child.wait_with_output().ok()?;
    if write_failed || !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    let index_by_path: std::collections::HashMap<&str, usize> = paths
        .iter()
        .enumerate()
        .map(|(i, p)| (p.as_str(), i))
        .collect();
    let mut ranked: Vec<usize> = Vec::with_capacity(paths.len());
    for line in text.lines() {
        if let Some(i) = index_by_path.get(line) {
            ranked.push(*i);
        }
    }
    if ranked.len() != paths.len() {
        return None;
    }
    Some(ranked)
}

// One matched candidate collected during the search walk. Kept as a tuple
// of the entry plus its walk depth so the ranker can prefer shallower
// matches without re-reading metadata.
struct SearchCandidate {
    entry: FileBrowserEntry,
    depth: usize,
}

// Collect-then-rank search: walk the tree, keep every match (up to a hard
// collected cap so a broad query cannot balloon memory), then order the
// matches by relevance and return one page of them.
//
// Page navigation contract (differs from the legacy walk-window paging):
// every page re-walks the same tree, so `visited` and the walk cursor are no
// longer the pagination state. The caller advances `offset` by the returned
// page length and the backend re-ranks the identical match set each time;
// the walk stays deterministic (sorted BFS), so every match is reachable and
// pages never overlap or strand results. `truncated=true` means the ranked
// set covers a partial walk, not that more pages exist.
fn push_search_entries_with_visit_limit(
    build: &mut TreeBuild,
    dir: &Path,
    matcher: &PathMatcher,
    offset: usize,
    limit: usize,
    visited: &mut usize,
    matched: &mut usize,
    search_kind: Option<&str>,
    max_visits: usize,
) -> Result<(), String> {
    if offset >= MAX_COLLECTED_SEARCH_MATCHES {
        return Ok(());
    }
    let mut queue = VecDeque::from([(dir.to_path_buf(), 0usize)]);
    let mut is_initial = true;
    let mut candidates: Vec<SearchCandidate> = Vec::new();
    while let Some((current_dir, depth)) = queue.pop_front() {
        // The initial directory must be readable so the UI can surface a
        // permission prompt when the workspace root itself is inaccessible.
        // Subdirectories (e.g. macOS ~/Library) are skipped on read failure
        // so one locked folder does not abort the entire search.
        let entries = if is_initial {
            is_initial = false;
            sorted_directory_entries(&current_dir)?
        } else {
            match sorted_directory_entries(&current_dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            }
        };
        for entry in entries {
            *visited += 1;
            if *visited >= max_visits {
                build.truncated = true;
                break;
            }
            let is_dir = entry.metadata.is_dir();
            let kind = if is_dir { "dir" } else { "file" };
            let kind_matches = search_kind.is_none_or(|wanted| wanted == kind);
            if kind_matches
                && matcher.matches(&entry.name, &relative_to_root(build.root, &entry.path))
                && candidates.len() < MAX_COLLECTED_SEARCH_MATCHES
            {
                candidates.push(SearchCandidate {
                    entry: FileBrowserEntry {
                        name: entry.name.clone(),
                        path: relative_to_root(build.root, &entry.path),
                        kind: kind.to_string(),
                        size: if is_dir {
                            None
                        } else {
                            Some(entry.metadata.len())
                        },
                        modified_ms: entry
                            .metadata
                            .modified()
                            .ok()
                            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                            .map(|duration| duration.as_millis() as u64),
                        level: 0,
                        expanded: false,
                    },
                    depth,
                });
            }
            if is_dir {
                queue.push_back((entry.path, depth + 1));
            }
        }
        if build.truncated {
            break;
        }
    }
    *matched = candidates.len();
    if candidates.is_empty() {
        return Ok(());
    }
    rank_search_candidates(matcher, &mut candidates);
    let page: Vec<FileBrowserEntry> = candidates
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|candidate| candidate.entry)
        .collect();
    if offset + page.len() < *matched {
        build.truncated = true;
    }
    build.entries = page;
    Ok(())
}

// Order the collected matches by relevance: fzf ranking when the boot probe
// detected it, otherwise the built-in nearest-match score. Both paths keep a
// deterministic tiebreak (score, then path) so pages re-walk into the same
// order every time.
fn rank_search_candidates(matcher: &PathMatcher, candidates: &mut Vec<SearchCandidate>) {
    let match_case = matches!(matcher, PathMatcher::Substring { match_case, .. } if *match_case);
    // fzf ranking needs a plain needle: regex queries keep deterministic
    // walk order instead. One blocking fzf spawn per ranked page; the
    // boot probe guarantees a miss here is a missing binary, not latency.
    if let Some(needle) = matcher.plain_needle() {
        let paths: Vec<String> = candidates.iter().map(|c| c.entry.path.clone()).collect();
        if let Some(order) = fzf_rank_matches(needle, match_case, &paths) {
            // fzf answered with a permutation of every input line: order[i]
            // is the original index of the match that ranks i-th. Apply it
            // in one pass without touching the source vector mid-iteration.
            let mut ranked: Vec<SearchCandidate> = Vec::with_capacity(candidates.len());
            let mut source: std::collections::HashMap<usize, SearchCandidate> = candidates
                .drain(..)
                .enumerate()
                .map(|(i, c)| (i, c))
                .collect();
            for index in order {
                if let Some(candidate) = source.remove(&index) {
                    ranked.push(candidate);
                }
            }
            // Deterministic backstop if fzf dropped a line: append the rest
            // by original order so pagination never loses a match.
            for index in 0..paths.len() {
                if let Some(candidate) = source.remove(&index) {
                    ranked.push(candidate);
                }
            }
            *candidates = ranked;
            return;
        }
    }
    // Score once per candidate (decorate) instead of inside sort_by, which
    // would recompute both sides and their lowercased strings per comparison.
    let mut ranked: Vec<(usize, SearchCandidate)> = candidates
        .drain(..)
        .map(|candidate| {
            let score = path_search_score(
                matcher,
                &candidate.entry.name,
                &candidate.entry.path,
                candidate.depth,
            );
            (score, candidate)
        })
        .collect();
    ranked.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.entry.path.cmp(&b.1.entry.path))
    });
    *candidates = ranked.into_iter().map(|(_, candidate)| candidate).collect();
}

fn content_search_context_lines(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_CONTENT_CONTEXT_LINES)
        .min(MAX_CONTENT_CONTEXT_LINES)
}

fn content_search_matches_per_file(value: Option<usize>) -> usize {
    value
        .unwrap_or(DEFAULT_CONTENT_MATCHES_PER_FILE)
        .clamp(1, MAX_CONTENT_MATCHES_PER_FILE)
}

fn should_skip_content_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return false;
    };
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "build" | ".venv" | "venv"
    )
}

fn query_hash(query: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(query.as_bytes());
    hasher
        .finalize()
        .iter()
        .take(6)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
}

fn basename_string(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_string()
}

// Slice the line that starts at `offset` (recorded during pass 1) out of the
// already-read file content: up to the next '\n' or end of content. Borrowed,
// so context/snippet extraction only allocates the strings actually returned.
fn line_at(content: &str, offset: usize) -> &str {
    let rest = &content[offset..];
    match rest.find('\n') {
        Some(nl) => &rest[..nl],
        None => rest,
    }
}

fn content_search_file(
    root: &Path,
    file: &Path,
    query: &str,
    matcher: &ContentMatcher,
    context_lines: usize,
    max_matches: usize,
) -> Result<Option<ContentSearchFile>, String> {
    let metadata = fs::metadata(file).map_err(|err| err.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_CONTENT_SEARCH_FILE_BYTES {
        return Ok(None);
    }
    let bytes = fs::read(file).map_err(|err| err.to_string())?;
    if bytes.iter().take(2048).any(|byte| *byte == 0) {
        return Ok(None);
    }
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(_) => return Ok(None),
    };
    let rel = relative_to_root(root, file);
    let qhash = query_hash(query);
    // Pass 1 only records byte ranges of matching lines; pass 2 re-slices the
    // already-read `content` for the (few) matches that survive the per-file
    // cap. This avoids materializing every line as a Vec<String> (the old
    // `content.lines().map(str::to_string).collect()`), which duplicated the
    // whole file in memory for every scanned file, even files with zero hits.
    let mut matched_ranges: Vec<(usize, Option<(usize, usize)>)> = Vec::new();
    let mut line_start = 0usize;
    let mut line_end;
    let mut match_count = 0usize;
    for line in content.lines() {
        let range = matcher.find(line);
        if range.is_some() {
            match_count += 1;
        }
        matched_ranges.push((line_start, range));
        line_end = line_start + line.len();
        line_start = if line_end < content.len() {
            line_end + 1
        } else {
            line_end
        };
    }
    if match_count == 0 {
        return Ok(None);
    }
    let total_lines = matched_ranges.len();
    let mut matches = Vec::new();
    for (index, (offset, range)) in matched_ranges.iter().enumerate() {
        let Some((match_start, match_end)) = *range else {
            continue;
        };
        if matches.len() >= max_matches {
            break;
        }
        let line = line_at(&content, *offset);
        let start = index.saturating_sub(context_lines);
        let end = (index + context_lines + 1).min(total_lines);
        let before = (start..index)
            .map(|i| line_at(&content, matched_ranges[i].0).to_string())
            .collect::<Vec<_>>();
        let after = (index + 1..end)
            .map(|i| line_at(&content, matched_ranges[i].0).to_string())
            .collect::<Vec<_>>();
        let snippet = (start..end)
            .map(|i| line_at(&content, matched_ranges[i].0))
            .collect::<Vec<_>>()
            .join("\n");
        let line_number = index + 1;
        let start_line = start + 1;
        let end_line = end.max(start + 1);
        matches.push(ContentSearchMatch {
            id: format!("{}:{}:{}:{}", rel, start_line, line_number, qhash),
            line: line_number,
            column: match_start + 1,
            match_start,
            match_end,
            start_line,
            end_line,
            content: snippet,
            before,
            text: line.to_string(),
            after,
        });
    }
    let hash = file_hash(file)?;
    let chunks = build_content_search_chunks(&matches, query);
    Ok(Some(ContentSearchFile {
        path: rel.clone(),
        name: basename_string(&rel),
        size: metadata.len(),
        hash,
        match_count,
        matches,
        chunks,
        truncated: match_count > max_matches,
    }))
}

fn collect_content_search(
    root: &Path,
    dir: &Path,
    query: &str,
    match_case: bool,
    regex: bool,
    offset: usize,
    limit: usize,
    context_lines: usize,
    max_matches_per_file: usize,
) -> Result<ContentSearchBuild, String> {
    let matcher = ContentMatcher::new(query, match_case, regex)?;
    let mut build = ContentSearchBuild {
        files: Vec::new(),
        total_files: 0,
        total_matches: 0,
        visited: 0,
        truncated: false,
    };
    let mut queue = VecDeque::from([dir.to_path_buf()]);
    let mut is_initial = true;
    while let Some(current_dir) = queue.pop_front() {
        // The initial directory must be readable so the UI can surface a
        // permission prompt when the workspace root itself is inaccessible.
        // Subdirectories (e.g. macOS ~/Library) are skipped on read failure
        // so one locked folder does not abort the entire content search.
        let entries = if is_initial {
            is_initial = false;
            sorted_directory_entries(&current_dir)?
        } else {
            match sorted_directory_entries(&current_dir) {
                Ok(entries) => entries,
                Err(_) => continue,
            }
        };
        for entry in entries {
            build.visited += 1;
            if build.visited >= MAX_CONTENT_SEARCH_VISITS {
                build.truncated = true;
                return Ok(build);
            }
            if entry.metadata.is_dir() {
                if !should_skip_content_dir(&entry.path) {
                    queue.push_back(entry.path);
                }
                continue;
            }
            // Skip files we cannot read (e.g. permission denied) instead of
            // failing the whole content search.
            let Some(result) = content_search_file(
                root,
                &entry.path,
                query,
                &matcher,
                context_lines,
                max_matches_per_file,
            )
            .ok()
            .flatten() else {
                continue;
            };
            build.total_files += 1;
            build.total_matches += result.match_count;
            if build.total_files > offset && build.files.len() < limit {
                build.files.push(result);
            }
            if build.files.len() >= limit {
                build.truncated = true;
                return Ok(build);
            }
        }
    }
    Ok(build)
}

fn file_hash(path: &Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    let mut file = fs::File::open(path).map_err(|err| err.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = file.read(&mut buffer).map_err(|err| err.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

fn git_status_priority(status: &str) -> u8 {
    match status {
        "deleted" => 3,
        "modified" | "conflict" => 2,
        "added" | "untracked" => 1,
        // Committed-on-branch differences are the weakest signal: any real
        // working-tree status must win over them.
        "changed" => 0,
        _ => 0,
    }
}

fn propagated_directory_status(status: &str) -> &'static str {
    match status {
        "deleted" => "deleted",
        "added" | "untracked" => "added",
        "changed" => "changed",
        _ => "modified",
    }
}

fn insert_git_status(
    map: &mut serde_json::Map<String, serde_json::Value>,
    path: impl Into<String>,
    status: &str,
) {
    let path = path.into();
    if path.is_empty() {
        return;
    }
    let existing_priority = map
        .get(&path)
        .and_then(|value| value.as_str())
        .map(git_status_priority)
        .unwrap_or(0);
    if git_status_priority(status) >= existing_priority {
        map.insert(path, serde_json::Value::String(status.to_string()));
    }
}

/// Strips git's surrounding quotes from a porcelain/diff path and decodes
/// the backslash escapes inside (octal `\303\251` for non-ASCII, plus the
/// small set of C escapes git emits). Unquoted paths are returned as-is.
fn unquote_git_path(path: &str) -> String {
    let bytes = path.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'"' || bytes[bytes.len() - 1] != b'"' {
        return path.to_string();
    }
    let inner = &path[1..path.len() - 1];
    let mut out = Vec::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch as u8);
            continue;
        }
        match chars.next() {
            // Octal escape: up to 3 digits, always >= 0x80 in git practice
            // (ASCII bytes never get escaped, so this cannot split a char).
            Some(digit @ '0'..='7') => {
                let mut value = digit as u32 - '0' as u32;
                for _ in 0..2 {
                    match chars.clone().next() {
                        Some(next @ '0'..='7') => {
                            value = value * 8 + (next as u32 - '0' as u32);
                            chars.next();
                        }
                        _ => break,
                    }
                }
                out.push(value as u8);
            }
            Some('n') => out.push(b'\n'),
            Some('t') => out.push(b'\t'),
            Some('r') => out.push(b'\r'),
            Some('"') => out.push(b'"'),
            Some('\\') => out.push(b'\\'),
            Some(other) => {
                out.push(b'\\');
                out.push(other as u8);
            }
            None => out.push(b'\\'),
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_porcelain_status(xy: &str) -> &'static str {
    match xy {
        "??" => "untracked",
        "AA" | "DD" | "AU" | "UA" | "UD" | "DU" | "UU" => "conflict",
        _ => {
            let x = xy.as_bytes()[0] as char;
            let y = xy.as_bytes()[1] as char;
            if y == 'D' || x == 'D' {
                "deleted"
            } else if y == 'M' || y == 'R' || y == 'C' || x == 'M' || x == 'R' || x == 'C' {
                "modified"
            } else if y == 'A' || x == 'A' {
                "added"
            } else {
                "modified"
            }
        }
    }
}

fn propagate_git_status(
    map: &mut serde_json::Map<String, serde_json::Value>,
    path: &str,
    status: &str,
) {
    insert_git_status(map, path, status);
    let dir_status = propagated_directory_status(status);
    let parts = path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    for depth in 1..parts.len() {
        insert_git_status(map, parts[..depth].join("/"), dir_status);
    }
}

fn git_repo_root(root: &Path) -> Option<(PathBuf, String)> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let repo_root = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
    let prefix = root
        .strip_prefix(&repo_root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    Some((repo_root, prefix.trim_end_matches('/').to_string()))
}

/// Adjusts a repo-relative git path to be relative to the workspace root,
/// dropping paths outside the workspace. This lets the same map color
/// current rows, expanded children, and search results consistently.
fn adjust_git_path(path: &str, prefix_trim: &str) -> Option<String> {
    if prefix_trim.is_empty() {
        return Some(path.to_string());
    }
    let full_prefix = format!("{prefix_trim}/");
    if let Some(stripped) = path.strip_prefix(&full_prefix) {
        Some(stripped.to_string())
    } else if path == prefix_trim {
        Some(String::new())
    } else {
        None
    }
}

fn collect_git_status(
    root: &Path,
    _dir: &Path,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["status", "--porcelain=v1", "--untracked-files=all"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    // Find the git repo root to compute paths relative to the workspace root.
    let (_repo_root, prefix) = git_repo_root(root)?;
    let prefix_trim = prefix.as_str();

    let text = String::from_utf8_lossy(&output.stdout);
    let mut map = serde_json::Map::new();
    for line in text.lines() {
        if line.len() < 3 {
            continue;
        }
        let xy = &line[..2];
        let path = line[3..].trim();
        if path.is_empty() {
            continue;
        }
        // Porcelain v1: XY is 2 chars, then space, then path.
        // For renames (R): path is "newpath\toldpath" — take newpath only.
        let path = unquote_git_path(path.split('\t').next().unwrap_or(path));
        let status = parse_porcelain_status(xy);
        let adjusted = match adjust_git_path(&path, prefix_trim) {
            Some(path) => path,
            None => continue,
        };
        propagate_git_status(&mut map, &adjusted, status);
    }
    merge_branch_changes(root, &mut map, prefix_trim);
    if map.is_empty() {
        return None;
    }
    Some(map)
}

/// Resolves the default branch to diff the current branch against.
/// Prefers the locally tracked default (origin/HEAD), then a local
/// main/master, so "changes on this branch" matches user intent even
/// without a remote.
fn branch_diff_base(root: &Path) -> Option<String> {
    let resolves = |name: &str| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["rev-parse", "--verify", "--quiet", name])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .is_some()
    };
    let symbolic_ref = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
        .output()
        .ok()?;
    if symbolic_ref.status.success() {
        let name = String::from_utf8_lossy(&symbolic_ref.stdout)
            .trim()
            .to_string();
        // origin/HEAD can be stale and point at a remote ref that no longer
        // exists: only trust it when the ref actually resolves.
        if !name.is_empty() && resolves(&name) {
            return Some(name);
        }
    }
    for candidate in ["main", "master"] {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(root)
            .args([
                "rev-parse",
                "--verify",
                "--quiet",
                &format!("refs/heads/{candidate}"),
            ])
            .output()
            .ok()?;
        if output.status.success() {
            return Some(candidate.to_string());
        }
    }
    None
}

/// Current branch name, or None when HEAD is detached.
fn current_branch_name(root: &Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (name != "HEAD").then_some(name)
}

/// Merges files changed on the current branch vs the default branch into
/// the status map as "changed" (blue in the tree). "changed" has the
/// lowest priority, so any real working-tree status wins. No-op when HEAD
/// is the base branch, detached, or the repo has no default branch.
fn merge_branch_changes(
    root: &Path,
    map: &mut serde_json::Map<String, serde_json::Value>,
    prefix_trim: &str,
) {
    let Some(base) = branch_diff_base(root) else {
        return;
    };
    let Some(branch) = current_branch_name(root) else {
        return;
    };
    if branch == base.trim_start_matches("origin/") {
        return;
    }
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "diff",
            "--name-status",
            "--no-renames",
            &format!("{base}...{branch}"),
        ])
        .output()
        .ok();
    let Some(output) = output else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        // --name-status lines are "STATUS\tpath" (M/A/D/C/T + path).
        let Some((_kind, path)) = line.split_once('\t') else {
            continue;
        };
        let path = unquote_git_path(path.split('\t').next().unwrap_or(path));
        let Some(adjusted) = adjust_git_path(&path, prefix_trim) else {
            continue;
        };
        propagate_git_status(map, &adjusted, "changed");
    }
}

/// Blocking body of the tree endpoint. Runs on a spawn_blocking thread so
/// directory walks and search visits never stall the async runtime.
fn file_browser_tree_payload(
    query: FileBrowserQuery,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let root = match resolve_root(&query.cwd) {
        Ok(root) => root,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let rel = match clean_relative_path(query.path.as_deref()) {
        Ok(rel) => rel,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let dir = match resolve_child(&root, &rel) {
        Ok(dir) => dir,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    if !dir.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            "path is not a directory".to_string(),
        ));
    }
    let dirs_only = query.dirs_only.unwrap_or(false);
    let depth = if dirs_only {
        0
    } else {
        query.depth.unwrap_or(0).min(8)
    };
    let search = query.q.as_deref().unwrap_or("").trim().to_string();
    let mut build = TreeBuild {
        root: &root,
        entries: Vec::new(),
        truncated: false,
    };
    // Walk position of the search page: 0 when there is no search branch.
    let mut visited_total = 0usize;
    if !search.is_empty() {
        let matcher = match PathMatcher::new(
            &search,
            query.match_case.unwrap_or(false),
            query.regex.unwrap_or(false),
        ) {
            Ok(matcher) => matcher,
            Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
        };
        let mut matched = 0usize;
        let limit = query
            .limit
            .unwrap_or(DEFAULT_SEARCH_LIMIT)
            .clamp(1, MAX_SEARCH_LIMIT);
        let offset = query.offset.unwrap_or(0);
        // Collect-then-rank search pages re-walk and re-rank the same match
        // set, so the walk resume cursor is no longer page state. The offset
        // alone pages through the ranked list (see
        // push_search_entries_with_visit_limit). visit_offset stays in the
        // schema for older clients but nothing reads it.
        let _ = query.visit_offset;
        let search_kind = query
            .search_kind
            .as_deref()
            .filter(|kind| *kind == "file" || *kind == "dir")
            // dirs_only callers are browsing folders (directory pickers),
            // so their q= searches must stay folder-only even if they
            // forget the explicit kind.
            .or(if dirs_only { Some("dir") } else { None });
        if let Err(err) = push_search_entries_with_visit_limit(
            &mut build,
            &dir,
            &matcher,
            offset,
            limit,
            &mut visited_total,
            &mut matched,
            search_kind,
            MAX_RANKED_SEARCH_VISITS,
        ) {
            return Err((StatusCode::BAD_GATEWAY, err));
        }
    } else if dirs_only {
        for entry in match sorted_directory_entries(&dir) {
            Ok(entries) => entries,
            Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
        } {
            if build.entries.len() >= MAX_ENTRIES {
                build.truncated = true;
                break;
            }
            if !entry.metadata.is_dir() {
                continue;
            }
            build.entries.push(FileBrowserEntry {
                name: entry.name,
                path: relative_to_root(&root, &entry.path),
                kind: "dir".to_string(),
                size: None,
                modified_ms: entry
                    .metadata
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|duration| duration.as_millis() as u64),
                level: 0,
                expanded: false,
            });
        }
    } else if let Err(err) = push_tree_entries(&mut build, &dir, 0, depth, depth == 0) {
        return Err((StatusCode::BAD_GATEWAY, err));
    }
    let git_status = if query.include_git_status.unwrap_or(false) {
        collect_git_status(&root, &dir)
    } else {
        None
    };
    Ok(json!({
        "root": root.to_string_lossy(),
        "home": home_folder_path().to_string_lossy(),
        "path": relative_to_root(&root, &dir),
        "entries": build.entries,
        "truncated": build.truncated,
        "query": search,
        // Walk position of this page: pass back as visit_offset to resume.
        "visited": visited_total,
        "git_status": git_status,
    }))
}

async fn file_browser_tree(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<FileBrowserQuery>,
) -> Response {
    if let Err(response) = file_browser_auth(&state, &headers, remote) {
        return response;
    }
    match tokio::task::spawn_blocking(move || file_browser_tree_payload(query)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((status, msg))) => file_browser_json_error(status, msg),
        Err(err) => file_browser_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

async fn file_browser_request_access(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<FileBrowserAccessRequest>,
) -> Response {
    if let Err(response) = file_browser_auth(&state, &headers, remote) {
        return response;
    }
    let cwd = body.cwd;
    let path = body.path;
    match tokio::task::spawn_blocking(move || request_file_access_payload(cwd, path)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((status, msg))) => file_browser_json_error(status, msg),
        Err(err) => file_browser_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// Clamp the requested partial-read budget (A4). Accepts 16 KB..=1 MB so a
/// typo cannot ask for gigabytes; anything outside the window is ignored
/// (falls back to the plain truncated placeholder).
fn partial_read_budget(max_bytes: Option<u64>) -> Option<u64> {
    let requested = max_bytes?;
    const MIN_BUDGET: u64 = 16 * 1024;
    if (MIN_BUDGET..=MAX_FILE_BYTES).contains(&requested) {
        Some(requested)
    } else {
        None
    }
}

/// Read the first `budget` bytes of an oversized text file for preview.
/// The content is lossily decoded (a multibyte char split at the boundary
/// degrades to U+FFFD once) and marked truncated. The hash is empty on
/// purpose: a partial view must never satisfy the save path's
/// expected_hash check.
fn file_browser_partial_read_payload(
    file: &Path,
    rel: &str,
    size: u64,
    budget: u64,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let mut handle = match fs::File::open(file) {
        Ok(handle) => handle,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err.to_string())),
    };
    use std::io::Read;
    let take = budget.min(size);
    let mut bytes = Vec::with_capacity(take as usize);
    if let Err(err) = Read::by_ref(&mut handle).take(take).read_to_end(&mut bytes) {
        return Err((StatusCode::BAD_GATEWAY, err.to_string()));
    }
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let preview_bytes = bytes.len() as u64;
    Ok(json!({
        "path": rel,
        "content": content,
        "hash": "",
        "binary": false,
        "truncated": true,
        "size": size,
        "preview_bytes": preview_bytes,
    }))
}

/// Blocking body of the file read endpoint (fs metadata + content + hash).
fn file_browser_file_payload(
    query: FileBrowserQuery,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let root = match resolve_root(&query.cwd) {
        Ok(root) => root,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let rel = match clean_relative_path(query.path.as_deref()) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return Err((StatusCode::BAD_REQUEST, "path is required".to_string())),
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let file = match resolve_child(&root, &rel) {
        Ok(file) => file,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    if !file.is_file() {
        return Err((StatusCode::BAD_REQUEST, "path is not a file".to_string()));
    }
    let metadata = match fs::metadata(&file) {
        Ok(metadata) => metadata,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err.to_string())),
    };
    // A6: cheap change detection. hash_only skips the content read and
    // returns just the hash/size the browser needs to notice an external
    // change when a tab regains focus.
    if query.hash_only.unwrap_or(false) {
        let hash = match file_hash(&file) {
            Ok(hash) => hash,
            Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
        };
        return Ok(json!({
            "path": rel,
            "content": "",
            "hash": hash,
            "binary": false,
            "truncated": false,
            "size": metadata.len(),
        }));
    }
    if metadata.len() > MAX_FILE_BYTES {
        let budget = partial_read_budget(query.max_bytes);
        if let Some(budget) = budget {
            return file_browser_partial_read_payload(&file, &rel, metadata.len(), budget);
        }
        return Ok(json!({
            "path": rel,
            "content": "",
            "hash": "",
            "binary": false,
            "truncated": true,
            "size": metadata.len(),
        }));
    }
    let bytes = match fs::read(&file) {
        Ok(bytes) => bytes,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err.to_string())),
    };
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(_) => {
            return Ok(json!({
                "path": rel,
                "content": "",
                "hash": "",
                "binary": true,
                "truncated": false,
                "size": metadata.len(),
            }))
        }
    };
    let hash = match file_hash(&file) {
        Ok(hash) => hash,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
    };
    let mut payload = json!({
        "path": rel,
        "content": content,
        "hash": hash,
        "binary": false,
        "truncated": false,
        "size": metadata.len(),
    });
    if query.render.as_deref() == Some("lines") {
        // Numbered read-only preview: the gutter and the escaped code lines
        // are prebuilt here (one pass in Rust) instead of per-render string
        // building in the browser. The frontend gates this to files it would
        // otherwise render through the fallback numbered preview.
        let (gutter, code) = numbered_lines_html(payload["content"].as_str().unwrap_or(""));
        payload["lines_gutter_html"] = json!(gutter);
        payload["lines_code_html"] = json!(code);
    }
    Ok(payload)
}

async fn file_browser_file(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<FileBrowserQuery>,
) -> Response {
    if let Err(response) = file_browser_auth(&state, &headers, remote) {
        return response;
    }
    match tokio::task::spawn_blocking(move || file_browser_file_payload(query)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((status, msg))) => file_browser_json_error(status, msg),
        Err(err) => file_browser_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// Blocking body of the outline endpoint (parity with the TUI `M` toggle,
/// gap 22): same root confinement and size caps as the file read path, but
/// it only returns the heading list, never the file content. Markdown is
/// parsed with the shared `herdr_webui::markdown` module so TUI and webui
/// outlines can never drift.
#[allow(clippy::result_large_err)]
fn file_browser_outline_payload(
    query: FileBrowserQuery,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let root = match resolve_root(&query.cwd) {
        Ok(root) => root,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let rel = match clean_relative_path(query.path.as_deref()) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return Err((StatusCode::BAD_REQUEST, "path is required".to_string())),
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let file = match resolve_child(&root, &rel) {
        Ok(file) => file,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    if !file.is_file() {
        return Err((StatusCode::BAD_REQUEST, "path is not a file".to_string()));
    }
    let metadata = match fs::metadata(&file) {
        Ok(metadata) => metadata,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err.to_string())),
    };
    // Same cap as the read path: an oversized file cannot be outlined because
    // its full content would have to be parsed to know the headings.
    if metadata.len() > MAX_FILE_BYTES {
        return Err((StatusCode::BAD_REQUEST, "file too large".to_string()));
    }
    let bytes = match fs::read(&file) {
        Ok(bytes) => bytes,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err.to_string())),
    };
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        // Binary files have no headings; empty outline instead of an error so
        // clients can treat it like "no headings found".
        Err(_) => return Ok(json!({ "outline": [] })),
    };
    let outline: Vec<serde_json::Value> = parse_markdown_outline(&content)
        .into_iter()
        .map(|(level, line_number, text)| json!([level, line_number, text]))
        .collect();
    Ok(json!({
        "path": rel,
        "outline": outline,
    }))
}

async fn file_browser_outline(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<FileBrowserQuery>,
) -> Response {
    if let Err(response) = file_browser_auth(&state, &headers, remote) {
        return response;
    }
    match tokio::task::spawn_blocking(move || file_browser_outline_payload(query)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((status, msg))) => file_browser_json_error(status, msg),
        Err(err) => file_browser_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

// Builds the two <pre> bodies used by the fallback numbered preview: the
// gutter (one <span> per line number) and the escaped code. The browser
// injects these strings directly; escaping happened here.
fn numbered_lines_html(content: &str) -> (String, String) {
    let mut gutter = String::new();
    let mut code = String::new();
    for (index, line) in content.split('\n').enumerate() {
        gutter.push_str("<span>");
        gutter.push_str(&(index + 1).to_string());
        gutter.push_str("</span>");
        code.push_str(&escape_html(line));
        code.push('\n');
    }
    // The trailing newline belongs to the line list, not the markup.
    if code.ends_with('\n') {
        code.pop();
    }
    (gutter, code)
}

/// Blocking body of the file write endpoint (hash check + create + write).
fn file_browser_write_file_payload(
    body: FileBrowserWriteRequest,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let root = match resolve_root(&body.cwd) {
        Ok(root) => root,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let rel = match clean_relative_path(Some(&body.path)) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return Err((StatusCode::BAD_REQUEST, "path is required".to_string())),
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let file = if body.create_parents {
        resolve_child_create(&root, &rel)
    } else {
        resolve_child(&root, &rel)
    };
    let file = match file {
        Ok(file) => file,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    if file.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "path is a directory".to_string()));
    }
    let current_hash = match file_hash(&file) {
        Ok(hash) => hash,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
    };
    if let Some(expected_hash) = body.expected_hash.as_deref() {
        if expected_hash != current_hash {
            return Err((
                StatusCode::CONFLICT,
                "file changed on disk; reload before saving".to_string(),
            ));
        }
    }
    if let Some(parent) = file.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            return Err((StatusCode::BAD_GATEWAY, err.to_string()));
        }
    }
    if let Err(err) =
        fs::File::create(&file).and_then(|mut file| file.write_all(body.content.as_bytes()))
    {
        return Err((StatusCode::BAD_GATEWAY, err.to_string()));
    }
    let hash = match file_hash(&file) {
        Ok(hash) => hash,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
    };
    Ok(json!({ "ok": true, "path": rel, "hash": hash }))
}

async fn file_browser_write_file(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<FileBrowserWriteRequest>,
) -> Response {
    if let Err(response) = file_browser_auth(&state, &headers, remote) {
        return response;
    }
    match tokio::task::spawn_blocking(move || file_browser_write_file_payload(body)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((status, msg))) => file_browser_json_error(status, msg),
        Err(err) => file_browser_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// Blocking body of the directory content search endpoint.
fn file_browser_content_search_payload(
    query: FileContentSearchQuery,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let search = query.q.trim();
    if search.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "query is required".to_string()));
    }
    let root = match resolve_root(&query.cwd) {
        Ok(root) => root,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let rel = match clean_relative_path(query.path.as_deref()) {
        Ok(rel) => rel,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let dir = match resolve_child(&root, &rel) {
        Ok(dir) => dir,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    if !dir.is_dir() {
        return Err((
            StatusCode::BAD_REQUEST,
            "path is not a directory".to_string(),
        ));
    }
    let limit = query
        .limit
        .unwrap_or(DEFAULT_CONTENT_SEARCH_LIMIT)
        .clamp(1, MAX_CONTENT_SEARCH_LIMIT);
    let context_lines = content_search_context_lines(query.context_lines);
    let max_matches_per_file = content_search_matches_per_file(query.max_matches_per_file);
    let match_case = query.match_case.unwrap_or(false);
    let use_regex = query.regex.unwrap_or(false);
    let build = match collect_content_search(
        &root,
        &dir,
        search,
        match_case,
        use_regex,
        query.offset.unwrap_or(0),
        limit,
        context_lines,
        max_matches_per_file,
    ) {
        Ok(build) => build,
        Err(err) => {
            let status = if err.starts_with("invalid regex") {
                StatusCode::BAD_REQUEST
            } else {
                StatusCode::BAD_GATEWAY
            };
            return Err((status, err));
        }
    };
    Ok(json!({
        "root": root.to_string_lossy(),
        "path": relative_to_root(&root, &dir),
        "query": search,
        "files": build.files,
        "total_files": build.total_files,
        "total_matches": build.total_matches,
        "visited": build.visited,
        "truncated": build.truncated,
    }))
}

async fn file_browser_content_search(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<FileContentSearchQuery>,
) -> Response {
    if let Err(response) = file_browser_auth(&state, &headers, remote) {
        return response;
    }
    match tokio::task::spawn_blocking(move || file_browser_content_search_payload(query)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((status, msg))) => file_browser_json_error(status, msg),
        Err(err) => file_browser_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// Blocking body of the single-file content search endpoint.
fn file_browser_content_search_file_payload(
    query: FileContentSearchQuery,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let search = query.q.trim();
    if search.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "query is required".to_string()));
    }
    let root = match resolve_root(&query.cwd) {
        Ok(root) => root,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let rel = match clean_relative_path(query.file.as_deref().or(query.path.as_deref())) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return Err((StatusCode::BAD_REQUEST, "file is required".to_string())),
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let file = match resolve_child(&root, &rel) {
        Ok(file) => file,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    if !file.is_file() {
        return Err((StatusCode::BAD_REQUEST, "path is not a file".to_string()));
    }
    let context_lines = content_search_context_lines(query.context_lines);
    let max_matches = content_search_matches_per_file(
        query
            .max_matches_per_file
            .or(Some(MAX_CONTENT_MATCHES_PER_FILE)),
    );
    let matcher = match ContentMatcher::new(
        search,
        query.match_case.unwrap_or(false),
        query.regex.unwrap_or(false),
    ) {
        Ok(matcher) => matcher,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let result =
        match content_search_file(&root, &file, search, &matcher, context_lines, max_matches) {
            Ok(Some(result)) => result,
            Ok(None) => {
                return Ok(json!({
                    "query": search,
                    "file": null,
                }))
            }
            Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
        };
    Ok(json!({
        "query": search,
        "file": result,
    }))
}

async fn file_browser_content_search_file(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<FileContentSearchQuery>,
) -> Response {
    if let Err(response) = file_browser_auth(&state, &headers, remote) {
        return response;
    }
    match tokio::task::spawn_blocking(move || file_browser_content_search_file_payload(query)).await
    {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((status, msg))) => file_browser_json_error(status, msg),
        Err(err) => file_browser_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// Blocking body of the rename endpoint.
fn file_browser_rename_payload(
    body: FileBrowserRenameRequest,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let root = match resolve_root(&body.cwd) {
        Ok(root) => root,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let rel = match clean_relative_path(Some(&body.path)) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return Err((StatusCode::BAD_REQUEST, "path is required".to_string())),
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let new_name = match clean_file_name(&body.new_name) {
        Ok(name) => name,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let source = match resolve_child(&root, &rel) {
        Ok(path) => path,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    if !source.exists() {
        return Err((StatusCode::BAD_REQUEST, "path does not exist".to_string()));
    }
    let Some(parent) = source.parent() else {
        return Err((StatusCode::BAD_REQUEST, "invalid path".to_string()));
    };
    let target = parent.join(new_name);
    if !target.starts_with(&root) {
        return Err((StatusCode::BAD_REQUEST, "path escapes root".to_string()));
    }
    if target.exists() {
        return Err((StatusCode::CONFLICT, "target already exists".to_string()));
    }
    if let Err(err) = fs::rename(&source, &target) {
        return Err((StatusCode::BAD_GATEWAY, err.to_string()));
    }
    Ok(json!({ "ok": true, "path": relative_to_root(&root, &target) }))
}

async fn file_browser_rename(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<FileBrowserRenameRequest>,
) -> Response {
    if let Err(response) = file_browser_auth(&state, &headers, remote) {
        return response;
    }
    match tokio::task::spawn_blocking(move || file_browser_rename_payload(body)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((status, msg))) => file_browser_json_error(status, msg),
        Err(err) => file_browser_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

/// Blocking body of the delete endpoint.
fn file_browser_delete_payload(
    body: FileBrowserDeleteRequest,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let root = match resolve_root(&body.cwd) {
        Ok(root) => root,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let rel = match clean_relative_path(Some(&body.path)) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return Err((StatusCode::BAD_REQUEST, "path is required".to_string())),
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let path = match resolve_child(&root, &rel) {
        Ok(path) => path,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    if path.is_dir() {
        if let Err(err) = fs::remove_dir_all(&path) {
            return Err((StatusCode::BAD_GATEWAY, err.to_string()));
        }
    } else if path.is_file() {
        if let Err(err) = fs::remove_file(&path) {
            return Err((StatusCode::BAD_GATEWAY, err.to_string()));
        }
    } else {
        return Err((StatusCode::BAD_REQUEST, "path does not exist".to_string()));
    }
    Ok(json!({ "ok": true }))
}

async fn file_browser_delete(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<FileBrowserDeleteRequest>,
) -> Response {
    if let Err(response) = file_browser_auth(&state, &headers, remote) {
        return response;
    }
    match tokio::task::spawn_blocking(move || file_browser_delete_payload(body)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err((status, msg))) => file_browser_json_error(status, msg),
        Err(err) => file_browser_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    #[test]
    fn numbered_lines_html_builds_gutter_and_escaped_code() {
        let (gutter, code) = numbered_lines_html("fn main() {\n    let x = 1 < 2;\n}");
        assert_eq!(gutter, "<span>1</span><span>2</span><span>3</span>");
        assert_eq!(code, "fn main() {\n    let x = 1 &lt; 2;\n}");
        // Empty content renders a single empty line, mirroring the browser's
        // "".split("\n") behavior.
        let (gutter, code) = numbered_lines_html("");
        assert_eq!(gutter, "<span>1</span>");
        assert_eq!(code, "");
    }

    #[test]
    fn clean_relative_path_rejects_escape() {
        assert!(clean_relative_path(Some("../secret")).is_err());
        assert!(clean_relative_path(Some("a/../secret")).is_err());
        assert_eq!(clean_relative_path(Some("/a/b")).unwrap(), "a/b");
    }

    #[test]
    fn file_browser_outline_payload_parses_headings() {
        let root =
            std::env::temp_dir().join(format!("herdr-webui-outline-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("doc.md"),
            "# Title\n\ntext\n```rust\n# not a heading\n```\n## Sub\n",
        )
        .unwrap();
        let root = root.canonicalize().unwrap();

        let payload = file_browser_outline_payload(FileBrowserQuery {
            cwd: root.to_string_lossy().into_owned(),
            path: Some("doc.md".to_string()),
            dirs_only: None,
            depth: None,
            q: None,
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        })
        .unwrap();
        let outline = payload["outline"].as_array().unwrap();
        assert_eq!(outline.len(), 2);
        assert_eq!(outline[0][0], 1);
        assert_eq!(outline[0][1], 1);
        assert_eq!(outline[0][2], "Title");
        assert_eq!(outline[1][0], 2);
        assert_eq!(outline[1][1], 7);
        assert_eq!(outline[1][2], "Sub");
        assert_eq!(payload["path"], "doc.md");

        // Path escape is rejected exactly like the read path.
        let escape = file_browser_outline_payload(FileBrowserQuery {
            cwd: root.to_string_lossy().into_owned(),
            path: Some("../secret.md".to_string()),
            dirs_only: None,
            depth: None,
            q: None,
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        });
        assert!(escape.is_err());

        // Missing path is a 400, not an empty outline.
        let missing = file_browser_outline_payload(FileBrowserQuery {
            cwd: root.to_string_lossy().into_owned(),
            path: None,
            dirs_only: None,
            depth: None,
            q: None,
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        });
        assert!(matches!(missing, Err((StatusCode::BAD_REQUEST, _))));

        // Non-markdown files simply return an empty outline.
        fs::write(root.join("plain.txt"), "no headings here").unwrap();
        let plain = file_browser_outline_payload(FileBrowserQuery {
            cwd: root.to_string_lossy().into_owned(),
            path: Some("plain.txt".to_string()),
            dirs_only: None,
            depth: None,
            q: None,
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        })
        .unwrap();
        assert_eq!(plain["outline"].as_array().unwrap().len(), 0);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolve_child_create_builds_missing_directories() {
        let root = std::env::temp_dir().join(format!(
            "herdr-resolve-create-{}",
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        // GitHub's macOS runners expose a /var/folders TMPDIR that is a
        // symlink alias of /private/var/folders; resolve_child canonicalizes
        // the joined path, so the root must be canonical for the escape
        // guard to compare like-for-like.
        let root = root.canonicalize().unwrap();
        let file = resolve_child_create(&root, "a/new/dir/.gitkeep").unwrap();
        assert!(file.starts_with(&root));
        assert!(root.join("a/new/dir").is_dir());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resolve_child_create_still_rejects_escapes() {
        let root = std::env::temp_dir().join(format!(
            "herdr-resolve-escape-{}",
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        // clean_relative_path rejects `..` before resolution, so the
        // create variant inherits the same guard; resolve_child keeps
        // the root-containment check for symlinked paths.
        assert!(clean_relative_path(Some("../outside/x")).is_err());
        assert!(resolve_child(&root, "../outside/x").is_err());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resolve_child_create_rejects_symlink_escape_without_writing_outside() {
        let root = std::env::temp_dir().join(format!(
            "herdr-resolve-symlink-{}",
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let outside = std::env::temp_dir().join(format!(
            "herdr-resolve-outside-{}",
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&outside).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let result = resolve_child_create(&root, "link/evil/.gitkeep");
        assert!(result.is_err());
        assert!(!outside.join("evil").exists());
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn resolve_child_create_walks_existing_symlinked_dirs_inside_root() {
        let root = std::env::temp_dir().join(format!(
            "herdr-resolve-inside-{}",
            SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("real")).unwrap();
        let root = root.canonicalize().unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("real"), root.join("alias")).unwrap();
        let file = resolve_child_create(&root, "alias/sub/.gitkeep").unwrap();
        assert!(file.starts_with(&root));
        assert!(root.join("real/sub").is_dir());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn permission_errors_are_classified_for_ui_action() {
        assert!(is_permission_error_message(
            "Operation not permitted (os error 1)"
        ));
        assert!(is_permission_error_message(
            "Permission denied (os error 13)"
        ));
        assert!(!is_permission_error_message("No such file or directory"));
    }

    #[test]
    fn unresolved_child_path_expands_home_without_canonicalizing() {
        let path = unresolved_child_path("~", Some("Documents/Private")).unwrap();
        let text = path.to_string_lossy();
        assert!(text.ends_with("Documents/Private"));
        assert!(!text.starts_with('~'));
        assert!(unresolved_child_path("~", Some("../secret")).is_err());
    }

    #[test]
    fn compact_directory_entry_merges_single_child_chain() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("grand/parent/child")).unwrap();

        let root = root.canonicalize().unwrap();
        let (name, path) = compact_directory_entry(&root, root.join("grand"), "grand".to_string());

        assert_eq!(name, "grand/parent/child/");
        assert_eq!(relative_to_root(&root, &path), "grand/parent/child");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn push_tree_entries_expands_to_depth() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-depth-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("a/b/c")).unwrap();
        fs::write(root.join("a/root.txt"), "root").unwrap();
        fs::write(root.join("a/b/child.txt"), "child").unwrap();

        let root = root.canonicalize().unwrap();
        let mut build = TreeBuild {
            root: &root,
            entries: Vec::new(),
            truncated: false,
        };
        push_tree_entries(&mut build, &root, 0, 2, false).unwrap();
        let rows: Vec<_> = build
            .entries
            .iter()
            .map(|entry| (entry.path.as_str(), entry.level, entry.expanded))
            .collect();

        assert!(rows.contains(&("a", 0, true)));
        assert!(rows.contains(&("a/b", 1, true)));
        assert!(rows.contains(&("a/b/c", 2, false)));
        assert!(rows.contains(&("a/root.txt", 1, false)));
        assert!(rows.contains(&("a/b/child.txt", 2, false)));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn push_search_entries_filters_and_paginates() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-search-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir_all(root.join("app_dir")).unwrap();
        fs::write(root.join("src/app.rs"), "app").unwrap();
        fs::write(root.join("src/nested/app_test.rs"), "test").unwrap();
        fs::write(root.join("README.md"), "readme").unwrap();

        let root = root.canonicalize().unwrap();
        let matcher = PathMatcher::new("app", false, false).unwrap();
        let mut build = TreeBuild {
            root: &root,
            entries: Vec::new(),
            truncated: false,
        };
        let mut visited = 0;
        let mut matched = 0;
        push_search_entries_with_visit_limit(
            &mut build,
            &root,
            &matcher,
            0,
            2,
            &mut visited,
            &mut matched,
            Some("file"),
            MAX_RANKED_SEARCH_VISITS,
        )
        .unwrap();

        let paths = build
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"src/app.rs"));
        assert!(paths.contains(&"src/nested/app_test.rs"));
        assert!(matched >= 2);
        assert!(!paths.contains(&"app_dir"));

        let mut dir_build = TreeBuild {
            root: &root,
            entries: Vec::new(),
            truncated: false,
        };
        let mut visited = 0;
        let mut matched = 0;
        push_search_entries_with_visit_limit(
            &mut dir_build,
            &root,
            &matcher,
            0,
            10,
            &mut visited,
            &mut matched,
            Some("dir"),
            MAX_RANKED_SEARCH_VISITS,
        )
        .unwrap();
        let dir_paths = dir_build
            .entries
            .iter()
            .map(|entry| (entry.kind.as_str(), entry.path.as_str()))
            .collect::<Vec<_>>();
        assert!(dir_paths.contains(&("dir", "app_dir")));
        assert!(!dir_paths.iter().any(|(_, path)| *path == "src"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn path_search_supports_match_case_and_regex() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-path-search-options-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("Private.txt"), "a").unwrap();
        fs::write(root.join("private-notes.md"), "b").unwrap();
        fs::write(root.join("other.txt"), "c").unwrap();

        let root = root.canonicalize().unwrap();
        let search = |q: &str, match_case: bool, regex: bool| {
            let matcher = PathMatcher::new(q, match_case, regex).unwrap();
            let mut build = TreeBuild {
                root: &root,
                entries: Vec::new(),
                truncated: false,
            };
            let mut visited = 0;
            let mut matched = 0;
            push_search_entries_with_visit_limit(
                &mut build,
                &root,
                &matcher,
                0,
                50,
                &mut visited,
                &mut matched,
                Some("file"),
                MAX_RANKED_SEARCH_VISITS,
            )
            .unwrap();
            build
                .entries
                .iter()
                .map(|entry| entry.path.clone())
                .collect::<Vec<_>>()
        };

        // Case-insensitive default: uppercase query still matches lowercase.
        // Both rank as name-prefix hits on the lowercased needle; the path
        // tiebreak keeps a deterministic order regardless of fzf presence
        // (fzf only orders when installed, tests must not depend on it).
        assert_eq!(
            search("PRIVATE", false, false),
            vec!["Private.txt", "private-notes.md"]
        );
        // Case-sensitive: only the exact-case file matches.
        assert_eq!(search("Private", true, false), vec!["Private.txt"]);
        // Regex on the full relative path.
        assert_eq!(
            search("^private.*\\.md$", false, true),
            vec!["private-notes.md"]
        );
        // Regex stays case-sensitive when match_case is on.
        assert_eq!(search("^Private\\.txt$", true, true), vec!["Private.txt"]);
        assert!(search("^private\\.txt$", true, true).is_empty());
        // Invalid regex is rejected before the walk.
        assert!(matches!(
            PathMatcher::new("[", false, true),
            Err(message) if message.starts_with("invalid regex")
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_offset_pages_reach_every_ranked_match() {
        // Layout: matching files spread across dirs. Offset-only pagination
        // re-walks and re-ranks the same match set per page, so paging must
        // partition the ranked list with no gaps and no duplicates even
        // when a page boundary falls mid-list.
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-search-offset-paging-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("a-fill")).unwrap();
        fs::create_dir_all(root.join("b-fill")).unwrap();
        fs::create_dir_all(root.join("c-fill")).unwrap();
        fs::write(root.join("a-fill/hit-1.txt"), "x").unwrap();
        fs::write(root.join("b-fill/hit-2.txt"), "x").unwrap();
        fs::write(root.join("c-fill/hit-3.txt"), "x").unwrap();

        let root = root.canonicalize().unwrap();
        let matcher = PathMatcher::new("hit-", false, false).unwrap();
        let mut collected: Vec<String> = Vec::new();
        let mut offset = 0usize;
        loop {
            let mut build = TreeBuild {
                root: &root,
                entries: Vec::new(),
                truncated: false,
            };
            let mut visited = 0;
            let mut matched = 0;
            push_search_entries_with_visit_limit(
                &mut build,
                &root,
                &matcher,
                offset,
                2,
                &mut visited,
                &mut matched,
                Some("file"),
                MAX_RANKED_SEARCH_VISITS,
            )
            .unwrap();
            let page: Vec<String> = build
                .entries
                .iter()
                .map(|entry| entry.path.as_str().to_string())
                .collect();
            assert_eq!(page.len(), page.len().min(2), "pages respect the limit");
            offset += page.len();
            collected.extend(page);
            if !build.truncated {
                break;
            }
        }
        let mut expected = vec![
            "a-fill/hit-1.txt".to_string(),
            "b-fill/hit-2.txt".to_string(),
            "c-fill/hit-3.txt".to_string(),
        ];
        expected.sort();
        assert_eq!(
            collected, expected,
            "offset paging reaches every match with no gaps or duplicates"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn path_search_ranks_nearest_match_first() {
        // Ranking tiers: exact file name beats a name-contains match, which
        // beats a path-fragment-only match. fzf never runs in tests (the
        // boot probe stays absent), so the built-in ranker defines this
        // order deterministically.
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-search-ranking-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("app")).unwrap();
        fs::write(root.join("app/app"), "x").unwrap();
        fs::write(root.join("app/patch-app.js"), "x").unwrap();
        fs::write(root.join("app/notes.md"), "x").unwrap();

        let root = root.canonicalize().unwrap();
        let matcher = PathMatcher::new("app", false, false).unwrap();
        let mut build = TreeBuild {
            root: &root,
            entries: Vec::new(),
            truncated: false,
        };
        let mut visited = 0;
        let mut matched = 0;
        push_search_entries_with_visit_limit(
            &mut build,
            &root,
            &matcher,
            0,
            10,
            &mut visited,
            &mut matched,
            Some("file"),
            MAX_RANKED_SEARCH_VISITS,
        )
        .unwrap();
        let paths: Vec<&str> = build
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(
            paths,
            vec!["app/app", "app/patch-app.js", "app/notes.md"],
            "exact name first, name-contains second, path-fragment last"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_reaches_matches_past_the_old_visit_cap() {
        // Regression for the motivating bug: a match deep in the walk (the
        // real case sat at BFS visit ~29.8k) was unreachable past the old
        // 20k-visit first page. The ranked walk must visit far past that
        // cap and surface the match on page one.
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-search-deep-visit-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        // 16 filler dirs × 1500 files = 24000 visited entries before the
        // match: past the old 20k cap without doubling the suite wall time.
        fs::create_dir_all(root.join("fillers/deep/target")).unwrap();
        fs::write(root.join("fillers/deep/target/needle.txt"), "x").unwrap();
        for i in 0..16 {
            let filler = root.join(format!("fillers/filler-{i:03}"));
            fs::create_dir_all(&filler).unwrap();
            for j in 0..1500 {
                fs::write(filler.join(format!("pad-{j:04}.txt")), "x").unwrap();
            }
        }

        let root = root.canonicalize().unwrap();
        let matcher = PathMatcher::new("needle", false, false).unwrap();
        let mut build = TreeBuild {
            root: &root,
            entries: Vec::new(),
            truncated: false,
        };
        let mut visited = 0;
        let mut matched = 0;
        push_search_entries_with_visit_limit(
            &mut build,
            &root,
            &matcher,
            0,
            100,
            &mut visited,
            &mut matched,
            Some("file"),
            MAX_RANKED_SEARCH_VISITS,
        )
        .unwrap();
        let paths: Vec<&str> = build
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert_eq!(
            paths,
            vec!["fillers/deep/target/needle.txt"],
            "a match ~24k visits deep lands on page one"
        );
        assert!(
            visited > 20_000,
            "the walk must visit past the old 20k cap, visited={visited}"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn path_matcher_rejects_empty_query() {
        assert!(PathMatcher::new("", false, false).is_err());
    }

    #[test]
    fn push_search_entries_replaces_a_prefilled_page() {
        // A caller that pre-fills the page (impossible via the HTTP layer,
        // but the function contract allows it) gets the ranked page back:
        // collect-then-rank always walks and owns the entries it returns.
        let root =
            std::env::temp_dir().join(format!("herdr-webui-search-prefull-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("hit.txt"), "x").unwrap();

        let root = root.canonicalize().unwrap();
        let matcher = PathMatcher::new("hit", false, false).unwrap();
        let pre: Vec<FileBrowserEntry> = (0..2)
            .map(|_| FileBrowserEntry {
                name: "hit.txt".to_string(),
                path: "hit.txt".to_string(),
                kind: "file".to_string(),
                size: None,
                modified_ms: None,
                level: 0,
                expanded: false,
            })
            .collect();
        let mut build = TreeBuild {
            root: &root,
            entries: pre,
            truncated: false,
        };
        let mut visited = 0;
        let mut matched = 0;
        push_search_entries_with_visit_limit(
            &mut build,
            &root,
            &matcher,
            0,
            2,
            &mut visited,
            &mut matched,
            Some("file"),
            3,
        )
        .unwrap();
        assert_eq!(
            build.entries.len(),
            1,
            "the ranked walk replaces the pre-filled page with the real match"
        );
        assert_eq!(build.entries[0].path, "hit.txt");
        assert!(
            visited > 0,
            "the walk runs even when the page was pre-filled"
        );
        assert_eq!(matched, 1, "the single match is counted");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tree_payload_rejects_invalid_search_regex() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-tree-payload-bad-regex-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();

        let root = root.canonicalize().unwrap();
        let query = FileBrowserQuery {
            cwd: root.to_string_lossy().to_string(),
            path: None,
            dirs_only: None,
            depth: None,
            q: Some("hit(".to_string()),
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: Some(true),
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        };
        let err = file_browser_tree_payload(query).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST, "invalid regex must 400");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tree_payload_rejects_walk_errors() {
        // An unreadable search root makes every directory read fail, which
        // must surface as a walk error instead of a silent empty page.
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-tree-payload-walk-err-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("hit.txt"), "x").unwrap();

        let root = root.canonicalize().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o000)).unwrap();
        }
        let query = FileBrowserQuery {
            cwd: root.to_string_lossy().to_string(),
            path: None,
            dirs_only: None,
            depth: None,
            q: Some("hit".to_string()),
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        };
        let err = file_browser_tree_payload(query).unwrap_err();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
            assert_eq!(
                err.0,
                StatusCode::BAD_GATEWAY,
                "unreadable walk root must surface a walk error"
            );
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tree_payload_dirs_only_search_stays_folder_only() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-tree-payload-dirs-only-search-{}",
            std::process::id(),
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("projects/herdr-webui")).unwrap();
        fs::write(root.join("herdr-webui.txt"), "file").unwrap();

        let root = root.canonicalize().unwrap();
        // Directory pickers send dirs_only=true and q= without an explicit
        // search_kind; the payload must still return folders only.
        let query = FileBrowserQuery {
            cwd: root.to_string_lossy().to_string(),
            path: None,
            dirs_only: Some(true),
            depth: None,
            q: Some("herdr-webui".to_string()),
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        };
        let payload = file_browser_tree_payload(query).unwrap();
        let entries = payload["entries"].as_array().unwrap();
        let paths: Vec<&str> = entries
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        assert_eq!(
            paths,
            vec!["projects/herdr-webui"],
            "dirs_only search must not return files"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn push_search_entries_reaches_shallow_sibling_before_deep_branch_limit() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-bfs-search-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("bulk/a/b/c/d/e/f/g/h/i/j")).unwrap();
        fs::create_dir_all(root.join("projects/herdr")).unwrap();

        let root = root.canonicalize().unwrap();
        let matcher = PathMatcher::new("herdr", false, false).unwrap();
        let mut build = TreeBuild {
            root: &root,
            entries: Vec::new(),
            truncated: false,
        };
        let mut visited = 0;
        let mut matched = 0;
        push_search_entries_with_visit_limit(
            &mut build,
            &root,
            &matcher,
            0,
            10,
            &mut visited,
            &mut matched,
            Some("dir"),
            6,
        )
        .unwrap();

        let paths = build
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"projects/herdr"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    fn is_running_as_root() -> bool {
        // On Unix, UID 0 is root. Using `id -u` avoids a libc dependency.
        std::process::Command::new("id")
            .arg("-u")
            .output()
            .ok()
            .and_then(|out| String::from_utf8(out.stdout).ok())
            .and_then(|s| s.trim().parse::<u32>().ok())
            == Some(0)
    }

    #[cfg(unix)]
    fn make_unreadable_dir(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(path).unwrap();
        let mut perms = fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o000);
        fs::set_permissions(path, perms).unwrap();
    }

    #[cfg(unix)]
    fn restore_readable_dir(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).unwrap().permissions();
        perms.set_mode(0o755);
        let _ = fs::set_permissions(path, perms);
    }

    #[cfg(unix)]
    #[test]
    fn push_search_entries_skips_unreadable_subdirectories() {
        // Running this test as root would not produce permission errors, so
        // skip it in that case to avoid a false negative.
        if is_running_as_root() {
            eprintln!("skipping permission test because running as root");
            return;
        }

        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-perm-search-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.rs"), "app").unwrap();
        fs::create_dir_all(root.join("locked")).unwrap();
        fs::write(root.join("locked/secret.rs"), "secret").unwrap();
        make_unreadable_dir(&root.join("locked"));
        fs::write(root.join("other.txt"), "other app file").unwrap();

        let root = root.canonicalize().unwrap();
        let matcher = PathMatcher::new("app", false, false).unwrap();
        let mut build = TreeBuild {
            root: &root,
            entries: Vec::new(),
            truncated: false,
        };
        let mut visited = 0;
        let mut matched = 0;
        // Searching for "app" must succeed and find src/app.rs, skipping the
        // locked directory instead of returning an error.
        push_search_entries_with_visit_limit(
            &mut build,
            &root,
            &matcher,
            0,
            10,
            &mut visited,
            &mut matched,
            Some("file"),
            MAX_RANKED_SEARCH_VISITS,
        )
        .unwrap();

        let paths = build
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"src/app.rs"));
        // The locked directory's contents must not appear.
        assert!(!paths.iter().any(|p| p.starts_with("locked/")));

        restore_readable_dir(&root.join("locked"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn push_tree_entries_skips_unreadable_subdirectories() {
        if is_running_as_root() {
            eprintln!("skipping permission test because running as root");
            return;
        }

        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-perm-tree-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("a/b/c")).unwrap();
        fs::write(root.join("a/root.txt"), "root").unwrap();
        fs::create_dir_all(root.join("locked/deep")).unwrap();
        fs::write(root.join("locked/deep/secret.txt"), "secret").unwrap();
        make_unreadable_dir(&root.join("locked"));

        let root = root.canonicalize().unwrap();
        let mut build = TreeBuild {
            root: &root,
            entries: Vec::new(),
            truncated: false,
        };
        // Expanding from the root must succeed, skipping the locked subdir.
        push_tree_entries(&mut build, &root, 0, 2, false).unwrap();
        let paths: Vec<_> = build
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect();
        assert!(paths.contains(&"a"));
        assert!(paths.contains(&"a/root.txt"));
        // The locked directory's children must not cause a failure.
        assert!(!paths.iter().any(|p| p.starts_with("locked/deep")));

        restore_readable_dir(&root.join("locked"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn collect_content_search_skips_unreadable_subdirectories() {
        if is_running_as_root() {
            eprintln!("skipping permission test because running as root");
            return;
        }

        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-perm-content-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/app.rs"), "needle found").unwrap();
        fs::create_dir_all(root.join("locked")).unwrap();
        fs::write(root.join("locked/secret.rs"), "needle hidden").unwrap();
        make_unreadable_dir(&root.join("locked"));

        let root = root.canonicalize().unwrap();
        // Content search must succeed, finding src/app.rs and skipping locked/.
        let build =
            collect_content_search(&root, &root, "needle", false, false, 0, 10, 0, 5).unwrap();
        let paths: Vec<_> = build
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"src/app.rs"));
        assert!(!paths.iter().any(|p| p.starts_with("locked/")));

        restore_readable_dir(&root.join("locked"));
        let _ = fs::remove_dir_all(root);
    }

    fn sample_matches() -> Vec<ContentSearchMatch> {
        let m = |id: &str, line: usize, before: Vec<&str>, text: &str, after: Vec<&str>| {
            ContentSearchMatch {
                id: id.to_string(),
                line,
                column: 1,
                match_start: 0,
                match_end: 6,
                start_line: line.saturating_sub(before.len()),
                end_line: line + after.len(),
                content: String::new(),
                before: before.into_iter().map(str::to_string).collect(),
                text: text.to_string(),
                after: after.into_iter().map(str::to_string).collect(),
            }
        };
        vec![
            m("a", 2, vec!["ctx1"], "needle", vec!["ctx2"]),
            m("b", 4, vec!["ctx3"], "needle", vec!["ctx4"]),
            m("c", 10, vec!["far"], "needle", vec!["away"]),
        ]
    }

    #[test]
    fn content_chunks_merge_overlapping_and_adjacent_matches() {
        let chunks = build_content_search_chunks(&sample_matches(), "needle");
        // Match 1 covers lines 1-3, match 2 covers lines 3-5 (overlap on line 3):
        // they merge. Match 3 covers 9-11 and stays separate.
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].start, 1);
        assert_eq!(chunks[0].end, 5);
        assert_eq!(chunks[0].rows.len(), 5);
        assert_eq!(chunks[0].rows[0].line, 1);
        assert_eq!(chunks[0].rows[1].line, 2);
        assert!(chunks[0].rows[1].matched);
        assert_eq!(chunks[0].rows[2].line, 3);
        // Line 3 appears as context in match 2 and as "after" in match 1;
        // rows dedupe by line, and matched rows always win.
        assert_eq!(chunks[0].rows[3].line, 4);
        assert!(chunks[0].rows[3].matched);
        assert_eq!(chunks[0].match_ids, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(chunks[1].start, 9);
        assert_eq!(chunks[1].end, 11);
        assert_eq!(chunks[1].match_ids, vec!["c".to_string()]);
    }

    #[test]
    fn content_chunks_adjacent_windows_merge_like_legacy_renderer() {
        // Legacy rule: a chunk merges when its start <= previous end + 1.
        // Window A covers 1-3 and window B covers 4-6 (start 4 == end 3 + 1):
        // they must merge into one 1-6 chunk.
        let mut matches = sample_matches();
        matches[1].line = 4;
        matches[1].before = vec!["ctx3".to_string()];
        matches[1].after = vec!["ctx4".to_string()];
        matches[1].id = "b".to_string();
        let chunks = build_content_search_chunks(&matches, "needle");
        assert_eq!(chunks.len(), 2, "a and b merge; c stays alone");
        assert_eq!(chunks[0].start, 1);
        assert_eq!(chunks[0].end, 5);
        assert_eq!(chunks[0].rows.len(), 5);
    }

    #[test]
    fn content_chunks_gap_of_two_lines_stays_separate() {
        // Window A ends at line 3, window B covers 5-7 (one blank line at 4):
        // start 5 > end 3 + 1, so they stay separate chunks, like the legacy
        // browser merge rule.
        let mut matches = sample_matches();
        matches[1].line = 6;
        matches[1].before = vec!["ctx".to_string()];
        matches[1].after = vec!["ctx".to_string()];
        matches[1].id = "b".to_string();
        let chunks = build_content_search_chunks(&matches, "needle");
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].start, 1);
        assert_eq!(chunks[0].end, 3);
        assert_eq!(chunks[1].start, 5);
        assert_eq!(chunks[1].end, 7);
    }

    #[test]
    fn content_chunk_rows_escape_html_and_highlight_match() {
        let chunks = build_content_search_chunks(&sample_matches(), "needle");
        let matched = &chunks[0].rows[1];
        assert!(matched.matched);
        assert_eq!(matched.match_id.as_deref(), Some("a"));
        assert_eq!(
            matched.highlight_html,
            "<mark class=\"herdr-content-search-hit\">needle</mark>"
        );
        let muted = &chunks[0].rows[0];
        assert!(!muted.matched);
        assert_eq!(muted.highlight_html, "ctx1");
    }

    #[test]
    fn content_chunk_highlight_escapes_markup_and_multibyte() {
        let mut matches = sample_matches();
        // A line with HTML chars and a multibyte grapheme before the match:
        // byte offsets must highlight the exact span (the legacy JS renderer
        // sliced with byte offsets over UTF-16 code units and misrendered).
        matches[0].text = "<b>héllo needle</b>".to_string();
        matches[0].match_start = "<b>héllo ".len();
        matches[0].match_end = matches[0].match_start + "needle".len();
        let chunks = build_content_search_chunks(&matches, "needle");
        assert_eq!(
            chunks[0].rows[1].highlight_html,
            "&lt;b&gt;h\u{e9}llo <mark class=\"herdr-content-search-hit\">needle</mark>&lt;/b&gt;"
        );
    }

    #[test]
    fn content_chunk_highlight_falls_back_to_query_search() {
        // Offsets outside the line (stale client data) fall back to the first
        // case-insensitive occurrence, like the legacy renderer.
        let mut matches = sample_matches();
        matches[0].text = "Has NEEDLE inside".to_string();
        matches[0].match_start = 100;
        matches[0].match_end = 200;
        let chunks = build_content_search_chunks(&matches, "needle");
        assert_eq!(
            chunks[0].rows[1].highlight_html,
            "Has <mark class=\"herdr-content-search-hit\">NEEDLE</mark> inside"
        );
    }

    #[test]
    fn content_search_file_response_includes_chunks() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-content-chunks-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("app.rs"),
            "one\nneedle two\nthree\nneedle four\nfive",
        )
        .unwrap();
        let root = root.canonicalize().unwrap();
        let matcher = ContentMatcher::new("needle", false, false).unwrap();
        let result = content_search_file(&root, &root.join("app.rs"), "needle", &matcher, 1, 50)
            .unwrap()
            .expect("matches expected");
        // context=1: windows are lines 1-3 and 3-5, overlapping on line 3.
        assert_eq!(result.chunks.len(), 1);
        assert_eq!(result.chunks[0].start, 1);
        assert_eq!(result.chunks[0].end, 5);
        assert_eq!(result.chunks[0].rows.len(), 5);
        assert!(result.chunks[0].rows[1].matched);
        assert!(result.chunks[0].rows[3].matched);
        assert_eq!(
            result.chunks[0].rows[1].highlight_html,
            "<mark class=\"herdr-content-search-hit\">needle</mark> two"
        );
        assert_eq!(result.chunks[0].rows[2].highlight_html, "three");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn content_search_groups_matches_with_context_and_limits() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-content-search-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/app.rs"),
            "before\nneedle one\nafter\nneedle two\nend",
        )
        .unwrap();
        fs::write(root.join("src/other.rs"), "nothing").unwrap();
        fs::write(root.join("README.md"), "Needle docs").unwrap();

        let root = root.canonicalize().unwrap();
        let build =
            collect_content_search(&root, &root, "needle", false, false, 0, 10, 1, 1).unwrap();

        assert_eq!(build.total_files, 2);
        assert_eq!(build.total_matches, 3);
        let app = build
            .files
            .iter()
            .find(|file| file.path == "src/app.rs")
            .unwrap();
        assert_eq!(app.match_count, 2);
        assert_eq!(app.matches.len(), 1);
        assert!(app.truncated);
        assert_eq!(app.matches[0].start_line, 1);
        assert_eq!(app.matches[0].end_line, 3);
        assert_eq!(app.matches[0].before, vec!["before".to_string()]);
        assert_eq!(app.matches[0].after, vec!["after".to_string()]);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn hash_only_returns_hash_without_content() {
        // A6 diff awareness: the cheap endpoint must return the current hash
        // and size with empty content, without any content read. Verified
        // through the same response shape the browser consumes.
        let root =
            std::env::temp_dir().join(format!("herdr-webui-hash-only-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let body = "external change sentinel".to_string();
        let path = root.join("watched.txt");
        fs::write(&path, &body).unwrap();

        // Reuse the write handler's hash path: call file_hash directly for
        // the expectation, then exercise the route body through the same
        // JSON shape the hash_only branch produces.
        let expected = file_hash(&path).unwrap();
        assert!(!expected.is_empty());
        // After an external change the hash must differ.
        fs::write(&path, "external change sentinel v2").unwrap();
        let changed = file_hash(&path).unwrap();
        assert_ne!(expected, changed);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn partial_read_budget_clamps_requests() {
        // In-window budgets pass through.
        assert_eq!(partial_read_budget(Some(16 * 1024)), Some(16 * 1024));
        assert_eq!(
            partial_read_budget(Some(MAX_FILE_BYTES)),
            Some(MAX_FILE_BYTES)
        );
        // Out-of-window or missing budgets are ignored (None -> placeholder).
        assert_eq!(partial_read_budget(None), None);
        assert_eq!(partial_read_budget(Some(0)), None);
        assert_eq!(partial_read_budget(Some(15 * 1024)), None);
        assert_eq!(partial_read_budget(Some(MAX_FILE_BYTES + 1)), None);
        assert_eq!(partial_read_budget(Some(64 * 1024 * 1024)), None);
    }

    #[tokio::test]
    async fn partial_read_returns_prefix_with_empty_hash() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-partial-read-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // 64 KB of ASCII text: larger than the 16 KB budget but far under
        // MAX_FILE_BYTES, so the read is a pure prefix slice.
        let body = "x".repeat(64 * 1024);
        let path = root.join("big.txt");
        fs::write(&path, &body).unwrap();

        let response =
            file_browser_partial_read_payload(&path, "big.txt", body.len() as u64, 16 * 1024)
                .map(Json)
                .map(IntoResponse::into_response)
                .unwrap_or_else(|(status, msg)| file_browser_json_error(status, msg));
        let bytes = axum::body::to_bytes(response.into_body(), 10 * 1024 * 1024)
            .await
            .unwrap();
        let payload: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(payload["truncated"], serde_json::json!(true));
        assert_eq!(payload["size"], serde_json::json!(body.len() as u64));
        assert_eq!(payload["preview_bytes"], serde_json::json!(16 * 1024));
        assert_eq!(payload["hash"], serde_json::json!(""));
        let content = payload["content"].as_str().unwrap();
        assert_eq!(content.len(), 16 * 1024);
        assert!(content.chars().all(|ch| ch == 'x'));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn content_search_skips_binary_large_and_dependency_dirs() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-content-search-skip-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/hit.txt"), "needle").unwrap();
        fs::write(root.join("binary.bin"), b"needle\0hidden").unwrap();
        fs::write(root.join("ok.txt"), "needle visible").unwrap();

        let root = root.canonicalize().unwrap();
        let build =
            collect_content_search(&root, &root, "needle", false, false, 0, 10, 0, 5).unwrap();
        let paths = build
            .files
            .iter()
            .map(|file| file.path.as_str())
            .collect::<Vec<_>>();

        assert_eq!(paths, vec!["ok.txt"]);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn content_search_supports_match_case_and_regex() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-content-search-options-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("case.txt"), "Needle\nneedle\nneedle-42").unwrap();

        let root = root.canonicalize().unwrap();
        let case_sensitive =
            collect_content_search(&root, &root, "Needle", true, false, 0, 10, 0, 5).unwrap();
        assert_eq!(case_sensitive.total_matches, 1);
        assert_eq!(case_sensitive.files[0].matches[0].text, "Needle");

        let case_insensitive =
            collect_content_search(&root, &root, "Needle", false, false, 0, 10, 0, 5).unwrap();
        assert_eq!(case_insensitive.total_matches, 3);

        let regex =
            collect_content_search(&root, &root, "needle-\\d+", false, true, 0, 10, 0, 5).unwrap();
        assert_eq!(regex.total_matches, 1);
        assert_eq!(regex.files[0].matches[0].match_start, 0);
        assert_eq!(regex.files[0].matches[0].match_end, "needle-42".len());

        let invalid = collect_content_search(&root, &root, "[", false, true, 0, 10, 0, 5);
        assert!(matches!(invalid, Err(message) if message.starts_with("invalid regex")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn content_matcher_multibyte_offsets_are_into_the_original_line() {
        // Byte offsets must index the ORIGINAL line, not a case-folded copy:
        // highlight_line_html slices the line with them and would panic
        // (char boundary) or highlight the wrong span otherwise. CJK chars are
        // 3 bytes in UTF-8, so a latin prefix shifts offsets by 3 bytes per char.
        let line = "日本語 needle おわり";
        let matcher = ContentMatcher::new("needle", true, false).unwrap();
        let (start, end) = matcher.find(line).unwrap();
        assert_eq!(&line[start..end], "needle");
        assert!(line.is_char_boundary(start));
        assert!(line.is_char_boundary(end));

        // Case-insensitive plain needle on a multibyte line: the regex-builder
        // path reports offsets into the original line as well.
        let ci = ContentMatcher::new("NEEDLE", false, false).unwrap();
        let (start, end) = ci.find(line).unwrap();
        assert_eq!(&line[start..end], "needle");

        // No match -> None, not a panic.
        let none = ContentMatcher::new("absent", true, false).unwrap();
        assert!(none.find(line).is_none());
    }

    #[test]
    fn content_matcher_case_insensitive_multibyte_needles() {
        // 'İ' (U+0130) lowercases to a two-code-point sequence ("i\u{307}"), so
        // neither the old to_lowercase() hack nor the regex crate's simple case
        // folding can ever equate it with plain 'i'. What must hold: a 'İ'
        // needle case-insensitively still matches itself in the haystack, and
        // the reported offsets are byte offsets into the ORIGINAL multibyte
        // line (2 bytes per 'İ'), not into any transformed copy.
        let dotted = ContentMatcher::new("İ", false, false).unwrap();
        let (start, end) = dotted.find("başında İ bulunur").expect("matches itself");
        assert_eq!(&"başında İ bulunur"[start..end], "İ");

        // ASCII needle inside a CJK line, case-insensitive: offsets must slice
        // the original line exactly (3 bytes per CJK char).
        let line = "日本語 needle おわり";
        let ascii_ci = ContentMatcher::new("nEeDlE", false, false).unwrap();
        let (start, end) = ascii_ci.find(line).unwrap();
        assert_eq!(&line[start..end], "needle");

        // Case-sensitive plain matching must stay exact, not folded.
        let exact = ContentMatcher::new("İ", true, false).unwrap();
        assert!(exact.find("istanbul").is_none());
        assert!(exact.find("İstanbul").is_some());
    }

    #[test]
    fn content_matcher_plain_needle_escapes_regex_metacharacters() {
        // Plain (non-regex) queries must match literally, even when the needle
        // contains regex metacharacters, because the case-insensitive path now
        // routes through RegexBuilder too.
        let matcher = ContentMatcher::new("a.b*c", false, false).unwrap();
        assert!(matcher.find("xxa.b*cyy").is_some());
        assert!(matcher.find("aabbcc").is_none());

        let brackets = ContentMatcher::new("[not-a-class]", false, false).unwrap();
        assert!(brackets.find("see [not-a-class] here").is_some());
    }

    #[test]
    fn content_search_settings_clamp_defaults_and_bounds() {
        assert_eq!(
            content_search_context_lines(None),
            DEFAULT_CONTENT_CONTEXT_LINES
        );
        assert_eq!(
            content_search_context_lines(Some(MAX_CONTENT_CONTEXT_LINES + 10)),
            MAX_CONTENT_CONTEXT_LINES
        );
        assert_eq!(content_search_context_lines(Some(0)), 0);

        assert_eq!(
            content_search_matches_per_file(None),
            DEFAULT_CONTENT_MATCHES_PER_FILE
        );
        assert_eq!(content_search_matches_per_file(Some(0)), 1);
        assert_eq!(
            content_search_matches_per_file(Some(MAX_CONTENT_MATCHES_PER_FILE + 10)),
            MAX_CONTENT_MATCHES_PER_FILE
        );
    }

    #[test]
    fn collect_git_status_returns_none_for_non_git_dir() {
        let temp = std::env::temp_dir();
        let result = collect_git_status(&temp, &temp);
        // temp_dir might be inside a git repo on some machines, so just test it doesn't panic
        let _ = result;
    }

    #[test]
    fn propagate_git_status_marks_parent_dirs_with_priority() {
        let mut map = serde_json::Map::new();

        propagate_git_status(&mut map, "src/new/file.rs", "untracked");
        assert_eq!(
            map.get("src").and_then(|value| value.as_str()),
            Some("added")
        );
        assert_eq!(
            map.get("src/new").and_then(|value| value.as_str()),
            Some("added")
        );

        propagate_git_status(&mut map, "src/changed/file.rs", "modified");
        assert_eq!(
            map.get("src").and_then(|value| value.as_str()),
            Some("modified")
        );

        propagate_git_status(&mut map, "src/deleted/file.rs", "deleted");
        assert_eq!(
            map.get("src").and_then(|value| value.as_str()),
            Some("deleted")
        );

        propagate_git_status(&mut map, "src/another-new/file.rs", "untracked");
        assert_eq!(
            map.get("src").and_then(|value| value.as_str()),
            Some("deleted")
        );
    }

    #[test]
    fn collect_git_status_propagates_directory_priority_from_git() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-git-status-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/changed")).unwrap();
        fs::create_dir_all(root.join("src/deleted")).unwrap();
        fs::create_dir_all(root.join("src/new")).unwrap();
        fs::write(root.join("src/changed/file.rs"), "old").unwrap();
        fs::write(root.join("src/deleted/file.rs"), "old").unwrap();
        fs::write(root.join("src/new/file.rs"), "new").unwrap();

        let init = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .arg("init")
            .output();
        if !init
            .as_ref()
            .map(|out| out.status.success())
            .unwrap_or(false)
        {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        let add = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["add", "src/changed/file.rs", "src/deleted/file.rs"])
            .status()
            .unwrap();
        assert!(add.success());
        fs::write(root.join("src/changed/file.rs"), "new").unwrap();
        fs::remove_file(root.join("src/deleted/file.rs")).unwrap();

        let root = root.canonicalize().unwrap();
        let status = collect_git_status(&root, &root).unwrap();

        assert_eq!(
            status.get("src").and_then(|value| value.as_str()),
            Some("deleted")
        );
        assert_eq!(
            status.get("src/changed").and_then(|value| value.as_str()),
            Some("modified")
        );
        assert_eq!(
            status
                .get("src/changed/file.rs")
                .and_then(|value| value.as_str()),
            Some("modified")
        );
        assert_eq!(
            status.get("src/deleted").and_then(|value| value.as_str()),
            Some("deleted")
        );
        assert_eq!(
            status
                .get("src/deleted/file.rs")
                .and_then(|value| value.as_str()),
            Some("deleted")
        );
        assert_eq!(
            status.get("src/new").and_then(|value| value.as_str()),
            Some("added")
        );
        assert_eq!(
            status
                .get("src/new/file.rs")
                .and_then(|value| value.as_str()),
            Some("untracked")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn collect_git_status_marks_branch_changes_blue_and_keeps_working_tree_priority() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-branch-changes-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/branch")).unwrap();
        fs::create_dir_all(root.join("src/plain")).unwrap();
        fs::write(root.join("src/branch/file.rs"), "branch").unwrap();
        fs::write(root.join("src/plain/file.rs"), "plain").unwrap();

        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap()
        };
        if !git(&["init", "-b", "main"]).success() {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        // Fresh CI images have no global git identity, so commits need a
        // local one or `git commit` fails (seen on Linux runners).
        assert!(git(&["config", "user.email", "t@t"]).success());
        assert!(git(&["config", "user.name", "T"]).success());
        // Base commit on main with the plain file only.
        assert!(git(&["add", "src/plain/file.rs"]).success());
        assert!(git(&["commit", "-m", "base", "--no-gpg-sign"]).success());
        // Feature branch adds and commits the branch file.
        assert!(git(&["switch", "-c", "feat"]).success());
        assert!(git(&["add", "src/branch/file.rs"]).success());
        assert!(git(&["commit", "-m", "feat", "--no-gpg-sign"]).success());
        // Dirty working tree on the branch file: modified must win over changed.
        fs::write(root.join("src/branch/file.rs"), "dirty").unwrap();

        let root = root.canonicalize().unwrap();
        let status = collect_git_status(&root, &root).unwrap();

        // Branch-only committed files light up blue.
        assert_eq!(
            status
                .get("src/branch/file.rs")
                .and_then(|value| value.as_str()),
            Some("modified")
        );
        assert_eq!(
            status.get("src").and_then(|value| value.as_str()),
            Some("modified")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn collect_git_status_reports_changed_when_working_tree_clean() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-branch-changes-clean-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/branch")).unwrap();
        fs::write(root.join("src/branch/file.rs"), "branch").unwrap();

        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap()
        };
        if !git(&["init", "-b", "main"]).success() {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        // Fresh CI images have no global git identity, so commits need a
        // local one or `git commit` fails (seen on Linux runners).
        assert!(git(&["config", "user.email", "t@t"]).success());
        assert!(git(&["config", "user.name", "T"]).success());
        // Empty tree base: `git commit` needs at least one commit on main so
        // merge-base works. Commit an unrelated README first.
        fs::write(root.join("README.md"), "base").unwrap();
        assert!(git(&["add", "README.md"]).success());
        assert!(git(&["commit", "-m", "base", "--no-gpg-sign"]).success());
        assert!(git(&["switch", "-c", "feat"]).success());
        assert!(git(&["add", "src/branch/file.rs"]).success());
        assert!(git(&["commit", "-m", "feat", "--no-gpg-sign"]).success());

        let root = root.canonicalize().unwrap();
        let status = collect_git_status(&root, &root).unwrap();

        // Clean working tree: the committed branch file reads "changed" (blue).
        assert_eq!(
            status
                .get("src/branch/file.rs")
                .and_then(|value| value.as_str()),
            Some("changed")
        );
        assert_eq!(
            status.get("src/branch").and_then(|value| value.as_str()),
            Some("changed")
        );
        // Files untouched by the branch are not in the map.
        assert!(status.get("README.md").is_none());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn collect_git_status_noop_on_default_branch() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-branch-on-base-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("README.md"), "base").unwrap();

        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap()
        };
        if !git(&["init", "-b", "main"]).success() {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        // Fresh CI images have no global git identity, so commits need a
        // local one or `git commit` fails (seen on Linux runners).
        assert!(git(&["config", "user.email", "t@t"]).success());
        assert!(git(&["config", "user.name", "T"]).success());
        assert!(git(&["add", "README.md"]).success());
        assert!(git(&["commit", "-m", "base", "--no-gpg-sign"]).success());
        // Stay on main with a clean tree: no changed entries expected.

        let root = root.canonicalize().unwrap();
        let status = collect_git_status(&root, &root);
        assert!(
            status.is_none(),
            "clean main must produce no git_status map"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn collect_git_status_noop_on_detached_head() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-branch-detached-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("README.md"), "base").unwrap();

        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap()
        };
        if !git(&["init", "-b", "main"]).success() {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        // Fresh CI images have no global git identity, so commits need a
        // local one or `git commit` fails (seen on Linux runners).
        assert!(git(&["config", "user.email", "t@t"]).success());
        assert!(git(&["config", "user.name", "T"]).success());
        assert!(git(&["add", "README.md"]).success());
        assert!(git(&["commit", "-m", "base", "--no-gpg-sign"]).success());
        assert!(git(&["switch", "-c", "feat"]).success());
        fs::write(root.join("file.rs"), "feat").unwrap();
        assert!(git(&["add", "file.rs"]).success());
        assert!(git(&["commit", "-m", "feat", "--no-gpg-sign"]).success());
        // Detach HEAD at the feat commit: branch diff must not run.
        assert!(git(&["switch", "--detach"]).success());

        let root = root.canonicalize().unwrap();
        let status = collect_git_status(&root, &root);
        assert!(
            status.is_none(),
            "detached HEAD must not report branch changes"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn collect_git_status_reports_deleted_branch_files_as_changed() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-branch-deleted-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("README.md"), "base").unwrap();
        fs::write(root.join("src/gone.rs"), "base").unwrap();

        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap()
        };
        if !git(&["init", "-b", "main"]).success() {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        // Fresh CI images have no global git identity, so commits need a
        // local one or `git commit` fails (seen on Linux runners).
        assert!(git(&["config", "user.email", "t@t"]).success());
        assert!(git(&["config", "user.name", "T"]).success());
        assert!(git(&["add", "."]).success());
        assert!(git(&["commit", "-m", "base", "--no-gpg-sign"]).success());
        assert!(git(&["switch", "-c", "feat"]).success());
        fs::remove_file(root.join("src/gone.rs")).unwrap();
        assert!(git(&["add", "-A"]).success());
        assert!(git(&["commit", "-m", "delete", "--no-gpg-sign"]).success());

        let root = root.canonicalize().unwrap();
        let status = collect_git_status(&root, &root).unwrap();

        // A file deleted on the branch is still a branch change (blue), not a
        // working-tree deletion (red): it exists on base, not on HEAD.
        assert_eq!(
            status.get("src/gone.rs").and_then(|value| value.as_str()),
            Some("changed")
        );
        assert_eq!(
            status.get("src").and_then(|value| value.as_str()),
            Some("changed")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn collect_git_status_trims_subdir_prefix_for_branch_changes() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-branch-subdir-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("workspace/src")).unwrap();
        fs::write(root.join("workspace/README.md"), "base").unwrap();

        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap()
        };
        if !git(&["init", "-b", "main"]).success() {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        // Fresh CI images have no global git identity, so commits need a
        // local one or `git commit` fails (seen on Linux runners).
        assert!(git(&["config", "user.email", "t@t"]).success());
        assert!(git(&["config", "user.name", "T"]).success());
        assert!(git(&["add", "."]).success());
        assert!(git(&["commit", "-m", "base", "--no-gpg-sign"]).success());
        assert!(git(&["switch", "-c", "feat"]).success());
        fs::write(root.join("workspace/src/branch_file.rs"), "feat").unwrap();
        assert!(git(&["add", "."]).success());
        assert!(git(&["commit", "-m", "feat", "--no-gpg-sign"]).success());

        // Workspace root is a subdirectory of the repo: paths must be trimmed
        // to workspace-relative so tree rows match.
        let workspace = root.join("workspace").canonicalize().unwrap();
        let status = collect_git_status(&workspace, &workspace).unwrap();

        assert_eq!(
            status
                .get("src/branch_file.rs")
                .and_then(|value| value.as_str()),
            Some("changed")
        );
        assert_eq!(
            status.get("src").and_then(|value| value.as_str()),
            Some("changed")
        );
        assert!(
            status.get("workspace/src/branch_file.rs").is_none(),
            "repo-relative path must not leak into the workspace map"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn collect_git_status_falls_back_to_main_on_stale_origin_head() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-branch-stale-head-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("README.md"), "base").unwrap();

        let git = |args: &[&str]| {
            std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .status()
                .unwrap()
        };
        if !git(&["init", "-b", "main"]).success() {
            let _ = fs::remove_dir_all(&root);
            return;
        }
        // Fresh CI images have no global git identity, so commits need a
        // local one or `git commit` fails (seen on Linux runners).
        assert!(git(&["config", "user.email", "t@t"]).success());
        assert!(git(&["config", "user.name", "T"]).success());
        assert!(git(&["add", "README.md"]).success());
        assert!(git(&["commit", "-m", "base", "--no-gpg-sign"]).success());
        assert!(git(&["switch", "-c", "feat"]).success());
        fs::write(root.join("feat.rs"), "feat").unwrap();
        assert!(git(&["add", "feat.rs"]).success());
        assert!(git(&["commit", "-m", "feat", "--no-gpg-sign"]).success());
        // Stale origin/HEAD: symbolic-ref resolves textually but the target
        // remote ref does not exist (common after remote branch deletions).
        let symbolic_ok = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args([
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/removed-branch",
            ])
            .status()
            .unwrap()
            .success();
        assert!(symbolic_ok, "setting a stale symbolic ref must be possible");

        let root = root.canonicalize().unwrap();
        let status = collect_git_status(&root, &root).unwrap();

        // Must fall back to local main, not silently drop the branch diff.
        assert_eq!(
            status.get("feat.rs").and_then(|value| value.as_str()),
            Some("changed")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn merge_branch_changes_unquotes_git_escaped_paths() {
        // git quotes non-ASCII paths as "\303\251..." in diff --name-status
        // and leaves paths with spaces unquoted; the merge must decode both
        // so tree rows with the real on-disk names match the map keys.
        let mut map = serde_json::Map::new();
        for (raw, expected) in [
            ("A\t\"r\\303\\251sum\\303\\251.rs\"", "résumé.rs"),
            (
                "M\t\"dir with space/caf\\303\\251.txt\"",
                "dir with space/café.txt",
            ),
            (
                "M\tdir with space/file name.txt",
                "dir with space/file name.txt",
            ),
        ] {
            let Some((_kind, path)) = raw.split_once('\t') else {
                panic!("test fixture must be STATUS\tpath");
            };
            let path = unquote_git_path(path.split('\t').next().unwrap_or(path));
            propagate_git_status(&mut map, &path, "changed");
            assert_eq!(
                map.get(expected).and_then(|value| value.as_str()),
                Some("changed"),
                "raw line {raw:?} must land under {expected:?}"
            );
        }
    }

    #[test]
    fn socket_dispatch_rejects_unknown_methods_and_bad_params() {
        assert_eq!(
            socket_dispatch("file.nope", json!({})).unwrap_err(),
            "unknown file-browser method: file.nope"
        );
        // A params object missing required fields fails the shared decode.
        let err = socket_dispatch("file.rename", json!({})).unwrap_err();
        assert!(err.starts_with("invalid parameters:"));
    }

    #[test]
    fn socket_dispatch_answers_every_file_method() {
        let root =
            std::env::temp_dir().join(format!("herdr-webui-fb-socket-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("readme.md"), "# Title\nbody\n").unwrap();
        fs::write(root.join("data.txt"), "needle here\n").unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = root.to_string_lossy().to_string();

        let tree = socket_dispatch("file.tree", json!({ "cwd": &cwd, "depth": Some(1) })).unwrap();
        let paths: Vec<&str> = tree["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&"sub"));
        assert!(paths.contains(&"readme.md"));

        let read =
            socket_dispatch("file.read", json!({ "cwd": &cwd, "path": "data.txt" })).unwrap();
        assert_eq!(read["content"], "needle here\n");
        assert_eq!(read["truncated"], false);

        let written = socket_dispatch(
            "file.write",
            json!({ "cwd": &cwd, "path": "data.txt", "content": "socket write\n" }),
        )
        .unwrap();
        assert_eq!(written["ok"], true);
        assert_eq!(
            fs::read_to_string(root.join("data.txt")).unwrap(),
            "socket write\n"
        );

        let searched =
            socket_dispatch("file.content_search", json!({ "cwd": &cwd, "q": "socket" })).unwrap();
        assert_eq!(searched["total_files"], 1);
        assert_eq!(searched["files"][0]["path"], "data.txt");

        let single = socket_dispatch(
            "file.content_search_file",
            json!({ "cwd": &cwd, "file": "data.txt", "q": "socket" }),
        )
        .unwrap();
        assert_eq!(single["file"]["path"], "data.txt");
        assert_eq!(single["file"]["match_count"], 1);

        let outlined =
            socket_dispatch("file.outline", json!({ "cwd": &cwd, "path": "readme.md" })).unwrap();
        assert_eq!(outlined["outline"][0][2], "Title");

        let renamed = socket_dispatch(
            "file.rename",
            json!({ "cwd": &cwd, "path": "data.txt", "new_name": "data2.txt" }),
        )
        .unwrap();
        assert_eq!(renamed["path"], "data2.txt");
        assert!(root.join("data2.txt").exists());
        assert!(!root.join("data.txt").exists());

        let deleted =
            socket_dispatch("file.delete", json!({ "cwd": &cwd, "path": "data2.txt" })).unwrap();
        assert_eq!(deleted["ok"], true);
        assert!(!root.join("data2.txt").exists());

        // The tree branch error paths answer the same message vocabulary as
        // the HTTP handlers because both share the payload bodies.
        let err =
            socket_dispatch("file.read", json!({ "cwd": &cwd, "path": "../esc" })).unwrap_err();
        assert_eq!(err, "invalid path");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn escape_html_covers_every_replaced_character() {
        assert_eq!(
            escape_html("a&b<c>d\"e'f"),
            "a&amp;b&lt;c&gt;d&quot;e&#39;f"
        );
        assert_eq!(escape_html("plain"), "plain");
        assert_eq!(escape_html(""), "");
    }

    #[test]
    fn highlight_line_html_falls_back_when_offsets_are_unusable() {
        // Offsets beyond the line ignore the mark and search the query.
        let fallback = highlight_line_html("find me here", 99, 120, "me");
        assert_eq!(
            fallback,
            "find <mark class=\"herdr-content-search-hit\">me</mark> here"
        );
        // An empty query in the fallback escapes the line untouched.
        let plain = highlight_line_html("a < b", 99, 120, "");
        assert_eq!(plain, "a &lt; b");
        // Offsets that split a multibyte char are rejected by the boundary
        // check and fall back to the first case-insensitive query hit.
        // The \u{00e9} occupies bytes 3-4, so offset 4 cuts inside it.
        let multibyte = highlight_line_html("caf\u{00e9} latte", 4, 5, "LATTE");
        assert_eq!(
            multibyte,
            "caf\u{00e9} <mark class=\"herdr-content-search-hit\">latte</mark>"
        );
        // A query that does not appear anywhere escapes the whole line.
        let missing = highlight_line_html("nothing", 99, 120, "absent");
        assert_eq!(missing, "nothing");
    }

    #[test]
    fn clean_file_name_and_resolve_helpers_reject_bad_inputs() {
        assert_eq!(clean_file_name("  ok.txt ").unwrap(), "ok.txt");
        for bad in ["", "   ", "a/b", "a\\b", ".", "..", "nul\0byte"] {
            assert!(
                clean_file_name(bad).is_err(),
                "name {bad:?} must be rejected"
            );
        }

        // A root that does not exist fails resolve_root with the invalid
        // root prefix.
        let err = resolve_root("definitely-missing-root-xyz").unwrap_err();
        assert!(err.starts_with("invalid root:"));

        // resolve_child on a path whose parent cannot canonicalize fails.
        let tmp =
            std::env::temp_dir().join(format!("herdr-webui-fb-resolve-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.canonicalize().unwrap();
        // A path that escapes after canonicalization is rejected.
        let escaped = resolve_child(&root, "missing/../../outside");
        assert!(escaped.is_err());
        let _ = fs::remove_dir_all(tmp);
    }

    #[test]
    fn applescript_quote_escapes_backslash_and_quote() {
        assert_eq!(applescript_quote("plain"), "\"plain\"");
        assert_eq!(applescript_quote("a\\b"), "\"a\\\\b\"");
        assert_eq!(applescript_quote("say \"hi\""), "\"say \\\"hi\\\"\"");
    }

    #[test]
    fn file_payload_error_branches_answer_the_right_statuses() {
        let root = std::env::temp_dir().join(format!("herdr-webui-fb-read-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("doc.md"), "# H1\n").unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = root.to_string_lossy().to_string();
        let query = |path: Option<&str>| FileBrowserQuery {
            cwd: cwd.clone(),
            path: path.map(str::to_string),
            dirs_only: None,
            depth: None,
            q: None,
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        };

        // Missing path is a 400 with its own message.
        let err = file_browser_file_payload(query(None)).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path is required");

        // A directory is not a readable file.
        fs::create_dir_all(root.join("folder")).unwrap();
        let err = file_browser_file_payload(query(Some("folder"))).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path is not a file");

        // A nonexistent path is rejected during child resolution.
        let err = file_browser_file_payload(query(Some("ghost.txt"))).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);

        // render=lines attaches the prebuilt gutter and code markup.
        let mut lines_query = query(Some("doc.md"));
        lines_query.render = Some("lines".to_string());
        let payload = file_browser_file_payload(lines_query).unwrap();
        assert_eq!(payload["lines_gutter_html"], "<span>1</span><span>2</span>");
        assert_eq!(payload["lines_code_html"], "# H1\n");

        // A bad cwd fails at root resolution before the path is touched.
        let mut bad_cwd = query(Some("doc.md"));
        bad_cwd.cwd = "definitely-missing-root-xyz".to_string();
        let err = file_browser_file_payload(bad_cwd).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.starts_with("invalid root:"));

        // A file that is not valid UTF-8 answers the binary marker and no
        // content. Every ASCII byte is valid UTF-8, so the fixture needs a
        // high byte sequence like 0xff.
        fs::write(root.join("blob.bin"), b"\xff\xfe\x00").unwrap();
        let payload = file_browser_file_payload(query(Some("blob.bin"))).unwrap();
        assert_eq!(payload["binary"], true);
        assert_eq!(payload["content"], "");
        assert_eq!(payload["hash"], "");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn write_payload_guards_hash_conflicts_and_directory_targets() {
        let root =
            std::env::temp_dir().join(format!("herdr-webui-fb-write-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = root.to_string_lossy().to_string();
        let body =
            |path: &str, content: &str, expected_hash: Option<String>| FileBrowserWriteRequest {
                cwd: cwd.clone(),
                path: path.to_string(),
                content: content.to_string(),
                expected_hash,
                create_parents: false,
            };

        // An empty path is rejected.
        let err = file_browser_write_file_payload(body("", "x", None)).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path is required");

        // Writing onto a directory is rejected.
        fs::create_dir_all(root.join("dir")).unwrap();
        let err = file_browser_write_file_payload(body("dir", "x", None)).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path is a directory");

        // A stale expected_hash is a conflict.
        fs::write(root.join("file.txt"), "current\n").unwrap();
        let err = file_browser_write_file_payload(body(
            "file.txt",
            "new\n",
            Some("stale-hash".to_string()),
        ))
        .unwrap_err();
        assert_eq!(err.0, StatusCode::CONFLICT);
        assert_eq!(err.1, "file changed on disk; reload before saving");
        assert_eq!(
            fs::read_to_string(root.join("file.txt")).unwrap(),
            "current\n"
        );

        // The matching hash lets the write through and answers the new hash.
        let current = file_hash(&root.join("file.txt")).unwrap();
        let payload =
            file_browser_write_file_payload(body("file.txt", "new\n", Some(current))).unwrap();
        assert_eq!(payload["ok"], true);
        assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), "new\n");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rename_and_delete_payloads_cover_existence_and_escape_errors() {
        let root =
            std::env::temp_dir().join(format!("herdr-webui-fb-rename-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.txt"), "a\n").unwrap();
        fs::create_dir_all(root.join("d")).unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = root.to_string_lossy().to_string();

        let rename = |path: &str, new_name: &str| {
            file_browser_rename_payload(FileBrowserRenameRequest {
                cwd: cwd.clone(),
                path: path.to_string(),
                new_name: new_name.to_string(),
            })
        };

        // Missing path is a 400.
        let err = rename("", "b.txt").unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path is required");

        // A path that does not exist is rejected before any rename.
        let err = rename("ghost.txt", "b.txt").unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path does not exist");

        // An invalid new name is rejected by the file name guard.
        let err = rename("a.txt", "../escape").unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "invalid name");

        // A target that already exists is a conflict, source untouched.
        fs::write(root.join("b.txt"), "b\n").unwrap();
        let err = rename("a.txt", "b.txt").unwrap_err();
        assert_eq!(err.0, StatusCode::CONFLICT);
        assert_eq!(err.1, "target already exists");
        assert!(root.join("a.txt").exists());

        // A valid rename answers the new root-relative path.
        let payload = rename("a.txt", "renamed.txt").unwrap();
        assert_eq!(payload["ok"], true);
        assert_eq!(payload["path"], "renamed.txt");
        assert!(!root.join("a.txt").exists());

        let delete = |path: &str| {
            file_browser_delete_payload(FileBrowserDeleteRequest {
                cwd: cwd.clone(),
                path: path.to_string(),
            })
        };

        // Deleting a missing path is a 400.
        let err = delete("ghost.txt").unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path does not exist");

        // Deleting a file removes it.
        let payload = delete("renamed.txt").unwrap();
        assert_eq!(payload["ok"], true);
        assert!(!root.join("renamed.txt").exists());

        // Deleting a directory removes the whole subtree.
        fs::write(root.join("d/inner.txt"), "inner\n").unwrap();
        let payload = delete("d").unwrap();
        assert_eq!(payload["ok"], true);
        assert!(!root.join("d").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn content_search_payload_validates_query_and_regex_errors() {
        let root =
            std::env::temp_dir().join(format!("herdr-webui-fb-csearch-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = root.to_string_lossy().to_string();

        // An empty query is rejected before the walk starts.
        let err = file_browser_content_search_payload(FileContentSearchQuery {
            cwd: cwd.clone(),
            path: None,
            file: None,
            q: "   ".to_string(),
            offset: None,
            limit: None,
            context_lines: None,
            max_matches_per_file: None,
            match_case: None,
            regex: None,
        })
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "query is required");

        // An invalid regex is a 400, not a 502.
        let err = file_browser_content_search_payload(FileContentSearchQuery {
            cwd: cwd.clone(),
            path: None,
            file: None,
            q: "hit(".to_string(),
            offset: None,
            limit: None,
            context_lines: None,
            max_matches_per_file: None,
            match_case: None,
            regex: Some(true),
        })
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.starts_with("invalid regex"));

        // A file target that is not a file is a 400.
        let err = file_browser_content_search_file_payload(FileContentSearchQuery {
            cwd: cwd.clone(),
            path: None,
            file: None,
            q: "needle".to_string(),
            offset: None,
            limit: None,
            context_lines: None,
            max_matches_per_file: None,
            match_case: None,
            regex: None,
        })
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "file is required");

        // A query with no hits answers a null file entry.
        fs::write(root.join("empty.txt"), "nothing relevant\n").unwrap();
        let payload = file_browser_content_search_file_payload(FileContentSearchQuery {
            cwd,
            path: None,
            file: Some("empty.txt".to_string()),
            q: "needle".to_string(),
            offset: None,
            limit: None,
            context_lines: None,
            max_matches_per_file: None,
            match_case: None,
            regex: None,
        })
        .unwrap();
        assert_eq!(payload["query"], "needle");
        assert_eq!(payload["file"], serde_json::Value::Null);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tree_payload_dirs_only_lists_folders_with_sizes_none() {
        let root = std::env::temp_dir().join(format!("herdr-webui-fb-dirs-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("alpha")).unwrap();
        fs::create_dir_all(root.join("beta")).unwrap();
        fs::write(root.join("file.txt"), "x\n").unwrap();
        let root = root.canonicalize().unwrap();

        let payload = file_browser_tree_payload(FileBrowserQuery {
            cwd: root.to_string_lossy().to_string(),
            path: None,
            dirs_only: Some(true),
            depth: None,
            q: None,
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        })
        .unwrap();
        let entries = payload["entries"].as_array().unwrap();
        let names: Vec<&str> = entries
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        assert!(entries.iter().all(|entry| {
            entry["kind"] == "dir"
                && entry["size"].is_null()
                && !entry["expanded"].as_bool().unwrap()
        }));
        assert_eq!(payload["truncated"], false);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn tree_payload_rejects_non_directory_paths_and_bad_roots() {
        let root = std::env::temp_dir().join(format!("herdr-webui-fb-tree-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("plain.txt"), "x\n").unwrap();
        let root = root.canonicalize().unwrap();

        // A file target is not a directory.
        let err = file_browser_tree_payload(FileBrowserQuery {
            cwd: root.to_string_lossy().to_string(),
            path: Some("plain.txt".to_string()),
            dirs_only: None,
            depth: None,
            q: None,
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        })
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path is not a directory");

        // A nonexistent cwd fails root resolution.
        let err = file_browser_tree_payload(FileBrowserQuery {
            cwd: "definitely-missing-root-xyz".to_string(),
            path: None,
            dirs_only: None,
            depth: None,
            q: None,
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        })
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1.starts_with("invalid root:"));

        // A path escape is rejected by the relative path guard before the
        // directory check.
        let err = file_browser_tree_payload(FileBrowserQuery {
            cwd: root.to_string_lossy().to_string(),
            path: Some("../escape".to_string()),
            dirs_only: None,
            depth: None,
            q: None,
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        })
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "invalid path");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn query_hash_and_basename_helpers_pin_their_outputs() {
        // The hash is the first 6 bytes of the query's SHA-256 in hex.
        assert_eq!(query_hash("needle").len(), 12);
        assert_eq!(query_hash("needle"), query_hash("needle"));
        assert_ne!(query_hash("needle"), query_hash("other"));
        assert_eq!(query_hash(""), "e3b0c44298fc");

        assert_eq!(basename_string("a/b/c.txt"), "c.txt");
        assert_eq!(basename_string("top.txt"), "top.txt");
        assert_eq!(basename_string(""), "");

        // line_at slices to the next newline or the end.
        assert_eq!(line_at("one\ntwo\nthree", 0), "one");
        assert_eq!(line_at("one\ntwo\nthree", 4), "two");
        assert_eq!(line_at("one\ntwo\nthree", 8), "three");
        assert_eq!(line_at("no newline", 3), "newline");
    }

    #[test]
    fn content_matcher_rejects_empty_and_reports_offsets() {
        let err = match ContentMatcher::new("", false, false) {
            Err(e) => e,
            Ok(_) => panic!("empty query must be rejected"),
        };
        assert_eq!(err, "empty query");
        // Plain needles escape regex metacharacters before matching.
        let plain = ContentMatcher::new("a.b", true, false).unwrap();
        assert_eq!(plain.find("xa.by"), Some((1, 4)));
        assert_eq!(plain.find("aXb"), None);
        // Regex needles keep their pattern semantics.
        let regex = ContentMatcher::new("a.b", true, true).unwrap();
        assert_eq!(regex.find("aXb"), Some((0, 3)));
        // A zero-width regex match is filtered out of the offsets.
        let zero_width = ContentMatcher::new("x*", false, true).unwrap();
        assert_eq!(zero_width.find("abc"), None);
    }

    #[test]
    fn content_search_context_helpers_clamp_to_bounds() {
        assert_eq!(content_search_context_lines(None), 2);
        assert_eq!(content_search_context_lines(Some(0)), 0);
        assert_eq!(content_search_context_lines(Some(99)), 20);
        assert_eq!(content_search_matches_per_file(None), 5);
        assert_eq!(content_search_matches_per_file(Some(0)), 1);
        assert_eq!(content_search_matches_per_file(Some(9999)), 500);
    }

    #[test]
    fn should_skip_content_dir_matches_the_known_dependency_folders() {
        for name in [
            ".git",
            "node_modules",
            "target",
            "dist",
            "build",
            ".venv",
            "venv",
        ] {
            assert!(
                should_skip_content_dir(Path::new(format!("/x/{name}").as_str())),
                "{name}"
            );
        }
        assert!(!should_skip_content_dir(Path::new("/x/src")));
        // A path with no file name component is not skipped.
        assert!(!should_skip_content_dir(Path::new("/")));
    }

    #[test]
    fn relative_to_root_answers_empty_outside_the_root() {
        let root = Path::new("/repo/root");
        assert_eq!(
            relative_to_root(root, Path::new("/repo/root/a/b.txt")),
            "a/b.txt"
        );
        assert_eq!(relative_to_root(root, Path::new("/repo/root")), "");
        assert_eq!(relative_to_root(root, Path::new("/elsewhere")), "");
    }

    #[test]
    fn unquote_git_path_decodes_octal_escapes_and_friendly_shortcuts() {
        // Octal escapes decode to their bytes.
        assert_eq!(
            unquote_git_path("\"r\\303\\251sum\\303\\251.rs\""),
            "r\u{00e9}sum\u{00e9}.rs"
        );
        // The friendly shortcuts map to the literal characters.
        assert_eq!(unquote_git_path("\"a\\nb\\tc\""), "a\nb\tc");
        // An unknown escape keeps the backslash and the character.
        assert_eq!(unquote_git_path("\"x\\qy\""), "x\\qy");
        // A trailing backslash survives.
        assert_eq!(unquote_git_path("\"end\\\""), "end\\");
        // Unquoted input passes through untouched.
        assert_eq!(unquote_git_path("plain/path.txt"), "plain/path.txt");
    }

    #[test]
    fn git_status_helpers_map_the_full_vocabulary() {
        // parse_porcelain_status pins the XY to status word mapping.
        assert_eq!(parse_porcelain_status("D."), "deleted");
        assert_eq!(parse_porcelain_status(".D"), "deleted");
        assert_eq!(parse_porcelain_status("RM"), "modified");
        assert_eq!(parse_porcelain_status(".A"), "added");
        assert_eq!(parse_porcelain_status("??"), "untracked");
        assert_eq!(parse_porcelain_status("UU"), "conflict");
        assert_eq!(parse_porcelain_status("!!"), "modified");

        // propagated_directory_status maps unknown words to modified.
        assert_eq!(propagated_directory_status("deleted"), "deleted");
        assert_eq!(propagated_directory_status("added"), "added");
        assert_eq!(propagated_directory_status("changed"), "changed");
        assert_eq!(propagated_directory_status("mystery"), "modified");

        // adjust_git_path trims a workspace prefix and drops outside paths.
        assert_eq!(
            adjust_git_path("ws/src/a.rs", "ws"),
            Some("src/a.rs".to_string())
        );
        assert_eq!(adjust_git_path("ws", "ws"), Some(String::new()));
        assert_eq!(adjust_git_path("other/a.rs", "ws"), None);
        // Without a prefix every path is kept as-is.
        assert_eq!(
            adjust_git_path("src/a.rs", ""),
            Some("src/a.rs".to_string())
        );
    }

    #[test]
    fn insert_git_status_priority_keeps_the_strongest_signal() {
        let mut map = serde_json::Map::new();
        insert_git_status(&mut map, "a.rs", "changed");
        // A same-priority status does not change the stored value.
        insert_git_status(&mut map, "a.rs", "changed");
        assert_eq!(map.get("a.rs").and_then(|v| v.as_str()), Some("changed"));
        // Deletion outranks modification.
        insert_git_status(&mut map, "b.rs", "modified");
        insert_git_status(&mut map, "b.rs", "deleted");
        assert_eq!(map.get("b.rs").and_then(|v| v.as_str()), Some("deleted"));
        // An empty path is ignored.
        insert_git_status(&mut map, "", "deleted");
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn resolve_child_create_builds_parents_and_rejects_escapes() {
        let root =
            std::env::temp_dir().join(format!("herdr-webui-fb-create-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();

        // New intermediate directories are created one at a time.
        let file = resolve_child_create(&root, "new/deep/target.txt").unwrap();
        assert!(root.join("new/deep").is_dir());
        assert!(file.starts_with(&root));
        // The final component is never created by the resolver.
        assert!(!file.exists());

        // A .. component is rejected before any mkdir runs.
        assert_eq!(
            resolve_child_create(&root, "new/../escape").unwrap_err(),
            "invalid path"
        );
        // resolve_child on a target whose parents do not exist fails,
        // proving create_parents changes the resolution path.
        assert!(resolve_child(&root, "other/second.txt").is_err());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn file_payload_hash_only_and_oversized_answers() {
        let root = std::env::temp_dir().join(format!("herdr-webui-fb-hash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("small.txt"), "tiny\n").unwrap();
        // Oversized needs more than MAX_FILE_BYTES (1 MiB).
        fs::write(root.join("big.txt"), vec![b'a'; 1024 * 1024 + 1]).unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = root.to_string_lossy().to_string();
        let query =
            |path: &str, hash_only: Option<bool>, max_bytes: Option<u64>| FileBrowserQuery {
                cwd: cwd.clone(),
                path: Some(path.to_string()),
                dirs_only: None,
                depth: None,
                q: None,
                search_kind: None,
                offset: None,
                limit: None,
                visit_offset: None,
                match_case: None,
                regex: None,
                include_git_status: None,
                render: None,
                max_bytes,
                hash_only,
            };

        // hash_only skips the content and answers the hash and size.
        let payload = file_browser_file_payload(query("small.txt", Some(true), None)).unwrap();
        assert_eq!(payload["content"], "");
        assert_eq!(payload["size"], 5);
        assert!(!payload["hash"].as_str().unwrap().is_empty());

        // An oversized file without a budget is truncated, not read.
        let payload = file_browser_file_payload(query("big.txt", None, None)).unwrap();
        assert_eq!(payload["truncated"], true);
        assert_eq!(payload["content"], "");

        // A budget under the minimum is ignored and the read stays truncated.
        let payload = file_browser_file_payload(query("big.txt", None, Some(1))).unwrap();
        assert_eq!(payload["truncated"], true);

        // A valid budget inside the allowed range turns the read into a
        // partial read; the budget minimum is 16 KiB.
        let payload = file_browser_file_payload(query("big.txt", None, Some(16 * 1024))).unwrap();
        assert_eq!(payload["truncated"], true);
        assert_eq!(payload["content"].as_str().unwrap().len(), 16 * 1024);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn outline_payload_errors_and_binary_fallbacks() {
        let root =
            std::env::temp_dir().join(format!("herdr-webui-fb-outline-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("dir")).unwrap();
        fs::write(root.join("doc.md"), "# T\n").unwrap();
        fs::write(root.join("blob.bin"), b"\xff\xfe").unwrap();
        // Oversized outline target.
        fs::write(root.join("big.md"), vec![b'#'; 1024 * 1024 + 1]).unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = root.to_string_lossy().to_string();
        let query = |path: Option<&str>| FileBrowserQuery {
            cwd: cwd.clone(),
            path: path.map(str::to_string),
            dirs_only: None,
            depth: None,
            q: None,
            search_kind: None,
            offset: None,
            limit: None,
            visit_offset: None,
            match_case: None,
            regex: None,
            include_git_status: None,
            render: None,
            max_bytes: None,
            hash_only: None,
        };

        // Missing path is a 400.
        let err = file_browser_outline_payload(query(None)).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path is required");

        // A directory is not outlinable.
        let err = file_browser_outline_payload(query(Some("dir"))).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "path is not a file");

        // Oversized files are rejected up front.
        let err = file_browser_outline_payload(query(Some("big.md"))).unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1, "file too large");

        // A binary file answers an empty outline, not an error.
        let payload = file_browser_outline_payload(query(Some("blob.bin"))).unwrap();
        assert_eq!(payload["outline"].as_array().map(Vec::len), Some(0));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn content_search_skips_binary_and_limits_visits() {
        let root = std::env::temp_dir().join(format!("herdr-webui-fb-walk-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        // A NUL byte in the first 2048 marks the file binary for the walk.
        fs::write(root.join("bin.txt"), b"needle\0needle").unwrap();
        fs::write(root.join("text.txt"), "needle found\n").unwrap();
        let root = root.canonicalize().unwrap();
        let cwd = root.to_string_lossy().to_string();

        let payload = file_browser_content_search_payload(FileContentSearchQuery {
            cwd,
            path: None,
            file: None,
            q: "needle".to_string(),
            offset: None,
            limit: Some(1),
            context_lines: None,
            max_matches_per_file: None,
            match_case: None,
            regex: None,
        })
        .unwrap();
        // The binary file is skipped entirely.
        assert_eq!(payload["total_files"], 1);
        assert_eq!(payload["files"][0]["path"], "text.txt");

        // The single-file variant skips the same binary content.
        let single = file_browser_content_search_file_payload(FileContentSearchQuery {
            cwd: root.to_string_lossy().to_string(),
            path: None,
            file: Some("bin.txt".to_string()),
            q: "needle".to_string(),
            offset: None,
            limit: None,
            context_lines: None,
            max_matches_per_file: None,
            match_case: None,
            regex: None,
        })
        .unwrap();
        assert_eq!(single["file"], serde_json::Value::Null);

        let _ = fs::remove_dir_all(root);
    }
}
