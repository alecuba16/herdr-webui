//! WebSocket bridges: events, terminal, terminal-graphics.

use std::net::SocketAddr;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Query, State};
use axum::http::HeaderMap;
use axum::response::Response;
use serde::Deserialize;
use serde_json::json;

use crate::protocol::PaneSurfaceFrame;
use crate::protocol::{read_message, write_message, ClientMessage, ServerMessage};
use crate::protocol::{AttachScrollDirection, AttachScrollSource};
use crate::protocol::{ClientSurfaceSize, SurfaceGraphicsAssetKey, SurfaceGraphicsPlacement};
use crate::routes::shared::*;
use crate::server_settings::log_event;
use crate::terminal_hub;
use crate::WebState;
use herdr_webui::local_socket::{connect_local_stream, LocalStream};
use herdr_webui::socket_paths::socket_path_fits;
use herdr_webui::socket_paths::SOCKET_PATH_LIMIT;
use interprocess::TryClone as _;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

pub(crate) async fn events_ws(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<SessionQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    // Auth is checked once, at the upgrade handshake. An open websocket
    // keeps streaming after the session that opened it is revoked (logout,
    // expiry, credential change); the next upgrade with that cookie 401s.
    // Same lifetime boundary as every handshake-authenticated socket.
    // (Validated live in W34a: frames continue post-revocation.)
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    log_event(
        &state.log_level(),
        &format!("websocket: events connection from {remote}"),
    );
    let api = api_for_query_session_ensured(
        &state,
        &headers,
        query.session.as_deref(),
        query.backend.as_deref(),
    )
    .await;
    // Shared panes frames are per-session: the broadcast carries the
    // session name and each socket drops frames from other sessions.
    let panes_session = canonical_session_name(query.session.as_deref());
    ws.on_upgrade(move |socket| events_socket(state, api, socket, panes_session))
}

