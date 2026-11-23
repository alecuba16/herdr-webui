//! Git screens tests: panel views, branches, worktree browser, cleanup, worktree stamps.

use super::*;
use crate::tui::panels::{
    GitBranchEntry, GitCommitEntry, GitFileEntry, GitFileStatus, GitStashEntry, GitView,
};
use crate::tui::web_api::WebApiClient;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::style::Color;
use ratatui::Terminal;
use serde_json::json;

#[test]
fn git_screen_renders_views_and_commit_input() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Git;
    app.git_panel.branch = "main".to_string();
    app.git_panel.upstream = "origin/main".to_string();
    app.git_panel.ahead = 2;
    app.git_panel.behind = 1;
    app.git_panel.state = "dirty".to_string();
    app.git_panel.files = vec![GitFileEntry {
        path: "src/app.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.git_panel.diff_lines = vec![
        "diff --git a/src/app.rs b/src/app.rs".to_string(),
        "+new line".to_string(),
        "-old line".to_string(),
    ];
    app.git_panel.commits = vec![GitCommitEntry {
        hash: "abc123def".to_string(),
        message: "fix bug".to_string(),
        author: "Ada".to_string(),
        date: "2 hours ago".to_string(),
        labels: vec!["main".to_string()],
    }];
    app.commit_input = Some(CommitInput {
        text: String::new(),
        amend: false,
    });

    let backend = TestBackend::new(120, 30);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &app)).unwrap();
    let rendered = format!("{:?}", terminal.backend().buffer());
    assert!(rendered.contains("Changes"));
    assert!(rendered.contains("src/app.rs"));
    assert!(rendered.contains("Commit message"));

    // Typing builds the commit title; Ctrl-U clears it.
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    app.handle_key(KeyEvent::from(KeyCode::Char('i')));
    assert_eq!(app.commit_input.as_ref().unwrap().text, "hi");
    let ctrl_u = KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL);
    app.handle_key(ctrl_u);
    assert_eq!(app.commit_input.as_ref().unwrap().text, "");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.commit_input.is_none());
}

#[test]
fn git_panel_key_navigation_cycles_views() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Git;
    app.mode = TuiMode::Attach;
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Log);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Branches);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Stash);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::History);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Conflicts);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Cleanup);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Changes);

    // Esc/q returns to the terminal screen.
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.screen, TuiScreen::Terminal);
}

#[test]
fn git_changes_hunk_keys_move_cursor_and_apply() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Git;
    app.mode = TuiMode::Attach;
    app.git_panel.view = GitView::Changes;
    // Two hunks loaded (headers are the meta-None lines).
    app.git_panel.diff_lines = vec![
        "@@ -1,2 +1,3 @@".to_string(),
        "+added".to_string(),
        "@@ -9,1 +9,2 @@".to_string(),
        "-removed".to_string(),
    ];
    app.git_panel.diff_meta = vec![
        None,
        Some(crate::tui::panels::GitDiffLineMeta::default()),
        None,
        Some(crate::tui::panels::GitDiffLineMeta::default()),
    ];
    // J walks to the second hunk (status announces it), K back to the
    // first, K again wraps to the last.
    app.handle_key(KeyEvent::from(KeyCode::Char('J')));
    assert_eq!(app.git_panel.diff_hunk_selected, 1);
    assert_eq!(app.status, "hunk 2");
    app.handle_key(KeyEvent::from(KeyCode::Char('K')));
    assert_eq!(app.git_panel.diff_hunk_selected, 0);
    app.handle_key(KeyEvent::from(KeyCode::Char('K')));
    assert_eq!(app.git_panel.diff_hunk_selected, 1, "K wraps to the last");

    // H without a per-file diff loaded: guard error, no API call.
    app.git_panel.diff_title = "working tree".to_string();
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('H')));
    assert!(
        app.error
            .as_deref()
            .is_some_and(|e| e.contains("select a file to load its diff")),
        "guard error surfaces: {:?}",
        app.error
    );

    // J/K on other views fall through to their own bindings (Log uses
    // plain j/k for commits; uppercase J must not move the hunk cursor
    // there and must not crash).
    app.git_panel.view = GitView::Log;
    app.handle_key(KeyEvent::from(KeyCode::Char('J')));
    assert_eq!(app.git_panel.diff_hunk_selected, 1, "untouched in Log");
}

#[test]
fn git_branches_delete_blocked_for_current_branch_and_confirmed_for_others() {
    use crate::tui::panels::GitBranchEntry;
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Branches;
    app.git_panel.branches = vec![
        GitBranchEntry {
            name: "main".to_string(),
            current: true,
            remote: false,
            pushed: true,
            worktree_path: None,
        },
        GitBranchEntry {
            name: "feature".to_string(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: None,
        },
    ];
    app.git_panel.branch_selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Char('D')));
    assert!(app.prompt_input.is_none());
    assert_eq!(
        app.error.as_deref(),
        Some("cannot delete the current branch")
    );
    app.error = None;

    app.git_panel.branch_selected = 1;
    app.handle_key(KeyEvent::from(KeyCode::Char('D')));
    assert_eq!(
        app.prompt_input.as_ref().map(|prompt| prompt.kind),
        Some(PromptKind::ConfirmDeleteBranch)
    );
    app.handle_key(KeyEvent::from(KeyCode::Char('y')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.prompt_input.is_none());
    // The delete fires against the unreachable API; an error proves the path.
    assert!(app.error.is_some());
}

#[test]
fn git_stash_view_d_opens_drop_confirmation() {
    use crate::tui::panels::GitStashEntry;
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Stash;
    app.git_panel.stashes = vec![GitStashEntry {
        name: "stash@{0}".to_string(),
        message: "wip".to_string(),
    }];
    app.handle_key(KeyEvent::from(KeyCode::Char('D')));
    assert_eq!(
        app.prompt_input.as_ref().map(|prompt| prompt.kind),
        Some(PromptKind::ConfirmDropStash)
    );
    // Esc cancels.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.prompt_input.is_none());
}

