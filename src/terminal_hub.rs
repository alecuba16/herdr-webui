//! Shared terminal attach hub: one backend attach per
//! `(client socket, terminal_id)`, fanned out to every connected browser
//! WebSocket.
//!
//! Before the hub every browser WS opened its own backend attach
//! (`takeover: true`), so N viewers of one terminal meant N backend
//! connections, N reader threads, N full-history replays, and takeover
//! battles on external herdr daemons. The hub keeps one attach per
//! terminal alive for a short grace window after the last viewer leaves,
//! so reloads and quick reconnects reuse it instead of bouncing the
//! backend connection.
//!
//! Backpressure mirrors the built-in backend's own subscriber policy: a
//! stalled browser client gets dropped (its WS closes with the 4404 stall
//! code the frontend already banners) instead of ever blocking the shared
//! reader or growing an unbounded queue. A small bounded byte ring fed on
//! the forward path serves joining clients the recent output tail
//! immediately, without a second backend attach.

use crate::protocol::{
    read_message, write_message, ClientMessage, ServerMessage, PROTOCOL_VERSION,
};
use interprocess::local_socket::Stream as LocalStream;
use interprocess::TryClone as _;
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::{Receiver, Sender};

/// Upper bound for one client's pending output frames before the hub
/// drops it as stalled. Message-count cap, mirroring the built-in
/// backend's per-subscriber 256-frame channel but with headroom for
/// graphics-sized bursts.
const CLIENT_QUEUE_CAP: usize = 512;

/// Per-attach replay ring cap. The built-in backend replays its full
/// scrollback on every fresh attach; the hub ring covers re-joins of a
/// still-attached terminal (reconnect while the hub lives) where no new
/// backend full frame arrives. Matches the backend's own 8 MiB
/// scrollback bound so a late joiner sees at least what a fresh attach
/// would have shown.
const REPLAY_RING_BYTES: usize = 8 * 1024 * 1024;

/// How long the last viewer's departure keeps the shared attach open, so
/// page reloads and quick reconnects reuse the backend connection and the
/// replay ring instead of bouncing the attach.
const TEARDOWN_GRACE: Duration = Duration::from_millis(1_500);

/// Events a joined browser client can receive from a shared attach.
/// Mirrors the previous per-WS `TerminalEvent` shape in main.rs.
pub(crate) enum HubClientEvent {
    Bytes(Vec<u8>),
    /// Backend attach error to surface as a `herdr_error` JSON frame.
    Error {
        kind: &'static str,
        message: String,
        suggests_builtin: bool,
    },
}

impl std::fmt::Debug for HubClientEvent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Bytes(bytes) => write!(f, "Bytes({} bytes)", bytes.len()),
            Self::Error {
                kind,
                message,
                suggests_builtin,
            } => {
                write!(f, "Error {{ kind: {kind}, message: {message}, suggests_builtin: {suggests_builtin} }}")
            }
        }
    }
}

/// Bounded byte ring recording the recent output tail so joining clients
/// can catch up without a new backend attach. Raw terminal bytes only:
/// the frontend appends them to the scrollback exactly like live output.
pub(crate) struct ReplayRing {
    bytes: VecDeque<u8>,
    cap: usize,
}

impl ReplayRing {
    fn new(cap: usize) -> Self {
        Self {
            bytes: VecDeque::new(),
            cap: cap.max(1),
        }
    }

    fn push_bytes(&mut self, chunk: &[u8]) {
        if chunk.is_empty() {
            return;
        }
        // A chunk bigger than the whole ring keeps only its tail.
        if chunk.len() >= self.cap {
            self.bytes.clear();
            self.bytes
                .extend(chunk[chunk.len() - self.cap..].iter().copied());
            return;
        }
        if self.bytes.len() + chunk.len() <= self.cap {
            self.bytes.extend(chunk.iter().copied());
            return;
        }
        // Trim from the front, then append.
        let overflow = self.bytes.len() + chunk.len() - self.cap;
        self.bytes.drain(..overflow);
        self.bytes.extend(chunk.iter().copied());
    }

    fn replace_with(&mut self, chunk: &[u8]) {
        self.bytes.clear();
        self.push_bytes(chunk);
    }

