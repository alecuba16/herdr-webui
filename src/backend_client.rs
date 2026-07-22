use std::fmt;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use interprocess::local_socket::Stream as LocalStream;
use interprocess::TryClone as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::protocol::{
    read_message, write_message, ClientKeybindings, ClientLaunchMode, ClientMessage,
    RenderEncoding, ServerMessage, TerminalFrame,
};

/// Client-side API intended for a future first-party TUI or smoke CLI.
///
/// It speaks the same local sockets that the browser adapter uses today:
/// a newline-delimited JSON control socket and a length-prefixed bincode
/// terminal socket. This is not full Herdr parity yet; it is the stable-ish
/// MVP layer for listing state, reading pane tails, and attaching ANSI
/// terminal streams without depending on Axum, WebSocket, DOM, or browser terminal renderer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackendClient {
    api_socket: PathBuf,
    terminal_socket: PathBuf,
}

#[derive(Debug)]
pub enum BackendClientError {
    Io(io::Error),
    Json(serde_json::Error),
    Backend(String),
    Protocol(String),
    UnexpectedResponse(String),
}

impl fmt::Display for BackendClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(err) => write!(f, "I/O error: {err}"),
            Self::Json(err) => write!(f, "JSON error: {err}"),
            Self::Backend(message) => write!(f, "backend error: {message}"),
            Self::Protocol(message) => write!(f, "terminal protocol error: {message}"),
            Self::UnexpectedResponse(message) => write!(f, "unexpected response: {message}"),
        }
    }
}

impl std::error::Error for BackendClientError {}

impl From<io::Error> for BackendClientError {
    fn from(err: io::Error) -> Self {
        Self::Io(err)
    }
}

impl From<serde_json::Error> for BackendClientError {
    fn from(err: serde_json::Error) -> Self {
        Self::Json(err)
    }
}

impl BackendClient {
    pub fn new(api_socket: impl Into<PathBuf>, terminal_socket: impl Into<PathBuf>) -> Self {
        Self {
            api_socket: api_socket.into(),
            terminal_socket: terminal_socket.into(),
        }
    }

    /// Discover the built-in backend sockets for a session using the same path
    /// convention as the WebUI runtime. A future TUI can use this for the common
    /// case, or pass explicit paths with `new` when embedded/remote launchers
    /// provide sockets out of band.
    pub fn builtin_session(session: Option<&str>) -> Self {
        let (api_socket, terminal_socket) = builtin_socket_paths(session);
        Self::new(api_socket, terminal_socket)
    }

    pub fn api_socket(&self) -> &Path {
        &self.api_socket
    }

    pub fn terminal_socket(&self) -> &Path {
        &self.terminal_socket
    }

    pub fn request_raw(&self, request: Value) -> Result<Value, BackendClientError> {
        let mut stream = connect_local_stream(&self.api_socket)?;
        stream.write_all(serde_json::to_string(&request)?.as_bytes())?;
        stream.write_all(b"\n")?;
        stream.flush()?;
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(BackendClientError::UnexpectedResponse(
                "backend closed the control socket without a response".to_string(),
            ));
        }
        Ok(serde_json::from_str(&line)?)
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value, BackendClientError> {
        let response = self.request_raw(json!({
            "id": format!("tui:{method}"),
            "method": method,
            "params": params,
        }))?;
        if let Some(error) = response.get("error") {
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
                .unwrap_or("backend returned an error")
                .to_string();
            return Err(BackendClientError::Backend(message));
        }
        response.get("result").cloned().ok_or_else(|| {
            BackendClientError::UnexpectedResponse(format!(
                "missing result in backend response: {response}"
            ))
        })
    }

    pub fn ping(&self) -> Result<Value, BackendClientError> {
        self.request("ping", json!({}))
    }

    pub fn snapshot(&self) -> Result<Value, BackendClientError> {
        self.request("session.snapshot", json!({}))
    }

    pub fn list_workspaces(&self) -> Result<Value, BackendClientError> {
        self.request("workspace.list", json!({}))
    }

    pub fn create_workspace(
        &self,
        cwd: Option<&str>,
        label: Option<&str>,
    ) -> Result<Value, BackendClientError> {
        self.request(
            "workspace.create",
            json!({ "cwd": cwd, "label": label, "focus": false, "env": {} }),
        )
    }

    pub fn list_tabs(&self, workspace_id: Option<&str>) -> Result<Value, BackendClientError> {
        self.request("tab.list", json!({ "workspace_id": workspace_id }))
    }

