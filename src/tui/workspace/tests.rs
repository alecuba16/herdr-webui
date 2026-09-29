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

    // Wraps to the first panel (webui selectRelativePanel cycles).
    app.move_panel(1).unwrap();
    assert_eq!(app.selected_agent, 0);

    app.move_panel(-1).unwrap();
    assert_eq!(app.selected_agent, 1);

    // Wraps back to the first panel from the start.
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
fn prefix_n_opens_folder_picker_and_stages_on_enter() {
    let ctrl_b = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
    let (mut app, _stop) = app_with_fake_backend();

    // Ctrl+B N opens the browser overlay in pick mode: same rows as
    // prefix W, but Enter stages a folder instead of opening it.
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    assert_eq!(app.mode, TuiMode::WorktreeList);
    assert!(app.worktree_pick_workspace, "prefix N sets the pick intent");
    assert_eq!(app.worktree_root, "/repo");

    // Enter on the "this folder" row validates on disk like the typed
    // path flow; the fake /repo does not exist, so the error surfaces
    // and nothing is staged.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert!(
        app.status.contains("workspace folder must exist"),
        "status: {}",
        app.status
    );
    assert_eq!(app.workspace_create_stage, None);
    assert_eq!(app.mode, TuiMode::WorktreeList, "failed pick stays open");

    // A real folder stages into the workspace name prompt (webui
    // modal collects folder + name; the TUI chains them).
    let dir = std::env::temp_dir().join("tui-ws-picker");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.to_string_lossy().to_string();
    app.worktree_root = path.clone();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(
        app.workspace_create_stage,
        Some(WorkspaceCreateStage::Path(path))
    );
    assert!(!app.worktree_pick_workspace, "pick consumed on stage");
    assert_eq!(app.mode, TuiMode::Navigate, "picker closed after staging");
    assert_eq!(
        app.prompt_input.as_ref().map(|p| p.kind),
        Some(crate::tui::PromptKind::NewWorkspaceName)
    );

    // Esc cancels the pick intent without staging.
    let (mut app, _stop) = app_with_fake_backend();
    app.handle_key(ctrl_b);
    app.handle_key(KeyEvent::from(KeyCode::Char('n')));
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);
    assert!(!app.worktree_pick_workspace);
    assert_eq!(app.workspace_create_stage, None);
}

#[test]
fn pick_mode_enter_descends_folders_and_o_stages() {
    let (mut app, _stop) = app_with_fake_backend();
    let root = std::env::temp_dir().join("tui-ws-picker-tree");
    let sub = root.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    let root_path = root.to_string_lossy().to_string();
    let sub_path = sub.to_string_lossy().to_string();

    // Open the picker rooted at a real temp folder with a subdirectory.
    // The fake backend injects a /repo worktree row for any cwd, so the
    // browser rows are [this-folder, worktree(/repo), sub].
    app.worktree_pick_workspace = true;
    app.worktree_browse(&root_path).unwrap();
    assert_eq!(app.worktree_folder_rows.len(), 1, "sub shows as a row");

    // Cursor 2 is the subdirectory. Enter on it descends (stays a
    // picker) instead of staging it.
    app.worktree_selected = 2;
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.worktree_root, sub_path, "Enter descends into sub");
    assert_eq!(app.mode, TuiMode::WorktreeList, "picker stays open");
    assert!(app.worktree_pick_workspace, "descent keeps the pick intent");
    assert_eq!(app.workspace_create_stage, None);

    // `o` stages the browsed folder into the name prompt.
    app.handle_key(KeyEvent::from(KeyCode::Char('o')));
    assert_eq!(
        app.workspace_create_stage,
        Some(WorkspaceCreateStage::Path(sub_path.clone()))
    );
    assert!(!app.worktree_pick_workspace);
    assert_eq!(app.mode, TuiMode::Navigate);
    assert_eq!(
        app.prompt_input.as_ref().map(|p| p.kind),
        Some(crate::tui::PromptKind::NewWorkspaceName)
    );

    // Backspace on an empty filter goes to the parent (same reflex as `h`).
    let (mut app, _stop) = app_with_fake_backend();
    app.worktree_browse(&sub_path).unwrap();
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.worktree_root, root_path, "backspace goes to parent");
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
        PromptKind::NewWorkspaceName,
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
                PromptKind::NewWorkspaceName => WorkspacePrompt::NewWorkspaceName,
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

    let path = crate::backend_client::unique_test_path("herdr-workspace-fake");
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
            | "worktree.create" | "worktree.open" | "tab.promote" => {
                json!({"id": id, "result": {"ok": true}})
            }
            "worktree.list" => {
                json!({"id": id, "result": {"worktrees": [{"path": "/repo", "branch": "main"}]}})
            }
            "pane.read" => json!({"id": id, "result": {"read": {"text": ""}}}),
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

