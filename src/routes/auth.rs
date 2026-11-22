//! HTTP auth routes: login/logout and the shared guard.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::json;

use crate::auth::LoginRequest;
use crate::server_settings::log_event;
use crate::WebState;
use std::time::SystemTime;

pub(crate) fn authorized(state: &WebState, headers: &HeaderMap, remote: SocketAddr) -> bool {
    crate::auth::authorized(&state.auth, headers, remote)
}

#[allow(clippy::result_large_err)]
pub(crate) fn require_auth(
    state: &WebState,
    headers: &HeaderMap,
    remote: SocketAddr,
) -> Result<(), Response> {
    crate::auth::require_auth(&state.auth, headers, remote)
}

pub(crate) async fn login(
    State(state): State<WebState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<LoginRequest>,
) -> Response {
    if state.login_limiter.is_blocked(remote.ip()) {
        log_event(&state.log_level(), &format!("login: rate limited {remote}"));
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "too many attempts" })),
        )
            .into_response();
    }
    let secure = state
        .server_settings
        .lock()
        .map(|settings| settings.tls_mode.cookie_secure())
        .unwrap_or(false);
    let Ok(auth) = state.auth.lock() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "auth unavailable" })),
        )
            .into_response();
    };
    if auth.localhost_bypass(remote) {
        drop(auth);
        log_event(
            &state.log_level(),
            &format!("login: localhost bypass for {remote}"),
        );
        let response = crate::auth::login_response(&state.auth, secure);
        // The bypass login still issues a session (the browser may need
        // the cookie for non-localhost access later); keep the sidecar in
        // sync so a restart preserves every browser's session.
        persist_session_token(&state);
        return response;
    }
    let ok = auth.verify_credentials(&body.username, &body.password);
    drop(auth);
    if !ok {
        state.login_limiter.record_failure(remote.ip());
        log_event(
            &state.log_level(),
            &format!("login: failed for user '{}' from {remote}", body.username),
        );
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    state.login_limiter.reset(remote.ip());
    log_event(
        &state.log_level(),
        &format!("login: success for user '{}' from {remote}", body.username),
    );
    let response = crate::auth::login_response(&state.auth, secure);
    persist_session_token(&state);
    response
}

pub(crate) async fn logout(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    // Only authenticated callers can log out; the revocation inside
    // logout_response is the actual invalidation, so an unauthenticated POST
    // must not trigger it.
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let secure = state
        .server_settings
        .lock()
        .map(|settings| settings.tls_mode.cookie_secure())
        .unwrap_or(false);
    // Scoped logout: revoke exactly the session this browser holds. Other
    // browsers keep their own sessions.
    let cookie_token = crate::auth::cookie_value(&headers).unwrap_or_default();
    log_event(&state.log_level(), "logout: session revoked");
    let response = crate::auth::logout_response(&state.auth, &cookie_token, secure);
    persist_session_token(&state);
    response
}

/// Write the live session set (and each expiry for timed sessions) to the
/// sidecar so sessions survive the next restart. One lock hold snapshots
/// everything; the `sessions_rev` snapshot lets a late writer from a
/// concurrent login detect it is stale and skip the file write, so the file
/// always converges to the newest membership. Failures only cost
/// persistence and never the live sessions.
pub(crate) fn persist_session_token(state: &WebState) {
    let Ok(auth) = state.auth.lock() else {
        // Poisoned lock: skip the sidecar write. It only costs persistence,
        // never the live sessions.
        return;
    };
    let records: Vec<crate::server_settings::PersistedSessionRecord> = auth
        .sessions
        .iter()
        .map(|session| {
            let expires_at =
                if auth.session_expiration_minutes == crate::auth::SESSION_EXPIRATION_NEVER {
                    None
                } else {
                    session
                        .expires_at
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .map(|remaining| remaining.as_secs())
                        .ok()
                };
            crate::server_settings::PersistedSessionRecord {
                token: session.token.clone(),
                expires_at,
            }
        })
        .collect();
    let record = crate::server_settings::PersistedSessionToken {
        sessions: records,
        token: None,
        expires_at: None,
    };
    let rev = auth.sessions_rev;
    drop(auth);
    let auth = state.auth.clone();
    tokio::task::spawn_blocking(move || {
        // Out-of-order task completion from concurrent logins could write an
        // older set after the newest one. Re-check the live rev at write
        // time: if membership moved on, this snapshot is stale and skipped,
        // so the file ends up holding the newest session set.
        let current = auth.lock().map(|live| live.sessions_rev);
        if matches!(current, Ok(live_rev) if live_rev != rev) {
            return;
        }
        let _ = crate::server_settings::save_persisted_session_token(&record);
    });
}

pub(crate) async fn me(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    Json(json!({ "authenticated": authorized(&state, &headers, remote) })).into_response()
}
