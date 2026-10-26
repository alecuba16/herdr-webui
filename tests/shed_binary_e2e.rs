//! End-to-end shed validation against the real `herdr-webui` binary.
//!
//! Spawns the production binary in builtin backend mode, drives the real
//! JSON-lines API socket to mint a workspace/terminal, then speaks the real
//! client wire protocol (4-byte LE length + bincode frames, TerminalHello
//! handshake, AttachTerminal, Input) over the real client socket. The
//! regression under test: a re-attach on a live connection used to
//! underflow the subscriber pending-bytes counter, so the next output byte
//! shed a healthy re-attached client with "terminal output backlog
//! overflow". This test reproduces the exact production sequence:
//!
//!   attach -> flood via real shell -> re-attach on the live connection
//!   -> keep producing output -> client must keep receiving frames.
//!
//! bincode encodes the enum variant index as a varint followed by struct
//! fields in declaration order; the two frames this test needs
//! (TerminalHello at index 0, Input at index 1) are hand-encoded below.
//! The Welcome/terminal frames coming back are decoded loosely: the test
//! only needs the ServerShutdown sentinel with the overflow reason, so it
//! scans raw frame payloads for the shutdown string instead of fully
//! decoding ServerMessage (its variant set is large and versioned).

use interprocess::local_socket::{prelude::*, GenericFilePath, Stream};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// bincode standard config varint (verified against bincode 2.0.1's own
/// `encode_to_vec`): values <= 250 are a single byte; larger values use a
/// marker byte (FB = u16 LE, FC = u32 LE, FD = u64 LE) carrying the whole
/// number. NOT LEB128: a hand-rolled 7-bit encoder diverges at 128 and
/// desyncs framing for any Input frame larger than 127 bytes.
fn varint(value: u64) -> Vec<u8> {
    match value {
        0..=250 => vec![value as u8],
        251..=0xFFFF => {
            let mut out = vec![0xFB];
            out.extend_from_slice(&(value as u16).to_le_bytes());
            out
        }
        0x1_0000..=0xFFFF_FFFF => {
            let mut out = vec![0xFC];
            out.extend_from_slice(&(value as u32).to_le_bytes());
            out
        }
        _ => {
            let mut out = vec![0xFD];
            out.extend_from_slice(&value.to_le_bytes());
            out
        }
    }
}

fn u32_varint(value: u32) -> Vec<u8> {
    varint(u64::from(value))
}

/// Encode `ClientMessage::TerminalHello` (variant 0) with bincode standard
/// config: varint variant index, then fields in declaration order. Bools
/// are one byte; u32/u16 use varints under the standard config.
fn encode_terminal_hello(cols: u16, rows: u16) -> Vec<u8> {
    let mut out = varint(0); // variant index
    out.extend(u32_varint(22)); // version: PROTOCOL_VERSION
    out.extend(varint(u64::from(cols)));
    out.extend(varint(u64::from(rows)));
    out.extend(varint(0)); // cell_width_px
    out.extend(varint(0)); // cell_height_px
    out.push(0); // pixel_mouse: false
    out
}

/// Encode `ClientMessage::Input { data }` (variant 1): index, then the
/// Vec<u8> as a varint length prefix followed by the bytes.
fn encode_input(data: &[u8]) -> Vec<u8> {
    let mut out = varint(1);
    out.extend(varint(data.len() as u64));
    out.extend_from_slice(data);
    out
}

/// Encode `ClientMessage::AttachTerminal { terminal_id, takeover }`
/// (variant 5): index, then String as varint length + bytes, then bool.
fn encode_attach_terminal(terminal_id: &str) -> Vec<u8> {
    let mut out = varint(5);
    out.extend(varint(terminal_id.len() as u64));
    out.extend_from_slice(terminal_id.as_bytes());
    out.push(1); // takeover: true (matches web attach behavior)
    out
}

/// Encode `ClientMessage::Detach` (variant 4): just the index.
fn encode_detach() -> Vec<u8> {
    varint(4)
}

fn write_frame(stream: &mut Stream, payload: &[u8]) {
    let len = u32::try_from(payload.len()).expect("frame fits u32");
    stream.write_all(&len.to_le_bytes()).expect("write len");
    stream.write_all(payload).expect("write payload");
    stream.flush().expect("flush");
}

