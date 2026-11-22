//! Socket listeners, version/size constants, and the backend handle lifecycle.

use super::*;

pub(super) const BUILTIN_VERSION: &str = "builtin-0.1.0";

pub(super) const PROTOCOL_VERSION: u32 = 22;

pub(super) const MAX_FRAME_SIZE: usize = 32 * 1024 * 1024;

pub(super) const MAX_SCROLLBACK_BYTES: usize = 8 * 1024 * 1024;

pub(super) const MAX_SUBSCRIBER_PENDING_BYTES: usize = 2 * MAX_SCROLLBACK_BYTES;

pub(super) const DETECTION_TAIL_BYTES: usize = 64 * 1024;

/// Tail the chat-resolution PaneContext carries. The recency tiebreak
/// matches a <=400-char chunk of the candidate's last assistant text
/// against this tail, so 64KB is far beyond any match it could need;
/// the strip of the full scrollback this replaces cost an 8MB copy plus
/// a full ANSI scan on every conversation poll and every agents-list
/// refresh. Same size as DETECTION_TAIL_BYTES by coincidence, not
/// coupling: either can change alone.
pub(super) const RESOLVE_TAIL_BYTES: usize = 64 * 1024;

/// Attach replay cap. A full scrollback replay costs an 8MB frame, a
/// multi-second wasm parse on the client, and a multi-second writer drain on
/// the server side. The bounded tail keeps the visible state (well under
/// 256KB for any real session) while old scrollback stays server-side only.
pub(super) const ATTACH_REPLAY_MAX_BYTES: usize = 256 * 1024;

/// Screen-format pane.read emulation window. A fullscreen TUI repaints its
/// whole screen frequently, so the emulated tail needs enough bytes to
/// cover the last full repaint or the preview renders a half-erased screen.
/// 256KB matches the attach replay bound: enough for many full repaints of
/// a dense screen, cheap enough for the 200ms TUI tail poll cadence.
pub(super) const PANE_READ_SCREEN_TAIL_BYTES: usize = 256 * 1024;

