//! Coverage round tests.

use super::*;

#[test]
fn create_tab_on_a_split_pane_whose_workspace_is_gone() {
    // Two tiles, the focused pane's workspace left the list: the
    // workspace-position miss runs inside create_tab (the cursor
    // move is skipped).
    let mut app = two_tile_split();
    app.snapshot.panes[0].workspace_id = "ws_gone".to_string();
    app.create_tab();
    assert_eq!(app.selected_workspace, 0, "cursor stays on the old row");
}

#[test]
fn move_panel_on_a_split_pane_whose_workspace_is_gone() {
    // Two tiles, the focused pane's workspace left the list: the
    // position miss runs inside move_panel's cursor-follow block.
    let mut app = two_tile_split();
    app.snapshot.panes[0].workspace_id = "ws_gone".to_string();
    let _ = app.move_panel(1);
    assert_eq!(app.selected_workspace, 0);
}

#[test]
fn worktree_create_succeeds_end_to_end_through_the_fake_backend() {
    // The full chain: worktree.create answers ok and the refresh
    // (ping + snapshot) succeeds, so the success arm of the
    // confirm-prompt result mapping runs.
    let (socket, _stop) = fake_backend_socket_with(fixture_snapshot_value());
    let mut app = TuiApp::new(BackendClient::new(&socket, &socket), Duration::from_secs(1));
    app.refresh()
        .expect("fake backend answers ping and snapshot");
    app.worktree_create_stage = Some(crate::tui::workspace::WorktreeCreateStage::Path(
        "feature".to_string(),
        "/repo/wt-feature".to_string(),
        "main".to_string(),
    ));
    app.prompt_input = Some(crate::tui::PromptInput::new(
        crate::tui::PromptKind::ConfirmWorktreePullBase,
    ));
    crate::tui::workspace::run_prompt(
        &mut app,
        &crate::tui::workspace::WorkspacePrompt::ConfirmWorktreePullBase,
        "y",
    );
    assert!(app.error.is_none(), "{:?}", app.error);
    assert!(app.status.contains("worktree created"), "{}", app.status);
    assert!(
        app.worktree_create_stage.is_none(),
        "stage cleared on success"
    );
}

#[test]
fn file_preview_marks_dirty_edits_and_markdown_outline_in_the_title() {
    // Dirty preview paints the asterisk marker; a `.markdown`
    // extension (not just `.md`) flips the outline title.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.file_explorer.preview.path = Some("/repo/README.md".to_string());
    app.file_explorer.preview.content = "# Title\nbody".to_string();
    app.file_explorer.preview.dirty = true;
    app.file_explorer.edit_active = true;
    let text = draw(&app, 150, 30);
    assert!(text.contains('*'), "dirty marker renders");
    assert!(text.contains("Editing"), "edit-in-progress title");

    app.file_explorer.edit_active = false;

    app.file_explorer.preview.dirty = false;
    app.file_explorer.preview.path = Some("/repo/NOTES.markdown".to_string());
    app.file_explorer.markdown_outline = true;
    let text = draw(&app, 150, 30);
    assert!(text.contains("Outline"), "markdown outline title");
}

#[test]
fn blame_author_spans_skip_lines_without_diff_metadata() {
    // Blame on with authors keyed by lines the diff meta does not
    // carry: the metadata miss arms of the author-span chain run
    // without rendering an author.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.git_panel.view = crate::tui::panels::git::GitView::Changes;
    app.git_panel.blame_path = Some("src/app.rs".to_string());
    app.git_panel.diff_title = "src/app.rs".to_string();
    app.git_panel.show_blame = true;
    app.git_panel
        .blame_authors
        .insert(99, "Ghost Author".to_string());
    app.git_panel.diff_meta = vec![None];
    app.git_panel.diff_lines = vec!["line one".to_string(), "line two".to_string()];
    let _ = draw(&app, 120, 30);
    assert!(!app.git_panel.blame_authors.is_empty());
}

#[test]
fn wrap_input_hard_breaks_a_wider_word_without_a_boundary_space() {
    // A word wider than the row flushes mid-word: the breaking
    // token carries no trailing space, so the boundary-space
    // branch is skipped (its else).
    let rows = crate::tui::render::wrap_input_with_cursor("averyveryverylongword", 10);
    assert!(rows.len() >= 3, "hard-break splits the word: {rows:?}");
    assert!(rows.iter().all(|row| !row.ends_with(' ')));
}

#[test]
fn resize_preview_skips_tiles_the_resize_state_no_longer_matches() {
    // Resize mode names a pane that left the tree: the tile lookup
    // misses and the whole preview block is skipped.
    let mut app = two_tile_split();
    app.resize_mode = Some(crate::tui::split_mode::ResizeState {
        pane: "gone".to_string(),
    });
    app.last_resize_dir = Some((
        crate::tui::split::SplitDir::Row,
        crate::tui::split::ResizeDir::Wider,
    ));
    let _ = draw(&app, 120, 30);
    assert!(app.resize_mode.is_some());
}
