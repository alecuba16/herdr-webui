//! Session lifecycle routes: launch/close/cleanup and the version probes.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::compat::backend_compatibility;
use crate::compat::SimpleVersion;
use crate::WebState;
use std::time::Duration;
const HERDR_INSTALL_CACHE_TTL: Duration = Duration::from_secs(60);

use crate::builtin_backend;
use crate::file_browser;
use crate::local_socket::connect_local_stream;
use crate::protocol::PROTOCOL_VERSION;
use crate::protocol::{MAX_TESTED_BACKEND_VERSION, MIN_BACKEND_VERSION};
use crate::routes::shared::*;
use herdr_webui::HERDR_WEBUI_VERSION;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

pub(crate) async fn sessions(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    // herdr --version is a blocking process spawn (cached 60s in
    // WebState); offload the miss path. The state clone rides the move.
    let install_state = state.clone();
    let herdr_install = tokio::task::spawn_blocking(move || cached_herdr_install(&install_state))
        .await
        .unwrap_or_default();
    // known_sessions() probes every candidate session with a blocking
    // connect_local_stream() (one sync socket connect per session); run it
    // on a blocking thread so a slow or hung socket never stalls the
    // async runtime while the session list is built.
    let probe_state = state.clone();
    let sessions =
        tokio::task::spawn_blocking(move || known_sessions(&probe_state, herdr_install.compatible))
            .await
            .unwrap_or_default();
    Json(json!({
        "backend_mode": state.backend_mode.as_str(),
        "current_backend": backend_target_for_headers(&state, &headers).as_str(),
        // The server's configured default backend (used by tabs to retarget
        // when their pinned backend gets disabled in settings).
        "default_backend": default_backend_target(&state).as_str(),
        "enabled_backends": {
            "builtin": backend_target_enabled(&state, SessionBackendTarget::Builtin),
            "external-herdr": backend_target_enabled(&state, SessionBackendTarget::ExternalHerdr),
        },
        // External herdr sessions are only offered when the installed herdr
        // binary is detected AND compatible with this WebUI build.
        "herdr_available": herdr_install.available(),
        "herdr_compatible": herdr_install.compatible,
        "herdr_version": herdr_install.version,
        // How many of the listed sessions actually answer a socket probe;
        // the footer indicator shows this count next to the session name.
        "running_count": sessions
            .iter()
            .filter(|session| session.get("running").and_then(serde_json::Value::as_bool) == Some(true))
            .count(),
        "sessions": sessions,
    }))
    .into_response()
}

pub(crate) async fn versions(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let session = session_from_headers(&state, &headers);
    let current_backend = backend_target_for_headers(&state, &headers);
    let api = api_for_headers(&state, &headers);
    // backend_info() does a blocking ping; offload to avoid stalling the runtime.
    let backend = tokio::task::spawn_blocking(move || api.backend_info())
        .await
        .unwrap_or_default();
    let compatibility = if current_backend == SessionBackendTarget::Builtin {
        BackendCompatibility::Compatible
    } else {
        backend_compatibility_for_supported_range(backend.version.as_deref(), backend.protocol)
    };
    let compatibility_message = if current_backend == SessionBackendTarget::Builtin {
        "built-in backend is embedded in this WebUI process"
    } else {
        compatibility.message(backend.version.as_deref())
    };
    // Report the installed external herdr binary so clients can decide
    // whether external sessions may be offered at all.
    let herdr_bin = state.herdr_bin.clone();
    let herdr_install = tokio::task::spawn_blocking(move || detect_herdr_install(&herdr_bin))
        .await
        .unwrap_or_default();
    let default_backend = default_backend_target(&state);
    Json(json!({
        "webui": HERDR_WEBUI_VERSION,
        "backend": backend.version,
        "backend_mode": state.backend_mode.as_str(),
        "current_backend": current_backend.as_str(),
        "default_backend": default_backend.as_str(),
        // Enabled flags so browsers can stop targeting/offering a backend
        // that was disabled in settings mid-session.
        "enabled_backends": {
            "builtin": backend_target_enabled(&state, SessionBackendTarget::Builtin),
            "external-herdr": backend_target_enabled(&state, SessionBackendTarget::ExternalHerdr),
        },
        "session": session_display_name(session.as_deref()),
        "protocol_version": PROTOCOL_VERSION,
        "min_protocol_version": MIN_SUPPORTED_PROTOCOL_VERSION,
        "backend_protocol_version": backend.protocol,
        "min_backend": MIN_BACKEND_VERSION,
        "max_tested_backend": MAX_TESTED_BACKEND_VERSION,
        "herdr_install": {
            "available": herdr_install.available(),
            "compatible": herdr_install.compatible,
            "version": herdr_install.version,
            "path": state.herdr_bin,
        },
        // fzf detection result from the boot probe; the settings search
        // section surfaces it so the user knows which ranker is active.
        "fzf_available": file_browser::fzf_available(),
        "compatibility": {
            "status": compatibility.as_str(),
            "compatible": compatibility == BackendCompatibility::Compatible,
            "message": compatibility_message,
        }
    }))
    .into_response()
}

