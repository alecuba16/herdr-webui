//! Shared TUI test fixtures: app builders, snapshots, fake backend/web sockets, key and draw helpers.

use super::*;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::json;

/// Point the app's WebUI API at an endpoint nothing can ever answer:
/// port 1 refuses connections instantly, so every request surfaces the
/// deterministic "webui connection failed" error. Without this the
/// tests hit whatever real session runs on the default port (8787 on
/// this machine), and the same assertions flip between pass and fail
/// depending on whether that session is up.
pub(crate) fn point_web_api_at_dead_port(app: &mut TuiApp) {
    app.web_api = crate::tui::web_api::WebApiClient::new("127.0.0.1", 1);
}

// ---------------------------------------------------------------------------
// Coverage suite: renderers, shortcut dispatch arms, prompt/commit
// handlers, and panel state machines. These run against a dead loopback
// WebAPI (errors surface into `app.error`) and the TestBackend, so no
// network is needed.
// ---------------------------------------------------------------------------

pub(crate) fn fixture_snapshot_value() -> serde_json::Value {
    json!({
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
            "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"}],
            "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true,"agent_session":{"kind":"jcode","resolvable":true,"session_id":"sess_1"}}],
            "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}]
        }
    })
}

pub(crate) fn fixture_snapshot() -> TuiSnapshot {
    TuiSnapshot::from_backend_response(&fixture_snapshot_value())
}

/// Two tabs in the workspace so the tab strip renders one active and
/// one inactive tab (the single-tab fixture only ever shows the
/// active style).
pub(crate) fn fixture_snapshot_value_with_tabs() -> serde_json::Value {
    json!({
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":2,"active_tab_id":"tab_1"}],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"},
                {"tab_id":"tab_2","workspace_id":"ws_1","label":"Server","focused":false,"pane_count":1,"agent_status":"idle"}
            ],
            "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
            "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}]
        }
    })
}

pub(crate) fn app_with_snapshot() -> TuiApp {
    // NOTE: tests must NEVER wire `builtin_session(None)` into an app that
    // dispatches mutating shortcuts: that points at the real user backend
    // (the live herdr.sock in ~/.config/herdr-webui/builtin/default), so a
    // single Ctrl+B P / Ctrl+B X arm creates or closes REAL tabs in the
    // user's session. A nonexistent socket keeps every mutating arm on its
    // error path (and read-only refreshes too), which is what these tests
    // assert anyway. Tests that need a working backend use `fake_backend_socket`.
    let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    app
}

pub(crate) fn draw(app: &TuiApp, width: u16, height: u16) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, app)).unwrap();
    format!("{:?}", terminal.backend().buffer())
}

/// Renders and keeps the buffer so tests can assert on cell colors
/// (the Debug dump of `draw` is lossy for that).
pub(crate) fn draw_buffer(app: &TuiApp, width: u16, height: u16) -> ratatui::buffer::Buffer {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, app)).unwrap();
    terminal.backend().buffer().clone()
}

/// A rendered row plus its y coordinate, for depth-effect assertions.
/// `chars` is one entry per cell so multibyte glyphs (·, ▸) keep their
/// cell x positions.
pub(crate) struct RenderedRow {
    pub(crate) chars: Vec<char>,
    pub(crate) y: usize,
}

impl RenderedRow {
    /// Cell x of the first character of `needle`, or the row is not
    /// the one expected.
    pub(crate) fn cell_x_of(&self, needle: &str) -> Option<usize> {
        let needle: Vec<char> = needle.chars().collect();
        self.chars
            .windows(needle.len())
            .position(|w| w == needle.as_slice())
    }
}

pub(crate) fn rendered_row(buffer: &ratatui::buffer::Buffer, needle: &str) -> RenderedRow {
    for y in 0..buffer.area.height as usize {
        let chars: Vec<char> = (0..buffer.area.width as usize)
            .map(|x| {
                buffer[(x as u16, y as u16)]
                    .symbol()
                    .chars()
                    .next()
                    .unwrap_or(' ')
            })
            .collect();
        let as_line: String = chars.iter().collect();
        if as_line.contains(needle) {
            return RenderedRow { chars, y };
        }
    }
    panic!("row containing {needle:?} not rendered");
}

pub(crate) fn ctrl(ch: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(ch), KeyModifiers::CONTROL)
}

