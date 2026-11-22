//! Workspace, worktree, session lifecycle, and git helper tests.

use super::common::*;
use super::*;
use crate::tests::{env_lock, lock_env};

#[test]
fn existing_workspace_cwd_allows_blank_cwd() {
    assert_eq!(existing_workspace_cwd(None).unwrap(), None);
    assert_eq!(existing_workspace_cwd(Some("  ")).unwrap(), None);
}

#[test]
fn existing_workspace_cwd_expands_existing_directory() {
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-workspace-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();

    let cwd = existing_workspace_cwd(Some(dir.to_str().unwrap())).unwrap();

    assert_eq!(cwd.as_deref(), Some(dir.to_str().unwrap()));
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn existing_workspace_cwd_rejects_missing_directory() {
    let dir = std::env::temp_dir().join(format!(
        "herdr-webui-missing-workspace-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    let response = existing_workspace_cwd(Some(dir.to_str().unwrap())).unwrap_err();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn versions_api_reports_enabled_backends_from_settings() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-versions-enabled-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let mut state = test_state();
    // Server has external-herdr disabled in settings: browsers must see
    // enabled_backends so they stop targeting/offering it.
    state
        .server_settings
        .lock()
        .unwrap()
        .external_herdr_backend_enabled = false;
    state.backend_mode = BackendMode::Builtin;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/versions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["enabled_backends"]["builtin"], true);
    assert_eq!(body["enabled_backends"]["external-herdr"], false);

    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[test]
fn enriches_workspace_cwd_from_panes() {
    let mut workspaces = json!({
        "result": {
            "workspaces": [
                { "workspace_id": "ws1", "label": "repo" },
                { "workspace_id": "ws2", "label": "keeps", "cwd": "/already" }
            ]
        }
    });
    let panes = json!({
        "result": {
            "panes": [
                { "workspace_id": "ws1", "cwd": "/repo", "foreground_cwd": "/repo/sub" },
                { "workspace_id": "ws2", "cwd": "/ignored", "foreground_cwd": "/ignored/sub" }
            ]
        }
    });

    enrich_workspace_cwds(&mut workspaces, &panes);

    assert_eq!(workspaces["result"]["workspaces"][0]["cwd"], "/repo");
    assert_eq!(
        workspaces["result"]["workspaces"][0]["foreground_cwd"],
        "/repo/sub"
    );
    assert_eq!(workspaces["result"]["workspaces"][1]["cwd"], "/already");
}

#[test]
fn normalizes_worktree_response_server_side() {
    let mut response = json!({
        "result": {
            "worktrees": [
                { "path": "/repo/old", "label": "old", "last_commit_at": "2024-01-01T10:00:00+00:00" },
                { "path": "/repo/new", "label": "new", "last_commit_at": "2025-01-01T09:30:00+00:00" },
                { "path": "/repo/unknown", "label": "unknown" }
            ]
        }
    });

    normalize_worktree_response(&mut response);

    let rows = response["result"]["worktrees"].as_array().unwrap();
    assert_eq!(rows[0]["label"], "new");
    assert_eq!(rows[0]["last_commit_display"], "2025-01-01 09:30");
    assert_eq!(rows[1]["label"], "old");
    assert_eq!(rows[2]["label"], "unknown");
    assert!(rows[2]["last_commit_display"].is_null());
}

#[test]
fn worktree_activity_sort_uses_timestamp_when_offsets_differ() {
    let mut response = json!({
        "result": {
            "worktrees": [
                { "path": "/repo/local-later-string", "label": "older", "last_commit_at": "2025-01-01T10:00:00+02:00" },
                { "path": "/repo/utc-earlier-string", "label": "newer", "last_commit_at": "2025-01-01T08:30:00.000Z" }
            ]
        }
    });

    normalize_worktree_response(&mut response);

    let rows = response["result"]["worktrees"].as_array().unwrap();
    assert_eq!(rows[0]["label"], "newer");
    assert_eq!(rows[1]["label"], "older");
}

#[test]
fn open_created_worktree_request_preserves_source_cwd() {
    let request = open_created_worktree_request(
        "/tmp/source-repo",
        "/tmp/worktrees/repo/feature",
        Some("feature".into()),
    );

    assert_eq!(request["method"], "worktree.open");
    assert_eq!(request["params"]["cwd"], "/tmp/source-repo");
    assert_eq!(request["params"]["path"], "/tmp/worktrees/repo/feature");
    assert_eq!(request["params"]["label"], "feature");
}

#[test]
fn worktree_api_version_selects_native_existing_branch_support() {
    assert_eq!(
        HerdrWorktreeApiVersion::from_backend(Some("0.7.0")),
        HerdrWorktreeApiVersion::V0_7_0,
    );
    assert_eq!(
        HerdrWorktreeApiVersion::from_backend(Some("0.7.1")),
        HerdrWorktreeApiVersion::V0_7_1,
    );
    assert_eq!(
        HerdrWorktreeApiVersion::from_backend(Some("0.7.2")),
        HerdrWorktreeApiVersion::V0_7_1,
    );
    assert_eq!(
        HerdrWorktreeApiVersion::from_backend(None),
        HerdrWorktreeApiVersion::V0_7_0,
    );
}

#[test]
fn worktree_api_builds_native_create_request() {
    let worktree_api = HerdrWorktreeApi {
        client: ApiClient {
            backend: herdr_webui::backend_client::BackendClient::new(
                PathBuf::from("/tmp/herdr.sock"),
                PathBuf::new(),
            ),
        },
        version: HerdrWorktreeApiVersion::V0_7_1,
    };

    let request = worktree_api.create_request(
        CreateWorktreeRequest {
            workspace_id: Some("w_1".into()),
            cwd: Some("~/repo".into()),
            branch: Some("feature/demo".into()),
            base: Some("main".into()),
            path: Some("../worktrees/demo".into()),
            label: Some("demo".into()),
            pull_base: Some(false),
        },
        Some("/home/me/repo".into()),
        Some("/home/me/worktrees/demo".into()),
    );

    assert_eq!(request["method"], "worktree.create");
    assert_eq!(request["params"]["workspace_id"], "w_1");
    assert_eq!(request["params"]["cwd"], "/home/me/repo");
    assert_eq!(request["params"]["path"], "/home/me/worktrees/demo");
    assert_eq!(request["params"]["branch"], "feature/demo");
    assert_eq!(request["params"]["focus"], true);
}

#[tokio::test]
async fn create_workspace_route_rejects_missing_cwd_before_proxy() {
    let app = test_app();
    let missing = std::env::temp_dir().join(format!(
        "herdr-webui-route-missing-workspace-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    let response = app
        .oneshot(
            request(Method::POST, "/api/workspaces")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "label": "missing", "cwd": missing }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(response).await["error"],
        "workspace folder must exist"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn versions_api_reports_backend_compatibility_from_fake_socket() {
    let (socket, handle) = fake_api_socket(json!({
        "id": "web:ping",
        "result": { "version": "0.9.0", "protocol": PROTOCOL_VERSION }
    }));
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::GET, "/api/versions")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(response).await;

    assert_eq!(body["backend"], "0.9.0");
    assert_eq!(body["min_backend"], MIN_BACKEND_VERSION);
    assert_eq!(body["max_tested_backend"], MAX_TESTED_BACKEND_VERSION);
    assert_eq!(body["protocol_version"], PROTOCOL_VERSION);
    assert_eq!(body["min_protocol_version"], MIN_SUPPORTED_PROTOCOL_VERSION);
    assert_eq!(body["backend_protocol_version"], PROTOCOL_VERSION);
    assert_eq!(body["compatibility"]["status"], "compatible");
    assert_eq!(body["compatibility"]["compatible"], true);

    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[tokio::test]
async fn versions_api_reports_builtin_backend_as_compatible() {
    let mut state = test_state();
    state.backend_mode = BackendMode::Builtin;
    state.api_socket = None;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::GET, "/api/versions")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(response).await;

    assert_eq!(body["backend_mode"], "builtin");
    assert_eq!(body["compatibility"]["status"], "compatible");
    assert_eq!(body["compatibility"]["compatible"], true);
    assert_eq!(
        body["compatibility"]["message"],
        "built-in backend is embedded in this WebUI process"
    );
}

#[tokio::test]
async fn workspace_order_api_requires_auth_and_is_session_scoped() {
    let app = test_app();

    let unauthorized = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/workspace-order")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let update = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/workspace-order")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header("x-herdr-session", "work")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"order":["w2","w1"]}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(update.status(), StatusCode::OK);
    assert_eq!(response_json(update).await["order"], json!(["w2", "w1"]));

    let work = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/workspace-order")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header("x-herdr-session", "work")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let default = app
        .oneshot(
            request(Method::GET, "/api/workspace-order")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response_json(work).await["order"], json!(["w2", "w1"]));
    assert_eq!(response_json(default).await["order"], json!([]));
}

#[tokio::test]
async fn push_recent_workspace_dedupes_orders_and_truncates() {
    let mut recent = Vec::new();
    push_recent_workspace(
        &mut recent,
        "  /repo/a  ",
        Some(" A ".to_string()),
        None,
        Some("workspace".to_string()),
    );
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, "/repo/a");
    assert_eq!(recent[0].label.as_deref(), Some("A"));

    push_recent_workspace(&mut recent, "/repo/a", None, None, None);
    assert_eq!(recent.len(), 1, "same path replaces the existing entry");
    assert_eq!(recent[0].label, None, "replacement clears the label");

    push_recent_workspace(&mut recent, "   ", None, None, None);
    assert_eq!(recent.len(), 1, "empty and whitespace paths are ignored");

    for index in 0..(MAX_RECENT_WORKSPACES + 5) {
        push_recent_workspace(&mut recent, &format!("/repo/{index}"), None, None, None);
    }
    assert_eq!(recent.len(), MAX_RECENT_WORKSPACES);
    assert_eq!(
        recent[0].path,
        format!("/repo/{}", MAX_RECENT_WORKSPACES + 4)
    );
    assert!(recent.iter().all(|item| item.opened_at.is_some()));
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn recent_workspaces_api_requires_auth_and_clears() {
    let _env = lock_env();
    // The authed clear persists server settings; keep that write inside
    // a temp config dir so the real operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-recent-clear-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    // GET prunes entries whose folder is gone, so the seeded entry needs a
    // real directory on disk.
    let recent_dir = std::env::temp_dir().join(format!(
        "herdr-webui-recent-clear-dir-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&recent_dir).unwrap();
    let recent_path = recent_dir.to_str().unwrap().to_string();
    let app = test_app();

    let unauthorized = app
        .clone()
        .oneshot(
            request(Method::GET, "/api/recent-workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let open_unauthorized = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/recent-workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "path": "/repo/x", "label": "X" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(open_unauthorized.status(), StatusCode::UNAUTHORIZED);

    let clear_unauthorized = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/recent-workspaces/clear")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(clear_unauthorized.status(), StatusCode::UNAUTHORIZED);

    {
        let state = test_state();
        {
            let mut guard = state.server_settings.lock().unwrap();
            push_recent_workspace(
                &mut guard.recent_workspaces,
                &recent_path,
                Some("X".to_string()),
                Some("main".to_string()),
                Some("worktree".to_string()),
            );
        }
        let app_with_recent = test_app_with_state(state);

        let listed = app_with_recent
            .clone()
            .oneshot(
                request(Method::GET, "/api/recent-workspaces")
                    .header(header::COOKIE, "herdr_web_session=token-123")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let json = response_json(listed).await;
        assert_eq!(json["recent"][0]["path"], recent_path.as_str());
        assert_eq!(json["recent"][0]["label"], "X");
        assert_eq!(json["recent"][0]["branch"], "main");
        assert_eq!(json["recent"][0]["kind"], "worktree");

        let cleared = app_with_recent
            .oneshot(
                request(Method::POST, "/api/recent-workspaces/clear")
                    .header(header::COOKIE, "herdr_web_session=token-123")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cleared.status(), StatusCode::OK);
        assert_eq!(response_json(cleared).await["cleared"], json!(1));
    }

    let _ = fs::remove_dir_all(config_home);
    let _ = fs::remove_dir_all(&recent_dir);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn recent_workspaces_record_endpoint_requires_auth_and_records() {
    let _env = lock_env();
    // The authed record persists server settings; keep that write inside
    // a temp config dir so the real operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-recent-record-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let app = test_app();

    let unauthorized = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/recent-workspaces/record")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "path": "/repo/x", "label": "X" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

    let empty_path = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/recent-workspaces/record")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::from(json!({ "path": "   " }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(empty_path.status(), StatusCode::BAD_REQUEST);

    // Recording does not need the folder on disk (unlike GET pruning,
    // the record happens right after the client created it there).
    let recorded = app
        .clone()
        .oneshot(
            request(Method::POST, "/api/recent-workspaces/record")
                .header(header::CONTENT_TYPE, "application/json")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .body(Body::from(
                    json!({ "path": "/repo/x", "label": "X", "kind": "workspace" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(recorded.status(), StatusCode::OK);
    assert_eq!(response_json(recorded).await["ok"], json!(true));

    // The record landed in the persisted settings file, with the sent
    // fields (branch absent like the desktop's create-flow record).
    let settings_path = config_home.join("herdr-webui").join("webui-settings.json");
    let text = fs::read_to_string(&settings_path).unwrap_or_default();
    let persisted: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let entry = &persisted["recent_workspaces"][0];
    assert_eq!(entry["path"], json!("/repo/x"), "persisted: {text}");
    assert_eq!(entry["label"], json!("X"), "persisted: {text}");
    assert_eq!(entry["kind"], json!("workspace"), "persisted: {text}");
    assert!(entry["branch"].is_null(), "persisted: {text}");
    assert!(entry["opened_at"].as_u64().is_some(), "persisted: {text}");

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn recent_workspaces_prunes_missing_paths_and_persists() {
    let _env = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-recent-prune-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let kept_dir = std::env::temp_dir().join(format!(
        "herdr-webui-recent-prune-kept-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&kept_dir).unwrap();
    let kept_path = kept_dir.to_str().unwrap().to_string();

    {
        let state = test_state();
        {
            let mut guard = state.server_settings.lock().unwrap();
            push_recent_workspace(
                &mut guard.recent_workspaces,
                &kept_path,
                Some("Kept".to_string()),
                None,
                Some("workspace".to_string()),
            );
            push_recent_workspace(
                &mut guard.recent_workspaces,
                "/repo/gone-recent",
                None,
                None,
                None,
            );
        }
        let app = test_app_with_state(state.clone());

        let listed = app
            .oneshot(
                authed_request(Method::GET, "/api/recent-workspaces")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(listed.status(), StatusCode::OK);
        let recent = response_json(listed).await["recent"].clone();
        assert_eq!(recent.as_array().map(Vec::len), Some(1));
        assert_eq!(recent[0]["path"], kept_path.as_str());

        // The prune also updates in-memory state and persists it.
        let stored = state
            .server_settings
            .lock()
            .map(|settings| settings.recent_workspaces.clone())
            .unwrap_or_default();
        assert_eq!(stored.len(), 1);
        assert_eq!(stored[0].path, kept_path);
        let persisted =
            fs::read_to_string(config_home.join("herdr-webui/webui-settings.json")).unwrap();
        assert!(persisted.contains(&kept_path));
        assert!(!persisted.contains("/repo/gone-recent"));
    }

    let _ = fs::remove_dir_all(config_home);
    let _ = fs::remove_dir_all(&kept_dir);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn recent_workspaces_reports_persist_failure_when_prune_cannot_save() {
    let _env = lock_env();
    let state = test_state();
    // Point XDG_CONFIG_HOME at a plain file so saving settings cannot create
    // the config directory, making the prune persist fail.
    let sentinel = std::env::temp_dir().join(format!(
        "herdr-webui-prune-persist-file-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::write(&sentinel, "not-a-directory").unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &sentinel);

    {
        let mut guard = state.server_settings.lock().unwrap();
        push_recent_workspace(
            &mut guard.recent_workspaces,
            "/repo/gone-recent",
            None,
            None,
            None,
        );
    }
    let app = test_app_with_state(state);

    let listed = app
        .oneshot(
            authed_request(Method::GET, "/api/recent-workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(listed.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(response_json(listed).await["error"].as_str().is_some());

    std::env::remove_var("XDG_CONFIG_HOME");
    let _ = fs::remove_file(sentinel);
}

// lock_env() serializes env-mutating tests; holding it across await is
// intentional so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn remove_recent_workspace_removes_single_entry_and_validates() {
    let _env = lock_env();
    // The authed remove persists server settings; keep that write inside
    // a temp config dir so the real operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-recent-remove-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    // GET prunes entries whose folder is gone, so the seeded entries need
    // real directories on disk.
    let keep_dir = std::env::temp_dir().join(format!(
        "herdr-webui-recent-remove-keep-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&keep_dir).unwrap();
    let keep_path = keep_dir.to_str().unwrap().to_string();
    let gone_dir = std::env::temp_dir().join(format!(
        "herdr-webui-recent-remove-gone-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&gone_dir).unwrap();
    let gone_path = gone_dir.to_str().unwrap().to_string();

    {
        let state = test_state();
        {
            let mut guard = state.server_settings.lock().unwrap();
            push_recent_workspace(
                &mut guard.recent_workspaces,
                &keep_path,
                Some("Keep".to_string()),
                None,
                Some("workspace".to_string()),
            );
            push_recent_workspace(
                &mut guard.recent_workspaces,
                &gone_path,
                Some("Gone".to_string()),
                None,
                Some("worktree".to_string()),
            );
        }
        let app = test_app_with_state(state);

        let unauthorized = app
            .clone()
            .oneshot(
                request(Method::POST, "/api/recent-workspaces/remove")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "path": gone_path }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unauthorized.status(), StatusCode::UNAUTHORIZED);

        let missing_path = app
            .clone()
            .oneshot(
                authed_request(Method::POST, "/api/recent-workspaces/remove")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({}).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing_path.status(), StatusCode::BAD_REQUEST);

        // Empty and whitespace-only paths must 400 too, not expand to the
        // home directory and silently remove the home workspace entry.
        for empty_body in [json!({ "path": "" }), json!({ "path": "   " })] {
            let empty_path = app
                .clone()
                .oneshot(
                    authed_request(Method::POST, "/api/recent-workspaces/remove")
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(empty_body.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(empty_path.status(), StatusCode::BAD_REQUEST);
        }

        let removed = app
            .clone()
            .oneshot(
                authed_request(Method::POST, "/api/recent-workspaces/remove")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "path": gone_path }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(removed.status(), StatusCode::OK);
        let json = response_json(removed).await;
        assert_eq!(json["ok"], json!(true));
        assert_eq!(json["removed"], json!(1));
        assert_eq!(json["path"], gone_path.as_str());

        let listed = app
            .clone()
            .oneshot(
                authed_request(Method::GET, "/api/recent-workspaces")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let recent = response_json(listed).await["recent"].clone();
        assert_eq!(recent.as_array().map(Vec::len), Some(1));
        assert_eq!(recent[0]["path"], keep_path.as_str());

        // Removing an unknown path reports zero removals and keeps state.
        let noop = app
            .oneshot(
                authed_request(Method::POST, "/api/recent-workspaces/remove")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "path": "/repo/unknown" }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(noop.status(), StatusCode::OK);
        assert_eq!(response_json(noop).await["removed"], json!(0));
    }

    let _ = fs::remove_dir_all(config_home);
    let _ = fs::remove_dir_all(keep_dir);
    let _ = fs::remove_dir_all(gone_dir);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn open_worktree_handler_records_recent_workspace() {
    let _env = lock_env();
    // The authed open records a recent workspace, which persists server
    // settings; keep that write inside a temp config dir so the real
    // operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-worktree-record-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.open",
        json!({ "id": "web:worktree:open", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state.clone());

    let response = app
            .oneshot(
                authed_request(Method::POST, "/api/worktrees/open")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "workspace_id": "ws1", "cwd": "/repo", "path": "/repo/wt", "branch": "feature", "label": "  Feature  " }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    let recent = state
        .server_settings
        .lock()
        .map(|settings| settings.recent_workspaces.clone())
        .unwrap_or_default();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, "/repo/wt");
    assert_eq!(recent[0].label.as_deref(), Some("Feature"));
    assert_eq!(recent[0].branch.as_deref(), Some("feature"));
    assert_eq!(recent[0].kind.as_deref(), Some("worktree"));

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn open_recent_workspace_records_and_proxies_open() {
    let _env = lock_env();
    // The authed record persists server settings; keep that write inside
    // a temp config dir so the real operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-recent-open-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    // The open handler validates that the folder exists, so the recent
    // entry needs a real directory on disk.
    let recent_dir = std::env::temp_dir().join(format!(
        "herdr-webui-recent-open-dir-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&recent_dir).unwrap();
    let recent_path = recent_dir.to_str().unwrap().to_string();
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.open",
        json!({ "id": "web:recent-workspace:open", "result": { "ok": true, "workspace": { "workspace_id": "ws-recent" } } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state.clone());

    let response = app
        .clone()
        .oneshot(
            authed_request(Method::POST, "/api/recent-workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "path": recent_path, "label": " Recent ", "branch": "main" })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    let recent = state
        .server_settings
        .lock()
        .map(|settings| settings.recent_workspaces.clone())
        .unwrap_or_default();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, recent_path);
    assert_eq!(recent[0].label.as_deref(), Some("Recent"));
    assert_eq!(recent[0].branch.as_deref(), Some("main"));
    assert_eq!(recent[0].kind.as_deref(), Some("workspace"));

    let body = response_json(response).await;
    assert_eq!(
        body["result"]["workspace"]["workspace_id"],
        json!("ws-recent")
    );

    // Empty and whitespace-only paths must 400 before expansion: the old
    // behavior expanded "" to the home directory, opened it as a
    // workspace, and recorded it in recents.
    for empty in ["", "   "] {
        let response = app
            .clone()
            .oneshot(
                authed_request(Method::POST, "/api/recent-workspaces")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(json!({ "path": empty }).to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "expected 400 for open with empty path"
        );
        let body = response_json(response).await;
        assert_eq!(body["error"], json!("path is required"));
    }
    // No extra recents entry leaked from the rejected requests.
    let recent = state
        .server_settings
        .lock()
        .map(|settings| settings.recent_workspaces.clone())
        .unwrap_or_default();
    assert_eq!(recent.len(), 1);
    assert_eq!(recent[0].path, recent_path);

    let _ = fs::remove_dir_all(config_home);
    let _ = fs::remove_dir_all(&recent_dir);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
// lock_env() serializes env-mutating tests; held across await on purpose
// so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn open_recent_workspace_rejects_missing_folder() {
    let _env = lock_env();
    let state = test_state();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/recent-workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "path": "/repo/definitely-gone", "label": "Gone" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        response_json(response).await["error"],
        json!("workspace folder must exist")
    );
}

#[cfg(unix)]
#[tokio::test]
async fn recent_workspaces_returns_service_unavailable_when_lock_poisoned() {
    let state = test_state();
    // Poison the settings lock so handlers take their degraded arms.
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = state.server_settings.lock().unwrap();
        struct PanicOnDrop;
        impl Drop for PanicOnDrop {
            fn drop(&mut self) {
                panic!("poisoning settings lock");
            }
        }
        drop(PanicOnDrop);
    }));
    let app = test_app_with_state(state);

    let listed = app
        .clone()
        .oneshot(
            authed_request(Method::GET, "/api/recent-workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // The GET arm returns an empty list when the lock is unavailable.
    assert_eq!(listed.status(), StatusCode::OK);
    assert_eq!(
        response_json(listed).await["recent"]
            .as_array()
            .map(Vec::len),
        Some(0)
    );

    let cleared = app
        .oneshot(
            authed_request(Method::POST, "/api/recent-workspaces/clear")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn clear_recent_workspaces_reports_persist_failure() {
    let _guard = lock_env();
    let state = test_state();
    // Point XDG_CONFIG_HOME at a plain file so saving settings cannot create
    // the config directory, making persist_server_settings fail.
    let sentinel = std::env::temp_dir().join(format!(
        "herdr-webui-clear-persist-file-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::write(&sentinel, "not-a-directory").unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &sentinel);

    {
        let mut guard = state.server_settings.lock().unwrap();
        push_recent_workspace(&mut guard.recent_workspaces, "/repo/x", None, None, None);
    }
    let app = test_app_with_state(state);

    let cleared = app
        .oneshot(
            authed_request(Method::POST, "/api/recent-workspaces/clear")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cleared.status(), StatusCode::INTERNAL_SERVER_ERROR);
    assert!(response_json(cleared).await["error"].as_str().is_some());

    std::env::remove_var("XDG_CONFIG_HOME");
    let _ = fs::remove_file(sentinel);
}

#[tokio::test]
async fn record_and_persist_recent_fail_gracefully_when_lock_poisoned() {
    let state = test_state();
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = state.server_settings.lock().unwrap();
        struct PanicOnDrop;
        impl Drop for PanicOnDrop {
            fn drop(&mut self) {
                panic!("poisoning settings lock");
            }
        }
        drop(PanicOnDrop);
    }));

    let recorded = record_recent_workspace(&state, "/repo/x", None, None, None).await;
    assert!(
        recorded.is_err(),
        "recording must fail when the lock is poisoned"
    );

    let persisted = persist_server_settings(&state).await;
    assert!(
        persisted.is_err(),
        "persisting must fail when the lock is poisoned"
    );
}

#[test]
fn list_git_branches_can_include_remote_refs_on_request() {
    let repo =
        std::env::temp_dir().join(format!("herdr-webui-branches-test-{}", std::process::id()));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/local"])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["update-ref", "refs/remotes/origin/feature/remote", "HEAD"])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ])
        .output()
        .unwrap()
        .status
        .success());

    let local = list_git_branches(repo.to_str().unwrap(), false, false).unwrap();
    assert!(local.contains(&"feature/local".to_string()));
    assert!(!local.contains(&"origin/feature/remote".to_string()));

    let remote = list_git_branches(repo.to_str().unwrap(), true, false).unwrap();
    assert!(remote.contains(&"feature/local".to_string()));
    assert!(remote.contains(&"origin/feature/remote".to_string()));
    assert!(!remote.contains(&"origin/HEAD".to_string()));

    fs::remove_dir_all(repo).unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_ok_when_backend_drops_connection() {
    let (socket, saw_stop, handle) = fake_api_socket_drop_on_stop();
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert!(
        *saw_stop.lock().unwrap(),
        "backend should have received server.stop"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_ok_and_already_stopped_on_missing_socket() {
    // A stale session row: the backend died and its socket file is gone.
    // Close must succeed so the UI can dismiss the row, not 502.
    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-herdr-test-socket.sock"));
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["already_stopped"], true);
}

#[cfg(unix)]
#[tokio::test]
async fn close_session_reports_already_stopped_when_listener_died_with_socket_file() {
    // Stale row variant: the backend crashed (or was kill -9'd) without
    // unlinking its socket, so connect(2) gets ECONNREFUSED ("Connection
    // refused", macOS os error 61) instead of ENOENT. The session is
    // already down, so close must be ok + already_stopped, not 502.
    // /tmp, not std::env::temp_dir(): CI runners have a long $TMPDIR
    // that pushes this path past sun_path's 104-byte capacity.
    let path = PathBuf::from(format!(
        "/tmp/herdr-webui-test-dead-listener-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    // Bind then drop the listener: the socket file survives with nobody
    // accepting on it, exactly like a crashed backend. std's UnixListener
    // does not unlink on drop, unlike interprocess's ReclaimGuard.
    {
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        drop(listener);
    }

    let mut state = test_state();
    state.api_socket = Some(path.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["already_stopped"], true);
    let _ = fs::remove_file(path);
}

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn close_session_builtin_reports_already_stopped_when_listener_died_with_socket_file() {
    // Same dead-listener stale row for the built-in backend: the session
    // directory still holds a socket file with no listener (crashed
    // child). Close must be ok + already_stopped, drop the registry
    // entry, and remove the dead socket residue.
    let _guard = lock_env();
    // Short /tmp prefix, not std::env::temp_dir(): CI runners have a
    // long $TMPDIR that pushes the session socket path past sun_path's
    // 104-byte capacity (and past the deterministic fallback in
    // builtin_socket_paths, which would exercise a different code path).
    let config_home = PathBuf::from(format!(
        "/tmp/hw-dlclose-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let session_name = "dead-listener-builtin";
    let (api_socket, _client_socket) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    {
        let listener = std::os::unix::net::UnixListener::bind(&api_socket).unwrap();
        drop(listener);
    }

    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    // Registry entries hold live handles; a real (throwaway) handle keeps
    // the map shape honest. Its sockets live in /tmp and are never the ones
    // close_session contacts (that path comes from XDG_CONFIG_HOME).
    let stale_handle = Arc::new(
        builtin_backend::BuiltinBackendHandle::start(builtin_backend::BuiltinBackendConfig {
            api_socket: PathBuf::from(format!(
                "/tmp/herdr-webui-dead-listener-close-api-{}.sock",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            )),
            client_socket: PathBuf::from(format!(
                "/tmp/herdr-webui-dead-listener-close-client-{}.sock",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            )),
            cwd: std::env::temp_dir(),
            shell: None,
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
            journal_dir: None,
        })
        .unwrap(),
    );
    state
        .builtin_sessions
        .lock()
        .unwrap()
        .insert(session_name.to_string(), stale_handle);
    let sessions_registry = state.builtin_sessions.clone();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["already_stopped"], true);
    assert!(
        !sessions_registry.lock().unwrap().contains_key(session_name),
        "registry entry must be removed after closing a dead-listener built-in session"
    );
    assert!(
        !api_socket.exists(),
        "dead socket file must be removed after close"
    );
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
// lock_env() serializes env-mutating tests; held across await on purpose
// so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn close_session_builtin_with_missing_socket_reports_already_stopped() {
    // Same stale-row class for the built-in backend: the session
    // directory reports a session that no longer has a live socket
    // (crashed child). Closing it must be ok + already_stopped, and the
    // registry entry must be dropped.
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-stale-close-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let session_name = "gone-builtin";
    // Registry entries hold live handles; a real (throwaway) handle keeps
    // the map shape honest. Its sockets live in /tmp and are never the ones
    // close_session contacts (that path comes from XDG_CONFIG_HOME), so the
    // proxy sees ENOENT, the stale-row case under test.
    let stale_handle = Arc::new(
        builtin_backend::BuiltinBackendHandle::start(builtin_backend::BuiltinBackendConfig {
            api_socket: std::env::temp_dir().join(format!(
                "herdr-webui-stale-close-api-{}.sock",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            )),
            client_socket: std::env::temp_dir().join(format!(
                "herdr-webui-stale-close-client-{}.sock",
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos(),
            )),
            cwd: std::env::temp_dir(),
            shell: None,
            jcode_detection_variant: JcodeDetectionVariant::Vanilla,
            journal_dir: None,
        })
        .unwrap(),
    );
    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    state
        .builtin_sessions
        .lock()
        .unwrap()
        .insert(session_name.to_string(), stale_handle);
    let sessions_registry = state.builtin_sessions.clone();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["already_stopped"], true);
    // close_session must also drop the registry entry so the stale
    // session cannot linger in the built-in registry.
    assert!(
        !sessions_registry.lock().unwrap().contains_key(session_name),
        "registry entry must be removed after closing a stale built-in session"
    );
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── closed built-in session marker ──
// Close must be final until an explicit relaunch: the marker has to block
// every auto-start path (workspace proxying, events socket, terminal) and
// clean the on-disk residue so the row disappears from the manager list.

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn close_session_builtin_marks_session_closed_and_removes_residue() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-close-marker-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let session_name = "marker-close";
    let (api_socket, client_socket) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    let _ = fs::remove_file(&api_socket);
    let _ = fs::remove_file(&client_socket);

    // Live socket so close succeeds without the stale-row shortcut.
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    let name = api_socket.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let accept_handle = thread::spawn(move || {
        let stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        // server.stop: close the connection, simulating shutdown.
        drop(stream);
    });

    let state = test_state();
    let closed_registry = state.closed_builtin_sessions.clone();
    let sessions_registry = state.builtin_sessions.clone();
    let state_for_list = state.clone();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    accept_handle.join().unwrap();
    assert!(
        closed_registry.lock().unwrap().contains(session_name),
        "closed marker must be set after a successful builtin close"
    );
    assert!(
        !sessions_registry.lock().unwrap().contains_key(session_name),
        "live registry entry must be removed after close"
    );
    assert!(
        !api_socket.exists(),
        "api socket file must be removed after close"
    );
    assert!(
        !client_socket.exists(),
        "client socket file must be removed after close"
    );
    assert!(
        !api_socket.parent().unwrap().exists(),
        "empty session directory must be removed after close"
    );
    // The session must be gone from the manager list.
    assert!(
        !known_sessions(&state_for_list, true)
            .iter()
            .any(|session| session.get("name").and_then(Value::as_str) == Some(session_name)),
        "closed session must disappear from known_sessions"
    );

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[test]
fn ensure_builtin_session_skips_closed_sessions() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-closed-skip-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let state = test_state();
    state
        .closed_builtin_sessions
        .lock()
        .unwrap()
        .insert("closed-one".to_string());

    assert!(
        ensure_builtin_session(&state, Some("closed-one")).is_ok(),
        "closed session must be skipped, not resurrected"
    );
    assert!(
        !state
            .builtin_sessions
            .lock()
            .unwrap()
            .contains_key("closed-one"),
        "no backend may be started for a closed session"
    );
    let (api_socket, _) = builtin_socket_paths(Some("closed-one"));
    assert!(
        !api_socket.exists(),
        "closed session must leave no socket behind"
    );

    // Non-closed sessions still auto-start normally.
    assert!(ensure_builtin_session(&state, Some("open-one")).is_ok());
    assert!(
        state
            .builtin_sessions
            .lock()
            .unwrap()
            .contains_key("open-one"),
        "auto-start must still work for non-closed sessions"
    );

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn launch_session_builtin_clears_closed_marker_and_revives_session() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-relaunch-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let session_name = "relaunch-me";
    let state = test_state();
    state
        .closed_builtin_sessions
        .lock()
        .unwrap()
        .insert(session_name.to_string());
    let closed_registry = state.closed_builtin_sessions.clone();
    let state_after = state.clone();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert!(
        !closed_registry.lock().unwrap().contains(session_name),
        "explicit launch must clear the closed marker"
    );
    assert!(
        state_after
            .builtin_sessions
            .lock()
            .unwrap()
            .contains_key(session_name),
        "relaunched session must be running again"
    );

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[test]
fn ensure_backend_for_request_does_not_resurrect_closed_session() {
    // The workspace-proxy auto-start funnel: a request aimed at a closed
    // session (ensure_backend_for_request is what api_for_headers_ensured
    // calls) must not start its backend again.
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-resurrect-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let state = test_state();
    state
        .closed_builtin_sessions
        .lock()
        .unwrap()
        .insert("resurrect-guard".to_string());

    ensure_backend_for_request(
        &state,
        SessionBackendTarget::Builtin,
        Some("resurrect-guard"),
    );

    assert!(
        !state
            .builtin_sessions
            .lock()
            .unwrap()
            .contains_key("resurrect-guard"),
        "auto-start must not resurrect a closed session"
    );
    let (api_socket, _) = builtin_socket_paths(Some("resurrect-guard"));
    assert!(
        !api_socket.exists(),
        "auto-start must leave no socket behind for a closed session"
    );

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_bad_gateway_on_real_error() {
    // A socket file that exists but refuses connections (not a stale
    // ENOENT row) is a real failure and must surface as 502.
    let path = std::env::temp_dir().join(format!(
        "herdr-webui-test-refused-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    // A regular file is not a socket: connect fails with
    // "Connection refused"/"Socket type not supported", not ENOENT.
    fs::write(&path, b"").unwrap();

    let mut state = test_state();
    state.api_socket = Some(path.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let _ = fs::remove_file(path);
}

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_bad_gateway_when_refused_path_is_not_a_socket() {
    // Linux quirk: connect(2) to a path that is NOT a socket file also
    // returns ECONNREFUSED, identical to a crashed backend's dead
    // listener. A regular file at the socket path is a misconfiguration
    // (real error), so it must surface as 502 even though the error
    // string says "Connection refused". The dead-listener classification
    // gates on the path being an actual socket file; this pins that
    // gate against Linux, where the strings are indistinguishable.
    let path = std::env::temp_dir().join(format!(
        "herdr-webui-test-refused-regular-file-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    fs::write(&path, b"").unwrap();

    let mut state = test_state();
    state.api_socket = Some(path.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let _ = fs::remove_file(path);
}

#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_handler_proxies_snapshot() {
    let (socket, handle) = fake_api_socket_for_method(
        "session.snapshot",
        json!({ "id": "web:session:snapshot", "result": { "workspaces": [], "tabs": [], "panes": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["result"]["workspaces"].is_array());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// The snapshot bootstrap must carry the WebUI-only fields alongside the
// backend envelope: workspace drag order from the web state, one enriched
// worktree.list result per workspace (cwd pinned to that workspace so builtin
// resolves the right repo), and the source_workspace_id stamp the frontend
// uses to attribute rows.
#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_includes_order_and_worktree_results() {
    let (socket, handle, rx) = fake_api_socket_multi_recording(vec![
        json!({
            "result": {
                "snapshot": {
                    "workspaces": [
                        { "workspace_id": "ws_1", "label": "one" },
                        { "workspace_id": "ws_2", "label": "two" }
                    ],
                    "tabs": [],
                    "panes": [
                        { "workspace_id": "ws_1", "tab_id": "tab_1", "pane_id": "pane_1", "cwd": "/tmp/repo-a" },
                        { "workspace_id": "ws_2", "tab_id": "tab_2", "pane_id": "pane_2", "cwd": "/tmp/repo-b" }
                    ]
                },
                "type": "session_snapshot"
            }
        }),
        json!({ "match_cwd": "/tmp/repo-a", "result": { "worktrees": [ { "path": "/tmp/repo-a", "branch": "main" } ], "source": { "repo_name": "repo-a" } } }),
        json!({ "match_cwd": "/tmp/repo-b", "result": { "worktrees": [ { "path": "/tmp/repo-b", "branch": "dev" } ], "source": { "source_workspace_id": null, "repo_name": "repo-b" } } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    state.workspace_orders.lock().unwrap().insert(
        "default".to_string(),
        vec!["ws_2".to_string(), "ws_1".to_string()],
    );
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    // The backend envelope stays untouched: additions are siblings of
    // result.snapshot, not nested inside it.
    assert_eq!(
        body["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(body["result"]["workspace_order"], json!(["ws_2", "ws_1"]));
    let entries = body["result"]["worktree_results"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0]["result"]["source"]["source_workspace_id"],
        "ws_1"
    );
    assert_eq!(entries[0]["result"]["worktrees"][0]["path"], "/tmp/repo-a");
    assert_eq!(
        entries[1]["result"]["source"]["source_workspace_id"],
        "ws_2"
    );
    assert_eq!(entries[1]["result"]["worktrees"][0]["branch"], "dev");
    // Enrichment filled the workspace cwd from the snapshot's own panes.
    assert_eq!(
        body["result"]["snapshot"]["workspaces"][0]["cwd"],
        "/tmp/repo-a"
    );
    // The worktree.list requests pinned each workspace's resolved cwd and
    // carried a workspace id. Fetch order is not deterministic, so
    // assertions key off cwd, not arrival order.
    let requests: Vec<String> = rx.iter().collect();
    assert_eq!(requests.len(), 3);
    let mut worktree_params: Vec<(String, String)> = Vec::new();
    for line in &requests {
        let parsed: serde_json::Value = serde_json::from_str(line).unwrap();
        if parsed["method"] == "session.snapshot" {
            continue;
        }
        assert_eq!(parsed["method"], "worktree.list");
        worktree_params.push((
            parsed["params"]["workspace_id"]
                .as_str()
                .unwrap()
                .to_string(),
            parsed["params"]["cwd"].as_str().unwrap().to_string(),
        ));
    }
    worktree_params.sort();
    assert_eq!(
        worktree_params,
        vec![
            ("ws_1".to_string(), "/tmp/repo-a".to_string()),
            ("ws_2".to_string(), "/tmp/repo-b".to_string())
        ]
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// The snapshot stamps `worktree` metadata onto workspace rows from the same
// worktree.list results it ships as worktree_results. The builtin backend
// never sends the stamp (external herdr does), so without this the location
// bar worktree chip, sidebar repo grouping, and agent repo attribution stay
// blind on builtin sessions. The main-vs-linked call comes from the row
// path vs the source repo root because the builtin marks every row linked.
#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_stamps_workspace_worktree_metadata() {
    let (socket, handle, _rx) = fake_api_socket_multi_recording(vec![
        json!({
            "result": {
                "snapshot": {
                    "workspaces": [
                        { "workspace_id": "ws_main", "label": "main", "cwd": "/tmp/stamp-repo" },
                        { "workspace_id": "ws_lane", "label": "lane", "cwd": "/tmp/stamp-repo-lane" },
                        { "workspace_id": "ws_plain", "label": "plain", "cwd": "/tmp/stamp-plain" }
                    ],
                    "tabs": [],
                    "panes": []
                },
                "type": "session_snapshot"
            }
        }),
        json!({ "match_cwd": "/tmp/stamp-repo", "result": {
            "worktrees": [
                { "path": "/tmp/stamp-repo", "branch": "main", "is_linked_worktree": true },
                { "path": "/tmp/stamp-repo-lane", "branch": "lane", "is_linked_worktree": true }
            ],
            "source": { "repo_key": "/tmp/stamp-repo", "repo_root": "/tmp/stamp-repo", "repo_name": "stamp-repo" }
        } }),
        json!({ "match_cwd": "/tmp/stamp-repo-lane", "result": {
            "worktrees": [
                { "path": "/tmp/stamp-repo", "branch": "main", "is_linked_worktree": true },
                { "path": "/tmp/stamp-repo-lane", "branch": "lane", "is_linked_worktree": true }
            ],
            "source": { "repo_key": "/tmp/stamp-repo", "repo_root": "/tmp/stamp-repo", "repo_name": "stamp-repo" }
        } }),
        json!({ "match_cwd": "/tmp/stamp-plain", "result": {
            "worktrees": [],
            "source": { "repo_key": "/tmp/stamp-plain", "repo_root": "/tmp/stamp-plain", "repo_name": "stamp-plain" }
        } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let workspaces = body["result"]["snapshot"]["workspaces"].as_array().unwrap();
    let by_id = |id: &str| {
        workspaces
            .iter()
            .find(|w| w["workspace_id"] == id)
            .unwrap_or_else(|| panic!("workspace {id} missing"))
    };
    // Main checkout: row path equals the repo root, so the builtin's
    // all-rows-linked flag must not leak through.
    let main = by_id("ws_main")["worktree"].clone();
    assert_eq!(
        main["is_linked_worktree"], false,
        "main checkout is not linked"
    );
    assert_eq!(main["repo_root"], "/tmp/stamp-repo");
    assert_eq!(main["repo_key"], "/tmp/stamp-repo");
    assert_eq!(main["repo_name"], "stamp-repo");
    assert_eq!(main["checkout_path"], "/tmp/stamp-repo");
    assert_eq!(main["branch"], "main");
    // Linked worktree: same repo identity, checkout away from the root.
    let lane = by_id("ws_lane")["worktree"].clone();
    assert_eq!(lane["is_linked_worktree"], true, "lane checkout is linked");
    assert_eq!(lane["repo_root"], "/tmp/stamp-repo");
    assert_eq!(lane["checkout_path"], "/tmp/stamp-repo-lane");
    assert_eq!(lane["branch"], "lane");
    // A workspace whose worktree.list returns no matching row (plain
    // folder, failed probe) keeps no stamp, matching the pre-stamp shape
    // every frontend consumer already tolerates.
    assert!(
        by_id("ws_plain").get("worktree").is_none(),
        "plain folder stays unstamped"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// A backend stamp (external herdr ships its own `worktree` object) must
// survive the wrapper's stamping pass verbatim: only rows missing the
// key are stamped.
#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_keeps_backend_provided_worktree_stamp() {
    let (socket, handle, _rx) = fake_api_socket_multi_recording(vec![
        json!({
            "result": {
                "snapshot": {
                    "workspaces": [
                        { "workspace_id": "ws_ext", "label": "ext", "cwd": "/tmp/ext-repo",
                          "worktree": { "repo_key": "ext-key", "repo_root": "ext-root", "repo_name": "ext",
                                        "checkout_path": "ext-checkout", "is_linked_worktree": true, "branch": "ext-branch" } }
                    ],
                    "tabs": [],
                    "panes": []
                },
                "type": "session_snapshot"
            }
        }),
        json!({ "match_cwd": "/tmp/ext-repo", "result": {
            "worktrees": [ { "path": "/tmp/ext-repo", "branch": "wrapper-branch" } ],
            "source": { "repo_key": "/tmp/ext-repo", "repo_root": "/tmp/ext-repo", "repo_name": "ext-repo" }
        } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let stamp = &body["result"]["snapshot"]["workspaces"][0]["worktree"];
    assert_eq!(
        stamp["repo_key"], "ext-key",
        "backend stamp is not clobbered"
    );
    assert_eq!(stamp["branch"], "ext-branch");
    assert_eq!(stamp["checkout_path"], "ext-checkout");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// /api/workspaces (the legacy refresh path when the snapshot bootstrap
// failed once) stamps the same worktree metadata, so the location bar
// and sidebar do not depend on which refresh path ran.
#[cfg(unix)]
#[tokio::test]
async fn workspaces_handler_stamps_worktree_metadata() {
    let (socket, handle) = fake_api_socket_multi(vec![
        json!({ "result": { "workspaces": [
            { "workspace_id": "ws_lane", "label": "lane", "cwd": "/tmp/legacy-repo-lane" }
        ] } }),
        json!({ "result": { "panes": [] } }),
        json!({ "result": {
            "worktrees": [ { "path": "/tmp/legacy-repo-lane", "branch": "lane", "is_linked_worktree": true } ],
            "source": { "repo_key": "/tmp/legacy-repo", "repo_root": "/tmp/legacy-repo", "repo_name": "legacy-repo" }
        } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let stamp = &body["result"]["workspaces"][0]["worktree"];
    assert_eq!(stamp["is_linked_worktree"], true);
    assert_eq!(stamp["repo_root"], "/tmp/legacy-repo");
    assert_eq!(stamp["repo_name"], "legacy-repo");
    assert_eq!(stamp["checkout_path"], "/tmp/legacy-repo-lane");
    assert_eq!(stamp["branch"], "lane");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// A worktree.list failure (backend error response) must not break the rest of
// the snapshot: the entry becomes null, the same tolerance the frontend's
// legacy per-workspace catch() had, and the other workspace keeps its rows.
#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_tolerates_worktree_error_entries() {
    let (socket, handle, _rx) = fake_api_socket_multi_recording(vec![
        json!({
            "result": {
                "snapshot": {
                    "workspaces": [
                        { "workspace_id": "ws_1", "label": "one", "cwd": "/tmp/repo-a" },
                        { "workspace_id": "ws_2", "label": "two", "cwd": "/tmp/repo-b" }
                    ],
                    "tabs": [],
                    "panes": []
                }
            }
        }),
        json!({ "match_cwd": "/tmp/repo-a", "error": { "message": "worktree.list failed" } }),
        json!({ "match_cwd": "/tmp/repo-b", "result": { "worktrees": [ { "path": "/tmp/repo-b", "branch": "dev" } ], "source": { "repo_name": "repo-b" } } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let entries = body["result"]["worktree_results"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert!(
        entries[0].is_null(),
        "failed worktree.list must be a null entry"
    );
    assert_eq!(
        entries[1]["result"]["source"]["source_workspace_id"],
        "ws_2"
    );
    // The snapshot body itself still applied.
    assert_eq!(
        body["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// Workspaces sharing one checkout must cost a single worktree.list: the
// enrich step dedupes by cwd. Before, a 12-workspace snapshot paid the git
// round trip 12 times for 2 checkouts, which was the panel-switch bottleneck.
#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_dedupes_worktree_fetches_per_cwd() {
    let (socket, handle, rx) = fake_api_socket_multi_recording(vec![
        json!({
            "result": {
                "snapshot": {
                    "workspaces": [
                        { "workspace_id": "ws_1", "label": "one", "cwd": "/tmp/repo-a" },
                        { "workspace_id": "ws_2", "label": "two", "cwd": "/tmp/repo-a" },
                        { "workspace_id": "ws_3", "label": "three", "cwd": "/tmp/repo-b" }
                    ],
                    "tabs": [],
                    "panes": []
                }
            }
        }),
        json!({ "match_cwd": "/tmp/repo-a", "result": { "worktrees": [ { "path": "/tmp/repo-a", "branch": "main" } ], "source": { "repo_name": "repo-a" } } }),
        json!({ "match_cwd": "/tmp/repo-b", "result": { "worktrees": [ { "path": "/tmp/repo-b", "branch": "dev" } ], "source": { "repo_name": "repo-b" } } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let entries = body["result"]["worktree_results"].as_array().unwrap();
    assert_eq!(entries.len(), 3);
    // Both /tmp/repo-a workspaces carry the same fetched rows, each
    // stamped with its own workspace id.
    assert_eq!(
        entries[0]["result"]["source"]["source_workspace_id"],
        "ws_1"
    );
    assert_eq!(
        entries[1]["result"]["source"]["source_workspace_id"],
        "ws_2"
    );
    assert_eq!(
        entries[2]["result"]["source"]["source_workspace_id"],
        "ws_3"
    );
    for index in [0usize, 1] {
        assert_eq!(
            entries[index]["result"]["worktrees"][0]["path"],
            "/tmp/repo-a"
        );
    }
    assert_eq!(entries[2]["result"]["worktrees"][0]["path"], "/tmp/repo-b");
    // One worktree.list per unique cwd: three workspaces, two fetches.
    let requests: Vec<String> = rx.iter().collect();
    let worktree_cwds: Vec<String> = requests
        .iter()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .filter(|request| request["method"] == "worktree.list")
        .map(|request| request["params"]["cwd"].as_str().unwrap().to_string())
        .collect();
    let mut sorted = worktree_cwds.clone();
    sorted.sort();
    assert_eq!(
        sorted,
        vec!["/tmp/repo-a".to_string(), "/tmp/repo-b".to_string()],
        "three workspaces across two checkouts must issue exactly two fetches"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// A worktree.list whose response already carries source_workspace_id from the
// backend (protocol 16 external sets it) must keep that value: the wrapper
// only fills missing or null stamps, it never overwrites backend truth.
#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_preserves_backend_source_workspace_id() {
    let (socket, handle, _rx) = fake_api_socket_multi_recording(vec![
        json!({
            "result": {
                "snapshot": {
                    "workspaces": [
                        { "workspace_id": "ws_1", "label": "one", "cwd": "/tmp/repo-a" },
                        { "workspace_id": "ws_2", "label": "two", "cwd": "/tmp/repo-b" }
                    ],
                    "tabs": [],
                    "panes": []
                }
            }
        }),
        // This backend stamps source_workspace_id itself (some backends
        // attribute by repo, not by the asking workspace). The wrapper must
        // keep the backend value, not the positional assumption.
        json!({
            "match_cwd": "/tmp/repo-a",
            "result": {
                "worktrees": [ { "path": "/tmp/repo-b", "branch": "dev" } ],
                "source": { "source_workspace_id": "ws_2", "repo_name": "repo-b" }
            }
        }),
        // Backend stamp for a different workspace than the request params:
        // backend truth wins over the wrapper's positional assumption.
        json!({
            "match_cwd": "/tmp/repo-b",
            "result": {
                "worktrees": [ { "path": "/tmp/repo-a", "branch": "main" } ],
                "source": { "source_workspace_id": "ws_9", "repo_name": "repo-a" }
            }
        }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let entries = body["result"]["worktree_results"].as_array().unwrap();
    assert_eq!(entries.len(), 2);
    assert_eq!(
        entries[0]["result"]["source"]["source_workspace_id"],
        "ws_2"
    );
    assert_eq!(
        entries[1]["result"]["source"]["source_workspace_id"],
        "ws_9"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// A workspace with no resolvable cwd (no cwd field, no panes) must still get
// its worktree.list entry, with cwd: null in the request params. Builtin
// treats a null cwd as "use the session's own cwd"; the entry stays in the
// envelope so the frontend can attribute rows to it.
#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_sends_null_cwd_for_workspace_without_cwd() {
    let (socket, handle, rx) = fake_api_socket_multi_recording(vec![
        json!({
            "result": {
                "snapshot": {
                    "workspaces": [
                        { "workspace_id": "ws_1", "label": "one" }
                    ],
                    "tabs": [],
                    "panes": []
                }
            }
        }),
        json!({ "result": { "worktrees": [], "source": { "repo_name": "repo-x" } } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let entries = body["result"]["worktree_results"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(
        entries[0]["result"]["source"]["source_workspace_id"],
        "ws_1"
    );
    let requests: Vec<String> = rx.iter().collect();
    assert_eq!(requests.len(), 2);
    let worktree_request: serde_json::Value = requests
        .iter()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .find(|request| request["method"] == "worktree.list")
        .unwrap();
    assert_eq!(worktree_request["params"]["workspace_id"], "ws_1");
    assert!(worktree_request["params"]["cwd"].is_null());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// A worktree.list transport failure (socket refused / closed without a
// response) must become a null entry, same as a backend-level error: one bad
// workspace never breaks the whole snapshot bootstrap.
#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_tolerates_worktree_transport_errors() {
    // Inline listener: answers session.snapshot, then accepts the
    // worktree.list connection and closes it without responding, which makes
    // request_raw fail on the UnexpectedResponse path.
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = std::env::temp_dir().join(format!(
        "herdr-webui-snap-transport-{}-{}.sock",
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
        // First connection: answer session.snapshot with one workspace.
        {
            let mut stream = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let response = json!({
                "id": "web:session:snapshot",
                "result": {
                    "snapshot": {
                        "workspaces": [
                            { "workspace_id": "ws_1", "label": "one", "cwd": "/tmp/repo-a" }
                        ],
                        "tabs": [],
                        "panes": []
                    }
                }
            });
            stream
                .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        }
        // Second connection: read the worktree.list request, answer nothing,
        // close. request_raw sees a 0-byte read and fails.
        {
            let stream = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            drop(stream);
        }
    });
    let mut state = test_state();
    state.api_socket = Some(path.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let entries = body["result"]["worktree_results"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert!(
        entries[0].is_null(),
        "transport-failed worktree.list must be a null entry"
    );
    // The snapshot body itself still applied.
    assert_eq!(
        body["result"]["snapshot"]["workspaces"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    handle.join().unwrap();
    let _ = fs::remove_file(&path);
}

// ?workspace_id= filters the snapshot's tabs/panes to that workspace while
// the derived maps (workspaces_by_id, workspace_counts) still cover every
// workspace: the frontend deletes its local filter and cross-workspace
// count derivation on top of this contract.
#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_filters_rows_by_workspace_and_derives_maps() {
    let (socket, handle) = fake_api_socket_multi(vec![json!({
        "result": {
            "snapshot": {
                "workspaces": [
                    { "workspace_id": "ws_1", "label": "one", "cwd": "/tmp/repo-a" },
                    { "workspace_id": "ws_2", "label": "two", "cwd": "/tmp/repo-b" }
                ],
                "tabs": [
                    { "workspace_id": "ws_1", "tab_id": "tab_1", "number": 1, "label": "Shell" },
                    { "workspace_id": "ws_2", "tab_id": "tab_2", "number": 2, "label": "build" },
                    { "workspace_id": "ws_2", "number": 3, "label": "no id: skipped" },
                    { "workspace_id": "ws_2", "tab_id": "tab_4", "number": 4 },
                    { "workspace_id": "ws_2", "tab_id": "tab_5", "number": 5, "label": null }
                ],
                "panes": [
                    { "workspace_id": "ws_1", "tab_id": "tab_1", "pane_id": "pane_1" },
                    { "workspace_id": "ws_1", "tab_id": "tab_1", "pane_id": "pane_2" },
                    { "workspace_id": "ws_2", "tab_id": "tab_2", "pane_id": "pane_3" },
                    { "workspace_id": "ws_2", "pane_id": "no id: skipped" }
                ],
                "agents": []
            }
        }
    })]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot?workspace_id=ws_1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    // Only ws_1's rows survive the filter.
    let tabs = body["result"]["snapshot"]["tabs"].as_array().unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0]["workspace_id"], "ws_1");
    let panes = body["result"]["snapshot"]["panes"].as_array().unwrap();
    assert_eq!(panes.len(), 2);
    assert!(panes.iter().all(|pane| pane["workspace_id"] == "ws_1"));
    // The maps cover both workspaces regardless of the filter. The three
    // malformed ws_2 tabs (no tab_id, missing label, null label) still count
    // toward ws_2's totals but must never reach the label map. The no-id
    // ws_2 pane row counts toward ws_2's pane total the same way and must
    // never reach the pane map.
    assert_eq!(body["result"]["workspaces_by_id"]["ws_2"]["label"], "two");
    assert_eq!(
        body["result"]["workspace_counts"],
        json!({ "ws_1": { "tabs": 1, "panes": 2 }, "ws_2": { "tabs": 4, "panes": 2 } })
    );
    // The label map covers the dropped ws_2 tab: the agents list falls back
    // to it when its tab row is filtered out, so the panel name survives a
    // workspace switch.
    assert_eq!(
        body["result"]["tab_labels_by_id"],
        json!({ "tab_1": "Shell", "tab_2": "build" })
    );
    // The full-row maps keep every workspace's records regardless of the
    // filter: the pane tree resolves bare tab ids through them, so rows
    // the filter dropped must stay reachable. tabs_by_id keeps every
    // id-carrying row (label or not: 4 of the 5 tabs; the no-id row never
    // reaches the map). The pane map groups by tab_id (lists).
    assert_eq!(body["result"]["tabs_by_id"].as_object().unwrap().len(), 4);
    assert_eq!(
        body["result"]["tabs_by_id"]["tab_2"]["workspace_id"],
        "ws_2"
    );
    assert_eq!(
        body["result"]["tabs_by_id"]["tab_5"],
        json!({ "workspace_id": "ws_2", "tab_id": "tab_5", "number": 5, "label": null })
    );
    assert_eq!(
        body["result"]["panes_by_id"],
        json!({
            "tab_1": [
                { "workspace_id": "ws_1", "tab_id": "tab_1", "pane_id": "pane_1" },
                { "workspace_id": "ws_1", "tab_id": "tab_1", "pane_id": "pane_2" }
            ],
            "tab_2": [
                { "workspace_id": "ws_2", "tab_id": "tab_2", "pane_id": "pane_3" }
            ]
        })
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// A backend result that is not a session-snapshot envelope (no result object
// at all) must pass through the wrapper untouched: no workspace_order, no
// worktree_results, no cwd enrichment. The frontend's shape checks then keep
// the snapshot bootstrap enabled but unused, and legacy refresh handles it.
#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_non_envelope_result_gets_no_bootstrap_fields() {
    let (socket, handle) = fake_api_socket_multi(vec![
        json!({ "ok": true, "note": "not a snapshot envelope" }),
        // No worktree.list is queued for the non-envelope result. If the
        // wrapper wrongly issued one, the fake listener is already gone by
        // then, the connect fails, and the wrapper would still add no fields
        // because the result object is missing: the shape assertions below
        // are the contract.
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    state
        .workspace_orders
        .lock()
        .unwrap()
        .insert("default".to_string(), vec!["ws_9".to_string()]);
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(
        body.get("result"),
        None,
        "non-envelope body must pass through untouched"
    );
    assert!(
        body.pointer("/result/workspace_order").is_none(),
        "no workspace_order on a non-envelope result"
    );
    assert!(
        body.pointer("/result/worktree_results").is_none(),
        "no worktree_results on a non-envelope result"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// An error body from session.snapshot itself passes through with the same
// status semantics as the legacy endpoints: 200, body untouched. The
// frontend shape check rejects it (no snapshot.workspaces), the refresh
// falls back to the legacy calls, and the bootstrap stays enabled for the
// next round since the request itself did not fail.
#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_error_body_passes_through_untouched() {
    let (socket, handle) = fake_api_socket_multi(vec![
        json!({ "error": { "message": "session not running" } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(
        body["error"]["message"], "session not running",
        "backend error body must pass through untouched, same as legacy handlers"
    );
    assert!(
        body.pointer("/result/worktree_results").is_none(),
        "no bootstrap fields on an error body"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn create_workspace_handler_proxies_create() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.create",
        json!({ "id": "web:workspace:create", "result": { "id": "ws1" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let cwd = std::env::temp_dir();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "cwd": cwd.to_string_lossy(), "label": "test" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["id"], "ws1");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// The Actions UI stamps the selected session backend on every create
// call (x-herdr-backend). Creating a workspace while the browser
// targets the built-in backend must proxy workspace.create to the
// built-in session socket (auto-started), never to the external
// default API socket. The fake external socket below fails the test
// if it receives the create request.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn create_workspace_with_builtin_header_routes_to_builtin_backend() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-create-builtin-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // A fake external-herdr API socket that must stay untouched: if the
    // create request were misrouted there, the spawned handler would
    // accept it, reply with an id, and the drop guard below would panic
    // on join because the request never arrived (or the response would
    // carry the external marker label).
    let (external_socket, external_handle) = fake_api_socket_for_method(
        "workspace.create",
        json!({ "id": "web:workspace:create", "result": { "id": "external-ws" } }),
    );
    let session_name = "create-builtin";
    let mut state = test_state();
    state.api_socket = Some(external_socket.clone());
    // Hold a state clone so the shared builtin session registry (and
    // with it the started backend handle) outlives the oneshot request.
    let app = test_app_with_state(state.clone());

    let cwd = std::env::temp_dir();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-herdr-backend", "builtin")
                .header("x-herdr-session", session_name)
                .body(Body::from(
                    json!({ "cwd": cwd.to_string_lossy(), "label": "routing-test" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    // The built-in backend answers workspace.create with a workspace
    // result (id starts with ws_ / has workspace fields), and definitely
    // not the external fake marker.
    let result = body["result"].clone();
    assert!(
        result.get("id").and_then(Value::as_str) != Some("external-ws"),
        "create leaked to the external backend socket: {result}"
    );
    // The built-in backend answers workspace.create with a workspace
    // result: a workspace object (or workspace_id field) is present.
    let created_id = result
        .get("workspace")
        .and_then(|workspace| workspace.get("workspace_id"))
        .or_else(|| result.get("workspace_id"))
        .or_else(|| result.get("id"));
    assert!(
        created_id.is_some(),
        "built-in backend did not return a workspace result: {result}"
    );
    // The built-in session must be running for the answered session.
    let (builtin_api, _) = builtin_socket_paths(Some(session_name));
    assert!(connect_local_stream(&builtin_api).is_ok());

    let _ = fs::remove_dir_all(&config_home);
    let _ = fs::remove_file(&external_socket);
    drop(external_handle);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// Mirrors the above for worktree creation: the Actions UI worktree
// create flow also routes through the selected session backend.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn create_worktree_with_builtin_header_routes_to_builtin_backend() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-wt-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // The worktree create handler performs git checks locally, then
    // proxies the create to the backend. A request without branch/path
    // is rejected early by the built-in backend, but the key assertion
    // is which socket the proxy talks to: seed the external fake socket
    // with a marker reply; if the request lands there, the response
    // leaks the marker.
    let (external_socket, external_handle) = fake_api_socket_for_method(
        "worktree.create",
        json!({ "id": "web:worktree:create", "result": { "id": "external-wt" } }),
    );
    let session_name = "wt1";
    let mut state = test_state();
    state.api_socket = Some(external_socket.clone());
    // Hold a state clone so the started built-in backend outlives the
    // oneshot request (the router is consumed and dropped after it).
    let app = test_app_with_state(state.clone());

    let cwd = std::env::temp_dir().join("herdr-webui-wt-src");
    let _ = fs::create_dir_all(&cwd);
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees")
                .header(header::CONTENT_TYPE, "application/json")
                .header("x-herdr-backend", "builtin")
                .header("x-herdr-session", session_name)
                .body(Body::from(
                    json!({ "cwd": cwd.to_string_lossy(), "path": "", "branch": "" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(response).await;
    // Either the built-in backend rejected the empty worktree (fine)
    // or it answered; in both cases the external fake marker must be
    // absent from the response.
    let body_text = body.to_string();
    assert!(
        !body_text.contains("external-wt"),
        "worktree create leaked to the external backend socket: {body_text}"
    );
    let (builtin_api, _) = builtin_socket_paths(Some(session_name));
    assert!(
        connect_local_stream(&builtin_api).is_ok(),
        "built-in session socket missing after worktree create; body: {body_text}; socket: {}",
        builtin_api.display()
    );

    let _ = fs::remove_dir_all(&config_home);
    let _ = fs::remove_file(&external_socket);
    drop(external_handle);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[tokio::test]
async fn rename_workspace_handler_proxies_rename() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.rename",
        json!({ "id": "web:workspace:rename", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces/ws-abc/rename")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "label": "new name" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn close_workspace_handler_proxies_close() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.close",
        json!({ "id": "web:workspace:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces/ws-xyz/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn create_tab_handler_proxies_create() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.create",
        json!({ "id": "web:tab:create", "result": { "id": "tab1" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "workspace_id": "ws1", "label": "tab" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["id"], "tab1");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn rename_tab_handler_proxies_rename() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.rename",
        json!({ "id": "web:tab:rename", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-42/rename")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "label": "renamed" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn close_tab_handler_proxies_close() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.close",
        json!({ "id": "web:tab:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-99/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// Promote proxies the tab id and relays the full result payload (the
// browser navigates from the workspace/tab/pane fields in it). A success
// also records the promoted workspace in recent workspaces, using the
// cwd/label from the result.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn promote_tab_handler_proxies_promote_and_relays_result() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-promote-recent-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&config_home).unwrap();
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let (socket, handle) = fake_api_socket_for_method(
        "tab.promote",
        json!({
            "id": "web:tab:promote",
            "result": {
                "type": "tab_promoted",
                "workspace_created": true,
                "workspace": { "id": "ws-77", "label": "promoted", "cwd": "/repo/promoted" },
                "tab": { "id": "tab-99" },
                "root_pane": { "id": "pane-1" }
            }
        }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state.clone());

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-99/promote")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["type"], "tab_promoted");
    assert_eq!(body["result"]["workspace_created"], true);
    assert_eq!(body["result"]["workspace"]["id"], "ws-77");
    assert_eq!(body["result"]["tab"]["id"], "tab-99");
    assert_eq!(body["result"]["root_pane"]["id"], "pane-1");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    // The tab id was recorded in the promoted-tabs registry so the
    // terminal WS teardown can never auto-close it, even if the release
    // toggle frame was lost.
    assert!(
        state.promoted_temporary_tabs.lock().unwrap().get("tab-99")
            == Some(&PromotedTemporaryTabState::Promoted),
        "promoted tab must be recorded in the promoted-tabs registry"
    );

    // The promoted cwd/label were recorded in recents.
    {
        let guard = state.server_settings.lock().unwrap();
        let recent = &guard.recent_workspaces;
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].path, "/repo/promoted");
        assert_eq!(recent[0].label.as_deref(), Some("promoted"));
        assert_eq!(recent[0].kind.as_deref(), Some("workspace"));
    }
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// A backend error envelope (e.g. same-workspace rejection) must relay
/// the error AND leave the tab closable: the in-flight marker armed by
/// begin_temporary_tab_promote must be decremented back to zero and
/// removed, so the terminal WS teardown auto-closes the tab as usual.
#[cfg(unix)]
#[tokio::test]
async fn promote_tab_handler_failure_restores_closable_state() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.promote",
        json!({
            "id": "web:tab:promote",
            "error": { "code": "builtin_error", "message": "tab tab-98 already runs in workspace ws-1" }
        }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state.clone());

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-98/promote")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(response).await;
    assert_eq!(
        body["error"]["message"],
        "tab tab-98 already runs in workspace ws-1"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    // The guard must be fully released: no marker for this tab remains.
    assert!(
        state
            .promoted_temporary_tabs
            .lock()
            .unwrap()
            .get("tab-98")
            .is_none(),
        "failed promote must remove the in-flight marker so teardown auto-closes again"
    );
}

/// A dead backend socket (daemon stopped mid-call) surfaces BAD_GATEWAY
/// and also restores closable state.
#[cfg(unix)]
#[tokio::test]
async fn promote_tab_handler_backend_failure_restores_closable_state() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.promote",
        json!({ "id": "web:tab:promote", "error": { "code": "builtin_error", "message": "backend socket closed" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state.clone());

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-97/promote")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = response_json(response).await;
    assert!(
        body["error"].is_object(),
        "backend failure must relay an error, got {body}"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
    assert!(
        state
            .promoted_temporary_tabs
            .lock()
            .unwrap()
            .get("tab-97")
            .is_none(),
        "backend-failed promote must release the in-flight guard"
    );
}

/// A dead backend socket (removed path) must surface 502 through the
/// route's single Err arm and also release the in-flight guard, exactly
/// like a backend error envelope: connect_local_stream fails before a
/// request is ever written.
#[cfg(unix)]
#[tokio::test]
async fn promote_tab_handler_dead_socket_restores_closable_state() {
    let missing = std::env::temp_dir().join(format!(
        "herdr-webui-promote-missing-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let mut state = test_state();
    state.api_socket = Some(missing.clone());
    let app = test_app_with_state(state.clone());

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/tab-96/promote")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert!(
        body["error"].as_str().is_some_and(|err| !err.is_empty()),
        "dead socket must relay a join-failure error, got {body}"
    );
    assert!(
        state
            .promoted_temporary_tabs
            .lock()
            .unwrap()
            .get("tab-96")
            .is_none(),
        "dead-socket promote must release the in-flight guard"
    );
}

/// A panic inside the spawn_blocking backend call must keep propagating
/// after the join failure is folded: promote_join_failure resumes the
/// original panic payload instead of degrading it to a 502 message.
#[tokio::test]
#[should_panic(expected = "join-panic probe")]
async fn promote_join_failure_propagates_backend_panic() {
    let join = tokio::task::spawn_blocking(|| panic!("join-panic probe"))
        .await
        .unwrap_err();
    promote_join_failure(join);
}

/// A cancelled spawn_blocking task yields a JoinError that is not a
/// panic: promote_join_failure must degrade it to its message string so
/// the route answers 502 and restores auto-close. The runtime has a
/// single blocking thread, which the `parked` task holds in
/// blocking_recv: the probe is still queued behind it (the pool is
/// FIFO) when aborted, so its closure never runs. The park is released
/// only after the abort so the pool thread dequeues the cancelled
/// probe and resolves its JoinHandle as cancelled.
#[test]
fn promote_join_failure_degrades_cancelled_task_to_message() {
    let rt = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    rt.block_on(async {
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let parked = tokio::task::spawn_blocking(move || {
            // Hold the only blocking thread until the probe has been
            // aborted. A plain drop(release_rx) returned immediately,
            // the probe grabbed the freed slot and ran its closure
            // before abort() landed, flaking CI ("probe task must be
            // cancelled, not run").
            let _ = release_rx.blocking_recv();
        });
        let queued = tokio::task::spawn_blocking(|| unreachable!());
        // The probe is queued behind the parked task, so aborting now
        // marks it cancelled before it can ever run.
        queued.abort();
        // Free the blocking thread: it pops the cancelled probe, skips
        // its closure, and completes the JoinHandle as cancelled.
        let _ = release_tx.send(());
        let join = queued.await.unwrap_err();
        assert!(join.is_cancelled(), "probe task must be cancelled, not run");
        let message = promote_join_failure(join);
        assert!(
            message.contains("cancelled"),
            "join failure must degrade to its message, got {message}"
        );
        let _ = parked.await;
    });
}

/// An unauthenticated promote request must be rejected before the route
/// arms the in-flight guard: the registry stays untouched so the tab
/// keeps its normal auto-close semantics.
#[tokio::test]
async fn promote_tab_handler_rejects_unauthenticated() {
    let state = test_state();
    let app = test_app_with_state(state.clone());

    let response = app
        .oneshot(
            request(Method::POST, "/api/tabs/tab-99/promote")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert!(
        state.promoted_temporary_tabs.lock().unwrap().is_empty(),
        "rejected promote must never arm the in-flight guard"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn close_pane_handler_proxies_close() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.close",
        json!({ "id": "web:pane:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/panes/pane-7/close")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn remove_worktree_handler_proxies_remove() {
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.remove",
        json!({ "id": "web:worktree:remove", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces/ws-1/worktree-remove")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "force": true }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
// lock_env() serializes env-mutating tests; held across await on purpose
// so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn open_worktree_handler_proxies_open() {
    let _env = lock_env();
    // The authed open records a recent workspace, which persists server
    // settings; keep that write inside a temp config dir so the real
    // operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-worktree-proxy-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.open",
        json!({ "id": "web:worktree:open", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
            .oneshot(
                authed_request(Method::POST, "/api/worktrees/open")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "workspace_id": "ws1", "cwd": "/tmp", "path": "/tmp/wt", "branch": "main", "label": "wt" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── workspaces handler (two sequential requests + enrich) ──

#[cfg(unix)]
#[tokio::test]
async fn workspaces_handler_proxies_list_and_enriches_cwds() {
    let (socket, handle) = fake_api_socket_multi(vec![
        // workspace.list response
        json!({ "id": "web:workspace:list", "result": { "workspaces": [
            { "workspace_id": "ws1", "label": "workspace one", "cwd": null }
        ]}}),
        // pane.list response for enrichment
        json!({ "id": "web:pane:list:workspace-cwds", "result": { "panes": [
            { "workspace_id": "ws1", "cwd": "/home/user/project", "foreground_cwd": "/home/user/project/src" }
        ]}}),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let ws = &body["result"]["workspaces"][0];
    assert_eq!(ws["workspace_id"], "ws1");
    assert_eq!(ws["cwd"], "/home/user/project");
    assert_eq!(ws["foreground_cwd"], "/home/user/project/src");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

#[cfg(unix)]
#[tokio::test]
async fn workspaces_handler_returns_bad_gateway_on_error() {
    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-workspaces-test.sock"));
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
}

// ── git_branches handler ──

#[tokio::test]
async fn git_branches_handler_requires_cwd() {
    let app = test_app();

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/git-branches")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["error"], "cwd is required");
}

#[tokio::test]
async fn git_branches_handler_returns_branches_from_repo() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-git-branches-api-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init"
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/test"])
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(
                Method::GET,
                &format!("/api/git-branches?cwd={}", repo.to_string_lossy()),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let branches = body["branches"].as_array().unwrap();
    let names: Vec<&str> = branches.iter().map(|v| v.as_str().unwrap()).collect();
    assert!(names.contains(&"main") || names.contains(&"master"));
    assert!(names.contains(&"feature/test"));

    fs::remove_dir_all(&repo).unwrap();
}

#[tokio::test]
async fn git_branches_handler_returns_error_for_nonexistent_repo() {
    let app = test_app();
    let response = app
        .oneshot(
            authed_request(
                Method::GET,
                "/api/git-branches?cwd=/tmp/nonexistent-git-repo-xyz",
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert!(body["error"].as_str().is_some_and(|e| !e.is_empty()));
}

// ── launch_session error paths ──

#[tokio::test]
async fn launch_session_rejects_disabled_backend() {
    let state = test_state();
    // Disable both backends via settings
    if let Ok(mut settings) = state.server_settings.lock() {
        settings.builtin_backend_enabled = false;
        settings.external_herdr_backend_enabled = false;
    }
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"]
        .as_str()
        .is_some_and(|e| e.contains("disabled")));
}

#[cfg(unix)]
fn write_version_script(root: &std::path::Path, version_output: &str) -> String {
    use std::os::unix::fs::PermissionsExt;
    let script = root.join("fake-herdr");
    fs::write(&script, format!("#!/bin/sh\necho '{version_output}'\n")).unwrap();
    let mut permissions = fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&script, permissions).unwrap();
    script.display().to_string()
}

#[cfg(unix)]
#[test]
fn detect_herdr_install_classifies_detected_versions() {
    let root = std::env::temp_dir().join(format!(
        "herdr-webui-detect-install-test-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();

    // Compatible install: herdr 0.9.0 (matches the supported range).
    let bin = write_version_script(&root, "herdr 0.9.0");
    let install = detect_herdr_install(&bin);
    assert_eq!(install.version.as_deref(), Some("0.9.0"));
    assert!(install.available());
    assert!(install.compatible);

    // Protocol too old: herdr 0.8.0 must be flagged incompatible.
    let bin = write_version_script(&root, "herdr 0.8.0");
    let install = detect_herdr_install(&bin);
    assert_eq!(install.version.as_deref(), Some("0.8.0"));
    assert!(install.available());
    assert!(!install.compatible);

    // Newer untested release: still offered, matching the versions API.
    let bin = write_version_script(&root, "herdr 0.9.1");
    let install = detect_herdr_install(&bin);
    assert_eq!(install.version.as_deref(), Some("0.9.1"));
    assert!(install.compatible);

    // No version in output: treated as not detected.
    let bin = write_version_script(&root, "hello world");
    let install = detect_herdr_install(&bin);
    assert!(!install.available());

    // Missing binary: not detected.
    let install = detect_herdr_install("/nonexistent/herdr-bin-xyz");
    assert_eq!(install, HerdrInstall::default());

    let _ = fs::remove_dir_all(&root);
}

#[tokio::test]
async fn launch_session_rejects_incompatible_detected_herdr() {
    let root = std::env::temp_dir().join(format!(
        "herdr-webui-launch-compat-test-{}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&root);
    fs::create_dir_all(&root).unwrap();
    let bin = write_version_script(&root, "herdr 0.8.0");

    let mut state = test_state();
    state.herdr_bin = bin;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    let error = body["error"].as_str().unwrap_or_default();
    assert!(error.contains("0.8.0"), "error mentions detected version");
    assert!(
        error.contains("compatible"),
        "error explains incompatibility"
    );

    let _ = fs::remove_dir_all(&root);
}

#[tokio::test]
async fn launch_session_rejects_missing_herdr_install() {
    let mut state = test_state();
    state.herdr_bin = "/nonexistent/herdr-bin-xyz".to_string();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // Now rejected before spawn, instead of BAD_GATEWAY from spawn failure.
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("herdr binary not found"),
        "error explains missing install"
    );
}

#[tokio::test]
async fn launch_session_returns_error_when_herdr_bin_not_found() {
    let mut state = test_state();
    state.herdr_bin = "/nonexistent/herdr-bin-xyz".to_string();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // The install gate rejects before spawn, so this is now a clean
    // BAD_REQUEST with an actionable message instead of BAD_GATEWAY.
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(
        body["error"]
            .as_str()
            .unwrap_or_default()
            .contains("herdr binary not found"),
        "error explains the missing install"
    );
}

#[cfg(unix)]
fn fake_herdr_version_script() -> (String, TempDirGuard) {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!(
        "herdr-webui-launch-test-{}-{}",
        std::process::id(),
        std::thread::current().name().unwrap_or("t")
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let guard = TempDirGuard::new(root.clone());
    let script = root.join("fake-herdr");
    std::fs::write(
        &script,
        "#!/bin/sh\ncase \"$1\" in\n--version) echo 'herdr 0.9.0'; exit 0;;\nesac\nexit 0\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&script, permissions).unwrap();
    (script.display().to_string(), guard)
}

#[tokio::test]
async fn launch_session_external_succeeds_with_true_command() {
    // A fake herdr reporting a compatible version; any launch args make it
    // exit 0 like /usr/bin/true so the launch handler sees success.
    let mut state = test_state();
    let (script, _script_guard) = fake_herdr_version_script();
    state.herdr_bin = script;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test-launch", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert!(body["pid"].as_u64().is_some());
}

#[tokio::test]
async fn launch_session_default_session_omits_env() {
    let mut state = test_state();
    let (script, _script_guard) = fake_herdr_version_script();
    state.herdr_bin = script;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["session"], "default");
}

// ── close_session builtin backend path ──

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn close_session_builtin_backend_uses_builtin_socket_namespace() {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-close-builtin-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // Compute the socket path that builtin_socket_paths will return
    let session_name = "test-builtin-close";
    let (api_socket, _) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    let _ = fs::remove_file(&api_socket);

    // Create a fake backend listener directly at the builtin socket path
    let name = api_socket.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let saw_stop = std::sync::Arc::new(std::sync::Mutex::new(false));
    let saw_stop_clone = saw_stop.clone();
    let handle = thread::spawn(move || {
        let stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        if request["method"] == "server.stop" {
            *saw_stop_clone.lock().unwrap() = true;
            // Drop the connection without responding, simulating backend shutdown.
            drop(stream);
        }
    });

    let mut state = test_state();
    state.backend_mode = BackendMode::Builtin;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // close_session on a builtin session calls proxy_server_stop which
    // treats connection drop as OK.
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert!(
        *saw_stop.lock().unwrap(),
        "backend should have received server.stop"
    );
    handle.join().unwrap();
    let _ = fs::remove_file(&api_socket);
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[tokio::test]
async fn close_session_rejects_disabled_backend() {
    let state = test_state();
    if let Ok(mut settings) = state.server_settings.lock() {
        settings.external_herdr_backend_enabled = false;
    }
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"]
        .as_str()
        .is_some_and(|e| e.contains("disabled")));
}

// ── snapshot enrichment helpers ──

#[test]
fn enrich_workspace_cwds_fills_only_missing_fields_from_panes() {
    let mut workspaces = json!({
        "result": {
            "workspaces": [
                { "workspace_id": "ws-a", "name": "alpha" },
                { "workspace_id": "ws-b", "cwd": "/kept" },
                { "workspace_id": "ws-c" }
            ]
        }
    });
    let panes = json!({
        "result": {
            "panes": [
                { "workspace_id": "ws-a", "cwd": "/alpha/cwd", "foreground_cwd": "/alpha/fg" },
                { "workspace_id": "ws-a", "cwd": "/duplicate/ignored", "foreground_cwd": "/dupe/fg" },
                { "workspace_id": "ws-b", "cwd": "/ignored-builtin-wins", "foreground_cwd": "/b/fg" },
                { "workspace_id": "", "cwd": "/no-id" },
                { "cwd": "/missing-id-field" }
            ]
        }
    });
    enrich_workspace_cwds(&mut workspaces, &panes);

    let rows = workspaces
        .pointer("/result/workspaces")
        .and_then(serde_json::Value::as_array)
        .unwrap();
    // First pane wins for duplicate workspace entries.
    assert_eq!(rows[0]["cwd"].as_str(), Some("/alpha/cwd"));
    assert_eq!(rows[0]["foreground_cwd"].as_str(), Some("/alpha/fg"));
    // An existing cwd is kept; only the missing foreground_cwd is filled.
    assert_eq!(rows[1]["cwd"].as_str(), Some("/kept"));
    assert_eq!(rows[1]["foreground_cwd"].as_str(), Some("/b/fg"));
    // No pane data means no fields are added.
    assert!(rows[2].get("cwd").is_none());
    assert!(rows[2].get("foreground_cwd").is_none());
}

#[test]
fn enrich_workspace_cwds_without_pane_array_is_noop() {
    let mut workspaces = json!({
        "result": {
            "workspaces": [ { "workspace_id": "ws-a" } ]
        }
    });
    let panes = json!({ "result": {} });
    enrich_workspace_cwds(&mut workspaces, &panes);
    assert!(workspaces
        .pointer("/result/workspaces/0")
        .is_some_and(|w| w.get("cwd").is_none()));
}

#[test]
fn snapshot_counts_by_workspace_tallies_and_skips_non_strings() {
    let rows = json!([
        { "workspace_id": "ws-a" },
        { "workspace_id": "ws-a" },
        { "workspace_id": "ws-b" },
        { "workspace_id": 42 },
        { "name": "no id" }
    ]);
    let counts = snapshot_counts_by_workspace(Some(&rows));
    assert_eq!(
        counts.get("ws-a").and_then(serde_json::Value::as_i64),
        Some(2)
    );
    assert_eq!(
        counts.get("ws-b").and_then(serde_json::Value::as_i64),
        Some(1)
    );
    assert!(counts.get("42").is_none());
    assert_eq!(counts.len(), 2);
}

#[test]
fn snapshot_counts_by_workspace_without_rows_returns_empty_map() {
    let counts = snapshot_counts_by_workspace(None);
    assert!(counts.is_empty());
    let non_array = json!({ "result": {} });
    let counts = snapshot_counts_by_workspace(Some(&non_array));
    assert!(counts.is_empty());
}

#[test]
fn filter_snapshot_rows_by_workspace_keeps_only_matching_rows() {
    let mut value = json!({
        "result": {
            "tabs": [
                { "workspace_id": "ws-a", "title": "keep" },
                { "workspace_id": "ws-b", "title": "drop" }
            ],
            "panes": [
                { "workspace_id": "ws-a", "pane": 1 },
                { "workspace_id": "ws-b", "pane": 2 }
            ],
            "workspaces": [ { "workspace_id": "ws-b" } ]
    }
    });
    filter_snapshot_rows_by_workspace(&mut value, "/result/tabs", "ws-a");
    filter_snapshot_rows_by_workspace(&mut value, "/result/panes", "ws-a");
    assert_eq!(
        value
            .pointer("/result/tabs")
            .and_then(serde_json::Value::as_array)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        value
            .pointer("/result/tabs/0/title")
            .and_then(serde_json::Value::as_str),
        Some("keep")
    );
    assert_eq!(
        value
            .pointer("/result/panes")
            .and_then(serde_json::Value::as_array)
            .unwrap()
            .len(),
        1
    );
    // Untouched pointers keep their rows.
    assert_eq!(
        value
            .pointer("/result/workspaces")
            .and_then(serde_json::Value::as_array)
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn filter_snapshot_rows_by_workspace_missing_pointer_is_noop() {
    let mut value = json!({ "result": {} });
    filter_snapshot_rows_by_workspace(&mut value, "/result/missing", "ws-a");
    assert_eq!(value.pointer("/result"), Some(&json!({})));
}

// ── remove_worktree_path with real git repo ──

#[tokio::test]
async fn remove_worktree_path_handler_removes_worktree_from_repo() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-remove-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());

    // Create a worktree
    let wt_path = repo.with_extension("wt");
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "worktree",
            "add",
            &wt_path.to_string_lossy(),
            "-b",
            "feature"
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(wt_path.exists());

    // Remove it via the handler
    let app = test_app();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees/remove-path")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "repo_root": repo.to_string_lossy(),
                        "path": wt_path.to_string_lossy(),
                        "force": false,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert!(!wt_path.exists());

    fs::remove_dir_all(&repo).unwrap();
}

#[tokio::test]
async fn remove_worktree_path_handler_returns_error_for_nonexistent_path() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-remove-err-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees/remove-path")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "repo_root": repo.to_string_lossy(),
                        "path": "/tmp/nonexistent-worktree-path",
                        "force": false,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert!(body["error"].as_str().is_some_and(|e| !e.is_empty()));

    fs::remove_dir_all(&repo).unwrap();
}

// ── create_worktree Default phase (no branch, proxies to backend) ──

#[cfg(unix)]
#[tokio::test]
async fn create_worktree_default_phase_proxies_to_backend() {
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.create",
        json!({ "id": "web:worktree:create", "result": { "ok": true, "workspace_id": "ws1" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    // No branch specified -> Default phase -> proxies to backend
    let response = app
            .oneshot(
                authed_request(Method::POST, "/api/worktrees")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(
                        json!({ "workspace_id": "ws1", "cwd": "/tmp", "path": "/tmp/wt", "label": "test" }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["workspace_id"], "ws1");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── create_worktree with pull_base error ──

#[tokio::test]
async fn create_worktree_pull_base_error_returns_bad_request() {
    let app = test_app();

    // pull_base=true with a nonexistent cwd should cause git pull to fail
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "cwd": "/tmp/nonexistent-repo-for-pull-base",
                        "path": "/tmp/wt-test",
                        "branch": "feature",
                        "pull_base": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"].as_str().is_some_and(|e| !e.is_empty()));
}

// ── pull_base_branch honors --ff-only even with pull.rebase configured ──
// A repo-local pull.rebase=true plus a dirty tree must not turn the promised
// fast-forward pull into a failed rebase ("cannot pull with rebase: You have
// unstaged changes").
#[test]
fn pull_base_branch_fast_forwards_despite_rebase_config_and_dirty_tree() {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let origin = std::env::temp_dir().join(format!("herdr-webui-pull-origin-{stamp}"));
    let clone = std::env::temp_dir().join(format!("herdr-webui-pull-clone-{stamp}"));
    let _ = fs::remove_dir_all(&origin);
    let _ = fs::remove_dir_all(&clone);

    let git = |cwd: Option<&Path>, args: &[&str]| {
        let mut cmd = Command::new("git");
        if let Some(dir) = cwd {
            cmd.arg("-C").arg(dir);
        }
        assert!(cmd.args(args).output().unwrap().status.success());
    };

    git(None, &["init", "-b", "main", origin.to_str().unwrap()]);
    fs::write(origin.join("file.txt"), "one").unwrap();
    fs::write(origin.join("tracked.txt"), "clean").unwrap();
    git(Some(&origin), &["add", "."]);
    git(
        Some(&origin),
        &[
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ],
    );
    git(
        None,
        &["clone", origin.to_str().unwrap(), clone.to_str().unwrap()],
    );
    // The problematic configuration: pulls become rebases.
    git(Some(&clone), &["config", "pull.rebase", "true"]);
    // Unstaged change to a tracked file: a rebase refuses to start here,
    // a fast-forward does not.
    fs::write(clone.join("tracked.txt"), "dirty").unwrap();
    // Advance origin on a different file so the clone is strictly behind
    // and fast-forwardable.
    fs::write(origin.join("file.txt"), "two").unwrap();
    git(Some(&origin), &["add", "."]);
    git(
        Some(&origin),
        &[
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "advance",
        ],
    );

    // Negative control: without --no-rebase the configured rebase fails
    // on the dirty tree, which is the bug the fix removes.
    let old = Command::new("git")
        .arg("-C")
        .arg(&clone)
        .args(["pull", "--ff-only", "origin", "main"])
        .output()
        .unwrap();
    assert!(!old.status.success());
    assert!(String::from_utf8_lossy(&old.stderr).contains("cannot pull with rebase"));
    // The failed pull must not have moved the branch.
    let head_before = Command::new("git")
        .arg("-C")
        .arg(&clone)
        .args(["log", "-1", "--format=%s"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&head_before.stdout).trim(), "init");

    let clone_str = clone.to_string_lossy().to_string();
    pull_base_branch(&clone_str, "main").expect("fast-forward pull must succeed");
    let head = Command::new("git")
        .arg("-C")
        .arg(&clone)
        .args(["log", "-1", "--format=%s"])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&head.stdout).trim(), "advance");
    // The unstaged modification must survive the fast-forward.
    assert_eq!(
        fs::read_to_string(clone.join("tracked.txt")).unwrap(),
        "dirty"
    );
    let status = Command::new("git")
        .arg("-C")
        .arg(&clone)
        .args(["status", "--porcelain"])
        .output()
        .unwrap();
    // trim_end, not trim: the unstaged marker is a leading space that
    // trim would eat, turning " M" into "M" (the staged marker).
    assert_eq!(
        String::from_utf8_lossy(&status.stdout).trim_end(),
        " M tracked.txt"
    );

    let _ = fs::remove_dir_all(&origin);
    let _ = fs::remove_dir_all(&clone);
}

// ── create_worktree with existing branch in a real git repo (NativeCreate or LegacyOpen) ──

#[cfg(unix)]
#[tokio::test]
async fn create_worktree_existing_branch_proxies_to_backend() {
    // Set up a real git repo with an existing branch
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-cwt-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/existing"])
        .output()
        .unwrap()
        .status
        .success());

    // HerdrWorktreeApi::detect sends a ping first, then the handler
    // sends worktree.create.  Use fake_api_socket_multi to handle both.
    let (socket, handle) = fake_api_socket_multi(vec![
        // Response to ping (backend_info detection)
        json!({ "id": "web:ping", "result": { "version": "0.7.1" } }),
        // Response to worktree.create
        json!({ "id": "web:worktree:create", "result": { "ok": true, "workspace_id": "ws-new" } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let wt_path = std::env::temp_dir().join(format!(
        "herdr-webui-wt-path-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "cwd": repo.to_string_lossy(),
                        "path": wt_path.to_string_lossy(),
                        "branch": "feature/existing",
                        "label": "test-wt",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // Should be OK (either NativeCreate or LegacyOpen path, both proxy to backend)
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&wt_path);
}

// ── versions handler with spawn_blocking backend_info ──

#[cfg(unix)]
#[tokio::test]
async fn versions_handler_returns_bad_gateway_on_missing_socket() {
    let mut state = test_state();
    state.api_socket = Some(PathBuf::from("/tmp/nonexistent-versions-test.sock"));
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/versions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // backend_info returns default (no version, no protocol)
    // and external-herdr mode checks compatibility which should still be OK
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["compatibility"]["compatible"].as_bool().is_some());
}

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_ok_when_backend_responds_normally() {
    let (socket, handle) = fake_api_socket_for_method(
        "server.stop",
        json!({ "id": "web:server:stop", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["ok"], true);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── launch_session with builtin backend ──

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn launch_session_builtin_backend_starts_session() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-launch-builtin-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let state = test_state();
    // Enable builtin backend in settings
    if let Ok(mut settings) = state.server_settings.lock() {
        settings.builtin_backend_enabled = true;
        settings.external_herdr_backend_enabled = true;
    }
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test-builtin-launch", "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // Builtin session should start (or already be running) successfully
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["backend"], "builtin");

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── remove_worktree_path with force=true ──

#[tokio::test]
async fn remove_worktree_path_handler_with_force_succeeds() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-force-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    let wt_path = repo.with_extension("wt-force");
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "worktree",
            "add",
            &wt_path.to_string_lossy(),
            "-b",
            "feature-force"
        ])
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees/remove-path")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "repo_root": repo.to_string_lossy(),
                        "path": wt_path.to_string_lossy(),
                        "force": true,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert!(!wt_path.exists());
    fs::remove_dir_all(&repo).unwrap();
}

/// remove_worktree_path rejects unauthenticated requests.
#[tokio::test]
async fn remove_worktree_path_rejects_unauthenticated() {
    let response = test_app()
        .oneshot(
            request(Method::POST, "/api/worktrees/remove-path")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"repo_root": "/tmp", "path": "/tmp/wt"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[cfg(unix)]
#[tokio::test]
async fn session_snapshot_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "session.snapshot",
        json!({ "id": "web:session:snapshot", "result": { "workspaces": [] } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/session-snapshot")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── proxy_server_stop with normal response (not connection drop) ──

#[cfg(unix)]
#[tokio::test]
async fn close_session_returns_backend_response_on_normal_stop() {
    let (socket, handle) = fake_api_socket_for_method(
        "server.stop",
        json!({ "id": "web:server:stop", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "default", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["ok"], true);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── create_worktree LegacyOpen path ──
// When backend version < 0.7.1 and branch exists, it does local checkout
// then proxies worktree.open

#[cfg(unix)]
#[tokio::test]
async fn create_worktree_legacy_open_for_old_backend() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-legacy-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/legacy"])
        .output()
        .unwrap()
        .status
        .success());

    let wt_path = std::env::temp_dir().join(format!(
        "herdr-webui-wt-legacy-path-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));

    // Old backend (version 0.7.0) -> needs legacy existing branch create
    // The handler sends ping (detect), then worktree.open after local checkout
    let (socket, handle) = fake_api_socket_multi(vec![
        // ping response - old version so it uses legacy path
        json!({ "id": "web:ping", "result": { "version": "0.7.0" } }),
        // worktree.open response
        json!({ "id": "web:worktree:open", "result": { "ok": true, "workspace_id": "ws-legacy" } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "cwd": repo.to_string_lossy(),
                        "path": wt_path.to_string_lossy(),
                        "branch": "feature/legacy",
                        "label": "legacy-wt",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&wt_path);
}

// ── git_branches with actual git repo ──

#[tokio::test]
async fn git_branches_handler_returns_branches_for_real_repo() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-git-branches-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/test"])
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(
                Method::GET,
                &format!("/api/git-branches?cwd={}", repo.to_string_lossy()),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let branches = body["branches"].as_array().unwrap();
    assert!(
        branches.iter().any(|b| b.as_str() == Some("feature/test")),
        "expected feature/test in branches: {branches:?}"
    );
    let _ = fs::remove_dir_all(&repo);
}

// ── git_branches with remote fetch (error path) ──

#[tokio::test]
async fn git_branches_handler_with_remote_fetch_returns_error() {
    // git fetch --all on a repo with no remote succeeds (exit 0),
    // so the handler should return 200 with branch list.
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-git-remote-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    let response = app
        .oneshot(
            authed_request(
                Method::GET,
                &format!(
                    "/api/git-branches?cwd={}&remote=true&fetch=true",
                    repo.to_string_lossy()
                ),
            )
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    // git fetch --all with no remote succeeds, so we get 200 with branches
    assert_eq!(
        response.status(),
        StatusCode::OK,
        "git fetch on repo with no remote should succeed"
    );
    let body = response_json(response).await;
    assert!(body["branches"].as_array().is_some());
    let _ = fs::remove_dir_all(&repo);
}

// ── proxy_request_async JoinError path ──
// Hard to trigger in tests (requires runtime shutdown), so we rely on
// the missing-socket tests which exercise Ok(Err(socket_err)).

// ── workspaces handler with pane.list failure ──
// When pane.list fails, the handler should still return workspace.list
// result without enrichment (graceful degradation).

#[cfg(unix)]
#[tokio::test]
async fn workspaces_handler_returns_list_even_when_pane_list_fails() {
    // workspace.list succeeds but pane.list fails (connection reset)
    // The handler uses the same socket for both, so the second request
    // will fail after the first succeeds. Use multi with only one response.
    let (socket, handle) = fake_api_socket_multi(vec![
        // Only workspace.list response; pane.list will fail
        json!({ "id": "web:workspace:list", "result": { "workspaces": [
            { "workspace_id": "ws1", "label": "test", "cwd": "/tmp" }
        ]}}),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/workspaces")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    // Should still be OK since workspace.list succeeded
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body.get("result").is_some());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── create_workspace success path ──

#[cfg(unix)]
#[tokio::test]
async fn create_workspace_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.create",
        json!({ "id": "web:workspace:create", "result": { "workspace_id": "ws-new" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "cwd": "/tmp", "label": "test-ws" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["result"]["workspace_id"], "ws-new");
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── rename_workspace success path ──

#[cfg(unix)]
#[tokio::test]
async fn rename_workspace_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.rename",
        json!({ "id": "web:workspace:rename", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces/ws1/rename")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "label": "renamed" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── close_workspace success path ──

#[cfg(unix)]
#[tokio::test]
async fn close_workspace_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "workspace.close",
        json!({ "id": "web:workspace:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/workspaces/ws1/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── create_tab success path ──

#[cfg(unix)]
#[tokio::test]
async fn create_tab_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.create",
        json!({ "id": "web:tab:create", "result": { "tab_id": "tab-new" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "workspace_id": "ws1", "label": "tab1" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── close_tab success path ──

#[cfg(unix)]
#[tokio::test]
async fn close_tab_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.close",
        json!({ "id": "web:tab:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/t1/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── close_pane success path ──

#[cfg(unix)]
#[tokio::test]
async fn close_pane_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "pane.close",
        json!({ "id": "web:pane:close", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/panes/p1/close")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── open_worktree success path ──

// lock_env() serializes env-mutating tests; held across await on purpose
// so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[cfg(unix)]
#[tokio::test]
async fn open_worktree_proxies_successfully() {
    let _env = lock_env();
    // The authed open records a recent workspace, which persists server
    // settings; keep that write inside a temp config dir so the real
    // operator config is never touched.
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-worktree-success-test-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);
    let (socket, handle) = fake_api_socket_for_method(
        "worktree.open",
        json!({ "id": "web:worktree:open", "result": { "ok": true, "workspace_id": "ws-wt" } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees/open")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "path": "/tmp/test-wt", "label": "wt1" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);

    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── rename_tab success path ──

#[cfg(unix)]
#[tokio::test]
async fn rename_tab_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "tab.rename",
        json!({ "id": "web:tab:rename", "result": { "ok": true } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/tabs/t1/rename")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "label": "renamed" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── create_worktree legacy checkout error ──
// When the worktree path already exists, git worktree add fails.

#[cfg(unix)]
#[tokio::test]
async fn create_worktree_legacy_checkout_error_on_existing_path() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-err-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["branch", "feature/err-test"])
        .output()
        .unwrap()
        .status
        .success());

    // Pre-create the worktree path with content so git worktree add fails
    let wt_path = std::env::temp_dir().join(format!(
        "herdr-webui-wt-err-path-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&wt_path).unwrap();
    fs::write(wt_path.join("existing.txt"), "content").unwrap();

    // Old backend so it uses legacy path
    let (socket, handle) = fake_api_socket_multi(vec![
        json!({ "id": "web:ping", "result": { "version": "0.7.0" } }),
    ]);
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "cwd": repo.to_string_lossy(),
                        "path": wt_path.to_string_lossy(),
                        "branch": "feature/err-test",
                        "label": "err-wt",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // git worktree add fails because path exists, should be 400
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"].as_str().is_some());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
    let _ = fs::remove_dir_all(&repo);
    let _ = fs::remove_dir_all(&wt_path);
}

// ── remove_worktree_path git command error ──

#[tokio::test]
async fn remove_worktree_path_returns_error_on_git_failure() {
    let repo = std::env::temp_dir().join(format!(
        "herdr-webui-wt-rm-err-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_dir_all(&repo);
    fs::create_dir_all(&repo).unwrap();
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());

    let app = test_app();
    // Try to remove a non-existent worktree path
    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/worktrees/remove-path")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({
                        "repo_root": repo.to_string_lossy(),
                        "path": "/nonexistent/worktree/path/xyz",
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert!(body["error"].as_str().is_some());
    let _ = fs::remove_dir_all(&repo);
}

// ── versions handler with actual socket ──

#[cfg(unix)]
#[tokio::test]
async fn versions_handler_proxies_successfully() {
    let (socket, handle) = fake_api_socket_for_method(
        "ping",
        json!({ "id": "web:ping", "result": { "version": "0.7.2", "protocol": 16 } }),
    );
    let mut state = test_state();
    state.api_socket = Some(socket.clone());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/versions")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body.get("backend").is_some());
    handle.join().unwrap();
    let _ = fs::remove_file(socket);
}

// ── builtin auto-start on workspace requests ──
// A browser pinning the built-in backend before any /api/session/launch
// used to get a 502 on every workspace list (the built-in session was
// never started), which made the Git UI fall back to the default folder.
// The workspaces handler must auto-start the built-in session instead.

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn workspaces_auto_starts_builtin_session() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-auto-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let session_name = "test-builtin-auto";
    // Hold a state clone so the shared builtin_sessions registry (and
    // with it the started backend handle) outlives the oneshot request:
    // oneshot consumes the router and would otherwise drop the handle
    // and tear the session down before we can verify it.
    let state = test_state();
    let app = test_app_with_state(state.clone());

    // No session launch: the request itself must start the backend.
    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/workspaces")
                .header("x-herdr-backend", "builtin")
                .header("x-herdr-session", session_name)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert!(body["result"]["workspaces"].is_array());

    // The built-in session must now be running and reachable: the
    // response came from it (no 502), and the api socket accepts
    // connections even for a fresh registry view.
    let (api_socket, _) = builtin_socket_paths(Some(session_name));
    assert!(connect_local_stream(&api_socket).is_ok());

    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// A fresh browser fires several workspace requests at once; concurrent
// auto-starts of the same built-in session must not race on the socket
// bind. Every caller must succeed (or find the session already running).
#[cfg(unix)]
#[test]
fn concurrent_ensure_builtin_session_starts_session_once() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-builtin-race-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let session_name = "test-builtin-race";
    let state = test_state();
    let barrier = Arc::new(std::sync::Barrier::new(8));
    let mut handles = Vec::new();
    for _ in 0..8 {
        let state = state.clone();
        let barrier = Arc::clone(&barrier);
        handles.push(std::thread::spawn(move || {
            barrier.wait();
            ensure_builtin_session(&state, Some(session_name))
        }));
    }
    for handle in handles {
        assert!(handle.join().unwrap().is_ok());
    }

    let (api_socket, _) = builtin_socket_paths(Some(session_name));
    assert!(connect_local_stream(&api_socket).is_ok());

    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// versions must expose the server's true configured default backend so
// fresh browsers adopt it; current_backend only echoes the request
// header and cannot drive that choice.
#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn versions_reports_default_backend_independent_of_request_header() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-versions-default-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    // Bind the fake ping listener at the built-in default session path:
    // the request targets the built-in backend, so that is the socket
    // versions actually pings. Bind it there directly instead of
    // moving a temp-dir socket with rename(), which fails with EXDEV
    // when temp_dir and the socket dir are on different filesystems.
    let (api_socket, _) = builtin_socket_paths(None);
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    let (_, handle) = fake_api_socket_for_method_at(
        api_socket.clone(),
        "ping",
        json!({ "id": "web:ping", "result": { "version": "0.9.0", "protocol": 22 } }),
    );

    let mut state = test_state();
    // Server configured external-herdr while the browser pins builtin.
    state.backend_mode = BackendMode::ExternalHerdr;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::GET, "/api/versions")
                .header("x-herdr-backend", "builtin")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["current_backend"], "builtin");
    assert_eq!(body["default_backend"], "external-herdr");
    handle.join().unwrap();
    let _ = fs::remove_file(&api_socket);
    let _ = fs::remove_dir_all(&config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── launch_session builtin Ok(Err) path ──
// ensure_builtin_session fails when BuiltinBackendHandle::start fails.
// We trigger this by pre-creating a regular file at the builtin socket path
// so bind_local_listener fails.

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn launch_session_builtin_returns_error_on_socket_bind_failure() {
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-launch-err-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let session_name = "test-builtin-err";
    let (api_socket, client_socket) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    fs::create_dir_all(client_socket.parent().unwrap()).unwrap();

    // Create a directory at the api_socket path.
    // prepare_socket_path() calls fs::remove_file(path) which fails on
    // directories (ErrorKind::Other or IsADirectory), causing start() to
    // return an io::Error.
    let _ = fs::remove_file(&api_socket);
    fs::create_dir(&api_socket).unwrap();

    let mut state = test_state();
    state.backend_mode = BackendMode::Builtin;
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // ensure_builtin_session fails because socket is already bound
    assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"].as_str().is_some());

    let _ = fs::remove_dir(&api_socket);
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

// ── git_branches Ok(Err) path (git not found) ──
// Same issue as remove_worktree_path: requires clearing PATH which breaks
// parallel tests. The Ok(Err) path is already covered by other error tests
// that trigger non-zero exit status. Skip this specific path.

// ── launch_session external spawn Ok(Err) path ──
// Command::new(herdr_bin).spawn() fails when herdr_bin is not on PATH
// and PATH is empty. But we use a full path so this doesn't apply.
// Instead, use a binary that exists but can't be spawned (e.g., /dev/null).

#[cfg(unix)]
#[tokio::test]
async fn launch_session_external_returns_error_on_spawn_failure() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!(
        "herdr-webui-spawn-fail-test-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    // A binary that exists and reports a compatible version, but loses
    // execute permission between detection and launch: spawn() fails.
    let script = root.join("fake-herdr");
    std::fs::write(
        &script,
        "#!/bin/sh\ncase \"$1\" in\n--version) echo 'herdr 0.9.0'; exit 0;;\nesac\nexit 0\n",
    )
    .unwrap();
    let mut permissions = std::fs::metadata(&script).unwrap().permissions();
    permissions.set_mode(0o644);
    std::fs::set_permissions(&script, permissions).unwrap();
    let mut state = test_state();
    state.herdr_bin = script.display().to_string();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            authed_request(Method::POST, "/api/session/launch")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": "test-spawn-err", "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    // Not executable: detection cannot run it, so the install gate
    // rejects with an actionable error before any spawn is attempted.
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
    assert!(body["error"].as_str().is_some());
    let _ = std::fs::remove_dir_all(&root);
}

#[cfg(unix)]
// lock_env() serializes env-mutating tests; held across await on purpose
// so no other test touches process env while handlers run.
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn cleanup_sessions_removes_stale_builtin_dirs_and_keeps_default_and_running() {
    // Three built-in session directories: a stale one (dead-listener
    // socket, the crash leftover), the default slot (always kept), and a
    // running one (live listener, kept). Plus a non-session directory that
    // must never be touched.
    let _guard = lock_env();
    let config_home = PathBuf::from(format!(
        "/tmp/hw-cleanup-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let stale_name = "stale-session";
    let running_name = "running-session";
    let (stale_api, _) = builtin_socket_paths(Some(stale_name));
    let (running_api, _) = builtin_socket_paths(Some(running_name));
    let (default_api, _) = builtin_socket_paths(Some("default"));
    for dir in [
        stale_api.parent(),
        running_api.parent(),
        default_api.parent(),
    ] {
        fs::create_dir_all(dir.unwrap()).unwrap();
    }
    // Dead-listener socket: bound then dropped, exactly what a crashed
    // backend leaves behind.
    {
        let listener = std::os::unix::net::UnixListener::bind(&stale_api).unwrap();
        drop(listener);
    }
    let running_listener = std::os::unix::net::UnixListener::bind(&running_api).unwrap();
    // Not a session slot (not canonical name output).
    fs::create_dir_all(config_home.join("builtin/keep-not-a-session")).unwrap();

    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/cleanup")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "backend": "builtin" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["ok"], true);
    assert_eq!(body["removed_count"], 1);
    assert_eq!(body["removed"][0], stale_name);
    assert!(
        !stale_api.parent().unwrap().exists(),
        "stale session directory must be removed"
    );
    assert!(
        running_api.parent().unwrap().exists(),
        "running session directory must be kept"
    );
    assert!(
        default_api.parent().unwrap().exists(),
        "default session directory must be kept"
    );
    assert!(
        config_home.join("builtin/keep-not-a-session").exists(),
        "non-session directories must be untouched"
    );
    drop(running_listener);
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn cleanup_sessions_removes_session_even_when_registry_pins_it_closed() {
    // A closed session is in closed_builtin_sessions; cleanup must remove
    // that marker too, otherwise the directory is gone but the marker keeps
    // telling the server the session was explicitly closed (harmless but
    // stale state, and it would resurrect in a fresh process if the socket
    // path somehow reappeared).
    let _guard = lock_env();
    let config_home = PathBuf::from(format!(
        "/tmp/hw-cleanup-marker-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let session_name = "closed-marker-session";
    let (api_socket, _) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    // Long XDG prefixes push the session socket path past sun_path, so the
    // sockets live in the hashed fallback dir; the sessions list directory
    // stays at <config>/herdr-webui/builtin. Recreate the canonical session
    // directory there too, matching what the real discovery/launch flow
    // leaves behind.
    let session_dir = server_settings_path()
        .parent()
        .unwrap()
        .join("builtin")
        .join(session_name);
    fs::create_dir_all(&session_dir).unwrap();

    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    state
        .closed_builtin_sessions
        .lock()
        .unwrap()
        .insert(session_name.to_string());
    let closed_marker = state.closed_builtin_sessions.clone();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/cleanup")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "backend": "builtin" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["removed_count"], 1);
    assert!(
        !closed_marker.lock().unwrap().contains(session_name),
        "cleanup must clear the closed-session marker for removed sessions"
    );
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn cleanup_sessions_rejects_non_builtin_backend() {
    let app = test_app_with_state(test_state());
    let response = app
        .oneshot(
            request(Method::POST, "/api/session/cleanup")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "backend": "external-herdr" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    let body = response_json(response).await;
    assert_eq!(body["ok"], false);
}

#[cfg(unix)]
#[allow(clippy::await_holding_lock)]
#[tokio::test]
async fn cleanup_sessions_removes_panes_sidecar_and_store_entry_with_tabs() {
    // Session cleanup must take the TAB data with it, not just the
    // socket dir: the panes sidecar carries each panel's tab ids, and
    // the in-memory panes store holds the same entry for a warm server.
    // A cleanup that leaves either would resurrect closed tabs on the
    // next same-name launch or GET.
    let _guard = lock_env();
    let config_home = PathBuf::from(format!(
        "/tmp/hw-cleanup-panes-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let session_name = "panes-tabs-session";
    let (api_socket, _) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    // Dead-listener socket so the cleanup sees the session as stale.
    {
        let listener = std::os::unix::net::UnixListener::bind(&api_socket).unwrap();
        drop(listener);
    }
    let session_dir = server_settings_path()
        .parent()
        .unwrap()
        .join("builtin")
        .join(session_name);
    fs::create_dir_all(&session_dir).unwrap();
    // Journal with shell tabs: the tab half of the session record.
    fs::write(
        session_dir.join("session-journal.json"),
        json!({
            "version": 1,
            "workspaces": [{
                "workspace_id": "ws_1",
                "label": "tabs-here",
                "cwd": "/tmp",
                "shell_tabs": ["Shell"]
            }],
            "focused_workspace_cwd": "/tmp"
        })
        .to_string(),
    )
    .unwrap();
    // Panes sidecar with tab ids on its panels.
    let sidecar = config_home
        .join("herdr-webui")
        .join(format!("panes-{session_name}.json"));
    fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
    fs::write(
        &sidecar,
        json!({
            "v": 1,
            "panels": [{
                "kind": "pane",
                "paneId": "p1",
                "tabs": ["tab_1"],
                "active": "tab_1",
                "groupId": null
            }],
            "groups": [],
            "visible": { "type": "panel", "id": "p1" }
        })
        .to_string(),
    )
    .unwrap();

    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    // Warm the in-memory store the way any GET/op on this session does.
    // A default entry stands in for the loaded one: the cleanup contract
    // is the eviction itself, not the payload shape.
    state
        .panes_store
        .sessions
        .lock()
        .unwrap()
        .insert(session_name.to_string(), Default::default());
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/cleanup")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "backend": "builtin" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["removed_count"], 1);
    assert!(
        !sidecar.exists(),
        "cleanup must remove the panes sidecar carrying the session's tab ids"
    );
    assert!(
        !session_dir.join("session-journal.json").exists(),
        "cleanup must remove the journal recording the session's shell tabs"
    );
    assert!(
        server_settings_path()
            .parent()
            .unwrap()
            .join("builtin")
            .join(session_name)
            .read_dir()
            .is_err()
            || fs::read_dir(
                server_settings_path()
                    .parent()
                    .unwrap()
                    .join("builtin")
                    .join(session_name)
            )
            .is_err(),
        "the session directory itself is gone"
    );
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// Close is final for tab data too: the panes sidecar (panel tab ids) and
/// the warm store entry must go with the session, because a later cleanup
/// cannot see the session anymore once close removed its dir.
#[cfg(unix)]
#[tokio::test]
// The env lock guards XDG_CONFIG_HOME for the whole await span (same
// shape as the panes_routes_tests suites).
#[allow(clippy::await_holding_lock)]
async fn close_session_drops_panes_sidecar_and_store_entry() {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    let _guard = lock_env();
    let config_home = std::env::temp_dir().join(format!(
        "herdr-webui-close-panes-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let session_name = "close-tabs-session";
    let (api_socket, _) = builtin_socket_paths(Some(session_name));
    fs::create_dir_all(api_socket.parent().unwrap()).unwrap();
    let _ = fs::remove_file(&api_socket);
    let name = api_socket.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let stop_handle = thread::spawn(move || {
        let stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], "server.stop");
        // Drop without responding: proxy_server_stop treats that as ok.
        drop(stream);
    });

    // Journal and panes sidecar with tab ids: the session's tab data.
    let session_dir = server_settings_path()
        .parent()
        .unwrap()
        .join("builtin")
        .join(session_name);
    fs::create_dir_all(&session_dir).unwrap();
    fs::write(
        session_dir.join("session-journal.json"),
        json!({
            "version": 1,
            "workspaces": [{
                "workspace_id": "ws_1",
                "label": "closing",
                "cwd": "/tmp",
                "shell_tabs": ["Shell"]
            }],
            "focused_workspace_cwd": "/tmp"
        })
        .to_string(),
    )
    .unwrap();
    let sidecar = config_home
        .join("herdr-webui")
        .join(format!("panes-{session_name}.json"));
    fs::create_dir_all(sidecar.parent().unwrap()).unwrap();
    fs::write(
        &sidecar,
        json!({
            "v": 1,
            "panels": [{
                "kind": "pane",
                "paneId": "p1",
                "tabs": ["tab_1"],
                "active": "tab_1",
                "groupId": null
            }],
            "groups": [],
            "visible": { "type": "panel", "id": "p1" }
        })
        .to_string(),
    )
    .unwrap();

    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    state
        .panes_store
        .sessions
        .lock()
        .unwrap()
        .insert(session_name.to_string(), Default::default());
    // Keep the store handle to assert eviction after the app consumes the
    // state: same Arc the close path mutates.
    let store = state.panes_store.clone();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/close")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({ "session": session_name, "backend": "builtin" }).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    stop_handle.join().unwrap();
    assert!(
        !sidecar.exists(),
        "close must drop the panes sidecar carrying the session's tab ids"
    );
    assert!(
        !session_dir.join("session-journal.json").exists(),
        "close must drop the journal recording the session's shell tabs"
    );
    assert!(
        !store.sessions.lock().unwrap().contains_key(session_name),
        "close must evict the warm panes store entry"
    );
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// The orphan sweep is the safety net for sidecars no session dir backs:
/// close and cleanup both delete dirs, so their sidecars would otherwise be
/// unreachable forever. Protection is name-mapped, not pattern-matched:
/// a running dotted session (`a.b`) owns sidecar `panes-a_b.json` through
/// the sanitizer (dots dropped), so the live name must pin that file even
/// though the file name spells the component differently.
#[cfg(unix)]
#[tokio::test]
// The env lock guards XDG_CONFIG_HOME for the whole await span.
#[allow(clippy::await_holding_lock)]
async fn cleanup_sessions_sweeps_orphan_sidecars_without_session_dirs() {
    let _guard = lock_env();
    let config_home = PathBuf::from(format!(
        "/tmp/hw-sweep-panes-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let builtin_root = config_home.join("herdr-webui").join("builtin");
    // Running dotted session: dir + registry entry, must pin the sidecar
    // the sanitizer maps it to (panes-a_b.json).
    fs::create_dir_all(builtin_root.join("a.b")).unwrap();

    let sidecars = config_home.join("herdr-webui");
    fs::create_dir_all(&sidecars).unwrap();
    let orphan = sidecars.join("panes-orphan-a.json");
    let dotted_owner = sidecars.join("panes-a_b.json");
    let live_sidecar = sidecars.join("panes-live-session.json");
    let default_sidecar = sidecars.join("panes-default.json");
    for path in [&orphan, &dotted_owner, &live_sidecar, &default_sidecar] {
        fs::write(path, "{\"v\":1,\"panels\":[],\"groups\":[]}").unwrap();
    }

    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    // Live registry entries (real throwaway handles): the strongest pin,
    // their sockets live in /tmp and never collide with the config home.
    for (name, suffix) in [("live-session", "live"), ("a.b", "dotted")] {
        let handle = Arc::new(
            builtin_backend::BuiltinBackendHandle::start(builtin_backend::BuiltinBackendConfig {
                api_socket: PathBuf::from(format!(
                    "/tmp/herdr-webui-sweep-{suffix}-api-{}.sock",
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                )),
                client_socket: PathBuf::from(format!(
                    "/tmp/herdr-webui-sweep-{suffix}-client-{}.sock",
                    SystemTime::now()
                        .duration_since(UNIX_EPOCH)
                        .unwrap()
                        .as_nanos(),
                )),
                cwd: std::env::temp_dir(),
                shell: None,
                jcode_detection_variant: JcodeDetectionVariant::Vanilla,
                journal_dir: None,
            })
            .unwrap(),
        );
        state
            .builtin_sessions
            .lock()
            .unwrap()
            .insert(name.to_string(), handle);
    }
    // Warm store entry pins like a live name would.
    state
        .panes_store
        .sessions
        .lock()
        .unwrap()
        .insert("warm-session".to_string(), Default::default());
    let warm_sidecar = sidecars.join("panes-warm-session.json");
    fs::write(&warm_sidecar, "{\"v\":1,\"panels\":[],\"groups\":[]}").unwrap();
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/cleanup")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "backend": "builtin" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    let swept: Vec<String> = body["swept_orphans"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect();
    assert_eq!(swept, vec!["orphan-a".to_string()]);
    assert!(!orphan.exists(), "orphan sidecar must be swept");
    assert!(
        dotted_owner.exists(),
        "running dotted session pins its sidecar across the sanitizer"
    );
    assert!(
        live_sidecar.exists(),
        "live registry entry pins its sidecar"
    );
    assert!(default_sidecar.exists(), "default sidecar is never swept");
    assert!(warm_sidecar.exists(), "warm store entry pins its sidecar");
    let _ = fs::remove_dir_all(config_home);
    std::env::remove_var("XDG_CONFIG_HOME");
}

/// A fresh config home with no builtin sessions dir is the normal first-run
/// state: cleanup answers ok with empty lists instead of erroring on the
/// missing directory.
#[cfg(unix)]
#[tokio::test]
// The env lock guards XDG_CONFIG_HOME for the whole await span.
#[allow(clippy::await_holding_lock)]
async fn cleanup_sessions_answers_ok_when_the_builtin_dir_is_missing() {
    let _guard = lock_env();
    let config_home = PathBuf::from(format!(
        "/tmp/hw-cleanup-missing-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    std::env::set_var("XDG_CONFIG_HOME", &config_home);

    let mut state = test_state();
    state.builtin_sessions = Arc::new(Mutex::new(HashMap::new()));
    let app = test_app_with_state(state);

    let response = app
        .oneshot(
            request(Method::POST, "/api/session/cleanup")
                .header(header::COOKIE, "herdr_web_session=token-123")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(json!({ "backend": "builtin" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    let body = response_json(response).await;
    assert_eq!(body["removed_count"], 0);
    assert_eq!(body["kept_running_count"], 0);
    assert_eq!(body["swept_orphans"], json!([]));
    std::env::remove_var("XDG_CONFIG_HOME");
}

#[test]
fn worktree_activity_display_formats_iso_and_space_forms() {
    // ISO T form becomes a space in the 16-char prefix.
    assert_eq!(
        worktree_activity_display("2026-01-02T03:04:05Z"),
        Some("2026-01-02 03:04".to_string())
    );
    // Space form is kept as the prefix.
    assert_eq!(
        worktree_activity_display("2026-01-02 03:04:05"),
        Some("2026-01-02 03:04".to_string())
    );
    // Surrounding whitespace is trimmed first.
    assert_eq!(
        worktree_activity_display("  2026-01-02T03:04:05Z  "),
        Some("2026-01-02 03:04".to_string())
    );
    // Too short for a 16-char prefix: no display. Only the byte at
    // position 10 decides, so a slash date with a T still displays.
    assert_eq!(worktree_activity_display("2026-01-02"), None);
    assert_eq!(worktree_activity_display(""), None);
    assert_eq!(
        worktree_activity_display("2026/01/02T03:04"),
        Some("2026/01/02 03:04".to_string())
    );
    assert_eq!(worktree_activity_display("2026-01-02x03:04"), None);
}

#[test]
fn enrich_worktree_activity_fills_commit_data_from_git() {
    let (repo, _guard) = temp_guard("worktree-activity-git");
    assert!(Command::new("git")
        .arg("init")
        .arg(&repo)
        .output()
        .unwrap()
        .status
        .success());
    fs::write(repo.join("file.txt"), "hello").unwrap();
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args(["add", "."])
        .output()
        .unwrap()
        .status
        .success());
    assert!(Command::new("git")
        .arg("-C")
        .arg(&repo)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=t@example.com",
            "commit",
            "-m",
            "init",
        ])
        .output()
        .unwrap()
        .status
        .success());

    // A row without activity fields gets them from the repo HEAD.
    let mut row = json!({ "path": repo.to_string_lossy() });
    enrich_worktree_activity(&mut row);
    assert!(row["last_commit_at"].as_str().is_some());
    assert!(row["last_commit_hash"].as_str().is_some());
    assert!(row["last_commit_display"].as_str().is_some());

    // An empty path cannot be probed.
    let mut row = json!({ "path": "  " });
    enrich_worktree_activity(&mut row);
    assert!(row.get("last_commit_at").is_none());

    // A path that is not a git repo gets nothing.
    let (plain, _guard2) = temp_guard("worktree-activity-plain");
    let mut row = json!({ "path": plain.to_string_lossy() });
    enrich_worktree_activity(&mut row);
    assert!(row.get("last_commit_at").is_none());

    // A preexisting activity date is kept and only the display is added.
    let mut row = json!({
        "path": repo.to_string_lossy(),
        "last_commit_at": "2026-01-02T03:04:05Z",
    });
    enrich_worktree_activity(&mut row);
    assert_eq!(row["last_commit_at"], "2026-01-02T03:04:05Z");
    assert_eq!(row["last_commit_display"], "2026-01-02 03:04");
}

#[test]
fn worktree_activity_sort_key_orders_by_date_and_falls_back() {
    // String date parses into a numeric key bucket.
    let with_date = json!({ "last_commit_at": "2026-01-02T03:04:05Z" });
    let key = worktree_activity_sort_key(&with_date);
    assert!(key.starts_with("2:"));
    assert!(key.len() > 2);

    // Unparseable string date keeps the raw string in bucket 2.
    let raw = json!({ "mtime": "not-a-date" });
    assert_eq!(worktree_activity_sort_key(&raw), "2:not-a-date");

    // Numeric timestamp fields land in bucket 1.
    let numeric = json!({ "last_commit_timestamp": 1_700_000_000 });
    assert!(worktree_activity_sort_key(&numeric).starts_with("1:"));

    // Nothing at all lands in bucket 0.
    assert_eq!(worktree_activity_sort_key(&json!({})), "0:");
}

#[test]
fn path_basename_handles_trailing_slashes_and_empty_paths() {
    assert_eq!(path_basename("/a/b/c.txt"), "c.txt");
    assert_eq!(path_basename("c.txt"), "c.txt");
    assert_eq!(path_basename("/a/b/"), "b");
    assert_eq!(path_basename("//"), "");
    assert_eq!(path_basename(""), "");
    assert_eq!(path_basename("/"), "");
}

#[test]
fn same_checkout_path_resolves_real_paths() {
    let (dir, _guard) = temp_guard("same-checkout");
    let file = dir.join("probe.txt");
    fs::write(&file, b"x").unwrap();
    let direct = file.to_string_lossy().to_string();
    // On macOS /tmp is a symlink to /private/tmp, so a canonicalized form
    // differs from the written string while still naming the same file.
    let canonical = fs::canonicalize(&file)
        .unwrap()
        .to_string_lossy()
        .to_string();
    assert!(same_checkout_path(&direct, &canonical));
    assert!(same_checkout_path(&direct, &direct));
    assert!(!same_checkout_path(&direct, &format!("{direct}-nope")));
}

#[test]
fn expand_path_prefix_resolves_home_relative_and_absolute_paths() {
    let _guard = lock_env();
    let original_home = std::env::var_os("HOME");
    let (home, _guard2) = temp_guard("expand-home");
    std::env::set_var("HOME", home.to_string_lossy().to_string());

    assert_eq!(expand_path_prefix("~"), home);
    assert_eq!(expand_path_prefix("~/src"), home.join("src"));
    assert_eq!(expand_path_prefix("/abs/path"), PathBuf::from("/abs/path"));
    assert_eq!(expand_path_prefix("rel/path"), home.join("rel/path"));
    assert_eq!(
        expand_user_path_string("~/x"),
        home.join("x").to_string_lossy().to_string()
    );

    std::env::remove_var("HOME");
    // Without HOME the prefix survives unchanged instead of panicking.
    assert_eq!(expand_path_prefix("~/x"), PathBuf::from("~/x"));
    assert_eq!(expand_path_prefix("x"), PathBuf::from("x"));
    match original_home {
        Some(home) => std::env::set_var("HOME", home),
        None => std::env::remove_var("HOME"),
    }
}

#[test]
fn worktree_list_cache_invalidate_drops_only_the_asked_cwd() {
    // A branch switch through git-ui moves HEAD for one checkout. The
    // worktree.list rows for that cwd carry the checked-out branch, so
    // the cached answer must drop; other cwds keep their fresh entries
    // and a missing cwd stays a no-op.
    let cache = WorktreeListCache::default();
    cache.put(
        "/tmp/repo-a",
        serde_json::json!([{"path": "/tmp/repo-a", "branch": "main"}]),
    );
    cache.put(
        "/tmp/repo-b",
        serde_json::json!([{"path": "/tmp/repo-b", "branch": "dev" }]),
    );

    cache.invalidate("/tmp/repo-a");

    assert!(
        cache.get(&Some("/tmp/repo-a".to_string())).is_none(),
        "switched cwd loses its cached rows"
    );
    assert!(
        cache.get(&Some("/tmp/repo-b".to_string())).is_some(),
        "untouched cwd keeps its cached rows"
    );
    cache.invalidate("/tmp/never-cached");
    assert!(
        cache.get(&Some("/tmp/repo-b".to_string())).is_some(),
        "no-op invalidate keeps other entries"
    );

    // Re-put after invalidate serves again: the switch path must not
    // permanently poison the cwd.
    cache.put(
        "/tmp/repo-a",
        serde_json::json!([{"path": "/tmp/repo-a", "branch": "feature" }]),
    );
    assert!(cache.get(&Some("/tmp/repo-a".to_string())).is_some());
}
