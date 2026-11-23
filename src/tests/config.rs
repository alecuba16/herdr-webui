//! Config parsing, TLS modes, protocol framing, socket path derivation, no-sleep.

use super::common::*;
use super::*;
use crate::tests::{env_lock, lock_env};

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
    assert!(text.contains("herdr-webui set-password"));
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
    assert!(raw.contains("password_hash"));
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
        password: Some(crate::password_hashing::hash_password("test-password").unwrap()),
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
    assert!(
        crate::password_hashing::verify_password(
            auth.password.as_deref().unwrap_or_default(),
            "test-password"
        ),
        "the stored PHC hash must verify the plaintext"
    );
    assert_ne!(
        auth.password.as_deref(),
        Some("test-password"),
        "from_settings must carry the hash through, never the plaintext"
    );
    assert!(!auth.localhost_no_auth);
    assert!(
        auth.sessions.is_empty(),
        "fresh config carries no sessions until login or restore"
    );
    assert_eq!(auth.sessions_rev, 0);
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
fn apply_no_sleep_mode_off_and_auto_return_inactive() {
    let mut state = NoSleepState::default();
    let (active, gen_off) = apply_no_sleep_mode(&mut state, "off".to_string(), None);
    assert!(!active);
    assert_eq!(gen_off, 1);
    assert_eq!(state.mode, "off");
    assert_eq!(state.until_ms, None);

    let (active, gen_auto) = apply_no_sleep_mode(&mut state, "auto".to_string(), None);
    assert!(!active);
    assert_eq!(gen_auto, 2);
    assert_eq!(state.mode, "auto");
    // A later mode change invalidates the auto generation counter.
    let (_, gen_next) = apply_no_sleep_mode(&mut state, "off".to_string(), None);
    assert_eq!(gen_next, 3);
    assert_eq!(state.auto_generation, 3);
}

#[test]
fn apply_no_sleep_mode_timed_starts_guard_and_sets_until() {
    // On a supported platform the guard spawns the real inhibitor process
    // (caffeinate / systemd-inhibit); dropping the state kills it.
    let mut state = NoSleepState::default();
    let until = unix_ms_now() + 3_600_000;
    let (active, _) = apply_no_sleep_mode(&mut state, "1h".to_string(), Some(until));
    if cfg!(any(target_os = "macos", target_os = "linux")) {
        // The inhibitor may legitimately fail to spawn on a stripped CI
        // image; only pin the success shape when the guard exists.
        if state.guard.is_some() {
            assert!(active);
            assert_eq!(state.mode, "1h");
            assert_eq!(state.until_ms, Some(until));
            assert_eq!(state.error, None);
        } else {
            assert!(!active);
            assert!(state.error.is_some());
        }
    }
}

#[test]
fn sync_auto_no_sleep_starts_and_keeps_guard_for_working_agents() {
    let mut state = NoSleepState {
        mode: "auto".to_string(),
        ..NoSleepState::default()
    };
    sync_auto_no_sleep(&mut state, true, 60);
    if state.guard.is_some() {
        // First working observation starts the guard and clears any error.
        assert_eq!(state.auto_idle_since_ms, None);
        assert_eq!(state.error, None);
        // A second working observation keeps the guard and resets nothing.
        sync_auto_no_sleep(&mut state, true, 60);
        assert_eq!(state.auto_idle_since_ms, None);
        // Idle below the cooldown keeps auto mode and records the idle mark.
        sync_auto_no_sleep(&mut state, false, 60);
        assert_eq!(state.mode, "auto");
        assert!(state.auto_idle_since_ms.is_some());
    }
}

#[test]
fn sync_auto_no_sleep_ignores_non_auto_modes() {
    let mut state = NoSleepState {
        mode: "1h".to_string(),
        ..NoSleepState::default()
    };
    sync_auto_no_sleep(&mut state, true, 0);
    assert_eq!(state.mode, "1h");
    assert!(state.guard.is_none());
}

