use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use interprocess::local_socket::traits::ListenerExt as _;
use interprocess::TryClone as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};

use crate::builtin_events::{BuiltinEventHub, PaneEventContext};
use crate::protocol::{
    read_message, write_message, ClientInputEvent, ClientMessage, RenderEncoding, ServerMessage,
    TerminalFrame,
};
use crate::terminal_text::{self, TerminalTextOptions};

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
        let rx = backend.state.subscribe_events();
        write_json_line(
            &mut stream,
            &success_response(&id, json!({ "type": "subscription_started" })),
        )?;
        while backend.running.load(Ordering::Acquire) {
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(event) => write_json_line(&mut stream, &event)?,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
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
        let message = read_message::<_, ClientMessage>(&mut stream, MAX_FRAME_SIZE)?;
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
                    let (tx, rx) = mpsc::sync_channel::<TerminalSubscriberMessage>(256);
                    terminal.subscribe(tx);
                    let mut writer = stream.try_clone().map_err(|err| err.to_string())?;
                    let terminal_size = Arc::clone(&terminal_size);
                    thread::spawn(move || {
                        let mut seq = seq;
                        while let Ok(message) = rx.recv() {
                            match message {
                                TerminalSubscriberMessage::Output(bytes) => {
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
                                TerminalSubscriberMessage::Exited => {
                                    let _ = write_message(
                                        &mut writer,
                                        &ServerMessage::ServerShutdown {
                                            reason: Some("terminal exited".to_string()),
                                        },
                                    );
                                    break;
                                }
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
    events: BuiltinEventHub,
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
    fn new(_cwd: PathBuf, shell: Option<String>) -> io::Result<Self> {
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
            events: BuiltinEventHub::new(),
        };
        Ok(state)
    }

    fn handle_request(&self, id: &str, method: &str, params: Value) -> Value {
        match self.handle_request_inner(method, params.clone()) {
            Ok(result) => {
                self.publish_success_event(method, &params, &result);
                success_response(id, result)
            }
            Err(err) => error_response(id, "builtin_error", err),
        }
    }

    fn subscribe_events(&self) -> mpsc::Receiver<Value> {
        self.events.subscribe()
    }

    fn publish_event(&self, event: &str, data: Value) {
        self.events.publish(event, data);
    }

    fn publish_success_event(&self, method: &str, params: &Value, result: &Value) {
        match method {
            "workspace.create" => self.publish_event("workspace.created", result.clone()),
            "workspace.rename" => self.publish_event("workspace.renamed", result.clone()),
            "workspace.close" => self.publish_event(
                "workspace.closed",
                json!({ "workspace_id": optional_string(params, "workspace_id") }),
            ),
            "tab.create" => self.publish_event("tab.created", result.clone()),
            "tab.rename" => self.publish_event("tab.renamed", result.clone()),
            "tab.close" => self.publish_event(
                "tab.closed",
                json!({ "tab_id": optional_string(params, "tab_id") }),
            ),
            "pane.close" => self.publish_event(
                "pane.closed",
                json!({ "pane_id": optional_string(params, "pane_id") }),
            ),
            "agent.start" => self.publish_event("workspace.created", result.clone()),
            "worktree.open" => self.publish_event("worktree.opened", result.clone()),
            "worktree.create" => self.publish_event("worktree.created", result.clone()),
            _ => {}
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
                    .tabs_for_workspace(workspace["workspace_id"].as_str().unwrap_or_default())?
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
            self.events.clone(),
            PaneEventContext {
                workspace_id: workspace_id.clone(),
                tab_id: tab_id.clone(),
                pane_id: pane_id.clone(),
                terminal_id: terminal_id.clone(),
            },
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
            self.events.clone(),
            PaneEventContext {
                workspace_id: workspace_id.clone(),
                tab_id: tab_id.clone(),
                pane_id: pane_id.clone(),
                terminal_id: terminal_id.clone(),
            },
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
        let terminal = TerminalRuntime::spawn(
            terminal_id.clone(),
            cwd.clone(),
            argv.clone(),
            30,
            100,
            self.events.clone(),
            PaneEventContext {
                workspace_id: workspace_id.clone(),
                tab_id: tab_id.clone(),
                pane_id: pane_id.clone(),
                terminal_id: terminal_id.clone(),
            },
        )
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
    child_pid: Option<u32>,
    argv: Vec<String>,
    event_hub: BuiltinEventHub,
    event_context: PaneEventContext,
    last_agent_state: Mutex<Option<(Option<String>, String)>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    writer: Mutex<Box<dyn Write + Send>>,
    scrollback: Mutex<VecDeque<u8>>,
    subscribers: Mutex<Vec<mpsc::SyncSender<TerminalSubscriberMessage>>>,
    exited: AtomicBool,
}

#[derive(Clone)]
enum TerminalSubscriberMessage {
    Output(Vec<u8>),
    Exited,
}

impl TerminalRuntime {
    fn spawn(
        id: String,
        cwd: PathBuf,
        argv: Vec<String>,
        rows: u16,
        cols: u16,
        event_hub: BuiltinEventHub,
        event_context: PaneEventContext,
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
        let program = argv.first().cloned().unwrap_or_else(default_shell);
        let use_login_shell = argv.len() <= 1 && is_shell_program(&program);
        let shell_for_env = if use_login_shell {
            program.clone()
        } else {
            default_shell()
        };
        let mut command = if use_login_shell {
            CommandBuilder::new_default_prog()
        } else {
            let mut command = CommandBuilder::new(program);
            for arg in argv.iter().skip(1) {
                command.arg(arg);
            }
            command
        };
        for (key, value) in terminal_environment(&shell_for_env) {
            command.env(key, value);
        }
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|err| io::Error::other(err.to_string()))?;
        let child_pid = child.process_id();
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
            child_pid,
            argv,
            event_hub,
            event_context,
            last_agent_state: Mutex::new(None),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            writer: Mutex::new(writer),
            scrollback: Mutex::new(VecDeque::new()),
            subscribers: Mutex::new(Vec::new()),
            exited: AtomicBool::new(false),
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
            runtime_for_reader.notify_exited();
        });
        Ok(runtime)
    }

    fn child_pid(&self) -> Option<u32> {
        self.child_pid
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

    fn subscribe(&self, tx: mpsc::SyncSender<TerminalSubscriberMessage>) {
        if self.exited.load(Ordering::Acquire) {
            let _ = tx.try_send(TerminalSubscriberMessage::Exited);
            return;
        }
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
        terminal_screen_text_lossy(&String::from_utf8_lossy(&bytes))
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
            let payload = TerminalSubscriberMessage::Output(bytes.to_vec());
            subscribers.retain(|tx| match tx.try_send(payload.clone()) {
                Ok(()) => true,
                Err(mpsc::TrySendError::Full(_)) => false,
                Err(mpsc::TrySendError::Disconnected(_)) => false,
            });
        }
        self.publish_agent_status_if_changed();
    }

    fn notify_exited(&self) {
        if self.exited.swap(true, Ordering::AcqRel) {
            return;
        }
        self.event_hub.publish(
            "pane.exited",
            json!({
                "workspace_id": self.event_context.workspace_id,
                "tab_id": self.event_context.tab_id,
                "pane_id": self.event_context.pane_id,
                "terminal_id": self.event_context.terminal_id,
                "reason": "terminal exited",
            }),
        );
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.retain(|tx| match tx.try_send(TerminalSubscriberMessage::Exited) {
                Ok(()) => false,
                Err(mpsc::TrySendError::Full(_)) => false,
                Err(mpsc::TrySendError::Disconnected(_)) => false,
            });
        }
    }

    fn publish_agent_status_if_changed(&self) {
        let tail = self.history_tail_text(DETECTION_TAIL_BYTES);
        let process_agent = self
            .child_pid()
            .and_then(detect_agent_label_from_process_tree);
        let agent = detect_agent_label(&self.argv)
            .or(process_agent)
            .or_else(|| detect_agent_label_from_text(&tail))
            .map(str::to_string);
        let status = match detect_agent_status(agent.as_deref(), &tail) {
            "unknown" if agent.is_some() => "idle",
            status => status,
        }
        .to_string();
        let current = (agent.clone(), status.clone());
        let should_publish = self
            .last_agent_state
            .lock()
            .map(|mut previous| {
                let changed = previous.as_ref() != Some(&current);
                *previous = Some(current);
                changed
            })
            .unwrap_or(false);
        if should_publish && agent.is_some() {
            self.event_hub.publish(
                "pane.agent_status_changed",
                json!({
                    "workspace_id": self.event_context.workspace_id,
                    "tab_id": self.event_context.tab_id,
                    "pane_id": self.event_context.pane_id,
                    "terminal_id": self.event_context.terminal_id,
                    "agent": agent,
                    "agent_status": status,
                    "status": status,
                }),
            );
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
    ordered_workspaces(data)
        .into_iter()
        .map(|workspace| workspace_json(workspace, data))
        .collect()
}

fn tab_list_json(data: &BuiltinData, workspace_id: Option<&str>) -> Vec<Value> {
    ordered_tabs(data, workspace_id)
        .into_iter()
        .map(|tab| tab_json(tab, data))
        .collect()
}

fn pane_list_json(data: &BuiltinData, workspace_id: Option<&str>) -> Vec<Value> {
    ordered_panes(data, workspace_id)
        .into_iter()
        .map(|pane| pane_json(pane, data))
        .collect()
}

fn agent_list_json(data: &BuiltinData) -> Vec<Value> {
    ordered_panes(data, None)
        .into_iter()
        .filter(|pane| pane.label.is_some() || pane_agent_presentation(pane, data).agent.is_some())
        .map(|pane| agent_json(pane, data))
        .collect()
}

fn layout_list_json(data: &BuiltinData) -> Vec<Value> {
    ordered_tabs(data, None)
        .into_iter()
        .map(|tab| layout_json(tab, data))
        .collect()
}

fn ordered_workspaces(data: &BuiltinData) -> Vec<&WorkspaceRecord> {
    let mut workspaces = data.workspaces.values().collect::<Vec<_>>();
    workspaces.sort_by_key(|workspace| id_sort_key(&workspace.workspace_id));
    workspaces
}

fn ordered_tabs<'a>(data: &'a BuiltinData, workspace_id: Option<&str>) -> Vec<&'a TabRecord> {
    let mut tabs = Vec::new();
    for workspace in ordered_workspaces(data) {
        if workspace_id.is_some_and(|workspace_id| workspace.workspace_id != workspace_id) {
            continue;
        }
        tabs.extend(
            workspace
                .tab_ids
                .iter()
                .filter_map(|tab_id| data.tabs.get(tab_id)),
        );
    }
    tabs
}

fn ordered_panes<'a>(data: &'a BuiltinData, workspace_id: Option<&str>) -> Vec<&'a PaneRecord> {
    let mut panes = Vec::new();
    for tab in ordered_tabs(data, workspace_id) {
        panes.extend(
            tab.pane_ids
                .iter()
                .filter_map(|pane_id| data.panes.get(pane_id)),
        );
    }
    panes
}

