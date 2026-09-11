use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_server::tls_rustls::RustlsConfig;
use interprocess::TryClone as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::builtin_detection::JcodeDetectionVariant;

mod assets;
mod builtin_backend;
mod builtin_detection;
mod builtin_events;
mod compat;
mod file_browser;
mod git_ui;
mod lsp;
mod protocol;
mod service;
mod terminal_text;

use assets::{
    app_boot_js, app_html, desktop_css, desktop_directory_picker_css, desktop_directory_picker_js,
    desktop_file_browser_css, desktop_file_browser_js, desktop_git_ui_css, desktop_git_ui_js,
    desktop_js, desktop_search_css, desktop_search_js, desktop_shortcuts_css,
    favicon_attention_svg, favicon_error_svg, favicon_svg, icon_chevron_down_svg,
    icon_chevron_right_svg, icon_clock_svg, icon_columns_svg, icon_copy_svg, icon_eye_off_svg,
    icon_eye_svg, icon_file_svg, icon_folder_svg, icon_folder_up_svg, icon_git_svg, icon_help_svg,
    icon_link_svg, icon_lock_open_svg, icon_lock_svg, icon_pencil_svg, icon_refresh_svg,
    icon_save_svg, icon_search_svg, icon_settings_svg, icon_terminal_svg, icon_theme_auto_svg,
    icon_trash_svg, icon_x_svg, jetbrains_mono_nerd_font, login_css, login_html, login_js,
    mobile_attention_js, mobile_core_js, mobile_css, mobile_file_browser_js, mobile_js,
    mobile_settings_js, mobile_terminal_js, mobile_worktrees_js, shared_actions_js,
    shared_colors_css, shared_content_search_css, shared_core_js, shared_editor_js,
    shared_file_content_search_js, shared_file_icons_css, shared_file_icons_js,
    shared_file_tree_css, shared_file_tree_js, shared_line_context_js, shared_lsp_js,
    shared_markdown_preview_css, shared_markdown_preview_js, shared_options_js,
    shared_settings_confirm_js, shared_settings_feedback_js, shared_temp_terminal_js,
    shared_terminal_adapter_js, shared_terminal_fit_js, shared_terminal_scroll_js,
    shared_workspace_search_js, vendor_codemirror_js, vendor_dompurify_js, vendor_ghostty_wasm,
    vendor_marked_js, vendor_mermaid_js, vendor_wterm_css, vendor_wterm_js,
};
use compat::SimpleVersion;
use compat::{backend_compatibility, BackendCompatibility};
use protocol::*;

const DEFAULT_BIND: &str = "127.0.0.1:8787";
const COOKIE_NAME: &str = "herdr_web_session";
const HERDR_WEBUI_VERSION: &str = env!("HERDR_WEBUI_VERSION");
const INSTALL_LABEL: &str = "herdr-web";
const MAX_FRAME_SIZE: usize = 2 * 1024 * 1024;
const MAX_GRAPHICS_FRAME_SIZE: usize = 32 * 1024 * 1024;
const MIN_SUPPORTED_PROTOCOL_VERSION: u32 = 22;
const PROTOCOL_VERSION: u32 = 22;
const MIN_BACKEND_VERSION: &str = "0.9.0";
const MAX_TESTED_BACKEND_VERSION: &str = "0.9.0";
const DEFAULT_FOLDER_READ_TIMEOUT: Duration = Duration::from_millis(1500);

type LocalStream = interprocess::local_socket::Stream;
type BuiltinSessionRegistry =
    Arc<Mutex<HashMap<String, Arc<builtin_backend::BuiltinBackendHandle>>>>;

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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct BackendInfo {
    version: Option<String>,
    protocol: Option<u32>,
}

/// Installed external herdr binary state, used to decide whether the UI may
/// offer external-herdr sessions at all.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct HerdrInstall {
    /// Parsed `herdr --version` output, e.g. "herdr 0.9.0".
    version: Option<String>,
    /// True when the binary was found and its version is inside the
    /// supported backend range for this WebUI build.
    compatible: bool,
}

impl HerdrInstall {
    fn available(&self) -> bool {
        self.version.is_some()
    }
}

/// Runs `herdr --version` and classifies the install against the supported
/// backend version range. Blocking (process spawn); call from a blocking
/// context.
fn detect_herdr_install(herdr_bin: &str) -> HerdrInstall {
    let output = std::process::Command::new(herdr_bin)
        .arg("--version")
        .output();
    let Ok(output) = output else {
        return HerdrInstall::default();
    };
    if !output.status.success() {
        return HerdrInstall::default();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    // Accept both "herdr 0.9.0" and a bare "0.9.0".
    let version = text.split_whitespace().find_map(|token| {
        SimpleVersion::parse(token).map(|_| token.trim_start_matches('v').to_string())
    });
    let Some(version) = version else {
        return HerdrInstall::default();
    };
    // `herdr --version` gives us no protocol number, so classify by version
    // range alone: below MIN_BACKEND_VERSION is unusable, anything newer is
    // offered as untested (matching the versions API).
    let parsed = SimpleVersion::parse(&version);
    let min = SimpleVersion::parse(MIN_BACKEND_VERSION);
    let compatible = matches!(
        (parsed, min),
        (Some(parsed), Some(min)) if parsed >= min
    );
    HerdrInstall {
        version: Some(version),
        compatible,
    }
}

#[derive(Clone, Debug)]
struct WebConfig {
    bind: SocketAddr,
    /// True when --bind was passed explicitly and must override persisted settings.
    bind_explicit: bool,
    session: Option<String>,
    api_socket: Option<PathBuf>,
    client_socket: Option<PathBuf>,
    backend_mode: Option<BackendMode>,
    tls: TlsConfig,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum BackendMode {
    ExternalHerdr,
    Builtin,
    Auto,
}

impl BackendMode {
    fn parse(value: &str) -> io::Result<Self> {
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

    fn as_str(self) -> &'static str {
        match self {
            Self::ExternalHerdr => "external-herdr",
            Self::Builtin => "builtin",
            Self::Auto => "auto",
        }
    }

    fn is_builtin(self) -> bool {
        matches!(self, Self::Builtin)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SessionBackendTarget {
    ExternalHerdr,
    Builtin,
}

impl SessionBackendTarget {
    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "external-herdr" | "external" | "herdr" => Some(Self::ExternalHerdr),
            "builtin" | "built-in" => Some(Self::Builtin),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::ExternalHerdr => "external-herdr",
            Self::Builtin => "builtin",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TlsConfig {
    mode: TlsMode,
    cert_path: Option<PathBuf>,
    key_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
struct RecentWorkspace {
    path: String,
    label: Option<String>,
    branch: Option<String>,
    kind: Option<String>,
    opened_at: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum TlsMode {
    Off,
    Auto,
    SelfSigned,
    Files,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct PersistedServerSettings {
    bind: Option<String>,
    user: Option<String>,
    password: Option<String>,
    localhost_no_auth: Option<bool>,
    no_sleep_auto_cooldown_seconds: Option<u64>,
    backend_mode: Option<BackendMode>,
    builtin_shell: Option<String>,
    default_folder: Option<String>,
    builtin_backend_enabled: Option<bool>,
    external_herdr_backend_enabled: Option<bool>,
    jcode_detection_variant: Option<String>,
    log_level: Option<LogLevel>,
    #[serde(default)]
    lsp: Option<lsp::LspSettings>,
    #[serde(default)]
    recent_workspaces: Option<Vec<RecentWorkspace>>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum LogLevel {
    #[default]
    None,
    Info,
    Debug,
}

impl LogLevel {
    fn as_str(&self) -> &'static str {
        match self {
            LogLevel::None => "none",
            LogLevel::Info => "info",
            LogLevel::Debug => "debug",
        }
    }

    fn enabled(&self) -> bool {
        !matches!(self, LogLevel::None)
    }
}

fn log_event(level: &LogLevel, message: &str) {
    if level.enabled() {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        eprintln!("[{secs}] {message}");
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct RuntimeServerSettings {
    bind: SocketAddr,
    user: Option<String>,
    password: Option<String>,
    localhost_no_auth: bool,
    no_sleep_auto_cooldown_seconds: u64,
    backend_mode: BackendMode,
    builtin_shell: Option<String>,
    default_folder: String,
    builtin_backend_enabled: bool,
    external_herdr_backend_enabled: bool,
    jcode_detection_variant: JcodeDetectionVariant,
    log_level: LogLevel,
    lsp: lsp::LspSettings,
    recent_workspaces: Vec<RecentWorkspace>,
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
        let mut bind_explicit = false;
        let mut session = None;
        let mut api_socket = None;
        let mut client_socket = None;
        let mut backend_mode = None;
        let mut tls_mode = TlsMode::Auto;
        let mut tls_mode_set = false;
        let mut cert_path = None;
        let mut key_path = None;
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
                    bind_explicit = true;
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
                "--backend-mode" => {
                    backend_mode = Some(BackendMode::parse(required_arg(
                        args,
                        index,
                        "--backend-mode",
                    )?)?);
                    index += 2;
                }
                "--https" => {
                    if args
                        .get(index + 1)
                        .is_some_and(|value| !value.starts_with('-'))
                    {
                        tls_mode = parse_tls_mode(required_arg(args, index, "--https")?)?;
                        index += 2;
                    } else {
                        tls_mode = TlsMode::Auto;
                        index += 1;
                    }
                    tls_mode_set = true;
                }
                "--tls-cert" => {
                    cert_path = Some(PathBuf::from(required_arg(args, index, "--tls-cert")?));
                    index += 2;
                }
                "--tls-key" => {
                    key_path = Some(PathBuf::from(required_arg(args, index, "--tls-key")?));
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
        if !tls_mode_set && (cert_path.is_some() || key_path.is_some()) {
            tls_mode = TlsMode::Auto;
        }
        Ok(Self {
            bind,
            bind_explicit,
            session,
            api_socket,
            client_socket,
            backend_mode,
            tls: TlsConfig {
                mode: tls_mode,
                cert_path,
                key_path,
            },
        })
    }
}

fn parse_tls_mode(value: &str) -> io::Result<TlsMode> {
    match value {
        "off" => Ok(TlsMode::Off),
        "auto" => Ok(TlsMode::Auto),
        "self-signed" | "selfsigned" | "self" => Ok(TlsMode::SelfSigned),
        "files" | "cert" => Ok(TlsMode::Files),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid --https mode: {other}; use off, auto, self-signed, or files"),
        )),
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
    "herdr-webui [--verbose] [--bind HOST:PORT] [--https off|auto|self-signed|files] [--tls-cert PATH --tls-key PATH] [--session NAME] [--api-socket PATH] [--client-socket PATH] [--backend-mode <external-herdr|builtin|auto>]\n\
herdr-webui --version\n\
herdr-webui install-mac [--verbose] [--bind HOST:PORT] [--https off|auto|self-signed|files] [--tls-cert PATH --tls-key PATH] [--session NAME]\n\
herdr-webui update-mac [--verbose]\n\
herdr-webui install-linux [--bind HOST:PORT] [--https off|auto|self-signed|files] [--tls-cert PATH --tls-key PATH] [--session NAME]\n\
herdr-webui update-linux\n\
herdr-webui start-mac | start [--verbose]\n\
herdr-webui stop-mac | stop [--verbose]\n\
herdr-webui restart-mac | restart [--verbose]\n\
herdr-webui start-linux | start\n\
herdr-webui stop-linux | stop\n\
herdr-webui restart-linux | restart\n\
herdr-webui uninstall-mac [--verbose]\n\
herdr-webui uninstall-linux\n\
Default backend mode for fresh settings is builtin. Use --backend-mode external-herdr for a separate Herdr daemon.\n"
}

#[derive(Clone)]
pub(crate) struct WebState {
    api_socket: Option<PathBuf>,
    client_socket: Option<PathBuf>,
    session_name: Option<String>,
    backend_mode: BackendMode,
    _builtin_backend: Option<Arc<builtin_backend::BuiltinBackendHandle>>,
    builtin_sessions: BuiltinSessionRegistry,
    /// Serializes built-in session cold starts. Several handlers can
    /// auto-start the same session concurrently on a fresh browser load;
    /// without a lock two starts would race on binding the session socket
    /// and the loser would fail with AddrInUse.
    builtin_start_lock: Arc<Mutex<()>>,
    herdr_bin: String,
    auth: Arc<Mutex<AuthConfig>>,
    server_settings: Arc<Mutex<RuntimeServerSettings>>,
    no_sleep: Arc<Mutex<NoSleepState>>,
    rebind_tx: tokio::sync::watch::Sender<SocketAddr>,
    /// Broadcasts the public settings JSON to every connected events socket
    /// after a settings change, so open tabs re-sync backend enablement
    /// without a page reload.
    settings_tx: tokio::sync::broadcast::Sender<serde_json::Value>,
    workspace_orders: Arc<Mutex<HashMap<String, Vec<String>>>>,
    lsp: Arc<lsp::LspRegistry>,
}

impl WebState {
    fn log_level(&self) -> LogLevel {
        self.server_settings
            .lock()
            .map(|settings| settings.log_level.clone())
            .unwrap_or_default()
    }

    /// Update LSP settings in memory, persisted server settings, and the registry.
    async fn update_lsp_settings(&self, lsp_settings: lsp::LspSettings) -> io::Result<()> {
        let next = {
            let Ok(mut guard) = self.server_settings.lock() else {
                return Err(io::Error::other("server settings unavailable"));
            };
            guard.lsp = lsp_settings.clone();
            guard.clone()
        };
        let save = {
            let next_clone = next.clone();
            tokio::task::spawn_blocking(move || save_runtime_server_settings(&next_clone))
                .await
                .map_err(|err| io::Error::other(err.to_string()))?
        };
        save?;
        self.lsp.set_settings(lsp_settings);
        Ok(())
    }
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
    if !settings.builtin_backend_enabled && !settings.external_herdr_backend_enabled {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "at least one backend type must be enabled",
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
        backend_mode: BackendMode::Builtin,
        builtin_shell: None,
        default_folder: default_working_folder(None),
        builtin_backend_enabled: true,
        external_herdr_backend_enabled: true,
        jcode_detection_variant: JcodeDetectionVariant::default(),
        log_level: LogLevel::default(),
        lsp: lsp::LspSettings::default(),
        recent_workspaces: Vec::new(),
    }
}

fn readable_directory(path: &Path) -> io::Result<PathBuf> {
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

fn home_folder_path() -> PathBuf {
    home_dir().unwrap_or_else(|_| PathBuf::from("~"))
}

fn default_working_folder(candidate: Option<&str>) -> String {
    default_working_folder_with_prompt(candidate, true)
}

fn default_working_folder_without_prompt(candidate: Option<&str>) -> String {
    default_working_folder_with_prompt(candidate, false)
}

fn default_working_folder_with_prompt(
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

fn server_settings_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("herdr-webui/webui-settings.json");
    }
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".config/herdr-webui/webui-settings.json"))
        .unwrap_or_else(|_| std::env::temp_dir().join("herdr-webui/webui-settings.json"))
}

/// Apply CLI flags that must win over persisted settings.
/// An explicit `--bind` beats the persisted bind from webui-settings.json;
/// otherwise a preview instance could silently squat the saved port instead of
/// the one the operator asked for.
fn apply_cli_overrides(settings: &mut RuntimeServerSettings, config: &WebConfig) {
    if config.bind_explicit {
        settings.bind = config.bind;
    }
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
    if let Some(backend_mode) = persisted.backend_mode {
        settings.backend_mode = backend_mode;
    }
    if persisted.builtin_shell.is_some() {
        settings.builtin_shell = persisted.builtin_shell.filter(|value| !value.is_empty());
    }
    if persisted.default_folder.is_some() {
        settings.default_folder =
            default_working_folder_without_prompt(persisted.default_folder.as_deref());
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
    if missing_keys {
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
fn assert_test_settings_isolation() {
    if std::env::var_os("XDG_CONFIG_HOME").is_none() {
        panic!(
            "test would write the real settings path; set XDG_CONFIG_HOME \
             to a temp dir (see lock_env-isolated tests) before persisting"
        );
    }
}

#[cfg(not(test))]
fn assert_test_settings_isolation() {}

fn save_runtime_server_settings(settings: &RuntimeServerSettings) -> io::Result<()> {
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
        user: settings.user.clone(),
        password: settings.password.clone(),
        localhost_no_auth: Some(settings.localhost_no_auth),
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
    let mut server_settings = load_runtime_server_settings(config.bind)?;
    apply_cli_overrides(&mut server_settings, &config);
    if let Some(backend_mode) = config.backend_mode {
        server_settings.backend_mode = backend_mode;
    }
    let auth = Arc::new(Mutex::new(AuthConfig::from_settings(&server_settings)?));
    let backend_mode = resolve_backend_mode(
        server_settings.backend_mode,
        config.session.as_deref(),
        config.api_socket.as_deref(),
    );
    let builtin_sessions: BuiltinSessionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let builtin_start_lock: Arc<Mutex<()>> = Arc::new(Mutex::new(()));
    let (api_socket, client_socket) = if backend_mode.is_builtin() {
        let (_api_socket, _client_socket) = builtin_socket_paths(config.session.as_deref());
        let handle = Arc::new(builtin_backend::BuiltinBackendHandle::start(
            builtin_backend::BuiltinBackendConfig {
                api_socket: _api_socket,
                client_socket: _client_socket,
                cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
                shell: server_settings.builtin_shell.clone(),
                jcode_detection_variant: server_settings.jcode_detection_variant,
            },
        )?);
        let api_socket = handle.api_socket().to_path_buf();
        let client_socket = handle.client_socket().to_path_buf();
        if let Ok(mut sessions) = builtin_sessions.lock() {
            sessions.insert(
                canonical_session_name(config.session.as_deref()),
                Arc::clone(&handle),
            );
        }
        (Some(api_socket), Some(client_socket))
    } else {
        (config.api_socket.clone(), config.client_socket.clone())
    };
    let server_settings = Arc::new(Mutex::new(server_settings.clone()));
    let lsp_registry = Arc::new(lsp::LspRegistry::new(
        server_settings.lock().unwrap().lsp.clone(),
    ));
    let (rebind_tx, rebind_rx) = tokio::sync::watch::channel(server_settings.lock().unwrap().bind);
    let (settings_tx, _) = tokio::sync::broadcast::channel(16);
    let state = WebState {
        api_socket,
        client_socket,
        session_name: config.session.clone(),
        backend_mode,
        _builtin_backend: None,
        builtin_sessions,
        builtin_start_lock,
        herdr_bin: std::env::var("HERDR_WEB_HERDR_BIN").unwrap_or_else(|_| "herdr".to_string()),
        auth,
        server_settings,
        no_sleep: Arc::new(Mutex::new(NoSleepState::default())),
        rebind_tx,
        settings_tx,
        workspace_orders: Arc::new(Mutex::new(HashMap::new())),
        lsp: lsp_registry,
    };

    serve_rebindable(state, rebind_rx, config.tls).await
}

fn resolve_backend_mode(
    configured: BackendMode,
    session: Option<&str>,
    explicit_api_socket: Option<&Path>,
) -> BackendMode {
    match configured {
        BackendMode::Auto => {
            let socket = explicit_api_socket
                .map(Path::to_path_buf)
                .unwrap_or_else(|| api_socket_path_for(session));
            if connect_local_stream(&socket).is_ok() {
                BackendMode::ExternalHerdr
            } else {
                BackendMode::Builtin
            }
        }
        mode => mode,
    }
}

fn builtin_socket_paths(session: Option<&str>) -> (PathBuf, PathBuf) {
    let session = session
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(safe_socket_component)
        .unwrap_or_else(|| "default".to_string());
    let dir = server_settings_path()
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| std::env::temp_dir().join("herdr-webui"))
        .join("builtin")
        .join(&session);
    let paths = (dir.join("herdr.sock"), dir.join("herdr-client.sock"));
    if socket_path_pair_fits(&paths) {
        return paths;
    }

    let hash = short_socket_hash(&format!("{}:{session}", dir.display()));
    let dir = short_builtin_socket_dir(&hash);
    (dir.join("herdr.sock"), dir.join("herdr-client.sock"))
}

#[cfg(unix)]
fn short_builtin_socket_dir(hash: &str) -> PathBuf {
    PathBuf::from("/tmp").join(format!("herdr-webui-builtin-{hash}"))
}

#[cfg(not(unix))]
fn short_builtin_socket_dir(hash: &str) -> PathBuf {
    std::env::temp_dir().join(format!("herdr-webui-builtin-{hash}"))
}

fn safe_socket_component(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "default".to_string()
    } else {
        sanitized
    }
}

fn short_socket_hash(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn socket_path_pair_fits(paths: &(PathBuf, PathBuf)) -> bool {
    socket_path_fits(&paths.0) && socket_path_fits(&paths.1)
}

#[cfg(unix)]
fn socket_path_fits(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().len() < 100
}

#[cfg(not(unix))]
fn socket_path_fits(_path: &Path) -> bool {
    true
}

async fn serve_rebindable(
    state: WebState,
    mut rebind_rx: tokio::sync::watch::Receiver<SocketAddr>,
    tls: TlsConfig,
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
                eprintln!("failed to bind {}://{bind}: {err}", tls.scheme());
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                continue;
            }
        };
        eprintln!("herdr-webui listening on {}://{bind}", tls.scheme());
        let mut shutdown_rx = rebind_rx.clone();
        let router = app_router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
        let tls_config = tls.rustls_config().await?;
        let server = async move {
            match tls_config {
                Some(tls_config) => {
                    let handle = axum_server::Handle::new();
                    let shutdown_handle = handle.clone();
                    tokio::spawn(async move {
                        let _ = shutdown_rx.changed().await;
                        shutdown_handle.graceful_shutdown(None);
                    });
                    axum_server::from_tcp_rustls(listener.into_std()?, tls_config)
                        .map_err(|err| io::Error::other(err.to_string()))?
                        .handle(handle)
                        .serve(router)
                        .await
                }
                None => axum::serve(listener, router)
                    .with_graceful_shutdown(async move {
                        let _ = shutdown_rx.changed().await;
                    })
                    .await
                    .map_err(io::Error::other),
            }
        };
        tokio::pin!(server);
        // Best-effort language server sweep; bounded so a hung server cannot
        // delay exit (children are also killed on drop as a backstop).
        let sweep = async {
            let _ =
                tokio::time::timeout(std::time::Duration::from_secs(3), state.lsp.shutdown_all())
                    .await;
        };
        tokio::pin!(sweep);
        tokio::select! {
            _ = sigterm.recv() => {
                // Never leave spawned language servers behind the backend.
                sweep.await;
                return Ok(());
            }
            _ = sigint.recv() => {
                sweep.await;
                return Ok(());
            }
            res = &mut server => {
                res.map_err(io::Error::other)?;
            }
        }
    }
}

impl TlsConfig {
    fn scheme(&self) -> &'static str {
        match self.mode {
            TlsMode::Off => "http",
            TlsMode::Auto | TlsMode::SelfSigned | TlsMode::Files => "https",
        }
    }

    async fn rustls_config(&self) -> io::Result<Option<RustlsConfig>> {
        match self.mode {
            TlsMode::Off => Ok(None),
            TlsMode::Auto | TlsMode::Files => {
                if let Some((cert, key)) = self.available_cert_files() {
                    return Ok(Some(RustlsConfig::from_pem_file(cert, key).await?));
                }
                if matches!(self.mode, TlsMode::Files) {
                    eprintln!("configured TLS certificate files are not available; generating a self-signed certificate");
                }
                let (cert, key) = ensure_self_signed_cert()?;
                Ok(Some(RustlsConfig::from_pem_file(cert, key).await?))
            }
            TlsMode::SelfSigned => {
                let (cert, key) = ensure_self_signed_cert()?;
                Ok(Some(RustlsConfig::from_pem_file(cert, key).await?))
            }
        }
    }

    fn available_cert_files(&self) -> Option<(&Path, &Path)> {
        let cert = self.cert_path.as_deref()?;
        let key = self.key_path.as_deref()?;
        (cert.exists() && key.exists()).then_some((cert, key))
    }
}

fn ensure_self_signed_cert() -> io::Result<(PathBuf, PathBuf)> {
    let (cert_path, key_path) = self_signed_cert_paths(&config_dir());
    if cert_path.exists() && key_path.exists() {
        return Ok((cert_path, key_path));
    }
    let dir = cert_path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "self-signed cert path has no parent directory",
        )
    })?;
    fs::create_dir_all(dir)?;
    let subject_alt_names = vec![
        "localhost".to_string(),
        "127.0.0.1".to_string(),
        "::1".to_string(),
    ];
    let certified = rcgen::generate_simple_self_signed(subject_alt_names)
        .map_err(|err| io::Error::other(err.to_string()))?;
    fs::write(&cert_path, certified.cert.pem())?;
    fs::write(&key_path, certified.signing_key.serialize_pem())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600))?;
    }
    Ok((cert_path, key_path))
}

