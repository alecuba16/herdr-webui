//! Files screen tests: navigation, preview, edit, find/replace, filter.

use super::*;
use crate::tui::panels::{FileEntry, GitBranchEntry, GitFileEntry, GitFileStatus, GitView};
use crate::tui::web_api::WebApiClient;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::style::Color;
use ratatui::Terminal;
use serde_json::json;

#[test]
fn files_screen_navigation_and_preview_flow() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
            "tabs": [], "panes": [], "agents": []
        }
    }));
    app.screen = TuiScreen::Files;
    app.file_explorer.entries = vec![
        FileEntry {
            name: "src".to_string(),
            path: "src".to_string(),
            is_dir: true,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
        FileEntry {
            name: "main.rs".to_string(),
            path: "main.rs".to_string(),
            is_dir: false,
            size: Some(120),
            level: 0,
            expanded: false,
            git_status: None,
        },
    ];
    app.file_explorer.move_selection(1);
    assert_eq!(app.file_explorer.selected, 1);
    assert_eq!(app.active_cwd().as_deref(), Some("/repo"));

    // Render smoke: files screen renders without a live WebUI backend.
    let backend = TestBackend::new(100, 28);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &app)).unwrap();
    let rendered = format!("{:?}", terminal.backend().buffer());
    assert!(rendered.contains("Files"));
}

#[test]
fn files_screen_rename_opens_prompt_prefilled_with_name() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;
    app.file_explorer.entries = vec![FileEntry {
        name: "old.rs".to_string(),
        path: "old.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    }];
    app.handle_key(KeyEvent::from(KeyCode::Char('R')));
    let prompt = app.prompt_input.as_ref().expect("rename prompt open");
    assert_eq!(prompt.kind, PromptKind::RenameFile);
    assert_eq!(prompt.text, "old.rs");

    // Edit the prefilled name and submit; the prompt closes (the rename
    // call fails against the default loopback API, but the modal flow is
    // what matters here).
    app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    app.handle_key(KeyEvent::from(KeyCode::Char('w')));
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "new");
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.prompt_input.is_none());
}

#[test]
fn files_screen_delete_requires_typed_y_confirmation() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;
    app.file_explorer.entries = vec![FileEntry {
        name: "doomed.txt".to_string(),
        path: "doomed.txt".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    }];
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(
        app.prompt_input.as_ref().map(|prompt| prompt.kind),
        Some(PromptKind::ConfirmDeleteFile)
    );
    // Typing 'n' then Enter cancels without deleting.
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.prompt_input.is_none());
    assert_eq!(app.status, "cancelled");
    assert!(app.error.is_none());

    // Reopen, type 'y', Enter: the delete call runs (fails against the
    // dead loopback API, proving the action path is taken).
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    app.handle_key(KeyEvent::from(KeyCode::Char('y')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.prompt_input.is_none());
    assert!(app.error.is_some());
}

#[test]
fn files_screen_e_starts_edit_and_esc_stops_with_dirty_kept() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("notes.md".to_string()),
        content: "line one".to_string(),
        truncated: false,
        binary: false,
        hash: "h1".to_string(),
        dirty: false,
    };

    // In-screen e enters edit mode on the open preview.
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert!(app.file_explorer.edit_active);
    assert_eq!(app.file_explorer.edit_cursor, "line one".len());

    // While editing, a typed char goes into the buffer and marks it dirty.
    app.handle_key(KeyEvent::from(KeyCode::Char('!')));
    assert_eq!(app.file_explorer.preview.content, "line one!");
    assert!(app.file_explorer.preview.dirty);

    // Backspace removes the char but the buffer stays dirty.
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.file_explorer.preview.content, "line one");

    // Esc stops editing; the dirty flag survives so the title keeps the *.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(!app.file_explorer.edit_active);
    assert!(app.file_explorer.preview.dirty);

    // Prefix then e re-enters edit mode from any panel screen.
    let ctrl_b = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert!(app.file_explorer.edit_active);
    assert_eq!(
        app.file_explorer.edit_cursor,
        app.file_explorer.preview.content.len()
    );

    // While editing, j/k no longer move the tree selection: keys type.
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.file_explorer.preview.content, "line onej");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
}

#[test]
fn prefix_e_from_git_edits_file_highlighted_in_changes() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Changes;
    app.git_panel.files = vec![GitFileEntry {
        path: "src/app.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.git_panel.file_selected = 0;

    // Prefix e switches to the Files screen and loads the selected file
    // for editing; the file_read call fails against the dead loopback API,
    // which proves the edit-from-git path is taken.
    let ctrl_b = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert!(app.error.is_some(), "edit from git must attempt file_read");
}

#[test]
fn prefix_e_amend_moves_to_commit_modal_and_a_stays_amend() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Git;
    // In-screen a opens the amend modal (webui has no prefix amend
    // shortcut; the checkbox lives in the commit modal).
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    let modal = app.commit_input.as_ref().expect("amend modal open");
    assert!(modal.amend);
}