/// Shared entry for sibling test modules: a client wired to the fake
/// backend (answers worktree.list and friends) so tests that press
/// API-backed keys stay hermetic. The stop channel leaks by design;
/// the listener thread parks on its socket until process exit.
pub(crate) fn fake_backend_client() -> BackendClient {
    let (api_socket, _stop) = workspace_fake_socket();
    BackendClient::new(api_socket.clone(), api_socket)
}

#[test]
fn workspace_actions_validate_empty_inputs_and_missing_selection() {
    // The worktree-list fallback hits the backend socket; wire the
    // fake one so this stays hermetic (the builtin socket answers
    // differently depending on the live session state).
    let mut app = TuiApp::new(fake_backend_client(), Duration::from_secs(1));
    app.snapshot = crate::tui::model::TuiSnapshot::from_backend_response(&workspace_snapshot());
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
    // Webui parity: without a workspace the worktree browser still opens,
    // falling back to the home folder instead of failing.
    assert!(app.worktree_list().is_ok());
    assert_eq!(app.mode, TuiMode::WorktreeList);
    assert_eq!(app.worktree_selected, 0);
    app.mode = TuiMode::Navigate;
    assert_eq!(
        app.create_worktree("branch", "/tmp/path").unwrap_err(),
        "no workspace folder selected"
    );
}