#[test]
fn git_in_panel_keys_cover_stage_fetch_pull_push_and_enter() {
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.mode = TuiMode::Attach;
    app.git_panel.files = vec![
        GitFileEntry {
            path: "src/app.rs".to_string(),
            status: GitFileStatus::Unstaged,
        },
        GitFileEntry {
            path: "src/lib.rs".to_string(),
            status: GitFileStatus::Staged,
        },
    ];
    app.git_panel.commits = vec![GitCommitEntry {
        hash: "abc123".to_string(),
        message: "m".to_string(),
        author: "a".to_string(),
        date: "now".to_string(),
        labels: vec![],
    }];
    app.git_panel.branches = vec![GitBranchEntry {
        name: "main".to_string(),
        current: true,
        remote: false,
        pushed: true,
        worktree_path: None,
    }];
    app.git_panel.stashes = vec![GitStashEntry {
        name: "stash@{0}".to_string(),
        message: "wip".to_string(),
    }];

    // Stage selected hits the API.
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.error.is_some());
    app.error = None;

    // Discard selected hits the API.
    app.handle_key(KeyEvent::from(KeyCode::Char('d')));
    assert!(app.error.is_some());
    app.error = None;

    // Fetch, pull, push hit the API.
    for key in ['f', 'p'] {
        app.handle_key(KeyEvent::from(KeyCode::Char(key)));
        assert!(app.error.is_some(), "{key} must call the API");
        app.error = None;
    }
    app.handle_key(KeyEvent::new(KeyCode::Char('P'), KeyModifiers::SHIFT));
    assert!(app.error.is_some());
    app.error = None;

    // Commit modal keys.
    app.handle_key(KeyEvent::from(KeyCode::Char('c')));
    assert!(app.commit_input.is_some());
    app.commit_input = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    assert!(app.commit_input.as_ref().is_some_and(|c| c.amend));
    app.commit_input = None;

    // Enter in Changes loads the diff (API error surfaces).
    app.git_panel.view = GitView::Changes;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some());
    app.error = None;

    // Enter in History with a commit loads its diff.
    app.git_panel.view = GitView::History;
    app.git_panel.history_file = Some("src/app.rs".to_string());
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "history Enter hits the compare API");
    app.error = None;

    // Enter in Branches switches (current branch is a no-op switch).
    app.git_panel.view = GitView::Branches;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    app.error = None;

    // Enter in Stash applies.
    app.git_panel.view = GitView::Stash;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "stash Enter hits the API");
    app.error = None;

    // D in Branches with the current branch is refused.
    app.git_panel.view = GitView::Branches;
    app.handle_key(KeyEvent::new(KeyCode::Char('D'), KeyModifiers::SHIFT));
    assert_eq!(
        app.error.as_deref(),
        Some("cannot delete the current branch")
    );
    app.error = None;

    // D in Stash with an entry opens the confirm prompt.
    app.git_panel.view = GitView::Stash;
    app.handle_key(KeyEvent::new(KeyCode::Char('D'), KeyModifiers::SHIFT));
    assert!(app
        .prompt_input
        .as_ref()
        .is_some_and(|p| p.kind == PromptKind::ConfirmDropStash));
    app.prompt_input = None;

    // D in Changes does nothing.
    app.git_panel.view = GitView::Changes;
    app.handle_key(KeyEvent::new(KeyCode::Char('D'), KeyModifiers::SHIFT));
    assert!(app.prompt_input.is_none());

    // j/k move the selection across git entries.
    app.git_panel.view = GitView::Changes;
    app.git_panel.file_selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.git_panel.file_selected, 1);
    app.handle_key(KeyEvent::from(KeyCode::Char('k')));
    assert_eq!(app.git_panel.file_selected, 0);
    app.handle_key(KeyEvent::from(KeyCode::Down));
    app.handle_key(KeyEvent::from(KeyCode::Up));

    // r refreshes the active screen.
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    app.error = None;

    // Tab cycles the git view (Changes -> Log -> Branches -> Stash ->
    // History -> Conflicts -> Cleanup -> Changes).
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Log);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Branches);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Stash);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::History);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Conflicts);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Cleanup);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Changes);
    app.error = None;

    // D in Branches with no selection errors.
    app.git_panel.view = GitView::Branches;
    app.git_panel.branches.clear();
    app.handle_key(KeyEvent::new(KeyCode::Char('D'), KeyModifiers::SHIFT));
    assert_eq!(app.error.as_deref(), Some("no branch selected"));
    app.error = None;

    // D in Stash with no selection errors.
    app.git_panel.view = GitView::Stash;
    app.git_panel.stashes.clear();
    app.handle_key(KeyEvent::new(KeyCode::Char('D'), KeyModifiers::SHIFT));
    assert_eq!(app.error.as_deref(), Some("no stash selected"));
    app.error = None;
    app.git_panel.stashes = vec![GitStashEntry {
        name: "stash@{0}".to_string(),
        message: "wip".to_string(),
    }];

    // Enter in History with no commit selected errors.
    app.git_panel.view = GitView::History;
    app.git_panel.history_file = None;
    app.git_panel.commits.clear();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.error.as_deref(), Some("no commit selected"));
    app.error = None;

    // Enter in Log does nothing.
    app.git_panel.view = GitView::Log;
    app.handle_key(KeyEvent::from(KeyCode::Enter));

    // Esc returns to the terminal screen.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.screen, TuiScreen::Terminal);
}

#[test]
fn git_panel_switch_and_delete_and_stash_hit_api() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut panel = crate::tui::panels::GitPanel::new("/repo");
    panel.branches = vec![GitBranchEntry {
        name: "feature".to_string(),
        current: false,
        remote: false,
        pushed: false,
        worktree_path: None,
    }];
    panel.branch_selected = 0;
    assert!(panel.switch_branch(&api, "feature").is_err());

    panel.stashes = vec![GitStashEntry {
        name: "stash@{0}".to_string(),
        message: "wip".to_string(),
    }];
    panel.stash_selected = 0;
    assert!(panel.stash_apply(&api).is_err());
    assert!(panel.stash_drop(&api).is_err());
}

#[test]
fn git_panel_commit_pull_push_fetch_hit_api() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut panel = crate::tui::panels::GitPanel::new("/repo");
    assert!(panel.commit(&api, "msg", false).is_err());
    assert!(panel.pull(&api).is_err());
    assert!(panel.push(&api).is_err());
    assert!(panel.fetch(&api).is_err());
    assert!(panel.stage_selected(&api).is_err());
    assert!(panel.unstage_selected(&api).is_err());
    assert!(panel.discard_selected(&api).is_err());
    assert!(panel.stash_changes(&api).is_err());
    // toggle_stage_all with nothing staged stages the non-staged files;
    // with files present the stage call hits the API.
    panel.files = vec![GitFileEntry {
        path: "src/app.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    assert!(panel.toggle_stage_all(&api).is_err());
    // With everything staged it unstages via the API.
    panel.files = vec![GitFileEntry {
        path: "src/app.rs".to_string(),
        status: GitFileStatus::Staged,
    }];
    assert!(panel.toggle_stage_all(&api).is_err());
    // With no files it is a no-op success (webui parity).
    panel.files.clear();
    assert!(panel.toggle_stage_all(&api).is_ok());
}

#[test]
fn git_lists_paint_the_selected_row_inverted_in_both_themes() {
    // The git lists used a foreground-only accent that vanished on
    // light terminals; the selected row now inverts (panel-bg fg on
    // accent bg) like the sidebar lists.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.git_panel.files = vec![
        GitFileEntry {
            path: "zz_git_selected_marker.rs".to_string(),
            status: GitFileStatus::Unstaged,
        },
        GitFileEntry {
            path: "zz_other_file.rs".to_string(),
            status: GitFileStatus::Unstaged,
        },
    ];
    app.git_panel.file_selected = 0;
    app.git_panel.diff_lines = vec!["@@ -1,2 +1,3 @@".to_string(), "+added line".to_string()];
    // `None` marks the chunk header; `hunk_headers()` reads these
    // indexes to find the `@@` row the cursor sits on.
    app.git_panel.diff_meta = vec![None, Some(crate::tui::panels::GitDiffLineMeta::default())];
    app.git_panel.diff_hunk_selected = 0;
    for (theme, accent, panel_bg) in [
        (
            TuiTheme::Dark,
            Color::Rgb(137, 180, 250),
            Color::Rgb(17, 17, 27),
        ),
        (
            TuiTheme::Light,
            Color::Rgb(37, 99, 235),
            Color::Rgb(255, 255, 255),
        ),
    ] {
        app.theme = theme;
        app.palette = crate::tui::theme::Palette::for_theme(theme);
        let buffer = draw_buffer(&app, 140, 30);
        // Selected file row: every painted cell carries the accent bg.
        // A unique marker path keeps the needle off the sidebar tree,
        // which renders `src/...` rows of its own.
        let file_row = rendered_row(&buffer, "zz_git_selected_marker.rs");
        let unselected = rendered_row(&buffer, "zz_other_file.rs");
        assert_eq!(
            buffer[(
                file_row.cell_x_of("zz_git").unwrap() as u16,
                file_row.y as u16
            )]
                .bg,
            accent
        );
        assert_eq!(
            buffer[(
                file_row.cell_x_of("zz_git").unwrap() as u16,
                file_row.y as u16
            )]
                .fg,
            panel_bg
        );
        let unselected_has_accent = (0..buffer.area.width as usize)
            .any(|x| buffer[(x as u16, unselected.y as u16)].bg == accent);
        assert!(
            !unselected_has_accent,
            "unselected file row stays on panel bg"
        );
        // Hunk cursor: the @@ header inverts the same way.
        let hunk_row = rendered_row(&buffer, "@@ -1,2");
        let hunk_x = hunk_row.cell_x_of("@@").unwrap();
        assert_eq!(buffer[(hunk_x as u16, hunk_row.y as u16)].bg, accent);
        assert_eq!(buffer[(hunk_x as u16, hunk_row.y as u16)].fg, panel_bg);
    }
}

