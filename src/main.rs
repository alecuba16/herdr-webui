use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use axum::extract::{ConnectInfo, State};
#[cfg(test)]
use axum::http::header;
use axum::http::HeaderMap;
use axum::http::HeaderValue;
#[cfg(test)]
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use axum_server::tls_rustls::RustlsConfig;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::auth::{AuthConfig, LoginRateLimiter};
#[cfg(test)]
use crate::builtin_detection::JcodeDetectionVariant;
use herdr_webui::HERDR_WEBUI_VERSION;
use server_settings::{
    apply_cli_overrides, load_runtime_server_settings, log_event, save_runtime_server_settings,
    server_settings_path, BackendMode, LogLevel, RuntimeServerSettings,
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
mod chat_lens;
mod compat;
mod file_browser;
mod git_bin;
mod git_ui;
mod jcode_transcript;
mod local_socket;
mod lsp;
mod notes;
mod password_hashing;
mod protocol;
mod route_helpers;
pub(crate) mod routes;

// Flat re-exports: pre-split modules (git_ui, lsp, notes, builtin_backend,
// file_browser) and the inline test modules keep their crate-root paths.
#[allow(unused_imports)]
pub(crate) use crate::auth::DEFAULT_SESSION_EXPIRATION_MINUTES;
#[allow(unused_imports)]
pub(crate) use crate::compat::SimpleVersion;
#[allow(unused_imports)]
pub(crate) use crate::protocol::PROTOCOL_VERSION;
#[allow(unused_imports)]
pub(crate) use crate::protocol::{
    read_message, write_message, AttachScrollDirection, AttachScrollSource, ClientMessage,
    RenderEncoding, ServerMessage, MAX_TESTED_BACKEND_VERSION, MIN_BACKEND_VERSION,
};
#[allow(unused_imports)]
pub(crate) use crate::protocol::{
    ClientSurfaceSize, FrameData, PaneSurfaceFrame, PaneSurfacePane, PaneSurfaceScrollMetrics,
    SurfaceGraphicsAsset, SurfaceGraphicsAssetKey, SurfaceGraphicsFormat, SurfaceGraphicsPlacement,
    SurfaceGraphicsScene, SurfaceGraphicsSource, SurfaceGraphicsTarget, SurfaceRect,
};
#[allow(unused_imports)]
pub(crate) use herdr_webui::socket_paths::{socket_path_fits, SOCKET_PATH_LIMIT};
#[allow(unused_imports)]
pub(crate) use routes::auth::{authorized, login, logout, me, persist_session_token, require_auth};
#[allow(unused_imports)]
pub(crate) use routes::panes::{
    conversation_error, promote_join_failure, submit_pane_code, submit_pane_error,
};
#[allow(unused_imports)]
pub(crate) use routes::session::{
    backend_compatibility_for_supported_range, config_dir, detect_herdr_install,
    ensure_builtin_session, request_session_name, requested_session_from_headers, HerdrInstall,
};
#[allow(unused_imports)]
pub(crate) use routes::settings::{
    agents_working_from_value, apply_no_sleep_mode, default_working_folder,
    default_working_folder_without_prompt, no_sleep_ms, persist_server_settings,
    sync_auto_no_sleep,
};
#[allow(unused_imports)]
pub(crate) use routes::shared::{
    agents, cleanup_sessions, clear_recent_workspaces, close_pane, close_session, close_tab,
    close_workspace, create_tab, create_workspace, create_worktree, events_ws, git_branches,
    launch_session, no_sleep, open_recent_workspace, open_worktree, pane_conversation,
    pane_conversation_image, pane_layout, pane_prompt, pane_tool_output, panes, promote_tab,
    recent_workspaces, record_recent_workspace_endpoint, remove_recent_workspace, remove_worktree,
    remove_worktree_path, rename_tab, rename_workspace, server_settings, session_snapshot,
    sessions, set_workspace_order, submit_pane, tabs, terminal_graphics_ws, terminal_ws,
    update_no_sleep, update_server_settings, versions, workspace_order, workspaces, worktrees,
};
#[allow(unused_imports)]
pub(crate) use routes::workspace::{
    enrich_session_snapshot, enrich_workspace_cwds, existing_workspace_cwd, expand_path_prefix,
    expand_user_path_string, filter_snapshot_rows_by_workspace, list_git_branches,
    push_recent_workspace, record_recent_workspace, snapshot_counts_by_workspace, unix_now_seconds,
    workspace_order_key, MAX_RECENT_WORKSPACES,
};
#[allow(unused_imports)]
pub(crate) use routes::worktree::{
    days_from_civil, enrich_worktree_activity, git_failure, is_leap_year,
    normalize_worktree_response, open_created_worktree_request, parse_worktree_activity_timestamp,
    path_basename, pull_base_branch, register_worktree_list_cache, same_checkout_path,
    worktree_activity_display, worktree_activity_sort_key, worktree_cache_invalidated,
    CreateWorktreeRequest,
};
#[allow(unused_imports)]
pub(crate) use routes::ws::{
    base64_encode, graphics_bridge_payload, should_auto_close_temporary_tab,
    terminal_graphics_text_messages, terminal_release_toggle, terminal_text_messages,
    web_event_kind, GraphicsBridgePayload, TerminalGraphicsQuery,
};
mod server_settings;
mod service;
mod terminal_hub;
mod terminal_text;
mod workspace_panes_store;

use assets::{
    app_boot_js, app_html, desktop_css, desktop_directory_picker_css, desktop_directory_picker_js,
    desktop_file_browser_css, desktop_file_browser_js, desktop_git_ui_css, desktop_git_ui_js,
    desktop_js, desktop_modal_drag_js, desktop_notes_css, desktop_notes_js, desktop_search_css,
    desktop_search_js, desktop_shortcuts_css, desktop_tour_css, favicon_attention_svg,
    favicon_error_svg, favicon_svg, icon_chevron_down_svg, icon_chevron_right_svg, icon_clock_svg,
    icon_columns_svg, icon_copy_svg, icon_eye_off_svg, icon_eye_svg, icon_file_svg,
    icon_folder_svg, icon_folder_up_svg, icon_git_svg, icon_help_svg, icon_link_svg,
    icon_lock_open_svg, icon_lock_svg, icon_pencil_svg, icon_refresh_svg, icon_save_svg,
    icon_search_svg, icon_settings_svg, icon_terminal_svg, icon_theme_auto_svg, icon_trash_svg,
    icon_worktree_svg, icon_x_svg, jetbrains_mono_nerd_font, login_css, login_html, login_js,
    mobile_actions_js, mobile_attention_js, mobile_backend_js, mobile_composer_js, mobile_core_js,
    mobile_css, mobile_directory_picker_js, mobile_events_js, mobile_file_browser_js,
    mobile_git_js, mobile_js, mobile_lens_js, mobile_notes_js, mobile_panels_js, mobile_screens_js,
    mobile_search_js, mobile_sessions_js, mobile_settings_js, mobile_terminal_js, mobile_theme_js,
    mobile_tour_css, mobile_tour_js, mobile_tour_steps_js, mobile_workmeta_js, mobile_worktrees_js,
    shared_actions_js, shared_alert_card_css, shared_alert_card_js, shared_attention_js,
    shared_backend_state_js, shared_colors_css, shared_content_search_css, shared_core_js,
    shared_editor_js, shared_file_content_search_js, shared_file_icons_css, shared_file_icons_js,
    shared_file_tree_css, shared_file_tree_js, shared_graphics_bridge_js, shared_http_js,
    shared_line_context_js, shared_lsp_js, shared_markdown_preview_css, shared_markdown_preview_js,
    shared_options_js, shared_palette_css, shared_primitives_css, shared_prompt_cards_js,
    shared_settings_confirm_js, shared_settings_feedback_js, shared_skeleton_css,
    shared_skeleton_js, shared_terminal_adapter_js, shared_terminal_fit_js,
    shared_terminal_input_js, shared_terminal_scroll_js, shared_tokens_css,
    shared_tour_driver_js,
    shared_workspace_search_js, vendor_codemirror_js, vendor_dompurify_js, vendor_ghostty_wasm,
    vendor_marked_js, vendor_mermaid_js, vendor_wterm_css, vendor_wterm_js,
};
use compat::BackendCompatibility;
#[cfg(test)]
use interprocess::TryClone as _;

const DEFAULT_BIND: &str = "127.0.0.1:8787";
const INSTALL_LABEL: &str = "herdr-web";
pub(crate) const MAX_FRAME_SIZE: usize = 2 * 1024 * 1024;
pub(crate) const MAX_GRAPHICS_FRAME_SIZE: usize = 32 * 1024 * 1024;
pub(crate) const MIN_SUPPORTED_PROTOCOL_VERSION: u32 = 22;

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

pub(crate) type PromotedTemporaryTabs = Arc<Mutex<HashMap<String, PromotedTemporaryTabState>>>;

/// Marks a tab as having another in-flight promote request. Never
/// downgrades a tab that is already promoted.
pub(crate) fn begin_temporary_tab_promote(registry: &PromotedTemporaryTabs, tab_id: &str) {
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
pub(crate) fn finish_temporary_tab_promote(
    registry: &PromotedTemporaryTabs,
    tab_id: &str,
    promoted: bool,
) {
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

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct BackendInfo {
    version: Option<String>,
    protocol: Option<u32>,
}

/// `detect_herdr_install` behind a 60s WebState cache: /api/sessions is
/// polled frequently and the spawn is pure overhead once the answer is
/// known. A fresh install/upgrade flips the answer, so the entry expires
/// rather than living forever. Blocking (process spawn on miss); call
/// from a blocking context.
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
pub(crate) enum SessionBackendTarget {
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
    /// HTTP on the configured bind port plus HTTPS on the next port
    /// (bind port + 1). One TCP port cannot speak both protocols, so
    /// the dual mode needs a second listener.
    Both,
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

pub(crate) struct NoSleepState {
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

pub(crate) fn unix_ms_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(crate) fn start_no_sleep_guard() -> io::Result<NoSleepGuard> {
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
        "both" | "http-https" | "http+https" => Ok(TlsMode::Both),
        other => Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("invalid --https mode: {other}; use off, auto, self-signed, files, or both"),
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
            TlsMode::Both => "both",
        }
    }

    /// Primary scheme for the configured bind port. `both` serves HTTP on
    /// the configured port and HTTPS on port+1, so the primary is http.
    pub fn scheme(self) -> &'static str {
        match self {
            TlsMode::Off | TlsMode::Both => "http",
            TlsMode::Auto | TlsMode::SelfSigned | TlsMode::Files => "https",
        }
    }

    /// Secondary HTTPS bind when the mode needs a second port (`both`);
    /// None for single-protocol modes. Saturates so a bind on the last
    /// possible port cannot overflow.
    pub fn https_bind(self, bind: SocketAddr) -> Option<SocketAddr> {
        match self {
            TlsMode::Both => Some(SocketAddr::new(bind.ip(), bind.port().saturating_add(1))),
            _ => None,
        }
    }

    pub fn uses_tls(self) -> bool {
        !matches!(self, TlsMode::Off)
    }

    /// Whether the login cookie may carry the `Secure` flag. Only for
    /// HTTPS-only modes: in `both` mode the same host also serves plain
    /// HTTP, and a Secure cookie would make login impossible over the
    /// HTTP port.
    pub fn cookie_secure(self) -> bool {
        matches!(self, TlsMode::Auto | TlsMode::SelfSigned | TlsMode::Files)
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
    herdr_webui::socket_paths::home_dir()
}

fn print_help() {
    eprint!("{}", help_text());
}

fn help_text() -> &'static str {
    "herdr-webui [--verbose] [--bind HOST:PORT] [--https off|auto|self-signed|files|both] [--tls-cert PATH --tls-key PATH] [--session NAME] [--api-socket PATH] [--client-socket PATH] [--backend-mode <external-herdr|builtin|auto>]\n\
herdr-webui --version\n\
herdr-webui install-mac [--verbose] [--bind HOST:PORT] [--https off|auto|self-signed|files|both] [--tls-cert PATH --tls-key PATH] [--session NAME]\n\
herdr-webui update-mac [--verbose]\n\
herdr-webui install-linux [--verbose] [--bind HOST:PORT] [--https off|auto|self-signed|files|both] [--tls-cert PATH --tls-key PATH] [--session NAME]\n\
herdr-webui update-linux [--verbose]\n\
herdr-webui start-mac | start [--verbose]\n\
herdr-webui stop-mac | stop [--verbose]\n\
herdr-webui restart-mac | restart [--verbose]\n\
herdr-webui start-linux | start [--verbose]\n\
herdr-webui stop-linux | stop [--verbose]\n\
herdr-webui restart-linux | restart [--verbose]\n\
herdr-webui uninstall-mac [--verbose]\n\
herdr-webui uninstall-linux [--verbose]\n\
herdr-webui set-password [--user NAME] [--password VALUE | --stdin] [--clear] [--verbose]\n\
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
    /// 60s cache of `herdr --version` (Task P7: /api/sessions spawned
    /// the binary on every call). Bounded by Instant because an install
    /// or upgrade changes the answer.
    herdr_install_cache: Arc<Mutex<Option<(std::time::Instant, HerdrInstall)>>>,
    auth: Arc<Mutex<AuthConfig>>,
    /// Worktree.list results keyed by cwd, short TTL: consecutive
    /// panel-switch snapshots re-ask the same checkouts.
    worktree_list_cache: Arc<WorktreeListCache>,
    /// Per-IP failed-login throttle backing the /api/login guard.
    login_limiter: Arc<LoginRateLimiter>,
    server_settings: Arc<Mutex<RuntimeServerSettings>>,
    no_sleep: Arc<Mutex<NoSleepState>>,
    rebind_tx: tokio::sync::watch::Sender<ListenEndpoint>,
    /// Broadcasts the public settings JSON to every connected events socket
    /// after a settings change, so open tabs re-sync backend enablement
    /// without a page reload.
    settings_tx: tokio::sync::broadcast::Sender<serde_json::Value>,
    /// Server-wide note entries. Loaded from the notes.json sidecar at
    /// boot; every mutation persists back and fans out a full snapshot to
    /// connected events sockets.
    notes: Arc<Mutex<notes::NotesState>>,
    /// Broadcasts the full notes snapshot after every notes mutation so
    /// every connected tab converges without polling.
    notes_tx: tokio::sync::broadcast::Sender<serde_json::Value>,
    /// Shared panel/group state per herdr session
    /// (workspace_panes_store.rs): every mutation persists a
    /// per-session sidecar and fans the new entry out here so every
    /// connected client of that session converges on one truth.
    panes_store: Arc<workspace_panes_store::PanesStore>,
    workspace_orders: Arc<Mutex<HashMap<String, Vec<String>>>>,
    lsp: Arc<lsp::LspRegistry>,
    /// Shared terminal attach hub: one backend attach per
    /// `(client socket, terminal_id)`, fanned out to every connected
    /// viewer (Phase 5 transport work, see docs/ux/phase5-transport-design.md).
    terminal_hub: Arc<terminal_hub::TerminalHub>,
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
pub(crate) struct ApiClient {
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
        let ack: serde_json::Value = read_json_line(&mut reader).map_err(|err| err.to_string())?;
        // A rejected subscribe answers with an error frame and closes the
        // stream; treating it as a healthy ack left the events loop cycling
        // subscribe -> EOF -> resubscribe with zero events and no log of why
        // (observed live against herdr 0.9.5 with an invalid subscription).
        if let Some(error) = ack.get("error") {
            return Err(format!(
                "events.subscribe rejected: {}",
                error
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("unknown")
            ));
        }
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

pub(crate) fn home_folder_path() -> PathBuf {
    home_dir().unwrap_or_else(|_| PathBuf::from("~"))
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
    if matches!(args.first().map(String::as_str), Some("set-password")) {
        // Subcommand token consumed; --verbose already stripped above.
        args.remove(0);
        let mut user = None;
        let mut password = None;
        let mut clear = false;
        let mut stdin = false;
        let mut index = 0;
        while index < args.len() {
            match args[index].as_str() {
                "--user" => {
                    let value = args.get(index + 1).ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "set-password: --user needs a value",
                        )
                    })?;
                    user = Some(value.clone());
                    index += 2;
                }
                "--password" => {
                    let value = args.get(index + 1).ok_or_else(|| {
                        io::Error::new(
                            io::ErrorKind::InvalidInput,
                            "set-password: --password needs a value",
                        )
                    })?;
                    password = Some(value.clone());
                    index += 2;
                }
                "--clear" => {
                    clear = true;
                    index += 1;
                }
                "--stdin" => {
                    stdin = true;
                    index += 1;
                }
                other => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("set-password: unexpected argument: {other}"),
                    ));
                }
            }
        }
        if clear && (stdin || password.is_some()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "set-password: --clear cannot be combined with --stdin or --password",
            ));
        }
        if stdin && password.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "set-password: --stdin and --password are mutually exclusive",
            ));
        }
        if stdin {
            let mut line = String::new();
            std::io::stdin().read_line(&mut line)?;
            password = Some(line);
        }
        return server_settings::set_password_command(user, password, clear);
    }
    let config = WebConfig::parse(&args)?;
    let mut server_settings = load_runtime_server_settings(config.bind)?;
    apply_cli_overrides(&mut server_settings, &config);
    if let Some(backend_mode) = config.backend_mode {
        server_settings.backend_mode = backend_mode;
    }
    let mut auth_config = AuthConfig::from_settings(&server_settings)?;
    // Sessions survive the restart: restore the persisted session set
    // (records still valid) so open windows keep their cookies instead of
    // bouncing to the login page on every WebUI restart. The loader drops
    // lapsed records, so a timed token is never resurrected past its
    // expiry, and it understands every sidecar format ever written
    // (multi-session array, older single-record JSON, legacy raw token).
    if let Some(record) = crate::server_settings::load_persisted_session_token() {
        auth_config.restore_sessions(
            record
                .sessions
                .into_iter()
                .map(|session| crate::auth::SessionRecord {
                    expires_at: session.to_system_time(),
                    token: session.token,
                })
                .collect(),
        );
    }
    let auth = Arc::new(Mutex::new(auth_config));
    let worktree_list_cache = Arc::new(WorktreeListCache::default());
    // The socket transport (TUI git panels via the builtin backend) can
    // switch branches without a WebState; the registry lets those
    // switches drop this server's cache entry too.
    register_worktree_list_cache(worktree_list_cache.clone());
    let backend_mode = resolve_backend_mode(
        server_settings.backend_mode,
        config.session.as_deref(),
        config.api_socket.as_deref(),
    );
    let builtin_sessions: BuiltinSessionRegistry = Arc::new(Mutex::new(HashMap::new()));
    let builtin_start_lock: Arc<Mutex<()>> = Arc::new(Mutex::new(()));
    let (api_socket, client_socket) = if backend_mode.is_builtin() {
        let (_api_socket, _client_socket) = builtin_socket_paths(config.session.as_deref());
        let journal_dir = Some(builtin_session_dir(config.session.as_deref()));
        let handle = Arc::new(builtin_backend::BuiltinBackendHandle::start(
            builtin_backend::BuiltinBackendConfig {
                api_socket: _api_socket,
                client_socket: _client_socket,
                cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
                shell: server_settings.builtin_shell.clone(),
                jcode_detection_variant: server_settings.jcode_detection_variant,
                journal_dir,
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
    let notes = Arc::new(Mutex::new(notes::load_notes()));
    let (notes_tx, _) = tokio::sync::broadcast::channel(16);
    let panes_store = workspace_panes_store::PanesStore::new();
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
        herdr_install_cache: Arc::new(Mutex::new(None)),
        auth,
        worktree_list_cache,
        login_limiter: Arc::new(LoginRateLimiter::new()),
        server_settings,
        no_sleep: Arc::new(Mutex::new(NoSleepState::default())),
        rebind_tx,
        settings_tx,
        notes,
        notes_tx,
        panes_store,
        workspace_orders: Arc::new(Mutex::new(HashMap::new())),
        lsp: lsp_registry,
        terminal_hub: Arc::new(terminal_hub::TerminalHub::new()),
    };

    // fzf detection runs after the server is up so no request pays the spawn
    // cost and a slow PATH cannot delay the listener. Until it lands, path
    // search falls back to the built-in collect-then-rank ordering.
    tokio::spawn(async move {
        let available = tokio::task::spawn_blocking(file_browser::probe_fzf)
            .await
            .unwrap_or(false);
        if available {
            eprintln!("fzf detected: path search uses fzf ranking");
        }
    });

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

// Socket-path derivation lives in herdr_webui::socket_paths (shared with
// BackendClient so server and client compute byte-identical paths). Local
// wrappers keep the settings-dir injection server-side and the names the
// tests use.
use herdr_webui::local_socket::{connect_local_stream, LocalStream};
use herdr_webui::socket_paths::{
    builtin_session_dir as builtin_session_dir_in, builtin_socket_paths_in,
};

pub(crate) fn builtin_socket_paths(session: Option<&str>) -> (PathBuf, PathBuf) {
    // Server side resolves its settings dir; the client side resolves
    // the runtime settings path with its test isolation.
    builtin_socket_paths_in(
        &herdr_webui::socket_paths::settings_dir_fallback(&server_settings_path()),
        session,
    )
}

/// Canonical session directory for plain files (journal), independent of
/// the socket fallback: long settings paths push the sockets to the short
/// hashed /tmp dir, but the journal must stay beside webui-settings.json so
/// close and cleanup find it.
pub(crate) fn builtin_session_dir(session: Option<&str>) -> PathBuf {
    builtin_session_dir_in(
        &herdr_webui::socket_paths::settings_dir_fallback(&server_settings_path()),
        session,
    )
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
        // In `both` mode the configured port serves HTTP and port+1 serves
        // HTTPS (one TCP port cannot speak both protocols).
        let primary_tls = if tls.mode == TlsMode::Both {
            TlsConfig {
                mode: TlsMode::Off,
                ..tls.clone()
            }
        } else {
            tls.clone()
        };
        let secondary_bind = tls.mode.https_bind(bind);
        let secondary_tls = if secondary_bind.is_some() {
            Some(TlsConfig {
                mode: TlsMode::Auto,
                ..tls.clone()
            })
        } else {
            None
        };
        let primary_tls_config = primary_tls.rustls_config().await?;
        // Must derive from secondary_tls (mode Auto), NOT from tls (mode Both):
        // rustls_config() for Both returns None and the HTTPS port would end up
        // serving plain HTTP (TLS clients would hang on the handshake).
        let secondary_tls_config = if let Some(secondary) = secondary_tls.as_ref() {
            secondary.rustls_config().await?
        } else {
            None
        };
        let mut shutdown_rx = rebind_rx.clone();
        // Each listener runs as its own spawned task: awaiting them
        // sequentially would starve the second listener (the first future
        // never completes, so the TLS accept loop would never be polled and
        // handshakes would hang). A completion channel reports the first
        // listener that stops so the loop can rebuild both.
        let (done_tx, mut done_rx) = tokio::sync::mpsc::channel::<io::Error>(4);
        let mut bind_descriptions: Vec<String> = Vec::new();
        if let Err(err) = bind_listener(
            bind,
            primary_tls_config,
            &state,
            &mut shutdown_rx,
            done_tx.clone(),
        )
        .await
        {
            eprintln!("failed to bind {}://{bind}: {err}", tls.scheme());
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
            continue;
        }
        bind_descriptions.push(format!("{}://{bind}", tls.scheme()));
        if let Some(secondary) = secondary_bind {
            if let Err(err) = bind_listener(
                secondary,
                secondary_tls_config,
                &state,
                &mut shutdown_rx,
                done_tx.clone(),
            )
            .await
            {
                eprintln!("failed to bind https://{secondary}: {err}");
                tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
                continue;
            }
            bind_descriptions.push(format!("https://{secondary}"));
        }
        eprintln!("herdr-webui listening on {}", bind_descriptions.join(" + "));
        drop(done_tx);
        tokio::pin!(shutdown_rx);
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
            _ = shutdown_rx.changed() => {}
            res = done_rx.recv() => {
                // A listener stopped (fatal accept loop error). Log it; the
                // loop continues so the remaining listener keeps serving
                // until a rebind or signal.
                if let Some(err) = res {
                    eprintln!("listener stopped: {err}");
                }
                continue;
            }
        }
        // Rebind requested (or a listener died): the next loop iteration
        // rebuilds both listeners with the fresh endpoint.
    }
}

/// Binds one listener (HTTP or HTTPS) and spawns its serving task. The task
/// reports a fatal error on `done_tx` so `serve_rebindable` can rebuild the
/// listeners; graceful shutdown comes from the shared rebind watch channel.
async fn bind_listener(
    bind: SocketAddr,
    tls_config: Option<RustlsConfig>,
    state: &WebState,
    shutdown_rx: &mut tokio::sync::watch::Receiver<ListenEndpoint>,
    done_tx: tokio::sync::mpsc::Sender<io::Error>,
) -> io::Result<()> {
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let mut shutdown_rx = shutdown_rx.clone();
    let router = app_router(state.clone()).into_make_service_with_connect_info::<SocketAddr>();
    match tls_config {
        Some(tls_config) => {
            let handle = axum_server::Handle::new();
            let shutdown_handle = handle.clone();
            tokio::spawn(async move {
                let _ = shutdown_rx.changed().await;
                shutdown_handle.graceful_shutdown(None);
            });
            let server = axum_server::from_tcp_rustls(listener.into_std()?, tls_config)
                .map_err(|err| io::Error::other(err.to_string()))?
                .handle(handle)
                .serve(router);
            tokio::spawn(async move {
                if let Err(err) = server.await {
                    let _ = done_tx.send(io::Error::other(err.to_string())).await;
                }
            });
        }
        None => {
            let server = axum::serve(listener, router).with_graceful_shutdown(async move {
                let _ = shutdown_rx.changed().await;
            });
            tokio::spawn(async move {
                if let Err(err) = server.await {
                    let _ = done_tx.send(io::Error::other(err)).await;
                }
            });
        }
    }
    Ok(())
}

impl TlsConfig {
    fn scheme(&self) -> &'static str {
        self.mode.scheme()
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
            TlsMode::Both => Ok(None),
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
        .route("/api/session/cleanup", post(cleanup_sessions))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
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
        .merge(notes::routes())
        .merge(workspace_panes_store::routes())
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
        .route("/api/panes/{pane_id}/submit", post(submit_pane))
        .route("/api/panes/{pane_id}/conversation", get(pane_conversation))
        .route(
            "/api/panes/{pane_id}/conversation/image",
            get(pane_conversation_image),
        )
        .route("/api/panes/{pane_id}/prompt", get(pane_prompt))
        .route("/api/panes/{pane_id}/tool-output", get(pane_tool_output))
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
        .route("/assets/desktop/notes.css", get(desktop_notes_css))
        .route("/assets/desktop/shortcuts.css", get(desktop_shortcuts_css))
        .route("/assets/desktop/tour.css", get(desktop_tour_css))
        .route("/assets/app-boot.js", get(app_boot_js))
        .route("/assets/shared/core.js", get(shared_core_js))
        .route("/assets/shared/http.js", get(shared_http_js))
        .route("/assets/shared/skeleton.js", get(shared_skeleton_js))
        .route("/assets/shared/skeleton.css", get(shared_skeleton_css))
        .route("/assets/shared/attention.js", get(shared_attention_js))
        .route("/assets/shared/alert-card.js", get(shared_alert_card_js))
        .route("/assets/shared/alert-card.css", get(shared_alert_card_css))
        .route("/assets/shared/options.js", get(shared_options_js))
        .route("/assets/shared/actions.js", get(shared_actions_js))
        .route(
            "/assets/shared/backend-state.js",
            get(shared_backend_state_js),
        )
        .route(
            "/assets/shared/prompt-cards.js",
            get(shared_prompt_cards_js),
        )
        .route("/assets/shared/tour-driver.js", get(shared_tour_driver_js))
        .route("/assets/shared/terminal-input.js", get(shared_terminal_input_js))
        .route("/assets/shared/file-icons.js", get(shared_file_icons_js))
        .route("/assets/shared/file-icons.css", get(shared_file_icons_css))
        .route("/assets/shared/file-tree.css", get(shared_file_tree_css))
        .route("/assets/shared/colors.css", get(shared_colors_css))
        .route("/assets/shared/palette.css", get(shared_palette_css))
        .route("/assets/shared/tokens.css", get(shared_tokens_css))
        .route("/assets/shared/primitives.css", get(shared_primitives_css))
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
        .route("/assets/desktop/modal-drag.js", get(desktop_modal_drag_js))
        .route("/assets/desktop/notes.js", get(desktop_notes_js))
        .route("/assets/desktop/app.js", get(desktop_js))
        .route("/assets/login.css", get(login_css))
        .route("/assets/login.js", get(login_js))
        .route("/assets/mobile/attention.js", get(mobile_attention_js))
        .route("/assets/mobile/core.js", get(mobile_core_js))
        .route("/assets/mobile/settings.js", get(mobile_settings_js))
        .route("/assets/mobile/search.js", get(mobile_search_js))
        .route("/assets/mobile/git.js", get(mobile_git_js))
        .route("/assets/mobile/composer.js", get(mobile_composer_js))
        .route("/assets/mobile/lens.js", get(mobile_lens_js))
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
            "/assets/mobile/directory-picker.js",
            get(mobile_directory_picker_js),
        )
        .route(
            "/assets/mobile/file-browser.js",
            get(mobile_file_browser_js),
        )
        .route("/assets/mobile/notes.js", get(mobile_notes_js))
        .route("/assets/mobile/tour-steps.js", get(mobile_tour_steps_js))
        .route("/assets/mobile/tour.js", get(mobile_tour_js))
        .route("/assets/mobile/tour.css", get(mobile_tour_css))
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
        .route("/assets/icons/worktree.svg", get(icon_worktree_svg))
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
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

/// Baseline security headers on every HTTP response. The app never frames
/// itself (DOMPurify even forbids iframes in markdown previews), so DENY is
/// safe. `no-store` is limited to `/api/` responses: those may carry session
/// or settings data that must not survive in intermediary caches, while
/// static assets cache normally. WebSocket upgrades (101) skip the cache
/// header entirely: the response body is a protocol switch, not content.
async fn security_headers(request: axum::extract::Request, next: Next) -> Response {
    let is_api = request.uri().path().starts_with("/api/");
    let mut response = next.run(request).await;
    let is_upgrade = response.status().as_u16() == 101;
    let headers = response.headers_mut();
    headers.insert(
        axum::http::header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        axum::http::header::X_FRAME_OPTIONS,
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        axum::http::header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    if is_api && !is_upgrade {
        // A handler that set its own Cache-Control (the conversation
        // image route: immutable bytes, a day-long private cache) owns
        // the decision — the blanket no-store must not overwrite it.
        if !headers.contains_key(axum::http::header::CACHE_CONTROL) {
            headers.insert(
                axum::http::header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            );
        }
    }
    response
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

pub(crate) fn canonical_session_name(session: Option<&str>) -> String {
    session
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .filter(|value| *value != "default")
        .unwrap_or("default")
        .to_string()
}

pub(crate) fn backend_target_for_headers(
    state: &WebState,
    headers: &HeaderMap,
) -> SessionBackendTarget {
    headers
        .get("x-herdr-backend")
        .and_then(|value| value.to_str().ok())
        .and_then(SessionBackendTarget::parse)
        .filter(|target| backend_target_enabled(state, *target))
        .unwrap_or_else(|| default_backend_target(state))
}

pub(crate) fn backend_target_for_query(
    state: &WebState,
    headers: &HeaderMap,
    requested: Option<&str>,
) -> SessionBackendTarget {
    requested
        .and_then(SessionBackendTarget::parse)
        .filter(|target| backend_target_enabled(state, *target))
        .unwrap_or_else(|| backend_target_for_headers(state, headers))
}

pub(crate) fn backend_target_enabled(state: &WebState, target: SessionBackendTarget) -> bool {
    state
        .server_settings
        .lock()
        .map(|settings| backend_target_enabled_in_settings(&settings, target))
        .unwrap_or(true)
}

pub(crate) fn backend_target_enabled_in_settings(
    settings: &RuntimeServerSettings,
    target: SessionBackendTarget,
) -> bool {
    match target {
        SessionBackendTarget::Builtin => settings.builtin_backend_enabled,
        SessionBackendTarget::ExternalHerdr => settings.external_herdr_backend_enabled,
    }
}

pub(crate) fn default_backend_target(state: &WebState) -> SessionBackendTarget {
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

pub(crate) fn session_from_headers(state: &WebState, headers: &HeaderMap) -> Option<String> {
    request_session_name(
        state,
        headers
            .get("x-herdr-session")
            .and_then(|value| value.to_str().ok()),
    )
}

pub(crate) fn api_for_target_session(
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

/// Resolved routing for one request: backend target plus session name.
/// Shared core of the api_for_headers*/client_socket_for_* twins.
struct SessionRoute {
    backend: SessionBackendTarget,
    session: Option<String>,
}

impl SessionRoute {
    fn for_headers(state: &WebState, headers: &HeaderMap) -> Self {
        Self {
            backend: backend_target_for_headers(state, headers),
            session: session_from_headers(state, headers),
        }
    }

    fn for_query(
        state: &WebState,
        headers: &HeaderMap,
        session: Option<&str>,
        backend: Option<&str>,
    ) -> Self {
        Self {
            backend: backend_target_for_query(state, headers, backend),
            session: request_session_name(state, session),
        }
    }

    fn api(&self, state: &WebState) -> ApiClient {
        api_for_target_session(state, self.backend, self.session.as_deref())
    }

    fn client_socket(&self, state: &WebState) -> PathBuf {
        client_socket_for_target_session(state, self.backend, self.session.as_deref())
    }

    async fn ensure(&self, state: &WebState) {
        if self.backend != SessionBackendTarget::Builtin {
            return;
        }
        let state_clone = state.clone();
        let session_clone = self.session.clone();
        let backend = self.backend;
        let _ = tokio::task::spawn_blocking(move || {
            ensure_backend_for_request(&state_clone, backend, session_clone.as_deref())
        })
        .await;
    }
}

pub(crate) fn api_for_headers(state: &WebState, headers: &HeaderMap) -> ApiClient {
    SessionRoute::for_headers(state, headers).api(state)
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
pub(crate) async fn api_for_headers_ensured(state: &WebState, headers: &HeaderMap) -> ApiClient {
    let route = SessionRoute::for_headers(state, headers);
    route.ensure(state).await;
    route.api(state)
}

#[cfg(test)]
fn client_socket_for_headers(state: &WebState, headers: &HeaderMap) -> PathBuf {
    SessionRoute::for_headers(state, headers).client_socket(state)
}

/// Resolve the API client for a query-string session/backend without
/// starting anything. `api_for_query_session_ensured` builds on this after
/// auto-starting the built-in backend when needed.
#[allow(dead_code)]
pub(crate) fn api_for_query_session_routed(
    state: &WebState,
    headers: &HeaderMap,
    session: Option<&str>,
    backend: Option<&str>,
) -> ApiClient {
    SessionRoute::for_query(state, headers, session, backend).api(state)
}

/// WebSocket twin of `api_for_headers_ensured`: resolve the API client for a
/// query-string session/backend, auto-starting the built-in backend when the
/// connection targets it so the terminal/events sockets do not 502 on a
/// fresh browser that pinned the built-in backend.
pub(crate) async fn api_for_query_session_ensured(
    state: &WebState,
    headers: &HeaderMap,
    session: Option<&str>,
    backend: Option<&str>,
) -> ApiClient {
    let route = SessionRoute::for_query(state, headers, session, backend);
    route.ensure(state).await;
    route.api(state)
}

pub(crate) fn client_socket_for_query_session(
    state: &WebState,
    headers: &HeaderMap,
    session: Option<&str>,
    backend: Option<&str>,
) -> PathBuf {
    SessionRoute::for_query(state, headers, session, backend).client_socket(state)
}

pub(crate) fn session_display_name(session: Option<&str>) -> &str {
    session.unwrap_or("default")
}

pub(crate) fn known_external_sessions() -> Vec<serde_json::Value> {
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

pub(crate) fn known_builtin_sessions(state: &WebState) -> Vec<serde_json::Value> {
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

pub(crate) fn known_sessions(state: &WebState, herdr_compatible: bool) -> Vec<serde_json::Value> {
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

pub(crate) fn read_json_line<T: for<'de> Deserialize<'de>>(
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

#[allow(clippy::result_large_err)]
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

pub(crate) struct WorktreeListCache {
    entries: Mutex<HashMap<String, WorktreeCacheEntry>>,
}

impl Default for WorktreeListCache {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

// The git-ui switch handlers must drop the cached `worktree.list` for
// the switched cwd, but the socket transport (TUI via the builtin
// backend) has no WebState to carry the handle. The builtin backend runs
// in this process, so the webui registers its cache here once and every
// transport reaches it through git_ui::worktree_cache_invalidated.
static WORKTREE_LIST_CACHES: std::sync::OnceLock<Mutex<Vec<std::sync::Arc<WorktreeListCache>>>> =
    std::sync::OnceLock::new();

#[derive(Clone)]
pub(crate) struct WorktreeCacheEntry {
    fetched_at: std::time::Instant,
    value: serde_json::Value,
}

impl WorktreeListCache {
    pub(crate) fn get(&self, cwd: &Option<String>) -> Option<WorktreeCacheEntry> {
        let cwd = cwd.as_deref()?;
        let guard = self.entries.lock().ok()?;
        let entry = guard.get(cwd)?;
        // 2s TTL: consecutive switches hit the cache, stale data never
        // outlives a user noticing a missing fresh worktree for long.
        if entry.fetched_at.elapsed() < Duration::from_secs(2) {
            Some(entry.clone())
        } else {
            None
        }
    }

    pub(crate) fn put(&self, cwd: &str, value: serde_json::Value) {
        if let Ok(mut guard) = self.entries.lock() {
            guard.insert(
                cwd.to_string(),
                WorktreeCacheEntry {
                    fetched_at: std::time::Instant::now(),
                    value,
                },
            );
        }
    }

    /// Drop the cached `worktree.list` for a cwd whose repo state just
    /// changed out of band (branch switch, reset): the rows carry the
    /// checked-out branch, so a served cache hit would answer with the
    /// pre-switch HEAD for the rest of the TTL.
    pub(crate) fn invalidate(&self, cwd: &str) {
        if let Ok(mut guard) = self.entries.lock() {
            guard.remove(cwd);
        }
    }
}

/// One `worktree.list` per unique cwd, fetched in parallel through the
/// shared short-TTL cache: before this helper existed, N workspaces paid
/// N sequential git round trips (~0.5s at 12) per snapshot. Parallel on
/// purpose: each fetch opens its own backend socket, so spawned threads
/// never share framing state. Returns the response per cwd (None when
/// the backend errored); callers decide how misses degrade.
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

pub(crate) struct HerdrWorktreeApi {
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
        crate::open_created_worktree_request(cwd, path, label)
    }

    fn create_request(
        &self,
        body: crate::CreateWorktreeRequest,
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

#[derive(Deserialize)]
pub(crate) struct WorkspaceQuery {
    workspace_id: Option<String>,
    cwd: Option<String>,
}

pub(crate) const PANE_PROMPT_TAIL_LINES: usize = 16;

#[derive(Deserialize)]
pub(crate) struct TerminalQuery {
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
pub(crate) struct SessionQuery {
    session: Option<String>,
    backend: Option<String>,
}

#[derive(Debug)]
pub(crate) enum TerminalGraphicsEvent {
    Message(String),
    Error(String),
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod panes_routes_tests;

#[cfg(test)]
mod test_env_guard;

#[cfg(test)]
mod tui_parity_e2e_tests;

#[cfg(test)]
mod graphics_bridge_tests;