/// Pump the event loop until the in-flight refresh worker replies (or a
/// 5s deadline trips, mirroring the bin loop's poll cadence). Async
/// refresh means a single `refresh_if_due` only arms the worker; tests
/// that assert on the refreshed state must wait for the landing.
pub(crate) fn drain_refresh(app: &mut TuiApp) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while app.refresh_inflight.is_some() && Instant::now() < deadline {
        app.refresh_if_due();
        std::thread::sleep(Duration::from_millis(5));
    }
    // One more tick so the last poll result (already received) is applied
    // even if the drain loop exited on the deadline boundary.
    app.refresh_if_due();
}

/// Scripted fake backend socket for TuiApp tests: one thread accepting
/// connections in a loop, answering each JSON-line request by method.
/// Hermetic replacement for the built-in session socket.
pub(crate) fn fake_backend_socket() -> (std::path::PathBuf, std::sync::mpsc::Sender<()>) {
    fake_backend_socket_with(fixture_snapshot_value())
}

/// `fake_backend_socket` whose `pane.read` answers a `history_lines`
/// line history, for the lens deep-fetch growth paths.
pub(crate) fn fake_backend_socket_with_pane_history(
    history_lines: usize,
) -> (std::path::PathBuf, std::sync::mpsc::Sender<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use interprocess::TryClone as _;
    use std::io::{BufRead, BufReader, Write};

    let path = crate::backend_client::unique_test_path("herdr-tui-fake-hist");
    let _ = std::fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let handle = std::thread::spawn(move || loop {
        if rx.try_recv().is_ok() {
            break;
        }
        let Ok(mut stream) = listener.accept() else {
            break;
        };
        let mut line = String::new();
        {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
        }
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        let response = match request["method"].as_str().unwrap_or("") {
            "ping" => json!({"id": request["id"], "result": {"version": "test", "protocol": 1}}),
            "session.snapshot" => json!({"id": request["id"], "result": fixture_snapshot_value()}),
            "pane.read" => {
                let text = (0..history_lines)
                    .map(|i| format!("deep line {i}"))
                    .collect::<Vec<_>>()
                    .join("\n");
                json!({"id": request["id"], "result": {"read": {"text": text}}})
            }
            method => json!({"error": format!("unexpected method {method}")}),
        };
        stream
            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
            .unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    });
    std::mem::forget(handle);
    (path, tx)
}

/// `fake_backend_socket` with a custom `session.snapshot` reply, for
/// flows that assert on the post-refresh workspace list (reroute).
pub(crate) fn fake_backend_socket_with(
    snapshot: serde_json::Value,
) -> (std::path::PathBuf, std::sync::mpsc::Sender<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use interprocess::TryClone as _;
    use std::io::{BufRead, BufReader, Write};

    let path = crate::backend_client::unique_test_path("herdr-tui-fake");
    let _ = std::fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let handle = std::thread::spawn(move || loop {
        if rx.try_recv().is_ok() {
            break;
        }
        let Ok(mut stream) = listener.accept() else {
            break;
        };
        let mut line = String::new();
        {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
        }
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        let response = match request["method"].as_str().unwrap_or("") {
            "ping" => json!({"id": request["id"], "result": {"version": "test", "protocol": 1}}),
            "session.snapshot" => {
                json!({"id": request["id"], "result": snapshot})
            }
            "tab.create" | "tab.close" => {
                // A close on a tab the server no longer knows (raced by
                // pane.exited teardown) answers not-found; the TUI must
                // treat that as the desired outcome.
                if request["method"] == "tab.close"
                    && request["params"]["tab_id"].as_str() == Some("tab_gone")
                {
                    json!({"id": request["id"], "error": "tab tab_gone not found"})
                } else {
                    // Fresh-shell split reads the created tab's root pane
                    // off the reply, so the answer mirrors the backend
                    // shape.
                    json!({
                        "id": request["id"],
                        "result": {
                            "ok": true,
                            "tab": {"tab_id": "tab_new"},
                            "root_pane": {"pane_id": "pane_opened"}
                        }
                    })
                }
            }
            "workspace.create" => json!({
                "id": request["id"],
                "result": {"workspace": {"workspace_id": "ws_created"}}
            }),
            "worktree.open" => json!({
                "id": request["id"],
                "result": {
                    "workspace": {"workspace_id": "ws_opened"},
                    "tab": {"tab_id": "tab_opened"},
                    "root_pane": {"pane_id": "pane_opened"}
                }
            }),
            "worktree.create" => json!({
                "id": request["id"],
                "result": {"ok": true}
            }),
            // Result shaped like the server's promote route payload:
            // workspace cwd (the backend resolves the live cwd) plus
            // label, which the TUI records into recents.
            "tab.promote" => json!({
                "id": request["id"],
                "result": {
                    "workspace": {
                        "workspace_id": "ws_promoted",
                        "cwd": "/promoted/cwd",
                        "label": "promoted label"
                    }
                }
            }),
            "workspace.close" => {
                // Built-in backend drops the emptied workspace itself; a
                // second close reports not-found, which the TUI ignores.
                if request["params"]["workspace_id"].as_str() == Some("ws_gone") {
                    json!({"id": request["id"], "error": "workspace not found"})
                } else {
                    json!({"id": request["id"], "result": {"ok": true}})
                }
            }
            "pane.read" => json!({
                "id": request["id"],
                "result": {"read": {"text": "pane output"}}
            }),
            method => json!({"error": format!("unexpected method {method}")}),
        };
        stream
            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
            .unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    });
    std::mem::forget(handle);
    (path, tx)
}

