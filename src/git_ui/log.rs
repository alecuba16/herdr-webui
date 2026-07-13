use std::io::Write;
use std::net::SocketAddr;
use std::process::{Command, Stdio};

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::{git_json_error, git_ui_repo, git_ui_text, git_ui_text_strings, safe_git_token};
use crate::{git_failure, require_auth, WebState};

#[derive(Deserialize)]
pub(super) struct GitUiLogQuery {
    pub(super) cwd: Option<String>,
    pub(super) max: Option<usize>,
    pub(super) all: Option<bool>,
}

#[derive(Deserialize)]
pub(super) struct GitUiResetRequest {
    pub(super) cwd: String,
    pub(super) mode: String,
    pub(super) ref_name: String,
    pub(super) confirmation: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct GitUiRebaseRequest {
    cwd: String,
    upstream: String,
    onto: Option<String>,
    confirmation: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct GitUiCommitRequest {
    pub(super) cwd: String,
    pub(super) title: String,
    pub(super) body: Option<String>,
    pub(super) amend: Option<bool>,
}

#[derive(Deserialize)]
pub(super) struct GitUiTagRequest {
    pub(super) cwd: String,
    pub(super) tag_name: String,
    pub(super) ref_name: String,
}

#[derive(Deserialize)]
pub(super) struct GitUiPullPushRequest {
    pub(super) cwd: String,
    pub(super) mode: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) pull_first: Option<bool>,
    pub(super) push_tags: Option<bool>,
}

#[derive(Deserialize)]
pub(super) struct GitUiApplyPatchRequest {
    pub(super) cwd: String,
    pub(super) patch: String,
    pub(super) reverse: Option<bool>,
    pub(super) cached: Option<bool>,
}

/// Reconstruct a git log graph line so it no longer contains the null-byte
/// (`%x00`) separators emitted by `--format=%H%x00%an%x00%ar%x00%s`.
///
/// Commit lines become a human-readable `--oneline`-style string
/// (`<graph_prefix><short-hash> <message>`). Graph-only and empty lines are
/// passed through unchanged, since they never contain null bytes.
fn reconstruct_log_line(line: &str) -> String {
    let raw = line.trim();
    if raw.is_empty() {
        return line.to_owned();
    }
    let start = match raw.find(|c: char| c.is_ascii_hexdigit()) {
        Some(start) => start,
        None => return line.to_owned(),
    };
    let end = raw[start..]
        .find(|c: char| !c.is_ascii_hexdigit())
        .map(|e| start + e)
        .unwrap_or(raw.len());
    if end - start < 7 {
        return line.to_owned();
    }
    let hash = &raw[start..end];
    let parts: Vec<&str> = raw[end..].split('\0').collect();
    let message = parts.get(3).map(|s| s.trim()).unwrap_or("");
    let graph_prefix = &raw[..start];
    let short = &hash[..8.min(hash.len())];
    format!("{}{} {}", graph_prefix, short, message)
}

fn git_ui_log_blocking(
    cwd: String,
    max: String,
    all: bool,
) -> Result<Response, (StatusCode, String)> {
    let mut args = vec![
        "log",
        "--graph",
        "--decorate",
        "--date=relative",
        "--max-count",
        &max,
        "--format=%H%x00%an%x00%ar%x00%s",
    ];
    if all {
        args.push("--all");
    }
    match git_ui_text(&cwd, &args) {
        Ok(text) => {
            let lines = text.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
            let commits = lines
                .iter()
                .filter_map(|line| {
                    let raw = line.trim();
                    if raw.is_empty() {
                        return None;
                    }
                    let start = match raw.find(|c: char| c.is_ascii_hexdigit()) {
                        Some(start) => start,
                        None => return None,
                    };
                    let end = raw[start..]
                        .find(|c: char| !c.is_ascii_hexdigit())
                        .map(|e| start + e)
                        .unwrap_or(raw.len());
                    if end - start < 7 {
                        return None;
                    }
                    let hash = raw[start..end].to_string();
                    let parts: Vec<&str> = raw[end..].split('\0').collect();
                    let author = parts.get(1).map(|s| s.trim()).unwrap_or("").to_string();
                    let date = parts.get(2).map(|s| s.trim()).unwrap_or("").to_string();
                    let message = parts.get(3).map(|s| s.trim()).unwrap_or("").to_string();
                    Some(
                        json!({ "hash": hash, "author": author, "date": date, "message": message }),
                    )
                })
                .collect::<Vec<_>>();
            let display_lines = lines
                .iter()
                .map(|line| reconstruct_log_line(line))
                .collect::<Vec<_>>();
            Ok(Json(json!({ "commits": commits, "lines": display_lines })).into_response())
        }
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_log(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiLogQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let Some(cwd) = query.cwd.as_deref() else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    let max = query.max.unwrap_or(80).clamp(1, 300).to_string();
    let all = query.all.unwrap_or(false);
    let cwd = cwd.to_string();
    match tokio::task::spawn_blocking(move || git_ui_log_blocking(cwd, max, all)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_reset_blocking(
    cwd: String,
    mode: String,
    ref_name: String,
) -> Result<Response, (StatusCode, String)> {
    match git_ui_text(&cwd, &["reset", &mode, &ref_name]) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_reset(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiResetRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let mode = match body.mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        _ => return git_json_error(StatusCode::BAD_REQUEST, "invalid reset mode"),
    };
    if mode == "--hard" && body.confirmation.as_deref() != Some("reset hard") {
        return git_json_error(
            StatusCode::BAD_REQUEST,
            "hard reset requires typed confirmation",
        );
    }
    let ref_name = match safe_git_token(&body.ref_name, "ref") {
        Ok(v) => v.to_string(),
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let mode = mode.to_string();
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_reset_blocking(cwd, mode, ref_name)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_default_base_ref(cwd: &str) -> Result<String, String> {
    for candidate in ["main", "master"] {
        if git_ui_text(cwd, &["rev-parse", "--verify", candidate]).is_ok() {
            return Ok(candidate.to_string());
        }
    }
    Err("could not find main or master ref".to_string())
}

fn git_ui_rebase_blocking(
    cwd: String,
    upstream: String,
    onto: Option<String>,
) -> Result<Response, (StatusCode, String)> {
    let onto = match onto {
        Some(value) => value,
        None => match git_ui_default_base_ref(&cwd) {
            Ok(value) => value,
            Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
        },
    };
    match git_ui_text(&cwd, &["rebase", "--onto", &onto, &upstream]) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text, "onto": onto })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_rebase(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiRebaseRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    if body.confirmation.as_deref() != Some("rebase selected") {
        return git_json_error(
            StatusCode::BAD_REQUEST,
            "rebase requires typed confirmation",
        );
    }
    let upstream = match safe_git_token(&body.upstream, "upstream") {
        Ok(v) => v.to_string(),
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let onto = match body
        .onto
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(value) => match safe_git_token(value, "onto") {
            Ok(v) => Some(v.to_string()),
            Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
        },
        None => None,
    };
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_rebase_blocking(cwd, upstream, onto)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_commit_blocking(
    cwd: String,
    title: String,
    body: Option<String>,
    amend: bool,
) -> Result<Response, (StatusCode, String)> {
    let mut args = vec!["commit"];
    if amend {
        args.push("--amend");
    }
    args.push("-m");
    args.push(&title);
    if let Some(message) = body.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        args.push("-m");
        args.push(message);
    }
    match git_ui_text(&cwd, &args) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_commit(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiCommitRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return git_json_error(StatusCode::BAD_REQUEST, "commit title is required");
    }
    let commit_body = body.body;
    let amend = body.amend.unwrap_or(false);
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || {
        git_ui_commit_blocking(cwd, title, commit_body, amend)
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn safe_tag_name(value: &str) -> Result<&str, String> {
    let tag = safe_git_token(value, "tag")?;
    if tag.chars().any(char::is_whitespace) {
        return Err("invalid tag".to_string());
    }
    Ok(tag)
}

fn git_ui_tag_blocking(
    cwd: String,
    tag_name: String,
    ref_name: String,
) -> Result<Response, (StatusCode, String)> {
    match git_ui_text(&cwd, &["tag", &tag_name, &ref_name]) {
        Ok(text) => {
            Ok(Json(json!({ "ok": true, "message": text, "tag": tag_name })).into_response())
        }
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_tag(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiTagRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let tag_name = match safe_tag_name(&body.tag_name) {
        Ok(v) => v.to_string(),
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let ref_name = match safe_git_token(&body.ref_name, "ref") {
        Ok(v) => v.to_string(),
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_tag_blocking(cwd, tag_name, ref_name)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_pull_blocking(
    cwd: String,
    mode: String,
    branch: Option<String>,
) -> Result<Response, (StatusCode, String)> {
    let mut args = vec!["pull".to_string()];
    match mode.as_str() {
        "regular" => {}
        "rebase" => args.push("--rebase".to_string()),
        "ff-only" => args.push("--ff-only".to_string()),
        "no-ff" => args.push("--no-ff".to_string()),
        "force" => args.push("--force".to_string()),
        _ => return Err((StatusCode::BAD_REQUEST, "invalid pull mode".to_string())),
    }
    if let Some(branch) = branch.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        args.push("origin".to_string());
        args.push(branch.to_string());
    }
    match git_ui_text_strings(&cwd, &args) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_pull(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiPullPushRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let mode = body.mode.unwrap_or_else(|| "regular".to_string());
    let branch = match body
        .branch
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(value) => match safe_git_token(value, "branch") {
            Ok(v) => Some(v.to_string()),
            Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
        },
        None => None,
    };
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_pull_blocking(cwd, mode, branch)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_push_blocking(
    cwd: String,
    mode: String,
    branch: Option<String>,
    pull_first: bool,
    push_tags: bool,
) -> Result<Response, (StatusCode, String)> {
    if pull_first {
        git_ui_text(&cwd, &["pull", "--ff-only"]).map_err(|err| (StatusCode::BAD_GATEWAY, err))?;
    }
    let mut args = vec!["push".to_string()];
    if push_tags {
        args.push("--tags".to_string());
    }
    match mode.as_str() {
        "regular" => {}
        "force" => args.push("--force".to_string()),
        "force-with-lease" => args.push("--force-with-lease".to_string()),
        _ => return Err((StatusCode::BAD_REQUEST, "invalid push mode".to_string())),
    }
    if let Some(branch) = branch.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        args.push("origin".to_string());
        args.push(branch.to_string());
    }
    match git_ui_text_strings(&cwd, &args) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_push(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiPullPushRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let mode = body.mode.unwrap_or_else(|| "regular".to_string());
    let branch = match body
        .branch
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(value) => match safe_git_token(value, "branch") {
            Ok(v) => Some(v.to_string()),
            Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
        },
        None => None,
    };
    let cwd = body.cwd;
    let pull_first = body.pull_first.unwrap_or(false);
    let push_tags = body.push_tags.unwrap_or(false);
    match tokio::task::spawn_blocking(move || {
        git_ui_push_blocking(cwd, mode, branch, pull_first, push_tags)
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_apply_patch_blocking(
    cwd: String,
    patch: String,
    reverse: bool,
    cached: bool,
) -> Result<Response, (StatusCode, String)> {
    let repo = match git_ui_repo(&cwd) {
        Ok(repo) => repo,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let mut command = Command::new("git");
    command.arg("-C").arg(&repo).arg("apply");
    if reverse {
        command.arg("-R");
    }
    if cached {
        command.arg("--cached");
    }
    command.arg("--whitespace=nowarn").stdin(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err.to_string())),
    };
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(err) = stdin.write_all(patch.as_bytes()) {
            return Err((StatusCode::BAD_GATEWAY, err.to_string()));
        }
    }
    match child.wait_with_output() {
        Ok(output) if output.status.success() => Ok(Json(json!({ "ok": true })).into_response()),
        Ok(output) => Err((StatusCode::BAD_GATEWAY, git_failure(output, "git apply"))),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err.to_string())),
    }
}

pub(super) async fn git_ui_apply_patch(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiApplyPatchRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    if body.patch.trim().is_empty() {
        return git_json_error(StatusCode::BAD_REQUEST, "patch is required");
    }
    let cwd = body.cwd;
    let patch = body.patch;
    let reverse = body.reverse.unwrap_or(false);
    let cached = body.cached.unwrap_or(false);
    match tokio::task::spawn_blocking(move || {
        git_ui_apply_patch_blocking(cwd, patch, reverse, cached)
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}
