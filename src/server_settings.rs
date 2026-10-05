//! Server settings: persistence, validation, and merge for the web UI's
//! runtime configuration (`webui-settings.json`).
//!
//! Handlers stay in `main.rs` (single axum state type); this module owns the
//! data model and file I/O so the settings rules are testable in isolation.

use std::fs;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::builtin_detection::JcodeDetectionVariant;
use crate::{
    auth::{
        AuthConfig, DEFAULT_SESSION_EXPIRATION_MINUTES, LEGACY_DEFAULT_SESSION_EXPIRATION_MINUTES,
        MAX_SESSION_EXPIRATION_MINUTES, MIN_SESSION_EXPIRATION_MINUTES, SESSION_EXPIRATION_NEVER,
    },
    lsp, TlsMode, WebConfig,
};

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct PersistedServerSettings {
    pub bind: Option<String>,
    pub tls_mode: Option<TlsMode>,
    pub user: Option<String>,
    pub password: Option<String>,
    pub localhost_no_auth: Option<bool>,
    pub session_expiration_minutes: Option<u64>,
    /// Written by every save of this (newer) version. Absent on files last
    /// written before the never-expire default existed; the loader uses it
    /// to run the 1440 -> 0 migration exactly once per install.
    pub session_expiration_migrated: Option<bool>,
    pub no_sleep_auto_cooldown_seconds: Option<u64>,
    pub backend_mode: Option<BackendMode>,
    pub builtin_shell: Option<String>,
    pub default_folder: Option<String>,
    pub builtin_backend_enabled: Option<bool>,
    pub external_herdr_backend_enabled: Option<bool>,
    pub jcode_detection_variant: Option<String>,
    pub log_level: Option<LogLevel>,
    #[serde(default)]
    pub lsp: Option<lsp::LspSettings>,
    #[serde(default)]
    pub recent_workspaces: Option<Vec<RecentWorkspace>>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    #[default]
    None,
    Info,
    Debug,
}

impl LogLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            LogLevel::None => "none",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
        }
    }

    pub fn enabled(&self) -> bool {
        !matches!(self, LogLevel::None)
    }
}

pub fn log_event(level: &LogLevel, message: &str) {
    if level.enabled() {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        eprintln!("[{secs}] {message}");
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackendMode {
    ExternalHerdr,
    Builtin,
    Auto,
}

impl BackendMode {
    pub fn parse(value: &str) -> io::Result<Self> {
        match value {
            "external-herdr" | "external" | "herdr" => Ok(Self::ExternalHerdr),
            "builtin" | "built-in" => Ok(Self::Builtin),
            "auto" => Ok(Self::Auto),
            other => Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid --backend-mode: {other}; use external-herdr, builtin, or auto"),
            )),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExternalHerdr => "external-herdr",
            Self::Builtin => "builtin",
            Self::Auto => "auto",
        }
    }

    pub fn is_builtin(self) -> bool {
        matches!(self, Self::Builtin)
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct RecentWorkspace {
    pub path: String,
    pub label: Option<String>,
    pub branch: Option<String>,
    pub kind: Option<String>,
    pub opened_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RuntimeServerSettings {
    pub bind: SocketAddr,
    pub tls_mode: TlsMode,
    pub user: Option<String>,
    pub password: Option<String>,
    pub localhost_no_auth: bool,
    pub session_expiration_minutes: u64,
    pub no_sleep_auto_cooldown_seconds: u64,
    pub backend_mode: BackendMode,
    pub builtin_shell: Option<String>,
    pub default_folder: String,
    pub builtin_backend_enabled: bool,
    pub external_herdr_backend_enabled: bool,
    pub jcode_detection_variant: JcodeDetectionVariant,
    pub log_level: LogLevel,
    pub lsp: lsp::LspSettings,
    pub recent_workspaces: Vec<RecentWorkspace>,
}

impl AuthConfig {
    /// Builds the auth config from validated settings.
    pub fn from_settings(settings: &RuntimeServerSettings) -> io::Result<Self> {
        validate_runtime_server_settings(settings)?;
        Ok(AuthConfig::from_parts_with_expiration(
            settings.user.clone(),
            settings.password.clone(),
            settings.localhost_no_auth,
            settings.session_expiration_minutes,
        ))
    }
}

pub fn validate_runtime_server_settings(settings: &RuntimeServerSettings) -> io::Result<()> {
    if !(MIN_SESSION_EXPIRATION_MINUTES..=MAX_SESSION_EXPIRATION_MINUTES)
        .contains(&settings.session_expiration_minutes)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "session expiration must be 0 (never expire) or between 1 and {MAX_SESSION_EXPIRATION_MINUTES} minutes"
            ),
        ));
    }
    let local_bind = settings.bind.ip().is_loopback();
    if !local_bind && (settings.user.is_none() || settings.password.is_none()) {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "username and password are required before binding to 0.0.0.0 or any non-local address",
        ));
    }
    if local_bind
        && !settings.localhost_no_auth
        && (settings.user.is_none() || settings.password.is_none())
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "set username/password or allow localhost auth bypass",
        ));
    }
    if settings.no_sleep_auto_cooldown_seconds > 3600 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "no-sleep auto cooldown must be 3600 seconds or less",
        ));
    }
    if !settings.builtin_backend_enabled && !settings.external_herdr_backend_enabled {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "at least one backend type must be enabled",
        ));
    }
    Ok(())
}

