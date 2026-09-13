// Cookie-session authentication primitives for the WebUI server.
//
// First module split slice (SRP at module scale) extracted from main.rs:
// this module owns session-token generation, constant-time credential
// comparison, cookie parsing, the localhost auth bypass, and the login
// response. Axum handlers stay in main.rs because the router has a single
// state type; they delegate here.
use std::net::SocketAddr;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) const COOKIE_NAME: &str = "herdr_web_session";

/// Auth credentials and the per-run session token derived from them.
pub(crate) struct AuthConfig {
    pub(crate) user: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) localhost_no_auth: bool,
    pub(crate) token: String,
}

impl AuthConfig {
    /// Derives a fresh session token from credentials plus a time seed.
    /// Settings validation happens before construction in the caller.
    pub(crate) fn from_parts(
        user: Option<String>,
        password: Option<String>,
        localhost_no_auth: bool,
    ) -> Self {
        let seed = format!(
            "{}:{}:{}",
            user.as_deref().unwrap_or(""),
            password.as_deref().unwrap_or(""),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        );
        let token = Sha256::digest(seed.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Self {
            user,
            password,
            localhost_no_auth,
            token,
        }
    }

    /// True when this remote matches the stored username and password.
    pub(crate) fn verify_credentials(&self, username: &str, password: &str) -> bool {
        self.user
            .as_deref()
            .zip(self.password.as_deref())
            .is_some_and(|(user, stored)| {
                constant_time_eq(username.as_bytes(), user.as_bytes())
                    && constant_time_eq(password.as_bytes(), stored.as_bytes())
            })
    }

    pub(crate) fn localhost_bypass(&self, remote: SocketAddr) -> bool {
        remote.ip().is_loopback() && self.localhost_no_auth
    }
}

pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Cookie-session check with the localhost bypass. Pure: takes the auth
/// cell directly so any state type can use it.
pub(crate) fn authorized(
    auth: &Mutex<AuthConfig>,
    headers: &HeaderMap,
    remote: SocketAddr,
) -> bool {
    let Ok(auth) = auth.lock() else {
        return false;
    };
    if auth.localhost_bypass(remote) {
        return true;
    }
    let Some(cookie) = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    cookie.split(';').any(|part| {
        let Some(value) = part.trim().strip_prefix(&format!("{COOKIE_NAME}=")) else {
            return false;
        };
        constant_time_eq(value.as_bytes(), auth.token.as_bytes())
    })
}

#[allow(clippy::result_large_err)]
pub(crate) fn require_auth(
    auth: &Mutex<AuthConfig>,
    headers: &HeaderMap,
    remote: SocketAddr,
) -> Result<(), Response> {
    authorized(auth, headers, remote)
        .then_some(())
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response()
        })
}

#[derive(Deserialize)]
pub(crate) struct LoginRequest {
    pub(crate) username: String,
    pub(crate) password: String,
}

/// Successful-login response that sets the session cookie.
pub(crate) fn login_response(auth: &Mutex<AuthConfig>) -> Response {
    let token = auth
        .lock()
        .map(|auth| auth.token.clone())
        .unwrap_or_default();
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE_NAME}={}; HttpOnly; SameSite=Lax; Path=/",
            token
        ))
        .expect("valid cookie"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_auth(localhost_no_auth: bool) -> (Mutex<AuthConfig>, SocketAddr) {
        (
            Mutex::new(AuthConfig::from_parts(
                Some("user".to_string()),
                Some("pass".to_string()),
                localhost_no_auth,
            )),
            "127.0.0.1:9000".parse().unwrap(),
        )
    }

    fn headers_with_cookie(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        let cookie = format!("{COOKIE_NAME}={token}; other=1");
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&cookie).expect("valid cookie"),
        );
        headers
    }

    #[test]
    fn constant_time_eq_compares_equal_values() {
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
        assert!(!constant_time_eq(b"same", b"same-but-longer"));
    }

    #[test]
    fn generated_tokens_differ_between_runs() {
        let a = AuthConfig::from_parts(None, None, true);
        let b = AuthConfig::from_parts(None, None, true);
        assert_ne!(a.token, b.token, "time seed must vary session tokens");
    }

    #[test]
    fn verify_credentials_matches_exact_user_and_password() {
        let (auth, _) = make_auth(false);
        let auth = auth.lock().unwrap();
        assert!(auth.verify_credentials("user", "pass"));
        assert!(!auth.verify_credentials("user", "wrong"));
        assert!(!auth.verify_credentials("other", "pass"));
    }

    #[test]
    fn localhost_bypass_only_for_loopback_and_flag() {
        let (auth, loopback) = make_auth(true);
        assert!(auth.lock().unwrap().localhost_bypass(loopback));
        let remote: SocketAddr = "192.0.2.1:1234".parse().unwrap();
        assert!(!auth.lock().unwrap().localhost_bypass(remote));
        let (strict, loopback2) = make_auth(false);
        assert!(!strict.lock().unwrap().localhost_bypass(loopback2));
    }

    #[test]
    fn authorized_accepts_valid_session_cookie() {
        let (auth, remote) = make_auth(false);
        let token = auth.lock().unwrap().token.clone();
        assert!(authorized(&auth, &headers_with_cookie(&token), remote));
        assert!(!authorized(
            &auth,
            &headers_with_cookie("wrong-token"),
            remote
        ));
        assert!(!authorized(&auth, &HeaderMap::new(), remote));
    }

    #[test]
    fn authorized_localhost_bypass_skips_cookie() {
        let (auth, remote) = make_auth(true);
        assert!(authorized(&auth, &HeaderMap::new(), remote));
    }

    #[test]
    fn login_response_sets_http_only_cookie() {
        let (auth, _) = make_auth(false);
        let token = auth.lock().unwrap().token.clone();
        let response = login_response(&auth);
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(cookie.contains(&format!("{COOKIE_NAME}={token}")));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
    }
}
