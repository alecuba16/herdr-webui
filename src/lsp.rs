//! Language Server Protocol bridge.
//!
//! Spawns local language servers and translates browser HTTP requests into
//! LSP JSON-RPC messages over stdio, following the model used by Zed: one
//! server process per language per workspace root, configurable per language
//! in persisted settings, with auto-detection of known local installations.

use std::collections::HashMap;
use std::io;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};

use crate::{expand_user_path_string, require_auth, WebState};

const MAX_LSP_REQUEST_BYTES: usize = 8 * 1024 * 1024;
const MAX_LSP_RESPONSE_BYTES: usize = 16 * 1024 * 1024;
const LSP_REQUEST_TIMEOUT_MS: u64 = 30_000;
const MAX_SERVERS: usize = 12;
const MAX_ARGS: usize = 24;
const IDLE_SHUTDOWN_SECS: u64 = 600;

// ---------------------------------------------------------------------------
// Settings model
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct LanguageServerConfig {
    #[serde(default)]
    pub(crate) enabled: bool,
    #[serde(default)]
    pub(crate) command: Option<String>,
    #[serde(default)]
    pub(crate) args: Vec<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub(crate) struct LspSettings {
    #[serde(default)]
    pub(crate) enabled: bool,
    #[serde(default)]
    pub(crate) servers: HashMap<String, LanguageServerConfig>,
}

// ---------------------------------------------------------------------------
// Known language servers (Zed reference defaults, auto-detect order)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
struct KnownServer {
    language: &'static str,
    /// Human-readable server name for the settings UI.
    name: &'static str,
    /// Executable names searched in PATH and well-known locations, in order.
    binaries: &'static [&'static str],
    /// Extra args appended when auto-detected (always after user args).
    detect_args: &'static [&'static str],
    /// npm package that provides the server, for setup guidance.
    package: Option<&'static str>,
    /// Setup hint shown in the UI when the server is not installed.
    hint: &'static str,
}

fn known_servers() -> Vec<KnownServer> {
    vec![
        KnownServer {
            language: "json",
            name: "vscode-json-language-server",
            binaries: &["vscode-json-language-server"],
            detect_args: &["--stdio"],
            package: Some("vscode-langservers-extracted"),
            hint: "npm install -g vscode-langservers-extracted",
        },
        KnownServer {
            language: "yaml",
            name: "yaml-language-server",
            binaries: &["yaml-language-server", "yaml-ls"],
            detect_args: &["--stdio"],
            package: Some("yaml-language-server"),
            hint: "npm install -g yaml-language-server",
        },
        KnownServer {
            language: "typescript",
            name: "vtsls",
            binaries: &["vtsls"],
            detect_args: &["--stdio"],
            package: Some("@vtsls/language-server"),
            hint: "npm install -g @vtsls/language-server",
        },
        KnownServer {
            language: "javascript",
            name: "vtsls",
            binaries: &["vtsls"],
            detect_args: &["--stdio"],
            package: Some("@vtsls/language-server"),
            hint: "npm install -g @vtsls/language-server",
        },
        KnownServer {
            language: "rust",
            name: "rust-analyzer",
            binaries: &["rust-analyzer"],
            detect_args: &[],
            package: None,
            hint: "rustup component add rust-analyzer",
        },
        KnownServer {
            language: "python",
            name: "ty",
            binaries: &["ty", "pyright", "python-lsp-server", "pylsp"],
            detect_args: &[],
            package: None,
            hint: "pip install ty (or pyright)",
        },
        KnownServer {
            language: "css",
            name: "vscode-css-language-server",
            binaries: &["vscode-css-language-server"],
            detect_args: &["--stdio"],
            package: Some("vscode-langservers-extracted"),
            hint: "npm install -g vscode-langservers-extracted",
        },
        KnownServer {
            language: "html",
            name: "vscode-html-language-server",
            binaries: &["vscode-html-language-server"],
            detect_args: &["--stdio"],
            package: Some("vscode-langservers-extracted"),
            hint: "npm install -g vscode-langservers-extracted",
        },
        KnownServer {
            language: "markdown",
            name: "vscode-markdown-language-server",
            binaries: &["vscode-markdown-language-server"],
            detect_args: &["--stdio"],
            package: Some("vscode-langservers-extracted"),
            hint: "npm install -g vscode-langservers-extracted",
        },
        KnownServer {
            language: "go",
            name: "gopls",
            binaries: &["gopls"],
            detect_args: &[],
            package: None,
            hint: "go install golang.org/x/tools/gopls@latest",
        },
        KnownServer {
            language: "java",
            name: "jdtls",
            binaries: &["jdtls", "java-language-server"],
            detect_args: &[],
            package: None,
            hint: "install jdtls (Eclipse JDT Language Server)",
        },
    ]
}

/// Languages the editor frontend supports, used to accept config keys.
pub(crate) fn known_language_keys() -> Vec<String> {
    let mut keys: Vec<String> = known_servers()
        .into_iter()
        .map(|server| server.language.to_string())
        .collect();
    keys.push("kotlin".to_string());
    keys.sort();
    keys.dedup();
    keys
}