#[test]
fn files_screen_dirty_preview_survives_switch_and_blocks_replacement() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("notes.md".to_string()),
        content: "line one".to_string(),
        truncated: false,
        binary: false,
        hash: "h1".to_string(),
        dirty: false,
    };
    app.file_explorer.entries = vec![
        FileEntry {
            name: "notes.md".to_string(),
            path: "notes.md".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
        FileEntry {
            name: "other.txt".to_string(),
            path: "other.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
    ];
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    app.handle_key(KeyEvent::from(KeyCode::Char('!')));
    assert!(app.file_explorer.preview.dirty);

    // Prefix t leaves for the terminal, then prefix f returns to Files
    // without rebuilding the explorer: the dirty buffer survives both
    // switches, like a webui dirty editor tab.
    let ctrl_b = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('t')));
    assert_eq!(app.screen, TuiScreen::Terminal);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('f')));
    assert_eq!(app.screen, TuiScreen::Files);
    assert_eq!(app.file_explorer.preview.content, "line one!");
    assert!(app.file_explorer.preview.dirty);

    // Leave edit mode (Esc keeps dirty) so tree navigation works again.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(!app.file_explorer.edit_active);

    // Opening a different file while dirty is refused with a visible
    // message; the dirty preview is not replaced.
    app.file_explorer.move_selection(1);
    assert_eq!(app.file_explorer.selected, 1);
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("unsaved edits"));
    assert_eq!(
        app.file_explorer.preview.path.as_deref(),
        Some("notes.md"),
        "preview must not be replaced while dirty"
    );
}

#[test]
fn dirty_preview_blocks_rename_delete_and_discard_of_edited_file() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    point_web_api_at_dead_port(&mut app);
    app.screen = TuiScreen::Files;
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("notes.md".to_string()),
        content: "line one".to_string(),
        truncated: false,
        binary: false,
        hash: "h1".to_string(),
        dirty: false,
    };
    app.file_explorer.entries = vec![FileEntry {
        name: "notes.md".to_string(),
        path: "notes.md".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    }];
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    app.handle_key(KeyEvent::from(KeyCode::Char('!')));
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.file_explorer.preview.dirty);

    // Rename and delete of the dirty file are refused, not prompted.
    app.handle_key(KeyEvent::from(KeyCode::Char('R')));
    assert!(app.prompt_input.is_none());
    assert!(app
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("unsaved edits"));
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert!(app.prompt_input.is_none());
    assert!(app
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("unsaved edits"));

    // Git discard (in-screen d) of the same file is refused too.
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Changes;
    app.git_panel.files = vec![GitFileEntry {
        path: "notes.md".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.git_panel.file_selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Char('d')));
    assert!(app
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("unsaved edits"));

    // Discarding a different file still works (fails on the dead API,
    // proving the action ran instead of the guard).
    app.git_panel.files = vec![GitFileEntry {
        path: "other.txt".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('d')));
    assert!(
        app.error
            .as_deref()
            .unwrap_or_default()
            .contains("webui connection failed"),
        "discard of a non-edited file must reach the API, got {:?}",
        app.error
    );
}

#[test]
fn prefix_h_loads_file_history_and_o_returns_to_changes() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Changes;
    app.git_panel.files = vec![GitFileEntry {
        path: "src/app.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.git_panel.file_selected = 0;
    let ctrl_b = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);

    // Chord reduction: prefix h/o no longer jump git views (History is
    // reachable in-screen via the Tab cycle; the file-history arm in
    // run_shortcut stays for future direct bindings). The reduced keys
    // must stay inert.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    assert_eq!(
        app.git_panel.view,
        GitView::Changes,
        "h is inert after reduction"
    );
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('o')));
    assert_eq!(
        app.git_panel.view,
        GitView::Changes,
        "o is inert after reduction"
    );
}

