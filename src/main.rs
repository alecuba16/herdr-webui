use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::net::SocketAddr;
use std::panic::resume_unwind;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path as AxumPath, Query, State};
#[cfg(test)]
use axum::http::{header, HeaderValue};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use axum_server::tls_rustls::RustlsConfig;
use interprocess::TryClone as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::auth::{AuthConfig, LoginRateLimiter, LoginRequest};
#[cfg(test)]
use crate::builtin_detection::JcodeDetectionVariant;
use server_settings::{
    apply_cli_overrides, load_runtime_server_settings, log_event, save_runtime_server_settings,
    server_settings_path, settings_public_json, BackendMode, LogLevel, RecentWorkspace,
    RuntimeServerSettings,
};
#[cfg(test)]
use server_settings::{
    default_runtime_server_settings, validate_runtime_server_settings, PersistedServerSettings,
};

mod assets;
mod auth;
mod builtin_backend;
mod builtin_detection;
mod builtin_events;
mod compat;
mod file_browser;
mod git_ui;
mod lsp;
mod protocol;
mod server_settings;
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
    mobile_actions_js, mobile_attention_js, mobile_backend_js, mobile_core_js, mobile_css,
    mobile_events_js, mobile_file_browser_js, mobile_git_js, mobile_js, mobile_panels_js,
    mobile_screens_js, mobile_search_js, mobile_sessions_js, mobile_settings_js,
    mobile_terminal_js, mobile_theme_js, mobile_workmeta_js, mobile_worktrees_js,
    shared_actions_js, shared_attention_js, shared_colors_css, shared_content_search_css,
    shared_core_js, shared_editor_js, shared_file_content_search_js, shared_file_icons_css,
    shared_file_icons_js, shared_file_tree_css, shared_file_tree_js, shared_graphics_bridge_js,
    shared_http_js, shared_line_context_js, shared_lsp_js, shared_markdown_preview_css,
    shared_markdown_preview_js, shared_options_js, shared_settings_confirm_js,
    shared_settings_feedback_js, shared_temp_terminal_js, shared_terminal_adapter_js,
    shared_terminal_fit_js, shared_terminal_scroll_js, shared_workspace_search_js,
    vendor_codemirror_js, vendor_dompurify_js, vendor_ghostty_wasm, vendor_marked_js,
    vendor_mermaid_js, vendor_wterm_css, vendor_wterm_js,
};
use compat::SimpleVersion;
use compat::{backend_compatibility, BackendCompatibility};
use protocol::*;

const DEFAULT_BIND: &str = "127.0.0.1:8787";
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
/// Canonical names of built-in sessions the user explicitly closed. Close is
/// a destructive action: the workspace state is gone, so the marker stops
/// every auto-start path (workspace proxying, events socket, terminal) from
/// silently resurrecting the session. An explicit `/api/session/launch`
/// clears the marker; a fresh WebUI process starts with no markers.
type ClosedBuiltinSessions = Arc<Mutex<HashSet<String>>>;
/// Server-side guard for temporary tabs going through promote.
/// `Promoting(n)` counts promote requests the backend has not answered
/// yet, so the terminal WS teardown (which can fire at any moment, e.g. a
/// network blip or navigation during the promote round-trip) must not
/// auto-close the tab before the backend decides. `Promoted` marks a
/// promote that succeeded; the skip must persist because the
/// release-toggle frame from the overlay can still be lost afterwards.
/// When all in-flight promotes of a tab finish with failures the marker is
/// removed, so the tab stays closable like any normal temporary tab.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PromotedTemporaryTabState {
    /// `n` concurrent unanswered promote requests for this tab.
    Promoting(u32),
    Promoted,
}

type PromotedTemporaryTabs = Arc<Mutex<HashMap<String, PromotedTemporaryTabState>>>;

/// Marks a tab as having another in-flight promote request. Never
/// downgrades a tab that is already promoted.
fn begin_temporary_tab_promote(registry: &PromotedTemporaryTabs, tab_id: &str) {
    let tab_id = tab_id.trim();
    if tab_id.is_empty() {
        return;
    }
    if let Ok(mut registry) = registry.lock() {
        match registry.get_mut(tab_id) {
            Some(PromotedTemporaryTabState::Promoting(count)) => {
                *count = count.saturating_add(1);
            }
            Some(PromotedTemporaryTabState::Promoted) => {}
            None => {
                registry.insert(tab_id.to_string(), PromotedTemporaryTabState::Promoting(1));
            }
        }
    }
}

/// Marks one previously in-flight promote as finished. `promoted` keeps the
/// tab protected forever (the shell is now a real workspace tab), while a
/// failed promote decrements the in-flight count and removes the marker at
/// zero, restoring normal auto-close semantics.
fn finish_temporary_tab_promote(registry: &PromotedTemporaryTabs, tab_id: &str, promoted: bool) {
    let tab_id = tab_id.trim();
    if tab_id.is_empty() {
        return;
    }
    if let Ok(mut registry) = registry.lock() {
        if promoted {
            registry.insert(tab_id.to_string(), PromotedTemporaryTabState::Promoted);
            return;
        }
        // Only decrement our own in-flight count; never touch a tab a
        // concurrent promote already finished successfully.
        if let Some(PromotedTemporaryTabState::Promoting(count)) = registry.get_mut(tab_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                registry.remove(tab_id);
            }
        }
    }
}

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
    /// True when --https was passed explicitly and must override persisted
    /// settings (same contract as `bind_explicit`).
    tls_mode_explicit: bool,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TlsMode {
    Off,
    Auto,
    SelfSigned,
    Files,
}

/// The address and TLS mode the listener must (re)build with. The rebind
/// watch channel carries this so a settings change can hot-swap the scheme
/// (http <-> https) exactly like it hot-swaps the bind address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ListenEndpoint {
    bind: SocketAddr,
    tls_mode: TlsMode,
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
            tls_mode_explicit: tls_mode_set,
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

