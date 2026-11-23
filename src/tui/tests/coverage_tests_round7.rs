//! Coverage round tests.

use super::*;
use crate::tui::web_api::WebApiClient;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

/// Coverage round 7: app-level arms that need a live (or selectively
/// dead) web_api or unusual snapshot shapes.
/// Multi-request HTTP server: every request gets the same JSON
/// body, until the listener is dropped with the sender.
pub(crate) fn http_json_server(
    body: serde_json::Value,
) -> (WebApiClient, std::sync::mpsc::Sender<()>) {
    use std::io::{BufRead as _, Write as _};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        while let Ok((mut stream, _)) = listener.accept() {
            if rx.try_recv().is_ok() {
                break;
            }
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            if reader.read_line(&mut request).unwrap_or(0) == 0 {
                continue;
            }
            let mut content_length = 0usize;
            loop {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                    break;
                }
                if let Some(value) = header
                    .trim()
                    .to_ascii_lowercase()
                    .strip_prefix("content-length:")
                {
                    content_length = value.trim().parse().unwrap_or(0);
                }
            }
            use std::io::Read as _;
            let mut body_bytes = vec![0u8; content_length];
            if content_length > 0 {
                let _ = reader.read_exact(&mut body_bytes);
            }
            let text = body.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                text.len(),
                text
            );
            let _ = stream.flush();
        }
    });
    (WebApiClient::new("127.0.0.1", port), tx)
}

#[test]
fn search_target_and_create_tab_skip_absent_workspaces() {
    // select_search_target: a pane resolves to its agent row, but
    // the agent's workspace is not in the workspaces list, so the
    // workspace-cursor move is skipped (the position else-arm).
    let mut app = app_with_snapshot();
    app.snapshot.agents[0].workspace_id = "ws_gone".to_string();
    app.snapshot.panes[0].workspace_id = "ws_gone".to_string();
    app.select_search_target(Some("ws_gone"), None, Some("pane_1"));
    assert_eq!(app.selected_agent, 0);
    assert_eq!(app.selected_workspace, 0, "cursor stays on the old row");

    // create_tab: the focused pane's workspace is not in the list,
    // so the cursor move is skipped there too.
    let mut app = app_with_snapshot();
    app.snapshot.panes[0].workspace_id = "ws_gone".to_string();
    app.split_focus = Some("pane_1".to_string());
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.create_tab();
    assert_eq!(app.selected_workspace, 0);
}

#[test]
fn close_tab_falls_back_to_the_first_listed_tab() {
    // No view pane tab match and no active tab id: the first
    // fallback tab of the workspace owns the close. The built-in
    // backend answers tab.close ok, so the close succeeds.
    let (socket, _stop) = fake_backend_socket();
    let mut app = TuiApp::new(BackendClient::new(&socket, &socket), Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    let ws_id = app.snapshot.workspaces[0].id.clone();
    app.snapshot.workspaces[0].active_tab_id = None;
    app.snapshot.panes.clear();
    app.selected_workspace = 0;
    // Sanity: the workspace still lists its tab.
    assert!(
        !app.snapshot.workspace_tabs(&ws_id).is_empty(),
        "fixture lists the tab"
    );
    app.close_selected_tab();
    assert!(
        app.error.is_none(),
        "close rides the first listed tab: {:?}",
        app.error
    );
}

#[test]
fn files_screen_success_arms_refresh_search_preview_and_navigation() {
    let (api, _stop) = http_json_server(serde_json::json!({
        "entries": [
            {"name": "dir", "path": "dir", "is_dir": true},
            {"name": "a.rs", "path": "dir/a.rs", "is_dir": false}
        ]
    }));
    let mut app = app_with_snapshot();
    app.web_api = api;
    app.screen = TuiScreen::Files;

    // Plain refresh succeeds: no error lands (the success arm).
    app.refresh_active_screen();
    assert!(app.error.is_none(), "{:?}", app.error);

    // Enter on a file entry: toggle_expand answers false (not a
    // dir), open_preview succeeds (the success else-arm).
    app.file_explorer.selected = 1;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_none(), "{:?}", app.error);
    assert!(app.file_explorer.preview.path.is_some());

    // `l` on the directory row: enter_directory flips the root and
    // the refresh succeeds.
    app.file_explorer.selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert!(app.error.is_none(), "{:?}", app.error);

    // `h` goes back up one directory: the refresh succeeds again.
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    assert!(app.error.is_none(), "{:?}", app.error);

    // Filter commit on the tree kind: the refresh map closure runs
    // (content search arm runs in its own test below).
    app.file_explorer.search_mode = true;
    app.file_explorer.search_kind = crate::tui::panels::files::SearchKind::File;
    app.handle_key(KeyEvent::new(KeyCode::Char('\n'), KeyModifiers::NONE));
    assert!(app.error.is_none(), "{:?}", app.error);
}

