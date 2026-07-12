use std::collections::HashMap;
use std::collections::VecDeque;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use interprocess::local_socket::traits::ListenerExt as _;
use interprocess::TryClone as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};

use crate::protocol::{
    read_message, write_message, ClientInputEvent, ClientMessage, RenderEncoding, ServerMessage,
    TerminalFrame,
};

const BUILTIN_VERSION: &str = "builtin-0.1.0";
const PROTOCOL_VERSION: u32 = 16;
const MAX_FRAME_SIZE: usize = 32 * 1024 * 1024;
const MAX_SCROLLBACK_BYTES: usize = 8 * 1024 * 1024;
const DETECTION_TAIL_BYTES: usize = 64 * 1024;
const SOCKET_PERMISSION_MODE: u32 = 0o600;

type LocalListener = interprocess::local_socket::Listener;
type LocalStream = interprocess::local_socket::Stream;

#[derive(Debug, Clone)]
pub(crate) struct BuiltinBackendConfig {
    pub api_socket: PathBuf,
    pub client_socket: PathBuf,
    pub cwd: PathBuf,
    pub shell: Option<String>,
}

pub(crate) struct BuiltinBackendHandle {
    _inner: Arc<BuiltinBackendInner>,
}

struct BuiltinBackendInner {
    running: AtomicBool,
    api_socket: PathBuf,
    client_socket: PathBuf,
    state: Arc<BuiltinState>,
}

impl Drop for BuiltinBackendInner {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        let _ = fs::remove_file(&self.api_socket);
        let _ = fs::remove_file(&self.client_socket);
    }
}

impl Drop for BuiltinBackendHandle {
    fn drop(&mut self) {
        self._inner.running.store(false, Ordering::Release);
        // Unblock listener.accept() so listener threads can observe running=false
        // and release their Arc<BuiltinBackendInner>. Without this, the listener
        // threads keep the inner alive and socket cleanup never runs until process
        // exit.
        let _ = connect_local_stream(&self._inner.api_socket);
        let _ = connect_local_stream(&self._inner.client_socket);
    }
}

impl BuiltinBackendHandle {
    pub(crate) fn start(config: BuiltinBackendConfig) -> io::Result<Self> {
        prepare_socket_path(&config.api_socket)?;
        prepare_socket_path(&config.client_socket)?;
        let api_listener = bind_local_listener(&config.api_socket)?;
        let client_listener = bind_local_listener(&config.client_socket)?;
        restrict_socket_permissions(&config.api_socket)?;
        restrict_socket_permissions(&config.client_socket)?;

        let state = Arc::new(BuiltinState::new(config.cwd, config.shell)?);
        let inner = Arc::new(BuiltinBackendInner {
            running: AtomicBool::new(true),
            api_socket: config.api_socket,
            client_socket: config.client_socket,
            state,
        });
        spawn_api_listener(api_listener, Arc::clone(&inner));
        spawn_client_listener(client_listener, Arc::clone(&inner));
        Ok(Self { _inner: inner })
    }

    pub(crate) fn api_socket(&self) -> &Path {
        &self._inner.api_socket
    }

    pub(crate) fn client_socket(&self) -> &Path {
        &self._inner.client_socket
    }
}