impl TlsMode {
    pub fn as_str(self) -> &'static str {
        match self {
            TlsMode::Off => "off",
            TlsMode::Auto => "auto",
            TlsMode::SelfSigned => "self-signed",
            TlsMode::Files => "files",
        }
    }

    pub fn scheme(self) -> &'static str {
        match self {
            TlsMode::Off => "http",
            TlsMode::Auto | TlsMode::SelfSigned | TlsMode::Files => "https",
        }
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
herdr-webui install-linux [--verbose] [--bind HOST:PORT] [--https off|auto|self-signed|files] [--tls-cert PATH --tls-key PATH] [--session NAME]\n\
herdr-webui update-linux [--verbose]\n\
herdr-webui start-mac | start [--verbose]\n\
herdr-webui stop-mac | stop [--verbose]\n\
herdr-webui restart-mac | restart [--verbose]\n\
herdr-webui start-linux | start [--verbose]\n\
herdr-webui stop-linux | stop [--verbose]\n\
herdr-webui restart-linux | restart [--verbose]\n\
herdr-webui uninstall-mac [--verbose]\n\
herdr-webui uninstall-linux [--verbose]\n\
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
    closed_builtin_sessions: ClosedBuiltinSessions,
    promoted_temporary_tabs: PromotedTemporaryTabs,
    /// Serializes built-in session cold starts. Several handlers can
    /// auto-start the same session concurrently on a fresh browser load;
    /// without a lock two starts would race on binding the session socket
    /// and the loser would fail with AddrInUse.
    builtin_start_lock: Arc<Mutex<()>>,
    herdr_bin: String,
    auth: Arc<Mutex<AuthConfig>>,
    /// Per-IP failed-login throttle backing the /api/login guard.
    login_limiter: Arc<LoginRateLimiter>,
    server_settings: Arc<Mutex<RuntimeServerSettings>>,
    no_sleep: Arc<Mutex<NoSleepState>>,
    rebind_tx: tokio::sync::watch::Sender<ListenEndpoint>,
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
    /// Delegates the raw request/response framing to the shared client
    /// so the WebUI proxy and the TUI cannot drift on wire format.
    backend: herdr_webui::backend_client::BackendClient,
}

impl ApiClient {
    /// Raw JSON request/response, one message per line. The framing
    /// lives in BackendClient::request_raw; this keeps the WebUI's
    /// plain-string error surface (handlers map it to status codes).
    fn request_value(&self, request: serde_json::Value) -> Result<serde_json::Value, String> {
        self.backend
            .request_raw(request)
            .map_err(|err| err.to_string())
    }