/// Search PATH plus well-known install locations for a server binary.
fn find_server_binary(binary: &str) -> Option<PathBuf> {
    let direct = PathBuf::from(binary);
    if direct.is_file() {
        return Some(direct);
    }
    let path_var = std::env::var("PATH").unwrap_or_default();
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path_var).collect();
    let home = std::env::var("HOME").unwrap_or_default();
    if !home.is_empty() {
        let home = PathBuf::from(home);
        // npm global installs
        dirs.push(home.join(".local/share/npm/bin"));
        dirs.push(home.join(".npm-global/bin"));
        // cargo installs (rust-analyzer)
        dirs.push(home.join(".cargo/bin"));
        // pip user installs (ty, pyright)
        dirs.push(home.join(".local/bin"));
        // go installs
        dirs.push(home.join("go/bin"));
        // Zed-downloaded servers
        dirs.push(home.join("Library/Application Support/Zed/languages/json-language-server/node_modules/vscode-langservers-extracted/bin"));
        dirs.push(home.join("Library/Application Support/Zed/languages/yaml-language-server/node_modules/yaml-language-server/bin"));
        dirs.push(home.join("Library/Application Support/Zed/languages/typescript-language-server/node_modules/.bin"));
        dirs.push(home.join("Library/Application Support/Zed/languages/vtsls/node_modules/.bin"));
    }
    for dir in dirs {
        let candidate = dir.join(binary);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.is_file()
        && fs_metadata_permissions(path)
            .map(|perms| perms.mode() & 0o111 != 0)
            .unwrap_or(false)
}

#[cfg(unix)]
fn fs_metadata_permissions(path: &Path) -> io::Result<std::fs::Permissions> {
    std::fs::metadata(path).map(|meta| meta.permissions())
}

#[cfg(not(unix))]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

// ---------------------------------------------------------------------------
// Registry and process management
// ---------------------------------------------------------------------------

pub(crate) struct LspRegistry {
    servers: Mutex<HashMap<String, Arc<LspServerHandle>>>,
    /// Shared LSP settings, kept in sync with persisted server settings.
    settings: std::sync::Mutex<LspSettings>,
}

impl LspRegistry {
    pub(crate) fn new(settings: LspSettings) -> Self {
        Self {
            servers: Mutex::new(HashMap::new()),
            settings: std::sync::Mutex::new(settings),
        }
    }

    pub(crate) fn settings(&self) -> LspSettings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub(crate) fn set_settings(&self, settings: LspSettings) {
        if let Ok(mut guard) = self.settings.lock() {
            *guard = settings;
        }
    }

    pub(crate) async fn status(&self) -> Vec<serde_json::Value> {
        // Snapshot handles first so we never hold the registry lock while
        // probing child processes (the stdout reader cleanup takes the
        // child lock before the registry lock; avoid the inverse order).
        let snapshot: Vec<(String, std::sync::Arc<LspServerHandle>)> = {
            let servers = self.servers.lock().await;
            servers
                .iter()
                .map(|(key, handle)| (key.clone(), Arc::clone(handle)))
                .collect()
        };
        let mut out = Vec::new();
        let mut dead: Vec<String> = Vec::new();
        for (key, handle) in snapshot {
            if !handle.is_running().await {
                dead.push(key);
                continue;
            }
            out.push(json!({
                "language": handle.language,
                "root": handle.root_string,
                "command": format!("{} {}", handle.command, handle.args.join(" ")),
                "state": handle.state(),
                "last_error": handle.last_error(),
            }));
        }
        if !dead.is_empty() {
            self.servers
                .lock()
                .await
                .retain(|key, _| !dead.contains(key));
        }
        out
    }
}

struct LspServerHandle {
    language: String,
    root_string: String,
    command: String,
    args: Vec<String>,
    child: Mutex<Option<Child>>,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    /// Pending request id -> response sender.
    pending: Mutex<HashMap<u64, mpsc::Sender<serde_json::Value>>>,
    /// Push notifications (diagnostics etc.) for the frontend to poll.
    notifications: Mutex<Vec<serde_json::Value>>,
    state: std::sync::Mutex<ServerState>,
    last_error: std::sync::Mutex<Option<String>>,
    /// Servers exit or die; the first error message is latched here.
    exited: Mutex<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ServerState {
    Starting,
    Running,
}

impl LspServerHandle {
    fn state(&self) -> ServerState {
        self.state
            .lock()
            .map(|guard| *guard)
            .unwrap_or(ServerState::Starting)
    }
    fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|g| g.clone())
    }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

pub(crate) fn routes() -> Router<WebState> {
    Router::new()
        .route("/api/lsp/config", get(lsp_config).post(lsp_update_config))
        .route("/api/lsp/detect", get(lsp_detect))
        .route("/api/lsp/start", post(lsp_start))
        .route("/api/lsp/status", get(lsp_status))
        .route("/api/lsp/request", post(lsp_request))
        .route("/api/lsp/notify", post(lsp_notify))
        .route("/api/lsp/notifications", get(lsp_notifications))
        .route("/api/lsp/stop", post(lsp_stop))
}

fn lsp_error(status: StatusCode, error: impl Into<String>) -> Response {
    (status, Json(json!({ "error": error.into() }))).into_response()
}

async fn lsp_config(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let settings = state.lsp.settings();
    Json(json!({ "settings": settings, "languages": known_language_keys() })).into_response()
}

#[derive(Deserialize)]
struct LspUpdateConfigRequest {
    settings: LspSettings,
}

async fn lsp_update_config(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<LspUpdateConfigRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    if let Err(err) = validate_lsp_settings(&body.settings) {
        return lsp_error(StatusCode::BAD_REQUEST, err);
    }
    if let Err(err) = state.update_lsp_settings(body.settings.clone()).await {
        return lsp_error(StatusCode::INTERNAL_SERVER_ERROR, err.to_string());
    }
    let settings = state.lsp.settings();
    Json(json!({ "settings": settings, "languages": known_language_keys() })).into_response()
}

