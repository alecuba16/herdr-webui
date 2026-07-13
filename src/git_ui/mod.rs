use std::fs;
use std::net::SocketAddr;
use std::path::Path;
use std::process::Command;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::json;

use crate::{expand_user_path_string, git_failure, require_auth, WebState};

mod branch;
mod cleanup;
mod conflict;
mod diff;
mod file;
mod log;
mod stash;

macro_rules! check_auth {
    ($state:expr, $headers:expr, $remote:expr) => {
        if let Err(response) = require_auth($state, $headers, $remote) {
            return response;
        }
    };
}

pub(crate) fn routes() -> Router<WebState> {
    Router::new()
        .route("/api/git-ui/status", get(git_ui_status))
        .route("/api/git-ui/diff", get(diff::git_ui_diff))
        .route("/api/git-ui/compare", get(diff::git_ui_compare))
        .route("/api/git-ui/branches", get(branch::git_ui_branches))
        .route(
            "/api/git-ui/cleanup-scan",
            get(cleanup::git_ui_cleanup_scan),
        )
        .route(
            "/api/git-ui/branch-delete",
            post(branch::git_ui_branch_delete),
        )
        .route(
            "/api/git-ui/worktree-remove",
            post(cleanup::git_ui_worktree_remove),
        )
        .route(
            "/api/git-ui/worktree-prune",
            post(cleanup::git_ui_worktree_prune),
        )
        .route("/api/git-ui/log", get(log::git_ui_log))
        .route("/api/git-ui/blame", get(file::git_ui_blame))
        .route(
            "/api/git-ui/file",
            get(file::git_ui_file).post(file::git_ui_write_file),
        )
        .route("/api/git-ui/file-history", get(file::git_ui_file_history))
        .route("/api/git-ui/stashes", get(stash::git_ui_stashes))
        .route("/api/git-ui/conflicts", get(conflict::git_ui_conflicts))
        .route("/api/git-ui/stage", post(git_ui_stage))
        .route("/api/git-ui/unstage", post(git_ui_unstage))
        .route("/api/git-ui/discard", post(git_ui_discard))
        .route("/api/git-ui/stash", post(stash::git_ui_stash))
        .route("/api/git-ui/stash-apply", post(stash::git_ui_stash_apply))
        .route("/api/git-ui/stash-drop", post(stash::git_ui_stash_drop))
        .route("/api/git-ui/switch", post(branch::git_ui_switch))
        .route("/api/git-ui/reset", post(log::git_ui_reset))
        .route("/api/git-ui/rebase", post(log::git_ui_rebase))
        .route("/api/git-ui/pull", post(log::git_ui_pull))
        .route("/api/git-ui/push", post(log::git_ui_push))
        .route("/api/git-ui/commit", post(log::git_ui_commit))
        .route("/api/git-ui/tag", post(log::git_ui_tag))
        .route("/api/git-ui/apply-patch", post(log::git_ui_apply_patch))
        .route(
            "/api/git-ui/conflict-resolve",
            post(conflict::git_ui_conflict_resolve),
        )
        .route(
            "/api/git-ui/conflict-action",
            post(conflict::git_ui_conflict_action),
        )
}

#[derive(Deserialize)]
pub(super) struct GitUiCwdQuery {
    pub(super) cwd: Option<String>,
}

#[derive(Deserialize)]
struct GitUiPathsRequest {
    cwd: String,
    paths: Vec<String>,
    confirmed: Option<bool>,
}

pub(super) fn git_json_error(status: StatusCode, error: impl Into<String>) -> Response {
    (status, Json(json!({ "error": error.into() }))).into_response()
}

pub(super) fn git_ui_repo(cwd: &str) -> Result<String, String> {
    let validated = safe_git_token(cwd, "repository path")?;
    let expanded = expand_user_path_string(validated);
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

pub(super) fn git_ui_output(cwd: &str, args: &[&str]) -> Result<std::process::Output, String> {
    let repo = git_ui_repo(cwd)?;
    Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .map_err(|err| err.to_string())
}

pub(super) fn git_ui_text(cwd: &str, args: &[&str]) -> Result<String, String> {
    let output = git_ui_output(cwd, args)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    } else {
        Err(git_failure(output, args.first().copied().unwrap_or("git")))
    }
}

