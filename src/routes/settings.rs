//! Server settings and no-sleep routes.

use std::net::SocketAddr;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;

use crate::auth::AuthConfig;
use crate::auth::DEFAULT_SESSION_EXPIRATION_MINUTES;
use crate::routes::shared::*;
use crate::server_settings::{save_runtime_server_settings, settings_public_json, LogLevel};
use crate::server_settings::{BackendMode, RuntimeServerSettings};
use crate::ListenEndpoint;
use crate::WebState;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::time::Duration;

pub(crate) fn no_sleep_public_json(state: &NoSleepState) -> serde_json::Value {
    json!({
        "mode": &state.mode,
        "until_ms": state.until_ms,
        "error": &state.error,
        "active": state.guard.is_some(),
        "supported": cfg!(any(target_os = "macos", target_os = "linux")),
    })
}

pub(crate) fn agents_working_from_value(value: &serde_json::Value) -> bool {
    value
        .pointer("/result/agents")
        .and_then(|agents| agents.as_array())
        .is_some_and(|agents| {
            agents.iter().any(|agent| {
                agent
                    .get("agent_status")
                    .or_else(|| agent.get("status"))
                    .and_then(|status| status.as_str())
                    == Some("working")
            })
        })
}

pub(crate) fn sync_auto_no_sleep(
    state: &mut NoSleepState,
    has_working_agents: bool,
    cooldown_seconds: u64,
) {
    if state.mode != "auto" {
        return;
    }
    if has_working_agents && state.guard.is_none() {
        state.auto_idle_since_ms = None;
        match start_no_sleep_guard() {
            Ok(guard) => {
                state.guard = Some(guard);
                state.error = None;
            }
            Err(err) => {
                state.error = Some(err.to_string());
            }
        }
    } else if has_working_agents {
        state.auto_idle_since_ms = None;
        state.error = None;
    } else {
        let now = unix_ms_now();
        let idle_since = *state.auto_idle_since_ms.get_or_insert(now);
        if now.saturating_sub(idle_since) >= cooldown_seconds.saturating_mul(1000) {
            state.guard = None;
            state.mode = "off".to_string();
            state.until_ms = None;
            state.auto_idle_since_ms = None;
            state.error = None;
        }
    }
}

pub(crate) fn sync_auto_no_sleep_from_agents(state: &WebState, agents: &serde_json::Value) {
    let cooldown = state
        .server_settings
        .lock()
        .map(|settings| settings.no_sleep_auto_cooldown_seconds)
        .unwrap_or(60);
    let Ok(mut no_sleep) = state.no_sleep.lock() else {
        return;
    };
    sync_auto_no_sleep(&mut no_sleep, agents_working_from_value(agents), cooldown);
}

pub(crate) fn apply_no_sleep_mode(
    state: &mut NoSleepState,
    mode: String,
    until_ms: Option<u64>,
) -> (bool, u64) {
    state.auto_generation = state.auto_generation.wrapping_add(1);
    let generation = state.auto_generation;
    state.guard = None;
    state.mode = "off".to_string();
    state.until_ms = None;
    state.error = None;
    state.auto_idle_since_ms = None;
    if mode == "off" || mode == "auto" {
        state.mode = mode;
        return (false, generation);
    }
    match start_no_sleep_guard() {
        Ok(guard) => {
            state.mode = mode;
            state.until_ms = until_ms;
            state.guard = Some(guard);
            (true, generation)
        }
        Err(err) => {
            state.error = Some(err.to_string());
            (false, generation)
        }
    }
}