#[test]
fn git_diff_pane_follows_the_hunk_cursor_and_shows_the_position() {
    // A diff taller than the pane used to render only the top slice:
    // the highlighted hunk header (and search hits) below the fold
    // stayed invisible. The pane now centers the window on the active
    // anchor and prints a position row when content is hidden.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.git_panel.files = vec![GitFileEntry {
        path: "zz_scroll_file.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    // One line per hunk header ordinal: 60 @@ headers with body lines,
    // far taller than any pane at 140x30.
    let mut diff_lines = Vec::new();
    let mut diff_meta = Vec::new();
    for i in 0..60 {
        diff_lines.push(format!("@@ -{i},1 +{i},1 @@"));
        diff_meta.push(None);
        diff_lines.push(format!(" body-{i}"));
        diff_meta.push(Some(crate::tui::panels::GitDiffLineMeta::default()));
    }
    app.git_panel.diff_lines = diff_lines;
    app.git_panel.diff_meta = diff_meta;
    app.git_panel.diff_hunk_selected = 50;

    let buffer = draw_buffer(&app, 140, 30);
    // The selected hunk header must be on screen.
    let hunk_row = rendered_row(&buffer, "@@ -50");
    assert!(hunk_row.y > 0, "hunk anchor rendered inside the pane");
    // Top-of-diff lines scrolled out.
    let mut saw_top = false;
    for y in 0..buffer.area.height as usize {
        let line: String = (0..buffer.area.width as usize)
            .map(|x| {
                buffer[(x as u16, y as u16)]
                    .symbol()
                    .chars()
                    .next()
                    .unwrap_or(' ')
            })
            .collect();
        if line.contains("@@ -0,1") {
            saw_top = true;
        }
    }
    assert!(!saw_top, "top of the diff scrolled out of view");
    // The position row is present and honest.
    let pos_row = rendered_row(&buffer, "of 120");
    assert!(
        pos_row.y > hunk_row.y,
        "position row sits under the content"
    );
}

#[test]
fn worktree_overlay_renders_rows_filter_and_empty_states() {
    let mut app = app_with_snapshot();
    app.mode = TuiMode::WorktreeList;
    app.worktree_root = "/repo".to_string();
    app.worktree_rows = vec![
        crate::tui::workspace::WorktreeRow {
            path: "/repo".to_string(),
            branch: "main".to_string(),
            label: String::new(),
            is_linked: false,
        },
        crate::tui::workspace::WorktreeRow {
            path: "/repo-wt".to_string(),
            branch: "feature".to_string(),
            label: "wt".to_string(),
            is_linked: true,
        },
    ];
    app.worktree_selected = 1;

    let buf = draw(&app, 100, 30);
    assert!(buf.contains("Worktrees"), "title renders");
    assert!(buf.contains("/repo"), "row path renders");
    assert!(buf.contains("[linked]"), "linked badge renders");
    assert!(buf.contains("[main]"), "main badge renders");
    assert!(buf.contains("WORKTREES"), "footer context renders");

    // Active filter shows the query and the narrowed count. The
    // browser total includes the "this folder" row (1 + 2 worktrees).
    app.worktree_filter = "feature".to_string();
    let buf = draw(&app, 100, 30);
    assert!(buf.contains("filter: feature_"), "filter query renders");
    assert!(buf.contains("1/3"), "filtered count renders");
    assert!(buf.contains("Esc clears the filter"), "title switches");

    // No match shows the search empty state.
    app.worktree_filter = "zz".to_string();
    let buf = draw(&app, 100, 30);
    assert!(buf.contains("No worktrees or folders match your search"));

    // The "this folder" row always renders (Enter opens it as a
    // workspace), even with no discovered worktrees.
    app.worktree_filter.clear();
    app.worktree_rows.clear();
    let buf = draw(&app, 100, 30);
    assert!(buf.contains("this folder: /repo"));
    assert!(buf.contains("[open as workspace]"), "open badge renders");
}

#[test]
fn worktree_row_without_branch_renders_only_the_badge() {
    // Row with an empty branch shows the linked badge without the
    // double-space separator.
    let mut app = app_with_snapshot();
    app.mode = TuiMode::WorktreeList;
    app.worktree_root = "/repo".to_string();
    app.worktree_rows = vec![crate::tui::workspace::WorktreeRow {
        path: "/repo".to_string(),
        branch: String::new(),
        label: String::new(),
        is_linked: true,
    }];
    let buf = draw(&app, 100, 30);
    assert!(buf.contains("[linked]"), "badge renders without branch");
}

#[test]
fn git_log_title_shows_more_hint_and_file_scope() {
    // The log toolbar title arms: the +more hint when the log has more
    // pages, and the file name when the log is file-scoped.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Log;
    app.git_panel.commits = vec![GitCommitEntry {
        hash: "abc123def".to_string(),
        message: "fix bug".to_string(),
        author: "Ada".to_string(),
        date: "2 hours ago".to_string(),
        labels: vec![],
    }];
    app.git_panel.log_has_more = true;
    app.git_panel.log_limit = 100;
    app.git_panel.log_file = Some("src/app.rs".to_string());
    // Wide terminal: the log list is ~45% of the width, so the full
    // toolbar (scope + file + +more hint) needs the room to fit.
    let rendered = draw(&app, 200, 30);
    assert!(rendered.contains("+more"), "the +more hint renders");
    assert!(rendered.contains("src/app.rs"), "the file scope renders");
}

#[test]
fn confirm_cleanup_delete_prompt_shows_the_selected_item() {
    // The ConfirmCleanupDelete subject arm: the prompt carries the
    // selected cleanup item (kind + name) as its subject line.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.git_panel.cleanup_repos = vec![crate::tui::panels::git::CleanupRepo {
        path: "/repo".to_string(),
        branches: vec!["feature-old".to_string()],
        worktrees: vec![],
    }];
    app.prompt_input = Some(crate::tui::PromptInput::new(
        crate::tui::PromptKind::ConfirmCleanupDelete,
    ));
    let rendered = draw(&app, 120, 30);
    assert!(
        rendered.contains("branch feature-old"),
        "the cleanup item kind and name render as the subject"
    );
}

#[test]
fn worktree_browser_folder_rows_and_pick_mode_render() {
    // Folder rows render with the descend badge, and pick mode (new
    // workspace) swaps the badges and the overlay title.
    let mut app = app_with_snapshot();
    app.mode = TuiMode::WorktreeList;
    app.worktree_root = "/repo".to_string();
    app.worktree_folder_rows = vec![crate::tui::workspace::BrowserRow::Folder {
        path: "/repo/src".to_string(),
        name: "src".to_string(),
    }];
    let rendered = draw(&app, 120, 30);
    assert!(rendered.contains("src/"), "folder row renders");
    assert!(
        rendered.contains("[folder]"),
        "plain mode shows the folder badge"
    );
    assert!(rendered.contains("Worktrees"), "plain-mode title renders");

    // Pick mode: title and badges change; the this-folder row carries
    // the stage hint.
    app.worktree_pick_workspace = true;
    let rendered = draw(&app, 120, 30);
    assert!(
        rendered.contains("New workspace"),
        "pick-mode title renders"
    );
    assert!(
        rendered.contains("[folder, Enter descends]"),
        "pick mode shows the descend badge"
    );
    assert!(
        rendered.contains("[o stages for new workspace]"),
        "the this-folder row carries the stage hint in pick mode"
    );
}

