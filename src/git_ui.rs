use std::fs;
use std::io::Write;
use std::net::SocketAddr;
use std::path::Path;
use std::process::{Command, Stdio};

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{expand_user_path_string, git_failure, require_auth, WebState};

pub(crate) fn routes() -> Router<WebState> {
    Router::new()
        .route("/api/git-ui/status", get(git_ui_status))
        .route("/api/git-ui/diff", get(git_ui_diff))
        .route("/api/git-ui/compare", get(git_ui_compare))
        .route("/api/git-ui/branches", get(git_ui_branches))
        .route("/api/git-ui/log", get(git_ui_log))
        .route("/api/git-ui/blame", get(git_ui_blame))
        .route("/api/git-ui/file", get(git_ui_file).post(git_ui_write_file))
        .route("/api/git-ui/file-history", get(git_ui_file_history))
        .route("/api/git-ui/stashes", get(git_ui_stashes))
        .route("/api/git-ui/conflicts", get(git_ui_conflicts))
        .route("/api/git-ui/stage", post(git_ui_stage))
        .route("/api/git-ui/unstage", post(git_ui_unstage))
        .route("/api/git-ui/discard", post(git_ui_discard))
        .route("/api/git-ui/stash", post(git_ui_stash))
        .route("/api/git-ui/stash-apply", post(git_ui_stash_apply))
        .route("/api/git-ui/stash-drop", post(git_ui_stash_drop))
        .route("/api/git-ui/switch", post(git_ui_switch))
        .route("/api/git-ui/reset", post(git_ui_reset))
        .route("/api/git-ui/rebase", post(git_ui_rebase))
        .route("/api/git-ui/commit", post(git_ui_commit))
        .route("/api/git-ui/apply-patch", post(git_ui_apply_patch))
        .route(
            "/api/git-ui/conflict-resolve",
            post(git_ui_conflict_resolve),
        )
        .route("/api/git-ui/conflict-action", post(git_ui_conflict_action))
}

#[derive(Deserialize)]
struct GitUiQuery {
    cwd: Option<String>,
    scope: Option<String>,
    file: Option<String>,
    base: Option<String>,
    target: Option<String>,
    merge_base: Option<bool>,
    max: Option<usize>,
    ref_name: Option<String>,
    all: Option<bool>,
    context: Option<usize>,
}

#[derive(Deserialize)]
struct GitUiPathsRequest {
    cwd: String,
    paths: Vec<String>,
    confirmed: Option<bool>,
}

#[derive(Deserialize)]
struct GitUiStashRequest {
    cwd: String,
    message: Option<String>,
    paths: Option<Vec<String>>,
    stash: Option<String>,
    pop: Option<bool>,
    confirmed: Option<bool>,
}

#[derive(Deserialize)]
struct GitUiSwitchRequest {
    cwd: String,
    branch: String,
    create: Option<bool>,
    base: Option<String>,
}

#[derive(Deserialize)]
struct GitUiResetRequest {
    cwd: String,
    mode: String,
    ref_name: String,
    confirmation: Option<String>,
}

#[derive(Deserialize)]
struct GitUiRebaseRequest {
    cwd: String,
    upstream: String,
    onto: Option<String>,
    confirmation: Option<String>,
}

#[derive(Deserialize)]
struct GitUiCommitRequest {
    cwd: String,
    title: String,
    body: Option<String>,
    amend: Option<bool>,
}

#[derive(Deserialize)]
struct GitUiApplyPatchRequest {
    cwd: String,
    patch: String,
    reverse: Option<bool>,
    cached: Option<bool>,
}

#[derive(Deserialize)]
struct GitUiWriteFileRequest {
    cwd: String,
    path: String,
    content: String,
    expected_hash: Option<String>,
}

#[derive(Deserialize)]
struct GitUiConflictResolveRequest {
    cwd: String,
    path: String,
    mode: String,
    content: Option<String>,
}

#[derive(Deserialize)]
struct GitUiConflictActionRequest {
    cwd: String,
    action: String,
}

#[derive(Serialize)]
struct GitDiffLine {
    line_type: String,
    content: String,
    old_line_number: Option<usize>,
    new_line_number: Option<usize>,
}

#[derive(Serialize)]
struct GitDiffChunk {
    header: String,
    old_start: usize,
    old_lines: usize,
    new_start: usize,
    new_lines: usize,
    lines: Vec<GitDiffLine>,
}

#[derive(Serialize)]
struct GitDiffFile {
    path: String,
    old_path: Option<String>,
    status: String,
    additions: usize,
    deletions: usize,
    chunks: Vec<GitDiffChunk>,
}

fn git_json_error(status: StatusCode, error: impl Into<String>) -> Response {
    (status, Json(json!({ "error": error.into() }))).into_response()
}

fn git_ui_repo(cwd: &str) -> Result<String, String> {
    let expanded = expand_user_path_string(cwd);
    let output = Command::new("git")
        .arg("-C")
        .arg(&expanded)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(git_failure(output, "git rev-parse"));
    }
    Ok(expanded)
}

fn git_ui_output(cwd: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let repo = git_ui_repo(cwd)?;
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|err| err.to_string())
}

fn git_ui_text(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = git_ui_output(cwd, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(git_failure(output, args.first().copied().unwrap_or("git")))
    }
}

fn git_ui_text_strings(cwd: &str, args: &[String]) -> Result<String, String> {
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    git_ui_text(cwd, &refs)
}

fn safe_repo_path(path: &str) -> Result<&str, String> {
    let trimmed = path.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.split('/').any(|part| part == "..")
        || trimmed.contains('\0')
    {
        return Err("invalid repository path".to_string());
    }
    Ok(trimmed)
}

fn safe_git_token<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.contains('\0') {
        return Err(format!("invalid {label}"));
    }
    Ok(trimmed)
}

fn git_ui_auth(state: &WebState, headers: &HeaderMap, remote: SocketAddr) -> Result<(), Response> {
    require_auth(state, headers, remote)
}

fn parse_diff_path(raw: &str) -> Option<String> {
    let mut path = raw.trim();
    if path == "/dev/null" {
        return None;
    }
    if path.starts_with('"') && path.ends_with('"') && path.len() >= 2 {
        path = &path[1..path.len() - 1];
    }
    for prefix in ["a/", "b/"] {
        if let Some(rest) = path.strip_prefix(prefix) {
            path = rest;
            break;
        }
    }
    Some(path.replace("\\t", "\t").replace("\\\"", "\""))
}