pub fn default_runtime_server_settings(bind: SocketAddr) -> RuntimeServerSettings {
    RuntimeServerSettings {
        bind,
        tls_mode: TlsMode::Auto,
        user: None,
        password: None,
        localhost_no_auth: true,
        session_expiration_minutes: DEFAULT_SESSION_EXPIRATION_MINUTES,
        no_sleep_auto_cooldown_seconds: 60,
        backend_mode: BackendMode::Builtin,
        builtin_shell: None,
        default_folder: crate::default_working_folder(None),
        builtin_backend_enabled: true,
        external_herdr_backend_enabled: true,
        jcode_detection_variant: JcodeDetectionVariant::default(),
        log_level: LogLevel::default(),
        lsp: lsp::LspSettings::default(),
        recent_workspaces: Vec::new(),
    }
}

/// One-time migration for the never-expire default: files last written by an
/// old version carry the old 24h default and would keep auto-logging users
/// out. The `session_expiration_migrated` marker (written by every
/// new-version save) guarantees an operator who deliberately sets 1440 back
/// later is not reset on every start. Returns the value to persist in the
/// in-memory settings and sets `migrated` when the file needs a rewrite.
fn migrate_legacy_session_expiration(
    persisted: u64,
    marker: Option<bool>,
    migrated: &mut bool,
) -> u64 {
    if persisted == LEGACY_DEFAULT_SESSION_EXPIRATION_MINUTES && marker != Some(true) {
        *migrated = true;
        SESSION_EXPIRATION_NEVER
    } else {
        persisted
    }
}

pub fn server_settings_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("herdr-webui/webui-settings.json");
    }
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".config/herdr-webui/webui-settings.json"))
        .unwrap_or_else(|_| std::env::temp_dir().join("herdr-webui/webui-settings.json"))
}

/// Sidecar file holding the persisted session set, next to the settings
/// file (same directory and permissions) so sessions survive a WebUI
/// restart. Each record carries its token and absolute expiry (Unix
/// seconds; `None` only for never-expiring sessions). The loader drops
/// records that already lapsed, so a timed token is never resurrected
/// past its expiry.
///
/// Backwards compatibility, in fallback order: the current multi-session
/// `{"sessions":[..]}` array; the older single-record
/// `{"token":"..","expires_at":..}` object; and the very first raw-token
/// text format (bare hex token), which only ever held never-expire
/// sessions. A sidecar written by any older version restores on boot.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PersistedSessionToken {
    /// Live sessions, in LRU order as of the last membership change:
    /// least recently used first. Per-request touches after that write are
    /// memory-only, so a restart resumes LRU from this snapshot, not from
    /// live usage. Absent in older sidecar formats.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sessions: Vec<PersistedSessionRecord>,
    /// Single-token fallback: `Some` only when the file held the older
    /// one-record format (read path), or when every live session shares
    /// one expiry and the writer chose the compact single form (write
    /// path is always the multi form, so this stays `None` from us).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

/// One persisted session: token plus absolute expiry. `expires_at` is
/// `None` only for never-expiring sessions.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct PersistedSessionRecord {
    pub token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