#[derive(Default, Deserialize)]
pub(crate) struct SessionActionRequest {
    session: Option<String>,
    backend: Option<String>,
}

pub(crate) fn requested_session_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-herdr-session")
        .and_then(|value| value.to_str().ok())
}

pub(crate) fn action_session(
    state: &WebState,
    headers: &HeaderMap,
    body: &SessionActionRequest,
) -> Option<String> {
    request_session_name(
        state,
        body.session
            .as_deref()
            .or_else(|| requested_session_from_headers(headers)),
    )
}

pub(crate) fn action_backend(
    state: &WebState,
    headers: &HeaderMap,
    body: &SessionActionRequest,
) -> SessionBackendTarget {
    body.backend
        .as_deref()
        .and_then(SessionBackendTarget::parse)
        .unwrap_or_else(|| backend_target_for_headers(state, headers))
}

pub(crate) fn ensure_builtin_session(
    state: &WebState,
    session: Option<&str>,
) -> Result<(), String> {
    let session_name = canonical_session_name(session);
    // Closed means closed: a user-closed session must not be resurrected by
    // workspace proxying, the events socket, or the terminal auto-start.
    // Only an explicit /api/session/launch clears the marker and starts it.
    if state
        .closed_builtin_sessions
        .lock()
        .map(|closed| closed.contains(&session_name))
        .unwrap_or(false)
    {
        return Ok(());
    }
    if state
        .builtin_sessions
        .lock()
        .map(|sessions| {
            sessions
                .get(&session_name)
                .is_some_and(|handle| handle.is_running())
        })
        .unwrap_or(false)
    {
        return Ok(());
    }
    // Serialize cold starts across threads: with auto-start on workspace
    // requests, a fresh browser fires several requests at once and two
    // concurrent starts would race on the session socket bind. Must run on
    // a blocking thread (callers already use spawn_blocking).
    let _start_guard = state
        .builtin_start_lock
        .lock()
        .map_err(|_| "built-in session start lock unavailable".to_string())?;
    // A dead registered handle (crashed listeners, stale socket files) must
    // be evicted so a fresh backend starts below; otherwise every proxied
    // request 502s forever against the corpse.
    state
        .builtin_sessions
        .lock()
        .map(|mut sessions| {
            if sessions
                .get(&session_name)
                .is_some_and(|handle| !handle.is_running())
            {
                sessions.remove(&session_name);
            }
        })
        .ok();
    let (api_socket, client_socket) = builtin_socket_paths(Some(&session_name));
    // The journal lives in the canonical session directory (not the /tmp
    // socket fallback), so cleanup and explicit close always find it.
    let journal_dir = Some(builtin_session_dir(Some(&session_name)));
    if connect_local_stream(&api_socket).is_ok() {
        return Ok(());
    }
    let shell = state
        .server_settings
        .lock()
        .ok()
        .and_then(|settings| settings.builtin_shell.clone());
    let handle =
        builtin_backend::BuiltinBackendHandle::start(builtin_backend::BuiltinBackendConfig {
            api_socket,
            client_socket,
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            shell,
            jcode_detection_variant: state
                .server_settings
                .lock()
                .ok()
                .map(|settings| settings.jcode_detection_variant)
                .unwrap_or_default(),
            journal_dir,
        })
        .map_err(|err| err.to_string())?;
    state
        .builtin_sessions
        .lock()
        .map_err(|_| "built-in session registry unavailable".to_string())?
        .insert(session_name, Arc::new(handle));
    Ok(())
}

