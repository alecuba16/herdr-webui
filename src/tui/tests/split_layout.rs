//! Split, move, resize, zoom, and pane layout tests.

use super::*;
use crossterm::event::{KeyCode, KeyEvent};
use serde_json::json;

#[test]
fn split_mode_opens_previews_and_commits_cross_workspace_pane() {
    let mut app = app_with_two_panes();

    // Ctrl+B s on the Terminal screen opens split mode (prefix-s there
    // is no longer settings; the Git screen keeps settings).
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    let preview = app.split_mode.clone().expect("split mode open");
    assert_eq!(preview.neighbor, "pane_1");
    assert_eq!(
        preview.pane, "pane_2",
        "cross-workspace pane is the candidate"
    );
    assert_eq!(preview.side, crate::tui::split::Side::Right);

    // Enter commits: the tree holds both panes, focus lands on the new
    // tile, and the mode overlay closes.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.split_mode.is_none());
    assert_eq!(app.split_tree.leaves(), vec!["pane_1", "pane_2"]);
    assert_eq!(app.split_focus.as_deref(), Some("pane_2"));
    // Split view is active: two tiles render.
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("jcode"), "tile titles carry agent names");
    assert!(drawn.contains("bot"));
}

#[test]
fn split_mode_esc_cancels_and_tab_flips_side() {
    let mut app = app_with_two_panes();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.split_mode.is_some());

    // Tab flips the side family: Right -> Below.
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Below
    );

    // Esc cancels with zero mutation.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.split_mode.is_none());
    assert_eq!(app.split_tree.leaves(), vec!["pane_1"]);
}

#[test]
fn split_mode_git_screen_still_opens_settings() {
    let mut app = app_with_two_panes();
    app.screen = TuiScreen::Git;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(app.mode, TuiMode::Settings);
}

#[test]
fn split_repress_keeps_the_walked_ghost() {
    // Review finding: re-pressing Ctrl+B s with the overlay open used
    // to rebuild the preview and silently discard the placement the
    // user had walked/flipped; it is a no-op now.
    let mut app = app_with_two_panes();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Below
    );
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Below,
        "re-press keeps the flipped side"
    );
}

#[test]
fn split_commit_arms_the_double_esc_guard() {
    // The Esc path arms just_closed_mode; commit is also a mode exit,
    // so a reflex Esc right after committing must not open the quit
    // confirm (same behavior as resize and move).
    let mut app = app_with_two_panes();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.split_mode, None);
    assert!(app.just_closed_mode);
    assert_eq!(app.status, "tile added");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_ne!(
        app.mode,
        TuiMode::ConfirmQuit,
        "reflex Esc stays in the app"
    );
}

#[test]
fn move_mode_swaps_and_inserts_tiles() {
    // Coverage note (move_commit's inner guards): the "picked the last
    // tile" and the inner "target vanished" returns are structurally
    // unreachable — reaching the insert branch already proved both
    // panes present, remove_leaf removes exactly the picked pane (so
    // the pulled tree is Some), and target != picked stays in it.
    let mut app = app_with_two_panes();
    // Seed a split: pane_2 right of pane_1.
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        weights: vec![8; 2],
    };
    app.split_focus = Some("pane_1".to_string());

    // Ctrl+B m opens move mode on the focused tile.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    assert!(app.move_mode.is_some());
    assert_eq!(app.move_mode.as_ref().unwrap().picked, "pane_1");

    // Tab toggles the verb to insert.
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert!(app.move_mode.as_ref().unwrap().insert);

    // Tab back to swap; Enter with picked == target is refused with a
    // reason and the mode stays open (finding: keep modes open so the
    // user can pick a real target instead of a silent cancel).
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.move_mode.is_some());
    assert_eq!(
        app.status,
        "target is the picked tile: hjkl moves the target"
    );
    // Esc still cancels the refused mode.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.move_mode.is_none());

    // Reopen and swap pane_1 with pane_2 via a walk: with only two
    // tiles the geometry comes from the last render; tests have none
    // yet, so commit directly through the state helpers.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    let state = app.move_mode.clone().unwrap();
    app.move_mode = Some(crate::tui::split::MoveState {
        target: "pane_2".to_string(),
        ..state
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.split_tree.leaves(), vec!["pane_2", "pane_1"]);
    assert!(app.move_mode.is_none());
}

#[test]
fn zoom_toggles_and_restores_the_split() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        weights: vec![8; 2],
    };
    app.split_focus = Some("pane_2".to_string());

    // Ctrl+B z zooms the focused tile.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    assert!(app.split_zoomed);
    // Zoom walks are pinned: hjkl cannot leave the zoomed tile.
    app.split_move_focus(1, 0);
    assert_eq!(app.split_focus.as_deref(), Some("pane_2"));

    // Ctrl+B z again restores the tree.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    assert!(!app.split_zoomed);
    assert_eq!(app.split_tree.leaves().len(), 2);
}

#[test]
fn sync_split_tree_prunes_dead_panes_and_reseeds() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("gone_pane"),
        ],
        weights: vec![8; 2],
    };
    app.split_focus = Some("gone_pane".to_string());
    app.sync_split_tree();
    // Dead leaf pruned, single-child split collapsed, focus falls
    // to the surviving leaf (nearest-leaf fallback: no recorded
    // geometry in a unit test, so the first alive leaf wins).
    assert_eq!(app.split_tree.leaves(), vec!["pane_1"]);
    assert_eq!(app.split_focus.as_deref(), Some("pane_1"));

    // Fresh app: the dead seed leaf (initial "" tree) reseeds from the
    // focused pane so the Terminal screen always shows something.
    let mut fresh = app_with_two_panes();
    fresh.sync_split_tree();
    assert_eq!(fresh.split_tree.leaves(), vec!["pane_1"]);
}

#[test]
fn auto_split_queue_inserts_opened_workspace_pane_beside_focus() {
    // Auto-split on open: a queued workspace id makes the next
    // sync_split_tree insert the workspace's first off-tree pane
    // beside the current focus, and the tile focus lands on the new
    // pane (the just-opened workspace greets the user).
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        weights: vec![8; 2],
    };
    app.split_focus = Some("pane_1".to_string());
    push_pane_3(&mut app);
    app.split_panes_of_workspaces
        .push(("ws_2".to_string(), Some("pane_1".to_string())));

    app.sync_split_tree();

    let leaves = app.split_tree.leaves();
    assert_eq!(leaves.len(), 3, "the opened pane joined the tree");
    assert!(
        leaves.contains(&"pane_3"),
        "pane_3 (ws_2's fresh pane) is on the tree"
    );
    assert_eq!(
        app.split_focus.as_deref(),
        Some("pane_3"),
        "focus lands on the just-opened tile"
    );
    assert!(
        app.split_panes_of_workspaces.is_empty(),
        "queue drains once the pane joined"
    );
    // Zoom must not hide the new tile: auto-split clears it.
    assert!(!app.split_zoomed);
}

#[test]
fn auto_split_queue_skips_panes_already_on_the_tree() {
    // An open that lands on an already-tiled pane (backend focused an
    // existing workspace) must not duplicate the tile: no spare pane
    // means the request waits, and a vanished workspace drops.
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        weights: vec![8; 2],
    };
    app.split_focus = Some("pane_1".to_string());
    app.split_panes_of_workspaces
        .push(("ws_2".to_string(), Some("pane_1".to_string())));

    app.sync_split_tree();

    assert_eq!(
        app.split_tree.leaves().len(),
        2,
        "no duplication: every ws_2 pane is already a tile"
    );
    assert_eq!(
        app.split_panes_of_workspaces,
        vec![("ws_2".to_string(), Some("pane_1".to_string()))],
        "workspace alive without a spare pane stays queued"
    );

    // Workspace gone from the snapshot: the queue drops it.
    app.snapshot.workspaces.retain(|ws| ws.id != "ws_2");
    app.snapshot
        .panes
        .retain(|pane| pane.workspace_id != "ws_2");
    app.sync_split_tree();
    assert!(
        app.split_panes_of_workspaces.is_empty(),
        "vanished workspace drops from the queue"
    );
    assert_eq!(app.split_tree.leaves().len(), 1, "its dead tiles pruned");
}

#[test]
fn auto_split_queue_waits_for_the_pane_to_exist() {
    // The queue defers by design: opening queues the workspace id
    // before its first pane exists, and the insertion happens at the
    // first sync that sees a pane. A workspace whose pane is already
    // off-tree (pane_2 here) takes it immediately instead of waiting,
    // so this scenario holds ws_2 back to zero panes.
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = Some("pane_1".to_string());
    app.snapshot
        .panes
        .retain(|pane| pane.workspace_id != "ws_2");
    app.split_panes_of_workspaces
        .push(("ws_2".to_string(), Some("pane_1".to_string())));

    // First sync: workspace exists, pane not yet born.
    app.sync_split_tree();
    assert_eq!(
        app.split_panes_of_workspaces,
        vec![("ws_2".to_string(), Some("pane_1".to_string()))],
        "still waiting for the pane"
    );
    assert_eq!(app.split_tree.leaves(), vec!["pane_1"], "tree untouched");

    // The refresh that carries the pane lands.
    push_pane_3(&mut app);
    app.sync_split_tree();
    assert!(app.split_tree.leaves().contains(&"pane_3"));
    assert!(app.split_panes_of_workspaces.is_empty());
    assert_eq!(app.split_focus.as_deref(), Some("pane_3"));
}

