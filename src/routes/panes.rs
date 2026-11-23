//! Pane submit/conversation/prompt routes and tab promotion.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::routes::shared::*;
use crate::WebState;
use std::panic::resume_unwind;

pub(crate) fn submit_pane_note(code: &str, err: &str) -> String {
    match code {
        "agent_blocked" => {
            "Not sent: the agent is waiting for an answer in the terminal. Answer it first.".into()
        }
        "agent_not_found" | "agent_exited" => {
            "Not sent: this panel is gone. Pick another panel.".into()
        }
        "message_too_long" => "Not sent: message is too long (20000 characters max).".into(),
        "empty_agent_prompt" => "Not sent: the message is empty.".into(),
        "unauthorized" => "Not sent: session expired. Reload.".into(),
        _ => format!("Not sent: {err}"),
    }
}

/// Extracts the machine wire code from a backend submit error.
///
/// The builtin backend reports `code: "builtin_error"` with the real code
/// as the MESSAGE prefix (`"agent_blocked: ..."`); external herdr reports
/// its own codes (`"agent_blocked"`, `"empty_agent_prompt"`) as the error
/// code with a human message. Try the message prefix first (builtin),
/// then the error code (herdr), so both backends classify identically.
pub(crate) fn submit_pane_code(error: &serde_json::Value) -> String {
    let message = error
        .get("message")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    let prefix = message.split(':').next().unwrap_or("");
    const KNOWN: [&str; 6] = [
        "agent_blocked",
        "agent_not_found",
        "agent_exited",
        "message_too_long",
        "empty_agent_prompt",
        "unauthorized",
    ];
    if KNOWN.contains(&prefix) {
        return prefix.to_string();
    }
    let code = error
        .get("code")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    if KNOWN.contains(&code) {
        return code.to_string();
    }
    // Unknown: keep the message prefix (builtin) or the raw code (herdr)
    // so the note still names what failed.
    if !prefix.is_empty() {
        prefix.to_string()
    } else {
        code.to_string()
    }
}

/// Maps a backend submit error to (status, code, note). Kept beside the
/// note map so the route reads as one classification step.
pub(crate) fn submit_pane_error(message: &str, code: &str) -> (StatusCode, String, String) {
    let status = match code {
        "agent_blocked" => StatusCode::CONFLICT,
        "agent_not_found" | "agent_exited" => StatusCode::NOT_FOUND,
        "message_too_long" | "empty_agent_prompt" => StatusCode::BAD_REQUEST,
        _ => StatusCode::BAD_GATEWAY,
    };
    let note = submit_pane_note(code, message);
    (status, code.to_string(), note)
}

/// Error classification for the conversation route: design codes with
/// HTTP statuses. `agent_not_found` mirrors submit's shape (404 + note
/// style) exactly — round-10 live verification, same code name, no
/// invented `pane_not_found`.
pub(crate) fn conversation_error(message: &str) -> (StatusCode, String) {
    let code = message.split(':').next().unwrap_or("");
    let status = match code {
        "agent_not_found" => StatusCode::NOT_FOUND,
        "unsupported_agent" => StatusCode::NOT_FOUND,
        "no_session_path" | "ambiguous" => StatusCode::NOT_FOUND,
        "transcript_missing" => StatusCode::NOT_FOUND,
        // Design section 3: a cursor from another session or a
        // superseded generation must not be served — 409 semantics
        // (reference HistoryChanged parity).
        "history_changed" => StatusCode::CONFLICT,
        _ => StatusCode::BAD_GATEWAY,
    };
    (status, code.to_string())
}