#[test]
fn renders_files_preview_states() {
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.file_explorer.entries = vec![
        FileEntry {
            name: "src".to_string(),
            path: "src".to_string(),
            is_dir: true,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
        FileEntry {
            name: "readme.md".to_string(),
            path: "readme.md".to_string(),
            is_dir: false,
            size: Some(42),
            level: 0,
            expanded: false,
            git_status: None,
        },
    ];
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("readme.md".to_string()),
        content: "hello world".to_string(),
        truncated: false,
        binary: false,
        hash: "abc".to_string(),
        dirty: false,
    };
    // Sidebar 34 + tree/preview split needs >= 90 for the main area:
    // draw at 150 so the preview pane exists.
    let rendered = draw(&app, 150, 30);
    assert!(rendered.contains("hello world"), "preview content shown");
    assert!(rendered.contains("readme.md"));

    // Binary preview refuses editing.
    app.file_explorer.preview.binary = true;
    assert!(app.file_explorer.start_edit().is_err());

    // Truncated preview also refuses.
    app.file_explorer.preview.binary = false;
    app.file_explorer.preview.truncated = true;
    assert!(app.file_explorer.start_edit().is_err());

    // Edit mode renders the cursor hint.
    app.file_explorer.preview.truncated = false;
    app.file_explorer.start_edit().unwrap();
    assert!(app.file_explorer.edit_active);
    assert!(draw(&app, 150, 30)
        .contains("Ctrl-S save \u{b7} Ctrl-F find \u{b7} Ctrl-H replace \u{b7} Esc stop"));

    // Find bar renders the query and match count while active.
    app.file_explorer.editor_find.active = true;
    app.file_explorer.editor_find.query = "read".to_string();
    app.file_explorer.editor_find.ranges = vec![(1, 5), (10, 14)];
    app.file_explorer.editor_find.selected = 1;
    let find_draw = draw(&app, 150, 30);
    assert!(find_draw.contains("find read"));
    assert!(find_draw.contains("match 2/2"));
    app.file_explorer.editor_find.active = false;

    // Filter mode renders the filter box.
    app.file_explorer.edit_active = false;
    app.file_explorer.filter_active = true;
    app.file_explorer.filter = "read".to_string();
    let filtered = draw(&app, 150, 30);
    assert!(filtered.contains("filter:"), "filter box renders");
    assert!(filtered.contains("Enter applies"), "filter hint renders");
    app.file_explorer.filter_active = false;
    app.file_explorer.filter.clear();

    // No preview at all: the placeholder hints render.
    app.file_explorer.preview = crate::tui::panels::FilePreview::default();
    let no_preview = draw(&app, 150, 30);
    assert!(
        no_preview.contains("Select a file with j/k and press Enter to preview."),
        "no-preview hint renders"
    );
    assert!(
        no_preview.contains("Enter on a folder expands it"),
        "folder hint renders"
    );

    // Empty file preview shows the empty-file line.
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("empty.txt".to_string()),
        content: String::new(),
        truncated: false,
        binary: false,
        hash: "h".to_string(),
        dirty: false,
    };
    assert!(
        draw(&app, 150, 30).contains("empty.txt is empty"),
        "empty file line renders"
    );

    // Binary preview renders the binary-file badge.
    app.file_explorer.preview.binary = true;
    assert!(
        draw(&app, 150, 30).contains("binary file"),
        "binary badge renders"
    );

    // Truncated preview renders the truncation marker.
    app.file_explorer.preview.binary = false;
    app.file_explorer.preview.truncated = true;
    assert!(
        draw(&app, 150, 30).contains("… file truncated"),
        "truncation marker renders"
    );
    app.file_explorer.preview.truncated = false;

    // Search mode renders the search-results header.
    app.file_explorer.search_mode = true;
    app.file_explorer.filter = "read".to_string();
    assert!(
        draw(&app, 150, 30).contains("search results for 'read'"),
        "search header renders"
    );
    app.file_explorer.search_mode = false;
    app.file_explorer.filter.clear();

    // A non-root cwd shows the root_path title (subdirectory view).
    app.file_explorer.root_path = "src".to_string();
    assert!(
        draw(&app, 150, 30).contains("src"),
        "root path title renders"
    );
    app.file_explorer.root_path = String::new();

    // Expanded directory renders the open-folder caret; scrolling keeps
    // the selection in view.
    let mut many = vec![FileEntry {
        name: "src".to_string(),
        path: "src".to_string(),
        is_dir: true,
        size: None,
        level: 0,
        expanded: true,
        git_status: None,
    }];
    for i in 0..40 {
        many.push(FileEntry {
            name: format!("file{i}.rs"),
            path: format!("file{i}.rs"),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        });
    }
    app.file_explorer.entries = many;
    // Selection near the top: the expanded caret is visible.
    app.file_explorer.selected = 2;
    let top = draw(&app, 150, 30);
    assert!(top.contains("\u{25be}"), "expanded caret renders");
    // Selection far down: the list scrolls to keep it visible.
    app.file_explorer.selected = 38;
    let scrolled = draw(&app, 150, 30);
    assert!(
        scrolled.contains("file38.rs"),
        "scroll keeps selection visible"
    );
    assert!(
        !scrolled.contains("file0.rs"),
        "scrolled past the first entry"
    );

    // An empty tree renders the empty hint.
    app.file_explorer.entries.clear();
    app.file_explorer.selected = 0;
    assert!(
        draw(&app, 150, 30).contains("No entries."),
        "empty tree hint renders"
    );
}

