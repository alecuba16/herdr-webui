//! LSP API tests.

use super::common::*;
use super::*;
use crate::tests::{env_lock, lock_env};

// ── LSP API tests ──

async fn lsp_post(
    app: &axum::Router,
    uri: &str,
    payload: serde_json::Value,
) -> (StatusCode, Value) {
    let response = app
        .clone()
        .oneshot(
            authed_request(Method::POST, uri)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(payload.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status();
    (status, response_json(response).await)
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn lsp_config_api_reports_and_updates_settings() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-lsp-config");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    let app = test_app_with_state(state);

    let initial = app
        .clone()
        .oneshot(
            authed_request(Method::GET, "/api/lsp/config")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(initial.status(), StatusCode::OK);
    let initial_body = response_json(initial).await;
    assert_eq!(initial_body["settings"]["enabled"], false);
    assert!(initial_body["languages"]
        .as_array()
        .is_some_and(|langs| langs.iter().any(|l| l == "json")));

    let (status, updated) = lsp_post(
        &app,
        "/api/lsp/config",
        json!({
            "settings": {
                "enabled": true,
                "servers": {
                    "json": {
                        "enabled": true,
                        "command": "vscode-json-language-server",
                        "args": ["--stdio"]
                    }
                }
            }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(updated["settings"]["enabled"], true);
    assert_eq!(
        updated["settings"]["servers"]["json"]["command"],
        "vscode-json-language-server"
    );

    // Rejected: unknown language.
    let (status, rejected) = lsp_post(
        &app,
        "/api/lsp/config",
        json!({
            "settings": {
                "enabled": true,
                "servers": {
                    "cobol": { "enabled": true, "command": "cobol-ls", "args": [] }
                }
            }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(rejected["error"].as_str().is_some());
}

#[tokio::test]
async fn lsp_start_rejects_unconfigured_language() {
    let state = test_state();
    let app = test_app_with_state(state);
    let (status, body) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "json", "cwd": std::env::temp_dir().to_string_lossy() }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "language servers are disabled");
}

#[tokio::test]
async fn lsp_request_rejects_disallowed_method() {
    let state = test_state();
    let app = test_app_with_state(state);
    let (status, _) = lsp_post(
        &app,
        "/api/lsp/request",
        json!({
            "language": "json",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "method": "workspace/executeCommand",
            "params": {}
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn lsp_status_reports_running_servers() {
    let state = test_state();
    let app = test_app_with_state(state);
    let response = app
        .clone()
        .oneshot(
            authed_request(Method::GET, "/api/lsp/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["servers"].as_array().is_some());
}

#[tokio::test]
async fn lsp_apis_require_auth() {
    let state = test_state();
    let app = test_app_with_state(state);
    for (uri, method) in [
        ("/api/lsp/config", Method::GET),
        ("/api/lsp/detect", Method::GET),
        ("/api/lsp/status", Method::GET),
        ("/api/lsp/notifications", Method::GET),
    ] {
        let response = app
            .clone()
            .oneshot(request(method, uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{uri}");
    }
    for uri in [
        ("/api/lsp/config", json!({ "settings": {} })),
        (
            "/api/lsp/start",
            json!({ "language": "json", "cwd": "/tmp" }),
        ),
        (
            "/api/lsp/request",
            json!({ "language": "json", "cwd": "/tmp", "method": "initialize" }),
        ),
        (
            "/api/lsp/notify",
            json!({ "language": "json", "cwd": "/tmp", "method": "initialized" }),
        ),
        ("/api/lsp/stop", json!({})),
    ] {
        let response = app
            .clone()
            .oneshot(
                request(Method::POST, uri.0)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(uri.1.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{}", uri.0);
    }
}

/// Absolute path to the node binary, or None when node is absent (the
/// full-flow LSP API tests skip, matching the lsp module's own e2e test).
fn node_binary_path() -> Option<String> {
    std::process::Command::new("which")
        .arg("node")
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn lsp_api_full_flow_start_request_notify_stop() {
    let Some(node) = node_binary_path() else {
        eprintln!("skipping: node not found");
        return;
    };
    let _env = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-lsp-api-flow");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let (script_dir, _script_guard) = temp_guard("herdr-lsp-api-script");
    let workspace = script_dir.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let script_path = script_dir.join("fake-server.js");
    std::fs::write(
        &script_path,
        r#"
function send(msg) {
  const s = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(s) + '\r\n\r\n' + s);
}
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\r\n\r\n')) >= 0) {
    const m = buf.slice(0, idx).match(/Content-Length: (\d+)/);
    if (!m) { buf = ''; return; }
    const len = parseInt(m[1], 10);
    if (buf.length < idx + 4 + len) return;
    const body = buf.slice(idx + 4, idx + 4 + len);
    buf = buf.slice(idx + 4 + len);
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true } } });
    } else if (msg.method === 'textDocument/hover') {
      send({ jsonrpc: '2.0', id: msg.id, result: { contents: 'api flow hover' } });
    } else if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    } else if (msg.method === 'exit') {
      process.exit(0);
    }
  }
});
"#,
    )
    .unwrap();
    let script_abs = script_path
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let workspace_abs = workspace
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let mut state = test_state();
    state.lsp = Arc::new(lsp::LspRegistry::new(lsp::LspSettings {
        enabled: true,
        servers: [(
            "json".to_string(),
            lsp::LanguageServerConfig {
                enabled: true,
                command: Some(node.clone()),
                args: vec![script_abs],
            },
        )]
        .into(),
    }));
    let app = test_app_with_state(state);

    // start
    let (status, started) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "json", "cwd": workspace_abs }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "start: {started}");
    assert_eq!(started["ok"], true);
    assert_eq!(started["already_running"], false);
    assert!(started["key"].as_str().is_some());

    // start again: same key reports already_running
    let (status, again) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "json", "cwd": workspace_abs }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(again["already_running"], true);
    assert_eq!(again["key"], started["key"]);

    // request: initialize then hover
    let (status, init) = lsp_post(
        &app,
        "/api/lsp/request",
        json!({
            "language": "json",
            "cwd": workspace_abs,
            "method": "initialize",
            "params": { "processId": null, "rootUri": null, "capabilities": {} }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "initialize: {init}");
    assert_eq!(init["ok"], true);
    assert!(init["result"]["capabilities"]["hoverProvider"]
        .as_bool()
        .unwrap_or(false));

    let (status, hover) = lsp_post(
        &app,
        "/api/lsp/request",
        json!({
            "language": "json",
            "cwd": workspace_abs,
            "method": "textDocument/hover",
            "params": { "textDocument": { "uri": "file:///x.json" }, "position": { "line": 0, "character": 0 } }
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "hover: {hover}");
    assert_eq!(hover["result"]["contents"], "api flow hover");

    // notify: initialized marks the server running
    let (status, notified) = lsp_post(
        &app,
        "/api/lsp/notify",
        json!({ "language": "json", "cwd": workspace_abs, "method": "initialized", "params": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "notify: {notified}");
    assert_eq!(notified["ok"], true);

    // status: the json server is listed with state ready
    let response = app
        .clone()
        .oneshot(
            authed_request(Method::GET, "/api/lsp/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let status_body = response_json(response).await;
    let servers = status_body["servers"].as_array().expect("servers array");
    assert!(servers
        .iter()
        .any(|s| s["language"] == "json" && s["state"] == "running"));

    // notifications: shape only, content depends on server output
    let response = app
        .clone()
        .oneshot(
            authed_request(Method::GET, "/api/lsp/notifications")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let notes_body = response_json(response).await;
    assert!(notes_body["notifications"].as_array().is_some());
    assert!(notes_body["servers"].as_array().is_some());

    // stop: one server stopped
    let (status, stopped) = lsp_post(
        &app,
        "/api/lsp/stop",
        json!({ "language": "json", "cwd": workspace_abs }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "stop: {stopped}");
    assert_eq!(stopped["stopped"], 1);

    // stop everything: registry already empty
    let (status, stopped_all) = lsp_post(&app, "/api/lsp/stop", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stopped_all["stopped"], 0);
}

/// A server that pushes diagnostics, progress, and showMessage
/// notifications alongside its initialize response must land them in the
/// poll queue (and the events hub) instead of being mistaken for replies.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn lsp_api_server_notifications_are_queued_and_status_reports_stderr() {
    let Some(node) = node_binary_path() else {
        eprintln!("skipping: node not found");
        return;
    };
    let _env = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-lsp-api-notes");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let (script_dir, _script_guard) = temp_guard("herdr-lsp-api-notes-script");
    let workspace = script_dir.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let script_path = script_dir.join("notes-server.js");
    std::fs::write(
        &script_path,
        r#"
function send(msg) {
  const s = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(s) + '\r\n\r\n' + s);
}
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\r\n\r\n')) >= 0) {
    const m = buf.slice(0, idx).match(/Content-Length: (\d+)/);
    if (!m) { buf = ''; return; }
    const len = parseInt(m[1], 10);
    if (buf.length < idx + 4 + len) return;
    const body = buf.slice(idx + 4, idx + 4 + len);
    buf = buf.slice(idx + 4 + len);
    const msg = JSON.parse(body);
    if (msg.method === 'initialize') {
      process.stderr.write('fake server starting up\n');
      send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///a.json', diagnostics: [{ message: 'diag from fake' }] } });
      send({ jsonrpc: '2.0', method: '$/progress', params: { token: 'tok', value: { kind: 'begin', title: 'indexing' } } });
      send({ jsonrpc: '2.0', method: 'window/showMessage', params: { type: 3, message: 'hello from fake' } });
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true } } });
    } else if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    } else if (msg.method === 'exit') {
      process.exit(0);
    }
  }
});
"#,
    )
    .unwrap();
    let script_abs = script_path
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let workspace_abs = workspace
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let mut state = test_state();
    state.lsp = Arc::new(lsp::LspRegistry::new(lsp::LspSettings {
        enabled: true,
        servers: [(
            "json".to_string(),
            lsp::LanguageServerConfig {
                enabled: true,
                command: Some(node.clone()),
                args: vec![script_abs],
            },
        )]
        .into(),
    }));
    let app = test_app_with_state(state);

    let (status, started) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "json", "cwd": workspace_abs }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "start: {started}");

    let (status, init) = lsp_post(
        &app,
        "/api/lsp/request",
        json!({ "language": "json", "cwd": workspace_abs, "method": "initialize" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "initialize: {init}");

    // The three notifications emitted before the initialize reply must be
    // sitting in the poll queue under this server's key.
    let response = app
        .clone()
        .oneshot(
            authed_request(Method::GET, "/api/lsp/notifications")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let notes = response_json(response).await;
    let servers = notes["servers"].as_array().cloned().unwrap_or_default();
    assert!(
        servers.iter().any(|s| s["language"] == "json"),
        "server must be listed in notifications: {servers:?}"
    );
    let notifications = notes["notifications"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let methods: Vec<&str> = notifications
        .iter()
        .filter_map(|n| n["method"].as_str())
        .collect();
    assert!(
        methods.contains(&"textDocument/publishDiagnostics"),
        "diagnostics must be queued: {methods:?}"
    );
    assert!(
        methods.contains(&"$/progress"),
        "progress must be queued: {methods:?}"
    );
    assert!(
        methods.contains(&"window/showMessage"),
        "showMessage must be queued: {methods:?}"
    );

    // The stderr latch must surface the startup line in status.
    let mut found_stderr = false;
    for _ in 0..50 {
        let response = app
            .clone()
            .oneshot(
                authed_request(Method::GET, "/api/lsp/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response_json(response).await;
        if body["servers"]
            .as_array()
            .and_then(|s| s.first())
            .and_then(|s| s["last_error"].as_str())
            .is_some_and(|e| e.contains("stderr: fake server starting up"))
        {
            found_stderr = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(found_stderr, "stderr line must be latched into last_error");

    let (status, stopped) = lsp_post(
        &app,
        "/api/lsp/stop",
        json!({ "language": "json", "cwd": workspace_abs }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(stopped["stopped"], 1);
}

/// An oversized Content-Length must kill the server and prune it from the
/// registry: the reader refuses to buffer an unbounded body.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn lsp_api_server_oversized_frame_kills_and_prunes_server() {
    let Some(node) = node_binary_path() else {
        eprintln!("skipping: node not found");
        return;
    };
    let _env = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-lsp-api-oversize");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let (script_dir, _script_guard) = temp_guard("herdr-lsp-api-oversize-script");
    let workspace = script_dir.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let script_path = script_dir.join("oversize-server.js");
    std::fs::write(
        &script_path,
        r#"
process.stdout.write('Content-Length: 999999999\r\n\r\n');
setTimeout(() => process.exit(0), 10000);
"#,
    )
    .unwrap();
    let script_abs = script_path
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let workspace_abs = workspace
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let mut state = test_state();
    state.lsp = Arc::new(lsp::LspRegistry::new(lsp::LspSettings {
        enabled: true,
        servers: [(
            "json".to_string(),
            lsp::LanguageServerConfig {
                enabled: true,
                command: Some(node.clone()),
                args: vec![script_abs],
            },
        )]
        .into(),
    }));
    let app = test_app_with_state(state);

    let (status, started) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "json", "cwd": workspace_abs }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "start: {started}");

    // The oversized frame kills the server and removes it from the
    // registry, so the next request reports it as not running.
    let mut pruned = false;
    for _ in 0..50 {
        let (status, body) = lsp_post(
            &app,
            "/api/lsp/request",
            json!({ "language": "json", "cwd": workspace_abs, "method": "initialize" }),
        )
        .await;
        if status == StatusCode::NOT_FOUND {
            assert!(
                body["error"]
                    .as_str()
                    .is_some_and(|e| e.contains("not running")),
                "pruned server must report not-running: {body}"
            );
            pruned = true;
            break;
        }
        // 502 (send fails on the killed child) and 410 (entry still in
        // the registry, process dead) are valid intermediate states while
        // the cleanup finishes.
        assert!(
            status == StatusCode::OK
                || status == StatusCode::GONE
                || status == StatusCode::BAD_GATEWAY,
            "unexpected status {status}"
        );
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(pruned, "oversized frame must kill and prune the server");
}

/// A garbage JSON body must be skipped (server stays usable) and a
/// truncated frame followed by process exit must clean up the registry.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn lsp_api_server_survives_garbage_frame_and_prunes_after_truncated_exit() {
    let Some(node) = node_binary_path() else {
        eprintln!("skipping: node not found");
        return;
    };
    let _env = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-lsp-api-garbage");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let (script_dir, _script_guard) = temp_guard("herdr-lsp-api-garbage-script");
    let workspace = script_dir.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let script_path = script_dir.join("garbage-server.js");
    std::fs::write(
        &script_path,
        r#"
function send(msg) {
  const s = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(s) + '\r\n\r\n' + s);
}
let exited = false;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\r\n\r\n')) >= 0) {
    const m = buf.slice(0, idx).match(/Content-Length: (\d+)/);
    if (!m) { buf = ''; return; }
    const len = parseInt(m[1], 10);
    if (buf.length < idx + 4 + len) return;
    const body = buf.slice(idx + 4, idx + 4 + len);
    buf = buf.slice(idx + 4 + len);
    const msg = JSON.parse(body);
    if (msg.method === 'initialize' && !exited) {
      // First initialize: garbage JSON body with a valid header, then a
      // real reply. The reader must skip the garbage and still deliver.
      const junk = 'this is not json at all';
      process.stdout.write('Content-Length: ' + Buffer.byteLength(junk) + '\r\n\r\n' + junk);
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: { hoverProvider: true } } });
    } else if (msg.method === 'initialize' && exited) {
      // Second initialize: announce 100 bytes but send only a few, then
      // exit: truncated frame + EOF cleanup.
      process.stdout.write('Content-Length: 100\r\n\r\nshort');
      process.exit(0);
    } else if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: null });
    } else if (msg.method === 'exit') {
      process.exit(0);
    }
  }
});
"#,
    )
    .unwrap();
    let script_abs = script_path
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let workspace_abs = workspace
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .to_string();

    let mut state = test_state();
    state.lsp = Arc::new(lsp::LspRegistry::new(lsp::LspSettings {
        enabled: true,
        servers: [(
            "json".to_string(),
            lsp::LanguageServerConfig {
                enabled: true,
                command: Some(node.clone()),
                args: vec![script_abs],
            },
        )]
        .into(),
    }));
    let app = test_app_with_state(state);

    let (status, started) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "json", "cwd": workspace_abs }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "start: {started}");

    // First round: the garbage frame is skipped and the real reply lands.
    let (status, init) = lsp_post(
        &app,
        "/api/lsp/request",
        json!({ "language": "json", "cwd": workspace_abs, "method": "initialize" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "initialize after garbage: {init}");

    // Second round: stop the (still-running) server so the next start
    // spawns a fresh one wired to the truncated-exit script path.
    let (status, stopped) = lsp_post(
        &app,
        "/api/lsp/stop",
        json!({ "language": "json", "cwd": workspace_abs }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "stop: {stopped}");

    let (status, started_again) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "json", "cwd": workspace_abs }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "restart: {started_again}");

    // The truncated frame + exit must prune the registry entry.
    let mut pruned = false;
    for _ in 0..50 {
        let (status, body) = lsp_post(
            &app,
            "/api/lsp/request",
            json!({ "language": "json", "cwd": workspace_abs, "method": "initialize" }),
        )
        .await;
        if status == StatusCode::NOT_FOUND {
            assert!(
                body["error"]
                    .as_str()
                    .is_some_and(|e| e.contains("not running")),
                "pruned server must report not-running: {body}"
            );
            pruned = true;
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(pruned, "truncated frame + exit must prune the server");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn lsp_start_error_branches() {
    let _env = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-lsp-api-errors");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let mut state = test_state();
    state.lsp = Arc::new(lsp::LspRegistry::new(lsp::LspSettings {
        enabled: true,
        servers: [
            (
                "json".to_string(),
                lsp::LanguageServerConfig {
                    enabled: false,
                    command: Some("definitely-missing-server".to_string()),
                    args: vec![],
                },
            ),
            (
                "yaml".to_string(),
                lsp::LanguageServerConfig {
                    enabled: true,
                    command: None,
                    args: vec![],
                },
            ),
            (
                "rust".to_string(),
                lsp::LanguageServerConfig {
                    enabled: true,
                    command: Some("definitely-missing-server".to_string()),
                    args: vec![],
                },
            ),
        ]
        .into(),
    }));
    let app = test_app_with_state(state);

    // Unknown language: NOT_FOUND.
    let (status, body) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "cobol", "cwd": "/tmp" }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].as_str().unwrap().contains("cobol"));

    // Configured but disabled: FORBIDDEN.
    let (status, body) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "json", "cwd": "/tmp" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body["error"].as_str().unwrap().contains("disabled"));

    // Enabled but no command: BAD_REQUEST.
    let (status, body) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "yaml", "cwd": "/tmp" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("no command"));

    // Missing workspace on a fully configured language: BAD_REQUEST.
    let (status, body) = lsp_post(
        &app,
        "/api/lsp/start",
        json!({ "language": "rust", "cwd": "/definitely/not/here" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(body["error"].as_str().unwrap().contains("workspace"));
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn lsp_request_notify_require_running_server() {
    let _env = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-lsp-api-require");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    // Enabled with a configured command, but no server ever started: the
    // running-handle lookup is what must fail.
    let mut state = test_state();
    state.lsp = Arc::new(lsp::LspRegistry::new(lsp::LspSettings {
        enabled: true,
        servers: [(
            "json".to_string(),
            lsp::LanguageServerConfig {
                enabled: true,
                command: Some("definitely-missing-server".to_string()),
                args: vec![],
            },
        )]
        .into(),
    }));
    let app = test_app_with_state(state);
    // No server started yet: request and notify both 404.
    let (status, body) = lsp_post(
        &app,
        "/api/lsp/request",
        json!({ "language": "json", "cwd": "/tmp", "method": "initialize", "params": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(body["error"].as_str().unwrap().contains("not running"));

    let (status, _) = lsp_post(
        &app,
        "/api/lsp/notify",
        json!({ "language": "json", "cwd": "/tmp", "method": "initialized", "params": {} }),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // Bad workspace root on an allowed method: BAD_REQUEST.
    let (status, _) = lsp_post(
        &app,
        "/api/lsp/request",
        json!({ "language": "json", "cwd": "/definitely/not/here", "method": "initialize" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    let (status, _) = lsp_post(
        &app,
        "/api/lsp/notify",
        json!({ "language": "json", "cwd": "/definitely/not/here", "method": "initialized" }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);

    // Disallowed notify method: FORBIDDEN.
    let (status, _) = lsp_post(
        &app,
        "/api/lsp/notify",
        json!({ "language": "json", "cwd": "/tmp", "method": "workspace/didChangeConfiguration" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn lsp_request_notify_reject_when_disabled() {
    let state = test_state();
    let app = test_app_with_state(state);
    // Default settings have lsp disabled: request and notify 403.
    let (status, body) = lsp_post(
        &app,
        "/api/lsp/request",
        json!({ "language": "json", "cwd": "/tmp", "method": "initialize" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "language servers are disabled");

    let (status, _) = lsp_post(
        &app,
        "/api/lsp/notify",
        json!({ "language": "json", "cwd": "/tmp", "method": "initialized" }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}
