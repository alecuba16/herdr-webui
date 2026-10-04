//! Server settings: persistence, validation, and merge for the web UI's
//! runtime configuration (`webui-settings.json`).
//!
//! Handlers stay in `main.rs` (single axum state type); this module owns the
//! data model and file I/O so the settings rules are testable in isolation.

use std::fs;
use std::io;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

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

/// Sidecar file holding the persisted session token, next to the settings
/// file (same directory and permissions) so sessions survive a WebUI restart.
/// `expires_at` carries the token's absolute expiry (Unix seconds; `None`
/// only for never-expiring sessions) so a timed token is never resurrected
/// after it lapsed: the restore path rejects records already in the past,
/// and a never-expire record keeps working with the raw-token format the
/// first version of the sidecar wrote.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PersistedSessionToken {
    pub token: String,
    pub expires_at: Option<u64>,
}

pub fn session_token_path() -> PathBuf {
    server_settings_path().with_file_name("session-token")
}

/// Restore the persisted session token for sessions that are still valid.
/// None when the file is missing, unreadable, malformed, empty, or already
/// expired (the caller falls back to a fresh boot token). Best effort: a
/// corrupted or deleted sidecar must never block startup.
pub fn load_persisted_session_token() -> Option<PersistedSessionToken> {
    let raw = fs::read_to_string(session_token_path()).ok()?;
    let (token, expires_at) =
        if let Ok(record) = serde_json::from_str::<PersistedSessionToken>(&raw) {
            (record.token, record.expires_at)
        } else {
            // Legacy sidecar: a bare token was only ever written for
            // never-expiring sessions, so it restores as never-expire.
            (raw.trim().to_string(), None)
        };
    let token = token.trim();
    if token.is_empty() {
        return None;
    }
    if let Some(expires_at) = expires_at {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|value| value.as_secs())
            .unwrap_or(0);
        if expires_at <= now {
            return None;
        }
    }
    Some(PersistedSessionToken {
        token: token.to_string(),
        expires_at,
    })
}

/// Persist the current session token and its expiry so the next boot
/// restores it instead of logging every open window out. Called after every
/// rotation (login, logout, settings save). Failures are the caller's to
/// log; a failed write only costs persistence, never the in-memory session.
pub fn save_persisted_session_token(record: &PersistedSessionToken) -> io::Result<()> {
    let path = session_token_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let payload = serde_json::to_string(record)?;
    fs::write(&path, payload)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
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
    fs::write(&path, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
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

        // Missing file: no token, no panic.
        assert_eq!(load_persisted_session_token(), None);

        // Roundtrip (never-expire record): save then load returns it.
        let never = PersistedSessionToken {
            token: "abc123".to_string(),
            expires_at: None,
        };
        save_persisted_session_token(&never).unwrap();
        let loaded = load_persisted_session_token().unwrap();
        assert_eq!(loaded.token, "abc123");
        assert_eq!(loaded.expires_at, None);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(session_token_path())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "sidecar must be owner-only");
        }

        // Roundtrip (timed record): expiry survives and a lapsed record is
        // rejected instead of resurrected.
        let future = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 3600;
        let timed = PersistedSessionToken {
            token: "timed456".to_string(),
            expires_at: Some(future),
        };
        save_persisted_session_token(&timed).unwrap();
        let loaded = load_persisted_session_token().unwrap();
        assert_eq!(loaded.token, "timed456");
        assert_eq!(loaded.expires_at, Some(future));
        let lapsed = PersistedSessionToken {
            token: "gone789".to_string(),
            expires_at: Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs()
                    - 1,
            ),
        };
        save_persisted_session_token(&lapsed).unwrap();
        assert_eq!(load_persisted_session_token(), None);

        // Legacy raw-token sidecar loads as a never-expire record.
        fs::write(session_token_path(), "  legacy123  \n").unwrap();
        let loaded = load_persisted_session_token().unwrap();
        assert_eq!(loaded.token, "legacy123");
        assert_eq!(loaded.expires_at, None);

        // Removal drops it.
        remove_persisted_session_token();
        assert_eq!(load_persisted_session_token(), None);

        // Corrupt/empty content reads as no token (best effort).
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
}
