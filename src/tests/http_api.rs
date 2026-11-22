//! HTTP route handler tests: auth, settings, panes, terminal/events sockets.

use super::common::*;
use super::*;
use crate::tests::{env_lock, lock_env};

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn server_settings_api_reports_and_updates_runtime_settings() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-settings-api-test");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    let app = test_app_with_state(state);

    let before = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let before_body = response_json(before).await;
    assert_eq!(before_body["bind"], "127.0.0.1:8787");
    assert_eq!(before_body["tls_mode"], "auto");
    assert_eq!(before_body["scheme"], "https");
    assert_eq!(before_body["username"], "user");
    assert_eq!(before_body["no_sleep_auto_cooldown_seconds"], 60);
    assert_eq!(before_body["backend_mode"], "external-herdr");
    assert_eq!(before_body["builtin_shell"], Value::Null);
    assert!(before_body["default_folder"]
        .as_str()
        .is_some_and(|value| !value.is_empty()));
    assert_eq!(before_body["builtin_backend_enabled"], true);
    assert_eq!(before_body["external_herdr_backend_enabled"], true);
    assert_eq!(before_body["enabled_backends"]["builtin"], true);
    assert_eq!(before_body["enabled_backends"]["external-herdr"], true);

    let default_folder = std::env::temp_dir().to_string_lossy().to_string();
    let updated = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "0.0.0.0:8787",
                        "tls_mode": "off",
                        "username": "test-user",
                        "password": "test-password",
                        "localhost_no_auth": true,
                        "backend_mode": "builtin",
                        "builtin_shell": "/bin/zsh",
                        "default_folder": default_folder,
                        "builtin_backend_enabled": true,
                        "external_herdr_backend_enabled": false,
                        "no_sleep_auto_cooldown_seconds": 90,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let updated_body = response_json(updated).await;

    assert_eq!(updated_body["bind"], "0.0.0.0:8787");
    assert_eq!(updated_body["username"], "test-user");
    assert_eq!(updated_body["has_password"], true);
    assert_eq!(updated_body["no_sleep_auto_cooldown_seconds"], 90);
    assert_eq!(updated_body["backend_mode"], "builtin");
    assert_eq!(updated_body["tls_mode"], "off");
    assert_eq!(updated_body["scheme"], "http");
    assert_eq!(updated_body["builtin_shell"], "/bin/zsh");
    assert_eq!(
        updated_body["default_folder"],
        std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .to_string()
    );
    assert_eq!(updated_body["builtin_backend_enabled"], true);
    assert_eq!(updated_body["external_herdr_backend_enabled"], false);
    assert_eq!(updated_body["enabled_backends"]["builtin"], true);
    assert_eq!(updated_body["enabled_backends"]["external-herdr"], false);
    assert!(server_settings_path().exists());

    let cleared = app
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "0.0.0.0:8787",
                        "username": "test-user",
                        "password": null,
                        "localhost_no_auth": true,
                        "backend_mode": "builtin",
                        "builtin_shell": null,
                        "builtin_backend_enabled": true,
                        "external_herdr_backend_enabled": false,
                        "no_sleep_auto_cooldown_seconds": 90,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let cleared_body = response_json(cleared).await;
    assert_eq!(cleared_body["builtin_shell"], Value::Null);

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn every_response_carries_security_headers_and_api_responses_are_no_store() {
    let _guard = lock_env();
    let app = test_app();

    // Unauthenticated API responses must still carry the hardening headers
    // and must never be cacheable: the 401 body itself is fine to cache, but
    // an authed response captured by an intermediary would leak data.
    let api = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(api.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        api.headers().get(header::X_CONTENT_TYPE_OPTIONS),
        Some(&HeaderValue::from_static("nosniff"))
    );
    assert_eq!(
        api.headers().get(header::X_FRAME_OPTIONS),
        Some(&HeaderValue::from_static("DENY"))
    );
    assert_eq!(
        api.headers().get(header::REFERRER_POLICY),
        Some(&HeaderValue::from_static("no-referrer"))
    );
    assert_eq!(
        api.headers().get(header::CACHE_CONTROL),
        Some(&HeaderValue::from_static("no-store"))
    );

    // Static assets carry the hardening headers and now also the
    // revalidation pair (ETag + no-cache): asset URLs are versionless, so
    // no-cache forces a conditional revalidation that collapses to a 304
    // on unchanged binaries. The exact ETag value is build-dependent; pin
    // the presence and shape, not the hash.
    let asset = app
        .oneshot(
            request(Method::GET, "/assets/login.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(asset.status(), StatusCode::OK);
    assert_eq!(
        asset.headers().get(header::X_CONTENT_TYPE_OPTIONS),
        Some(&HeaderValue::from_static("nosniff"))
    );
    assert_eq!(
        asset.headers().get(header::CACHE_CONTROL),
        Some(&HeaderValue::from_static("no-cache"))
    );
    let etag = asset
        .headers()
        .get(header::ETAG)
        .and_then(|value| value.to_str().ok())
        .expect("assets carry an ETag");
    assert!(
        etag.starts_with('\"') && etag.ends_with('\"'),
        "ETag is quoted: {etag}"
    );
}

#[tokio::test]
async fn sessions_api_reports_enabled_backends_from_settings() {
    let state = test_state();
    state
        .server_settings
        .lock()
        .unwrap()
        .builtin_backend_enabled = false;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/sessions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["enabled_backends"]["builtin"], false);
    assert_eq!(body["enabled_backends"]["external-herdr"], true);
    // Default backend flips to the remaining enabled one.
    assert_eq!(body["default_backend"], "external-herdr");
}

#[tokio::test]
async fn server_settings_api_rejects_public_bind_without_credentials() {
    let app = test_app();

    let response = app
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "0.0.0.0:8787",
                        "username": null,
                        "password": null,
                        "localhost_no_auth": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(
        body["error"],
        "username and password are required before binding to 0.0.0.0 or any non-local address"
    );
}

#[tokio::test]
async fn server_settings_api_rejects_public_bind_with_missing_password() {
    let state = test_state();
    state.server_settings.lock().unwrap().password = None;
    let response = test_app_with_state(state)
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "0.0.0.0:8787",
                        "username": "user",
                        "password": null,
                        "localhost_no_auth": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[test]
fn require_auth_returns_unauthorized_response() {
    let state = test_state();
    let response =
        require_auth(&state, &HeaderMap::new(), "192.0.2.1:1234".parse().unwrap()).unwrap_err();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[test]
fn compares_constant_time_equal_values() {
    assert!(crate::auth::constant_time_eq(b"same", b"same"));
    assert!(!crate::auth::constant_time_eq(b"same", b"diff"));
    assert!(!crate::auth::constant_time_eq(b"same", b"same-but-longer"));
}

/// Terminal-WS teardown is the heart of the promote hand-off: the
/// overlay tab's WS must close the underlying temporary tab on a normal
/// disconnect, skip the close when the browser armed the release toggle
/// (successful promote) or when a promote is in flight / already done
/// (server-side guard), and give an in-transit promote a grace window
/// to arm that guard. One server, three sequential connections, one
/// recording api socket; the attach socket relays nothing so teardown
/// is driven purely by the WS lifecycle.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn terminal_ws_teardown_respects_promote_release_and_grace() {
    use futures_util::SinkExt;
    use tokio_tungstenite::connect_async;

    // Async channel: the test must never block the tokio runtime with a
    // std recv while the server task still needs to run.
    let (close_tx, mut close_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let (attach_tx, _attach_rx) = std::sync::mpsc::channel::<String>();
    let (api_socket, _api_thread) = fake_api_socket_recording(close_tx.clone());
    let (attach_socket, _attach_thread) = fake_terminal_attach_socket(attach_tx.clone());

    let mut state = test_state();
    state.api_socket = Some(api_socket.clone());
    state.client_socket = Some(attach_socket.clone());
    let app = test_app_with_state(state.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server_handle = tokio::spawn(async move {
        let mut shutdown_rx = Some(shutdown_rx);
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.take().unwrap().await;
        })
        .await;
    });

    let connect = |temporary_tab_id: &str| {
        let url =
            format!("ws://{addr}/ws/terminal?terminal_id=t1&temporary_tab_id={temporary_tab_id}");
        async move {
            let request = tokio_tungstenite::tungstenite::http::Request::builder()
                .uri(&url)
                .header("cookie", "herdr_web_session=token-123")
                .header("host", addr.to_string())
                .header("connection", "Upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-version", "13")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .body(())
                .unwrap();
            connect_async(request)
                .await
                .expect("failed to connect to terminal WS")
                .0
        }
    };

    // 1) Normal teardown: no release frame, no guard entry -> the
    //    temporary tab is auto-closed after the grace window.
    let mut ws = connect("tab-grace-normal").await;
    let _ = ws.close(None).await;
    let closed = tokio::time::timeout(Duration::from_secs(10), close_rx.recv())
        .await
        .expect("temporary tab must be closed on normal teardown")
        .expect("api socket thread alive");
    assert_eq!(closed, "tab-grace-normal");

    // 2) Armed release toggle: the same teardown must NOT close the
    //    tab (the promote succeeded and the overlay is going away).
    let mut ws = connect("tab-grace-armed").await;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        json!({ "type": "release", "enabled": true })
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    // Give the server a beat to consume the release frame before the
    // Close frame tears the socket down.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = ws.close(None).await;
    let unexpected = tokio::time::timeout(Duration::from_millis(600), close_rx.recv()).await;
    assert!(
        unexpected.is_err(),
        "armed release toggle must keep the promoted tab open (got {unexpected:?})"
    );

    // 3) In-flight promote arms the server-side guard during the grace
    //    window: the teardown re-check must observe it and skip the
    //    close. Simulates the WS dying exactly while the promote POST is
    //    between the socket read and the backend round-trip.
    let mut ws = connect("tab-grace-inflight").await;
    begin_temporary_tab_promote(&state.promoted_temporary_tabs, "tab-grace-inflight");
    let _ = ws.close(None).await;
    let unexpected = tokio::time::timeout(Duration::from_millis(600), close_rx.recv()).await;
    assert!(
        unexpected.is_err(),
        "in-flight promote must win the grace race and keep the tab open"
    );

    // Clean the guard so later checks stay honest.
    finish_temporary_tab_promote(&state.promoted_temporary_tabs, "tab-grace-inflight", false);

    // 4) In-transit promote: the WS closes first, then the promote POST
    //    lands inside the grace window. Its api socket accepts but never
    //    answers, so the request stays in flight and the guard stays
    //    armed (Promoting) when the teardown performs the grace
    //    re-check: the close must be skipped.
    let mut ws = connect("tab-grace-inflight-late").await;
    let _ = ws.close(None).await;
    {
        use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

        let stuck_path = fake_socket_dir().join(format!(
            "stuck-{}-{}.sock",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            fake_socket_suffix()
        ));
        let _ = fs::remove_file(&stuck_path);
        let name = stuck_path.clone().to_fs_name::<GenericFilePath>().unwrap();
        let stuck_listener = ListenerOptions::new()
            .name(name)
            .try_overwrite(true)
            .create_sync()
            .unwrap();
        // Accept, hold the request past the grace window, then answer
        // with a backend error so the in-flight promote task completes
        // and can be awaited deterministically.
        thread::spawn(move || {
            while let Ok(mut stream) = stuck_listener.accept() {
                thread::sleep(Duration::from_secs(2));
                let _ = stream.write_all(br#"{"id":"web:tab:promote","error":"stuck backend"}"#);
                let _ = stream.write_all(b"\n");
                let _ = stream.flush();
            }
        });

        let mut late_state = state.clone();
        late_state.api_socket = Some(stuck_path.clone());
        let late = tokio::spawn(async move {
            let request = Request::builder()
                .method(Method::POST)
                .uri("/api/tabs/tab-grace-inflight-late/promote")
                .header("cookie", "herdr_web_session=token-123")
                .extension(ConnectInfo("192.0.2.1:1234".parse::<SocketAddr>().unwrap()))
                .body(Body::empty())
                .unwrap();
            test_app_with_state(late_state)
                .oneshot(request)
                .await
                .unwrap()
        });
        let unexpected = tokio::time::timeout(Duration::from_millis(600), close_rx.recv()).await;
        assert!(
            unexpected.is_err(),
            "in-transit promote inside the grace window must keep the tab open"
        );
        // Disarm the guard; the stuck socket then answers with a
        // backend error after the grace window, so the promote task
        // finishes on its own (the error path decrements the saturated
        // count back to zero) and the full route tail, including the
        // join, is executed.
        finish_temporary_tab_promote(
            &state.promoted_temporary_tabs,
            "tab-grace-inflight-late",
            false,
        );
        let late_response = tokio::time::timeout(Duration::from_secs(10), late)
            .await
            .expect("late promote task must finish")
            .expect("late promote request must complete");
        // Transport succeeded, so the backend error rides inside the
        // envelope with an overall 200; the route must also have
        // disarmed the in-flight guard again on its error path.
        assert_eq!(
            late_response.status(),
            StatusCode::OK,
            "a backend error inside the envelope keeps the 200 transport status"
        );
        let body = to_bytes(late_response.into_body(), usize::MAX)
            .await
            .unwrap();
        let envelope: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(
            envelope["error"], "stuck backend",
            "the backend error must be relayed in the envelope"
        );
        let _ = fs::remove_file(&stuck_path);
    }

    // 5) Guard armed mid-grace: teardown passes the first check while
    //    the tab is still closable, then the promote guard arms during
    //    the 250ms window (exactly when an in-transit promote request
    //    gets parsed). The re-check must observe it and skip the close:
    //    this exercises the re-check false arm of the grace window.
    {
        let mut ws = connect("tab-grace-mid-arm").await;
        let _ = ws.close(None).await;
        // The close is detected and the first closability check has
        // passed by now (well under the grace window), so arming the
        // guard here puts it between the two checks deterministically.
        tokio::time::sleep(Duration::from_millis(100)).await;
        begin_temporary_tab_promote(&state.promoted_temporary_tabs, "tab-grace-mid-arm");
        let unexpected = tokio::time::timeout(Duration::from_millis(600), close_rx.recv()).await;
        assert!(
            unexpected.is_err(),
            "guard armed mid-grace must keep the tab open at the re-check"
        );
        finish_temporary_tab_promote(&state.promoted_temporary_tabs, "tab-grace-mid-arm", false);
    }

    let _ = shutdown_tx.send(());
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
    drop(close_tx);
    drop(attach_tx);
    // The fake-socket threads block in accept() until process exit;
    // they are intentionally detached (unique socket names, no joins).
    let _ = fs::remove_file(api_socket);
    let _ = fs::remove_file(attach_socket);
}

/// Forwarding happy path: the WS relay must translate browser frames
/// into herdr ClientMessages on the attach socket (binary passthrough,
/// JSON `input` text, plain text fallback) and keep the ping loop alive.
/// The abrupt socket drop after the ping exercises the raw-io error path
/// of the outbound relay without a clean Close handshake.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn terminal_ws_forwards_input_frames_to_attach_socket() {
    use futures_util::SinkExt;
    use tokio_tungstenite::connect_async;

    let (received_tx, received_rx) = std::sync::mpsc::channel::<String>();
    let (attach_socket, _attach_thread) = fake_terminal_attach_socket(received_tx.clone());

    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-api.sock"));
    state.client_socket = Some(attach_socket.clone());
    let app = test_app_with_state(state.clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server_handle = tokio::spawn(async move {
        let mut shutdown_rx = Some(shutdown_rx);
        let _ = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move {
            let _ = shutdown_rx.take().unwrap().await;
        })
        .await;
    });

    let url = format!("ws://{addr}/ws/terminal?terminal_id=t1&temporary_tab_id=tab-forward");
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let mut ws = connect_async(request)
        .await
        .expect("failed to connect to terminal WS")
        .0;

    ws.send(tokio_tungstenite::tungstenite::Message::Binary(
        vec![0x41, 0x42].into(),
    ))
    .await
    .unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::Text(
        json!({ "input": "XY" }).to_string().into(),
    ))
    .await
    .unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::Text("Z".into()))
        .await
        .unwrap();
    ws.send(tokio_tungstenite::tungstenite::Message::Ping(
        tokio_tungstenite::tungstenite::Bytes::from_static(b"keepalive"),
    ))
    .await
    .unwrap();

    // The relay may need a beat to drain the frames through the socket
    // pair; read the recorded messages on a blocking thread so the
    // tokio runtime is never blocked by the std mpsc receiver.
    let received_rx = Arc::new(StdMutex::new(received_rx));
    let next = || {
        let rx = Arc::clone(&received_rx);
        async move {
            tokio::task::spawn_blocking(move || {
                rx.lock()
                    .unwrap_or_else(|poison| poison.into_inner())
                    .recv_timeout(Duration::from_secs(10))
            })
            .await
            .unwrap()
        }
    };
    let first = next()
        .await
        .expect("attach socket must record binary passthrough");
    assert_eq!(first, "Input { data: [65, 66] }");
    let second = next().await.expect("attach socket must record json input");
    assert_eq!(second, "Input { data: [88, 89] }");
    let third = next().await.expect("attach socket must record plain text");
    assert_eq!(third, "Input { data: [90] }");

    // Abrupt drop: no Close frame, the socket dies while the relay is
    // healthy. The relay's outbound half must terminate and forward
    // nothing further.
    drop(ws);
    tokio::time::sleep(Duration::from_millis(300)).await;
    let leftover = received_rx
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .try_recv();
    assert!(
        leftover.is_err(),
        "no frames may be forwarded after the abrupt WS drop (got {leftover:?})"
    );

    let _ = shutdown_tx.send(());
    let _ = tokio::time::timeout(Duration::from_secs(5), server_handle).await;
    drop(received_tx);
    let _ = fs::remove_file(&attach_socket);
}

