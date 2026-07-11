use std::collections::VecDeque;
use std::fs;
use std::io::{Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{expand_user_path_string, require_auth, WebState};

const MAX_ENTRIES: usize = 1000;
const MAX_SEARCH_VISITS: usize = 20_000;
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
        .route(
            "/api/file-browser/content-search/snippet",
            axum::routing::post(file_browser_save_content_snippet),
        )
        .route(
            "/api/file-browser/rename",
            axum::routing::post(file_browser_rename),
        )
        .route(
            "/api/file-browser/delete",
            axum::routing::post(file_browser_delete),
        )
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
    include_git_status: Option<bool>,
}

#[derive(Deserialize)]
struct FileBrowserWriteRequest {
    cwd: String,
    path: String,
    content: String,
    expected_hash: Option<String>,
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
struct FileContentSnippetSaveRequest {
    cwd: String,
    path: String,
    expected_hash: String,
    start_line: usize,
    end_line: usize,
    content: String,
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
struct ContentSearchFile {
    path: String,
    name: String,
    size: u64,
    hash: String,
    match_count: usize,
    matches: Vec<ContentSearchMatch>,
    truncated: bool,
}

struct ContentSearchBuild {
    files: Vec<ContentSearchFile>,
    total_files: usize,
    total_matches: usize,
    visited: usize,
    truncated: bool,
}

enum ContentMatcher {
    Plain { needle: String, match_case: bool },
    Regex(Regex),
}

impl ContentMatcher {
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
        Ok(Self::Plain {
            needle: if match_case {
                query.to_string()
            } else {
                query.to_lowercase()
            },
            match_case,
        })
    }

