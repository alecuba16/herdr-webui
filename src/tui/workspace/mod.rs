//! Workspace and panel management for the TUI.
//!
//! Phase 1 of the TUI parity plan (`docs/tui-parity-plan.md`): create,
//! rename, and close workspaces, panel navigation, and worktree dialogs,
//! all driven by the `Ctrl+B` prefix shortcuts that mirror the WebUI
//! `DEFAULT_WEBUI_SHORTCUTS`. Backed entirely by `BackendClient` JSON-RPC
//! methods (`workspace.*`, `tab.*`, `worktree.*`).

use serde_json::Value;

use super::{PromptInput, PromptKind, TuiApp, TuiScreen};

/// Result of a workspace action, reported through the status line or
/// error slot by the caller.
pub type WorkspaceResult = Result<String, String>;

impl TuiApp {
    /// Report a [`WorkspaceResult`] through the status line or error slot.
    pub(crate) fn workspace_status(&mut self, result: WorkspaceResult) {
        workspace_status(self, result);
    }
    /// Webui `nextPanel` / `prevPanel`: move the selected tab within the
    /// selected workspace. The webui focuses the terminal of the next
    /// panel; the TUI selects it so Enter attaches.
    pub fn move_panel(&mut self, delta: isize) -> WorkspaceResult {
        let Some(workspace) = self
            .selected_workspace()
            .map(|ws| (ws.id.clone(), ws.active_tab_id.clone()))
        else {
            return Err("no workspace selected".to_string());
        };
        let (workspace_id, active_tab_id) = workspace;
        let tabs = self.snapshot.workspace_tabs(&workspace_id);
        let len = tabs.len();
        if len == 0 {
            return Err("no panels in this workspace".to_string());
        }
        let current = tabs
            .iter()
            .position(|tab| Some(&tab.id) == active_tab_id.as_ref())
            .unwrap_or(0);
        let next = (current as isize + delta).clamp(0, len as isize - 1) as usize;
        let tab_id = tabs[next].id.clone();
        // tab.focus is not exposed as a dedicated backend method; the
        // focused tab follows the pane focus in the snapshot refresh.
        // Selecting the terminal pane of that tab approximates it: the
        // agent list index for the tab's first pane.
        if let Some(pane) = self
            .snapshot
            .panes
            .iter()
            .find(|pane| pane.tab_id == tab_id)
        {
            if let Some(index) = self
                .snapshot
                .agents
                .iter()
                .position(|agent| agent.pane_id == pane.id)
            {
                self.selected_agent = index;
            }
        }
        self.refresh_tail();
        Ok(format!("panel {}/{}", next + 1, len))
    }

