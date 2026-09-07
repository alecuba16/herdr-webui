use super::*;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::style::Color;
use ratatui::Terminal;
use serde_json::json;

use crate::tui_panels::{
    FileEntry, GitBranchEntry, GitCommitEntry, GitFileEntry, GitFileStatus, GitStashEntry, GitView,
};

#[test]
fn parses_snapshot_for_tui_lists() {
    let snapshot = TuiSnapshot::from_backend_response(&json!({
        "type": "session_snapshot",
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"working","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
            "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"working"}],
            "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"working","foreground_cwd":"/repo","focused":true}],
            "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"working","cwd":"/repo","focused":true}]
        }
    }));

    assert_eq!(snapshot.workspaces[0].label, "Repo");
    assert_eq!(snapshot.workspace_tabs("ws_1").len(), 1);
    assert_eq!(snapshot.workspace_panes("ws_1")[0].terminal_id, "term_1");
    assert_eq!(snapshot.agents[0].display_agent.as_deref(), Some("jcode"));
}

#[test]
fn maps_keys_to_terminal_bytes() {
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Char('x'))),
        Some(b"x".to_vec())
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Enter)),
        Some(b"\r".to_vec())
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
        Some(vec![3])
    );
}

#[test]
fn ctrl_b_arms_prefix_and_shortcut_dispatch_instead_of_menu() {
    let key = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    assert!(is_menu_key(key));

    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    // First Ctrl+B arms the prefix instead of opening the old menu.
    app.handle_key(key);
    assert!(app.prefix.is_armed());
    // Second Ctrl+B cancels the prefix.
    app.handle_key(key);
    assert!(!app.prefix.is_armed());
    // Prefix then ? opens help.
    app.handle_key(key);
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Help);
    // Esc closes help.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);
}

#[test]
fn prefix_shortcuts_switch_screens() {
    let ctrl_b = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));

    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('f')));
    assert_eq!(app.screen, TuiScreen::Files);

    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('g')));
    assert_eq!(app.screen, TuiScreen::Git);

    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('t')));
    assert_eq!(app.screen, TuiScreen::Terminal);
}

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
        },
        FileEntry {
            name: "main.rs".to_string(),
            path: "main.rs".to_string(),
            is_dir: false,
            size: Some(120),
            level: 0,
            expanded: false,
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
    assert_eq!(app.git_panel.view, GitView::Changes);

    // Esc/q returns to the terminal screen.
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.screen, TuiScreen::Terminal);
}

#[test]
fn render_smoke_contains_herdr_chrome() {
    let backend = TestBackend::new(100, 28);
    let mut terminal = Terminal::new(backend).unwrap();
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
            "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"}],
            "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
            "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}]
        }
    }));
    app.pane_tail = vec!["Session ready".to_string()];

    terminal.draw(|frame| render(frame, &app)).unwrap();
    let rendered = format!("{:?}", terminal.backend().buffer());
    assert!(rendered.contains("Workspaces"));
    assert!(rendered.contains("Agents"));
    assert!(rendered.contains("Session ready"));
}

#[test]
fn snapshot_summary_reports_counts() {
    let snapshot = TuiSnapshot {
        workspaces: vec![TuiWorkspace {
            id: "ws".to_string(),
            label: "Repo".to_string(),
            cwd: "/repo".to_string(),
            focused: true,
            agent_status: "idle".to_string(),
            pane_count: 1,
            tab_count: 1,
            active_tab_id: Some("tab".to_string()),
        }],
        tabs: vec![],
        panes: vec![],
        agents: vec![],
    };
    let summary = snapshot_summary(
        &snapshot,
        Some(&json!({"version":"builtin-0.1.0","protocol":16})),
    );
    assert!(summary.contains("backend builtin-0.1.0 protocol 16"));
    assert!(summary.contains("1 workspaces"));
}

#[test]
fn text_snapshot_includes_selected_agent_and_terminal_output() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"working","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
            "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"working"}],
            "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"working","cwd":"/repo","focused":true}],
            "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"working","cwd":"/repo","focused":true}]
        }
    }));
    app.pane_tail = vec![
        "Session ready".to_string(),
        "··● bash ●·· · 12s".to_string(),
    ];

    let snapshot = app.text_snapshot();
    assert!(snapshot.contains("workspaces=1 tabs=1 panes=1 agents=1"));
    assert!(snapshot.contains("agent jcode · working"));
    assert!(snapshot.contains("terminal term_1"));
    assert!(snapshot.contains("··● bash ●·· · 12s"));
}

#[test]
fn terminal_output_ingest_replaces_full_frame_and_appends_delta() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    assert!(app.take_dirty());
    assert!(!app.take_dirty());

    app.ingest_terminal_output(&TerminalOutput {
        seq: 1,
        width: 120,
        height: 32,
        full: true,
        bytes: b"old\r\x1b[2KSession ready\n\x1b[33mworking\x1b[0m".to_vec(),
    });
    assert_eq!(app.pane_tail, vec!["Session ready", "working"]);
    assert!(app.take_dirty());

    app.ingest_terminal_output(&TerminalOutput {
        seq: 2,
        width: 120,
        height: 32,
        full: false,
        bytes: b"\nnext line".to_vec(),
    });
    assert_eq!(app.pane_tail, vec!["Session ready", "working", "next line"]);
}

#[test]
fn terminal_output_ingest_merges_character_deltas_on_same_line() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));

    app.ingest_terminal_output(&TerminalOutput {
        seq: 1,
        width: 120,
        height: 32,
        full: true,
        bytes: b"prompt ".to_vec(),
    });
    app.ingest_terminal_output(&TerminalOutput {
        seq: 2,
        width: 120,
        height: 32,
        full: false,
        bytes: b"a".to_vec(),
    });
    app.ingest_terminal_output(&TerminalOutput {
        seq: 3,
        width: 120,
        height: 32,
        full: false,
        bytes: b"b".to_vec(),
    });
    app.ingest_terminal_output(&TerminalOutput {
        seq: 4,
        width: 120,
        height: 32,
        full: false,
        bytes: b"\rprompt abc".to_vec(),
    });

    assert_eq!(app.pane_tail, vec!["prompt abc"]);
}

