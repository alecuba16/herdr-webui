use std::collections::VecDeque;
use std::fs;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{expand_user_path_string, require_auth, WebState};
use super::{git_json_error, git_ui_text, list_local_branches, safe_git_token};

#[derive(Deserialize)]
pub(super) struct GitUiCleanupQuery {
    pub(super) root: Option<String>,
    pub(super) cwd: Option<String>,
}

#[derive(Deserialize)]
pub(super) struct GitUiWorktreeRemoveRequest {
    pub(super) cwd: String,
    pub(super) path: String,
    pub(super) force: Option<bool>,
    pub(super) confirmed: Option<bool>,
}

#[derive(Deserialize)]
pub(super) struct GitUiWorktreePruneRequest {
    pub(super) cwd: String,
    pub(super) dry_run: Option<bool>,
    pub(super) expire: Option<String>,
}

#[derive(Serialize)]
pub(super) struct GitCleanupBranch {
    name: String,
    current: bool,
    checked_out: bool,
}

#[derive(Serialize)]
pub(super) struct GitCleanupWorktree {
    path: String,
    branch: Option<String>,
    detached: bool,
    prunable: bool,
    primary: bool,
}

#[derive(Serialize)]
pub(super) struct GitCleanupRepo {
    pub(super) path: String,
    branches: Vec<GitCleanupBranch>,
    worktrees: Vec<GitCleanupWorktree>,
    error: Option<String>,
}

const GIT_CLEANUP_SCAN_LIMIT: usize = 1500;
const GIT_CLEANUP_SCAN_MAX_DEPTH: usize = 15;
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".tox",
    ".next",
    ".nuxt",
    ".gradle",
    ".m2",
    ".svelte-kit",
    ".turbo",
    ".parcel-cache",
    "dist",
    "target",
    "build",
];

pub(super) async fn git_ui_cleanup_scan(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiCleanupQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let Some(root) = query.root.as_deref().or(query.cwd.as_deref()) else {
        return git_json_error(StatusCode::BAD_REQUEST, "root is required");
    };
    let root_owned = root.to_string();
    match tokio::task::spawn_blocking(move || git_cleanup_scan(&root_owned))
        .await
    {
        Ok(Ok((repos, truncated))) => Json(json!({
            "root": expand_user_path_string(root),
            "repos": repos,
            "truncated": truncated,
        }))
        .into_response(),
        Ok(Err(err)) => git_json_error(StatusCode::BAD_REQUEST, err),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

pub(super) fn git_cleanup_scan(root: &str) -> Result<(Vec<GitCleanupRepo>, bool), String> {
    let root = PathBuf::from(expand_user_path_string(root));
    if !root.is_dir() {
        return Err("root directory does not exist".to_string());
    }
    let (repo_paths, truncated) = discover_git_repos(&root)?;
    let repos = repo_paths
        .into_iter()
        .map(|path| cleanup_repo(&path))
        .collect::<Vec<_>>();
    Ok((repos, truncated))
}

pub(super) fn discover_git_repos(root: &Path) -> Result<(Vec<PathBuf>, bool), String> {
    let mut repos = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut visited = 0usize;
    let mut truncated = false;
    while let Some((dir, depth)) = queue.pop_front() {
        visited += 1;
        if visited > GIT_CLEANUP_SCAN_LIMIT {
            truncated = true;
            break;
        }
        let git_marker = dir.join(".git");
        if git_marker.is_dir() {
            let canonical = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
            if seen.insert(canonical) {
                repos.push(dir);
            }
            continue;
        }
        if git_marker.is_file() {
            match resolve_worktree_base(&git_marker) {
                Some(base) => {
                    let canonical = fs::canonicalize(&base).unwrap_or_else(|_| base.clone());
                    if seen.insert(canonical) {
                        repos.push(base);
                    }
                }
                None => {
                    let canonical = fs::canonicalize(&dir).unwrap_or_else(|_| dir.clone());
                    if seen.insert(canonical) {
                        repos.push(dir);
                    }
                }
            }
            continue;
        }
        if depth >= GIT_CLEANUP_SCAN_MAX_DEPTH {
            continue;
        }
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(err) if dir == root => return Err(err.to_string()),
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if name.to_string_lossy() == ".git" || !file_type.is_dir() {
                continue;
            }
            if SKIP_DIRS
                .iter()
                .any(|skip| name.to_string_lossy() == *skip)
            {
                continue;
            }
            queue.push_back((path, depth + 1));
        }
    }
    repos.sort();
    Ok((repos, truncated))
}

pub(super) fn resolve_worktree_base(git_file: &Path) -> Option<PathBuf> {
    let content = fs::read_to_string(git_file).ok()?;
    let gitdir_line = content.lines().next()?;
    let gitdir_path = gitdir_line.strip_prefix("gitdir:")?.trim();
    let worktree_gitdir = if Path::new(gitdir_path).is_absolute() {
        PathBuf::from(gitdir_path)
    } else {
        git_file.parent()?.join(gitdir_path)
    };
    let gitdir_str = worktree_gitdir.to_string_lossy();
    if !gitdir_str.contains(".git/worktrees/") {
        return None;
    }
    let common_git_dir = worktree_gitdir
        .ancestors()
        .skip(1)
        .find(|p| p.file_name() == Some(std::ffi::OsStr::new(".git")))?;
    let base_repo = common_git_dir.parent()?;
    Some(base_repo.to_path_buf())
}

fn cleanup_repo(path: &Path) -> GitCleanupRepo {
    let repo = path.to_string_lossy().to_string();
    match cleanup_repo_details(&repo) {
        Ok((branches, worktrees)) => GitCleanupRepo {
            path: repo,
            branches,
            worktrees,
            error: None,
        },
        Err(error) => GitCleanupRepo {
            path: repo,
            branches: Vec::new(),
            worktrees: Vec::new(),
            error: Some(error),
        },
    }
}

fn cleanup_repo_details(
    cwd: &str,
) -> Result<(Vec<GitCleanupBranch>, Vec<GitCleanupWorktree>), String> {
    let worktrees = cleanup_worktrees(cwd)?;
    let checked_out = worktrees
        .iter()
        .filter_map(|worktree| worktree.branch.as_deref())
        .collect::<std::collections::HashSet<_>>();
    let branches = list_local_branches(cwd)?
        .into_iter()
        .map(|b| {
            let checked_out = checked_out.contains(b.name.as_str());
            GitCleanupBranch {
                name: b.name,
                current: b.current,
                checked_out,
            }
        })
        .collect::<Vec<_>>();
    Ok((branches, worktrees))
}

fn cleanup_worktrees(cwd: &str) -> Result<Vec<GitCleanupWorktree>, String> {
    let root = git_ui_text(cwd, &["rev-parse", "--show-toplevel"])?
        .trim()
        .to_string();
    let text = git_ui_text(cwd, &["worktree", "list", "--porcelain"])?;
    let mut rows = Vec::new();
    let mut current: Option<GitCleanupWorktree> = None;
    for line in text.lines().chain(std::iter::once("")) {
        if line.is_empty() {
            if let Some(row) = current.take() {
                rows.push(row);
            }
            continue;
        }
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(row) = current.take() {
                rows.push(row);
            }
            current = Some(GitCleanupWorktree {
                path: path.to_string(),
                branch: None,
                detached: false,
                prunable: false,
                primary: path == root,
            });
        } else if let Some(branch) = line.strip_prefix("branch ") {
            if let Some(row) = current.as_mut() {
                row.branch = Some(
                    branch
                        .strip_prefix("refs/heads/")
                        .unwrap_or(branch)
                        .to_string(),
                );
            }
        } else if line == "detached" {
            if let Some(row) = current.as_mut() {
                row.detached = true;
            }
        } else if line.starts_with("prunable") {
            if let Some(row) = current.as_mut() {
                row.prunable = true;
            }
        }
    }
    Ok(rows)
}