pub(crate) async fn events_socket(
    state: WebState,
    api: ApiClient,
    mut socket: WebSocket,
    panes_session: String,
) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    // Settings changes must reach open tabs immediately: a backend disabled
    // mid-session stops being targeted/offered without a page reload.
    let mut settings_rx = state.settings_tx.subscribe();
    // Notes mutations broadcast the full snapshot; receivers that lag a
    // burst miss frames and self-heal on the next panel-open GET.
    let mut notes_rx = state.notes_tx.subscribe();
    // Shared panes mutations broadcast the full session entry the same
    // way; the session filter below keeps other sessions' frames out.
    let mut panes_rx = state.panes_store.tx.subscribe();
    let subscribe_api = api.clone();
    // backend_info() does a blocking ping over a Unix socket; run it on a
    // blocking thread so it does not stall the async runtime while waiting
    // for the backend to respond (or time out) during connection setup.
    let backend_info_api = api.clone();
    let backend_info = tokio::task::spawn_blocking(move || backend_info_api.backend_info())
        .await
        .unwrap_or_default();
    let backend_protocol = backend_info.protocol;
    // Push channel for LSP diagnostics (C1): the registry broadcasts every
    // publishDiagnostics batch and we forward it to connected UIs. Receivers
    // that lag a burst simply miss those batches; diagnostics are full-state
    // snapshots so the next event restores the view.
    let mut lsp_rx = state.lsp.subscribe_diagnostics();
    std::thread::spawn(move || {
        // Detect the backend protocol so we only subscribe to layout.updated
        // on protocol 16+. Older backends reject unknown subscription types
        // and would fail the entire events.subscribe request.
        let mut subscriptions = vec![
            json!({"type":"workspace.created"}),
            json!({"type":"workspace.updated"}),
            json!({"type":"workspace.renamed"}),
            json!({"type":"workspace.closed"}),
            json!({"type":"workspace.focused"}),
            json!({"type":"worktree.created"}),
            json!({"type":"worktree.opened"}),
            json!({"type":"worktree.removed"}),
            json!({"type":"tab.created"}),
            json!({"type":"tab.closed"}),
            json!({"type":"tab.focused"}),
            json!({"type":"tab.renamed"}),
            json!({"type":"pane.created"}),
            json!({"type":"pane.closed"}),
            json!({"type":"pane.focused"}),
            json!({"type":"pane.moved"}),
            json!({"type":"pane.exited"}),
            json!({"type":"pane.agent_detected"}),
        ];
        // pane.agent_status_changed is deliberately absent: every herdr
        // 0.9.x external daemon requires a pane_id on it (no wildcard
        // exists; the poll loop filters pane_id != subscribed pane_id), so a
        // bare entry made the daemon reject the WHOLE events.subscribe
        // request and the events loop resubscribed forever with zero events
        // (verified live against 0.9.5: "missing field pane_id"). The
        // builtin backend ignores subscription params, and the browser
        // falls back to the agents row it refreshes from snapshot data
        // (paneStatusEvents TTL), so external mode loses nothing.
        if backend_protocol.unwrap_or(0) >= 16 {
            subscriptions.push(json!({"type":"layout.updated"}));
        }
        let request = json!({
            "id": "web:events",
            "method": "events.subscribe",
            "params": { "subscriptions": subscriptions }
        });
        // The backend subscription can fail while the socket itself is fine
        // (external herdr daemon died, backend restarting). The events socket
        // also carries server-level frames (server_settings_changed, lsp
        // diagnostics) that must NOT die with the backend: keep retrying the
        // subscription with a backoff instead of dropping `tx`, which would
        // close the whole WebSocket and make tabs miss one-shot settings
        // broadcasts during the reconnect gap (they would stay pinned to a
        // backend disabled in settings until the next manual refresh).
        let mut backoff_secs = 1u64;
        loop {
            match subscribe_api.subscribe(request.clone()) {
                Ok(mut stream) => {
                    let _ = tx.send(json!({ "type": "ready" }));
                    let subscribed_at = std::time::Instant::now();
                    loop {
                        match stream.next_value() {
                            Ok(Some(value)) => {
                                // herdr 0.9.2+ (upstream #4225) reports a
                                // subscription that fell behind retained history
                                // with an error frame `{error:{code:
                                // "events_lost"}}` and then closes the stream.
                                // Silent gaps would desync the UI, so break and
                                // resubscribe; the backoff reset below makes the
                                // resync fast, and the browser refresh rebuilds
                                // state from session.snapshot.
                                if value.get("error").and_then(|error| error.get("code"))
                                    == Some(&serde_json::json!("events_lost"))
                                {
                                    break;
                                }
                                if tx.send(json!({ "type": "event", "event": value })).is_err() {
                                    return;
                                }
                            }
                            Ok(None) => break,
                            Err(err) => {
                                let _ = tx.send(json!({
                                    "type": "error",
                                    "message": err.to_string()
                                }));
                                break;
                            }
                        }
                    }
                    // A stream that stayed healthy for a while proves the
                    // backend was up; a quick subsequent failure is a flap,
                    // not an outage, so reconnect fast instead of waiting
                    // out a 30s backoff grown during the outage.
                    if subscribed_at.elapsed() >= std::time::Duration::from_secs(10) {
                        backoff_secs = 1;
                    }
                }
                Err(err) => {
                    // Carry the subscribe() detail ("events.subscribe
                    // rejected: ...", connect error) instead of a generic
                    // string: the browser console is the only place a
                    // rejected subscription becomes diagnosable.
                    let _ = tx.send(json!({ "type": "error", "message": err.to_string() }));
                }
            }
            // The WebSocket consumer went away; stop retrying.
            if tx.is_closed() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(backoff_secs));
            backoff_secs = (backoff_secs * 2).min(30);
        }
    });

    loop {
        tokio::select! {
            // When the subscription thread exits (backend died), it drops tx
            // and rx.recv() returns None. Break so the WebSocket closes and the
            // client can reconnect to a fresh backend instead of hanging.
            value = rx.recv() => {
                let Some(value) = value else { break; };
                if web_event_kind(&value) == Some("pane.agent_status_changed") {
                    // Use the event payload directly instead of calling agent.list
                    // This avoids recomputing all pane statuses on every status change
                    if let Some(event) = value.get("event") {
                        if let Some(data) = event.get("data") {
                            if let Some(status) = data.get("agent_status").and_then(|s| s.as_str()) {
                                let has_working = status == "working";
                                let cooldown = state
                                    .server_settings
                                    .lock()
                                    .map(|settings| settings.no_sleep_auto_cooldown_seconds)
                                    .unwrap_or(60);
                                if let Ok(mut no_sleep) = state.no_sleep.lock() {
                                    sync_auto_no_sleep(&mut no_sleep, has_working, cooldown);
                                }
                            }
                        }
                    }
                }
                if socket.send(Message::Text(value.to_string().into())).await.is_err() { break; }
            }
            lsp_event = lsp_rx.recv() => {
                let Ok(event) = lsp_event else { break; };
                let value = json!({
                    "type": "event",
                    "event": {
                        "type": "lsp.diagnostics",
                        "event": "lsp.diagnostics",
                        "data": event,
                    }
                });
                if socket.send(Message::Text(value.to_string().into())).await.is_err() { break; }
            }
            settings = settings_rx.recv() => {
                let Ok(settings) = settings else { break; };
                if socket.send(Message::Text(settings.to_string().into())).await.is_err() { break; }
            }
            notes = notes_rx.recv() => {
                let Ok(notes) = notes else { break; };
                if socket.send(Message::Text(notes.to_string().into())).await.is_err() { break; }
            }
            panes = panes_rx.recv() => {
                let Ok(panes) = panes else { break; };
                // Per-session gate: the shared panes entry belongs to one
                // herdr session; a socket pinned to another session must
                // not repaint from it.
                if panes.get("session").and_then(serde_json::Value::as_str) == Some(panes_session.as_str()) {
                    let mut frame = panes.clone();
                    frame["type"] = serde_json::json!("workspace_panes_changed");
                    if socket.send(Message::Text(frame.to_string().into())).await.is_err() { break; }
                }
            }
            message = socket.recv() => {
                if message.is_none() { break; }
            }
        }
    }
}

