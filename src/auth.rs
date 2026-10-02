// Cookie-session authentication primitives for the WebUI server.
//
// First module split slice (SRP at module scale) extracted from main.rs:
// this module owns session-token generation, constant-time credential
// comparison, cookie parsing, the localhost auth bypass, and the login
// response. Axum handlers stay in main.rs because the router has a single
// state type; they delegate here.
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

pub(crate) const COOKIE_NAME: &str = "herdr_web_session";
pub(crate) const DEFAULT_SESSION_EXPIRATION_MINUTES: u64 = 24 * 60;
pub(crate) const MIN_SESSION_EXPIRATION_MINUTES: u64 = 1;
pub(crate) const MAX_SESSION_EXPIRATION_MINUTES: u64 = 365 * 24 * 60;

/// Auth credentials and the per-run session token derived from them.
pub(crate) struct AuthConfig {
    pub(crate) user: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) localhost_no_auth: bool,
    pub(crate) token: String,
    pub(crate) token_expires_at: SystemTime,
    pub(crate) session_expiration_minutes: u64,
}

impl AuthConfig {
    /// Derives a fresh session token. The seed mixes OS randomness
    /// (`RandomState` is seeded from the operating system per process)
    /// with credentials and a time value, so a token cannot be
    /// predicted from timing alone the way a pure nanos seed could.
    /// Settings validation happens before construction in the caller.
    pub(crate) fn from_parts_with_expiration(
        user: Option<String>,
        password: Option<String>,
        localhost_no_auth: bool,
        session_expiration_minutes: u64,
    ) -> Self {
        Self::from_parts_at(
            user,
            password,
            localhost_no_auth,
            session_expiration_minutes,
            SystemTime::now(),
        )
    }

    fn from_parts_at(
        user: Option<String>,
        password: Option<String>,
        localhost_no_auth: bool,
        session_expiration_minutes: u64,
        issued_at: SystemTime,
    ) -> Self {
        use std::hash::BuildHasher;
        let mut seed = Sha256::new();
        // OS-seeded entropy: a fresh RandomState per call carries keys the
        // process derived from the operating system, not from anything
        // an attacker can observe. Time and credentials only mix it.
        let os_entropy = std::hash::RandomState::new().hash_one(SystemTime::now());
        seed.update(os_entropy.to_le_bytes());
        seed.update(user.as_deref().unwrap_or(""));
        seed.update(b":");
        seed.update(password.as_deref().unwrap_or(""));
        seed.update(b":");
        seed.update(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
                .to_le_bytes(),
        );
        let token = seed
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Self {
            user,
            password,
            localhost_no_auth,
            token,
            token_expires_at: issued_at
                + Duration::from_secs(session_expiration_minutes.saturating_mul(60)),
            session_expiration_minutes,
        }
    }

    pub(crate) fn rotate_token(&mut self) {
        let refreshed = Self::from_parts_with_expiration(
            self.user.clone(),
            self.password.clone(),
            self.localhost_no_auth,
            self.session_expiration_minutes,
        );
        self.token = refreshed.token;
        self.token_expires_at = refreshed.token_expires_at;
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

    pub(crate) fn token_is_valid(&self) -> bool {
        SystemTime::now() < self.token_expires_at
    }
}

pub(crate) fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Per-IP failed-login throttle. Without it a remote can hammer
/// /api/login with password guesses as fast as the network allows;
/// constant-time comparison stops timing leaks but not brute force.
/// After `MAX_ATTEMPTS` failures inside `WINDOW` the IP is blocked
/// until the oldest failure ages out of the window.
pub(crate) struct LoginRateLimiter {
    failures: Mutex<HashMap<IpAddr, Vec<SystemTime>>>,
}

const MAX_ATTEMPTS: usize = 5;
const WINDOW: Duration = Duration::from_secs(300);

impl LoginRateLimiter {
    pub(crate) fn new() -> Self {
        Self {
            failures: Mutex::new(HashMap::new()),
        }
    }

    /// True when the IP exhausted its attempts inside the window.
    /// Prunes expired entries as a side effect so the map cannot grow
    /// without bound from one-off scanners.
    pub(crate) fn is_blocked(&self, ip: IpAddr) -> bool {
        let Ok(mut failures) = self.failures.lock() else {
            // Fail closed: if the lock is poisoned, do not let the
            // limiter silently disappear under an attacker.
            return true;
        };
        let cutoff = SystemTime::now().checked_sub(WINDOW);
        let expired = {
            let entries = failures.entry(ip).or_default();
            if let Some(cutoff) = cutoff {
                entries.retain(|time| *time > cutoff);
            }
            entries.is_empty()
        };
        if expired {
            failures.remove(&ip);
        }
        failures
            .get(&ip)
            .is_some_and(|entries| entries.len() >= MAX_ATTEMPTS)
    }

    pub(crate) fn record_failure(&self, ip: IpAddr) {
        if let Ok(mut failures) = self.failures.lock() {
            failures.entry(ip).or_default().push(SystemTime::now());
        }
    }