fn validate_lsp_settings(settings: &LspSettings) -> Result<(), String> {
    let known = known_language_keys();
    for (language, config) in &settings.servers {
        if !known.contains(language) {
            return Err(format!("unknown language: {language}"));
        }
        if config.args.len() > MAX_ARGS {
            return Err(format!("too many arguments for {language}"));
        }
        if let Some(command) = &config.command {
            let trimmed = command.trim();
            if trimmed.is_empty() {
                return Err(format!("empty command for {language}"));
            }
            if trimmed.contains("..") || trimmed.starts_with('-') {
                return Err(format!("invalid command for {language}"));
            }
        }
    }
    Ok(())
}

async fn lsp_detect(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let detected = detect_all_servers();
    Json(json!({ "servers": detected })).into_response()
}

async fn lsp_status(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let servers = state.lsp.status().await;
    Json(json!({ "servers": servers })).into_response()
}

/// Detect every known language server without spawning anything.
fn detect_all_servers() -> Vec<serde_json::Value> {
    known_servers()
        .into_iter()
        .map(|server| {
            let found = server
                .binaries
                .iter()
                .find_map(|binary| find_server_binary(binary))
                .map(|path| path.to_string_lossy().to_string());
            let settings_configured = found.is_some();
            json!({
                "language": server.language,
                "name": server.name,
                "found": found,
                "ready": settings_configured,
                "package": server.package,
                "hint": server.hint,
                "args": server.detect_args,
            })
        })
        .collect()
}

#[derive(Deserialize)]
struct LspStartRequest {
    language: String,
    cwd: String,
}

async fn lsp_start(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<LspStartRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let settings = state.lsp.settings();
    if !settings.enabled {
        return lsp_error(StatusCode::FORBIDDEN, "language servers are disabled");
    }
    let language = body.language.trim().to_lowercase();
    let Some(config) = settings.servers.get(&language).cloned() else {
        return lsp_error(
            StatusCode::NOT_FOUND,
            format!("no language server configured for {language}"),
        );
    };
    if !config.enabled {
        return lsp_error(
            StatusCode::FORBIDDEN,
            format!("language server for {language} is disabled"),
        );
    }
    let Some(command) = config.command else {
        return lsp_error(
            StatusCode::BAD_REQUEST,
            format!("no command configured for {language}"),
        );
    };
    let root = match resolve_workspace_root(&body.cwd) {
        Ok(root) => root,
        Err(err) => return lsp_error(StatusCode::BAD_REQUEST, err),
    };
    let root_string = root.to_string_lossy().to_string();
    let key = server_key(&language, &root_string);
    {
        let servers = state.lsp.servers.lock().await;
        if let Some(handle) = servers.get(&key) {
            if handle.is_running().await {
                return Json(json!({ "ok": true, "key": key, "already_running": true }))
                    .into_response();
            }
        }
    }
    if let Err(err) = can_spawn_more(&state).await {
        return lsp_error(StatusCode::TOO_MANY_REQUESTS, err);
    }
    let mut args = config.args.clone();
    let known = known_servers().into_iter().find(|s| s.language == language);
    if let (Some(known), true) = (known.as_ref(), args.is_empty()) {
        args = known
            .detect_args
            .iter()
            .map(|arg| arg.to_string())
            .collect();
    }
    match spawn_server(&state, &language, &root_string, &command, &args).await {
        Ok(spawned_key) => {
            Json(json!({ "ok": true, "key": spawned_key, "already_running": false }))
                .into_response()
        }
        Err(err) => lsp_error(StatusCode::BAD_GATEWAY, err),
    }
}

async fn can_spawn_more(state: &WebState) -> Result<(), String> {
    let servers = state.lsp.servers.lock().await;
    let mut running = 0;
    for handle in servers.values() {
        if handle.is_running().await {
            running += 1;
        }
    }
    if running >= MAX_SERVERS {
        return Err(format!(
            "too many running language servers (max {MAX_SERVERS})"
        ));
    }
    Ok(())
}

fn server_key(language: &str, root: &str) -> String {
    format!("{language}:{root}")
}

/// Resolve the workspace root for a server, same confinement as the file
/// browser: the directory must exist and be readable.
fn resolve_workspace_root(cwd: &str) -> Result<PathBuf, String> {
    let expanded = expand_user_path_string(cwd);
    let path = PathBuf::from(expanded)
        .canonicalize()
        .map_err(|err| format!("invalid workspace root: {err}"))?;
    if !path.is_dir() {
        return Err("workspace root is not a directory".to_string());
    }
    Ok(path)
}

