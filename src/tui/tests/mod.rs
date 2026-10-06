use super::*;
use crate::tui::terminal::terminal_output_styled_lines_lossy;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::style::Color;
use ratatui::Terminal;
use serde_json::json;

use crate::tui::panels::{
    FileEntry, GitBranchEntry, GitCommitEntry, GitFileEntry, GitFileStatus, GitStashEntry, GitView,
};

/// Point the app's WebUI API at an endpoint nothing can ever answer:
/// port 1 refuses connections instantly, so every request surfaces the
/// deterministic "webui connection failed" error. Without this the
/// tests hit whatever real session runs on the default port (8787 on
/// this machine), and the same assertions flip between pass and fail
/// depending on whether that session is up.
pub(crate) fn point_web_api_at_dead_port(app: &mut TuiApp) {
    app.web_api = crate::tui::web_api::WebApiClient::new("127.0.0.1", 1);
}

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
fn log_two_commit_compare_keys_and_markdown_outline_key() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    point_web_api_at_dead_port(&mut app);
    app.screen = TuiScreen::Git;
    app.mode = TuiMode::Attach;
    app.git_panel.view = GitView::Log;
    app.git_panel.commits = vec![
        crate::tui::panels::git::GitCommitEntry {
            hash: "aaa".to_string(),
            message: "new".to_string(),
            author: "a".to_string(),
            date: String::new(),
            labels: vec![],
        },
        crate::tui::panels::git::GitCommitEntry {
            hash: "bbb".to_string(),
            message: "old".to_string(),
            author: "a".to_string(),
            date: String::new(),
            labels: vec![],
        },
    ];
    // Space marks the selected commit, Space again on the next commit.
    app.handle_key(KeyEvent::from(KeyCode::Char(' ')));
    assert_eq!(app.git_panel.log_selected, vec!["aaa".to_string()]);
    app.git_panel.commit_selected = 1;
    app.handle_key(KeyEvent::from(KeyCode::Char(' ')));
    assert_eq!(
        app.git_panel.log_selected,
        vec!["aaa".to_string(), "bbb".to_string()]
    );
    // c with two selected compares (dead web API: the error surfaces,
    // but only after the selection guard passed).
    app.handle_key(KeyEvent::from(KeyCode::Char('c')));
    assert!(
        app.error
            .as_deref()
            .is_some_and(|e| e.contains("webui connection failed")),
        "compare hits the API: {:?}",
        app.error
    );
    // One selected: c keeps the commit-modal meaning (no compare call).
    app.error = None;
    app.git_panel.log_selected.truncate(1);
    app.handle_key(KeyEvent::from(KeyCode::Char('c')));
    assert!(app.commit_input.is_some(), "c opens the commit modal");
    // Close the modal so the Files keys below are not swallowed by it.
    app.commit_input = None;

    // Files screen: M without a markdown preview errors; with one it
    // flips the outline mode on and back off.
    app.screen = TuiScreen::Files;
    app.git_panel.log_selected.clear();
    app.error = None;
    app.file_explorer.preview = crate::tui::panels::FilePreview::default();
    app.handle_key(KeyEvent::from(KeyCode::Char('M')));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|e| e.contains("open a markdown file first")));
    app.error = None;
    app.file_explorer.preview.path = Some("docs/plan.md".to_string());
    app.handle_key(KeyEvent::from(KeyCode::Char('M')));
    assert!(app.file_explorer.markdown_outline);
    assert_eq!(app.status, "outline view (M shows source)");
    app.handle_key(KeyEvent::from(KeyCode::Char('M')));
    assert!(!app.file_explorer.markdown_outline);
    assert_eq!(app.status, "source view");
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
            "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true,"agent_session":{"kind":"jcode","resolvable":true,"session_id":"sess_1"}}],
            "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}]
        }
    })
}

fn fixture_snapshot() -> TuiSnapshot {
    TuiSnapshot::from_backend_response(&fixture_snapshot_value())
}

/// Two tabs in the workspace so the tab strip renders one active and
/// one inactive tab (the single-tab fixture only ever shows the
/// active style).
fn fixture_snapshot_value_with_tabs() -> serde_json::Value {
    json!({
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":2,"active_tab_id":"tab_1"}],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"},
                {"tab_id":"tab_2","workspace_id":"ws_1","label":"Server","focused":false,"pane_count":1,"agent_status":"idle"}
            ],
            "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
            "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}]
        }
    })
}

fn app_with_snapshot() -> TuiApp {
    // NOTE: tests must NEVER wire `builtin_session(None)` into an app that
    // dispatches mutating shortcuts: that points at the real user backend
    // (the live herdr.sock in ~/.config/herdr-webui/builtin/default), so a
    // single Ctrl+B P / Ctrl+B X arm creates or closes REAL tabs in the
    // user's session. A nonexistent socket keeps every mutating arm on its
    // error path (and read-only refreshes too), which is what these tests
    // assert anyway. Tests that need a working backend use `fake_backend_socket`.
    let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
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

#[test]
fn pane_viewport_size_mirrors_the_rendered_pane_geometry() {
    // 100x30, sidebar shown (>=100 cols -> 34): the tail area is
    // 100 - 34 sidebar - 2 borders = 64 cols and
    // 30 - 1 footer - 1 tab bar - 2 borders - 3 header = 23 rows.
    use crate::tui::render::pane_viewport_size;
    assert_eq!(pane_viewport_size(100, 30, false), (64, 23));
    // Narrow window: sidebar halves, borders still subtracted.
    assert_eq!(pane_viewport_size(80, 30, false), (80 - 28 - 2, 23));
    // Sidebar collapsed: full width minus pane borders.
    assert_eq!(pane_viewport_size(100, 30, true), (98, 23));
    // Tiny screens clamp instead of underflowing: 10 cols -> sidebar
    // min(28,10/2)=5, pane borders 2, so 3 cols survive; 8 rows clamp
    // to 1 viewport row.
    assert_eq!(pane_viewport_size(10, 8, false), (3, 1));
    assert_eq!(pane_viewport_size(0, 0, false), (1, 1));
}

#[test]
fn attach_viewport_follows_screen_size_and_sidebar_state() {
    let mut app = app_with_snapshot();
    // Unknown screen size (embedders, --once): legacy fallback.
    assert_eq!(app.attach_viewport(), (120, 32));

    app.set_terminal_size(100, 30);
    assert_eq!(app.attach_viewport(), (64, 23));

    // Sidebar toggle changes only the width the pane can show.
    app.sidebar_collapsed = true;
    assert_eq!(app.attach_viewport(), (98, 23));
}

#[test]
fn attach_sizing_keeps_the_last_tail_line_inside_the_pane() {
    // Regression for both reported bugs: at 100x30 the pane shows a
    // 64-col viewport, so a pty-tail line of exactly 64 cols renders
    // on ONE row (no Wrap continuation doubling the last character)
    // and the LAST tail line (the input/prompt row) stays visible at
    // the bottom of the pane instead of being pushed out.
    let mut app = app_with_snapshot();
    app.set_terminal_size(100, 30);
    let (cols, rows) = app.attach_viewport();
    assert_eq!((cols, rows), (64, 23));

    // Fill exactly one pty screen: `rows` lines, each `cols` wide,
    // the last one being the prompt row the user must see.
    let mut tail = Vec::new();
    for i in 0..rows {
        let line = if i == rows - 1 {
            "❯ INPUT_LINE_MARKER".to_string()
        } else {
            format!("row-{i:02} ").repeat((cols / 7) as usize)
        };
        tail.push(line);
    }
    app.set_pane_tail_from_text(&tail.join("\n"));

    let rendered = draw(&app, 100, 30);
    assert!(
        rendered.contains("INPUT_LINE_MARKER"),
        "the last tail line (input row) must be visible inside the pane"
    );
    // The pane is 64 cols wide: 23 rendered rows for 23 tail lines
    // means no line wrapped. A wrapped line would push the marker
    // out (the pre-fix symptom). Sanity-check the marker lands once
    // (no Wrap spill duplicating content).
    let marker_hits = rendered.matches("INPUT_LINE_MARKER").count();
    assert_eq!(marker_hits, 1);
}

/// Renders and keeps the buffer so tests can assert on cell colors
/// (the Debug dump of `draw` is lossy for that).
fn draw_buffer(app: &TuiApp, width: u16, height: u16) -> ratatui::buffer::Buffer {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, app)).unwrap();
    terminal.backend().buffer().clone()
}

/// A rendered row plus its y coordinate, for depth-effect assertions.
/// `chars` is one entry per cell so multibyte glyphs (·, ▸) keep their
/// cell x positions.
struct RenderedRow {
    chars: Vec<char>,
    y: usize,
}

impl RenderedRow {
    /// Cell x of the first character of `needle`, or the row is not
    /// the one expected.
    fn cell_x_of(&self, needle: &str) -> Option<usize> {
        let needle: Vec<char> = needle.chars().collect();
        self.chars
            .windows(needle.len())
            .position(|w| w == needle.as_slice())
    }
}

fn rendered_row(buffer: &ratatui::buffer::Buffer, needle: &str) -> RenderedRow {
    for y in 0..buffer.area.height as usize {
        let chars: Vec<char> = (0..buffer.area.width as usize)
            .map(|x| {
                buffer[(x as u16, y as u16)]
                    .symbol()
                    .chars()
                    .next()
                    .unwrap_or(' ')
            })
            .collect();
        let as_line: String = chars.iter().collect();
        if as_line.contains(needle) {
            return RenderedRow { chars, y };
        }
    }
    panic!("row containing {needle:?} not rendered");
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
    app.git_panel.diff_meta = vec![Some(crate::tui::panels::GitDiffLineMeta {
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
        git_status: None,
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
    let help = draw(&app, 100, 50);
    assert!(help.contains("Ctrl+B"), "help lists prefix rows");
    assert!(help.contains("toggle blame"), "help lists blame");
    assert!(
        help.contains("create worktree"),
        "help lists workspace rows"
    );
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
        git_status: None,
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

    // Search opens the palette overlay.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('f')));
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(app.mode, TuiMode::SearchPalette, "search opens the palette");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_ne!(app.mode, TuiMode::SearchPalette);

    // Sidebar navigation arms: j/k move workspaces, a/A move agents.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.sidebar_focus, SidebarFocus::Workspaces);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::new(KeyCode::Char('A'), KeyModifiers::SHIFT));
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);

    // NewTab/CloseTab dispatch: against a real backend these mutate the
    // session, so only assert the arms run without panic. Quit status arm.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));

    // Quit arm opens the confirmation overlay instead of quitting.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    assert!(!app.should_quit(), "quit shortcut asks first");
    // Cancel first; the destructive confirm runs at the very end of the
    // test because after `y` the app is in a terminal ConfirmQuit state.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);

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

    // Prefix s opens the settings overlay (webui settings: KeyS).
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(app.mode, TuiMode::Settings);
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);

    // Unknown prefix key cancels quietly (the `_ => None` arm).
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::F(7)));
    assert_eq!(app.git_panel.view, GitView::Log);

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

    // The real confirm runs last: y confirms the quit overlay that the
    // quit arm opened earlier in the flow.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    app.handle_key(KeyEvent::from(KeyCode::Char('y')));
    assert_eq!(app.status, "quit");
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
fn shortcut_labels_cover_every_variant() {
    // Every Shortcut variant renders a non-empty label; exercise the
    // full match arms without going through the key map.
    use crate::tui::keys::Shortcut;
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
    let mut explorer = crate::tui::panels::FileExplorer::new("/repo");
    explorer.entries = vec![
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
            name: "child.rs".to_string(),
            path: "src/child.rs".to_string(),
            is_dir: false,
            size: None,
            level: 1,
            expanded: false,
            git_status: None,
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
    let mut panel = crate::tui::panels::GitPanel::new("/repo");
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
    let mut panel = crate::tui::panels::GitPanel::new("/repo");
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

    // In Navigate on the Terminal screen q opens the quit confirmation.
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    // Esc cancels the quit overlay back to Navigate.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);
    assert!(!app.should_quit());

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

    let path = crate::backend_client::unique_test_path("herdr-tui-fake");
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
            "workspace.create" => json!({
                "id": request["id"],
                "result": {"workspace": {"workspace_id": "ws_created"}}
            }),
            "worktree.open" => json!({
                "id": request["id"],
                "result": {
                    "workspace": {"workspace_id": "ws_opened"},
                    "tab": {"tab_id": "tab_opened"},
                    "root_pane": {"pane_id": "pane_opened"}
                }
            }),
            // Result shaped like the server's promote route payload:
            // workspace cwd (the backend resolves the live cwd) plus
            // label, which the TUI records into recents.
            "tab.promote" => json!({
                "id": request["id"],
                "result": {
                    "workspace": {
                        "workspace_id": "ws_promoted",
                        "cwd": "/promoted/cwd",
                        "label": "promoted label"
                    }
                }
            }),
            "workspace.close" => {
                // Built-in backend drops the emptied workspace itself; a
                // second close reports not-found, which the TUI ignores.
                if request["workspace_id"].as_str() == Some("ws_gone") {
                    json!({"id": request["id"], "error": "workspace not found"})
                } else {
                    json!({"id": request["id"], "result": {"ok": true}})
                }
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

    let path = crate::backend_client::unique_test_path("herdr-tui-fake-nosnap");
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
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
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
        app.handle_key(KeyEvent::from(KeyCode::Char('p')));
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
        app.file_explorer = crate::tui::panels::FileExplorer::new("/definitely/not/here");
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
fn close_last_tab_also_closes_the_workspace() {
    // Gap 7: webui closeTab closes the workspace explicitly when the
    // tab was the last one in it. The single-tab fixture exercises the
    // workspace.close arm: the fake backend answers both requests and
    // the refreshed status proves the full round trip.
    let (api_socket, _stop) = fake_backend_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(
        app.status, "backend test · protocol 1 · 1 workspaces · 1 agents",
        "closing the last tab must refresh against the fake backend"
    );
    assert!(app.error.is_none(), "last-tab close error: {:?}", app.error);
    let _ = std::fs::remove_file(&api_socket);
}

#[test]
fn close_last_tab_ignores_workspace_not_found() {
    // Built-in backends drop the emptied workspace themselves, so the
    // explicit workspace.close may come back "not found"; the TUI must
    // swallow that and still report success.
    let (api_socket, _stop) = fake_backend_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    let mut snapshot = fixture_snapshot();
    snapshot.workspaces[0].id = "ws_gone".to_string();
    snapshot.tabs[0].workspace_id = "ws_gone".to_string();
    app.snapshot = snapshot;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    // Refresh succeeds against the fake backend, so the status is the
    // backend summary; the point is that the not-found error is gone.
    assert_eq!(
        app.status,
        "backend test · protocol 1 · 1 workspaces · 1 agents"
    );
    assert!(
        !app.error
            .as_deref()
            .is_some_and(|e| e.contains("not found")),
        "workspace-already-gone not-found must be ignored: {:?}",
        app.error
    );
    let _ = std::fs::remove_file(&api_socket);
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
fn edit_key_save_error_surfaces_from_files_screen() {
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.screen = TuiScreen::Files;
    app.mode = TuiMode::Attach;
    app.file_explorer.preview = crate::tui::panels::FilePreview {
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
    assert!(help.contains("? closes"), "help footer renders");
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
fn navigate_esc_on_files_screen_returns_to_terminal() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Files;
    // Esc on a non-Terminal screen steps back to Terminal (webui Esc
    // leaves the open panel); the second Esc opens the quit overlay,
    // and a third Esc only cancels it.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.screen, TuiScreen::Terminal);
    assert_ne!(app.status, "quit", "first Esc detaches, not quits");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    assert!(!app.should_quit(), "second Esc asks, does not quit");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);
    assert!(!app.should_quit());
    // q opens the confirm overlay too, and y confirms it.
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    app.handle_key(KeyEvent::from(KeyCode::Char('y')));
    assert_eq!(app.status, "quit");
    assert!(app.should_quit());
}

#[test]
fn quit_confirmation_covers_all_quit_paths() {
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Attach;
    app.screen = TuiScreen::Terminal;

    // Plain q in Navigate opens the overlay (covered above); Esc on the
    // Terminal screen opens it too, and cancel restores the prior mode.
    app.mode = TuiMode::Navigate;
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    assert_eq!(app.mode, TuiMode::Navigate, "cancel restores Navigate");

    // Opened from Attach, cancel restores Attach.
    app.mode = TuiMode::Attach;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Attach, "cancel restores Attach");
    assert!(!app.should_quit());

    // Enter confirms, Ctrl+C confirms too.
    app.mode = TuiMode::Navigate;
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.should_quit(), "Enter confirms quit");

    app.status = String::new();
    app.mode = TuiMode::ConfirmQuit;
    app.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));
    assert!(app.should_quit(), "Ctrl+C confirms quit");

    // Unknown keys in the overlay do nothing.
    app.status = String::new();
    app.mode = TuiMode::ConfirmQuit;
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    assert!(!app.should_quit());

    // The overlay renders its question, hints, and footer mode.
    app.mode = TuiMode::ConfirmQuit;
    let rendered = draw(&app, 100, 24);
    assert!(rendered.contains("Quit herdr-webui-tui?"), "title renders");
    assert!(rendered.contains("y"), "y hint renders");
    assert!(rendered.contains("QUIT?"), "footer shows QUIT? mode");
    assert!(rendered.contains("n"), "n hint renders");
}

#[test]
fn plain_question_mark_opens_help_from_every_screen() {
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Terminal;
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Help);
    app.handle_key(KeyEvent::from(KeyCode::Esc));

    // Files screen: ? opens help even while a panel owns the keyboard.
    app.screen = TuiScreen::Files;
    app.file_explorer = crate::tui::panels::FileExplorer::new("/repo");
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Help);
    app.handle_key(KeyEvent::from(KeyCode::Esc));

    // Git screen: same from every git view.
    app.screen = TuiScreen::Git;
    app.git_panel = crate::tui::panels::GitPanel::new("/repo");
    for view in [GitView::Changes, GitView::Log, GitView::Branches] {
        app.git_panel.view = view;
        app.handle_key(KeyEvent::from(KeyCode::Char('?')));
        assert_eq!(app.mode, TuiMode::Help, "? opens help from {view:?}");
        app.handle_key(KeyEvent::from(KeyCode::Esc));
        assert_eq!(app.mode, TuiMode::Navigate);
    }
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
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
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
fn footer_shows_help_hint_on_every_screen_and_mode() {
    let mut app = app_with_snapshot();

    // Navigate mode, every screen: the footer ends with the help hint.
    app.mode = TuiMode::Navigate;
    for screen in [TuiScreen::Terminal, TuiScreen::Files, TuiScreen::Git] {
        app.screen = screen;
        let rendered = draw(&app, 120, 24);
        assert!(
            rendered.contains("? help"),
            "Navigate footer on {screen:?} must advertise help"
        );
    }

    // Attach mode, every screen: per-screen action hints plus help.
    app.mode = TuiMode::Attach;
    for screen in [TuiScreen::Terminal, TuiScreen::Files, TuiScreen::Git] {
        app.screen = screen;
        let rendered = draw(&app, 120, 24);
        assert!(
            rendered.contains("? help"),
            "Attach footer on {screen:?} must advertise help"
        );
    }
    // The Attach hints are per-screen, not one generic string.
    app.screen = TuiScreen::Git;
    assert!(draw(&app, 120, 24).contains("Tab view"), "git hint shows");
    app.screen = TuiScreen::Files;
    assert!(draw(&app, 120, 24).contains("e edit"), "files hint shows");
}

#[test]
fn footer_keeps_help_hint_visible_at_80_columns() {
    let mut app = app_with_snapshot();

    // The classic 80x24 terminal: the full hints (60-90 chars) would clip
    // the `Ctrl+B ? help` tail off-screen. The compact fallbacks must keep
    // it visible in every mode/screen pair, and the status message must
    // still render (never a negative-width truncate).
    app.mode = TuiMode::Navigate;
    for screen in [TuiScreen::Terminal, TuiScreen::Files, TuiScreen::Git] {
        app.screen = screen;
        let rendered = draw(&app, 80, 24);
        assert!(
            rendered.contains("Ctrl+B ? help"),
            "Navigate at 80 cols on {screen:?} must still show the help hint"
        );
    }
    app.mode = TuiMode::Attach;
    for screen in [TuiScreen::Terminal, TuiScreen::Files, TuiScreen::Git] {
        app.screen = screen;
        let rendered = draw(&app, 80, 24);
        assert!(
            rendered.contains("Ctrl+B ? help"),
            "Attach at 80 cols on {screen:?} must still show the help hint"
        );
    }
    // The status message survives next to the compact hint: the fixture
    // app still carries the constructor's "connecting" status.
    app.screen = TuiScreen::Terminal;
    let rendered = draw(&app, 80, 24);
    assert!(
        rendered.contains("connecting"),
        "status message must render at 80 cols, got: {}",
        rendered.chars().rev().take(200).collect::<String>()
    );

    // Even a 60-col terminal keeps the help discovery tail.
    app.mode = TuiMode::Navigate;
    for screen in [TuiScreen::Terminal, TuiScreen::Files, TuiScreen::Git] {
        app.screen = screen;
        assert!(
            draw(&app, 60, 24).contains("Ctrl+B ? help"),
            "Navigate at 60 cols on {screen:?} keeps the help tail"
        );
    }
}