fn spawn_api_listener(listener: LocalListener, backend: Arc<BuiltinBackendInner>) {
    thread::spawn(move || {
        for stream in listener.incoming() {
            if !backend.running.load(Ordering::Acquire) {
                break;
            }
            match stream {
                Ok(stream) => {
                    let backend = Arc::clone(&backend);
                    thread::spawn(move || {
                        if let Err(err) = handle_api_connection(stream, backend) {
                            eprintln!("builtin backend api connection failed: {err}");
                        }
                    });
                }
                Err(err) => {
                    eprintln!("builtin backend api accept failed: {err}");
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    });
}

fn spawn_client_listener(listener: LocalListener, backend: Arc<BuiltinBackendInner>) {
    thread::spawn(move || {
        for stream in listener.incoming() {
            if !backend.running.load(Ordering::Acquire) {
                break;
            }
            match stream {
                Ok(stream) => {
                    let backend = Arc::clone(&backend);
                    thread::spawn(move || {
                        if let Err(err) = handle_client_connection(stream, backend) {
                            eprintln!("builtin backend terminal connection failed: {err}");
                        }
                    });
                }
                Err(err) => {
                    eprintln!("builtin backend terminal accept failed: {err}");
                    thread::sleep(Duration::from_millis(50));
                }
            }
        }
    });
}

fn handle_api_connection(
    mut stream: LocalStream,
    backend: Arc<BuiltinBackendInner>,
) -> io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    if reader.read_line(&mut line)? == 0 || line.trim().is_empty() {
        return Ok(());
    }
    let request: Value = match serde_json::from_str(&line) {
        Ok(value) => value,
        Err(err) => {
            write_json_line(
                &mut stream,
                &error_response("", "invalid_request", err.to_string()),
            )?;
            return Ok(());
        }
    };
    let id = request
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("builtin")
        .to_string();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    if method == "events.subscribe" {
        write_json_line(
            &mut stream,
            &success_response(&id, json!({ "type": "subscription_started" })),
        )?;
        // Built-in MVP does not have an event hub yet. Close the subscription
        // after the ack so the WebUI bridge thread can exit and keep using its
        // existing 5s snapshot polling instead of leaking one blocked thread per
        // browser reconnect.
        return Ok(());
    }

    let response = backend.state.handle_request(&id, method, params);
    if method == "server.stop" {
        backend.running.store(false, Ordering::Release);
    }
    write_json_line(&mut stream, &response)
}

fn handle_client_connection(
    mut stream: LocalStream,
    backend: Arc<BuiltinBackendInner>,
) -> Result<(), String> {
    let hello = read_message::<_, ClientMessage>(&mut stream, MAX_FRAME_SIZE)?;
    let (cols, rows, requested_encoding) = match hello {
        ClientMessage::Hello {
            version,
            cols,
            rows,
            requested_encoding,
            ..
        } => {
            let error = (version > PROTOCOL_VERSION).then(|| {
                format!("client version {version} is newer than server version {PROTOCOL_VERSION}")
            });
            write_message(
                &mut stream,
                &ServerMessage::Welcome {
                    version: PROTOCOL_VERSION,
                    encoding: RenderEncoding::TerminalAnsi,
                    error,
                },
            )?;
            if version > PROTOCOL_VERSION {
                return Ok(());
            }
            (cols.max(1), rows.max(1), requested_encoding)
        }
        _ => return Err("expected Hello as first terminal client message".to_string()),
    };
    let _ = requested_encoding;

    let mut attached: Option<Arc<TerminalRuntime>> = None;
    let mut writer_started = false;
    let mut seq = 1_u64;
    let terminal_size = Arc::new(Mutex::new((cols, rows)));
    loop {
        let message = match read_message::<_, ClientMessage>(&mut stream, MAX_FRAME_SIZE) {
            Ok(message) => message,
            Err(err) => return Err(err),
        };
        match message {
            ClientMessage::AttachTerminal { terminal_id, .. } => {
                let terminal = backend
                    .state
                    .terminal(&terminal_id)
                    .ok_or_else(|| format!("terminal {terminal_id} not found"))?;
                terminal.resize(rows, cols);
                let history = terminal.history_bytes();
                write_message(
                    &mut stream,
                    &ServerMessage::Terminal(TerminalFrame {
                        seq,
                        width: cols,
                        height: rows,
                        full: true,
                        bytes: history,
                    }),
                )?;
                seq += 1;
                if !writer_started {
                    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(256);
                    terminal.subscribe(tx);
                    let mut writer = stream.try_clone().map_err(|err| err.to_string())?;
                    let terminal_size = Arc::clone(&terminal_size);
                    thread::spawn(move || {
                        let mut seq = seq;
                        while let Ok(bytes) = rx.recv() {
                            let (width, height) = terminal_size
                                .lock()
                                .map(|size| *size)
                                .unwrap_or((cols, rows));
                            let frame = ServerMessage::Terminal(TerminalFrame {
                                seq,
                                width,
                                height,
                                full: false,
                                bytes,
                            });
                            seq += 1;
                            if write_message(&mut writer, &frame).is_err() {
                                break;
                            }
                        }
                    });
                    writer_started = true;
                }
                attached = Some(terminal);
            }
            ClientMessage::Input { data } => {
                if let Some(terminal) = &attached {
                    terminal.write_input(&data).map_err(|err| err.to_string())?;
                }
            }
            ClientMessage::InputEvents { events } => {
                if let Some(terminal) = &attached {
                    for event in events {
                        if let ClientInputEvent::Paste { text } = event {
                            terminal
                                .write_input(text.as_bytes())
                                .map_err(|err| err.to_string())?;
                        }
                    }
                }
            }
            ClientMessage::Resize { cols, rows, .. } => {
                if let Ok(mut size) = terminal_size.lock() {
                    *size = (cols.max(1), rows.max(1));
                }
                if let Some(terminal) = &attached {
                    terminal.resize(rows.max(1), cols.max(1));
                }
            }
            ClientMessage::AttachScroll { .. } => {
                // Built-in MVP keeps xterm.js as the scrollback renderer. The web
                // adapter will fall back to local scrolling for this backend.
            }
            ClientMessage::Detach => break,
            ClientMessage::ClipboardImage { .. } => {}
            ClientMessage::Hello { .. } => {}
        }
    }
    Ok(())
}

struct BuiltinState {
    data: Mutex<BuiltinData>,
    default_shell: String,
}

struct BuiltinData {
    next_id: u64,
    workspaces: HashMap<String, WorkspaceRecord>,
    tabs: HashMap<String, TabRecord>,
    panes: HashMap<String, PaneRecord>,
    terminals: HashMap<String, Arc<TerminalRuntime>>,
    focused_workspace_id: Option<String>,
    focused_tab_id: Option<String>,
    focused_pane_id: Option<String>,
}

#[derive(Clone)]
struct WorkspaceRecord {
    workspace_id: String,
    label: String,
    cwd: PathBuf,
    tab_ids: Vec<String>,
}

#[derive(Clone)]
struct TabRecord {
    tab_id: String,
    workspace_id: String,
    label: String,
    pane_ids: Vec<String>,
}

#[derive(Clone)]
struct PaneRecord {
    pane_id: String,
    terminal_id: String,
    workspace_id: String,
    tab_id: String,
    cwd: PathBuf,
    label: Option<String>,
    argv: Vec<String>,
}

impl BuiltinState {
    fn new(cwd: PathBuf, shell: Option<String>) -> io::Result<Self> {
        let default_shell = shell.unwrap_or_else(default_shell);
        let state = Self {
            data: Mutex::new(BuiltinData {
                next_id: 1,
                workspaces: HashMap::new(),
                tabs: HashMap::new(),
                panes: HashMap::new(),
                terminals: HashMap::new(),
                focused_workspace_id: None,
                focused_tab_id: None,
                focused_pane_id: None,
            }),
            default_shell,
        };
        state
            .create_workspace(Some(cwd), Some("Workspace".to_string()), true)
            .map_err(io::Error::other)?;
        Ok(state)
    }

    fn handle_request(&self, id: &str, method: &str, params: Value) -> Value {
        match self.handle_request_inner(method, params) {
            Ok(result) => success_response(id, result),
            Err(err) => error_response(id, "builtin_error", err),
        }
    }

    fn handle_request_inner(&self, method: &str, params: Value) -> Result<Value, String> {
        match method {
            "ping" => Ok(json!({
                "type": "pong",
                "version": BUILTIN_VERSION,
                "protocol": PROTOCOL_VERSION,
                "capabilities": {
                    "live_handoff": false,
                    "detached_server_daemon": false,
                    "builtin_backend": true,
                    "terminal_attach": true,
                    "terminal_server_scroll": false,
                    "jcode_detection": true
                }
            })),
            "server.stop" => Ok(json!({ "type": "ok" })),
            "session.snapshot" => {
                Ok(json!({ "type": "session_snapshot", "snapshot": self.snapshot()? }))
            }
            "workspace.list" => {
                Ok(json!({ "type": "workspace_list", "workspaces": self.workspace_list()? }))
            }
            "workspace.create" => {
                let cwd = optional_string(&params, "cwd").map(PathBuf::from);
                let label = optional_string(&params, "label");
                let workspace = self.create_workspace(cwd, label, false)?;
                let tab = self
                    .tabs_for_workspace(
                        &workspace["workspace_id"]
                            .as_str()
                            .unwrap_or_default()
                            .to_string(),
                    )?
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| json!({}));
                let pane = self
                    .panes_for_tab(tab["tab_id"].as_str().unwrap_or_default())?
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| json!({}));
                Ok(
                    json!({ "type": "workspace_created", "workspace": workspace, "tab": tab, "root_pane": pane }),
                )
            }
            "workspace.rename" => {
                let workspace_id = required_string(&params, "workspace_id")?;
                let label = required_string(&params, "label")?;
                let workspace = self.rename_workspace(&workspace_id, label)?;
                Ok(json!({ "type": "workspace_info", "workspace": workspace }))
            }
            "workspace.close" => {
                let workspace_id = required_string(&params, "workspace_id")?;
                self.close_workspace(&workspace_id)?;
                Ok(json!({ "type": "ok" }))
            }
            "tab.list" => Ok(
                json!({ "type": "tab_list", "tabs": self.tab_list(optional_string(&params, "workspace_id"))? }),
            ),
            "tab.create" => {
                let workspace_id = optional_string(&params, "workspace_id");
                let label = optional_string(&params, "label");
                let (tab, root_pane) = self.create_tab(workspace_id, label)?;
                Ok(json!({ "type": "tab_created", "tab": tab, "root_pane": root_pane }))
            }
            "tab.rename" => {
                let tab_id = required_string(&params, "tab_id")?;
                let label = required_string(&params, "label")?;
                let tab = self.rename_tab(&tab_id, label)?;
                Ok(json!({ "type": "tab_info", "tab": tab }))
            }
            "tab.close" => {
                let tab_id = required_string(&params, "tab_id")?;
                self.close_tab(&tab_id)?;
                Ok(json!({ "type": "ok" }))
            }
            "pane.list" => Ok(
                json!({ "type": "pane_list", "panes": self.pane_list(optional_string(&params, "workspace_id"))? }),
            ),
            "pane.get" => {
                let pane_id = required_string(&params, "pane_id")?;
                Ok(json!({ "type": "pane_info", "pane": self.pane_info_by_id(&pane_id)? }))
            }
            "pane.layout" => Ok(
                json!({ "type": "pane_layout", "layout": self.layout(optional_string(&params, "pane_id"))? }),
            ),
            "pane.close" => {
                let pane_id = required_string(&params, "pane_id")?;
                self.close_pane(&pane_id)?;
                Ok(json!({ "type": "ok" }))
            }
            "agent.list" => Ok(json!({ "type": "agent_list", "agents": self.agent_list()? })),
            "agent.start" => {
                let name = required_string(&params, "name")?;
                let argv = params
                    .get("argv")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let cwd = optional_string(&params, "cwd").map(PathBuf::from);
                let (agent, argv) = self.start_agent(name, argv, cwd)?;
                Ok(json!({ "type": "agent_started", "agent": agent, "argv": argv }))
            }
            "worktree.list" => self.worktree_list(optional_string(&params, "cwd")),
            "worktree.open" => self.worktree_open(params),
            "worktree.create" => self.worktree_create(params),
            "worktree.remove" => Err(
                "built-in backend does not implement worktree.remove yet; use remove-path fallback"
                    .to_string(),
            ),
            "pane.read" => {
                let pane_id = required_string(&params, "pane_id")?;
                let text = self.read_pane_recent(&pane_id)?;
                Ok(
                    json!({ "type": "pane_read", "read": { "pane_id": pane_id, "text": text, "format": "text" } }),
                )
            }
            other => Err(format!("built-in backend does not implement {other}")),
        }
    }

    fn terminal(&self, terminal_id: &str) -> Option<Arc<TerminalRuntime>> {
        self.data
            .lock()
            .ok()
            .and_then(|data| data.terminals.get(terminal_id).cloned())
    }

    fn create_workspace(
        &self,
        cwd: Option<PathBuf>,
        label: Option<String>,
        focus: bool,
    ) -> Result<Value, String> {
        let cwd =
            cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        let workspace_id = next_id(&mut data, "ws");
        let tab_id = next_id(&mut data, "tab");
        let pane_id = next_id(&mut data, "pane");
        let terminal_id = next_id(&mut data, "term");
        let terminal = TerminalRuntime::spawn(
            terminal_id.clone(),
            cwd.clone(),
            vec![self.default_shell.clone()],
            30,
            100,
        )
        .map_err(|err| err.to_string())?;
        data.workspaces.insert(
            workspace_id.clone(),
            WorkspaceRecord {
                workspace_id: workspace_id.clone(),
                label: label.unwrap_or_else(|| workspace_label(&cwd)),
                cwd: cwd.clone(),
                tab_ids: vec![tab_id.clone()],
            },
        );
        data.tabs.insert(
            tab_id.clone(),
            TabRecord {
                tab_id: tab_id.clone(),
                workspace_id: workspace_id.clone(),
                label: "Shell".to_string(),
                pane_ids: vec![pane_id.clone()],
            },
        );
        data.panes.insert(
            pane_id.clone(),
            PaneRecord {
                pane_id: pane_id.clone(),
                terminal_id: terminal_id.clone(),
                workspace_id: workspace_id.clone(),
                tab_id: tab_id.clone(),
                cwd,
                label: None,
                argv: vec![self.default_shell.clone()],
            },
        );
        data.terminals.insert(terminal_id, terminal);
        if focus || data.focused_workspace_id.is_none() {
            data.focused_workspace_id = Some(workspace_id.clone());
            data.focused_tab_id = Some(tab_id);
            data.focused_pane_id = Some(pane_id);
        }
        let workspace = data
            .workspaces
            .get(&workspace_id)
            .map(|workspace| workspace_json(workspace, &data))
            .unwrap_or_else(|| json!({}));
        Ok(workspace)
    }

    fn create_tab(
        &self,
        workspace_id: Option<String>,
        label: Option<String>,
    ) -> Result<(Value, Value), String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        let workspace_id = workspace_id
            .or_else(|| data.focused_workspace_id.clone())
            .ok_or_else(|| "no workspace".to_string())?;
        let cwd = data
            .workspaces
            .get(&workspace_id)
            .map(|workspace| workspace.cwd.clone())
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        let tab_id = next_id(&mut data, "tab");
        let pane_id = next_id(&mut data, "pane");
        let terminal_id = next_id(&mut data, "term");
        let terminal = TerminalRuntime::spawn(
            terminal_id.clone(),
            cwd.clone(),
            vec![self.default_shell.clone()],
            30,
            100,
        )
        .map_err(|err| err.to_string())?;
        data.tabs.insert(
            tab_id.clone(),
            TabRecord {
                tab_id: tab_id.clone(),
                workspace_id: workspace_id.clone(),
                label: label.unwrap_or_else(|| "Shell".to_string()),
                pane_ids: vec![pane_id.clone()],
            },
        );
        if let Some(workspace) = data.workspaces.get_mut(&workspace_id) {
            workspace.tab_ids.push(tab_id.clone());
        }
        data.panes.insert(
            pane_id.clone(),
            PaneRecord {
                pane_id: pane_id.clone(),
                terminal_id: terminal_id.clone(),
                workspace_id: workspace_id.clone(),
                tab_id: tab_id.clone(),
                cwd,
                label: None,
                argv: vec![self.default_shell.clone()],
            },
        );
        data.terminals.insert(terminal_id, terminal);
        data.focused_workspace_id = Some(workspace_id);
        data.focused_tab_id = Some(tab_id.clone());
        data.focused_pane_id = Some(pane_id.clone());
        let tab = tab_json(data.tabs.get(&tab_id).unwrap(), &data);
        let pane = pane_json(data.panes.get(&pane_id).unwrap(), &data);
        Ok((tab, pane))
    }

    fn start_agent(
        &self,
        name: String,
        argv: Vec<String>,
        cwd: Option<PathBuf>,
    ) -> Result<(Value, Vec<String>), String> {
        let argv = if argv.is_empty() {
            vec![name.clone()]
        } else {
            argv
        };
        let cwd =
            cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        let workspace_id = next_id(&mut data, "ws");
        let tab_id = next_id(&mut data, "tab");
        let pane_id = next_id(&mut data, "pane");
        let terminal_id = next_id(&mut data, "term");
        let terminal =
            TerminalRuntime::spawn(terminal_id.clone(), cwd.clone(), argv.clone(), 30, 100)
                .map_err(|err| err.to_string())?;
        data.workspaces.insert(
            workspace_id.clone(),
            WorkspaceRecord {
                workspace_id: workspace_id.clone(),
                label: name.clone(),
                cwd: cwd.clone(),
                tab_ids: vec![tab_id.clone()],
            },
        );
        data.tabs.insert(
            tab_id.clone(),
            TabRecord {
                tab_id: tab_id.clone(),
                workspace_id: workspace_id.clone(),
                label: name.clone(),
                pane_ids: vec![pane_id.clone()],
            },
        );
        data.panes.insert(
            pane_id.clone(),
            PaneRecord {
                pane_id: pane_id.clone(),
                terminal_id: terminal_id.clone(),
                workspace_id: workspace_id.clone(),
                tab_id: tab_id.clone(),
                cwd,
                label: Some(name),
                argv: argv.clone(),
            },
        );
        data.terminals.insert(terminal_id, terminal);
        data.focused_workspace_id = Some(workspace_id);
        data.focused_tab_id = Some(tab_id);
        data.focused_pane_id = Some(pane_id.clone());
        let pane = data.panes.get(&pane_id).unwrap();
        Ok((agent_json(pane, &data), argv))
    }

    fn snapshot(&self) -> Result<Value, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(json!({
            "version": BUILTIN_VERSION,
            "protocol": PROTOCOL_VERSION,
            "focused_workspace_id": data.focused_workspace_id,
            "focused_tab_id": data.focused_tab_id,
            "focused_pane_id": data.focused_pane_id,
            "workspaces": workspace_list_json(&data),
            "tabs": tab_list_json(&data, None),
            "panes": pane_list_json(&data, None),
            "layouts": layout_list_json(&data),
            "agents": agent_list_json(&data),
        }))
    }

    fn workspace_list(&self) -> Result<Vec<Value>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(workspace_list_json(&data))
    }

    fn tab_list(&self, workspace_id: Option<String>) -> Result<Vec<Value>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(tab_list_json(&data, workspace_id.as_deref()))
    }

    fn pane_list(&self, workspace_id: Option<String>) -> Result<Vec<Value>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(pane_list_json(&data, workspace_id.as_deref()))
    }

    fn agent_list(&self) -> Result<Vec<Value>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(agent_list_json(&data))
    }

    fn layout(&self, pane_id: Option<String>) -> Result<Value, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        let tab_id = pane_id
            .as_deref()
            .and_then(|pane_id| data.panes.get(pane_id).map(|pane| pane.tab_id.clone()))
            .or_else(|| data.focused_tab_id.clone())
            .ok_or_else(|| "no focused tab".to_string())?;
        let tab = data
            .tabs
            .get(&tab_id)
            .ok_or_else(|| format!("tab {tab_id} not found"))?;
        Ok(layout_json(tab, &data))
    }

    fn tabs_for_workspace(&self, workspace_id: &str) -> Result<Vec<Value>, String> {
        self.tab_list(Some(workspace_id.to_string()))
    }

    fn panes_for_tab(&self, tab_id: &str) -> Result<Vec<Value>, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        Ok(data
            .tabs
            .get(tab_id)
            .map(|tab| {
                tab.pane_ids
                    .iter()
                    .filter_map(|pane_id| data.panes.get(pane_id))
                    .map(|pane| pane_json(pane, &data))
                    .collect()
            })
            .unwrap_or_default())
    }

    fn pane_info_by_id(&self, pane_id: &str) -> Result<Value, String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        data.panes
            .get(pane_id)
            .map(|pane| pane_json(pane, &data))
            .ok_or_else(|| format!("pane {pane_id} not found"))
    }

    fn rename_workspace(&self, workspace_id: &str, label: String) -> Result<Value, String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        if let Some(workspace) = data.workspaces.get_mut(workspace_id) {
            workspace.label = label;
        } else {
            return Err(format!("workspace {workspace_id} not found"));
        }
        let workspace = data
            .workspaces
            .get(workspace_id)
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        Ok(workspace_json(workspace, &data))
    }

    fn rename_tab(&self, tab_id: &str, label: String) -> Result<Value, String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        if let Some(tab) = data.tabs.get_mut(tab_id) {
            tab.label = label;
        } else {
            return Err(format!("tab {tab_id} not found"));
        }
        let tab = data
            .tabs
            .get(tab_id)
            .ok_or_else(|| format!("tab {tab_id} not found"))?;
        Ok(tab_json(tab, &data))
    }

    fn close_workspace(&self, workspace_id: &str) -> Result<(), String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        let workspace = data
            .workspaces
            .remove(workspace_id)
            .ok_or_else(|| format!("workspace {workspace_id} not found"))?;
        for tab_id in workspace.tab_ids {
            close_tab_locked(&mut data, &tab_id);
        }
        normalize_focus(&mut data);
        Ok(())
    }

    fn close_tab(&self, tab_id: &str) -> Result<(), String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        close_tab_locked(&mut data, tab_id);
        normalize_focus(&mut data);
        Ok(())
    }

    fn close_pane(&self, pane_id: &str) -> Result<(), String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        close_pane_locked(&mut data, pane_id);
        normalize_focus(&mut data);
        Ok(())
    }

    fn read_pane_recent(&self, pane_id: &str) -> Result<String, String> {
        let terminal = {
            let data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            let pane = data
                .panes
                .get(pane_id)
                .ok_or_else(|| format!("pane {pane_id} not found"))?;
            data.terminals.get(&pane.terminal_id).cloned()
        }
        .ok_or_else(|| "terminal not found".to_string())?;
        Ok(String::from_utf8_lossy(&terminal.history_bytes()).to_string())
    }

    fn worktree_list(&self, cwd: Option<String>) -> Result<Value, String> {
        let cwd = cwd
            .map(PathBuf::from)
            .or_else(|| {
                self.data.lock().ok().and_then(|data| {
                    data.focused_workspace_id
                        .as_ref()
                        .and_then(|id| data.workspaces.get(id))
                        .map(|ws| ws.cwd.clone())
                })
            })
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let repo_root = git_output(&cwd, &["rev-parse", "--show-toplevel"])
            .unwrap_or_else(|_| cwd.to_string_lossy().to_string());
        let repo_name = Path::new(&repo_root)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("repo")
            .to_string();
        let list = git_output(Path::new(&repo_root), &["worktree", "list", "--porcelain"])
            .unwrap_or_default();
        let worktrees = parse_git_worktrees(&list);
        Ok(json!({
            "type": "worktree_list",
            "source": {
                "repo_key": repo_root,
                "repo_name": repo_name,
                "repo_root": repo_root,
                "source_checkout_path": cwd.to_string_lossy(),
                "source_workspace_id": null,
            },
            "worktrees": worktrees,
        }))
    }

    fn worktree_open(&self, params: Value) -> Result<Value, String> {
        let path = optional_string(&params, "path")
            .or_else(|| optional_string(&params, "cwd"))
            .ok_or_else(|| "path or cwd is required".to_string())?;
        let label = optional_string(&params, "label");
        let workspace = self.create_workspace(Some(PathBuf::from(&path)), label, true)?;
        let workspace_id = workspace["workspace_id"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let tab = self
            .tabs_for_workspace(&workspace_id)?
            .into_iter()
            .next()
            .unwrap_or_else(|| json!({}));
        let pane = self
            .panes_for_tab(tab["tab_id"].as_str().unwrap_or_default())?
            .into_iter()
            .next()
            .unwrap_or_else(|| json!({}));
        Ok(json!({
            "type": "worktree_opened",
            "workspace": workspace,
            "tab": tab,
            "root_pane": pane,
            "worktree": { "path": path, "branch": optional_string(&params, "branch"), "is_bare": false, "is_detached": false, "is_prunable": false, "is_linked_worktree": true, "open_workspace_id": workspace_id, "label": workspace_id },
            "already_open": false,
        }))
    }

    fn worktree_create(&self, params: Value) -> Result<Value, String> {
        let cwd = optional_string(&params, "cwd")
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| "cwd is required".to_string())?;
        let branch =
            optional_string(&params, "branch").unwrap_or_else(|| format!("webui-{}", now_ms()));
        let base = optional_string(&params, "base").unwrap_or_else(|| "HEAD".to_string());
        let path = optional_string(&params, "path")
            .map(PathBuf::from)
            .unwrap_or_else(|| cwd.parent().unwrap_or_else(|| Path::new(".")).join(&branch));
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|err| err.to_string())?;
        }
        run_git(
            &cwd,
            &[
                "worktree",
                "add",
                "-b",
                &branch,
                &path.to_string_lossy(),
                &base,
            ],
        )?;
        self.worktree_open(json!({ "path": path.to_string_lossy(), "branch": branch, "label": optional_string(&params, "label") }))
            .map(|mut value| {
                if let Some(object) = value.as_object_mut() {
                    object.insert("type".to_string(), json!("worktree_created"));
                }
                value
            })
    }
}

