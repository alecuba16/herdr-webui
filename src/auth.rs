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
/// `"herdr_web_session="` precomputed so the per-request cookie scan
/// allocates nothing: the hot auth path only compares byte slices.
const COOKIE_PREFIX: &str = "herdr_web_session=";
pub(crate) const SESSION_EXPIRATION_NEVER: u64 = 0;
pub(crate) const DEFAULT_SESSION_EXPIRATION_MINUTES: u64 = SESSION_EXPIRATION_NEVER;
pub(crate) const MIN_SESSION_EXPIRATION_MINUTES: u64 = SESSION_EXPIRATION_NEVER;
pub(crate) const MAX_SESSION_EXPIRATION_MINUTES: u64 = 365 * 24 * 60;
/// Old default (24h) kept only for the one-time settings migration in
/// server_settings.rs: persisted 1440 flips to 0 (never expire) so existing
/// installs stop auto-logging users out after a day.
pub(crate) const LEGACY_DEFAULT_SESSION_EXPIRATION_MINUTES: u64 = 24 * 60;
/// Sentinel expiry for never-expiring sessions: 9999-12-31 in Unix seconds.
/// Far enough that no auth check can reach it, small enough that no
/// `SystemTime` arithmetic can overflow on any supported platform.
pub(crate) fn never_expires_at() -> SystemTime {
    SystemTime::UNIX_EPOCH + Duration::from_secs(253_402_300_799)
}

/// Hard cap on live sessions. Each login appends a session, so the set
/// is bounded: a compromised password cannot mint an unbounded token
/// population, and the auth hot path stays a fixed max of 8 constant-time
/// compares with no allocation.
pub(crate) const MAX_SESSIONS: usize = 8;

/// One live login: the token a browser holds plus its absolute expiry.
/// Never-expiring sessions use the far-future sentinel so the same
/// comparison covers both policies.
#[derive(Clone)]
pub(crate) struct SessionRecord {
    pub(crate) token: String,
    pub(crate) expires_at: SystemTime,
}

impl SessionRecord {
    fn is_valid(&self) -> bool {
        SystemTime::now() < self.expires_at
    }
}

/// Auth credentials and the live session set derived from them. Multiple
/// browsers (each with its own cookie jar) hold one SessionRecord each;
/// a login no longer invalidates the other sessions.
pub(crate) struct AuthConfig {
    pub(crate) user: Option<String>,
    pub(crate) password: Option<String>,
    pub(crate) localhost_no_auth: bool,
    /// Live sessions. Order doubles as the LRU clock: index 0 is the
    /// least recently used. A successful auth moves that session last.
    /// Eviction drops index 0: the least recently used session goes first.
    pub(crate) sessions: Vec<SessionRecord>,
    /// Bumped on every membership change (issue, revoke, reset, re-anchor).
    /// The sidecar persist path snapshots it so an out-of-order write from
    /// a concurrent login can detect it is stale and skip the file write.
    /// LRU reordering does not bump it: membership did not change, and
    /// per-request touches never rewrite the sidecar (the hot path stays
    /// allocation-free and write-free; a restart trades exact recency for
    /// the last snapshot's order).
    pub(crate) sessions_rev: u64,
    pub(crate) session_expiration_minutes: u64,
}