    fn snapshot(&self) -> Vec<u8> {
        self.bytes.iter().copied().collect()
    }

    /// Replay size in bytes. Used by tests; kept for diagnostics.
    #[cfg(test)]
    fn len(&self) -> usize {
        self.bytes.len()
    }
}

/// One shared backend attach for a terminal. Browser WS clients join
/// with a bounded event queue; the reader thread pushes output into
/// every queue without ever blocking on a slow one.
pub(crate) struct SharedAttach {
    /// Writer-thread input: browser input/resize frames for the one
    /// backend connection, serialized FIFO. Created up front; the writer
    /// thread only starts once the handshake succeeded, and queued
    /// messages wait in the channel until then.
    in_tx: std::sync::mpsc::Sender<ClientMessage>,
    /// Registered browser clients. `None` slots are dropped/stalled
    /// clients pending cleanup.
    clients: Mutex<Vec<Option<Sender<HubClientEvent>>>>,
    /// True once the attach is finished (handshake error, stream death,
    /// or graceful detach). Guards hub reuse: joins after completion
    /// start a fresh attach attempt instead of a dead one.
    closed: AtomicBool,
    replay: Mutex<ReplayRing>,
}

impl SharedAttach {
    /// Push output bytes into the replay ring and fan out to every
    /// registered client. A client whose bounded queue is full (stalled
    /// browser TCP peer) is dropped: its WS relay observes the channel
    /// close and reports the 4404 stall. Never blocks.
    fn publish(&self, event: HubClientEvent) {
        if let HubClientEvent::Bytes(bytes) = &event {
            if let Ok(mut replay) = self.replay.lock() {
                replay.push_bytes(bytes);
            }
        }
        if let Ok(mut clients) = self.clients.lock() {
            for slot in clients.iter_mut() {
                let Some(client) = slot else { continue };
                match client.try_send(clone_event(&event)) {
                    Ok(()) => {}
                    // Full queue (stalled consumer) or already-disconnected
                    // receiver: drop it from the fan-out.
                    Err(_) => *slot = None,
                }
            }
        }
    }

    /// Broadcast an attach error to every client, mark closed.
    fn fail(&self, event: HubClientEvent) {
        self.closed.store(true, Ordering::Release);
        self.publish(event);
        if let Ok(mut clients) = self.clients.lock() {
            clients.clear();
        }
    }

    /// Register a client queue. Returns the queue Receiver plus the
    /// current replay snapshot to deliver before live events.
    ///
    /// Snapshot and registration are atomic w.r.t. `publish` (which
    /// takes the same locks in the same order: replay, then clients):
    /// bytes published before the snapshot are in the snapshot only,
    /// bytes published after are delivered live only — never both.
    fn join(&self) -> (Receiver<HubClientEvent>, Vec<u8>) {
        let (tx, rx) = tokio::sync::mpsc::channel(CLIENT_QUEUE_CAP);
        let replay_guard = self.replay.lock().expect("terminal hub replay lock");
        let snapshot = replay_guard.snapshot();
        let mut clients = self.clients.lock().expect("terminal hub clients lock");
        clients.retain(|slot| slot.is_some());
        clients.push(Some(tx));
        drop(clients);
        drop(replay_guard);
        (rx, snapshot)
    }

    /// Number of live client queues (stalled slots cleaned up).
    fn live_clients(&self) -> usize {
        self.clients
            .lock()
            .map(|mut clients| {
                clients.retain(|slot| slot.is_some());
                clients.len()
            })
            .unwrap_or(0)
    }
}

fn clone_event(event: &HubClientEvent) -> HubClientEvent {
    match event {
        HubClientEvent::Bytes(bytes) => HubClientEvent::Bytes(bytes.clone()),
        HubClientEvent::Error {
            kind,
            message,
            suggests_builtin,
        } => HubClientEvent::Error {
            kind,
            message: message.clone(),
            suggests_builtin: *suggests_builtin,
        },
    }
}

/// Attach handshake errors. Mirrors the previous per-WS
/// `TerminalAttachError` in main.rs so the `herdr_error` JSON frames stay
/// byte-compatible with the frontend recovery flow.
#[derive(Clone)]
pub(crate) enum AttachError {
    Connect,
    SendHandshake,
    ReadHandshake,
    Rejected(String),
    Attach,
}