#[test]
fn auto_split_uses_the_captured_neighbor_not_the_post_open_selection() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    // No split_focus: pre-split single-leaf state, focused_pane_id()
    // falls back to the sidebar selection (this is the shape right
    // after an open moved it).
    app.selected_workspace = 1;
    app.split_panes_of_workspaces
        .push(("ws_2".to_string(), Some("pane_1".to_string())));

    app.sync_split_tree();

    let leaves = app.split_tree.leaves();
    assert!(leaves.contains(&"pane_1"), "neighbor kept as a tile");
    assert!(
        leaves.contains(&"pane_2"),
        "the new pane inserted beside it"
    );
    assert_eq!(leaves.len(), 2);
    assert_eq!(
        app.split_focus.as_deref(),
        Some("pane_2"),
        "the just-opened workspace's tile takes the focus"
    );
    assert!(app.split_panes_of_workspaces.is_empty());
}

#[test]
fn auto_split_dead_neighbor_falls_back_to_current_focus() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_2");
    app.split_focus = Some("pane_2".to_string());
    push_pane_3(&mut app);
    // The pane captured as neighbor is gone from the tree; the drain
    // must still split beside the live focus instead of waiting.
    app.split_panes_of_workspaces
        .push(("ws_2".to_string(), Some("pane_1".to_string())));

    app.sync_split_tree();

    let leaves = app.split_tree.leaves();
    assert!(leaves.contains(&"pane_2"), "focus kept as a tile");
    assert!(
        leaves.contains(&"pane_3"),
        "ws_2's spare pane inserted beside the live focus"
    );
    assert_eq!(app.split_focus.as_deref(), Some("pane_3"));
    assert!(app.split_panes_of_workspaces.is_empty());
}

#[test]
fn split_and_move_modes_never_coexist() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        weights: vec![8; 2],
    };
    app.split_focus = Some("pane_1".to_string());
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(
        app.split_mode
            .as_ref()
            .is_some_and(|m| m.pane == crate::tui::split::FRESH_SHELL),
        "both panes on tree: the fresh shell sentinel is the candidate"
    );

    // Give the tree a third pane to open and re-open both modes.
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
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.split_mode.is_some());

    // Opening move mode closes split mode.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    assert!(app.split_mode.is_none());
    assert!(app.move_mode.is_some());

    // And back: opening split mode closes move mode.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.move_mode.is_none());
    assert!(app.split_mode.is_some());
}

#[test]
fn view_pane_follows_split_focus_not_sidebar_cursor() {
    // The sidebar cursor stays on pane_1 (workspace ws_1's active
    // tab); the split commits pane_2 and focus lands there. Every
    // focused-tile pipeline (tail fetch, attach, lens) must read
    // pane_2 through view_pane, or the focused tile shows another
    // pane's output (live-demo regression).
    let mut app = app_with_two_panes();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));

    assert_eq!(app.selected_pane().map(|p| p.id.as_str()), Some("pane_1"));
    assert_eq!(app.view_pane().map(|p| p.id.as_str()), Some("pane_2"));
    assert_eq!(app.view_pane_id().as_deref(), Some("pane_2"));
    assert_eq!(app.view_terminal_id(), Some("term_2"));

    // Walking focus back to pane_1 flips the view pane with it. The
    // walk scores against the last frame's tile geometry, so one
    // draw must happen first (production renders every tick).
    app.main_focused = true;
    let _ = draw(&app, 150, 40);
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    assert_eq!(app.view_pane().map(|p| p.id.as_str()), Some("pane_1"));
    // ...and the sidebar cursor never moved.
    assert_eq!(app.selected_pane().map(|p| p.id.as_str()), Some("pane_1"));
}

#[test]
fn view_pane_falls_back_to_selection_without_split() {
    let app = app_with_two_panes();
    assert_eq!(app.split_tree.leaves().len(), 1);
    assert_eq!(app.view_pane().map(|p| p.id.as_str()), Some("pane_1"));
    assert_eq!(app.view_terminal_id(), Some("term_1"));
}

#[test]
fn tile_titles_carry_workspace_label_folder_and_chips() {
    // Design "Tile identity and status": every tile border carries
    // the workspace label (human, not the raw id), the cwd folder on
    // every tile (not only the focused one), and the worktree/branch
    // chips when the workspace carries a git stamp.
    let mut fixture = fixture_snapshot_value_two_panes();
    // ws_2 becomes a linked worktree lane with a branch.
    fixture["snapshot"]["workspaces"][1]["worktree"] = json!({
        "repo_root": "/repos/herdr",
        "repo_name": "herdr",
        "branch": "feature/side-lane",
        "path": "/repos/herdr-lane",
    });
    fixture["snapshot"]["workspaces"][0]["worktree"] = json!({
        "repo_root": "/repo",
        "repo_name": "repo",
        "branch": "main",
        "path": "/repo",
    });
    fixture["snapshot"]["panes"][1]["cwd"] = json!("/repos/herdr-lane");
    let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = TuiSnapshot::from_backend_response(&fixture);
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        weights: vec![8; 2],
    };
    app.split_focus = Some("pane_2".to_string());

    // Half-width tiles must fit the whole title: at 150 cols each
    // tile is 58 wide and ratatui clips the tail of the 59-char
    // pane_2 title (the branch token), so the identity composition
    // needs a draw that leaves the tokens room.
    let drawn = draw(&app, 220, 40);

    // Both tiles: human workspace labels, never the raw ws_ ids.
    assert!(drawn.contains("Repo"), "workspace label renders");
    assert!(drawn.contains("Other"), "second workspace label renders");
    assert!(!drawn.contains("ws_1"), "raw workspace id must not render");
    assert!(!drawn.contains("ws_2"), "raw workspace id must not render");
    // Folder on both tiles: main checkout repo, linked lane checkout.
    assert!(drawn.contains("repo"));
    assert!(drawn.contains("herdr-lane"), "folder comes from pane cwd");
    // Linked lane chip + branch token on the worktree tile.
    assert!(drawn.contains("[worktree]"), "linked lane chip renders");
    assert!(
        drawn.contains("@ feature/side-lane"),
        "branch token renders"
    );
    // The main checkout shows its branch without the worktree chip
    // (@ main renders once). The strip follows the focused tile's
    // workspace (ws_2, the linked lane), so its [worktree] token
    // rides next to the tile's own chip: two total, one per surface.
    assert!(drawn.contains("@ main"));
    assert_eq!(
        drawn.matches("[worktree]").count(),
        2,
        "tile chip plus the focused workspace's strip token"
    );
}

#[test]
fn tile_titles_fall_back_to_workspace_id_without_label() {
    // A snapshot row without a label keeps rendering: the title falls
    // back to the workspace id instead of vanishing (defensive parse
    // already defaults the label, so this pins the fallback).
    let mut fixture = fixture_snapshot_value_two_panes();
    fixture["snapshot"]["workspaces"][1]["label"] = serde_json::Value::Null;
    let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = TuiSnapshot::from_backend_response(&fixture);
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        weights: vec![8; 2],
    };
    app.split_focus = Some("pane_2".to_string());
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("Workspace"), "default label renders");
}

#[test]
fn pane_buffers_follow_view_pane_on_focus_walk() {
    // refresh_tail's fetch target and the pane_buffers gate both key
    // on the view pane: after a focus walk the next refresh must
    // reset scroll/history for the newly focused pane, not keep the
    // previous pane's offsets.
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        weights: vec![8; 2],
    };
    app.split_focus = Some("pane_2".to_string());
    app.pane_buffers_pane_id = Some("pane_1".to_string());
    app.pane_scroll = 7;

    app.refresh_tail();

    // The client is a dead socket, so the read errors; the gate still
    // must have switched panes (scroll reset happens with the pane
    // switch, before the request).
    assert_eq!(app.pane_buffers_pane_id.as_deref(), Some("pane_2"));
    assert_eq!(app.pane_scroll, 0);
}

#[test]
fn resize_mode_opens_steps_and_closes_with_enter() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_1".to_string());

    // Ctrl+B Shift+Z opens resize mode on the focused tile.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));
    let state = app.resize_mode.clone().expect("resize mode open");
    assert_eq!(state.pane, "pane_1");

    // l widens pane_1: weight flows from pane_2.
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert_eq!(app.status, "tile resized");
    let crate::tui::split::SplitNode::Split { weights, .. } = &app.split_tree else {
        panic!("row split survives resize");
    };
    assert_eq!(weights, &[9, 7]);

    // Enter closes the mode.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.resize_mode.is_none());
    assert_eq!(app.status, "resize done");
    assert!(app.just_closed_mode);
}