#[tokio::test]
async fn no_sleep_update_round_trips_modes_through_api() {
    let app = test_app();
    let post = |mode: &str| {
        let app = app.clone();
        let mode = mode.to_string();
        async move {
            app.clone()
                .oneshot(
                    authed_request(Method::POST, "/api/no-sleep")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(json!({ "mode": mode }).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap()
        }
    };

    // off is idempotent and reports inactive.
    let response = post("off").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["mode"], "off");
    assert_eq!(body["active"], false);

    // auto activates the polling loop; the response reports the mode even
    // though no backend is reachable (agent list probe fails silently).
    let response = post("auto").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["mode"], "auto");
    assert_eq!(body["until_ms"], Value::Null);

    // A timed mode reports the mode; until_ms is set when the guard
    // actually started, and a second off clears it again.
    let response = post("1h").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["mode"], "1h");
    let until_after_1h = body["until_ms"].as_u64();
    if body["active"] == true {
        assert!(until_after_1h.is_some());
    }

    let response = post("off").await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["mode"], "off");
    assert_eq!(body["until_ms"], Value::Null);

    // GET reports the settled state.
    let response = app
        .clone()
        .oneshot(
            authed_request(Method::GET, "/api/no-sleep")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["mode"], "off");
}

#[test]
fn classifies_backend_compatibility() {
    // herdr 0.9.x requires an exact protocol match: every supported
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
    // The tested range spans every 0.9.x release: protocol 22 never
    // changed between them, so each patch release stays Compatible.
    assert_eq!(
        backend_compatibility_for_supported_range(Some("0.9.1"), Some(PROTOCOL_VERSION)),
        BackendCompatibility::Compatible
    );
    assert_eq!(
        backend_compatibility_for_supported_range(Some("0.9.5"), Some(PROTOCOL_VERSION)),
        BackendCompatibility::Compatible
    );
    assert_eq!(
        backend_compatibility_for_supported_range(Some("0.9.6"), Some(PROTOCOL_VERSION)),
        BackendCompatibility::UntestedNewer
    );
    assert_eq!(
        backend_compatibility_for_supported_range(Some("0.10.0"), Some(PROTOCOL_VERSION)),
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
    assert_eq!(
        backend_compatibility_for_supported_range(Some("0.8.9"), Some(PROTOCOL_VERSION)),
        BackendCompatibility::TooOld
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
    use crate::terminal_hub::AttachError;
    // Handshake failures offer a built-in session; transport failures
    // (socket missing, attach send failing) do not, since the backend
    // may just be restarting.
    assert!(AttachError::ReadHandshake.suggests_builtin());
    assert!(
        AttachError::Rejected("client version 22 is newer than server version 21".into())
            .suggests_builtin()
    );
    assert!(!AttachError::Connect.suggests_builtin());
    assert!(!AttachError::SendHandshake.suggests_builtin());
    assert!(!AttachError::Attach.suggests_builtin());

    assert_eq!(AttachError::ReadHandshake.error_kind(), "handshake_failed");
    assert_eq!(
        AttachError::Rejected("mismatch".into()).error_kind(),
        "handshake_rejected"
    );
    assert_eq!(AttachError::Connect.error_kind(), "connect_failed");
    // User-facing messages keep the legacy terminal text for direct
    // display when the UI cannot parse the structured frame.
    assert!(AttachError::Rejected("boom".into())
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
    // The head and consumed-count were added after a framing desync showed
    // up as a bare "trailing bytes" that could not tell a misdecoded
    // variant from a mid-frame shift (a 16KB Input frame decoded 130 of
    // 16388 bytes and nothing in the error said which).
    assert!(err.contains("head"));
    assert!(err.contains("decoded"));
}

#[test]
fn truncated_framed_protocol_errors_name_the_stage_and_length() {
    // EOF before any length byte vs EOF mid-body must be tellable apart
    // from the error alone; each carries the frame length in play.
    let empty = read_message::<_, ClientMessage>(&mut Cursor::new([]), MAX_FRAME_SIZE).unwrap_err();
    assert!(empty.starts_with("read frame length"), "{empty}");
    assert!(empty.contains("kind UnexpectedEof"), "{empty}");

    let payload =
        bincode::serde::encode_to_vec(&ClientMessage::Detach, bincode::config::standard()).unwrap();
    let mut truncated = Vec::new();
    truncated.extend_from_slice(&u32::try_from(payload.len() + 64).unwrap().to_le_bytes());
    truncated.extend_from_slice(&payload);
    let mid_body =
        read_message::<_, ClientMessage>(&mut Cursor::new(truncated), MAX_FRAME_SIZE).unwrap_err();
    assert!(
        mid_body.contains("failed to fill whole buffer"),
        "{mid_body}"
    );
    assert!(
        mid_body.contains(&format!("read {}-byte frame body", payload.len() + 64)),
        "{mid_body}"
    );
}

#[test]
fn client_message_wire_goldens_match_the_hand_rolled_mirrors() {
    // The e2e suites (tests/input_rate_e2e.rs, tests/shed_binary_e2e.rs)
    // hand-roll ClientMessage payloads because the types are pub(crate)
    // and unreachable from integration tests. Those mirrors cannot be
    // compared against the real encoder directly, so both sides pin
    // these exact byte goldens: the mirror tests assert the same vectors,
    // and this test asserts the real ClientMessage encodes to them through
    // the production write path (bincode::serde, standard config). Any
    // drift - variant index, field order, bool byte, length-prefix scheme -
    // fails here with a byte-level diff instead of desyncing a live
    // handshake with "trailing bytes in frame".
    let hello = bincode::serde::encode_to_vec(
        &ClientMessage::TerminalHello {
            version: PROTOCOL_VERSION,
            cols: 120,
            rows: 40,
            cell_width_px: 0,
            cell_height_px: 0,
            pixel_mouse: false,
        },
        bincode::config::standard(),
    )
    .unwrap();
    assert_eq!(
        hello,
        vec![
            0x00,                   // TerminalHello variant index (varint)
            PROTOCOL_VERSION as u8, // version: 22 fits one varint byte
            120,                    // cols
            40,                     // rows
            0,                      // cell_width_px
            0,                      // cell_height_px
            0,                      // pixel_mouse: false is one zero byte
        ]
    );

    // 16 KiB is the frame size the flood tests actually push, so pin the
    // length prefix at that size: 16384 = 0x4000 > 250, so bincode emits
    // the FB marker + u16 LE (00 40), the exact shape the old LEB128
    // mirror got wrong (it produced 80 80 01 and desynced framing).
    let input = bincode::serde::encode_to_vec(
        &ClientMessage::Input {
            data: vec![b'x'; 16384],
        },
        bincode::config::standard(),
    )
    .unwrap();
    assert_eq!(&input[..4], &[0x01, 0xFB, 0x00, 0x40]);
    assert_eq!(input.len(), 4 + 16384);
    assert_eq!(&input[4..], &[b'x'; 16384][..]);

    // Small Vec: length 5 stays inline (< 251).
    let small = bincode::serde::encode_to_vec(
        &ClientMessage::Input {
            data: vec![0xAB; 5],
        },
        bincode::config::standard(),
    )
    .unwrap();
    assert_eq!(small, [0x01, 0x05, 0xAB, 0xAB, 0xAB, 0xAB, 0xAB]);

    let attach = bincode::serde::encode_to_vec(
        &ClientMessage::AttachTerminal {
            terminal_id: "probe-tty".to_string(),
            takeover: true,
        },
        bincode::config::standard(),
    )
    .unwrap();
    assert_eq!(
        attach,
        vec![
            0x05, // AttachTerminal variant index (Detach=4 sits before it)
            0x09, // String length as varint: "probe-tty" is 9 bytes
            b'p', b'r', b'o', b'b', b'e', b'-', b't', b't', b'y',
            0x01, // takeover: true is one 0x01 byte
        ]
    );
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
        password_hash: settings.password.clone(),
        password: None,
        localhost_no_auth: Some(settings.localhost_no_auth),
        session_expiration_minutes: Some(settings.session_expiration_minutes),
        session_expiration_migrated: None,
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

// ── events_socket: verify backend_info uses spawn_blocking and close on drop ──
// This is hard to test directly because events_socket requires a WebSocket
// upgrade. Instead we test the helper functions it depends on.

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

#[test]
fn parses_tls_mode_aliases_and_rejects_unknown() {
    assert_eq!(parse_tls_mode("off").unwrap(), TlsMode::Off);
    assert_eq!(parse_tls_mode("auto").unwrap(), TlsMode::Auto);
    assert_eq!(parse_tls_mode("self-signed").unwrap(), TlsMode::SelfSigned);
    assert_eq!(parse_tls_mode("selfsigned").unwrap(), TlsMode::SelfSigned);
    assert_eq!(parse_tls_mode("self").unwrap(), TlsMode::SelfSigned);
    assert_eq!(parse_tls_mode("files").unwrap(), TlsMode::Files);
    assert_eq!(parse_tls_mode("cert").unwrap(), TlsMode::Files);
    assert_eq!(parse_tls_mode("both").unwrap(), TlsMode::Both);
    assert_eq!(parse_tls_mode("http-https").unwrap(), TlsMode::Both);
    assert_eq!(parse_tls_mode("http+https").unwrap(), TlsMode::Both);
    assert!(parse_tls_mode("maybe")
        .unwrap_err()
        .to_string()
        .contains("invalid --https mode"));
    assert!(parse_tls_mode("").is_err());
}

#[test]
fn tls_mode_accessors_pin_scheme_bind_and_cookie_rules() {
    // Canonical text for every mode.
    assert_eq!(TlsMode::Off.as_str(), "off");
    assert_eq!(TlsMode::Auto.as_str(), "auto");
    assert_eq!(TlsMode::SelfSigned.as_str(), "self-signed");
    assert_eq!(TlsMode::Files.as_str(), "files");
    assert_eq!(TlsMode::Both.as_str(), "both");

    // Primary scheme: `both` serves HTTP on the configured port.
    assert_eq!(TlsMode::Off.scheme(), "http");
    assert_eq!(TlsMode::Both.scheme(), "http");
    assert_eq!(TlsMode::Auto.scheme(), "https");
    assert_eq!(TlsMode::SelfSigned.scheme(), "https");
    assert_eq!(TlsMode::Files.scheme(), "https");

    let bind: SocketAddr = "127.0.0.1:8080".parse().unwrap();
    let next: SocketAddr = "127.0.0.1:8081".parse().unwrap();
    assert_eq!(TlsMode::Both.https_bind(bind), Some(next));
    assert_eq!(TlsMode::Off.https_bind(bind), None);
    assert_eq!(TlsMode::Auto.https_bind(bind), None);

    // uses_tls: every mode except Off carries TLS somewhere (Both carries
    // it on the side port).
    assert!(!TlsMode::Off.uses_tls());
    assert!(TlsMode::Auto.uses_tls());
    assert!(TlsMode::SelfSigned.uses_tls());
    assert!(TlsMode::Files.uses_tls());
    assert!(TlsMode::Both.uses_tls());

    // cookie_secure: only HTTPS-only modes may set the Secure flag, because
    // `both` also serves the same host over plain HTTP.
    assert!(TlsMode::Auto.cookie_secure());
    assert!(TlsMode::SelfSigned.cookie_secure());
    assert!(TlsMode::Files.cookie_secure());
    assert!(!TlsMode::Off.cookie_secure());
    assert!(!TlsMode::Both.cookie_secure());
}

#[test]
fn arg_helpers_report_missing_values_and_remove_flags() {
    let args = vec!["--bind".to_string(), "127.0.0.1:9000".to_string()];
    assert_eq!(required_arg(&args, 0, "--bind").unwrap(), "127.0.0.1:9000");
    let err = required_arg(&args, 1, "--bind").unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    assert!(err.to_string().contains("missing value for --bind"));

    let mut flags = vec![
        "--verbose".to_string(),
        "a".to_string(),
        "--verbose".to_string(),
        "b".to_string(),
    ];
    assert!(take_flag(&mut flags, "--verbose"));
    // Only the first occurrence is removed.
    assert_eq!(flags, vec!["a", "--verbose", "b"]);
    assert!(take_flag(&mut flags, "--verbose"));
    assert_eq!(flags, vec!["a", "b"]);
    assert!(!take_flag(&mut flags, "--verbose"));
    assert_eq!(flags, vec!["a", "b"]);
    assert!(!take_flag(&mut flags, "--quiet"));
}

#[test]
fn parses_timestamps_with_offsets_and_fractional_seconds() {
    // UTC Z suffix.
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T03:04:05Z"),
        Some(1_767_323_045)
    );
    // Positive offset subtracts: 03:04:05+02:00 is 01:04:05 UTC.
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T03:04:05+02:00"),
        Some(1_767_323_045 - 2 * 3_600)
    );
    // Negative offset adds.
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T03:04:05-01:30"),
        Some(1_767_323_045 + 3_600 + 1_800)
    );
    // Fractional seconds are skipped up to the next non-digit.
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02 03:04:05.123456Z"),
        Some(1_767_323_045)
    );
    // Leap second clamps to 59: 03:04:60 is 03:04:59 + 1s over the pin.
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T03:04:60Z"),
        Some(1_767_323_045 + 54)
    );
    // Missing offset reads as UTC.
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T03:04:05"),
        Some(1_767_323_045)
    );
    // Whitespace trims.
    assert_eq!(
        parse_worktree_activity_timestamp(" 2026-01-02T03:04:05Z "),
        Some(1_767_323_045)
    );
}