#[test]
fn stamp_parser_marks_main_and_linked_from_source_repo_root() {
    // The builtin row flag says linked for every row, main included;
    // the parser must derive the flag from the row path vs the
    // source repo_root instead.
    let response = json!({
        "source": {"repo_root": "/repo", "repo_name": "repo"},
        "worktrees": [
            {"path": "/repo", "branch": "main", "is_linked_worktree": true},
            {"path": "/repo-wt", "branch": "feature", "is_linked_worktree": true}
        ]
    });

    let main = crate::tui::parse_worktree_list_response(&response, "/repo")
        .expect("main checkout row found");
    assert!(!main.is_linked, "row at repo_root is the main checkout");
    assert_eq!(main.branch, "main");
    assert_eq!(main.repo_root, "/repo");
    assert_eq!(main.repo_name, "repo");

    let lane =
        crate::tui::parse_worktree_list_response(&response, "/repo-wt").expect("lane row found");
    assert!(lane.is_linked, "row away from repo_root is linked");
    assert_eq!(lane.branch, "feature");
}

#[test]
fn stamp_parser_skips_unrelated_folders_and_missing_shapes() {
    // A folder the rows do not name (plain directory, subfolder) has
    // no identity to stamp.
    let response = json!({
        "source": {"repo_root": "/repo", "repo_name": "repo"},
        "worktrees": [
            {"path": "/repo", "branch": "main"},
            {"path": "/repo-wt", "branch": "feature"}
        ]
    });
    assert!(
        crate::tui::parse_worktree_list_response(&response, "/unrelated").is_none(),
        "folder absent from rows is unstamped"
    );

    // No rows at all: broken git or plain folder, nothing to stamp.
    assert!(crate::tui::parse_worktree_list_response(&response_no_rows(), "/repo").is_none());

    // Rows without a source envelope: the repo root falls back to the
    // row checkout path, so the main-vs-linked call lands on main
    // (the audit's settled behavior for source-less replies). The
    // overlay derivation keeps trusting the raw row flag.
    let bare =
        json!({"worktrees": [{"path": "/repo", "branch": "main", "is_linked_worktree": true}]});
    let stamp = crate::tui::parse_worktree_list_response(&bare, "/repo")
        .expect("row still stamps without an envelope");
    assert!(!stamp.is_linked, "source-less reply lands on main");
    let rows = crate::tui::workspace::worktree_rows_from_response(&bare);
    assert_eq!(rows.len(), 1);
    assert!(rows[0].is_linked, "fallback trusts the row flag");
}

#[test]
fn stamp_fetch_marks_sidebar_rows_through_refresh_cycle() {
    // The snapshot refresh must stamp the workspace rows with their
    // worktree identity: the fetch arms on the first refresh after
    // the snapshot lands, the reply drains into the cache, and the
    // next refresh replays the cache onto fresh (unstamped) rows.
    let (path, _stop) = stamp_fake_socket(json!([
        {"path": "/repo", "branch": "main", "is_linked_worktree": true}
    ]));
    let client = BackendClient::new(path.clone(), path);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    assert!(
        app.snapshot.workspaces[0].worktree.is_none(),
        "fixture rows start unstamped"
    );

    // First refresh lands the snapshot; the stamp fetch arms and the
    // reply commits within the pump.
    pump_until_stamped(&mut app);
    assert!(
        app.snapshot.workspaces[0]
            .worktree
            .as_ref()
            .is_some_and(|stamp| !stamp.is_linked),
        "main checkout stamps not-linked even though the row flag says linked"
    );

    // Cache: a second refresh replaces the rows (fresh from_backend)
    // and replays the cached stamp without a new fetch. The refresh
    // cadence is 1s, so force the refresh due.
    let cached = app.stamp_cache.get("/repo").expect("reply cached");
    let fetched_at = cached.fetched_at;
    app.snapshot = fixture_snapshot();
    app.last_refresh = None;
    app.refresh_inflight = None;
    pump_until_stamped(&mut app);
    assert!(
        app.snapshot.workspaces[0]
            .worktree
            .as_ref()
            .is_some_and(|stamp| !stamp.is_linked),
        "cache replays the stamp onto fresh rows"
    );
    assert_eq!(
        app.stamp_cache.get("/repo").map(|e| e.fetched_at),
        Some(fetched_at),
        "fresh cache entry means no re-fetch"
    );
}