impl PersistedSessionRecord {
    /// Whether this record is still valid at load time. Lapsed records
    /// are dropped by the loader so timed tokens never resurrect.
    pub fn is_live(&self) -> bool {
        let Some(expires_at) = self.expires_at else {
            return true;
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0);
        expires_at > now
    }

    /// Absolute expiry as `SystemTime`; the sentinel for never-expire
    /// records so the restore path needs no policy knowledge.
    pub fn to_system_time(&self) -> SystemTime {
        match self.expires_at {
            Some(secs) => SystemTime::UNIX_EPOCH + Duration::from_secs(secs),
            None => crate::auth::never_expires_at(),
        }
    }
}

pub fn session_token_path() -> PathBuf {
    server_settings_path().with_file_name("session-token")
}

/// Restore the persisted session set for sessions that are still valid.
/// None when the file is missing, unreadable, malformed, empty, or holds
/// only lapsed records (the caller falls back to a fresh boot state).
/// Best effort: a corrupted or deleted sidecar must never block startup.
pub fn load_persisted_session_token() -> Option<PersistedSessionToken> {
    let raw = fs::read_to_string(session_token_path()).ok()?;
    if let Ok(record) = serde_json::from_str::<PersistedSessionToken>(&raw) {
        let sessions = if record.sessions.is_empty() {
            // Older single-record sidecar: `token` held the one live session.
            record
                .token
                .as_deref()
                .map(str::trim)
                .filter(|token| !token.is_empty())
                .map(|token| {
                    vec![PersistedSessionRecord {
                        token: token.to_string(),
                        expires_at: record.expires_at,
                    }]
                })
                .unwrap_or_default()
        } else {
            record.sessions
        };
        let live: Vec<PersistedSessionRecord> = sessions
            .into_iter()
            .filter(PersistedSessionRecord::is_live)
            .collect();
        if live.is_empty() {
            return None;
        }
        return Some(PersistedSessionToken {
            sessions: live,
            token: None,
            expires_at: None,
        });
    }
    // Legacy sidecar: a bare token was only ever written for
    // never-expiring sessions, so it restores as never-expire.
    let token = raw.trim();
    if token.is_empty() {
        return None;
    }
    Some(PersistedSessionToken {
        sessions: vec![PersistedSessionRecord {
            token: token.to_string(),
            expires_at: None,
        }],
        token: None,
        expires_at: None,
    })
}

/// Persist the live session set so the next boot restores it instead of
/// logging every open window out. Called after every membership change
/// (login, logout, settings save). Failures are the caller's to log; a
/// failed write only costs persistence, never the in-memory sessions.
pub fn save_persisted_session_token(record: &PersistedSessionToken) -> io::Result<()> {
    // Same isolation contract as the settings file: an unisolated test
    // writing the real sidecar silently destroys the operator's live
    // sessions (fixture tokens replace the minted ones on the next boot).
    assert_test_settings_isolation();
    let path = session_token_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_string(record)?;
    atomic_write(&path, payload.as_bytes())?;
    Ok(())
}

/// Write `content` to `path` so readers and crash recovery never observe a
/// truncated file: the payload lands in a sibling temp file first and a
/// rename swaps it in atomically. A plain `fs::write` truncates first, so a
/// crash (or a concurrent reader: observed live on 2026-10-05, 37 empty
/// reads per 2000 writes in a repro) could see an empty sidecar and boot
/// with every persisted session gone. The settings file shares the risk.
pub fn atomic_write(path: &Path, content: &[u8]) -> io::Result<()> {
    let temp = path.with_extension("new");
    fs::write(&temp, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&temp, fs::Permissions::from_mode(0o600));
    }
    fs::rename(&temp, path)?;
    Ok(())
}

/// Drop the persisted token when it must not be resurrected later (for
/// example when credentials were cleared or the record on disk is stale).
/// Best effort, like the save. Currently only exercised by tests: every
/// production path re-persists the newest token instead of removing the
/// sidecar, but the primitive stays because the cleanup is part of the
/// sidecar contract (and future credential-drop flows will need it).
#[allow(dead_code)]
pub fn remove_persisted_session_token() {
    let _ = fs::remove_file(session_token_path());
}