    pub(crate) fn reset(&self, ip: IpAddr) {
        if let Ok(mut failures) = self.failures.lock() {
            failures.remove(&ip);
        }
    }
}

impl Default for LoginRateLimiter {
    fn default() -> Self {
        Self::new()
    }
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
    if !auth.token_is_valid() {
        return false;
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

/// Successful-login response that sets the session cookie. `secure`
/// marks the cookie `Secure` when the listener actually speaks TLS,
/// so no proxy downgrade can strip it in the common deployment.
pub(crate) fn login_response(auth: &Mutex<AuthConfig>, secure: bool) -> Response {
    let (token, max_age) = auth
        .lock()
        .map(|mut auth| {
            auth.rotate_token();
            let max_age = auth
                .token_expires_at
                .duration_since(SystemTime::now())
                .unwrap_or_default()
                .as_secs()
                .max(1);
            (auth.token.clone(), max_age)
        })
        .unwrap_or_default();
    let mut response = Json(json!({ "ok": true })).into_response();
    let secure_flag = if secure { "; Secure" } else { "" };
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE_NAME}={token}; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure_flag}; Path=/"
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
            Mutex::new(AuthConfig::from_parts_with_expiration(
                Some("user".to_string()),
                Some("pass".to_string()),
                localhost_no_auth,
                DEFAULT_SESSION_EXPIRATION_MINUTES,
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
        let a = AuthConfig::from_parts_with_expiration(
            None,
            None,
            true,
            DEFAULT_SESSION_EXPIRATION_MINUTES,
        );
        let b = AuthConfig::from_parts_with_expiration(
            None,
            None,
            true,
            DEFAULT_SESSION_EXPIRATION_MINUTES,
        );
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
    fn expired_session_cookie_is_rejected() {
        let now = SystemTime::now();
        let auth = Mutex::new(AuthConfig::from_parts_at(
            Some("user".to_string()),
            Some("pass".to_string()),
            false,
            DEFAULT_SESSION_EXPIRATION_MINUTES,
            now - Duration::from_secs(DEFAULT_SESSION_EXPIRATION_MINUTES * 60 + 1),
        ));
        let token = auth.lock().unwrap().token.clone();
        let remote: SocketAddr = "192.0.2.1:1234".parse().unwrap();
        assert!(!authorized(&auth, &headers_with_cookie(&token), remote));
    }

    #[test]
    fn login_response_sets_http_only_cookie() {
        let (auth, _) = make_auth(false);
        let response = login_response(&auth, false);
        let token = auth.lock().unwrap().token.clone();
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(cookie.contains(&format!("{COOKIE_NAME}={token}")));
        let max_age = cookie
            .split(';')
            .find_map(|part| part.trim().strip_prefix("Max-Age="))
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap();
        assert!((1..=86400).contains(&max_age));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
        assert!(!cookie.contains("Secure"), "plain http must not pin Secure");
    }

    #[test]
    fn login_response_adds_secure_flag_for_tls() {
        let (auth, _) = make_auth(false);
        let response = login_response(&auth, true);
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
        assert!(cookie.contains("Secure"));
    }

    #[test]
    fn rate_limiter_blocks_after_max_attempts_and_resets() {
        let limiter = LoginRateLimiter::new();
        let ip: IpAddr = "192.0.2.10".parse().unwrap();
        assert!(!limiter.is_blocked(ip));
        for _ in 0..MAX_ATTEMPTS {
            limiter.record_failure(ip);
        }
        assert!(limiter.is_blocked(ip), "fifth failure blocks the IP");
        limiter.reset(ip);
        assert!(!limiter.is_blocked(ip));
    }

    #[test]
    fn rate_limiter_tracks_ips_independently() {
        let limiter = LoginRateLimiter::new();
        let blocked: IpAddr = "192.0.2.10".parse().unwrap();
        let other: IpAddr = "192.0.2.11".parse().unwrap();
        for _ in 0..MAX_ATTEMPTS {
            limiter.record_failure(blocked);
        }
        assert!(limiter.is_blocked(blocked));
        assert!(!limiter.is_blocked(other));
    }

    #[test]
    fn rate_limiter_window_expires_old_failures() {
        let limiter = LoginRateLimiter::new();
        let ip: IpAddr = "192.0.2.10".parse().unwrap();
        for _ in 0..MAX_ATTEMPTS {
            limiter.record_failure(ip);
        }
        assert!(limiter.is_blocked(ip));
        // Rewind every recorded failure past the window: the lock is
        // intentionally taken via a short-lived poisoned-free helper by
        // reaching into the internals from the test.
        {
            let mut failures = limiter.failures.lock().unwrap();
            let entries = failures.get_mut(&ip).unwrap();
            let aged = SystemTime::now() - WINDOW - Duration::from_secs(1);
            for time in entries.iter_mut() {
                *time = aged;
            }
        }
        assert!(
            !limiter.is_blocked(ip),
            "expired failures must not keep the IP blocked"
        );
    }
}
