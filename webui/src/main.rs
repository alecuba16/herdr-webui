use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use interprocess::TryClone as _;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

const DEFAULT_BIND: &str = "127.0.0.1:8787";
const COOKIE_NAME: &str = "herdr_web_session";
const HERDR_WEBUI_VERSION: &str = env!("HERDR_WEBUI_VERSION");
const INSTALL_LABEL: &str = "herdr-web";
const MAX_FRAME_SIZE: usize = 2 * 1024 * 1024;
const MAX_GRAPHICS_FRAME_SIZE: usize = 32 * 1024 * 1024;
const PROTOCOL_VERSION: u32 = 14;
const MIN_BACKEND_VERSION: &str = "0.7.0";
const MAX_TESTED_BACKEND_VERSION: &str = "0.7.0";

type LocalStream = interprocess::local_socket::Stream;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct SimpleVersion {
    major: u64,
    minor: u64,
    patch: u64,
}

impl SimpleVersion {
    fn parse(value: &str) -> Option<Self> {
        let value = value.strip_prefix('v').unwrap_or(value);
        let core = value
            .find(['-', '+'])
            .map(|index| &value[..index])
            .unwrap_or(value);
        let mut parts = core.split('.');
        let major = parts.next()?.parse().ok()?;
        let minor = parts.next()?.parse().ok()?;
        let patch = parts.next()?.parse().ok()?;
        parts.next().is_none().then_some(Self {
            major,
            minor,
            patch,
        })
    }
}

#[derive(Debug, PartialEq, Eq)]
enum BackendCompatibility {
    Compatible,
    TooOld,
    UntestedNewer,
    Unknown,
}

impl BackendCompatibility {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Compatible => "compatible",
            Self::TooOld => "too_old",
            Self::UntestedNewer => "untested_newer",
            Self::Unknown => "unknown",
        }
    }

    fn message(&self, backend: Option<&str>) -> &'static str {
        match self {
            Self::Compatible => "backend version is supported",
            Self::TooOld => "backend version is older than the minimum supported version",
            Self::UntestedNewer => "backend version is newer than the maximum tested version",
            Self::Unknown if backend.is_some() => "backend version could not be parsed",
            Self::Unknown => "backend version is unavailable",
        }
    }
}

fn backend_compatibility(backend: Option<&str>) -> BackendCompatibility {
    let Some(backend) = backend.and_then(SimpleVersion::parse) else {
        return BackendCompatibility::Unknown;
    };
    let min = SimpleVersion::parse(MIN_BACKEND_VERSION).expect("valid min backend version");
    let max = SimpleVersion::parse(MAX_TESTED_BACKEND_VERSION).expect("valid max backend version");
    if backend < min {
        BackendCompatibility::TooOld
    } else if backend > max {
        BackendCompatibility::UntestedNewer
    } else {
        BackendCompatibility::Compatible
    }
}

#[derive(Clone, Debug)]
struct WebConfig {
    bind: SocketAddr,
    session: Option<String>,
    api_socket: Option<PathBuf>,
    client_socket: Option<PathBuf>,
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

fn print_help() {
    eprintln!("herdr-webui [--bind HOST:PORT] [--session NAME] [--api-socket PATH] [--client-socket PATH]");
    eprintln!("herdr-webui --version");
    eprintln!("herdr-webui install-mac [--bind HOST:PORT] [--session NAME]");
    eprintln!("herdr-webui update-mac");
    eprintln!("herdr-webui uninstall-mac");
    eprintln!("env:");
    eprintln!("  HERDR_WEB_USER=alice HERDR_WEB_PASSWORD=secret");
    eprintln!("  HERDR_WEB_LOCALHOST_NO_AUTH=true");
}

fn home_dir() -> io::Result<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from).ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::NotFound,
            "HOME is required for macOS install",
        )
    })
}

fn local_bin_dir() -> io::Result<PathBuf> {
    Ok(home_dir()?.join(".local").join("bin"))
}

fn install_bin_path() -> io::Result<PathBuf> {
    Ok(local_bin_dir()?.join("herdr-webui"))
}

fn install_plist_path() -> io::Result<PathBuf> {
    Ok(home_dir()?
        .join("Library")
        .join("LaunchAgents")
        .join(format!("{INSTALL_LABEL}.plist")))
}