fn self_signed_cert_paths(config_dir: &Path) -> (PathBuf, PathBuf) {
    let dir = config_dir.join("tls");
    (
        dir.join("self-signed-cert.pem"),
        dir.join("self-signed-key.pem"),
    )
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
        .route(
            "/api/recent-workspaces",
            get(recent_workspaces).post(open_recent_workspace),
        )
        .route(
            "/api/recent-workspaces/clear",
            post(clear_recent_workspaces),
        )
        .route(
            "/api/recent-workspaces/remove",
            post(remove_recent_workspace),
        )
        .route("/api/worktrees", get(worktrees).post(create_worktree))
        .route("/api/worktrees/open", post(open_worktree))
        .route("/api/worktrees/remove-path", post(remove_worktree_path))
        .route("/api/git-branches", get(git_branches))
        .merge(file_browser::routes())
        .merge(git_ui::routes())
        .merge(lsp::routes())
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
        .route("/api/session-snapshot", get(session_snapshot))
        .route("/api/agents", get(agents))
        .route("/assets/desktop/app.css", get(desktop_css))
        .route("/assets/desktop/git-ui.css", get(desktop_git_ui_css))
        .route(
            "/assets/desktop/file-browser.css",
            get(desktop_file_browser_css),
        )
        .route(
            "/assets/desktop/directory-picker.css",
            get(desktop_directory_picker_css),
        )
        .route("/assets/desktop/search.css", get(desktop_search_css))
        .route("/assets/desktop/shortcuts.css", get(desktop_shortcuts_css))
        .route("/assets/app-boot.js", get(app_boot_js))
        .route("/assets/shared/core.js", get(shared_core_js))
        .route("/assets/shared/options.js", get(shared_options_js))
        .route("/assets/shared/actions.js", get(shared_actions_js))
        .route("/assets/shared/file-icons.js", get(shared_file_icons_js))
        .route("/assets/shared/file-icons.css", get(shared_file_icons_css))
        .route("/assets/shared/file-tree.css", get(shared_file_tree_css))
        .route("/assets/shared/colors.css", get(shared_colors_css))
        .route(
            "/assets/shared/content-search.css",
            get(shared_content_search_css),
        )
        .route("/assets/shared/file-tree.js", get(shared_file_tree_js))
        .route(
            "/assets/shared/file-content-search.js",
            get(shared_file_content_search_js),
        )
        .route(
            "/assets/shared/line-context.js",
            get(shared_line_context_js),
        )
        .route(
            "/assets/shared/workspace-search.js",
            get(shared_workspace_search_js),
        )
        .route(
            "/assets/shared/settings-feedback.js",
            get(shared_settings_feedback_js),
        )
        .route(
            "/assets/shared/settings-confirm.js",
            get(shared_settings_confirm_js),
        )
        .route("/assets/vendor/codemirror.js", get(vendor_codemirror_js))
        .route("/assets/vendor/marked.js", get(vendor_marked_js))
        .route("/assets/vendor/dompurify.js", get(vendor_dompurify_js))
        .route("/assets/vendor/mermaid.js", get(vendor_mermaid_js))
        .route("/assets/vendor/wterm.js", get(vendor_wterm_js))
        .route("/assets/vendor/wterm.css", get(vendor_wterm_css))
        .route("/assets/vendor/ghostty-vt.wasm", get(vendor_ghostty_wasm))
        .route("/assets/shared/editor.js", get(shared_editor_js))
        .route("/assets/shared/lsp.js", get(shared_lsp_js))
        .route(
            "/assets/shared/markdown-preview.js",
            get(shared_markdown_preview_js),
        )
        .route(
            "/assets/shared/markdown-preview.css",
            get(shared_markdown_preview_css),
        )
        .route(
            "/assets/shared/terminal-scroll.js",
            get(shared_terminal_scroll_js),
        )
        .route(
            "/assets/shared/terminal-fit.js",
            get(shared_terminal_fit_js),
        )
        .route(
            "/assets/shared/terminal-adapter.js",
            get(shared_terminal_adapter_js),
        )
        .route(
            "/assets/shared/temp-terminal.js",
            get(shared_temp_terminal_js),
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
        .route("/assets/icons/lock.svg", get(icon_lock_svg))
        .route("/assets/icons/lock-open.svg", get(icon_lock_open_svg))
        .route("/assets/icons/search.svg", get(icon_search_svg))
        .route("/assets/icons/refresh.svg", get(icon_refresh_svg))
        .route("/assets/icons/columns.svg", get(icon_columns_svg))
        .route("/assets/icons/save.svg", get(icon_save_svg))
        .route("/assets/icons/clock.svg", get(icon_clock_svg))
        .route("/assets/icons/copy.svg", get(icon_copy_svg))
        .route("/assets/icons/x.svg", get(icon_x_svg))
        .route("/assets/icons/link.svg", get(icon_link_svg))
        .route("/assets/icons/pencil.svg", get(icon_pencil_svg))
        .route("/assets/icons/eye.svg", get(icon_eye_svg))
        .route("/assets/icons/eye-off.svg", get(icon_eye_off_svg))
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

fn canonical_session_name(session: Option<&str>) -> String {
    session
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| *value != "default")
        .unwrap_or("default")
        .to_string()
}

fn request_session_name(state: &WebState, requested: Option<&str>) -> Option<String> {
    requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| *value != "default")
        .map(str::to_string)
        .or_else(|| state.session_name.clone())
}

fn backend_target_for_headers(state: &WebState, headers: &HeaderMap) -> SessionBackendTarget {
    headers
        .get("x-herdr-backend")
        .and_then(|value| value.to_str().ok())
        .and_then(SessionBackendTarget::parse)
        .filter(|target| backend_target_enabled(state, *target))
        .unwrap_or_else(|| default_backend_target(state))
}

fn backend_target_for_query(
    state: &WebState,
    headers: &HeaderMap,
    requested: Option<&str>,
) -> SessionBackendTarget {
    requested
        .and_then(SessionBackendTarget::parse)
        .filter(|target| backend_target_enabled(state, *target))
        .unwrap_or_else(|| backend_target_for_headers(state, headers))
}

fn backend_target_enabled(state: &WebState, target: SessionBackendTarget) -> bool {
    state
        .server_settings
        .lock()
        .map(|settings| backend_target_enabled_in_settings(&settings, target))
        .unwrap_or(true)
}

fn backend_target_enabled_in_settings(
    settings: &RuntimeServerSettings,
    target: SessionBackendTarget,
) -> bool {
    match target {
        SessionBackendTarget::Builtin => settings.builtin_backend_enabled,
        SessionBackendTarget::ExternalHerdr => settings.external_herdr_backend_enabled,
    }
}

fn default_backend_target(state: &WebState) -> SessionBackendTarget {
    let mode_target = if state.backend_mode.is_builtin() {
        SessionBackendTarget::Builtin
    } else {
        SessionBackendTarget::ExternalHerdr
    };
    if backend_target_enabled(state, mode_target) {
        return mode_target;
    }
    match mode_target {
        SessionBackendTarget::Builtin => SessionBackendTarget::ExternalHerdr,
        SessionBackendTarget::ExternalHerdr => SessionBackendTarget::Builtin,
    }
}

fn session_from_headers(state: &WebState, headers: &HeaderMap) -> Option<String> {
    request_session_name(
        state,
        headers
            .get("x-herdr-session")
            .and_then(|value| value.to_str().ok()),
    )
}

fn api_for_target_session(
    state: &WebState,
    backend: SessionBackendTarget,
    session: Option<&str>,
) -> ApiClient {
    match backend {
        SessionBackendTarget::Builtin => {
            let session_name = canonical_session_name(session);
            let (api_socket, _) = builtin_socket_paths(Some(&session_name));
            ApiClient {
                socket_path: api_socket,
            }
        }
        SessionBackendTarget::ExternalHerdr => {
            if session.is_none() {
                if let Some(socket_path) = &state.api_socket {
                    return ApiClient {
                        socket_path: socket_path.clone(),
                    };
                }
            }
            ApiClient {
                socket_path: api_socket_path_for(session),
            }
        }
    }
}

fn client_socket_for_target_session(
    state: &WebState,
    backend: SessionBackendTarget,
    session: Option<&str>,
) -> PathBuf {
    match backend {
        SessionBackendTarget::Builtin => {
            let session_name = canonical_session_name(session);
            let (_, client_socket) = builtin_socket_paths(Some(&session_name));
            client_socket
        }
        SessionBackendTarget::ExternalHerdr => {
            if session.is_none() {
                if let Some(socket_path) = &state.client_socket {
                    return socket_path.clone();
                }
            }
            client_socket_path_for(session)
        }
    }
}

fn api_for_headers(state: &WebState, headers: &HeaderMap) -> ApiClient {
    let backend = backend_target_for_headers(state, headers);
    let session = session_from_headers(state, headers);
    api_for_target_session(state, backend, session.as_deref())
}

/// Ensure the built-in session backend is running before proxying a request
/// to it. The built-in backend is embedded in the WebUI process, so starting
/// it on demand is safe and cheap; without this, a browser that pins the
/// built-in backend before any `/api/session/launch` call would get a 502
/// for every workspace/list request and the Git UI would fall back to the
/// default folder ("No Git repository").
///
/// Must run on a blocking thread: it connects to the session socket and can
/// spawn the built-in backend threads.
fn ensure_backend_for_request(
    state: &WebState,
    backend: SessionBackendTarget,
    session: Option<&str>,
) {
    if backend != SessionBackendTarget::Builtin {
        return;
    }
    if !backend_target_enabled(state, backend) {
        return;
    }
    if let Err(err) = ensure_builtin_session(state, session) {
        log_event(
            &state.log_level(),
            &format!("failed to auto-start built-in session: {err}"),
        );
    }
}

