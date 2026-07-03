use std::collections::HashMap;
use std::fs;
use std::future::IntoFuture;
use std::io::{self, BufRead, BufReader, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use interprocess::TryClone as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

mod assets;
mod compat;
mod file_browser;
mod git_ui;
mod protocol;
mod service;

use assets::*;
#[cfg(test)]
use compat::SimpleVersion;
use compat::{backend_compatibility, BackendCompatibility};
use protocol::*;

const DEFAULT_BIND: &str = "127.0.0.1:8787";
const COOKIE_NAME: &str = "herdr_web_session";
const HERDR_WEBUI_VERSION: &str = env!("HERDR_WEBUI_VERSION");
const INSTALL_LABEL: &str = "herdr-web";
const MAX_FRAME_SIZE: usize = 2 * 1024 * 1024;
const MAX_GRAPHICS_FRAME_SIZE: usize = 32 * 1024 * 1024;
const MIN_SUPPORTED_PROTOCOL_VERSION: u32 = 14;
const PROTOCOL_VERSION: u32 = 15;
const MIN_BACKEND_VERSION: &str = "0.7.0";
const MAX_TESTED_BACKEND_VERSION: &str = "0.7.2";

type LocalStream = interprocess::local_socket::Stream;

fn backend_compatibility_for_supported_range(
    backend: Option<&str>,
    protocol: Option<u32>,
) -> BackendCompatibility {
    backend_compatibility(
        backend,
        protocol,
        MIN_SUPPORTED_PROTOCOL_VERSION,
        PROTOCOL_VERSION,
        MIN_BACKEND_VERSION,
        MAX_TESTED_BACKEND_VERSION,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BackendInfo {
    version: Option<String>,
    protocol: Option<u32>,
}

#[derive(Clone, Debug)]
struct WebConfig {
    bind: SocketAddr,
    session: Option<String>,
    api_socket: Option<PathBuf>,
    client_socket: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct PersistedServerSettings {
    bind: Option<String>,
    user: Option<String>,
    password: Option<String>,
    localhost_no_auth: Option<bool>,
    no_sleep_auto_cooldown_seconds: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RuntimeServerSettings {
    bind: SocketAddr,
    user: Option<String>,
    password: Option<String>,
    localhost_no_auth: bool,
    no_sleep_auto_cooldown_seconds: u64,
}

struct NoSleepGuard {
    child: Child,
}

impl Drop for NoSleepGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct NoSleepState {
    mode: String,
    until_ms: Option<u64>,
    error: Option<String>,
    guard: Option<NoSleepGuard>,
    auto_generation: u64,
    auto_idle_since_ms: Option<u64>,
}

impl Default for NoSleepState {
    fn default() -> Self {
        Self {
            mode: "off".to_string(),
            until_ms: None,
            error: None,
            guard: None,
            auto_generation: 0,
            auto_idle_since_ms: None,
        }
    }
}

fn no_sleep_ms(mode: &str) -> Option<u64> {
    match mode {
        "off" | "auto" | "infinite" => Some(0),
        "1h" => Some(60 * 60 * 1000),
        "2h" => Some(2 * 60 * 60 * 1000),
        "4h" => Some(4 * 60 * 60 * 1000),
        _ => None,
    }
}

fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn start_no_sleep_guard() -> io::Result<NoSleepGuard> {
    #[cfg(target_os = "macos")]
    let child = Command::new("caffeinate")
        .args(["-dimsu"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    #[cfg(target_os = "linux")]
    let child = Command::new("systemd-inhibit")
        .args([
            "--what=sleep:idle",
            "--who=herdr-webui",
            "--why=Herdr WebUI no-sleep mode",
            "sleep",
            "infinity",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()?;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "no-sleep mode is only supported on macOS and Linux",
    ));
    Ok(NoSleepGuard { child })
}

impl WebConfig {
    fn parse(args: &[String]) -> io::Result<Self> {
        let mut bind = DEFAULT_BIND.parse::<SocketAddr>().expect("valid bind");
        let mut session = None;
        let mut api_socket = None;
        let mut client_socket = None;
        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--bind" => {
                    let value = required_arg(args, index, "--bind")?;
                    bind = value.parse().map_err(|err| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            format!("invalid --bind: {err}"),
                        )
                    })?;
                    index += 2;
                }
                "--session" => {
                    session = Some(required_arg(args, index, "--session")?.to_string());
                    index += 2;
                }
                "--api-socket" => {
                    api_socket = Some(PathBuf::from(required_arg(args, index, "--api-socket")?));
                    index += 2;
                }
                "--client-socket" => {
                    client_socket =
                        Some(PathBuf::from(required_arg(args, index, "--client-socket")?));
                    index += 2;
                }
                "help" | "--help" | "-h" => {
                    print_help();
                    std::process::exit(0);
                }
                other => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("unknown argument: {other}"),
                    ));
                }
            }
        }
        Ok(Self {
            bind,
            session,
            api_socket,
            client_socket,
        })
    }
}

fn required_arg<'a>(args: &'a [String], index: usize, flag: &str) -> io::Result<&'a str> {
    args.get(index + 1).map(String::as_str).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("missing value for {flag}"),
        )
    })
}

fn take_flag(args: &mut Vec<String>, flag: &str) -> bool {
    let Some(index) = args.iter().position(|arg| arg == flag) else {
        return false;
    };
    args.remove(index);
    true
}

fn home_dir() -> io::Result<PathBuf> {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "HOME is required"))
}

fn print_help() {
    eprint!("{}", help_text());
}

fn help_text() -> &'static str {
    "herdr-webui [--verbose] [--bind HOST:PORT] [--session NAME] [--api-socket PATH] [--client-socket PATH]\n\
herdr-webui --version\n\
herdr-webui install-mac [--verbose] [--bind HOST:PORT] [--session NAME]\n\
herdr-webui update-mac [--verbose]\n\
herdr-webui install-linux [--bind HOST:PORT] [--session NAME]\n\
herdr-webui update-linux\n\
herdr-webui start-mac | start [--verbose]\n\
herdr-webui stop-mac | stop [--verbose]\n\
herdr-webui restart-mac | restart [--verbose]\n\
herdr-webui start-linux | start\n\
herdr-webui stop-linux | stop\n\
herdr-webui restart-linux | restart\n\
herdr-webui uninstall-mac [--verbose]\n\
herdr-webui uninstall-linux\n"
}

#[derive(Clone)]
pub(crate) struct WebState {
    api_socket: Option<PathBuf>,
    client_socket: Option<PathBuf>,
    session_name: Option<String>,
    herdr_bin: String,
    auth: Arc<Mutex<AuthConfig>>,
    server_settings: Arc<Mutex<RuntimeServerSettings>>,
    no_sleep: Arc<Mutex<NoSleepState>>,
    rebind_tx: tokio::sync::watch::Sender<SocketAddr>,
    workspace_orders: Arc<Mutex<HashMap<String, Vec<String>>>>,
}

#[derive(Clone)]
struct ApiClient {
    socket_path: PathBuf,
}

impl ApiClient {
    fn request_value(&self, request: serde_json::Value) -> Result<serde_json::Value, String> {
        let mut stream = connect_local_stream(&self.socket_path).map_err(|err| err.to_string())?;
        stream
            .write_all(
                serde_json::to_string(&request)
                    .map_err(|err| err.to_string())?
                    .as_bytes(),
            )
            .map_err(|err| err.to_string())?;
        stream.write_all(b"\n").map_err(|err| err.to_string())?;
        stream.flush().map_err(|err| err.to_string())?;
        let mut reader = BufReader::new(stream);
        read_json_line(&mut reader).map_err(|err| err.to_string())
    }

    fn subscribe(&self, request: serde_json::Value) -> Result<EventStream, String> {
        let mut stream = connect_local_stream(&self.socket_path).map_err(|err| err.to_string())?;
        stream
            .write_all(
                serde_json::to_string(&request)
                    .map_err(|err| err.to_string())?
                    .as_bytes(),
            )
            .map_err(|err| err.to_string())?;
        stream.write_all(b"\n").map_err(|err| err.to_string())?;
        stream.flush().map_err(|err| err.to_string())?;
        let mut reader = BufReader::new(stream);
        let _ack: serde_json::Value = read_json_line(&mut reader).map_err(|err| err.to_string())?;
        Ok(EventStream { reader })
    }

