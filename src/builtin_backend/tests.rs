#![cfg(test)]

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
fn strip_terminal_title_suffix_drops_mutating_status_tokens() {
    // jcode's live metrics suffix: both markers cut at the first
    // occurrence, leaving the stable title head.
    assert_eq!(
        strip_terminal_title_suffix("jcode · src/foo.rs · work ~1m09s"),
        "jcode · src/foo.rs"
    );
    assert_eq!(
        strip_terminal_title_suffix("jcode · src/foo.rs · last ~4h02m"),
        "jcode · src/foo.rs"
    );
    // Braille spinner prefixes never reach a header.
    assert_eq!(strip_terminal_title_suffix("⠙ Working…"), "Working…");
    // A title with no known token comes back trimmed only.
    assert_eq!(
        strip_terminal_title_suffix("  plain title  "),
        "plain title"
    );
    // Everything strips to nothing -> empty (callers treat empty
    // as no title).
    assert_eq!(strip_terminal_title_suffix("⠙"), "");
    assert_eq!(strip_terminal_title_suffix(" · work ~1s"), "");
}

#[test]
fn pane_json_serves_terminal_title_from_the_osc_tracker() {
    let state = BuiltinState::new(
        std::env::temp_dir(),
        Some(hermetic_test_shell()),
        JcodeDetectionVariant::Vanilla,
    )
    .unwrap();
    let workspace = state.handle_request(
        "seed",
        "workspace.create",
        json!({
            "label": "Workspace",
            "open_terminal": false
        }),
    );
    let workspace_id = workspace["result"]["workspace"]["workspace_id"]
        .as_str()
        .unwrap()
        .to_string();
    let tab = state.handle_request(
        "seed",
        "tab.create",
        json!({ "workspace_id": workspace_id, "label": "Tab", "focus": true }),
    );
    let pane_id = tab["result"]["root_pane"]["pane_id"]
        .as_str()
        .unwrap()
        .to_string();
    let terminal_id = tab["result"]["root_pane"]["terminal_id"]
        .as_str()
        .unwrap()
        .to_string();

    // No title observed yet: both fields stay null.
    let before = state.handle_request("q", "session.snapshot", json!({}));
    let pane_before = before["result"]["snapshot"]["panes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pane| pane["pane_id"].as_str() == Some(pane_id.as_str()))
        .cloned()
        .unwrap();
    assert!(pane_before["terminal_title"].is_null());
    assert!(pane_before["terminal_title_stripped"].is_null());

    // A pane_json read with the tracker primed serves both fields:
    // the raw OSC 0 title and the stripped form without the
    // metrics suffix.
    let value = state.data.lock().unwrap();
    let terminal = value.terminals.get(&terminal_id).unwrap();
    {
        let mut tracker = terminal.osc9_tracker.lock().unwrap();
        tracker.observe(b"\x1b]0;jcode \xC2\xB7 src/foo.rs \xC2\xB7 work ~1m09s\x07");
    }
    let pane = value
        .panes
        .get(&pane_id)
        .map(|pane| pane_json(pane, &value))
        .unwrap();
    drop(value);
    assert_eq!(
        pane["terminal_title"].as_str(),
        Some("jcode · src/foo.rs · work ~1m09s")
    );
    assert_eq!(
        pane["terminal_title_stripped"].as_str(),
        Some("jcode · src/foo.rs")
    );
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
fn promote_create_tab_with_shell(state: &BuiltinState, workspace_id: &str, label: &str) -> String {
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
    panic!("shell in tab {tab_id} never processed cd into {dir:?} (last live cwd: {last_seen:?})");
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
    let guard = state.handle_request("promote-guard", "tab.promote", json!({ "tab_id": tab_id }));
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
    let closed = state.handle_request("close", "pane.close", json!({ "pane_id": "pane_missing" }));
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
    // pattern fires against real output. The bound must cover a
    // fresh debug server boot under load (observed 33s from spawn to
    // first prompt on a busy machine: config parse, migrations, and
    // context-limit caches all run before the TUI leaves the
    // connecting screen), so 120s keeps the wait generous without
    // hanging a genuinely broken boot.
    let deadline = std::time::Instant::now() + Duration::from_secs(120);
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
        let mut provider_dead = false;
        loop {
            let timeout = flip_deadline.saturating_duration_since(std::time::Instant::now());
            if timeout.is_zero() {
                break;
            }
            match rx.recv_timeout(timeout.min(Duration::from_millis(250))) {
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
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Ok(_) => {}
            }
            // The isolated home has no usable provider when the parent
            // keeps auth on disk (no bare ANTHROPIC_API_KEY in the env):
            // the turn errors in ~16ms, under the detector's 500ms sample,
            // so no working event ever fires. Skip the flip assertions
            // like `live_jcode_binary` skips without a jcode build; the
            // boot-phase assertions above still prove the detector reads
            // real chrome.
            if !saw_working
                && terminal
                    .history_tail_text(DETECTION_TAIL_BYTES)
                    .contains("No tokens/providers left")
            {
                provider_dead = true;
                break;
            }
        }
        if provider_dead {
            eprintln!(
                    "live_jcode_tui_detection_end_to_end: no usable provider in the isolated home, skipping the working flip assertions"
                );
            terminal.kill_and_wait();
            drop(terminal);
            return;
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
fn agent_prompt_enqueue_validates_input() {
    // Long-press Send: enqueue shares every agent.prompt validation
    // (herdr-compatible codes) and reports the enqueue flag back.
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

    // Empty message refused, same code as the normal submit.
    let response = state.handle_request(
        "t1",
        "agent.prompt",
        json!({ "pane_id": pane_id, "text": "  \n", "enqueue": true }),
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
        json!({ "pane_id": pane_id, "text": long, "enqueue": true }),
    );
    assert!(response["error"]["message"]
        .as_str()
        .unwrap_or("")
        .starts_with("message_too_long"));

    // Blocked pane refused before anything is typed: a message typed
    // into an open dialog would answer the dialog.
    {
        let mut previous = terminal.last_agent_state.lock().unwrap();
        *previous = Some((Some("jcode".to_string()), "blocked".to_string(), 0));
    }
    let response = state.handle_request(
        "t3",
        "agent.prompt",
        json!({ "pane_id": pane_id, "text": "should be refused", "enqueue": true }),
    );
    assert_eq!(
        response["error"]["message"],
        "agent_blocked: the agent is waiting for an answer in the terminal"
    );
    {
        let mut previous = terminal.last_agent_state.lock().unwrap();
        *previous = None;
    }

    // Unknown pane refused with agent_not_found (herdr-compatible).
    let response = state.handle_request(
        "t4",
        "agent.prompt",
        json!({ "pane_id": "no-such-pane", "text": "hi", "enqueue": true }),
    );
    assert!(response["error"]["message"]
        .as_str()
        .unwrap_or("")
        .starts_with("agent_not_found"));

    // Successful enqueue reports the flag on the wire.
    let response = state.handle_request(
        "t5",
        "agent.prompt",
        json!({ "pane_id": pane_id, "text": "queue me", "enqueue": true }),
    );
    assert_eq!(response["result"]["ok"], json!(true));
    assert_eq!(response["result"]["enqueue"], json!(true));

    // Legacy submit without the flag reports enqueue=false (the
    // older clients' shape stays byte-compatible on the new field).
    let response = state.handle_request(
        "t6",
        "agent.prompt",
        json!({ "pane_id": pane_id, "text": "plain send" }),
    );
    assert_eq!(response["result"]["enqueue"], json!(false));
}

#[test]
fn agent_prompt_enqueue_sends_csi_u_after_gap() {
    // /bin/cat echoes its stdin, so both the bracketed paste AND the
    // delayed Ctrl+Enter must appear in the scrollback. The CSI-u
    // bytes arrive after the same 300ms gap as the plain Enter.
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
        json!({ "pane_id": pane_id, "text": "hold to queue\nsecond line\n", "enqueue": true }),
    );
    assert!(
        response.get("error").is_none(),
        "enqueue must succeed on a plain shell pane: {response}"
    );

    std::thread::sleep(Duration::from_millis(AGENT_PROMPT_ENTER_GAP_MS + 700));
    // pane.read strips ANSI, so assert on the raw PTY history: /bin/cat
    // echoes everything it read, including the delayed CSI-u bytes.
    let terminal = {
        let data = state.data.lock().unwrap();
        let pane = data.panes.get(&pane_id).unwrap();
        data.terminals.get(&pane.terminal_id).unwrap().clone()
    };
    let history = terminal.history_bytes();
    let raw = String::from_utf8_lossy(&history);
    assert!(
        raw.contains("hold to queue\r\nsecond line"),
        "paste payload missing from pane output: {raw:?}"
    );
    // The scrollback holds both raw echo bytes (real ESC) and the
    // emulator-rendered grid text where ESC shows up in caret notation
    // (^[). Assert on the CSI-u parameter payload so both encodings
    // pass: what matters is that the delayed Ctrl+Enter reached the
    // pane after the paste, in either captured form.
    assert!(
        raw.contains("\u{1b}[13;5u") || raw.contains("^[[13;5u"),
        "delayed Ctrl+Enter CSI-u missing from pane output: {raw:?}"
    );
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
    terminal.append_output("jcode\n1> ask anything\n~/…/proj  main ▱▱▱▱ 2% llmg-coding".as_bytes());
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
fn terminal_exit_synthesizes_mouse_and_paste_decrst_for_subscribers() {
    // jcode never sends DECRST on exit (crossterm's restore only flips
    // raw mode), so the backend must synthesize it. Through append_output
    // the bytes reach subscribers and scrollback, which is what flips the
    // client adapter's sniffed mouse mode off.
    let hub = BuiltinEventHub::new();
    let context = PaneEventContext {
        workspace_id: "ws_decrst".to_string(),
        tab_id: "tab_decrst".to_string(),
        pane_id: "pane_decrst".to_string(),
        terminal_id: "term_decrst".to_string(),
    };
    let terminal = TerminalRuntime::spawn(
        "term_decrst".to_string(),
        std::env::current_dir().unwrap(),
        vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf hi".to_string(),
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

    let mut joined = Vec::new();
    let mut saw_exit = false;
    for _ in 0..32 {
        match rx.recv_timeout(Duration::from_secs(2)).unwrap() {
            TerminalSubscriberMessage::Output(bytes) => joined.extend_from_slice(&bytes),
            TerminalSubscriberMessage::Replay(..) => {}
            TerminalSubscriberMessage::Overflow => {}
            TerminalSubscriberMessage::Exited => {
                saw_exit = true;
                break;
            }
        }
    }
    assert!(saw_exit);
    let text = String::from_utf8_lossy(&joined);
    for mode in ["1000", "1002", "1003", "1015", "1006", "2004"] {
        assert!(
            text.contains(&format!("\x1b[?{mode}l")),
            "exit must synthesize DECRST for mode {mode}, got: {text:?}"
        );
    }
}

#[test]
fn attach_replay_tail_is_bounded_and_line_aligned() {
    let hub = BuiltinEventHub::new();
    let context = PaneEventContext {
        workspace_id: "ws_tail".to_string(),
        tab_id: "tab_tail".to_string(),
        pane_id: "pane_tail".to_string(),
        terminal_id: "term_tail".to_string(),
    };
    let terminal = TerminalRuntime::spawn(
        "term_tail".to_string(),
        std::env::current_dir().unwrap(),
        vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf x".to_string(),
        ],
        24,
        80,
        hub,
        context,
        JcodeDetectionVariant::Vanilla,
    )
    .unwrap();
    // Fill scrollback past the replay cap with lines that carry a
    // marker: the replay must keep the newest 256KB (bounded) and start
    // at a line boundary, not mid-line.
    let mut filler = String::new();
    for i in 0..8000 {
        filler.push_str(&format!("line {i:05} padding padding padding\n"));
    }
    terminal.append_output(filler.as_bytes());
    terminal.reset_status_throttle();
    let tail = terminal.attach_replay_bytes();
    assert!(tail.len() <= ATTACH_REPLAY_MAX_BYTES, "replay is bounded");
    assert!(
        tail.len() > ATTACH_REPLAY_MAX_BYTES - 4096,
        "replay keeps (nearly) the whole budget, got {} bytes",
        tail.len()
    );
    let text = String::from_utf8_lossy(&tail);
    // The newest line must be present: nothing at the tail was dropped.
    assert!(text.contains("line 07999"), "newest lines survive");
    // Line alignment: the replay starts at the beginning of a line, so
    // the first row renders a complete line instead of a mid-line cut.
    let first_line_end = text.find('\n').unwrap_or(text.len());
    let first_line = &text[..first_line_end];
    assert!(
        first_line.starts_with("line 0"),
        "replay starts on a line boundary, got start: {:?}",
        &text[..text.len().min(80)]
    );
}

#[test]
fn attach_replay_returns_full_history_below_the_cap() {
    let hub = BuiltinEventHub::new();
    let context = PaneEventContext {
        workspace_id: "ws_small".to_string(),
        tab_id: "tab_small".to_string(),
        pane_id: "pane_small".to_string(),
        terminal_id: "term_small".to_string(),
    };
    let terminal = TerminalRuntime::spawn(
        "term_small".to_string(),
        std::env::current_dir().unwrap(),
        vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "printf x".to_string(),
        ],
        24,
        80,
        hub,
        context,
        JcodeDetectionVariant::Vanilla,
    )
    .unwrap();
    terminal.append_output(b"first\nsecond\nthird\n");
    terminal.reset_status_throttle();
    let tail = terminal.attach_replay_bytes();
    // The spawned shell's own bytes can land in scrollback before or
    // after this append (async reader), so containment + size, not
    // byte equality: below the cap nothing is dropped or trimmed.
    assert!(
        tail.len() < ATTACH_REPLAY_MAX_BYTES,
        "small history stays small"
    );
    let text = String::from_utf8_lossy(&tail);
    assert!(text.contains("first\nsecond\nthird\n"));
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
fn agent_quit_inside_shell_synthesizes_decrst_exactly_once() {
    // The primary bug-B repro: jcode runs inside the pane's zsh and
    // quits (Ctrl-C), the shell stays alive. notify_exited never fires
    // (the pane child did not exit), so the DECRST must come from the
    // live->absent transition in update_agent_exit_record.
    let hub = BuiltinEventHub::new();
    let context = PaneEventContext {
        workspace_id: "ws_inner".to_string(),
        tab_id: "tab_inner".to_string(),
        pane_id: "pane_inner".to_string(),
        terminal_id: "term_inner".to_string(),
    };
    let terminal = TerminalRuntime::spawn(
        "term_inner".to_string(),
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
    let (tx, rx) = mpsc::channel();
    terminal.subscribe(TerminalSubscriber {
        tx,
        pending_bytes: Arc::new(AtomicUsize::new(0)),
    });
    terminal.reset_status_throttle();

    let count_decrst = |bytes: &[u8], needle: &[u8]| {
        bytes
            .windows(needle.len())
            .filter(|window| *window == needle)
            .count()
    };

    // Live agent seen, then gone: the transition synthesizes the reset.
    terminal.update_agent_exit_record(Some("jcode"), true);
    terminal.update_agent_exit_record(None, true);
    assert!(terminal.recent_agent_exit_active());

    // Repeat empty probes must not synthesize again (armed-flag one-shot).
    terminal.update_agent_exit_record(None, true);
    terminal.update_agent_exit_record(None, true);

    let mut joined = Vec::new();
    while let Ok(message) = rx.try_recv() {
        if let TerminalSubscriberMessage::Output(bytes) = message {
            joined.extend_from_slice(&bytes);
        }
    }
    for mode in ["1000", "1002", "1003", "1015", "1006", "2004"] {
        let needle = format!("\x1b[?{mode}l").into_bytes();
        assert_eq!(
            count_decrst(&joined, &needle),
            1,
            "mode {mode} reset synthesized exactly once at the transition"
        );
    }
    // And the same bytes are in scrollback, so re-attach replays the reset
    // and the adapter's sniffer flips even for a late attach.
    let tail = terminal.attach_replay_bytes();
    let needle = b"\x1b[?1006l";
    assert_eq!(
        count_decrst(&tail, needle),
        1,
        "reset lands in scrollback once"
    );

    // Agent comes back and quits again: a second full cycle synthesizes
    // a second reset (each quit leaves its own DECSET stale).
    terminal.update_agent_exit_record(Some("jcode"), true);
    terminal.update_agent_exit_record(None, true);
    let mut second = Vec::new();
    while let Ok(message) = rx.try_recv() {
        if let TerminalSubscriberMessage::Output(bytes) = message {
            second.extend_from_slice(&bytes);
        }
    }
    let needle = b"\x1b[?1006l";
    assert_eq!(
        count_decrst(&second, needle),
        1,
        "a fresh quit cycle synthesizes one more reset"
    );
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
        detect_agent_status_with_osc(Some("amp"), "", "", "⠋ amp", JcodeDetectionVariant::Vanilla),
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
        detect_agent_status_with_osc(Some("grok"), "", "", "grok", JcodeDetectionVariant::Vanilla),
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
        ("qwen", "yes, allow once\napply this change?", "blocked"),
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
        (
            "hermes",
            "hermes needs your input\nenter to confirm",
            "blocked",
        ),
        (
            "hermes",
            "ask a question\ntype your answer\nenter send",
            "blocked",
        ),
        ("hermes", "sudo password\nenter to confirm", "blocked"),
        ("hermes", "🔑 root@host for sudo\nenter confirm", "blocked"),
        ("hermes", "approve once\ncancel\ntype 1/2/3", "blocked"),
        ("hermes", "msg=interrupt", "working"),
        ("hermes", "ctrl+c to interrupt", "working"),
        ("hermes", "ctrl+c cancel", "working"),
        ("kilo", "△ Permission required", "blocked"),
        ("kilo", "esc interrupt", "working"),
        (
            "kimi",
            "↵ confirm\nrun this command?\napprove\n choose",
            "blocked",
        ),
        (
            "kimi",
            "approve this change?\n↵ confirm\nreject\n choose",
            "blocked",
        ),
        (
            "kimi",
            "↑↓ select\nesc cancel\nquestion\n↵ choose",
            "blocked",
        ),
        (
            "kimi",
            "requesting approval\nreject\napprove once\n1/2/3/4 choose",
            "blocked",
        ),
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

    let idle_screen =
        terminal_screen_text_lossy("⠋ running bash · npm test · 12s\r\u{1b}[2KSession ready\n1> ");
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
    // Kilo: unmatched text falls through to unknown.
    assert_eq!(
        detect_agent_status(
            Some("kilo"),
            "no markers here",
            JcodeDetectionVariant::Vanilla
        ),
        "unknown"
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
    // Antigravity: the tab-amend + edit-command permission variant
    // blocks without the "do you want to proceed?" line.
    assert_eq!(
        detect_agent_status(
            Some("agy"),
            "requesting permission for:\ntab amend\nedit command",
            JcodeDetectionVariant::Vanilla
        ),
        "blocked"
    );
    // Antigravity: text with no manifest markers stays unknown.
    assert_eq!(
        detect_agent_status(
            Some("agy"),
            "plain prompt text",
            JcodeDetectionVariant::Vanilla
        ),
        "unknown"
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
fn builtin_read_pane_screen_format_replays_composed_screen() {
    // Fullscreen-TUI draw stream (jcode shape): repaint via cursor
    // addressing and erase ops, spinner frames glued by CR. The plain
    // strip format keeps every draw fragment, so the tail reads as
    // garbage rows; format=screen must replay the same bytes into the
    // composed final screen.
    let state = BuiltinState::new(
        std::env::temp_dir(),
        Some(hermetic_test_shell()),
        JcodeDetectionVariant::Vanilla,
    )
    .unwrap();
    state.handle_request("seed", "workspace.create", json!({ "label": "Screen" }));
    let (pane_id, terminal) = {
        let data = state.data.lock().unwrap();
        let (pane_id, pane) = data.panes.iter().next().unwrap();
        let terminal = data.terminals.get(&pane.terminal_id).unwrap().clone();
        (pane_id.clone(), terminal)
    };
    let draw = concat!(
        "\u{1b}[2J\u{1b}[H",
        " Tasks\r\n",
        " ⠙ Working…\r\n",
        "\u{1b}[2;1H", // next frame: repaint the status row in place
        "\u{1b}[K",
        " ✓ Done",
        "\u{1b}[1;3H", // rewrite part of the header row in place
        "clean",
        "\r\n",
    );
    terminal.append_output(draw.as_bytes());

    let screen = state.read_pane_screen(&pane_id).unwrap();
    assert!(
        screen.contains("clean"),
        "screen format lost the cursor-addressed write: {screen:?}"
    );
    assert!(
        screen.contains("✓ Done"),
        "screen format lost the rewrite: {screen:?}"
    );
    assert!(
        !screen.contains("asks"),
        "overwritten header fragment must not survive: {screen:?}"
    );
    assert!(
        !screen.contains("⠙"),
        "erased spinner frame must not survive: {screen:?}"
    );

    // Same bytes through the default strip format: the draw fragments
    // glue into the garbage rows the TUI previews used to show.
    let stripped = state.read_pane_recent(&pane_id).unwrap();
    assert!(
        stripped.contains("⠙"),
        "strip keeps erased fragments (the old garbage): {stripped:?}"
    );

    // Wire shape: format param routes to the screen read and reports
    // itself; unknown formats refuse instead of silently stripping.
    let response = state.handle_request(
        "read",
        "pane.read",
        json!({ "pane_id": pane_id, "format": "screen" }),
    );
    assert_eq!(response["result"]["read"]["format"], "screen");
    assert_eq!(response["result"]["read"]["text"].as_str().unwrap(), screen);
    let plain = state.handle_request("read", "pane.read", json!({ "pane_id": pane_id }));
    assert_eq!(plain["result"]["read"]["format"], "text");
    let bogus = state.handle_request(
        "read",
        "pane.read",
        json!({ "pane_id": pane_id, "format": "pixels" }),
    );
    assert!(
        bogus["error"]["message"]
            .as_str()
            .unwrap_or("")
            .starts_with("unknown pane.read format"),
        "unknown format must refuse: {bogus}"
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

    // git canonicalizes the temp path on macOS (/var/folders is a
    // symlink to /private/var/folders), so the porcelain rows and the
    // derived repo identity carry the canonical spelling while the
    // raw creation path carries the /var spelling. The identity rule
    // under test: run from inside the lane, repo root must be the
    // main repo (porcelain first row), not the lane itself.
    let lane_canonical = lane.canonicalize().unwrap();
    let repo_canonical = repo.canonicalize().unwrap();
    assert_eq!(
        result["source"]["repo_root"],
        json!(repo_canonical.to_string_lossy().to_string())
    );
    assert_eq!(
        result["source"]["repo_key"],
        json!(repo_canonical.to_string_lossy().to_string())
    );
    assert_eq!(result["source"]["repo_name"], "repo");
    assert_eq!(
        result["source"]["source_checkout_path"],
        json!(lane.to_string_lossy().to_string())
    );
    let paths: Vec<&str> = result["worktrees"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["path"].as_str().unwrap())
        .collect();
    assert!(
        paths.contains(&repo_canonical.to_string_lossy().to_string().as_str()),
        "main row present"
    );
    assert!(
        paths.contains(&lane_canonical.to_string_lossy().to_string().as_str()),
        "lane row present"
    );
    fs::remove_dir_all(&scratch).ok();
}

/// `worktree.list` must not report a broken git as an empty list.
/// A repo checkout whose `git worktree list` fails carries the git
/// error in the envelope (`git_error`), while a plain folder keeps
/// the silent empty-rows identity: same transport shape, different
/// honesty. Brokenness comes from a corrupted HEAD (rev-parse and
/// worktree list both fail, the `.git` dir still exists), so the
/// test needs no env override of the process-wide git resolution.
#[test]
fn builtin_worktree_list_reports_git_failure_not_empty_rows() {
    let scratch = std::env::temp_dir().join(format!(
        "herdr-wt-git-error-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let repo = scratch.join("repo");
    fs::create_dir_all(&repo).unwrap();
    run_git(&repo, &["init", "-q"]).unwrap();
    run_git(&repo, &["config", "user.email", "t@t"]).unwrap();
    run_git(&repo, &["config", "user.name", "T"]).unwrap();
    fs::write(repo.join("README.md"), "base\n").unwrap();
    run_git(&repo, &["add", "."]).unwrap();
    run_git(&repo, &["commit", "-q", "-m", "base"]).unwrap();
    // Corrupt HEAD after the commit: the checkout still looks like a
    // repo (`.git` exists) but every git read fails, the same shape the
    // xcrun shim failure produces inside a Rosetta service.
    fs::write(repo.join(".git/HEAD"), "garbage\n").unwrap();

    let state = BuiltinState::new(
        std::env::temp_dir(),
        Some(default_shell()),
        JcodeDetectionVariant::Vanilla,
    )
    .unwrap();
    let result = state
        .handle_request_inner("worktree.list", json!({ "cwd": repo.to_string_lossy() }))
        .unwrap();

    assert!(
        result["git_error"].as_str().is_some(),
        "corrupted repo must report git_error, got {result}"
    );
    assert_eq!(
        result["worktrees"].as_array().unwrap().len(),
        0,
        "failed discovery reports zero rows alongside the error"
    );

    // Plain folder: git also fails there, but a folder is not a repo,
    // so no git_error rides the envelope.
    let plain = scratch.join("plain");
    fs::create_dir_all(&plain).unwrap();
    let result = state
        .handle_request_inner("worktree.list", json!({ "cwd": plain.to_string_lossy() }))
        .unwrap();
    assert_eq!(
        result["git_error"],
        serde_json::Value::Null,
        "plain folder keeps the silent empty-rows identity"
    );

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
        journal_dir: None,
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
    let mut client = connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
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
        journal_dir: None,
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

    let mut client = connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
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
            let len = u32::from_le_bytes([pending[0], pending[1], pending[2], pending[3]]) as usize;
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
        journal_dir: None,
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
        journal_dir: None,
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

    let mut client = connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
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
        journal_dir: None,
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
    let mut client = connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
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
    let mut second = connect_local_stream(&PathBuf::from(format!("{base}-client.sock"))).unwrap();
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
        journal_dir: None,
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
        journal_dir: None,
    })
    .unwrap();
    {
        let mut seed = connect_local_stream(&api_socket).unwrap();
        seed.write_all(br#"{"id":"seed","method":"workspace.create","params":{"label":"seed"}}"#)
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
        journal_dir: None,
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
    let response = state.handle_request("seed", "workspace.create", json!({ "label": "Legacy" }));
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

/// Journaling state with a persistent dir wired, mirroring the
/// production `BuiltinBackendHandle::start` wiring (journal_path set
/// before any request runs).
fn journaling_state(dir: &Path) -> BuiltinState {
    let mut state = BuiltinState::new(
        dir.to_path_buf(),
        Some(hermetic_test_shell()),
        JcodeDetectionVariant::Vanilla,
    )
    .unwrap();
    state.journal_path = Some(dir.join(SESSION_JOURNAL_FILE));
    state
}

#[test]
fn journal_records_workspace_and_shell_tabs_and_replays_after_restart() {
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-journal-rt-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let checkout_a = dir.join("checkout-a");
    let checkout_b = dir.join("checkout-b");
    std::fs::create_dir_all(&checkout_a).unwrap();
    std::fs::create_dir_all(&checkout_b).unwrap();
    {
        let state = journaling_state(&dir);
        // Two workspaces: one with a shell tab, one without terminals.
        state.handle_request(
            "ws1",
            "workspace.create",
            json!({
                "label": "First",
                "cwd": checkout_a.to_string_lossy(),
                "open_terminal": true
            }),
        );
        state.handle_request(
            "ws2",
            "workspace.create",
            json!({
                "label": "Second",
                "cwd": checkout_b.to_string_lossy(),
                "open_terminal": false
            }),
        );
        assert!(state
            .journal_path
            .as_ref()
            .is_some_and(|path| path.exists()));
    }
    // Fresh backend over the same journal dir simulates the restart.
    let state = journaling_state(&dir);
    replay_session_journal(&state, &dir.join(SESSION_JOURNAL_FILE));
    let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
    let workspaces = snapshot["result"]["snapshot"]["workspaces"].clone();
    let labels: Vec<&str> = workspaces
        .as_array()
        .unwrap()
        .iter()
        .map(|workspace| workspace["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, vec!["First", "Second"]);
    let tabs = snapshot["result"]["snapshot"]["tabs"].clone();
    let tab_workspace_ids: Vec<&str> = tabs
        .as_array()
        .unwrap()
        .iter()
        .map(|tab| tab["workspace_id"].as_str().unwrap())
        .collect();
    // Only the workspace opened with a terminal gets a replayed tab.
    let first_id = workspaces[0]["workspace_id"].as_str().unwrap();
    assert_eq!(tab_workspace_ids, vec![first_id]);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn replay_skips_vanished_checkouts_and_restores_focus() {
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-journal-vanished-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let checkout_a = dir.join("checkout-a");
    let checkout_b = dir.join("checkout-b");
    std::fs::create_dir_all(&checkout_a).unwrap();
    std::fs::create_dir_all(&checkout_b).unwrap();
    {
        let state = journaling_state(&dir);
        let first = state.handle_request(
            "ws1",
            "workspace.create",
            json!({
                "label": "Gone",
                "cwd": checkout_a.to_string_lossy(),
                "open_terminal": false
            }),
        );
        let _first_id = first["result"]["workspace"]["workspace_id"].clone();
        state.handle_request(
            "ws2",
            "workspace.create",
            json!({
                "label": "Alive",
                "cwd": checkout_b.to_string_lossy(),
                "open_terminal": false,
                "focus": true
            }),
        );
    }
    std::fs::remove_dir_all(&checkout_a).unwrap();
    let state = journaling_state(&dir);
    replay_session_journal(&state, &dir.join(SESSION_JOURNAL_FILE));
    let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
    let workspaces = snapshot["result"]["snapshot"]["workspaces"].clone();
    let labels: Vec<&str> = workspaces
        .as_array()
        .unwrap()
        .iter()
        .map(|workspace| workspace["label"].as_str().unwrap())
        .collect();
    assert_eq!(labels, vec!["Alive"]);
    let focused = workspaces[0]["workspace_id"].as_str().unwrap();
    assert_eq!(
        snapshot["result"]["snapshot"]["focused_workspace_id"].as_str(),
        Some(focused)
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn replay_ignores_torn_journal_and_unknown_versions() {
    // A truncated or future-version journal is not a session: replay
    // must leave state empty rather than guess at an unknown schema.
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-journal-torn-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let journal = dir.join(SESSION_JOURNAL_FILE);

    std::fs::write(&journal, b"{\"version\":1,\"workspaces\":[").unwrap();
    let state = journaling_state(&dir);
    replay_session_journal(&state, &journal);
    let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
    assert_eq!(
        snapshot["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap()
            .len(),
        0
    );

    // The version check reads the parsed struct: a valid payload with
    // an unknown version must also leave state empty.
    std::fs::write(
        &journal,
        b"{\"version\":2,\"workspaces\":[],\"focused_workspace_cwd\":null}",
    )
    .unwrap();
    let state = journaling_state(&dir);
    replay_session_journal(&state, &journal);
    let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
    assert_eq!(
        snapshot["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn replay_ignores_missing_journal_file() {
    // No journal on disk (fresh install, or cleanup already ran) means
    // no work to do, not an error.
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-journal-missing-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let state = journaling_state(&dir);
    replay_session_journal(&state, &dir.join(SESSION_JOURNAL_FILE));
    let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
    assert_eq!(
        snapshot["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn replay_restores_focus_only_when_focused_cwd_survived() {
    // Focus follows the journaled cwd: dropped when that checkout is
    // gone, and untouched (fresh focus) when nothing was journaled.
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-journal-focus-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let checkout_a = dir.join("checkout-a");
    let checkout_b = dir.join("checkout-b");
    std::fs::create_dir_all(&checkout_a).unwrap();
    std::fs::create_dir_all(&checkout_b).unwrap();

    // Focused cwd points at a vanished checkout: restore_focus must
    // find no match in `restored` and leave the fresh focus alone.
    std::fs::write(
            dir.join(SESSION_JOURNAL_FILE),
            format!(
                "{{\"version\":1,\"workspaces\":[{{\"workspace_id\":\"ws_1\",\"label\":\"Alive\",\"cwd\":\"{}\",\"shell_tabs\":[]}}],\"focused_workspace_cwd\":\"{}\"}}",
                checkout_b.to_string_lossy(),
                dir.join("gone").to_string_lossy()
            ),
        )
        .unwrap();
    let state = journaling_state(&dir);
    replay_session_journal(&state, &dir.join(SESSION_JOURNAL_FILE));
    let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
    let workspaces = snapshot["result"]["snapshot"]["workspaces"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(workspaces.len(), 1);
    // The only restored workspace keeps replay's fresh focus because
    // the journaled focused cwd is not among the survivors.
    assert_eq!(
        snapshot["result"]["snapshot"]["focused_workspace_id"],
        workspaces[0]["workspace_id"]
    );

    // Journal without a focused cwd: replay restores workspaces and
    // leaves focus wherever phase 1's fresh focus landed.
    std::fs::write(
            dir.join(SESSION_JOURNAL_FILE),
            format!(
                "{{\"version\":1,\"workspaces\":[{{\"workspace_id\":\"ws_1\",\"label\":\"Alive\",\"cwd\":\"{}\",\"shell_tabs\":[]}}],\"focused_workspace_cwd\":null}}",
                checkout_a.to_string_lossy()
            ),
        )
        .unwrap();
    let state = journaling_state(&dir);
    replay_session_journal(&state, &dir.join(SESSION_JOURNAL_FILE));
    let snapshot = state.handle_request("snap", "session.snapshot", json!({}));
    let workspaces = snapshot["result"]["snapshot"]["workspaces"]
        .as_array()
        .unwrap()
        .clone();
    assert_eq!(workspaces.len(), 1);
    assert_eq!(
        snapshot["result"]["snapshot"]["focused_workspace_id"],
        workspaces[0]["workspace_id"]
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn workspace_close_persists_journal_and_publishes_event() {
    // workspace.close goes through the full request path: its structural
    // event marks the journal dirty and the post-response persist writes
    // the survivor list to disk.
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-journal-close-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let state = journaling_state(&dir);
    let created = state.handle_request(
        "w",
        "workspace.create",
        json!({
            "label": "Alpha", "open_terminal": false
        }),
    );
    let workspace_id = created["result"]["workspace"]["workspace_id"]
        .as_str()
        .unwrap()
        .to_string();

    let closed = state.handle_request(
        "c",
        "workspace.close",
        json!({ "workspace_id": workspace_id }),
    );
    assert_eq!(closed["result"]["type"], "ok");

    let journal = std::fs::read_to_string(dir.join(SESSION_JOURNAL_FILE)).unwrap();
    let journal: serde_json::Value = serde_json::from_str(&journal).unwrap();
    assert_eq!(
        journal["workspaces"].as_array().unwrap().len(),
        0,
        "closed workspace must leave the journal"
    );
    assert!(!state.journal_dirty.load(Ordering::Acquire));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn replay_skips_workspace_when_state_lock_is_poisoned() {
    // The create_workspace Err arm during replay is reachable only
    // when the data lock is poisoned (a panicking request thread raced
    // the start); the workspace is skipped and replay continues.
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-journal-poison-replay-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let checkout = dir.join("checkout");
    std::fs::create_dir_all(&checkout).unwrap();
    std::fs::write(
            dir.join(SESSION_JOURNAL_FILE),
            format!(
                "{{\"version\":1,\"workspaces\":[{{\"workspace_id\":\"ws_1\",\"label\":\"Alpha\",\"cwd\":\"{}\",\"shell_tabs\":[]}}],\"focused_workspace_cwd\":null}}",
                checkout.to_string_lossy()
            ),
        )
        .unwrap();
    let state = journaling_state(&dir);

    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = state.data.lock().unwrap();
        panic!("poison the lock");
    }));

    // Replay runs over the poisoned state: the workspace create must
    // fail, take its skip arm, and leave no restored workspaces.
    replay_session_journal(&state, &dir.join(SESSION_JOURNAL_FILE));
    let data = state
        .data
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert!(
        data.workspaces.is_empty(),
        "poisoned replay must skip the workspace, not restore it"
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn restore_focus_survives_a_poisoned_data_lock() {
    // The lock-poisoned arm is real on a panicking request thread: the
    // server must skip focus restore and still come up, not abort
    // replay with a lock error mid-start.
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-journal-poison-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let state = journaling_state(&dir);
    let created = state.handle_request(
        "w",
        "workspace.create",
        json!({
            "label": "Alpha", "open_terminal": false
        }),
    );
    let alpha_id = created["result"]["workspace"]["workspace_id"]
        .as_str()
        .unwrap()
        .to_string();

    // Poison the data lock the same way a panicking request thread
    // would: the guard unwinds while held.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = state.data.lock().unwrap();
        panic!("poison the lock");
    }));

    // With the lock poisoned, focus restore must take its Err arm and
    // change nothing: not the fresh Alpha focus, and certainly not the
    // nonexistent journaled id.
    restore_focus_from_journal(
        &state,
        Some(dir.to_string_lossy().to_string()).as_deref(),
        &[(dir.to_string_lossy().to_string(), "ws_9".to_string())],
    );
    let data = state
        .data
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    assert_eq!(
        data.focused_workspace_id.as_deref(),
        Some(alpha_id.as_str())
    );
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn journal_events_mark_dirty_and_strip_suffix() {
    // Structural events (`.mutated`) mark the journal dirty and strip
    // the suffix on the wire; status events do neither.
    let state = BuiltinState::new(
        std::env::current_dir().unwrap(),
        Some(default_shell()),
        JcodeDetectionVariant::Vanilla,
    )
    .unwrap();
    let rx = state.subscribe_events();

    state.publish_event("workspace.created.mutated", json!({ "type": "stub" }));

    assert!(state.journal_dirty.load(Ordering::Acquire));
    let event = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(event["event"], "workspace.created");

    state.journal_dirty.store(false, Ordering::Release);
    state.publish_event("pane.agent_status_changed", json!({ "type": "stub" }));
    assert!(!state.journal_dirty.load(Ordering::Acquire));
    let event = rx.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(event["event"], "pane.agent_status_changed");
}

#[test]
fn persist_consumes_dirty_flag_set_by_structural_mutation() {
    // A workspace.create through the full request path marks the flag
    // via its event and the journal lands on disk; a read leaves both
    // flag and file untouched.
    let dir = std::env::temp_dir().join(format!(
        "herdr-journal-dirty-consume-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let mut state = BuiltinState::new(
        dir.clone(),
        Some(default_shell()),
        JcodeDetectionVariant::Vanilla,
    )
    .unwrap();
    state.journal_path = Some(dir.join(SESSION_JOURNAL_FILE));

    state.handle_request("w", "workspace.create", json!({ "label": "Alpha" }));

    assert!(state.journal_path.as_ref().unwrap().is_file());
    assert!(!state.journal_dirty.load(Ordering::Acquire));
    let before = std::fs::read_to_string(state.journal_path.as_ref().unwrap()).unwrap();
    std::fs::remove_file(state.journal_path.as_ref().unwrap()).unwrap();

    state.handle_request("r", "workspace.list", json!({}));

    assert!(!state.journal_dirty.load(Ordering::Acquire));
    assert!(
        !state.journal_path.as_ref().unwrap().is_file(),
        "reads must not re-journal"
    );
    assert!(!before.is_empty());
}

#[test]
fn persist_survives_a_poisoned_data_lock() {
    // A panicking request thread poisons the data lock; the next best-effort
    // persist must take its Err arm and skip the write, not panic in turn.
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-journal-persist-poison-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let state = journaling_state(&dir);
    state.handle_request(
        "w",
        "workspace.create",
        json!({ "label": "Alpha", "open_terminal": false }),
    );
    assert!(state.journal_path.as_ref().unwrap().is_file());
    std::fs::remove_file(state.journal_path.as_ref().unwrap()).unwrap();

    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = state.data.lock().unwrap();
        panic!("poison the lock");
    }));

    state.persist_session_journal();
    assert!(
        !state.journal_path.as_ref().unwrap().is_file(),
        "a poisoned lock must skip the write, not fail"
    );
}