    pub fn create_tab(
        &self,
        workspace_id: Option<&str>,
        label: Option<&str>,
    ) -> Result<Value, BackendClientError> {
        self.request(
            "tab.create",
            json!({ "workspace_id": workspace_id, "label": label }),
        )
    }

    pub fn list_panes(&self, workspace_id: Option<&str>) -> Result<Value, BackendClientError> {
        self.request("pane.list", json!({ "workspace_id": workspace_id }))
    }

    pub fn read_pane(&self, pane_id: &str) -> Result<Value, BackendClientError> {
        self.request("pane.read", json!({ "pane_id": pane_id }))
    }

    pub fn list_agents(&self) -> Result<Value, BackendClientError> {
        self.request("agent.list", json!({}))
    }

    pub fn start_agent(
        &self,
        name: &str,
        argv: &[String],
        cwd: Option<&str>,
    ) -> Result<Value, BackendClientError> {
        self.request(
            "agent.start",
            json!({ "name": name, "argv": argv, "cwd": cwd }),
        )
    }

    pub fn list_worktrees(&self, cwd: Option<&str>) -> Result<Value, BackendClientError> {
        self.request("worktree.list", json!({ "cwd": cwd }))
    }

    pub fn open_worktree(
        &self,
        path: &str,
        branch: Option<&str>,
        label: Option<&str>,
    ) -> Result<Value, BackendClientError> {
        self.request(
            "worktree.open",
            json!({ "path": path, "branch": branch, "label": label }),
        )
    }

    pub fn create_worktree(
        &self,
        cwd: &str,
        branch: &str,
        path: &str,
        label: Option<&str>,
    ) -> Result<Value, BackendClientError> {
        self.create_worktree_from_base(cwd, branch, "HEAD", path, label)
    }

    pub fn create_worktree_from_base(
        &self,
        cwd: &str,
        branch: &str,
        base: &str,
        path: &str,
        label: Option<&str>,
    ) -> Result<Value, BackendClientError> {
        self.request(
            "worktree.create",
            json!({ "cwd": cwd, "branch": branch, "base": base, "path": path, "label": label }),
        )
    }

    pub fn attach_terminal(
        &self,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<TerminalClient, BackendClientError> {
        let mut stream = connect_local_stream(&self.terminal_socket)?;
        let cols = cols.max(1);
        let rows = rows.max(1);
        write_protocol(
            &mut stream,
            &ClientMessage::Hello {
                version: BUILTIN_TUI_PROTOCOL_VERSION,
                cols,
                rows,
                cell_width_px: 0,
                cell_height_px: 0,
                requested_encoding: RenderEncoding::TerminalAnsi,
                keybindings: ClientKeybindings::Server,
                launch_mode: ClientLaunchMode::TerminalAttach,
            },
        )?;
        match read_protocol::<ServerMessage>(&mut stream)? {
            ServerMessage::Welcome {
                error: Some(error), ..
            } => {
                return Err(BackendClientError::Protocol(error));
            }
            ServerMessage::Welcome { .. } => {}
            other => {
                return Err(BackendClientError::UnexpectedResponse(format!(
                    "expected terminal Welcome, got {other:?}"
                )));
            }
        }
        write_protocol(
            &mut stream,
            &ClientMessage::AttachTerminal {
                terminal_id: terminal_id.to_string(),
                takeover: false,
            },
        )?;
        Ok(TerminalClient { stream, cols, rows })
    }
}

pub const BUILTIN_TUI_PROTOCOL_VERSION: u32 = 16;
pub const MAX_TUI_TERMINAL_FRAME_SIZE: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalOutput {
    pub seq: u64,
    pub width: u16,
    pub height: u16,
    pub full: bool,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    Output(TerminalOutput),
    Graphics(Vec<u8>),
    WindowTitle(Option<String>),
    Clipboard(String),
    Notify {
        message: String,
        body: Option<String>,
    },
    MouseCapture {
        enabled: bool,
    },
    ServerShutdown {
        reason: Option<String>,
    },
    Ignored,
}

pub struct TerminalClient {
    stream: LocalStream,
    cols: u16,
    rows: u16,
}

pub struct TerminalWriter {
    stream: LocalStream,
    cols: u16,
    rows: u16,
}

impl TerminalClient {
    pub fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    pub fn writer(&self) -> Result<TerminalWriter, BackendClientError> {
        Ok(TerminalWriter {
            stream: self.stream.try_clone()?,
            cols: self.cols,
            rows: self.rows,
        })
    }