    fn backend_info(&self) -> BackendInfo {
        let response = self
            .request_value(json!({ "id": "web:ping", "method": "ping", "params": {} }))
            .ok();
        let version = response
            .as_ref()
            .and_then(|response| response.get("result"))
            .and_then(|result| result.get("version"))
            .and_then(|version| version.as_str())
            .map(str::to_string);
        let protocol = response
            .as_ref()
            .and_then(|response| response.get("result"))
            .and_then(|result| result.get("protocol"))
            .and_then(|protocol| protocol.as_u64())
            .and_then(|protocol| u32::try_from(protocol).ok());
        BackendInfo { version, protocol }
    }
}

struct EventStream {
    reader: BufReader<LocalStream>,
}

impl EventStream {
    fn next_value(&mut self) -> Result<Option<serde_json::Value>, io::Error> {
        let mut line = String::new();
        let read = self.reader.read_line(&mut line)?;
        if read == 0 {
            return Ok(None);
        }
        serde_json::from_str(&line)
            .map(Some)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
    }
}

struct AuthConfig {
    user: Option<String>,
    password: Option<String>,
    localhost_no_auth: bool,
    token: String,
}

impl AuthConfig {
    fn from_settings(settings: &RuntimeServerSettings) -> io::Result<Self> {
        validate_runtime_server_settings(settings)?;
        let seed = format!(
            "{}:{}:{}",
            settings.user.as_deref().unwrap_or(""),
            settings.password.as_deref().unwrap_or(""),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_nanos())
                .unwrap_or(0)
        );
        let token = Sha256::digest(seed.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(Self {
            user: settings.user.clone(),
            password: settings.password.clone(),
            localhost_no_auth: settings.localhost_no_auth,
            token,
        })
    }
}

fn validate_runtime_server_settings(settings: &RuntimeServerSettings) -> io::Result<()> {
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
    Ok(())
}

fn default_runtime_server_settings(bind: SocketAddr) -> RuntimeServerSettings {
    RuntimeServerSettings {
        bind,
        user: None,
        password: None,
        localhost_no_auth: true,
        no_sleep_auto_cooldown_seconds: 60,
    }
}

fn server_settings_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("herdr-webui/webui-settings.json");
    }
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".config/herdr-webui/webui-settings.json"))
        .unwrap_or_else(|_| std::env::temp_dir().join("herdr-webui/webui-settings.json"))
}

fn load_runtime_server_settings(default_bind: SocketAddr) -> io::Result<RuntimeServerSettings> {
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
        "user",
        "password",
        "localhost_no_auth",
        "no_sleep_auto_cooldown_seconds",
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
    if persisted.user.is_some() {
        settings.user = persisted.user.filter(|value| !value.is_empty());
    }
    if persisted.password.is_some() {
        settings.password = persisted.password.filter(|value| !value.is_empty());
    }
    if let Some(localhost_no_auth) = persisted.localhost_no_auth {
        settings.localhost_no_auth = localhost_no_auth;
    }
    if let Some(cooldown) = persisted.no_sleep_auto_cooldown_seconds {
        settings.no_sleep_auto_cooldown_seconds = cooldown;
    }
    validate_runtime_server_settings(&settings)?;
    if missing_keys {
        save_runtime_server_settings(&settings)?;
    }
    Ok(settings)
}

fn save_runtime_server_settings(settings: &RuntimeServerSettings) -> io::Result<()> {
    validate_runtime_server_settings(settings)?;
    let path = server_settings_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let content = serde_json::to_string_pretty(&PersistedServerSettings {
        bind: Some(settings.bind.to_string()),
        user: settings.user.clone(),
        password: settings.password.clone(),
        localhost_no_auth: Some(settings.localhost_no_auth),
        no_sleep_auto_cooldown_seconds: Some(settings.no_sleep_auto_cooldown_seconds),
    })?;
    fs::write(&path, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let mut args = std::env::args().skip(1).collect::<Vec<_>>();
    if take_flag(&mut args, "--verbose") || take_flag(&mut args, "-v") {
        std::env::set_var("HERDR_WEB_VERBOSE", "1");
    }
    if matches!(args.first().map(String::as_str), Some("--version" | "-V")) {
        println!("{HERDR_WEBUI_VERSION}");
        return Ok(());
    }
    if matches!(args.first().map(String::as_str), Some("install-mac")) {
        return service::install_macos(WebConfig::parse(&args[1..])?);
    }
    if matches!(args.first().map(String::as_str), Some("update-mac")) {
        return service::update_macos();
    }
    if matches!(args.first().map(String::as_str), Some("install-linux")) {
        return service::install_linux(WebConfig::parse(&args[1..])?);
    }
    if matches!(args.first().map(String::as_str), Some("update-linux")) {
        return service::update_linux();
    }
    if matches!(
        args.first().map(String::as_str),
        Some("start-mac" | "start")
    ) {
        if matches!(args.first().map(String::as_str), Some("start")) {
            return service::start_service();
        }
        return service::start_macos_service();
    }
    if matches!(args.first().map(String::as_str), Some("start-linux")) {
        return service::start_linux_service();
    }
    if matches!(args.first().map(String::as_str), Some("stop")) {
        return service::stop_service();
    }
    if matches!(args.first().map(String::as_str), Some("stop-mac")) {
        return service::stop_macos_service();
    }
    if matches!(args.first().map(String::as_str), Some("stop-linux")) {
        return service::stop_linux_service();
    }
    if matches!(
        args.first().map(String::as_str),
        Some("restart-mac" | "restart")
    ) {
        if matches!(args.first().map(String::as_str), Some("restart")) {
            return service::restart_service();
        }
        return service::restart_macos_service();
    }
    if matches!(args.first().map(String::as_str), Some("restart-linux")) {
        return service::restart_linux_service();
    }
    if matches!(args.first().map(String::as_str), Some("uninstall-mac")) {
        return service::uninstall_macos();
    }
    if matches!(args.first().map(String::as_str), Some("uninstall-linux")) {
        return service::uninstall_linux();
    }
    let config = WebConfig::parse(&args)?;
    let server_settings = load_runtime_server_settings(config.bind)?;
    let auth = Arc::new(Mutex::new(AuthConfig::from_settings(&server_settings)?));
    let server_settings = Arc::new(Mutex::new(server_settings.clone()));
    let (rebind_tx, rebind_rx) = tokio::sync::watch::channel(server_settings.lock().unwrap().bind);
    let state = WebState {
        api_socket: config.api_socket.clone(),
        client_socket: config.client_socket.clone(),
        session_name: config.session.clone(),
        herdr_bin: std::env::var("HERDR_WEB_HERDR_BIN").unwrap_or_else(|_| "herdr".to_string()),
        auth,
        server_settings,
        no_sleep: Arc::new(Mutex::new(NoSleepState::default())),
        rebind_tx,
        workspace_orders: Arc::new(Mutex::new(HashMap::new())),
    };

    serve_rebindable(state, rebind_rx).await
}

async fn serve_rebindable(
    state: WebState,
    mut rebind_rx: tokio::sync::watch::Receiver<SocketAddr>,
) -> io::Result<()> {
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(io::Error::other)?;
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(io::Error::other)?;

    loop {
        let bind = *rebind_rx.borrow_and_update();
        let listener = match tokio::net::TcpListener::bind(bind).await {
            Ok(listener) => listener,
            Err(err) => {
                eprintln!("failed to bind http://{bind}: {err}");
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                continue;
            }
        };
        eprintln!("herdr-webui listening on http://{bind}");
        let mut shutdown_rx = rebind_rx.clone();
        let server = axum::serve(
            listener,
            app_router(state.clone()).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.changed().await;
        })
        .into_future();
        tokio::pin!(server);
        tokio::select! {
            _ = sigterm.recv() => return Ok(()),
            _ = sigint.recv() => return Ok(()),
            res = &mut server => {
                res.map_err(io::Error::other)?;
            }
        }
    }
}