/// Apply CLI flags that must win over persisted settings.
/// An explicit `--bind` beats the persisted bind from webui-settings.json;
/// otherwise a preview instance could silently squat the saved port instead of
/// the one the operator asked for. An explicit `--https` beats the persisted
/// tls_mode for the same reason.
pub fn apply_cli_overrides(settings: &mut RuntimeServerSettings, config: &WebConfig) {
    if config.bind_explicit {
        settings.bind = config.bind;
    }
    if config.tls_mode_explicit {
        settings.tls_mode = config.tls.mode;
    }
}

pub fn load_runtime_server_settings(default_bind: SocketAddr) -> io::Result<RuntimeServerSettings> {
    let mut settings = default_runtime_server_settings(default_bind);
    let path = server_settings_path();
    let Ok(raw) = fs::read_to_string(path) else {
        save_runtime_server_settings(&settings)?;
        return Ok(settings);
    };
    let raw_json: serde_json::Value = serde_json::from_str(&raw).map_err(|err| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid webui-settings.json: {err}"),
        )
    })?;
    let missing_keys = [
        "bind",
        "tls_mode",
        "user",
        "password",
        "localhost_no_auth",
        "session_expiration_minutes",
        "no_sleep_auto_cooldown_seconds",
        "backend_mode",
        "builtin_shell",
        "default_folder",
        "builtin_backend_enabled",
        "external_herdr_backend_enabled",
        "log_level",
    ]
    .iter()
    .any(|key| raw_json.get(key).is_none());
    let persisted: PersistedServerSettings = serde_json::from_value(raw_json).map_err(|err| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("invalid webui-settings.json: {err}"),
        )
    })?;
    if let Some(bind) = persisted.bind {
        settings.bind = bind.parse().map_err(|err| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid saved bind: {err}"),
            )
        })?;
    }
    if let Some(tls_mode) = persisted.tls_mode {
        settings.tls_mode = tls_mode;
    }
    if persisted.user.is_some() {
        settings.user = persisted.user.filter(|value| !value.is_empty());
    }
    if persisted.password.is_some() {
        settings.password = persisted.password.filter(|value| !value.is_empty());
    }
    if let Some(localhost_no_auth) = persisted.localhost_no_auth {
        settings.localhost_no_auth = localhost_no_auth;
    }
    let mut expiration_migrated = false;
    if let Some(session_expiration_minutes) = persisted.session_expiration_minutes {
        settings.session_expiration_minutes = migrate_legacy_session_expiration(
            session_expiration_minutes,
            persisted.session_expiration_migrated,
            &mut expiration_migrated,
        );
    }
    if let Some(cooldown) = persisted.no_sleep_auto_cooldown_seconds {
        settings.no_sleep_auto_cooldown_seconds = cooldown;
    }
    if let Some(backend_mode) = persisted.backend_mode {
        settings.backend_mode = backend_mode;
    }
    if persisted.builtin_shell.is_some() {
        settings.builtin_shell = persisted.builtin_shell.filter(|value| !value.is_empty());
    }
    if persisted.default_folder.is_some() {
        settings.default_folder =
            crate::default_working_folder_without_prompt(persisted.default_folder.as_deref());
    }
    if let Some(enabled) = persisted.builtin_backend_enabled {
        settings.builtin_backend_enabled = enabled;
    }
    if let Some(enabled) = persisted.external_herdr_backend_enabled {
        settings.external_herdr_backend_enabled = enabled;
    }
    if let Some(variant_str) = persisted.jcode_detection_variant {
        settings.jcode_detection_variant = JcodeDetectionVariant::from_str(&variant_str);
    }
    if let Some(log_level) = persisted.log_level {
        settings.log_level = log_level;
    }
    if let Some(lsp) = persisted.lsp {
        settings.lsp = lsp;
    }
    if let Some(recent) = persisted.recent_workspaces {
        settings.recent_workspaces = recent;
    }
    validate_runtime_server_settings(&settings)?;
    if missing_keys || expiration_migrated {
        save_runtime_server_settings(&settings)?;
    }
    Ok(settings)
}

/// Tests must never persist settings to the operator's real config file:
/// a stray save clobbers `~/.config/herdr-webui/webui-settings.json` and
/// locks the operator out of their own server (username/password fixtures
/// replace real credentials). Every test that reaches a persisting route
/// must set `XDG_CONFIG_HOME` to a temp dir; `lock_env()` serializes those
/// env mutations. This guard turns an unisolated test into a loud failure
/// instead of a silent config overwrite.
#[cfg(test)]
pub fn assert_test_settings_isolation() {
    if std::env::var_os("XDG_CONFIG_HOME").is_none() {
        panic!(
            "test would write the real settings path; set XDG_CONFIG_HOME \
             to a temp dir (see lock_env-isolated tests) before persisting"
        );
    }
}