pub(crate) async fn run_auto_no_sleep_loop(state: WebState, api: ApiClient, generation: u64) {
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        interval.tick().await;
        let should_continue = state
            .no_sleep
            .lock()
            .map(|state| state.mode == "auto" && state.auto_generation == generation)
            .unwrap_or(false);
        if !should_continue {
            break;
        }
        let request =
            json!({ "id": "web:agent:list:no-sleep-auto", "method": "agent.list", "params": {} });
        let api_loop = api.clone();
        let result = tokio::task::spawn_blocking(move || api_loop.request_value(request)).await;
        match result {
            Ok(Ok(agents)) => sync_auto_no_sleep_from_agents(&state, &agents),
            Ok(Err(err)) => {
                if let Ok(mut no_sleep) = state.no_sleep.lock() {
                    if no_sleep.mode == "auto" && no_sleep.auto_generation == generation {
                        no_sleep.guard = None;
                        no_sleep.error = Some(err);
                    }
                }
            }
            Err(_) => {
                // The blocking task was cancelled; the loop's next tick
                // re-checks the generation and stops if no longer active.
            }
        }
    }
}

pub(crate) async fn server_settings(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let Ok(settings) = state.server_settings.lock() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "server settings unavailable" })),
        )
            .into_response();
    };
    Json(settings_public_json(&settings)).into_response()
}

pub(crate) async fn no_sleep(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let Ok(no_sleep) = state.no_sleep.lock() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "no-sleep state unavailable" })),
        )
            .into_response();
    };
    Json(no_sleep_public_json(&no_sleep)).into_response()
}

pub(crate) async fn update_no_sleep(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<UpdateNoSleepRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let Some(duration_ms) = no_sleep_ms(body.mode.as_str()) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "invalid no-sleep mode" })),
        )
            .into_response();
    };
    let timer_until = if body.mode == "off" || duration_ms == 0 {
        None
    } else {
        Some(unix_ms_now() + duration_ms)
    };
    let auto_api = api_for_headers(&state, &headers);
    let auto_agents = if body.mode == "auto" {
        let request =
            json!({ "id": "web:agent:list:no-sleep", "method": "agent.list", "params": {} });
        let probe_api = auto_api.clone();
        tokio::task::spawn_blocking(move || probe_api.request_value(request))
            .await
            .ok()
            .and_then(|result| result.ok())
    } else {
        None
    };
    let mut auto_generation = None;
    let (response_json, timer_active) = {
        let cooldown = state
            .server_settings
            .lock()
            .map(|settings| settings.no_sleep_auto_cooldown_seconds)
            .unwrap_or(60);
        let Ok(mut no_sleep) = state.no_sleep.lock() else {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "no-sleep state unavailable" })),
            )
                .into_response();
        };
        let (active, generation) =
            apply_no_sleep_mode(&mut no_sleep, body.mode.clone(), timer_until);
        if let Some(agents) = &auto_agents {
            sync_auto_no_sleep(&mut no_sleep, agents_working_from_value(agents), cooldown);
        }
        if body.mode == "auto" {
            auto_generation = Some(generation);
        }
        (no_sleep_public_json(&no_sleep), active)
    };
    if let Some(until_ms) = timer_until.filter(|_| timer_active) {
        let state_for_timer = state.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(
                until_ms.saturating_sub(unix_ms_now()),
            ))
            .await;
            let Ok(mut no_sleep) = state_for_timer.no_sleep.lock() else {
                return;
            };
            if no_sleep.until_ms == Some(until_ms) {
                no_sleep.guard = None;
                no_sleep.mode = "off".to_string();
                no_sleep.until_ms = None;
            }
        });
    }
    if let Some(generation) = auto_generation {
        tokio::spawn(run_auto_no_sleep_loop(state.clone(), auto_api, generation));
    }
    Json(response_json).into_response()
}

#[derive(Deserialize)]
pub(crate) struct UpdateServerSettingsRequest {
    bind: String,
    tls_mode: Option<TlsMode>,
    username: Option<String>,
    password: Option<String>,
    localhost_no_auth: bool,
    session_expiration_minutes: Option<u64>,
    no_sleep_auto_cooldown_seconds: Option<u64>,
    backend_mode: Option<BackendMode>,
    #[serde(default)]
    builtin_shell: Option<Option<String>>,
    default_folder: Option<String>,
    builtin_backend_enabled: Option<bool>,
    external_herdr_backend_enabled: Option<bool>,
    log_level: Option<LogLevel>,
}

