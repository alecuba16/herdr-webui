//! Workspace, tab, pane-list and agent routes.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::routes::shared::*;
use crate::routes::worktree::{normalize_worktree_response, path_basename};
use crate::server_settings::RecentWorkspace;
use crate::WebState;
use crate::WorktreeListCache;
use herdr_webui::socket_paths::home_dir;
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};

pub(crate) async fn workspaces(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let api = api_for_headers_ensured(&state, &headers).await;
    let worktree_cache = state.worktree_list_cache.clone();
    // request_value() does blocking socket I/O; offload to a blocking thread
    // so it does not stall the async runtime (and active WebSocket loops).
    match tokio::task::spawn_blocking(move || {
        match api.request_value(
            json!({ "id": "web:workspace:list", "method": "workspace.list", "params": {} }),
        ) {
            Ok(mut value) => {
                if let Ok(panes) = api.request_value(json!({ "id": "web:pane:list:workspace-cwds", "method": "pane.list", "params": { "workspace_id": null } })) {
                    enrich_workspace_cwds(&mut value, &panes);
                }
                // Same worktree stamp the snapshot path puts on workspace
                // rows, so the legacy refresh path (snapshot bootstrap
                // failed once) renders the same location bar and sidebar
                // grouping instead of a bar missing its worktree chip.
                // Shares the snapshot's cache, so a snapshot that just ran
                // serves these from it without new git round trips.
                if let Some(workspaces_value) = value.pointer_mut("/result/workspaces") {
                    let unique_cwds: Vec<(String, Option<String>)> = {
                        let mut seen = HashSet::new();
                        workspaces_value
                            .as_array()
                            .into_iter()
                            .flatten()
                            .map(|workspace| {
                                (
                                    workspace
                                        .get("workspace_id")
                                        .and_then(serde_json::Value::as_str)
                                        .unwrap_or_default()
                                        .to_string(),
                                    workspace
                                        .get("cwd")
                                        .and_then(serde_json::Value::as_str)
                                        .map(expand_user_path_string),
                                )
                            })
                            .filter(|(_, cwd)| seen.insert(cwd.clone()))
                            .collect()
                    };
                    let cwd_results =
                        fetch_worktree_results_by_cwd(&api, &worktree_cache, &unique_cwds);
                    stamp_workspace_worktrees(workspaces_value, &cwd_results);
                }
                Ok(value)
            }
            Err(err) => Err(err),
        }
    }).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub(crate) fn enrich_workspace_cwds(workspaces: &mut serde_json::Value, panes: &serde_json::Value) {
    use std::collections::HashMap;

    let mut cwd_by_workspace = HashMap::<String, (Option<String>, Option<String>)>::new();
    let pane_items = panes
        .pointer("/result/panes")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten();
    for pane in pane_items {
        let Some(workspace_id) = pane
            .get("workspace_id")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        cwd_by_workspace
            .entry(workspace_id.to_string())
            .or_insert_with(|| {
                (
                    pane.get("cwd")
                        .and_then(serde_json::Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                    pane.get("foreground_cwd")
                        .and_then(serde_json::Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                )
            });
    }

    let workspace_items = workspaces
        .pointer_mut("/result/workspaces")
        .and_then(serde_json::Value::as_array_mut)
        .into_iter()
        .flatten();
    for workspace in workspace_items {
        let Some(workspace_id) = workspace
            .get("workspace_id")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Some((cwd, foreground_cwd)) = cwd_by_workspace.get(workspace_id) else {
            continue;
        };
        if workspace
            .get("cwd")
            .and_then(serde_json::Value::as_str)
            .is_none()
        {
            if let Some(cwd) = cwd {
                workspace["cwd"] = json!(cwd);
            }
        }
        if workspace
            .get("foreground_cwd")
            .and_then(serde_json::Value::as_str)
            .is_none()
        {
            if let Some(foreground_cwd) = foreground_cwd {
                workspace["foreground_cwd"] = json!(foreground_cwd);
            }
        }
    }
}

/// Tab (or pane) count per workspace_id from a snapshot array. Built from
/// the UNFILTERED arrays so every workspace keeps its totals even when a
/// workspace_id filter narrows the payload arrays.
pub(crate) fn snapshot_counts_by_workspace(
    rows: Option<&serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut counts = serde_json::Map::new();
    let Some(rows) = rows.and_then(serde_json::Value::as_array) else {
        return counts;
    };
    for row in rows {
        let Some(id) = row.get("workspace_id").and_then(serde_json::Value::as_str) else {
            continue;
        };
        let entry = counts
            .entry(id.to_string())
            .or_insert_with(|| serde_json::Value::from(0));
        if let Some(count) = entry.as_i64() {
            *entry = serde_json::Value::from(count + 1);
        }
    }
    counts
}

/// Keep only one workspace's rows in a snapshot array (tabs/panes). This
/// is the filtering both JS clients used to run locally (mobile app.js
/// applySessionSnapshot, desktop core.js applySessionSnapshot); the
/// server now does it so the payload shrinks to the selected workspace.
pub(crate) fn filter_snapshot_rows_by_workspace(
    value: &mut serde_json::Value,
    pointer: &str,
    workspace_id: &str,
) {
    let Some(rows) = value
        .pointer_mut(pointer)
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    rows.retain(|row| {
        row.get("workspace_id").and_then(serde_json::Value::as_str) == Some(workspace_id)
    });
}

/// Adds the WebUI-only bootstrap fields to a raw backend `session.snapshot`
/// response. Mutates `result` in place, keeping the backend envelope
/// (including `result.snapshot` for protocol 16+ backends) untouched:
/// - `workspace_order`: drag-sort order, a WebUI concept no backend knows.
/// - `workspaces_by_id` / `workspace_counts`: derived maps the JS clients
///   used to build locally (Object.fromEntries + per-workspace tab/pane
///   counting); the server ships them so the clients stop re-deriving.
/// - `workspace_cwds`: reuses the snapshot's own panes so external daemons
///   without per-workspace `cwd` still get enriched workspace rows. The
///   builtin already sets `cwd`/`foreground_cwd` directly, and enrichment
///   only fills missing fields, so builtin rows pass through unchanged.
/// - `worktree_results`: one `worktree.list` response per workspace with
///   `cwd` pinned to that workspace, normalized through the same path as
///   `/api/worktrees` (activity enrichment + sort). Sending explicit `cwd`
///   also fixes builtin, whose `worktree.list` otherwise resolves the
///   focused workspace's cwd regardless of the requested workspace_id,
///   and lets the wrapper stamp `source_workspace_id` so the frontend
///   can attribute rows to their source workspace. Failed requests keep
///   the same tolerance as the frontend's legacy per-workspace fetch:
///   the entry is null and the rest of the snapshot still applies.
///
/// Short-TTL cache keyed by cwd. Consecutive panel-switch snapshots
/// re-ask the same checkouts, and the small TTL keeps worktree changes reflecting.
pub(crate) fn enrich_session_snapshot(
    value: &mut serde_json::Value,
    workspace_order: &[String],
    workspace_id: Option<&str>,
    api: &ApiClient,
    worktree_cache: &WorktreeListCache,
) {
    if value
        .get("result")
        .and_then(serde_json::Value::as_object)
        .is_none()
    {
        return;
    }
    // Both known envelope shapes carry the arrays under result: builtin
    // and protocol 16 external wrap them as result.snapshot.*; the flat
    // result.* shape stays supported because the TUI parser accepts it.
    let base = if value.pointer("/result/snapshot").is_some() {
        "/result/snapshot"
    } else if value.pointer("/result/workspaces").is_some() {
        "/result"
    } else {
        return;
    };
    if value
        .pointer(&format!("{base}/workspaces"))
        .and_then(serde_json::Value::as_array)
        .is_none()
    {
        return;
    };
    // Enrich workspace cwd/foreground_cwd from the snapshot's own panes.
    // The wrapper dance exists because enrich_workspace_cwds expects the
    // /api/workspaces envelope (result.workspaces + result.panes); the
    // panes argument wants the same envelope shape, not the bare array.
    let panes = value.pointer(&format!("{base}/panes")).cloned();
    if let Some(panes) = panes {
        let mut enriched = json!({
            "result": {
                "workspaces": value
                    .pointer(&format!("{base}/workspaces"))
                    .cloned()
                    .unwrap_or(serde_json::Value::Array(Vec::new())),
                "panes": panes.clone(),
            }
        });
        let pane_envelope = json!({ "result": { "panes": panes } });
        enrich_workspace_cwds(&mut enriched, &pane_envelope);
        let rows = enriched
            .pointer("/result/workspaces")
            .cloned()
            .unwrap_or(serde_json::Value::Array(Vec::new()));
        if let Some(workspaces_value) = value.pointer_mut(&format!("{base}/workspaces")) {
            *workspaces_value = rows;
        }
    }
    // Collect after cwd enrichment so worktree.list pins each workspace's
    // resolved cwd (and expand ~ the same way /api/worktrees does).
    let workspace_ids: Vec<(String, Option<String>)> = value
        .pointer(&format!("{base}/workspaces"))
        .and_then(serde_json::Value::as_array)
        .map(|workspaces| {
            workspaces
                .iter()
                .map(|workspace| {
                    (
                        workspace
                            .get("workspace_id")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        workspace
                            .get("cwd")
                            .and_then(serde_json::Value::as_str)
                            .map(expand_user_path_string),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let mut worktree_results = Vec::with_capacity(workspace_ids.len());
    // One worktree.list per unique cwd, fetched in parallel: before, N
    // workspaces paid N sequential git round trips (~0.5s at 12) per snapshot.
    // Parallel on purpose: each fetch opens its own backend socket, so
    // spawned threads never share framing state.
    let unique_cwds: Vec<(String, Option<String>)> = {
        let mut seen = HashSet::new();
        workspace_ids
            .iter()
            .filter(|(_, cwd)| seen.insert(cwd.clone()))
            .cloned()
            .collect()
    };
    let cwd_results: HashMap<Option<String>, Option<serde_json::Value>> =
        fetch_worktree_results_by_cwd(api, worktree_cache, &unique_cwds);
    for (workspace_id, cwd) in &workspace_ids {
        // Backend-level errors stay null entries, matching the legacy
        // per-workspace fetch where /api/worktrees returned 502 and the
        // frontend catch() produced null. A null entry must not break the
        // rest of the snapshot.
        let Some(mut response) = cwd_results.get(cwd).cloned().flatten() else {
            worktree_results.push(serde_json::Value::Null);
            continue;
        };
        // The wrapper, not the backend, knows which workspace produced each
        // result (builtin ignores workspace_id and resolves cwd instead, and
        // never sets source_workspace_id). Stamp it so the frontend can
        // attribute rows without re-deriving the mapping.
        if response.pointer("/result/source").is_none() {
            if let Some(result) = response.get_mut("result") {
                result["source"] = json!({});
            }
        }
        if let Some(source) = response
            .pointer_mut("/result/source")
            .and_then(serde_json::Value::as_object_mut)
        {
            // Overwrite null too: builtin sets the key but always leaves it
            // null because it never learned which workspace asked.
            let stale = source
                .get("source_workspace_id")
                .is_none_or(|value| value.is_null());
            if stale {
                source.insert("source_workspace_id".to_string(), json!(workspace_id));
            }
        }
        normalize_worktree_response(&mut response);
        // Full envelope per entry ({result: {worktrees, source}}) so both
        // desktop and mobile reuse their existing per-request parsing on
        // each entry unchanged.
        worktree_results.push(response);
    }
    // Stamp worktree metadata onto the workspace rows from the results
    // just fetched: the external herdr backend ships `worktree` on every
    // workspace row, but the builtin backend never does, so every
    // workspace-scoped surface (location bar worktree chip, sidebar repo
    // grouping, agent repo attribution) went blind on builtin sessions.
    // Computed here, where the per-cwd worktree.list data already flows,
    // so both backends end up with the same shape and neither pays an
    // extra git round trip.
    if let Some(workspaces_value) = value.pointer_mut(&format!("{base}/workspaces")) {
        stamp_workspace_worktrees(workspaces_value, &cwd_results);
    }
    // Derived maps from the UNFILTERED arrays (computed before the
    // workspace_id filter narrows them): workspaces_by_id replaces the
    // clients' Object.fromEntries(workspaces.map(...)), and
    // workspace_counts replaces their per-workspace tab/pane loops.
    // shape: {id: {tabs: n, panes: n}}.
    // tab_labels_by_id keeps every tab's id -> label so the agents list can
    // name panels of workspaces whose tab rows the filter just dropped; the
    // label token vanishes without it when the selected workspace differs
    // from the agent's one (filtered snapshot, reported bug).
    // tabs_by_id / panes_by_id keep the full row records the same way: the
    // pane tree stores bare tab ids, and its strips/prune logic must resolve
    // ids whose rows the filter dropped (cross-workspace trees). The tab map
    // is id -> tab row; the pane map is id -> [pane rows] because multiple
    // panes share one tab id (the pane-index map consumers already expect).
    let mut tab_labels_by_id = serde_json::Map::new();
    let mut tabs_by_id = serde_json::Map::new();
    let mut panes_by_id = serde_json::Map::new();
    if let Some(tabs) = value
        .pointer(&format!("{base}/tabs"))
        .and_then(serde_json::Value::as_array)
    {
        for tab in tabs {
            let Some(tab_id) = tab.get("tab_id").and_then(serde_json::Value::as_str) else {
                continue;
            };
            if let Some(label) = tab.get("label").and_then(serde_json::Value::as_str) {
                tab_labels_by_id.insert(tab_id.to_string(), json!(label));
            }
            tabs_by_id.insert(tab_id.to_string(), tab.clone());
        }
    }
    if let Some(panes) = value
        .pointer(&format!("{base}/panes"))
        .and_then(serde_json::Value::as_array)
    {
        for pane in panes {
            let Some(tab_id) = pane.get("tab_id").and_then(serde_json::Value::as_str) else {
                continue;
            };
            let entry = panes_by_id
                .entry(tab_id.to_string())
                .or_insert_with(|| serde_json::Value::Array(Vec::new()));
            if let Some(list) = entry.as_array_mut() {
                list.push(pane.clone());
            }
        }
    }
    let tab_counts = snapshot_counts_by_workspace(value.pointer(&format!("{base}/tabs")));
    let pane_counts = snapshot_counts_by_workspace(value.pointer(&format!("{base}/panes")));
    let mut workspace_counts = serde_json::Map::new();
    for id in tab_counts.keys() {
        workspace_counts.insert(
            id.clone(),
            json!({
                "tabs": tab_counts.get(id).cloned().unwrap_or(json!(0)),
                "panes": pane_counts.get(id).cloned().unwrap_or(json!(0)),
            }),
        );
    }
    for id in pane_counts.keys() {
        workspace_counts.entry(id.clone()).or_insert_with(|| {
            json!({
                "tabs": tab_counts.get(id).cloned().unwrap_or(json!(0)),
                "panes": pane_counts.get(id).cloned().unwrap_or(json!(0)),
            })
        });
    }
    let workspaces_by_id = value
        .pointer(&format!("{base}/workspaces"))
        .and_then(serde_json::Value::as_array)
        .map(|workspaces| {
            let mut map = serde_json::Map::new();
            for workspace in workspaces {
                if let Some(id) = workspace
                    .get("workspace_id")
                    .and_then(serde_json::Value::as_str)
                {
                    map.insert(id.to_string(), workspace.clone());
                }
            }
            serde_json::Value::Object(map)
        })
        .unwrap_or(serde_json::Value::Object(Default::default()));
    // Server-side per-workspace filtering: with a workspace_id param
    // only that workspace's tabs/panes ride the payload (what both
    // clients computed locally after the full snapshot). Counts and
    // workspaces_by_id above already captured the full picture, so the
    // clients keep cross-workspace totals without the full arrays.
    if let Some(workspace_id) = workspace_id {
        filter_snapshot_rows_by_workspace(value, &format!("{base}/tabs"), workspace_id);
        filter_snapshot_rows_by_workspace(value, &format!("{base}/panes"), workspace_id);
    }
    let result = value.get_mut("result").filter(|result| result.is_object());
    if let Some(result) = result {
        result["workspace_order"] = json!(workspace_order);
        result["worktree_results"] = json!(worktree_results);
        result["workspace_counts"] = serde_json::Value::Object(workspace_counts);
        result["workspaces_by_id"] = workspaces_by_id;
        result["tab_labels_by_id"] = serde_json::Value::Object(tab_labels_by_id);
        result["tabs_by_id"] = serde_json::Value::Object(tabs_by_id);
        result["panes_by_id"] = serde_json::Value::Object(panes_by_id);
    }
}

pub(crate) fn workspace_order_key(state: &WebState, headers: &HeaderMap) -> String {
    session_display_name(session_from_headers(state, headers).as_deref()).to_string()
}

pub(crate) fn unix_now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

pub(crate) fn push_recent_workspace(
    recent: &mut Vec<RecentWorkspace>,
    path: &str,
    label: Option<String>,
    branch: Option<String>,
    kind: Option<String>,
) {
    let path = path.trim().to_string();
    if path.is_empty() {
        return;
    }
    let trim = |value: Option<String>| {
        value
            .map(|raw| raw.trim().to_string())
            .filter(|trimmed| !trimmed.is_empty())
    };
    recent.retain(|item| item.path != path);
    recent.insert(
        0,
        RecentWorkspace {
            path,
            label: trim(label),
            branch: trim(branch),
            kind: trim(kind),
            opened_at: Some(unix_now_seconds()),
        },
    );
    recent.truncate(MAX_RECENT_WORKSPACES);
}

pub(crate) async fn record_recent_workspace(
    state: &WebState,
    path: &str,
    label: Option<String>,
    branch: Option<String>,
    kind: Option<String>,
) -> io::Result<()> {
    {
        let Ok(mut guard) = state.server_settings.lock() else {
            return Err(io::Error::other("server settings unavailable"));
        };
        push_recent_workspace(&mut guard.recent_workspaces, path, label, branch, kind);
    }
    persist_server_settings(state).await
}

pub(crate) async fn recent_workspaces(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    // Drop entries whose folder no longer exists so the palette only offers
    // reopenable targets, and persist the pruning so stale paths stay gone.
    // The lock-poisoned arm keeps returning an empty list.
    let snapshot = match state.server_settings.lock() {
        Ok(guard) => guard.recent_workspaces.clone(),
        Err(_) => return Json(json!({ "recent": [] })).into_response(),
    };
    // Existence checks touch the filesystem, so they run outside the lock.
    let missing: Vec<String> = snapshot
        .iter()
        .filter(|item| !Path::new(&expand_user_path_string(&item.path)).is_dir())
        .map(|item| item.path.clone())
        .collect();
    let recent = if missing.is_empty() {
        snapshot
    } else {
        let Ok(mut guard) = state.server_settings.lock() else {
            return Json(json!({ "recent": [] })).into_response();
        };
        guard
            .recent_workspaces
            .retain(|item| !missing.contains(&item.path));
        guard.recent_workspaces.clone()
    };
    if !missing.is_empty() {
        if let Err(err) = persist_server_settings(&state).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response();
        }
    }
    // Derived display fields both clients computed locally (mobile
    // worktrees.js recentCandidates/renderRecentRow, desktop search.js
    // recentWorkspaceCandidates): title = label or path basename, and
    // kind_label = the "worktree"/"workspace" meta word. Additive keys;
    // old clients ignore them.
    let recent = recent
        .into_iter()
        .map(|item| {
            let title = item
                .label
                .clone()
                .filter(|label| !label.trim().is_empty())
                .unwrap_or_else(|| path_basename(&expand_user_path_string(&item.path)));
            let kind_label = if item.kind.as_deref() == Some("worktree") {
                "worktree"
            } else {
                "workspace"
            };
            json!({
                "path": item.path,
                "label": item.label,
                "branch": item.branch,
                "kind": item.kind,
                "opened_at": item.opened_at,
                "title": title,
                "kind_label": kind_label,
            })
        })
        .collect::<Vec<_>>();
    Json(json!({ "recent": recent })).into_response()
}

pub(crate) async fn clear_recent_workspaces(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let cleared = {
        let Ok(mut guard) = state.server_settings.lock() else {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "server settings unavailable" })),
            )
                .into_response();
        };
        let count = guard.recent_workspaces.len();
        guard.recent_workspaces.clear();
        count
    };
    match persist_server_settings(&state).await {
        Ok(()) => Json(json!({ "ok": true, "cleared": cleared })).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

/// Record a workspace the client just opened/created through a
/// non-WebUI path (the TUI talks to the backend socket directly, so
/// its workspace.create/worktree.open flows never pass through the
/// recording proxies). Record-only: like the desktop's fire-and-forget
/// POST after `POST /api/workspaces`, a failed record must never
/// fail the client operation.
pub(crate) async fn record_recent_workspace_endpoint(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<RecordRecentWorkspaceRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    // Validate the raw path BEFORE expanding, matching the remove/open
    // endpoints: empty paths 400 instead of recording the home dir.
    let raw_path = body.path.as_deref().unwrap_or_default();
    if raw_path.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path is required" })),
        )
            .into_response();
    }
    let path = expand_user_path_string(raw_path).trim().to_string();
    match record_recent_workspace(
        &state,
        &path,
        body.label.clone(),
        body.branch.clone(),
        body.kind.clone(),
    )
    .await
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub(crate) async fn remove_recent_workspace(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<RemoveRecentWorkspaceRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    // Validate the raw path BEFORE expanding: an empty or whitespace-only
    // path must 400 instead of expanding "~"/"" into the home directory and
    // silently removing the home workspace entry.
    let raw_path = body.path.as_deref().unwrap_or_default();
    if raw_path.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path is required" })),
        )
            .into_response();
    }
    let path = expand_user_path_string(raw_path).trim().to_string();
    if path.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path is required" })),
        )
            .into_response();
    }
    let removed = {
        let Ok(mut guard) = state.server_settings.lock() else {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "server settings unavailable" })),
            )
                .into_response();
        };
        let count = guard.recent_workspaces.len();
        guard.recent_workspaces.retain(|item| item.path != path);
        count - guard.recent_workspaces.len()
    };
    match persist_server_settings(&state).await {
        Ok(()) => Json(json!({ "ok": true, "removed": removed, "path": path })).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub(crate) struct RecordRecentWorkspaceRequest {
    path: Option<String>,
    label: Option<String>,
    branch: Option<String>,
    kind: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct OpenRecentWorkspaceRequest {
    pub(crate) path: Option<String>,
    pub(crate) label: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) open_terminal: Option<bool>,
}

#[derive(Deserialize)]
pub(crate) struct RemoveRecentWorkspaceRequest {
    path: Option<String>,
}

pub(crate) async fn workspace_order(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let key = workspace_order_key(&state, &headers);
    let order = state
        .workspace_orders
        .lock()
        .ok()
        .and_then(|orders| orders.get(&key).cloned())
        .unwrap_or_default();
    Json(json!({ "order": order })).into_response()
}

pub(crate) async fn set_workspace_order(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<WorkspaceOrderRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let key = workspace_order_key(&state, &headers);
    if let Ok(mut orders) = state.workspace_orders.lock() {
        orders.insert(key, body.order.clone());
    }
    Json(json!({ "ok": true, "order": body.order })).into_response()
}

#[derive(Deserialize)]
pub(crate) struct WorkspaceOrderRequest {
    order: Vec<String>,
}

pub(crate) async fn agents(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:agent:list", "method": "agent.list", "params": {} }),
    )
    .await
}

