use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{require_auth, WebState};
use super::{git_json_error, git_ui_text_strings, safe_repo_path, safe_git_token};

#[derive(Deserialize)]
pub(super) struct GitUiDiffQuery {
    pub(super) cwd: Option<String>,
    pub(super) scope: Option<String>,
    pub(super) file: Option<String>,
    pub(super) base: Option<String>,
    pub(super) target: Option<String>,
    pub(super) merge_base: Option<bool>,
    pub(super) context: Option<usize>,
}

#[derive(Serialize)]
pub(super) struct GitDiffLine {
    pub(super) line_type: String,
    content: String,
    old_line_number: Option<usize>,
    new_line_number: Option<usize>,
}

#[derive(Serialize)]
pub(super) struct GitDiffChunk {
    header: String,
    old_start: usize,
    old_lines: usize,
    new_start: usize,
    new_lines: usize,
    pub(super) lines: Vec<GitDiffLine>,
}

#[derive(Serialize)]
pub(super) struct GitDiffFile {
    pub(super) path: String,
    pub(super) old_path: Option<String>,
    pub(super) status: String,
    pub(super) additions: usize,
    pub(super) deletions: usize,
    pub(super) chunks: Vec<GitDiffChunk>,
}

#[derive(Serialize)]
struct GitFileSummary {
    additions: Option<usize>,
    deletions: Option<usize>,
}pub(super) fn parse_diff_path(raw: &str) -> Option<String> {
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

pub(super) fn parse_unified_diff(text: &str) -> Vec<GitDiffFile> {
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

pub(super) fn parse_numstat(text: &str) -> serde_json::Map<String, serde_json::Value> {
    let mut summaries = serde_json::Map::new();
    for line in text.lines() {
        let mut parts = line.splitn(3, '\t');
        let additions = parts.next().and_then(|value| value.parse::<usize>().ok());
        let deletions = parts.next().and_then(|value| value.parse::<usize>().ok());
        let Some(path) = parts.next() else { continue };
        summaries.insert(
            path.to_string(),
            json!(GitFileSummary {
                additions,
                deletions,
            }),
        );
    }
    summaries
}

pub(super) fn git_ui_diff_args(query: &GitUiDiffQuery, compare: bool) -> Result<Vec<String>, String> {
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

async fn git_ui_diff_common(query: GitUiDiffQuery, compare: bool) -> Response {
    let Some(cwd) = query.cwd.as_deref() else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    let args = match git_ui_diff_args(&query, compare) {
        Ok(args) => args,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let cwd = cwd.to_string();
    match tokio::task::spawn_blocking(move || git_ui_text_strings(&cwd, &args)).await {
        Ok(Ok(text)) => Json(json!({ "files": parse_unified_diff(&text) })).into_response(),
        Ok(Err(err)) => git_json_error(StatusCode::BAD_GATEWAY, err),
        Err(err) => git_json_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string()),
    }
}

pub(super) async fn git_ui_diff(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiDiffQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    git_ui_diff_common(query, false).await
}

pub(super) async fn git_ui_compare(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitUiDiffQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    git_ui_diff_common(query, true).await
}