#[test]
fn workspace_backend_actions_succeed_against_fake_socket() {
    let (mut app, _stop) = app_with_fake_backend();

    // Webui parity: the folder must exist and tilde expands. Use a real
    // temp dir so validation passes like the webui modal does.
    let dir = std::env::temp_dir().join("tui-ws-create-parity");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.to_string_lossy().to_string();
    assert_eq!(
        app.create_workspace(&format!(" {path} ")).unwrap(),
        format!("workspace created: {path}")
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
    assert_eq!(
        app.worktree_list().unwrap(),
        "browsing /docs (1 worktrees, 0 folders)"
    );
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

/// Serializes tests that touch `$HOME`: one removes it process-wide
/// (expand_tilde_falls_back_without_home) while the other expands `~`
/// against it, so running them concurrently is a race.
static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[test]
fn new_workspace_prompt_validates_tilde_expands_and_chains_name_step() {
    let _guard = HOME_LOCK.lock().unwrap();
    use super::{validate_workspace_folder, WorkspaceCreateStage};

    // Tilde expansion mirrors the webui expand_user_path_string.
    let home = std::env::var_os("HOME").expect("HOME set in tests");
    let expanded = super::expand_tilde_path("~");
    assert_eq!(expanded, std::path::PathBuf::from(&home));
    let expanded = super::expand_tilde_path("~/Documents/code");
    assert_eq!(
        expanded,
        std::path::PathBuf::from(&home).join("Documents/code")
    );
    assert_eq!(
        super::expand_tilde_path("/absolute/path"),
        std::path::PathBuf::from("/absolute/path")
    );

    // Webui parity: the folder must exist on disk.
    let missing = validate_workspace_folder("/definitely/not/a/real/dir");
    assert!(missing.unwrap_err().contains("workspace folder must exist"));

    // Step 1 of the prompt chain: a real folder stages the path and
    // opens the name prompt; a bad path stays on the path prompt.
    let (mut app, _stop) = app_with_fake_backend();
    let dir = std::env::temp_dir().join("tui-ws-chained");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.to_string_lossy().to_string();

    run_prompt(&mut app, &WorkspacePrompt::NewWorkspace, &path);
    assert!(app.error.is_none(), "valid path stages: {:?}", app.error);
    assert_eq!(
        app.workspace_create_stage,
        Some(WorkspaceCreateStage::Path(path.clone()))
    );
    assert_eq!(
        app.prompt_input.as_ref().map(|p| p.kind),
        Some(PromptKind::NewWorkspaceName)
    );
    assert_eq!(app.status, format!("workspace name for {path}"));

    // Step 2: the typed name creates the workspace with the label.
    run_prompt(&mut app, &WorkspacePrompt::NewWorkspaceName, "myproj");
    assert!(app.error.is_none(), "create with label: {:?}", app.error);
    assert_eq!(app.status, format!("workspace created: {path}"));
    assert_eq!(app.workspace_create_stage, None);
    assert_eq!(app.selected_workspace, 1);

    // A missing folder keeps the path prompt open and surfaces the error.
    let (mut app, _stop) = app_with_fake_backend();
    run_prompt(
        &mut app,
        &WorkspacePrompt::NewWorkspace,
        "/definitely/not/real",
    );
    assert!(app
        .error
        .as_deref()
        .unwrap_or_default()
        .contains("workspace folder must exist"));
    assert_eq!(
        app.prompt_input.as_ref().map(|p| p.kind),
        Some(PromptKind::NewWorkspace)
    );
    assert_eq!(app.workspace_create_stage, None);

    // The name step without a staged path errors instead of panicking.
    let (mut app, _stop) = app_with_fake_backend();
    run_prompt(&mut app, &WorkspacePrompt::NewWorkspaceName, "orphan");
    assert_eq!(app.error.as_deref(), Some("no workspace path staged"));
}

#[test]
fn worktree_list_browses_filters_and_opens_selected() {
    let (mut app, _stop) = app_with_fake_backend();

    // Ctrl+B W opens the browser overlay for the selected workspace cwd.
    app.worktree_list().unwrap();
    assert_eq!(app.mode, TuiMode::WorktreeList);
    assert_eq!(app.worktree_root, "/repo");
    assert_eq!(app.worktree_rows.len(), 1);
    assert_eq!(app.worktree_rows[0].path, "/repo");
    assert_eq!(app.worktree_rows[0].branch, "main");
    assert_eq!(app.worktree_selected, 0);

    // Filtering narrows the rows (case-insensitive over path/branch).
    app.handle_key(KeyEvent::from(KeyCode::Char('m')));
    assert_eq!(app.worktree_filter, "m");
    assert_eq!(app.filtered_worktree_rows().len(), 1);
    app.handle_key(KeyEvent::from(KeyCode::Char('z')));
    assert_eq!(app.filtered_worktree_rows().len(), 0, "no row matches z");

    // Esc clears the filter first and only closes on the second press.
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::WorktreeList);
    assert_eq!(app.worktree_filter, "");
    app.handle_key(KeyEvent::from(KeyCode::Esc));
    assert_eq!(app.mode, TuiMode::Navigate);

    // Enter opens the selected row through worktree.open and returns
    // to Navigate (backend focuses the already-open workspace).
    app.worktree_list().unwrap();
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.mode, TuiMode::Navigate);
    assert!(app.status.contains("opened"), "status: {}", app.status);

    // Without a workspace the browser still opens, falling back to home.
    let (mut app, _stop) = app_with_fake_backend();
    app.selected_workspace = 99;
    assert!(app.worktree_list().is_ok());
    assert_eq!(app.mode, TuiMode::WorktreeList);
    assert!(!app.worktree_root.is_empty());
}