/// Budgeted variant of `fake_backend_socket`: answers the first
/// `budget` requests normally, then accepts connections but closes them
/// without a response so later calls fail. Used to exercise the
/// refresh-error arms after a successful tab create/close.
pub(crate) fn fake_backend_socket_failing_snapshots(
) -> (std::path::PathBuf, std::sync::mpsc::Sender<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use std::io::{BufRead, BufReader, Write};

    let path = crate::backend_client::unique_test_path("herdr-tui-fake-nosnap");
    let _ = std::fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        loop {
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
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let method = request["method"].as_str().unwrap_or("");
            if method == "session.snapshot" {
                // Fail the snapshot: close without a response so any
                // refresh errors while tab create/close still succeed.
                continue;
            }
            let response = match method {
                "ping" => {
                    json!({"id": request["id"], "result": {"version": "test", "protocol": 1}})
                }
                "tab.close" => {
                    // The raced-teardown shape: a close on a tab the
                    // server already dropped answers not-found so the
                    // client runs its recovery arm.
                    if request["params"]["tab_id"].as_str() == Some("tab_gone") {
                        json!({"id": request["id"], "error": "tab tab_gone not found"})
                    } else {
                        json!({"id": request["id"], "result": {"ok": true}})
                    }
                }
                "workspace.close" => {
                    // ws_real_err wants a real failure (not the ignored
                    // not-found) so the error surfaces.
                    if request["params"]["workspace_id"].as_str() == Some("ws_real_err") {
                        json!({"id": request["id"], "error": "workspace backend exploded"})
                    } else {
                        json!({"id": request["id"], "result": {"ok": true}})
                    }
                }
                "tab.create" => json!({"id": request["id"], "result": {"ok": true}}),
                method => json!({"error": format!("unexpected method {method}")}),
            };
            stream
                .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        }
    });
    (path, tx)
}

/// Fake HTTP server for the recent-workspaces endpoints: keeps an
/// in-memory list so remove/clear mutate it like the real handler, and
/// records the open POST body (path + label) for assertions. Requests
/// for any other path get an empty 200 so unrelated best-effort
/// calls (file/content search) stay harmless.
pub(crate) fn fake_recents_server(
    initial: Vec<serde_json::Value>,
) -> (u16, std::sync::mpsc::Receiver<serde_json::Value>) {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::sync::{Arc, Mutex};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let recents = Arc::new(Mutex::new(initial));
    let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
    let handle = std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let request = {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                let target = request_line
                    .split(' ')
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                let mut content_length = 0usize;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    let trimmed = header.trim();
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some(value) =
                        trimmed.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let body: serde_json::Value = if body.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null)
                };
                (target, body)
            };
            let (target, body) = request;
            let response = if target == "/api/recent-workspaces" {
                // POST re-records the opened path (top of the list);
                // GET returns the current list.
                if body
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .is_some()
                {
                    let _ = tx.send(body.clone());
                    let mut list = recents.lock().unwrap();
                    let path = body["path"].as_str().unwrap().to_string();
                    let label = body["label"].as_str().map(str::to_string);
                    let entry = match label {
                        Some(label) => serde_json::json!({ "path": path, "label": label }),
                        None => serde_json::json!({ "path": path }),
                    };
                    list.retain(|item| item["path"].as_str() != Some(path.as_str()));
                    list.insert(0, entry);
                    // worktree.open-shaped result, exactly like the
                    // real proxy returns it (and the desktop api() body):
                    // everything nested under "result".
                    serde_json::json!({
                        "ok": true,
                        "result": {
                            "workspace": { "workspace_id": "ws_reopened" },
                            "tab": { "tab_id": "tab_reopened" },
                            "root_pane": { "pane_id": "pane_reopened" }
                        }
                    })
                } else {
                    serde_json::json!({ "recent": *recents.lock().unwrap() })
                }
            } else if target == "/api/recent-workspaces/remove" {
                let path = body["path"].as_str().unwrap_or_default().to_string();
                recents
                    .lock()
                    .unwrap()
                    .retain(|item| item["path"].as_str() != Some(path.as_str()));
                serde_json::json!({ "ok": true })
            } else if target == "/api/recent-workspaces/record" {
                // Record-only endpoint: insert at the top like the
                // server's push_recent_workspace (dedup by path).
                let _ = tx.send(body.clone());
                let path = body["path"].as_str().unwrap_or_default().to_string();
                let label = body["label"].as_str().map(str::to_string);
                let kind = body["kind"].as_str().map(str::to_string);
                let entry = match (label, kind) {
                    (Some(label), _) => json!({ "path": path, "label": label }),
                    (None, Some(kind)) => json!({ "path": path, "kind": kind }),
                    (None, None) => json!({ "path": path }),
                };
                let mut list = recents.lock().unwrap();
                list.retain(|item| item["path"].as_str() != Some(path.as_str()));
                list.insert(0, entry);
                serde_json::json!({ "ok": true })
            } else if target == "/api/recent-workspaces/clear" {
                recents.lock().unwrap().clear();
                serde_json::json!({ "ok": true })
            } else {
                serde_json::json!({ "ok": true })
            };
            let body_text = response.to_string();
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body_text.len(),
                    body_text
                )
                .as_bytes(),
            );
        }
    });
    std::mem::forget(handle);
    (port, rx)
}