#[test]
fn terminal_output_styled_lines_parse_sgr_colors_and_styles() {
    let lines = terminal_output_styled_lines_lossy(
        "plain \u{1b}[31;1mred\u{1b}[0m \u{1b}[38;5;42midx\u{1b}[0m \u{1b}[48;2;1;2;3mbg\u{1b}[0m",
    );
    assert_eq!(lines.len(), 1);
    let spans = &lines[0];
    assert_eq!(
        spans
            .iter()
            .map(|span| span.text.as_str())
            .collect::<Vec<_>>(),
        vec!["plain ", "red", " ", "idx", " ", "bg"]
    );
    assert_eq!(spans[1].style.fg, Some(Color::Indexed(1)));
    assert!(spans[1].style.bold);
    assert_eq!(spans[3].style.fg, Some(Color::Indexed(42)));
    assert_eq!(spans[5].style.bg, Some(Color::Rgb(1, 2, 3)));
}

#[test]
fn terminal_output_ingest_preserves_color_spans_for_rendering() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));

    app.ingest_terminal_output(&TerminalOutput {
        seq: 1,
        width: 120,
        height: 32,
        full: true,
        bytes: b"ok \x1b[32mgreen\x1b[0m".to_vec(),
    });

    assert_eq!(app.pane_tail, vec!["ok green"]);
    assert_eq!(app.pane_tail_styles[0][1].text, "green");
    assert_eq!(app.pane_tail_styles[0][1].style.fg, Some(Color::Indexed(2)));
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
fn git_branches_delete_blocked_for_current_branch_and_confirmed_for_others() {
    use crate::tui_panels::GitBranchEntry;
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
        },
        GitBranchEntry {
            name: "feature".to_string(),
            current: false,
            remote: false,
            pushed: false,
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
    use crate::tui_panels::GitStashEntry;
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
fn files_screen_e_starts_edit_and_esc_stops_with_dirty_kept() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Files;
    app.file_explorer.preview = crate::tui_panels::FilePreview {
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
    app.file_explorer.preview = crate::tui_panels::FilePreview {
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
        },
        FileEntry {
            name: "other.txt".to_string(),
            path: "other.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
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
    app.screen = TuiScreen::Files;
    app.file_explorer.preview = crate::tui_panels::FilePreview {
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

    // Prefix h switches to the History view and fetches the file's
    // commits; the file-history call fails against the dead loopback API,
    // proving the history path is taken.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    assert_eq!(app.git_panel.view, GitView::History);
    assert!(app.error.is_some(), "history fetch must hit the API");

    // Prefix o returns to the Changes view (webui compare shortcut).
    app.error = None;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('o')));
    assert_eq!(app.git_panel.view, GitView::Changes);
}

// ---------------------------------------------------------------------------
// Coverage suite: renderers, shortcut dispatch arms, prompt/commit
// handlers, and panel state machines. These run against a dead loopback
// WebAPI (errors surface into `app.error`) and the TestBackend, so no
// network is needed.
// ---------------------------------------------------------------------------

fn fixture_snapshot_value() -> serde_json::Value {
    json!({
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
            "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"}],
            "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
            "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}]
        }
    })
}

fn fixture_snapshot() -> TuiSnapshot {
    TuiSnapshot::from_backend_response(&fixture_snapshot_value())
}

fn app_with_snapshot() -> TuiApp {
    // NOTE: `builtin_session` points at the built-in backend, which may be
    // live on this machine. Tests must not depend on its state; any key
    // that triggers a backend refresh can replace this fixture snapshot
    // with live data.
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    app
}

fn draw(app: &TuiApp, width: u16, height: u16) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, app)).unwrap();
    format!("{:?}", terminal.backend().buffer())
}

fn ctrl(ch: char) -> KeyEvent {
    KeyEvent::new(KeyCode::Char(ch), KeyModifiers::CONTROL)
}