pub(crate) fn expand_path_prefix(prefix: &str) -> PathBuf {
    if prefix == "~" {
        return home_dir().unwrap_or_else(|_| PathBuf::from(prefix));
    }
    if let Some(rest) = prefix.strip_prefix("~/") {
        return home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|_| PathBuf::from(prefix));
    }
    let path = PathBuf::from(prefix);
    if path.is_absolute() {
        path
    } else {
        home_dir()
            .map(|home| home.join(path))
            .unwrap_or_else(|_| PathBuf::from(prefix))
    }
}

pub(crate) fn expand_user_path_string(path: &str) -> String {
    expand_path_prefix(path).to_string_lossy().to_string()
}

pub(crate) fn list_git_branches(
    cwd: &str,
    include_remote: bool,
    fetch_remote: bool,
) -> Result<Vec<String>, String> {
    let cwd = expand_path_prefix(cwd);
    if fetch_remote {
        let output = crate::git_bin::command()
            .arg("-C")
            .arg(&cwd)
            .args(["fetch", "--all", "--prune"])
            .output()
            .map_err(|err| err.to_string())?;
        if !output.status.success() {
            return Err(git_failure(output, "git fetch"));
        }
    }
    let mut refs = vec!["refs/heads"];
    if include_remote {
        refs.push("refs/remotes");
    }
    let output = crate::git_bin::command()
        .arg("-C")
        .arg(cwd)
        .args(["for-each-ref", "--format=%(refname:short)"])
        .args(refs)
        .output()
        .map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(git_failure(output, "git for-each-ref"));
    }
    let mut branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.ends_with("/HEAD"))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    branches.sort();
    branches.dedup();
    Ok(branches)
}