/// Parsed question dialog for one pane. GET /api/panes/{pane_id}/prompt.
/// Reuses the same server-side tail the TUI parses over its transport
/// (`pane.read`), ANSI-stripped to the last 16 non-empty-bottom lines
/// (the same window the desktop's prompt_cards.js reads from its local
/// terminal grid), and runs the shared parser (src/prompt_cards.rs
/// `parse_prompt`, the Rust port of the JS one). Returns the parse, not
/// the tail, so the wire carries only the card shape. `blocked` mirrors
/// the pane's live agent status so an offline fallback client can gate
/// exactly like prompt_cards.js paneBlocked() does.
pub(crate) async fn pane_prompt(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(pane_id): AxumPath<String>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let api = api_for_headers_ensured(&state, &headers).await;
    let result = tokio::task::spawn_blocking(move || pane_prompt_payload(&api, &pane_id)).await;
    match result {
        Ok(Ok(payload)) => Json(payload).into_response(),
        Ok(Err((status, message))) => (status, Json(json!({ "error": message }))).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

/// Blocking core of /api/panes/{pane_id}/prompt: read the tail, parse
/// the dialog. The blocked flag rides from agent.list, the same status
/// source the JS paneBlocked() consults through state.agents.
pub(crate) fn pane_prompt_payload(
    api: &ApiClient,
    pane_id: &str,
) -> Result<serde_json::Value, (StatusCode, String)> {
    let read = api
        .request_value(json!({
            "id": "web:pane:read:prompt",
            "method": "pane.read",
            "params": { "pane_id": pane_id },
        }))
        .map_err(|err| (StatusCode::BAD_GATEWAY, err))?;
    if read.get("error").is_some() {
        let message = read
            .pointer("/error/message")
            .or_else(|| read.get("error"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("pane read failed");
        return Err((StatusCode::BAD_GATEWAY, message.to_string()));
    }
    // `request_value` returns the raw wire object, so the text lives
    // under /result/read/text (builtin and external herdr wrap the same
    // way; the TUI's read_pane unwraps `result` before its get("read")).
    // The unwrapped fallbacks keep hypothetical flat backends working.
    let text = read
        .pointer("/result/read/text")
        .or_else(|| read.pointer("/read/text"))
        .or_else(|| read.get("text"))
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
    // Same strip the TUI tail applies (tui/mod.rs strip_ansi_lossy feeds
    // set_pane_tail_from_text): dialog lines must read like the grid
    // text the JS parser sees. Drop mode, like every production strip:
    // a bare CR separates grid rows in raw pty history, and CRLF row
    // ends must not double-space the tail.
    let stripped = crate::terminal_text::strip_ansi_lossy(
        text,
        crate::terminal_text::StripCarriageReturn::Drop,
    );
    let mut lines: Vec<String> = stripped.lines().map(str::to_string).collect();
    // prompt_cards.js tailLines() drops trailing blank rows then takes the
    // last 16; mirror that so an identical screen parses identically.
    while lines.last().is_some_and(|line| line.trim().is_empty()) {
        lines.pop();
    }
    let tail: Vec<String> = if lines.len() > PANE_PROMPT_TAIL_LINES {
        lines.split_off(lines.len() - PANE_PROMPT_TAIL_LINES)
    } else {
        lines
    };
    let prompt = herdr_webui::prompt_cards::parse_prompt(&tail);
    let agents = api
        .request_value(json!({
            "id": "web:agent:list:prompt",
            "method": "agent.list",
            "params": {},
        }))
        .map_err(|err| (StatusCode::BAD_GATEWAY, err))?;
    let blocked = agents
        .pointer("/result/agents")
        .or_else(|| agents.get("agents"))
        .and_then(serde_json::Value::as_array)
        .map(|rows| {
            rows.iter().any(|row| {
                row.get("pane_id").and_then(serde_json::Value::as_str) == Some(pane_id)
                    && row.get("agent_status").and_then(serde_json::Value::as_str)
                        == Some("blocked")
            })
        })
        .unwrap_or(false);
    Ok(match prompt {
        Some(card) => {
            use herdr_webui::prompt_cards::PromptCardKind;
            let kind = match card.kind {
                PromptCardKind::Options => "options",
                PromptCardKind::Text => "text",
            };
            json!({
                "blocked": blocked,
                "kind": kind,
                "title": card.title,
                "options": card
                    .options
                    .iter()
                    .map(|option| json!({ "key": option.key, "label": option.label }))
                    .collect::<Vec<_>>(),
            })
        }
        None => json!({ "blocked": blocked, "kind": null, "title": null, "options": [] }),
    })
}

/// Page cursors the chat lens sends (reference before/from parity):
/// both optional, both opaque strings the backend validates against
/// the same session + generation.
pub(crate) async fn pane_conversation(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(pane_id): AxumPath<String>,
    Query(query): Query<PaneConversationQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let mut params = json!({ "pane_id": pane_id });
    if let Some(before) = query.before.filter(|b| !b.is_empty()) {
        params["before"] = serde_json::Value::String(before);
    }
    if let Some(from) = query.from.filter(|f| !f.is_empty()) {
        params["from"] = serde_json::Value::String(from);
    }
    let api = api_for_headers_ensured(&state, &headers).await;
    let result = tokio::task::spawn_blocking(move || {
        api.request_value(json!({
            "id": "web:pane:conversation",
            "method": "pane.conversation",
            "params": params,
        }))
    })
    .await;
    match result {
        Ok(Ok(value)) => {
            if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
                let message = error
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("conversation failed");
                let (status, code) = conversation_error(message);
                return (status, Json(json!({ "error": message, "code": code }))).into_response();
            }
            // Unwrap the wire envelope ({id, result: {type,
            // conversation}}): the browser gets the design's flat
            // conversation payload.
            match value
                .pointer("/result/conversation")
                .filter(|c| c.is_object())
            {
                Some(conversation) => {
                    let version = conversation
                        .get("version")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    // Weak ETag, reference parity: a restart may parse
                    // the same files differently, so the tag is only
                    // weak-comparable — and compare strips W/ so a
                    // weak round trip still matches.
                    let etag = format!("W/\"{version}\"");
                    let bare = format!("\"{version}\"");
                    // Reference index.ts:2407 strips the weak prefix
                    // ONCE from the sent header (replace(/^W\//, "")),
                    // so a malformed W/W/"…" never matches. A single
                    // strip_prefix mirrors that; multiple W/ prefixes
                    // stay and fail the compare.
                    if headers
                        .get(axum::http::header::IF_NONE_MATCH)
                        .and_then(|v| v.to_str().ok())
                        .map(|v| v.strip_prefix("W/").unwrap_or(v) == bare)
                        .unwrap_or(false)
                    {
                        return (
                            StatusCode::NOT_MODIFIED,
                            [
                                (axum::http::header::ETAG, etag.as_str()),
                                (axum::http::header::CACHE_CONTROL, "no-store"),
                            ],
                        )
                            .into_response();
                    }
                    (
                        StatusCode::OK,
                        [
                            (axum::http::header::ETAG, etag.as_str()),
                            // no-store keeps the browser's own cache out
                            // of it, so the chat sees the 304 (same call
                            // as the reference).
                            (axum::http::header::CACHE_CONTROL, "no-store"),
                        ],
                        Json(conversation.clone()),
                    )
                        .into_response()
                }
                None => (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "error": "malformed backend response", "code": "error" })),
                )
                    .into_response(),
            }
        }
        Ok(Err(err)) => {
            let (status, code) = conversation_error(&err);
            (status, Json(json!({ "error": err, "code": code }))).into_response()
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub(crate) async fn pane_conversation_image(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(pane_id): AxumPath<String>,
    Query(query): Query<PaneConversationImageQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let Some(reference) = query.r#ref.filter(|r| !r.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing ref query parameter", "code": "bad_request" })),
        )
            .into_response();
    };
    let api = api_for_headers_ensured(&state, &headers).await;
    let result = tokio::task::spawn_blocking(move || {
        api.request_value(json!({
            "id": "web:pane:conversation_image",
            "method": "pane.conversation_image",
            "params": { "pane_id": pane_id, "ref": reference },
        }))
    })
    .await;
    match result {
        Ok(Ok(value)) => {
            if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
                let message = error
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("conversation image failed");
                let (status, code) = conversation_error(message);
                return (status, Json(json!({ "error": message, "code": code }))).into_response();
            }
            // Backend arm returns {type, image: {media_type, data}|null}.
            // Null is not-found (rotation, /clear, or a bad ref) rather
            // than a failure — the page drops back to its placeholder.
            match value
                .pointer("/result/image")
                .filter(|i| i.is_object())
                .and_then(|i| {
                    let media_type = i.get("media_type")?.as_str()?.to_string();
                    let data = i.get("data")?.as_str()?;
                    Some((media_type, data.to_string()))
                }) {
                Some((media_type, data)) => match crate::jcode_transcript::base64_decode(&data) {
                    Some(bytes) => (
                        StatusCode::OK,
                        [
                            (axum::http::header::CONTENT_TYPE, media_type.as_str()),
                            (
                                axum::http::header::CACHE_CONTROL,
                                "private, max-age=86400, immutable",
                            ),
                            (
                                axum::http::HeaderName::from_static("x-content-type-options"),
                                "nosniff",
                            ),
                        ],
                        bytes,
                    )
                        .into_response(),
                    None => (
                        StatusCode::NOT_FOUND,
                        Json(json!({
                            "error": "no such image in this pane's conversation",
                            "code": "image_not_found",
                        })),
                    )
                        .into_response(),
                },
                None => (
                    StatusCode::NOT_FOUND,
                    Json(json!({
                        "error": "no such image in this pane's conversation",
                        "code": "image_not_found",
                    })),
                )
                    .into_response(),
            }
        }
        Ok(Err(err)) => {
            let (status, code) = conversation_error(&err);
            (status, Json(json!({ "error": err, "code": code }))).into_response()
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

pub(crate) async fn pane_tool_output(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(pane_id): AxumPath<String>,
    Query(query): Query<PaneToolOutputQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let Some(reference) = query.r#ref.filter(|r| !r.is_empty()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing ref query parameter", "code": "bad_request" })),
        )
            .into_response();
    };
    let api = api_for_headers_ensured(&state, &headers).await;
    let result = tokio::task::spawn_blocking(move || {
        api.request_value(json!({
            "id": "web:pane:tool_output",
            "method": "pane.tool_output",
            "params": { "pane_id": pane_id, "ref": reference },
        }))
    })
    .await;
    match result {
        Ok(Ok(value)) => {
            if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
                let message = error
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("tool output failed");
                let (status, code) = conversation_error(message);
                return (status, Json(json!({ "error": message, "code": code }))).into_response();
            }
            // Backend arm returns {type, output: string|null}. A null
            // output is the not-found case (distinguished from backend
            // failures, which arrive as error envelopes).
            let output = value
                .pointer("/result/output")
                .cloned()
                .unwrap_or(serde_json::Value::Null);
            match output {
                serde_json::Value::String(text) => Json(json!({ "output": text })).into_response(),
                _ => (
                    StatusCode::NOT_FOUND,
                    Json(json!({
                        "error": "no tool output for this reference",
                        "code": "tool_output_not_found",
                    })),
                )
                    .into_response(),
            }
        }
        Ok(Err(err)) => {
            let (status, code) = conversation_error(&err);
            (status, Json(json!({ "error": err, "code": code }))).into_response()
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

/// Composer submit: types one message into the pane's agent through the
/// backend's `agent.prompt` (built-in backend and external herdr implement
/// the same method, including the `agent_blocked` refusal while the agent
/// waits for an answer). Refusal errors keep their machine-readable code AND
/// the human-facing note in the response body: the server owns the copy so
/// every client (desktop, mobile, future integrations) says the same thing
/// and the browser only displays.
///
/// Human-facing copy for a composer submit refusal. The route classifies the
/// wire code anyway (for the status mapping), so the same match owns the
/// note: one classification, two projections, no drift. Unknown codes get
/// the generic "Not sent" prefix around the server's own error string so
/// every refusal reads consistently in the UI.
pub(crate) async fn submit_pane(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(pane_id): AxumPath<String>,
    body: axum::extract::Json<serde_json::Value>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let Some(text) = body
        .get("text")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
    else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "missing text" })),
        )
            .into_response();
    };
    // Long-press Send (enqueue): forwarded as agent.prompt `enqueue` so
    // both backends see the same flag; absent keeps the legacy submit.
    let enqueue = body
        .get("enqueue")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    let api = api_for_headers_ensured(&state, &headers).await;
    let result = tokio::task::spawn_blocking(move || {
        api.request_value(json!({
            "id": "web:pane:submit",
            "method": "agent.prompt",
            "params": { "pane_id": pane_id, "text": text, "enqueue": enqueue },
        }))
    })
    .await;
    // Both backends deliver refusals as an Ok wire response carrying an
    // `error` object ({code, message}); the Err arm is transport only.
    // The route classifies once (status + code + note) so the browser
    // never needs to know which backend answered or how it shaped its
    // error fields.
    match result {
        Ok(Ok(value)) => {
            if let Some(error) = value.get("error").filter(|e| !e.is_null()) {
                let code = submit_pane_code(error);
                let message = error
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("submit failed");
                let (status, code, note) = submit_pane_error(message, &code);
                return (
                    status,
                    Json(json!({ "error": message, "code": code, "note": note })),
                )
                    .into_response();
            }
            Json(value).into_response()
        }
        Ok(Err(err)) => {
            let (status, code, note) = submit_pane_error(&err, "error");
            (
                status,
                Json(json!({ "error": err, "code": code, "note": note })),
            )
                .into_response()
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

/// Folds a failed `spawn_blocking` join into the promote route's error
/// channel. A panic in the backend call must still propagate (it may hold
/// poisoned locks or invariant breakage worth crashing on), while a plain
/// join failure (task cancelled, runtime shutdown) degrades to its message
/// so the route can restore auto-close semantics and answer 502.
pub(crate) fn promote_join_failure(join: tokio::task::JoinError) -> String {
    match join.try_into_panic() {
        Ok(panic) => resume_unwind(panic),
        Err(err) => err.to_string(),
    }
}

/// Promotes a temporary terminal tab into a workspace rooted at the shell's
/// live cwd. Thin proxy: the backend owns the semantics (registry-only
/// re-parent, never stopping the process); the HTTP result carries the full
/// workspace/tab/pane payload the browser navigates from. On success the
/// promoted workspace is also recorded in recent workspaces, mirroring
/// create/open routes (the path comes from the result because the backend
/// resolves the live cwd).
pub(crate) async fn promote_tab(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(tab_id): AxumPath<String>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let api = api_for_headers_ensured(&state, &headers).await;
    // Arm the in-flight guard before the backend call: the overlay's
    // terminal WS can start teardown at any point of this round-trip
    // (navigation, network blip, browser close). Without the pre-arm the
    // auto-close wins the race, kills the live shell the user asked to
    // keep, and the promote then fails with "tab not found".
    begin_temporary_tab_promote(&state.promoted_temporary_tabs, &tab_id);
    let tab_id_for_registry = tab_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        api.request_value(json!({
            "id": "web:tab:promote",
            "method": "tab.promote",
            "params": { "tab_id": tab_id },
        }))
    })
    .await
    // Fold the spawn_blocking join failure (runtime shutdown or a panic in
    // the backend call) into the same error channel as a failed backend
    // call: panics still propagate, join failures degrade to their message,
    // and a single Err arm below restores auto-close for both.
    .map_err(promote_join_failure)
    .and_then(|inner| inner);
    match outcome {
        Ok(value) => {
            // Relay the full envelope; the browser reads the workspace/tab/
            // pane fields from it (or shows the backend error inside it).
            // Record the tab id before relaying, but only on a promote
            // success: if this socket dies before the overlay's release
            // toggle frame is delivered, the terminal WS teardown must
            // still skip the auto-close for the freshly promoted tab (see
            // terminal_socket cleanup). A failed promote must stay closable.
            let promoted_ok = value.get("error").is_none();
            finish_temporary_tab_promote(
                &state.promoted_temporary_tabs,
                &tab_id_for_registry,
                promoted_ok,
            );
            let workspace = value
                .get("result")
                .and_then(|result| result.get("workspace"));
            let cwd = workspace
                .and_then(|workspace| workspace.get("cwd"))
                .and_then(|cwd| cwd.as_str())
                .map(|cwd| cwd.trim().to_string())
                .unwrap_or_default();
            let label = workspace
                .and_then(|workspace| workspace.get("label"))
                .and_then(|label| label.as_str())
                .map(|label| label.trim().to_string())
                .filter(|label| !label.is_empty());
            if !cwd.is_empty() {
                // Recording must not fail or delay the promote response:
                // errors are swallowed like in open_recent_workspace.
                let _ = record_recent_workspace(
                    &state,
                    &cwd,
                    label,
                    None,
                    Some("workspace".to_string()),
                )
                .await;
            }
            Json(value).into_response()
        }
        Err(err) => {
            // The backend call itself failed (dead socket, daemon stop, or
            // the spawn_blocking task died): restore normal auto-close
            // semantics for this tab.
            finish_temporary_tab_promote(
                &state.promoted_temporary_tabs,
                &tab_id_for_registry,
                false,
            );
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response()
        }
    }
}