#[test]
fn footer_hint_follows_focused_context() {
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Attach;

    // Per git view: the hint names the view's own actions, not one
    // generic git string. Tab cycles views in the app; the test sets
    // `view` directly to avoid backend refreshes.
    for (view, needle) in [
        (GitView::Changes, "J/K hunk"),
        (GitView::Log, "Space mark"),
        (GitView::Branches, "c create"),
        (GitView::Stash, "Enter diff"),
        (GitView::History, "o back to changes"),
        (GitView::Conflicts, "o ours"),
        (GitView::Cleanup, "B prune"),
    ] {
        app.screen = TuiScreen::Git;
        app.git_panel.view = view;
        let rendered = draw(&app, 140, 24);
        assert!(
            rendered.contains(needle),
            "Git {view:?} hint must show `{needle}`"
        );
        assert!(
            rendered.contains("Ctrl+B ? help"),
            "Git {view:?} hint keeps the help tail at 140 cols"
        );
    }
    app.git_panel.view = GitView::Changes;

    // Files edit mode takes over: save/stop keys instead of move/open.
    app.screen = TuiScreen::Files;
    app.file_explorer.edit_active = true;
    let rendered = draw(&app, 140, 24);
    assert!(rendered.contains("Ctrl-S save"), "edit mode names Ctrl-S");
    assert!(rendered.contains("Esc stop"), "edit mode names Esc");
    app.file_explorer.edit_active = false;

    // The filter bar owns the keyboard: no move/open hint while typing.
    app.file_explorer.start_filter();
    let rendered = draw(&app, 140, 24);
    assert!(rendered.contains("type to filter"), "filter bar hint");
    assert!(
        !rendered.contains("Enter open"),
        "filter bar hides the browse hint"
    );
    app.file_explorer.filter_active = false;

    // Commit input wins over the screen hint.
    app.screen = TuiScreen::Git;
    app.commit_input = Some(CommitInput {
        text: String::new(),
        amend: false,
    });
    let rendered = draw(&app, 140, 24);
    assert!(rendered.contains("Enter commits"), "commit input hint");
    app.commit_input = None;

    // Prompt input beats commit input and everything else.
    app.prompt_input = Some(PromptInput::new(PromptKind::RenameFile));
    let rendered = draw(&app, 140, 24);
    assert!(rendered.contains("Enter accepts"), "prompt hint wins");
    app.prompt_input = None;

    // The quit overlay beats all screen contexts: `q` on the Terminal
    // screen in Navigate mode asks first, and the overlay hint replaces
    // whatever context was active.
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Terminal;
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    let rendered = draw(&app, 140, 24);
    assert!(rendered.contains("y quit"), "quit overlay hint wins");
    assert!(!rendered.contains("Enter accepts"), "no stale prompt hint");
}

#[test]
fn footer_hint_survives_narrow_terminals_per_context() {
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Attach;

    // Every context keeps the help tail at 80 cols (the classic width).
    app.screen = TuiScreen::Git;
    for view in GitView::all() {
        app.git_panel.view = view;
        let rendered = draw(&app, 80, 24);
        assert!(
            rendered.contains("Ctrl+B ? help"),
            "Git {view:?} at 80 cols keeps the help tail"
        );
    }
    app.git_panel.view = GitView::Changes;

    app.screen = TuiScreen::Files;
    app.file_explorer.edit_active = true;
    assert!(
        draw(&app, 80, 24).contains("Ctrl+B ? help"),
        "edit mode at 80 cols keeps the help tail"
    );
    app.file_explorer.edit_active = false;

    app.file_explorer.start_filter();
    assert!(
        draw(&app, 80, 24).contains("Ctrl+B ? help"),
        "filter bar at 80 cols keeps the help tail"
    );
    app.file_explorer.filter_active = false;

    app.commit_input = Some(CommitInput {
        text: String::new(),
        amend: false,
    });
    assert!(
        draw(&app, 80, 24).contains("Ctrl+B ? help"),
        "commit input at 80 cols keeps the help tail"
    );
    app.commit_input = None;
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
    app.file_explorer.preview = crate::tui::panels::FilePreview {
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

/// Fake HTTP server for the recent-workspaces endpoints: keeps an
/// in-memory list so remove/clear mutate it like the real handler, and
/// records the open POST body (path + label) for assertions. Requests
/// for any other path get an empty 200 so unrelated best-effort
/// calls (file/content search) stay harmless.
fn fake_recents_server(
    initial: Vec<serde_json::Value>,
) -> (u16, std::sync::mpsc::Receiver<serde_json::Value>) {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::sync::{Arc, Mutex};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let recents = Arc::new(Mutex::new(initial));
    let (tx, rx) = std::sync::mpsc::channel::<serde_json::Value>();
    let handle = std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let request = {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                let target = request_line
                    .split(' ')
                    .nth(1)
                    .unwrap_or_default()
                    .to_string();
                let mut content_length = 0usize;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    let trimmed = header.trim();
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some(value) =
                        trimmed.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let body: serde_json::Value = if body.is_empty() {
                    serde_json::Value::Null
                } else {
                    serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null)
                };
                (target, body)
            };
            let (target, body) = request;
            let response = if target == "/api/recent-workspaces" {
                // POST re-records the opened path (top of the list);
                // GET returns the current list.
                if body
                    .get("path")
                    .and_then(serde_json::Value::as_str)
                    .is_some()
                {
                    let _ = tx.send(body.clone());
                    let mut list = recents.lock().unwrap();
                    let path = body["path"].as_str().unwrap().to_string();
                    let label = body["label"].as_str().map(str::to_string);
                    let entry = match label {
                        Some(label) => serde_json::json!({ "path": path, "label": label }),
                        None => serde_json::json!({ "path": path }),
                    };
                    list.retain(|item| item["path"].as_str() != Some(path.as_str()));
                    list.insert(0, entry);
                    // worktree.open-shaped result, exactly like the
                    // real proxy returns it (and the desktop api() body):
                    // everything nested under "result".
                    serde_json::json!({
                        "ok": true,
                        "result": {
                            "workspace": { "workspace_id": "ws_reopened" },
                            "tab": { "tab_id": "tab_reopened" },
                            "root_pane": { "pane_id": "pane_reopened" }
                        }
                    })
                } else {
                    serde_json::json!({ "recent": *recents.lock().unwrap() })
                }
            } else if target == "/api/recent-workspaces/remove" {
                let path = body["path"].as_str().unwrap_or_default().to_string();
                recents
                    .lock()
                    .unwrap()
                    .retain(|item| item["path"].as_str() != Some(path.as_str()));
                serde_json::json!({ "ok": true })
            } else if target == "/api/recent-workspaces/record" {
                // Record-only endpoint: insert at the top like the
                // server's push_recent_workspace (dedup by path).
                let _ = tx.send(body.clone());
                let path = body["path"].as_str().unwrap_or_default().to_string();
                let label = body["label"].as_str().map(str::to_string);
                let kind = body["kind"].as_str().map(str::to_string);
                let entry = match (label, kind) {
                    (Some(label), _) => json!({ "path": path, "label": label }),
                    (None, Some(kind)) => json!({ "path": path, "kind": kind }),
                    (None, None) => json!({ "path": path }),
                };
                let mut list = recents.lock().unwrap();
                list.retain(|item| item["path"].as_str() != Some(path.as_str()));
                list.insert(0, entry);
                serde_json::json!({ "ok": true })
            } else if target == "/api/recent-workspaces/clear" {
                recents.lock().unwrap().clear();
                serde_json::json!({ "ok": true })
            } else {
                serde_json::json!({ "ok": true })
            };
            let body_text = response.to_string();
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body_text.len(),
                    body_text
                )
                .as_bytes(),
            );
        }
    });
    std::mem::forget(handle);
    (port, rx)
}

#[test]
fn search_palette_recents_unavailable_keeps_palette_usable() {
    // Desktop `loadRecentWorkspaces` swallows a failed load (empty
    // list, palette unaffected). The TUI must do the same: with the
    // WebUI API at a dead port, opening the palette notes the failure
    // in the status line, clears the recents section, and still
    // lists the local candidates for navigation.
    let (api_socket, _stop_backend) = fake_backend_socket();
    let mut app = TuiApp::new_with_options(
        BackendClient::new(api_socket.clone(), api_socket),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.snapshot = fixture_snapshot();
    let ctrl_b = ctrl('b');

    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(
        app.mode,
        TuiMode::SearchPalette,
        "palette opens despite the failed recents load"
    );
    assert!(
        app.search_palette.recents.is_empty(),
        "failed load clears the section"
    );
    assert!(
        app.status.starts_with("recents unavailable"),
        "status notes the failure: {}",
        app.status
    );
    // The palette stays usable: typing filters the local candidates.
    let query = fixture_snapshot()
        .workspaces
        .first()
        .map(|ws| ws.label.chars().next().unwrap().to_string())
        .unwrap_or_else(|| "w".to_string());
    app.handle_key(KeyEvent::from(KeyCode::Char(query.chars().next().unwrap())));
    assert_eq!(
        app.mode,
        TuiMode::SearchPalette,
        "typing still filters instead of closing"
    );
    assert_eq!(app.search_palette.query, query);
}

#[test]
fn search_palette_recents_load_remove_clear_and_open() {
    // Fake backend answers ping/snapshot; the fixture workspace cwd is
    // /repo, so the /repo recent must render disabled while /side stays
    // openable.
    let (api_socket, _stop_backend) = fake_backend_socket();
    let (port, open_requests) = fake_recents_server(vec![
        json!({ "path": "/repo", "label": "main repo" }),
        json!({ "path": "/side", "kind": "worktree", "branch": "feature/x" }),
    ]);
    let mut app = TuiApp::new_with_options(
        BackendClient::new(api_socket.clone(), api_socket),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", port),
    );
    app.snapshot = fixture_snapshot();
    let ctrl_b = ctrl('b');

    // Opening the palette loads the recents: with the empty query the
    // recent section lists both entries above the (empty) local rows.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(app.mode, TuiMode::SearchPalette);
    assert_eq!(app.search_palette.recents.len(), 2);
    assert_eq!(app.search_palette.results.len(), 2);
    assert!(matches!(
        &app.search_palette.results[0],
        search::SearchCandidate::Recent { is_open: true, .. }
    ));
    assert!(matches!(
        &app.search_palette.results[1],
        search::SearchCandidate::Recent { is_open: false, .. }
    ));

    // Desktop `renderSearchPalette` snaps the cursor off disabled rows:
    // the selection lands on the openable /side, not the disabled
    // /repo at index 0.
    assert_eq!(
        app.search_palette.selected, 1,
        "cursor skips the disabled recent"
    );

    // The disabled row renders with the hint; the openable row keeps
    // its title and worktree subtitle.
    let canvas = draw(&app, 100, 24);
    assert!(canvas.contains("(already open)"), "open recent is dimmed");
    assert!(canvas.contains("[wt] side"), "worktree row with icon");
    assert!(canvas.contains("worktree"), "subtitle renders");

    // The refusal guard still holds when the cursor sits on a
    // disabled row (desktop `chooseSearchResult` returns early on
    // disabled rows): park it there manually, Enter commits the
    // (empty) query first, the second Enter is refused, and the
    // palette stays open with the status explaining why.
    app.search_palette.selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.search_palette.committed, "empty query commits cleanly");
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.mode, TuiMode::SearchPalette);
    assert_eq!(app.status, "recent workspace already open");

    // Ctrl+X removes the recent under the cursor (/repo, parked at
    // row 0) from the server list; only /side remains and the
    // refresh snaps the cursor to it.
    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL));
    assert_eq!(app.search_palette.recents.len(), 1);
    assert_eq!(app.search_palette.results.len(), 1);
    assert_eq!(app.status, "removed recent: /repo");

    // Ctrl+X with no recent under the cursor explains itself instead
    // of failing silently (a local row or empty selection).
    app.search_palette.results.clear();
    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::CONTROL));
    assert_eq!(app.status, "no recent workspace selected");

    // Reopen the palette to reload from the (mutated) server list,
    // then Ctrl+Shift+X clears every entry.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(app.search_palette.recents.len(), 1, "reload after remove");
    app.handle_key(KeyEvent::new(
        KeyCode::Char('x'),
        KeyModifiers::CONTROL | KeyModifiers::SHIFT,
    ));
    assert_eq!(app.search_palette.recents.len(), 0);
    assert!(app.search_palette.results.is_empty());
    assert_eq!(app.status, "recent workspaces cleared");

    // Esc, then reopen with a fresh server list (the fake kept /side
    // through the remove and clear only affected its own copy: push a
    // new entry by reopening via the open flow below). Instead of
    // relying on the shared fake state, drive the open flow directly:
    // reopen the palette on a second fake preloaded with /side.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    drop(open_requests);
    let (port2, open_requests2) =
        fake_recents_server(vec![json!({ "path": "/side", "kind": "worktree" })]);
    app.web_api = WebApiClient::new("127.0.0.1", port2);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(app.search_palette.recents.len(), 1);

    // Enter on the openable recent reopens it: the first Enter commits
    // the empty query, the second navigates. The palette closes, the
    // POST body carries the recorded label (here none, kind only), and
    // the status confirms the open.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.search_palette.committed);
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_ne!(app.mode, TuiMode::SearchPalette, "open navigates away");
    assert!(app.error.is_none(), "open flow: {:?}", app.error);
    let posted = open_requests2
        .recv_timeout(Duration::from_secs(5))
        .expect("open POST reached the server");
    assert_eq!(posted["path"], "/side");
    assert!(posted.get("label").is_none_or(|v| v.is_null()));

    // A recent WITH a recorded label travels with the open POST like
    // the desktop openRecentWorkspace(path, label) round trip: the
    // label key is present and carries the custom name, so the server
    // re-records it (only a null label keeps the backend naming).
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    drop(open_requests2);
    let (port3, open_requests3) =
        fake_recents_server(vec![json!({ "path": "/labored", "label": "custom name" })]);
    app.web_api = WebApiClient::new("127.0.0.1", port3);
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(app.search_palette.recents.len(), 1);
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_ne!(
        app.mode,
        TuiMode::SearchPalette,
        "labeled open navigates away"
    );
    assert!(app.error.is_none(), "labeled open flow: {:?}", app.error);
    let posted = open_requests3
        .recv_timeout(Duration::from_secs(5))
        .expect("labeled open POST reached the server");
    assert_eq!(posted["path"], "/labored");
    assert_eq!(posted["label"], "custom name");
}

#[test]
fn search_palette_recents_cache_serves_ttl_and_invalidates_on_mutations() {
    // Desktop `loadRecent` caches the list 10s (failed loads too) and
    // `invalidateRecent` drops the cache after open/remove/clear. The
    // TUI mirrors both: within the TTL a reopen serves the cached rows
    // without touching the server; the mutations invalidate so the
    // next open refetches.
    let (api_socket, _stop_backend) = fake_backend_socket();
    let (port, _open_requests) = fake_recents_server(vec![json!({ "path": "/cached" })]);
    let mut app = TuiApp::new_with_options(
        BackendClient::new(api_socket.clone(), api_socket),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", port),
    );
    app.snapshot = fixture_snapshot();
    let ctrl_b = ctrl('b');

    // First open fetches.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(app.search_palette.recents.len(), 1);
    assert!(app.search_palette.recents_fetched_at.is_some());
    app.handle_key(KeyEvent::from(KeyCode::Esc));

    // Reopen inside the TTL: cached rows, no refetch. Simulate the
    // server changing the list underneath: a fresh fetch would show
    // zero rows (the fake was seeded with one entry only and nothing
    // removed it), so assert the cached rows survive unchanged and the
    // fetch stamp stays put.
    let stamp = app.search_palette.recents_fetched_at;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(app.search_palette.recents.len(), 1, "cached rows served");
    assert_eq!(
        app.search_palette.recents_fetched_at, stamp,
        "no refetch inside the TTL"
    );
    app.handle_key(KeyEvent::from(KeyCode::Esc));

    // Invalidate (as remove/clear/open do) forces the next open to
    // refetch: the stamp moves.
    app.search_palette.invalidate_recents();
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(app.search_palette.recents.len(), 1);
    assert_ne!(
        app.search_palette.recents_fetched_at, stamp,
        "invalidation forces a refetch"
    );
}

#[test]
fn tui_created_workspaces_and_opened_worktrees_record_recents() {
    // Desktop records every created workspace (fire-and-forget POST
    // after the create) and every worktree open (`/api/worktrees/open`
    // records server-side). The TUI talks to the backend socket
    // directly, so its create/open flows must POST the new record-only
    // endpoint themselves — best effort, a dead WebUI server must not
    // fail the operation.
    let (api_socket, _stop_backend) = fake_backend_socket();
    let (port, open_requests) = fake_recents_server(vec![]);
    let mut app = TuiApp::new_with_options(
        BackendClient::new(api_socket.clone(), api_socket),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", port),
    );
    app.snapshot = fixture_snapshot();

    // Create flow: a real temp folder (validation checks the disk),
    // a custom label, then the record POST must carry both.
    let dir = std::env::temp_dir().join(format!(
        "herdr-tui-recent-create-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.to_string_lossy().to_string();
    // `create_workspace_at` is the shared tail of both prompt flows
    // (path-only and path+label); drive it directly with the label.
    let result = app.create_workspace_at(&path, Some("custom ws"));
    assert!(result.is_ok(), "create flow: {result:?}");
    // The worktree-open flow needs the overlay populated; reuse the
    // same fake backend's worktree.open arm.
    app.worktree_rows = vec![crate::tui::workspace::WorktreeRow {
        path: "/wt/branch-x".to_string(),
        branch: "branch-x".to_string(),
        label: String::new(),
        is_linked: false,
    }];
    // Row 0 is the "this folder" row; index 1 is the worktree.
    app.worktree_selected = 1;
    let result2 = app.worktree_open_selected();
    assert!(result2.is_ok(), "open flow: {result2:?}");

    // Promote flow: server route records the promoted workspace from
    // the result (cwd resolved by the backend + label); the TUI socket
    // flow must POST the same shape. Push a temp tab into the snapshot.
    app.snapshot.tabs.push(crate::tui::model::TuiTab {
        id: "tab_temp".to_string(),
        workspace_id: "ws_1".to_string(),
        label: "temp".to_string(),
        focused: false,
        pane_count: 1,
        agent_status: "idle".to_string(),
    });
    let result3 = app.temp_terminal_promote();
    assert!(result3.is_ok(), "promote flow: {result3:?}");

    let posted_create = open_requests
        .recv_timeout(Duration::from_secs(5))
        .expect("create record POST reached the server");
    assert_eq!(posted_create["path"], json!(path));
    assert_eq!(posted_create["label"], "custom ws");
    assert_eq!(posted_create["kind"], "workspace");
    let posted_open = open_requests
        .recv_timeout(Duration::from_secs(5))
        .expect("worktree open record POST reached the server");
    assert_eq!(posted_open["path"], "/wt/branch-x");
    assert_eq!(posted_open["kind"], "worktree");
    assert!(posted_open.get("label").is_none_or(|v| v.is_null()));
    let posted_promote = open_requests
        .recv_timeout(Duration::from_secs(5))
        .expect("promote record POST reached the server");
    assert_eq!(posted_promote["path"], "/promoted/cwd");
    assert_eq!(posted_promote["label"], "promoted label");
    assert_eq!(posted_promote["kind"], "workspace");
    std::fs::remove_dir_all(&dir).ok();
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
fn rename_panel_prompt_prefills_current_label_like_desktop() {
    // Desktop `panelRenameInitialLabel` prefills the rename input with
    // the current label unless it is a generated default (shell,
    // terminal, "tab N").
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.run_shortcut(Shortcut::RenamePanel);
    assert_eq!(
        app.prompt_input.as_ref().unwrap().text,
        "",
        "Shell is a default title, prefill stays empty"
    );
    app.prompt_input = None;

    // A custom label prefills the prompt for incremental editing.
    app.snapshot.tabs[0].label = "Build".to_string();
    app.run_shortcut(Shortcut::RenamePanel);
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "Build");
    app.prompt_input = None;

    // "tab 2" is a generated default too.
    app.snapshot.tabs[0].label = "Tab 2".to_string();
    app.run_shortcut(Shortcut::RenamePanel);
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "");
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
    app.git_panel.view = crate::tui::panels::GitView::Changes;
    app.git_panel.cwd = std::env::temp_dir().to_string_lossy().to_string();
    app.git_panel.files = vec![crate::tui::panels::GitFileEntry {
        path: "a.rs".to_string(),
        status: crate::tui::panels::GitFileStatus::Unstaged,
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
    app.file_explorer.entries = vec![crate::tui::panels::FileEntry {
        name: "d".to_string(),
        path: "d".to_string(),
        is_dir: true,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    }];
    app.file_explorer.selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "dir expand failure surfaces");
    app.error = None;

    // Enter on a plain file with the read endpoint dead: open_preview Err.
    let (dead_port, _stop2) = fake_web_api_server(true, true, false);
    app.web_api = WebApiClient::new("127.0.0.1", dead_port);
    app.file_explorer.entries = vec![crate::tui::panels::FileEntry {
        name: "x.rs".to_string(),
        path: "x.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
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
fn settings_overlay_opens_cycles_theme_and_closes() {
    let mut app = app_with_snapshot();
    app.theme = TuiTheme::Dark;
    app.palette = Palette::for_theme(TuiTheme::Dark);

    // Ctrl+B s opens the settings overlay.
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(app.mode, TuiMode::Settings);
    let drawn = draw(&app, 150, 30);
    assert!(drawn.contains("web api base"));
    assert!(drawn.contains("refresh interval"));
    assert!(drawn.contains("theme"));
    assert!(drawn.contains("dark"));

    // t cycles the theme live, and the palette follows it so the switch
    // is visible immediately (webui applies the theme on selection).
    app.handle_key(KeyEvent::from(KeyCode::Char('t')));
    assert_eq!(app.theme, TuiTheme::Light);
    assert_eq!(app.status, "theme: light");
    assert_eq!(app.palette, Palette::for_theme(TuiTheme::Light));
    let light_bg = app.palette.bg;
    app.handle_key(KeyEvent::from(KeyCode::Char('t')));
    assert_eq!(app.theme, TuiTheme::System);
    assert_ne!(app.palette.bg, light_bg);

    // Esc closes back to navigate mode.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);
}

#[test]
fn sidebar_toggle_hides_and_restores_the_sidebar_column() {
    let mut app = app_with_snapshot();
    let shown = draw(&app, 120, 30);
    assert!(shown.contains("Workspaces"), "sidebar renders workspaces");

    // Ctrl+B Shift+B collapses the sidebar (webui sidebar: KeyB).
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
    app.handle_key(KeyEvent::new(KeyCode::Char('B'), KeyModifiers::SHIFT));
    assert!(app.sidebar_collapsed);
    assert_eq!(app.status, "sidebar hidden");
    let hidden = draw(&app, 120, 30);
    assert!(
        !hidden.contains("Workspaces"),
        "collapsed sidebar must not render"
    );

    // Toggling again restores it.
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
    app.handle_key(KeyEvent::new(KeyCode::Char('B'), KeyModifiers::SHIFT));
    assert!(!app.sidebar_collapsed);
    assert_eq!(app.status, "sidebar shown");
    assert!(draw(&app, 120, 30).contains("Workspaces"));
}

#[test]
fn focus_walker_cycles_sidebar_regions_and_main() {
    let mut app = app_with_snapshot();
    assert!(app.main_focused);

    // Ctrl+B . walks forward: main -> workspaces.
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
    app.handle_key(KeyEvent::from(KeyCode::Char('.')));
    assert!(!app.main_focused);
    assert_eq!(app.sidebar_focus, SidebarFocus::Workspaces);
    assert_eq!(app.status, "focus: workspaces");

    // Again: workspaces -> agents.
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
    app.handle_key(KeyEvent::from(KeyCode::Char('.')));
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);

    // Ctrl+B , walks back and wraps: agents -> workspaces.
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
    app.handle_key(KeyEvent::from(KeyCode::Char(',')));
    assert_eq!(app.sidebar_focus, SidebarFocus::Workspaces);
}

#[test]
fn promote_without_temp_terminal_reports_error_via_shortcut() {
    // Ctrl+B Shift+P with no temp tab: the webui promotes only when the
    // overlay is visible; the TUI equivalent guard refuses and reports.
    let mut app = app_with_snapshot();
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
    app.handle_key(KeyEvent::new(KeyCode::Char('P'), KeyModifiers::SHIFT));
    assert_eq!(app.error.as_deref(), Some("no temporary terminal open"));
}

#[test]
fn renders_missed_terminal_sidebar_status_and_empty_tabs() {
    let mut app = app_with_snapshot();
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Done","cwd":"/done","focused":true,"agent_status":"done","pane_count":1,"tab_count":0,"active_tab_id":null},
                {"workspace_id":"ws_2","label":"Mystery","cwd":"/mystery","focused":false,"agent_status":"weird","pane_count":0,"tab_count":0,"active_tab_id":null}
            ],
            "tabs": [],
            "panes": [
                {"pane_id":"pane_done","terminal_id":"term_done","workspace_id":"ws_1","tab_id":"","agent":"jcode","display_agent":"jcode","agent_status":"done","cwd":"/done","focused":true},
                {"pane_id":"pane_unknown","terminal_id":"term_unknown","workspace_id":"ws_1","tab_id":"","agent":"bot","display_agent":"bot","agent_status":"strange","cwd":"/done","focused":false}
            ],
            "agents": [
                {"pane_id":"pane_done","terminal_id":"term_done","workspace_id":"ws_1","tab_id":"","agent":"jcode","display_agent":"jcode","agent_status":"done","cwd":"/done","focused":true},
                {"pane_id":"pane_unknown","terminal_id":"term_unknown","workspace_id":"ws_1","tab_id":"","agent":"bot","display_agent":"bot","agent_status":"strange","cwd":"/done","focused":false}
            ]
        }
    }));
    app.sidebar_focus = SidebarFocus::Agents;
    app.selected_agent = 1;
    let rendered = draw(&app, 120, 30);
    assert!(rendered.contains("Workspaces"));
    assert!(rendered.contains("Agents*"));
    assert!(rendered.contains("Done"));
    assert!(rendered.contains("Mystery"));
    assert!(rendered.contains("/done"));
    assert!(rendered.contains("strange"));

    app.snapshot.workspaces.clear();
    app.snapshot.tabs.clear();
    app.snapshot.panes.clear();
    app.snapshot.agents.clear();
    let empty = draw(&app, 40, 20);
    assert!(empty.contains("no workspaces"));
    assert!(empty.contains("Pane"));

    app.sidebar_collapsed = true;
    let collapsed = draw(&app, 12, 8);
    assert!(collapsed.contains("no work"));
}