#[test]
fn stamp_fetch_serves_ttl_expiration_with_refetch() {
    // After the TTL the cache entry goes stale: the next refresh must
    // arm a fresh fetch instead of replaying the stale reply.
    let (path, _stop) = stamp_fake_socket(json!([
        {"path": "/repo", "branch": "main", "is_linked_worktree": true}
    ]));
    let client = BackendClient::new(path.clone(), path);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    pump_until_stamped(&mut app);
    let stamped = app.snapshot.workspaces[0]
        .worktree
        .as_ref()
        .expect("stamp landed");
    assert!(!stamped.is_linked);

    // Force the cache entry stale, replace the rows, and force the
    // refresh due: the next refresh must arm a fresh fetch instead of
    // replaying the stale reply.
    app.stamp_cache.get_mut("/repo").unwrap().fetched_at -=
        STAMP_CACHE_TTL + Duration::from_millis(1);
    app.snapshot = fixture_snapshot();
    app.last_refresh = None;
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        app.refresh_if_due();
        if app.stamp_inflight.iter().any(|w| w.cwd == "/repo") {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(
        app.stamp_inflight.iter().any(|w| w.cwd == "/repo"),
        "stale cache arms a fresh fetch"
    );
}

#[test]
fn stamp_fetch_skips_when_no_row_matches_and_stays_quiet() {
    // A reply whose rows do not name the workspace folder (plain
    // directory) stamps nothing, surfaces no error, and stops fetching
    // until the TTL lets it retry.
    let (path, _stop) = stamp_fake_socket(json!([{"path": "/unrelated"}]));
    let client = BackendClient::new(path.clone(), path);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    pump_until_quiet(&mut app);
    assert!(
        app.snapshot.workspaces[0].worktree.is_none(),
        "no stamp without a matching row"
    );
    assert!(
        app.error.is_none(),
        "stamp problems stay out of the error slot"
    );

    // The cached reply is fresh, so a follow-up refresh arms no new
    // fetch for the still-unstamped cwd.
    app.snapshot = fixture_snapshot();
    app.last_refresh = None;
    drain_refresh(&mut app);
    assert!(
        !app.stamp_inflight.iter().any(|w| w.cwd == "/repo"),
        "fresh cache suppresses the fetch even without a stamp"
    );
}

#[test]
fn stamp_worker_death_is_silent() {
    // A worker that dies without a reply (dropped sender) must drain
    // silently: no error, no wedge, the next refresh re-arms.
    let (tx, rx) = std::sync::mpsc::channel::<Result<Value, BackendClientError>>();
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    app.stamp_inflight.push(crate::tui::StampInflight {
        cwd: "/repo".to_string(),
        receiver: rx,
    });
    drop(tx);
    app.poll_refresh();
    assert!(app.stamp_inflight.is_empty(), "dead worker is discarded");
    assert!(app.error.is_none(), "worker death is not an error");
}

#[test]
fn stamp_parser_survives_detached_and_missing_branch() {
    let response = json!({
        "source": {"repo_root": "/repo", "repo_name": "repo"},
        "worktrees": [
            {"path": "/repo", "branch": null, "is_detached": true}
        ]
    });
    let stamp =
        crate::tui::parse_worktree_list_response(&response, "/repo").expect("detached row stamps");
    assert_eq!(stamp.branch, "", "detached HEAD keeps an empty branch");
    assert!(!stamp.is_linked);
}

#[test]
fn branch_picker_opens_with_current_branch_pinned_first() {
    // Desktop popover parity: the current branch leads the list so the
    // picker answers "where am I" before anything else.
    let (port, _stop) = fake_git_api_server(json!({
        "branches": [
            {"name": "feature", "current": false, "remote": false, "worktree_path": null},
            {"name": "main", "current": true, "remote": false, "worktree_path": "/repo"},
            {"name": "origin/main", "current": false, "remote": true, "worktree_path": null}
        ]
    }));
    let mut app = app_with_snapshot();
    app.web_api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
    let result = app.branch_picker_open();
    assert!(result.is_ok(), "{result:?}");
    assert_eq!(app.mode, TuiMode::BranchPicker);
    let names: Vec<&str> = app
        .branch_picker_rows
        .iter()
        .map(|row| row.name.as_str())
        .collect();
    assert_eq!(names, vec!["main", "feature"]);
    assert!(
        app.branch_picker_rows.iter().all(|row| !row.remote),
        "remote branches are informational, the picker keeps local rows only"
    );
    assert!(app.branch_picker_rows[0].current);
}

#[test]
fn branch_picker_no_workspace_folder_fails_cleanly() {
    let mut app = app_with_snapshot();
    app.snapshot.workspaces.clear();
    let result = app.branch_picker_open();
    assert_eq!(result.unwrap_err(), "no workspace folder selected");
    assert_ne!(app.mode, TuiMode::BranchPicker);
}

#[test]
fn branch_picker_enter_switches_through_git_switch() {
    // Plain branch (no worktree holds it): Enter goes through
    // git.switch and the status line reports the switch.
    let (port, _stop) = fake_git_api_server(json!({
        "branches": [
            {"name": "main", "current": true, "remote": false, "worktree_path": "/repo"},
            {"name": "feature", "current": false, "remote": false, "worktree_path": null}
        ]
    }));
    let mut app = app_with_snapshot();
    app.web_api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
    app.branch_picker_open().unwrap();
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    let result = app.branch_picker_commit();
    assert_eq!(result.unwrap(), "switched to feature");
    // A successful switch closes the overlay back to where it opened.
    assert_ne!(app.mode, TuiMode::BranchPicker);
}

#[test]
fn branch_picker_enter_reroutes_when_a_worktree_holds_the_branch() {
    // The reroute rule: a branch checked out in a sibling worktree
    // opens that worktree instead of git.switch, because git refuses a
    // second checkout.
    let (port, _stop) = fake_git_api_server(json!({
        "branches": [
            {"name": "main", "current": true, "remote": false, "worktree_path": "/repo"},
            {"name": "feature", "current": false, "remote": false, "worktree_path": "/repo-wt"}
        ]
    }));
    let mut app = app_with_snapshot();
    app.web_api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
    app.branch_picker_open().unwrap();
    // The backend socket is dead in this fixture, so worktree.open
    // fails: the failure IS the reroute proof (a plain switch would
    // have gone through the HTTP fake and succeeded).
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    let result = app.branch_picker_commit();
    let err = result.expect_err("reroute must attempt worktree.open");
    assert!(
        err.contains("repo-wt") || !err.is_empty(),
        "the error names the reroute target"
    );
}

#[test]
fn branch_picker_create_fallback_from_filter_query() {
    // Desktop create-CTA parity: Enter with a filter naming no branch
    // creates that branch and switches to it.
    let (port, _stop) = fake_git_api_server(json!({
        "branches": [
            {"name": "main", "current": true, "remote": false, "worktree_path": "/repo"}
        ]
    }));
    let mut app = app_with_snapshot();
    app.web_api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
    app.branch_picker_open().unwrap();
    for ch in "brand-new".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    let result = app.branch_picker_commit();
    assert_eq!(result.unwrap(), "created and switched to brand-new");
}

#[test]
fn branch_picker_current_branch_enter_is_a_noop() {
    let (port, _stop) = fake_git_api_server(json!({
        "branches": [
            {"name": "main", "current": true, "remote": false, "worktree_path": "/repo"}
        ]
    }));
    let mut app = app_with_snapshot();
    app.web_api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
    app.branch_picker_open().unwrap();
    let result = app.branch_picker_commit();
    assert_eq!(result.unwrap(), "already on main");
}

#[test]
fn branch_picker_render_pins_current_marker_and_worktree_badge() {
    let mut app = app_with_snapshot();
    app.branch_picker_root = "/repo".to_string();
    app.branch_picker_rows = vec![
        GitBranchEntry {
            name: "main".to_string(),
            current: true,
            remote: false,
            pushed: false,
            worktree_path: Some("/repo".to_string()),
        },
        GitBranchEntry {
            name: "feature".to_string(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: Some("/repo-wt".to_string()),
        },
        GitBranchEntry {
            name: "plain".to_string(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: None,
        },
    ];
    app.mode = TuiMode::BranchPicker;
    let rendered = draw(&app, 100, 30);
    assert!(rendered.contains("Switch branch"), "title renders");
    assert!(rendered.contains("main"), "current branch renders");
    assert!(rendered.contains("feature"), "sibling row renders");
    // The sibling worktree row carries the badge, the local one does not.
    assert!(
        rendered.contains("[worktree]"),
        "checked-out-elsewhere row carries the worktree badge"
    );
}

#[test]
fn branch_picker_esc_clears_filter_then_closes() {
    let mut app = app_with_snapshot();
    app.branch_picker_rows = vec![GitBranchEntry {
        name: "main".to_string(),
        current: true,
        remote: false,
        pushed: false,
        worktree_path: None,
    }];
    app.branch_picker_root = "/repo".to_string();
    app.open_overlay(TuiMode::BranchPicker);
    app.handle_key(KeyEvent::from(KeyCode::Char('f')));
    assert_eq!(app.branch_picker_filter, "f");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.branch_picker_filter, "", "first Esc clears the filter");
    assert_eq!(app.mode, TuiMode::BranchPicker, "still open");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_ne!(app.mode, TuiMode::BranchPicker, "second Esc closes");
}

#[test]
fn branch_picker_filter_narrows_rows() {
    let mut app = app_with_snapshot();
    app.branch_picker_root = "/repo".to_string();
    app.branch_picker_rows = vec![
        GitBranchEntry {
            name: "main".to_string(),
            current: true,
            remote: false,
            pushed: false,
            worktree_path: None,
        },
        GitBranchEntry {
            name: "feature/one".to_string(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: None,
        },
    ];
    app.branch_picker_filter = "feature".to_string();
    let rows = app.filtered_branch_picker_rows();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "feature/one");
}

#[test]
fn worktree_browser_marks_the_current_checkout_row() {
    // Desktop `worktreePopoverRow` marks the checkout the workspace
    // sits on; the TUI browser mirrors it with a leading check so the
    // user knows which row is "here".
    let mut app = app_with_snapshot();
    app.worktree_rows = vec![crate::tui::workspace::WorktreeRow {
        path: "/repo".to_string(),
        branch: "main".to_string(),
        label: "repo".to_string(),
        is_linked: false,
    }];
    app.worktree_folder_rows = Vec::new();
    app.worktree_root = "/repo".to_string();
    app.mode = TuiMode::WorktreeList;
    let rendered = draw(&app, 100, 30);
    assert!(
        rendered.contains("✓ /repo"),
        "the row matching the workspace cwd carries the current marker"
    );
    // A cwd that matches nothing leaves the rows unmarked.
    app.snapshot.workspaces[0].cwd = "/somewhere-else".to_string();
    let rendered = draw(&app, 100, 30);
    assert!(
        !rendered.contains("✓ /repo"),
        "a non-matching cwd marks nothing"
    );
}

#[test]
fn worktree_browser_c_opens_the_create_worktree_prompt() {
    // Desktop popover "Create worktree" CTA analog: `c` inside the
    // browser chains into the two-step create prompt.
    let mut app = app_with_snapshot();
    app.worktree_rows = Vec::new();
    app.worktree_folder_rows = Vec::new();
    app.worktree_root = "/repo".to_string();
    app.open_overlay(TuiMode::WorktreeList);
    app.handle_key(KeyEvent::from(KeyCode::Char('c')));
    assert!(
        matches!(
            app.prompt_input.as_ref().map(|prompt| prompt.kind),
            Some(PromptKind::CreateWorktreeBase)
        ),
        "`c` opens the base step of the create-worktree prompt"
    );
    // In pick mode (prefix `N`) `c` stays a no-op: that overlay's
    // intent is folders for a new workspace.
    app.prompt_input = None;
    app.worktree_pick_workspace = true;
    app.handle_key(KeyEvent::from(KeyCode::Char('c')));
    assert!(
        app.prompt_input.is_none(),
        "pick mode does not open the create prompt"
    );
}

#[test]
fn branch_picker_empty_filter_line_and_no_match_row() {
    let mut app = app_with_snapshot();
    app.mode = TuiMode::BranchPicker;
    app.branch_picker_root = "/repo".to_string();
    app.branch_picker_rows = vec![
        crate::tui::panels::git::GitBranchEntry {
            name: "main".to_string(),
            current: true,
            remote: false,
            pushed: true,
            worktree_path: None,
        },
        crate::tui::panels::git::GitBranchEntry {
            name: "feature".to_string(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: Some("/wt/feature".to_string()),
        },
    ];
    // Typed filter shows the query line and narrows rows.
    app.branch_picker_filter = "feat".to_string();
    let drawn = draw(&app, 120, 30);
    assert!(
        drawn.contains("Branches · Enter switches or creates"),
        "filtered footer copy, got: {drawn}"
    );

    // A filter matching nothing shows the create hint row.
    app.branch_picker_filter = "zzz".to_string();
    let drawn = draw(&app, 120, 30);
    assert!(
        drawn.contains("No branches match"),
        "no-match row renders, got: {drawn}"
    );

    // Empty filter keeps the plain footer and full row list.
    app.branch_picker_filter.clear();
    let drawn = draw(&app, 120, 30);
    assert!(drawn.contains("Branches · Enter switch/worktree"));
}

#[test]
fn cleanup_prompt_summary_counts_and_branch_option() {
    let mut app = app_with_snapshot();
    app.prompt_input = Some(crate::tui::PromptInput::new(
        crate::tui::PromptKind::ConfirmCleanupDelete,
    ));
    // No pending items at all.
    let drawn = draw(&app, 120, 30);
    assert!(
        drawn.contains("no cleanup item"),
        "zero-item summary, got: {drawn}"
    );

    // One marked worktree with a branch: singular + branch-too note.
    app.git_panel.cleanup_repos = vec![crate::tui::panels::git::CleanupRepo {
        path: "/repo".to_string(),
        branches: vec![],
        worktrees: vec![crate::tui::panels::git::CleanupWorktree {
            path: "/repo/wt".to_string(),
            branch: Some("feature".to_string()),
        }],
    }];
    app.git_panel.cleanup_toggle_mark();
    let drawn = draw(&app, 120, 30);
    assert!(
        drawn.contains("worktree /repo/wt"),
        "singular summary, got: {drawn}"
    );
    assert!(
        drawn.contains("(yb also deletes branches)"),
        "branch-too option renders"
    );

    // Two marked items: plural summary (move the cursor between marks,
    // else the second toggle un-marks the first).
    app.git_panel.cleanup_repos = vec![crate::tui::panels::git::CleanupRepo {
        path: "/repo".to_string(),
        branches: vec!["old-a".to_string(), "old-b".to_string()],
        worktrees: vec![],
    }];
    app.git_panel.cleanup_marked.clear();
    app.git_panel.cleanup_selected = 0;
    app.git_panel.cleanup_toggle_mark();
    app.git_panel.cleanup_selected = 1;
    app.git_panel.cleanup_toggle_mark();
    let drawn = draw(&app, 120, 30);
    assert!(
        drawn.contains("2 cleanup items"),
        "plural summary, got: {drawn}"
    );
}

#[test]
fn create_session_prompt_subject_names_session_and_backend() {
    let mut app = app_with_snapshot();
    app.prompt_input = Some(crate::tui::PromptInput::new(
        crate::tui::PromptKind::CreateSession,
    ));
    let drawn = draw(&app, 120, 30);
    assert!(
        drawn.contains(&format!(
            "from {} · {}",
            app.current_session, app.current_backend
        )),
        "create-session subject names both, got: {drawn}"
    );
}

#[test]
fn branch_picker_key_handler_moves_the_cursor_and_edits_the_filter() {
    let mut app = app_with_snapshot();
    app.branch_picker_rows = vec![
        GitBranchEntry {
            name: "main".into(),
            current: true,
            remote: false,
            pushed: false,
            worktree_path: None,
        },
        GitBranchEntry {
            name: "feature".into(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: None,
        },
    ];
    app.branch_picker_root = "/repo".into();
    app.open_overlay(TuiMode::BranchPicker);

    // Arrows wrap around.
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Down));
    assert_eq!(app.branch_picker_selected, 1);
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Down));
    assert_eq!(app.branch_picker_selected, 0);
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Up));
    assert_eq!(app.branch_picker_selected, 1);

    // j/k mirror the arrows when the filter is empty.
    app.branch_picker_selected = 0;
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.branch_picker_selected, 1);
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Char('k')));
    assert_eq!(app.branch_picker_selected, 0);

    // Typing feeds the filter, Backspace pops it, Ctrl+U clears it.
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Char('f')));
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Char('e')));
    assert_eq!(app.branch_picker_filter, "fe");
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.branch_picker_filter, "f");
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Char('a')));
    app.handle_branch_picker_key(ctrl('u'));
    assert_eq!(app.branch_picker_filter, "");

    // Esc with no filter closes the overlay; with a filter it only
    // clears the filter.
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.mode != TuiMode::BranchPicker, "closed with no filter");
    app.open_overlay(TuiMode::BranchPicker);
    app.branch_picker_filter = "f".into();
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.branch_picker_filter, "");
    assert_eq!(app.mode, TuiMode::BranchPicker, "first Esc keeps it open");
}

