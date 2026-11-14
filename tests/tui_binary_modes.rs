//! Non-interactive binary modes against hermetic fake backend sockets:
//! `--help`, `--summary` and `--once` all print and exit, so they run
//! as plain subprocesses (no PTY needed) and still exercise `main`'s
//! early-return arms under coverage. The integration harness runs
//! binaries with LLVM_PROFILE_FILE inherited, so the child counters
//! merge into the parent profile.
//!
//! The control socket speaks JSON lines; the terminal socket speaks the
//! client wire protocol (4-byte LE length + bincode frames). The
//! `--once` arm attaches a terminal over the wire protocol, so its fake
//! answers the handshake with a hand-encoded Welcome and replays one
//! Terminal frame, mirroring the encoding notes in `shed_binary_e2e.rs`.

use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

fn serve_fake_backend(path: &std::path::Path) -> std::sync::mpsc::Sender<()> {
    let name = path.to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || loop {
        if rx.try_recv().is_ok() {
            break;
        }
        let Ok(mut stream) = listener.accept() else {
            break;
        };
        let mut line = String::new();
        {
            let mut reader = BufReader::new(&mut stream);
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
        }
        let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let response = match request["method"].as_str().unwrap_or("") {
            "ping" => json!({"id": request["id"], "result": {"version": "modes", "protocol": 1}}),
            "session.snapshot" => json!({"id": request["id"], "result": {"snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
                "agents": []
            }}}),
            "pane.read" => {
                json!({"id": request["id"], "result": {"read": {"text": "hello modes"}}})
            }
            _ => json!({"id": request["id"], "result": {}}),
        };
        let _ = stream.write_all(serde_json::to_string(&response).unwrap().as_bytes());
        let _ = stream.write_all(b"\n");
        let _ = stream.flush();
    });
    tx
}

/// bincode standard-config varint, same notes as `shed_binary_e2e.rs`.
fn varint(value: u64) -> Vec<u8> {
    match value {
        0..=250 => vec![value as u8],
        251..=0xFFFF => {
            let mut out = vec![0xFB];
            out.extend_from_slice(&(value as u16).to_le_bytes());
            out
        }
        _ => {
            let mut out = vec![0xFC];
            out.extend_from_slice(&(value as u32).to_le_bytes());
            out
        }
    }
}

fn write_frame(stream: &mut impl Write, payload: &[u8]) {
    let len = u32::try_from(payload.len()).unwrap();
    stream.write_all(&len.to_le_bytes()).unwrap();
    stream.write_all(payload).unwrap();
    stream.flush().unwrap();
}

/// Read one length-prefixed frame without buffering past it.
fn read_frame(stream: &mut impl Read) -> Vec<u8> {
    let mut len_buf = [0u8; 4];
    stream.read_exact(&mut len_buf).unwrap();
    let len = u32::from_le_bytes(len_buf) as usize;
    let mut payload = vec![0u8; len];
    stream.read_exact(&mut payload).unwrap();
    payload
}

/// Terminal-socket fake: Welcome after the hello frame, then one
/// Terminal replay frame after the attach request.
///
/// `ServerMessage::Welcome` is variant 0: version varint, then
/// `RenderEncoding` unit-enum index (TerminalAnsi = 1), then
/// `Option<String>` (None = 0). `ServerMessage::Terminal` is variant 1
/// wrapping `TerminalFrame { seq, width, height, full, bytes }`.
fn serve_fake_terminal(path: &std::path::Path) -> std::sync::mpsc::Sender<()> {
    let name = path.to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || loop {
        if rx.try_recv().is_ok() {
            break;
        }
        let Ok(mut stream) = listener.accept() else {
            break;
        };
        // Hello frame (discarded; decoding ClientMessage is not needed).
        let _hello = read_frame(&mut stream);
        let mut welcome = varint(0); // ServerMessage::Welcome
        welcome.extend(varint(22)); // version
        welcome.extend(varint(1)); // RenderEncoding::TerminalAnsi
        welcome.push(0); // error: None
        write_frame(&mut stream, &welcome);
        // Attach request (discarded), then replay one output frame.
        let _attach = read_frame(&mut stream);
        let mut frame = varint(1); // ServerMessage::Terminal
        frame.extend(varint(0)); // seq
        frame.extend(varint(120)); // width
        frame.extend(varint(32)); // height
        frame.push(1); // full: true
        frame.extend(varint(b"hello modes\n".len() as u64));
        frame.extend_from_slice(b"hello modes\n");
        write_frame(&mut stream, &frame);
    });
    tx
}