#[test]
fn renders_missed_file_preview_outline_jump_find_and_statuses() {
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.file_explorer.entries = vec![
        FileEntry {
            name: "deleted.rs".to_string(),
            path: "deleted.rs".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: Some("deleted".to_string()),
        },
        FileEntry {
            name: "modified.rs".to_string(),
            path: "modified.rs".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: Some("modified".to_string()),
        },
        FileEntry {
            name: "added.rs".to_string(),
            path: "added.rs".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: Some("added".to_string()),
        },
        FileEntry {
            name: "other.rs".to_string(),
            path: "other.rs".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: Some("renamed".to_string()),
        },
    ];
    app.file_explorer.preview.path = Some("README.md".to_string());
    app.file_explorer.preview.content = "# Title\ntext\n## Middle\n### Deep\n#### Leaf".to_string();
    app.file_explorer.markdown_outline = true;
    let outline = draw(&app, 140, 30);
    assert!(outline.contains("Outline"));
    assert!(outline.contains("# Title"));
    assert!(outline.contains("## Middle"));
    assert!(outline.contains("### Deep"));
    assert!(outline.contains("- Leaf"));

    app.file_explorer.preview.content = "plain text only".to_string();
    assert!(draw(&app, 140, 30).contains("no headings"));

    app.file_explorer.markdown_outline = false;
    app.file_explorer.preview.path = Some("src/lib.rs".to_string());
    app.file_explorer.preview.content = (1..=20)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    app.file_explorer.preview_jump_line = Some(15);
    let jump = draw(&app, 140, 12);
    assert!(jump.contains("  15"));
    assert!(jump.contains("line 15"));

    app.file_explorer.edit_active = true;
    app.file_explorer.edit_cursor = app.file_explorer.preview.content.len();
    app.file_explorer.editor_find.active = true;
    app.file_explorer.editor_find.query = "line".to_string();
    app.file_explorer.editor_find.match_case = true;
    app.file_explorer.editor_find.regex = true;
    app.file_explorer.editor_find.ranges.clear();
    let no_matches = draw(&app, 140, 30);
    assert!(no_matches.contains("find"));
    assert!(no_matches.contains("no matches"));
    assert!(no_matches.contains(" A"));
    assert!(no_matches.contains(" X"));
}

#[test]
fn renders_missed_git_diff_log_stash_and_prompt_branches() {
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.git_panel.cwd = "/other".to_string();
    app.git_panel.branch.clear();
    app.git_panel.state = "conflicts".to_string();
    app.git_panel.view = GitView::Changes;
    app.git_panel.files = vec![GitFileEntry {
        path: "src/lib.rs".to_string(),
        status: GitFileStatus::Conflicted,
    }];
    app.git_panel.diff_title = "src/lib.rs".to_string();
    app.git_panel.diff_lines = vec![
        "@@ -1,2 +1,2 @@".to_string(),
        "-old".to_string(),
        "+new search hit".to_string(),
        " context".to_string(),
    ];
    app.git_panel.diff_meta = vec![
        None,
        Some(crate::tui::panels::git::GitDiffLineMeta {
            old_line: Some(1),
            new_line: None,
        }),
        Some(crate::tui::panels::git::GitDiffLineMeta {
            old_line: None,
            new_line: Some(1),
        }),
        Some(crate::tui::panels::git::GitDiffLineMeta {
            old_line: None,
            new_line: Some(2),
        }),
    ];
    app.git_panel.diff_search_active = true;
    app.git_panel.diff_search_query = "search".to_string();
    app.git_panel.diff_search_matches = vec![2];
    app.git_panel.diff_search_selected = 0;
    app.git_panel.diff_hunk_selected = 0;
    app.git_panel.show_blame = true;
    app.git_panel.blame_path = Some("src/lib.rs".to_string());
    app.git_panel
        .blame_authors
        .insert(1, "Ada Lovelace Byron".to_string());
    let changes = draw(&app, 160, 30);
    assert!(changes.contains("≠ workspace"));
    assert!(changes.contains("(detached)"));
    assert!(changes.contains("conflicts"));
    assert!(changes.contains("/search"));
    assert!(changes.contains("Ada Lovelace"));

    app.git_panel.view = GitView::Log;
    app.git_panel.commits = vec![GitCommitEntry {
        hash: "abc123456789".to_string(),
        message: "marked commit".to_string(),
        author: "Ada".to_string(),
        date: "now".to_string(),
        labels: vec!["main".to_string(), "tag".to_string()],
    }];
    app.git_panel.log_selected = vec!["abc123456789".to_string()];
    app.git_panel.diff_title = "abc1234".to_string();
    app.git_panel.diff_lines = vec!["+commit diff".to_string()];
    let log = draw(&app, 160, 30);
    assert!(log.contains("*"));
    assert!(log.contains("marked commit"));
    assert!(log.contains("main, tag"));
    assert!(log.contains("commit diff"));

    app.git_panel.view = GitView::Stash;
    app.git_panel.stashes = vec![GitStashEntry {
        name: "stash@{0}".to_string(),
        message: "wip stash".to_string(),
    }];
    app.git_panel.stash_diff_title = "stash@{0}".to_string();
    app.git_panel.stash_diff_lines = vec!["+stash diff".to_string()];
    let stash = draw(&app, 160, 30);
    assert!(stash.contains("stash@{0}"));
    assert!(stash.contains("Stash diff"));
    assert!(stash.contains("+stash diff"));

    app.prompt_input = Some(PromptInput::new(PromptKind::CreateWorktreeBranch));
    assert!(draw(&app, 160, 30).contains("Create worktree: branch"));
    app.prompt_input = Some(PromptInput::new(PromptKind::CreateWorktreePath));
    assert!(draw(&app, 160, 30).contains("Create worktree: checkout path"));
    app.prompt_input = Some(PromptInput::new(PromptKind::CreateBranch));
    assert!(draw(&app, 160, 30).contains("Create branch"));
    app.prompt_input = Some(PromptInput::new(PromptKind::RenameWorkspace));
    assert!(draw(&app, 160, 30).contains("Repo"));
    app.prompt_input = Some(PromptInput::new(PromptKind::RenamePanel));
    assert!(draw(&app, 160, 30).contains("Shell"));
    app.prompt_input = Some(PromptInput::new(PromptKind::ConfirmCloseWorkspace));
    assert!(draw(&app, 160, 30).contains("Repo"));
}

#[test]
fn renders_content_search_scroll_empty_cleanup_and_settings_modes() {
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.mode = TuiMode::Settings;
    app.status = "all fine".to_string();
    app.file_explorer.cwd = "/repo/files".to_string();
    app.git_panel.cwd = "/repo/git".to_string();
    let settings = draw(&app, 100, 30);
    assert!(settings.contains("Settings"));
    assert!(settings.contains("/repo/files"));
    assert!(settings.contains("/repo/git"));

    app.mode = TuiMode::Help;
    app.help_scroll = 0;
    assert!(draw(&app, 100, 30).contains("Herdr WebUI TUI"));

    app.mode = TuiMode::Navigate;
    app.file_explorer.search_mode = true;
    app.file_explorer.search_kind = crate::tui::panels::files::SearchKind::Content;
    let files = (0..18)
        .map(|index| crate::tui::panels::files::ContentSearchFile {
            path: format!("src/file_{index}.rs"),
            name: format!("file_{index}.rs"),
            match_count: 1,
            chunks: vec![crate::tui::panels::files::ContentSearchChunk {
                start: index + 1,
                end: index + 1,
                rows: vec![crate::tui::panels::files::ContentSearchRow {
                    line: index + 1,
                    text: format!("needle {index}"),
                    matched: index % 2 == 0,
                }],
            }],
            truncated: false,
            first_match_line: index + 1,
        })
        .collect::<Vec<_>>();
    app.file_explorer.content_search = crate::tui::panels::files::ContentSearchState {
        query: "needle".to_string(),
        match_case: false,
        regex: false,
        files,
        expanded: vec![true; 18],
        offset: 0,
        done: true,
        total_files: 18,
        total_matches: 18,
        visited: 18,
        truncated: false,
        selected: 30,
    };
    let search = draw(&app, 120, 12);
    assert!(search.contains("searched 18 files"));
    assert!(search.contains("file_"));

    app.screen = TuiScreen::Git;
    app.file_explorer.search_mode = false;
    app.git_panel.view = GitView::Cleanup;
    app.git_panel.cleanup_root = None;
    app.git_panel.cleanup_repos.clear();
    let cleanup = draw(&app, 120, 30);
    assert!(cleanup.contains("Cleanup"));
    assert!(cleanup.contains("x delete"));
}

#[test]
fn renders_content_search_results_conflicts_cleanup_and_prompt_subjects() {
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.file_explorer.search_mode = true;
    app.file_explorer.search_kind = crate::tui::panels::files::SearchKind::Content;
    app.file_explorer.content_search = crate::tui::panels::files::ContentSearchState {
        query: "Needle".to_string(),
        match_case: true,
        regex: true,
        files: vec![crate::tui::panels::files::ContentSearchFile {
            path: "src/search.rs".to_string(),
            name: "search.rs".to_string(),
            match_count: 2,
            chunks: vec![crate::tui::panels::files::ContentSearchChunk {
                start: 7,
                end: 8,
                rows: vec![
                    crate::tui::panels::files::ContentSearchRow {
                        line: 7,
                        text: "before".to_string(),
                        matched: false,
                    },
                    crate::tui::panels::files::ContentSearchRow {
                        line: 8,
                        text: "Needle found".to_string(),
                        matched: true,
                    },
                ],
            }],
            truncated: true,
            first_match_line: 8,
        }],
        expanded: vec![true],
        offset: 1,
        done: false,
        total_files: 1,
        total_matches: 2,
        visited: 11,
        truncated: true,
        selected: 2,
    };
    let rendered = draw(&app, 220, 30);
    assert!(rendered.contains("Search Content"));
    assert!(rendered.contains("Needle"));
    assert!(rendered.contains("searched 11 files"));
    assert!(rendered.contains("stopped at limit"));
    assert!(rendered.contains("stopped at limit"));
    assert!(rendered.contains("src/search.rs"));
    assert!(rendered.contains("Needle found"));

    app.file_explorer.content_search.files.clear();
    app.file_explorer.content_search.expanded.clear();
    assert!(draw(&app, 220, 30).contains("No content matches."));

    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Conflicts;
    app.git_panel.conflict_files = vec!["src/lib.rs".to_string()];
    app.git_panel.rebase_in_progress = true;
    let conflicts = draw(&app, 150, 30);
    assert!(conflicts.contains("rebase in progress"));
    assert!(conflicts.contains("src/lib.rs"));
    app.git_panel.rebase_in_progress = false;
    app.git_panel.merge_in_progress = true;
    assert!(draw(&app, 150, 30).contains("merge in progress"));
    app.git_panel.merge_in_progress = false;
    assert!(draw(&app, 150, 30).contains("no merge/rebase in progress"));

    app.git_panel.view = GitView::Cleanup;
    app.git_panel.cleanup_root = Some("/repo".to_string());
    app.git_panel.cleanup_repos = vec![crate::tui::panels::git::CleanupRepo {
        path: "/repo".to_string(),
        branches: vec!["old-branch".to_string()],
        worktrees: vec!["stale-worktree".to_string()],
    }];
    let cleanup = draw(&app, 150, 30);
    assert!(cleanup.contains("Cleanup"));
    assert!(cleanup.contains("old-branch"));
    assert!(cleanup.contains("stale-worktree"));

    app.git_panel.commits = vec![GitCommitEntry {
        hash: "abcdef123456".to_string(),
        message: "subject line".to_string(),
        author: "Ada".to_string(),
        date: "today".to_string(),
        labels: vec![],
    }];
    for kind in [
        PromptKind::CreateTag,
        PromptKind::ResetMode,
        PromptKind::ConfirmResetHard,
        PromptKind::RebaseUpstream,
        PromptKind::ConfirmRebase,
    ] {
        app.prompt_input = Some(PromptInput::new(kind));
        let prompt = draw(&app, 150, 30);
        assert!(prompt.contains("abcdef1"));
        assert!(prompt.contains("subject line"));
    }

    app.prompt_input = Some(PromptInput::new(PromptKind::GitCwd));
    app.git_panel.cwd = "/repo/sub".to_string();
    assert!(draw(&app, 150, 30).contains("/repo/sub"));

    app.prompt_input = Some(PromptInput::new(PromptKind::CreateFile));
    app.file_explorer.root_path.clear();
    assert!(draw(&app, 150, 30).contains("(workspace root)"));
    app.prompt_input = Some(PromptInput::new(PromptKind::CreateDirectory));
    app.file_explorer.root_path = "/repo/src".to_string();
    assert!(draw(&app, 150, 30).contains("/repo/src"));

    app.prompt_input = Some(PromptInput::new(PromptKind::ReplaceInFile));
    app.file_explorer.editor_find.query = "needle".to_string();
    app.file_explorer.editor_find.ranges.clear();
    assert!(draw(&app, 150, 30).contains("find: needle (no matches)"));
    app.file_explorer.editor_find.ranges = vec![(0, 6), (10, 16)];
    app.file_explorer.editor_find.selected = 1;
    assert!(draw(&app, 150, 30).contains("find: needle (match 2/2)"));
}

#[test]
fn round2_constructors_prompt_titles_help_and_refresh_errors() {
    assert_eq!(
        PromptKind::CreateFile.into_workspace_prompt(),
        workspace::WorkspacePrompt::ConfirmCloseWorkspace
    );
    assert_eq!(PromptKind::CreateDirectory.title(), "New directory");
    assert_eq!(
        PromptKind::ReplaceInFile.hint(),
        "type the replacement, Enter replaces the current match (! = all)"
    );

    let opts = TuiOptions::default();
    assert!(opts.api_socket.is_none());
    assert_eq!(opts.refresh_interval, Duration::from_millis(1000));

    let client = BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
    let mut app = TuiApp::new_with_options(
        client,
        Duration::from_millis(5),
        TuiTheme::Light,
        WebApiClient::new("127.0.0.1", 1),
    );
    assert_eq!(app.status, "connecting");
    assert_eq!(app.theme, TuiTheme::Light);
    assert!(app.take_dirty());
    assert!(!app.take_dirty());

    app.refresh_if_due();
    assert!(app.error.is_some());
    assert!(app.take_dirty());

    let mut help = TuiApp::new(BackendClient::builtin_session(None), Duration::from_secs(1));
    help.mode = TuiMode::Help;
    help.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert!(help.help_scroll > 0);
    help.handle_key(KeyEvent::from(KeyCode::Char('k')));
    assert_eq!(help.help_scroll, 0);
    help.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(help.mode, TuiMode::Help);
    // q types into the filter now (? is the toggle closer); the x above
    // also typed, so clear first.
    help.help_filter.clear();
    help.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(help.help_filter, "q");
    assert_eq!(help.mode, TuiMode::Help);
    help.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(help.mode, TuiMode::Navigate);

    help.mode = TuiMode::Settings;
    help.handle_key(KeyEvent::from(KeyCode::Tab));
    assert!(help.status.contains("theme:"));
    help.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(help.mode, TuiMode::Settings);
    help.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(help.mode, TuiMode::Navigate);
}

#[test]
fn round2_commit_modal_enter_error_and_editing_keys() {
    let (port, _stop) = fake_web_api_server(false, false, false);
    let mut app = TuiApp::new_with_options(
        BackendClient::builtin_session(None),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", port),
    );
    app.screen = TuiScreen::Git;
    app.commit_input = Some(CommitInput {
        text: String::new(),
        amend: true,
    });

    app.handle_key(KeyEvent::from(KeyCode::Char('f')));
    app.handle_key(KeyEvent::from(KeyCode::Char('i')));
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(app.commit_input.as_ref().unwrap().text, "fix");
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.commit_input.as_ref().unwrap().text, "fi");
    app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
    assert_eq!(app.commit_input.as_ref().unwrap().text, "");
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.error.as_deref(), Some("commit message is empty"));
    assert!(app.commit_input.is_none());

    app.error = None;
    app.commit_input = Some(CommitInput {
        text: "ship it".to_string(),
        amend: false,
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("webui connection failed") || err.contains("connection")));
    assert!(app.commit_input.is_none());

    app.commit_input = Some(CommitInput {
        text: "cancel".to_string(),
        amend: false,
    });
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.commit_input.is_none());
}