/// Chat-lens transcript for one pane. GET /api/panes/{pane_id}/conversation
/// (optional ?before=…&from=… page cursors).
/// Thin proxy to the backend `pane.conversation` method; the backend
/// owns resolution, parsing, and the design's error codes. Rides the
/// existing session-cookie auth like every other /api route.
///
/// ETag (reference parity): the response `version` is already the
/// stat signature of both session files, so it serves as a strong
/// ETag. A poll that carries a matching If-None-Match short-circuits
/// with 304 — the common idle poll moves zero turn bytes.
#[derive(serde::Deserialize, Default)]
pub(crate) struct PaneConversationQuery {
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    from: Option<String>,
}

/// Image bytes the conversation's image part named. GET
/// /api/panes/{pane_id}/conversation/image?ref=…
/// Reference conversationImage parity: the page carried
/// {kind:"image", media_type, ref} and this fetches the bytes from
/// the same session (a ref can only name the session the page came
/// from). Serves raw bytes with the stored media type — browsers
/// render an <img src> here directly, no base64 detour.
///
/// Cache (reference parity): jcode transcript bytes are immutable —
/// a ref names a message id in a signed session file — so the
/// response is `private, max-age=86400, immutable` (the reference
/// reserves no-store for backends whose bytes can change).
#[derive(serde::Deserialize)]
pub(crate) struct PaneConversationImageQuery {
    #[serde(default)]
    r#ref: Option<String>,
}

/// Whole tool output by call id. GET /api/panes/{pane_id}/tool-output?ref=…
/// Reference toolOutput parity: the page carried a trimmed head and this
/// fetches the rest from the same session. `conversation_error`
/// classifies resolution failures; a ref with no matching tool_result is
/// a 404 `tool_output_not_found` (rotation, /clear, or a bad ref) rather
/// than an error — the page drops back to the head it already has.
#[derive(serde::Deserialize)]
pub(crate) struct PaneToolOutputQuery {
    #[serde(default)]
    r#ref: Option<String>,
}