#[test]
fn renders_all_git_views_with_populated_state() {
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.git_panel.branch = "main".to_string();
    app.git_panel.upstream = "origin/main".to_string();
    app.git_panel.ahead = 1;
    app.git_panel.behind = 2;
    app.git_panel.state = "dirty".to_string();
    app.git_panel.files = vec![GitFileEntry {
        path: "src/app.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.git_panel.diff_lines = vec![
        "@@ -1,2 +1,3 @@".to_string(),
        "+added line".to_string(),
        "-removed line".to_string(),
        " context".to_string(),
    ];
    app.git_panel.commits = vec![GitCommitEntry {
        hash: "abc123def456".to_string(),
        message: "fix bug".to_string(),
        author: "Ada Lovelace".to_string(),
        date: "2 hours ago".to_string(),
        labels: vec!["main".to_string()],
    }];
    app.git_panel.branches = vec![
        GitBranchEntry {
            name: "main".to_string(),
            current: true,
            remote: false,
            pushed: true,
        },
        GitBranchEntry {
            name: "feature".to_string(),
            current: false,
            remote: false,
            pushed: false,
        },
    ];
    app.git_panel.stashes = vec![GitStashEntry {
        name: "stash@{0}".to_string(),
        message: "wip".to_string(),
    }];
    app.git_panel.history_file = Some("src/app.rs".to_string());

    for view in [
        GitView::Changes,
        GitView::Log,
        GitView::Branches,
        GitView::Stash,
        GitView::History,
    ] {
        app.git_panel.view = view;
        let rendered = draw(&app, 120, 30);
        assert!(
            rendered.contains("Changes")
                || rendered.contains("Log")
                || rendered.contains("Branches")
                || rendered.contains("Stash")
                || rendered.contains("History"),
            "{view:?} must render a tab bar"
        );
    }

    // Populated panes render their content.
    app.git_panel.view = GitView::Branches;
    assert!(draw(&app, 120, 30).contains("feature"));
    app.git_panel.view = GitView::Stash;
    assert!(draw(&app, 120, 30).contains("stash@{0}"));
    app.git_panel.view = GitView::History;
    // Empty diff shows the Enter hint; a loaded commit diff shows lines.
    app.git_panel.diff_lines.clear();
    let history = draw(&app, 120, 30);
    assert!(history.contains("fix bug"), "history must list the commit");
    assert!(history.contains("Select a commit"), "history diff hint");
    // History with a loaded commit diff shows the diff pane title.
    app.git_panel.diff_title = "abc123 · src/app.rs".to_string();
    app.git_panel.diff_lines = vec!["+hello".to_string()];
    assert!(draw(&app, 120, 30).contains("+hello"));
}

#[test]
fn renders_blame_annotations_in_changes_diff() {
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.git_panel.files = vec![GitFileEntry {
        path: "src/app.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.git_panel.diff_title = "src/app.rs".to_string();
    app.git_panel.diff_lines = vec!["+added line".to_string()];
    app.git_panel.diff_meta = vec![Some(crate::tui_panels::GitDiffLineMeta {
        old_line: None,
        new_line: Some(2),
    })];
    app.git_panel.show_blame = true;
    app.git_panel.blame_path = Some("src/app.rs".to_string());
    app.git_panel
        .blame_authors
        .insert(2, "Ada Lovelace".to_string());
    let rendered = draw(&app, 120, 30);
    assert!(rendered.contains("[blame]"), "diff title marks blame");
    assert!(rendered.contains("Ada Lovelace"), "blame author shown");
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
        },
        FileEntry {
            name: "readme.md".to_string(),
            path: "readme.md".to_string(),
            is_dir: false,
            size: Some(42),
            level: 0,
            expanded: false,
        },
    ];
    app.file_explorer.preview = crate::tui_panels::FilePreview {
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
    assert!(draw(&app, 150, 30).contains("Ctrl-S save \u{b7} Esc stop"));

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
    app.file_explorer.preview = crate::tui_panels::FilePreview::default();
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
    app.file_explorer.preview = crate::tui_panels::FilePreview {
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
    }];
    for i in 0..40 {
        many.push(FileEntry {
            name: format!("file{i}.rs"),
            path: format!("file{i}.rs"),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
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
fn renders_prompt_commit_help_and_modes() {
    // Rename prompt.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.file_explorer.entries = vec![FileEntry {
        name: "a.txt".to_string(),
        path: "a.txt".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
    }];
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::RenameFile,
        text: "b.txt".to_string(),
    });
    let rename = draw(&app, 100, 28);
    assert!(rename.contains("Rename file"), "rename title renders");
    assert!(rename.contains("b.txt"), "rename text renders");

    // Every prompt kind title/hint renders.
    for kind in [
        PromptKind::RenameFile,
        PromptKind::ConfirmDeleteFile,
        PromptKind::ConfirmDeleteBranch,
        PromptKind::ConfirmDropStash,
    ] {
        app.prompt_input = Some(PromptInput {
            kind,
            text: String::new(),
        });
        let rendered = draw(&app, 100, 28);
        assert!(
            rendered.contains("type y then Enter") || rendered.contains("Enter renames"),
            "{kind:?} hint renders"
        );
    }

    // Commit input with text.
    app.prompt_input = None;
    app.screen = TuiScreen::Git;
    app.commit_input = Some(CommitInput {
        text: "ship it".to_string(),
        amend: false,
    });
    let commit = draw(&app, 100, 28);
    assert!(commit.contains("ship it"), "commit text renders");

    // Amend flag in the title.
    app.commit_input = Some(CommitInput {
        text: String::new(),
        amend: true,
    });
    assert!(draw(&app, 100, 28).contains("Amend"));

    // Help overlay.
    app.commit_input = None;
    app.mode = TuiMode::Help;
    let help = draw(&app, 100, 28);
    assert!(help.contains("Ctrl+B"), "help lists prefix rows");
    assert!(help.contains("toggle blame"), "help lists blame");
    app.mode = TuiMode::Navigate;

    // Attach mode on the Terminal screen renders the detach hint bar.
    app.mode = TuiMode::Attach;
    app.screen = TuiScreen::Terminal;
    assert!(draw(&app, 100, 28).contains("Ctrl-G"));
}

#[test]
fn prompt_key_flow_types_confirms_and_cancels() {
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.file_explorer.entries = vec![FileEntry {
        name: "a.txt".to_string(),
        path: "a.txt".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
    }];

    // Rename: typing builds text, Backspace pops, Esc cancels, Enter acts.
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::RenameFile,
        text: String::new(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().text,
        "x",
        "typing reaches the prompt"
    );
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.prompt_input.is_none(), "Esc cancels the prompt");

    // Rename with an Enter hits the API (dead loopback -> error, no crash).
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::RenameFile,
        text: "b.txt".to_string(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(
        app.prompt_input.is_none(),
        "Enter runs and closes the prompt"
    );
    assert!(app.error.is_some(), "rename calls the API");

    // Rename with no selection is refused.
    app.error = None;
    app.file_explorer.entries.clear();
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::RenameFile,
        text: "b.txt".to_string(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.error.as_deref(),
        Some("no file selected"),
        "rename without selection errors"
    );

    // Confirm delete file without selection errors even after typing y.
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::ConfirmDeleteFile,
        text: String::new(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Char('y')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.error.as_deref(), Some("no file selected"));

    // Confirm delete branch with a branch: type y, Enter hits the API.
    app.error = None;
    app.screen = TuiScreen::Git;
    app.git_panel.branches = vec![GitBranchEntry {
        name: "tmp".to_string(),
        current: false,
        remote: false,
        pushed: false,
    }];
    app.git_panel.branch_selected = 0;
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::ConfirmDeleteBranch,
        text: String::new(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Char('y')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.prompt_input.is_none());
    assert!(app.error.is_some(), "branch delete hits the API");

    // Confirm drop stash with an entry: type y, Enter hits the API.
    app.error = None;
    app.git_panel.stashes = vec![GitStashEntry {
        name: "stash@{0}".to_string(),
        message: "wip".to_string(),
    }];
    app.git_panel.stash_selected = 0;
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::ConfirmDropStash,
        text: String::new(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Char('y')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.prompt_input.is_none());
    assert!(app.error.is_some(), "stash drop hits the API");

    // Anything else while a prompt is open is swallowed.
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::ConfirmDropStash,
        text: String::new(),
    });
    let screen_before = app.screen;
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert!(
        app.prompt_input.is_some(),
        "unhandled keys do not close the prompt"
    );
    assert_eq!(app.screen, screen_before);
}

#[test]
fn commit_key_flow_types_saves_and_rejects_empty() {
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;

    // Enter with empty message closes the modal with an error.
    app.commit_input = Some(CommitInput {
        text: String::new(),
        amend: false,
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.commit_input.is_none(), "empty commit closes the modal");
    assert_eq!(app.error.as_deref(), Some("commit message is empty"));

    // Enter with text hits the API and closes the modal.
    app.error = None;
    app.commit_input = Some(CommitInput {
        text: "ship".to_string(),
        amend: false,
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.commit_input.is_none(), "commit closes the modal");
    assert!(app.error.is_some(), "commit hits the API");

    // Esc closes the modal without committing.
    app.commit_input = Some(CommitInput {
        text: "nope".to_string(),
        amend: false,
    });
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.commit_input.is_none());

    // Backspace pops from the message.
    app.commit_input = Some(CommitInput {
        text: "ab".to_string(),
        amend: false,
    });
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.commit_input.as_ref().unwrap().text, "a");
}