pub(super) fn git_ui_text_strings(cwd: &str, args: &[String]) -> Result<String, String> {
    let refs = args.iter().map(String::as_str).collect::<Vec<_>>();
    git_ui_text(cwd, &refs)
}

pub(super) fn safe_repo_path(path: &str) -> Result<&str, String> {
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

pub(super) fn safe_git_token<'a>(value: &'a str, label: &str) -> Result<&'a str, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.contains('\0') {
        return Err(format!("invalid {label}"));
    }
    Ok(trimmed)
}

pub(super) struct LocalBranch {
    pub(super) name: String,
    pub(super) current: bool,
}

pub(super) fn list_local_branches(cwd: &str) -> Result<Vec<LocalBranch>, String> {
    let text = git_ui_text(cwd, &["branch", "--format=%(refname:short)%00%(HEAD)"])?;
    let branches = text
        .lines()
        .filter_map(|line| {
            let mut parts = line.split('\0');
            let name = parts.next()?.trim();
            if name.is_empty() {
                return None;
            }
            Some(LocalBranch {
                name: name.to_string(),
                current: parts.next() == Some("*"),
            })
        })
        .collect::<Vec<_>>();
    Ok(branches)
}

fn git_remote_url(cwd: &str, upstream: &str) -> Option<String> {
    let remote = upstream
        .split_once('/')
        .map(|(remote, _)| remote)
        .filter(|remote| !remote.trim().is_empty())
        .unwrap_or("origin");
    git_ui_text(cwd, &["config", "--get", &format!("remote.{remote}.url")])
        .ok()
        .map(|url| url.trim().to_string())
        .filter(|url| !url.is_empty())
}