#[derive(Deserialize)]
pub(crate) struct UpdateNoSleepRequest {
    mode: String,
}

pub(crate) async fn persist_server_settings(state: &WebState) -> io::Result<()> {
    let snapshot = {
        let Ok(guard) = state.server_settings.lock() else {
            return Err(io::Error::other("server settings unavailable"));
        };
        guard.clone()
    };
    tokio::task::spawn_blocking(move || save_runtime_server_settings(&snapshot))
        .await
        .map_err(|err| io::Error::other(err.to_string()))?
}

pub(crate) async fn update_server_settings(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<UpdateServerSettingsRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let bind = match body.bind.trim().parse::<SocketAddr>() {
        Ok(bind) => bind,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": format!("invalid bind address: {err}") })),
            )
                .into_response();
        }
    };
    let current = state
        .server_settings
        .lock()
        .ok()
        .map(|settings| settings.clone());
    let next = RuntimeServerSettings {
        bind,
        tls_mode: body
            .tls_mode
            .or_else(|| current.as_ref().map(|settings| settings.tls_mode))
            .unwrap_or(TlsMode::Auto),
        lsp: current
            .as_ref()
            .map(|settings| settings.lsp.clone())
            .unwrap_or_default(),
        user: body
            .username
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        // A submitted password is plaintext from the settings form: hash it
        // before it lands anywhere (memory or disk). An omitted/empty field
        // keeps the stored hash, so "leave blank to keep current password"
        // stays one code path. Re-submitting the SAME password keeps the
        // stored hash too: a fresh salt would otherwise rewrite the hash on
        // every save and falsely report an identity change (which resets
        // every session), so verify against the stored hash first.
        password: body
            .password
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .and_then(|plain| {
                let current_hash = current
                    .as_ref()
                    .and_then(|settings| settings.password.as_deref());
                let unchanged = current_hash
                    .is_some_and(|stored| crate::password_hashing::verify_password(stored, &plain));
                if unchanged {
                    return current_hash.map(str::to_string);
                }
                match crate::password_hashing::hash_password(&plain) {
                    Ok(hash) => Some(hash),
                    Err(err) => {
                        // The handler cannot return mid-struct-literal; record
                        // the failure and let validation reject it below via
                        // the missing-credential path.
                        eprintln!("failed to hash submitted password: {err}");
                        None
                    }
                }
            })
            .or_else(|| {
                current
                    .as_ref()
                    .and_then(|settings| settings.password.clone())
            }),
        localhost_no_auth: body.localhost_no_auth,
        session_expiration_minutes: body
            .session_expiration_minutes
            .or_else(|| {
                current
                    .as_ref()
                    .map(|settings| settings.session_expiration_minutes)
            })
            .unwrap_or(DEFAULT_SESSION_EXPIRATION_MINUTES),
        no_sleep_auto_cooldown_seconds: body.no_sleep_auto_cooldown_seconds.unwrap_or(60),
        backend_mode: body
            .backend_mode
            .or_else(|| current.as_ref().map(|settings| settings.backend_mode))
            .unwrap_or(BackendMode::Builtin),
        builtin_shell: match body.builtin_shell {
            Some(value) => value
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
            None => current
                .as_ref()
                .and_then(|settings| settings.builtin_shell.clone()),
        },
        default_folder: default_working_folder(body.default_folder.as_deref().or_else(|| {
            current
                .as_ref()
                .map(|settings| settings.default_folder.as_str())
        })),
        builtin_backend_enabled: body
            .builtin_backend_enabled
            .or_else(|| {
                current
                    .as_ref()
                    .map(|settings| settings.builtin_backend_enabled)
            })
            .unwrap_or(true),
        external_herdr_backend_enabled: body
            .external_herdr_backend_enabled
            .or_else(|| {
                current
                    .as_ref()
                    .map(|settings| settings.external_herdr_backend_enabled)
            })
            .unwrap_or(true),
        jcode_detection_variant: current
            .as_ref()
            .map(|settings| settings.jcode_detection_variant)
            .unwrap_or_default(),
        log_level: body
            .log_level
            .or_else(|| current.as_ref().map(|settings| settings.log_level.clone()))
            .unwrap_or_default(),
        recent_workspaces: current
            .as_ref()
            .map(|settings| settings.recent_workspaces.clone())
            .unwrap_or_default(),
    };
    let bind_changed = current
        .as_ref()
        .is_none_or(|settings| settings.bind != next.bind);
    let tls_mode_changed = current
        .as_ref()
        .is_none_or(|settings| settings.tls_mode != next.tls_mode);
    // save_runtime_server_settings does file I/O (fs::write + permissions);
    // offload to avoid stalling the async runtime.
    let save_result = {
        let next_clone = next.clone();
        tokio::task::spawn_blocking(move || save_runtime_server_settings(&next_clone)).await
    };
    match save_result {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response();
        }
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response();
        }
    }
    let auth = match AuthConfig::from_settings(&next) {
        Ok(auth) => auth,
        Err(err) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response();
        }
    };
    // Identity-relevant fields decide whether sessions must reset. A save
    // that only touches bind, TLS, backends, or the default folder must not
    // invalidate any open browser: every existing cookie stays valid.
    // Credential (or localhost-bypass) changes reset every session and mint
    // one fresh for the caller: keeping tokens across a credential change
    // would let a browser authorized under the old credentials keep access
    // under the new ones. An expiration-policy change without a credential
    // change keeps every session but re-anchors their expiries to the new
    // policy, so other browsers stay logged in with the new lifetime.
    let secure = next.tls_mode.cookie_secure();
    let identity_changed = {
        let Ok(current_auth) = state.auth.lock() else {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "auth unavailable" })),
            )
                .into_response();
        };
        current_auth.user != auth.user
            || current_auth.password != auth.password
            || current_auth.localhost_no_auth != auth.localhost_no_auth
    };
    let policy_changed = {
        let Ok(current_auth) = state.auth.lock() else {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "auth unavailable" })),
            )
                .into_response();
        };
        !identity_changed
            && current_auth.session_expiration_minutes != auth.session_expiration_minutes
    };
    let rotated_cookie = {
        let Ok(mut auth_lock) = state.auth.lock() else {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": "auth unavailable" })),
            )
                .into_response();
        };
        if identity_changed {
            // Reset every session (old tokens die: a browser authorized under
            // old credentials must not keep access) and mint one for THIS
            // browser on the same response, so the save does not instantly
            // 401 the caller into the login page.
            *auth_lock = auth;
            let record = auth_lock.reset_sessions();
            Some((record.token, AuthConfig::cookie_max_age(record.expires_at)))
        } else if policy_changed {
            // Policy-only change: keep every session, adopt the new lifetime.
            // The incoming `auth` already carries the new policy from the
            // saved settings; only the session set (and its rev) carries
            // over, then re-anchor stamps the new lifetime on every session.
            let mut preserved = auth;
            preserved.sessions = auth_lock.sessions.clone();
            preserved.sessions_rev = auth_lock.sessions_rev;
            *auth_lock = preserved;
            let new_expiry = auth_lock.reanchor_expiries();
            new_expiry.map(|expiry| {
                let token = auth_lock
                    .current_session()
                    .map(|session| session.token.clone())
                    .unwrap_or_default();
                (token, AuthConfig::cookie_max_age(expiry))
            })
        } else {
            // Benign save: keep the current sessions AND their expiries so
            // running logins are untouched (the fresh `auth` carried a new
            // token set and a re-anchored expiry that would silently change
            // policy).
            let mut preserved = auth;
            preserved.sessions = auth_lock.sessions.clone();
            preserved.sessions_rev = auth_lock.sessions_rev;
            preserved.session_expiration_minutes = auth_lock.session_expiration_minutes;
            *auth_lock = preserved;
            None
        }
    };
    // Keep the sidecar in sync with whatever token now lives in the auth
    // cell (rotated on an identity change, preserved on a benign save).
    persist_session_token(&state);
    if let Ok(mut settings_lock) = state.server_settings.lock() {
        *settings_lock = next.clone();
    }
    if bind_changed || tls_mode_changed {
        let _ = state.rebind_tx.send(ListenEndpoint {
            bind: next.bind,
            tls_mode: next.tls_mode,
        });
    }
    // Tell every connected events socket so long-lived tabs adopt the new
    // enabled_backends immediately (a disabled backend stops being
    // targeted/offered without a reload). Include the server's configured
    // default backend so tabs can retarget accurately without waiting for
    // the next /api/versions poll (loadVersions only runs at boot).
    let _ = state.settings_tx.send(json!({
        "type": "server_settings_changed",
        "enabled_backends": {
            "builtin": next.builtin_backend_enabled,
            "external-herdr": next.external_herdr_backend_enabled,
        },
        "default_backend": default_backend_target(&state).as_str(),
    }));
    let mut response = Json(settings_public_json(&next)).into_response();
    if let Some((token, max_age)) = rotated_cookie {
        crate::auth::attach_session_cookie(&mut response, &token, max_age, secure);
    }
    response
}