pub(crate) fn web_event_kind(value: &serde_json::Value) -> Option<&str> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("event") {
        return None;
    }
    let event = value.get("event")?;
    event
        .get("event")
        .or_else(|| event.get("type"))
        .and_then(serde_json::Value::as_str)
}

pub(crate) async fn terminal_ws(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<TerminalQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    log_event(
        &state.log_level(),
        &format!("websocket: terminal connection from {remote}"),
    );
    let client_socket_path = client_socket_for_query_session(
        &state,
        &headers,
        query.session.as_deref(),
        query.backend.as_deref(),
    );
    // The resolved backend for the herdr_error frame: the server reroutes
    // disabled/absent pins to the remaining enabled backend, so the browser
    // must know which backend actually failed instead of blaming its stale pin.
    let attach_backend = backend_target_for_query(&state, &headers, query.backend.as_deref());
    let api = api_for_query_session_ensured(
        &state,
        &headers,
        query.session.as_deref(),
        query.backend.as_deref(),
    )
    .await;
    ws.on_upgrade(move |socket| {
        let promoted_temporary_tabs = state.promoted_temporary_tabs.clone();
        terminal_socket(
            client_socket_path,
            api,
            attach_backend,
            query,
            socket,
            promoted_temporary_tabs,
            state.terminal_hub.clone(),
        )
    })
}