fn app_router(state: WebState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/session", get(index))
        .route("/session/{session}", get(index))
        .route("/session/{session}/workspace/{workspace_id}", get(index))
        .route(
            "/session/{session}/workspace/{workspace_id}/tab/{tab_id}",
            get(index),
        )
        .route(
            "/session/{session}/workspace/{workspace_id}/tab/{tab_id}/pane/{pane_id}",
            get(index),
        )
        .route("/workspace/{workspace_id}", get(index))
        .route("/workspace/{workspace_id}/tab/{tab_id}", get(index))
        .route(
            "/workspace/{workspace_id}/tab/{tab_id}/pane/{pane_id}",
            get(index),
        )
        .route("/api/me", get(me))
        .route("/api/sessions", get(sessions))
        .route("/api/versions", get(versions))
        .route(
            "/api/server-settings",
            get(server_settings).post(update_server_settings),
        )
        .route("/api/no-sleep", get(no_sleep).post(update_no_sleep))
        .route("/api/session/launch", post(launch_session))
        .route("/api/session/close", post(close_session))
        .route("/api/login", post(login))
        .route("/api/workspaces", get(workspaces).post(create_workspace))
        .route(
            "/api/workspace-order",
            get(workspace_order).post(set_workspace_order),
        )
        .route("/api/worktrees", get(worktrees).post(create_worktree))
        .route("/api/worktrees/open", post(open_worktree))
        .route("/api/worktrees/remove-path", post(remove_worktree_path))
        .route("/api/git-branches", get(git_branches))
        .merge(file_browser::routes())
        .merge(git_ui::routes())
        .route(
            "/api/workspaces/{workspace_id}/rename",
            post(rename_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/close",
            post(close_workspace),
        )
        .route(
            "/api/workspaces/{workspace_id}/worktree-remove",
            post(remove_worktree),
        )
        .route("/api/tabs", get(tabs).post(create_tab))
        .route("/api/tabs/{tab_id}/rename", post(rename_tab))
        .route("/api/tabs/{tab_id}/close", post(close_tab))
        .route("/api/panes", get(panes))
        .route("/api/panes/{pane_id}/close", post(close_pane))
        .route("/api/pane-layout", get(pane_layout))
        .route("/api/agents", get(agents))
        .route("/assets/desktop/app.css", get(desktop_css))
        .route("/assets/desktop/git-ui.css", get(desktop_git_ui_css))
        .route(
            "/assets/desktop/file-browser.css",
            get(desktop_file_browser_css),
        )
        .route("/assets/desktop/search.css", get(desktop_search_css))
        .route("/assets/desktop/shortcuts.css", get(desktop_shortcuts_css))
        .route("/assets/app-boot.js", get(app_boot_js))
        .route("/assets/shared/core.js", get(shared_core_js))
        .route("/assets/shared/file-tree.js", get(shared_file_tree_js))
        .route("/assets/vendor/codemirror.js", get(vendor_codemirror_js))
        .route("/assets/shared/editor.js", get(shared_editor_js))
        .route(
            "/assets/shared/terminal-scroll.js",
            get(shared_terminal_scroll_js),
        )
        .route("/assets/desktop/git-ui.js", get(desktop_git_ui_js))
        .route(
            "/assets/desktop/file-browser.js",
            get(desktop_file_browser_js),
        )
        .route(
            "/assets/desktop/directory-picker.js",
            get(desktop_directory_picker_js),
        )
        .route("/assets/desktop/search.js", get(desktop_search_js))
        .route("/assets/desktop/app.js", get(desktop_js))
        .route("/assets/login.css", get(login_css))
        .route("/assets/login.js", get(login_js))
        .route("/assets/mobile/attention.js", get(mobile_attention_js))
        .route("/assets/mobile/core.js", get(mobile_core_js))
        .route("/assets/mobile/settings.js", get(mobile_settings_js))
        .route("/assets/mobile/terminal.js", get(mobile_terminal_js))
        .route("/assets/mobile/worktrees.js", get(mobile_worktrees_js))
        .route(
            "/assets/mobile/file-browser.js",
            get(mobile_file_browser_js),
        )
        .route("/assets/mobile/app.css", get(mobile_css))
        .route("/assets/mobile/app.js", get(mobile_js))
        .route("/assets/xterm.js", get(xterm_js))
        .route("/assets/xterm.css", get(xterm_css))
        .route(
            "/assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf",
            get(jetbrains_mono_nerd_font),
        )
        .route("/assets/icons/help.svg", get(icon_help_svg))
        .route("/assets/icons/settings.svg", get(icon_settings_svg))
        .route("/assets/icons/theme-auto.svg", get(icon_theme_auto_svg))
        .route("/assets/icons/git.svg", get(icon_git_svg))
        .route("/assets/icons/terminal.svg", get(icon_terminal_svg))
        .route(
            "/assets/icons/chevron-right.svg",
            get(icon_chevron_right_svg),
        )
        .route("/assets/icons/chevron-down.svg", get(icon_chevron_down_svg))
        .route("/assets/icons/folder.svg", get(icon_folder_svg))
        .route("/assets/icons/folder-up.svg", get(icon_folder_up_svg))
        .route("/assets/icons/file.svg", get(icon_file_svg))
        .route("/assets/icons/trash.svg", get(icon_trash_svg))
        .route("/assets/icons/broom.svg", get(icon_broom_svg))
        .route("/assets/icons/search.svg", get(icon_search_svg))
        .route("/assets/icons/refresh.svg", get(icon_refresh_svg))
        .route("/favicon.svg", get(favicon_svg))
        .route("/favicon-attention.svg", get(favicon_attention_svg))
        .route("/favicon-error.svg", get(favicon_error_svg))
        .route("/ws/events", get(events_ws))
        .route("/ws/terminal", get(terminal_ws))
        .with_state(state)
}

fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("herdr");
    }
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".config/herdr"))
        .unwrap_or_else(|_| std::env::temp_dir().join("herdr"))
}

fn session_dir(name: Option<&str>) -> PathBuf {
    match name {
        Some(name) if name != "default" => config_dir().join("sessions").join(name),
        _ => config_dir(),
    }
}

fn api_socket_path_for(name: Option<&str>) -> PathBuf {
    session_dir(name).join("herdr.sock")
}

fn client_socket_path_for(name: Option<&str>) -> PathBuf {
    session_dir(name).join("herdr-client.sock")
}

fn session_from_headers(state: &WebState, headers: &HeaderMap) -> Option<String> {
    headers
        .get("x-herdr-session")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| *value != "default")
        .map(str::to_string)
        .or_else(|| state.session_name.clone())
}

fn api_for_headers(state: &WebState, headers: &HeaderMap) -> ApiClient {
    let session = session_from_headers(state, headers);
    if session.is_none() {
        if let Some(socket_path) = &state.api_socket {
            return ApiClient {
                socket_path: socket_path.clone(),
            };
        }
    }
    ApiClient {
        socket_path: api_socket_path_for(session.as_deref()),
    }
}

fn client_socket_for_headers(state: &WebState, headers: &HeaderMap) -> PathBuf {
    let session = session_from_headers(state, headers);
    if session.is_none() {
        if let Some(socket_path) = &state.client_socket {
            return socket_path.clone();
        }
    }
    client_socket_path_for(session.as_deref())
}

fn session_display_name(session: Option<&str>) -> &str {
    session.unwrap_or("default")
}

fn known_sessions() -> Vec<serde_json::Value> {
    let mut names = vec![None];
    let sessions_dir = config_dir().join("sessions");
    if let Ok(entries) = fs::read_dir(sessions_dir) {
        let mut found = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name != "default")
            .map(Some)
            .collect::<Vec<_>>();
        found.sort();
        names.extend(found);
    }
    names
        .into_iter()
        .map(|name| {
            let api_socket = api_socket_path_for(name.as_deref());
            let running = connect_local_stream(&api_socket).is_ok();
            json!({
                "name": session_display_name(name.as_deref()),
                "running": running,
                "api_socket": api_socket.display().to_string(),
            })
        })
        .collect()
}

fn connect_local_stream(path: &Path) -> io::Result<LocalStream> {
    #[cfg(unix)]
    {
        use interprocess::local_socket::{prelude::*, GenericFilePath};
        let name = path.to_fs_name::<GenericFilePath>()?;
        LocalStream::connect(name)
    }
    #[cfg(windows)]
    {
        use interprocess::local_socket::{prelude::*, GenericNamespaced};
        let name = path.to_string_lossy().to_string();
        let name = name.to_ns_name::<GenericNamespaced>()?;
        LocalStream::connect(name)
    }
}

fn read_json_line<T: for<'de> Deserialize<'de>>(
    reader: &mut BufReader<LocalStream>,
) -> io::Result<T> {
    let mut line = String::new();
    let read = reader.read_line(&mut line)?;
    if read == 0 || line.trim().is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "empty response",
        ));
    }
    serde_json::from_str(&line).map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))
}

fn authorized(state: &WebState, headers: &HeaderMap, remote: SocketAddr) -> bool {
    let Ok(auth) = state.auth.lock() else {
        return false;
    };
    if remote.ip().is_loopback() && auth.localhost_no_auth {
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

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[allow(clippy::result_large_err)]
pub(crate) fn require_auth(
    state: &WebState,
    headers: &HeaderMap,
    remote: SocketAddr,
) -> Result<(), Response> {
    authorized(state, headers, remote)
        .then_some(())
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({ "error": "unauthorized" })),
            )
                .into_response()
        })
}