/// HTTP fake serving only the rename/delete/read endpoints: every tree
/// refresh fails so success arms with a failing refresh are reachable.
pub(crate) fn fake_web_api_server(
    rename_ok: bool,
    delete_ok: bool,
    read_ok: bool,
) -> (u16, std::sync::mpsc::Sender<()>) {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if rx.try_recv().is_ok() {
                break;
            }
            let Ok(stream) = stream else { break };
            let mut stream = stream;
            let mut line = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
            }
            let target = line.split(' ').nth(1).unwrap_or_default().to_string();
            let mutation_ok = (target.starts_with("/api/file-browser/rename") && rename_ok)
                || (target.starts_with("/api/file-browser/delete") && delete_ok);
            let body = if mutation_ok {
                json!({"ok": true})
            } else if target.starts_with("/api/file-browser/file") && read_ok {
                json!({
                    "content": "fn main() {}\n",
                    "binary": false,
                    "truncated": false,
                    "hash": "hash-v1",
                })
            } else {
                // Drop without a response: the call fails with an I/O error.
                continue;
            };
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.to_string().len(),
                    body
                )
                .as_bytes(),
            );
        }
    });
    (port, tx)
}

/// Close/finish tour keys persist the tour outcome to the shared
/// settings file (`record_tour_state`), so every tour test that can
/// press one needs the env lock plus its own XDG dir, exactly like the
/// settings tests: without it a parallel sibling writes its
/// `tuiOnboardingTour` into this test's settings file, or worse into
/// the user's real one. Drop restores the env and drops the temp dir,
/// including on a panicking unwind.
pub(crate) struct SettingsEnvGuard {
    _lock: std::sync::MutexGuard<'static, ()>,
    prior_xdg: Option<String>,
    dir: std::path::PathBuf,
}

impl Drop for SettingsEnvGuard {
    fn drop(&mut self) {
        match self.prior_xdg.take() {
            Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

pub(crate) fn settings_test_env() -> SettingsEnvGuard {
    let _lock = crate::test_env_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("herdr-tui-settings-env-{stamp}"));
    std::fs::create_dir_all(&dir).unwrap();
    let prior_xdg = std::env::var("XDG_CONFIG_HOME").ok();
    std::env::set_var("XDG_CONFIG_HOME", &dir);
    SettingsEnvGuard {
        _lock,
        prior_xdg,
        dir,
    }
}

/// HTTP fake serving the palette search endpoints: the tree (file)
/// search succeeds with one hit, the content search drops the
/// connection (simulates a partial backend failure).
pub(crate) fn fake_palette_server(
    file_ok: bool,
    content_ok: bool,
) -> (u16, std::sync::mpsc::Sender<()>) {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if rx.try_recv().is_ok() {
                break;
            }
            let Ok(mut stream) = stream else { break };
            let mut line = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
            }
            let target = line.split(' ').nth(1).unwrap_or_default().to_string();
            let body = if target.contains("/api/file-browser/tree") && file_ok {
                json!({"entries": [
                    {"name": "alpha.rs", "kind": "file", "path": "src/alpha.rs"}
                ]})
            } else if target.contains("/api/file-browser/content-search") && content_ok {
                json!({"files": [
                    {"path": "src/beta.rs", "name": "beta.rs",
                     "matches": [{"line": 7, "text": "let x = 1;"}]}
                ]})
            } else {
                // Drop without a response: the call fails with an I/O error.
                continue;
            };
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.to_string().len(),
                    body
                )
                .as_bytes(),
            );
        }
    });
    (port, tx)
}

