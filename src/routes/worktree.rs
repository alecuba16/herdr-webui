//! Worktree lifecycle routes and the worktree list cache.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::routes::shared::*;
use crate::routes::shared::{existing_workspace_cwd, OpenRecentWorkspaceRequest};
use crate::WebState;
use crate::WorktreeListCache;
use crate::WORKTREE_LIST_CACHES;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::mpsc;
use std::sync::Mutex;

pub(crate) fn register_worktree_list_cache(cache: std::sync::Arc<WorktreeListCache>) {
    let registry = WORKTREE_LIST_CACHES.get_or_init(Mutex::default);
    if let Ok(mut caches) = registry.lock() {
        // Re-registering the same handle (test apps) replaces, not grows.
        caches.retain(|registered| !std::sync::Arc::ptr_eq(registered, &cache));
        caches.push(cache);
    }
}

pub(crate) fn invalidate_registered_worktree_caches(cwd: &str) {
    if let Some(registry) = WORKTREE_LIST_CACHES.get() {
        if let Ok(caches) = registry.lock() {
            for cache in caches.iter() {
                cache.invalidate(cwd);
            }
        }
    }
}

/// Entry point for git-ui switch paths in every transport (HTTP handler
/// and the builtin socket dispatch): drop the cached `worktree.list`
/// answer for a cwd whose HEAD just moved.
pub(crate) fn worktree_cache_invalidated(cwd: &str) {
    invalidate_registered_worktree_caches(cwd);
}

pub(crate) fn fetch_worktree_results_by_cwd(
    api: &ApiClient,
    worktree_cache: &WorktreeListCache,
    unique_cwds: &[(String, Option<String>)],
) -> HashMap<Option<String>, Option<serde_json::Value>> {
    let (tx, rx) = mpsc::channel::<(Option<String>, Option<serde_json::Value>)>();
    let missing: Vec<(String, Option<String>)> = unique_cwds
        .iter()
        .filter(|(_, cwd)| {
            if let Some(hit) = worktree_cache.get(cwd) {
                tx.send((cwd.clone(), Some(hit.value.clone())))
                    .expect("worktree cache receiver alive");
                false
            } else {
                true
            }
        })
        .cloned()
        .collect();
    if !missing.is_empty() {
        std::thread::scope(|scope| {
            for (workspace_id, cwd) in &missing {
                let tx = tx.clone();
                let cwd = cwd.clone();
                let workspace_id = workspace_id.clone();
                scope.spawn(move || {
                    // One id per unique cwd: backends keying sessions by
                    // workspace still see a real id.
                    let request = json!({
                        "id": "web:worktree:list:snapshot",
                        "method": "worktree.list",
                        "params": { "workspace_id": workspace_id, "cwd": cwd },
                    });
                    let response = match api.request_value(request) {
                        Ok(response) if response.get("error").is_none() => {
                            // Only real paths are cache keys; a null
                            // cwd resolves against the unstable process cwd.
                            if let Some(cwd_key) = &cwd {
                                worktree_cache.put(cwd_key, response.clone());
                            }
                            Some(response)
                        }
                        _ => None,
                    };
                    tx.send((cwd, response))
                        .expect("worktree fetch receiver alive");
                });
            }
        });
    }
    drop(tx);
    rx.into_iter().collect()
}