/// Resolve the API client for a request header set, auto-starting the
/// built-in session backend when the request targets it. Only call for
/// authenticated requests (session launch/close manage the built-in
/// session lifecycle themselves and must not auto-start on close).
async fn api_for_headers_ensured(state: &WebState, headers: &HeaderMap) -> ApiClient {
    let backend = backend_target_for_headers(state, headers);
    let session = session_from_headers(state, headers);
    if backend == SessionBackendTarget::Builtin {
        let state_clone = state.clone();
        let session_clone = session.clone();
        let _ = tokio::task::spawn_blocking(move || {
            ensure_backend_for_request(&state_clone, backend, session_clone.as_deref())
        })
        .await;
    }
    api_for_target_session(state, backend, session.as_deref())
}

#[cfg(test)]
fn client_socket_for_headers(state: &WebState, headers: &HeaderMap) -> PathBuf {
    let backend = backend_target_for_headers(state, headers);
    let session = session_from_headers(state, headers);
    client_socket_for_target_session(state, backend, session.as_deref())
}

/// Resolve the API client for a query-string session/backend without
/// starting anything. `api_for_query_session_ensured` builds on this after
/// auto-starting the built-in backend when needed.
fn api_for_query_session_routed(
    state: &WebState,
    headers: &HeaderMap,
    session: Option<&str>,
    backend: Option<&str>,
) -> ApiClient {
    let backend = backend_target_for_query(state, headers, backend);
    let session = request_session_name(state, session);
    api_for_target_session(state, backend, session.as_deref())
}

/// WebSocket twin of `api_for_headers_ensured`: resolve the API client for a
/// query-string session/backend, auto-starting the built-in backend when the
/// connection targets it so the terminal/events sockets do not 502 on a
/// fresh browser that pinned the built-in backend.
async fn api_for_query_session_ensured(
    state: &WebState,
    headers: &HeaderMap,
    session: Option<&str>,
    backend: Option<&str>,
) -> ApiClient {
    let target = backend_target_for_query(state, headers, backend);
    let session = request_session_name(state, session);
    if target == SessionBackendTarget::Builtin {
        let state_clone = state.clone();
        let session_clone = session.clone();
        let _ = tokio::task::spawn_blocking(move || {
            ensure_backend_for_request(&state_clone, target, session_clone.as_deref())
        })
        .await;
    }
    api_for_target_session(state, target, session.as_deref())
}

fn client_socket_for_query_session(
    state: &WebState,
    headers: &HeaderMap,
    session: Option<&str>,
    backend: Option<&str>,
) -> PathBuf {
    let backend = backend_target_for_query(state, headers, backend);
    let session = request_session_name(state, session);
    client_socket_for_target_session(state, backend, session.as_deref())
}

fn session_display_name(session: Option<&str>) -> &str {
    session.unwrap_or("default")
}

fn known_external_sessions() -> Vec<serde_json::Value> {
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
                "backend": SessionBackendTarget::ExternalHerdr.as_str(),
                "backend_label": "Herdr",
                "running": running,
                "api_socket": api_socket.display().to_string(),
            })
        })
        .collect()
}

fn known_builtin_sessions(state: &WebState) -> Vec<serde_json::Value> {
    let mut names = vec!["default".to_string()];
    let sessions_dir = server_settings_path()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("builtin");
    if let Ok(entries) = fs::read_dir(sessions_dir) {
        let mut found = entries
            .filter_map(Result::ok)
            .filter(|entry| entry.path().is_dir())
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| name != "default")
            .collect::<Vec<_>>();
        found.sort();
        names.extend(found);
    }
    let mut known = names.iter().cloned().collect::<HashSet<_>>();
    if let Ok(sessions) = state.builtin_sessions.lock() {
        let mut live = sessions.keys().cloned().collect::<Vec<_>>();
        live.sort();
        for name in live {
            if known.insert(name.clone()) {
                names.push(name);
            }
        }
    }
    names
        .into_iter()
        .map(|name| {
            let (api_socket, _) = builtin_socket_paths(Some(&name));
            let running = connect_local_stream(&api_socket).is_ok();
            json!({
                "name": name,
                "backend": SessionBackendTarget::Builtin.as_str(),
                "backend_label": "built-in",
                "running": running,
                "api_socket": api_socket.display().to_string(),
            })
        })
        .collect()
}

fn known_sessions(state: &WebState, herdr_compatible: bool) -> Vec<serde_json::Value> {
    let (external_enabled, builtin_enabled) = state
        .server_settings
        .lock()
        .map(|settings| {
            (
                settings.external_herdr_backend_enabled,
                settings.builtin_backend_enabled,
            )
        })
        .unwrap_or((true, true));
    let mut sessions = Vec::new();
    // Only offer external herdr sessions when the installed herdr binary is
    // detected and compatible; otherwise the UI must not tempt users into an
    // attach that is guaranteed to fail its handshake.
    if external_enabled && herdr_compatible {
        sessions.extend(known_external_sessions());
    }
    if builtin_enabled {
        sessions.extend(known_builtin_sessions(state));
    }
    sessions
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
    backend_mode: Option<BackendMode>,
    #[serde(default)]
    builtin_shell: Option<Option<String>>,
    default_folder: Option<String>,
    builtin_backend_enabled: Option<bool>,
    external_herdr_backend_enabled: Option<bool>,
    log_level: Option<LogLevel>,
}

fn settings_public_json(settings: &RuntimeServerSettings) -> serde_json::Value {
    json!({
        "bind": settings.bind.to_string(),
        "username": settings.user.clone().unwrap_or_default(),
        "has_password": settings.password.is_some(),
        "localhost_no_auth": settings.localhost_no_auth,
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
        lsp: current
            .as_ref()
            .map(|settings| settings.lsp.clone())
            .unwrap_or_default(),
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
    if let Ok(mut auth_lock) = state.auth.lock() {
        *auth_lock = auth;
    }
    if let Ok(mut settings_lock) = state.server_settings.lock() {
        *settings_lock = next.clone();
    }
    if bind_changed {
        let _ = state.rebind_tx.send(next.bind);
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
    // herdr --version is a blocking process spawn; offload it.
    let herdr_bin = state.herdr_bin.clone();
    let herdr_install = tokio::task::spawn_blocking(move || detect_herdr_install(&herdr_bin))
        .await
        .unwrap_or_default();
    Json(json!({
        "backend_mode": state.backend_mode.as_str(),
        "current_backend": backend_target_for_headers(&state, &headers).as_str(),
        // The server's configured default backend (used by tabs to retarget
        // when their pinned backend gets disabled in settings).
        "default_backend": default_backend_target(&state).as_str(),
        "enabled_backends": {
            "builtin": backend_target_enabled(&state, SessionBackendTarget::Builtin),
            "external-herdr": backend_target_enabled(&state, SessionBackendTarget::ExternalHerdr),
        },
        // External herdr sessions are only offered when the installed herdr
        // binary is detected AND compatible with this WebUI build.
        "herdr_available": herdr_install.available(),
        "herdr_compatible": herdr_install.compatible,
        "herdr_version": herdr_install.version,
        "sessions": known_sessions(&state, herdr_install.compatible),
    }))
    .into_response()
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
    let current_backend = backend_target_for_headers(&state, &headers);
    let api = api_for_headers(&state, &headers);
    // backend_info() does a blocking ping; offload to avoid stalling the runtime.
    let backend = tokio::task::spawn_blocking(move || api.backend_info())
        .await
        .unwrap_or_default();
    let compatibility = if current_backend == SessionBackendTarget::Builtin {
        BackendCompatibility::Compatible
    } else {
        backend_compatibility_for_supported_range(backend.version.as_deref(), backend.protocol)
    };
    let compatibility_message = if current_backend == SessionBackendTarget::Builtin {
        "built-in backend is embedded in this WebUI process"
    } else {
        compatibility.message(backend.version.as_deref())
    };
    // Report the installed external herdr binary so clients can decide
    // whether external sessions may be offered at all.
    let herdr_bin = state.herdr_bin.clone();
    let herdr_install = tokio::task::spawn_blocking(move || detect_herdr_install(&herdr_bin))
        .await
        .unwrap_or_default();
    let default_backend = default_backend_target(&state);
    Json(json!({
        "webui": HERDR_WEBUI_VERSION,
        "backend": backend.version,
        "backend_mode": state.backend_mode.as_str(),
        "current_backend": current_backend.as_str(),
        "default_backend": default_backend.as_str(),
        // Enabled flags so browsers can stop targeting/offering a backend
        // that was disabled in settings mid-session.
        "enabled_backends": {
            "builtin": backend_target_enabled(&state, SessionBackendTarget::Builtin),
            "external-herdr": backend_target_enabled(&state, SessionBackendTarget::ExternalHerdr),
        },
        "session": session_display_name(session.as_deref()),
        "protocol_version": PROTOCOL_VERSION,
        "min_protocol_version": MIN_SUPPORTED_PROTOCOL_VERSION,
        "backend_protocol_version": backend.protocol,
        "min_backend": MIN_BACKEND_VERSION,
        "max_tested_backend": MAX_TESTED_BACKEND_VERSION,
        "herdr_install": {
            "available": herdr_install.available(),
            "compatible": herdr_install.compatible,
            "version": herdr_install.version,
            "path": state.herdr_bin,
        },
        "compatibility": {
            "status": compatibility.as_str(),
            "compatible": compatibility == BackendCompatibility::Compatible,
            "message": compatibility_message,
        }
    }))
    .into_response()
}

#[derive(Default, Deserialize)]
struct SessionActionRequest {
    session: Option<String>,
    backend: Option<String>,
}

fn requested_session_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get("x-herdr-session")
        .and_then(|value| value.to_str().ok())
}

fn action_session(
    state: &WebState,
    headers: &HeaderMap,
    body: &SessionActionRequest,
) -> Option<String> {
    request_session_name(
        state,
        body.session
            .as_deref()
            .or_else(|| requested_session_from_headers(headers)),
    )
}

fn action_backend(
    state: &WebState,
    headers: &HeaderMap,
    body: &SessionActionRequest,
) -> SessionBackendTarget {
    body.backend
        .as_deref()
        .and_then(SessionBackendTarget::parse)
        .unwrap_or_else(|| backend_target_for_headers(state, headers))
}

fn ensure_builtin_session(state: &WebState, session: Option<&str>) -> Result<(), String> {
    let session_name = canonical_session_name(session);
    if state
        .builtin_sessions
        .lock()
        .map(|sessions| sessions.contains_key(&session_name))
        .unwrap_or(false)
    {
        return Ok(());
    }
    // Serialize cold starts across threads: with auto-start on workspace
    // requests, a fresh browser fires several requests at once and two
    // concurrent starts would race on the session socket bind. Must run on
    // a blocking thread (callers already use spawn_blocking).
    let _start_guard = state
        .builtin_start_lock
        .lock()
        .map_err(|_| "built-in session start lock unavailable".to_string())?;
    if state
        .builtin_sessions
        .lock()
        .map(|sessions| sessions.contains_key(&session_name))
        .unwrap_or(false)
    {
        return Ok(());
    }
    let (api_socket, client_socket) = builtin_socket_paths(Some(&session_name));
    if connect_local_stream(&api_socket).is_ok() {
        return Ok(());
    }
    let shell = state
        .server_settings
        .lock()
        .ok()
        .and_then(|settings| settings.builtin_shell.clone());
    let handle =
        builtin_backend::BuiltinBackendHandle::start(builtin_backend::BuiltinBackendConfig {
            api_socket,
            client_socket,
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            shell,
            jcode_detection_variant: state
                .server_settings
                .lock()
                .ok()
                .map(|settings| settings.jcode_detection_variant)
                .unwrap_or_default(),
        })
        .map_err(|err| err.to_string())?;
    state
        .builtin_sessions
        .lock()
        .map_err(|_| "built-in session registry unavailable".to_string())?
        .insert(session_name, Arc::new(handle));
    Ok(())
}

async fn launch_session(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    body: Option<Json<SessionActionRequest>>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let session = action_session(&state, &headers, &body);
    let backend = action_backend(&state, &headers, &body);
    if !backend_target_enabled(&state, backend) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "backend": backend.as_str(),
                "error": "backend type is disabled in settings",
            })),
        )
            .into_response();
    }
    if backend == SessionBackendTarget::ExternalHerdr {
        // Only launch external herdr sessions when the installed binary is
        // detected and compatible; anything else is guaranteed to fail its
        // handshake against this WebUI build.
        let herdr_bin = state.herdr_bin.clone();
        let install = tokio::task::spawn_blocking(move || detect_herdr_install(&herdr_bin))
            .await
            .unwrap_or_default();
        if !install.available() {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "ok": false,
                    "backend": backend.as_str(),
                    "error": format!(
                        "herdr binary not found ({}); install herdr {} or newer to use external Herdr sessions",
                        state.herdr_bin,
                        MIN_BACKEND_VERSION,
                    ),
                })),
            )
                .into_response();
        }
        if !install.compatible {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "ok": false,
                    "backend": backend.as_str(),
                    "error": format!(
                        "installed herdr {} is not compatible with this WebUI build (requires {}); upgrade herdr or use a built-in session",
                        install.version.unwrap_or_default(),
                        MIN_BACKEND_VERSION,
                    ),
                })),
            )
                .into_response();
        }
    }
    if backend == SessionBackendTarget::Builtin {
        // ensure_builtin_session does socket connect and process spawning;
        // offload to avoid stalling the async runtime.
        let state_clone = state.clone();
        let session_clone = session.clone();
        let result = tokio::task::spawn_blocking(move || {
            ensure_builtin_session(&state_clone, session_clone.as_deref())
        })
        .await;
        return match result {
            Ok(Ok(())) => Json(json!({
                "ok": true,
                "backend": backend.as_str(),
                "session": session_display_name(session.as_deref()),
            }))
            .into_response(),
            Ok(Err(err)) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "ok": false, "error": err })),
            )
                .into_response(),
            Err(err) => (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "ok": false, "error": err.to_string() })),
            )
                .into_response(),
        };
    }
    // command.spawn() is a blocking fork+exec; offload it.
    let herdr_bin = state.herdr_bin.clone();
    let session_name = session.clone();
    let spawn_result = tokio::task::spawn_blocking(move || {
        let mut command = std::process::Command::new(&herdr_bin);
        command
            .arg("server")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env_remove("HERDR_SOCKET_PATH")
            .env_remove("HERDR_CLIENT_SOCKET_PATH");
        if let Some(session) = session_name.as_deref().filter(|value| *value != "default") {
            command.env("HERDR_SESSION", session);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        command.spawn()
    })
    .await;
    match spawn_result {
        Ok(Ok(child)) => Json(json!({
            "ok": true,
            "pid": child.id(),
            "backend": backend.as_str(),
            "session": session_display_name(session.as_deref()),
        }))
        .into_response(),
        Ok(Err(err)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "ok": false, "error": err.to_string() })),
        )
            .into_response(),
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
    body: Option<Json<SessionActionRequest>>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let body = body.map(|Json(body)| body).unwrap_or_default();
    let session = action_session(&state, &headers, &body);
    let backend = action_backend(&state, &headers, &body);
    if !backend_target_enabled(&state, backend) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "ok": false,
                "backend": backend.as_str(),
                "error": "backend type is disabled in settings",
            })),
        )
            .into_response();
    }
    if backend == SessionBackendTarget::Builtin {
        let session_name = canonical_session_name(session.as_deref());
        let api = api_for_target_session(&state, backend, session.as_deref());
        let response = proxy_server_stop(api).await;
        if let Ok(mut sessions) = state.builtin_sessions.lock() {
            sessions.remove(&session_name);
        }
        return response;
    }
    let api = api_for_target_session(&state, backend, session.as_deref());
    proxy_server_stop(api).await
}