/// Fake WebUI server answering `POST /api/panes/{id}/submit`:
/// `Some("ok")` returns the success body, `Some("blocked")` the
/// agent_blocked refusal shape the real route emits (HTTP 409 with
/// `{error, code, note}`), `None` drops the connection.
pub(crate) fn fake_composer_server(mode: Option<&str>) -> (u16, std::sync::mpsc::Sender<()>) {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mode = mode.map(str::to_string);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if rx.try_recv().is_ok() {
                break;
            }
            let Ok(stream) = stream else { break };
            let mut stream = stream;
            let mut request_line = String::new();
            let mut content_length = 0usize;
            {
                let mut reader = BufReader::new(&mut stream);
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    let lower = header.trim().to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                    if header.trim().is_empty() {
                        break;
                    }
                }
                // Drain the body so the request completes.
                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    use std::io::Read;
                    let _ = reader.read_exact(&mut body);
                }
            }
            if !request_line.contains("/api/panes/") || !request_line.contains("/submit") {
                continue;
            }
            let Some(mode) = mode.as_deref() else {
                continue;
            };
            let (status, body) = match mode {
                "ok" => ("200 OK", json!({ "type": "agent_prompt", "ok": true })),
                "blocked" => (
                    "409 Conflict",
                    json!({
                        "error": "agent_blocked: the agent is waiting for an answer in the terminal",
                        "code": "agent_blocked",
                        "note": "Not sent: the agent is waiting for an answer in the terminal. Answer it first."
                    }),
                ),
                _ => continue,
            };
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.to_string().len(),
                    body
                )
                .as_bytes(),
            );
        }
    });
    (port, tx)
}

/// A hermetic terminal-protocol server: speaks the same length-prefixed
/// bincode protocol 22 handshake as the real backend terminal socket
/// (`TerminalHello` → `Welcome` → Input/Detach/AttachTerminal frames),
/// and records every input frame's bytes, so key-to-bytes routing can be
/// asserted against a LIVE terminal connection instead of a dead socket.
pub(crate) fn hermetic_terminal_socket() -> (std::path::PathBuf, std::sync::mpsc::Receiver<Vec<u8>>)
{
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = crate::backend_client::unique_test_path("herdr-tui-fake-term");
    let _ = std::fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || loop {
        let Ok(mut stream) = listener.accept() else {
            break;
        };
        // Handshake: TerminalHello in, Welcome out (protocol 22).
        let hello = crate::protocol::read_message::<_, crate::protocol::ClientMessage>(
            &mut stream,
            crate::backend_client::MAX_TUI_TERMINAL_FRAME_SIZE,
        );
        if hello.is_err() {
            continue;
        }
        let welcome = crate::protocol::ServerMessage::Welcome {
            version: 22,
            encoding: crate::protocol::RenderEncoding::TerminalAnsi,
            error: None,
        };
        if crate::protocol::write_message(&mut stream, &welcome).is_err() {
            continue;
        }
        // Serve frames until the client detaches or the socket dies.
        // Input frames are recorded; Detach ends the connection.
        loop {
            let frame = crate::protocol::read_message::<_, crate::protocol::ClientMessage>(
                &mut stream,
                crate::backend_client::MAX_TUI_TERMINAL_FRAME_SIZE,
            );
            let Ok(frame) = frame else { break };
            match frame {
                crate::protocol::ClientMessage::Input { data } => {
                    let _ = tx.send(data);
                }
                crate::protocol::ClientMessage::AttachTerminal { .. } => {
                    // Attach-mode history read: one full-frame render so
                    // `read_output` returns instead of blocking forever.
                    // A send-then-detach caller never reads this frame and
                    // drops the socket right after its Detach: the write
                    // can hit EPIPE from that RST. Pushing the frame is
                    // best-effort; the buffered Input frames behind it
                    // must still be read, so a write error never breaks
                    // the serve loop.
                    let output =
                        crate::protocol::ServerMessage::Terminal(crate::protocol::TerminalFrame {
                            seq: 1,
                            width: 120,
                            height: 32,
                            full: true,
                            bytes: b"fake history".to_vec(),
                        });
                    let _ = crate::protocol::write_message(&mut stream, &output);
                }
                crate::protocol::ClientMessage::Detach => break,
                _ => {}
            }
        }
    });
    (path, rx)
}