    pub fn read_event(&mut self) -> Result<TerminalEvent, BackendClientError> {
        match read_protocol::<ServerMessage>(&mut self.stream)? {
            ServerMessage::Terminal(frame) => Ok(TerminalEvent::Output(frame.into())),
            ServerMessage::Graphics { bytes } => Ok(TerminalEvent::Graphics(bytes)),
            ServerMessage::WindowTitle { title } => Ok(TerminalEvent::WindowTitle(title)),
            ServerMessage::Clipboard { data } => Ok(TerminalEvent::Clipboard(data)),
            ServerMessage::Notify { message, body, .. } => {
                Ok(TerminalEvent::Notify { message, body })
            }
            ServerMessage::MouseCapture { enabled } => Ok(TerminalEvent::MouseCapture { enabled }),
            ServerMessage::ServerShutdown { reason } => {
                Ok(TerminalEvent::ServerShutdown { reason })
            }
            _ => Ok(TerminalEvent::Ignored),
        }
    }

    pub fn read_output(&mut self) -> Result<TerminalOutput, BackendClientError> {
        loop {
            if let TerminalEvent::Output(output) = self.read_event()? {
                return Ok(output);
            }
        }
    }

    pub fn send_input(&mut self, data: &[u8]) -> Result<(), BackendClientError> {
        write_protocol(
            &mut self.stream,
            &ClientMessage::Input {
                data: data.to_vec(),
            },
        )
    }

    pub fn paste_text(&mut self, text: &str) -> Result<(), BackendClientError> {
        write_protocol(
            &mut self.stream,
            &ClientMessage::InputEvents {
                events: vec![crate::protocol::ClientInputEvent::Paste {
                    text: text.to_string(),
                }],
            },
        )
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), BackendClientError> {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        write_protocol(
            &mut self.stream,
            &ClientMessage::Resize {
                cols: self.cols,
                rows: self.rows,
                cell_width_px: 0,
                cell_height_px: 0,
            },
        )
    }

    pub fn detach(&mut self) -> Result<(), BackendClientError> {
        write_protocol(&mut self.stream, &ClientMessage::Detach)
    }
}

impl TerminalWriter {
    pub fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    pub fn send_input(&mut self, data: &[u8]) -> Result<(), BackendClientError> {
        write_protocol(
            &mut self.stream,
            &ClientMessage::Input {
                data: data.to_vec(),
            },
        )
    }

