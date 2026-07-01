use std::fs;
use std::net::SocketAddr;
use std::path::Path;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::{
    git_json_error, git_ui_output, git_ui_repo, git_ui_text, safe_repo_path, GitUiCwdQuery,
};
use crate::{require_auth, WebState};

#[derive(Deserialize)]
pub(super) struct GitUiConflictResolveRequest {
    pub(super) cwd: String,
    pub(super) path: String,
    pub(super) mode: String,
    pub(super) content: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct GitUiConflictActionRequest {
    pub(super) cwd: String,
    pub(super) action: String,
}

fn git_ui_conflicts_blocking(cwd: String) -> Result<Response, (StatusCode, String)> {
    let mut warnings: Vec<String> = Vec::new();
    let files = match git_ui_text(&cwd, &["diff", "--name-only", "--diff-filter=U"]) {
        Ok(text) => text.lines().map(ToOwned::to_owned).collect::<Vec<_>>(),
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
    };
    let merge = git_ui_output(&cwd, &["rev-parse", "--verify", "MERGE_HEAD"])
        .is_ok_and(|o| o.status.success());
    let repo = match git_ui_repo(&cwd) {
        Ok(r) => r,
        Err(err) => {
            warnings.push(format!("repo resolve failed: {err}"));
            cwd.clone()
        }
    };
    let rebase_merge = git_ui_text(&cwd, &["rev-parse", "--git-path", "rebase-merge"])
        .ok()
        .is_some_and(|path| Path::new(&repo).join(path.trim()).exists());
    let rebase_apply = git_ui_text(&cwd, &["rev-parse", "--git-path", "rebase-apply"])
        .ok()
        .is_some_and(|path| Path::new(&repo).join(path.trim()).exists());
    Ok(Json(json!({ "files": files, "merge": merge, "rebase": rebase_merge || rebase_apply, "warnings": warnings }))
        .into_response())
}

pub(super) async fn git_ui_conflicts(
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
    match tokio::task::spawn_blocking(move || git_ui_conflicts_blocking(cwd)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_conflict_resolve_blocking(
    cwd: String,
    path: String,
    mode: String,
    content: Option<String>,
) -> Result<Response, (StatusCode, String)> {
    let result = match mode.as_str() {
        "ours" => git_ui_text(&cwd, &["checkout", "--ours", "--", &path])
            .and_then(|_| git_ui_text(&cwd, &["add", "--", &path])),
        "theirs" => git_ui_text(&cwd, &["checkout", "--theirs", "--", &path])
            .and_then(|_| git_ui_text(&cwd, &["add", "--", &path])),
        "mark" => git_ui_text(&cwd, &["add", "--", &path]),
        "manual" => {
            let repo = match git_ui_repo(&cwd) {
                Ok(repo) => repo,
                Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
            };
            let full = Path::new(&repo).join(&path);
            match fs::write(full, content.unwrap_or_default()) {
                Ok(_) => git_ui_text(&repo, &["add", "--", &path]),
                Err(err) => Err(err.to_string()),
            }
        }
        _ => Err("invalid conflict resolve mode".to_string()),
    };
    match result {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_conflict_resolve(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiConflictResolveRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let path = match safe_repo_path(&body.path) {
        Ok(path) => path.to_string(),
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let mode = body.mode;
    let content = body.content;
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || {
        git_ui_conflict_resolve_blocking(cwd, path, mode, content)
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_conflict_action_blocking(
    cwd: String,
    args: Vec<&'static str>,
) -> Result<Response, (StatusCode, String)> {
    match git_ui_text(&cwd, &args) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_conflict_action(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiConflictActionRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let args = match body.action.as_str() {
        "merge-abort" => vec!["merge", "--abort"],
        "rebase-continue" => vec!["rebase", "--continue"],
        "rebase-abort" => vec!["rebase", "--abort"],
        "cherry-pick-continue" => vec!["cherry-pick", "--continue"],
        "cherry-pick-abort" => vec!["cherry-pick", "--abort"],
        _ => return git_json_error(StatusCode::BAD_REQUEST, "invalid conflict action"),
    };
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_conflict_action_blocking(cwd, args)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}
