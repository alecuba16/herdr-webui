//! Terminal input throughput measurement against the real binary.
//!
//! Answers one question: is the webui input path (client socket frame ->
//! ClientMessage::Input decode -> PTY write) the limiting factor for how
//! fast a terminal can consume input? The test spawns the production
//! binary in builtin backend mode, attaches to a real shell, runs `cat`
//! as a pure echo sink, then pushes a fixed byte volume through real
//! Input frames and measures wall-clock throughput end to end (input in
//! -> PTY -> cat -> output frames back to this client).
//!
//! A direct PTY baseline (same volume, no webui in the path) runs first
//! in-process so the assertion can compare webui throughput against the
//! PTY's own line rate instead of an arbitrary constant: the webui path
//! must sustain at least a quarter of what the bare PTY sustains, and at
//! least 1 MB/s absolute. Both floors leave huge headroom for slow CI
//! runners while still failing loudly if the input path ever grows a
//! serialization stall (a per-byte lock, a decode copy per chunk, a
//! synchronous flush storm).
//!
//! Both floors are wall-clock claims, so they only bind on a quiet
//! machine: the gate below samples CPU idle and skips the floor asserts
//! (with the evidence printed) when something else is burning the CPU.

use interprocess::local_socket::{prelude::*, GenericFilePath, Stream};
use interprocess::TryClone;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Payload volume pushed through each path. Big enough that per-frame
/// overhead shows up in the rate, small enough that a debug build
/// finishes in seconds.
const PAYLOAD_BYTES: usize = 2 * 1024 * 1024;
/// Frame size for the webui Input frames. The browser sends whatever
/// chunking its queue picks (16KB chunks); this exercises the same
/// order of magnitude.
const INPUT_FRAME_BYTES: usize = 16 * 1024;
/// End marker: never appears in the payload (payload is 'x' bytes and
/// this uses digits + letters), sent as a separate final line after the
/// volume so the measurement window closes exactly when cat echoes it.
const MARKER: &[u8] = b"RATE9DONE7\n";

/// CPU idle fraction a machine must show for the wall-clock floors to
/// bind. Measured on a 10-core dev box: ambient load (load avg ~7,
/// 68% idle) still sustains the floors (webui 12.8 MB/s), while a
/// parallel 727-test suite (9% idle) collapses the webui leg 41x
/// (12.8 -> 0.31 MB/s) while the bare-PTY baseline only drops 5x. No
/// fixed rate separates "input path regressed" from "CPU starved",
/// so busy machines skip the floors instead of flaking.
const QUIET_CPU_IDLE_MIN: f64 = 0.40;