fn workspace_display_number(workspace: &WorkspaceRecord, data: &BuiltinData) -> usize {
    ordered_workspaces(data)
        .iter()
        .position(|candidate| candidate.workspace_id == workspace.workspace_id)
        .map(|index| index + 1)
        .unwrap_or(1)
}

fn tab_display_number(tab: &TabRecord, data: &BuiltinData) -> usize {
    data.workspaces
        .get(&tab.workspace_id)
        .and_then(|workspace| {
            workspace
                .tab_ids
                .iter()
                .position(|tab_id| tab_id == &tab.tab_id)
        })
        .map(|index| index + 1)
        .unwrap_or(1)
}

fn pane_display_number(pane: &PaneRecord, data: &BuiltinData) -> usize {
    data.tabs
        .get(&pane.tab_id)
        .and_then(|tab| {
            tab.pane_ids
                .iter()
                .position(|pane_id| pane_id == &pane.pane_id)
        })
        .map(|index| index + 1)
        .unwrap_or(1)
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
        "number": workspace_display_number(workspace, data),
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
        "number": tab_display_number(tab, data),
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
        "number": pane_display_number(pane, data),
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
    let terminal = data.terminals.get(&pane.terminal_id);
    let tail = terminal
        .map(|terminal| terminal.history_tail_text(DETECTION_TAIL_BYTES))
        .unwrap_or_default();
    let process_agent = terminal
        .and_then(|terminal| terminal.child_pid())
        .and_then(detect_agent_label_from_process_tree);
    let agent = detect_agent_label(&pane.argv)
        .or(process_agent)
        .or_else(|| detect_agent_label_from_text(&tail));
    let status = match detect_agent_status(agent, &tail) {
        "unknown" if agent.is_some() => "idle",
        status => status,
    };
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
            } else if cfg!(target_os = "macos") {
                "/bin/zsh".to_string()
            } else {
                "/bin/sh".to_string()
            }
        })
}

fn is_shell_program(program: &str) -> bool {
    let name = Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(program)
        .trim_start_matches('-')
        .to_lowercase();
    matches!(
        name.as_str(),
        "sh" | "bash" | "zsh" | "fish" | "ksh" | "csh" | "tcsh" | "dash"
    )
}

fn terminal_environment(shell: &str) -> HashMap<String, String> {
    let mut env = std::env::vars().collect::<HashMap<_, _>>();
    let home = env
        .get("HOME")
        .cloned()
        .or_else(default_home_dir)
        .unwrap_or_else(|| "/".to_string());
    env.entry("HOME".to_string())
        .or_insert_with(|| home.clone());
    if let Some(user) = default_user_name() {
        env.entry("USER".to_string())
            .or_insert_with(|| user.clone());
        env.entry("LOGNAME".to_string()).or_insert(user);
    }
    env.insert("SHELL".to_string(), shell.to_string());
    env.insert(
        "PATH".to_string(),
        enriched_terminal_path(env.get("PATH").map(String::as_str), &home),
    );
    env.insert("HERDR_WEBUI".to_string(), "1".to_string());
    env
}

fn default_home_dir() -> Option<String> {
    default_user_name().and_then(|user| {
        if cfg!(target_os = "macos") {
            Some(format!("/Users/{user}"))
        } else if cfg!(unix) {
            Some(format!("/home/{user}"))
        } else {
            None
        }
    })
}

fn default_user_name() -> Option<String> {
    std::env::var("USER")
        .ok()
        .or_else(|| std::env::var("LOGNAME").ok())
        .filter(|value| !value.trim().is_empty())
}

fn enriched_terminal_path(current_path: Option<&str>, home: &str) -> String {
    let home_entries = [
        ".local/bin",
        "bin",
        ".cargo/bin",
        ".pyenv/bin",
        ".pyenv/shims",
        ".jenv/bin",
        ".jenv/shims",
        ".fzf/bin",
        ".jcode/bin",
    ]
    .into_iter()
    .map(|entry| format!("{home}/{entry}"));
    let mac_path = macos_path_helper_path();
    let common_entries = [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "/nix/var/nix/profiles/default/bin",
    ];
    let mut entries = Vec::new();
    entries.extend(home_entries);
    if let Some(path) = current_path {
        entries.extend(path.split(':').map(str::to_string));
    }
    if let Some(path) = mac_path.as_deref() {
        entries.extend(path.split(':').map(str::to_string));
    }
    entries.extend(common_entries.into_iter().map(str::to_string));
    dedupe_path_entries(entries)
}

fn dedupe_path_entries(entries: impl IntoIterator<Item = String>) -> String {
    let mut out = Vec::new();
    for entry in entries {
        let entry = entry.trim();
        if entry.is_empty() || out.iter().any(|existing| existing == entry) {
            continue;
        }
        out.push(entry.to_string());
    }
    out.join(":")
}

