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
    assert_eq!(app.mode, TuiMode::Help, "close returns to the Help overlay");
    app.handle_key(key(KeyCode::Esc));
    assert_eq!(
        app.mode,
        TuiMode::Navigate,
        "help close returns to Navigate"
    );
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
    let total = tour::tour_steps().len();
    assert_eq!(
        steps.iter().filter(|s| s.shortcut.is_some()).count(),
        total - 1
    );
}

#[test]
fn tour_swallows_the_prefix_and_lens_keys() {
    let mut app = open_tour_app();
    let before_index = app.tour_index;
    let before_workspace = app.selected_workspace;
    // Ctrl+B never arms inside the tour, so the next key is a plain tour
    // key, not a prefix chord.
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
    assert!(!app.prefix.is_armed());
    assert_eq!(app.mode, TuiMode::Tour);
    // Plain j after Ctrl+B advances the tour step; the selection moves
    // through the step's demo dispatch, never through a leaked chord.
    app.handle_key(key(KeyCode::Char('j')));
    assert_eq!(app.mode, TuiMode::Tour, "j stayed inside the tour");
    assert_eq!(app.tour_index, before_index + 1);
    assert_eq!(
        app.selected_workspace,
        before_workspace + 1,
        "demo moved it, not a leaked chord"
    );
    // Ctrl+B then ?: ? closes the tour, it never opens Help.
    let mut app = open_tour_app();
    app.handle_key(KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL));
    app.handle_key(key(KeyCode::Char('?')));
    assert_ne!(app.mode, TuiMode::Tour);
    assert_ne!(app.mode, TuiMode::Help, "prefix ? did not open Help");
    assert_eq!(app.tour_demo_overlay, None);
}

#[test]
fn tour_renders_on_a_tiny_terminal_without_panicking() {
    let app = open_tour_app();
    // 10x8: narrower than the card floor, shorter than the card height.
    let screen = draw(&app, 10, 8);
    assert!(screen.contains("Tour"));
    // A wide terminal still renders the full card.
    assert!(draw(&app, 100, 30).contains("Tour 1 / 8"));
}

#[test]
fn shortcut_key_hint_covers_every_hint_arm() {
    // The tour only renders chords for the shortcuts its steps teach,
    // so the hint table's other arms stay unexercised by the walk
    // tests. Drive the mapping directly: pinned hints plus the catch-all
    // for chords without a stable single key.
    use crate::tui::keys::Shortcut;
    let hint = tour::shortcut_key_hint;
    assert_eq!(hint(Shortcut::Help), "?");
    assert_eq!(hint(Shortcut::Files), "f");
    assert_eq!(hint(Shortcut::Git), "g");
    assert_eq!(hint(Shortcut::Terminal), "t");
    assert_eq!(hint(Shortcut::Search), "/");
    assert_eq!(hint(Shortcut::Refresh), "r");
    assert_eq!(hint(Shortcut::NextWorkspace), "j");
    assert_eq!(hint(Shortcut::PrevWorkspace), "k");
    assert_eq!(hint(Shortcut::NextAgent), "a");
    assert_eq!(hint(Shortcut::PrevAgent), "Shift+A");
    assert_eq!(hint(Shortcut::NewTab), "p");
    assert_eq!(hint(Shortcut::CloseTab), "x");
    assert_eq!(hint(Shortcut::Quit), "q");
    assert_eq!(hint(Shortcut::Settings), "Shift+E");
    assert_eq!(hint(Shortcut::SettingsOverlay), "Shift+E");
    assert_eq!(hint(Shortcut::Sidebar), "Shift+B");
    assert_eq!(hint(Shortcut::FocusNext), ".");
    assert_eq!(hint(Shortcut::FocusPrev), ",");
    assert_eq!(hint(Shortcut::Lens), "L");
    assert_eq!(hint(Shortcut::Composer), "C");
    assert_eq!(hint(Shortcut::SessionManager), "Shift+P");
    assert_eq!(hint(Shortcut::GitChanges), "1");
    assert_eq!(hint(Shortcut::GitLog), "3");
    assert_eq!(hint(Shortcut::GitBranch), "b");
    assert_eq!(hint(Shortcut::GitSwitchBranch), "v");
    assert_eq!(hint(Shortcut::NewWorkspace), "n");
    assert_eq!(hint(Shortcut::OpenWorktrees), "w");
    assert_eq!(hint(Shortcut::GitCommit), "see help");
    // chord() glues the prefix onto the hint.
    assert_eq!(
        tour::TourStep::chord_hint_for_test(Shortcut::GitPush).as_deref(),
        Some("Ctrl+B see help")
    );
}