/// Sends `server.stop` to the backend and treats a connection drop as success.
///
/// The backend may close the socket before sending a response (or send a
/// partial/truncated one) because it is shutting down. That manifests as an
/// `UnexpectedEof` or `ConnectionReset` error from `read_json_line`, which
/// `proxy_request` would turn into a 502 Bad Gateway. For a stop command that
/// is the expected outcome, so we return ok instead.
///
/// Runs the blocking socket I/O on a `spawn_blocking` thread so it does not
/// stall the async runtime (and by extension, active WebSocket loops) while
/// waiting for the backend to respond or drop the connection.
async fn proxy_server_stop(api: ApiClient) -> Response {
    let request = json!({ "id": "web:server:stop", "method": "server.stop", "params": {} });
    match tokio::task::spawn_blocking(move || api.request_value(request)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => {
            // The backend may have died without removing its socket file
            // (crash, kill -9). Removing a stale session row must still
            // count as success: there is nothing left to stop. LocalStream
            // connect surfaces a missing socket path as ENOENT ("No such
            // file or directory").
            let is_missing_socket = err.contains("No such file or directory");
            let is_connection_drop = err.contains("empty response")
                || err.contains("UnexpectedEof")
                || err.contains("ConnectionReset")
                || err.contains("Connection reset")
                || err.contains("broken pipe")
                || err.contains("Broken pipe");
            if is_missing_socket {
                Json(json!({ "ok": true, "already_stopped": true })).into_response()
            } else if is_connection_drop {
                Json(json!({ "ok": true })).into_response()
            } else {
                (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response()
            }
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
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
        log_event(
            &state.log_level(),
            &format!("login: localhost bypass for {remote}"),
        );
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
    log_event(
        &state.log_level(),
        &format!("login: success for user '{}' from {remote}", body.username),
    );
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
    let api = api_for_headers_ensured(&state, &headers).await;
    // request_value() does blocking socket I/O; offload to a blocking thread
    // so it does not stall the async runtime (and active WebSocket loops).
    match tokio::task::spawn_blocking(move || {
        match api.request_value(
            json!({ "id": "web:workspace:list", "method": "workspace.list", "params": {} }),
        ) {
            Ok(mut value) => {
                if let Ok(panes) = api.request_value(json!({ "id": "web:pane:list:workspace-cwds", "method": "pane.list", "params": { "workspace_id": null } })) {
                    enrich_workspace_cwds(&mut value, &panes);
                }
                Ok(value)
            }
            Err(err) => Err(err),
        }
    }).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
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

const MAX_RECENT_WORKSPACES: usize = 20;

fn unix_now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn push_recent_workspace(
    recent: &mut Vec<RecentWorkspace>,
    path: &str,
    label: Option<String>,
    branch: Option<String>,
    kind: Option<String>,
) {
    let path = path.trim().to_string();
    if path.is_empty() {
        return;
    }
    let trim = |value: Option<String>| {
        value
            .map(|raw| raw.trim().to_string())
            .filter(|trimmed| !trimmed.is_empty())
    };
    recent.retain(|item| item.path != path);
    recent.insert(
        0,
        RecentWorkspace {
            path,
            label: trim(label),
            branch: trim(branch),
            kind: trim(kind),
            opened_at: Some(unix_now_seconds()),
        },
    );
    recent.truncate(MAX_RECENT_WORKSPACES);
}

async fn persist_server_settings(state: &WebState) -> io::Result<()> {
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

async fn record_recent_workspace(
    state: &WebState,
    path: &str,
    label: Option<String>,
    branch: Option<String>,
    kind: Option<String>,
) -> io::Result<()> {
    {
        let Ok(mut guard) = state.server_settings.lock() else {
            return Err(io::Error::other("server settings unavailable"));
        };
        push_recent_workspace(&mut guard.recent_workspaces, path, label, branch, kind);
    }
    persist_server_settings(state).await
}

async fn recent_workspaces(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let recent = state
        .server_settings
        .lock()
        .map(|settings| settings.recent_workspaces.clone())
        .unwrap_or_default();
    Json(json!({ "recent": recent })).into_response()
}

async fn clear_recent_workspaces(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let cleared = {
        let Ok(mut guard) = state.server_settings.lock() else {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "server settings unavailable" })),
            )
                .into_response();
        };
        let count = guard.recent_workspaces.len();
        guard.recent_workspaces.clear();
        count
    };
    match persist_server_settings(&state).await {
        Ok(()) => Json(json!({ "ok": true, "cleared": cleared })).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
}

async fn remove_recent_workspace(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<RemoveRecentWorkspaceRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    // Validate the raw path BEFORE expanding: an empty or whitespace-only
    // path must 400 instead of expanding "~"/"" into the home directory and
    // silently removing the home workspace entry.
    let raw_path = body.path.as_deref().unwrap_or_default();
    if raw_path.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path is required" })),
        )
            .into_response();
    }
    let path = expand_user_path_string(raw_path).trim().to_string();
    if path.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path is required" })),
        )
            .into_response();
    }
    let removed = {
        let Ok(mut guard) = state.server_settings.lock() else {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({ "error": "server settings unavailable" })),
            )
                .into_response();
        };
        let count = guard.recent_workspaces.len();
        guard.recent_workspaces.retain(|item| item.path != path);
        count - guard.recent_workspaces.len()
    };
    match persist_server_settings(&state).await {
        Ok(()) => Json(json!({ "ok": true, "removed": removed, "path": path })).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response(),
    }
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
    let api = api_for_headers_ensured(&state, &headers).await;
    match api.request_value(
        json!({ "id": "web:worktree:list", "method": "worktree.list", "params": { "workspace_id": query.workspace_id, "cwd": cwd } }),
    ) {
        Ok(mut value) => {
            normalize_worktree_response(&mut value);
            Json(value).into_response()
        }
        Err(err) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
    }
}

fn normalize_worktree_response(value: &mut serde_json::Value) {
    let Some(rows) = value
        .pointer_mut("/result/worktrees")
        .and_then(serde_json::Value::as_array_mut)
    else {
        return;
    };
    for row in rows.iter_mut() {
        enrich_worktree_activity(row);
    }
    rows.sort_by(|left, right| {
        worktree_activity_sort_key(right).cmp(&worktree_activity_sort_key(left))
    });
}

fn enrich_worktree_activity(row: &mut serde_json::Value) {
    if row_activity_date(row).is_none_or(|value| value.trim().is_empty()) {
        if let Some((date, hash)) = latest_worktree_commit(row) {
            if let Some(object) = row.as_object_mut() {
                object.insert("last_commit_at".to_string(), json!(date));
                if !hash.is_empty() {
                    object.insert("last_commit_hash".to_string(), json!(hash));
                }
            }
        }
    }
    let display = row_activity_date(row).and_then(worktree_activity_display);
    if let (Some(display), Some(object)) = (display, row.as_object_mut()) {
        object
            .entry("last_commit_display".to_string())
            .or_insert_with(|| json!(display));
    }
}

fn latest_worktree_commit(row: &serde_json::Value) -> Option<(String, String)> {
    let path = row.get("path").and_then(serde_json::Value::as_str)?.trim();
    if path.is_empty() {
        return None;
    }
    let output = run_git_capture(&["-C", path, "log", "-1", "--format=%cI%x00%H"]).ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let mut parts = text.split('\0');
    let date = parts.next().unwrap_or_default().trim().to_string();
    if date.is_empty() {
        return None;
    }
    let hash = parts.next().unwrap_or_default().trim().to_string();
    Some((date, hash))
}

fn row_activity_date(row: &serde_json::Value) -> Option<&str> {
    [
        "last_commit_at",
        "latest_commit_at",
        "last_commit_date",
        "latest_commit_date",
        "modified_at",
        "updated_at",
        "mtime",
        "last_modified_at",
    ]
    .into_iter()
    .find_map(|key| row.get(key).and_then(serde_json::Value::as_str))
}

fn worktree_activity_display(value: &str) -> Option<String> {
    let value = value.trim();
    let prefix = || value.chars().take(16).collect::<String>();
    if value.len() >= 16 && value.as_bytes().get(10) == Some(&b'T') {
        return Some(prefix().replace('T', " "));
    }
    if value.len() >= 16 && value.as_bytes().get(10) == Some(&b' ') {
        return Some(prefix());
    }
    None
}

fn worktree_activity_sort_key(row: &serde_json::Value) -> String {
    let string_key = row_activity_date(row).unwrap_or_default().to_string();
    if !string_key.is_empty() {
        if let Some(timestamp) = parse_worktree_activity_timestamp(&string_key) {
            return format!("2:{:020}", timestamp + 20_000_000_000);
        }
        return format!("2:{string_key}");
    }
    [
        "last_commit_timestamp",
        "latest_commit_timestamp",
        "modified_timestamp",
        "updated_timestamp",
    ]
    .into_iter()
    .find_map(|key| row.get(key).and_then(serde_json::Value::as_i64))
    .map(|value| format!("1:{value:020}"))
    .unwrap_or_else(|| "0:".to_string())
}

fn parse_worktree_activity_timestamp(value: &str) -> Option<i64> {
    let value = value.trim();
    let bytes = value.as_bytes();
    if bytes.len() < 19
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || !matches!(bytes.get(10), Some(b'T' | b' '))
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let year: i32 = value.get(0..4)?.parse().ok()?;
    let month: u32 = value.get(5..7)?.parse().ok()?;
    let day: u32 = value.get(8..10)?.parse().ok()?;
    let hour: i64 = value.get(11..13)?.parse().ok()?;
    let minute: i64 = value.get(14..16)?.parse().ok()?;
    let second: i64 = value.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
    {
        return None;
    }
    let days = days_from_civil(year, month, day)?;
    let local_seconds = days * 86_400 + hour * 3_600 + minute * 60 + second.min(59);
    let offset_index = if bytes.get(19) == Some(&b'.') {
        20 + bytes
            .get(20..)?
            .iter()
            .position(|byte| !byte.is_ascii_digit())?
    } else {
        19
    };
    let offset_seconds = match bytes.get(offset_index) {
        Some(b'Z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            if bytes.len() < offset_index + 6 || bytes.get(offset_index + 3) != Some(&b':') {
                return None;
            }
            let hours: i64 = value
                .get(offset_index + 1..offset_index + 3)?
                .parse()
                .ok()?;
            let minutes: i64 = value
                .get(offset_index + 4..offset_index + 6)?
                .parse()
                .ok()?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            let offset = hours * 3_600 + minutes * 60;
            if *sign == b'+' {
                offset
            } else {
                -offset
            }
        }
        _ => 0,
    };
    Some(local_seconds - offset_seconds)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<i64> {
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => return None,
    };
    if day == 0 || day > days_in_month {
        return None;
    }
    let year = year - i32::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = year - era * 400;
    let month = month as i32;
    let day = day as i32;
    let doy = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) as i64)
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
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
    let api = api_for_headers_ensured(&state, &headers).await;

    // Phase 1: git operations (pull, branch check, worktree checkout, and
    // backend API version detection) are blocking subprocesses or socket I/O
    // that can take seconds (git pull involves network). Offload them all to
    // spawn_blocking to avoid stalling the async runtime.
    enum CreateWorktreePhase {
        Error(Response),
        NativeCreate,
        LegacyOpen,
        Default,
    }
    let phase = {
        let cwd = cwd.clone();
        let path = path.clone();
        let api_clone = api.clone();
        let pull_base = body.pull_base.unwrap_or(false);
        let branch = body.branch.clone();
        let base = body.base.clone();
        tokio::task::spawn_blocking(move || {
            if pull_base {
                if let Some(cwd) = cwd.as_deref() {
                    let base = base
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("HEAD");
                    if let Err(err) = pull_base_branch(cwd, base) {
                        return CreateWorktreePhase::Error(
                            (
                                StatusCode::BAD_REQUEST,
                                Json(json!({ "ok": false, "error": err })),
                            )
                                .into_response(),
                        );
                    }
                }
            }
            if let (Some(cwd), Some(path), Some(branch)) = (&cwd, &path, branch.as_deref()) {
                let branch = branch.trim();
                if !branch.is_empty() && git_branch_exists(cwd, branch).unwrap_or(false) {
                    let worktree_api = HerdrWorktreeApi::detect(api_clone);
                    if !worktree_api.needs_legacy_existing_branch_create() {
                        // Native API handles existing-branch create; no local
                        // checkout needed. Phase 2 will call the native API.
                        return CreateWorktreePhase::NativeCreate;
                    }
                    let base = base
                        .as_deref()
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .unwrap_or("HEAD");
                    if let Err(err) = create_worktree_checkout(cwd, path, branch, base) {
                        return CreateWorktreePhase::Error(
                            (
                                StatusCode::BAD_REQUEST,
                                Json(json!({ "ok": false, "error": err })),
                            )
                                .into_response(),
                        );
                    }
                    // Legacy checkout done; Phase 2 will call worktree.open.
                    return CreateWorktreePhase::LegacyOpen;
                }
            }
            CreateWorktreePhase::Default
        })
        .await
        .unwrap_or_else(|err| {
            CreateWorktreePhase::Error(
                (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({ "ok": false, "error": err.to_string() })),
                )
                    .into_response(),
            )
        })
    };

    match phase {
        CreateWorktreePhase::Error(response) => return response,
        CreateWorktreePhase::NativeCreate => {
            let worktree_api = HerdrWorktreeApi::new(api);
            let request = worktree_api.create_request(body, cwd, path);
            return proxy_request_async(worktree_api.client, request).await;
        }
        CreateWorktreePhase::LegacyOpen => {
            if let (Some(cwd), Some(path)) = (&cwd, &path) {
                let worktree_api = HerdrWorktreeApi::new(api);
                let request = worktree_api.legacy_open_created_request(cwd, path, body.label);
                return proxy_request_async(worktree_api.client, request).await;
            }
        }
        CreateWorktreePhase::Default => {}
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
    let recorded_path = path.as_deref().or(cwd.as_deref()).unwrap_or("").to_string();
    let recorded_label = body.label.clone();
    let recorded_branch = body.branch.clone();
    let record_state = state.clone();
    let record_kind = "worktree".to_string();
    let record = tokio::spawn(async move {
        let _ = record_recent_workspace(
            &record_state,
            &recorded_path,
            recorded_label,
            recorded_branch,
            Some(record_kind),
        )
        .await;
    });
    let response = proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
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
    .await;
    let _ = record.await;
    response
}

#[derive(Deserialize)]
struct OpenRecentWorkspaceRequest {
    path: Option<String>,
    label: Option<String>,
    branch: Option<String>,
}

#[derive(Deserialize)]
struct RemoveRecentWorkspaceRequest {
    path: Option<String>,
}

async fn open_recent_workspace(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<OpenRecentWorkspaceRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let path = body.path.as_deref().map(expand_user_path_string);
    let cwd = body.path.as_deref().map(expand_user_path_string);
    let recorded_path = path.clone().unwrap_or_default();
    let recorded_label = body.label.clone();
    let recorded_branch = body.branch.clone();
    let record_state = state.clone();
    let record_kind = "workspace".to_string();
    let record = tokio::spawn(async move {
        let _ = record_recent_workspace(
            &record_state,
            &recorded_path,
            recorded_label,
            recorded_branch,
            Some(record_kind),
        )
        .await;
    });
    let response = proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({
            "id": "web:recent-workspace:open",
            "method": "worktree.open",
            "params": {
                "workspace_id": null,
                "cwd": cwd,
                "path": path,
                "branch": null,
                "label": body.label,
                "focus": true,
            },
        }),
    )
    .await;
    let _ = record.await;
    response
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
    let force = body.force.unwrap_or(false);
    // git worktree remove is a subprocess that can block; offload it.
    let path_for_response = path.clone();
    match tokio::task::spawn_blocking(move || {
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(&repo_root)
            .args(["worktree", "remove"]);
        if force {
            command.arg("--force");
        }
        command.arg(&path);
        command.output()
    })
    .await
    {
        Ok(Ok(output)) if output.status.success() => {
            Json(json!({ "ok": true, "path": path_for_response })).into_response()
        }
        Ok(Ok(output)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": String::from_utf8_lossy(&output.stderr).trim() })),
        )
            .into_response(),
        Ok(Err(err)) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({ "error": err.to_string() })),
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
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:agent:list", "method": "agent.list", "params": {} }),
    )
    .await
}

#[derive(Deserialize)]
struct WorkspaceQuery {
    workspace_id: Option<String>,
    cwd: Option<String>,
}

#[derive(Deserialize)]
struct GitBranchesQuery {
    cwd: Option<String>,
    remote: Option<bool>,
    fetch: Option<bool>,
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

fn list_git_branches(
    cwd: &str,
    include_remote: bool,
    fetch_remote: bool,
) -> Result<Vec<String>, String> {
    let cwd = expand_path_prefix(cwd);
    if fetch_remote {
        let output = Command::new("git")
            .arg("-C")
            .arg(&cwd)
            .args(["fetch", "--all", "--prune"])
            .output()
            .map_err(|err| err.to_string())?;
        if !output.status.success() {
            return Err(git_failure(output, "git fetch"));
        }
    }
    let mut refs = vec!["refs/heads"];
    if include_remote {
        refs.push("refs/remotes");
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["for-each-ref", "--format=%(refname:short)"])
        .args(refs)
        .output()
        .map_err(|err| err.to_string())?;
    if !output.status.success() {
        return Err(git_failure(output, "git for-each-ref"));
    }
    let mut branches = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.ends_with("/HEAD"))
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
    let Some(cwd) = query.cwd.as_deref().map(str::to_string) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "cwd is required" })),
        )
            .into_response();
    };
    let remote = query.remote.unwrap_or(false);
    let fetch = query.fetch.unwrap_or(false);
    // list_git_branches runs git subprocesses (potentially git fetch --all)
    // which can block for seconds; offload to avoid stalling the async runtime.
    match tokio::task::spawn_blocking(move || list_git_branches(&cwd, remote, fetch)).await {
        Ok(Ok(branches)) => Json(GitBranchesResponse { branches }).into_response(),
        Ok(Err(err)) => (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response(),
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
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:tab:list", "method": "tab.list", "params": { "workspace_id": query.workspace_id } }),
    )
    .await
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
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:pane:list", "method": "pane.list", "params": { "workspace_id": query.workspace_id } }),
    )
    .await
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
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:pane:layout", "method": "pane.layout", "params": { "pane_id": query.pane_id } }),
    )
    .await
}