#[test]
fn rejects_malformed_timestamps() {
    assert_eq!(parse_worktree_activity_timestamp(""), None);
    assert_eq!(parse_worktree_activity_timestamp("2026-01-02"), None);
    assert_eq!(
        parse_worktree_activity_timestamp("2026-1-2T03:04:05Z"),
        None
    );
    assert_eq!(
        parse_worktree_activity_timestamp("2026-13-02T03:04:05Z"),
        None
    );
    assert_eq!(
        parse_worktree_activity_timestamp("2026-02-30T03:04:05Z"),
        None
    );
    assert_eq!(
        parse_worktree_activity_timestamp("2026-02-29T03:04:05Z"),
        None
    );
    assert!(
        parse_worktree_activity_timestamp("2024-02-29T03:04:05Z").is_some(),
        "2024 is a leap year"
    );
    assert_eq!(
        parse_worktree_activity_timestamp("2000-02-29T03:04:05Z"),
        Some(951_793_445)
    );
    assert_eq!(
        parse_worktree_activity_timestamp("1900-02-29T00:00:00Z"),
        None
    );
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T24:00:00Z"),
        None
    );
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T23:60:00Z"),
        None
    );
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T23:59:61Z"),
        None
    );
    // Offset out of range.
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T03:04:05+24:00"),
        None
    );
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T03:04:05+02:60"),
        None
    );
    // Incomplete offset: needs exactly hh:mm.
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T03:04:05+0200"),
        None
    );
    // Garbage after fractional seconds never finds a terminator.
    assert_eq!(
        parse_worktree_activity_timestamp("2026-01-02T03:04:05.123456"),
        None
    );
    // Slash separators do not parse.
    assert_eq!(
        parse_worktree_activity_timestamp("2026/01/02 03:04:05"),
        None
    );
}

#[test]
fn days_from_civil_pins_known_epoch_values() {
    // Unix epoch: 1970-01-01.
    assert_eq!(days_from_civil(1970, 1, 1), Some(0));
    assert_eq!(days_from_civil(1970, 1, 2), Some(1));
    assert_eq!(days_from_civil(1969, 12, 31), Some(-1));
    assert_eq!(days_from_civil(2000, 3, 1), Some(11_017));
    assert_eq!(days_from_civil(2026, 1, 2), Some(20_455));
    // Month day limits.
    assert_eq!(days_from_civil(2026, 4, 31), None);
    assert_eq!(days_from_civil(2026, 2, 29), None);
    assert_eq!(days_from_civil(2028, 2, 29), Some(21_243));
    assert_eq!(days_from_civil(2026, 0, 1), None);
    assert_eq!(days_from_civil(2026, 1, 0), None);
    // 1900 is not a leap year (divisible by 100, not by 400).
    assert!(!is_leap_year(1900));
    assert!(!is_leap_year(2026));
    assert!(is_leap_year(2024));
    assert!(is_leap_year(2000));
}