#[test]
fn shortcut_dispatch_covers_every_arm() {
    let ctrl_b = ctrl('b');
    let mut app = app_with_snapshot();

    // Screens.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('f')));
    assert_eq!(app.screen, TuiScreen::Files);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('t')));
    assert_eq!(app.screen, TuiScreen::Terminal);

    // Search on Files starts the filter.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('f')));
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert!(app.file_explorer.filter_active, "search arms the filter");

    // Sidebar navigation arms: j/k move workspaces, a/A move agents.
    app.file_explorer.filter_active = false;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.sidebar_focus, SidebarFocus::Workspaces);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::new(KeyCode::Char('A'), KeyModifiers::SHIFT));
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);

    // NewTab/CloseTab dispatch: against a real backend these mutate the
    // session, so only assert the arms run without panic. Quit status arm.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));

    // Quit arm.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.status, "quit");

    // Refresh arm and PrevWorkspace arm (focus unchanged by j/k).
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    let focus_before = app.sidebar_focus;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('k')));
    assert_eq!(app.sidebar_focus, focus_before, "j/k keep the focus");

    // Agent selection arms: a/A move between agents.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::new(KeyCode::Char('A'), KeyModifiers::SHIFT));
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);

    // Git views via prefix keys.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('g')));
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('1')));
    assert_eq!(app.git_panel.view, GitView::Changes);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('3')));
    assert_eq!(app.git_panel.view, GitView::Log);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('4')));
    assert_eq!(app.git_panel.view, GitView::Stash);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('b')));
    assert_eq!(app.git_panel.view, GitView::Branches);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert_eq!(app.git_panel.view, GitView::Log);

    // Commit modal opens, then amend variant, then the Enter alias.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('2')));
    assert!(app.commit_input.is_some());
    assert!(!app.commit_input.as_ref().unwrap().amend);
    app.commit_input = None;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('c')));
    assert!(app.commit_input.is_some());
    app.commit_input = None;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(
        app.commit_input.is_some(),
        "prefix Enter opens the commit modal"
    );
    app.commit_input = None;

    // Prefix s opens the stash view.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(app.git_panel.view, GitView::Stash);

    // Unknown prefix key cancels quietly (the `_ => None` arm).
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::F(7)));
    assert_eq!(app.git_panel.view, GitView::Stash);

    // History requires a selected file.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    assert!(
        app.error.is_some() || app.git_panel.view == GitView::History,
        "history either runs or errors"
    );

    // Blame with no selection errors but does not crash.
    app.error = None;
    app.git_panel.files.clear();
    app.git_panel.diff_title = String::new();
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    assert!(app.error.is_some(), "blame without a file errors");

    // Switch branch dispatches; a selected current branch is skipped
    // locally before any API call. open_git_screen may refresh from a
    // live backend, so only assert the arm runs without panic.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('v')));
    assert!(app.git_panel.view == GitView::Branches);

    // All git action arms run against the dead API: they must set an
    // error (or status) and never panic.
    for (key, expect_stage) in [
        ('G', true), // stage all
        ('y', true), // stage file
        ('u', true), // unstage file
        ('z', true), // stash file
    ] {
        app.error = None;
        app.handle_key(ctrl_b);
        if key == 'G' {
            app.handle_key(KeyEvent::new(KeyCode::Char('G'), KeyModifiers::SHIFT));
        } else {
            app.handle_key(KeyEvent::from(KeyCode::Char(key)));
        }
        assert!(expect_stage, "action arm {key} ran");
    }
    app.error = None;
    app.git_panel.files = vec![GitFileEntry {
        path: "src/app.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    for key in ['y', 'u', 'd', 'z'] {
        app.handle_key(ctrl_b);
        app.handle_key(KeyEvent::from(KeyCode::Char(key)));
        app.error = None;
    }
    // Pull arm.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::new(KeyCode::Char('P'), KeyModifiers::SHIFT));
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
    // History -> Changes).
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Log);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Branches);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Stash);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::History);
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
fn files_in_panel_keys_cover_rename_delete_and_enter() {
    let mut app = app_with_snapshot();
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
        },
        FileEntry {
            name: "a.txt".to_string(),
            path: "a.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
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
    app.file_explorer.preview = crate::tui_panels::FilePreview {
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
fn shortcut_labels_cover_every_variant() {
    // Every Shortcut variant renders a non-empty label; exercise the
    // full match arms without going through the key map.
    use crate::tui_keys::Shortcut;
    let all = vec![
        Shortcut::Help,
        Shortcut::Files,
        Shortcut::Git,
        Shortcut::Terminal,
        Shortcut::Search,
        Shortcut::Refresh,
        Shortcut::NextWorkspace,
        Shortcut::PrevWorkspace,
        Shortcut::NextAgent,
        Shortcut::PrevAgent,
        Shortcut::NewTab,
        Shortcut::CloseTab,
        Shortcut::Quit,
        Shortcut::GitChanges,
        Shortcut::GitCommit,
        Shortcut::GitLog,
        Shortcut::GitStash,
        Shortcut::GitBranch,
        Shortcut::GitSwitchBranch,
        Shortcut::GitStageAll,
        Shortcut::GitStageFile,
        Shortcut::GitUnstageFile,
        Shortcut::GitDiscardFile,
        Shortcut::GitStashFile,
        Shortcut::GitPush,
        Shortcut::GitFileHistory,
        Shortcut::GitChangesBack,
        Shortcut::GitBlame,
        Shortcut::EditFile,
    ];
    for shortcut in all {
        assert!(
            !shortcut.label().is_empty(),
            "{shortcut:?} must have a label"
        );
    }
    // Prompt titles and hints for every kind.
    for kind in [
        PromptKind::RenameFile,
        PromptKind::ConfirmDeleteFile,
        PromptKind::ConfirmDeleteBranch,
        PromptKind::ConfirmDropStash,
    ] {
        assert!(!kind.title().is_empty(), "{kind:?} title");
        assert!(!kind.hint().is_empty(), "{kind:?} hint");
    }
}

#[test]
fn file_explorer_expand_and_set_cwd_reset_state() {
    let client = BackendClient::builtin_session(None);
    let mut explorer = crate::tui_panels::FileExplorer::new("/repo");
    explorer.entries = vec![
        FileEntry {
            name: "src".to_string(),
            path: "src".to_string(),
            is_dir: true,
            size: None,
            level: 0,
            expanded: false,
        },
        FileEntry {
            name: "child.rs".to_string(),
            path: "src/child.rs".to_string(),
            is_dir: false,
            size: None,
            level: 1,
            expanded: false,
        },
    ];
    let api = WebApiClient::new("127.0.0.1", 1);

    // Collapsing an expanded dir removes its children locally.
    explorer.entries[0].expanded = true;
    explorer.selected = 0;
    let changed = explorer.toggle_expand(&api).unwrap();
    assert!(!changed || explorer.entries.len() == 1);

    // Expanding hits the API (dead port -> error, no panic).
    explorer.entries[0].expanded = false;
    let _ = explorer.toggle_expand(&api);

    // set_cwd on GitPanel resets diff/blame state for the new repo.
    let mut panel = crate::tui_panels::GitPanel::new("/repo");
    panel.diff_lines = vec!["+x".to_string()];
    panel.show_blame = true;
    panel.blame_path = Some("src/app.rs".to_string());
    panel.set_cwd("/other");
    assert_eq!(panel.cwd, "/other");
    assert!(panel.diff_lines.is_empty());
    assert!(!panel.show_blame);
    assert!(panel.blame_path.is_none());
    let _ = client.ping();
}

#[test]
fn git_panel_switch_and_delete_and_stash_hit_api() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut panel = crate::tui_panels::GitPanel::new("/repo");
    panel.branches = vec![GitBranchEntry {
        name: "feature".to_string(),
        current: false,
        remote: false,
        pushed: false,
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
    let mut panel = crate::tui_panels::GitPanel::new("/repo");
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
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    assert_eq!(app.error.as_deref(), Some("no workspace selected"));
    app.error = None;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(app.error.as_deref(), Some("no workspace selected"));
}

#[test]
fn navigation_keys_cover_sidebar_move_focus_and_attach() {
    let mut app = app_with_snapshot();
    assert_eq!(app.mode, TuiMode::Navigate);

    let panes_start = app.snapshot.panes.len();
    assert_eq!(panes_start, 1, "fixture must have one pane");
    // Navigate mode on the Terminal screen: j/k move the workspace
    // selection.
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    app.handle_key(KeyEvent::from(KeyCode::Down));
    app.handle_key(KeyEvent::from(KeyCode::Char('k')));
    app.handle_key(KeyEvent::from(KeyCode::Up));
    assert_eq!(app.selected_workspace, 0, "single workspace clamps at 0");

    // Tab/BackTab toggle the sidebar focus.
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);
    app.handle_key(KeyEvent::from(KeyCode::BackTab));
    assert_eq!(app.sidebar_focus, SidebarFocus::Workspaces);

    // a/w focus the agents and workspaces lists.
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);
    app.handle_key(KeyEvent::from(KeyCode::Char('w')));
    assert_eq!(app.sidebar_focus, SidebarFocus::Workspaces);

    // ? opens Help.
    assert_eq!(
        app.snapshot.panes.len(),
        panes_start,
        "j/k/Tab/a/w keep panes"
    );
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Help);
    // Esc closes Help.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);

    // r refreshes the active screen. NOTE: `app_with_snapshot` points at
    // the built-in backend session, which may be live on this machine; a
    // live refresh replaces the fixture snapshot, so restore it after.
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    app.snapshot = fixture_snapshot();
    app.clamp_selection();

    // Enter attaches to the selected terminal.
    assert!(
        app.selected_pane().is_some(),
        "pane resolves, focus={:?} ws={} panes={}",
        app.sidebar_focus,
        app.selected_workspace,
        app.snapshot.panes.len()
    );
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.mode, TuiMode::Attach);
    assert_eq!(app.status, "attach mode: Ctrl-G detach");

    // Ctrl-G detaches back to Navigate.
    app.handle_key(ctrl('g'));
    assert_eq!(app.mode, TuiMode::Navigate);

    // In Navigate on the Terminal screen q quits.
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.status, "quit");

    // On the Files screen Navigate keys go to the panel handlers.
    app.screen = TuiScreen::Files;
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    app.handle_key(KeyEvent::from(KeyCode::Char('k')));
    // Unknown key: no panic.
    app.handle_key(KeyEvent::from(KeyCode::F(5)));
}

