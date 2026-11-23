//! Coverage round tests.

use super::*;
use ratatui::backend::TestBackend;
use ratatui::Terminal;

#[test]
fn render_covers_collapsed_carets_clean_previews_and_no_git_drift() {
    // Content search with a collapsed file row: the ▸ caret arm.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.file_explorer.search_mode = true;
    app.file_explorer.search_kind = crate::tui::panels::files::SearchKind::Content;
    app.file_explorer.content_search = crate::tui::panels::files::ContentSearchState {
        files: vec![crate::tui::panels::files::ContentSearchFile {
            path: "a.rs".to_string(),
            name: "a.rs".to_string(),
            match_count: 1,
            first_match_line: 1,
            truncated: false,
            chunks: vec![crate::tui::panels::files::ContentSearchChunk {
                start: 1,
                end: 1,
                rows: vec![crate::tui::panels::files::ContentSearchRow {
                    line: 1,
                    text: "hit".to_string(),
                    matched: true,
                }],
            }],
        }],
        expanded: vec![false],
        selected: 0,
        ..Default::default()
    };
    let text = draw(&app, 120, 30);
    assert!(text.contains("▸"), "collapsed caret");

    // File preview, clean and not markdown: the plain dirty-marker
    // and outline arms.
    app.file_explorer.search_mode = false;
    app.file_explorer.preview.path = Some("a.rs".to_string());
    app.file_explorer.preview.content = "hello".to_string();
    app.file_explorer.preview.dirty = false;
    let text = draw(&app, 120, 30);
    assert!(!text.contains(" * "), "clean preview has no dirty mark");

    // Git tab bar with the panel cwd equal to the workspace cwd:
    // the no-drift arm skips the badge.
    app.screen = TuiScreen::Git;
    app.git_panel.cwd = app.snapshot.workspaces[0].cwd.clone();
    let text = draw(&app, 120, 30);
    assert!(!text.contains("≠ workspace"), "no drift badge");
}

#[test]
fn blame_lookup_survives_missing_meta_lines_and_unknown_authors() {
    // Blame on, but each diff line exercises one miss: no meta at
    // all, a None meta slot, a meta without line numbers, and a
    // line the blame map does not know.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.git_panel.diff_title = "src/app.rs".to_string();
    app.git_panel.diff_lines = vec![
        " no meta at all".to_string(),
        " none slot".to_string(),
        " no line numbers".to_string(),
        " unknown author".to_string(),
        " known author".to_string(),
    ];
    app.git_panel.diff_meta = vec![
        None,
        None,
        Some(crate::tui::panels::GitDiffLineMeta {
            old_line: None,
            new_line: None,
        }),
        Some(crate::tui::panels::GitDiffLineMeta {
            old_line: None,
            new_line: Some(4),
        }),
        Some(crate::tui::panels::GitDiffLineMeta {
            old_line: None,
            new_line: Some(5),
        }),
    ];
    app.git_panel.show_blame = true;
    app.git_panel.blame_path = Some("src/app.rs".to_string());
    app.git_panel
        .blame_authors
        .insert(5, "Ada Lovelace".to_string());
    let text = draw(&app, 120, 30);
    assert!(text.contains("Ada Lovelace"), "known author still shown");
}

#[test]
fn footer_wraps_a_long_status_onto_extra_rows() {
    // A long error wraps past the chrome row: the extra-rows
    // extend closure runs when the footer area can spare rows.
    let mut app = app_with_snapshot();
    app.error = Some("x".repeat(400));
    app.screen = TuiScreen::Terminal;
    let text = draw(&app, 60, 30);
    assert!(text.contains('x'), "long error renders in the footer");

    // Direct call with a 3-row area: the wrapped rows extend past
    // the chrome line and paint as their own lines.
    let palette = crate::tui::theme::TuiTheme::Dark.palette();
    let backend = TestBackend::new(60, 3);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal
        .draw(|frame| crate::tui::render::render_footer(frame, frame.area(), &app, &palette))
        .unwrap();
    let text = format!("{:?}", terminal.backend().buffer());
    assert!(text.contains('x'), "wrapped rows render");
}

#[test]
fn resize_preview_draws_without_a_recorded_direction_and_on_a_blocked_step() {
    // Resize mode with a recorded direction that cannot move (the
    // blocked arm) and with no recorded direction at all.
    let mut app = two_tile_split();
    app.resize_mode = Some(crate::tui::split_mode::ResizeState {
        pane: "pane_1".to_string(),
    });
    // No last_resize_dir: the outer else-arm of the preview.
    let _ = draw(&app, 120, 30);
    // A direction recorded, but the step is Clamped (the sibling
    // sits at the weight floor, so widening cannot take from it):
    // the inner else-arm paints the clamped marker.
    app.split_tree = crate::tui::split::SplitNode::weighted(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        vec![8, crate::tui::split::SPLIT_WEIGHT_MIN],
    );
    app.last_resize_dir = Some((
        crate::tui::split::SplitDir::Row,
        crate::tui::split::ResizeDir::Wider,
    ));
    let _ = draw(&app, 120, 30);
    assert!(app.resize_mode.is_some());
}