pub(crate) async fn terminal_socket(
    path: PathBuf,
    api: ApiClient,
    backend: SessionBackendTarget,
    query: TerminalQuery,
    mut socket: WebSocket,
    promoted_temporary_tabs: PromotedTemporaryTabs,
    hub: Arc<terminal_hub::TerminalHub>,
) {
    let terminal_id = query.terminal_id.clone();
    let cols = query.cols.unwrap_or(100).max(1);
    let rows = query.rows.unwrap_or(30).max(1);
    // Per-connection flag armed by the browser's release toggle after a
    // successful promote. When armed, teardown skips the temporary-tab
    // auto-close: the tab now belongs to a real workspace and the overlay
    // is tearing down without closing it.
    let mut release_armed = false;
    // Guard parity with the built-in backend's socket_path_pair_fits: an
    // external session whose socket path exceeds the OS limit can never
    // attach (connect() fails with a confusing ENAMETOOLONG/ENOENT), so
    // surface the real cause as a structured frame instead of letting the
    // browser retry forever. Without this the failure looks like a dead
    // daemon and the recovery UI keeps pumping reconnects.
    if !socket_path_fits(&path) {
        let payload = json!({
            "type": "herdr_error",
            "backend": backend.as_str(),
            "kind": "socket_path_too_long",
            "message": format!(
                "session socket path is too long for this OS: {} ({} bytes, limit {})",
                path.display(),
                std::ffi::OsStr::as_encoded_bytes(path.as_os_str()).len(),
                SOCKET_PATH_LIMIT
            ),
            "suggest_builtin": false,
        });
        if let Ok(text) = serde_json::to_string(&payload) {
            let _ = socket.send(Message::Text(text.into())).await;
        }
        return;
    }
    // Shared attach hub: one backend attach per (client socket,
    // terminal_id), fanned out to every connected viewer. Late joiners
    // and quick reconnects reuse the live attach and receive the replay
    // tail immediately; the last viewer's departure detaches the
    // backend after a short grace window. Backpressure drops stalled
    // browser clients (they see the 4404 stall close) instead of ever
    // blocking the shared reader.
    let (mut out_rx, replay, join_guard) = hub.join(&path, &terminal_id, cols, rows);
    // Replay tail first, so a re-join of a still-attached terminal
    // paints the recent output immediately. Fresh attaches get the
    // backend's own full-history frame through the live queue; the
    // snapshot is empty there and costs nothing.
    if !replay.is_empty() && socket.send(Message::Binary(replay.into())).await.is_err() {
        return;
    }

    loop {
        tokio::select! {
            event = out_rx.recv() => {
                match event {
                    // Attach error surfaced by the hub as a structured
                    // frame (same wire behavior as the old per-WS relay):
                    // herdr_error JSON first, then the explicit 4404
                    // stall close, so the browser can offer a built-in
                    // session and never hangs on silence.
                    Some(terminal_hub::HubClientEvent::Error { kind, message, suggests_builtin }) => {
                        let payload = json!({
                            "type": "herdr_error",
                            "backend": backend.as_str(),
                            "kind": kind,
                            "message": message,
                            "suggest_builtin": suggests_builtin,
                        });
                        if let Ok(text) = serde_json::to_string(&payload) {
                            let _ = socket.send(Message::Text(text.into())).await;
                        }
                        let _ = socket
                            .send(Message::Close(Some(CloseFrame {
                                code: 4404,
                                reason: "herdr-stalled".into(),
                            })))
                            .await;
                        break;
                    }
                    Some(terminal_hub::HubClientEvent::Bytes(bytes)) => {
                        if socket.send(Message::Binary(bytes.into())).await.is_err() { break; }
                    }
                    None => {
                        // Hub channel closed: the shared backend stream
                        // ended (detach, shutdown, or death) or this
                        // client was dropped as stalled. Same explicit
                        // stall close so the browser never hangs on
                        // silence.
                        let _ = socket
                            .send(Message::Close(Some(CloseFrame {
                                code: 4404,
                                reason: "herdr-stalled".into(),
                            })))
                            .await;
                        break;
                    }
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Binary(data))) => {
                        if let Some(attach) = hub.attach_sender(&path, &terminal_id) {
                            if attach.send(ClientMessage::Input { data: data.to_vec() }).is_err() { break; }
                        } else { break; }
                    }
                    Some(Ok(Message::Text(text))) => {
                        let text = text.as_str();
                        // Promote hand-off: the overlay armed this socket with
                        // a release toggle, so its cleanup must not auto-close
                        // the now-promoted tab. Consumed here, never forwarded.
                        if terminal_release_toggle(text, &mut release_armed) {
                            continue;
                        }
                        for message in terminal_text_messages(text) {
                            if hub.send_client_message(&path, &terminal_id, message).is_err() { break; }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
    join_guard.detach();
    let close_tab_id = query
        .temporary_tab_id
        .as_deref()
        .filter(|value| !value.is_empty());
    // A promote request for this tab can be in transit when the overlay
    // socket dies (the HTTP route arms the server-side guard only once the
    // request is parsed; a WS close is detected faster than the promote
    // POST can arrive). Closing now would kill the shell the user asked to
    // keep, so when the tab looks closable give an in-transit promote a
    // short grace window to arm its guard; if none shows up the temporary
    // tab closes exactly as before.
    const PROMOTE_GRACE: Duration = Duration::from_millis(250);
    if should_auto_close_temporary_tab(release_armed, close_tab_id, &promoted_temporary_tabs) {
        tokio::time::sleep(PROMOTE_GRACE).await;
        if should_auto_close_temporary_tab(release_armed, close_tab_id, &promoted_temporary_tabs) {
            if let Some(tab_id) = close_tab_id {
                let request = json!({ "id": "web:temp-terminal:close", "method": "tab.close", "params": { "tab_id": tab_id } });
                let _ = tokio::task::spawn_blocking(move || api.request_value(request)).await;
            }
        }
    }
}

/// Teardown decision for the temporary tab served by a terminal socket:
/// auto-close unless the browser armed the release toggle (successful
/// promote, toggle frame delivered), a promote request is currently in
/// flight, or the promote route already marked the tab promoted
/// (toggle frame lost when the socket died mid-promote). A promoted or
/// promoting tab must never be closed here: in-flight protection closes
/// the pre-success race where the teardown auto-close used to kill the
/// shell before the backend answered, failing the promote with
/// "tab not found".
pub(crate) fn should_auto_close_temporary_tab(
    release_armed: bool,
    tab_id: Option<&str>,
    promoted_tabs: &PromotedTemporaryTabs,
) -> bool {
    if release_armed {
        return false;
    }
    match tab_id.map(str::trim).filter(|tab_id| !tab_id.is_empty()) {
        Some(tab_id) => !promoted_tabs
            .lock()
            .map(|promoted| promoted.contains_key(tab_id))
            .unwrap_or(false),
        None => false,
    }
}

/// Events from the graphics bridge reader thread: graphics payloads to relay
/// to the browser, or a fatal bridge error that ends the socket.
#[derive(Deserialize)]
pub(crate) struct TerminalGraphicsQuery {
    pub(crate) tab_id: String,
    pub(crate) cols: Option<u16>,
    pub(crate) rows: Option<u16>,
    pub(crate) cell_width_px: Option<u32>,
    pub(crate) cell_height_px: Option<u32>,
    pub(crate) session: Option<String>,
    pub(crate) backend: Option<String>,
}

pub(crate) async fn terminal_graphics_ws(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<TerminalGraphicsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    log_event(
        &state.log_level(),
        &format!("websocket: terminal graphics bridge from {remote}"),
    );
    let client_socket_path = client_socket_for_query_session(
        &state,
        &headers,
        query.session.as_deref(),
        query.backend.as_deref(),
    );
    ws.on_upgrade(move |socket| terminal_graphics_socket(client_socket_path, query, socket))
}

/// Opens a ClientShell-mode connection to the external herdr daemon,
/// pins it to the requested tab, and relays each PaneSurface graphics scene
/// (plus the pane rects the browser needs to translate surface-relative
/// placements into pane-local coordinates) as JSON text frames.
///
/// herdr 0.9.0 rejects a bare `ClientShellHello`; shell clients must send
/// `EndpointControl { kind: "endpoint.hello.v1", data: <EndpointClientHello
/// JSON> }` first. The scene collection is armed by known cell metrics
/// (`collect_scene` gates on `cell_size.is_known()`), so the bridge always
/// sends real cell dimensions, never zero.
pub(crate) async fn terminal_graphics_socket(
    path: PathBuf,
    query: TerminalGraphicsQuery,
    mut socket: WebSocket,
) {
    // Clamp browser-provided geometry to herdr 0.9.0's client-shell limits
    // (client_transport.rs): the daemon closes the connection otherwise.
    const MAX_SHELL_DIMENSION: u16 = 4096;
    const MAX_SHELL_CELLS: u32 = 1_000_000;
    const MAX_CELL_PX: u32 = 4096;
    let cols = query.cols.unwrap_or(100).clamp(1, MAX_SHELL_DIMENSION);
    let rows = query.rows.unwrap_or(30).clamp(1, MAX_SHELL_DIMENSION);
    let cols = if u32::from(cols) * u32::from(rows) > MAX_SHELL_CELLS {
        (MAX_SHELL_CELLS / u32::from(rows)).min(u32::from(MAX_SHELL_DIMENSION)) as u16
    } else {
        cols
    };
    let cell_width_px = query.cell_width_px.unwrap_or(9).clamp(1, MAX_CELL_PX);
    let cell_height_px = query.cell_height_px.unwrap_or(17).clamp(1, MAX_CELL_PX);
    let tab_id = query.tab_id.clone();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<TerminalGraphicsEvent>();
    let (in_tx, in_rx) = std::sync::mpsc::channel::<ClientMessage>();

    std::thread::spawn(move || {
        let mut stream =
            match connect_terminal_graphics_shell(&path, cols, rows, cell_width_px, cell_height_px)
            {
                Ok(stream) => stream,
                Err(error) => {
                    let _ = out_tx.send(TerminalGraphicsEvent::Error(error));
                    return;
                }
            };
        let Ok(mut writer) = stream.try_clone() else {
            let _ = out_tx.send(TerminalGraphicsEvent::Error(
                "failed to clone herdr client socket".into(),
            ));
            return;
        };
        let mut pin_writer = writer
            .try_clone()
            .expect("third clone of client socket must succeed");
        std::thread::spawn(move || {
            for message in in_rx {
                if write_message(&mut writer, &message).is_err() {
                    break;
                }
            }
        });

        // Read loop: forward every PaneSurface graphics payload to the
        // browser as one JSON frame. `PaneSurfacePatch` never carries
        // graphics (any scene change forces a full PaneSurface), so patches
        // can be dropped here without losing images. The first
        // EndpointControl after the welcome is the shell snapshot carrying
        // `boot_id`, which the tab pinning request needs. Unknown
        // EndpointControl kinds are ignored by contract (append-only enum).
        let mut boot_id: Option<String> = None;
        loop {
            match read_message::<_, ServerMessage>(&mut stream, MAX_GRAPHICS_FRAME_SIZE) {
                Ok(ServerMessage::EndpointControl { kind, data })
                    if kind == "shell.snapshot.v1" =>
                {
                    if boot_id.is_none() {
                        boot_id = serde_json::from_str::<serde_json::Value>(&data)
                            .ok()
                            .and_then(|snapshot| {
                                snapshot
                                    .get("boot_id")
                                    .and_then(|value| value.as_str())
                                    .map(str::to_owned)
                            });
                        if let Some(boot_id) = boot_id.as_deref().filter(|id| !id.is_empty()) {
                            if !tab_id.is_empty() {
                                let pin = serde_json::json!({
                                    "id": "web:graphics-bridge:tab-focus",
                                    "method": "tab.focus",
                                    "params": { "tab_id": tab_id },
                                });
                                if write_message(
                                    &mut pin_writer,
                                    &ClientMessage::ClientShellEndpointRequest {
                                        boot_id: boot_id.to_string(),
                                        request: pin.to_string(),
                                    },
                                )
                                .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    }
                }
                Ok(ServerMessage::PaneSurface(frame)) => {
                    let payload = graphics_bridge_payload(&frame);
                    match serde_json::to_string(&payload) {
                        Ok(text) => {
                            if out_tx.send(TerminalGraphicsEvent::Message(text)).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                Ok(ServerMessage::ServerShutdown { .. }) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    loop {
        tokio::select! {
            message = out_rx.recv() => {
                match message {
                    Some(TerminalGraphicsEvent::Error(error)) => {
                        let payload = json!({
                            "type": "graphics_bridge_error",
                            "message": error,
                        });
                        if let Ok(text) = serde_json::to_string(&payload) {
                            let _ = socket.send(Message::Text(text.into())).await;
                        }
                        break;
                    }
                    Some(TerminalGraphicsEvent::Message(text)) => {
                        if socket.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                    None => break,
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        for message in terminal_graphics_text_messages(&text, &query) {
                            if in_tx.send(message).is_err() { break; }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }

    // The browser WS is gone, but the reader thread above may be blocked in
    // read_message on a healthy, idle daemon connection — shell clients get
    // no heartbeat frames, so nothing would ever unblock it. That would
    // leave a zombie shell client on the daemon side holding the pinned
    // tab's geometry (headless.rs `tab_geometry_controllers`). herdr 0.9.0
    // processes ClientMessage::Detach as a graceful disconnect: it removes
    // the client (restoring tab geometry via remove_client_and_resize_if_
    // needed) and closes its stream, which unblocks the reader with EOF.
    // The writer thread delivers Detach and then exits when `in_tx` drops.
    let _ = in_tx.send(ClientMessage::Detach);
}

/// JSON payload relayed to the browser for one PaneSurface. Only the fields
/// the browser renderer needs: surface dimensions, pane rects (so it can
/// translate surface-relative placements into the attach pane's local grid),
/// new assets (base64), retained asset keys, and placements.
pub(crate) fn graphics_bridge_payload(frame: &PaneSurfaceFrame) -> GraphicsBridgePayload<'_> {
    let panes = frame
        .panes
        .iter()
        .map(|pane| GraphicsBridgePane {
            pane_id: pane.pane_id.clone(),
            x: pane.rect.x,
            y: pane.rect.y,
            width: pane.rect.width,
            height: pane.rect.height,
            inner_x: pane.inner_rect.x,
            inner_y: pane.inner_rect.y,
            inner_width: pane.inner_rect.width,
            inner_height: pane.inner_rect.height,
            focused: pane.focused,
            scrollback_offset: pane
                .scroll
                .as_ref()
                .map(|scroll| scroll.offset_from_bottom as u32)
                .unwrap_or(0),
        })
        .collect();
    let assets = frame
        .graphics
        .assets
        .iter()
        .map(|asset| GraphicsBridgeAsset {
            key: &asset.key,
            data: base64_encode(&asset.data),
        })
        .collect();
    GraphicsBridgePayload {
        kind: "graphics_scene",
        surface_revision: frame.surface_revision,
        cols: frame.frame.width,
        rows: frame.frame.height,
        panes,
        assets,
        placements: frame.graphics.placements.iter().collect(),
        retained_assets: &frame.graphics.retained_assets,
    }
}

/// Minimal standard base64 encoder (no external crate): the webui keeps its
/// dependency footprint tiny, and asset uploads are the only consumer.
pub(crate) fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Maps browser text messages on the graphics WS to upstream ClientShell
/// messages. The browser only needs `resize` (keep the shell surface in
/// sync with the attach grid) and focus/blur.
pub(crate) fn terminal_graphics_text_messages(
    text: &str,
    query: &TerminalGraphicsQuery,
) -> Vec<ClientMessage> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    match value.get("type").and_then(|value| value.as_str()) {
        Some("resize") => {
            // Clamp to herdr 0.9.0's client-shell geometry limits
            // (client_transport.rs): anything beyond these makes the
            // daemon drop the connection, not just ignore the resize.
            const MAX_SHELL_DIMENSION: u64 = 4096;
            const MAX_SHELL_CELLS: u64 = 1_000_000;
            const MAX_CELL_PX: u64 = 4096;
            let cols = value
                .get("cols")
                .and_then(|value| value.as_u64())
                .unwrap_or(cols_of(query))
                .clamp(1, MAX_SHELL_DIMENSION) as u16;
            let rows = value
                .get("rows")
                .and_then(|value| value.as_u64())
                .unwrap_or(rows_of(query))
                .clamp(1, MAX_SHELL_DIMENSION) as u16;
            let cols = if u64::from(cols) * u64::from(rows) > MAX_SHELL_CELLS {
                ((MAX_SHELL_CELLS / u64::from(rows)).min(MAX_SHELL_DIMENSION)) as u16
            } else {
                cols
            };
            let cell_width_px = value
                .get("cell_width_px")
                .and_then(|value| value.as_u64())
                .unwrap_or(query.cell_width_px.unwrap_or(9).max(1) as u64)
                .clamp(1, MAX_CELL_PX) as u32;
            let cell_height_px = value
                .get("cell_height_px")
                .and_then(|value| value.as_u64())
                .unwrap_or(query.cell_height_px.unwrap_or(17).max(1) as u64)
                .clamp(1, MAX_CELL_PX) as u32;
            vec![ClientMessage::ClientShellResize {
                cell_width_px,
                cell_height_px,
                surface_size: ClientSurfaceSize { cols, rows },
                pixel_mouse: false,
            }]
        }
        Some("focus") => vec![ClientMessage::ClientShellFocus {
            focused: value
                .get("focused")
                .and_then(|value| value.as_bool())
                .unwrap_or(true),
        }],
        _ => Vec::new(),
    }
}

pub(crate) fn cols_of(query: &TerminalGraphicsQuery) -> u64 {
    query.cols.unwrap_or(100).max(1) as u64
}

pub(crate) fn rows_of(query: &TerminalGraphicsQuery) -> u64 {
    query.rows.unwrap_or(30).max(1) as u64
}

/// Opens a ClientShell-mode connection to the herdr daemon and pins it to
/// the terminal's tab. Mirrors herdr 0.9.0's handshake contract:
/// `endpoint.hello.v1` welcome, then `tab.focus` scoped to this connection.
pub(crate) fn connect_terminal_graphics_shell(
    path: &Path,
    cols: u16,
    rows: u16,
    cell_width_px: u32,
    cell_height_px: u32,
) -> Result<LocalStream, String> {
    let mut stream = connect_local_stream(path).map_err(|err| format!("connect failed: {err}"))?;
    let hello = serde_json::json!({
        "generation": 1,
        "cell_width_px": cell_width_px,
        "cell_height_px": cell_height_px,
        "surface_size": { "cols": cols, "rows": rows },
        "pixel_mouse": false,
        "direct_graphics": false,
        "endpoint_keybindings": false,
        "mouse_capture": false,
        "surface_active": true,
        "snapshot_codecs": ["shell.snapshot.v1"],
        "surface_codecs": ["shell.surface.v1"],
        "input_codecs": ["shell.input.semantic.v1"],
        "blob_codecs": ["shell.blob.v1"],
    });
    write_message(
        &mut stream,
        &ClientMessage::EndpointControl {
            kind: "endpoint.hello.v1".into(),
            data: hello.to_string(),
        },
    )
    .map_err(|err| format!("send hello failed: {err}"))?;

    match read_message::<_, ServerMessage>(&mut stream, MAX_FRAME_SIZE) {
        Ok(ServerMessage::EndpointControl { kind, data }) if kind == "endpoint.welcome.v1" => {
            // Any rejection arrives as an EndpointHandshakeError JSON in a
            // generic `EndpointControl` or a Welcome error; surface both.
            if let Ok(welcome) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(error) = welcome.get("error") {
                    let code = error
                        .get("code")
                        .and_then(|value| value.as_str())
                        .unwrap_or("unknown");
                    let message = error
                        .get("message")
                        .and_then(|value| value.as_str())
                        .unwrap_or("backend rejected the graphics bridge");
                    return Err(format!("{code}: {message}"));
                }
            }
        }
        Ok(ServerMessage::Welcome {
            error: Some(error), ..
        }) => {
            return Err(error);
        }
        Ok(_) => return Err("unexpected handshake response".into()),
        Err(err) => return Err(format!("read welcome failed: {err}")),
    }
    Ok(stream)
}

pub(crate) fn terminal_text_messages(text: &str) -> Vec<ClientMessage> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return vec![ClientMessage::Input {
            data: text.as_bytes().to_vec(),
        }];
    };
    match value.get("type").and_then(|value| value.as_str()) {
        Some("resize") => {
            let cols = value
                .get("cols")
                .and_then(|value| value.as_u64())
                .unwrap_or(100)
                .min(u16::MAX as u64) as u16;
            let rows = value
                .get("rows")
                .and_then(|value| value.as_u64())
                .unwrap_or(30)
                .min(u16::MAX as u64) as u16;
            vec![ClientMessage::Resize {
                cols: cols.max(1),
                rows: rows.max(1),
                cell_width_px: 0,
                cell_height_px: 0,
                pixel_mouse: false,
            }]
        }
        Some("scroll") => {
            let direction = match value.get("direction").and_then(|value| value.as_str()) {
                Some("up") => AttachScrollDirection::Up,
                Some("down") => AttachScrollDirection::Down,
                _ => AttachScrollDirection::Down,
            };
            let lines = value
                .get("lines")
                .and_then(|value| value.as_u64())
                .unwrap_or(3)
                .clamp(1, u16::MAX as u64) as u16;
            let column = value
                .get("column")
                .and_then(|value| value.as_u64())
                .and_then(|value| u16::try_from(value).ok());
            let row = value
                .get("row")
                .and_then(|value| value.as_u64())
                .and_then(|value| u16::try_from(value).ok());
            let modifiers = value
                .get("modifiers")
                .and_then(|value| value.as_u64())
                .and_then(|value| u8::try_from(value).ok())
                .unwrap_or(0);
            vec![ClientMessage::AttachScroll {
                source: AttachScrollSource::Wheel,
                direction,
                lines,
                column,
                row,
                modifiers,
            }]
        }
        Some("key") if value.get("code").and_then(|value| value.as_str()) == Some("Enter") => {
            let modifiers = value
                .get("modifiers")
                .and_then(|value| value.as_u64())
                .and_then(|value| u8::try_from(value).ok())
                .unwrap_or(0);
            vec![ClientMessage::Input {
                data: (if modifiers & 1 != 0 {
                    "\x1b[13;2u"
                } else {
                    "\r"
                })
                .as_bytes()
                .to_vec(),
            }]
        }
        Some("paste") => value
            .get("text")
            .and_then(|value| value.as_str())
            .map(|text| {
                // herdr 0.9.0 removed `InputEvents`; paste is delivered as
                // raw bracketed-paste input bytes.
                vec![ClientMessage::Input {
                    data: format!("\x1b[200~{}\x1b[201~", text).into_bytes(),
                }]
            })
            .unwrap_or_default(),
        _ => value
            .get("input")
            .and_then(|value| value.as_str())
            .map(|input| {
                vec![ClientMessage::Input {
                    data: input.as_bytes().to_vec(),
                }]
            })
            .unwrap_or_default(),
    }
}

/// Release toggle for temporary terminal WebSockets. After a successful
/// promote the overlay sends `{"type":"release","enabled":true}` so this
/// socket's cleanup skips the `temporary_tab_id` auto-close: the promoted
/// tab must survive the overlay teardown. Returns true when the message is
/// a release toggle (consumed here, never forwarded as terminal input).
pub(crate) fn terminal_release_toggle(text: &str, armed: &mut bool) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    if value.get("type").and_then(|value| value.as_str()) != Some("release") {
        return false;
    }
    *armed = value
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    true
}

/// WS wrapper for the external-backend graphics bridge.
#[derive(serde::Serialize)]
pub(crate) struct GraphicsBridgePayload<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    surface_revision: u64,
    cols: u16,
    rows: u16,
    panes: Vec<GraphicsBridgePane>,
    assets: Vec<GraphicsBridgeAsset<'a>>,
    placements: Vec<&'a SurfaceGraphicsPlacement>,
    retained_assets: &'a [SurfaceGraphicsAssetKey],
}

#[derive(serde::Serialize)]
pub(crate) struct GraphicsBridgePane {
    pane_id: String,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    inner_x: u16,
    inner_y: u16,
    inner_width: u16,
    inner_height: u16,
    focused: bool,
    scrollback_offset: u32,
}

#[derive(serde::Serialize)]
pub(crate) struct GraphicsBridgeAsset<'a> {
    key: &'a SurfaceGraphicsAssetKey,
    /// Base64-encoded RGBA/PNG bytes. The browser decodes with `fetch`-free
    /// `Uint8Array.fromBase64`-style parsing and `createImageBitmap`.
    data: String,
}
