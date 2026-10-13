use std::io::Write;
use std::net::SocketAddr;
use std::process::{Command, Stdio};

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use super::diff::{git_ui_diff_args, GitUiDiffQuery};
use super::log_graph::{parse_log_row_json, reconstruct_log_line, LOG_FORMAT};
use super::{
    check_auth, git_json_error, git_spawn, git_ui_output, git_ui_repo, git_ui_text,
    git_ui_text_strings, safe_git_token, safe_repo_path,
};
use crate::{git_failure, require_auth, WebState};

#[derive(Deserialize)]
pub(super) struct GitUiLogQuery {
    pub(super) cwd: Option<String>,
    pub(super) max: Option<usize>,
    pub(super) all: Option<bool>,
    pub(super) scope: Option<String>,
    pub(super) base: Option<String>,
    pub(super) file: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum GitLogScope {
    All,
    BaseCurrent,
    Base,
}

impl GitLogScope {
    fn from_query(scope: Option<String>, all: bool) -> Result<Self, String> {
        match scope
            .as_deref()
            .unwrap_or(if all { "all" } else { "base-current" })
        {
            "all" => Ok(Self::All),
            "base-current" => Ok(Self::BaseCurrent),
            "base" => Ok(Self::Base),
            other => Err(format!("unsupported git log scope: {other}")),
        }
    }

    fn includes_all(self) -> bool {
        matches!(self, Self::All)
    }