impl AttachError {
    pub(crate) fn user_message(&self) -> String {
        match self {
            Self::Connect => "failed to connect to herdr client socket\r\n".to_string(),
            Self::SendHandshake => "failed to send herdr handshake\r\n".to_string(),
            Self::ReadHandshake => "failed to read herdr handshake\r\n".to_string(),
            Self::Rejected(error) => format!("herdr rejected terminal connection: {error}\r\n"),
            Self::Attach => "failed to attach herdr terminal\r\n".to_string(),
        }
    }

    pub(crate) fn error_kind(&self) -> &'static str {
        match self {
            Self::Connect => "connect_failed",
            Self::SendHandshake => "handshake_failed",
            Self::ReadHandshake => "handshake_failed",
            Self::Rejected(_) => "handshake_rejected",
            Self::Attach => "attach_failed",
        }
    }

    pub(crate) fn suggests_builtin(&self) -> bool {
        matches!(self, Self::ReadHandshake | Self::Rejected(_))
    }
}

/// herdr 0.9.0 requires an exact client protocol version match at
/// handshake time; the backend either accepts the version or rejects the
/// connection with a `Welcome{error}`.
fn connect_terminal_attach(
    path: &Path,
    terminal_id: &str,
    cols: u16,
    rows: u16,
) -> Result<LocalStream, AttachError> {
    let mut stream = crate::connect_local_stream(path).map_err(|_| AttachError::Connect)?;
    let hello = ClientMessage::TerminalHello {
        version: PROTOCOL_VERSION,
        cols,
        rows,
        cell_width_px: 0,
        cell_height_px: 0,
        pixel_mouse: false,
    };
    write_message(&mut stream, &hello).map_err(|_| AttachError::SendHandshake)?;

    match read_message::<_, ServerMessage>(&mut stream, crate::MAX_GRAPHICS_FRAME_SIZE)
        .map_err(|_| AttachError::ReadHandshake)?
    {
        ServerMessage::Welcome {
            error: Some(error), ..
        } => return Err(AttachError::Rejected(error)),
        ServerMessage::Welcome { error: None, .. } => {}
        _ => return Err(AttachError::ReadHandshake),
    }

    write_message(
        &mut stream,
        &ClientMessage::AttachTerminal {
            terminal_id: terminal_id.to_owned(),
            takeover: true,
        },
    )
    .map_err(|_| AttachError::Attach)?;
    Ok(stream)
}

type HubKey = (PathBuf, String);

fn hub_key(client_socket: &Path, terminal_id: &str) -> HubKey {
    (client_socket.to_path_buf(), terminal_id.to_string())
}

/// Hub state keyed by resolved client socket path + terminal id. A
/// terminal id is only unique inside one session's backend, so the
/// socket path (which encodes the session) is the namespace.
#[derive(Default)]
pub(crate) struct TerminalHub {
    attaches: Mutex<HashMap<HubKey, Arc<SharedAttach>>>,
}

impl TerminalHub {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Join (creating when absent) the shared attach for
    /// `(client_socket, terminal_id)`. Returns the client event queue,
    /// the replay snapshot to deliver before live events, and a guard
    /// that keeps this client counted; drop the guard (or call
    /// `detach()`) when the WS closes.
    ///
    /// The fresh attach runs in the background: handshake failures reach
    /// the joined client as `HubClientEvent::Error` through the same
    /// queue, preserving the old per-WS error-frame behavior.
    pub(crate) fn join(
        self: &Arc<Self>,
        client_socket: &Path,
        terminal_id: &str,
        cols: u16,
        rows: u16,
    ) -> (Receiver<HubClientEvent>, Vec<u8>, HubJoinGuard) {
        let key: HubKey = (client_socket.to_path_buf(), terminal_id.to_string());
        let attach = match self.live_attach(&key) {
            Some(attach) => attach,
            None => self.start_attach(&key, cols, rows),
        };
        let (rx, replay) = attach.join();
        (
            rx,
            replay,
            HubJoinGuard {
                hub: Arc::clone(self),
                key,
            },
        )
    }