async fn index(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if authorized(&state, &headers, remote) {
        app_html()
    } else {
        login_html()
    }
}

async fn me(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    Json(json!({ "authenticated": authorized(&state, &headers, remote) })).into_response()
}

#[derive(Deserialize)]
struct UpdateServerSettingsRequest {
    bind: String,
    username: Option<String>,
    password: Option<String>,
    localhost_no_auth: bool,
    no_sleep_auto_cooldown_seconds: Option<u64>,
}

fn settings_public_json(settings: &RuntimeServerSettings) -> serde_json::Value {
    json!({
        "bind": settings.bind.to_string(),
        "username": settings.user.clone().unwrap_or_default(),
        "has_password": settings.password.is_some(),
        "localhost_no_auth": settings.localhost_no_auth,
        "no_sleep_auto_cooldown_seconds": settings.no_sleep_auto_cooldown_seconds,
        "settings_path": server_settings_path().to_string_lossy(),
    })
}

fn no_sleep_public_json(state: &NoSleepState) -> serde_json::Value {
    json!({
        "mode": &state.mode,
        "until_ms": state.until_ms,
        "error": &state.error,
        "active": state.guard.is_some(),
        "supported": cfg!(any(target_os = "macos", target_os = "linux")),
    })
}

fn agents_working_from_value(value: &serde_json::Value) -> bool {
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

fn sync_auto_no_sleep(state: &mut NoSleepState, has_working_agents: bool, cooldown_seconds: u64) {
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

fn sync_auto_no_sleep_from_agents(state: &WebState, agents: &serde_json::Value) {
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

fn apply_no_sleep_mode(
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

async fn run_auto_no_sleep_loop(state: WebState, api: ApiClient, generation: u64) {
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
        match api.request_value(
            json!({ "id": "web:agent:list:no-sleep-auto", "method": "agent.list", "params": {} }),
        ) {
            Ok(agents) => sync_auto_no_sleep_from_agents(&state, &agents),
            Err(err) => {
                if let Ok(mut no_sleep) = state.no_sleep.lock() {
                    if no_sleep.mode == "auto" && no_sleep.auto_generation == generation {
                        no_sleep.guard = None;
                        no_sleep.error = Some(err);
                    }
                }
            }
        }
    }
}

async fn server_settings(
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

#[derive(Deserialize)]
struct UpdateNoSleepRequest {
    mode: String,
}

async fn no_sleep(
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

async fn update_no_sleep(
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
    let auto_agents = (body.mode == "auto")
        .then(|| {
            auto_api
                .request_value(json!({ "id": "web:agent:list:no-sleep", "method": "agent.list", "params": {} }))
                .ok()
        })
        .flatten();
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

async fn update_server_settings(
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
        user: body
            .username
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        password: body
            .password
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .or_else(|| {
                current
                    .as_ref()
                    .and_then(|settings| settings.password.clone())
            }),
        localhost_no_auth: body.localhost_no_auth,
        no_sleep_auto_cooldown_seconds: body.no_sleep_auto_cooldown_seconds.unwrap_or(60),
    };
    let bind_changed = current
        .as_ref()
        .is_none_or(|settings| settings.bind != next.bind);
    if let Err(err) = save_runtime_server_settings(&next) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response();
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
    if let Ok(mut auth_lock) = state.auth.lock() {
        *auth_lock = auth;
    }
    if let Ok(mut settings_lock) = state.server_settings.lock() {
        *settings_lock = next.clone();
    }
    if bind_changed {
        let _ = state.rebind_tx.send(next.bind);
    }
    Json(settings_public_json(&next)).into_response()
}

async fn sessions(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    Json(json!({ "sessions": known_sessions() })).into_response()
}

async fn versions(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let session = session_from_headers(&state, &headers);
    let api = api_for_headers(&state, &headers);
    let backend = api.backend_info();
    let compatibility =
        backend_compatibility_for_supported_range(backend.version.as_deref(), backend.protocol);
    let compatibility_message = compatibility.message(backend.version.as_deref());
    Json(json!({
        "webui": HERDR_WEBUI_VERSION,
        "backend": backend.version,
        "session": session_display_name(session.as_deref()),
        "protocol_version": PROTOCOL_VERSION,
        "min_protocol_version": MIN_SUPPORTED_PROTOCOL_VERSION,
        "backend_protocol_version": backend.protocol,
        "min_backend": MIN_BACKEND_VERSION,
        "max_tested_backend": MAX_TESTED_BACKEND_VERSION,
        "compatibility": {
            "status": compatibility.as_str(),
            "compatible": compatibility == BackendCompatibility::Compatible,
            "message": compatibility_message,
        }
    }))
    .into_response()
}

async fn launch_session(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let mut command = std::process::Command::new(&state.herdr_bin);
    command
        .arg("server")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_remove("HERDR_SOCKET_PATH")
        .env_remove("HERDR_CLIENT_SOCKET_PATH");
    let session = session_from_headers(&state, &headers);
    if let Some(session) = session.as_deref().filter(|value| *value != "default") {
        command.env("HERDR_SESSION", session);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    match command.spawn() {
        Ok(child) => Json(json!({ "ok": true, "pid": child.id() })).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn close_session(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:server:stop", "method": "server.stop", "params": {} }),
    )
}

#[derive(Deserialize)]
struct LoginRequest {
    username: String,
    password: String,
}

async fn login(
    State(state): State<WebState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<LoginRequest>,
) -> Response {
    let Ok(auth) = state.auth.lock() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "auth unavailable" })),
        )
            .into_response();
    };
    if remote.ip().is_loopback() && auth.localhost_no_auth {
        drop(auth);
        return login_response(&state);
    }
    let ok = auth
        .user
        .as_deref()
        .zip(auth.password.as_deref())
        .is_some_and(|(user, password)| {
            constant_time_eq(body.username.as_bytes(), user.as_bytes())
                && constant_time_eq(body.password.as_bytes(), password.as_bytes())
        });
    drop(auth);
    if !ok {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "unauthorized" })),
        )
            .into_response();
    }
    login_response(&state)
}

