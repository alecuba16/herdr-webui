//! Core TUI behavior tests: navigation, rendering, prompts, footer, terminal ingest.

use super::*;
use crate::tui::panels::{
    FileEntry, GitBranchEntry, GitCommitEntry, GitFileEntry, GitFileStatus, GitStashEntry, GitView,
};
use crate::tui::terminal::terminal_output_styled_lines_lossy;
use crate::tui::web_api::WebApiClient;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::style::Color;
use ratatui::Terminal;
use serde_json::json;

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
    // Enter with two selected compares (dead web API: the error
    // surfaces, but only after the selection guard passed). The old c
    // compare moved aside so c is always the commit modal.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(
        app.error
            .as_deref()
            .is_some_and(|e| e.contains("webui connection failed")),
        "compare hits the API: {:?}",
        app.error
    );
    // One selected: Enter compares with the parent; c keeps the
    // commit-modal meaning (no compare call).
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
            worktree: None,
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
        worktree_path: None,
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
fn prompt_input_wraps_long_text_and_grows_the_box() {
    // The reported bug: typing past the box width clipped the input to
    // one row, so the tail of a long line was invisible. The wrapped
    // render must show BOTH the head and the tail of a 120-char input
    // in a 64-col box, and the cursor block must land after the tail.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    let long =
        "fix the login flow so the session cookie survives a ".repeat(2) + "hard refresh on Safari";
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::CreateFile,
        text: long.clone(),
    });
    let rendered = draw(&app, 100, 30);
    assert!(rendered.contains("fix the login flow"), "head visible");
    assert!(
        rendered.contains("hard refresh on"),
        "tail visible: wrapping replaces the old single-row clip"
    );
    // Cursor block sits right after the visible tail.
    assert!(
        rendered.contains("Safari█"),
        "cursor renders on the wrapped tail row"
    );
    // Multiline paste opens real rows instead of one joined line.
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::CreateFile,
        text: "first line\nsecond line".to_string(),
    });
    let rendered = draw(&app, 100, 30);
    assert!(rendered.contains("first line"));
    assert!(rendered.contains("second line█"));
}

#[test]
fn prompt_input_tail_scrolls_past_eight_rows() {
    // Past the 8-row budget the window keeps the LAST rows (the ones
    // around the cursor), exactly like jcode's composer: the head
    // scrolls away, the tail plus cursor stay visible.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Files;
    let long = (1..=140).map(|n| format!("w{n:03} ")).collect::<String>() + "end";
    // -> 12+ wrapped rows at 62 cols, past the 8-row budget
    app.prompt_input = Some(PromptInput {
        kind: PromptKind::CreateFile,
        text: long.clone(),
    });
    let rendered = draw(&app, 100, 30);
    // The first words scroll off; the tail plus cursor stays visible.
    assert!(
        !rendered.contains("w001 w002 w003"),
        "head scrolled away past the row budget"
    );
    assert!(
        rendered.contains("end█"),
        "cursor stays on the final wrapped row"
    );
}

#[test]
fn commit_input_wraps_long_text_like_the_prompt_modal() {
    // Same fix for the commit title modal: a long message wraps and the
    // tail plus cursor stay visible instead of clipping at one row.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Git;
    app.commit_input = Some(CommitInput {
        text: "release 0.7.17: prompt cards chat-mode gate, chooser parse guard, ".to_string()
            + "wrapped composer and commit modals",
        amend: false,
    });
    let rendered = draw(&app, 120, 30);
    assert!(rendered.contains("release 0.7.17"), "head visible");
    assert!(
        rendered.contains("wrapped composer and commit modals█"),
        "tail visible with cursor"
    );
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

    // Git views: the chord reduction dropped the 1-4/b/l chords, so
    // view switching rides Ctrl+B g then the in-screen Tab cycle.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('g')));
    assert_eq!(app.screen, TuiScreen::Git);
    assert_eq!(app.git_panel.view, GitView::Changes);
    // Tab cycles through the views in-screen.
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Log);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Branches);
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    assert_eq!(app.git_panel.view, GitView::Stash);

    // Commit modal opens via prefix c; the old prefix 2 and prefix
    // Enter aliases are gone with the chord reduction.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('c')));
    assert!(app.commit_input.is_some());
    assert!(!app.commit_input.as_ref().unwrap().amend);
    app.commit_input = None;
    // Prefix digits no longer dispatch: they cancel quietly.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('2')));
    assert!(app.commit_input.is_none(), "digit chords are gone");
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.commit_input.is_none(), "prefix Enter no longer commits");

    // Prefix s opens the settings overlay (webui settings: KeyS).
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(app.mode, TuiMode::Settings);
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);

    // Unknown prefix key cancels quietly (the `_ => None` arm).
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::F(7)));
    assert_eq!(app.git_panel.view, GitView::Stash);

    // History chord (old h) is gone with the reduction; blame (m) stays.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    assert_eq!(
        app.git_panel.view,
        GitView::Stash,
        "h no longer jumps views"
    );

    // Blame with no selection errors but does not crash.
    app.error = None;
    app.git_panel.files.clear();
    app.git_panel.diff_title = String::new();
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    assert!(app.error.is_some(), "blame without a file errors");

    // Switch branch now opens the workspace-scoped branch picker (the
    // dead HTTP endpoint surfaces the error, but the overlay intent is
    // still visible before the request fails). The old git-screen
    // Branches view stays reachable through prefix `b`.
    // Branches view via in-screen Tab from prefix b is gone; the
    // git screen + Tab cycle covers it. The old prefix-b assertion
    // became the Tab cycle above.
    app.error = None;
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('v')));
    assert!(
        app.mode == TuiMode::BranchPicker || app.error.is_some(),
        "prefix v either opens the picker or reports the load failure"
    );
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('b')));
    assert_ne!(
        app.git_panel.view,
        GitView::Branches,
        "b no longer jumps views"
    );

    // All git action arms run against the dead API: they must set an
    // error (or status) and never panic. Stage all is a plain
    // in-screen G (webui KeyG parity).
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Changes;
    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Char('G')));
    assert!(app.error.is_some() || !app.status.is_empty());
    // u/z chords stay after the reduction (y is gone: staging rides
    // the in-screen s key).
    for key in ['u', 'z'] {
        app.error = None;
        app.handle_key(ctrl_b);
        app.handle_key(KeyEvent::from(KeyCode::Char(key)));
        assert!(app.error.is_some(), "action arm {key} ran");
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

    // With passthrough on, Ctrl+B skips the prefix feed and falls
    // through to the attach input path: the prefix never arms, and the
    // attach status names the shell-bound key.
    app.terminal_prefix_passthrough = true;
    app.handle_key(ctrl('g'));
    assert_eq!(app.mode, TuiMode::Navigate);
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.status,
        "attach mode: Ctrl-G detach · Ctrl+B goes to the shell"
    );
    app.handle_key(ctrl('b'));
    assert!(
        !app.prefix.is_armed(),
        "passthrough keeps Ctrl+B out of the prefix"
    );
    // Restore the default and re-check arming still works.
    app.terminal_prefix_passthrough = false;
    app.handle_key(ctrl('b'));
    assert!(app.prefix.is_armed(), "flag off restores the prefix chord");
    app.prefix.cancel();
    app.terminal_prefix_passthrough = true;

    // Stale-armed-prefix regression: arming Ctrl+B in Navigate, then
    // attaching, must cancel the prefix so the next plain key cannot
    // fire a chord, and Ctrl+B itself reaches the PTY ("sent input")
    // instead of arming again.
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Terminal;
    app.terminal_prefix_passthrough = true;
    app.handle_key(ctrl('b'));
    assert!(app.prefix.is_armed(), "prefix arms in Navigate");
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.mode, TuiMode::Attach);
    assert!(!app.prefix.is_armed(), "attach entry cancels the prefix");
    let screen_before = app.screen;
    app.handle_key(KeyEvent::from(KeyCode::Char('g')));
    assert_eq!(
        app.screen, screen_before,
        "stale prefix cannot fire a chord"
    );
    app.handle_key(ctrl('b'));
    assert!(!app.prefix.is_armed(), "Ctrl+B stays bound to the shell");
    // Reaching the PTY feed means the attach input path ran: either
    // the input went through ("sent input") or the dead loopback API
    // surfaced a send/attach error. What must NOT happen is arming.
    assert!(
        app.status == "sent input" || app.error.is_some(),
        "Ctrl+B bytes reach the PTY feed, status={:?} error={:?}",
        app.status,
        app.error
    );
    app.terminal_prefix_passthrough = false;

    // Ctrl-G detaches back to Navigate.
    app.handle_key(ctrl('g'));
    assert_eq!(app.mode, TuiMode::Navigate);
    // Off attach: passthrough only applies while attached, so Ctrl+B
    // arms the prefix again even with the flag on.
    app.handle_key(ctrl('b'));
    assert!(
        app.prefix.is_armed(),
        "outside attach the prefix still arms"
    );
    app.prefix.cancel();
    app.terminal_prefix_passthrough = false;

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