fn parse_unified_diff(text: &str) -> Vec<GitDiffFile> {
    let mut files = Vec::new();
    for block in text.split("\ndiff --git ") {
        let block = if block.starts_with("diff --git ") {
            block.to_string()
        } else if files.is_empty() && !block.starts_with("diff --git ") {
            continue;
        } else {
            format!("diff --git {block}")
        };
        let lines: Vec<&str> = block.lines().collect();
        if lines.is_empty() {
            continue;
        }
        let minus = lines.iter().find(|line| line.starts_with("--- ")).copied();
        let plus = lines.iter().find(|line| line.starts_with("+++ ")).copied();
        let rename_from = lines
            .iter()
            .find_map(|line| line.strip_prefix("rename from "));
        let rename_to = lines
            .iter()
            .find_map(|line| line.strip_prefix("rename to "));
        let old_path = rename_from
            .map(ToOwned::to_owned)
            .or_else(|| minus.and_then(|line| parse_diff_path(&line[4..])));
        let new_path = rename_to
            .map(ToOwned::to_owned)
            .or_else(|| plus.and_then(|line| parse_diff_path(&line[4..])));
        let Some(path) = new_path.clone().or_else(|| old_path.clone()) else {
            continue;
        };
        let status = if lines.iter().any(|line| line.starts_with("new file mode"))
            || minus.is_some_and(|line| line.contains("/dev/null"))
        {
            "added"
        } else if lines
            .iter()
            .any(|line| line.starts_with("deleted file mode"))
            || plus.is_some_and(|line| line.contains("/dev/null"))
        {
            "deleted"
        } else if old_path.as_deref() != Some(path.as_str()) {
            "renamed"
        } else {
            "modified"
        };
        let mut chunks = Vec::new();
        let mut current: Option<GitDiffChunk> = None;
        let mut old_line = 0usize;
        let mut new_line = 0usize;
        for line in lines {
            if line.starts_with("@@") {
                if let Some(chunk) = current.take() {
                    chunks.push(chunk);
                }
                let mut old_start = 0;
                let mut old_lines = 1;
                let mut new_start = 0;
                let mut new_lines = 1;
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 3 {
                    let old = parts[1].trim_start_matches('-');
                    let new = parts[2].trim_start_matches('+');
                    let old_parts: Vec<&str> = old.split(',').collect();
                    let new_parts: Vec<&str> = new.split(',').collect();
                    old_start = old_parts.first().and_then(|v| v.parse().ok()).unwrap_or(0);
                    old_lines = old_parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(1);
                    new_start = new_parts.first().and_then(|v| v.parse().ok()).unwrap_or(0);
                    new_lines = new_parts.get(1).and_then(|v| v.parse().ok()).unwrap_or(1);
                }
                old_line = old_start;
                new_line = new_start;
                current = Some(GitDiffChunk {
                    header: line.to_string(),
                    old_start,
                    old_lines,
                    new_start,
                    new_lines,
                    lines: Vec::new(),
                });
            } else if let Some(chunk) = current.as_mut() {
                let Some(prefix) = line.chars().next() else {
                    continue;
                };
                if !matches!(prefix, '+' | '-' | ' ') {
                    continue;
                }
                let line_type = match prefix {
                    '+' => "add",
                    '-' => "delete",
                    _ => "normal",
                };
                chunk.lines.push(GitDiffLine {
                    line_type: line_type.to_string(),
                    content: line[1..].to_string(),
                    old_line_number: (line_type != "add").then_some(old_line),
                    new_line_number: (line_type != "delete").then_some(new_line),
                });
                if line_type != "add" {
                    old_line += 1;
                }
                if line_type != "delete" {
                    new_line += 1;
                }
            }
        }
        if let Some(chunk) = current.take() {
            chunks.push(chunk);
        }
        let additions = chunks
            .iter()
            .flat_map(|chunk| &chunk.lines)
            .filter(|line| line.line_type == "add")
            .count();
        let deletions = chunks
            .iter()
            .flat_map(|chunk| &chunk.lines)
            .filter(|line| line.line_type == "delete")
            .count();
        files.push(GitDiffFile {
            path,
            old_path: (status == "renamed").then_some(old_path.unwrap_or_default()),
            status: status.to_string(),
            additions,
            deletions,
            chunks,
        });
    }
    files
}

fn git_ui_diff_args(query: &GitUiQuery, compare: bool) -> Result<Vec<String>, String> {
    let mut args = vec![
        "diff".to_string(),
        "--no-ext-diff".to_string(),
        "--color=never".to_string(),
    ];
    let context = query.context.unwrap_or(3).clamp(0, 200).to_string();
    args.push(format!("-U{context}"));
    if compare {
        let base = safe_git_token(query.base.as_deref().unwrap_or("HEAD"), "base ref")?;
        let target = safe_git_token(query.target.as_deref().unwrap_or("."), "target ref")?;
        if query.merge_base.unwrap_or(false) {
            args.push("--merge-base".to_string());
        }
        args.push(base.to_string());
        args.push(target.to_string());
    } else {
        match query.scope.as_deref().unwrap_or("all") {
            "staged" => args.push("--cached".to_string()),
            "working" => {}
            _ => args.push("HEAD".to_string()),
        }
    }
    if let Some(file) = query.file.as_deref() {
        args.push("--".to_string());
        args.push(safe_repo_path(file)?.to_string());
    }
    Ok(args)
}