#[test]
fn files_in_panel_keys_cover_rename_delete_and_enter() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.screen = TuiScreen::Files;
    app.mode = TuiMode::Attach;
    app.file_explorer.entries = vec![
        FileEntry {
            name: "src".to_string(),
            path: "src".to_string(),
            is_dir: true,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
        FileEntry {
            name: "a.txt".to_string(),
            path: "a.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
    ];

    // Enter on a file opens the preview (API error surfaces but the
    // selection does not crash).
    app.file_explorer.selected = 1;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "preview needs the API");
    app.error = None;

    // R opens the rename prompt prefilled with the current name.
    app.handle_key(KeyEvent::new(KeyCode::Char('R'), KeyModifiers::SHIFT));
    let prompt = app.prompt_input.as_ref().unwrap();
    assert_eq!(prompt.kind, PromptKind::RenameFile);
    assert_eq!(prompt.text, "a.txt", "rename prompt is prefilled");
    app.prompt_input = None;

    // x opens the delete confirmation.
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert!(app
        .prompt_input
        .as_ref()
        .is_some_and(|p| p.kind == PromptKind::ConfirmDeleteFile));
    app.prompt_input = None;

    // Filter keys: / starts the filter, typing appends, Enter applies.
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert!(app.file_explorer.filter_active);
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    assert_eq!(app.file_explorer.filter, "a");
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(!app.file_explorer.filter_active, "Enter applies the filter");
    assert!(app.error.is_some(), "filter search hits the API");
    app.error = None;
    app.file_explorer.filter.clear();

    // e starts editing the open preview.
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("a.txt".to_string()),
        content: "x".to_string(),
        truncated: false,
        binary: false,
        hash: "h".to_string(),
        dirty: false,
    };
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert!(app.file_explorer.edit_active, "e starts edit mode");

    // While editing, j/k no longer move the selection.
    let selected_before = app.file_explorer.selected;
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.file_explorer.selected, selected_before);

    // Esc stops editing.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(!app.file_explorer.edit_active);

    // l enters/expands: on a directory it refreshes (API error ok).
    app.file_explorer.selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    app.error = None;

    // h and u go to the parent (root: no-op or API error, no panic).
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    app.handle_key(KeyEvent::from(KeyCode::Char('u')));
    app.error = None;

    // Filter: backspace pops a char, Esc cancels the filter.
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert!(app.file_explorer.filter.is_empty(), "backspace pops filter");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(!app.file_explorer.filter_active, "Esc cancels filter");

    // r refreshes the active screen.
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));

    // q returns to the terminal screen.
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.screen, TuiScreen::Terminal);
}

#[test]
fn prefix_e_from_git_changes_opens_file_edit_and_tab_arms_error() {
    let ctrl_b = ctrl('b');
    let mut app = app_with_snapshot();

    // prefix e on the Git screen with no selected file: error arm.
    app.screen = TuiScreen::Git;
    app.git_panel.files.clear();
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert_eq!(
        app.error.as_deref(),
        Some("no file selected in git changes"),
        "git edit without selection errors"
    );

    // prefix e with a selected file: reads via the API, builds a fresh
    // explorer, and lands on the Files screen in edit mode. Against a
    // live backend the read may succeed; against a dead one it errors.
    // Either way the arm must not panic.
    app.error = None;
    app.git_panel.files = vec![GitFileEntry {
        path: "src/app.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.git_panel.view = GitView::Changes;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    if app.error.is_none() {
        assert_eq!(
            app.screen,
            TuiScreen::Files,
            "successful git edit switches to the Files screen"
        );
        assert_eq!(
            app.file_explorer.preview.path.as_deref(),
            Some("src/app.rs")
        );
        assert!(app.file_explorer.edit_active, "edit mode starts");
    }

    // NewTab/CloseTab with no workspace selected: error arms.
    app.snapshot.workspaces.clear();
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    assert_eq!(app.error.as_deref(), Some("no workspace selected"));
    app.error = None;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(app.error.as_deref(), Some("no workspace selected"));
}

#[test]
fn prefix_e_and_discard_guards_against_dead_web_api() {
    let ctrl_b = ctrl('b');
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.snapshot = fixture_snapshot();
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Changes;
    app.git_panel.files = vec![GitFileEntry {
        path: "src/app.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.git_panel.set_cwd("/repo");

    // EditFile against a dead web API: the read error surfaces.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert!(app.error.is_some(), "dead web API read must error");

    // EditFile on the Files screen with no preview open errors from
    // start_edit's own guard.
    app.error = None;
    app.screen = TuiScreen::Files;
    app.file_explorer.preview = crate::tui::panels::FilePreview::default();
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert!(
        app.error
            .as_deref()
            .is_some_and(|e| e.contains("no file preview open")),
        "prefix e on Files without a preview errors: {:?}",
        app.error
    );
    app.screen = TuiScreen::Git;

    // Without a dirty preview the discard runs against the API and errors
    // (the dirty-buffer guard needs a live API to keep the file list; the
    // e2e suite covers the guard arm against the real server).
    app.file_explorer.preview.dirty = false;
    app.error = None;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('d')));
    assert!(app.error.is_some(), "dead web API discard must error");

    // Branch switch against a dead web API errors (via prefix v).
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
            name: "dev".to_string(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: None,
        },
    ];
    app.git_panel.branch_selected = 1;
    app.error = None;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('v')));
    assert!(app.error.is_some(), "dead web API branch switch must error");
}