#[test]
fn resize_mode_esc_closes_and_next_esc_does_not_quit() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_1".to_string());
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));

    // Esc closes the mode and arms the double-Esc guard.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.resize_mode.is_none());
    assert_eq!(app.status, "resize done");
    // The very next Esc must not open the quit confirm.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_ne!(app.mode, TuiMode::ConfirmQuit, "double-Esc reflex guarded");
    assert!(!app.should_quit());
}

#[test]
fn resize_mode_narrows_with_h_and_reports_clamps() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::weighted(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        vec![2, 15],
    );
    app.split_focus = Some("pane_1".to_string());
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));

    // pane_1 is at the floor: narrowing reports the clamp.
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    assert_eq!(app.status, "already at minimum size");
    let crate::tui::split::SplitNode::Split { weights, .. } = &app.split_tree else {
        panic!("row split survives resize");
    };
    assert_eq!(weights, &[2, 15]);

    // Widening still works: weight flows in from pane_2.
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert_eq!(app.status, "tile resized");
    let crate::tui::split::SplitNode::Split { weights, .. } = &app.split_tree else {
        panic!("row split survives resize");
    };
    assert_eq!(weights, &[3, 14]);
}

#[test]
fn resize_mode_reports_when_no_divider_exists() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Col,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_1".to_string());
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));

    // A col split has no vertical divider: h/l report the refusal.
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert_eq!(app.status, "no vertical divider to move");
}

#[test]
fn resize_mode_closes_when_the_pane_dies() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_1".to_string());
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));
    assert!(app.resize_mode.is_some());

    // pane_1 vanishes from the snapshot: sync must close resize mode
    // instead of stepping into a dead pane.
    app.snapshot.panes.retain(|pane| pane.id != "pane_1");
    app.sync_split_tree();
    assert!(app.resize_mode.is_none(), "dead pane closes resize mode");
}

#[test]
fn resize_mode_single_tile_and_no_focus_guard() {
    let mut app = app_with_two_panes();
    // Single leaf: nothing to resize.
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = None;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));
    assert!(app.resize_mode.is_none());
    assert_eq!(app.status, "nothing to resize (single tile)");
}

#[test]
fn resize_mode_hint_names_the_pane() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_1".to_string());
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));
    let drawn = draw(&app, 150, 40);
    assert!(
        drawn.contains("RESIZE · jcode · h/l narrower/wider · j/k shorter/taller · Enter/Esc done"),
        "footer shows the resize hint, got: {drawn}"
    );
}

#[test]
fn tile_header_falls_back_to_terminal_title_for_the_name_slot() {
    let mut app = app_with_two_panes();
    // No label, no agent: the terminal title is the pane's name.
    app.snapshot.panes[0].label = None;
    app.snapshot.panes[0].agent = None;
    app.snapshot.panes[0].display_agent = None;
    app.snapshot.panes[0].terminal_title = Some("jcode · src/foo.rs".to_string());
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_1".to_string());
    let drawn = draw(&app, 150, 40);
    assert!(
        drawn.contains("jcode · src/foo.rs"),
        "title serves as the name slot, got: {drawn}"
    );
    // The title already names the pane: no duplicate token next to it.
    assert!(
        !drawn.contains("jcode · src/foo.rs · jcode"),
        "no duplicated title token, got: {drawn}"
    );
}

#[test]
fn tile_header_shows_a_distinct_title_beside_the_name() {
    let mut app = app_with_two_panes();
    app.snapshot.panes[0].terminal_title = Some("jcode · src/foo.rs".to_string());
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_1".to_string());
    let drawn = draw(&app, 150, 40);
    // Agent name stays the name slot; the distinct title rides its own
    // token next to the workspace label (truncated to its 12-column
    // budget) and displaces the folder token.
    assert!(
        drawn.contains("○ jcode · Repo · jcode · src…"),
        "distinct title shows beside the name, got: {drawn}"
    );
}

#[test]
fn split_tiles_show_ghost_preview_and_move_rings() {
    // Split mode ghost: two tiles on the tree, a third pane available
    // from the same workspace as the candidate.
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
    app.snapshot = TuiSnapshot::from_backend_response(&three_pane_fixture());
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.split_mode.is_some());
    let drawn = draw(&app, 150, 40);
    assert!(
        drawn.contains("SPLIT · open jcode"),
        "hint names the pane by its display label, got: {drawn}"
    );
    assert!(
        drawn.contains("+ jcode ") || drawn.contains("+ pane_3 "),
        "ghost tile titles the incoming pane, got: {drawn}"
    );

    // Move mode swap rings: double borders on picked and target.
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    let state = app.move_mode.clone().unwrap();
    app.move_mode = Some(crate::tui::split::MoveState {
        target: "pane_2".to_string(),
        ..state
    });
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("⇄ moving"), "picked ring renders");
    // Swap verb: the target ring became the landing ghost (ux review:
    // show where the picked pane lands), so both display names ride
    // the ghost title instead of a "⇄ target" ring.
    assert!(
        drawn.contains("jcode ⇄ bot"),
        "swap ghost names both panes, got: {drawn}"
    );

    // Insert verb swaps the target ring for a ghost landing tile.
    let state = app.move_mode.clone().unwrap();
    app.move_mode = Some(crate::tui::split::MoveState {
        insert: true,
        ..state
    });
    let drawn = draw(&app, 150, 40);
    assert!(
        drawn.contains("pane_1 lands"),
        "insert ghost names the pane"
    );

    // A zoomed single tile draws alone and the hint bar still lists.
    let mut app = two_tile_split();
    app.split_zoomed = true;
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("cwd "), "zoomed focused tile keeps chrome");
}

#[test]
fn split_tile_tails_render_loading_and_cached_text() {
    // Unfocused tile with no tail and no fetch in flight: no output.
    let mut app = two_tile_split();
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("no output"), "empty tail placeholder");

    // Tail fetch in flight: the unfocused tile shows the loading
    // placeholder until the reply lands in the cache.
    let (_tx, rx) = std::sync::mpsc::channel();
    app.tile_tail_rx = Some(rx);
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("loading…"), "in-flight tail placeholder");
    app.tile_tail_rx = None;

    // Degenerate terminal sizes: every sub-area collapses and the
    // empty-rect guards return without panicking.
    for (w, h) in [(2, 1), (3, 2), (5, 4)] {
        let _ = draw(&app, w, h);
    }

    // Cached plain tail lines render into the unfocused tile.
    app.tile_tails
        .insert("pane_2".to_string(), "alpha\nbeta\ngamma".to_string());
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("alpha"), "cached tail renders");

    // Focused tile with no pane tail shows the attach hint.
    let mut app = two_tile_split();
    app.split_focus = Some("pane_1".to_string());
    let drawn = draw(&app, 150, 40);
    assert!(
        drawn.contains("No pane output yet"),
        "focused tile attach hint"
    );

    // Deep history renders plain, the styled live tail renders styled.
    let mut app = two_tile_split();
    app.pane_history = vec!["scrollback line".to_string(), "tail line".to_string()];
    app.pane_tail = vec!["tail line".to_string()];
    app.pane_tail_styles = vec![vec![crate::tui::terminal::TuiTextSpan {
        text: "tail line".to_string(),
        style: crate::tui::terminal::TuiTextStyle {
            bold: true,
            ..Default::default()
        },
    }]];
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("scrollback line"), "deep history renders");
    assert!(drawn.contains("tail line"), "styled tail renders");

    // The single-pane view walks the same deep history: scrollback
    // lines above the styled window render plain there too.
    let mut app = app_with_snapshot();
    app.pane_history = vec!["plain past".to_string(), "tail line".to_string()];
    app.pane_tail = vec!["tail line".to_string()];
    app.pane_tail_styles = vec![vec![crate::tui::terminal::TuiTextSpan {
        text: "tail line".to_string(),
        style: crate::tui::terminal::TuiTextStyle::default(),
    }]];
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("plain past"), "plain scrollback row");
    assert!(drawn.contains("tail line"), "live tail row");
}

#[test]
fn split_status_bar_aggregates_and_lists_tiles() {
    // Two tiles both list, counts aggregate by status.
    let app = two_tile_split();
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("AGENTS "), "status bar renders");
    assert!(drawn.contains("(Repo)"), "workspace labels list");

    // Beyond five tiles the bar switches to the aggregate form.
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
            crate::tui::split::SplitNode::leaf("ghost_1"),
            crate::tui::split::SplitNode::leaf("ghost_2"),
            crate::tui::split::SplitNode::leaf("ghost_3"),
            crate::tui::split::SplitNode::leaf("ghost_4"),
        ],
    );
    app.split_focus = Some("pane_1".to_string());
    let drawn = draw(&app, 150, 40);
    assert!(
        drawn.contains("· 1 more "),
        "overflow counts the tail, got: {drawn}"
    );
    // A tile whose pane left the snapshot renders the placeholder.
    assert!(drawn.contains(" … "), "missing pane placeholder");
}

// ---------------------------------------------------------------------------
// Split/move/resize mode handler coverage: ghost walks, cycling, guards,
// sync pruning of dead overlays, zoom restores, and refused commits.
// ---------------------------------------------------------------------------