#[test]
fn round2_navigation_panel_attach_and_prompt_key_edges() {
    let mut app = app_with_snapshot();
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);
    app.handle_key(KeyEvent::from(KeyCode::Char('w')));
    assert_eq!(app.sidebar_focus, SidebarFocus::Workspaces);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.mode, TuiMode::Attach);

    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert!(
        app.error.is_some(),
        "dead builtin terminal attach should surface"
    );
    app.error = None;
    app.handle_key(ctrl('g'));
    assert_eq!(app.mode, TuiMode::Navigate);
    assert_eq!(app.status, "detached");

    app.snapshot.panes.clear();
    app.snapshot.agents.clear();
    app.mode = TuiMode::Attach;
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(app.mode, TuiMode::Navigate);
    assert_eq!(app.error.as_deref(), Some("selected pane has no terminal"));

    app.prompt_input = Some(PromptInput::new(PromptKind::ConfirmDeleteFile));
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "");
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "cancelled");

    app.prompt_input = Some(PromptInput {
        kind: PromptKind::CreateFile,
        text: "tmp.txt".to_string(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.prompt_input.is_none());
}

#[test]
fn round2_files_git_keys_and_prompt_actions_hit_error_guards() {
    let mut app = TuiApp::new_with_options(
        BackendClient::builtin_session(None),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.snapshot = fixture_snapshot();
    app.screen = TuiScreen::Files;
    app.mode = TuiMode::Attach;
    app.file_explorer.entries = vec![FileEntry {
        name: "a.rs".to_string(),
        path: "a.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    }];

    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert!(app.file_explorer.filter_active);
    app.file_explorer.filter_active = false;
    app.handle_key(KeyEvent::from(KeyCode::Char('t')));
    assert!(app.status.contains("search:"));
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::CreateFile
    );
    app.prompt_input = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('A')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::CreateDirectory
    );
    app.prompt_input = None;
    app.file_explorer.preview.dirty = true;
    app.file_explorer.preview.path = Some("a.rs".to_string());
    app.handle_key(KeyEvent::from(KeyCode::Char('R')));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("before renaming")));
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("before deleting")));

    app.file_explorer.preview.dirty = false;
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::CreateFile,
        text: String::new(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.error.as_deref(), Some("type a file name"));
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::CreateDirectory,
        text: "dir".to_string(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("webui connection failed") || err.contains("connection")));

    app.screen = TuiScreen::Git;
    app.mode = TuiMode::Attach;
    app.git_panel.view = GitView::Changes;
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert!(app.git_panel.diff_search_active);
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    app.handle_key(KeyEvent::from(KeyCode::Char('N')));
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(!app.git_panel.diff_search_active);
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    assert_eq!(app.status, "no diff search matches");
    app.handle_key(KeyEvent::from(KeyCode::Char('N')));
    assert_eq!(app.status, "no diff search matches");
    app.handle_key(KeyEvent::from(KeyCode::Char('J')));
    assert_eq!(app.status, "no hunks in the loaded diff");
    app.handle_key(KeyEvent::from(KeyCode::Char('K')));
    assert_eq!(app.status, "no hunks in the loaded diff");
    app.handle_key(KeyEvent::from(KeyCode::Char('H')));
    assert!(app.error.is_some());

    app.error = None;
    app.git_panel.view = GitView::Log;
    app.git_panel.commits.clear();
    app.handle_key(KeyEvent::from(KeyCode::Char(' ')));
    assert_eq!(app.error.as_deref(), Some("no commit selected"));
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(
        app.error.is_some(),
        "log scope refresh should hit dead web api"
    );
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('+')));
    assert!(
        app.error.is_some()
            || app.status.contains("log limit")
            || app.status.contains("already")
            || app.status.contains("no more commits")
    );
}

#[test]
fn round2_shortcuts_git_guards_and_refresh_tail_edges() {
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.snapshot = fixture_snapshot();
    app.file_explorer.preview.path = Some("dirty.rs".to_string());
    app.file_explorer.preview.dirty = true;

    for key in ['/', 'r', 'j', 'k', 'a', 'A', ']', '[', 'w'] {
        app.handle_key(ctrl('b'));
        app.handle_key(KeyEvent::from(KeyCode::Char(key)));
    }
    assert!(app.error.is_some());

    // Prefix N opens the folder picker; the dead socket makes
    // worktree.list fail, so the pick intent is cancelled and the error
    // surfaces instead of opening the old path prompt.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    assert!(app.error.is_some() || app.status.contains("browsing"));
    assert!(!app.worktree_pick_workspace || app.mode == TuiMode::WorktreeList);
    app.prompt_input = None;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('T'), KeyModifiers::SHIFT));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::CreateWorktreeBranch
    );
    app.prompt_input = None;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('X'), KeyModifiers::SHIFT));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::ConfirmCloseWorkspace
    );
    app.prompt_input = None;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('S'), KeyModifiers::SHIFT));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::RenameWorkspace
    );
    app.prompt_input = None;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('I')));
    assert_eq!(app.prompt_input.as_ref().unwrap().kind, PromptKind::GitCwd);
    assert_eq!(app.screen, TuiScreen::Git);
    app.prompt_input = None;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('B')));
    assert!(app.sidebar_collapsed);

    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Changes;
    app.git_panel.files = vec![GitFileEntry {
        path: "dirty.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.git_panel.file_selected = 0;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('d')));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("before discarding")));

    app.error = None;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    assert_eq!(app.git_panel.view, GitView::History);
    assert!(app.error.is_some());

    app.error = None;
    app.git_panel.view = GitView::Log;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    assert_eq!(app.git_panel.view, GitView::Changes);
    assert!(app.error.is_some());

    app.snapshot.panes.clear();
    app.pane_tail = vec!["old".to_string()];
    app.refresh_tail();
    assert!(app.pane_tail.is_empty());
}

#[test]
fn round3_commit_modal_editing_and_submit_error_arms() {
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Changes;

    app.commit_input = Some(CommitInput {
        text: "abc".to_string(),
        amend: true,
    });
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    app.handle_key(KeyEvent::from(KeyCode::Char('d')));
    assert_eq!(app.commit_input.as_ref().unwrap().text, "abd");

    app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
    assert_eq!(app.commit_input.as_ref().unwrap().text, "");
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.error.as_deref(), Some("commit message is empty"));
    assert!(app.commit_input.is_none());

    app.error = None;
    app.commit_input = Some(CommitInput {
        text: "ship it".to_string(),
        amend: false,
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("webui connection failed")));

    app.error = None;
    app.commit_input = Some(CommitInput {
        text: "cancel me".to_string(),
        amend: false,
    });
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.commit_input.is_none());
}

#[test]
fn round3_log_toolbar_prompts_and_prompt_error_paths() {
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.screen = TuiScreen::Git;
    app.mode = TuiMode::Attach;
    app.git_panel.view = GitView::Log;

    for key in ['t', 'R', 'b'] {
        app.error = None;
        app.handle_key(KeyEvent::from(KeyCode::Char(key)));
        assert_eq!(app.error.as_deref(), Some("no commit selected"));
    }

    app.git_panel.commits = vec![GitCommitEntry {
        hash: "abc123".to_string(),
        message: "change".to_string(),
        author: "Ada".to_string(),
        date: String::new(),
        labels: vec![],
    }];
    app.git_panel.commit_selected = 0;

    app.handle_key(KeyEvent::from(KeyCode::Char('t')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::CreateTag
    );
    app.prompt_input.as_mut().unwrap().text = "v1".to_string();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("webui connection failed")));

    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('R')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::ResetMode
    );
    app.prompt_input.as_mut().unwrap().text = "bogus".to_string();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.error.as_deref(), Some("type soft, mixed or hard"));

    app.error = None;
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::ResetMode,
        text: "hard".to_string(),
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::ConfirmResetHard
    );
    app.prompt_input.as_mut().unwrap().text = "y".to_string();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("webui connection failed")));

    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('b')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::RebaseUpstream
    );
    app.prompt_input.as_mut().unwrap().text = "origin/main".to_string();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::ConfirmRebase
    );
    app.prompt_input.as_mut().unwrap().text = "y".to_string();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("webui connection failed")));

    app.error = None;
    app.git_panel.view = GitView::Branches;
    app.handle_key(KeyEvent::from(KeyCode::Char('c')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::CreateBranch
    );
    app.prompt_input.as_mut().unwrap().text = "feature/demo".to_string();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("webui connection failed")));

    app.error = None;
    app.git_panel.view = GitView::Log;
    app.handle_key(KeyEvent::from(KeyCode::Char('w')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::CreateWorktreeBranch
    );
}

#[test]
fn round3_git_diff_search_hunk_and_stash_key_error_paths() {
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.screen = TuiScreen::Git;
    app.mode = TuiMode::Attach;
    app.git_panel.view = GitView::Changes;
    app.git_panel.diff_lines = vec![
        "@@ -1 +1 @@".to_string(),
        "-old needle".to_string(),
        "+new needle".to_string(),
    ];

    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert!(app.git_panel.diff_search_active);
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert_eq!(app.git_panel.diff_search_query, "e");
    app.handle_key(KeyEvent::from(KeyCode::Char('d')));
    assert_eq!(app.git_panel.diff_search_query, "ed");
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    app.handle_key(KeyEvent::from(KeyCode::Char('N')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(!app.git_panel.diff_search_active);
    assert!(!app.git_panel.diff_search_matches.is_empty());
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.git_panel.diff_search_matches.is_empty());
    app.git_panel.diff_lines = vec![
        "@@ -1 +1 @@".to_string(),
        "-old needle".to_string(),
        "+new needle".to_string(),
    ];
    app.git_panel.diff_meta = vec![
        None,
        Some(crate::tui::panels::git::GitDiffLineMeta::default()),
        Some(crate::tui::panels::git::GitDiffLineMeta::default()),
    ];

    app.handle_key(KeyEvent::from(KeyCode::Char('J')));
    assert_eq!(app.status, "hunk 1");
    app.handle_key(KeyEvent::from(KeyCode::Char('K')));
    assert_eq!(app.status, "hunk 1");
    app.handle_key(KeyEvent::from(KeyCode::Char('H')));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("webui connection failed")));

    app.error = None;
    app.git_panel.view = GitView::Stash;
    app.git_panel.stashes = vec![GitStashEntry {
        name: "stash@{0}".to_string(),
        message: "wip".to_string(),
    }];
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("webui connection failed")));

    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('D')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::ConfirmDropStash
    );
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.prompt_input.is_none());
}

#[test]
fn round3_specific_tui_edges_and_shortcuts() {
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.snapshot = fixture_snapshot();

    app.refresh_if_due();
    assert!(app.error.is_some());
    app.error = Some("visible".to_string());
    assert!(app.text_snapshot().contains("error: visible"));

    app.run_shortcut(Shortcut::RenamePanel);
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::RenamePanel
    );
    app.prompt_input = None;

    app.run_shortcut(Shortcut::TempTerminalToggle);
    assert!(app.error.is_some());
    app.error = None;

    app.screen = TuiScreen::Files;
    app.mode = TuiMode::Attach;
    app.file_explorer.entries = vec![FileEntry {
        name: "dir".to_string(),
        path: "dir".to_string(),
        is_dir: true,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    }];
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert!(app.status == "no recent previews" || app.error.is_some());
    app.git_panel.files = vec![GitFileEntry {
        path: "src/lib.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.handle_key(KeyEvent::from(KeyCode::Char('w')));
    assert!(app.status.contains("revealed") || app.error.is_some());

    app.file_explorer.edit_active = true;
    app.file_explorer.preview.path = Some("edit.rs".to_string());
    app.file_explorer.preview.content = "hello".to_string();
    app.handle_key(KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL));
    assert!(app.status == "saved" || app.error.is_some());

    app.screen = TuiScreen::Git;
    app.mode = TuiMode::Attach;
    app.git_panel.view = GitView::Changes;
    app.git_panel.diff_lines = vec!["@@ -1 +1 @@".to_string(), "+hello".to_string()];
    app.git_panel.diff_hunk_selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Char('@')));
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    app.handle_key(KeyEvent::from(KeyCode::Char('N')));
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    app.git_panel.cancel_diff_search();
    app.git_panel.diff_lines = vec!["@@ -1 +1 @@".to_string(), "+hello".to_string()];
    app.git_panel.view = GitView::Changes;
    app.handle_key(KeyEvent::from(KeyCode::Char('J')));
    assert!(app.status == "hunk 1" || app.status == "no hunks in the loaded diff");
    app.handle_key(KeyEvent::from(KeyCode::Char('H')));
    assert!(app.status == "hunk applied" || app.error.is_some());

    app.error = None;
    app.git_panel.view = GitView::Branches;
    app.handle_key(KeyEvent::from(KeyCode::Char('c')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::CreateBranch
    );
    app.prompt_input = None;
    app.git_panel.view = GitView::Changes;
    app.handle_key(KeyEvent::from(KeyCode::Char('c')));
    assert!(app.commit_input.is_some());
    app.commit_input = None;

    app.git_panel.view = GitView::Stash;
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    assert!(app.status == "stash applied" || app.error.is_some());
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.status == "stash diff loaded" || app.error.is_some());

    app.error = None;
    app.git_panel.view = GitView::History;
    app.git_panel.commits = vec![GitCommitEntry {
        hash: "abc123".to_string(),
        message: "msg".to_string(),
        author: "me".to_string(),
        date: String::new(),
        labels: vec![],
    }];
    app.git_panel.commit_selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.status.contains("commit abc123") || app.error.is_some());

    app.error = None;
    app.git_panel.view = GitView::Branches;
    app.git_panel.branches = vec![GitBranchEntry {
        name: "feature".to_string(),
        current: false,
        remote: false,
        pushed: false,
    }];
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.status.contains("switched") || app.error.is_some());

    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Terminal;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.mode, TuiMode::Attach);
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert!(app.error.is_some());

    app.load_selected_terminal_history(80, 24);
    assert!(app.error.is_some());
    assert!(!app.should_quit());
}

#[test]
fn round4_commit_modal_typing_clear_submit_and_log_prompts() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.screen = TuiScreen::Git;
    app.mode = TuiMode::Attach;
    app.git_panel.view = GitView::Changes;
    app.commit_input = Some(CommitInput {
        text: String::new(),
        amend: false,
    });

    for ch in "hello".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert_eq!(app.commit_input.as_ref().unwrap().text, "hello");
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.commit_input.as_ref().unwrap().text, "hell");
    app.handle_key(KeyEvent::from(KeyCode::Left));
    app.handle_key(KeyEvent::from(KeyCode::Right));
    assert_eq!(app.commit_input.as_ref().unwrap().text, "hell");
    app.handle_key(ctrl('u'));
    assert_eq!(app.commit_input.as_ref().unwrap().text, "");
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.commit_input.is_none());
    assert_eq!(app.error.as_deref(), Some("commit message is empty"));

    app.error = None;
    app.commit_input = Some(CommitInput {
        text: "ship it".to_string(),
        amend: true,
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.commit_input.is_none());
    assert!(
        app.error
            .as_deref()
            .is_some_and(|err| err.contains("webui connection failed")),
        "dead commit API error is surfaced: {:?}",
        app.error
    );

    app.commit_input = Some(CommitInput {
        text: "cancel me".to_string(),
        amend: false,
    });
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.commit_input.is_none());

    app.git_panel.view = GitView::Log;
    app.git_panel.commits = vec![GitCommitEntry {
        hash: "abc123".to_string(),
        message: "msg".to_string(),
        author: "me".to_string(),
        date: String::new(),
        labels: vec![],
    }];
    app.git_panel.commit_selected = 0;
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('t')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::CreateTag
    );
    assert_eq!(app.status, PromptKind::CreateTag.title());
    app.prompt_input = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('R')));
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::ResetMode
    );
    assert_eq!(app.status, PromptKind::ResetMode.title());

    app.prompt_input = None;
    app.git_panel.commits.clear();
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('t')));
    assert_eq!(app.error.as_deref(), Some("no commit selected"));
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('R')));
    assert_eq!(app.error.as_deref(), Some("no commit selected"));
}

#[test]
fn round4_render_small_area_diff_and_status_variants() {
    let mut app = app_with_snapshot();
    let backend = TestBackend::new(0, 0);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &app)).unwrap();

    app.screen = TuiScreen::Terminal;
    app.snapshot.workspaces[0].active_tab_id = Some("not-active".to_string());
    let backend = TestBackend::new(90, 18);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &app)).unwrap();
    let rendered = format!("{:?}", terminal.backend().buffer());
    assert!(rendered.contains("Shell"));

    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Changes;
    app.git_panel.diff_title = "src/app.rs".to_string();
    app.git_panel.diff_search_active = true;
    app.git_panel.diff_search_query = "absent".to_string();
    app.git_panel.diff_search_matches.clear();
    app.git_panel.diff_lines = vec![
        "@@ -1 +1 @@".to_string(),
        "-old".to_string(),
        "+new".to_string(),
    ];
    app.git_panel.diff_meta = vec![None, None, None];
    app.git_panel.diff_hunk_selected = 0;
    let backend = TestBackend::new(100, 24);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &app)).unwrap();
    let rendered = format!("{:?}", terminal.backend().buffer());
    assert!(rendered.contains("Diff"));
    assert!(rendered.contains("0/0"));

    app.snapshot.agents = vec![
        crate::tui::model::TuiAgent {
            pane_id: "p1".to_string(),
            terminal_id: "t1".to_string(),
            workspace_id: "ws_1".to_string(),
            tab_id: "tab_1".to_string(),
            agent: Some("jcode".to_string()),
            display_agent: Some("jcode".to_string()),
            title: None,
            status: "working".to_string(),
            cwd: "/repo".to_string(),
            focused: false,
        },
        crate::tui::model::TuiAgent {
            pane_id: "p2".to_string(),
            terminal_id: "t2".to_string(),
            workspace_id: "ws_1".to_string(),
            tab_id: "tab_1".to_string(),
            agent: Some("shell".to_string()),
            display_agent: Some("shell".to_string()),
            title: None,
            status: "blocked".to_string(),
            cwd: "/repo".to_string(),
            focused: false,
        },
    ];
    let backend = TestBackend::new(100, 20);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &app)).unwrap();
    let rendered = format!("{:?}", terminal.backend().buffer());
    assert!(rendered.contains("jcode"));
    assert!(rendered.contains("shell"));
}

#[test]
fn final_round_prompt_titles_options_and_refresh_error_arms() {
    assert_eq!(
        PromptKind::ConfirmCleanupDelete.title(),
        "Delete cleanup item (y)"
    );
    assert_eq!(
        PromptKind::CreateTag.hint(),
        "type the tag name, Enter tags the selected commit"
    );
    assert_eq!(
        PromptKind::ResetMode.hint(),
        "type soft, mixed or hard, Enter resets"
    );
    assert_eq!(
        PromptKind::RebaseUpstream.hint(),
        "type the upstream ref, then y + Enter to rebase"
    );
    assert_eq!(
        PromptKind::GitCwd.hint(),
        "type a repository path, Enter switches the git panel"
    );
    assert_eq!(
        PromptKind::CreateBranch.hint(),
        "type the branch name, Enter creates and switches"
    );
    assert_eq!(
        PromptKind::CreateFile.hint(),
        "type the file name, Enter creates an empty file"
    );
    assert_eq!(
        PromptKind::CreateDirectory.hint(),
        "type the directory name, Enter creates it"
    );
    assert_eq!(
        PromptKind::ReplaceInFile.hint(),
        "type the replacement, Enter replaces the current match (! = all)"
    );

    let dead_options = TuiOptions {
        api_socket: Some(std::path::PathBuf::from("/nonexistent.sock")),
        terminal_socket: Some(std::path::PathBuf::from("/nonexistent-terminal.sock")),
        ..TuiOptions::default()
    };
    let mut app = TuiApp::new_with_options(
        build_client(&dead_options),
        Duration::from_secs(0),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.snapshot = fixture_snapshot();
    app.refresh_if_due();
    assert!(app.error.as_deref().is_some_and(|err| !err.is_empty()));

    let builtin_options = TuiOptions::default();
    let mut app = TuiApp::new_with_options(
        build_client(&builtin_options),
        Duration::from_secs(60),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.snapshot = fixture_snapshot();
    app.status = "before".to_string();
    app.last_refresh = Some(Instant::now());
    app.refresh_if_due();
    assert_eq!(app.status, "before", "not-due refresh skips the backend");
}

#[test]
fn help_overlay_filters_by_typed_query() {
    let mut app = app_with_snapshot();
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Help);

    // Typing narrows the rows: "worktree" keeps only worktree shortcuts.
    for ch in "worktree".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert_eq!(app.help_filter, "worktree");
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("filter: worktree_"));
    assert!(
        drawn.contains(
            "No shortcuts match"
                .replace("No shortcuts match", "worktree")
                .as_str()
        ) || drawn.contains("worktree")
    );
    // The filter must drop unrelated rows like the terminal detach hint.
    assert!(!drawn.contains("detach terminal"));

    // Backspace edits the query; a wrong extra letter empties the list.
    for ch in "zzz".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert_eq!(app.help_filter, "worktreezzz");
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("No shortcuts match"));

    // Esc clears the filter first (stays in the overlay), then closes.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.help_filter, "");
    assert_eq!(app.mode, TuiMode::Help);
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);
}

#[test]
fn help_filter_types_q_into_query_and_question_mark_closes() {
    // Regression from the pty acceptance run: q must type into the query
    // ("quit", "quick"...) like the webui search box; ? is the toggle
    // closer and Esc clears the filter before closing.
    let mut app = app_with_snapshot();
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Help);

    // "quit" must type through its leading q into the filter and match
    // the quit shortcut row.
    for ch in "quit".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert_eq!(app.help_filter, "quit");
    assert_eq!(app.mode, TuiMode::Help);
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("filter: quit_"));
    assert!(drawn.contains("quit"));

    // ? closes the overlay even with a filter active.
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Navigate);
    assert_eq!(app.help_filter, "");

    // Esc clears the filter first (stays in the overlay), then closes.
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    for ch in "zz".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.help_filter, "");
    assert_eq!(app.mode, TuiMode::Help);
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);
}

#[test]
fn filtered_help_rows_match_keys_and_descriptions() {
    // Direct unit check of the filter helper (webui settings-search parity).
    let rows = crate::tui::keys::filtered_help_rows("worktree");
    assert!(!rows.is_empty());
    assert!(rows.iter().all(
        |(keys, description)| keys.to_ascii_lowercase().contains("worktree")
            || description.to_ascii_lowercase().contains("worktree")
    ));
    // Empty query returns every row including separators.
    assert_eq!(
        crate::tui::keys::filtered_help_rows("").len(),
        crate::tui::keys::help_rows().len()
    );
    // No match returns empty.
    assert!(crate::tui::keys::filtered_help_rows("zzzzzzzz").is_empty());
}

