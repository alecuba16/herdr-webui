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
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{expand_user_path_string, require_auth, WebState};

const MAX_ENTRIES: usize = 1000;
const MAX_SEARCH_VISITS: usize = 20_000;
const DEFAULT_SEARCH_LIMIT: usize = 100;
const MAX_SEARCH_LIMIT: usize = 500;
const MAX_FILE_BYTES: u64 = 1024 * 1024;

pub(crate) fn routes() -> Router<WebState> {
    Router::new()
        .route("/api/file-browser/tree", get(file_browser_tree))
        .route(
            "/api/file-browser/file",
            get(file_browser_file).post(file_browser_write_file),
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
    offset: Option<usize>,
    limit: Option<usize>,
}

#[derive(Deserialize)]
struct FileBrowserWriteRequest {
    cwd: String,
    path: String,
    content: String,
    expected_hash: Option<String>,
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
) -> Result<(), String> {
    if build.entries.len() >= limit || *visited >= MAX_SEARCH_VISITS {
        build.truncated = true;
        return Ok(());
    }
    for entry in sorted_directory_entries(dir)? {
        *visited += 1;
        if *visited >= MAX_SEARCH_VISITS {
            build.truncated = true;
            break;
        }
        let is_dir = entry.metadata.is_dir();
        if entry.sort_name.contains(needle)
            || relative_to_root(build.root, &entry.path)
                .to_lowercase()
                .contains(needle)
        {
            if *matched >= offset && build.entries.len() < limit {
                build.entries.push(FileBrowserEntry {
                    name: entry.name.clone(),
                    path: relative_to_root(build.root, &entry.path),
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
                    level: 0,
                    expanded: false,
                });
            }
            *matched += 1;
            if build.entries.len() >= limit {
                build.truncated = true;
                break;
            }
        }
        if is_dir {
            push_search_entries(build, &entry.path, needle, offset, limit, visited, matched)?;
            if build.truncated || build.entries.len() >= limit {
                break;
            }
        }
    }
    Ok(())
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
        if let Err(err) = push_search_entries(
            &mut build,
            &dir,
            &search,
            offset,
            limit,
            &mut visited,
            &mut matched,
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
    Json(json!({
        "root": root.to_string_lossy(),
        "path": relative_to_root(&root, &dir),
        "entries": build.entries,
        "truncated": build.truncated,
        "query": search,
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
        push_search_entries(&mut build, &root, "app", 0, 2, &mut visited, &mut matched).unwrap();

        let paths = build
            .entries
            .iter()
            .map(|entry| entry.path.as_str())
            .collect::<Vec<_>>();
        assert!(paths.contains(&"src/app.rs"));
        assert!(paths.contains(&"src/nested/app_test.rs"));
        assert!(matched >= 2);
        let _ = fs::remove_dir_all(root);
    }
}