#[test]
fn worktree_overlay_arrows_move_while_filter_active() {
    // Webui modal parity: the search box does not swallow arrow keys,
    // while j/k stay query letters (typing "j" extends the filter).
    let (mut app, _stop) = app_with_fake_backend();
    app.worktree_list().unwrap();
    assert_eq!(app.worktree_rows.len(), 1);

    // Type a filter that still matches the single row.
    for ch in "repo".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert_eq!(app.worktree_filter, "repo");
    assert_eq!(app.filtered_worktree_rows().len(), 1);

    // Down keeps moving the cursor (wrap over the 2 filtered rows:
    // "this folder" and the worktree) instead of being eaten by the
    // filter, and j extends the query.
    app.worktree_selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Down));
    assert_eq!(app.worktree_selected, 1, "Down moves even with a filter");
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.worktree_filter, "repoj", "j types into the filter");

    // A filter matching nothing clamps the cursor to a valid position.
    app.worktree_filter = "zz".to_string();
    app.worktree_selected = 0;
    app.handle_key(KeyEvent::from(KeyCode::Down));
    assert_eq!(
        app.worktree_selected, 0,
        "empty filtered list keeps cursor 0"
    );
}

#[test]
fn worktree_overlay_covers_remaining_key_arms_and_error_paths() {
    let (mut app, _stop) = app_with_fake_backend();
    app.worktree_list().unwrap();
    assert_eq!(app.worktree_rows.len(), 1);
    assert_eq!(app.worktree_rows[0].title(), "/repo");
    // The fake row has no label, so the title is the bare path.

    // Enter with the cursor past the filtered rows errors instead of
    // panicking (the cursor is clamped by the key handler, but the API
    // entry must still be defensive).
    app.worktree_selected = 5;
    assert_eq!(
        app.worktree_open_selected().unwrap_err(),
        "no worktree selected"
    );

    // Enter with a row whose path is missing errors. The browser list
    // puts the "this folder" row at 0, so the worktree row is at 1.
    app.worktree_selected = 1;
    app.worktree_rows[0].path = String::new();
    assert_eq!(
        app.worktree_open_selected().unwrap_err(),
        "worktree path missing"
    );

    // Ctrl+U clears the filter and resets the cursor.
    app.worktree_list().unwrap();
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    app.worktree_selected = 9;
    app.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL));
    assert_eq!(app.worktree_filter, "");
    assert_eq!(app.worktree_selected, 0);

    // Backspace pops a filter char and clamps the cursor.
    app.handle_key(KeyEvent::from(KeyCode::Char('r')));
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.worktree_filter, "");

    // Up/k move with wrap. The browser list has two rows: the "this
    // folder" row plus the discovered worktree.
    app.handle_key(KeyEvent::from(KeyCode::Up));
    assert_eq!(app.worktree_selected, 1, "up wraps to last on 2 rows");
    app.handle_key(KeyEvent::from(KeyCode::Char('k')));
    assert_eq!(app.worktree_selected, 0);
    app.handle_key(KeyEvent::from(KeyCode::Down));
    assert_eq!(app.worktree_selected, 1);
    app.handle_key(KeyEvent::from(KeyCode::Char('j')));
    assert_eq!(app.worktree_selected, 0);

    // A filter matching nothing keeps a valid cursor and Enter errors.
    for ch in "zz".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert_eq!(app.filtered_worktree_rows().len(), 0);
    assert_eq!(
        app.worktree_open_selected().unwrap_err(),
        "no worktree selected"
    );

    // The no-match render message differs from the empty-discovery one.
    app.handle_key(KeyEvent::from(KeyCode::Enter));
    assert_eq!(app.status, "no worktree selected");
}