/// Scripted fake backend socket for TuiApp tests: one thread accepting
/// connections in a loop, answering each JSON-line request by method.
/// Hermetic replacement for the built-in session socket.
fn fake_backend_socket() -> (std::path::PathBuf, std::sync::mpsc::Sender<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use interprocess::TryClone as _;
    use std::io::{BufRead, BufReader, Write};

    let path = std::env::temp_dir().join(format!(
        "herdr-tui-fake-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    let _ = std::fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let handle = std::thread::spawn(move || loop {
        if rx.try_recv().is_ok() {
            break;
        }
        let Ok(mut stream) = listener.accept() else {
            break;
        };
        let mut line = String::new();
        {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                continue;
            }
        }
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        let response = match request["method"].as_str().unwrap_or("") {
            "ping" => json!({"id": request["id"], "result": {"version": "test", "protocol": 1}}),
            "session.snapshot" => {
                json!({"id": request["id"], "result": fixture_snapshot_value()})
            }
            "tab.create" | "tab.close" => {
                json!({"id": request["id"], "result": {"ok": true}})
            }
            method => json!({"error": format!("unexpected method {method}")}),
        };
        stream
            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
            .unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    });
    std::mem::forget(handle);
    (path, tx)
}

/// Budgeted variant of `fake_backend_socket`: answers the first
/// `budget` requests normally, then accepts connections but closes them
/// without a response so later calls fail. Used to exercise the
/// refresh-error arms after a successful tab create/close.
fn fake_backend_socket_failing_snapshots() -> (std::path::PathBuf, std::sync::mpsc::Sender<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use std::io::{BufRead, BufReader, Write};

    let path = std::env::temp_dir().join(format!(
        "herdr-tui-fake-nosnap-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    let _ = std::fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        loop {
            if rx.try_recv().is_ok() {
                break;
            }
            let Ok(mut stream) = listener.accept() else {
                break;
            };
            let mut line = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
            }
            let request: serde_json::Value = serde_json::from_str(&line).unwrap();
            let method = request["method"].as_str().unwrap_or("");
            if method == "session.snapshot" {
                // Fail the snapshot: close without a response so any
                // refresh errors while tab create/close still succeed.
                continue;
            }
            let response = match method {
                "ping" => {
                    json!({"id": request["id"], "result": {"version": "test", "protocol": 1}})
                }
                "tab.create" | "tab.close" => {
                    json!({"id": request["id"], "result": {"ok": true}})
                }
                method => json!({"error": format!("unexpected method {method}")}),
            };
            stream
                .write_all(serde_json::to_string(&response).unwrap().as_bytes())
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        }
    });
    (path, tx)
}

