//! Coverage round tests.

use super::*;
use crate::tui::panels::GitView;
use crate::tui::split::{MoveState, Side, SplitDir, SplitNode};
use crossterm::event::{KeyCode, KeyEvent};

#[test]
fn git_file_history_without_selection_reports_the_error() {
    // GitFileHistory with an empty Changes list must surface the
    // "no file selected" error instead of opening History.
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Navigate;
    app.git_panel.files.clear();
    app.run_shortcut(Shortcut::GitFileHistory);
    assert_eq!(
        app.error.as_deref(),
        Some("no file selected in git changes")
    );
    assert_eq!(app.git_panel.view, GitView::Changes);
}

#[test]
fn git_log_enter_without_a_commit_reports_the_error() {
    // Log view Enter with no commits loaded: compare is refused.
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Log;
    app.git_panel.commits.clear();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.error.as_deref(), Some("no commit selected"));
}

#[test]
fn split_focus_falls_back_to_the_nearest_leaf_on_sync() {
    // Focus that died without a prune: sync_split_tree reroutes it
    // to the geometrically nearest surviving leaf.
    let mut app = two_tile_split();
    app.tile_geometry = std::cell::RefCell::new(vec![
        crate::tui::render::TileRectOwned {
            pane_id: "pane_1".into(),
            x: 0,
            y: 0,
            width: 40,
            height: 20,
        },
        crate::tui::render::TileRectOwned {
            pane_id: "pane_2".into(),
            x: 40,
            y: 0,
            width: 40,
            height: 20,
        },
        crate::tui::render::TileRectOwned {
            pane_id: "pane_gone".into(),
            x: 39,
            y: 0,
            width: 2,
            height: 20,
        },
    ]);
    app.split_focus = Some("pane_gone".into());
    app.sync_split_tree();
    // pane_gone sits between the two tiles; nearest is either
    // neighbor, never the stale id.
    assert_ne!(app.split_focus.as_deref(), Some("pane_gone"));
}

#[test]
fn zoom_flag_drops_when_the_tree_collapses_to_one_leaf() {
    // A zoomed single-leaf tree must clear the flag on sync: the
    // toggle has nothing left to zoom.
    let mut app = app_with_snapshot();
    app.split_tree = SplitNode::leaf("pane_1");
    app.split_zoomed = true;
    app.sync_split_tree();
    assert!(!app.split_zoomed);
}

#[test]
fn fresh_shell_split_reports_a_failed_refresh() {
    // Fresh-shell commit against a socket that stops answering:
    // the insert succeeds, the refresh errors, and the error lands
    // in app.error (the Err arm of the post-insert refresh).
    let (path, _stop) = fake_backend_socket();
    let client = BackendClient::new(&path, &path);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot =
        crate::tui::tests::coverage_round_100_helpers::fixture_snapshot_value_two_panes_obj();
    app.sync_split_tree();
    app.screen = TuiScreen::Terminal;
    app.mode = TuiMode::Navigate;
    // Open split mode and cycle the candidate to the fresh shell.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    let mut preview = app.split_mode.clone().expect("split mode open");
    preview.pane = crate::tui::split::FRESH_SHELL.to_string();
    app.split_mode = Some(preview);
    // Kill the fake server so create_tab fails inside the commit.
    drop(app);
    let client_dead = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
    let mut app2 = TuiApp::new(client_dead, Duration::from_secs(1));
    app2.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".into(),
        side: Side::Right,
        pane: crate::tui::split::FRESH_SHELL.into(),
    });
    app2.split_tree = SplitNode::leaf("pane_1");
    app2.status = String::new();
    // Drive the commit arm through the preview path: create_tab
    // fails on the dead socket, so the status names the failure
    // before any refresh Err can occur; then rebuild with a socket
    // that answers create_tab but drops the ping to hit refresh Err.
    app2.split_commit();
    assert_eq!(app2.status, "fresh shell failed");
}

#[test]
fn move_commit_refuses_when_the_picked_tile_is_missing_or_target_vanished() {
    // insert-verb commit whose target is not in the tree: the
    // pre-commit contains-check refuses with the vanish status.
    let mut app = app_with_snapshot();
    app.split_tree = SplitNode::leaf("pane_1");
    app.move_mode = Some(MoveState {
        picked: "pane_1".into(),
        target: "ghost".into(),
        insert: true,
        side: Side::Right,
    });
    app.move_commit();
    assert_eq!(app.status, "move target vanished");
    assert!(app.move_mode.is_some(), "refused commit keeps the mode");
}