    /// Subscribe to backend events: opens the control socket, sends
    /// the subscription request, consumes the ack, and keeps the
    /// stream open for later reads. The event socket has no framing
    /// equivalent in BackendClient, so the connect/write prologue is
    /// reproduced here against the same socket path.
    fn subscribe(&self, request: serde_json::Value) -> Result<EventStream, String> {
        let mut stream =
            connect_local_stream(self.backend.api_socket()).map_err(|err| err.to_string())?;
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
    let listen_endpoint = {
        let settings = server_settings.lock().unwrap();
        ListenEndpoint {
            bind: settings.bind,
            tls_mode: settings.tls_mode,
        }
    };
    let (rebind_tx, rebind_rx) = tokio::sync::watch::channel(listen_endpoint);
    let (settings_tx, _) = tokio::sync::broadcast::channel(16);
    let closed_builtin_sessions: ClosedBuiltinSessions = Arc::new(Mutex::new(HashSet::new()));
    let promoted_temporary_tabs: PromotedTemporaryTabs = Arc::new(Mutex::new(HashMap::new()));
    let state = WebState {
        api_socket,
        client_socket,
        session_name: config.session.clone(),
        backend_mode,
        _builtin_backend: None,
        builtin_sessions,
        closed_builtin_sessions,
        promoted_temporary_tabs,
        builtin_start_lock,
        herdr_bin: std::env::var("HERDR_WEB_HERDR_BIN").unwrap_or_else(|_| "herdr".to_string()),
        auth,
        login_limiter: Arc::new(LoginRateLimiter::new()),
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

/// Maximum socket path length the OS can bind/connect. Unix sun_path is
/// 104 bytes on macOS (108 on Linux) but the built-in backend deliberately
/// keeps a stricter budget (<100) so the same guard works everywhere; the
/// external-session guard reuses it. On Windows named pipes have no such
/// limit and the check passes trivially.
pub const SOCKET_PATH_LIMIT: usize = 100;

fn socket_path_pair_fits(paths: &(PathBuf, PathBuf)) -> bool {
    socket_path_fits(&paths.0) && socket_path_fits(&paths.1)
}

#[cfg(unix)]
fn socket_path_fits(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    path.as_os_str().as_bytes().len() < SOCKET_PATH_LIMIT
}

#[cfg(not(unix))]
fn socket_path_fits(_path: &Path) -> bool {
    true
}

async fn serve_rebindable(
    state: WebState,
    mut rebind_rx: tokio::sync::watch::Receiver<ListenEndpoint>,
    tls: TlsConfig,
) -> io::Result<()> {
    let mut sigterm = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        .map_err(io::Error::other)?;
    let mut sigint = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())
        .map_err(io::Error::other)?;

    loop {
        let endpoint = *rebind_rx.borrow_and_update();
        let bind = endpoint.bind;
        // The settings tls_mode is authoritative on every rebuild: an explicit
        // --https flag was folded into the settings at startup by
        // apply_cli_overrides, so it wins over the persisted file until the
        // operator changes the protocol through the settings API.
        let tls = TlsConfig {
            mode: endpoint.tls_mode,
            ..tls.clone()
        };
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
        .route(
            "/api/recent-workspaces/record",
            post(record_recent_workspace_endpoint),
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
        .route("/api/tabs/{tab_id}/promote", post(promote_tab))
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
        .route("/assets/shared/http.js", get(shared_http_js))
        .route("/assets/shared/attention.js", get(shared_attention_js))
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
            "/assets/shared/graphics-bridge.js",
            get(shared_graphics_bridge_js),
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
        .route("/assets/mobile/search.js", get(mobile_search_js))
        .route("/assets/mobile/git.js", get(mobile_git_js))
        .route("/assets/mobile/sessions.js", get(mobile_sessions_js))
        .route("/assets/mobile/events.js", get(mobile_events_js))
        .route("/assets/mobile/screens.js", get(mobile_screens_js))
        .route("/assets/mobile/panels.js", get(mobile_panels_js))
        .route("/assets/mobile/workmeta.js", get(mobile_workmeta_js))
        .route("/assets/mobile/theme.js", get(mobile_theme_js))
        .route("/assets/mobile/actions.js", get(mobile_actions_js))
        .route("/assets/mobile/backend.js", get(mobile_backend_js))
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
        .route("/ws/terminal-graphics", get(terminal_graphics_ws))
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
                backend: herdr_webui::backend_client::BackendClient::new(
                    api_socket,
                    PathBuf::new(),
                ),
            }
        }
        SessionBackendTarget::ExternalHerdr => {
            if session.is_none() {
                if let Some(socket_path) = &state.api_socket {
                    return ApiClient {
                        backend: herdr_webui::backend_client::BackendClient::new(
                            socket_path.clone(),
                            PathBuf::new(),
                        ),
                    };
                }
            }
            ApiClient {
                backend: herdr_webui::backend_client::BackendClient::new(
                    api_socket_path_for(session),
                    PathBuf::new(),
                ),
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
#[allow(dead_code)]
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
    crate::auth::authorized(&state.auth, headers, remote)
}

#[allow(clippy::result_large_err)]
pub(crate) fn require_auth(
    state: &WebState,
    headers: &HeaderMap,
    remote: SocketAddr,
) -> Result<(), Response> {
    crate::auth::require_auth(&state.auth, headers, remote)
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
    tls_mode: Option<TlsMode>,
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
    if let Ok(mut auth_lock) = state.auth.lock() {
        *auth_lock = auth;
    }
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
    // Closed means closed: a user-closed session must not be resurrected by
    // workspace proxying, the events socket, or the terminal auto-start.
    // Only an explicit /api/session/launch clears the marker and starts it.
    if state
        .closed_builtin_sessions
        .lock()
        .map(|closed| closed.contains(&session_name))
        .unwrap_or(false)
    {
        return Ok(());
    }
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
        // An explicit launch revives the session: clear the closed marker so
        // ensure_builtin_session (and every later auto-start) can run again.
        let canonical = canonical_session_name(session.as_deref());
        if let Ok(mut closed) = state.closed_builtin_sessions.lock() {
            closed.remove(&canonical);
        }
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
        let stopped = response.status().is_success();
        if let Ok(mut sessions) = state.builtin_sessions.lock() {
            sessions.remove(&session_name);
        }
        if stopped {
            mark_closed_builtin_session(&state, &session_name);
        }
        return response;
    }
    let api = api_for_target_session(&state, backend, session.as_deref());
    proxy_server_stop(api).await
}

/// Record a successful built-in session close and remove its on-disk residue.
///
/// Close is destructive and final until an explicit relaunch: the marker stops
/// every auto-start path (workspace proxying, events socket, terminal) from
/// resurrecting the stopped backend, the socket files are deleted so no
/// stale connect target remains, and the session's `builtin/<name>` directory
/// is removed once empty so the session disappears from the manager list
/// (known_builtin_sessions discovers sessions there). The `default` directory
/// is never removed: closing the default session must not delete the slot
/// fresh sessions relaunch into. All filesystem steps are best-effort; the
/// close itself already succeeded.
fn mark_closed_builtin_session(state: &WebState, session_name: &str) {
    if let Ok(mut closed) = state.closed_builtin_sessions.lock() {
        closed.insert(session_name.to_string());
    }
    let (api_socket, client_socket) = builtin_socket_paths(Some(session_name));
    for socket in [&api_socket, &client_socket] {
        let _ = fs::remove_file(socket);
    }
    if session_name == "default" {
        return;
    }
    if let Some(dir) = api_socket.parent() {
        let empty = fs::read_dir(dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false);
        if empty {
            let _ = fs::remove_dir(dir);
        }
    }
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
    // Linux also returns ECONNREFUSED when the socket path is not a socket
    // file at all; the dead-listener classification below checks the file
    // type, which needs the unix extension trait in scope.
    #[cfg(unix)]
    use std::os::unix::fs::FileTypeExt;
    // Capture before `api` moves into the closure below: the path must be
    // an actual socket file for ECONNREFUSED to count as a dead listener
    // (Linux also refuses non-socket paths with ECONNREFUSED).
    let socket_path_is_socket = api
        .backend
        .api_socket()
        .metadata()
        .map(|meta| meta.file_type().is_socket())
        .unwrap_or(false);
    let request = json!({ "id": "web:server:stop", "method": "server.stop", "params": {} });
    match tokio::task::spawn_blocking(move || api.request_value(request)).await {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(err)) => {
            // The backend may have died without removing its socket file
            // (crash, kill -9). Removing a stale session row must still
            // count as success: there is nothing left to stop. LocalStream
            // connect surfaces a missing socket path as ENOENT ("No such
            // file or directory"). A dead listener with the socket file
            // still bound surfaces as ECONNREFUSED ("Connection refused"),
            // the same stale-row case: the path exists but nobody accepts.
            let is_missing_socket = err.contains("No such file or directory");
            // Linux also returns ECONNREFUSED when the path is not a socket
            // file at all (a regular file, a directory...), which is a real
            // error, not a crashed backend. Only a socket file nobody accepts
            // on is a dead listener. macOS surfaces non-socket paths as
            // ENOTSOCK ("Socket type not supported") instead, so the gate
            // only changes behavior for the misconfigured-path class.
            let is_dead_listener = (err.contains("Connection refused")
                || err.contains("ConnectionRefused"))
                && socket_path_is_socket;
            let is_connection_drop = err.contains("empty response")
                || err.contains("closed the control socket")
                || err.contains("UnexpectedEof")
                || err.contains("ConnectionReset")
                || err.contains("Connection reset")
                || err.contains("broken pipe")
                || err.contains("Broken pipe");
            if is_missing_socket || is_dead_listener {
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

async fn login(
    State(state): State<WebState>,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<LoginRequest>,
) -> Response {
    if state.login_limiter.is_blocked(remote.ip()) {
        log_event(&state.log_level(), &format!("login: rate limited {remote}"));
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({ "error": "too many attempts" })),
        )
            .into_response();
    }
    let secure = state
        .server_settings
        .lock()
        .map(|settings| settings.tls_mode != TlsMode::Off)
        .unwrap_or(false);
    let Ok(auth) = state.auth.lock() else {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "auth unavailable" })),
        )
            .into_response();
    };
    if auth.localhost_bypass(remote) {
        drop(auth);
        log_event(
            &state.log_level(),
            &format!("login: localhost bypass for {remote}"),
        );
        return crate::auth::login_response(&state.auth, secure);
    }
    let ok = auth.verify_credentials(&body.username, &body.password);
    drop(auth);
    if !ok {
        state.login_limiter.record_failure(remote.ip());
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
    state.login_limiter.reset(remote.ip());
    log_event(
        &state.log_level(),
        &format!("login: success for user '{}' from {remote}", body.username),
    );
    crate::auth::login_response(&state.auth, secure)
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
    // Drop entries whose folder no longer exists so the palette only offers
    // reopenable targets, and persist the pruning so stale paths stay gone.
    // The lock-poisoned arm keeps returning an empty list.
    let snapshot = match state.server_settings.lock() {
        Ok(guard) => guard.recent_workspaces.clone(),
        Err(_) => return Json(json!({ "recent": [] })).into_response(),
    };
    // Existence checks touch the filesystem, so they run outside the lock.
    let missing: Vec<String> = snapshot
        .iter()
        .filter(|item| !Path::new(&expand_user_path_string(&item.path)).is_dir())
        .map(|item| item.path.clone())
        .collect();
    let recent = if missing.is_empty() {
        snapshot
    } else {
        let Ok(mut guard) = state.server_settings.lock() else {
            return Json(json!({ "recent": [] })).into_response();
        };
        guard
            .recent_workspaces
            .retain(|item| !missing.contains(&item.path));
        guard.recent_workspaces.clone()
    };
    if !missing.is_empty() {
        if let Err(err) = persist_server_settings(&state).await {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": err.to_string() })),
            )
                .into_response();
        }
    }
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

/// Record a workspace the client just opened/created through a
/// non-WebUI path (the TUI talks to the backend socket directly, so
/// its workspace.create/worktree.open flows never pass through the
/// recording proxies). Record-only: like the desktop's fire-and-forget
/// POST after `POST /api/workspaces`, a failed record must never
/// fail the client operation.
async fn record_recent_workspace_endpoint(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<RecordRecentWorkspaceRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    // Validate the raw path BEFORE expanding, matching the remove/open
    // endpoints: empty paths 400 instead of recording the home dir.
    let raw_path = body.path.as_deref().unwrap_or_default();
    if raw_path.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path is required" })),
        )
            .into_response();
    }
    let path = expand_user_path_string(raw_path).trim().to_string();
    match record_recent_workspace(
        &state,
        &path,
        body.label.clone(),
        body.branch.clone(),
        body.kind.clone(),
    )
    .await
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
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