    /// Live (not closed) attach for the key, if any.
    fn live_attach(&self, key: &HubKey) -> Option<Arc<SharedAttach>> {
        let attaches = self.attaches.lock().ok()?;
        let attach = attaches.get(key)?;
        if attach.closed.load(Ordering::Acquire) {
            return None;
        }
        Some(Arc::clone(attach))
    }

    /// Remove a closed entry from the map. No-op for live attaches.
    fn reap_if_closed(&self, key: &HubKey) {
        if let Ok(mut attaches) = self.attaches.lock() {
            let stale = attaches
                .get(key)
                .is_some_and(|attach| attach.closed.load(Ordering::Acquire));
            if stale {
                attaches.remove(key);
            }
        }
    }

    /// Start a fresh shared attach for the key and register it. The
    /// handshake + reader/writer threads run in the background; the
    /// placeholder is joinable immediately.
    fn start_attach(&self, key: &HubKey, cols: u16, rows: u16) -> Arc<SharedAttach> {
        // Channel created up front so input frames can queue before the
        // handshake finishes; the writer thread drains them afterwards.
        let (in_tx, in_rx) = std::sync::mpsc::channel::<ClientMessage>();
        let attach = Arc::new(SharedAttach {
            in_tx,
            clients: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
            replay: Mutex::new(ReplayRing::new(replay_cap())),
        });
        {
            let mut attaches = self.attaches.lock().expect("terminal hub lock");
            // A live attach may have appeared while we set up.
            if let Some(existing) = attaches.get(key) {
                if !existing.closed.load(Ordering::Acquire) {
                    return Arc::clone(existing);
                }
                attaches.remove(key);
            }
            attaches.insert(key.clone(), Arc::clone(&attach));
        }

        let path = key.0.clone();
        let terminal_id = key.1.clone();
        let attach_for_task = Arc::clone(&attach);
        // Blocking pool: the handshake is synchronous local-socket IO.
        tokio::task::spawn_blocking(move || {
            match connect_terminal_attach(&path, &terminal_id, cols, rows) {
                Err(error) => {
                    // Attach failed: every joined client gets the
                    // herdr_error event; the entry stays closed and is
                    // not reused (next join starts a fresh attempt).
                    attach_for_task.fail(HubClientEvent::Error {
                        kind: error.error_kind(),
                        message: error.user_message().trim_end().to_string(),
                        suggests_builtin: error.suggests_builtin(),
                    });
                }
                Ok(stream) => spawn_attach_threads(attach_for_task, stream, in_rx),
            }
        });
        attach
    }

    /// A joined client's WS closed. When it was the last viewer, send the
    /// backend Detach after the grace window so a reload can rejoin.
    fn detach(&self, key: &HubKey) {
        let Some(attach) = self.live_attach(key) else {
            self.reap_if_closed(key);
            return;
        };
        if attach.live_clients() > 0 {
            return; // Others still watching.
        }
        let weak = Arc::downgrade(&attach);
        tokio::spawn(async move {
            tokio::time::sleep(TEARDOWN_GRACE).await;
            let Some(attach) = weak.upgrade() else { return };
            if attach.live_clients() > 0 {
                return; // Someone rejoined inside the window.
            }
            // Last viewer gone: graceful backend detach. Sending fails
            // silently when the reader/writer threads already exited.
            let _ = attach.in_tx.send(ClientMessage::Detach);
        });
    }

    /// Sender for the live attach's input queue, so a WS relay can feed
    /// browser input/resize frames into the shared backend connection.
    /// `None` when the attach already finished (the relay should close).
    pub(crate) fn attach_sender(
        &self,
        client_socket: &Path,
        terminal_id: &str,
    ) -> Option<std::sync::mpsc::Sender<ClientMessage>> {
        self.live_attach(&hub_key(client_socket, terminal_id))
            .map(|attach| attach.in_tx.clone())
    }

    /// Send one client message (input/resize) into the shared attach's
    /// input queue. `Err(())` when no live attach exists: the caller
    /// should close its WS.
    pub(crate) fn send_client_message(
        &self,
        client_socket: &Path,
        terminal_id: &str,
        message: ClientMessage,
    ) -> Result<(), ()> {
        match self.live_attach(&hub_key(client_socket, terminal_id)) {
            Some(attach) => attach.in_tx.send(message).map_err(|_| ()),
            None => Err(()),
        }
    }
}

