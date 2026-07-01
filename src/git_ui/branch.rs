use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::{git_json_error, git_ui_text, list_local_branches, safe_git_token, GitUiCwdQuery};
use crate::{require_auth, WebState};

#[derive(Deserialize)]
pub(super) struct GitUiSwitchRequest {
    pub(super) cwd: String,
    pub(super) branch: String,
    pub(super) create: Option<bool>,
    pub(super) base: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct GitUiBranchDeleteRequest {
    pub(super) cwd: String,
    pub(super) branch: String,
    pub(super) force: Option<bool>,
    pub(super) confirmed: Option<bool>,
}

fn git_ui_branches_blocking(cwd: String) -> Result<Response, (StatusCode, String)> {
    let local = match list_local_branches(&cwd) {
        Ok(branches) => branches,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
    };
    let local_json = local
        .iter()
        .map(|b| json!({ "name": b.name, "current": b.current, "remote": false }))
        .collect::<Vec<_>>();
    let remote_text = match git_ui_text(&cwd, &["branch", "-r", "--format=%(refname:short)"]) {
        Ok(text) => text,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
    };
    let remote = remote_text
        .lines()
        .filter_map(|line| {
            let name = line.trim();
            if name.is_empty() || name.ends_with("/HEAD") {
                return None;
            }
            Some(json!({ "name": name, "current": false, "remote": true }))
        })
        .collect::<Vec<_>>();
    let mut branches = local_json.clone();
    branches.extend(remote.clone());
    Ok(
        Json(json!({ "branches": branches, "local": local_json, "remote": remote }))
            .into_response(),
    )
}

pub(super) async fn git_ui_branches(
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
    match tokio::task::spawn_blocking(move || git_ui_branches_blocking(cwd)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_branch_delete_blocking(
    cwd: String,
    branch: String,
    force: bool,
) -> Result<Response, (StatusCode, String)> {
    let delete_flag = if force { "-D" } else { "-d" };
    match git_ui_text(&cwd, &["branch", delete_flag, "--", &branch]) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_branch_delete(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiBranchDeleteRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    if !body.confirmed.unwrap_or(false) {
        return git_json_error(
            StatusCode::BAD_REQUEST,
            "branch deletion requires confirmation",
        );
    }
    let branch = match safe_git_token(&body.branch, "branch") {
        Ok(v) => v.to_string(),
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let force = body.force.unwrap_or(false);
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_branch_delete_blocking(cwd, branch, force))
        .await
    {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_switch_blocking(
    cwd: String,
    args: Vec<String>,
) -> Result<Response, (StatusCode, String)> {
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    match git_ui_text(&cwd, &refs) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_switch(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiSwitchRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let branch = match safe_git_token(&body.branch, "branch") {
        Ok(v) => v,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    if branch.is_empty() {
        return git_json_error(StatusCode::BAD_REQUEST, "branch is required");
    }
    let args: Vec<String> = if body.create.unwrap_or(false) {
        let base = match safe_git_token(body.base.as_deref().unwrap_or("HEAD"), "base") {
            Ok(v) => v,
            Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
        };
        vec![
            "switch".to_string(),
            "-c".to_string(),
            branch.to_string(),
            base.to_string(),
        ]
    } else {
        vec!["switch".to_string(), branch.to_string()]
    };
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_switch_blocking(cwd, args)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}