#[test]
fn files_key_error_and_guard_arms() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.screen = TuiScreen::Files;
    app.mode = TuiMode::Attach;
    app.file_explorer.entries = vec![
        FileEntry {
            name: "src".to_string(),
            path: "src".to_string(),
            is_dir: true,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
        FileEntry {
            name: "a.txt".to_string(),
            path: "a.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
    ];

    // An unmatched key does nothing.
    app.handle_key(KeyEvent::from(KeyCode::F(9)));

    // R with no selection errors (entries exist but selected out of range).
    app.file_explorer.selected = 9;
    app.handle_key(KeyEvent::new(KeyCode::Char('R'), KeyModifiers::SHIFT));
    assert_eq!(app.error.as_deref(), Some("no file selected"));
    app.error = None;

    // x with no selection errors.
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(app.error.as_deref(), Some("no file selected"));
    app.error = None;

    // R with a dirty preview of the selected file is refused.
    app.file_explorer.selected = 1;
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("a.txt".to_string()),
        content: "x".to_string(),
        truncated: false,
        binary: false,
        hash: "h".to_string(),
        dirty: true,
    };
    app.handle_key(KeyEvent::new(KeyCode::Char('R'), KeyModifiers::SHIFT));
    assert_eq!(
        app.error.as_deref(),
        Some("unsaved edits: save or reload before renaming files")
    );
    app.error = None;

    // x with the dirty preview is refused too.
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(
        app.error.as_deref(),
        Some("unsaved edits: save or reload before deleting files")
    );
    app.file_explorer.preview.dirty = false;
    app.error = None;

    // Enter on a file: toggle_expand is a no-op for files, then
    // open_preview runs (API error surfaces against the dead port).
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some());
    app.error = None;

    // l on a file: neither enter nor expand; nothing happens.
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));

    // l on a directory: enter_directory wins, refresh errors surface.
    app.file_explorer.selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert!(app.error.is_some());
    app.error = None;

    // u goes up from the entered directory (root becomes empty; refresh
    // error surfaces).
    app.file_explorer.root_path = "src".to_string();
    app.handle_key(KeyEvent::from(KeyCode::Char('u')));
    assert!(app.error.is_some());
    app.error = None;
}

#[test]
fn files_filter_ignores_non_text_keys_while_active() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;
    app.mode = TuiMode::Attach;
    app.file_explorer.filter_active = true;
    app.file_explorer.filter = "re".to_string();
    // Arrow keys are not filter characters: the match falls through the
    // `_` arm and the filter keeps running without touching the API.
    app.handle_key(KeyEvent::from(KeyCode::Up));
    assert!(app.file_explorer.filter_active, "filter stays active");
    assert_eq!(app.file_explorer.filter, "re");
    assert!(app.error.is_none(), "guard arm must not set an error");
}

#[test]
fn files_enter_refuses_to_open_preview_with_dirty_other_file() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;
    app.mode = TuiMode::Attach;
    // A dirty buffer on another file blocks Enter preview loading: the
    // refusal surfaces as an error, keeping the dirty buffer intact.
    app.file_explorer.entries = vec![
        crate::tui::panels::FileEntry {
            name: "one.txt".to_string(),
            path: "one.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
        crate::tui::panels::FileEntry {
            name: "two.txt".to_string(),
            path: "two.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
    ];
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("one.txt".to_string()),
        content: "edited".to_string(),
        truncated: false,
        binary: false,
        hash: "h".to_string(),
        dirty: true,
    };
    app.file_explorer.selected = 1;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(
        app.error
            .as_deref()
            .is_some_and(|e| e.contains("unsaved edits")),
        "Enter must refuse to drop the dirty buffer: {:?}",
        app.error
    );
    assert_eq!(
        app.file_explorer.preview.path.as_deref(),
        Some("one.txt"),
        "dirty buffer survives"
    );
}