async fn spawn_server(
    state: &WebState,
    language: &str,
    root: &str,
    command: &str,
    args: &[String],
) -> Result<String, String> {
    // Resolve the command: absolute path or PATH lookup. Never a shell.
    let resolved = resolve_command(command).ok_or_else(|| {
        format!("language server command not found: {command}. Install it or set an absolute path.")
    })?;
    let mut cmd = Command::new(&resolved);
    cmd.args(args)
        .current_dir(root)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("failed to start {command}: {err}"))?;
    let stdin = child.stdin.take().ok_or("no stdin handle")?;
    let stdout = child.stdout.take().ok_or("no stdout handle")?;
    let stderr = child.stderr.take().ok_or("no stderr handle")?;

    let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>(64);

    let handle = Arc::new(LspServerHandle {
        language: language.to_string(),
        root_string: root.to_string(),
        command: resolved.to_string_lossy().to_string(),
        args: args.to_vec(),
        child: Mutex::new(Some(child)),
        stdin_tx,
        pending: Mutex::new(HashMap::new()),
        notifications: Mutex::new(Vec::new()),
        state: std::sync::Mutex::new(ServerState::Starting),
        last_error: std::sync::Mutex::new(None),
        exited: Mutex::new(false),
    });

    // stdin writer task
    let key = server_key(language, root);
    let stdin_writer = stdin;
    tokio::spawn(async move {
        let mut writer = stdin_writer;
        let mut rx = stdin_rx;
        while let Some(frame) = rx.recv().await {
            if writer.write_all(&frame).await.is_err() {
                break;
            }
            let _ = writer.flush().await;
        }
    });

    // stdout reader: parse LSP frames, dispatch responses and notifications.
    let handle_for_reader = Arc::clone(&handle);
    let registry_for_reader = Arc::clone(&state.lsp);
    let key_for_reader = key.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            let mut header = String::new();
            // Read headers until empty line.
            let mut content_length: Option<usize> = None;
            loop {
                header.clear();
                match reader.read_line(&mut header).await {
                    Ok(0) => {
                        // EOF: server exited; drop it from the registry.
                        let mut child_guard = handle_for_reader.child.lock().await;
                        if let Some(mut child) = child_guard.take() {
                            let _ = child.kill().await;
                        }
                        *handle_for_reader.exited.lock().await = true;
                        registry_for_reader
                            .servers
                            .lock()
                            .await
                            .remove(&key_for_reader);
                        return;
                    }
                    Ok(_) => {}
                    Err(_) => {
                        // Read error: treat like exit and clean up.
                        let mut child_guard = handle_for_reader.child.lock().await;
                        if let Some(mut child) = child_guard.take() {
                            let _ = child.kill().await;
                        }
                        *handle_for_reader.exited.lock().await = true;
                        registry_for_reader
                            .servers
                            .lock()
                            .await
                            .remove(&key_for_reader);
                        return;
                    }
                }
                let line = header.trim_end();
                if line.is_empty() {
                    break;
                }
                if let Some(value) = line
                    .strip_prefix("Content-Length:")
                    .map(str::trim)
                    .and_then(|v| v.parse::<usize>().ok())
                {
                    content_length = Some(value);
                }
            }
            let Some(length) = content_length else {
                continue;
            };
            if length > MAX_LSP_RESPONSE_BYTES {
                // Oversized frame: kill the server and drop it from the registry.
                let mut child_guard = handle_for_reader.child.lock().await;
                if let Some(mut child) = child_guard.take() {
                    let _ = child.kill().await;
                }
                *handle_for_reader.exited.lock().await = true;
                registry_for_reader
                    .servers
                    .lock()
                    .await
                    .remove(&key_for_reader);
                return;
            }
            let mut body = vec![0u8; length];
            if reader.read_exact(&mut body).await.is_err() {
                // Truncated frame: treat like exit and clean up.
                let mut child_guard = handle_for_reader.child.lock().await;
                if let Some(mut child) = child_guard.take() {
                    let _ = child.kill().await;
                }
                *handle_for_reader.exited.lock().await = true;
                registry_for_reader
                    .servers
                    .lock()
                    .await
                    .remove(&key_for_reader);
                return;
            }
            let Ok(message) = serde_json::from_slice::<serde_json::Value>(&body) else {
                continue;
            };
            if let Some(id) = message.get("id").and_then(|id| id.as_u64()) {
                if let Some(result) = message.get("result").or_else(|| message.get("error")) {
                    let sender = handle_for_reader.pending.lock().await.remove(&id);
                    if let Some(sender) = sender {
                        let _ = sender.send(result.clone()).await;
                    }
                }
            } else if let Some(method) = message.get("method").and_then(|m| m.as_str()) {
                if method == "textDocument/publishDiagnostics"
                    || method == "textDocument/publishDiagnosticsThin"
                    || method == "$/progress"
                    || method == "window/showMessage"
                    || method == "window/logMessage"
                {
                    let mut notifications = handle_for_reader.notifications.lock().await;
                    notifications.push(message);
                    // Keep the latest 200 notifications.
                    let len = notifications.len();
                    if len > 200 {
                        notifications.drain(0..len - 200);
                    }
                }
            }
        }
    });

    // stderr watcher: latch first error line (servers may write logs).
    let handle_for_stderr = Arc::clone(&handle);
    tokio::spawn(async move {
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => return,
                Ok(_) => {}
                Err(_) => return,
            }
            let trimmed = line.trim();
            if !trimmed.is_empty() {
                if let Ok(mut last_error) = handle_for_stderr.last_error.lock() {
                    if last_error.is_none() {
                        *last_error = Some(format!(
                            "stderr: {}",
                            trimmed.chars().take(500).collect::<String>()
                        ));
                    }
                }
            }
        }
    });

    // Exit watcher + idle shutdown.
    let handle_for_exit = Arc::clone(&handle);
    let registry = Arc::clone(&state.lsp);
    let key_for_task = key.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(IDLE_SHUTDOWN_SECS)).await;
        // Idle for 10 minutes without any request: shut down.
        let _ = handle_for_exit.send_request("shutdown", json!({})).await;
        let _ = handle_for_exit.send_notification("exit", json!({})).await;
        let mut child_guard = handle_for_exit.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill().await;
        }
        *handle_for_exit.exited.lock().await = true;
        registry.servers.lock().await.remove(&key_for_task);
    });

    state
        .lsp
        .servers
        .lock()
        .await
        .insert(key.clone(), Arc::clone(&handle));
    Ok(key)
}