struct TerminalRuntime {
    _id: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    writer: Mutex<Box<dyn Write + Send>>,
    scrollback: Mutex<VecDeque<u8>>,
    subscribers: Mutex<Vec<mpsc::SyncSender<Vec<u8>>>>,
}

impl TerminalRuntime {
    fn spawn(
        id: String,
        cwd: PathBuf,
        argv: Vec<String>,
        rows: u16,
        cols: u16,
    ) -> io::Result<Arc<Self>> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| io::Error::other(err.to_string()))?;
        let mut command = CommandBuilder::new(argv.first().cloned().unwrap_or_else(default_shell));
        for arg in argv.iter().skip(1) {
            command.arg(arg);
        }
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|err| io::Error::other(err.to_string()))?;
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| io::Error::other(err.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|err| io::Error::other(err.to_string()))?;
        let runtime = Arc::new(Self {
            _id: id,
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            writer: Mutex::new(writer),
            scrollback: Mutex::new(VecDeque::new()),
            subscribers: Mutex::new(Vec::new()),
        });
        let runtime_for_reader = Arc::clone(&runtime);
        thread::spawn(move || {
            let mut buf = [0_u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => runtime_for_reader.append_output(&buf[..n]),
                    Err(_) => break,
                }
            }
        });
        Ok(runtime)
    }

    fn write_input(&self, bytes: &[u8]) -> io::Result<()> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| io::Error::other("terminal writer unavailable"))?;
        writer.write_all(bytes)?;
        writer.flush()
    }

    fn resize(&self, rows: u16, cols: u16) {
        if let Ok(master) = self.master.lock() {
            let _ = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            });
        }
    }

    fn subscribe(&self, tx: mpsc::SyncSender<Vec<u8>>) {
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.push(tx);
        }
    }

    fn history_bytes(&self) -> Vec<u8> {
        self.scrollback
            .lock()
            .map(|scrollback| scrollback.iter().copied().collect())
            .unwrap_or_default()
    }

    fn history_tail_text(&self, max_bytes: usize) -> String {
        let bytes = self
            .scrollback
            .lock()
            .map(|scrollback| {
                let mut bytes = scrollback
                    .iter()
                    .rev()
                    .take(max_bytes)
                    .copied()
                    .collect::<Vec<_>>();
                bytes.reverse();
                bytes
            })
            .unwrap_or_default();
        strip_ansi_lossy(&String::from_utf8_lossy(&bytes))
    }

    fn append_output(&self, bytes: &[u8]) {
        if let Ok(mut scrollback) = self.scrollback.lock() {
            scrollback.extend(bytes.iter().copied());
            let overflow = scrollback.len().saturating_sub(MAX_SCROLLBACK_BYTES);
            for _ in 0..overflow {
                scrollback.pop_front();
            }
        }
        if let Ok(mut subscribers) = self.subscribers.lock() {
            let payload = bytes.to_vec();
            subscribers.retain(|tx| match tx.try_send(payload.clone()) {
                Ok(()) => true,
                Err(mpsc::TrySendError::Full(_)) => false,
                Err(mpsc::TrySendError::Disconnected(_)) => false,
            });
        }
    }
}

