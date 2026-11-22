//! Coverage round tests.

use super::*;

#[test]
fn sync_split_tree_keeps_live_overlay_state() {
    // Preview, move, and resize all point at panes that still sit
    // in the tree: every guard keeps its mode (the false-arms of
    // the sync cleanup).
    let mut app = two_tile_split();
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_2".to_string(),
        side: crate::tui::split::Side::Right,
        pane: "pane_3".to_string(),
    });
    app.move_mode = Some(crate::tui::split::MoveState {
        picked: "pane_1".to_string(),
        target: "pane_2".to_string(),
        insert: false,
        side: crate::tui::split::Side::Left,
    });
    app.resize_mode = Some(crate::tui::split_mode::ResizeState {
        pane: "pane_1".to_string(),
    });
    app.sync_split_tree();
    assert!(app.split_mode.is_some(), "preview neighbor still alive");
    assert!(app.move_mode.is_some(), "move pair still alive");
    assert!(app.resize_mode.is_some(), "resize pane still alive");
}

#[test]
fn fresh_shell_split_uses_the_first_workspace_when_no_pane_is_viewed() {
    // No pane is in view (empty snapshot panes but a workspace is
    // listed): the fresh-shell create falls back to the first
    // workspace (the or_else arm of the workspace lookup).
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Terminal;
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".to_string(),
        side: crate::tui::split::Side::Right,
        pane: crate::tui::split::FRESH_SHELL.to_string(),
    });
    app.snapshot.panes.clear();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_commit();
    // The dead backend cannot create the tab, so the mode stays
    // open with the reason; the workspace fallback arm ran.
    assert!(app.split_mode.is_some(), "create failure keeps the mode");
}