#[test]
fn content_search_commit_reports_done_on_success() {
    let (api, _stop) = http_json_server(serde_json::json!({
        "files": [{
            "path": "a.rs",
            "name": "a.rs",
            "match_count": 1,
            "chunks": [{
                "start": 1,
                "end": 1,
                "rows": [{"line": 1, "matched": true, "text": "hit"}]
            }]
        }],
        "total_files": 1,
        "total_matches": 1,
        "visited": 1,
        "truncated": false
    }));
    let mut app = app_with_snapshot();
    app.web_api = api;
    app.screen = TuiScreen::Files;
    app.file_explorer.search_mode = true;
    app.file_explorer.search_kind = crate::tui::panels::files::SearchKind::Content;
    app.file_explorer.filter = "needle".to_string();
    app.file_explorer.filter_active = true;
    app.handle_files_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "content search done");
    assert!(app.error.is_none(), "{:?}", app.error);
}

#[test]
fn log_compare_and_cleanup_prune_report_success() {
    // Git Log view with a selected commit: Enter runs the compare
    // against the parent; the ok arm stamps the status line.
    let (api, _stop) = http_json_server(serde_json::json!({
        "files": [{"path": "a.rs", "chunks": []}]
    }));
    let mut app = app_with_snapshot();
    app.web_api = api;
    app.screen = TuiScreen::Git;
    app.git_panel.view = crate::tui::panels::git::GitView::Log;
    app.git_panel.commits = vec![crate::tui::panels::git::GitCommitEntry {
        hash: "abc123".to_string(),
        message: String::new(),
        author: String::new(),
        date: String::new(),
        labels: vec![],
    }];
    app.git_panel.commit_selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.status.contains("compare abc123"), "{}", app.status);
    assert!(app.error.is_none(), "{:?}", app.error);

    // Cleanup view with a selected item: prefix-P prunes, the ok
    // arm maps the item's repo (not the cwd fallback).
    let (api, _stop) = http_json_server(serde_json::json!({
        "repos": [{"path": "/repo", "branches": [], "worktrees": []}]
    }));
    let mut app = app_with_snapshot();
    app.web_api = api;
    app.screen = TuiScreen::Git;
    app.git_panel.view = crate::tui::panels::git::GitView::Cleanup;
    app.git_panel.cleanup_repos = vec![crate::tui::panels::git::CleanupRepo {
        path: "/repo".to_string(),
        branches: vec![],
        worktrees: vec![crate::tui::panels::git::CleanupWorktree {
            path: "/repo/wt-feature".to_string(),
            branch: Some("feature".to_string()),
        }],
    }];
    app.git_panel.cleanup_selected = 0;
    app.handle_key(KeyEvent::new(KeyCode::Char('B'), KeyModifiers::SHIFT));
    assert!(app.error.is_none(), "{:?}", app.error);
}

#[test]
fn text_snapshot_on_an_empty_snapshot_prints_only_the_header() {
    // Every optional block (cwd, workspace, agent, pane) drops out.
    let mut app = app_with_snapshot();
    app.snapshot = TuiSnapshot::default();
    let text = app.text_snapshot();
    assert!(text.contains("workspaces=0"));
    assert!(!text.contains("active cwd"));
    assert!(!text.contains("workspace "));
    assert!(!text.contains("agent "));
    assert!(!text.contains("pane "));
}

#[test]
fn navigation_arrows_without_a_split_scroll_the_focused_pane() {
    // No split on screen: the walk fallback returns false, so
    // Up/Down scroll and Right stays inert (the empty arm).
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Terminal;
    app.mode = TuiMode::Navigate;
    app.main_focused = true;
    app.pane_tail = vec!["line".to_string(); 40];
    app.handle_navigation_key(KeyEvent::from(KeyCode::Up));
    app.handle_navigation_key(KeyEvent::from(KeyCode::Down));
    app.handle_navigation_key(KeyEvent::from(KeyCode::Right));
    assert!(app.error.is_none());
}

#[test]
fn lens_gate_reports_supported_for_a_chat_kind_session() {
    // The fixture pane carries a resolvable jcode session: the
    // Supported arm of the gate.
    let mut app = app_with_snapshot();
    app.snapshot.panes[0].agent_session = Some(crate::tui::model::TuiAgentSession {
        kind: "jcode".to_string(),
        resolvable: true,
        session_id: Some("sess_1".to_string()),
        reason: None,
    });
    assert!(app.lens_chat_supported() == crate::tui::lens::LensGate::Supported);
}

#[test]
fn view_pane_falls_back_when_the_split_focus_is_missing() {
    // Split active but the focus id is not a pane: the fallback to
    // the sidebar selection runs.
    let mut app = app_with_snapshot();
    app.split_focus = Some("gone".to_string());
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    assert_eq!(app.view_pane().map(|pane| pane.id.as_str()), Some("pane_1"));
}