#[cfg(target_os = "macos")]
fn macos_path_helper_path() -> Option<String> {
    let output = std::process::Command::new("/usr/libexec/path_helper")
        .arg("-s")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    parse_path_helper_output(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(not(target_os = "macos"))]
fn macos_path_helper_path() -> Option<String> {
    None
}

fn parse_path_helper_output(output: &str) -> Option<String> {
    for line in output.lines() {
        let Some(rest) = line.trim_start().strip_prefix("PATH=") else {
            continue;
        };
        let rest = rest.trim_start();
        if let Some(value) = rest.strip_prefix('"') {
            return value.split('"').next().map(str::to_string);
        }
        if let Some(value) = rest.strip_prefix('\'') {
            return value.split('\'').next().map(str::to_string);
        }
        return rest.split(';').next().map(str::to_string);
    }
    None
}

fn workspace_label(cwd: &Path) -> String {
    cwd.file_name()
        .and_then(|name| name.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("Workspace")
        .to_string()
}

fn id_sort_key(id: &str) -> usize {
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
    let bottom4 = bottom_non_empty_lines(&lower, 4);
    let bottom3 = bottom_non_empty_lines(&lower, 3);
    if lower.contains("jcode")
        || lower.contains("session ready")
        || lower.contains("ready for input")
        || jcode_blocked(&bottom_non_empty_lines(&lower, 8))
        || has_jcode_spinner(&bottom3)
        || has_jcode_tool_bar(&bottom4)
        || lower.contains("running tool")
        || lower.contains("executing tool")
        || lower.contains("network disconnected, waiting to retry")
    {
        return Some("jcode");
    }
    None
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProcessInfo {
    pid: u32,
    ppid: u32,
    command: String,
    args: String,
}

type ProcessCache = Option<(Instant, Vec<ProcessInfo>)>;

fn detect_agent_label_from_process_tree(root_pid: u32) -> Option<&'static str> {
    detect_agent_label_from_processes(root_pid, &process_table().ok()?)
}

#[cfg(unix)]
fn process_table() -> io::Result<Vec<ProcessInfo>> {
    static CACHE: OnceLock<Mutex<ProcessCache>> = OnceLock::new();
    let cache = CACHE.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = cache.lock() {
        if let Some((loaded_at, processes)) = guard.as_ref() {
            if loaded_at.elapsed() < Duration::from_millis(250) {
                return Ok(processes.clone());
            }
        }
        let processes = process_table_uncached()?;
        *guard = Some((Instant::now(), processes.clone()));
        return Ok(processes);
    }
    process_table_uncached()
}

#[cfg(unix)]
fn process_table_uncached() -> io::Result<Vec<ProcessInfo>> {
    let output = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,comm=,args="])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other("ps failed"));
    }
    Ok(parse_process_table(&String::from_utf8_lossy(
        &output.stdout,
    )))
}

#[cfg(not(unix))]
fn process_table() -> io::Result<Vec<ProcessInfo>> {
    Ok(Vec::new())
}

fn parse_process_table(raw: &str) -> Vec<ProcessInfo> {
    raw.lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let pid = parts.next()?.parse().ok()?;
            let ppid = parts.next()?.parse().ok()?;
            let command = parts.next()?.to_string();
            let args = parts.collect::<Vec<_>>().join(" ");
            Some(ProcessInfo {
                pid,
                ppid,
                command,
                args,
            })
        })
        .collect()
}

fn detect_agent_label_from_processes(
    root_pid: u32,
    processes: &[ProcessInfo],
) -> Option<&'static str> {
    let by_pid = processes
        .iter()
        .map(|process| (process.pid, process))
        .collect::<HashMap<_, _>>();
    let mut children = HashMap::<u32, Vec<u32>>::new();
    for process in processes {
        children.entry(process.ppid).or_default().push(process.pid);
    }
    let mut stack = vec![root_pid];
    let mut seen = HashSet::<u32>::new();
    while let Some(pid) = stack.pop() {
        if !seen.insert(pid) {
            continue;
        }
        if let Some(process) = by_pid.get(&pid) {
            if let Some(agent) = detect_agent_label_from_process(process) {
                return Some(agent);
            }
        }
        if let Some(child_pids) = children.get(&pid) {
            stack.extend(child_pids.iter().copied());
        }
    }
    None
}

fn detect_agent_label_from_process(process: &ProcessInfo) -> Option<&'static str> {
    if let Some(agent) = detect_agent_label(std::slice::from_ref(&process.command)) {
        return Some(agent);
    }

    let argv = process_args_tokens(&process.args);
    if let Some(agent) = argv
        .first()
        .and_then(|candidate| detect_agent_label(std::slice::from_ref(candidate)))
    {
        return Some(agent);
    }

    let runtime = argv.first().map(String::as_str).unwrap_or(&process.command);
    if is_generic_runtime_or_shell(runtime) {
        return wrapped_agent_label_from_runtime_argv(runtime, &argv);
    }

    None
}

fn wrapped_agent_label_from_runtime_argv(runtime: &str, argv: &[String]) -> Option<&'static str> {
    let runtime = normalized_command_name(runtime);
    match runtime.as_str() {
        "node" | "bun" => script_arg_agent_label(argv, &["-e", "--eval", "-p", "--print"], &[]),
        "python" | "python3" => script_arg_agent_label(argv, &["-c"], &["-m"]),
        "sh" | "bash" | "zsh" | "fish" => script_arg_agent_label(argv, &["-c"], &[]),
        _ => None,
    }
}

fn script_arg_agent_label(
    argv: &[String],
    eval_flags: &[&str],
    module_flags: &[&str],
) -> Option<&'static str> {
    let mut args = argv.iter().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--" {
            return args
                .next()
                .and_then(|token| detect_agent_label(std::slice::from_ref(token)));
        }
        if flag_matches(arg, eval_flags) || flag_matches(arg, module_flags) {
            return None;
        }
        if arg.starts_with('-') {
            if option_takes_value(arg) {
                let _ = args.next();
            }
            continue;
        }
        return detect_agent_label(std::slice::from_ref(arg));
    }
    None
}

fn flag_matches(arg: &str, flags: &[&str]) -> bool {
    flags
        .iter()
        .any(|flag| arg == *flag || short_flag_payload(arg, flag) || long_flag_value(arg, flag))
}

fn short_flag_payload(arg: &str, flag: &str) -> bool {
    flag.starts_with('-')
        && !flag.starts_with("--")
        && arg.starts_with(flag)
        && arg.len() > flag.len()
}

fn long_flag_value(arg: &str, flag: &str) -> bool {
    flag.starts_with("--")
        && arg
            .strip_prefix(flag)
            .is_some_and(|rest| rest.starts_with('='))
}

fn option_takes_value(arg: &str) -> bool {
    matches!(
        arg,
        "-r" | "--require"
            | "--loader"
            | "--import"
            | "--experimental-loader"
            | "--inspect-port"
            | "-W"
            | "-X"
            | "-S"
            | "-L"
            | "-o"
    )
}

fn is_generic_runtime_or_shell(name: &str) -> bool {
    matches!(
        normalized_command_name(name).as_str(),
        "sh" | "bash" | "zsh" | "fish" | "tmux" | "node" | "bun" | "python" | "python3"
    )
}

fn normalized_command_name(name: &str) -> String {
    let mut name = Path::new(name)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(name)
        .trim_matches(|ch| matches!(ch, '"' | '\''))
        .to_lowercase();
    for suffix in [".exe", ".cmd", ".bat", ".ps1", ".js"] {
        if name.ends_with(suffix) {
            name.truncate(name.len() - suffix.len());
            break;
        }
    }
    name
}

fn process_args_tokens(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    let mut escaped = false;
    for ch in input.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if let Some(active_quote) = quote {
            if ch == active_quote {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        match ch {
            '"' | '\'' => quote = Some(ch),
            ch if ch.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            ch => current.push(ch),
        }
    }
    if escaped {
        current.push('\\');
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn detect_agent_status(agent: Option<&str>, text: &str) -> &'static str {
    let Some(agent) = agent else {
        return "unknown";
    };
    let lower = text.to_lowercase();
    match agent {
        "jcode" => detect_jcode_status(&lower),
        "opencode" => detect_opencode_status(&lower),
        "kilo" => detect_kilo_status(&lower),
        "amp" => detect_amp_status(&lower),
        "agy" => detect_antigravity_status(&lower),
        "claude" => detect_claude_status(&lower),
        "cline" => detect_cline_status(&lower),
        "codex" => detect_codex_status(&lower),
        "cursor" => detect_cursor_status(&lower),
        "devin" => detect_devin_status(&lower),
        "droid" => detect_droid_status(&lower),
        "gemini" => detect_gemini_status(&lower),
        "copilot" => detect_copilot_status(&lower),
        "grok" => detect_grok_status(&lower),
        "hermes" => detect_hermes_status(&lower),
        "kimi" => detect_kimi_status(&lower),
        "kiro" => detect_kiro_status(&lower),
        "maki" => detect_maki_status(&lower),
        "pi" => detect_pi_status(&lower),
        "qodercli" => detect_qodercli_status(&lower),
        _ => "unknown",
    }
}

fn detect_amp_status(lower: &str) -> &'static str {
    if contains_any(
        lower,
        &[
            "plugin confirmation needed",
            "waiting for approval",
            "invoke tool",
            "run this command?",
            "allow editing file:",
            "allow creating file:",
            "confirm tool call",
        ],
    ) || (lower.contains("approve")
        && contains_any(
            lower,
            &[
                "allow all for this session",
                "allow all for every session",
                "allow file for every session",
                "deny with feedback",
            ],
        ))
    {
        return "blocked";
    }
    if has_braille_spinner_line(lower)
        || lower.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with('╰')
                && contains_any(line, &["thinking", "streaming", "running tools", "waiting"])
                && line.contains('─')
        })
        || lower.contains("esc to cancel")
    {
        return "working";
    }
    if lower.contains(" - amp - ") {
        return "idle";
    }
    "unknown"
}