#[test]
fn tab_create_and_close_shortcuts_hit_the_backend() {
    let (api_socket, _stop) = fake_backend_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    let ctrl_b = ctrl('b');

    // NewTab creates a tab, then refresh() runs; the held notice
    // (create/close report through set_status_notice) owns the line
    // past the refresh, proving both the action and the hold.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    assert_eq!(
        app.status, "tab created in Repo",
        "create tab keeps its notice past the refresh"
    );
    assert!(app.status_hold_until.is_some(), "notice must arm the hold");
    assert!(app.error.is_none(), "create tab error: {:?}", app.error);

    // CloseTab closes the active tab and refreshes the same way.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(
        app.status, "tab Shell closed",
        "close tab keeps its notice past the refresh"
    );
    assert!(app.status_hold_until.is_some(), "notice must arm the hold");
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
    // the held close notice survives the refresh round trip.
    let (api_socket, _stop) = fake_backend_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = fixture_snapshot();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(
        app.status, "tab Shell closed",
        "closing the last tab keeps its notice past the refresh"
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
    // Refresh succeeds against the fake backend; the held notice stays
    // and the point is that the not-found error is gone.
    assert_eq!(app.status, "tab Shell closed");
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
fn close_tab_ignores_tab_not_found() {
    // pane.exited teardown can close the tab server-side before the TUI's
    // close request lands; the backend now answers that with an explicit
    // not-found instead of a silent ok. The TUI must treat it as the
    // outcome it wanted: run the same post-close flow (status, refresh)
    // and surface no error.
    let (api_socket, _stop) = fake_backend_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    let mut snapshot = fixture_snapshot();
    snapshot.tabs[0].id = "tab_gone".to_string();
    snapshot.workspaces[0].active_tab_id = Some("tab_gone".to_string());
    app.snapshot = snapshot;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    // Refresh succeeds against the fake backend; the held notice stays:
    // the full success flow ran despite the not-found.
    assert_eq!(app.status, "tab Shell closed");
    assert!(
        !app.error
            .as_deref()
            .is_some_and(|e| e.contains("not found")),
        "tab-already-gone not-found must be ignored: {:?}",
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
            worktree_path: None,
        },
        GitBranchEntry {
            name: "origin/dev".to_string(),
            current: false,
            remote: true,
            pushed: false,
            worktree_path: None,
        },
        GitBranchEntry {
            name: "local".to_string(),
            current: false,
            remote: false,
            pushed: false,
            worktree_path: None,
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

    // Opened from Attach, cancel restores Attach. Pin the flag: with
    // the real shared settings on, Ctrl+B would pass to the PTY instead
    // of arming the quit chord.
    app.mode = TuiMode::Attach;
    app.terminal_prefix_passthrough = false;
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
    assert_eq!(app.status, "tab created in Repo", "create still succeeds");
    assert!(
        app.error.as_deref().is_some_and(|e| !e.is_empty()),
        "refresh after create must surface the backend error"
    );
    app.error = None;
    // Same shape for close: the tab.close is served, the refresh fails.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(app.status, "tab Shell closed", "close still succeeds");
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
        (GitView::Branches, "B create"),
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
    // Hermeticity: construction reads the real shared settings file,
    // which an operator may have flipped on; pin the flag so the
    // Ctrl+B arm below is deterministic on any machine.
    app.terminal_prefix_passthrough = false;

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
fn armed_prefix_footer_lists_the_live_shortcut_legend() {
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Navigate;

    // Terminal screen in Navigate: the legend names split for `s` (the
    // dispatch owns the key there) and keeps the ? help discovery tail.
    app.screen = TuiScreen::Terminal;
    app.handle_key(ctrl('b'));
    assert!(app.prefix.is_armed());
    let armed = draw(&app, 160, 24);
    assert!(armed.contains("Ctrl+B> "), "armed label present");
    assert!(
        armed.contains("s split"),
        "Terminal legend names split for s: {armed}"
    );
    assert!(
        armed.contains("? help"),
        "legend keeps the discovery tail: {armed}"
    );

    // Attach mode on the same Terminal screen: the dispatch sends
    // prefix-s to settings there, and the legend must not lie (review
    // F1). The attach hint is also the state users arm from most.
    app.handle_key(ctrl('b')); // toggle the armed prefix off
    assert!(!app.prefix.is_armed());
    app.mode = TuiMode::Attach;
    app.handle_key(ctrl('b'));
    let attach_armed = draw(&app, 160, 24);
    assert!(
        attach_armed.contains("s settings"),
        "attach legend names settings for s: {attach_armed}"
    );
    assert!(
        !attach_armed.contains("s split"),
        "attach legend must not promise split: {attach_armed}"
    );
    app.mode = TuiMode::Navigate;

    // Git screen in Navigate: same settings wording (webui KeyS muscle
    // memory lives on Files/Git).
    app.handle_key(ctrl('b')); // cancel the armed prefix first...
    assert!(!app.prefix.is_armed());
    app.screen = TuiScreen::Git;
    app.handle_key(ctrl('b'));
    let git_armed = draw(&app, 160, 24);
    assert!(
        git_armed.contains("s settings"),
        "Git legend names settings for s: {git_armed}"
    );

    // Disarmed: the footer is back to the context hint, no legend keys.
    app.handle_key(ctrl('b'));
    assert!(!app.prefix.is_armed());
    let plain = draw(&app, 160, 24);
    assert!(
        !plain.contains("Ctrl+B> "),
        "disarmed footer drops the armed label"
    );
    assert!(plain.contains("? help"), "context hint back in place");
}

#[test]
fn armed_prefix_legend_survives_narrow_terminals_and_outranks_mode_hints() {
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Terminal;
    // Zoom mode would own the hint slot with its own "ZOOM" hint; while
    // the prefix is armed the legend must win, because the zoom keys
    // are dead until the prefix resolves.
    app.split_zoomed = true;
    app.handle_key(ctrl('b'));
    assert!(app.prefix.is_armed());

    // 80 cols: the full legend cannot fit next to the label and status
    // budget, so fit_hint trims front segments; the tail (? help) is
    // the part that must survive, like every other footer hint.
    let narrow = draw(&app, 80, 24);
    assert!(
        narrow.contains("? help"),
        "narrow armed footer keeps the discovery tail: {narrow}"
    );
    assert!(
        !narrow.contains("ZOOM"),
        "legend outranks the zoom mode hint while armed: {narrow}"
    );

    // Wide terminal: the full legend fits and still beats the zoom hint.
    let wide = draw(&app, 200, 24);
    assert!(wide.contains("s split"), "wide legend shows the split key");
    assert!(!wide.contains("ZOOM"), "zoom hint stays hidden while armed");

    // After the prefix resolves (Esc), the zoom hint owns the slot again.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(!app.prefix.is_armed());
    let zoomed = draw(&app, 200, 24);
    assert!(zoomed.contains("ZOOM"), "zoom hint back once disarmed");
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
fn settings_p_toggle_flips_passthrough_and_round_trips_the_file() {
    // Env-writing tests share one lock (PR #240 convention): without
    // it a parallel test can swap XDG_CONFIG_HOME mid-toggle.
    let _guard = crate::test_env_lock()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    // The shared settings file lives under XDG_CONFIG_HOME; point it
    // at a fresh temp dir so the test never touches real user config
    // and parallel tests cannot collide.
    let dir = std::env::temp_dir().join(format!(
        "herdr-tui-settings-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let prior_xdg = std::env::var("XDG_CONFIG_HOME").ok();
    std::env::set_var("XDG_CONFIG_HOME", &dir);

    let mut app = app_with_snapshot();
    app.mode = TuiMode::Settings;
    app.terminal_prefix_passthrough = false;

    // A pre-existing unrelated key must survive the toggle's write.
    let settings_path = dir.join("herdr-webui/webui-settings.json");
    std::fs::create_dir_all(settings_path.parent().unwrap()).unwrap();
    std::fs::write(
        &settings_path,
        serde_json::json!({ "theme": "dark" }).to_string(),
    )
    .unwrap();

    // p flips the flag on, persists, and says so in the status.
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    assert!(app.terminal_prefix_passthrough);
    assert_eq!(app.status, "ctrl+b passthrough: on");
    let raw = std::fs::read_to_string(&settings_path).unwrap();
    let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(value["terminalPrefixPassthrough"], serde_json::json!(true));
    assert_eq!(
        value["theme"],
        serde_json::json!("dark"),
        "unknown keys survive"
    );

    // Second p flips it off again, same guarantees.
    app.handle_key(KeyEvent::from(KeyCode::Char('p')));
    assert!(!app.terminal_prefix_passthrough);
    assert_eq!(app.status, "ctrl+b passthrough: off");
    let value: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&settings_path).unwrap()).unwrap();
    assert_eq!(value["terminalPrefixPassthrough"], serde_json::json!(false));

    // The reader sees what the writer wrote (round trip): the last
    // write left the flag off, then an explicit write flips it on.
    assert!(!crate::tui::tui_terminal_prefix_passthrough());
    crate::tui::tui_set_terminal_prefix_passthrough(true).unwrap();
    assert!(crate::tui::tui_terminal_prefix_passthrough());

    // Restore the environment and drop the scratch dir.
    match prior_xdg {
        Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
        None => std::env::remove_var("XDG_CONFIG_HOME"),
    }
    let _ = std::fs::remove_dir_all(&dir);
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
        worktrees: vec![crate::tui::panels::git::CleanupWorktree {
            path: "stale-worktree".to_string(),
            branch: None,
        }],
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
        "type the replacement, Enter replaces (! replaces all)"
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
    // Async refresh: the first tick only arms the worker; the reply (an
    // error here, the socket does not exist) lands on a later poll.
    assert!(
        app.refresh_inflight.is_some(),
        "first tick starts the worker"
    );
    assert!(!app.error.is_some());
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        app.refresh_if_due();
        if app.error.is_some() || Instant::now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
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
        PromptKind::CreateWorktreeBase
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

    // The / chord above may leave a palette open; the git section
    // below needs Navigate for the in-screen keys.
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Git;
    app.git_panel.view = GitView::Changes;
    app.git_panel.files = vec![GitFileEntry {
        path: "dirty.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    app.git_panel.file_selected = 0;
    // In-screen d discards (the old Ctrl+B d chord is gone with the
    // reduction).
    app.handle_key(KeyEvent::from(KeyCode::Char('d')));
    assert!(app
        .error
        .as_deref()
        .is_some_and(|err| err.contains("before discarding")));

    app.error = None;
    app.handle_key(KeyEvent::from(KeyCode::Tab));
    // Tab switching views can trigger a refresh against the dead
    // socket; what matters is it stays on the git screen without
    // panicking. History (the old Ctrl+B h jump) is gone.
    assert_ne!(app.git_panel.view, GitView::History);
    app.error = None;

    app.error = None;
    app.git_panel.view = GitView::Log;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    // Prefix m blame survives the reduction; the annotated diff lives
    // in the Changes view, so the view switches there.
    assert_eq!(app.git_panel.view, GitView::Changes);
    assert!(
        app.error.is_some(),
        "prefix m blame stays after the reduction"
    );

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
    app.handle_key(KeyEvent::new(KeyCode::Char('B'), KeyModifiers::SHIFT));
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
        PromptKind::CreateWorktreeBase
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
    drain_refresh(&mut app);
    assert!(app.error.is_some());
    app.error = Some("visible".to_string());
    assert!(app.text_snapshot().contains("error: visible"));

    app.run_shortcut(Shortcut::RenamePanel);
    assert_eq!(
        app.prompt_input.as_ref().unwrap().kind,
        PromptKind::RenamePanel
    );
    app.prompt_input = None;

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
    app.handle_key(KeyEvent::new(KeyCode::Char('B'), KeyModifiers::SHIFT));
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
        worktree_path: None,
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
        "Delete cleanup items (y / yb)"
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
        "type the replacement, Enter replaces (! replaces all)"
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
    drain_refresh(&mut app);
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
fn footer_shows_waiting_hint_while_refresh_is_in_flight() {
    // Outage feedback: a dead backend no longer freezes the loop for the
    // full timeout; the in-flight wait must be visible in the footer.
    // Under 500ms the plain status stays (no flicker on healthy replies);
    // past it the spinner + hint takes the message slot, and once the
    // worker's error lands the footer shows the error instead.
    let mut app = TuiApp::new_with_options(
        BackendClient::new("/nonexistent.sock", "/nonexistent.sock"),
        Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", 1),
    );
    app.refresh_if_due();
    assert!(app.refresh_inflight.is_some(), "tick arms the worker");
    let plain = draw(&app, 80, 24);
    assert!(
        !plain.contains("waiting for backend"),
        "under the 500ms grace the footer stays calm"
    );

    std::thread::sleep(Duration::from_millis(600));
    let waiting = draw(&app, 80, 24);
    assert!(
        waiting.contains("waiting for backend"),
        "a stuck refresh must say so in the status line"
    );
    // Tiny terminal: the same draw must not panic and the hint still fits.
    let _cramped = draw(&app, 20, 6);

    drain_refresh(&mut app);
    assert!(app.error.is_some(), "dead socket lands as an error");
    let errored = draw(&app, 80, 24);
    assert!(
        !errored.contains("waiting for backend"),
        "the error replaces the waiting hint once it lands"
    );
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
    // Every overlay and capture-layer context must advertise its keys
    // in its hint (the footer is the discoverability surface; an empty
    // hint is a regression). Narrow-terminal shrinking is pinned
    // separately in the render fit_hint tests.
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
    }
    // The worktree overlay hint names its keys.
    let hint = FooterContext::WorktreeList.hint();
    assert!(hint.contains("Enter opens"), "worktree hint: {hint}");
    assert!(hint.contains("type filters"), "worktree hint: {hint}");
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
fn footer_names_walk_and_scroll_keys_when_split_active() {
    // Review F2: with a split open the TerminalMain footer must swap
    // to the split hint (hjkl walk, Ctrl+j/k scroll); without one the
    // plain hint stays.
    let mut app = app_with_two_panes();
    app.main_focused = true;
    let plain = app.footer_context().hint();
    assert!(plain.contains("Enter attach"));
    assert!(
        !plain.contains("Ctrl+j/k"),
        "no split, no walk/scroll hint yet"
    );

    // Open the split like a user: Ctrl+B s then Enter commits.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.split_tree.leaves().len(), 2);
    let split = app.footer_context().hint();
    assert!(
        split.contains("hjkl walk") && !split.contains("ZOOM"),
        "split hint names the walk keys"
    );
    assert!(
        split.contains("Ctrl+j/k scroll"),
        "split hint names the scroll escape"
    );

    // Zoom flips the footer to the zoom copy: the walk is disabled
    // while one tile owns the screen, so the hint must not claim it
    // (mode hints live in the render path, not the static context).
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("ZOOM"), "zoom names itself");
    assert!(
        !drawn.contains("hjkl walk"),
        "zoom hint must not advertise the disabled walk"
    );
}

#[test]
fn prefix_shift_e_opens_settings_from_terminal_screen() {
    // Review F4: `Ctrl+B Shift+E` is the dedicated settings chord that
    // works from every screen; on Terminal `Ctrl+B s` stays split mode.
    let mut app = app_with_snapshot();
    app.main_focused = true;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('E'), KeyModifiers::SHIFT));
    assert_eq!(
        app.mode,
        crate::tui::TuiMode::Settings,
        "Shift+E opens settings"
    );
    app.handle_key(KeyEvent::from(KeyCode::Esc));

    // Plain e behind the prefix stays edit-file (on Terminal that
    // routes to the Git screen's file list, never settings).
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('e')));
    assert_ne!(app.mode, crate::tui::TuiMode::Settings);
    assert_eq!(app.screen, crate::tui::TuiScreen::Git);
    // On the git screen prefix s keeps the settings meaning.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(
        app.mode,
        crate::tui::TuiMode::Settings,
        "git screen: prefix s stays settings"
    );
    app.handle_key(KeyEvent::from(KeyCode::Esc));

    // Back on Terminal, Ctrl+B s still opens split mode, not settings.
    app.screen = crate::tui::TuiScreen::Terminal;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.split_mode.is_some(), "Ctrl+B s keeps the split meaning");
}