fn git_status_blocking(cwd: String) -> Result<Response, (StatusCode, String)> {
    let repo = match git_ui_repo(&cwd) {
        Ok(repo) => repo,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let status = match git_ui_text(&repo, &["status", "--porcelain=v2", "--branch"]) {
        Ok(text) => text,
        Err(err) => return Err((StatusCode::BAD_GATEWAY, err)),
    };
    let mut branch = String::new();
    let mut upstream = String::new();
    let mut ahead: usize = 0;
    let mut behind: usize = 0;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    let mut conflicted = Vec::new();
    // Porcelain v2 branch header lines:
    //   # branch.oid <hash>
    //   # branch.head <branch>          (or "(detached)")
    //   # branch.upstream <upstream>    (only when an upstream is set)
    //   # branch.ab +<ahead> -<behind>  (only when an upstream is set)
    //
    // Entry lines are keyed by a leading type char:
    //   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
    //   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <R><score> <path>\t<oldpath>
    //   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>   (unmerged)
    //   ? <path>                                                  (untracked)
    for line in status.lines() {
        if let Some(name) = line.strip_prefix("# branch.head ") {
            branch = name.to_string();
            continue;
        }
        if let Some(name) = line.strip_prefix("# branch.upstream ") {
            upstream = name.to_string();
            continue;
        }
        if let Some(rest) = line.strip_prefix("# branch.ab ") {
            let mut parts = rest.split_whitespace();
            if let Some(value) = parts.next().and_then(|v| v.strip_prefix('+')) {
                ahead = value.parse().unwrap_or(0);
            }
            if let Some(value) = parts.next().and_then(|v| v.strip_prefix('-')) {
                behind = value.parse().unwrap_or(0);
            }
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        match line.chars().next() {
            Some('?') => {
                if let Some(path) = line.strip_prefix("? ") {
                    untracked.push(path.to_string());
                }
            }
            Some('1') | Some('2') => {
                // 9 fixed fields for type 1, 10 for type 2 (extra <R><score> column);
                // the final field holds the path (type 2 also appends \t<oldpath>).
                let n = if line.starts_with('1') { 9 } else { 10 };
                let fields: Vec<&str> = line.splitn(n, ' ').collect();
                if fields.len() < n {
                    continue;
                }
                let xy = fields[1].as_bytes();
                if xy.len() >= 2 {
                    let path_field = fields[n - 1];
                    let path = path_field.split('\t').next().unwrap_or(path_field);
                    let (x, y) = (xy[0] as char, xy[1] as char);
                    // Porcelain v2 uses '.' for unmodified where v1 used ' '.
                    let is_change = |c: char| !matches!(c, ' ' | '.');
                    if matches!((x, y), ('U', _) | (_, 'U') | ('A', 'A') | ('D', 'D')) {
                        conflicted.push(path.to_string());
                    } else {
                        if is_change(x) {
                            staged.push(path.to_string());
                        }
                        if is_change(y) {
                            unstaged.push(path.to_string());
                        }
                    }
                }
            }
            Some('u') => {
                let fields: Vec<&str> = line.splitn(11, ' ').collect();
                if let Some(path) = fields.get(10) {
                    conflicted.push(path.to_string());
                }
            }
            _ => {}
        }
    }
    let mut warnings: Vec<String> = Vec::new();
    let stashes = match git_ui_text(&repo, &["stash", "list", "--format=%gd"]) {
        Ok(text) => text.lines().count(),
        Err(err) => {
            warnings.push(format!("stash list failed: {err}"));
            0
        }
    };
    let staged_summaries = match git_ui_text(&repo, &["diff", "--numstat", "--cached"]) {
        Ok(text) => diff::parse_numstat(&text),
        Err(err) => {
            warnings.push(format!("staged numstat failed: {err}"));
            serde_json::Map::new()
        }
    };
    let unstaged_summaries = match git_ui_text(&repo, &["diff", "--numstat"]) {
        Ok(text) => diff::parse_numstat(&text),
        Err(err) => {
            warnings.push(format!("unstaged numstat failed: {err}"));
            serde_json::Map::new()
        }
    };
    let remote_url = git_remote_url(&repo, &upstream);
    let state_name = if !conflicted.is_empty() {
        "conflicts"
    } else if staged.is_empty() && unstaged.is_empty() && untracked.is_empty() {
        "clean"
    } else {
        "dirty"
    };
    Ok(Json(json!({
        "repo_path": repo,
        "branch": branch,
        "upstream": upstream,
        "remote_url": remote_url,
        "ahead": ahead,
        "behind": behind,
        "state": state_name,
        "staged": staged,
        "unstaged": unstaged,
        "untracked": untracked,
        "conflicted": conflicted,
        "summaries": {
            "staged": staged_summaries,
            "unstaged": unstaged_summaries,
        },
        "stashes": stashes,
        "warnings": warnings,
    }))
    .into_response())
}

async fn git_ui_status(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiCwdQuery>,
) -> Response {
    check_auth!(&state, &headers, remote);
    let Some(cwd) = query.cwd.as_deref() else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    let cwd = cwd.to_string();
    match tokio::task::spawn_blocking(move || git_status_blocking(cwd)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_paths(body: &GitUiPathsRequest) -> Result<Vec<&str>, String> {
    if body.paths.is_empty() {
        return Err("paths are required".to_string());
    }
    body.paths.iter().map(|path| safe_repo_path(path)).collect()
}

fn git_ui_stage_blocking(
    cwd: String,
    paths: Vec<String>,
) -> Result<Response, (StatusCode, String)> {
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths);
    match git_ui_text_strings(&cwd, &args) {
        Ok(_) => Ok(Json(json!({ "ok": true })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

async fn git_ui_stage(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiPathsRequest>,
) -> Response {
    check_auth!(&state, &headers, remote);
    let paths = match git_ui_paths(&body) {
        Ok(paths) => paths,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let paths = paths.into_iter().map(|p| p.to_string()).collect::<Vec<_>>();
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_stage_blocking(cwd, paths)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_unstage_blocking(
    cwd: String,
    paths: Vec<String>,
) -> Result<Response, (StatusCode, String)> {
    let mut args = vec![
        "restore".to_string(),
        "--staged".to_string(),
        "--".to_string(),
    ];
    args.extend(paths);
    match git_ui_text_strings(&cwd, &args) {
        Ok(_) => Ok(Json(json!({ "ok": true })).into_response()),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

async fn git_ui_unstage(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiPathsRequest>,
) -> Response {
    check_auth!(&state, &headers, remote);
    let paths = match git_ui_paths(&body) {
        Ok(paths) => paths,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let paths = paths.into_iter().map(|p| p.to_string()).collect::<Vec<_>>();
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_unstage_blocking(cwd, paths)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

fn git_ui_discard_blocking(
    cwd: String,
    paths: Vec<String>,
) -> Result<Response, (StatusCode, String)> {
    let repo = match git_ui_repo(&cwd) {
        Ok(repo) => repo,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    for path in &paths {
        let tracked = git_ui_output(&repo, &["ls-files", "--error-unmatch", "--", path])
            .is_ok_and(|output| output.status.success());
        if tracked {
            if let Err(err) = git_ui_text(&repo, &["restore", "--", path]) {
                return Err((StatusCode::BAD_GATEWAY, err));
            }
        } else {
            let full = Path::new(&repo).join(path);
            if full.is_dir() {
                if let Err(err) = fs::remove_dir_all(&full) {
                    return Err((StatusCode::BAD_GATEWAY, err.to_string()));
                }
            } else if full.exists() && fs::remove_file(&full).is_err() {
                return Err((
                    StatusCode::BAD_GATEWAY,
                    "failed to remove untracked file".to_string(),
                ));
            }
        }
    }
    Ok(Json(json!({ "ok": true })).into_response())
}

async fn git_ui_discard(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiPathsRequest>,
) -> Response {
    check_auth!(&state, &headers, remote);
    if !body.confirmed.unwrap_or(false) {
        return git_json_error(StatusCode::BAD_REQUEST, "discard requires confirmation");
    }
    let paths = match git_ui_paths(&body) {
        Ok(paths) => paths,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let paths = paths.into_iter().map(|p| p.to_string()).collect::<Vec<_>>();
    let cwd = body.cwd;
    match tokio::task::spawn_blocking(move || git_ui_discard_blocking(cwd, paths)).await {
        Ok(Ok(response)) => response,
        Ok(Err((status, msg))) => git_json_error(status, msg),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::branch::*;
    use super::cleanup::*;
    use super::conflict::*;
    use super::diff::*;
    use super::file::*;
    use super::log::*;
    use super::stash::*;
    use super::*;
    use crate::{AuthConfig, BackendMode, NoSleepState, RuntimeServerSettings};
    use axum::body::to_bytes;
    use serde_json::Value;
    use std::collections::HashMap;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn query() -> GitUiDiffQuery {
        GitUiDiffQuery {
            cwd: None,
            scope: None,
            file: None,
            base: None,
            target: None,
            merge_base: None,
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
            backend_mode: BackendMode::ExternalHerdr,
            _builtin_backend: None,
            builtin_sessions: Arc::new(Mutex::new(HashMap::new())),
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
                backend_mode: BackendMode::ExternalHerdr,
                builtin_shell: None,
                default_folder: std::env::temp_dir().to_string_lossy().to_string(),
                builtin_backend_enabled: true,
                external_herdr_backend_enabled: true,
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
                Query(GitUiCwdQuery {
                    cwd: Some(cwd.clone()),
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
            assert_eq!(json["ahead"], 0);
            assert_eq!(json["behind"], 0);
            assert_eq!(json["upstream"], "");

            let diff = git_ui_diff(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiDiffQuery {
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
                Query(GitUiCwdQuery {
                    cwd: Some(cwd.clone()),
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
                Query(GitUiLogQuery {
                    cwd: Some(cwd.clone()),
                    max: Some(5),
                    all: None,
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
                Query(GitUiFileQuery {
                    cwd: Some(cwd.clone()),
                    file: Some("tracked.txt".to_string()),
                    ref_name: None,
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
                Query(GitUiBlameQuery {
                    cwd: Some(cwd),
                    file: Some("tracked.txt".to_string()),
                    ref_name: None,
                }),
            )
            .await;
            assert_eq!(blame.status(), StatusCode::OK);
            let json = response_json(blame).await;
            assert!(json["text"].as_str().unwrap().contains("\tone"));
        });
    }

    #[test]
    fn git_ui_status_reports_ahead_behind_and_upstream() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let repo = TempRepo::new();
            repo.commit_initial();

            // Bare upstream + tracking config so ahead/behind are reported.
            let upstream = std::env::temp_dir().join(format!(
                "herdr-webui-git-ui-upstream-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            let work = std::env::temp_dir().join(format!(
                "herdr-webui-git-ui-work-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            repo.git(&[
                "clone",
                "--bare",
                "-q",
                repo.path.to_str().unwrap(),
                upstream.to_str().unwrap(),
            ]);
            repo.git(&["remote", "add", "origin", upstream.to_str().unwrap()]);
            repo.git(&["fetch", "-q", "origin"]);
            repo.git(&["branch", "--set-upstream-to=origin/main", "main"]);

            // One local commit ahead of upstream.
            repo.write("ahead.txt", "ahead\n");
            repo.git(&["add", "ahead.txt"]);
            repo.git(&["commit", "-qm", "local ahead"]);
            let cwd = repo.path.to_str().unwrap().to_string();
            let state = test_state();
            let status = git_ui_status(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiCwdQuery {
                    cwd: Some(cwd.clone()),
                }),
            )
            .await;
            assert_eq!(status.status(), StatusCode::OK);
            let json = response_json(status).await;
            assert_eq!(json["branch"], "main");
            assert_eq!(json["upstream"], "origin/main");
            assert_eq!(json["ahead"], 1);
            assert_eq!(json["behind"], 0);

            // Advance upstream by one commit so local also falls behind.
            Command::new("git")
                .current_dir(repo.path.as_os_str())
                .args([
                    "clone",
                    "-q",
                    upstream.to_str().unwrap(),
                    work.to_str().unwrap(),
                ])
                .output()
                .unwrap();
            Command::new("git")
                .current_dir(&work)
                .args(["checkout", "-q", "main"])
                .output()
                .unwrap();
            Command::new("git")
                .current_dir(&work)
                .args(["config", "user.email", "test@example.com"])
                .output()
                .unwrap();
            Command::new("git")
                .current_dir(&work)
                .args(["config", "user.name", "Test User"])
                .output()
                .unwrap();
            fs::write(work.join("upstream-change.txt"), "x\n").unwrap();
            Command::new("git")
                .current_dir(&work)
                .args(["add", "upstream-change.txt"])
                .output()
                .unwrap();
            Command::new("git")
                .current_dir(&work)
                .args(["commit", "-qm", "upstream ahead"])
                .output()
                .unwrap();
            Command::new("git")
                .current_dir(&work)
                .args(["push", "-q", "origin", "main"])
                .output()
                .unwrap();
            repo.git(&["fetch", "-q", "origin"]);

            let status = git_ui_status(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiCwdQuery { cwd: Some(cwd) }),
            )
            .await;
            assert_eq!(status.status(), StatusCode::OK);
            let json = response_json(status).await;
            assert_eq!(json["ahead"], 1);
            assert_eq!(json["behind"], 1);

            let _ = fs::remove_dir_all(&upstream);
            let _ = fs::remove_dir_all(&work);
        });
    }

    #[test]
    fn git_ui_status_reports_conflicts_state() {
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
            let status = git_ui_status(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiCwdQuery { cwd: Some(cwd) }),
            )
            .await;
            assert_eq!(status.status(), StatusCode::OK);
            let json = response_json(status).await;
            assert_eq!(json["state"], "conflicts");
            assert_eq!(json["conflicted"][0], "conflict.txt");
        });
    }

    #[test]
    fn git_ui_cleanup_scan_and_delete_routes_work() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let repo = TempRepo::new();
            repo.commit_initial();
            repo.git(&["branch", "cleanup/delete-me"]);
            let cwd = repo.path.to_str().unwrap().to_string();
            let state = test_state();

            let scan = git_ui_cleanup_scan(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiCleanupQuery {
                    root: Some(cwd.clone()),
                    cwd: None,
                }),
            )
            .await;
            assert_eq!(scan.status(), StatusCode::OK);
            let json = response_json(scan).await;
            assert_eq!(json["repos"][0]["path"], cwd);
            assert!(json["repos"][0]["branches"]
                .as_array()
                .unwrap()
                .iter()
                .any(|branch| branch["name"] == "cleanup/delete-me"));
            assert!(json["repos"][0]["worktrees"]
                .as_array()
                .unwrap()
                .iter()
                .any(|worktree| worktree["primary"] == true));

            let missing_confirmation = git_ui_branch_delete(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiBranchDeleteRequest {
                    cwd: cwd.clone(),
                    branch: "cleanup/delete-me".to_string(),
                    force: Some(true),
                    confirmed: None,
                }),
            )
            .await;
            assert_eq!(missing_confirmation.status(), StatusCode::BAD_REQUEST);

            let deleted = git_ui_branch_delete(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiBranchDeleteRequest {
                    cwd: cwd.clone(),
                    branch: "cleanup/delete-me".to_string(),
                    force: Some(true),
                    confirmed: Some(true),
                }),
            )
            .await;
            assert_eq!(deleted.status(), StatusCode::OK);
            assert!(!repo
                .git(&["branch", "--list", "cleanup/delete-me"])
                .contains("cleanup/delete-me"));

            let worktree_path = repo.path.parent().unwrap().join(format!(
                "{}-worktree",
                repo.path.file_name().unwrap().to_string_lossy()
            ));
            let worktree_path_text = worktree_path.to_string_lossy().to_string();
            repo.git(&[
                "worktree",
                "add",
                "-b",
                "cleanup/wt",
                &worktree_path_text,
                "main",
            ]);

            let removed_worktree = git_ui_worktree_remove(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiWorktreeRemoveRequest {
                    cwd: cwd.clone(),
                    path: worktree_path_text.clone(),
                    force: Some(false),
                    confirmed: Some(true),
                }),
            )
            .await;
            assert_eq!(removed_worktree.status(), StatusCode::OK);
            assert!(!worktree_path.exists());

            let protected = git_ui_worktree_remove(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiWorktreeRemoveRequest {
                    cwd,
                    path: repo.path.to_string_lossy().to_string(),
                    force: Some(true),
                    confirmed: Some(true),
                }),
            )
            .await;
            assert_eq!(protected.status(), StatusCode::BAD_REQUEST);
        });
    }

    #[cfg(unix)]
    #[test]
    fn git_cleanup_scan_does_not_follow_symlinked_directories() {
        let root = TempRepo::new();
        root.commit_initial();
        let outside = TempRepo::new();
        outside.commit_initial();
        std::os::unix::fs::symlink(&outside.path, root.path.join("linked-outside")).unwrap();

        let (repos, truncated) = git_cleanup_scan(root.path.to_str().unwrap()).unwrap();
        assert!(!truncated);
        assert_eq!(repos.len(), 1);
        assert_eq!(repos[0].path, root.path.to_string_lossy());
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
                Json(GitUiStashPushRequest {
                    cwd: cwd.clone(),
                    message: Some("save new".to_string()),
                    paths: Some(vec!["new.txt".to_string()]),
                }),
            )
            .await;
            assert_eq!(stash.status(), StatusCode::OK);
            assert!(!repo.path.join("new.txt").exists());

            let stashes = git_ui_stashes(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiCwdQuery {
                    cwd: Some(cwd.clone()),
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
                Json(GitUiStashApplyRequest {
                    cwd: cwd.clone(),
                    stash: Some("stash@{0}".to_string()),
                    pop: None,
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

            let head = repo.git(&["rev-parse", "HEAD"]).trim().to_string();
            let tag = git_ui_tag(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiTagRequest {
                    cwd: cwd.clone(),
                    tag_name: "ui-test-tag".to_string(),
                    ref_name: head.clone(),
                }),
            )
            .await;
            assert_eq!(tag.status(), StatusCode::OK);
            assert_eq!(repo.git(&["rev-parse", "ui-test-tag"]).trim(), head);

            let unsafe_tag = git_ui_tag(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiTagRequest {
                    cwd: cwd.clone(),
                    tag_name: "bad tag".to_string(),
                    ref_name: "HEAD".to_string(),
                }),
            )
            .await;
            assert_eq!(unsafe_tag.status(), StatusCode::BAD_REQUEST);

            let compare = git_ui_compare(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Query(GitUiDiffQuery {
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
                Query(GitUiFileQuery {
                    cwd: Some(cwd.clone()),
                    file: Some("tracked.txt".to_string()),
                    ref_name: None,
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
                Query(GitUiFileHistoryQuery {
                    cwd: Some(cwd.clone()),
                    file: Some("tracked.txt".to_string()),
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
                Json(GitUiStashPushRequest {
                    cwd: cwd.clone(),
                    message: None,
                    paths: None,
                }),
            )
            .await;
            assert_eq!(stash.status(), StatusCode::OK);

            let pop = git_ui_stash_apply(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiStashApplyRequest {
                    cwd: cwd.clone(),
                    stash: Some("stash@{0}".to_string()),
                    pop: Some(true),
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
                Json(GitUiStashPushRequest {
                    cwd: cwd.clone(),
                    message: Some("drop me".to_string()),
                    paths: Some(vec!["drop.txt".to_string()]),
                }),
            )
            .await;
            assert_eq!(stash.status(), StatusCode::OK);

            let drop_without_confirm = git_ui_stash_drop(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiStashDropRequest {
                    cwd: cwd.clone(),
                    stash: Some("stash@{0}".to_string()),
                    confirmed: None,
                }),
            )
            .await;
            assert_eq!(drop_without_confirm.status(), StatusCode::BAD_REQUEST);

            let drop = git_ui_stash_drop(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiStashDropRequest {
                    cwd,
                    stash: Some("stash@{0}".to_string()),
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
                Query(GitUiCwdQuery {
                    cwd: Some(cwd.clone()),
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

    #[test]
    fn discover_git_repos_dedupes_worktrees_to_base_repo() {
        let scan_root = std::env::temp_dir().join(format!(
            "herdr-test-dedup-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&scan_root).unwrap();
        let base_path = scan_root.join("base");
        fs::create_dir_all(&base_path).unwrap();
        Command::new("git")
            .current_dir(&base_path)
            .args(["init"])
            .output()
            .unwrap();
        Command::new("git")
            .current_dir(&base_path)
            .args(["checkout", "-b", "main"])
            .output()
            .unwrap();
        Command::new("git")
            .current_dir(&base_path)
            .args(["config", "user.email", "test@example.com"])
            .output()
            .unwrap();
        Command::new("git")
            .current_dir(&base_path)
            .args(["config", "user.name", "Test"])
            .output()
            .unwrap();
        fs::write(base_path.join("file.txt"), "content\n").unwrap();
        Command::new("git")
            .current_dir(&base_path)
            .args(["add", "."])
            .output()
            .unwrap();
        Command::new("git")
            .current_dir(&base_path)
            .args(["commit", "-m", "init"])
            .output()
            .unwrap();
        let worktree_dir = scan_root.join("worktrees").join("feature");
        fs::create_dir_all(scan_root.join("worktrees")).unwrap();
        Command::new("git")
            .current_dir(&base_path)
            .args([
                "worktree",
                "add",
                "-b",
                "feature",
                worktree_dir.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        let (repos, truncated) = discover_git_repos(&scan_root).unwrap();
        assert!(!truncated);
        let repo_paths: Vec<String> = repos
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        let base_canonical = fs::canonicalize(&base_path).unwrap();
        let count = repo_paths
            .iter()
            .filter(|p| {
                let canon = fs::canonicalize(p).unwrap_or_else(|_| PathBuf::from(p));
                canon == base_canonical
            })
            .count();
        assert_eq!(
            count, 1,
            "base repo should appear exactly once, got: {repo_paths:?}"
        );
        let wt_canonical = fs::canonicalize(&worktree_dir).unwrap();
        let wt_str = wt_canonical.to_string_lossy().to_string();
        assert!(
            !repo_paths.iter().any(|p| **p == wt_str),
            "worktree should not appear as separate repo, got: {repo_paths:?}"
        );
        let _ = fs::remove_dir_all(&scan_root);
    }

    #[test]
    fn resolve_worktree_base_finds_base_repo_from_git_file() {
        let base = TempRepo::new();
        base.commit_initial();
        let worktree_dir = base.path.parent().unwrap().join(format!(
            "wt-r-{}",
            base.path.file_name().unwrap().to_string_lossy()
        ));
        Command::new("git")
            .current_dir(&base.path)
            .args([
                "worktree",
                "add",
                "-b",
                "dev",
                worktree_dir.to_str().unwrap(),
            ])
            .output()
            .unwrap();
        let git_file = worktree_dir.join(".git");
        assert!(git_file.is_file());
        let resolved = resolve_worktree_base(&git_file).unwrap();
        let expected = fs::canonicalize(&base.path).unwrap();
        let got = fs::canonicalize(&resolved).unwrap();
        assert_eq!(got, expected);
    }

    #[test]
    fn discover_git_repos_skips_node_modules() {
        let base = TempRepo::new();
        base.commit_initial();
        let nm = base.path.join("node_modules");
        fs::create_dir_all(&nm).unwrap();
        let nested = nm.join("some-package");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(nested.join(".git")).unwrap();
        let (repos, _) = discover_git_repos(&base.path).unwrap();
        let paths: Vec<String> = repos
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        assert!(
            !paths.iter().any(|p| p.contains("node_modules")),
            "should skip node_modules, got: {paths:?}"
        );
    }

    #[test]
    fn git_ui_worktree_prune_dry_run_actual_and_invalid_expire() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let repo = TempRepo::new();
            repo.commit_initial();
            let worktree_dir = repo.path.parent().unwrap().join(format!(
                "{}-prunable-wt",
                repo.path.file_name().unwrap().to_string_lossy()
            ));
            let worktree_dir_text = worktree_dir.to_string_lossy().to_string();
            repo.git(&[
                "worktree",
                "add",
                "-b",
                "cleanup/prunable",
                &worktree_dir_text,
                "main",
            ]);
            fs::remove_dir_all(&worktree_dir).unwrap();

            let cwd = repo.path.to_str().unwrap().to_string();
            let state = test_state();

            let dry_run = git_ui_worktree_prune(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiWorktreePruneRequest {
                    cwd: cwd.clone(),
                    dry_run: Some(true),
                    expire: None,
                }),
            )
            .await;
            assert_eq!(dry_run.status(), StatusCode::OK);

            let prune = git_ui_worktree_prune(
                State(state.clone()),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiWorktreePruneRequest {
                    cwd: cwd.clone(),
                    dry_run: None,
                    expire: None,
                }),
            )
            .await;
            assert_eq!(prune.status(), StatusCode::OK);

            let invalid = git_ui_worktree_prune(
                State(state),
                HeaderMap::new(),
                ConnectInfo(remote()),
                Json(GitUiWorktreePruneRequest {
                    cwd,
                    dry_run: None,
                    expire: Some("-1hour".to_string()),
                }),
            )
            .await;
            assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        });
    }
}