fn login_response(state: &WebState) -> Response {
    let token = state
        .auth
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

fn proxy_request(api: &ApiClient, request: serde_json::Value) -> Response {
    match api.request_value(request) {
        Ok(value) => Json(value).into_response(),
        Err(err) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
    }
}

async fn proxy_request_async(api: ApiClient, request: serde_json::Value) -> Response {
    match tokio::task::spawn_blocking(move || api.request_value(request)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn workspaces(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let api = api_for_headers(&state, &headers);
    match api.request_value(
        json!({ "id": "web:workspace:list", "method": "workspace.list", "params": {} }),
    ) {
        Ok(mut value) => {
            if let Ok(panes) = api.request_value(json!({ "id": "web:pane:list:workspace-cwds", "method": "pane.list", "params": { "workspace_id": null } })) {
                enrich_workspace_cwds(&mut value, &panes);
            }
            Json(value).into_response()
        }
        Err(err) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
    }
}

fn enrich_workspace_cwds(workspaces: &mut serde_json::Value, panes: &serde_json::Value) {
    use std::collections::HashMap;

    let mut cwd_by_workspace = HashMap::<String, (Option<String>, Option<String>)>::new();
    let pane_items = panes
        .pointer("/result/panes")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten();
    for pane in pane_items {
        let Some(workspace_id) = pane
            .get("workspace_id")
            .and_then(serde_json::Value::as_str)
            .filter(|value| !value.is_empty())
        else {
            continue;
        };
        cwd_by_workspace
            .entry(workspace_id.to_string())
            .or_insert_with(|| {
                (
                    pane.get("cwd")
                        .and_then(serde_json::Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                    pane.get("foreground_cwd")
                        .and_then(serde_json::Value::as_str)
                        .filter(|value| !value.is_empty())
                        .map(str::to_string),
                )
            });
    }

    let workspace_items = workspaces
        .pointer_mut("/result/workspaces")
        .and_then(serde_json::Value::as_array_mut)
        .into_iter()
        .flatten();
    for workspace in workspace_items {
        let Some(workspace_id) = workspace
            .get("workspace_id")
            .and_then(serde_json::Value::as_str)
        else {
            continue;
        };
        let Some((cwd, foreground_cwd)) = cwd_by_workspace.get(workspace_id) else {
            continue;
        };
        if workspace
            .get("cwd")
            .and_then(serde_json::Value::as_str)
            .is_none()
        {
            if let Some(cwd) = cwd {
                workspace["cwd"] = json!(cwd);
            }
        }
        if workspace
            .get("foreground_cwd")
            .and_then(serde_json::Value::as_str)
            .is_none()
        {
            if let Some(foreground_cwd) = foreground_cwd {
                workspace["foreground_cwd"] = json!(foreground_cwd);
            }
        }
    }
}

fn workspace_order_key(state: &WebState, headers: &HeaderMap) -> String {
    session_display_name(session_from_headers(state, headers).as_deref()).to_string()
}

fn open_created_worktree_request(
    cwd: &str,
    path: &str,
    label: Option<String>,
) -> serde_json::Value {
    json!({
        "id": "web:worktree:open-created",
        "method": "worktree.open",
        "params": {
            "workspace_id": null,
            "cwd": cwd,
            "path": path,
            "branch": null,
            "label": label,
            "focus": true,
        },
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HerdrWorktreeApiVersion {
    V0_7_0,
    V0_7_1,
}

impl HerdrWorktreeApiVersion {
    fn from_backend(version: Option<&str>) -> Self {
        let supports_native_existing_branch = version
            .and_then(crate::compat::SimpleVersion::parse)
            .is_some_and(|version| {
                version
                    >= (crate::compat::SimpleVersion {
                        major: 0,
                        minor: 7,
                        patch: 1,
                    })
            });
        if supports_native_existing_branch {
            Self::V0_7_1
        } else {
            Self::V0_7_0
        }
    }

    fn uses_native_existing_branch_create(self) -> bool {
        matches!(self, Self::V0_7_1)
    }
}

struct HerdrWorktreeApi {
    client: ApiClient,
    version: HerdrWorktreeApiVersion,
}

impl HerdrWorktreeApi {
    fn detect(client: ApiClient) -> Self {
        let backend = client.backend_info();
        let version = HerdrWorktreeApiVersion::from_backend(backend.version.as_deref());
        Self { client, version }
    }

    fn new(client: ApiClient) -> Self {
        Self {
            client,
            version: HerdrWorktreeApiVersion::V0_7_1,
        }
    }

    fn needs_legacy_existing_branch_create(&self) -> bool {
        !self.version.uses_native_existing_branch_create()
    }

    fn legacy_open_created_request(
        &self,
        cwd: &str,
        path: &str,
        label: Option<String>,
    ) -> serde_json::Value {
        let _ = self;
        open_created_worktree_request(cwd, path, label)
    }

    fn create_request(
        &self,
        body: CreateWorktreeRequest,
        cwd: Option<String>,
        path: Option<String>,
    ) -> serde_json::Value {
        let _ = self;
        json!({
            "id": "web:worktree:create",
            "method": "worktree.create",
            "params": {
                "workspace_id": body.workspace_id,
                "cwd": cwd,
                "branch": body.branch,
                "base": body.base,
                "path": path,
                "label": body.label,
                "focus": true,
            },
        })
    }

    fn remove_request(workspace_id: String, force: bool) -> serde_json::Value {
        json!({ "id": "web:worktree:remove", "method": "worktree.remove", "params": { "workspace_id": workspace_id, "force": force } })
    }
}

async fn workspace_order(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let key = workspace_order_key(&state, &headers);
    let order = state
        .workspace_orders
        .lock()
        .ok()
        .and_then(|orders| orders.get(&key).cloned())
        .unwrap_or_default();
    Json(json!({ "order": order })).into_response()
}

#[derive(Deserialize)]
struct WorkspaceOrderRequest {
    order: Vec<String>,
}

async fn set_workspace_order(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<WorkspaceOrderRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let key = workspace_order_key(&state, &headers);
    if let Ok(mut orders) = state.workspace_orders.lock() {
        orders.insert(key, body.order.clone());
    }
    Json(json!({ "ok": true, "order": body.order })).into_response()
}

async fn worktrees(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<WorkspaceQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let cwd = query.cwd.as_deref().map(expand_user_path_string);
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:worktree:list", "method": "worktree.list", "params": { "workspace_id": query.workspace_id, "cwd": cwd } }),
    )
}

#[derive(Deserialize)]
struct CreateWorktreeRequest {
    workspace_id: Option<String>,
    cwd: Option<String>,
    branch: Option<String>,
    base: Option<String>,
    path: Option<String>,
    label: Option<String>,
    pull_base: Option<bool>,
}

#[derive(Deserialize)]
struct OpenWorktreeRequest {
    workspace_id: Option<String>,
    cwd: Option<String>,
    path: Option<String>,
    branch: Option<String>,
    label: Option<String>,
}

#[derive(Deserialize)]
struct RemoveWorktreePathRequest {
    repo_root: String,
    path: String,
    force: Option<bool>,
}

#[derive(Deserialize)]
struct RemoveWorktreeRequest {
    force: Option<bool>,
}

async fn create_worktree(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateWorktreeRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let cwd = body.cwd.as_deref().map(expand_user_path_string);
    let path = body.path.as_deref().map(expand_user_path_string);
    let api = api_for_headers(&state, &headers);
    if body.pull_base.unwrap_or(false) {
        if let Some(cwd) = cwd.as_deref() {
            let base = body
                .base
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("HEAD");
            if let Err(err) = pull_base_branch(cwd, base) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "ok": false, "error": err })),
                )
                    .into_response();
            }
        }
    }
    if let (Some(cwd), Some(path), Some(branch)) = (&cwd, &path, body.branch.as_deref()) {
        let branch = branch.trim();
        if !branch.is_empty() && git_branch_exists(cwd, branch).unwrap_or(false) {
            let worktree_api = HerdrWorktreeApi::detect(api.clone());
            if !worktree_api.needs_legacy_existing_branch_create() {
                let request =
                    worktree_api.create_request(body, Some(cwd.clone()), Some(path.clone()));
                return proxy_request_async(worktree_api.client, request).await;
            }
            let base = body
                .base
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("HEAD");
            match create_worktree_checkout(cwd, path, branch, base) {
                Ok(()) => {
                    return proxy_request(
                        &worktree_api.client,
                        worktree_api.legacy_open_created_request(cwd, path, body.label),
                    );
                }
                Err(err) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({ "ok": false, "error": err })),
                    )
                        .into_response();
                }
            }
        }
    }
    let worktree_api = HerdrWorktreeApi::new(api);
    let request = worktree_api.create_request(body, cwd, path);
    proxy_request_async(worktree_api.client, request).await
}

fn run_git_capture(args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .output()
        .map_err(|err| err.to_string())
}

pub(crate) fn git_failure(output: std::process::Output, context: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("{context} failed with status {}", output.status)
    }
}

fn git_branch_exists(repo: &str, branch: &str) -> Result<bool, String> {
    let output = run_git_capture(&[
        "-C",
        repo,
        "show-ref",
        "--verify",
        "--quiet",
        &format!("refs/heads/{branch}"),
    ])?;
    if output.status.success() {
        Ok(true)
    } else if output.status.code() == Some(1) {
        Ok(false)
    } else {
        Err(git_failure(output, "git show-ref"))
    }
}

fn pull_base_branch(cwd: &str, base: &str) -> Result<(), String> {
    let output = if base == "HEAD" {
        run_git_capture(&["-C", cwd, "pull", "--ff-only"])?
    } else {
        run_git_capture(&["-C", cwd, "pull", "--ff-only", "origin", base])?
    };
    if output.status.success() {
        Ok(())
    } else {
        Err(git_failure(output, "git pull"))
    }
}

fn create_worktree_checkout(cwd: &str, path: &str, branch: &str, base: &str) -> Result<(), String> {
    if let Some(parent) = Path::new(path).parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let output = if git_branch_exists(cwd, branch)? {
        run_git_capture(&["-C", cwd, "worktree", "add", path, branch])?
    } else {
        run_git_capture(&["-C", cwd, "worktree", "add", "-b", branch, path, base])?
    };
    if output.status.success() {
        Ok(())
    } else {
        Err(git_failure(output, "git worktree add"))
    }
}

async fn open_worktree(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<OpenWorktreeRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let cwd = body.cwd.as_deref().map(expand_user_path_string);
    let path = body.path.as_deref().map(expand_user_path_string);
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({
            "id": "web:worktree:open",
            "method": "worktree.open",
            "params": {
                "workspace_id": body.workspace_id,
                "cwd": cwd,
                "path": path,
                "branch": body.branch,
                "label": body.label,
                "focus": true,
            },
        }),
    )
}