    pub fn paste_text(&mut self, text: &str) -> Result<(), BackendClientError> {
        write_protocol(
            &mut self.stream,
            &ClientMessage::InputEvents {
                events: vec![crate::protocol::ClientInputEvent::Paste {
                    text: text.to_string(),
                }],
            },
        )
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<(), BackendClientError> {
        self.cols = cols.max(1);
        self.rows = rows.max(1);
        write_protocol(
            &mut self.stream,
            &ClientMessage::Resize {
                cols: self.cols,
                rows: self.rows,
                cell_width_px: 0,
                cell_height_px: 0,
            },
        )
    }

    pub fn detach(&mut self) -> Result<(), BackendClientError> {
        write_protocol(&mut self.stream, &ClientMessage::Detach)
    }
}

impl From<TerminalFrame> for TerminalOutput {
    fn from(frame: TerminalFrame) -> Self {
        Self {
            seq: frame.seq,
            width: frame.width,
            height: frame.height,
            full: frame.full,
            bytes: frame.bytes,
        }
    }
}

fn write_protocol<M: serde::Serialize>(
    stream: &mut LocalStream,
    message: &M,
) -> Result<(), BackendClientError> {
    write_message(stream, message).map_err(BackendClientError::Protocol)
}

fn read_protocol<M: for<'de> serde::Deserialize<'de>>(
    stream: &mut LocalStream,
) -> Result<M, BackendClientError> {
    read_message(stream, MAX_TUI_TERMINAL_FRAME_SIZE).map_err(BackendClientError::Protocol)
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

fn builtin_socket_paths(session: Option<&str>) -> (PathBuf, PathBuf) {
    let session = session
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(safe_socket_component)
        .unwrap_or_else(|| "default".to_string());
    let dir = runtime_settings_path()
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

fn runtime_settings_path() -> PathBuf {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return PathBuf::from(dir).join("herdr-webui/webui-settings.json");
    }
    std::env::var("HOME")
        .map(|home| PathBuf::from(home).join(".config/herdr-webui/webui-settings.json"))
        .unwrap_or_else(|_| std::env::temp_dir().join("herdr-webui/webui-settings.json"))
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

#[cfg(unix)]
fn short_builtin_socket_dir(hash: &str) -> PathBuf {
    PathBuf::from("/tmp").join(format!("herdr-webui-builtin-{hash}"))
}

#[cfg(not(unix))]
fn short_builtin_socket_dir(hash: &str) -> PathBuf {
    std::env::temp_dir().join(format!("herdr-webui-builtin-{hash}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{mpsc, Mutex, OnceLock};
    use std::thread;
    use std::time::{SystemTime, UNIX_EPOCH};

    use interprocess::local_socket::traits::Listener;
    use interprocess::local_socket::Listener as LocalListener;
    use serde_json::json;

    #[test]
    fn error_display_and_from_impls_are_descriptive() {
        let io_error = BackendClientError::from(io::Error::other("disk gone"));
        assert_eq!(io_error.to_string(), "I/O error: disk gone");

        let json_error = BackendClientError::from(serde_json::from_str::<Value>("{").unwrap_err());
        assert!(json_error.to_string().starts_with("JSON error:"));

        assert_eq!(
            BackendClientError::Protocol("bad frame".to_string()).to_string(),
            "terminal protocol error: bad frame"
        );
        assert_eq!(
            BackendClientError::UnexpectedResponse("wrong frame".to_string()).to_string(),
            "unexpected response: wrong frame"
        );
    }

    #[test]
    fn builtin_session_uses_webui_socket_convention() {
        let _guard = env_lock().lock().unwrap();
        let base = PathBuf::from("/tmp").join(unique_name("tui-client-config"));
        std::env::set_var("XDG_CONFIG_HOME", &base);

        let client = BackendClient::builtin_session(Some("work/session"));

        assert!(client
            .api_socket()
            .ends_with("herdr-webui/builtin/work_session/herdr.sock"));
        assert!(client
            .terminal_socket()
            .ends_with("herdr-webui/builtin/work_session/herdr-client.sock"));
        let _ = fs::remove_dir_all(base);
        std::env::remove_var("XDG_CONFIG_HOME");
    }

    #[test]
    fn request_unwraps_json_rpc_result_for_tui_clients() {
        let socket = temp_socket("tui-api");
        let listener = bind_local_listener(&socket).unwrap();
        let handle = thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let mut line = String::new();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            reader.read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "session.snapshot");
            stream
                .write_all(
                    json!({ "id": request["id"], "result": { "type": "session_snapshot", "snapshot": { "workspaces": [] } } })
                        .to_string()
                        .as_bytes(),
                )
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        });

        let client = BackendClient::new(&socket, temp_socket("unused-terminal"));
        let result = client.snapshot().unwrap();

        assert_eq!(result["type"], "session_snapshot");
        handle.join().unwrap();
        let _ = fs::remove_file(socket);
    }

    #[test]
    fn request_raw_reports_closed_control_socket() {
        let socket = temp_socket("tui-api-closed");
        let listener = bind_local_listener(&socket).unwrap();
        let handle = thread::spawn(move || {
            let stream = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.contains("session.snapshot"));
            drop(stream);
        });

        let client = BackendClient::new(&socket, temp_socket("unused-terminal"));
        let err = client
            .request_raw(json!({ "id": "x", "method": "session.snapshot", "params": {} }))
            .unwrap_err()
            .to_string();

        assert!(err.contains("closed the control socket without a response"));
        handle.join().unwrap();
        let _ = fs::remove_file(socket);
    }

    #[test]
    fn request_reports_backend_errors_and_missing_results() {
        let socket = temp_socket("tui-api-error");
        let listener = bind_local_listener(&socket).unwrap();
        let handle = thread::spawn(move || {
            for response in [
                json!({ "id": "tui:ping", "error": { "message": "boom" } }),
                json!({ "id": "tui:ping" }),
            ] {
                let mut stream = listener.accept().unwrap();
                let mut line = String::new();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                reader.read_line(&mut line).unwrap();
                stream.write_all(response.to_string().as_bytes()).unwrap();
                stream.write_all(b"\n").unwrap();
                stream.flush().unwrap();
            }
        });

        let client = BackendClient::new(&socket, temp_socket("unused-terminal"));
        let backend_error = client.ping().unwrap_err().to_string();
        assert!(backend_error.contains("backend error: boom"));
        let missing_result = client.ping().unwrap_err().to_string();
        assert!(missing_result.contains("missing result in backend response"));

        handle.join().unwrap();
        let _ = fs::remove_file(socket);
    }

    #[test]
    fn api_helpers_send_expected_methods_and_params() {
        let socket = temp_socket("tui-api-methods");
        let listener = bind_local_listener(&socket).unwrap();
        let expected = vec![
            ("ping", json!({})),
            ("workspace.list", json!({})),
            (
                "workspace.create",
                json!({ "cwd": "/repo", "label": "Repo", "focus": false, "env": {} }),
            ),
            ("tab.list", json!({ "workspace_id": "ws_1" })),
            (
                "tab.create",
                json!({ "workspace_id": "ws_1", "label": "Build" }),
            ),
            ("pane.list", json!({ "workspace_id": "ws_1" })),
            ("pane.read", json!({ "pane_id": "pane_1" })),
            ("agent.list", json!({})),
            (
                "agent.start",
                json!({ "name": "jcode", "argv": ["jcode", "--help"], "cwd": "/repo" }),
            ),
            ("worktree.list", json!({ "cwd": "/repo" })),
            (
                "worktree.open",
                json!({ "path": "/repo", "branch": "main", "label": "Main" }),
            ),
            (
                "worktree.create",
                json!({ "cwd": "/repo", "branch": "feature", "base": "HEAD", "path": "/wt/feature", "label": "Feature" }),
            ),
        ];
        let expected_for_thread = expected.clone();
        let handle = thread::spawn(move || {
            for (method, params) in expected_for_thread {
                let mut stream = listener.accept().unwrap();
                let mut line = String::new();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                reader.read_line(&mut line).unwrap();
                let request: Value = serde_json::from_str(&line).unwrap();
                assert_eq!(request["method"], method);
                assert_eq!(request["params"], params);
                stream
                    .write_all(
                        json!({ "id": request["id"], "result": { "type": "ok", "method": method } })
                            .to_string()
                            .as_bytes(),
                    )
                    .unwrap();
                stream.write_all(b"\n").unwrap();
                stream.flush().unwrap();
            }
        });

        let client = BackendClient::new(&socket, temp_socket("unused-terminal"));
        assert_eq!(client.ping().unwrap()["method"], "ping");
        assert_eq!(
            client.list_workspaces().unwrap()["method"],
            "workspace.list"
        );
        assert_eq!(
            client
                .create_workspace(Some("/repo"), Some("Repo"))
                .unwrap()["method"],
            "workspace.create"
        );
        assert_eq!(
            client.list_tabs(Some("ws_1")).unwrap()["method"],
            "tab.list"
        );
        assert_eq!(
            client.create_tab(Some("ws_1"), Some("Build")).unwrap()["method"],
            "tab.create"
        );
        assert_eq!(
            client.list_panes(Some("ws_1")).unwrap()["method"],
            "pane.list"
        );
        assert_eq!(client.read_pane("pane_1").unwrap()["method"], "pane.read");
        assert_eq!(client.list_agents().unwrap()["method"], "agent.list");
        assert_eq!(
            client
                .start_agent(
                    "jcode",
                    &["jcode".to_string(), "--help".to_string()],
                    Some("/repo")
                )
                .unwrap()["method"],
            "agent.start"
        );
        assert_eq!(
            client.list_worktrees(Some("/repo")).unwrap()["method"],
            "worktree.list"
        );
        assert_eq!(
            client
                .open_worktree("/repo", Some("main"), Some("Main"))
                .unwrap()["method"],
            "worktree.open"
        );
        assert_eq!(
            client
                .create_worktree("/repo", "feature", "/wt/feature", Some("Feature"))
                .unwrap()["method"],
            "worktree.create"
        );

        handle.join().unwrap();
        let _ = fs::remove_file(socket);
    }

    #[test]
    fn socket_helpers_sanitize_and_shorten_paths() {
        let _guard = env_lock().lock().unwrap();
        let base = PathBuf::from("/tmp").join(unique_name("tui-client-long-config"));
        std::env::set_var("XDG_CONFIG_HOME", &base);

        assert_eq!(safe_socket_component("work/session:?"), "work_session__");
        assert_eq!(safe_socket_component(""), "default");
        assert_eq!(short_socket_hash("abc").len(), 16);
        assert!(socket_path_pair_fits(&(
            PathBuf::from("/tmp/a.sock"),
            PathBuf::from("/tmp/b.sock"),
        )));

        let long_session = "s".repeat(140);
        let client = BackendClient::builtin_session(Some(&long_session));
        assert!(client.api_socket().starts_with(
            short_builtin_socket_dir("")
                .parent()
                .unwrap_or(Path::new("/tmp"))
        ));
        assert!(client.api_socket().ends_with("herdr.sock"));
        assert!(client.terminal_socket().ends_with("herdr-client.sock"));

        let _ = fs::remove_dir_all(base);
        std::env::remove_var("XDG_CONFIG_HOME");
    }

    #[test]
    fn runtime_settings_path_uses_xdg_home_and_temp_fallbacks() {
        let _guard = env_lock().lock().unwrap();
        let original_xdg = std::env::var_os("XDG_CONFIG_HOME");
        let original_home = std::env::var_os("HOME");
        let xdg = PathBuf::from("/tmp").join(unique_name("xdg-config"));
        let home = PathBuf::from("/tmp").join(unique_name("home-config"));

        std::env::set_var("XDG_CONFIG_HOME", &xdg);
        std::env::set_var("HOME", &home);
        assert_eq!(
            runtime_settings_path(),
            xdg.join("herdr-webui/webui-settings.json")
        );

        std::env::remove_var("XDG_CONFIG_HOME");
        assert_eq!(
            runtime_settings_path(),
            home.join(".config/herdr-webui/webui-settings.json")
        );

        std::env::remove_var("HOME");
        assert_eq!(
            runtime_settings_path(),
            std::env::temp_dir().join("herdr-webui/webui-settings.json")
        );

        restore_env_var("XDG_CONFIG_HOME", original_xdg);
        restore_env_var("HOME", original_home);
    }

    #[test]
    fn create_worktree_from_base_sends_builtin_cwd_base_shape() {
        let socket = temp_socket("tui-worktree-create");
        let listener = bind_local_listener(&socket).unwrap();
        let handle = thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            let mut line = String::new();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            reader.read_line(&mut line).unwrap();
            let request: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(request["method"], "worktree.create");
            assert_eq!(request["params"]["cwd"], "/repo");
            assert_eq!(request["params"]["branch"], "feature/tui");
            assert_eq!(request["params"]["base"], "main");
            assert_eq!(request["params"]["path"], "/worktrees/tui");
            stream
                .write_all(
                    json!({ "id": request["id"], "result": { "type": "worktree_created" } })
                        .to_string()
                        .as_bytes(),
                )
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        });