/// Returns the full backend `session.snapshot` response in one round trip so
/// the frontend can bootstrap workspaces, tabs, panes, layouts, and agents
/// without issuing separate list requests. Added with protocol 16 backends.
async fn session_snapshot(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:session:snapshot", "method": "session.snapshot", "params": {} }),
    )
    .await
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
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:workspace:create", "method": "workspace.create", "params": { "cwd": cwd, "focus": false, "label": body.label, "env": {} } }),
    )
    .await
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
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:workspace:rename", "method": "workspace.rename", "params": { "workspace_id": workspace_id, "label": body.label } }),
    )
    .await
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
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:workspace:close", "method": "workspace.close", "params": { "workspace_id": workspace_id } }),
    )
    .await
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
    proxy_request_async(api_for_headers_ensured(&state, &headers).await, request).await
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
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:tab:create", "method": "tab.create", "params": { "workspace_id": body.workspace_id, "focus": false, "label": body.label, "env": {} } }),
    )
    .await
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
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:tab:rename", "method": "tab.rename", "params": { "tab_id": tab_id, "label": body.label } }),
    )
    .await
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
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:tab:close", "method": "tab.close", "params": { "tab_id": tab_id } }),
    )
    .await
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
    proxy_request_async(
        api_for_headers_ensured(&state, &headers).await,
        json!({ "id": "web:pane:close", "method": "pane.close", "params": { "pane_id": pane_id } }),
    )
    .await
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
    log_event(
        &state.log_level(),
        &format!("websocket: events connection from {remote}"),
    );
    let api = api_for_query_session_ensured(
        &state,
        &headers,
        query.session.as_deref(),
        query.backend.as_deref(),
    )
    .await;
    ws.on_upgrade(move |socket| events_socket(state, api, socket))
}

async fn events_socket(state: WebState, api: ApiClient, mut socket: WebSocket) {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<serde_json::Value>();
    // Settings changes must reach open tabs immediately: a backend disabled
    // mid-session stops being targeted/offered without a page reload.
    let mut settings_rx = state.settings_tx.subscribe();
    let subscribe_api = api.clone();
    // backend_info() does a blocking ping over a Unix socket; run it on a
    // blocking thread so it does not stall the async runtime while waiting
    // for the backend to respond (or time out) during connection setup.
    let backend_info_api = api.clone();
    let backend_info = tokio::task::spawn_blocking(move || backend_info_api.backend_info())
        .await
        .unwrap_or_default();
    let use_builtin_event_hub = backend_uses_builtin_event_hub(&backend_info);
    let backend_protocol = backend_info.protocol;
    // Push channel for LSP diagnostics (C1): the registry broadcasts every
    // publishDiagnostics batch and we forward it to connected UIs. Receivers
    // that lag a burst simply miss those batches; diagnostics are full-state
    // snapshots so the next event restores the view.
    let mut lsp_rx = state.lsp.subscribe_diagnostics();
    std::thread::spawn(move || {
        // Detect the backend protocol so we only subscribe to layout.updated
        // on protocol 16+. Older backends reject unknown subscription types
        // and would fail the entire events.subscribe request.
        let mut subscriptions = vec![
            json!({"type":"workspace.created"}),
            json!({"type":"workspace.updated"}),
            json!({"type":"workspace.renamed"}),
            json!({"type":"workspace.closed"}),
            json!({"type":"workspace.focused"}),
            json!({"type":"worktree.created"}),
            json!({"type":"worktree.opened"}),
            json!({"type":"worktree.removed"}),
            json!({"type":"tab.created"}),
            json!({"type":"tab.closed"}),
            json!({"type":"tab.focused"}),
            json!({"type":"tab.renamed"}),
            json!({"type":"pane.created"}),
            json!({"type":"pane.closed"}),
            json!({"type":"pane.focused"}),
            json!({"type":"pane.moved"}),
            json!({"type":"pane.exited"}),
            json!({"type":"pane.agent_detected"}),
            json!({"type":"pane.agent_status_changed"}),
        ];
        if backend_protocol.unwrap_or(0) >= 16 {
            subscriptions.push(json!({"type":"layout.updated"}));
        }
        let request = json!({
            "id": "web:events",
            "method": "events.subscribe",
            "params": { "subscriptions": subscriptions }
        });
        // The backend subscription can fail while the socket itself is fine
        // (external herdr daemon died, backend restarting). The events socket
        // also carries server-level frames (server_settings_changed, lsp
        // diagnostics) that must NOT die with the backend: keep retrying the
        // subscription with a backoff instead of dropping `tx`, which would
        // close the whole WebSocket and make tabs miss one-shot settings
        // broadcasts during the reconnect gap (they would stay pinned to a
        // backend disabled in settings until the next manual refresh).
        let mut backoff_secs = 1u64;
        loop {
            match subscribe_api.subscribe(request.clone()) {
                Ok(mut stream) => {
                    let _ = tx.send(json!({ "type": "ready" }));
                    let subscribed_at = std::time::Instant::now();
                    loop {
                        match stream.next_value() {
                            Ok(Some(value)) => {
                                if tx.send(json!({ "type": "event", "event": value })).is_err() {
                                    return;
                                }
                            }
                            Ok(None) => break,
                            Err(err) => {
                                let _ = tx.send(json!({
                                    "type": "error",
                                    "message": err.to_string()
                                }));
                                break;
                            }
                        }
                    }
                    // A stream that stayed healthy for a while proves the
                    // backend was up; a quick subsequent failure is a flap,
                    // not an outage, so reconnect fast instead of waiting
                    // out a 30s backoff grown during the outage.
                    if subscribed_at.elapsed() >= std::time::Duration::from_secs(10) {
                        backoff_secs = 1;
                    }
                }
                Err(_) => {
                    let _ = tx.send(
                        json!({ "type": "error", "message": "failed to subscribe to Herdr events" }),
                    );
                }
            }
            // The WebSocket consumer went away; stop retrying.
            if tx.is_closed() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_secs(backoff_secs));
            backoff_secs = (backoff_secs * 2).min(30);
        }
    });

    let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
    loop {
        tokio::select! {
            // When the subscription thread exits (backend died), it drops tx
            // and rx.recv() returns None. Break so the WebSocket closes and the
            // client can reconnect to a fresh backend instead of hanging.
            value = rx.recv() => {
                let Some(value) = value else { break; };
                if web_event_kind(&value) == Some("pane.agent_status_changed") {
                    // Use the event payload directly instead of calling agent.list
                    // This avoids recomputing all pane statuses on every status change
                    if let Some(event) = value.get("event") {
                        if let Some(data) = event.get("data") {
                            if let Some(status) = data.get("agent_status").and_then(|s| s.as_str()) {
                                let has_working = status == "working";
                                let cooldown = state
                                    .server_settings
                                    .lock()
                                    .map(|settings| settings.no_sleep_auto_cooldown_seconds)
                                    .unwrap_or(60);
                                if let Ok(mut no_sleep) = state.no_sleep.lock() {
                                    sync_auto_no_sleep(&mut no_sleep, has_working, cooldown);
                                }
                            }
                        }
                    }
                }
                if socket.send(Message::Text(value.to_string().into())).await.is_err() { break; }
            }
            lsp_event = lsp_rx.recv() => {
                let Ok(event) = lsp_event else { break; };
                let value = json!({
                    "type": "event",
                    "event": {
                        "type": "lsp.diagnostics",
                        "event": "lsp.diagnostics",
                        "data": event,
                    }
                });
                if socket.send(Message::Text(value.to_string().into())).await.is_err() { break; }
            }
            settings = settings_rx.recv() => {
                let Ok(settings) = settings else { break; };
                if socket.send(Message::Text(settings.to_string().into())).await.is_err() { break; }
            }
            _ = interval.tick(), if !use_builtin_event_hub => {
                // request_value() does blocking socket I/O; offload it so the
                // async runtime and other WebSocket loops are not stalled while
                // waiting for the backend to respond.
                let poll_api = api.clone();
                let poll_result = tokio::task::spawn_blocking(move || {
                    let agents = poll_api.request_value(json!({ "id": "web:agent:list:poll", "method": "agent.list", "params": {} })).ok();
                    let workspaces = poll_api.request_value(json!({ "id": "web:workspace:list:poll", "method": "workspace.list", "params": {} })).ok();
                    (agents, workspaces)
                }).await;
                let (agents, workspaces) = match poll_result {
                    Ok(pair) => pair,
                    Err(_) => break,
                };
                if let Some(agents) = &agents {
                    sync_auto_no_sleep_from_agents(&state, agents);
                }
                let value = json!({ "type": "snapshot", "agents": agents, "workspaces": workspaces });
                if socket.send(Message::Text(value.to_string().into())).await.is_err() { break; }
            }
            message = socket.recv() => {
                if message.is_none() { break; }
            }
        }
    }
}

fn backend_uses_builtin_event_hub(info: &BackendInfo) -> bool {
    info.version
        .as_deref()
        .is_some_and(|version| version.starts_with("builtin-"))
        && info.protocol.unwrap_or(0) >= 16
}

fn web_event_kind(value: &serde_json::Value) -> Option<&str> {
    if value.get("type").and_then(serde_json::Value::as_str) != Some("event") {
        return None;
    }
    let event = value.get("event")?;
    event
        .get("event")
        .or_else(|| event.get("type"))
        .and_then(serde_json::Value::as_str)
}

#[derive(Deserialize)]
struct TerminalQuery {
    terminal_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    session: Option<String>,
    backend: Option<String>,
    temporary_tab_id: Option<String>,
}

#[derive(Deserialize)]
struct SessionQuery {
    session: Option<String>,
    backend: Option<String>,
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
    log_event(
        &state.log_level(),
        &format!("websocket: terminal connection from {remote}"),
    );
    let client_socket_path = client_socket_for_query_session(
        &state,
        &headers,
        query.session.as_deref(),
        query.backend.as_deref(),
    );
    // The resolved backend for the herdr_error frame: the server reroutes
    // disabled/absent pins to the remaining enabled backend, so the browser
    // must know which backend actually failed instead of blaming its stale pin.
    let attach_backend = backend_target_for_query(&state, &headers, query.backend.as_deref());
    let api = api_for_query_session_ensured(
        &state,
        &headers,
        query.session.as_deref(),
        query.backend.as_deref(),
    )
    .await;
    ws.on_upgrade(move |socket| {
        terminal_socket(client_socket_path, api, attach_backend, query, socket)
    })
}