/// Stamp `worktree` metadata onto workspace rows from per-cwd
/// `worktree.list` responses (the same envelope the wrapper ships as
/// `worktree_results`: `{result: {worktrees, source}}`). Mirrors the
/// stamp the external herdr backend puts on its workspace rows, so
/// builtin sessions get the identical shape:
/// `{repo_key, repo_root, repo_name, checkout_path, is_linked_worktree,
/// branch}`. Only rows missing the key are stamped (external rows keep
/// their backend-provided stamp verbatim).
///
/// Linked-vs-main cannot come from the row flag: the builtin backend
/// marks every `worktree list` row `is_linked_worktree: true`, main
/// checkout included, so the check is `row path != source repo_root`
/// (the repo root the same response reports). A workspace whose cwd
/// matches no row (failed fetch, plain folder, mid-creation checkout)
/// keeps no stamp, which is exactly the pre-stamp behavior the frontend
/// already handles.
pub(crate) fn stamp_workspace_worktrees(
    workspaces: &mut serde_json::Value,
    cwd_results: &HashMap<Option<String>, Option<serde_json::Value>>,
) {
    let Some(rows) = workspaces.as_array_mut() else {
        return;
    };
    for workspace in rows.iter_mut() {
        if workspace.get("worktree").is_some() {
            continue;
        }
        let Some(cwd) = workspace
            .get("cwd")
            .and_then(serde_json::Value::as_str)
            .map(expand_user_path_string)
        else {
            continue;
        };
        let Some(response) = cwd_results.get(&Some(cwd.clone())).cloned().flatten() else {
            continue;
        };
        let source = response.pointer("/result/source");
        let repo_root = source
            .and_then(|source| source.get("repo_root"))
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        let Some(row) = response
            .pointer("/result/worktrees")
            .and_then(serde_json::Value::as_array)
            .and_then(|worktrees| {
                worktrees.iter().find(|row| {
                    row.get("path")
                        .and_then(serde_json::Value::as_str)
                        .is_some_and(|path| same_checkout_path(path, &cwd))
                })
            })
            .cloned()
        else {
            continue;
        };
        let checkout_path = row
            .get("path")
            .and_then(serde_json::Value::as_str)
            .unwrap_or(&cwd)
            .to_string();
        let is_linked_worktree = match &repo_root {
            Some(repo_root) => !same_checkout_path(&checkout_path, repo_root),
            // Without a repo root the main-vs-linked call is unknowable;
            // the builtin always sends one, so this only guards a
            // malformed response, and claiming linked is the safer
            // wrong answer (a plain workspace just renders as before).
            None => true,
        };
        let branch = row
            .get("branch")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string);
        if let Some(object) = workspace.as_object_mut() {
            object.insert(
                "worktree".to_string(),
                json!({
                    "repo_key": source
                        .and_then(|source| source.get("repo_key"))
                        .and_then(serde_json::Value::as_str)
                        .or(repo_root.as_deref())
                        .unwrap_or(&checkout_path),
                    "repo_root": repo_root.clone().unwrap_or_else(|| checkout_path.clone()),
                    "repo_name": source
                        .and_then(|source| source.get("repo_name"))
                        .and_then(serde_json::Value::as_str)
                        .map(str::to_string)
                        .unwrap_or_default(),
                    "checkout_path": checkout_path,
                    "is_linked_worktree": is_linked_worktree,
                    "branch": branch,
                }),
            );
        }
    }
}

