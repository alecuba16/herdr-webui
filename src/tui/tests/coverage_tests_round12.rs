//! Coverage round tests.

use super::*;
use crossterm::event::{KeyCode, KeyEvent};

#[test]
fn vertical_walk_moves_between_stacked_tiles() {
    // Column split: Down/Up walk between the stacked tiles, so
    // nav_vertical_key's walk-success path runs both directions.
    let mut app = two_tile_split();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Col,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.mode = TuiMode::Navigate;
    let _ = draw(&app, 120, 30);
    app.handle_navigation_key(KeyEvent::from(KeyCode::Down));
    assert_eq!(app.split_focus.as_deref(), Some("pane_2"), "down walks");
    app.handle_navigation_key(KeyEvent::from(KeyCode::Up));
    assert_eq!(app.split_focus.as_deref(), Some("pane_1"), "up walks back");
}

#[test]
fn move_panel_on_a_split_with_no_panes_in_the_snapshot() {
    // Split active but the snapshot has no panes at all: the
    // cursor-follow block is skipped wholesale.
    let mut app = two_tile_split();
    app.snapshot.panes.clear();
    let _ = app.move_panel(1);
    assert_eq!(app.selected_workspace, 0);
    assert!(app.split_focus.is_some());
}