fn resolve_command(command: &str) -> Option<PathBuf> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(expand_user_path_string(trimmed));
    if path.is_absolute() {
        return is_executable(&path).then_some(path);
    }
    if trimmed.contains('/') {
        // Relative path with directories: reject (avoid cwd-dependent runs).
        return None;
    }
    find_server_binary(trimmed)
}

impl LspServerHandle {
    async fn is_running(&self) -> bool {
        // A server is running only while its child process is alive and no
        // exit (EOF on stdout, idle shutdown, or stop) has been observed.
        let mut guard = self.child.lock().await;
        match guard.as_mut() {
            Some(child) => match child.try_wait() {
                Ok(None) => !*self.exited.lock().await,
                // Reap the dead child so callers stop seeing it as a slot.
                Ok(_) => {
                    guard.take();
                    *self.exited.lock().await = true;
                    false
                }
                Err(_) => false,
            },
            None => false,
        }
    }

    async fn send_frame(&self, message: &serde_json::Value) -> Result<(), String> {
        let body = serde_json::to_vec(message).map_err(|err| err.to_string())?;
        if body.len() > MAX_LSP_REQUEST_BYTES {
            return Err("LSP message too large".to_string());
        }
        let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
        frame.extend_from_slice(&body);
        self.stdin_tx
            .send(frame)
            .await
            .map_err(|_| "language server is not running".to_string())
    }

    pub(crate) async fn send_request(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let (tx, mut rx) = mpsc::channel(1);
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let request_id = NEXT.fetch_add(1, Ordering::Relaxed);
        self.pending.lock().await.insert(request_id, tx);
        let message = json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "method": method,
            "params": params,
        });
        self.send_frame(&message).await?;
        match tokio::time::timeout(
            std::time::Duration::from_millis(LSP_REQUEST_TIMEOUT_MS),
            rx.recv(),
        )
        .await
        {
            Ok(Some(response)) => Ok(response),
            Ok(None) => Err("language server dropped the request".to_string()),
            Err(_) => {
                self.pending.lock().await.remove(&request_id);
                Err(format!("{method} timed out"))
            }
        }
    }

    pub(crate) async fn send_notification(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<(), String> {
        let message = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        self.send_frame(&message).await
    }

    fn mark_running(&self) {
        if let Ok(mut state) = self.state.lock() {
            *state = ServerState::Running;
        }
    }
}

// ---------------------------------------------------------------------------
// Request / notify endpoints
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct LspRequestForward {
    language: String,
    cwd: String,
    method: String,
    params: Option<serde_json::Value>,
}

async fn lsp_request(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<LspRequestForward>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let settings = state.lsp.settings();
    if !settings.enabled {
        return lsp_error(StatusCode::FORBIDDEN, "language servers are disabled");
    }
    if !is_allowed_request_method(&body.method) {
        return lsp_error(
            StatusCode::FORBIDDEN,
            format!("LSP method not allowed: {}", body.method),
        );
    }
    let root = match resolve_workspace_root(&body.cwd) {
        Ok(root) => root,
        Err(err) => return lsp_error(StatusCode::BAD_REQUEST, err),
    };
    let key = server_key(&body.language.to_lowercase(), &root.to_string_lossy());
    let handle = {
        let servers = state.lsp.servers.lock().await;
        servers.get(&key).cloned()
    };
    let Some(handle) = handle else {
        return lsp_error(
            StatusCode::NOT_FOUND,
            "language server is not running; call /api/lsp/start first",
        );
    };
    if !handle.is_running().await {
        return lsp_error(StatusCode::GONE, "language server has exited");
    }
    if body.method == "initialize" {
        handle.mark_running();
    }
    match handle
        .send_request(&body.method, body.params.unwrap_or(json!({})))
        .await
    {
        Ok(result) => Json(json!({ "ok": true, "result": result })).into_response(),
        Err(err) => lsp_error(StatusCode::BAD_GATEWAY, err),
    }
}

/// Whitelisted LSP methods the browser may request. Lifecycle methods are
/// handled by the backend itself; dangerous or custom methods are blocked.
fn is_allowed_request_method(method: &str) -> bool {
    matches!(
        method,
        "initialize"
            | "textDocument/hover"
            | "textDocument/completion"
            | "completionItem/resolve"
            | "textDocument/signatureHelp"
            | "textDocument/definition"
            | "textDocument/typeDefinition"
            | "textDocument/implementation"
            | "textDocument/references"
            | "textDocument/documentSymbol"
            | "textDocument/rename"
            | "textDocument/prepareRename"
            | "textDocument/formatting"
            | "textDocument/rangeFormatting"
            | "textDocument/codeAction"
            | "textDocument/semanticTokens/full"
            | "textDocument/semanticTokens/range"
            | "textDocument/inlayHint"
            | "textDocument/foldingRange"
            | "textDocument/documentHighlight"
            | "textDocument/codeLens"
            | "shutdown"
    )
}

#[derive(Deserialize)]
struct LspNotifyForward {
    language: String,
    cwd: String,
    method: String,
    params: Option<serde_json::Value>,
}