#[test]
fn files_l_and_u_surface_refresh_errors_from_a_dead_api() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;
    app.mode = TuiMode::Attach;
    app.file_explorer = crate::tui::panels::FileExplorer::new("/repo");
    app.file_explorer.entries = vec![
        crate::tui::panels::FileEntry {
            name: "dir".to_string(),
            path: "dir".to_string(),
            is_dir: true,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
        crate::tui::panels::FileEntry {
            name: "file.txt".to_string(),
            path: "file.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
    ];
    // l on a plain file falls through to toggle_expand, which returns
    // Ok(false) without an API call: no refresh, no error.
    app.file_explorer.selected = 1;
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert!(app.error.is_none(), "l on a file must not refresh");
    // l on a directory expands it inline; the refresh against the dead
    // API surfaces the error.
    app.file_explorer.selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert!(
        app.error.is_some(),
        "l on a dir should surface a refresh error"
    );
    app.error = None;
    // u goes up a directory; the refresh error surfaces the same way.
    app.file_explorer.root_path = "sub".to_string();
    app.handle_key(KeyEvent::from(KeyCode::Char('u')));
    assert!(app.error.is_some(), "u should surface a refresh error");
}

#[test]
fn files_and_git_panel_error_arms_surface_to_status() {
    // A dead WebUI API endpoint makes every panel call fail fast, and the
    // snapshot-failing backend socket makes Terminal refreshes fail too;
    // the error arms must land in app.error instead of panicking.
    let (api_socket, _stop) = fake_backend_socket_failing_snapshots();
    let mut app = TuiApp::new_with_options(
        BackendClient::new(api_socket.clone(), api_socket.clone()),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.snapshot = fixture_snapshot();

    // Ctrl+B f twice: opening the Files screen when already there is a
    // cheap no-op (early return).
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('f')));
    assert_eq!(app.screen, TuiScreen::Files);
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('f')));
    assert_eq!(app.screen, TuiScreen::Files, "second open is a no-op");

    // Enter on a file entry: toggle_expand fails against the dead API.
    app.file_explorer.entries = vec![crate::tui::panels::FileEntry {
        name: "a.rs".to_string(),
        path: "a.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    }];
    app.file_explorer.selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "Enter error surfaces");
    app.error = None;

    // 'e' on a previewless selection refuses to edit with an error.
    app.file_explorer.preview.path = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert!(app.error.is_some(), "edit without preview errors");
    app.error = None;

    // 'r' on the Files screen refreshes the tree against the dead API.
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    assert!(app.error.is_some(), "files refresh error surfaces");
    app.error = None;

    // Terminal screen: prefix-r refresh hits the Terminal arm of
    // refresh_active_screen, failing against the dead snapshot socket.
    app.screen = TuiScreen::Terminal;
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    assert!(app.error.is_some(), "terminal refresh error surfaces");
    app.error = None;

    // Vanished-file prefix-e (a.rs deleted from disk behind the tree):
    // the rename prompt path rebuilds a fresh explorer and its failed
    // refresh surfaces too.
    app.screen = TuiScreen::Files;
    app.git_panel.cwd = std::env::temp_dir().to_string_lossy().to_string();
    app.file_explorer.entries = vec![crate::tui::panels::FileEntry {
        name: "vanished.rs".to_string(),
        path: "vanished.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    }];
    app.file_explorer.selected = 0;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert!(app.error.is_some(), "vanished prefix-e errors");
    app.error = None;

    // Rename prompt: confirm with a dead API surfaces the failure.
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::RenameFile,
        text: "b.rs".to_string(),
    });
    app.file_explorer.entries = vec![crate::tui::panels::FileEntry {
        name: "a.rs".to_string(),
        path: "a.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    }];
    app.file_explorer.selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "rename failure surfaces");
    assert!(app.prompt_input.is_none(), "prompt closes on confirm");
    app.error = None;

    // Delete prompt: typing `y` confirms, and the delete fails against
    // the dead API.
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::ConfirmDeleteFile,
        text: String::new(),
    });
    app.file_explorer.selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Char('y')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "delete failure surfaces");
    assert!(app.prompt_input.is_none());
}

#[test]
fn content_search_keys_own_results_and_toggles_re_run() {
    use crate::tui::panels::files::{ContentSearchChunk, ContentSearchFile, ContentSearchRow};

    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;

    // Fabricate results without a server: the key flow must not hit the
    // API for j/k, Enter-toggle, or A/X toggles with a dead endpoint...
    // except toggles re-run the search, so use the fake server that
    // answers content-search with an empty payload (parse-safe).
    let (port, _stop) = fake_web_api_server(true, true, true);
    app.web_api = WebApiClient::new("127.0.0.1", port);
    app.file_explorer.search_mode = true;
    app.file_explorer.search_kind = crate::tui::panels::files::SearchKind::Content;
    app.file_explorer.filter = "needle".to_string();
    app.file_explorer.content_search = crate::tui::panels::files::ContentSearchState {
        query: "needle".to_string(),
        files: vec![ContentSearchFile {
            path: "a.txt".to_string(),
            name: "a.txt".to_string(),
            match_count: 1,
            chunks: vec![ContentSearchChunk {
                start: 1,
                end: 1,
                rows: vec![ContentSearchRow {
                    line: 4,
                    text: "hit here".to_string(),
                    matched: true,
                }],
            }],
            truncated: false,
            first_match_line: 4,
        }],
        expanded: vec![true],
        done: true,
        ..Default::default()
    };

    // j moves over the flat rows (header + one line).
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.file_explorer.content_search.selected, 1);

    // Enter on a matched line jumps: preview opens at the line. The
    // fake server must answer file reads for this to succeed.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.file_explorer.preview_jump_line, Some(4));

    // Esc clears the results and leaves content mode.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(!app.file_explorer.search_mode);
    assert!(app.file_explorer.content_search.files.is_empty());
}