async fn remove_worktree_path(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<RemoveWorktreePathRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let repo_root = expand_user_path_string(&body.repo_root);
    let path = expand_user_path_string(&body.path);
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(&repo_root)
        .args(["worktree", "remove"]);
    if body.force.unwrap_or(false) {
        command.arg("--force");
    }
    command.arg(&path);
    match command.output() {
        Ok(output) if output.status.success() => {
            Json(json!({ "ok": true, "path": path })).into_response()
        }
        Ok(output) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": String::from_utf8_lossy(&output.stderr).trim() })),
        )
            .into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}
async fn agents(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:agent:list", "method": "agent.list", "params": {} }),
    )
}

#[derive(Deserialize)]
struct WorkspaceQuery {
    workspace_id: Option<String>,
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct GitBranchesQuery {
    cwd: Option<String>,
}

#[derive(Serialize)]
struct GitBranchesResponse {
    branches: Vec<String>,
}

fn expand_path_prefix(prefix: &str) -> PathBuf {
    if prefix == "~" {
        return home_dir().unwrap_or_else(|_| PathBuf::from(prefix));
    }
    if let Some(rest) = prefix.strip_prefix("~/") {
        return home_dir()
            .map(|home| home.join(rest))
            .unwrap_or_else(|_| PathBuf::from(prefix));
    }
    let path = PathBuf::from(prefix);
    if path.is_absolute() {
        path
    } else {
        home_dir()
            .map(|home| home.join(path))
            .unwrap_or_else(|_| PathBuf::from(prefix))
    }
}

pub(crate) fn expand_user_path_string(path: &str) -> String {
    expand_path_prefix(path).to_string_lossy().to_string()
}

fn list_git_branches(cwd: &str) -> io::Result<Vec<String>> {
    let cwd = expand_path_prefix(cwd);
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["for-each-ref", "--format=%(refname:short)", "refs/heads"])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(
            String::from_utf8_lossy(&output.stderr).trim().to_string(),
        ));
    }
    let mut branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    branches.sort();
    branches.dedup();
    Ok(branches)
}

async fn git_branches(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<GitBranchesQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let Some(cwd) = query.cwd.as_deref() else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "cwd is required" })),
        )
            .into_response();
    };
    match list_git_branches(cwd) {
        Ok(branches) => Json(GitBranchesResponse { branches }).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn tabs(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<WorkspaceQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:tab:list", "method": "tab.list", "params": { "workspace_id": query.workspace_id } }),
    )
}

async fn panes(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<WorkspaceQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:pane:list", "method": "pane.list", "params": { "workspace_id": query.workspace_id } }),
    )
}

#[derive(Deserialize)]
struct PaneLayoutQuery {
    pane_id: Option<String>,
}

async fn pane_layout(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<PaneLayoutQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:pane:layout", "method": "pane.layout", "params": { "pane_id": query.pane_id } }),
    )
}

#[derive(Deserialize)]
struct CreateWorkspaceRequest {
    cwd: Option<String>,
    label: Option<String>,
}

fn existing_workspace_cwd(cwd: Option<&str>) -> Result<Option<String>, Box<Response>> {
    let Some(cwd) = cwd.map(str::trim).filter(|cwd| !cwd.is_empty()) else {
        return Ok(None);
    };
    let expanded = expand_user_path_string(cwd);
    if !Path::new(&expanded).is_dir() {
        return Err(Box::new(
            (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "workspace folder must exist" })),
            )
                .into_response(),
        ));
    }
    Ok(Some(expanded))
}

async fn create_workspace(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateWorkspaceRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let cwd = match existing_workspace_cwd(body.cwd.as_deref()) {
        Ok(cwd) => cwd,
        Err(response) => return *response,
    };
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:workspace:create", "method": "workspace.create", "params": { "cwd": cwd, "focus": false, "label": body.label, "env": {} } }),
    )
}

#[derive(Deserialize)]
struct RenameWorkspaceRequest {
    label: String,
}

async fn rename_workspace(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(workspace_id): AxumPath<String>,
    Json(body): Json<RenameWorkspaceRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:workspace:rename", "method": "workspace.rename", "params": { "workspace_id": workspace_id, "label": body.label } }),
    )
}

async fn close_workspace(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(workspace_id): AxumPath<String>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:workspace:close", "method": "workspace.close", "params": { "workspace_id": workspace_id } }),
    )
}

async fn remove_worktree(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(workspace_id): AxumPath<String>,
    body: Option<Json<RemoveWorktreeRequest>>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let request = HerdrWorktreeApi::remove_request(
        workspace_id,
        body.as_ref().and_then(|body| body.force).unwrap_or(false),
    );
    proxy_request_async(api_for_headers(&state, &headers), request).await
}

#[derive(Deserialize)]
struct CreateTabRequest {
    workspace_id: Option<String>,
    label: Option<String>,
}

async fn create_tab(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateTabRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:tab:create", "method": "tab.create", "params": { "workspace_id": body.workspace_id, "focus": false, "label": body.label, "env": {} } }),
    )
}

#[derive(Deserialize)]
struct RenameTabRequest {
    label: String,
}

async fn rename_tab(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(tab_id): AxumPath<String>,
    Json(body): Json<RenameTabRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:tab:rename", "method": "tab.rename", "params": { "tab_id": tab_id, "label": body.label } }),
    )
}

async fn close_tab(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(tab_id): AxumPath<String>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:tab:close", "method": "tab.close", "params": { "tab_id": tab_id } }),
    )
}

async fn close_pane(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(pane_id): AxumPath<String>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:pane:close", "method": "pane.close", "params": { "pane_id": pane_id } }),
    )
}

async fn events_ws(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<SessionQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let api = query
        .session
        .as_deref()
        .map(|session| ApiClient {
            socket_path: api_socket_path_for(Some(session)),
        })
        .unwrap_or_else(|| api_for_headers(&state, &headers));
    ws.on_upgrade(move |socket| events_socket(state, api, socket))
}

async fn events_socket(state: WebState, api: ApiClient, mut socket: WebSocket) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    let subscribe_api = api.clone();
    std::thread::spawn(move || {
        let request = json!({
            "id": "web:events",
            "method": "events.subscribe",
            "params": { "subscriptions": [
                {"type":"workspace.created"}, {"type":"workspace.updated"}, {"type":"workspace.renamed"}, {"type":"workspace.closed"}, {"type":"workspace.focused"},
                {"type":"worktree.created"}, {"type":"worktree.opened"}, {"type":"worktree.removed"},
                {"type":"tab.created"}, {"type":"tab.closed"}, {"type":"tab.focused"}, {"type":"tab.renamed"},
                {"type":"pane.created"}, {"type":"pane.closed"}, {"type":"pane.focused"}, {"type":"pane.moved"}, {"type":"pane.exited"}, {"type":"pane.agent_detected"}, {"type":"pane.agent_status_changed"}
            ]}
        });
        let Ok(mut stream) = subscribe_api.subscribe(request) else {
            let _ = tx
                .send(json!({ "type": "error", "message": "failed to subscribe to Herdr events" }));
            return;
        };
        let _ = tx.send(json!({ "type": "ready" }));
        loop {
            match stream.next_value() {
                Ok(Some(value)) => {
                    if tx.send(json!({ "type": "event", "event": value })).is_err() {
                        break;
                    }
                }
                Ok(None) => break,
                Err(err) => {
                    let _ = tx.send(json!({ "type": "error", "message": err.to_string() }));
                    break;
                }
            }
        }
    });

    let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        tokio::select! {
            Some(value) = rx.recv() => {
                if socket.send(Message::Text(value.to_string().into())).await.is_err() { break; }
            }
            _ = interval.tick() => {
                let agents = api.request_value(json!({ "id": "web:agent:list:poll", "method": "agent.list", "params": {} })).ok();
                if let Some(agents) = &agents {
                    sync_auto_no_sleep_from_agents(&state, agents);
                }
                let workspaces = api.request_value(json!({ "id": "web:workspace:list:poll", "method": "workspace.list", "params": {} })).ok();
                let value = json!({ "type": "snapshot", "agents": agents, "workspaces": workspaces });
                if socket.send(Message::Text(value.to_string().into())).await.is_err() { break; }
            }
            message = socket.recv() => {
                if message.is_none() { break; }
            }
        }
    }
}

#[derive(Deserialize)]
struct TerminalQuery {
    terminal_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    session: Option<String>,
}

#[derive(Deserialize)]
struct SessionQuery {
    session: Option<String>,
}

async fn terminal_ws(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<TerminalQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let client_socket_path = query
        .session
        .as_deref()
        .map(|session| client_socket_path_for(Some(session)))
        .unwrap_or_else(|| client_socket_for_headers(&state, &headers));
    ws.on_upgrade(move |socket| terminal_socket(client_socket_path, query, socket))
}

