//! Workspace and panel management for the TUI.
//!
//! Phase 1 of the TUI parity plan (`docs/tui-parity-plan.md`): create,
//! rename, and close workspaces, panel navigation, and worktree dialogs,
//! all driven by the `Ctrl+B` prefix shortcuts that mirror the WebUI
//! `DEFAULT_WEBUI_SHORTCUTS`. Backed entirely by `BackendClient` JSON-RPC
//! methods (`workspace.*`, `tab.*`, `worktree.*`).

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
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
        // The cursor tracks the pane the TUI actually selected (the
        // selected agent's tab), because the snapshot's active_tab_id
        // only follows a real backend focus, not the local selection.
        // Without this, moving twice from a non-active tab jumps back.
        let current = self
            .selected_agent_pane_id()
            .and_then(|pane_id| {
                self.snapshot
                    .panes
                    .iter()
                    .find(|pane| pane.id == pane_id)
                    .map(|pane| pane.tab_id.clone())
            })
            .and_then(|tab_id| tabs.iter().position(|tab| tab.id == tab_id))
            .or_else(|| {
                tabs.iter()
                    .position(|tab| Some(&tab.id) == active_tab_id.as_ref())
            })
            .unwrap_or(0);
        // Webui `selectRelativePanel` wraps around the tab list
        // (`(current + delta + tabs.length) % tabs.length`), so the
        // panel cursor cycles instead of sticking at the edges.
        let next = (current as isize + delta).rem_euclid(len as isize) as usize;
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

    /// Pane id of the agent row the sidebar has selected, if any.
    fn selected_agent_pane_id(&self) -> Option<String> {
        self.selected_agent().map(|agent| agent.pane_id.clone())
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
        // Desktop records every created workspace into the recents
        // list right after the create (fire-and-forget POST after
        // `POST /api/workspaces`); the TUI's socket-side create never
        // passes a recording proxy, so record here, best effort: a
        // failed record must not fail the workspace creation.
        let _ = self
            .web_api
            .record_recent_workspace(expanded_path, label, Some("workspace"));
        self.refresh().map_err(|err| err.to_string())?;
        self.focus_workspace_by_id(&id);
        Ok(format!("workspace created: {expanded_path}"))
    }

    /// Focus the workspace with the given id after a refresh (webui
    /// post-create/post-open navigation). Empty or missing ids are
    /// ignored so the selection simply stays where it was.
    fn focus_workspace_by_id(&mut self, id: &str) {
        if id.is_empty() {
            return;
        }
        if let Some(index) = self.snapshot.workspaces.iter().position(|ws| ws.id == id) {
            self.selected_workspace = index;
            self.refresh_tail();
        }
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

    /// Webui `openWorktrees` (prefix W): browse the selected workspace
    /// folder like the webui "Open workspace or worktree" modal. The
    /// overlay lists the folder itself (Enter opens it as a workspace),
    /// the discovered worktrees (Enter opens), and the subdirectories
    /// (Enter descends, `o` opens as a workspace), all filterable.
    /// Without a workspace the webui falls back to the exploration
    /// default folder; the TUI uses the selected workspace cwd or home.
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
        self.worktree_browse(&cwd)
    }

    /// Webui `newWorkspace` (prefix `N`): open the browser overlay in
    /// "pick a folder" intent. Enter on the "this folder" row, a
    /// worktree row, or a folder row stages that path into the
    /// workspace name prompt (webui modal collects folder + name).
    pub fn workspace_pick_folder(&mut self) -> WorkspaceResult {
        self.worktree_pick_workspace = true;
        let result = self.worktree_list();
        if result.is_err() {
            self.worktree_pick_workspace = false;
        }
        result
    }

    /// Point the browser overlay at `path`: discover its worktrees and
    /// subdirectories, reset the cursor and filter, and open the overlay
    /// (staying in it when already open, e.g. while descending).
    pub fn worktree_browse(&mut self, path: &str) -> WorkspaceResult {
        let expanded = expand_tilde_path(path);
        let cwd = expanded.to_string_lossy().to_string();
        let result = self
            .client
            .list_worktrees(Some(&cwd))
            .map_err(|err| err.to_string())?;
        self.worktree_rows = result
            .get("worktrees")
            .and_then(Value::as_array)
            .map(|items| items.iter().map(WorktreeRow::from_json).collect())
            .unwrap_or_default();
        self.worktree_folder_rows = list_subdirectories(&expanded);
        self.worktree_selected = 0;
        self.worktree_filter.clear();
        self.worktree_root = cwd.clone();
        if self.mode != TuiMode::WorktreeList {
            self.open_overlay(TuiMode::WorktreeList);
        }
        Ok(format!(
            "browsing {} ({} worktrees, {} folders)",
            self.worktree_root,
            self.worktree_rows.len(),
            self.worktree_folder_rows.len()
        ))
    }

    /// Rows shown in the overlay, in display order: the browse root
    /// itself ("this folder"), the discovered worktrees, then the
    /// subdirectories of the root.
    pub fn browser_rows(&self) -> Vec<BrowserRow> {
        let mut rows = vec![BrowserRow::ThisFolder {
            path: self.worktree_root.clone(),
        }];
        rows.extend(self.worktree_rows.iter().cloned().map(BrowserRow::Worktree));
        rows.extend(self.worktree_folder_rows.iter().cloned());
        rows
    }

    /// Rows matching the typed filter (webui modal search over rows).
    /// The query matches paths, names, branches, and labels.
    pub fn filtered_browser_rows(&self) -> Vec<BrowserRow> {
        let query = self.worktree_filter.trim().to_ascii_lowercase();
        if query.is_empty() {
            return self.browser_rows();
        }
        self.browser_rows()
            .into_iter()
            .filter(|row| row.matches(&query))
            .collect()
    }

    /// Enter in the WorktreeList overlay: worktree rows open through
    /// `worktree.open`, folder rows descend into the folder, and the
    /// "this folder" row opens the browse root as a workspace. In
    /// pick mode (prefix `N`) Enter keeps descending folders (the
    /// tree stays navigable) and `o` stages any row for the
    /// workspace name prompt instead.
    pub fn worktree_enter_selected(&mut self) -> WorkspaceResult {
        let Some(row) = self
            .filtered_browser_rows()
            .get(self.worktree_selected)
            .cloned()
        else {
            return Err("no worktree selected".to_string());
        };
        if self.worktree_pick_workspace && !matches!(row, BrowserRow::Folder { .. }) {
            return self.worktree_stage_picked();
        }
        match row {
            BrowserRow::Folder { path, .. } => self.worktree_browse(&path),
            _ => self.worktree_open_selected(),
        }
    }

    /// Stage the selected row's path for the workspace name prompt
    /// (prefix `N` pick mode). Validates on disk like the typed-path
    /// flow (webui "workspace folder must exist") before chaining.
    fn worktree_stage_picked(&mut self) -> WorkspaceResult {
        let Some(row) = self
            .filtered_browser_rows()
            .get(self.worktree_selected)
            .cloned()
        else {
            return Err("no worktree selected".to_string());
        };
        let path = match &row {
            BrowserRow::ThisFolder { path } | BrowserRow::Folder { path, .. } => path.clone(),
            BrowserRow::Worktree(worktree) => worktree.path.clone(),
        };
        if path.is_empty() {
            return Err("worktree path missing".to_string());
        }
        let expanded = validate_workspace_folder(&path)?;
        self.workspace_create_stage = Some(WorkspaceCreateStage::Path(expanded.clone()));
        self.worktree_pick_workspace = false;
        self.close_overlay();
        self.prompt_input = Some(PromptInput::new(PromptKind::NewWorkspaceName));
        self.status = format!("workspace at {expanded}: type the name");
        Ok(format!("workspace path staged: {expanded}"))
    }

    /// Open the selected checkout through `worktree.open`. The backend
    /// focuses an already-open workspace instead of duplicating it (webui
    /// already-open parity), so it also covers plain folders opened as
    /// workspaces.
    pub fn worktree_open_selected(&mut self) -> WorkspaceResult {
        // The cursor indexes the filtered list, exactly like the webui
        // modal selection over its rendered rows.
        let Some(row) = self
            .filtered_browser_rows()
            .get(self.worktree_selected)
            .cloned()
        else {
            return Err("no worktree selected".to_string());
        };
        let path = match &row {
            BrowserRow::ThisFolder { path } | BrowserRow::Folder { path, .. } => path.clone(),
            BrowserRow::Worktree(worktree) => worktree.path.clone(),
        };
        if path.is_empty() {
            return Err("worktree path missing".to_string());
        }
        let title = row.title();
        // The webui's worktree opens go through `/api/worktrees/open`,
        // which records the opened path into recents server-side
        // (kind: worktree). The TUI opens through the backend socket,
        // so record here, best effort: a failed record must not fail
        // the open.
        let kind = match &row {
            BrowserRow::Worktree(_) => Some("worktree"),
            _ => Some("workspace"),
        };
        self.client
            .open_worktree(&path, None, None)
            .map_err(|err| err.to_string())?;
        let _ = self.web_api.record_recent_workspace(&path, None, kind);
        self.refresh().map_err(|err| err.to_string())?;
        // Focus the opened workspace like the webui post-open navigation;
        // the backend keys it by cwd, so resolve the id first.
        if let Some(id) = self
            .snapshot
            .workspaces
            .iter()
            .find(|ws| ws.cwd == path)
            .map(|ws| ws.id.clone())
        {
            self.focus_workspace_by_id(&id);
        }
        // Opening a worktree is a context switch (the webui navigates to
        // the new workspace), so it also drops any overlay stack.
        self.overlay_stack.clear();
        self.mode = TuiMode::Navigate;
        Ok(format!("opened {title}"))
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

    /// Keys inside the WorktreeList overlay: j/k move over the filtered
    /// rows, printable characters extend the type-to-filter query (same
    /// convention as the help overlay: j/k only move when the query is
    /// empty), Enter opens worktrees and the "this folder" row and
    /// descends into folders, `o` opens any row without descending, `h`
    /// goes to the parent folder, Esc closes (clearing the filter
    /// first). Arrows always move the cursor like the webui modal, which
    /// navigates its rows while the search box has text.
    pub(crate) fn handle_worktree_list_key(&mut self, key: KeyEvent) {
        let filter_active = !self.worktree_filter.is_empty();
        let len = self.filtered_browser_rows().len();
        match key.code {
            KeyCode::Esc => {
                if filter_active {
                    self.worktree_filter.clear();
                    self.worktree_selected = 0;
                } else {
                    // Closing the picker cancels the intent (prefix `N`
                    // chains to the name prompt only on Enter).
                    self.worktree_pick_workspace = false;
                    self.close_overlay();
                }
            }
            KeyCode::Enter => match self.worktree_enter_selected() {
                Ok(message) => self.status = message,
                Err(err) => self.status = err,
            },
            // `o` opens the selected row as a workspace even when it is
            // a folder (Enter on folders descends instead). In pick mode
            // (prefix `N`) `o` stages the row: Enter descends folders,
            // `o` picks them.
            KeyCode::Char('o') if !filter_active => {
                let result = if self.worktree_pick_workspace {
                    self.worktree_stage_picked()
                } else {
                    self.worktree_open_selected()
                };
                match result {
                    Ok(message) => self.status = message,
                    Err(err) => self.status = err,
                }
            }
            // `h` goes to the parent folder (vim/left convention shared
            // with the Files screen). Backspace on an empty filter does
            // the same so the two navigation reflexes agree.
            KeyCode::Char('h') | KeyCode::Backspace if !filter_active => {
                let parent = Path::new(&self.worktree_root)
                    .parent()
                    .map(|path| path.to_string_lossy().to_string())
                    .unwrap_or_default();
                if !parent.is_empty() {
                    match self.worktree_browse(&parent) {
                        Ok(message) => self.status = message,
                        Err(err) => self.status = err,
                    }
                }
            }
            KeyCode::Backspace if filter_active => {
                self.worktree_filter.pop();
                self.worktree_selected = 0;
                self.clamp_worktree_cursor();
            }
            // Arrows always move (webui modal parity): they are not query
            // letters, so an active filter must not swallow them.
            KeyCode::Down if len > 0 => {
                self.worktree_selected = (self.worktree_selected + 1) % len;
            }
            KeyCode::Up if len > 0 => {
                self.worktree_selected = (self.worktree_selected + len.saturating_sub(1)) % len;
            }
            // j/k are query letters while the filter is active.
            KeyCode::Char('j') if !filter_active && len > 0 => {
                self.worktree_selected = (self.worktree_selected + 1) % len;
            }
            KeyCode::Char('k') if !filter_active && len > 0 => {
                self.worktree_selected = (self.worktree_selected + len.saturating_sub(1)) % len;
            }
            KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.worktree_filter.clear();
                self.worktree_selected = 0;
            }
            KeyCode::Char(c) if !c.is_control() => {
                self.worktree_filter.push(c);
                self.worktree_selected = 0;
                self.clamp_worktree_cursor();
            }
            _ => {}
        }
    }

    /// Keep the worktree cursor inside the filtered list after the query
    /// changes its length (webui modal keeps its selection valid).
    fn clamp_worktree_cursor(&mut self) {
        let len = self.filtered_browser_rows().len();
        if self.worktree_selected >= len {
            self.worktree_selected = len.saturating_sub(1);
        }
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

    /// Label of the active panel (desktop `panelRenameInitialLabel`
    /// source; used to prefill the rename prompt).
    pub fn active_panel_label(&self) -> Option<String> {
        let tab_id = self.active_tab_id()?;
        self.snapshot
            .tabs
            .iter()
            .find(|tab| tab.id == tab_id)
            .map(|tab| tab.label.clone())
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

/// One row of the browser overlay: the browse root itself, a
/// discovered worktree, or a subdirectory of the root. Drives both the
/// cursor (they share one filtered list) and the render badges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserRow {
    /// The folder currently browsed (webui "Open as workspace").
    ThisFolder { path: String },
    /// A discovered worktree checkout (webui worktree row).
    Worktree(WorktreeRow),
    /// A subdirectory of the browse root (Enter descends, `o` opens).
    Folder { path: String, name: String },
}

impl BrowserRow {
    /// Row title used for the list line and open status message.
    pub fn title(&self) -> String {
        match self {
            Self::ThisFolder { path } => path.clone(),
            Self::Worktree(worktree) => worktree.title(),
            Self::Folder { name, .. } => name.clone(),
        }
    }

    /// Case-insensitive filter match over the row's display text
    /// (path, name, branch, label).
    pub fn matches(&self, query: &str) -> bool {
        let haystack = match self {
            Self::ThisFolder { path } => path.to_ascii_lowercase(),
            Self::Worktree(worktree) => {
                format!("{} {} {}", worktree.path, worktree.branch, worktree.label)
                    .to_ascii_lowercase()
            }
            Self::Folder { path, name } => format!("{path} {name}").to_ascii_lowercase(),
        };
        haystack.contains(query)
    }
}

/// Subdirectories of `root`, sorted by name, without `.` entries.
/// Read errors (missing or permission-denied folders) yield an empty
/// list so the overlay stays usable instead of failing to open.
pub(crate) fn list_subdirectories(root: &Path) -> Vec<BrowserRow> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut dirs: Vec<BrowserRow> = entries
        .flatten()
        .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                return None;
            }
            Some(BrowserRow::Folder {
                path: entry.path().to_string_lossy().to_string(),
                name,
            })
        })
        .collect();
    dirs.sort_by_key(|left| left.title());
    dirs
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
}

#[cfg(test)]
pub(crate) mod tests;