fn run_binary(args: &[&str]) -> (String, String, Option<i32>) {
    let output = Command::new(env!("CARGO_BIN_EXE_herdr-webui-tui"))
        .args(args)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned(),
        output.status.code(),
    )
}

/// Run the binary with a 60s watchdog so a hung child cannot stall the
/// suite; the pipe handles are taken before the wait thread moves the
/// child.
fn run_binary_guarded(args: &[&str]) -> (String, String, Option<i32>) {
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_herdr-webui-tui"));
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let (tx, rx) = std::sync::mpsc::channel::<std::process::ExitStatus>();
    std::thread::spawn(move || {
        if let Ok(status) = child.wait() {
            let _ = tx.send(status);
        }
    });
    let status = rx
        .recv_timeout(Duration::from_secs(60))
        .expect("binary did not exit within 60s");
    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(out) = stdout_pipe.as_mut() {
        let _ = out.read_to_string(&mut stdout);
    }
    if let Some(err) = stderr_pipe.as_mut() {
        let _ = err.read_to_string(&mut stderr);
    }
    (stdout, stderr, status.code())
}

#[test]
fn help_flag_prints_usage_and_exits_clean() {
    for flag in ["--help", "-h"] {
        let (stdout, stderr, code) = run_binary(&[flag]);
        assert!(
            stdout.contains("Usage: herdr-webui-tui"),
            "no usage for {flag}"
        );
        assert!(
            stdout.contains("--summary"),
            "flags list missing for {flag}"
        );
        assert_eq!(code, Some(0));
        assert!(stderr.is_empty(), "help wrote to stderr for {flag}");
    }
}

#[test]
fn summary_flag_prints_backend_counts_and_exits() {
    let path = herdr_webui::backend_client::unique_test_path("herdr-tui-modes");
    let _ = std::fs::remove_file(&path);
    let _stop = serve_fake_backend(&path);
    let (stdout, stderr, code) = run_binary_guarded(&[
        "--summary",
        "--api-socket",
        path.to_str().unwrap(),
        "--terminal-socket",
        path.to_str().unwrap(),
    ]);
    assert!(
        stdout.contains("backend modes protocol 1"),
        "summary missing ping line: {stdout}"
    );
    assert!(stdout.contains("1 workspaces"), "summary: {stdout}");
    assert_eq!(code, Some(0), "stderr: {stderr}");
}

#[test]
fn once_flag_prints_text_snapshot_and_exits() {
    let api_path = herdr_webui::backend_client::unique_test_path("herdr-tui-modes-api");
    let term_path = herdr_webui::backend_client::unique_test_path("herdr-tui-modes-term");
    let _ = std::fs::remove_file(&api_path);
    let _ = std::fs::remove_file(&term_path);
    let _stop_api = serve_fake_backend(&api_path);
    let _stop_term = serve_fake_terminal(&term_path);
    let (stdout, stderr, code) = run_binary_guarded(&[
        "--once",
        "--api-socket",
        api_path.to_str().unwrap(),
        "--terminal-socket",
        term_path.to_str().unwrap(),
    ]);
    assert!(
        stdout.contains("Repo") || stdout.contains("jcode") || stdout.contains("hello modes"),
        "once snapshot should name the workspace, agent or tail: {stdout}"
    );
    assert_eq!(code, Some(0), "stderr: {stderr}");
}

#[test]
fn unknown_flag_fails_with_usage_on_stderr() {
    let (stdout, stderr, code) = run_binary(&["--nope"]);
    assert_eq!(code, Some(1));
    assert!(stdout.is_empty());
    assert!(stderr.contains("unknown argument: --nope"));
    assert!(stderr.contains("Usage: herdr-webui-tui"));
}

#[test]
fn summary_without_backend_fails_with_connection_error() {
    let path = herdr_webui::backend_client::unique_test_path("herdr-tui-dead");
    let _ = std::fs::remove_file(&path);
    let (stdout, stderr, code) = run_binary_guarded(&[
        "--summary",
        "--api-socket",
        path.to_str().unwrap(),
        "--terminal-socket",
        path.to_str().unwrap(),
    ]);
    assert_eq!(code, Some(1));
    assert!(stdout.is_empty());
    assert!(!stderr.is_empty(), "connection error expected on stderr");
}