fn install_log_dir() -> io::Result<PathBuf> {
    Ok(home_dir()?.join("Library").join("Logs").join("herdr-webui"))
}

fn copy_current_exe_to_install_path() -> io::Result<PathBuf> {
    let source = std::env::current_exe()?;
    let target = install_bin_path()?;
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let same_file = source.canonicalize().ok() == target.canonicalize().ok();
    if !same_file {
        fs::copy(&source, &target)?;
    }
    let mut permissions = fs::metadata(&target)?.permissions();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        permissions.set_mode(0o755);
    }
    fs::set_permissions(&target, permissions)?;
    Ok(target)
}

fn plist_xml(config: &WebConfig, install_bin: &Path) -> io::Result<String> {
    let log_dir = install_log_dir()?;
    let mut env_lines = vec![format!(
        "    <key>HERDR_WEB_LOCALHOST_NO_AUTH</key>\n    <string>{}</string>",
        xml_escape(
            &std::env::var("HERDR_WEB_LOCALHOST_NO_AUTH").unwrap_or_else(|_| "true".to_string())
        )
    )];
    if let Ok(user) = std::env::var("HERDR_WEB_USER") {
        if !user.is_empty() {
            env_lines.push(format!(
                "    <key>HERDR_WEB_USER</key>\n    <string>{}</string>",
                xml_escape(&user)
            ));
        }
    }
    if let Ok(password) = std::env::var("HERDR_WEB_PASSWORD") {
        if !password.is_empty() {
            env_lines.push(format!(
                "    <key>HERDR_WEB_PASSWORD</key>\n    <string>{}</string>",
                xml_escape(&password)
            ));
        }
    }
    if let Ok(herdr_bin) = std::env::var("HERDR_WEB_HERDR_BIN") {
        if !herdr_bin.is_empty() {
            env_lines.push(format!(
                "    <key>HERDR_WEB_HERDR_BIN</key>\n    <string>{}</string>",
                xml_escape(&herdr_bin)
            ));
        }
    }
    let mut args = vec![
        format!(
            "    <string>{}</string>",
            xml_escape(&install_bin.display().to_string())
        ),
        "    <string>--bind</string>".to_string(),
        format!(
            "    <string>{}</string>",
            xml_escape(&config.bind.to_string())
        ),
    ];
    if let Some(session) = &config.session {
        args.push("    <string>--session</string>".to_string());
        args.push(format!("    <string>{}</string>", xml_escape(session)));
    }
    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
{env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>{stdout}</string>
  <key>StandardErrorPath</key>
  <string>{stderr}</string>
</dict>
</plist>
"#,
        label = INSTALL_LABEL,
        args = args.join("\n"),
        env = env_lines.join("\n"),
        stdout = xml_escape(&log_dir.join("stdout.log").display().to_string()),
        stderr = xml_escape(&log_dir.join("stderr.log").display().to_string())
    ))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn launchctl(args: &[&str]) -> io::Result<bool> {
    let status = Command::new("launchctl").args(args).status()?;
    Ok(status.success())
}

fn mac_domain() -> String {
    format!("gui/{}", unsafe { libc_getuid() })
}

#[cfg(unix)]
unsafe fn libc_getuid() -> u32 {
    unsafe extern "C" {
        fn getuid() -> u32;
    }
    getuid()
}

#[cfg(not(unix))]
unsafe fn libc_getuid() -> u32 {
    0
}

fn install_macos(config: WebConfig) -> io::Result<()> {
    let install_bin = copy_current_exe_to_install_path()?;
    let plist = install_plist_path()?;
    fs::create_dir_all(plist.parent().expect("plist has parent"))?;
    fs::create_dir_all(install_log_dir()?)?;
    fs::write(&plist, plist_xml(&config, &install_bin)?)?;
    let domain = mac_domain();
    let plist_arg = plist.display().to_string();
    let _ = launchctl(&["bootout", &domain, &plist_arg]);
    launchctl(&["bootstrap", &domain, &plist_arg])?;
    launchctl(&["kickstart", "-k", &format!("{domain}/{INSTALL_LABEL}")])?;
    println!("Installed {INSTALL_LABEL} at {}", plist.display());
    println!("Installed binary at {}", install_bin.display());
    println!("Open http://{}", config.bind);
    Ok(())
}