async fn git_ui_status(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiQuery>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let Some(cwd) = query.cwd.as_deref() else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    let repo = match git_ui_repo(cwd) {
        Ok(repo) => repo,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let status = match git_ui_text(&repo, &["status", "--porcelain=v1", "--branch"]) {
        Ok(text) => text,
        Err(err) => return git_json_error(StatusCode::BAD_GATEWAY, err),
    };
    let mut branch = String::new();
    let mut upstream = String::new();
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    let mut conflicted = Vec::new();
    for line in status.lines() {
        if let Some(head) = line.strip_prefix("## ") {
            let parts: Vec<&str> = head.split("...").collect();
            branch = parts.first().copied().unwrap_or(head).to_string();
            upstream = parts
                .get(1)
                .map(|v| v.split_whitespace().next().unwrap_or(""))
                .unwrap_or("")
                .to_string();
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let x = line.as_bytes()[0] as char;
        let y = line.as_bytes()[1] as char;
        let path = line[3..].to_string();
        if x == '?' && y == '?' {
            untracked.push(path);
        } else if matches!((x, y), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D')) {
            conflicted.push(path);
        } else {
            if x != ' ' {
                staged.push(path.clone());
            }
            if y != ' ' {
                unstaged.push(path);
            }
        }
    }
    let stashes = git_ui_text(&repo, &["stash", "list", "--format=%gd"])
        .map(|text| text.lines().count())
        .unwrap_or(0);
    let state_name = if !conflicted.is_empty() {
        "conflicts"
    } else if staged.is_empty() && unstaged.is_empty() && untracked.is_empty() {
        "clean"
    } else {
        "dirty"
    };
    Json(json!({
        "repo_path": repo,
        "branch": branch,
        "upstream": upstream,
        "state": state_name,
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
        "conflicted": conflicted,
        "stashes": stashes,
    }))
    .into_response()
}

async fn git_ui_diff_common(query: GitUiQuery, compare: bool) -> Response {
    let Some(cwd) = query.cwd.as_deref() else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    let args = match git_ui_diff_args(&query, compare) {
        Ok(args) => args,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    match git_ui_text_strings(cwd, &args) {
        Ok(text) => Json(json!({ "files": parse_unified_diff(&text) })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_diff(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiQuery>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    git_ui_diff_common(query, false).await
}

async fn git_ui_compare(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiQuery>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    git_ui_diff_common(query, true).await
}

async fn git_ui_branches(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiQuery>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let Some(cwd) = query.cwd.as_deref() else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    let text = match git_ui_text(cwd, &["branch", "--format=%(refname:short)%00%(HEAD)"]) {
        Ok(text) => text,
        Err(err) => return git_json_error(StatusCode::BAD_GATEWAY, err),
    };
    let local = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            Some(json!({ "name": name, "current": parts.next() == Some("*"), "remote": false }))
        })
        .collect::<Vec<_>>();
    let remote_text = match git_ui_text(cwd, &["branch", "-r", "--format=%(refname:short)"]) {
        Ok(text) => text,
        Err(err) => return git_json_error(StatusCode::BAD_GATEWAY, err),
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
    let mut branches = local.clone();
    branches.extend(remote.clone());
    Json(json!({ "branches": branches, "local": local, "remote": remote })).into_response()
}

async fn git_ui_log(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiQuery>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let Some(cwd) = query.cwd.as_deref() else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    let max = query.max.unwrap_or(80).clamp(1, 300).to_string();
    let mut args = vec![
        "log",
        "--graph",
        "--decorate",
        "--oneline",
        "--date=relative",
        "--max-count",
        &max,
    ];
    if query.all.unwrap_or(false) {
        args.push("--all");
    }
    match git_ui_text(cwd, &args) {
        Ok(text) => {
            Json(json!({ "lines": text.lines().map(ToOwned::to_owned).collect::<Vec<_>>() }))
                .into_response()
        }
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_blame(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiQuery>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
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
        Ok(value) => value,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    match git_ui_text(cwd, &["blame", "--line-porcelain", ref_name, "--", file]) {
        Ok(text) => Json(json!({ "text": text })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
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

async fn git_ui_file(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiQuery>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let (Some(cwd), Some(file)) = (query.cwd.as_deref(), query.file.as_deref()) else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd and file are required");
    };
    let file = match safe_repo_path(file) {
        Ok(file) => file,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let repo = match git_ui_repo(cwd) {
        Ok(repo) => repo,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let ref_name = query.ref_name.as_deref().unwrap_or("working");
    if ref_name == "working" {
        let full = Path::new(&repo).join(file);
        let content = if full.exists() {
            match fs::read_to_string(&full) {
                Ok(content) => content,
                Err(err) => return git_json_error(StatusCode::BAD_GATEWAY, err.to_string()),
            }
        } else {
            String::new()
        };
        let hash = match git_ui_working_file_hash(&repo, file) {
            Ok(hash) => hash,
            Err(err) => return git_json_error(StatusCode::BAD_GATEWAY, err),
        };
        return Json(json!({ "path": file, "content": content, "hash": hash })).into_response();
    }
    let ref_name = match safe_git_token(ref_name, "ref") {
        Ok(ref_name) => ref_name,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let spec = format!("{ref_name}:{file}");
    match git_ui_text(&repo, &["show", &spec]) {
        Ok(content) => {
            Json(json!({ "path": file, "content": content, "hash": "" })).into_response()
        }
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_write_file(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiWriteFileRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let path = match safe_repo_path(&body.path) {
        Ok(path) => path,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let repo = match git_ui_repo(&body.cwd) {
        Ok(repo) => repo,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let current_hash = match git_ui_working_file_hash(&repo, path) {
        Ok(hash) => hash,
        Err(err) => return git_json_error(StatusCode::BAD_GATEWAY, err),
    };
    if let Some(expected_hash) = body.expected_hash.as_deref() {
        if expected_hash != current_hash {
            return git_json_error(
                StatusCode::CONFLICT,
                "file changed on disk; reload before saving",
            );
        }
    }
    let full = Path::new(&repo).join(path);
    if full.is_dir() {
        return git_json_error(StatusCode::BAD_REQUEST, "path is a directory");
    }
    if let Some(parent) = full.parent() {
        if let Err(err) = fs::create_dir_all(parent) {
            return git_json_error(StatusCode::BAD_GATEWAY, err.to_string());
        }
    }
    if let Err(err) = fs::write(&full, body.content) {
        return git_json_error(StatusCode::BAD_GATEWAY, err.to_string());
    }
    let hash = match git_ui_working_file_hash(&repo, path) {
        Ok(hash) => hash,
        Err(err) => return git_json_error(StatusCode::BAD_GATEWAY, err),
    };
    Json(json!({ "ok": true, "path": path, "hash": hash })).into_response()
}

async fn git_ui_file_history(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiQuery>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let (Some(cwd), Some(file)) = (query.cwd.as_deref(), query.file.as_deref()) else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd and file are required");
    };
    let file = match safe_repo_path(file) {
        Ok(file) => file,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    match git_ui_text(
        cwd,
        &[
            "log",
            "--follow",
            "--date=relative",
            "--format=%h%x00%an%x00%ar%x00%s",
            "--",
            file,
        ],
    ) {
        Ok(text) => {
            let commits = text.lines().filter_map(|line| {
                let parts: Vec<&str> = line.split('\0').collect();
                (parts.len() >= 4).then(|| json!({ "hash": parts[0], "author": parts[1], "date": parts[2], "message": parts[3] }))
            }).collect::<Vec<_>>();
            Json(json!({ "commits": commits })).into_response()
        }
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_stashes(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiQuery>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let Some(cwd) = query.cwd.as_deref() else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    match git_ui_text(cwd, &["stash", "list", "--format=%gd%x00%h%x00%cr%x00%gs"]) {
        Ok(text) => {
            let stashes = text.lines().filter_map(|line| {
                let parts: Vec<&str> = line.split('\0').collect();
                (parts.len() >= 4).then(|| json!({ "name": parts[0], "hash": parts[1], "date": parts[2], "message": parts[3] }))
            }).collect::<Vec<_>>();
            Json(json!({ "stashes": stashes })).into_response()
        }
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_conflicts(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiQuery>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let Some(cwd) = query.cwd.as_deref() else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    let files = git_ui_text(cwd, &["diff", "--name-only", "--diff-filter=U"])
        .unwrap_or_default()
        .lines()
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    let merge = git_ui_output(cwd, &["rev-parse", "--verify", "MERGE_HEAD"])
        .is_ok_and(|o| o.status.success());
    let repo = git_ui_repo(cwd).unwrap_or_else(|_| cwd.to_string());
    let rebase_merge = git_ui_text(cwd, &["rev-parse", "--git-path", "rebase-merge"])
        .ok()
        .is_some_and(|path| Path::new(&repo).join(path.trim()).exists());
    let rebase_apply = git_ui_text(cwd, &["rev-parse", "--git-path", "rebase-apply"])
        .ok()
        .is_some_and(|path| Path::new(&repo).join(path.trim()).exists());
    Json(json!({ "files": files, "merge": merge, "rebase": rebase_merge || rebase_apply }))
        .into_response()
}

fn git_ui_paths(body: &GitUiPathsRequest) -> Result<Vec<&str>, String> {
    if body.paths.is_empty() {
        return Err("paths are required".to_string());
    }
    body.paths.iter().map(|path| safe_repo_path(path)).collect()
}

async fn git_ui_stage(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiPathsRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let paths = match git_ui_paths(&body) {
        Ok(paths) => paths,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let mut args = vec!["add", "--"];
    args.extend(paths);
    match git_ui_text(&body.cwd, &args) {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_unstage(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiPathsRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let paths = match git_ui_paths(&body) {
        Ok(paths) => paths,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let mut args = vec!["restore", "--staged", "--"];
    args.extend(paths);
    match git_ui_text(&body.cwd, &args) {
        Ok(_) => Json(json!({ "ok": true })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_discard(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiPathsRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    if !body.confirmed.unwrap_or(false) {
        return git_json_error(StatusCode::BAD_REQUEST, "discard requires confirmation");
    }
    let paths = match git_ui_paths(&body) {
        Ok(paths) => paths,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let repo = match git_ui_repo(&body.cwd) {
        Ok(repo) => repo,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    for path in paths {
        let tracked = git_ui_output(&repo, &["ls-files", "--error-unmatch", "--", path])
            .is_ok_and(|output| output.status.success());
        if tracked {
            if let Err(err) = git_ui_text(&repo, &["restore", "--staged", "--worktree", "--", path]) {
                return git_json_error(StatusCode::BAD_GATEWAY, err);
            }
        } else {
            let full = Path::new(&repo).join(path);
            if full.is_dir() {
                if let Err(err) = fs::remove_dir_all(&full) {
                    return git_json_error(StatusCode::BAD_GATEWAY, err.to_string());
                }
            } else if full.exists() && fs::remove_file(&full).is_err() {
                return git_json_error(StatusCode::BAD_GATEWAY, "failed to remove untracked file");
            }
        }
    }
    Json(json!({ "ok": true })).into_response()
}

async fn git_ui_stash(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiStashRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let msg = body.message.as_deref().unwrap_or("herdr-webui stash");
    let mut args = vec!["stash", "push", "-u", "-m", msg];
    let safe_paths = match body.paths.as_ref() {
        Some(paths) if !paths.is_empty() => {
            let safe = paths
                .iter()
                .map(|path| safe_repo_path(path))
                .collect::<Result<Vec<_>, _>>();
            match safe {
                Ok(paths) => Some(paths),
                Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
            }
        }
        _ => None,
    };
    if let Some(paths) = safe_paths.as_ref() {
        args.push("--");
        args.extend(paths.iter().copied());
    }
    match git_ui_text(&body.cwd, &args) {
        Ok(text) => Json(json!({ "ok": true, "message": text })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_stash_apply(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiStashRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let stash = match safe_git_token(body.stash.as_deref().unwrap_or("stash@{0}"), "stash") {
        Ok(value) => value,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let op = if body.pop.unwrap_or(false) {
        "pop"
    } else {
        "apply"
    };
    match git_ui_text(&body.cwd, &["stash", op, stash]) {
        Ok(text) => Json(json!({ "ok": true, "message": text })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_stash_drop(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiStashRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    if !body.confirmed.unwrap_or(false) {
        return git_json_error(StatusCode::BAD_REQUEST, "stash drop requires confirmation");
    }
    let stash = match safe_git_token(body.stash.as_deref().unwrap_or("stash@{0}"), "stash") {
        Ok(value) => value,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    match git_ui_text(&body.cwd, &["stash", "drop", stash]) {
        Ok(text) => Json(json!({ "ok": true, "message": text })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_switch(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiSwitchRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let branch = match safe_git_token(&body.branch, "branch") {
        Ok(value) => value,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    if branch.is_empty() {
        return git_json_error(StatusCode::BAD_REQUEST, "branch is required");
    }
    let args = if body.create.unwrap_or(false) {
        vec![
            "switch",
            "-c",
            branch,
            match safe_git_token(body.base.as_deref().unwrap_or("HEAD"), "base") {
                Ok(value) => value,
                Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
            },
        ]
    } else {
        vec!["switch", branch]
    };
    match git_ui_text(&body.cwd, &args) {
        Ok(text) => Json(json!({ "ok": true, "message": text })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_reset(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiResetRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
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
        Ok(value) => value,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    match git_ui_text(&body.cwd, &["reset", mode, ref_name]) {
        Ok(text) => Json(json!({ "ok": true, "message": text })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
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

async fn git_ui_rebase(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiRebaseRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    if body.confirmation.as_deref() != Some("rebase selected") {
        return git_json_error(
            StatusCode::BAD_REQUEST,
            "rebase requires typed confirmation",
        );
    }
    let upstream = match safe_git_token(&body.upstream, "upstream") {
        Ok(value) => value,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let onto = match body
        .onto
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(value) => match safe_git_token(value, "onto") {
            Ok(value) => value.to_string(),
            Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
        },
        None => match git_ui_default_base_ref(&body.cwd) {
            Ok(value) => value,
            Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
        },
    };
    match git_ui_text(&body.cwd, &["rebase", "--onto", onto.as_str(), upstream]) {
        Ok(text) => Json(json!({ "ok": true, "message": text, "onto": onto })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_commit(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiCommitRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let title = body.title.trim();
    if title.is_empty() {
        return git_json_error(StatusCode::BAD_REQUEST, "commit title is required");
    }
    let mut args = vec!["commit"];
    if body.amend.unwrap_or(false) {
        args.push("--amend");
    }
    args.extend(["-m", title]);
    if let Some(message) = body
        .body
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        args.extend(["-m", message]);
    }
    match git_ui_text(&body.cwd, &args) {
        Ok(text) => Json(json!({ "ok": true, "message": text })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_apply_patch(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiApplyPatchRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    if body.patch.trim().is_empty() {
        return git_json_error(StatusCode::BAD_REQUEST, "patch is required");
    }
    let repo = match git_ui_repo(&body.cwd) {
        Ok(repo) => repo,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let mut command = Command::new("git");
    command.arg("-C").arg(repo).arg("apply");
    if body.reverse.unwrap_or(false) {
        command.arg("-R");
    }
    if body.cached.unwrap_or(false) {
        command.arg("--cached");
    }
    command.arg("--whitespace=nowarn").stdin(Stdio::piped());
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(err) => return git_json_error(StatusCode::BAD_GATEWAY, err.to_string()),
    };
    if let Some(mut stdin) = child.stdin.take() {
        if let Err(err) = stdin.write_all(body.patch.as_bytes()) {
            return git_json_error(StatusCode::BAD_GATEWAY, err.to_string());
        }
    }
    match child.wait_with_output() {
        Ok(output) if output.status.success() => Json(json!({ "ok": true })).into_response(),
        Ok(output) => git_json_error(StatusCode::BAD_GATEWAY, git_failure(output, "git apply")),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err.to_string()),
    }
}

async fn git_ui_conflict_resolve(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiConflictResolveRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
        return response;
    }
    let path = match safe_repo_path(&body.path) {
        Ok(path) => path,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let result = match body.mode.as_str() {
        "ours" => git_ui_text(&body.cwd, &["checkout", "--ours", "--", path])
            .and_then(|_| git_ui_text(&body.cwd, &["add", "--", path])),
        "theirs" => git_ui_text(&body.cwd, &["checkout", "--theirs", "--", path])
            .and_then(|_| git_ui_text(&body.cwd, &["add", "--", path])),
        "mark" => git_ui_text(&body.cwd, &["add", "--", path]),
        "manual" => {
            let repo = match git_ui_repo(&body.cwd) {
                Ok(repo) => repo,
                Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
            };
            let full = Path::new(&repo).join(path);
            match fs::write(full, body.content.unwrap_or_default()) {
                Ok(_) => git_ui_text(&repo, &["add", "--", path]),
                Err(err) => Err(err.to_string()),
            }
        }
        _ => Err("invalid conflict resolve mode".to_string()),
    };
    match result {
        Ok(text) => Json(json!({ "ok": true, "message": text })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn git_ui_conflict_action(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiConflictActionRequest>,
) -> Response {
    if let Err(response) = git_ui_auth(&state, &headers, remote) {
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
    match git_ui_text(&body.cwd, &args) {
        Ok(text) => Json(json!({ "ok": true, "message": text })).into_response(),
        Err(err) => git_json_error(StatusCode::BAD_GATEWAY, err),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AuthConfig, NoSleepState, RuntimeServerSettings};
    use axum::body::to_bytes;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn query() -> GitUiQuery {
        GitUiQuery {
            cwd: None,
            scope: None,
            file: None,
            base: None,
            target: None,
            merge_base: None,
            max: None,
            ref_name: None,
            all: None,
            context: None,
        }
    }

    fn test_state() -> WebState {
        let bind = "127.0.0.1:8787".parse::<SocketAddr>().unwrap();
        let (rebind_tx, _) = tokio::sync::watch::channel(bind);
        WebState {
            api_socket: None,
            client_socket: None,
            session_name: None,
            herdr_bin: "herdr".to_string(),
            auth: Arc::new(Mutex::new(AuthConfig {
                user: None,
                password: None,
                localhost_no_auth: true,
                token: "token".to_string(),
            })),
            server_settings: Arc::new(Mutex::new(RuntimeServerSettings {
                bind,
                user: None,
                password: None,
                localhost_no_auth: true,
                no_sleep_auto_cooldown_seconds: 60,
            })),
            no_sleep: Arc::new(Mutex::new(NoSleepState::default())),
            rebind_tx,
            workspace_orders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    async fn response_json(response: Response) -> Value {
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    fn remote() -> SocketAddr {
        "127.0.0.1:1234".parse().unwrap()
    }

    struct TempRepo {
        path: PathBuf,
    }

    impl TempRepo {
        fn new() -> Self {
            static NEXT_REPO_ID: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "herdr-webui-git-ui-test-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
                NEXT_REPO_ID.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&path).unwrap();
            let repo = Self { path };
            repo.git(&["init"]);
            repo.git(&["checkout", "-b", "main"]);
            repo.git(&["config", "user.email", "test@example.com"]);
            repo.git(&["config", "user.name", "Test User"]);
            repo
        }

        fn write(&self, path: &str, content: &str) {
            let full = self.path.join(path);
            if let Some(parent) = full.parent() {
                fs::create_dir_all(parent).unwrap();
            }
            fs::write(full, content).unwrap();
        }

        fn git(&self, args: &[&str]) -> String {
            let output = Command::new("git")
                .current_dir(&self.path)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).to_string()
        }

        fn commit_initial(&self) {
            self.write("tracked.txt", "one\n");
            self.git(&["add", "."]);
            self.git(&["commit", "-m", "initial"]);
        }
    }

    impl Drop for TempRepo {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn rejects_unsafe_repo_paths() {
        assert!(safe_repo_path("src/main.rs").is_ok());
        assert_eq!(safe_repo_path(" src/main.rs ").unwrap(), "src/main.rs");
        assert!(safe_repo_path("../secret").is_err());
        assert!(safe_repo_path("src/../secret").is_err());
        assert!(safe_repo_path("/tmp/secret").is_err());
        assert!(safe_repo_path("").is_err());
        assert!(safe_repo_path("src\0secret").is_err());
    }

    #[test]
    fn rejects_unsafe_git_tokens() {
        assert_eq!(safe_git_token(" main ", "branch").unwrap(), "main");
        assert!(safe_git_token("", "branch").is_err());
        assert!(safe_git_token("--upload-pack=/tmp/x", "branch").is_err());
        assert!(safe_git_token("main\0next", "branch").is_err());
    }

    #[test]
    fn parses_diff_paths() {
        assert_eq!(
            parse_diff_path("a/src/main.rs").as_deref(),
            Some("src/main.rs")
        );
        assert_eq!(
            parse_diff_path("b/src/main.rs").as_deref(),
            Some("src/main.rs")
        );
        assert_eq!(parse_diff_path("/dev/null"), None);
        assert_eq!(
            parse_diff_path("\"a/src/file\\tname.rs\"").as_deref(),
            Some("src/file\tname.rs")
        );
        assert_eq!(
            parse_diff_path("\"b/src/file\\\"name.rs\"").as_deref(),
            Some("src/file\"name.rs")
        );
    }

    #[test]
    fn parses_basic_unified_diff() {
        let diff = "diff --git a/src/a.py b/src/a.py\n--- a/src/a.py\n+++ b/src/a.py\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n";
        let files = parse_unified_diff(diff);

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "src/a.py");
        assert_eq!(files[0].additions, 1);
        assert_eq!(files[0].deletions, 1);
        assert_eq!(files[0].chunks[0].lines.len(), 3);
        assert_eq!(files[0].chunks[0].lines[0].line_type, "delete");
        assert_eq!(files[0].chunks[0].lines[1].line_type, "add");
    }

    #[test]
    fn parses_added_deleted_and_renamed_diffs() {
        let diff = "diff --git a/new.txt b/new.txt\nnew file mode 100644\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+new\n\ndiff --git a/old.txt b/old.txt\ndeleted file mode 100644\n--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n\ndiff --git a/old-name.txt b/new-name.txt\nsimilarity index 100%\nrename from old-name.txt\nrename to new-name.txt\n--- a/old-name.txt\n+++ b/new-name.txt\n";
        let files = parse_unified_diff(diff);

        assert_eq!(files.len(), 3);
        assert_eq!(files[0].status, "added");
        assert_eq!(files[0].path, "new.txt");
        assert_eq!(files[0].additions, 1);
        assert_eq!(files[1].status, "deleted");
        assert_eq!(files[1].path, "old.txt");
        assert_eq!(files[1].deletions, 1);
        assert_eq!(files[2].status, "renamed");
        assert_eq!(files[2].path, "new-name.txt");
        assert_eq!(files[2].old_path.as_deref(), Some("old-name.txt"));
    }

    #[test]
    fn builds_git_diff_args_for_scopes_and_compare() {
        let mut staged = query();
        staged.scope = Some("staged".to_string());
        staged.file = Some("src/main.rs".to_string());
        staged.context = Some(500);
        assert_eq!(
            git_ui_diff_args(&staged, false).unwrap(),
            vec![
                "diff",
                "--no-ext-diff",
                "--color=never",
                "-U200",
                "--cached",
                "--",
                "src/main.rs"
            ]
        );

        let mut working = query();
        working.scope = Some("working".to_string());
        working.context = Some(0);
        assert_eq!(
            git_ui_diff_args(&working, false).unwrap(),
            vec!["diff", "--no-ext-diff", "--color=never", "-U0"]
        );

        let mut compare = query();
        compare.base = Some("main".to_string());
        compare.target = Some("feature".to_string());
        compare.merge_base = Some(true);
        assert_eq!(
            git_ui_diff_args(&compare, true).unwrap(),
            vec![
                "diff",
                "--no-ext-diff",
                "--color=never",
                "-U3",
                "--merge-base",
                "main",
                "feature"
            ]
        );
    }

    #[test]
    fn rejects_unsafe_diff_args() {
        let mut bad_file = query();
        bad_file.file = Some("../secret".to_string());
        assert!(git_ui_diff_args(&bad_file, false).is_err());

        let mut bad_ref = query();
        bad_ref.base = Some("--help".to_string());
        assert!(git_ui_diff_args(&bad_ref, true).is_err());
    }

    #[test]
    fn validates_git_ui_paths_request() {
        let body = GitUiPathsRequest {
            cwd: "/repo".to_string(),
            paths: vec!["a.txt".to_string(), "dir/b.txt".to_string()],
            confirmed: None,
        };
        assert_eq!(git_ui_paths(&body).unwrap(), vec!["a.txt", "dir/b.txt"]);

        let empty = GitUiPathsRequest {
            cwd: "/repo".to_string(),
            paths: vec![],
            confirmed: None,
        };
        assert!(git_ui_paths(&empty).is_err());

        let unsafe_path = GitUiPathsRequest {
            cwd: "/repo".to_string(),
            paths: vec!["../secret".to_string()],
            confirmed: None,
        };
        assert!(git_ui_paths(&unsafe_path).is_err());
    }

    #[test]
    fn git_ui_status_diff_log_branches_and_file_routes_work() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let repo = TempRepo::new();
            repo.commit_initial();
            repo.write("tracked.txt", "one\ntwo\n");
            repo.write("staged.txt", "staged\n");
            repo.write("untracked.txt", "untracked\n");
            repo.git(&["add", "staged.txt"]);
            let cwd = repo.path.to_str().unwrap().to_string();
            let state = test_state();

            let status = git_ui_status(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiQuery {
                    cwd: Some(cwd.clone()),
                    ..query()
                }),
            )
            .await;
            assert_eq!(status.status(), StatusCode::OK);
            let json = response_json(status).await;
            assert!(json["branch"]
                .as_str()
                .is_some_and(|branch| !branch.is_empty()));
            assert_eq!(json["staged"][0], "staged.txt");
            assert_eq!(json["unstaged"][0], "tracked.txt");
            assert_eq!(json["untracked"][0], "untracked.txt");

            let diff = git_ui_diff(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiQuery {
                    cwd: Some(cwd.clone()),
                    scope: Some("working".to_string()),
                    file: Some("tracked.txt".to_string()),
                    context: Some(1),
                    ..query()
                }),
            )
            .await;
            assert_eq!(diff.status(), StatusCode::OK);
            let json = response_json(diff).await;
            assert_eq!(json["files"][0]["path"], "tracked.txt");
            assert_eq!(json["files"][0]["additions"], 1);

            let branches = git_ui_branches(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiQuery {
                    cwd: Some(cwd.clone()),
                    ..query()
                }),
            )
            .await;
            assert_eq!(branches.status(), StatusCode::OK);
            let json = response_json(branches).await;
            assert!(json["local"][0]["current"].as_bool().unwrap());
            assert!(json["local"][0]["name"]
                .as_str()
                .is_some_and(|branch| !branch.is_empty()));
            assert!(json["branches"]
                .as_array()
                .is_some_and(|branches| !branches.is_empty()));

            let log = git_ui_log(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiQuery {
                    cwd: Some(cwd.clone()),
                    max: Some(5),
                    ..query()
                }),
            )
            .await;
            assert_eq!(log.status(), StatusCode::OK);
            let json = response_json(log).await;
            assert!(json["lines"][0].as_str().unwrap().contains("initial"));

            let file = git_ui_file(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiQuery {
                    cwd: Some(cwd.clone()),
                    file: Some("tracked.txt".to_string()),
                    ..query()
                }),
            )
            .await;
            assert_eq!(file.status(), StatusCode::OK);
            let json = response_json(file).await;
            assert_eq!(json["path"], "tracked.txt");
            assert_eq!(json["content"], "one\ntwo\n");
            assert!(json["hash"].as_str().is_some_and(|hash| !hash.is_empty()));

            let blame = git_ui_blame(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiQuery {
                    cwd: Some(cwd),
                    file: Some("tracked.txt".to_string()),
                    ..query()
                }),
            )
            .await;
            assert_eq!(blame.status(), StatusCode::OK);
            let json = response_json(blame).await;
            assert!(json["text"].as_str().unwrap().contains("\tone"));
        });
    }

    #[test]
    fn git_ui_mutation_routes_stage_unstage_stash_and_commit() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let repo = TempRepo::new();
            repo.commit_initial();
            repo.write("new.txt", "new\n");
            let cwd = repo.path.to_str().unwrap().to_string();
            let state = test_state();

            let stage = git_ui_stage(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiPathsRequest {
                    cwd: cwd.clone(),
                    paths: vec!["new.txt".to_string()],
                    confirmed: None,
                }),
            )
            .await;
            assert_eq!(stage.status(), StatusCode::OK);
            assert!(repo
                .git(&["diff", "--cached", "--name-only"])
                .contains("new.txt"));

            let unstage = git_ui_unstage(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiPathsRequest {
                    cwd: cwd.clone(),
                    paths: vec!["new.txt".to_string()],
                    confirmed: None,
                }),
            )
            .await;
            assert_eq!(unstage.status(), StatusCode::OK);
            assert!(!repo
                .git(&["diff", "--cached", "--name-only"])
                .contains("new.txt"));

            let stash = git_ui_stash(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiStashRequest {
                    cwd: cwd.clone(),
                    message: Some("save new".to_string()),
                    paths: Some(vec!["new.txt".to_string()]),
                    stash: None,
                    pop: None,
                    confirmed: None,
                }),
            )
            .await;
            assert_eq!(stash.status(), StatusCode::OK);
            assert!(!repo.path.join("new.txt").exists());

            let stashes = git_ui_stashes(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiQuery {
                    cwd: Some(cwd.clone()),
                    ..query()
                }),
            )
            .await;
            assert_eq!(stashes.status(), StatusCode::OK);
            let json = response_json(stashes).await;
            assert!(json["stashes"][0]["message"]
                .as_str()
                .unwrap()
                .contains("save new"));

            let apply = git_ui_stash_apply(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiStashRequest {
                    cwd: cwd.clone(),
                    message: None,
                    paths: None,
                    stash: Some("stash@{0}".to_string()),
                    pop: None,
                    confirmed: None,
                }),
            )
            .await;
            assert_eq!(apply.status(), StatusCode::OK);
            assert!(repo.path.join("new.txt").exists());
            repo.git(&["add", "new.txt"]);

            let commit = git_ui_commit(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiCommitRequest {
                    cwd: cwd.clone(),
                    title: "add new".to_string(),
                    body: None,
                    amend: None,
                }),
            )
            .await;
            assert_eq!(commit.status(), StatusCode::OK);
            assert!(repo.git(&["log", "--oneline", "-1"]).contains("add new"));

            let compare = git_ui_compare(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiQuery {
                    cwd: Some(cwd),
                    base: Some("HEAD~1".to_string()),
                    target: Some("HEAD".to_string()),
                    ..query()
                }),
            )
            .await;
            assert_eq!(compare.status(), StatusCode::OK);
            let json = response_json(compare).await;
            assert_eq!(json["files"][0]["path"], "new.txt");
        });
    }

    #[test]
    fn git_ui_write_file_and_destructive_guards_work() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let repo = TempRepo::new();
            repo.commit_initial();
            let cwd = repo.path.to_str().unwrap().to_string();
            let state = test_state();

            let file = git_ui_file(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiQuery {
                    cwd: Some(cwd.clone()),
                    file: Some("tracked.txt".to_string()),
                    ..query()
                }),
            )
            .await;
            let json = response_json(file).await;
            let hash = json["hash"].as_str().unwrap();

            let write = git_ui_write_file(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiWriteFileRequest {
                    cwd: cwd.clone(),
                    path: "tracked.txt".to_string(),
                    content: "changed\n".to_string(),
                    expected_hash: Some(hash.to_string()),
                }),
            )
            .await;
            assert_eq!(write.status(), StatusCode::OK);
            assert_eq!(
                fs::read_to_string(repo.path.join("tracked.txt")).unwrap(),
                "changed\n"
            );

            let discard_without_confirm = git_ui_discard(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiPathsRequest {
                    cwd: cwd.clone(),
                    paths: vec!["tracked.txt".to_string()],
                    confirmed: None,
                }),
            )
            .await;
            assert_eq!(discard_without_confirm.status(), StatusCode::BAD_REQUEST);

            let discard = git_ui_discard(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiPathsRequest {
                    cwd: cwd.clone(),
                    paths: vec!["tracked.txt".to_string()],
                    confirmed: Some(true),
                }),
            )
            .await;
            assert_eq!(discard.status(), StatusCode::OK);
            assert_eq!(
                fs::read_to_string(repo.path.join("tracked.txt")).unwrap(),
                "one\n"
            );

            repo.write("tracked.txt", "staged\n");
            repo.git(&["add", "tracked.txt"]);
            assert!(repo
                .git(&["diff", "--cached", "--name-only"])
                .contains("tracked.txt"));
            let discard_staged = git_ui_discard(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiPathsRequest {
                    cwd: cwd.clone(),
                    paths: vec!["tracked.txt".to_string()],
                    confirmed: Some(true),
                }),
            )
            .await;
            assert_eq!(discard_staged.status(), StatusCode::OK);
            assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "");
            assert_eq!(
                fs::read_to_string(repo.path.join("tracked.txt")).unwrap(),
                "one\n"
            );

            let reset_without_confirm = git_ui_reset(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiResetRequest {
                    cwd,
                    mode: "hard".to_string(),
                    ref_name: "HEAD".to_string(),
                    confirmation: None,
                }),
            )
            .await;
            assert_eq!(reset_without_confirm.status(), StatusCode::BAD_REQUEST);
        });
    }

    #[test]
    fn git_ui_destructive_and_validation_edges_work() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let repo = TempRepo::new();
            repo.commit_initial();
            let cwd = repo.path.to_str().unwrap().to_string();
            let state = test_state();
            fs::create_dir_all(repo.path.join("scratch-dir")).unwrap();
            fs::write(repo.path.join("scratch-dir/file.txt"), "scratch\n").unwrap();

            let discard_dir = git_ui_discard(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiPathsRequest {
                    cwd: cwd.clone(),
                    paths: vec!["scratch-dir".to_string()],
                    confirmed: Some(true),
                }),
            )
            .await;
            assert_eq!(discard_dir.status(), StatusCode::OK);
            assert!(!repo.path.join("scratch-dir").exists());

            let invalid_reset = git_ui_reset(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiResetRequest {
                    cwd: cwd.clone(),
                    mode: "sideways".to_string(),
                    ref_name: "HEAD".to_string(),
                    confirmation: None,
                }),
            )
            .await;
            assert_eq!(invalid_reset.status(), StatusCode::BAD_REQUEST);

            let empty_commit = git_ui_commit(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiCommitRequest {
                    cwd: cwd.clone(),
                    title: "  ".to_string(),
                    body: None,
                    amend: None,
                }),
            )
            .await;
            assert_eq!(empty_commit.status(), StatusCode::BAD_REQUEST);

            let empty_patch = git_ui_apply_patch(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiApplyPatchRequest {
                    cwd,
                    patch: "  ".to_string(),
                    reverse: None,
                    cached: None,
                }),
            )
            .await;
            assert_eq!(empty_patch.status(), StatusCode::BAD_REQUEST);
        });
    }

    #[test]
    fn git_ui_file_history_switch_reset_and_patch_routes_work() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let repo = TempRepo::new();
            repo.commit_initial();
            repo.write("tracked.txt", "one\ntwo\n");
            repo.git(&["add", "tracked.txt"]);
            repo.git(&["commit", "-m", "update tracked"]);
            let cwd = repo.path.to_str().unwrap().to_string();
            let state = test_state();

            let history = git_ui_file_history(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiQuery {
                    cwd: Some(cwd.clone()),
                    file: Some("tracked.txt".to_string()),
                    ..query()
                }),
            )
            .await;
            assert_eq!(history.status(), StatusCode::OK);
            let json = response_json(history).await;
            assert_eq!(json["commits"].as_array().unwrap().len(), 2);

            let switch = git_ui_switch(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiSwitchRequest {
                    cwd: cwd.clone(),
                    branch: "feature".to_string(),
                    create: Some(true),
                    base: Some("HEAD".to_string()),
                }),
            )
            .await;
            assert_eq!(switch.status(), StatusCode::OK);
            assert_eq!(repo.git(&["branch", "--show-current"]).trim(), "feature");

            let reset = git_ui_reset(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiResetRequest {
                    cwd: cwd.clone(),
                    mode: "mixed".to_string(),
                    ref_name: "HEAD".to_string(),
                    confirmation: None,
                }),
            )
            .await;
            assert_eq!(reset.status(), StatusCode::OK);

            let patch = "diff --git a/patched.txt b/patched.txt\nnew file mode 100644\nindex 0000000..3e75765\n--- /dev/null\n+++ b/patched.txt\n@@ -0,0 +1 @@\n+patched\n";
            let apply = git_ui_apply_patch(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiApplyPatchRequest {
                    cwd: cwd.clone(),
                    patch: patch.to_string(),
                    reverse: None,
                    cached: None,
                }),
            )
            .await;
            assert_eq!(apply.status(), StatusCode::OK);
            assert_eq!(fs::read_to_string(repo.path.join("patched.txt")).unwrap(), "patched\n");

            let reverse = git_ui_apply_patch(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiApplyPatchRequest {
                    cwd,
                    patch: patch.to_string(),
                    reverse: Some(true),
                    cached: None,
                }),
            )
            .await;
            assert_eq!(reverse.status(), StatusCode::OK);
            assert!(!repo.path.join("patched.txt").exists());
        });
    }

    #[test]
    fn git_ui_stash_pop_drop_and_commit_amend_work() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let repo = TempRepo::new();
            repo.commit_initial();
            repo.write("tracked.txt", "one\ntwo\n");
            let cwd = repo.path.to_str().unwrap().to_string();
            let state = test_state();

            let stash = git_ui_stash(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiStashRequest {
                    cwd: cwd.clone(),
                    message: None,
                    paths: None,
                    stash: None,
                    pop: None,
                    confirmed: None,
                }),
            )
            .await;
            assert_eq!(stash.status(), StatusCode::OK);

            let pop = git_ui_stash_apply(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiStashRequest {
                    cwd: cwd.clone(),
                    message: None,
                    paths: None,
                    stash: Some("stash@{0}".to_string()),
                    pop: Some(true),
                    confirmed: None,
                }),
            )
            .await;
            assert_eq!(pop.status(), StatusCode::OK);
            assert_eq!(
                fs::read_to_string(repo.path.join("tracked.txt")).unwrap(),
                "one\ntwo\n"
            );

            repo.git(&["add", "tracked.txt"]);
            let amend = git_ui_commit(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiCommitRequest {
                    cwd: cwd.clone(),
                    title: "amended title".to_string(),
                    body: Some("amended body".to_string()),
                    amend: Some(true),
                }),
            )
            .await;
            assert_eq!(amend.status(), StatusCode::OK);
            assert!(repo
                .git(&["log", "-1", "--format=%B"])
                .contains("amended body"));

            repo.write("drop.txt", "drop\n");
            let stash = git_ui_stash(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiStashRequest {
                    cwd: cwd.clone(),
                    message: Some("drop me".to_string()),
                    paths: Some(vec!["drop.txt".to_string()]),
                    stash: None,
                    pop: None,
                    confirmed: None,
                }),
            )
            .await;
            assert_eq!(stash.status(), StatusCode::OK);

            let drop_without_confirm = git_ui_stash_drop(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiStashRequest {
                    cwd: cwd.clone(),
                    message: None,
                    paths: None,
                    stash: Some("stash@{0}".to_string()),
                    pop: None,
                    confirmed: None,
                }),
            )
            .await;
            assert_eq!(drop_without_confirm.status(), StatusCode::BAD_REQUEST);

            let drop = git_ui_stash_drop(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiStashRequest {
                    cwd,
                    message: None,
                    paths: None,
                    stash: Some("stash@{0}".to_string()),
                    pop: None,
                    confirmed: Some(true),
                }),
            )
            .await;
            assert_eq!(drop.status(), StatusCode::OK);
        });
    }

    #[test]
    fn git_ui_conflict_routes_detect_resolve_and_abort_merge() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let repo = TempRepo::new();
            repo.write("conflict.txt", "base\n");
            repo.git(&["add", "conflict.txt"]);
            repo.git(&["commit", "-m", "base"]);
            repo.git(&["switch", "-c", "other"]);
            repo.write("conflict.txt", "other\n");
            repo.git(&["commit", "-am", "other change"]);
            repo.git(&["switch", "main"]);
            repo.write("conflict.txt", "main\n");
            repo.git(&["commit", "-am", "main change"]);
            let merge = Command::new("git")
                .current_dir(&repo.path)
                .args(["merge", "other"])
                .output()
                .unwrap();
            assert!(!merge.status.success());
            let cwd = repo.path.to_str().unwrap().to_string();
            let state = test_state();

            let conflicts = git_ui_conflicts(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiQuery {
                    cwd: Some(cwd.clone()),
                    ..query()
                }),
            )
            .await;
            assert_eq!(conflicts.status(), StatusCode::OK);
            let json = response_json(conflicts).await;
            assert_eq!(json["files"][0], "conflict.txt");
            assert_eq!(json["merge"], true);

            let resolve = git_ui_conflict_resolve(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiConflictResolveRequest {
                    cwd: cwd.clone(),
                    path: "conflict.txt".to_string(),
                    mode: "manual".to_string(),
                    content: Some("resolved\n".to_string()),
                }),
            )
            .await;
            assert_eq!(resolve.status(), StatusCode::OK);
            assert_eq!(
                fs::read_to_string(repo.path.join("conflict.txt")).unwrap(),
                "resolved\n"
            );
            assert!(repo
                .git(&["diff", "--cached", "--name-only"])
                .contains("conflict.txt"));

            repo.git(&["merge", "--abort"]);
            let merge = Command::new("git")
                .current_dir(&repo.path)
                .args(["merge", "other"])
                .output()
                .unwrap();
            assert!(!merge.status.success());
            let abort = git_ui_conflict_action(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiConflictActionRequest {
                    cwd,
                    action: "merge-abort".to_string(),
                }),
            )
            .await;
            assert_eq!(abort.status(), StatusCode::OK);
        });
    }
}
