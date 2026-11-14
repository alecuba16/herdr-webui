//! Onboarding tour tests: overlay open/close, step navigation, demo
//! dispatch through the real shortcut path, and the key-swallow guard
//! (a mid-tour key never reaches the app underneath).

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::json;

use crate::tui::render::render;
use crate::tui::tests::app_with_snapshot;
use crate::tui::{tour, TuiApp, TuiMode, TuiScreen, TuiSnapshot};

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

/// The shared fixture has one workspace and one agent; the tour demos
/// move the workspace and agent selection, so these tests need a
/// snapshot where that movement is observable.
fn tour_fixture_app() -> TuiApp {
    let mut app = app_with_snapshot();
    app.snapshot = TuiSnapshot::from_backend_response(&json!({
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"},
                {"workspace_id":"ws_2","label":"Web","cwd":"/web","focused":false,"agent_status":"working","pane_count":1,"tab_count":1,"active_tab_id":"tab_2"}
            ],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"},
                {"tab_id":"tab_2","workspace_id":"ws_2","label":"Server","focused":false,"pane_count":1,"agent_status":"working"}
            ],
            "panes": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true,"agent_session":{"kind":"jcode","resolvable":true,"session_id":"sess_1"}},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_2","tab_id":"tab_2","agent":"codex","display_agent":"codex","agent_status":"working","cwd":"/web","focused":false,"agent_session":{"kind":"codex","resolvable":true,"session_id":"sess_2"}}
            ],
            "agents": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_2","tab_id":"tab_2","agent":"codex","display_agent":"codex","agent_status":"working","cwd":"/web","focused":false}
            ]
        }
    }));
    app
}

fn open_tour_app() -> TuiApp {
    let mut app = tour_fixture_app();
    app.open_tour();
    app
}

fn draw(app: &TuiApp, width: u16, height: u16) -> String {
    let backend = TestBackend::new(width, height);
    let mut terminal = Terminal::new(backend).unwrap();
    terminal.draw(|frame| render(frame, app)).unwrap();
    format!("{:?}", terminal.backend().buffer())
}

#[test]
fn tour_opens_on_first_step_and_runs_the_search_demo() {
    let app = open_tour_app();
    assert_eq!(app.mode, TuiMode::Tour);
    assert_eq!(app.tour_index, 0);
    // The demo opened the palette through run_shortcut; the tour keeps
    // the mode and the palette renders below the card.
    assert_eq!(app.tour_demo_overlay, Some(TuiMode::SearchPalette));
    assert!(app.search_palette.query.is_empty());
    let step = tour::tour_steps()[0].clone();
    assert_eq!(step.title, "Search palette");
    assert_eq!(step.chord().as_deref(), Some("Ctrl+B /"));
    // Draw: the palette surface and the tour card are both on screen.
    let screen = draw(&app, 100, 30);
    assert!(screen.contains("Search"));
    assert!(screen.contains("Tour 1 /"));
}

#[test]
fn tour_walks_forward_and_back_with_the_demo_side_effects() {
    let mut app = open_tour_app();
    app.handle_key(key(KeyCode::Char('j')));
    assert_eq!(app.tour_index, 1);
    assert_eq!(app.screen, TuiScreen::Terminal);
    // Step 2 moved the workspace selection through run_shortcut, and
    // the step change dropped the step-1 palette render.
    assert_eq!(app.selected_workspace, 1);
    assert_eq!(app.tour_demo_overlay, None);
    // k walks back and re-runs the first demo.
    app.handle_key(key(KeyCode::Char('k')));
    assert_eq!(app.tour_index, 0);
    assert_eq!(app.tour_demo_overlay, Some(TuiMode::SearchPalette));
    assert!(!app.search_palette.committed);
    // Plain Enter also advances.
    app.handle_key(key(KeyCode::Enter));
    assert_eq!(app.tour_index, 1);
}

#[test]
fn tour_last_step_finishes_and_closes_the_overlay() {
    let mut app = open_tour_app();
    let last = tour::tour_steps().len() - 1;
    for _ in 0..last {
        app.handle_key(key(KeyCode::Char('j')));
    }
    assert_eq!(app.tour_index, last);
    // The final j finishes the tour instead of walking past the end.
    app.handle_key(key(KeyCode::Char('j')));
    assert!(app.tour_finished);
    assert_ne!(app.mode, TuiMode::Tour);
    assert_eq!(app.tour_demo_overlay, None);
}

#[test]
fn tour_keys_never_leak_into_the_app_underneath() {
    let mut app = open_tour_app();
    // Tab would normally toggle the sidebar focus; inside the tour it
    // must do nothing at all.
    let before_agent = app.selected_agent;
    app.handle_key(key(KeyCode::Tab));
    assert_eq!(app.mode, TuiMode::Tour, "Tab stayed inside the tour");
    assert_eq!(app.selected_agent, before_agent);
    // q would open the quit confirm from Navigate; inside the tour it
    // closes the tour only.
    app.handle_key(key(KeyCode::Char('q')));
    assert_ne!(app.mode, TuiMode::Tour);
    assert_ne!(app.mode, TuiMode::ConfirmQuit);
}

#[test]
fn tour_closes_with_esc_and_help_replays_it_with_shift_t() {
    let mut app = tour_fixture_app();
    app.open_help_overlay();
    assert_eq!(app.mode, TuiMode::Help);
    app.handle_key(KeyEvent::new(KeyCode::Char('T'), KeyModifiers::NONE));
    assert_eq!(app.mode, TuiMode::Tour);
    app.handle_key(key(KeyCode::Esc));
    assert_ne!(app.mode, TuiMode::Tour);
}

#[test]
fn tour_steps_cover_the_main_areas_in_the_webui_order() {
    let steps = tour::tour_steps();
    let titles: Vec<&str> = steps.iter().map(|s| s.title).collect();
    assert_eq!(
        titles,
        vec![
            "Search palette",
            "Workspaces",
            "Agents",
            "Main screen",
            "Terminal screen",
            "Sidebar collapse",
            "Help overlay",
            "The prefix language",
        ]
    );
    // Every step teaches a chord except the prefix explanation.
    assert!(steps.iter().filter(|s| s.shortcut.is_some()).count() >= 7);
}