fn update_macos() -> io::Result<()> {
    let install_bin = copy_current_exe_to_install_path()?;
    let domain = mac_domain();
    if !launchctl(&["kickstart", "-k", &format!("{domain}/{INSTALL_LABEL}")])? {
        let plist = install_plist_path()?;
        launchctl(&["bootstrap", &domain, &plist.display().to_string()])?;
    }
    println!("Updated binary at {}", install_bin.display());
    println!("Restarted {INSTALL_LABEL}");
    Ok(())
}

fn uninstall_macos() -> io::Result<()> {
    let plist = install_plist_path()?;
    let domain = mac_domain();
    let _ = launchctl(&["bootout", &domain, &plist.display().to_string()]);
    if plist.exists() {
        fs::remove_file(&plist)?;
    }
    println!("Uninstalled {INSTALL_LABEL}");
    Ok(())
}

#[derive(Clone)]
struct WebState {
    api_socket: Option<PathBuf>,
    client_socket: Option<PathBuf>,
    session_name: Option<String>,
    herdr_bin: String,
    auth: Arc<AuthConfig>,
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

    fn backend_version(&self) -> Option<String> {
        let response = self
            .request_value(json!({ "id": "web:ping", "method": "ping", "params": {} }))
            .ok()?;
        response
            .get("result")
            .and_then(|result| result.get("version"))
            .and_then(|version| version.as_str())
            .map(str::to_string)
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
    fn load(bind: SocketAddr) -> io::Result<Self> {
        let user = std::env::var("HERDR_WEB_USER")
            .ok()
            .filter(|value| !value.is_empty());
        let password = std::env::var("HERDR_WEB_PASSWORD")
            .ok()
            .filter(|value| !value.is_empty());
        let localhost_no_auth = std::env::var("HERDR_WEB_LOCALHOST_NO_AUTH")
            .ok()
            .is_some_and(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "on"));
        let local_bind = bind.ip().is_loopback();
        if !local_bind && (user.is_none() || password.is_none()) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "HERDR_WEB_USER and HERDR_WEB_PASSWORD are required when binding non-local addresses",
            ));
        }
        if local_bind && !localhost_no_auth && (user.is_none() || password.is_none()) {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "set HERDR_WEB_USER/HERDR_WEB_PASSWORD or HERDR_WEB_LOCALHOST_NO_AUTH=true",
            ));
        }
        let seed = format!(
            "{}:{}:{}",
            user.as_deref().unwrap_or(""),
            password.as_deref().unwrap_or(""),
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
            user,
            password,
            localhost_no_auth,
            token,
        })
    }
}

#[tokio::main]
async fn main() -> io::Result<()> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if matches!(args.first().map(String::as_str), Some("--version" | "-V")) {
        println!("{HERDR_WEBUI_VERSION}");
        return Ok(());
    }
    if matches!(args.first().map(String::as_str), Some("install-mac")) {
        return install_macos(WebConfig::parse(&args[1..])?);
    }
    if matches!(args.first().map(String::as_str), Some("update-mac")) {
        return update_macos();
    }
    if matches!(args.first().map(String::as_str), Some("uninstall-mac")) {
        return uninstall_macos();
    }
    let config = WebConfig::parse(&args)?;
    let auth = Arc::new(AuthConfig::load(config.bind)?);
    let state = WebState {
        api_socket: config.api_socket.clone(),
        client_socket: config.client_socket.clone(),
        session_name: config.session.clone(),
        herdr_bin: std::env::var("HERDR_WEB_HERDR_BIN").unwrap_or_else(|_| "herdr".to_string()),
        auth,
        workspace_orders: Arc::new(Mutex::new(HashMap::new())),
    };

    let app = app_router(state);

    let listener = tokio::net::TcpListener::bind(config.bind).await?;
    eprintln!("herdr-webui listening on http://{}", config.bind);
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    .map_err(io::Error::other)
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
        .route("/api/path-suggestions", get(path_suggestions))
        .route("/api/git-branches", get(git_branches))
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
        .route("/api/pane-layout", get(pane_layout))
        .route("/api/agents", get(agents))
        .route("/assets/app.css", get(app_css))
        .route("/assets/app-core.js", get(app_core_js))
        .route("/assets/app.js", get(app_js))
        .route("/assets/login.css", get(login_css))
        .route("/assets/login.js", get(login_js))
        .route("/assets/xterm.js", get(xterm_js))
        .route("/assets/xterm.css", get(xterm_css))
        .route("/favicon.svg", get(favicon_svg))
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
    if remote.ip().is_loopback() && state.auth.localhost_no_auth {
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
        constant_time_eq(value.as_bytes(), state.auth.token.as_bytes())
    })
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[allow(clippy::result_large_err)]
fn require_auth(state: &WebState, headers: &HeaderMap, remote: SocketAddr) -> Result<(), Response> {
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
        Html(APP_HTML).into_response()
    } else {
        Html(LOGIN_HTML).into_response()
    }
}