/// Path equality for git checkouts: exact first, then canonicalized on
/// both sides so a workspace opened through one spelling of a symlinked
/// prefix (/tmp vs /private/tmp on macOS) still matches the row git
/// reports under the other spelling. Canonicalize failures fall back to
/// the exact comparison result.
pub(crate) fn same_checkout_path(left: &str, right: &str) -> bool {
    if left == right {
        return true;
    }
    let canonical = |path: &str| std::fs::canonicalize(path).ok();
    match (canonical(left), canonical(right)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

pub(crate) fn open_created_worktree_request(
    cwd: &str,
    path: &str,
    label: Option<String>,
) -> serde_json::Value {
    json!({
        "id": "web:worktree:open-created",
        "method": "worktree.open",
        "params": {
            "workspace_id": null,
            "cwd": cwd,
            "path": path,
            "branch": null,
            "label": label,
            "focus": true,
        },
    })
}

pub(crate) async fn worktrees(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<WorkspaceQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let cwd = query.cwd.as_deref().map(expand_user_path_string);
    let api = api_for_headers_ensured(&state, &headers).await;
    let request = json!({ "id": "web:worktree:list", "method": "worktree.list", "params": { "workspace_id": query.workspace_id, "cwd": cwd } });
    let result = tokio::task::spawn_blocking(move || api.request_value(request)).await;
    match result {
        Ok(Ok(mut value)) => {
            normalize_worktree_response(&mut value);
            Json(value).into_response()
        }
        Ok(Err(err)) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
        Err(join_err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": join_err.to_string() })),
        )
            .into_response(),
    }
}

pub(crate) fn normalize_worktree_response(value: &mut serde_json::Value) {
    // The source envelope holds fields every JS consumer used to stamp
    // onto rows client-side (desktop core.js flatMap, worktrees.js
    // discoverWorktrees, mobile worktrees.js applyResult). Stamping them
    // here covers /api/worktrees and the snapshot's worktree_results in
    // one place; the row-level keys are additive so old clients ignore
    // them. Missing source fields fall back exactly like the JS did
    // (repo_name -> repo_key -> repo_root; source_checkout_path ->
    // repo_root).
    let source = value
        .pointer("/result/source")
        .and_then(serde_json::Value::as_object)
        .cloned()
        .unwrap_or_default();
    let str_field = |key: &str| source.get(key).and_then(serde_json::Value::as_str);
    let source_workspace_id = str_field("source_workspace_id").map(str::to_string);
    let repo_name = str_field("repo_name")
        .or_else(|| str_field("repo_key"))
        .or_else(|| str_field("repo_root"))
        .map(str::to_string);
    let source_cwd = str_field("source_checkout_path")
        .or_else(|| str_field("repo_root"))
        .map(str::to_string);
    let repo_root = str_field("repo_root").map(str::to_string);
    let repo_key = str_field("repo_key").map(str::to_string);
    let default_dir = str_field("default_worktree_directory").map(str::to_string);
    let repo_label = repo_name
        .as_deref()
        .map(path_basename)
        .filter(|label| !label.is_empty())
        .or_else(|| repo_root.as_deref().map(path_basename))
        .unwrap_or_default();
    let Some(rows) = value
        .pointer_mut("/result/worktrees")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for row in rows.iter_mut() {
        enrich_worktree_activity(row);
        if let Some(object) = row.as_object_mut() {
            if let Some(value) = &source_workspace_id {
                object
                    .entry("source_workspace_id".to_string())
                    .or_insert_with(|| json!(value));
            }
            if let Some(value) = &repo_name {
                object
                    .entry("source_repo_name".to_string())
                    .or_insert_with(|| json!(value));
            }
            if let Some(value) = &repo_key {
                object
                    .entry("source_repo_key".to_string())
                    .or_insert_with(|| json!(value));
            }
            if let Some(value) = &repo_root {
                object
                    .entry("source_repo_root".to_string())
                    .or_insert_with(|| json!(value));
            }
            if let Some(value) = &source_cwd {
                object
                    .entry("source_cwd".to_string())
                    .or_insert_with(|| json!(value));
            }
            if let Some(value) = &default_dir {
                object
                    .entry("default_worktree_directory".to_string())
                    .or_insert_with(|| json!(value));
            }
            if !repo_label.is_empty() {
                object
                    .entry("repo_label".to_string())
                    .or_insert_with(|| json!(repo_label));
            }
        }
    }
    rows.sort_by(|left, right| {
        worktree_activity_sort_key(right).cmp(&worktree_activity_sort_key(left))
    });
}

/// Basename of a path, the JS `pathBasename` parity: strip trailing
/// slashes, split, take the last non-empty segment.
pub(crate) fn path_basename(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .to_string()
}

pub(crate) fn enrich_worktree_activity(row: &mut serde_json::Value) {
    if row_activity_date(row).is_none_or(|value| value.trim().is_empty()) {
        if let Some((date, hash)) = latest_worktree_commit(row) {
            if let Some(object) = row.as_object_mut() {
                object.insert("last_commit_at".to_string(), json!(date));
                if !hash.is_empty() {
                    object.insert("last_commit_hash".to_string(), json!(hash));
                }
            }
        }
    }
    let display = row_activity_date(row).and_then(worktree_activity_display);
    if let (Some(display), Some(object)) = (display, row.as_object_mut()) {
        object
            .entry("last_commit_display".to_string())
            .or_insert_with(|| json!(display));
    }
}

pub(crate) fn latest_worktree_commit(row: &serde_json::Value) -> Option<(String, String)> {
    let path = row.get("path").and_then(serde_json::Value::as_str)?.trim();
    if path.is_empty() {
        return None;
    }
    let output = run_git_capture(&["-C", path, "log", "-1", "--format=%cI%x00%H"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut parts = text.split('\0');
    let date = parts.next().unwrap_or_default().trim().to_string();
    if date.is_empty() {
        return None;
    }
    let hash = parts.next().unwrap_or_default().trim().to_string();
    Some((date, hash))
}

pub(crate) fn row_activity_date(row: &serde_json::Value) -> Option<&str> {
    [
        "last_commit_at",
        "latest_commit_at",
        "last_commit_date",
        "latest_commit_date",
        "modified_at",
        "updated_at",
        "mtime",
        "last_modified_at",
    ]
    .into_iter()
    .find_map(|key| row.get(key).and_then(serde_json::Value::as_str))
}

pub(crate) fn worktree_activity_display(value: &str) -> Option<String> {
    let value = value.trim();
    let prefix = || value.chars().take(16).collect::<String>();
    if value.len() >= 16 && value.as_bytes().get(10) == Some(&b'T') {
        return Some(prefix().replace('T', " "));
    }
    if value.len() >= 16 && value.as_bytes().get(10) == Some(&b' ') {
        return Some(prefix());
    }
    None
}

pub(crate) fn worktree_activity_sort_key(row: &serde_json::Value) -> String {
    let string_key = row_activity_date(row).unwrap_or_default().to_string();
    if !string_key.is_empty() {
        if let Some(timestamp) = parse_worktree_activity_timestamp(&string_key) {
            return format!("2:{:020}", timestamp + 20_000_000_000);
        }
        return format!("2:{string_key}");
    }
    [
        "last_commit_timestamp",
        "latest_commit_timestamp",
        "modified_timestamp",
        "updated_timestamp",
    ]
    .into_iter()
    .find_map(|key| row.get(key).and_then(serde_json::Value::as_i64))
    .map(|value| format!("1:{value:020}"))
    .unwrap_or_else(|| "0:".to_string())
}

pub(crate) fn parse_worktree_activity_timestamp(value: &str) -> Option<i64> {
    let value = value.trim();
    let bytes = value.as_bytes();
    if bytes.len() < 19
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !matches!(bytes.get(10), Some(b'T' | b' '))
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let year: i32 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    let local_seconds = days * 86_400 + hour * 3_600 + minute * 60 + second.min(59);
    let offset_index = if bytes.get(19) == Some(&b'.') {
        20 + bytes
            .get(20..)?
            .iter()
            .position(|byte| !byte.is_ascii_digit())?
    } else {
        19
    };
    let offset_seconds = match bytes.get(offset_index) {
        Some(b'Z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            if bytes.len() < offset_index + 6 || bytes.get(offset_index + 3) != Some(&b':') {
                return None;
            }
            let hours: i64 = value
                .get(offset_index + 1..offset_index + 3)?
                .parse()
                .ok()?;
            let minutes: i64 = value
                .get(offset_index + 4..offset_index + 6)?
                .parse()
                .ok()?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let offset = hours * 3_600 + minutes * 60;
            if *sign == b'+' {
                offset
            } else {
                -offset
            }
        }
        _ => 0,
    };
    Some(local_seconds - offset_seconds)
}

pub(crate) fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return None,
    };
    if day == 0 || day > days_in_month {
        return None;
    }
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) as i64)
}

