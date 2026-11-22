//! Search palette, lens, and composer overlay tests.

use super::*;
use crate::tui::web_api::WebApiClient;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::backend::TestBackend;
use ratatui::Terminal;
use serde_json::json;

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
            worktree: None,
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
            worktree: None,
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
            worktree: None,
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
    // While open, the lens owns the keys: k scrolls up (stops follow).
    app.pane_tail = vec!["one".to_string(), "two".to_string()];
    app.handle_key(KeyEvent::from(KeyCode::Char('k')));
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
fn plain_shift_l_and_shift_c_open_lens_and_composer() {
    // Review F1: the TerminalMain footer advertises Shift+L / Shift+C
    // as plain keys, so they must fire without the Ctrl+B prefix in
    // both focus states (main focused and sidebar focused).
    let mut app = app_with_snapshot();
    app.main_focused = true;
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(app.lens.active, "plain Shift+L opens the lens");
    app.handle_key(KeyEvent::from(KeyCode::Char('i')));
    assert!(!app.lens.active);

    // Composer prompt via plain Shift+C, main focus.
    app.handle_key(KeyEvent::new(KeyCode::Char('C'), KeyModifiers::SHIFT));
    assert!(
        app.prompt_input.is_some(),
        "plain Shift+C opens the composer prompt"
    );
    assert_eq!(app.status, "composer: type the message, Enter sends");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert!(app.prompt_input.is_none());

    // Sidebar focused: the footer still advertises the keys, so they
    // keep working there too.
    app.main_focused = false;
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(app.lens.active, "Shift+L works with the sidebar focused");
    app.handle_key(KeyEvent::from(KeyCode::Char('i')));
    app.handle_key(KeyEvent::new(KeyCode::Char('C'), KeyModifiers::SHIFT));
    assert!(
        app.prompt_input.is_some(),
        "Shift+C works with the sidebar focused"
    );
}

#[test]
fn footer_names_the_split_entry_and_the_mode_hints_take_over() {
    // User report: no way to discover split mode from the regular
    // single-pane view. The chord (Ctrl+B s) worked all along, but the
    // resting TerminalMain hint never named it, so the entry was
    // invisible unless the prefix was armed or the help overlay opened.
    let mut app = app_with_two_panes();
    app.main_focused = true;

    // Resting regular view: the hint names the chord, front-loaded so
    // fit_hint keeps it while the terminal can carry two segments plus
    // the help tail.
    let wide = draw(&app, 120, 24);
    assert!(
        wide.contains("Ctrl+B s split"),
        "the resting main hint must name the split entry"
    );
    // The classic 80-col terminal cannot fit two segments plus the
    // protected help tail (47 > 36 budget), so the hint collapses to
    // the attach action and help, the same line the old hint showed:
    // no regression, the shrink just starts one segment later.
    let medium = draw(&app, 100, 24);
    assert!(
        medium.contains("Ctrl+B s split"),
        "100 columns keep the split chord after the shrink"
    );
    let narrow = draw(&app, 80, 24);
    assert!(
        narrow.contains("Ctrl+B ? help"),
        "the discovery tail never disappears"
    );

    // Once a mode takes over, its own hint names the next step and the
    // resting hint's split entry is not duplicated on screen.
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::from(KeyCode::Char('s')));
    assert!(app.split_mode.is_some());
    let drawn = draw(&app, 120, 24);
    assert!(
        drawn.contains("SPLIT ·"),
        "the split mode hint takes the footer slot"
    );
    assert!(
        !drawn.contains("Ctrl+B s split"),
        "the mode hint replaces the resting hint, no duplicate chord row"
    );
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
    app.handle_key(KeyEvent::from(KeyCode::Char('k')));
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

#[test]
fn lens_page_keys_scroll_by_ten() {
    let mut app = app_with_snapshot();
    app.pane_tail = (0..30).map(|i| format!("line {i}")).collect();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(app.lens.active);
    // PageUp jumps 10 lines away from the tail (stops follow).
    app.handle_key(KeyEvent::from(KeyCode::PageUp));
    assert!(!app.lens.follow);
    assert_eq!(app.lens.scroll_up, 10, "PageUp scrolls up 10 lines");
    // PageDown scrolls back 10 toward the tail, re-arming follow when
    // it lands at the bottom.
    app.handle_key(KeyEvent::from(KeyCode::PageDown));
    assert_eq!(app.lens.scroll_up, 0, "PageDown returns to the tail");
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
fn lens_arrow_and_k_keys_scroll_toward_older_lines() {
    // k and Up share the scroll-away-from-tail arm (the lens's
    // up-scroll, matching the pane view): PageUp covers the 10-line
    // jump, this covers the single-step one, plus the Up alias of the
    // k scroll.
    let mut app = app_with_snapshot();
    app.pane_tail = (0..30).map(|i| format!("line {i}")).collect();
    app.handle_key(ctrl('b'));
    app.handle_key(KeyEvent::new(KeyCode::Char('L'), KeyModifiers::SHIFT));
    assert!(app.lens.active);
    // Up aliases k: one line away from the tail.
    app.handle_key(KeyEvent::from(KeyCode::Up));
    assert!(!app.lens.follow);
    assert_eq!(app.lens.scroll_up, 1);
    // j scrolls one line back toward the tail.
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.lens.scroll_up, 0);
    assert!(app.lens.follow, "back at the tail re-arms follow");
    // Down aliases j from a scrolled position.
    app.handle_key(KeyEvent::from(KeyCode::PageUp));
    assert_eq!(app.lens.scroll_up, 10);
    app.handle_key(KeyEvent::from(KeyCode::Down));
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
fn composer_prompt_backspace_and_ctrl_u_edit_the_draft() {
    let mut app = app_with_snapshot();
    point_web_api_at_dead_port(&mut app);
    app.screen = TuiScreen::Terminal;
    app.run_shortcut(Shortcut::Composer);
    app.handle_key(KeyEvent::from(KeyCode::Char('h')));
    app.handle_key(KeyEvent::from(KeyCode::Char('i')));
    // Backspace drops the last character and resyncs the draft.
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "h");
    assert_eq!(
        app.composer_drafts.get("pane_1").map(String::as_str),
        Some("h")
    );
    // Ctrl+U clears the prompt text and the draft.
    app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "");
    assert_eq!(
        app.composer_drafts.get("pane_1").map(String::as_str),
        Some("")
    );
    // No focused pane resolves: the draft sync is a no-op, not a panic.
    app.snapshot.panes.clear();
    app.handle_key(KeyEvent::from(KeyCode::Char('x')));
    assert_eq!(app.prompt_input.as_ref().unwrap().text, "x");
}