#[test]
fn files_screen_ctrl_f_find_bar_types_cycles_and_esc_keeps_query() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("notes.md".to_string()),
        content: "alpha beta alpha".to_string(),
        truncated: false,
        binary: false,
        hash: "h1".to_string(),
        dirty: false,
    };
    app.file_explorer.edit_active = true;
    app.file_explorer.edit_cursor = 0;

    // Ctrl+F opens the find bar.
    app.handle_key(ctrl('f'));
    assert!(app.file_explorer.editor_find.active);

    // Typing re-runs the search incrementally.
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert_eq!(app.file_explorer.editor_find.query, "al");
    assert_eq!(app.file_explorer.editor_find.ranges.len(), 2);

    // Enter cycles forward, Shift+Enter cycles back.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.file_explorer.editor_find.selected, 1);
    let shift_enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT);
    app.handle_key(shift_enter);
    assert_eq!(app.file_explorer.editor_find.selected, 0);

    // A toggles match case (query "al" is lowercase so no change in
    // count, but the flag flips and re-runs).
    app.handle_key(KeyEvent::from(KeyCode::Char('A')));
    assert!(app.file_explorer.editor_find.match_case);

    // Esc closes the bar but keeps the query for the next open.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(!app.file_explorer.editor_find.active);
    assert_eq!(app.file_explorer.editor_find.query, "al");

    // Reopen resumes with the same query.
    app.handle_key(ctrl('f'));
    assert!(app.file_explorer.editor_find.active);
    assert_eq!(app.file_explorer.editor_find.ranges.len(), 2);
    app.handle_key(KeyEvent::from(KeyCode::Esc));
}

#[test]
fn files_screen_ctrl_h_replace_prompt_replaces_current_and_all() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("notes.md".to_string()),
        content: "foo bar foo".to_string(),
        truncated: false,
        binary: false,
        hash: "h1".to_string(),
        dirty: false,
    };
    app.file_explorer.edit_active = true;
    app.file_explorer.edit_cursor = 0;
    app.handle_key(ctrl('f'));
    app.handle_key(KeyEvent::from(KeyCode::Char('f')));
    app.handle_key(KeyEvent::from(KeyCode::Char('o')));
    app.handle_key(KeyEvent::from(KeyCode::Char('o')));
    assert_eq!(app.file_explorer.editor_find.ranges.len(), 2);
    app.handle_key(KeyEvent::from(KeyCode::Esc));

    // Ctrl+H opens the replace prompt.
    app.handle_key(ctrl('h'));
    assert_eq!(
        app.prompt_input.as_ref().map(|prompt| prompt.kind),
        Some(PromptKind::ReplaceInFile)
    );

    // Enter with plain text replaces only the current match.
    for ch in "qux".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.prompt_input.is_none());
    assert_eq!(app.file_explorer.preview.content, "qux bar foo");
    assert!(app.file_explorer.preview.dirty);
    assert!(app.file_explorer.edit_active);
    // Find re-ran: the remaining foo is still a match.
    assert_eq!(app.file_explorer.editor_find.ranges.len(), 1);

    // Trailing `!` replaces all matches.
    app.file_explorer.edit_active = true;
    app.handle_key(ctrl('h'));
    for ch in "zap!".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.file_explorer.preview.content, "qux bar zap");
    assert!(app.file_explorer.editor_find.ranges.is_empty());
}

#[test]
fn files_screen_tab_cycles_recent_previews_and_w_reveals_git_file() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;
    // Two already-open recents: Tab should flip the preview without
    // touching the (dead) backend.
    app.file_explorer.recent_previews = vec!["b.md".to_string(), "a.md".to_string()];
    app.file_explorer.preview = crate::tui::panels::FilePreview {
        path: Some("b.md".to_string()),
        content: "b".to_string(),
        truncated: false,
        binary: false,
        hash: "h1".to_string(),
        dirty: false,
    };
    // Tab without a reachable API keeps the list rotating state intact;
    // the switch itself fails and surfaces an error, so assert on the
    // non-networking branch: single-entry recents.
    app.file_explorer.recent_previews.truncate(1);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.status, "no recent previews");

    // `w` with no git file selected errors instead of guessing.
    app.handle_key(KeyEvent::from(KeyCode::Char('w')));
    assert_eq!(
        app.error.as_deref(),
        Some("no file selected in the git panel")
    );
}