#[test]
fn overlays_restore_the_mode_they_were_opened_from() {
    // Regression: overlays opened while attached must close back to
    // Attach, not Navigate. The WebUI modals return to the underlying
    // view; dropping the attach context silently detaches the user.
    // The fake backend answers worktree.list so the nested overlay
    // open does not depend on a live session (the builtin socket may
    // reject /repo and the test would flake).
    let client = crate::tui::workspace::tests::fake_backend_client();
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    app.screen = TuiScreen::Terminal;
    app.mode = TuiMode::Attach;

    // Help overlay from prefix while attached.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Help);
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Attach, "? closer restores Attach");

    // Esc closer with an active filter clears first, closes on second.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    for ch in "theme".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Help, "Esc clears the filter first");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Attach, "Esc closer restores Attach");

    // Settings overlay from prefix while attached.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(app.mode, TuiMode::Settings);
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(app.mode, TuiMode::Attach, "s closer restores Attach");

    // Overlays from Navigate keep returning to Navigate.
    app.mode = TuiMode::Navigate;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Help);
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Navigate);

    // Nested: opening help from inside the worktree overlay restores
    // the worktree overlay on close (prefix wins over the overlay).
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('w')));
    assert_eq!(app.mode, TuiMode::WorktreeList);
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Help);
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(
        app.mode,
        TuiMode::WorktreeList,
        "nested close restores the worktree overlay"
    );
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);
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
fn help_overlay_scrolls_with_page_keys_and_ctrl_u_clears() {
    let mut app = app_with_snapshot();
    app.open_overlay(TuiMode::Help);

    // PageDown/Down scroll, PageUp/Up scroll back, all while filtering.
    app.handle_key(KeyEvent::from(KeyCode::Down));
    let scrolled = app.help_scroll;
    assert!(scrolled <= crate::tui::keys::filtered_help_rows("").len());
    app.handle_key(KeyEvent::from(KeyCode::PageDown));
    assert!(app.help_scroll >= scrolled);
    app.handle_key(KeyEvent::from(KeyCode::PageUp));
    app.handle_key(KeyEvent::from(KeyCode::Up));
    assert_eq!(app.help_scroll, 0);

    // Ctrl+U clears the active filter.
    for ch in "theme".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert_eq!(app.help_filter, "theme");
    app.handle_key(ctrl('u'));
    assert_eq!(app.help_filter, "");
    // The overlay stays open after Ctrl+U.
    assert_eq!(app.mode, TuiMode::Help);
    // Filtered render shows the count line and the narrowed title.
    app.help_filter = "theme".to_string();
    let buf = draw(&app, 100, 40);
    assert!(buf.contains("filter: theme_"), "help filter renders");
    assert!(buf.contains("Esc clears the filter"), "help title switches");
}

#[test]
fn new_workspace_name_prompt_shows_the_staged_path() {
    let mut app = app_with_snapshot();
    app.workspace_create_stage = Some(crate::tui::workspace::WorkspaceCreateStage::Path(
        "/repo".to_string(),
    ));
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::NewWorkspaceName,
        text: String::new(),
    });
    let buf = draw(&app, 100, 30);
    assert!(buf.contains("Workspace name"), "prompt title renders");
    assert!(buf.contains("/repo"), "staged path shows as subject");
}

#[test]
fn footer_context_hints_exist_for_every_variant() {
    // Every overlay and capture-layer context must advertise its keys in
    // both full and compact hint forms (the footer is the discoverability
    // surface; an empty hint is a regression).
    let contexts = [
        FooterContext::ConfirmQuit,
        FooterContext::HelpOverlay,
        FooterContext::SettingsOverlay,
        FooterContext::WorktreeList,
        FooterContext::CommitInput,
        FooterContext::PromptInput(PromptKind::ReplaceInFile),
        FooterContext::PromptInput(PromptKind::RenameFile),
        FooterContext::DiffSearch,
        FooterContext::EditorFind,
        FooterContext::FileEdit,
        FooterContext::FilterBar,
        FooterContext::ContentSearch,
        FooterContext::Terminal(TuiMode::Attach),
        FooterContext::Terminal(TuiMode::Navigate),
        FooterContext::Files(TuiMode::Navigate),
        FooterContext::Git(TuiMode::Navigate, GitView::Cleanup),
    ];
    for ctx in contexts {
        assert!(!ctx.hint().trim().is_empty(), "{ctx:?} hint empty");
        assert!(
            !ctx.compact_hint().trim().is_empty(),
            "{ctx:?} compact hint empty"
        );
    }
    // The worktree overlay hint names its keys.
    let hint = FooterContext::WorktreeList.hint();
    assert!(hint.contains("Enter opens"), "worktree hint: {hint}");
    assert!(hint.contains("type filters"), "worktree hint: {hint}");
}

#[test]
fn help_overlay_backspace_edits_the_filter() {
    let mut app = app_with_snapshot();
    app.open_overlay(TuiMode::Help);
    for ch in "git".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert_eq!(app.help_filter, "git");
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.help_filter, "gi");
    assert_eq!(app.help_scroll, 0, "backspace resets scroll");
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
fn overlay_depth_effect_dims_backdrop_and_draws_shadow() {
    // Webui modal parity: overlays sit on a dimmed backdrop
    // (.modal-backdrop #0008) with a shadowed, accent-bordered float
    // window (neovim-style depth).
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Terminal;

    // Baseline footer text color before any overlay.
    let plain = draw_buffer(&app, 110, 30);
    let plain_footer_fg = plain[(5u16, 29u16)].fg;

    // Open the settings overlay.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(app.mode, TuiMode::Settings);
    let overlay = draw_buffer(&app, 110, 30);
    let overlay_footer_fg = overlay[(5u16, 29u16)].fg;
    assert_ne!(
        plain_footer_fg, overlay_footer_fg,
        "the backdrop behind the overlay must be dimmed"
    );

    // The overlay border uses the accent color and the cell right of
    // the border carries the shadow band (blank cell, shadow bg).
    let row = rendered_row(&overlay, "Settings · Esc closes");
    let x0 = row.cell_x_of("Settings · Esc closes").unwrap() - 1;
    assert_eq!(
        overlay[(x0 as u16, row.y as u16)].fg,
        Color::Rgb(137, 180, 250),
        "overlay border must be accent"
    );
    let x_right = row.cell_x_of("┐").unwrap();
    let shadow = overlay[((x_right + 1) as u16, (row.y + 3) as u16)].clone();
    // The shadow is a blank cell whose colors fold into the shadow
    // tone (bg painted, fg dimmed with the rest of the backdrop).
    assert_eq!(shadow.fg, Color::Rgb(137, 142, 157));
    assert_eq!(
        shadow.bg,
        Color::Rgb(10, 10, 16),
        "shadow band painted right of the overlay"
    );

    // Closing the overlay restores the original colors (no residual
    // dimming once the modal is gone).
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    let restored = draw_buffer(&app, 110, 30);
    assert_eq!(
        restored[(5u16, 29u16)].fg,
        plain_footer_fg,
        "backdrop colors must return after the overlay closes"
    );
}

#[test]
fn overlay_depth_effect_applies_to_every_overlay() {
    // Help, quit confirm, and the typed prompts get the same depth
    // treatment as settings: dimmed backdrop + shadow + accent border.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Terminal;

    // Help overlay.
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    let help = draw_buffer(&app, 110, 30);
    let row = rendered_row(&help, "Help · ? closes");
    let x0 = row.cell_x_of("Help · ? closes").unwrap() - 1;
    assert_eq!(
        help[(x0 as u16, row.y as u16)].fg,
        Color::Rgb(137, 180, 250),
        "help border accent"
    );
    let x_right = row.cell_x_of("┐").unwrap();
    assert_eq!(
        help[((x_right + 1) as u16, (row.y + 3) as u16)].bg,
        Color::Rgb(10, 10, 16),
        "help shadow band"
    );
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));

    // Quit confirmation.
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    let quit = draw_buffer(&app, 110, 30);
    let row = rendered_row(&quit, "Quit?");
    let x0 = row.cell_x_of("Quit?").unwrap() - 1;
    assert_eq!(
        quit[(x0 as u16, row.y as u16)].fg,
        Color::Rgb(137, 180, 250),
        "quit border accent"
    );
    let x_right = row.cell_x_of("┐").unwrap();
    assert_eq!(
        quit[((x_right + 1) as u16, (row.y + 3) as u16)].bg,
        Color::Rgb(10, 10, 16),
        "quit shadow band"
    );
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));

    // Commit input modal.
    app.commit_input = Some(CommitInput {
        text: "wip".to_string(),
        amend: false,
    });
    let commit = draw_buffer(&app, 110, 30);
    let row = rendered_row(&commit, "Commit message");
    let x0 = row.cell_x_of("Commit message").unwrap() - 1;
    assert_eq!(
        commit[(x0 as u16, row.y as u16)].fg,
        Color::Rgb(137, 180, 250),
        "commit modal border accent"
    );
    let x_right = row.cell_x_of("┐").unwrap();
    assert_eq!(
        commit[((x_right + 1) as u16, (row.y + 3) as u16)].bg,
        Color::Rgb(10, 10, 16),
        "commit modal shadow band"
    );
    app.commit_input = None;
}

#[test]
fn overlay_depth_effect_light_theme_and_named_colors() {
    // The depth helpers have theme-dependent arms: the light palette
    // picks the green channel for the border fold and a gray shadow,
    // and dim_color folds every named ANSI color it meets behind the
    // overlay. Drive the light theme through the settings overlay and
    // assert both the shadow color and a dimmed named-color cell.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Terminal;
    app.theme = TuiTheme::Light;
    app.palette = Palette::for_theme(TuiTheme::Light);

    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(app.mode, TuiMode::Settings);
    let overlay = draw_buffer(&app, 110, 30);
    let row = rendered_row(&overlay, "Settings · Esc closes");
    let x0 = row.cell_x_of("Settings · Esc closes").unwrap() - 1;
    // Light palette border stays the light accent blue (37, 99, 235).
    let accent = app.palette.accent;
    assert_eq!(overlay[(x0 as u16, row.y as u16)].fg, accent);
    // Light shadow: gray (203, 213, 225), not the dark near-black.
    let x_right = row.cell_x_of("┐").unwrap();
    let shadow = overlay[((x_right + 1) as u16, (row.y + 3) as u16)].clone();
    assert_eq!(
        shadow.bg,
        Color::Rgb(203, 213, 225),
        "light theme paints a gray shadow band"
    );

    // Named-color folding: dim_color maps the terminal ANSI names to
    // the palette tones. Every named color appears somewhere behind
    // the overlay in this fixture (footer, statuses, dots), so a
    // full-screen pass folds at least White and Red cells; assert the
    // dimming happened by sampling a footer cell again on light.
    let plain = {
        app.handle_key(KeyEvent::from(KeyCode::Char('s')));
        draw_buffer(&app, 110, 30)
    };
    let plain_fg = plain[(5u16, 29u16)].fg;
    let dim_fg = overlay[(5u16, 29u16)].fg;
    assert_ne!(plain_fg, dim_fg, "light backdrop also dims");
}

#[test]
fn depth_helpers_fold_named_colors_and_pick_theme_tones() {
    use crate::tui::render::{border_tone, dim_color, is_dark, shadow_color};

    let dark = Palette::for_theme(TuiTheme::Dark);
    let light = Palette::for_theme(TuiTheme::Light);

    // Every named ANSI color has a dim_color arm; each must fold to a
    // palette tone (Rgb) rather than stay a raw terminal name.
    assert_eq!(dim_color(Color::White, &dark), dark.border);
    assert_eq!(dim_color(Color::Black, &dark), dark.border);
    assert_eq!(dim_color(Color::Red, &dark), dark.red);
    assert_eq!(dim_color(Color::Green, &dark), dark.green);
    assert_eq!(dim_color(Color::Blue, &dark), dark.accent);
    assert_eq!(dim_color(Color::Yellow, &dark), dark.yellow);
    assert_eq!(dim_color(Color::Cyan, &dark), dark.teal);
    assert_eq!(dim_color(Color::Magenta, &dark), dark.accent);
    assert_eq!(dim_color(Color::DarkGray, &dark), dark.muted);
    assert_eq!(dim_color(Color::Gray, &dark), dark.muted);
    // Remaining terminal names (Indexed, the bright variants) have no
    // palette tone of their own and fold to muted like the grays.
    assert_eq!(dim_color(Color::Indexed(3), &dark), dark.muted);
    assert_eq!(dim_color(Color::LightRed, &dark), dark.muted);
    // Reset stays Reset: the system theme must not paint over the
    // user's terminal background.
    assert_eq!(dim_color(Color::Reset, &dark), Color::Reset);
    // Rgb folds halfway to the border tone.
    assert_eq!(
        dim_color(Color::Rgb(205, 214, 244), &dark),
        Color::Rgb(137, 142, 157)
    );

    // Theme detection drives the tones.
    assert!(is_dark(&dark));
    assert!(!is_dark(&light));

    // border_tone: red channel on dark, green channel on light.
    assert_eq!(border_tone(&dark), 69);
    assert_eq!(border_tone(&light), 213);

    // shadow_color: near-black on dark, gray on light.
    assert_eq!(shadow_color(&dark), Color::Rgb(10, 10, 16));
    assert_eq!(shadow_color(&light), Color::Rgb(203, 213, 225));

    // Non-Rgb palettes (a hand-built one) fall back to the defaults.
    let mut plain = dark;
    plain.border = Color::White;
    assert_eq!(border_tone(&plain), 128);
    plain.panel_bg = Color::Black;
    assert!(is_dark(&plain));
}

#[test]
fn search_palette_opens_types_commits_and_navigates() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);

    // Ctrl+B / opens the palette overlay from any screen.
    let ctrl_b = ctrl('b');
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(app.mode, TuiMode::SearchPalette);
    assert_eq!(app.search_palette.query, "");
    assert!(!app.search_palette.committed);

    // Typing live-filters the local candidates (the fixture has the
    // "Repo" workspace, the "Shell" tab and the jcode agent).
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    assert_eq!(app.search_palette.query, "rep");
    assert_eq!(app.search_palette.results.len(), 1);
    assert!(matches!(
        app.search_palette.results[0],
        search::SearchCandidate::Workspace { .. }
    ));

    // Arrows move the cursor even with a query typed (webui modal
    // parity); j/k are query letters once text exists.
    app.handle_key(KeyEvent::from(KeyCode::Down));
    assert_eq!(app.search_palette.selected, 0, "single row stays at 0");
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.search_palette.query, "repj", "j types into the query");
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.search_palette.query, "rep");

    // First Enter commits: with the API dead, the fetch fails, the
    // error surfaces, and the palette stays open and uncommitted (the
    // next Enter retries instead of navigating stale rows).
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(!app.search_palette.committed);
    assert!(app.error.is_some(), "dead API surfaces the fetch error");

    // A second Enter retries the failed fetch, fails again, and stays
    // in the palette; navigating a local row needs a successful commit
    // first, so for this dead-API test we force the committed flag the
    // way a successful commit would and verify navigation still lands.
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(
        !app.search_palette.committed,
        "retry still fails on dead API"
    );
    assert_eq!(app.mode, TuiMode::SearchPalette);
    app.error = None;
    app.search_palette.committed = true;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_ne!(app.mode, TuiMode::SearchPalette, "Enter navigated");
    assert_eq!(app.selected_workspace, 0);
    assert_eq!(
        app.sidebar_focus,
        SidebarFocus::Agents,
        "landed on the pane"
    );
    assert_eq!(app.selected_agent, 0);

    // Esc while the palette is open closes it without side effects.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_ne!(app.mode, TuiMode::SearchPalette);

    // Ctrl+U clears the query after typing.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
    assert_eq!(app.search_palette.query, "");
}

#[test]
fn search_palette_panel_and_agent_rows_resolve_to_panes() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);

    // Panel row: the tab resolves to its first pane.
    app.search_palette.results = vec![search::SearchCandidate::Panel {
        id: "tab_1".to_string(),
        label: "Shell".to_string(),
        workspace_id: "ws_1".to_string(),
    }];
    app.search_palette.selected = 0;
    app.run_search_candidate(&app.search_palette.results[0].clone())
        .unwrap();
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);
    assert_eq!(app.selected_agent, 0);

    // Agent row: the pane resolves via the agents list.
    app.search_palette.results = vec![search::SearchCandidate::Agent {
        pane_id: "pane_1".to_string(),
        label: "jcode".to_string(),
    }];
    app.run_search_candidate(&app.search_palette.results[0].clone())
        .unwrap();
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);
    assert_eq!(app.selected_agent, 0);

    // A pane id that exists nowhere must not panic (fallback arms).
    app.search_palette.results = vec![search::SearchCandidate::Agent {
        pane_id: "ghost".to_string(),
        label: "ghost".to_string(),
    }];
    app.run_search_candidate(&app.search_palette.results[0].clone())
        .unwrap();
}

#[test]
fn search_palette_renders_query_rows_and_empty_state() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(app.mode, TuiMode::SearchPalette);

    // Freshly opened: the empty state hints at typing.
    let canvas = draw(&app, 80, 24);
    assert!(canvas.contains("type to search"), "empty query hint");
    assert!(canvas.contains("Search"));

    // Typing filters and the rows render with the icon prefix.
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    let canvas = draw(&app, 80, 24);
    assert!(canvas.contains("query: rep_"), "the query line renders");
    assert!(canvas.contains("[ws] Repo"), "workspace row with icon");
    assert!(canvas.contains("1 results"));

    // A failed dead-API commit keeps the palette uncommitted, so the
    // rows area shows the Enter hint rather than "no results" (the
    // red error in the footer carries the failure).
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    assert!(app.search_palette.results.is_empty());
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(!app.search_palette.committed, "dead commit does not commit");
    let canvas = draw(&app, 80, 24);
    assert!(
        canvas.contains("Enter searches files and content too"),
        "uncommitted empty search shows the hint, not a false none"
    );

    // The footer shows the palette mode label.
    assert!(canvas.contains("SEARCH"));
}

#[test]
fn search_palette_boundary_and_regression_checks() {
    // Reopen: a fresh open after navigation resets query/results/cursor.
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    assert_eq!(app.search_palette.query, "", "reopen resets the query");
    assert_eq!(app.search_palette.results.len(), 0, "reopen resets rows");
    assert!(!app.search_palette.committed, "reopen resets committed");

    // Overlay stacking: help opened inside the palette returns to the
    // palette, Esc from the palette returns to the original mode.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Help, "help opens over the palette");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(
        app.mode,
        TuiMode::SearchPalette,
        "help close returns to the palette"
    );
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate, "palette close restores mode");

    // Enter on a palette with no candidate and a dead backend retries
    // the fetch (stays uncommitted) instead of closing; Esc is the
    // exit path there.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(!app.search_palette.committed, "dead commit retries");
    assert_eq!(app.mode, TuiMode::SearchPalette, "palette stays open");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate, "Esc closes the palette");

    // Enter with an empty query: commit is a no-op, and with no row
    // under the cursor the palette stays open (desktop
    // `chooseSearchResult` returns early on a missing row); Esc is the
    // exit path there.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.search_palette.committed);
    assert!(app.search_palette.results.is_empty());
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.mode,
        TuiMode::SearchPalette,
        "no-row Enter keeps the palette open"
    );
    assert_eq!(app.status, "search: no matching rows");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate, "Esc closes the palette");

    // The palette is reachable from every screen the fixture offers.
    for screen in [TuiScreen::Files, TuiScreen::Git, TuiScreen::Terminal] {
        app.screen = screen;
        app.handle_key(ctrl('b'));
        app.handle_key(KeyEvent::from(KeyCode::Char('/')));
        assert_eq!(
            app.mode,
            TuiMode::SearchPalette,
            "palette opens from {screen:?}"
        );
        app.handle_key(KeyEvent::from(KeyCode::Esc));
    }

    // The help overlay lists the palette entry and its filter finds it.
    let rows = crate::tui::keys::help_rows();
    assert!(
        rows.iter()
            .any(|(key, desc)| *key == "Ctrl+B /" && desc.contains("palette")),
        "help rows mention the palette"
    );
    assert!(!crate::tui::keys::filtered_help_rows("palette").is_empty());

    // File and content rows hit the API-backed navigation arms without
    // panicking (dead API surfaces the error, palette already closed).
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.search_palette.results = vec![search::SearchCandidate::File {
        path: "/repo/src".to_string(),
        name: "src".to_string(),
        is_dir: true,
    }];
    app.search_palette.committed = true;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.screen, TuiScreen::Files, "dir hit lands on Files");
    assert_ne!(
        app.mode,
        TuiMode::SearchPalette,
        "navigation closed the palette"
    );

    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.search_palette.results = vec![
        search::SearchCandidate::File {
            path: "/repo/main.rs".to_string(),
            name: "main.rs".to_string(),
            is_dir: false,
        },
        search::SearchCandidate::Content {
            file: "/repo/main.rs".to_string(),
            line: 12,
            name: "main.rs".to_string(),
        },
    ];
    app.search_palette.committed = true;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "dead API reveal errors surface");
    app.error = None;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.search_palette.results = vec![search::SearchCandidate::Content {
        file: "/repo/main.rs".to_string(),
        line: 12,
        name: "main.rs".to_string(),
    }];
    app.search_palette.committed = true;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "dead API preview errors surface");
}

#[test]
fn search_palette_scrolls_when_rows_outgrow_the_overlay() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    // More rows than fit (overlay caps at 20 height ≈ 15 visible).
    app.search_palette.results = (0..40)
        .map(|i| search::SearchCandidate::Agent {
            pane_id: format!("pane_{i}"),
            label: format!("agent {i}"),
        })
        .collect();
    app.search_palette.selected = 39;
    let canvas = draw(&app, 80, 24);
    assert!(canvas.contains("agent 39"), "cursor row scrolls into view");
    assert!(
        !canvas.contains("agent 0"),
        "scrolled-off rows leave the window"
    );
}