/// App whose terminal socket is the hermetic fake: attach_terminal
/// succeeds, send_input lands in the recorded channel, detach closes.
pub(crate) fn app_with_fake_terminal() -> (TuiApp, std::sync::mpsc::Receiver<Vec<u8>>) {
    let (path, rx) = hermetic_terminal_socket();
    let client = BackendClient::new("/nonexistent.sock", &path);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    point_web_api_at_dead_port(&mut app);
    (app, rx)
}

// ---------------------------------------------------------------------------
// T1: worktree identity stamp (sidebar badge parity with the webui).
// ---------------------------------------------------------------------------

/// Fake backend answering `worktree.list` with the builtin envelope
/// shape (source + rows). Hermetic like `fake_backend_socket`, but
/// the rows are pinned per test instead of shared fixture data.
pub(crate) fn stamp_fake_socket(
    worktrees: Value,
) -> (std::path::PathBuf, std::sync::mpsc::Sender<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use interprocess::TryClone as _;
    use std::io::{BufRead, BufReader, Write};

    let path = crate::backend_client::unique_test_path("herdr-tui-stamp-fake");
    let _ = std::fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let handle = std::thread::spawn(move || loop {
        if rx.try_recv().is_ok() {
            break;
        }
        let Ok(mut stream) = listener.accept() else {
            break;
        };
        let mut line = String::new();
        {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
        }
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        let response = match request["method"].as_str().unwrap_or("") {
            "ping" => json!({"id": request["id"], "result": {"version": "test", "protocol": 1}}),
            "session.snapshot" => json!({
                "id": request["id"],
                "result": fixture_snapshot_value()
            }),
            "worktree.list" => json!({
                "id": request["id"],
                "result": {
                    "source": {
                        "repo_root": "/repo",
                        "repo_name": "repo",
                        "repo_key": "/repo"
                    },
                    "worktrees": worktrees
                }
            }),
            method => json!({"id": request["id"], "error": format!("unexpected method {method}")}),
        };
        stream
            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
            .unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    });
    std::mem::forget(handle);
    (path, tx)
}

pub(crate) fn response_no_rows() -> serde_json::Value {
    json!({"worktrees": []})
}

/// Pump refresh ticks until the workspace stamp lands. A fresh app
/// has no armed worker, so unlike `drain_refresh` this starts the
/// round-trip itself and keeps ticking until the stamp commits.
pub(crate) fn pump_until_stamped(app: &mut TuiApp) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        app.refresh_if_due();
        if app
            .snapshot
            .workspaces
            .first()
            .is_some_and(|ws| ws.worktree.is_some())
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("stamp never landed within 5s");
}

/// Pump refresh ticks until the snapshot refresh and the stamp fetch
/// both settle (worker armed, landed, nothing left in flight). Used
/// when no stamp is expected: the reply must still land (into the
/// cache) without wedging the loop.
pub(crate) fn pump_until_quiet(app: &mut TuiApp) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        app.refresh_if_due();
        if app.last_refresh.is_some()
            && app.refresh_inflight.is_none()
            && app.stamp_inflight.is_empty()
        {
            return;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("refresh never settled within 5s");
}

// ---------------------------------------------------------------------------
// Branch picker overlay (desktop branch popover parity, prefix `v`).
// ---------------------------------------------------------------------------

/// Fake HTTP server speaking the git-ui endpoints the branch picker
/// needs: `git.branches` (with worktree_path stamps) and `git.switch`.
pub(crate) fn fake_git_api_server(
    branches: serde_json::Value,
) -> (u16, std::sync::mpsc::Sender<()>) {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if rx.try_recv().is_ok() {
                break;
            }
            let Ok(mut stream) = stream else { break };
            // Same single-line read convention as `fake_web_api_server`:
            // the request line carries the target, and the client never
            // re-reads the connection after the response arrives.
            let mut line = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
            }
            let target = line.split(' ').nth(1).unwrap_or_default().to_string();
            let response = if target.starts_with("/api/git-ui/branches") {
                branches.clone()
            } else if target.starts_with("/api/git-ui/switch") {
                json!({"ok": true})
            } else {
                json!({"error": "unexpected endpoint"})
            };
            let payload = serde_json::to_string(&response).unwrap();
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    payload.len(),
                    payload
                )
                .as_bytes(),
            );
        }
    });
    (port, tx)
}