pub(crate) async fn launch_session(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    body: Option<Json<SessionActionRequest>>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let session = action_session(&state, &headers, &body);
    let backend = action_backend(&state, &headers, &body);
    if !backend_target_enabled(&state, backend) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "backend": backend.as_str(),
                "error": "backend type is disabled in settings",
            })),
        )
            .into_response();
    }
    if backend == SessionBackendTarget::ExternalHerdr {
        // Only launch external herdr sessions when the installed binary is
        // detected and compatible; anything else is guaranteed to fail its
        // handshake against this WebUI build.
        let herdr_bin = state.herdr_bin.clone();
        let install = tokio::task::spawn_blocking(move || detect_herdr_install(&herdr_bin))
            .await
            .unwrap_or_default();
        if !install.available() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "ok": false,
                    "backend": backend.as_str(),
                    "error": format!(
                        "herdr binary not found ({}); install herdr {} or newer to use external Herdr sessions",
                        state.herdr_bin,
                        MIN_BACKEND_VERSION,
                    ),
                })),
            )
                .into_response();
        }
        if !install.compatible {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "ok": false,
                    "backend": backend.as_str(),
                    "error": format!(
                        "installed herdr {} is not compatible with this WebUI build (requires {}); upgrade herdr or use a built-in session",
                        install.version.unwrap_or_default(),
                        MIN_BACKEND_VERSION,
                    ),
                })),
            )
                .into_response();
        }
    }
    if backend == SessionBackendTarget::Builtin {
        // An explicit launch revives the session: clear the closed marker so
        // ensure_builtin_session (and every later auto-start) can run again.
        let canonical = canonical_session_name(session.as_deref());
        if let Ok(mut closed) = state.closed_builtin_sessions.lock() {
            closed.remove(&canonical);
        }
        // ensure_builtin_session does socket connect and process spawning;
        // offload to avoid stalling the async runtime.
        let state_clone = state.clone();
        let session_clone = session.clone();
        let result = tokio::task::spawn_blocking(move || {
            ensure_builtin_session(&state_clone, session_clone.as_deref())
        })
        .await;
        return match result {
            Ok(Ok(())) => Json(json!({
                "ok": true,
                "backend": backend.as_str(),
                "session": session_display_name(session.as_deref()),
            }))
            .into_response(),
            Ok(Err(err)) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "ok": false, "error": err })),
            )
                .into_response(),
            Err(err) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "ok": false, "error": err.to_string() })),
            )
                .into_response(),
        };
    }
    // command.spawn() is a blocking fork+exec; offload it.
    let herdr_bin = state.herdr_bin.clone();
    let session_name = session.clone();
    let spawn_result = tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new(&herdr_bin);
        command
            .arg("server")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env_remove("HERDR_SOCKET_PATH")
            .env_remove("HERDR_CLIENT_SOCKET_PATH");
        if let Some(session) = session_name.as_deref().filter(|value| *value != "default") {
            command.env("HERDR_SESSION", session);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command.spawn()
    })
    .await;
    match spawn_result {
        Ok(Ok(child)) => Json(json!({
            "ok": true,
            "pid": child.id(),
            "backend": backend.as_str(),
            "session": session_display_name(session.as_deref()),
        }))
        .into_response(),
        Ok(Err(err)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub(crate) async fn close_session(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    body: Option<Json<SessionActionRequest>>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let session = action_session(&state, &headers, &body);
    let backend = action_backend(&state, &headers, &body);
    if !backend_target_enabled(&state, backend) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "backend": backend.as_str(),
                "error": "backend type is disabled in settings",
            })),
        )
            .into_response();
    }
    if backend == SessionBackendTarget::Builtin {
        let session_name = canonical_session_name(session.as_deref());
        let api = api_for_target_session(&state, backend, session.as_deref());
        let response = proxy_server_stop(api).await;
        let stopped = response.status().is_success();
        if let Ok(mut sessions) = state.builtin_sessions.lock() {
            sessions.remove(&session_name);
        }
        if stopped {
            mark_closed_builtin_session(&state, &session_name);
        }
        return response;
    }
    let api = api_for_target_session(&state, backend, session.as_deref());
    proxy_server_stop(api).await
}

