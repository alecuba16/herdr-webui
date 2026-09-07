//! End-to-end PTY test: spawn the real `herdr-webui-tui` binary against a
//! hermetic fake backend socket and drive it through a pseudo-terminal, so
//! the interactive loop in `run_interactive`/`main` runs under coverage.

use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
use portable_pty::{CommandBuilder, NativePtySystem, PtySize, PtySystem};
use serde_json::json;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

fn serve_fake_backend(path: &std::path::Path) -> mpsc::Sender<()> {
    let name = path.to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = mpsc::channel::<()>();
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
            "ping" => json!({"id": request["id"], "result": {"version": "pty", "protocol": 1}}),
            "session.snapshot" => json!({"id": request["id"], "result": {"snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idled","cwd":"/repo","focused":true}],
                "agents": []
            }}}),
            "pane.read" => {
                json!({"id": request["id"], "result": {"read": {"text": "hello from pty"}}})
            }
            "tab.create" | "tab.close" => {
                json!({"id": request["id"], "result": {"ok": true}})
            }
            _ => json!({"id": request["id"], "result": {}}),
        };
        let _ = stream.write_all(serde_json::to_string(&response).unwrap().as_bytes());
        let _ = stream.write_all(b"\n");
        let _ = stream.flush();
    });
    tx
}

/// Pump the PTY on a dedicated thread so a hung render cannot block the
/// test forever: the main thread enforces the deadline via the channel.
fn read_until(pty_out: Box<dyn Read + Send>, needle: &str, timeout: Duration) -> String {
    let needle = needle.to_string();
    let (tx, rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = pty_out;
        let mut buf = vec![0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => {
                    let _ = tx.send(String::new());
                    return;
                }
                Ok(n) => {
                    if tx
                        .send(String::from_utf8_lossy(&buf[..n]).into_owned())
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
    });
    let mut seen = String::new();
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            panic!("TUI did not render {needle:?} in time; output so far: {seen:?}");
        }
        match rx.recv_timeout(remaining) {
            Ok(chunk) => {
                seen.push_str(&chunk);
                if seen.contains(&needle) {
                    return seen;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                panic!("TUI did not render {needle:?} in time; output so far: {seen:?}")
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                panic!("PTY closed before {needle:?}; output: {seen:?}")
            }
        }
    }
}

#[test]
fn tui_binary_interactive_loop_pty() {
    let path = std::env::temp_dir().join(format!(
        "herdr-tui-pty-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_file(&path);
    let stop = serve_fake_backend(&path);

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            ..Default::default()
        })
        .unwrap();
    let mut cmd = CommandBuilder::new(env!("CARGO_BIN_EXE_herdr-webui-tui"));
    cmd.args([
        "--api-socket",
        path.to_str().unwrap(),
        "--terminal-socket",
        path.to_str().unwrap(),
        "--refresh-ms",
        "50",
    ]);
    let mut child = pair.slave.spawn_command(cmd).unwrap();
    let pty_out = pair.master.try_clone_reader().unwrap();

    // The TUI renders its footer with the Navigate hint. The watcher gets a
    // clone; the original reader keeps draining in the background below,
    // because nothing else consumes the master output once the needle is
    // found: the pty buffer would fill and the TUI would block mid-draw,
    // never reaching its input poll (it hangs before reading `q`).
    // 120s is a failure deadline, not the expected duration.
    let watcher = pair.master.try_clone_reader().unwrap();
    let seen = read_until(watcher, "q quit", Duration::from_secs(120));
    assert!(
        seen.contains("Ctrl+B prefix"),
        "footer should show prefix hint"
    );

    // Drain master output until the child exits so redraws never block.
    let (drain_tx, _drain_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut reader = pty_out;
        let mut buf = vec![0u8; 4096];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
        }
        let _ = drain_tx.send(());
    });

    // 'q' quits the interactive loop and the binary exits 0.
    let mut writer = pair.master.take_writer().unwrap();
    let _ = writer.write_all(b"q");
    let _ = writer.flush();
    drop(writer);

    // Reap the child on a watchdog thread with a hard deadline; a plain
    // wait() would hang forever if the TUI failed to quit. On timeout the
    // killer reaps the process so a failed test never leaks it.
    let (tx, rx) = mpsc::channel::<portable_pty::ExitStatus>();
    let mut killer = child.clone_killer();
    std::thread::spawn(move || {
        if let Ok(status) = child.wait() {
            let _ = tx.send(status);
        }
    });
    let status = rx.recv_timeout(Duration::from_secs(120));
    if status.is_err() {
        let _ = killer.kill();
    }
    let status = status.expect("TUI did not exit after q");
    assert!(status.success());

    let _ = std::fs::remove_file(&path);
    let _ = stop.send(());
}