impl Drop for TerminalRuntime {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

fn workspace_list_json(data: &BuiltinData) -> Vec<Value> {
    let mut workspaces = data.workspaces.values().collect::<Vec<_>>();
    workspaces.sort_by_key(|workspace| workspace.workspace_id.clone());
    workspaces
        .into_iter()
        .map(|workspace| workspace_json(workspace, data))
        .collect()
}

fn tab_list_json(data: &BuiltinData, workspace_id: Option<&str>) -> Vec<Value> {
    let mut tabs = data.tabs.values().collect::<Vec<_>>();
    tabs.sort_by_key(|tab| tab.tab_id.clone());
    tabs.into_iter()
        .filter(|tab| workspace_id.is_none_or(|workspace_id| tab.workspace_id == workspace_id))
        .map(|tab| tab_json(tab, data))
        .collect()
}

fn pane_list_json(data: &BuiltinData, workspace_id: Option<&str>) -> Vec<Value> {
    let mut panes = data.panes.values().collect::<Vec<_>>();
    panes.sort_by_key(|pane| pane.pane_id.clone());
    panes
        .into_iter()
        .filter(|pane| workspace_id.is_none_or(|workspace_id| pane.workspace_id == workspace_id))
        .map(|pane| pane_json(pane, data))
        .collect()
}

fn agent_list_json(data: &BuiltinData) -> Vec<Value> {
    data.panes
        .values()
        .filter(|pane| pane.label.is_some() || pane_agent_presentation(pane, data).agent.is_some())
        .map(|pane| agent_json(pane, data))
        .collect()
}

fn layout_list_json(data: &BuiltinData) -> Vec<Value> {
    data.tabs
        .values()
        .map(|tab| layout_json(tab, data))
        .collect()
}

fn workspace_json(workspace: &WorkspaceRecord, data: &BuiltinData) -> Value {
    let pane_count = workspace
        .tab_ids
        .iter()
        .filter_map(|tab_id| data.tabs.get(tab_id))
        .map(|tab| tab.pane_ids.len())
        .sum::<usize>();
    json!({
        "workspace_id": workspace.workspace_id,
        "number": numeric_suffix(&workspace.workspace_id),
        "label": workspace.label,
        "focused": data.focused_workspace_id.as_deref() == Some(&workspace.workspace_id),
        "pane_count": pane_count,
        "tab_count": workspace.tab_ids.len(),
        "active_tab_id": workspace.tab_ids.first().cloned().unwrap_or_default(),
        "agent_status": aggregate_workspace_agent_status(workspace, data),
        "cwd": workspace.cwd.to_string_lossy(),
        "foreground_cwd": workspace.cwd.to_string_lossy(),
    })
}

fn tab_json(tab: &TabRecord, data: &BuiltinData) -> Value {
    json!({
        "tab_id": tab.tab_id,
        "workspace_id": tab.workspace_id,
        "number": numeric_suffix(&tab.tab_id),
        "label": tab.label,
        "focused": data.focused_tab_id.as_deref() == Some(&tab.tab_id),
        "pane_count": tab.pane_ids.len(),
        "agent_status": aggregate_tab_agent_status(tab, data),
    })
}

fn pane_json(pane: &PaneRecord, data: &BuiltinData) -> Value {
    let presentation = pane_agent_presentation(pane, data);
    json!({
        "pane_id": pane.pane_id,
        "terminal_id": pane.terminal_id,
        "workspace_id": pane.workspace_id,
        "tab_id": pane.tab_id,
        "focused": data.focused_pane_id.as_deref() == Some(&pane.pane_id),
        "cwd": pane.cwd.to_string_lossy(),
        "foreground_cwd": pane.cwd.to_string_lossy(),
        "label": pane.label,
        "agent": presentation.agent,
        "title": pane.label,
        "display_agent": presentation.agent,
        "agent_status": presentation.status,
        "custom_status": null,
        "state_labels": {},
        "agent_session": null,
        "scroll": null,
        "revision": 0,
    })
}

fn agent_json(pane: &PaneRecord, data: &BuiltinData) -> Value {
    let presentation = pane_agent_presentation(pane, data);
    json!({
        "terminal_id": pane.terminal_id,
        "name": pane.label,
        "agent": presentation.agent,
        "title": pane.label,
        "display_agent": presentation.agent,
        "agent_status": presentation.status,
        "screen_detection_skipped": false,
        "custom_status": null,
        "state_labels": {},
        "agent_session": null,
        "workspace_id": pane.workspace_id,
        "tab_id": pane.tab_id,
        "pane_id": pane.pane_id,
        "focused": data.focused_pane_id.as_deref() == Some(&pane.pane_id),
        "cwd": pane.cwd.to_string_lossy(),
        "foreground_cwd": pane.cwd.to_string_lossy(),
        "revision": 0,
    })
}

fn layout_json(tab: &TabRecord, data: &BuiltinData) -> Value {
    let panes = tab
        .pane_ids
        .iter()
        .filter_map(|pane_id| data.panes.get(pane_id))
        .enumerate()
        .map(|(index, pane)| {
            json!({
                "pane_id": pane.pane_id,
                "focused": data.focused_pane_id.as_deref() == Some(&pane.pane_id),
                "rect": { "x": 0, "y": index as u16 * 10, "width": 100, "height": 30 },
            })
        })
        .collect::<Vec<_>>();
    json!({
        "workspace_id": tab.workspace_id,
        "tab_id": tab.tab_id,
        "zoomed": false,
        "area": { "x": 0, "y": 0, "width": 100, "height": 30 },
        "focused_pane_id": data.focused_pane_id,
        "panes": panes,
        "splits": [],
    })
}

#[derive(Clone, Copy)]
struct PaneAgentPresentation {
    agent: Option<&'static str>,
    status: &'static str,
}

fn pane_agent_presentation(pane: &PaneRecord, data: &BuiltinData) -> PaneAgentPresentation {
    let tail = data
        .terminals
        .get(&pane.terminal_id)
        .map(|terminal| terminal.history_tail_text(DETECTION_TAIL_BYTES))
        .unwrap_or_default();
    let agent = detect_agent_label(&pane.argv).or_else(|| detect_agent_label_from_text(&tail));
    let status = detect_agent_status(agent, &tail);
    PaneAgentPresentation { agent, status }
}

fn aggregate_workspace_agent_status(
    workspace: &WorkspaceRecord,
    data: &BuiltinData,
) -> &'static str {
    let statuses = workspace
        .tab_ids
        .iter()
        .filter_map(|tab_id| data.tabs.get(tab_id))
        .flat_map(|tab| tab.pane_ids.iter())
        .filter_map(|pane_id| data.panes.get(pane_id))
        .map(|pane| pane_agent_presentation(pane, data).status);
    strongest_agent_status(statuses)
}