impl AuthConfig {
    fn empty_sessions() -> Vec<SessionRecord> {
        Vec::with_capacity(MAX_SESSIONS + 1)
    }

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
        _issued_at: SystemTime,
    ) -> Self {
        Self {
            user,
            password,
            localhost_no_auth,
            sessions: Self::empty_sessions(),
            sessions_rev: 0,
            session_expiration_minutes,
        }
    }

    /// Fresh token with the configured expiry policy.
    fn mint_token(&self) -> String {
        use std::hash::BuildHasher;
        let mut seed = Sha256::new();
        // OS-seeded entropy: a fresh RandomState per call carries keys the
        // process derived from the operating system, not from anything
        // an attacker can observe. Time and credentials only mix it.
        let os_entropy = std::hash::RandomState::new().hash_one(SystemTime::now());
        seed.update(os_entropy.to_le_bytes());
        seed.update(self.user.as_deref().unwrap_or(""));
        seed.update(b":");
        seed.update(self.password.as_deref().unwrap_or(""));
        seed.update(b":");
        seed.update(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
                .to_le_bytes(),
        );
        seed.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn expiry_from_now(&self) -> SystemTime {
        if self.session_expiration_minutes == SESSION_EXPIRATION_NEVER {
            // Never expire: only an explicit logout (or a settings save
            // resetting the set) invalidates the session. This is the
            // default so an open window never bounces to the login page.
            never_expires_at()
        } else {
            SystemTime::now()
                + Duration::from_secs(self.session_expiration_minutes.saturating_mul(60))
        }
    }

    /// Mint a new session, append it as most-recently-used, evicting the
    /// least recently used session when the cap is hit. Returns the record for the
    /// response cookie.
    pub(crate) fn issue_session(&mut self) -> SessionRecord {
        // Expired-but-unremoved records must not eat cap slots: purge
        // first, so the cap counts only live sessions.
        self.purge_lapsed();
        let record = SessionRecord {
            token: self.mint_token(),
            expires_at: self.expiry_from_now(),
        };
        self.sessions.push(record.clone());
        if self.sessions.len() > MAX_SESSIONS {
            self.sessions.remove(0);
        }
        self.sessions_rev = self.sessions_rev.wrapping_add(1);
        record
    }

    /// Drop lapsed sessions (lazy purge; the auth check is read-only).
    /// Returns the new rev when membership changed, for the sidecar sync.
    pub(crate) fn purge_lapsed(&mut self) -> Option<u64> {
        let before = self.sessions.len();
        self.sessions.retain(|session| session.is_valid());
        if self.sessions.len() != before {
            self.sessions_rev = self.sessions_rev.wrapping_add(1);
            Some(self.sessions_rev)
        } else {
            None
        }
    }

    /// Revoke exactly the session whose token matches (the caller's own
    /// cookie on logout). Other browsers stay logged in. True when a
    /// session was actually removed.
    pub(crate) fn revoke_session(&mut self, token: &str) -> bool {
        let before = self.sessions.len();
        self.sessions
            .retain(|session| !constant_time_eq(session.token.as_bytes(), token.as_bytes()));
        let revoked = self.sessions.len() != before;
        if revoked {
            self.sessions_rev = self.sessions_rev.wrapping_add(1);
        }
        revoked
    }

    /// Credential change (or localhost-bypass or policy flip): drop every
    /// session and mint one fresh for the browser making the change.
    pub(crate) fn reset_sessions(&mut self) -> SessionRecord {
        self.sessions = Self::empty_sessions();
        self.sessions_rev = self.sessions_rev.wrapping_add(1);
        self.issue_session()
    }

    /// Expiration policy changed without a credential change: keep every
    /// live session working by re-anchoring their expiries to the new
    /// policy (timed sessions get full windows from now; never-expire
    /// sessions get the sentinel). Returns the new expiry when any session
    /// exists, for the cookie re-issue to the caller.
    pub(crate) fn reanchor_expiries(&mut self) -> Option<SystemTime> {
        let new_expiry = self.expiry_from_now();
        if self.sessions.is_empty() {
            return None;
        }
        for session in &mut self.sessions {
            session.expires_at = new_expiry;
        }
        self.sessions_rev = self.sessions_rev.wrapping_add(1);
        Some(new_expiry)
    }

    /// Restore sessions persisted by a previous run (boot path). Lapsed
    /// records are dropped by the loader; the cap still applies.
    pub(crate) fn restore_sessions(&mut self, records: Vec<SessionRecord>) {
        self.sessions = records;
        self.sessions.truncate(MAX_SESSIONS);
        self.sessions_rev = self.sessions_rev.wrapping_add(1);
    }

    /// Cookie Max-Age for a session expiry, pinned to a year so a
    /// never-expiring session's cookie does not die with the browser.
    pub(crate) fn cookie_max_age(expires_at: SystemTime) -> u64 {
        expires_at
            .duration_since(SystemTime::now())
            .map(|remaining| remaining.as_secs())
            .unwrap_or(0)
            .clamp(1, 365 * 24 * 60 * 60)
    }

    /// True when any live session is still valid.
    pub(crate) fn token_is_valid(&self) -> bool {
        self.sessions.iter().any(SessionRecord::is_valid)
    }

    /// Find a valid session by token, moving it to the LRU tail. Read-only
    /// on a miss: an unknown token purges nothing.
    pub(crate) fn find_valid_session(&mut self, token: &[u8]) -> Option<&SessionRecord> {
        let index = self
            .sessions
            .iter()
            .position(|session| constant_time_eq(session.token.as_bytes(), token))?;
        if !self.sessions[index].is_valid() {
            return None;
        }
        let session = self.sessions.remove(index);
        self.sessions.push(session);
        self.sessions.last()
    }

    /// Legacy single-token accessor kept for the settings-save identity
    /// comparison and the sidecar fallback paths.
    pub(crate) fn current_session(&self) -> Option<&SessionRecord> {
        self.sessions
            .iter()
            .rev()
            .find(|session| session.is_valid())
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

/// Extract this request's session-cookie token, if any. The logout path
/// uses it to revoke exactly the caller's session.
pub(crate) fn cookie_value(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())?
        .split(';')
        .filter_map(|part| part.trim().strip_prefix(COOKIE_PREFIX))
        .map(str::to_string)
        .next()
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
    let Ok(mut auth) = auth.lock() else {
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
    let mut matched = false;
    for part in cookie.split(';') {
        let Some(value) = part.trim().strip_prefix(COOKIE_PREFIX) else {
            continue;
        };
        if auth.find_valid_session(value.as_bytes()).is_some() {
            matched = true;
            break;
        }
    }
    // Lapsed sessions the check happened to skip never stay authorized, and
    // a miss must not mutate state.
    matched && auth.token_is_valid()
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
/// so no proxy downgrade can strip it in the common deployment. A
/// never-expiring session still pins the browser cookie at one year: a
/// session cookie (`Max-Age` omitted) would die with the browser process
/// and reintroduce the logged-out-after-a-while complaint on restarts.
/// The login APPENDS a session: every other browser stays logged in.
pub(crate) fn login_response(auth: &Mutex<AuthConfig>, secure: bool) -> Response {
    let (token, max_age) = auth
        .lock()
        .map(|mut auth| {
            let record = auth.issue_session();
            (record.token, AuthConfig::cookie_max_age(record.expires_at))
        })
        .unwrap_or_default();
    session_cookie_response(token, max_age, secure)
}

/// Response carrying a session cookie for an already-issued token. Used by
/// the settings save: it can rotate the token (credentials changed) and
/// must re-issue the cookie on the same response, otherwise every browser
/// instantly 401s into the login page after a benign settings save.
/// The response JSON body is the caller's concern; this only attaches the
/// Set-Cookie header, so compose by mutating the caller's response instead
/// when the body is not `{"ok":true}`.
pub(crate) fn attach_session_cookie(
    response: &mut Response,
    token: &str,
    max_age: u64,
    secure: bool,
) {
    let secure_flag = if secure { "; Secure" } else { "" };
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE_NAME}={token}; Max-Age={max_age}; HttpOnly; SameSite=Lax{secure_flag}; Path=/"
        ))
        .expect("valid cookie"),
    );
}