    fn includes_current(self) -> bool {
        matches!(self, Self::BaseCurrent)
    }
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
    pub(super) cwd: String,
    pub(super) upstream: String,
    pub(super) onto: Option<String>,
    pub(super) pull_first: Option<bool>,
    pub(super) confirmation: Option<String>,
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
    pub(super) patch: Option<String>,
    pub(super) reverse: Option<bool>,
    pub(super) cached: Option<bool>,
    // Chunk-based body: regenerate the patch server-side from the same
    // diff args the client rendered, so what gets applied is
    // bit-identical to what the user clicked on.
    pub(super) scope: Option<String>,
    pub(super) context: Option<usize>,
    pub(super) base: Option<String>,
    pub(super) target: Option<String>,
    pub(super) file: Option<String>,
    pub(super) chunk_index: Option<usize>,
    pub(super) merge_base: Option<bool>,
}

fn git_log_args(
    max: usize,
    all: bool,
    refs: &[String],
    file: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut args = vec![
        "log".to_string(),
        "--graph".to_string(),
        "--decorate".to_string(),
        "--date=relative".to_string(),
        "--max-count".to_string(),
        max.to_string(),
        format!("--format={LOG_FORMAT}"),
    ];
    if file.is_some() {
        args.push("--follow".to_string());
    }
    args.extend(refs.iter().cloned());
    if all {
        args.push("--all".to_string());
    }
    if let Some(file) = file {
        args.push("--".to_string());
        args.push(safe_repo_path(file)?.to_string());
    }
    Ok(args)
}

fn log_refs(
    cwd: &str,
    scope: GitLogScope,
    base: Option<String>,
) -> Result<Vec<String>, (StatusCode, String)> {
    let mut refs = Vec::new();
    if let Some(base) = default_log_base(base) {
        let base = safe_git_token(&base, "log base branch")
            .map_err(|err| (StatusCode::BAD_REQUEST, err))?
            .to_string();
        if git_ref_exists(cwd, &base) {
            refs.push(base);
        }
    }
    if scope.includes_current() {
        refs.push("HEAD".to_string());
    }
    Ok(refs)
}

fn default_log_base(base: Option<String>) -> Option<String> {
    let branch = base.unwrap_or_else(|| "master".to_string());
    let branch = branch.trim();
    if branch.is_empty() {
        None
    } else {
        Some(branch.to_string())
    }
}

fn git_ref_exists(cwd: &str, ref_name: &str) -> bool {
    let spec = format!("{ref_name}^{{commit}}");
    git_ui_output(cwd, &["rev-parse", "--verify", "--quiet", &spec])
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn parsed_log_rows(lines: &[String]) -> Vec<serde_json::Value> {
    lines
        .iter()
        .filter_map(|line| parse_log_row_json(line))
        .collect::<Vec<_>>()
}

fn count_commit_rows(rows: &[serde_json::Value]) -> usize {
    rows.iter()
        .filter(|row| row["hash"].as_str().is_some_and(|hash| !hash.is_empty()))
        .count()
}

fn trim_log_lines_to_commit_limit(lines: Vec<String>, limit: usize) -> Vec<String> {
    let mut commits = 0usize;
    let mut trimmed = Vec::new();
    for line in lines {
        let is_commit = parse_log_row_json(&line)
            .and_then(|row| row["hash"].as_str().map(|hash| !hash.is_empty()))
            .unwrap_or(false);
        if is_commit {
            commits += 1;
            if commits > limit {
                break;
            }
        }
        trimmed.push(line);
    }
    trimmed
}

pub(super) fn git_ui_log_blocking(
    cwd: String,
    limit: usize,
    scope: GitLogScope,
    base: Option<String>,
    file: Option<String>,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let refs = log_refs(&cwd, scope, base)?;
    let query_limit = limit.saturating_add(1);
    let args = git_log_args(query_limit, scope.includes_all(), &refs, file.as_deref())
        .map_err(|err| (StatusCode::BAD_REQUEST, err))?;
    match git_ui_text_strings(&cwd, &args) {
        Ok(text) => {
            let raw_lines = text.lines().map(ToOwned::to_owned).collect::<Vec<_>>();
            let raw_rows = parsed_log_rows(&raw_lines);
            let has_more = count_commit_rows(&raw_rows) > limit;
            let lines = if has_more {
                trim_log_lines_to_commit_limit(raw_lines, limit)
            } else {
                raw_lines
            };
            let rows = parsed_log_rows(&lines);
            let commits = rows
                .iter()
                .filter(|row| row["hash"].as_str().is_some_and(|hash| !hash.is_empty()))
                .map(|row| {
                    json!({
                        "hash": row["hash"],
                        "author": row["author"],
                        "date": row["date"],
                        "message": row["title"],
                        "exact_date": row["exact_date"],
                        "labels": row["labels"],
                    })
                })
                .collect::<Vec<_>>();
            let display_lines = lines
                .iter()
                .map(|line| reconstruct_log_line(line))
                .collect::<Vec<_>>();
            Ok(json!({
                "commits": commits,
                "lines": display_lines,
                "rows": rows,
                "has_more": has_more,
                "limit": limit,
            }))
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
    check_auth!(&state, &headers, remote);
    let Some(cwd) = query.cwd.as_deref() else {
        return git_json_error(StatusCode::BAD_REQUEST, "cwd is required");
    };
    let limit = query.max.unwrap_or(80).clamp(1, 2000);
    let all = query.all.unwrap_or(false);
    let scope = match GitLogScope::from_query(query.scope, all) {
        Ok(scope) => scope,
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let base = query.base;
    let file = query.file;
    let cwd = cwd.to_string();
    git_spawn(move || git_ui_log_blocking(cwd, limit, scope, base, file)).await
}

pub(super) fn git_ui_reset_blocking(
    cwd: String,
    mode: String,
    ref_name: String,
) -> Result<serde_json::Value, (StatusCode, String)> {
    match git_ui_text(&cwd, &["reset", &mode, &ref_name]) {
        Ok(text) => Ok(json!({ "ok": true, "message": text })),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_reset(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiResetRequest>,
) -> Response {
    check_auth!(&state, &headers, remote);
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
    git_spawn(move || git_ui_reset_blocking(cwd, mode, ref_name)).await
}

fn git_ui_default_base_ref(cwd: &str) -> Result<String, String> {
    for candidate in ["main", "master"] {
        if git_ui_text(cwd, &["rev-parse", "--verify", candidate]).is_ok() {
            return Ok(candidate.to_string());
        }
    }
    Err("could not find main or master ref".to_string())
}

fn fetch_branch_name(ref_name: &str) -> &str {
    ref_name.strip_prefix("origin/").unwrap_or(ref_name)
}

fn fetched_rebase_ref(ref_name: &str) -> String {
    if ref_name.starts_with("origin/") || ref_name.starts_with("refs/") {
        ref_name.to_string()
    } else {
        format!("origin/{ref_name}")
    }
}

/// Fetches the repo's default base branch (main or master, whichever
/// exists as a remote-tracking ref) unless it was already fetched as the
/// selected branch. Repos with neither are left untouched.
fn fetch_default_base(cwd: &str) -> Result<(), (StatusCode, String)> {
    for base in ["main", "master"] {
        if git_ui_text(cwd, &["rev-parse", "--verify", &format!("origin/{base}")]).is_err() {
            continue; // no such remote-tracking ref; try the next candidate
        }
        return git_ui_text(cwd, &["fetch", "origin", base])
            .map(|_| ())
            .map_err(|err| {
                (
                    StatusCode::BAD_GATEWAY,
                    format!("fetch {base} failed:\n{err}"),
                )
            });
    }
    Ok(())
}

pub(super) fn git_ui_rebase_blocking(
    cwd: String,
    upstream: String,
    onto: Option<String>,
    pull_first: bool,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let onto = match onto {
        Some(value) => value,
        None => match git_ui_default_base_ref(&cwd) {
            Ok(value) => value,
            Err(err) => return Err((StatusCode::BAD_REQUEST, err)),
        },
    };
    // GitHub-flow rebase: when fetching, always refresh main/master too so
    // the default base is never stale, and rebase onto the remote-tracking
    // ref of the selected branch. Without fetching, keep the caller's ref
    // exactly as given (local branch name or explicit origin/ ref).
    let rebase_onto = if pull_first {
        let fetch_branch = fetch_branch_name(&onto).to_string();
        git_ui_text(&cwd, &["fetch", "origin", &fetch_branch]).map_err(|err| {
            (
                StatusCode::BAD_GATEWAY,
                format!("fetch selected branch failed:\n{err}"),
            )
        })?;
        // GitHub-flow rebase: keep the default base fresh too. When the
        // caller rebases onto something other than main/master, fetch the
        // repo's default branch as well so the next "rebase onto main" is
        // not based on a stale ref.
        fetch_default_base(&cwd)?;
        fetched_rebase_ref(&onto)
    } else {
        onto.clone()
    };
    match git_ui_text(&cwd, &["rebase", "--onto", &rebase_onto, &upstream]) {
        Ok(text) => Ok(json!({ "ok": true, "message": text, "onto": rebase_onto })),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_rebase(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiRebaseRequest>,
) -> Response {
    check_auth!(&state, &headers, remote);
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
    let pull_first = body.pull_first.unwrap_or(false);
    git_spawn(move || git_ui_rebase_blocking(cwd, upstream, onto, pull_first)).await
}

pub(super) fn git_ui_commit_blocking(
    cwd: String,
    title: String,
    body: Option<String>,
    amend: bool,
) -> Result<serde_json::Value, (StatusCode, String)> {
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
        Ok(text) => Ok(json!({ "ok": true, "message": text })),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_commit(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiCommitRequest>,
) -> Response {
    check_auth!(&state, &headers, remote);
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return git_json_error(StatusCode::BAD_REQUEST, "commit title is required");
    }
    let commit_body = body.body;
    let amend = body.amend.unwrap_or(false);
    let cwd = body.cwd;
    git_spawn(move || git_ui_commit_blocking(cwd, title, commit_body, amend)).await
}

pub(super) fn safe_tag_name(value: &str) -> Result<&str, String> {
    let tag = safe_git_token(value, "tag")?;
    if tag.chars().any(char::is_whitespace) {
        return Err("invalid tag".to_string());
    }
    Ok(tag)
}

/// Socket transport for the log: mirrors the HTTP handler's parameter
/// shaping (default limit, scope resolution, optional base and file
/// filter) and runs the blocking query inline.
pub(super) fn socket_log(params: serde_json::Value) -> Result<serde_json::Value, String> {
    let query: GitUiLogQuery =
        serde_json::from_value(params).map_err(|err| format!("invalid parameters: {err}"))?;
    let Some(cwd) = query.cwd.as_deref() else {
        return Err("cwd is required".to_string());
    };
    let limit = query.max.unwrap_or(80).clamp(1, 2000);
    let all = query.all.unwrap_or(false);
    let scope = GitLogScope::from_query(query.scope, all)?;
    let base = query.base;
    let file = query.file;
    super::map_status(git_ui_log_blocking(
        cwd.to_string(),
        limit,
        scope,
        base,
        file,
    ))
}

pub(super) fn git_ui_tag_blocking(
    cwd: String,
    tag_name: String,
    ref_name: String,
) -> Result<serde_json::Value, (StatusCode, String)> {
    match git_ui_text(&cwd, &["tag", &tag_name, &ref_name]) {
        Ok(text) => Ok(json!({ "ok": true, "message": text, "tag": tag_name })),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_tag(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiTagRequest>,
) -> Response {
    check_auth!(&state, &headers, remote);
    let tag_name = match safe_tag_name(&body.tag_name) {
        Ok(v) => v.to_string(),
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let ref_name = match safe_git_token(&body.ref_name, "ref") {
        Ok(v) => v.to_string(),
        Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
    };
    let cwd = body.cwd;
    git_spawn(move || git_ui_tag_blocking(cwd, tag_name, ref_name)).await
}

pub(super) fn git_ui_pull_blocking(
    cwd: String,
    mode: String,
    branch: Option<String>,
) -> Result<serde_json::Value, (StatusCode, String)> {
    if mode == "update" {
        // GitHub-flow update: fetch everything, then fast-forward the
        // current branch only. Never creates a merge commit.
        git_ui_text_strings(&cwd, &["fetch".to_string(), "origin".to_string()]).map_err(|err| {
            (
                StatusCode::BAD_GATEWAY,
                format!("fetch origin failed:\n{err}"),
            )
        })?;
        let mut args = vec!["merge".to_string(), "--ff-only".to_string()];
        if let Some(branch) = branch.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            args.push(format!("origin/{branch}"));
        } else {
            args.push("@{u}".to_string());
        }
        return match git_ui_text_strings(&cwd, &args) {
            Ok(text) => Ok(json!({ "ok": true, "message": text })),
            Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
        };
    }
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
        Ok(text) => Ok(json!({ "ok": true, "message": text })),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_pull(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiPullPushRequest>,
) -> Response {
    check_auth!(&state, &headers, remote);
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
    git_spawn(move || git_ui_pull_blocking(cwd, mode, branch)).await
}

pub(super) fn git_ui_fetch_blocking(
    cwd: String,
    branch: Option<String>,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let mut args = vec!["fetch".to_string(), "origin".to_string()];
    if let Some(branch) = branch.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
        args.push(branch.to_string());
    }
    match git_ui_text_strings(&cwd, &args) {
        Ok(text) => Ok(json!({ "ok": true, "message": text })),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_fetch(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiPullPushRequest>,
) -> Response {
    check_auth!(&state, &headers, remote);
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
    git_spawn(move || git_ui_fetch_blocking(cwd, branch)).await
}

pub(super) fn git_ui_push_blocking(
    cwd: String,
    mode: String,
    branch: Option<String>,
    pull_first: bool,
    push_tags: bool,
) -> Result<serde_json::Value, (StatusCode, String)> {
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
        Ok(text) => Ok(json!({ "ok": true, "message": text })),
        Err(err) => Err((StatusCode::BAD_GATEWAY, err)),
    }
}

pub(super) async fn git_ui_push(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<GitUiPullPushRequest>,
) -> Response {
    check_auth!(&state, &headers, remote);
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
    git_spawn(move || git_ui_push_blocking(cwd, mode, branch, pull_first, push_tags)).await
}

pub(super) fn git_ui_apply_patch_blocking(
    cwd: String,
    patch: String,
    reverse: bool,
    cached: bool,
) -> Result<serde_json::Value, (StatusCode, String)> {
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
        Ok(output) if output.status.success() => Ok(json!({ "ok": true })),
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
    check_auth!(&state, &headers, remote);
    // Two body shapes share the handler: the explicit {patch} text and
    // the chunk selector ({file, chunk_index, scope/context/base/target})
    // that regenerates the same patch server-side. Exactly one applies.
    let patch = if let Some(patch) = body.patch.as_deref() {
        if patch.trim().is_empty() {
            return git_json_error(StatusCode::BAD_REQUEST, "patch is required");
        }
        patch.to_string()
    } else {
        match chunk_patch(&body) {
            Ok(Some(patch)) => patch,
            Ok(None) => {
                return git_json_error(
                    StatusCode::BAD_REQUEST,
                    "patch or chunk selector (file, chunk_index) is required",
                )
            }
            Err(err) => return git_json_error(StatusCode::BAD_REQUEST, err),
        }
    };
    let cwd = body.cwd;
    let reverse = body.reverse.unwrap_or(false);
    let cached = body.cached.unwrap_or(false);
    git_spawn(move || git_ui_apply_patch_blocking(cwd, patch, reverse, cached)).await
}

/// Build the single-chunk patch for a chunk-based apply request. The diff
/// is regenerated with the SAME args builder the diff handler uses
/// (git_ui_diff_args), so the chunk the client rendered by index is the
/// chunk this patch contains. Returns Ok(None) when the selector fields
/// are absent (caller should have sent {patch} instead) and an error when
/// they point at a chunk that does not exist.
pub(super) fn chunk_patch(body: &GitUiApplyPatchRequest) -> Result<Option<String>, String> {
    let (Some(file), Some(chunk_index)) = (body.file.as_deref(), body.chunk_index) else {
        return Ok(None);
    };
    let query = GitUiDiffQuery {
        cwd: Some(body.cwd.clone()),
        scope: body.scope.clone(),
        file: Some(file.to_string()),
        base: body.base.clone(),
        target: body.target.clone(),
        merge_base: body.merge_base,
        context: body.context,
        layout: None,
        q: None,
    };
    // Compare mode (base/target present) vs changes mode (scope), same
    // as the diff handler picks between /api/git-ui/diff and /compare.
    let compare = body.base.is_some() || body.target.is_some();
    let args = git_ui_diff_args(&query, compare)?;
    let text = git_ui_text_strings(&body.cwd, &args)?;
    let files = super::diff::parse_unified_diff(&text);
    let file_entry = files
        .iter()
        .find(|candidate| candidate.path == file)
        .ok_or_else(|| format!("no diff found for {file}"))?;
    let chunk = file_entry
        .chunks
        .get(chunk_index)
        .ok_or_else(|| format!("chunk {chunk_index} does not exist for {file}"))?;
    // Mirror the old client-side hunkPatch builder: diff --git header,
    // ---/+++ lines, chunk header, prefixed body lines.
    let old_path = file_entry.old_path.as_deref().unwrap_or(&file_entry.path);
    let mut lines = vec![
        format!("diff --git a/{old_path} b/{}", file_entry.path),
        format!("--- a/{old_path}"),
        format!("+++ b/{}", file_entry.path),
        chunk.header.clone(),
    ];
    for line in &chunk.lines {
        let prefix = match line.line_type.as_str() {
            "add" => '+',
            "delete" => '-',
            _ => ' ',
        };
        lines.push(format!("{prefix}{}", line.content));
    }
    Ok(Some(lines.join("\n") + "\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn chunk_patch_regenerates_the_client_chunk_server_side() {
        let repo = temp_repo("herdr-chunk-patch");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "test@example.com"]);
        run_git(&repo, &["config", "user.name", "Herdr Test"]);
        std::fs::write(repo.join("file.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n").unwrap();
        run_git(&repo, &["add", "file.txt"]);
        run_git(&repo, &["commit", "-m", "base"]);
        // Two separated hunks so chunk_index selection is observable. Git
        // merges edits closer than one context line even with -U0, so the
        // middle lines must stay untouched between the two edits.
        std::fs::write(repo.join("file.txt"), "one\nTWO\nthree\nfour\nfive\nSIX\n").unwrap();
        let cwd = repo.to_string_lossy().to_string();

        let body = GitUiApplyPatchRequest {
            cwd: cwd.clone(),
            patch: None,
            reverse: None,
            cached: None,
            scope: Some("working".to_string()),
            context: Some(0),
            base: None,
            target: None,
            file: Some("file.txt".to_string()),
            chunk_index: Some(0),
            merge_base: None,
        };
        let patch = chunk_patch(&body)
            .unwrap()
            .expect("chunk selector should build a patch");
        assert!(patch.starts_with("diff --git a/file.txt b/file.txt\n"));
        assert!(patch.contains("--- a/file.txt\n+++ b/file.txt"));
        assert_eq!(
            patch.lines().filter(|l| l.starts_with("@@")).count(),
            1,
            "exactly one hunk in the patch"
        );
        assert!(
            patch.contains("-two\n+TWO"),
            "patch carries chunk 0: {patch}"
        );
        assert!(
            !patch.contains("SIX"),
            "chunk 1 stays out of chunk 0: {patch}"
        );

        // Chunk 1 is the second hunk.
        let body = GitUiApplyPatchRequest {
            chunk_index: Some(1),
            ..body
        };
        let patch = chunk_patch(&body)
            .unwrap()
            .expect("chunk 1 selector should build a patch");
        assert!(
            patch.contains("-six\n+SIX"),
            "patch carries chunk 1: {patch}"
        );
        assert!(
            !patch.contains("two") && !patch.contains("TWO"),
            "chunk 0 stays out of chunk 1: {patch}"
        );

        // Missing chunk answers an error, not a panic or an empty patch.
        let body = GitUiApplyPatchRequest {
            chunk_index: Some(9),
            ..body
        };
        assert!(chunk_patch(&body).is_err(), "out-of-range chunk must error");

        // No selector at all: Ok(None) so the handler can demand {patch}.
        let body = GitUiApplyPatchRequest {
            file: None,
            chunk_index: None,
            ..body
        };
        assert!(chunk_patch(&body).unwrap().is_none());

        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn chunk_based_apply_patch_stages_and_restores_a_hunk() {
        let repo = temp_repo("herdr-chunk-apply");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "test@example.com"]);
        run_git(&repo, &["config", "user.name", "Herdr Test"]);
        std::fs::write(repo.join("file.txt"), "one\ntwo\n").unwrap();
        run_git(&repo, &["add", "file.txt"]);
        run_git(&repo, &["commit", "-m", "base"]);
        std::fs::write(repo.join("file.txt"), "one\nTWO\n").unwrap();
        let cwd = repo.to_string_lossy().to_string();

        // Stage hunk 0 from the working tree (scope=working, cached).
        let staged = git_ui_apply_patch_blocking(
            cwd.clone(),
            chunk_patch(&GitUiApplyPatchRequest {
                cwd: cwd.clone(),
                patch: None,
                reverse: None,
                cached: Some(true),
                scope: Some("working".to_string()),
                context: Some(0),
                base: None,
                target: None,
                file: Some("file.txt".to_string()),
                chunk_index: Some(0),
                merge_base: None,
            })
            .unwrap()
            .expect("chunk patch"),
            false,
            true,
        )
        .expect("staging chunk 0 should succeed");
        assert_eq!(staged["ok"], serde_json::json!(true));
        let staged_diff = git_text(&repo, &["diff", "--cached"]);
        assert!(staged_diff.contains("+TWO"), "hunk staged: {staged_diff}");

        // Restore the same hunk in the index (reverse + cached).
        let restored = git_ui_apply_patch_blocking(
            cwd.clone(),
            chunk_patch(&GitUiApplyPatchRequest {
                cwd,
                patch: None,
                reverse: None,
                cached: Some(true),
                scope: Some("staged".to_string()),
                context: Some(0),
                base: None,
                target: None,
                file: Some("file.txt".to_string()),
                chunk_index: Some(0),
                merge_base: None,
            })
            .unwrap()
            .expect("chunk patch"),
            true,
            true,
        )
        .expect("un-staging chunk 0 should succeed");
        assert_eq!(restored["ok"], serde_json::json!(true));
        let staged_diff = git_text(&repo, &["diff", "--cached"]);
        assert_eq!(staged_diff.trim(), "", "index is back to HEAD");

        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn log_refs_show_configured_base_before_head_when_available() {
        let repo = temp_repo("herdr-log-base");
        std::fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "test@example.com"]);
        run_git(&repo, &["config", "user.name", "Herdr Test"]);
        std::fs::write(repo.join("file.txt"), "base\n").unwrap();
        run_git(&repo, &["add", "file.txt"]);
        run_git(&repo, &["commit", "-m", "base"]);
        let base = git_text(&repo, &["branch", "--show-current"])
            .trim()
            .to_string();
        run_git(&repo, &["checkout", "-b", "feature"]);

        assert_eq!(
            log_refs(
                &repo.to_string_lossy(),
                GitLogScope::BaseCurrent,
                Some(base.clone())
            )
            .unwrap(),
            vec![base.clone(), "HEAD".to_string()]
        );
        assert_eq!(
            log_refs(
                &repo.to_string_lossy(),
                GitLogScope::All,
                Some(base.clone())
            )
            .unwrap(),
            vec![base.clone()]
        );
        assert_eq!(
            log_refs(
                &repo.to_string_lossy(),
                GitLogScope::Base,
                Some(base.clone())
            )
            .unwrap(),
            vec![base]
        );
        assert_eq!(
            log_refs(
                &repo.to_string_lossy(),
                GitLogScope::BaseCurrent,
                Some("missing-branch".to_string())
            )
            .unwrap(),
            vec!["HEAD".to_string()]
        );
        assert_eq!(
            GitLogScope::from_query(None, true).unwrap(),
            GitLogScope::All
        );
        assert_eq!(
            GitLogScope::from_query(Some("base".to_string()), true).unwrap(),
            GitLogScope::Base
        );
        assert!(GitLogScope::from_query(Some("weird".to_string()), false).is_err());
        assert_eq!(
            git_log_args(80, false, &["master".to_string(), "HEAD".to_string()], None).unwrap(),
            vec![
                "log",
                "--graph",
                "--decorate",
                "--date=relative",
                "--max-count",
                "80",
                "--format=%H%x00%an%x00%ar%x00%cI%x00%D%x00%s",
                "master",
                "HEAD",
            ]
        );
        assert_eq!(
            git_log_args(80, true, &["master".to_string()], None).unwrap(),
            vec![
                "log",
                "--graph",
                "--decorate",
                "--date=relative",
                "--max-count",
                "80",
                "--format=%H%x00%an%x00%ar%x00%cI%x00%D%x00%s",
                "master",
                "--all",
            ]
        );

        assert_eq!(
            git_log_args(40, false, &["HEAD".to_string()], Some("src/main.rs")).unwrap(),
            vec![
                "log",
                "--graph",
                "--decorate",
                "--date=relative",
                "--max-count",
                "40",
                "--format=%H%x00%an%x00%ar%x00%cI%x00%D%x00%s",
                "--follow",
                "HEAD",
                "--",
                "src/main.rs",
            ]
        );

        let _ = std::fs::remove_dir_all(repo);
    }

    #[test]
    fn trims_log_lines_to_limit_and_reports_more_candidates() {
        let lines = vec![
            [
                "* aaaaaaaa111111",
                "A",
                "1 day ago",
                "2026-07-12T10:00:00Z",
                "HEAD -> topic",
                "First",
            ]
            .join("\0"),
            "|\\".to_string(),
            [
                "* bbbbbbbb222222",
                "B",
                "2 days ago",
                "2026-07-11T10:00:00Z",
                "master",
                "Second",
            ]
            .join("\0"),
            [
                "* cccccccc333333",
                "C",
                "3 days ago",
                "2026-07-10T10:00:00Z",
                "",
                "Third",
            ]
            .join("\0"),
        ];
        let rows = parsed_log_rows(&lines);
        assert_eq!(count_commit_rows(&rows), 3);
        let trimmed = trim_log_lines_to_commit_limit(lines, 2);
        let trimmed_rows = parsed_log_rows(&trimmed);
        assert_eq!(count_commit_rows(&trimmed_rows), 2);
        assert!(trimmed.iter().any(|line| line == "|\\"));
        assert!(!trimmed.iter().any(|line| line.contains("cccccccc333333")));
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

    #[test]
    fn rebase_pull_first_fetches_branch_and_rebases_onto_remote_tracking_ref() {
        // (kept: unit expectations for fetch/ref naming helpers)
        assert_eq!(fetch_branch_name("master"), "master");
        assert_eq!(fetched_rebase_ref("master"), "origin/master");
        assert_eq!(fetch_branch_name("origin/master"), "master");
        assert_eq!(fetched_rebase_ref("origin/master"), "origin/master");
        assert_eq!(fetch_branch_name("feature/topic"), "feature/topic");
        assert_eq!(fetched_rebase_ref("feature/topic"), "origin/feature/topic");
        assert_eq!(
            fetched_rebase_ref("refs/remotes/origin/master"),
            "refs/remotes/origin/master"
        );
    }

    #[tokio::test]
    async fn pull_update_mode_fetches_and_fast_forwards_without_merge_commit() {
        // GitHub-flow update: after the remote advances, mode=update must
        // fast-forward the local branch and leave a linear history (no merge
        // commit). With no divergence it is a pure ff.
        let root =
            std::env::temp_dir().join(format!("herdr-webui-pull-update-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let origin = root.join("origin.git");
        let clone = root.join("work");
        std::fs::create_dir_all(&root).unwrap();

        run_git(&root, &["init", "--bare", "origin.git"]);
        // Pin the bare repo's HEAD to main: clones derive their initial
        // branch from it, and git builds whose default is master (Homebrew
        // git on CI runners, no init.defaultBranch configured) would
        // otherwise check out master and break the main refspecs below.
        run_git(&origin, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        run_git(&root, &["init", "-b", "main", "work"]);
        run_git(&clone, &["config", "user.email", "t@t"]);
        run_git(&clone, &["config", "user.name", "T"]);
        std::fs::write(clone.join("a.txt"), "base\n").unwrap();
        run_git(&clone, &["add", "-A"]);
        run_git(&clone, &["commit", "-m", "base"]);
        run_git(
            &clone,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        run_git(&clone, &["push", "-u", "origin", "main"]);

        // Remote advances behind the clone's back.
        let other = root.join("other");
        run_git(&root, &["clone", origin.to_str().unwrap(), "other"]);
        run_git(&other, &["config", "user.email", "t@t"]);
        run_git(&other, &["config", "user.name", "T"]);
        std::fs::write(other.join("b.txt"), "advance\n").unwrap();
        run_git(&other, &["add", "-A"]);
        run_git(&other, &["commit", "-m", "advance main"]);
        run_git(&other, &["push", "origin", "main"]);

        let response = git_ui_pull_blocking(
            clone.to_string_lossy().to_string(),
            "update".to_string(),
            None,
        )
        .expect("update pull should succeed");
        let payload: serde_json::Value = response;
        assert_eq!(payload["ok"], serde_json::json!(true));

        // Local main now equals remote main, linear history.
        let count = git_text(&clone, &["rev-list", "--count", "origin/main..main"]);
        assert_eq!(count.trim(), "0");
        let parents = git_text(&clone, &["rev-list", "--merges", "-1", "main"]);
        assert_eq!(parents.trim(), "", "update must not create merge commits");

        // True divergence: local commits AND remote advances from the same
        // base. Update must refuse (ff-only) instead of merging or rewriting.
        std::fs::write(clone.join("c.txt"), "local\n").unwrap();
        run_git(&clone, &["add", "-A"]);
        run_git(&clone, &["commit", "-m", "local work"]);
        std::fs::write(other.join("d.txt"), "remote\n").unwrap();
        run_git(&other, &["add", "-A"]);
        run_git(&other, &["commit", "-m", "remote work"]);
        run_git(&other, &["push", "origin", "main"]);
        let result = git_ui_pull_blocking(
            clone.to_string_lossy().to_string(),
            "update".to_string(),
            None,
        );
        assert!(result.is_err(), "diverged update must fail, not merge");
        // Nothing merged behind the error.
        let merges = git_text(&clone, &["rev-list", "--merges", "-1", "main"]);
        assert_eq!(merges.trim(), "", "no merge commit may appear");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn rebase_pull_first_fetches_main_alongside_selected_branch() {
        // Real repo with a local "origin": main advances on the remote after
        // the feature branch is created. Rebase with pull_first=true must
        // rebase onto the FETCHED origin/main, not the stale local main.
        let root =
            std::env::temp_dir().join(format!("herdr-webui-rebase-gh-flow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let origin = root.join("origin.git");
        let clone = root.join("work");
        std::fs::create_dir_all(&root).unwrap();

        run_git(&root, &["init", "--bare", "origin.git"]);
        // Pin the bare repo's HEAD to main (see the pull-update test above:
        // clones derive their initial branch from it).
        run_git(&origin, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        run_git(&root, &["init", "-b", "main", "work"]);
        std::fs::write(clone.join("a.txt"), "base\n").unwrap();
        run_git(&clone, &["config", "user.email", "t@t"]);
        run_git(&clone, &["config", "user.name", "T"]);
        run_git(&clone, &["add", "-A"]);
        run_git(&clone, &["commit", "-m", "base"]);
        run_git(
            &clone,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        run_git(&clone, &["push", "-u", "origin", "main"]);

        // Feature branch with its own commit.
        run_git(&clone, &["checkout", "-b", "feature"]);
        std::fs::write(clone.join("f.txt"), "feature\n").unwrap();
        run_git(&clone, &["add", "-A"]);
        run_git(&clone, &["commit", "-m", "feature"]);

        // Remote main advances behind the clone's back.
        let other = root.join("other");
        run_git(&root, &["clone", origin.to_str().unwrap(), "other"]);
        run_git(&other, &["config", "user.email", "t@t"]);
        run_git(&other, &["config", "user.name", "T"]);
        std::fs::write(other.join("b.txt"), "advance\n").unwrap();
        run_git(&other, &["add", "-A"]);
        run_git(&other, &["commit", "-m", "advance main"]);
        run_git(&other, &["push", "origin", "main"]);

        // Rebase feature onto main with fetch: backend fetches origin/main
        // (the default base), then rebases onto origin/main.
        let response = git_ui_rebase_blocking(
            clone.to_string_lossy().to_string(),
            "main".to_string(),
            None,
            true,
        )
        .expect("rebase should succeed");
        let payload: serde_json::Value = response;
        assert_eq!(payload["onto"], serde_json::json!("origin/main"));

        // The feature commit now sits on top of the advanced remote main.
        let log = git_text(&clone, &["log", "--oneline", "origin/main..HEAD"]);
        assert_eq!(log.lines().count(), 1, "only the feature commit on top");
        assert!(log.contains("feature"), "log: {log}");
        // And origin/main contains the advanced commit.
        let main_log = git_text(&clone, &["log", "--oneline", "-1", "origin/main"]);
        assert!(main_log.contains("advance main"), "log: {main_log}");

        let _ = std::fs::remove_dir_all(&root);
    }
}