/// Mouse + bracketed-paste resets synthesized on agent exit. jcode never
/// emits DECRST itself (crossterm's try_restore only restores raw mode and
/// leaves the alternate screen), so its DECSET mouse-tracking bytes would
/// otherwise keep the client adapter forwarding wheel reports into a shell
/// that echoes them as garbage.
pub(super) const AGENT_EXIT_DECRST_BYTES: &[u8] =
    b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1015l\x1b[?1006l\x1b[?2004l";

/// Gap between a composer message's bracketed paste and its Enter. Must
/// exceed jcode's 150ms paste-trailing-Enter suppression window
/// (`paste_guard.rs`, jcode issue #544) or the submit is swallowed.
pub(super) const AGENT_PROMPT_ENTER_GAP_MS: u64 = 300;

/// Composer message cap, matching the upstream reference (one message must
/// fit in a single submit; larger input goes through the terminal itself).
pub(super) const MAX_COMPOSER_CHARS: usize = 20_000;

/// Optional TTL for `RecentAgentProcessExit` records. `None` matches upstream
/// herdr: the record never expires on its own in production and is only
/// cleared when a live agent process is detected again (or the record is
/// explicitly reset). Set to `Some(Duration)` to auto-expire records if the
/// suppression ever needs to be time-bounded.
pub(super) const RECENT_AGENT_EXIT_TTL: Option<Duration> = None;

pub(super) const SOCKET_PERMISSION_MODE: u32 = 0o600;

pub(super) type LocalListener = interprocess::local_socket::Listener;

#[derive(Debug, Clone)]
pub(crate) struct BuiltinBackendConfig {
    pub api_socket: PathBuf,
    pub client_socket: PathBuf,
    pub cwd: PathBuf,
    pub shell: Option<String>,
    pub jcode_detection_variant: JcodeDetectionVariant,
    // Directory holding this session's journal file. None disables
    // persistence entirely (unit tests run fully in-memory).
    pub journal_dir: Option<PathBuf>,
}

pub(crate) struct BuiltinBackendHandle {
    _inner: Arc<BuiltinBackendInner>,
}

pub(super) struct BuiltinBackendInner {
    pub(super) running: AtomicBool,
    pub(super) api_socket: PathBuf,
    pub(super) client_socket: PathBuf,
    pub(super) state: Arc<BuiltinState>,
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

        let journal_path = config
            .journal_dir
            .as_ref()
            .map(|dir| dir.join(SESSION_JOURNAL_FILE));
        let mut state =
            BuiltinState::new(config.cwd, config.shell, config.jcode_detection_variant)?;
        state.journal_path = journal_path.clone();
        let state = Arc::new(state);
        // Replay runs before the listeners bind: the first snapshot any
        // client pulls already carries the recovered workspaces.
        if let Some(journal_path) = &journal_path {
            replay_session_journal(&state, journal_path);
        }
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

    /// True while the backend listener threads are still accepting. Turns
    /// false when the handle is dropped (session closed) or the listeners
    /// exited, so callers can detect a dead session whose socket files may
    /// still linger.
    pub(crate) fn is_running(&self) -> bool {
        self._inner
            .running
            .load(std::sync::atomic::Ordering::Acquire)
    }
}

pub(super) fn spawn_api_listener(listener: LocalListener, backend: Arc<BuiltinBackendInner>) {
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

pub(super) fn spawn_client_listener(listener: LocalListener, backend: Arc<BuiltinBackendInner>) {
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

pub(super) fn handle_api_connection(
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

/// Decide whether a `read_message` error string is the client closing
/// the socket. `read_message` stamps every io error with the stage and
/// `(kind <Kind>)`, and `read_exact` on a closed socket yields
/// `UnexpectedEof`, so the marker is unambiguous: real transport failures
/// come back as `ConnectionReset`/`BrokenPipe`/`WouldBlock`, not EOF.
/// Kept as a string check because `read_message` returns `String` errors;
/// matching the kind token keeps this stable against std rewording the
/// "failed to fill whole buffer" prose the previous check relied on.
pub(super) fn is_client_disconnect(err: &str) -> bool {
    err.contains("(kind UnexpectedEof)")
}

pub(super) fn handle_client_connection(
    mut stream: LocalStream,
    backend: Arc<BuiltinBackendInner>,
) -> Result<(), String> {
    // Client EOF (socket closed, mid-frame or between frames) is a normal
    // disconnect, not a backend failure: the "terminal connection failed"
    // line it produced on every clean teardown drowned real errors and
    // could land half-written when the guard's kill() raced the print.
    // Match our own `read frame length/body: ... (kind UnexpectedEof)`
    // marker, not std's "failed to fill whole buffer" prose: the prose is
    // an implementation detail of ReadBytesExt that a std upgrade can
    // reword, while the kind marker is ours and stays stable.
    let hello = match read_message::<_, ClientMessage>(&mut stream, MAX_FRAME_SIZE) {
        Ok(hello) => hello,
        Err(err) if is_client_disconnect(&err) => return Ok(()),
        Err(err) => return Err(err),
    };
    let (cols, rows) = match hello {
        ClientMessage::TerminalHello {
            version,
            cols,
            rows,
            ..
        } => {
            // herdr 0.9.0 requires an exact protocol version match.
            let error = (version != PROTOCOL_VERSION).then(|| {
                if version > PROTOCOL_VERSION {
                    format!(
                        "client version {version} is newer than server version {PROTOCOL_VERSION}"
                    )
                } else {
                    format!(
                        "client version {version} is older than server version {PROTOCOL_VERSION}; please upgrade your herdr client"
                    )
                }
            });
            write_message(
                &mut stream,
                &ServerMessage::Welcome {
                    version: PROTOCOL_VERSION,
                    encoding: RenderEncoding::TerminalAnsi,
                    error,
                },
            )?;
            if version != PROTOCOL_VERSION {
                return Ok(());
            }
            (cols.max(1), rows.max(1))
        }
        _ => return Err("expected TerminalHello as first terminal client message".to_string()),
    };

    let mut attached: Option<Arc<TerminalRuntime>> = None;
    let mut writer_tx: Option<mpsc::Sender<TerminalSubscriberMessage>> = None;
    // The pending counter for the live writer subscription, hoisted here so
    // the re-attach branch can charge replay frames against the same
    // counter the writer thread discharges.
    let mut subscriber_pending_bytes: Option<Arc<AtomicUsize>> = None;
    let terminal_size = Arc::new(Mutex::new((cols, rows)));
    loop {
        let message = match read_message::<_, ClientMessage>(&mut stream, MAX_FRAME_SIZE) {
            Ok(message) => message,
            Err(err) if is_client_disconnect(&err) => break,
            Err(err) => return Err(err),
        };
        match message {
            ClientMessage::AttachTerminal { terminal_id, .. } => {
                let terminal = backend
                    .state
                    .terminal(&terminal_id)
                    .ok_or_else(|| format!("terminal {terminal_id} not found"))?;
                terminal.resize(rows, cols);
                // The socket is written only by the writer thread from here
                // on. Writing the history frame from this loop while the
                // writer thread pumps live output interleaved two `write_all`
                // sequences mid-frame; the reader then decoded garbage frames
                // ("trailing bytes in frame") and whole PTY bursts were lost
                // when bulk output floods raced the attach replay.
                // Bounded tail (not full history): the client emulator parses
                // 256KB in one paint instead of multi-second 8MB drains, and
                // the `full: true` semantics are unchanged (the frame still
                // replaces local scrollback, just with the recent window).
                let history = terminal.attach_replay_bytes();
                if let Some(tx) = &writer_tx {
                    // Re-attach on a live connection: deliver a fresh replay
                    // of the history accumulated since the last attach. The
                    // pending counter belongs to the writer thread's
                    // subscriber; the replay is queued through the same
                    // channel so frames stay ordered behind any live
                    // output. Charge the frame's own length or the writer's
                    // subtraction below underflows the counter and the next
                    // output byte sheds a healthy re-attached client.
                    let replay_len = history.len().max(1);
                    if let Some(pending) = &subscriber_pending_bytes {
                        pending.fetch_add(replay_len, Ordering::AcqRel);
                        if tx
                            .send(TerminalSubscriberMessage::Replay(
                                Box::new(ServerMessage::Terminal(TerminalFrame {
                                    seq: 0,
                                    width: cols,
                                    height: rows,
                                    full: true,
                                    bytes: history,
                                })),
                                replay_len,
                            ))
                            .is_err()
                        {
                            pending.fetch_sub(replay_len, Ordering::AcqRel);
                        }
                    }
                    attached = Some(terminal);
                    continue;
                }
                let (tx, rx) = mpsc::channel::<TerminalSubscriberMessage>();
                let pending_bytes = Arc::new(AtomicUsize::new(0));
                let replay_len = history.len().max(1);
                pending_bytes.fetch_add(replay_len, Ordering::AcqRel);
                let history_frame = ServerMessage::Terminal(TerminalFrame {
                    seq: 1,
                    width: cols,
                    height: rows,
                    full: true,
                    bytes: history,
                });
                let subscriber = TerminalSubscriber {
                    tx: tx.clone(),
                    pending_bytes: Arc::clone(&pending_bytes),
                };
                if subscriber
                    .tx
                    .send(TerminalSubscriberMessage::Replay(
                        Box::new(history_frame),
                        replay_len,
                    ))
                    .is_err()
                {
                    pending_bytes.fetch_sub(replay_len, Ordering::AcqRel);
                    continue;
                }
                terminal.subscribe(subscriber);
                // Clone before the writer thread moves the Arc: the re-attach
                // branch charges replays against this same counter.
                let pending_for_reattach = Arc::clone(&pending_bytes);
                let mut writer = stream.try_clone().map_err(|err| err.to_string())?;
                let terminal_size = Arc::clone(&terminal_size);
                thread::spawn(move || {
                    let mut seq = 2_u64;
                    while let Ok(message) = rx.recv() {
                        match message {
                            TerminalSubscriberMessage::Replay(frame, charged_len) => {
                                if write_message(&mut writer, &frame).is_err() {
                                    break;
                                }
                                // Decrement only after the kernel accepted
                                // the frame: a blocked write still counts as
                                // pending, or a stalled client never trips
                                // the shed while the writer sits in write(2).
                                // charged_len is the length this frame's send
                                // added, so re-attach replays stay balanced
                                // instead of subtracting the first attach's
                                // capture.
                                pending_bytes.fetch_sub(charged_len, Ordering::AcqRel);
                            }
                            TerminalSubscriberMessage::Output(bytes) => {
                                let (width, height) = terminal_size
                                    .lock()
                                    .map(|size| *size)
                                    .unwrap_or((cols, rows));
                                // TerminalFrame serializes owned bytes on the
                                // wire; move out of the shared Arc (the last
                                // writer to touch the chunk pays the copy).
                                let frame = ServerMessage::Terminal(TerminalFrame {
                                    seq,
                                    width,
                                    height,
                                    full: false,
                                    bytes: (*bytes).clone(),
                                });
                                seq += 1;
                                if write_message(&mut writer, &frame).is_err() {
                                    break;
                                }
                                // Same rule as Replay: the chunk stays
                                // pending until write_message returns, so a
                                // slow client inflates the counter even
                                // while the writer is blocked in write(2).
                                pending_bytes.fetch_sub(bytes.len(), Ordering::AcqRel);
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
                            TerminalSubscriberMessage::Overflow => {
                                let _ = write_message(
                                    &mut writer,
                                    &ServerMessage::ServerShutdown {
                                        reason: Some(
                                            "terminal output backlog overflow".to_string(),
                                        ),
                                    },
                                );
                                break;
                            }
                        }
                    }
                });
                writer_tx = Some(tx);
                subscriber_pending_bytes = Some(pending_for_reattach);
                attached = Some(terminal);
            }
            ClientMessage::Input { data } => {
                if let Some(terminal) = &attached {
                    terminal.write_input(&data).map_err(|err| err.to_string())?;
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
                // Built-in MVP keeps the browser terminal as the scrollback renderer. The web
                // adapter will fall back to local scrolling for this backend.
            }
            ClientMessage::Detach => break,
            ClientMessage::ClipboardImage { .. } => {}
            ClientMessage::TerminalHello { .. } => {}
            // Protocol 22 messages from graphics streaming, client-owned
            // shells, and terminal control modes are not used by the built-in
            // backend.
            ClientMessage::ObserveTerminal { .. }
            | ClientMessage::ControlTerminal { .. }
            | ClientMessage::GraphicsTransmissionResult { .. }
            | ClientMessage::GraphicsTransmissionStarted { .. }
            | ClientMessage::ClientShellHello { .. }
            | ClientMessage::ClientShellResize { .. }
            | ClientMessage::ClientShellPaneInput { .. }
            | ClientMessage::ClientShellPopupInput { .. }
            | ClientMessage::ClientShellEndpointRequest { .. }
            | ClientMessage::AttachMouse { .. }
            | ClientMessage::ClientShellHostTheme { .. }
            | ClientMessage::ClientShellFocus { .. }
            | ClientMessage::ClientShellMouseCapture { .. }
            | ClientMessage::EndpointControl { .. } => {}
        }
    }
    Ok(())
}

/// Cap on concurrent shell spawns during replay. Each spawn forks a process
/// (openpty + exec); the cap keeps fork storms off the system when a
/// journal holds many workspaces.
pub(super) const REPLAY_WORKERS: usize = 8;

pub(super) fn required_string(params: &Value, key: &str) -> Result<String, String> {
    optional_string(params, key).ok_or_else(|| format!("{key} is required"))
}

pub(super) fn optional_string(params: &Value, key: &str) -> Option<String> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub(super) fn optional_bool(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(Value::as_bool)
}

pub(super) fn success_response(id: &str, result: Value) -> Value {
    json!({ "id": id, "result": result })
}

pub(super) fn error_response(id: &str, code: &str, message: impl Into<String>) -> Value {
    json!({ "id": id, "error": { "code": code, "message": message.into() } })
}

pub(super) fn write_json_line(stream: &mut LocalStream, value: &Value) -> io::Result<()> {
    stream.write_all(value.to_string().as_bytes())?;
    stream.write_all(b"\n")?;
    stream.flush()
}

pub(super) fn prepare_socket_path(path: &Path) -> io::Result<()> {
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

pub(super) fn local_socket_active(path: &Path) -> bool {
    connect_local_stream(path).is_ok()
}

pub(super) fn bind_local_listener(path: &Path) -> io::Result<LocalListener> {
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

pub(super) fn restrict_socket_permissions(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(SOCKET_PERMISSION_MODE))?;
    }
    Ok(())
}

pub(super) fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}
