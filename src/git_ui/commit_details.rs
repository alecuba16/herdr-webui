use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use serde::Deserialize;
use serde_json::{json, Value};

use super::{
    check_auth, git_json_error, git_origin_or_upstream_remote, git_spawn, git_ui_text,
    normalize_git_remote_url,
};
use crate::{require_auth, WebState};

#[derive(Deserialize)]
pub(super) struct CommitDetailsQuery {
    cwd: Option<String>,
    hash: Option<String>,
}

fn validate_commit_hash(hash: &str) -> Result<&str, String> {
    if !matches!(hash.len(), 40 | 64) || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("a full commit hash is required".to_string());
    }
    Ok(hash)
}

fn commit_web_url(remote: &str, hash: &str) -> Option<String> {
    let base = normalize_git_remote_url(remote)?;
    let uri: Uri = base.parse().ok()?;
    if uri.query().is_some() || uri.path().trim_matches('/').is_empty() {
        return None;
    }
    let suffix = match uri.authority()?.host().to_ascii_lowercase().as_str() {
        "github.com" => "commit",
        "bitbucket.org" => "commits",
        "gitlab.com" => "-/commit",
        _ => return None,
    };
    Some(format!("{base}/{suffix}/{hash}"))
}

fn commit_details(cwd: &str, hash: &str) -> Result<Value, (StatusCode, String)> {
    let hash = validate_commit_hash(hash).map_err(|err| (StatusCode::BAD_REQUEST, err))?;
    let text = git_ui_text(
        cwd,
        &[
            "show",
            "--no-patch",
            "--no-color",
            "--no-show-signature",
            "--no-notes",
            "--format=%H%x00%an%x00%ae%x00%aI%x00%P%x00%B",
            hash,
            "--",
        ],
    )
    .map_err(|err| (StatusCode::BAD_GATEWAY, err))?;
    let fields = text.splitn(6, '\0').collect::<Vec<_>>();
    if fields.len() != 6 {
        return Err((
            StatusCode::BAD_GATEWAY,
            "git returned incomplete commit metadata".to_string(),
        ));
    }
    let web_url = git_origin_or_upstream_remote(cwd)
        .ok()
        .and_then(|remote| commit_web_url(&remote, fields[0]));
    Ok(json!({
        "hash": fields[0],
        "author": fields[1],
        "email": fields[2],
        "date": fields[3],
        "message": fields[5].trim_end_matches('\n'),
        "parents": fields[4].split_whitespace().collect::<Vec<_>>(),
        "web_url": web_url,
    }))
}

pub(super) async fn git_ui_commit_details(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<CommitDetailsQuery>,
) -> Response {
    check_auth!(&state, &headers, remote);
    let (Some(cwd), Some(hash)) = (query.cwd, query.hash) else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd and hash are required");
    };
    git_spawn(move || commit_details(&cwd, &hash)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn git(repo: &Path, args: &[&str]) -> String {
        let output = crate::git_bin::command()
            .arg("-C")
            .arg(repo)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn rejects_non_commit_hash_arguments() {
        for hash in ["", "HEAD", "--all", "abc", "HEAD:file", &"g".repeat(40)] {
            assert!(validate_commit_hash(hash).is_err(), "accepted {hash}");
        }
        assert!(validate_commit_hash(&"a".repeat(40)).is_ok());
        assert!(validate_commit_hash(&"A".repeat(64)).is_ok());
    }

    #[test]
    fn builds_links_only_for_supported_remote_hosts() {
        let hash = "a".repeat(40);
        for (remote, expected) in [
            (
                "git@github.com:owner/repo.git",
                format!("https://github.com/owner/repo/commit/{hash}"),
            ),
            (
                "ssh://git@bitbucket.org/owner/repo.git",
                format!("https://bitbucket.org/owner/repo/commits/{hash}"),
            ),
            (
                "https://token@gitlab.com/team/repo.git",
                format!("https://gitlab.com/team/repo/-/commit/{hash}"),
            ),
        ] {
            assert_eq!(commit_web_url(remote, &hash), Some(expected));
        }
        for remote in [
            "/tmp/local.git",
            "https://github.com.evil.invalid/owner/repo",
            "https://example.com/github.com/repo",
            "https://github.com/owner/repo?next=elsewhere",
            "javascript:alert(1)",
        ] {
            assert_eq!(commit_web_url(remote, &hash), None, "accepted {remote}");
        }
    }

    #[test]
    fn reads_root_and_parent_metadata_without_network_requests() {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let repo = std::env::temp_dir().join(format!("herdr-commit-details-{stamp}"));
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init"]);
        git(&repo, &["config", "user.name", "Herdr Test"]);
        git(
            &repo,
            &["config", "user.email", "herdr-test@example.invalid"],
        );
        git(
            &repo,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "Subject <&>\n\nFirst body line\nSecond body line",
            ],
        );
        let root = git(&repo, &["rev-parse", "HEAD"]);
        let cwd = repo.to_str().unwrap();
        let details = commit_details(cwd, &root).unwrap();
        assert_eq!(details["hash"], root);
        assert_eq!(details["author"], "Herdr Test");
        assert_eq!(details["email"], "herdr-test@example.invalid");
        assert_eq!(
            details["message"],
            "Subject <&>\n\nFirst body line\nSecond body line"
        );
        assert_eq!(details["parents"], json!([]));
        assert!(details["web_url"].is_null());
        assert!(!details["date"].as_str().unwrap().is_empty());
        git(
            &repo,
            &["remote", "add", "origin", "git@github.com:owner/repo.git"],
        );
        git(
            &repo,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-m",
                "Second",
            ],
        );
        let next = git(&repo, &["rev-parse", "HEAD"]);
        let details = commit_details(cwd, &next).unwrap();
        assert_eq!(details["parents"], json!([root]));
        assert_eq!(
            details["web_url"],
            format!("https://github.com/owner/repo/commit/{next}")
        );
        assert!(commit_details(cwd, &"f".repeat(40)).is_err());
        std::fs::remove_dir_all(repo).unwrap();
    }
}
