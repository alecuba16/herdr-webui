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
    serve_fake_backend_at(path, "/repo")
}

/// Same fake backend with a configurable workspace cwd, so PTY tests
/// can point the browser at real on-disk folders.
fn serve_fake_backend_at(path: &std::path::Path, cwd: &str) -> mpsc::Sender<()> {
    let cwd = cwd.to_string();
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
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd": cwd, "focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
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

/// Pump the PTY into a shared log so a single reader owns the master
/// fd (multiple cloned readers race for the same buffer and lose
/// chunks), while the log lets assertions wait for later output. The
/// pump also keeps draining so the pty buffer never fills and blocks
/// the TUI mid-draw.
fn pump(pty_out: Box<dyn Read + Send>) -> std::sync::Arc<std::sync::Mutex<String>> {
    let log = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let sink = log.clone();
    std::thread::spawn(move || {
        let mut reader = pty_out;
        let mut buf = vec![0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if let Ok(mut log) = sink.lock() {
                        log.push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                }
            }
        }
    });
    log
}

/// Block until `needle` shows up in the pumped log. 120s is a failure
/// deadline, not the expected duration.
///
/// Matches are tried against both the raw wire and an SGR-stripped
/// copy: ratatui's diff renderer only re-emits changed cells and puts
/// an SGR escape at every style boundary, so needles that span two
/// styled spans (or sit right after a style flip) never appear
/// contiguously in the raw stream.
fn wait_for(log: &std::sync::Arc<std::sync::Mutex<String>>, needle: &str) {
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        {
            let Ok(log) = log.lock() else { break };
            if log.contains(needle) || strip_sgr(&log).contains(needle) {
                return;
            }
            if Instant::now() > deadline {
                let tail = log.len().saturating_sub(2000);
                panic!(
                    "TUI did not render {needle:?} in time; tail of output: {:?}",
                    &log[tail..]
                );
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Block until the theme value shows on the overlay row. Two wire
/// forms are accepted: the differential renderer may re-emit just
/// the changed cell with an explicit cursor jump (`ESC[11;28Hvalue`),
/// or, when the backdrop dimming restyles the whole row (the depth
/// effect repaints every cell while an overlay is open), as plain
/// contiguous text (`themvalue`). Both prove the same thing: the
/// theme row now shows `value`.
fn wait_for_theme(log: &std::sync::Arc<std::sync::Mutex<String>>, value: &str) {
    let jump = format!("\u{1b}[11;28H{value}");
    // Settings rows pad the key to 16 columns ("  theme" + 11 spaces)
    // before the value, so a full-row re-emission reads as contiguous
    // "  theme          <value>" once SGR escapes are stripped.
    let plain = format!("  theme{}{value}", " ".repeat(11));
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        {
            let Ok(log) = log.lock() else { break };
            if log.contains(&jump)
                || log.contains(&plain)
                || strip_sgr(&log).contains(&jump)
                || strip_sgr(&log).contains(&plain)
            {
                return;
            }
            if Instant::now() > deadline {
                let tail = log.len().saturating_sub(2000);
                panic!(
                    "TUI did not render theme {value:?} in time; tail of output: {:?}",
                    &log[tail..]
                );
            }
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Remove `ESC [ ... m` (SGR) sequences so style changes cannot split a
/// needle. Cursor-movement escapes are kept, which is what makes the
/// deterministic overlay-cell needles below work.
fn strip_sgr(wire: &str) -> String {
    let mut out = String::with_capacity(wire.len());
    let mut chars = wire.chars();
    while let Some(ch) = chars.next() {
        if ch != '\u{1b}' {
            out.push(ch);
            continue;
        }
        // Peek for "[ m" (SGR, params allowed but irrelevant here):
        // anything else is copied verbatim so cursor moves survive.
        // `ESC[m` (no params) is a valid SGR reset and is stripped too.
        let mut rest = chars.clone();
        if rest.next() == Some('[') {
            let mut sgr = false;
            for param in rest.by_ref() {
                if !(param.is_ascii_digit() || param == ';') {
                    sgr = param == 'm';
                    break;
                }
            }
            if sgr {
                chars = rest;
                continue;
            }
        }
        out.push(ch);
    }
    out
}

/// Panic-safe cleanup for the spawned TUI: if a wait_for assertion
/// fails, the child would otherwise stay alive holding the PTY and
/// the fake backend thread would spin forever. RAII keeps the happy
/// path unchanged: `disarm` after the exit status is reaped. The
/// guard holds a `ChildKiller` clone so the watchdog thread keeps
/// ownership of the `Child` and its wait().
struct ChildGuard {
    killer: Option<Box<dyn portable_pty::ChildKiller>>,
}

impl ChildGuard {
    fn disarm(&mut self) {
        self.killer = None;
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(mut killer) = self.killer.take() {
            let _ = killer.kill();
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
    let mut child_guard = ChildGuard {
        killer: Some(child.clone_killer()),
    };
    let pty_out = pair.master.try_clone_reader().unwrap();
    let log = pump(pty_out);

    // The PTY is 80 cols wide, so the footer swaps to the compact hint:
    // it keeps `q quit` and the discovery tail, but drops `Ctrl+B prefix`.
    wait_for(&log, "q quit");
    assert!(
        log.lock().unwrap().contains("Ctrl+B ? help"),
        "footer should show the help discovery hint"
    );

    // Walk the settings overlay through the real binary: Ctrl+B arms
    // the prefix, `s` opens the overlay, the render must show the
    // Settings panel, `t` cycles the theme in the status line, and Esc
    // returns to Navigate before `q` can quit.
    let mut writer = pair.master.take_writer().unwrap();
    let _ = writer.write_all(&[0x02]); // Ctrl+B
    let _ = writer.write_all(b"s");
    let _ = writer.flush();
    wait_for(&log, "web api base");
    assert!(
        log.lock().unwrap().contains("t cycles the theme"),
        "settings overlay hint missing"
    );
    let _ = writer.write_all(b"t");
    let _ = writer.flush();
    // Asserting the theme cycle needs wire-format awareness; see
    // wait_for_theme. The overlay is fixed at 64x12 centered in the
    // 80x24 PTY. The transient "theme: X" status is not assertable:
    // the 50ms refresh overwrites it before the next draw roughly
    // half the time.
    wait_for_theme(&log, "dark");
    let _ = writer.write_all(b"t");
    let _ = writer.flush();
    wait_for_theme(&log, "light");
    // A third `t` wraps the cycle back to system.
    let _ = writer.write_all(b"t");
    let _ = writer.flush();
    wait_for_theme(&log, "system");
    let _ = writer.write_all(b"\x1b"); // Esc closes the overlay.
    let _ = writer.flush();
    // Give Esc time to land as its own event before the next keys.
    std::thread::sleep(Duration::from_millis(200));

    // Sidebar collapse through the real binary: Ctrl+B Shift+B hides the
    // workspace list (webui sidebar: KeyB), Ctrl+B Shift+B restores it.
    // The transient "sidebar hidden/shown" status loses the race with
    // the 50ms refresh, so the assertions use durable layout signals:
    // collapsed, the tab bar redraws at row 1 column 1 (it lived at
    // column 29 beside the 28-wide sidebar); restored, the sidebar
    // border redraws at row 1 column 1 with the Workspaces title.
    let _ = writer.write_all(&[0x02]); // Ctrl+B
    let _ = writer.write_all(b"B");
    let _ = writer.flush();
    wait_for(&log, "\u{1b}[1;1H Repo");
    let _ = writer.write_all(&[0x02]); // Ctrl+B
    let _ = writer.write_all(b"B");
    let _ = writer.flush();
    wait_for(&log, "\u{1b}[1;1H\u{250c} Workspaces");

    // Keep the last shortcut and `q` apart so both land as events.
    std::thread::sleep(Duration::from_millis(200));
    let _ = writer.write_all(b"q");
    let _ = writer.flush();
    // `q` now opens the quit confirmation overlay instead of exiting
    // directly: wait for the modal, then `y` confirms and the binary exits.
    wait_for(&log, "Quit herdr-webui-tui?");
    assert!(
        log.lock().unwrap().contains("QUIT?"),
        "footer should show the QUIT? mode while the overlay is open"
    );
    let _ = writer.write_all(b"y");
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
    let status = status.expect("TUI did not exit after q + y confirm");
    assert!(status.success());

    // The child has exited on its own: disarm the panic guard so its
    // Drop does not try to kill an already-reaped process.
    child_guard.disarm();

    let _ = std::fs::remove_file(&path);
    let _ = stop.send(());
}

#[test]
fn tui_binary_worktree_browser_and_picker_pty() {
    // End-to-end acceptance over the real binary: the prefix-W browser
    // overlay must show the browse root and its real subdirectories,
    // the typed filter must narrow the rows, and the prefix-N picker
    // must stage the browsed folder into the workspace name prompt.
    // The workspace cwd points at a real temp tree so the folder rows
    // come from the actual filesystem.
    // A deliberately short root keeps the this-folder row inside the
    // 80-col overlay on CI runners whose TMPDIR lives deep under
    // /var/folders and would truncate the rendered path. canonicalize
    // folds the /private/tmp symlink so the asserted path matches
    // what the TUI actually renders (the backend reports the cwd, and
    // this test asserts on the rendered path string).
    let root_raw =
        std::path::PathBuf::from(format!("/tmp/hdrw-tui-browser-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root_raw);
    std::fs::create_dir_all(&root_raw).unwrap();
    let root = std::fs::canonicalize(&root_raw).unwrap();
    let sub_alpha = root.join("alpha");
    let sub_beta = root.join("beta");
    std::fs::create_dir_all(&sub_alpha).unwrap();
    std::fs::create_dir_all(&sub_beta).unwrap();
    let root_path = root.to_string_lossy().to_string();

    let path = std::env::temp_dir().join(format!(
        "herdr-tui-pty-browser-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = std::fs::remove_file(&path);
    let stop = serve_fake_backend_at(&path, &root_path);

    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: 30,
            cols: 100,
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
    let mut child_guard = ChildGuard {
        killer: Some(child.clone_killer()),
    };
    let pty_out = pair.master.try_clone_reader().unwrap();
    let log = pump(pty_out);

    wait_for(&log, "q quit");

    // Ctrl+B w opens the browser: the "this folder" row shows the
    // browse root and both real subdirectories render as rows.
    let mut writer = pair.master.take_writer().unwrap();
    let _ = writer.write_all(&[0x02]); // Ctrl+B
    let _ = writer.write_all(b"w");
    let _ = writer.flush();
    wait_for(&log, "Open workspace or worktree");
    assert!(
        log.lock()
            .unwrap()
            .contains(&format!("this folder: {root_path}")),
        "this-folder row must show the browse root"
    );
    wait_for(&log, "alpha/");
    assert!(
        log.lock().unwrap().contains("beta/"),
        "subdirectories must render as folder rows"
    );
    assert!(
        log.lock().unwrap().contains("[folder]"),
        "folder badge must render"
    );

    // Typing filters the rows (webui modal search): "alp" matches only
    // alpha out of the three rows (this folder, alpha, beta), so the
    // count line narrows to 1/3. Positive assertions are used because
    // the pump log is append-only and ratatui only re-emits changed
    // cells: the narrowed count arrives contiguously in both repaint
    // forms (full-row repaint and per-cell diff update), while the
    // filter text itself may arrive as split cell updates, so "1/3"
    // is the stable wire signal for the narrowed result set.
    let _ = writer.write_all(b"alp");
    let _ = writer.flush();
    wait_for(&log, "1/3");
    // Esc clears the filter first, second Esc closes the overlay.
    let _ = writer.write_all(b"\x1b");
    let _ = writer.flush();
    std::thread::sleep(Duration::from_millis(200));
    let _ = writer.write_all(b"\x1b");
    let _ = writer.flush();
    std::thread::sleep(Duration::from_millis(300));

    // Ctrl+B n opens the picker over the same rows: the panel title
    // announces the pick intent ("o stages the folder"). The row badge
    // is truncated by the 80-col overlay behind the long temp path,
    // so the title is the assertable signal; the badge rendering is
    // covered by the unit tests.
    let _ = writer.write_all(&[0x02]); // Ctrl+B
    let _ = writer.write_all(b"n");
    let _ = writer.flush();
    wait_for(&log, "New workspace");
    wait_for(&log, "o stages the folder");
    let _ = writer.write_all(b"o");
    let _ = writer.flush();
    wait_for(&log, "Workspace name");
    assert!(
        log.lock().unwrap().contains(&root_path),
        "staged path must show as the prompt subject"
    );

    // Quit cleanly: Esc drops the prompt, Ctrl+B q + y exits.
    let _ = writer.write_all(b"\x1b");
    let _ = writer.flush();
    std::thread::sleep(Duration::from_millis(200));
    let _ = writer.write_all(&[0x02]); // Ctrl+B
    let _ = writer.write_all(b"q");
    let _ = writer.flush();
    wait_for(&log, "Quit herdr-webui-tui?");
    let _ = writer.write_all(b"y");
    let _ = writer.flush();
    drop(writer);

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
    let status = status.expect("TUI did not exit after q + y confirm");
    assert!(status.success());
    child_guard.disarm();

    let _ = std::fs::remove_file(&path);
    let _ = stop.send(());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn strip_sgr_removes_style_sequences_and_keeps_cursor_moves() {
    // SGR with params, SGR reset without params, and the cursor move
    // used by the theme needles: only the style escapes disappear.
    let wire = "\u{1b}[38;2;205;214;244;48;2;17;17;27mthem\u{1b}[11;28H\u{1b}[m\u{1b}[0mlight";
    assert_eq!(strip_sgr(wire), "them\u{1b}[11;28Hlight");
}

#[test]
fn strip_sgr_keeps_private_modes_and_non_csi_escapes() {
    // `ESC[?25l` (hide cursor) and `ESC]10;?\u{7}` (OSC query) are not
    // SGR and must survive verbatim.
    let wire = "\u{1b}[?25l\u{1b}]10;?\u{7}x";
    assert_eq!(strip_sgr(wire), wire);
}

#[test]
fn strip_sgr_handles_partial_and_truncated_sequences() {
    // A lone trailing ESC (chunk boundary) and an unterminated CSI run
    // are kept verbatim: the pumped log is always complete strings, but
    // the helper must stay total on truncated input.
    assert_eq!(strip_sgr("a\u{1b}"), "a\u{1b}");
    assert_eq!(strip_sgr("a\u{1b}[38;2"), "a\u{1b}[38;2");
    // ESC followed by a non-CSI char is not SGR either.
    assert_eq!(strip_sgr("\u{1b}Pq"), "\u{1b}Pq");
}

#[test]
fn child_guard_kills_a_live_child_on_drop_and_spares_a_disarmed_guard() {
    // A panicking wait_for must not leak the TUI process: the guard's
    // Drop kills the live child. A disarmed guard must not kill
    // anything (the happy path disarms after the child exited).
    let pty_system = NativePtySystem::default();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            ..Default::default()
        })
        .unwrap();
    let mut cmd = CommandBuilder::new("sleep");
    cmd.arg("30");
    let mut child = pair.slave.spawn_command(cmd).unwrap();

    let guard = ChildGuard {
        killer: Some(child.clone_killer()),
    };
    drop(guard);
    // The guard dropped without disarming: the child must now be dead.
    let status = child.wait().unwrap();
    assert!(!status.success(), "guard drop must kill the live child");

    // Disarmed: Drop is a no-op and the child dies naturally. Fresh
    // PTY pair: the first child's reaping closed the previous slave.
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            ..Default::default()
        })
        .unwrap();
    let mut child = pair
        .slave
        .spawn_command(CommandBuilder::new("true"))
        .unwrap();
    let mut guard = ChildGuard {
        killer: Some(child.clone_killer()),
    };
    guard.disarm();
    drop(guard);
    let status = child.wait().unwrap();
    assert!(status.success(), "disarmed guard must not kill the child");
}
