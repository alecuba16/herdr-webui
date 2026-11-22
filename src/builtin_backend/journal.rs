//! Session journal persistence and replay.

use super::*;

/// Journal filename inside the canonical `builtin/<name>` session
/// directory. Close and cleanup remove that directory (or the file), so
/// the journal's lifecycle follows the session slot.
pub(crate) const SESSION_JOURNAL_FILE: &str = "session-journal.json";

/// Snapshot of the session's structural state, enough to rebuild the
/// workspace set after a restart. Live process state (PTY contents,
/// running agents, jcode detection) is deliberately not journaled: it
/// cannot survive a restart, and replaying fresh shells is the honest
/// recovery.
#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct SessionJournal {
    pub(super) version: u32,
    /// Workspaces in creation order; replay opens them in the same order
    /// so id assignment (and therefore list ordering) matches the
    /// pre-restart session as closely as possible.
    pub(super) workspaces: Vec<JournalWorkspace>,
    /// Cwd of the focused workspace. Replay renumbers every id, so the cwd
    /// is the one identity that survives a restart; a plain id would point
    /// at whatever record happens to hold that number now.
    pub(super) focused_workspace_cwd: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub(super) struct JournalWorkspace {
    pub(super) workspace_id: String,
    pub(super) label: String,
    pub(super) cwd: String,
    /// Shell tab labels in order. Agent tabs are excluded at journal time:
    /// their processes are gone and a fresh shell under the agent's name
    /// would misrepresent what replay actually restored.
    pub(super) shell_tabs: Vec<String>,
}

pub(super) fn journal_from_data(data: &BuiltinData, shell: &str) -> SessionJournal {
    let workspaces = ordered_workspaces(data)
        .into_iter()
        .map(|workspace| {
            let shell_tabs = workspace
                .tab_ids
                .iter()
                .filter_map(|tab_id| data.tabs.get(tab_id))
                .filter(|tab| {
                    // Shell tabs are identified by argv, not label: a
                    // renamed tab still runs the default shell and is
                    // replayable, an agent tab runs the agent's command
                    // and is not.
                    tab.pane_ids
                        .iter()
                        .filter_map(|pane_id| data.panes.get(pane_id))
                        .any(|pane| pane.argv.len() == 1 && pane.argv[0] == shell)
                })
                .map(|tab| tab.label.clone())
                .collect::<Vec<_>>();
            JournalWorkspace {
                workspace_id: workspace.workspace_id.clone(),
                label: workspace.label.clone(),
                cwd: workspace.cwd.to_string_lossy().into_owned(),
                shell_tabs,
            }
        })
        .collect::<Vec<_>>();
    SessionJournal {
        version: 1,
        workspaces,
        focused_workspace_cwd: data
            .focused_workspace_id
            .as_ref()
            .and_then(|workspace_id| data.workspaces.get(workspace_id))
            .map(|workspace| workspace.cwd.to_string_lossy().into_owned()),
    }
}

/// Rebuild the workspace set from the journal. Every step is best effort:
/// a vanished checkout is skipped, a tab that cannot spawn stays missing,
/// and replay never turns into a backend start failure. Workspace rows are
/// created in journal order, then the shell tabs spawn in parallel across
/// workspaces. Called before the listeners bind, so no lock contention with
/// live requests exists yet and no client observes the in-between state.
pub(super) fn replay_session_journal(state: &BuiltinState, journal_path: &Path) {
    let Ok(payload) = fs::read(journal_path) else {
        return;
    };
    let Ok(journal) = serde_json::from_slice::<SessionJournal>(&payload) else {
        return;
    };
    let SessionJournal {
        version,
        workspaces,
        focused_workspace_cwd,
    } = journal;
    if version != 1 {
        return;
    }
    // Phase 1, sequential: workspace rows without terminals, in journal
    // order so id assignment (and list ordering) matches the pre-restart
    // session; phase 2 gets the full spawn budget.
    let mut restored = Vec::<(String, String)>::new();
    let mut pending = Vec::<(String, Vec<String>)>::new();
    for journal_workspace in workspaces {
        let path = PathBuf::from(&journal_workspace.cwd);
        // A vanished checkout is skipped, not restored as a dead entry: the
        // user removed the worktree or folder, so the session must not
        // resurface a workspace whose cwd no longer resolves.
        if !path.is_dir() {
            continue;
        }
        // One skip arm covers every way a workspace row can fail: lock
        // poisoning (the covered path) and a non-string id, which only a
        // broken create_workspace contract can produce. Combinators keep
        // both branch regions out of this file.
        let Some(workspace_id) = state
            .create_workspace(Some(path), Some(journal_workspace.label), false, false)
            .ok()
            .and_then(|workspace| workspace["workspace_id"].as_str().map(str::to_string))
        else {
            continue;
        };
        restored.push((journal_workspace.cwd, workspace_id.clone()));
        if !journal_workspace.shell_tabs.is_empty() {
            pending.push((workspace_id, journal_workspace.shell_tabs));
        }
    }
    // Phase 2, bounded-parallel: shells spawn across workspaces so cold
    // start stays flat in the workspace count. Each worker owns whole
    // workspaces, so per-workspace tab order survives, and replay still
    // finishes before listeners bind: no client sees partial state.
    let next_workspace = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..pending.len().min(REPLAY_WORKERS) {
            scope.spawn(|| loop {
                let index = next_workspace.fetch_add(1, Ordering::AcqRel);
                let Some((workspace_id, labels)) = pending.get(index) else {
                    break;
                };
                for label in labels {
                    let _ =
                        state.create_tab(Some(workspace_id.clone()), Some(label.clone()), false);
                }
            });
        }
    });
    // Phase 3: restore focus. Replay's fresh focus lands on the first
    // opened workspace, so the journaled cwd wins whenever its checkout
    // survived.
    restore_focus_from_journal(state, focused_workspace_cwd.as_deref(), &restored);
}

pub(super) fn restore_focus_from_journal(
    state: &BuiltinState,
    focused_cwd: Option<&str>,
    restored: &[(String, String)],
) {
    let Some(focused_cwd) = focused_cwd else {
        return;
    };
    let Some(workspace_id) = restored
        .iter()
        .find(|(cwd, _)| cwd == focused_cwd)
        .map(|(_, id)| id.clone())
    else {
        return;
    };
    let Ok(mut data) = state.data.lock() else {
        return;
    };
    data.focused_workspace_id = Some(workspace_id.clone());
    data.focused_tab_id = data
        .workspaces
        .get(&workspace_id)
        .and_then(|workspace| workspace.tab_ids.first().cloned());
    data.focused_pane_id = data
        .focused_tab_id
        .as_ref()
        .and_then(|tab_id| data.tabs.get(tab_id))
        .and_then(|tab| tab.pane_ids.first().cloned());
}