#[test]
fn split_mode_keys_drive_the_ghost_and_cycle_candidates() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = Some("pane_1".to_string());
    app.screen = TuiScreen::Terminal;
    app.snapshot = TuiSnapshot::from_backend_response(&three_pane_fixture());
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    let preview = app.split_mode.clone().expect("split mode open");
    assert_eq!(preview.neighbor, "pane_1");
    assert_eq!(preview.pane, "pane_2", "cross-workspace first");

    // p cycles candidates: pane_2 -> pane_3 -> fresh shell sentinel
    // -> wrap pane_2 (the sentinel is the last entry).
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    assert_eq!(app.split_mode.as_ref().unwrap().pane, "pane_3");
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    assert_eq!(
        app.split_mode.as_ref().unwrap().pane,
        crate::tui::split::FRESH_SHELL
    );
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    assert_eq!(app.split_mode.as_ref().unwrap().pane, "pane_2");

    // hjkl moves the ghost: with no geometry recorded yet the walk
    // cannot move, so the neighbor stays and only mark_dirty ran.
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert_eq!(app.split_mode.as_ref().unwrap().neighbor, "pane_1");

    // Tab cycles the side family through all four edges.
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Below
    );
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Left
    );
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Above
    );
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Right
    );

    // Esc cancels and arms the double-Esc guard.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.split_mode.is_none());
    assert!(app.just_closed_mode);
    assert_eq!(app.status, "split cancelled");
}

#[test]
fn split_mode_cycle_without_candidates_reports_and_keeps_the_ghost() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = Some("pane_1".to_string());
    app.screen = TuiScreen::Terminal;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.split_mode.is_some());
    // Only pane_1 exists and it is the neighbor: no real candidates,
    // the cycle lands on the fresh-shell sentinel instead of a
    // refusal (design: "then a fresh shell"). The status is
    // overwritten by the key loop's refresh state ("connecting" on
    // the dead socket), so assert on the ghost.
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    assert!(app.split_mode.is_some(), "ghost stays open");
    assert_eq!(
        app.split_mode.as_ref().unwrap().pane,
        crate::tui::split::FRESH_SHELL,
        "no real candidate: the sentinel is the cycle's last entry"
    );
}

#[test]
fn split_commit_refuses_vanished_and_duplicate_targets() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = Some("pane_1".to_string());
    app.screen = TuiScreen::Terminal;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));

    // Neighbor gone from the tree: commit refuses and the mode
    // stays open with the reason (refused Enter is not a cancel).
    let preview = app.split_mode.clone().unwrap();
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "gone".to_string(),
        ..preview
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "split target vanished · Ctrl+B s to retry");
    assert!(app.split_mode.is_some(), "refused commit keeps the ghost");

    // Candidate already on the tree: commit refuses, mode stays.
    // The neighbor must be live so the second guard is the one that
    // fires.
    let preview = app.split_mode.clone().unwrap();
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".to_string(),
        pane: "pane_1".to_string(),
        side: preview.side,
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "pane already on screen");
    assert!(app.split_mode.is_some(), "refused commit keeps the ghost");
}

#[test]
fn move_mode_open_refusals_and_esc_cancel() {
    // Single tile: nothing to move.
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = Some("pane_1".to_string());
    app.screen = TuiScreen::Terminal;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    assert_eq!(app.status, "nothing to move (single tile)");
    assert!(app.move_mode.is_none());

    // Two tiles: opens, Esc cancels with the double-Esc guard armed.
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    assert!(app.move_mode.is_some());
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.move_mode.is_none());
    assert!(app.just_closed_mode);
    assert_eq!(app.status, "move cancelled");
}

#[test]
fn move_mode_commit_refuses_vanished_tiles_and_last_leaf_inserts() {
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    let state = app.move_mode.clone().unwrap();

    // Both named tiles gone from the tree: commit refuses.
    app.move_mode = Some(crate::tui::split::MoveState {
        picked: "gone_a".to_string(),
        target: "gone_b".to_string(),
        ..state
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "move target vanished");

    // Insert on the last two tiles: pulling the picked leaf leaves a
    // single leaf, insert lands it back beside the target.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    app.handle_key(KeyEvent::from(KeyCode::Tab)); // insert verb
    let state = app.move_mode.clone().unwrap();
    app.move_mode = Some(crate::tui::split::MoveState {
        target: "pane_2".to_string(),
        ..state
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.move_mode.is_none());
    assert_eq!(app.split_tree.leaves(), vec!["pane_2", "pane_1"]);
}

#[test]
fn sync_split_tree_prunes_dead_overlays_and_zoom() {
    // Split-mode ghost whose neighbor died closes on sync (single leaf
    // tree, pane_2 as the cross-workspace candidate).
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = Some("pane_1".to_string());
    app.screen = TuiScreen::Terminal;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.split_mode.is_some());
    // The neighbor pane_1 vanishes: sync prunes the ghost.
    app.snapshot.panes.retain(|pane| pane.id != "pane_1");
    app.sync_split_tree();
    assert!(app.split_mode.is_none(), "dead neighbor closes the ghost");

    // Move mode with both tiles alive survives, then dies when the
    // target leaves the tree.
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    let state = app.move_mode.clone().unwrap();
    app.move_mode = Some(crate::tui::split::MoveState {
        target: "pane_2".to_string(),
        ..state
    });
    // pane_2 vanishes from the snapshot: sync prunes it.
    app.snapshot.panes.retain(|pane| pane.id != "pane_2");
    app.sync_split_tree();
    assert!(app.move_mode.is_none(), "dead target closes the overlay");
    assert_eq!(app.split_tree.leaves(), vec!["pane_1"]);

    // Resize mode with a dead pane closes too.
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));
    assert!(app.resize_mode.is_some());
    // The resized pane (the focused pane_1) vanishes.
    app.snapshot.panes.retain(|pane| pane.id != "pane_1");
    app.sync_split_tree();
    assert!(app.resize_mode.is_none(), "dead resize target closes");

    // Zoomed pane vanishing clears the zoom flag: every pane must be
    // gone so the fallback focus chain ends in None.
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = Some("pane_1".to_string());
    app.screen = TuiScreen::Terminal;
    app.split_zoomed = true;
    app.snapshot.panes.clear();
    app.sync_split_tree();
    assert!(!app.split_zoomed, "zoom clears when its pane dies");
    assert_eq!(app.split_tree.leaves(), vec![""], "reseeded to empty");
}

#[test]
fn sync_split_tree_outside_terminal_leaves_the_tree_alone() {
    let mut app = two_tile_split();
    app.screen = TuiScreen::Git;
    app.split_tree = crate::tui::split::SplitNode::leaf("gone_pane");
    app.sync_split_tree();
    assert_eq!(
        app.split_tree.leaves(),
        vec!["gone_pane"],
        "no pruning off the Terminal screen"
    );
}

#[test]
fn resize_mode_guards_and_axis_refusals() {
    // Single tile: nothing to resize.
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = Some("pane_1".to_string());
    app.screen = TuiScreen::Terminal;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));
    assert_eq!(app.status, "nothing to resize (single tile)");
    assert!(app.resize_mode.is_none());

    // Column split: h/l (Row axis) finds no vertical divider.
    let mut app = two_tile_split();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Col,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));
    assert!(app.resize_mode.is_some());
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert_eq!(app.status, "no vertical divider to move");

    // Row split: j/k (Col axis) finds no horizontal divider.
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.status, "no horizontal divider to move");
    assert!(app.resize_mode.is_some(), "refusal keeps the mode open");
}

#[test]
fn zoom_open_refusals_and_resize_unzooms_first() {
    // No focus and no panes: zoom toggles nothing.
    let mut app = app_with_two_panes();
    app.snapshot.panes.clear();
    app.split_focus = None;
    app.split_toggle_zoom();
    assert!(!app.split_zoomed);

    // Resize while zoomed unzooms first (the mode needs the grid).
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    assert!(app.split_zoomed);
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('Z')));
    assert!(!app.split_zoomed, "resize unzooms");
    assert!(app.resize_mode.is_some());
    assert_eq!(app.status, "zoom off");

    // Split mode open while zoomed also unzooms.
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".to_string(),
        side: crate::tui::split::Side::Right,
        pane: "pane_2".to_string(),
    });
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(!app.split_zoomed, "open_split_mode unzooms");
}

#[test]
fn split_mode_move_ghost_without_focus_returns_silent() {
    // split_move_focus needs a focused pane: none -> silent return.
    let mut app = app_with_two_panes();
    app.split_focus = None;
    app.snapshot.panes.clear();
    app.split_move_focus(1, 0);
    assert!(app.split_mode.is_none(), "no overlay, no crash");
}