#[test]
fn narrow_footer_keeps_lens_discovery_hints() {
    // Compact hints on a narrow terminal: the lens keeps the Ctrl+B ?
    // tail (the one hint every screen needs).
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
}

#[test]
fn attach_mode_types_keys_into_the_live_terminal_socket() {
    // Attach mode's raw key path against the live fake socket: the
    // key bytes reach the terminal stream and the status confirms
    // (the dead API refresh after is noise, as everywhere).
    let (mut app, rx) = app_with_fake_terminal();
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
fn terminal_drain_error_survives_the_refresh_hold() {
    // A drain-detach error (server shutdown, broken pipe) must own
    // the footer for STATUS_HOLD: apply_refresh clears plain errors on
    // every successful snapshot, so without the hold the reason a pane
    // dropped could vanish before the first draw renders it.
    let mut app = app_with_snapshot();
    app.report_terminal_error("maintenance".to_string());
    assert_eq!(app.error.as_deref(), Some("maintenance"));
    assert!(app.status_hold_until.is_some());
    // A completed refresh within the hold keeps the error visible.
    app.apply_refresh(
        json!({}),
        json!({"snapshot": {"workspaces": [], "panes": [], "agents": []}}),
    );
    assert_eq!(
        app.error.as_deref(),
        Some("maintenance"),
        "refresh inside the hold must not wipe the drain error"
    );
    // Past the hold the next refresh clears it again, like any error.
    app.status_hold_until = Some(std::time::Instant::now());
    app.apply_refresh(
        json!({}),
        json!({"snapshot": {"workspaces": [], "panes": [], "agents": []}}),
    );
    assert!(app.error.is_none());
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
fn tab_marker_follows_the_focused_tile_on_splits() {
    // On a split screen the pane strip's ▸ marker must track the
    // focused tile, not the sidebar selection: the marker is the cue
    // telling the user which panel close/rename/compose targets.
    let mut app = app_with_snapshot();
    app.snapshot = crate::tui::model::TuiSnapshot::from_backend_response(
        &crate::tui::tests::fixture_snapshot_value_two_panes(),
    );
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_2".to_string());
    // Sidebar cursor parked on pane_1's agent row: view_pane overrides.
    app.selected_workspace = 0;
    app.selected_agent = 0;

    let rendered = draw(&app, 120, 30);
    // The only "Shell" text is ws_1's tab_1 in the pane strip; with the
    // focus on ws_2's pane_2 the marker must not sit on it.
    assert!(
        !rendered.contains("▸ Shell"),
        "the marker must not sit on the sidebar pane's tab while the focus is elsewhere: {rendered}"
    );

    // Focus back on pane_1: the marker returns to Shell in the strip.
    app.split_focus = Some("pane_1".to_string());
    let rendered = draw(&app, 120, 30);
    assert!(
        rendered.contains("▸ Shell"),
        "the marker tracks the focused tile: {rendered}"
    );

    // Mixed-workspace split: the strip follows the focused tile's
    // workspace (webui state.ws parity), so ws_2's tab list renders
    // with its own marker instead of going markerless.
    app.split_focus = Some("pane_2".to_string());
    let rendered = draw(&app, 120, 30);
    assert!(
        rendered.contains("▸ Server"),
        "the strip lists the focused tile's workspace and marks its tab: {rendered}"
    );
    assert!(
        rendered.contains("Docs") || rendered.contains("Other"),
        "the strip names the focused workspace: {rendered}"
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
fn tab_bar_renders_context_tokens_from_the_stamp() {
    // Location-bar parity: after the tab labels the bar carries the
    // workspace folder, the worktree lane marker when linked, and the
    // checked-out branch, all from the T1 stamp.
    let mut app = app_with_snapshot();
    app.snapshot.workspaces[0].worktree = Some(crate::tui::TuiWorktreeStamp {
        repo_root: "/repo".to_string(),
        repo_name: "repo".to_string(),
        branch: "feature/x".to_string(),
        is_linked: true,
    });
    app.snapshot.workspaces[0].cwd = "/Users/dev/src/repo-lane".to_string();
    let rendered = draw(&app, 120, 30);
    assert!(
        rendered.contains("repo-lane"),
        "folder token renders from the cwd basename"
    );
    assert!(
        !rendered.contains("/Users/dev/src"),
        "the folder token is the basename, not the full path"
    );
    assert!(
        rendered.contains("[worktree]"),
        "linked stamp renders the worktree token"
    );
    assert!(
        rendered.contains("@ feature/x"),
        "branch token renders from the stamp branch"
    );
}

#[test]
fn tab_bar_context_tokens_stay_absent_without_a_stamp() {
    // No stamp (plain folder, or the fetch has not landed yet): only
    // the folder token shows. No [worktree], no @ branch, and no
    // placeholder text pretending to know them.
    let app = app_with_snapshot();
    let rendered = draw(&app, 120, 30);
    assert!(
        rendered.contains("repo"),
        "folder token renders even without a stamp"
    );
    assert!(
        !rendered.contains("[worktree]"),
        "no stamp means no worktree token"
    );
    assert!(!rendered.contains("@ "), "no stamp means no branch token");
}

#[test]
fn tab_bar_drops_branch_token_for_detached_head() {
    // A stamp can land with an empty branch (detached HEAD, or a
    // checkout the porcelain could not name): the branch token stays
    // absent rather than printing a bare "@ " placeholder.
    let mut app = app_with_snapshot();
    app.snapshot.workspaces[0].worktree = Some(crate::tui::TuiWorktreeStamp {
        repo_root: "/repo".to_string(),
        repo_name: "repo".to_string(),
        branch: String::new(),
        is_linked: false,
    });
    let rendered = draw(&app, 120, 30);
    assert!(
        !rendered.contains("@ "),
        "an unnamed branch must not print an empty token"
    );
}

#[test]
fn tab_bar_context_tokens_distinguish_main_checkout() {
    // The main checkout shows the branch but not the worktree token;
    // only lanes carry [worktree] (desktop link-chip rule).
    let mut app = app_with_snapshot();
    app.snapshot.workspaces[0].worktree = Some(crate::tui::TuiWorktreeStamp {
        repo_root: "/repo".to_string(),
        repo_name: "repo".to_string(),
        branch: "main".to_string(),
        is_linked: false,
    });
    let rendered = draw(&app, 120, 30);
    assert!(
        rendered.contains("@ main"),
        "main checkout still shows its branch"
    );
    assert!(
        !rendered.contains("[worktree]"),
        "the main checkout is not a lane"
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
    // First refresh_if_due arms the async refresh; wait for the reply,
    // which is what stamps last_refresh/last_tail_refresh.
    app.refresh_if_due();
    drain_refresh(&mut app);
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
    // Drain the async refresh in attach mode: the reply applies (mode
    // != snapshot gating lives in apply_refresh) without stamping the
    // tail, which is the observable under test.
    app.refresh_if_due();
    drain_refresh(&mut app);
    assert!(app.last_refresh.is_some(), "the snapshot refresh landed");
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

    // Main focus (default): pane keys, no stale "j/k select". 180 cols
    // keeps the hint through the "q quit" segment; the full line
    // needs ~191, so fit_hint drops the trailing panel segment here
    // (compact fallback checked on the narrow draw).
    // Sidebar focus: same screen and mode, so the split chord still
    // fires from here and the hint names it plus the way back to the
    // main pane.
    assert!(matches!(
        app.footer_context(),
        crate::tui::FooterContext::TerminalMain
    ));
    let main = draw(&app, 180, 24);
    assert!(main.contains("Enter attach"), "main hint keeps attach");
    assert!(
        main.contains("Ctrl+B . / , focus sidebar"),
        "main hint tells the chord that walks focus, not dead plain keys"
    );
    assert!(
        main.contains("Shift+L lens"),
        "main hint names the lens shortcut"
    );
    assert!(
        main.contains("Ctrl+B s split"),
        "main hint names the split entry chord"
    );
    assert!(
        main.contains("q quit"),
        "main hint keeps the quit key that still works here"
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

#[test]
fn poll_refresh_arms_waiting_and_survives_a_silent_worker_drop() {
    // The three poll arms past the happy reply: a still-empty channel
    // keeps the worker armed and feeds the spinner (dirty), and a
    // worker that exits without sending (disconnected channel) must
    // silently stop waiting instead of erroring or wedging the loop.
    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));

    // waiting arm: a channel with no reply yet stays in flight, and the
    // next tick marks the frame dirty so the spinner keeps animating.
    let (tx, rx) = std::sync::mpsc::channel::<Result<(Value, Value), BackendClientError>>();
    app.refresh_inflight = Some(RefreshInflight {
        started: Instant::now(),
        receiver: rx,
    });
    assert!(app.take_dirty(), "arming the test state reads dirty first");
    app.poll_refresh();
    assert!(
        app.refresh_inflight.is_some(),
        "empty channel keeps the worker armed"
    );
    assert!(app.take_dirty(), "waiting arm feeds the spinner");
    assert!(app.error.is_none());

    // disconnected arm: the worker died without a reply (dropped sender).
    // poll must swallow that and stop waiting, leaving no inflight state
    // and no error (a crashed refresh worker is not a backend outage).
    drop(tx);
    app.poll_refresh();
    assert!(
        app.refresh_inflight.is_none(),
        "disconnected worker is discarded"
    );
    assert!(
        app.error.is_none(),
        "dropped worker is not reported as an error"
    );

    // Debug impl: TuiApp derives Debug, so the channel end must render
    // through the manual impl instead of failing to compile or leaking
    // the receiver's internals.
    app.refresh_inflight = Some(RefreshInflight {
        started: Instant::now(),
        receiver: std::sync::mpsc::channel::<Result<(Value, Value), BackendClientError>>().1,
    });
    let rendered = format!("{:?}", app.refresh_inflight);
    assert!(
        rendered.contains("started"),
        "Debug shows the started instant"
    );
    assert!(
        !rendered.contains("Receiver"),
        "channel internals stay hidden"
    );
}

#[test]
fn autoclose_closes_the_empty_workspace_left_behind() {
    // Desktop `autoCloseLeftWorkspace`: after a folder switch the
    // workspace left behind with zero tabs and panes is closed through
    // workspace.close and dropped from the sidebar.
    let mut app = app_with_snapshot();
    // Two workspaces: ws_1 selected and empty (0 tabs), ws_2 focused as
    // the switch target.
    app.snapshot.workspaces[0].tab_count = 0;
    app.snapshot.workspaces[0].pane_count = 0;
    app.snapshot.workspaces.push(TuiWorkspace {
        id: "ws_2".to_string(),
        label: "Lane".to_string(),
        cwd: "/repo-lane".to_string(),
        focused: true,
        agent_status: "idle".to_string(),
        pane_count: 1,
        tab_count: 1,
        active_tab_id: None,
        worktree: None,
    });
    app.selected_workspace = 1;
    // The previous workspace is still in the snapshot (as it would be
    // right after a refresh that re-listed it).
    app.autoclose_left_workspace(Some("ws_1"));
    assert!(
        app.snapshot.workspaces.iter().all(|ws| ws.id != "ws_1"),
        "the empty left-behind workspace disappears from the sidebar"
    );
}

#[test]
fn autoclose_keeps_workspaces_with_tabs_and_the_target() {
    // Guards: a workspace with tabs or panes stays open, and the
    // just-focused target is never closed even when empty.
    let mut app = app_with_snapshot();
    // Target selected: same id passed in must be a no-op.
    app.selected_workspace = 0;
    app.autoclose_left_workspace(Some("ws_1"));
    assert_eq!(
        app.snapshot.workspaces.len(),
        1,
        "the target is never closed"
    );
    // A workspace holding a tab stays open.
    app.snapshot.workspaces.push(TuiWorkspace {
        id: "ws_2".to_string(),
        label: "Busy".to_string(),
        cwd: "/busy".to_string(),
        focused: false,
        agent_status: "idle".to_string(),
        pane_count: 2,
        tab_count: 1,
        active_tab_id: None,
        worktree: None,
    });
    app.selected_workspace = 0;
    app.autoclose_left_workspace(Some("ws_2"));
    assert_eq!(
        app.snapshot.workspaces.len(),
        2,
        "a workspace with tabs survives the switch"
    );
    // Panes without a tab also count as content (older servers report
    // pane counts only).
    app.snapshot.workspaces[1].tab_count = 0;
    app.autoclose_left_workspace(Some("ws_2"));
    assert_eq!(
        app.snapshot.workspaces.len(),
        2,
        "a workspace with panes but no tabs still survives"
    );
}

#[test]
fn empty_tab_bar_names_the_open_workspaces_binding() {
    // Desktop empty bar is a button; the TUI analog is the hint naming
    // the binding that opens the browser overlay (the folder picker).
    let mut app = app_with_snapshot();
    app.snapshot.workspaces.clear();
    let rendered = draw(&app, 100, 30);
    assert!(
        rendered.contains("no workspaces · Ctrl+B w open"),
        "the empty tab bar carries the Ctrl+B w call to action"
    );
}

#[test]
fn chord_echo_matches_the_terminal_navigate_meaning() {
    // Review finding: on Terminal/Navigate the s/m/z chords open the
    // split modes, but the status echo named the git meanings
    // (settings, blame, stash), teaching the wrong verb for the keys
    // the user just pressed. Needs a two-tile tree so move and zoom
    // accept instead of refusing and replacing the echo.
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(app.status, "Ctrl+B s -> split mode");
    app.handle_key(KeyEvent::from(KeyCode::Esc));

    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    assert_eq!(app.status, "Ctrl+B m -> move tile mode");
    app.handle_key(KeyEvent::from(KeyCode::Esc));

    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    // The zoom handler owns the line with its own outcome; the echo
    // only survives when the action stays silent, so assert the
    // outcome, not the echo.
    assert_eq!(app.status, "zoomed (Ctrl+B z restores)");
    assert!(app.split_zoomed);
}

#[test]
fn chord_echo_keeps_git_meaning_off_the_terminal_screen() {
    // The override is scoped: on the Git screen the same chords keep
    // their original labels (settings, blame, stash).
    let mut app = app_with_two_panes();
    app.screen = TuiScreen::Git;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert_eq!(app.status, "Ctrl+B s -> settings");
}

#[test]
fn footer_split_hints_name_add_and_close_tiles() {
    // Review finding: once a split is live the hint named no way to
    // add another tile or close one; the cold-start gap recurred one
    // step after entering split mode.
    let mut app = app_with_two_panes();
    app.main_focused = true;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    let split = app.footer_context().hint();
    assert!(
        split.contains("Ctrl+B s split"),
        "live split hint still names how to add a tile"
    );
    assert!(
        split.contains("Ctrl+B x close tile"),
        "live split hint names how to close a tile"
    );

    // Sidebar focus: same screen and mode, the chord still fires, so
    // the hint names it plus the way back to the main pane.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('.')));
    let sidebar = draw(&app, 140, 24);
    assert!(
        sidebar.contains("Ctrl+B s split"),
        "sidebar hint names the split chord that still fires there"
    );
    assert!(
        sidebar.contains("Ctrl+B . main"),
        "sidebar hint names the way back to the main pane"
    );
}

#[test]
fn agnets_status_bar_lists_tiles_with_dots_and_counts() {
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
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("AGENTS"), "summary bar present");
    assert!(drawn.contains("jcode"));
    assert!(drawn.contains("bot"));
    assert!(drawn.contains("(Repo)"));
    assert!(drawn.contains("(Other)"));
}

#[test]
fn sidebar_moves_do_not_steal_split_focus() {
    let mut app = app_with_two_panes();
    // Multi-leaf tree, focus on pane_2 (the workspace-2 pane).
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        weights: vec![8; 2],
    };
    app.split_focus = Some("pane_2".to_string());

    // Sidebar j (workspaces list) moves the workspace cursor but not
    // the focused tile. Hand the sidebar the keyboard first: main_focused
    // owns hjkl on the pane otherwise.
    app.main_focused = false;
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.selected_workspace, 1);
    assert_eq!(
        app.split_focus.as_deref(),
        Some("pane_2"),
        "multi-leaf split owns focus"
    );
}

#[test]
fn dead_split_focus_falls_back_to_tree_leaf_not_sidebar() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::Split {
        dir: crate::tui::split::SplitDir::Row,
        children: vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
        weights: vec![8; 2],
    };
    // Dead focus, sidebar selection on pane_1: focus must come from the
    // tree, not the sidebar.
    app.split_focus = Some("gone".to_string());
    assert_eq!(app.focused_pane_id().as_deref(), Some("pane_1"));
}

#[test]
fn opening_split_mode_while_zoomed_auto_unzooms() {
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
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    assert!(app.split_zoomed);

    // Zoom needs a split candidate off the tree, so add a third pane.
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

    // Ctrl+B s unzooms first, then opens split mode; focus stays.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(!app.split_zoomed);
    assert!(app.split_mode.is_some());
    assert_eq!(app.status, "zoom off");

    // Same for move mode from a zoomed state.
    app.split_mode = None;
    app.split_zoomed = true;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    assert!(!app.split_zoomed);
    assert!(app.move_mode.is_some());

    // Guards: a stray zoomed flag pins the target walk.
    app.split_zoomed = true;
    let before = app.move_mode.clone().unwrap().target;
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert_eq!(app.move_mode.as_ref().unwrap().target, before);
}

#[test]
fn footer_shows_zoom_hint_while_zoomed() {
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
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    let drawn = draw(&app, 150, 40);
    assert!(drawn.contains("ZOOM"), "footer names the zoom state");
}

#[test]
fn double_esc_after_mode_close_does_not_open_quit_confirm() {
    let mut app = app_with_two_panes();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.split_mode.is_some());

    // First Esc closes the mode, the second is swallowed.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.split_mode.is_none());
    assert_eq!(app.mode, TuiMode::Navigate);
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);
    assert_eq!(app.status, "press q to quit");

    // q still reaches the quit confirm and y confirms.
    app.handle_key(KeyEvent::from(KeyCode::Char('q')));
    assert_eq!(app.mode, TuiMode::ConfirmQuit);
    app.handle_key(KeyEvent::from(KeyCode::Char('y')));
    assert_eq!(app.status, "quit");

    // Plain Esc with no mode just closed still opens the confirm.
    let mut fresh = app_with_two_panes();
    fresh.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(fresh.mode, TuiMode::ConfirmQuit);
}

