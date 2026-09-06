use std::collections::HashMap;
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

/// One git call per branch keeps this simple and correct; branch lists are
/// small and the endpoint is invoked when the popover opens, not per render.
fn branch_tip_details(cwd: &str, ref_name: &str) -> Option<String> {
    git_ui_text(cwd, &["show", "-s", "--format=%an%x00%cI%x00%s", ref_name])
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

/// Splits the NUL-delimited tip details into (author, ISO date, subject).
/// Missing pieces come back as empty strings.
fn split_branch_tip_details(details: &str) -> (String, String, String) {
    let mut parts = details.splitn(3, '\0');
    let author = parts.next().unwrap_or("").to_string();
    let date = parts.next().unwrap_or("").to_string();
    let subject = parts.next().unwrap_or("").to_string();
    (author, date, subject)
}

fn git_ui_branches_blocking(cwd: String) -> Result<Response, (StatusCode, String)> {
    let worktree_paths = git_ui_text(&cwd, &["worktree", "list", "--porcelain"])
        .map(|raw| parse_worktree_branch_paths(&raw))
        .unwrap_or_default();
    let local = match list_local_branches(&cwd) {
        Ok(branches) => branches,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
    };
    let local_json = local
        .iter()
        .map(|b| {
            let tip = branch_tip_details(&cwd, &format!("refs/heads/{}", b.name));
            let details = tip.as_deref().unwrap_or("");
            let (author, date, subject) = split_branch_tip_details(details);
            json!({
                "name": b.name,
                "current": b.current,
                "remote": false,
                "worktree_path": worktree_paths.get(&b.name).cloned(),
                "pushed": b.pushed,
                "upstream": b.upstream.as_deref(),
                "author": author,
                "date": date,
                "subject": subject,
            })
        })
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
            let local = local_branch_name_for_remote(name);
            let tip = branch_tip_details(&cwd, &format!("refs/remotes/{name}"));
            let details = tip.as_deref().unwrap_or("");
            let (author, date, subject) = split_branch_tip_details(details);
            Some(json!({
                "name": name,
                "current": false,
                "remote": true,
                "worktree_path": worktree_paths.get(local).cloned(),
                "author": author,
                "date": date,
                "subject": subject,
            }))
        })
        .collect::<Vec<_>>();
    let mut branches = local_json.clone();
    branches.extend(remote.clone());
    Ok(
        Json(json!({ "branches": branches, "local": local_json, "remote": remote }))
            .into_response(),
    )
}

fn local_branch_name_for_remote(remote: &str) -> &str {
    remote
        .split_once('/')
        .map(|(_, branch)| branch)
        .unwrap_or(remote)
}

pub(super) fn parse_worktree_branch_paths(raw: &str) -> HashMap<String, String> {
    let mut paths = HashMap::new();
    let mut current_path: Option<String> = None;
    for line in raw.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(path.to_string());
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if let Some(path) = current_path.as_ref() {
                paths.insert(branch.to_string(), path.clone());
            }
        } else if line.trim().is_empty() {
            current_path = None;
        }
    }
    paths
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
    maybe_switch_before_delete(&cwd, &branch)?;
    let delete_flag = if force { "-D" } else { "-d" };
    match git_ui_text(&cwd, &["branch", delete_flag, "--", &branch]) {
        Ok(text) => Ok(Json(json!({ "ok": true, "message": text })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

fn maybe_switch_before_delete(cwd: &str, branch: &str) -> Result<(), (StatusCode, String)> {
    let branches = list_local_branches(cwd).map_err(|err| (StatusCode::BAD_GATEWAY, err))?;
    let Some(target) = branches.iter().find(|candidate| candidate.name == branch) else {
        return Err((StatusCode::BAD_REQUEST, "branch not found".to_string()));
    };
    if !target.current {
        return Ok(());
    }
    if is_default_branch(branch) {
        return Err((
            StatusCode::BAD_REQUEST,
            "current main/master branch cannot be deleted".to_string(),
        ));
    }
    let Some(default_branch) = branches
        .iter()
        .find(|candidate| candidate.name == "main")
        .or_else(|| branches.iter().find(|candidate| candidate.name == "master"))
        .map(|candidate| candidate.name.as_str())
    else {
        return Err((
            StatusCode::BAD_REQUEST,
            "main or master branch is required before deleting the current branch".to_string(),
        ));
    };
    git_ui_text(cwd, &["switch", "--", default_branch])
        .map(|_| ())
        .map_err(|err| (StatusCode::BAD_GATEWAY, err))
}

fn is_default_branch(branch: &str) -> bool {
    branch == "main" || branch == "master"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_branch_tip_details_parses_all_fields() {
        let (author, date, subject) = split_branch_tip_details(concat!(
            "Ada",
            '\u{0}',
            "2026-09-01T10:00:00+02:00",
            '\u{0}',
            "fix the thing"
        ));
        assert_eq!(author, "Ada");
        assert_eq!(date, "2026-09-01T10:00:00+02:00");
        assert_eq!(subject, "fix the thing");
        let (author, date, subject) = split_branch_tip_details("Ada");
        assert_eq!(author, "Ada");
        assert_eq!(date, "");
        assert_eq!(subject, "");
    }

    #[test]
    fn branches_payload_includes_author_and_date() {
        let root =
            std::env::temp_dir().join(format!("herdr-webui-branch-details-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(&root)
            .args(["init", "-b", "main"])
            .output()
            .unwrap();
        assert!(output.status.success());
        for args in [
            ["config", "user.email", "t@t"],
            ["config", "user.name", "T"],
        ] {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success());
        }
        std::fs::write(root.join("a.txt"), "base\n").unwrap();
        for args in [vec!["add", "-A"], vec!["commit", "-m", "hello"]] {
            let out = std::process::Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(args)
                .output()
                .unwrap();
            assert!(out.status.success());
        }
        let details = branch_tip_details(root.to_str().unwrap(), "refs/heads/main");
        assert!(details.is_some());
        let (author, date, subject) = split_branch_tip_details(&details.unwrap());
        assert_eq!(author, "T");
        assert!(date.starts_with("20"), "date: {date}");
        assert_eq!(subject, "hello");

        let _ = std::fs::remove_dir_all(&root);
    }
}