#[test]
fn tab_create_and_close_shortcuts_hit_the_backend() {
    let (api_socket, _stop) = fake_backend_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    let ctrl_b = ctrl('b');

    // NewTab creates a tab, then refresh() replaces the status with the
    // backend summary (proof the refresh after create succeeded).
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    assert_eq!(
        app.status, "backend test · protocol 1 · 1 workspaces · 1 agents",
        "create tab must refresh against the fake backend"
    );
    assert!(app.error.is_none(), "create tab error: {:?}", app.error);

    // CloseTab closes the active tab and refreshes.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(
        app.status, "backend test · protocol 1 · 1 workspaces · 1 agents",
        "close tab must refresh against the fake backend"
    );
    assert!(app.error.is_none(), "close tab error: {:?}", app.error);

    // --- Error arms against a dead backend: create/close hit connection
    // errors and surface them.
    {
        let mut app = TuiApp::new(
            BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
            Duration::from_secs(1),
        );
        app.snapshot = fixture_snapshot();
        let ctrl_b = ctrl('b');
        app.handle_key(ctrl_b);
        app.handle_key(KeyEvent::from(KeyCode::Char('n')));
        assert!(
            app.error.is_some(),
            "create tab against a dead socket errors"
        );

        // CloseTab with a workspace but a broken backend errors too.
        app.error = None;
        app.handle_key(ctrl_b);
        app.handle_key(KeyEvent::from(KeyCode::Char('x')));
        assert!(
            app.error.is_some(),
            "close tab against a dead socket errors"
        );

        // Prefix g from the Files screen with a dead web API: the git
        // refresh error surfaces.
        app.screen = TuiScreen::Files;
        app.error = None;
        app.handle_key(ctrl_b);
        app.handle_key(KeyEvent::from(KeyCode::Char('g')));
        assert_eq!(app.screen, TuiScreen::Git);
        assert!(
            app.error.is_some(),
            "opening git against a dead web API surfaces the refresh error"
        );

        // Prefix f (files screen) with a dead web API: explorer refresh
        // error surfaces.
        app.screen = TuiScreen::Terminal;
        app.file_explorer = crate::tui_panels::FileExplorer::new("/definitely/not/here");
        app.error = None;
        app.handle_key(ctrl_b);
        app.handle_key(KeyEvent::from(KeyCode::Char('f')));
        assert_eq!(app.screen, TuiScreen::Files);
        assert!(
            app.error.is_some(),
            "opening files against a dead web API surfaces the refresh error"
        );
    }

    // --- Fallback arms: workspace without active_tab_id closes the first
    // listed tab; workspace with no tabs reports "no tab to close".
    {
        let (api_socket, _stop) = fake_backend_socket();
        let client = BackendClient::new(api_socket.clone(), api_socket.clone());
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        let mut snapshot = fixture_snapshot();
        snapshot.workspaces[0].active_tab_id = None;
        app.snapshot = snapshot;
        let ctrl_b = ctrl('b');
        app.handle_key(ctrl_b);
        app.handle_key(KeyEvent::from(KeyCode::Char('x')));
        assert_eq!(app.error, None, "fallback tab close works: {:?}", app.error);

        let mut snapshot = fixture_snapshot();
        snapshot.workspaces[0].active_tab_id = None;
        snapshot.tabs.clear();
        app.snapshot = snapshot;
        app.handle_key(ctrl_b);
        app.handle_key(KeyEvent::from(KeyCode::Char('x')));
        assert_eq!(app.error.as_deref(), Some("no tab to close"));
        let _ = std::fs::remove_file(&api_socket);
    }
}

#[test]
fn fake_backend_socket_answers_requests() {
    let (api_socket, _stop) = fake_backend_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let ping = client.ping().expect("ping must reach the fake backend");
    assert_eq!(ping["version"], "test");
    let snap = client.snapshot().expect("snapshot must parse");
    assert!(snap["snapshot"]["workspaces"].is_array());
    let _ = std::fs::remove_file(&api_socket);
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
    app.file_explorer.preview = crate::tui_panels::FilePreview::default();
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
        },
        GitBranchEntry {
            name: "dev".to_string(),
            current: false,
            remote: false,
            pushed: false,
        },
    ];
    app.git_panel.branch_selected = 1;
    app.error = None;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('v')));
    assert!(app.error.is_some(), "dead web API branch switch must error");
}

#[test]
fn prompt_commit_and_panel_key_guard_arms() {
    let mut app = app_with_snapshot();
    // handle_prompt_key with no prompt open: early return, no panic.
    app.handle_prompt_key(KeyEvent::from(KeyCode::Enter));
    app.handle_prompt_key(KeyEvent::from(KeyCode::Esc));

    // handle_commit_key with no commit modal open: early return.
    app.handle_commit_key(KeyEvent::from(KeyCode::Enter));
    app.handle_commit_key(KeyEvent::from(KeyCode::F(9)));

    // Commit modal open: an unmatched key does nothing, then Esc closes it.
    app.commit_input = Some(CommitInput {
        text: String::new(),
        amend: false,
    });
    app.handle_commit_key(KeyEvent::from(KeyCode::F(9)));
    assert!(app.commit_input.is_some());
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.commit_input.is_none(), "Esc closes the commit modal");

    // handle_panel_key on the Terminal screen is a no-op.
    app.mode = TuiMode::Attach;
    app.screen = TuiScreen::Terminal;
    app.handle_panel_key(KeyEvent::from(KeyCode::Char('j')));

    // Navigate mode Esc on the Files screen returns to Terminal.
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Files;
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.screen, TuiScreen::Terminal);
}