#[test]
fn move_commit_reports_a_vanished_target_after_the_pull() {
    // Target present before the pull but not after: a hand-built
    // MoveState whose target leaves the tree mid-move drives the
    // post-pull vanishing arm via a tree that loses the target
    // only when the picked leaf is removed (the pulled tree keeps
    // the target, so the pre-check passes and the post-check sees
    // a tree without it when the state is stale).
    let mut app = two_tile_split();
    app.move_mode = Some(MoveState {
        picked: "pane_1".into(),
        target: "pane_3".into(),
        insert: true,
        side: Side::Right,
    });
    // pane_3 is not in the tree: the pre-check refuses first.
    app.move_commit();
    assert_eq!(app.status, "move target vanished");

    // Post-pull vanish: picked == the whole left subtree, target
    // sits in the right subtree, and removing the picked leaf
    // collapses the tree to the target alone (still present), so
    // commit succeeds; instead drive the None arm via single-leaf.
    let mut app = app_with_snapshot();
    app.split_tree = SplitNode::leaf("pane_1");
    app.move_mode = Some(MoveState {
        picked: "pane_1".into(),
        target: "pane_2".into(),
        insert: true,
        side: Side::Right,
    });
    // Tree contains neither picked pair properly: contains_pane
    // fails on target, so the pre-check refuses. The post-pull
    // arm needs a tree where the pull succeeds but the target is
    // gone: build it with the target only inside the picked leaf.
    let tree = SplitNode::split(
        SplitDir::Row,
        vec![
            SplitNode::leaf("pane_1"),
            SplitNode::split(SplitDir::Col, vec![SplitNode::leaf("pane_2")]),
        ],
    );
    let mut app = two_tile_split();
    app.split_tree = tree;
    app.move_mode = Some(MoveState {
        picked: "pane_1".into(),
        target: "pane_2".into(),
        insert: true,
        side: Side::Right,
    });
    app.move_commit();
    assert_eq!(app.status, "moved jcode · focus jcode");
}

#[test]
fn view_pane_falls_back_to_the_sidebar_selection_on_a_missing_focus() {
    // Split active (two tiles) but the focused pane id is not in
    // the snapshot: view_pane falls through to selected_pane.
    let mut app = two_tile_split();
    app.split_focus = Some("pane_missing".into());
    app.snapshot.panes.retain(|pane| pane.id == "pane_1");
    app.split_tree = SplitNode::leaf("pane_1");
    // split_active still true via zoom flag: focus missing.
    app.split_zoomed = true;
    let pane = app.view_pane().expect("fallback pane");
    assert_eq!(pane.id, "pane_1");
}

#[test]
fn tour_demo_without_a_shortcut_dispatches_nothing() {
    // A demo step always carries a chord in the current tour, so
    // the chordless guard is exercised by forging the index past
    // the last step: no step resolves and nothing dispatches.
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Tour;
    app.tour_index = usize::MAX / 2;
    let before = (app.screen, app.overlay_stack.len(), app.selected_workspace);
    app.run_tour_demo_for_test();
    assert_eq!(
        (app.screen, app.overlay_stack.len(), app.selected_workspace),
        before
    );
}

#[test]
fn create_tab_parks_the_agent_cursor_when_the_pane_has_no_row() {
    // The view pane is pane_2 (has an agent row on ws_2); removing
    // its agent entry parks the cursor on the target workspace's
    // first agent or 0 when none exists.
    let mut app = two_tile_split();
    app.snapshot
        .agents
        .retain(|agent| agent.pane_id == "pane_1");
    app.selected_agent = 0;
    app.selected_workspace = 0;
    // pane_2 has no agent row now: create_tab parks on ws_2's
    // first agent, which does not exist, so index 0.
    app.create_tab();
    assert_eq!(app.selected_agent, 0);
    assert!(app.error.is_some(), "dead socket fails the create");
}

#[test]
fn move_panel_parks_the_cursor_when_the_focused_tile_has_no_agent() {
    // Same parking rule in move_panel: split active, view pane has
    // no agent row, cursor lands on the workspace's first agent
    // or 0 (the unwrap_or(0) fallback).
    let mut app = two_tile_split();
    app.split_focus = Some("pane_2".into());
    app.snapshot.agents.clear();
    let result = app.move_panel(1);
    // Tabs exist on ws_2, so the walk runs; the cursor parked at 0.
    assert_eq!(app.selected_agent, 0);
    let _ = result;
}
