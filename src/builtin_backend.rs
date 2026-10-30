use std::collections::VecDeque;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use interprocess::local_socket::traits::ListenerExt as _;
use interprocess::TryClone as _;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};

use crate::builtin_detection::{
    amp::detect_amp_status,
    antigravity::detect_antigravity_status,
    claude::detect_claude_status,
    claude::has_claude_half_circle_spinner,
    cline::detect_cline_status,
    codex::detect_codex_status,
    copilot::detect_copilot_status,
    cursor::detect_cursor_status,
    devin::detect_devin_status,
    droid::detect_droid_status,
    gemini::detect_gemini_status,
    grok::detect_grok_status,
    hermes::detect_hermes_status,
    kilo::detect_kilo_status,
    kimi::detect_kimi_status,
    kiro::detect_kiro_status,
    maki::detect_maki_status,
    opencode::detect_opencode_status,
    pi::detect_pi_status,
    qodercli::detect_qodercli_status,
    qwen::detect_qwen_status,
    scrape::{bottom_non_empty_lines, contains_any, contains_braille, starts_with_braille},
};
use crate::builtin_detection::{
    jcode::{
        detect_jcode_status_with_variant, has_jcode_spinner, is_jcode_active_background_line,
        jcode_blocked as jcode_blocked_markers, jcode_numbered_prompt_line,
        jcode_shell_prompt_line, mentions_jcode_brand,
    },
    JcodeDetectionVariant,
};
use crate::builtin_events::{BuiltinEventHub, PaneEventContext};
use crate::chat_lens;
use crate::protocol::{
    read_message, write_message, ClientMessage, RenderEncoding, ServerMessage, TerminalFrame,
};
use crate::terminal_text::{self, TerminalTextOptions};

const BUILTIN_VERSION: &str = "builtin-0.1.0";
// Must match the WebUI terminal attach client (`PROTOCOL_VERSION` in main.rs,
// 22 for herdr 0.9.0): the builtin backend emulates a herdr terminal server
// and requires an exact version match at handshake time. A mismatch made
// every builtin terminal attach fail with a `herdr_error` frame, so the
// browser offered the (also broken) built-in fallback and its question
// modal blocked the whole UI.
const PROTOCOL_VERSION: u32 = 22;
const MAX_FRAME_SIZE: usize = 32 * 1024 * 1024;
const MAX_SCROLLBACK_BYTES: usize = 8 * 1024 * 1024;
// Per-subscriber live-output backlog before the subscriber is shed. Must
// exceed MAX_SCROLLBACK_BYTES so a full-history replay never trips the shed.
const MAX_SUBSCRIBER_PENDING_BYTES: usize = 2 * MAX_SCROLLBACK_BYTES;
const DETECTION_TAIL_BYTES: usize = 64 * 1024;
/// Tail the chat-resolution PaneContext carries. The recency tiebreak
/// matches a <=400-char chunk of the candidate's last assistant text
/// against this tail, so 64KB is far beyond any match it could need;
/// the strip of the full scrollback this replaces cost an 8MB copy plus
/// a full ANSI scan on every conversation poll and every agents-list
/// refresh. Same size as DETECTION_TAIL_BYTES by coincidence, not
/// coupling: either can change alone.
const RESOLVE_TAIL_BYTES: usize = 64 * 1024;
/// Gap between a composer message's bracketed paste and its Enter. Must
/// exceed jcode's 150ms paste-trailing-Enter suppression window
/// (`paste_guard.rs`, jcode issue #544) or the submit is swallowed.
const AGENT_PROMPT_ENTER_GAP_MS: u64 = 300;
/// Composer message cap, matching the upstream reference (one message must
/// fit in a single submit; larger input goes through the terminal itself).
const MAX_COMPOSER_CHARS: usize = 20_000;

/// A composer message as sent: trailing newlines are the composer's, not the
/// text's; CRLF reads as one newline. Mirrors upstream `composerMessage`.
fn composer_message(text: &str) -> String {
    let trimmed = text.trim_end_matches(['\r', '\n']);
    trimmed.replace("\r\n", "\n").replace('\r', "\n")
}

/// One bracketed paste: newlines become CR inside the paste block so a
/// multi-line message stays one prompt instead of one submit per line.
fn bracketed_paste_payload(message: &str) -> String {
    let body = message.replace('\n', "\r");
    format!("\u{1b}[200~{body}\u{1b}[201~")
}
/// Optional TTL for `RecentAgentProcessExit` records. `None` matches upstream
/// herdr: the record never expires on its own in production and is only
/// cleared when a live agent process is detected again (or the record is
/// explicitly reset). Set to `Some(Duration)` to auto-expire records if the
/// suppression ever needs to be time-bounded.
const RECENT_AGENT_EXIT_TTL: Option<Duration> = None;
const SOCKET_PERMISSION_MODE: u32 = 0o600;

/// Mirrors upstream herdr's `terminal::state::RecentAgentProcessExit`:
/// recorded once when a previously-live agent process disappears from the
/// pane's process tree (the user quit jcode inside the shell, so the pane
/// itself keeps running). While present, the pane must stop reporting the
/// exited agent, otherwise stale screen text / OSC payloads keep a ghost
/// agent row alive in `agent.list`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RecentAgentProcessExit {
    agent: &'static str,
    observed_at: Instant,
}

impl RecentAgentProcessExit {
    /// A record is active until an optional TTL elapses. With
    /// `RECENT_AGENT_EXIT_TTL = None` records stay active until a live agent
    /// process is detected again, matching upstream herdr's behavior.
    fn is_active(&self, now: Instant) -> bool {
        RECENT_AGENT_EXIT_TTL.is_none_or(|ttl| now.duration_since(self.observed_at) < ttl)
    }
}

/// Captures the latest OSC 9 progress payload from raw PTY bytes.
/// Some agents emit `ESC]9;<agent>:<state> BEL` as a structured
/// side-channel for agent status detection, avoiding fragile screen-scraping.
/// Real jcode (master) does not emit it; jcode status rides on the terminal
/// title (` · work ~` / ` · last ~`, see `osc_title_status_for_agent`) plus
/// the screen-scrape fallback. This tracker serves agents that do use the
/// channel (amp, codex, hermes, qwen, grok, claude) and a hypothetical jcode
/// build with the herdr_detectable side-channel.
/// This is a minimal state machine that tracks the OSC body between
/// `ESC ]` and `BEL` (0x07) or `ST` (`ESC \`).
///
/// Matching upstream herdr's `AgentOscStateTracker`, the latest payload is
/// retained without a TTL: agents on this channel emit on state change only
/// (upstream jcode dedups in `agent_osc_state`), so a timestamped staleness
/// window would treat every long turn as "no recent status" and silently
/// degrade to screen-scraping.
/// Staleness is handled structurally instead: `reset()` clears the payload
/// when the terminal exits, and `notify_exited` clears it when the agent
/// process disappears.
#[derive(Default)]
struct Osc9Tracker {
    state: Osc9State,
    body: Vec<u8>,
    latest_payload: Option<String>,
    /// Latest OSC 0 terminal title, used for `osc_title` detection rules.
    latest_title: Option<String>,
}

#[derive(Default, Clone, Copy, PartialEq, Eq)]
enum Osc9State {
    #[default]
    Ground,
    Escape,
    OscBody,
    OscEscape,
}

impl Osc9Tracker {
    fn observe(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            match self.state {
                Osc9State::Ground => {
                    if byte == 0x1b {
                        self.state = Osc9State::Escape;
                    }
                }
                Osc9State::Escape => {
                    if byte == b']' {
                        self.body.clear();
                        self.state = Osc9State::OscBody;
                    } else if byte == 0x1b {
                        self.state = Osc9State::Escape;
                    } else {
                        self.state = Osc9State::Ground;
                    }
                }
                Osc9State::OscBody => match byte {
                    0x07 => {
                        self.finalize();
                        self.state = Osc9State::Ground;
                    }
                    0x1b => self.state = Osc9State::OscEscape,
                    _ => self.body.push(byte),
                },
                Osc9State::OscEscape => {
                    if byte == b'\\' {
                        self.finalize();
                        self.state = Osc9State::Ground;
                    } else {
                        self.body.push(0x1b);
                        self.body.push(byte);
                        self.state = Osc9State::OscBody;
                    }
                }
            }

            if self.body.len() > 4096 {
                self.body.clear();
                self.state = Osc9State::Ground;
            }
        }
    }

    fn finalize(&mut self) {
        if let Some((command, payload)) = parse_osc_body(&self.body) {
            if command == b"9" {
                let text = String::from_utf8_lossy(payload);
                let sanitized: String = text.chars().filter(|c| !c.is_control()).collect();
                if !sanitized.is_empty() {
                    self.latest_payload = Some(sanitized);
                }
            } else if command == b"0" || command == b"2" {
                // OSC 0 and OSC 2 both set the terminal title.
                let text = String::from_utf8_lossy(payload);
                let sanitized: String = text.chars().filter(|c| !c.is_control()).collect();
                if !sanitized.is_empty() {
                    self.latest_title = Some(sanitized);
                }
            }
        }
        self.body.clear();
    }

    /// Returns the latest OSC 9 progress payload, or `""` if none has been
    /// seen. The payload is retained until the terminal exits or the agent
    /// process disappears (`reset`), matching upstream herdr's
    /// `AgentOscStateTracker::latest_progress`.
    fn latest_progress(&self) -> &str {
        self.latest_payload.as_deref().unwrap_or("")
    }

    /// Extract a stable agent label from the OSC 9 progress payload when the
    /// payload follows a `<agent>:<state>` convention (the herdr_detectable
    /// jcode branch emits `jcode:working`, `jcode:idle`, `jcode:blocked`;
    /// jcode master does not emit OSC 9). This lets the backend
    /// identify the agent from its side-channel even when argv and process-tree
    /// detection fail (e.g. an agent launched through a wrapper script or shell
    /// that hides the binary name).
    fn latest_agent_label(&self) -> Option<&'static str> {
        let payload = self.latest_payload.as_deref()?;
        let colon = payload.find(':')?;
        let prefix = &payload[..colon];
        match prefix {
            "jcode" => Some("jcode"),
            _ => None,
        }
    }

    /// Clear all captured payloads. Called when the terminal exits so a stale
    /// OSC status does not persist after the agent process is gone.
    fn reset(&mut self) {
        self.latest_payload = None;
        self.latest_title = None;
        self.body.clear();
        self.state = Osc9State::Ground;
    }

    /// Returns the latest OSC 0/2 terminal title, if any.
    fn latest_title(&self) -> &str {
        self.latest_title.as_deref().unwrap_or("")
    }
}

fn parse_osc_body(body: &[u8]) -> Option<(&[u8], &[u8])> {
    let sep = body.iter().position(|&b| b == b';')?;
    Some((&body[..sep], &body[sep + 1..]))
}

type LocalListener = interprocess::local_socket::Listener;
type LocalStream = interprocess::local_socket::Stream;

#[derive(Debug, Clone)]
pub(crate) struct BuiltinBackendConfig {
    pub api_socket: PathBuf,
    pub client_socket: PathBuf,
    pub cwd: PathBuf,
    pub shell: Option<String>,
    pub jcode_detection_variant: JcodeDetectionVariant,
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