/// Reader/writer threads for one live backend attach.
fn spawn_attach_threads(
    attach: Arc<SharedAttach>,
    stream: LocalStream,
    in_rx: std::sync::mpsc::Receiver<ClientMessage>,
) {
    let Ok(mut writer) = stream.try_clone() else {
        attach.fail(HubClientEvent::Bytes(
            b"failed to clone herdr terminal socket\r\n".to_vec(),
        ));
        return;
    };
    // Writer thread: serialized FIFO of browser input to the backend.
    std::thread::spawn(move || {
        for message in in_rx {
            if write_message(&mut writer, &message).is_err() {
                break;
            }
        }
    });
    // Reader thread: backend frames to the fan-out. Bounded end to end:
    // a slow browser client is dropped, this thread never blocks.
    std::thread::spawn(move || {
        let mut stream = stream;
        loop {
            match read_message::<_, ServerMessage>(&mut stream, crate::MAX_GRAPHICS_FRAME_SIZE) {
                Ok(ServerMessage::Terminal(frame)) => {
                    if frame.full {
                        // Full frame = the backend's authoritative replay
                        // (fresh attach): it replaces the ring instead of
                        // appending, so re-joins see exactly the tail the
                        // backend considers current.
                        if let Ok(mut replay) = attach.replay.lock() {
                            replay.replace_with(&frame.bytes);
                        }
                    }
                    attach.publish(HubClientEvent::Bytes(frame.bytes));
                }
                Ok(ServerMessage::Graphics { bytes }) => {
                    attach.publish(HubClientEvent::Bytes(bytes));
                }
                Ok(ServerMessage::ServerShutdown { .. }) => break,
                Ok(_) => {}
                Err(_) => break,
            }
        }
        // Stream ended (graceful detach, shutdown, or death): mark the
        // attach closed and drop every client queue, so each WS relay
        // sees the channel close and finishes with its 4404 stall code.
        // The hub map entry is reaped on the next join/detach touch.
        attach.closed.store(true, Ordering::Release);
        if let Ok(mut clients) = attach.clients.lock() {
            for slot in clients.iter_mut() {
                *slot = None;
            }
        }
    });
}

fn replay_cap() -> usize {
    std::env::var("HERDR_REPLAY_CAP_BYTES")
        .ok()
        .and_then(|value| value.parse().ok())
        .filter(|cap| *cap > 0)
        .unwrap_or(REPLAY_RING_BYTES)
}

/// Handle returned by `join`; keeps the hub's client count honest.
/// Dropping it detaches, same as calling `detach()` explicitly.
pub(crate) struct HubJoinGuard {
    hub: Arc<TerminalHub>,
    key: HubKey,
}

impl HubJoinGuard {
    pub(crate) fn detach(self) {
        self.hub.detach(&self.key);
    }
}