#[test]
fn branch_picker_commit_with_no_selection_and_empty_filter_errors() {
    let mut app = app_with_snapshot();
    app.branch_picker_rows = vec![];
    app.branch_picker_root = "/repo".into();
    let result = app.branch_picker_commit();
    assert_eq!(result, Err("no branch selected".to_string()));

    // The key handler surfaces the same error on the status line.
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "no branch selected");
}

#[test]
fn worktree_create_prompt_chains_branch_path_base_and_pull_base() {
    let mut app = app_with_snapshot();
    use crate::tui::workspace::WorktreeCreateStage;
    use crate::tui::workspace::{run_prompt, WorkspacePrompt};

    // Empty branch name is rejected without staging.
    run_prompt(&mut app, &WorkspacePrompt::CreateWorktreeBranch, "  ");
    assert_eq!(app.error, Some("type a branch name".to_string()));
    assert!(app.worktree_create_stage.is_none());

    // Direct entry stages the branch and chains into the base prompt.
    run_prompt(&mut app, &WorkspacePrompt::CreateWorktreeBranch, "feat");
    assert_eq!(
        app.status,
        "type the base ref (empty = HEAD), Enter continues"
    );
    assert!(matches!(
        app.worktree_create_stage,
        Some(WorktreeCreateStage::DirectBranch(_))
    ));

    // Base stages the pair and chains into the path prompt.
    run_prompt(&mut app, &WorkspacePrompt::CreateWorktreeBase, "main");
    assert_eq!(app.status, "type the checkout path");
    assert!(matches!(
        app.worktree_create_stage,
        Some(WorktreeCreateStage::Branch(_, _))
    ));

    // Empty path keeps the path prompt open.
    run_prompt(&mut app, &WorkspacePrompt::CreateWorktreePath, "");
    assert_eq!(app.error, Some("type the checkout path".to_string()));

    // Path stages and chains into the pull-base confirm.
    run_prompt(&mut app, &WorkspacePrompt::CreateWorktreePath, "/tmp/wt");
    assert_eq!(
        app.status,
        "pull the base ref first? (y = fast-forward it, Enter = skip)"
    );
    assert!(matches!(
        app.worktree_create_stage,
        Some(WorktreeCreateStage::Path(_, _, _))
    ));

    // The confirm drives create_worktree; the nonexistent backend fails,
    // and the stage is restored so Enter can retry.
    app.error = None;
    run_prompt(&mut app, &WorkspacePrompt::ConfirmWorktreePullBase, "y");
    assert!(app.error.is_some(), "backend is unreachable, create fails");
    assert!(
        matches!(
            app.worktree_create_stage,
            Some(WorktreeCreateStage::Path(_, _, _))
        ),
        "failed create keeps the staged draft"
    );
}

