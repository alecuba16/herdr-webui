use std::fs;
use std::net::SocketAddr;
use std::path::Path;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::check_auth;
use super::git_spawn;
use super::{git_json_error, git_ui_repo, git_ui_text, safe_git_token, safe_repo_path};
// blame parsing lives in the lib crate (shared with the TUI); the bin
// reaches it through the herdr_webui dependency.
use crate::{git_failure, require_auth, WebState};
use herdr_webui::blame::parse_blame_authors;

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

pub(super) fn git_ui_blame_blocking(
    cwd: String,
    file: String,
    ref_name: String,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let args = git_blame_args(&file, &ref_name);
    match git_ui_text(&cwd, &args) {
        // `text` stays the raw --line-porcelain stream (payload
        // compatibility); `authors` is the parsed final-line → author map
        // built by the same shared parser the TUI uses (crate::blame),
        // so the JS client no longer parses porcelain in the browser.
        Ok(text) => {
            let authors = parse_blame_authors(&text);
            let authors = serde_json::Map::from_iter(
                authors
                    .into_iter()
                    .map(|(line, author)| (line.to_string(), serde_json::Value::String(author))),
            );
            Ok(json!({ "text": text, "authors": authors }))
        }
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

fn git_blame_args<'a>(file: &'a str, ref_name: &'a str) -> Vec<&'a str> {
    if ref_name == "working" {
        vec!["blame", "--line-porcelain", "--contents", file, "--", file]
    } else {
        vec!["blame", "--line-porcelain", ref_name, "--", file]
    }
}

pub(super) async fn git_ui_blame(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiBlameQuery>,
) -> Response {
    check_auth!(&state, &headers, remote);
    let (Some(cwd), Some(file)) = (query.cwd.as_deref(), query.file.as_deref()) else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd and file are required");
    };
    let file = match safe_repo_path(file) {
        Ok(file) => file,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let ref_name = match safe_git_token(query.ref_name.as_deref().unwrap_or("working"), "ref") {
        Ok(v) => v,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let cwd = cwd.to_string();
    let file = file.to_string();
    let ref_name = ref_name.to_string();
    git_spawn(move || git_ui_blame_blocking(cwd, file, ref_name)).await
}

fn git_ui_working_file_hash(repo: &str, path: &str) -> Result<String, String> {
    let full = Path::new(repo).join(path);
    if !full.exists() {
        return Ok(String::new());
    }
    let output = crate::git_bin::command()
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

pub(super) fn git_ui_file_blocking(
    cwd: String,
    file: String,
    ref_name: Option<String>,
) -> Result<serde_json::Value, (StatusCode, String)> {
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
        return Ok(json!({ "path": file, "content": content, "hash": hash }));
    }
    let ref_name = match safe_git_token(ref_name, "ref") {
        Ok(v) => v,
        Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
    };
    let spec = format!("{ref_name}:{file}");
    match git_ui_text(&repo, &["show", &spec]) {
        Ok(content) => Ok(json!({ "path": file, "content": content, "hash": "" })),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_file(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiFileQuery>,
) -> Response {
    check_auth!(&state, &headers, remote);
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
    git_spawn(move || git_ui_file_blocking(cwd, file, ref_name)).await
}

pub(super) fn git_ui_write_file_blocking(
    cwd: String,
    path: String,
    content: String,
    expected_hash: Option<String>,
) -> Result<serde_json::Value, (StatusCode, String)> {
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
    Ok(json!({ "ok": true, "path": path, "hash": hash }))
}

pub(super) async fn git_ui_write_file(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiWriteFileRequest>,
) -> Response {
    check_auth!(&state, &headers, remote);
    let path = match safe_repo_path(&body.path) {
        Ok(path) => path,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let path = path.to_string();
    let cwd = body.cwd;
    let content = body.content;
    let expected_hash = body.expected_hash;
    git_spawn(move || git_ui_write_file_blocking(cwd, path, content, expected_hash)).await
}

pub(super) fn git_ui_file_history_blocking(
    cwd: String,
    file: String,
) -> Result<serde_json::Value, (StatusCode, String)> {
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
            Ok(json!({ "commits": commits }))
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
    check_auth!(&state, &headers, remote);
    let (Some(cwd), Some(file)) = (query.cwd.as_deref(), query.file.as_deref()) else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd and file are required");
    };
    let file = match safe_repo_path(file) {
        Ok(file) => file,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let cwd = cwd.to_string();
    let file = file.to_string();
    git_spawn(move || git_ui_file_history_blocking(cwd, file)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blame_uses_working_tree_contents_by_default() {
        assert_eq!(
            git_blame_args("src/main.rs", "working"),
            vec![
                "blame",
                "--line-porcelain",
                "--contents",
                "src/main.rs",
                "--",
                "src/main.rs"
            ]
        );
        assert_eq!(
            git_blame_args("src/main.rs", "HEAD"),
            vec!["blame", "--line-porcelain", "HEAD", "--", "src/main.rs"]
        );
    }

    fn temp_repo(label: &str) -> std::path::PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let repo = std::env::temp_dir().join(format!("herdr-file-{label}-{stamp}"));
        std::fs::create_dir_all(&repo).unwrap();
        let git = |args: &[&str]| {
            let output = crate::git_bin::command()
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        };
        git(&["init"]);
        git(&["config", "user.name", "Herdr Test"]);
        git(&["config", "user.email", "herdr-test@example.invalid"]);
        repo
    }

    #[test]
    fn working_file_read_errors_surface_as_bad_gateway() {
        let repo = temp_repo("readerr");
        let cwd = repo.to_string_lossy().to_string();
        // A directory named like the file makes read_to_string fail while
        // the existence check passes: the content error arm.
        std::fs::create_dir_all(repo.join("dirfile")).unwrap();
        let (status, _) = git_ui_file_blocking(cwd, "dirfile".to_string(), None).unwrap_err();
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn invalid_ref_tokens_are_rejected_as_bad_request() {
        let repo = temp_repo("badtoken");
        let cwd = repo.to_string_lossy().to_string();
        // Tokens starting with '-' are rejected before git runs.
        let (status, _) =
            git_ui_file_blocking(cwd, "a.txt".to_string(), Some("--evil".to_string())).unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // A valid token on a repo without that file: git show fails, the
        // caller sees BAD_GATEWAY.
        let repo2 = temp_repo("badtoken2");
        let cwd2 = repo2.to_string_lossy().to_string();
        let (status2, _) =
            git_ui_file_blocking(cwd2, "a.txt".to_string(), Some("HEAD".to_string())).unwrap_err();
        assert_eq!(
            status2,
            StatusCode::BAD_GATEWAY,
            "valid token, missing file fails via git"
        );
        std::fs::remove_dir_all(repo).unwrap();
        std::fs::remove_dir_all(repo2).unwrap();
    }

    #[test]
    fn write_file_conflict_and_directory_paths_are_rejected() {
        let repo = temp_repo("write");
        let cwd = repo.to_string_lossy().to_string();
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        // Stale expected hash: CONFLICT without touching disk.
        let (status, _) = git_ui_write_file_blocking(
            cwd.clone(),
            "a.txt".to_string(),
            "two\n".to_string(),
            Some("0".repeat(40)),
        )
        .unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(
            std::fs::read_to_string(repo.join("a.txt")).unwrap(),
            "one\n"
        );
        // Directory target: hash-object on it fails first, surfacing
        // BAD_GATEWAY before the is_dir guard runs.
        std::fs::create_dir_all(repo.join("sub")).unwrap();
        let (status2, _) =
            git_ui_write_file_blocking(cwd.clone(), "sub".to_string(), "x".to_string(), None)
                .unwrap_err();
        // hash-object on a directory fails first, surfacing BAD_GATEWAY
        // before the is_dir guard; that error path is the real behavior.
        assert_eq!(status2, StatusCode::BAD_GATEWAY);
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn write_file_creates_parent_directories_and_reports_hash() {
        let repo = temp_repo("writeok");
        let cwd = repo.to_string_lossy().to_string();
        let out = git_ui_write_file_blocking(
            cwd,
            "nested/dir/b.txt".to_string(),
            "body\n".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(out["ok"], serde_json::json!(true));
        assert!(out["hash"].as_str().unwrap().len() >= 40);
        assert_eq!(
            std::fs::read_to_string(repo.join("nested/dir/b.txt")).unwrap(),
            "body\n"
        );
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn file_history_lists_commits_and_fails_gracefully_off_repo() {
        let repo = temp_repo("history");
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        let git = |args: &[&str]| {
            let output = crate::git_bin::command()
                .arg("-C")
                .arg(&repo)
                .args(args)
                .output()
                .unwrap();
            assert!(output.status.success());
        };
        git(&["add", "a.txt"]);
        git(&["-c", "commit.gpgsign=false", "commit", "-m", "first"]);
        let out =
            git_ui_file_history_blocking(repo.to_string_lossy().to_string(), "a.txt".to_string())
                .unwrap();
        let commits = out["commits"].as_array().unwrap();
        assert_eq!(commits.len(), 1);
        assert_eq!(commits[0]["message"], serde_json::json!("first"));
        let (status, _) = git_ui_file_history_blocking(
            "/nonexistent-repo-dir-for-herdr".to_string(),
            "a.txt".to_string(),
        )
        .unwrap_err();
        assert_eq!(status, StatusCode::BAD_GATEWAY);
        std::fs::remove_dir_all(repo).unwrap();
    }

    #[test]
    fn working_hash_of_missing_file_is_empty() {
        let repo = temp_repo("hashmissing");
        let hash =
            git_ui_working_file_hash(repo.to_string_lossy().to_string().as_str(), "gone.txt")
                .unwrap();
        assert_eq!(hash, "");
        std::fs::remove_dir_all(repo).unwrap();
    }
}