#[derive(Deserialize)]
struct RecordRecentWorkspaceRequest {
    path: Option<String>,
    label: Option<String>,
    branch: Option<String>,
    kind: Option<String>,
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
    // Validate the raw path BEFORE expanding: an empty or whitespace-only
    // path must 400 instead of expanding "~"/"" into the home directory,
    // opening it as a workspace, and recording it in recents.
    let raw_path = body.path.as_deref().unwrap_or_default();
    if raw_path.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "path is required" })),
        )
            .into_response();
    }
    // A recent entry whose folder vanished cannot be reopened: reject the
    // request before proxying so the backend never opens a workspace rooted
    // at a missing path (mirrors the create-workspace check).
    let cwd = match existing_workspace_cwd(Some(raw_path)) {
        Ok(cwd) => cwd,
        Err(response) => return *response,
    };
    let path = cwd.clone();
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

/// Folds a failed `spawn_blocking` join into the promote route's error
/// channel. A panic in the backend call must still propagate (it may hold
/// poisoned locks or invariant breakage worth crashing on), while a plain
/// join failure (task cancelled, runtime shutdown) degrades to its message
/// so the route can restore auto-close semantics and answer 502.
fn promote_join_failure(join: tokio::task::JoinError) -> String {
    match join.try_into_panic() {
        Ok(panic) => resume_unwind(panic),
        Err(err) => err.to_string(),
    }
}

