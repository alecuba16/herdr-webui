//! Inline unit tests for the WebUI server handlers and helpers.
//!
//! Extracted verbatim from main.rs so the production source is not
//! 70% test code. All names resolve as before: the module sits at
//! the crate root next to main.rs, so `use super::*` keeps meaning
//! "the whole main.rs namespace" for the bin target.
use super::*;
use axum::body::{to_bytes, Body};
use axum::http::{Method, Request};
use serde_json::Value;
use std::io::Cursor;
use std::sync::{Mutex as StdMutex, OnceLock};
use std::thread;
use tower::ServiceExt;

fn test_state() -> WebState {
    let bind = DEFAULT_BIND.parse::<SocketAddr>().unwrap();
    let (rebind_tx, _) = tokio::sync::watch::channel(ListenEndpoint {
        bind,
        tls_mode: TlsMode::Auto,
    });
    let (settings_tx, _) = tokio::sync::broadcast::channel(16);
    WebState {
        api_socket: Some(PathBuf::from("/tmp/default-api.sock")),
        client_socket: Some(PathBuf::from("/tmp/default-client.sock")),
        session_name: None,
        backend_mode: BackendMode::ExternalHerdr,
        _builtin_backend: None,
        builtin_sessions: Arc::new(Mutex::new(HashMap::new())),
        closed_builtin_sessions: Arc::new(Mutex::new(HashSet::new())),
        promoted_temporary_tabs: Arc::new(Mutex::new(HashMap::new())),
        builtin_start_lock: Arc::new(Mutex::new(())),
        herdr_bin: "herdr".to_string(),
        auth: Arc::new(Mutex::new(AuthConfig {
            user: Some("user".to_string()),
            password: Some("pass".to_string()),
            localhost_no_auth: false,
            token: "token-123".to_string(),
            token_expires_at: SystemTime::now()
                + Duration::from_secs(DEFAULT_SESSION_EXPIRATION_MINUTES * 60),
            session_expiration_minutes: DEFAULT_SESSION_EXPIRATION_MINUTES,
        })),
        login_limiter: Arc::new(LoginRateLimiter::new()),
        server_settings: Arc::new(Mutex::new(RuntimeServerSettings {
            bind,
            tls_mode: TlsMode::Auto,
            user: Some("user".to_string()),
            password: Some("pass".to_string()),
            localhost_no_auth: false,
            session_expiration_minutes: DEFAULT_SESSION_EXPIRATION_MINUTES,
            no_sleep_auto_cooldown_seconds: 60,
            backend_mode: BackendMode::ExternalHerdr,
            builtin_shell: None,
            default_folder: std::env::temp_dir().to_string_lossy().to_string(),
            builtin_backend_enabled: true,
            external_herdr_backend_enabled: true,
            jcode_detection_variant: JcodeDetectionVariant::default(),
            log_level: LogLevel::default(),
            lsp: lsp::LspSettings::default(),
            recent_workspaces: Vec::new(),
        })),
        no_sleep: Arc::new(Mutex::new(NoSleepState::default())),
        rebind_tx,
        settings_tx,
        workspace_orders: Arc::new(Mutex::new(HashMap::new())),
        lsp: Arc::new(lsp::LspRegistry::new(Default::default())),
    }
}

fn test_app() -> Router {
    app_router(test_state())
}

fn test_app_with_state(state: WebState) -> Router {
    app_router(state)
}

fn request(method: Method, uri: &str) -> axum::http::request::Builder {
    Request::builder()
        .method(method)
        .uri(uri)
        .extension(ConnectInfo("192.0.2.1:1234".parse::<SocketAddr>().unwrap()))
}

async fn response_json(response: Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

fn env_lock() -> &'static StdMutex<()> {
    static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| StdMutex::new(()))
}

/// Lock the env mutex, recovering from a poisoned state so a panicking
/// test does not cascade failures into every other env-lock test.
fn lock_env() -> std::sync::MutexGuard<'static, ()> {
    env_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

/// Monotonic suffix for fake-socket names. Timestamps alone can collide
/// when parallel tests start within the same clock tick on loaded CI
/// runners; a collision makes the second create clobber the first
/// listener and the first accept() fail (observed as flaky 502s in
/// proxy tests that never fail locally).
fn fake_socket_suffix() -> u64 {
    static COUNTER: OnceLock<std::sync::atomic::AtomicU64> = OnceLock::new();
    COUNTER
        .get_or_init(|| std::sync::atomic::AtomicU64::new(0))
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Deterministic directory for fake local-socket paths whose length must
/// stay under `SOCKET_PATH_LIMIT` even on CI runners whose TMPDIR is a
/// long per-job path (GitHub macOS runners use ~70+ byte temp dirs, so a
/// nanos-based name there would push the attach socket over the limit
/// and the relay would reject it before ever connecting).
#[cfg(unix)]
fn fake_socket_dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = PathBuf::from("/tmp").join(format!("herdr-wui-t{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir
    })
    .clone()
}

#[cfg(unix)]
fn fake_api_socket(response: serde_json::Value) -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = std::env::temp_dir().join(format!(
        "herdr-webui-api-test-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let handle = thread::spawn(move || {
        let mut stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], "ping");
        stream
            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
            .unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    });
    (path, handle)
}

#[test]
fn parses_default_config() {
    let config = WebConfig::parse(&[]).unwrap();

    assert_eq!(config.bind, DEFAULT_BIND.parse::<SocketAddr>().unwrap());
    assert!(
        !config.bind_explicit,
        "no --bind leaves bind_explicit false"
    );
    assert_eq!(config.session, None);
    assert_eq!(config.api_socket, None);
    assert_eq!(config.client_socket, None);
    assert_eq!(config.backend_mode, None);
    assert_eq!(config.tls.mode, TlsMode::Auto);
}

#[test]
fn parses_backend_modes_and_session_targets() {
    assert_eq!(
        BackendMode::parse("external-herdr").unwrap(),
        BackendMode::ExternalHerdr
    );
    assert_eq!(
        BackendMode::parse("external").unwrap(),
        BackendMode::ExternalHerdr
    );
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
    assert_eq!(BackendMode::Builtin.as_str(), "builtin");
    assert_eq!(BackendMode::Auto.as_str(), "auto");
    assert!(BackendMode::Builtin.is_builtin());
    assert!(!BackendMode::ExternalHerdr.is_builtin());
    assert!(BackendMode::parse("bad")
        .unwrap_err()
        .to_string()
        .contains("invalid --backend-mode"));

    assert_eq!(
        SessionBackendTarget::parse("external"),
        Some(SessionBackendTarget::ExternalHerdr)
    );
    assert_eq!(
        SessionBackendTarget::parse("built-in"),
        Some(SessionBackendTarget::Builtin)
    );
    assert_eq!(SessionBackendTarget::Builtin.as_str(), "builtin");
    assert_eq!(SessionBackendTarget::parse("unknown"), None);
}

#[test]
fn builtin_event_hub_detection_only_matches_builtin_protocol_16() {
    assert!(backend_uses_builtin_event_hub(&BackendInfo {
        version: Some("builtin-0.1.0".to_string()),
        protocol: Some(18),
    }));
    assert!(!backend_uses_builtin_event_hub(&BackendInfo {
        version: Some("builtin-0.1.0".to_string()),
        protocol: Some(15),
    }));
    assert!(!backend_uses_builtin_event_hub(&BackendInfo {
        version: Some("1.2.3".to_string()),
        protocol: Some(18),
    }));
    assert!(!backend_uses_builtin_event_hub(&BackendInfo {
        version: None,
        protocol: Some(18),
    }));
}

#[test]
fn web_event_kind_extracts_wrapped_backend_events() {
    let value = json!({
        "type": "event",
        "event": { "event": "pane.agent_status_changed", "data": {} }
    });
    assert_eq!(web_event_kind(&value), Some("pane.agent_status_changed"));
    let value = json!({
        "type": "event",
        "event": { "type": "layout.updated", "data": {} }
    });
    assert_eq!(web_event_kind(&value), Some("layout.updated"));
    assert_eq!(web_event_kind(&json!({ "type": "snapshot" })), None);
}

#[test]
fn parses_https_off_opt_out() {
    let args = ["--https", "off"].map(String::from);

    let config = WebConfig::parse(&args).unwrap();
    assert_eq!(config.tls.mode, TlsMode::Off);
    assert!(config.tls_mode_explicit);
}

#[test]
fn tls_mode_not_explicit_without_https_flag() {
    let args: Vec<String> = Vec::new();
    let config = WebConfig::parse(&args).unwrap();
    assert!(!config.tls_mode_explicit);
    // Without an explicit flag the persisted tls_mode from
    // webui-settings.json must win; apply_cli_overrides must leave it
    // untouched.
    let mut settings =
        server_settings::default_runtime_server_settings(DEFAULT_BIND.parse().unwrap());
    settings.tls_mode = TlsMode::Off;
    apply_cli_overrides(&mut settings, &config);
    assert_eq!(settings.tls_mode, TlsMode::Off);
}

#[test]
fn parses_bare_https_defaults_to_auto() {
    // Bare `--https` with no value must default to Auto (self-signed),
    // and it must not swallow the next flag as its value.
    let args = ["--https"].map(String::from);
    assert_eq!(WebConfig::parse(&args).unwrap().tls.mode, TlsMode::Auto);

    // `--https` directly followed by another flag: Auto again, and the
    // following flag is still parsed (bind wins the error surface).
    let args = ["--https", "--bind", "127.0.0.1:9797"].map(String::from);
    let config = WebConfig::parse(&args).unwrap();
    assert_eq!(config.tls.mode, TlsMode::Auto);
    assert_eq!(config.bind, "127.0.0.1:9797".parse::<SocketAddr>().unwrap());
}

#[test]
fn promote_guard_registry_ignores_blank_ids_and_counts_concurrent_begins() {
    let registry: PromotedTemporaryTabs = Arc::new(Mutex::new(HashMap::new()));

    // Blank ids (whitespace-only or empty) must never enter the registry:
    // a stray marker for "" would protect nothing and only leak memory.
    begin_temporary_tab_promote(&registry, "");
    begin_temporary_tab_promote(&registry, "   ");
    assert!(registry.lock().unwrap().is_empty());

    // finish with a blank id is a no-op: it must not decrement some
    // other tab's count (the lookup is by the same blank id, but the
    // guard documents the contract).
    finish_temporary_tab_promote(&registry, "", false);
    assert!(registry.lock().unwrap().is_empty());

    // finish(failure) for a tab that never began must not insert
    // anything (saturating decrement of a missing entry is a no-op).
    finish_temporary_tab_promote(&registry, "tab-ghost", false);
    assert!(registry.lock().unwrap().get("tab-ghost").is_none());

    // Concurrent begins count up on the same tab; begin over an
    // already-Promoted tab never downgrades it to Promoting.
    begin_temporary_tab_promote(&registry, "tab-x");
    begin_temporary_tab_promote(&registry, "tab-x");
    assert_eq!(
        registry.lock().unwrap().get("tab-x"),
        Some(&PromotedTemporaryTabState::Promoting(2))
    );
    finish_temporary_tab_promote(&registry, "tab-x", true);
    begin_temporary_tab_promote(&registry, "tab-x");
    assert_eq!(
        registry.lock().unwrap().get("tab-x"),
        Some(&PromotedTemporaryTabState::Promoted)
    );
}

#[test]
fn parses_all_config_flags() {
    let args = [
        "--bind",
        "0.0.0.0:9999",
        "--session",
        "work",
        "--api-socket",
        "/tmp/api.sock",
        "--client-socket",
        "/tmp/client.sock",
        "--backend-mode",
        "builtin",
        "--https",
        "files",
        "--tls-cert",
        "/tmp/cert.pem",
        "--tls-key",
        "/tmp/key.pem",
    ]
    .map(String::from);

    let config = WebConfig::parse(&args).unwrap();

    assert_eq!(config.bind, "0.0.0.0:9999".parse::<SocketAddr>().unwrap());
    assert!(config.bind_explicit, "explicit --bind sets bind_explicit");
    assert_eq!(config.session.as_deref(), Some("work"));
    assert_eq!(
        config.api_socket.as_deref(),
        Some(Path::new("/tmp/api.sock"))
    );
    assert_eq!(
        config.client_socket.as_deref(),
        Some(Path::new("/tmp/client.sock"))
    );
    assert_eq!(config.backend_mode, Some(BackendMode::Builtin));
    assert_eq!(config.tls.mode, TlsMode::Files);
    assert_eq!(
        config.tls.cert_path.as_deref(),
        Some(Path::new("/tmp/cert.pem"))
    );
    assert_eq!(
        config.tls.key_path.as_deref(),
        Some(Path::new("/tmp/key.pem"))
    );
}

#[test]
fn parses_https_modes_and_infers_auto_mode() {
    let bare_https = ["--https"].map(String::from);
    let auto = ["--https", "auto"].map(String::from);
    let self_signed = ["--https", "self-signed"].map(String::from);
    let files = ["--tls-cert", "/tmp/cert.pem", "--tls-key", "/tmp/key.pem"].map(String::from);

    assert_eq!(
        WebConfig::parse(&bare_https).unwrap().tls.mode,
        TlsMode::Auto
    );
    assert_eq!(WebConfig::parse(&auto).unwrap().tls.mode, TlsMode::Auto);
    assert_eq!(
        WebConfig::parse(&self_signed).unwrap().tls.mode,
        TlsMode::SelfSigned
    );
    assert_eq!(WebConfig::parse(&files).unwrap().tls.mode, TlsMode::Auto);
}

#[test]
fn tls_files_mode_allows_missing_paths_for_self_signed_fallback() {
    let missing_key = ["--https", "files", "--tls-cert", "/tmp/cert.pem"].map(String::from);

    let config = WebConfig::parse(&missing_key).unwrap();

    assert_eq!(config.tls.mode, TlsMode::Files);
    assert_eq!(
        config.tls.cert_path.as_deref(),
        Some(Path::new("/tmp/cert.pem"))
    );
    assert_eq!(config.tls.key_path, None);
}

#[test]
fn self_signed_cert_paths_are_stable_per_user_config() {
    let config = Path::new("/home/alice/.config/herdr");

    let (cert, key) = self_signed_cert_paths(config);

    assert_eq!(cert, config.join("tls/self-signed-cert.pem"));
    assert_eq!(key, config.join("tls/self-signed-key.pem"));
    assert!(!cert.starts_with("/home/alice/project"));
}

#[test]
fn help_lists_macos_service_commands() {
    let text = help_text();

    assert!(text.contains("herdr-webui update-mac"));
    assert!(text.contains("herdr-webui install-linux"));
    assert!(text.contains("herdr-webui update-linux"));
    assert!(text.contains("herdr-webui start-mac | start"));
    assert!(text.contains("herdr-webui stop-mac | stop"));
    assert!(text.contains("herdr-webui restart-mac | restart"));
    assert!(text.contains("herdr-webui start-linux | start"));
    assert!(text.contains("herdr-webui stop-linux | stop"));
    assert!(text.contains("herdr-webui restart-linux | restart"));
    assert!(text.contains("herdr-webui uninstall-linux"));
    assert!(text.contains("--backend-mode <external-herdr|builtin|auto>"));
    assert!(text.contains("Default backend mode for fresh settings is builtin"));
}

#[test]
fn manifest_keeps_default_run_for_quick_start() {
    // `cargo run -- ...` (the documented quick start) fails with "could
    // not determine which binary to run" unless the package sets
    // `default-run`, because this crate builds two binaries.
    let manifest = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml"))
        .expect("Cargo.toml next to the crate root");
    let has_active_default_run = manifest.lines().any(|line| {
        line.trim_start()
            .starts_with("default-run = \"herdr-webui\"")
    });
    assert!(
            has_active_default_run,
            "Cargo.toml must keep an active `default-run = \"herdr-webui\"` key so the README quick start works"
        );
}

