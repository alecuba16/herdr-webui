use std::fs;
use std::net::SocketAddr;
use std::path::Path;
use std::process::Command;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::{git_failure, require_auth, WebState};
use super::{git_json_error, git_ui_repo, git_ui_text, safe_repo_path, safe_git_token};

#[derive(Deserialize)]
pub(super) struct GitUiBlameQuery {
    pub(super) cwd: Option<String>,
    pub(super) file: Option<String>,
    pub(super) ref_name: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct GitUiFileQuery {
    pub(super) cwd: Option<String>,
    pub(super) file: Option<String>,
    pub(super) ref_name: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct GitUiFileHistoryQuery {
    pub(super) cwd: Option<String>,
    pub(super) file: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct GitUiWriteFileRequest {
    pub(super) cwd: String,
    pub(super) path: String,
    pub(super) content: String,
    pub(super) expected_hash: Option<String>,
}

fn git_ui_blame_blocking(
    cwd: String,
    file: String,
    ref_name: String,
) -> Result<Response, (StatusCode, String)> {
    match git_ui_text(&cwd, &["blame", "--line-porcelain", &ref_name, "--", &file]) {
        Ok(text) => Ok(Json(json!({ "text": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_blame(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiBlameQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let (Some(cwd), Some(file)) = (query.cwd.as_deref(), query.file.as_deref()) else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd and file are required");
    };
    let file = match safe_repo_path(file) {
        Ok(file) => file,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let ref_name = match safe_git_token(query.ref_name.as_deref().unwrap_or("HEAD"), "ref") {
        Ok(v) => v,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let cwd = cwd.to_string();
    let file = file.to_string();
    let ref_name = ref_name.to_string();
    match tokio::task::spawn_blocking(move || git_ui_blame_blocking(cwd, file, ref_name)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_working_file_hash(repo: &str, path: &str) -> Result<String, String> {
    let full = Path::new(repo).join(path);
    if !full.exists() {
        return Ok(String::new());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["hash-object", "--", path])
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(git_failure(output, "git hash-object"))
    }
}

fn git_ui_file_blocking(
    cwd: String,
    file: String,
    ref_name: Option<String>,
) -> Result<Response, (StatusCode, String)> {
    let repo = match git_ui_repo(&cwd) {
        Ok(repo) => repo,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let ref_name = ref_name.as_deref().unwrap_or("working");
    if ref_name == "working" {
        let full = Path::new(&repo).join(&file);
        let content = if full.exists() {
            match fs::read_to_string(&full) {
                Ok(content) => content,
                Err(err) => return Err((StatusCode::BAD_GATEWAY, err.to_string())),
            }
        } else {
            String::new()
        };
        let hash = match git_ui_working_file_hash(&repo, &file) {
            Ok(hash) => hash,
            Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
        };
        return Ok(Json(json!({ "path": file, "content": content, "hash": hash })).into_response());
    }
    let ref_name = match safe_git_token(ref_name, "ref") {
        Ok(v) => v,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let spec = format!("{ref_name}:{file}");
    match git_ui_text(&repo, &["show", &spec]) {
        Ok(content) => {
            Ok(Json(json!({ "path": file, "content": content, "hash": "" })).into_response())
        }
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_file(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiFileQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let (Some(cwd), Some(file)) = (query.cwd.as_deref(), query.file.as_deref()) else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd and file are required");
    };
    let file = match safe_repo_path(file) {
        Ok(file) => file,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let cwd = cwd.to_string();
    let file = file.to_string();
    let ref_name = query.ref_name.clone();
    match tokio::task::spawn_blocking(move || git_ui_file_blocking(cwd, file, ref_name)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_write_file_blocking(
    cwd: String,
    path: String,
    content: String,
    expected_hash: Option<String>,
) -> Result<Response, (StatusCode, String)> {
    let repo = match git_ui_repo(&cwd) {
        Ok(repo) => repo,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let current_hash = match git_ui_working_file_hash(&repo, &path) {
        Ok(hash) => hash,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
    };
    if let Some(expected) = expected_hash.as_deref() {
        if expected != current_hash {
            return Err((
                StatusCode::CONFLICT,
                "file changed on disk; reload before saving".to_string(),
            ));
        }
    }
    let full = Path::new(&repo).join(&path);
    if full.is_dir() {
        return Err((StatusCode::BAD_REQUEST, "path is a directory".to_string()));
    }
    if let Some(parent) = full.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            return Err((StatusCode::BAD_GATEWAY, err.to_string()));
        }
    }
    if let Err(err) = fs::write(&full, content) {
        return Err((StatusCode::BAD_GATEWAY, err.to_string()));
    }
    let hash = match git_ui_working_file_hash(&repo, &path) {
        Ok(hash) => hash,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
    };
    Ok(Json(json!({ "ok": true, "path": path, "hash": hash })).into_response())
}

pub(super) async fn git_ui_write_file(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiWriteFileRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let path = match safe_repo_path(&body.path) {
        Ok(path) => path,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let path = path.to_string();
    let cwd = body.cwd;
    let content = body.content;
    let expected_hash = body.expected_hash;
    match tokio::task::spawn_blocking(move || {
        git_ui_write_file_blocking(cwd, path, content, expected_hash)
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_file_history_blocking(
    cwd: String,
    file: String,
) -> Result<Response, (StatusCode, String)> {
    match git_ui_text(
        &cwd,
        &[
            "log",
            "--follow",
            "--date=relative",
            "--format=%h%x00%an%x00%ar%x00%s",
            "--",
            &file,
        ],
    ) {
        Ok(text) => {
            let commits = text.lines().filter_map(|line| {
                let parts: Vec<&str> = line.split('\0').collect();
                (parts.len() >= 4).then(|| json!({ "hash": parts[0], "author": parts[1], "date": parts[2], "message": parts[3] }))
            }).collect::<Vec<_>>();
            Ok(Json(json!({ "commits": commits })).into_response())
        }
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_file_history(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiFileHistoryQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let (Some(cwd), Some(file)) = (query.cwd.as_deref(), query.file.as_deref()) else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd and file are required");
    };
    let file = match safe_repo_path(file) {
        Ok(file) => file,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let cwd = cwd.to_string();
    let file = file.to_string();
    match tokio::task::spawn_blocking(move || git_ui_file_history_blocking(cwd, file)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}