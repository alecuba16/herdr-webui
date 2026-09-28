//! Workspace and panel management for the TUI.
//!
//! Phase 1 of the TUI parity plan (`docs/tui-parity-plan.md`): create,
//! rename, and close workspaces, panel navigation, and worktree dialogs,
//! all driven by the `Ctrl+B` prefix shortcuts that mirror the WebUI
//! `DEFAULT_WEBUI_SHORTCUTS`. Backed entirely by `BackendClient` JSON-RPC
//! methods (`workspace.*`, `tab.*`, `worktree.*`).

use serde_json::Value;
use std::path::{Path, PathBuf};

use super::{PromptInput, PromptKind, SidebarFocus, TuiApp, TuiMode};

/// Result of a workspace action, reported through the status line or
/// error slot by the caller.
pub type WorkspaceResult = Result<String, String>;

/// Expand a leading `~` or `~/...` to `$HOME`, the TUI counterpart of the
/// webui `expand_user_path_string` (main.rs). Keeps relative and absolute
/// paths untouched so the backend keeps its own resolution.
pub(crate) fn expand_tilde_path(input: &str) -> PathBuf {
    let trimmed = input.trim();
    if trimmed == "~" {
        return home_dir().unwrap_or_else(|| PathBuf::from(trimmed));
    }
    if let Some(rest) = trimmed.strip_prefix("~/") {
        return match home_dir() {
            Some(home) => home.join(rest),
            None => PathBuf::from(trimmed),
        };
    }
    PathBuf::from(trimmed)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/// Webui workspace-create validation: the folder must exist on disk.
/// Returns the expanded display path for the status line.
pub(crate) fn validate_workspace_folder(input: &str) -> Result<String, String> {
    let path = expand_tilde_path(input);
    if !Path::new(&path).is_dir() {
        return Err(format!("workspace folder must exist: {}", path.display()));
    }
    Ok(path.to_string_lossy().to_string())
}

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

    /// Webui `newWorkspace` one-shot: validate the typed path and create
    /// the workspace immediately (backend names it after the folder when
    /// no label is given). The interactive prompt flow chains the name
    /// step instead; this entry point covers programmatic callers and
    /// the e2e harness.
    pub fn create_workspace(&mut self, path: &str) -> WorkspaceResult {
        let path = path.trim();
        if path.is_empty() {
            return Err("type a directory path".to_string());
        }
        // Webui parity: expand `~` and reject folders missing on disk
        // before touching the backend (webui "workspace folder must
        // exist" error).
        let expanded = validate_workspace_folder(path)?;
        self.workspace_create_stage = Some(WorkspaceCreateStage::Path(expanded.clone()));
        self.create_workspace_at(&expanded, None)
    }

    /// Label step of the chained prompt: create the staged path with the
    /// typed name (webui modal's "Workspace name" field).
    pub fn create_workspace_with_label(&mut self, label: &str) -> WorkspaceResult {
        let Some(WorkspaceCreateStage::Path(path)) = self.workspace_create_stage.clone() else {
            return Err("no workspace path staged".to_string());
        };
        let label = label.trim();
        if label.is_empty() {
            return Err("type a workspace name".to_string());
        }
        self.create_workspace_at(&path, Some(label))
    }

    /// Create + focus a workspace at a validated path. Shared by the
    /// path-only and path+label prompt flows.
    pub fn create_workspace_at(
        &mut self,
        expanded_path: &str,
        label: Option<&str>,
    ) -> WorkspaceResult {
        let client = self.client.clone();
        let result = client
            .create_workspace(Some(expanded_path), label)
            .map_err(|err| err.to_string())?;
        let id = result
            .get("workspace")
            .and_then(|ws| ws.get("workspace_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.workspace_create_stage = None;
        self.refresh().map_err(|err| err.to_string())?;
        // Focus the new workspace like the webui post-create navigation.
        if !id.is_empty() {
            if let Some(index) = self.snapshot.workspaces.iter().position(|ws| ws.id == id) {
                self.selected_workspace = index;
                self.refresh_tail();
            }
        }
        Ok(format!("workspace created: {expanded_path}"))
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

    /// Webui `openWorktrees` (prefix W): browse the discovered worktrees
    /// of the selected workspace folder. Without a workspace the webui
    /// falls back to the exploration default folder; the TUI uses the
    /// selected workspace cwd or home. Rows land in the WorktreeList
    /// overlay (Enter opens, j/k moves, type filters).
    pub fn worktree_list(&mut self) -> WorkspaceResult {
        let cwd = self
            .selected_workspace()
            .map(|ws| ws.cwd.clone())
            .filter(|cwd| !cwd.is_empty())
            .unwrap_or_else(|| {
                std::env::var_os("HOME")
                    .map(|home| home.to_string_lossy().to_string())
                    .unwrap_or_else(|| ".".to_string())
            });
        let result = self
            .client
            .list_worktrees(Some(&cwd))
            .map_err(|err| err.to_string())?;
        self.worktree_rows = result
            .get("worktrees")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(WorktreeRow::from_json).collect())
            .unwrap_or_default();
        self.worktree_selected = 0;
        self.worktree_filter.clear();
        self.worktree_root = cwd.clone();
        self.open_overlay(TuiMode::WorktreeList);
        Ok(format!("worktrees: {} in {cwd}", self.worktree_rows.len()))
    }

    /// Enter in the WorktreeList overlay: open the selected checkout
    /// through `worktree.open`. The backend focuses an already-open
    /// workspace instead of duplicating it (webui already-open parity).
    pub fn worktree_open_selected(&mut self) -> WorkspaceResult {
        // The cursor indexes the filtered list, exactly like the webui
        // modal selection over its rendered rows.
        let Some(row) = self
            .filtered_worktree_rows()
            .get(self.worktree_selected)
            .cloned()
        else {
            return Err("no worktree selected".to_string());
        };
        if row.path.is_empty() {
            return Err("worktree path missing".to_string());
        }
        self.client
            .open_worktree(&row.path, None, None)
            .map_err(|err| err.to_string())?;
        self.refresh().map_err(|err| err.to_string())?;
        // Focus the opened workspace like the webui post-open navigation.
        let workspace_id = self
            .snapshot
            .workspaces
            .iter()
            .find(|ws| ws.cwd == row.path)
            .map(|ws| ws.id.clone());
        if let Some(id) = workspace_id {
            if let Some(index) = self.snapshot.workspaces.iter().position(|ws| ws.id == id) {
                self.selected_workspace = index;
                self.refresh_tail();
            }
        }
        // Opening a worktree is a context switch (the webui navigates to
        // the new workspace), so it also drops any overlay stack.
        self.overlay_stack.clear();
        self.mode = TuiMode::Navigate;
        Ok(format!("opened {}", row.title()))
    }

    /// Rows matching the typed filter (webui modal search over rows).
    pub fn filtered_worktree_rows(&self) -> Vec<WorktreeRow> {
        let query = self.worktree_filter.trim().to_ascii_lowercase();
        if query.is_empty() {
            return self.worktree_rows.clone();
        }
        self.worktree_rows
            .iter()
            .filter(|row| {
                row.path.to_ascii_lowercase().contains(&query)
                    || row.branch.to_ascii_lowercase().contains(&query)
                    || row.label.to_ascii_lowercase().contains(&query)
            })
            .cloned()
            .collect()
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
    NewWorkspaceName,
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
        // Webui modal parity: step 1 validates the folder (tilde expansion,
        // must exist) and stages it; step 2 takes the name and creates.
        // A validation error stays in step 1 so the user can fix the path.
        WorkspacePrompt::NewWorkspace => {
            match validate_workspace_folder(text) {
                Ok(expanded) => {
                    app.workspace_create_stage = Some(WorkspaceCreateStage::Path(expanded.clone()));
                    app.prompt_input = Some(PromptInput::new(PromptKind::NewWorkspaceName));
                    app.status = format!("workspace name for {expanded}");
                    return;
                }
                Err(err) => {
                    // Re-open the path prompt with the error visible so the
                    // user can correct the typo without re-pressing Ctrl+B N.
                    app.prompt_input = Some(PromptInput::new(PromptKind::NewWorkspace));
                    Err(err)
                }
            }
        }
        WorkspacePrompt::NewWorkspaceName => app.create_workspace_with_label(text),
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

/// Two-step workspace creation prompt: the webui modal collects folder
/// and name at once; the TUI asks path first (validated, tilde-expanded),
/// then the name. The stage carries the validated path between steps.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceCreateStage {
    Path(String),
}

/// One discovered worktree row in the browser overlay (webui worktree
/// open modal row: checkout path, branch, label, linked flag).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeRow {
    pub path: String,
    pub branch: String,
    pub label: String,
    pub is_linked: bool,
}

impl WorktreeRow {
    /// Parse a `worktree.list` JSON row into the overlay shape.
    pub(crate) fn from_json(value: &Value) -> Self {
        Self {
            path: value
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            branch: value
                .get("branch")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            label: value
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            is_linked: value
                .get("is_linked_worktree")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        }
    }

    /// Title line of the overlay row (webui worktreeOpenRowTitle).
    pub fn title(&self) -> String {
        if self.label.is_empty() {
            self.path.clone()
        } else {
            format!("{} ({})", self.path, self.label)
        }
    }
}

impl TuiApp {
    /// Webui `focusNext`/`focusPrev` (Period/Comma): walk the TUI focus
    /// regions. The webui walker moves through DOM controls; the TUI
    /// equivalent is the three keyboard-focusable regions: sidebar
    /// workspaces -> sidebar agents -> main screen.
    pub fn walk_focus(&mut self, delta: isize) {
        // Region order: 0 workspaces, 1 agents, 2 main.
        let current = if self.main_focused {
            2
        } else if self.sidebar_focus == SidebarFocus::Agents {
            1
        } else {
            0
        };
        let next = (current + delta).rem_euclid(3) as usize;
        match next {
            0 => {
                self.main_focused = false;
                self.sidebar_focus = SidebarFocus::Workspaces;
                self.status = "focus: workspaces".to_string();
            }
            1 => {
                self.main_focused = false;
                self.sidebar_focus = SidebarFocus::Agents;
                self.status = "focus: agents".to_string();
            }
            _ => {
                self.main_focused = true;
                self.status = "focus: main".to_string();
            }
        }
    }

    /// Webui `tempTerminalToggle` (Shift+M): open or re-focus the
    /// temporary terminal. The webui shows an overlay; the TUI
    /// approximation is a tab labeled "temp" in a workspace labeled
    /// "temp" (same labels the backend and webui use, so `tab.promote`
    /// recognizes the tab). Reusing the focused workspace's cwd when
    /// no temp workspace exists yet stands in for the webui's
    /// configured default folder, which has no TUI settings entry.
    pub fn temp_terminal_toggle(&mut self) -> WorkspaceResult {
        // Reuse an existing temp workspace, else create one.
        let temp_workspace = match self
            .snapshot
            .workspaces
            .iter()
            .find(|workspace| workspace.label == "temp")
        {
            Some(workspace) => workspace.id.clone(),
            None => {
                let cwd = self
                    .selected_workspace()
                    .map(|workspace| workspace.cwd.clone())
                    .unwrap_or_default();
                let result = self
                    .client
                    .create_workspace(Some(cwd.as_str()), Some("temp"))
                    .map_err(|err| err.to_string())?;
                result
                    .get("workspace")
                    .and_then(|ws| ws.get("workspace_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            }
        };
        if temp_workspace.is_empty() {
            return Err("could not create the temp workspace".to_string());
        }
        // Reuse the existing temp tab, else create one (label "temp" is
        // what `tab.promote` renames away from when promoting).
        let existing_tab = self
            .snapshot
            .workspace_tabs(&temp_workspace)
            .into_iter()
            .find(|tab| tab.label == "temp")
            .map(|tab| tab.id.clone());
        let (tab_id, created) = match existing_tab {
            Some(tab_id) => (tab_id, false),
            None => {
                let result = self
                    .client
                    .create_tab(Some(temp_workspace.as_str()), Some("temp"))
                    .map_err(|err| err.to_string())?;
                let tab_id = result
                    .get("tab")
                    .and_then(|tab| tab.get("tab_id"))
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                (tab_id, true)
            }
        };
        if tab_id.is_empty() {
            return Err("could not create the temp tab".to_string());
        }
        if created {
            self.refresh().map_err(|err| err.to_string())?;
        }
        // Focus like create_workspace: select the temp workspace and its
        // first pane so Enter attaches to the temporary shell.
        if let Some(index) = self
            .snapshot
            .workspaces
            .iter()
            .position(|workspace| workspace.id == temp_workspace)
        {
            self.selected_workspace = index;
        }
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
            self.refresh_tail();
        }
        Ok("temporary terminal ready: Enter attaches".to_string())
    }

    /// Webui `tempTerminalPromote` (Shift+P): promote the temporary
    /// terminal tab into a real workspace rooted at the shell's live
    /// cwd (built-in `tab.promote`). Requires a temp tab to exist;
    /// mirrors the webui guard that the overlay must be visible.
    pub fn temp_terminal_promote(&mut self) -> WorkspaceResult {
        let temp_tab = self
            .snapshot
            .tabs
            .iter()
            .find(|tab| tab.label == "temp")
            .map(|tab| tab.id.clone());
        let Some(tab_id) = temp_tab else {
            return Err("no temporary terminal open".to_string());
        };
        self.client
            .promote_tab(&tab_id)
            .map_err(|err| err.to_string())?;
        self.refresh().map_err(|err| err.to_string())?;
        // The promoted tab lands in the workspace at its live cwd; jump
        // the selection there like the webui post-promote navigation.
        if let Some(pane) = self
            .snapshot
            .panes
            .iter()
            .find(|pane| pane.tab_id == tab_id)
        {
            if let Some(index) = self
                .snapshot
                .workspaces
                .iter()
                .position(|workspace| workspace.id == pane.workspace_id)
            {
                self.selected_workspace = index;
            }
            if let Some(index) = self
                .snapshot
                .agents
                .iter()
                .position(|agent| agent.pane_id == pane.id)
            {
                self.selected_agent = index;
            }
            self.refresh_tail();
        }
        Ok("temporary terminal promoted".to_string())
    }
}

#[cfg(test)]
mod tests;