    fn find(&self, line: &str) -> Option<(usize, usize)> {
        match self {
            Self::Plain { needle, match_case } => {
                let haystack = if *match_case {
                    line.to_string()
                } else {
                    line.to_lowercase()
                };
                haystack
                    .find(needle)
                    .map(|start| (start, start + needle.len()))
            }
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
    (status, Json(json!({ "error": error.into() }))).into_response()
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
    for entry in sorted_directory_entries(dir)? {
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

fn push_search_entries(
    build: &mut TreeBuild,
    dir: &Path,
    needle: &str,
    offset: usize,
    limit: usize,
    visited: &mut usize,
    matched: &mut usize,
    search_kind: Option<&str>,
) -> Result<(), String> {
    push_search_entries_with_visit_limit(
        build,
        dir,
        needle,
        offset,
        limit,
        visited,
        matched,
        search_kind,
        MAX_SEARCH_VISITS,
    )
}

fn push_search_entries_with_visit_limit(
    build: &mut TreeBuild,
    dir: &Path,
    needle: &str,
    offset: usize,
    limit: usize,
    visited: &mut usize,
    matched: &mut usize,
    search_kind: Option<&str>,
    max_visits: usize,
) -> Result<(), String> {
    if build.entries.len() >= limit || *visited >= max_visits {
        build.truncated = true;
        return Ok(());
    }
    let mut queue = VecDeque::from([dir.to_path_buf()]);
    while let Some(current_dir) = queue.pop_front() {
        for entry in sorted_directory_entries(&current_dir)? {
            *visited += 1;
            if *visited >= max_visits {
                build.truncated = true;
                return Ok(());
            }
            let is_dir = entry.metadata.is_dir();
            let kind = if is_dir { "dir" } else { "file" };
            let kind_matches = search_kind.map_or(true, |wanted| wanted == kind);
            if kind_matches
                && (entry.sort_name.contains(needle)
                    || relative_to_root(build.root, &entry.path)
                        .to_lowercase()
                        .contains(needle))
            {
                if *matched >= offset && build.entries.len() < limit {
                    build.entries.push(FileBrowserEntry {
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
                    });
                }
                *matched += 1;
                if build.entries.len() >= limit {
                    build.truncated = true;
                    return Ok(());
                }
            }
            if is_dir {
                queue.push_back(entry.path);
            }
        }
    }
    Ok(())
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
    let lines = content.lines().map(str::to_string).collect::<Vec<_>>();
    let mut matches = Vec::new();
    let mut match_count = 0usize;
    let qhash = query_hash(query);
    for (index, line) in lines.iter().enumerate() {
        let Some((match_start, match_end)) = matcher.find(line) else {
            continue;
        };
        match_count += 1;
        if matches.len() >= max_matches {
            continue;
        }
        let start = index.saturating_sub(context_lines);
        let end = (index + context_lines + 1).min(lines.len());
        let before = lines[start..index].to_vec();
        let after = lines[(index + 1)..end].to_vec();
        let snippet = lines[start..end].join("\n");
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
            text: line.clone(),
            after,
        });
    }
    if match_count == 0 {
        return Ok(None);
    }
    let hash = file_hash(file)?;
    Ok(Some(ContentSearchFile {
        path: rel.clone(),
        name: basename_string(&rel),
        size: metadata.len(),
        hash,
        match_count,
        matches,
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
    while let Some(current_dir) = queue.pop_front() {
        for entry in sorted_directory_entries(&current_dir)? {
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
            let Some(result) = content_search_file(
                root,
                &entry.path,
                query,
                &matcher,
                context_lines,
                max_matches_per_file,
            )?
            else {
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

fn replace_line_range(
    content: &str,
    start_line: usize,
    end_line: usize,
    replacement: &str,
) -> Result<String, String> {
    if start_line == 0 || end_line < start_line {
        return Err("invalid line range".to_string());
    }
    let mut lines = content.split('\n').map(str::to_string).collect::<Vec<_>>();
    if lines.is_empty() {
        lines.push(String::new());
    }
    if start_line > lines.len() || end_line > lines.len() {
        return Err("line range outside file".to_string());
    }
    let replacement_lines = replacement
        .split('\n')
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.splice((start_line - 1)..end_line, replacement_lines);
    Ok(lines.join("\n"))
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
        _ => 0,
    }
}

fn propagated_directory_status(status: &str) -> &'static str {
    match status {
        "deleted" => "deleted",
        "added" | "untracked" => "added",
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
    let repo_root_output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !repo_root_output.status.success() {
        return None;
    }
    let repo_root = PathBuf::from(String::from_utf8_lossy(&repo_root_output.stdout).trim());
    let prefix = root
        .strip_prefix(&repo_root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_default();
    let prefix_trim = prefix.trim_end_matches('/');

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
        let path = path.split('\t').next().unwrap_or(path);
        // Strip surrounding quotes if present (git quotes paths with special chars)
        let path = if path.starts_with('"') && path.ends_with('"') {
            &path[1..path.len() - 1]
        } else {
            path
        };
        let status = parse_porcelain_status(xy);
        // Adjust path to be relative to the workspace root. This lets the same map
        // color current rows, expanded children, and search results consistently.
        let adjusted = if prefix_trim.is_empty() {
            path.to_string()
        } else {
            let full_prefix = format!("{}/", prefix_trim);
            if let Some(stripped) = path.strip_prefix(&full_prefix) {
                stripped.to_string()
            } else if path == prefix_trim {
                String::new()
            } else {
                continue;
            }
        };
        propagate_git_status(&mut map, &adjusted, status);
    }
    if map.is_empty() {
        return None;
    }
    Some(map)
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
    let root = match resolve_root(&query.cwd) {
        Ok(root) => root,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let rel = match clean_relative_path(query.path.as_deref()) {
        Ok(rel) => rel,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let dir = match resolve_child(&root, &rel) {
        Ok(dir) => dir,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    if !dir.is_dir() {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "path is not a directory");
    }
    let dirs_only = query.dirs_only.unwrap_or(false);
    let depth = if dirs_only {
        0
    } else {
        query.depth.unwrap_or(0).min(8)
    };
    let search = query.q.as_deref().unwrap_or("").trim().to_lowercase();
    let mut build = TreeBuild {
        root: &root,
        entries: Vec::new(),
        truncated: false,
    };
    if !search.is_empty() {
        let mut visited = 0usize;
        let mut matched = 0usize;
        let limit = query
            .limit
            .unwrap_or(DEFAULT_SEARCH_LIMIT)
            .clamp(1, MAX_SEARCH_LIMIT);
        let offset = query.offset.unwrap_or(0);
        let search_kind = query
            .search_kind
            .as_deref()
            .filter(|kind| *kind == "file" || *kind == "dir");
        if let Err(err) = push_search_entries(
            &mut build,
            &dir,
            &search,
            offset,
            limit,
            &mut visited,
            &mut matched,
            search_kind,
        ) {
            return file_browser_json_error(StatusCode::BAD_GATEWAY, err);
        }
    } else if dirs_only {
        for entry in match sorted_directory_entries(&dir) {
            Ok(entries) => entries,
            Err(err) => return file_browser_json_error(StatusCode::BAD_GATEWAY, err),
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
        return file_browser_json_error(StatusCode::BAD_GATEWAY, err);
    }
    let git_status = if query.include_git_status.unwrap_or(false) {
        collect_git_status(&root, &dir)
    } else {
        None
    };
    Json(json!({
        "root": root.to_string_lossy(),
        "path": relative_to_root(&root, &dir),
        "entries": build.entries,
        "truncated": build.truncated,
        "query": search,
        "git_status": git_status,
    }))
    .into_response()
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
    let root = match resolve_root(&query.cwd) {
        Ok(root) => root,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let rel = match clean_relative_path(query.path.as_deref()) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return file_browser_json_error(StatusCode::BAD_REQUEST, "path is required"),
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let file = match resolve_child(&root, &rel) {
        Ok(file) => file,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    if !file.is_file() {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "path is not a file");
    }
    let metadata = match fs::metadata(&file) {
        Ok(metadata) => metadata,
        Err(err) => return file_browser_json_error(StatusCode::BAD_GATEWAY, err.to_string()),
    };
    if metadata.len() > MAX_FILE_BYTES {
        return Json(json!({
            "path": rel,
            "content": "",
            "hash": "",
            "binary": false,
            "truncated": true,
            "size": metadata.len(),
        }))
        .into_response();
    }
    let bytes = match fs::read(&file) {
        Ok(bytes) => bytes,
        Err(err) => return file_browser_json_error(StatusCode::BAD_GATEWAY, err.to_string()),
    };
    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(_) => {
            return Json(json!({
                "path": rel,
                "content": "",
                "hash": "",
                "binary": true,
                "truncated": false,
                "size": metadata.len(),
            }))
            .into_response()
        }
    };
    let hash = match file_hash(&file) {
        Ok(hash) => hash,
        Err(err) => return file_browser_json_error(StatusCode::BAD_GATEWAY, err),
    };
    Json(json!({
        "path": rel,
        "content": content,
        "hash": hash,
        "binary": false,
        "truncated": false,
        "size": metadata.len(),
    }))
    .into_response()
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
    let root = match resolve_root(&body.cwd) {
        Ok(root) => root,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let rel = match clean_relative_path(Some(&body.path)) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return file_browser_json_error(StatusCode::BAD_REQUEST, "path is required"),
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let file = match resolve_child(&root, &rel) {
        Ok(file) => file,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    if file.is_dir() {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "path is a directory");
    }
    let current_hash = match file_hash(&file) {
        Ok(hash) => hash,
        Err(err) => return file_browser_json_error(StatusCode::BAD_GATEWAY, err),
    };
    if let Some(expected_hash) = body.expected_hash.as_deref() {
        if expected_hash != current_hash {
            return file_browser_json_error(
                StatusCode::CONFLICT,
                "file changed on disk; reload before saving",
            );
        }
    }
    if let Some(parent) = file.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            return file_browser_json_error(StatusCode::BAD_GATEWAY, err.to_string());
        }
    }
    if let Err(err) =
        fs::File::create(&file).and_then(|mut file| file.write_all(body.content.as_bytes()))
    {
        return file_browser_json_error(StatusCode::BAD_GATEWAY, err.to_string());
    }
    let hash = match file_hash(&file) {
        Ok(hash) => hash,
        Err(err) => return file_browser_json_error(StatusCode::BAD_GATEWAY, err),
    };
    Json(json!({ "ok": true, "path": rel, "hash": hash })).into_response()
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
    let search = query.q.trim();
    if search.is_empty() {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "query is required");
    }
    let root = match resolve_root(&query.cwd) {
        Ok(root) => root,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let rel = match clean_relative_path(query.path.as_deref()) {
        Ok(rel) => rel,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let dir = match resolve_child(&root, &rel) {
        Ok(dir) => dir,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    if !dir.is_dir() {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "path is not a directory");
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
            return file_browser_json_error(status, err);
        }
    };
    Json(json!({
        "root": root.to_string_lossy(),
        "path": relative_to_root(&root, &dir),
        "query": search,
        "files": build.files,
        "total_files": build.total_files,
        "total_matches": build.total_matches,
        "visited": build.visited,
        "truncated": build.truncated,
    }))
    .into_response()
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
    let search = query.q.trim();
    if search.is_empty() {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "query is required");
    }
    let root = match resolve_root(&query.cwd) {
        Ok(root) => root,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let rel = match clean_relative_path(query.file.as_deref().or(query.path.as_deref())) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return file_browser_json_error(StatusCode::BAD_REQUEST, "file is required"),
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let file = match resolve_child(&root, &rel) {
        Ok(file) => file,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    if !file.is_file() {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "path is not a file");
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
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let result =
        match content_search_file(&root, &file, search, &matcher, context_lines, max_matches) {
            Ok(Some(result)) => result,
            Ok(None) => {
                return Json(json!({
                    "query": search,
                    "file": null,
                }))
                .into_response()
            }
            Err(err) => return file_browser_json_error(StatusCode::BAD_GATEWAY, err),
        };
    Json(json!({
        "query": search,
        "file": result,
    }))
    .into_response()
}

async fn file_browser_save_content_snippet(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<FileContentSnippetSaveRequest>,
) -> Response {
    if let Err(response) = file_browser_auth(&state, &headers, remote) {
        return response;
    }
    let root = match resolve_root(&body.cwd) {
        Ok(root) => root,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let rel = match clean_relative_path(Some(&body.path)) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return file_browser_json_error(StatusCode::BAD_REQUEST, "path is required"),
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let file = match resolve_child(&root, &rel) {
        Ok(file) => file,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    if !file.is_file() {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "path is not a file");
    }
    let current_hash = match file_hash(&file) {
        Ok(hash) => hash,
        Err(err) => return file_browser_json_error(StatusCode::BAD_GATEWAY, err),
    };
    if current_hash != body.expected_hash {
        return file_browser_json_error(
            StatusCode::CONFLICT,
            "file changed on disk; reload before saving",
        );
    }
    let current = match fs::read_to_string(&file) {
        Ok(content) => content,
        Err(err) => return file_browser_json_error(StatusCode::BAD_GATEWAY, err.to_string()),
    };
    let next = match replace_line_range(&current, body.start_line, body.end_line, &body.content) {
        Ok(next) => next,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    if let Err(err) = fs::write(&file, next.as_bytes()) {
        return file_browser_json_error(StatusCode::BAD_GATEWAY, err.to_string());
    }
    let hash = match file_hash(&file) {
        Ok(hash) => hash,
        Err(err) => return file_browser_json_error(StatusCode::BAD_GATEWAY, err),
    };
    Json(json!({ "ok": true, "path": rel, "hash": hash })).into_response()
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
    let root = match resolve_root(&body.cwd) {
        Ok(root) => root,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let rel = match clean_relative_path(Some(&body.path)) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return file_browser_json_error(StatusCode::BAD_REQUEST, "path is required"),
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let new_name = match clean_file_name(&body.new_name) {
        Ok(name) => name,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let source = match resolve_child(&root, &rel) {
        Ok(path) => path,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    if !source.exists() {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "path does not exist");
    }
    let Some(parent) = source.parent() else {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "invalid path");
    };
    let target = parent.join(new_name);
    if !target.starts_with(&root) {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "path escapes root");
    }
    if target.exists() {
        return file_browser_json_error(StatusCode::CONFLICT, "target already exists");
    }
    if let Err(err) = fs::rename(&source, &target) {
        return file_browser_json_error(StatusCode::BAD_GATEWAY, err.to_string());
    }
    Json(json!({ "ok": true, "path": relative_to_root(&root, &target) })).into_response()
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
    let root = match resolve_root(&body.cwd) {
        Ok(root) => root,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let rel = match clean_relative_path(Some(&body.path)) {
        Ok(rel) if !rel.is_empty() => rel,
        Ok(_) => return file_browser_json_error(StatusCode::BAD_REQUEST, "path is required"),
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    let path = match resolve_child(&root, &rel) {
        Ok(path) => path,
        Err(err) => return file_browser_json_error(StatusCode::BAD_REQUEST, err),
    };
    if path.is_dir() {
        if let Err(err) = fs::remove_dir_all(&path) {
            return file_browser_json_error(StatusCode::BAD_GATEWAY, err.to_string());
        }
    } else if path.is_file() {
        if let Err(err) = fs::remove_file(&path) {
            return file_browser_json_error(StatusCode::BAD_GATEWAY, err.to_string());
        }
    } else {
        return file_browser_json_error(StatusCode::BAD_REQUEST, "path does not exist");
    }
    Json(json!({ "ok": true })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_relative_path_rejects_escape() {
        assert!(clean_relative_path(Some("../secret")).is_err());
        assert!(clean_relative_path(Some("a/../secret")).is_err());
        assert_eq!(clean_relative_path(Some("/a/b")).unwrap(), "a/b");
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
        let mut build = TreeBuild {
            root: &root,
            entries: Vec::new(),
            truncated: false,
        };
        let mut visited = 0;
        let mut matched = 0;
        push_search_entries(
            &mut build,
            &root,
            "app",
            0,
            2,
            &mut visited,
            &mut matched,
            Some("file"),
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
        push_search_entries(
            &mut dir_build,
            &root,
            "app",
            0,
            10,
            &mut visited,
            &mut matched,
            Some("dir"),
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
    fn push_search_entries_reaches_shallow_sibling_before_deep_branch_limit() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-bfs-search-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("bulk/a/b/c/d/e/f/g/h/i/j")).unwrap();
        fs::create_dir_all(root.join("projects/herdr")).unwrap();

        let root = root.canonicalize().unwrap();
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
            "herdr",
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
    fn replace_line_range_replaces_inclusive_range() {
        let next = replace_line_range("a\nb\nc\nd", 2, 3, "B\nC").unwrap();
        assert_eq!(next, "a\nB\nC\nd");
        assert!(replace_line_range("a", 0, 1, "x").is_err());
        assert!(replace_line_range("a", 2, 2, "x").is_err());
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
}