async fn terminal_socket(path: PathBuf, query: TerminalQuery, mut socket: WebSocket) {
    let terminal_id = query.terminal_id.clone();
    let cols = query.cols.unwrap_or(100).max(1);
    let rows = query.rows.unwrap_or(30).max(1);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let (in_tx, in_rx) = std::sync::mpsc::channel::<ClientMessage>();

    std::thread::spawn(move || {
        let mut stream =
            match connect_terminal_attach_with_protocol_fallback(&path, &terminal_id, cols, rows) {
                Ok(stream) => stream,
                Err(error) => {
                    let _ = out_tx.send(error.user_message().into_bytes());
                    return;
                }
            };

        let Ok(mut writer) = stream.try_clone() else {
            let _ = out_tx.send(b"failed to clone herdr terminal socket\r\n".to_vec());
            return;
        };
        std::thread::spawn(move || {
            for message in in_rx {
                if write_message(&mut writer, &message).is_err() {
                    break;
                }
            }
        });

        loop {
            match read_message::<_, ServerMessage>(&mut stream, MAX_GRAPHICS_FRAME_SIZE) {
                Ok(ServerMessage::Terminal(frame)) => {
                    if out_tx.send(frame.bytes).is_err() {
                        break;
                    }
                }
                Ok(ServerMessage::Graphics { bytes }) => {
                    if out_tx.send(bytes).is_err() {
                        break;
                    }
                }
                Ok(ServerMessage::ServerShutdown { .. }) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
    });

    loop {
        tokio::select! {
            Some(bytes) = out_rx.recv() => {
                if socket.send(Message::Binary(bytes.into())).await.is_err() { break; }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Binary(data))) => {
                        if in_tx.send(ClientMessage::Input { data: data.to_vec() }).is_err() { break; }
                    }
                    Some(Ok(Message::Text(text))) => {
                        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) {
                            if value.get("type").and_then(|value| value.as_str()) == Some("resize") {
                                let cols = value.get("cols").and_then(|value| value.as_u64()).unwrap_or(100).min(u16::MAX as u64) as u16;
                                let rows = value.get("rows").and_then(|value| value.as_u64()).unwrap_or(30).min(u16::MAX as u64) as u16;
                                let _ = in_tx.send(ClientMessage::Resize { cols: cols.max(1), rows: rows.max(1), cell_width_px: 0, cell_height_px: 0 });
                            } else if value.get("type").and_then(|value| value.as_str()) == Some("scroll") {
                                let direction = match value.get("direction").and_then(|value| value.as_str()) {
                                    Some("up") => AttachScrollDirection::Up,
                                    Some("down") => AttachScrollDirection::Down,
                                    _ => AttachScrollDirection::Down,
                                };
                                let lines = value.get("lines").and_then(|value| value.as_u64()).unwrap_or(3).clamp(1, u16::MAX as u64) as u16;
                                let column = value.get("column").and_then(|value| value.as_u64()).and_then(|value| u16::try_from(value).ok());
                                let row = value.get("row").and_then(|value| value.as_u64()).and_then(|value| u16::try_from(value).ok());
                                let modifiers = value.get("modifiers").and_then(|value| value.as_u64()).and_then(|value| u8::try_from(value).ok()).unwrap_or(0);
                                let _ = in_tx.send(ClientMessage::AttachScroll {
                                    source: AttachScrollSource::Wheel,
                                    direction,
                                    lines,
                                    column,
                                    row,
                                    modifiers,
                                });
                            } else if value.get("type").and_then(|value| value.as_str()) == Some("key") {
                                if value.get("code").and_then(|value| value.as_str()) == Some("Enter") {
                                    let modifiers = value.get("modifiers").and_then(|value| value.as_u64()).and_then(|value| u8::try_from(value).ok()).unwrap_or(0);
                                    let _ = in_tx.send(ClientMessage::InputEvents { events: vec![ClientInputEvent::Key { code: ClientKeyCode::Enter, modifiers, kind: ClientKeyKind::Press }] });
                                }
                            } else if let Some(input) = value.get("input").and_then(|value| value.as_str()) {
                                let _ = in_tx.send(ClientMessage::Input { data: input.as_bytes().to_vec() });
                            }
                        } else {
                            let _ = in_tx.send(ClientMessage::Input { data: text.to_string().into_bytes() });
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
        }
    }
    let _ = in_tx.send(ClientMessage::Detach);
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum TerminalAttachError {
    Connect,
    SendHandshake,
    ReadHandshake,
    Rejected(String),
    Attach,
}

impl TerminalAttachError {
    fn user_message(&self) -> String {
        match self {
            Self::Connect => "failed to connect to herdr client socket\r\n".to_string(),
            Self::SendHandshake => "failed to send herdr handshake\r\n".to_string(),
            Self::ReadHandshake => "failed to read herdr handshake\r\n".to_string(),
            Self::Rejected(error) => format!("herdr rejected terminal connection: {error}\r\n"),
            Self::Attach => "failed to attach herdr terminal\r\n".to_string(),
        }
    }
}

fn connect_terminal_attach_with_protocol_fallback(
    path: &Path,
    terminal_id: &str,
    cols: u16,
    rows: u16,
) -> Result<LocalStream, TerminalAttachError> {
    match connect_terminal_attach(path, terminal_id, PROTOCOL_VERSION, cols, rows) {
        Err(TerminalAttachError::Rejected(error))
            if should_retry_legacy_protocol(PROTOCOL_VERSION, &error) =>
        {
            connect_terminal_attach(
                path,
                terminal_id,
                MIN_SUPPORTED_PROTOCOL_VERSION,
                cols,
                rows,
            )
        }
        result => result,
    }
}

fn connect_terminal_attach(
    path: &Path,
    terminal_id: &str,
    protocol_version: u32,
    cols: u16,
    rows: u16,
) -> Result<LocalStream, TerminalAttachError> {
    let mut stream = connect_local_stream(path).map_err(|_| TerminalAttachError::Connect)?;
    let hello = ClientMessage::Hello {
        version: protocol_version,
        cols,
        rows,
        cell_width_px: 0,
        cell_height_px: 0,
        requested_encoding: RenderEncoding::TerminalAnsi,
        keybindings: ClientKeybindings::Server,
        launch_mode: ClientLaunchMode::TerminalAttach,
    };
    write_message(&mut stream, &hello).map_err(|_| TerminalAttachError::SendHandshake)?;

    match read_message::<_, ServerMessage>(&mut stream, MAX_FRAME_SIZE)
        .map_err(|_| TerminalAttachError::ReadHandshake)?
    {
        ServerMessage::Welcome {
            error: Some(error), ..
        } => return Err(TerminalAttachError::Rejected(error)),
        ServerMessage::Welcome { error: None, .. } => {}
        _ => return Err(TerminalAttachError::ReadHandshake),
    }

    write_message(
        &mut stream,
        &ClientMessage::AttachTerminal {
            terminal_id: terminal_id.to_owned(),
            takeover: true,
        },
    )
    .map_err(|_| TerminalAttachError::Attach)?;
    Ok(stream)
}

fn should_retry_legacy_protocol(protocol_version: u32, error: &str) -> bool {
    protocol_version == PROTOCOL_VERSION
        && PROTOCOL_VERSION > MIN_SUPPORTED_PROTOCOL_VERSION
        && error.contains("client version")
        && error.contains("newer than server version")
}

#[cfg(test)]
mod tests {
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
        let (rebind_tx, _) = tokio::sync::watch::channel(bind);
        WebState {
            api_socket: Some(PathBuf::from("/tmp/default-api.sock")),
            client_socket: Some(PathBuf::from("/tmp/default-client.sock")),
            session_name: None,
            herdr_bin: "herdr".to_string(),
            auth: Arc::new(Mutex::new(AuthConfig {
                user: Some("user".to_string()),
                password: Some("pass".to_string()),
                localhost_no_auth: false,
                token: "token-123".to_string(),
            })),
            server_settings: Arc::new(Mutex::new(RuntimeServerSettings {
                bind,
                user: Some("user".to_string()),
                password: Some("pass".to_string()),
                localhost_no_auth: false,
                no_sleep_auto_cooldown_seconds: 60,
            })),
            no_sleep: Arc::new(Mutex::new(NoSleepState::default())),
            rebind_tx,
            workspace_orders: Arc::new(Mutex::new(HashMap::new())),
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

    #[cfg(unix)]
    fn fake_api_socket(response: serde_json::Value) -> (PathBuf, thread::JoinHandle<()>) {
        use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

        let path = std::env::temp_dir().join(format!(
            "herdr-webui-api-test-{}.sock",
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
        assert_eq!(config.session, None);
        assert_eq!(config.api_socket, None);
        assert_eq!(config.client_socket, None);
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
        ]
        .map(String::from);

        let config = WebConfig::parse(&args).unwrap();

        assert_eq!(config.bind, "0.0.0.0:9999".parse::<SocketAddr>().unwrap());
        assert_eq!(config.session.as_deref(), Some("work"));
        assert_eq!(
            config.api_socket.as_deref(),
            Some(Path::new("/tmp/api.sock"))
        );
        assert_eq!(
            config.client_socket.as_deref(),
            Some(Path::new("/tmp/client.sock"))
        );
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
    }

    #[test]
    fn rejects_invalid_config_flags() {
        let missing = ["--bind"].map(String::from);
        let invalid_bind = ["--bind", "not-a-socket"].map(String::from);
        let unknown = ["--unknown"].map(String::from);

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
        let _guard = env_lock().lock().unwrap();
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
            api_for_headers(&state, &headers).socket_path,
            PathBuf::from("/tmp/default-api.sock")
        );
        assert_eq!(
            client_socket_for_headers(&state, &headers),
            PathBuf::from("/tmp/default-client.sock")
        );

        let mut session_headers = HeaderMap::new();
        session_headers.insert("x-herdr-session", HeaderValue::from_static("work"));

        assert!(api_for_headers(&state, &session_headers)
            .socket_path
            .ends_with("sessions/work/herdr.sock"));
        assert!(client_socket_for_headers(&state, &session_headers)
            .ends_with("sessions/work/herdr-client.sock"));
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
    fn default_runtime_server_settings_use_no_credentials_and_local_bypass() {
        let settings = default_runtime_server_settings("127.0.0.1:8787".parse().unwrap());

        assert_eq!(settings.bind, "127.0.0.1:8787".parse().unwrap());
        assert_eq!(settings.user, None);
        assert_eq!(settings.password, None);
        assert!(settings.localhost_no_auth);
        assert_eq!(settings.no_sleep_auto_cooldown_seconds, 60);
    }

    #[test]
    fn missing_runtime_settings_file_creates_defaults() {
        let _guard = env_lock().lock().unwrap();
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
        assert!(raw.contains("no_sleep_auto_cooldown_seconds"));

        let _ = fs::remove_dir_all(config_home);
        std::env::remove_var("XDG_CONFIG_HOME");
    }

    #[test]
    fn existing_runtime_settings_file_backfills_missing_keys() {
        let _guard = env_lock().lock().unwrap();
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
        assert_eq!(settings.user, None);
        assert_eq!(settings.password, None);
        assert!(settings.localhost_no_auth);
        assert_eq!(settings.no_sleep_auto_cooldown_seconds, 60);
        let raw = fs::read_to_string(path).unwrap();
        assert!(raw.contains("localhost_no_auth"));
        assert!(raw.contains("user"));
        assert!(raw.contains("password"));
        assert!(raw.contains("no_sleep_auto_cooldown_seconds"));

        let _ = fs::remove_dir_all(config_home);
        std::env::remove_var("XDG_CONFIG_HOME");
    }

    #[test]
    fn loads_auth_from_runtime_settings() {
        let auth = AuthConfig::from_settings(&RuntimeServerSettings {
            bind: "0.0.0.0:8787".parse().unwrap(),
            user: Some("test-user".to_string()),
            password: Some("test-password".to_string()),
            localhost_no_auth: false,
            no_sleep_auto_cooldown_seconds: 60,
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
            user: None,
            password: None,
            localhost_no_auth: true,
            no_sleep_auto_cooldown_seconds: 60,
        }) {
            Ok(_) => panic!("expected public auth config to fail"),
            Err(err) => err,
        };

        assert_eq!(public_err.kind(), io::ErrorKind::PermissionDenied);
    }

    #[allow(clippy::await_holding_lock)]
    #[tokio::test]
    async fn server_settings_api_reports_and_updates_runtime_settings() {
        let _guard = env_lock().lock().unwrap();
        let config_home = std::env::temp_dir().join(format!(
            "herdr-webui-settings-api-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::env::set_var("XDG_CONFIG_HOME", &config_home);
        let app = test_app();

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
        assert_eq!(before_body["username"], "user");
        assert_eq!(before_body["no_sleep_auto_cooldown_seconds"], 60);

        let updated = app
            .oneshot(
                request(Method::POST, "/api/server-settings")
                    .header(header::COOKIE, "herdr_web_session=token-123")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({
                            "bind": "0.0.0.0:8787",
                            "username": "test-user",
                            "password": "test-password",
                            "localhost_no_auth": true,
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
        assert!(server_settings_path().exists());

        let _ = fs::remove_dir_all(config_home);
        std::env::remove_var("XDG_CONFIG_HOME");
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
        assert!(constant_time_eq(b"same", b"same"));
        assert!(!constant_time_eq(b"same", b"diff"));
        assert!(!constant_time_eq(b"same", b"same-but-longer"));
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
        assert_eq!(
            backend_compatibility_for_supported_range(Some("0.6.9"), Some(PROTOCOL_VERSION)),
            BackendCompatibility::TooOld
        );
        assert_eq!(
            backend_compatibility_for_supported_range(
                Some("0.7.0"),
                Some(MIN_SUPPORTED_PROTOCOL_VERSION),
            ),
            BackendCompatibility::Compatible
        );
        assert_eq!(
            backend_compatibility_for_supported_range(Some("0.7.0"), Some(PROTOCOL_VERSION)),
            BackendCompatibility::Compatible
        );
        assert_eq!(
            backend_compatibility_for_supported_range(Some("0.7.1"), Some(PROTOCOL_VERSION)),
            BackendCompatibility::Compatible
        );
        assert_eq!(
            backend_compatibility_for_supported_range(Some("0.7.3"), Some(PROTOCOL_VERSION)),
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
            backend_compatibility_for_supported_range(Some("0.7.0"), None),
            BackendCompatibility::Unknown
        );
        assert_eq!(
            backend_compatibility_for_supported_range(Some("0.7.0"), Some(PROTOCOL_VERSION + 1)),
            BackendCompatibility::ProtocolMismatch
        );
    }

    #[test]
    fn terminal_protocol_fallback_retries_only_newer_client_mismatch() {
        assert!(should_retry_legacy_protocol(
            PROTOCOL_VERSION,
            "client version 15 is newer than server version 14; please upgrade the herdr server",
        ));
        assert!(!should_retry_legacy_protocol(
            MIN_SUPPORTED_PROTOCOL_VERSION,
            "client version 14 is newer than server version 13; please upgrade the herdr server",
        ));
        assert!(!should_retry_legacy_protocol(
            PROTOCOL_VERSION,
            "client version 15 is older than the minimum supported version 16",
        ));
        assert!(!should_retry_legacy_protocol(
            PROTOCOL_VERSION,
            "invalid local keybindings",
        ));
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
                socket_path: PathBuf::from("/tmp/herdr.sock"),
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
            bincode::serde::encode_to_vec(&ClientMessage::Detach, bincode::config::standard())
                .unwrap();
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
            "result": { "version": "0.7.0", "protocol": PROTOCOL_VERSION }
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

        assert_eq!(body["backend"], "0.7.0");
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
        let app = test_app();
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
            .is_some_and(|value| value.contains("herdr_web_session=token-123")));
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
    async fn static_asset_routes_serve_embedded_content() {
        let app = test_app();
        let js = app
            .clone()
            .oneshot(
                request(Method::GET, "/assets/xterm.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let css = app
            .clone()
            .oneshot(
                request(Method::GET, "/assets/xterm.css")
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
        assert_eq!(font.status(), StatusCode::OK);
        assert_eq!(app_js.status(), StatusCode::OK);
        assert_eq!(app_boot_js.status(), StatusCode::OK);
        assert_eq!(app_core_js.status(), StatusCode::OK);
        assert_eq!(desktop_search_js.status(), StatusCode::OK);
        assert_eq!(app_css.status(), StatusCode::OK);
        assert_eq!(desktop_search_css.status(), StatusCode::OK);
        assert_eq!(desktop_shortcuts_css.status(), StatusCode::OK);
        assert_eq!(mobile_attention_js.status(), StatusCode::OK);
        assert_eq!(mobile_core_js.status(), StatusCode::OK);
        assert_eq!(mobile_terminal_js.status(), StatusCode::OK);
        assert_eq!(mobile_worktrees_js.status(), StatusCode::OK);
        assert_eq!(mobile_settings_js.status(), StatusCode::OK);
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
}