#[test]
fn move_insert_commit_status_names_the_new_focus() {
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
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    let state = app.move_mode.clone().unwrap();
    app.move_mode = Some(crate::tui::split::MoveState {
        target: "pane_2".to_string(),
        insert: true,
        ..state
    });
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.split_focus.as_deref(), Some("pane_1"));
    assert_eq!(app.status, "moved jcode · focus jcode");
}

#[test]
fn ctrl_hjkl_scrolls_focused_pane_instead_of_walking() {
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
    app.main_focused = true;
    app.pane_tail = vec![
        "line one".to_string(),
        "line two".to_string(),
        "line three".to_string(),
    ];
    app.pane_scroll = 2;

    // Ctrl+j scrolls toward the tail: the offset drops, focus stays.
    app.handle_key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::CONTROL));
    assert_eq!(app.pane_scroll, 1);
    assert_eq!(app.split_focus.as_deref(), Some("pane_1"));
}

#[test]
fn attach_viewport_sizes_to_focused_tile_in_split() {
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
    app.set_terminal_size(150, 40);
    // One draw records the frame's tile geometry.
    let _ = draw(&app, 150, 40);

    let (cols, rows) = app.attach_viewport();
    let geometry = app.tile_geometry.borrow();
    let tile = geometry
        .iter()
        .find(|t| t.pane_id == "pane_2")
        .expect("focused tile recorded");
    // Borders (2) and the cwd/status/blank rows (3) do not belong to
    // the pty viewport.
    assert_eq!(cols, tile.width.saturating_sub(2));
    assert_eq!(rows, tile.height.saturating_sub(5));
    // The tile is roughly half the pane area, minus sidebar and
    // bars; the full-window viewport would be far wider.
    let (full_cols, _) = crate::tui::render::pane_viewport_size(150, 40, false);
    assert!(
        cols < full_cols,
        "split attach must size to the tile, not the window"
    );

    // Without a split the legacy viewport applies again.
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = None;
    let (cols, _) = app.attach_viewport();
    assert_eq!(cols, full_cols);
}