        let client = BackendClient::new(&socket, temp_socket("unused-terminal"));
        let result = client
            .create_worktree_from_base("/repo", "feature/tui", "main", "/worktrees/tui", None)
            .unwrap();

        assert_eq!(result["type"], "worktree_created");
        handle.join().unwrap();
        let _ = fs::remove_file(socket);
    }

    #[test]
    fn terminal_attach_reports_welcome_errors_and_wrong_first_frame() {
        let socket = temp_socket("tui-term-err");
        let listener = bind_local_listener(&socket).unwrap();
        let handle = thread::spawn(move || {
            for response in [
                ServerMessage::Welcome {
                    version: BUILTIN_TUI_PROTOCOL_VERSION,
                    encoding: RenderEncoding::TerminalAnsi,
                    error: Some("terminal rejected".to_string()),
                },
                ServerMessage::ServerShutdown {
                    reason: Some("not welcome".to_string()),
                },
            ] {
                let mut stream = listener.accept().unwrap();
                match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                    .unwrap()
                {
                    ClientMessage::Hello { .. } => {}
                    other => panic!("expected hello, got {other:?}"),
                }
                write_message(&mut stream, &response).unwrap();
            }
        });

        let client = BackendClient::new(temp_socket("unused-api"), &socket);
        let protocol_err = match client.attach_terminal("term_1", 80, 24) {
            Err(err) => err,
            Ok(_) => panic!("expected terminal protocol error"),
        };
        assert_eq!(
            protocol_err.to_string(),
            "terminal protocol error: terminal rejected"
        );
        let unexpected = match client.attach_terminal("term_1", 80, 24) {
            Err(err) => err,
            Ok(_) => panic!("expected unexpected terminal response"),
        };
        assert!(unexpected
            .to_string()
            .contains("expected terminal Welcome, got ServerShutdown"));

        handle.join().unwrap();
        let _ = fs::remove_file(socket);
    }