fn aggregate_tab_agent_status(tab: &TabRecord, data: &BuiltinData) -> &'static str {
    strongest_agent_status(
        tab.pane_ids
            .iter()
            .filter_map(|pane_id| data.panes.get(pane_id))
            .map(|pane| pane_agent_presentation(pane, data).status),
    )
}

fn strongest_agent_status(statuses: impl IntoIterator<Item = &'static str>) -> &'static str {
    let mut best = "unknown";
    for status in statuses {
        match status {
            "blocked" => return "blocked",
            "working" if best != "working" => best = "working",
            "idle" if best == "unknown" => best = "idle",
            _ => {}
        }
    }
    best
}

fn close_tab_locked(data: &mut BuiltinData, tab_id: &str) {
    if let Some(tab) = data.tabs.remove(tab_id) {
        for pane_id in tab.pane_ids {
            close_pane_locked(data, &pane_id);
        }
        if let Some(workspace) = data.workspaces.get_mut(&tab.workspace_id) {
            workspace.tab_ids.retain(|id| id != tab_id);
        }
    }
}

fn close_pane_locked(data: &mut BuiltinData, pane_id: &str) {
    if let Some(pane) = data.panes.remove(pane_id) {
        data.terminals.remove(&pane.terminal_id);
        if let Some(tab) = data.tabs.get_mut(&pane.tab_id) {
            tab.pane_ids.retain(|id| id != pane_id);
        }
    }
}

fn normalize_focus(data: &mut BuiltinData) {
    if data
        .focused_workspace_id
        .as_ref()
        .is_some_and(|id| data.workspaces.contains_key(id))
        && data
            .focused_tab_id
            .as_ref()
            .is_some_and(|id| data.tabs.contains_key(id))
        && data
            .focused_pane_id
            .as_ref()
            .is_some_and(|id| data.panes.contains_key(id))
    {
        return;
    }
    let Some(workspace) = data.workspaces.values().next() else {
        data.focused_workspace_id = None;
        data.focused_tab_id = None;
        data.focused_pane_id = None;
        return;
    };
    data.focused_workspace_id = Some(workspace.workspace_id.clone());
    data.focused_tab_id = workspace.tab_ids.first().cloned();
    data.focused_pane_id = data
        .focused_tab_id
        .as_ref()
        .and_then(|tab_id| data.tabs.get(tab_id))
        .and_then(|tab| tab.pane_ids.first().cloned());
}

fn next_id(data: &mut BuiltinData, prefix: &str) -> String {
    let id = data.next_id;
    data.next_id += 1;
    format!("{prefix}_{id}")
}

fn required_string(params: &Value, key: &str) -> Result<String, String> {
    optional_string(params, key).ok_or_else(|| format!("{key} is required"))
}

fn optional_string(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn success_response(id: &str, result: Value) -> Value {
    json!({ "id": id, "result": result })
}

fn error_response(id: &str, code: &str, message: impl Into<String>) -> Value {
    json!({ "id": id, "error": { "code": code, "message": message.into() } })
}

fn write_json_line(stream: &mut LocalStream, value: &Value) -> io::Result<()> {
    stream.write_all(value.to_string().as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

fn prepare_socket_path(path: &Path) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        let parent_existed = parent.exists();
        fs::create_dir_all(parent)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if !parent_existed {
                fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
            }
        }
    }
    if path.exists() && local_socket_active(path) {
        return Err(io::Error::new(
            io::ErrorKind::AddrInUse,
            format!(
                "built-in backend socket is already active at {}",
                path.display()
            ),
        ));
    }
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
    }
}