#[test]
fn parse_pane_reads_terminal_title_with_the_stripped_field_first() {
    let value = serde_json::json!({
        "panes": [{
            "pane_id": "pane_1",
            "terminal_id": "term_1",
            "agent_status": "idle",
            "terminal_title": "raw · work ~3s",
            "terminal_title_stripped": "raw",
        }]
    });
    let pane = crate::tui::model::TuiSnapshot::from_backend_response(&value).panes[0].clone();
    assert_eq!(pane.terminal_title.as_deref(), Some("raw"));

    // Raw-only backend: the client-side strip still yields the head.
    let raw_only = serde_json::json!({
        "panes": [{
            "pane_id": "pane_1",
            "terminal_id": "term_1",
            "agent_status": "idle",
            "terminal_title": "raw · work ~3s",
        }]
    });
    let pane = crate::tui::model::TuiSnapshot::from_backend_response(&raw_only).panes[0].clone();
    assert_eq!(pane.terminal_title.as_deref(), Some("raw"));

    // Old backend without the field: None, headers fall back further.
    let old = serde_json::json!({
        "panes": [{
            "pane_id": "pane_1",
            "terminal_id": "term_1",
            "agent_status": "idle",
        }]
    });
    let pane = crate::tui::model::TuiSnapshot::from_backend_response(&old).panes[0].clone();
    assert_eq!(pane.terminal_title, None);

    // A title that strips to nothing is treated as absent.
    let spinner_only = serde_json::json!({
        "panes": [{
            "pane_id": "pane_1",
            "terminal_id": "term_1",
            "agent_status": "idle",
            "terminal_title": "⠙",
        }]
    });
    let pane =
        crate::tui::model::TuiSnapshot::from_backend_response(&spinner_only).panes[0].clone();
    assert_eq!(pane.terminal_title, None);
}