#[cfg(not(test))]
pub fn assert_test_settings_isolation() {}

pub fn save_runtime_server_settings(settings: &RuntimeServerSettings) -> io::Result<()> {
    validate_runtime_server_settings(settings)?;
    // Runs after validation: rejection tests assert on the validation error
    // itself and never write, so they must not trip the guard.
    assert_test_settings_isolation();
    let path = server_settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(&PersistedServerSettings {
        bind: Some(settings.bind.to_string()),
        tls_mode: Some(settings.tls_mode),
        user: settings.user.clone(),
        password: settings.password.clone(),
        localhost_no_auth: Some(settings.localhost_no_auth),
        session_expiration_minutes: Some(settings.session_expiration_minutes),
        session_expiration_migrated: Some(true),
        no_sleep_auto_cooldown_seconds: Some(settings.no_sleep_auto_cooldown_seconds),
        backend_mode: Some(settings.backend_mode),
        builtin_shell: settings.builtin_shell.clone(),
        default_folder: Some(settings.default_folder.clone()),
        builtin_backend_enabled: Some(settings.builtin_backend_enabled),
        external_herdr_backend_enabled: Some(settings.external_herdr_backend_enabled),
        jcode_detection_variant: Some(settings.jcode_detection_variant.as_str().to_string()),
        log_level: Some(settings.log_level.clone()),
        lsp: Some(settings.lsp.clone()),
        recent_workspaces: Some(settings.recent_workspaces.clone()),
    })?;
    atomic_write(&path, content.as_bytes())?;
    Ok(())
}

