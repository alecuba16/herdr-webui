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
const MAX_FILE_BYTES: u64 = 1024 * 1024;
const MAX_SEARCH_RESULTS: usize = 200;
const MAX_SEARCH_VISITS: usize = 20_000;

pub(crate) fn routes() -> Router<WebState> {
    Router::new()
        .route("/api/file-browser/tree", get(file_browser_tree))
        .route("/api/file-browser/search", get(file_browser_search))
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

fn skip_search_dir(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | ".venv" | "venv" | "vendor" | "dist" | "build"
    )
}

fn smart_case_match(haystack: &str, needle: &str) -> bool {
    if needle.chars().any(|ch| ch.is_uppercase()) {
        haystack.contains(needle)
    } else {
        haystack.to_lowercase().contains(&needle.to_lowercase())
    }
}

fn search_entries(
    root: &Path,
    dir: &Path,
    query: &str,
    limit: usize,
    visits: &mut usize,
    entries: &mut Vec<FileBrowserEntry>,
) -> Result<bool, String> {
    for entry in sorted_directory_entries(dir)? {
        *visits += 1;
        if *visits >= MAX_SEARCH_VISITS {
            return Ok(true);
        }
        let is_dir = entry.metadata.is_dir();
        let path = relative_to_root(root, &entry.path);
        if smart_case_match(&entry.name, query) || smart_case_match(&path, query) {
            entries.push(FileBrowserEntry {
                name: entry.name.clone(),
                path: path.clone(),
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
                level: path.matches('/').count(),
                expanded: false,
            });
            if entries.len() >= limit {
                return Ok(true);
            }
        }
        if is_dir && !skip_search_dir(&entry.name) {
            let truncated = search_entries(root, &entry.path, query, limit, visits, entries)?;
            if truncated {
                return Ok(true);
            }
        }
    }
    Ok(false)
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
    let mut build = TreeBuild {
        root: &root,
        entries: Vec::new(),
        truncated: false,
    };
    if dirs_only {
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
    }))
    .into_response()
}