#[cfg(target_os = "macos")]
fn cpu_idle_fraction() -> Option<f64> {
    let out = Command::new("iostat")
        .args(["-c", "2", "-w", "1"])
        .output()
        .ok()?;
    parse_iostat_idle(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(target_os = "macos")]
/// `iostat -c 2 -w 1` prints a device line, then the units header (the
/// only line carrying the id column name), then a since-boot average and
/// the 1s sample; only that last line is current load. The id column
/// position comes from the units header because extra disks shift the
/// layout. Returns None instead of a wrong number when the format is
/// not recognized, which makes the quiet-gate fail closed.
fn parse_iostat_idle(text: &str) -> Option<f64> {
    let lines: Vec<&str> = text
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let header = *lines
        .iter()
        .find(|line| line.split_whitespace().any(|token| token == "id"))?;
    let id_col = header.split_whitespace().position(|token| token == "id")?;
    let sample = *lines.last()?;
    let idle: f64 = sample.split_whitespace().nth(id_col)?.parse().ok()?;
    Some(idle / 100.0)
}

#[cfg(target_os = "macos")]
#[test]
fn iostat_idle_parse_finds_the_id_column_behind_extra_devices() {
    // Regression: the first cut read line 1 (the device line) as the
    // header, so the probe returned None and the quiet-gate failed open
    // - floors bound on a machine a 727-test suite was strangling.
    let single_disk = "            disk0           cpu      load average
            KB/t  tps  MB/s   us sy id    1m   5m  15m
           45.26  827 36.56   21 11 68   7.21 8.24 9.28
           66.82 179  11.65   20 26 54   7.75 8.28 9.27";
    let two_disks = "            disk0  disk1           cpu      load average
            KB/t  tps  MB/s KB/t tps MB/s   us sy id   1m  5m 15m
           45.26  827 36.56 12.3 45 2.2   21 11 68   7.21 8.24 9.28
           66.82 179  11.65 15.1 60 1.4   20 26 54   7.75 8.28 9.27";
    // Line 1 is the since-boot average, line 2 is the 1s sample: the
    // parse must take the last line's id, not the first.
    assert_eq!(parse_iostat_idle(single_disk), Some(0.54));
    assert_eq!(parse_iostat_idle(two_disks), Some(0.54));
    assert_eq!(parse_iostat_idle("no id column here"), None);
}

#[cfg(target_os = "linux")]
/// CPU idle fraction over a 250ms /proc/stat delta.
fn cpu_idle_fraction() -> Option<f64> {
    let a = proc_stat_snap()?;
    std::thread::sleep(Duration::from_millis(250));
    let b = proc_stat_snap()?;
    (b.1 > a.1).then(|| (b.0 - a.0) as f64 / (b.1 - a.1) as f64)
}

/// (idle, total) from the aggregate `cpu` line: idle + iowait vs the sum
/// of all ticks. Parsing is separate from the file read so a macOS dev
/// box can regression-test the Linux path from real captured samples.
fn parse_proc_stat(first_line: &str) -> Option<(u64, u64)> {
    let fields: Vec<u64> = first_line
        .split_whitespace()
        .skip(1)
        .filter_map(|t| t.parse().ok())
        .collect();
    let idle = fields.get(3).copied()? + fields.get(4).copied().unwrap_or(0);
    Some((idle, fields.iter().sum()))
}

#[cfg(target_os = "linux")]
fn proc_stat_snap() -> Option<(u64, u64)> {
    let stat = std::fs::read_to_string("/proc/stat").ok()?;
    parse_proc_stat(stat.lines().next()?)
}

#[test]
fn proc_stat_idle_delta_matches_the_linux_aggregate_line() {
    // Real shapes from an Ubuntu box: 10-field line (with iowait) and a
    // guest-only 8-field line. The delta must land in [0,1] and move in
    // the same direction as the raw idle counter.
    let full = parse_proc_stat("cpu  74608 2520 24433 1117073 6176 4054 0 0 0 0").unwrap();
    assert_eq!(full, (1123249, 1228864));
    let short = parse_proc_stat("cpu  100 10 20 2000 5 0 0 0").unwrap();
    assert_eq!(short, (2005, 2135));
    // idle 2005 / total 2135 = 0.939, well under 1: the fraction math
    // holds on the short line too.
    assert!(short.0 as f64 / short.1 as f64 <= 1.0);
    assert_eq!(parse_proc_stat("not a stat line"), None);
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
/// No idle probe on this platform: floors bind unconditionally rather
/// than skip on a number we cannot see.
fn cpu_idle_fraction() -> Option<f64> {
    None
}

/// Wait up to `max_wait` for a quiet machine. Returns whether the floors
/// may bind, plus the idle samples as evidence for the skip message.
fn wait_for_quiet_cpu(max_wait: Duration) -> (bool, Vec<f64>) {
    let deadline = Instant::now() + max_wait;
    let mut samples = Vec::new();
    loop {
        match cpu_idle_fraction() {
            None => return (true, samples),
            Some(idle) => {
                samples.push(idle);
                if idle >= QUIET_CPU_IDLE_MIN {
                    return (true, samples);
                }
                if Instant::now() >= deadline {
                    return (false, samples);
                }
            }
        }
    }
}

/// Baseline: same volume straight into a bare PTY running cat. Returns
/// bytes/sec the PTY+cat pair sustained on this machine. This is what
/// the webui path is compared against: it isolates the kernel PTY and
/// cat from any webui code.
fn direct_pty_baseline() -> f64 {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("open baseline pty");
    // Same raw-mode treatment as the webui leg: a bare cat on a fresh
    // pty sits in canonical mode, and the 2 MiB no-newline payload dies
    // in the line buffer instead of echoing. sh -c lets stty raw run
    // inside the pty session before cat replaces it.
    let mut command = CommandBuilder::new("sh");
    command.arg("-c");
    command.arg("stty raw -echo; exec cat");
    let mut child = pair
        .slave
        .spawn_command(command)
        .expect("spawn baseline cat");
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .expect("clone baseline reader");
    let mut writer = pair.master.take_writer().expect("take baseline writer");

    // Give stty a beat to flip the line discipline before the first
    // payload byte lands: sh -c starts, runs stty, then execs cat, and a
    // write that arrives mid-transition can still hit canonical mode.
    std::thread::sleep(Duration::from_millis(500));

    let payload = vec![b'x'; PAYLOAD_BYTES];
    let mut sink = [0u8; 16384];
    // Reader thread drives the drain: the write side blocks once the PTY
    // buffer fills, so throughput only exists if someone reads.
    let start = Instant::now();
    let reader_handle = std::thread::spawn(move || {
        let mut total = 0_usize;
        let mut seen_marker = false;
        while !seen_marker {
            match reader.read(&mut sink) {
                Ok(0) => break,
                Ok(n) => {
                    total += n;
                    if sink[..n].windows(MARKER.len()).any(|w| w == MARKER) {
                        seen_marker = true;
                    }
                }
                Err(_) => break,
            }
        }
        total
    });
    for chunk in payload.chunks(INPUT_FRAME_BYTES) {
        writer.write_all(chunk).expect("baseline write");
    }
    writer.write_all(MARKER).expect("baseline marker write");
    writer.flush().expect("baseline flush");
    let echoed = reader_handle.join().expect("baseline reader");
    let elapsed = start.elapsed();
    let _ = child.kill();
    let _ = child.wait();
    assert!(
        echoed >= PAYLOAD_BYTES,
        "baseline cat echoed only {echoed} of {PAYLOAD_BYTES} bytes"
    );
    PAYLOAD_BYTES as f64 / elapsed.as_secs_f64()
}

// --- Wire protocol encoding (bincode standard config mirrors, verified
// byte-for-byte against bincode 2.0.1's own `encode_to_vec`) ---
//
// bincode's varint is NOT LEB128: values < 251 are one byte; larger
// values switch to a marker byte (FB = u16 LE, FC = u32 LE, FD = u64
// LE) carrying the whole number. A hand-rolled 7-bit LEB128 diverges at
// 128 and up, which silently desynced framing once 16KB Input frames
// started flowing (server saw "trailing bytes in frame").

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

fn encode_terminal_hello() -> Vec<u8> {
    let mut out = varint(0); // variant index
    out.extend(varint(22)); // version
    out.extend(varint(120)); // cols
    out.extend(varint(40)); // rows
    out.extend(varint(0)); // cell_width_px
    out.extend(varint(0)); // cell_height_px
    out.push(0); // pixel_mouse: false
    out
}

fn encode_input(data: &[u8]) -> Vec<u8> {
    let mut out = varint(1); // variant index
    out.extend(varint(data.len() as u64));
    out.extend_from_slice(data);
    out
}

fn encode_attach_terminal(terminal_id: &str) -> Vec<u8> {
    let mut out = varint(5); // variant index
    out.extend(varint(terminal_id.len() as u64));
    out.extend_from_slice(terminal_id.as_bytes());
    out.push(1); // takeover: true
    out
}

fn write_frame(stream: &mut Stream, payload: &[u8]) {
    let len = u32::try_from(payload.len()).expect("frame fits u32");
    stream.write_all(&len.to_le_bytes()).expect("write len");
    stream.write_all(payload).expect("write payload");
    stream.flush().expect("flush");
}

/// Buffered frame reader: partial reads accumulate so a recv timeout can
/// never desync the length-prefixed stream (read_exact discards on
/// timeout; on macOS the expiry even surfaces as WouldBlock).
struct FrameReader {
    buf: Vec<u8>,
}

impl FrameReader {
    fn new() -> Self {
        FrameReader { buf: Vec::new() }
    }

    /// One full frame within the socket's current recv timeout, else None.
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

    /// Blocking read: clears any leaked recv timeout first.
    fn read_frame(&mut self, stream: &mut Stream) -> Vec<u8> {
        stream.set_recv_timeout(None).expect("clear read timeout");
        loop {
            if let Some(frame) = self.poll(stream) {
                return frame;
            }
        }
    }
}

struct ServerGuard {
    child: Child,
    sockets: Vec<PathBuf>,
    home: PathBuf,
    log_tag: String,
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        for socket in &self.sockets {
            let _ = std::fs::remove_file(socket);
        }
        // Preserve the handler's failure line past the cleanup:
        // TMPDIR/<log_tag>-server-stderr.log keeps the one line
        // that explains a wedged or failed run. Tagged, not just
        // PID-named, so parallel runs never overwrite each other.
        let log = self.home.join("server-stderr.log");
        if log.exists() {
            let keep_path =
                std::env::temp_dir().join(format!("{}-server-stderr.log", self.log_tag));
            let _ = std::fs::copy(&log, keep_path);
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

/// The full measurement: spawn the real binary, attach to a real shell,
/// replace it with cat, push PAYLOAD_BYTES through real Input frames,
/// and measure until cat echoes the trailing marker back through real
/// Terminal frames. Returns webui-path bytes/sec.
fn webui_input_rate() -> f64 {
    let tag = format!(
        "rate-e2e-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis()
    );
    let home = std::env::temp_dir().join(&tag);
    std::fs::create_dir_all(&home).expect("create home");
    let settings_dir = home.join("herdr-webui");
    let (api_socket, client_socket) =
        herdr_webui::socket_paths::builtin_socket_paths_in(&settings_dir, Some("rate-e2e"));

    let bin = env!("CARGO_BIN_EXE_herdr-webui");
    // Server stderr lands in a file next to the sockets: the handler
    // thread's failure line ("builtin backend terminal connection
    // failed: ...") is the only place the root cause of a wedged test
    // shows up, and Stdio::null() threw it away.
    let log_path = home.join("server-stderr.log");
    let log_file = std::fs::File::create(&log_path).expect("create server stderr log");
    let child = Command::new(bin)
        .arg("--https")
        .arg("off")
        .arg("--bind")
        .arg("127.0.0.1:0")
        .arg("--session")
        .arg("rate-e2e")
        .arg("--backend-mode")
        .arg("builtin")
        .env("XDG_CONFIG_HOME", &home)
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_file))
        .spawn()
        .expect("spawn herdr-webui binary");

    let guard = ServerGuard {
        child,
        sockets: vec![api_socket.clone(), client_socket.clone()],
        home,
        log_tag: tag.clone(),
    };

    assert!(
        wait_for_socket(&api_socket, Duration::from_secs(30)),
        "api socket never appeared; binary may have failed to start"
    );
    assert!(
        wait_for_socket(&client_socket, Duration::from_secs(10)),
        "client socket never appeared"
    );

    let ws = api_request(
        &api_socket,
        r#"{"id":"1","method":"workspace.create","params":{"label":"rate-e2e"}}"#,
    );
    assert!(ws["result"].is_object(), "workspace.create failed: {ws}");
    let terminal_id = ws["result"]["root_pane"]["terminal_id"]
        .as_str()
        .or_else(|| ws["result"]["root_pane"]["pane_id"].as_str())
        .expect("terminal id in workspace.create result")
        .to_string();

    let client_socket_name = client_socket
        .to_fs_name::<GenericFilePath>()
        .expect("valid client socket name");
    let mut client = Stream::connect(client_socket_name).expect("connect client socket");
    let mut reader = FrameReader::new();
    write_frame(&mut client, &encode_terminal_hello());
    let welcome = reader.read_frame(&mut client);
    assert!(welcome.len() >= 4, "welcome frame too small");
    write_frame(&mut client, &encode_attach_terminal(&terminal_id));
    let replay = reader.read_frame(&mut client);
    assert!(!replay.is_empty(), "expected history replay frame");

    // The shell must be fully up before the exec line: under parallel
    // test load zsh startup can take seconds, and an exec line written
    // while zsh still initializes lands in the void. Drain frames until
    // the stream goes quiet, then give zsh one more beat to finish its
    // shell-integration sequence.
    client
        .set_recv_timeout(Some(Duration::from_millis(250)))
        .expect("set read timeout");
    let settle_deadline = Instant::now() + Duration::from_secs(15);
    let mut last_byte = Instant::now();
    while Instant::now() < settle_deadline {
        if reader.poll(&mut client).is_some() {
            last_byte = Instant::now();
        } else if last_byte.elapsed() > Duration::from_millis(800) {
            break;
        }
    }

    // Replace the login shell with a raw-mode echo sink. A fresh pty
    // sits in canonical mode: the line discipline holds input until a
    // newline, so a multi-KB payload with no newline echoes its first
    // 1KB and then blocks forever (measured: 16KB write -> 1024 bytes
    // echoed, cat never returns). `stty raw -echo` turns the pty into
    // a byte pipe; after it, cat replaces the shell and every input
    // byte echoes straight back (measured 2 MiB in ~139ms on the bare
    // pty). stty must run inside the shell session, not before exec.
    // One line, not two: a separate `exec cat` line lets zsh redraw its
    // prompt first, and zle restores the canonical tty modes it saved
    // at startup, silently undoing the raw flip. `exec` on the same
    // line replaces zsh before zle ever redraws.
    write_frame(&mut client, &encode_input(b"stty raw -echo; exec cat\n"));

    // Drain the echo of the setup lines so it cannot pollute the
    // measurement window: poll until the stream goes quiet for 600ms.
    let quiet_deadline = Instant::now() + Duration::from_secs(8);
    let mut last_byte = Instant::now();
    while Instant::now() < quiet_deadline {
        if reader.poll(&mut client).is_some() {
            last_byte = Instant::now();
        } else if last_byte.elapsed() > Duration::from_millis(600) {
            break;
        }
    }

    // cat liveness gate: one probe line must come back before the
    // measurement starts. If the exec failed or the shell is still
    // mid-transition, this fails fast instead of hanging the drain
    // loop below for two minutes.
    write_frame(&mut client, &encode_input(b"RATE7ALIVE\n"));
    let alive_deadline = Instant::now() + Duration::from_secs(10);
    let mut cat_live = false;
    while Instant::now() < alive_deadline && !cat_live {
        if let Some(frame) = reader.poll(&mut client) {
            if frame.windows(10).any(|w| w == b"RATE7ALIVE") {
                cat_live = true;
            }
        }
    }
    assert!(
        cat_live,
        "cat never echoed the liveness probe; exec cat did not take over the shell"
    );

    // Two jobs, two threads. The PTY holds only ~64KB; cat's echo fills
    // the kernel socket buffers long before all 2 MiB is written, so a
    // single-threaded write-then-drain deadlocks: the writer blocks in
    // write(2) while nobody drains the echo. Interleave instead: the
    // writer pushes Input frames and the reader drains Output frames
    // concurrently. The measurement window still opens at the first
    // payload frame and closes when the marker comes back.
    let payload = vec![b'x'; PAYLOAD_BYTES];
    let start = Instant::now();
    let mut writer_client = client.try_clone().expect("clone client stream for writer");
    // A wedged server handler (or one that died mid-flood, as observed
    // in the wild) leaves the socket undrained and this writer blocked
    // in write(2) forever. A send timeout turns that wedge into a loud
    // panic carrying the bytes written so far, instead of a test hung
    // past its 90s drain deadline.
    writer_client
        .set_send_timeout(Some(Duration::from_secs(10)))
        .expect("set writer send timeout");
    let writer_handle = std::thread::spawn(move || {
        let mut written = 0_usize;
        for chunk in payload.chunks(INPUT_FRAME_BYTES) {
            write_frame(&mut writer_client, &encode_input(chunk));
            written += chunk.len();
        }
        // Marker as its own Input frame: closes the measurement when the
        // echoed marker lands.
        write_frame(&mut writer_client, &encode_input(MARKER));
        written
    });

    // Drain output until the marker arrives. The window stays open until
    // the full volume came back: cat cannot echo what it has not read.
    client
        .set_recv_timeout(Some(Duration::from_millis(500)))
        .expect("set read timeout");
    let drain_deadline = Instant::now() + Duration::from_secs(90);
    let mut marker_tail: Vec<u8> = Vec::new();
    let mut saw_marker = false;
    let mut echoed = 0_usize;
    while Instant::now() < drain_deadline && !saw_marker {
        match reader.poll(&mut client) {
            Some(frame) => {
                echoed += frame.len();
                marker_tail.extend_from_slice(&frame);
                // Check BEFORE trimming: windows(MARKER.len()) needs the
                // combined buffer (last frame + retained tail) or a marker
                // split across frames never matches, and after the trim the
                // buffer is one byte short by construction.
                if marker_tail.windows(MARKER.len()).any(|w| w == MARKER) {
                    saw_marker = true;
                }
                let keep = MARKER.len().saturating_sub(1).min(marker_tail.len());
                if marker_tail.len() > keep {
                    marker_tail.drain(..marker_tail.len() - keep);
                }
            }
            None => continue,
        }
    }
    let elapsed = start.elapsed();
    let writer_written = writer_handle.join().expect("writer thread panicked");
    assert!(
        saw_marker,
        "marker never came back; cat echoed {echoed} bytes in {elapsed:?}, writer sent {writer_written} payload bytes"
    );
    // echoed covers payload + marker + any residual exec echo; only the
    // payload floor matters for the rate math.
    assert!(
        echoed >= PAYLOAD_BYTES,
        "cat echoed only {echoed} of {PAYLOAD_BYTES} bytes"
    );
    drop(client);
    drop(guard);
    PAYLOAD_BYTES as f64 / elapsed.as_secs_f64()
}

#[test]
fn varint_matches_bincode_across_the_value_space() {
    // The wire-format mirror above was wrong once (LEB128 vs bincode's
    // marker scheme); this sweep locks it to the real encoder so it
    // cannot drift again. Covers every scheme boundary (250/251 inline,
    // FB u16, FC u32, FD u64) plus the frame-length neighborhood the
    // flood actually encodes.
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
        INPUT_FRAME_BYTES as u64 - 1,
        INPUT_FRAME_BYTES as u64,
        INPUT_FRAME_BYTES as u64 + 1,
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
    // ClientMessage through the production bincode path. Integration
    // tests cannot import the pub(crate) type, so both suites pin these
    // goldens: this side proves the hand-rolled mirrors emit the same
    // bytes the real encoder does (verified once by the differential
    // below, kept as a constant golden so the contract is visible in
    // both binaries). A drift here fails fast at test time instead of
    // desyncing a live handshake with "trailing bytes in frame".
    assert_eq!(
        encode_terminal_hello(),
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

    // 16 KiB Input frame: the exact size the flood pushes. Length 16384
    // = 0x4000 > 250, so bincode emits FB + u16 LE (00 40); the old
    // LEB128 mirror emitted 80 80 01 here and desynced framing.
    let big = vec![b'x'; INPUT_FRAME_BYTES];
    let big_encoded = encode_input(&big);
    assert_eq!(&big_encoded[..4], &[0x01, 0xFB, 0x00, 0x40]);
    assert_eq!(big_encoded.len(), 4 + INPUT_FRAME_BYTES);
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
}

#[test]
fn builtin_binary_input_path_is_not_the_bottleneck() {
    let (quiet, idle_samples) = wait_for_quiet_cpu(Duration::from_secs(10));
    let baseline = direct_pty_baseline();
    let webui = webui_input_rate();
    // Report both so the assertion failure message carries the numbers a
    // developer needs (and a passing run logs them for the record).
    println!("direct pty baseline: {baseline:.2} bytes/s");
    println!("webui input path:     {webui:.2} bytes/s");
    println!("webui/baseline ratio: {:.3}", webui / baseline.max(1.0));
    if !quiet {
        println!(
            "cpu idle samples {:?} never reached {:.0}% in 10s; \
             floor asserts skipped: wall-clock rates do not bind under external load",
            idle_samples,
            QUIET_CPU_IDLE_MIN * 100.0
        );
        return;
    }
    // Quiet at start is not enough: a compile job arriving mid-measure
    // poisons both legs the same way, so re-sample before binding the
    // floors and skip (with evidence) if the machine turned busy.
    if let Some(idle_now) = cpu_idle_fraction() {
        if idle_now < QUIET_CPU_IDLE_MIN {
            println!(
                "cpu idle dropped to {:.0}% during the measurement; \
                 floor asserts skipped: wall-clock rates do not bind under external load",
                idle_now * 100.0
            );
            return;
        }
    }
    // Floors: the webui path must sustain a quarter of the bare PTY's
    // line rate (a healthy implementation sits near 1.0; anything below
    // 0.25 means the webui added a 4x bottleneck) and an absolute 1
    // MB/s so the claim "not the limiting factor" holds even when the
    // baseline itself is unusually slow.
    assert!(
        webui >= baseline * 0.25,
        "webui input path ({webui:.0} B/s) is under a quarter of the direct pty rate ({baseline:.0} B/s); the webui is the bottleneck"
    );
    assert!(
        webui >= 1_048_576.0,
        "webui input path ({webui:.0} B/s) is under the 1 MB/s floor; the webui is the bottleneck"
    );
}