#[test]
fn rejects_invalid_config_flags() {
    let missing = ["--bind"].map(String::from);
    let invalid_bind = ["--bind", "not-a-socket"].map(String::from);
    let unknown = ["--unknown"].map(String::from);
    let invalid_https = ["--https", "letsencrypt"].map(String::from);
    let invalid_backend = ["--backend-mode", "other"].map(String::from);

    assert_eq!(
        WebConfig::parse(&missing).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        WebConfig::parse(&invalid_bind).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        WebConfig::parse(&unknown).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        WebConfig::parse(&invalid_https).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
    assert_eq!(
        WebConfig::parse(&invalid_backend).unwrap_err().kind(),
        io::ErrorKind::InvalidInput
    );
}

#[test]
fn existing_workspace_cwd_allows_blank_cwd() {
    assert_eq!(existing_workspace_cwd(None).unwrap(), None);
    assert_eq!(existing_workspace_cwd(Some("  ")).unwrap(), None);
}

#[test]
fn existing_workspace_cwd_expands_existing_directory() {
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-workspace-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();

    let cwd = existing_workspace_cwd(Some(dir.to_str().unwrap())).unwrap();

    assert_eq!(cwd.as_deref(), Some(dir.to_str().unwrap()));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn existing_workspace_cwd_rejects_missing_directory() {
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-missing-workspace-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    let response = existing_workspace_cwd(Some(dir.to_str().unwrap())).unwrap_err();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn derives_session_paths() {
    let _guard = lock_env();
    std::env::set_var("XDG_CONFIG_HOME", "/tmp/herdr-config");

    assert_eq!(session_dir(None), PathBuf::from("/tmp/herdr-config/herdr"));
    assert_eq!(
        session_dir(Some("default")),
        PathBuf::from("/tmp/herdr-config/herdr")
    );
    assert_eq!(
        session_dir(Some("work")),
        PathBuf::from("/tmp/herdr-config/herdr/sessions/work")
    );
    assert_eq!(
        api_socket_path_for(Some("work")),
        PathBuf::from("/tmp/herdr-config/herdr/sessions/work/herdr.sock")
    );
    assert_eq!(
        client_socket_path_for(Some("work")),
        PathBuf::from("/tmp/herdr-config/herdr/sessions/work/herdr-client.sock")
    );

    std::env::remove_var("XDG_CONFIG_HOME");
}

#[test]
fn derives_safe_builtin_socket_paths() {
    let _guard = lock_env();
    std::env::set_var("XDG_CONFIG_HOME", "/tmp/herdr-config");

    let (api, client) = builtin_socket_paths(Some("team/session 1"));

    assert!(api.ends_with("herdr-webui/builtin/team_session_1/herdr.sock"));
    assert!(client.ends_with("herdr-webui/builtin/team_session_1/herdr-client.sock"));

    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[test]
fn builtin_socket_paths_fall_back_when_unix_path_would_be_too_long() {
    use std::os::unix::ffi::OsStrExt;

    let _guard = lock_env();
    let long_component = "x".repeat(140);
    std::env::set_var("XDG_CONFIG_HOME", format!("/tmp/{long_component}"));

    let (api, client) = builtin_socket_paths(Some("default"));

    assert!(api.to_string_lossy().contains("herdr-webui-builtin-"));
    assert!(client.to_string_lossy().contains("herdr-webui-builtin-"));
    assert!(api.as_os_str().as_bytes().len() < 100);
    assert!(client.as_os_str().as_bytes().len() < 100);

    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[test]
fn socket_path_fits_matches_limit_boundaries() {
    let _guard = lock_env();
    // Exactly at the limit fails; one byte under passes.
    let at_limit = PathBuf::from("x".repeat(SOCKET_PATH_LIMIT));
    let under_limit = PathBuf::from("x".repeat(SOCKET_PATH_LIMIT - 1));
    assert!(!socket_path_fits(&at_limit));
    assert!(socket_path_fits(&under_limit));
}

#[cfg(unix)]
#[test]
fn external_client_socket_path_reports_unfitting_sessions() {
    let _guard = lock_env();
    // Short roots keep short session names fitting (regression guard):
    // config_dir()/sessions/<name>/herdr-client.sock under the limit.
    std::env::set_var("XDG_CONFIG_HOME", "/tmp/herdr-test");
    let short = client_socket_path_for(Some("work"));
    assert!(socket_path_fits(&short));

    // A root long enough that config_dir()/sessions/<name>/
    // herdr-client.sock cannot fit: the guard must flag it so the
    // attach path can refuse with a clear error instead of a confusing
    // connect failure.
    let long_component = "x".repeat(140);
    std::env::set_var("XDG_CONFIG_HOME", format!("/tmp/{long_component}"));
    let long_session = "y".repeat(60);
    let client = client_socket_path_for(Some(&long_session));
    assert!(!socket_path_fits(&client));

    std::env::remove_var("XDG_CONFIG_HOME");
}

#[test]
fn resolves_session_from_headers_and_state() {
    let mut state = test_state();
    let mut headers = HeaderMap::new();

    assert_eq!(session_from_headers(&state, &headers), None);

    state.session_name = Some("configured".to_string());
    assert_eq!(
        session_from_headers(&state, &headers).as_deref(),
        Some("configured")
    );

    headers.insert("x-herdr-session", HeaderValue::from_static(" request "));
    assert_eq!(
        session_from_headers(&state, &headers).as_deref(),
        Some("request")
    );

    headers.insert("x-herdr-session", HeaderValue::from_static("default"));
    assert_eq!(
        session_from_headers(&state, &headers).as_deref(),
        Some("configured")
    );
}

#[test]
fn resolves_socket_paths_from_header_session_or_overrides() {
    let state = test_state();
    let headers = HeaderMap::new();

    assert_eq!(
        api_for_headers(&state, &headers)
            .backend
            .api_socket()
            .to_path_buf(),
        PathBuf::from("/tmp/default-api.sock")
    );
    assert_eq!(
        client_socket_for_headers(&state, &headers),
        PathBuf::from("/tmp/default-client.sock")
    );

    let mut session_headers = HeaderMap::new();
    session_headers.insert("x-herdr-session", HeaderValue::from_static("work"));

    assert!(api_for_headers(&state, &session_headers)
        .backend
        .api_socket()
        .to_path_buf()
        .ends_with("sessions/work/herdr.sock"));
    assert!(client_socket_for_headers(&state, &session_headers)
        .ends_with("sessions/work/herdr-client.sock"));
}

#[test]
fn builtin_mode_routes_header_sessions_to_builtin_socket_namespace() {
    let _guard = lock_env();
    std::env::set_var("XDG_CONFIG_HOME", "/tmp/herdr-config");
    let mut state = test_state();
    state.backend_mode = BackendMode::Builtin;
    state.api_socket = Some(PathBuf::from("/tmp/builtin-api.sock"));
    state.client_socket = Some(PathBuf::from("/tmp/builtin-client.sock"));
    let mut headers = HeaderMap::new();
    headers.insert("x-herdr-session", HeaderValue::from_static("other"));

    let (other_api, other_client) = builtin_socket_paths(Some("other"));
    assert_eq!(
        api_for_headers(&state, &headers)
            .backend
            .api_socket()
            .to_path_buf(),
        other_api
    );
    assert_eq!(client_socket_for_headers(&state, &headers), other_client);

    let (query_api, query_client) = builtin_socket_paths(Some("query"));
    assert_eq!(
        api_for_query_session_routed(&state, &headers, Some("query"), None)
            .backend
            .api_socket()
            .to_path_buf(),
        query_api
    );
    assert_eq!(
        client_socket_for_query_session(&state, &headers, Some("query"), None),
        query_client
    );

    std::env::remove_var("XDG_CONFIG_HOME");
}

#[test]
fn explicit_backend_header_can_route_external_while_default_is_builtin() {
    let mut state = test_state();
    state.backend_mode = BackendMode::Builtin;
    let mut headers = HeaderMap::new();
    headers.insert("x-herdr-session", HeaderValue::from_static("work"));
    headers.insert(
        "x-herdr-backend",
        HeaderValue::from_static("external-herdr"),
    );

    assert_eq!(
        backend_target_for_headers(&state, &headers),
        SessionBackendTarget::ExternalHerdr
    );
    assert!(api_for_headers(&state, &headers)
        .backend
        .api_socket()
        .to_path_buf()
        .ends_with("herdr/sessions/work/herdr.sock"));
}

#[test]
fn disabled_backend_type_is_hidden_and_not_selected() {
    let _guard = lock_env();
    let root = std::env::temp_dir().join(format!(
        "herdr-webui-disabled-backends-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("herdr/sessions/work")).unwrap();
    fs::create_dir_all(root.join("herdr-webui/builtin/inside")).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &root);
    let mut state = test_state();
    state.backend_mode = BackendMode::Builtin;
    state
        .server_settings
        .lock()
        .unwrap()
        .external_herdr_backend_enabled = false;
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-herdr-backend",
        HeaderValue::from_static("external-herdr"),
    );
    headers.insert("x-herdr-session", HeaderValue::from_static("work"));

    assert_eq!(
        backend_target_for_headers(&state, &headers),
        SessionBackendTarget::Builtin
    );
    let sessions = known_sessions(&state, false);

    assert!(sessions
        .iter()
        .all(|session| session.get("backend").and_then(Value::as_str) != Some("external-herdr")));
    assert!(sessions.iter().any(|session| {
        session.get("backend").and_then(Value::as_str) == Some("builtin")
            && session.get("name").and_then(Value::as_str) == Some("inside")
    }));

    std::env::remove_var("XDG_CONFIG_HOME");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn known_sessions_reports_external_and_builtin_entries() {
    let _guard = lock_env();
    let root =
        std::env::temp_dir().join(format!("herdr-webui-sessions-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("herdr/sessions/work")).unwrap();
    fs::create_dir_all(root.join("herdr-webui/builtin/inside")).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &root);
    let state = test_state();

    let sessions = known_sessions(&state, true);
    let pairs = sessions
        .iter()
        .map(|session| {
            (
                session.get("backend").and_then(Value::as_str).unwrap_or(""),
                session.get("name").and_then(Value::as_str).unwrap_or(""),
            )
        })
        .collect::<Vec<_>>();

    assert!(pairs.contains(&("external-herdr", "default")));
    assert!(pairs.contains(&("external-herdr", "work")));
    assert!(pairs.contains(&("builtin", "default")));
    assert!(pairs.contains(&("builtin", "inside")));

    std::env::remove_var("XDG_CONFIG_HOME");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn runtime_settings_reject_disabling_all_backend_types() {
    let mut settings = default_runtime_server_settings(DEFAULT_BIND.parse().unwrap());
    settings.builtin_backend_enabled = false;
    settings.external_herdr_backend_enabled = false;

    let err = validate_runtime_server_settings(&settings).unwrap_err();

    assert_eq!(err.kind(), io::ErrorKind::InvalidInput);
    assert!(err.to_string().contains("at least one backend type"));
}

#[cfg(unix)]
#[test]
fn known_sessions_is_passive_and_does_not_execute_herdr_bin() {
    use std::os::unix::fs::PermissionsExt;

    let _guard = lock_env();
    let root = std::env::temp_dir().join(format!(
        "herdr-webui-passive-sessions-test-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(root.join("herdr/sessions/work")).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &root);
    let marker = root.join("herdr-was-executed");
    let fake_herdr = root.join("fake-herdr");
    fs::write(
        &fake_herdr,
        format!("#!/bin/sh\ntouch '{}'\n", marker.display()),
    )
    .unwrap();
    let mut permissions = fs::metadata(&fake_herdr).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&fake_herdr, permissions).unwrap();
    let mut state = test_state();
    state.backend_mode = BackendMode::Builtin;
    state.herdr_bin = fake_herdr.display().to_string();

    // A compatible detected herdr install: external sessions are offered.
    let sessions = known_sessions(&state, true);

    assert!(sessions.iter().any(|session| {
        session.get("backend").and_then(Value::as_str) == Some("external-herdr")
            && session.get("name").and_then(Value::as_str) == Some("work")
    }));
    assert!(!marker.exists(), "session discovery must not execute Herdr");
    std::env::remove_var("XDG_CONFIG_HOME");
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn authorizes_loopback_when_localhost_bypass_enabled() {
    let state = test_state();
    state.auth.lock().unwrap().localhost_no_auth = true;

    assert!(authorized(
        &state,
        &HeaderMap::new(),
        "127.0.0.1:1234".parse().unwrap()
    ));
    assert!(!authorized(
        &state,
        &HeaderMap::new(),
        "192.0.2.1:1234".parse().unwrap()
    ));
}

#[test]
fn authorizes_matching_cookie_only() {
    let state = test_state();
    let mut headers = HeaderMap::new();

    headers.insert(
        header::COOKIE,
        HeaderValue::from_static("other=x; herdr_web_session=token-123; theme=dark"),
    );
    assert!(authorized(
        &state,
        &headers,
        "192.0.2.1:1234".parse().unwrap()
    ));

    headers.insert(
        header::COOKIE,
        HeaderValue::from_static("herdr_web_session=nope"),
    );
    assert!(!authorized(
        &state,
        &headers,
        "192.0.2.1:1234".parse().unwrap()
    ));
}

#[test]
fn default_runtime_server_settings_use_no_credentials_local_bypass_and_builtin_backend() {
    let settings = default_runtime_server_settings("127.0.0.1:8787".parse().unwrap());

    assert_eq!(settings.bind, "127.0.0.1:8787".parse().unwrap());
    assert_eq!(settings.user, None);
    assert_eq!(settings.password, None);
    assert!(settings.localhost_no_auth);
    assert_eq!(
        settings.session_expiration_minutes,
        DEFAULT_SESSION_EXPIRATION_MINUTES
    );
    assert_eq!(settings.no_sleep_auto_cooldown_seconds, 60);
    assert_eq!(settings.backend_mode, BackendMode::Builtin);
    assert_eq!(settings.builtin_shell, None);
    assert!(!settings.default_folder.is_empty());
}

#[test]
fn missing_runtime_settings_file_creates_defaults() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-settings-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let settings = load_runtime_server_settings("127.0.0.1:8787".parse().unwrap()).unwrap();

    assert_eq!(settings.user, None);
    assert_eq!(settings.password, None);
    assert!(settings.localhost_no_auth);
    assert!(server_settings_path().exists());
    let raw = fs::read_to_string(server_settings_path()).unwrap();
    assert!(raw.contains("localhost_no_auth"));
    assert!(raw.contains("session_expiration_minutes"));
    assert!(raw.contains("no_sleep_auto_cooldown_seconds"));
    assert!(raw.contains("backend_mode"));
    assert!(raw.contains(r#""backend_mode": "builtin""#));
    assert!(raw.contains("builtin_shell"));
    assert!(raw.contains("default_folder"));

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[test]
fn existing_runtime_settings_file_backfills_missing_keys() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-settings-backfill-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let path = server_settings_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, r#"{"bind":"127.0.0.1:9999"}"#).unwrap();

    let settings = load_runtime_server_settings("127.0.0.1:8787".parse().unwrap()).unwrap();

    assert_eq!(settings.bind, "127.0.0.1:9999".parse().unwrap());
    assert_eq!(settings.tls_mode, TlsMode::Auto);
    assert_eq!(settings.user, None);
    assert_eq!(settings.password, None);
    assert!(settings.localhost_no_auth);
    assert_eq!(
        settings.session_expiration_minutes,
        DEFAULT_SESSION_EXPIRATION_MINUTES
    );
    assert_eq!(settings.no_sleep_auto_cooldown_seconds, 60);
    assert_eq!(settings.backend_mode, BackendMode::Builtin);
    assert_eq!(settings.builtin_shell, None);
    assert!(!settings.default_folder.is_empty());
    let raw = fs::read_to_string(path).unwrap();
    assert!(raw.contains("localhost_no_auth"));
    assert!(raw.contains("session_expiration_minutes"));
    assert!(raw.contains("tls_mode"));
    assert!(raw.contains("user"));
    assert!(raw.contains("password"));
    assert!(raw.contains("no_sleep_auto_cooldown_seconds"));
    assert!(raw.contains("backend_mode"));
    assert!(raw.contains(r#""backend_mode": "builtin""#));
    assert!(raw.contains("builtin_shell"));
    assert!(raw.contains("default_folder"));

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[test]
fn explicit_cli_bind_overrides_persisted_bind() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-explicit-bind-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let path = server_settings_path();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    // A saved bind pointing at 8787 must not hijack an explicit --bind 8788.
    fs::write(&path, r#"{"bind":"127.0.0.1:8787"}"#).unwrap();

    let config = WebConfig::parse(&["--bind", "127.0.0.1:8788"].map(String::from)).unwrap();
    let mut server_settings = load_runtime_server_settings(config.bind).unwrap();
    apply_cli_overrides(&mut server_settings, &config);

    assert!(config.bind_explicit);
    assert_eq!(server_settings.bind, "127.0.0.1:8788".parse().unwrap());

    // Without an explicit flag the persisted bind keeps winning.
    let implicit = WebConfig::parse(&[]).unwrap();
    let mut implicit_settings = load_runtime_server_settings(implicit.bind).unwrap();
    apply_cli_overrides(&mut implicit_settings, &implicit);
    assert!(!implicit.bind_explicit);
    assert_eq!(
        implicit_settings.bind,
        "127.0.0.1:8787".parse().unwrap(),
        "persisted bind stays authoritative when --bind is absent"
    );

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[test]
fn loads_auth_from_runtime_settings() {
    let auth = AuthConfig::from_settings(&RuntimeServerSettings {
        bind: "0.0.0.0:8787".parse().unwrap(),
        tls_mode: TlsMode::Auto,
        user: Some("test-user".to_string()),
        password: Some("test-password".to_string()),
        localhost_no_auth: false,
        session_expiration_minutes: DEFAULT_SESSION_EXPIRATION_MINUTES,
        no_sleep_auto_cooldown_seconds: 60,
        backend_mode: BackendMode::ExternalHerdr,
        builtin_shell: None,
        default_folder: std::env::temp_dir().to_string_lossy().to_string(),
        builtin_backend_enabled: true,
        external_herdr_backend_enabled: true,
        jcode_detection_variant: JcodeDetectionVariant::default(),
        log_level: LogLevel::default(),
        lsp: lsp::LspSettings::default(),
        recent_workspaces: Vec::new(),
    })
    .unwrap();

    assert_eq!(auth.user.as_deref(), Some("test-user"));
    assert_eq!(auth.password.as_deref(), Some("test-password"));
    assert!(!auth.localhost_no_auth);
    assert!(!auth.token.is_empty());
}

#[test]
fn rejects_public_bind_without_credentials() {
    let public_err = match AuthConfig::from_settings(&RuntimeServerSettings {
        bind: "0.0.0.0:8787".parse().unwrap(),
        tls_mode: TlsMode::Auto,
        user: None,
        password: None,
        localhost_no_auth: true,
        session_expiration_minutes: DEFAULT_SESSION_EXPIRATION_MINUTES,
        no_sleep_auto_cooldown_seconds: 60,
        backend_mode: BackendMode::ExternalHerdr,
        builtin_shell: None,
        default_folder: std::env::temp_dir().to_string_lossy().to_string(),
        builtin_backend_enabled: true,
        external_herdr_backend_enabled: true,
        jcode_detection_variant: JcodeDetectionVariant::default(),
        log_level: LogLevel::default(),
        lsp: lsp::LspSettings::default(),
        recent_workspaces: Vec::new(),
    }) {
        Ok(_) => panic!("expected public auth config to fail"),
        Err(err) => err,
    };

    assert_eq!(public_err.kind(), io::ErrorKind::PermissionDenied);
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn server_settings_api_reports_and_updates_runtime_settings() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-settings-api-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    let app = test_app_with_state(state);

    let before = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let before_body = response_json(before).await;
    assert_eq!(before_body["bind"], "127.0.0.1:8787");
    assert_eq!(before_body["tls_mode"], "auto");
    assert_eq!(before_body["scheme"], "https");
    assert_eq!(before_body["username"], "user");
    assert_eq!(before_body["no_sleep_auto_cooldown_seconds"], 60);
    assert_eq!(before_body["backend_mode"], "external-herdr");
    assert_eq!(before_body["builtin_shell"], Value::Null);
    assert!(before_body["default_folder"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
    assert_eq!(before_body["builtin_backend_enabled"], true);
    assert_eq!(before_body["external_herdr_backend_enabled"], true);
    assert_eq!(before_body["enabled_backends"]["builtin"], true);
    assert_eq!(before_body["enabled_backends"]["external-herdr"], true);

    let default_folder = std::env::temp_dir().to_string_lossy().to_string();
    let updated = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "0.0.0.0:8787",
                        "tls_mode": "off",
                        "username": "test-user",
                        "password": "test-password",
                        "localhost_no_auth": true,
                        "backend_mode": "builtin",
                        "builtin_shell": "/bin/zsh",
                        "default_folder": default_folder,
                        "builtin_backend_enabled": true,
                        "external_herdr_backend_enabled": false,
                        "no_sleep_auto_cooldown_seconds": 90,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let updated_body = response_json(updated).await;

    assert_eq!(updated_body["bind"], "0.0.0.0:8787");
    assert_eq!(updated_body["username"], "test-user");
    assert_eq!(updated_body["has_password"], true);
    assert_eq!(updated_body["no_sleep_auto_cooldown_seconds"], 90);
    assert_eq!(updated_body["backend_mode"], "builtin");
    assert_eq!(updated_body["tls_mode"], "off");
    assert_eq!(updated_body["scheme"], "http");
    assert_eq!(updated_body["builtin_shell"], "/bin/zsh");
    assert_eq!(
        updated_body["default_folder"],
        std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string()
    );
    assert_eq!(updated_body["builtin_backend_enabled"], true);
    assert_eq!(updated_body["external_herdr_backend_enabled"], false);
    assert_eq!(updated_body["enabled_backends"]["builtin"], true);
    assert_eq!(updated_body["enabled_backends"]["external-herdr"], false);
    assert!(server_settings_path().exists());

    let cleared = app
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "0.0.0.0:8787",
                        "username": "test-user",
                        "password": null,
                        "localhost_no_auth": true,
                        "backend_mode": "builtin",
                        "builtin_shell": null,
                        "builtin_backend_enabled": true,
                        "external_herdr_backend_enabled": false,
                        "no_sleep_auto_cooldown_seconds": 90,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let cleared_body = response_json(cleared).await;
    assert_eq!(cleared_body["builtin_shell"], Value::Null);

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn versions_api_reports_enabled_backends_from_settings() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-versions-enabled-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let mut state = test_state();
    // Server has external-herdr disabled in settings: browsers must see
    // enabled_backends so they stop targeting/offering it.
    state
        .server_settings
        .lock()
        .unwrap()
        .external_herdr_backend_enabled = false;
    state.backend_mode = BackendMode::Builtin;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/versions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["enabled_backends"]["builtin"], true);
    assert_eq!(body["enabled_backends"]["external-herdr"], false);

    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[tokio::test]
async fn sessions_api_reports_enabled_backends_from_settings() {
    let state = test_state();
    state
        .server_settings
        .lock()
        .unwrap()
        .builtin_backend_enabled = false;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["enabled_backends"]["builtin"], false);
    assert_eq!(body["enabled_backends"]["external-herdr"], true);
    // Default backend flips to the remaining enabled one.
    assert_eq!(body["default_backend"], "external-herdr");
}

#[tokio::test]
async fn server_settings_api_rejects_public_bind_without_credentials() {
    let app = test_app();

    let response = app
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "0.0.0.0:8787",
                        "username": null,
                        "password": null,
                        "localhost_no_auth": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(
        body["error"],
        "username and password are required before binding to 0.0.0.0 or any non-local address"
    );
}

#[tokio::test]
async fn server_settings_api_rejects_public_bind_with_missing_password() {
    let state = test_state();
    state.server_settings.lock().unwrap().password = None;
    let response = test_app_with_state(state)
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "0.0.0.0:8787",
                        "username": "user",
                        "password": null,
                        "localhost_no_auth": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn no_sleep_api_reports_shared_default_state() {
    let response = test_app()
        .oneshot(
            request(Method::GET, "/api/no-sleep")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["mode"], "off");
    assert_eq!(body["until_ms"], Value::Null);
}

#[tokio::test]
async fn no_sleep_api_rejects_invalid_mode() {
    let response = test_app()
        .oneshot(
            request(Method::POST, "/api/no-sleep")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"mode":"bad"}"#))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["error"], "invalid no-sleep mode");
}

#[test]
fn require_auth_returns_unauthorized_response() {
    let state = test_state();
    let response =
        require_auth(&state, &HeaderMap::new(), "192.0.2.1:1234".parse().unwrap()).unwrap_err();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[test]
fn compares_constant_time_equal_values() {
    assert!(crate::auth::constant_time_eq(b"same", b"same"));
    assert!(!crate::auth::constant_time_eq(b"same", b"diff"));
    assert!(!crate::auth::constant_time_eq(b"same", b"same-but-longer"));
}

#[test]
fn parses_simple_semver_values() {
    assert_eq!(
        SimpleVersion::parse("v0.7.0+abc").unwrap(),
        SimpleVersion {
            major: 0,
            minor: 7,
            patch: 0
        }
    );
    assert_eq!(
        SimpleVersion::parse("0.7.1-dev").unwrap(),
        SimpleVersion {
            major: 0,
            minor: 7,
            patch: 1
        }
    );
    assert_eq!(SimpleVersion::parse("0.7"), None);
    assert_eq!(SimpleVersion::parse("unknown"), None);
}

#[test]
fn parses_no_sleep_modes() {
    assert_eq!(no_sleep_ms("off"), Some(0));
    assert_eq!(no_sleep_ms("auto"), Some(0));
    assert_eq!(no_sleep_ms("1h"), Some(60 * 60 * 1000));
    assert_eq!(no_sleep_ms("2h"), Some(2 * 60 * 60 * 1000));
    assert_eq!(no_sleep_ms("4h"), Some(4 * 60 * 60 * 1000));
    assert_eq!(no_sleep_ms("infinite"), Some(0));
    assert_eq!(no_sleep_ms("bad"), None);
}

#[test]
fn detects_working_agents_for_auto_no_sleep() {
    assert!(agents_working_from_value(&json!({
        "result": { "agents": [{ "agent_status": "idle" }, { "agent_status": "working" }] }
    })));
    assert!(!agents_working_from_value(&json!({
        "result": { "agents": [{ "agent_status": "idle" }, { "agent_status": "done" }] }
    })));
    assert!(!agents_working_from_value(
        &json!({ "result": { "agents": [] } })
    ));
}

#[test]
fn auto_no_sleep_turns_off_after_idle_cooldown() {
    let mut state = NoSleepState {
        mode: "auto".to_string(),
        auto_idle_since_ms: Some(unix_ms_now().saturating_sub(1000)),
        ..NoSleepState::default()
    };

    sync_auto_no_sleep(&mut state, false, 0);

    assert_eq!(state.mode, "off");
    assert_eq!(state.auto_idle_since_ms, None);
    assert!(state.guard.is_none());
}

#[test]
fn classifies_backend_compatibility() {
    // herdr 0.9.0 requires an exact protocol match: every supported
    // release maps 1:1 to its own protocol version.
    assert_eq!(
        backend_compatibility_for_supported_range(Some("0.8.0"), Some(20)),
        BackendCompatibility::ProtocolMismatch
    );
    assert_eq!(
        backend_compatibility_for_supported_range(Some("0.8.0"), Some(PROTOCOL_VERSION - 1)),
        BackendCompatibility::ProtocolMismatch
    );
    assert_eq!(
        backend_compatibility_for_supported_range(
            Some("0.9.0"),
            Some(MIN_SUPPORTED_PROTOCOL_VERSION),
        ),
        BackendCompatibility::Compatible
    );
    assert_eq!(
        backend_compatibility_for_supported_range(Some("0.9.0"), Some(PROTOCOL_VERSION),),
        BackendCompatibility::Compatible
    );
    assert_eq!(
        backend_compatibility_for_supported_range(Some("0.9.1"), Some(PROTOCOL_VERSION)),
        BackendCompatibility::UntestedNewer
    );
    assert_eq!(
        backend_compatibility_for_supported_range(Some("bad"), Some(PROTOCOL_VERSION)),
        BackendCompatibility::Unknown
    );
    assert_eq!(
        backend_compatibility_for_supported_range(None, None),
        BackendCompatibility::Unknown
    );
    assert_eq!(
        backend_compatibility_for_supported_range(Some("0.9.0"), None),
        BackendCompatibility::Unknown
    );
    assert_eq!(
        backend_compatibility_for_supported_range(Some("0.9.0"), Some(PROTOCOL_VERSION + 1)),
        BackendCompatibility::ProtocolMismatch
    );
}

#[test]
fn terminal_handshake_requires_exact_protocol_version() {
    // herdr 0.9.0 rejects every client version except its own. The
    // handshake must send exactly PROTOCOL_VERSION or the backend closes
    // the connection after the Welcome rejection.
    assert_eq!(PROTOCOL_VERSION, 22);
}

#[test]
fn terminal_attach_errors_classify_for_graceful_degradation() {
    // Handshake failures offer a built-in session; transport failures
    // (socket missing, attach send failing) do not, since the backend
    // may just be restarting.
    assert!(TerminalAttachError::ReadHandshake.suggests_builtin());
    assert!(TerminalAttachError::Rejected(
        "client version 22 is newer than server version 21".into()
    )
    .suggests_builtin());
    assert!(!TerminalAttachError::Connect.suggests_builtin());
    assert!(!TerminalAttachError::SendHandshake.suggests_builtin());
    assert!(!TerminalAttachError::Attach.suggests_builtin());

    assert_eq!(
        TerminalAttachError::ReadHandshake.error_kind(),
        "handshake_failed"
    );
    assert_eq!(
        TerminalAttachError::Rejected("mismatch".into()).error_kind(),
        "handshake_rejected"
    );
    assert_eq!(TerminalAttachError::Connect.error_kind(), "connect_failed");
    // User-facing messages keep the legacy terminal text for direct
    // display when the UI cannot parse the structured frame.
    assert!(TerminalAttachError::Rejected("boom".into())
        .user_message()
        .starts_with("herdr rejected terminal connection: boom"));
}

#[test]
fn terminal_text_messages_maps_paste_to_bracketed_input() {
    let messages = terminal_text_messages(
        r#"{"type":"paste","text":"fn main() {\n    println!(\"hi\");\n}\n"}"#,
    );

    assert_eq!(
        messages,
        vec![ClientMessage::Input {
            data: b"\x1b[200~fn main() {\n    println!(\"hi\");\n}\n\x1b[201~".to_vec(),
        }]
    );
}

#[test]
fn terminal_release_toggle_arms_only_on_release_messages() {
    let mut armed = false;
    assert!(terminal_release_toggle(
        r#"{"type":"release","enabled":true}"#,
        &mut armed
    ));
    assert!(armed);

    assert!(terminal_release_toggle(
        r#"{"type":"release","enabled":false}"#,
        &mut armed
    ));
    assert!(!armed);

    // Non-release payloads never touch the flag.
    let mut armed = false;
    assert!(!terminal_release_toggle(
        r#"{"type":"resize","cols":80,"rows":24}"#,
        &mut armed
    ));
    assert!(!armed);
    assert!(!terminal_release_toggle("plain text", &mut armed));
    assert!(!armed);

    // A release without an enabled field disarms (defaults to false).
    let mut armed = true;
    assert!(terminal_release_toggle(r#"{"type":"release"}"#, &mut armed));
    assert!(!armed);
}

#[test]
fn terminal_release_toggle_keeps_release_text_out_of_terminal_input() {
    // The toggle is consumed by the socket loop before forwarding, but
    // keep the guarantee explicit: a release payload must never be
    // interpreted as terminal input, even if routing changes.
    let messages = terminal_text_messages(r#"{"type":"release","enabled":true}"#);
    assert!(messages.is_empty());
}

#[test]
fn auto_close_skips_armed_and_promoted_temporary_tabs() {
    let promoted: PromotedTemporaryTabs = Arc::new(Mutex::new(HashMap::new()));

    // Normal teardown: the temporary tab is auto-closed.
    assert!(should_auto_close_temporary_tab(
        false,
        Some("tab-1"),
        &promoted
    ));

    // Armed release toggle (promote succeeded, toggle delivered): skip.
    assert!(!should_auto_close_temporary_tab(
        true,
        Some("tab-1"),
        &promoted
    ));

    // Promote recorded the tab server-side (toggle lost): skip.
    promoted
        .lock()
        .unwrap()
        .insert("tab-2".to_string(), PromotedTemporaryTabState::Promoted);
    assert!(!should_auto_close_temporary_tab(
        false,
        Some("tab-2"),
        &promoted
    ));
    // A promote still in flight (backend not answered yet) is equally
    // protected: the pre-arm must beat the teardown auto-close.
    promoted
        .lock()
        .unwrap()
        .insert("tab-3".to_string(), PromotedTemporaryTabState::Promoting(1));
    assert!(!should_auto_close_temporary_tab(
        false,
        Some("tab-3"),
        &promoted
    ));
    // Other tabs in the same registry still auto-close.
    assert!(should_auto_close_temporary_tab(
        false,
        Some("tab-1"),
        &promoted
    ));

    // No temporary tab id: nothing to close.
    assert!(!should_auto_close_temporary_tab(false, None, &promoted));

    // Empty id is treated as absent.
    assert!(!should_auto_close_temporary_tab(false, Some(""), &promoted));
}

/// A poisoned registry lock must degrade to a no-op in both directions:
/// begin does not insert (the tab keeps its current auto-close
/// semantics) and finish does not remove or corrupt anything. The
/// lock is only poisoned by a panic while held elsewhere; the
/// promote paths deliberately never unwrap it.
#[test]
fn promote_guard_registry_survives_poisoned_lock() {
    let registry: PromotedTemporaryTabs = Arc::new(Mutex::new(HashMap::new()));
    begin_temporary_tab_promote(&registry, "tab-P");
    assert_eq!(
        registry.lock().unwrap().get("tab-P"),
        Some(&PromotedTemporaryTabState::Promoting(1))
    );

    // Poison the mutex: a panic unwinds while the guard is held.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = registry.lock().unwrap();
        struct PanicOnDrop;
        impl Drop for PanicOnDrop {
            fn drop(&mut self) {
                panic!("poisoning promote registry");
            }
        }
        drop(PanicOnDrop);
    }));

    // begin is a no-op: the entry is untouched, never inserted twice.
    begin_temporary_tab_promote(&registry, "tab-Q");
    assert!(
        registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get("tab-Q")
            .is_none(),
        "begin must not insert while poisoned"
    );
    assert_eq!(
        registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get("tab-P"),
        Some(&PromotedTemporaryTabState::Promoting(1))
    );

    // finish is also a no-op: no decrement, no removal.
    finish_temporary_tab_promote(&registry, "tab-P", false);
    assert_eq!(
        registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get("tab-P"),
        Some(&PromotedTemporaryTabState::Promoting(1)),
        "finish must not mutate while poisoned"
    );
    finish_temporary_tab_promote(&registry, "tab-P", true);
    assert_eq!(
        registry
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get("tab-P"),
        Some(&PromotedTemporaryTabState::Promoting(1)),
        "finish(success) must not mutate while poisoned"
    );

    // The teardown decision also degrades under poison: the lookup is
    // unwrap_or(false), i.e. "promoted state unavailable -> treat as
    // closable", so a poisoned registry keeps the tab closable like any
    // ordinary temporary tab.
    assert!(
        should_auto_close_temporary_tab(false, Some("tab-P"), &registry),
        "poisoned registry must fail open (closable) in the teardown decision"
    );
}

/// Fake herdr client socket for a terminal attach: answers the
/// TerminalHello handshake, records the AttachTerminal target, and
/// relays every forwarded ClientMessage (input etc.) to `received` so
/// tests can assert what the WS layer actually forwarded. The stream
/// stays open until the test drops the socket, keeping the relay loop
/// in its Ok(_) => {} steady state.
#[cfg(unix)]
fn fake_terminal_attach_socket(
    received: std::sync::mpsc::Sender<String>,
) -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = fake_socket_dir().join(format!(
        "attach-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let handle = thread::spawn(move || {
        // Every WS scenario opens its own attach connection; serve each
        // accepted stream on its own thread so several sequential
        // terminal sockets can handshake against one listener.
        while let Ok(mut stream) = listener.accept() {
            let received = received.clone();
            thread::spawn(move || {
                let mut writer = stream.try_clone().unwrap();
                // TerminalHello -> Welcome(error: None). Not sending
                // further frames keeps the WS relay loop idle and
                // teardown in the caller's control.
                let _ = read_message::<_, ClientMessage>(&mut stream, MAX_FRAME_SIZE);
                let _ = write_message(
                    &mut writer,
                    &ServerMessage::Welcome {
                        version: PROTOCOL_VERSION,
                        encoding: RenderEncoding::TerminalAnsi,
                        error: None,
                    },
                );
                let _ = read_message::<_, ClientMessage>(&mut stream, MAX_FRAME_SIZE);
                loop {
                    match read_message::<_, ClientMessage>(&mut stream, MAX_FRAME_SIZE) {
                        Ok(ClientMessage::Detach) => break,
                        Ok(message) => {
                            let _ = received.send(format!("{message:?}"));
                        }
                        Err(_) => break,
                    }
                }
            });
        }
    });
    (path, handle)
}

/// Fake API socket that records every tab.close request into `closed`
/// and answers with an empty result. Unlike `fake_api_socket_multi` it
/// accepts any number of connections until the channel receiver is
/// dropped, so several teardown scenarios can share one listener.
#[cfg(unix)]
fn fake_api_socket_recording(
    closed: tokio::sync::mpsc::UnboundedSender<String>,
) -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = fake_socket_dir().join(format!(
        "close-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let handle = thread::spawn(move || {
        while let Ok(mut stream) = listener.accept() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                break;
            }
            let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) else {
                break;
            };
            if request["method"] == "tab.close" {
                if let Some(tab_id) = request["params"]["tab_id"].as_str() {
                    let _ = closed.send(tab_id.to_string());
                }
            }
            let _ = stream.write_all(
                serde_json::to_string(&json!({ "id": request["id"], "result": {} }))
                    .unwrap()
                    .as_bytes(),
            );
            let _ = stream.write_all(b"\n");
            let _ = stream.flush();
        }
    });
    (path, handle)
}

/// Terminal-WS teardown is the heart of the promote hand-off: the
/// overlay tab's WS must close the underlying temporary tab on a normal
/// disconnect, skip the close when the browser armed the release toggle
/// (successful promote) or when a promote is in flight / already done
/// (server-side guard), and give an in-transit promote a grace window
/// to arm that guard. One server, three sequential connections, one
/// recording api socket; the attach socket relays nothing so teardown
/// is driven purely by the WS lifecycle.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn terminal_ws_teardown_respects_promote_release_and_grace() {
    use futures_util::SinkExt;
    use tokio_tungstenite::connect_async;

    // Async channel: the test must never block the tokio runtime with a
    // std recv while the server task still needs to run.
    let (close_tx, mut close_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (attach_tx, _attach_rx) = std::sync::mpsc::channel::<String>();
    let (api_socket, _api_thread) = fake_api_socket_recording(close_tx.clone());
    let (attach_socket, _attach_thread) = fake_terminal_attach_socket(attach_tx.clone());

    let mut state = test_state();
    state.api_socket = Some(api_socket.clone());
    state.client_socket = Some(attach_socket.clone());
    let app = test_app_with_state(state.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server_handle = tokio::spawn(async move {
        let mut shutdown_rx = Some(shutdown_rx);
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.take().unwrap().await;
        })
        .await;
    });

    let connect = |temporary_tab_id: &str| {
        let url =
            format!("ws://{addr}/ws/terminal?terminal_id=t1&temporary_tab_id={temporary_tab_id}");
        async move {
            let request = tokio_tungstenite::tungstenite::http::Request::builder()
                .uri(&url)
                .header("cookie", "herdr_web_session=token-123")
                .header("host", addr.to_string())
                .header("connection", "Upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-version", "13")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .body(())
                .unwrap();
            connect_async(request)
                .await
                .expect("failed to connect to terminal WS")
                .0
        }
    };

    // 1) Normal teardown: no release frame, no guard entry -> the
    //    temporary tab is auto-closed after the grace window.
    let mut ws = connect("tab-grace-normal").await;
    let _ = ws.close(None).await;
    let closed = tokio::time::timeout(Duration::from_secs(10), close_rx.recv())
        .await
        .expect("temporary tab must be closed on normal teardown")
        .expect("api socket thread alive");
    assert_eq!(closed, "tab-grace-normal");

    // 2) Armed release toggle: the same teardown must NOT close the
    //    tab (the promote succeeded and the overlay is going away).
    let mut ws = connect("tab-grace-armed").await;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        json!({ "type": "release", "enabled": true })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    // Give the server a beat to consume the release frame before the
    // Close frame tears the socket down.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = ws.close(None).await;
    let unexpected = tokio::time::timeout(Duration::from_millis(600), close_rx.recv()).await;
    assert!(
        unexpected.is_err(),
        "armed release toggle must keep the promoted tab open (got {unexpected:?})"
    );

    // 3) In-flight promote arms the server-side guard during the grace
    //    window: the teardown re-check must observe it and skip the
    //    close. Simulates the WS dying exactly while the promote POST is
    //    between the socket read and the backend round-trip.
    let mut ws = connect("tab-grace-inflight").await;
    begin_temporary_tab_promote(&state.promoted_temporary_tabs, "tab-grace-inflight");
    let _ = ws.close(None).await;
    let unexpected = tokio::time::timeout(Duration::from_millis(600), close_rx.recv()).await;
    assert!(
        unexpected.is_err(),
        "in-flight promote must win the grace race and keep the tab open"
    );

    // Clean the guard so later checks stay honest.
    finish_temporary_tab_promote(&state.promoted_temporary_tabs, "tab-grace-inflight", false);

    // 4) In-transit promote: the WS closes first, then the promote POST
    //    lands inside the grace window. Its api socket accepts but never
    //    answers, so the request stays in flight and the guard stays
    //    armed (Promoting) when the teardown performs the grace
    //    re-check: the close must be skipped.
    let mut ws = connect("tab-grace-inflight-late").await;
    let _ = ws.close(None).await;
    {
        use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

        let stuck_path = fake_socket_dir().join(format!(
            "stuck-{}-{}.sock",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            fake_socket_suffix()
        ));
        let _ = fs::remove_file(&stuck_path);
        let name = stuck_path.clone().to_fs_name::<GenericFilePath>().unwrap();
        let stuck_listener = ListenerOptions::new()
            .name(name)
            .try_overwrite(true)
            .create_sync()
            .unwrap();
        // Accept, hold the request past the grace window, then answer
        // with a backend error so the in-flight promote task completes
        // and can be awaited deterministically.
        thread::spawn(move || {
            while let Ok(mut stream) = stuck_listener.accept() {
                thread::sleep(Duration::from_secs(2));
                let _ = stream.write_all(br#"{"id":"web:tab:promote","error":"stuck backend"}"#);
                let _ = stream.write_all(b"\n");
                let _ = stream.flush();
            }
        });

        let mut late_state = state.clone();
        late_state.api_socket = Some(stuck_path.clone());
        let late = tokio::spawn(async move {
            let request = Request::builder()
                .method(Method::POST)
                .uri("/api/tabs/tab-grace-inflight-late/promote")
                .header("cookie", "herdr_web_session=token-123")
                .extension(ConnectInfo("192.0.2.1:1234".parse::<SocketAddr>().unwrap()))
                .body(Body::empty())
                .unwrap();
            test_app_with_state(late_state)
                .oneshot(request)
                .await
                .unwrap()
        });
        let unexpected = tokio::time::timeout(Duration::from_millis(600), close_rx.recv()).await;
        assert!(
            unexpected.is_err(),
            "in-transit promote inside the grace window must keep the tab open"
        );
        // Disarm the guard; the stuck socket then answers with a
        // backend error after the grace window, so the promote task
        // finishes on its own (the error path decrements the saturated
        // count back to zero) and the full route tail, including the
        // join, is executed.
        finish_temporary_tab_promote(
            &state.promoted_temporary_tabs,
            "tab-grace-inflight-late",
            false,
        );
        let late_response = tokio::time::timeout(Duration::from_secs(10), late)
            .await
            .expect("late promote task must finish")
            .expect("late promote request must complete");
        // Transport succeeded, so the backend error rides inside the
        // envelope with an overall 200; the route must also have
        // disarmed the in-flight guard again on its error path.
        assert_eq!(
            late_response.status(),
            StatusCode::OK,
            "a backend error inside the envelope keeps the 200 transport status"
        );
        let body = to_bytes(late_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let envelope: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            envelope["error"], "stuck backend",
            "the backend error must be relayed in the envelope"
        );
        let _ = fs::remove_file(&stuck_path);
    }

    // 5) Guard armed mid-grace: teardown passes the first check while
    //    the tab is still closable, then the promote guard arms during
    //    the 250ms window (exactly when an in-transit promote request
    //    gets parsed). The re-check must observe it and skip the close:
    //    this exercises the re-check false arm of the grace window.
    {
        let mut ws = connect("tab-grace-mid-arm").await;
        let _ = ws.close(None).await;
        // The close is detected and the first closability check has
        // passed by now (well under the grace window), so arming the
        // guard here puts it between the two checks deterministically.
        tokio::time::sleep(Duration::from_millis(100)).await;
        begin_temporary_tab_promote(&state.promoted_temporary_tabs, "tab-grace-mid-arm");
        let unexpected = tokio::time::timeout(Duration::from_millis(600), close_rx.recv()).await;
        assert!(
            unexpected.is_err(),
            "guard armed mid-grace must keep the tab open at the re-check"
        );
        finish_temporary_tab_promote(&state.promoted_temporary_tabs, "tab-grace-mid-arm", false);
    }

    let _ = shutdown_tx.send(());
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
    drop(close_tx);
    drop(attach_tx);
    // The fake-socket threads block in accept() until process exit;
    // they are intentionally detached (unique socket names, no joins).
    let _ = fs::remove_file(api_socket);
    let _ = fs::remove_file(attach_socket);
}

/// Forwarding happy path: the WS relay must translate browser frames
/// into herdr ClientMessages on the attach socket (binary passthrough,
/// JSON `input` text, plain text fallback) and keep the ping loop alive.
/// The abrupt socket drop after the ping exercises the raw-io error path
/// of the outbound relay without a clean Close handshake.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn terminal_ws_forwards_input_frames_to_attach_socket() {
    use futures_util::SinkExt;
    use tokio_tungstenite::connect_async;

    let (received_tx, received_rx) = std::sync::mpsc::channel::<String>();
    let (attach_socket, _attach_thread) = fake_terminal_attach_socket(received_tx.clone());

    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-api.sock"));
    state.client_socket = Some(attach_socket.clone());
    let app = test_app_with_state(state.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server_handle = tokio::spawn(async move {
        let mut shutdown_rx = Some(shutdown_rx);
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.take().unwrap().await;
        })
        .await;
    });

    let url = format!("ws://{addr}/ws/terminal?terminal_id=t1&temporary_tab_id=tab-forward");
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let mut ws = connect_async(request)
        .await
        .expect("failed to connect to terminal WS")
        .0;

    ws.send(tokio_tungstenite::tungstenite::Message::Binary(
        vec![0x41, 0x42].into(),
    ))
    .await
    .unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        json!({ "input": "XY" }).to_string().into(),
    ))
    .await
    .unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::Text("Z".into()))
        .await
        .unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::Ping(
        tokio_tungstenite::tungstenite::Bytes::from_static(b"keepalive"),
    ))
    .await
    .unwrap();

    // The relay may need a beat to drain the frames through the socket
    // pair; read the recorded messages on a blocking thread so the
    // tokio runtime is never blocked by the std mpsc receiver.
    let received_rx = Arc::new(StdMutex::new(received_rx));
    let next = || {
        let rx = Arc::clone(&received_rx);
        async move {
            tokio::task::spawn_blocking(move || {
                rx.lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .recv_timeout(Duration::from_secs(10))
            })
            .await
            .unwrap()
        }
    };
    let first = next()
        .await
        .expect("attach socket must record binary passthrough");
    assert_eq!(first, "Input { data: [65, 66] }");
    let second = next().await.expect("attach socket must record json input");
    assert_eq!(second, "Input { data: [88, 89] }");
    let third = next().await.expect("attach socket must record plain text");
    assert_eq!(third, "Input { data: [90] }");

    // Abrupt drop: no Close frame, the socket dies while the relay is
    // healthy. The relay's outbound half must terminate and forward
    // nothing further.
    drop(ws);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let leftover = received_rx
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .try_recv();
    assert!(
        leftover.is_err(),
        "no frames may be forwarded after the abrupt WS drop (got {leftover:?})"
    );

    let _ = shutdown_tx.send(());
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
    drop(received_tx);
    let _ = fs::remove_file(&attach_socket);
}

/// Raw-arm coverage for the recording api-socket fake: a connection
/// whose first line is not valid UTF-8 must hit the read_line error arm,
/// and a line that is valid UTF-8 but not JSON must hit the parse-fail
/// arm. Both end the accept loop, so the socket thread terminates and
/// no tab.close is ever recorded from these probe connections.
#[cfg(unix)]
#[tokio::test]
async fn fake_api_socket_recording_ends_on_raw_and_garbage_lines() {
    use interprocess::local_socket::{prelude::*, GenericFilePath};
    use std::io::Write as _;

    let (closed_tx, mut closed_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Invalid UTF-8 on the wire: BufReader::read_line errors out and
    // the accept loop breaks on the raw-io arm.
    let (bad_utf8_socket, bad_utf8_thread) = fake_api_socket_recording(closed_tx.clone());
    let name = bad_utf8_socket
        .clone()
        .to_fs_name::<GenericFilePath>()
        .unwrap();
    let mut stream = LocalStream::connect(name).unwrap();
    stream.write_all(&[0xff, 0xfe, b'\n']).unwrap();
    stream.flush().unwrap();
    drop(stream);
    bad_utf8_thread.join().unwrap();
    let _ = fs::remove_file(&bad_utf8_socket);

    // Valid UTF-8 but not JSON: the parse-fail arm ends the loop.
    let (garbage_socket, garbage_thread) = fake_api_socket_recording(closed_tx.clone());
    let name = garbage_socket
        .clone()
        .to_fs_name::<GenericFilePath>()
        .unwrap();
    let mut stream = LocalStream::connect(name).unwrap();
    stream.write_all(b"not-json\n").unwrap();
    stream.flush().unwrap();
    drop(stream);
    garbage_thread.join().unwrap();
    let _ = fs::remove_file(&garbage_socket);

    // Valid JSON but not tab.close: the method filter arm falls
    // through, the request is answered, and no close is recorded.
    // The accept loop stays alive (detached like the other fakes), so
    // completion is observed from the response on the client stream.
    let (ping_socket, _ping_thread) = fake_api_socket_recording(closed_tx.clone());
    let name = ping_socket.clone().to_fs_name::<GenericFilePath>().unwrap();
    let mut stream = LocalStream::connect(name).unwrap();
    stream
        .write_all(br#"{"id":1,"method":"tab.list","params":{}}"#)
        .unwrap();
    stream.write_all(b"\n").unwrap();
    stream.flush().unwrap();
    let mut response = String::new();
    {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        reader.read_line(&mut response).unwrap();
    }
    assert_eq!(response.trim(), r#"{"id":1,"result":{}}"#);
    drop(stream);
    let _ = fs::remove_file(&ping_socket);

    // Attach-socket fake Err arm: after the Welcome handshake the relay
    // loop must end on a malformed frame instead of looping forever.
    let (attach_probe_tx, attach_probe_rx) = std::sync::mpsc::channel::<String>();
    let (attach_probe_socket, _attach_probe_thread) = fake_terminal_attach_socket(attach_probe_tx);
    let name = attach_probe_socket
        .clone()
        .to_fs_name::<GenericFilePath>()
        .unwrap();
    let mut stream = LocalStream::connect(name).unwrap();
    write_message(
        &mut stream,
        &ClientMessage::TerminalHello {
            version: PROTOCOL_VERSION,
            cols: 80,
            rows: 24,
            cell_width_px: 0,
            cell_height_px: 0,
            pixel_mouse: false,
        },
    )
    .unwrap();
    // First Input frame is consumed by the pre-loop read; the second
    // one is echoed into the received channel; the zero-length frame
    // after it fails bincode decoding and must end the relay loop.
    write_message(&mut stream, &ClientMessage::Input { data: vec![0x41] }).unwrap();
    write_message(&mut stream, &ClientMessage::Input { data: vec![0x43] }).unwrap();
    stream.write_all(&[0, 0, 0, 0]).unwrap();
    stream.flush().unwrap();
    let echoed = attach_probe_rx
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    assert_eq!(echoed, "Input { data: [67] }");
    drop(stream);
    let _ = fs::remove_file(&attach_probe_socket);

    assert!(
        tokio::time::timeout(Duration::from_millis(200), closed_rx.recv())
            .await
            .is_err(),
        "no tab.close may be recorded from raw probe connections"
    );
}

#[test]
fn tls_config_scheme_follows_mode() {
    // `--https off` needs the explicit value: bare `--https` defaults
    // to Auto, and a bare `off` would be an unknown arg.
    let cases: &[(&str, &[&str], &str)] = &[
        (
            "off",
            &["--bind", "127.0.0.1:9797", "--https", "off"],
            "http",
        ),
        ("auto", &["--bind", "127.0.0.1:9797", "--https"], "https"),
        (
            "self-signed",
            &["--bind", "127.0.0.1:9797", "--https", "self-signed"],
            "https",
        ),
        (
            "files",
            &[
                "--bind",
                "127.0.0.1:9797",
                "--https",
                "files",
                "--tls-cert",
                "/tmp/cert.pem",
                "--tls-key",
                "/tmp/key.pem",
            ],
            "https",
        ),
    ];
    for (mode, args, expected) in cases {
        let args = args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
        let scheme = WebConfig::parse(&args).unwrap().tls.scheme();
        assert_eq!(scheme, *expected, "mode {mode}");
    }
}

#[test]
fn promote_guard_registry_lifecycle() {
    let registry: PromotedTemporaryTabs = Arc::new(Mutex::new(HashMap::new()));

    // begin: in-flight marker protects the tab from teardown auto-close.
    begin_temporary_tab_promote(&registry, "tab-A");
    assert_eq!(
        registry.lock().unwrap().get("tab-A"),
        Some(&PromotedTemporaryTabState::Promoting(1))
    );
    assert!(!should_auto_close_temporary_tab(
        false,
        Some("tab-A"),
        &registry
    ));

    // finish(success): stays protected forever (Promoted).
    finish_temporary_tab_promote(&registry, "tab-A", true);
    assert_eq!(
        registry.lock().unwrap().get("tab-A"),
        Some(&PromotedTemporaryTabState::Promoted)
    );
    assert!(!should_auto_close_temporary_tab(
        false,
        Some("tab-A"),
        &registry
    ));

    // finish(failure) on a fresh tab: marker cleared, closable again.
    begin_temporary_tab_promote(&registry, "tab-B");
    finish_temporary_tab_promote(&registry, "tab-B", false);
    assert!(registry.lock().unwrap().get("tab-B").is_none());
    assert!(should_auto_close_temporary_tab(
        false,
        Some("tab-B"),
        &registry
    ));

    // finish(failure) never downgrades a tab a concurrent promote
    // already finished successfully.
    begin_temporary_tab_promote(&registry, "tab-C");
    finish_temporary_tab_promote(&registry, "tab-C", true);
    finish_temporary_tab_promote(&registry, "tab-C", false);
    assert_eq!(
        registry.lock().unwrap().get("tab-C"),
        Some(&PromotedTemporaryTabState::Promoted)
    );

    // A promote arriving while another is in flight counts up, and
    // each failure decrements only its own count.
    begin_temporary_tab_promote(&registry, "tab-D");
    begin_temporary_tab_promote(&registry, "tab-D");
    assert_eq!(
        registry.lock().unwrap().get("tab-D"),
        Some(&PromotedTemporaryTabState::Promoting(2))
    );
    finish_temporary_tab_promote(&registry, "tab-D", false);
    assert_eq!(
        registry.lock().unwrap().get("tab-D"),
        Some(&PromotedTemporaryTabState::Promoting(1))
    );
    assert!(!should_auto_close_temporary_tab(
        false,
        Some("tab-D"),
        &registry
    ));
    finish_temporary_tab_promote(&registry, "tab-D", true);
    assert_eq!(
        registry.lock().unwrap().get("tab-D"),
        Some(&PromotedTemporaryTabState::Promoted)
    );

    // Second promote over an already-promoted tab (UI double click):
    // begin must not downgrade Promoted, and its rejection must not
    // strip the protection either.
    begin_temporary_tab_promote(&registry, "tab-A");
    assert_eq!(
        registry.lock().unwrap().get("tab-A"),
        Some(&PromotedTemporaryTabState::Promoted)
    );
    finish_temporary_tab_promote(&registry, "tab-A", false);
    assert_eq!(
        registry.lock().unwrap().get("tab-A"),
        Some(&PromotedTemporaryTabState::Promoted)
    );

    // Empty/whitespace ids are ignored (treated as absent everywhere).
    let empty_registry: PromotedTemporaryTabs = Arc::new(Mutex::new(HashMap::new()));
    begin_temporary_tab_promote(&empty_registry, "   ");
    assert!(empty_registry.lock().unwrap().is_empty());
    finish_temporary_tab_promote(&empty_registry, "", true);
    assert!(empty_registry.lock().unwrap().is_empty());
    // Absent ids never auto-close: there is no tab to close.
    assert!(!should_auto_close_temporary_tab(
        false,
        Some("   "),
        &empty_registry
    ));
}

#[test]
fn terminal_text_messages_keeps_legacy_input_json_and_plain_text() {
    assert_eq!(
        terminal_text_messages(r#"{"input":"abc"}"#),
        vec![ClientMessage::Input {
            data: b"abc".to_vec()
        }]
    );
    assert_eq!(
        terminal_text_messages("plain"),
        vec![ClientMessage::Input {
            data: b"plain".to_vec()
        }]
    );
}

#[test]
fn computes_workspace_order_key_from_session() {
    let state = test_state();
    let mut headers = HeaderMap::new();

    assert_eq!(workspace_order_key(&state, &headers), "default");

    headers.insert("x-herdr-session", HeaderValue::from_static("work"));
    assert_eq!(workspace_order_key(&state, &headers), "work");
}

#[test]
fn enriches_workspace_cwd_from_panes() {
    let mut workspaces = json!({
        "result": {
            "workspaces": [
                { "workspace_id": "ws1", "label": "repo" },
                { "workspace_id": "ws2", "label": "keeps", "cwd": "/already" }
            ]
        }
    });
    let panes = json!({
        "result": {
            "panes": [
                { "workspace_id": "ws1", "cwd": "/repo", "foreground_cwd": "/repo/sub" },
                { "workspace_id": "ws2", "cwd": "/ignored", "foreground_cwd": "/ignored/sub" }
            ]
        }
    });

    enrich_workspace_cwds(&mut workspaces, &panes);

    assert_eq!(workspaces["result"]["workspaces"][0]["cwd"], "/repo");
    assert_eq!(
        workspaces["result"]["workspaces"][0]["foreground_cwd"],
        "/repo/sub"
    );
    assert_eq!(workspaces["result"]["workspaces"][1]["cwd"], "/already");
}

#[test]
fn normalizes_worktree_response_server_side() {
    let mut response = json!({
        "result": {
            "worktrees": [
                { "path": "/repo/old", "label": "old", "last_commit_at": "2024-01-01T10:00:00+00:00" },
                { "path": "/repo/new", "label": "new", "last_commit_at": "2025-01-01T09:30:00+00:00" },
                { "path": "/repo/unknown", "label": "unknown" }
            ]
        }
    });

    normalize_worktree_response(&mut response);

    let rows = response["result"]["worktrees"].as_array().unwrap();
    assert_eq!(rows[0]["label"], "new");
    assert_eq!(rows[0]["last_commit_display"], "2025-01-01 09:30");
    assert_eq!(rows[1]["label"], "old");
    assert_eq!(rows[2]["label"], "unknown");
    assert!(rows[2]["last_commit_display"].is_null());
}

#[test]
fn worktree_activity_sort_uses_timestamp_when_offsets_differ() {
    let mut response = json!({
        "result": {
            "worktrees": [
                { "path": "/repo/local-later-string", "label": "older", "last_commit_at": "2025-01-01T10:00:00+02:00" },
                { "path": "/repo/utc-earlier-string", "label": "newer", "last_commit_at": "2025-01-01T08:30:00.000Z" }
            ]
        }
    });

    normalize_worktree_response(&mut response);

    let rows = response["result"]["worktrees"].as_array().unwrap();
    assert_eq!(rows[0]["label"], "newer");
    assert_eq!(rows[1]["label"], "older");
}

#[test]
fn open_created_worktree_request_preserves_source_cwd() {
    let request = open_created_worktree_request(
        "/tmp/source-repo",
        "/tmp/worktrees/repo/feature",
        Some("feature".into()),
    );

    assert_eq!(request["method"], "worktree.open");
    assert_eq!(request["params"]["cwd"], "/tmp/source-repo");
    assert_eq!(request["params"]["path"], "/tmp/worktrees/repo/feature");
    assert_eq!(request["params"]["label"], "feature");
}

#[test]
fn worktree_api_version_selects_native_existing_branch_support() {
    assert_eq!(
        HerdrWorktreeApiVersion::from_backend(Some("0.7.0")),
        HerdrWorktreeApiVersion::V0_7_0,
    );
    assert_eq!(
        HerdrWorktreeApiVersion::from_backend(Some("0.7.1")),
        HerdrWorktreeApiVersion::V0_7_1,
    );
    assert_eq!(
        HerdrWorktreeApiVersion::from_backend(Some("0.7.2")),
        HerdrWorktreeApiVersion::V0_7_1,
    );
    assert_eq!(
        HerdrWorktreeApiVersion::from_backend(None),
        HerdrWorktreeApiVersion::V0_7_0,
    );
}

#[test]
fn worktree_api_builds_native_create_request() {
    let worktree_api = HerdrWorktreeApi {
        client: ApiClient {
            backend: herdr_webui::backend_client::BackendClient::new(
                PathBuf::from("/tmp/herdr.sock"),
                PathBuf::new(),
            ),
        },
        version: HerdrWorktreeApiVersion::V0_7_1,
    };

    let request = worktree_api.create_request(
        CreateWorktreeRequest {
            workspace_id: Some("w_1".into()),
            cwd: Some("~/repo".into()),
            branch: Some("feature/demo".into()),
            base: Some("main".into()),
            path: Some("../worktrees/demo".into()),
            label: Some("demo".into()),
            pull_base: Some(false),
        },
        Some("/home/me/repo".into()),
        Some("/home/me/worktrees/demo".into()),
    );

    assert_eq!(request["method"], "worktree.create");
    assert_eq!(request["params"]["workspace_id"], "w_1");
    assert_eq!(request["params"]["cwd"], "/home/me/repo");
    assert_eq!(request["params"]["path"], "/home/me/worktrees/demo");
    assert_eq!(request["params"]["branch"], "feature/demo");
    assert_eq!(request["params"]["focus"], true);
}

#[test]
fn round_trips_framed_protocol_messages() {
    let msg = ClientMessage::AttachScroll {
        source: AttachScrollSource::Wheel,
        direction: AttachScrollDirection::Down,
        lines: 3,
        column: Some(7),
        row: Some(9),
        modifiers: 4,
    };
    let mut bytes = Vec::new();

    write_message(&mut bytes, &msg).unwrap();
    let decoded: ClientMessage = read_message(&mut Cursor::new(bytes), MAX_FRAME_SIZE).unwrap();

    assert_eq!(decoded, msg);
}

#[test]
fn write_message_reports_writer_errors() {
    struct FailingWriter;

    impl Write for FailingWriter {
        fn write(&mut self, _buf: &[u8]) -> io::Result<usize> {
            Err(io::Error::new(io::ErrorKind::BrokenPipe, "closed"))
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    let err = write_message(&mut FailingWriter, &ClientMessage::Detach).unwrap_err();

    assert!(err.contains("closed"));
}

#[test]
fn rejects_oversized_framed_protocol_message() {
    let bytes = 4u32.to_le_bytes();
    let err = read_message::<_, ClientMessage>(&mut Cursor::new(bytes), 3).unwrap_err();

    assert!(err.contains("exceeds maximum"));
}

#[test]
fn rejects_framed_protocol_message_with_trailing_bytes() {
    let payload =
        bincode::serde::encode_to_vec(&ClientMessage::Detach, bincode::config::standard()).unwrap();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&u32::try_from(payload.len() + 1).unwrap().to_le_bytes());
    bytes.extend_from_slice(&payload);
    bytes.push(0);

    let err =
        read_message::<_, ClientMessage>(&mut Cursor::new(bytes), MAX_FRAME_SIZE).unwrap_err();

    assert!(err.contains("trailing bytes"));
}

#[tokio::test]
async fn api_me_reports_authentication_status() {
    let app = test_app();

    let unauthenticated = app
        .clone()
        .oneshot(request(Method::GET, "/api/me").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let authenticated = app
        .oneshot(
            request(Method::GET, "/api/me")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(unauthenticated.status(), StatusCode::OK);
    assert_eq!(response_json(unauthenticated).await["authenticated"], false);
    assert_eq!(authenticated.status(), StatusCode::OK);
    assert_eq!(response_json(authenticated).await["authenticated"], true);
}

#[tokio::test]
async fn create_workspace_route_rejects_missing_cwd_before_proxy() {
    let app = test_app();
    let missing = std::env::temp_dir().join(format!(
        "herdr-webui-route-missing-workspace-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    let response = app
        .oneshot(
            request(Method::POST, "/api/workspaces")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "label": "missing", "cwd": missing }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(response).await["error"],
        "workspace folder must exist"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn versions_api_reports_backend_compatibility_from_fake_socket() {
    let (socket, handle) = fake_api_socket(json!({
        "id": "web:ping",
        "result": { "version": "0.9.0", "protocol": PROTOCOL_VERSION }
    }));
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::GET, "/api/versions")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(response).await;

    assert_eq!(body["backend"], "0.9.0");
    assert_eq!(body["min_backend"], MIN_BACKEND_VERSION);
    assert_eq!(body["max_tested_backend"], MAX_TESTED_BACKEND_VERSION);
    assert_eq!(body["protocol_version"], PROTOCOL_VERSION);
    assert_eq!(body["min_protocol_version"], MIN_SUPPORTED_PROTOCOL_VERSION);
    assert_eq!(body["backend_protocol_version"], PROTOCOL_VERSION);
    assert_eq!(body["compatibility"]["status"], "compatible");
    assert_eq!(body["compatibility"]["compatible"], true);

    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[tokio::test]
async fn versions_api_reports_builtin_backend_as_compatible() {
    let mut state = test_state();
    state.backend_mode = BackendMode::Builtin;
    state.api_socket = None;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::GET, "/api/versions")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(response).await;

    assert_eq!(body["backend_mode"], "builtin");
    assert_eq!(body["compatibility"]["status"], "compatible");
    assert_eq!(body["compatibility"]["compatible"], true);
    assert_eq!(
        body["compatibility"]["message"],
        "built-in backend is embedded in this WebUI process"
    );
}

#[tokio::test]
async fn index_serves_login_without_auth_and_app_with_auth() {
    let app = test_app();

    let login = app
        .clone()
        .oneshot(request(Method::GET, "/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let app_html = app
        .clone()
        .oneshot(
            request(Method::GET, "/session/default/workspace/w1/tab/t1/pane/p1")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let app_js = app
        .oneshot(
            request(Method::GET, "/assets/desktop/app.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let login_body = String::from_utf8(
        to_bytes(login.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let app_body = String::from_utf8(
        to_bytes(app_html.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let app_js_body = String::from_utf8(
        to_bytes(app_js.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(login_body.contains("Login"));
    assert!(app_body.contains("Herdr"));
    assert!(app_body.contains("/assets/app-boot.js"));
    assert!(app_js_body.contains("optSoundScope"));
}

#[tokio::test]
async fn login_route_sets_cookie_for_valid_credentials() {
    let state = test_state();
    let app = test_app_with_state(state.clone());
    let body = Body::from(r#"{"username":"user","password":"pass"}"#);

    let response = app
        .oneshot(
            request(Method::POST, "/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("herdr_web_session=") && value.contains("Max-Age=")));
    assert_ne!(state.auth.lock().unwrap().token, "token-123");
    assert_eq!(response_json(response).await["ok"], true);
}

#[tokio::test]
async fn login_route_rejects_invalid_credentials() {
    let app = test_app();
    let body = Body::from(r#"{"username":"user","password":"wrong"}"#);

    let response = app
        .oneshot(
            request(Method::POST, "/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response_json(response).await["error"], "unauthorized");
}

#[tokio::test]
async fn login_route_throttles_repeated_failures() {
    let app = test_app();
    for _ in 0..5 {
        let body = Body::from(r#"{"username":"user","password":"wrong"}"#);
        let response = app
            .clone()
            .oneshot(
                request(Method::POST, "/api/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    // Sixth attempt, even with correct credentials, must be throttled.
    let body = Body::from(r#"{"username":"user","password":"pass"}"#);
    let response = app
        .oneshot(
            request(Method::POST, "/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response_json(response).await["error"], "too many attempts");
}

#[tokio::test]
async fn workspace_order_api_requires_auth_and_is_session_scoped() {
    let app = test_app();

    let unauthorized = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/workspace-order")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let update = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/workspace-order")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header("x-herdr-session", "work")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"order":["w2","w1"]}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(update.status(), StatusCode::OK);
    assert_eq!(response_json(update).await["order"], json!(["w2", "w1"]));

    let work = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/workspace-order")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header("x-herdr-session", "work")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let default = app
        .oneshot(
            request(Method::GET, "/api/workspace-order")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response_json(work).await["order"], json!(["w2", "w1"]));
    assert_eq!(response_json(default).await["order"], json!([]));
}

#[tokio::test]
async fn push_recent_workspace_dedupes_orders_and_truncates() {
    let mut recent = Vec::new();
    push_recent_workspace(
        &mut recent,
        "  /repo/a  ",
        Some(" A ".to_string()),
        None,
        Some("workspace".to_string()),
    );
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, "/repo/a");
    assert_eq!(recent[0].label.as_deref(), Some("A"));

    push_recent_workspace(&mut recent, "/repo/a", None, None, None);
    assert_eq!(recent.len(), 1, "same path replaces the existing entry");
    assert_eq!(recent[0].label, None, "replacement clears the label");

    push_recent_workspace(&mut recent, "   ", None, None, None);
    assert_eq!(recent.len(), 1, "empty and whitespace paths are ignored");

    for index in 0..(MAX_RECENT_WORKSPACES + 5) {
        push_recent_workspace(&mut recent, &format!("/repo/{index}"), None, None, None);
    }
    assert_eq!(recent.len(), MAX_RECENT_WORKSPACES);
    assert_eq!(
        recent[0].path,
        format!("/repo/{}", MAX_RECENT_WORKSPACES + 4)
    );
    assert!(recent.iter().all(|item| item.opened_at.is_some()));
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn recent_workspaces_api_requires_auth_and_clears() {
    let _env = lock_env();
    // The authed clear persists server settings; keep that write inside
    // a temp config dir so the real operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-recent-clear-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    // GET prunes entries whose folder is gone, so the seeded entry needs a
    // real directory on disk.
    let recent_dir = std::env::temp_dir().join(format!(
        "herdr-webui-recent-clear-dir-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&recent_dir).unwrap();
    let recent_path = recent_dir.to_str().unwrap().to_string();
    let app = test_app();

    let unauthorized = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/recent-workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let open_unauthorized = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/recent-workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "path": "/repo/x", "label": "X" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(open_unauthorized.status(), StatusCode::UNAUTHORIZED);

    let clear_unauthorized = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/recent-workspaces/clear")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(clear_unauthorized.status(), StatusCode::UNAUTHORIZED);

    {
        let state = test_state();
        {
            let mut guard = state.server_settings.lock().unwrap();
            push_recent_workspace(
                &mut guard.recent_workspaces,
                &recent_path,
                Some("X".to_string()),
                Some("main".to_string()),
                Some("worktree".to_string()),
            );
        }
        let app_with_recent = test_app_with_state(state);

        let listed = app_with_recent
            .clone()
            .oneshot(
                request(Method::GET, "/api/recent-workspaces")
                    .header(header::COOKIE, "herdr_web_session=token-123")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let json = response_json(listed).await;
        assert_eq!(json["recent"][0]["path"], recent_path.as_str());
        assert_eq!(json["recent"][0]["label"], "X");
        assert_eq!(json["recent"][0]["branch"], "main");
        assert_eq!(json["recent"][0]["kind"], "worktree");

        let cleared = app_with_recent
            .oneshot(
                request(Method::POST, "/api/recent-workspaces/clear")
                    .header(header::COOKIE, "herdr_web_session=token-123")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cleared.status(), StatusCode::OK);
        assert_eq!(response_json(cleared).await["cleared"], json!(1));
    }

    let _ = fs::remove_dir_all(config_home);
    let _ = fs::remove_dir_all(&recent_dir);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn recent_workspaces_record_endpoint_requires_auth_and_records() {
    let _env = lock_env();
    // The authed record persists server settings; keep that write inside
    // a temp config dir so the real operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-recent-record-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let app = test_app();

    let unauthorized = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/recent-workspaces/record")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "path": "/repo/x", "label": "X" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let empty_path = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/recent-workspaces/record")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::from(json!({ "path": "   " }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(empty_path.status(), StatusCode::BAD_REQUEST);

    // Recording does not need the folder on disk (unlike GET pruning,
    // the record happens right after the client created it there).
    let recorded = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/recent-workspaces/record")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::from(
                    json!({ "path": "/repo/x", "label": "X", "kind": "workspace" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(recorded.status(), StatusCode::OK);
    assert_eq!(response_json(recorded).await["ok"], json!(true));

    // The record landed in the persisted settings file, with the sent
    // fields (branch absent like the desktop's create-flow record).
    let settings_path = config_home.join("herdr-webui").join("webui-settings.json");
    let text = fs::read_to_string(&settings_path).unwrap_or_default();
    let persisted: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let entry = &persisted["recent_workspaces"][0];
    assert_eq!(entry["path"], json!("/repo/x"), "persisted: {text}");
    assert_eq!(entry["label"], json!("X"), "persisted: {text}");
    assert_eq!(entry["kind"], json!("workspace"), "persisted: {text}");
    assert!(entry["branch"].is_null(), "persisted: {text}");
    assert!(entry["opened_at"].as_u64().is_some(), "persisted: {text}");

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// End-to-end closure of the auth parity loop: a real axum server with
/// real auth (username/password, no localhost bypass), a real
/// `WebApiClient` as the TUI binary uses it, and a real
/// `webui-settings.json` holding the credentials. The client must get
/// 401 on the first recents call, log in through /api/login, cache the
/// session cookie, retry, and every recents operation must then work
/// against the authed server.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn web_api_client_authenticates_against_real_authed_server() {
    let _env = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-tui-auth-e2e-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(config_home.join("herdr-webui")).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    // The persisted settings the TUI reads: the authed server's
    // user/password. bind is present too so the file shape matches
    // a real deployment.
    std::fs::write(
        config_home.join("herdr-webui").join("webui-settings.json"),
        json!({ "bind": "127.0.0.1:0", "user": "user", "password": "pass" }).to_string(),
    )
    .unwrap();
    // GET /api/recent-workspaces prunes entries whose folder is gone,
    // so the recorded path must exist on disk.
    let recorded_dir = std::env::temp_dir().join(format!(
        "herdr-webui-tui-auth-e2e-dir-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&recorded_dir).unwrap();
    let recorded_path = recorded_dir.to_string_lossy().to_string();

    // test_state() has auth on: user/pass, localhost_no_auth false,
    // so only a valid session cookie passes require_auth.
    let state = test_state();
    let app = test_app_with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    // The blocking TUI client runs on the blocking pool.
    let port = addr.port();
    let outcome = tokio::task::spawn_blocking(move || {
        let client = herdr_webui::tui::web_api::WebApiClient::new("127.0.0.1", port);
        // First call: 401, then the client logs in with the persisted
        // credentials and retries. recent-workspaces returns [] with a
        // 200 once authorized.
        let value = client
            .recent_workspaces()
            .expect("401 triggers login and the retry succeeds");
        assert_eq!(value["recent"], json!([]), "authorized list is empty");
        // Second call: the cached cookie authorizes without login.
        let value = client
            .recent_workspaces()
            .expect("cached session cookie authorizes");
        assert_eq!(value["recent"], json!([]));
        // Record one entry; it must persist with the sent fields.
        client
            .record_recent_workspace(&recorded_path, Some("e2e label"), Some("workspace"))
            .expect("record reaches the authed server");
        // And the list now serves the entry back (the folder exists, so
        // the GET pruning keeps it).
        let value = client.recent_workspaces().expect("list after record");
        assert_eq!(value["recent"][0]["path"], json!(recorded_path));
        assert_eq!(value["recent"][0]["label"], json!("e2e label"));
    })
    .await;

    // Also pin the wrong-password path: the 401 must surface, not hang
    // or loop.
    let wrong_port = addr.port();
    let wrong_config_home = config_home.clone();
    let wrong = tokio::task::spawn_blocking(move || {
        std::fs::write(
            wrong_config_home
                .join("herdr-webui")
                .join("webui-settings.json"),
            json!({ "bind": "127.0.0.1:0", "user": "user", "password": "WRONG" }).to_string(),
        )
        .unwrap();
        let client = herdr_webui::tui::web_api::WebApiClient::new("127.0.0.1", wrong_port);
        match client.recent_workspaces() {
            Err(herdr_webui::tui::web_api::WebApiError::Http { status: 401, .. }) => 401,
            Err(herdr_webui::tui::web_api::WebApiError::Api(_)) => 401,
            other => panic!("expected surfaced 401, got {other:?}"),
        }
    })
    .await;

    server_handle.abort();
    outcome.expect("authed e2e client flow");
    assert_eq!(wrong.expect("wrong-password flow"), 401);

    let _ = std::fs::remove_dir_all(&recorded_dir);
    let _ = std::fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn web_api_client_recovers_after_real_server_token_rotation() {
    let _env = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-tui-rotation-e2e-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(config_home.join("herdr-webui")).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    std::fs::write(
        config_home.join("herdr-webui").join("webui-settings.json"),
        json!({ "bind": "127.0.0.1:0", "user": "user", "password": "pass" }).to_string(),
    )
    .unwrap();

    // Real authed router (auth on, no localhost bypass). Keep the auth
    // Arc so the test can rotate the session token live, which is what
    // a WebUI restart does to a long-running TUI.
    let state = test_state();
    let auth = Arc::clone(&state.auth);
    let old_token = auth.lock().unwrap().token.clone();
    let app = test_app_with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let port = addr.port();
    let outcome = tokio::task::spawn_blocking(move || {
        let client = herdr_webui::tui::web_api::WebApiClient::new("127.0.0.1", port);
        // Login + authorized call: cookie for the old token.
        let value = client
            .recent_workspaces()
            .expect("initial login and authorized call");
        assert_eq!(value["recent"], json!([]));
        client
            .recent_workspaces()
            .expect("cached cookie authorizes");
        (client, ())
    })
    .await;
    let (client, ()) = outcome.expect("initial authed flow");

    // Rotate the live token: same credentials, fresh per-start token.
    // The client's cached cookie is now stale.
    {
        let mut auth = auth.lock().unwrap();
        let rotated = crate::auth::AuthConfig::from_parts_with_expiration(
            auth.user.clone(),
            auth.password.clone(),
            auth.localhost_no_auth,
            DEFAULT_SESSION_EXPIRATION_MINUTES,
        );
        assert_ne!(rotated.token, old_token, "rotation must change the token");
        *auth = rotated;
    }

    // The same client instance (stale cookie) must re-login through the
    // real /api/login route, replace the cookie, and recover. The old
    // `cookie.is_none()` guard surfaces 401 forever here.
    let recovered = tokio::task::spawn_blocking(move || {
        let value = client
            .recent_workspaces()
            .expect("stale cookie re-logins and the call recovers");
        assert_eq!(value["recent"], json!([]));
        // And the new cookie is cached again.
        client.recent_workspaces().expect("new cookie authorizes");
    })
    .await;
    recovered.expect("rotation recovery flow");

    server_handle.abort();
    let _ = std::fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn recent_workspaces_prunes_missing_paths_and_persists() {
    let _env = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-recent-prune-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let kept_dir = std::env::temp_dir().join(format!(
        "herdr-webui-recent-prune-kept-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&kept_dir).unwrap();
    let kept_path = kept_dir.to_str().unwrap().to_string();

    {
        let state = test_state();
        {
            let mut guard = state.server_settings.lock().unwrap();
            push_recent_workspace(
                &mut guard.recent_workspaces,
                &kept_path,
                Some("Kept".to_string()),
                None,
                Some("workspace".to_string()),
            );
            push_recent_workspace(
                &mut guard.recent_workspaces,
                "/repo/gone-recent",
                None,
                None,
                None,
            );
        }
        let app = test_app_with_state(state.clone());

        let listed = app
            .oneshot(
                authed_request(Method::GET, "/api/recent-workspaces")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let recent = response_json(listed).await["recent"].clone();
        assert_eq!(recent.as_array().map(Vec::len), Some(1));
        assert_eq!(recent[0]["path"], kept_path.as_str());

        // The prune also updates in-memory state and persists it.
        let stored = state
            .server_settings
            .lock()
            .map(|settings| settings.recent_workspaces.clone())
            .unwrap_or_default();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].path, kept_path);
        let persisted =
            fs::read_to_string(config_home.join("herdr-webui/webui-settings.json")).unwrap();
        assert!(persisted.contains(&kept_path));
        assert!(!persisted.contains("/repo/gone-recent"));
    }

    let _ = fs::remove_dir_all(config_home);
    let _ = fs::remove_dir_all(&kept_dir);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn recent_workspaces_reports_persist_failure_when_prune_cannot_save() {
    let _env = lock_env();
    let state = test_state();
    // Point XDG_CONFIG_HOME at a plain file so saving settings cannot create
    // the config directory, making the prune persist fail.
    let sentinel = std::env::temp_dir().join(format!(
        "herdr-webui-prune-persist-file-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::write(&sentinel, "not-a-directory").unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &sentinel);

    {
        let mut guard = state.server_settings.lock().unwrap();
        push_recent_workspace(
            &mut guard.recent_workspaces,
            "/repo/gone-recent",
            None,
            None,
            None,
        );
    }
    let app = test_app_with_state(state);

    let listed = app
        .oneshot(
            authed_request(Method::GET, "/api/recent-workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(response_json(listed).await["error"].as_str().is_some());

    std::env::remove_var("XDG_CONFIG_HOME");
    let _ = fs::remove_file(sentinel);
}

// lock_env() serializes env-mutating tests; holding it across await is
// intentional so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn remove_recent_workspace_removes_single_entry_and_validates() {
    let _env = lock_env();
    // The authed remove persists server settings; keep that write inside
    // a temp config dir so the real operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-recent-remove-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    // GET prunes entries whose folder is gone, so the seeded entries need
    // real directories on disk.
    let keep_dir = std::env::temp_dir().join(format!(
        "herdr-webui-recent-remove-keep-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&keep_dir).unwrap();
    let keep_path = keep_dir.to_str().unwrap().to_string();
    let gone_dir = std::env::temp_dir().join(format!(
        "herdr-webui-recent-remove-gone-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&gone_dir).unwrap();
    let gone_path = gone_dir.to_str().unwrap().to_string();

    {
        let state = test_state();
        {
            let mut guard = state.server_settings.lock().unwrap();
            push_recent_workspace(
                &mut guard.recent_workspaces,
                &keep_path,
                Some("Keep".to_string()),
                None,
                Some("workspace".to_string()),
            );
            push_recent_workspace(
                &mut guard.recent_workspaces,
                &gone_path,
                Some("Gone".to_string()),
                None,
                Some("worktree".to_string()),
            );
        }
        let app = test_app_with_state(state);

        let unauthorized = app
            .clone()
            .oneshot(
                request(Method::POST, "/api/recent-workspaces/remove")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "path": gone_path }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let missing_path = app
            .clone()
            .oneshot(
                authed_request(Method::POST, "/api/recent-workspaces/remove")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_path.status(), StatusCode::BAD_REQUEST);

        // Empty and whitespace-only paths must 400 too, not expand to the
        // home directory and silently remove the home workspace entry.
        for empty_body in [json!({ "path": "" }), json!({ "path": "   " })] {
            let empty_path = app
                .clone()
                .oneshot(
                    authed_request(Method::POST, "/api/recent-workspaces/remove")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(empty_body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(empty_path.status(), StatusCode::BAD_REQUEST);
        }

        let removed = app
            .clone()
            .oneshot(
                authed_request(Method::POST, "/api/recent-workspaces/remove")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "path": gone_path }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(removed.status(), StatusCode::OK);
        let json = response_json(removed).await;
        assert_eq!(json["ok"], json!(true));
        assert_eq!(json["removed"], json!(1));
        assert_eq!(json["path"], gone_path.as_str());

        let listed = app
            .clone()
            .oneshot(
                authed_request(Method::GET, "/api/recent-workspaces")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let recent = response_json(listed).await["recent"].clone();
        assert_eq!(recent.as_array().map(Vec::len), Some(1));
        assert_eq!(recent[0]["path"], keep_path.as_str());

        // Removing an unknown path reports zero removals and keeps state.
        let noop = app
            .oneshot(
                authed_request(Method::POST, "/api/recent-workspaces/remove")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "path": "/repo/unknown" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(noop.status(), StatusCode::OK);
        assert_eq!(response_json(noop).await["removed"], json!(0));
    }

    let _ = fs::remove_dir_all(config_home);
    let _ = fs::remove_dir_all(keep_dir);
    let _ = fs::remove_dir_all(gone_dir);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[tokio::test]
async fn runtime_settings_persist_recent_workspaces_round_trip() {
    let mut settings = default_runtime_server_settings("127.0.0.1:8787".parse().unwrap());
    push_recent_workspace(
        &mut settings.recent_workspaces,
        "/repo/round",
        Some("Round".to_string()),
        None,
        Some("workspace".to_string()),
    );
    let serialized = serde_json::to_string(&PersistedServerSettings {
        bind: Some(settings.bind.to_string()),
        tls_mode: Some(settings.tls_mode),
        user: settings.user.clone(),
        password: settings.password.clone(),
        localhost_no_auth: Some(settings.localhost_no_auth),
        session_expiration_minutes: Some(settings.session_expiration_minutes),
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
    })
    .unwrap();
    assert!(serialized.contains("\"recent_workspaces\""));
    let parsed: PersistedServerSettings = serde_json::from_str(&serialized).unwrap();
    let recent = parsed.recent_workspaces.unwrap();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, "/repo/round");
    assert_eq!(recent[0].label.as_deref(), Some("Round"));
}

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn open_worktree_handler_records_recent_workspace() {
    let _env = lock_env();
    // The authed open records a recent workspace, which persists server
    // settings; keep that write inside a temp config dir so the real
    // operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-worktree-record-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.open",
        json!({ "id": "web:worktree:open", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state.clone());

    let response = app
            .oneshot(
                authed_request(Method::POST, "/api/worktrees/open")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "workspace_id": "ws1", "cwd": "/repo", "path": "/repo/wt", "branch": "feature", "label": "  Feature  " }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    let recent = state
        .server_settings
        .lock()
        .map(|settings| settings.recent_workspaces.clone())
        .unwrap_or_default();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, "/repo/wt");
    assert_eq!(recent[0].label.as_deref(), Some("Feature"));
    assert_eq!(recent[0].branch.as_deref(), Some("feature"));
    assert_eq!(recent[0].kind.as_deref(), Some("worktree"));

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn open_recent_workspace_records_and_proxies_open() {
    let _env = lock_env();
    // The authed record persists server settings; keep that write inside
    // a temp config dir so the real operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-recent-open-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    // The open handler validates that the folder exists, so the recent
    // entry needs a real directory on disk.
    let recent_dir = std::env::temp_dir().join(format!(
        "herdr-webui-recent-open-dir-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&recent_dir).unwrap();
    let recent_path = recent_dir.to_str().unwrap().to_string();
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.open",
        json!({ "id": "web:recent-workspace:open", "result": { "ok": true, "workspace": { "workspace_id": "ws-recent" } } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state.clone());

    let response = app
        .clone()
        .oneshot(
            authed_request(Method::POST, "/api/recent-workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "path": recent_path, "label": " Recent ", "branch": "main" })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    let recent = state
        .server_settings
        .lock()
        .map(|settings| settings.recent_workspaces.clone())
        .unwrap_or_default();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, recent_path);
    assert_eq!(recent[0].label.as_deref(), Some("Recent"));
    assert_eq!(recent[0].branch.as_deref(), Some("main"));
    assert_eq!(recent[0].kind.as_deref(), Some("workspace"));

    let body = response_json(response).await;
    assert_eq!(
        body["result"]["workspace"]["workspace_id"],
        json!("ws-recent")
    );

    // Empty and whitespace-only paths must 400 before expansion: the old
    // behavior expanded "" to the home directory, opened it as a
    // workspace, and recorded it in recents.
    for empty in ["", "   "] {
        let response = app
            .clone()
            .oneshot(
                authed_request(Method::POST, "/api/recent-workspaces")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "path": empty }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "expected 400 for open with empty path"
        );
        let body = response_json(response).await;
        assert_eq!(body["error"], json!("path is required"));
    }
    // No extra recents entry leaked from the rejected requests.
    let recent = state
        .server_settings
        .lock()
        .map(|settings| settings.recent_workspaces.clone())
        .unwrap_or_default();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, recent_path);

    let _ = fs::remove_dir_all(config_home);
    let _ = fs::remove_dir_all(&recent_dir);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
// lock_env() serializes env-mutating tests; held across await on purpose
// so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn open_recent_workspace_rejects_missing_folder() {
    let _env = lock_env();
    let state = test_state();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/recent-workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "path": "/repo/definitely-gone", "label": "Gone" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(response).await["error"],
        json!("workspace folder must exist")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn recent_workspaces_returns_service_unavailable_when_lock_poisoned() {
    let state = test_state();
    // Poison the settings lock so handlers take their degraded arms.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = state.server_settings.lock().unwrap();
        struct PanicOnDrop;
        impl Drop for PanicOnDrop {
            fn drop(&mut self) {
                panic!("poisoning settings lock");
            }
        }
        drop(PanicOnDrop);
    }));
    let app = test_app_with_state(state);

    let listed = app
        .clone()
        .oneshot(
            authed_request(Method::GET, "/api/recent-workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // The GET arm returns an empty list when the lock is unavailable.
    assert_eq!(listed.status(), StatusCode::OK);
    assert_eq!(
        response_json(listed).await["recent"]
            .as_array()
            .map(Vec::len),
        Some(0)
    );

    let cleared = app
        .oneshot(
            authed_request(Method::POST, "/api/recent-workspaces/clear")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn clear_recent_workspaces_reports_persist_failure() {
    let _guard = lock_env();
    let state = test_state();
    // Point XDG_CONFIG_HOME at a plain file so saving settings cannot create
    // the config directory, making persist_server_settings fail.
    let sentinel = std::env::temp_dir().join(format!(
        "herdr-webui-clear-persist-file-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::write(&sentinel, "not-a-directory").unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &sentinel);

    {
        let mut guard = state.server_settings.lock().unwrap();
        push_recent_workspace(&mut guard.recent_workspaces, "/repo/x", None, None, None);
    }
    let app = test_app_with_state(state);

    let cleared = app
        .oneshot(
            authed_request(Method::POST, "/api/recent-workspaces/clear")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(response_json(cleared).await["error"].as_str().is_some());

    std::env::remove_var("XDG_CONFIG_HOME");
    let _ = fs::remove_file(sentinel);
}

#[tokio::test]
async fn record_and_persist_recent_fail_gracefully_when_lock_poisoned() {
    let state = test_state();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = state.server_settings.lock().unwrap();
        struct PanicOnDrop;
        impl Drop for PanicOnDrop {
            fn drop(&mut self) {
                panic!("poisoning settings lock");
            }
        }
        drop(PanicOnDrop);
    }));

    let recorded = record_recent_workspace(&state, "/repo/x", None, None, None).await;
    assert!(
        recorded.is_err(),
        "recording must fail when the lock is poisoned"
    );

    let persisted = persist_server_settings(&state).await;
    assert!(
        persisted.is_err(),
        "persisting must fail when the lock is poisoned"
    );
}

#[tokio::test]
async fn static_asset_routes_serve_embedded_content() {
    let app = test_app();
    let js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/vendor/wterm.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/vendor/wterm.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let ghostty_wasm = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/vendor/ghostty-vt.wasm")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let font = app
        .clone()
        .oneshot(
            request(
                Method::GET,
                "/assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    let app_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/desktop/app.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let app_boot_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/app-boot.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let app_core_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/core.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let settings_feedback_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/settings-feedback.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let settings_confirm_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/settings-confirm.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let file_icons_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/file-icons.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let file_icons_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/file-icons.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_colors_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/colors.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_tokens_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/tokens.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_primitives_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/primitives.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_alert_card_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/alert-card.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_alert_card_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/alert-card.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_content_search_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/content-search.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let file_content_search_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/file-content-search.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let line_context_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/line-context.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let desktop_search_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/desktop/search.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let app_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/desktop/app.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let desktop_search_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/desktop/search.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let desktop_shortcuts_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/desktop/shortcuts.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/app.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_core_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/core.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_attention_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/attention.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_terminal_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/terminal.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_worktrees_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/worktrees.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_settings_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/settings.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_search_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/search.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_git_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/git.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_sessions_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/sessions.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_events_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/events.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_screens_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/screens.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_panels_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/panels.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_workmeta_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/workmeta.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_theme_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/theme.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_actions_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/actions.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_backend_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/backend.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/app.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let icon = app
        .clone()
        .oneshot(
            request(Method::GET, "/favicon.svg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let attention_icon = app
        .clone()
        .oneshot(
            request(Method::GET, "/favicon-attention.svg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let error_icon = app
        .oneshot(
            request(Method::GET, "/favicon-error.svg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(js.status(), StatusCode::OK);
    assert_eq!(css.status(), StatusCode::OK);
    assert_eq!(ghostty_wasm.status(), StatusCode::OK);
    assert_eq!(font.status(), StatusCode::OK);
    assert_eq!(app_js.status(), StatusCode::OK);
    assert_eq!(app_boot_js.status(), StatusCode::OK);
    assert_eq!(app_core_js.status(), StatusCode::OK);
    assert_eq!(settings_feedback_js.status(), StatusCode::OK);
    assert_eq!(settings_confirm_js.status(), StatusCode::OK);
    assert_eq!(file_icons_js.status(), StatusCode::OK);
    assert_eq!(file_icons_css.status(), StatusCode::OK);
    assert_eq!(shared_colors_css.status(), StatusCode::OK);
    assert_eq!(shared_tokens_css.status(), StatusCode::OK);
    assert_eq!(shared_primitives_css.status(), StatusCode::OK);
    assert_eq!(shared_alert_card_js.status(), StatusCode::OK);
    assert_eq!(shared_alert_card_css.status(), StatusCode::OK);
    assert_eq!(shared_content_search_css.status(), StatusCode::OK);
    assert_eq!(file_content_search_js.status(), StatusCode::OK);
    assert_eq!(desktop_search_js.status(), StatusCode::OK);
    assert_eq!(app_css.status(), StatusCode::OK);
    assert_eq!(desktop_search_css.status(), StatusCode::OK);
    assert_eq!(desktop_shortcuts_css.status(), StatusCode::OK);
    assert_eq!(mobile_attention_js.status(), StatusCode::OK);
    assert_eq!(mobile_core_js.status(), StatusCode::OK);
    assert_eq!(mobile_terminal_js.status(), StatusCode::OK);
    assert_eq!(mobile_worktrees_js.status(), StatusCode::OK);
    assert_eq!(mobile_settings_js.status(), StatusCode::OK);
    assert_eq!(mobile_search_js.status(), StatusCode::OK);
    assert_eq!(mobile_git_js.status(), StatusCode::OK);
    assert_eq!(mobile_sessions_js.status(), StatusCode::OK);
    assert_eq!(mobile_events_js.status(), StatusCode::OK);
    assert_eq!(mobile_screens_js.status(), StatusCode::OK);
    assert_eq!(mobile_panels_js.status(), StatusCode::OK);
    assert_eq!(mobile_workmeta_js.status(), StatusCode::OK);
    assert_eq!(mobile_theme_js.status(), StatusCode::OK);
    assert_eq!(mobile_actions_js.status(), StatusCode::OK);
    assert_eq!(mobile_backend_js.status(), StatusCode::OK);
    assert_eq!(mobile_js.status(), StatusCode::OK);
    assert_eq!(mobile_css.status(), StatusCode::OK);
    assert_eq!(icon.status(), StatusCode::OK);
    assert_eq!(attention_icon.status(), StatusCode::OK);
    assert_eq!(error_icon.status(), StatusCode::OK);
    assert!(js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert_eq!(
        ghostty_wasm.headers()[header::CONTENT_TYPE],
        "application/wasm"
    );
    assert_eq!(font.headers()[header::CONTENT_TYPE], "font/ttf");
    assert!(app_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(app_boot_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(app_core_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(file_icons_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(file_icons_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(shared_colors_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(shared_tokens_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(shared_primitives_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(shared_alert_card_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(shared_alert_card_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(shared_content_search_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(file_content_search_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(line_context_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(desktop_search_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(app_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(desktop_search_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(desktop_shortcuts_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(mobile_core_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_attention_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_terminal_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_worktrees_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_settings_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_search_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_git_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_sessions_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_events_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_screens_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_panels_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_workmeta_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_theme_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_actions_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_backend_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(icon.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("image/svg+xml"));
    assert!(
        to_bytes(js.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(to_bytes(css.into_body(), 1024 * 1024).await.unwrap().len() > 100);
    assert!(
        to_bytes(ghostty_wasm.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100 * 1024
    );
    assert!(
        to_bytes(font.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 2 * 1024 * 1024
    );
    assert!(
        to_bytes(app_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(app_boot_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(app_core_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(file_icons_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(file_icons_css.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(desktop_search_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(app_css.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(desktop_search_css.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(desktop_shortcuts_css.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(mobile_core_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_attention_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_terminal_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_worktrees_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_settings_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(mobile_search_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_git_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_sessions_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_events_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 500
    );
    assert!(
        to_bytes(mobile_screens_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_panels_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_workmeta_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_theme_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_actions_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_backend_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_css.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(String::from_utf8(
        to_bytes(icon.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec()
    )
    .unwrap()
    .contains("<svg"));
}

#[tokio::test]
async fn app_boot_skips_terminal_scroll_helper_but_compat_route_remains() {
    let app = test_app();
    let app_boot_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/app-boot.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let terminal_scroll_js = app
        .oneshot(
            request(Method::GET, "/assets/shared/terminal-scroll.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(app_boot_js.status(), StatusCode::OK);
    assert_eq!(terminal_scroll_js.status(), StatusCode::OK);
    let app_boot_body = String::from_utf8(
        to_bytes(app_boot_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let terminal_scroll_body = String::from_utf8(
        to_bytes(terminal_scroll_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();

    assert!(!app_boot_body.contains("/assets/shared/terminal-scroll.js"));
    assert!(terminal_scroll_body.contains("Compatibility shim"));
    assert!(terminal_scroll_body.contains("HerdrTerminalScroll"));
}

#[test]
fn list_git_branches_can_include_remote_refs_on_request() {
    let repo =
        std::env::temp_dir().join(format!("herdr-webui-branches-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/local"])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["update-ref", "refs/remotes/origin/feature/remote", "HEAD"])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ])
        .output()
        .unwrap()
        .status
        .success());

    let local = list_git_branches(repo.to_str().unwrap(), false, false).unwrap();
    assert!(local.contains(&"feature/local".to_string()));
    assert!(!local.contains(&"origin/feature/remote".to_string()));

    let remote = list_git_branches(repo.to_str().unwrap(), true, false).unwrap();
    assert!(remote.contains(&"feature/local".to_string()));
    assert!(remote.contains(&"origin/feature/remote".to_string()));
    assert!(!remote.contains(&"origin/HEAD".to_string()));

    fs::remove_dir_all(repo).unwrap();
}

/// Fake API socket that reads one request then closes the connection
/// without responding, simulating a backend that shuts down on server.stop.
#[cfg(unix)]
fn fake_api_socket_drop_on_stop() -> (
    PathBuf,
    std::sync::Arc<std::sync::Mutex<bool>>,
    thread::JoinHandle<()>,
) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use std::sync::Arc;
    use std::sync::Mutex;

    let path = std::env::temp_dir().join(format!(
        "herdr-webui-stop-test-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let saw_stop = Arc::new(Mutex::new(false));
    let saw_stop_clone = saw_stop.clone();
    let handle = thread::spawn(move || {
        let stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        if request["method"] == "server.stop" {
            *saw_stop_clone.lock().unwrap() = true;
            // Drop the connection without responding, simulating backend shutdown.
            drop(stream);
        }
    });
    (path, saw_stop, handle)
}

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_ok_when_backend_drops_connection() {
    let (socket, saw_stop, handle) = fake_api_socket_drop_on_stop();
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert!(
        *saw_stop.lock().unwrap(),
        "backend should have received server.stop"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_ok_and_already_stopped_on_missing_socket() {
    // A stale session row: the backend died and its socket file is gone.
    // Close must succeed so the UI can dismiss the row, not 502.
    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-herdr-test-socket.sock"));
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["already_stopped"], true);
}

#[cfg(unix)]
#[tokio::test]
async fn close_session_reports_already_stopped_when_listener_died_with_socket_file() {
    // Stale row variant: the backend crashed (or was kill -9'd) without
    // unlinking its socket, so connect(2) gets ECONNREFUSED ("Connection
    // refused", macOS os error 61) instead of ENOENT. The session is
    // already down, so close must be ok + already_stopped, not 502.
    // /tmp, not std::env::temp_dir(): CI runners have a long $TMPDIR
    // that pushes this path past sun_path's 104-byte capacity.
    let path = PathBuf::from(format!(
        "/tmp/herdr-webui-test-dead-listener-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    // Bind then drop the listener: the socket file survives with nobody
    // accepting on it, exactly like a crashed backend. std's UnixListener
    // does not unlink on drop, unlike interprocess's ReclaimGuard.
    {
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        drop(listener);
    }

    let mut state = test_state();
    state.api_socket = Some(path.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["already_stopped"], true);
    let _ = fs::remove_file(path);
}

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn close_session_builtin_reports_already_stopped_when_listener_died_with_socket_file() {
    // Same dead-listener stale row for the built-in backend: the session
    // directory still holds a socket file with no listener (crashed
    // child). Close must be ok + already_stopped, drop the registry
    // entry, and remove the dead socket residue.
    let _guard = lock_env();
    // Short /tmp prefix, not std::env::temp_dir(): CI runners have a
    // long $TMPDIR that pushes the session socket path past sun_path's
    // 104-byte capacity (and past the deterministic fallback in
    // builtin_socket_paths, which would exercise a different code path).
    let config_home = PathBuf::from(format!(
        "/tmp/hw-dlclose-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let session_name = "dead-listener-builtin";
    let (api_socket, _client_socket) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    {
        let listener = std::os::unix::net::UnixListener::bind(&api_socket).unwrap();
        drop(listener);
    }

    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    // Registry entries hold live handles; a real (throwaway) handle keeps
    // the map shape honest. Its sockets live in /tmp and are never the ones
    // close_session contacts (that path comes from XDG_CONFIG_HOME).
    let stale_handle = Arc::new(
        builtin_backend::BuiltinBackendHandle::start(builtin_backend::BuiltinBackendConfig {
            api_socket: PathBuf::from(format!(
                "/tmp/herdr-webui-dead-listener-close-api-{}.sock",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            )),
            client_socket: PathBuf::from(format!(
                "/tmp/herdr-webui-dead-listener-close-client-{}.sock",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            )),
            cwd: std::env::temp_dir(),
            shell: None,
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
        })
        .unwrap(),
    );
    state
        .builtin_sessions
        .lock()
        .unwrap()
        .insert(session_name.to_string(), stale_handle);
    let sessions_registry = state.builtin_sessions.clone();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["already_stopped"], true);
    assert!(
        !sessions_registry.lock().unwrap().contains_key(session_name),
        "registry entry must be removed after closing a dead-listener built-in session"
    );
    assert!(
        !api_socket.exists(),
        "dead socket file must be removed after close"
    );
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
// lock_env() serializes env-mutating tests; held across await on purpose
// so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn close_session_builtin_with_missing_socket_reports_already_stopped() {
    // Same stale-row class for the built-in backend: the session
    // directory reports a session that no longer has a live socket
    // (crashed child). Closing it must be ok + already_stopped, and the
    // registry entry must be dropped.
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-stale-close-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let session_name = "gone-builtin";
    // Registry entries hold live handles; a real (throwaway) handle keeps
    // the map shape honest. Its sockets live in /tmp and are never the ones
    // close_session contacts (that path comes from XDG_CONFIG_HOME), so the
    // proxy sees ENOENT, the stale-row case under test.
    let stale_handle = Arc::new(
        builtin_backend::BuiltinBackendHandle::start(builtin_backend::BuiltinBackendConfig {
            api_socket: std::env::temp_dir().join(format!(
                "herdr-webui-stale-close-api-{}.sock",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            )),
            client_socket: std::env::temp_dir().join(format!(
                "herdr-webui-stale-close-client-{}.sock",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            )),
            cwd: std::env::temp_dir(),
            shell: None,
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
        })
        .unwrap(),
    );
    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    state
        .builtin_sessions
        .lock()
        .unwrap()
        .insert(session_name.to_string(), stale_handle);
    let sessions_registry = state.builtin_sessions.clone();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["already_stopped"], true);
    // close_session must also drop the registry entry so the stale
    // session cannot linger in the built-in registry.
    assert!(
        !sessions_registry.lock().unwrap().contains_key(session_name),
        "registry entry must be removed after closing a stale built-in session"
    );
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── closed built-in session marker ──
// Close must be final until an explicit relaunch: the marker has to block
// every auto-start path (workspace proxying, events socket, terminal) and
// clean the on-disk residue so the row disappears from the manager list.

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn close_session_builtin_marks_session_closed_and_removes_residue() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-close-marker-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let session_name = "marker-close";
    let (api_socket, client_socket) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    let _ = fs::remove_file(&api_socket);
    let _ = fs::remove_file(&client_socket);

    // Live socket so close succeeds without the stale-row shortcut.
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    let name = api_socket.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let accept_handle = thread::spawn(move || {
        let stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        // server.stop: close the connection, simulating shutdown.
        drop(stream);
    });

    let state = test_state();
    let closed_registry = state.closed_builtin_sessions.clone();
    let sessions_registry = state.builtin_sessions.clone();
    let state_for_list = state.clone();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    accept_handle.join().unwrap();
    assert!(
        closed_registry.lock().unwrap().contains(session_name),
        "closed marker must be set after a successful builtin close"
    );
    assert!(
        !sessions_registry.lock().unwrap().contains_key(session_name),
        "live registry entry must be removed after close"
    );
    assert!(
        !api_socket.exists(),
        "api socket file must be removed after close"
    );
    assert!(
        !client_socket.exists(),
        "client socket file must be removed after close"
    );
    assert!(
        !api_socket.parent().unwrap().exists(),
        "empty session directory must be removed after close"
    );
    // The session must be gone from the manager list.
    assert!(
        !known_sessions(&state_for_list, true)
            .iter()
            .any(|session| session.get("name").and_then(Value::as_str) == Some(session_name)),
        "closed session must disappear from known_sessions"
    );

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[test]
fn ensure_builtin_session_skips_closed_sessions() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-closed-skip-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let state = test_state();
    state
        .closed_builtin_sessions
        .lock()
        .unwrap()
        .insert("closed-one".to_string());

    assert!(
        ensure_builtin_session(&state, Some("closed-one")).is_ok(),
        "closed session must be skipped, not resurrected"
    );
    assert!(
        !state
            .builtin_sessions
            .lock()
            .unwrap()
            .contains_key("closed-one"),
        "no backend may be started for a closed session"
    );
    let (api_socket, _) = builtin_socket_paths(Some("closed-one"));
    assert!(
        !api_socket.exists(),
        "closed session must leave no socket behind"
    );

    // Non-closed sessions still auto-start normally.
    assert!(ensure_builtin_session(&state, Some("open-one")).is_ok());
    assert!(
        state
            .builtin_sessions
            .lock()
            .unwrap()
            .contains_key("open-one"),
        "auto-start must still work for non-closed sessions"
    );

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn launch_session_builtin_clears_closed_marker_and_revives_session() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-relaunch-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let session_name = "relaunch-me";
    let state = test_state();
    state
        .closed_builtin_sessions
        .lock()
        .unwrap()
        .insert(session_name.to_string());
    let closed_registry = state.closed_builtin_sessions.clone();
    let state_after = state.clone();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert!(
        !closed_registry.lock().unwrap().contains(session_name),
        "explicit launch must clear the closed marker"
    );
    assert!(
        state_after
            .builtin_sessions
            .lock()
            .unwrap()
            .contains_key(session_name),
        "relaunched session must be running again"
    );

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[test]
fn ensure_backend_for_request_does_not_resurrect_closed_session() {
    // The workspace-proxy auto-start funnel: a request aimed at a closed
    // session (ensure_backend_for_request is what api_for_headers_ensured
    // calls) must not start its backend again.
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-resurrect-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let state = test_state();
    state
        .closed_builtin_sessions
        .lock()
        .unwrap()
        .insert("resurrect-guard".to_string());

    ensure_backend_for_request(
        &state,
        SessionBackendTarget::Builtin,
        Some("resurrect-guard"),
    );

    assert!(
        !state
            .builtin_sessions
            .lock()
            .unwrap()
            .contains_key("resurrect-guard"),
        "auto-start must not resurrect a closed session"
    );
    let (api_socket, _) = builtin_socket_paths(Some("resurrect-guard"));
    assert!(
        !api_socket.exists(),
        "auto-start must leave no socket behind for a closed session"
    );

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_bad_gateway_on_real_error() {
    // A socket file that exists but refuses connections (not a stale
    // ENOENT row) is a real failure and must surface as 502.
    let path = std::env::temp_dir().join(format!(
        "herdr-webui-test-refused-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    // A regular file is not a socket: connect fails with
    // "Connection refused"/"Socket type not supported", not ENOENT.
    fs::write(&path, b"").unwrap();

    let mut state = test_state();
    state.api_socket = Some(path.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let _ = fs::remove_file(path);
}

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_bad_gateway_when_refused_path_is_not_a_socket() {
    // Linux quirk: connect(2) to a path that is NOT a socket file also
    // returns ECONNREFUSED, identical to a crashed backend's dead
    // listener. A regular file at the socket path is a misconfiguration
    // (real error), so it must surface as 502 even though the error
    // string says "Connection refused". The dead-listener classification
    // gates on the path being an actual socket file; this pins that
    // gate against Linux, where the strings are indistinguishable.
    let path = std::env::temp_dir().join(format!(
        "herdr-webui-test-refused-regular-file-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    fs::write(&path, b"").unwrap();

    let mut state = test_state();
    state.api_socket = Some(path.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let _ = fs::remove_file(path);
}

// ────────────────────────────────────────────────────────────────────
// Flexible fake socket helpers for testing spawn_blocking handlers
// ────────────────────────────────────────────────────────────────────

/// Fake API socket that accepts a request, checks the method, and
/// responds with the given JSON value.  Handles any method (not just
/// "ping" like `fake_api_socket`).
#[cfg(unix)]
fn fake_api_socket_for_method(
    expected_method: &str,
    response: serde_json::Value,
) -> (PathBuf, thread::JoinHandle<()>) {
    let path = std::env::temp_dir().join(format!(
        "herdr-webui-test-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    fake_api_socket_for_method_at(path, expected_method, response)
}

/// Binds the fake API socket at an explicit path instead of temp_dir.
/// Use when the test needs the fake at a location outside temp_dir:
/// rename(2) across filesystems fails with EXDEV (cross-device link)
/// inside sandboxes where TMPDIR and the target dir differ in device.
#[cfg(unix)]
fn fake_api_socket_for_method_at(
    path: PathBuf,
    expected_method: &str,
    response: serde_json::Value,
) -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let expected = expected_method.to_string();
    let handle = thread::spawn(move || {
        let mut stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], expected, "unexpected method");
        stream
            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
            .unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    });
    (path, handle)
}

/// Fake API socket that accepts multiple sequential requests, responding
/// to each with the corresponding value in `responses`.
#[cfg(unix)]
fn fake_api_socket_multi(responses: Vec<serde_json::Value>) -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = std::env::temp_dir().join(format!(
        "herdr-webui-multi-test-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let handle = thread::spawn(move || {
        for resp in responses {
            let mut stream = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            stream
                .write_all(serde_json::to_string(&resp).unwrap().as_bytes())
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        }
    });
    (path, handle)
}

fn authed_request(method: Method, uri: &str) -> axum::http::request::Builder {
    request(method, uri).header(header::COOKIE, "herdr_web_session=token-123")
}

// ── proxy_request_async success + error paths ──

#[cfg(unix)]
#[tokio::test]
async fn agents_handler_proxies_agent_list() {
    let (socket, handle) = fake_api_socket_for_method(
        "agent.list",
        json!({ "id": "web:agent:list", "result": { "agents": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/agents")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["result"]["agents"].is_array());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn agents_handler_returns_bad_gateway_on_socket_error() {
    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-agents-test.sock"));
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/agents")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
}

#[cfg(unix)]
#[tokio::test]
async fn tabs_handler_proxies_tab_list() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.list",
        json!({ "id": "web:tab:list", "result": { "tabs": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/tabs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["result"]["tabs"].is_array());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn panes_handler_proxies_pane_list() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.list",
        json!({ "id": "web:pane:list", "result": { "panes": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["result"]["panes"].is_array());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn pane_layout_handler_proxies_pane_layout() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.layout",
        json!({ "id": "web:pane:layout", "result": { "layout": {} } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/pane-layout")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_handler_proxies_snapshot() {
    let (socket, handle) = fake_api_socket_for_method(
        "session.snapshot",
        json!({ "id": "web:session:snapshot", "result": { "workspaces": [], "tabs": [], "panes": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["result"]["workspaces"].is_array());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn create_workspace_handler_proxies_create() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.create",
        json!({ "id": "web:workspace:create", "result": { "id": "ws1" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let cwd = std::env::temp_dir();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "cwd": cwd.to_string_lossy(), "label": "test" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["id"], "ws1");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// The Actions UI stamps the selected session backend on every create
// call (x-herdr-backend). Creating a workspace while the browser
// targets the built-in backend must proxy workspace.create to the
// built-in session socket (auto-started), never to the external
// default API socket. The fake external socket below fails the test
// if it receives the create request.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn create_workspace_with_builtin_header_routes_to_builtin_backend() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-create-builtin-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // A fake external-herdr API socket that must stay untouched: if the
    // create request were misrouted there, the spawned handler would
    // accept it, reply with an id, and the drop guard below would panic
    // on join because the request never arrived (or the response would
    // carry the external marker label).
    let (external_socket, external_handle) = fake_api_socket_for_method(
        "workspace.create",
        json!({ "id": "web:workspace:create", "result": { "id": "external-ws" } }),
    );
    let session_name = "create-builtin";
    let mut state = test_state();
    state.api_socket = Some(external_socket.clone());
    // Hold a state clone so the shared builtin session registry (and
    // with it the started backend handle) outlives the oneshot request.
    let app = test_app_with_state(state.clone());

    let cwd = std::env::temp_dir();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-herdr-backend", "builtin")
                .header("x-herdr-session", session_name)
                .body(Body::from(
                    json!({ "cwd": cwd.to_string_lossy(), "label": "routing-test" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    // The built-in backend answers workspace.create with a workspace
    // result (id starts with ws_ / has workspace fields), and definitely
    // not the external fake marker.
    let result = body["result"].clone();
    assert!(
        result.get("id").and_then(Value::as_str) != Some("external-ws"),
        "create leaked to the external backend socket: {result}"
    );
    // The built-in backend answers workspace.create with a workspace
    // result: a workspace object (or workspace_id field) is present.
    let created_id = result
        .get("workspace")
        .and_then(|workspace| workspace.get("workspace_id"))
        .or_else(|| result.get("workspace_id"))
        .or_else(|| result.get("id"));
    assert!(
        created_id.is_some(),
        "built-in backend did not return a workspace result: {result}"
    );
    // The built-in session must be running for the answered session.
    let (builtin_api, _) = builtin_socket_paths(Some(session_name));
    assert!(connect_local_stream(&builtin_api).is_ok());

    let _ = fs::remove_dir_all(&config_home);
    let _ = fs::remove_file(&external_socket);
    drop(external_handle);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// Mirrors the above for worktree creation: the Actions UI worktree
// create flow also routes through the selected session backend.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn create_worktree_with_builtin_header_routes_to_builtin_backend() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-wt-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // The worktree create handler performs git checks locally, then
    // proxies the create to the backend. A request without branch/path
    // is rejected early by the built-in backend, but the key assertion
    // is which socket the proxy talks to: seed the external fake socket
    // with a marker reply; if the request lands there, the response
    // leaks the marker.
    let (external_socket, external_handle) = fake_api_socket_for_method(
        "worktree.create",
        json!({ "id": "web:worktree:create", "result": { "id": "external-wt" } }),
    );
    let session_name = "wt1";
    let mut state = test_state();
    state.api_socket = Some(external_socket.clone());
    // Hold a state clone so the started built-in backend outlives the
    // oneshot request (the router is consumed and dropped after it).
    let app = test_app_with_state(state.clone());

    let cwd = std::env::temp_dir().join("herdr-webui-wt-src");
    let _ = fs::create_dir_all(&cwd);
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-herdr-backend", "builtin")
                .header("x-herdr-session", session_name)
                .body(Body::from(
                    json!({ "cwd": cwd.to_string_lossy(), "path": "", "branch": "" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(response).await;
    // Either the built-in backend rejected the empty worktree (fine)
    // or it answered; in both cases the external fake marker must be
    // absent from the response.
    let body_text = body.to_string();
    assert!(
        !body_text.contains("external-wt"),
        "worktree create leaked to the external backend socket: {body_text}"
    );
    let (builtin_api, _) = builtin_socket_paths(Some(session_name));
    assert!(
        connect_local_stream(&builtin_api).is_ok(),
        "built-in session socket missing after worktree create; body: {body_text}; socket: {}",
        builtin_api.display()
    );

    let _ = fs::remove_dir_all(&config_home);
    let _ = fs::remove_file(&external_socket);
    drop(external_handle);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[tokio::test]
async fn rename_workspace_handler_proxies_rename() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.rename",
        json!({ "id": "web:workspace:rename", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces/ws-abc/rename")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "label": "new name" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn close_workspace_handler_proxies_close() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.close",
        json!({ "id": "web:workspace:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces/ws-xyz/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn create_tab_handler_proxies_create() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.create",
        json!({ "id": "web:tab:create", "result": { "id": "tab1" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "workspace_id": "ws1", "label": "tab" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["id"], "tab1");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn rename_tab_handler_proxies_rename() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.rename",
        json!({ "id": "web:tab:rename", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-42/rename")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "label": "renamed" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn close_tab_handler_proxies_close() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.close",
        json!({ "id": "web:tab:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-99/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// Promote proxies the tab id and relays the full result payload (the
// browser navigates from the workspace/tab/pane fields in it). A success
// also records the promoted workspace in recent workspaces, using the
// cwd/label from the result.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn promote_tab_handler_proxies_promote_and_relays_result() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-promote-recent-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&config_home).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let (socket, handle) = fake_api_socket_for_method(
        "tab.promote",
        json!({
            "id": "web:tab:promote",
            "result": {
                "type": "tab_promoted",
                "workspace_created": true,
                "workspace": { "id": "ws-77", "label": "promoted", "cwd": "/repo/promoted" },
                "tab": { "id": "tab-99" },
                "root_pane": { "id": "pane-1" }
            }
        }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state.clone());

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-99/promote")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["type"], "tab_promoted");
    assert_eq!(body["result"]["workspace_created"], true);
    assert_eq!(body["result"]["workspace"]["id"], "ws-77");
    assert_eq!(body["result"]["tab"]["id"], "tab-99");
    assert_eq!(body["result"]["root_pane"]["id"], "pane-1");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    // The tab id was recorded in the promoted-tabs registry so the
    // terminal WS teardown can never auto-close it, even if the release
    // toggle frame was lost.
    assert!(
        state.promoted_temporary_tabs.lock().unwrap().get("tab-99")
            == Some(&PromotedTemporaryTabState::Promoted),
        "promoted tab must be recorded in the promoted-tabs registry"
    );

    // The promoted cwd/label were recorded in recents.
    {
        let guard = state.server_settings.lock().unwrap();
        let recent = &guard.recent_workspaces;
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].path, "/repo/promoted");
        assert_eq!(recent[0].label.as_deref(), Some("promoted"));
        assert_eq!(recent[0].kind.as_deref(), Some("workspace"));
    }
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// A backend error envelope (e.g. same-workspace rejection) must relay
/// the error AND leave the tab closable: the in-flight marker armed by
/// begin_temporary_tab_promote must be decremented back to zero and
/// removed, so the terminal WS teardown auto-closes the tab as usual.
#[cfg(unix)]
#[tokio::test]
async fn promote_tab_handler_failure_restores_closable_state() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.promote",
        json!({
            "id": "web:tab:promote",
            "error": { "code": "builtin_error", "message": "tab tab-98 already runs in workspace ws-1" }
        }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state.clone());

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-98/promote")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(response).await;
    assert_eq!(
        body["error"]["message"],
        "tab tab-98 already runs in workspace ws-1"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    // The guard must be fully released: no marker for this tab remains.
    assert!(
        state
            .promoted_temporary_tabs
            .lock()
            .unwrap()
            .get("tab-98")
            .is_none(),
        "failed promote must remove the in-flight marker so teardown auto-closes again"
    );
}

/// A dead backend socket (daemon stopped mid-call) surfaces BAD_GATEWAY
/// and also restores closable state.
#[cfg(unix)]
#[tokio::test]
async fn promote_tab_handler_backend_failure_restores_closable_state() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.promote",
        json!({ "id": "web:tab:promote", "error": { "code": "builtin_error", "message": "backend socket closed" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state.clone());

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-97/promote")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(response).await;
    assert!(
        body["error"].is_object(),
        "backend failure must relay an error, got {body}"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
    assert!(
        state
            .promoted_temporary_tabs
            .lock()
            .unwrap()
            .get("tab-97")
            .is_none(),
        "backend-failed promote must release the in-flight guard"
    );
}

/// A dead backend socket (removed path) must surface 502 through the
/// route's single Err arm and also release the in-flight guard, exactly
/// like a backend error envelope: connect_local_stream fails before a
/// request is ever written.
#[cfg(unix)]
#[tokio::test]
async fn promote_tab_handler_dead_socket_restores_closable_state() {
    let missing = std::env::temp_dir().join(format!(
        "herdr-webui-promote-missing-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let mut state = test_state();
    state.api_socket = Some(missing.clone());
    let app = test_app_with_state(state.clone());

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-96/promote")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert!(
        body["error"].as_str().is_some_and(|err| !err.is_empty()),
        "dead socket must relay a join-failure error, got {body}"
    );
    assert!(
        state
            .promoted_temporary_tabs
            .lock()
            .unwrap()
            .get("tab-96")
            .is_none(),
        "dead-socket promote must release the in-flight guard"
    );
}

/// A panic inside the spawn_blocking backend call must keep propagating
/// after the join failure is folded: promote_join_failure resumes the
/// original panic payload instead of degrading it to a 502 message.
#[tokio::test]
#[should_panic(expected = "join-panic probe")]
async fn promote_join_failure_propagates_backend_panic() {
    let join = tokio::task::spawn_blocking(|| panic!("join-panic probe"))
        .await
        .unwrap_err();
    promote_join_failure(join);
}

/// A cancelled spawn_blocking task yields a JoinError that is not a
/// panic: promote_join_failure must degrade it to its message string so
/// the route answers 502 and restores auto-close. Built on a runtime
/// whose only blocking thread is parked, so the queued task is still
/// waiting for a pool slot when it is aborted.
#[test]
fn promote_join_failure_degrades_cancelled_task_to_message() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    rt.block_on(async {
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let parked = tokio::task::spawn_blocking(move || {
            let _ = std::sync::mpsc::channel::<()>();
            // Park the only blocking thread until the test is done.
            drop(release_rx);
        });
        let queued = tokio::task::spawn_blocking(|| unreachable!());
        // Yield so `queued` is registered as waiting for the pool, then
        // cancel it before it ever runs.
        tokio::task::yield_now().await;
        queued.abort();
        let join = queued.await.unwrap_err();
        assert!(join.is_cancelled(), "probe task must be cancelled, not run");
        let message = promote_join_failure(join);
        assert!(
            message.contains("cancelled"),
            "join failure must degrade to its message, got {message}"
        );
        let _ = release_tx.send(());
        let _ = parked.await;
    });
}

/// An unauthenticated promote request must be rejected before the route
/// arms the in-flight guard: the registry stays untouched so the tab
/// keeps its normal auto-close semantics.
#[tokio::test]
async fn promote_tab_handler_rejects_unauthenticated() {
    let state = test_state();
    let app = test_app_with_state(state.clone());

    let response = app
        .oneshot(
            request(Method::POST, "/api/tabs/tab-99/promote")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(
        state.promoted_temporary_tabs.lock().unwrap().is_empty(),
        "rejected promote must never arm the in-flight guard"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn close_pane_handler_proxies_close() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.close",
        json!({ "id": "web:pane:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/panes/pane-7/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn remove_worktree_handler_proxies_remove() {
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.remove",
        json!({ "id": "web:worktree:remove", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces/ws-1/worktree-remove")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "force": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
// lock_env() serializes env-mutating tests; held across await on purpose
// so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn open_worktree_handler_proxies_open() {
    let _env = lock_env();
    // The authed open records a recent workspace, which persists server
    // settings; keep that write inside a temp config dir so the real
    // operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-worktree-proxy-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.open",
        json!({ "id": "web:worktree:open", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
            .oneshot(
                authed_request(Method::POST, "/api/worktrees/open")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "workspace_id": "ws1", "cwd": "/tmp", "path": "/tmp/wt", "branch": "main", "label": "wt" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── workspaces handler (two sequential requests + enrich) ──

#[cfg(unix)]
#[tokio::test]
async fn workspaces_handler_proxies_list_and_enriches_cwds() {
    let (socket, handle) = fake_api_socket_multi(vec![
        // workspace.list response
        json!({ "id": "web:workspace:list", "result": { "workspaces": [
            { "workspace_id": "ws1", "label": "workspace one", "cwd": null }
        ]}}),
        // pane.list response for enrichment
        json!({ "id": "web:pane:list:workspace-cwds", "result": { "panes": [
            { "workspace_id": "ws1", "cwd": "/home/user/project", "foreground_cwd": "/home/user/project/src" }
        ]}}),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let ws = &body["result"]["workspaces"][0];
    assert_eq!(ws["workspace_id"], "ws1");
    assert_eq!(ws["cwd"], "/home/user/project");
    assert_eq!(ws["foreground_cwd"], "/home/user/project/src");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn workspaces_handler_returns_bad_gateway_on_error() {
    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-workspaces-test.sock"));
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
}

// ── git_branches handler ──

#[tokio::test]
async fn git_branches_handler_requires_cwd() {
    let app = test_app();

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/git-branches")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["error"], "cwd is required");
}

#[tokio::test]
async fn git_branches_handler_returns_branches_from_repo() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-git-branches-api-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init"
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/test"])
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(
                Method::GET,
                &format!("/api/git-branches?cwd={}", repo.to_string_lossy()),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let branches = body["branches"].as_array().unwrap();
    let names: Vec<&str> = branches.iter().map(|v| v.as_str().unwrap()).collect();
    assert!(names.contains(&"main") || names.contains(&"master"));
    assert!(names.contains(&"feature/test"));

    fs::remove_dir_all(&repo).unwrap();
}

#[tokio::test]
async fn git_branches_handler_returns_error_for_nonexistent_repo() {
    let app = test_app();
    let response = app
        .oneshot(
            authed_request(
                Method::GET,
                "/api/git-branches?cwd=/tmp/nonexistent-git-repo-xyz",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert!(body["error"].as_str().is_some_and(|e| !e.is_empty()));
}

// ── launch_session error paths ──

#[tokio::test]
async fn launch_session_rejects_disabled_backend() {
    let state = test_state();
    // Disable both backends via settings
    if let Ok(mut settings) = state.server_settings.lock() {
        settings.builtin_backend_enabled = false;
        settings.external_herdr_backend_enabled = false;
    }
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"]
        .as_str()
        .is_some_and(|e| e.contains("disabled")));
}

#[cfg(unix)]
fn write_version_script(root: &std::path::Path, version_output: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    let script = root.join("fake-herdr");
    fs::write(&script, format!("#!/bin/sh\necho '{version_output}'\n")).unwrap();
    let mut permissions = fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&script, permissions).unwrap();
    script.display().to_string()
}

#[cfg(unix)]
#[test]
fn detect_herdr_install_classifies_detected_versions() {
    let root = std::env::temp_dir().join(format!(
        "herdr-webui-detect-install-test-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();

    // Compatible install: herdr 0.9.0 (matches the supported range).
    let bin = write_version_script(&root, "herdr 0.9.0");
    let install = detect_herdr_install(&bin);
    assert_eq!(install.version.as_deref(), Some("0.9.0"));
    assert!(install.available());
    assert!(install.compatible);

    // Protocol too old: herdr 0.8.0 must be flagged incompatible.
    let bin = write_version_script(&root, "herdr 0.8.0");
    let install = detect_herdr_install(&bin);
    assert_eq!(install.version.as_deref(), Some("0.8.0"));
    assert!(install.available());
    assert!(!install.compatible);

    // Newer untested release: still offered, matching the versions API.
    let bin = write_version_script(&root, "herdr 0.9.1");
    let install = detect_herdr_install(&bin);
    assert_eq!(install.version.as_deref(), Some("0.9.1"));
    assert!(install.compatible);

    // No version in output: treated as not detected.
    let bin = write_version_script(&root, "hello world");
    let install = detect_herdr_install(&bin);
    assert!(!install.available());

    // Missing binary: not detected.
    let install = detect_herdr_install("/nonexistent/herdr-bin-xyz");
    assert_eq!(install, HerdrInstall::default());

    let _ = fs::remove_dir_all(&root);
}

#[tokio::test]
async fn launch_session_rejects_incompatible_detected_herdr() {
    let root = std::env::temp_dir().join(format!(
        "herdr-webui-launch-compat-test-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let bin = write_version_script(&root, "herdr 0.8.0");

    let mut state = test_state();
    state.herdr_bin = bin;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    let error = body["error"].as_str().unwrap_or_default();
    assert!(error.contains("0.8.0"), "error mentions detected version");
    assert!(
        error.contains("compatible"),
        "error explains incompatibility"
    );

    let _ = fs::remove_dir_all(&root);
}

#[tokio::test]
async fn launch_session_rejects_missing_herdr_install() {
    let mut state = test_state();
    state.herdr_bin = "/nonexistent/herdr-bin-xyz".to_string();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // Now rejected before spawn, instead of BAD_GATEWAY from spawn failure.
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("herdr binary not found"),
        "error explains missing install"
    );
}

#[tokio::test]
async fn launch_session_returns_error_when_herdr_bin_not_found() {
    let mut state = test_state();
    state.herdr_bin = "/nonexistent/herdr-bin-xyz".to_string();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // The install gate rejects before spawn, so this is now a clean
    // BAD_REQUEST with an actionable message instead of BAD_GATEWAY.
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("herdr binary not found"),
        "error explains the missing install"
    );
}

#[cfg(unix)]
fn fake_herdr_version_script() -> String {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!(
        "herdr-webui-launch-test-{}-{}",
        std::process::id(),
        std::thread::current().name().unwrap_or("t")
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let script = root.join("fake-herdr");
    std::fs::write(
        &script,
        "#!/bin/sh\ncase \"$1\" in\n--version) echo 'herdr 0.9.0'; exit 0;;\nesac\nexit 0\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&script, permissions).unwrap();
    script.display().to_string()
}

#[tokio::test]
async fn launch_session_external_succeeds_with_true_command() {
    // A fake herdr reporting a compatible version; any launch args make it
    // exit 0 like /usr/bin/true so the launch handler sees success.
    let mut state = test_state();
    state.herdr_bin = fake_herdr_version_script();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test-launch", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert!(body["pid"].as_u64().is_some());
}

#[tokio::test]
async fn launch_session_default_session_omits_env() {
    let mut state = test_state();
    state.herdr_bin = fake_herdr_version_script();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["session"], "default");
}

// ── close_session builtin backend path ──

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn close_session_builtin_backend_uses_builtin_socket_namespace() {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-close-builtin-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // Compute the socket path that builtin_socket_paths will return
    let session_name = "test-builtin-close";
    let (api_socket, _) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    let _ = fs::remove_file(&api_socket);

    // Create a fake backend listener directly at the builtin socket path
    let name = api_socket.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let saw_stop = std::sync::Arc::new(std::sync::Mutex::new(false));
    let saw_stop_clone = saw_stop.clone();
    let handle = thread::spawn(move || {
        let stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        if request["method"] == "server.stop" {
            *saw_stop_clone.lock().unwrap() = true;
            // Drop the connection without responding, simulating backend shutdown.
            drop(stream);
        }
    });

    let mut state = test_state();
    state.backend_mode = BackendMode::Builtin;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // close_session on a builtin session calls proxy_server_stop which
    // treats connection drop as OK.
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert!(
        *saw_stop.lock().unwrap(),
        "backend should have received server.stop"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(&api_socket);
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[tokio::test]
async fn close_session_rejects_disabled_backend() {
    let state = test_state();
    if let Ok(mut settings) = state.server_settings.lock() {
        settings.external_herdr_backend_enabled = false;
    }
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"]
        .as_str()
        .is_some_and(|e| e.contains("disabled")));
}

// ── update_server_settings save error path ──

#[tokio::test]
async fn update_server_settings_rejects_invalid_bind_address() {
    let app = test_app();

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "bind": "not-a-valid-address", "localhost_no_auth": true }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert!(body["error"]
        .as_str()
        .is_some_and(|e| e.contains("invalid bind")));
}

// ── remove_worktree_path with real git repo ──

#[tokio::test]
async fn remove_worktree_path_handler_removes_worktree_from_repo() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-remove-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());

    // Create a worktree
    let wt_path = repo.with_extension("wt");
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "worktree",
            "add",
            &wt_path.to_string_lossy(),
            "-b",
            "feature"
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(wt_path.exists());

    // Remove it via the handler
    let app = test_app();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees/remove-path")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "repo_root": repo.to_string_lossy(),
                        "path": wt_path.to_string_lossy(),
                        "force": false,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert!(!wt_path.exists());

    fs::remove_dir_all(&repo).unwrap();
}

#[tokio::test]
async fn remove_worktree_path_handler_returns_error_for_nonexistent_path() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-remove-err-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees/remove-path")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "repo_root": repo.to_string_lossy(),
                        "path": "/tmp/nonexistent-worktree-path",
                        "force": false,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert!(body["error"].as_str().is_some_and(|e| !e.is_empty()));

    fs::remove_dir_all(&repo).unwrap();
}

// ── create_worktree Default phase (no branch, proxies to backend) ──

#[cfg(unix)]
#[tokio::test]
async fn create_worktree_default_phase_proxies_to_backend() {
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.create",
        json!({ "id": "web:worktree:create", "result": { "ok": true, "workspace_id": "ws1" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    // No branch specified -> Default phase -> proxies to backend
    let response = app
            .oneshot(
                authed_request(Method::POST, "/api/worktrees")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "workspace_id": "ws1", "cwd": "/tmp", "path": "/tmp/wt", "label": "test" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["workspace_id"], "ws1");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── create_worktree with pull_base error ──

#[tokio::test]
async fn create_worktree_pull_base_error_returns_bad_request() {
    let app = test_app();

    // pull_base=true with a nonexistent cwd should cause git pull to fail
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "cwd": "/tmp/nonexistent-repo-for-pull-base",
                        "path": "/tmp/wt-test",
                        "branch": "feature",
                        "pull_base": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"].as_str().is_some_and(|e| !e.is_empty()));
}

// ── create_worktree with existing branch in a real git repo (NativeCreate or LegacyOpen) ──

#[cfg(unix)]
#[tokio::test]
async fn create_worktree_existing_branch_proxies_to_backend() {
    // Set up a real git repo with an existing branch
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-cwt-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/existing"])
        .output()
        .unwrap()
        .status
        .success());

    // HerdrWorktreeApi::detect sends a ping first, then the handler
    // sends worktree.create.  Use fake_api_socket_multi to handle both.
    let (socket, handle) = fake_api_socket_multi(vec![
        // Response to ping (backend_info detection)
        json!({ "id": "web:ping", "result": { "version": "0.7.1" } }),
        // Response to worktree.create
        json!({ "id": "web:worktree:create", "result": { "ok": true, "workspace_id": "ws-new" } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let wt_path = std::env::temp_dir().join(format!(
        "herdr-webui-wt-path-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "cwd": repo.to_string_lossy(),
                        "path": wt_path.to_string_lossy(),
                        "branch": "feature/existing",
                        "label": "test-wt",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // Should be OK (either NativeCreate or LegacyOpen path, both proxy to backend)
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&wt_path);
}

// ── versions handler with spawn_blocking backend_info ──

#[cfg(unix)]
#[tokio::test]
async fn versions_handler_returns_bad_gateway_on_missing_socket() {
    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-versions-test.sock"));
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/versions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // backend_info returns default (no version, no protocol)
    // and external-herdr mode checks compatibility which should still be OK
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["compatibility"]["compatible"].as_bool().is_some());
}

// ── events_socket: verify backend_info uses spawn_blocking and close on drop ──
// This is hard to test directly because events_socket requires a WebSocket
// upgrade. Instead we test the helper functions it depends on.

#[test]
fn backend_uses_builtin_event_hub_detects_builtin() {
    assert!(backend_uses_builtin_event_hub(&BackendInfo {
        version: Some("builtin-0.8.0".to_string()),
        protocol: Some(16),
    }));
    assert!(!backend_uses_builtin_event_hub(&BackendInfo {
        version: Some("0.7.5".to_string()),
        protocol: Some(15),
    }));
    assert!(!backend_uses_builtin_event_hub(&BackendInfo {
        version: Some("builtin-0.8.0".to_string()),
        protocol: Some(15),
    }));
    assert!(!backend_uses_builtin_event_hub(&BackendInfo {
        version: None,
        protocol: Some(16),
    }));
}

#[test]
fn web_event_kind_extracts_kind_from_wrapped_event() {
    assert_eq!(
        web_event_kind(&json!({ "type": "event", "event": { "event": "workspace.created" } })),
        Some("workspace.created")
    );
    assert_eq!(
        web_event_kind(&json!({ "type": "event", "event": { "type": "tab.closed" } })),
        Some("tab.closed")
    );
    assert_eq!(web_event_kind(&json!({ "type": "snapshot" })), None,);
    assert_eq!(web_event_kind(&json!({ "type": "event" })), None,);
}

// ── server_settings handler POST with successful save (spawn_blocking path) ──

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn update_server_settings_saves_and_returns_updated_settings() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-save-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "127.0.0.1:9999",
                        "username": "user",
                        "password": "pass",
                        "localhost_no_auth": false,
                        "session_expiration_minutes": 30,
                        "no_sleep_auto_cooldown_seconds": 120,
                        "backend_mode": "builtin",
                        "builtin_backend_enabled": true,
                        "external_herdr_backend_enabled": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["bind"], "127.0.0.1:9999");
    assert_eq!(body["no_sleep_auto_cooldown_seconds"], 120);
    assert_eq!(body["session_expiration_minutes"], 30);
    assert_eq!(body["backend_mode"], "builtin");
    assert!(server_settings_path().exists());

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── proxy_server_stop with actual server.stop response (success) ──

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_ok_when_backend_responds_normally() {
    let (socket, handle) = fake_api_socket_for_method(
        "server.stop",
        json!({ "id": "web:server:stop", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["ok"], true);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── launch_session with builtin backend ──

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn launch_session_builtin_backend_starts_session() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-launch-builtin-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    // Enable builtin backend in settings
    if let Ok(mut settings) = state.server_settings.lock() {
        settings.builtin_backend_enabled = true;
        settings.external_herdr_backend_enabled = true;
    }
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test-builtin-launch", "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // Builtin session should start (or already be running) successfully
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["backend"], "builtin");

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── remove_worktree_path with force=true ──

#[tokio::test]
async fn remove_worktree_path_handler_with_force_succeeds() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-force-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    let wt_path = repo.with_extension("wt-force");
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "worktree",
            "add",
            &wt_path.to_string_lossy(),
            "-b",
            "feature-force"
        ])
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees/remove-path")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "repo_root": repo.to_string_lossy(),
                        "path": wt_path.to_string_lossy(),
                        "force": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!wt_path.exists());
    fs::remove_dir_all(&repo).unwrap();
}

// ── proxy_request_async JoinError (panic in spawn_blocking) ──
// This is hard to trigger directly; the error path is covered by
// testing handlers that point to nonexistent sockets, which triggers
// the Err(err) branch in the match.

#[cfg(unix)]
#[tokio::test]
async fn proxy_request_async_handlers_return_bad_gateway_on_missing_socket() {
    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-proxy-async-test.sock"));
    let app = test_app_with_state(state);

    // Test several handlers that use proxy_request_async
    let endpoints: [(&str, Method); 5] = [
        ("/api/agents", Method::GET),
        ("/api/tabs", Method::GET),
        ("/api/panes", Method::GET),
        ("/api/pane-layout", Method::GET),
        ("/api/session-snapshot", Method::GET),
    ];

    for (uri, method) in &endpoints {
        let response = app
            .clone()
            .oneshot(
                authed_request(method.clone(), uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_GATEWAY,
            "endpoint {uri} should return 502"
        );
    }
}

// ── auth rejection for all proxy handlers ──

/// All proxy handlers should reject unauthenticated requests with 401.
#[tokio::test]
async fn proxy_handlers_reject_unauthenticated() {
    let endpoints = [
        ("/api/agents", Method::GET),
        ("/api/tabs", Method::GET),
        ("/api/panes", Method::GET),
        ("/api/pane-layout", Method::GET),
        ("/api/session-snapshot", Method::GET),
        ("/api/workspaces", Method::GET),
        ("/api/git-branches?cwd=.", Method::GET),
    ];

    for (uri, method) in &endpoints {
        let response = test_app()
            .oneshot(request(method.clone(), uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "endpoint {uri} should require auth"
        );
    }
}

/// POST handlers also reject unauthenticated requests.
#[tokio::test]
async fn post_handlers_reject_unauthenticated() {
    let endpoints = [
        ("/api/workspaces", json!({"cwd": ".", "label": "t"})),
        ("/api/workspaces/ws1/rename", json!({"label": "t"})),
        ("/api/workspaces/ws1/close", json!({})),
        ("/api/tabs", json!({"workspace_id": "ws1", "label": "t"})),
        ("/api/tabs/t1/rename", json!({"label": "t"})),
        ("/api/tabs/t1/close", json!({})),
        ("/api/panes/p1/close", json!({})),
        ("/api/worktrees/open", json!({"path": "/tmp"})),
        ("/api/worktrees", json!({"cwd": ".", "path": "/tmp/wt"})),
    ];

    for (uri, body) in &endpoints {
        let response = test_app()
            .oneshot(
                request(Method::POST, uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "endpoint {uri} should require auth"
        );
    }
}

/// session/launch and session/close also reject unauthenticated requests.
#[tokio::test]
async fn session_handlers_reject_unauthenticated() {
    for uri in ["/api/session/launch", "/api/session/close"] {
        let response = test_app()
            .oneshot(
                request(Method::POST, uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "endpoint {uri} should require auth"
        );
    }
}

/// remove_worktree_path rejects unauthenticated requests.
#[tokio::test]
async fn remove_worktree_path_rejects_unauthenticated() {
    let response = test_app()
        .oneshot(
            request(Method::POST, "/api/worktrees/remove-path")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"repo_root": "/tmp", "path": "/tmp/wt"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

/// update_server_settings rejects unauthenticated requests.
#[tokio::test]
async fn update_server_settings_rejects_unauthenticated() {
    // Need a valid body (with bind field) so JSON parsing succeeds,
    // then auth check runs and rejects.
    let response = test_app()
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "127.0.0.1:8080",
                        "localhost_no_auth": false,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// ── proxy_request_async success path ──

#[cfg(unix)]
#[tokio::test]
async fn agents_handler_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "agent.list",
        json!({ "id": "web:agent:list", "result": { "agents": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/agents")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body.get("result").is_some());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn tabs_handler_proxies_with_workspace_id() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.list",
        json!({ "id": "web:tab:list", "result": { "tabs": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/tabs?workspace_id=ws1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "session.snapshot",
        json!({ "id": "web:session:snapshot", "result": { "workspaces": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── proxy_server_stop with normal response (not connection drop) ──

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_backend_response_on_normal_stop() {
    let (socket, handle) = fake_api_socket_for_method(
        "server.stop",
        json!({ "id": "web:server:stop", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["ok"], true);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── create_worktree LegacyOpen path ──
// When backend version < 0.7.1 and branch exists, it does local checkout
// then proxies worktree.open

#[cfg(unix)]
#[tokio::test]
async fn create_worktree_legacy_open_for_old_backend() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-legacy-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/legacy"])
        .output()
        .unwrap()
        .status
        .success());

    let wt_path = std::env::temp_dir().join(format!(
        "herdr-webui-wt-legacy-path-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    // Old backend (version 0.7.0) -> needs legacy existing branch create
    // The handler sends ping (detect), then worktree.open after local checkout
    let (socket, handle) = fake_api_socket_multi(vec![
        // ping response - old version so it uses legacy path
        json!({ "id": "web:ping", "result": { "version": "0.7.0" } }),
        // worktree.open response
        json!({ "id": "web:worktree:open", "result": { "ok": true, "workspace_id": "ws-legacy" } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "cwd": repo.to_string_lossy(),
                        "path": wt_path.to_string_lossy(),
                        "branch": "feature/legacy",
                        "label": "legacy-wt",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&wt_path);
}

// ── git_branches with actual git repo ──

#[tokio::test]
async fn git_branches_handler_returns_branches_for_real_repo() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-git-branches-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/test"])
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(
                Method::GET,
                &format!("/api/git-branches?cwd={}", repo.to_string_lossy()),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let branches = body["branches"].as_array().unwrap();
    assert!(
        branches.iter().any(|b| b.as_str() == Some("feature/test")),
        "expected feature/test in branches: {branches:?}"
    );
    let _ = fs::remove_dir_all(&repo);
}

// ── git_branches with remote fetch (error path) ──

#[tokio::test]
async fn git_branches_handler_with_remote_fetch_returns_error() {
    // git fetch --all on a repo with no remote succeeds (exit 0),
    // so the handler should return 200 with branch list.
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-git-remote-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(
                Method::GET,
                &format!(
                    "/api/git-branches?cwd={}&remote=true&fetch=true",
                    repo.to_string_lossy()
                ),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    // git fetch --all with no remote succeeds, so we get 200 with branches
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "git fetch on repo with no remote should succeed"
    );
    let body = response_json(response).await;
    assert!(body["branches"].as_array().is_some());
    let _ = fs::remove_dir_all(&repo);
}

// ── proxy_request_async JoinError path ──
// Hard to trigger in tests (requires runtime shutdown), so we rely on
// the missing-socket tests which exercise Ok(Err(socket_err)).

// ── workspaces handler with pane.list failure ──
// When pane.list fails, the handler should still return workspace.list
// result without enrichment (graceful degradation).

#[cfg(unix)]
#[tokio::test]
async fn workspaces_handler_returns_list_even_when_pane_list_fails() {
    // workspace.list succeeds but pane.list fails (connection reset)
    // The handler uses the same socket for both, so the second request
    // will fail after the first succeeds. Use multi with only one response.
    let (socket, handle) = fake_api_socket_multi(vec![
        // Only workspace.list response; pane.list will fail
        json!({ "id": "web:workspace:list", "result": { "workspaces": [
            { "workspace_id": "ws1", "label": "test", "cwd": "/tmp" }
        ]}}),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // Should still be OK since workspace.list succeeded
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body.get("result").is_some());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── create_workspace success path ──

#[cfg(unix)]
#[tokio::test]
async fn create_workspace_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.create",
        json!({ "id": "web:workspace:create", "result": { "workspace_id": "ws-new" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "cwd": "/tmp", "label": "test-ws" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["workspace_id"], "ws-new");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── rename_workspace success path ──

#[cfg(unix)]
#[tokio::test]
async fn rename_workspace_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.rename",
        json!({ "id": "web:workspace:rename", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces/ws1/rename")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "label": "renamed" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── close_workspace success path ──

#[cfg(unix)]
#[tokio::test]
async fn close_workspace_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.close",
        json!({ "id": "web:workspace:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces/ws1/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── create_tab success path ──

#[cfg(unix)]
#[tokio::test]
async fn create_tab_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.create",
        json!({ "id": "web:tab:create", "result": { "tab_id": "tab-new" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "workspace_id": "ws1", "label": "tab1" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── close_tab success path ──

#[cfg(unix)]
#[tokio::test]
async fn close_tab_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.close",
        json!({ "id": "web:tab:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/t1/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── close_pane success path ──

#[cfg(unix)]
#[tokio::test]
async fn close_pane_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.close",
        json!({ "id": "web:pane:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/panes/p1/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── open_worktree success path ──

// lock_env() serializes env-mutating tests; held across await on purpose
// so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[cfg(unix)]
#[tokio::test]
async fn open_worktree_proxies_successfully() {
    let _env = lock_env();
    // The authed open records a recent workspace, which persists server
    // settings; keep that write inside a temp config dir so the real
    // operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-worktree-success-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.open",
        json!({ "id": "web:worktree:open", "result": { "ok": true, "workspace_id": "ws-wt" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees/open")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "path": "/tmp/test-wt", "label": "wt1" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── pane_layout success path ──

#[cfg(unix)]
#[tokio::test]
async fn pane_layout_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.layout",
        json!({ "id": "web:pane:layout", "result": { "layout": {} } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/pane-layout?pane_id=p1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── panes success path ──

#[cfg(unix)]
#[tokio::test]
async fn panes_handler_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.list",
        json!({ "id": "web:pane:list", "result": { "panes": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes?workspace_id=ws1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── rename_tab success path ──

#[cfg(unix)]
#[tokio::test]
async fn rename_tab_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.rename",
        json!({ "id": "web:tab:rename", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/t1/rename")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "label": "renamed" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── create_worktree legacy checkout error ──
// When the worktree path already exists, git worktree add fails.

#[cfg(unix)]
#[tokio::test]
async fn create_worktree_legacy_checkout_error_on_existing_path() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-err-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/err-test"])
        .output()
        .unwrap()
        .status
        .success());

    // Pre-create the worktree path with content so git worktree add fails
    let wt_path = std::env::temp_dir().join(format!(
        "herdr-webui-wt-err-path-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&wt_path).unwrap();
    fs::write(wt_path.join("existing.txt"), "content").unwrap();

    // Old backend so it uses legacy path
    let (socket, handle) = fake_api_socket_multi(vec![
        json!({ "id": "web:ping", "result": { "version": "0.7.0" } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "cwd": repo.to_string_lossy(),
                        "path": wt_path.to_string_lossy(),
                        "branch": "feature/err-test",
                        "label": "err-wt",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // git worktree add fails because path exists, should be 400
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"].as_str().is_some());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&wt_path);
}

// ── remove_worktree_path git command error ──

#[tokio::test]
async fn remove_worktree_path_returns_error_on_git_failure() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-rm-err-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    // Try to remove a non-existent worktree path
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees/remove-path")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "repo_root": repo.to_string_lossy(),
                        "path": "/nonexistent/worktree/path/xyz",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert!(body["error"].as_str().is_some());
    let _ = fs::remove_dir_all(&repo);
}

// ── versions handler with actual socket ──

#[cfg(unix)]
#[tokio::test]
async fn versions_handler_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "ping",
        json!({ "id": "web:ping", "result": { "version": "0.7.2", "protocol": 16 } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/versions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body.get("backend").is_some());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── builtin auto-start on workspace requests ──
// A browser pinning the built-in backend before any /api/session/launch
// used to get a 502 on every workspace list (the built-in session was
// never started), which made the Git UI fall back to the default folder.
// The workspaces handler must auto-start the built-in session instead.

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn workspaces_auto_starts_builtin_session() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-auto-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let session_name = "test-builtin-auto";
    // Hold a state clone so the shared builtin_sessions registry (and
    // with it the started backend handle) outlives the oneshot request:
    // oneshot consumes the router and would otherwise drop the handle
    // and tear the session down before we can verify it.
    let state = test_state();
    let app = test_app_with_state(state.clone());

    // No session launch: the request itself must start the backend.
    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/workspaces")
                .header("x-herdr-backend", "builtin")
                .header("x-herdr-session", session_name)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["result"]["workspaces"].is_array());

    // The built-in session must now be running and reachable: the
    // response came from it (no 502), and the api socket accepts
    // connections even for a fresh registry view.
    let (api_socket, _) = builtin_socket_paths(Some(session_name));
    assert!(connect_local_stream(&api_socket).is_ok());

    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// A fresh browser fires several workspace requests at once; concurrent
// auto-starts of the same built-in session must not race on the socket
// bind. Every caller must succeed (or find the session already running).
#[cfg(unix)]
#[test]
fn concurrent_ensure_builtin_session_starts_session_once() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-race-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let session_name = "test-builtin-race";
    let state = test_state();
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let mut handles = Vec::new();
    for _ in 0..8 {
        let state = state.clone();
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            ensure_builtin_session(&state, Some(session_name))
        }));
    }
    for handle in handles {
        assert!(handle.join().unwrap().is_ok());
    }

    let (api_socket, _) = builtin_socket_paths(Some(session_name));
    assert!(connect_local_stream(&api_socket).is_ok());

    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// versions must expose the server's true configured default backend so
// fresh browsers adopt it; current_backend only echoes the request
// header and cannot drive that choice.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn versions_reports_default_backend_independent_of_request_header() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-versions-default-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // Bind the fake ping listener at the built-in default session path:
    // the request targets the built-in backend, so that is the socket
    // versions actually pings. Bind it there directly instead of
    // moving a temp-dir socket with rename(), which fails with EXDEV
    // when temp_dir and the socket dir are on different filesystems.
    let (api_socket, _) = builtin_socket_paths(None);
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    let (_, handle) = fake_api_socket_for_method_at(
        api_socket.clone(),
        "ping",
        json!({ "id": "web:ping", "result": { "version": "0.9.0", "protocol": 22 } }),
    );

    let mut state = test_state();
    // Server configured external-herdr while the browser pins builtin.
    state.backend_mode = BackendMode::ExternalHerdr;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/versions")
                .header("x-herdr-backend", "builtin")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["current_backend"], "builtin");
    assert_eq!(body["default_backend"], "external-herdr");
    handle.join().unwrap();
    let _ = fs::remove_file(&api_socket);
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// The herdr_error frame must name the backend the server actually
/// resolved for the attach, not the browser's stale pin: when a tab
/// pins external-herdr after the setting was disabled, the server
/// reroutes to builtin and the frame says builtin.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn terminal_ws_herdr_error_reports_resolved_backend() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-terminal-backend-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let mut state = test_state();
    // External-herdr is disabled: a browser pinning it gets rerouted to
    // the built-in backend. Block the built-in session start (directory
    // at the api socket path makes bind fail, per the launch_session
    // error-path test) so the attach fails with connect_failed.
    state
        .server_settings
        .lock()
        .unwrap()
        .external_herdr_backend_enabled = false;
    state.backend_mode = BackendMode::Builtin;
    let (api_socket, client_socket) = builtin_socket_paths(None);
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    fs::create_dir_all(client_socket.parent().unwrap()).unwrap();
    let _ = fs::remove_file(&api_socket);
    fs::create_dir(&api_socket).unwrap();
    let app = test_app_with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let url = format!("ws://{addr}/ws/terminal?terminal_id=t1&backend=external-herdr");
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(request)
        .await
        .expect("Failed to connect to WebSocket");

    let mut got_error_frame = false;
    for _ in 0..30 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        // The attach failure is surfaced twice: the raw error text as a
        // binary frame, then the structured herdr_error JSON. Both travel
        // one ordered channel, so the JSON always follows the raw text.
        let Ok(text) = msg.to_text() else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            continue;
        };
        if value["type"].as_str() == Some("herdr_error") {
            // The resolved backend is builtin: the disabled external pin
            // must not leak into the frame.
            assert_eq!(value["backend"], "builtin");
            assert_eq!(value["kind"], "connect_failed");
            got_error_frame = true;
            break;
        }
    }
    assert!(
        got_error_frame,
        "herdr_error frame with resolved backend must reach the terminal socket"
    );

    server_handle.abort();
    let _ = fs::remove_dir(&api_socket);
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── events WebSocket upgrade test ──
// The events_ws handler requires a proper WebSocket upgrade request.
// Testing the full event loop requires a real WebSocket client and
// is beyond the scope of unit tests. The events_socket code is
// exercised via integration tests with a running backend.

/// events_ws rejects unauthenticated requests.
#[tokio::test]
async fn events_ws_rejects_unauthenticated() {
    // Without auth cookie, the handler should reject even WebSocket
    // upgrade requests. Axum's WebSocketUpgrade extractor runs first,
    // so without proper WS headers we get 400, but with proper WS
    // headers and no auth we'd get 401. Test the auth rejection path.
    let response = test_app()
        .oneshot(
            request(Method::GET, "/ws/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // Without proper WS upgrade headers, Axum returns 400
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

// ── launch_session builtin Ok(Err) path ──
// ensure_builtin_session fails when BuiltinBackendHandle::start fails.
// We trigger this by pre-creating a regular file at the builtin socket path
// so bind_local_listener fails.

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn launch_session_builtin_returns_error_on_socket_bind_failure() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-launch-err-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let session_name = "test-builtin-err";
    let (api_socket, client_socket) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    fs::create_dir_all(client_socket.parent().unwrap()).unwrap();

    // Create a directory at the api_socket path.
    // prepare_socket_path() calls fs::remove_file(path) which fails on
    // directories (ErrorKind::Other or IsADirectory), causing start() to
    // return an io::Error.
    let _ = fs::remove_file(&api_socket);
    fs::create_dir(&api_socket).unwrap();

    let mut state = test_state();
    state.backend_mode = BackendMode::Builtin;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // ensure_builtin_session fails because socket is already bound
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"].as_str().is_some());

    let _ = fs::remove_dir(&api_socket);
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── remove_worktree_path Ok(Err) path ──
// The Ok(Err(err)) path triggers when `Command::new("git").output()` fails
// to spawn (git binary not found). This requires modifying global PATH
// which would break parallel tests that also use git subprocesses.
// Skipping this path.

// ── git_branches Ok(Err) path (git not found) ──
// Same issue as remove_worktree_path: requires modifying global PATH.
// Skipping this path.

// ── launch_session external spawn Ok(Err) path ──
// We set XDG_CONFIG_HOME to a path where the settings file can't be written
// (parent dir is a regular file, not a directory).

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn update_server_settings_returns_error_on_save_failure() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-save-err-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    // Create config_home as a regular FILE, not a directory.
    // server_settings_path() will be config_home/herdr-webui/webui-settings.json
    // and fs::create_dir_all will fail because config_home is a file.
    std::fs::write(&config_home, "not a directory").unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "127.0.0.1:8080",
                        "localhost_no_auth": false,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert!(body["error"].as_str().is_some());

    let _ = fs::remove_file(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── git_branches Ok(Err) path (git not found) ──
// Same issue as remove_worktree_path: requires clearing PATH which breaks
// parallel tests. The Ok(Err) path is already covered by other error tests
// that trigger non-zero exit status. Skip this specific path.

// ── launch_session external spawn Ok(Err) path ──
// Command::new(herdr_bin).spawn() fails when herdr_bin is not on PATH
// and PATH is empty. But we use a full path so this doesn't apply.
// Instead, use a binary that exists but can't be spawned (e.g., /dev/null).

#[cfg(unix)]
#[tokio::test]
async fn launch_session_external_returns_error_on_spawn_failure() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!(
        "herdr-webui-spawn-fail-test-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    // A binary that exists and reports a compatible version, but loses
    // execute permission between detection and launch: spawn() fails.
    let script = root.join("fake-herdr");
    std::fs::write(
        &script,
        "#!/bin/sh\ncase \"$1\" in\n--version) echo 'herdr 0.9.0'; exit 0;;\nesac\nexit 0\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o644);
    std::fs::set_permissions(&script, permissions).unwrap();
    let mut state = test_state();
    state.herdr_bin = script.display().to_string();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test-spawn-err", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // Not executable: detection cannot run it, so the install gate
    // rejects with an actionable error before any spawn is attempted.
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"].as_str().is_some());
    let _ = std::fs::remove_dir_all(&root);
}

// ── LSP API tests ──

async fn lsp_post(
    app: &axum::Router,
    uri: &str,
    payload: serde_json::Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            authed_request(Method::POST, uri)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    (status, response_json(response).await)
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn lsp_config_api_reports_and_updates_settings() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-lsp-config-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    let app = test_app_with_state(state);

    let initial = app
        .clone()
        .oneshot(
            authed_request(Method::GET, "/api/lsp/config")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(initial.status(), StatusCode::OK);
    let initial_body = response_json(initial).await;
    assert_eq!(initial_body["settings"]["enabled"], false);
    assert!(initial_body["languages"]
        .as_array()
        .is_some_and(|langs| langs.iter().any(|l| l == "json")));

    let (status, updated) = lsp_post(
        &app,
        "/api/lsp/config",
        json!({
            "settings": {
                "enabled": true,
                "servers": {
                    "json": {
                        "enabled": true,
                        "command": "vscode-json-language-server",
                        "args": ["--stdio"]
                    }
                }
            }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["settings"]["enabled"], true);
    assert_eq!(
        updated["settings"]["servers"]["json"]["command"],
        "vscode-json-language-server"
    );

    // Rejected: unknown language.
    let (status, rejected) = lsp_post(
        &app,
        "/api/lsp/config",
        json!({
            "settings": {
                "enabled": true,
                "servers": {
                    "cobol": { "enabled": true, "command": "cobol-ls", "args": [] }
                }
            }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(rejected["error"].as_str().is_some());
}

#[tokio::test]
async fn lsp_start_rejects_unconfigured_language() {
    let state = test_state();
    let app = test_app_with_state(state);
    let (status, body) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "json", "cwd": std::env::temp_dir().to_string_lossy() }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "language servers are disabled");
}

#[tokio::test]
async fn lsp_request_rejects_disallowed_method() {
    let state = test_state();
    let app = test_app_with_state(state);
    let (status, _) = lsp_post(
        &app,
        "/api/lsp/request",
        json!({
            "language": "json",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "method": "workspace/executeCommand",
            "params": {}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn lsp_status_reports_running_servers() {
    let state = test_state();
    let app = test_app_with_state(state);
    let response = app
        .clone()
        .oneshot(
            authed_request(Method::GET, "/api/lsp/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["servers"].as_array().is_some());
}

#[tokio::test]
async fn lsp_apis_require_auth() {
    let state = test_state();
    let app = test_app_with_state(state);
    for (uri, method) in [
        ("/api/lsp/config", Method::GET),
        ("/api/lsp/detect", Method::GET),
        ("/api/lsp/status", Method::GET),
        ("/api/lsp/notifications", Method::GET),
    ] {
        let response = app
            .clone()
            .oneshot(request(method, uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
    }
    for uri in [
        ("/api/lsp/config", json!({ "settings": {} })),
        (
            "/api/lsp/start",
            json!({ "language": "json", "cwd": "/tmp" }),
        ),
        (
            "/api/lsp/request",
            json!({ "language": "json", "cwd": "/tmp", "method": "initialize" }),
        ),
        (
            "/api/lsp/notify",
            json!({ "language": "json", "cwd": "/tmp", "method": "initialized" }),
        ),
        ("/api/lsp/stop", json!({})),
    ] {
        let response = app
            .clone()
            .oneshot(
                request(Method::POST, uri.0)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(uri.1.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{}", uri.0);
    }
}

// ── create_worktree spawn_blocking JoinError path ──
// The JoinError path (lines 3161-3166) triggers when the spawn_blocking
// task itself panics. We can't easily trigger this, but the
// unwrap_or_else catches it and returns an error response.

// ── events_socket WebSocket test ──
// We test the events_socket by creating a real TCP server with the axum
// app, connecting via tokio-tungstenite, and verifying events are forwarded.

#[cfg(unix)]
#[tokio::test]
async fn events_socket_sends_ready_and_forwards_events() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    // Create a fake backend socket that responds to ping and
    // accepts events.subscribe, then sends one event and closes.
    let (socket, _handle) = fake_api_socket_events_streaming();
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    // Start a real TCP server
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    // Connect via WebSocket with auth cookie
    let url = format!("ws://{addr}/ws/events");
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(request)
        .await
        .expect("Failed to connect to WebSocket");

    // Collect messages: we expect "ready", "event", and "snapshot" (in any order).
    // The interval timer fires immediately, so "snapshot" can arrive before "ready".
    let mut got_ready = false;
    let mut got_event = false;
    let mut got_snapshot = false;

    for _ in 0..30 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            _ => break, // timeout, stream closed, or error
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        match value["type"].as_str() {
            Some("ready") => got_ready = true,
            Some("event") => {
                assert_eq!(value["event"]["type"], "workspace.created");
                got_event = true;
            }
            Some("snapshot") => got_snapshot = true,
            _ => {}
        }
        if got_ready && got_event && got_snapshot {
            break;
        }
    }

    assert!(got_ready, "did not receive ready message");
    assert!(got_event, "did not receive event message");
    assert!(
        got_snapshot,
        "did not receive snapshot message from interval poll"
    );

    // The fake socket thread may still be accepting connections.
    // Don't join it - just abort the server and clean up.
    server_handle.abort();
    let _ = fs::remove_file(socket);
}

/// Fake API socket that responds to ping, accepts events.subscribe,
/// and streams a "ready" event followed by one test event.
#[cfg(unix)]
#[cfg(unix)]
#[tokio::test]
async fn events_socket_forwards_lsp_diagnostics_push() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    // C1: lsp.diagnostics published on the registry must reach /ws/events
    // subscribers as {type:"event", event:{type:"lsp.diagnostics"}}.
    let (socket, _handle) = fake_api_socket_events_streaming();
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let lsp = state.lsp.clone();
    let app = test_app_with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let url = format!("ws://{addr}/ws/events");
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(request)
        .await
        .expect("Failed to connect to WebSocket");

    // Give the socket loop a moment to enter select! before publishing.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    lsp.publish_diagnostics_for_test(lsp::LspDiagnosticsEvent {
            language: "rust".to_string(),
            root: "/tmp/repo".to_string(),
            notification: json!({
                "method": "textDocument/publishDiagnostics",
                "params": {
                    "uri": "file:///tmp/repo/src/main.rs",
                    "diagnostics": [
                        { "range": { "start": { "line": 3, "character": 0 } }, "severity": 1, "message": "pushed!" }
                    ]
                }
            }),
        });

    let mut got_push = false;
    for _ in 0..30 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        if value["type"].as_str() == Some("event") {
            let event = &value["event"];
            if event["type"].as_str() == Some("lsp.diagnostics")
                || event["event"].as_str() == Some("lsp.diagnostics")
            {
                let data = &event["data"];
                assert_eq!(data["language"], "rust");
                assert_eq!(data["root"], "/tmp/repo");
                assert_eq!(
                    data["notification"]["params"]["diagnostics"][0]["message"],
                    "pushed!"
                );
                got_push = true;
                break;
            }
        }
    }
    assert!(
        got_push,
        "lsp.diagnostics push must reach the events socket"
    );
    server_handle.abort();
}

/// Saving server settings must broadcast `server_settings_changed` with
/// the new `enabled_backends` to every connected events socket, so open
/// tabs stop targeting/offering a backend disabled mid-session without
/// a page reload.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn events_socket_broadcasts_server_settings_changed() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-settings-broadcast-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let (socket, _handle) = fake_api_socket_events_streaming();
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let state = Arc::new(state);
    let app = test_app_with_state((*state).clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    let server_handle = tokio::spawn(async move {
        let _ = server_state;
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let url = format!("ws://{addr}/ws/events");
    let ws_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(ws_request)
        .await
        .expect("Failed to connect to WebSocket");

    // Wait for the events loop to subscribe before flipping settings.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // Disable the external-herdr backend through the settings API. The app
    // router clones the Arc-based WebState, so this POST shares the same
    // settings_tx the events socket subscribed to.
    let save = test_app_with_state((*state).clone())
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "127.0.0.1:8787",
                        "username": "user",
                        "password": "pass",
                        "localhost_no_auth": true,
                        "backend_mode": "builtin",
                        "builtin_backend_enabled": true,
                        "external_herdr_backend_enabled": false,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(save.status(), StatusCode::OK);

    // The events socket must receive the broadcast frame.
    let mut got_settings_change = false;
    for _ in 0..30 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        if value["type"].as_str() == Some("server_settings_changed") {
            assert_eq!(value["enabled_backends"]["builtin"], true);
            assert_eq!(value["enabled_backends"]["external-herdr"], false);
            // The frame carries the server's default backend so tabs
            // retarget accurately without a /api/versions poll.
            assert_eq!(value["default_backend"], "builtin");
            got_settings_change = true;
            break;
        }
    }
    assert!(
        got_settings_change,
        "server_settings_changed frame must reach the events socket"
    );

    server_handle.abort();
    let _ = fs::remove_file(socket);
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// A tab pinned to external-herdr has its events socket bound to that
/// backend (`?backend=external-herdr`). When the external daemon is not
/// running, the backend subscription fails — but the socket ALSO carries
/// server-level frames (`server_settings_changed`). It must stay open and
/// keep retrying the subscription, otherwise the one-shot settings
/// broadcast lands in a reconnect gap and a tab stays pinned to a backend
/// disabled in settings (this exact regression was caught by the
/// session-ux e2e suite).
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn events_socket_survives_backend_subscription_failure() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-events-dead-backend-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let mut state = test_state();
    // Point external-herdr at a socket path with NO listener: the
    // events.subscribe request fails, like a dead external daemon.
    state.api_socket = Some(std::env::temp_dir().join(format!(
                "herdr-webui-dead-external-{}.sock",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )));
    let state = Arc::new(state);
    let app = test_app_with_state((*state).clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    let server_handle = tokio::spawn(async move {
        let _ = server_state;
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    // Bind the events socket to the dead external backend, as a pinned
    // browser tab does.
    let url = format!("ws://{addr}/ws/events?backend=external-herdr");
    let ws_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(ws_request)
        .await
        .expect("Failed to connect to WebSocket");

    // The subscription failure surfaces as an error frame, but the
    // socket must stay open (no close frame).
    let mut saw_error = false;
    let mut saw_settings_change = false;
    for _ in 0..10 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(10), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            Ok(None) => break, // socket closed by server = the bug
            Ok(Some(Err(_))) | Err(_) => break,
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        match value["type"].as_str() {
            Some("error") => {
                saw_error = true;
                // Settings broadcast must still arrive while the socket
                // retries the subscription.
                let save = test_app_with_state((*state).clone())
                    .oneshot(
                        request(Method::POST, "/api/server-settings")
                            .header(header::COOKIE, "herdr_web_session=token-123")
                            .header(header::CONTENT_TYPE, "application/json")
                            .body(Body::from(
                                json!({
                                    "bind": "127.0.0.1:8787",
                                    "username": "user",
                                    "password": "pass",
                                    "localhost_no_auth": true,
                                    "backend_mode": "builtin",
                                    "builtin_backend_enabled": true,
                                    "external_herdr_backend_enabled": false,
                                })
                                .to_string(),
                            ))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(save.status(), StatusCode::OK);
            }
            Some("server_settings_changed") => {
                assert_eq!(value["enabled_backends"]["external-herdr"], false);
                saw_settings_change = true;
                break;
            }
            _ => {}
        }
    }
    assert!(
        saw_error,
        "subscription failure must surface as an error frame"
    );
    assert!(
        saw_settings_change,
        "server_settings_changed must reach a tab whose backend subscription failed"
    );

    server_handle.abort();
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

fn fake_api_socket_events_streaming() -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = std::env::temp_dir().join(format!(
        "herdr-webui-events-test-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();

    let handle = thread::spawn(move || {
        // Accept connections in a loop and handle each on a separate thread
        // so the subscribe stream stays alive while poll requests are served.
        for _ in 0..20 {
            let Ok(mut stream) = listener.accept() else {
                break;
            };
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let request: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
                let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
                let id = request.get("id").cloned().unwrap_or(json!("web:poll"));
                match method {
                    "ping" => {
                        let _ = stream.write_all(
                                json!({ "id": "web:ping", "result": { "version": "0.7.2", "protocol": 16 } })
                                    .to_string()
                                    .as_bytes(),
                            );
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                    }
                    "events.subscribe" => {
                        // Send the response line for subscribe
                        let _ = stream.write_all(
                            json!({ "id": "web:events", "result": { "ok": true } })
                                .to_string()
                                .as_bytes(),
                        );
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                        // Stream one event as newline-delimited JSON
                        let _ = stream.write_all(
                                json!({ "type": "workspace.created", "data": { "workspace_id": "ws1" } })
                                    .to_string()
                                    .as_bytes(),
                            );
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                        // Keep the stream alive so the WebSocket loop doesn't end
                        // immediately. The interval timer will fire and send snapshots.
                        thread::sleep(std::time::Duration::from_secs(10));
                    }
                    "agent.list" => {
                        let _ = stream.write_all(
                            json!({ "id": id, "result": { "agents": [] } })
                                .to_string()
                                .as_bytes(),
                        );
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                    }
                    "workspace.list" => {
                        let _ = stream.write_all(
                            json!({ "id": id, "result": { "workspaces": [] } })
                                .to_string()
                                .as_bytes(),
                        );
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                    }
                    _ => {
                        let _ = stream
                            .write_all(json!({ "id": id, "result": {} }).to_string().as_bytes());
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                    }
                }
            });
        }
    });
    (path, handle)
}

#[cfg(unix)]
// lock_env() serializes env-mutating tests; held across await on purpose
// so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn cleanup_sessions_removes_stale_builtin_dirs_and_keeps_default_and_running() {
    // Three built-in session directories: a stale one (dead-listener
    // socket, the crash leftover), the default slot (always kept), and a
    // running one (live listener, kept). Plus a non-session directory that
    // must never be touched.
    let _guard = lock_env();
    let config_home = PathBuf::from(format!(
        "/tmp/hw-cleanup-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let stale_name = "stale-session";
    let running_name = "running-session";
    let (stale_api, _) = builtin_socket_paths(Some(stale_name));
    let (running_api, _) = builtin_socket_paths(Some(running_name));
    let (default_api, _) = builtin_socket_paths(Some("default"));
    for dir in [
        stale_api.parent(),
        running_api.parent(),
        default_api.parent(),
    ] {
        fs::create_dir_all(dir.unwrap()).unwrap();
    }
    // Dead-listener socket: bound then dropped, exactly what a crashed
    // backend leaves behind.
    {
        let listener = std::os::unix::net::UnixListener::bind(&stale_api).unwrap();
        drop(listener);
    }
    let running_listener = std::os::unix::net::UnixListener::bind(&running_api).unwrap();
    // Not a session slot (not canonical name output).
    fs::create_dir_all(config_home.join("builtin/keep-not-a-session")).unwrap();

    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/cleanup")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "backend": "builtin" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["removed_count"], 1);
    assert_eq!(body["removed"][0], stale_name);
    assert!(
        !stale_api.parent().unwrap().exists(),
        "stale session directory must be removed"
    );
    assert!(
        running_api.parent().unwrap().exists(),
        "running session directory must be kept"
    );
    assert!(
        default_api.parent().unwrap().exists(),
        "default session directory must be kept"
    );
    assert!(
        config_home.join("builtin/keep-not-a-session").exists(),
        "non-session directories must be untouched"
    );
    drop(running_listener);
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn cleanup_sessions_removes_session_even_when_registry_pins_it_closed() {
    // A closed session is in closed_builtin_sessions; cleanup must remove
    // that marker too, otherwise the directory is gone but the marker keeps
    // telling the server the session was explicitly closed (harmless but
    // stale state, and it would resurrect in a fresh process if the socket
    // path somehow reappeared).
    let _guard = lock_env();
    let config_home = PathBuf::from(format!(
        "/tmp/hw-cleanup-marker-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let session_name = "closed-marker-session";
    let (api_socket, _) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    // Long XDG prefixes push the session socket path past sun_path, so the
    // sockets live in the hashed fallback dir; the sessions list directory
    // stays at <config>/herdr-webui/builtin. Recreate the canonical session
    // directory there too, matching what the real discovery/launch flow
    // leaves behind.
    let session_dir = server_settings_path()
        .parent()
        .unwrap()
        .join("builtin")
        .join(session_name);
    fs::create_dir_all(&session_dir).unwrap();

    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    state
        .closed_builtin_sessions
        .lock()
        .unwrap()
        .insert(session_name.to_string());
    let closed_marker = state.closed_builtin_sessions.clone();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/cleanup")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "backend": "builtin" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["removed_count"], 1);
    assert!(
        !closed_marker.lock().unwrap().contains(session_name),
        "cleanup must clear the closed-session marker for removed sessions"
    );
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn cleanup_sessions_rejects_non_builtin_backend() {
    let app = test_app_with_state(test_state());
    let response = app
        .oneshot(
            request(Method::POST, "/api/session/cleanup")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
}