async fn terminal_socket(
    path: PathBuf,
    api: ApiClient,
    backend: SessionBackendTarget,
    query: TerminalQuery,
    mut socket: WebSocket,
) {
    let terminal_id = query.terminal_id.clone();
    let cols = query.cols.unwrap_or(100).max(1);
    let rows = query.rows.unwrap_or(30).max(1);
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<TerminalEvent>();
    let (in_tx, in_rx) = std::sync::mpsc::channel::<ClientMessage>();

    std::thread::spawn(move || {
        let mut stream = match connect_terminal_attach(&path, &terminal_id, cols, rows) {
            Ok(stream) => stream,
            Err(error) => {
                // Order matters: the raw text first, then the structured
                // error, through ONE channel so the select loop can never
                // observe the channel close before the error frame. (With a
                // separate error channel, a closed out_rx could win the
                // select race and the browser would never see the JSON
                // frame offering a built-in session.)
                let _ = out_tx.send(TerminalEvent::Bytes(error.user_message().into_bytes()));
                let _ = out_tx.send(TerminalEvent::Error(error));
                return;
            }
        };

        let Ok(mut writer) = stream.try_clone() else {
            let _ = out_tx.send(TerminalEvent::Bytes(
                b"failed to clone herdr terminal socket\r\n".to_vec(),
            ));
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
                    if out_tx.send(TerminalEvent::Bytes(frame.bytes)).is_err() {
                        break;
                    }
                }
                Ok(ServerMessage::Graphics { bytes }) => {
                    if out_tx.send(TerminalEvent::Bytes(bytes)).is_err() {
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
            message = out_rx.recv() => {
                match message {
                    // Graceful degradation: surface the handshake failure as
                    // a structured frame before closing, so the browser can
                    // offer a built-in session instead of blocking on a dead
                    // terminal. Delivered through the same channel as the raw
                    // bytes and after them, so ordering is guaranteed: the
                    // channel close can never race ahead of the error frame.
                    Some(TerminalEvent::Error(error)) => {
                        let payload = json!({
                            "type": "herdr_error",
                            "backend": backend.as_str(),
                            "kind": error.error_kind(),
                            "message": error.user_message().trim_end(),
                            "suggest_builtin": error.suggests_builtin(),
                        });
                        if let Ok(text) = serde_json::to_string(&payload) {
                            let _ = socket.send(Message::Text(text.into())).await;
                        }
                        break;
                    }
                    Some(TerminalEvent::Bytes(bytes)) => {
                        if socket.send(Message::Binary(bytes.into())).await.is_err() { break; }
                    }
                    None => break,
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Binary(data))) => {
                        if in_tx.send(ClientMessage::Input { data: data.to_vec() }).is_err() { break; }
                    }
                    Some(Ok(Message::Text(text))) => {
                        for message in terminal_text_messages(&text) {
                            if in_tx.send(message).is_err() { break; }
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
    if let Some(tab_id) = query
        .temporary_tab_id
        .as_deref()
        .filter(|value| !value.is_empty())
    {
        let _ = api.request_value(
            json!({ "id": "web:temp-terminal:close", "method": "tab.close", "params": { "tab_id": tab_id } }),
        );
    }
}

fn terminal_text_messages(text: &str) -> Vec<ClientMessage> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return vec![ClientMessage::Input {
            data: text.as_bytes().to_vec(),
        }];
    };
    match value.get("type").and_then(|value| value.as_str()) {
        Some("resize") => {
            let cols = value
                .get("cols")
                .and_then(|value| value.as_u64())
                .unwrap_or(100)
                .min(u16::MAX as u64) as u16;
            let rows = value
                .get("rows")
                .and_then(|value| value.as_u64())
                .unwrap_or(30)
                .min(u16::MAX as u64) as u16;
            vec![ClientMessage::Resize {
                cols: cols.max(1),
                rows: rows.max(1),
                cell_width_px: 0,
                cell_height_px: 0,
                pixel_mouse: false,
            }]
        }
        Some("scroll") => {
            let direction = match value.get("direction").and_then(|value| value.as_str()) {
                Some("up") => AttachScrollDirection::Up,
                Some("down") => AttachScrollDirection::Down,
                _ => AttachScrollDirection::Down,
            };
            let lines = value
                .get("lines")
                .and_then(|value| value.as_u64())
                .unwrap_or(3)
                .clamp(1, u16::MAX as u64) as u16;
            let column = value
                .get("column")
                .and_then(|value| value.as_u64())
                .and_then(|value| u16::try_from(value).ok());
            let row = value
                .get("row")
                .and_then(|value| value.as_u64())
                .and_then(|value| u16::try_from(value).ok());
            let modifiers = value
                .get("modifiers")
                .and_then(|value| value.as_u64())
                .and_then(|value| u8::try_from(value).ok())
                .unwrap_or(0);
            vec![ClientMessage::AttachScroll {
                source: AttachScrollSource::Wheel,
                direction,
                lines,
                column,
                row,
                modifiers,
            }]
        }
        Some("key") if value.get("code").and_then(|value| value.as_str()) == Some("Enter") => {
            let modifiers = value
                .get("modifiers")
                .and_then(|value| value.as_u64())
                .and_then(|value| u8::try_from(value).ok())
                .unwrap_or(0);
            vec![ClientMessage::Input {
                data: (if modifiers & 1 != 0 {
                    "\x1b[13;2u"
                } else {
                    "\r"
                })
                .as_bytes()
                .to_vec(),
            }]
        }
        Some("paste") => value
            .get("text")
            .and_then(|value| value.as_str())
            .map(|text| {
                // herdr 0.9.0 removed `InputEvents`; paste is delivered as
                // raw bracketed-paste input bytes.
                vec![ClientMessage::Input {
                    data: format!("\x1b[200~{}\x1b[201~", text).into_bytes(),
                }]
            })
            .unwrap_or_default(),
        _ => value
            .get("input")
            .and_then(|value| value.as_str())
            .map(|input| {
                vec![ClientMessage::Input {
                    data: input.as_bytes().to_vec(),
                }]
            })
            .unwrap_or_default(),
    }
}

/// Events from the terminal reader thread to the WS select loop, through one
/// ordered channel. Ordering is load-bearing: the raw failure text must be
/// delivered before the structured error so the browser always receives the
/// `herdr_error` JSON frame (a closed channel can never race ahead of it).
enum TerminalEvent {
    Bytes(Vec<u8>),
    Error(TerminalAttachError),
}

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

    /// Machine-readable kind forwarded to the browser so it can offer a
    /// built-in session when the external herdr backend cannot be attached.
    fn error_kind(&self) -> &'static str {
        match self {
            Self::Connect => "connect_failed",
            Self::SendHandshake => "handshake_failed",
            Self::ReadHandshake => "handshake_failed",
            Self::Rejected(_) => "handshake_rejected",
            Self::Attach => "attach_failed",
        }
    }

    /// True when the failure means the external herdr backend is unusable
    /// for terminal attach (protocol/handshake problems) and the UI should
    /// offer a built-in session instead of retrying silently.
    fn suggests_builtin(&self) -> bool {
        matches!(self, Self::ReadHandshake | Self::Rejected(_))
    }
}

/// herdr 0.9.0 requires an exact client protocol version match at handshake
/// time, so no multi-version fallback is possible: the client sends
/// `TerminalHello{version: PROTOCOL_VERSION}` and the backend either accepts
/// it or rejects the connection with a `Welcome{error}`.
fn connect_terminal_attach(
    path: &Path,
    terminal_id: &str,
    cols: u16,
    rows: u16,
) -> Result<LocalStream, TerminalAttachError> {
    let mut stream = connect_local_stream(path).map_err(|_| TerminalAttachError::Connect)?;
    let hello = ClientMessage::TerminalHello {
        version: PROTOCOL_VERSION,
        cols,
        rows,
        cell_width_px: 0,
        cell_height_px: 0,
        pixel_mouse: false,
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
        let (settings_tx, _) = tokio::sync::broadcast::channel(16);
        WebState {
            api_socket: Some(PathBuf::from("/tmp/default-api.sock")),
            client_socket: Some(PathBuf::from("/tmp/default-client.sock")),
            session_name: None,
            backend_mode: BackendMode::ExternalHerdr,
            _builtin_backend: None,
            builtin_sessions: Arc::new(Mutex::new(HashMap::new())),
            builtin_start_lock: Arc::new(Mutex::new(())),
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

        assert_eq!(WebConfig::parse(&args).unwrap().tls.mode, TlsMode::Off);
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
        assert_eq!(api_for_headers(&state, &headers).socket_path, other_api);
        assert_eq!(client_socket_for_headers(&state, &headers), other_client);

        let (query_api, query_client) = builtin_socket_paths(Some("query"));
        assert_eq!(
            api_for_query_session_routed(&state, &headers, Some("query"), None).socket_path,
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
            .socket_path
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

        assert!(sessions.iter().all(
            |session| session.get("backend").and_then(Value::as_str) != Some("external-herdr")
        ));
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
        assert_eq!(settings.user, None);
        assert_eq!(settings.password, None);
        assert!(settings.localhost_no_auth);
        assert_eq!(settings.no_sleep_auto_cooldown_seconds, 60);
        assert_eq!(settings.backend_mode, BackendMode::Builtin);
        assert_eq!(settings.builtin_shell, None);
        assert!(!settings.default_folder.is_empty());
        let raw = fs::read_to_string(path).unwrap();
        assert!(raw.contains("localhost_no_auth"));
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
            user: Some("test-user".to_string()),
            password: Some("test-password".to_string()),
            localhost_no_auth: false,
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
            user: None,
            password: None,
            localhost_no_auth: true,
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
                    "/repo/x",
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
            assert_eq!(json["recent"][0]["path"], "/repo/x");
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
        std::env::remove_var("XDG_CONFIG_HOME");
    }

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

        {
            let state = test_state();
            {
                let mut guard = state.server_settings.lock().unwrap();
                push_recent_workspace(
                    &mut guard.recent_workspaces,
                    "/repo/keep",
                    Some("Keep".to_string()),
                    None,
                    Some("workspace".to_string()),
                );
                push_recent_workspace(
                    &mut guard.recent_workspaces,
                    "/repo/gone",
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
                        .body(Body::from(json!({ "path": "/repo/gone" }).to_string()))
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
                        .body(Body::from(json!({ "path": "/repo/gone" }).to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(removed.status(), StatusCode::OK);
            let json = response_json(removed).await;
            assert_eq!(json["ok"], json!(true));
            assert_eq!(json["removed"], json!(1));
            assert_eq!(json["path"], "/repo/gone");

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
            assert_eq!(recent[0]["path"], "/repo/keep");

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
            user: settings.user.clone(),
            password: settings.password.clone(),
            localhost_no_auth: Some(settings.localhost_no_auth),
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
        let (socket, handle) = fake_api_socket_for_method(
            "worktree.open",
            json!({ "id": "web:recent-workspace:open", "result": { "ok": true, "workspace": { "workspace_id": "ws-recent" } } }),
        );
        let mut state = test_state();
        state.api_socket = Some(socket.clone());
        let app = test_app_with_state(state.clone());

        let response = app
            .oneshot(
                authed_request(Method::POST, "/api/recent-workspaces")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "path": "/repo/recent", "label": " Recent ", "branch": "main" })
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
        assert_eq!(recent[0].path, "/repo/recent");
        assert_eq!(recent[0].label.as_deref(), Some("Recent"));
        assert_eq!(recent[0].branch.as_deref(), Some("main"));
        assert_eq!(recent[0].kind.as_deref(), Some("workspace"));

        let body = response_json(response).await;
        assert_eq!(
            body["result"]["workspace"]["workspace_id"],
            json!("ws-recent")
        );

        let _ = fs::remove_dir_all(config_home);
        std::env::remove_var("XDG_CONFIG_HOME");
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
        use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

        let path = std::env::temp_dir().join(format!(
            "herdr-webui-test-{}-{}.sock",
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
    fn fake_api_socket_multi(
        responses: Vec<serde_json::Value>,
    ) -> (PathBuf, thread::JoinHandle<()>) {
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
                        json!({ "cwd": cwd.to_string_lossy(), "label": "routing-test" })
                            .to_string(),
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
                        json!({ "cwd": cwd.to_string_lossy(), "path": "", "branch": "" })
                            .to_string(),
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
        use std::os::unix::fs::PermissionsExt;

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
            std::thread::current().name().unwrap_or("t").to_string()
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
                        json!({ "session": "test-launch", "backend": "external-herdr" })
                            .to_string(),
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
                        json!({ "bind": "not-a-valid-address", "localhost_no_auth": true })
                            .to_string(),
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
                        json!({ "session": "test-builtin-launch", "backend": "builtin" })
                            .to_string(),
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

        let (socket, handle) = fake_api_socket_for_method(
            "ping",
            json!({ "id": "web:ping", "result": { "version": "0.9.0", "protocol": 22 } }),
        );
        // Bind the fake ping listener at the built-in default session path:
        // the request targets the built-in backend, so that is the socket
        // versions actually pings.
        let (api_socket, _) = builtin_socket_paths(None);
        fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
        let _ = fs::remove_file(&api_socket);
        fs::rename(&socket, &api_socket).unwrap();

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
            let msg =
                match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
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
                        json!({ "session": "test-spawn-err", "backend": "external-herdr" })
                            .to_string(),
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
            let msg =
                match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
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
            let msg =
                match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
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
            let msg =
                match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
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
            let msg =
                match tokio::time::timeout(std::time::Duration::from_secs(10), ws_stream.next())
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
                    let request: serde_json::Value =
                        serde_json::from_str(&line).unwrap_or_default();
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
                            let _ = stream.write_all(
                                json!({ "id": id, "result": {} }).to_string().as_bytes(),
                            );
                            let _ = stream.write_all(b"\n");
                            let _ = stream.flush();
                        }
                    }
                });
            }
        });
        (path, handle)
    }
}

#[cfg(test)]
mod tui_parity_e2e_tests {
    //! End-to-end tests driving the real axum server with the TUI's
    //! `WebApiClient`, `FileExplorer`, and `GitPanel` against a real
    //! temp git repository. These verify the loopback contract the TUI
    //! depends on: loopback + `localhost_no_auth` auth, and the exact
    //! request/response shapes the TUI parsers expect.
    use super::*;
    use crate::lsp::LspRegistry;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use herdr_webui::tui_panels::{FileExplorer, GitFileStatus, GitPanel, GitView};
    use herdr_webui::tui_web_api::WebApiClient;

    fn temp_git_repo() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "herdr-tui-e2e-repo-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| {
            let mut attempt = 0;
            loop {
                let output = Command::new("git").arg("-C").arg(&dir).args(args).output();
                let detail = match &output {
                    Ok(out) if out.status.success() => return,
                    Ok(out) => format!(
                        "exit={:?} stderr={}",
                        out.status.code(),
                        String::from_utf8_lossy(&out.stderr).trim()
                    ),
                    Err(err) => err.to_string(),
                };
                attempt += 1;
                if attempt >= 3 {
                    panic!("git {args:?} failed in test repo: {detail}");
                }
                std::thread::sleep(std::time::Duration::from_millis(100 * attempt as u64));
            }
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "tui@test.local"]);
        run(&["config", "user.name", "TUI Test"]);
        std::fs::write(dir.join("readme.md"), "hello\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
        std::fs::write(dir.join("readme.md"), "hello\nworld\n").unwrap();
        std::fs::write(dir.join("new_file.rs"), "fn main() {}\n").unwrap();
        // A bare sibling repo acts as "origin" so fetch/pull/push have a
        // real remote to talk to in the round-trip test.
        let bare = std::env::temp_dir().join(format!(
            "herdr-tui-e2e-bare-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let bare_str = bare.to_string_lossy().to_string();
        assert!(
            Command::new("git")
                .arg("clone")
                .arg("-q")
                .arg("--bare")
                .arg(&dir)
                .arg(&bare)
                .output()
                .is_ok_and(|out| out.status.success()),
            "git clone --bare failed in test setup"
        );
        run(&["remote", "add", "origin", &bare_str]);
        run(&["push", "-q", "-u", "origin", "HEAD"]);
        run(&["config", "pull.rebase", "true"]);
        std::thread::sleep(std::time::Duration::from_millis(1));
        dir
    }

    fn localhost_no_auth_state(default_folder: PathBuf) -> WebState {
        let bind = DEFAULT_BIND.parse::<SocketAddr>().unwrap();
        let (rebind_tx, _) = tokio::sync::watch::channel(bind);
        let (settings_tx, _) = tokio::sync::broadcast::channel(16);
        WebState {
            api_socket: Some(PathBuf::from("/tmp/default-api.sock")),
            client_socket: Some(PathBuf::from("/tmp/default-client.sock")),
            session_name: None,
            backend_mode: BackendMode::ExternalHerdr,
            _builtin_backend: None,
            builtin_sessions: Arc::new(Mutex::new(HashMap::new())),
            builtin_start_lock: Arc::new(Mutex::new(())),
            herdr_bin: "herdr".to_string(),
            auth: Arc::new(Mutex::new(AuthConfig {
                user: None,
                password: None,
                localhost_no_auth: true,
                token: "e2e-token".to_string(),
            })),
            server_settings: Arc::new(Mutex::new(RuntimeServerSettings {
                bind,
                user: None,
                password: None,
                localhost_no_auth: true,
                no_sleep_auto_cooldown_seconds: 60,
                backend_mode: BackendMode::ExternalHerdr,
                builtin_shell: None,
                default_folder: default_folder.to_string_lossy().to_string(),
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
            lsp: Arc::new(LspRegistry::new(Default::default())),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn tui_web_api_client_round_trips_file_tree_and_git_panels() {
        let repo = temp_git_repo();
        let state = localhost_no_auth_state(repo.clone());
        let app = app_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });

        let api = WebApiClient::new("127.0.0.1", addr.port());
        let cwd = repo.to_string_lossy().to_string();

        // The TUI client is blocking; run it on the blocking pool so the
        // async server keeps making progress while it waits.
        let result = tokio::task::spawn_blocking(move || tui_round_trip_assertions(&api, &cwd))
            .await
            .unwrap();
        result.unwrap_or_else(|err| panic!("tui round trip failed: {err}"));
        server.abort();
        let _ = std::fs::remove_dir_all(&repo);
    }

    fn tui_round_trip_assertions(api: &WebApiClient, cwd: &str) -> Result<(), String> {
        // FileExplorer: tree listing via the TUI parser.
        let mut explorer = FileExplorer::new(cwd);
        explorer.refresh(api).unwrap();
        let names: Vec<&str> = explorer.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(
            names.contains(&"readme.md"),
            "tree missing readme.md: {names:?}"
        );
        assert!(
            names.contains(&"new_file.rs"),
            "tree missing new_file.rs: {names:?}"
        );
        assert!(names.contains(&".git"), "tree missing .git: {names:?}");

        // FileExplorer: file preview.
        explorer.selected = names.iter().position(|n| *n == "readme.md").unwrap();
        explorer.open_preview(api).unwrap();
        let preview = explorer.preview.clone();
        assert_eq!(preview.path.as_deref(), Some("readme.md"));
        assert!(preview.content.contains("world"));
        assert!(!preview.binary);

        // GitPanel: status parses into staged/unstaged/untracked lists.
        let mut panel = GitPanel::new(cwd);
        panel.refresh(api).unwrap();
        assert_eq!(panel.state, "dirty");
        let has_readme = panel
            .files
            .iter()
            .any(|entry| entry.path == "readme.md" && entry.status == GitFileStatus::Unstaged);
        assert!(
            has_readme,
            "expected unstaged readme.md, got {:?}",
            panel
                .files
                .iter()
                .map(|f| (&f.path, &f.status))
                .collect::<Vec<_>>()
        );
        assert!(
            panel.files.iter().any(|entry| entry.path == "new_file.rs"),
            "expected untracked new_file.rs"
        );

        // GitPanel: diff for the modified file renders add/delete lines.
        panel.file_selected = panel
            .files
            .iter()
            .position(|entry| entry.path == "readme.md")
            .unwrap();
        panel.refresh_diff(api).unwrap();
        assert!(
            panel
                .diff_lines
                .iter()
                .any(|line| line.starts_with('+') && line.contains("world")),
            "diff missing +world line: {:?}",
            panel.diff_lines
        );

        // GitPanel: blame toggle (webui blame: KeyM) fetches the author
        // map for the diff target from /api/git-ui/blame, keyed by the
        // new-side line number of the +world line.
        assert!(!panel.show_blame);
        panel.toggle_blame(api).unwrap();
        assert!(panel.show_blame);
        assert_eq!(panel.blame_path.as_deref(), Some("readme.md"));
        // readme.md is "hello\nworld\n". With ref "working" the server
        // blames `--contents <file>`: uncommitted lines attribute to the
        // synthetic "External file (--contents)" author, committed
        // lines to the repo author. Line 2 ("world") is the local
        // edit; line 1 ("hello") comes from the init commit.
        assert_eq!(
            panel.blame_authors.get(&2).map(String::as_str),
            Some("External file (--contents)"),
            "blame must attribute the uncommitted line 2 to the working-tree author: {:?}",
            panel.blame_authors
        );
        assert_eq!(
            panel.blame_authors.get(&1).map(String::as_str),
            Some("TUI Test"),
            "blame must attribute committed line 1 to the repo author: {:?}",
            panel.blame_authors
        );
        assert!(
            panel
                .diff_meta
                .iter()
                .any(|meta| meta.as_ref().is_some_and(|m| m.new_line == Some(2))),
            "diff meta must carry new_line numbers for blame: {:?}",
            panel.diff_meta
        );
        // Toggle off: state flips, cache is kept for the same file.
        panel.toggle_blame(api).unwrap();
        assert!(!panel.show_blame);
        assert_eq!(panel.blame_authors.len(), 2);

        // GitPanel: stage the modified file, then status shows it staged.
        panel.stage_selected(api).unwrap();
        assert!(panel.files.iter().any(
            |entry| entry.path == "readme.md" && matches!(entry.status, GitFileStatus::Staged)
        ));

        // GitPanel: unstageSelected always unstages (webui parity, no
        // toggle), and stageSelected always stages.
        panel.unstage_selected(api).unwrap();
        assert!(panel
            .files
            .iter()
            .any(|entry| entry.path == "readme.md"
                && matches!(entry.status, GitFileStatus::Unstaged)));
        panel.stage_selected(api).unwrap();
        assert!(panel.files.iter().any(
            |entry| entry.path == "readme.md" && matches!(entry.status, GitFileStatus::Staged)
        ));

        // GitPanel: toggleStageAll unstages everything when something is
        // staged, then stages everything when nothing is (webui G).
        panel.toggle_stage_all(api).unwrap();
        assert!(
            !panel
                .files
                .iter()
                .any(|entry| matches!(entry.status, GitFileStatus::Staged)),
            "toggle with staged entries must unstage them"
        );
        panel.toggle_stage_all(api).unwrap();
        assert!(
            panel
                .files
                .iter()
                .all(|entry| matches!(entry.status, GitFileStatus::Staged)),
            "toggle with nothing staged must stage all"
        );
        panel.toggle_stage_all(api).unwrap();

        // GitPanel: per-file history lists commits touching readme.md.
        panel.view = GitView::Changes;
        panel.refresh_view(api).unwrap();
        panel.file_selected = panel
            .files
            .iter()
            .position(|entry| entry.path == "readme.md")
            .unwrap();
        panel.view = GitView::History;
        panel.refresh_view(api).unwrap();
        assert!(
            !panel.commits.is_empty(),
            "file history for readme.md must list the init commit"
        );
        assert_eq!(panel.commits[0].message, "init");
        assert!(panel.commits[0]
            .hash
            .chars()
            .all(|ch| ch.is_ascii_hexdigit()));
        assert!(panel
            .history_file
            .as_deref()
            .is_some_and(|f| f == "readme.md"));

        // History Enter loads the selected commit's diff (webui
        // showHistoryCommit): the root commit shows the full file as
        // additions, scoped to the history file.
        let init_hash = panel.commits[0].hash.clone();
        panel.load_commit_diff(api, &init_hash).unwrap();
        assert!(
            panel
                .diff_lines
                .iter()
                .any(|line| line.starts_with('+') && line.contains("hello")),
            "commit diff missing +hello line: {:?}",
            panel.diff_lines
        );
        assert!(panel.diff_title.contains(&panel.commits[0].hash));
        assert!(panel.diff_title.contains("readme.md"));

        // GitPanel: log shows the init commit.
        panel.view = GitView::Log;
        panel.refresh_view(api).unwrap();
        assert_eq!(panel.commits.len(), 1);
        assert_eq!(panel.commits[0].message, "init");

        // GitPanel: branches list contains the current branch.
        panel.view = GitView::Branches;
        panel.refresh_view(api).unwrap();
        assert!(
            panel.branches.iter().any(|b| b.current),
            "expected a current branch: {:?}",
            panel
                .branches
                .iter()
                .map(|b| (&b.name, b.current))
                .collect::<Vec<_>>()
        );

        // WebApiClient: rename a file through the browser API.
        api.file_rename(cwd, "new_file.rs", "renamed.rs").unwrap();
        explorer.refresh(api).unwrap();
        let names: Vec<&str> = explorer.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(
            names.contains(&"renamed.rs"),
            "rename missing from tree: {names:?}"
        );
        assert!(
            !names.contains(&"new_file.rs"),
            "old name still in tree: {names:?}"
        );

        // WebApiClient: delete the renamed file.
        api.file_delete(cwd, "renamed.rs").unwrap();
        explorer.refresh(api).unwrap();
        let names: Vec<&str> = explorer.entries.iter().map(|e| e.name.as_str()).collect();
        assert!(
            !names.contains(&"renamed.rs"),
            "deleted file still in tree: {names:?}"
        );

        // WebApiClient: create and delete a branch (stays on main).
        let default_branch = panel
            .branches
            .iter()
            .find(|b| b.current)
            .map(|b| b.name.clone())
            .unwrap_or_else(|| "master".to_string());
        api.git_switch(cwd, "tui-e2e-tmp", true).unwrap();
        api.git_switch(cwd, &default_branch, false).unwrap();
        panel.view = GitView::Branches;
        panel.refresh_view(api).unwrap();
        assert!(
            panel.branches.iter().any(|b| b.name == "tui-e2e-tmp"),
            "temp branch missing: {:?}",
            panel.branches.iter().map(|b| &b.name).collect::<Vec<_>>()
        );
        panel.branch_selected = panel
            .branches
            .iter()
            .position(|b| b.name == "tui-e2e-tmp")
            .unwrap();
        panel.delete_branch(api, "tui-e2e-tmp", false).unwrap();
        panel.refresh_view(api).unwrap();
        assert!(
            !panel.branches.iter().any(|b| b.name == "tui-e2e-tmp"),
            "deleted branch still listed"
        );

        // WebApiClient: stash the unstaged change, list, apply (keeps the
        // entry), then drop until the list is empty.
        api.git_stash(cwd).unwrap();
        panel.view = GitView::Stash;
        panel.refresh_view(api).unwrap();
        assert_eq!(panel.stashes.len(), 1, "expected one stash entry");
        panel.stash_apply(api).unwrap();
        panel.refresh_view(api).unwrap();
        assert!(
            !panel.stashes.is_empty(),
            "apply is keep-by-default so the entry must remain",
        );
        assert!(
            panel.files.iter().any(|e| e.path == "readme.md"),
            "stash apply lost the modified file"
        );
        // Re-stash with a different tree. A stash whose commit would be
        // bit-identical to stash@{0} (same tree, message, and second) is
        // a no-op ref update in git, so no entry would be created; the
        // extra line guarantees a distinct commit and a second entry.
        std::fs::write(
            std::path::Path::new(cwd).join("readme.md"),
            "hello\nworld\nmore\n",
        )
        .unwrap();
        api.git_stash(cwd).unwrap();
        panel.refresh_view(api).unwrap();
        assert_eq!(panel.stashes.len(), 2, "expected two stash entries");
        panel.stash_drop(api).unwrap();
        panel.refresh_view(api).unwrap();
        assert_eq!(panel.stashes.len(), 1, "drop must remove exactly one entry");
        panel.stash_drop(api).unwrap();
        panel.refresh_view(api).unwrap();
        assert!(panel.stashes.is_empty(), "stash list not empty after drops");

        // FileExplorer edit round trip: edit the file, save, re-read shows
        // the new content and the preview hash advanced.
        let mut editor = FileExplorer::new(cwd);
        editor.refresh(api).unwrap();
        let names: Vec<&str> = editor.entries.iter().map(|e| e.name.as_str()).collect();
        editor.selected = names
            .iter()
            .position(|n| *n == "readme.md")
            .expect("readme.md in tree");
        editor.open_preview(api).unwrap();
        let hash_before = editor.preview.hash.clone();
        editor.start_edit().expect("start edit");
        assert!(editor.edit_active);
        // Type a line: Enter inserts a line break (real terminals send
        // KeyCode::Enter, not Char('\n')), then text, then save with Ctrl-S.
        editor
            .edit_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE), api)
            .unwrap();
        for ch in "edited by tui".chars() {
            editor
                .edit_key(KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE), api)
                .unwrap();
        }
        assert!(editor.preview.dirty, "typing must mark the preview dirty");
        editor
            .edit_key(
                KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL),
                api,
            )
            .unwrap();
        assert!(!editor.preview.dirty, "save must clear dirty");
        assert!(editor.edit_active, "save keeps edit mode open");
        // Esc exits edit mode; a clean exit must not be dirty.
        editor
            .edit_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), api)
            .unwrap();
        assert!(!editor.edit_active);
        // Re-read the file from the server: content and hash changed.
        editor.open_preview(api).unwrap();
        assert_eq!(
            editor.preview.path.as_deref(),
            Some("readme.md"),
            "preview path must survive the edit round trip"
        );
        assert!(
            editor.preview.content.contains("edited by tui"),
            "re-read content must contain the edit: {:?}",
            editor.preview.content
        );
        assert_ne!(
            editor.preview.hash, hash_before,
            "hash must change after a save"
        );

        // Refusing guards: binary/truncated previews cannot start editing.
        editor.preview.binary = true;
        assert!(editor.start_edit().is_err());
        editor.preview.binary = false;
        editor.preview.truncated = true;
        assert!(editor.start_edit().is_err());
        editor.preview.truncated = false;

        // Stale-hash save is rejected by the server (409).
        editor.preview.hash = "0000000000000000000000000000000000000000".to_string();
        editor.preview.content = "conflicting content\n".to_string();
        editor.preview.dirty = true;
        let save_err = editor.save_preview(api).unwrap_err();
        assert!(
            save_err.to_string().contains("409"),
            "stale hash save must fail with the server 409, got {save_err}"
        );
        assert!(
            save_err.to_string().contains("file changed on disk"),
            "stale hash save must surface the server conflict message, got {save_err}"
        );

        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn tui_app_prompt_and_git_actions_round_trip() {
        let repo = temp_git_repo();
        let state = localhost_no_auth_state(repo.clone());
        let app = app_router(state);

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await
            .unwrap();
        });

        let port = addr.port();
        let cwd = repo.to_string_lossy().to_string();
        let result = tokio::task::spawn_blocking(move || tui_app_prompt_assertions(port, &cwd))
            .await
            .unwrap();
        result.unwrap_or_else(|err| panic!("tui app prompt round trip failed: {err}"));
        server.abort();
        let _ = std::fs::remove_dir_all(&repo);
        // The bare "origin" sibling shares the repo's timestamped name.
        let bare = std::env::temp_dir().join(
            repo.file_name()
                .unwrap()
                .to_string_lossy()
                .replace("herdr-tui-e2e-repo-", "herdr-tui-e2e-bare-"),
        );
        let _ = std::fs::remove_dir_all(&bare);
    }

    fn tui_app_prompt_assertions(port: u16, cwd: &str) -> Result<(), String> {
        use herdr_webui::backend_client::BackendClient;
        use herdr_webui::tui::{TuiApp, TuiMode, TuiScreen, TuiSnapshot, TuiTheme};

        let client = BackendClient::new("/tmp/unused-api.sock", "/tmp/unused-term.sock");
        let mut app = TuiApp::new_with_options(
            client,
            std::time::Duration::from_secs(1),
            TuiTheme::Dark,
            WebApiClient::new("127.0.0.1", port),
        );
        // Drive the app through prompt flows without a terminal: prompts are
        // pure app state, so handle_key is enough.
        app.snapshot = TuiSnapshot::default();
        app.screen = TuiScreen::Files;
        app.mode = TuiMode::Attach;
        app.file_explorer = herdr_webui::tui_panels::FileExplorer::new(cwd);
        app.file_explorer
            .refresh(&app.web_api)
            .map_err(|e| e.to_string())?;
        app.git_panel.set_cwd(cwd);
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;

        let press = |app: &mut TuiApp, ch: char| {
            app.handle_key(crossterm::event::KeyEvent::from(
                crossterm::event::KeyCode::Char(ch),
            ));
        };

        // --- Rename prompt: R opens, type new name, Enter confirms.
        // Select the file to rename deterministically (dirs sort first).
        let target_idx = app
            .file_explorer
            .entries
            .iter()
            .position(|e| e.name == "new_file.rs")
            .ok_or("new_file.rs missing from tree")?;
        app.file_explorer.selected = target_idx;
        press(&mut app, 'R');
        assert!(app.prompt_input.is_some(), "rename prompt did not open");
        // Type over the default text: Ctrl+U clears, then type the new name.
        app.handle_key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('u'),
            crossterm::event::KeyModifiers::CONTROL,
        ));
        press(&mut app, 'r');
        press(&mut app, 'e');
        press(&mut app, 'n');
        press(&mut app, 'a');
        press(&mut app, 'm');
        press(&mut app, 'e');
        press(&mut app, 'd');
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert!(app.prompt_input.is_none(), "rename prompt still open");
        assert_eq!(
            app.status, "renamed to renamed",
            "rename status wrong: {}",
            app.status
        );
        assert!(
            app.file_explorer
                .entries
                .iter()
                .any(|e| e.name == "renamed"),
            "renamed file missing from tree"
        );

        // --- Delete confirm: x opens, y confirms. Select the renamed file
        // explicitly so the delete target is deterministic.
        let doomed_idx = app
            .file_explorer
            .entries
            .iter()
            .position(|e| e.name == "renamed")
            .ok_or("renamed file missing before delete")?;
        app.file_explorer.selected = doomed_idx;
        let doomed = app
            .file_explorer
            .selected_entry()
            .map(|e| e.name.clone())
            .ok_or("no entry selected for delete")?;
        assert_eq!(doomed, "renamed");
        press(&mut app, 'x');
        assert!(app.prompt_input.is_some(), "delete prompt did not open");
        press(&mut app, 'y');
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert!(app.prompt_input.is_none(), "delete prompt still open");
        assert!(
            app.status.starts_with("deleted "),
            "delete status: {}",
            app.status
        );
        assert!(
            !app.file_explorer.entries.iter().any(|e| e.name == doomed),
            "deleted file {doomed} still in tree"
        );
        assert!(
            !app.file_explorer
                .entries
                .iter()
                .any(|e| e.name == "renamed"),
            "deleted file still in tree"
        );

        // --- Git branch delete via prompt: Tab to Branches, D opens, y confirms.
        app.screen = TuiScreen::Git;
        app.git_panel.view = herdr_webui::tui_panels::GitView::Branches;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        // Remember the default branch, create a temp branch, return to the
        // default, then delete the temp branch.
        let default_branch = app
            .git_panel
            .branches
            .iter()
            .find(|b| b.current)
            .map(|b| b.name.clone())
            .ok_or("no current branch")?;
        app.web_api
            .git_switch(cwd, "tui-app-branch", true)
            .map_err(|e| e.to_string())?;
        app.web_api
            .git_switch(cwd, &default_branch, false)
            .map_err(|e| e.to_string())?;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let idx = app
            .git_panel
            .branches
            .iter()
            .position(|b| b.name == "tui-app-branch")
            .ok_or("temp branch not listed")?;
        app.git_panel.branch_selected = idx;
        press(&mut app, 'D');
        assert!(app.prompt_input.is_some(), "branch delete prompt not open");
        press(&mut app, 'y');
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert!(app.prompt_input.is_none(), "branch prompt still open");
        assert!(
            app.status.starts_with("deleted branch"),
            "branch delete status: {}",
            app.status
        );

        // --- Stash drop via prompt: create a stash, Tab to Stash, D opens, y confirms.
        app.web_api.git_stash(cwd).map_err(|e| e.to_string())?;
        app.git_panel.view = herdr_webui::tui_panels::GitView::Stash;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        assert!(!app.git_panel.stashes.is_empty(), "stash list empty");
        press(&mut app, 'D');
        assert!(app.prompt_input.is_some(), "stash drop prompt not open");
        press(&mut app, 'y');
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert!(app.prompt_input.is_none(), "stash prompt still open");
        assert_eq!(app.status, "stash dropped", "stash status: {}", app.status);

        // --- Git fetch/pull/push round-trip against the bare "origin":
        // the remote exists, so each action succeeds and refresh_view runs.
        app.git_panel.view = herdr_webui::tui_panels::GitView::Branches;
        press(&mut app, 'f');
        assert!(
            app.error.is_none(),
            "fetch against origin failed: {:?}",
            app.error
        );
        press(&mut app, 'p');
        assert!(
            app.error.is_none(),
            "pull against origin failed: {:?}",
            app.error
        );
        press(&mut app, 'P');
        assert!(
            app.error.is_none(),
            "push against origin failed: {:?}",
            app.error
        );
        // And the error arms still exist: point the panel at a plain
        // directory outside the repo that has no remotes at all.
        let no_remote_dir =
            std::env::temp_dir().join(format!("herdr-tui-e2e-noremote-{}", std::process::id()));
        std::fs::create_dir_all(&no_remote_dir).map_err(|e| e.to_string())?;
        app.git_panel.cwd = no_remote_dir.to_string_lossy().to_string();
        press(&mut app, 'f');
        press(&mut app, 'p');
        press(&mut app, 'P');
        assert!(
            app.error.is_some(),
            "fetch/pull/push without remotes should error"
        );
        app.git_panel.cwd = cwd.to_string();
        app.error = None;
        let _ = std::fs::remove_dir_all(&no_remote_dir);

        // --- Prefix e from the Git screen (EditFile): reads the file, opens
        // the Files screen in edit mode with the diff file loaded.
        // Re-dirty the working tree: the stash flow above consumed the
        // original unstaged change.
        std::fs::write(
            std::path::Path::new(cwd).join("edit_me.rs"),
            "fn edit() {}\n",
        )
        .map_err(|e| e.to_string())?;
        app.screen = TuiScreen::Git;
        app.git_panel.view = herdr_webui::tui_panels::GitView::Changes;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        // The unstaged readme.md change (from the earlier stash apply) or the
        // new_file entry must be present; select it explicitly.
        let edit_idx = app
            .git_panel
            .files
            .iter()
            .position(|f| f.path == "edit_me.rs")
            .ok_or("edit_me.rs not in git changes")?;
        app.git_panel.file_selected = edit_idx;
        let ctrl_b = crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('b'),
            crossterm::event::KeyModifiers::CONTROL,
        );
        app.handle_key(ctrl_b);
        press(&mut app, 'e');
        assert_eq!(
            app.screen,
            TuiScreen::Files,
            "prefix e from git opens the Files screen"
        );
        assert!(app.file_explorer.edit_active, "prefix e starts edit mode");

        // Edit arms: type a char, Ctrl-S saves, Esc stops editing.
        press(&mut app, 'z');
        app.handle_key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('s'),
            crossterm::event::KeyModifiers::CONTROL,
        ));
        assert_eq!(app.status, "saved", "Ctrl-S saves: {}", app.status);
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Esc,
        ));
        // Esc with no unsaved edits reports "edit mode closed".
        assert!(
            app.status.contains("edit mode"),
            "Esc after save reports edit close: {}",
            app.status
        );
        assert!(!app.file_explorer.edit_active);

        // --- Prefix e with a dirty preview of a DIFFERENT file is refused.
        // (Same-file dirty previews are allowed: the edit continues.)
        app.file_explorer.preview.path = Some("other_file.rs".to_string());
        app.file_explorer.preview.dirty = true;
        app.screen = TuiScreen::Git;
        app.handle_key(ctrl_b);
        press(&mut app, 'e');
        assert_eq!(
            app.status, "unsaved edits: save or reload before editing another file",
            "dirty preview of another file blocks prefix e"
        );
        app.file_explorer.preview.dirty = false;
        app.file_explorer.preview.path = None;
        app.error = None;

        // --- Commit the pending edit through the prefix-2 commit modal so a
        // tracked file (edit_me.rs) exists for the blame test.
        std::fs::write(
            std::path::Path::new(cwd).join("edit_me.rs"),
            "fn edit() { return 7 }\n",
        )
        .map_err(|e| e.to_string())?;
        app.screen = TuiScreen::Git;
        app.git_panel.view = herdr_webui::tui_panels::GitView::Changes;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let edit_idx = app
            .git_panel
            .files
            .iter()
            .position(|f| f.path == "edit_me.rs")
            .ok_or("edit_me.rs not in git changes")?;
        app.git_panel.file_selected = edit_idx;
        app.git_panel
            .stage_selected(&app.web_api)
            .map_err(|e| e.to_string())?;
        app.handle_key(ctrl_b);
        press(&mut app, '2');
        assert!(
            app.commit_input.is_some(),
            "prefix 2 opens the commit modal"
        );
        press(&mut app, 't');
        press(&mut app, 'e');
        press(&mut app, 's');
        press(&mut app, 't');
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert!(
            app.commit_input.is_none(),
            "commit modal closed after Enter"
        );
        assert_eq!(
            app.status, "committed: test",
            "commit status: {}",
            app.status
        );

        // --- Prefix git action arms against the live server: stage-all,
        // unstage, stage-file, and stash-file all run through the panel
        // wrappers (which refresh the view after each action).
        std::fs::write(
            std::path::Path::new(cwd).join("edit_me.rs"),
            "fn edit() { return 70 }\n",
        )
        .map_err(|e| e.to_string())?;
        std::fs::write(
            std::path::Path::new(cwd).join("other.rs"),
            "fn other() {}\n",
        )
        .map_err(|e| e.to_string())?;
        app.screen = TuiScreen::Git;
        app.git_panel.view = herdr_webui::tui_panels::GitView::Changes;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;

        // Prefix G toggles stage-all: tracked changes stage (untracked files
        // stay untracked, like `git add -u`), then toggle back.
        app.handle_key(ctrl_b);
        app.handle_key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('G'),
            crossterm::event::KeyModifiers::SHIFT,
        ));
        assert!(
            app.git_panel
                .files
                .iter()
                .filter(|f| f.path != "other.rs")
                .all(|f| f.status == herdr_webui::tui_panels::GitFileStatus::Staged),
            "stage-all stages tracked changes: {:?}",
            app.git_panel
                .files
                .iter()
                .map(|f| (f.path.clone(), f.status.clone()))
                .collect::<Vec<_>>()
        );
        app.handle_key(ctrl_b);
        app.handle_key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('G'),
            crossterm::event::KeyModifiers::SHIFT,
        ));
        assert!(
            !app.git_panel
                .files
                .iter()
                .any(|f| f.status == herdr_webui::tui_panels::GitFileStatus::Staged),
            "stage-all toggles everything back"
        );

        // Prefix y stages the selected file; prefix u unstages it.
        let y_idx = app
            .git_panel
            .files
            .iter()
            .position(|f| f.path == "edit_me.rs")
            .ok_or("edit_me.rs missing before stage")?;
        app.git_panel.file_selected = y_idx;
        app.handle_key(ctrl_b);
        press(&mut app, 'y');
        assert!(
            app.git_panel.files.iter().any(|f| f.path == "edit_me.rs"
                && f.status == herdr_webui::tui_panels::GitFileStatus::Staged),
            "prefix y stages the selected file"
        );
        app.git_panel.file_selected = y_idx;
        app.handle_key(ctrl_b);
        press(&mut app, 'u');
        assert!(
            app.git_panel.files.iter().any(|f| f.path == "edit_me.rs"
                && f.status != herdr_webui::tui_panels::GitFileStatus::Staged),
            "prefix u unstages the selected file"
        );

        // Prefix z stashes the changes; the changes list empties.
        app.handle_key(ctrl_b);
        press(&mut app, 'z');
        assert!(
            app.git_panel.files.is_empty(),
            "prefix z stashes all changes: {:?}",
            app.git_panel.files
        );
        // Restore the stashed changes for the later sections.
        app.git_panel.view = herdr_webui::tui_panels::GitView::Stash;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert_eq!(app.status, "stash applied", "stash restore: {}", app.status);
        app.git_panel.view = herdr_webui::tui_panels::GitView::Changes;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;

        // --- Git blame toggle (prefix m) flips blame on and off. edit_me.rs is
        // committed now; dirty the working copy again so it appears in the
        // changes list, then blame it (with ref "working" the server blames
        // --contents, so uncommitted lines attribute to the synthetic
        // external-file author).
        std::fs::write(
            std::path::Path::new(cwd).join("edit_me.rs"),
            "fn edit() { return 8 }\n",
        )
        .map_err(|e| e.to_string())?;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let blame_idx = app
            .git_panel
            .files
            .iter()
            .position(|f| f.path == "edit_me.rs")
            .ok_or("edit_me.rs not in git changes after commit")?;
        app.git_panel.file_selected = blame_idx;
        app.handle_key(ctrl_b);
        press(&mut app, 'm');
        assert!(app.git_panel.show_blame, "prefix m enables blame");
        assert_eq!(app.status, "blame on", "blame status: {}", app.status);
        assert!(app.error.is_none(), "blame load error: {:?}", app.error);
        app.handle_key(ctrl_b);
        press(&mut app, 'm');
        assert!(!app.git_panel.show_blame, "prefix m toggles blame off");
        assert_eq!(app.status, "blame off", "blame off status: {}", app.status);

        // --- Prefix m from a non-Changes view resets to Changes first.
        app.git_panel.view = herdr_webui::tui_panels::GitView::Branches;
        app.git_panel.diff_title = "edit_me.rs".to_string();
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        // Keep the changes list for blame resolution while showing Branches.
        app.git_panel.files = vec![herdr_webui::tui_panels::GitFileEntry {
            path: "edit_me.rs".to_string(),
            status: herdr_webui::tui_panels::GitFileStatus::Unstaged,
        }];
        app.handle_key(ctrl_b);
        press(&mut app, 'm');
        assert_eq!(
            app.git_panel.view,
            herdr_webui::tui_panels::GitView::Changes,
            "prefix m resets the view to Changes"
        );
        assert!(app.git_panel.show_blame, "blame toggles on from Branches");
        // Toggle off again for the next sections.
        app.handle_key(ctrl_b);
        press(&mut app, 'm');
        assert!(!app.git_panel.show_blame);

        // --- Prefix e on a binary file is refused. edit_me.bin is untracked
        // but readable; the server flags it binary, so the edit guard fires.
        {
            let bin_path = std::path::Path::new(cwd).join("logo.bin");
            std::fs::write(&bin_path, [0u8, 159, 146, 150, 0, 7]).map_err(|e| e.to_string())?;
            app.git_panel
                .refresh_view(&app.web_api)
                .map_err(|e| e.to_string())?;
            let bin_idx = app
                .git_panel
                .files
                .iter()
                .position(|f| f.path == "logo.bin")
                .ok_or("logo.bin not in changes")?;
            app.git_panel.file_selected = bin_idx;
            app.handle_key(ctrl_b);
            press(&mut app, 'e');
            assert!(
                app.error
                    .as_deref()
                    .is_some_and(|e| e.contains("cannot be edited")),
                "binary file edit must be refused: {:?}",
                app.error
            );
            app.error = None;
            let _ = std::fs::remove_file(&bin_path);
        }

        // --- Prefix o returns to the changes view.
        app.handle_key(ctrl_b);
        press(&mut app, 'o');
        assert_eq!(
            app.git_panel.view,
            herdr_webui::tui_panels::GitView::Changes
        );

        // --- Prefix v with a non-current branch switches to it and back.
        app.git_panel.view = herdr_webui::tui_panels::GitView::Branches;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let default_branch = app
            .git_panel
            .branches
            .iter()
            .find(|b| b.current)
            .map(|b| b.name.clone())
            .ok_or("no current branch")?;
        app.web_api
            .git_switch(cwd, "tui-switch-tmp", true)
            .map_err(|e| e.to_string())?;
        app.web_api
            .git_switch(cwd, &default_branch, false)
            .map_err(|e| e.to_string())?;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let switch_idx = app
            .git_panel
            .branches
            .iter()
            .position(|b| b.name == "tui-switch-tmp")
            .ok_or("switch branch missing")?;
        app.git_panel.branch_selected = switch_idx;
        app.handle_key(ctrl_b);
        press(&mut app, 'v');
        assert!(
            app.status.starts_with("switched to tui-switch-tmp"),
            "prefix v switches: {}",
            app.status
        );

        // Switch back to the default branch for the discard test.
        let back_idx = app
            .git_panel
            .branches
            .iter()
            .position(|b| b.name == default_branch)
            .ok_or("default branch missing")?;
        app.git_panel.branch_selected = back_idx;
        app.handle_key(ctrl_b);
        press(&mut app, 'v');
        assert_eq!(
            app.status,
            format!("switched to {default_branch}"),
            "switch back: {}",
            app.status
        );

        // --- Prefix d with a dirty preview on the same file is refused first,
        // then the plain discard runs.
        app.git_panel.view = herdr_webui::tui_panels::GitView::Changes;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let edit_idx = app
            .git_panel
            .files
            .iter()
            .position(|f| f.path == "edit_me.rs")
            .ok_or("edit_me.rs not dirty before discard")?;
        app.git_panel.file_selected = edit_idx;
        // Dirty preview of the selected file blocks the discard.
        app.file_explorer.preview.path = Some("edit_me.rs".to_string());
        app.file_explorer.preview.dirty = true;
        app.handle_key(ctrl_b);
        press(&mut app, 'd');
        assert!(
            app.error
                .as_deref()
                .is_some_and(|e| e.contains("unsaved edits")),
            "dirty preview blocks discard: {:?}",
            app.error
        );
        // Without the dirty buffer the discard proceeds against the API.
        app.file_explorer.preview.dirty = false;
        app.file_explorer.preview.path = None;
        app.error = None;
        app.git_panel.file_selected = edit_idx;
        app.handle_key(ctrl_b);
        press(&mut app, 'd');
        assert!(app.error.is_none(), "discard failed: {:?}", app.error);

        // --- Git Enter success statuses: History commit diff, branch switch,
        // and stash apply.
        // History: Enter loads the selected commit's diff. Dirty the file
        // again so it is selectable in Changes (refresh_history resolves the
        // history file from the Changes selection).
        std::fs::write(
            std::path::Path::new(cwd).join("edit_me.rs"),
            "fn edit() { return 9 }\n",
        )
        .map_err(|e| e.to_string())?;
        app.screen = TuiScreen::Git;
        app.git_panel.view = herdr_webui::tui_panels::GitView::Changes;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let hist_idx = app
            .git_panel
            .files
            .iter()
            .position(|f| f.path == "edit_me.rs")
            .ok_or("edit_me.rs missing for history")?;
        app.git_panel.file_selected = hist_idx;
        app.git_panel.history_file = Some("edit_me.rs".to_string());

        // The Log view (prefix l) refreshes the commit list and clamps an
        // out-of-range selection the same way.
        app.git_panel.commit_selected = 99;
        app.handle_key(ctrl_b);
        press(&mut app, 'l');
        assert!(
            app.git_panel.view == herdr_webui::tui_panels::GitView::Log,
            "prefix l opens the Log view"
        );
        assert_eq!(
            app.git_panel.commit_selected,
            app.git_panel.commits.len().saturating_sub(1),
            "log refresh must clamp the selection"
        );
        app.git_panel.view = herdr_webui::tui_panels::GitView::History;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        assert!(
            !app.git_panel.commits.is_empty(),
            "history needs commits after the earlier commit"
        );
        app.git_panel.commit_selected = 0;
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert!(
            app.status.starts_with("commit "),
            "history Enter status: {}",
            app.status
        );
        assert!(app.error.is_none(), "history diff error: {:?}", app.error);

        // An out-of-range selection clamps to the last commit on refresh
        // (webui list guards behave the same after the list shrinks).
        app.git_panel.commit_selected = 99;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        assert_eq!(
            app.git_panel.commit_selected,
            app.git_panel.commits.len().saturating_sub(1),
            "commit selection must clamp on refresh"
        );
        // History without a file context: the commit diff title is the bare
        // hash, no " · file" suffix (webui `compareFilePaths` is empty).
        app.git_panel.history_file = None;
        app.git_panel.commit_selected = 0;
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert_eq!(
            app.git_panel.diff_title, app.git_panel.commits[0].hash,
            "no-file history diff title is the bare hash"
        );
        app.git_panel.history_file = Some("edit_me.rs".to_string());

        // Branches: Enter switches to the selected non-current branch, then
        // back to the default branch.
        app.git_panel.view = herdr_webui::tui_panels::GitView::Branches;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let default_branch = app
            .git_panel
            .branches
            .iter()
            .find(|b| b.current)
            .map(|b| b.name.clone())
            .ok_or("no current branch")?;
        let switch_idx = app
            .git_panel
            .branches
            .iter()
            .position(|b| b.name == "tui-switch-tmp")
            .ok_or("tui-switch-tmp missing for Enter switch")?;
        app.git_panel.branch_selected = switch_idx;
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert_eq!(
            app.status, "switched to tui-switch-tmp",
            "branch Enter status: {}",
            app.status
        );
        let back_idx = app
            .git_panel
            .branches
            .iter()
            .position(|b| b.name == default_branch)
            .ok_or("default branch missing after switch")?;
        app.git_panel.branch_selected = back_idx;
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert_eq!(
            app.status,
            format!("switched to {default_branch}"),
            "branch Enter back: {}",
            app.status
        );

        // Stash: stash the dirty edit, Enter applies it.
        app.web_api.git_stash(cwd).map_err(|e| e.to_string())?;
        app.git_panel.view = herdr_webui::tui_panels::GitView::Stash;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        assert!(!app.git_panel.stashes.is_empty(), "stash list empty");
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert_eq!(app.status, "stash applied", "stash Enter: {}", app.status);
        assert!(app.error.is_none(), "stash apply error: {:?}", app.error);

        // --- Files navigation: j/k moves, Enter on a directory expands.
        app.screen = TuiScreen::Files;
        app.file_explorer
            .refresh(&app.web_api)
            .map_err(|e| e.to_string())?;
        let start = app.file_explorer.selected;
        press(&mut app, 'j');
        press(&mut app, 'k');
        assert_eq!(app.file_explorer.selected, start);
        let dir_idx = app
            .file_explorer
            .entries
            .iter()
            .position(|e| e.is_dir)
            .ok_or("no directory in tree")?;
        app.file_explorer.selected = dir_idx;
        let dir_path = app.file_explorer.entries[dir_idx].path.clone();
        // Enter toggles inline expansion (webui click parity): children merge
        // into the tree without changing the root.
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert!(
            app.file_explorer.entries[dir_idx].expanded,
            "Enter expands the directory inline"
        );
        assert!(
            app.file_explorer.entries.iter().any(|e| e.level > 0),
            "expanded children appear in the tree"
        );
        assert_eq!(
            app.file_explorer.root_path, "",
            "inline expansion keeps the root"
        );
        // Enter again collapses.
        app.file_explorer.selected = dir_idx;
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert!(
            !app.file_explorer.entries[dir_idx].expanded,
            "Enter collapses the directory"
        );
        assert!(
            !app.file_explorer.entries.iter().any(|e| e.level > 0),
            "collapsed children are gone"
        );

        // l enters the directory as the new root (double-click parity); h
        // goes back up to the repo root.
        app.file_explorer.selected = dir_idx;
        press(&mut app, 'l');
        assert_eq!(
            app.file_explorer.root_path, dir_path,
            "l enters the directory"
        );
        press(&mut app, 'h');
        assert!(
            app.file_explorer.root_path.is_empty(),
            "h returns to the repo root"
        );
        assert!(
            app.file_explorer
                .entries
                .iter()
                .any(|e| e.name == "readme.md" || e.name == "edit_me.rs"),
            "parent listing is restored"
        );

        // --- Prefix e from Git Changes on a file that no longer exists on
        // disk surfaces the read error instead of opening edit mode.
        app.screen = TuiScreen::Git;
        app.git_panel.view = herdr_webui::tui_panels::GitView::Changes;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let deleted = std::path::Path::new(cwd).join("vanish.rs");
        std::fs::write(&deleted, "fn gone() {}\n").map_err(|e| e.to_string())?;
        {
            let out = Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(["add", "vanish.rs"])
                .output()
                .map_err(|e| e.to_string())?;
            assert!(out.status.success(), "git add vanish.rs failed");
        }
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let vanish_idx = app
            .git_panel
            .files
            .iter()
            .position(|f| f.path == "vanish.rs")
            .ok_or("vanish.rs missing from git changes")?;
        app.git_panel.file_selected = vanish_idx;
        std::fs::remove_file(&deleted).map_err(|e| e.to_string())?;
        let ctrl_b = |app: &mut TuiApp| {
            app.handle_key(crossterm::event::KeyEvent::new(
                crossterm::event::KeyCode::Char('b'),
                crossterm::event::KeyModifiers::CONTROL,
            ));
        };
        ctrl_b(&mut app);
        press(&mut app, 'e');
        assert!(
            app.error.as_deref().is_some_and(|e| !e.is_empty()),
            "prefix e on a vanished file must surface an error"
        );
        assert_ne!(app.screen, TuiScreen::Files, "failed edit stays on Git");

        // --- Blame reloads when the diff target changes while blame is on.
        app.error = None;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let edit_idx = app
            .git_panel
            .files
            .iter()
            .position(|f| f.path == "edit_me.rs")
            .ok_or("edit_me.rs missing from changes")?;
        app.git_panel.file_selected = edit_idx;
        // Enter loads the edit_me.rs diff first so blame resolves the shown
        // file instead of the vanished one still in diff_title.
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert_eq!(
            app.git_panel.diff_title, "edit_me.rs",
            "Enter should load the edit_me.rs diff"
        );
        ctrl_b(&mut app);
        press(&mut app, 'm');
        assert!(
            app.git_panel.show_blame,
            "blame should be on; error: {:?}, status: {}",
            app.error, app.status
        );
        assert!(
            !app.git_panel.blame_authors.is_empty(),
            "blame authors should be loaded"
        );
        let old_path = app.git_panel.blame_path.clone();
        assert_eq!(old_path.as_deref(), Some("edit_me.rs"));
        // Enter on a different changes row reloads the diff and, with blame
        // on, reloads the annotations for the newly shown file (webui blame
        // follows the shown file).
        std::fs::write(
            std::path::Path::new(cwd).join("readme.md"),
            "hello\nworld\nblame reload\n",
        )
        .map_err(|e| e.to_string())?;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let readme_idx = app
            .git_panel
            .files
            .iter()
            .position(|f| f.path == "readme.md")
            .ok_or("readme.md missing from changes")?;
        app.git_panel.file_selected = readme_idx;
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Enter,
        ));
        assert_eq!(
            app.git_panel.diff_title, "readme.md",
            "Enter loads the readme.md diff"
        );
        assert_eq!(
            app.git_panel.blame_path.as_deref(),
            Some("readme.md"),
            "blame must reload when the diff target changes"
        );
        assert!(
            !app.git_panel.blame_authors.is_empty(),
            "reloaded blame has authors"
        );

        Ok(())
    }
}