async fn me(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    Json(json!({ "authenticated": authorized(&state, &headers, remote) })).into_response()
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
    let backend = api.backend_version();
    let compatibility = backend_compatibility(backend.as_deref());
    let compatibility_message = compatibility.message(backend.as_deref());
    Json(json!({
        "webui": HERDR_WEBUI_VERSION,
        "backend": backend,
        "session": session_display_name(session.as_deref()),
        "protocol_version": PROTOCOL_VERSION,
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
    if remote.ip().is_loopback() && state.auth.localhost_no_auth {
        return login_response(&state);
    }
    let ok = state
        .auth
        .user
        .as_deref()
        .zip(state.auth.password.as_deref())
        .is_some_and(|(user, password)| {
            constant_time_eq(body.username.as_bytes(), user.as_bytes())
                && constant_time_eq(body.password.as_bytes(), password.as_bytes())
        });
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
    let mut response = Json(json!({ "ok": true })).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{COOKIE_NAME}={}; HttpOnly; SameSite=Lax; Path=/",
            state.auth.token
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

async fn workspaces(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:workspace:list", "method": "workspace.list", "params": {} }),
    )
}

fn workspace_order_key(state: &WebState, headers: &HeaderMap) -> String {
    session_display_name(session_from_headers(state, headers).as_deref()).to_string()
}

fn open_created_worktree_request(cwd: &str, path: &str, label: Option<String>) -> serde_json::Value {
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
    if let (Some(cwd), Some(path), Some(branch)) = (&cwd, &path, body.branch.as_deref()) {
        let branch = branch.trim();
        if !branch.is_empty() {
            let base = body
                .base
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("HEAD");
            match create_worktree_checkout(cwd, path, branch, base) {
                Ok(()) => {
                    return proxy_request(
                        &api_for_headers(&state, &headers),
                        open_created_worktree_request(cwd, path, body.label),
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
    proxy_request(
        &api_for_headers(&state, &headers),
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
        }),
    )
}

fn run_git_capture(args: &[&str]) -> Result<std::process::Output, String> {
    Command::new("git")
        .args(args)
        .output()
        .map_err(|err| err.to_string())
}

fn git_failure(output: std::process::Output, context: &str) -> String {
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
struct PathSuggestionsQuery {
    prefix: Option<String>,
}

#[derive(Serialize)]
struct PathSuggestion {
    path: String,
    label: String,
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

fn expand_user_path_string(path: &str) -> String {
    expand_path_prefix(path).to_string_lossy().to_string()
}

fn display_path_for_prefix(path: &Path, prefix: &str) -> String {
    if prefix == "~" || prefix.starts_with("~/") {
        if let Ok(home) = home_dir() {
            if let Ok(rest) = path.strip_prefix(&home) {
                let rest = rest.to_string_lossy();
                return if rest.is_empty() {
                    "~".to_string()
                } else {
                    format!("~/{}", rest)
                };
            }
        }
    }
    if !prefix.starts_with('/') {
        if let Ok(home) = home_dir() {
            if let Ok(rest) = path.strip_prefix(&home) {
                return rest.to_string_lossy().to_string();
            }
        }
    }
    path.to_string_lossy().to_string()
}

fn directory_suggestions(prefix: &str) -> Vec<PathSuggestion> {
    let prefix = prefix.trim();
    let expanded = expand_path_prefix(prefix);
    let has_trailing_separator =
        prefix.ends_with('/') || prefix.ends_with(std::path::MAIN_SEPARATOR);
    let (dir, name_prefix) = if prefix.is_empty() {
        (
            home_dir()
                .unwrap_or_else(|_| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"))),
            String::new(),
        )
    } else if has_trailing_separator {
        (expanded, String::new())
    } else {
        (
            expanded
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| PathBuf::from(".")),
            expanded
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default(),
        )
    };
    let mut suggestions = Vec::new();
    let name_prefix_lower = name_prefix.to_lowercase();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return suggestions,
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !name_prefix_lower.is_empty() && !file_name.to_lowercase().contains(&name_prefix_lower) {
            continue;
        }
        if name_prefix.is_empty() && file_name.starts_with('.') {
            continue;
        }
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        suggestions.push(PathSuggestion {
            label: file_name,
            path: display_path_for_prefix(&path, prefix),
        });
        if suggestions.len() >= 30 {
            break;
        }
    }
    suggestions.sort_by(|a, b| a.label.cmp(&b.label));
    suggestions
}

async fn path_suggestions(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Query(query): Query<PathSuggestionsQuery>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    Json(json!({ "suggestions": directory_suggestions(query.prefix.as_deref().unwrap_or_default()) }))
        .into_response()
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

async fn create_workspace(
    State(state): State<WebState>,
    headers: HeaderMap,
    ConnectInfo(remote): ConnectInfo<SocketAddr>,
    Json(body): Json<CreateWorkspaceRequest>,
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:workspace:create", "method": "workspace.create", "params": { "cwd": body.cwd, "focus": false, "label": body.label, "env": {} } }),
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
) -> Response {
    if let Err(response) = require_auth(&state, &headers, remote) {
        return response;
    }
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:worktree:remove", "method": "worktree.remove", "params": { "workspace_id": workspace_id, "force": false } }),
    )
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

async fn xterm_js() -> Response {
    static_text(XTERM_JS, "application/javascript; charset=utf-8")
}

async fn xterm_css() -> Response {
    static_text(XTERM_CSS, "text/css; charset=utf-8")
}

async fn app_js() -> Response {
    static_text(APP_JS, "application/javascript; charset=utf-8")
}

async fn app_core_js() -> Response {
    static_text(APP_CORE_JS, "application/javascript; charset=utf-8")
}

async fn app_css() -> Response {
    static_text(APP_CSS, "text/css; charset=utf-8")
}

async fn login_js() -> Response {
    static_text(LOGIN_JS, "application/javascript; charset=utf-8")
}

async fn login_css() -> Response {
    static_text(LOGIN_CSS, "text/css; charset=utf-8")
}

fn static_text(body: &'static str, content_type: &'static str) -> Response {
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}

async fn favicon_svg() -> Response {
    let mut response = HERDR_LOGO.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("image/svg+xml; charset=utf-8"),
    );
    response
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
    ws.on_upgrade(move |socket| events_socket(api, socket))
}

async fn events_socket(api: ApiClient, mut socket: WebSocket) {
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
                {"type":"pane.created"}, {"type":"pane.closed"}, {"type":"pane.focused"}, {"type":"pane.moved"}, {"type":"pane.exited"}, {"type":"pane.agent_detected"}
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
        let Ok(mut stream) = connect_local_stream(&path) else {
            let _ = out_tx.send(b"failed to connect to herdr client socket\r\n".to_vec());
            return;
        };
        let hello = ClientMessage::Hello {
            version: PROTOCOL_VERSION,
            cols,
            rows,
            cell_width_px: 0,
            cell_height_px: 0,
            requested_encoding: RenderEncoding::TerminalAnsi,
            keybindings: ClientKeybindings::Server,
            launch_mode: ClientLaunchMode::TerminalAttach,
        };
        if write_message(&mut stream, &hello).is_err() {
            let _ = out_tx.send(b"failed to send herdr handshake\r\n".to_vec());
            return;
        }
        let Ok(ServerMessage::Welcome { error, .. }) =
            read_message::<_, ServerMessage>(&mut stream, MAX_FRAME_SIZE)
        else {
            let _ = out_tx.send(b"failed to read herdr handshake\r\n".to_vec());
            return;
        };
        if let Some(error) = error {
            let _ = out_tx
                .send(format!("herdr rejected terminal connection: {error}\r\n").into_bytes());
            return;
        }
        if write_message(
            &mut stream,
            &ClientMessage::AttachTerminal {
                terminal_id,
                takeover: true,
            },
        )
        .is_err()
        {
            let _ = out_tx.send(b"failed to attach herdr terminal\r\n".to_vec());
            return;
        }

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

fn write_message<W: Write, M: Serialize>(writer: &mut W, msg: &M) -> Result<(), String> {
    let payload = bincode::serde::encode_to_vec(msg, bincode::config::standard())
        .map_err(|err| err.to_string())?;
    let len = u32::try_from(payload.len()).map_err(|_| "payload too large".to_string())?;
    writer
        .write_all(&len.to_le_bytes())
        .map_err(|err| err.to_string())?;
    writer.write_all(&payload).map_err(|err| err.to_string())?;
    writer.flush().map_err(|err| err.to_string())
}

fn read_message<R: Read, M: for<'de> Deserialize<'de>>(
    reader: &mut R,
    max_frame_size: usize,
) -> Result<M, String> {
    let mut len_buf = [0u8; 4];
    reader
        .read_exact(&mut len_buf)
        .map_err(|err| err.to_string())?;
    let len = u32::from_le_bytes(len_buf) as usize;
    if len > max_frame_size {
        return Err(format!("frame size {len} exceeds maximum {max_frame_size}"));
    }
    let mut payload = vec![0u8; len];
    reader
        .read_exact(&mut payload)
        .map_err(|err| err.to_string())?;
    let (msg, consumed) = bincode::serde::decode_from_slice(&payload, bincode::config::standard())
        .map_err(|err| err.to_string())?;
    if consumed != len {
        return Err("trailing bytes in frame".into());
    }
    Ok(msg)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum RenderEncoding {
    SemanticFrame,
    TerminalAnsi,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum ClientKeybindings {
    Server,
    Local { keys_toml: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum ClientLaunchMode {
    App,
    TerminalAttach,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum ClientMessage {
    Hello {
        version: u32,
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
        requested_encoding: RenderEncoding,
        keybindings: ClientKeybindings,
        launch_mode: ClientLaunchMode,
    },
    Input {
        data: Vec<u8>,
    },
    ClipboardImage {
        extension: String,
        data: Vec<u8>,
    },
    Resize {
        cols: u16,
        rows: u16,
        cell_width_px: u32,
        cell_height_px: u32,
    },
    Detach,
    AttachTerminal {
        terminal_id: String,
        takeover: bool,
    },
    AttachScroll {
        source: AttachScrollSource,
        direction: AttachScrollDirection,
        lines: u16,
        column: Option<u16>,
        row: Option<u16>,
        modifiers: u8,
    },
    InputEvents {
        events: Vec<ClientInputEvent>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum AttachScrollDirection {
    Up,
    Down,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum AttachScrollSource {
    Wheel,
    PageKey { input: Vec<u8> },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum ClientInputEvent {
    Key {
        code: ClientKeyCode,
        modifiers: u8,
        kind: ClientKeyKind,
    },
    Mouse {
        kind: ClientMouseKind,
        column: u16,
        row: u16,
        modifiers: u8,
    },
    Paste {
        text: String,
    },
    FocusGained,
    FocusLost,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum ClientKeyKind {
    Press,
    Repeat,
    Release,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum ClientKeyCode {
    Backspace,
    Enter,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    Tab,
    BackTab,
    Delete,
    Insert,
    Esc,
    Char(char),
    F(u8),
    Null,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum ClientMouseButton {
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum ClientMouseKind {
    Down(ClientMouseButton),
    Up(ClientMouseButton),
    Drag(ClientMouseButton),
    Moved,
    ScrollUp,
    ScrollDown,
    ScrollLeft,
    ScrollRight,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CellData {
    symbol: String,
    fg: u32,
    bg: u32,
    modifier: u16,
    skip: bool,
    hyperlink: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct CursorState {
    x: u16,
    y: u16,
    visible: bool,
    #[serde(default)]
    shape: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FrameData {
    cells: Vec<CellData>,
    width: u16,
    height: u16,
    cursor: Option<CursorState>,
    hyperlinks: Vec<String>,
    graphics: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct TerminalFrame {
    seq: u64,
    width: u16,
    height: u16,
    full: bool,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum NotifyKind {
    Sound,
    Toast,
    SystemToast,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum ServerMessage {
    Welcome {
        version: u32,
        encoding: RenderEncoding,
        error: Option<String>,
    },
    Frame(FrameData),
    Terminal(TerminalFrame),
    Graphics {
        bytes: Vec<u8>,
    },
    ServerShutdown {
        reason: Option<String>,
    },
    Notify {
        kind: NotifyKind,
        message: String,
        body: Option<String>,
    },
    Clipboard {
        data: String,
    },
    WindowTitle {
        title: Option<String>,
    },
    ReloadSoundConfig,
    MouseCapture {
        enabled: bool,
    },
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
        WebState {
            api_socket: Some(PathBuf::from("/tmp/default-api.sock")),
            client_socket: Some(PathBuf::from("/tmp/default-client.sock")),
            session_name: None,
            herdr_bin: "herdr".to_string(),
            auth: Arc::new(AuthConfig {
                user: Some("user".to_string()),
                password: Some("pass".to_string()),
                localhost_no_auth: false,
                token: "token-123".to_string(),
            }),
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

    fn clear_auth_env() {
        std::env::remove_var("HERDR_WEB_USER");
        std::env::remove_var("HERDR_WEB_PASSWORD");
        std::env::remove_var("HERDR_WEB_LOCALHOST_NO_AUTH");
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
    fn escapes_xml_special_characters() {
        assert_eq!(xml_escape("<&>\"'"), "&lt;&amp;&gt;&quot;&apos;");
    }

    #[test]
    fn builds_plist_with_session_and_escaped_values() {
        let _guard = env_lock().lock().unwrap();
        let home = std::env::temp_dir().join(format!(
            "herdr-webui-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::env::set_var("HOME", &home);
        std::env::set_var("HERDR_WEB_LOCALHOST_NO_AUTH", "false");
        std::env::set_var("HERDR_WEB_USER", "a<&b");
        std::env::set_var("HERDR_WEB_PASSWORD", "p\"q");
        std::env::set_var("HERDR_WEB_HERDR_BIN", "/opt/herdr'");

        let config = WebConfig {
            bind: "127.0.0.1:8787".parse().unwrap(),
            session: Some("work&test".to_string()),
            api_socket: None,
            client_socket: None,
        };
        let plist = plist_xml(&config, Path::new("/tmp/herdr-webui&bin")).unwrap();

        assert!(plist.contains("<string>/tmp/herdr-webui&amp;bin</string>"));
        assert!(plist.contains("<string>work&amp;test</string>"));
        assert!(plist.contains("<string>a&lt;&amp;b</string>"));
        assert!(plist.contains("<string>p&quot;q</string>"));
        assert!(plist.contains("<string>/opt/herdr&apos;</string>"));
        assert!(plist.contains("Library/Logs/herdr-webui/stdout.log"));

        std::env::remove_var("HERDR_WEB_USER");
        std::env::remove_var("HERDR_WEB_PASSWORD");
        std::env::remove_var("HERDR_WEB_HERDR_BIN");
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
        let mut state = test_state();
        Arc::get_mut(&mut state.auth).unwrap().localhost_no_auth = true;

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
    fn loads_auth_with_localhost_bypass() {
        let _guard = env_lock().lock().unwrap();
        clear_auth_env();
        std::env::set_var("HERDR_WEB_LOCALHOST_NO_AUTH", "true");

        let auth = AuthConfig::load("127.0.0.1:8787".parse().unwrap()).unwrap();

        assert!(auth.localhost_no_auth);
        assert_eq!(auth.user, None);
        assert_eq!(auth.password, None);
        assert!(!auth.token.is_empty());

        clear_auth_env();
    }

    #[test]
    fn loads_auth_with_credentials() {
        let _guard = env_lock().lock().unwrap();
        clear_auth_env();
        std::env::set_var("HERDR_WEB_USER", "alice");
        std::env::set_var("HERDR_WEB_PASSWORD", "secret");

        let auth = AuthConfig::load("0.0.0.0:8787".parse().unwrap()).unwrap();

        assert_eq!(auth.user.as_deref(), Some("alice"));
        assert_eq!(auth.password.as_deref(), Some("secret"));
        assert!(!auth.localhost_no_auth);
        assert!(!auth.token.is_empty());

        clear_auth_env();
    }

    #[test]
    fn rejects_auth_without_credentials_when_required() {
        let _guard = env_lock().lock().unwrap();
        clear_auth_env();

        let local_err = match AuthConfig::load("127.0.0.1:8787".parse().unwrap()) {
            Ok(_) => panic!("expected localhost auth config to fail"),
            Err(err) => err,
        };
        let public_err = match AuthConfig::load("0.0.0.0:8787".parse().unwrap()) {
            Ok(_) => panic!("expected public auth config to fail"),
            Err(err) => err,
        };

        assert_eq!(local_err.kind(), io::ErrorKind::PermissionDenied);
        assert_eq!(public_err.kind(), io::ErrorKind::PermissionDenied);
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
    fn classifies_backend_compatibility() {
        assert_eq!(
            backend_compatibility(Some("0.6.9")),
            BackendCompatibility::TooOld
        );
        assert_eq!(
            backend_compatibility(Some("0.7.0")),
            BackendCompatibility::Compatible
        );
        assert_eq!(
            backend_compatibility(Some("0.7.1")),
            BackendCompatibility::UntestedNewer
        );
        assert_eq!(
            backend_compatibility(Some("bad")),
            BackendCompatibility::Unknown
        );
        assert_eq!(backend_compatibility(None), BackendCompatibility::Unknown);
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

    #[cfg(unix)]
    #[tokio::test]
    async fn versions_api_reports_backend_compatibility_from_fake_socket() {
        let (socket, handle) = fake_api_socket(json!({
            "id": "web:ping",
            "result": { "version": "0.7.0" }
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
                request(Method::GET, "/assets/app.js")
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
        assert!(app_body.contains("/assets/app-core.js"));
        assert!(app_body.contains("/assets/app.js"));
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
        let app_js = app
            .clone()
            .oneshot(
                request(Method::GET, "/assets/app.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let app_core_js = app
            .clone()
            .oneshot(
                request(Method::GET, "/assets/app-core.js")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let app_css = app
            .clone()
            .oneshot(
                request(Method::GET, "/assets/app.css")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let icon = app
            .oneshot(
                request(Method::GET, "/favicon.svg")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(js.status(), StatusCode::OK);
        assert_eq!(css.status(), StatusCode::OK);
        assert_eq!(app_js.status(), StatusCode::OK);
        assert_eq!(app_core_js.status(), StatusCode::OK);
        assert_eq!(app_css.status(), StatusCode::OK);
        assert_eq!(icon.status(), StatusCode::OK);
        assert!(js.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .contains("javascript"));
        assert!(css.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .contains("text/css"));
        assert!(app_js.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .contains("javascript"));
        assert!(app_core_js.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .contains("javascript"));
        assert!(app_css.headers()[header::CONTENT_TYPE]
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
            to_bytes(app_js.into_body(), 1024 * 1024)
                .await
                .unwrap()
                .len()
                > 1000
        );
        assert!(
            to_bytes(app_core_js.into_body(), 1024 * 1024)
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

const LOGIN_HTML: &str = include_str!("assets/login.html");
const APP_HTML: &str = include_str!("assets/app.html");
const LOGIN_CSS: &str = include_str!("assets/login.css");
const LOGIN_JS: &str = include_str!("assets/login.js");
const APP_CORE_JS: &str = include_str!("assets/app_core.js");
const APP_CSS: &str = include_str!("assets/app.css");
const APP_JS: &str = include_str!("assets/app.js");

const XTERM_CSS: &str = include_str!("assets/xterm.css");
const XTERM_JS: &str = include_str!("assets/xterm.min.js");
const HERDR_LOGO: &str = include_str!("assets/herdr-logo.svg");