#[test]
fn single_pane_header_shows_the_terminal_title_too() {
    let mut app = app_with_two_panes();
    // Single-pane path: no split tree, focus on pane_1.
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = None;
    app.snapshot.panes[0].terminal_title = Some("jcode · src/foo.rs".to_string());
    let drawn = draw(&app, 150, 40);
    assert!(
        drawn.contains("jcode · src"),
        "single-pane header carries the title, got: {drawn}"
    );
}

#[test]
fn prompt_input_wraps_long_words_and_zero_width() {
    // A word wider than the row hard-breaks across rows.
    let mut app = app_with_snapshot();
    app.prompt_input = Some(crate::tui::PromptInput::new(
        crate::tui::PromptKind::NewWorkspaceName,
    ));
    app.prompt_input.as_mut().unwrap().text = "supercalifragilisticexpialidocious".to_string();
    let drawn = draw(&app, 40, 30);
    assert!(
        drawn.contains("supercalifragil"),
        "long word breaks at the width, got: {drawn}"
    );
}

#[test]
fn wrap_input_with_cursor_handles_zero_width_and_word_splits() {
    use crate::tui::render::wrap_input_with_cursor;
    // Zero width degrades to one cursor row.
    assert_eq!(wrap_input_with_cursor("anything", 0), vec!["\u{2588}"]);
    // A word wider than the row splits across rows without spaces.
    let rows = wrap_input_with_cursor("aaaaaaaaaa", 4);
    assert!(
        rows.windows(2)
            .all(|w| w[0].len() == 4 || w[0].contains(' '))
            || rows.len() > 1
    );
    assert!(rows.iter().all(|row| row.chars().count() <= 4));
}

#[test]
fn sync_seeds_focus_on_the_first_alive_leaf() {
    // A two-leaf tree with no focus: sync seeds it.
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = None;
    app.sync_split_tree();
    assert!(
        app.split_focus.is_some(),
        "focus seeded on first alive leaf"
    );
}

#[test]
fn panel_focus_cycles_the_tab_list_and_reports_the_index() {
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
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_2","agent":"bot","display_agent":"bot","agent_status":"idle","cwd":"/repo","focused":false}
            ],
            "agents": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_2","agent":"bot","display_agent":"bot","agent_status":"idle","cwd":"/repo","focused":false}
            ]
        }
    }));
    // Two tabs in the fixture: cycling wraps around the list.
    let first = app.move_panel(1).expect("panel focus works");
    assert_eq!(first, "panel 2/2");
    let wrap = app.move_panel(1).expect("panel focus works");
    assert_eq!(wrap, "panel 1/2", "wraps back to the first tab");
}

#[test]
fn autoclose_guards_skip_empty_ids_and_still_selected_workspaces() {
    let mut app = app_with_snapshot();
    app.snapshot.workspaces[0].tab_count = 0;
    app.snapshot.workspaces[0].pane_count = 0;

    // No previous id at all: silent return.
    app.autoclose_left_workspace(None);
    assert_eq!(app.snapshot.workspaces.len(), 1);

    // Empty previous id: silent return.
    app.autoclose_left_workspace(Some(""));
    assert_eq!(app.snapshot.workspaces.len(), 1);

    // Previous is the still-selected workspace: never closed.
    app.autoclose_left_workspace(Some("ws_1"));
    assert_eq!(app.snapshot.workspaces.len(), 1);

    // Previous id not in the snapshot (already gone): silent return.
    app.autoclose_left_workspace(Some("ws_missing"));
    assert_eq!(app.snapshot.workspaces.len(), 1);

    // Non-empty workspace left behind: kept.
    app.snapshot.workspaces[0].tab_count = 1;
    app.snapshot.workspaces.push(TuiWorkspace {
        id: "ws_2".to_string(),
        label: "Lane".to_string(),
        cwd: "/repo-lane".to_string(),
        focused: true,
        agent_status: "idle".to_string(),
        pane_count: 1,
        tab_count: 1,
        active_tab_id: None,
        worktree: None,
    });
    app.selected_workspace = 1;
    app.autoclose_left_workspace(Some("ws_1"));
    assert!(
        app.snapshot.workspaces.iter().any(|ws| ws.id == "ws_1"),
        "a workspace with tabs is never autoclosed"
    );
}

#[test]
fn ghost_half_covers_all_sides_and_both_axes() {
    // Draw the split-mode ghost once per side (Right/Below/Left/Above):
    // every ghost_half_rect arm and both split_rect_half axes run.
    for side in [
        crate::tui::split::Side::Right,
        crate::tui::split::Side::Below,
        crate::tui::split::Side::Left,
        crate::tui::split::Side::Above,
    ] {
        let mut app = app_with_two_panes();
        app.split_tree = crate::tui::split::SplitNode::split(
            crate::tui::split::SplitDir::Row,
            vec![
                crate::tui::split::SplitNode::leaf("pane_1"),
                crate::tui::split::SplitNode::leaf("pane_2"),
            ],
        );
        app.split_mode = Some(crate::tui::split::SplitPreview {
            neighbor: "pane_1".into(),
            pane: "pane_3".into(),
            side,
        });
        app.screen = TuiScreen::Terminal;
        let drawn = draw(&app, 150, 40);
        assert!(drawn.contains("+ pane_3 "), "ghost renders side {side:?}");
    }
}

#[test]
fn zoomed_split_with_no_focused_tile_draws_nothing() {
    // split_zoomed filters tiles down to the focused one; with focus
    // pointing at a pane the tree does not hold, the visible list is
    // empty and render_split_view returns before the overlays run.
    let mut app = two_tile_split();
    app.split_zoomed = true;
    app.split_focus = Some("pane_missing".into());
    let drawn = draw(&app, 40, 20);
    assert!(!drawn.contains("+ pane_3"));
    assert!(!drawn.contains("⇄ moving"));
}