    /// Webui `newWorkspace`: create a workspace at the typed path.
    pub fn create_workspace(&mut self, path: &str) -> WorkspaceResult {
        let path = path.trim();
        if path.is_empty() {
            return Err("type a directory path".to_string());
        }
        let client = self.client.clone();
        let result = client
            .create_workspace(Some(path), None)
            .map_err(|err| err.to_string())?;
        let id = result
            .get("workspace")
            .and_then(|ws| ws.get("workspace_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.refresh().map_err(|err| err.to_string())?;
        // Focus the new workspace like the webui post-create navigation.
        if !id.is_empty() {
            if let Some(index) = self.snapshot.workspaces.iter().position(|ws| ws.id == id) {
                self.selected_workspace = index;
                self.refresh_tail();
            }
        }
        Ok(format!("workspace created: {path}"))
    }

    /// Webui `closeWorkspace` (prefix Shift+X): close every panel in the
    /// selected workspace through `workspace.close`.
    pub fn close_workspace(&mut self) -> WorkspaceResult {
        let Some(workspace) = self.selected_workspace().map(|ws| ws.id.clone()) else {
            return Err("no workspace selected".to_string());
        };
        self.client
            .request(
                "workspace.close",
                serde_json::json!({ "workspace_id": workspace }),
            )
            .map_err(|err| err.to_string())?;
        self.refresh().map_err(|err| err.to_string())?;
        self.clamp_selection();
        Ok("workspace closed".to_string())
    }

    /// Rename the selected workspace through `workspace.rename`.
    pub fn rename_workspace(&mut self, label: &str) -> WorkspaceResult {
        let label = label.trim();
        if label.is_empty() {
            return Err("type a workspace name".to_string());
        }
        let Some(workspace) = self.selected_workspace().map(|ws| ws.id.clone()) else {
            return Err("no workspace selected".to_string());
        };
        self.client
            .request(
                "workspace.rename",
                serde_json::json!({ "workspace_id": workspace, "label": label }),
            )
            .map_err(|err| err.to_string())?;
        self.refresh().map_err(|err| err.to_string())?;
        Ok(format!("workspace renamed to {label}"))
    }

    /// Rename the active panel through `tab.rename`.
    pub fn rename_panel(&mut self, label: &str) -> WorkspaceResult {
        let label = label.trim();
        if label.is_empty() {
            return Err("type a panel name".to_string());
        }
        let Some(tab_id) = self.active_tab_id() else {
            return Err("no active panel".to_string());
        };
        self.client
            .request(
                "tab.rename",
                serde_json::json!({ "tab_id": tab_id, "label": label }),
            )
            .map_err(|err| err.to_string())?;
        self.refresh().map_err(|err| err.to_string())?;
        Ok(format!("panel renamed to {label}"))
    }

    /// Webui `removeWorktree` (prefix Delete/Backspace): remove the linked
    /// worktree of the selected workspace. Built-in mode blocks the
    /// backend `worktree.remove`, so the error surfaces verbatim; the
    /// HTTP cleanup endpoint is the supported path in a later phase.
    pub fn remove_worktree(&mut self) -> WorkspaceResult {
        let Some(workspace) = self
            .selected_workspace()
            .map(|ws| (ws.id.clone(), ws.cwd.clone()))
        else {
            return Err("no workspace selected".to_string());
        };
        let (_, cwd) = workspace;
        if cwd.is_empty() {
            return Err("selected workspace has no folder".to_string());
        }
        // Mirrors the webui Delete guard: this is a destructive, guarded
        // backend call. The built-in backend returns an explicit
        // unsupported error for worktree.remove.
        self.client
            .request(
                "worktree.remove",
                serde_json::json!({ "cwd": cwd, "path": cwd }),
            )
            .map_err(|err| err.to_string())?;
        self.refresh().map_err(|err| err.to_string())?;
        Ok("worktree removed".to_string())
    }

    /// Webui `openWorktrees` (prefix W): list the worktrees detected for
    /// the selected workspace folder and return them for display.
    pub fn worktree_list(&mut self) -> WorkspaceResult {
        let Some(cwd) = self
            .selected_workspace()
            .map(|ws| ws.cwd.clone())
            .filter(|cwd| !cwd.is_empty())
        else {
            return Err("no workspace folder selected".to_string());
        };
        let result = self
            .client
            .list_worktrees(Some(&cwd))
            .map_err(|err| err.to_string())?;
        let count = result
            .get("worktrees")
            .and_then(Value::as_array)
            .map(|items| items.len())
            .unwrap_or(0);
        self.status = format!("worktrees: {count} in {cwd}");
        self.screen = TuiScreen::Terminal;
        Ok(self.status.clone())
    }

    /// Webui `createWorktree` (prefix Shift+T): create a worktree from
    /// the selected workspace at `branch` checked out into `path`.
    pub fn create_worktree(&mut self, branch: &str, path: &str) -> WorkspaceResult {
        let branch = branch.trim();
        let path = path.trim();
        if branch.is_empty() || path.is_empty() {
            return Err("type branch and checkout path".to_string());
        }
        let Some(cwd) = self
            .selected_workspace()
            .map(|ws| ws.cwd.clone())
            .filter(|cwd| !cwd.is_empty())
        else {
            return Err("no workspace folder selected".to_string());
        };
        self.client
            .create_worktree(&cwd, branch, path, None)
            .map_err(|err| err.to_string())?;
        self.refresh().map_err(|err| err.to_string())?;
        Ok(format!("worktree created: {branch} -> {path}"))
    }

    /// Active tab id of the selected workspace, falling back to its first tab.
    pub fn active_tab_id(&self) -> Option<String> {
        let workspace = self.selected_workspace()?;
        workspace.active_tab_id.clone().or_else(|| {
            self.snapshot
                .workspace_tabs(&workspace.id)
                .first()
                .map(|tab| tab.id.clone())
        })
    }
}

/// Prompt kinds owned by the workspace module, appended to the shared
/// `PromptKind` enum through `TryFrom`-style matching in `mod.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WorkspacePrompt {
    NewWorkspace,
    RenameWorkspace,
    RenamePanel,
    CreateWorktreeBranch,
    CreateWorktreePath,
    ConfirmCloseWorkspace,
}

/// Report a [`WorkspaceResult`] through the status line or error slot.
pub(crate) fn workspace_status(app: &mut TuiApp, result: WorkspaceResult) {
    match result {
        Ok(status) => app.status = status,
        Err(err) => app.error = Some(err),
    }
}

/// Collect typed prompt text and execute the matching workspace action.
/// Mirrors how `run_prompt_action` in `mod.rs` dispatches file/git prompts.
pub(crate) fn run_prompt(app: &mut TuiApp, kind: &WorkspacePrompt, text: &str) {
    let result = match kind {
        WorkspacePrompt::NewWorkspace => app.create_workspace(text),
        WorkspacePrompt::RenameWorkspace => app.rename_workspace(text),
        WorkspacePrompt::RenamePanel => app.rename_panel(text),
        WorkspacePrompt::ConfirmCloseWorkspace => app.close_workspace(),
        WorkspacePrompt::CreateWorktreeBranch => {
            let branch = text.trim();
            if branch.is_empty() {
                Err("type a branch name".to_string())
            } else {
                app.worktree_create_stage = Some(WorktreeCreateStage::Branch(branch.to_string()));
                // Chain straight into the checkout path prompt.
                app.prompt_input = Some(PromptInput::new(PromptKind::CreateWorktreePath));
                Ok("type the checkout path".to_string())
            }
        }
        WorkspacePrompt::CreateWorktreePath => {
            let Some(WorktreeCreateStage::Branch(branch)) = app.worktree_create_stage.take() else {
                return;
            };
            app.create_worktree(&branch, text)
        }
    };
    match result {
        Ok(status) => app.status = status,
        Err(err) => app.error = Some(err),
    }
}

/// Two-step worktree creation prompt: branch first, then checkout path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeCreateStage {
    Branch(String),
}

#[cfg(test)]
mod tests;