pub(crate) fn no_sleep_ms(mode: &str) -> Option<u64> {
    match mode {
        "off" | "auto" | "infinite" => Some(0),
        "1h" => Some(60 * 60 * 1000),
        "2h" => Some(2 * 60 * 60 * 1000),
        "4h" => Some(4 * 60 * 60 * 1000),
        _ => None,
    }
}

pub(crate) fn default_working_folder(candidate: Option<&str>) -> String {
    default_working_folder_with_prompt(candidate, true)
}

pub(crate) fn default_working_folder_without_prompt(candidate: Option<&str>) -> String {
    default_working_folder_with_prompt(candidate, false)
}

pub(crate) fn default_working_folder_with_prompt(
    candidate: Option<&str>,
    allow_permission_prompt: bool,
) -> String {
    let home = home_folder_path();
    let fallback = readable_directory_bounded(&home).unwrap_or(home);
    let raw = candidate
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("~");
    let path = PathBuf::from(expand_user_path_string(raw));
    match readable_directory_bounded(&path) {
        Ok(path) => path.to_string_lossy().to_string(),
        Err(err) if allow_permission_prompt && err.kind() == io::ErrorKind::PermissionDenied => {
            request_default_folder_permission(&path)
                .and_then(|path| readable_directory_bounded(&path))
                .unwrap_or(fallback)
                .to_string_lossy()
                .to_string()
        }
        Err(_) => fallback.to_string_lossy().to_string(),
    }
}