fn detect_antigravity_status(lower: &str) -> &'static str {
    if lower.contains("requesting permission for:")
        && (lower.contains("do you want to proceed?")
            || (lower.contains("tab amend") && lower.contains("edit command")))
    {
        return "blocked";
    }
    if has_braille_ing_line(lower) || bottom_non_empty_lines(lower, 5).contains("· 1 task") {
        return "working";
    }
    "unknown"
}

fn detect_claude_status(lower: &str) -> &'static str {
    if (lower.contains("enter to select")
        && lower.contains("esc to cancel")
        && contains_any(
            lower,
            &[
                "tab/arrow keys to navigate",
                "arrow keys to navigate",
                "arrows to navigate",
                "↑/↓ to navigate",
                "↑↓ to navigate",
            ],
        ))
        || (lower.contains("run a dynamic workflow?") && lower.contains("esc to cancel"))
        || (lower.contains("do you want to proceed?")
            && contains_any(
                lower,
                &[
                    "bash command",
                    "bash(",
                    "contains expansion",
                    "tab to amend",
                    "ctrl+e to explain",
                    "esc to cancel",
                ],
            ))
        || contains_any(
            lower,
            &[
                "waiting for permission",
                "do you want to allow this connection?",
                "review your answers",
                "skip interview and plan immediately",
            ],
        )
    {
        return "blocked";
    }
    if has_braille_spinner_line(lower)
        || lower
            .lines()
            .any(|line| line.trim_start().starts_with("/btw"))
        || lower.contains("esc to close")
    {
        return "working";
    }
    if lower.lines().any(|line| line.trim_start().starts_with('❯'))
        && !contains_any(
            lower,
            &[
                "enter to select",
                "esc to cancel",
                "tab/arrow keys",
                "arrow keys to navigate",
                "↑/↓ to navigate",
            ],
        )
    {
        return "idle";
    }
    "unknown"
}

fn detect_cline_status(lower: &str) -> &'static str {
    if lower.contains("let cline use this tool")
        || (lower.contains("[act mode]")
            && (lower.contains("execute command?") || lower.contains("use this tool?"))
            && lower.contains("yes"))
        || (lower.contains("[plan mode]")
            && (lower.contains("execute command?") || lower.contains("use this tool?"))
            && lower.contains("yes"))
    {
        "blocked"
    } else if lower.trim().is_empty() {
        "unknown"
    } else {
        "working"
    }
}

fn detect_codex_status(lower: &str) -> &'static str {
    if lower.contains("action required")
        || lower.contains("press enter to confirm or esc to cancel")
        || lower.contains("enter to submit answer")
        || lower.contains("enter to submit all")
        || lower.contains("allow command?")
        || lower.contains("[y/n]")
        || lower.contains("yes (y)")
        || ((lower.contains("do you want to") || lower.contains("would you like to"))
            && (lower.contains("yes") || lower.contains('❯')))
    {
        return "blocked";
    }
    if has_codex_spinner(lower) {
        return "working";
    }
    if !lower.trim().is_empty() {
        return "idle";
    }
    "unknown"
}

fn detect_cursor_status(lower: &str) -> &'static str {
    let bottom8 = bottom_non_empty_lines(lower, 8);
    if (bottom8.contains("write to this file?")
        && bottom8.contains("proceed (y)")
        && contains_any(
            &bottom8,
            &["reject & propose changes", "esc or n or p", "add write("],
        ))
        || (lower.contains("waiting for approval")
            && lower.contains("run this command?")
            && contains_any(lower, &["run (once) (y)", "skip (esc or n)"]))
        || contains_any(lower, &["(y) (enter)", "keep (n)", "skip (esc or n)"])
        || lower.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with("allow ") && line.contains("(y)")
        })
    {
        return "blocked";
    }
    let bottom6 = bottom_non_empty_lines(lower, 6);
    let bottom5 = bottom_non_empty_lines(lower, 5);
    if bottom6.contains("ctrl+c to stop")
        || background_tasks_line(&bottom5)
        || has_cursor_spinner(&bottom8)
    {
        return "working";
    }
    "unknown"
}

fn detect_devin_status(lower: &str) -> &'static str {
    if lower.contains("do you trust the files in this folder?")
        || (lower.contains("approve once")
            && lower.contains("select")
            && lower.contains("confirm")
            && lower.contains("esc cancel"))
    {
        return "blocked";
    }
    if (lower.contains("running tools") && lower.contains("esc to interrupt"))
        || lower.contains("guide devin while it works")
        || (lower.contains("reading shell ") && lower.contains("timeout:"))
    {
        return "working";
    }
    if (lower.contains("ask devin to build")
        && lower.contains("features, fix bugs")
        && lower.contains("your code"))
        || (lower.contains("context:")
            && lower.lines().any(|line| line.trim_start().starts_with('❭')))
    {
        return "idle";
    }
    "unknown"
}

fn detect_droid_status(lower: &str) -> &'static str {
    if (lower.contains("enter to select")
        && lower.contains("esc to cancel")
        && contains_any(
            lower,
            &[
                "↑↓ to navigate",
                "use ↑↓ to navigate",
                "> yes, allow",
                "> no, cancel",
            ],
        ))
        || (lower.contains("enter select")
            && lower.contains("esc cancel")
            && contains_any(lower, &["↑/↓ navigate", "↑↓ navigate"]))
    {
        return "blocked";
    }
    if lower.contains("esc to stop") {
        return "working";
    }
    "unknown"
}

fn detect_gemini_status(lower: &str) -> &'static str {
    if lower.contains("│ apply this change")
        || lower.contains("│ allow execution")
        || (lower.contains("yes")
            && contains_any(
                lower,
                &[
                    "waiting for user confirmation",
                    "│ do you want to proceed",
                    "do you want to proceed?",
                ],
            ))
        || lower.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with('❯') && (line.contains("yes") || line.contains("allow"))
        })
    {
        return "blocked";
    }
    if lower.contains("esc to cancel") {
        return "working";
    }
    "unknown"
}

fn detect_copilot_status(lower: &str) -> &'static str {
    if lower.contains("enter to select")
        || lower.contains("enter to confirm")
        || lower.contains("enter to submit")
        || lower.contains("enter accept")
    {
        return "blocked";
    }
    if contains_any(
        lower,
        &[
            "esc to cancel",
            "esc cancel",
            "esc again to cancel",
            "esc interrupt",
        ],
    ) {
        return "working";
    }
    "unknown"
}

fn detect_grok_status(lower: &str) -> &'static str {
    let bottom2 = bottom_non_empty_lines(lower, 2);
    if lower.lines().any(grok_option_dialog_line)
        || (bottom2.contains(":select")
            && bottom2.contains("ctrl+o:yolo")
            && bottom2.contains("ctrl+c:cancel"))
        || (bottom2.contains("tab:scrollback") && bottom2.contains("shift+x:dismiss"))
        || (lower.contains("yes, proceed")
            && lower.contains("no, reject")
            && contains_any(
                lower,
                &["use ← → to choose permission whitelist scope", "←/→:scope"],
            ))
    {
        return "blocked";
    }
    if lower.lines().any(grok_spinner_stop_line)
        || (bottom2.contains("esc:cancel") && bottom2.contains("ctrl+.:shortcuts"))
        || (lower.contains("ctrl+c:cancel")
            && lower.contains("ctrl+enter:interject")
            && lower.contains("waiting"))
        || lower.lines().any(grok_tool_line)
    {
        return "working";
    }
    if bottom2.contains("ctrl+.:shortcuts")
        && !bottom2.contains("esc:cancel")
        && !bottom2.contains("ctrl+c:cancel")
    {
        return "idle";
    }
    "unknown"
}

