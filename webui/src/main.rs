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
        let token = format!("{:x}", Sha256::digest(seed.as_bytes()));
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
        .route("/session/:session", get(index))
        .route("/session/:session/workspace/:workspace_id", get(index))
        .route(
            "/session/:session/workspace/:workspace_id/tab/:tab_id",
            get(index),
        )
        .route(
            "/session/:session/workspace/:workspace_id/tab/:tab_id/pane/:pane_id",
            get(index),
        )
        .route("/workspace/:workspace_id", get(index))
        .route("/workspace/:workspace_id/tab/:tab_id", get(index))
        .route(
            "/workspace/:workspace_id/tab/:tab_id/pane/:pane_id",
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
        .route(
            "/api/workspaces/:workspace_id/rename",
            post(rename_workspace),
        )
        .route("/api/workspaces/:workspace_id/close", post(close_workspace))
        .route(
            "/api/workspaces/:workspace_id/worktree-remove",
            post(remove_worktree),
        )
        .route("/api/tabs", get(tabs).post(create_tab))
        .route("/api/tabs/:tab_id/rename", post(rename_tab))
        .route("/api/tabs/:tab_id/close", post(close_tab))
        .route("/api/panes", get(panes))
        .route("/api/pane-layout", get(pane_layout))
        .route("/api/agents", get(agents))
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
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({ "id": "web:worktree:list", "method": "worktree.list", "params": { "workspace_id": query.workspace_id } }),
    )
}

#[derive(Deserialize)]
struct CreateWorktreeRequest {
    workspace_id: Option<String>,
    branch: Option<String>,
    base: Option<String>,
    path: Option<String>,
    label: Option<String>,
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
    proxy_request(
        &api_for_headers(&state, &headers),
        json!({
            "id": "web:worktree:create",
            "method": "worktree.create",
            "params": {
                "workspace_id": body.workspace_id,
                "branch": body.branch,
                "base": body.base,
                "path": body.path,
                "label": body.label,
                "focus": true,
            },
        }),
    )
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
    let mut response = XTERM_JS.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/javascript; charset=utf-8"),
    );
    response
}