/// Promotes a temporary terminal tab into a workspace rooted at the shell's
/// live cwd. Thin proxy: the backend owns the semantics (registry-only
/// re-parent, never stopping the process); the HTTP result carries the full
/// workspace/tab/pane payload the browser navigates from. On success the
/// promoted workspace is also recorded in recent workspaces, mirroring
/// create/open routes (the path comes from the result because the backend
/// resolves the live cwd).
async fn promote_tab(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    AxumPath(tab_id): AxumPath<String>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let api = api_for_headers_ensured(&state, &headers).await;
    // Arm the in-flight guard before the backend call: the overlay's
    // terminal WS can start teardown at any point of this round-trip
    // (navigation, network blip, browser close). Without the pre-arm the
    // auto-close wins the race, kills the live shell the user asked to
    // keep, and the promote then fails with "tab not found".
    begin_temporary_tab_promote(&state.promoted_temporary_tabs, &tab_id);
    let tab_id_for_registry = tab_id.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        api.request_value(json!({
            "id": "web:tab:promote",
            "method": "tab.promote",
            "params": { "tab_id": tab_id },
        }))
    })
    .await
    // Fold the spawn_blocking join failure (runtime shutdown or a panic in
    // the backend call) into the same error channel as a failed backend
    // call: panics still propagate, join failures degrade to their message,
    // and a single Err arm below restores auto-close for both.
    .map_err(promote_join_failure)
    .and_then(|inner| inner);
    match outcome {
        Ok(value) => {
            // Relay the full envelope; the browser reads the workspace/tab/
            // pane fields from it (or shows the backend error inside it).
            // Record the tab id before relaying, but only on a promote
            // success: if this socket dies before the overlay's release
            // toggle frame is delivered, the terminal WS teardown must
            // still skip the auto-close for the freshly promoted tab (see
            // terminal_socket cleanup). A failed promote must stay closable.
            let promoted_ok = value.get("error").is_none();
            finish_temporary_tab_promote(
                &state.promoted_temporary_tabs,
                &tab_id_for_registry,
                promoted_ok,
            );
            let workspace = value
                .get("result")
                .and_then(|result| result.get("workspace"));
            let cwd = workspace
                .and_then(|workspace| workspace.get("cwd"))
                .and_then(|cwd| cwd.as_str())
                .map(|cwd| cwd.trim().to_string())
                .unwrap_or_default();
            let label = workspace
                .and_then(|workspace| workspace.get("label"))
                .and_then(|label| label.as_str())
                .map(|label| label.trim().to_string())
                .filter(|label| !label.is_empty());
            if !cwd.is_empty() {
                // Recording must not fail or delay the promote response:
                // errors are swallowed like in open_recent_workspace.
                let _ = record_recent_workspace(
                    &state,
                    &cwd,
                    label,
                    None,
                    Some("workspace".to_string()),
                )
                .await;
            }
            Json(value).into_response()
        }
        Err(err) => {
            // The backend call itself failed (dead socket, daemon stop, or
            // the spawn_blocking task died): restore normal auto-close
            // semantics for this tab.
            finish_temporary_tab_promote(
                &state.promoted_temporary_tabs,
                &tab_id_for_registry,
                false,
            );
            (StatusCode::BAD_GATEWAY, Json(json!({ "error": err }))).into_response()
        }
    }
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

/// Query for the external-backend graphics bridge WS. The bridge opens a
/// parallel ClientShell-mode connection pinned to the terminal's tab so the
/// browser can render the tab's Kitty graphics scene on a canvas overlay,
/// while the attach connection keeps feeding wterm the pane text.
#[derive(Deserialize)]
struct TerminalGraphicsQuery {
    tab_id: String,
    cols: Option<u16>,
    rows: Option<u16>,
    cell_width_px: Option<u32>,
    cell_height_px: Option<u32>,
    session: Option<String>,
    backend: Option<String>,
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
        let promoted_temporary_tabs = state.promoted_temporary_tabs.clone();
        terminal_socket(
            client_socket_path,
            api,
            attach_backend,
            query,
            socket,
            promoted_temporary_tabs,
        )
    })
}