// --- Split panels (design: docs/ux/tui-split-panels-design.md) ---

/// Two panes across two workspaces: the cross-workspace case the split
/// feature exists for.
pub(crate) fn fixture_snapshot_value_two_panes() -> serde_json::Value {
    json!({
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"},
                {"workspace_id":"ws_2","label":"Other","cwd":"/other","focused":false,"agent_status":"working","pane_count":1,"tab_count":1,"active_tab_id":"tab_2"}
            ],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"},
                {"tab_id":"tab_2","workspace_id":"ws_2","label":"Server","focused":false,"pane_count":1,"agent_status":"working"}
            ],
            "panes": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_2","tab_id":"tab_2","agent":"bot","display_agent":"bot","agent_status":"working","cwd":"/other","focused":false}
            ],
            "agents": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_2","tab_id":"tab_2","agent":"bot","display_agent":"bot","agent_status":"working","cwd":"/other","focused":false}
            ]
        }
    })
}

pub(crate) fn app_with_two_panes() -> TuiApp {
    let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = TuiSnapshot::from_backend_response(&fixture_snapshot_value_two_panes());
    // Production seeds the tree when the first snapshot lands
    // (apply_refresh -> sync_split_tree); tests that set the snapshot
    // directly must walk the same path.
    app.sync_split_tree();
    app
}

/// Third pane helper for auto-split tests: a pane on ws_2 not yet on
/// the tree, pushed straight into the snapshot like a backend refresh
/// that carries the just-opened workspace's pane.
pub(crate) fn push_pane_3(app: &mut TuiApp) {
    app.snapshot.panes.push(crate::tui::model::TuiPane {
        id: "pane_3".to_string(),
        terminal_id: "term_3".to_string(),
        workspace_id: "ws_2".to_string(),
        tab_id: "tab_2".to_string(),
        label: None,
        agent: None,
        display_agent: None,
        agent_status: "idle".to_string(),
        cwd: "/other".to_string(),
        focused: false,
        terminal_title: None,
        agent_session: None,
    });
}

// ---------------------------------------------------------------------------
// Session manager overlay (webui session manager parity). The WebUI API
// rides a raw TCP fake server (the web_api.rs pattern): sessions list,
// launch/close/cleanup actions, and the retarget flows.
// ---------------------------------------------------------------------------

/// Fake WebUI HTTP server for the session manager surface. `handler`
/// receives `(method, path)` and returns the JSON response value; the
/// server thread answers every request until the sender is dropped.
/// The returned client rides a session cookie so no auth replay runs
/// (the sessions routes are covered auth-free in web_api tests).
pub(crate) fn fake_webui_api<F>(
    handler: F,
) -> (
    crate::tui::web_api::WebApiClient,
    std::sync::mpsc::Sender<()>,
)
where
    F: Fn(String, String) -> serde_json::Value + Send + 'static,
{
    use std::io::{BufRead as _, BufReader, Read as _, Write as _};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || loop {
        if rx.try_recv().is_ok() {
            break;
        }
        let Ok((mut stream, _)) = listener.accept() else {
            break;
        };
        let mut line = String::new();
        let mut content_length = 0usize;
        {
            let mut reader = BufReader::new(&stream);
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap_or(0) == 0 {
                    break;
                }
                let trimmed = header.trim();
                if trimmed.is_empty() {
                    break;
                }
                if let Some(value) = trimmed.to_ascii_lowercase().strip_prefix("content-length:") {
                    content_length = value.trim().parse().unwrap_or(0);
                }
            }
            let mut body = vec![0u8; content_length];
            if content_length > 0 {
                let _ = reader.read_exact(&mut body);
            }
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let path = parts.next().unwrap_or("").to_string();
        let payload = handler(method, path).to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            payload.len(),
            payload
        );
        let _ = stream.write_all(response.as_bytes());
        let _ = stream.flush();
    });
    let client = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
    // Preload a cookie so the 401 replay path never runs in these
    // tests. `session_cookie` is private to web_api but its RefCell is
    // reachable through replay_session's probe on a live server; the
    // simpler contract here: these tests only use 200-answering servers
    // so no cookie is needed at all.
    (client, tx)
}