#[test]
fn split_ghost_moves_between_tiles_and_flips_side_family_only_on_axis_break() {
    let mut app = app_with_two_panes();
    app.snapshot = TuiSnapshot::from_backend_response(&three_pane_fixture());
    app.sync_split_tree();
    // Two tiles side by side, ghost overlays pane_1 proposing pane_2.
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_3"),
        ],
    );
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".into(),
        pane: "pane_2".into(),
        side: crate::tui::split::Side::Right,
    });
    // Tile geometry is recorded during render; draw once so the ghost
    // walk has real rectangles.
    draw(&app, 150, 40);

    // Zoomed: ghost moves are suppressed.
    app.split_zoomed = true;
    app.split_move_ghost(1, 0);
    assert_eq!(app.split_mode.as_ref().unwrap().neighbor, "pane_1");
    app.split_zoomed = false;

    // Horizontal move lands on the other tile and keeps the row side.
    app.split_move_ghost(1, 0);
    assert_eq!(app.split_mode.as_ref().unwrap().neighbor, "pane_3");
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Right
    );

    // Back: the row neighbor is pane_1 again.
    app.split_move_ghost(-1, 0);
    assert_eq!(app.split_mode.as_ref().unwrap().neighbor, "pane_1");

    // A vertical move on a flat row finds no neighbor: the ghost
    // stays put and the side family is untouched.
    app.split_move_ghost(0, 1);
    assert_eq!(app.split_mode.as_ref().unwrap().neighbor, "pane_1");
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Right
    );

    // A stacked (column) tree does have a vertical neighbor, and the
    // axis switch flips the side family to Below.
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Col,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_3"),
        ],
    );
    draw(&app, 150, 40);
    // The side family is still Right: the axis switch flips it to
    // Below on the way to pane_3.
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".into(),
        pane: "pane_2".into(),
        side: crate::tui::split::Side::Right,
    });
    app.split_move_ghost(0, 1);
    assert_eq!(app.split_mode.as_ref().unwrap().neighbor, "pane_3");
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Below
    );

    // The side family is already Below now: a vertical move keeps it
    // (the col-side-preserving arm).
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".into(),
        pane: "pane_2".into(),
        side: crate::tui::split::Side::Below,
    });
    app.split_move_ghost(0, 1);
    assert_eq!(app.split_mode.as_ref().unwrap().neighbor, "pane_3");
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Below
    );

    // With a single tile on the tree, a move that finds no neighbor is
    // a no-op.
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_move_ghost(0, 1);
    assert_eq!(app.split_mode.as_ref().unwrap().neighbor, "pane_3");
}

#[test]
fn split_cycle_pane_reports_when_no_alternative_exists() {
    let mut app = app_with_two_panes();
    // Both panes on the tree after a commit: no off-tree candidate,
    // so the cycle lands on the fresh-shell sentinel instead of a
    // refusal (design: "then a fresh shell").
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.split_tree.leaves(), vec!["pane_1", "pane_2"]);
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".into(),
        pane: "pane_2".into(),
        side: crate::tui::split::Side::Right,
    });
    app.split_cycle_pane();
    assert_eq!(
        app.split_mode.as_ref().unwrap().pane,
        crate::tui::split::FRESH_SHELL
    );
    assert!(app.split_mode.is_some(), "preview stays up");

    // The sentinel is the only candidate here: cycling stays on it
    // instead of refusing (a dead p key would hide the feature).
    app.split_cycle_pane();
    assert_eq!(
        app.split_mode.as_ref().unwrap().pane,
        crate::tui::split::FRESH_SHELL
    );

    // No preview at all: silent return.
    app.split_mode = None;
    app.split_cycle_pane();
    assert!(app.split_mode.is_none());
}

#[test]
fn split_flip_side_cycles_the_full_side_compass() {
    let mut app = app_with_two_panes();
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".into(),
        pane: "pane_2".into(),
        side: crate::tui::split::Side::Right,
    });
    let expect = [
        crate::tui::split::Side::Below,
        crate::tui::split::Side::Left,
        crate::tui::split::Side::Above,
        crate::tui::split::Side::Right,
    ];
    for side in expect {
        app.split_flip_side();
        assert_eq!(app.split_mode.as_ref().unwrap().side, side);
    }
    // No preview: silent return.
    app.split_mode = None;
    app.split_flip_side();
    assert!(app.split_mode.is_none());
}

#[test]
fn move_mode_walk_target_tracks_the_approach_side() {
    let mut app = app_with_two_panes();
    app.snapshot = TuiSnapshot::from_backend_response(&three_pane_fixture());
    app.sync_split_tree();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_3"),
        ],
    );
    app.move_mode = Some(crate::tui::split::MoveState {
        picked: "pane_1".into(),
        target: "pane_1".into(),
        insert: false,
        side: crate::tui::split::Side::Right,
    });
    draw(&app, 150, 40);

    // Zoomed: suppressed.
    app.split_zoomed = true;
    app.move_walk_target(1, 0);
    assert_eq!(app.move_mode.as_ref().unwrap().target, "pane_1");
    app.split_zoomed = false;

    // Walking right approaches from the left edge.
    app.move_walk_target(1, 0);
    assert_eq!(app.move_mode.as_ref().unwrap().target, "pane_3");
    assert_eq!(
        app.move_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Left
    );

    // Walking back left skips the picked tile itself (the insert
    // preview never targets the pane being moved), so the target
    // stays on pane_3.
    app.move_walk_target(-1, 0);
    assert_eq!(app.move_mode.as_ref().unwrap().target, "pane_3");

    // A column tree walks vertically: dy > 0 approaches from above,
    // dy < 0 from below.
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
            crate::tui::split::SplitNode::leaf("pane_3"),
        ],
    );
    app.mark_dirty();
    draw(&app, 150, 40);
    // Walking left from pane_3 skips the picked pane_1 and lands on
    // pane_2, approached from its right edge.
    app.move_walk_target(-1, 0);
    assert_eq!(app.move_mode.as_ref().unwrap().target, "pane_2");
    assert_eq!(
        app.move_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Right
    );

    // A column tree walks vertically: dy < 0 approaches pane_1 from
    // below, dy > 0 approaches pane_3 from above. The picked pane_1
    // stays skipped in the horizontal walk but is a legal vertical
    // target from pane_2.
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Col,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
            crate::tui::split::SplitNode::leaf("pane_3"),
        ],
    );
    app.mark_dirty();
    draw(&app, 150, 40);
    // Walking down from pane_2 approaches pane_3 from above; the
    // picked pane_1 is always skipped, so walking up from pane_2
    // finds nothing.
    app.move_walk_target(0, -1);
    assert_eq!(app.move_mode.as_ref().unwrap().target, "pane_2");
    app.move_walk_target(0, 1);
    assert_eq!(app.move_mode.as_ref().unwrap().target, "pane_3");
    assert_eq!(
        app.move_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Above
    );
    // Walking back up approaches pane_2 from below.
    app.move_walk_target(0, -1);
    assert_eq!(app.move_mode.as_ref().unwrap().target, "pane_2");
    assert_eq!(
        app.move_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Below
    );
    app.move_walk_target(0, 1);
    assert_eq!(app.move_mode.as_ref().unwrap().target, "pane_3");

    // A single-tile tree finds no neighbor: silent no-op.
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_3");
    app.mark_dirty();
    draw(&app, 150, 40);
    app.move_walk_target(0, 1);
    assert_eq!(app.move_mode.as_ref().unwrap().target, "pane_3");

    // No mode: silent return.
    app.move_mode = None;
    app.move_walk_target(1, 0);
    assert!(app.move_mode.is_none());
}

#[test]
fn move_mode_key_handler_routes_tab_esc_and_walking() {
    let mut app = app_with_two_panes();
    app.snapshot = TuiSnapshot::from_backend_response(&three_pane_fixture());
    app.sync_split_tree();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_3"),
        ],
    );
    app.move_mode = Some(crate::tui::split::MoveState {
        picked: "pane_1".into(),
        target: "pane_1".into(),
        insert: false,
        side: crate::tui::split::Side::Right,
    });
    draw(&app, 150, 40);

    // Tab toggles the insert verb.
    app.handle_move_mode_key(KeyEvent::from(KeyCode::Tab));
    assert!(app.move_mode.as_ref().unwrap().insert);
    app.handle_move_mode_key(KeyEvent::from(KeyCode::Tab));
    assert!(!app.move_mode.as_ref().unwrap().insert);

    // hjkl and the arrow keys walk the target.
    app.handle_move_mode_key(KeyEvent::from(KeyCode::Char('l')));
    assert_eq!(app.move_mode.as_ref().unwrap().target, "pane_3");
    app.handle_move_mode_key(KeyEvent::from(KeyCode::Char('h')));
    // The picked tile (pane_1) is skipped by walks, so the target
    // stays on pane_3 through the left/up/down steps; Right re-lands
    // on it too.
    app.handle_move_mode_key(KeyEvent::from(KeyCode::Left));
    app.handle_move_mode_key(KeyEvent::from(KeyCode::Right));
    app.handle_move_mode_key(KeyEvent::from(KeyCode::Up));
    app.handle_move_mode_key(KeyEvent::from(KeyCode::Down));
    assert_eq!(app.move_mode.as_ref().unwrap().target, "pane_3");

    // An inert key falls through without touching the mode.
    app.handle_move_mode_key(KeyEvent::from(KeyCode::Char('x')));

    // Esc cancels.
    app.handle_move_mode_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.move_mode.is_none());
    assert_eq!(app.status, "move cancelled");

    // No mode: keys are inert.
    app.handle_move_mode_key(KeyEvent::from(KeyCode::Char('l')));
    assert!(app.move_mode.is_none());
}