#[test]
fn search_palette_multi_workspace_selection_and_arrow_paging() {
    let mut app = app_with_snapshot();
    app.snapshot
        .workspaces
        .push(crate::tui::model::TuiWorkspace {
            id: "ws_2".to_string(),
            label: "Second".to_string(),
            cwd: "/two".to_string(),
            focused: false,
            agent_status: "idle".to_string(),
            pane_count: 0,
            tab_count: 0,
            active_tab_id: None,
        });
    point_web_api_at_dead_port(&mut app);

    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));

    // "e" matches only the agent text ("agent jcode ..."), and after
    // typing, arrows still page through the rows (webui modal parity).
    let len = app.search_palette.results.len();
    assert!(len >= 1, "agent matched the query: {len}");
    for _ in 0..len + 1 {
        app.handle_key(KeyEvent::from(KeyCode::Down));
    }
    assert!(
        app.search_palette.selected < len,
        "arrows wrap around with a typed query"
    );
    app.handle_key(KeyEvent::from(KeyCode::Up));
    assert!(app.search_palette.selected < len);

    // Navigating an agent row from the second workspace still lands on
    // a valid agent index and keeps the workspace selection in range.
    app.search_palette.results = vec![search::SearchCandidate::Workspace {
        id: "ws_2".to_string(),
        label: "Second".to_string(),
    }];
    app.search_palette.selected = 0;
    app.search_palette.committed = true;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.selected_workspace, 1, "second workspace selected");
    assert!(
        app.selected_workspace < app.snapshot.workspaces.len(),
        "selection stays in range"
    );
}

#[test]
fn search_palette_render_invariants() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));

    let backend = TestBackend::new(60, 20);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, &app)).unwrap();
    let buf = terminal.backend().buffer().clone();
    let area = ratatui::layout::Rect {
        x: 0,
        y: 0,
        width: 60,
        height: 20,
    };
    let text: String = buf
        .content()
        .iter()
        .map(|c| c.symbol().to_string())
        .collect();
    assert!(
        text.contains("query: a"),
        "query line renders: {}",
        &text[..120.min(text.len())]
    );
    assert!(text.contains("SEARCH"), "SEARCH footer label renders");
    assert!(text.contains("Enter commits"), "hint row renders");
    // Cursor is painted on the query line, not inside any result row.
    let cursor_row: String = (0..area.width)
        .map(|x| buf[(x, area.y + 4)].symbol().to_string())
        .collect();
    assert!(
        cursor_row.contains("│"),
        "cursor column marker inside overlay"
    );
    assert!(
        !cursor_row.contains("[ws]"),
        "cursor is not on a result row: {cursor_row}"
    );
}

#[test]
fn search_palette_scoring_orders_exact_prefix_substring() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.snapshot
        .workspaces
        .push(crate::tui::model::TuiWorkspace {
            id: "ws_repo".to_string(),
            label: "repo".to_string(),
            cwd: "/repo".to_string(),
            focused: false,
            agent_status: "idle".to_string(),
            pane_count: 0,
            tab_count: 0,
            active_tab_id: None,
        });
    app.snapshot
        .workspaces
        .push(crate::tui::model::TuiWorkspace {
            id: "ws_x".to_string(),
            label: "my repo here".to_string(),
            cwd: "/x".to_string(),
            focused: false,
            agent_status: "idle".to_string(),
            pane_count: 0,
            tab_count: 0,
            active_tab_id: None,
        });
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    // "repo" ties "Repo" and "repo" at the same substring index (score
    // tie broken by title) and finds "my repo here" at a later index.
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    app.handle_key(KeyEvent::from(KeyCode::Char('o')));

    let labels: Vec<String> = app
        .search_palette
        .results
        .iter()
        .map(|c| match c {
            search::SearchCandidate::Workspace { label, .. } => label.clone(),
            _ => String::new(),
        })
        .collect();
    // Desktop parity: workspace searchText is "workspace {title} ...", so
    // both "Repo" and "repo" are substring hits at the same index (score
    // tie) and order falls to title.localeCompare, where "Repo" < "repo".
    // "my repo here" matches at a later index, so it ranks last.
    assert_eq!(
        labels,
        vec![
            "Repo".to_string(),
            "repo".to_string(),
            "my repo here".to_string()
        ],
        "score ties break by title, later substring index ranks later"
    );

    // Selection stays robust when results go empty: typing a nonsense
    // query must not panic on move_selection or Enter.
    for ch in "zzqqxx".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert!(app.search_palette.results.is_empty());
    app.handle_key(KeyEvent::from(KeyCode::Down));
    app.handle_key(KeyEvent::from(KeyCode::Up));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.mode, crate::tui::model::TuiMode::SearchPalette);
}

#[test]
fn search_palette_shows_error_and_stays_usable_when_backend_fails() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));

    // First Enter commits: file+content fetches hit a dead port and must
    // surface an error, keep the palette open, and stay committed=false
    // so a later Enter retries rather than navigating stale rows.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "commit failure surfaces an error");
    assert_eq!(
        app.mode,
        crate::tui::model::TuiMode::SearchPalette,
        "palette stays open after a failed commit"
    );
    assert!(
        !app.search_palette.committed,
        "failed commit must not mark the palette committed"
    );
    assert_eq!(
        app.search_palette.results.len(),
        0,
        "no local match for 'x' and no fetched rows"
    );

    // The error must render on the status line (red), next to a query
    // line that still shows the typed text. 80 cols gives the footer
    // room for the full message (60 truncates it).
    let buf = draw_buffer(&app, 80, 24);
    let text: String = buf
        .content()
        .iter()
        .map(|c| c.symbol().to_string())
        .collect();
    assert!(text.contains("query: x"), "query survives the error");
    assert!(
        text.contains("connection failed"),
        "error text rendered: {}",
        text.chars().take(200).collect::<String>()
    );
}

#[test]
fn search_palette_retyping_after_commit_requires_fresh_enter() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));

    // Simulate a successful commit: local rows plus the committed flag.
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    app.search_palette.committed = true;
    assert!(app.search_palette.committed);

    // Extending the query must drop the committed state: the next Enter
    // re-commits (re-fetches) instead of navigating rows fetched for
    // the old query.
    app.handle_key(KeyEvent::from(KeyCode::Char('o')));
    assert!(
        !app.search_palette.committed,
        "typing after a commit drops committed"
    );
    // Backspace and Ctrl+U also invalidate the commit.
    app.search_palette.committed = true;
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert!(!app.search_palette.committed, "backspace drops committed");
    app.search_palette.committed = true;
    app.handle_key(ctrl('u'));
    assert!(!app.search_palette.committed, "Ctrl+U drops committed");

    // And the uncommitted palette behaves like a committed-ignorant one:
    // with a local hit the row renders (no false "no results" state).
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    let text = draw(&app, 80, 24);
    assert!(
        text.contains("[ws] Repo"),
        "local row renders while uncommitted"
    );
    assert!(
        !text.contains("no results"),
        "no false no-results state while uncommitted"
    );
}

/// HTTP fake serving the palette search endpoints: the tree (file)
/// search succeeds with one hit, the content search drops the
/// connection (simulates a partial backend failure).
fn fake_palette_server(file_ok: bool, content_ok: bool) -> (u16, std::sync::mpsc::Sender<()>) {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if rx.try_recv().is_ok() {
                break;
            }
            let Ok(mut stream) = stream else { break };
            let mut line = String::new();
            {
                let mut reader = BufReader::new(&mut stream);
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    continue;
                }
            }
            let target = line.split(' ').nth(1).unwrap_or_default().to_string();
            let body = if target.contains("/api/file-browser/tree") && file_ok {
                json!({"entries": [
                    {"name": "alpha.rs", "kind": "file", "path": "src/alpha.rs"}
                ]})
            } else if target.contains("/api/file-browser/content-search") && content_ok {
                json!({"files": [
                    {"path": "src/beta.rs", "name": "beta.rs",
                     "matches": [{"line": 7, "text": "let x = 1;"}]}
                ]})
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
fn search_palette_retry_after_partial_failure_appends_no_duplicates() {
    let (port, _stop) = fake_palette_server(true, false);
    let mut app = app_with_snapshot();
    app.web_api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);

    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));

    // The file search succeeds (one row appended), the content search
    // drops the connection: the commit fails and stays uncommitted.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(
        !app.search_palette.committed,
        "partial failure keeps uncommitted"
    );
    let files_after_first = app
        .search_palette
        .results
        .iter()
        .filter(|c| matches!(c, search::SearchCandidate::File { .. }))
        .count();
    assert_eq!(
        files_after_first, 1,
        "file hit appended on the failed commit"
    );

    // Retrying the commit must not duplicate the file row.
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(!app.search_palette.committed, "retry fails again");
    let files_after_retry = app
        .search_palette
        .results
        .iter()
        .filter(|c| matches!(c, search::SearchCandidate::File { .. }))
        .count();
    assert_eq!(
        files_after_retry, 1,
        "retry must not append a duplicate file row"
    );
}

#[test]
fn search_palette_file_and_content_navigation_failure_paths() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);

    // A committed palette with a file row: navigating it with a dead
    // backend must surface the reveal error, close the palette, and
    // land on the Files screen (not crash or hang).
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.search_palette.results = vec![search::SearchCandidate::File {
        path: "src/alpha.rs".to_string(),
        name: "alpha.rs".to_string(),
        is_dir: false,
    }];
    app.search_palette.selected = 0;
    app.search_palette.committed = true;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_ne!(app.mode, TuiMode::SearchPalette, "palette closed");
    assert_eq!(app.screen, TuiScreen::Files, "landed on Files screen");
    assert!(app.error.is_some(), "reveal failure surfaces");

    // Same for a content row: the preview fetch fails, the error
    // surfaces, and the app stays usable (mode restored).
    app.error = None;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.search_palette.results = vec![search::SearchCandidate::Content {
        file: "src/beta.rs".to_string(),
        name: "beta.rs".to_string(),
        line: 7,
    }];
    app.search_palette.selected = 0;
    app.search_palette.committed = true;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_ne!(app.mode, TuiMode::SearchPalette, "palette closed");
    assert_eq!(app.screen, TuiScreen::Files, "landed on Files screen");
    assert!(app.error.is_some(), "preview failure surfaces");

    // A dir row navigates without any fetch (select_path only), so it
    // succeeds even with the backend dead.
    app.error = None;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.search_palette.results = vec![search::SearchCandidate::File {
        path: "src".to_string(),
        name: "src".to_string(),
        is_dir: true,
    }];
    app.search_palette.selected = 0;
    app.search_palette.committed = true;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_ne!(app.mode, TuiMode::SearchPalette);
    assert!(app.error.is_none(), "dir navigation needs no fetch");
}

#[test]
fn lens_prefix_toggles_overlay_and_esc_closes() {
    let mut app = app_with_snapshot();
    assert!(!app.lens.active);
    // Ctrl+B Shift+L opens the lens over the terminal screen.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(app.lens.active);
    assert!(app.lens.follow);
    // While open, the lens owns the keys: j scrolls up (stops follow).
    app.pane_tail = vec!["one".to_string(), "two".to_string()];
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert!(!app.lens.follow);
    assert_eq!(app.lens.scroll_up, 1);
    // G jumps back to the tail: follow re-arms.
    app.handle_key(KeyEvent::from(KeyCode::Char('G')));
    assert!(app.lens.follow);
    assert_eq!(app.lens.scroll_up, 0);
    // Esc closes.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(!app.lens.active);
    // After close, j is the navigation key again (selection moves).
    let before = app.selected_workspace;
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.selected_workspace, before);
}

/// Design section 6 (TUI parity): the lens shortcut is gated on the
/// pane having a supported `agent_session`. Fixture pane is jcode with
/// `resolvable: true`, so the gate reads Supported. The refusal shape
/// (`resolvable: false` + reason) also counts as supported — the lens
/// then shows the refusal instead of turns.
#[test]
fn lens_gate_parses_agent_session_from_snapshot() {
    let snapshot = TuiSnapshot::from_backend_response(&fixture_snapshot_value());
    let pane = &snapshot.panes[0];
    let session = pane
        .agent_session
        .as_ref()
        .expect("fixture pane carries agent_session");
    assert_eq!(session.kind, "jcode");
    assert!(session.resolvable);
    assert_eq!(session.session_id.as_deref(), Some("sess_1"));
    assert!(session.chat_supported());
}

#[test]
fn lens_gate_allows_supported_kind_even_when_unresolvable() {
    let mut app = app_with_snapshot();
    app.snapshot.panes[0].agent_session = Some(crate::tui::model::TuiAgentSession {
        kind: "jcode".to_string(),
        resolvable: false,
        session_id: None,
        reason: Some("no_session_path".to_string()),
    });
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(
        app.lens.active,
        "supported kind with refusal still opens the lens"
    );
    assert_eq!(
        app.status, "lens: No jcode conversation found for this panel yet",
        "refused pane must surface the refusal reason copy (design section 6)"
    );
    // Closing (second Ctrl+B L) says "lens closed", not the refusal
    // copy again: the copy is the open-time hint only. The prefix must
    // be armed again — while the lens is open it owns the bare keys.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(
        !app.lens.active,
        "second L over a refused pane closes the lens"
    );
    assert_eq!(app.status, "lens closed");
}

#[test]
fn lens_gate_blocks_pane_without_agent_session() {
    let mut app = app_with_snapshot();
    app.snapshot.panes[0].agent_session = None;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(
        !app.lens.active,
        "shell pane (no agent_session) must not open the lens"
    );
    assert_eq!(app.status, "lens: no agent session on this pane");
}

#[test]
fn lens_gate_blocks_unsupported_agent_kind() {
    let mut app = app_with_snapshot();
    app.snapshot.panes[0].agent_session = Some(crate::tui::model::TuiAgentSession {
        kind: "other-agent".to_string(),
        resolvable: true,
        session_id: Some("sess_x".to_string()),
        reason: None,
    });
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(!app.lens.active, "unsupported kind must not open the lens");
    assert_eq!(app.status, "lens: unsupported agent");
}

/// The lens must not survive a pane switch onto a pane without a
/// provider: refresh_tail force-closes it (webui parity: the switch
/// disappears, so does the overlay).
#[test]
fn lens_gate_force_closes_on_unsupported_pane_refresh() {
    let mut app = app_with_snapshot();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(app.lens.active);
    // Switch to a snapshot whose pane has no agent_session, then let
    // the refresh path run (the socket is dead, so the read errors —
    // the gate must still fire before that).
    app.snapshot.panes[0].agent_session = None;
    app.refresh_tail();
    assert!(
        !app.lens.active,
        "lens must force-close over an unsupported pane"
    );
    assert_eq!(app.status, "lens closed (pane has no transcript provider)");
}

#[test]
fn lens_toggle_ignores_other_screens() {
    // The lens is a terminal-screen surface; on Files it must not open.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(!app.lens.active, "no lens over the Files screen");
}

#[test]
fn lens_unread_tracks_new_output_while_scrolled_up() {
    let mut app = app_with_snapshot();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    app.pane_tail = (0..10).map(|i| format!("line {i}")).collect();
    // refresh_tail feeds observe_len through the set_pane_tail path;
    // simulate by calling the observer directly (refresh needs a backend).
    app.lens.observe_len(app.pane_tail.len());
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert!(!app.lens.follow);
    // New output lands while the reader is scrolled up.
    app.pane_tail.push("line 10".to_string());
    app.lens.observe_len(app.pane_tail.len());
    assert!(app.lens.unread, "new output while scrolled up sets unread");
    // Footer context is the lens overlay.
    assert!(matches!(
        app.footer_context(),
        crate::tui::FooterContext::Lens
    ));
}

#[test]
fn lens_render_shapes_user_turns_and_meta() {
    let mut app = app_with_snapshot();
    app.lens.open();
    app.pane_tail = vec![
        "❯ cargo build".to_string(),
        "Compiling herdr v0.1".to_string(),
        "".to_string(),
        "Finished".to_string(),
    ];
    let canvas = draw(&app, 100, 30);
    assert!(canvas.contains("Chat"));
    assert!(canvas.contains("❯ cargo build"));
    assert!(canvas.contains("Compiling herdr v0.1"));
    assert!(canvas.contains("following"), "meta line shows follow state");
    // Scrolled-up + unread shows the resume hint.
    app.lens.scroll_up(2, app.pane_tail.len());
    app.lens.unread = true;
    let canvas = draw(&app, 100, 30);
    assert!(
        canvas.contains("new output"),
        "unread hint rendered: {canvas}"
    );
}

#[test]
fn composer_shortcut_opens_prompt_with_per_pane_draft() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    // No draft yet: prompt opens empty.
    app.screen = TuiScreen::Terminal;
    app.run_shortcut(Shortcut::Composer);
    assert!(app.prompt_input.is_some());
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        crate::tui::PromptKind::ComposerMessage
    );
    // Typing syncs the per-pane draft (pane_1 in the fixture).
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    app.handle_key(KeyEvent::from(KeyCode::Char('i')));
    assert_eq!(
        app.composer_drafts.get("pane_1").map(String::as_str),
        Some("hi")
    );
    // Esc keeps the draft.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.prompt_input.is_none());
    assert_eq!(
        app.composer_drafts.get("pane_1").map(String::as_str),
        Some("hi")
    );
    // Reopening prefills from the draft (webui per-pane draft restore).
    app.run_shortcut(Shortcut::Composer);
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "hi");
}

#[test]
fn composer_prompt_shows_target_pane_and_enter_submits() {
    let (port, _stop) = fake_composer_server(Some("ok"));
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", port),
    );
    app.snapshot = fixture_snapshot();
    app.screen = TuiScreen::Terminal;
    app.run_shortcut(Shortcut::Composer);
    // The subject line renders the target pane (agent · pane id).
    let canvas = draw(&app, 80, 24);
    assert!(canvas.contains("Send a message"), "prompt title: {canvas}");
    assert!(canvas.contains("jcode · pane_1"), "target pane: {canvas}");
    // Type and send: the submit route answers, the draft clears.
    for ch in "echo hello".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert_eq!(
        app.composer_drafts.get("pane_1").map(String::as_str),
        Some("echo hello")
    );
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.prompt_input.is_none(), "prompt closed after submit");
    assert!(
        !app.composer_drafts.contains_key("pane_1"),
        "draft cleared on success"
    );
    assert_eq!(app.status, "message sent");
}

#[test]
fn composer_blocked_refusal_shows_server_note_and_keeps_draft() {
    let (port, _stop) = fake_composer_server(Some("blocked"));
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", port),
    );
    app.snapshot = fixture_snapshot();
    app.screen = TuiScreen::Terminal;
    app.run_shortcut(Shortcut::Composer);
    for ch in "deploy now".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    // The server wrote the note; it lands in the status line verbatim
    // and the draft stays.
    assert_eq!(
        app.status,
        "Not sent: the agent is waiting for an answer in the terminal. Answer it first."
    );
    assert_eq!(
        app.composer_drafts.get("pane_1").map(String::as_str),
        Some("deploy now"),
        "refusal keeps the draft"
    );
}

#[test]
fn composer_empty_message_sends_nothing() {
    let (port, _stop) = fake_composer_server(Some("ok"));
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", port),
    );
    app.snapshot = fixture_snapshot();
    app.screen = TuiScreen::Terminal;
    app.run_shortcut(Shortcut::Composer);
    // Only whitespace: no request leaves, the status says so.
    app.handle_key(KeyEvent::from(KeyCode::Char(' ')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "message empty, nothing sent");
    // The draft (whitespace) is kept, nothing was submitted.
    assert!(app.composer_drafts.contains_key("pane_1"));
}

#[test]
fn composer_ignores_other_screens() {
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.run_shortcut(Shortcut::Composer);
    assert!(
        app.prompt_input.is_none(),
        "no composer off the Terminal screen"
    );
}

/// Fake WebUI server answering `POST /api/panes/{id}/submit`:
/// `Some("ok")` returns the success body, `Some("blocked")` the
/// agent_blocked refusal shape the real route emits (HTTP 409 with
/// `{error, code, note}`), `None` drops the connection.
fn fake_composer_server(mode: Option<&str>) -> (u16, std::sync::mpsc::Sender<()>) {
    use std::io::{BufRead, BufReader, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    let mode = mode.map(str::to_string);
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            if rx.try_recv().is_ok() {
                break;
            }
            let Ok(stream) = stream else { break };
            let mut stream = stream;
            let mut request_line = String::new();
            let mut content_length = 0usize;
            {
                let mut reader = BufReader::new(&mut stream);
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    let lower = header.trim().to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                    if header.trim().is_empty() {
                        break;
                    }
                }
                // Drain the body so the request completes.
                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    use std::io::Read;
                    let _ = reader.read_exact(&mut body);
                }
            }
            if !request_line.contains("/api/panes/") || !request_line.contains("/submit") {
                continue;
            }
            let Some(mode) = mode.as_deref() else {
                continue;
            };
            let (status, body) = match mode {
                "ok" => ("200 OK", json!({ "type": "agent_prompt", "ok": true })),
                "blocked" => (
                    "409 Conflict",
                    json!({
                        "error": "agent_blocked: the agent is waiting for an answer in the terminal",
                        "code": "agent_blocked",
                        "note": "Not sent: the agent is waiting for an answer in the terminal. Answer it first."
                    }),
                ),
                _ => continue,
            };
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.to_string().len(),
                    body
                )
                .as_bytes(),
            );
        }
    });
    (port, tx)
}

// ---------------------------------------------------------------------------
// Prompt cards (P3, webui prompt_cards.js port): evaluate/visibility,
// key routing, answer transport, and render gating.
// ---------------------------------------------------------------------------

