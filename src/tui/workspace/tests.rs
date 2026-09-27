//! Tests for workspace and panel management actions (Phase 1 of
//! `docs/tui-parity-plan.md`).

use std::time::Duration;

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::json;

use super::*;
use crate::backend_client::BackendClient;

fn app_with_snapshot(snapshot: serde_json::Value) -> TuiApp {
    let mut app = TuiApp::new(BackendClient::builtin_session(None), Duration::from_secs(1));
    app.snapshot = crate::tui::model::TuiSnapshot::from_backend_response(&snapshot);
    app
}

fn workspace_snapshot() -> serde_json::Value {
    json!({
        "type": "session_snapshot",
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"working","pane_count":1,"tab_count":2,"active_tab_id":"tab_1"},
                {"workspace_id":"ws_2","label":"Docs","cwd":"/docs","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_3"}
            ],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"working"},
                {"tab_id":"tab_2","workspace_id":"ws_1","label":"Build","focused":false,"pane_count":1,"agent_status":"idle"},
                {"tab_id":"tab_3","workspace_id":"ws_2","label":"Notes","focused":false,"pane_count":1,"agent_status":"idle"}
            ],
            "panes": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"working","foreground_cwd":"/repo","focused":true},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_2","agent":"shell","display_agent":"shell","agent_status":"idle","foreground_cwd":"/repo","focused":false},
                {"pane_id":"pane_3","terminal_id":"term_3","workspace_id":"ws_2","tab_id":"tab_3","agent":"shell","display_agent":"shell","agent_status":"idle","foreground_cwd":"/docs","focused":false}
            ],
            "agents": [
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"working","cwd":"/repo","focused":true},
                {"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_2","agent":"shell","display_agent":"shell","agent_status":"idle","cwd":"/repo","focused":false},
                {"pane_id":"pane_3","terminal_id":"term_3","workspace_id":"ws_2","tab_id":"tab_3","agent":"shell","display_agent":"shell","agent_status":"idle","cwd":"/docs","focused":false}
            ]
        }
    })
}

#[test]
fn move_panel_moves_selection_within_workspace_tabs() {
    let mut app = app_with_snapshot(workspace_snapshot());
    // Active tab is tab_1 whose pane is pane_1, agent index 0.
    assert_eq!(app.active_tab_id().as_deref(), Some("tab_1"));

    app.move_panel(1).unwrap();
    // Second tab tab_2 selects its agent pane_2 (index 1).
    assert_eq!(app.selected_agent, 1);

    // Clamped at the last panel.
    app.move_panel(1).unwrap();
    assert_eq!(app.selected_agent, 1);

    app.move_panel(-1).unwrap();
    assert_eq!(app.selected_agent, 0);

    // Clamped at the first panel.
    app.move_panel(-1).unwrap();
    assert_eq!(app.selected_agent, 0);
}

#[test]
fn move_panel_without_tabs_errors() {
    let mut app = app_with_snapshot(json!({
        "type": "session_snapshot",
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Empty","cwd":"","focused":true,"agent_status":"idle","pane_count":0,"tab_count":0}
            ],
            "tabs": [], "panes": [], "agents": []
        }
    }));
    assert!(app.move_panel(1).is_err());
    assert!(app.move_panel(-1).is_err());
}

#[test]
fn active_tab_id_falls_back_to_first_tab() {
    let mut app = app_with_snapshot(workspace_snapshot());
    app.snapshot.workspaces[0].active_tab_id = None;
    assert_eq!(app.active_tab_id().as_deref(), Some("tab_1"));

    // Workspace with no tabs yields None.
    app.selected_workspace = 99;
    assert_eq!(app.active_tab_id(), None);
}

#[test]
fn prefix_bracket_shortcuts_move_panels() {
    let ctrl_b = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    let mut app = app_with_snapshot(workspace_snapshot());
    assert_eq!(app.selected_agent, 0);

    // Ctrl+B ] selects the next panel (webui nextPanel).
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char(']')));
    assert_eq!(app.selected_agent, 1);

    // Ctrl+B [ selects the previous panel (webui prevPanel).
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('[')));
    assert_eq!(app.selected_agent, 0);
}

#[test]
fn prefix_n_opens_new_workspace_prompt() {
    let ctrl_b = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    let mut app = app_with_snapshot(workspace_snapshot());

    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    let prompt = app.prompt_input.as_ref().unwrap();
    assert_eq!(prompt.kind, PromptKind::NewWorkspace);

    // Typing then Enter tries the backend create; the builtin backend
    // errors without a real session, which surfaces in the error slot.
    app.handle_key(KeyEvent::from(KeyCode::Char('/')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some() || app.status.contains("workspace"));
}

#[test]
fn prefix_shift_t_opens_worktree_branch_prompt_and_chains_to_path() {
    let ctrl_b = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    let mut app = app_with_snapshot(workspace_snapshot());

    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('T')));
    let prompt = app.prompt_input.as_ref().unwrap();
    assert_eq!(prompt.kind, PromptKind::CreateWorktreeBranch);

    // Empty branch text errors instead of chaining.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.error.is_some());
    assert!(app.prompt_input.is_none());

    // Typed branch stores the stage and chains into the path prompt.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('T')));
    for ch in "feature".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.worktree_create_stage,
        Some(WorktreeCreateStage::Branch("feature".to_string()))
    );
    let prompt = app.prompt_input.as_ref().unwrap();
    assert_eq!(prompt.kind, PromptKind::CreateWorktreePath);
}