/// Buffered frame reader for one client connection.
///
/// `read_exact` cannot coexist with a recv timeout: on timeout it
/// discards the bytes it already read, desyncing this length-prefixed
/// stream (and on macOS the expiry surfaces as WouldBlock, panicking the
/// read outright). The polling loops need short recv timeouts, so every
/// frame read goes through this buffer instead: partial reads accumulate
/// and a frame parses only once fully buffered. `poll` honors the
/// socket's current recv timeout; `read_frame` clears it to block.
struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    fn new() -> Self {
        FrameReader { buf: Vec::new() }
    }

    /// One full frame if the socket offers one within its current recv
    /// timeout; None when nothing complete arrived. Partial bytes stay
    /// buffered for the next call, so a timeout can never desync.
    fn poll(&mut self, stream: &mut Stream) -> Option<Vec<u8>> {
        loop {
            if let Some(frame) = self.take_frame() {
                return Some(frame);
            }
            let mut chunk = [0u8; 16384];
            match stream.read(&mut chunk) {
                Ok(0) => panic!("client socket closed by server"),
                Ok(n) => self.buf.extend_from_slice(&chunk[..n]),
                Err(err)
                    if err.kind() == std::io::ErrorKind::WouldBlock
                        || err.kind() == std::io::ErrorKind::TimedOut
                        || err.kind() == std::io::ErrorKind::Interrupted =>
                {
                    return None
                }
                Err(err) => panic!("frame read failed: {err}"),
            }
        }
    }

    /// Pop one complete frame from the buffer, if any.
    fn take_frame(&mut self) -> Option<Vec<u8>> {
        if self.buf.len() < 4 {
            return None;
        }
        let len = u32::from_le_bytes([self.buf[0], self.buf[1], self.buf[2], self.buf[3]]) as usize;
        assert!(len <= 32 * 1024 * 1024, "oversized frame: {len}");
        if self.buf.len() < 4 + len {
            return None;
        }
        let payload = self.buf[4..4 + len].to_vec();
        self.buf.drain(..4 + len);
        Some(payload)
    }
}

/// Blocking frame read for the handshake/replay points: clears the recv
/// timeout (the polling loops leave short ones behind) and consumes the
/// same buffer, so leftovers from a poll can never strand a frame.
fn read_frame(stream: &mut Stream, reader: &mut FrameReader) -> Vec<u8> {
    stream.set_recv_timeout(None).expect("clear read timeout");
    loop {
        if let Some(frame) = reader.poll(stream) {
            return frame;
        }
    }
}

struct ServerGuard {
    child: Child,
    sockets: Vec<PathBuf>,
    home: PathBuf,
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for socket in &self.sockets {
            let _ = std::fs::remove_file(socket);
        }
        let _ = std::fs::remove_dir_all(&self.home);
    }
}