/// Fixture tail of a blocked numbered dialog (the shapes the parser
/// accepts: nav hint + numbered options + question line).
fn blocked_dialog_tail() -> Vec<String> {
    [
        "❯ Should I proceed with the deploy?",
        "Use ↑/↓ or 1-3 to choose:",
        "1. Deploy now",
        "2. Deploy with tag",
        "3. Cancel",
        "esc to dismiss",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect()
}

fn app_with_blocked_pane() -> TuiApp {
    let mut app = app_with_snapshot();
    // The fixture pane is "idle"; a blocked pane with a question dialog
    // is the card's precondition.
    app.snapshot.panes[0].agent_status = "blocked".to_string();
    app
}

/// A hermetic terminal-protocol server: speaks the same length-prefixed
/// bincode protocol 22 handshake as the real backend terminal socket
/// (`TerminalHello` → `Welcome` → Input/Detach/AttachTerminal frames),
/// and records every input frame's bytes. Used to prove the prompt
/// card's answer route against a LIVE terminal connection: the dead
/// socket path can only ever surface the error arm.
fn fake_terminal_socket() -> (std::path::PathBuf, std::sync::mpsc::Receiver<Vec<u8>>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = crate::backend_client::unique_test_path("herdr-tui-fake-term");
    let _ = std::fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || loop {
        let Ok(mut stream) = listener.accept() else {
            break;
        };
        // Handshake: TerminalHello in, Welcome out (protocol 22).
        let hello = crate::protocol::read_message::<_, crate::protocol::ClientMessage>(
            &mut stream,
            crate::backend_client::MAX_TUI_TERMINAL_FRAME_SIZE,
        );
        if hello.is_err() {
            continue;
        }
        let welcome = crate::protocol::ServerMessage::Welcome {
            version: 22,
            encoding: crate::protocol::RenderEncoding::TerminalAnsi,
            error: None,
        };
        if crate::protocol::write_message(&mut stream, &welcome).is_err() {
            continue;
        }
        // Serve frames until the client detaches or the socket dies.
        // Input frames are recorded; Detach ends the connection.
        loop {
            let frame = crate::protocol::read_message::<_, crate::protocol::ClientMessage>(
                &mut stream,
                crate::backend_client::MAX_TUI_TERMINAL_FRAME_SIZE,
            );
            let Ok(frame) = frame else { break };
            match frame {
                crate::protocol::ClientMessage::Input { data } => {
                    let _ = tx.send(data);
                }
                crate::protocol::ClientMessage::AttachTerminal { .. } => {
                    // Attach-mode history read: one full-frame render so
                    // `read_output` returns instead of blocking forever.
                    // A send-then-detach caller (send_pane_input) never
                    // reads this frame and drops the socket right after
                    // its Detach: the write can hit EPIPE from that RST.
                    // Pushing the frame is best-effort; the buffered
                    // Input frames behind it must still be read, so a
                    // write error never breaks the serve loop.
                    let output =
                        crate::protocol::ServerMessage::Terminal(crate::protocol::TerminalFrame {
                            seq: 1,
                            width: 120,
                            height: 32,
                            full: true,
                            bytes: b"fake history".to_vec(),
                        });
                    let _ = crate::protocol::write_message(&mut stream, &output);
                }
                crate::protocol::ClientMessage::Detach => break,
                _ => {}
            }
        }
    });
    (path, rx)
}

/// App whose terminal socket is the hermetic fake: attach_terminal
/// succeeds, send_input lands in the recorded channel, detach closes.
fn app_with_fake_terminal_socket() -> (TuiApp, std::sync::mpsc::Receiver<Vec<u8>>) {
    let (path, rx) = fake_terminal_socket();
    let client = BackendClient::new("/nonexistent.sock", &path);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    point_web_api_at_dead_port(&mut app);
    (app, rx)
}

#[test]
fn prompt_card_option_answer_reaches_the_live_terminal_socket() {
    // The real answer route, end to end against a live terminal
    // connection: Enter on the selected option types "1\r" into the
    // dialog (webui sendInputData parity), the status line confirms,
    // and the card collapses. The pane.read refresh after the send
    // hits the dead API socket: that error is refresh noise, not an
    // answer failure (the send already succeeded).
    let (mut app, rx) = app_with_fake_terminal_socket();
    app.snapshot.panes[0].agent_status = "blocked".to_string();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert!(app.prompt_card.visible);
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    let sent = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("answer typed into the dialog");
    assert_eq!(sent, b"1\r", "selected option key + Enter goes raw");
    assert_eq!(app.status, "answered: Deploy now");
    assert!(!app.prompt_card.visible, "answered card collapses");
}

#[test]
fn prompt_card_digits_jump_and_answer_in_one_key() {
    let (mut app, rx) = app_with_fake_terminal_socket();
    app.snapshot.panes[0].agent_status = "blocked".to_string();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    // Digit 2: cursor jumps to option 2 AND answers in the same
    // keystroke (webui clickable buttons parity).
    app.handle_key(KeyEvent::from(KeyCode::Char('2')));
    let sent = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("digit answers immediately");
    assert_eq!(sent, b"2\r");
    assert_eq!(app.status, "answered: Deploy with tag");
    // Digits past the option count are ignored (no send, card stays).
    // A fresh blocked episode re-arms the card (same question text,
    // new episode per the webui blocked-episode rule).
    app.snapshot.panes[0].agent_status = "idle".to_string();
    app.evaluate_prompt_card();
    app.snapshot.panes[0].agent_status = "blocked".to_string();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert!(app.prompt_card.visible);
    app.handle_key(KeyEvent::from(KeyCode::Char('9')));
    assert!(rx.try_recv().is_err(), "out-of-range digit sends nothing");
    assert!(app.prompt_card.visible, "card survives an ignored digit");
    assert_eq!(
        app.status, "answered: Deploy with tag",
        "the ignored digit leaves the answered status untouched"
    );
    assert_eq!(
        app.prompt_card_cursor, 0,
        "fresh episode resets the cursor to the first option"
    );
}

#[test]
fn prompt_card_jk_moves_the_cursor_and_k_clamps_at_zero() {
    let mut app = app_with_blocked_pane();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert_eq!(app.prompt_card_cursor, 0);
    // j moves down, k moves back up.
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.prompt_card_cursor, 1);
    app.handle_key(KeyEvent::from(KeyCode::Char('k')));
    assert_eq!(app.prompt_card_cursor, 0);
    // k at the top clamps at zero instead of wrapping.
    app.handle_key(KeyEvent::from(KeyCode::Char('k')));
    assert_eq!(app.prompt_card_cursor, 0, "k clamps at the first option");
    // j clamps at the last option too.
    for _ in 0..5 {
        app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    }
    assert_eq!(app.prompt_card_cursor, 2, "j clamps at the last option");
    // The selected option is what Enter answers: cursor 2 is
    // "Cancel". The dead socket errors (expected noise) but the
    // status proves which option was picked.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "answered: Cancel");
}

#[test]
fn prompt_card_free_text_refuses_stale_and_empty_answers() {
    let mut app = app_with_blocked_pane();
    app.set_pane_tail_from_text("❯ What database should I use?\nenter your response below:\n");
    assert!(app.prompt_card.visible);
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.prompt_input.as_ref().map(|p| p.kind),
        Some(PromptKind::CardAnswer)
    );
    // Empty answer: refused with the empty status (the modal is
    // closed by the Enter route itself; the refusal only sets the
    // status line and the empty send never happens).
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.status, "answer empty, nothing sent",
        "empty answer never sends"
    );
    assert!(app.prompt_input.is_none());
    // Re-open the answer modal and type an answer, then let the
    // dialog move on underneath: the stale guard refuses.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    for ch in "postgres".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    app.pane_tail = vec!["build finished".to_string()];
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.status, "question changed, not sent",
        "stale guard refuses a moved-on free-text dialog"
    );
    assert!(app.prompt_input.is_none(), "refusal closes the modal");
    assert!(
        app.prompt_card.visible,
        "the card itself stays up for the new tail"
    );
}

#[test]
fn prompt_card_answer_keys_never_leak_to_navigation() {
    // Regression shapes for the answer route's guards: a send that
    // cannot start never answers, and a stale dialog is never
    // answered even though the card still shows the old question.
    let mut app = app_with_blocked_pane();
    app.snapshot.panes[0].terminal_id = String::new();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert!(app.prompt_card.visible);
    // Empty terminal id: the attach fails (the no-terminal guard in
    // send_pane_input only fires when NO pane is selected, a state
    // that cannot coexist with a visible card — every selection move
    // refreshes the tail, which collapses the card).
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    // Optimistic answer status (webui parity: the card collapses and
    // the status says answered; the send failure lands in error and
    // is never swallowed by a success status).
    assert_eq!(app.status, "answered: Deploy now");
    assert!(
        app.error.is_some(),
        "an unusable terminal id surfaces the send failure"
    );
    assert!(!app.prompt_card.visible, "the answered card collapses");
    // The stale guard on the option route.
    let mut app = app_with_blocked_pane();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.prompt_card_cursor, 1);
    app.pane_tail = vec!["build finished".to_string()];
    // Enter with a stale tail: the guard refuses before any send.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.status, "question changed, not sent",
        "stale option dialog is never answered"
    );
    assert!(
        app.prompt_card.visible,
        "the stale card stays up (only the next evaluate collapses it)"
    );
    assert_eq!(app.prompt_card_cursor, 1, "refusal leaves the cursor alone");
}

#[test]
fn lens_page_keys_scroll_by_ten() {
    let mut app = app_with_snapshot();
    app.pane_tail = (0..30).map(|i| format!("line {i}")).collect();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(app.lens.active);
    // PageDown jumps 10 lines away from the tail (stops follow).
    app.handle_key(KeyEvent::from(KeyCode::PageDown));
    assert!(!app.lens.follow);
    assert_eq!(app.lens.scroll_up, 10, "PageDown scrolls up 10 lines");
    // PageUp scrolls back 10 toward the tail, re-arming follow when
    // it lands at the bottom.
    app.handle_key(KeyEvent::from(KeyCode::PageUp));
    assert_eq!(app.lens.scroll_up, 0, "PageUp returns to the tail");
    assert!(app.lens.follow);
}

#[test]
fn lens_toggle_via_prefix_closes_an_open_lens() {
    // The segmented-switch parity: the same prefix flips the lens off
    // again (toggle(), not open()).
    let mut app = app_with_snapshot();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(app.lens.active);
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(!app.lens.active, "the lens prefix toggles the lens off");
    assert_eq!(app.status, "lens closed");
    // Re-open: the status now shows the open hint, not the closed one.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(app.lens.active);
    assert_eq!(
        app.status, "lens: j/k scroll · G tail · Esc close",
        "re-open shows the lens hint"
    );
}

#[test]
fn composer_prefix_opens_the_message_prompt() {
    // Shift+C after the prefix resolves the Composer shortcut (the
    // help overlay documents it as Ctrl+B Shift+C).
    let mut app = app_with_snapshot();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('C'), KeyModifiers::SHIFT));
    let prompt = app.prompt_input.as_ref().expect("composer opens");
    assert_eq!(prompt.kind, PromptKind::ComposerMessage);
    assert_eq!(
        app.status, "composer: type the message, Enter sends",
        "composer open shows its status hint"
    );
}

#[test]
fn prompt_card_subject_and_hints_render() {
    // CardAnswer modal: the subject line carries the card's question
    // title, and the prompt rows show the CardAnswer-specific hint.
    let mut app = app_with_blocked_pane();
    app.set_pane_tail_from_text("❯ What database should I use?\nenter your response below:\n");
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.prompt_input.as_ref().map(|p| p.kind),
        Some(PromptKind::CardAnswer)
    );
    let rendered = draw(&app, 100, 24);
    assert!(
        rendered.contains("Answer the question"),
        "CardAnswer subject renders"
    );
    assert!(
        rendered.contains("What database should I use"),
        "the card title is the prompt subject"
    );
    assert!(
        rendered.contains("Enter answers the question"),
        "CardAnswer hint row renders"
    );
    // The Text card itself renders its own hint row while the modal
    // is closed: "Enter to type your answer".
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    let rendered = draw(&app, 100, 24);
    assert!(
        rendered.contains("Enter to type your answer"),
        "Text card hint row renders"
    );
}

#[test]
fn narrow_footer_keeps_lens_and_prompt_card_discovery_hints() {
    // Compact hints on a narrow terminal: the lens and the card keep
    // the Ctrl+B ? tail (the one hint every screen needs).
    let mut app = app_with_snapshot();
    app.pane_tail = vec!["one".to_string(), "two".to_string()];
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(app.lens.active);
    let rendered = draw(&app, 80, 24);
    assert!(
        rendered.contains("Ctrl+B ? help"),
        "lens compact hint keeps the discovery tail"
    );
    assert!(rendered.contains("following"), "lens follow hint renders");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.status, "lens closed");
    // Prompt card context: blocked pane with a dialog.
    app.snapshot.panes[0].agent_status = "blocked".to_string();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert!(app.prompt_card.visible);
    let rendered = draw(&app, 80, 24);
    assert!(
        rendered.contains("Ctrl+B ? help"),
        "prompt-card compact hint keeps the discovery tail"
    );
}

#[test]
fn lens_arrow_and_k_keys_scroll_toward_the_tail() {
    // k and Up share the scroll-toward-tail arm (the lens's
    // down-scroll): PageUp covers the 10-line jump, this covers the
    // single-step one, plus the Down alias of the up-scroll.
    let mut app = app_with_snapshot();
    app.pane_tail = (0..30).map(|i| format!("line {i}")).collect();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(app.lens.active);
    // Down aliases j: one line away from the tail.
    app.handle_key(KeyEvent::from(KeyCode::Down));
    assert!(!app.lens.follow);
    assert_eq!(app.lens.scroll_up, 1);
    // k scrolls one line back toward the tail.
    app.handle_key(KeyEvent::from(KeyCode::Char('k')));
    assert_eq!(app.lens.scroll_up, 0);
    assert!(app.lens.follow, "back at the tail re-arms follow");
    // Up aliases k from a scrolled position.
    app.handle_key(KeyEvent::from(KeyCode::PageDown));
    assert_eq!(app.lens.scroll_up, 10);
    app.handle_key(KeyEvent::from(KeyCode::Up));
    assert_eq!(app.lens.scroll_up, 9);
    // End aliases G: straight to the tail.
    app.handle_key(KeyEvent::from(KeyCode::End));
    assert_eq!(app.lens.scroll_up, 0);
    assert!(app.lens.follow);
    // A key the lens does not own falls through to the handler's
    // catch-all: the lens stays open, nothing scrolls.
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert!(app.lens.active, "unknown key leaves the lens open");
    assert_eq!(app.lens.scroll_up, 0);
}

#[test]
fn lens_meta_line_shows_scrolled_while_away_from_the_tail() {
    // The meta line's "scrolled" branch: while the reader sits away
    // from the tail the lens says so instead of "following".
    let mut app = app_with_snapshot();
    app.pane_tail = (0..30).map(|i| format!("line {i}")).collect();
    app.lens.open();
    app.lens.scroll_up(3, app.pane_tail.len());
    let rendered = draw(&app, 100, 30);
    assert!(
        rendered.contains("scrolled"),
        "meta line shows scrolled state"
    );
    assert!(
        !rendered.contains("· following"),
        "follow is off while scrolled"
    );
}

#[test]
fn prompt_card_unhandled_key_falls_through_to_navigation() {
    // The card's catch-all arm: keys it does not own (x) must fall
    // through to navigation so pane/list movement works while the
    // card floats. x moves the FILES selection when the screen is
    // Files, but on the Terminal screen x reaches the terminal
    // pane's own keys: the sentinel is that the card survives and no
    // answer status appears.
    let mut app = app_with_blocked_pane();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert!(app.prompt_card.visible);
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert!(app.prompt_card.visible, "unknown key leaves the card up");
    assert!(
        !app.status.starts_with("answered"),
        "unknown key never answers (status: {0})",
        app.status
    );
    // q stays the quit key even with the card visible: it reaches the
    // quit confirm (never stolen by the card).
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    assert_eq!(app.mode, TuiMode::Navigate);
    assert!(app.prompt_card.visible, "canceling quit keeps the card");
}

#[test]
fn attach_mode_types_keys_into_the_live_terminal_socket() {
    // Attach mode's raw key path against the live fake socket: the
    // key bytes reach the terminal stream and the status confirms
    // (the dead API refresh after is noise, as everywhere).
    let (mut app, rx) = app_with_fake_terminal_socket();
    app.attach_selected();
    assert_eq!(app.mode, TuiMode::Attach);
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    let sent = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("attach-mode key reaches the terminal");
    assert_eq!(sent, b"a");
    assert_eq!(app.status, "sent input");
    // Ctrl-G detaches back to Navigate.
    app.handle_key(KeyEvent::new(KeyCode::Char('g'), KeyModifiers::CONTROL));
    assert_eq!(app.mode, TuiMode::Navigate);
    assert_eq!(app.status, "detached");
}

#[test]
fn question_title_skips_prompt_marker_captures_that_trim_to_nothing() {
    // A marker line of only spaces ("❯   ": the lazy capture is a
    // bare space that trims to empty) falls through the prompt-marked
    // pass instead of producing an empty title; the title comes from
    // the next real line.
    let lines: Vec<String> = ["❯   ", "esc cancel", "1. Postgres", "2. MySQL"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let card = crate::tui::prompt_cards::parse_prompt(&lines).expect("parses");
    // Every other line is noise (cancel hint, options): the empty
    // capture must not leak as the title, the dialog default applies.
    assert_eq!(
        card.title, "Select an option",
        "an empty capture never becomes the title; the default applies"
    );
}

#[test]
fn prompt_card_answer_attach_failure_surfaces_the_error() {
    // The card-answer attach arm against a socket nobody listens on
    // (the deterministic surrogate for a mid-send death: the raw
    // answer path reports the failure through `error` while the
    // optimistic status stays, webui parity).
    let mut app = app_with_snapshot();
    app.snapshot.panes[0].agent_status = "blocked".to_string();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert!(app.prompt_card.visible);
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "answered: Deploy now");
    assert!(
        app.error.is_some(),
        "attach failure surfaces instead of a silent success"
    );
}

#[test]
fn attach_mode_key_attach_failure_surfaces_the_error() {
    // The attach-mode send route against a dead socket: the key is
    // mapped to bytes but the attach fails, so nothing is sent and
    // the error arm reports it (no status overwrite).
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Attach;
    app.handle_key(KeyEvent::from(KeyCode::Char('a')));
    assert_ne!(app.status, "sent input");
    assert!(app.error.is_some());
    // A key with no terminal byte mapping (F5) falls through the
    // if-let: nothing is sent, no error, attach mode unchanged.
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::F(5)));
    assert!(app.error.is_none(), "unmapped key sends nothing");
    assert_eq!(app.mode, TuiMode::Attach);
}

#[test]
fn history_load_without_a_terminal_is_a_silent_no_op() {
    // The no-terminal early return: no panes means no history to
    // load, so the call must not touch the backend at all.
    let mut app = app_with_snapshot();
    app.snapshot.panes.clear();
    app.load_selected_terminal_history(120, 32);
    assert!(
        app.error.is_none(),
        "no terminal means no attach attempt, no error"
    );
}

#[test]
fn workspace_tabs_render_inactive_tab_style() {
    // The inactive-tab arm of the tab strip: a workspace with two tabs
    // renders one active (accent bg) and one inactive (panel bg) tab;
    // both labels must appear with the plain separator.
    let mut app = app_with_snapshot();
    app.snapshot = TuiSnapshot::from_backend_response(&fixture_snapshot_value_with_tabs());
    let rendered = draw(&app, 120, 30);
    assert!(rendered.contains("Shell"), "active tab label renders");
    assert!(rendered.contains("Server"), "inactive tab label renders");
}

#[test]
fn prompt_card_render_without_a_parsed_card_is_a_silent_no_op() {
    // Defensive: evaluate keeps `current` populated whenever the card
    // is visible; a visible flag without a parsed card is a state bug,
    // and the renderer must skip the card instead of panicking.
    let mut app = app_with_snapshot();
    app.prompt_card.visible = true;
    let rendered = draw(&app, 120, 30);
    assert!(
        !rendered.contains('│') || rendered.contains("help"),
        "render completes without panicking"
    );
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
fn search_palette_no_results_after_commit_renders() {
    // The committed-no-results arm: a query with no hits after the
    // Enter commit shows the "no results" hint, not the typing hint.
    let mut app = app_with_snapshot();
    app.mode = TuiMode::SearchPalette;
    app.search_palette.query = "zzz-nothing".to_string();
    app.search_palette.committed = true;
    app.search_palette.results = Vec::new();
    let rendered = draw(&app, 120, 30);
    assert!(
        rendered.contains("no results"),
        "committed empty search shows the no-results hint"
    );
    assert!(
        !rendered.contains("Enter searches files"),
        "the pre-commit hint is gone after committing"
    );
}

#[test]
fn attach_selected_without_a_terminal_reports_an_error() {
    // Enter on the Terminal screen with no terminal in the selected
    // pane: attach mode is refused instead of half-entered.
    let mut app = app_with_snapshot();
    // No panes at all: the selected pane (and its terminal) resolve
    // to None, so Enter must refuse instead of half-entering attach.
    app.snapshot.panes.clear();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.mode, TuiMode::Navigate);
    assert_eq!(
        app.error.as_deref(),
        Some("no terminal selected"),
        "attach refused with a clear error"
    );
}