/// Record a successful built-in session close and remove its on-disk residue.
///
/// Close is destructive and final until an explicit relaunch: the marker stops
/// every auto-start path (workspace proxying, events socket, terminal) from
/// resurrecting the stopped backend, the socket files are deleted so no
/// stale connect target remains, and the session's `builtin/<name>` directory
/// is removed once empty so the session disappears from the manager list
/// (known_builtin_sessions discovers sessions there). The `default` directory
/// is never removed: closing the default session must not delete the slot
/// fresh sessions relaunch into. All filesystem steps are best-effort; the
/// close itself already succeeded.
fn mark_closed_builtin_session(state: &WebState, session_name: &str) {
    if let Ok(mut closed) = state.closed_builtin_sessions.lock() {
        closed.insert(session_name.to_string());
    }
    let (api_socket, client_socket) = builtin_socket_paths(Some(session_name));
    for socket in [&api_socket, &client_socket] {
        let _ = fs::remove_file(socket);
    }
    // The recovery journal dies with the session, including the default
    // slot whose directory is never removed: a relaunch must start empty,
    // not resurrect the workspaces the close just removed.
    let _ = fs::remove_file(
        builtin_session_dir(Some(session_name)).join(builtin_backend::SESSION_JOURNAL_FILE),
    );
    if session_name == "default" {
        return;
    }
    // Close is final for tab data too: drop the panes sidecar (panel tab
    // ids) and the warm store entry, or a same-name relaunch would
    // resurrect the closed session's panels pointing at dead tabs. The
    // default slot keeps its sidecar so a fresh default boot keeps the
    // empty rail shape.
    workspace_panes_store::cleanup_session_entry(&state.panes_store, session_name);
    // The session slot may exist in two places when the socket pair fell
    // back to /tmp: the canonical dir (journal) and the fallback dir
    // (sockets). Both must go when empty, or a hollow dir keeps the
    // session listed and a stale journal resurrects it later.
    let canonical_dir = builtin_session_dir(Some(session_name));
    let socket_dir = api_socket
        .parent()
        .filter(|dir| *dir != canonical_dir)
        .map(Path::to_path_buf);
    let mut dirs = vec![canonical_dir];
    if let Some(socket_dir) = socket_dir {
        dirs.push(socket_dir);
    }
    for dir in dirs {
        let empty = fs::read_dir(&dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if empty {
            let _ = fs::remove_dir(&dir);
        }
    }
}

/// Directory names under `builtin/` that a cleanup must never remove.
/// `default` is the slot fresh sessions relaunch into (see
/// mark_closed_builtin_session), and a live in-process handle means the
/// backend is running right now.
fn cleanup_safe_builtin_names(state: &WebState) -> HashSet<String> {
    let mut safe = HashSet::new();
    safe.insert("default".to_string());
    if let Ok(sessions) = state.builtin_sessions.lock() {
        safe.extend(sessions.keys().cloned());
    }
    safe
}

/// Removes one stale built-in session directory: the socket files inside
/// (crashed backends leave dead-listener sockets behind, which keep the
/// row listed as offline forever) and then the directory itself. Returns
/// true when the session is fully gone afterwards.
fn cleanup_builtin_session_dir(session_name: &str) -> bool {
    let (api_socket, client_socket) = builtin_socket_paths(Some(session_name));
    for socket in [&api_socket, &client_socket] {
        if socket.is_file() {
            let _ = fs::remove_file(socket);
        }
    }
    // Remove both homes (canonical journal dir plus /tmp socket fallback
    // when they differ): a leftover dead socket or stale journal would
    // keep the session listed or resurrect closed workspaces on relaunch.
    let canonical_dir = builtin_session_dir(Some(session_name));
    let mut removed = fs::remove_dir_all(&canonical_dir).is_ok();
    if let Some(socket_dir) = api_socket.parent().filter(|dir| *dir != canonical_dir) {
        removed |= fs::remove_dir_all(socket_dir).is_ok();
    }
    removed
}

/// Deletes stale built-in sessions: directories under `builtin/` whose
/// backend is not running (socket connect fails), excluding `default` (the
/// relaunch slot) and any session with a live in-process handle. This is the
/// server half of the manager's "Clean up closed sessions" button; a
/// crashed backend leaves a dead socket file behind, and those leftovers are
/// exactly what accumulates as "old closed sessions" in the list.
pub(crate) async fn cleanup_sessions(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    body: Option<Json<SessionActionRequest>>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let backend = action_backend(&state, &headers, &body);
    if backend != SessionBackendTarget::Builtin {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "backend": backend.as_str(),
                "error": "cleanup is only supported for built-in sessions",
            })),
        )
            .into_response();
    }
    if !backend_target_enabled(&state, backend) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "backend": backend.as_str(),
                "error": "backend type is disabled in settings",
            })),
        )
            .into_response();
    }
    // Probe + remove runs one blocking connect and filesystem ops per
    // session; keep it off the async runtime like the other session probes.
    let probe_state = state.clone();
    let (removed, kept_running, kept_default, swept_orphans) =
        tokio::task::spawn_blocking(move || {
            let safe = cleanup_safe_builtin_names(&probe_state);
            let sessions_dir = builtin_socket_paths(Some("default"))
                .0
                .parent()
                .and_then(Path::parent)
                .map(Path::to_path_buf)
                .unwrap_or_else(|| config_dir().join("builtin"));
            let mut removed = Vec::new();
            let mut kept_running = 0usize;
            let mut kept_default = 0usize;
            let Ok(entries) = fs::read_dir(&sessions_dir) else {
                return (removed, kept_running, kept_default, Vec::new());
            };
            let mut names = Vec::new();
            for entry in entries.filter_map(Result::ok) {
                if !entry.path().is_dir() {
                    continue;
                }
                if let Ok(name) = entry.file_name().into_string() {
                    names.push(name);
                }
            }
            names.sort();
            let all_dir_names = names.clone();
            for name in names {
                // The default slot is the relaunch target for every fresh
                // session and the empty-socket state is normal there: never
                // remove it.
                if name == "default" {
                    kept_default += 1;
                    continue;
                }
                // Non-default session names are always safe_socket_component
                // output, so a different canonical name means the directory is
                // not a session slot; leave it alone.
                if name != canonical_session_name(Some(&name)) {
                    continue;
                }
                if safe.contains(&name) {
                    kept_running += 1;
                    continue;
                }
                let (api_socket, _) = builtin_socket_paths(Some(&name));
                if connect_local_stream(&api_socket).is_ok() {
                    kept_running += 1;
                    continue;
                }
                if cleanup_builtin_session_dir(&name) {
                    removed.push(name);
                }
            }
            // Orphan sweep: sidecars whose session dir is already gone (close
            // and the loop above both remove dirs) were unreachable before this
            // pass, and header-routed panes ops can create sidecars for sessions
            // that never had a backend at all.
            let swept_orphans = workspace_panes_store::sweep_orphan_panes_sidecars(
                &probe_state.panes_store,
                &safe,
                &all_dir_names,
                |name| {
                    let (api_socket, _) = builtin_socket_paths(Some(name));
                    api_socket.parent().map(Path::to_path_buf)
                },
            );
            (removed, kept_running, kept_default, swept_orphans)
        })
        .await
        // A dead probe task (panic or runtime shutdown) must still answer the
        // route: an empty result reports nothing removed, nothing kept.
        .unwrap_or_default();
    debug_assert!(kept_default <= 1, "default session dir is never removed");
    let mut removed_count = 0usize;
    if let Ok(mut closed) = state.closed_builtin_sessions.lock() {
        for name in &removed {
            closed.remove(name);
            // Also drop each removed session's panes sidecar and in-memory
            // store entry, or a same-name relaunch would resurrect its old
            // panels (the sidecar survives the socket-dir cleanup).
            workspace_panes_store::cleanup_session_entry(&state.panes_store, name);
        }
        removed_count = removed.len();
        // Swept orphans never had a closed marker or a store entry that
        // matters anymore, but a same-name relaunch must not find the
        // evicted sidecar in the warm map either.
        for name in &swept_orphans {
            closed.remove(name);
        }
    }
    Json(json!({
        "ok": true,
        "removed": removed,
        "removed_count": removed_count,
        "kept_running_count": kept_running,
        "swept_orphans": swept_orphans,
    }))
    .into_response()
}