#[test]
fn open_move_mode_guards_single_tile_and_missing_focus() {
    let mut app = app_with_two_panes();
    // Single tile: refused.
    app.open_move_mode();
    assert_eq!(app.status, "nothing to move (single tile)");
    assert!(app.move_mode.is_none());

    // No panes at all: no focus guard.
    app.snapshot = TuiSnapshot::from_backend_response(&json!({"snapshot": {
        "workspaces": [], "tabs": [], "panes": [], "agents": []
    }}));
    app.split_tree = crate::tui::split::SplitNode::leaf("gone");
    app.open_move_mode();
    assert_eq!(app.status, "no pane to move");
    assert!(app.move_mode.is_none());
}

#[test]
fn resize_mode_opens_walks_and_guards() {
    let mut app = app_with_two_panes();
    app.snapshot = TuiSnapshot::from_backend_response(&three_pane_fixture());
    app.sync_split_tree();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_3"),
        ],
    );

    // Single tile guard first.
    let single = app.split_tree.clone();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.open_resize_mode();
    assert_eq!(app.status, "nothing to resize (single tile)");
    assert!(app.resize_mode.is_none());
    app.split_tree = single;

    // Zoomed auto-unzoom opens resize mode.
    app.split_zoomed = true;
    app.open_resize_mode();
    assert!(!app.split_zoomed);
    assert_eq!(app.status, "zoom off");
    assert!(app.resize_mode.is_some());
    assert_eq!(app.resize_mode.as_ref().unwrap().pane, "pane_1");

    // h narrows the focused tile.
    let before = app.split_tree.clone();
    app.resize_step_direction(
        crate::tui::split::SplitDir::Row,
        crate::tui::split::ResizeDir::Narrow,
    );
    assert_eq!(app.status, "tile resized");
    assert_ne!(app.split_tree, before);

    // l widens it back.
    app.resize_step_direction(
        crate::tui::split::SplitDir::Row,
        crate::tui::split::ResizeDir::Wider,
    );
    assert_eq!(app.split_tree, before);

    // A nested tree: resizing pane_1 on the row axis has no row
    // divider in its own column, so the outer frame's divider moves.
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::split(
                crate::tui::split::SplitDir::Col,
                vec![
                    crate::tui::split::SplitNode::leaf("pane_1"),
                    crate::tui::split::SplitNode::leaf("pane_2"),
                ],
            ),
            crate::tui::split::SplitNode::leaf("pane_3"),
        ],
    );
    app.resize_step_direction(
        crate::tui::split::SplitDir::Row,
        crate::tui::split::ResizeDir::Narrow,
    );
    assert_eq!(app.status, "resized outer boundary");

    // Key handler routing: j/k drive the col axis (no col dividers
    // on a flat row, so the move reports the outer boundary).
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_3"),
        ],
    );
    for key in [
        KeyCode::Char('l'),
        KeyCode::Char('k'),
        KeyCode::Char('j'),
        KeyCode::Char('h'),
        KeyCode::Left,
        KeyCode::Right,
        KeyCode::Up,
        KeyCode::Down,
        KeyCode::Char('x'),
    ] {
        app.handle_resize_mode_key(KeyEvent::from(key));
    }
    assert_eq!(
        app.status, "no horizontal divider to move",
        "col verbs on a flat row refuse with the divider note"
    );

    // No mode: inert.
    app.resize_mode = None;
    app.handle_resize_mode_key(KeyEvent::from(KeyCode::Char('l')));
    assert!(app.resize_mode.is_none());
}

#[test]
fn split_mode_commit_refuses_when_the_neighbor_vanished() {
    let mut app = app_with_two_panes();
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "gone".into(),
        pane: "pane_2".into(),
        side: crate::tui::split::Side::Right,
    });
    app.split_commit();
    assert_eq!(app.status, "split target vanished · Ctrl+B s to retry");
    assert!(app.split_mode.is_some(), "refused commit keeps the ghost");
    assert_eq!(app.split_tree.leaves(), vec!["pane_1"], "tree untouched");

    // No preview at all: silent return.
    app.split_mode = None;
    app.split_commit();
    assert_eq!(app.split_tree.leaves(), vec!["pane_1"]);
}

#[test]
fn handle_split_mode_key_routes_all_verbs() {
    let mut app = app_with_two_panes();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.split_mode.is_some());

    // hjkl move the ghost (draw once so geometry exists).
    draw(&app, 150, 40);
    let before = app.split_mode.as_ref().unwrap().neighbor.clone();
    app.handle_split_mode_key(KeyEvent::from(KeyCode::Char('l')));
    app.handle_split_mode_key(KeyEvent::from(KeyCode::Char('h')));
    app.handle_split_mode_key(KeyEvent::from(KeyCode::Char('j')));
    app.handle_split_mode_key(KeyEvent::from(KeyCode::Char('k')));
    assert_eq!(app.split_mode.as_ref().unwrap().neighbor, before);

    // Inert key with no direction: falls through.
    app.handle_split_mode_key(KeyEvent::from(KeyCode::Char('x')));
    assert!(app.split_mode.is_some());

    // Esc cancels.
    app.handle_split_mode_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.split_mode.is_none());
    assert_eq!(app.status, "split cancelled");
}

#[test]
fn split_view_with_a_zero_height_pane_area_draws_no_tiles() {
    let app = two_tile_split();
    // Coverage note (render/mod.rs truncate copy): its bare tail after
    // the char loop is the same mathematically unreachable shape as
    // terminal's truncate — a char sum over max_width must trip the
    // in-loop check first (see terminal/mod.rs coverage_tests).
    // Height 2 with a positive width: render_main runs (its area guard
    // passes), the vertical layout gives the two fixed rows to the tab
    // bar and status bar, so pane_area is height 0 and empty while the
    // frame is not — exactly what render_split_view's own guard needs.
    // Width 0 cannot reach it: render_main's area guard fires first.
    // Height alone can never trigger it with 3+ rows: the pane column
    // holds Min(1), and the solver always grants a Minimum its floor
    // even over-constrained.
    let drawn = draw(&app, 80, 2);
    assert!(!drawn.contains("pane_1"), "no tiles render");
    assert!(!drawn.contains("pane_2"), "no tiles render");
}

#[test]
fn split_overlays_survive_one_column_tiles_without_panicking() {
    // A 1-column pane area halves to a zero-width ghost half: the
    // render_ghost is_empty guard fires and the frame still draws
    // everything else. Uses the raw buffer debug string so a panic,
    // not a missing glyph, fails the test.
    // Note: render_double_border's own guard is layout-invariant-
    // unreachable — layout_tiles drops empty-area leaves (the !area.
    // is_empty check), so a tile reaching the ring painters never
    // carries an empty rect; only the ghost halves can be empty.
    let mut app = two_tile_split();
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".into(),
        pane: "pane_3".into(),
        side: crate::tui::split::Side::Right,
    });
    let drawn = draw(&app, 1, 40);
    // The ghost half is zero-width so nothing of it renders, and the
    // tile block still drew its border: the box-drawing vertical bar
    // is the tile's left border in the single column, proving the
    // render pipeline ran (a bare "no panic" assert could pass on an
    // empty buffer).
    assert!(
        !drawn.contains("+ pane_3"),
        "zero-width ghost draws nothing"
    );
    // The split ring now owns the neighbor border, so the double
    // vertical bar proves the pipeline ran (the target-highlight
    // round replaced the plain single bar there).
    assert!(
        drawn.contains('║') || drawn.contains('│'),
        "tile borders still render"
    );

    // Move mode at 1 column: both rings hit the empty-rect guard.
    let mut app = two_tile_split();
    app.move_mode = Some(crate::tui::split::MoveState {
        picked: "pane_1".into(),
        target: "pane_2".into(),
        insert: false,
        side: crate::tui::split::Side::Right,
    });
    draw(&app, 1, 40);

    // Same guards via the insert verb (ghost target instead of ring).
    app.move_mode = Some(crate::tui::split::MoveState {
        insert: true,
        ..app.move_mode.clone().unwrap()
    });
    draw(&app, 1, 40);
    // Reaching here without a panic is the point: the zero-width
    // halves never reach ratatui with a non-empty claim.
}

#[test]
fn layout_weights_fall_back_to_equal_shares_for_missing_entries() {
    // A hand-built tree whose weights are missing: layout still
    // splits equally (recorded geometry proves it) instead of
    // panicking. Also pins the empty-children and empty-area arms.
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    draw(&app, 150, 40);
    let geometry = app.tile_geometry_snapshot();
    assert_eq!(geometry.len(), 2);
    assert_eq!(geometry[0].width, geometry[1].width, "equal shares");

    // Zero-height window: layout bails without panicking.
    let drawn = draw(&app, 10, 0);
    assert!(drawn.is_empty() || !drawn.contains("AGENTS"));
}