pub(crate) fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

#[derive(Deserialize)]
pub(crate) struct CreateWorktreeRequest {
    pub(crate) workspace_id: Option<String>,
    pub(crate) cwd: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) base: Option<String>,
    pub(crate) path: Option<String>,
    pub(crate) label: Option<String>,
    pub(crate) pull_base: Option<bool>,
}

#[derive(Deserialize)]
pub(crate) struct OpenWorktreeRequest {
    workspace_id: Option<String>,
    cwd: Option<String>,
    path: Option<String>,
    branch: Option<String>,
    label: Option<String>,
    open_terminal: Option<bool>,
}

#[derive(Deserialize)]
pub(crate) struct RemoveWorktreePathRequest {
    repo_root: String,
    path: String,
    force: Option<bool>,
}

pub(crate) async fn create_worktree(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateWorktreeRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let cwd = body.cwd.as_deref().map(expand_user_path_string);
    let path = body.path.as_deref().map(expand_user_path_string);
    let api = api_for_headers_ensured(&state, &headers).await;

    // Phase 1: git operations (pull, branch check, worktree checkout, and
    // backend API version detection) are blocking subprocesses or socket I/O
    // that can take seconds (git pull involves network). Offload them all to
    // spawn_blocking to avoid stalling the async runtime.
    enum CreateWorktreePhase {
        Error(Response),
        NativeCreate,
        LegacyOpen,
        Default,
    }
    let phase = {
        let cwd = cwd.clone();
        let path = path.clone();
        let api_clone = api.clone();
        let pull_base = body.pull_base.unwrap_or(false);
        let branch = body.branch.clone();
        let base = body.base.clone();
        tokio::task::spawn_blocking(move || {
            if pull_base {
                if let Some(cwd) = cwd.as_deref() {
                    let base = base
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("HEAD");
                    if let Err(err) = pull_base_branch(cwd, base) {
                        return CreateWorktreePhase::Error(
                            (
                                StatusCode::BAD_REQUEST,
                                Json(json!({ "ok": false, "error": err })),
                            )
                                .into_response(),
                        );
                    }
                }
            }
            if let (Some(cwd), Some(path), Some(branch)) = (&cwd, &path, branch.as_deref()) {
                let branch = branch.trim();
                if !branch.is_empty() && git_branch_exists(cwd, branch).unwrap_or(false) {
                    let worktree_api = HerdrWorktreeApi::detect(api_clone);
                    if !worktree_api.needs_legacy_existing_branch_create() {
                        // Native API handles existing-branch create; no local
                        // checkout needed. Phase 2 will call the native API.
                        return CreateWorktreePhase::NativeCreate;
                    }
                    let base = base
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("HEAD");
                    if let Err(err) = create_worktree_checkout(cwd, path, branch, base) {
                        return CreateWorktreePhase::Error(
                            (
                                StatusCode::BAD_REQUEST,
                                Json(json!({ "ok": false, "error": err })),
                            )
                                .into_response(),
                        );
                    }
                    // Legacy checkout done; Phase 2 will call worktree.open.
                    return CreateWorktreePhase::LegacyOpen;
                }
            }
            CreateWorktreePhase::Default
        })
        .await
        .unwrap_or_else(|err| {
            CreateWorktreePhase::Error(
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "ok": false, "error": err.to_string() })),
                )
                    .into_response(),
            )
        })
    };

    match phase {
        CreateWorktreePhase::Error(response) => return response,
        CreateWorktreePhase::NativeCreate => {
            let worktree_api = HerdrWorktreeApi::new(api);
            let request = worktree_api.create_request(body, cwd, path);
            return proxy_request_async(worktree_api.client, request).await;
        }
        CreateWorktreePhase::LegacyOpen => {
            if let (Some(cwd), Some(path)) = (&cwd, &path) {
                let worktree_api = HerdrWorktreeApi::new(api);
                let request = worktree_api.legacy_open_created_request(cwd, path, body.label);
                return proxy_request_async(worktree_api.client, request).await;
            }
        }
        CreateWorktreePhase::Default => {}
    }
    let worktree_api = HerdrWorktreeApi::new(api);
    let request = worktree_api.create_request(body, cwd, path);
    proxy_request_async(worktree_api.client, request).await
}