pub(crate) async fn git_branches(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitBranchesQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let Some(cwd) = query.cwd.as_deref().map(str::to_string) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "cwd is required" })),
        )
            .into_response();
    };
    let remote = query.remote.unwrap_or(false);
    let fetch = query.fetch.unwrap_or(false);
    // list_git_branches runs git subprocesses (potentially git fetch --all)
    // which can block for seconds; offload to avoid stalling the async runtime.
    match tokio::task::spawn_blocking(move || list_git_branches(&cwd, remote, fetch)).await {
        Ok(Ok(branches)) => Json(GitBranchesResponse { branches }).into_response(),
        Ok(Err(err)) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub(crate) async fn tabs(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<WorkspaceQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:tab:list", "method": "tab.list", "params": { "workspace_id": query.workspace_id } }),
    )
    .await
}

pub(crate) async fn panes(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<WorkspaceQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:pane:list", "method": "pane.list", "params": { "workspace_id": query.workspace_id } }),
    )
    .await
}

pub(crate) async fn pane_layout(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<PaneLayoutQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:pane:layout", "method": "pane.layout", "params": { "pane_id": query.pane_id } }),
    )
    .await
}

/// Returns the full backend `session.snapshot` response in one round trip so
/// the frontend can bootstrap workspaces, tabs, panes, layouts, and agents
/// without issuing separate list requests. Extended beyond the raw backend
/// payload with the WebUI-only bootstrap fields: workspace drag order,
/// per-workspace `cwd`/`foreground_cwd` enrichment, and one enriched
/// `worktree.list` result per workspace. All additions are siblings of
/// `result.snapshot`, so the backend envelope itself stays untouched.
pub(crate) async fn session_snapshot(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<SessionSnapshotQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let key = workspace_order_key(&state, &headers);
    let order = state
        .workspace_orders
        .lock()
        .ok()
        .and_then(|orders| orders.get(&key).cloned())
        .unwrap_or_default();
    let workspace_id = query
        .workspace_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    let api = api_for_headers_ensured(&state, &headers).await;
    let worktree_cache = state.worktree_list_cache.clone();
    let response = tokio::task::spawn_blocking(move || {
        let mut value = api.request_value(
            json!({ "id": "web:session:snapshot", "method": "session.snapshot", "params": {} }),
        )?;
        enrich_session_snapshot(
            &mut value,
            &order,
            workspace_id.as_deref(),
            &api,
            &worktree_cache,
        );
        Ok::<_, String>(value)
    })
    .await;
    match response {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub(crate) fn existing_workspace_cwd(cwd: Option<&str>) -> Result<Option<String>, Box<Response>> {
    let Some(cwd) = cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) else {
        return Ok(None);
    };
    let expanded = expand_user_path_string(cwd);
    if !Path::new(&expanded).is_dir() {
        return Err(Box::new(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "workspace folder must exist" })),
            )
                .into_response(),
        ));
    }
    Ok(Some(expanded))
}