#[test]
fn run_tour_demo_guards_off_the_step_table() {
    // Out-of-range index: the demo runner returns without touching the
    // app; same for a step whose demo flag is off or that carries no
    // shortcut. All three guards live behind the normal walk, so poke
    // them by driving the index directly.
    let mut app = open_tour_app();
    // The runner clears the previous demo surface before the guards,
    // so an out-of-range index still lands on a clean overlay.
    assert!(
        app.tour_demo_overlay.is_some(),
        "step 0 demo opened a palette"
    );
    app.tour_index = tour::tour_steps().len() + 5;
    app.run_tour_demo_for_test();
    assert_eq!(app.tour_demo_overlay, None, "no step: overlay cleared");

    // Help step (demo: false): runner returns before dispatch.
    let help_index = tour::tour_steps()
        .iter()
        .position(|s| s.title == "Help overlay")
        .unwrap();
    app.tour_index = help_index;
    app.run_tour_demo_for_test();
    assert_eq!(app.tour_demo_overlay, None, "non-demo step: no overlay");

    // Prefix step (shortcut: None, demo: false): shortcut guard.
    // Note: this step is the only shortcut:None step in the table and
    // also carries demo: false, so the !demo guard fires first; the
    // bare shortcut let-else needs a demo:true + shortcut:None step,
    // which the table never builds (every demo drives a real chord).
    let prefix_index = tour::tour_steps()
        .iter()
        .position(|s| s.title == "The prefix language")
        .unwrap();
    app.tour_index = prefix_index;
    app.run_tour_demo_for_test();
    assert_eq!(app.tour_demo_overlay, None, "no-shortcut step: no overlay");
}

#[test]
fn tour_render_covers_every_region_and_the_chordless_footer() {
    // Walk every step and render each: the region match arms (Main,
    // Sidebar, Agents, Footer) and the no-chord footer line all need a
    // live render to execute.
    let mut app = open_tour_app();
    let total = tour::tour_steps().len();
    for index in 0..total {
        app.tour_index = index;
        // Each step renders its region plus the card; the chordless
        // prefix step renders the "Ctrl+B arms the prefix" footer line.
        let screen = draw(&app, 120, 40);
        assert!(screen.contains("Tour"), "step {index} renders the card");
    }
    // The last step has no chord: its footer line explains the prefix.
    app.tour_index = total - 1;
    let screen = draw(&app, 120, 40);
    assert!(
        screen.contains("Ctrl+B arms the prefix; Esc cancels it."),
        "chordless footer line rendered"
    );
    // Narrow width shrinks the sidebar region to half the body.
    app.tour_index = 1;
    let narrow = draw(&app, 40, 24);
    assert!(
        narrow.contains("Tour"),
        "narrow render still draws the card"
    );

    // Mode Tour with an out-of-range index (only reachable if the walk
    // raced a step-table change, but the guard must hold): tour_step()
    // yields None and render_tour returns before touching the layout.
    app.tour_index = tour::tour_steps().len() + 5;
    let guard = draw(&app, 80, 24);
    assert!(!guard.contains("Tour"), "no step: no card drawn");
}