fn detect_hermes_status(lower: &str) -> &'static str {
    if lower.contains("dangerous command")
        || (lower.contains("allow once")
            && lower.contains("allow for this session")
            && lower.contains("deny"))
        || contains_any(
            lower,
            &["enter to confirm", "↑/↓ to select", "show full command"],
        )
    {
        return "blocked";
    }
    if lower.contains("msg=interrupt") || lower.contains("ctrl+c cancel") {
        return "working";
    }
    "unknown"
}

fn detect_kimi_status(lower: &str) -> &'static str {
    if (lower.contains("↵ confirm")
        && contains_any(
            lower,
            &[
                "run this command?",
                "write this file?",
                "apply these edits?",
                "stop this task?",
                "ready to build with this plan?",
                " choose",
            ],
        ))
        || (lower.contains("↑↓ select")
            && lower.contains("esc cancel")
            && (lower.lines().any(|line| line.trim() == "question")
                || lower
                    .lines()
                    .any(|line| line.trim_start().starts_with("? ")))
            && contains_any(lower, &["↵ choose", "↵ toggle", "↵ save"]))
        || (lower.contains("requesting approval")
            && lower.contains("reject")
            && contains_any(lower, &["approve once", "approve for this session"])
            && contains_any(lower, &["1/2/3/4 choose", "↵ confirm"]))
    {
        return "blocked";
    }
    if lower.lines().any(kimi_background_agents_line)
        || lower.lines().any(|line| {
            matches!(
                line.trim(),
                "🌕" | "🌖" | "🌗" | "🌘" | "🌑" | "🌒" | "🌓" | "🌔"
            )
        })
        || lower.lines().any(|line| {
            let line = line.trim_start();
            starts_with_braille(line)
                && contains_any(line, &["thinking...", "working...", "using "])
        })
    {
        return "working";
    }
    "unknown"
}

fn detect_kiro_status(lower: &str) -> &'static str {
    if (lower.contains("requires approval")
        && contains_any(
            lower,
            &[
                "yes, single permission",
                "trust, always allow",
                "no (tab to edit)",
                "esc to close",
            ],
        ))
        || (lower.contains("pending from subagents")
            && (lower.contains("tool approval") || lower.contains("tool approvals"))
            && contains_any(
                lower,
                &[
                    "approve all pending",
                    "configure individually",
                    "exit (cancel subagents)",
                ],
            ))
    {
        return "blocked";
    }
    if lower.contains("kiro is working")
        || (lower.contains("esc to cancel")
            && lower.lines().any(|line| {
                let line = line.trim_start();
                matches!(line.chars().next(), Some('◔' | '◑' | '◕' | '●'))
                    && line.chars().skip(1).any(char::is_alphabetic)
            }))
    {
        return "working";
    }
    "unknown"
}

fn detect_maki_status(lower: &str) -> &'static str {
    if (lower.contains("permission required")
        && contains_any(
            lower,
            &[
                "y allow",
                "n deny",
                "confirm allow",
                "confirm deny",
                "enter deny",
                "esc cancel",
            ],
        ))
        || (lower.contains("plan complete")
            && lower.contains("enter confirm")
            && contains_any(lower, &["space toggle parallel", "edit plan"]))
    {
        return "blocked";
    }
    let bottom1 = bottom_non_empty_lines(lower, 1);
    if bottom1.lines().any(maki_spinner_status_line) {
        return "working";
    }
    if bottom1.lines().any(maki_idle_status_line)
        || (bottom_non_empty_lines(lower, 3)
            .lines()
            .any(|line| line.starts_with("❯ "))
            && !lower.contains("queue another prompt"))
    {
        return "idle";
    }
    "unknown"
}

fn detect_pi_status(lower: &str) -> &'static str {
    if lower.contains("working...") {
        "working"
    } else {
        "unknown"
    }
}

fn detect_qodercli_status(lower: &str) -> &'static str {
    if (lower.contains("waiting for user confirmation")
        && contains_any(lower, &["yes", "no", "allow", "reject"]))
        || (lower.contains("awaiting approval") && contains_any(lower, &["allow", "reject"]))
        || contains_any(
            lower,
            &[
                "permission required",
                "allow once or always?",
                "asking user",
                "enter your response",
                "review your answers:",
                "shell awaiting input",
            ],
        )
    {
        return "blocked";
    }
    if lower.contains("(esc to cancel,") || has_braille_spinner_line(lower) {
        return "working";
    }
    "unknown"
}

fn detect_kilo_status(lower: &str) -> &'static str {
    if let Some(status) = detect_opencode_like_status(lower) {
        return status;
    }
    if lower.contains("esc interrupt") {
        return "working";
    }
    "unknown"
}

fn detect_opencode_like_status(lower: &str) -> Option<&'static str> {
    if lower.contains("△ permission required")
        || (lower.contains("esc dismiss")
            && contains_any(lower, &["enter confirm", "enter submit", "enter toggle"])
            && contains_any(lower, &["↑↓ select", "⇆ tab"]))
    {
        return Some("blocked");
    }
    None
}

fn detect_jcode_status(lower: &str) -> &'static str {
    let bottom8 = bottom_non_empty_lines(lower, 8);
    let bottom6 = bottom_non_empty_lines(lower, 6);
    let bottom4 = bottom_non_empty_lines(lower, 4);
    let bottom3 = bottom_non_empty_lines(lower, 3);
    if jcode_blocked(&bottom8) || jcode_question_blocked(&bottom6) {
        return "blocked";
    }
    if bottom3
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .is_some_and(jcode_idle_line)
    {
        return "idle";
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
    if (contains_any(&bottom3, &["session ready", "ready for input"])
        || bottom3.lines().any(|line| line.trim() == "❯"))
        && !contains_any(
            &bottom3,
            &["processing", "embedding", "running tool", "executing"],
        )
    {
        return "idle";
    }
    "unknown"
}

fn jcode_idle_line(line: &str) -> bool {
    let line = line.trim();
    line == "❯"
        || jcode_numbered_prompt_line(line)
        || line.contains("session ready")
        || line.contains("ready for input")
}

fn jcode_numbered_prompt_line(line: &str) -> bool {
    let line = line.trim_start();
    let digit_count = line.chars().take_while(|ch| ch.is_ascii_digit()).count();
    digit_count > 0
        && line[digit_count..]
            .chars()
            .next()
            .is_some_and(|ch| ch == '>')
}

fn detect_opencode_status(lower: &str) -> &'static str {
    if let Some(status) = detect_opencode_like_status(lower) {
        return status;
    }
    if contains_any(
        lower,
        &[
            "esc to interrupt",
            "ctrl+c to interrupt",
            "press esc to interrupt",
        ],
    ) || lower.lines().any(has_opencode_interrupt_line)
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
        matches!(chars.next(), Some(first) if is_braille(first))
            && matches!(chars.next(), Some(second) if second.is_whitespace())
            && chars.any(char::is_alphabetic)
    })
}

fn has_braille_spinner_line(text: &str) -> bool {
    text.lines().any(|line| {
        let mut chars = line.trim_start().chars();
        matches!(chars.next(), Some(first) if is_braille(first))
            && matches!(chars.next(), Some(second) if second.is_whitespace())
    })
}

fn has_braille_ing_line(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start();
        starts_with_braille(line) && line.split_whitespace().any(|word| word.ends_with("ing"))
    })
}

fn starts_with_braille(text: &str) -> bool {
    text.chars().next().is_some_and(is_braille)
}

fn is_braille(ch: char) -> bool {
    ('\u{2800}'..='\u{28ff}').contains(&ch)
}

fn has_codex_spinner(text: &str) -> bool {
    text.chars().any(|ch| {
        matches!(
            ch,
            '⠋' | '⠙' | '⠹' | '⠸' | '⠼' | '⠴' | '⠦' | '⠧' | '⠇' | '⠏'
        )
    })
}

fn has_cursor_spinner(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start();
        if line.starts_with('⬡') || line.starts_with('⬢') || starts_with_braille(line) {
            line.split_whitespace().any(|word| word.ends_with("ing"))
        } else {
            false
        }
    })
}

fn background_tasks_line(text: &str) -> bool {
    text.lines().any(|line| {
        let words = line.split_whitespace().collect::<Vec<_>>();
        words.windows(3).any(|window| {
            window[0].parse::<usize>().is_ok()
                && window[1].starts_with("background")
                && window[2].starts_with("task")
        })
    })
}