        let state = Arc::new(BuiltinState::new(
            config.cwd,
            config.shell,
            config.jcode_detection_variant,
        )?);
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

/// Decide whether a `read_message` error string is the client closing
/// the socket. `read_message` stamps every io error with the stage and
/// `(kind <Kind>)`, and `read_exact` on a closed socket yields
/// `UnexpectedEof`, so the marker is unambiguous: real transport failures
/// come back as `ConnectionReset`/`BrokenPipe`/`WouldBlock`, not EOF.
/// Kept as a string check because `read_message` returns `String` errors;
/// matching the kind token keeps this stable against std rewording the
/// "failed to fill whole buffer" prose the previous check relied on.
fn is_client_disconnect(err: &str) -> bool {
    err.contains("(kind UnexpectedEof)")
}

fn handle_client_connection(
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
                let history = terminal.history_bytes();
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

struct BuiltinState {
    data: Mutex<BuiltinData>,
    default_shell: String,
    events: BuiltinEventHub,
    jcode_detection_variant: JcodeDetectionVariant,
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
    fn new(
        _cwd: PathBuf,
        shell: Option<String>,
        jcode_detection_variant: JcodeDetectionVariant,
    ) -> io::Result<Self> {
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
            jcode_detection_variant,
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
            // `tab.promote` returns the full result (workspace + tab + pane)
            // so clients can navigate from the HTTP response itself; the
            // events are for other connected browsers. workspace_created
            // marks whether a new workspace was created (refresh) or the tab
            // just moved into an existing one (cheaper tab.renamed refresh).
            "tab.promote" => {
                if result.get("workspace_created") == Some(&Value::Bool(true)) {
                    self.publish_event("workspace.created", result.clone())
                } else {
                    self.publish_event("tab.renamed", result.clone())
                }
            }
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
                // Absent open_terminal keeps the legacy one-tab mint, so
                // non-web clients (Rust API client, TUI) see no change.
                let open_terminal = optional_bool(&params, "open_terminal").unwrap_or(true);
                let workspace = self.create_workspace(cwd, label, false, open_terminal)?;
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
                let focus = optional_bool(&params, "focus").unwrap_or(true);
                let (tab, root_pane) = self.create_tab(workspace_id, label, focus)?;
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
            "tab.promote" => {
                let tab_id = required_string(&params, "tab_id")?;
                let result = self.promote_tab(&tab_id)?;
                Ok(result)
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
            "pane.conversation" => {
                let pane_id = required_string(&params, "pane_id")?;
                // Page cursors (reference before/from parity): optional
                // strings; the chat lens passes them once it holds pages.
                let page = chat_lens::ConversationPage {
                    before: optional_string(&params, "before"),
                    from: optional_string(&params, "from"),
                };
                let result = self.pane_conversation(&pane_id, &page)?;
                Ok(json!({ "type": "pane_conversation", "conversation": result }))
            }
            "pane.conversation_image" => {
                // One image the conversation's image part named, by ref
                // (reference conversationImage parity): same resolution
                // pipeline as pane.conversation so the ref can only name
                // the session the page came from. {media_type, data} on
                // the wire, base64 as the reference carries it; null
                // output -> image_not_found at the route.
                let pane_id = required_string(&params, "pane_id")?;
                let reference = required_string(&params, "ref")?;
                let image = self.pane_conversation_image(&pane_id, &reference)?;
                Ok(json!({
                    "type": "pane_conversation_image",
                    "image": image.map(|(media_type, bytes)| json!({
                        "media_type": media_type,
                        "data": crate::jcode_transcript::base64_encode(&bytes),
                    })),
                }))
            }
            "pane.tool_output" => {
                // One whole tool output by call id (reference toolOutput
                // parity): the page carried a trimmed head + output_ref,
                // this returns the rest. Same resolution pipeline and
                // error codes as pane.conversation.
                let pane_id = required_string(&params, "pane_id")?;
                let reference = required_string(&params, "ref")?;
                let output = self.pane_tool_output(&pane_id, &reference)?;
                Ok(json!({ "type": "pane_tool_output", "output": output }))
            }
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
            "worktree.remove" => self.worktree_remove(params),
            // The TUI git/file panels run over the socket instead of the
            // HTTP API: the dispatch lives with the handlers themselves so
            // validation stays single-sourced between both transports.
            "git.status"
            | "git.diff"
            | "git.compare"
            | "git.branches"
            | "git.branch.delete"
            | "git.switch"
            | "git.log"
            | "git.path_info"
            | "git.permalink"
            | "git.blame"
            | "git.file"
            | "git.file_write"
            | "git.file_history"
            | "git.stashes"
            | "git.stash_show"
            | "git.conflicts"
            | "git.stage"
            | "git.unstage"
            | "git.discard"
            | "git.stash"
            | "git.stash_apply"
            | "git.stash_drop"
            | "git.reset"
            | "git.rebase"
            | "git.fetch"
            | "git.pull"
            | "git.push"
            | "git.commit"
            | "git.tag"
            | "git.apply_patch"
            | "git.conflict_resolve"
            | "git.conflict_action"
            | "git.cleanup_scan"
            | "git.worktree_remove"
            | "git.worktree_prune" => crate::git_ui::socket_dispatch(method, params),
            "file.tree"
            | "file.read"
            | "file.write"
            | "file.content_search"
            | "file.content_search_file"
            | "file.rename"
            | "file.delete" => crate::file_browser::socket_dispatch(method, params),
            "pane.read" => {
                let pane_id = required_string(&params, "pane_id")?;
                let text = self.read_pane_recent(&pane_id)?;
                Ok(
                    json!({ "type": "pane_read", "read": { "pane_id": pane_id, "text": text, "format": "text" } }),
                )
            }
            "agent.prompt" => {
                // herdr's own agent.prompt takes `target` (agent name or
                // pane_id); our built-in accepts pane_id, with `target` as
                // the external-herdr-compatible alias so the same request
                // body works against both backends.
                let pane_id = params
                    .get("pane_id")
                    .and_then(Value::as_str)
                    .or_else(|| params.get("target").and_then(Value::as_str))
                    .map(str::to_string)
                    .ok_or_else(|| "missing param pane_id".to_string())?;
                let text = params
                    .get("text")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .ok_or_else(|| "text is required".to_string())?;
                // herdr refuses an empty prompt with `empty_agent_prompt`;
                // trim check here because required_string-style filtering
                // would report a generic "required" instead.
                if text.trim().is_empty() {
                    return Err("empty_agent_prompt: agent prompt must not be empty".to_string());
                }
                let terminal = {
                    let data = self
                        .data
                        .lock()
                        .map_err(|_| "state unavailable".to_string())?;
                    let pane = data
                        .panes
                        .get(&pane_id)
                        .ok_or_else(|| format!("agent_not_found: pane {pane_id} not found"))?;
                    data.terminals.get(&pane.terminal_id).cloned()
                }
                .ok_or_else(|| "agent_not_found: terminal not found".to_string())?;
                if text.chars().count() > MAX_COMPOSER_CHARS {
                    return Err(
                        "message_too_long: composer message exceeds 20000 characters".to_string(),
                    );
                }
                terminal.agent_prompt(&text)?;
                Ok(json!({ "type": "agent_prompt", "pane_id": pane_id, "ok": true }))
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
        open_terminal: bool,
    ) -> Result<Value, String> {
        let cwd =
            cwd.unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
        let (workspace_id, tab_id, pane_id, terminal_id, has_focus_target) = {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            let workspace_id = next_id(&mut data, "ws");
            let tab_id = next_id(&mut data, "tab");
            let pane_id = next_id(&mut data, "pane");
            let terminal_id = next_id(&mut data, "term");
            // Focus resolution reads the pre-spawn state; the insert pass
            // below applies the same rule against the same snapshot values.
            let has_focus_target = focus || data.focused_workspace_id.is_none();
            (workspace_id, tab_id, pane_id, terminal_id, has_focus_target)
        };
        let label = label.unwrap_or_else(|| workspace_label(&cwd));
        if open_terminal {
            // Spawn outside the lock: openpty can retry with sleeps and
            // process spawn can stall on slow disks; every other request
            // would wait on `data` for the whole duration.
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
                self.jcode_detection_variant,
            )
            .map_err(|err| err.to_string())?;
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            data.workspaces.insert(
                workspace_id.clone(),
                WorkspaceRecord {
                    workspace_id: workspace_id.clone(),
                    label,
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
            if has_focus_target {
                data.focused_workspace_id = Some(workspace_id.clone());
                data.focused_tab_id = Some(tab_id);
                data.focused_pane_id = Some(pane_id);
            }
        } else {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            // Zero-tab workspace: open_terminal=false skips the Shell tab
            // and root pane entirely. Focus lands on the workspace itself;
            // normalize_focus resolves tab/pane to None until a terminal is
            // spawned into it (POST /api/tabs reuses create_tab).
            data.workspaces.insert(
                workspace_id.clone(),
                WorkspaceRecord {
                    workspace_id: workspace_id.clone(),
                    label,
                    cwd,
                    tab_ids: Vec::new(),
                },
            );
            if focus || data.focused_workspace_id.is_none() {
                data.focused_workspace_id = Some(workspace_id.clone());
                data.focused_tab_id = None;
                data.focused_pane_id = None;
            }
        }
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
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
        focus: bool,
    ) -> Result<(Value, Value), String> {
        let (workspace_id, cwd) = {
            let data = self
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
            (workspace_id, cwd)
        };
        let (tab_id, pane_id, terminal_id) = {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            (
                next_id(&mut data, "tab"),
                next_id(&mut data, "pane"),
                next_id(&mut data, "term"),
            )
        };
        // Spawn outside the lock, same reason as create_workspace.
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
            self.jcode_detection_variant,
        )
        .map_err(|err| err.to_string())?;
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        // The workspace can be closed while the spawn ran; fail instead of
        // resurrecting a workspace row the close already removed.
        if !data.workspaces.contains_key(&workspace_id) {
            return Err(format!("workspace {workspace_id} not found"));
        }
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
        if focus
            || data.focused_workspace_id.is_none()
            || data.focused_tab_id.is_none()
            || data.focused_pane_id.is_none()
        {
            data.focused_workspace_id = Some(workspace_id);
            data.focused_tab_id = Some(tab_id.clone());
            data.focused_pane_id = Some(pane_id.clone());
        }
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
        let (workspace_id, tab_id, pane_id, terminal_id) = {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            (
                next_id(&mut data, "ws"),
                next_id(&mut data, "tab"),
                next_id(&mut data, "pane"),
                next_id(&mut data, "term"),
            )
        };
        // Spawn outside the lock, same reason as create_workspace.
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
            self.jcode_detection_variant,
        )
        .map_err(|err| err.to_string())?;
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
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

    /// Chat-lens transcript for one pane (design section 4). Thin: the
    /// wire carries turns, cursor, model, status, version. Errors use
    /// the route's design codes: `agent_not_found` (pane gone),
    /// `unsupported_agent` (no transcript support), `no_session_path` /
    /// `ambiguous` (resolution refused), `transcript_missing` (files
    /// unreadable or unparseable).
    fn pane_conversation(
        &self,
        pane_id: &str,
        page: &chat_lens::ConversationPage,
    ) -> Result<Value, String> {
        let (pane, presentation) = self.pane_and_presentation(pane_id)?;
        let Some(agent) = presentation.agent else {
            return Err("unsupported_agent: no agent running in this pane".to_string());
        };
        if !chat_lens::agent_supported(Some(agent)) {
            return Err(format!(
                "unsupported_agent: {agent} has no transcript support"
            ));
        }
        chat_lens::conversation_payload_with(
            chat_lens::store_index(),
            &self.pane_context(&pane),
            page,
        )
    }

    /// One image by ref (reference conversationImage parity): same
    /// resolution pipeline and error codes as pane_conversation, so a
    /// ref can only name the session the page came from. Ok(None) ->
    /// image_not_found (rotated out, a ref that never existed).
    fn pane_conversation_image(
        &self,
        pane_id: &str,
        reference: &str,
    ) -> Result<Option<(String, Vec<u8>)>, String> {
        if !crate::jcode_transcript::valid_tool_ref(reference) {
            return Ok(None);
        }
        let (pane, presentation) = self.pane_and_presentation(pane_id)?;
        let Some(agent) = presentation.agent else {
            return Err("unsupported_agent: no agent running in this pane".to_string());
        };
        if !chat_lens::agent_supported(Some(agent)) {
            return Err(format!(
                "unsupported_agent: {agent} has no transcript support"
            ));
        }
        chat_lens::conversation_image_with(
            chat_lens::store_index(),
            &self.pane_context(&pane),
            reference,
        )
    }

    /// One whole tool output by call id: reference toolOutput parity.
    /// Same resolution pipeline and error codes as pane_conversation,
    /// so a page that could show a trimmed head can always fetch the
    /// rest of THAT session's output. None -> tool_output_not_found
    /// (rotated out, cleared, or a ref that never existed).
    fn pane_tool_output(&self, pane_id: &str, reference: &str) -> Result<Option<String>, String> {
        if !crate::jcode_transcript::valid_tool_ref(reference) {
            return Ok(None);
        }
        let (pane, presentation) = self.pane_and_presentation(pane_id)?;
        let Some(agent) = presentation.agent else {
            return Err("unsupported_agent: no agent running in this pane".to_string());
        };
        if !chat_lens::agent_supported(Some(agent)) {
            return Err(format!(
                "unsupported_agent: {agent} has no transcript support"
            ));
        }
        chat_lens::tool_output(&self.pane_context(&pane), reference)
    }

    /// Thin adapter: the pane and its agent presentation, behind the
    /// data lock. Shared head of pane_conversation and
    /// pane_tool_output (agent_not_found classification).
    fn pane_and_presentation(
        &self,
        pane_id: &str,
    ) -> Result<(PaneRecord, PaneAgentPresentation), String> {
        let data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        let pane = data
            .panes
            .get(pane_id)
            .ok_or_else(|| "agent_not_found: no such pane".to_string())?
            .clone();
        let presentation = pane_agent_presentation(&pane, &data);
        Ok((pane, presentation))
    }

    /// Thin adapter: gathers the plain-data context the chat module
    /// needs (live cwd, process map, pane tail) from terminal state.
    /// Chat logic never touches BuiltinState directly.
    fn pane_context(&self, pane: &PaneRecord) -> chat_lens::PaneContext {
        let live_cwd = self
            .terminal(&pane.terminal_id)
            .and_then(|terminal| live_process_cwd(terminal.child_pid()))
            .unwrap_or_else(|| pane.cwd.clone());
        let processes: Vec<chat_lens::ProcessRow> = process_table()
            .unwrap_or_default()
            .iter()
            .map(|p| chat_lens::ProcessRow::new(p.pid, p.ppid))
            .collect();
        let terminal_pid = self
            .terminal(&pane.terminal_id)
            .and_then(|terminal| terminal.child_pid());
        let pane_tail = self
            .terminal(&pane.terminal_id)
            .map(|terminal| {
                // Simple ANSI strip, NOT the VT screen emulation of
                // history_tail_text: the tiebreak needs verbatim prompt
                // echo, and VT emulation lets spinner redraws/CR overwrite
                // it (found live: twin panes flipped ambiguous while a
                // tool ran). Same strip mode as pane.read on the wire.
                // Bounded tail (RESOLVE_TAIL_BYTES): the tiebreak matches
                // a <=400-char chunk of the candidate's last text
                // (jcode_transcript.rs last_substantial_text_chunk), so
                // the full 8MB strip was pure per-poll cost. The bound
                // only narrows the step-3 window: steps 1/1b/2 never
                // read pane_tail, and a candidate chunk older than 64KB
                // of scrollback only fails to match when the pane really
                // scrolled that far past it (the same candidate then
                // loses to ambiguity either way).
                terminal_text::strip_ansi_lossy(
                    &String::from_utf8_lossy(&terminal.history_tail_bytes(RESOLVE_TAIL_BYTES)),
                    terminal_text::StripCarriageReturn::Drop,
                )
            })
            .unwrap_or_default();
        chat_lens::PaneContext {
            live_cwd,
            terminal_pid,
            processes,
            pane_tail,
        }
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
        // Explicit close on a missing tab is an error, not a silent no-op:
        // the old remove-and-ignore returned ok while the tab stayed gone
        // or was never there, which hid id-mismatch bugs (a scoped id the
        // server never knew) behind a 200. Teardown paths that may race a
        // close use close_tab_locked directly and stay best-effort.
        if !data.tabs.contains_key(tab_id) {
            return Err(format!("tab {tab_id} not found"));
        }
        close_tab_locked(&mut data, tab_id);
        // Closing the last tab keeps the workspace alive: terminals are
        // decoupled from workspace lifecycle, and a zero-tab workspace
        // stays open for file explorer, git, and agents until an explicit
        // workspace close removes it.
        normalize_focus(&mut data);
        Ok(())
    }

    /// Promotes a temporary terminal tab into a real workspace rooted at the
    /// terminal's CURRENT live path (the directory the shell `cd`-ed into),
    /// without stopping the process or closing the tab.
    ///
    /// Registry-only re-parent: the TabRecord/PaneRecord workspace_id fields
    /// are rewritten, the tab_id moves between the workspace tab_ids lists,
    /// and the emptied temporary workspace is dropped. `data.terminals` is
    /// never touched, so the PTY child keeps running and the attached
    /// browser keeps its live connection.
    fn promote_tab(&self, tab_id: &str) -> Result<Value, String> {
        // Snapshot the tab/pane/terminal ids and the spawn cwd without
        // holding the lock during the filesystem probes.
        let (pane_id, terminal_id, pane_cwd) = {
            let data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            let tab = data
                .tabs
                .get(tab_id)
                .ok_or_else(|| format!("tab {tab_id} not found"))?;
            let pane_id = tab
                .pane_ids
                .first()
                .cloned()
                .ok_or_else(|| format!("tab {tab_id} has no panes"))?;
            let pane = data
                .panes
                .get(&pane_id)
                .ok_or_else(|| format!("pane {pane_id} not found"))?;
            (pane_id, pane.terminal_id.clone(), pane.cwd.clone())
        };

        // Resolve the terminal's live cwd. A missing probe falls back to the
        // pane's registered cwd (same semantics as worktree_open's
        // canonicalize fallback).
        let live_cwd = self
            .terminal(&terminal_id)
            .and_then(|terminal| live_process_cwd(terminal.child_pid()))
            .unwrap_or(pane_cwd.clone());
        let canonical_live = std::fs::canonicalize(&live_cwd).unwrap_or(live_cwd.clone());

        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        // Re-validate under the lock: the tab may have been closed while we
        // probed the filesystem.
        let tab = data
            .tabs
            .get_mut(tab_id)
            .ok_or_else(|| format!("tab {tab_id} not found"))?
            .clone();
        let old_workspace_id = tab.workspace_id.clone();

        // Guard: promoting into the workspace the tab already lives in is a
        // no-op error; the caller keeps the tab exactly as it was.
        let current_workspace_cwd = data
            .workspaces
            .get(&tab.workspace_id)
            .map(|workspace| {
                std::fs::canonicalize(&workspace.cwd).unwrap_or_else(|_| workspace.cwd.clone())
            })
            .unwrap_or_else(|| PathBuf::from(""));
        if current_workspace_cwd == canonical_live {
            return Err(format!(
                "tab {tab_id} already runs in workspace {} (cwd {})",
                tab.workspace_id,
                canonical_live.display()
            ));
        }

        // Find-or-create the workspace at the canonical live path, reusing
        // worktree_open semantics: canonicalize both sides so a temp cwd and
        // a user-typed path to the same folder meet.
        let existing_workspace_id = data
            .workspaces
            .values()
            .find(|workspace| {
                std::fs::canonicalize(&workspace.cwd).unwrap_or_else(|_| workspace.cwd.clone())
                    == canonical_live
            })
            .map(|workspace| workspace.workspace_id.clone());
        let (workspace_id, created_workspace) = match existing_workspace_id {
            Some(existing) => (existing, false),
            None => {
                let workspace_id = next_id(&mut data, "ws");
                data.workspaces.insert(
                    workspace_id.clone(),
                    WorkspaceRecord {
                        workspace_id: workspace_id.clone(),
                        label: workspace_label(&canonical_live),
                        cwd: canonical_live.clone(),
                        tab_ids: Vec::new(),
                    },
                );
                (workspace_id, true)
            }
        };

        // Registry-only re-parent. The order matters for the guard above:
        // rewrite the records before moving the tab_id so a panic mid-way can
        // never leave the tab in both lists (the ids stay unique because
        // every edit is under the same lock).
        {
            let tab_record = data
                .tabs
                .get_mut(tab_id)
                .expect("tab re-validated above under the same lock");
            tab_record.workspace_id = workspace_id.clone();
            if tab_record.label == "temp" {
                tab_record.label = "Shell".to_string();
            }
        }
        for pane_id in &tab.pane_ids {
            if let Some(pane) = data.panes.get_mut(pane_id) {
                pane.workspace_id = workspace_id.clone();
                pane.cwd = canonical_live.clone();
            }
        }
        if let Some(old_workspace) = data.workspaces.get_mut(&old_workspace_id) {
            old_workspace.tab_ids.retain(|id| id != tab_id);
        }
        if let Some(workspace) = data.workspaces.get_mut(&workspace_id) {
            workspace.tab_ids.push(tab_id.to_string());
        }

        // Drop the emptied temporary workspace. No terminals are left behind
        // (the promoted tab took the only panes with it), so this is purely
        // a registry removal; close_workspace's kill loop must NOT run.
        let mut dropped_temp_workspace = None;
        if let Some(old_workspace) = data.workspaces.get(&old_workspace_id) {
            if old_workspace.tab_ids.is_empty() {
                data.workspaces.remove(&old_workspace_id);
                dropped_temp_workspace = Some(old_workspace_id.clone());
            }
        }

        // Focus the promoted surface.
        data.focused_workspace_id = Some(workspace_id.clone());
        data.focused_tab_id = Some(tab_id.to_string());
        data.focused_pane_id = tab.pane_ids.first().cloned();

        normalize_focus(&mut data);

        let workspace = data
            .workspaces
            .get(&workspace_id)
            .map(|workspace| workspace_json(workspace, &data))
            .unwrap_or_else(|| json!({}));
        let tab_json_value = data
            .tabs
            .get(tab_id)
            .map(|tab| tab_json(tab, &data))
            .unwrap_or_else(|| json!({}));
        let pane_json_value = data
            .panes
            .get(&pane_id)
            .map(|pane| pane_json(pane, &data))
            .unwrap_or_else(|| json!({}));
        drop(data);

        // Events for OTHER connected browsers. The promoting client navigates
        // from the HTTP response (publish_success_event relays the full
        // result as workspace.created when a new workspace was made, or as
        // tab.renamed when the tab only moved into an existing one).
        if let Some(dropped) = dropped_temp_workspace {
            self.publish_event("workspace.closed", json!({ "workspace_id": dropped }));
        }

        Ok(json!({
            "type": "tab_promoted",
            "workspace_created": created_workspace,
            "workspace": workspace,
            "tab": tab_json_value,
            "root_pane": pane_json_value,
        }))
    }

    fn close_pane(&self, pane_id: &str) -> Result<(), String> {
        let mut data = self
            .data
            .lock()
            .map_err(|_| "state unavailable".to_string())?;
        // Same contract as close_tab: closing an unknown pane is an error,
        // not a silent no-op. The pane→tab cascade below runs only after
        // the pane is known to exist.
        if !data.panes.contains_key(pane_id) {
            return Err(format!("pane {pane_id} not found"));
        }
        // Get the tab_id before closing the pane
        let tab_id = data.panes.get(pane_id).map(|p| p.tab_id.clone());

        close_pane_locked(&mut data, pane_id);

        // Closing the last pane of a tab closes the tab (pane→tab cascade
        // keeps pane sets coherent), but the workspace stays alive: zero-tab
        // workspaces persist until an explicit workspace close.
        if let Some(tid) = tab_id {
            let should_close_tab = data
                .tabs
                .get(&tid)
                .map(|tab| tab.pane_ids.is_empty())
                .unwrap_or(true);
            if should_close_tab {
                close_tab_locked(&mut data, &tid);
                normalize_focus(&mut data);
                // Emit tab.closed event for the auto-closed tab
                self.publish_event("tab.closed", json!({ "tab_id": tid }));
            }
        }

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
        // Match external herdr's pane.read default (strip_ansi: true) so
        // inline-image payloads (Kitty APC, Sixel DCS, iTerm2 OSC 1337)
        // never leak as base64 garbage into API consumers. Drop mode keeps
        // CRLF line ends single, like herdr's grid-row join.
        Ok(terminal_text::strip_ansi_lossy(
            &String::from_utf8_lossy(&terminal.history_bytes()),
            terminal_text::StripCarriageReturn::Drop,
        ))
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
        let list = git_output(Path::new(&repo_root), &["worktree", "list", "--porcelain"])
            .unwrap_or_default();
        let mut worktrees = parse_git_worktrees(&list);
        // `rev-parse --show-toplevel` reports the queried checkout's own
        // toplevel, so inside a linked worktree it names the lane, not the
        // repository. `worktree list --porcelain` always leads with the
        // main checkout, so the first row is the true repository root and
        // name; callers derive main-vs-linked from it (the row flag is
        // unreliable: the parser marks every row linked). An empty list
        // (plain folder, broken git) keeps the toplevel/cwd identity.
        let repo_root = worktrees
            .first()
            .and_then(|row| row.get("path"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or(repo_root);
        let repo_name = Path::new(&repo_root)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("repo")
            .to_string();
        enrich_worktree_commit_dates(&mut worktrees);
        worktrees.sort_by_key(|row| std::cmp::Reverse(worktree_activity_key(row)));
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
        let canonical_path =
            std::fs::canonicalize(Path::new(&path)).unwrap_or_else(|_| PathBuf::from(&path));
        // Herdr parity: opening a checkout that is already open as a
        // workspace focuses that workspace instead of creating a duplicate.
        let existing_workspace = {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            let existing = data
                .workspaces
                .values()
                .find(|workspace| {
                    std::fs::canonicalize(&workspace.cwd).unwrap_or_else(|_| workspace.cwd.clone())
                        == canonical_path
                })
                .map(|workspace| workspace.workspace_id.clone());
            match existing {
                Some(workspace_id) => {
                    // Herdr parity: a supplied label renames the existing
                    // workspace even when it is already open.
                    if let Some(label) = &label {
                        if let Some(workspace) = data.workspaces.get_mut(&workspace_id) {
                            workspace.label = label.clone();
                        }
                    }
                    let workspace = data
                        .workspaces
                        .get(&workspace_id)
                        .map(|workspace| workspace_json(workspace, &data))
                        .unwrap_or_else(|| json!({}));
                    data.focused_workspace_id = Some(workspace_id.clone());
                    data.focused_tab_id = data
                        .workspaces
                        .get(&workspace_id)
                        .and_then(|workspace| workspace.tab_ids.first().cloned());
                    data.focused_pane_id = data
                        .focused_tab_id
                        .as_ref()
                        .and_then(|tab_id| data.tabs.get(tab_id))
                        .and_then(|tab| tab.pane_ids.first().cloned());
                    Some(workspace)
                }
                None => None,
            }
        };
        let (workspace, already_open) = match existing_workspace {
            Some(workspace) => (workspace, true),
            None => (
                self.create_workspace(
                    Some(PathBuf::from(&path)),
                    label,
                    true,
                    optional_bool(&params, "open_terminal").unwrap_or(true),
                )?,
                false,
            ),
        };
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
            "already_open": already_open,
        }))
    }

    /// Remove a git worktree from its repo. Mirrors the WebUI
    /// /api/worktrees/remove-path semantics: `repo_root` scopes the git
    /// invocation, `path` is the worktree directory to remove, `force`
    /// maps to `git worktree remove --force`. Emits `worktree.removed`.
    /// A `workspace_id` in params resolves the path from the open
    /// workspace's cwd and scopes the git invocation to that cwd (git
    /// resolves the main repo from any checkout, including the worktree
    /// itself), which is what the workspace-scoped WebUI route sends.
    fn worktree_remove(&self, params: Value) -> Result<Value, String> {
        let workspace_id = optional_string(&params, "workspace_id");
        let mut params = params;
        if optional_string(&params, "path").is_none() {
            if let Some(workspace_id) = workspace_id.as_deref() {
                let data = self
                    .data
                    .lock()
                    .map_err(|_| "state unavailable".to_string())?;
                let workspace = data
                    .workspaces
                    .get(workspace_id)
                    .ok_or_else(|| format!("workspace not found: {workspace_id}"))?;
                let cwd = workspace.cwd.to_string_lossy().to_string();
                if let Some(object) = params.as_object_mut() {
                    object.insert("path".to_string(), json!(cwd));
                    object.insert("repo_root".to_string(), json!(cwd));
                }
            }
        }
        let repo_root = optional_string(&params, "repo_root")
            .or_else(|| optional_string(&params, "cwd"))
            .map(PathBuf::from)
            .or_else(|| std::env::current_dir().ok())
            .ok_or_else(|| "repo_root is required".to_string())?;
        let path = required_string(&params, "path")?;
        let force = optional_bool(&params, "force").unwrap_or(false);
        let repo = Path::new(&repo_root);
        if !repo.is_dir() {
            return Err(format!("repo_root is not a directory: {}", repo.display()));
        }
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&path);
        // Canonicalize while the directory still exists: after run_git
        // removes it, canonicalize fails on both sides and each falls
        // back to its raw spelling, so a workspace opened through a
        // symlinked prefix (/tmp vs /private/tmp on macOS) removed via
        // the other spelling would linger with a dead cwd. A relative
        // `path` resolves against repo_root (same base git uses), not
        // the server process cwd. Snapshot the match set now, tear
        // down after git succeeds.
        let mut removed_path = PathBuf::from(&path);
        if removed_path.is_relative() {
            removed_path = repo.join(&removed_path);
        }
        let canonical_removed = removed_path
            .canonicalize()
            .unwrap_or_else(|_| removed_path.clone());
        let matching_workspaces: Vec<String> = {
            let data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            data.workspaces
                .iter()
                .filter(|(_, workspace)| {
                    workspace
                        .cwd
                        .canonicalize()
                        .unwrap_or_else(|_| workspace.cwd.clone())
                        == canonical_removed
                })
                .map(|(id, _)| id.clone())
                .collect()
        };
        run_git(repo, &args)?;

        // The worktree directory is gone: every open workspace rooted
        // there would keep a dead cwd, dead PTYs, and a snapshot entry no
        // filesystem backs. Close those workspaces with the same teardown
        // as workspace.close (tabs, panes, PTYs) so polls and snapshots
        // stop listing the removed worktree.
        let dropped_workspaces: Vec<String> = {
            let mut data = self
                .data
                .lock()
                .map_err(|_| "state unavailable".to_string())?;
            let dropped = matching_workspaces
                .into_iter()
                .filter_map(|ws_id| {
                    let workspace = data.workspaces.remove(&ws_id)?;
                    for tab_id in workspace.tab_ids {
                        close_tab_locked(&mut data, &tab_id);
                    }
                    Some(ws_id)
                })
                .collect();
            normalize_focus(&mut data);
            dropped
        };
        for ws_id in &dropped_workspaces {
            self.publish_event("workspace.closed", json!({ "workspace_id": ws_id }));
        }
        let result = json!({
            "type": "worktree_removed",
            "path": path,
            "repo_root": repo.to_string_lossy(),
            // The id disambiguates the payload when two open workspaces
            // share one folder path (path-only matching would drop both
            // client-side or the wrong one).
            "workspace_ids": dropped_workspaces,
        });
        self.publish_event("worktree.removed", result.clone());
        Ok(result)
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
    last_agent_state: Mutex<Option<(Option<String>, String, u64)>>,
    /// Monotonic detection sequence: grabbed at the start of every
    /// detect_and_publish_agent_status run and committed with the result.
    /// The sweeper force pass and the agent_prompt synchronous re-check can
    /// run concurrently with the output path; without a sequence number a
    /// later-started pass with an older tail snapshot could commit after a
    /// newer one and briefly regress the published status. Stale commits
    /// are dropped inside the compare-and-set.
    detection_seq: AtomicU64,
    last_status_check: Mutex<Option<Instant>>,
    /// Set when output arrived while the status check was throttled. A
    /// trailing-edge sweeper (spawned once per runtime) runs the pending
    /// check when the throttle window expires, so a status flip carried by
    /// the LAST bytes of an output burst is never missed (e.g. a question
    /// dialog printed right after heavy output, then the pane goes silent
    /// while `read` blocks — no further output would ever trigger a check).
    pending_status_check: AtomicBool,
    /// Set once when a previously-live agent process disappears from the
    /// process tree while the pane shell keeps running. Suppresses the
    /// exited agent's label until a live agent is detected again.
    recent_agent_process_exit: Mutex<Option<RecentAgentProcessExit>>,
    /// Last agent label seen live in this pane's process tree. Arms the
    /// exit record: only a successful process-table read that comes back
    /// empty after this was set records an exit.
    last_live_process_agent: Mutex<Option<&'static str>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Option<Box<dyn Child + Send + Sync>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    scrollback: Mutex<VecDeque<u8>>,
    subscribers: Mutex<Vec<TerminalSubscriber>>,
    osc9_tracker: Mutex<Osc9Tracker>,
    exited: AtomicBool,
    jcode_detection_variant: JcodeDetectionVariant,
}

#[derive(Clone)]
enum TerminalSubscriberMessage {
    // Arc so append_output allocates the chunk once and every subscriber
    // shares it; cloning the message is a refcount bump, not a Vec copy.
    // (Before: each subscriber got its own to_vec() copy per chunk, which
    // multiplied PTY output volume by the subscriber count.)
    Output(Arc<Vec<u8>>),
    // Attach replay frame. Queued as the first message on the writer
    // channel so the history write and live output writes are serialized
    // by the same thread instead of racing on a dup'ed socket. Carries its
    // own charged length: the re-attach path queues additional replays
    // through the same channel, and the writer must subtract exactly what
    // this send added, not the length captured at the first attach.
    Replay(Box<ServerMessage>, usize),
    Exited,
    // Terminal output backlog exceeded MAX_SUBSCRIBER_PENDING_BYTES: the
    // writer thread sends a shutdown frame instead of leaving the client
    // blocked on read_message forever.
    Overflow,
}

/// One attached terminal client. Unbounded queue: a slow client never
/// silently loses output while it catches up. `pending_bytes` bounds memory
/// for clients that stopped reading; on overflow the subscriber is shed
/// with an explicit Overflow notice, never a silent drop.
struct TerminalSubscriber {
    tx: mpsc::Sender<TerminalSubscriberMessage>,
    pending_bytes: Arc<AtomicUsize>,
}

/// Open a pty, retrying transient failures. Under parallel test load (and
/// busy CI runners) `openpty` can fail with ENXIO ("Device not configured")
/// when the kernel briefly runs out of available ptys; a short backoff retry
/// makes pane creation robust there. Permanent errors surface after the
/// retries are exhausted. The attempt closure is injected so tests can drive
/// the failure path hermetically.
fn openpty_with_retry<T, E>(
    rows: u16,
    cols: u16,
    attempt_open: &dyn Fn(u16, u16) -> Result<T, E>,
) -> io::Result<T>
where
    E: std::fmt::Display,
{
    let mut last_err = String::new();
    for attempt in 0..3 {
        match attempt_open(rows, cols) {
            Ok(pair) => return Ok(pair),
            Err(err) => {
                last_err = err.to_string();
                if attempt < 2 {
                    std::thread::sleep(Duration::from_millis(100 * (attempt + 1)));
                }
            }
        }
    }
    Err(io::Error::other(last_err))
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
        jcode_detection_variant: JcodeDetectionVariant,
    ) -> io::Result<Arc<Self>> {
        let pty_system = native_pty_system();
        // Under parallel test load (and busy CI runners) openpty can fail
        // transiently with ENXIO ("Device not configured") when the kernel
        // briefly runs out of available ptys. A short retry makes pane
        // creation robust there; permanent errors still surface after the
        // retries are exhausted.
        let pair = openpty_with_retry(rows, cols, &|rows, cols| {
            pty_system.openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
        })?;
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
        for key in TERMINAL_ENV_SCRUB_KEYS {
            command.env_remove(key);
        }
        command.cwd(cwd);
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
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
            detection_seq: AtomicU64::new(0),
            last_status_check: Mutex::new(None),
            pending_status_check: AtomicBool::new(false),
            recent_agent_process_exit: Mutex::new(None),
            last_live_process_agent: Mutex::new(None),
            master: Mutex::new(pair.master),
            child: Mutex::new(Some(child)),
            writer: Mutex::new(writer),
            scrollback: Mutex::new(VecDeque::new()),
            subscribers: Mutex::new(Vec::new()),
            osc9_tracker: Mutex::new(Osc9Tracker::default()),
            exited: AtomicBool::new(false),
            jcode_detection_variant,
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
        // Trailing-edge status sweeper: append_output only checks the status
        // throttle on output arrival; if the last burst landed inside a
        // throttle window, the pending flag stays set until this loop runs
        // the check once the window expires. Exits when the pane is gone.
        {
            let sweeper_runtime = Arc::clone(&runtime);
            thread::spawn(move || loop {
                thread::sleep(Duration::from_millis(100));
                if sweeper_runtime.exited.load(Ordering::Acquire) {
                    return;
                }
                if !sweeper_runtime
                    .pending_status_check
                    .swap(false, Ordering::AcqRel)
                {
                    continue;
                }
                sweeper_runtime.publish_agent_status_if_changed_force();
            });
        }
        Ok(runtime)
    }

    fn child_pid(&self) -> Option<u32> {
        self.child_pid
    }

    /// Probes the pane's process tree for a live agent and updates the exit
    /// record, mirroring upstream herdr's live→absent transition:
    /// - A live agent clears any exit record (the agent is back) and becomes
    ///   the new `last_live_process_agent`.
    /// - A successful read that finds no agent after a previously-live agent
    ///   records the exit exactly once (the armed flag is cleared so repeat
    ///   empty reads do not re-set it).
    /// - A failed `ps` read is a no-op: we cannot distinguish "agent gone"
    ///   from "probe broken", so we keep the previous record state.
    fn update_agent_exit_record(&self, live_agent: Option<&'static str>, probe_ok: bool) {
        if !probe_ok {
            return;
        }
        if let Some(agent) = live_agent {
            if let Ok(mut last_live) = self.last_live_process_agent.lock() {
                *last_live = Some(agent);
            }
            if let Ok(mut record) = self.recent_agent_process_exit.lock() {
                *record = None;
            }
            return;
        }
        let exited_agent = self
            .last_live_process_agent
            .lock()
            .ok()
            .and_then(|mut last_live| last_live.take());
        let Some(agent) = exited_agent else {
            return;
        };
        if let Ok(mut record) = self.recent_agent_process_exit.lock() {
            *record = Some(RecentAgentProcessExit {
                agent,
                observed_at: Instant::now(),
            });
        }
    }

    /// True while an agent process previously seen live in this pane has
    /// exited and no live agent has been detected since. Suppresses the
    /// exited agent's label in presentation and status publishing.
    fn recent_agent_exit_active(&self) -> bool {
        self.recent_agent_process_exit
            .lock()
            .ok()
            .and_then(|record| *record)
            .is_some_and(|record| record.is_active(Instant::now()))
    }

    /// Live agent in this pane's process tree, or `None` when the table
    /// read fails (the failure is propagated so callers can treat a broken
    /// probe as a no-op rather than an exit).
    fn probe_live_process_agent(&self) -> Option<Option<&'static str>> {
        let pid = self.child_pid()?;
        let processes = process_table().ok()?;
        Some(detect_agent_label_from_processes(pid, &processes))
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

    fn subscribe(&self, subscriber: TerminalSubscriber) {
        if self.exited.load(Ordering::Acquire) {
            let _ = subscriber.tx.send(TerminalSubscriberMessage::Exited);
            return;
        }
        if let Ok(mut subscribers) = self.subscribers.lock() {
            subscribers.push(subscriber);
        }
    }

    fn history_bytes(&self) -> Vec<u8> {
        self.scrollback
            .lock()
            .map(|scrollback| scrollback.iter().copied().collect())
            .unwrap_or_default()
    }

    /// Last `max_bytes` of raw scrollback, byte-exact (no VT emulation),
    /// for consumers that strip ANSI themselves. The resolution tail
    /// uses this instead of history_bytes: the recency tiebreak matches
    /// a <=400-char chunk, so 64KB bounds the copy and strip that used to
    /// walk the full 8MB scrollback on every conversation poll.
    fn history_tail_bytes(&self, max_bytes: usize) -> Vec<u8> {
        self.scrollback
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
        // Feed raw bytes to the OSC 9 tracker so agent status can be detected
        // via structured payloads (e.g. `ESC]9;jcode:working BEL` on the
        // herdr_detectable branch; jcode master never sends one).
        if let Ok(mut tracker) = self.osc9_tracker.lock() {
            tracker.observe(bytes);
        }
        if let Ok(mut subscribers) = self.subscribers.lock() {
            let payload = TerminalSubscriberMessage::Output(Arc::new(bytes.to_vec()));
            // Count the chunk before queueing: the writer decrements only
            // after the kernel accepts the frame, so the counter covers the
            // channel backlog AND any in-flight blocked write. The add must
            // land first or the counter wraps.
            subscribers.retain(|subscriber| {
                subscriber
                    .pending_bytes
                    .fetch_add(bytes.len(), Ordering::AcqRel);
                match subscriber.tx.send(payload.clone()) {
                    Ok(()) => {
                        if subscriber.pending_bytes.load(Ordering::Acquire)
                            > MAX_SUBSCRIBER_PENDING_BYTES
                        {
                            // Shed, but queue an Overflow notice behind the
                            // backlog so the writer can tell the client.
                            let _ = subscriber.tx.send(TerminalSubscriberMessage::Overflow);
                            false
                        } else {
                            true
                        }
                    }
                    Err(_) => {
                        // Disconnected writer never dequeues: undo the add.
                        subscriber
                            .pending_bytes
                            .fetch_sub(bytes.len(), Ordering::AcqRel);
                        false
                    }
                }
            });
        }
        // Invalidate cached agent presentation so next agent.list recomputes
        self.publish_agent_status_if_changed();
    }

    fn notify_exited(&self) {
        if self.exited.swap(true, Ordering::AcqRel) {
            return;
        }
        // Compute the agent label one last time so we can publish a final
        // "done" status. After this the tracker is reset, so we capture the
        // label from argv or screen text before clearing.
        let tail = self.history_tail_text(DETECTION_TAIL_BYTES);
        // If the agent process exited recently while the pane shell kept
        // running (jcode quit inside the shell), the exit record is active and
        // the pane must not keep reporting the agent. Only publish a final
        // "done" for an agent the pane still legitimately reports.
        let agent_suppressed = self.recent_agent_exit_active();
        let agent = if agent_suppressed {
            None
        } else {
            detect_agent_label(&self.argv)
                .or_else(|| detect_agent_label_from_text(&tail))
                .or_else(|| {
                    self.osc9_tracker
                        .lock()
                        .ok()
                        .and_then(|t| t.latest_agent_label())
                })
                .map(str::to_string)
        };
        // Clear OSC 9 state so stale payloads do not persist after the agent
        // process exits. Without this, a captured `jcode:working` would keep
        // the pane stuck in "working" even after the process is gone.
        if let Ok(mut tracker) = self.osc9_tracker.lock() {
            tracker.reset();
        }
        // Publish a final "done" status so the UI does not show a stale
        // working/idle state after the process is gone.
        if let Some(ref agent) = agent {
            self.event_hub.publish(
                "pane.agent_status_changed",
                json!({
                    "workspace_id": self.event_context.workspace_id,
                    "tab_id": self.event_context.tab_id,
                    "pane_id": self.event_context.pane_id,
                    "terminal_id": self.event_context.terminal_id,
                    "agent": agent,
                    "agent_status": "done",
                    "status": "done",
                }),
            );
        }
        // Clear cached agent state so the next agent.list recomputes from
        // scratch (pane_agent_presentation will see exited=true → "done").
        if let Ok(mut previous) = self.last_agent_state.lock() {
            previous.take();
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
            subscribers.retain(|subscriber| {
                matches!(
                    subscriber.tx.send(TerminalSubscriberMessage::Exited),
                    Ok(())
                )
            });
        }
    }

    /// Resets the status-detection throttle so the next output-driven
    /// `publish_agent_status_if_changed` run is guaranteed to execute.
    /// Only used by tests to avoid racing the spawned shell's prompt output,
    /// which can consume the 500ms throttle window before the synthetic
    /// append_output call lands.
    #[cfg(test)]
    fn reset_status_throttle(&self) {
        if let Ok(mut last_check) = self.last_status_check.lock() {
            *last_check = None;
        }
    }

    fn publish_agent_status_if_changed(&self) {
        // Throttle status detection to max once per 500ms per terminal
        // This prevents CPU burn during heavy terminal output
        let should_check = self
            .last_status_check
            .lock()
            .map(|mut last_check| {
                let now = Instant::now();
                let should_run = last_check
                    .map(|last| now.duration_since(last) >= Duration::from_millis(500))
                    .unwrap_or(true);
                if should_run {
                    *last_check = Some(now);
                }
                should_run
            })
            .unwrap_or(false);

        if !should_check {
            // Mark pending so the trailing-edge sweeper re-runs the check
            // once the throttle window expires; without it, a flip carried
            // by the last bytes of a burst is lost when the pane goes
            // silent right after (blocked on input with no more output).
            self.pending_status_check.store(true, Ordering::Release);
            return;
        }
        self.pending_status_check.store(false, Ordering::Release);
        // Run the detection core directly. Routing through
        // run_status_detection would re-check the throttle this method just
        // consumed (last_status_check was refreshed a moment ago, so the
        // second gate always fails), starving detection for as long as
        // output keeps flowing: a turn with continuous spinner frames
        // would never publish "working", and even the boot sequence only
        // ever detected via the sweeper's silent-window luck.
        self.detect_and_publish_agent_status();
    }

    /// Un-throttled detection entry point used by the sweeper thread. The
    /// pending flag is cleared by the caller; the throttle bookkeeping in
    /// `run_status_detection` still applies so the sweeper cannot hammer
    /// detection while output keeps flowing.
    fn publish_agent_status_if_changed_force(&self) {
        self.run_status_detection();
    }

    /// The pane's last published agent status ("working"/"blocked"/"done"/
    /// "idle"), or None when no agent has been detected yet. The sweeper
    /// guarantees this is fresh even when the flip rode the last bytes of an
    /// output burst (see `pending_status_check`).
    fn last_agent_status(&self) -> Option<String> {
        self.last_agent_state
            .lock()
            .ok()
            .and_then(|state| state.as_ref().map(|(_, status, _)| status.clone()))
    }

    /// Server-side composer submit ("agent.prompt" semantics): paste the
    /// message into the pane's PTY as one bracketed paste, then its Enter
    /// after a gap. Runs on the server so the paste→Enter sequence survives
    /// a jittery connection and a locked phone, and so a blocked pane can
    /// refuse before anything is typed (a message typed into an open
    /// permission/question dialog would answer the dialog, never the
    /// composer).
    ///
    /// The Enter gap (300ms) is deliberately outside jcode's 150ms
    /// paste-guard window (`paste_guard.rs`, the #544 Windows Terminal fix):
    /// a trailing Enter inside that window is swallowed as paste residue, so
    /// the submit would silently not happen. Never shorten below ~200ms.
    ///
    /// Takes the runtime Arc because the delayed Enter runs on a detached
    /// thread that must outlive the submitting HTTP request (the phone can
    /// lock or the connection drop between paste and Enter).
    fn agent_prompt(self: &Arc<Self>, text: &str) -> Result<(), String> {
        if self.exited.load(Ordering::Acquire) {
            return Err("agent_exited: terminal has exited".to_string());
        }
        if self.last_agent_status().as_deref() == Some("blocked") {
            return Err(
                "agent_blocked: the agent is waiting for an answer in the terminal".to_string(),
            );
        }
        // The cached status comes from the output-driven detector + the
        // 100ms trailing sweeper, which can lag a fresh permission dialog
        // by up to ~600ms (throttle + sweeper tick) and far longer on a
        // starved machine (observed >10s on a loaded CI runner). A paste
        // that lands inside that window would answer the dialog, so run
        // the detection core once more right here: a submit is a rare
        // user action and the tail parse is milliseconds. This closes the
        // submit-vs-sweeper race instead of merely narrowing it.
        self.detect_and_publish_agent_status();
        if self.last_agent_status().as_deref() == Some("blocked") {
            return Err(
                "agent_blocked: the agent is waiting for an answer in the terminal".to_string(),
            );
        }
        let message = composer_message(text);
        let payload = bracketed_paste_payload(&message);
        self.write_input(payload.as_bytes())
            .map_err(|err| format!("io_error: {err}"))?;
        // The Enter must go even if the submitting client disconnects or
        // locks, so the gap + CR run on a detached thread holding only the
        // runtime Arc.
        let runtime = Arc::clone(self);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(AGENT_PROMPT_ENTER_GAP_MS));
            if runtime.exited.load(Ordering::Acquire) {
                return;
            }
            let _ = runtime.write_input(b"\r");
        });
        Ok(())
    }

    fn run_status_detection(&self) {
        // After the terminal exits, the final "done" status was already
        // published in notify_exited. Skip further detection to avoid CPU
        // waste, stale screen-text false positives, and consuming the
        // throttle window on a dead terminal (the sweeper stops calling
        // once it observes `exited`, but a force call racing the exit must
        // still be a full no-op).
        if self.exited.load(Ordering::Acquire) {
            return;
        }
        let now = Instant::now();
        let should_check = self
            .last_status_check
            .lock()
            .map(|mut last_check| {
                let should_run = last_check
                    .map(|last| now.duration_since(last) >= Duration::from_millis(500))
                    .unwrap_or(true);
                if should_run {
                    *last_check = Some(now);
                }
                should_run
            })
            .unwrap_or(false);
        if !should_check {
            // Window not expired yet (the sweeper woke too early): re-mark
            // pending so the next sweeper tick retries.
            self.pending_status_check.store(true, Ordering::Release);
            return;
        }
        self.detect_and_publish_agent_status();
    }

    /// The detection core shared by the throttled/sweeper paths and the
    /// composer refusal gate: parse the pane tail (+ OSC state) and
    /// publish the resulting (agent, status) pair when it changed.
    /// Throttle-free by design; the callers own rate limiting.
    fn detect_and_publish_agent_status(&self) {
        // Reserve the sequence before reading the tail: two concurrent
        // passes get distinct seqs, and a pass that commits after a newer
        // one (higher committed seq) is stale and must not regress the
        // published state.
        let seq = self.detection_seq.fetch_add(1, Ordering::AcqRel) + 1;
        let tail = self.history_tail_text(DETECTION_TAIL_BYTES);
        let (osc_progress, osc_title, osc_agent) = self
            .osc9_tracker
            .lock()
            .map(|tracker| {
                // The OSC 9 payload is retained until the terminal exits
                // (reset) or the agent process disappears (notify_exited
                // resets the tracker). Agents that use this channel emit on
                // state change only, so there is no timestamped freshness
                // window. Note real jcode master emits no OSC 9 progress:
                // status comes from the title rules plus screen-scrape, and
                // this payload path only serves a hypothetical jcode build
                // with the herdr_detectable side-channel.
                let progress = tracker.latest_progress().to_string();
                (
                    progress,
                    tracker.latest_title().to_string(),
                    tracker.latest_agent_label(),
                )
            })
            .unwrap_or_default();
        let process_agent = self
            .probe_live_process_agent()
            .inspect(|&live_agent| {
                self.update_agent_exit_record(live_agent, true);
            })
            // Probe unavailable (no child pid or `ps` failed): treat as a
            // no-op so a broken probe never fabricates an exit record.
            .unwrap_or(None);
        // While a recent agent-process exit is active, stop reporting the
        // exited agent: stale OSC 9 labels and leftover screen text (spinner
        // frames, banners) would otherwise keep the ghost agent alive.
        let agent_suppressed = self.recent_agent_exit_active();
        let agent = if agent_suppressed {
            None
        } else {
            detect_agent_label(&self.argv)
                .or(process_agent)
                .or(osc_agent)
                .or_else(|| detect_agent_label_from_text(&tail))
                .map(str::to_string)
        };
        let status = detect_agent_status_with_osc(
            agent.as_deref(),
            &tail,
            &osc_progress,
            &osc_title,
            self.jcode_detection_variant,
        )
        .to_string();
        let current = (agent.clone(), status.clone());
        let should_publish = self
            .last_agent_state
            .lock()
            .map(|mut previous| {
                // Stale pass: a newer detection already committed after
                // this one started reading its tail. Committing would
                // regress the published status; drop the result instead.
                if previous
                    .as_ref()
                    .is_some_and(|(_, _, committed_seq)| *committed_seq >= seq)
                {
                    return false;
                }
                let changed = previous
                    .as_ref()
                    .map(|(prev_agent, prev_status, _)| {
                        (prev_agent.clone(), prev_status.clone()) != current
                    })
                    .unwrap_or(true);
                // A Some→None agent transition must emit an event so the
                // frontend drops the exited agent from its list; plain shell
                // panes (previous was already None) must not spam events.
                let previous_agent_was_some = previous
                    .as_ref()
                    .is_some_and(|(previous_agent, _, _)| previous_agent.is_some());
                *previous = Some((current.0, current.1, seq));
                changed && (agent.is_some() || previous_agent_was_some)
            })
            .unwrap_or(false);
        if should_publish {
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

impl TerminalRuntime {
    /// Test-only: kill the pane child and block until it is truly gone.
    /// `Drop` kills without waiting, and jcode's session threads can keep
    /// creating files under `JCODE_HOME` for a while after the kill lands
    /// (observed re-creating `ambient/transcripts` over 1s later under
    /// load), so a cleanup that starts right after `drop(terminal)` races
    /// the dying process. Reaping first makes the scratch-tree removal
    /// deterministic.
    ///
    /// Also blocks until the reader thread observed EOF and ran
    /// notify_exited: the `agent_exited` refusal gate keys on the
    /// `exited` flag, which the reader flips AFTER child.wait() returns,
    /// so a request landing in that gap would paste into a dead PTY and
    /// the refusal assert would flake.
    #[cfg(test)]
    fn kill_and_wait(&self) {
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        while !self.exited.load(Ordering::Acquire) {
            if Instant::now() >= deadline {
                return;
            }
            thread::sleep(Duration::from_millis(5));
        }
    }
}

impl Drop for TerminalRuntime {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            // Reap without blocking the dropping thread: kill delivers
            // SIGKILL, so wait() returns almost immediately, but a Drop on
            // a UI-sensitive thread must never sit in a syscall. An
            // unreaped child would linger as a zombie until server exit.
            // Taking the box out releases the lock before the thread
            // spawn, so the guard never crosses a thread boundary.
            if let Some(child) = child.take() {
                let mut child = child;
                let _ = child.kill();
                std::thread::spawn(move || {
                    let _ = child.wait();
                });
            }
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
        "agent_session": pane_agent_session(pane, data, &presentation),
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
        "agent_session": pane_agent_session(pane, data, &presentation),
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

/// Resolves a pane's `agent_session` (design section 6) by delegating
/// to the chat module: `null` for unsupported agents (Chat lens
/// hidden); `{kind, resolvable, session_id}` for jcode panes when
/// resolution succeeds. The pane tail uses the same verbatim strip as
/// pane_context, so agent_session, conversation and tool output all
/// resolve to the SAME session (the VT-emulation tail let spinner
/// redraws flip twin panes ambiguous — found live).
fn pane_agent_session(
    pane: &PaneRecord,
    data: &BuiltinData,
    presentation: &PaneAgentPresentation,
) -> Value {
    let Some(agent) = presentation.agent else {
        return Value::Null;
    };
    if !chat_lens::agent_supported(Some(agent)) {
        return Value::Null;
    }
    let live_cwd = data
        .terminals
        .get(&pane.terminal_id)
        .and_then(|terminal| live_process_cwd(terminal.child_pid()))
        .unwrap_or_else(|| pane.cwd.clone());
    let processes: Vec<chat_lens::ProcessRow> = process_table()
        .unwrap_or_default()
        .iter()
        .map(|p| chat_lens::ProcessRow::new(p.pid, p.ppid))
        .collect();
    let terminal_pid = data
        .terminals
        .get(&pane.terminal_id)
        .and_then(|terminal| terminal.child_pid());
    let pane_tail = data
        .terminals
        .get(&pane.terminal_id)
        .map(|terminal| {
            // Same strip mode as pane_context (verbatim prompt echo, no
            // VT emulation) and same RESOLVE_TAIL_BYTES bound: agent_json,
            // conversation and tool-output resolution must see the same
            // tail the PaneContext they came from had, or one path could
            // resolve while another refuses on the same pane.
            terminal_text::strip_ansi_lossy(
                &String::from_utf8_lossy(&terminal.history_tail_bytes(RESOLVE_TAIL_BYTES)),
                terminal_text::StripCarriageReturn::Drop,
            )
        })
        .unwrap_or_default();
    chat_lens::agent_session(
        agent,
        &chat_lens::PaneContext {
            live_cwd,
            terminal_pid,
            processes,
            pane_tail,
        },
    )
}

fn pane_agent_presentation(pane: &PaneRecord, data: &BuiltinData) -> PaneAgentPresentation {
    // Cache design (the removed v0.2.84 cache, for contrast, snapshotted
    // pane_agent_presentation results with no invalidation hook and could
    // stick at a stale "no agent" forever): the output-driven detector
    // (detect_and_publish_agent_status, 500ms throttle + trailing-edge
    // sweeper) already recomputes the agent state on every append and stores
    // it in last_agent_state with seq-staleness protection. Serving THAT
    // value here is exactly as fresh as the throttled path guarantees, and
    // skips the 64KB tail copy, the screen scrape and the `ps` fork on every
    // poll. This is not a second cache: it reads the detector's own state,
    // which output invalidates by construction, so the old "stuck None"
    // failure mode cannot recur (any append re-runs the detector). The
    // fallback below runs only when the detector has never produced a
    // result (no output observed yet), and the exited path is excluded on
    // purpose: exit clears last_agent_state (notify_exited) but must still
    // report the agent label + "done" derived from argv and the final tail.
    // An active RecentAgentProcessExit record also bypasses the cache: the
    // record can flip while a stale cached agent is still committed (the
    // agent process disappeared, but the last detector pass saw it live),
    // and serving the cached label would resurrect exactly the ghost the
    // suppression exists to kill.
    let terminal = data.terminals.get(&pane.terminal_id);
    if let Some(terminal) = terminal {
        if !terminal.exited.load(Ordering::Acquire) && !terminal.recent_agent_exit_active() {
            if let Some((agent, status, _)) = terminal
                .last_agent_state
                .lock()
                .ok()
                .and_then(|state| state.clone())
            {
                return PaneAgentPresentation {
                    agent: agent.as_deref().and_then(agent_label_to_static),
                    status: agent_status_to_static(&status),
                };
            }
        }
    }
    // Mirror upstream herdr's RecentAgentProcessExit suppression: when the
    // pane's agent process exited (jcode quit inside the shell) the pane must
    // stop reporting that agent even if stale screen text or OSC payloads
    // still match, so `agent.list` drops the ghost row.
    let agent_exited_recently = terminal
        .map(|terminal| terminal.recent_agent_exit_active())
        .unwrap_or(false);
    // When the terminal has exited, report "done" instead of letting stale
    // screen text (e.g. a leftover spinner frame) keep the status stuck in
    // "working". The OSC 9 tracker was already reset on exit, but screen-scrape
    // patterns in the scrollback can still match, so this guard is needed.
    if let Some(terminal) = terminal {
        if terminal.exited.load(Ordering::Acquire) {
            let agent = if agent_exited_recently {
                None
            } else {
                detect_agent_label(&pane.argv)
                    .or_else(|| {
                        detect_agent_label_from_text(
                            &terminal.history_tail_text(DETECTION_TAIL_BYTES),
                        )
                    })
                    .or_else(|| {
                        terminal
                            .osc9_tracker
                            .lock()
                            .ok()
                            .and_then(|t| t.latest_agent_label())
                    })
            };
            let status = if agent.is_some() { "done" } else { "unknown" };
            return PaneAgentPresentation { agent, status };
        }
    }
    let tail = terminal
        .map(|terminal| terminal.history_tail_text(DETECTION_TAIL_BYTES))
        .unwrap_or_default();
    let process_agent = terminal
        .and_then(|terminal| terminal.probe_live_process_agent())
        .flatten();
    let agent = if agent_exited_recently {
        None
    } else {
        detect_agent_label(&pane.argv)
            .or(process_agent)
            .or_else(|| {
                // Fall back to the OSC 9 side-channel agent label when argv and
                // process-tree detection both miss (e.g. jcode launched through a
                // wrapper that hides the binary name). The OSC payload format is
                // `<agent>:<state>`, so `jcode:working` identifies the agent.
                terminal
                    .and_then(|t| t.osc9_tracker.lock().ok())
                    .and_then(|t| t.latest_agent_label())
            })
            .or_else(|| detect_agent_label_from_text(&tail))
    };
    let (osc_progress, osc_title) = terminal
        .and_then(|terminal| terminal.osc9_tracker.lock().ok())
        .map(|tracker| {
            (
                tracker.latest_progress().to_string(),
                tracker.latest_title().to_string(),
            )
        })
        .unwrap_or_default();
    let status = detect_agent_status_with_osc(
        agent,
        &tail,
        &osc_progress,
        &osc_title,
        terminal
            .map(|t| t.jcode_detection_variant)
            .unwrap_or(JcodeDetectionVariant::Vanilla),
    );
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
            "done" if best == "unknown" || best == "idle" => best = "done",
            "idle" if best == "unknown" => best = "idle",
            _ => {}
        }
    }
    best
}

// last_agent_state stores owned Strings (it is also handed to event JSON),
// but PaneAgentPresentation and the aggregate fns work in &'static str to
// avoid clones on the hot poll path. Both conversions are total over the
// value sets the detector can produce, so they can never fall back on
// unknown input. An unrecognized value (future detector version, corrupt
// state) maps to None/"unknown", which keeps the API contract stable.
fn agent_label_to_static(label: &str) -> Option<&'static str> {
    const LABELS: &[&str] = &[
        "pi",
        "jcode",
        "claude",
        "codex",
        "gemini",
        "cursor",
        "devin",
        "agy",
        "cline",
        "omp",
        "mastracode",
        "opencode",
        "copilot",
        "kimi",
        "kiro",
        "droid",
        "amp",
        "grok",
        "hermes",
        "kilo",
        "qodercli",
        "maki",
        "claurst",
        "qwen",
    ];
    LABELS.iter().copied().find(|candidate| *candidate == label)
}