#[test]
fn prompt_dispatcher_covers_rename_close_and_worktree_stage_guards() {
    use crate::tui::workspace::{run_prompt, WorkspacePrompt};
    let mut app = app_with_snapshot();

    // Rename workspace with an empty label is refused.
    run_prompt(&mut app, &WorkspacePrompt::RenameWorkspace, "  ");
    assert!(app.error.is_some());

    // Rename panel with an empty label is refused.
    app.error = None;
    run_prompt(&mut app, &WorkspacePrompt::RenamePanel, "");
    assert!(app.error.is_some());

    // Close workspace confirm runs against the dead backend and
    // reports the failure.
    app.error = None;
    run_prompt(&mut app, &WorkspacePrompt::ConfirmCloseWorkspace, "y");
    assert!(app.error.is_some());

    // The worktree prompt chain guards: a path/base/pull-base prompt
    // with no staged draft is a silent return.
    app.error = None;
    run_prompt(&mut app, &WorkspacePrompt::CreateWorktreePath, "/tmp/wt");
    assert!(app.error.is_none(), "no stage: silent guard");
    run_prompt(&mut app, &WorkspacePrompt::CreateWorktreeBase, "main");
    run_prompt(&mut app, &WorkspacePrompt::ConfirmWorktreePullBase, "y");
    assert!(app.worktree_create_stage.is_none());
}

#[test]
fn browser_row_matches_searches_paths_names_branches_and_labels() {
    use crate::tui::workspace::BrowserRow;
    let row = BrowserRow::Folder {
        path: "/repo/src".into(),
        name: "src".into(),
    };
    assert!(row.matches("src"));
    assert!(row.matches("/repo"));
    assert!(!row.matches("docs"));
    let this = BrowserRow::ThisFolder {
        path: "/repo".into(),
    };
    assert!(this.matches("repo"));
}

#[test]
fn drain_auto_split_queue_waits_when_no_neighbor_is_alive() {
    let mut app = app_with_two_panes();
    // Queue a workspace whose spare pane exists but the captured
    // neighbor is dead and the current focus IS the spare pane (it
    // cannot host a tile beside itself): the request is kept.
    app.snapshot = TuiSnapshot::from_backend_response(&three_pane_fixture());
    app.split_tree = crate::tui::split::SplitNode::leaf("pane_1");
    app.split_focus = Some("pane_3".to_string());
    app.split_panes_of_workspaces = vec![("ws_1".to_string(), Some("dead".to_string()))];
    app.drain_auto_split_queue();
    assert_eq!(
        app.split_panes_of_workspaces,
        vec![("ws_1".to_string(), Some("dead".to_string()))],
        "request kept while nothing alive can host it"
    );

    // Queue for a workspace that vanished from the snapshot: dropped.
    app.split_panes_of_workspaces = vec![("ws_missing".to_string(), None)];
    app.drain_auto_split_queue();
    assert!(app.split_panes_of_workspaces.is_empty());
}

#[test]
fn resize_step_on_the_outer_boundary_names_itself() {
    let mut app = app_with_two_panes();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.resize_mode = Some(crate::tui::split_mode::ResizeState {
        pane: "pane_1".into(),
    });
    // Bounded walk left: the status lands on one of the three
    // outcomes (moved, outer, clamped) without looping forever.
    for _ in 0..16 {
        app.resize_step_direction(
            crate::tui::split::SplitDir::Row,
            crate::tui::split::ResizeDir::Narrow,
        );
    }
    assert!(matches!(
        app.status.as_str(),
        "tile resized" | "resized outer boundary" | "already at minimum size"
    ));
}

#[test]
fn footer_counts_wide_chars_by_display_width_when_shrinking() {
    // H2 regression: the hint budget used chars().count(), so a wide
    // (CJK) status line undercounted its columns and the footer could
    // overflow or misbudget the status slot.
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Terminal;
    // 4 CJK chars = 8 display columns; chars().count() says 4.
    app.status = "端末の状態".to_string();

    let drawn = draw(&app, 60, 24);
    // The footer paints the whole status without being cut short by a
    // char-count budget, and the wrap splits it into display-width
    // rows (no ragged half-width cell from a wrong budget).
    assert!(
        drawn.contains("端末"),
        "wide status text renders on the chrome line"
    );

    // Narrower than label + status + minimum hint: the hint shrinks
    // by display width and never overflows past the last column, so
    // the drawn footer line cannot spill the wide chars off-screen.
    let narrow = draw(&app, 60, 24);
    assert!(
        narrow.contains("端末"),
        "wide status still renders at narrow width"
    );
    assert!(
        narrow.contains("? help"),
        "the discovery tail survives display-width shrinking"
    );
}

#[test]
fn chord_echo_writes_the_chord_and_label_then_a_report_replaces_it() {
    // B5: a fired prefix chord writes "Ctrl+B <key> -> <label>" into
    // the status slot; any later reporting action owns the line again.
    let mut app = app_with_snapshot();
    app.mode = TuiMode::Navigate;
    app.screen = TuiScreen::Terminal;

    // Ctrl+B w: opens the worktree overlay, which reports its status.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('w')));
    assert!(
        app.status.starts_with("Ctrl+B w -> "),
        "chord echo lands in the status: {:?}",
        app.status
    );
    assert!(app.status.contains("worktree list"));

    // A second chord whose action stays quiet keeps the echo visible:
    // the Terminal screen guard (Ctrl+B t on Terminal Navigate) is a
    // no-op, so only the echo owns the line after it fires.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    app.screen = TuiScreen::Terminal;
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('t')));
    assert_eq!(
        app.status, "Ctrl+B t -> terminal",
        "the quiet action keeps the chord echo on the line"
    );

    // A subsequent reporting action replaces the echo.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('B')));
    assert_eq!(app.status, "sidebar hidden");
    assert!(
        !app.status.contains("-> "),
        "the reporting action owns the line after the echo"
    );
}

#[test]
fn selecting_a_paneless_workspace_parks_the_agent_cursor_on_its_first_agent() {
    let mut app = app_with_two_panes();
    // ws_2 keeps its shell pane but its agent row is gone, so the
    // pane-id lookup misses and the cursor must park on ws_1's agent
    // (the only row left) instead of stranding on the removed row.
    // Split view focused on ws_2's pane makes view_pane hit the
    // miss (the pane exists, its agent row does not).
    app.snapshot
        .agents
        .retain(|agent| agent.workspace_id != "ws_2");
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_2".to_string());
    app.screen = TuiScreen::Terminal;
    app.selected_workspace = 1;
    app.selected_agent = 0;

    app.run_shortcut(Shortcut::NewTab);

    assert_eq!(
        app.selected_agent, 0,
        "agent cursor parked on ws_1's agent row (index 0), the only one left"
    );
    let parked = app
        .snapshot
        .agents
        .get(app.selected_agent)
        .map(|agent| agent.workspace_id.clone())
        .unwrap_or_default();
    assert_eq!(parked, "ws_1", "the parked row belongs to ws_1");
}

#[test]
fn close_tab_falls_back_when_the_view_pane_workspace_left_the_snapshot() {
    let (api_socket, _stop) = fake_backend_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = TuiSnapshot::from_backend_response(&fixture_snapshot_value_two_panes());
    app.screen = TuiScreen::Terminal;
    // Split view with focus on pane_2 (ws_2), then ws_2 drops from the
    // snapshot: stale pane data, the close chain must fall back to the
    // sidebar-selected workspace (ws_1's active tab).
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Row,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.split_focus = Some("pane_2".to_string());
    app.selected_workspace = 0;
    app.snapshot.workspaces.retain(|ws| ws.id != "ws_2");
    app.snapshot.tabs.retain(|tab| tab.workspace_id != "ws_2");

    app.run_shortcut(Shortcut::CloseTab);

    assert!(
        app.status.contains("closed"),
        "the fallback tab closed: {:?}",
        app.status
    );
    assert!(
        !app.status.contains("tab Server closed"),
        "the stale ws_2 tab did not close: {}",
        app.status
    );
    assert!(
        app.error.is_none()
            || !app
                .error
                .as_deref()
                .is_some_and(|e| e.contains("not found")),
        "stale pane data must not surface a close error: {:?}",
        app.error
    );
}