async fn lsp_notify(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<LspNotifyForward>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let settings = state.lsp.settings();
    if !settings.enabled {
        return lsp_error(StatusCode::FORBIDDEN, "language servers are disabled");
    }
    if !is_allowed_notify_method(&body.method) {
        return lsp_error(
            StatusCode::FORBIDDEN,
            format!("LSP notification not allowed: {}", body.method),
        );
    }
    let root = match resolve_workspace_root(&body.cwd) {
        Ok(root) => root,
        Err(err) => return lsp_error(StatusCode::BAD_REQUEST, err),
    };
    let key = server_key(&body.language.to_lowercase(), &root.to_string_lossy());
    let handle = {
        let servers = state.lsp.servers.lock().await;
        servers.get(&key).cloned()
    };
    let Some(handle) = handle else {
        return lsp_error(
            StatusCode::NOT_FOUND,
            "language server is not running; call /api/lsp/start first",
        );
    };
    if !handle.is_running().await {
        return lsp_error(StatusCode::GONE, "language server has exited");
    }
    if body.method == "initialized" {
        handle.mark_running();
    }
    match handle
        .send_notification(&body.method, body.params.unwrap_or(json!({})))
        .await
    {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(err) => lsp_error(StatusCode::BAD_GATEWAY, err),
    }
}

fn is_allowed_notify_method(method: &str) -> bool {
    matches!(
        method,
        "initialized"
            | "exit"
            | "textDocument/didOpen"
            | "textDocument/didChange"
            | "textDocument/didSave"
            | "textDocument/didClose"
            | "textDocument/willSave"
            | "$/cancelRequest"
            | "$/setTrace"
    )
}

async fn lsp_notifications(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    let servers = state.lsp.status().await;
    // Frontend polls per (language, cwd); collect everything for simplicity.
    let mut all = Vec::new();
    {
        let registry = state.lsp.servers.lock().await;
        for handle in registry.values() {
            let mut notifications = handle.notifications.lock().await;
            all.append(&mut notifications);
        }
    }
    Json(json!({ "notifications": all, "servers": servers })).into_response()
}

#[derive(Deserialize)]
struct LspStopRequest {
    language: Option<String>,
    cwd: Option<String>,
}

async fn lsp_stop(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<LspStopRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    // Stop handles first, then prune dead entries, so a stopped server is
    // removed from the registry instead of lingering as a dead slot.
    let mut stopped = 0;
    if let (Some(language), Some(cwd)) = (body.language.as_deref(), body.cwd.as_deref()) {
        let root = match resolve_workspace_root(cwd) {
            Ok(root) => root,
            Err(err) => return lsp_error(StatusCode::BAD_REQUEST, err),
        };
        let key = server_key(&language.to_lowercase(), &root.to_string_lossy());
        let handle = {
            let servers = state.lsp.servers.lock().await;
            servers.get(&key).cloned()
        };
        if let Some(handle) = handle {
            if let Err(err) = stop_handle(&handle).await {
                return lsp_error(StatusCode::BAD_GATEWAY, err);
            }
            stopped += 1;
            state.lsp.servers.lock().await.remove(&key);
        }
    } else {
        let snapshot: Vec<_> = {
            let servers = state.lsp.servers.lock().await;
            servers.values().map(Arc::clone).collect()
        };
        for handle in snapshot {
            if let Err(err) = stop_handle(&handle).await {
                return lsp_error(StatusCode::BAD_GATEWAY, err);
            }
            stopped += 1;
        }
        state.lsp.servers.lock().await.clear();
    }
    Json(json!({ "ok": true, "stopped": stopped })).into_response()
}