fn agent_status_to_static(status: &str) -> &'static str {
    match status {
        "working" => "working",
        "blocked" => "blocked",
        "done" => "done",
        "idle" => "idle",
        _ => "unknown",
    }
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
    // Keep the focused workspace whenever it still exists: zero-tab
    // workspaces are valid surfaces now, so a missing tab/pane must not
    // yank focus to an arbitrary other workspace.
    let workspace = data
        .focused_workspace_id
        .as_ref()
        .and_then(|id| data.workspaces.get(id).map(|ws| ws.workspace_id.clone()))
        .or_else(|| {
            data.workspaces
                .values()
                .next()
                .map(|ws| ws.workspace_id.clone())
        });
    let Some(workspace) = workspace else {
        data.focused_workspace_id = None;
        data.focused_tab_id = None;
        data.focused_pane_id = None;
        return;
    };
    data.focused_workspace_id = Some(workspace.clone());
    // A focused tab that no longer exists (or a workspace with zero
    // tabs) resolves to no tab; the pane follows the resolved tab.
    data.focused_tab_id = data
        .focused_tab_id
        .as_ref()
        .filter(|tab_id| {
            data.tabs
                .get(*tab_id)
                .is_some_and(|tab| tab.workspace_id == workspace)
        })
        .cloned()
        .or_else(|| {
            data.workspaces
                .get(&workspace)
                .and_then(|ws| ws.tab_ids.first().cloned())
        });
    data.focused_pane_id = data
        .focused_pane_id
        .as_ref()
        .filter(|pane_id| {
            data.panes
                .get(*pane_id)
                .is_some_and(|pane| pane.tab_id == data.focused_tab_id.clone().unwrap_or_default())
        })
        .cloned()
        .or_else(|| {
            data.focused_tab_id
                .as_ref()
                .and_then(|tab_id| data.tabs.get(tab_id))
                .and_then(|tab| tab.pane_ids.first().cloned())
        });
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

fn optional_bool(params: &Value, key: &str) -> Option<bool> {
    params.get(key).and_then(Value::as_bool)
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
    // Image-protocol hints. The browser terminal renders Kitty graphics
    // (Ghostty core in wterm 0.5.0), so advertise a Kitty-capable host
    // terminal: agents like jcode use these to pick the Kitty emitter
    // instead of iTerm2/Sixel. Overwrite inherited values - the launching
    // shell (e.g. iTerm.app) leaks its own TERM_PROGRAM and KITTY_WINDOW_ID
    // into the server env, which would misdirect detection toward
    // protocols the web renderer cannot show. The PTY child inherits the
    // server env directly (CommandBuilder::env only adds on top), so the
    // spawn site must also env_remove() the keys listed here.
    env.insert("TERM_PROGRAM".to_string(), "ghostty".to_string());
    env.remove("KITTY_WINDOW_ID");
    env
}