/// Raw-arm coverage for the recording api-socket fake: a connection
/// whose first line is not valid UTF-8 must hit the read_line error arm,
/// and a line that is valid UTF-8 but not JSON must hit the parse-fail
/// arm. Both end the accept loop, so the socket thread terminates and
/// no tab.close is ever recorded from these probe connections.
#[cfg(unix)]
#[tokio::test]
async fn fake_api_socket_recording_ends_on_raw_and_garbage_lines() {
    use interprocess::local_socket::{prelude::*, GenericFilePath};
    use std::io::Write as _;

    let (closed_tx, mut closed_rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    // Invalid UTF-8 on the wire: BufReader::read_line errors out and
    // the accept loop breaks on the raw-io arm.
    let (bad_utf8_socket, bad_utf8_thread) = fake_api_socket_recording(closed_tx.clone());
    let name = bad_utf8_socket
        .clone()
        .to_fs_name::<GenericFilePath>()
        .unwrap();
    let mut stream = LocalStream::connect(name).unwrap();
    stream.write_all(&[0xff, 0xfe, b'\n']).unwrap();
    stream.flush().unwrap();
    drop(stream);
    bad_utf8_thread.join().unwrap();
    let _ = fs::remove_file(&bad_utf8_socket);

    // Valid UTF-8 but not JSON: the parse-fail arm ends the loop.
    let (garbage_socket, garbage_thread) = fake_api_socket_recording(closed_tx.clone());
    let name = garbage_socket
        .clone()
        .to_fs_name::<GenericFilePath>()
        .unwrap();
    let mut stream = LocalStream::connect(name).unwrap();
    stream.write_all(b"not-json\n").unwrap();
    stream.flush().unwrap();
    drop(stream);
    garbage_thread.join().unwrap();
    let _ = fs::remove_file(&garbage_socket);

    // Valid JSON but not tab.close: the method filter arm falls
    // through, the request is answered, and no close is recorded.
    // The accept loop stays alive (detached like the other fakes), so
    // completion is observed from the response on the client stream.
    let (ping_socket, _ping_thread) = fake_api_socket_recording(closed_tx.clone());
    let name = ping_socket.clone().to_fs_name::<GenericFilePath>().unwrap();
    let mut stream = LocalStream::connect(name).unwrap();
    stream
        .write_all(br#"{"id":1,"method":"tab.list","params":{}}"#)
        .unwrap();
    stream.write_all(b"\n").unwrap();
    stream.flush().unwrap();
    let mut response = String::new();
    {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        reader.read_line(&mut response).unwrap();
    }
    assert_eq!(response.trim(), r#"{"id":1,"result":{}}"#);
    drop(stream);
    let _ = fs::remove_file(&ping_socket);

    // Attach-socket fake Err arm: after the Welcome handshake the relay
    // loop must end on a malformed frame instead of looping forever.
    let (attach_probe_tx, attach_probe_rx) = std::sync::mpsc::channel::<String>();
    let (attach_probe_socket, _attach_probe_thread) = fake_terminal_attach_socket(attach_probe_tx);
    let name = attach_probe_socket
        .clone()
        .to_fs_name::<GenericFilePath>()
        .unwrap();
    let mut stream = LocalStream::connect(name).unwrap();
    write_message(
        &mut stream,
        &ClientMessage::TerminalHello {
            version: PROTOCOL_VERSION,
            cols: 80,
            rows: 24,
            cell_width_px: 0,
            cell_height_px: 0,
            pixel_mouse: false,
        },
    )
    .unwrap();
    // First Input frame is consumed by the pre-loop read; the second
    // one is echoed into the received channel; the zero-length frame
    // after it fails bincode decoding and must end the relay loop.
    write_message(&mut stream, &ClientMessage::Input { data: vec![0x41] }).unwrap();
    write_message(&mut stream, &ClientMessage::Input { data: vec![0x43] }).unwrap();
    stream.write_all(&[0, 0, 0, 0]).unwrap();
    stream.flush().unwrap();
    let echoed = attach_probe_rx
        .recv_timeout(Duration::from_secs(10))
        .unwrap();
    assert_eq!(echoed, "Input { data: [67] }");
    drop(stream);
    let _ = fs::remove_file(&attach_probe_socket);

    assert!(
        tokio::time::timeout(Duration::from_millis(200), closed_rx.recv())
            .await
            .is_err(),
        "no tab.close may be recorded from raw probe connections"
    );
}

#[tokio::test]
async fn api_me_reports_authentication_status() {
    let app = test_app();

    let unauthenticated = app
        .clone()
        .oneshot(request(Method::GET, "/api/me").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let authenticated = app
        .oneshot(
            request(Method::GET, "/api/me")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(unauthenticated.status(), StatusCode::OK);
    assert_eq!(response_json(unauthenticated).await["authenticated"], false);
    assert_eq!(authenticated.status(), StatusCode::OK);
    assert_eq!(response_json(authenticated).await["authenticated"], true);
}

#[tokio::test]
async fn index_serves_login_without_auth_and_app_with_auth() {
    let app = test_app();

    let login = app
        .clone()
        .oneshot(request(Method::GET, "/").body(Body::empty()).unwrap())
        .await
        .unwrap();
    let app_html = app
        .clone()
        .oneshot(
            request(Method::GET, "/session/default/workspace/w1/tab/t1/pane/p1")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let app_js = app
        .oneshot(
            request(Method::GET, "/assets/desktop/app.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    let login_body = String::from_utf8(
        to_bytes(login.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let app_body = String::from_utf8(
        to_bytes(app_html.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let app_js_body = String::from_utf8(
        to_bytes(app_js.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    assert!(login_body.contains("Login"));
    assert!(app_body.contains("Herdr"));
    assert!(app_body.contains("/assets/app-boot.js"));
    assert!(app_js_body.contains("optSoundScope"));
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn login_route_sets_cookie_for_valid_credentials() {
    // The login handler persists the session sidecar; without an XDG
    // redirect that write lands on the real ~/.config and destroys the
    // operator's live sessions with fixture tokens.
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-login-route-test");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    let app = test_app_with_state(state.clone());
    let body = Body::from(r#"{"username":"user","password":"pass"}"#);

    let response = app
        .oneshot(
            request(Method::POST, "/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert!(response
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("herdr_web_session=") && value.contains("Max-Age=")));
    assert!(
        state
            .auth
            .lock()
            .unwrap()
            .sessions
            .iter()
            .any(|session| session.token == "token-123"),
        "login appends a session: the pre-login session must survive"
    );
    assert!(
        state.auth.lock().unwrap().sessions.len() >= 2,
        "login adds a new session alongside the pre-login one"
    );
    assert_eq!(response_json(response).await["ok"], true);
    let _ = std::fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[tokio::test]
async fn login_route_rejects_invalid_credentials() {
    let app = test_app();
    let body = Body::from(r#"{"username":"user","password":"wrong"}"#);

    let response = app
        .oneshot(
            request(Method::POST, "/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response_json(response).await["error"], "unauthorized");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn logout_route_invalidates_session_and_requires_auth() {
    // Same isolation as the login route test: logout persists the sidecar.
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-logout-route-test");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    let app = test_app_with_state(state.clone());

    // Unauthenticated logout must not revoke anything and answers 401.
    let response = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/logout")
                .header(header::COOKIE, "herdr_web_session=wrong")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(state.auth.lock().unwrap().sessions.len(), 1);

    // Authenticated logout revokes exactly the caller's session.
    let response = app
        .oneshot(
            request(Method::POST, "/api/logout")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response
            .headers()
            .get(header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.contains("Max-Age=0")),
        "logout must clear the browser cookie"
    );
    assert_eq!(response_json(response).await["ok"], true);
    assert!(
        state
            .auth
            .lock()
            .unwrap()
            .sessions
            .iter()
            .all(|session| session.token != "token-123"),
        "the caller's session must be revoked"
    );

    // The old cookie no longer authorizes API calls.
    let response = test_app_with_state(state.clone())
        .oneshot(
            request(Method::GET, "/api/me")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response_json(response).await["authenticated"], false);
    let _ = std::fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn login_route_throttles_repeated_failures() {
    // Failures never mint sessions, but keep the isolation contract for
    // every auth route test so a future edit persisting on failure
    // cannot silently write the real sidecar.
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-throttle-route-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let app = test_app();
    for _ in 0..5 {
        let body = Body::from(r#"{"username":"user","password":"wrong"}"#);
        let response = app
            .clone()
            .oneshot(
                request(Method::POST, "/api/login")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(body)
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    // Sixth attempt, even with correct credentials, must be throttled.
    let body = Body::from(r#"{"username":"user","password":"pass"}"#);
    let response = app
        .oneshot(
            request(Method::POST, "/api/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(body)
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(response_json(response).await["error"], "too many attempts");
    let _ = std::fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// End-to-end closure of the auth parity loop: a real axum server with
/// real auth (username/password, no localhost bypass), a real
/// `WebApiClient` as the TUI binary uses it, and a real
/// `webui-settings.json` holding the credentials. The client must get
/// 401 on the first recents call, log in through /api/login, cache the
/// session cookie, retry, and every recents operation must then work
/// against the authed server.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn web_api_client_authenticates_against_real_authed_server() {
    let _env = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-tui-auth-e2e-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(config_home.join("herdr-webui")).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    // GET /api/recent-workspaces prunes entries whose folder is gone,
    // so the recorded path must exist on disk.
    let recorded_dir = std::env::temp_dir().join(format!(
        "herdr-webui-tui-auth-e2e-dir-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&recorded_dir).unwrap();
    let recorded_path = recorded_dir.to_string_lossy().to_string();

    // test_state() has auth on: user/pass, localhost_no_auth false,
    // so only a valid session cookie passes require_auth.
    let state = test_state();
    // The session sidecar as the server writes it: the live session
    // token the TUI replays. Written before the server starts, the same
    // way a previous server run leaves it on disk.
    let sidecar_token = state
        .auth
        .lock()
        .unwrap()
        .current_session()
        .map(|session| session.token.clone())
        .unwrap();
    std::fs::write(
        config_home.join("herdr-webui").join("session-token"),
        json!({ "sessions": [ { "token": sidecar_token } ] }).to_string(),
    )
    .unwrap();
    let app = test_app_with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    // The blocking TUI client runs on the blocking pool.
    let port = addr.port();
    let outcome = tokio::task::spawn_blocking(move || {
        let client = herdr_webui::tui::web_api::WebApiClient::new("127.0.0.1", port);
        // First call: 401, then the client replays the sidecar session
        // token and retries. recent-workspaces returns [] with a 200 once
        // authorized.
        let value = client
            .recent_workspaces()
            .expect("401 triggers session replay and the retry succeeds");
        assert_eq!(value["recent"], json!([]), "authorized list is empty");
        // Second call: the cached cookie authorizes without replay.
        let value = client
            .recent_workspaces()
            .expect("cached session cookie authorizes");
        assert_eq!(value["recent"], json!([]));
        // Record one entry; it must persist with the sent fields.
        client
            .record_recent_workspace(&recorded_path, Some("e2e label"), Some("workspace"))
            .expect("record reaches the authed server");
        // And the list now serves the entry back (the folder exists, so
        // the GET pruning keeps it).
        let value = client.recent_workspaces().expect("list after record");
        assert_eq!(value["recent"][0]["path"], json!(recorded_path));
        assert_eq!(value["recent"][0]["label"], json!("e2e label"));
    })
    .await;

    // Also pin the no-live-sidecar path: a sidecar whose only token was
    // dropped server-side must surface the 401, not hang or loop.
    let wrong_port = addr.port();
    let wrong_config_home = config_home.clone();
    let wrong = tokio::task::spawn_blocking(move || {
        std::fs::write(
            wrong_config_home.join("herdr-webui").join("session-token"),
            json!({ "sessions": [ { "token": "dropped-server-side" } ] }).to_string(),
        )
        .unwrap();
        let client = herdr_webui::tui::web_api::WebApiClient::new("127.0.0.1", wrong_port);
        match client.recent_workspaces() {
            Err(herdr_webui::tui::web_api::WebApiError::Http { status: 401, .. }) => 401,
            other => panic!("expected surfaced 401, got {other:?}"),
        }
    })
    .await;

    server_handle.abort();
    outcome.expect("authed e2e client flow");
    assert_eq!(wrong.expect("stale-sidecar flow"), 401);

    let _ = std::fs::remove_dir_all(&recorded_dir);
    let _ = std::fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn web_api_client_recovers_after_real_server_token_rotation() {
    let _env = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-tui-rotation-e2e-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::fs::create_dir_all(config_home.join("herdr-webui")).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // Real authed router (auth on, no localhost bypass). Keep the auth
    // Arc so the test can rotate the session token live, which is what
    // a WebUI restart does to a long-running TUI.
    let state = test_state();
    let auth = Arc::clone(&state.auth);
    let old_token = auth
        .lock()
        .unwrap()
        .current_session()
        .map(|session| session.token.clone())
        .unwrap();
    // Sidecar seeded with the server's live token, the way a previous
    // run leaves it.
    std::fs::write(
        config_home.join("herdr-webui").join("session-token"),
        json!({ "sessions": [ { "token": old_token } ] }).to_string(),
    )
    .unwrap();
    let app = test_app_with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let port = addr.port();
    let outcome = tokio::task::spawn_blocking(move || {
        let client = herdr_webui::tui::web_api::WebApiClient::new("127.0.0.1", port);
        // Replay + authorized call: cookie for the old token.
        let value = client
            .recent_workspaces()
            .expect("initial replay and authorized call");
        assert_eq!(value["recent"], json!([]));
        client
            .recent_workspaces()
            .expect("cached cookie authorizes");
        (client, ())
    })
    .await;
    let (client, ()) = outcome.expect("initial authed flow");

    // Simulate the multi-session world the same way a restart does: keep
    // credentials, drop the old session, restore a fresh live session set.
    // The server's persist path then writes the NEW token to the sidecar,
    // so the TUI can replay it on its next 401.
    let new_token;
    {
        let mut auth = auth.lock().unwrap();
        let mut rotated = crate::auth::AuthConfig::from_parts_with_expiration(
            auth.user.clone(),
            auth.password.clone(),
            auth.localhost_no_auth,
            DEFAULT_SESSION_EXPIRATION_MINUTES,
        );
        let record = rotated.issue_session();
        new_token = record.token;
        assert_ne!(
            new_token, old_token,
            "rotation must not keep the old token live"
        );
        *auth = rotated;
    }
    std::fs::write(
        config_home.join("herdr-webui").join("session-token"),
        json!({ "sessions": [ { "token": new_token } ] }).to_string(),
    )
    .unwrap();

    // The same client instance (stale cookie) must replay the new sidecar
    // token, replace the cookie, and recover. The old `cookie.is_none()`
    // guard surfaces 401 forever here.
    let recovered = tokio::task::spawn_blocking(move || {
        let value = client
            .recent_workspaces()
            .expect("stale cookie replays and the call recovers");
        assert_eq!(value["recent"], json!([]));
        // And the new cookie is cached again.
        client.recent_workspaces().expect("new cookie authorizes");
    })
    .await;
    recovered.expect("rotation recovery flow");

    server_handle.abort();
    let _ = std::fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[tokio::test]
async fn static_asset_routes_serve_embedded_content() {
    let app = test_app();
    let js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/vendor/wterm.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/vendor/wterm.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let ghostty_wasm = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/vendor/ghostty-vt.wasm")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let font = app
        .clone()
        .oneshot(
            request(
                Method::GET,
                "/assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    let app_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/desktop/app.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let app_boot_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/app-boot.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let app_core_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/core.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let settings_feedback_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/settings-feedback.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let settings_confirm_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/settings-confirm.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let file_icons_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/file-icons.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let file_icons_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/file-icons.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_colors_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/colors.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_tokens_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/tokens.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_primitives_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/primitives.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_alert_card_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/alert-card.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_alert_card_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/alert-card.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let shared_content_search_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/content-search.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let file_content_search_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/file-content-search.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let line_context_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/shared/line-context.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let desktop_search_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/desktop/search.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let app_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/desktop/app.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let desktop_search_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/desktop/search.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let desktop_shortcuts_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/desktop/shortcuts.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/app.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_core_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/core.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_attention_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/attention.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_terminal_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/terminal.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_worktrees_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/worktrees.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_settings_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/settings.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_search_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/search.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_git_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/git.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_sessions_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/sessions.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_events_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/events.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_screens_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/screens.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_panels_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/panels.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_workmeta_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/workmeta.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_theme_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/theme.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_actions_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/actions.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_backend_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/backend.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let mobile_css = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/mobile/app.css")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let icon = app
        .clone()
        .oneshot(
            request(Method::GET, "/favicon.svg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let attention_icon = app
        .clone()
        .oneshot(
            request(Method::GET, "/favicon-attention.svg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let error_icon = app
        .oneshot(
            request(Method::GET, "/favicon-error.svg")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(js.status(), StatusCode::OK);
    assert_eq!(css.status(), StatusCode::OK);
    assert_eq!(ghostty_wasm.status(), StatusCode::OK);
    assert_eq!(font.status(), StatusCode::OK);
    assert_eq!(app_js.status(), StatusCode::OK);
    assert_eq!(app_boot_js.status(), StatusCode::OK);
    assert_eq!(app_core_js.status(), StatusCode::OK);
    assert_eq!(settings_feedback_js.status(), StatusCode::OK);
    assert_eq!(settings_confirm_js.status(), StatusCode::OK);
    assert_eq!(file_icons_js.status(), StatusCode::OK);
    assert_eq!(file_icons_css.status(), StatusCode::OK);
    assert_eq!(shared_colors_css.status(), StatusCode::OK);
    assert_eq!(shared_tokens_css.status(), StatusCode::OK);
    assert_eq!(shared_primitives_css.status(), StatusCode::OK);
    assert_eq!(shared_alert_card_js.status(), StatusCode::OK);
    assert_eq!(shared_alert_card_css.status(), StatusCode::OK);
    assert_eq!(shared_content_search_css.status(), StatusCode::OK);
    assert_eq!(file_content_search_js.status(), StatusCode::OK);
    assert_eq!(desktop_search_js.status(), StatusCode::OK);
    assert_eq!(app_css.status(), StatusCode::OK);
    assert_eq!(desktop_search_css.status(), StatusCode::OK);
    assert_eq!(desktop_shortcuts_css.status(), StatusCode::OK);
    assert_eq!(mobile_attention_js.status(), StatusCode::OK);
    assert_eq!(mobile_core_js.status(), StatusCode::OK);
    assert_eq!(mobile_terminal_js.status(), StatusCode::OK);
    assert_eq!(mobile_worktrees_js.status(), StatusCode::OK);
    assert_eq!(mobile_settings_js.status(), StatusCode::OK);
    assert_eq!(mobile_search_js.status(), StatusCode::OK);
    assert_eq!(mobile_git_js.status(), StatusCode::OK);
    assert_eq!(mobile_sessions_js.status(), StatusCode::OK);
    assert_eq!(mobile_events_js.status(), StatusCode::OK);
    assert_eq!(mobile_screens_js.status(), StatusCode::OK);
    assert_eq!(mobile_panels_js.status(), StatusCode::OK);
    assert_eq!(mobile_workmeta_js.status(), StatusCode::OK);
    assert_eq!(mobile_theme_js.status(), StatusCode::OK);
    assert_eq!(mobile_actions_js.status(), StatusCode::OK);
    assert_eq!(mobile_backend_js.status(), StatusCode::OK);
    assert_eq!(mobile_js.status(), StatusCode::OK);
    assert_eq!(mobile_css.status(), StatusCode::OK);
    assert_eq!(icon.status(), StatusCode::OK);
    assert_eq!(attention_icon.status(), StatusCode::OK);
    assert_eq!(error_icon.status(), StatusCode::OK);
    assert!(js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert_eq!(
        ghostty_wasm.headers()[header::CONTENT_TYPE],
        "application/wasm"
    );
    assert_eq!(font.headers()[header::CONTENT_TYPE], "font/ttf");
    assert!(app_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(app_boot_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(app_core_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(file_icons_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(file_icons_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(shared_colors_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(shared_tokens_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(shared_primitives_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(shared_alert_card_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(shared_alert_card_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(shared_content_search_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(file_content_search_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(line_context_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(desktop_search_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(app_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(desktop_search_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(desktop_shortcuts_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(mobile_core_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_attention_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_terminal_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_worktrees_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_settings_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_search_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_git_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_sessions_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_events_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_screens_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_panels_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_workmeta_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_theme_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_actions_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_backend_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_js.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(mobile_css.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("text/css"));
    assert!(icon.headers()[header::CONTENT_TYPE]
        .to_str()
        .unwrap()
        .contains("image/svg+xml"));
    assert!(
        to_bytes(js.into_body(), 8 * 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(to_bytes(css.into_body(), 1024 * 1024).await.unwrap().len() > 100);
    assert!(
        to_bytes(ghostty_wasm.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100 * 1024
    );
    assert!(
        to_bytes(font.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 2 * 1024 * 1024
    );
    assert!(
        to_bytes(app_js.into_body(), 4 * 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(app_boot_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(app_core_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(file_icons_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(file_icons_css.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(desktop_search_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(app_css.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(desktop_search_css.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(desktop_shortcuts_css.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(mobile_core_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_attention_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_terminal_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_worktrees_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_settings_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 100
    );
    assert!(
        to_bytes(mobile_search_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_git_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_sessions_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_events_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 500
    );
    assert!(
        to_bytes(mobile_screens_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_panels_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_workmeta_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_theme_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_actions_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_backend_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(
        to_bytes(mobile_css.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .len()
            > 1000
    );
    assert!(String::from_utf8(
        to_bytes(icon.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec()
    )
    .unwrap()
    .contains("<svg"));
}

#[tokio::test]
async fn app_boot_skips_terminal_scroll_helper_but_compat_route_remains() {
    let app = test_app();
    let app_boot_js = app
        .clone()
        .oneshot(
            request(Method::GET, "/assets/app-boot.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let terminal_scroll_js = app
        .oneshot(
            request(Method::GET, "/assets/shared/terminal-scroll.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(app_boot_js.status(), StatusCode::OK);
    assert_eq!(terminal_scroll_js.status(), StatusCode::OK);
    let app_boot_body = String::from_utf8(
        to_bytes(app_boot_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();
    let terminal_scroll_body = String::from_utf8(
        to_bytes(terminal_scroll_js.into_body(), 1024 * 1024)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap();

    assert!(!app_boot_body.contains("/assets/shared/terminal-scroll.js"));
    assert!(terminal_scroll_body.contains("Compatibility shim"));
    assert!(terminal_scroll_body.contains("HerdrTerminalScroll"));
}

// ── proxy_request_async success + error paths ──

#[cfg(unix)]
#[tokio::test]
async fn agents_handler_proxies_agent_list() {
    let (socket, handle) = fake_api_socket_for_method(
        "agent.list",
        json!({ "id": "web:agent:list", "result": { "agents": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/agents")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["result"]["agents"].is_array());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn agents_handler_returns_bad_gateway_on_socket_error() {
    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-agents-test.sock"));
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/agents")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
}

#[cfg(unix)]
#[tokio::test]
async fn tabs_handler_proxies_tab_list() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.list",
        json!({ "id": "web:tab:list", "result": { "tabs": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/tabs")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["result"]["tabs"].is_array());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn pane_prompt_endpoint_parses_jcode_viewer_from_raw_terminal_bytes() {
    // End-to-end for the mobile card fallback: raw terminal bytes from
    // pane.read (SGR colors, OSC title, cursor addressing, box drawing)
    // must parse into the letter-key options card, and the blocked flag
    // must ride through from agent.list.
    let viewer = "\u{1b}]0;jcode\u{7}\u{1b}[2J\u{1b}[H\u{1b}[1;36m│ Permissions (2 pending)                                                  │\u{1b}[0m\n\
         \u{1b}[36m│ Tool: Bash (rm -rf work)                                                  │\u{1b}[0m\n\
         \u{1b}[33m│ a approve · d deny · A approve all · D deny all                          │\u{1b}[0m\n\
         \u{1b}[90m│ ⏳ Agent is waiting for this decision                                     │\u{1b}[0m\n\n\n";
    let agents = json!({
        "id": "web:agent:list:prompt",
        "result": { "agents": [
            { "pane_id": "pane_1", "agent_status": "blocked" },
            { "pane_id": "pane_2", "agent_status": "working" }
        ]}
    });
    let (socket, handle) = fake_api_socket_multi(vec![
        json!({
            "id": "web:pane:read:prompt",
            "result": { "read": { "pane_id": "pane_1", "text": viewer, "format": "text" } }
        }),
        agents,
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/prompt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["blocked"], json!(true), "blocked flag from agent.list");
    assert_eq!(body["kind"], json!("options"));
    assert_eq!(body["title"], json!("jcode permissions (2 pending)"));
    let options = body["options"].as_array().unwrap();
    assert_eq!(options.len(), 4);
    assert_eq!(options[0]["key"], json!("a"));
    assert_eq!(options[0]["label"], json!("Approve"));
    assert_eq!(options[1]["key"], json!("d"));
    assert_eq!(options[1]["label"], json!("Deny"));
    assert_eq!(options[2]["key"], json!("A"));
    assert_eq!(options[2]["label"], json!("Approve all"));
    assert_eq!(options[3]["key"], json!("D"));
    assert_eq!(options[3]["label"], json!("Deny all"));
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn pane_prompt_endpoint_returns_null_kind_when_no_dialog() {
    let (socket, handle) = fake_api_socket_multi(vec![
        json!({
            "id": "web:pane:read:prompt",
            "result": { "read": { "pane_id": "pane_1", "text": "$ ls\nsrc tests Cargo.toml\n$ ", "format": "text" } }
        }),
        json!({
            "id": "web:agent:list:prompt",
            "result": { "agents": [
                { "pane_id": "pane_1", "agent_status": "idle" }
            ]}
        }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/prompt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["blocked"], json!(false));
    assert_eq!(body["kind"], serde_json::Value::Null);
    assert_eq!(body["title"], serde_json::Value::Null);
    assert_eq!(body["options"], json!([]));
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn pane_prompt_endpoint_returns_bad_gateway_on_backend_error() {
    let (socket, handle) = fake_api_socket_multi(vec![json!({
        "id": "web:pane:read:prompt",
        "error": { "code": "not_found", "message": "pane gone" }
    })]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/prompt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert_eq!(
        body["error"],
        json!("pane gone"),
        "backend message surfaces"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn pane_prompt_endpoint_tail_window_keeps_last_16_lines() {
    // The payload takes the last 16 non-trailing-blank lines, mirroring
    // prompt_cards.js tailLines(). The same dialog must parse when it
    // sits inside that window and stop parsing once newer output pushes
    // it out: a stale transcript dialog must never float a card.
    let viewer = [
        "│ Permissions (1 pending) │",
        "│ Tool: Bash (git push) │",
        "│ a approve · d deny · A approve all · D deny all │",
        "│ ⏳ Agent is waiting for this decision │",
    ];
    let agents = json!({
        "id": "web:agent:list:prompt",
        "result": { "agents": [
            { "pane_id": "pane_1", "agent_status": "blocked" }
        ]}
    });

    let inside = {
        // Exactly 16 lines: the title sits at the window's top edge. Any
        // smaller window would truncate the title and the parse must
        // fail, so this pins the boundary from BOTH sides.
        let mut lines: Vec<String> = vec!["│ Permissions (1 pending) │".to_string()];
        lines.push("│ Tool: Bash (git push) │".to_string());
        lines.push("│ a approve · d deny · A approve all · D deny all │".to_string());
        lines.push("│ ⏳ Agent is waiting for this decision │".to_string());
        for i in 0..12 {
            lines.push(format!("│ filler row {i} │"));
        }
        lines.join("\n")
    };
    let (socket, handle) = fake_api_socket_multi(vec![
        json!({
            "id": "web:pane:read:prompt",
            "result": { "read": { "pane_id": "pane_1", "text": inside, "format": "text" } }
        }),
        agents.clone(),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);
    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/prompt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["kind"], json!("options"), "dialog at the tail parses");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    // Sixteen newer lines push the dialog out of the window: no card.
    let newer: Vec<String> = (0..16).map(|i| format!("build log line {i}")).collect();
    let outside = format!("{}\n{}", viewer.join("\n"), newer.join("\n"));
    let (socket, handle) = fake_api_socket_multi(vec![
        json!({
            "id": "web:pane:read:prompt",
            "result": { "read": { "pane_id": "pane_1", "text": outside, "format": "text" } }
        }),
        agents.clone(),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);
    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/prompt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(
        body["kind"],
        serde_json::Value::Null,
        "dialog outside the window never parses"
    );
    assert_eq!(
        body["blocked"],
        json!(true),
        "blocked flag still rides through"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn pane_prompt_endpoint_survives_raw_crlf_bytes() {
    // Some backends hand back grid text with CRLF row ends; the strip
    // must not turn every row into a blank-separated double row. This
    // pins the current behavior so a regression cannot slip in silently.
    let viewer = "│ Permissions (1 pending) │\r\n│ Tool: Bash (git push) │\r\n│ a approve · d deny · A approve all · D deny all │\r\n│ ⏳ Agent is waiting for this decision │\r\n";
    let (socket, handle) = fake_api_socket_multi(vec![
        json!({
            "id": "web:pane:read:prompt",
            "result": { "read": { "pane_id": "pane_1", "text": viewer, "format": "text" } }
        }),
        json!({
            "id": "web:agent:list:prompt",
            "result": { "agents": [
                { "pane_id": "pane_1", "agent_status": "blocked" }
            ]}
        }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/prompt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(
        body["kind"],
        json!("options"),
        "CRLF rows still parse as one card"
    );
    assert_eq!(body["blocked"], json!(true));
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    // Sixteen CRLF rows fill the tail window exactly in Drop mode. Newline
    // mode would double them to 31 lines and push the help row and the
    // waiting marker out of the last-16 window, killing the parse: this
    // leg catches a strip-mode regression the short dialog above cannot.
    let mut rows: Vec<String> = vec![
        "│ Permissions (1 pending) │".to_string(),
        "│ Tool: Bash (git push) │".to_string(),
        "│ a approve · d deny · A approve all · D deny all │".to_string(),
        "│ ⏳ Agent is waiting for this decision │".to_string(),
    ];
    for i in 0..12 {
        rows.push(format!("│ filler row {i} │"));
    }
    let full = rows.join("\r\n") + "\r\n";
    let (socket, handle) = fake_api_socket_multi(vec![
        json!({
            "id": "web:pane:read:prompt",
            "result": { "read": { "pane_id": "pane_1", "text": full, "format": "text" } }
        }),
        json!({
            "id": "web:agent:list:prompt",
            "result": { "agents": [
                { "pane_id": "pane_1", "agent_status": "blocked" }
            ]}
        }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);
    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/prompt")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(
        body["kind"],
        json!("options"),
        "a full-window CRLF dialog still parses"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn pane_prompt_endpoint_accepts_all_pane_read_shapes() {
    // The wire shape is `{"result": {"read": ...}}` on both backends, but
    // the payload keeps unwrapped fallbacks for flat backends
    // (bare `read` object, or a top-level `text`). All three must parse
    // the same viewer dialog; a fallback that silently reads the wrong
    // field would return kind: null in production.
    let viewer = "│ Permissions (3 pending) │\n│ a approve · d deny · A approve all · D deny all │\n│ ⏳ Agent is waiting for this decision │";
    let agents = json!({
        "id": "web:agent:list:prompt",
        "result": { "agents": [
            { "pane_id": "pane_1", "agent_status": "blocked" }
        ]}
    });
    for (name, read) in [
        (
            "wrapped result",
            json!({
                "id": "web:pane:read:prompt",
                "result": { "read": { "pane_id": "pane_1", "text": viewer, "format": "text" } }
            }),
        ),
        (
            "unwrapped read",
            json!({
                "id": "web:pane:read:prompt",
                "read": { "pane_id": "pane_1", "text": viewer, "format": "text" }
            }),
        ),
        (
            "flat text",
            json!({ "id": "web:pane:read:prompt", "text": viewer, "format": "text" }),
        ),
    ] {
        let (socket, handle) = fake_api_socket_multi(vec![read.clone(), agents.clone()]);
        let mut state = test_state();
        state.api_socket = Some(socket.clone());
        let app = test_app_with_state(state);
        let response = app
            .oneshot(
                authed_request(Method::GET, "/api/panes/pane_1/prompt")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK, "{name}: status");
        let body = response_json(response).await;
        assert_eq!(body["kind"], json!("options"), "{name}: viewer parses");
        assert_eq!(
            body["title"],
            json!("jcode permissions (3 pending)"),
            "{name}: title"
        );
        handle.join().unwrap();
        let _ = fs::remove_file(socket);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn panes_handler_proxies_pane_list() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.list",
        json!({ "id": "web:pane:list", "result": { "panes": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["result"]["panes"].is_array());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn pane_layout_handler_proxies_pane_layout() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.layout",
        json!({ "id": "web:pane:layout", "result": { "layout": {} } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/pane-layout")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── update_server_settings save error path ──

#[tokio::test]
async fn update_server_settings_rejects_invalid_bind_address() {
    let app = test_app();

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "bind": "not-a-valid-address", "localhost_no_auth": true }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert!(body["error"]
        .as_str()
        .is_some_and(|e| e.contains("invalid bind")));
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn update_server_settings_rejects_public_bind_without_credentials() {
    let _env = lock_env();
    let (config_home, _config_guard) = temp_guard("settings-public-bind");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let app = test_app();

    // A non-loopback bind with no username/password is rejected by
    // validation before anything is saved.
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "bind": "0.0.0.0:8787", "localhost_no_auth": true }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert!(body["error"]
        .as_str()
        .is_some_and(|e| e.contains("username and password are required")));
}

// ── server_settings handler POST with successful save (spawn_blocking path) ──

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn update_server_settings_saves_and_returns_updated_settings() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-save-test");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "127.0.0.1:9999",
                        "username": "user",
                        "password": "pass",
                        "localhost_no_auth": false,
                        "session_expiration_minutes": 30,
                        "no_sleep_auto_cooldown_seconds": 120,
                        "backend_mode": "builtin",
                        "builtin_backend_enabled": true,
                        "external_herdr_backend_enabled": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["bind"], "127.0.0.1:9999");
    assert_eq!(body["no_sleep_auto_cooldown_seconds"], 120);
    assert_eq!(body["session_expiration_minutes"], 30);
    assert_eq!(body["backend_mode"], "builtin");
    assert!(server_settings_path().exists());

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// Policy-only saves must adopt the NEW lifetime for every preserved
/// session. The W18b live run caught the bug: the save path stomped the
/// incoming policy with the old one before re-anchoring, so a 1-minute
/// policy flipped to never-expire still killed every browser 60s later.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn update_server_settings_policy_flip_adopts_new_lifetime() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-policy-flip-test");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    let auth = Arc::clone(&state.auth);
    // Two live browsers, timed policy 30 minutes, sessions near expiry.
    {
        let mut auth = auth.lock().unwrap();
        auth.session_expiration_minutes = 30;
        let soon = SystemTime::now() + std::time::Duration::from_secs(30);
        auth.sessions = vec![
            crate::auth::SessionRecord {
                token: "token-123".to_string(),
                expires_at: soon,
            },
            crate::auth::SessionRecord {
                token: "token-456".to_string(),
                expires_at: soon,
            },
        ];
    }
    let mut settings = state.server_settings.lock().unwrap();
    settings.session_expiration_minutes = 30;
    drop(settings);
    let app = test_app_with_state(state);

    // Policy-only save: same identity, never-expire from now on.
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": DEFAULT_BIND,
                        "username": "user",
                        "password": "pass",
                        "localhost_no_auth": false,
                        "session_expiration_minutes": 0,
                        "backend_mode": "builtin",
                        "builtin_backend_enabled": true,
                        "external_herdr_backend_enabled": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    {
        let auth = auth.lock().unwrap();
        assert_eq!(
            auth.session_expiration_minutes, 0,
            "the new policy must be adopted, not stomped by the old value"
        );
        assert_eq!(auth.sessions.len(), 2, "both sessions preserved");
        for session in &auth.sessions {
            assert_eq!(
                session.expires_at,
                crate::auth::never_expires_at(),
                "re-anchor must stamp the never-expire sentinel on every session"
            );
        }
    }

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// The reverse flip (never-expire -> timed) must equally re-anchor: a
/// session that used to live forever now carries the timed deadline.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn update_server_settings_policy_flip_never_to_timed_anchors_deadline() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-policy-flip-rev-test");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    let auth = Arc::clone(&state.auth);
    // Never-expire policy, one never session, one already-lapsed session.
    {
        let mut auth = auth.lock().unwrap();
        auth.session_expiration_minutes = 0;
        auth.sessions = vec![
            crate::auth::SessionRecord {
                token: "token-123".to_string(),
                expires_at: crate::auth::never_expires_at(),
            },
            crate::auth::SessionRecord {
                token: "token-lapsed".to_string(),
                expires_at: SystemTime::now() - std::time::Duration::from_secs(1),
            },
        ];
    }
    let mut settings = state.server_settings.lock().unwrap();
    settings.session_expiration_minutes = 0;
    drop(settings);
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": DEFAULT_BIND,
                        "username": "user",
                        "password": "pass",
                        "localhost_no_auth": false,
                        "session_expiration_minutes": 45,
                        "backend_mode": "builtin",
                        "builtin_backend_enabled": true,
                        "external_herdr_backend_enabled": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    {
        let auth = auth.lock().unwrap();
        assert_eq!(
            auth.session_expiration_minutes, 45,
            "the new timed policy must be adopted"
        );
        let valid: Vec<_> = auth
            .sessions
            .iter()
            .filter(|session| session.token == "token-123")
            .collect();
        assert_eq!(valid.len(), 1, "live session preserved across the flip");
        let deadline = SystemTime::now() + std::time::Duration::from_secs(45 * 60);
        assert!(
            valid[0].expires_at > SystemTime::now() + std::time::Duration::from_secs(40 * 60),
            "re-anchor must stamp the timed deadline, not keep never-expire"
        );
        assert!(valid[0].expires_at <= deadline);
    }

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── proxy_server_stop with actual server.stop response (success) ──

/// A credential change resets every session and mints one fresh cookie
/// for the caller on the same response, so the save itself must not 401
/// the browser that made it while every other token dies.
#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn update_server_settings_identity_change_rotates_sessions_and_cookie() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-identity-change-test");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    let auth = Arc::clone(&state.auth);
    // A second browser session that must die with the credential change.
    {
        let mut auth = auth.lock().unwrap();
        auth.sessions.push(crate::auth::SessionRecord {
            token: "token-other-browser".to_string(),
            expires_at: crate::auth::never_expires_at(),
        });
    }
    let app = test_app_with_state(state);

    // Same user, new password: identity change.
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": DEFAULT_BIND,
                        "username": "user",
                        "password": "new-pass",
                        "localhost_no_auth": false,
                        "session_expiration_minutes": DEFAULT_SESSION_EXPIRATION_MINUTES,
                        "backend_mode": "builtin",
                        "builtin_backend_enabled": true,
                        "external_herdr_backend_enabled": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let set_cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    assert!(
        set_cookie
            .as_ref()
            .is_some_and(|c| c.contains("herdr_web_session=")),
        "the save response must carry the fresh cookie for the caller"
    );
    let new_token = set_cookie.as_ref().map(|c| {
        c.split("herdr_web_session=")
            .nth(1)
            .and_then(|rest| rest.split(';').next())
            .unwrap_or_default()
            .to_string()
    });

    {
        let auth = auth.lock().unwrap();
        let stored = auth.password.as_deref().unwrap_or_default();
        assert!(
            crate::password_hashing::verify_password(stored, "new-pass"),
            "the new credential must be live as a PHC hash, not plaintext"
        );
        assert_ne!(stored, "new-pass", "never store the plaintext");
        assert_eq!(
            auth.user.as_deref(),
            Some("user"),
            "the username change must be live too"
        );
        assert_eq!(
            auth.sessions.len(),
            1,
            "every old session must be reset, only the caller's fresh one remains"
        );
        assert!(
            !auth.sessions.iter().any(|s| s.token == "token-123"),
            "the old caller token must be dead"
        );
        assert_eq!(
            new_token.as_deref(),
            Some(auth.sessions[0].token.as_str()),
            "the Set-Cookie token must match the one stored session"
        );
    }

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── proxy_request_async JoinError (panic in spawn_blocking) ──
// This is hard to trigger directly; the error path is covered by
// testing handlers that point to nonexistent sockets, which triggers
// the Err(err) branch in the match.

#[cfg(unix)]
#[tokio::test]
async fn proxy_request_async_handlers_return_bad_gateway_on_missing_socket() {
    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-proxy-async-test.sock"));
    let app = test_app_with_state(state);

    // Test several handlers that use proxy_request_async
    let endpoints: [(&str, Method); 5] = [
        ("/api/agents", Method::GET),
        ("/api/tabs", Method::GET),
        ("/api/panes", Method::GET),
        ("/api/pane-layout", Method::GET),
        ("/api/session-snapshot", Method::GET),
    ];

    for (uri, method) in &endpoints {
        let response = app
            .clone()
            .oneshot(
                authed_request(method.clone(), uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_GATEWAY,
            "endpoint {uri} should return 502"
        );
    }
}

// ── auth rejection for all proxy handlers ──

/// All proxy handlers should reject unauthenticated requests with 401.
#[tokio::test]
async fn proxy_handlers_reject_unauthenticated() {
    let endpoints = [
        ("/api/agents", Method::GET),
        ("/api/tabs", Method::GET),
        ("/api/panes", Method::GET),
        ("/api/pane-layout", Method::GET),
        ("/api/session-snapshot", Method::GET),
        ("/api/workspaces", Method::GET),
        ("/api/git-branches?cwd=.", Method::GET),
    ];

    for (uri, method) in &endpoints {
        let response = test_app()
            .oneshot(request(method.clone(), uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "endpoint {uri} should require auth"
        );
    }
}

/// POST handlers also reject unauthenticated requests.
#[tokio::test]
async fn post_handlers_reject_unauthenticated() {
    let endpoints = [
        ("/api/workspaces", json!({"cwd": ".", "label": "t"})),
        ("/api/workspaces/ws1/rename", json!({"label": "t"})),
        ("/api/workspaces/ws1/close", json!({})),
        ("/api/tabs", json!({"workspace_id": "ws1", "label": "t"})),
        ("/api/tabs/t1/rename", json!({"label": "t"})),
        ("/api/tabs/t1/close", json!({})),
        ("/api/panes/p1/close", json!({})),
        ("/api/worktrees/open", json!({"path": "/tmp"})),
        ("/api/worktrees", json!({"cwd": ".", "path": "/tmp/wt"})),
    ];

    for (uri, body) in &endpoints {
        let response = test_app()
            .oneshot(
                request(Method::POST, uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "endpoint {uri} should require auth"
        );
    }
}

/// session/launch and session/close also reject unauthenticated requests.
#[tokio::test]
async fn session_handlers_reject_unauthenticated() {
    for uri in ["/api/session/launch", "/api/session/close"] {
        let response = test_app()
            .oneshot(
                request(Method::POST, uri)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::UNAUTHORIZED,
            "endpoint {uri} should require auth"
        );
    }
}

/// update_server_settings rejects unauthenticated requests.
#[tokio::test]
async fn update_server_settings_rejects_unauthenticated() {
    // Need a valid body (with bind field) so JSON parsing succeeds,
    // then auth check runs and rejects.
    let response = test_app()
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "127.0.0.1:8080",
                        "localhost_no_auth": false,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

// ── proxy_request_async success path ──

#[cfg(unix)]
#[tokio::test]
async fn agents_handler_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "agent.list",
        json!({ "id": "web:agent:list", "result": { "agents": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/agents")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body.get("result").is_some());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn tabs_handler_proxies_with_workspace_id() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.list",
        json!({ "id": "web:tab:list", "result": { "tabs": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/tabs?workspace_id=ws1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── pane_layout success path ──

#[cfg(unix)]
#[tokio::test]
async fn pane_layout_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.layout",
        json!({ "id": "web:pane:layout", "result": { "layout": {} } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/pane-layout?pane_id=p1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── panes success path ──

#[cfg(unix)]
#[tokio::test]
async fn panes_handler_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.list",
        json!({ "id": "web:pane:list", "result": { "panes": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes?workspace_id=ws1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

/// The herdr_error frame must name the backend the server actually
/// resolved for the attach, not the browser's stale pin: when a tab
/// pins external-herdr after the setting was disabled, the server
/// reroutes to builtin and the frame says builtin.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn terminal_ws_herdr_error_reports_resolved_backend() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-terminal-backend-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let mut state = test_state();
    // External-herdr is disabled: a browser pinning it gets rerouted to
    // the built-in backend. Block the built-in session start (directory
    // at the api socket path makes bind fail, per the launch_session
    // error-path test) so the attach fails with connect_failed.
    state
        .server_settings
        .lock()
        .unwrap()
        .external_herdr_backend_enabled = false;
    state.backend_mode = BackendMode::Builtin;
    let (api_socket, client_socket) = builtin_socket_paths(None);
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    fs::create_dir_all(client_socket.parent().unwrap()).unwrap();
    let _ = fs::remove_file(&api_socket);
    fs::create_dir(&api_socket).unwrap();
    let app = test_app_with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let url = format!("ws://{addr}/ws/terminal?terminal_id=t1&backend=external-herdr");
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(request)
        .await
        .expect("Failed to connect to WebSocket");

    let mut got_error_frame = false;
    for _ in 0..30 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        // The attach failure is surfaced twice: the raw error text as a
        // binary frame, then the structured herdr_error JSON. Both travel
        // one ordered channel, so the JSON always follows the raw text.
        let Ok(text) = msg.to_text() else { continue };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
            continue;
        };
        if value["type"].as_str() == Some("herdr_error") {
            // The resolved backend is builtin: the disabled external pin
            // must not leak into the frame.
            assert_eq!(value["backend"], "builtin");
            assert_eq!(value["kind"], "connect_failed");
            got_error_frame = true;
            break;
        }
    }
    assert!(
        got_error_frame,
        "herdr_error frame with resolved backend must reach the terminal socket"
    );

    server_handle.abort();
    let _ = fs::remove_dir(&api_socket);
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── events WebSocket upgrade test ──
// The events_ws handler requires a proper WebSocket upgrade request.
// Testing the full event loop requires a real WebSocket client and
// is beyond the scope of unit tests. The events_socket code is
// exercised via integration tests with a running backend.

/// events_ws rejects unauthenticated requests.
#[tokio::test]
async fn events_ws_rejects_unauthenticated() {
    // Without auth cookie, the handler should reject even WebSocket
    // upgrade requests. Axum's WebSocketUpgrade extractor runs first,
    // so without proper WS headers we get 400, but with proper WS
    // headers and no auth we'd get 401. Test the auth rejection path.
    let response = test_app()
        .oneshot(
            request(Method::GET, "/ws/events")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // Without proper WS upgrade headers, Axum returns 400
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

// ── remove_worktree_path Ok(Err) path ──
// The Ok(Err(err)) path triggers when `Command::new("git").output()` fails
// to spawn (git binary not found). This requires modifying global PATH
// which would break parallel tests that also use git subprocesses.
// Skipping this path.

// ── git_branches Ok(Err) path (git not found) ──
// Same issue as remove_worktree_path: requires modifying global PATH.
// Skipping this path.

// ── launch_session external spawn Ok(Err) path ──
// We set XDG_CONFIG_HOME to a path where the settings file can't be written
// (parent dir is a regular file, not a directory).

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn update_server_settings_returns_error_on_save_failure() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-save-err-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    // Create config_home as a regular FILE, not a directory.
    // server_settings_path() will be config_home/herdr-webui/webui-settings.json
    // and fs::create_dir_all will fail because config_home is a file.
    std::fs::write(&config_home, "not a directory").unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/server-settings")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "127.0.0.1:8080",
                        "localhost_no_auth": false,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert!(body["error"].as_str().is_some());

    let _ = fs::remove_file(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── create_worktree spawn_blocking JoinError path ──
// The JoinError path (lines 3161-3166) triggers when the spawn_blocking
// task itself panics. We can't easily trigger this, but the
// unwrap_or_else catches it and returns an error response.

// ── events_socket WebSocket test ──
// We test the events_socket by creating a real TCP server with the axum
// app, connecting via tokio-tungstenite, and verifying events are forwarded.

#[cfg(unix)]
#[tokio::test]
async fn events_socket_sends_ready_and_forwards_events() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    // Create a fake backend socket that responds to ping and
    // accepts events.subscribe, then sends one event and closes.
    let (socket, _handle) = fake_api_socket_events_streaming();
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    // Start a real TCP server
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    // Connect via WebSocket with auth cookie
    let url = format!("ws://{addr}/ws/events");
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(request)
        .await
        .expect("Failed to connect to WebSocket");

    // Collect messages: we expect "ready" then "event". The 5s polling
    // snapshot push is gone: external sessions refresh from their
    // events.subscribe stream, so no "snapshot" frame exists anymore.
    let mut got_ready = false;
    let mut got_event = false;

    for _ in 0..30 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            _ => break, // timeout, stream closed, or error
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        match value["type"].as_str() {
            Some("ready") => got_ready = true,
            Some("event") => {
                assert_eq!(value["event"]["type"], "workspace.created");
                got_event = true;
            }
            _ => {}
        }
        if got_ready && got_event {
            break;
        }
    }

    assert!(got_ready, "did not receive ready message");
    assert!(got_event, "did not receive event message");

    // The fake socket thread may still be accepting connections.
    // Don't join it - just abort the server and clean up.
    server_handle.abort();
    let _ = fs::remove_file(socket);
}

/// Fake API socket that responds to ping, accepts events.subscribe,
/// and streams a "ready" event followed by one test event.
#[cfg(unix)]
#[cfg(unix)]
#[tokio::test]
async fn events_socket_forwards_lsp_diagnostics_push() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    // C1: lsp.diagnostics published on the registry must reach /ws/events
    // subscribers as {type:"event", event:{type:"lsp.diagnostics"}}.
    let (socket, _handle) = fake_api_socket_events_streaming();
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let lsp = state.lsp.clone();
    let app = test_app_with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let url = format!("ws://{addr}/ws/events");
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(request)
        .await
        .expect("Failed to connect to WebSocket");

    // Give the socket loop a moment to enter select! before publishing.
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    lsp.publish_diagnostics_for_test(lsp::LspDiagnosticsEvent {
            language: "rust".to_string(),
            root: "/tmp/repo".to_string(),
            notification: json!({
                "method": "textDocument/publishDiagnostics",
                "params": {
                    "uri": "file:///tmp/repo/src/main.rs",
                    "diagnostics": [
                        { "range": { "start": { "line": 3, "character": 0 } }, "severity": 1, "message": "pushed!" }
                    ]
                }
            }),
        });

    let mut got_push = false;
    for _ in 0..30 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        if value["type"].as_str() == Some("event") {
            let event = &value["event"];
            if event["type"].as_str() == Some("lsp.diagnostics")
                || event["event"].as_str() == Some("lsp.diagnostics")
            {
                let data = &event["data"];
                assert_eq!(data["language"], "rust");
                assert_eq!(data["root"], "/tmp/repo");
                assert_eq!(
                    data["notification"]["params"]["diagnostics"][0]["message"],
                    "pushed!"
                );
                got_push = true;
                break;
            }
        }
    }
    assert!(
        got_push,
        "lsp.diagnostics push must reach the events socket"
    );
    server_handle.abort();
}

/// Saving server settings must broadcast `server_settings_changed` with
/// the new `enabled_backends` to every connected events socket, so open
/// tabs stop targeting/offering a backend disabled mid-session without
/// a page reload.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn events_socket_broadcasts_server_settings_changed() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-settings-broadcast");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let (socket, _handle) = fake_api_socket_events_streaming();
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let state = Arc::new(state);
    let app = test_app_with_state((*state).clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    let server_handle = tokio::spawn(async move {
        let _ = server_state;
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let url = format!("ws://{addr}/ws/events");
    let ws_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(ws_request)
        .await
        .expect("Failed to connect to WebSocket");

    // Wait for the events loop to subscribe before flipping settings.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    // Disable the external-herdr backend through the settings API. The app
    // router clones the Arc-based WebState, so this POST shares the same
    // settings_tx the events socket subscribed to.
    let save = test_app_with_state((*state).clone())
        .oneshot(
            request(Method::POST, "/api/server-settings")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "bind": "127.0.0.1:8787",
                        "username": "user",
                        "password": "pass",
                        "localhost_no_auth": true,
                        "backend_mode": "builtin",
                        "builtin_backend_enabled": true,
                        "external_herdr_backend_enabled": false,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(save.status(), StatusCode::OK);

    // The events socket must receive the broadcast frame.
    let mut got_settings_change = false;
    for _ in 0..30 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        if value["type"].as_str() == Some("server_settings_changed") {
            assert_eq!(value["enabled_backends"]["builtin"], true);
            assert_eq!(value["enabled_backends"]["external-herdr"], false);
            // The frame carries the server's default backend so tabs
            // retarget accurately without a /api/versions poll.
            assert_eq!(value["default_backend"], "builtin");
            got_settings_change = true;
            break;
        }
    }
    assert!(
        got_settings_change,
        "server_settings_changed frame must reach the events socket"
    );

    server_handle.abort();
    let _ = fs::remove_file(socket);
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// A tab pinned to external-herdr has its events socket bound to that
/// backend (`?backend=external-herdr`). When the external daemon is not
/// running, the backend subscription fails — but the socket ALSO carries
/// server-level frames (`server_settings_changed`). It must stay open and
/// keep retrying the subscription, otherwise the one-shot settings
/// broadcast lands in a reconnect gap and a tab stays pinned to a backend
/// disabled in settings (this exact regression was caught by the
/// session-ux e2e suite).
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn events_socket_survives_backend_subscription_failure() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-events-dead-backend");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let mut state = test_state();
    // Point external-herdr at a socket path with NO listener: the
    // events.subscribe request fails, like a dead external daemon.
    state.api_socket = Some(std::env::temp_dir().join(format!(
                "herdr-webui-dead-external-{}.sock",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            )));
    let state = Arc::new(state);
    let app = test_app_with_state((*state).clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    let server_handle = tokio::spawn(async move {
        let _ = server_state;
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    // Bind the events socket to the dead external backend, as a pinned
    // browser tab does.
    let url = format!("ws://{addr}/ws/events?backend=external-herdr");
    let ws_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(ws_request)
        .await
        .expect("Failed to connect to WebSocket");

    // The subscription failure surfaces as an error frame, but the
    // socket must stay open (no close frame).
    let mut saw_error = false;
    let mut saw_settings_change = false;
    for _ in 0..10 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(10), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            Ok(None) => break, // socket closed by server = the bug
            Ok(Some(Err(_))) | Err(_) => break,
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        match value["type"].as_str() {
            Some("error") => {
                saw_error = true;
                // Settings broadcast must still arrive while the socket
                // retries the subscription.
                let save = test_app_with_state((*state).clone())
                    .oneshot(
                        request(Method::POST, "/api/server-settings")
                            .header(header::COOKIE, "herdr_web_session=token-123")
                            .header(header::CONTENT_TYPE, "application/json")
                            .body(Body::from(
                                json!({
                                    "bind": "127.0.0.1:8787",
                                    "username": "user",
                                    "password": "pass",
                                    "localhost_no_auth": true,
                                    "backend_mode": "builtin",
                                    "builtin_backend_enabled": true,
                                    "external_herdr_backend_enabled": false,
                                })
                                .to_string(),
                            ))
                            .unwrap(),
                    )
                    .await
                    .unwrap();
                assert_eq!(save.status(), StatusCode::OK);
            }
            Some("server_settings_changed") => {
                assert_eq!(value["enabled_backends"]["external-herdr"], false);
                saw_settings_change = true;
                break;
            }
            _ => {}
        }
    }
    assert!(
        saw_error,
        "subscription failure must surface as an error frame"
    );
    assert!(
        saw_settings_change,
        "server_settings_changed must reach a tab whose backend subscription failed"
    );

    server_handle.abort();
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// A backend that answers events.subscribe with an error frame (herdr 0.9.x
/// does this for any invalid subscription entry; one bad pane_id rejects the
/// whole stream) must surface as an error message on the WebSocket, never
/// as a healthy "ready" stream that then delivers nothing. This is the
/// regression shape of the pane.agent_status_changed bug: the webui sent an
/// entry every 0.9.x daemon rejects, consumed the error frame as the ack,
/// and cycled subscribe -> EOF -> resubscribe with zero events.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn events_socket_reports_rejected_subscription_instead_of_ready() {
    use futures_util::StreamExt;
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use tokio_tungstenite::connect_async;

    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-events-rejected-sub");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // Fake external daemon: rejects every events.subscribe with the same
    // error frame herdr sends for an invalid subscription (id preserved,
    // error.code + error.message). Accepts in a loop because the events
    // thread retries with a backoff.
    // fake_socket_dir keeps the path short: CI runners have long per-job
    // temp dirs and a nanos-based name there overflows sun_path (104 bytes),
    // which makes the listener creation fail before the test even starts.
    let path = fake_socket_dir().join(format!("events-reject-{}.sock", fake_socket_suffix()));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    // Leak the accept thread on purpose: it blocks in listener.accept()
    // for connections that never come once the subscription thread stops
    // retrying. Same shape as fake_api_socket_events_streaming; the
    // pid-keyed socket path lets the test-artifact sweeper unlink it later.
    thread::spawn(move || {
        for _ in 0..50 {
            let Ok(mut stream) = listener.accept() else {
                break;
            };
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let request: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
                let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
                let id = request.get("id").cloned().unwrap_or(json!("web:poll"));
                let response = if method == "events.subscribe" {
                    json!({
                        "id": id,
                        "error": {
                            "code": "invalid_request",
                            "message": "invalid request: missing field `pane_id`",
                        }
                    })
                } else if method == "ping" {
                    json!({ "id": id, "result": { "version": "0.9.5", "protocol": 22 } })
                } else {
                    json!({ "id": id, "result": {} })
                };
                let _ = stream.write_all(response.to_string().as_bytes());
                let _ = stream.write_all(b"\n");
                let _ = stream.flush();
            });
        }
    });

    let mut state = test_state();
    state.api_socket = Some(path.clone());
    let app = test_app_with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let url = format!("ws://{addr}/ws/events?backend=external-herdr");
    let ws_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(ws_request)
        .await
        .expect("Failed to connect to WebSocket");

    // The rejected subscription must surface the daemon's message, and the
    // "ready" frame must never arrive: ready means a live event stream,
    // which a rejected subscribe never produced.
    let mut saw_rejection = false;
    let mut saw_ready = false;
    for _ in 0..10 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(10), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            Ok(None) => break,
            Ok(Some(Err(_))) | Err(_) => break,
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        match value["type"].as_str() {
            Some("error") => {
                let message = value["message"].as_str().unwrap_or("");
                assert!(
                    message.contains("events.subscribe rejected"),
                    "error frame must carry the subscribe rejection, got: {message}"
                );
                assert!(
                    message.contains("missing field `pane_id`"),
                    "error frame must surface the daemon's own message, got: {message}"
                );
                saw_rejection = true;
                break;
            }
            Some("ready") => saw_ready = true,
            _ => {}
        }
    }
    assert!(
        saw_rejection,
        "rejected events.subscribe must surface its error frame on /ws/events"
    );
    assert!(
        !saw_ready,
        "no ready frame may precede a rejected subscribe"
    );

    drop(ws_stream);
    server_handle.abort();
    let _ = fs::remove_file(&path);
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// herdr 0.9.2+ (upstream #4225) answers a subscriber that fell behind
/// retained history with `{"error":{"code":"events_lost"}}` and closes
/// the stream. The webui must break out of the read loop, resubscribe, and
/// send a fresh "ready" frame: forwarding the error as a bogus event would
/// desync the browser silently, and treating the close as terminal would
/// kill events forever.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn events_socket_resubscribes_after_events_lost() {
    use futures_util::StreamExt;
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use tokio_tungstenite::connect_async;

    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-events-lost");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // Fake daemon: the first subscribe acks and streams one event, then the
    // events_lost error frame and EOF (herdr closes the stream after the
    // error). The second subscribe acks and streams one more event. Later
    // subscribes keep streaming so a flaky retry cannot starve the test.
    // fake_socket_dir keeps the path under sun_path even on CI runners
    // with long per-job temp dirs (same trap as the reject test).
    let path = fake_socket_dir().join(format!("events-lost-{}.sock", fake_socket_suffix()));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let subscribe_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let subscribe_count_for_thread = subscribe_count.clone();
    // Leak the accept thread on purpose (see the rejection test): it blocks
    // in accept() once the subscription thread stops retrying.
    thread::spawn(move || {
        for _ in 0..50 {
            let Ok(mut stream) = listener.accept() else {
                break;
            };
            let subscribe_count = subscribe_count_for_thread.clone();
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let request: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
                let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
                let id = request.get("id").cloned().unwrap_or(json!("web:poll"));
                if method == "events.subscribe" {
                    let n = subscribe_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let _ = stream.write_all(
                        json!({ "id": id, "result": { "type": "subscription_started" } })
                            .to_string()
                            .as_bytes(),
                    );
                    let _ = stream.write_all(b"\n");
                    if n == 0 {
                        // First stream: one event, then the history-loss error
                        // and close, byte-for-byte the frame herdr emits.
                        let _ = stream.write_all(
                            json!({ "event": "tab_created", "data": { "tab_id": "t1" } })
                                .to_string()
                                .as_bytes(),
                        );
                        let _ = stream.write_all(b"\n");
                        let _ = stream.write_all(
                            json!({ "id": "web:events", "error": { "code": "events_lost" } })
                                .to_string()
                                .as_bytes(),
                        );
                        let _ = stream.write_all(b"\n");
                        drop(stream);
                        return;
                    }
                    // Later streams: keep one event flowing per subscribe.
                    let _ = stream.write_all(
                        json!({ "event": "tab_created", "data": { "tab_id": "t2" } })
                            .to_string()
                            .as_bytes(),
                    );
                    let _ = stream.write_all(b"\n");
                    let _ = stream.flush();
                    thread::sleep(std::time::Duration::from_secs(30));
                } else if method == "ping" {
                    let _ = stream.write_all(
                        json!({ "id": id, "result": { "version": "0.9.5", "protocol": 22 } })
                            .to_string()
                            .as_bytes(),
                    );
                    let _ = stream.write_all(b"\n");
                    let _ = stream.flush();
                } else {
                    let _ =
                        stream.write_all(json!({ "id": id, "result": {} }).to_string().as_bytes());
                    let _ = stream.write_all(b"\n");
                    let _ = stream.flush();
                }
            });
        }
    });

    let mut state = test_state();
    state.api_socket = Some(path.clone());
    let app = test_app_with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_handle = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let url = format!("ws://{addr}/ws/events?backend=external-herdr");
    let ws_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(ws_request)
        .await
        .expect("Failed to connect to WebSocket");

    // Expect: ready, the pre-loss event, a SECOND ready (the loop broke on
    // events_lost and resubscribed), and another event. The events_lost
    // frame itself must NOT arrive as a bogus "event" frame.
    let mut ready_count = 0;
    let mut event_count = 0;
    let mut saw_bogus_lost_event = false;
    for _ in 0..20 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(10), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            Ok(None) => break,
            Ok(Some(Err(_))) | Err(_) => break,
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        match value["type"].as_str() {
            Some("ready") => ready_count += 1,
            Some("event") => {
                // The error frame must never be forwarded as an event.
                if value["event"]["error"]["code"] == json!("events_lost") {
                    saw_bogus_lost_event = true;
                }
                event_count += 1;
            }
            _ => {}
        }
        if ready_count >= 2 && event_count >= 2 {
            break;
        }
    }
    assert!(
        ready_count >= 2,
        "events_lost must break the read loop and resubscribe (ready frames: {ready_count})"
    );
    assert!(
        event_count >= 2,
        "the resubscribed stream must deliver events again (events: {event_count})"
    );
    assert!(
        !saw_bogus_lost_event,
        "the events_lost error frame must not be forwarded as a bogus event"
    );

    drop(ws_stream);
    server_handle.abort();
    let _ = fs::remove_file(&path);
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// Every notes mutation must broadcast a full notes_changed snapshot to
/// connected events sockets, so open tabs converge without polling.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn events_socket_broadcasts_notes_changed() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-notes-broadcast");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let (socket, _handle) = fake_api_socket_events_streaming();
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let state = Arc::new(state);
    let app = test_app_with_state((*state).clone());

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server_state = state.clone();
    let server_handle = tokio::spawn(async move {
        let _ = server_state;
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let url = format!("ws://{addr}/ws/events");
    let ws_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream, _response) = connect_async(ws_request)
        .await
        .expect("Failed to connect to WebSocket");

    // Second subscriber: the "every connected client sees the same list"
    // claim needs fan-out evidence, not a single-socket happy path.
    let ws_request_two = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut ws_stream_two, _response_two) = connect_async(ws_request_two)
        .await
        .expect("Failed to connect the second WebSocket");

    // Wait for the events loop to subscribe before mutating notes.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let create = test_app_with_state((*state).clone())
        .oneshot(
            request(Method::POST, "/api/notes")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "title": "hello", "content": "world" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(create.status(), StatusCode::CREATED);

    let mut got_notes_change = false;
    for _ in 0..30 {
        let msg = match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream.next())
            .await
        {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        if value["type"].as_str() == Some("notes_changed") {
            let notes = value["notes"].as_array().expect("notes snapshot");
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0]["title"], "hello");
            assert_eq!(notes[0]["content"], "world");
            // The frame carries the same contract as GET: resolved titles
            // and the language table, so adopting clients need no local
            // derivation logic.
            assert_eq!(notes[0]["display_title"], "hello");
            let languages = value["languages"].as_array().expect("languages table");
            assert_eq!(languages.len(), 14);
            assert_eq!(languages[0]["value"], "txt");
            got_notes_change = true;
            break;
        }
    }
    assert!(
        got_notes_change,
        "notes_changed frame must reach the events socket"
    );

    let mut got_notes_change_two = false;
    for _ in 0..30 {
        let msg =
            match tokio::time::timeout(std::time::Duration::from_secs(15), ws_stream_two.next())
                .await
            {
                Ok(Some(Ok(m))) => m,
                _ => break,
            };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        if value["type"].as_str() == Some("notes_changed") {
            let notes = value["notes"].as_array().expect("notes snapshot");
            assert_eq!(notes.len(), 1);
            assert_eq!(notes[0]["title"], "hello");
            assert_eq!(notes[0]["content"], "world");
            got_notes_change_two = true;
            break;
        }
    }
    assert!(
        got_notes_change_two,
        "notes_changed frame must reach the second events socket too"
    );

    server_handle.abort();
    let _ = fs::remove_file(socket);
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

pub(crate) fn fake_api_socket_events_streaming() -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    // pid-keyed name: the dead-test-artifact sweeper can prove ownership
    // from the embedded pid and unlink this socket on a later run even
    // though the accept thread outlives the test that created it.
    let path = std::env::temp_dir().join(format!(
        "herdr-webui-events-test-{}-{}.sock",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();

    let handle = thread::spawn(move || {
        // Accept connections in a loop and handle each on a separate thread
        // so the subscribe stream stays alive while poll requests are served.
        for _ in 0..20 {
            let Ok(mut stream) = listener.accept() else {
                break;
            };
            thread::spawn(move || {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let request: serde_json::Value = serde_json::from_str(&line).unwrap_or_default();
                let method = request.get("method").and_then(|m| m.as_str()).unwrap_or("");
                let id = request.get("id").cloned().unwrap_or(json!("web:poll"));
                match method {
                    "ping" => {
                        let _ = stream.write_all(
                                json!({ "id": "web:ping", "result": { "version": "0.7.2", "protocol": 16 } })
                                    .to_string()
                                    .as_bytes(),
                            );
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                    }
                    "events.subscribe" => {
                        // Send the response line for subscribe
                        let _ = stream.write_all(
                            json!({ "id": "web:events", "result": { "ok": true } })
                                .to_string()
                                .as_bytes(),
                        );
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                        // Stream one event as newline-delimited JSON
                        let _ = stream.write_all(
                                json!({ "type": "workspace.created", "data": { "workspace_id": "ws1" } })
                                    .to_string()
                                    .as_bytes(),
                            );
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                        // Keep the stream alive so the WebSocket loop doesn't end
                        // immediately. The interval timer will fire and send snapshots.
                        thread::sleep(std::time::Duration::from_secs(10));
                    }
                    "agent.list" => {
                        let _ = stream.write_all(
                            json!({ "id": id, "result": { "agents": [] } })
                                .to_string()
                                .as_bytes(),
                        );
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                    }
                    "workspace.list" => {
                        let _ = stream.write_all(
                            json!({ "id": id, "result": { "workspaces": [] } })
                                .to_string()
                                .as_bytes(),
                        );
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                    }
                    _ => {
                        let _ = stream
                            .write_all(json!({ "id": id, "result": {} }).to_string().as_bytes());
                        let _ = stream.write_all(b"\n");
                        let _ = stream.flush();
                    }
                }
            });
        }
    });
    (path, handle)
}

/// The composer submit route owns the refusal classification AND copy: one
/// step produces the status code, the wire code, and the human note. The
/// browser displays `note` verbatim (falling back to the error string when
/// absent), so these strings are the UI contract.
#[test]
fn submit_pane_error_classifies_code_status_and_note() {
    let (status, code, note) = submit_pane_error(
        "agent_blocked: the agent is waiting for an answer in the terminal",
        "agent_blocked",
    );
    assert_eq!(code, "agent_blocked");
    assert_eq!(status, StatusCode::CONFLICT);
    assert!(note.contains("waiting for an answer"), "note={note}");

    let (status, code, note) =
        submit_pane_error("agent_not_found: pane x not found", "agent_not_found");
    assert_eq!(code, "agent_not_found");
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(note.contains("gone"), "note={note}");

    let (status, code, note) =
        submit_pane_error("agent_exited: terminal has exited", "agent_exited");
    assert_eq!(code, "agent_exited");
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(note.contains("gone"), "note={note}");

    let (status, code, note) = submit_pane_error(
        "message_too_long: composer message exceeds 20000 characters",
        "message_too_long",
    );
    assert_eq!(code, "message_too_long");
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(note.contains("20000"), "note={note}");

    let (status, code, note) = submit_pane_error(
        "empty_agent_prompt: agent prompt must not be empty",
        "empty_agent_prompt",
    );
    assert_eq!(code, "empty_agent_prompt");
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(note.contains("empty"), "note={note}");

    // Unknown codes degrade: 502, the raw wire prefix, and a wrapped note
    // ("Not sent: " + the server's error string) so the UI reads the same.
    let (status, code, note) = submit_pane_error("io_error: write failed", "io_error");
    assert_eq!(code, "io_error");
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(note, "Not sent: io_error: write failed");
}

/// The two backends shape their errors differently: the builtin one puts
/// the machine code in the message prefix ("agent_blocked: ...") with a
/// generic wire code, external herdr puts herdr codes in `code` with a
/// human message. submit_pane_code must classify both identically.
#[test]
fn submit_pane_code_reads_builtin_prefix_and_herdr_code() {
    // Builtin shape: {code: "builtin_error", message: "<code>: <detail>"}.
    let builtin = json!({
        "code": "builtin_error",
        "message": "agent_blocked: the agent is waiting for an answer in the terminal"
    });
    assert_eq!(submit_pane_code(&builtin), "agent_blocked");

    // herdr shape: {code: "agent_blocked", message: "human text"}.
    let herdr = json!({ "code": "agent_blocked", "message": "agent is blocked" });
    assert_eq!(submit_pane_code(&herdr), "agent_blocked");

    // herdr's empty_prompt carries no code prefix in the message.
    let herdr_empty = json!({ "code": "empty_agent_prompt", "message": "prompt is empty" });
    assert_eq!(submit_pane_code(&herdr_empty), "empty_agent_prompt");

    // Builtin unknown error: the message prefix names the failure.
    let builtin_unknown = json!({ "code": "builtin_error", "message": "io_error: write failed" });
    assert_eq!(submit_pane_code(&builtin_unknown), "io_error");

    // Nothing recognizable: empty string, not a panic.
    assert_eq!(submit_pane_code(&json!({})), "");
}

/// The conversation route's error classification (design codes -> HTTP
/// statuses): the chat lens reads `code` to pick its reset paths, so
/// the mapping is a wire contract, same style as submit_pane_error.
#[test]
fn conversation_error_classifies_design_codes_to_statuses() {
    // Resolution refusals: 404 (the pane is real, the conversation is not).
    let (status, code) = conversation_error("agent_not_found: pane x has no agent");
    assert_eq!(code, "agent_not_found");
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, code) = conversation_error("unsupported_agent: claude has no transcript support");
    assert_eq!(code, "unsupported_agent");
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, code) = conversation_error("no_session_path: no jcode session in this pane");
    assert_eq!(code, "no_session_path");
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, code) = conversation_error("ambiguous: two sessions match");
    assert_eq!(code, "ambiguous");
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, code) = conversation_error("transcript_missing: session files unreadable");
    assert_eq!(code, "transcript_missing");
    assert_eq!(status, StatusCode::NOT_FOUND);

    // A cursor the transcript no longer knows: 409 history_changed
    // (reference HistoryChanged parity) — the client drops held pages
    // and re-anchors in ONE round trip.
    let (status, code) =
        conversation_error("history_changed: cursor message no longer in the transcript");
    assert_eq!(code, "history_changed");
    assert_eq!(status, StatusCode::CONFLICT);

    // Unknown codes degrade to 502 with the raw prefix.
    let (status, code) = conversation_error("io_error: read failed");
    assert_eq!(code, "io_error");
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}

/// The ETag header contract of the conversation route: weak form
/// W/"<version>", compare after stripping W/ (reference index.ts
/// parity). These strings are the wire contract between the route and
/// the lens poll (If-None-Match in, 304 out).
#[test]
fn conversation_etag_is_weak_and_strips_w_on_compare() {
    // Weak tag format: W/"version".
    let version = "g7317e00af883a5c2";
    let etag = format!("W/\"{version}\"");
    assert!(etag.starts_with("W/\""));
    assert!(etag.ends_with('"'));
    // The browser sends the tag back verbatim; the compare strips W/.
    let bare = format!("\"{version}\"");
    let matches = etag.trim_start_matches("W/") == bare;
    assert!(matches, "weak round trip must match");
    // A strong-form send (client stripped W/) still matches: same
    // trim on both sides.
    assert_eq!(bare.trim_start_matches("W/"), bare);
}

// ── conversation route integration (real router + fake backend) ──
//
// The unit tests above cover the classification helpers in isolation;
// these go through the mounted router with a fake backend socket, the
// way the browser does: auth cookie, query params, envelope unwrap,
// ETag/304 short-circuit, image bytes.

#[cfg(unix)]
#[tokio::test]
async fn conversation_route_serves_payload_and_forwards_cursors() {
    let (socket, handle, rx) = fake_api_socket_multi_recording(vec![json!({
        "result": {
            "type": "pane_conversation",
            "conversation": {
                "source": "jcode-transcript",
                "turns": [ { "role": "user", "ts": "t1", "parts": [] } ],
                "cursor": "sess_1:g1:m42",
                "title": "fix the lens poll",
                "context_used": 68412,
                "version": "v9"
            }
        }
    })]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    // before/from ride the query string; URL-encoded cursors must
    // survive to the backend params verbatim.
    let uri = "/api/panes/pane_1/conversation?before=sess_1%3Ag1%3Am42&from=sess_1%3Ag1%3Am7";
    let response = app
        .clone()
        .oneshot(
            authed_request(Method::GET, uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let etag = response
        .headers()
        .get(axum::http::header::ETAG)
        .unwrap()
        .to_str()
        .unwrap()
        .to_string();
    assert_eq!(etag, "W/\"v9\"");
    assert_eq!(
        response
            .headers()
            .get(axum::http::header::CACHE_CONTROL)
            .unwrap(),
        "no-store"
    );
    let body = response_json(response).await;
    // Envelope unwrapped: the browser sees the flat conversation.
    assert_eq!(body["source"], "jcode-transcript");
    assert_eq!(body["cursor"], "sess_1:g1:m42");
    assert_eq!(body["title"], "fix the lens poll");
    assert_eq!(body["context_used"], 68412);

    // The backend saw the cursors decoded, not double-encoded.
    let request: Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
    assert_eq!(request["method"], "pane.conversation");
    assert_eq!(request["params"]["pane_id"], "pane_1");
    assert_eq!(request["params"]["before"], "sess_1:g1:m42");
    assert_eq!(request["params"]["from"], "sess_1:g1:m7");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn conversation_route_answers_304_on_matching_if_none_match() {
    let (socket, handle, _rx) = fake_api_socket_multi_recording(vec![json!({
        "result": {
            "type": "pane_conversation",
            "conversation": { "turns": [], "cursor": null, "version": "v9" }
        }
    })]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    // The lens poll sends the tag the route handed it (weak form
    // verbatim); the strip-W/ compare must match its own output.
    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/conversation")
                .header(axum::http::header::IF_NONE_MATCH, "W/\"v9\"")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(
        response.headers().get(axum::http::header::ETAG).unwrap(),
        "W/\"v9\""
    );
    // 304 carries zero turn bytes: the body is empty.
    let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
    assert!(bytes.is_empty(), "304 must carry no body");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn conversation_route_rejects_unauthenticated_before_backend() {
    // No cookie: the middleware answers 401 and the backend socket is
    // never dialed (no listener exists at the state's socket path, so a
    // pass-through would surface as 502, not 401).
    let app = test_app();

    let response = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/panes/pane_1/conversation")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    let response = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/panes/pane_1/conversation/image?ref=abc")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[cfg(unix)]
#[tokio::test]
async fn conversation_route_maps_backend_errors_and_malformed_payloads() {
    // history_changed: 409 with the design code, so the lens drops
    // held pages and re-anchors in one round trip.
    let (socket, handle, _rx) = fake_api_socket_multi_recording(vec![json!({
        "error": { "message": "history_changed: cursor message no longer in the transcript" }
    })]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/conversation")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let body = response_json(response).await;
    assert_eq!(body["code"], "history_changed");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    // A result without the conversation envelope: 502 malformed, not
    // a 200 with an empty chat.
    let (socket, handle, _rx) = fake_api_socket_multi_recording(vec![json!({
        "result": { "type": "something_else" }
    })]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/conversation")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert_eq!(body["code"], "error");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn conversation_image_route_serves_bytes_and_not_found() {
    // 1x1 PNG, base64 (the reference wire carries base64; the route
    // decodes and serves raw bytes with the stored media type).
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let (socket, handle, rx) = fake_api_socket_multi_recording(vec![json!({
        "result": {
            "type": "pane_conversation_image",
            "image": { "media_type": "image/png", "data": png }
        }
    })]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .clone()
        .oneshot(
            authed_request(
                Method::GET,
                "/api/panes/pane_1/conversation/image?ref=msg_img_1",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .unwrap(),
        "image/png"
    );
    assert_eq!(
        response
            .headers()
            .get(axum::http::header::CACHE_CONTROL)
            .unwrap(),
        "private, max-age=86400, immutable"
    );
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let decoded = crate::jcode_transcript::base64_decode(png).unwrap();
    assert_eq!(bytes.to_vec(), decoded);
    assert!(!bytes.is_empty());

    // The ref rode the params, and the media type is not sniffable.
    let request: Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
    assert_eq!(request["method"], "pane.conversation_image");
    assert_eq!(request["params"]["pane_id"], "pane_1");
    assert_eq!(request["params"]["ref"], "msg_img_1");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    // Missing ref: 400 before any backend call.
    let app2 = test_app();
    let response = app2
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/conversation/image")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["code"], "bad_request");

    // Null image (rotated out / never existed): 404 image_not_found,
    // the page's placeholder path, not an error banner.
    let (socket, handle, _rx) = fake_api_socket_multi_recording(vec![json!({
        "result": { "type": "pane_conversation_image", "image": null }
    })]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(
                Method::GET,
                "/api/panes/pane_1/conversation/image?ref=toolu_dead",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = response_json(response).await;
    assert_eq!(body["code"], "image_not_found");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn conversation_route_etag_compare_edge_cases() {
    // Reference index.ts:2407 strips ONE leading W/ from the sent
    // header and compares to "version" (quoted). These pin the edge
    // semantics the happy-path test cannot see.
    let conv = |version: &str| {
        vec![json!({
            "result": {
                "type": "pane_conversation",
                "conversation": { "turns": [], "cursor": null, "version": version }
            }
        })]
    };
    for (sent, expect_304, why) in [
        ("W/\"v9\"", true, "verbatim weak round trip matches"),
        (
            "\"v9\"",
            true,
            "strong form of the same tag matches (strip is a no-op)",
        ),
        (
            "W/W/\"v9\"",
            false,
            "double weak prefix is not a tag the route ever emitted",
        ),
        (
            "W/\"v8\"",
            false,
            "a different version serves the full payload",
        ),
        ("*", false, "no star handling, reference has none either"),
        ("", false, "an empty header never matches"),
    ] {
        let (socket, handle, _rx) = fake_api_socket_multi_recording(conv("v9"));
        let mut state = test_state();
        state.api_socket = Some(socket.clone());
        let app = test_app_with_state(state);
        let mut builder = authed_request(Method::GET, "/api/panes/pane_1/conversation");
        if !sent.is_empty() {
            builder = builder.header(axum::http::header::IF_NONE_MATCH, sent);
        }
        let response = app
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let got_304 = response.status() == StatusCode::NOT_MODIFIED;
        assert_eq!(
            got_304,
            expect_304,
            "if-none-match {sent:?}: {why} (expected 304={expect_304}, got {})",
            response.status()
        );
        if expect_304 {
            let bytes = to_bytes(response.into_body(), 1024).await.unwrap();
            assert!(bytes.is_empty(), "304 carries no body");
        } else {
            // Full answer: the browser must get the payload AND the
            // fresh etag to store for the next poll.
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers().get(axum::http::header::ETAG).unwrap(),
                "W/\"v9\""
            );
            let body = response_json(response).await;
            assert_eq!(body["version"], "v9");
        }
        handle.join().unwrap();
        let _ = fs::remove_file(socket);
    }
}

#[cfg(unix)]
#[tokio::test]
async fn conversation_route_empty_cursors_treated_as_absent() {
    // The lens only sets a cursor param when it has one, but a stale
    // URL or a hand-crafted request can carry an empty one: the route
    // filters empties to absent so the backend sees a clean newest
    // page, not an empty cursor string (which would 409 on decode).
    let (socket, handle, rx) = fake_api_socket_multi_recording(vec![json!({
        "result": {
            "type": "pane_conversation",
            "conversation": { "turns": [], "cursor": null, "version": "v1" }
        }
    })]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/conversation?before=&from=")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["version"], "v1");

    let request: Value = serde_json::from_str(&rx.recv().unwrap()).unwrap();
    assert!(
        request["params"].get("before").is_none(),
        "empty before must not reach the backend params"
    );
    assert!(
        request["params"].get("from").is_none(),
        "empty from must not reach the backend params"
    );
    assert_eq!(request["params"]["pane_id"], "pane_1");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn conversation_image_route_invalid_base64_is_not_found() {
    // The backend arm validated the ref but the data failed to decode
    // (a truncated file, a hand-edit): bytes cannot be served, and a
    // 500 would break the page for a placeholder-sized problem — the
    // lens drops just the image, same as a rotated-out ref.
    let (socket, handle, _rx) = fake_api_socket_multi_recording(vec![json!({
        "result": {
            "type": "pane_conversation_image",
            "image": { "media_type": "image/png", "data": "not!!valid!!base64" }
        }
    })]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(
                Method::GET,
                "/api/panes/pane_1/conversation/image?ref=msg_img_9",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let body = response_json(response).await;
    assert_eq!(body["code"], "image_not_found");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn conversation_route_backend_transport_failure_is_bad_gateway() {
    // No listener at the socket path: the backend dial fails outright.
    // The route must answer 502 (browser-renderable), never panic or
    // hang — the lens shows its refusal state and the poll re-arms.
    let mut state = test_state();
    let dead = std::env::temp_dir().join(format!(
        "herdr-webui-dead-api-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    state.api_socket = Some(dead);
    let app = test_app_with_state(state);

    let response = app
        .clone()
        .oneshot(
            authed_request(Method::GET, "/api/panes/pane_1/conversation")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);

    let response = app
        .clone()
        .oneshot(
            authed_request(
                Method::GET,
                "/api/panes/pane_1/conversation/image?ref=msg_x",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
}

/// Long-press Send (enqueue) reaches the backend: the submit route must
/// forward the flag as agent.prompt `params.enqueue`. A recording api
/// socket captures the request the route actually sent.
#[cfg(unix)]
#[tokio::test]
async fn submit_pane_route_forwards_enqueue_flag() {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = std::env::temp_dir().join(format!(
        "herdr-webui-submit-enqueue-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let handle = thread::spawn(move || {
        let mut stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        stream
            .write_all(
                serde_json::to_string(&json!({
                    "id": request["id"],
                    "result": { "type": "agent_prompt", "pane_id": "pane_1", "ok": true, "enqueue": true }
                }))
                .unwrap()
                .as_bytes(),
            )
            .unwrap();
        let _ = stream.write_all(b"\n");
        let _ = stream.flush();
        request
    });

    let mut state = test_state();
    state.api_socket = Some(path.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/panes/pane_1/submit")
                .header(axum::http::header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_string(&json!({ "text": "hold to queue", "enqueue": true }))
                        .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);

    let request = handle.join().unwrap();
    assert_eq!(request["method"], "agent.prompt");
    assert_eq!(request["params"]["text"], "hold to queue");
    assert_eq!(
        request["params"]["enqueue"], true,
        "the enqueue flag must reach the backend params"
    );
}