pub(crate) fn run_git_capture(args: &[&str]) -> Result<std::process::Output, String> {
    crate::git_bin::command()
        .args(args)
        .output()
        .map_err(|err| err.to_string())
}

pub(crate) fn git_failure(output: std::process::Output, context: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("{context} failed with status {}", output.status)
    }
}

pub(crate) fn git_branch_exists(repo: &str, branch: &str) -> Result<bool, String> {
    let output = run_git_capture(&[
        "-C",
        repo,
        "show-ref",
        "--verify",
        "--quiet",
        &format!("refs/heads/{branch}"),
    ])?;
    if output.status.success() {
        Ok(true)
    } else if output.status.code() == Some(1) {
        Ok(false)
    } else {
        Err(git_failure(output, "git show-ref"))
    }
}

pub(crate) fn pull_base_branch(cwd: &str, base: &str) -> Result<(), String> {
    // --no-rebase keeps the fast-forward promise even when the user has
    // pull.rebase configured globally; a rebase on a dirty tree would fail
    // where a fast-forward would succeed.
    let output = if base == "HEAD" {
        run_git_capture(&["-C", cwd, "pull", "--ff-only", "--no-rebase"])?
    } else {
        run_git_capture(&[
            "-C",
            cwd,
            "pull",
            "--ff-only",
            "--no-rebase",
            "origin",
            base,
        ])?
    };
    if output.status.success() {
        Ok(())
    } else {
        Err(git_failure(output, "git pull"))
    }
}