fn local_socket_active(path: &Path) -> bool {
    connect_local_stream(path).is_ok()
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

fn bind_local_listener(path: &Path) -> io::Result<LocalListener> {
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

fn restrict_socket_permissions(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(SOCKET_PERMISSION_MODE))?;
    }
    Ok(())
}

fn default_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| {
            if cfg!(windows) {
                "powershell.exe".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
}

fn workspace_label(cwd: &Path) -> String {
    cwd.file_name()
        .and_then(|name| name.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Workspace")
        .to_string()
}

fn numeric_suffix(id: &str) -> usize {
    id.rsplit('_')
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0)
}

fn detect_agent_label(argv: &[String]) -> Option<&'static str> {
    argv.first().and_then(|command| {
        let name = Path::new(command)
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or(command)
            .to_lowercase();
        match name.as_str() {
            "pi" => Some("pi"),
            "jcode" => Some("jcode"),
            "claude" | "claude-code" => Some("claude"),
            "codex" => Some("codex"),
            "gemini" => Some("gemini"),
            "cursor" | "cursor-agent" => Some("cursor"),
            "devin" | "devin-cli" => Some("devin"),
            "agy" | "antigravity" | "antigravity-cli" => Some("agy"),
            "cline" => Some("cline"),
            "omp" => Some("omp"),
            "mastracode" | "mastra-code" => Some("mastracode"),
            "opencode" | "open-code" => Some("opencode"),
            "copilot" | "github-copilot" | "ghcs" => Some("copilot"),
            "kimi" | "kimi-code" => Some("kimi"),
            "kiro" | "kiro-cli" => Some("kiro"),
            "droid" => Some("droid"),
            "amp" | "amp-local" => Some("amp"),
            "grok" | "grok-build" => Some("grok"),
            "hermes" | "hermes-agent" => Some("hermes"),
            "kilo" | "kilo-code" => Some("kilo"),
            "qodercli" | "qoderclicn" | "qoder" | "qodercn" => Some("qodercli"),
            "maki" => Some("maki"),
            _ => None,
        }
    })
}