/// Sends `server.stop` to the backend and treats a connection drop as success.
///
/// The backend may close the socket before sending a response (or send a
/// partial/truncated one) because it is shutting down. That manifests as an
/// `UnexpectedEof` or `ConnectionReset` error from `read_json_line`, which
/// `proxy_request` would turn into a 502 Bad Gateway. For a stop command that
/// is the expected outcome, so we return ok instead.
///
/// Runs the blocking socket I/O on a `spawn_blocking` thread so it does not
/// stall the async runtime (and by extension, active WebSocket loops) while
/// waiting for the backend to respond or drop the connection.
pub(crate) async fn proxy_server_stop(api: ApiClient) -> Response {
    // Linux also returns ECONNREFUSED when the socket path is not a socket
    // file at all; the dead-listener classification below checks the file
    // type, which needs the unix extension trait in scope.
    #[cfg(unix)]
    use std::os::unix::fs::FileTypeExt;
    // Capture before `api` moves into the closure below: the path must be
    // an actual socket file for ECONNREFUSED to count as a dead listener
    // (Linux also refuses non-socket paths with ECONNREFUSED).
    let socket_path_is_socket = api
        .backend
        .api_socket()
        .metadata()
        .map(|meta| meta.file_type().is_socket())
        .unwrap_or(false);
    let request = json!({ "id": "web:server:stop", "method": "server.stop", "params": {} });
    match tokio::task::spawn_blocking(move || api.request_value(request)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => {
            // The backend may have died without removing its socket file
            // (crash, kill -9). Removing a stale session row must still
            // count as success: there is nothing left to stop. LocalStream
            // connect surfaces a missing socket path as ENOENT ("No such
            // file or directory"). A dead listener with the socket file
            // still bound surfaces as ECONNREFUSED ("Connection refused"),
            // the same stale-row case: the path exists but nobody accepts.
            let is_missing_socket = err.contains("No such file or directory");
            // Linux also returns ECONNREFUSED when the path is not a socket
            // file at all (a regular file, a directory...), which is a real
            // error, not a crashed backend. Only a socket file nobody accepts
            // on is a dead listener. macOS surfaces non-socket paths as
            // ENOTSOCK ("Socket type not supported") instead, so the gate
            // only changes behavior for the misconfigured-path class.
            let is_dead_listener = (err.contains("Connection refused")
                || err.contains("ConnectionRefused"))
                && socket_path_is_socket;
            let is_connection_drop = err.contains("empty response")
                || err.contains("closed the control socket")
                || err.contains("UnexpectedEof")
                || err.contains("ConnectionReset")
                || err.contains("Connection reset")
                || err.contains("broken pipe")
                || err.contains("Broken pipe");
            if is_missing_socket || is_dead_listener {
                Json(json!({ "ok": true, "already_stopped": true })).into_response()
            } else if is_connection_drop {
                Json(json!({ "ok": true })).into_response()
            } else {
                (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response()
            }
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub(crate) async fn proxy_request_async(api: ApiClient, request: serde_json::Value) -> Response {
    match tokio::task::spawn_blocking(move || api.request_value(request)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub(crate) fn backend_compatibility_for_supported_range(
    backend: Option<&str>,
    protocol: Option<u32>,
) -> BackendCompatibility {
    backend_compatibility(
        backend,
        protocol,
        MIN_SUPPORTED_PROTOCOL_VERSION,
        PROTOCOL_VERSION,
        MIN_BACKEND_VERSION,
        MAX_TESTED_BACKEND_VERSION,
    )
}

pub(crate) fn cached_herdr_install(state: &WebState) -> HerdrInstall {
    if let Ok(guard) = state.herdr_install_cache.lock() {
        if let Some((at, install)) = guard.as_ref() {
            if at.elapsed() < HERDR_INSTALL_CACHE_TTL {
                return install.clone();
            }
        }
    }
    let install = detect_herdr_install(&state.herdr_bin);
    if let Ok(mut guard) = state.herdr_install_cache.lock() {
        *guard = Some((std::time::Instant::now(), install.clone()));
    }
    install
}

pub(crate) fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("herdr");
    }
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".config/herdr"))
        .unwrap_or_else(|_| std::env::temp_dir().join("herdr"))
}

pub(crate) fn request_session_name(state: &WebState, requested: Option<&str>) -> Option<String> {
    requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| *value != "default")
        .map(str::to_string)
        .or_else(|| state.session_name.clone())
}

/// Runs `herdr --version` and classifies the install against the supported
/// backend version range. Blocking (process spawn); call from a blocking
/// context.
pub(crate) fn detect_herdr_install(herdr_bin: &str) -> HerdrInstall {
    let output = std::process::Command::new(herdr_bin)
        .arg("--version")
        .output();
    let Ok(output) = output else {
        return HerdrInstall::default();
    };
    if !output.status.success() {
        return HerdrInstall::default();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // Accept both "herdr 0.9.0" and a bare "0.9.0".
    let version = text.split_whitespace().find_map(|token| {
        SimpleVersion::parse(token).map(|_| token.trim_start_matches('v').to_string())
    });
    let Some(version) = version else {
        return HerdrInstall::default();
    };
    // `herdr --version` gives us no protocol number, so classify by version
    // range alone: below MIN_BACKEND_VERSION is unusable, anything newer is
    // offered as untested (matching the versions API).
    let parsed = SimpleVersion::parse(&version);
    let min = SimpleVersion::parse(MIN_BACKEND_VERSION);
    let compatible = matches!(
        (parsed, min),
        (Some(parsed), Some(min)) if parsed >= min
    );
    HerdrInstall {
        version: Some(version),
        compatible,
    }
}

/// Installed external herdr binary state, used to decide whether the UI may
/// offer external-herdr sessions at all.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct HerdrInstall {
    /// Parsed `herdr --version` output, e.g. "herdr 0.9.0".
    pub(crate) version: Option<String>,
    /// True when the binary was found and its version is inside the
    /// supported backend range for this WebUI build.
    pub(crate) compatible: bool,
}

impl HerdrInstall {
    pub(crate) fn available(&self) -> bool {
        self.version.is_some()
    }
}