async fn file_browser_search(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<FileBrowserQuery>,
) -> Response {
    if let Err(response) = file_browser_auth(&state, &headers, remote) {
        return response;
    }
    let q = query.q.as_deref().unwrap_or("").trim();
    if q.is_empty() {
        return Json(json!({ "entries": [], "truncated": false })).into_response();
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
        .unwrap_or(MAX_SEARCH_RESULTS)
        .clamp(1, MAX_SEARCH_RESULTS);
    let mut visits = 0;
    let mut entries = Vec::new();
    let truncated = match search_entries(&root, &dir, q, limit, &mut visits, &mut entries) {
        Ok(value) => value,
        Err(err) => return file_browser_json_error(StatusCode::BAD_GATEWAY, err),
    };
    Json(json!({
        "root": root.to_string_lossy(),
        "path": relative_to_root(&root, &dir),
        "entries": entries,
        "truncated": truncated,
        "visited": visits,
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
    use axum::body::to_bytes;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    fn test_state() -> WebState {
        let bind = "127.0.0.1:8787".parse::<SocketAddr>().unwrap();
        let (rebind_tx, _) = tokio::sync::watch::channel(bind);
        WebState {
            api_socket: None,
            client_socket: None,
            session_name: None,
            herdr_bin: "herdr".to_string(),
            auth: Arc::new(Mutex::new(crate::AuthConfig {
                user: None,
                password: None,
                localhost_no_auth: true,
                token: "test-token".to_string(),
            })),
            server_settings: Arc::new(Mutex::new(crate::RuntimeServerSettings {
                bind,
                user: None,
                password: None,
                localhost_no_auth: true,
                no_sleep_auto_cooldown_seconds: 60,
            })),
            no_sleep: Arc::new(Mutex::new(crate::NoSleepState::default())),
            rebind_tx,
            workspace_orders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn auth_required_state() -> WebState {
        let state = test_state();
        state.auth.lock().unwrap().localhost_no_auth = false;
        state
    }

    fn loopback() -> SocketAddr {
        "127.0.0.1:1234".parse().unwrap()
    }

    fn remote() -> SocketAddr {
        "192.0.2.1:1234".parse().unwrap()
    }

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        root.canonicalize().unwrap()
    }

    async fn response_json(response: Response) -> serde_json::Value {
        let bytes = to_bytes(response.into_body(), 2 * 1024 * 1024)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn clean_relative_path_rejects_escape() {
        assert!(clean_relative_path(Some("../secret")).is_err());
        assert!(clean_relative_path(Some("a/../secret")).is_err());
        assert!(clean_relative_path(Some("bad\0path")).is_err());
        assert_eq!(clean_relative_path(Some("/a/b")).unwrap(), "a/b");
    }

    #[test]
    fn clean_file_name_and_path_helpers_validate_edges() {
        assert_eq!(clean_file_name(" next.txt ").unwrap(), "next.txt");
        for name in ["", ".", "..", "a/b", "a\\b", "bad\0name"] {
            assert!(clean_file_name(name).is_err());
        }

        let root = temp_root("path-helpers");
        fs::write(root.join("file.txt"), "abc").unwrap();
        let outside = root.parent().unwrap().join("outside.txt");
        fs::write(&outside, "outside").unwrap();

        assert!(resolve_root(root.join("missing").to_str().unwrap()).is_err());
        assert_eq!(relative_to_root(&root, &outside), "");
        assert!(resolve_child(&root, "../outside.txt").is_err());
        assert_eq!(file_hash(&root.join("missing.txt")).unwrap(), "");
        assert_eq!(
            file_hash(&root.join("file.txt")).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );

        let _ = fs::remove_file(outside);
        let _ = fs::remove_dir_all(root);
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
    fn search_entries_matches_paths_and_skips_heavy_dirs() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-file-browser-search-test-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::create_dir_all(root.join("target/debug")).unwrap();
        fs::write(root.join("src/nested/NeedleFile.rs"), "match").unwrap();
        fs::write(root.join("target/debug/needle-hidden.rs"), "skip").unwrap();

        let root = root.canonicalize().unwrap();
        let mut visits = 0;
        let mut entries = Vec::new();
        let truncated =
            search_entries(&root, &root, "needle", 20, &mut visits, &mut entries).unwrap();

        assert!(!truncated);
        assert!(entries
            .iter()
            .any(|entry| entry.path == "src/nested/NeedleFile.rs"));
        assert!(!entries
            .iter()
            .any(|entry| entry.path.contains("target/debug")));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn search_and_tree_helpers_cover_limits_and_case_rules() {
        let root = temp_root("limits");
        fs::create_dir_all(root.join("Alpha/Sub")).unwrap();
        fs::write(root.join("Alpha/Sub/Needle.txt"), "hit").unwrap();
        fs::write(root.join("alpha-lower.txt"), "hit").unwrap();
        for index in 0..(MAX_ENTRIES + 2) {
            fs::create_dir_all(root.join(format!("many-{index:04}"))).unwrap();
        }

        let mut visits = 0;
        let mut entries = Vec::new();
        let truncated =
            search_entries(&root, &root, "Needle", 1, &mut visits, &mut entries).unwrap();
        assert!(truncated);
        assert_eq!(entries.len(), 1);
        assert!(entries[0].path.ends_with("Needle.txt"));

        let mut visits = MAX_SEARCH_VISITS - 1;
        let mut entries = Vec::new();
        assert!(search_entries(&root, &root, "missing", 200, &mut visits, &mut entries).unwrap());

        assert!(smart_case_match("Alpha", "Alpha"));
        assert!(!smart_case_match("alpha", "Alpha"));
        assert!(smart_case_match("Alpha", "alpha"));

        let mut build = TreeBuild {
            root: &root,
            entries: Vec::new(),
            truncated: false,
        };
        push_tree_entries(&mut build, &root, 0, 0, true).unwrap();
        assert!(build.truncated);
        assert_eq!(build.entries.len(), MAX_ENTRIES);

        assert!(matches!(
            sorted_directory_entries(&root.join("alpha-lower.txt")),
            Err(err) if !err.is_empty()
        ));
        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn file_browser_tree_file_write_rename_and_delete_routes_work() {
        let root = temp_root("routes");
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/nested/app.rs"), "fn main() {}\n").unwrap();

        let state = test_state();
        let headers = HeaderMap::new();
        let cwd = root.to_string_lossy().to_string();

        let tree = response_json(
            file_browser_tree(
                State(state.clone()),
                headers.clone(),
                ConnectInfo(loopback()),
                Query(FileBrowserQuery {
                    cwd: cwd.clone(),
                    path: Some("src".to_string()),
                    dirs_only: Some(false),
                    depth: Some(2),
                    q: None,
                    limit: None,
                }),
            )
            .await,
        )
        .await;
        assert_eq!(tree["path"], "src");
        assert!(tree["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entry| { entry["path"] == "src/nested/app.rs" && entry["kind"] == "file" }));

        let file = response_json(
            file_browser_file(
                State(state.clone()),
                headers.clone(),
                ConnectInfo(loopback()),
                Query(FileBrowserQuery {
                    cwd: cwd.clone(),
                    path: Some("src/nested/app.rs".to_string()),
                    dirs_only: None,
                    depth: None,
                    q: None,
                    limit: None,
                }),
            )
            .await,
        )
        .await;
        assert_eq!(file["content"], "fn main() {}\n");
        let hash = file["hash"].as_str().unwrap().to_string();

        let written = response_json(
            file_browser_write_file(
                State(state.clone()),
                headers.clone(),
                ConnectInfo(loopback()),
                Json(FileBrowserWriteRequest {
                    cwd: cwd.clone(),
                    path: "src/nested/app.rs".to_string(),
                    content: "fn main() { println!(\"hi\"); }\n".to_string(),
                    expected_hash: Some(hash),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(written["ok"], true);
        assert!(fs::read_to_string(root.join("src/nested/app.rs"))
            .unwrap()
            .contains("println!"));

        let renamed = response_json(
            file_browser_rename(
                State(state.clone()),
                headers.clone(),
                ConnectInfo(loopback()),
                Json(FileBrowserRenameRequest {
                    cwd: cwd.clone(),
                    path: "src/nested/app.rs".to_string(),
                    new_name: "main.rs".to_string(),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(renamed["path"], "src/nested/main.rs");
        assert!(root.join("src/nested/main.rs").exists());

        let deleted = response_json(
            file_browser_delete(
                State(state),
                headers,
                ConnectInfo(loopback()),
                Json(FileBrowserDeleteRequest {
                    cwd,
                    path: "src/nested/main.rs".to_string(),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(deleted["ok"], true);
        assert!(!root.join("src/nested/main.rs").exists());

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn file_browser_routes_report_edge_cases() {
        let root = temp_root("edges");
        fs::write(root.join("binary.bin"), [0, 159, 146, 150]).unwrap();
        fs::write(
            root.join("large.txt"),
            vec![b'x'; (MAX_FILE_BYTES + 1) as usize],
        )
        .unwrap();
        fs::write(root.join("conflict.txt"), "new").unwrap();

        let state = test_state();
        let headers = HeaderMap::new();
        let cwd = root.to_string_lossy().to_string();

        let binary = response_json(
            file_browser_file(
                State(state.clone()),
                headers.clone(),
                ConnectInfo(loopback()),
                Query(FileBrowserQuery {
                    cwd: cwd.clone(),
                    path: Some("binary.bin".to_string()),
                    dirs_only: None,
                    depth: None,
                    q: None,
                    limit: None,
                }),
            )
            .await,
        )
        .await;
        assert_eq!(binary["binary"], true);

        let large = response_json(
            file_browser_file(
                State(state.clone()),
                headers.clone(),
                ConnectInfo(loopback()),
                Query(FileBrowserQuery {
                    cwd: cwd.clone(),
                    path: Some("large.txt".to_string()),
                    dirs_only: None,
                    depth: None,
                    q: None,
                    limit: None,
                }),
            )
            .await,
        )
        .await;
        assert_eq!(large["truncated"], true);

        let conflict = file_browser_write_file(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(loopback()),
            Json(FileBrowserWriteRequest {
                cwd: cwd.clone(),
                path: "conflict.txt".to_string(),
                content: "edit".to_string(),
                expected_hash: Some("stale".to_string()),
            }),
        )
        .await;
        assert_eq!(conflict.status(), StatusCode::CONFLICT);
        assert_eq!(
            response_json(conflict).await["error"],
            "file changed on disk; reload before saving"
        );

        let bad_rename = file_browser_rename(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(loopback()),
            Json(FileBrowserRenameRequest {
                cwd: cwd.clone(),
                path: "conflict.txt".to_string(),
                new_name: "../escape".to_string(),
            }),
        )
        .await;
        assert_eq!(bad_rename.status(), StatusCode::BAD_REQUEST);

        let missing_delete = file_browser_delete(
            State(state),
            headers,
            ConnectInfo(loopback()),
            Json(FileBrowserDeleteRequest {
                cwd,
                path: "missing.txt".to_string(),
            }),
        )
        .await;
        assert_eq!(missing_delete.status(), StatusCode::BAD_REQUEST);

        let _ = fs::remove_dir_all(root);
    }

    #[tokio::test]
    async fn file_browser_routes_cover_validation_and_auth_errors() {
        let root = temp_root("validation");
        fs::create_dir_all(root.join("dir/subdir")).unwrap();
        fs::write(root.join("dir/file.txt"), "text").unwrap();
        fs::write(root.join("dir/target.txt"), "taken").unwrap();
        fs::write(root.join("target.txt"), "taken").unwrap();
        let cwd = root.to_string_lossy().to_string();
        let headers = HeaderMap::new();
        let state = test_state();

        let unauthorized = file_browser_tree(
            State(auth_required_state()),
            headers.clone(),
            ConnectInfo(remote()),
            Query(FileBrowserQuery {
                cwd: cwd.clone(),
                path: None,
                dirs_only: None,
                depth: None,
                q: None,
                limit: None,
            }),
        )
        .await;
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let dirs = response_json(
            file_browser_tree(
                State(state.clone()),
                headers.clone(),
                ConnectInfo(loopback()),
                Query(FileBrowserQuery {
                    cwd: cwd.clone(),
                    path: Some("dir".to_string()),
                    dirs_only: Some(true),
                    depth: Some(8),
                    q: None,
                    limit: None,
                }),
            )
            .await,
        )
        .await;
        assert_eq!(dirs["entries"].as_array().unwrap().len(), 1);
        assert_eq!(dirs["entries"][0]["kind"], "dir");

        let invalid_root = file_browser_tree(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(loopback()),
            Query(FileBrowserQuery {
                cwd: root.join("missing").to_string_lossy().to_string(),
                path: None,
                dirs_only: None,
                depth: None,
                q: None,
                limit: None,
            }),
        )
        .await;
        assert_eq!(invalid_root.status(), StatusCode::BAD_REQUEST);

        let file_as_tree = file_browser_tree(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(loopback()),
            Query(FileBrowserQuery {
                cwd: cwd.clone(),
                path: Some("dir/file.txt".to_string()),
                dirs_only: None,
                depth: None,
                q: None,
                limit: None,
            }),
        )
        .await;
        assert_eq!(file_as_tree.status(), StatusCode::BAD_REQUEST);

        let empty_search = response_json(
            file_browser_search(
                State(state.clone()),
                headers.clone(),
                ConnectInfo(loopback()),
                Query(FileBrowserQuery {
                    cwd: cwd.clone(),
                    path: None,
                    dirs_only: None,
                    depth: None,
                    q: Some("   ".to_string()),
                    limit: None,
                }),
            )
            .await,
        )
        .await;
        assert_eq!(empty_search["entries"].as_array().unwrap().len(), 0);

        let search_not_dir = file_browser_search(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(loopback()),
            Query(FileBrowserQuery {
                cwd: cwd.clone(),
                path: Some("dir/file.txt".to_string()),
                dirs_only: None,
                depth: None,
                q: Some("file".to_string()),
                limit: Some(0),
            }),
        )
        .await;
        assert_eq!(search_not_dir.status(), StatusCode::BAD_REQUEST);

        let missing_file_path = file_browser_file(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(loopback()),
            Query(FileBrowserQuery {
                cwd: cwd.clone(),
                path: Some("".to_string()),
                dirs_only: None,
                depth: None,
                q: None,
                limit: None,
            }),
        )
        .await;
        assert_eq!(missing_file_path.status(), StatusCode::BAD_REQUEST);

        let dir_as_file = file_browser_file(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(loopback()),
            Query(FileBrowserQuery {
                cwd: cwd.clone(),
                path: Some("dir".to_string()),
                dirs_only: None,
                depth: None,
                q: None,
                limit: None,
            }),
        )
        .await;
        assert_eq!(dir_as_file.status(), StatusCode::BAD_REQUEST);

        let write_dir = file_browser_write_file(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(loopback()),
            Json(FileBrowserWriteRequest {
                cwd: cwd.clone(),
                path: "dir".to_string(),
                content: "nope".to_string(),
                expected_hash: None,
            }),
        )
        .await;
        assert_eq!(write_dir.status(), StatusCode::BAD_REQUEST);

        let created = response_json(
            file_browser_write_file(
                State(state.clone()),
                headers.clone(),
                ConnectInfo(loopback()),
                Json(FileBrowserWriteRequest {
                    cwd: cwd.clone(),
                    path: "dir/new.txt".to_string(),
                    content: "new".to_string(),
                    expected_hash: None,
                }),
            )
            .await,
        )
        .await;
        assert_eq!(created["ok"], true);
        assert_eq!(fs::read_to_string(root.join("dir/new.txt")).unwrap(), "new");

        let rename_missing_path = file_browser_rename(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(loopback()),
            Json(FileBrowserRenameRequest {
                cwd: cwd.clone(),
                path: "".to_string(),
                new_name: "x".to_string(),
            }),
        )
        .await;
        assert_eq!(rename_missing_path.status(), StatusCode::BAD_REQUEST);

        let rename_missing_source = file_browser_rename(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(loopback()),
            Json(FileBrowserRenameRequest {
                cwd: cwd.clone(),
                path: "missing.txt".to_string(),
                new_name: "x".to_string(),
            }),
        )
        .await;
        assert_eq!(rename_missing_source.status(), StatusCode::BAD_REQUEST);

        let rename_conflict = file_browser_rename(
            State(state.clone()),
            headers.clone(),
            ConnectInfo(loopback()),
            Json(FileBrowserRenameRequest {
                cwd: cwd.clone(),
                path: "dir/file.txt".to_string(),
                new_name: "target.txt".to_string(),
            }),
        )
        .await;
        assert_eq!(rename_conflict.status(), StatusCode::CONFLICT);

        let delete_dir = response_json(
            file_browser_delete(
                State(state),
                headers,
                ConnectInfo(loopback()),
                Json(FileBrowserDeleteRequest {
                    cwd,
                    path: "dir/subdir".to_string(),
                }),
            )
            .await,
        )
        .await;
        assert_eq!(delete_dir["ok"], true);
        assert!(!root.join("dir/subdir").exists());

        let _ = fs::remove_dir_all(root);
    }
}