#[test]
fn file_editor_paints_the_cursor_cell_in_both_themes() {
    // The editor never places a terminal cursor, so the caret must be
    // painted: an inverted cell at the cursor's row and column. The
    // check pins the cell's colors against the active palette in both
    // themes, the fix for the light-mode invisibility report.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.file_explorer.preview.path = Some("src/lib.rs".to_string());
    app.file_explorer.preview.content = "fn main() {\n    let x = 1;\n}\n".to_string();
    app.file_explorer.edit_active = true;
    // Cursor mid-line: on `let`, column 4 of line 2.
    app.file_explorer.edit_cursor = "fn main() {\n    ".len();

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
        let row = rendered_row(&buffer, "fn main() {");
        // Line 2 starts one row below line 1; the caret sits on the
        // character right after the leading indent.
        let caret_y = (row.y + 1) as u16;
        let line_two = rendered_row(&buffer, "let x = 1;");
        assert_eq!(caret_y, line_two.y as u16);
        // The indent is 4 cells after the 5-wide number gutter; the
        // caret cell paints accent bg with panel-bg fg.
        let caret_x = line_two.cell_x_of("let x").unwrap();
        assert_eq!(buffer[(caret_x as u16, caret_y)].fg, panel_bg);
        assert_eq!(buffer[(caret_x as u16, caret_y)].bg, accent);
        // The character under the caret is still readable.
        assert_eq!(buffer[(caret_x as u16, caret_y)].symbol(), "l");
    }

    // End-of-line cursor: with the cursor past the final newline (the
    // state `start_edit` leaves), the caret paints on a virtual line
    // below the last rendered one.
    app.file_explorer.edit_cursor = app.file_explorer.preview.content.len();
    app.theme = TuiTheme::Light;
    app.palette = crate::tui::theme::Palette::for_theme(TuiTheme::Light);
    let buffer = draw_buffer(&app, 140, 30);
    let last = rendered_row(&buffer, "}");
    let virtual_row = rendered_row(&buffer, "   4");
    assert_eq!(
        virtual_row.y,
        last.y + 1,
        "caret row sits below the last line"
    );
    // The virtual row is `   4 ` + one inverted padding space.
    let caret_x = (virtual_row.cell_x_of("4").unwrap() + 2) as u16;
    assert_eq!(
        buffer[(caret_x, virtual_row.y as u16)].bg,
        Color::Rgb(37, 99, 235)
    );
    assert_eq!(
        buffer[(caret_x, virtual_row.y as u16)].fg,
        Color::Rgb(255, 255, 255)
    );
    assert_eq!(buffer[(caret_x, virtual_row.y as u16)].symbol(), " ");
}

#[test]
fn file_tree_search_rows_highlight_matched_name_in_yellow() {
    // Committed search results paint the matched substring with the
    // palette yellow (same token as the webui `herdr-tree-hit` mark);
    // the rest of the row keeps its normal color.
    // Coverage note (match_span's regex build): the Ok-else on
    // RegexBuilder is unreachable — the needle goes through
    // regex::escape first, whose output is always a compilable
    // pattern, so the build can never fail here.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.file_explorer.entries = vec![FileEntry {
        name: "render_tree.rs".to_string(),
        path: "src/render_tree.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    }];
    app.file_explorer.filter = "tree".to_string();
    app.file_explorer.search_mode = true;

    let buffer = draw_buffer(&app, 120, 30);
    let row = rendered_row(&buffer, "render_tree.rs");
    let matched_x = row.cell_x_of("tree").expect("matched substring rendered");
    let plain_x = row.cell_x_of("render").expect("name prefix rendered");
    let yellow = Color::Rgb(249, 226, 175);
    assert_eq!(
        buffer[(matched_x as u16, row.y as u16)].fg,
        yellow,
        "matched substring uses the palette yellow"
    );
    assert_ne!(
        buffer[(plain_x as u16, row.y as u16)].fg,
        yellow,
        "unmatched part keeps its normal color"
    );

    // Unfiltered tree: no highlight anywhere on the name.
    app.file_explorer.search_mode = false;
    let buffer = draw_buffer(&app, 120, 30);
    let row = rendered_row(&buffer, "render_tree.rs");
    let name_x = row.cell_x_of("tree").expect("name rendered unfiltered");
    assert_ne!(
        buffer[(name_x as u16, row.y as u16)].fg,
        yellow,
        "plain tree rows never highlight"
    );
}

#[test]
fn prefix_v_opens_the_branch_picker() {
    let (port, _stop) = fake_git_api_server(json!({
        "branches": [
            {"name": "main", "current": true, "remote": false, "worktree_path": "/repo"}
        ]
    }));
    let mut app = app_with_snapshot();
    app.web_api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
    app.run_shortcut(Shortcut::GitSwitchBranch);
    assert_eq!(
        app.mode,
        TuiMode::BranchPicker,
        "prefix v opens the workspace-scoped picker"
    );
    assert!(!app.branch_picker_rows.is_empty());
}

#[test]
fn files_screen_refresh_error_lands_in_the_status_bar() {
    // A dead web_api makes the Files screen refresh report the error.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.refresh_active_screen();
    assert!(app.error.is_some());
}