pub(crate) async fn create_workspace(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateWorkspaceRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let cwd = match existing_workspace_cwd(body.cwd.as_deref()) {
        Ok(cwd) => cwd,
        Err(response) => return *response,
    };
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:workspace:create", "method": "workspace.create", "params": { "cwd": cwd, "focus": false, "label": body.label, "env": {}, "open_terminal": body.open_terminal } }),
    )
    .await
}

#[derive(Deserialize)]
pub(crate) struct CreateWorkspaceRequest {
    cwd: Option<String>,
    label: Option<String>,
    open_terminal: Option<bool>,
}

pub(crate) async fn rename_workspace(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(body): Json<RenameWorkspaceRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:workspace:rename", "method": "workspace.rename", "params": { "workspace_id": workspace_id, "label": body.label } }),
    )
    .await
}

#[derive(Deserialize)]
pub(crate) struct RenameWorkspaceRequest {
    label: String,
}

pub(crate) async fn close_workspace(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:workspace:close", "method": "workspace.close", "params": { "workspace_id": workspace_id } }),
    )
    .await
}

pub(crate) async fn remove_worktree(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(workspace_id): AxumPath<String>,
    body: Option<Json<RemoveWorktreeRequest>>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let request = HerdrWorktreeApi::remove_request(
        workspace_id,
        body.as_ref().and_then(|body| body.force).unwrap_or(false),
    );
    proxy_request_async(api_for_headers_ensured(&state, &headers).await, request).await
}