fn readable_directory_bounded(path: &Path) -> io::Result<PathBuf> {
    let path = path.to_path_buf();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(readable_directory(&path));
    });
    rx.recv_timeout(DEFAULT_FOLDER_READ_TIMEOUT).map_err(|_| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "default folder readability check timed out",
        )
    })?
}

#[cfg(target_os = "macos")]
fn request_default_folder_permission(default_folder: &Path) -> io::Result<PathBuf> {
    let default = default_folder
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let script = format!(
        "set selectedFolder to choose folder with prompt \"Allow Herdr WebUI to read the default folder\" default location (POSIX file \"{default}\")\nreturn POSIX path of selectedFolder"
    );
    let output = Command::new("osascript").arg("-e").arg(script).output()?;
    if !output.status.success() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    let selected = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if selected.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "folder permission prompt returned no folder",
        ));
    }
    Ok(PathBuf::from(selected))
}

#[cfg(not(target_os = "macos"))]
fn request_default_folder_permission(default_folder: &Path) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::PermissionDenied,
        format!("cannot read {}", default_folder.display()),
    ))
}

const DEFAULT_FOLDER_READ_TIMEOUT: Duration = Duration::from_millis(1500);

pub(crate) fn readable_directory(path: &Path) -> io::Result<PathBuf> {
    let metadata = fs::metadata(path)?;
    if !metadata.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "default folder must be a directory",
        ));
    }
    fs::read_dir(path)?;
    Ok(path.canonicalize().unwrap_or_else(|_| path.to_path_buf()))
}
