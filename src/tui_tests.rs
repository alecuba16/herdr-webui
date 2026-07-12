use super::*;
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
fn ctrl_b_toggles_menu_and_is_detectable_before_terminal_input() {
    let key = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    assert!(is_menu_key(key));

    let client = BackendClient::builtin_session(None);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.handle_key(key);
    assert_eq!(app.mode, TuiMode::Help);
    app.handle_key(key);
    assert_eq!(app.mode, TuiMode::Navigate);

    app.mode = TuiMode::Attach;
    app.handle_key(key);
    assert_eq!(app.mode, TuiMode::Help);
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