fn grok_option_dialog_line(line: &str) -> bool {
    let mut words = line.trim_start_matches('┃').split_whitespace();
    let Some(label) = words.next() else {
        return false;
    };
    let Some(choice) = words.next() else {
        return false;
    };
    !label.is_empty()
        && label.chars().all(|ch| ch.is_ascii_alphanumeric())
        && matches!(choice, "(●)" | "(○)")
}

fn grok_spinner_stop_line(line: &str) -> bool {
    let line = line.trim_start();
    starts_with_braille(line) && line.ends_with("[stop]")
}

fn grok_tool_line(line: &str) -> bool {
    let line = line.trim_start();
    if !starts_with_braille(line) {
        return false;
    }
    let lower = line.to_lowercase();
    contains_any(&lower, &[" run", " read", " search", " list"])
}

fn kimi_background_agents_line(line: &str) -> bool {
    line.contains("kimi")
        && line.contains("thinking")
        && line.contains("[")
        && line.contains("agent")
        && line.contains("running]")
}

fn maki_spinner_status_line(line: &str) -> bool {
    let line = line.trim_start();
    starts_with_braille(line) && contains_any(line, &["[build]", "[plan]", "[bash]"])
}

fn maki_idle_status_line(line: &str) -> bool {
    let line = line.trim_start();
    contains_any(line, &["[build]", "[plan]", "[bash]"]) && !starts_with_braille(line)
}

fn has_opencode_interrupt_line(line: &str) -> bool {
    let Some(opencode_index) = line.find("opencode") else {
        return false;
    };
    let mut rest = &line[opencode_index + "opencode".len()..];
    while let Some(index) = rest.find("esc ") {
        let after_esc = &rest[index + "esc ".len()..];
        if after_esc.starts_with("interrupt") || after_esc.starts_with("again to interrupt") {
            return true;
        }
        rest = &rest[index + "esc".len()..];
    }
    false
}

fn has_jcode_tool_bar(text: &str) -> bool {
    text.lines().any(jcode_tool_bar_line)
}

fn jcode_tool_bar_line(line: &str) -> bool {
    let mut rest = line.trim_start();
    let Some(after_prefix) = consume_jcode_dots(rest, 3) else {
        return false;
    };
    rest = after_prefix;
    let Some(after_space) = consume_some_whitespace(rest) else {
        return false;
    };
    rest = after_space;
    let Some(after_command) = consume_non_whitespace(rest) else {
        return false;
    };
    rest = after_command;
    let Some(after_space) = consume_some_whitespace(rest) else {
        return false;
    };
    rest = after_space;
    let Some(after_suffix) = consume_jcode_dots(rest, 3) else {
        return false;
    };
    rest = after_suffix;

    if rest.trim().is_empty() {
        return true;
    }

    let Some(after_space) = consume_some_whitespace(rest) else {
        return false;
    };
    let Some(after_dot) = after_space.strip_prefix('·') else {
        return false;
    };
    consume_some_whitespace(after_dot).is_some()
}

fn consume_jcode_dots(text: &str, count: usize) -> Option<&str> {
    let mut rest = text;
    for _ in 0..count {
        let mut chars = rest.chars();
        match chars.next() {
            Some('·' | '●') => rest = chars.as_str(),
            _ => return None,
        }
    }
    Some(rest)
}

fn consume_some_whitespace(text: &str) -> Option<&str> {
    let trimmed = text.trim_start();
    (trimmed.len() < text.len()).then_some(trimmed)
}