pub(crate) fn create_worktree_checkout(
    cwd: &str,
    path: &str,
    branch: &str,
    base: &str,
) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let output = if git_branch_exists(cwd, branch)? {
        run_git_capture(&["-C", cwd, "worktree", "add", path, branch])?
    } else {
        run_git_capture(&["-C", cwd, "worktree", "add", "-b", branch, path, base])?
    };
    if output.status.success() {
        Ok(())
    } else {
        Err(git_failure(output, "git worktree add"))
    }
}

pub(crate) async fn open_worktree(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<OpenWorktreeRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let cwd = body.cwd.as_deref().map(expand_user_path_string);
    let path = body.path.as_deref().map(expand_user_path_string);
    let recorded_path = path.as_deref().or(cwd.as_deref()).unwrap_or("").to_string();
    let recorded_label = body.label.clone();
    let recorded_branch = body.branch.clone();
    let record_state = state.clone();
    let record_kind = "worktree".to_string();
    let record = tokio::spawn(async move {
        let _ = record_recent_workspace(
            &record_state,
            &recorded_path,
            recorded_label,
            recorded_branch,
            Some(record_kind),
        )
        .await;
    });
    let response = proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({
            "id": "web:worktree:open",
            "method": "worktree.open",
            "params": {
                "workspace_id": body.workspace_id,
                "cwd": cwd,
                "path": path,
                "branch": body.branch,
                "label": body.label,
                "focus": true,
                "open_terminal": body.open_terminal,
            },
        }),
    )
    .await;
    let _ = record.await;
    response
}

pub(crate) async fn open_recent_workspace(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<OpenRecentWorkspaceRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    // Validate the raw path BEFORE expanding: an empty or whitespace-only
    // path must 400 instead of expanding "~"/"" into the home directory,
    // opening it as a workspace, and recording it in recents.
    let raw_path = body.path.as_deref().unwrap_or_default();
    if raw_path.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path is required" })),
        )
            .into_response();
    }
    // A recent entry whose folder vanished cannot be reopened: reject the
    // request before proxying so the backend never opens a workspace rooted
    // at a missing path (mirrors the create-workspace check).
    let cwd = match existing_workspace_cwd(Some(raw_path)) {
        Ok(cwd) => cwd,
        Err(response) => return *response,
    };
    let path = cwd.clone();
    let recorded_path = path.clone().unwrap_or_default();
    let recorded_label = body.label.clone();
    let recorded_branch = body.branch.clone();
    let record_state = state.clone();
    let record_kind = "workspace".to_string();
    let record = tokio::spawn(async move {
        let _ = record_recent_workspace(
            &record_state,
            &recorded_path,
            recorded_label,
            recorded_branch,
            Some(record_kind),
        )
        .await;
    });
    let response = proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({
            "id": "web:recent-workspace:open",
            "method": "worktree.open",
            "params": {
                "workspace_id": null,
                "cwd": cwd,
                "path": path,
                "branch": null,
                "label": body.label,
                "focus": true,
                "open_terminal": body.open_terminal,
            },
        }),
    )
    .await;
    let _ = record.await;
    response
}

pub(crate) async fn remove_worktree_path(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<RemoveWorktreePathRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let repo_root = expand_user_path_string(&body.repo_root);
    let path = expand_user_path_string(&body.path);
    let force = body.force.unwrap_or(false);
    // git worktree remove is a subprocess that can block; offload it.
    let path_for_response = path.clone();
    match tokio::task::spawn_blocking(move || {
        let mut command = crate::git_bin::command();
        command
            .arg("-C")
            .arg(&repo_root)
            .args(["worktree", "remove"]);
        if force {
            command.arg("--force");
        }
        command.arg(&path);
        command.output()
    })
    .await
    {
        Ok(Ok(output)) if output.status.success() => {
            Json(json!({ "ok": true, "path": path_for_response })).into_response()
        }
        Ok(Ok(output)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": String::from_utf8_lossy(&output.stderr).trim() })),
        )
            .into_response(),
        Ok(Err(err)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}