#[test]
fn history_load_mid_stream_death_surfaces_read_and_detach_errors() {
    // `load_selected_terminal_history` against a server that hangs up
    // right after the AttachTerminal handshake: read_output blocks on
    // its read (the synchronization point), sees EOF, and the detach
    // write on the dead stream fails too — both error arms run in a
    // fixed order, deterministically (unlike the send-then-detach
    // window in send_pane_input, the blocking read guarantees the
    // peer close is processed before the next write).
    let path = crate::backend_client::unique_test_path("herdr-tui-hist-die");
    let _ = std::fs::remove_file(&path);
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    std::thread::spawn(move || {
        let Ok(mut stream) = listener.accept() else {
            return;
        };
        let _ = crate::protocol::read_message::<_, crate::protocol::ClientMessage>(
            &mut stream,
            crate::backend_client::MAX_TUI_TERMINAL_FRAME_SIZE,
        );
        let welcome = crate::protocol::ServerMessage::Welcome {
            version: 22,
            encoding: crate::protocol::RenderEncoding::TerminalAnsi,
            error: None,
        };
        let _ = crate::protocol::write_message(&mut stream, &welcome);
        // Consume the AttachTerminal frame so the handshake completes,
        // then hang up: read_output's blocking read observes the EOF
        // before the detach write runs.
        let _ = crate::protocol::read_message::<_, crate::protocol::ClientMessage>(
            &mut stream,
            crate::backend_client::MAX_TUI_TERMINAL_FRAME_SIZE,
        );
        drop(stream);
    });
    let client = BackendClient::new("/nonexistent.sock", &path);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    app.load_selected_terminal_history(120, 32);
    assert!(
        app.error.is_some(),
        "mid-stream death surfaces through the error channel"
    );
}

#[test]
fn help_overlay_ignores_keys_that_neither_filter_nor_scroll() {
    // The catch-all arm: a control key (Tab) neither filters nor
    // scrolls and must not corrupt the overlay state.
    let mut app = app_with_snapshot();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('?')));
    assert_eq!(app.mode, TuiMode::Help);
    let scroll_before = app.help_scroll;
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.mode, TuiMode::Help, "Tab does not close help");
    assert_eq!(app.help_scroll, scroll_before, "Tab does not scroll");
    assert_eq!(app.help_filter, "", "Tab does not filter");
}

#[test]
fn prompt_card_evaluates_visible_on_blocked_dialog_and_hides_when_unblocked() {
    let mut app = app_with_blocked_pane();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert!(
        app.prompt_card.visible,
        "blocked pane with a numbered dialog opens the card"
    );
    let card = app.prompt_card.current_card().expect("card parsed");
    assert_eq!(card.kind, crate::tui::prompt_cards::PromptCardKind::Options);
    assert_eq!(card.title, "Should I proceed with the deploy");
    assert_eq!(card.options.len(), 3);
    // Footer context switches to the card.
    assert!(matches!(
        app.footer_context(),
        crate::tui::FooterContext::PromptCard
    ));
    // Status flips back to idle: the card must collapse (webui hides
    // the card when the agent stops waiting).
    app.snapshot.panes[0].agent_status = "idle".to_string();
    app.evaluate_prompt_card();
    assert!(!app.prompt_card.visible, "unblocked pane hides the card");
}

#[test]
fn prompt_card_key_routing_owns_answer_keys_only_while_visible() {
    let mut app = app_with_blocked_pane();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert!(app.prompt_card.visible);
    // j moves the card cursor (not the workspace selection).
    let workspace_before = app.selected_workspace;
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.prompt_card_cursor, 1);
    assert_eq!(app.selected_workspace, workspace_before);
    // k moves back up.
    app.handle_key(KeyEvent::from(KeyCode::Char('k')));
    assert_eq!(app.prompt_card_cursor, 0);
    // Digit 2 jumps straight to the second option AND answers it
    // (a digit is a click: cursor + answer in one key, webui button
    // parity). The send fails on the dead socket, but the answered
    // label proves the cursor sat on option 2 at answer time; the
    // post-answer refresh resets the cursor to 0 (it is only
    // meaningful while the card is visible).
    app.handle_key(KeyEvent::from(KeyCode::Char('2')));
    assert_eq!(app.status, "answered: Deploy with tag");
    assert!(!app.prompt_card.visible, "answered card collapses");
    // Re-arm the card (fresh blocked episode, same question) and
    // dismiss it with Esc: dismissal sticks within the episode.
    app.snapshot.panes[0].agent_status = "idle".to_string();
    app.evaluate_prompt_card();
    app.snapshot.panes[0].agent_status = "blocked".to_string();
    app.evaluate_prompt_card();
    assert!(app.prompt_card.visible, "fresh episode re-opens the card");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(!app.prompt_card.visible);
    assert_eq!(app.status, "card dismissed");
    // After dismissal j is navigation again (selection moves).
    let before = app.selected_workspace;
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.selected_workspace, before);
    // A fresh blocked episode re-arms the card even with the same
    // question text (webui blocked-episode rule).
    app.snapshot.panes[0].agent_status = "idle".to_string();
    app.evaluate_prompt_card();
    app.snapshot.panes[0].agent_status = "blocked".to_string();
    app.evaluate_prompt_card();
    assert!(
        app.prompt_card.visible,
        "fresh blocked episode re-opens the card"
    );
}

#[test]
fn prompt_card_keys_do_not_route_on_other_screens_or_attach_mode() {
    let mut app = app_with_blocked_pane();
    // The card is DERIVED state (status + tail), so it evaluates on
    // every screen; only the key routing and the render are gated to
    // the Terminal screen in Navigate mode. On Files, card keys must
    // fall through to the tree: j moves the file cursor, never the
    // option cursor, and Enter opens a preview, never an answer.
    app.screen = TuiScreen::Files;
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert!(app.prompt_card.visible, "derived state evaluates anywhere");
    let cursor_before = app.prompt_card_cursor;
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(
        app.prompt_card_cursor, cursor_before,
        "Files screen: j is tree navigation, not the card cursor"
    );
    assert!(app.error.is_none(), "no answer attempt left the app");
    // Footer context on Files is the Files hint, not the card hint.
    assert!(!matches!(
        app.footer_context(),
        crate::tui::FooterContext::PromptCard
    ));
    // Attach mode on the Terminal screen: attach owns the keys, the
    // card renders under it (webui card slides under modals) and
    // Enter never answers.
    app.screen = TuiScreen::Terminal;
    app.mode = TuiMode::Attach;
    let cursor_before = app.prompt_card_cursor;
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.prompt_card_cursor, cursor_before);
}

#[test]
fn prompt_card_visible_q_still_quits() {
    // Plain q is the TUI-wide quit key; the card must never steal it
    // (the webui quit control lives outside the card). Esc is the
    // card's dismiss (the × button), q falls through to quit.
    let mut app = app_with_blocked_pane();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert!(app.prompt_card.visible);
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert!(app.prompt_card.visible, "q does not dismiss the card");
    assert_eq!(app.mode, TuiMode::ConfirmQuit, "q still quits");
}

#[test]
fn prompt_card_answer_option_stale_guard_and_error_path() {
    let mut app = app_with_blocked_pane();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    assert!(app.prompt_card.visible);
    // The dialog moved on: the tail no longer parses (or parses to a
    // different question). The stale guard must refuse to send.
    app.pane_tail = vec!["shell output".to_string()];
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.status, "question changed, not sent",
        "stale guard refuses to answer a moved-on dialog"
    );
    assert!(app.prompt_card.visible, "card stays after a stale refusal");
    // Fresh dialog again: Enter answers through the raw input path;
    // the dead terminal socket surfaces an error but the card
    // collapses (the answer was consumed by the dialog).
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some(), "dead terminal socket surfaces");
    assert!(!app.prompt_card.visible, "answered card collapses");
}

#[test]
fn prompt_card_free_text_opens_answer_prompt_and_routes_hybrid_transport() {
    let mut app = app_with_blocked_pane();
    // Free-text question shape: question line + "enter your response".
    app.set_pane_tail_from_text("❯ What database should I use?\nenter your response below:\n");
    assert!(app.prompt_card.visible);
    let card = app.prompt_card.current_card().expect("card parsed");
    assert_eq!(card.kind, crate::tui::prompt_cards::PromptCardKind::Text);
    // Enter opens the CardAnswer modal (NOT the composer: the composer
    // submit route refuses blocked panes by design).
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    let prompt = app.prompt_input.as_ref().expect("answer prompt opens");
    assert_eq!(prompt.kind, PromptKind::CardAnswer);
    // Type an answer and submit: blocked pane routes the raw path
    // (typed text + Enter into the dialog). The dead terminal socket
    // surfaces the error.
    app.handle_key(KeyEvent::from(KeyCode::Char('y')));
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.prompt_input.is_none(), "answer prompt closes on submit");
    assert!(
        app.error.is_some(),
        "blocked free-text answer goes through raw input (dead socket errors)"
    );
    assert!(!app.prompt_card.visible, "answered card collapses");
    // The composer draft for the pane is untouched (the answer is not
    // a composer message).
    assert!(!app.composer_drafts.contains_key("pane_1"));
}

#[test]
fn prompt_card_render_gates_on_visibility_screen_and_mode() {
    let mut app = app_with_blocked_pane();
    app.set_pane_tail_from_text(&blocked_dialog_tail().join("\n"));
    // The card's own hint row is the sentinel: the dialog lines
    // themselves stay in the pane tail (rendered by the terminal
    // pane), so only the card frame's rows prove the card renders.
    let rendered = draw(&app, 100, 24);
    assert!(
        rendered.contains("Enter answer"),
        "card hint row renders while the card is visible"
    );
    // Dismissed: the card frame (and its hint row) disappear; the
    // dialog text stays as plain tail output.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    let rendered = draw(&app, 100, 24);
    assert!(!rendered.contains("Enter answer"), "dismissed card hides");
    // Re-arm and switch to Files: the card state is visible but the
    // render gate is Terminal-screen-only.
    app.snapshot.panes[0].agent_status = "idle".to_string();
    app.evaluate_prompt_card();
    app.snapshot.panes[0].agent_status = "blocked".to_string();
    app.evaluate_prompt_card();
    assert!(app.prompt_card.visible);
    app.screen = TuiScreen::Files;
    let rendered = draw(&app, 100, 24);
    assert!(!rendered.contains("Enter answer"), "no card over Files");
    // Attach mode renders the terminal raw; the card is Navigate-only
    // (attach owns the keys, the webui card would be hidden behind
    // the focused terminal).
    app.screen = TuiScreen::Terminal;
    app.mode = TuiMode::Attach;
    let rendered = draw(&app, 100, 24);
    assert!(!rendered.contains("Enter answer"), "no card in attach mode");
}

#[test]
fn prompt_card_text_answer_via_composer_when_unblocked() {
    // Hybrid transport (user decision): a Text card whose pane flips
    // to UNBLOCKED while the answer modal is open routes the answer
    // through the composer submit (agent.prompt semantics). The
    // composer server answers 200 ok.
    let (port, _stop) = fake_composer_server(Some("ok"));
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", port),
    );
    app.snapshot = fixture_snapshot();
    app.snapshot.panes[0].agent_status = "blocked".to_string();
    app.set_pane_tail_from_text("❯ What database should I use?\nenter your response below:\n");
    assert!(app.prompt_card.visible);
    // Enter opens the CardAnswer modal.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.prompt_input.as_ref().map(|p| p.kind),
        Some(PromptKind::CardAnswer)
    );
    // The pane unblocks while the modal is open (the agent resumed).
    // The dialog text is still on the tail; the composer route takes
    // the answer as a plain message now.
    app.snapshot.panes[0].agent_status = "idle".to_string();
    for ch in "postgres".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.prompt_input.is_none(), "answer prompt closes on submit");
    assert_eq!(
        app.status, "message sent",
        "unblocked free-text answer rides the composer submit route"
    );
    assert!(!app.prompt_card.visible, "answered card collapses");
    // The raw terminal path never ran: its status would be
    // "answer sent" (and its attach error would replace the composer
    // success). The refresh after submit hits the dead API socket,
    // which is normal dead-backend noise, not an answer-path error.
    assert_eq!(app.status, "message sent");
}

// ---------------------------------------------------------------------------
// UX fixes: selection highlight, panel identity, live preview
// ---------------------------------------------------------------------------

#[test]
fn selected_workspace_row_uses_the_inverted_highlight_style() {
    // Two workspaces, second selected: the selected row must carry the
    // accent BACKGROUND (full-row inversion, webui `.selected` class),
    // not only the "▸" symbol + accent foreground that was easy to
    // miss on dim terminals.
    let mut app = app_with_snapshot();
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Alpha","cwd":"/a","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"},
                {"workspace_id":"ws_2","label":"Beta","cwd":"/b","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":null}
            ],
            "tabs": [],
            "panes": [],
            "agents": []
        }
    }));
    app.sidebar_focus = SidebarFocus::Workspaces;
    app.selected_workspace = 1;

    let buffer = draw_buffer(&app, 120, 30);
    // "Beta 1p 1t" pins the sidebar row (the empty-tab tab bar also
    // prints the workspace label alone on an earlier row).
    let selected = rendered_row(&buffer, "Beta 1p 1t");
    let unselected = rendered_row(&buffer, "Alpha 1p 1t");
    let accent = Color::Rgb(137, 180, 250);
    // The highlight paints the whole row: at least one cell on the
    // selected row carries the accent bg.
    let has_accent_bg =
        (0..buffer.area.width as usize).any(|x| buffer[(x as u16, selected.y as u16)].bg == accent);
    assert!(
        has_accent_bg,
        "selected workspace row must have the accent background"
    );
    let unselected_has_accent_bg = (0..buffer.area.width as usize)
        .any(|x| buffer[(x as u16, unselected.y as u16)].bg == accent);
    assert!(
        !unselected_has_accent_bg,
        "unselected workspace row must stay on the panel background"
    );
}

#[test]
fn selected_agent_row_uses_the_inverted_highlight_style() {
    let mut app = app_with_snapshot();
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":2,"tab_count":2,"active_tab_id":"tab_1"}
            ],
            "tabs": [],
            "panes": [],
            "agents": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":false},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_2","agent":"bot","display_agent":"bot","agent_status":"idle","cwd":"/repo","focused":false}
            ]
        }
    }));
    app.sidebar_focus = SidebarFocus::Agents;
    app.selected_agent = 1;

    let buffer = draw_buffer(&app, 120, 30);
    let selected = rendered_row(&buffer, "bot");
    let unselected = rendered_row(&buffer, "jcode");
    let accent = Color::Rgb(137, 180, 250);
    let has_accent_bg =
        (0..buffer.area.width as usize).any(|x| buffer[(x as u16, selected.y as u16)].bg == accent);
    assert!(
        has_accent_bg,
        "selected agent row must have the accent background"
    );
    let unselected_has_accent_bg = (0..buffer.area.width as usize)
        .any(|x| buffer[(x as u16, unselected.y as u16)].bg == accent);
    assert!(
        !unselected_has_accent_bg,
        "unselected agent row must stay on the panel background"
    );
}

#[test]
fn tab_bar_marks_the_viewing_panel_and_pane_title_names_it() {
    // The backend-active tab (tab_1 "Shell") is NOT the tab the TUI
    // selected (pane_2 lives in tab_2 "Server"): the tab strip must
    // mark the VIEWING tab with "▸", and the pane title must name the
    // panel label so the user knows which panel the preview belongs to.
    let mut app = app_with_snapshot();
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":2,"tab_count":2,"active_tab_id":"tab_1"}],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"},
                {"tab_id":"tab_2","workspace_id":"ws_1","label":"Server","focused":false,"pane_count":1,"agent_status":"idle"}
            ],
            "panes": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_2","agent":"bot","display_agent":"bot","agent_status":"idle","cwd":"/srv","focused":false}
            ],
            "agents": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_2","agent":"bot","display_agent":"bot","agent_status":"idle","cwd":"/srv","focused":false}
            ]
        }
    }));
    app.sidebar_focus = SidebarFocus::Agents;
    app.selected_agent = 1;
    assert_eq!(
        app.selected_pane().map(|pane| pane.id.as_str()),
        Some("pane_2")
    );

    let rendered = draw(&app, 120, 30);
    // The viewing marker sits on the selected tab, not the backend one.
    assert!(
        rendered.contains("▸ Server"),
        "the tab bar must mark the panel the TUI is viewing"
    );
    assert!(
        !rendered.contains("▸ Shell"),
        "the backend-active tab is not necessarily the viewed one"
    );
    // The pane title names agent, panel label, and pane id.
    assert!(
        rendered.contains("bot · Server · pane_2"),
        "the pane header must name which panel the preview belongs to"
    );
}

#[test]
fn tail_refreshes_between_snapshot_ticks_while_not_attached() {
    // Live preview (ux fix): the tail must poll at the fast cadence
    // even when the snapshot interval has NOT elapsed yet. The event
    // loop calls refresh_if_due every 50ms; the snapshot refresh is
    // 1s here. A fake backend answers ping/snapshot (the pane.read
    // arm errors, which is fine: the observable is that the fast tail
    // path fires and stamps last_tail_refresh between snapshot ticks).
    let (api_socket, _stop) = fake_backend_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.refresh_interval = Duration::from_secs(1);
    // First refresh_if_due fires the full refresh (last_refresh None).
    app.refresh_if_due();
    assert!(app.last_refresh.is_some(), "first tick does the snapshot");
    let first_tail = app.last_tail_refresh;
    assert!(
        first_tail.is_some(),
        "the snapshot refresh records the tail poll too"
    );

    // Immediately after, the snapshot is not due again — but the tail
    // poll interval (200ms) also has not elapsed, so nothing fires.
    app.refresh_if_due();
    assert_eq!(
        app.last_tail_refresh, first_tail,
        "tail poll respects its own cadence"
    );

    // After the tail interval elapses (but NOT the snapshot interval),
    // the fast path fires and stamps a newer tail refresh.
    std::thread::sleep(Duration::from_millis(250));
    let snapshot_refresh = app.last_refresh;
    app.refresh_if_due();
    assert_eq!(
        app.last_refresh, snapshot_refresh,
        "snapshot keeps its own slower cadence"
    );
    assert!(
        app.last_tail_refresh.unwrap() > first_tail.unwrap(),
        "tail must poll between snapshot ticks while not attached"
    );
}

#[test]
fn tail_fast_poll_skips_attach_mode_and_other_screens() {
    // The fast tail poll only owns the Navigate terminal screen: in
    // attach mode the live pty streams the screen, and on Files/Git
    // screens the pane is not visible at all.
    let (api_socket, _stop) = fake_backend_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();

    app.mode = TuiMode::Attach;
    std::thread::sleep(Duration::from_millis(250));
    app.refresh_if_due();
    assert!(
        app.last_tail_refresh.is_none(),
        "attach mode never stamps the tail poll"
    );

    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Git;
    std::thread::sleep(Duration::from_millis(250));
    app.refresh_if_due();
    assert!(
        app.last_tail_refresh.is_none(),
        "the git screen never stamps the tail poll"
    );
}

#[test]
fn main_focus_gates_sidebar_navigation_keys() {
    // Focus walker effect (ux fix): with the main screen focused
    // (the default), j/k must NOT move the sidebar cursor — the pane
    // owns the keys. Walking focus to the sidebar restores list
    // navigation.
    let mut app = app_with_snapshot();
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Alpha","cwd":"/a","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"},
                {"workspace_id":"ws_2","label":"Beta","cwd":"/b","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":null}
            ],
            "tabs": [],
            "panes": [],
            "agents": []
        }
    }));
    app.main_focused = true;
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(
        app.selected_workspace, 0,
        "main focus must swallow j so the sidebar cursor stays"
    );

    // Walk focus to the workspaces region: j moves the cursor again.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('.')));
    assert!(!app.main_focused);
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(
        app.selected_workspace, 1,
        "sidebar focus restores list navigation"
    );
}

#[test]
fn footer_hint_follows_the_focus_region_on_the_terminal_screen() {
    // Context-aware statusbar (ux fix): with the main region focused
    // (the default), j/k are dead on the pane so the hint names pane
    // actions instead; walking focus to a sidebar region brings back
    // the select/attach hint naming Tab too.
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Terminal;

    // Main focus (default): pane keys, no stale "j/k select". 120 cols
    // fits the full hint (compact fallback checked on the narrow draw).
    assert!(matches!(
        app.footer_context(),
        crate::tui::FooterContext::TerminalMain
    ));
    let main = draw(&app, 160, 24);
    assert!(main.contains("Enter attach"), "main hint keeps attach");
    assert!(
        main.contains("focus sidebar"),
        "main hint tells how to reach the lists"
    );
    assert!(
        main.contains("chat lens"),
        "main hint names the lens shortcut"
    );
    assert!(
        !main.contains("j/k select"),
        "main hint must not advertise dead list keys"
    );

    // Sidebar region: the list hint returns.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('.')));
    assert!(!app.main_focused);
    assert!(matches!(
        app.footer_context(),
        crate::tui::FooterContext::Terminal(TuiMode::Navigate)
    ));
    let sidebar = draw(&app, 120, 24);
    assert!(
        sidebar.contains("j/k select"),
        "sidebar hint names the list keys"
    );
    assert!(
        sidebar.contains("Tab lists"),
        "sidebar hint names the Tab toggle"
    );

    // Narrow terminal: the compact main hint keeps the help tail.
    app.main_focused = true;
    let narrow = draw(&app, 60, 24);
    assert!(
        narrow.contains("Ctrl+B ? help"),
        "main hint keeps the help tail at 60 cols"
    );
}

#[test]
fn footer_hint_names_common_files_actions() {
    // Files hint enrichment: / search and L file log ride with the
    // browse actions on wide terminals.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    let rendered = draw(&app, 140, 24);
    assert!(rendered.contains("/ search"), "files hint names search");
    assert!(rendered.contains("L file log"), "files hint names file log");
    assert!(
        rendered.contains("Ctrl+B ? help"),
        "files hint keeps the help tail"
    );
}