fn detect_agent_label_from_text(text: &str) -> Option<&'static str> {
    let lower = text.to_lowercase();
    if lower.contains("opencode")
        || lower.contains("△ permission required")
        || (lower.contains("esc dismiss") && lower.contains("enter confirm"))
    {
        return Some("opencode");
    }
    if lower.contains("jcode")
        || lower.contains("session ready")
        || lower.contains("ready for input")
        || jcode_blocked(&bottom_non_empty_lines(&lower, 8))
        || lower.contains("running tool")
        || lower.contains("executing tool")
    {
        return Some("jcode");
    }
    None
}

fn detect_agent_status(agent: Option<&str>, text: &str) -> &'static str {
    let Some(agent) = agent else {
        return "unknown";
    };
    let lower = text.to_lowercase();
    match agent {
        "jcode" => detect_jcode_status(&lower),
        "opencode" => detect_opencode_status(&lower),
        _ => "unknown",
    }
}

fn detect_jcode_status(lower: &str) -> &'static str {
    let bottom8 = bottom_non_empty_lines(lower, 8);
    let bottom6 = bottom_non_empty_lines(lower, 6);
    let bottom4 = bottom_non_empty_lines(lower, 4);
    let bottom3 = bottom_non_empty_lines(lower, 3);
    if jcode_blocked(&bottom8) || jcode_question_blocked(&bottom6) {
        return "blocked";
    }
    if has_jcode_spinner(&bottom3)
        || has_jcode_tool_bar(&bottom4)
        || contains_any(
            &bottom4,
            &[
                "running tool",
                "executing tool",
                "network disconnected, waiting to retry",
            ],
        )
    {
        return "working";
    }
    if contains_any(&bottom3, &["session ready", "ready for input"])
        || bottom3.lines().any(|line| line.trim() == "❯")
    {
        if !contains_any(
            &bottom3,
            &["processing", "embedding", "running tool", "executing"],
        ) {
            return "idle";
        }
    }
    "unknown"
}

fn detect_opencode_status(lower: &str) -> &'static str {
    if lower.contains("△ permission required")
        || (lower.contains("esc dismiss")
            && contains_any(lower, &["enter confirm", "enter submit", "enter toggle"])
            && contains_any(lower, &["↑↓ select", "⇆ tab"]))
    {
        return "blocked";
    }
    if contains_any(
        lower,
        &[
            "esc to interrupt",
            "ctrl+c to interrupt",
            "press esc to interrupt",
        ],
    ) || lower
        .lines()
        .any(|line| line.contains("opencode") && line.contains("esc") && line.contains("interrupt"))
        || has_opencode_progress(lower)
    {
        return "working";
    }
    "unknown"
}

fn jcode_blocked(text: &str) -> bool {
    (text.contains("permission")
        && contains_any(text, &["allow once", "always allow", "allow"])
        && contains_any(text, &["deny", "reject", "cancel"]))
        || (text.contains("approve?")
            && contains_any(text, &["allow", "yes"])
            && contains_any(text, &["reject", "no", "cancel"]))
        || (text.contains("confirm action")
            && contains_any(text, &["allow", "yes", "proceed"])
            && contains_any(text, &["reject", "no", "cancel"]))
}

fn jcode_question_blocked(text: &str) -> bool {
    (text.contains("enter your response") && contains_any(text, &["continue", "submit", "cancel"]))
        || (text.contains("asking user")
            && contains_any(
                text,
                &["enter your response", "awaiting input", "waiting for user"],
            ))
        || (text.contains("awaiting input") && contains_any(text, &["enter", "type", "respond"]))
}

fn has_jcode_spinner(text: &str) -> bool {
    text.lines().any(|line| {
        let mut chars = line.trim_start().chars();
        matches!(chars.next(), Some(first) if ('\u{2800}'..='\u{28ff}').contains(&first))
            && chars.any(char::is_alphabetic)
    })
}

fn has_jcode_tool_bar(text: &str) -> bool {
    text.lines().any(|line| {
        let trimmed = line.trim_start();
        let mut prefix_count = 0_usize;
        let mut prefix_end = 0_usize;
        for (idx, ch) in trimmed.char_indices() {
            if ch == '·' || ch == '●' {
                prefix_count += 1;
                prefix_end = idx + ch.len_utf8();
            } else {
                break;
            }
        }
        prefix_count >= 3 && trimmed[prefix_end..].contains(' ')
    })
}

fn has_opencode_progress(text: &str) -> bool {
    text.lines().any(|line| {
        let mut run = 0_usize;
        for ch in line.chars() {
            if ch == '■' || ch == '⬝' {
                run += 1;
                if run >= 4 {
                    return true;
                }
            } else {
                run = 0;
            }
        }
        false
    })
}