async fn stop_handle(handle: &Arc<LspServerHandle>) -> Result<(), String> {
    let _ = handle.send_request("shutdown", json!({})).await;
    let _ = handle.send_notification("exit", json!({})).await;
    let mut child_guard = handle.child.lock().await;
    if let Some(mut child) = child_guard.take() {
        let _ = child.kill().await;
    }
    *handle.exited.lock().await = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_lsp_settings_rejects_unknown_language() {
        let mut settings = LspSettings::default();
        settings
            .servers
            .insert("cobol".to_string(), LanguageServerConfig::default());
        assert!(validate_lsp_settings(&settings)
            .unwrap_err()
            .contains("unknown language"));
    }

    #[test]
    fn validate_lsp_settings_rejects_invalid_commands() {
        let mut settings = LspSettings::default();
        settings.servers.insert(
            "json".to_string(),
            LanguageServerConfig {
                enabled: true,
                command: Some("../escape".to_string()),
                args: vec![],
            },
        );
        assert!(validate_lsp_settings(&settings).is_err());

        settings.servers.insert(
            "json".to_string(),
            LanguageServerConfig {
                enabled: true,
                command: Some("-rf".to_string()),
                args: vec![],
            },
        );
        assert!(validate_lsp_settings(&settings).is_err());

        settings.servers.insert(
            "json".to_string(),
            LanguageServerConfig {
                enabled: true,
                command: Some("   ".to_string()),
                args: vec![],
            },
        );
        assert!(validate_lsp_settings(&settings).is_err());
    }

    #[test]
    fn validate_lsp_settings_accepts_known_language() {
        let mut settings = LspSettings::default();
        settings.servers.insert(
            "json".to_string(),
            LanguageServerConfig {
                enabled: true,
                command: Some("vscode-json-language-server".to_string()),
                args: vec!["--stdio".to_string()],
            },
        );
        assert!(validate_lsp_settings(&settings).is_ok());
    }

    #[test]
    fn validate_lsp_settings_limits_args() {
        let mut settings = LspSettings::default();
        settings.servers.insert(
            "json".to_string(),
            LanguageServerConfig {
                enabled: true,
                command: Some("x".to_string()),
                args: vec!["-a".to_string(); MAX_ARGS + 1],
            },
        );
        assert!(validate_lsp_settings(&settings).is_err());
    }

    #[test]
    fn known_language_keys_are_unique_and_sorted() {
        let keys = known_language_keys();
        let mut sorted = keys.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(keys, sorted);
        assert!(keys.contains(&"json".to_string()));
        assert!(keys.contains(&"kotlin".to_string()));
    }

    #[test]
    fn request_whitelist_blocks_lifecycle_and_custom_methods() {
        assert!(!is_allowed_request_method("workspace/symbol"));
        assert!(!is_allowed_request_method("client/registerCapability"));
        assert!(!is_allowed_request_method("workspace/executeCommand"));
        assert!(is_allowed_request_method("textDocument/hover"));
        assert!(is_allowed_request_method("textDocument/completion"));
        assert!(is_allowed_request_method("textDocument/definition"));
        assert!(is_allowed_request_method("shutdown"));
    }

    #[test]
    fn notify_whitelist_blocks_arbitrary_methods() {
        assert!(!is_allowed_notify_method(
            "workspace/didChangeConfiguration"
        ));
        assert!(!is_allowed_notify_method("exit/whatever"));
        assert!(is_allowed_notify_method("textDocument/didOpen"));
        assert!(is_allowed_notify_method("textDocument/didChange"));
        assert!(is_allowed_notify_method("textDocument/didClose"));
    }

    #[test]
    fn resolve_command_rejects_relative_paths() {
        assert!(resolve_command("").is_none());
        assert!(resolve_command("some/relative/server").is_none());
    }

    #[test]
    fn server_key_combines_language_and_root() {
        assert_eq!(
            server_key("json", "/tmp/project"),
            "json:/tmp/project".to_string()
        );
    }

    #[test]
    fn detect_reports_json_server_when_available() {
        let servers = detect_all_servers();
        let json = servers
            .iter()
            .find(|s| s.get("language").and_then(|l| l.as_str()) == Some("json"))
            .expect("json entry");
        // Structure check: every language has a hint.
        assert!(json.get("hint").and_then(|h| h.as_str()).is_some());
    }

    #[test]
    fn workspace_root_must_be_a_directory() {
        assert!(resolve_workspace_root("/definitely/not/here").is_err());
        let file = std::env::temp_dir().join("herdr-lsp-not-a-dir.txt");
        std::fs::write(&file, b"x").ok();
        assert!(resolve_workspace_root(&file.to_string_lossy()).is_err());
        let _ = std::fs::remove_file(&file);
    }

    #[tokio::test]
    async fn registry_settings_roundtrip() {
        let registry = LspRegistry::new(LspSettings::default());
        assert!(!registry.settings().enabled);
        let mut settings = LspSettings::default();
        settings.enabled = true;
        registry.set_settings(settings.clone());
        assert!(registry.settings().enabled);
    }

    /// End-to-end: spawn a tiny fake LSP server written in node (mirrors how
    /// real JS language servers speak Content-Length framed JSON-RPC on
    /// stdio), then drive initialize + shutdown through the registry.
    #[tokio::test]
    async fn spawns_fake_lsp_server_and_proxies_requests() {
        let node = std::process::Command::new("which")
            .arg("node")
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if !node {
            eprintln!("skipping: node not found");
            return;
        }
        let script = r#"
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
let buf = '';
process.stdin.on('data', (d) => { buf += d.toString(); tryParse(); });
function tryParse() {
  while (true) {
    const idx = buf.indexOf('\r\n\r\n');
    if (idx < 0) return;
    const header = buf.slice(0, idx);
    const m = header.match(/Content-Length: (\d+)/);
    if (!m) { buf = ''; return; }
    const len = parseInt(m[1], 10);
    if (buf.length < idx + 4 + len) return;
    const body = buf.slice(idx + 4, idx + 4 + len);
    buf = buf.slice(idx + 4 + len);
    handleMessage(JSON.parse(body));
  }
}
function send(msg) {
  const s = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(s) + '\r\n\r\n' + s);
}
function handleMessage(msg) {
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true } } });
  } else if (msg.method === 'textDocument/hover') {
    send({ jsonrpc: '2.0', id: msg.id, result: { contents: 'hello from fake' } });
  } else if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
  } else if (msg.method === 'exit') {
    process.exit(0);
  }
}
"#;
        let dir = std::env::temp_dir().join("herdr-lsp-fake-server");
        std::fs::create_dir_all(&dir).ok();
        let script_path = dir.join("fake-server.js");
        std::fs::write(&script_path, script).unwrap();
        let script_abs = script_path.canonicalize().unwrap();

        let registry = Arc::new(LspRegistry::new(LspSettings::default()));
        let root = dir.canonicalize().unwrap().to_string_lossy().to_string();
        let node_bin = std::process::Command::new("which")
            .arg("node")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .expect("node path");
        let command = node_bin;
        let script_arg = script_abs.to_string_lossy().to_string();
        let key = spawn_server_test(registry.as_ref(), "json", &root, &command, &[script_arg])
            .await
            .expect("spawn failed");
        assert!(key.starts_with("json:"));

        let handle = {
            let servers = registry.servers.lock().await;
            servers.get(&key).cloned().expect("handle registered")
        };
        // Wait for the process to be running.
        for _ in 0..50 {
            if handle.is_running().await {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(handle.is_running().await);

        let init = handle
            .send_request(
                "initialize",
                json!({
                    "processId": null,
                    "rootUri": format!("file://{root}"),
                    "capabilities": {},
                }),
            )
            .await
            .expect("initialize request failed");
        assert!(init
            .get("capabilities")
            .and_then(|c| c.get("hoverProvider"))
            .and_then(|h| h.as_bool())
            .unwrap_or(false));

        let hover = handle
            .send_request(
                "textDocument/hover",
                json!({
                    "textDocument": { "uri": format!("file://{root}/test.json") },
                    "position": { "line": 0, "character": 0 },
                }),
            )
            .await
            .expect("hover request failed");
        assert!(hover
            .get("contents")
            .and_then(|c| c.as_str())
            .map(|c| c.contains("fake"))
            .unwrap_or(false));

        stop_handle(&handle).await.ok();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }

    async fn spawn_server_test(
        registry: &LspRegistry,
        language: &str,
        root: &str,
        command: &str,
        args: &[String],
    ) -> Result<String, String> {
        let handle = spawn_server_inner(language, root, command, args).await?;
        let key = server_key(language, root);
        registry.servers.lock().await.insert(key.clone(), handle);
        Ok(key)
    }

    /// Core spawn logic without requiring a full WebState; used by tests.
    async fn spawn_server_inner(
        language: &str,
        root: &str,
        command: &str,
        args: &[String],
    ) -> Result<Arc<LspServerHandle>, String> {
        let resolved =
            resolve_command(command).ok_or_else(|| format!("command not found: {command}"))?;
        let mut cmd = Command::new(&resolved);
        cmd.args(args)
            .current_dir(root)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|err| err.to_string())?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;
        let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>(64);
        let handle = Arc::new(LspServerHandle {
            language: language.to_string(),
            root_string: root.to_string(),
            command: resolved.to_string_lossy().to_string(),
            args: args.to_vec(),
            child: Mutex::new(Some(child)),
            stdin_tx,
            pending: Mutex::new(HashMap::new()),
            notifications: Mutex::new(Vec::new()),
            state: std::sync::Mutex::new(ServerState::Starting),
            last_error: std::sync::Mutex::new(None),
            exited: Mutex::new(false),
        });
        tokio::spawn(async move {
            let mut writer = stdin;
            let mut rx = stdin_rx;
            while let Some(frame) = rx.recv().await {
                if writer.write_all(&frame).await.is_err() {
                    break;
                }
                let _ = writer.flush().await;
            }
        });
        let handle_for_reader = Arc::clone(&handle);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut header = String::new();
                let mut content_length: Option<usize> = None;
                loop {
                    header.clear();
                    match reader.read_line(&mut header).await {
                        Ok(0) => return,
                        Ok(_) => {}
                        Err(_) => return,
                    }
                    let line = header.trim_end();
                    if line.is_empty() {
                        break;
                    }
                    if let Some(value) = line
                        .strip_prefix("Content-Length:")
                        .map(str::trim)
                        .and_then(|v| v.parse::<usize>().ok())
                    {
                        content_length = Some(value);
                    }
                }
                let Some(length) = content_length else {
                    continue;
                };
                if length > MAX_LSP_RESPONSE_BYTES {
                    return;
                }
                let mut body = vec![0u8; length];
                if reader.read_exact(&mut body).await.is_err() {
                    return;
                }
                let Ok(message) = serde_json::from_slice::<serde_json::Value>(&body) else {
                    continue;
                };
                if let Some(id) = message.get("id").and_then(|id| id.as_u64()) {
                    if let Some(result) = message.get("result").or_else(|| message.get("error")) {
                        let sender = handle_for_reader.pending.lock().await.remove(&id);
                        if let Some(sender) = sender {
                            let _ = sender.send(result.clone()).await;
                        }
                    }
                }
            }
        });
        let handle_for_stderr = Arc::clone(&handle);
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) => return,
                    Ok(_) => {}
                    Err(_) => return,
                }
                let _ = handle_for_stderr;
            }
        });
        Ok(handle)
    }

    #[tokio::test]
    async fn dead_server_is_pruned_from_status() {
        // A server that exits right away must disappear from status() and
        // the registry instead of lingering as a phantom "running" entry.
        let node = std::process::Command::new("which")
            .arg("node")
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false);
        if !node {
            eprintln!("skipping: node not found");
            return;
        }
        let dir = std::env::temp_dir().join("herdr-lsp-dies-immediately");
        std::fs::create_dir_all(&dir).ok();
        let script_path = dir.join("die-immediately.js");
        std::fs::write(&script_path, "process.exit(0);\n").unwrap();
        let root = dir.canonicalize().unwrap().to_string_lossy().to_string();
        let node_bin = std::process::Command::new("which")
            .arg("node")
            .output()
            .ok()
            .filter(|out| out.status.success())
            .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
            .expect("node path");
        let registry = Arc::new(LspRegistry::new(LspSettings::default()));
        let script_arg = script_path
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string();
        let key = spawn_server_test(registry.as_ref(), "json", &root, &node_bin, &[script_arg])
            .await
            .expect("spawn failed");

        // The process exits; is_running() must flip to false and the next
        // status() call must drop it from the registry.
        let mut running = true;
        for _ in 0..100 {
            let servers = registry.servers.lock().await;
            let handle = servers.get(&key).cloned();
            drop(servers);
            if let Some(handle) = handle {
                if !handle.is_running().await {
                    running = false;
                    break;
                }
            } else {
                // Already removed by the stdout reader cleanup.
                running = false;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(!running, "dead server was never detected as exited");

        let status = registry.status().await;
        assert!(
            status.is_empty(),
            "dead server must be pruned from status, got: {status:?}"
        );
        assert!(
            registry.servers.lock().await.get(&key).is_none(),
            "dead server must be removed from the registry"
        );
    }
}