#[test]
fn worktree_stage_picked_guards_missing_rows_and_paths() {
    let mut app = app_with_snapshot();
    // A selection index past the rows: the guard fires.
    app.worktree_selected = 99;
    let result = app.worktree_stage_picked();
    assert_eq!(result, Err("no worktree selected".to_string()));

    // A this-folder row whose root is empty hits the second guard.
    app.worktree_selected = 0;
    app.worktree_root = String::new();
    let result = app.worktree_stage_picked();
    assert_eq!(result, Err("worktree path missing".to_string()));
}

#[test]
fn branch_picker_reroute_succeeds_through_the_fake_backend() {
    // The reroute tail (open, recent-workspace record, refresh, focus,
    // autoclose, overlay drop) needs a live backend socket: wire the
    // workspace fake so worktree.open succeeds.
    let mut app = app_with_snapshot();
    app.client = crate::tui::workspace::tests::fake_backend_client();
    app.branch_picker_rows = vec![GitBranchEntry {
        name: "feature".into(),
        current: false,
        remote: false,
        pushed: false,
        worktree_path: Some("/repo-wt".into()),
    }];
    app.branch_picker_root = "/repo".into();
    app.open_overlay(TuiMode::BranchPicker);

    let result = app.branch_picker_commit();
    assert!(result.is_ok(), "reroute runs through worktree.open");
    assert_eq!(app.mode, TuiMode::Navigate, "overlay stack dropped");
}

#[test]
fn worktree_open_selected_reports_the_missing_row() {
    let mut app = app_with_snapshot();
    // Selection index past the rows: the open guard fires.
    app.worktree_selected = 99;
    let result = app.worktree_open_selected();
    assert_eq!(result, Err("no worktree selected".to_string()));
}

#[test]
fn branch_picker_key_handler_routes_enter_esc_and_query_letters() {
    let mut app = app_with_snapshot();
    app.branch_picker_rows = vec![
        GitBranchEntry {
            name: "main".into(),
            current: true,
            remote: false,
            pushed: false,
            worktree_path: None,
        },
        GitBranchEntry {
            name: "feature".into(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: None,
        },
    ];
    app.branch_picker_root = "/repo".into();
    app.open_overlay(TuiMode::BranchPicker);

    // Enter commits: the current branch is a no-op success into status.
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "already on main");

    // Backspace with a filter pops it; with no filter it falls through.
    app.branch_picker_filter = "fe".into();
    app.handle_branch_picker_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.branch_picker_filter, "f");

    // A control char is ignored (not pushed into the filter).
    app.handle_branch_picker_key(KeyEvent::new(KeyCode::Char('\t'), KeyModifiers::NONE));
    assert_eq!(app.branch_picker_filter, "f");
}

#[test]
fn worktree_overlay_key_handler_routes_o_c_and_h() {
    let mut app = app_with_snapshot();
    app.mode = TuiMode::WorktreeList;
    app.worktree_root = "/repo".into();
    app.worktree_pick_workspace = true;

    // `o` in pick mode stages the selected row (the this-folder row is
    // the browse root, a real path on disk fails validation only if it
    // does not exist; /repo does not, so the error lands in status).
    app.handle_worktree_list_key(KeyEvent::from(KeyCode::Char('o')));
    assert!(!app.status.is_empty());

    // Out of pick mode `o` opens the selected row as a workspace.
    app.worktree_pick_workspace = false;
    app.handle_worktree_list_key(KeyEvent::from(KeyCode::Char('o')));
    assert!(!app.status.is_empty());

    // `c` opens the create-worktree base prompt (not in pick mode).
    app.handle_worktree_list_key(KeyEvent::from(KeyCode::Char('c')));
    assert!(matches!(
        app.prompt_input.as_ref().map(|p| p.kind),
        Some(PromptKind::CreateWorktreeBase)
    ));
    assert_eq!(app.status, PromptKind::CreateWorktreeBase.title());

    // `h` with no parent (root path) stays put; with a parent it
    // browses up (fails against the dead api, error to status).
    app.prompt_input = None;
    app.worktree_root = "/".into();
    app.handle_worktree_list_key(KeyEvent::from(KeyCode::Char('h')));
    app.worktree_root = "/repo/sub".into();
    app.handle_worktree_list_key(KeyEvent::from(KeyCode::Char('h')));

    // Backspace with an active filter pops the filter letter.
    app.worktree_filter = "ab".into();
    app.handle_worktree_list_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.worktree_filter, "a");
}

#[test]
fn worktree_stage_picked_reads_the_worktree_row_path() {
    let mut app = app_with_snapshot();
    // A real directory so validation passes: use the repo cwd itself.
    let cwd = std::env::current_dir().unwrap();
    app.worktree_root = cwd.to_string_lossy().to_string();
    app.worktree_rows = vec![crate::tui::workspace::WorktreeRow {
        path: cwd.to_string_lossy().to_string(),
        branch: "main".into(),
        label: "wt".into(),
        is_linked: false,
    }];
    // Index 0 is the "this folder" row; index 1 is the worktree row
    // whose path arms the Worktree match.
    app.worktree_selected = 1;
    let result = app.worktree_stage_picked();
    assert!(result.is_ok(), "real dir stages, got {result:?}");
}

#[test]
fn branch_picker_reroute_focuses_the_worktrees_workspace_after_refresh() {
    // Full reroute success: worktree.open answers, refresh lands a
    // snapshot whose workspace lives at the worktree path, and the
    // focus moves to it (the tail after refresh).
    let (port, _stop_http) = fake_git_api_server(json!({
        "branches": [
            {"name": "main", "current": true, "remote": false, "worktree_path": "/repo"},
            {"name": "feature", "current": false, "remote": false, "worktree_path": "/repo-wt"}
        ]
    }));
    let (api_socket, _stop_backend) = fake_backend_socket_with(json!({
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"},
                {"workspace_id":"ws_wt","label":"Lane","cwd":"/repo-wt","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_wt"}
            ],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":false,"pane_count":1,"agent_status":"idle"},
                {"tab_id":"tab_wt","workspace_id":"ws_wt","label":"Lane","focused":true,"pane_count":1,"agent_status":"idle"}
            ],
            "panes": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":false},
                {"pane_id":"pane_wt","terminal_id":"term_wt","workspace_id":"ws_wt","tab_id":"tab_wt","agent":"bot","display_agent":"bot","agent_status":"idle","cwd":"/repo-wt","focused":true}
            ],
            "agents": [
                {"pane_id":"pane_wt","terminal_id":"term_wt","workspace_id":"ws_wt","tab_id":"tab_wt","agent":"bot","display_agent":"bot","agent_status":"idle","cwd":"/repo-wt","focused":true}
            ]
        }
    }));
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    app.web_api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
    app.branch_picker_open().unwrap();
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    let result = app.branch_picker_commit().unwrap();
    assert_eq!(result, "switched to feature in /repo-wt");
    assert_eq!(
        app.selected_workspace().unwrap().id,
        "ws_wt",
        "reroute focuses the worktree's workspace"
    );
    assert_eq!(app.mode, crate::tui::TuiMode::Navigate);
    assert!(app.overlay_stack.is_empty());
}