fn bottom_non_empty_lines(text: &str, count: usize) -> String {
    let mut lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .rev()
        .take(count)
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.reverse();
    lines.join("\n")
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

fn strip_ansi_lossy(input: &str) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if next.is_ascii_alphabetic() || next == '~' {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    let mut previous_escape = false;
                    for next in chars.by_ref() {
                        if next == '\u{7}' || (previous_escape && next == '\\') {
                            break;
                        }
                        previous_escape = next == '\u{1b}';
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }
        if ch == '\r' {
            output.push('\n');
        } else if ch == '\n' || ch == '\t' || !ch.is_control() {
            output.push(ch);
        }
    }
    output
}

fn run_git(cwd: &Path, args: &[&str]) -> Result<(), String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(git_output_error(output))
    }
}

fn git_output(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|err| err.to_string())?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        Err(git_output_error(output))
    }
}

fn git_output_error(output: std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else {
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }
}

fn parse_git_worktrees(raw: &str) -> Vec<Value> {
    let mut rows = Vec::new();
    let mut current_path: Option<String> = None;
    let mut branch: Option<String> = None;
    let mut detached = false;
    let flush = |rows: &mut Vec<Value>,
                 current_path: &mut Option<String>,
                 branch: &mut Option<String>,
                 detached: &mut bool| {
        if let Some(path) = current_path.take() {
            rows.push(json!({
                "path": path,
                "branch": branch.take(),
                "is_bare": false,
                "is_detached": *detached,
                "is_prunable": false,
                "is_linked_worktree": true,
                "open_workspace_id": null,
                "label": Path::new(&path).file_name().and_then(|name| name.to_str()).unwrap_or(&path),
            }));
            *detached = false;
        }
    };
    for line in raw.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut rows, &mut current_path, &mut branch, &mut detached);
            current_path = Some(path.to_string());
        } else if let Some(value) = line.strip_prefix("branch ") {
            branch = Some(value.trim_start_matches("refs/heads/").to_string());
        } else if line == "detached" {
            detached = true;
        }
    }
    flush(&mut rows, &mut current_path, &mut branch, &mut detached);
    rows
}

fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_herdr_agent_aliases_from_argv() {
        assert_eq!(
            detect_agent_label(&["/usr/local/bin/jcode".into()]),
            Some("jcode")
        );
        assert_eq!(detect_agent_label(&["claude-code".into()]), Some("claude"));
        assert_eq!(detect_agent_label(&["open-code".into()]), Some("opencode"));
        assert_eq!(detect_agent_label(&["cursor-agent".into()]), Some("cursor"));
        assert_eq!(detect_agent_label(&["qodercn".into()]), Some("qodercli"));
        assert_eq!(detect_agent_label(&["bash".into()]), None);
    }

    #[test]
    fn detects_jcode_status_from_jcode_support_manifest_patterns() {
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "Permission required\nAllow once\nAlways allow\nDeny"
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "Asking user\nEnter your response\nSubmit"),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "⠋ running analysis"),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "Running tool bash"),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "Session ready\n❯"),
            "idle"
        );
    }

    #[test]
    fn detects_opencode_status_from_manifest_patterns() {
        assert_eq!(
            detect_agent_status(Some("opencode"), "△ Permission required"),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(Some("opencode"), "esc dismiss\nenter confirm\n↑↓ select"),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(Some("opencode"), "opencode · esc to interrupt"),
            "working"
        );
        assert_eq!(detect_agent_status(Some("opencode"), "■■■■"), "working");
    }

    #[test]
    fn strips_ansi_before_tail_detection() {
        let stripped = strip_ansi_lossy("\u{1b}[31mSession ready\u{1b}[0m\r\n\u{1b}]0;title\u{7}❯");

        assert!(stripped.contains("Session ready"));
        assert!(stripped.contains("❯"));
        assert!(!stripped.contains("[31m"));
        assert_eq!(detect_agent_label_from_text(&stripped), Some("jcode"));
    }

    #[test]
    fn parses_git_worktree_porcelain_output() {
        let rows = parse_git_worktrees(
            "worktree /repo\nbranch refs/heads/main\n\nworktree /repo-feature\ndetached\n",
        );

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["path"], "/repo");
        assert_eq!(rows[0]["branch"], "main");
        assert_eq!(rows[0]["is_detached"], false);
        assert_eq!(rows[1]["path"], "/repo-feature");
        assert_eq!(rows[1]["is_detached"], true);
    }

    #[test]
    fn builtin_worktree_remove_reports_unsupported_instead_of_false_success() {
        let state = BuiltinState::new(std::env::temp_dir(), Some(default_shell())).unwrap();

        let err = state
            .handle_request_inner("worktree.remove", json!({ "workspace_id": "ws_1" }))
            .unwrap_err();

        assert!(err.contains("does not implement worktree.remove"));
    }

    #[cfg(unix)]
    #[test]
    fn events_subscribe_acks_then_closes_without_holding_connection() {
        let base = format!(
            "/tmp/herdr-webui-events-test-{}-{}",
            std::process::id(),
            now_ms()
        );
        let api_socket = PathBuf::from(format!("{base}-api.sock"));
        let client_socket = PathBuf::from(format!("{base}-client.sock"));
        let _handle = BuiltinBackendHandle::start(BuiltinBackendConfig {
            api_socket: api_socket.clone(),
            client_socket,
            cwd: std::env::temp_dir(),
            shell: Some(default_shell()),
        })
        .unwrap();
        let mut stream = connect_local_stream(&api_socket).unwrap();
        stream
            .write_all(br#"{"id":"events","method":"events.subscribe","params":{}}"#)
            .unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
        let mut reader = BufReader::new(stream);
        let mut ack = String::new();
        reader.read_line(&mut ack).unwrap();
        assert!(ack.contains("subscription_started"));
        let mut eof = String::new();
        assert_eq!(reader.read_line(&mut eof).unwrap(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn dropping_handle_unblocks_listeners_and_reclaims_sockets() {
        let base = format!(
            "/tmp/herdr-webui-drop-test-{}-{}",
            std::process::id(),
            now_ms()
        );
        let api_socket = PathBuf::from(format!("{base}-api.sock"));
        let client_socket = PathBuf::from(format!("{base}-client.sock"));
        let handle = BuiltinBackendHandle::start(BuiltinBackendConfig {
            api_socket: api_socket.clone(),
            client_socket: client_socket.clone(),
            cwd: std::env::temp_dir(),
            shell: Some(default_shell()),
        })
        .unwrap();
        assert!(api_socket.exists());
        assert!(client_socket.exists());

        drop(handle);

        for _ in 0..50 {
            if !api_socket.exists() && !client_socket.exists() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("built-in sockets were not reclaimed after handle drop");
    }

    #[cfg(unix)]
    #[test]
    fn prepare_socket_path_rejects_active_socket_without_unlinking() {
        let path = PathBuf::from(format!(
            "/tmp/herdr-webui-active-socket-test-{}-{}.sock",
            std::process::id(),
            now_ms()
        ));
        prepare_socket_path(&path).unwrap();
        let listener = bind_local_listener(&path).unwrap();

        let err = prepare_socket_path(&path).unwrap_err();

        assert_eq!(err.kind(), io::ErrorKind::AddrInUse);
        drop(listener);
        let _ = fs::remove_file(path);
    }
}