#[test]
fn open_split_mode_reports_no_focus_when_nothing_is_alive() {
    let mut app = app_with_two_panes();
    app.snapshot = TuiSnapshot::from_backend_response(&json!({"snapshot": {
        "workspaces": [], "tabs": [], "panes": [], "agents": []
    }}));
    app.open_split_mode();
    assert_eq!(app.status, "no pane to split");
    assert!(app.split_mode.is_none());
}

#[test]
fn open_resize_mode_reports_no_focus_when_nothing_is_alive() {
    let mut app = app_with_two_panes();
    app.snapshot = TuiSnapshot::from_backend_response(&json!({"snapshot": {
        "workspaces": [], "tabs": [], "panes": [], "agents": []
    }}));
    app.open_resize_mode();
    assert_eq!(app.status, "no pane to resize");
    assert!(app.resize_mode.is_none());
}

#[test]
fn split_move_ghost_without_a_preview_is_silent() {
    let mut app = app_with_two_panes();
    app.split_mode = None;
    app.split_move_ghost(1, 0);
    assert!(app.split_mode.is_none());
}

#[test]
fn move_mode_guards_pick_eq_target_missing_mode_and_last_leaf_insert() {
    let mut app = app_with_two_panes();

    // No mode: silent return.
    app.move_commit();
    assert!(app.move_mode.is_none());

    // Picked equals target: refused with a reason, mode stays open.
    app.move_mode = Some(crate::tui::split::MoveState {
        picked: "pane_1".into(),
        target: "pane_1".into(),
        insert: true,
        side: crate::tui::split::Side::Right,
    });
    app.move_commit();
    assert!(app.move_mode.is_some());
    assert_eq!(
        app.status,
        "target is the picked tile: hjkl moves the target"
    );
    app.move_mode = None;
    assert_eq!(app.split_tree.leaves(), vec!["pane_1"]);

    // Toggle with no mode: silent.
    app.move_mode = None;
    app.move_toggle_insert();
    assert!(app.move_mode.is_none());

    // Insert where the picked pane is not on the tree at all: the
    // vanished guard fires.
    app.move_mode = Some(crate::tui::split::MoveState {
        picked: "ghost".into(),
        target: "pane_1".into(),
        insert: false,
        side: crate::tui::split::Side::Right,
    });
    app.move_commit();
    assert_eq!(app.status, "move target vanished");

    // Insert with a 2-leaf tree where the target is not on the tree
    // after the earlier guards: the vanished-target guard inside the
    // insert branch fires (target checked again after the pull).
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.move_mode = Some(crate::tui::split::MoveState {
        picked: "pane_1".into(),
        target: "pane_1".into(),
        insert: true,
        side: crate::tui::split::Side::Right,
    });
    app.move_commit();
    // Note: the "move picked the last tile" arm is unreachable — it
    // needs remove_leaf to return None, which only happens when the
    // tree is a lone leaf equal to picked, but picked == target
    // returns first. The "target vanished after pull" arm is likewise
    // unreachable with a consistent tree.
}

#[test]
fn split_ghost_axis_break_flips_a_col_side_to_right_on_horizontal_moves() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_3"),
        ],
    );
    // Preview family is col (Below) but the move is horizontal: the
    // family switches to Right.
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".into(),
        pane: "pane_2".into(),
        side: crate::tui::split::Side::Below,
    });
    draw(&app, 150, 40);
    app.split_move_ghost(1, 0);
    assert_eq!(app.split_mode.as_ref().unwrap().neighbor, "pane_3");
    assert_eq!(
        app.split_mode.as_ref().unwrap().side,
        crate::tui::split::Side::Right
    );
}

#[test]
fn move_toggle_insert_flips_the_verb_with_a_live_state() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.move_mode = Some(crate::tui::split::MoveState {
        picked: "pane_1".into(),
        target: "pane_1".into(),
        insert: false,
        side: crate::tui::split::Side::Right,
    });
    app.move_toggle_insert();
    assert!(app.move_mode.as_ref().unwrap().insert);
    app.move_toggle_insert();
    assert!(!app.move_mode.as_ref().unwrap().insert);
}

#[test]
fn move_panel_selects_the_tab_of_the_pane_the_agent_list_points_at() {
    let mut app = app_with_snapshot();
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":2,"tab_count":2,"active_tab_id":"tab_2"}],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":false,"pane_count":1,"agent_status":"idle"},
                {"tab_id":"tab_2","workspace_id":"ws_1","label":"Server","focused":false,"pane_count":1,"agent_status":"idle"}
            ],
            "panes": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":false},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_2","agent":"bot","display_agent":"bot","agent_status":"idle","cwd":"/repo","focused":false}
            ],
            "agents": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":false},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_2","agent":"bot","display_agent":"bot","agent_status":"idle","cwd":"/repo","focused":false}
            ]
        }
    }));
    // Cursor on the first agent (pane_1, tab_1): moving selects tab_1
    // and repoints the agent cursor at its pane's entry.
    app.selected_agent = 0;
    let message = app.move_panel(1).unwrap();
    assert_eq!(message, "panel 2/2");
    assert_eq!(app.selected_agent, 1, "agent cursor follows tab_2's pane");
}

#[test]
fn move_panel_keeps_the_cursor_when_the_tab_has_no_agent_entry() {
    let mut app = app_with_snapshot();
    // tab_2 has no pane entry at all: neither the pane lookup nor the
    // agent repoint finds anything, and the panel still switches.
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":2,"tab_count":2,"active_tab_id":"tab_1"}],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":false,"pane_count":1,"agent_status":"idle"},
                {"tab_id":"tab_2","workspace_id":"ws_1","label":"Server","focused":false,"pane_count":1,"agent_status":"idle"}
            ],
            "panes": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":false}
            ],
            "agents": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":false}
            ]
        }
    }));
    // Moving to tab_2 finds no pane: the agent cursor stays on pane_1's
    // row and the status still reports the switch.
    app.selected_agent = 0;
    let message = app.move_panel(1).unwrap();
    assert_eq!(message, "panel 2/2");
    assert_eq!(app.selected_agent, 0, "no pane row to repoint at");
}

#[test]
fn tile_titles_stamp_worktree_and_branch_chip() {
    // A workspace stamped as a linked worktree with a branch renders
    // the [worktree] marker and the @ branch chip on its tile title;
    // the focused tile renders through the full single-pane chrome.
    let mut app = app_with_two_panes();
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,
                 "agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1",
                 "worktree":{"repo_root":"/repo","repo_name":"repo","branch":"feature-x",
                             "checkout_path":"/repo/.wt/feature-x"}}
            ],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"}
            ],
            "panes": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1",
                 "agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo/.wt/feature-x","focused":true}
            ],
            "agents": []
        }
    }));
    app.sync_split_tree();
    app.split_focus = Some("pane_1".to_string());
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("[worktree] "), "worktree marker on the tile");
    assert!(drawn.contains("@ feature-x "), "branch chip on the tile");

    // A three-row terminal: tab bar and AGENTS bar take the body, the
    // pane area collapses to zero and the split view early-returns.
    // The tree needs two tiles for the split path to run at all.
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    let _ = draw(&app, 150, 2);
    let _ = draw(&app, 150, 3);
    let _ = draw(&app, 150, 4);

    // A tile whose workspace vanished from the snapshot still renders:
    // the workspace lookup falls back to the raw id.
    app.snapshot.workspaces.clear();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.snapshot.panes.push(crate::tui::model::TuiPane {
        id: "pane_2".into(),
        terminal_id: "term_2".into(),
        workspace_id: "ws_missing".into(),
        tab_id: "tab_1".into(),
        label: None,
        agent: Some("bot".into()),
        display_agent: Some("bot".into()),
        agent_status: "idle".into(),
        cwd: "/elsewhere".into(),
        focused: false,
        terminal_title: None,
        agent_session: None,
    });
    app.split_focus = Some("pane_2".to_string());
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("ws_missing"), "fallback workspace token");
}

#[test]
fn nearest_leaf_to_scores_by_center_distance_not_tree_order() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::Split {
                dir: crate::tui::split::SplitDir::Col,
                children: vec![
                    crate::tui::split::SplitNode::leaf("pane_2"),
                    crate::tui::split::SplitNode::leaf("pane_3"),
                ],
                weights: vec![8; 2],
            },
        ],
    );
    // Row split with a column right half: pane_2 is the right-top
    // quadrant, pane_3 the right-bottom one. The dead pane sits on the
    // right-bottom slot, so the center-to-center winner is pane_3 even
    // though pane_1 is the first leaf on the tree.
    push_tile_geometry(
        &mut app,
        &[
            ("pane_1", 0, 0, 50, 40),
            ("pane_2", 50, 0, 50, 20),
            ("pane_3", 50, 20, 50, 20),
        ],
    );
    assert_eq!(app.nearest_leaf_to("pane_3").as_deref(), Some("pane_2"));

    // Unknown origin pane: no geometry row, nothing to score.
    assert_eq!(app.nearest_leaf_to("no_such_pane"), None);

    // Origin present but no other leaf carries geometry.
    push_tile_geometry(&mut app, &[("pane_1", 0, 0, 50, 40)]);
    assert_eq!(app.nearest_leaf_to("pane_1"), None);
}