pub fn settings_public_json(settings: &RuntimeServerSettings) -> serde_json::Value {
    serde_json::json!({
        "bind": settings.bind.to_string(),
        "tls_mode": settings.tls_mode.as_str(),
        "scheme": settings.tls_mode.scheme(),
        "https_bind": settings.tls_mode.https_bind(settings.bind).map(|addr| addr.to_string()),
        "username": settings.user.clone().unwrap_or_default(),
        "has_password": settings.password.is_some(),
        "localhost_no_auth": settings.localhost_no_auth,
        "session_expiration_minutes": settings.session_expiration_minutes,
        "no_sleep_auto_cooldown_seconds": settings.no_sleep_auto_cooldown_seconds,
        "backend_mode": settings.backend_mode.as_str(),
        "builtin_shell": settings.builtin_shell.clone(),
        "default_folder": settings.default_folder.clone(),
        "builtin_backend_enabled": settings.builtin_backend_enabled,
        "external_herdr_backend_enabled": settings.external_herdr_backend_enabled,
        "log_level": settings.log_level.as_str(),
        "enabled_backends": {
            "builtin": settings.builtin_backend_enabled,
            "external-herdr": settings.external_herdr_backend_enabled,
        },
        "settings_path": server_settings_path().to_string_lossy(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::SESSION_EXPIRATION_NEVER;
    use crate::tests::lock_env;

    fn valid_settings() -> RuntimeServerSettings {
        default_runtime_server_settings("127.0.0.1:8787".parse().unwrap())
    }

    #[test]
    fn rejects_public_bind_without_credentials() {
        let mut settings = valid_settings();
        settings.bind = "0.0.0.0:8787".parse().unwrap();
        settings.user = None;
        settings.password = None;
        let err = validate_runtime_server_settings(&settings).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    /// Pins finding #4's last line of defense: the isolation guard must
    /// PANIC when XDG is unset, so an unisolated persisting test fails
    /// loudly instead of silently overwriting the operator's real
    /// settings/sidecar files. Proves the guard fires (a guard that
    /// silently passes is worse than no guard).
    ///
    /// Runs under catch_unwind instead of #[should_panic]: a should_panic
    /// test unwinds through the shared env lock with the panic still
    /// "uncaught", so std poisons the mutex and every later env-lock test
    /// in the binary cascades with PoisonError (observed on CI: 12 service
    /// tests). catch_unwind catches the panic before the lock guard drops,
    /// so the mutex stays healthy, and XDG_CONFIG_HOME is restored so the
    /// unset window cannot leak into later tests.
    #[test]
    fn isolation_guard_panics_when_xdg_unset() {
        let _guard = lock_env();
        let saved = std::env::var("XDG_CONFIG_HOME");
        std::env::remove_var("XDG_CONFIG_HOME");
        let caught = std::panic::catch_unwind(assert_test_settings_isolation);
        let payload = caught.expect_err("isolation guard must panic when XDG_CONFIG_HOME is unset");
        let panic_msg: String = if let Some(s) = payload.downcast_ref::<&'static str>() {
            (*s).to_string()
        } else if let Some(s) = payload.downcast_ref::<String>() {
            s.clone()
        } else {
            String::from("<non-string panic payload>")
        };
        assert!(
            panic_msg.contains("test would write the real settings path"),
            "isolation guard panicked with an unexpected message: {panic_msg}"
        );
        match saved {
            Ok(v) => std::env::set_var("XDG_CONFIG_HOME", v),
            Err(_) => std::env::remove_var("XDG_CONFIG_HOME"),
        }
    }

    /// The guard must NOT fire when isolation is in place, and the save
    /// path it protects must then target the isolated location.
    #[test]
    fn isolation_guard_passes_and_save_targets_isolated_path() {
        let _guard = lock_env();
        let xdg = std::env::temp_dir().join(format!("herdr-guard-pass-{}", std::process::id()));
        std::env::set_var("XDG_CONFIG_HOME", &xdg);
        assert_test_settings_isolation();
        let settings = valid_settings();
        save_runtime_server_settings(&settings).unwrap();
        let written = server_settings_path();
        assert!(
            written.starts_with(&xdg),
            "save landed at {}",
            written.display()
        );
        let _ = std::fs::remove_dir_all(&xdg);
        std::env::remove_var("XDG_CONFIG_HOME");
    }

    #[test]
    fn rejects_local_bind_without_credentials_or_bypass() {
        let mut settings = valid_settings();
        settings.localhost_no_auth = false;
        let err = validate_runtime_server_settings(&settings).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[test]
    fn rejects_disabling_all_backends() {
        let mut settings = valid_settings();
        settings.builtin_backend_enabled = false;
        settings.external_herdr_backend_enabled = false;
        let err = validate_runtime_server_settings(&settings).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn rejects_no_sleep_cooldown_above_one_hour() {
        let mut settings = valid_settings();
        settings.no_sleep_auto_cooldown_seconds = 3601;
        let err = validate_runtime_server_settings(&settings).unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    }

    #[test]
    fn validates_session_expiration_range() {
        let mut settings = valid_settings();
        settings.session_expiration_minutes = MAX_SESSION_EXPIRATION_MINUTES + 1;
        assert_eq!(
            validate_runtime_server_settings(&settings)
                .unwrap_err()
                .kind(),
            io::ErrorKind::InvalidInput
        );

        settings.session_expiration_minutes = SESSION_EXPIRATION_NEVER;
        assert!(
            validate_runtime_server_settings(&settings).is_ok(),
            "0 must mean never-expiring sessions"
        );
        settings.session_expiration_minutes = 1;
        assert!(validate_runtime_server_settings(&settings).is_ok());
        settings.session_expiration_minutes = MAX_SESSION_EXPIRATION_MINUTES;
        assert!(validate_runtime_server_settings(&settings).is_ok());
    }

    #[test]
    fn persisted_session_token_roundtrip_and_cleanup() {
        let _guard = lock_env();
        let dir = std::env::temp_dir().join(format!("herdr-token-test-{}", std::process::id()));
        std::env::set_var("XDG_CONFIG_HOME", &dir);

        // Missing file: no sessions, no panic.
        assert_eq!(load_persisted_session_token(), None);

        // Roundtrip (multi-session, never-expire): save then load returns them.
        let never = PersistedSessionToken {
            sessions: vec![
                PersistedSessionRecord {
                    token: "abc123".to_string(),
                    expires_at: None,
                },
                PersistedSessionRecord {
                    token: "def456".to_string(),
                    expires_at: None,
                },
            ],
            token: None,
            expires_at: None,
        };
        save_persisted_session_token(&never).unwrap();
        let loaded = load_persisted_session_token().unwrap();
        assert_eq!(loaded.sessions.len(), 2);
        assert_eq!(loaded.sessions[0].token, "abc123");
        assert_eq!(loaded.sessions[1].token, "def456");
        assert_eq!(loaded.sessions[0].expires_at, None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(session_token_path())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "sidecar must be owner-only");
        }

        // Timed record: expiry survives; a lapsed record is rejected
        // instead of resurrected; mixed live/lapsed keeps only the live one.
        let future = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        let timed = PersistedSessionToken {
            sessions: vec![PersistedSessionRecord {
                token: "timed456".to_string(),
                expires_at: Some(future),
            }],
            token: None,
            expires_at: None,
        };
        save_persisted_session_token(&timed).unwrap();
        let loaded = load_persisted_session_token().unwrap();
        assert_eq!(loaded.sessions[0].token, "timed456");
        assert_eq!(loaded.sessions[0].expires_at, Some(future));
        let past = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - 1;
        let mixed = PersistedSessionToken {
            sessions: vec![
                PersistedSessionRecord {
                    token: "gone789".to_string(),
                    expires_at: Some(past),
                },
                PersistedSessionRecord {
                    token: "live000".to_string(),
                    expires_at: Some(future),
                },
            ],
            token: None,
            expires_at: None,
        };
        save_persisted_session_token(&mixed).unwrap();
        let loaded = load_persisted_session_token().unwrap();
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].token, "live000");
        let all_lapsed = PersistedSessionToken {
            sessions: vec![PersistedSessionRecord {
                token: "gone999".to_string(),
                expires_at: Some(past),
            }],
            token: None,
            expires_at: None,
        };
        save_persisted_session_token(&all_lapsed).unwrap();
        assert_eq!(load_persisted_session_token(), None);

        // Older single-record format (token + expires_at, no sessions array)
        // still restores as one live session.
        fs::write(
            session_token_path(),
            serde_json::to_string(&serde_json::json!({
                "token": "oldfmt1",
                "expires_at": future,
            }))
            .unwrap(),
        )
        .unwrap();
        let loaded = load_persisted_session_token().unwrap();
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].token, "oldfmt1");
        assert_eq!(loaded.sessions[0].expires_at, Some(future));

        // Legacy raw-token sidecar loads as a never-expire record.
        fs::write(session_token_path(), "  legacy123  \n").unwrap();
        let loaded = load_persisted_session_token().unwrap();
        assert_eq!(loaded.sessions.len(), 1);
        assert_eq!(loaded.sessions[0].token, "legacy123");
        assert_eq!(loaded.sessions[0].expires_at, None);

        // Removal drops it.
        remove_persisted_session_token();
        assert_eq!(load_persisted_session_token(), None);

        // Corrupt/empty content reads as no sessions (best effort).
        fs::write(session_token_path(), "   ").unwrap();
        assert_eq!(load_persisted_session_token(), None);
        remove_persisted_session_token();
        std::env::remove_var("XDG_CONFIG_HOME");
    }

    #[test]
    fn legacy_1440_default_migrates_to_never_expire_once() {
        let mut migrated = false;
        assert_eq!(
            migrate_legacy_session_expiration(1440, None, &mut migrated),
            SESSION_EXPIRATION_NEVER
        );
        assert!(migrated, "a legacy file must be rewritten with the marker");

        // After the save, the marker is present: a deliberate 1440 sticks.
        let mut migrated = false;
        assert_eq!(
            migrate_legacy_session_expiration(1440, Some(true), &mut migrated),
            1440
        );
        assert!(!migrated);

        // Non-default values never migrate.
        let mut migrated = false;
        assert_eq!(
            migrate_legacy_session_expiration(60, None, &mut migrated),
            60
        );
        assert!(!migrated);

        // 1440 stays valid: hand-maintained configs keep working.
        let mut settings = valid_settings();
        settings.session_expiration_minutes = LEGACY_DEFAULT_SESSION_EXPIRATION_MINUTES;
        assert_eq!(settings.session_expiration_minutes, 1440);
        assert!(validate_runtime_server_settings(&settings).is_ok());
    }

    #[test]
    fn backend_mode_parses_aliases() {
        assert_eq!(
            BackendMode::parse("herdr").unwrap(),
            BackendMode::ExternalHerdr
        );
        assert_eq!(BackendMode::parse("builtin").unwrap(), BackendMode::Builtin);
        assert_eq!(
            BackendMode::parse("built-in").unwrap(),
            BackendMode::Builtin
        );
        assert_eq!(BackendMode::parse("auto").unwrap(), BackendMode::Auto);
        assert!(BackendMode::parse("nope").is_err());
    }

    #[test]
    fn tls_mode_defaults_to_auto_and_roundtrips_as_kebab_case() {
        let settings = valid_settings();
        assert_eq!(settings.tls_mode, crate::TlsMode::Auto);
        let mut off = valid_settings();
        off.tls_mode = crate::TlsMode::Off;
        let json = serde_json::to_string(&PersistedServerSettings {
            tls_mode: Some(off.tls_mode),
            ..PersistedServerSettings::default()
        })
        .unwrap();
        assert!(
            json.contains("\"off\""),
            "serialized mode must be kebab-case, got: {json}"
        );
        let parsed: PersistedServerSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.tls_mode, Some(crate::TlsMode::Off));
        let self_signed = serde_json::to_string(&PersistedServerSettings {
            tls_mode: Some(crate::TlsMode::SelfSigned),
            ..PersistedServerSettings::default()
        })
        .unwrap();
        assert!(self_signed.contains("\"self-signed\""));
        let files = serde_json::to_string(&PersistedServerSettings {
            tls_mode: Some(crate::TlsMode::Files),
            ..PersistedServerSettings::default()
        })
        .unwrap();
        assert!(files.contains("\"files\""));
        let both = serde_json::to_string(&PersistedServerSettings {
            tls_mode: Some(crate::TlsMode::Both),
            ..PersistedServerSettings::default()
        })
        .unwrap();
        assert!(both.contains("\"both\""));
        let parsed_both: PersistedServerSettings = serde_json::from_str(&both).unwrap();
        assert_eq!(parsed_both.tls_mode, Some(crate::TlsMode::Both));
        assert_eq!(crate::TlsMode::Both.scheme(), "http");
        assert_eq!(
            crate::TlsMode::Both.https_bind("127.0.0.1:8787".parse().unwrap()),
            Some("127.0.0.1:8788".parse().unwrap())
        );
        assert_eq!(
            crate::TlsMode::Off.https_bind("127.0.0.1:8787".parse().unwrap()),
            None
        );
        assert!(crate::TlsMode::Both.uses_tls());
        assert!(!crate::TlsMode::Off.uses_tls());
    }

    #[test]
    fn log_level_enabled_only_for_info_and_debug() {
        assert!(!LogLevel::None.enabled());
        assert!(LogLevel::Info.enabled());
        assert!(LogLevel::Debug.enabled());
        assert_eq!(LogLevel::Info.as_str(), "info");
    }

    #[test]
    fn auth_config_from_settings_validates_first() {
        let mut settings = valid_settings();
        settings.localhost_no_auth = false;
        assert!(AuthConfig::from_settings(&settings).is_err());
        settings.localhost_no_auth = true;
        let auth = AuthConfig::from_settings(&settings).unwrap();
        let loopback: std::net::SocketAddr = "127.0.0.1:1234".parse().unwrap();
        assert!(auth.localhost_bypass(loopback));
    }

    #[test]
    fn atomic_write_never_exposes_a_partial_file_to_readers() {
        use std::sync::Arc;
        let dir = std::env::temp_dir().join(format!(
            "herdr-webui-atomic-write-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sidecar.json");
        let payload = "{".to_string() + &"x".repeat(4096) + "}";
        // Pre-create so the reader only ever judges tearing, not the
        // not-yet-created window before the writer's first rename.
        fs::write(&path, payload.as_bytes()).unwrap();
        let writer_payload = payload.clone();
        let writer_path = Arc::new(path.clone());
        let writer = std::thread::spawn(move || {
            for _ in 0..500 {
                atomic_write(&writer_path, writer_payload.as_bytes()).unwrap();
            }
        });
        let mut bad_reads = 0;
        for _ in 0..2000 {
            match fs::read(&path) {
                Ok(bytes) if bytes == payload.as_bytes() => {}
                // A read that observes truncation (empty/partial) or a
                // missing file is exactly the bug this pins out.
                Ok(_) => bad_reads += 1,
                Err(_) => bad_reads += 1,
            }
        }
        writer.join().unwrap();
        assert_eq!(bad_reads, 0, "reader saw a torn or missing file");
        let _ = fs::remove_dir_all(&dir);
    }
}