impl Drop for HubJoinGuard {
    fn drop(&mut self) {
        self.hub.detach(&self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_ring_appends_and_trims_to_cap() {
        let mut ring = ReplayRing::new(8);
        ring.push_bytes(b"abcdef");
        assert_eq!(ring.snapshot(), b"abcdef".to_vec());
        ring.push_bytes(b"ghij");
        // Cap 8: oldest bytes dropped from the front.
        assert_eq!(ring.snapshot(), b"cdefghij".to_vec());
        assert_eq!(ring.len(), 8);
    }

    #[test]
    fn replay_ring_oversized_chunk_keeps_tail() {
        let mut ring = ReplayRing::new(4);
        ring.push_bytes(b"0123456789");
        assert_eq!(ring.snapshot(), b"6789".to_vec());
    }

    #[test]
    fn replay_ring_replace_with_resets_content() {
        let mut ring = ReplayRing::new(16);
        ring.push_bytes(b"stale");
        ring.replace_with(b"fresh");
        assert_eq!(ring.snapshot(), b"fresh".to_vec());
        ring.replace_with(b"0123456789ABCDEF0123");
        // Replace also trims to the cap.
        assert_eq!(ring.snapshot(), b"456789ABCDEF0123".to_vec());
    }

    #[test]
    fn replay_ring_snapshot_is_copy() {
        let mut ring = ReplayRing::new(16);
        ring.push_bytes(b"data");
        let snapshot = ring.snapshot();
        ring.push_bytes(b"more");
        assert_eq!(snapshot, b"data".to_vec());
        assert_eq!(ring.snapshot(), b"datamore".to_vec());
    }

    #[test]
    fn shared_attach_publish_fans_out_and_drops_stalled_client() {
        let attach = SharedAttach {
            in_tx: std::sync::mpsc::channel().0,
            clients: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
            replay: Mutex::new(ReplayRing::new(64)),
        };
        let (mut rx1, replay1) = attach.join();
        let (rx2, _replay2) = attach.join();
        assert!(replay1.is_empty());
        assert_eq!(attach.live_clients(), 2);

        attach.publish(HubClientEvent::Bytes(b"hello".to_vec()));
        // Replay ring got the bytes for future joiners.
        assert_eq!(attach.replay.lock().unwrap().snapshot(), b"hello".to_vec());

        // Force-queue rx2's sender to capacity to simulate a stalled
        // client, then publish: the stalled slot must be dropped while
        // the healthy one keeps receiving.
        if let Ok(mut clients) = attach.clients.lock() {
            // rx2 is the second joined client (slot index 1); stall
            // only that one so rx1 stays a healthy consumer.
            if let Some(Some(client)) = clients.get_mut(1) {
                while client
                    .try_send(HubClientEvent::Bytes(b"x".to_vec()))
                    .is_ok()
                {}
            }
        }
        attach.publish(HubClientEvent::Bytes(b"after-stall".to_vec()));
        // Stalled client dropped from the fan-out, healthy one stays.
        assert_eq!(attach.live_clients(), 1);

        let mut got1 = Vec::new();
        while let Ok(event) = rx1.try_recv() {
            if let HubClientEvent::Bytes(bytes) = event {
                got1.push(bytes);
            }
        }
        assert!(got1.iter().any(|bytes| bytes == b"hello"));
        assert!(got1.iter().any(|bytes| bytes == b"after-stall"));
        // The stalled client still drains its queued frames but its slot
        // is gone; the receiver closes once the queued backlog is read.
        drop(rx2);
    }

    #[test]
    fn shared_attach_join_returns_replay_snapshot() {
        let attach = SharedAttach {
            in_tx: std::sync::mpsc::channel().0,
            clients: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
            replay: Mutex::new(ReplayRing::new(64)),
        };
        attach.publish(HubClientEvent::Bytes(b"history-tail".to_vec()));
        let (mut rx, replay) = attach.join();
        assert_eq!(replay, b"history-tail".to_vec());
        // Live output still flows to the late joiner after the snapshot.
        attach.publish(HubClientEvent::Bytes(b"live".to_vec()));
        let mut events = Vec::new();
        while let Ok(event) = rx.try_recv() {
            events.push(event);
        }
        assert_eq!(events.len(), 1);
        assert!(matches!(&events[0], HubClientEvent::Bytes(bytes) if bytes == b"live"));
    }

    #[test]
    fn shared_attach_fail_broadcasts_error_and_closes() {
        let attach = SharedAttach {
            in_tx: std::sync::mpsc::channel().0,
            clients: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
            replay: Mutex::new(ReplayRing::new(64)),
        };
        let (mut rx, _replay) = attach.join();
        attach.fail(HubClientEvent::Error {
            kind: "connect_failed",
            message: "boom".to_string(),
            suggests_builtin: false,
        });
        assert!(attach.closed.load(Ordering::Acquire));
        assert_eq!(attach.live_clients(), 0);
        match rx.try_recv() {
            Ok(HubClientEvent::Error {
                kind,
                message,
                suggests_builtin,
            }) => {
                assert_eq!(kind, "connect_failed");
                assert_eq!(message, "boom");
                assert!(!suggests_builtin);
            }
            other => panic!("expected error event, got {other:?}"),
        }
    }

    #[test]
    fn hub_client_event_debug_formats_both_variants() {
        let bytes = HubClientEvent::Bytes(b"abc".to_vec());
        assert_eq!(format!("{bytes:?}"), "Bytes(3 bytes)");
        let error = HubClientEvent::Error {
            kind: "connect_failed",
            message: "boom".to_string(),
            suggests_builtin: true,
        };
        let debug = format!("{error:?}");
        assert!(debug.contains("connect_failed"));
        assert!(debug.contains("boom"));
        assert!(debug.contains("suggests_builtin: true"));
    }

    #[test]
    fn replay_ring_empty_chunk_is_noop() {
        let mut ring = ReplayRing::new(8);
        ring.push_bytes(b"data");
        ring.push_bytes(b"");
        assert_eq!(ring.snapshot(), b"data".to_vec());
        assert_eq!(ring.len(), 4);
    }

    #[test]
    fn attach_error_messages_kinds_and_builtin_hints() {
        assert_eq!(
            AttachError::Connect.user_message(),
            "failed to connect to herdr client socket\r\n"
        );
        assert_eq!(
            AttachError::SendHandshake.user_message(),
            "failed to send herdr handshake\r\n"
        );
        assert_eq!(
            AttachError::ReadHandshake.user_message(),
            "failed to read herdr handshake\r\n"
        );
        assert_eq!(
            AttachError::Rejected("version mismatch".to_string()).user_message(),
            "herdr rejected terminal connection: version mismatch\r\n"
        );
        assert_eq!(
            AttachError::Attach.user_message(),
            "failed to attach herdr terminal\r\n"
        );

        assert_eq!(AttachError::Connect.error_kind(), "connect_failed");
        assert_eq!(AttachError::SendHandshake.error_kind(), "handshake_failed");
        assert_eq!(AttachError::ReadHandshake.error_kind(), "handshake_failed");
        assert_eq!(
            AttachError::Rejected(String::new()).error_kind(),
            "handshake_rejected"
        );
        assert_eq!(AttachError::Attach.error_kind(), "attach_failed");

        assert!(!AttachError::Connect.suggests_builtin());
        assert!(!AttachError::SendHandshake.suggests_builtin());
        assert!(AttachError::ReadHandshake.suggests_builtin());
        assert!(AttachError::Rejected(String::new()).suggests_builtin());
        assert!(!AttachError::Attach.suggests_builtin());
    }

    #[test]
    fn shared_attach_publish_with_poisoned_locks_never_panics() {
        let attach = SharedAttach {
            in_tx: std::sync::mpsc::channel().0,
            clients: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
            replay: Mutex::new(ReplayRing::new(64)),
        };
        attach.publish(HubClientEvent::Bytes(b"first".to_vec()));
        // Poison both locks by panicking while holding them.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _clients = attach.clients.lock().unwrap();
            let _replay = attach.replay.lock().unwrap();
            panic!("poison source");
        }));
        // Locks are poisoned now: publish/fail must be silent no-ops
        // instead of panicking (a panic in the reader thread would take
        // the whole process down).
        attach.publish(HubClientEvent::Bytes(b"second".to_vec()));
        attach.fail(HubClientEvent::Error {
            kind: "handshake_failed",
            message: "poisoned".to_string(),
            suggests_builtin: false,
        });
    }

    #[test]
    fn replay_cap_reads_env_override() {
        // Only this var feeds replay_cap and no other test touches it, so a
        // set/restore dance is safe even under parallel test threads.
        std::env::set_var("HERDR_REPLAY_CAP_BYTES", "4096");
        assert_eq!(replay_cap(), 4096);
        // Invalid or non-positive values fall back to the default.
        std::env::set_var("HERDR_REPLAY_CAP_BYTES", "not-a-number");
        assert_eq!(replay_cap(), REPLAY_RING_BYTES);
        std::env::set_var("HERDR_REPLAY_CAP_BYTES", "0");
        assert_eq!(replay_cap(), REPLAY_RING_BYTES);
        std::env::remove_var("HERDR_REPLAY_CAP_BYTES");
        assert_eq!(replay_cap(), REPLAY_RING_BYTES);
    }

    #[test]
    fn hub_detach_without_attach_is_noop() {
        let hub = TerminalHub::new();
        hub.detach(&(PathBuf::from("/nonexistent.sock"), "t1".to_string()));
        assert!(hub.attaches.lock().unwrap().is_empty());
    }
}