    #[test]
    fn terminal_client_maps_non_output_events_and_ignores_control_frames() {
        let socket = temp_socket("tui-terminal-events");
        let listener = bind_local_listener(&socket).unwrap();
        let handle = thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::Hello { cols, rows, .. } => assert_eq!((cols, rows), (1, 1)),
                other => panic!("expected hello, got {other:?}"),
            }
            write_message(
                &mut stream,
                &ServerMessage::Welcome {
                    version: BUILTIN_TUI_PROTOCOL_VERSION,
                    encoding: RenderEncoding::TerminalAnsi,
                    error: None,
                },
            )
            .unwrap();
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::AttachTerminal { terminal_id, .. } => {
                    assert_eq!(terminal_id, "term_events")
                }
                other => panic!("expected attach, got {other:?}"),
            }

            let events = [
                ServerMessage::Graphics {
                    bytes: b"image".to_vec(),
                },
                ServerMessage::WindowTitle {
                    title: Some("title".to_string()),
                },
                ServerMessage::Clipboard {
                    data: "copied".to_string(),
                },
                ServerMessage::Notify {
                    kind: crate::protocol::NotifyKind::Toast,
                    message: "message".to_string(),
                    body: Some("body".to_string()),
                },
                ServerMessage::MouseCapture { enabled: true },
                ServerMessage::ServerShutdown {
                    reason: Some("done".to_string()),
                },
                ServerMessage::ReloadSoundConfig,
                ServerMessage::PrefixInputSource { active: true },
            ];
            for event in events {
                write_message(&mut stream, &event).unwrap();
            }
        });

        let client = BackendClient::new(temp_socket("unused-api"), &socket);
        let mut terminal = client.attach_terminal("term_events", 0, 0).unwrap();

        assert_eq!(terminal.size(), (1, 1));
        assert_eq!(
            terminal.read_event().unwrap(),
            TerminalEvent::Graphics(b"image".to_vec())
        );
        assert_eq!(
            terminal.read_event().unwrap(),
            TerminalEvent::WindowTitle(Some("title".to_string()))
        );
        assert_eq!(
            terminal.read_event().unwrap(),
            TerminalEvent::Clipboard("copied".to_string())
        );
        assert_eq!(
            terminal.read_event().unwrap(),
            TerminalEvent::Notify {
                message: "message".to_string(),
                body: Some("body".to_string())
            }
        );
        assert_eq!(
            terminal.read_event().unwrap(),
            TerminalEvent::MouseCapture { enabled: true }
        );
        assert_eq!(
            terminal.read_event().unwrap(),
            TerminalEvent::ServerShutdown {
                reason: Some("done".to_string())
            }
        );
        assert_eq!(terminal.read_event().unwrap(), TerminalEvent::Ignored);
        assert_eq!(terminal.read_event().unwrap(), TerminalEvent::Ignored);

        handle.join().unwrap();
        let _ = fs::remove_file(socket);
    }

    #[test]
    fn terminal_client_attaches_reads_output_writes_from_clone_and_detaches() {
        let socket = temp_socket("tui-terminal");
        let listener = bind_local_listener(&socket).unwrap();
        let (seen_tx, seen_rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::Hello { cols, rows, .. } => {
                    assert_eq!(cols, 80);
                    assert_eq!(rows, 24);
                }
                other => panic!("expected hello, got {other:?}"),
            }
            write_message(
                &mut stream,
                &ServerMessage::Welcome {
                    version: BUILTIN_TUI_PROTOCOL_VERSION,
                    encoding: RenderEncoding::TerminalAnsi,
                    error: None,
                },
            )
            .unwrap();
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::AttachTerminal { terminal_id, .. } => {
                    assert_eq!(terminal_id, "term_1")
                }
                other => panic!("expected attach, got {other:?}"),
            }
            write_message(
                &mut stream,
                &ServerMessage::Terminal(TerminalFrame {
                    seq: 7,
                    width: 80,
                    height: 24,
                    full: true,
                    bytes: b"hello tui".to_vec(),
                }),
            )
            .unwrap();
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::Resize { cols, rows, .. } => {
                    assert_eq!((cols, rows), (1, 1));
                }
                other => panic!("expected resize, got {other:?}"),
            }
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::InputEvents { events } => match &events[..] {
                    [crate::protocol::ClientInputEvent::Paste { text }] => {
                        assert_eq!(text, "terminal paste")
                    }
                    other => panic!("expected paste event, got {other:?}"),
                },
                other => panic!("expected input events, got {other:?}"),
            }
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::Resize { cols, rows, .. } => {
                    assert_eq!((cols, rows), (120, 40));
                }
                other => panic!("expected writer resize, got {other:?}"),
            }
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::InputEvents { events } => match &events[..] {
                    [crate::protocol::ClientInputEvent::Paste { text }] => {
                        assert_eq!(text, "writer paste")
                    }
                    other => panic!("expected writer paste event, got {other:?}"),
                },
                other => panic!("expected writer input events, got {other:?}"),
            }
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::Input { data } => seen_tx.send(data).unwrap(),
                other => panic!("expected input, got {other:?}"),
            }
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::Detach => {}
                other => panic!("expected detach, got {other:?}"),
            }
        });

        let client = BackendClient::new(temp_socket("unused-api"), &socket);
        let mut terminal = client.attach_terminal("term_1", 80, 24).unwrap();
        assert_eq!(terminal.size(), (80, 24));
        let output = terminal.read_output().unwrap();
        terminal.resize(0, 0).unwrap();
        assert_eq!(terminal.size(), (1, 1));
        terminal.paste_text("terminal paste").unwrap();
        let mut writer = terminal.writer().unwrap();
        assert_eq!(writer.size(), (1, 1));
        writer.resize(120, 40).unwrap();
        assert_eq!(writer.size(), (120, 40));
        writer.paste_text("writer paste").unwrap();
        writer.send_input(b"abc").unwrap();
        writer.detach().unwrap();

        assert_eq!(output.seq, 7);
        assert!(output.full);
        assert_eq!(output.bytes, b"hello tui");
        assert_eq!(seen_rx.recv().unwrap(), b"abc");
        handle.join().unwrap();
        let _ = fs::remove_file(socket);
    }

    #[test]
    fn terminal_client_direct_input_and_detach_use_protocol_frames() {
        let socket = temp_socket("tui-term-io");
        let listener = bind_local_listener(&socket).unwrap();
        let (seen_tx, seen_rx) = mpsc::channel();
        let handle = thread::spawn(move || {
            let mut stream = listener.accept().unwrap();
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::Hello { .. } => {}
                other => panic!("expected hello, got {other:?}"),
            }
            write_message(
                &mut stream,
                &ServerMessage::Welcome {
                    version: BUILTIN_TUI_PROTOCOL_VERSION,
                    encoding: RenderEncoding::TerminalAnsi,
                    error: None,
                },
            )
            .unwrap();
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::AttachTerminal { terminal_id, .. } => {
                    assert_eq!(terminal_id, "term_io")
                }
                other => panic!("expected attach, got {other:?}"),
            }
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::Input { data } => seen_tx.send(data).unwrap(),
                other => panic!("expected input, got {other:?}"),
            }
            match read_message::<_, ClientMessage>(&mut stream, MAX_TUI_TERMINAL_FRAME_SIZE)
                .unwrap()
            {
                ClientMessage::Detach => {}
                other => panic!("expected detach, got {other:?}"),
            }
        });

        let client = BackendClient::new(temp_socket("unused-api"), &socket);
        let mut terminal = client.attach_terminal("term_io", 100, 30).unwrap();
        terminal.send_input(b"direct").unwrap();
        terminal.detach().unwrap();

        assert_eq!(seen_rx.recv().unwrap(), b"direct");
        handle.join().unwrap();
        let _ = fs::remove_file(socket);
    }

    fn restore_env_var(key: &str, value: Option<std::ffi::OsString>) {
        match value {
            Some(value) => std::env::set_var(key, value),
            None => std::env::remove_var(key),
        }
    }

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    fn unique_name(prefix: &str) -> String {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{prefix}-{}-{nanos}", std::process::id())
    }

    fn temp_socket(prefix: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{}.sock", unique_name(prefix)))
    }

    fn bind_local_listener(path: &Path) -> io::Result<LocalListener> {
        let _ = fs::remove_file(path);
        #[cfg(unix)]
        {
            use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
            let name = path.to_fs_name::<GenericFilePath>()?;
            ListenerOptions::new()
                .name(name)
                .reclaim_name(false)
                .create_sync()
        }
        #[cfg(windows)]
        {
            use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};
            let name = path.to_string_lossy().to_string();
            let name = name.to_ns_name::<GenericNamespaced>()?;
            ListenerOptions::new()
                .name(name)
                .reclaim_name(false)
                .create_sync()
        }
    }
}
