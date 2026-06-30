use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::{require_auth, WebState};
use super::{git_json_error, git_ui_text, safe_repo_path, safe_git_token, GitUiCwdQuery};

#[derive(Deserialize)]
pub(super) struct GitUiStashPushRequest {
    pub(super) cwd: String,
    pub(super) message: Option<String>,
    pub(super) paths: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub(super) struct GitUiStashApplyRequest {
    pub(super) cwd: String,
    pub(super) stash: Option<String>,
    pub(super) pop: Option<bool>,
}

#[derive(Deserialize)]
pub(super) struct GitUiStashDropRequest {
    pub(super) cwd: String,
    pub(super) stash: Option<String>,
    pub(super) confirmed: Option<bool>,
}

fn git_ui_stashes_blocking(cwd: String) -> Result<Response, (StatusCode, String)> {
    match git_ui_text(&cwd, &["stash", "list", "--format=%gd%x00%h%x00%cr%x00%gs"]) {
        Ok(text) => {
            let stashes = text.lines().filter_map(|line| {
                let parts: Vec<&str> = line.split('\0').collect();
                (parts.len() >= 4).then(|| json!({ "name": parts[0], "hash": parts[1], "date": parts[2], "message": parts[3] }))
            }).collect::<Vec<_>>();
            Ok(Json(json!({ "stashes": stashes })).into_response())
        }
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_stashes(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiCwdQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let Some(cwd) = query.cwd.as_deref() else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    let cwd = cwd.to_string();
    match tokio::task::spawn_blocking(move || git_ui_stashes_blocking(cwd)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_stash_blocking(
    cwd: String,
    msg: String,
    safe_paths: Option<Vec<String>>,
) -> Result<Response, (StatusCode, String)> {
    let mut args = vec!["stash", "push", "-u", "-m", &msg];
    if let Some(paths) = &safe_paths {
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
    }
    match git_ui_text(&cwd, &args) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_stash(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiStashPushRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let msg = body.message.as_deref().unwrap_or("herdr-webui stash").to_string();
    let safe_paths = match body.paths.as_ref() {
        Some(paths) if !paths.is_empty() => {
            let safe = paths
                .iter()
                .map(|path| safe_repo_path(path))
                .collect::<Result<Vec<_>, _>>();
            match safe {
                Ok(paths) => Some(paths.into_iter().map(|p| p.to_string()).collect::<Vec<_>>()),
                Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
            }
        }
        _ => None,
    };
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_stash_blocking(cwd, msg, safe_paths)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_stash_apply_blocking(
    cwd: String,
    stash: String,
    pop: bool,
) -> Result<Response, (StatusCode, String)> {
    let op = if pop { "pop" } else { "apply" };
    match git_ui_text(&cwd, &["stash", op, &stash]) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_stash_apply(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiStashApplyRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let stash = match safe_git_token(body.stash.as_deref().unwrap_or("stash@{0}"), "stash") {
        Ok(v) => v.to_string(),
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let pop = body.pop.unwrap_or(false);
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_stash_apply_blocking(cwd, stash, pop)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_stash_drop_blocking(
    cwd: String,
    stash: String,
) -> Result<Response, (StatusCode, String)> {
    match git_ui_text(&cwd, &["stash", "drop", &stash]) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_stash_drop(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiStashDropRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    if !body.confirmed.unwrap_or(false) {
        return git_json_error(StatusCode::BAD_REQUEST, "stash drop requires confirmation");
    }
    let stash = match safe_git_token(body.stash.as_deref().unwrap_or("stash@{0}"), "stash") {
        Ok(v) => v.to_string(),
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_stash_drop_blocking(cwd, stash)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}