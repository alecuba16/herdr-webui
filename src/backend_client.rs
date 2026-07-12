use std::fmt;
use std::io::{self, BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use interprocess::local_socket::Stream as LocalStream;
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
/// terminal streams without depending on Axum, WebSocket, DOM, or xterm.js.
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

impl TerminalClient {
    pub fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
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
    use interprocess::TryClone as _;
    use serde_json::json;

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
    fn terminal_client_attaches_reads_output_sends_input_and_detaches() {
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
        let output = terminal.read_output().unwrap();
        terminal.send_input(b"abc").unwrap();
        terminal.detach().unwrap();

        assert_eq!(output.seq, 7);
        assert!(output.full);
        assert_eq!(output.bytes, b"hello tui");
        assert_eq!(seen_rx.recv().unwrap(), b"abc");
        handle.join().unwrap();
        let _ = fs::remove_file(socket);
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
