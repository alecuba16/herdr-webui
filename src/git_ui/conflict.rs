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

use super::{
    git_failure, git_json_error, git_ui_output, git_ui_repo, git_ui_text, safe_repo_path,
    GitUiCwdQuery,
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
        mode if is_base_conflict_mode(mode) => git_ui_conflict_stage_to_file(&cwd, &path, 1),
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

fn git_conflict_stage_spec(stage: u8, path: &str) -> String {
    format!(":{stage}:{path}")
}

fn is_base_conflict_mode(mode: &str) -> bool {
    matches!(mode, "base" | "parent")
}

fn git_ui_conflict_stage_to_file(cwd: &str, path: &str, stage: u8) -> Result<String, String> {
    let repo = git_ui_repo(cwd)?;
    let spec = git_conflict_stage_spec(stage, path);
    let output = Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["show", &spec])
        .output()
        .map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(git_failure(output, "git show"));
    }
    let full = Path::new(&repo).join(path);
    if let Some(parent) = full.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    fs::write(full, output.stdout).map_err(|err| err.to_string())?;
    git_ui_text(&repo, &["add", "--", path])
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::*;

    #[test]
    fn conflict_stage_spec_targets_git_index_stages() {
        assert_eq!(git_conflict_stage_spec(1, "src/main.rs"), ":1:src/main.rs");
        assert_eq!(git_conflict_stage_spec(2, "file.txt"), ":2:file.txt");
        assert_eq!(
            git_conflict_stage_spec(3, "dir/file.txt"),
            ":3:dir/file.txt"
        );
        assert!(is_base_conflict_mode("base"));
        assert!(is_base_conflict_mode("parent"));
        assert!(!is_base_conflict_mode("ours"));
    }

    #[test]
    fn conflict_resolve_base_uses_parent_stage_and_stages_file() {
        let repo = temp_repo("herdr-conflict-base");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "test@example.com"]);
        run_git(&repo, &["config", "user.name", "Herdr Test"]);
        std::fs::write(repo.join("file.txt"), "base\n").unwrap();
        run_git(&repo, &["add", "file.txt"]);
        run_git(&repo, &["commit", "-m", "base"]);
        let base_branch = git_text(&repo, &["branch", "--show-current"])
            .trim()
            .to_string();
        run_git(&repo, &["checkout", "-b", "feature"]);
        std::fs::write(repo.join("file.txt"), "head\n").unwrap();
        run_git(&repo, &["commit", "-am", "head"]);
        run_git(&repo, &["checkout", &base_branch]);
        std::fs::write(repo.join("file.txt"), "remote\n").unwrap();
        run_git(&repo, &["commit", "-am", "remote"]);
        run_git(&repo, &["checkout", "feature"]);
        let merge = Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["merge", base_branch.as_str()])
            .output()
            .unwrap();
        assert!(!merge.status.success(), "merge should conflict");

        git_ui_conflict_resolve_blocking(
            repo.to_string_lossy().to_string(),
            "file.txt".to_string(),
            "base".to_string(),
            None,
        )
        .unwrap();

        assert_eq!(
            std::fs::read_to_string(repo.join("file.txt")).unwrap(),
            "base\n"
        );
        let status = git_text(&repo, &["status", "--porcelain"]);
        assert!(
            status.contains("M  file.txt"),
            "expected staged file, got {status:?}"
        );
        let _ = std::fs::remove_dir_all(repo);
    }

    fn temp_repo(prefix: &str) -> std::path::PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()))
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_text(repo: &Path, args: &[&str]) -> String {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).to_string()
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
        "rebase-skip" => vec!["rebase", "--skip"],
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