pub(crate) fn session_manager_app<F>(handler: F) -> (TuiApp, std::sync::mpsc::Sender<()>)
where
    F: Fn(String, String) -> serde_json::Value + Send + 'static,
{
    let (web_api, stop) = fake_webui_api(handler);
    let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.web_api = web_api;
    // Pin the status line: retarget failures land in `app.error`, and a
    // successful refresh would otherwise overwrite the status with the
    // backend summary line.
    app.status_hold_until = Some(std::time::Instant::now() + Duration::from_secs(3600));
    app.open_session_manager();
    (app, stop)
}

pub(crate) fn sessions_list_response() -> serde_json::Value {
    json!({"sessions": [
        {"name": "default", "backend": "builtin", "running": true, "api_socket": "/tmp/sess-default/api.sock"},
        {"name": "extra", "backend": "builtin", "running": false, "api_socket": "/tmp/sess-extra/api.sock"},
        {"name": "ext", "backend": "external-herdr", "running": true, "api_socket": "/tmp/sess-ext/api.sock"},
        {"name": "work", "backend": "builtin", "running": true, "api_socket": "/tmp/sess-work/api.sock"}
    ]})
}

pub(crate) fn session_rows_handler(_method: String, path: String) -> serde_json::Value {
    if path.starts_with("/api/sessions") {
        sessions_list_response()
    } else if path.starts_with("/api/session/launch") || path.starts_with("/api/session/close") {
        json!({"ok": true})
    } else if path.starts_with("/api/session/cleanup") {
        json!({"removed_count": 2})
    } else {
        json!({})
    }
}

// ---------------------------------------------------------------------------
// Render coverage round: split tile drawing arms, branch picker edges,
// cleanup prompt summary, session manager empty list, prompt wrapping.
// ---------------------------------------------------------------------------

pub(crate) fn two_tile_split() -> TuiApp {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_1".to_string());
    app.screen = TuiScreen::Terminal;
    app
}

pub(crate) fn three_pane_fixture() -> serde_json::Value {
    json!({
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":2,"tab_count":1,"active_tab_id":"tab_1"},
                {"workspace_id":"ws_2","label":"Other","cwd":"/other","focused":false,"agent_status":"working","pane_count":1,"tab_count":1,"active_tab_id":"tab_2"}
            ],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":2,"agent_status":"idle"},
                {"tab_id":"tab_2","workspace_id":"ws_2","label":"Server","focused":false,"pane_count":1,"agent_status":"working"}
            ],
            "panes": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_2","tab_id":"tab_2","agent":"bot","display_agent":"bot","agent_status":"working","cwd":"/other","focused":false},
                {"pane_id":"pane_3","terminal_id":"term_3","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":false}
            ],
            "agents": []
        }
    })
}

// ---------------------------------------------------------------------------
// Coverage-closing tests for split_mode.rs (nearest-leaf focus, zoom
// auto-lift, fresh-shell commit) and mod.rs error arms (git guards,
// workspace-selection cursor parking, close-tab stale paths).
// ---------------------------------------------------------------------------

/// Tile geometry rows the render normally records; tests hand them in
/// when the assertion is about the scoring, not the layout pass.
pub(crate) fn push_tile_geometry(app: &mut TuiApp, rows: &[(&str, u16, u16, u16, u16)]) {
    *app.tile_geometry.borrow_mut() = rows
        .iter()
        .map(
            |(pane_id, x, y, width, height)| crate::tui::render::TileRectOwned {
                pane_id: pane_id.to_string(),
                x: *x,
                y: *y,
                width: *width,
                height: *height,
            },
        )
        .collect();
}

// ---------------------------------------------------------------------------
// Target-highlight round: resize/split rings, resize divider preview,
// swap landing ghost, focused-tile marker, single-pane accent, tab bar
// style swap, AGENTS chip marker.
// ---------------------------------------------------------------------------

pub(crate) fn shift_z() -> KeyEvent {
    KeyEvent::new(KeyCode::Char('Z'), KeyModifiers::SHIFT)
}

/// Two-tile split with resize mode open via the real chord.
pub(crate) fn resize_mode_app() -> TuiApp {
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(shift_z());
    assert!(app.resize_mode.is_some(), "resize mode open");
    app
}

impl RenderedRow {
    /// Row chars as a String for substring checks.
    pub(crate) fn as_line_string(&self) -> String {
        self.chars.iter().collect()
    }
}
