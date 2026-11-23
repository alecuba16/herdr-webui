//! Coverage round tests.

use super::coverage_tests_round7::http_json_server;
use super::*;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

#[test]
fn navigation_arrow_keys_walk_the_split_then_fall_back_to_scrolls() {
    // Two side-by-side tiles: each arrow walks the focus to the
    // neighbor. The walk reads the tile geometry the last render
    // recorded, so draw once before walking.
    let mut app = two_tile_split();
    app.mode = TuiMode::Navigate;
    let _ = draw(&app, 120, 30);
    app.handle_navigation_key(KeyEvent::from(KeyCode::Right));
    assert_eq!(app.split_focus.as_deref(), Some("pane_2"), "right walks");
    app.handle_navigation_key(KeyEvent::from(KeyCode::Down));
    assert_eq!(app.split_focus.as_deref(), Some("pane_2"));
    app.handle_navigation_key(KeyEvent::from(KeyCode::Left));
    assert_eq!(
        app.split_focus.as_deref(),
        Some("pane_1"),
        "left walks back"
    );
    app.handle_navigation_key(KeyEvent::from(KeyCode::Up));
    assert_eq!(app.split_focus.as_deref(), Some("pane_1"));
}

#[test]
fn view_pane_falls_back_to_the_sidebar_pane_when_the_focus_is_gone() {
    // Split active but the focused pane left the snapshot: the
    // focused-tile lookup misses and the sidebar pane owns the
    // view pipeline.
    let mut app = two_tile_split();
    app.split_focus = Some("gone".to_string());
    let pane = app.view_pane().expect("sidebar pane backs the view");
    assert_eq!(pane.id, "pane_1");
}

#[test]
fn files_enter_directory_and_go_up_refresh_through_the_live_api() {
    // `l` on a directory row enters it and the refresh succeeds
    // through the fake API; `h` goes back up and refreshes again.
    let (api, _stop) = http_json_server(serde_json::json!({
        "entries": [
            {"name": "dir", "path": "/repo/dir", "is_dir": true},
            {"name": "file.rs", "path": "/repo/file.rs", "is_dir": false}
        ]
    }));
    let mut app = app_with_snapshot();
    app.web_api = api;
    app.screen = TuiScreen::Files;
    app.file_explorer.cwd = "/repo".to_string();
    app.file_explorer.root_path = "/repo".to_string();
    app.file_explorer.entries = vec![crate::tui::panels::files::FileEntry {
        name: "dir".to_string(),
        path: "/repo/dir".to_string(),
        is_dir: true,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    }];
    app.handle_files_key(KeyEvent::new(KeyCode::Char('l'), KeyModifiers::NONE));
    assert_eq!(app.file_explorer.root_path, "/repo/dir");
    assert!(!app.file_explorer.entries.is_empty(), "refresh refilled");
    assert!(app.error.is_none(), "{:?}", app.error);

    app.handle_files_key(KeyEvent::new(KeyCode::Char('h'), KeyModifiers::NONE));
    assert_eq!(app.file_explorer.root_path, "/repo");
    assert!(app.error.is_none(), "{:?}", app.error);
}

#[test]
fn files_commit_of_an_empty_filter_refreshes_the_tree() {
    // Filter bar open with an empty query: Enter commits a plain
    // refresh (the else arm of the search-kind split).
    let (api, _stop) = http_json_server(serde_json::json!({
        "entries": [{"name": "a.rs", "path": "/repo/a.rs", "is_dir": false}]
    }));
    let mut app = app_with_snapshot();
    app.web_api = api;
    app.screen = TuiScreen::Files;
    app.file_explorer.cwd = "/repo".to_string();
    app.file_explorer.root_path = "/repo".to_string();
    app.file_explorer.filter_active = true;
    app.handle_files_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_none(), "{:?}", app.error);
    assert_eq!(app.file_explorer.entries.len(), 1);
}

#[test]
fn cleanup_prune_maps_the_selected_item_repo_after_the_scan() {
    // Prune against a repo differing from the panel cwd: the ok
    // arm invalidates the stamp for the selected item's repo.
    // The rescan reply keeps a worktree row so the post-scan
    // selection still resolves to /repo (an empty rescan would
    // park the cursor on nothing and the cwd fallback would run).
    let (api, _stop) = http_json_server(serde_json::json!({
        "repos": [{
            "path": "/repo",
            "branches": [],
            "worktrees": [{"path": "/repo/wt-feature", "branch": "feature"}]
        }]
    }));
    let mut app = app_with_snapshot();
    app.web_api = api;
    app.screen = TuiScreen::Git;
    app.git_panel.view = crate::tui::panels::git::GitView::Cleanup;
    app.git_panel.cwd = "/panel/cwd".to_string();
    app.git_panel.cleanup_repos = vec![crate::tui::panels::git::CleanupRepo {
        path: "/repo".to_string(),
        branches: vec![],
        worktrees: vec![crate::tui::panels::git::CleanupWorktree {
            path: "/repo/wt-feature".to_string(),
            branch: Some("feature".to_string()),
        }],
    }];
    app.git_panel.cleanup_selected = 0;
    // Seed the stamp cache for both repos: only the selected
    // item's repo is invalidated by the prune.
    app.stamp_cache.insert(
        "/repo".to_string(),
        crate::tui::StampCacheEntry {
            fetched_at: std::time::Instant::now(),
            response: serde_json::json!({"stale": true}),
        },
    );
    app.stamp_cache.insert(
        "/panel/cwd".to_string(),
        crate::tui::StampCacheEntry {
            fetched_at: std::time::Instant::now(),
            response: serde_json::json!({"kept": true}),
        },
    );
    app.handle_key(KeyEvent::new(KeyCode::Char('B'), KeyModifiers::SHIFT));
    assert!(app.error.is_none(), "{:?}", app.error);
    assert_eq!(app.status, "worktrees pruned");
    assert!(
        !app.stamp_cache.contains_key("/repo"),
        "selected repo dropped"
    );
    assert!(app.stamp_cache.contains_key("/panel/cwd"), "cwd kept");
}