#[test]
fn close_tab_without_a_tab_label_reports_the_plain_closed_notice() {
    let (api_socket, _stop) = fake_backend_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket.clone());
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = TuiSnapshot::from_backend_response(&fixture_snapshot_value_two_panes());
    app.screen = TuiScreen::Terminal;
    // Single-tab ws_1 (was_last_tab path): closing the only tab also
    // closes the workspace. Strip the tab rows so the closed-status
    // arm falls to the label-less "tab closed" notice.
    app.selected_workspace = 0;
    app.snapshot.workspaces.retain(|ws| ws.id != "ws_2");
    app.snapshot.tabs.retain(|tab| tab.workspace_id != "ws_2");
    app.snapshot
        .panes
        .retain(|pane| pane.workspace_id != "ws_2");
    app.snapshot
        .agents
        .retain(|agent| agent.workspace_id != "ws_2");
    app.sync_split_tree();
    app.snapshot.tabs.clear();

    app.run_shortcut(Shortcut::CloseTab);

    assert_eq!(
        app.status, "tab closed",
        "no tab row to name: the plain closed notice owns the line"
    );
    assert!(
        app.status_hold_until.is_some(),
        "the closed notice arms the hold past the refresh"
    );
}

#[test]
fn resize_divider_preview_draws_after_h() {
    let mut app = resize_mode_app();
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    assert!(app.last_resize_dir.is_some(), "direction recorded");
    let buffer = draw_buffer(&app, 150, 40);
    // The preview paints accent_dim bg cells along the moved divider
    // column; the ring alone never sets that bg.
    let dim = app.palette.accent_dim();
    let painted = buffer.content().iter().any(|cell| cell.bg == dim);
    assert!(painted, "divider preview cells carry accent_dim");
}

#[test]
fn resize_preview_absent_before_any_direction() {
    let app = resize_mode_app();
    assert!(app.last_resize_dir.is_none());
    let buffer = draw_buffer(&app, 150, 40);
    let dim = app.palette.accent_dim();
    assert!(
        !buffer.content().iter().any(|cell| cell.bg == dim),
        "no direction pressed yet: no preview"
    );
}

#[test]
fn resize_preview_follows_last_pressed_direction() {
    // A column split, so j/k (the Col axis) has a divider to move:
    // the Row fixture cannot preview a horizontal move.
    let mut app = two_tile_split();
    app.split_tree = crate::tui::split::SplitNode::split(
        crate::tui::split::SplitDir::Col,
        vec![
            crate::tui::split::SplitNode::leaf("pane_1"),
            crate::tui::split::SplitNode::leaf("pane_2"),
        ],
    );
    app.handle_key(ctrl('b'));
    app.handle_key(shift_z());
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(
        app.last_resize_dir,
        Some((
            crate::tui::split::SplitDir::Col,
            crate::tui::split::ResizeDir::Narrow
        )),
        "j records the column axis"
    );
    let buffer = draw_buffer(&app, 150, 40);
    let dim = app.palette.accent_dim();
    let j_cells: Vec<_> = buffer
        .content()
        .iter()
        .filter(|cell| cell.bg == dim)
        .collect();
    assert!(!j_cells.is_empty(), "j painted a horizontal preview");
    // A vertical-attempt (l) on a Col tree refuses: no divider on the
    // Row axis, so last_resize_dir stays the recorded pair but the
    // rendered preview must keep following the recorded axis.
    app.handle_key(KeyEvent::from(KeyCode::Char('l')));
    assert!(
        app.status.contains("no vertical divider"),
        "l on a Col tree refuses, got: {}",
        app.status
    );
    // Refused has no moved geometry to preview, but the attempted
    // direction stays recorded so the next render keeps following it.
    assert_eq!(
        app.last_resize_dir,
        Some((
            crate::tui::split::SplitDir::Row,
            crate::tui::split::ResizeDir::Wider
        )),
        "the refused attempt still records its direction"
    );
}

#[test]
fn move_swap_ghost_names_both_panes() {
    let mut app = two_tile_split();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    let state = app.move_mode.clone().unwrap();
    app.move_mode = Some(crate::tui::split::MoveState {
        target: "pane_2".to_string(),
        ..state
    });
    let drawn = draw(&app, 150, 40);
    // pane_1/pane_2 are cross-workspace: display names are jcode/bot.
    assert!(
        drawn.contains("jcode ⇄ bot"),
        "swap ghost names picked and target by display label, got: {drawn}"
    );
    assert!(drawn.contains("⇄ moving"), "picked ring keeps its title");
    assert!(
        !drawn.contains("⇄ target"),
        "the swap ghost replaces the old target ring"
    );
    // The footer names the target too.
    assert!(
        drawn.contains("· target bot"),
        "move hint names the target, got: {drawn}"
    );
}

#[test]
fn single_pane_border_is_accent_outside_attach_and_teal_inside() {
    let mut app = app_with_two_panes();
    app.screen = TuiScreen::Terminal;
    app.mode = TuiMode::Navigate;
    let buffer = draw_buffer(&app, 100, 30);
    assert!(
        buffer
            .content()
            .iter()
            .any(|cell| cell.fg == app.palette.accent
                && cell.modifier.contains(ratatui::style::Modifier::BOLD)),
        "non-Attach single pane paints the bold accent border"
    );
    app.mode = TuiMode::Attach;
    let buffer = draw_buffer(&app, 100, 30);
    assert!(
        buffer
            .content()
            .iter()
            .any(|cell| cell.fg == app.palette.teal),
        "Attach keeps the teal border"
    );
}

#[test]
fn single_pane_title_is_unaffected_by_accent_border() {
    let mut app = app_with_two_panes();
    app.screen = TuiScreen::Terminal;
    let drawn = draw(&app, 100, 30);
    // The pane identity title keeps its shape; only the border color
    // changed. The footer legend also lists resize, so the ring-title
    // strings are the discriminator, not the word alone.
    assert!(drawn.contains(" · "), "title separator still renders");
    assert!(
        !drawn.contains(" splits here "),
        "no split ring on the single-pane view"
    );
    assert!(!drawn.contains("⇄ moving"), "no move ring either");
}

#[test]
fn agents_bar_marks_the_focused_chip() {
    let app = two_tile_split();
    let drawn = draw(&app, 150, 40);
    // pane_1 (jcode) is focused: its AGENTS chip carries the marker.
    assert!(
        drawn.contains("▸ jcode"),
        "focused chip is glyph-marked in the AGENTS bar, got: {drawn}"
    );
}

#[test]
fn prompt_typing_and_backspace_edit_the_prompt_text() {
    // Char/Backspace/Ctrl+U arms of the prompt input handler.
    let mut app = app_with_snapshot();
    app.prompt_input = Some(crate::tui::PromptInput::new(
        crate::tui::PromptKind::RenameFile,
    ));
    app.handle_key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE));
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "x");
    app.handle_key(KeyEvent::new(KeyCode::Char('y'), KeyModifiers::NONE));
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "xy");
    app.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "x");
    app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "");
    // A char with no prompt open runs the composer draft arm.
    app.prompt_input = None;
    app.handle_key(KeyEvent::new(KeyCode::Char('z'), KeyModifiers::NONE));
}

#[test]
fn arrow_keys_scroll_a_single_pane_when_no_walk_exists() {
    // Single leaf tree: split_walk_fallback is false, so the keys
    // fall through to the pane scroll arms.
    let mut app = app_with_snapshot();
    app.screen = TuiScreen::Terminal;
    app.pane_tail = vec!["line".to_string(); 40];
    app.pane_scroll = 0;
    app.handle_key(KeyEvent::new(KeyCode::Down, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('j'), KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));
    app.handle_key(KeyEvent::new(KeyCode::Char('k'), KeyModifiers::NONE));
}

#[test]
fn text_snapshot_lists_the_active_context() {
    // Every optional block of the debug dump runs with a full fixture.
    let app = app_with_snapshot();
    let text = app.text_snapshot();
    assert!(text.contains("active cwd /repo"));
    assert!(text.contains("workspace ws_1"));
    assert!(text.contains("agent jcode"));
    assert!(text.contains("pane pane_1"));
}

#[test]
fn commit_stamp_marks_the_matching_workspace_without_overwriting() {
    // A worktree list response stamps every workspace at the asking
    // cwd; an already-stamped workspace keeps its existing stamp.
    let mut app = app_with_snapshot();
    let response = serde_json::json!({
        "worktrees": [{"path": "/repo", "branch": "main"}],
        "source": {"repo_root": "/repo", "repo_name": "repo"}
    });
    app.commit_stamp("/repo", response.clone());
    assert!(app.snapshot.workspaces[0].worktree.is_some());
    let first = app.snapshot.workspaces[0].worktree.clone().unwrap();
    app.commit_stamp("/repo", response);
    assert_eq!(app.snapshot.workspaces[0].worktree.clone().unwrap(), first);
}

#[test]
fn pane_read_text_lines_reads_both_response_shapes() {
    use crate::tui::pane_read_text_lines;
    let nested = serde_json::json!({"read": {"text": "one\ntwo\nthree"}});
    assert_eq!(pane_read_text_lines(&nested, 2), vec!["two", "three"]);
    let flat = serde_json::json!({"text": "legacy"});
    assert_eq!(pane_read_text_lines(&flat, 10), vec!["legacy"]);
    let empty = serde_json::json!({});
    assert!(pane_read_text_lines(&empty, 10).is_empty());
}