#[test]
fn sync_split_tree_parks_focus_on_the_nearest_surviving_leaf() {
    let mut app = app_with_two_panes();
    push_pane_3(&mut app);
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::Split {
                dir: crate::tui::split::SplitDir::Col,
                children: vec![
                    crate::tui::split::SplitNode::leaf("pane_2"),
                    crate::tui::split::SplitNode::leaf("pane_3"),
                ],
                weights: vec![8; 2],
            },
        ],
    );
    // pane_3 occupies the right-bottom quadrant and holds focus; the
    // recorded geometry keeps its last rect so the prune can score
    // survivors against it.
    push_tile_geometry(
        &mut app,
        &[
            ("pane_1", 0, 0, 50, 40),
            ("pane_2", 50, 0, 50, 20),
            ("pane_3", 50, 20, 50, 20),
        ],
    );
    app.split_focus = Some("pane_3".to_string());
    app.snapshot.panes.retain(|pane| pane.id != "pane_3");

    app.sync_split_tree();

    assert_eq!(
        app.split_focus.as_deref(),
        Some("pane_2"),
        "focus lands on the geometrically nearest survivor, not the first leaf"
    );
    assert!(app.status.contains("focus moved to"), "{}", app.status);
}

#[test]
fn sync_split_tree_lifts_zoom_when_the_zoomed_pane_vanished() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_2".to_string());
    app.split_zoomed = true;
    // pane_2 gone from the snapshot: prune keeps a single leaf, focus
    // dies with it, and the zoomed flag must drop so the collapsed
    // tree renders unzoomed.
    app.snapshot.panes.retain(|pane| pane.id != "pane_2");
    app.sync_split_tree();
    assert!(!app.split_zoomed);
    assert_eq!(app.split_tree.leaves(), vec!["pane_1"]);
}

#[test]
fn resize_mode_rings_the_resized_pane() {
    let app = resize_mode_app();
    let drawn = draw(&app, 150, 40);
    assert!(
        drawn.contains(" resize "),
        "resize ring titles the resized tile"
    );
}

#[test]
fn split_mode_neighbor_ring_and_ghost_coexist() {
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
    app.snapshot = TuiSnapshot::from_backend_response(&three_pane_fixture());
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    let buffer = draw_buffer(&app, 150, 40);
    let row = rendered_row(&buffer, "splits here");
    // Double border corner left of the ring title proves the Double
    // shape (ghost corners are Rounded).
    let corner = row.chars[..row.cell_x_of("splits here").unwrap()]
        .iter()
        .rposition(|c| *c == '╔')
        .expect("double corner left of the ring title");
    let _ = corner;
    let drawn = format!("{buffer:?}");
    assert!(
        drawn.contains("+ pane_3 ") || drawn.contains("+ jcode "),
        "ghost still renders beside the ring"
    );
}

#[test]
fn focused_tile_title_carries_marker_and_alt_bg() {
    let app = two_tile_split();
    let buffer = draw_buffer(&app, 150, 40);
    let row = rendered_row(&buffer, "▸");
    assert!(
        row.as_line_string().contains("▸ "),
        "focused tile title starts with the marker"
    );
    // The focused tile interior lifts to panel_alt.
    let alt = app.palette.panel_alt;
    assert!(
        buffer.content().iter().any(|cell| cell.bg == alt),
        "focused tile interior uses panel_alt"
    );
}

#[test]
fn split_active_single_tile_draws_no_ring() {
    let mut app = app_with_two_panes();
    app.screen = TuiScreen::Terminal;
    // Zoom forces the split path with only the focused tile drawn.
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_zoomed = true;
    app.split_focus = Some("pane_1".to_string());
    let drawn = draw(&app, 100, 30);
    assert!(!drawn.contains(" resize "));
    assert!(!drawn.contains("⇄ moving"));
}

#[test]
fn resize_mode_in_single_pane_view_draws_no_ring_and_does_not_panic() {
    let mut app = app_with_two_panes();
    app.screen = TuiScreen::Terminal;
    // Single leaf: the resize chord refuses to open the mode, and
    // rendering must stay calm either way.
    app.handle_key(ctrl('b'));
    app.handle_key(shift_z());
    assert!(app.resize_mode.is_none(), "single tile refuses resize mode");
    // The ring title is ` resize ` with padding spaces; the footer
    // legend says `Z resize` unpadded, so the padded form is the
    // ring-only discriminator.
    let drawn = draw(&app, 100, 30);
    assert!(!drawn.contains(" resize \u{20}"), "no ring title renders");
    assert!(!drawn.contains(" splits here "));
}

#[test]
fn split_mode_with_vanished_neighbor_skips_the_ring() {
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.split_mode.is_some());
    // Neighbor left the tree between open and render.
    let preview = app.split_mode.clone().unwrap();
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_gone".to_string(),
        ..preview
    });
    let drawn = draw(&app, 150, 40);
    assert!(
        !drawn.contains(" splits here "),
        "no neighbor tile: no ring, no panic"
    );
}

#[test]
fn sync_split_tree_clears_zoom_and_overlays_when_panes_vanish() {
    let mut app = app_with_two_panes();
    app.split_zoomed = true;
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_2".to_string(),
        side: crate::tui::split::Side::Right,
        pane: "pane_3".to_string(),
    });
    app.move_mode = Some(crate::tui::split::MoveState {
        picked: "pane_1".to_string(),
        target: "pane_2".to_string(),
        insert: true,
        side: crate::tui::split::Side::Left,
    });
    app.resize_mode = Some(crate::tui::split_mode::ResizeState {
        pane: "pane_1".to_string(),
    });
    // Snapshot loses every pane: zoom, split preview, move, and resize
    // overlays must all clear instead of pointing at dead panes.
    app.snapshot.panes.clear();
    app.sync_split_tree();
    assert!(!app.split_zoomed);
    assert!(app.split_mode.is_none());
    assert!(app.move_mode.is_none());
    assert!(app.resize_mode.is_none());
}

#[test]
fn sync_split_tree_clears_zoom_when_only_the_focused_pane_remains() {
    // Two panes zoomed on pane_1, then pane_2 dies: the tree keeps
    // pane_1 so the len<2 arm fires, but focus stays valid.
    let mut app = app_with_two_panes();
    app.split_focus = Some("pane_1".to_string());
    app.split_zoomed = true;
    app.snapshot.panes.retain(|pane| pane.id != "pane_2");
    app.sync_split_tree();
    assert!(!app.split_zoomed);
    assert_eq!(app.split_focus.as_deref(), Some("pane_1"));
}

#[test]
fn split_move_focus_walks_between_tiles_and_stays_at_edges() {
    // Two side-by-side tiles from a real draw: a right walk lands on
    // pane_2, another right walk has no further tile so focus stays.
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        weights: vec![1; 2],
    };
    app.split_focus = Some("pane_1".to_string());
    draw(&app, 80, 24);
    app.split_move_focus(1, 0);
    assert_eq!(app.split_focus.as_deref(), Some("pane_2"));
    app.split_move_focus(1, 0);
    assert_eq!(
        app.split_focus.as_deref(),
        Some("pane_2"),
        "no tile to the right: focus stays"
    );
    app.split_move_focus(-1, 0);
    assert_eq!(app.split_focus.as_deref(), Some("pane_1"));
}

#[test]
fn sync_split_tree_clears_stale_zoom_preview_move_and_resize_state() {
    // All four stale-state guards fire in one sync: the zoomed pane, the
    // split preview neighbor, the move pair, and the resize origin all
    // point at panes that no longer exist in the tree.
    let mut app = two_tile_split();
    use crate::tui::split::{MoveState, Side, SplitPreview};
    app.split_zoomed = true;
    app.split_focus = Some("gone".to_string());
    app.split_mode = Some(SplitPreview {
        neighbor: "gone".to_string(),
        side: Side::Right,
        pane: "pane_2".to_string(),
    });
    app.move_mode = Some(MoveState {
        picked: "gone".to_string(),
        target: "also-gone".to_string(),
        insert: true,
        side: Side::Below,
    });
    app.resize_mode = Some(crate::tui::split_mode::ResizeState {
        pane: "gone".to_string(),
    });
    app.last_resize_dir = Some((
        crate::tui::split::SplitDir::Row,
        crate::tui::split::ResizeDir::Wider,
    ));
    app.snapshot.panes.clear();
    app.sync_split_tree();
    assert!(!app.split_zoomed);
    assert!(app.split_mode.is_none());
    assert!(app.move_mode.is_none());
    assert!(app.resize_mode.is_none());
    assert!(app.last_resize_dir.is_none());
}

#[test]
fn view_pane_finds_the_focused_pane_and_active_cwd_falls_back_to_the_agent() {
    // Focus on a live pane: view_pane returns it. With the workspace
    // cwd empty, active_cwd falls back to the selected agent's cwd.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Terminal;
    app.split_focus = Some("pane_1".to_string());
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    assert_eq!(app.view_pane().map(|pane| pane.id.as_str()), Some("pane_1"));

    app.snapshot.workspaces[0].cwd = String::new();
    assert_eq!(app.active_cwd().as_deref(), Some("/repo"));
}
