// Route-level contract tests for the shared panes store
// (workspace_panes_store.rs): ops over HTTP, sidecar persistence, the
// seed-overwrite apply rule, and the per-session broadcast fanout.
// Mirrors the notes contract tests (notes_list_contract_is_server_owned,
// events_socket_broadcasts_notes_changed).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Method, StatusCode};
use serde_json::json;
use tower::ServiceExt;

use crate::tests::{
    lock_env, request, response_json, temp_guard, test_app, test_app_with_state, test_state,
};

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn panes_op_contract_creates_groups_and_persists() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-panes-contract");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let app = test_app();
    let cookie = "herdr_web_session=token-123";

    // GET returns the seed: one panel, no groups.
    let response = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/workspace-panes")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let seed = response_json(response).await;
    assert_eq!(seed["session"], "default");
    assert_eq!(seed["panels"].as_array().unwrap().len(), 1);
    assert_eq!(seed["panels"][0]["paneId"], "p1");

    // Create two panels so a group can form.
    let mut created = 0;
    for _ in 0..2 {
        let op = app
            .clone()
            .oneshot(
                request(Method::POST, "/api/workspace-panes/op")
                    .header(header::COOKIE, cookie)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "op": "panel.create", "wsId": "ws_1" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(op.status(), StatusCode::OK);
        created += 1;
    }
    assert_eq!(created, 2);

    // Group p2 with p3 (auto-join picks the right neighbor).
    let group = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/workspace-panes/op")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "op": "group.create",
                        "paneId": "p2",
                        "axis": "row",
                        "draggedFirst": true
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(group.status(), StatusCode::OK);
    let grouped = response_json(group).await;
    assert_eq!(grouped["groups"].as_array().unwrap().len(), 1);
    assert_eq!(grouped["groups"][0]["memberIds"], json!(["p2", "p3"]));
    assert_eq!(grouped["groups"][0]["groupId"], "g1");
    assert_eq!(grouped["visible"]["type"], "group");
    assert_eq!(grouped["visible"]["id"], "g1");

    // Rename the group; the name rides the record.
    let rename = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/workspace-panes/op")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "op": "group.rename", "groupId": "g1", "name": "demo" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rename.status(), StatusCode::OK);
    let renamed = response_json(rename).await;
    assert_eq!(renamed["groups"][0]["name"], "demo");

    // A fresh store over the same sidecar (reboot shape) restores the
    // group, the name, and the membership.
    let mut state = test_state();
    state.panes_store = crate::workspace_panes_store::PanesStore::new();
    let rebooted = test_app_with_state(state);
    let response = rebooted
        .oneshot(
            request(Method::GET, "/api/workspace-panes")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let restored = response_json(response).await;
    assert_eq!(restored["groups"][0]["groupId"], "g1");
    assert_eq!(restored["groups"][0]["name"], "demo");
    assert_eq!(restored["groups"][0]["memberIds"], json!(["p2", "p3"]));
    assert_eq!(restored["panels"].as_array().unwrap().len(), 3);

    std::env::remove_var("XDG_CONFIG_HOME");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn panes_apply_seed_never_overwrites_real_content() {
    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-panes-apply");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let cookie = "herdr_web_session=token-123";

    // Real content first: a panel holding a tab.
    let app = test_app();
    let real_entry = json!({
        "v": 3,
        "panels": [ { "paneId": "p1", "tabs": ["tab_9"], "active": "tab_9", "wsId": "ws_1", "groupId": null } ],
        "groups": [],
        "visible": { "type": "panel", "id": "p1" }
    });
    let apply = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/workspace-panes")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "entry": real_entry }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(apply.status(), StatusCode::OK);

    // A second client POSTs the untouched seed: it must NOT clobber the
    // stored entry.
    let seed_entry = json!({
        "v": 3,
        "panels": [ { "paneId": "p1", "tabs": [], "active": null, "wsId": null, "groupId": null } ],
        "groups": [],
        "visible": { "type": "panel", "id": "p1" }
    });
    let clobber = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/workspace-panes")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "entry": seed_entry }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(clobber.status(), StatusCode::OK);
    let after = response_json(clobber).await;
    assert_eq!(
        after["panels"][0]["tabs"],
        json!(["tab_9"]),
        "the seed must never overwrite real content"
    );

    // Unknown ops and unknown panels are refused.
    let bad_op = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/workspace-panes/op")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "op": "nonsense" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bad_op.status(), StatusCode::BAD_REQUEST);
    let bad_panel = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/workspace-panes/op")
                .header(header::COOKIE, cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "op": "panel.rename", "paneId": "nope", "name": "x" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bad_panel.status(), StatusCode::NOT_FOUND);

    // Unauthorized without the session cookie.
    let response = app
        .oneshot(
            request(Method::GET, "/api/workspace-panes")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);

    std::env::remove_var("XDG_CONFIG_HOME");
}

#[tokio::test]
#[allow(clippy::await_holding_lock)]
async fn panes_ops_broadcast_per_session() {
    use futures_util::StreamExt;
    use tokio_tungstenite::connect_async;

    let _guard = lock_env();
    let (config_home, _config_guard) = temp_guard("herdr-webui-panes-broadcast");
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let (socket, _handle) = crate::tests::fake_api_socket_events_streaming();
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let state = Arc::new(state);
    let app = test_app_with_state((*state).clone());

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

    // Two sockets on the SAME session: both must see the panes frame.
    let url = format!("ws://{addr}/ws/events?session=alpha");
    let mut streams = Vec::new();
    for _ in 0..2 {
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
        let (ws_stream, _response) = connect_async(ws_request)
            .await
            .expect("Failed to connect to WebSocket");
        streams.push(ws_stream);
    }
    // One socket on ANOTHER session: it must NOT see the alpha frame.
    let other_url = format!("ws://{addr}/ws/events?session=beta");
    let other_request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&other_url)
        .header("cookie", "herdr_web_session=token-123")
        .header("host", addr.to_string())
        .header("connection", "Upgrade")
        .header("upgrade", "websocket")
        .header("sec-websocket-version", "13")
        .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
        .body(())
        .unwrap();
    let (mut other_stream, _other_response) = connect_async(other_request)
        .await
        .expect("Failed to connect the other-session WebSocket");

    // Wait for the events loops to subscribe before mutating.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    let op = test_app_with_state((*state).clone())
        .oneshot(
            request(Method::POST, "/api/workspace-panes/op")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header("x-herdr-session", "alpha")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "op": "panel.create", "wsId": "ws_1" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(op.status(), StatusCode::OK);

    for stream in streams.iter_mut() {
        let mut got_frame = false;
        for _ in 0..30 {
            let msg = match tokio::time::timeout(std::time::Duration::from_secs(15), stream.next())
                .await
            {
                Ok(Some(Ok(m))) => m,
                _ => break,
            };
            let text = msg.to_text().expect("expected text message");
            let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
            if value["type"].as_str() == Some("workspace_panes_changed") {
                assert_eq!(value["session"], "alpha", "frame names its session");
                let panels = value["panels"].as_array().expect("panels array");
                assert!(
                    panels.len() >= 2,
                    "the op result rides the broadcast, not just the HTTP response"
                );
                got_frame = true;
                break;
            }
        }
        assert!(
            got_frame,
            "workspace_panes_changed frame must reach every same-session socket"
        );
    }

    // The other session must stay silent on panes frames for a while.
    let mut leaked = false;
    for _ in 0..10 {
        let msg =
            match tokio::time::timeout(std::time::Duration::from_millis(500), other_stream.next())
                .await
        {
            Ok(Some(Ok(m))) => m,
            _ => break,
        };
        let text = msg.to_text().expect("expected text message");
        let value: serde_json::Value = serde_json::from_str(text).expect("invalid json");
        if value["type"].as_str() == Some("workspace_panes_changed") {
            leaked = true;
            break;
        }
    }
    assert!(!leaked, "another session's socket must not see alpha frames");

    server_handle.abort();
    let _ = std::fs::remove_file(socket);
    std::env::remove_var("XDG_CONFIG_HOME");
}