fn git_ui_worktree_remove_blocking(
    cwd: String,
    path: String,
    force: bool,
) -> Result<Response, (StatusCode, String)> {
    let path = expand_user_path_string(&path);
    let repo = match git_ui_text(&cwd, &["rev-parse", "--show-toplevel"]) {
        Ok(value) => value.trim().to_string(),
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
    };
    let requested_path = fs::canonicalize(&path).unwrap_or_else(|_| PathBuf::from(&path));
    let primary_path = fs::canonicalize(&repo).unwrap_or_else(|_| PathBuf::from(&repo));
    if requested_path == primary_path {
        return Err((
            StatusCode::BAD_REQUEST,
            "primary worktree cannot be removed here".to_string(),
        ));
    }
    let args = if force {
        vec!["worktree", "remove", "--force", path.as_str()]
    } else {
        vec!["worktree", "remove", path.as_str()]
    };
    match git_ui_text(&cwd, &args) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_worktree_remove(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiWorktreeRemoveRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    if !body.confirmed.unwrap_or(false) {
        return git_json_error(
            StatusCode::BAD_REQUEST,
            "worktree removal requires confirmation",
        );
    }
    let force = body.force.unwrap_or(false);
    let path = body.path;
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || {
        git_ui_worktree_remove_blocking(cwd, path, force)
    })
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_worktree_prune_blocking(
    cwd: String,
    args: Vec<String>,
) -> Result<Response, (StatusCode, String)> {
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    match git_ui_text(&cwd, &refs) {
        Ok(text) => {
            let pruned: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
            Ok(Json(json!({ "ok": true, "pruned": pruned, "message": text })).into_response())
        }
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_worktree_prune(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiWorktreePruneRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let mut args = vec!["worktree".to_string(), "prune".to_string()];
    if body.dry_run.unwrap_or(false) {
        args.push("--dry-run".to_string());
    }
    if let Some(expire) = body.expire.as_deref() {
        let validated = match safe_git_token(expire, "expire") {
            Ok(v) => v,
            Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
        };
        args.push("--expire".to_string());
        args.push(validated.to_string());
    }
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_worktree_prune_blocking(cwd, args)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}