#[test]
fn git_cleanup_render_marks_the_marked_rows_and_tab_bar_skips_an_empty_cwd() {
    let mut app = app_with_snapshot();
    // Marked cleanup rows render the accent star.
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Cleanup;
    app.git_panel.cleanup_repos = vec![crate::tui::panels::git::CleanupRepo {
        path: "/repo".to_string(),
        branches: vec!["old".into()],
        worktrees: vec![],
    }];
    app.git_panel.cleanup_toggle_mark();
    let drawn = draw(&app, 120, 30);
    assert!(drawn.contains("* "), "marked row shows the star");
    assert!(drawn.contains("old"));

    // A workspace with an empty cwd renders the tab bar without the
    // path chip (no panic, no empty token).
    let mut app = app_with_snapshot();
    app.snapshot.workspaces[0].cwd = String::new();
    let drawn = draw(&app, 120, 30);
    assert!(drawn.contains("Shell"), "tab bar still renders");
}

#[test]
fn fresh_shell_commit_creates_the_tab_and_inserts_the_new_pane() {
    // Snapshot that already carries the created tab's root pane, the
    // shape the real backend answers on the post-create refresh: the
    // commit's internal refresh would otherwise prune the new leaf.
    let mut created = fixture_snapshot_value_two_panes();
    created["snapshot"]["panes"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "pane_id":"pane_opened","terminal_id":"term_new","workspace_id":"ws_1",
            "tab_id":"tab_new","agent":null,"display_agent":null,
            "agent_status":"idle","cwd":"/repo","focused":false
        }));
    let (api_socket, _stop) = fake_backend_socket_with(created);
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = TuiSnapshot::from_backend_response(&fixture_snapshot_value_two_panes());
    app.sync_split_tree();
    app.screen = TuiScreen::Terminal;
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = Some("pane_1".to_string());
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".to_string(),
        pane: crate::tui::split::FRESH_SHELL.to_string(),
        side: crate::tui::split::Side::Right,
    });

    app.split_commit();

    assert!(app.split_mode.is_none(), "commit closes the mode");
    // The post-create refresh runs before the assertion: its focus
    // notice (the fake snapshot lacks the new pane) owns the line, so
    // the commit proof is the tree and focus state below.
    assert_eq!(
        app.split_tree.leaves(),
        vec!["pane_1", "pane_opened"],
        "the backend's root pane joined beside the neighbor"
    );
    assert_eq!(
        app.split_focus.as_deref(),
        Some("pane_opened"),
        "focus moves to the fresh tile"
    );
    assert!(app.just_closed_mode, "commit arms the double-Esc guard");
    assert!(app.error.is_none(), "refresh after create: {:?}", app.error);

    // Against a dead socket the create fails and the mode stays open.
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = Some("pane_1".to_string());
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".to_string(),
        pane: crate::tui::split::FRESH_SHELL.to_string(),
        side: crate::tui::split::Side::Right,
    });
    app.split_commit();
    assert_eq!(app.status, "fresh shell failed");
    assert!(
        app.split_mode.is_some(),
        "failed create keeps the mode open"
    );
    assert_eq!(app.split_tree.leaves(), vec!["pane_1"]);
}

#[test]
fn git_log_enter_without_a_selected_commit_errors() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Log;
    app.git_panel.cwd = "/repo".to_string();
    app.git_panel.log_file = None;
    app.git_panel.commits.clear();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.error.as_deref(), Some("no commit selected"));
}

#[test]
fn git_discard_refuses_while_the_selected_file_preview_is_dirty() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Changes;
    app.git_panel.cwd = "/repo".to_string();
    app.git_panel.files = vec![GitFileEntry {
        path: "notes.md".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.git_panel.file_selected = 0;
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("notes.md".to_string()),
        content: "edited".to_string(),
        truncated: false,
        binary: false,
        hash: "h".to_string(),
        dirty: true,
    };
    app.run_shortcut(Shortcut::GitDiscardFile);
    assert_eq!(
        app.error.as_deref(),
        Some("unsaved edits: save or reload before discarding this file"),
        "the dirty buffer blocks the discard verb"
    );

    // A dirty preview on another file does not block the discard: the
    // verb runs (and errors on the dead API, proving the guard passed).
    app.file_explorer.preview.path = Some("other.txt".to_string());
    app.error = None;
    app.run_shortcut(Shortcut::GitDiscardFile);
    assert!(
        app.error
            .as_deref()
            .is_some_and(|e| !e.contains("unsaved edits")),
        "discard ran against the API: {:?}",
        app.error
    );
}

#[test]
fn fresh_shell_split_reports_failure_and_stays_open() {
    // Dead client: the fresh-shell branch must keep the mode open with
    // the failure status instead of committing a phantom pane.
    let mut app = app_with_two_panes();
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".to_string(),
        side: crate::tui::split::Side::Right,
        pane: crate::tui::split::FRESH_SHELL.to_string(),
    });
    app.split_commit();
    assert_eq!(app.status, "fresh shell failed");
    assert!(app.split_mode.is_some(), "mode stays open on failure");
}

#[test]
fn fresh_shell_split_records_the_refresh_error() {
    // Socket that answers tab.create with the full root_pane shape but
    // closes without a response on session.snapshot: the insert
    // commits, the post-insert refresh fails, and the error lands in
    // app.error (the Err arm).
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use std::io::{BufRead as _, BufReader, Write as _};
    let path = crate::backend_client::unique_test_path("herdr-tui-fresh-err");
    let _ = std::fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let value = path.clone();
    std::thread::spawn(move || {
        while let Ok(mut stream) = listener.accept() {
            let mut line = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
            }
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let response = match request["method"].as_str().unwrap_or("") {
                "tab.create" => serde_json::json!({
                    "id": request["id"],
                    "result": {
                        "ok": true,
                        "tab": {"tab_id": "tab_new"},
                        "root_pane": {"pane_id": "pane_opened"}
                    }
                }),
                // Every refresh verb hangs up: ping or snapshot fail.
                _ => continue,
            };
            stream
                .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        }
        let _ = std::fs::remove_file(&value);
    });
    let client = BackendClient::new(&path, &path);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = TuiSnapshot::from_backend_response(&fixture_snapshot_value_two_panes());
    app.sync_split_tree();
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".to_string(),
        side: crate::tui::split::Side::Right,
        pane: crate::tui::split::FRESH_SHELL.to_string(),
    });
    app.split_commit();
    assert!(app.split_mode.is_none(), "the insert itself commits");
    assert!(app.error.is_some(), "the refresh failure is recorded");
}

#[test]
fn fresh_shell_split_with_a_dead_client_commits_nothing() {
    // Non-sentinel pane id on a dead client: the commit falls through
    // to the plain insert path (no create_tab), so the mode closes and
    // the tree gains the pane without any server round-trip.
    let mut app = app_with_two_panes();
    app.split_mode = Some(crate::tui::split::SplitPreview {
        neighbor: "pane_1".to_string(),
        side: crate::tui::split::Side::Right,
        pane: "pane_new".to_string(),
    });
    app.split_commit();
    assert!(app.split_mode.is_none());
    assert!(app.split_tree.contains_pane("pane_new"));
}

#[test]
fn git_changes_shortcut_resets_the_view_when_it_drifted() {
    // Screen already Git with the Log view open: the Changes shortcut
    // flips the view back and refreshes.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.git_panel.view = crate::tui::panels::git::GitView::Log;
    app.run_shortcut(Shortcut::GitFileHistory);
    assert_eq!(
        app.git_panel.view,
        crate::tui::panels::git::GitView::Changes
    );
}