fn session_cookie_response(token: String, max_age: u64, secure: bool) -> Response {
    let mut response = Json(json!({ "ok": true })).into_response();
    attach_session_cookie(&mut response, &token, max_age, secure);
    response
}

/// Explicit-logout response scoped to the caller. Only the session whose
/// token matches the caller's cookie is revoked; every other browser keeps
/// its own session. The caller's cookie is cleared with `Max-Age=0`. The
/// `Clear-Site-Data` header stays out: it also wipes cached assets and
/// would make the next login slower for no security gain.
pub(crate) fn logout_response(
    auth: &Mutex<AuthConfig>,
    cookie_token: &str,
    secure: bool,
) -> Response {
    if let Ok(mut auth) = auth.lock() {
        auth.revoke_session(cookie_token);
    }
    let mut response = Json(json!({ "ok": true })).into_response();
    let secure_flag = if secure { "; Secure" } else { "" };
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE_NAME}=; Max-Age=0; HttpOnly; SameSite=Lax{secure_flag}; Path=/"
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
        let mut a = AuthConfig::from_parts_with_expiration(
            None,
            None,
            true,
            DEFAULT_SESSION_EXPIRATION_MINUTES,
        );
        let mut b = AuthConfig::from_parts_with_expiration(
            None,
            None,
            true,
            DEFAULT_SESSION_EXPIRATION_MINUTES,
        );
        let first = a.issue_session().token;
        let second = b.issue_session().token;
        assert_ne!(first, second, "time seed must vary session tokens");
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
        let token = auth.lock().unwrap().issue_session().token;
        assert!(authorized(&auth, &headers_with_cookie(&token), remote));
        assert!(!authorized(
            &auth,
            &headers_with_cookie("wrong-token"),
            remote
        ));
        assert!(!authorized(&auth, &HeaderMap::new(), remote));
    }

    #[test]
    fn authorized_accepts_each_of_multiple_sessions() {
        // The core multi-browser contract: two cookie jars, both valid.
        let (auth, remote) = make_auth(false);
        let first = auth.lock().unwrap().issue_session().token;
        let second = auth.lock().unwrap().issue_session().token;
        assert!(authorized(&auth, &headers_with_cookie(&first), remote));
        assert!(authorized(&auth, &headers_with_cookie(&second), remote));
    }

    #[test]
    fn authorized_localhost_bypass_skips_cookie() {
        let (auth, remote) = make_auth(true);
        assert!(authorized(&auth, &HeaderMap::new(), remote));
    }

    #[test]
    fn expired_session_cookie_is_rejected() {
        let (auth, remote) = make_auth(false);
        let token = {
            let mut auth = auth.lock().unwrap();
            let record = auth.issue_session();
            // Force the session into the past regardless of policy.
            auth.sessions[0].expires_at = SystemTime::now() - Duration::from_secs(1);
            record.token
        };
        assert!(!authorized(&auth, &headers_with_cookie(&token), remote));
    }

    #[test]
    fn never_expiring_restored_session_stays_valid() {
        // A never-expire record restored from a previous run (any age)
        // keeps authorizing: the far-future sentinel cannot lapse.
        let (auth, remote) = make_auth(false);
        let token = "persisted-long-ago-token".to_string();
        auth.lock().unwrap().restore_sessions(vec![SessionRecord {
            token: token.clone(),
            expires_at: never_expires_at(),
        }]);
        assert!(authorized(&auth, &headers_with_cookie(&token), remote));
    }

    #[test]
    fn logout_revokes_only_the_caller_session() {
        let (auth, _) = make_auth(false);
        let first = auth.lock().unwrap().issue_session().token;
        let second = auth.lock().unwrap().issue_session().token;
        let response = logout_response(&auth, &first, false);
        {
            let auth = auth.lock().unwrap();
            assert!(
                !auth.sessions.iter().any(|s| s.token == first),
                "the caller's session must be revoked"
            );
            assert!(
                auth.sessions.iter().any(|s| s.token == second),
                "other browsers must stay logged in"
            );
        }
        let cookie = response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        assert!(cookie.contains("Max-Age=0"), "logout must clear the cookie");
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
    }

    #[test]
    fn logout_with_unknown_token_changes_nothing() {
        let (auth, _) = make_auth(false);
        auth.lock().unwrap().issue_session();
        let rev_before = auth.lock().unwrap().sessions_rev;
        logout_response(&auth, "no-such-token", false);
        let auth = auth.lock().unwrap();
        assert_eq!(auth.sessions.len(), 1, "unknown token revokes nothing");
        assert_eq!(auth.sessions_rev, rev_before);
    }

    #[test]
    fn issuing_past_the_cap_evicts_the_oldest_session() {
        let (auth, remote) = make_auth(false);
        let mut tokens = Vec::new();
        for _ in 0..(MAX_SESSIONS + 1) {
            tokens.push(auth.lock().unwrap().issue_session().token);
        }
        let auth_guard = auth.lock().unwrap();
        assert_eq!(auth_guard.sessions.len(), MAX_SESSIONS);
        assert!(
            !auth_guard.sessions.iter().any(|s| s.token == tokens[0]),
            "the least recently used session must be evicted at the cap"
        );
        drop(auth_guard);
        assert!(!authorized(&auth, &headers_with_cookie(&tokens[0]), remote));
        assert!(authorized(
            &auth,
            &headers_with_cookie(&tokens[MAX_SESSIONS]),
            remote
        ));
    }

    #[test]
    fn eviction_is_lru_not_fifo() {
        // Fill the pool, then use the oldest session so it becomes the most
        // recently used. The next login past the cap must evict a different,
        // untouched session, not the freshly used one. Pins the LRU contract
        // (touch moves a session to the tail; index 0 is the victim).
        let (auth, remote) = make_auth(false);
        let mut tokens = Vec::new();
        for _ in 0..MAX_SESSIONS {
            tokens.push(auth.lock().unwrap().issue_session().token);
        }
        // Use token 0: authorized() must find it valid (and move it to the
        // LRU tail).
        assert!(authorized(&auth, &headers_with_cookie(&tokens[0]), remote));
        // One more login past the cap.
        tokens.push(auth.lock().unwrap().issue_session().token);
        {
            let auth_guard = auth.lock().unwrap();
            assert_eq!(auth_guard.sessions.len(), MAX_SESSIONS);
            // The freshly used token 0 survived; untouched token 1 did not.
            assert!(
                auth_guard.sessions.iter().any(|s| s.token == tokens[0]),
                "a freshly used session must survive eviction (LRU)"
            );
            assert!(
                !auth_guard.sessions.iter().any(|s| s.token == tokens[1]),
                "an untouched session must be the eviction victim (LRU)"
            );
            // The next LRU head is the untouched token 2 (token 1 was evicted).
            assert_eq!(auth_guard.sessions[0].token, tokens[2]);
        }
        // The used session stays authorized; the victim is rejected.
        assert!(authorized(&auth, &headers_with_cookie(&tokens[0]), remote));
        assert!(!authorized(&auth, &headers_with_cookie(&tokens[1]), remote));
        // The freshly issued one is valid too.
        assert!(authorized(
            &auth,
            &headers_with_cookie(&tokens[MAX_SESSIONS]),
            remote
        ));
    }

    #[test]
    fn purge_lapsed_drops_only_expired_sessions_and_bumps_rev() {
        let (auth, _) = make_auth(false);
        {
            let mut auth = auth.lock().unwrap();
            let live = auth.issue_session().clone();
            let lapsed = auth.issue_session();
            let mut sessions = vec![lapsed];
            sessions[0].expires_at = SystemTime::now() - Duration::from_secs(1);
            sessions.push(live);
            auth.restore_sessions(sessions);
        }
        let rev = auth.lock().unwrap().sessions_rev;
        assert_eq!(auth.lock().unwrap().purge_lapsed(), Some(rev + 1));
        assert_eq!(auth.lock().unwrap().sessions.len(), 1);
        assert_eq!(
            auth.lock().unwrap().purge_lapsed(),
            None,
            "second purge is a no-op"
        );
    }

    #[test]
    fn restart_eviction_follows_sidecar_snapshot_order() {
        // The sidecar records membership only; per-request touches are
        // memory-only by design (the hot path stays write-free). A restart
        // therefore resumes eviction from the snapshot order, not from
        // pre-restart usage: the file's first entry is the next victim
        // even if that session was the most recently used one before the
        // restart (validated live in W32d). Pins two contracts: restore
        // never reorders the file's entries, and eviction follows the
        // restored order exactly.
        let (auth, remote) = make_auth(false);
        let mut records = Vec::new();
        for i in 0..MAX_SESSIONS {
            records.push(SessionRecord {
                token: format!("snapshot-{i}"),
                expires_at: never_expires_at(),
            });
        }
        // "Boot 2": restore exactly what the loader hands over, file order.
        auth.lock().unwrap().restore_sessions(records);
        // One login past the cap evicts the snapshot's first entry.
        let fresh = auth.lock().unwrap().issue_session().token;
        let guard = auth.lock().unwrap();
        assert_eq!(guard.sessions.len(), MAX_SESSIONS);
        assert!(
            !guard.sessions.iter().any(|s| s.token == "snapshot-0"),
            "the snapshot's first entry is the victim, regardless of pre-restart usage"
        );
        for i in 1..MAX_SESSIONS {
            assert!(
                guard
                    .sessions
                    .iter()
                    .any(|s| s.token == format!("snapshot-{i}")),
                "snapshot entry {i} survives in file order"
            );
        }
        assert_eq!(
            guard.sessions.last().map(|s| s.token.as_str()),
            Some(fresh.as_str()),
            "the fresh session lands at the LRU tail"
        );
        drop(guard);
        // The victim is rejected afterwards; the survivors stay authorized.
        assert!(!authorized(
            &auth,
            &headers_with_cookie("snapshot-0"),
            remote
        ));
        assert!(authorized(
            &auth,
            &headers_with_cookie("snapshot-1"),
            remote
        ));
    }

    #[test]
    fn reanchor_expiries_keeps_sessions_and_updates_expiry() {
        let (auth, _) = make_auth(false);
        auth.lock().unwrap().issue_session();
        // Flip to a timed policy and re-anchor.
        let mut guard = auth.lock().unwrap();
        guard.session_expiration_minutes = 30;
        let new_expiry = guard.reanchor_expiries().expect("live session exists");
        assert!(guard.sessions.iter().all(|s| s.expires_at == new_expiry));
        assert!(
            new_expiry <= SystemTime::now() + Duration::from_secs(30 * 60 + 5),
            "timed re-anchor grants a full window from now"
        );
    }

    #[test]
    fn login_response_sets_http_only_cookie() {
        let (auth, _) = make_auth(false);
        let response = login_response(&auth, false);
        let token = auth
            .lock()
            .unwrap()
            .current_session()
            .map(|session| session.token.clone())
            .unwrap();
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
        assert!((1..=365 * 24 * 60 * 60).contains(&max_age));
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