#[test]
fn create_workspace_with_label_validates_the_name() {
    let (mut app, _stop) = app_with_fake_backend();
    app.workspace_create_stage = Some(WorkspaceCreateStage::Path("/repo".to_string()));
    assert_eq!(
        app.create_workspace_with_label("   ").unwrap_err(),
        "type a workspace name"
    );
    // The orphan name step (no staged path) errors.
    let (mut app2, _stop2) = app_with_fake_backend();
    assert_eq!(
        app2.create_workspace_with_label("name").unwrap_err(),
        "no workspace path staged"
    );
}

#[test]
fn worktree_row_title_falls_back_to_path_without_label() {
    let row = WorktreeRow {
        path: "/repo".to_string(),
        branch: "main".to_string(),
        label: String::new(),
        is_linked: true,
    };
    assert_eq!(row.title(), "/repo");
}

#[test]
fn worktree_open_focuses_unknown_path_without_panicking() {
    // Opening a worktree whose cwd is not among the refreshed snapshot
    // workspaces skips the focus step instead of panicking (backend may
    // auto-drop or rename on open).
    let (mut app, _stop) = app_with_fake_backend();
    app.worktree_list().unwrap();
    // Cursor 1 targets the worktree row (0 is the "this folder" row).
    app.worktree_selected = 1;
    app.worktree_rows[0].path = "/elsewhere".to_string();
    let before = app.selected_workspace;
    let result = app.worktree_open_selected().unwrap();
    assert_eq!(result, "opened /elsewhere");
    assert_eq!(app.selected_workspace, before, "no focus when cwd missing");
    assert_eq!(app.mode, TuiMode::Navigate);
}

#[test]
fn worktree_backspace_clamps_cursor_when_filter_shrinks() {
    let (mut app, _stop) = app_with_fake_backend();
    app.worktree_list().unwrap();
    // Type a filter, then backspace it to nothing: the cursor stays valid.
    for ch in "repo".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert_eq!(app.filtered_worktree_rows().len(), 1);
    for _ in 0..4 {
        app.handle_key(KeyEvent::from(KeyCode::Backspace));
    }
    assert_eq!(app.worktree_filter, "");
    assert!(app.worktree_selected < app.filtered_worktree_rows().len());
}

#[test]
fn expand_tilde_falls_back_without_home() {
    let _guard = HOME_LOCK.lock().unwrap();
    // Without $HOME a ~/path stays as typed instead of panicking.
    let prev = std::env::var_os("HOME");
    unsafe { std::env::remove_var("HOME") };
    let expanded = expand_tilde_path("~/Documents");
    assert_eq!(expanded, std::path::PathBuf::from("~/Documents"));
    let bare = expand_tilde_path("~");
    assert_eq!(bare, std::path::PathBuf::from("~"));
    if let Some(home) = prev {
        unsafe { std::env::set_var("HOME", home) }
    }
}

#[test]
fn worktree_backspace_on_filter_matching_nothing_clamps_to_zero() {
    // Deleting the last char of a no-match filter must land the cursor
    // on saturating_sub path: filter "zz" (0 rows), backspace -> "z"
    // still 0 rows, cursor clamps to 0 via the len==0 branch.
    let (mut app, _stop) = app_with_fake_backend();
    app.worktree_list().unwrap();
    for ch in "zz".chars() {
        app.handle_key(KeyEvent::from(KeyCode::Char(ch)));
    }
    assert_eq!(app.filtered_worktree_rows().len(), 0);
    app.worktree_selected = 3;
    app.handle_key(KeyEvent::from(KeyCode::Backspace));
    assert_eq!(app.worktree_selected, 0);
    assert_eq!(app.worktree_filter, "z");
}

#[test]
fn focus_workspace_by_id_ignores_empty_ids() {
    // A create/open response without a workspace id must not move the
    // selection (the early return in focus_workspace_by_id).
    let (mut app, _stop) = app_with_fake_backend();
    let before = app.selected_workspace;
    app.focus_workspace_by_id("");
    assert_eq!(app.selected_workspace, before);
}