/// Env keys that `terminal_environment` scrubs and that the spawn site must
/// remove from the inherited PTY env (CommandBuilder::env() cannot unset).
pub(crate) const TERMINAL_ENV_SCRUB_KEYS: [&str; 1] = ["KITTY_WINDOW_ID"];

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
            "claurst" => Some("claurst"),
            "qwen" | "qwen-code" => Some("qwen"),
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
    let bottom3 = bottom_non_empty_lines(&lower, 3);
    let bottom8 = bottom_non_empty_lines(&lower, 8);
    let bottom12 = bottom_non_empty_lines(&lower, 12);
    if mentions_jcode_brand(&lower)
        || jcode_blocked_markers(&bottom8)
        || has_jcode_spinner(&bottom3)
        || is_jcode_active_background_line(&bottom8)
        || lower.contains("network disconnected, waiting to retry")
        || bottom12
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .is_some_and(|line| {
                let line = line.trim();
                jcode_numbered_prompt_line(line) || jcode_shell_prompt_line(line)
            })
    {
        return Some("jcode");
    }
    if lower.contains("claurst")
        || (lower.contains("yes, allow once") && lower.contains("no, deny"))
        || (lower.contains("yes, always allow (persistent)")
            && lower.contains("yes, allow this session"))
    {
        return Some("claurst");
    }
    // Qwen Code: detect from its signature confirmation and composer patterns.
    if (lower.contains("yes, allow once")
        && contains_any(
            &lower,
            &[
                "apply this change?",
                "allow execution of:",
                "do you want to proceed?",
                "shell command execution",
            ],
        ))
        || (lower.contains("do you trust this folder?") && lower.contains("don't trust (esc)"))
    {
        return Some("qwen");
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

/// Reads a live process's current working directory. Used by `tab.promote`
/// to root the promoted workspace at the directory the shell `cd`-ed into,
/// not the PTY spawn cwd, and by chat-lens PaneContexts to check a session's
/// cwd evidence. Returns `None` when the probe fails (missing pid,
/// permission denied, unsupported platform) so callers fall back to the
/// pane's registered cwd.
#[cfg(unix)]
fn live_process_cwd(pid: Option<u32>) -> Option<PathBuf> {
    let pid = pid?;
    #[cfg(target_os = "linux")]
    {
        // Cheapest probe: /proc/<pid>/cwd resolves to the live cwd.
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }
    #[cfg(not(target_os = "linux"))]
    {
        macos_process_cwd(pid)
    }
}

/// Native cwd probe for macOS (and other non-Linux unixes carrying
/// libSystem). The old implementation forked `lsof` per call (50-200ms),
/// paid on every conversation poll and every agents refresh;
/// `proc_pidinfo(PROC_PIDVNODEPATHINFO)` reads the same kernel vnode the
/// cwd points at, at syscall cost (microseconds). Returns None on any
/// failure: missing pid, EPERM, empty path.
#[cfg(all(unix, not(target_os = "linux")))]
fn macos_process_cwd(pid: u32) -> Option<PathBuf> {
    use std::ffi::OsStr;
    use std::os::unix::ffi::OsStrExt;
    // Mirrors <sys/proc_info.h> vnode_info_path so the cwd path can be
    // read out of the struct the kernel fills. Only pvi_cdir.vip_path is
    // consumed; the stat fields exist just to keep the layout exact.
    // vinfo_stat's largest member alignment is 8, so the whole struct is
    // naturally 8-aligned on every ABI we target.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct VinfoStat {
        vst_dev: u32,
        vst_mode: u16,
        vst_nlink: u16,
        vst_ino: u64,
        vst_uid: u32,
        vst_gid: u32,
        vst_atime: i64,
        vst_atimensec: i64,
        vst_mtime: i64,
        vst_mtimensec: i64,
        vst_ctime: i64,
        vst_ctimensec: i64,
        vst_birthtime: i64,
        vst_birthtimensec: i64,
        vst_size: i64,
        vst_blocks: i64,
        vst_blksize: i32,
        vst_flags: u32,
        vst_gen: u32,
        vst_rdev: u32,
        vst_qspare: [i64; 2],
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct VnodeInfo {
        vi_stat: VinfoStat,
        vi_type: i32,
        vi_pad: i32,
        vi_fsid: [i32; 2], // fsid_t: two int32_t
    }
    #[repr(C)]
    struct VnodeInfoPath {
        vip_vi: VnodeInfo,
        vip_path: [u8; 1024], // MAXPATHLEN
    }
    #[repr(C)]
    struct ProcVnodePathInfo {
        pvi_cdir: VnodeInfoPath, // current working directory
        pvi_rdir: VnodeInfoPath, // root directory (chroot)
    }
    extern "C" {
        fn proc_pidinfo(
            pid: i32,
            flavor: i32,
            arg: u64,
            buffer: *mut core::ffi::c_void,
            buffersize: i32,
        ) -> i32;
    }
    const PROC_PIDVNODEPATHINFO: i32 = 9;
    // All-zero POD: every field is an integer, no niches, valid repr(C).
    let mut info: ProcVnodePathInfo = unsafe { core::mem::zeroed() };
    let size = core::mem::size_of::<ProcVnodePathInfo>() as i32;
    let rc = unsafe {
        proc_pidinfo(
            pid as i32,
            PROC_PIDVNODEPATHINFO,
            0,
            &mut info as *mut _ as *mut core::ffi::c_void,
            size,
        )
    };
    if rc < size {
        return None;
    }
    let path = &info.pvi_cdir.vip_path;
    let len = path.iter().position(|&b| b == 0)?;
    if len == 0 {
        return None;
    }
    Some(PathBuf::from(OsStr::from_bytes(&path[..len])))
}

#[cfg(not(unix))]
fn live_process_cwd(_pid: Option<u32>) -> Option<PathBuf> {
    None
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

/// Detect agent status using OSC 9 progress payload as primary signal,
/// falling back to screen-scraping when no OSC payload is present.
/// This mirrors herdr's manifest-based detection: OSC rules at priority 1100
/// always win over screen-scrape rules at lower priority.
fn detect_agent_status_with_osc(
    agent: Option<&str>,
    text: &str,
    osc_progress: &str,
    osc_title: &str,
    jcode_variant: JcodeDetectionVariant,
) -> &'static str {
    // OSC title rules have the highest priority (up to 1300 in manifests).
    // Check them before OSC progress and screen-scrape.
    if !osc_title.is_empty() {
        if let Some(agent) = agent {
            if let Some(status) = osc_title_status_for_agent(agent, osc_title) {
                return status;
            }
        }
    }
    if !osc_progress.is_empty() {
        let Some(agent) = agent else {
            return "unknown";
        };
        if let Some(status) = osc_progress_status_for_agent(agent, osc_progress) {
            return status;
        }
    }
    detect_agent_status(agent, text, jcode_variant)
}

/// Map an OSC 9 progress payload to an agent status string.
///
/// Agents emit structured progress via OSC 9:
/// - jcode (herdr_detectable branch only; master never emits OSC 9):
///   `jcode:working`, `jcode:idle`, `jcode:blocked`
/// - Claude: OSC 9;4 `4;0` → idle only (no working rule in manifest)
/// - Qwen: OSC 9;4 `4;3` → working only (no idle rule in manifest)
/// - Grok: OSC 9;4 `4;1;-1` → working, `4;0;0` → idle
///
/// Returns `None` for unknown formats so the caller falls back to
/// screen-scrape detection.
fn osc_progress_status_for_agent(agent: &str, osc_progress: &str) -> Option<&'static str> {
    match agent {
        "jcode" => match osc_progress {
            "jcode:working" => Some("working"),
            "jcode:idle" => Some("idle"),
            "jcode:blocked" => Some("blocked"),
            _ => None,
        },
        // Claude manifest: osc_progress_idle regex '^4;0' → idle only.
        // No osc_progress_working rule; 4;3 falls through to screen-scrape.
        "claude" => {
            if osc_progress.starts_with("4;0") {
                Some("idle")
            } else {
                None
            }
        }
        // Qwen manifest: osc_tool_progress_working regex '^4;3(?:;|$)' →
        // working only. No osc_progress_idle rule; 4;0 falls through to
        // screen-scrape.
        "qwen" => {
            if osc_progress.starts_with("4;3") {
                Some("working")
            } else {
                None
            }
        }
        // Grok emits OSC 9;4 with payload "4;1;-1" while busy and "4;0;0" idle.
        "grok" => {
            if osc_progress == "4;1;-1" {
                Some("working")
            } else if osc_progress == "4;0;0" {
                Some("idle")
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Map an OSC 0/2 terminal title to an agent status string based on
/// `osc_title` manifest rules. Returns `None` when the title doesn't match
/// any known pattern, letting the caller fall back to OSC progress or
/// screen-scrape detection.
///
/// Mirrors the `osc_title` rules from herdr's detection manifests for:
/// amp, claude, codex, grok, hermes, qwen. The jcode arm reads jcode's
/// own title grammar instead (work/last segments).
fn osc_title_status_for_agent(agent: &str, title: &str) -> Option<&'static str> {
    match agent {
        // amp.toml: blocked if "Plugin confirmation needed", working if
        // braille prefix, idle if " - amp - " without braille/blocker.
        "amp" => {
            if title.contains("Plugin confirmation needed") {
                Some("blocked")
            } else if starts_with_braille(title) {
                Some("working")
            } else if title.contains(" - amp - ") {
                Some("idle")
            } else {
                None
            }
        }
        // claude.toml: working if braille or half-circle prefix, idle if ✳ prefix.
        "claude" => {
            if has_claude_half_circle_spinner(title) || starts_with_braille(title) {
                Some("working")
            } else if title.starts_with('✳') {
                // ✳ U+2733 followed by optional FE0E and space.
                let chars: Vec<char> = title.chars().collect();
                if chars.len() >= 2 && (chars[1] == ' ' || chars[1] == '\u{fe0e}') {
                    Some("idle")
                } else {
                    None
                }
            } else {
                None
            }
        }
        // codex.toml: blocked if "Action Required", working if braille anywhere,
        // idle if non-empty without braille/blocker.
        "codex" => {
            if title.contains("Action Required") {
                Some("blocked")
            } else if title.contains(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'])
            {
                Some("working")
            } else if !title.is_empty() {
                Some("idle")
            } else {
                None
            }
        }
        // grok.toml: blocked if "Action Required", idle if title ends with
        // "grok" without braille, working if any non-whitespace without idle match.
        "grok" => {
            if title.contains("Action Required") {
                Some("blocked")
            } else if (title == "grok" || title.ends_with(" - grok")) && !contains_braille(title) {
                Some("idle")
            } else if !title.trim().is_empty() {
                Some("working")
            } else {
                None
            }
        }
        // hermes.toml: blocked if ⚠ prefix, working if ⏳ prefix, idle if ✓ prefix.
        "hermes" => {
            let mut chars = title.chars();
            if let Some(first) = chars.next() {
                let second = chars.next();
                let after_variant = match second {
                    Some('\u{fe0e}') | Some('\u{fe0f}') => chars.next(),
                    Some(_) => second,
                    None => None,
                };
                let is_space_or_end = matches!(after_variant, Some(' ') | None);
                if first == '⚠' && is_space_or_end {
                    Some("blocked")
                } else if first == '⏳' && is_space_or_end {
                    Some("working")
                } else if first == '✓' && is_space_or_end {
                    Some("idle")
                } else {
                    None
                }
            } else {
                None
            }
        }
        // qwen.toml: blocked if ✳ prefix (U+2733 + optional FE0E + space),
        // working if ◐ prefix (U+25D0 + optional FE0E + space).
        "qwen" => {
            let mut chars = title.chars();
            if let Some(first) = chars.next() {
                let second = chars.next();
                let after_variant = match second {
                    Some('\u{fe0e}') => chars.next(),
                    _ => second,
                };
                if first == '✳' && after_variant == Some(' ') {
                    Some("blocked")
                } else if first == '◐' && after_variant == Some(' ') {
                    Some("working")
                } else {
                    None
                }
            } else {
                None
            }
        }
        // jcode: the title's work-segment suffix encodes the turn state
        // (`title_with_metrics` in jcode's terminal_title.rs): ` · work ~<dur>`
        // while a turn runs and ` · last ~<dur>` once it finished. `last` is
        // the only reliable idle signal for the post-turn screen, where the
        // scrape markers (numbered prompt, hint row, context bar) fall out of
        // the tail window. `work` maps to None on purpose: the scrape path
        // also carries `blocked`, and a title saying `work` must not outrank
        // a live Permissions viewer on screen.
        "jcode" => {
            if title.contains(" · last ~") {
                Some("idle")
            } else {
                None
            }
        }
        _ => None,
    }
}

fn detect_agent_status(
    agent: Option<&str>,
    text: &str,
    jcode_variant: JcodeDetectionVariant,
) -> &'static str {
    let Some(agent) = agent else {
        return "unknown";
    };
    let lower = text.to_lowercase();
    match agent {
        "jcode" => detect_jcode_status_with_variant(&lower, jcode_variant),
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
        "claurst" => crate::builtin_detection::claurst::detect_claurst_status(&lower),
        "qwen" => detect_qwen_status(&lower),
        _ => "unknown",
    }
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

fn enrich_worktree_commit_dates(rows: &mut [Value]) {
    for row in rows {
        let Some(path) = row.get("path").and_then(Value::as_str).map(str::to_string) else {
            continue;
        };
        let Ok(text) = git_output(Path::new(&path), &["log", "-1", "--format=%cI%x00%H"]) else {
            continue;
        };
        let mut parts = text.split('\0');
        let date = parts.next().unwrap_or_default().trim();
        let hash = parts.next().unwrap_or_default().trim();
        if let Some(object) = row.as_object_mut() {
            if !date.is_empty() {
                object.insert("last_commit_at".to_string(), json!(date));
            }
            if !hash.is_empty() {
                object.insert("last_commit_hash".to_string(), json!(hash));
            }
        }
    }
}

fn worktree_activity_key(row: &Value) -> String {
    row.get("last_commit_at")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
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
    use interprocess::local_socket::traits::Stream as _;

    // PTY tests run their shells through this, not the user's login shell:
    // default_shell() resolves $SHELL (zsh + .zshrc here), whose fork-heavy
    // init (pyenv/jenv/oh-my-posh/zoxide) stalls past the 20s deadlines when
    // the whole bin suite spawns dozens of panes in parallel, and the seed
    // poll then trips with nothing but the kernel's input echo. /bin/sh runs
    // no rc file; these tests exercise the PTY/scrollback/fanout protocol,
    // not any shell program.
    fn hermetic_test_shell() -> String {
        "/bin/sh".to_string()
    }

    #[test]
    fn client_disconnect_marker_matches_only_eof_kind() {
        // The handler routes errors to `Ok(())` on a clean disconnect and
        // everything else to `Err`, so a too-loose marker would silently
        // swallow real transport failures (reset, broken pipe). EOF at both
        // read stages is a disconnect; anything carrying another kind is
        // not, even when std's prose mentions the same words.
        assert!(is_client_disconnect(
            "read frame length: failed to fill whole buffer (kind UnexpectedEof)"
        ));
        assert!(is_client_disconnect(
            "read 130-byte frame body: failed to fill whole buffer (kind UnexpectedEof)"
        ));
        assert!(!is_client_disconnect(
            "read frame length: connection reset by peer (kind ConnectionReset)"
        ));
        assert!(!is_client_disconnect(
            "read frame length: resource temporarily unavailable (kind WouldBlock)"
        ));
        // Old check matched std's prose directly; the marker must not
        // regress to that behavior for a non-EOF error that happens to
        // contain the phrase.
        assert!(!is_client_disconnect(
            "failed to fill whole buffer (kind ConnectionReset)"
        ));
    }

    #[test]
    fn client_connection_treats_immediate_eof_as_clean_disconnect() {
        // Handler-level proof that dropping the socket before the hello
        // returns Ok(()), not an error: clean teardown must not log
        // "terminal connection failed". A real listener + real accepted
        // stream, not a Cursor, because the fix under test is about the
        // exact error text a real EOF produces on this platform.
        let (dir, listener, backend) = eof_test_backend();
        let sock = dir.join("client.sock");
        use interprocess::local_socket::{prelude::*, GenericFilePath};
        // Connect and close immediately: EOF before any length byte.
        let client = interprocess::local_socket::Stream::connect(
            sock.clone().to_fs_name::<GenericFilePath>().unwrap(),
        )
        .unwrap();
        let server = listener.accept().unwrap();
        drop(client);
        let result = handle_client_connection(server, Arc::clone(&backend));
        assert!(result.is_ok(), "EOF before hello must be Ok: {result:?}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn client_connection_treats_mid_stream_eof_as_clean_disconnect() {
        // The loop guard (the `break` path), not the hello guard: complete
        // the handshake, then drop the client between frames. This is the
        // teardown every e2e run performs when its ServerGuard closes the
        // client stream, so it must land in Ok(()) exactly like the
        // pre-hello EOF does.
        let (dir, listener, backend) = eof_test_backend();
        let sock = dir.join("client.sock");
        use interprocess::local_socket::{prelude::*, GenericFilePath};
        let mut client = interprocess::local_socket::Stream::connect(
            sock.clone().to_fs_name::<GenericFilePath>().unwrap(),
        )
        .unwrap();
        let server = listener.accept().unwrap();
        // Handshake exactly as the e2e suites do: framed TerminalHello.
        let hello = bincode::serde::encode_to_vec(
            &ClientMessage::TerminalHello {
                version: PROTOCOL_VERSION,
                cols: 120,
                rows: 40,
                cell_width_px: 0,
                cell_height_px: 0,
                pixel_mouse: false,
            },
            bincode::config::standard(),
        )
        .unwrap();
        client
            .write_all(&(hello.len() as u32).to_le_bytes())
            .unwrap();
        client.write_all(&hello).unwrap();
        client.flush().unwrap();
        // Drain the Welcome on the client side BEFORE closing: the
        // handler writes it synchronously during the handshake, and a
        // closed peer would turn that write into EPIPE (an Err), muddying
        // what this test proves. The handler must be running while the
        // client drains (the handler is the writer), and after the welcome
        // the handler can only block on the loop read, so dropping the
        // client here puts it deterministically on the EOF path.
        let handle = thread::spawn(move || handle_client_connection(server, backend));
        let mut len_buf = [0u8; 4];
        client.read_exact(&mut len_buf).unwrap();
        let mut welcome = vec![0u8; u32::from_le_bytes(len_buf) as usize];
        client.read_exact(&mut welcome).unwrap();
        drop(client);
        let result = handle.join().unwrap();
        assert!(
            result.is_ok(),
            "EOF after hello must be Ok (loop break), got: {result:?}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    /// Shared fixture for the EOF tests: scratch dir, a listener bound on
    /// a per-test socket path, and a backend whose Drop removes the
    /// socket files (the dir itself is the tests' job to delete).
    ///
    /// The path mixes pid, nanos and a process-local counter: parallel
    /// tests can read the same nanos (measured: ~21us clock granularity,
    /// 18.65% exact tie between two threads) and with the same path
    /// try_overwrite(true) silently rebinds the socket, so one test's
    /// connect lands on the wrong listener and both wedge forever in
    /// accept()/read with nothing logged. The counter breaks the tie.
    fn eof_test_backend() -> (
        PathBuf,
        interprocess::local_socket::Listener,
        Arc<BuiltinBackendInner>,
    ) {
        static FIXTURE_ID: AtomicU64 = AtomicU64::new(0);
        let id = FIXTURE_ID.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "herdr-eof-sock-{}-{}-{}",
            std::process::id(),
            id,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let sock = dir.join("client.sock");
        use interprocess::local_socket::{prelude::*, GenericFilePath};
        let name = sock.clone().to_fs_name::<GenericFilePath>().unwrap();
        let listener = interprocess::local_socket::ListenerOptions::new()
            .name(name)
            .try_overwrite(true)
            .create_sync()
            .unwrap();
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let backend = Arc::new(BuiltinBackendInner {
            running: AtomicBool::new(true),
            api_socket: dir.join("api.sock"),
            client_socket: sock,
            state: Arc::new(state),
        });
        (dir, listener, backend)
    }

    #[test]
    fn openpty_retry_recovers_from_transient_failures() {
        // Two transient ENXIO-style failures, then success: the helper
        // retries with backoff and returns the pty.
        let attempts = std::sync::atomic::AtomicU8::new(0);
        let result = openpty_with_retry(24, 80, &|rows, cols| {
            let n = attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if n < 2 {
                Err(io::Error::other("Device not configured"))
            } else {
                Ok((rows, cols))
            }
        });
        assert_eq!(result.unwrap(), (24, 80));
        assert_eq!(
            attempts.load(std::sync::atomic::Ordering::SeqCst),
            3,
            "two failures then one success"
        );
    }

    #[test]
    fn openpty_retry_surfaces_persistent_failure() {
        // Every attempt fails: the last error surfaces after the retries.
        let attempts = std::sync::atomic::AtomicU8::new(0);
        let result = openpty_with_retry::<u8, io::Error>(24, 80, &|_rows, _cols| {
            attempts.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(io::Error::other("Device not configured"))
        });
        let err = result.unwrap_err();
        assert!(err.to_string().contains("Device not configured"));
        assert_eq!(
            attempts.load(std::sync::atomic::Ordering::SeqCst),
            3,
            "three attempts before giving up"
        );
    }

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
        assert_eq!(
            detect_agent_label(&["/home/user/.cargo/bin/claurst".into()]),
            Some("claurst")
        );
        assert_eq!(detect_agent_label(&["bash".into()]), None);
    }

    #[test]
    fn builtin_event_hub_publishes_mutation_events() {
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let rx = state.subscribe_events();

        state.handle_request("test", "tab.create", json!({ "label": "second" }));

        let event = rx.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event["event"], "tab.created");
        assert_eq!(event["data"]["type"], "tab_created");
    }

    #[test]
    fn builtin_tab_create_respects_focus_false() {
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let workspace =
            state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let workspace_id = workspace["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        let focused_tab_id = workspace["result"]["tab"]["tab_id"]
            .as_str()
            .unwrap()
            .to_string();

        let background_tab = state.handle_request(
            "background-tab",
            "tab.create",
            json!({ "workspace_id": workspace_id, "label": "Temp", "focus": false }),
        );
        let background_tab_id = background_tab["result"]["tab"]["tab_id"].as_str().unwrap();
        let snapshot = state.handle_request("snapshot", "session.snapshot", json!({}));

        assert_eq!(
            snapshot["result"]["snapshot"]["focused_tab_id"].as_str(),
            Some(focused_tab_id.as_str())
        );
        let tabs = snapshot["result"]["snapshot"]["tabs"].as_array().unwrap();
        assert!(tabs
            .iter()
            .any(|tab| tab["tab_id"] == focused_tab_id && tab["focused"] == true));
        assert!(tabs
            .iter()
            .any(|tab| tab["tab_id"] == background_tab_id && tab["focused"] == false));
    }

    // ── tab.promote ──

    /// Shared fixture for the promote tests: a workspace "temp" at `dir`
    /// holding one overlay-shaped tab labeled "temp", with a live terminal
    /// process so the live-cwd probe and the "process must never die"
    /// invariant are both exercised. Records are inserted by hand (no
    /// workspace.create/tab.create round-trip) so no login shell is spawned:
    /// the user's rc files (pyenv and friends) can delay input processing for
    /// seconds and make the cd-driven tests flaky.
    fn promote_fixture(dir: &Path) -> (BuiltinState, String, String) {
        let state = BuiltinState::new(
            dir.to_path_buf(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let workspace_id = promote_create_workspace(&state, "temp", dir);
        #[cfg(unix)]
        let tab_id = promote_create_tab_with_shell(&state, &workspace_id, "temp");
        #[cfg(not(unix))]
        let tab_id = {
            let tab = state.handle_request(
                "tab",
                "tab.create",
                json!({ "workspace_id": workspace_id, "label": "temp", "focus": false }),
            );
            tab["result"]["tab"]["tab_id"].as_str().unwrap().to_string()
        };
        (state, workspace_id, tab_id)
    }

    /// Inserts a bare WorkspaceRecord (no root tab, no terminal). Mirrors
    /// create_workspace's registry shape for tests that only need the
    /// bookkeeping.
    fn promote_create_workspace(state: &BuiltinState, label: &str, cwd: &Path) -> String {
        let mut data = state.data.lock().unwrap();
        let workspace_id = next_id(&mut data, "ws");
        data.workspaces.insert(
            workspace_id.clone(),
            WorkspaceRecord {
                workspace_id: workspace_id.clone(),
                label: label.to_string(),
                cwd: cwd.to_path_buf(),
                tab_ids: Vec::new(),
            },
        );
        workspace_id
    }

    /// Creates a tab whose terminal runs an rc-free interactive shell, so a
    /// written `cd` is processed within milliseconds instead of waiting on
    /// login-shell rc files. Mirrors create_tab's registry shape exactly;
    /// test-only.
    #[cfg(unix)]
    fn promote_create_tab_with_shell(
        state: &BuiltinState,
        workspace_id: &str,
        label: &str,
    ) -> String {
        let cwd = {
            let data = state.data.lock().unwrap();
            data.workspaces
                .get(workspace_id)
                .map(|workspace| workspace.cwd.clone())
                .unwrap()
        };
        let argv = vec!["/bin/sh".to_string(), "-i".to_string()];
        let (tab_id, pane_id, terminal_id) = {
            let mut data = state.data.lock().unwrap();
            (
                next_id(&mut data, "tab"),
                next_id(&mut data, "pane"),
                next_id(&mut data, "term"),
            )
        };
        let terminal = TerminalRuntime::spawn(
            terminal_id.clone(),
            cwd.clone(),
            argv.clone(),
            30,
            100,
            state.events.clone(),
            PaneEventContext {
                workspace_id: workspace_id.to_string(),
                tab_id: tab_id.clone(),
                pane_id: pane_id.clone(),
                terminal_id: terminal_id.clone(),
            },
            state.jcode_detection_variant,
        )
        .unwrap();
        let mut data = state.data.lock().unwrap();
        data.tabs.insert(
            tab_id.clone(),
            TabRecord {
                tab_id: tab_id.clone(),
                workspace_id: workspace_id.to_string(),
                label: label.to_string(),
                pane_ids: vec![pane_id.clone()],
            },
        );
        if let Some(workspace) = data.workspaces.get_mut(workspace_id) {
            workspace.tab_ids.push(tab_id.clone());
        }
        data.panes.insert(
            pane_id.clone(),
            PaneRecord {
                pane_id: pane_id.clone(),
                terminal_id: terminal_id.clone(),
                workspace_id: workspace_id.to_string(),
                tab_id: tab_id.clone(),
                cwd,
                label: None,
                argv,
            },
        );
        data.terminals.insert(terminal_id, terminal);
        tab_id
    }

    /// Writes a `cd <dir>` into the tab's shell and waits for the shell to
    /// process it, so the live-cwd probe observes the change like in
    /// production. Polls because shell startup and parallel test load can
    /// delay the command; panics after ~5s so a stuck shell fails the test
    /// loudly instead of tripping the same-workspace guard below.
    #[cfg(unix)]
    fn promote_send_cd(state: &BuiltinState, tab_id: &str, dir: &Path) {
        let terminal_id = {
            let data = state.data.lock().unwrap();
            data.tabs
                .get(tab_id)
                .and_then(|tab| tab.pane_ids.first())
                .and_then(|pane_id| data.panes.get(pane_id))
                .map(|pane| pane.terminal_id.clone())
                .unwrap()
        };
        let Some(terminal) = state.terminal(&terminal_id) else {
            panic!("no terminal for tab {tab_id}");
        };
        let _ = terminal.write_input(format!("cd {}\n", dir.to_string_lossy()).as_bytes());
        // The probe resolves symlinks (macOS tempdir is /var -> /private/var),
        // so compare canonical forms.
        let canonical_dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        let mut last_seen = None;
        for _ in 0..50 {
            let observed = live_process_cwd(terminal.child_pid());
            if observed.as_deref() == Some(canonical_dir.as_path()) {
                return;
            }
            last_seen = observed;
            thread::sleep(Duration::from_millis(100));
        }
        panic!(
            "shell in tab {tab_id} never processed cd into {dir:?} (last live cwd: {last_seen:?})"
        );
    }

    fn promoted_workspaces(snapshot: &Value) -> Vec<String> {
        snapshot["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|workspace| {
                workspace["workspace_id"]
                    .as_str()
                    .unwrap_or_default()
                    .to_string()
            })
            .collect()
    }

    #[cfg(unix)]
    #[test]
    fn builtin_promote_reparents_tab_into_new_workspace_without_killing_terminal() {
        let temp = std::env::temp_dir().join(format!(
            "herdr-promote-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&temp).unwrap();
        let (state, temp_workspace_id, tab_id) = promote_fixture(&temp);

        // Terminal is alive before the promote.
        let terminal_id = {
            let data = state.data.lock().unwrap();
            data.tabs
                .get(&tab_id)
                .and_then(|tab| tab.pane_ids.first())
                .and_then(|pane_id| data.panes.get(pane_id))
                .map(|pane| pane.terminal_id.clone())
                .unwrap()
        };
        let alive_before = state
            .terminal(&terminal_id)
            .is_some_and(|terminal| !terminal.exited.load(Ordering::Acquire));
        assert!(alive_before);

        // Promote: the live cwd (the shell has not cd-ed anywhere yet, so
        // the probe reports the spawn cwd = temp) is already the workspace
        // cwd, so this first call must fail the same-workspace guard.
        let guard =
            state.handle_request("promote-guard", "tab.promote", json!({ "tab_id": tab_id }));
        assert!(
            guard["error"].is_object(),
            "promoting into the same workspace must fail, got: {guard}"
        );

        // cd the shell into a subdirectory, then promote for real. The
        // live-cwd probe must pick the subdirectory, not the spawn cwd.
        let sub = temp.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let canonical_sub = std::fs::canonicalize(&sub).unwrap_or_else(|_| sub.clone());
        // Drive the shell with a real `cd` so the live probe sees it. This
        // requires the PTY child to be a shell; the fixture's /bin/sh -i
        // guarantees that on unix.
        promote_send_cd(&state, &tab_id, &sub);
        let live = state
            .terminal(&terminal_id)
            .and_then(|terminal| live_process_cwd(terminal.child_pid()))
            .unwrap_or_else(|| PathBuf::from(""));
        assert_eq!(
            live, canonical_sub,
            "live cwd probe should follow the shell cd"
        );

        let promoted = state.handle_request("promote", "tab.promote", json!({ "tab_id": tab_id }));
        assert!(
            promoted["result"].is_object(),
            "promote should succeed, got: {promoted}"
        );
        let new_workspace_id = promoted["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(new_workspace_id, temp_workspace_id);
        assert_eq!(
            promoted["result"]["workspace"]["cwd"],
            canonical_sub.to_string_lossy().to_string(),
            "promoted workspace must root at the live cwd"
        );
        assert_eq!(promoted["result"]["tab"]["label"], "Shell");

        // Invariant: the terminal was never stopped.
        let alive_after = state
            .terminal(&terminal_id)
            .is_some_and(|terminal| !terminal.exited.load(Ordering::Acquire));
        assert!(alive_after, "promote must never stop the process");

        // The emptied temp workspace is gone from the registry.
        let snapshot = state.handle_request("snapshot", "session.snapshot", json!({}));
        let workspace_ids = promoted_workspaces(&snapshot);
        assert!(!workspace_ids.contains(&temp_workspace_id));
        assert!(workspace_ids.contains(&new_workspace_id));

        // The promoted tab lists the new workspace and keeps its pane.
        let listed_tab = snapshot["result"]["snapshot"]["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tab| tab["tab_id"] == tab_id.as_str())
            .unwrap()
            .clone();
        assert_eq!(listed_tab["workspace_id"], new_workspace_id.as_str());
        let panes = snapshot["result"]["snapshot"]["panes"].as_array().unwrap();
        assert!(panes.iter().any(|pane| pane["tab_id"] == tab_id.as_str()
            && pane["workspace_id"] == new_workspace_id.as_str()));

        let _ = fs::remove_dir_all(&temp);
    }

    #[cfg(unix)]
    #[test]
    fn builtin_promote_finds_existing_workspace_at_live_path() {
        let temp = std::env::temp_dir().join(format!(
            "herdr-promote-existing-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let sub = temp.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let (state, temp_workspace_id, tab_id) = promote_fixture(&temp);

        // A workspace already exists at the target path (bare record, like
        // a workspace whose root tab was closed).
        let existing_workspace_id = promote_create_workspace(&state, "existing", &sub);

        // Point the pane cwd at the target (the live probe runs against the
        // shell pid; in the test the shell is real so cd is possible, but the
        // registry pane.cwd fallback covers the probe-less path too). Drive
        // a real cd so both the live probe and the fallback agree.
        promote_send_cd(&state, &tab_id, &sub);

        let promoted = state.handle_request("promote", "tab.promote", json!({ "tab_id": tab_id }));
        assert!(
            promoted["result"].is_object(),
            "promote should reuse the existing workspace, got: {promoted}"
        );
        assert_eq!(
            promoted["result"]["workspace"]["workspace_id"],
            existing_workspace_id.as_str(),
            "must reuse the workspace already open at the live path"
        );

        let snapshot = state.handle_request("snapshot", "session.snapshot", json!({}));
        let workspace_ids = promoted_workspaces(&snapshot);
        assert!(!workspace_ids.contains(&temp_workspace_id));
        assert!(workspace_ids.contains(&existing_workspace_id));
        let listed_tab = snapshot["result"]["snapshot"]["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tab| tab["tab_id"] == tab_id.as_str())
            .unwrap()
            .clone();
        assert_eq!(listed_tab["workspace_id"], existing_workspace_id.as_str());

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn builtin_promote_unknown_tab_fails() {
        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let promoted =
            state.handle_request("promote", "tab.promote", json!({ "tab_id": "tab_missing" }));
        assert!(promoted["error"].is_object());
        assert!(promoted["error"]["message"]
            .as_str()
            .unwrap()
            .contains("tab tab_missing not found"));
    }

    #[test]
    fn builtin_close_unknown_tab_is_an_error() {
        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        // A close on a missing tab must fail loudly, not return ok: the
        // old silent no-op hid id-mismatch bugs (a scoped id the server
        // never knew) behind a 200 while the tab stayed alive.
        let closed = state.handle_request("close", "tab.close", json!({ "tab_id": "tab_missing" }));
        assert!(closed["error"].is_object());
        assert!(closed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("tab tab_missing not found"));
    }

    #[test]
    fn builtin_close_unknown_pane_is_an_error() {
        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let closed =
            state.handle_request("close", "pane.close", json!({ "pane_id": "pane_missing" }));
        assert!(closed["error"].is_object());
        assert!(closed["error"]["message"]
            .as_str()
            .unwrap()
            .contains("pane pane_missing not found"));
    }

    #[test]
    fn builtin_close_known_tab_still_works() {
        let temp = std::env::temp_dir().join(format!(
            "herdr-close-known-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        fs::create_dir_all(&temp).unwrap();
        let state = BuiltinState::new(
            temp.clone(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let workspace_id = promote_create_workspace(&state, "close", &temp);
        let created = state.handle_request(
            "create",
            "tab.create",
            json!({ "workspace_id": workspace_id, "label": "close", "focus": false }),
        );
        let tab_id = created["result"]["tab"]["tab_id"].as_str().unwrap();
        let closed = state.handle_request("close", "tab.close", json!({ "tab_id": tab_id }));
        assert!(closed["error"].is_null(), "closing a real tab must succeed");
        let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
        let tabs = snapshot["result"]["snapshot"]["tabs"].as_array().unwrap();
        assert!(tabs.iter().all(|tab| tab["tab_id"] != tab_id));
        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn builtin_promote_same_workspace_is_an_error() {
        let temp = std::env::temp_dir().join(format!(
            "herdr-promote-same-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&temp).unwrap();
        let (state, _workspace_id, tab_id) = promote_fixture(&temp);

        // The shell has not cd-ed anywhere: the live cwd equals the
        // workspace cwd, so promote must refuse instead of making a
        // duplicate workspace.
        let promoted = state.handle_request("promote", "tab.promote", json!({ "tab_id": tab_id }));
        assert!(promoted["error"].is_object());
        let message = promoted["error"]["message"].as_str().unwrap();
        assert!(
            message.contains("already runs in workspace"),
            "unexpected error: {message}"
        );

        let _ = fs::remove_dir_all(&temp);
    }

    #[cfg(unix)]
    #[test]
    fn builtin_promote_publishes_workspace_events() {
        let temp = std::env::temp_dir().join(format!(
            "herdr-promote-events-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let sub = temp.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let (state, temp_workspace_id, tab_id) = promote_fixture(&temp);
        let rx = state.subscribe_events();

        // cd into the subdir and promote.
        promote_send_cd(&state, &tab_id, &sub);
        let promoted = state.handle_request("promote", "tab.promote", json!({ "tab_id": tab_id }));
        assert!(promoted["result"].is_object(), "promote failed: {promoted}");

        // The workspace.closed event for the dropped temp workspace fires
        // through publish_success_event (tab.promote arm), and
        // workspace.created for the new workspace.
        let mut saw_closed = false;
        let mut saw_created = false;
        while let Ok(event) = rx.try_recv() {
            match event["event"].as_str() {
                Some("workspace.closed")
                    if event["data"]["workspace_id"] == temp_workspace_id.as_str() =>
                {
                    saw_closed = true;
                }
                Some("workspace.created") => saw_created = true,
                _ => {}
            }
        }
        assert!(
            saw_closed,
            "workspace.closed for the emptied temp workspace must fire"
        );
        assert!(
            saw_created,
            "workspace.created for the promoted workspace must fire"
        );

        let _ = fs::remove_dir_all(&temp);
    }

    /// Promote must survive a workspace record that went missing between
    /// validation and the re-parent (dangling id in a tab or pane): the
    /// skip-if-absent arms must keep the promote a success instead of
    /// panicking on a half-updated registry. Built by deleting the old
    /// workspace record while the tab still references it.
    #[cfg(unix)]
    #[test]
    fn builtin_promote_survives_dangling_workspace_references() {
        let temp = std::env::temp_dir().join(format!(
            "herdr-promote-dangling-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let sub = temp.join("sub");
        fs::create_dir_all(&sub).unwrap();
        let (state, temp_workspace_id, tab_id) = promote_fixture(&temp);
        promote_send_cd(&state, &tab_id, &sub);

        // Break the invariant on purpose: drop the workspace record the
        // tab/pane still point at. Every promote code path that touches
        // workspace records must tolerate the miss.
        {
            let mut data = state.data.lock().unwrap();
            data.workspaces.remove(&temp_workspace_id);
        }

        let promoted = state.handle_request("promote", "tab.promote", json!({ "tab_id": tab_id }));
        assert!(
            promoted["result"].is_object(),
            "promote must survive dangling workspace ids, got: {promoted}"
        );
        let new_workspace_id = promoted["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_ne!(new_workspace_id, temp_workspace_id);

        // The snapshot stays coherent: the tab lives in the new workspace,
        // and no workspace carries the removed id.
        let snapshot = state.handle_request("snapshot", "session.snapshot", json!({}));
        let listed_tab = snapshot["result"]["snapshot"]["tabs"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tab| tab["tab_id"] == tab_id.as_str())
            .unwrap()
            .clone();
        assert_eq!(listed_tab["workspace_id"], new_workspace_id.as_str());

        let _ = fs::remove_dir_all(&temp);
    }

    /// The live-cwd probe returns None when the process cannot be
    /// interrogated (here: a pid that does not exist), and promote falls
    /// back to the pane's registered cwd when the terminal record is gone.
    /// Exercises the probe failure arm on non-Linux unix plus the fallback
    /// wiring: the same-workspace guard must fire on the pane cwd.
    #[cfg(all(unix, not(target_os = "linux")))]
    #[test]
    fn builtin_promote_probe_failure_falls_back_to_pane_cwd() {
        // Bogus pid: the kernel probe fails, returns None.
        assert!(live_process_cwd(Some(u32::MAX)).is_none());

        let temp = std::env::temp_dir().join(format!(
            "herdr-promote-probe-fail-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&temp).unwrap();
        let (state, _temp_workspace_id, tab_id) = promote_fixture(&temp);
        let pane_cwd = {
            let data = state.data.lock().unwrap();
            let tab = data.tabs.get(&tab_id).unwrap();
            let pane_id = tab.pane_ids.first().unwrap();
            data.panes.get(pane_id).unwrap().cwd.clone()
        };
        // Drop the terminal record so the live probe short-circuits to
        // None and promote must fall back to the pane's registered cwd.
        {
            let mut data = state.data.lock().unwrap();
            let tab = data.tabs.get(&tab_id).unwrap();
            let pane_id = tab.pane_ids.first().unwrap().clone();
            let terminal_id = data.panes.get(&pane_id).unwrap().terminal_id.clone();
            data.terminals.remove(&terminal_id);
        }
        // The fallback equals the workspace cwd, so promote must refuse
        // on the same-workspace guard, naming the pane cwd.
        let promoted = state.handle_request("promote", "tab.promote", json!({ "tab_id": tab_id }));
        let message = promoted["error"]["message"].as_str().unwrap_or("");
        assert!(
            promoted["error"].is_object() && message.contains(&*pane_cwd.to_string_lossy()),
            "probe failure must fall back to the pane cwd (guard must mention it), got: {promoted}"
        );

        let _ = fs::remove_dir_all(&temp);
    }

    /// The native probe must return the same cwd the kernel reports for
    /// THIS process, byte-exact: it replaced `lsof -d cwd` (50-200ms fork)
    /// and a mismatch here would silently mis-route every resolution.
    #[cfg(all(unix, not(target_os = "linux")))]
    #[test]
    fn builtin_live_process_cwd_matches_kernel_truth() {
        let probe = live_process_cwd(Some(std::process::id()));
        let truth = std::env::current_dir().unwrap();
        let canonical_truth = std::fs::canonicalize(&truth).unwrap_or(truth);
        assert_eq!(
            probe.as_deref(),
            Some(canonical_truth.as_path()),
            "native probe must report the process cwd (symlinks resolved, as lsof did)"
        );
    }

    /// A pane whose scrollback exceeds RESOLVE_TAIL_BYTES must still
    /// resolve: the tail bound (64KB) must keep the recency tiebreak
    /// working with far more text than it ever matches against.
    #[cfg(unix)]
    #[test]
    fn builtin_pane_context_tail_is_bounded_but_resolution_survives() {
        let (temp, _guard) = crate::tests::temp_guard("herdr-resolve-tail-bounded");
        let (state, _workspace_id, tab_id) = promote_fixture(&temp);
        let (pane_id, terminal_id) = {
            let data = state.data.lock().unwrap();
            let tab = data.tabs.get(&tab_id).unwrap();
            let pane_id = tab.pane_ids.first().unwrap().clone();
            let terminal_id = data.panes.get(&pane_id).unwrap().terminal_id.clone();
            (pane_id, terminal_id)
        };
        // Push well past RESOLVE_TAIL_BYTES of scrollback through the real
        // PTY, with a discriminating marker line in the LAST few KB. The
        // filler is GENERATED in the shell (yes | head -c), not typed:
        // the PTY canonical line limit (MAX_CANON 4096) silently drops
        // any single typed line longer than that, so a big printf arg
        // never reaches the shell.
        let marker = "RESOLVE_TAIL_MARKER_XYZZY_7c9e";
        let filler_bytes = RESOLVE_TAIL_BYTES + 128 * 1024;
        let terminal = state.terminal(&terminal_id).unwrap();
        let before = terminal.history_bytes().len();
        let script = format!(
            "yes 0123456789abcdef0123456789abcdef | head -c {filler_bytes}; printf '%s\\n' '{marker}'\n"
        );
        terminal.write_input(script.as_bytes()).unwrap();
        // Wait until BOTH conditions hold: the scrollback exceeded the
        // bound (the tail is full) and the marker has landed inside it.
        // Waiting on the tail length alone is racy under load: filler
        // alone fills 64KB long before the trailing printf reaches the
        // scrollback, so a poll can catch mid-filler bytes and the
        // marker assert below would fail on a healthy pane.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let tail = terminal.history_tail_bytes(RESOLVE_TAIL_BYTES);
            let marker_landed = String::from_utf8_lossy(&tail).contains(marker);
            if (tail.len() == RESOLVE_TAIL_BYTES && marker_landed)
                || std::time::Instant::now() > deadline
            {
                break;
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        let tail = terminal.history_tail_bytes(RESOLVE_TAIL_BYTES);
        assert_eq!(
            tail.len(),
            RESOLVE_TAIL_BYTES,
            "scrollback must exceed the tail bound for this test to mean anything"
        );
        assert!(
            String::from_utf8_lossy(&tail).contains(marker),
            "marker written last must be inside the bounded tail"
        );
        // pane_context's strip is bounded but must still carry the marker.
        let pane = {
            let data = state.data.lock().unwrap();
            data.panes.get(&pane_id).unwrap().clone()
        };
        let context = state.pane_context(&pane);
        assert!(
            context.pane_tail.contains(marker),
            "bounded pane_tail must include the newest text (marker missing)"
        );
        assert!(
            context.pane_tail.len() <= RESOLVE_TAIL_BYTES,
            "pane_tail must stay bounded (got {} bytes)",
            context.pane_tail.len()
        );
        assert!(
            before < terminal.history_bytes().len(),
            "the pane must have actually received output"
        );
    }

    #[cfg(unix)]
    #[test]
    #[should_panic(expected = "no terminal for tab")]
    fn builtin_promote_send_cd_panics_without_terminal_runtime() {
        let (temp, _temp_guard) = crate::tests::temp_guard("herdr-promote-cd-noterm");
        let (state, _workspace_id, tab_id) = promote_fixture(&temp);
        // Tab and pane stay, the terminal runtime goes: the helper's
        // lookup must fail loudly instead of writing into a dead PTY.
        {
            let mut data = state.data.lock().unwrap();
            let tab = data.tabs.get(&tab_id).unwrap();
            let pane_id = tab.pane_ids.first().unwrap().clone();
            let terminal_id = data.panes.get(&pane_id).unwrap().terminal_id.clone();
            data.terminals.remove(&terminal_id);
        }
        promote_send_cd(&state, &tab_id, std::env::temp_dir().as_path());
    }

    #[cfg(unix)]
    #[test]
    #[should_panic(expected = "never processed cd into")]
    fn builtin_promote_send_cd_panics_when_shell_never_cds() {
        let (temp, _temp_guard) = crate::tests::temp_guard("herdr-promote-cd-stuck");
        let (state, _workspace_id, tab_id) = promote_fixture(&temp);
        // A directory that cannot become the shell's cwd: remove it after
        // creating the fixture, so every probe observation disagrees with
        // the expected target and the helper hits its 5s panic.
        let gone = temp.join("gone-dir");
        fs::create_dir_all(&gone).unwrap();
        fs::remove_dir(&gone).unwrap();
        promote_send_cd(&state, &tab_id, &gone);

        unreachable!("promote_send_cd must panic when the cd never happens");
    }

    #[test]
    fn builtin_display_numbers_are_scoped_by_level() {
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
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
    fn sweeper_recovers_every_flip_across_bursty_output() {
        // Stress variant of the throttle regression: a long bursty output
        // sequence where every flip lands inside throttle windows. The
        // sweeper must eventually publish EVERY status change; none may be
        // permanently lost even though append_output mostly ran throttled.
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some("/bin/cat".to_string()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let rx = state.subscribe_events();
        let terminal = {
            let data = state.data.lock().unwrap();
            let pane = data.panes.values().next().unwrap();
            data.terminals.get(&pane.terminal_id).unwrap().clone()
        };

        // Rapid-fire appends with no sleeps: nearly every append lands in
        // someone's throttle window, so the pending/sweeper path carries
        // most of the detection load.
        terminal.reset_status_throttle();
        terminal.append_output("⠋ running bash · npm test".as_bytes());
        for _round in 0..6 {
            // working -> blocked -> working -> blocked, all inside windows.
            // The blocked payload is the real `jcode permissions` viewer
            // (`jcode-tui-permissions/src/lib.rs`): border title, the
            // `⏳ Agent is waiting for this decision` line, and the
            // `a approve / d deny` help row.
            terminal.append_output(
                "┌─ Permissions (1 pending) ──┐\n│ ⏳ Agent is waiting for this decision │\n└──────────┘\n a  approve    d  deny    A  approve all    D  deny all".as_bytes(),
            );
            terminal.append_output("\n\n⠹ streaming · 4.1 tps".as_bytes());
            terminal.append_output(
                "┌─ Permissions (1 pending) ──┐\n│ ⏳ Agent is waiting for this decision │\n└──────────┘\n a  approve    d  deny    A  approve all    D  deny all".as_bytes(),
            );
            // Give the sweeper a moment to drain the pending flag between
            // rounds so the sequence does not collapse into one window.
            std::thread::sleep(Duration::from_millis(700));
        }

        // Drain the event stream: the final status must be blocked (the
        // dialog text is the last thing on screen) and at least one
        // blocked event must have arrived during the sequence.
        let mut saw_blocked = false;
        let mut last_status = String::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let timeout = deadline.saturating_duration_since(std::time::Instant::now());
            if timeout.is_zero() {
                break;
            }
            match rx.recv_timeout(timeout) {
                Ok(event) => {
                    if event["event"] == "pane.agent_status_changed" {
                        let status = event["data"]["agent_status"].as_str().unwrap_or("");
                        if status == "blocked" {
                            saw_blocked = true;
                        }
                        last_status = status.to_string();
                    }
                }
                Err(_) => break,
            }
        }
        assert!(
            saw_blocked,
            "a blocked flip must be published during the bursty sequence"
        );
        assert_eq!(
            last_status, "blocked",
            "final status must settle on blocked"
        );
    }

    #[test]
    fn throttled_status_flip_is_recovered_by_sweeper() {
        // Regression test for the throttle-swallowed flip: a status change
        // carried by the LAST bytes of an output burst could be lost when a
        // check ran <500ms earlier and the pane then goes silent (e.g. a
        // permission dialog printed right after heavy output, then the
        // process blocks on input — no further output ever triggers a
        // check). The pending flag + sweeper thread must recover it.
        //
        // /bin/cat blocks on stdin and never writes, so the ONLY output in
        // the scrollback is the synthetic bytes below (the shell prompt
        // cannot race the throttle window like it would with zsh).
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some("/bin/cat".to_string()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let rx = state.subscribe_events();
        let terminal = {
            let data = state.data.lock().unwrap();
            let pane = data.panes.values().next().unwrap();
            data.terminals.get(&pane.terminal_id).unwrap().clone()
        };

        // First burst consumes the throttle window with a working status.
        terminal.reset_status_throttle();
        terminal.append_output("⠋ thinking… 3s".as_bytes());
        let working = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("working status event");
        assert_eq!(working["data"]["agent_status"], "working");

        // Immediately (inside the throttle window) print the blocked dialog:
        // the real `jcode permissions` viewer chrome (border title + the
        // `⏳ Agent is waiting for this decision` line + help row), as the
        // user would see when jcode queues an ambient permission request.
        // append_output is throttled, so this only sets the pending flag; the
        // pane then goes silent. Without the sweeper, no event would ever
        // carry the blocked flip.
        terminal.append_output(
            "┌─ Permissions (1 pending) ──┐\n│ ⏳ Agent is waiting for this decision │\n└──────────┘\n a  approve    d  deny    A  approve all    D  deny all".as_bytes(),
        );

        // The sweeper ticks every 100ms and runs the pending check once the
        // 500ms window expires: the blocked event must arrive within a few
        // seconds without any further terminal output.
        let blocked = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("blocked status event recovered by sweeper");
        assert_eq!(blocked["event"], "pane.agent_status_changed");
        assert_eq!(blocked["data"]["agent"], "jcode");
        assert_eq!(blocked["data"]["agent_status"], "blocked");
    }

    /// Restores one env var on drop, even when the test panics mid-run
    /// (asserts keep `JCODE_HOME` from leaking into sibling tests, which
    /// spawn panes in the same process and would hit the isolated home).
    struct RestoreEnvVar {
        key: &'static str,
        value: Option<std::ffi::OsString>,
    }

    /// Removes the live e2e scratch tree on drop, panic-safe. Each run
    /// boots a real jcode whose isolated home accumulates session logs,
    /// transcripts, and setup state (~100KB per run); without cleanup every
    /// test run leaves that behind in the system temp dir. Retries for up
    /// to 5s because the pane child is killed but not waited on drop, and
    /// jcode's session threads can re-create dirs (`ambient/transcripts`)
    /// well past 1s on a loaded machine (observed during parallel stress
    /// runs; a 1s window leaked one dir).
    struct RemoveTempDir(PathBuf);

    impl Drop for RemoveTempDir {
        fn drop(&mut self) {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                if std::fs::remove_dir_all(&self.0).is_ok() || !self.0.exists() {
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    impl Drop for RestoreEnvVar {
        fn drop(&mut self) {
            match self.value.take() {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    fn restore_env_var(key: &'static str) -> RestoreEnvVar {
        RestoreEnvVar {
            key,
            value: std::env::var_os(key),
        }
    }

    /// Real jcode binary for live e2e tests, when a build exists. Checks
    /// the known build locations in order; `None` skips the caller silently
    /// so CI without jcode stays green. The variant argument is kept for a
    /// future info_fields build path ("vanilla" is the only one resolved
    /// today: the worktree build shares one target dir with other
    /// branches, so a per-branch binary is not addressable right now).
    ///
    /// TEMPORARY divergence note: the fallback path
    /// (`~/.jcode/builds/current/jcode`) is whatever build the developer
    /// last promoted, not necessarily upstream master. Both formats
    /// currently render the same bottom chrome (`N> ` prompt + context
    /// bar), so the vanilla assertions hold either way; verified live
    /// 2026-10-11 against the promoted fork build v0.94.19-dev (full e2e
    /// incl. flip + refusal gates green with the primary binary moved
    /// aside). If the fork format drifts, gate the fallback out and
    /// resolve the variant from the binary path instead.
    fn live_jcode_binary(_variant: &str) -> Option<String> {
        let home = std::env::var("HOME").ok()?;
        let candidates = [
            // Upstream master debug build in the main checkout.
            format!("{home}/Documents/projects/jcode/target/debug/jcode"),
            // Promoted build (usually the merged fork).
            format!("{home}/.jcode/builds/current/jcode"),
        ];
        candidates
            .into_iter()
            .find(|path| std::path::Path::new(path).is_file())
    }

    #[test]
    fn live_jcode_tui_detection_end_to_end() {
        // REAL acceptance path: spawn the actual jcode binary (vanilla
        // master build) in a real PTY, let its TUI render, and require the
        // detector to publish jcode agent events. Skipped when no jcode
        // build exists so CI stays green; the skip prints one line so a
        // machine that never runs the real path is visible in --nocapture
        // output instead of silently passing.
        let Some(jcode) = live_jcode_binary("vanilla") else {
            eprintln!("live_jcode_tui_detection_end_to_end: no jcode build, skipping");
            return;
        };
        let _guard = crate::tests::lock_env();
        let temp = std::env::temp_dir().join(format!("herdr-jcode-e2e-{}", std::process::id()));
        std::fs::create_dir_all(&temp).unwrap();
        let _remove_temp = RemoveTempDir(temp.clone());
        // Isolated jcode home: no real sessions, no telemetry, no menubar.
        // The restore guards put the real environment back on drop, even if
        // an assert below panics, so sibling tests (same process) keep
        // spawning their panes with the developer's real env.
        let home = temp.join("jcode-home");
        std::fs::create_dir_all(&home).unwrap();
        let _restore_home = restore_env_var("JCODE_HOME");
        // The promoted jcode build binds its daemon socket under its own
        // runtime dir (observed ~/.jcode/scratch/jcode.sock on this build,
        // NOT relocated by JCODE_HOME isolation). A live jcode server from
        // another session can own that path, the spawned TUI then times out
        // waiting for the socket and exits rc=1, and the detector
        // correctly reports done, failing the "clean boot" assert. JCODE_SOCKET
        // (jcode-app-core server/socket.rs: socket_path() checks it first)
        // relocates the daemon socket into the test's temp dir so the
        // spawned jcode owns its own, uncontended socket.
        let _restore_socket = restore_env_var("JCODE_SOCKET");
        let _restore_selfdev = restore_env_var("JCODE_NO_SELFDEV");
        let _restore_menubar = restore_env_var("JCODE_NO_MENUBAR");
        let _restore_telemetry = restore_env_var("JCODE_NO_TELEMETRY");
        std::env::set_var("JCODE_HOME", &home);
        std::env::set_var("JCODE_SOCKET", temp.join("jcode-e2e.sock"));
        // The isolated home has no provider profiles, but a jcode-launched
        // test process (this very binary can run under jcode) exports
        // JCODE_PROVIDER_PROFILE_NAME / JCODE_PROVIDER_PROFILE_ACTIVE; the
        // spawned jcode server then fails "Unknown provider profile" and the
        // TUI dies waiting for the socket. Scrub the profile vars so the
        // fresh home boots with its own defaults.
        let _restore_profile_name = restore_env_var("JCODE_PROVIDER_PROFILE_NAME");
        let _restore_profile_active = restore_env_var("JCODE_PROVIDER_PROFILE_ACTIVE");
        let _restore_provider = restore_env_var("JCODE_PROVIDER");
        std::env::remove_var("JCODE_PROVIDER_PROFILE_NAME");
        std::env::remove_var("JCODE_PROVIDER_PROFILE_ACTIVE");
        std::env::remove_var("JCODE_PROVIDER");
        // The scrubbed home has no provider config at all, so any submitted
        // turn immediately fails auth and jcode reports `blocked` (observed:
        // the working flip fires, then a single status event `blocked`, no
        // return to idle). The e2e loop needs a real working->idle cycle,
        // which needs a working provider. Seed the developer's real
        // config.toml (auth + provider profiles) into the temp home; API
        // keys still come from the inherited env, and session storage under
        // the temp home stays isolated from the real one.
        let real_config = default_home_dir()
            .map(|h| format!("{h}/.jcode/config.toml"))
            .filter(|p| std::path::Path::new(p).exists());
        if let Some(real_config) = real_config {
            let _ = std::fs::copy(&real_config, home.join("config.toml"));
        }
        std::env::set_var("JCODE_NO_SELFDEV", "1");
        std::env::set_var("JCODE_NO_MENUBAR", "1");
        std::env::set_var("JCODE_NO_TELEMETRY", "1");
        // Skip first-run onboarding ("Welcome to jcode" picker): a fresh
        // home looks like a brand-new install (is_new_user_install in
        // jcode's onboarding_flow_control.rs: launch_count <= 5 and < 10
        // native sessions) and the welcome screen never shows the "1> "
        // prompt, so the test could never observe an idle state. Seeding
        // launch_count > 5 marks the install as established and boots the
        // real prompt screen directly.
        std::fs::write(home.join("setup_hints.json"), "{\"launch_count\":9}").unwrap();

        let state =
            BuiltinState::new(temp.clone(), Some(jcode), JcodeDetectionVariant::Vanilla).unwrap();
        // Subscribe BEFORE the pane exists: jcode writes "Connecting to
        // server..." the moment the PTY spawns, and the first detection run
        // (argv label, no screen markers yet → "unknown") fires on those
        // bytes. A subscriber attached after that misses the transition and
        // sees only silence, because later runs detect the same
        // (jcode, unknown) state and skip publishing.
        let rx = state.subscribe_events();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let terminal = {
            let data = state.data.lock().unwrap();
            let pane = data.panes.values().next().unwrap();
            data.terminals.get(&pane.terminal_id).unwrap().clone()
        };

        // The real TUI boots, renders its input prompt, then idles. Wait
        // for the first jcode status event (label + status from the real
        // screen scrape of real render output). A clean boot must never
        // report blocked or done: seeing either would mean a fabricated
        // pattern fires against real output.
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut saw_jcode_event = false;
        let mut saw_idle = false;
        loop {
            let timeout = deadline.saturating_duration_since(std::time::Instant::now());
            if timeout.is_zero() {
                break;
            }
            match rx.recv_timeout(timeout) {
                Ok(event) => {
                    if event["event"] == "pane.agent_status_changed"
                        && event["data"]["agent"].as_str() == Some("jcode")
                    {
                        saw_jcode_event = true;
                        let status = event["data"]["agent_status"].as_str().unwrap_or("");
                        assert!(
                            status != "blocked" && status != "done",
                            "clean jcode boot reported {status:?}; no permission dialog or agent exit exists at this point"
                        );
                        // A fresh boot lands on idle (prompt visible) or
                        // working (spinner while loading); both prove the
                        // detector reads the real chrome.
                        if status == "idle" || status == "working" {
                            saw_idle = true;
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        assert!(
            saw_jcode_event,
            "real jcode TUI must be detected by agent label (argv/process path)"
        );
        assert!(
            saw_idle,
            "real jcode TUI must reach idle or working status via screen scrape"
        );

        // Real working→idle flip through the real composer API
        // (agent.prompt): paste+Enter with the 300ms gap outside jcode's
        // 150ms paste-guard window, then the detector must publish working
        // (spinner status line `⠋ sending…`) and, after the turn ends or a
        // single Ctrl+C, idle again (numbered prompt restored). This closes
        // the loop between the request route the phone UI hits and the
        // output-driven detector (throttle, trailing sweeper, publish)
        // against real render bytes, not a hand-rolled PTY write.
        if saw_idle {
            let pane_id = {
                let data = state.data.lock().unwrap();
                data.panes.keys().next().unwrap().clone()
            };
            let response = state.handle_request(
                "seed",
                "agent.prompt",
                json!({
                    "pane_id": pane_id,
                    "text": "count from 1 to 60, one number per line, nothing else",
                }),
            );
            assert!(
                response.get("error").is_none(),
                "agent.prompt must be accepted on a live idle jcode pane: {response}"
            );
            let flip_deadline = std::time::Instant::now() + Duration::from_secs(60);
            let mut saw_working = false;
            let mut returned_to_idle = false;
            loop {
                let timeout = flip_deadline.saturating_duration_since(std::time::Instant::now());
                if timeout.is_zero() {
                    break;
                }
                match rx.recv_timeout(timeout) {
                    Ok(event)
                        if event["event"] == "pane.agent_status_changed"
                            && event["data"]["agent"].as_str() == Some("jcode") =>
                    {
                        let status = event["data"]["agent_status"].as_str().unwrap_or("");
                        match status {
                            "working" if !saw_working => {
                                saw_working = true;
                                // Interrupt: Ctrl+C cancels the running turn
                                // (app/input.rs: cancel_requested = true). A
                                // turn that finishes first just returns to
                                // idle; do not press Ctrl+C again after the
                                // prompt is back, a second press quits jcode.
                                let _ = terminal.write_input(b"\x03");
                            }
                            "idle" if saw_working => {
                                returned_to_idle = true;
                                break;
                            }
                            _ => {}
                        }
                    }
                    Err(_) => break,
                    Ok(_) => {}
                }
            }
            assert!(
                saw_working,
                "a submitted prompt must flip the pane to working (spinner status line)"
            );
            assert!(
                returned_to_idle,
                "after the turn ends or Ctrl+C, the pane must return to idle (numbered prompt restored)"
            );

            // Refusal paths on the same live pane: a prompt for an unknown
            // pane id must route to agent_not_found, and once the child is
            // reaped the pane's own id must flip to agent_exited. These pin
            // the composer-side gates (route lookup, runtime exited check)
            // against the same live state the flip used.
            let missing = state.handle_request(
                "seed",
                "agent.prompt",
                json!({ "pane_id": "pane-nope", "text": "hi" }),
            );
            assert!(
                missing["error"]["message"]
                    .as_str()
                    .unwrap_or("")
                    .starts_with("agent_not_found:"),
                "unknown pane must refuse with agent_not_found: {missing}"
            );
            terminal.kill_and_wait();
            let gone = state.handle_request(
                "seed",
                "agent.prompt",
                json!({ "pane_id": pane_id, "text": "hi" }),
            );
            assert!(
                gone["error"]["message"]
                    .as_str()
                    .unwrap_or("")
                    .starts_with("agent_exited:"),
                "prompt on a dead pane must refuse with agent_exited: {gone}"
            );
        } else {
            terminal.kill_and_wait();
        }

        // The pane child is already reaped above (kill_and_wait in both
        // branches); Drop only kills without waiting, and jcode's session
        // threads can re-create dirs under the scratch home for a while
        // after the kill, which raced the removal and leaked a dir on a
        // loaded machine.
        drop(terminal);
        // The `_remove_temp` guard removes the scratch tree (retrying past
        // the pane child's post-kill session writes).
    }

    #[test]
    fn sweeper_force_check_skips_exited_terminal() {
        // After the terminal exits, notify_exited already published the
        // final "done" status. The sweeper's force path must not re-run
        // detection on the dead terminal (stale screen text false
        // positives).
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some("/bin/cat".to_string()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let terminal = {
            let data = state.data.lock().unwrap();
            let pane = data.panes.values().next().unwrap();
            data.terminals.get(&pane.terminal_id).unwrap().clone()
        };
        terminal.exited.store(true, Ordering::Release);
        // Arm pending + a dirty throttle window: the force path must take
        // the exited early-return, leaving the throttle bookkeeping and
        // detection untouched.
        terminal.pending_status_check.store(true, Ordering::Release);
        terminal.publish_agent_status_if_changed_force();
        assert!(
            terminal.last_status_check.lock().unwrap().is_none(),
            "exited terminal must not consume the throttle window"
        );
        assert_eq!(
            state.handle_request("seed", "workspace.list", json!({}))["result"]["workspaces"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn composer_message_normalizes_line_ends() {
        // Trailing newlines are the composer's, not the text's; CRLF and
        // bare CR read as one newline. Mirrors upstream composerMessage.
        assert_eq!(composer_message("hello\n\n"), "hello");
        assert_eq!(composer_message("hello\r\n\r\n"), "hello");
        assert_eq!(composer_message("a\r\nb"), "a\nb");
        assert_eq!(composer_message("a\rb"), "a\nb");
        assert_eq!(composer_message("\n\nhello"), "\n\nhello");
    }

    #[test]
    fn bracketed_paste_payload_wraps_one_block() {
        // Newlines become CR INSIDE the paste markers: a multi-line message
        // stays one paste (one prompt) instead of one submit per line.
        assert_eq!(
            bracketed_paste_payload("hello"),
            "\u{1b}[200~hello\u{1b}[201~"
        );
        assert_eq!(
            bracketed_paste_payload("a\nb\nc"),
            "\u{1b}[200~a\rb\rc\u{1b}[201~"
        );
    }

    #[test]
    fn agent_prompt_types_message_then_enter() {
        // /bin/cat echoes its stdin back, so both the bracketed paste AND
        // the delayed Enter must appear in the scrollback. This pins the
        // whole server-side submit contract: refusal-free pane gets the
        // full payload, and the Enter follows after the gap even though
        // agent_prompt returns before it is sent.
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some("/bin/cat".to_string()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let pane_id = {
            let data = state.data.lock().unwrap();
            data.panes.keys().next().unwrap().clone()
        };

        let response = state.handle_request(
            "test",
            "agent.prompt",
            json!({ "pane_id": pane_id, "text": "hello from composer\nsecond line\n" }),
        );
        assert!(
            response.get("error").is_none(),
            "agent.prompt must succeed on a plain shell pane: {response}"
        );

        // cat echoes paste bytes immediately, the CR lands after the 300ms
        // gap; allow generous headroom for CI scheduling.
        std::thread::sleep(Duration::from_millis(AGENT_PROMPT_ENTER_GAP_MS + 700));
        let text = state.handle_request("t2", "pane.read", json!({ "pane_id": pane_id }));
        let text = text["result"]["read"]["text"].as_str().unwrap_or("");
        // pane.read strips ANSI, so the paste markers are gone from the
        // echo; the message body must have arrived in ONE piece (both
        // lines) and the delayed Enter as a trailing CR-derived newline.
        assert!(
            text.contains("hello from composer\nsecond line"),
            "paste payload missing from pane output: {text:?}"
        );
        assert!(
            text.contains("second line\n"),
            "delayed Enter missing from pane output: {text:?}"
        );
    }

    #[test]
    fn agent_prompt_refuses_on_fresh_dialog_despite_stale_cache() {
        // Regression pin for the CI flake (v0.4.57 release, run
        // 37157316762): the refusal gate used to read ONLY the cached
        // last_agent_state, which is flipped by the throttled status
        // detection (500ms window + 100ms sweeper). On a loaded runner the
        // sweeper thread can be starved for the whole poll window, so a
        // fresh permission dialog in the scrollback was never seen and
        // the submit was accepted. The gate now re-runs the detection
        // core synchronously at submit time, so a stale cache cannot
        // smuggle a paste past an open dialog. Simulate the starved
        // machine directly: dialog bytes are in the scrollback, the cache
        // still says working.
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some("/bin/cat".to_string()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let (pane_id, terminal) = {
            let data = state.data.lock().unwrap();
            let (pane_id, pane) = data.panes.iter().next().unwrap();
            let terminal = data.terminals.get(&pane.terminal_id).unwrap().clone();
            (pane_id.clone(), terminal)
        };
        // Stale cache: the sweeper has not run since the dialog landed.
        // Consume the 500ms throttle window with a warmup append first,
        // so the dialog append below is throttled (pending flag set, no
        // detection) exactly like a starved runner where the sweeper
        // never gets scheduled.
        terminal.append_output(b"warmup\n");
        {
            let mut previous = terminal.last_agent_state.lock().unwrap();
            *previous = Some((Some("claurst".to_string()), "working".to_string(), 0));
        }
        // Fresh screen: a Claurst permission dialog lands in the tail but
        // the detection is throttled out, so the cached status still says
        // working. On a loaded CI runner the same state arises because the
        // sweeper thread is starved for the whole poll window.
        terminal.append_output(b"Do you want to run this command?\nYes, allow once\nNo, deny\n");
        // Submit immediately, inside the throttle window, while the cache
        // is still stale.
        let response = state.handle_request(
            "test",
            "agent.prompt",
            json!({ "pane_id": pane_id, "text": "should be refused" }),
        );
        assert_eq!(
            response["error"]["message"],
            "agent_blocked: the agent is waiting for an answer in the terminal"
        );
        // And the fresh detection result must have been published: the
        // cache no longer says working.
        assert_eq!(
            terminal.last_agent_status().as_deref(),
            Some("blocked"),
            "submit-time detection must publish the blocked status"
        );
        // Nothing was typed: cat echoes stdin, so any leaked paste would
        // show in the scrollback within the Enter-gap window.
        std::thread::sleep(Duration::from_millis(AGENT_PROMPT_ENTER_GAP_MS + 300));
        let text = state.handle_request("t2", "pane.read", json!({ "pane_id": pane_id }));
        let text = text["result"]["read"]["text"].as_str().unwrap_or("");
        assert!(
            !text.contains("should be refused"),
            "refused message leaked into the pane: {text:?}"
        );
    }

    #[test]
    fn agent_prompt_refuses_when_blocked() {
        // A blocked pane must refuse BEFORE anything is typed: a message
        // typed into an open permission/question dialog would answer the
        // dialog. Seed a blocked status directly into last_agent_state.
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some("/bin/cat".to_string()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let (pane_id, terminal) = {
            let data = state.data.lock().unwrap();
            let (pane_id, pane) = data.panes.iter().next().unwrap();
            let terminal = data.terminals.get(&pane.terminal_id).unwrap().clone();
            (pane_id.clone(), terminal)
        };
        {
            let mut previous = terminal.last_agent_state.lock().unwrap();
            *previous = Some((Some("jcode".to_string()), "blocked".to_string(), 0));
        }

        let response = state.handle_request(
            "test",
            "agent.prompt",
            json!({ "pane_id": pane_id, "text": "should be refused" }),
        );
        assert_eq!(
            response["error"]["message"],
            "agent_blocked: the agent is waiting for an answer in the terminal"
        );

        // Nothing was typed: /bin/cat echoes stdin, so any leaked input
        // would show in the scrollback within the Enter-gap window.
        std::thread::sleep(Duration::from_millis(AGENT_PROMPT_ENTER_GAP_MS + 300));
        let text = state.handle_request("t2", "pane.read", json!({ "pane_id": pane_id }));
        let text = text["result"]["read"]["text"].as_str().unwrap_or("");
        assert!(
            !text.contains("should be refused"),
            "refused message leaked into the pane: {text:?}"
        );
    }

    #[test]
    fn agent_prompt_validates_input() {
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some("/bin/cat".to_string()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let pane_id = {
            let data = state.data.lock().unwrap();
            data.panes.keys().next().unwrap().clone()
        };

        // Empty message refused, herdr-compatible code.
        let response = state.handle_request(
            "t1",
            "agent.prompt",
            json!({ "pane_id": pane_id, "text": "  \n" }),
        );
        assert_eq!(
            response["error"]["message"],
            "empty_agent_prompt: agent prompt must not be empty"
        );

        // Over-cap message refused.
        let long = "x".repeat(MAX_COMPOSER_CHARS + 1);
        let response = state.handle_request(
            "t2",
            "agent.prompt",
            json!({ "pane_id": pane_id, "text": long }),
        );
        assert!(response["error"]["message"]
            .as_str()
            .unwrap_or("")
            .starts_with("message_too_long"));

        // Unknown pane refused with agent_not_found (herdr-compatible).
        let response = state.handle_request(
            "t3",
            "agent.prompt",
            json!({ "pane_id": "no-such-pane", "text": "hi" }),
        );
        assert!(response["error"]["message"]
            .as_str()
            .unwrap_or("")
            .starts_with("agent_not_found"));

        // `target` alias works like pane_id (external-herdr wire compat).
        let response = state.handle_request(
            "t4",
            "agent.prompt",
            json!({ "target": pane_id, "text": "via target" }),
        );
        assert_eq!(response["result"]["ok"], json!(true));
    }

    #[test]
    fn terminal_output_publishes_agent_status_changes() {
        // Use a silent program instead of a real shell: zsh can write its
        // prompt bytes at any moment (on a loaded CI runner the shell can
        // start slowly and emit the prompt AFTER the throttle reset below).
        // That write consumes the 500ms throttle window, so the synthetic
        // append_output is skipped and the expected event never fires. No
        // widening of recv_timeout can fix a publish that never happens.
        // /bin/cat blocks on stdin and never writes, so the only output the
        // throttle window can be consumed by is the synthetic bytes below.
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some("/bin/cat".to_string()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let rx = state.subscribe_events();
        let terminal = {
            let data = state.data.lock().unwrap();
            let pane = data.panes.values().next().unwrap();
            data.terminals.get(&pane.terminal_id).unwrap().clone()
        };

        // Defense in depth on top of the silent shell: reset the throttle so
        // the synthetic output is guaranteed to trigger the status-change
        // publish even if some earlier byte slipped through.
        terminal.reset_status_throttle();
        terminal.append_output("⠋ thinking… 3s".as_bytes());

        // Generous window: on a loaded CI runner the detection scan itself
        // (tail extraction + regex) can take a moment; 5s leaves room without
        // masking a real regression.
        let event = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("agent status event");
        assert_eq!(event["event"], "pane.agent_status_changed");
        assert_eq!(event["data"]["agent"], "jcode");
        assert_eq!(event["data"]["agent_status"], "working");
    }

    #[test]
    fn agent_list_reflects_agent_detected_after_output() {
        // Regression test for the stale-cache bug (v0.2.84–v0.2.87):
        // A shell pane starts with no agent. When the user launches jcode inside
        // the shell, the terminal output changes, but the cached
        // PaneAgentPresentation (which stored `None`) was never invalidated,
        // so agent.list kept returning an empty list.
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            // Use a silent program instead of an interactive shell: a real
            // zsh prints its prompt bytes into the scrollback after the
            // synthetic jcode output below, and those prompt lines become the
            // bottom of the detection tail. That makes the expected "idle"
            // status depend on the machine's prompt format (CI runners fail
            // with "unknown"). `/bin/cat` blocks on stdin and never writes, so
            // the detection tail contains exactly the synthetic bytes.
            Some("/bin/cat".to_string()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));

        // Before any agent output, the pane should have no agent.
        let agents_before = state.handle_request("seed", "agent.list", json!({}));
        assert!(
            agents_before["result"]["agents"]
                .as_array()
                .unwrap()
                .is_empty(),
            "expected no agents before output"
        );

        // Simulate jcode terminal output appearing in the pane.
        let terminal = {
            let data = state.data.lock().unwrap();
            let pane = data.panes.values().next().unwrap();
            data.terminals.get(&pane.terminal_id).unwrap().clone()
        };
        terminal.append_output("jcode\n1> ".as_bytes());
        // Give the reader thread time to process.
        std::thread::sleep(Duration::from_millis(200));

        // Now agent.list must reflect the detected jcode agent.
        let agents_after = state.handle_request("seed", "agent.list", json!({}));
        let list = agents_after["result"]["agents"].as_array().unwrap();
        assert_eq!(
            list.len(),
            1,
            "agent.list should show 1 agent after jcode output"
        );
        assert_eq!(list[0]["agent"], "jcode");
        assert_eq!(list[0]["agent_status"], "idle");
    }

    #[test]
    fn spinner_append_publishes_working_inline() {
        // Regression: the output path used to route its gate-passing check
        // through run_status_detection, which re-checked the throttle that
        // had just been refreshed, a second gate that always fails, so an
        // append that won the first gate never ran detection. During a real
        // jcode turn (spinner frames streaming for the whole turn) only the
        // 100ms sweeper could land a check, and only when its tick happened
        // to fall in the short window between throttle expiry and the next
        // gate-passing append. The live e2e flipped to working in ~1 run of
        // 6. The fix runs the detection core inline after the first gate,
        // so detection is guaranteed at most one throttle window behind the
        // output. This test pins the inline behavior: an append that passes
        // the throttle must update the status synchronously, before the
        // sweeper could ever intervene (it asserts immediately, within
        // microseconds of the append, so on the double-gate code the sweeper
        // cannot rescue the check).
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            // /bin/cat never writes, so the detection tail contains exactly
            // the synthetic bytes below.
            Some("/bin/cat".to_string()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let rx = state.subscribe_events();
        let terminal = {
            let data = state.data.lock().unwrap();
            let pane = data.panes.values().next().unwrap();
            data.terminals.get(&pane.terminal_id).unwrap().clone()
        };

        // Boot into a known idle state, mirroring the real captured chrome:
        // the numbered input row (`1> `, ASCII per input_prompt in
        // ui_input.rs; `›` is only the transcript echo) and the overscroll
        // status line whose context bar (`▱▱▱▱ 2%` on a fresh session,
        // `overscroll_context_bar`) is what the idle heuristic keys on.
        terminal
            .append_output("jcode\n1> ask anything\n~/…/proj  main ▱▱▱▱ 2% llmg-coding".as_bytes());
        let mut booted_idle = false;
        let boot_deadline = std::time::Instant::now() + Duration::from_secs(2);
        loop {
            let remaining = boot_deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining) {
                Ok(event)
                    if event["event"] == "pane.agent_status_changed"
                        && event["data"]["agent"].as_str() == Some("jcode")
                        && event["data"]["agent_status"].as_str() == Some("idle") =>
                {
                    booted_idle = true;
                    break;
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        assert!(booted_idle, "boot must reach idle (sweeper path)");

        // Force the throttle open so the next append passes the output
        // path's gate, then feed one real spinner status line (braille
        // glyph + label, as jcode renders it mid-turn). The status must flip
        // synchronously inside the append: on the double-gate code the
        // second gate failed and the status stayed "idle" until some later
        // sweeper tick (which this test never grants).
        terminal.reset_status_throttle();
        terminal.append_output("\u{1b}[1;1H\u{280b} sending…".as_bytes());
        assert_eq!(
            terminal.last_agent_status().as_deref(),
            Some("working"),
            "a throttle-passing append must run detection inline"
        );

        // The inline detection must also have published the event.
        let mut saw_working = false;
        while let Ok(event) = rx.try_recv() {
            if event["event"] == "pane.agent_status_changed"
                && event["data"]["agent"].as_str() == Some("jcode")
                && event["data"]["agent_status"].as_str() == Some("working")
            {
                saw_working = true;
            }
        }
        assert!(saw_working, "the working flip must publish an event");
    }

    #[test]
    fn stale_detection_pass_does_not_regress_committed_state() {
        // The sweeper force pass and the agent_prompt synchronous re-check
        // can run detection concurrently with the output path. Each pass
        // reserves a monotonic sequence before reading its tail; a pass
        // that commits after a newer pass (higher committed seq) is stale
        // and must drop its result, because committing an older tail
        // snapshot would briefly regress the published status. Here a
        // detection with a FUTURE sequence commits first (simulating a
        // newer pass that started later but finished first), and the
        // in-flight older pass must not overwrite it.
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some("/bin/cat".to_string()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        state.handle_request("seed", "workspace.create", json!({ "label": "Workspace" }));
        let terminal = {
            let data = state.data.lock().unwrap();
            let pane = data.panes.values().next().unwrap();
            data.terminals.get(&pane.terminal_id).unwrap().clone()
        };
        // Simulate the newer pass: it reserved a high sequence and
        // committed an idle jcode state, the way detect_and_publish would.
        // The counter is left untouched, so the next real detection pass
        // reserves a far lower sequence: exactly the stale-pass shape.
        {
            let mut previous = terminal.last_agent_state.lock().unwrap();
            *previous = Some((Some("jcode".to_string()), "idle".to_string(), 1000));
        }
        // The stale pass: screen text says working, but its sequence is
        // lower than the committed one, so the result must be dropped.
        terminal.append_output("jcode\n⠋ sending…".as_bytes());
        terminal.reset_status_throttle();
        terminal.publish_agent_status_if_changed_force();
        let status = terminal.last_agent_status();
        assert_eq!(
            status.as_deref(),
            Some("idle"),
            "a stale detection pass must not regress the newer committed state"
        );
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
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let (tx, rx) = mpsc::channel();
        terminal.subscribe(TerminalSubscriber {
            tx,
            pending_bytes: Arc::new(AtomicUsize::new(0)),
        });

        let mut saw_exit = false;
        for _ in 0..8 {
            match rx.recv_timeout(Duration::from_secs(1)).unwrap() {
                TerminalSubscriberMessage::Output(_) => {}
                TerminalSubscriberMessage::Replay(..) => {}
                TerminalSubscriberMessage::Overflow => {}
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
    fn strongest_agent_status_handles_done() {
        // Done is stronger than unknown and idle, weaker than working and blocked.
        assert_eq!(strongest_agent_status(["done"]), "done");
        assert_eq!(strongest_agent_status(["unknown", "done"]), "done");
        assert_eq!(strongest_agent_status(["idle", "done"]), "done");
        assert_eq!(strongest_agent_status(["done", "working"]), "working");
        assert_eq!(strongest_agent_status(["done", "blocked"]), "blocked");
        // Done does not override working once working is already set.
        assert_eq!(strongest_agent_status(["working", "done"]), "working");
    }

    #[test]
    fn pane_agent_presentation_reports_done_after_exit() {
        let hub = BuiltinEventHub::new();
        let context = PaneEventContext {
            workspace_id: "ws_done".to_string(),
            tab_id: "tab_done".to_string(),
            pane_id: "pane_done".to_string(),
            terminal_id: "term_done".to_string(),
        };
        // Spawn a shell that exits quickly. We set the pane argv to "jcode" so
        // detect_agent_label identifies it as jcode. This avoids requiring the
        // jcode binary to be installed on the CI runner.
        let terminal = TerminalRuntime::spawn(
            "term_done".to_string(),
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
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();

        // Wait for exit.
        let (tx, rx) = mpsc::channel();
        terminal.subscribe(TerminalSubscriber {
            tx,
            pending_bytes: Arc::new(AtomicUsize::new(0)),
        });
        let mut saw_exit = false;
        for _ in 0..8 {
            match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                TerminalSubscriberMessage::Output(_) => {}
                TerminalSubscriberMessage::Replay(..) => {}
                TerminalSubscriberMessage::Overflow => {}
                TerminalSubscriberMessage::Exited => {
                    saw_exit = true;
                    break;
                }
            }
        }
        assert!(saw_exit);

        // Verify pane_agent_presentation reports "done" for the exited terminal.
        // The pane argv is set to "jcode" so detect_agent_label identifies the
        // agent even though the actual process was /bin/sh.
        let data = BuiltinData {
            workspaces: HashMap::new(),
            tabs: HashMap::new(),
            panes: HashMap::from([(
                "pane_done".to_string(),
                PaneRecord {
                    pane_id: "pane_done".to_string(),
                    terminal_id: "term_done".to_string(),
                    workspace_id: "ws_done".to_string(),
                    tab_id: "tab_done".to_string(),
                    cwd: std::env::current_dir().unwrap(),
                    label: Some("jcode".to_string()),
                    argv: vec!["jcode".to_string(), "--version".to_string()],
                },
            )]),
            terminals: HashMap::from([("term_done".to_string(), terminal)]),
            focused_workspace_id: None,
            focused_tab_id: None,
            focused_pane_id: None,
            next_id: 0,
        };
        let pane = data.panes.get("pane_done").unwrap();
        let presentation = pane_agent_presentation(pane, &data);
        assert_eq!(presentation.agent, Some("jcode"));
        assert_eq!(presentation.status, "done");
    }

    #[test]
    fn agent_exit_record_lifecycle_is_deterministic() {
        // Pure state-machine test for update_agent_exit_record, no live ps.
        let hub = BuiltinEventHub::new();
        let context = PaneEventContext {
            workspace_id: "ws_rec".to_string(),
            tab_id: "tab_rec".to_string(),
            pane_id: "pane_rec".to_string(),
            terminal_id: "term_rec".to_string(),
        };
        let terminal = TerminalRuntime::spawn(
            "term_rec".to_string(),
            std::env::current_dir().unwrap(),
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "sleep 30".to_string(),
            ],
            24,
            80,
            hub,
            context,
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();

        // Initially no exit record and nothing armed.
        assert!(!terminal.recent_agent_exit_active());
        assert_eq!(
            terminal.last_live_process_agent.lock().unwrap().take(),
            None
        );

        // Empty reads without a previously-live agent never arm the record:
        // a plain shell pane must never fabricate an agent exit.
        terminal.update_agent_exit_record(None, true);
        assert!(!terminal.recent_agent_exit_active());

        // Failed probe is a no-op even after a live agent was seen.
        terminal.update_agent_exit_record(Some("jcode"), true);
        assert!(!terminal.recent_agent_exit_active());
        assert_eq!(
            *terminal.last_live_process_agent.lock().unwrap(),
            Some("jcode")
        );
        terminal.update_agent_exit_record(None, false);
        assert!(!terminal.recent_agent_exit_active());
        assert_eq!(
            *terminal.last_live_process_agent.lock().unwrap(),
            Some("jcode")
        );

        // Successful empty read after a live agent sets the record exactly once.
        terminal.update_agent_exit_record(None, true);
        assert!(terminal.recent_agent_exit_active());
        let record = terminal
            .recent_agent_process_exit
            .lock()
            .unwrap()
            .expect("exit record must be set");
        assert_eq!(record.agent, "jcode");
        // Second empty read must not re-set (already disarmed).
        terminal.update_agent_exit_record(None, true);
        assert!(terminal.recent_agent_exit_active());
        assert_eq!(
            *terminal.last_live_process_agent.lock().unwrap(),
            None,
            "second empty read must not re-arm"
        );

        // Live re-detection clears the record.
        terminal.update_agent_exit_record(Some("jcode"), true);
        assert!(!terminal.recent_agent_exit_active());
        assert_eq!(
            *terminal.last_live_process_agent.lock().unwrap(),
            Some("jcode")
        );

        // A fresh live→absent transition records the exit again: the cycle
        // repeats deterministically once another agent run happens.
        terminal.update_agent_exit_record(None, true);
        assert!(terminal.recent_agent_exit_active());
        let record = terminal
            .recent_agent_process_exit
            .lock()
            .unwrap()
            .expect("exit record must be set again");
        assert_eq!(record.agent, "jcode");
    }

    #[test]
    fn pane_agent_presentation_suppresses_agent_after_process_exit() {
        // jcode exited inside the shell pane: screen text still shows its
        // banner and idle marker, but the exit record must suppress the
        // ghost agent from pane_agent_presentation (and thus agent.list).
        let hub = BuiltinEventHub::new();
        let context = PaneEventContext {
            workspace_id: "ws_ghost".to_string(),
            tab_id: "tab_ghost".to_string(),
            pane_id: "pane_ghost".to_string(),
            terminal_id: "term_ghost".to_string(),
        };
        let terminal = TerminalRuntime::spawn(
            "term_ghost".to_string(),
            std::env::current_dir().unwrap(),
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "sleep 30".to_string(),
            ],
            24,
            80,
            hub,
            context,
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        // Stale screen text that would otherwise detect jcode + idle.
        terminal.append_output(b"jcode\n1> \n");
        // Simulate the live→absent transition: jcode was live, then gone.
        terminal.update_agent_exit_record(Some("jcode"), true);
        terminal.update_agent_exit_record(None, true);
        assert!(terminal.recent_agent_exit_active());

        let data = BuiltinData {
            // agent_list_json walks workspaces → tabs → panes, so the pane
            // must be linked from a tab and workspace to appear in the list.
            workspaces: HashMap::from([(
                "ws_ghost".to_string(),
                WorkspaceRecord {
                    workspace_id: "ws_ghost".to_string(),
                    label: "Ghost".to_string(),
                    cwd: std::env::current_dir().unwrap(),
                    tab_ids: vec!["tab_ghost".to_string()],
                },
            )]),
            tabs: HashMap::from([(
                "tab_ghost".to_string(),
                TabRecord {
                    tab_id: "tab_ghost".to_string(),
                    workspace_id: "ws_ghost".to_string(),
                    label: "Ghost".to_string(),
                    pane_ids: vec!["pane_ghost".to_string()],
                },
            )]),
            panes: HashMap::from([(
                "pane_ghost".to_string(),
                PaneRecord {
                    pane_id: "pane_ghost".to_string(),
                    terminal_id: "term_ghost".to_string(),
                    workspace_id: "ws_ghost".to_string(),
                    tab_id: "tab_ghost".to_string(),
                    cwd: std::env::current_dir().unwrap(),
                    label: None,
                    argv: vec!["/bin/zsh".to_string()],
                },
            )]),
            terminals: HashMap::from([("term_ghost".to_string(), terminal.clone())]),
            focused_workspace_id: None,
            focused_tab_id: None,
            focused_pane_id: None,
            next_id: 0,
        };
        let pane = data.panes.get("pane_ghost").unwrap();
        let presentation = pane_agent_presentation(pane, &data);
        assert_eq!(
            presentation.agent, None,
            "exited agent must be suppressed even with stale jcode screen text"
        );
        assert_eq!(presentation.status, "unknown");

        // agent.list must not include the pane: no label and no agent.
        assert!(agent_list_json(&data).is_empty());

        // Live re-detection clears the record and the agent re-appears.
        terminal.update_agent_exit_record(Some("jcode"), true);
        let presentation = pane_agent_presentation(pane, &data);
        assert_eq!(presentation.agent, Some("jcode"));
        assert!(!agent_list_json(&data).is_empty());
    }

    #[test]
    fn pane_agent_presentation_suppresses_done_after_terminal_exit_with_record() {
        // The pane's shell itself exits while an agent exit record is active:
        // notify_exited must not publish a final "done" for the suppressed
        // agent, and the exited-terminal presentation branch must report no
        // agent.
        let hub = BuiltinEventHub::new();
        let context = PaneEventContext {
            workspace_id: "ws_gd".to_string(),
            tab_id: "tab_gd".to_string(),
            pane_id: "pane_gd".to_string(),
            terminal_id: "term_gd".to_string(),
        };
        let events = hub.subscribe();
        let terminal = TerminalRuntime::spawn(
            "term_gd".to_string(),
            std::env::current_dir().unwrap(),
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "printf 'jcode' && sleep 0.1".to_string(),
            ],
            24,
            80,
            hub,
            context,
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        // jcode was live, then exited inside the shell before the shell quit.
        terminal.update_agent_exit_record(Some("jcode"), true);
        terminal.update_agent_exit_record(None, true);

        // Wait for the reader thread to see the shell exit.
        let (tx, rx) = mpsc::channel();
        terminal.subscribe(TerminalSubscriber {
            tx,
            pending_bytes: Arc::new(AtomicUsize::new(0)),
        });
        let mut saw_exit = false;
        for _ in 0..16 {
            match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
                TerminalSubscriberMessage::Output(_) => {}
                TerminalSubscriberMessage::Replay(..) => {}
                TerminalSubscriberMessage::Overflow => {}
                TerminalSubscriberMessage::Exited => {
                    saw_exit = true;
                    break;
                }
            }
        }
        assert!(saw_exit);

        // notify_exited must not have published a "done" agent_status_changed
        // event for the suppressed agent. Drain events and verify.
        let mut saw_agent_done = false;
        while let Ok(event) = events.try_recv() {
            if event["event"] == "pane.agent_status_changed"
                && !event["data"]["agent"].is_null()
                && event["data"]["agent_status"] == "done"
            {
                saw_agent_done = true;
            }
        }
        assert!(
            !saw_agent_done,
            "suppressed agent must not get a final done publish"
        );

        // Presentation after terminal exit: no agent, unknown status.
        let data = BuiltinData {
            workspaces: HashMap::new(),
            tabs: HashMap::new(),
            panes: HashMap::from([(
                "pane_gd".to_string(),
                PaneRecord {
                    pane_id: "pane_gd".to_string(),
                    terminal_id: "term_gd".to_string(),
                    workspace_id: "ws_gd".to_string(),
                    tab_id: "tab_gd".to_string(),
                    cwd: std::env::current_dir().unwrap(),
                    label: None,
                    argv: vec!["/bin/zsh".to_string()],
                },
            )]),
            terminals: HashMap::from([("term_gd".to_string(), terminal)]),
            focused_workspace_id: None,
            focused_tab_id: None,
            focused_pane_id: None,
            next_id: 0,
        };
        let pane = data.panes.get("pane_gd").unwrap();
        let presentation = pane_agent_presentation(pane, &data);
        assert_eq!(presentation.agent, None);
        assert_eq!(presentation.status, "unknown");
    }

    #[test]
    fn pane_agent_presentation_serves_cached_state_and_falls_back() {
        // Poll path: once the output-driven detector has committed a state,
        // pane_agent_presentation must serve it without re-reading the tail
        // or forking ps (the 500ms-throttled detector keeps it fresh on
        // every append). Before any detector run, and after exit cleared
        // the cache, the full-detection fallback and the exited branch
        // apply respectively.
        let hub = BuiltinEventHub::new();
        let context = PaneEventContext {
            workspace_id: "ws_cache".to_string(),
            tab_id: "tab_cache".to_string(),
            pane_id: "pane_cache".to_string(),
            terminal_id: "term_cache".to_string(),
        };
        let terminal = TerminalRuntime::spawn(
            "term_cache".to_string(),
            std::env::current_dir().unwrap(),
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "sleep 30".to_string(),
            ],
            24,
            80,
            hub,
            context,
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();

        let data = BuiltinData {
            workspaces: HashMap::new(),
            tabs: HashMap::new(),
            panes: HashMap::from([(
                "pane_cache".to_string(),
                PaneRecord {
                    pane_id: "pane_cache".to_string(),
                    terminal_id: "term_cache".to_string(),
                    workspace_id: "ws_cache".to_string(),
                    tab_id: "tab_cache".to_string(),
                    cwd: std::env::current_dir().unwrap(),
                    label: None,
                    argv: vec!["/bin/zsh".to_string()],
                },
            )]),
            terminals: HashMap::from([("term_cache".to_string(), terminal.clone())]),
            focused_workspace_id: None,
            focused_tab_id: None,
            focused_pane_id: None,
            next_id: 0,
        };
        let pane = data.panes.get("pane_cache").unwrap();

        // No detector run yet: full-detection fallback runs (plain shell,
        // no agent text anywhere) and reports unknown.
        let presentation = pane_agent_presentation(pane, &data);
        assert_eq!(presentation.agent, None);
        assert_eq!(presentation.status, "unknown");

        // Detector commits a state: subsequent polls serve it verbatim,
        // even if the tail would now scrape differently (the detector
        // invalidates by output, not by reads).
        {
            let mut previous = terminal.last_agent_state.lock().unwrap();
            *previous = Some((Some("jcode".to_string()), "blocked".to_string(), 1));
        }
        let presentation = pane_agent_presentation(pane, &data);
        assert_eq!(presentation.agent, Some("jcode"));
        assert_eq!(presentation.status, "blocked");

        // The cached status flows through the aggregates the same way.
        let statuses =
            strongest_agent_status(std::iter::once(pane_agent_presentation(pane, &data).status));
        assert_eq!(statuses, "blocked");

        // An unknown cached agent label (state written by hand) must degrade
        // to None rather than a made-up label.
        {
            let mut previous = terminal.last_agent_state.lock().unwrap();
            *previous = Some((Some("not-an-agent".to_string()), "idle".to_string(), 2));
        }
        let presentation = pane_agent_presentation(pane, &data);
        assert_eq!(presentation.agent, None);
        assert_eq!(presentation.status, "idle");
    }

    #[test]
    fn agent_status_publishes_null_agent_after_exit_record() {
        // Some→None agent transition must emit a single null-agent event so
        // the frontend drops the row, without spamming for plain shell panes.
        let hub = BuiltinEventHub::new();
        let context = PaneEventContext {
            workspace_id: "ws_null".to_string(),
            tab_id: "tab_null".to_string(),
            pane_id: "pane_null".to_string(),
            terminal_id: "term_null".to_string(),
        };
        let events = hub.subscribe();
        let terminal = TerminalRuntime::spawn(
            "term_null".to_string(),
            std::env::current_dir().unwrap(),
            vec![
                "/bin/sh".to_string(),
                "-c".to_string(),
                "sleep 30".to_string(),
            ],
            24,
            80,
            hub,
            context,
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();

        // Seed last_agent_state with a live jcode detection via screen text.
        terminal.append_output(b"jcode\n1> \n");
        // The plain publish is double-throttled (outer gate arms the
        // window, inner gate re-checks it and defers to the sweeper), so
        // use the force entry point to run detection synchronously here;
        // under full-suite parallel load the sweeper can starve past the
        // 1s recv window and flake the test.
        terminal.reset_status_throttle();
        terminal.publish_agent_status_if_changed_force();
        let event = events.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event["event"], "pane.agent_status_changed");
        assert_eq!(event["data"]["agent"], "jcode");

        // jcode exits inside the shell: the exit record arms.
        terminal.update_agent_exit_record(Some("jcode"), true);
        terminal.update_agent_exit_record(None, true);

        // Next detection run must publish a null-agent transition event.
        terminal.reset_status_throttle();
        terminal.publish_agent_status_if_changed_force();
        let event = events.recv_timeout(Duration::from_secs(1)).unwrap();
        assert_eq!(event["event"], "pane.agent_status_changed");
        assert_eq!(
            event["data"]["agent"],
            Value::Null,
            "agent must be null in the transition event"
        );

        // Further runs with no agent must not spam: same state, no publish.
        terminal.reset_status_throttle();
        terminal.publish_agent_status_if_changed_force();
        assert!(
            events.try_recv().is_err(),
            "no further events expected for unchanged None state"
        );
    }

    #[test]
    fn osc9_tracker_captures_jcode_progress_payload() {
        let mut tracker = Osc9Tracker::default();
        // jcode emits: ESC ] 9 ; jcode:working BEL
        tracker.observe(b"\x1b]9;jcode:working\x07");
        assert_eq!(tracker.latest_progress(), "jcode:working");

        tracker.observe(b"\x1b]9;jcode:idle\x07");
        assert_eq!(tracker.latest_progress(), "jcode:idle");

        tracker.observe(b"\x1b]9;jcode:blocked\x07");
        assert_eq!(tracker.latest_progress(), "jcode:blocked");
    }

    #[test]
    fn osc9_tracker_handles_split_sequence() {
        let mut tracker = Osc9Tracker::default();
        tracker.observe(b"\x1b]9;jcode:work");
        assert_eq!(tracker.latest_progress(), "");
        tracker.observe(b"ing\x07");
        assert_eq!(tracker.latest_progress(), "jcode:working");
    }

    #[test]
    fn osc9_tracker_ignores_non_osc9_commands() {
        let mut tracker = Osc9Tracker::default();
        // OSC 0 (title) should not be captured as progress but as title
        tracker.observe(b"\x1b]0;some title\x07");
        assert_eq!(tracker.latest_progress(), "");
        assert_eq!(tracker.latest_title(), "some title");
        // OSC 52 (clipboard) should not be captured
        tracker.observe(b"\x1b]52;c;aGVsbG8=\x07");
        assert_eq!(tracker.latest_progress(), "");
        assert_eq!(tracker.latest_title(), "some title");
    }

    #[test]
    fn osc9_tracker_ignores_oversized_payload() {
        let mut tracker = Osc9Tracker::default();
        let mut oversized = Vec::from(b"\x1b]9;".as_slice());
        oversized.extend(std::iter::repeat_n(b'x', 5000));
        oversized.push(0x07);
        tracker.observe(&oversized);
        assert_eq!(tracker.latest_progress(), "");
        // Recovers after oversized payload
        tracker.observe(b"\x1b]9;jcode:working\x07");
        assert_eq!(tracker.latest_progress(), "jcode:working");
    }

    #[test]
    fn osc9_tracker_extracts_agent_label_from_payload() {
        let mut tracker = Osc9Tracker::default();
        // No payload yet → no agent label
        assert_eq!(tracker.latest_agent_label(), None);

        tracker.observe(b"\x1b]9;jcode:working\x07");
        assert_eq!(tracker.latest_agent_label(), Some("jcode"));

        tracker.observe(b"\x1b]9;jcode:idle\x07");
        assert_eq!(tracker.latest_agent_label(), Some("jcode"));

        tracker.observe(b"\x1b]9;jcode:blocked\x07");
        assert_eq!(tracker.latest_agent_label(), Some("jcode"));
    }

    #[test]
    fn osc9_tracker_agent_label_none_for_unknown_prefix() {
        let mut tracker = Osc9Tracker::default();
        // Unknown agent prefix → no label (falls back to other detection)
        tracker.observe(b"\x1b]9;unknownagent:working\x07");
        assert_eq!(tracker.latest_agent_label(), None);
        // Non-colon payloads → no label
        tracker.observe(b"\x1b]9;4;0\x07");
        assert_eq!(tracker.latest_agent_label(), None);
    }

    #[test]
    fn osc9_tracker_retains_payload_without_ttl() {
        // Agents on this channel emit on state change only, so a payload must
        // remain authoritative for the whole pane lifetime (matching upstream
        // herdr's no-TTL retention). There is no freshness window: a long
        // turn keeps reporting `jcode:working` and long idle keeps
        // reporting `jcode:idle`.
        let mut tracker = Osc9Tracker::default();
        tracker.observe(b"\x1b]9;jcode:working\x07");
        assert_eq!(tracker.latest_progress(), "jcode:working");
        // A different OSC payload replaces it.
        tracker.observe(b"\x1b]9;jcode:idle\x07");
        assert_eq!(tracker.latest_progress(), "jcode:idle");
        // Only `reset()` (terminal exit / agent gone) clears it.
        tracker.reset();
        assert_eq!(tracker.latest_progress(), "");
    }

    #[test]
    fn osc9_tracker_reset_clears_all_state() {
        let mut tracker = Osc9Tracker::default();
        tracker.observe(b"\x1b]9;jcode:working\x07");
        tracker.observe(b"\x1b]0;some title\x07");
        assert_eq!(tracker.latest_progress(), "jcode:working");
        assert_eq!(tracker.latest_title(), "some title");
        assert_eq!(tracker.latest_agent_label(), Some("jcode"));

        tracker.reset();

        assert_eq!(tracker.latest_progress(), "");
        assert_eq!(tracker.latest_title(), "");
        assert_eq!(tracker.latest_agent_label(), None);
        // Tracker can still capture new payloads after reset.
        tracker.observe(b"\x1b]9;jcode:idle\x07");
        assert_eq!(tracker.latest_progress(), "jcode:idle");
        assert_eq!(tracker.latest_agent_label(), Some("jcode"));
    }

    #[test]
    fn osc9_tracker_accepts_st_terminator_and_esc_bytes_in_body() {
        let mut tracker = Osc9Tracker::default();
        // ESC \ terminates the sequence the same as BEL.
        tracker.observe(b"\x1b]9;jcode:working\x1b\\");
        assert_eq!(tracker.latest_progress(), "jcode:working");

        // A lone ESC inside the body followed by a normal byte keeps both
        // bytes in the buffer, but finalize strips control bytes from the
        // stored payload, so the ESC disappears and the text survives.
        tracker.observe(b"\x1b]9;jcode:be\x1bgin\x07");
        assert_eq!(tracker.latest_progress(), "jcode:begin");
        // The captured payload keeps the raw ESC, but label extraction only
        // looks at the prefix before the colon.
        assert_eq!(tracker.latest_agent_label(), Some("jcode"));

        // Back-to-back ESC bytes stay in the Escape state until a byte
        // decides the sequence.
        tracker.reset();
        tracker.observe(b"\x1b\x1b]9;jcode:idle\x07");
        assert_eq!(tracker.latest_progress(), "jcode:idle");
    }

    #[test]
    fn osc9_tracker_ignores_payloads_that_sanitize_to_empty() {
        let mut tracker = Osc9Tracker::default();
        // OSC 9 body of only control bytes: no progress update.
        tracker.observe(b"\x1b]9;\x01\x02\x07");
        assert_eq!(tracker.latest_progress(), "");
        // OSC 0 title of only control bytes: no title update, and a prior
        // title survives.
        tracker.observe(b"\x1b]0;real title\x07");
        assert_eq!(tracker.latest_title(), "real title");
        tracker.observe(b"\x1b]0;\x01\x02\x07");
        assert_eq!(tracker.latest_title(), "real title");
        // A payload without a semicolon cannot be parsed at all.
        tracker.observe(b"\x1b]noseparator\x07");
        assert_eq!(tracker.latest_progress(), "");
        assert_eq!(tracker.latest_title(), "real title");
    }

    #[test]
    fn detect_agent_status_with_osc_prefers_osc_over_screen_scrape() {
        // OSC says "idle" but screen shows working spinner
        assert_eq!(
            detect_agent_status_with_osc(
                Some("jcode"),
                "⠋ sending… 0.3s",
                "jcode:idle",
                "",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        // OSC says "working" but screen shows idle prompt
        assert_eq!(
            detect_agent_status_with_osc(
                Some("jcode"),
                "1> ",
                "jcode:working",
                "",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // OSC says "blocked" with minimal screen
        assert_eq!(
            detect_agent_status_with_osc(
                Some("jcode"),
                "1> ",
                "jcode:blocked",
                "",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
    }

    #[test]
    fn detect_agent_status_with_osc_falls_back_to_screen_scrape() {
        // No OSC payload -> screen-scrape detection
        assert_eq!(
            detect_agent_status_with_osc(
                Some("jcode"),
                "⠋ sending… 0.3s",
                "",
                "",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("jcode"),
                "jcode\n1> ",
                "",
                "",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
    }

    #[test]
    fn detect_agent_status_with_osc_unknown_payload_falls_back() {
        // Unknown OSC payload format -> falls back to screen-scrape
        assert_eq!(
            detect_agent_status_with_osc(
                Some("jcode"),
                "⠋ sending… 0.3s",
                "unknown:format",
                "",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
    }

    #[test]
    fn osc9_progress_reports_claude_and_qwen_statuses() {
        // OSC 9;4;3 = working (tool executing) for Qwen only; Claude has no
        // osc_progress_working rule so 4;3 falls through to screen-scrape.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("claude"),
                "⠋ Thinking about the problem",
                "4;3",
                "",
                JcodeDetectionVariant::Vanilla
            ),
            "working" // falls through to screen-scrape, detects braille spinner
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("qwen"),
                "> type your message",
                "4;3",
                "",
                JcodeDetectionVariant::Vanilla
            ),
            "working" // OSC 4;3 matches qwen osc_tool_progress_working
        );
        // OSC 9;4;0 = idle for Claude only; Qwen has no osc_progress_idle
        // rule so 4;0 falls through to screen-scrape.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("claude"),
                "◐ Thinking about the problem",
                "4;0",
                "",
                JcodeDetectionVariant::Vanilla
            ),
            "idle" // OSC 4;0 matches claude osc_progress_idle
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("qwen"),
                "⠋ 5s · esc to cancel)",
                "4;0",
                "",
                JcodeDetectionVariant::Vanilla
            ),
            "working" // 4;0 falls through, screen-scrape detects cancel hint
        );
        // OSC 9;4;3;extra = working (extra data after state is ignored)
        assert_eq!(
            detect_agent_status_with_osc(
                Some("qwen"),
                "❯",
                "4;3;details",
                "",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
    }

    #[test]
    fn osc_title_detection_for_all_agents() {
        // jcode: ` · last ~<dur>` → idle (post-turn), everything else falls
        // through so the scrape path keeps blocked/working.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("jcode"),
                "",
                "",
                "🌐 jcode/observatory Humpback · last ~1m11s",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        // `work` segment must NOT classify via title: a live Permissions
        // viewer on screen (blocked) outranks the title.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("jcode"),
                "┌ Permissions (1 pending) ┐\na approve · d deny",
                "",
                "🌐 jcode/observatory Humpback · work ~1m09s",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Boot title (no work segment) falls through to the scrape path.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("jcode"),
                "1> ",
                "",
                "🐳 jcode/observatory Humpback",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        // Qwen: ✳ prefix → blocked, ◐ prefix → working.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("qwen"),
                "",
                "",
                "✳ Waiting for user confirmation",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("qwen"),
                "",
                "",
                "◐ Processing",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Qwen with variation selector FE0E.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("qwen"),
                "",
                "",
                "✳\u{fe0e} Waiting",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );

        // Claude: braille/half-circle prefix → working, ✳ prefix → idle.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("claude"),
                "",
                "",
                "⠋ Thinking",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("claude"),
                "",
                "",
                "◐ Thinking",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("claude"),
                "",
                "",
                "✳ Claude Code",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );

        // Codex: "Action Required" → blocked, braille → working, other → idle.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("codex"),
                "",
                "",
                "Action Required: Review changes",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("codex"),
                "",
                "",
                "codex ⠋",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("codex"),
                "",
                "",
                "codex",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );

        // Hermes: ⚠ → blocked, ⏳ → working, ✓ → idle.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("hermes"),
                "",
                "",
                "⚠ Approval needed",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("hermes"),
                "",
                "",
                "⏳ Working",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("hermes"),
                "",
                "",
                "✓ Done",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );

        // Amp: "Plugin confirmation needed" → blocked, braille → working.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("amp"),
                "",
                "",
                "Plugin confirmation needed",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("amp"),
                "",
                "",
                "⠋ amp",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("amp"),
                "",
                "",
                "project - amp - main",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );

        // Grok: "Action Required" → blocked, "grok" → idle, other → working.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("grok"),
                "",
                "",
                "Action Required",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("grok"),
                "",
                "",
                "grok",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status_with_osc(
                Some("grok"),
                "",
                "",
                "project - grok",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
    }

    #[test]
    fn osc_title_takes_priority_over_osc_progress() {
        // OSC title says blocked, OSC progress says working → blocked wins.
        assert_eq!(
            detect_agent_status_with_osc(
                Some("qwen"),
                "",
                "4;3",
                "✳ Waiting",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
    }

    #[test]
    fn detects_jcode_status_from_jcode_support_manifest_patterns() {
        // Blocked: Permissions viewer chrome from
        // `crates/jcode-tui-permissions/src/lib.rs`.
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "┌ Permissions (1 pending) ────┐\n│ ❯ [normal] run bash │\n└──────────┘\na approve · d deny · A approve all · D deny all",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "⏳ Agent is waiting for this decision",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Working: spinner status line (`draw_status` in ui_input.rs).
        for line in [
            "⠋ thinking… 1.2s",
            "⠋ streaming · ↑1.2k ↓42 · 1.2s",
            "⠋ sending… 0.3s",
            "⠸ running bash · npm test",
            "⠋ connecting… 0.3s",
            "⠋ Rate limited. Auto-retry in 1m 30s...",
            "↻ network disconnected, waiting to retry · websocket · 8s",
        ] {
            assert_eq!(
                detect_agent_status(Some("jcode"), line, JcodeDetectionVariant::Vanilla),
                "working",
                "{line}"
            );
        }
        // Working: background-task progress while the prompt is visible
        // (`render_background_task_message` in ui_messages.rs).
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "Jcode is running this in the background. Progress, checkpoints, and completion will appear here.\n╭ ◌ bg run full Rust and JS tests · 5202362vb9 ╮\nLatest status: bg action=\"status\" task_id=\"5202362vb9\"\n1> ",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Idle: completed bg task falls back to the prompt.
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "╭ ✓ bg run full Rust and JS tests completed · 5202362vb9 ╮\nexit 0 · 5.7s\n1> ",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        // Idle: numbered prompt, shell prompt, and hint rows.
        assert_eq!(
            detect_agent_status(Some("jcode"), "1> ", JcodeDetectionVariant::Vanilla),
            "idle"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "1>                                                            together_ai/revolut ca/glm 5 2 · ~/repo",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), "2$ ", JcodeDetectionVariant::Vanilla),
            "idle"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "1> \n↗ next prompt opens a new session",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "2$ \nshell mode · enter runs locally",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        // While a turn runs the prompt is `N… ` and the spinner sits in the
        // chrome above it; an old `N> ` prompt means the turn ended, so the
        // spinner text in scrollback is stale transcript, and the pane is
        // idle (the status line itself is cleared when processing stops).
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "⠋ thinking… 12s\nold response line 1\nold response line 2\nold response line 3\nold response line 4\nold response line 5\nold response line 6\nold response line 7\nold response line 8\n1> ",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        // Spinner with the processing prompt `N… ` directly below: working.
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "1… \n⠋ thinking… 12s",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Guards: transcript text without chrome stays unknown.
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "plain prompt",
                JcodeDetectionVariant::Vanilla
            ),
            "unknown"
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                "⠋running analysis",
                JcodeDetectionVariant::Vanilla
            ),
            "unknown"
        );

        assert_eq!(
            detect_agent_label_from_text("◌ bg cargo test · 5202362vb9"),
            Some("jcode")
        );
        assert_eq!(
            detect_agent_label_from_text("↻ network disconnected, waiting to retry"),
            Some("jcode")
        );

        assert_eq!(
            detect_agent_label_from_text("yes, allow once\nno, deny"),
            Some("claurst")
        );
        assert_eq!(
            detect_agent_label_from_text("yes, always allow (persistent)\nyes, allow this session"),
            Some("claurst")
        );
        assert_eq!(
            detect_agent_label_from_text("claurst is ready"),
            Some("claurst")
        );

        // A shell prompt whose cwd merely sits under a jcode-named
        // directory is not a jcode agent. This is the split-panel ghost row:
        // the bare `contains("jcode")` check branded this tail as jcode.
        assert_eq!(
            detect_agent_label_from_text("mac ~/documents/projects/jcode %"),
            None
        );
        assert_eq!(
            detect_agent_label_from_text("mac ~/.jcode/scratch/lens_repo %"),
            None
        );
        // But a real brand mention still detects.
        assert_eq!(
            detect_agent_label_from_text("welcome to jcode\nready"),
            Some("jcode")
        );
        assert_eq!(detect_agent_label_from_text("jcode"), Some("jcode"));
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
            ("claude", "◐ Thinking about the problem", "working"),
            ("claude", "◓ Analyzing code", "working"),
            ("claude", "◑ Searching files", "working"),
            ("claude", "◒ Writing code", "working"),
            ("claude", "enter to confirm\nesc to cancel", "blocked"),
            ("claude", "❯", "idle"),
            (
                "qwen",
                "yes, allow once\napply this change?",
                "blocked",
            ),
            (
                "qwen",
                "do you trust this folder?\ntrust folder (1)\ndon't trust (esc)",
                "blocked",
            ),
            ("qwen", "⠋ Thinking...(5s · esc to cancel)", "working"),
            ("qwen", "(3m 12s · esc to cancel)", "working"),
            ("qwen", "> type your message or @path/to/file", "idle"),
            ("cline", "Let Cline use this tool?", "blocked"),
            ("cline", "Cline is reading context", "working"),
            ("codex", "Allow command?", "blocked"),
            ("codex", "⠋ thinking", "working"),
            ("codex", "codex ready", "idle"),
            ("codex", "• Working (esc to interrupt)", "working"),
            ("codex", "■ Conversation interrupted", "idle"),
            (
                "codex",
                "> You are in /home/user/project\nDo you trust the contents of this directory?",
                "blocked",
            ),
            (
                "cursor",
                "write to this file?\nproceed (y)\nreject & propose changes",
                "blocked",
            ),
            ("cursor", "⬡ thinking", "working"),
            ("cursor", "run command (y)", "blocked"),
            ("cursor", "→ run this (y)", "blocked"),
            (
                "devin",
                "approve once\nselect\nconfirm\nesc cancel",
                "blocked",
            ),
            (
                "devin",
                "do you trust the authors of this directory?\nwith untrusted content.\nyes, trust ",
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
                "enter to select\nesc to cancel\n↑↓ to navigate\n> yes, allow",
                "blocked",
            ),
            ("droid", "esc to stop", "working"),
            ("gemini", "│ Apply this change", "blocked"),
            ("gemini", "esc to cancel", "working"),
            ("copilot", "esc to cancel\nenter to submit", "blocked"),
            ("copilot", "esc interrupt", "working"),
            ("grok", "┃ a (●) option", "blocked"),
            ("grok", "⠋ Run command", "working"),
            ("grok", "ctrl+.:shortcuts", "idle"),
            ("grok", "⋅ 3 │ background", "working"),
            ("hermes", "dangerous command\nenter to confirm", "blocked"),
            ("hermes", "approval\n↑/↓ to select", "blocked"),
            ("hermes", "hermes needs your input\nenter to confirm", "blocked"),
            ("hermes", "ask a question\ntype your answer\nenter send", "blocked"),
            ("hermes", "sudo password\nenter to confirm", "blocked"),
            ("hermes", "🔑 root@host for sudo\nenter confirm", "blocked"),
            ("hermes", "approve once\ncancel\ntype 1/2/3", "blocked"),
            ("hermes", "msg=interrupt", "working"),
            ("hermes", "ctrl+c to interrupt", "working"),
            ("hermes", "ctrl+c cancel", "working"),
            ("kilo", "△ Permission required", "blocked"),
            ("kilo", "esc interrupt", "working"),
            ("kimi", "↵ confirm\nrun this command?\napprove\n choose", "blocked"),
            ("kimi", "approve this change?\n↵ confirm\nreject\n choose", "blocked"),
            ("kimi", "↑↓ select\nesc cancel\nquestion\n↵ choose", "blocked"),
            ("kimi", "requesting approval\nreject\napprove once\n1/2/3/4 choose", "blocked"),
            ("kimi", "🌕", "working"),
            (
                "kiro",
                "requires approval\nyes, single permission",
                "blocked",
            ),
            ("kiro", "kiro is working", "working"),
            (
                "kiro",
                "ask a question or describe a task\n/copy to clipboard",
                "idle",
            ),
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
            (
                "claurst",
                "yes, allow once\nyes, allow this session\nyes, always allow (persistent)\nno, deny",
                "blocked",
            ),
            ("claurst", "· thinking…", "working"),
            ("claurst", "❯", "idle"),
            ("qwen", "⠋ 5s · esc to cancel)", "working"),
            (
                "qwen",
                "yes, allow once\nallow execution of: rm -rf",
                "blocked",
            ),
            ("qwen", "> type your message", "idle"),
        ];

        for (agent, text, expected) in cases {
            assert_eq!(
                detect_agent_status(Some(agent), text, JcodeDetectionVariant::Vanilla),
                expected,
                "agent {agent} text {text:?}"
            );
        }
    }

    #[test]
    fn jcode_status_covers_manifest_choice_combinations() {
        // Blocked: the Permissions viewer help row and its key bindings
        // (`crates/jcode-tui-permissions/src/lib.rs` render_help).
        let viewer = "Permissions (1 pending)\na approve\nd deny\nA approve all\nD deny all";
        assert_eq!(
            detect_agent_status(Some("jcode"), viewer, JcodeDetectionVariant::Vanilla),
            "blocked"
        );
        let waiting = "⏳ Agent is waiting for this decision";
        assert_eq!(
            detect_agent_status(Some("jcode"), waiting, JcodeDetectionVariant::Vanilla),
            "blocked"
        );

        // Working: spinner status line shapes from `draw_status`
        // (`ui_input.rs`): every phase label the TUI renders.
        for status in [
            "⠋ sending… 3s",
            "⠙ thinking… 1m 02s",
            "⠹ streaming · 12.3 tps · ↑1.2k ↓4.5k",
            "⠸ running bash · npm test",
            "⠋ Rate limited. Auto-retry in 1m 30s...",
            "↻ network disconnected, waiting to retry · ws · 12s",
        ] {
            assert_eq!(
                detect_agent_status(Some("jcode"), status, JcodeDetectionVariant::Vanilla),
                "working"
            );
        }

        // Idle: the numbered input prompt is the last non-empty line.
        for ready in ["1> ", "3> fix the bug", "2$ "] {
            assert_eq!(
                detect_agent_status(Some("jcode"), ready, JcodeDetectionVariant::Vanilla),
                "idle"
            );
        }
    }

    #[test]
    fn terminal_screen_text_applies_common_tui_rewrites() {
        assert_eq!(
            terminal_screen_text_lossy("Session ready\n❯\r\u{1b}[2K⠋ sending… 3s"),
            "Session ready\n⠋ sending… 3s"
        );
        assert_eq!(
            terminal_screen_text_lossy("Session ready\n⠋ sending… 3s\r\u{1b}[2KSession ready\n1> "),
            // The screen emulator trims trailing spaces per line: `1> `
            // collapses to `1>` (detectors trim too, so statuses match).
            "Session ready\nSession ready\n1>"
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
        // The real bottom chrome: a spinner status line replaces the prompt
        // while working, then the numbered prompt returns when idle.
        let working_screen =
            terminal_screen_text_lossy("1> \r\u{1b}[2K⠋ running bash · npm test · 12s");
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                &working_screen,
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );

        let idle_screen = terminal_screen_text_lossy(
            "⠋ running bash · npm test · 12s\r\u{1b}[2KSession ready\n1> ",
        );
        assert_eq!(
            detect_agent_status(Some("jcode"), &idle_screen, JcodeDetectionVariant::Vanilla),
            "idle"
        );
        assert_eq!(detect_agent_label_from_text(&idle_screen), Some("jcode"));

        let blocked_screen = terminal_screen_text_lossy(
            "⠋ running bash · 12s\r\u{1b}[2KPermissions (1 pending)\n⏳ Agent is waiting for this decision",
        );
        assert_eq!(
            detect_agent_status(
                Some("jcode"),
                &blocked_screen,
                JcodeDetectionVariant::Vanilla
            ),
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
    fn detects_claurst_from_terminal_process_tree() {
        let processes = parse_process_table(
            r#"
              10     1 /bin/zsh -zsh
              11    10 /home/user/.cargo/bin/claurst claurst
              20     1 /usr/local/bin/claurst claurst --provider anthropic
            "#,
        );

        assert_eq!(
            detect_agent_label_from_processes(10, &processes),
            Some("claurst")
        );
        assert_eq!(
            detect_agent_label_from_processes(20, &processes),
            Some("claurst")
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
            detect_agent_status(
                Some("opencode"),
                "△ Permission required",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("opencode"),
                "esc dismiss\nenter confirm\n↑↓ select",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("opencode"),
                "esc dismiss\nenter submit\n⇆ tab",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("opencode"),
                "esc dismiss\nenter toggle\n↑↓ select",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("opencode"),
                "opencode · esc to interrupt",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(
                Some("opencode"),
                "opencode · esc again to interrupt",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(
                Some("opencode"),
                "opencode escaped interrupt",
                JcodeDetectionVariant::Vanilla
            ),
            "unknown"
        );
        assert_eq!(
            detect_agent_status(
                Some("opencode"),
                "esc interrupt before opencode",
                JcodeDetectionVariant::Vanilla
            ),
            "unknown"
        );
        assert_eq!(
            detect_agent_status(Some("opencode"), "■■■■", JcodeDetectionVariant::Vanilla),
            "working"
        );
    }

    #[test]
    fn detects_qwen_status_from_manifest_patterns() {
        // Blocked: tool confirmation dialog.
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                "Do you want to proceed?\nyes, allow once\n",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: localized confirmation spinner lines.
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                "⠏ Waiting for user confirmation...\n",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                "⠏ 等待用户确认...",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Spinner without the trailing dots must not match.
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                "⠏ Waiting for user confirmation",
                JcodeDetectionVariant::Vanilla
            ),
            "unknown"
        );
        // Blocked: numbered question dialog and arrow navigation.
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                "❯ [✓] 1. First option\n",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                "› 2. Pick one\n↑/↓ : Enter to confirm",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: folder trust dialog.
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                "Do you trust this folder?\nTrust folder (1)\nDon't trust (esc)",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Working: cancel hint with elapsed time and braille spinner.
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                "⠙ Generating response (1m 12s · esc to cancel)",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                ".. Compiling (45s · esc to cancel)",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Working: narrow terminal cancel hint without spinner.
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                "(3m 12s · esc to cancel)",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Idle: composer prompt box.
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                "> type your message or @path/to/file",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        // Idle: fragmented localized composer.
        assert_eq!(
            detect_agent_status(
                Some("qwen"),
                "> type mes sage @pat h/to /fil",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("qwen"), "nothing", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_kimi_status_from_manifest_patterns() {
        // Blocked: current approval panel.
        assert_eq!(
            detect_agent_status(
                Some("kimi"),
                "Run this command?\n↵ confirm\n Choose: approve / reject / revise",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: ▶ approve alias form (no space after the marker).
        assert_eq!(
            detect_agent_status(
                Some("kimi"),
                "▶approve everything?\n↵ confirm\n choose",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: question panel.
        assert_eq!(
            detect_agent_status(
                Some("kimi"),
                "question\n↑↓ select\nesc cancel\n↵ choose",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: legacy approval panel.
        assert_eq!(
            detect_agent_status(
                Some("kimi"),
                "Requesting approval\nreject\napprove once\n1/2/3/4 choose",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Working: moon spinner.
        assert_eq!(
            detect_agent_status(Some("kimi"), "🌕", JcodeDetectionVariant::Vanilla),
            "working"
        );
        // Working: braille spinner with thinking.
        assert_eq!(
            detect_agent_status(
                Some("kimi"),
                "⠋ thinking...",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Working: background agents line in bottom 3.
        assert_eq!(
            detect_agent_status(
                Some("kimi"),
                "line\nKimi thinking about it [2 agents running]\nline",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Zero agents must not count as working.
        assert_eq!(
            detect_agent_status(
                Some("kimi"),
                "Kimi thinking [0 agents running]",
                JcodeDetectionVariant::Vanilla
            ),
            "unknown"
        );
        assert_eq!(
            detect_agent_status(Some("kimi"), "nothing", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_kiro_status_from_manifest_patterns() {
        // Blocked: approval panel.
        assert_eq!(
            detect_agent_status(
                Some("kiro"),
                "Requires approval\nyes, single permission\nesc to close",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: pending subagent approvals.
        assert_eq!(
            detect_agent_status(
                Some("kiro"),
                "Pending from subagents\ntool approvals\nApprove all pending",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Working: explicit text.
        assert_eq!(
            detect_agent_status(
                Some("kiro"),
                "Kiro is working on it",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Working: half-circle spinner with esc to cancel.
        assert_eq!(
            detect_agent_status(
                Some("kiro"),
                "◔ running tools\nesc to cancel",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Idle: composer prompt.
        assert_eq!(
            detect_agent_status(
                Some("kiro"),
                "ask a question or describe a task\n/copy to clipboard",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("kiro"), "nothing", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_gemini_status_from_manifest_patterns() {
        assert_eq!(
            detect_agent_status(
                Some("gemini"),
                "│ apply this change?",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("gemini"),
                "waiting for user confirmation\nyes",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // ❯ line with yes or allow.
        assert_eq!(
            detect_agent_status(
                Some("gemini"),
                "❯ allow this command",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("gemini"),
                "esc to cancel",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("gemini"), "nothing", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_cursor_status_from_manifest_patterns() {
        // Blocked: write permission dialog in bottom 8.
        assert_eq!(
            detect_agent_status(
                Some("cursor"),
                "Write to this file?\nProceed (y)\nReject & propose changes",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: waiting for approval with run hints.
        assert_eq!(
            detect_agent_status(
                Some("cursor"),
                "Waiting for approval\nRun this command?\nrun (once) (y)",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: → allow line with (y).
        assert_eq!(
            detect_agent_status(
                Some("cursor"),
                "→ allow this (y)",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Working: ctrl+c hint.
        assert_eq!(
            detect_agent_status(
                Some("cursor"),
                "ctrl+c to stop",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Working: background task count line in bottom 5.
        assert_eq!(
            detect_agent_status(
                Some("cursor"),
                "2 background tasks running",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Working: ⬡ spinner with an -ing word.
        assert_eq!(
            detect_agent_status(Some("cursor"), "⬡ indexing", JcodeDetectionVariant::Vanilla),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("cursor"), "nothing", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_devin_status_from_manifest_patterns() {
        // Blocked: workspace trust prompt.
        assert_eq!(
            detect_agent_status(
                Some("devin"),
                "Do you trust the authors of this directory?\nwith untrusted content.\nyes, trust it",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: permission prompt.
        assert_eq!(
            detect_agent_status(
                Some("devin"),
                "approve once\nselect\nconfirm\nesc cancel",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Working: guide line or running tools.
        assert_eq!(
            detect_agent_status(
                Some("devin"),
                "guide devin while it works",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(
                Some("devin"),
                "running tools\nesc to interrupt",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Idle: welcome composer.
        assert_eq!(
            detect_agent_status(
                Some("devin"),
                "Ask Devin to build\nfeatures, fix bugs\nyour code",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        // Idle: context line with ❭.
        assert_eq!(
            detect_agent_status(
                Some("devin"),
                "context:\n❭ prompt",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("devin"), "nothing", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_droid_status_from_manifest_patterns() {
        assert_eq!(
            detect_agent_status(
                Some("droid"),
                "enter to select\nesc to cancel\n↑↓ to navigate\n> yes, allow",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("droid"),
                "enter select\nesc cancel\n↑/↓ navigate",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(Some("droid"), "esc to stop", JcodeDetectionVariant::Vanilla),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("droid"), "nothing", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_copilot_status_from_manifest_patterns() {
        assert_eq!(
            detect_agent_status(
                Some("copilot"),
                "esc to cancel\nenter to select",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("copilot"),
                "esc again to cancel",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(
                Some("copilot"),
                "esc interrupt",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("copilot"), "nothing", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_amp_status_from_manifest_patterns() {
        assert_eq!(
            detect_agent_status(
                Some("amp"),
                "plugin confirmation needed",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("amp"),
                "run this command?",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // approve plus a session-scope allow option.
        assert_eq!(
            detect_agent_status(
                Some("amp"),
                "approve\nallow all for this session",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Working: braille spinner line.
        assert_eq!(
            detect_agent_status(Some("amp"), "⠋ working", JcodeDetectionVariant::Vanilla),
            "working"
        );
        // Working: ╰ box line with a verb and ─ rule.
        assert_eq!(
            detect_agent_status(
                Some("amp"),
                "╰ thinking ──────",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("amp"), "esc to cancel", JcodeDetectionVariant::Vanilla),
            "working"
        );
        // Idle: title bar with " - amp - ".
        assert_eq!(
            detect_agent_status(
                Some("amp"),
                "project - amp - main",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("amp"), "nothing", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_grok_status_from_manifest_patterns() {
        // Blocked: option dialog line ┃ label (●).
        assert_eq!(
            detect_agent_status(
                Some("grok"),
                "┃ yes (●) proceed",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: shortcut bar with :select (one bottom line).
        assert_eq!(
            detect_agent_status(
                Some("grok"),
                ":select ctrl+o:yolo ctrl+c:cancel",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: scrollback bar with dismiss hint.
        assert_eq!(
            detect_agent_status(
                Some("grok"),
                "tab:scrollback shift+x:dismiss",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: scope picker.
        assert_eq!(
            detect_agent_status(
                Some("grok"),
                "yes, proceed\nno, reject\n←/→:scope",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Working: spinner stop line.
        assert_eq!(
            detect_agent_status(
                Some("grok"),
                "⠙ running[stop]",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Working: tool line.
        assert_eq!(
            detect_agent_status(
                Some("grok"),
                "⠙ Run tests now",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Working: background chip pinned top line.
        assert_eq!(
            detect_agent_status(
                Some("grok"),
                "⁙ 3 │ tasks running\nline",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Idle: shortcuts bar without cancel hints.
        assert_eq!(
            detect_agent_status(
                Some("grok"),
                "ctrl+.:shortcuts",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("grok"), "nothing", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_codex_status_from_manifest_patterns() {
        // Blocked: trust prompt in top 20.
        assert_eq!(
            detect_agent_status(
                Some("codex"),
                "> You are in a repo.\nDo you trust the contents of this directory?",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("codex"),
                "action required",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("codex"),
                "allow command?\n[y/n]",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Working: braille spinner anywhere.
        assert_eq!(
            detect_agent_status(
                Some("codex"),
                "⠸ working on it",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Working: bullet status line.
        assert_eq!(
            detect_agent_status(
                Some("codex"),
                "• Working (esc to interrupt)",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Interrupted conversation must not read as working.
        assert_eq!(
            detect_agent_status(
                Some("codex"),
                "• Working (esc to interrupt)\n■ Conversation interrupted",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        // Non-empty unknown text is idle.
        assert_eq!(
            detect_agent_status(Some("codex"), "plain text", JcodeDetectionVariant::Vanilla),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("codex"), "", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_maki_status_from_manifest_patterns() {
        // Blocked: permission panel.
        assert_eq!(
            detect_agent_status(
                Some("maki"),
                "permission required\ny allow\nn deny",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: plan complete confirm.
        assert_eq!(
            detect_agent_status(
                Some("maki"),
                "plan complete\nenter confirm\nspace toggle parallel",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Working: spinner status line at the bottom.
        assert_eq!(
            detect_agent_status(
                Some("maki"),
                "⠋ [build] compiling",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Idle: non-spinner status line at the bottom.
        assert_eq!(
            detect_agent_status(Some("maki"), "[bash] done", JcodeDetectionVariant::Vanilla),
            "idle"
        );
        // Idle: ❯ prompt without a queued followup.
        assert_eq!(
            detect_agent_status(
                Some("maki"),
                "❯ ask something",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        assert_eq!(
            detect_agent_status(Some("maki"), "nothing", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_kilo_pi_qodercli_and_cline_status_patterns() {
        // Kilo shares the opencode manifest plus its own esc interrupt rule.
        assert_eq!(
            detect_agent_status(
                Some("kilo"),
                "△ Permission required",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("kilo"),
                "esc interrupt",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Pi: only the literal spinner text counts.
        assert_eq!(
            detect_agent_status(Some("pi"), "working...", JcodeDetectionVariant::Vanilla),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("pi"), "working", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
        // Qoder CLI: confirmation and approval panels.
        assert_eq!(
            detect_agent_status(
                Some("qodercli"),
                "permission required",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("qodercli"),
                "awaiting approval\nallow",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("qodercli"),
                "(esc to cancel, running)",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Cline: tool permission prompts block, other output works.
        assert_eq!(
            detect_agent_status(
                Some("cline"),
                "Let Cline use this tool?",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("cline"),
                "[act mode]\nExecute command?\nyes",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("cline"),
                "[plan mode]\nUse this tool?\nyes",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        assert_eq!(
            detect_agent_status(
                Some("cline"),
                "any other output",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(Some("cline"), "", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn detects_antigravity_and_hermes_status_patterns() {
        // Antigravity: permission request blocks.
        assert_eq!(
            detect_agent_status(
                Some("agy"),
                "Requesting permission for:\nDo you want to proceed?",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Antigravity: braille -ing line works.
        assert_eq!(
            detect_agent_status(Some("agy"), "⠙ thinking", JcodeDetectionVariant::Vanilla),
            "working"
        );
        // Antigravity: · N task line works (N >= 1, no leading zero).
        assert_eq!(
            detect_agent_status(
                Some("agy"),
                "· 3 tasks running",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Hermes: dangerous command approval.
        assert_eq!(
            detect_agent_status(
                Some("hermes"),
                "dangerous\nenter confirm",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Hermes: sudo password prompt.
        assert_eq!(
            detect_agent_status(
                Some("hermes"),
                "sudo password",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Hermes: interrupt status.
        assert_eq!(
            detect_agent_status(
                Some("hermes"),
                "msg=interrupt",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect_agent_status(
                Some("hermes"),
                "ctrl+c cancel",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
    }

    #[test]
    fn detects_claude_status_from_manifest_patterns() {
        // Blocked: enter to select dialogs.
        assert_eq!(
            detect_agent_status(
                Some("claude"),
                "enter to select\nesc to cancel\n↑/↓ to navigate",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: bash command confirmation.
        assert_eq!(
            detect_agent_status(
                Some("claude"),
                "Do you want to proceed?\nbash command",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Blocked: waiting for permission.
        assert_eq!(
            detect_agent_status(
                Some("claude"),
                "waiting for permission",
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
        // Working: half-circle spinner.
        assert_eq!(
            detect_agent_status(
                Some("claude"),
                "◐ Thinking about the problem",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        // Working: /btw line.
        assert_eq!(
            detect_agent_status(Some("claude"), "/btw note", JcodeDetectionVariant::Vanilla),
            "working"
        );
        // Idle: ❯ prompt without dialog markers.
        assert_eq!(
            detect_agent_status(
                Some("claude"),
                "❯ ask something",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
    }

    #[test]
    fn builtin_read_pane_strips_image_payloads_and_keeps_single_newlines() {
        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        // printf \r\n exercises ONLCR-style CRLF history bytes; the Kitty
        // APC and iTerm2 OSC forms are the exact escape families whose
        // base64 payloads used to leak into pane.read (round-2 finding 2).
        let script = "printf 'one\\r\\n\\033_Ga=T,f=32,t=d,i=7,q=2;/wAA==\\033\\\\two\\r\\n\\033]1337;File=inline=1:SEVMTE8=\\033\\\\end\\r\\n'";
        let started = state
            .handle_request_inner(
                "agent.start",
                json!({
                    "name": "imgemit",
                    "argv": ["/bin/sh", "-c", script],
                    "cwd": std::env::temp_dir().to_string_lossy()
                }),
            )
            .unwrap();
        let pane_id = started["agent"]["pane_id"].as_str().unwrap().to_string();

        // Poll until the shell command's output has been captured.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let text = loop {
            let text = state.read_pane_recent(&pane_id).unwrap();
            if text.contains("end") || std::time::Instant::now() > deadline {
                break text;
            }
            std::thread::sleep(Duration::from_millis(50));
        };

        assert!(
            !text.contains("/wAA=="),
            "Kitty base64 payload leaked: {text:?}"
        );
        assert!(
            !text.contains("SEVMTE8="),
            "iTerm2 base64 payload leaked: {text:?}"
        );
        assert!(
            !text.contains("\u{1b}_G") && !text.contains("\u{1b}]1337"),
            "escape framing leaked: {text:?}"
        );
        assert!(text.contains("one") && text.contains("two") && text.contains("end"));
        // Drop mode: CRLF history must not become double newlines.
        assert!(!text.contains("\n\n"), "double newline from CRLF: {text:?}");
    }

    #[test]
    fn builtin_panes_advertise_kitty_env_and_scrub_inherited_hints() {
        // The image hint env must be set even when the server process
        // itself inherited misleading values (e.g. launched from iTerm).
        // SAFETY on env mutation: each cargo test binary runs tests in
        // threads of ONE process, so a leaked TERM_PROGRAM would only
        // mislead other panes; remove it first to keep the test
        // deterministic either way.
        let previous_term_program = std::env::var("TERM_PROGRAM").ok();
        let previous_kitty_id = std::env::var("KITTY_WINDOW_ID").ok();
        std::env::set_var("TERM_PROGRAM", "iTerm.app");
        std::env::set_var("KITTY_WINDOW_ID", "123");

        let env = terminal_environment("/bin/zsh");
        assert_eq!(env.get("TERM_PROGRAM").map(String::as_str), Some("ghostty"));
        assert!(!env.contains_key("KITTY_WINDOW_ID"));

        // Restore so other tests are unaffected.
        match previous_term_program {
            Some(value) => std::env::set_var("TERM_PROGRAM", value),
            None => std::env::remove_var("TERM_PROGRAM"),
        }
        match previous_kitty_id {
            Some(value) => std::env::set_var("KITTY_WINDOW_ID", value),
            None => std::env::remove_var("KITTY_WINDOW_ID"),
        }
    }

    #[test]
    fn builtin_pane_child_env_advertises_kitty_hint_and_scrubs_inherited_kitty_id() {
        // Real-PTY proof that the spawn-site scrub reaches the child process:
        // poison the server process env the way a real iTerm/kitty launch
        // would, start a pane that prints the vars it sees, and assert the
        // child got TERM_PROGRAM=ghostty and NO KITTY_WINDOW_ID. This covers
        // the CommandBuilder::env_remove() step that the HashMap-only unit
        // test above cannot reach (env() only adds on top of the inherited
        // env, it cannot unset).
        let previous_term_program = std::env::var("TERM_PROGRAM").ok();
        let previous_kitty_id = std::env::var("KITTY_WINDOW_ID").ok();
        std::env::set_var("TERM_PROGRAM", "iTerm.app");
        std::env::set_var("KITTY_WINDOW_ID", "123");

        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let script = "printf 'TP=%s KID=%s' \"$TERM_PROGRAM\" \"${KITTY_WINDOW_ID:-}\"";
        let started = state
            .handle_request_inner(
                "agent.start",
                json!({
                    "name": "envhint",
                    "argv": ["/bin/sh", "-c", script],
                    "cwd": std::env::temp_dir().to_string_lossy()
                }),
            )
            .unwrap();
        let pane_id = started["agent"]["pane_id"].as_str().unwrap().to_string();

        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        let text = loop {
            let text = state.read_pane_recent(&pane_id).unwrap();
            if text.contains("TP=") || std::time::Instant::now() > deadline {
                break text;
            }
            std::thread::sleep(Duration::from_millis(50));
        };

        assert!(
            text.contains("TP=ghostty KID="),
            "child env wrong: {text:?}"
        );

        // Restore so other tests are unaffected.
        match previous_term_program {
            Some(value) => std::env::set_var("TERM_PROGRAM", value),
            None => std::env::remove_var("TERM_PROGRAM"),
        }
        match previous_kitty_id {
            Some(value) => std::env::set_var("KITTY_WINDOW_ID", value),
            None => std::env::remove_var("KITTY_WINDOW_ID"),
        }
    }

    #[test]
    fn strips_ansi_before_tail_detection() {
        let stripped = strip_ansi_lossy("\u{1b}[31mjcode\u{1b}[0m\r\n\u{1b}]0;title\u{7}1> ");

        assert!(stripped.contains("jcode"));
        assert!(stripped.contains("1> "));
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
    fn builtin_worktree_remove_rejects_missing_params() {
        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();

        // Unknown workspace_id: the resolver cannot fill path/repo_root, so
        // the request must still fail instead of removing anything.
        let err = state
            .handle_request_inner("worktree.remove", json!({ "workspace_id": "ws_missing" }))
            .unwrap_err();

        assert!(
            err.contains("workspace not found"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn builtin_worktree_remove_resolves_workspace_id_to_path() {
        let scratch = std::env::temp_dir().join(format!(
            "herdr-wt-remove-ws-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let repo = scratch.join("repo");
        let worktree = scratch.join("feature-y");
        fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-q"]).unwrap();
        fs::write(repo.join("README.md"), "base\n").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["config", "user.email", "t@t"]).unwrap();
        run_git(&repo, &["config", "user.name", "T"]).unwrap();
        run_git(&repo, &["commit", "-q", "-m", "base"]).unwrap();
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature-y",
                &worktree.to_string_lossy(),
            ],
        )
        .unwrap();
        assert!(worktree.is_dir());

        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let opened = state
            .handle_request_inner(
                "worktree.open",
                json!({ "path": worktree.to_string_lossy() }),
            )
            .unwrap();
        let workspace_id = opened["workspace"]["workspace_id"].as_str().unwrap();

        // The workspace-scoped WebUI route sends only workspace_id + force.
        let result = state
            .handle_request_inner(
                "worktree.remove",
                json!({ "workspace_id": workspace_id, "force": false }),
            )
            .unwrap();

        assert_eq!(result["type"], "worktree_removed");
        // The removed worktree's workspace must not linger in the state:
        // a follow-up snapshot listing it again would resurrect the row
        // with a dead cwd and a dead PTY (the live regression).
        let ids = result["workspace_ids"].as_array().unwrap();
        assert_eq!(
            ids.iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>(),
            vec![workspace_id],
            "the removed worktree's workspace id rides the event"
        );
        let snapshot = state
            .handle_request_inner("session.snapshot", json!({}))
            .unwrap();
        let listed: Vec<&str> = snapshot["snapshot"]["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["workspace_id"].as_str().unwrap())
            .collect();
        assert!(
            !listed.contains(&workspace_id),
            "the removed worktree stays out of the snapshot: {listed:?}"
        );
        assert!(!worktree.exists(), "worktree directory must be gone");
        let listing = git_output(&repo, &["worktree", "list", "--porcelain"]).unwrap();
        assert!(!listing.contains("feature-y"));
        fs::remove_dir_all(&scratch).ok();
    }

    #[cfg(unix)]
    #[test]
    fn builtin_worktree_remove_tears_down_workspace_opened_via_symlink() {
        // A workspace opened through a symlinked path (macOS /tmp hides
        // /private/tmp) must still be torn down when the worktree is
        // removed via the other spelling. The canonical comparison must
        // run while the directory still exists: after git removes it,
        // canonicalize fails and raw spellings would differ forever.
        let scratch = std::env::temp_dir().join(format!(
            "herdr-wt-remove-symlink-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let repo = scratch.join("repo");
        fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-q"]).unwrap();
        fs::write(repo.join("README.md"), "base\n").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["config", "user.email", "t@t"]).unwrap();
        run_git(&repo, &["config", "user.name", "T"]).unwrap();
        run_git(&repo, &["commit", "-q", "-m", "base"]).unwrap();
        // Open the worktree through the symlinked view and remove it
        // through the canonical spelling (a remove-path caller typing
        // the resolved path).
        let canonical_worktree = scratch.join("feature-z");
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature-z",
                &canonical_worktree.to_string_lossy(),
            ],
        )
        .unwrap();
        let symlink_view = scratch.join("link-to-scratch");
        std::os::unix::fs::symlink(&scratch, &symlink_view).unwrap();
        let opened_path = symlink_view.join("feature-z");
        assert!(opened_path.is_dir());

        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let opened = state
            .handle_request_inner(
                "worktree.open",
                json!({ "path": opened_path.to_string_lossy() }),
            )
            .unwrap();
        let workspace_id = opened["workspace"]["workspace_id"].as_str().unwrap();

        // Remove via the canonical spelling: the opened workspace's cwd
        // carries the symlinked spelling, so raw matching would miss it.
        let result = state
            .handle_request_inner(
                "worktree.remove",
                json!({
                    "path": canonical_worktree.to_string_lossy(),
                    "repo_root": repo.to_string_lossy(),
                    "force": false
                }),
            )
            .unwrap();
        assert_eq!(result["type"], "worktree_removed");
        let ids = result["workspace_ids"].as_array().unwrap();
        assert_eq!(
            ids.iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>(),
            vec![workspace_id],
            "the symlink-opened workspace is torn down despite the spelling gap"
        );
        let snapshot = state
            .handle_request_inner("session.snapshot", json!({}))
            .unwrap();
        let listed: Vec<&str> = snapshot["snapshot"]["workspaces"]
            .as_array()
            .unwrap()
            .iter()
            .map(|w| w["workspace_id"].as_str().unwrap())
            .collect();
        assert!(
            !listed.contains(&workspace_id),
            "the symlink-opened workspace stays out of the snapshot: {listed:?}"
        );
        fs::remove_file(&symlink_view).ok();
        fs::remove_dir_all(&scratch).ok();
    }

    #[test]
    fn builtin_worktree_remove_relative_path_joins_repo_root() {
        // Raw socket callers may send a relative path (git-ui always
        // sends absolute ones). The canonical comparison must join the
        // repo_root first: resolving against the server cwd would
        // canonicalize the wrong (or missing) directory and leave the
        // opened workspace alive after removal.
        let scratch = std::env::temp_dir().join(format!(
            "herdr-wt-remove-relative-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        let repo = scratch.join("repo");
        fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-q"]).unwrap();
        fs::write(repo.join("README.md"), "base\n").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["config", "user.email", "t@t"]).unwrap();
        run_git(&repo, &["config", "user.name", "T"]).unwrap();
        run_git(&repo, &["commit", "-q", "-m", "base"]).unwrap();
        let worktree = scratch.join("feature-rel");
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature-rel",
                &worktree.to_string_lossy(),
            ],
        )
        .unwrap();

        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let opened = state
            .handle_request_inner(
                "worktree.open",
                json!({ "path": worktree.to_string_lossy() }),
            )
            .unwrap();
        let workspace_id = opened["workspace"]["workspace_id"].as_str().unwrap();

        // Remove with a path relative to repo_root (the worktree is a
        // sibling of repo, the normal `git worktree add ../name` layout),
        // while the test process cwd points somewhere else entirely:
        // resolving `../feature-rel` against the process cwd hits a
        // directory that either does not exist or is the wrong one, so
        // the opened workspace would survive removal.
        let result = state
            .handle_request_inner(
                "worktree.remove",
                json!({
                    "path": "../feature-rel",
                    "repo_root": repo.to_string_lossy(),
                    "force": false
                }),
            )
            .unwrap();
        assert_eq!(result["type"], "worktree_removed");
        let ids = result["workspace_ids"].as_array().unwrap();
        assert_eq!(
            ids.iter().map(|v| v.as_str().unwrap()).collect::<Vec<_>>(),
            vec![workspace_id],
            "the relative path still tears down the opened workspace"
        );
        assert!(
            !worktree.exists(),
            "git removed the worktree resolved against repo_root"
        );
        fs::remove_dir_all(&scratch).ok();
    }

    #[test]
    fn builtin_worktree_remove_removes_a_real_worktree() {
        let scratch = std::env::temp_dir().join(format!(
            "herdr-wt-remove-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let repo = scratch.join("repo");
        let worktree = scratch.join("feature-x");
        fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-q"]).unwrap();
        fs::write(repo.join("README.md"), "base\n").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        // Linux CI runners ship no global git identity, so the fixture
        // repo must configure one before its first commit.
        run_git(&repo, &["config", "user.email", "t@t"]).unwrap();
        run_git(&repo, &["config", "user.name", "T"]).unwrap();
        run_git(&repo, &["commit", "-q", "-m", "base"]).unwrap();
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature-x",
                &worktree.to_string_lossy(),
            ],
        )
        .unwrap();
        assert!(worktree.is_dir());

        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let result = state
            .handle_request_inner(
                "worktree.remove",
                json!({
                    "repo_root": repo.to_string_lossy(),
                    "path": worktree.to_string_lossy(),
                }),
            )
            .unwrap();

        assert_eq!(result["type"], "worktree_removed");
        assert!(!worktree.exists(), "worktree directory must be gone");
        let listing = git_output(&repo, &["worktree", "list", "--porcelain"]).unwrap();
        assert!(!listing.contains("feature-x"));
        fs::remove_dir_all(&scratch).ok();
    }

    // `rev-parse --show-toplevel` inside a linked worktree names the lane
    // itself, so deriving the source identity from it would report a lane
    // as its own repository root and every consumer comparing checkout
    // paths against the root (the WebUI workspace worktree stamp, the
    // browser grouping) would misjudge main-vs-linked. The porcelain list
    // always leads with the main checkout, so the identity comes from
    // there even when the query ran inside the lane.
    #[test]
    fn builtin_worktree_list_reports_main_repo_root_from_a_lane() {
        let scratch = std::env::temp_dir().join(format!(
            "herdr-wt-list-root-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let repo = scratch.join("repo");
        let lane = scratch.join("feature-y");
        fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-q"]).unwrap();
        fs::write(repo.join("README.md"), "base\n").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["config", "user.email", "t@t"]).unwrap();
        run_git(&repo, &["config", "user.name", "T"]).unwrap();
        run_git(&repo, &["commit", "-q", "-m", "base"]).unwrap();
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature-y",
                &lane.to_string_lossy(),
            ],
        )
        .unwrap();

        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let result = state
            .handle_request_inner("worktree.list", json!({ "cwd": lane.to_string_lossy() }))
            .unwrap();

        let repo_str = repo.to_string_lossy().to_string();
        let lane_str = lane.to_string_lossy().to_string();
        assert_eq!(result["source"]["repo_root"], json!(repo_str));
        assert_eq!(result["source"]["repo_key"], json!(repo_str));
        assert_eq!(result["source"]["repo_name"], "repo");
        assert_eq!(result["source"]["source_checkout_path"], json!(lane_str));
        let paths: Vec<&str> = result["worktrees"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| row["path"].as_str().unwrap())
            .collect();
        assert!(paths.contains(&repo_str.as_str()), "main row present");
        assert!(paths.contains(&lane_str.as_str()), "lane row present");
        fs::remove_dir_all(&scratch).ok();
    }

    /// The TUI git/file panels talk to the BB socket: git.* and file.*
    /// methods must run the real operations, not the unsupported-method
    /// error the BB used to return for them.
    #[test]
    fn builtin_socket_dispatch_runs_git_and_file_ops() {
        let scratch = std::env::temp_dir().join(format!(
            "herdr-socket-dispatch-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let repo = scratch.join("repo");
        fs::create_dir_all(&repo).unwrap();
        run_git(&repo, &["init", "-q"]).unwrap();
        fs::write(repo.join("README.md"), "base\n").unwrap();
        run_git(&repo, &["add", "."]).unwrap();
        run_git(&repo, &["config", "user.email", "t@t"]).unwrap();
        run_git(&repo, &["config", "user.name", "T"]).unwrap();
        run_git(&repo, &["commit", "-q", "-m", "base"]).unwrap();

        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let cwd = repo.to_string_lossy().to_string();

        // git.status sees the clean repo
        let status = state
            .handle_request_inner("git.status", json!({ "cwd": cwd }))
            .unwrap();
        assert!(status["branch"].is_string(), "status payload: {status}");

        // git.stage + git.commit work end to end
        fs::write(repo.join("new.txt"), "content\n").unwrap();
        state
            .handle_request_inner("git.stage", json!({ "cwd": cwd, "paths": ["new.txt"] }))
            .unwrap();
        state
            .handle_request_inner("git.commit", json!({ "cwd": cwd, "title": "add new" }))
            .unwrap();
        let log = state
            .handle_request_inner("git.log", json!({ "cwd": cwd, "scope": "all", "max": 5 }))
            .unwrap();
        assert_eq!(log["commits"].as_array().map(Vec::len), Some(2));

        // git.diff for the working tree
        fs::write(repo.join("new.txt"), "changed\n").unwrap();
        let diff = state
            .handle_request_inner("git.diff", json!({ "cwd": cwd, "scope": "working" }))
            .unwrap();
        assert_eq!(diff["files"].as_array().map(Vec::len), Some(1));

        // file.tree + file.read + file.write over the socket
        let tree = state
            .handle_request_inner("file.tree", json!({ "cwd": cwd, "path": "", "depth": 0 }))
            .unwrap();
        assert!(tree["entries"].as_array().is_some(), "tree payload: {tree}");
        let read = state
            .handle_request_inner("file.read", json!({ "cwd": cwd, "path": "README.md" }))
            .unwrap();
        assert_eq!(read["content"], "base\n");
        let expected_hash = read["hash"].as_str().unwrap().to_string();
        let write = state
            .handle_request_inner(
                "file.write",
                json!({
                    "cwd": cwd,
                    "path": "README.md",
                    "content": "updated\n",
                    "expected_hash": expected_hash,
                }),
            )
            .unwrap();
        assert_eq!(write["ok"], true);
        // A stale hash must be rejected, same as over HTTP.
        let stale = state.handle_request_inner(
            "file.write",
            json!({
                "cwd": cwd,
                "path": "README.md",
                "content": "conflict\n",
                "expected_hash": "stale-hash",
            }),
        );
        assert_eq!(
            stale.unwrap_err(),
            "file changed on disk; reload before saving"
        );

        // validation flows through both dispatch tables
        let err = state
            .handle_request_inner("git.status", json!({}))
            .unwrap_err();
        assert_eq!(err, "cwd is required");
        let err = state
            .handle_request_inner("file.read", json!({ "cwd": cwd, "path": "missing.bin" }))
            .unwrap_err();
        assert_eq!(err, "path is not a file");

        fs::remove_dir_all(&scratch).ok();
    }

    #[test]
    fn builtin_worktree_open_focuses_existing_workspace_instead_of_duplicating() {
        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();

        let first = state
            .handle_request_inner(
                "worktree.open",
                json!({ "path": std::env::temp_dir().to_string_lossy() }),
            )
            .unwrap();
        let first_id = first["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(first["already_open"], false);

        // Opening the same checkout again must focus the existing workspace
        // instead of creating a duplicate one (Herdr parity).
        let second = state
            .handle_request_inner(
                "worktree.open",
                json!({ "path": std::env::temp_dir().to_string_lossy() }),
            )
            .unwrap();
        assert_eq!(second["already_open"], true);
        assert_eq!(
            second["workspace"]["workspace_id"].as_str().unwrap(),
            first_id
        );
        assert_eq!(
            state.data.lock().unwrap().focused_workspace_id.as_deref(),
            Some(first_id.as_str())
        );

        let workspaces = state.handle_request("seed", "workspace.list", json!({}));
        let workspaces = workspaces["result"]["workspaces"].as_array().unwrap();
        assert_eq!(workspaces.len(), 1, "no duplicate workspace is created");

        // A supplied label renames the already-open workspace (Herdr parity).
        let third = state
            .handle_request_inner(
                "worktree.open",
                json!({
                    "path": std::env::temp_dir().to_string_lossy(),
                    "label": "custom-label"
                }),
            )
            .unwrap();
        assert_eq!(third["already_open"], true);
        assert_eq!(third["workspace"]["label"], "custom-label");
    }

    #[test]
    fn builtin_worktree_open_creates_workspace_for_new_checkout() {
        let dir = std::env::temp_dir();
        let checkout = dir.join(format!(
            "herdr-webui-wt-open-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&checkout).unwrap();
        let state = BuiltinState::new(
            dir.clone(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();

        let result = state
            .handle_request_inner(
                "worktree.open",
                json!({ "path": checkout.to_string_lossy() }),
            )
            .unwrap();

        assert_eq!(result["already_open"], false);
        assert_eq!(
            result["workspace"]["cwd"].as_str().unwrap(),
            checkout.to_string_lossy()
        );
        assert!(result["tab"]["tab_id"].as_str().is_some());
        assert!(result["root_pane"]["pane_id"].as_str().is_some());
        fs::remove_dir_all(&checkout).ok();
    }

    #[cfg(unix)]
    #[test]
    fn builtin_worktree_open_resolves_symlinked_path_to_existing_workspace() {
        let root = std::env::temp_dir().join(format!(
            "herdr-webui-wt-symlink-{}-{}",
            std::process::id(),
            now_ms()
        ));
        fs::create_dir_all(&root).unwrap();
        let checkout = root.join("checkout");
        fs::create_dir_all(&checkout).unwrap();
        let link = root.join("link-to-checkout");
        std::os::unix::fs::symlink(&checkout, &link).unwrap();
        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();

        let first = state
            .handle_request_inner(
                "worktree.open",
                json!({ "path": checkout.to_string_lossy() }),
            )
            .unwrap();
        let first_id = first["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();

        // Opening through the symlink must focus the same workspace instead
        // of creating a duplicate (canonicalized path matching).
        let second = state
            .handle_request_inner("worktree.open", json!({ "path": link.to_string_lossy() }))
            .unwrap();
        assert_eq!(second["already_open"], true);
        assert_eq!(
            second["workspace"]["workspace_id"].as_str().unwrap(),
            first_id
        );

        let workspaces = state.handle_request("seed", "workspace.list", json!({}));
        let workspaces = workspaces["result"]["workspaces"].as_array().unwrap();
        assert_eq!(workspaces.len(), 1);
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn builtin_state_starts_without_auto_workspace() {
        let state = BuiltinState::new(
            std::env::temp_dir(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();

        let snapshot = state.handle_request("snapshot", "session.snapshot", json!({}));
        let snapshot = &snapshot["result"]["snapshot"];

        assert_eq!(snapshot["workspaces"].as_array().unwrap().len(), 0);
        assert_eq!(snapshot["tabs"].as_array().unwrap().len(), 0);
        assert_eq!(snapshot["panes"].as_array().unwrap().len(), 0);
        assert!(snapshot["focused_workspace_id"].is_null());
    }

    #[cfg(unix)]
    #[test]
    fn client_socket_accepts_webui_attach_protocol_version() {
        // Regression guard: the WebUI terminal attach client sends
        // `TerminalHello{version: PROTOCOL_VERSION}` (22 for herdr 0.9.0) and
        // the builtin backend requires an exact match. When the constants
        // drifted (client 22, builtin 20) every builtin terminal attach
        // failed with a herdr_error frame and the browser's fallback question
        // modal blocked the UI. Exercise the real client socket handshake.
        let base = format!(
            "/tmp/herdr-webui-client-hello-test-{}-{}",
            std::process::id(),
            now_ms()
        );
        let api_socket = PathBuf::from(format!("{base}-api.sock"));
        let client_socket = PathBuf::from(format!("{base}-client.sock"));
        let _handle = BuiltinBackendHandle::start(BuiltinBackendConfig {
            api_socket: api_socket.clone(),
            client_socket,
            cwd: std::env::temp_dir(),
            shell: Some(hermetic_test_shell()),
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
        })
        .unwrap();
        // Seed a workspace + tab; the root pane owns the terminal id. The api
        // socket serves one request per connection, so open two.
        let request = |line: &str| -> Value {
            let mut api = connect_local_stream(&api_socket).unwrap();
            api.write_all(line.as_bytes()).unwrap();
            api.write_all(b"\n").unwrap();
            api.flush().unwrap();
            let mut reader = BufReader::new(api);
            let mut out = String::new();
            reader.read_line(&mut out).unwrap();
            serde_json::from_str(&out).unwrap()
        };
        let workspace =
            request(r#"{"id":"seed","method":"workspace.create","params":{"label":"handshake"}}"#);
        let workspace_id = workspace["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        let tab = request(&format!(
            r#"{{"id":"tab","method":"tab.create","params":{{"workspace_id":"{workspace_id}"}}}}"#
        ));
        let terminal_id = tab["result"]["root_pane"]["terminal_id"]
            .as_str()
            .unwrap()
            .to_string();

        // The exact handshake the WebUI attach path performs.
        let mut client =
            connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
        write_message(
            &mut client,
            &ClientMessage::TerminalHello {
                version: 22,
                cols: 80,
                rows: 24,
                cell_width_px: 0,
                cell_height_px: 0,
                pixel_mouse: false,
            },
        )
        .unwrap();
        match read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE).unwrap() {
            ServerMessage::Welcome { error: None, .. } => {}
            ServerMessage::Welcome {
                error: Some(err), ..
            } => {
                panic!("builtin backend rejected the WebUI attach version: {err}")
            }
            other => panic!("expected Welcome, got {other:?}"),
        }
        write_message(
            &mut client,
            &ClientMessage::AttachTerminal {
                terminal_id,
                takeover: true,
            },
        )
        .unwrap();
        match read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE).unwrap() {
            ServerMessage::Terminal(_) => {}
            other => panic!("expected Terminal frame after attach, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn client_socket_overflow_sheds_stalled_reader_with_shutdown_frame() {
        // A client that stops reading must be shed, but never silently: the
        // writer drains the buffered backlog, then delivers an explicit
        // shutdown frame so the client sees why the stream ended instead of
        // blocking on read_message forever.
        let base = format!(
            "/tmp/herdr-webui-overflow-test-{}-{}",
            std::process::id(),
            now_ms()
        );
        let api_socket = PathBuf::from(format!("{base}-api.sock"));
        let client_socket = PathBuf::from(format!("{base}-client.sock"));
        let _handle = BuiltinBackendHandle::start(BuiltinBackendConfig {
            api_socket: api_socket.clone(),
            client_socket,
            cwd: std::env::temp_dir(),
            shell: Some(hermetic_test_shell()),
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
        })
        .unwrap();
        let request = |line: &str| -> Value {
            let mut api = connect_local_stream(&api_socket).unwrap();
            api.write_all(line.as_bytes()).unwrap();
            api.write_all(b"\n").unwrap();
            api.flush().unwrap();
            let mut reader = BufReader::new(api);
            let mut out = String::new();
            reader.read_line(&mut out).unwrap();
            serde_json::from_str(&out).unwrap()
        };
        let workspace =
            request(r#"{"id":"seed","method":"workspace.create","params":{"label":"overflow"}}"#);
        let workspace_id = workspace["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        let tab = request(&format!(
            r#"{{"id":"tab","method":"tab.create","params":{{"workspace_id":"{workspace_id}"}}}}"#
        ));
        let terminal_id = tab["result"]["root_pane"]["terminal_id"]
            .as_str()
            .unwrap()
            .to_string();
        let pane_id = tab["result"]["root_pane"]["pane_id"]
            .as_str()
            .unwrap()
            .to_string();

        let mut client =
            connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
        write_message(
            &mut client,
            &ClientMessage::TerminalHello {
                version: 22,
                cols: 80,
                rows: 24,
                cell_width_px: 0,
                cell_height_px: 0,
                pixel_mouse: false,
            },
        )
        .unwrap();
        read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE).unwrap();
        write_message(
            &mut client,
            &ClientMessage::AttachTerminal {
                terminal_id,
                takeover: true,
            },
        )
        .unwrap();

        // Flood far past MAX_SUBSCRIBER_PENDING_BYTES without reading.
        // dd streams from the kernel at PTY speed; the printf/seq form
        // formats 3M arguments in the shell itself and stalls before the
        // PTY ever fills. The burst is finite and bigger than the cap, so
        // once the flood is done the writer can drain and deliver the
        // shutdown notice.
        write_message(
            &mut client,
            &ClientMessage::Input {
                // The PTY echoes the typed command itself, so the marker the
                // poll waits for must not appear in the command text: print
                // the two halves separately so scrollback only shows the
                // joined marker once the flood has actually finished.
                data: b"dd if=/dev/zero bs=1024 count=65536 2>/dev/null; printf 'FLOOD-' ; printf 'DONE\\n'\n".to_vec(),
            },
        )
        .unwrap();

        // Keep the client stalled until the flood FINISHES producing, not
        // for a fixed time: under parallel-suite load dd can underrun any
        // wall-clock window, and once the test starts reading it drains at
        // line rate so pending never crosses the cap. Poll server-side
        // scrollback over the API for the FLOOD-DONE marker instead; the
        // client socket stays unread the whole time, so the shed is
        // deterministic. The marker is split in the command so the PTY's
        // echo of the typed command cannot satisfy the poll early.
        let flood_deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let read = request(&format!(
                r#"{{"id":"read","method":"pane.read","params":{{"pane_id":"{pane_id}"}}}}"#
            ));
            if read["result"]["read"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("FLOOD-DONE"))
            {
                break;
            }
            assert!(
                Instant::now() < flood_deadline,
                "flood never finished; pane.read keeps racing the client stream"
            );
            thread::sleep(Duration::from_millis(50));
        }
        let mut saw_shutdown = false;
        // A silent socket blocks read_message forever; the deadline below is
        // only checked between frames. read_message cannot be retried on a
        // timeout either: EAGAIN between its two read_exact calls loses the
        // frame boundary. So drain bytes into a buffer with a short recv
        // timeout and decode whole frames from it; an EAGAIN with zero new
        // bytes just re-loops without touching sync.
        client
            .set_recv_timeout(Some(Duration::from_millis(250)))
            .unwrap();
        let mut pending: Vec<u8> = Vec::new();
        let mut scratch = [0u8; 16384];
        let mut diag_frames: usize = 0;
        let mut diag_bytes: usize = 0;
        let deadline = Instant::now() + Duration::from_secs(120);
        'wait: while Instant::now() < deadline {
            use std::io::Read as _;
            loop {
                match client.read(&mut scratch) {
                    Ok(0) => panic!("overflowed client stream closed before shutdown"),
                    Ok(n) => {
                        pending.extend_from_slice(&scratch[..n]);
                        diag_bytes += n;
                    }
                    // macOS surfaces an expired recv timeout as EAGAIN.
                    Err(ref err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                        break;
                    }
                    Err(ref err) if err.kind() == std::io::ErrorKind::TimedOut => break,
                    Err(err) => panic!("overflowed client stream broke: {err}"),
                }
            }
            // Frames on the wire are 4-byte LE length + bincode payload
            // (write_message). Decode only complete frames so a partial
            // tail waits for more bytes instead of losing sync.
            loop {
                if pending.len() < 4 {
                    break;
                }
                let len =
                    u32::from_le_bytes([pending[0], pending[1], pending[2], pending[3]]) as usize;
                assert!(
                    len <= MAX_FRAME_SIZE,
                    "overflowed stream frame size {len} exceeds {MAX_FRAME_SIZE}"
                );
                if pending.len() < 4 + len {
                    break;
                }
                let (message, consumed) = bincode::serde::decode_from_slice::<ServerMessage, _>(
                    &pending[4..4 + len],
                    bincode::config::standard(),
                )
                .expect("overflowed stream frame failed to decode");
                assert_eq!(consumed, len, "overflowed stream frame has trailing bytes");
                pending.drain(..4 + len);
                diag_frames += 1;
                match message {
                    ServerMessage::Terminal(_) => {}
                    ServerMessage::ServerShutdown { reason } => {
                        let reason = reason.unwrap_or_default();
                        assert!(
                            reason.contains("overflow"),
                            "expected overflow shutdown, got {reason}"
                        );
                        saw_shutdown = true;
                        break 'wait;
                    }
                    _ => {}
                }
            }
        }
        assert!(
            saw_shutdown,
            "stalled reader was never shed or got no shutdown frame (frames={diag_frames}, bytes={diag_bytes})"
        );
    }

    #[cfg(unix)]
    #[test]
    fn builtin_api_stays_responsive_while_pane_floods() {
        // The shed test covers the subscriber path. This one covers the API
        // surface the WebUI leans on while a pane floods: pane.conversation,
        // pane.tool_output, and pane.read must each answer in bounded time
        // even while the PTY reader keeps appending and the scrollback lock
        // is hot. A plain-shell pane refuses conversation/tool_output with
        // unsupported_agent BEFORE any transcript work, so the assertion is
        // the refusal arriving quickly, not its content; pane.read has real
        // work (full-scrollback copy + ANSI strip) and must still finish.
        //
        // Why the refusal path is the right fidelity here: once an agent
        // check passes, conversation work reads transcript FILES (bounded,
        // disjoint from scrollback) plus pane_context, whose only
        // scrollback touch is the 64KB tail strip (RESOLVE_TAIL_BYTES),
        // cheap next to the full-scrollback strip (bounded by
        // MAX_SCROLLBACK_BYTES) this loop exercises on every pane.read.
        // Serving real turns mid-flood would need the backend's
        // process-global store_index() pointed at a fixture store (it
        // hardwires ~/.jcode/sessions today), a production refactor out
        // of scope for flood robustness; the payload-building half is
        // covered by the chat_lens unit tests.
        let base = format!(
            "/tmp/herdr-webui-flood-api-test-{}-{}",
            std::process::id(),
            now_ms()
        );
        let api_socket = PathBuf::from(format!("{base}-api.sock"));
        let client_socket = PathBuf::from(format!("{base}-client.sock"));
        let _handle = BuiltinBackendHandle::start(BuiltinBackendConfig {
            api_socket: api_socket.clone(),
            client_socket,
            cwd: std::env::temp_dir(),
            shell: Some(hermetic_test_shell()),
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
        })
        .unwrap();
        let request = |line: &str| -> Value {
            let mut api = connect_local_stream(&api_socket).unwrap();
            api.write_all(line.as_bytes()).unwrap();
            api.write_all(b"\n").unwrap();
            api.flush().unwrap();
            let mut reader = BufReader::new(api);
            let mut out = String::new();
            reader.read_line(&mut out).unwrap();
            serde_json::from_str(&out).unwrap()
        };
        let workspace =
            request(r#"{"id":"seed","method":"workspace.create","params":{"label":"flood-api"}}"#);
        let workspace_id = workspace["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        let tab = request(&format!(
            r#"{{"id":"tab","method":"tab.create","params":{{"workspace_id":"{workspace_id}"}}}}"#
        ));
        let pane_id = tab["result"]["root_pane"]["pane_id"]
            .as_str()
            .unwrap()
            .to_string();

        // Sustained flood past the 8MB scrollback cap. Generated in the
        // shell (MAX_CANON drops typed lines over 4096 bytes), split in
        // two printfs so the echoed command cannot satisfy the poll early.
        let flood = request(&format!(
            r#"{{"id":"prompt","method":"agent.prompt","params":{{"pane_id":"{pane_id}","text":"dd if=/dev/zero bs=1024 count=131072 2>/dev/null; printf 'FLOOD-' ; printf 'DONE\\n'"}}}}"#
        ));
        assert_eq!(flood["result"]["ok"], Value::Bool(true), "flood must start");

        // While dd streams, hammer the API. Each call gets a generous
        // per-call bound (suite load can starve this thread badly) but a
        // hang shows up as the deadline expiring without the answer.
        let per_call_bound = Duration::from_secs(30);
        let mut worst_conversation = Duration::ZERO;
        let mut worst_tool_output = Duration::ZERO;
        let mut worst_read = Duration::ZERO;
        let overall = Instant::now() + Duration::from_secs(120);
        let mut conversation_refusals = 0;
        let mut tool_output_refusals = 0;
        let mut reads = 0;
        while Instant::now() < overall {
            let started = Instant::now();
            let conversation = request(&format!(
                r#"{{"id":"conv","method":"pane.conversation","params":{{"pane_id":"{pane_id}"}}}}"#
            ));
            assert!(
                started.elapsed() < per_call_bound,
                "pane.conversation stalled"
            );
            worst_conversation = worst_conversation.max(started.elapsed());
            let err = conversation["error"]["message"]
                .as_str()
                .unwrap_or_default();
            assert!(
                err.starts_with("unsupported_agent"),
                "plain shell must refuse conversation, got {err}"
            );
            conversation_refusals += 1;

            let started = Instant::now();
            let tool_output = request(&format!(
                r#"{{"id":"tool","method":"pane.tool_output","params":{{"pane_id":"{pane_id}","ref":"does-not-exist"}}}}"#
            ));
            assert!(
                started.elapsed() < per_call_bound,
                "pane.tool_output stalled"
            );
            worst_tool_output = worst_tool_output.max(started.elapsed());
            let err = tool_output["error"]["message"].as_str().unwrap_or_default();
            assert!(
                err.starts_with("unsupported_agent"),
                "plain shell must refuse tool_output, got {err}"
            );
            tool_output_refusals += 1;

            let started = Instant::now();
            let read = request(&format!(
                r#"{{"id":"read","method":"pane.read","params":{{"pane_id":"{pane_id}"}}}}"#
            ));
            assert!(started.elapsed() < per_call_bound, "pane.read stalled");
            worst_read = worst_read.max(started.elapsed());
            assert!(
                read["result"]["read"]["text"].as_str().is_some(),
                "pane.read must return text during the flood"
            );
            reads += 1;

            // End the loop once the flood finished: the marker only shows
            // up in scrollback after dd completed, so surviving requests
            // prove responsiveness across the whole flood.
            if read["result"]["read"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("FLOOD-DONE"))
            {
                break;
            }
        }
        assert!(
            conversation_refusals > 0 && tool_output_refusals > 0 && reads > 0,
            "no requests completed during the flood"
        );
        // Tight post-flood regression bounds, measured under full-suite
        // parallel load (solo run: refusals ~0.2ms, pane.read ~20ms for the
        // 8MB copy+strip). An order of magnitude over those catches a real
        // stall without flaking on a starved CI runner. pane.read gets more
        // headroom than the refusals: its cost scales with scrollback fill
        // (up to MAX_SCROLLBACK_BYTES) and a loaded runner can inflate the
        // copy+strip well past the solo measurement.
        assert!(
            worst_conversation < Duration::from_secs(1),
            "pane.conversation regression: worst {worst_conversation:?}"
        );
        assert!(
            worst_tool_output < Duration::from_secs(1),
            "pane.tool_output regression: worst {worst_tool_output:?}"
        );
        assert!(
            worst_read < Duration::from_secs(5),
            "pane.read regression: worst {worst_read:?}"
        );
        // Sanity: the flood actually filled the scrollback past its cap.
        let read = request(&format!(
            r#"{{"id":"final","method":"pane.read","params":{{"pane_id":"{pane_id}"}}}}"#
        ));
        let text_len = read["result"]["read"]["text"]
            .as_str()
            .map(str::len)
            .unwrap_or(0);
        assert!(
            text_len <= MAX_SCROLLBACK_BYTES,
            "pane.read text must be bounded by the scrollback cap, got {text_len}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn client_socket_second_attach_on_same_connection_replays_history() {
        // The writer thread starts once per connection; a re-attach on the
        // same connection must still deliver a fresh replay frame of the
        // history accumulated since the last attach.
        let base = format!(
            "/tmp/herdr-webui-reattach-test-{}-{}",
            std::process::id(),
            now_ms()
        );
        let api_socket = PathBuf::from(format!("{base}-api.sock"));
        let client_socket = PathBuf::from(format!("{base}-client.sock"));
        let _handle = BuiltinBackendHandle::start(BuiltinBackendConfig {
            api_socket: api_socket.clone(),
            client_socket,
            cwd: std::env::temp_dir(),
            shell: Some(hermetic_test_shell()),
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
        })
        .unwrap();
        let request = |line: &str| -> Value {
            let mut api = connect_local_stream(&api_socket).unwrap();
            api.write_all(line.as_bytes()).unwrap();
            api.write_all(b"\n").unwrap();
            api.flush().unwrap();
            let mut reader = BufReader::new(api);
            let mut out = String::new();
            reader.read_line(&mut out).unwrap();
            serde_json::from_str(&out).unwrap()
        };
        let workspace =
            request(r#"{"id":"seed","method":"workspace.create","params":{"label":"reattach"}}"#);
        let workspace_id = workspace["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        let tab = request(&format!(
            r#"{{"id":"tab","method":"tab.create","params":{{"workspace_id":"{workspace_id}"}}}}"#
        ));
        let terminal_id = tab["result"]["root_pane"]["terminal_id"]
            .as_str()
            .unwrap()
            .to_string();

        let mut client =
            connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
        write_message(
            &mut client,
            &ClientMessage::TerminalHello {
                version: 22,
                cols: 80,
                rows: 24,
                cell_width_px: 0,
                cell_height_px: 0,
                pixel_mouse: false,
            },
        )
        .unwrap();
        read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE).unwrap();

        // Seed real scrollback BEFORE the first attach so the first replay
        // charges a large pending_bytes debt. The historical wrap bug only
        // shed a re-attached client when the first-attach history exceeded
        // the next live output chunk: each subsequent chunk fetch_add's its
        // own length, which wraps a small debt back below the shed cap, so
        // a near-empty first history masks the bug exactly like the original
        // test did.
        {
            let mut seeder =
                connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
            write_message(
                &mut seeder,
                &ClientMessage::TerminalHello {
                    version: 22,
                    cols: 80,
                    rows: 24,
                    cell_width_px: 0,
                    cell_height_px: 0,
                    pixel_mouse: false,
                },
            )
            .unwrap();
            read_message::<_, ServerMessage>(&mut seeder, MAX_FRAME_SIZE).unwrap();
            write_message(
                &mut seeder,
                &ClientMessage::AttachTerminal {
                    terminal_id: terminal_id.clone(),
                    takeover: true,
                },
            )
            .unwrap();
            // Drain the seeder's own replay frame.
            match read_message::<_, ServerMessage>(&mut seeder, MAX_FRAME_SIZE).unwrap() {
                ServerMessage::Terminal(frame) => assert!(frame.full),
                other => panic!("expected seeder replay frame, got {other:?}"),
            }
            write_message(
                &mut seeder,
                &ClientMessage::Input {
                    data: b"for i in $(seq 1 2000); do echo SEED-$i; done\n".to_vec(),
                },
            )
            .unwrap();
            // Wait until the seed lines land in scrollback: without this the
            // first attach can race the PTY echo and replay an empty (or
            // partial) history, reintroducing the small-debt mask.
            seeder
                .set_recv_timeout(Some(Duration::from_millis(250)))
                .unwrap();
            let mut seeded_bytes = 0_usize;
            let deadline = Instant::now() + Duration::from_secs(20);
            while seeded_bytes < 12_000 && Instant::now() < deadline {
                match read_message::<_, ServerMessage>(&mut seeder, MAX_FRAME_SIZE) {
                    Ok(ServerMessage::Terminal(frame)) => {
                        seeded_bytes += frame.bytes.len();
                    }
                    Ok(_) => {}
                    Err(ref err)
                        if err.contains("timed out")
                            || err.contains("Resource temporarily unavailable") =>
                    {
                        continue
                    }
                    Err(err) => panic!("seeder stream broke: {err}"),
                }
            }
            assert!(
                seeded_bytes >= 12_000,
                "seed output never reached scrollback (only {seeded_bytes} bytes)"
            );
            // The seeder connection is deliberately left unread from now on;
            // dropping it unsubscribes its writer thread on send failure.
            drop(seeder);
        }

        write_message(
            &mut client,
            &ClientMessage::AttachTerminal {
                terminal_id: terminal_id.clone(),
                takeover: true,
            },
        )
        .unwrap();
        // Drain the first replay.
        match read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE).unwrap() {
            ServerMessage::Terminal(frame) => assert!(frame.full),
            other => panic!("expected replay frame, got {other:?}"),
        }
        // Produce output, wait for it to land in scrollback, then re-attach
        // on the same connection and demand a fresh replay containing it.
        write_message(
            &mut client,
            &ClientMessage::Input {
                data: b"echo REATTACH-MARKER\n".to_vec(),
            },
        )
        .unwrap();
        let mut saw_marker = false;
        // Mute-socket guard: without a recv timeout a missing marker hangs
        // read_message past every deadline below.
        client
            .set_recv_timeout(Some(Duration::from_millis(250)))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE) {
                Ok(ServerMessage::Terminal(frame)) => {
                    if String::from_utf8_lossy(&frame.bytes).contains("REATTACH-MARKER") {
                        saw_marker = true;
                        break;
                    }
                }
                Ok(_) => {}
                // read_message wraps io errors in Strings; the recv timeout
                // surfaces as either phrasing depending on platform.
                Err(ref err)
                    if err.contains("timed out")
                        || err.contains("Resource temporarily unavailable") =>
                {
                    continue
                }
                Err(err) => panic!("reattach stream broke: {err}"),
            }
        }
        assert!(saw_marker, "marker never streamed before re-attach");
        write_message(
            &mut client,
            &ClientMessage::AttachTerminal {
                terminal_id,
                takeover: true,
            },
        )
        .unwrap();
        let mut replay_has_marker = false;
        // Same mute-socket guard as the shed test: read_message blocks
        // forever on a silent stream and the deadline below only runs
        // between frames. A short recv timeout converts the stall into
        // deadline lapses; EAGAIN on an empty buffer keeps frame sync.
        client
            .set_recv_timeout(Some(Duration::from_millis(250)))
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE) {
                Ok(ServerMessage::Terminal(frame)) => {
                    if frame.full {
                        replay_has_marker =
                            String::from_utf8_lossy(&frame.bytes).contains("REATTACH-MARKER");
                        break;
                    }
                }
                Ok(_) => {}
                // read_message wraps io errors in Strings; the recv timeout
                // surfaces as either phrasing depending on platform.
                Err(ref err)
                    if err.contains("timed out")
                        || err.contains("Resource temporarily unavailable") =>
                {
                    continue
                }
                Err(err) => panic!("reattach replay stream broke: {err}"),
            }
        }
        assert!(
            replay_has_marker,
            "second attach on same connection did not replay history"
        );

        // Regression: the re-attach replay used to leave pending_bytes
        // unbalanced (writer subtracted the first attach's capture, the
        // re-attach send charged nothing), the counter wrapped to near
        // usize::MAX, and the very next output byte shed a healthy
        // re-attached client with "output backlog overflow". Prove the
        // counter stays balanced: produce output AFTER the second attach
        // and require the live marker frame. A shed arrives as
        // ServerShutdown AFTER the queued frames drain, so keep reading
        // past the marker for a grace period; any shutdown in that window
        // is the wrap bug firing.
        write_message(
            &mut client,
            &ClientMessage::Input {
                data: b"echo POST-REATTACH-MARKER\n".to_vec(),
            },
        )
        .unwrap();
        let mut saw_post_marker = false;
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE) {
                Ok(ServerMessage::Terminal(frame)) => {
                    if String::from_utf8_lossy(&frame.bytes).contains("POST-REATTACH-MARKER") {
                        saw_post_marker = true;
                        // Marker seen. The wrap bug sheds on the chunk
                        // FOLLOWING the re-attach replay, which may already
                        // be flushed; give the writer thread a moment to
                        // surface a delayed shutdown before declaring
                        // success.
                        thread::sleep(Duration::from_millis(500));
                    }
                }
                Ok(ServerMessage::ServerShutdown { reason }) => {
                    panic!("re-attached client was shed after second attach: {reason:?}")
                }
                Ok(_) => {}
                Err(ref err)
                    if err.contains("timed out")
                        || err.contains("Resource temporarily unavailable") =>
                {
                    // Silent socket past the marker: nothing more is coming,
                    // which is exactly the healthy path.
                    if saw_post_marker {
                        break;
                    }
                    continue;
                }
                Err(err) => panic!("post-reattach stream broke: {err}"),
            }
        }
        assert!(
            saw_post_marker,
            "output after second attach never streamed; pending_bytes wrap shed the client"
        );
    }

    #[cfg(unix)]
    #[test]
    fn client_socket_disconnected_client_is_dropped_from_fanout() {
        // A dead connection must leave the subscriber list so its queue stops
        // growing; otherwise every later append_output pays an Err send and a
        // pending_bytes add/sub pair for a client that is long gone.
        let base = format!(
            "/tmp/herdr-webui-disconnect-test-{}-{}",
            std::process::id(),
            now_ms()
        );
        let api_socket = PathBuf::from(format!("{base}-api.sock"));
        let client_socket = PathBuf::from(format!("{base}-client.sock"));
        let _handle = BuiltinBackendHandle::start(BuiltinBackendConfig {
            api_socket: api_socket.clone(),
            client_socket,
            cwd: std::env::temp_dir(),
            shell: Some(hermetic_test_shell()),
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
        })
        .unwrap();
        let request = |line: &str| -> Value {
            let mut api = connect_local_stream(&api_socket).unwrap();
            api.write_all(line.as_bytes()).unwrap();
            api.write_all(b"\n").unwrap();
            api.flush().unwrap();
            let mut reader = BufReader::new(api);
            let mut out = String::new();
            reader.read_line(&mut out).unwrap();
            serde_json::from_str(&out).unwrap()
        };
        let workspace =
            request(r#"{"id":"seed","method":"workspace.create","params":{"label":"disconnect"}}"#);
        let workspace_id = workspace["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        let tab = request(&format!(
            r#"{{"id":"tab","method":"tab.create","params":{{"workspace_id":"{workspace_id}"}}}}"#
        ));
        let terminal_id = tab["result"]["root_pane"]["terminal_id"]
            .as_str()
            .unwrap()
            .to_string();

        // Attach, consume the replay, then close the socket without Detach.
        let mut client =
            connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
        write_message(
            &mut client,
            &ClientMessage::TerminalHello {
                version: 22,
                cols: 80,
                rows: 24,
                cell_width_px: 0,
                cell_height_px: 0,
                pixel_mouse: false,
            },
        )
        .unwrap();
        read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE).unwrap();
        write_message(
            &mut client,
            &ClientMessage::AttachTerminal {
                terminal_id,
                takeover: true,
            },
        )
        .unwrap();
        read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE).unwrap();
        drop(client);

        // Keep producing output after the disconnect; nothing may panic and a
        // fresh attach must still receive live output.
        let mut second =
            connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
        write_message(
            &mut second,
            &ClientMessage::TerminalHello {
                version: 22,
                cols: 80,
                rows: 24,
                cell_width_px: 0,
                cell_height_px: 0,
                pixel_mouse: false,
            },
        )
        .unwrap();
        read_message::<_, ServerMessage>(&mut second, MAX_FRAME_SIZE).unwrap();
        write_message(
            &mut second,
            &ClientMessage::AttachTerminal {
                terminal_id: tab["result"]["root_pane"]["terminal_id"]
                    .as_str()
                    .unwrap()
                    .to_string(),
                takeover: true,
            },
        )
        .unwrap();
        read_message::<_, ServerMessage>(&mut second, MAX_FRAME_SIZE).unwrap();
        write_message(
            &mut second,
            &ClientMessage::Input {
                data: b"echo AFTER-DISCONNECT-MARKER\n".to_vec(),
            },
        )
        .unwrap();
        let mut saw_marker = false;
        let deadline = Instant::now() + Duration::from_secs(20);
        while Instant::now() < deadline {
            match read_message::<_, ServerMessage>(&mut second, MAX_FRAME_SIZE) {
                Ok(ServerMessage::Terminal(frame)) => {
                    if String::from_utf8_lossy(&frame.bytes).contains("AFTER-DISCONNECT-MARKER") {
                        saw_marker = true;
                        break;
                    }
                }
                Ok(_) => {}
                Err(err) => panic!("post-disconnect attach stream broke: {err}"),
            }
        }
        assert!(
            saw_marker,
            "fresh attach saw no live output after a dead subscriber"
        );
    }

    #[cfg(unix)]
    #[test]
    fn client_socket_replay_survives_output_flood_during_attach() {
        // Regression guard: the attach replay frame and live output frames
        // used to be written from two threads on the same dup'ed socket, so a
        // PTY output burst racing the attach replay interleaved `write_all`
        // sequences mid-frame. The reader then failed with "trailing bytes in
        // frame" and whole bursts were lost. Drive a flood through a second
        // attach while the first one replays, then prove the stream stays
        // frame-exact and every flooded line is delivered.
        let base = format!(
            "/tmp/herdr-webui-flood-test-{}-{}",
            std::process::id(),
            now_ms()
        );
        let api_socket = PathBuf::from(format!("{base}-api.sock"));
        let client_socket = PathBuf::from(format!("{base}-client.sock"));
        let _handle = BuiltinBackendHandle::start(BuiltinBackendConfig {
            api_socket: api_socket.clone(),
            client_socket,
            cwd: std::env::temp_dir(),
            shell: Some(hermetic_test_shell()),
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
        })
        .unwrap();
        let request = |line: &str| -> Value {
            let mut api = connect_local_stream(&api_socket).unwrap();
            api.write_all(line.as_bytes()).unwrap();
            api.write_all(b"\n").unwrap();
            api.flush().unwrap();
            let mut reader = BufReader::new(api);
            let mut out = String::new();
            reader.read_line(&mut out).unwrap();
            serde_json::from_str(&out).unwrap()
        };
        let workspace =
            request(r#"{"id":"seed","method":"workspace.create","params":{"label":"flood"}}"#);
        let workspace_id = workspace["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        let tab = request(&format!(
            r#"{{"id":"tab","method":"tab.create","params":{{"workspace_id":"{workspace_id}"}}}}"#
        ));
        let terminal_id = tab["result"]["root_pane"]["terminal_id"]
            .as_str()
            .unwrap()
            .to_string();

        let attach = || -> LocalStream {
            let mut client =
                connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
            write_message(
                &mut client,
                &ClientMessage::TerminalHello {
                    version: 22,
                    cols: 80,
                    rows: 24,
                    cell_width_px: 0,
                    cell_height_px: 0,
                    pixel_mouse: false,
                },
            )
            .unwrap();
            match read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE).unwrap() {
                ServerMessage::Welcome { error: None, .. } => {}
                ServerMessage::Welcome {
                    error: Some(err), ..
                } => panic!("builtin backend rejected attach: {err}"),
                other => panic!("expected Welcome, got {other:?}"),
            }
            write_message(
                &mut client,
                &ClientMessage::AttachTerminal {
                    terminal_id: terminal_id.clone(),
                    takeover: true,
                },
            )
            .unwrap();
            client
        };

        // Attach the driver first, then flood while it streams, then race
        // fresh attaches against the running burst: each new connection's
        // attach replay used to be written from the connection loop while
        // that connection's own writer thread (subscribed microseconds
        // earlier) pumped live output, interleaving two `write_all` sequences
        // mid-frame on the dup'ed socket. The readers here decode every
        // frame; the old interleaving surfaced as "trailing bytes in frame"
        // within a few mid-flood attaches.
        let mut driver = attach();
        let driver_stream = Arc::new(Mutex::new(String::new()));
        let driver_reader = {
            let driver_stream = Arc::clone(&driver_stream);
            let driver = driver.try_clone().expect("clone driver socket");
            thread::spawn(move || {
                let mut client = driver;
                let deadline = Instant::now() + Duration::from_secs(60);
                while Instant::now() < deadline {
                    match read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE) {
                        Ok(ServerMessage::Terminal(frame)) => {
                            let text = String::from_utf8_lossy(&frame.bytes);
                            driver_stream
                                .lock()
                                .expect("driver stream lock")
                                .push_str(&text);
                            if text.contains("FLOOD_DONE") {
                                break;
                            }
                        }
                        Ok(ServerMessage::ServerShutdown { .. }) => break,
                        Ok(_) => {}
                        Err(err) => panic!("driver attach stream broke: {err}"),
                    }
                }
            })
        };
        write_message(
            &mut driver,
            &ClientMessage::Input {
                data: b"printf 'FLOOD-LINE-%05d\\n' $(seq 1 60000); echo FLOOD_\"DONE\"\n".to_vec(),
            },
        )
        .unwrap();

        // Attach fresh connections while the burst streams. Each attach gets
        // a replay of the history accumulated so far (which keeps growing,
        // so replay writes get longer and race harder) plus the live tail.
        let mut probe_lines = 0usize;
        for _ in 0..4 {
            thread::sleep(Duration::from_millis(30));
            let probe = attach();
            let probe_reader = thread::spawn(move || {
                let mut client = probe;
                let mut stream = String::new();
                let deadline = Instant::now() + Duration::from_secs(60);
                while Instant::now() < deadline {
                    match read_message::<_, ServerMessage>(&mut client, MAX_FRAME_SIZE) {
                        Ok(ServerMessage::Terminal(frame)) => {
                            stream.push_str(&String::from_utf8_lossy(&frame.bytes));
                            if stream.contains("FLOOD_DONE") {
                                break;
                            }
                        }
                        Ok(ServerMessage::ServerShutdown { .. }) => break,
                        Ok(_) => {}
                        Err(err) => panic!("mid-flood attach stream broke: {err}"),
                    }
                }
                stream.matches("FLOOD-LINE-").count()
            });
            probe_lines += probe_reader.join().expect("probe reader panicked");
        }
        driver_reader.join().expect("driver reader panicked");
        let driver_lines = driver_stream
            .lock()
            .expect("driver stream lock")
            .matches("FLOOD-LINE-")
            .count();

        assert!(
            driver_lines >= 60000,
            "driver attach lost flood output: saw {driver_lines} of 60000 FLOOD-LINE markers"
        );
        assert!(
            probe_lines > 0,
            "mid-flood attaches saw no flood output (driver saw {driver_lines})"
        );
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
            shell: Some(hermetic_test_shell()),
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
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
            shell: Some(hermetic_test_shell()),
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
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

    #[test]
    fn closing_last_tab_keeps_workspace_alive() {
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let workspace = state.handle_request(
            "seed",
            "workspace.create",
            json!({ "label": "Test Workspace" }),
        );
        let workspace_id = workspace["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        let tab_id = workspace["result"]["tab"]["tab_id"]
            .as_str()
            .unwrap()
            .to_string();

        // Subscribe to events before closing
        let rx = state.subscribe_events();

        // Close the only tab
        state.handle_request("close", "tab.close", json!({ "tab_id": tab_id }));

        // The workspace survives with zero tabs: terminals are decoupled
        // from workspace lifecycle.
        let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
        let workspaces = snapshot["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap();
        assert_eq!(
            workspaces.len(),
            1,
            "workspace must survive closing its last tab"
        );
        assert_eq!(
            workspaces[0]["workspace_id"],
            workspace_id.as_str(),
            "the surviving workspace must be the one whose tab closed"
        );
        let tabs = snapshot["result"]["snapshot"]["tabs"].as_array().unwrap();
        assert!(tabs.is_empty(), "the closed tab must be gone");
        // Focus stays on the zero-tab workspace itself.
        assert_eq!(
            snapshot["result"]["snapshot"]["focused_workspace_id"],
            workspace_id.as_str()
        );
        assert_eq!(
            snapshot["result"]["snapshot"]["focused_tab_id"],
            Value::Null,
            "zero-tab workspace focuses no tab"
        );

        // tab.closed fires; workspace.closed must NOT fire for this close.
        let mut got_tab_closed = false;
        while let Ok(event) = rx.recv_timeout(Duration::from_millis(500)) {
            if event["event"] == "tab.closed" {
                got_tab_closed = true;
                assert_eq!(event["data"]["tab_id"], tab_id);
            }
            assert_ne!(
                event["event"], "workspace.closed",
                "closing a terminal must never close the workspace"
            );
        }
        assert!(got_tab_closed, "tab.closed event should be emitted");
    }

    #[test]
    fn closing_last_pane_closes_tab_but_keeps_workspace() {
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let workspace = state.handle_request(
            "seed",
            "workspace.create",
            json!({ "label": "Test Workspace" }),
        );
        let workspace_id = workspace["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        let tab_id = workspace["result"]["tab"]["tab_id"]
            .as_str()
            .unwrap()
            .to_string();
        let pane_id = workspace["result"]["root_pane"]["pane_id"]
            .as_str()
            .unwrap()
            .to_string();

        // Subscribe to events before closing
        let rx = state.subscribe_events();

        // Close the only pane
        state.handle_request("close", "pane.close", json!({ "pane_id": pane_id }));

        // Pane→tab cascade stays: the emptied tab closes. The workspace
        // survives with zero tabs.
        let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
        let workspaces = snapshot["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap();
        assert_eq!(
            workspaces.len(),
            1,
            "workspace must survive closing its last pane"
        );
        assert_eq!(
            workspaces[0]["workspace_id"],
            workspace_id.as_str(),
            "the surviving workspace must be the one whose pane closed"
        );
        let tabs = snapshot["result"]["snapshot"]["tabs"].as_array().unwrap();
        assert!(
            tabs.is_empty(),
            "tab should be auto-closed when last pane closes"
        );

        // Collect events: tab.closed yes, workspace.closed no.
        let mut got_tab_closed = false;
        while let Ok(event) = rx.recv_timeout(Duration::from_millis(500)) {
            if event["event"] == "tab.closed" {
                got_tab_closed = true;
                assert_eq!(event["data"]["tab_id"], tab_id);
            }
            assert_ne!(
                event["event"], "workspace.closed",
                "closing a terminal must never close the workspace"
            );
        }
        assert!(got_tab_closed, "tab.closed event should be emitted");
    }

    #[test]
    fn workspace_create_open_terminal_false_mints_no_tab() {
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let response = state.handle_request(
            "seed",
            "workspace.create",
            json!({ "label": "NoTerminal", "open_terminal": false }),
        );
        let workspace_id = response["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            response["result"]["tab"],
            json!({}),
            "open_terminal=false must not mint a Shell tab"
        );
        assert_eq!(
            response["result"]["root_pane"],
            json!({}),
            "open_terminal=false must not mint a root pane"
        );

        let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
        let workspaces = snapshot["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0]["workspace_id"], workspace_id.as_str());
        assert_eq!(workspaces[0]["tab_count"].as_i64().unwrap_or(0), 0);
        let tabs = snapshot["result"]["snapshot"]["tabs"].as_array().unwrap();
        assert!(tabs.is_empty());
        let panes = snapshot["result"]["snapshot"]["panes"].as_array().unwrap();
        assert!(panes.is_empty());

        // Focus lands on the workspace itself with no tab/pane.
        assert_eq!(
            snapshot["result"]["snapshot"]["focused_workspace_id"],
            workspace_id.as_str()
        );
        assert_eq!(
            snapshot["result"]["snapshot"]["focused_tab_id"],
            Value::Null
        );
        assert_eq!(
            snapshot["result"]["snapshot"]["focused_pane_id"],
            Value::Null
        );

        // Spawning a terminal into the zero-tab workspace works: create_tab
        // takes the cwd from the workspace record.
        let tab = state.handle_request(
            "spawn",
            "tab.create",
            json!({ "workspace_id": workspace_id, "label": "Shell" }),
        );
        assert_eq!(
            tab["result"]["tab"]["workspace_id"],
            workspace_id.as_str(),
            "tab.create must attach to the zero-tab workspace"
        );
    }

    #[test]
    fn worktree_open_open_terminal_false_mints_no_tab() {
        let temp = std::env::temp_dir().join(format!(
            "herdr-webui-worktree-open-no-terminal-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&temp).unwrap();
        let state = BuiltinState::new(
            temp.clone(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        let response = state.handle_request(
            "open",
            "worktree.open",
            json!({ "path": temp.to_string_lossy(), "open_terminal": false }),
        );
        let workspace_id = response["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(
            response["result"]["tab"],
            json!({}),
            "worktree.open with open_terminal=false must not mint a tab"
        );
        assert_eq!(
            response["result"]["root_pane"],
            json!({}),
            "worktree.open with open_terminal=false must not mint a pane"
        );

        let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
        let workspaces = snapshot["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap();
        assert_eq!(workspaces.len(), 1);
        assert_eq!(workspaces[0]["workspace_id"], workspace_id.as_str());
        let tabs = snapshot["result"]["snapshot"]["tabs"].as_array().unwrap();
        assert!(tabs.is_empty());
        assert_eq!(
            snapshot["result"]["snapshot"]["focused_workspace_id"],
            workspace_id.as_str()
        );
        assert_eq!(
            snapshot["result"]["snapshot"]["focused_tab_id"],
            Value::Null
        );
        let _ = std::fs::remove_dir_all(temp);
    }

    #[test]
    fn workspace_create_absent_open_terminal_defaults_to_tab() {
        let state = BuiltinState::new(
            std::env::current_dir().unwrap(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        // No open_terminal param: legacy one-tab mint for non-web clients.
        let response =
            state.handle_request("seed", "workspace.create", json!({ "label": "Legacy" }));
        assert_eq!(
            response["result"]["tab"]["label"], "Shell",
            "absent open_terminal must keep the legacy Shell tab"
        );
        let pane_id = response["result"]["root_pane"]["pane_id"].as_str();
        assert!(pane_id.is_some(), "legacy mint includes a root pane");
    }

    #[test]
    fn normalize_focus_keeps_workspace_with_no_tabs() {
        let temp_a = std::env::temp_dir().join(format!(
            "herdr-webui-focus-a-{}-{}",
            std::process::id(),
            now_ms()
        ));
        let temp_b = std::env::temp_dir().join(format!(
            "herdr-webui-focus-b-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&temp_a).unwrap();
        std::fs::create_dir_all(&temp_b).unwrap();
        let state = BuiltinState::new(
            temp_a.clone(),
            Some(default_shell()),
            JcodeDetectionVariant::Vanilla,
        )
        .unwrap();
        // Workspace One exists in the background, never focused.
        let first = state.handle_request(
            "seed1",
            "workspace.create",
            json!({ "label": "One", "cwd": temp_a.to_string_lossy() }),
        );
        let first_id = first["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        // worktree.open creates and focuses workspace Two with one Shell tab.
        let second = state.handle_request(
            "seed2",
            "worktree.open",
            json!({ "path": temp_b.to_string_lossy() }),
        );
        let second_id = second["result"]["workspace"]["workspace_id"]
            .as_str()
            .unwrap()
            .to_string();
        let second_tab = second["result"]["tab"]["tab_id"]
            .as_str()
            .unwrap()
            .to_string();
        let focused = state.handle_request("snap", "session.snapshot", json!({}));
        assert_eq!(
            focused["result"]["snapshot"]["focused_workspace_id"],
            second_id.as_str(),
            "sanity: workspace Two is focused before the close"
        );

        // Close Two's only tab: focus must stay on the zero-tab Two, not
        // jump to One.
        state.handle_request("close", "tab.close", json!({ "tab_id": second_tab }));
        let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
        assert_eq!(
            snapshot["result"]["snapshot"]["focused_workspace_id"],
            second_id.as_str(),
            "focus must stay on the zero-tab workspace, not jump to another"
        );
        assert_eq!(
            snapshot["result"]["snapshot"]["focused_tab_id"],
            Value::Null
        );
        let workspaces = snapshot["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap();
        assert_eq!(workspaces.len(), 2, "both workspaces survive");
        let _ = first_id;
        let _ = std::fs::remove_dir_all(temp_a);
        let _ = std::fs::remove_dir_all(temp_b);
    }
}