fn wait_for_socket(path: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if path.exists() {
            std::thread::sleep(Duration::from_millis(200));
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

fn api_request(socket: &Path, line: &str) -> serde_json::Value {
    let mut stream = Stream::connect(
        socket
            .to_fs_name::<GenericFilePath>()
            .expect("valid socket name"),
    )
    .expect("connect api socket");
    stream
        .write_all(line.as_bytes())
        .and_then(|_| stream.write_all(b"\n"))
        .and_then(|_| stream.flush())
        .expect("write request");
    let mut out = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(15);
    stream
        .set_recv_timeout(Some(Duration::from_secs(5)))
        .expect("set read timeout");
    loop {
        if Instant::now() > deadline {
            panic!("api response timeout for: {line}");
        }
        let mut buf = [0u8; 16384];
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                out.extend_from_slice(&buf[..n]);
                if out.contains(&b'\n') {
                    break;
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                if out.contains(&b'\n') {
                    break;
                }
                continue;
            }
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(err) => panic!("api read failed: {err}"),
        }
    }
    let text = String::from_utf8_lossy(&out);
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .expect("non-empty response line");
    serde_json::from_str(line).expect("valid json response")
}

#[test]
fn varint_matches_bincode_across_the_value_space() {
    // The wire-format mirror above was wrong once (LEB128 vs bincode's
    // marker scheme) and desynced every large frame; this sweep locks it
    // to the real encoder so it cannot drift again. Covers every scheme
    // boundary (250/251 inline, FB u16, FC u32, FD u64) plus the frame
    // lengths the flood test actually encodes.
    let probes: Vec<u64> = [
        0,
        1,
        127,
        128,
        249,
        250,
        251,
        252,
        255,
        256,
        u16::MAX as u64 - 1,
        u16::MAX as u64,
        u16::MAX as u64 + 1,
        u32::MAX as u64 - 1,
        u32::MAX as u64,
        u32::MAX as u64 + 1,
        u64::MAX,
        16383,
        16384,
        16385,
    ]
    .into();
    for value in probes {
        assert_eq!(
            varint(value),
            bincode::encode_to_vec(value, bincode::config::standard()).unwrap(),
            "varint({value}) diverged from bincode"
        );
    }
}

#[test]
fn mirror_encodings_match_the_protocol_wire_goldens() {
    // Same byte vectors as client_message_wire_goldens_match_the_hand_
    // rolled_mirrors in src/tests.rs, which encodes the REAL
    // ClientMessage through the production bincode path. This suite
    // cannot import the pub(crate) type, so both sides pin these
    // goldens: a drift fails fast here at test time instead of
    // desyncing a live handshake with "trailing bytes in frame".
    assert_eq!(
        encode_terminal_hello(120, 40),
        [
            0x00, // TerminalHello variant index (varint)
            22,   // version: PROTOCOL_VERSION fits one varint byte
            120,  // cols
            40,   // rows
            0,    // cell_width_px
            0,    // cell_height_px
            0,    // pixel_mouse: false is one zero byte
        ]
    );

    // 16 KiB Input frame: the size the flood pushes. Length 16384 =
    // 0x4000 > 250, so bincode emits FB + u16 LE (00 40); the old LEB128
    // mirror emitted 80 80 01 here and desynced framing.
    let big = vec![b'x'; 16384];
    let big_encoded = encode_input(&big);
    assert_eq!(&big_encoded[..4], &[0x01, 0xFB, 0x00, 0x40]);
    assert_eq!(big_encoded.len(), 4 + 16384);
    assert_eq!(&big_encoded[4..], &big[..]);

    // Small Vec: length 5 stays inline (< 251).
    assert_eq!(
        encode_input(&[0xAB; 5]),
        [0x01, 0x05, 0xAB, 0xAB, 0xAB, 0xAB, 0xAB]
    );

    // AttachTerminal: variant 5 (Detach=4 sits before it), String as
    // varint length + bytes, bool takeover as a single 0x01 byte.
    assert_eq!(
        encode_attach_terminal("probe-tty"),
        vec![
            0x05, // AttachTerminal variant index
            0x09, // "probe-tty".len() as varint (9 bytes)
            b'p', b'r', b'o', b'b', b'e', b'-', b't', b't', b'y', 0x01, // takeover: true
        ]
    );

    // Detach is just the variant index: one zero-cost byte.
    assert_eq!(encode_detach(), [0x04]);
}

#[test]
fn builtin_binary_reattach_survives_output_flood() {
    let tag = format!(
        "shed-e2e-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let home = std::env::temp_dir().join(&tag);
    std::fs::create_dir_all(&home).expect("create home");
    // Socket derivation must mirror the server's builtin_socket_paths()
    // exactly, including its over-limit fallback to /tmp/herdr-webui-
    // builtin-<hash>: the canonical path under a long settings dir exceeds
    // SOCKET_PATH_LIMIT and the server silently relocates. The server
    // derives sockets from server_settings_path().parent(), which is
    // XDG_CONFIG_HOME/herdr-webui; use the same helper with the same
    // settings dir so both sides land on byte-identical socket paths.
    let settings_dir = home.join("herdr-webui");
    let (api_socket, client_socket) =
        herdr_webui::socket_paths::builtin_socket_paths_in(&settings_dir, Some("shed-e2e"));

    let bin = env!("CARGO_BIN_EXE_herdr-webui");
    let child = Command::new(bin)
        .arg("--https")
        .arg("off")
        .arg("--bind")
        .arg("127.0.0.1:0")
        .arg("--session")
        .arg("shed-e2e")
        .arg("--backend-mode")
        .arg("builtin")
        .env("XDG_CONFIG_HOME", &home)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn herdr-webui binary");

    let mut guard = ServerGuard {
        child,
        sockets: vec![api_socket.clone(), client_socket.clone()],
        home,
    };

    assert!(
        wait_for_socket(&api_socket, Duration::from_secs(30)),
        "api socket never appeared; binary may have failed to start"
    );
    assert!(
        wait_for_socket(&client_socket, Duration::from_secs(10)),
        "client socket never appeared"
    );

    // Mint a workspace with a live terminal through the real JSON API.
    let ws = api_request(
        &api_socket,
        r#"{"id":"1","method":"workspace.create","params":{"label":"shed-e2e"}}"#,
    );
    assert!(ws["result"].is_object(), "workspace.create failed: {ws}");
    // The builtin API returns workspace/tab/root_pane JSON; only the
    // terminal id matters for the client wire protocol.
    let terminal_id = ws["result"]["root_pane"]["terminal_id"]
        .as_str()
        .or_else(|| ws["result"]["root_pane"]["pane_id"].as_str())
        .expect("terminal id in workspace.create result")
        .to_string();

    // --- Client wire protocol: real handshake ---
    let client_socket_name = client_socket
        .to_fs_name::<GenericFilePath>()
        .expect("valid client socket name");
    let mut client = Stream::connect(client_socket_name.clone()).expect("connect client socket");
    let mut reader = FrameReader::new();
    let mut marker_matcher = MarkerMatcher::new();
    write_frame(&mut client, &encode_terminal_hello(120, 40));
    let welcome = read_frame(&mut client, &mut reader);
    // Welcome is variant 0; the error field is Option<String> (None = 0)
    // after version varint and encoding varint. A handshake rejection
    // carries a Some(reason) string; assert loosely.
    assert!(welcome.len() >= 4, "welcome frame too small");
    assert!(
        !welcome
            .windows(20)
            .any(|w| w == b"older than server".as_slice()),
        "handshake rejected: {:?}",
        String::from_utf8_lossy(&welcome)
    );

    // First attach: history replay arrives as a Terminal frame. Even an
    // empty history yields a valid frame (variant index + headers), so
    // only require decodability, not a size floor.
    write_frame(&mut client, &encode_attach_terminal(&terminal_id));
    let replay = read_frame(&mut client, &mut reader);
    assert!(!replay.is_empty(), "expected history replay frame");

    // --- Flood the real shell with sustained output ---
    // The shell command generates the volume; each burst must come back as
    // Terminal frames while the subscriber stays healthy. The echoed
    // command itself would match the marker, so the typed command uses
    // FL""OOD quoting: the PTY echo shows the quotes while the shell's
    // output shows the plain marker. A per-burst deadline surfaces a shed
    // instead of hanging forever.
    //
    // Deadline budget: a burst is ~55KB of output through one PTY, well
    // under the 16MB shed cap, and the test only sends burst N+1 after
    // burst N's marker arrived, so a healthy run never has more than one
    // burst in flight and needs low single-digit seconds even on a slow
    // machine. But GitHub's shared macOS runners stall for tens of
    // seconds under load (observed: bursts 11-13 and 35 hitting the old
    // 30s wall on runs whose every other burst was fast), and a timeout
    // there is a scheduling stall, not a shed — a real shed answers
    // with the Overflow shutdown frame and then closes the socket (the
    // poll loop panics on EOF), it never leaves the client waiting in
    // silence. 120s keeps the shed-vs-stall distinction honest.
    let flood_cmd = "for i in $(seq 1 1000); do echo FL\"\"OOD-$i-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345; done; echo FL\"\"OOD-DONE-$RANDOM\n";
    let marker: &[u8] = b"FLOOD-DONE-";
    let bursts = 40u32;
    for burst in 0..bursts {
        write_frame(&mut client, &encode_input(flood_cmd.as_bytes()));
        let burst_deadline = Instant::now() + Duration::from_secs(120);
        let mut saw_marker = false;
        while Instant::now() < burst_deadline && !saw_marker {
            client
                .set_recv_timeout(Some(Duration::from_millis(250)))
                .expect("set read timeout");
            match reader.poll(&mut client) {
                Some(payload) => {
                    saw_marker = marker_matcher.feed(&payload, marker);
                }
                None => continue,
            }
        }
        assert!(
            saw_marker,
            "burst {burst} never finished; a shed answers with an Overflow \
             shutdown frame then EOF, so silence past this deadline is a \
             runner stall (or a hang), not a shed"
        );
    }

    // Drop this connection and open a fresh one whose FIRST attach carries
    // the accumulated history. This matters for the regression's shape:
    // the pre-fix writer subtracts the first-attach replay length (its
    // captured `replay_len`) when it later processes a re-attach replay, so
    // the counter wraps to usize::MAX - replay_len. A later output chunk
    // then fetch_add's its own length: when the chunk exceeds the debt the
    // add wraps the counter back below the shed cap and the bug is masked
    // (a near-empty first history hides it). A first attach over the full
    // flooded scrollback makes the debt (~1.7MB) dwarf every probe chunk
    // (~100B), so on unfixed code the counter stays above the cap and the
    // shed fires deterministically.
    write_frame(&mut client, &encode_detach());
    drop(client);
    let mut client = Stream::connect(client_socket_name).expect("reconnect client socket");
    let mut reader = FrameReader::new();
    write_frame(&mut client, &encode_terminal_hello(120, 40));
    let welcome2 = read_frame(&mut client, &mut reader);
    assert!(!welcome2.is_empty(), "expected welcome on reconnect");
    write_frame(&mut client, &encode_attach_terminal(&terminal_id));
    // The first replay on this connection is the full flooded history.
    let replay = read_frame(&mut client, &mut reader);
    assert!(!replay.is_empty(), "expected history replay on reconnect");

    // --- Quiesce: drive the pending counter to exactly zero ---
    // The pre-fix writer subtracts the first-attach replay length from the
    // counter when it processes the re-attach replay, wrapping only when
    // the counter is zero at that instant. Drain until the shell goes
    // silent so the re-attach replay is the only thing in flight.
    let quiesce_deadline = Instant::now() + Duration::from_secs(30);
    let mut last_frame = Instant::now();
    while Instant::now() < quiesce_deadline {
        if last_frame.elapsed() < Duration::from_secs(1) {
            client
                .set_recv_timeout(Some(Duration::from_millis(100)))
                .expect("set read timeout");
            if reader.poll(&mut client).is_some() {
                last_frame = Instant::now();
            }
        } else {
            break;
        }
    }

    // --- The regression: re-attach on the live connection ---
    // Before the fix, this queued a replay frame without charging the
    // pending counter; the writer subtracted the first attach's captured
    // replay length from a counter that never received it, wrapping to
    // usize::MAX - debt, and the next output byte shed the client. After
    // the fix the re-attach replay is charged, the subtraction balances,
    // and output keeps flowing.
    write_frame(&mut client, &encode_attach_terminal(&terminal_id));
    let replay2 = read_frame(&mut client, &mut reader);
    assert!(!replay2.is_empty(), "expected re-attach history frame");

    // --- Two-round health probe: the actual shed detector ---
    // The chunk that trips the pending counter is still delivered (its
    // send succeeded before the shed check), so a single marker after
    // re-attach passes even on unfixed code. The shed only becomes
    // visible on the NEXT round of output: the subscriber is gone, so
    // nothing after the trip ever reaches this socket. Require markers
    // from two further commands; on unfixed code round 1 either delivers
    // the queued "backlog overflow" shutdown or goes silent.
    for round in 0..2 {
        let probe_cmd = format!("echo PROBE{round}-AL\"\"IVE-OK\n");
        let probe_marker = format!("PROBE{round}-ALIVE-OK");
        write_frame(&mut client, &encode_input(probe_cmd.as_bytes()));
        let probe_deadline = Instant::now() + Duration::from_secs(60);
        let mut probe_ok = false;
        while Instant::now() < probe_deadline && !probe_ok {
            client
                .set_recv_timeout(Some(Duration::from_millis(250)))
                .expect("set read timeout");
            match reader.poll(&mut client) {
                Some(payload) => {
                    if payload
                        .windows(b"backlog overflow".len())
                        .any(|w| w == b"backlog overflow")
                    {
                        panic!("client was shed after re-attach (overflow shutdown frame)");
                    }
                    probe_ok = marker_matcher.feed(&payload, probe_marker.as_bytes());
                }
                None => continue,
            }
        }
        assert!(
            probe_ok,
            "probe round {round} produced no output; subscriber was shed on re-attach"
        );
    }

    // Detach cleanly; the child must still be alive.
    write_frame(&mut client, &encode_detach());
    let status = guard
        .child
        .try_wait()
        .expect("try_wait on child")
        .map(|status| status.success());
    assert_eq!(status, None, "binary exited during the test");

    drop(guard);
}

/// Occurrences of the flood completion marker in a frame payload. The
/// typed command quotes the marker (FL""OOD-DONE) so the PTY echo never
/// matches; only real shell output does.
fn count_marker(payload: &[u8], marker: &[u8]) -> usize {
    payload
        .windows(marker.len())
        .filter(|window| *window == marker)
        .count()
}

/// Marker matcher that survives frame boundaries: chunked PTY output can
/// split a marker across two Terminal frames, so each feed joins a short
/// carry from the previous frame before counting.
struct MarkerMatcher {
    carry: Vec<u8>,
}

impl MarkerMatcher {
    fn new() -> Self {
        MarkerMatcher { carry: Vec::new() }
    }

    fn feed(&mut self, payload: &[u8], marker: &[u8]) -> bool {
        let mut joined = std::mem::take(&mut self.carry);
        joined.extend_from_slice(payload);
        let found = count_marker(&joined, marker) >= 1;
        let keep = marker.len().saturating_sub(1).min(joined.len());
        self.carry = joined[joined.len() - keep..].to_vec();
        found
    }
}