#[test]
fn confirm_close_workspace_requires_y() {
    let ctrl_b = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    let mut app = app_with_snapshot(workspace_snapshot());

    // Prefix Shift+X opens the confirm prompt.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('X')));
    let prompt = app.prompt_input.as_ref().unwrap();
    assert_eq!(prompt.kind, PromptKind::ConfirmCloseWorkspace);

    // Typing something other than y cancels without closing the workspace.
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(app.prompt_input.is_none());
    assert_eq!(app.status, "cancelled");
    assert!(app.error.is_none(), "no backend call made: {:?}", app.error);
}

#[test]
fn prompt_kind_hints_and_titles_cover_workspace_kinds() {
    for kind in [
        PromptKind::NewWorkspace,
        PromptKind::RenameWorkspace,
        PromptKind::RenamePanel,
        PromptKind::CreateWorktreeBranch,
        PromptKind::CreateWorktreePath,
        PromptKind::ConfirmCloseWorkspace,
    ] {
        assert!(!kind.title().is_empty());
        assert!(!kind.hint().is_empty());
        assert_eq!(
            kind.into_workspace_prompt(),
            match kind {
                PromptKind::NewWorkspace => WorkspacePrompt::NewWorkspace,
                PromptKind::RenameWorkspace => WorkspacePrompt::RenameWorkspace,
                PromptKind::RenamePanel => WorkspacePrompt::RenamePanel,
                PromptKind::CreateWorktreeBranch => WorkspacePrompt::CreateWorktreeBranch,
                PromptKind::CreateWorktreePath => WorkspacePrompt::CreateWorktreePath,
                PromptKind::ConfirmCloseWorkspace => WorkspacePrompt::ConfirmCloseWorkspace,
                _ => unreachable!(),
            }
        );
    }
    // Only the four confirm kinds require y-to-submit.
    assert!(!PromptKind::NewWorkspace.needs_confirm());
    assert!(!PromptKind::RenameFile.needs_confirm());
    assert!(PromptKind::ConfirmDeleteFile.needs_confirm());
    assert!(PromptKind::ConfirmCloseWorkspace.needs_confirm());
}

#[test]
fn rename_and_create_prompt_kinds_are_not_destructive() {
    for kind in [
        PromptKind::NewWorkspace,
        PromptKind::RenameWorkspace,
        PromptKind::RenamePanel,
        PromptKind::CreateWorktreeBranch,
        PromptKind::CreateWorktreePath,
    ] {
        assert!(!kind.needs_confirm());
    }
}

#[test]
fn remove_worktree_requires_a_workspace_folder() {
    let mut app = app_with_snapshot(json!({
        "type": "session_snapshot",
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"NoFolder","cwd":"","focused":true,"agent_status":"idle","pane_count":0,"tab_count":0}
            ],
            "tabs": [], "panes": [], "agents": []
        }
    }));
    assert!(app.remove_worktree().is_err());
}

#[test]
fn walk_focus_cycles_regions_and_wraps() {
    // Webui focusNext/focusPrev: workspaces -> agents -> main, wrapping.
    let mut app = app_with_snapshot(workspace_snapshot());
    app.main_focused = false;
    app.sidebar_focus = SidebarFocus::Workspaces;

    app.walk_focus(1);
    assert_eq!(app.sidebar_focus, SidebarFocus::Agents);
    assert!(!app.main_focused);

    app.walk_focus(1);
    assert!(app.main_focused);

    // Wrap: main -> workspaces.
    app.walk_focus(1);
    assert!(!app.main_focused);
    assert_eq!(app.sidebar_focus, SidebarFocus::Workspaces);

    // And backwards wrap: workspaces -> main.
    app.walk_focus(-1);
    assert!(app.main_focused);
    assert_eq!(app.status, "focus: main");
}

#[test]
fn temp_terminal_promote_without_temp_tab_reports_error() {
    // Webui promote guard: no visible temporary terminal means promote
    // is refused, and nothing hits the backend.
    let mut app = app_with_snapshot(workspace_snapshot());
    let result = app.temp_terminal_promote();
    assert_eq!(result.unwrap_err(), "no temporary terminal open");
}

#[test]
fn temp_terminal_toggle_reuses_existing_temp_tab_without_backend_calls() {
    // With a temp workspace + temp tab already in the snapshot, toggle
    // must reuse them (no create, no refresh) and move the selection so
    // Enter attaches to the temporary shell. The builtin session client
    // has no live socket, so any backend call would fail the test.
    let mut app = app_with_snapshot(json!({
        "type": "session_snapshot",
        "snapshot": {
            "workspaces": [
                {"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"},
                {"workspace_id":"ws_t","label":"temp","cwd":"/repo","focused":false,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_t"}
            ],
            "tabs": [
                {"tab_id":"tab_t","workspace_id":"ws_t","label":"temp","focused":false,"pane_count":1,"agent_status":"idle"},
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"}
            ],
            "panes": [
                {"pane_id":"pane_t","terminal_id":"term_t","workspace_id":"ws_t","tab_id":"tab_t","agent":"shell","display_agent":"shell","agent_status":"idle","foreground_cwd":"/repo","focused":false},
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","foreground_cwd":"/repo","focused":true}
            ],
            "agents": [
                {"pane_id":"pane_t","terminal_id":"term_t","workspace_id":"ws_t","tab_id":"tab_t","agent":"shell","display_agent":"shell","agent_status":"idle","cwd":"/repo","focused":false},
                {"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}
            ]
        }
    }));
    assert_eq!(app.selected_workspace, 0, "selection starts on ws_1");
    let result = app.temp_terminal_toggle();
    assert!(result.is_ok(), "reuse path needs no backend");
    assert_eq!(
        app.selected_workspace, 1,
        "selection moved to the temp workspace"
    );
    assert_eq!(
        app.selected_agent, 0,
        "agent selection moved to the temp pane (first in the agents list)"
    );
}