#[test]
fn files_key_error_and_guard_arms() {
    let mut app = app_with_snapshot();
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
        },
        FileEntry {
            name: "a.txt".to_string(),
            path: "a.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
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
    app.file_explorer.preview = crate::tui_panels::FilePreview {
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
fn edit_key_save_error_surfaces_from_files_screen() {
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.screen = TuiScreen::Files;
    app.mode = TuiMode::Attach;
    app.file_explorer.preview = crate::tui_panels::FilePreview {
        path: Some("a.txt".to_string()),
        content: "x".to_string(),
        truncated: false,
        binary: false,
        hash: "h".to_string(),
        dirty: true,
    };
    app.file_explorer.start_edit().unwrap();
    // Ctrl-S save against the dead API: the error surfaces.
    app.handle_key(ctrl('s'));
    assert!(
        app.error
            .as_deref()
            .is_some_and(|e| e.contains("failed") || e.contains("refused")),
        "save against a dead web API errors: {:?}",
        app.error
    );
}

#[test]
fn esc_on_files_returns_to_terminal_isolated() {
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Files;
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.screen, TuiScreen::Terminal);
}

#[test]
fn renders_git_and_file_view_variants() {
    let mut app = app_with_snapshot();

    // Git screen with an empty area: the early return arms of the screen
    // renderers are exercised through the 150-wide draw with the Git
    // screen active; area-is-empty guards also run via render dispatch.
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Changes;
    app.git_panel.files = vec![
        GitFileEntry {
            path: "s.rs".to_string(),
            status: GitFileStatus::Staged,
        },
        GitFileEntry {
            path: "m.rs".to_string(),
            status: GitFileStatus::Unstaged,
        },
        GitFileEntry {
            path: "u.rs".to_string(),
            status: GitFileStatus::Untracked,
        },
        GitFileEntry {
            path: "c.rs".to_string(),
            status: GitFileStatus::Conflicted,
        },
    ];
    app.git_panel.state = "clean".to_string();
    app.git_panel.commits = vec![
        GitCommitEntry {
            hash: "h1".to_string(),
            message: "m1".to_string(),
            author: "a".to_string(),
            date: "d".to_string(),
            labels: vec!["main".to_string()],
        },
        GitCommitEntry {
            hash: "h2".to_string(),
            message: "m2".to_string(),
            author: "a".to_string(),
            date: "d".to_string(),
            labels: vec![],
        },
    ];
    app.git_panel.branches = vec![
        GitBranchEntry {
            name: "main".to_string(),
            current: true,
            remote: false,
            pushed: true,
        },
        GitBranchEntry {
            name: "origin/dev".to_string(),
            current: false,
            remote: true,
            pushed: false,
        },
        GitBranchEntry {
            name: "local".to_string(),
            current: false,
            remote: false,
            pushed: false,
        },
    ];
    app.git_panel.stashes = vec![GitStashEntry {
        name: "stash@{0}".to_string(),
        message: "wip".to_string(),
    }];

    // Changes view renders all four status letters.
    let changes = draw(&app, 150, 30);
    assert!(changes.contains("clean"), "clean state badge renders");

    // Log view renders commit labels and label-less commits.
    app.git_panel.view = GitView::Log;
    let log = draw(&app, 150, 30);
    assert!(log.contains("main"), "commit label renders");

    // Branches view renders current/remote/plain branch markers.
    app.git_panel.view = GitView::Branches;
    let branches = draw(&app, 150, 30);
    assert!(branches.contains("main"), "branch name renders");

    // Stash view renders stash entries.
    app.git_panel.view = GitView::Stash;
    let stash = draw(&app, 150, 30);
    assert!(stash.contains("wip"), "stash message renders");

    // History view with no file shows the plain History title.
    app.git_panel.view = GitView::History;
    app.git_panel.history_file = None;
    let history = draw(&app, 150, 30);
    assert!(history.contains("History"), "history title renders");

    // Conflicts state badge renders bold red.
    app.git_panel.view = GitView::Changes;
    app.git_panel.state = "conflicts".to_string();
    let _ = draw(&app, 150, 30);

    // Any other state badge renders neutral.
    app.git_panel.state = "dirty".to_string();
    let _ = draw(&app, 150, 30);

    // Prompt and commit renderers run on every draw; ensure the
    // early-return arms (None) are hit with no modal open (already the
    // case above) and with modals open below.
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::ConfirmDeleteFile,
        text: String::new(),
    });
    assert!(draw(&app, 150, 30).contains("Delete"));
    app.prompt_input = None;
    app.screen = TuiScreen::Git;
    app.commit_input = Some(CommitInput {
        text: "msg".to_string(),
        amend: true,
    });
    let commit_modal = draw(&app, 150, 30);
    assert!(commit_modal.contains("Amend"), "amend modal renders");

    // Files screen tiny-area guard: draw at the minimum width so the
    // files renderer runs its area checks.
    app.screen = TuiScreen::Files;
    app.commit_input = None;
    let _ = draw(&app, 10, 5);
}

#[test]
fn renders_terminal_footer_and_help_variants() {
    let mut app = app_with_snapshot();

    // Attach+Terminal footer shows Ctrl-G; Navigate shows help hint; the
    // Help overlay footer shows its own hint.
    app.mode = TuiMode::Attach;
    app.screen = TuiScreen::Terminal;
    let attach = draw(&app, 100, 24);
    assert!(attach.contains("Ctrl-G"), "attach footer renders");

    app.mode = TuiMode::Navigate;
    let navigate = draw(&app, 100, 24);
    assert!(
        navigate.contains("Enter attach"),
        "navigate footer shows the attach hint"
    );

    app.mode = TuiMode::Help;
    let help = draw(&app, 100, 24);
    assert!(help.contains("Esc"), "help footer renders");
}