async fn terminal_socket(
    path: PathBuf,
    api: ApiClient,
    backend: SessionBackendTarget,
    query: TerminalQuery,
    mut socket: WebSocket,
    promoted_temporary_tabs: PromotedTemporaryTabs,
) {
    let terminal_id = query.terminal_id.clone();
    let cols = query.cols.unwrap_or(100).max(1);
    let rows = query.rows.unwrap_or(30).max(1);
    // Per-connection flag armed by the browser's release toggle after a
    // successful promote. When armed, teardown skips the temporary-tab
    // auto-close: the tab now belongs to a real workspace and the overlay
    // is tearing down without closing it.
    let mut release_armed = false;
    // Guard parity with the built-in backend's socket_path_pair_fits: an
    // external session whose socket path exceeds the OS limit can never
    // attach (connect() fails with a confusing ENAMETOOLONG/ENOENT), so
    // surface the real cause as a structured frame instead of letting the
    // browser retry forever. Without this the failure looks like a dead
    // daemon and the recovery UI keeps pumping reconnects.
    if !socket_path_fits(&path) {
        let payload = json!({
            "type": "herdr_error",
            "backend": backend.as_str(),
            "kind": "socket_path_too_long",
            "message": format!(
                "session socket path is too long for this OS: {} ({} bytes, limit {})",
                path.display(),
                std::ffi::OsStr::as_encoded_bytes(path.as_os_str()).len(),
                SOCKET_PATH_LIMIT
            ),
            "suggest_builtin": false,
        });
        if let Ok(text) = serde_json::to_string(&payload) {
            let _ = socket.send(Message::Text(text.into())).await;
        }
        return;
    }
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<TerminalEvent>();
    let (in_tx, in_rx) = std::sync::mpsc::channel::<ClientMessage>();

    std::thread::spawn(move || {
        let mut stream = match connect_terminal_attach(&path, &terminal_id, cols, rows) {
            Ok(stream) => stream,
            Err(error) => {
                // Order matters: the STRUCTURED error first, then the raw
                // text, through ONE channel. The browser treats any binary
                // frame as a live-backend signal (attach success) and only
                // herdr_error text re-arms its reconnect backoff, so the
                // structured frame must arrive first or every failed
                // reconnect resets the backoff and a resize drag rebuilds
                // a per-frame WebSocket storm. (With a separate error
                // channel, a closed out_rx could win the select race and
                // the browser would never see the JSON frame offering a
                // built-in session.)
                let _ = out_tx.send(TerminalEvent::Error(error.clone()));
                let _ = out_tx.send(TerminalEvent::Bytes(error.user_message().into_bytes()));
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
                        let text = text.as_str();
                        // Promote hand-off: the overlay armed this socket with
                        // a release toggle, so its cleanup must not auto-close
                        // the now-promoted tab. Consumed here, never forwarded.
                        if terminal_release_toggle(text, &mut release_armed) {
                            continue;
                        }
                        for message in terminal_text_messages(text) {
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
    let close_tab_id = query
        .temporary_tab_id
        .as_deref()
        .filter(|value| !value.is_empty());
    // A promote request for this tab can be in transit when the overlay
    // socket dies (the HTTP route arms the server-side guard only once the
    // request is parsed; a WS close is detected faster than the promote
    // POST can arrive). Closing now would kill the shell the user asked to
    // keep, so when the tab looks closable give an in-transit promote a
    // short grace window to arm its guard; if none shows up the temporary
    // tab closes exactly as before.
    const PROMOTE_GRACE: Duration = Duration::from_millis(250);
    if should_auto_close_temporary_tab(release_armed, close_tab_id, &promoted_temporary_tabs) {
        tokio::time::sleep(PROMOTE_GRACE).await;
        if should_auto_close_temporary_tab(release_armed, close_tab_id, &promoted_temporary_tabs) {
            if let Some(tab_id) = close_tab_id {
                let _ = api.request_value(
                    json!({ "id": "web:temp-terminal:close", "method": "tab.close", "params": { "tab_id": tab_id } }),
                );
            }
        }
    }
}

/// Teardown decision for the temporary tab served by a terminal socket:
/// auto-close unless the browser armed the release toggle (successful
/// promote, toggle frame delivered), a promote request is currently in
/// flight, or the promote route already marked the tab promoted
/// (toggle frame lost when the socket died mid-promote). A promoted or
/// promoting tab must never be closed here: in-flight protection closes
/// the pre-success race where the teardown auto-close used to kill the
/// shell before the backend answered, failing the promote with
/// "tab not found".
fn should_auto_close_temporary_tab(
    release_armed: bool,
    tab_id: Option<&str>,
    promoted_tabs: &PromotedTemporaryTabs,
) -> bool {
    if release_armed {
        return false;
    }
    match tab_id.map(str::trim).filter(|tab_id| !tab_id.is_empty()) {
        Some(tab_id) => !promoted_tabs
            .lock()
            .map(|promoted| promoted.contains_key(tab_id))
            .unwrap_or(false),
        None => false,
    }
}

/// Events from the graphics bridge reader thread: graphics payloads to relay
/// to the browser, or a fatal bridge error that ends the socket.
#[derive(Debug)]
enum TerminalGraphicsEvent {
    Message(String),
    Error(String),
}

/// WS wrapper for the external-backend graphics bridge.
async fn terminal_graphics_ws(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<TerminalGraphicsQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    log_event(
        &state.log_level(),
        &format!("websocket: terminal graphics bridge from {remote}"),
    );
    let client_socket_path = client_socket_for_query_session(
        &state,
        &headers,
        query.session.as_deref(),
        query.backend.as_deref(),
    );
    ws.on_upgrade(move |socket| terminal_graphics_socket(client_socket_path, query, socket))
}

/// Opens a ClientShell-mode connection to the external herdr daemon,
/// pins it to the requested tab, and relays each PaneSurface graphics scene
/// (plus the pane rects the browser needs to translate surface-relative
/// placements into pane-local coordinates) as JSON text frames.
///
/// herdr 0.9.0 rejects a bare `ClientShellHello`; shell clients must send
/// `EndpointControl { kind: "endpoint.hello.v1", data: <EndpointClientHello
/// JSON> }` first. The scene collection is armed by known cell metrics
/// (`collect_scene` gates on `cell_size.is_known()`), so the bridge always
/// sends real cell dimensions, never zero.
async fn terminal_graphics_socket(
    path: PathBuf,
    query: TerminalGraphicsQuery,
    mut socket: WebSocket,
) {
    // Clamp browser-provided geometry to herdr 0.9.0's client-shell limits
    // (client_transport.rs): the daemon closes the connection otherwise.
    const MAX_SHELL_DIMENSION: u16 = 4096;
    const MAX_SHELL_CELLS: u32 = 1_000_000;
    const MAX_CELL_PX: u32 = 4096;
    let cols = query.cols.unwrap_or(100).clamp(1, MAX_SHELL_DIMENSION);
    let rows = query.rows.unwrap_or(30).clamp(1, MAX_SHELL_DIMENSION);
    let cols = if u32::from(cols) * u32::from(rows) > MAX_SHELL_CELLS {
        (MAX_SHELL_CELLS / u32::from(rows)).min(u32::from(MAX_SHELL_DIMENSION)) as u16
    } else {
        cols
    };
    let cell_width_px = query.cell_width_px.unwrap_or(9).clamp(1, MAX_CELL_PX);
    let cell_height_px = query.cell_height_px.unwrap_or(17).clamp(1, MAX_CELL_PX);
    let tab_id = query.tab_id.clone();
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<TerminalGraphicsEvent>();
    let (in_tx, in_rx) = std::sync::mpsc::channel::<ClientMessage>();

    std::thread::spawn(move || {
        let mut stream =
            match connect_terminal_graphics_shell(&path, cols, rows, cell_width_px, cell_height_px)
            {
                Ok(stream) => stream,
                Err(error) => {
                    let _ = out_tx.send(TerminalGraphicsEvent::Error(error));
                    return;
                }
            };
        let Ok(mut writer) = stream.try_clone() else {
            let _ = out_tx.send(TerminalGraphicsEvent::Error(
                "failed to clone herdr client socket".into(),
            ));
            return;
        };
        let mut pin_writer = writer
            .try_clone()
            .expect("third clone of client socket must succeed");
        std::thread::spawn(move || {
            for message in in_rx {
                if write_message(&mut writer, &message).is_err() {
                    break;
                }
            }
        });

        // Read loop: forward every PaneSurface graphics payload to the
        // browser as one JSON frame. `PaneSurfacePatch` never carries
        // graphics (any scene change forces a full PaneSurface), so patches
        // can be dropped here without losing images. The first
        // EndpointControl after the welcome is the shell snapshot carrying
        // `boot_id`, which the tab pinning request needs. Unknown
        // EndpointControl kinds are ignored by contract (append-only enum).
        let mut boot_id: Option<String> = None;
        loop {
            match read_message::<_, ServerMessage>(&mut stream, MAX_GRAPHICS_FRAME_SIZE) {
                Ok(ServerMessage::EndpointControl { kind, data })
                    if kind == "shell.snapshot.v1" =>
                {
                    if boot_id.is_none() {
                        boot_id = serde_json::from_str::<serde_json::Value>(&data)
                            .ok()
                            .and_then(|snapshot| {
                                snapshot
                                    .get("boot_id")
                                    .and_then(|value| value.as_str())
                                    .map(str::to_owned)
                            });
                        if let Some(boot_id) = boot_id.as_deref().filter(|id| !id.is_empty()) {
                            if !tab_id.is_empty() {
                                let pin = serde_json::json!({
                                    "id": "web:graphics-bridge:tab-focus",
                                    "method": "tab.focus",
                                    "params": { "tab_id": tab_id },
                                });
                                if write_message(
                                    &mut pin_writer,
                                    &ClientMessage::ClientShellEndpointRequest {
                                        boot_id: boot_id.to_string(),
                                        request: pin.to_string(),
                                    },
                                )
                                .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    }
                }
                Ok(ServerMessage::PaneSurface(frame)) => {
                    let payload = graphics_bridge_payload(&frame);
                    match serde_json::to_string(&payload) {
                        Ok(text) => {
                            if out_tx.send(TerminalGraphicsEvent::Message(text)).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
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
                    Some(TerminalGraphicsEvent::Error(error)) => {
                        let payload = json!({
                            "type": "graphics_bridge_error",
                            "message": error,
                        });
                        if let Ok(text) = serde_json::to_string(&payload) {
                            let _ = socket.send(Message::Text(text.into())).await;
                        }
                        break;
                    }
                    Some(TerminalGraphicsEvent::Message(text)) => {
                        if socket.send(Message::Text(text.into())).await.is_err() { break; }
                    }
                    None => break,
                }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        for message in terminal_graphics_text_messages(&text, &query) {
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

    // The browser WS is gone, but the reader thread above may be blocked in
    // read_message on a healthy, idle daemon connection — shell clients get
    // no heartbeat frames, so nothing would ever unblock it. That would
    // leave a zombie shell client on the daemon side holding the pinned
    // tab's geometry (headless.rs `tab_geometry_controllers`). herdr 0.9.0
    // processes ClientMessage::Detach as a graceful disconnect: it removes
    // the client (restoring tab geometry via remove_client_and_resize_if_
    // needed) and closes its stream, which unblocks the reader with EOF.
    // The writer thread delivers Detach and then exits when `in_tx` drops.
    let _ = in_tx.send(ClientMessage::Detach);
}

/// JSON payload relayed to the browser for one PaneSurface. Only the fields
/// the browser renderer needs: surface dimensions, pane rects (so it can
/// translate surface-relative placements into the attach pane's local grid),
/// new assets (base64), retained asset keys, and placements.
#[derive(serde::Serialize)]
struct GraphicsBridgePayload<'a> {
    #[serde(rename = "type")]
    kind: &'a str,
    surface_revision: u64,
    cols: u16,
    rows: u16,
    panes: Vec<GraphicsBridgePane>,
    assets: Vec<GraphicsBridgeAsset<'a>>,
    placements: Vec<&'a SurfaceGraphicsPlacement>,
    retained_assets: &'a [SurfaceGraphicsAssetKey],
}

#[derive(serde::Serialize)]
struct GraphicsBridgePane {
    pane_id: String,
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    inner_x: u16,
    inner_y: u16,
    inner_width: u16,
    inner_height: u16,
    focused: bool,
    scrollback_offset: u32,
}

#[derive(serde::Serialize)]
struct GraphicsBridgeAsset<'a> {
    key: &'a SurfaceGraphicsAssetKey,
    /// Base64-encoded RGBA/PNG bytes. The browser decodes with `fetch`-free
    /// `Uint8Array.fromBase64`-style parsing and `createImageBitmap`.
    data: String,
}

fn graphics_bridge_payload(frame: &PaneSurfaceFrame) -> GraphicsBridgePayload<'_> {
    let panes = frame
        .panes
        .iter()
        .map(|pane| GraphicsBridgePane {
            pane_id: pane.pane_id.clone(),
            x: pane.rect.x,
            y: pane.rect.y,
            width: pane.rect.width,
            height: pane.rect.height,
            inner_x: pane.inner_rect.x,
            inner_y: pane.inner_rect.y,
            inner_width: pane.inner_rect.width,
            inner_height: pane.inner_rect.height,
            focused: pane.focused,
            scrollback_offset: pane
                .scroll
                .as_ref()
                .map(|scroll| scroll.offset_from_bottom as u32)
                .unwrap_or(0),
        })
        .collect();
    let assets = frame
        .graphics
        .assets
        .iter()
        .map(|asset| GraphicsBridgeAsset {
            key: &asset.key,
            data: base64_encode(&asset.data),
        })
        .collect();
    GraphicsBridgePayload {
        kind: "graphics_scene",
        surface_revision: frame.surface_revision,
        cols: frame.frame.width,
        rows: frame.frame.height,
        panes,
        assets,
        placements: frame.graphics.placements.iter().collect(),
        retained_assets: &frame.graphics.retained_assets,
    }
}

/// Minimal standard base64 encoder (no external crate): the webui keeps its
/// dependency footprint tiny, and asset uploads are the only consumer.
fn base64_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// Maps browser text messages on the graphics WS to upstream ClientShell
/// messages. The browser only needs `resize` (keep the shell surface in
/// sync with the attach grid) and focus/blur.
fn terminal_graphics_text_messages(
    text: &str,
    query: &TerminalGraphicsQuery,
) -> Vec<ClientMessage> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    match value.get("type").and_then(|value| value.as_str()) {
        Some("resize") => {
            // Clamp to herdr 0.9.0's client-shell geometry limits
            // (client_transport.rs): anything beyond these makes the
            // daemon drop the connection, not just ignore the resize.
            const MAX_SHELL_DIMENSION: u64 = 4096;
            const MAX_SHELL_CELLS: u64 = 1_000_000;
            const MAX_CELL_PX: u64 = 4096;
            let cols = value
                .get("cols")
                .and_then(|value| value.as_u64())
                .unwrap_or(cols_of(query))
                .clamp(1, MAX_SHELL_DIMENSION) as u16;
            let rows = value
                .get("rows")
                .and_then(|value| value.as_u64())
                .unwrap_or(rows_of(query))
                .clamp(1, MAX_SHELL_DIMENSION) as u16;
            let cols = if u64::from(cols) * u64::from(rows) > MAX_SHELL_CELLS {
                ((MAX_SHELL_CELLS / u64::from(rows)).min(MAX_SHELL_DIMENSION)) as u16
            } else {
                cols
            };
            let cell_width_px = value
                .get("cell_width_px")
                .and_then(|value| value.as_u64())
                .unwrap_or(query.cell_width_px.unwrap_or(9).max(1) as u64)
                .clamp(1, MAX_CELL_PX) as u32;
            let cell_height_px = value
                .get("cell_height_px")
                .and_then(|value| value.as_u64())
                .unwrap_or(query.cell_height_px.unwrap_or(17).max(1) as u64)
                .clamp(1, MAX_CELL_PX) as u32;
            vec![ClientMessage::ClientShellResize {
                cell_width_px,
                cell_height_px,
                surface_size: ClientSurfaceSize { cols, rows },
                pixel_mouse: false,
            }]
        }
        Some("focus") => vec![ClientMessage::ClientShellFocus {
            focused: value
                .get("focused")
                .and_then(|value| value.as_bool())
                .unwrap_or(true),
        }],
        _ => Vec::new(),
    }
}

fn cols_of(query: &TerminalGraphicsQuery) -> u64 {
    query.cols.unwrap_or(100).max(1) as u64
}

fn rows_of(query: &TerminalGraphicsQuery) -> u64 {
    query.rows.unwrap_or(30).max(1) as u64
}

/// Opens a ClientShell-mode connection to the herdr daemon and pins it to
/// the terminal's tab. Mirrors herdr 0.9.0's handshake contract:
/// `endpoint.hello.v1` welcome, then `tab.focus` scoped to this connection.
fn connect_terminal_graphics_shell(
    path: &Path,
    cols: u16,
    rows: u16,
    cell_width_px: u32,
    cell_height_px: u32,
) -> Result<LocalStream, String> {
    let mut stream = connect_local_stream(path).map_err(|err| format!("connect failed: {err}"))?;
    let hello = serde_json::json!({
        "generation": 1,
        "cell_width_px": cell_width_px,
        "cell_height_px": cell_height_px,
        "surface_size": { "cols": cols, "rows": rows },
        "pixel_mouse": false,
        "direct_graphics": false,
        "endpoint_keybindings": false,
        "mouse_capture": false,
        "surface_active": true,
        "snapshot_codecs": ["shell.snapshot.v1"],
        "surface_codecs": ["shell.surface.v1"],
        "input_codecs": ["shell.input.semantic.v1"],
        "blob_codecs": ["shell.blob.v1"],
    });
    write_message(
        &mut stream,
        &ClientMessage::EndpointControl {
            kind: "endpoint.hello.v1".into(),
            data: hello.to_string(),
        },
    )
    .map_err(|err| format!("send hello failed: {err}"))?;

    match read_message::<_, ServerMessage>(&mut stream, MAX_FRAME_SIZE) {
        Ok(ServerMessage::EndpointControl { kind, data }) if kind == "endpoint.welcome.v1" => {
            // Any rejection arrives as an EndpointHandshakeError JSON in a
            // generic `EndpointControl` or a Welcome error; surface both.
            if let Ok(welcome) = serde_json::from_str::<serde_json::Value>(&data) {
                if let Some(error) = welcome.get("error") {
                    let code = error
                        .get("code")
                        .and_then(|value| value.as_str())
                        .unwrap_or("unknown");
                    let message = error
                        .get("message")
                        .and_then(|value| value.as_str())
                        .unwrap_or("backend rejected the graphics bridge");
                    return Err(format!("{code}: {message}"));
                }
            }
        }
        Ok(ServerMessage::Welcome {
            error: Some(error), ..
        }) => {
            return Err(error);
        }
        Ok(_) => return Err("unexpected handshake response".into()),
        Err(err) => return Err(format!("read welcome failed: {err}")),
    }
    Ok(stream)
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

/// Release toggle for temporary terminal WebSockets. After a successful
/// promote the overlay sends `{"type":"release","enabled":true}` so this
/// socket's cleanup skips the `temporary_tab_id` auto-close: the promoted
/// tab must survive the overlay teardown. Returns true when the message is
/// a release toggle (consumed here, never forwarded as terminal input).
fn terminal_release_toggle(text: &str, armed: &mut bool) -> bool {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return false;
    };
    if value.get("type").and_then(|value| value.as_str()) != Some("release") {
        return false;
    }
    *armed = value
        .get("enabled")
        .and_then(|value| value.as_bool())
        .unwrap_or(false);
    true
}

/// Events from the terminal reader thread to the WS select loop, through one
/// ordered channel. Ordering is load-bearing: the STRUCTURED error must be
/// delivered before the raw failure text, because the browser treats any
/// binary frame as a live-backend signal (attach success) and only the
/// `herdr_error` JSON re-arms its reconnect backoff; raw text first would
/// reset the backoff on every failed attempt (see terminal.js ws.onmessage).
enum TerminalEvent {
    Bytes(Vec<u8>),
    Error(TerminalAttachError),
}

#[derive(Clone)]
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
mod tests;

#[cfg(test)]
mod tui_parity_e2e_tests;

#[cfg(test)]
mod graphics_bridge_tests;