async fn xterm_css() -> Response {
    let mut response = XTERM_CSS.into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/css; charset=utf-8"),
    );
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
                if socket.send(Message::Text(value.to_string())).await.is_err() { break; }
            }
            _ = interval.tick() => {
                let agents = api.request_value(json!({ "id": "web:agent:list:poll", "method": "agent.list", "params": {} })).ok();
                let workspaces = api.request_value(json!({ "id": "web:workspace:list:poll", "method": "workspace.list", "params": {} })).ok();
                let value = json!({ "type": "snapshot", "agents": agents, "workspaces": workspaces });
                if socket.send(Message::Text(value.to_string())).await.is_err() { break; }
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
                if socket.send(Message::Binary(bytes)).await.is_err() { break; }
            }
            message = socket.recv() => {
                match message {
                    Some(Ok(Message::Binary(data))) => {
                        if in_tx.send(ClientMessage::Input { data }).is_err() { break; }
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
                            let _ = in_tx.send(ClientMessage::Input { data: text.into_bytes() });
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
            .oneshot(
                request(Method::GET, "/session/default/workspace/w1/tab/t1/pane/p1")
                    .header(header::COOKIE, "herdr_web_session=token-123")
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
        assert!(login_body.contains("Login"));
        assert!(app_body.contains("Herdr"));
        assert!(app_body.contains("optSoundScope"));
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
        assert_eq!(icon.status(), StatusCode::OK);
        assert!(js.headers()[header::CONTENT_TYPE]
            .to_str()
            .unwrap()
            .contains("javascript"));
        assert!(css.headers()[header::CONTENT_TYPE]
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

const LOGIN_HTML: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>herdr web login</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><style>
body{margin:0;background:#11111b;color:#cdd6f4;font-family:ui-sans-serif,system-ui;display:grid;place-items:center;height:100vh}form{background:#181825;border:1px solid #313244;border-radius:16px;padding:24px;display:grid;gap:12px;min-width:300px}.brand{display:flex;align-items:center;gap:12px;margin-bottom:4px}.brand img{width:38px;height:38px;border-radius:12px;background:#1e1e2e;border:1px solid #313244;padding:6px}.brand strong{display:block;font-size:22px;line-height:1}.brand span{display:block;color:#a6adc8;font-size:12px;margin-top:4px}input,button{font:inherit;border-radius:10px;border:1px solid #45475a;background:#1e1e2e;color:#cdd6f4;padding:10px}button{background:#89b4fa;color:#11111b;border:0;font-weight:700}p{color:#f38ba8;min-height:1.2em}</style></head><body><form id="login"><div class="brand"><img src="/favicon.svg" alt=""><div><strong>Herdr</strong><span>WebUI</span></div></div><input name="username" autocomplete="username" placeholder="user"><input name="password" type="password" autocomplete="current-password" placeholder="password"><button>Login</button><p id="error"></p></form><script>
login.onsubmit=async e=>{e.preventDefault();error.textContent='';const f=new FormData(login);const r=await fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:f.get('username'),password:f.get('password')})});if(r.ok) location.reload(); else error.textContent='login failed'};
</script></body></html>"#;

const APP_HTML: &str = r#"<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>herdr web</title><link rel="icon" href="/favicon.svg" type="image/svg+xml"><script src="/assets/xterm.js"></script><link rel="stylesheet" href="/assets/xterm.css"><style>
*{box-sizing:border-box}body{--bg:#11111b;--fg:#cdd6f4;--panel:#181825;--panel2:#1e1e2e;--border:#313244;--border2:#45475a;--muted:#a6adc8;--accent:#89b4fa;margin:0;background:var(--bg);color:var(--fg);font-family:ui-sans-serif,system-ui;height:100vh;overflow:hidden}body.light{--bg:#eff1f5;--fg:#4c4f69;--panel:#e6e9ef;--panel2:#ccd0da;--border:#bcc0cc;--border2:#9ca0b0;--muted:#6c6f85;--accent:#1e66f5}#app{display:grid;grid-template-columns:330px minmax(0,1fr);height:100vh;overflow:hidden}.side{border-right:1px solid var(--border);background:var(--panel);display:flex;flex-direction:column;min-width:0;overflow:hidden}.head{padding:14px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center}.head strong{flex:1}.btn{background:var(--accent);color:var(--bg);border:0;border-radius:8px;padding:7px 10px;font-weight:700}.mini{background:var(--border);color:var(--fg);border:1px solid var(--border2);border-radius:7px;padding:2px 6px;font-size:12px;margin-left:4px;cursor:pointer;line-height:1}.mini:hover{background:var(--border2)}.mini.danger{background:#3b2028;color:#ffccd5;border-color:#f38ba8}.mini.danger:hover{background:#5a2734}.mini.tree{background:#24342f;color:#a6e3a1;border-color:#74c7a3}.mini.tree:hover{background:#315044}.section{padding:10px;overflow:auto}.item{padding:8px;border-radius:10px;margin:4px 0;cursor:pointer;border:1px solid transparent}.item:hover,.item.active{background:var(--border);border-color:var(--border2)}.section-header{display:flex;align-items:center;gap:8px;margin:14px 0 8px 0;color:var(--fg);font-weight:800;font-size:13px;letter-spacing:.06em;text-transform:uppercase}.section-header:before,.section-header:after{content:"";height:1px;background:var(--border);flex:1}.repo-header{display:flex;align-items:center;gap:8px;margin:12px 0 4px 0;color:var(--fg);font-weight:700;font-size:12px}.repo-header:before{content:"";width:26px;height:1px;background:var(--border)}.repo-header:after{content:"";height:1px;background:var(--border);flex:1}.space-title{display:flex;align-items:center;gap:6px}.space-title .label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.space-actions{margin-left:auto;display:inline-flex;gap:2px}.muted{color:var(--muted);font-size:12px}.chip{display:inline-block;border:1px solid var(--border2);background:var(--panel2);color:var(--fg);border-radius:999px;padding:1px 6px;margin-left:4px;max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle}.chip.branch{border-color:#89b4fa;color:#89b4fa}.chip.repo{border-color:#fab387;color:#fab387}.chip.worktree{border-color:#a6e3a1;color:#a6e3a1}.agent-title,.agent-meta{display:flex;align-items:center;gap:6px;min-width:0}.agent-title span,.agent-meta span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.agent-status{background:transparent!important}.agent-status.idle{color:#40a02b}.agent-status.working{color:#df8e1d}.agent-status.blocked{color:#d20f39}.agent-status.unknown{color:var(--muted)}.agent-status.done{color:#1e66f5}.agent-name{color:var(--muted)}.tabs{flex:none;display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px;border-bottom:1px solid var(--border)}.tab{padding:6px 10px;border-radius:999px;background:var(--panel2);color:var(--fg);border:1px solid var(--border);cursor:pointer}.tab.active{background:var(--accent);color:var(--bg)}.tab.active .mini{color:var(--fg)}.tab.add{background:var(--border);color:var(--fg)}.tab-info{margin-left:auto;color:var(--muted);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:45%;padding-left:12px}.main{display:flex;flex-direction:column;min-width:0;min-height:0;overflow:hidden}.terminal-shell{position:relative;flex:1 1 auto;min-width:0;min-height:0;max-width:100%;max-height:100%;padding:8px;overflow:auto;background:var(--bg);scrollbar-gutter:stable both-edges}.terminal-shell.no-overflow{overflow:hidden}.terminal{display:block;width:max-content;height:max-content;min-width:max-content;min-height:max-content;white-space:nowrap}.terminal .xterm{display:block;min-width:max-content;min-height:max-content}.terminal .xterm-screen{display:block}.terminal .xterm-viewport{overflow:visible!important;height:100%!important}.modal-backdrop{position:fixed;inset:0;display:none;place-items:center;background:#0008;z-index:1100}.modal{background:var(--panel);border:1px solid var(--border2);border-radius:14px;padding:18px;min-width:320px;box-shadow:0 18px 50px #0008}.modal h2{margin:0 0 12px 0;font-size:18px}.option{display:flex;gap:10px;align-items:flex-start;margin:12px 0}.option span{display:block}.option small{display:block;color:var(--muted);margin-top:2px}.modal-actions{text-align:right;margin-top:14px}.settings-select{background:var(--panel2);color:var(--fg);border:1px solid var(--border2);border-radius:8px;padding:7px;min-width:140px}.context-menu{position:fixed;z-index:1000;display:none;background:var(--panel);border:1px solid var(--border2);border-radius:8px;box-shadow:0 8px 24px #0006;padding:4px}.context-menu button{display:block;width:120px;text-align:left;background:transparent;color:var(--fg);border:0;padding:7px 9px;border-radius:6px}.context-menu button:hover{background:var(--border)}.terminal-shell::-webkit-scrollbar{width:10px;height:10px}.terminal-shell::-webkit-scrollbar-thumb{background:var(--border2);border-radius:8px}.terminal-shell::-webkit-scrollbar-track{background:var(--panel)}.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;flex:none}.idle{background:#a6e3a1}.working{background:#f9e2af}.blocked{background:#f38ba8}.unknown{background:#6c7086}.done{background:#89b4fa}input{background:var(--panel2);color:var(--fg);border:1px solid var(--border2);border-radius:8px;padding:7px;width:100%}</style></head><body><div id="app"><aside class="side"><div class="head"><strong>herdr web</strong><button class="mini" id="themeToggle" title="Toggle theme">☾</button><button class="mini" id="shortcutsToggle" title="Shortcuts">?</button><button class="mini" id="settingsToggle" title="Settings">⚙</button><button class="btn" id="newWs">+ Workspace</button></div><div class="section"><div class="muted" id="versions">webui - · backend -</div><div id="workspaces"></div><div class="section-header">Agents</div><div id="agents"></div></div></aside><main class="main"><div class="tabs" id="tabs"></div><div class="terminal-shell" id="terminalShell"><div class="terminal-loading" id="terminalLoading"><span>Loading panel</span></div><div class="terminal" id="terminal"></div></div></main></div><div class="context-menu" id="clipboardMenu"><button id="copyMenu">Copy</button><button id="pasteMenu">Paste</button></div><div class="modal-backdrop" id="settingsModal"><div class="modal"><h2>Settings</h2><label class="option"><span>Default theme<small>Auto follows browser/system theme; if unavailable it uses light.</small></span><select class="settings-select" id="optTheme"><option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option></select></label><label class="option"><input type="checkbox" id="optOverflow"><span>Show terminal overflow scrollbars<small>Keep backend terminal size and use browser scrollbars when it overflows.</small></span></label><label class="option"><input type="checkbox" id="optFit"><span>Resize terminal to browser viewport<small>Ask Herdr to use browser-sized terminal dimensions instead of pane layout size.</small></span></label><label class="option"><span>Shift+Enter sequence<small>Try another mode if OpenCode does not insert a newline.</small></span><select class="settings-select" id="optShiftEnter"><option value="csi27">CSI 27;2;13~</option><option value="kitty">Kitty CSI 13;2u</option><option value="newline">Literal newline</option><option value="xterm">Xterm SS3 M</option></select></label><label class="option"><input type="checkbox" id="optSound"><span>Agent attention sounds<small>Play a browser sound when an agent needs attention.</small></span></label><div class="modal-actions"><button class="btn" id="settingsClose">Close</button></div></div></div><script>
let state={session:'default',sessions:[],workspaces:[],worktrees:[],workspaceBranches:{},workspaceOrder:[],dragWorkspace:null,tabs:[],allTabs:[],panes:[],agents:[],ws:null,tab:null,pane:null,terminalId:null,termCols:null,termRows:null,fitDefault:false,editingTab:null,editingTabValue:'',editingWorkspace:null,editingWorkspaceValue:''};let term,termWs,eventWs,hiddenTimer,refreshTimer,connectedTerminalId=null,connectedSize='',termScrollBound=false,audioCtx=null,audioUnlocked=false,knownAttention=null,lastAttentionSound=0,creatingDefaultWorkspace=false,refreshSeq=0,terminalFramePending=false,resizeFramePending=false,lastWorkspacesHtml='',lastAgentsHtml='',lastTabsHtml='',closeChordUntil=0;
const extraStyle=document.createElement('style');extraStyle.textContent='.terminal .xterm-screen{overflow:hidden!important}.terminal .xterm-rows{width:100%!important;height:100%!important;overflow:hidden!important}.terminal .xterm-rows>div{width:100%!important;overflow:hidden!important}.herdr-spinner{position:relative;display:inline-block;width:12px;height:12px;margin-right:6px;vertical-align:-2px;flex:none}.herdr-spinner i{position:absolute;width:3px;height:3px;border-radius:50%;background:#f9e2af;animation:herdr-orbit 2.4s linear infinite}.herdr-spinner i:nth-child(2){animation-delay:-.6s}.herdr-spinner i:nth-child(3){animation-delay:-1.2s}.herdr-spinner i:nth-child(4){animation-delay:-1.8s}@keyframes herdr-orbit{0%{transform:translate(0,0)}25%{transform:translate(9px,0)}50%{transform:translate(9px,9px)}75%{transform:translate(0,9px)}100%{transform:translate(0,0)}}.terminal-loading{position:absolute;inset:0;display:none;place-items:center;background:linear-gradient(135deg,color-mix(in srgb,var(--bg),transparent 4%),color-mix(in srgb,var(--panel),transparent 15%));z-index:5;color:var(--muted);font-weight:700;letter-spacing:.04em;pointer-events:none}.terminal-loading.show{display:grid}.terminal-loading span{display:inline-flex;align-items:center;gap:10px}.terminal-loading span:before{content:"";width:14px;height:14px;border:2px solid var(--border2);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.blocked-text{color:#f38ba8;font-size:12px;margin-right:4px}.agent-group-header{display:flex;align-items:center;gap:8px;margin:14px 0 6px 0;color:var(--fg);font-weight:700;font-size:12px;letter-spacing:.03em;text-transform:uppercase}.agent-group-header:after{content:"";height:1px;background:var(--border);flex:1}.tab{min-width:140px;display:inline-flex;align-items:center;justify-content:space-between;gap:8px}.tab.add{min-width:0;background:var(--accent);color:var(--bg);font-weight:800}.tab-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}.tab-actions{display:inline-flex;gap:2px;margin-left:8px}.tab-rename-input{width:120px;min-width:120px;background:var(--panel);color:var(--fg);border:1px solid var(--accent);border-radius:999px;padding:4px 8px}.workspace-rename-input{min-width:0;flex:1}.side-footer{margin-top:auto;padding:10px;border-top:1px solid var(--border)}.session-manager{display:none;position:absolute;inset:52px 0 0 0;z-index:20;background:var(--bg);padding:32px}.main{position:relative}.session-manager h1{margin:0 0 8px 0}.session-manager p{color:var(--muted)}.session-actions{display:grid;gap:12px;max-width:620px;margin-top:18px}.session-line{display:flex;align-items:center;justify-content:space-between;gap:16px;background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:14px}.session-line strong{display:block}.session-line small{display:block;color:var(--muted);margin-top:3px}.session-line .btn,.session-line .tab,.session-line .mini{white-space:nowrap}';document.head.appendChild(extraStyle);
const brandStyle=document.createElement('style');brandStyle.textContent='.head{padding:12px 14px}.brand{flex:1;min-width:0;display:flex;align-items:center;gap:10px}.brand img{width:34px;height:34px;border-radius:10px;background:var(--panel2);border:1px solid var(--border);padding:5px;flex:none}.brand-text{min-width:0;line-height:1.05}.brand-title{display:block;font-weight:800;letter-spacing:.01em}.brand-subtitle{display:block;color:var(--muted);font-size:11px;margin-top:3px;text-transform:uppercase;letter-spacing:.12em}';document.head.appendChild(brandStyle);
const headTitle=document.querySelector('.head strong');if(headTitle){const brand=document.createElement('div');brand.className='brand';brand.innerHTML='<img src="/favicon.svg" alt=""><div class="brand-text"><span class="brand-title">Herdr</span><span class="brand-subtitle">WebUI</span></div>';headTitle.replaceWith(brand)}
const layoutStyle=document.createElement('style');layoutStyle.textContent='.side .section{flex:1;min-height:0;display:flex;flex-direction:column;overflow:hidden;padding:0}.sidebar-split{flex:1;min-height:0;display:flex;flex-direction:column}.sidebar-pane{min-height:0;display:flex;flex-direction:column;padding:0 10px 8px}.sidebar-pane.workspaces-pane,.sidebar-pane.agents-pane{flex:1 1 50%}.sidebar-scroll{min-height:0;overflow:auto;padding-right:2px}.sidebar-actions{padding:8px 0 0}.sidebar-actions .btn{width:100%}.side-footer{flex:none}.head #newWs{display:none}.section-header{flex:none}';document.head.appendChild(layoutStyle);
const linkStyle=document.createElement('style');linkStyle.textContent='a.item,a.item:visited,a.item:hover,a.item:active{color:var(--fg);text-decoration:none}a.tab,a.tab:visited,a.tab:hover,a.tab:active{color:var(--fg);text-decoration:none}a.tab.active,a.tab.active:visited,a.tab.active:hover,a.tab.active:active{color:var(--bg)}a.item{display:block}a.tab{display:inline-flex}';document.head.appendChild(linkStyle);
const workspaceTreeStyle=document.createElement('style');workspaceTreeStyle.textContent='.workspace-child{position:relative;margin-left:26px!important}.workspace-child:before{content:"";position:absolute;left:-17px;top:-6px;width:14px;height:22px;border-left:1px solid var(--border2);border-bottom:1px solid var(--border2);border-bottom-left-radius:6px}.workspace-child:after{content:"";position:absolute;left:-17px;top:16px;bottom:-10px;border-left:1px solid var(--border);opacity:.5}.workspace-child.last:after{display:none}.workspace-group-main{margin-top:6px}.workspace-group-main+.workspace-child{margin-top:2px}.workspace-orphan-header{margin-top:10px}';document.head.appendChild(workspaceTreeStyle);
const dragStyle=document.createElement('style');dragStyle.textContent='.workspace-drag{opacity:.55}.workspace-drop{outline:1px dashed var(--accent);outline-offset:2px}';document.head.appendChild(dragStyle);
const branchChipStyle=document.createElement('style');branchChipStyle.textContent='.chip.branch{font-size:10px;line-height:1.1;padding:1px 5px;margin-left:3px;max-width:180px}';document.head.appendChild(branchChipStyle);
const sectionEl=document.querySelector('.side .section');if(sectionEl&&!el('workspacePane')){const versionsEl=el('versions'),workspacesEl=el('workspaces'),agentsEl=el('agents'),oldAgentsHeader=document.querySelector('.section-header'),newWsButton=el('newWs');const split=document.createElement('div');split.className='sidebar-split';const workspacePane=document.createElement('div');workspacePane.id='workspacePane';workspacePane.className='sidebar-pane workspaces-pane';workspacePane.innerHTML='<div class="section-header">Workspaces</div>';const workspaceScroll=document.createElement('div');workspaceScroll.className='sidebar-scroll';workspaceScroll.appendChild(workspacesEl);const workspaceActions=document.createElement('div');workspaceActions.className='sidebar-actions';workspaceActions.appendChild(newWsButton);workspacePane.appendChild(workspaceScroll);workspacePane.appendChild(workspaceActions);const agentsPane=document.createElement('div');agentsPane.className='sidebar-pane agents-pane';agentsPane.innerHTML='<div class="section-header">Agents</div>';const agentsScroll=document.createElement('div');agentsScroll.className='sidebar-scroll';agentsScroll.appendChild(agentsEl);agentsPane.appendChild(agentsScroll);if(oldAgentsHeader)oldAgentsHeader.remove();split.appendChild(workspacePane);split.appendChild(agentsPane);sectionEl.appendChild(split);if(versionsEl){versionsEl.classList.add('side-footer');document.querySelector('.side').appendChild(versionsEl)}}
const uxStyle=document.createElement('style');uxStyle.textContent='.modal-backdrop{backdrop-filter:blur(8px)}.modal{width:min(560px,calc(100vw - 32px));max-height:min(720px,calc(100vh - 32px));overflow:auto;padding:0}.settings-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 20px 12px;border-bottom:1px solid var(--border)}.settings-head h2{margin:0}.settings-head p{margin:5px 0 0;color:var(--muted);font-size:13px}.settings-close{font-size:16px;padding:5px 9px}.settings-body{padding:10px 20px 16px}.option{background:var(--panel2);border:1px solid var(--border);border-radius:12px;padding:12px}.option:hover{border-color:var(--border2)}.option input[type=checkbox]{width:auto;margin-top:2px}.option select{margin-left:auto}.modal-actions{position:sticky;bottom:0;background:linear-gradient(180deg,transparent,var(--panel) 18%);padding:16px 20px 20px}.session-manager{padding:0;background:linear-gradient(135deg,var(--bg),var(--panel))}.session-card{margin:32px auto;max-width:880px;border:1px solid var(--border);border-radius:18px;background:color-mix(in srgb,var(--panel),transparent 8%);box-shadow:0 20px 80px #0006;overflow:hidden}.session-hero{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:24px;border-bottom:1px solid var(--border);background:linear-gradient(135deg,color-mix(in srgb,var(--accent),transparent 88%),transparent)}.session-hero h1{margin:0}.session-hero p{margin:6px 0 0}.session-current{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border2);background:var(--panel2);border-radius:999px;padding:8px 12px;font-weight:700;white-space:nowrap}.session-actions{max-width:none;margin:0;padding:18px}.session-list{display:grid;gap:10px}.session-line{transition:border-color .15s,background .15s,transform .15s}.session-line:hover{transform:translateY(-1px);border-color:var(--accent)}.session-line.active{border-color:var(--accent);background:color-mix(in srgb,var(--accent),transparent 88%)}.session-line>span:first-child{min-width:0}.session-line strong{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.session-controls{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.status-pill{display:inline-flex;align-items:center;border-radius:999px;border:1px solid var(--border2);padding:4px 8px;font-size:12px;font-weight:700}.status-pill.running{color:#40a02b}.status-pill.offline{color:var(--muted)}.session-new{margin-top:14px}.session-new .btn{white-space:nowrap}';document.head.appendChild(uxStyle);
const worktreeStyle=document.createElement('style');worktreeStyle.textContent='.worktree-form{display:grid;gap:12px;padding:16px 20px}.worktree-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.worktree-form label{display:grid;gap:6px;color:var(--muted);font-size:12px}.worktree-form input{font-size:14px}.worktree-source{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--border);background:var(--panel2);border-radius:999px;padding:6px 10px;color:var(--fg);width:max-content;max-width:100%}.worktree-error{min-height:18px;color:#f38ba8;font-size:13px}.mini.tree{font-weight:800}';document.head.appendChild(worktreeStyle);
const shortcutsStyle=document.createElement('style');shortcutsStyle.textContent='.shortcuts-list{display:grid;gap:8px;padding:14px 20px 4px}.shortcut-row{display:grid;grid-template-columns:120px 1fr;gap:12px;align-items:center;padding:9px 0;border-bottom:1px solid var(--border)}.shortcut-row:last-child{border-bottom:0}.shortcut-row kbd{justify-self:start;background:var(--panel2);border:1px solid var(--border2);border-bottom-width:2px;border-radius:7px;padding:3px 7px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg)}';document.head.appendChild(shortcutsStyle);
if(!el('worktreeCreateModal'))document.body.insertAdjacentHTML('beforeend','<div class="modal-backdrop" id="worktreeCreateModal"><div class="modal"><div class="settings-head"><div><h2>Create worktree</h2><p>Creates a linked Git worktree from selected parent workspace and opens it.</p></div><button class="mini settings-close" id="worktreeCreateClose" title="Close">✕</button></div><form class="worktree-form" id="worktreeCreateForm"><div class="worktree-source" id="worktreeCreateSource">source workspace</div><div class="worktree-grid"><label>Branch<input id="worktreeBranch" placeholder="worktree/my-branch" required></label><label>Base<input id="worktreeBase" value="HEAD" placeholder="HEAD"></label></div><div class="worktree-grid"><label>Label<input id="worktreeLabel" placeholder="optional"></label><label>Path<input id="worktreePath" placeholder="optional absolute path"></label></div><div class="worktree-error" id="worktreeCreateError"></div><div class="modal-actions"><button type="button" class="tab add" id="worktreeCreateCancel">Cancel</button><button class="btn" id="worktreeCreateSubmit">Create and open</button></div></form></div></div>');
if(!el('shortcutsModal'))document.body.insertAdjacentHTML('beforeend','<div class="modal-backdrop" id="shortcutsModal"><div class="modal"><div class="settings-head"><div><h2>Shortcuts</h2><p>Browser/WebUI shortcuts. Terminal apps may handle their own keybindings inside the pane.</p></div><button class="mini settings-close" id="shortcutsCloseTop" title="Close">✕</button></div><div class="shortcuts-list"><div class="shortcut-row"><kbd id="closeShortcutCurrent">Disabled</kbd><span>Close current Herdr panel. Configure in Settings.</span></div><div class="shortcut-row"><kbd>Shift+Enter</kbd><span>Send configured newline sequence to terminal.</span></div><div class="shortcut-row"><kbd>PageUp/PageDown</kbd><span>Scroll Herdr terminal backend.</span></div><div class="shortcut-row"><kbd>Option+Wheel</kbd><span>Scroll browser overflow instead of terminal backend.</span></div><div class="shortcut-row"><kbd>Cmd/Ctrl+C</kbd><span>Copy selected terminal text.</span></div><div class="shortcut-row"><kbd>Cmd/Ctrl+V</kbd><span>Paste clipboard into terminal.</span></div><div class="shortcut-row"><kbd>Double-click</kbd><span>Rename workspaces and panels.</span></div><div class="shortcut-row"><kbd>Cmd/Middle-click</kbd><span>Open workspace, agent, or panel link using browser tab behavior.</span></div></div><div class="modal-actions"><button class="btn" id="shortcutsClose">Close</button></div></div></div>');
const settingsModal=el('settingsModal');if(settingsModal&&!settingsModal.dataset.ux){const modal=settingsModal.querySelector('.modal');const heading=modal&&modal.querySelector('h2');if(modal&&heading){const head=document.createElement('div');head.className='settings-head';head.innerHTML='<div><h2>Settings</h2><p>Browser-local preferences for terminal, theme, and agent behavior.</p></div><button class="mini settings-close" id="settingsCloseTop" title="Close">✕</button>';heading.replaceWith(head);const body=document.createElement('div');body.className='settings-body';[...modal.querySelectorAll('label.option')].forEach(node=>body.appendChild(node));modal.insertBefore(body,modal.querySelector('.modal-actions'));el('settingsCloseTop').onclick=()=>{settingsModal.style.display='none'}}settingsModal.dataset.ux='1'}
const themes={dark:{background:'#11111b',foreground:'#cdd6f4'},light:{background:'#eff1f5',foreground:'#4c4f69'}};function normalizeThemeMode(value){if(value==='night')return 'dark';if(value==='day')return 'light';return ['auto','light','dark'].includes(value)?value:'auto'}let themeMode=normalizeThemeMode(localStorage.getItem('herdr-web-theme')),lastEffectiveTheme=null;
let options=JSON.parse(localStorage.getItem('herdr-web-options')||'{"overflow":true,"fitToBrowser":false,"sound":true,"soundScope":"current","shiftEnter":"csi27","closeShortcut":"off","sortAgentsByStatus":false,"workspaceSort":"default","scrollLines":3}');if(!options.shiftEnter)options.shiftEnter='csi27';if(options.captureCmdW===true||options.closeShortcut===true)options.closeShortcut='altw';if(!['off','altw','shiftspacew'].includes(options.closeShortcut))options.closeShortcut='off';if(options.sortAgentsByStatus===undefined)options.sortAgentsByStatus=false;if(!['all','current'].includes(options.soundScope))options.soundScope='current';if(!['default','drag','state'].includes(options.workspaceSort))options.workspaceSort='default';options.scrollLines=Math.max(1,Math.min(20,Number(options.scrollLines)||3));
function saveOptions(){localStorage.setItem('herdr-web-options',JSON.stringify(options))}
const shiftEnterSetting=el('optShiftEnter');if(shiftEnterSetting&&!el('optSortAgents'))shiftEnterSetting.closest('label').insertAdjacentHTML('afterend','<label class="option"><span>Close panel shortcut<small>Stored in browser storage and available after reopening the tab.</small></span><select class="settings-select" id="optCloseShortcut"><option value="off">Disabled</option><option value="altw">Option+W</option><option value="shiftspacew">Shift+Space then W</option></select></label><label class="option"><input type="checkbox" id="optSortAgents"><span>Sort agents by attention<small>Blocked first, then done, unknown, idle, working.</small></span></label><label class="option"><span>Workspace sorting<small>Default tree order, shared drag-and-drop order, or attention state priority.</small></span><select class="settings-select" id="optWorkspaceSort"><option value="default">Default</option><option value="drag">Drag&drop</option><option value="state">State</option></select></label><label class="option"><span>Notification scope<small>Choose whether sounds ring in every open tab or only the tab viewing the agent panel.</small></span><select class="settings-select" id="optSoundScope"><option value="current">Current agent tab</option><option value="all">All tabs</option></select></label><label class="option"><span>Scroll speed<small><span id="scrollLinesValue">3</span> terminal lines per wheel step.</small></span><input type="range" id="optScrollLines" min="1" max="20" step="1"></label>');
function applyOptions(){const shell=el('terminalShell');if(shell)shell.classList.toggle('no-overflow',!options.overflow);const overflow=el('optOverflow'),fitOpt=el('optFit'),sound=el('optSound'),themeSelect=el('optTheme'),shiftEnter=el('optShiftEnter'),closeShortcut=el('optCloseShortcut'),sortAgents=el('optSortAgents'),workspaceSort=el('optWorkspaceSort'),soundScope=el('optSoundScope'),scrollLines=el('optScrollLines'),scrollLinesValue=el('scrollLinesValue'),closeShortcutCurrent=el('closeShortcutCurrent');if(overflow)overflow.checked=!!options.overflow;if(fitOpt)fitOpt.checked=!!options.fitToBrowser;if(sound)sound.checked=!!options.sound;if(themeSelect)themeSelect.value=themeMode;if(shiftEnter)shiftEnter.value=options.shiftEnter||'csi27';if(closeShortcut)closeShortcut.value=options.closeShortcut||'off';if(closeShortcutCurrent)closeShortcutCurrent.textContent=closeShortcutLabel();if(sortAgents)sortAgents.checked=!!options.sortAgentsByStatus;if(workspaceSort)workspaceSort.value=options.workspaceSort||'default';if(soundScope)soundScope.value=options.soundScope||'current';if(scrollLines)scrollLines.value=String(options.scrollLines||3);if(scrollLinesValue)scrollLinesValue.textContent=String(options.scrollLines||3);fitTerminalShell();if(options.fitToBrowser){const fit=browserTerminalSize();if(fit){state.termCols=fit.cols;state.termRows=fit.rows;connectTerminal()}}}
function closeShortcutLabel(){if(options.closeShortcut==='altw')return 'Option+W';if(options.closeShortcut==='shiftspacew')return 'Shift+Space, W';return 'Disabled'}
function effectiveTheme(){if(themeMode==='dark')return 'dark';if(themeMode==='light')return 'light';if(window.matchMedia)return window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';return 'light'}
function terminalTheme(){return themes[effectiveTheme()]||themes.light}
function shiftEnterSequence(){const mode=options.shiftEnter||'csi27';if(mode==='kitty')return '\x1b[13;2u';if(mode==='newline')return '\n';if(mode==='xterm')return '\x1bOM';return '\x1b[27;2;13~'}
function applyTheme(){themeMode=normalizeThemeMode(themeMode);const current=effectiveTheme();lastEffectiveTheme=current;const light=current==='light';document.body.classList.toggle('light',light);const toggle=el('themeToggle');if(toggle){toggle.textContent=themeMode==='auto'?'A':(themeMode==='dark'?'☾':'☀');toggle.title='Theme: '+themeMode+' ('+current+')'}const themeSelect=el('optTheme');if(themeSelect)themeSelect.value=themeMode;localStorage.setItem('herdr-web-theme',themeMode);if(term){try{term.options.theme=terminalTheme()}catch(e){try{term.setOption('theme',terminalTheme())}catch(_){}}}fitTerminalShell()}
function pollAutoTheme(){if(themeMode!=='auto')return;const current=effectiveTheme();if(current!==lastEffectiveTheme)applyTheme()}
function el(id){return document.getElementById(id)}
function setupSessionChrome(){const head=document.querySelector('.head');if(!el('sessionButton')){const b=document.createElement('button');b.className='mini';b.id='sessionButton';b.title='Session manager';b.textContent='session';head.insertBefore(b,el('themeToggle'));b.onclick=()=>showSessionManager(state.backendOnline?'Session manager':'Herdr session offline')}const side=document.querySelector('.side');const versionsEl=el('versions');if(versionsEl&&!versionsEl.classList.contains('side-footer')){versionsEl.remove();versionsEl.classList.add('side-footer');side.appendChild(versionsEl)}if(!el('sessionManager')){const m=document.createElement('div');m.className='session-manager';m.id='sessionManager';m.innerHTML='<div class="session-card"><div class="session-hero"><div><h1 id="sessionManagerTitle">Sessions</h1><p id="sessionManagerText">Choose a Herdr backend session to open.</p></div><div class="session-current"><span class="dot unknown"></span><span id="sessionCurrentLabel">default</span></div></div><div class="session-actions"><div class="session-list" id="sessionList"></div><div class="session-line session-new"><span><strong>Target another session</strong><small>Create or open a named target URL. Launch starts backend for current target.</small></span><span class="session-controls"><button class="btn" id="newSessionTarget">New target</button></span></div></div></div>';document.querySelector('.main').prepend(m);el('newSessionTarget').onclick=()=>{const name=prompt('session name');if(name)goSession(name)}}}
async function loadSessions(){try{const r=await api('/api/sessions');state.sessions=r.sessions||[]}catch(e){state.sessions=[{name:state.session||'default',running:false}]}}
function renderSessionRows(){const list=state.sessions.length?state.sessions:[{name:state.session||'default',running:state.backendOnline}];return list.map(s=>{const active=s.name===state.session;const status=`<span class="status-pill ${s.running?'running':'offline'}">${s.running?'running':'offline'}</span>`;const controls=active?`<span class="session-controls"><button class="btn" onclick="event.stopPropagation();launchBackend()">Launch</button><button class="tab add" onclick="event.stopPropagation();refresh()">Retry</button><button class="tab add" onclick="event.stopPropagation();resetSession()">Reset workspaces</button><button class="mini danger" onclick="event.stopPropagation();closeCurrentSession()">Close</button></span>`:`<span class="session-controls">${status}</span>`;return `<div class="session-line ${active?'active':''}" onclick="goSession('${escapeAttr(s.name)}')"><span><strong>${escapeHtml(s.name)}</strong><small>${active?'current browser target':(s.running?'click to switch to this running session':'click to target this offline session')}</small></span>${controls}</div>`}).join('')}
async function showSessionManager(title,text){await loadSessions();const titleEl=el('sessionManagerTitle'),textEl=el('sessionManagerText'),manager=el('sessionManager'),list=el('sessionList'),current=el('sessionCurrentLabel');if(titleEl)titleEl.textContent=title||'Session manager';if(textEl)textEl.textContent=text||`Current target: ${state.session||'default'}`;if(current)current.textContent=state.session||'default';if(list)list.innerHTML=renderSessionRows();if(manager)manager.style.display='block'}
function hideSessionManager(){const manager=el('sessionManager');if(manager)manager.style.display='none'}
async function launchBackend(){const textEl=el('sessionManagerText');if(textEl)textEl.textContent='Launching Herdr session...';try{const r=await api('/api/session/launch',{method:'POST'});if(textEl)textEl.textContent=r.ok?`Launched pid ${r.pid}. Waiting for backend...`:(r.error||'Launch failed');setTimeout(refresh,1200)}catch(e){if(textEl)textEl.textContent=e.message||String(e)}}
async function closeCurrentSession(){if(!confirm('Close current Herdr session?'))return;try{await api('/api/session/close',{method:'POST'});showSessionManager('Herdr session closed','Session stopped. You can launch it again.');setTimeout(refresh,800)}catch(e){showSessionManager('Close failed',e.message||String(e))}}
async function resetSession(){if(!confirm('Close all workspaces in this session?'))return;for(const w of [...state.workspaces]){try{await api(`/api/workspaces/${encodeURIComponent(w.workspace_id)}/close`,{method:'POST'})}catch(e){}}state.ws=null;state.tab=null;state.pane=null;refresh()}
const statusClass=s=>s==='done'?'done':(s||'unknown');
function statusMark(status,withText=false){const s=statusClass(status);if(s==='working')return '<span class="herdr-spinner" aria-label="working"><i></i><i></i><i></i><i></i></span>';if(s==='blocked')return withText?'<span class="blocked-text">blocked</span>':'';return ''}
function statusDot(status){const s=statusClass(status);if(s==='working')return '<span class="dot working"></span>';if(s==='blocked')return '<span class="dot blocked"></span>';if(s==='idle'||s==='done')return `<span class="dot ${s==='done'?'done':'idle'}"></span>`;return '<span class="dot unknown"></span>'}
function apiOptions(opt){const next=Object.assign({},opt||{});next.headers=Object.assign({},next.headers||{},state.session&&state.session!=='default'?{'x-herdr-session':state.session}:{});return next}
async function api(url,opt){const r=await fetch(url,apiOptions(opt));if(r.status===401){location.href='/';throw Error('unauthorized')}const body=await r.json();if(!r.ok||body.error)throw Error(body.error||r.statusText);return body}
async function loadVersions(){const versionsEl=el('versions');try{const v=await api('/api/versions');const session=v.session||state.session||'default';const compat=v.compatibility||{},status=compat.status&&compat.status!=='compatible'?' · '+compat.status:'';if(versionsEl){versionsEl.textContent=`session ${session} · webui ${v.webui||'-'} · backend ${v.backend||'offline'}${status}`;versionsEl.title=compat.message||''}const button=el('sessionButton');if(button)button.textContent=state.session||session}catch(e){if(versionsEl)versionsEl.textContent='webui - · backend offline'}}
function sessionPrefix(){return '/session/'+encodeURIComponent(state.session||'default')}
function expandScopedId(ws,id){if(!ws||!id)return id||null;return `${ws}:${id}`}
function compactScopedId(ws,id){if(!ws||!id)return id||null;const prefix=`${ws}:`;return id.startsWith(prefix)?id.slice(prefix.length):id}
function selectionPath(ws,tab,pane){let p=sessionPrefix()+'/workspace/'+encodeURIComponent(ws);if(tab)p+='/tab/'+encodeURIComponent(compactScopedId(ws,tab));if(pane)p+='/pane/'+encodeURIComponent(compactScopedId(ws,pane));return p}
function parseRoute(){const p=location.pathname.split('/').filter(Boolean).map(decodeURIComponent);let i=0;state.session='default';if(p[0]==='session'){state.session=p[1]||'default';i=2}state.ws=p[i]==='workspace'?p[i+1]:null;state.tab=p[i+2]==='tab'?expandScopedId(state.ws,p[i+3]):null;state.pane=p[i+4]==='pane'?expandScopedId(state.ws,p[i+5]):null}
function setTerminalLoading(show){const loading=el('terminalLoading');if(loading)loading.classList.toggle('show',!!show)}
function resetTerminalConnection(clear=false){if(termWs){termWs.onclose=null;try{termWs.close()}catch(e){}termWs=null}connectedTerminalId=null;connectedSize='';if(clear&&term)term.clear()}
function openSelection(e,ws,tab,pane){if(e&&(e.metaKey||e.ctrlKey)){window.open(selectionPath(ws,tab,pane),'herdr-selection');return}go(ws,tab,pane)}
function navigateSelection(e,ws,tab,pane){if(e&&(e.metaKey||e.ctrlKey||e.shiftKey||e.button===1))return true;e.preventDefault();go(ws,tab,pane);return false}
function go(ws,tab,pane){history.pushState(null,'',selectionPath(ws,tab,pane));parseRoute();resetTerminalConnection(true);setTerminalLoading(true);refresh()}
function goSession(name){state.session=name||'default';state.ws=null;state.tab=null;state.pane=null;resetTerminalConnection(true);setTerminalLoading(true);if(eventWs){eventWs.onclose=null;try{eventWs.close()}catch(e){}eventWs=null}history.pushState(null,'',sessionPrefix());parseRoute();loadVersions();refresh();connectEvents()}
async function refreshOnline(seq){
parseRoute();
const w=await api('/api/workspaces');
if(seq!==refreshSeq)return;
state.workspaces=w.result.workspaces||[];
if(state.workspaces.length===0&&!creatingDefaultWorkspace){
creatingDefaultWorkspace=true;
try{const r=await api('/api/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label:'default',cwd:null})});if(seq!==refreshSeq)return;state.ws=r.result.workspace.workspace_id;state.fitDefault=true;history.replaceState(null,'',selectionPath(state.ws));creatingDefaultWorkspace=false;return refresh()}catch(e){creatingDefaultWorkspace=false}
}
if(state.ws&&!state.workspaces.some(w=>w.workspace_id===state.ws)){
resetTerminalConnection(true);setTerminalLoading(false);state.ws=(state.workspaces[0]||{}).workspace_id||null;state.tab=null;state.pane=null;state.terminalId=null;if(state.ws)history.replaceState(null,'',selectionPath(state.ws));else history.replaceState(null,'',sessionPrefix())
}
const worktreeSources=state.workspaces.map(ws=>ws.workspace_id);
const worktreeResults=await Promise.all(worktreeSources.map(id=>api('/api/worktrees?workspace_id='+encodeURIComponent(id)).catch(()=>null)));
if(seq!==refreshSeq)return;
state.worktrees=worktreeResults.flatMap(r=>(((r||{}).result||{}).worktrees)||[]);
state.workspaceBranches={};
for(const r of worktreeResults){const result=(r||{}).result||{},source=result.source||{},sourceId=source.source_workspace_id,sourcePath=source.source_checkout_path;if(!sourceId||!sourcePath)continue;const match=(result.worktrees||[]).find(wt=>samePath(wt.path,sourcePath));if(match&&(match.branch||match.is_detached))state.workspaceBranches[sourceId]=match.branch||(match.is_detached?'detached':'')}
try{const order=await api('/api/workspace-order');if(seq!==refreshSeq)return;state.workspaceOrder=order.order||[]}catch(e){state.workspaceOrder=[]}
if(!state.ws&&state.workspaces[0])state.ws=state.workspaces[0].workspace_id;
if(state.ws){
const [allT,t,p,a]=await Promise.all([api('/api/tabs'),api('/api/tabs?workspace_id='+encodeURIComponent(state.ws)),api('/api/panes?workspace_id='+encodeURIComponent(state.ws)),api('/api/agents')]);
if(seq!==refreshSeq)return;
state.allTabs=allT.result.tabs||[];state.tabs=t.result.tabs||[];state.panes=p.result.panes||[];state.agents=a.result.agents||[];
handleAttentionSound();
if(!state.tabs.some(t=>t.tab_id===state.tab)){const focused=state.tabs.find(t=>t.focused);state.tab=(focused||state.tabs[0]||{}).tab_id||null}
if(!state.panes.some(p=>p.pane_id===state.pane)){const pane=state.panes.find(x=>x.tab_id===state.tab&&x.focused)||state.panes.find(x=>x.tab_id===state.tab)||state.panes[0];state.pane=pane&&pane.pane_id}
const pane=state.panes.find(x=>x.pane_id===state.pane);state.terminalId=pane&&pane.terminal_id;state.termCols=null;state.termRows=null;
if(state.pane){try{const l=await api('/api/pane-layout?pane_id='+encodeURIComponent(state.pane));if(seq!==refreshSeq)return;const lp=((l.result||{}).layout||{}).panes||[];const selected=lp.find(x=>x.pane_id===state.pane);if(selected&&selected.rect){state.termCols=Math.max(1,selected.rect.width);state.termRows=Math.max(1,selected.rect.height)}}catch(e){}}
if(state.fitDefault||options.fitToBrowser){const fit=browserTerminalSize();if(fit){state.termCols=fit.cols;state.termRows=fit.rows;state.fitDefault=false}}
if((location.pathname==='/'||location.pathname==='/session'||location.pathname==='/session/'+encodeURIComponent(state.session))&&state.ws)history.replaceState(null,'',selectionPath(state.ws,state.tab,state.pane));
}
render();connectTerminal()
}
async function refresh(){const seq=++refreshSeq;try{await refreshOnline(seq);if(seq!==refreshSeq)return;state.backendOnline=true;hideSessionManager();const button=el('sessionButton');if(button)button.textContent=state.session||'default'}catch(e){state.backendOnline=false;state.workspaces=[];state.tabs=[];state.panes=[];state.agents=[];render();showSessionManager('Herdr session offline',`No backend reachable for session ${state.session||'default'}: ${e.message||e}`);const button=el('sessionButton');if(button)button.textContent=(state.session||'default')+' offline'}}
function scheduleRefresh(){clearTimeout(refreshTimer);refreshTimer=setTimeout(refresh,500)}
function applySnapshot(msg){const wr=msg.workspaces&&msg.workspaces.result;const ar=msg.agents&&msg.agents.result;if(wr&&wr.workspaces)state.workspaces=wr.workspaces;if(ar&&ar.agents){state.agents=ar.agents;handleAttentionSound()}render()}
function unlockAudio(){if(audioUnlocked)return;try{audioCtx=audioCtx||new (window.AudioContext||window.webkitAudioContext)();audioCtx.resume();audioUnlocked=true}catch(e){}}
function handleAttentionSound(){const attentionAgents=state.agents.filter(needsAttention);const current=new Set(attentionAgents.map(agentKey));if(knownAttention===null){knownAttention=current;return}const newlyAttentioned=attentionAgents.filter(a=>!knownAttention.has(agentKey(a)));knownAttention=current;if(newlyAttentioned.length&&shouldPlayAttentionSound(newlyAttentioned))playAttentionSound()}
function needsAttention(a){const s=statusClass(a.agent_status);return s==='blocked'||s==='done'}
function agentKey(a){return a.terminal_id||`${a.workspace_id}:${a.tab_id}:${a.pane_id}`}
function shouldPlayAttentionSound(agents){if((options.soundScope||'current')==='all')return true;return agents.some(a=>a.workspace_id===state.ws&&a.tab_id===state.tab&&a.pane_id===state.pane)}
function playAttentionSound(){if(!options.sound||!audioUnlocked)return;const now=Date.now();if(now-lastAttentionSound<1500)return;lastAttentionSound=now;if(!audioCtx||audioCtx.state!=='running')return;const o=audioCtx.createOscillator();const g=audioCtx.createGain();o.type='sine';o.frequency.setValueAtTime(880,audioCtx.currentTime);o.frequency.setValueAtTime(660,audioCtx.currentTime+0.08);g.gain.setValueAtTime(0.0001,audioCtx.currentTime);g.gain.exponentialRampToValueAtTime(0.12,audioCtx.currentTime+0.01);g.gain.exponentialRampToValueAtTime(0.0001,audioCtx.currentTime+0.22);o.connect(g);g.connect(audioCtx.destination);o.start();o.stop(audioCtx.currentTime+0.24)}
function tabTitle(t){return t.label||`tab ${t.number}`}
function render(){const wsById=Object.fromEntries(state.workspaces.map(w=>[w.workspace_id,w]));const tabById=Object.fromEntries(state.allTabs.concat(state.tabs).map(t=>[t.tab_id,t]));const workspacesHtml=renderSpaces();if(workspacesHtml!==lastWorkspacesHtml){workspaces.innerHTML=workspacesHtml;lastWorkspacesHtml=workspacesHtml}const agentsHtml=renderAgents(wsById,tabById);if(agentsHtml!==lastAgentsHtml){agents.innerHTML=agentsHtml;lastAgentsHtml=agentsHtml}const pane=state.panes.find(p=>p.pane_id===state.pane);const info=pane?`${pane.pane_id} · ${pane.terminal_id}${state.termCols&&state.termRows?' · '+state.termCols+'x'+state.termRows:''}`:'no pane';const tabsHtml=state.tabs.map(t=>renderTabButton(t)).join('')+(state.ws?`<button class="tab add" title="New panel" onclick="newTab()">+</button>`:'')+`<div class="tab-info">${escapeHtml(info)}</div>`;if(tabsHtml!==lastTabsHtml){tabs.innerHTML=tabsHtml;lastTabsHtml=tabsHtml}updateTitle(wsById,tabById,pane);if(state.editingTab){const input=document.querySelector('.tab-rename-input');if(input&&document.activeElement!==input){input.focus();input.select()}}if(state.editingWorkspace){const input=document.querySelector('.workspace-rename-input');if(input&&document.activeElement!==input){input.focus();input.select()}}fitTerminalShell()}
function updateTitle(wsById,tabById,pane){const w=wsById[state.ws];const t=tabById[state.tab];const workspace=w?(w.worktree?worktreeDisplayName(w):w.label):(state.ws||state.session||'herdr');const panel=t?agentTabLabel(state.ws,t):(pane?pane.pane_id:'panel');document.title=`${workspace} • ${panel}`}
function renderTabButton(t){if(state.editingTab===t.tab_id)return `<span class="tab ${t.tab_id===state.tab?'active':''}"><input class="tab-rename-input" value="${escapeAttr(state.editingTabValue)}" oninput="state.editingTabValue=this.value" onkeydown="tabRenameKey(event,'${t.tab_id}')"></span>`;return `<a class="tab ${t.tab_id===state.tab?'active':''}" href="${escapeAttr(selectionPath(t.workspace_id,t.tab_id))}" target="herdr-selection" onclick="return navigateSelection(event,'${t.workspace_id}','${t.tab_id}')" ondblclick="event.preventDefault();event.stopPropagation();startTabRename('${t.tab_id}','${escapeAttr(tabTitle(t))}')"><span class="tab-label">${escapeHtml(tabTitle(t))}</span><span class="tab-actions"><span class="mini danger" title="Close panel" onclick="event.preventDefault();event.stopPropagation();closeTab('${t.tab_id}')">✕</span></span></a>`}
function renderSpaces(){const groups=new Map(),usedParents=new Set(),linkedIds=new Set();for(const w of state.workspaces){if(!isLinkedWorktree(w))continue;const k=worktreeGroupKey(w);linkedIds.add(w.workspace_id);if(!groups.has(k))groups.set(k,{type:'group',label:w.worktree.repo_name||w.label,children:[],parent:null});groups.get(k).children.push(w)}for(const g of groups.values()){g.parent=findWorktreeParent(g);if(g.parent)usedParents.add(g.parent.workspace_id)}let items=[];for(const w of state.workspaces){if(linkedIds.has(w.workspace_id)||usedParents.has(w.workspace_id))continue;items.push({type:'single',workspace:w})}for(const g of groups.values())items.push(g);items=sortWorkspaceItems(items);let html='';for(const item of items){if(item.type==='single'){html+=renderWorkspaceCard(item.workspace,'');continue}const children=sortGroupChildren(item.children);if(item.parent)html+=renderWorkspaceCard(item.parent,'workspace-group-main');else html+=`<div class="repo-header workspace-orphan-header">${escapeHtml(item.label)}</div>`;html+=children.map((w,i)=>renderWorkspaceCard(w,'workspace-child '+(i===children.length-1?'last':''))).join('')}return html}
function workspaceItemIds(item){return item.type==='single'?[item.workspace.workspace_id]:[(item.parent&&item.parent.workspace_id)||'',...item.children.map(w=>w.workspace_id)].filter(Boolean)}
function workspaceOrderIndex(id){const i=state.workspaceOrder.indexOf(id);return i<0?999999:i}
function workspaceItemOrder(item){return Math.min(...workspaceItemIds(item).map(workspaceOrderIndex))}
function workspacePriority(w){return {blocked:0,done:1,unknown:2,idle:3,working:4}[statusClass(w.agent_status)]??2}
function workspaceItemPriority(item){const all=item.type==='single'?[item.workspace]:[item.parent,...item.children].filter(Boolean);return Math.min(...all.map(workspacePriority))}
function sortWorkspaceItems(items){if(options.workspaceSort==='state')return items.slice().sort((a,b)=>workspaceItemPriority(a)-workspaceItemPriority(b));if(options.workspaceSort==='drag')return items.slice().sort((a,b)=>workspaceItemOrder(a)-workspaceItemOrder(b));return items}
function sortGroupChildren(children){if(options.workspaceSort==='state')return children.slice().sort((a,b)=>workspacePriority(a)-workspacePriority(b));if(options.workspaceSort==='drag')return children.slice().sort((a,b)=>workspaceOrderIndex(a.workspace_id)-workspaceOrderIndex(b.workspace_id));return children}
function renderWorkspaceCard(w,extraClass){const editing=state.editingWorkspace===w.workspace_id;const label=editing?`<input class="workspace-rename-input" value="${escapeAttr(state.editingWorkspaceValue)}" oninput="state.editingWorkspaceValue=this.value" onkeydown="workspaceRenameKey(event,'${w.workspace_id}')">`:`<span class="label">${escapeHtml(w.label)}</span>`;const linked=isLinkedWorktree(w);const closeAction=linked?`removeWorktree('${w.workspace_id}')`:`closeWorkspace('${w.workspace_id}')`;const closeTitle=linked?'Remove and close worktree':'Close workspace';const worktreeAction=linked?'':`<span class="mini tree" title="Create worktree" onclick="event.preventDefault();event.stopPropagation();openWorktreeCreateModal('${w.workspace_id}')">♧+</span>`;const drag=options.workspaceSort==='drag'?' draggable="true" ondragstart="workspaceDragStart(event,\''+w.workspace_id+'\')" ondragover="workspaceDragOver(event,\''+w.workspace_id+'\')" ondragleave="workspaceDragLeave(event)" ondrop="workspaceDrop(event,\''+w.workspace_id+'\')" ondragend="workspaceDragEnd(event)"':'';return `<a class="item ${w.workspace_id===state.ws?'active':''} ${extraClass||''}" data-workspace-id="${escapeAttr(w.workspace_id)}" href="${escapeAttr(selectionPath(w.workspace_id))}" target="herdr-selection"${drag} onclick="if(state.editingWorkspace){event.preventDefault();return false}return navigateSelection(event,'${w.workspace_id}')" ondblclick="event.preventDefault();event.stopPropagation();startWorkspaceRename('${w.workspace_id}','${escapeAttr(w.label)}')"><div class="space-title"><span>${statusDot(w.agent_status)}</span>${label}<span class="space-actions">${worktreeAction}<span class="mini danger" title="${closeTitle}" onclick="event.preventDefault();event.stopPropagation();${closeAction}">✕</span></span></div><div class="muted">${spaceMeta(w)}</div></a>`}
function spaceMeta(w){const wt=worktreeForWorkspace(w);const parts=[`${w.pane_count} panes`];const branch=(wt&&(wt.branch||(wt.is_detached?'detached':'')))||state.workspaceBranches[w.workspace_id];if(branch)parts.push(`<span class="chip branch">${escapeHtml(branch)}</span>`);return parts.join(' ')}
function isLinkedWorktree(w){return !!(w&&w.worktree&&w.worktree.is_linked_worktree)}
function worktreeGroupKey(w){return w&&w.worktree&&(w.worktree.repo_key||w.worktree.repo_root||w.worktree.repo_name)||''}
function findWorktreeParent(group){return state.workspaces.find(w=>w.worktree&&!w.worktree.is_linked_worktree&&worktreeGroupKey(w)===(group.children[0]?worktreeGroupKey(group.children[0]):''))||state.workspaces.find(w=>!w.worktree&&w.label===group.label)||null}
function worktreeForWorkspace(w){if(!w.worktree)return null;return state.worktrees.find(t=>t.open_workspace_id===w.workspace_id)||state.worktrees.find(t=>samePath(t.path,w.worktree.checkout_path))||null}
function samePath(a,b){return String(a||'').replace(/\/+$/,'')===String(b||'').replace(/\/+$/,'')}
function renderAgents(wsById,tabById){const list=state.agents.slice();if(options.sortAgentsByStatus)list.sort((a,b)=>agentAttentionRank(a)-agentAttentionRank(b));return list.map(a=>renderAgentRow(a,wsById,tabById)).join('')}
function agentAttentionRank(a){const status=statusClass(a.agent_status);return {blocked:0,done:1,unknown:2,idle:3,working:4}[status]??2}
function renderAgentRow(a,wsById,tabById){const w=wsById[a.workspace_id];const repo=w&&w.worktree?parentWorkspaceName(w,wsById):null;const primary=w&&w.worktree?`[${repo}] ${worktreeDisplayName(w)}`:(w?w.label:a.workspace_id);const t=tabById[a.tab_id];const tab=agentTabLabel(a.workspace_id,t);const label=a.name||a.display_agent||a.agent||a.terminal_id;const status=statusClass(a.agent_status);const active=a.workspace_id===state.ws&&a.tab_id===state.tab&&a.pane_id===state.pane;return `<a class="item ${active?'active':''}" href="${escapeAttr(selectionPath(a.workspace_id,a.tab_id,a.pane_id))}" target="herdr-selection" onclick="return navigateSelection(event,'${a.workspace_id}','${a.tab_id}','${a.pane_id}')"><div class="agent-title">${statusMark(a.agent_status,status==='blocked')}<span>${escapeHtml(primary)}</span>${tab?`<span>•</span><span>${escapeHtml(tab)}</span>`:''}</div><div class="agent-meta"><span class="agent-status ${status}">${escapeHtml(status)}</span><span>•</span><span class="agent-name">${escapeHtml(label)}</span></div></a>`}
function agentTabLabel(wsId,t){if(!t)return '';const count=state.allTabs.filter(x=>x.workspace_id===wsId).length;return count>1||t.label?tabTitle(t):''}
function worktreeDisplayName(w){if(!w)return 'worktree';const wt=worktreeForWorkspace(w);return wt&&wt.label?wt.label:w.label}
function parentWorkspaceName(w,wsById){if(!w||!w.worktree)return 'workspace';const key=w.worktree.repo_key||w.worktree.repo_root||w.worktree.repo_name;const match=Object.values(wsById).find(x=>x.workspace_id!==w.workspace_id&&x.worktree&&(x.worktree.repo_key||x.worktree.repo_root||x.worktree.repo_name)===key&&!x.worktree.is_linked_worktree)||Object.values(wsById).find(x=>x.workspace_id!==w.workspace_id&&!x.worktree&&x.label===w.worktree.repo_name);return match?match.label:w.worktree.repo_name}
function connectEvents(){if(document.hidden||eventWs)return;const eventSession=state.session;const ws=new WebSocket(wsUrl('/ws/events'));eventWs=ws;ws.onmessage=e=>{if(eventWs!==ws||eventSession!==state.session)return;let msg;try{msg=JSON.parse(e.data)}catch(_){scheduleRefresh();return}if(msg.type==='snapshot')applySnapshot(msg);else if(msg.type==='event')scheduleRefresh()};ws.onclose=()=>{if(eventWs===ws)eventWs=null;if(!document.hidden&&eventSession===state.session)setTimeout(connectEvents,1500)}}
function connectTerminal(){
if(document.hidden)return;
if(!state.terminalId){resetTerminalConnection(true);setTerminalLoading(false);return}
fitTerminalShell();
const cols=state.termCols||100,rows=state.termRows||30,size=`${cols}x${rows}`;
const target=`${state.session}|${state.ws}|${state.tab}|${state.pane}|${state.terminalId}`;
if(termWs&&termWs.readyState===1&&connectedTerminalId===target&&connectedSize===size){setTerminalLoading(false);fitTerminalSurface();focusTerminal();return}
resetTerminalConnection(true);setTerminalLoading(true);connectedTerminalId=target;connectedSize=size;
if(!term){
term=new Terminal({convertEol:false,fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace',theme:terminalTheme(),scrollback:10000});term.open(terminal);applyTheme();term.onData(d=>termWs&&termWs.readyState===1&&termWs.send(JSON.stringify({input:d})));
if(term.attachCustomKeyEventHandler)term.attachCustomKeyEventHandler(e=>{if(e.type==='keydown'&&handleCloseShortcut(e))return false;if(e.type==='keydown'&&e.key==='Enter'&&e.shiftKey&&!e.altKey&&!e.ctrlKey&&!e.metaKey){pasteToTerminal(shiftEnterSequence());return false}if(e.type==='keydown'&&!e.altKey&&!e.ctrlKey&&!e.metaKey&&(e.key==='PageUp'||e.key==='PageDown')){sendBackendScroll(e.key==='PageUp'?'up':'down',Math.max(1,(state.termRows||rows)-1));return false}return true})
}
if(!termScrollBound){
el('terminalShell').addEventListener('wheel',e=>{if(wheelOnShellScrollbar(e))return;if(e.altKey){e.preventDefault();scrollBrowserOverflow(e.deltaX,e.deltaY);return}if(!termWs||termWs.readyState!==1)return;e.preventDefault();const delta=Math.abs(e.deltaY)>=Math.abs(e.deltaX)?e.deltaY:e.deltaX;const lines=Math.max(1,Math.min(20,Number(options.scrollLines)||3));sendBackendScroll(delta<0?'up':'down',lines,mouseCell(e),mouseModifiers(e))},{passive:false});
el('terminalShell').addEventListener('mousedown',()=>setTimeout(focusTerminal,0));termScrollBound=true
}
try{term.resize(cols,rows);fitTerminalSurface()}catch(e){}
const ws=new WebSocket(wsUrl(`/ws/terminal?terminal_id=${encodeURIComponent(state.terminalId)}&cols=${cols}&rows=${rows}`));termWs=ws;ws.binaryType='arraybuffer';
ws.onopen=()=>{if(termWs===ws)focusTerminal()};
ws.onmessage=e=>{if(termWs!==ws||connectedTerminalId!==target)return;setTerminalLoading(false);if(typeof e.data==='string')term.write(e.data);else term.write(new Uint8Array(e.data));scheduleTerminalFrameWork()};
ws.onclose=()=>{if(termWs===ws){termWs=null;connectedTerminalId=null;connectedSize='';setTerminalLoading(false);scheduleRefresh()}}
}
function modalOpen(){return ['settingsModal','worktreeCreateModal','shortcutsModal'].some(id=>{const m=el(id);return m&&m.style.display&&m.style.display!=='none'})}
function focusTerminal(){if(state.editingTab||state.editingWorkspace||modalOpen()||!term)return;try{term.focus()}catch(e){}}
function scheduleTerminalFrameWork(){if(terminalFramePending)return;terminalFramePending=true;requestAnimationFrame(()=>{terminalFramePending=false;fitTerminalShell();fitTerminalSurface();focusTerminal()})}
function sendBackendScroll(direction,lines,cell,modifiers=0){if(termWs&&termWs.readyState===1)termWs.send(JSON.stringify({type:'scroll',direction,lines,column:cell&&cell.column,row:cell&&cell.row,modifiers}))}
function mouseCell(e){const screen=terminal.querySelector('.xterm-screen');const rowsEl=terminal.querySelector('.xterm-rows');if(!screen||!rowsEl)return null;const rect=screen.getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)return null;const colWidth=rect.width/(state.termCols||100);const rowHeight=rect.height/(state.termRows||30);if(!colWidth||!rowHeight)return null;return{column:Math.max(0,Math.min((state.termCols||100)-1,Math.floor((e.clientX-rect.left)/colWidth))),row:Math.max(0,Math.min((state.termRows||30)-1,Math.floor((e.clientY-rect.top)/rowHeight)))}}
function mouseModifiers(e){return(e.shiftKey?1:0)|(e.ctrlKey?2:0)|(e.altKey?4:0)}
async function copySelection(){const text=term&&term.getSelection?term.getSelection():'';if(!text)return false;try{await navigator.clipboard.writeText(text)}catch(e){const area=document.createElement('textarea');area.value=text;document.body.appendChild(area);area.select();document.execCommand('copy');area.remove()}hideClipboardMenu();return true}
async function pasteClipboard(){let text='';try{text=await navigator.clipboard.readText()}catch(e){text=prompt('Paste text')||''}if(text)pasteToTerminal(text);hideClipboardMenu()}
function pasteToTerminal(text){if(termWs&&termWs.readyState===1)termWs.send(JSON.stringify({input:text}))}
function showClipboardMenu(x,y){const menu=el('clipboardMenu');if(!menu)return;menu.style.left=x+'px';menu.style.top=y+'px';menu.style.display='block'}
function hideClipboardMenu(){const menu=el('clipboardMenu');if(menu)menu.style.display='none'}
function fitTerminalSurface(){const x=terminal.querySelector('.xterm');const screen=terminal.querySelector('.xterm-screen');const viewport=terminal.querySelector('.xterm-viewport');const rowsEl=terminal.querySelector('.xterm-rows');const helper=terminal.querySelector('.xterm-helper-textarea');if(!x||!screen)return;const cols=state.termCols||100,rows=state.termRows||30;const dims=term&&term._core&&term._core._renderService&&term._core._renderService.dimensions&&term._core._renderService.dimensions.css&&term._core._renderService.dimensions.css.cell;const firstRow=rowsEl&&rowsEl.firstElementChild;const cellWidth=(dims&&dims.width)||((firstRow&&firstRow.getBoundingClientRect().width)/cols)||9;const rowHeight=(dims&&dims.height)||((firstRow&&firstRow.getBoundingClientRect().height))||17;const width=Math.ceil(cellWidth*cols);const height=Math.ceil(rowHeight*rows);terminal.style.width=width+'px';terminal.style.height=height+'px';terminal.style.minWidth=width+'px';terminal.style.minHeight=height+'px';x.style.width=width+'px';x.style.height=height+'px';x.style.minWidth=width+'px';x.style.minHeight=height+'px';screen.style.width=width+'px';screen.style.height=height+'px';if(viewport)viewport.style.height=height+'px';if(rowsEl){rowsEl.style.width=width+'px';rowsEl.style.height=height+'px'}if(helper){helper.style.width=width+'px';helper.style.height=height+'px'}}
function fitTerminalShell(){const main=document.querySelector('.main');const tabsEl=document.querySelector('.tabs');const shell=el('terminalShell');if(!main||!tabsEl||!shell)return;const m=main.getBoundingClientRect();const t=tabsEl.getBoundingClientRect();shell.style.width=Math.max(0,Math.floor(m.width))+'px';shell.style.height=Math.max(0,Math.floor(m.height-t.height))+'px'}
function browserTerminalSize(){fitTerminalShell();const shell=el('terminalShell');if(!shell)return null;const width=Math.max(80,shell.clientWidth-16);const height=Math.max(24,shell.clientHeight-16);const dims=term&&term._core&&term._core._renderService&&term._core._renderService.dimensions&&term._core._renderService.dimensions.css&&term._core._renderService.dimensions.css.cell;const cellWidth=(dims&&dims.width)||9;const cellHeight=(dims&&dims.height)||17;return{cols:Math.max(80,Math.floor(width/cellWidth)),rows:Math.max(24,Math.floor(height/cellHeight))}}
window.addEventListener('resize',()=>{if(resizeFramePending)return;resizeFramePending=true;requestAnimationFrame(()=>{resizeFramePending=false;fitTerminalShell();if(options.fitToBrowser){const fit=browserTerminalSize();if(fit){state.termCols=fit.cols;state.termRows=fit.rows;connectTerminal()}}})});
function scrollBrowserOverflow(dx,dy){const shell=el('terminalShell');if(!shell)return;const maxTop=Math.max(0,shell.scrollHeight-shell.clientHeight);const maxLeft=Math.max(0,shell.scrollWidth-shell.clientWidth);shell.scrollTop=Math.max(0,Math.min(maxTop,shell.scrollTop+dy));shell.scrollLeft=Math.max(0,Math.min(maxLeft,shell.scrollLeft+dx))}
function wheelOnShellScrollbar(e){const shell=el('terminalShell');if(!shell)return false;const r=shell.getBoundingClientRect();const vertical=shell.scrollHeight>shell.clientHeight&&e.clientX>=r.right-14;const horizontal=shell.scrollWidth>shell.clientWidth&&e.clientY>=r.bottom-14;return vertical||horizontal}
function wsUrl(path){const sep=path.includes('?')?'&':'?';const session=state.session&&state.session!=='default'?sep+'session='+encodeURIComponent(state.session):'';return (location.protocol==='https:'?'wss://':'ws://')+location.host+path+session}
function escapeHtml(s){return String(s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function escapeAttr(s){return escapeHtml(s).replace(/'/g,'&#39;')}
function workspaceCloseName(id){const w=state.workspaces.find(x=>x.workspace_id===id);if(!w)return id;const branch=workspaceBranch(w);return `${w.label}${branch?' - '+branch:''}`}
function workspaceBranch(w){const wt=worktreeForWorkspace(w);return (wt&&(wt.branch||(wt.is_detached?'detached':'')))||state.workspaceBranches[w.workspace_id]||''}
function panelCloseName(id){const t=state.allTabs.concat(state.tabs).find(x=>x.tab_id===id);if(!t)return id;return `${workspaceCloseName(t.workspace_id)} - ${tabTitle(t)}`}
function workspaceDragStart(e,id){state.dragWorkspace=id;e.currentTarget.classList.add('workspace-drag');try{e.dataTransfer.setData('text/plain',id);e.dataTransfer.effectAllowed='move'}catch(_){}}
function workspaceDragOver(e,id){if(options.workspaceSort!=='drag'||!state.dragWorkspace||state.dragWorkspace===id)return;e.preventDefault();e.currentTarget.classList.add('workspace-drop')}
function workspaceDragLeave(e){e.currentTarget.classList.remove('workspace-drop')}
function workspaceDragEnd(e){e.currentTarget.classList.remove('workspace-drag');document.querySelectorAll('.workspace-drop').forEach(x=>x.classList.remove('workspace-drop'));state.dragWorkspace=null}
async function workspaceDrop(e,targetId){e.preventDefault();e.currentTarget.classList.remove('workspace-drop');const source=state.dragWorkspace;if(!source||source===targetId)return;const ids=orderedWorkspaceIds().filter(id=>id!==source);const index=Math.max(0,ids.indexOf(targetId));ids.splice(index,0,source);state.workspaceOrder=ids;state.dragWorkspace=null;render();await api('/api/workspace-order',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({order:ids})})}
function orderedWorkspaceIds(){return Array.from(document.querySelectorAll('#workspaces .item')).map(x=>x.dataset.workspaceId).filter(Boolean)}
function openWorktreeCreateModal(id){const w=state.workspaces.find(x=>x.workspace_id===id);if(!w||isLinkedWorktree(w))return;state.createWorktreeWorkspace=id;el('worktreeCreateSource').textContent=w.label||id;el('worktreeBranch').value='';el('worktreeBase').value='HEAD';el('worktreeLabel').value='';el('worktreePath').value='';el('worktreeCreateError').textContent='';el('worktreeCreateModal').style.display='grid';setTimeout(()=>el('worktreeBranch').focus(),0)}
function closeWorktreeCreateModal(){const m=el('worktreeCreateModal');if(m)m.style.display='none';state.createWorktreeWorkspace=null}
async function closeWorkspace(id){if(!confirm(`Close workspace "${workspaceCloseName(id)}"?`))return;await api(`/api/workspaces/${encodeURIComponent(id)}/close`,{method:'POST'});if(state.ws===id){state.ws=null;state.tab=null;state.pane=null}refresh()}
async function removeWorktree(id){if(!confirm(`Remove and close worktree "${workspaceCloseName(id)}"?`))return;await api(`/api/workspaces/${encodeURIComponent(id)}/worktree-remove`,{method:'POST'});if(state.ws===id){state.ws=null;state.tab=null;state.pane=null}refresh()}
async function newTab(){if(!state.ws)return;const label=prompt('panel name');if(label===null)return;const r=await api('/api/tabs',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspace_id:state.ws,label})});const tab=r.result.tab.tab_id;go(state.ws,tab)}
function startWorkspaceRename(id,label){state.editingWorkspace=id;state.editingWorkspaceValue=label||'';render()}
function workspaceRenameKey(e,id){if(e.key==='Enter'){e.preventDefault();commitWorkspaceRename(id)}else if(e.key==='Escape'){state.editingWorkspace=null;state.editingWorkspaceValue='';render()}}
async function commitWorkspaceRename(id){if(state.editingWorkspace!==id)return;const label=String(state.editingWorkspaceValue||'').trim();state.editingWorkspace=null;state.editingWorkspaceValue='';if(label)await api(`/api/workspaces/${encodeURIComponent(id)}/rename`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label})});refresh()}
function startTabRename(id,label){state.editingTab=id;state.editingTabValue=label||'';render()}
function tabRenameKey(e,id){if(e.key==='Enter'){e.preventDefault();commitTabRename(id)}else if(e.key==='Escape'){state.editingTab=null;state.editingTabValue='';render()}}
async function commitTabRename(id){if(state.editingTab!==id)return;const label=String(state.editingTabValue||'').trim();state.editingTab=null;state.editingTabValue='';if(label)await api(`/api/tabs/${encodeURIComponent(id)}/rename`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label})});refresh()}
async function closeTab(id){if(!confirm(`Close panel "${panelCloseName(id)}"?`))return;await api(`/api/tabs/${encodeURIComponent(id)}/close`,{method:'POST'});state.tab=null;state.pane=null;refresh()}
function shortcutW(e){return String(e.key||'').toLowerCase()==='w'||e.code==='KeyW'}
function shortcutSpace(e){return e.code==='Space'||e.key===' '||e.key==='Spacebar'}
function handleCloseShortcut(e){const mode=options.closeShortcut||'off';if(mode==='altw'&&e.altKey&&!e.metaKey&&!e.ctrlKey&&!e.shiftKey&&shortcutW(e))return closeCurrentPanelShortcut();if(mode==='shiftspacew'){const now=Date.now();if(e.shiftKey&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&shortcutSpace(e)){closeChordUntil=now+1500;return true}if(closeChordUntil>now&&!e.metaKey&&!e.ctrlKey&&!e.altKey&&shortcutW(e)){closeChordUntil=0;return closeCurrentPanelShortcut()}if(!e.shiftKey&&!shortcutW(e))closeChordUntil=0}return false}
function closeCurrentPanelShortcut(){if((options.closeShortcut||'off')==='off'||!state.tab)return false;closeTab(state.tab);return true}
function closeShortcutKeydown(e){if(!handleCloseShortcut(e))return false;e.preventDefault();e.stopPropagation();if(e.stopImmediatePropagation)e.stopImmediatePropagation();return true}
newWs.onclick=async()=>{const label=prompt('workspace label');if(label===null)return;const cwd=prompt('cwd (empty = default)')||null;const r=await api('/api/workspaces',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label,cwd})});const ws=r.result.workspace.workspace_id;go(ws)};
el('themeToggle').onclick=()=>{themeMode=themeMode==='auto'?'dark':(themeMode==='dark'?'light':'auto');applyTheme()};if(window.matchMedia){try{const media=window.matchMedia('(prefers-color-scheme: dark)');if(media.addEventListener)media.addEventListener('change',()=>{if(themeMode==='auto')applyTheme()});else if(media.addListener)media.addListener(()=>{if(themeMode==='auto')applyTheme()})}catch(e){}}setInterval(pollAutoTheme,2000);
let settingsBackdropDown=false,shortcutsBackdropDown=false;el('settingsToggle').onclick=()=>{el('settingsModal').style.display='grid';applyOptions()};el('settingsClose').onclick=()=>{el('settingsModal').style.display='none'};el('settingsModal').addEventListener('pointerdown',e=>{settingsBackdropDown=e.target===el('settingsModal')});el('settingsModal').addEventListener('click',e=>{if(settingsBackdropDown&&e.target===el('settingsModal'))el('settingsModal').style.display='none';settingsBackdropDown=false});el('shortcutsToggle').onclick=()=>{applyOptions();el('shortcutsModal').style.display='grid'};el('shortcutsClose').onclick=()=>{el('shortcutsModal').style.display='none'};el('shortcutsCloseTop').onclick=()=>{el('shortcutsModal').style.display='none'};el('shortcutsModal').addEventListener('pointerdown',e=>{shortcutsBackdropDown=e.target===el('shortcutsModal')});el('shortcutsModal').addEventListener('click',e=>{if(shortcutsBackdropDown&&e.target===el('shortcutsModal'))el('shortcutsModal').style.display='none';shortcutsBackdropDown=false});el('optTheme').onchange=()=>{themeMode=normalizeThemeMode(el('optTheme').value);applyTheme()};el('optOverflow').onchange=()=>{options.overflow=el('optOverflow').checked;saveOptions();applyOptions()};el('optFit').onchange=()=>{options.fitToBrowser=el('optFit').checked;saveOptions();applyOptions()};el('optShiftEnter').onchange=()=>{options.shiftEnter=el('optShiftEnter').value;saveOptions();applyOptions()};el('optCloseShortcut').onchange=()=>{options.closeShortcut=el('optCloseShortcut').value;closeChordUntil=0;saveOptions();applyOptions()};el('optSortAgents').onchange=()=>{options.sortAgentsByStatus=el('optSortAgents').checked;saveOptions();applyOptions();render()};el('optWorkspaceSort').onchange=()=>{options.workspaceSort=el('optWorkspaceSort').value;saveOptions();applyOptions();render()};el('optSoundScope').onchange=()=>{options.soundScope=el('optSoundScope').value;saveOptions();applyOptions()};el('optScrollLines').oninput=()=>{options.scrollLines=Math.max(1,Math.min(20,Number(el('optScrollLines').value)||3));saveOptions();applyOptions()};el('optSound').onchange=()=>{options.sound=el('optSound').checked;saveOptions();applyOptions()};
el('worktreeCreateClose').onclick=closeWorktreeCreateModal;el('worktreeCreateCancel').onclick=closeWorktreeCreateModal;el('worktreeCreateModal').addEventListener('click',e=>{if(e.target===el('worktreeCreateModal'))closeWorktreeCreateModal()});el('worktreeCreateForm').onsubmit=async e=>{e.preventDefault();const err=el('worktreeCreateError'),submit=el('worktreeCreateSubmit');err.textContent='';const branch=el('worktreeBranch').value.trim(),base=el('worktreeBase').value.trim()||'HEAD',label=el('worktreeLabel').value.trim(),path=el('worktreePath').value.trim();if(!branch){err.textContent='Branch is required';return}submit.disabled=true;try{const r=await api('/api/worktrees',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspace_id:state.createWorktreeWorkspace,branch,base,label:label||null,path:path||null})});closeWorktreeCreateModal();const result=r.result||{};go(result.workspace.workspace_id,result.tab&&result.tab.tab_id,result.root_pane&&result.root_pane.pane_id)}catch(ex){err.textContent=ex.message||String(ex)}finally{submit.disabled=false}};
el('copyMenu').onclick=copySelection;el('pasteMenu').onclick=pasteClipboard;el('terminalShell').addEventListener('contextmenu',e=>{e.preventDefault();showClipboardMenu(e.clientX,e.clientY)});document.addEventListener('click',e=>{const menu=el('clipboardMenu');if(menu&&!menu.contains(e.target))hideClipboardMenu()});window.addEventListener('keydown',closeShortcutKeydown,true);document.addEventListener('keydown',e=>{const copyKey=(e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='c';const pasteKey=(e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='v';if(copyKey&&term&&term.getSelection&&term.getSelection()){e.preventDefault();copySelection()}else if(pasteKey){e.preventDefault();pasteClipboard()}});
window.onpopstate=refresh;document.addEventListener('visibilitychange',()=>{if(document.hidden){hiddenTimer=setTimeout(()=>{if(eventWs)eventWs.close();if(termWs)termWs.close()},1000)}else{clearTimeout(hiddenTimer);loadVersions();refresh();connectEvents()}});
document.addEventListener('pointerdown',unlockAudio,{once:true});document.addEventListener('keydown',unlockAudio,{once:true});
setupSessionChrome();applyTheme();applyOptions();loadVersions();refresh();connectEvents();
</script></body></html>"#;

const XTERM_CSS: &str = include_str!("assets/xterm.css");
const XTERM_JS: &str = include_str!("assets/xterm.min.js");
const HERDR_LOGO: &str = include_str!("assets/herdr-logo.svg");