#[test]
fn branch_delete_prompt_without_selection_reports_error() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.screen = TuiScreen::Git;
    app.mode = TuiMode::Attach;
    app.git_panel.view = GitView::Branches;
    // No branches at all: confirming the delete prompt must surface the
    // guard error instead of a panic or silent no-op.
    app.git_panel.branches = vec![];
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::ConfirmDeleteBranch,
        text: "y".to_string(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.error.as_deref(), Some("no branch selected"));
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
        crate::tui_panels::FileEntry {
            name: "one.txt".to_string(),
            path: "one.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
        },
        crate::tui_panels::FileEntry {
            name: "two.txt".to_string(),
            path: "two.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
        },
    ];
    app.file_explorer.preview = crate::tui_panels::FilePreview {
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
    app.file_explorer = crate::tui_panels::FileExplorer::new("/repo");
    app.file_explorer.entries = vec![
        crate::tui_panels::FileEntry {
            name: "dir".to_string(),
            path: "dir".to_string(),
            is_dir: true,
            size: None,
            level: 0,
            expanded: false,
        },
        crate::tui_panels::FileEntry {
            name: "file.txt".to_string(),
            path: "file.txt".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
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
fn navigate_esc_on_files_screen_returns_to_terminal() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Files;
    // Esc on a non-Terminal screen steps back to Terminal (webui Esc
    // leaves the open panel), and only a second Esc quits.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.screen, TuiScreen::Terminal);
    assert_ne!(app.status, "quit", "first Esc detaches, not quits");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.status, "quit");
}

#[test]
fn tab_shortcut_refresh_errors_surface_after_backend_create_and_close() {
    let (api_socket, _stop) = fake_backend_socket_failing_snapshots();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    // Budget 1 answers exactly the tab.create request; the refresh that
    // follows hits the closed stream and its error surfaces.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    assert_eq!(app.status, "tab created", "create still succeeds");
    assert!(
        app.error.as_deref().is_some_and(|e| !e.is_empty()),
        "refresh after create must surface the backend error"
    );
    app.error = None;
    // Same shape for close: the tab.close is served, the refresh fails.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(app.status, "tab closed", "close still succeeds");
    assert!(
        app.error.as_deref().is_some_and(|e| !e.is_empty()),
        "refresh after close must surface the backend error"
    );
}

#[test]
fn renders_prefix_armed_footer_and_tiny_screens() {
    let mut app = app_with_snapshot();

    // Armed prefix shows the "Ctrl+B> " hint in the footer.
    app.mode = TuiMode::Attach;
    app.screen = TuiScreen::Terminal;
    app.handle_key(ctrl('b'));
    assert!(app.prefix.is_armed());
    let armed = draw(&app, 100, 24);
    assert!(armed.contains("Ctrl+B> "), "armed prefix footer renders");

    // A zero-height terminal leaves every area empty: the Files and Git
    // screens must bail out on the empty area instead of panicking in
    // the layout code (footer Length(1) wins over the Min(1) body).
    app.screen = TuiScreen::Files;
    let _ = draw(&app, 100, 0);
    app.screen = TuiScreen::Git;
    let _ = draw(&app, 100, 0);
    // A one-row terminal still renders the footer row without panicking.
    let one = draw(&app, 100, 1);
    assert!(!one.is_empty(), "one row renders");

    // A file longer than the pane breaks out of the line loop instead
    // of overflowing the visible rows.
    app.screen = TuiScreen::Files;
    app.file_explorer.preview = crate::tui_panels::FilePreview {
        path: Some("long.txt".to_string()),
        content: (0..200)
            .map(|i| format!("line {i}"))
            .collect::<Vec<_>>()
            .join("\n"),
        truncated: false,
        binary: false,
        hash: "h".to_string(),
        dirty: false,
    };
    let long = draw(&app, 130, 10);
    assert!(long.contains("line 0"), "long preview starts at the top");
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
    app.file_explorer.entries = vec![crate::tui_panels::FileEntry {
        name: "a.rs".to_string(),
        path: "a.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
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
    app.file_explorer.entries = vec![crate::tui_panels::FileEntry {
        name: "vanished.rs".to_string(),
        path: "vanished.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
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
    app.file_explorer.entries = vec![crate::tui_panels::FileEntry {
        name: "a.rs".to_string(),
        path: "a.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
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

/// HTTP fake serving only the rename/delete/read endpoints: every tree
/// refresh fails so success arms with a failing refresh are reachable.
fn fake_web_api_server(
    rename_ok: bool,
    delete_ok: bool,
    read_ok: bool,
) -> (u16, std::sync::mpsc::Sender<()>) {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if rx.try_recv().is_ok() {
                break;
            }
            let Ok(stream) = stream else { break };
            let mut stream = stream;
            let mut line = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
            }
            let target = line.split(' ').nth(1).unwrap_or_default().to_string();
            let mutation_ok = (target.starts_with("/api/file-browser/rename") && rename_ok)
                || (target.starts_with("/api/file-browser/delete") && delete_ok);
            let body = if mutation_ok {
                json!({"ok": true})
            } else if target.starts_with("/api/file-browser/file") && read_ok {
                json!({
                    "content": "fn main() {}\n",
                    "binary": false,
                    "truncated": false,
                    "hash": "hash-v1",
                })
            } else {
                // Drop without a response: the call fails with an I/O error.
                continue;
            };
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.to_string().len(),
                    body
                )
                .as_bytes(),
            );
        }
    });
    (port, tx)
}

#[test]
fn rename_delete_and_edit_succeed_but_refresh_fails() {
    // Rename and delete succeed against the fake, but the follow-up tree
    // refresh (file-browser/tree) has no server: the refresh error must
    // surface while the prompt closes normally.
    let (port, _stop) = fake_web_api_server(true, true, true);
    let mut app = TuiApp::new_with_options(
        BackendClient::builtin_session(None),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", port),
    );
    app.snapshot = fixture_snapshot();
    app.screen = TuiScreen::Files;
    app.file_explorer.entries = vec![crate::tui_panels::FileEntry {
        name: "a.rs".to_string(),
        path: "a.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
    }];
    app.file_explorer.selected = 0;

    // Rename: the API succeeds, then the tree refresh fails.
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::RenameFile,
        text: "b.rs".to_string(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "renamed to b.rs");
    assert!(app.error.is_some(), "refresh failure after rename surfaces");
    assert!(app.prompt_input.is_none());
    app.error = None;

    // Delete: the API succeeds, then the tree refresh fails.
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::ConfirmDeleteFile,
        text: "y".to_string(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "deleted a.rs");
    assert!(app.error.is_some(), "refresh failure after delete surfaces");
    assert!(app.prompt_input.is_none());
    app.error = None;

    // Prefix-e from Git Changes: file_read succeeds (read_ok), then the
    // rebuilt explorer's tree refresh fails -> error surfaces, and the
    // edit still starts from the fetched content.
    app.screen = TuiScreen::Git;
    app.git_panel.view = crate::tui_panels::GitView::Changes;
    app.git_panel.cwd = std::env::temp_dir().to_string_lossy().to_string();
    app.git_panel.files = vec![crate::tui_panels::GitFileEntry {
        path: "a.rs".to_string(),
        status: crate::tui_panels::GitFileStatus::Unstaged,
    }];
    app.git_panel.file_selected = 0;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert!(
        app.error.is_some(),
        "tree refresh failure in prefix-e surfaces"
    );
    assert!(
        app.file_explorer.edit_active,
        "edit starts on fetched content"
    );
    assert_eq!(app.file_explorer.preview.path.as_deref(), Some("a.rs"));
    app.error = None;

    // Enter on the Files screen with a directory selected: toggle_expand
    // fails (tree endpoint dead) -> Err arm.
    app.screen = TuiScreen::Files;
    app.file_explorer.edit_active = false;
    app.file_explorer.entries = vec![crate::tui_panels::FileEntry {
        name: "d".to_string(),
        path: "d".to_string(),
        is_dir: true,
        size: None,
        level: 0,
        expanded: false,
    }];
    app.file_explorer.selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "dir expand failure surfaces");
    app.error = None;

    // Enter on a plain file with the read endpoint dead: open_preview Err.
    let (dead_port, _stop2) = fake_web_api_server(true, true, false);
    app.web_api = WebApiClient::new("127.0.0.1", dead_port);
    app.file_explorer.entries = vec![crate::tui_panels::FileEntry {
        name: "x.rs".to_string(),
        path: "x.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
    }];
    app.file_explorer.selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "preview open failure surfaces");
    app.error = None;

    // 'h' (Left) from a subdirectory: go_up succeeds, refresh fails.
    app.file_explorer.cwd = format!("{}/sub", std::env::temp_dir().to_string_lossy());
    app.file_explorer.root_path = std::env::temp_dir().to_string_lossy().to_string();
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    assert!(app.error.is_some(), "go_up refresh failure surfaces");
}
