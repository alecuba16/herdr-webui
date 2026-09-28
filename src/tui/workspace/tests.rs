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

fn workspace_fake_socket() -> (std::path::PathBuf, std::sync::mpsc::Sender<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use interprocess::TryClone as _;
    use std::io::{BufRead, BufReader, Write};

    let path = std::env::temp_dir().join(format!(
        "herdr-workspace-fake-{}-{}.sock",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    let _ = std::fs::remove_file(&path);
    let listener = ListenerOptions::new()
        .name(path.clone().to_fs_name::<GenericFilePath>().unwrap())
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
        let id = request["id"].clone();
        let response = match request["method"].as_str().unwrap_or("") {
            "ping" => json!({"id": id, "result": {"version": "test", "protocol": 1}}),
            "session.snapshot" => json!({"id": id, "result": workspace_snapshot()}),
            "workspace.create" => {
                json!({"id": id, "result": {"workspace": {"workspace_id": "ws_2"}}})
            }
            "workspace.close" | "workspace.rename" | "tab.rename" | "worktree.remove"
            | "worktree.create" | "tab.promote" => json!({"id": id, "result": {"ok": true}}),
            "worktree.list" => {
                json!({"id": id, "result": {"worktrees": [{"path": "/repo", "branch": "main"}]}})
            }
            "tab.create" => json!({"id": id, "result": {"tab": {"tab_id": "tab_t"}}}),
            method => json!({"id": id, "error": format!("unexpected method {method}")}),
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

fn app_with_fake_backend() -> (TuiApp, std::sync::mpsc::Sender<()>) {
    let (api_socket, stop) = workspace_fake_socket();
    let client = BackendClient::new(api_socket.clone(), api_socket);
    let mut app = TuiApp::new(client, Duration::from_secs(1));
    app.snapshot = crate::tui::model::TuiSnapshot::from_backend_response(&workspace_snapshot());
    (app, stop)
}

#[test]
fn workspace_actions_validate_empty_inputs_and_missing_selection() {
    let mut app = app_with_snapshot(workspace_snapshot());
    assert_eq!(
        app.create_workspace("  ").unwrap_err(),
        "type a directory path"
    );
    assert_eq!(
        app.rename_workspace("  ").unwrap_err(),
        "type a workspace name"
    );
    assert_eq!(app.rename_panel("  ").unwrap_err(), "type a panel name");
    assert_eq!(
        app.create_worktree("branch", "  ").unwrap_err(),
        "type branch and checkout path"
    );

    app.selected_workspace = 99;
    assert_eq!(app.close_workspace().unwrap_err(), "no workspace selected");
    assert_eq!(
        app.rename_workspace("name").unwrap_err(),
        "no workspace selected"
    );
    assert_eq!(app.rename_panel("panel").unwrap_err(), "no active panel");
    assert_eq!(app.remove_worktree().unwrap_err(), "no workspace selected");
    assert_eq!(
        app.worktree_list().unwrap_err(),
        "no workspace folder selected"
    );
    assert_eq!(
        app.create_worktree("branch", "/tmp/path").unwrap_err(),
        "no workspace folder selected"
    );
}

#[test]
fn workspace_backend_actions_succeed_against_fake_socket() {
    let (mut app, _stop) = app_with_fake_backend();

    assert_eq!(
        app.create_workspace(" /new ").unwrap(),
        "workspace created: /new"
    );
    assert_eq!(app.selected_workspace, 1);
    assert_eq!(
        app.rename_workspace(" Docs ").unwrap(),
        "workspace renamed to Docs"
    );
    assert_eq!(
        app.rename_panel(" Build ").unwrap(),
        "panel renamed to Build"
    );
    assert_eq!(app.worktree_list().unwrap(), "worktrees: 1 in /docs");
    assert_eq!(
        app.create_worktree(" feature ", " /checkout ").unwrap(),
        "worktree created: feature -> /checkout"
    );
    assert_eq!(app.remove_worktree().unwrap(), "worktree removed");
    assert_eq!(app.close_workspace().unwrap(), "workspace closed");
}

#[test]
fn temp_terminal_backend_paths_create_and_promote() {
    let (mut app, _stop) = app_with_fake_backend();
    app.snapshot
        .workspaces
        .retain(|workspace| workspace.label != "temp");

    assert_eq!(
        app.temp_terminal_toggle().unwrap(),
        "temporary terminal ready: Enter attaches"
    );

    app.snapshot.tabs.push(crate::tui::model::TuiTab {
        id: "tab_t".to_string(),
        workspace_id: "ws_1".to_string(),
        label: "temp".to_string(),
        focused: false,
        pane_count: 1,
        agent_status: "idle".to_string(),
    });
    assert_eq!(
        app.temp_terminal_promote().unwrap(),
        "temporary terminal promoted"
    );
}

#[test]
fn workspace_prompt_status_and_no_selection_edges() {
    let mut app = app_with_snapshot(workspace_snapshot());
    app.workspace_status(Ok("fine".to_string()));
    assert_eq!(app.status, "fine");
    app.workspace_status(Err("bad".to_string()));
    assert_eq!(app.error.as_deref(), Some("bad"));

    super::run_prompt(&mut app, &WorkspacePrompt::CreateWorktreePath, "/tmp/wt");
    assert_ne!(app.status, "worktree created: feature -> /tmp/wt");

    let mut empty = app_with_snapshot(json!({
        "type":"session_snapshot",
        "snapshot":{"workspaces":[],"tabs":[],"panes":[],"agents":[]}
    }));
    assert_eq!(empty.move_panel(1).unwrap_err(), "no workspace selected");
}

#[test]
fn round3_move_panel_and_prompt_guard_edges() {
    let mut app = app_with_snapshot(json!({
        "type": "session_snapshot",
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":2,"active_tab_id":"tab_1"}],
            "tabs": [
                {"tab_id":"tab_1","workspace_id":"ws_1","label":"One","focused":true,"pane_count":1,"agent_status":"idle"},
                {"tab_id":"tab_2","workspace_id":"ws_1","label":"Two","focused":false,"pane_count":1,"agent_status":"idle"}
            ],
            "panes": [{"pane_id":"pane_2","terminal_id":"term_2","workspace_id":"ws_1","tab_id":"tab_2","agent":"shell","display_agent":"shell","agent_status":"idle","foreground_cwd":"/repo","focused":false}],
            "agents": []
        }
    }));
    app.selected_agent = 7;
    assert_eq!(app.move_panel(1).unwrap(), "panel 2/2");
    assert_eq!(app.selected_agent, 7);

    run_prompt(&mut app, &WorkspacePrompt::RenameWorkspace, "   ");
    assert_eq!(app.error.as_deref(), Some("type a workspace name"));
    app.error = None;
    run_prompt(&mut app, &WorkspacePrompt::RenamePanel, "");
    assert_eq!(app.error.as_deref(), Some("type a panel name"));
    app.error = None;
    app.status = "before".to_string();
    run_prompt(&mut app, &WorkspacePrompt::CreateWorktreePath, "/tmp/wt");
    assert_eq!(app.status, "before");
}

#[test]
fn round3_temp_terminal_promote_missing_refreshed_pane_keeps_selection() {
    let (mut app, _stop) = app_with_fake_backend();
    app.snapshot.tabs.push(crate::tui::model::TuiTab {
        id: "tab_missing_pane".to_string(),
        workspace_id: "ws_1".to_string(),
        label: "temp".to_string(),
        focused: false,
        pane_count: 0,
        agent_status: "idle".to_string(),
    });
    app.selected_workspace = 1;
    app.selected_agent = 2;

    assert_eq!(
        app.temp_terminal_promote().unwrap(),
        "temporary terminal promoted"
    );
    assert_eq!(app.selected_workspace, 0);
    assert_eq!(app.selected_agent, 0);
}

#[test]
fn round4_workspace_temp_empty_ids_and_create_path_backend_error() {
    let mut app = app_with_snapshot(json!({
        "type": "session_snapshot",
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
            "tabs": [], "panes": [], "agents": []
        }
    }));
    app.worktree_create_stage = Some(WorktreeCreateStage::Branch("feat".to_string()));
    run_prompt(
        &mut app,
        &WorkspacePrompt::CreateWorktreePath,
        " /checkout ",
    );
    assert!(app.error.is_some());

    let mut app = app_with_snapshot(json!({
        "type": "session_snapshot",
        "snapshot": {
            "workspaces": [{"workspace_id":"","label":"temp","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":0,"tab_count":0}],
            "tabs": [], "panes": [], "agents": []
        }
    }));
    assert_eq!(
        app.temp_terminal_toggle().unwrap_err(),
        "could not create the temp workspace"
    );

    let mut app = app_with_snapshot(json!({
        "type": "session_snapshot",
        "snapshot": {
            "workspaces": [{"workspace_id":"ws_t","label":"temp","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":0,"tab_count":1}],
            "tabs": [{"tab_id":"","workspace_id":"ws_t","label":"temp","focused":true,"pane_count":0,"agent_status":"idle"}],
            "panes": [], "agents": []
        }
    }));
    assert_eq!(
        app.temp_terminal_toggle().unwrap_err(),
        "could not create the temp tab"
    );
}