#[derive(Deserialize)]
pub(crate) struct RemoveWorktreeRequest {
    force: Option<bool>,
}

pub(crate) async fn create_tab(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateTabRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:tab:create", "method": "tab.create", "params": { "workspace_id": body.workspace_id, "focus": false, "label": body.label, "env": {} } }),
    )
    .await
}

#[derive(Deserialize)]
pub(crate) struct CreateTabRequest {
    workspace_id: Option<String>,
    label: Option<String>,
}

pub(crate) async fn rename_tab(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(tab_id): AxumPath<String>,
    Json(body): Json<RenameTabRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:tab:rename", "method": "tab.rename", "params": { "tab_id": tab_id, "label": body.label } }),
    )
    .await
}

#[derive(Deserialize)]
pub(crate) struct RenameTabRequest {
    label: String,
}

pub(crate) async fn close_tab(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(tab_id): AxumPath<String>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:tab:close", "method": "tab.close", "params": { "tab_id": tab_id } }),
    )
    .await
}

pub(crate) async fn close_pane(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(pane_id): AxumPath<String>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:pane:close", "method": "pane.close", "params": { "pane_id": pane_id } }),
    )
    .await
}

pub(crate) const MAX_RECENT_WORKSPACES: usize = 20;

#[derive(Deserialize)]
pub(crate) struct GitBranchesQuery {
    cwd: Option<String>,
    remote: Option<bool>,
    fetch: Option<bool>,
}

#[derive(Serialize)]
struct GitBranchesResponse {
    branches: Vec<String>,
}

#[derive(Deserialize)]
pub(crate) struct PaneLayoutQuery {
    pane_id: Option<String>,
}

#[derive(Deserialize)]
pub(crate) struct SessionSnapshotQuery {
    /// When set, the snapshot's tabs/panes arrays carry only this
    /// workspace's rows (the filtering the JS clients used to do).
    #[serde(default)]
    workspace_id: Option<String>,
}