fn consume_non_whitespace(text: &str) -> Option<&str> {
    let end = text
        .char_indices()
        .find_map(|(idx, ch)| ch.is_whitespace().then_some(idx))
        .unwrap_or(text.len());
    (end > 0).then_some(&text[end..])
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

fn terminal_screen_text_lossy(input: &str) -> String {
    terminal_text::terminal_text_lossy(input, TerminalTextOptions::backend_tail())
}

#[cfg(test)]
fn strip_ansi_lossy(input: &str) -> String {
    terminal_text::strip_ansi_lossy(input, terminal_text::StripCarriageReturn::Newline)
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
    fn builtin_event_hub_publishes_mutation_events() {
        let state =
            BuiltinState::new(std::env::current_dir().unwrap(), Some(default_shell())).unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let rx = state.subscribe_events();

        state.handle_request("test", "tab.create", json!({ "label": "second" }));

        let event = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event["event"], "tab.created");
        assert_eq!(event["data"]["type"], "tab_created");
    }

    #[test]
    fn builtin_display_numbers_are_scoped_by_level() {
        let state =
            BuiltinState::new(std::env::current_dir().unwrap(), Some(default_shell())).unwrap();
        let empty_snapshot = state.handle_request("empty", "session.snapshot", json!({}));
        assert_eq!(
            empty_snapshot["result"]["snapshot"]["workspaces"]
                .as_array()
                .unwrap()
                .len(),
            0
        );

        let first_workspace_response = state.handle_request(
            "workspace-first",
            "workspace.create",
            json!({ "label": "First workspace" }),
        );
        let snapshot = state.handle_request("snapshot", "session.snapshot", json!({}));
        let first_workspace = snapshot["result"]["snapshot"]["workspaces"][0].clone();
        let first_workspace_id = first_workspace["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();

        assert_eq!(first_workspace["number"], 1);
        assert_eq!(first_workspace_response["result"]["workspace"]["number"], 1);
        assert_eq!(snapshot["result"]["snapshot"]["tabs"][0]["number"], 1);
        assert_eq!(snapshot["result"]["snapshot"]["panes"][0]["number"], 1);

        let second_tab = state.handle_request(
            "tab",
            "tab.create",
            json!({ "workspace_id": first_workspace_id, "label": "Second" }),
        );
        assert_eq!(second_tab["result"]["tab"]["number"], 2);
        assert_eq!(second_tab["result"]["root_pane"]["number"], 1);

        let second_workspace = state.handle_request(
            "workspace",
            "workspace.create",
            json!({ "label": "Second workspace" }),
        );
        let second_workspace_id = second_workspace["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();

        assert_eq!(second_workspace["result"]["workspace"]["number"], 2);
        assert_eq!(second_workspace["result"]["tab"]["number"], 1);
        assert_eq!(second_workspace["result"]["root_pane"]["number"], 1);

        let first_workspace_tabs = state.handle_request(
            "tabs-first",
            "tab.list",
            json!({ "workspace_id": first_workspace_id }),
        );
        let first_workspace_tab_numbers = first_workspace_tabs["result"]["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tab| tab["number"].as_u64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(first_workspace_tab_numbers, vec![1, 2]);

        let second_workspace_tabs = state.handle_request(
            "tabs-second",
            "tab.list",
            json!({ "workspace_id": second_workspace_id }),
        );
        let second_workspace_tab_numbers = second_workspace_tabs["result"]["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tab| tab["number"].as_u64().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(second_workspace_tab_numbers, vec![1]);
    }

    #[test]
    fn terminal_output_publishes_agent_status_changes() {
        let state =
            BuiltinState::new(std::env::current_dir().unwrap(), Some(default_shell())).unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let rx = state.subscribe_events();
        let terminal = {
            let data = state.data.lock().unwrap();
            let pane = data.panes.values().next().unwrap();
            data.terminals.get(&pane.terminal_id).unwrap().clone()
        };

        terminal.append_output("●·· batch ··● · 2/5 done".as_bytes());

        let event = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event["event"], "pane.agent_status_changed");
        assert_eq!(event["data"]["agent"], "jcode");
        assert_eq!(event["data"]["agent_status"], "working");
    }

    #[test]
    fn terminal_exit_notifies_subscribers_and_event_hub() {
        let hub = BuiltinEventHub::new();
        let events = hub.subscribe();
        let context = PaneEventContext {
            workspace_id: "ws_exit".to_string(),
            tab_id: "tab_exit".to_string(),
            pane_id: "pane_exit".to_string(),
            terminal_id: "term_exit".to_string(),
        };
        let terminal = TerminalRuntime::spawn(
            "term_exit".to_string(),
            std::env::current_dir().unwrap(),
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "printf done".to_string(),
            ],
            24,
            80,
            hub,
            context,
        )
        .unwrap();
        let (tx, rx) = mpsc::sync_channel(8);
        terminal.subscribe(tx);

        let mut saw_exit = false;
        for _ in 0..8 {
            match rx.recv_timeout(Duration::from_secs(1)).unwrap() {
                TerminalSubscriberMessage::Output(_) => {}
                TerminalSubscriberMessage::Exited => {
                    saw_exit = true;
                    break;
                }
            }
        }
        assert!(saw_exit);

        let event = events.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event["event"], "pane.exited");
        assert_eq!(event["data"]["pane_id"], "pane_exit");
        assert_eq!(event["data"]["terminal_id"], "term_exit");
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
            detect_agent_status(Some("jcode"), "⠋ thinking… 1.2s"),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "⠋ streaming · ↑1.2k ↓42 · 1.2s"),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "⠋ sending… 0.3s"),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "⠋ connecting… 0.3s"),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "··● bash ●·· · 12s"),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "··● bash ●··"),
            "working"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "●·· batch ··● · 2/5 done · last done: read · 1m 3s"
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "●·· batch ··● · 2/5 done"),
            "working"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "↻ network disconnected, waiting to retry · websocket · 8s"
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "Jcode is running this in the background. Progress, checkpoints, and completion will appear here.\n╭ ◌ bg run full Rust and JS tests · 5202362vb9 ╮\nLatest status: bg action=\"status\" task_id=\"5202362vb9\"\n❯"
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "╭ ✓ bg run full Rust and JS tests completed · 5202362vb9 ╮\nexit 0 · 5.7s\n❯"
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "Jcode is running this in the background. Progress, checkpoints, and completion will appear here.\n╭ ◌ bg run full Rust and JS tests · 5202362vb9 ╮\nLatest status: bg action=\"status\" task_id=\"5202362vb9\"\n╭ ✓ bg run full Rust and JS tests completed · 5202362vb9 ╮\nexit 0 · 5.7s\n❯"
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "Session ready\n❯"),
            "idle"
        );
        assert_eq!(detect_agent_status(Some("jcode"), "1> "), "idle");
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "1>                                                            together_ai/revolut ca/glm 5 2 · ~/repo"
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "We should deny this assumption in the explanation.\n❯ "
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "Permission request\n❯ Allow once\n  Deny\nold response line 1\nold response line 2\nold response line 3\nold response line 4\nold response line 5\nold response line 6\nold response line 7\nold response line 8\n❯ "
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "Processing request\nold response line 1\nold response line 2\nold response line 3\nold response line 4\n❯ "
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "··● bash ●·· · 12s\nold response line 1\nold response line 2\nold response line 3\nold response line 4\n❯ "
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "··● bash ●·· · 12s\nSession ready\n❯ "),
            "idle"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "Running tool bash\nresult mentions running tool\n❯ "
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "··● bash ●·· · 12s\n1> "),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "Running tool bash\n1> typed input"),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "Session ready\n❯\n··● bash ●·· · 12s"),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "··● not a toolbar\n❯"),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "plain prompt"),
            "unknown"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "⠋running analysis"),
            "unknown"
        );

        assert_eq!(
            detect_agent_label_from_text("●·· batch ··● · 2/5 done"),
            Some("jcode")
        );
        assert_eq!(
            detect_agent_label_from_text("↻ network disconnected, waiting to retry"),
            Some("jcode")
        );
    }

    #[test]
    fn detects_all_builtin_agent_screen_manifest_statuses() {
        let cases = [
            ("amp", "waiting for approval\nrun this command?", "blocked"),
            ("amp", "╰ amp thinking ─", "working"),
            ("amp", "project - amp - ready", "idle"),
            (
                "agy",
                "requesting permission for:\ndo you want to proceed?",
                "blocked",
            ),
            ("agy", "⠋ thinking", "working"),
            (
                "claude",
                "enter to select\nesc to cancel\narrow keys to navigate",
                "blocked",
            ),
            ("claude", "/btw\nesc to close", "working"),
            ("claude", "❯", "idle"),
            ("cline", "Let Cline use this tool?", "blocked"),
            ("cline", "Cline is reading context", "working"),
            ("codex", "Allow command?", "blocked"),
            ("codex", "⠋ thinking", "working"),
            ("codex", "codex ready", "idle"),
            (
                "cursor",
                "write to this file?\nproceed (y)\nreject & propose changes",
                "blocked",
            ),
            ("cursor", "⬡ thinking", "working"),
            (
                "devin",
                "approve once\nselect\nconfirm\nesc cancel",
                "blocked",
            ),
            ("devin", "running tools\nesc to interrupt", "working"),
            (
                "devin",
                "Ask Devin to build\nfeatures, fix bugs\nyour code",
                "idle",
            ),
            (
                "droid",
                "enter to select\nesc to cancel\n↑↓ to navigate",
                "blocked",
            ),
            ("droid", "esc to stop", "working"),
            ("gemini", "│ Apply this change", "blocked"),
            ("gemini", "esc to cancel", "working"),
            ("copilot", "enter to submit", "blocked"),
            ("copilot", "esc interrupt", "working"),
            ("grok", "┃ a (●) option", "blocked"),
            ("grok", "⠋ Run command", "working"),
            ("grok", "ctrl+.:shortcuts", "idle"),
            ("hermes", "dangerous command", "blocked"),
            ("hermes", "msg=interrupt", "working"),
            ("kilo", "△ Permission required", "blocked"),
            ("kilo", "esc interrupt", "working"),
            ("kimi", "↵ confirm\nrun this command?", "blocked"),
            ("kimi", "🌕", "working"),
            (
                "kiro",
                "requires approval\nyes, single permission",
                "blocked",
            ),
            ("kiro", "kiro is working", "working"),
            ("maki", "permission required\ny allow", "blocked"),
            ("maki", "⠋ [build]", "working"),
            ("maki", "[build]", "idle"),
            ("pi", "Working...", "working"),
            (
                "qodercli",
                "waiting for user confirmation\nyes/no",
                "blocked",
            ),
            ("qodercli", "(esc to cancel, keep working)", "working"),
        ];

        for (agent, text, expected) in cases {
            assert_eq!(
                detect_agent_status(Some(agent), text),
                expected,
                "agent {agent} text {text:?}"
            );
        }
    }

    #[test]
    fn jcode_status_covers_manifest_choice_combinations() {
        for allow in ["allow once", "always allow", "allow"] {
            for deny in ["deny", "reject", "cancel"] {
                let text = format!("Permission request\n{allow}\n{deny}");
                assert_eq!(detect_agent_status(Some("jcode"), &text), "blocked");
            }
        }

        for allow in ["allow", "yes"] {
            for deny in ["reject", "no", "cancel"] {
                let text = format!("Approve?\n{allow}\n{deny}");
                assert_eq!(detect_agent_status(Some("jcode"), &text), "blocked");
            }
        }

        for allow in ["allow", "yes", "proceed"] {
            for deny in ["reject", "no", "cancel"] {
                let text = format!("Confirm action\n{allow}\n{deny}");
                assert_eq!(detect_agent_status(Some("jcode"), &text), "blocked");
            }
        }

        for action in ["continue", "submit", "cancel"] {
            let text = format!("Enter your response\n{action}");
            assert_eq!(detect_agent_status(Some("jcode"), &text), "blocked");
        }

        for prompt in ["enter your response", "awaiting input", "waiting for user"] {
            let text = format!("Asking user\n{prompt}");
            assert_eq!(detect_agent_status(Some("jcode"), &text), "blocked");
        }

        for action in ["enter", "type", "respond"] {
            let text = format!("Awaiting input\n{action}");
            assert_eq!(detect_agent_status(Some("jcode"), &text), "blocked");
        }

        for status in [
            "running tool",
            "executing tool",
            "network disconnected, waiting to retry",
        ] {
            assert_eq!(detect_agent_status(Some("jcode"), status), "working");
        }

        for ready in ["session ready", "ready for input", "❯"] {
            assert_eq!(detect_agent_status(Some("jcode"), ready), "idle");
        }
    }

    #[test]
    fn jcode_tool_bar_matcher_tracks_manifest_shape() {
        for line in [
            "··● bash ●·· · 12s",
            "··● bash ●··",
            "●·· batch ··● · 2/5 done",
            "●·· batch ··● · 2/5 done · last done: read · 1m 3s",
        ] {
            assert!(has_jcode_tool_bar(line), "expected toolbar: {line:?}");
        }

        for line in [
            "··● not a toolbar",
            "·· bash ●··",
            "··● bash ●·",
            "··● bash ●··tail",
            "··● bash ●·· ·",
            "··● bash ●··· 12s",
        ] {
            assert!(!has_jcode_tool_bar(line), "unexpected toolbar: {line:?}");
        }
    }

    #[test]
    fn terminal_screen_text_applies_common_tui_rewrites() {
        assert_eq!(
            terminal_screen_text_lossy("Session ready\n❯\r\u{1b}[2K··● bash ●·· · 12s"),
            "Session ready\n··● bash ●·· · 12s"
        );
        assert_eq!(
            terminal_screen_text_lossy(
                "Session ready\n··● bash ●·· · 12s\r\u{1b}[2KSession ready\n❯"
            ),
            "Session ready\nSession ready\n❯"
        );
        assert_eq!(terminal_screen_text_lossy("old\u{1b}[2Jnew"), "new");
        assert_eq!(terminal_screen_text_lossy("abc\rxy"), "xyc");
        assert_eq!(terminal_screen_text_lossy("abc\u{8}d"), "abd");
        assert_eq!(terminal_screen_text_lossy("abc\u{1b}[2G\u{1b}[1K"), "  c");
        assert_eq!(
            terminal_screen_text_lossy("one\ntwo\u{1b}[1A\rONE"),
            "ONE\ntwo"
        );
        assert_eq!(
            terminal_screen_text_lossy("\u{1b}]0;title\u{7}ready"),
            "ready"
        );
    }

    #[test]
    fn jcode_status_uses_screen_not_stale_ansi_history() {
        let working_screen =
            terminal_screen_text_lossy("Session ready\n❯\r\u{1b}[2K··● bash ●·· · 12s");
        assert_eq!(
            detect_agent_status(Some("jcode"), &working_screen),
            "working"
        );

        let idle_screen = terminal_screen_text_lossy(
            "Session ready\n··● bash ●·· · 12s\r\u{1b}[2KSession ready\n❯",
        );
        assert_eq!(detect_agent_status(Some("jcode"), &idle_screen), "idle");
        assert_eq!(detect_agent_label_from_text(&idle_screen), Some("jcode"));

        let blocked_screen = terminal_screen_text_lossy(
            "··● bash ●·· · 12s\r\u{1b}[2KApprove?\n❯ Allow\n  Reject\nEsc to cancel",
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), &blocked_screen),
            "blocked"
        );
    }

    #[test]
    fn enriches_terminal_path_for_launch_agent_shells() {
        let path = enriched_terminal_path(Some("/usr/bin:/bin:/opt/homebrew/bin"), "/Users/alex");
        let entries = path.split(':').collect::<Vec<_>>();

        assert!(entries.contains(&"/Users/alex/.pyenv/bin"));
        assert!(entries.contains(&"/Users/alex/.jenv/bin"));
        assert!(entries.contains(&"/Users/alex/.local/bin"));
        assert!(entries.contains(&"/opt/homebrew/bin"));
        assert_eq!(
            entries
                .iter()
                .filter(|entry| **entry == "/opt/homebrew/bin")
                .count(),
            1
        );
        assert!(is_shell_program("/bin/zsh"));
        assert!(is_shell_program("-zsh"));
        assert!(!is_shell_program("jcode"));
    }

    #[test]
    fn parses_path_helper_output() {
        assert_eq!(
            parse_path_helper_output("PATH=\"/usr/local/bin:/usr/bin:/bin\"; export PATH;"),
            Some("/usr/local/bin:/usr/bin:/bin".to_string())
        );
    }

    #[test]
    fn detects_jcode_from_terminal_process_tree() {
        let processes = parse_process_table(
            r#"
              10     1 /bin/zsh -zsh
              11    10 /opt/homebrew/bin/node node /Users/alex/.local/bin/jcode
              12    11 /Users/alex/.local/bin/jcode jcode
              20     1 /Users/alex/.local/bin/jcode jcode
              30     1 /opt/homebrew/bin/node node /Users/alex/.local/bin/jcode
            "#,
        );

        assert_eq!(
            detect_agent_label_from_processes(10, &processes),
            Some("jcode")
        );
        assert_eq!(
            detect_agent_label_from_processes(20, &processes),
            Some("jcode")
        );
        assert_eq!(
            detect_agent_label_from_processes(30, &processes),
            Some("jcode")
        );
        assert_eq!(detect_agent_label_from_processes(999, &processes), None);
    }

    #[test]
    fn detects_jcode_wrapped_processes_like_herdr() {
        let processes = parse_process_table(
            r#"
              10     1 /bin/zsh -zsh
              11    10 /opt/homebrew/bin/node node -- /Users/alex/bin/jcode.js
              20     1 /opt/homebrew/bin/bun bun /Users/alex/bin/jcode
              30     1 /opt/homebrew/bin/python3 python3 /Users/alex/bin/jcode
              40     1 /usr/bin/env jcode
              50     1 /opt/homebrew/bin/node node --require /Users/alex/bin/jcode /Users/alex/app.js
              60     1 /opt/homebrew/bin/node node -e /Users/alex/bin/jcode
            "#,
        );

        assert_eq!(
            detect_agent_label_from_processes(10, &processes),
            Some("jcode")
        );
        assert_eq!(
            detect_agent_label_from_processes(20, &processes),
            Some("jcode")
        );
        assert_eq!(
            detect_agent_label_from_processes(30, &processes),
            Some("jcode")
        );
        assert_eq!(
            detect_agent_label_from_processes(40, &processes),
            Some("jcode")
        );
        assert_eq!(detect_agent_label_from_processes(50, &processes), None);
        assert_eq!(detect_agent_label_from_processes(60, &processes), None);
    }

    #[test]
    fn tokenizes_process_args_with_quotes_for_detection() {
        assert_eq!(
            process_args_tokens("node '/Users/alex/bin/jcode.js' --flag"),
            vec!["node", "/Users/alex/bin/jcode.js", "--flag"]
        );
        assert_eq!(
            process_args_tokens("node \"/Users/alex/bin/jcode.js\""),
            vec!["node", "/Users/alex/bin/jcode.js"]
        );
        assert_eq!(
            process_args_tokens(r"node /Users/alex/bin/jcode\ cli"),
            vec!["node", "/Users/alex/bin/jcode cli"]
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
            detect_agent_status(Some("opencode"), "esc dismiss\nenter submit\n⇆ tab"),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(Some("opencode"), "esc dismiss\nenter toggle\n↑↓ select"),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(Some("opencode"), "opencode · esc to interrupt"),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("opencode"), "opencode · esc again to interrupt"),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("opencode"), "opencode escaped interrupt"),
            "unknown"
        );
        assert_eq!(
            detect_agent_status(Some("opencode"), "esc interrupt before opencode"),
            "unknown"
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

    #[test]
    fn builtin_state_starts_without_auto_workspace() {
        let state = BuiltinState::new(std::env::temp_dir(), Some(default_shell())).unwrap();

        let snapshot = state.handle_request("snapshot", "session.snapshot", json!({}));
        let snapshot = &snapshot["result"]["snapshot"];

        assert_eq!(snapshot["workspaces"].as_array().unwrap().len(), 0);
        assert_eq!(snapshot["tabs"].as_array().unwrap().len(), 0);
        assert_eq!(snapshot["panes"].as_array().unwrap().len(), 0);
        assert!(snapshot["focused_workspace_id"].is_null());
    }

    #[cfg(unix)]
    #[test]
    fn events_subscribe_streams_builtin_event_hub_messages() {
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
        {
            let mut seed = connect_local_stream(&api_socket).unwrap();
            seed.write_all(
                br#"{"id":"seed","method":"workspace.create","params":{"label":"seed"}}"#,
            )
            .unwrap();
            seed.write_all(b"\n").unwrap();
            seed.flush().unwrap();
            let mut reader = BufReader::new(seed);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(line.contains("workspace_created"));
        }
        let (tx, rx) = mpsc::channel::<String>();
        let subscribe_socket = api_socket.clone();
        thread::spawn(move || {
            let mut stream = connect_local_stream(&subscribe_socket).unwrap();
            stream
                .write_all(br#"{"id":"events","method":"events.subscribe","params":{}}"#)
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
            let mut reader = BufReader::new(stream);
            for _ in 0..2 {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                tx.send(line).unwrap();
            }
        });

        let ack = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(ack.contains("subscription_started"));
        let mut control = connect_local_stream(&api_socket).unwrap();
        control
            .write_all(br#"{"id":"tab","method":"tab.create","params":{"label":"evented"}}"#)
            .unwrap();
        control.write_all(b"\n").unwrap();
        control.flush().unwrap();

        let event = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let event: Value = serde_json::from_str(&event).unwrap();
        assert_eq!(event["event"], "tab.created");
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
