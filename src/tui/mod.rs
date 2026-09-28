pub mod keys;
pub mod model;
pub mod panels;
pub mod render;
pub mod terminal;
pub mod theme;
pub mod web_api;
pub mod workspace;

#[cfg(test)]
pub mod tests;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::Value;

use crate::backend_client::{BackendClient, BackendClientError, TerminalOutput};
use crate::terminal_text::{self, StripCarriageReturn};
pub use keys::{PrefixState, Shortcut};
pub use model::{
    snapshot_summary, SidebarFocus, TuiAgent, TuiMode, TuiPane, TuiSnapshot, TuiTab, TuiWorkspace,
};
use model::{value_str, value_u64};
use panels::files::{content_rows, content_search, run_content_search, ContentRow, SearchKind};
use panels::git::{ConflictAction, ConflictResolveMode};
use panels::{FileExplorer, GitPanel, GitView};
pub use render::render;
use terminal::{terminal_output_styled_lines_lossy, TuiTextSpan};
use theme::Palette;
pub use theme::TuiTheme;
use web_api::WebApiClient;

impl PromptKind {
    /// Map the workspace-management prompt kinds onto the workspace
    /// module's own enum. File/git kinds never reach this conversion.
    pub(crate) fn into_workspace_prompt(self) -> workspace::WorkspacePrompt {
        match self {
            Self::NewWorkspace => workspace::WorkspacePrompt::NewWorkspace,
            Self::RenameWorkspace => workspace::WorkspacePrompt::RenameWorkspace,
            Self::RenamePanel => workspace::WorkspacePrompt::RenamePanel,
            Self::CreateWorktreeBranch => workspace::WorkspacePrompt::CreateWorktreeBranch,
            Self::CreateWorktreePath => workspace::WorkspacePrompt::CreateWorktreePath,
            Self::ConfirmCloseWorkspace => workspace::WorkspacePrompt::ConfirmCloseWorkspace,
            // File/git kinds have no workspace counterpart; map to the
            // harmless no-op closest to their intent.
            _ => workspace::WorkspacePrompt::ConfirmCloseWorkspace,
        }
    }
}

const TAIL_LINES: usize = 240;
const TERMINAL_RAW_BUFFER_BYTES: usize = 512 * 1024;

/// Max lines the Help overlay can scroll down: total rows minus whatever
/// fits in the 50-line centered box (title + border included).
fn help_max_scroll() -> usize {
    let rows = crate::tui::keys::help_rows().len();
    rows.saturating_sub(50usize.saturating_sub(4).saturating_sub(1))
}

/// Which main screen the TUI shows. Mirrors the WebUI workspace shell modes
/// (terminal, Git, Files) so the same workspace can be inspected from both
/// clients.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TuiScreen {
    Terminal,
    Files,
    Git,
}

impl TuiScreen {
    pub fn title(self) -> &'static str {
        match self {
            Self::Terminal => "Terminal",
            Self::Files => "Files",
            Self::Git => "Git",
        }
    }
}

#[derive(Debug, Clone)]
pub struct TuiOptions {
    pub session: Option<String>,
    pub api_socket: Option<PathBuf>,
    pub terminal_socket: Option<PathBuf>,
    pub refresh_interval: Duration,
    pub theme: TuiTheme,
    pub web_api: WebApiClient,
}

impl Default for TuiOptions {
    fn default() -> Self {
        Self {
            session: None,
            api_socket: None,
            terminal_socket: None,
            refresh_interval: Duration::from_millis(1000),
            theme: TuiTheme::from_env(),
            web_api: WebApiClient::new("127.0.0.1", 8787),
        }
    }
}

#[derive(Debug)]
pub struct TuiApp {
    pub client: BackendClient,
    pub web_api: WebApiClient,
    pub snapshot: TuiSnapshot,
    pub selected_workspace: usize,
    pub selected_agent: usize,
    pub sidebar_focus: SidebarFocus,
    /// Webui sidebar: KeyB collapses/expands the sidebar column.
    pub sidebar_collapsed: bool,
    /// Webui focusNext/focusPrev: walker position. When true, key input
    /// goes to the main screen instead of the sidebar list.
    pub main_focused: bool,
    pub mode: TuiMode,
    pub screen: TuiScreen,
    pub prefix: PrefixState,
    pub file_explorer: FileExplorer,
    pub git_panel: GitPanel,
    pub commit_input: Option<CommitInput>,
    pub prompt_input: Option<PromptInput>,
    pub pane_tail: Vec<String>,
    pub(crate) pane_tail_styles: Vec<Vec<TuiTextSpan>>,
    terminal_raw_output: String,
    terminal_raw_terminal_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub last_refresh: Option<Instant>,
    pub refresh_interval: Duration,
    pub theme: TuiTheme,
    pub(crate) palette: Palette,
    pub tick: u64,
    /// Two-step worktree creation: branch typed first, then checkout path.
    pub worktree_create_stage: Option<workspace::WorktreeCreateStage>,
    /// Rebase upstream typed into the RebaseUpstream prompt; consumed by
    /// the follow-up typed confirm (webui rebase modal two-step).
    pub rebase_pending_upstream: Option<String>,
    /// Vertical scroll of the Help overlay (j/k when help is open).
    pub help_scroll: usize,
    /// Mode the user was in when the quit overlay opened; restored on cancel.
    pub(crate) quit_prev_mode: TuiMode,
    dirty: bool,
}

/// Commit message input state. Opened with the commit shortcut; typed text
/// becomes the commit title until Enter commits it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInput {
    pub text: String,
    pub amend: bool,
}

/// A modal text prompt. Used for file rename and for typing `y` to confirm
/// destructive actions (file delete, branch delete, stash drop).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptInput {
    pub kind: PromptKind,
    pub text: String,
}

impl PromptInput {
    pub fn new(kind: PromptKind) -> Self {
        Self {
            kind,
            text: String::new(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptKind {
    RenameFile,
    ConfirmDeleteFile,
    ConfirmDeleteBranch,
    ConfirmDropStash,
    NewWorkspace,
    RenameWorkspace,
    RenamePanel,
    CreateWorktreeBranch,
    CreateWorktreePath,
    ConfirmCloseWorkspace,
    ConfirmCleanupDelete,
    /// Log view: tag name for the selected commit (webui tag modal).
    CreateTag,
    /// Log view: reset mode text (soft/mixed/hard) for the selected
    /// commit (webui reset modal). `hard` chains into a typed confirm.
    ResetMode,
    /// Log view: typed `y` guard for a hard reset (webui asks for
    /// "reset hard"; the server double-checks the same string).
    ConfirmResetHard,
    /// Log view: rebase upstream ref for the selected commit (webui
    /// rebase modal). Chains into `ConfirmRebase`'s typed `y`.
    RebaseUpstream,
    /// Log view: typed `y` guard that runs the rebase staged by
    /// `RebaseUpstream` (the webui modal has both fields at once;
    /// the TUI prompts sequentially).
    ConfirmRebase,
    /// Git cwd picker (prefix I): type a repo path, Enter switches the
    /// git panel to it (webui location bar).
    GitCwd,
    /// Branches view: create a new branch from the typed name
    /// (webui `git_switch` with create: true).
    CreateBranch,
    /// Files screen `a`: new empty file under the current root
    /// (webui mobile new-file flow; desktop has no default key).
    CreateFile,
    /// Files screen `A`: new directory. No mkdir endpoint exists, so
    /// this writes a `.gitkeep` marker inside (documented deviation).
    CreateDirectory,
    /// Edit mode Ctrl+H: replacement text for the current editor find
    /// match. A trailing `!` replaces all matches instead of the
    /// selected one (documented deviation from the webui replace bar,
    /// which has separate replace/replace-all buttons).
    ReplaceInFile,
}

impl PromptKind {
    /// Destructive prompts only submit when the typed text is exactly `y`.
    pub fn needs_confirm(self) -> bool {
        matches!(
            self,
            Self::ConfirmDeleteFile
                | Self::ConfirmDeleteBranch
                | Self::ConfirmDropStash
                | Self::ConfirmCloseWorkspace
                | Self::ConfirmCleanupDelete
                | Self::ConfirmResetHard
                | Self::ConfirmRebase
        )
    }

    pub fn title(self) -> &'static str {
        match self {
            Self::RenameFile => "Rename file",
            Self::ConfirmDeleteFile => "Delete file",
            Self::ConfirmDeleteBranch => "Delete branch",
            Self::ConfirmDropStash => "Drop stash",
            Self::NewWorkspace => "New workspace path",
            Self::RenameWorkspace => "Rename workspace",
            Self::RenamePanel => "Rename panel",
            Self::CreateWorktreeBranch => "Create worktree: branch",
            Self::CreateWorktreePath => "Create worktree: checkout path",
            Self::ConfirmCloseWorkspace => "Close workspace (y)",
            Self::ConfirmCleanupDelete => "Delete cleanup item (y)",
            Self::CreateTag => "Tag commit",
            Self::ResetMode => "Reset to commit",
            Self::ConfirmResetHard => "Hard reset (y)",
            Self::RebaseUpstream => "Rebase: upstream ref",
            Self::ConfirmRebase => "Rebase (y)",
            Self::GitCwd => "Git directory",
            Self::CreateBranch => "Create branch",
            Self::CreateFile => "New file",
            Self::CreateDirectory => "New directory",
            Self::ReplaceInFile => "Replace in file",
        }
    }

    /// Hint shown under the input line.
    pub fn hint(self) -> &'static str {
        match self {
            Self::RenameFile => "type the new name, Enter renames",
            Self::NewWorkspace => "type a directory path, Enter opens it",
            Self::RenameWorkspace | Self::RenamePanel => "type the new name, Enter renames",
            Self::CreateWorktreeBranch => "type the branch name, Enter continues",
            Self::CreateWorktreePath => "type the checkout path, Enter creates",
            Self::CreateTag => "type the tag name, Enter tags the selected commit",
            Self::ResetMode => "type soft, mixed or hard, Enter resets",
            Self::RebaseUpstream => "type the upstream ref, then y + Enter to rebase",
            Self::GitCwd => "type a repository path, Enter switches the git panel",
            Self::CreateBranch => "type the branch name, Enter creates and switches",
            Self::CreateFile => "type the file name, Enter creates an empty file",
            Self::CreateDirectory => "type the directory name, Enter creates it",
            Self::ReplaceInFile => {
                "type the replacement, Enter replaces the current match (! = all)"
            }
            _ => "type y then Enter to confirm, Esc cancels",
        }
    }
}

impl TuiApp {
    pub fn new(client: BackendClient, refresh_interval: Duration) -> Self {
        Self::new_with_theme(client, refresh_interval, TuiTheme::Dark)
    }

    pub fn new_with_theme(
        client: BackendClient,
        refresh_interval: Duration,
        theme: TuiTheme,
    ) -> Self {
        Self::new_with_options(
            client,
            refresh_interval,
            theme,
            WebApiClient::new("127.0.0.1", 8787),
        )
    }

    pub fn new_with_options(
        client: BackendClient,
        refresh_interval: Duration,
        theme: TuiTheme,
        web_api: WebApiClient,
    ) -> Self {
        let cwd = "";
        Self {
            client,
            web_api,
            snapshot: TuiSnapshot::default(),
            selected_workspace: 0,
            selected_agent: 0,
            sidebar_focus: SidebarFocus::Workspaces,
            sidebar_collapsed: false,
            main_focused: true,
            mode: TuiMode::Navigate,
            screen: TuiScreen::Terminal,
            prefix: PrefixState::new(),
            file_explorer: FileExplorer::new(cwd),
            git_panel: GitPanel::new(cwd),
            commit_input: None,
            prompt_input: None,
            pane_tail: Vec::new(),
            pane_tail_styles: Vec::new(),
            terminal_raw_output: String::new(),
            terminal_raw_terminal_id: None,
            status: "connecting".to_string(),
            error: None,
            last_refresh: None,
            refresh_interval,
            theme,
            palette: Palette::for_theme(theme),
            tick: 0,
            worktree_create_stage: None,
            rebase_pending_upstream: None,
            help_scroll: 0,
            quit_prev_mode: TuiMode::Navigate,
            dirty: true,
        }
    }

    pub fn refresh(&mut self) -> Result<(), BackendClientError> {
        let first_refresh = self.last_refresh.is_none();
        let ping = self.client.ping()?;
        let snapshot = self.client.snapshot()?;
        self.snapshot = TuiSnapshot::from_backend_response(&snapshot);
        if first_refresh {
            self.select_focused_items();
        }
        self.clamp_selection();
        if self.mode != TuiMode::Attach {
            self.refresh_tail();
        }
        self.status = format!(
            "backend {} · protocol {} · {} workspaces · {} agents",
            value_str(&ping, &["version"]).unwrap_or("built-in"),
            value_u64(&ping, &["protocol"]).unwrap_or_default(),
            self.snapshot.workspaces.len(),
            self.snapshot.agents.len(),
        );
        self.error = None;
        self.last_refresh = Some(Instant::now());
        self.mark_dirty();
        Ok(())
    }

    pub fn refresh_if_due(&mut self) {
        self.tick = self.tick.wrapping_add(1);
        let due = self
            .last_refresh
            .map(|loaded| loaded.elapsed() >= self.refresh_interval)
            .unwrap_or(true);
        if due {
            if let Err(err) = self.refresh() {
                self.error = Some(err.to_string());
                self.mark_dirty();
            }
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> bool {
        // The Ctrl+B prefix wins everywhere, including attach mode, exactly
        // like the WebUI shortcut overlay wins over terminal input.
        if let Some(shortcut) = self.prefix.feed(key) {
            self.run_shortcut(shortcut);
            self.mark_dirty();
            return false;
        }
        if self.prefix.is_armed() {
            self.mark_dirty();
            return false;
        }
        if self.commit_input.is_some() {
            self.handle_commit_key(key);
            self.mark_dirty();
            return false;
        }
        if self.prompt_input.is_some() {
            self.handle_prompt_key(key);
            self.mark_dirty();
            return false;
        }
        match self.mode {
            TuiMode::Help => match key.code {
                KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q') => {
                    self.mode = TuiMode::Navigate;
                    self.help_scroll = 0;
                }
                KeyCode::Char('j') | KeyCode::Down | KeyCode::PageDown => {
                    self.help_scroll = self.help_scroll.saturating_add(1).min(help_max_scroll());
                }
                KeyCode::Char('k') | KeyCode::Up | KeyCode::PageUp => {
                    self.help_scroll = self.help_scroll.saturating_sub(1);
                }
                _ => {}
            },
            TuiMode::ConfirmQuit => match key.code {
                // y/Enter confirm the quit; n/Esc/q cancel back to the
                // previous mode. Ctrl+C also confirms (the classic "I
                // really want out" reflex key).
                KeyCode::Char('y') | KeyCode::Enter => self.status = "quit".to_string(),
                KeyCode::Char('n') | KeyCode::Esc | KeyCode::Char('q') => self.cancel_quit(),
                _ if key.modifiers.contains(KeyModifiers::CONTROL)
                    && key.code == KeyCode::Char('c') =>
                {
                    self.status = "quit".to_string();
                }
                _ => {}
            },
            TuiMode::Settings => match key.code {
                KeyCode::Esc | KeyCode::Char('q') | KeyCode::Char('s') => {
                    self.mode = TuiMode::Navigate;
                }
                // Theme cycle (webui settings theme select).
                KeyCode::Char('t') | KeyCode::Tab => {
                    self.theme = self.theme.next();
                    self.status = format!("theme: {}", self.theme.label());
                }
                _ => {}
            },
            TuiMode::Navigate => self.handle_navigation_key(key),
            TuiMode::Attach => {
                if self.screen == TuiScreen::Terminal {
                    self.handle_attach_key(key);
                } else {
                    self.handle_panel_key(key);
                }
            }
        }
        self.mark_dirty();
        false
    }

    fn handle_prompt_key(&mut self, key: KeyEvent) {
        let Some(prompt) = self.prompt_input.as_mut() else {
            return;
        };
        match key.code {
            KeyCode::Esc => self.prompt_input = None,
            KeyCode::Enter => {
                let kind = prompt.kind;
                let text = prompt.text.trim().to_string();
                self.prompt_input = None;
                if kind.needs_confirm() && text != "y" {
                    self.status = "cancelled".to_string();
                    return;
                }
                self.run_prompt_action(kind, &text);
            }
            KeyCode::Backspace => {
                prompt.text.pop();
            }
            KeyCode::Char(ch) => {
                if key.modifiers.contains(KeyModifiers::CONTROL) && ch.eq_ignore_ascii_case(&'u') {
                    prompt.text.clear();
                } else {
                    prompt.text.push(ch);
                }
            }
            _ => {}
        }
    }

    fn run_prompt_action(&mut self, kind: PromptKind, text: &str) {
        match kind {
            PromptKind::RenameFile => {
                let Some(entry) = self.file_explorer.selected_entry() else {
                    self.error = Some("no file selected".to_string());
                    return;
                };
                let path = entry.path.clone();
                match self
                    .web_api
                    .file_rename(&self.file_explorer.cwd, &path, text)
                {
                    Ok(_) => {
                        self.status = format!("renamed to {text}");
                        if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                            self.error = Some(err.to_string());
                        }
                    }
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            PromptKind::ConfirmDeleteFile => {
                let Some(entry) = self.file_explorer.selected_entry() else {
                    self.error = Some("no file selected".to_string());
                    return;
                };
                let path = entry.path.clone();
                match self.web_api.file_delete(&self.file_explorer.cwd, &path) {
                    Ok(_) => {
                        self.status = format!("deleted {path}");
                        if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                            self.error = Some(err.to_string());
                        }
                    }
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            PromptKind::ConfirmDeleteBranch => {
                let Some(branch) = self
                    .git_panel
                    .branches
                    .get(self.git_panel.branch_selected)
                    .filter(|entry| !entry.current)
                    .map(|entry| entry.name.clone())
                else {
                    self.error = Some("no branch selected".to_string());
                    return;
                };
                match self.git_panel.delete_branch(&self.web_api, &branch, false) {
                    Ok(_) => self.status = format!("deleted branch {branch}"),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            PromptKind::ConfirmDropStash => match self.git_panel.stash_drop(&self.web_api) {
                Ok(_) => self.status = "stash dropped".to_string(),
                Err(err) => self.error = Some(err.to_string()),
            },
            PromptKind::NewWorkspace
            | PromptKind::RenameWorkspace
            | PromptKind::RenamePanel
            | PromptKind::CreateWorktreeBranch
            | PromptKind::CreateWorktreePath
            | PromptKind::ConfirmCloseWorkspace => {
                let kind = kind.into_workspace_prompt();
                workspace::run_prompt(self, &kind, text);
            }
            PromptKind::ConfirmCleanupDelete => match self.git_panel.selected_cleanup_item() {
                Some(item) => match self.git_panel.cleanup_delete(&self.web_api, &item) {
                    Ok(()) => self.status = format!("deleted {} {}", item.kind.label(), item.name),
                    Err(err) => self.error = Some(err.to_string()),
                },
                None => self.error = Some("no cleanup item selected".to_string()),
            },
            PromptKind::CreateTag => {
                let tag = text.trim();
                if tag.is_empty() {
                    self.error = Some("type a tag name".to_string());
                } else {
                    match self.git_panel.log_tag(&self.web_api, tag) {
                        Ok(()) => self.status = format!("tagged {tag}"),
                        Err(err) => self.error = Some(err.to_string()),
                    }
                }
            }
            PromptKind::ResetMode => {
                let mode = text.trim();
                match mode {
                    "soft" | "mixed" => match self.git_panel.log_reset(&self.web_api, mode) {
                        Ok(()) => self.status = format!("reset {mode}"),
                        Err(err) => self.error = Some(err.to_string()),
                    },
                    // Hard reset chains into the typed-y confirm; the
                    // server independently requires "reset hard".
                    "hard" => {
                        self.prompt_input = Some(PromptInput::new(PromptKind::ConfirmResetHard));
                        self.status = PromptKind::ConfirmResetHard.title().to_string();
                    }
                    _ => self.error = Some("type soft, mixed or hard".to_string()),
                }
            }
            PromptKind::ConfirmResetHard => match self.git_panel.log_reset(&self.web_api, "hard") {
                Ok(()) => self.status = "reset hard".to_string(),
                Err(err) => self.error = Some(err.to_string()),
            },
            PromptKind::RebaseUpstream => {
                let upstream = text.trim();
                if upstream.is_empty() {
                    self.error = Some("type the upstream ref".to_string());
                } else {
                    self.rebase_pending_upstream = Some(upstream.to_string());
                    self.prompt_input = Some(PromptInput::new(PromptKind::ConfirmRebase));
                    self.status = PromptKind::ConfirmRebase.title().to_string();
                }
            }
            PromptKind::ConfirmRebase => {
                let Some(upstream) = self.rebase_pending_upstream.take() else {
                    self.error = Some("no rebase pending".to_string());
                    return;
                };
                match self.git_panel.log_rebase(&self.web_api, &upstream) {
                    Ok(()) => self.status = format!("rebase onto {upstream}"),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            PromptKind::GitCwd => {
                let path = text.trim();
                if path.is_empty() {
                    self.error = Some("type a directory path".to_string());
                } else {
                    self.git_panel.set_cwd(path);
                    if let Err(err) = self.git_panel.refresh_view(&self.web_api) {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = format!("git cwd: {path}");
                    }
                }
            }
            PromptKind::CreateBranch => {
                let branch = text.trim();
                if branch.is_empty() {
                    self.error = Some("type a branch name".to_string());
                } else {
                    let cwd = self.git_panel.cwd.clone();
                    match self.web_api.git_switch(&cwd, branch, true) {
                        Ok(_) => {
                            self.status = format!("switched to {branch}");
                            if let Err(err) = self.git_panel.refresh_view(&self.web_api) {
                                self.error = Some(err.to_string());
                            }
                        }
                        Err(err) => self.error = Some(err.to_string()),
                    }
                }
            }
            PromptKind::CreateFile => {
                if text.trim().is_empty() {
                    self.error = Some("type a file name".to_string());
                } else {
                    match self.file_explorer.create_file(&self.web_api, text.trim()) {
                        Ok(()) => {
                            self.status = format!("created {}", text.trim());
                            // Webui opens the new file right away.
                            if let Err(err) = self.file_explorer.open_preview(&self.web_api) {
                                self.error = Some(err.to_string());
                            }
                        }
                        Err(err) => self.error = Some(err.to_string()),
                    }
                }
            }
            PromptKind::CreateDirectory => {
                if text.trim().is_empty() {
                    self.error = Some("type a directory name".to_string());
                } else {
                    match self
                        .file_explorer
                        .create_directory(&self.web_api, text.trim())
                    {
                        Ok(()) => self.status = format!("created {}", text.trim()),
                        Err(err) => self.error = Some(err.to_string()),
                    }
                }
            }
            PromptKind::ReplaceInFile => {
                // `!` suffix = replace all (documented deviation).
                let (replacement, all) = match text.strip_suffix('!') {
                    Some(head) => (head.to_string(), true),
                    None => (text.to_string(), false),
                };
                let count = self.file_explorer.editor_find.ranges.len();
                match self.file_explorer.editor_replace(&replacement, all) {
                    Ok(()) => {
                        self.status = if all {
                            format!("replaced {count} matches")
                        } else {
                            format!("replaced 1 of {count} matches")
                        };
                        // Stay in edit mode with the find bar alive so
                        // Ctrl+S persists and Enter keeps cycling.
                        self.file_explorer.edit_active = true;
                    }
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
        }
    }

    /// Keys while content-search results are visible (webui results
    /// view): j/k walk the flat rows, Enter opens the match (or toggles
    /// a file group), `+` appends the next page, `A`/`X` flip the
    /// match-case/regex toggles and re-run, Esc clears the results.
    fn handle_content_search_key(&mut self, key: KeyEvent) {
        let rows = content_rows(&self.file_explorer.content_search);
        let len = rows.len();
        let state = &mut self.file_explorer.content_search;
        match key.code {
            KeyCode::Char('j') | KeyCode::Down => {
                state.selected = move_index(state.selected, len, 1);
            }
            KeyCode::Char('k') | KeyCode::Up => {
                state.selected = move_index(state.selected, len, -1);
            }
            KeyCode::Enter => {
                let selected = state.selected;
                match rows.get(selected) {
                    Some(ContentRow::File(index)) => {
                        let index = *index;
                        content_search::toggle_content_file(state, index);
                    }
                    Some(ContentRow::Line { file, line, .. }) => {
                        let path = state.files[*file].path.clone();
                        let line = *line;
                        if let Err(err) =
                            self.file_explorer
                                .open_preview_at_line(&self.web_api, &path, line)
                        {
                            self.error = Some(err.to_string());
                        } else {
                            self.status = format!("{path}:{line}");
                        }
                    }
                    None => {}
                }
            }
            // Load more files (webui `loadMore`, appending at the offset).
            KeyCode::Char('+') => {
                let done = state.done;
                if !done {
                    if let Err(err) =
                        run_content_search(&mut self.file_explorer, &self.web_api, true)
                    {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = "loaded more results".to_string();
                    }
                } else {
                    self.status = "no more results".to_string();
                }
            }
            // Match-case toggle (webui setting `fileContentSearchMatchCase`);
            // no default webui key: A/X are the TUI bindings, documented.
            KeyCode::Char('A') => {
                state.match_case = !state.match_case;
                self.rerun_content_search();
            }
            // Regex toggle (webui setting `fileContentSearchRegex`).
            KeyCode::Char('X') => {
                state.regex = !state.regex;
                self.rerun_content_search();
            }
            // Clear the results and go back to the tree.
            KeyCode::Esc => {
                state.clear_results();
                self.file_explorer.search_mode = false;
                self.file_explorer.filter.clear();
                self.status = "content search closed".to_string();
                if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            _ => {}
        }
    }

    /// Re-run the content search after a toggle flip (fresh, offset 0).
    fn rerun_content_search(&mut self) {
        match run_content_search(&mut self.file_explorer, &self.web_api, false) {
            Ok(()) => {
                self.status = format!(
                    "search re-run: match-case {}, regex {}",
                    self.file_explorer.content_search.match_case,
                    self.file_explorer.content_search.regex
                )
            }
            Err(err) => self.error = Some(err.to_string()),
        }
    }

    /// Keys while the editor find bar is active (webui find toolbar).
    fn handle_editor_find_key(&mut self, key: KeyEvent) {
        let shift = key
            .modifiers
            .contains(crossterm::event::KeyModifiers::SHIFT);
        match key.code {
            KeyCode::Esc => {
                self.file_explorer.editor_find_close();
                self.status = "find closed".to_string();
            }
            KeyCode::Enter => {
                self.file_explorer.editor_find_next(!shift);
                let count = self.file_explorer.editor_find.ranges.len();
                self.status = if count == 0 {
                    "no matches".to_string()
                } else {
                    format!(
                        "match {}/{}",
                        self.file_explorer.editor_find.selected + 1,
                        count
                    )
                };
            }
            KeyCode::Backspace => self.file_explorer.pop_find_char(),
            // Match-case / regex toggles (webui toolbar checkboxes).
            KeyCode::Char('A') => {
                self.file_explorer.editor_find.match_case =
                    !self.file_explorer.editor_find.match_case;
                self.file_explorer.refresh_find();
            }
            KeyCode::Char('X') => {
                self.file_explorer.editor_find.regex = !self.file_explorer.editor_find.regex;
                self.file_explorer.refresh_find();
            }
            KeyCode::Char(ch) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                self.file_explorer.push_find_char(ch);
            }
            _ => {}
        }
    }

    fn handle_commit_key(&mut self, key: KeyEvent) {
        let Some(commit) = self.commit_input.as_mut() else {
            return;
        };
        match key.code {
            KeyCode::Enter => {
                let text = commit.text.trim().to_string();
                let amend = commit.amend;
                self.commit_input = None;
                if text.is_empty() {
                    self.error = Some("commit message is empty".to_string());
                    return;
                }
                match self.git_panel.commit(&self.web_api, &text, amend) {
                    Ok(()) => self.status = format!("committed: {text}"),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Esc => self.commit_input = None,
            KeyCode::Backspace => {
                commit.text.pop();
            }
            KeyCode::Char(ch) => {
                if key.modifiers.contains(KeyModifiers::CONTROL) && ch.eq_ignore_ascii_case(&'u') {
                    commit.text.clear();
                } else {
                    commit.text.push(ch);
                }
            }
            _ => {}
        }
    }

    fn run_shortcut(&mut self, shortcut: Shortcut) {
        match shortcut {
            Shortcut::Help => {
                self.mode = TuiMode::Help;
                self.help_scroll = 0;
            }
            Shortcut::Files => self.open_files_screen(),
            Shortcut::Git => self.open_git_screen(),
            Shortcut::Terminal => self.screen = TuiScreen::Terminal,
            Shortcut::Search => {
                if self.screen == TuiScreen::Files {
                    self.file_explorer.start_filter();
                    self.status = "file filter".to_string();
                }
            }
            Shortcut::Refresh => self.refresh_active_screen(),
            Shortcut::NextWorkspace => self.move_selection(1),
            Shortcut::PrevWorkspace => self.move_selection(-1),
            Shortcut::NextAgent => {
                self.sidebar_focus = SidebarFocus::Agents;
                self.move_selection(1);
            }
            Shortcut::PrevAgent => {
                self.sidebar_focus = SidebarFocus::Agents;
                self.move_selection(-1);
            }
            Shortcut::NewTab => self.create_tab(),
            Shortcut::CloseTab => self.close_selected_tab(),
            Shortcut::NextPanel => {
                let result = self.move_panel(1);
                self.workspace_status(result);
            }
            Shortcut::PrevPanel => {
                let result = self.move_panel(-1);
                self.workspace_status(result);
            }
            Shortcut::NewWorkspace => {
                self.prompt_input = Some(PromptInput::new(PromptKind::NewWorkspace));
                self.status = PromptKind::NewWorkspace.title().to_string();
            }
            Shortcut::OpenWorktrees => {
                let result = self.worktree_list();
                self.workspace_status(result);
            }
            Shortcut::CreateWorktree => {
                self.worktree_create_stage = None;
                self.prompt_input = Some(PromptInput::new(PromptKind::CreateWorktreeBranch));
                self.status = PromptKind::CreateWorktreeBranch.title().to_string();
            }
            Shortcut::CloseWorkspace => {
                self.prompt_input = Some(PromptInput::new(PromptKind::ConfirmCloseWorkspace));
                self.status = PromptKind::ConfirmCloseWorkspace.title().to_string();
            }
            Shortcut::RemoveWorktree => {
                let result = self.remove_worktree();
                self.workspace_status(result);
            }
            Shortcut::RenamePanel => {
                self.prompt_input = Some(PromptInput::new(PromptKind::RenamePanel));
                self.status = PromptKind::RenamePanel.title().to_string();
            }
            Shortcut::RenameWorkspace => {
                self.prompt_input = Some(PromptInput::new(PromptKind::RenameWorkspace));
                self.status = PromptKind::RenameWorkspace.title().to_string();
            }
            Shortcut::GitCwdPicker => {
                // Prefix I: switch the git panel to a typed repo path
                // (webui location bar; no webui default binding).
                self.open_git_screen();
                self.prompt_input = Some(PromptInput::new(PromptKind::GitCwd));
                self.status = PromptKind::GitCwd.title().to_string();
            }
            Shortcut::Settings => {
                // Prefix s: settings overlay (webui settings modal).
                self.mode = TuiMode::Settings;
            }
            Shortcut::Sidebar => {
                // Prefix Shift+B: collapse/expand the sidebar column
                // (webui sidebar: KeyB).
                self.sidebar_collapsed = !self.sidebar_collapsed;
                self.status = if self.sidebar_collapsed {
                    "sidebar hidden".to_string()
                } else {
                    "sidebar shown".to_string()
                };
            }
            Shortcut::FocusNext => self.walk_focus(1),
            Shortcut::FocusPrev => self.walk_focus(-1),
            Shortcut::TempTerminalToggle => {
                let result = self.temp_terminal_toggle();
                self.workspace_status(result);
            }
            Shortcut::TempTerminalPromote => {
                let result = self.temp_terminal_promote();
                self.workspace_status(result);
            }
            Shortcut::Quit => self.request_quit(),
            Shortcut::GitChanges => {
                self.open_git_screen();
                self.git_panel.view = GitView::Changes;
                self.refresh_active_screen();
            }
            Shortcut::GitCommit => {
                self.open_git_screen();
                self.commit_input = Some(CommitInput {
                    text: String::new(),
                    amend: false,
                });
                self.status = "commit: type message, Enter commits".to_string();
            }
            Shortcut::EditFile => {
                // Webui parity: prefix then e edits the current file. On the
                // Files screen that is the open preview; on Git it is the
                // file selected in the Changes list.
                if self.screen == TuiScreen::Files {
                    match self.file_explorer.start_edit() {
                        Ok(()) => self.status = "editing: Ctrl-S saves, Esc stops".to_string(),
                        Err(err) => self.error = Some(err.to_string()),
                    }
                } else {
                    self.open_git_screen();
                    self.git_panel.view = GitView::Changes;
                    let file = self
                        .git_panel
                        .selected_file()
                        .map(|entry| entry.path.clone());
                    let Some(file) = file else {
                        self.error = Some("no file selected in git changes".to_string());
                        return;
                    };
                    // A dirty buffer is not silently replaced: the webui
                    // keeps dirty editor tabs, so ask the user to save or
                    // reload first.
                    if self.file_explorer.preview.dirty
                        && self.file_explorer.preview.path.as_deref() != Some(file.as_str())
                    {
                        self.status =
                            "unsaved edits: save or reload before editing another file".to_string();
                        return;
                    }
                    match self.web_api.file_read(&self.git_panel.cwd, &file) {
                        Ok(data) => {
                            let content = data.get("content").and_then(Value::as_str).unwrap_or("");
                            let binary =
                                data.get("binary").and_then(Value::as_bool).unwrap_or(false);
                            let truncated = data
                                .get("truncated")
                                .and_then(Value::as_bool)
                                .unwrap_or(false);
                            // Rebuild the explorer for the git cwd so the
                            // tree, cwd, and preview all describe the same
                            // directory; reusing the old explorer would
                            // leave stale entries resolved against the new
                            // cwd.
                            let mut explorer =
                                crate::tui::panels::FileExplorer::new(&self.git_panel.cwd);
                            // Best effort: a failed tree refresh leaves an
                            // empty tree but keeps cwd and preview aligned.
                            if let Err(err) = explorer.refresh(&self.web_api) {
                                self.error = Some(err.to_string());
                            }
                            explorer.preview = crate::tui::panels::FilePreview {
                                path: Some(file),
                                content: content.to_string(),
                                truncated,
                                binary,
                                hash: data
                                    .get("hash")
                                    .and_then(Value::as_str)
                                    .unwrap_or_default()
                                    .to_string(),
                                dirty: false,
                            };
                            // start_edit re-checks binary/truncated and
                            // reports "binary file cannot be edited" /
                            // "truncated file cannot be edited safely".
                            match explorer.start_edit() {
                                Ok(()) => {
                                    self.status = "editing: Ctrl-S saves, Esc stops".to_string()
                                }
                                Err(err) => self.error = Some(err.to_string()),
                            }
                            self.screen = TuiScreen::Files;
                            self.file_explorer = explorer;
                        }
                        Err(err) => self.error = Some(err.to_string()),
                    }
                }
            }
            Shortcut::GitLog => {
                self.open_git_screen();
                self.git_panel.view = GitView::Log;
                // Keep an existing file scope (webui `logFilePath`) when
                // re-opening the Log view.
                self.refresh_active_screen();
            }
            Shortcut::GitStash => {
                self.open_git_screen();
                self.git_panel.view = GitView::Stash;
                self.refresh_active_screen();
            }
            Shortcut::GitFileHistory => {
                // Webui `history: KeyH`: list commits touching the file
                // selected in Changes.
                self.open_git_screen();
                if self.git_panel.view != GitView::Changes {
                    self.git_panel.view = GitView::Changes;
                    self.refresh_active_screen();
                }
                if self.git_panel.selected_file().is_none() {
                    self.error = Some("no file selected in git changes".to_string());
                    return;
                }
                self.git_panel.view = GitView::History;
                self.refresh_active_screen();
                let file = self.git_panel.history_file.clone().unwrap_or_default();
                self.status = format!("history: {file}");
            }
            Shortcut::GitChangesBack => {
                // Webui `compare: KeyO`: return to the current changes view.
                self.open_git_screen();
                self.git_panel.view = GitView::Changes;
                self.refresh_active_screen();
            }
            Shortcut::GitBlame => {
                // Webui `blame: KeyM`: toggle author annotations on the
                // diff lines of the selected file.
                self.open_git_screen();
                if self.git_panel.view != GitView::Changes {
                    self.git_panel.view = GitView::Changes;
                    self.refresh_active_screen();
                }
                match self.git_panel.toggle_blame(&self.web_api) {
                    Ok(()) => {
                        self.status = if self.git_panel.show_blame {
                            "blame on".to_string()
                        } else {
                            "blame off".to_string()
                        };
                    }
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            Shortcut::GitBranch => {
                self.open_git_screen();
                self.git_panel.view = GitView::Branches;
                self.refresh_active_screen();
            }
            Shortcut::GitSwitchBranch => {
                self.open_git_screen();
                self.git_panel.view = GitView::Branches;
                self.refresh_active_screen();
                let selected = self.git_panel.branch_selected;
                let Some(branch) = self
                    .git_panel
                    .branches
                    .get(selected)
                    .filter(|entry| !entry.current)
                    .map(|entry| entry.name.clone())
                else {
                    return;
                };
                match self.git_panel.switch_branch(&self.web_api, &branch) {
                    Ok(()) => self.status = format!("switched to {branch}"),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            Shortcut::GitStageAll => self.run_git_action(|panel, api| panel.toggle_stage_all(api)),
            Shortcut::GitStageFile => self.run_git_action(|panel, api| panel.stage_selected(api)),
            Shortcut::GitUnstageFile => {
                self.run_git_action(|panel, api| panel.unstage_selected(api))
            }
            Shortcut::GitDiscardFile => {
                // Discarding the file under edit while its buffer is
                // dirty would silently fork it from disk.
                let selected_path = self
                    .git_panel
                    .selected_file()
                    .map(|entry| entry.path.clone());
                if self.file_explorer.preview.dirty
                    && selected_path.is_some_and(|path| {
                        self.file_explorer.preview.path.as_deref() == Some(path.as_str())
                    })
                {
                    self.error = Some(
                        "unsaved edits: save or reload before discarding this file".to_string(),
                    );
                } else {
                    self.run_git_action(|panel, api| panel.discard_selected(api));
                }
            }
            Shortcut::GitStashFile => self.run_git_action(|panel, api| panel.stash_changes(api)),
            Shortcut::GitPush => self.run_git_action(|panel, api| panel.push(api)),
        }
    }

    /// Open the quit confirmation overlay. Remembers the mode to restore
    /// when the user cancels.
    fn request_quit(&mut self) {
        self.quit_prev_mode = self.mode;
        self.mode = TuiMode::ConfirmQuit;
        self.status = "quit? y confirms · Esc cancels".to_string();
    }

    /// Cancel the quit overlay and return to the mode the user was in.
    fn cancel_quit(&mut self) {
        self.mode = self.quit_prev_mode;
        self.status = "quit cancelled".to_string();
    }

    fn run_git_action(
        &mut self,
        action: impl FnOnce(
            &mut GitPanel,
            &WebApiClient,
        ) -> Result<(), crate::tui::web_api::WebApiError>,
    ) {
        self.open_git_screen();
        self.git_panel.view = GitView::Changes;
        if let Err(err) = action(&mut self.git_panel, &self.web_api) {
            self.error = Some(err.to_string());
        }
    }

    fn create_tab(&mut self) {
        let Some(workspace) = self
            .selected_workspace()
            .map(|workspace| workspace.id.clone())
        else {
            self.error = Some("no workspace selected".to_string());
            return;
        };
        match self.client.create_tab(Some(&workspace), None) {
            Ok(_) => {
                self.status = "tab created".to_string();
                if let Err(err) = self.refresh() {
                    self.error = Some(err.to_string());
                }
            }
            Err(err) => self.error = Some(err.to_string()),
        }
    }

    fn close_selected_tab(&mut self) {
        let Some(workspace) = self.selected_workspace() else {
            self.error = Some("no workspace selected".to_string());
            return;
        };
        let workspace_id = workspace.id.clone();
        let tab_id = workspace.active_tab_id.clone().or_else(|| {
            self.snapshot
                .workspace_tabs(&workspace.id)
                .first()
                .map(|tab| tab.id.clone())
        });
        let Some(tab_id) = tab_id else {
            self.error = Some("no tab to close".to_string());
            return;
        };
        // Webui closeTab guard (gap 7): closing the last tab in a
        // workspace also closes the workspace. The built-in backend
        // auto-closes emptied workspaces, but external backends may
        // keep them, so the TUI mirrors the webui and closes it
        // explicitly after the tab is gone.
        let was_last_tab = self.snapshot.workspace_tabs(&workspace_id).len().max(1) == 1;
        match self
            .client
            .request("tab.close", serde_json::json!({ "tab_id": tab_id }))
        {
            Ok(_) => {
                self.status = "tab closed".to_string();
                if was_last_tab {
                    if let Err(err) = self.client.request(
                        "workspace.close",
                        serde_json::json!({ "workspace_id": workspace_id }),
                    ) {
                        // The built-in backend may have already dropped
                        // the emptied workspace; only surface real
                        // failures.
                        if !err.to_string().contains("not found") {
                            self.error = Some(err.to_string());
                        }
                    }
                }
                if let Err(err) = self.refresh() {
                    self.error = Some(err.to_string());
                }
                self.clamp_selection();
            }
            Err(err) => self.error = Some(err.to_string()),
        }
    }

    fn open_files_screen(&mut self) {
        if self.screen == TuiScreen::Files {
            return;
        }
        self.screen = TuiScreen::Files;
        // A dirty preview survives the screen switch like a webui
        // dirty editor tab: skip the rebuild so the buffer and its
        // explorer stay together until saved or reloaded.
        if self.file_explorer.preview.dirty && self.file_explorer.preview.path.is_some() {
            return;
        }
        let Some(cwd) = self.active_cwd() else {
            return;
        };
        self.file_explorer = FileExplorer::new(&cwd);
        if let Err(err) = self.file_explorer.refresh(&self.web_api) {
            self.error = Some(err.to_string());
        }
    }

    fn open_git_screen(&mut self) {
        if self.screen == TuiScreen::Git {
            return;
        }
        self.screen = TuiScreen::Git;
        let Some(cwd) = self.active_cwd() else {
            return;
        };
        self.git_panel.set_cwd(&cwd);
        if let Err(err) = self.git_panel.refresh_view(&self.web_api) {
            self.error = Some(err.to_string());
        }
    }

    fn refresh_active_screen(&mut self) {
        match self.screen {
            TuiScreen::Terminal => {
                if let Err(err) = self.refresh() {
                    self.error = Some(err.to_string());
                }
            }
            TuiScreen::Files => {
                if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            TuiScreen::Git => {
                if let Err(err) = self.git_panel.refresh_view(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
        }
    }

    /// The cwd used for files/git panels: selected workspace cwd, falling back
    /// to the selected agent cwd.
    pub fn active_cwd(&self) -> Option<String> {
        let workspace_cwd = self
            .selected_workspace()
            .map(|workspace| workspace.cwd.clone())
            .filter(|cwd| !cwd.is_empty());
        workspace_cwd.or_else(|| {
            self.selected_agent()
                .map(|agent| agent.cwd.clone())
                .filter(|cwd| !cwd.is_empty())
        })
    }

    /// Handle in-panel keys (files/git screens) while in attach mode.
    fn handle_panel_key(&mut self, key: KeyEvent) {
        match self.screen {
            TuiScreen::Files => self.handle_files_key(key),
            TuiScreen::Git => self.handle_git_key(key),
            TuiScreen::Terminal => {}
        }
    }

    fn handle_files_key(&mut self, key: KeyEvent) {
        // While editing, all keys type into the buffer; Esc exits edit mode.
        if self.file_explorer.edit_active {
            // Find bar owns the keyboard while active (webui Ctrl+F bar):
            // typing re-runs incrementally, Enter/Shift+Enter cycle, A/X
            // flip toggles, Esc closes keeping the query.
            if self.file_explorer.editor_find.active {
                self.handle_editor_find_key(key);
                return;
            }
            match self.file_explorer.edit_key(key, &self.web_api) {
                Ok(()) => {
                    if !self.file_explorer.edit_active {
                        self.status = if self.file_explorer.preview.dirty {
                            "edit mode left with unsaved changes".to_string()
                        } else {
                            "edit mode closed".to_string()
                        };
                    } else if key
                        .modifiers
                        .contains(crossterm::event::KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('f')
                    {
                        self.file_explorer.editor_find_open();
                        self.status = "find: Enter next, Shift+Enter prev, Esc closes".to_string();
                    } else if key
                        .modifiers
                        .contains(crossterm::event::KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('h')
                    {
                        // Replace flows through the shared prompt: type
                        // the replacement, Enter replaces the current
                        // match, `!` replaces all (documented deviation
                        // from the webui's dedicated replace bar).
                        self.prompt_input = Some(PromptInput {
                            kind: PromptKind::ReplaceInFile,
                            text: String::new(),
                        });
                    } else if key
                        .modifiers
                        .contains(crossterm::event::KeyModifiers::CONTROL)
                        && key.code == KeyCode::Char('s')
                    {
                        self.status = "saved".to_string();
                    }
                }
                Err(err) => self.error = Some(err.to_string()),
            }
            return;
        }
        if self.file_explorer.filter_active {
            match key.code {
                KeyCode::Enter => self.file_explorer.commit_filter(),
                KeyCode::Esc => {
                    self.file_explorer.filter_active = false;
                    self.file_explorer.filter.clear();
                }
                KeyCode::Backspace => self.file_explorer.pop_filter_char(),
                KeyCode::Char(ch) => self.file_explorer.push_filter_char(ch),
                _ => {}
            }
            if self.file_explorer.filter_active {
                return;
            }
            // Committing the filter runs the search for the active
            // kind: tree search refreshes entries, content search fills
            // the grouped results (webui `runContentSearch`).
            let result = if self.file_explorer.search_mode
                && self.file_explorer.search_kind == SearchKind::Content
            {
                run_content_search(&mut self.file_explorer, &self.web_api, false)
                    .map(|_| self.status = "content search done".to_string())
            } else {
                self.file_explorer
                    .refresh(&self.web_api)
                    .map(|_| self.status = String::new())
            };
            if let Err(err) = result {
                self.error = Some(err.to_string());
            }
            return;
        }
        // Content-search results own the keyboard while visible
        // (webui results view): j/k move over the flat rows, Enter
        // jumps/toggles, +/- page, A/X flip match-case/regex.
        if self.file_explorer.search_mode
            && self.file_explorer.search_kind == SearchKind::Content
            && self.file_explorer.content_search.has_results()
        {
            self.handle_content_search_key(key);
            return;
        }
        match key.code {
            KeyCode::Char('j') | KeyCode::Down => self.file_explorer.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.file_explorer.move_selection(-1),
            KeyCode::Enter => {
                // Webui click parity: Enter toggles inline expansion for
                // directories and opens the preview for files. Entering a
                // directory as the new root stays on `l` (double-click).
                match self.file_explorer.toggle_expand(&self.web_api) {
                    Err(err) => self.error = Some(err.to_string()),
                    // Not a directory: open the preview; failures surface.
                    Ok(false) => {
                        if let Err(err) = self.file_explorer.open_preview(&self.web_api) {
                            self.error = Some(err.to_string());
                        }
                    }
                    Ok(true) => {}
                }
            }
            KeyCode::Char('l') | KeyCode::Right => {
                if self.file_explorer.enter_directory()
                    || self
                        .file_explorer
                        .toggle_expand(&self.web_api)
                        .unwrap_or(false)
                {
                    if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                        self.error = Some(err.to_string());
                    }
                }
            }
            // `h`/Left and `u` both go up one directory and refresh;
            // failures surface in the status bar like every panel error.
            KeyCode::Char('h') | KeyCode::Left | KeyCode::Char('u') => {
                if self.file_explorer.go_up() {
                    if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                        self.error = Some(err.to_string());
                    }
                }
            }
            KeyCode::Char('r') => self.refresh_active_screen(),
            // Webui file-browser "show history": open the git Log view
            // scoped to the selected file (`logFilePath`). Plain `h` is
            // go-up here, so the log entry is `L` (Log).
            KeyCode::Char('L') => {
                let file = self
                    .file_explorer
                    .selected_entry()
                    .filter(|entry| !entry.is_dir)
                    .map(|entry| entry.path.clone());
                match file {
                    Some(file) => {
                        self.open_git_screen();
                        self.git_panel.view = GitView::Log;
                        self.git_panel.log_file = Some(file.clone());
                        self.git_panel.log_limit = crate::tui::panels::git::LOG_PAGE_SIZE;
                        self.refresh_active_screen();
                        self.status = format!("log: {file}");
                    }
                    None => self.error = Some("select a file first".to_string()),
                }
            }
            // Tab cycles recently opened previews (webui open-file
            // tabs approximation). Blocked on a dirty buffer like the
            // webui blocks tab switches with unsaved editors.
            KeyCode::Tab => match self.file_explorer.cycle_recent_preview(&self.web_api) {
                Ok(true) => self.status = "switched preview".to_string(),
                Ok(false) => {
                    self.status = if self.file_explorer.preview.dirty {
                        "save or discard before switching".to_string()
                    } else {
                        "no recent previews".to_string()
                    }
                }
                Err(err) => self.error = Some(err.to_string()),
            },
            // Reveal the git-panel selected file in the tree
            // (neovim reveal-current-file; plan reserves prefix F, so
            // plain `w` carries it here like `w` in the git log view
            // reuses the worktree prompt).
            KeyCode::Char('w') => {
                let file = self
                    .git_panel
                    .selected_file()
                    .map(|entry| entry.path.clone());
                match file {
                    Some(file) => match self.file_explorer.reveal_path(&self.web_api, &file) {
                        Ok(()) => self.status = format!("revealed {file}"),
                        Err(err) => self.error = Some(err.to_string()),
                    },
                    None => self.error = Some("no file selected in the git panel".to_string()),
                }
            }
            KeyCode::Char('/') => self.file_explorer.start_filter(),
            // Cycle the filter scope (webui filter-kind toggle button):
            // Files → Folders → Content.
            KeyCode::Char('t') => {
                self.file_explorer.cycle_search_kind();
                self.status = format!("search: {}", self.file_explorer.search_kind.label());
            }
            // New file (webui mobile new-file flow): empty file created
            // via `file_write` under the current root, then previewed.
            KeyCode::Char('a') => {
                self.prompt_input = Some(PromptInput {
                    kind: PromptKind::CreateFile,
                    text: String::new(),
                });
            }
            // New directory: `.gitkeep` marker via `file_write` (the
            // API has no mkdir endpoint; documented deviation).
            KeyCode::Char('A') => {
                self.prompt_input = Some(PromptInput {
                    kind: PromptKind::CreateDirectory,
                    text: String::new(),
                });
            }
            // Markdown outline flip (gap 22): webui eye toggle. M shows
            // the header outline of the open markdown preview (or the
            // source again); a non-markdown preview explains itself.
            KeyCode::Char('M') => match self.file_explorer.toggle_markdown_outline() {
                Some(true) => self.status = "outline view (M shows source)".to_string(),
                Some(false) => self.status = "source view".to_string(),
                None => {
                    self.error = Some("open a markdown file first".to_string());
                }
            },
            KeyCode::Char('e') => match self.file_explorer.start_edit() {
                Ok(()) => self.status = "editing: Ctrl-S saves, Esc stops".to_string(),
                Err(err) => self.error = Some(err.to_string()),
            },
            KeyCode::Char('R') => {
                // Rename the selected file: prefill the prompt with the
                // current name so editing is incremental.
                let name = self
                    .file_explorer
                    .selected_entry()
                    .map(|entry| entry.name.clone())
                    .unwrap_or_default();
                if name.is_empty() {
                    self.error = Some("no file selected".to_string());
                } else if self.file_explorer.preview.dirty
                    && self.file_explorer.preview.path.is_some()
                {
                    // Renaming would desync the dirty buffer's path from
                    // the file on disk; require a save or reload first.
                    self.error =
                        Some("unsaved edits: save or reload before renaming files".to_string());
                } else {
                    self.prompt_input = Some(PromptInput {
                        kind: PromptKind::RenameFile,
                        text: name,
                    });
                }
            }
            KeyCode::Char('x') => {
                let name = self
                    .file_explorer
                    .selected_entry()
                    .map(|entry| entry.name.clone())
                    .unwrap_or_default();
                if name.is_empty() {
                    self.error = Some("no file selected".to_string());
                } else if self.file_explorer.preview.dirty
                    && self.file_explorer.preview.path.is_some()
                {
                    // Deleting would orphan the dirty buffer (a later save
                    // would recreate the file); the webui also refuses
                    // editing deleted files.
                    self.error =
                        Some("unsaved edits: save or reload before deleting files".to_string());
                } else {
                    self.prompt_input = Some(PromptInput {
                        kind: PromptKind::ConfirmDeleteFile,
                        text: String::new(),
                    });
                }
            }
            KeyCode::Char('?') => self.mode = TuiMode::Help,
            KeyCode::Esc | KeyCode::Char('q') => self.screen = TuiScreen::Terminal,
            _ => {}
        }
    }

    fn handle_git_key(&mut self, key: KeyEvent) {
        // Diff search (webui Ctrl+F): while active it owns the keyboard;
        // Enter commits the query, Esc closes, typing searches
        // incrementally, n/N still work from the committed state.
        if self.git_panel.diff_search_active {
            match key.code {
                // Enter commits the query but keeps the matches so n/N
                // keep cycling; Esc forgets the search entirely.
                KeyCode::Enter => self.git_panel.end_diff_search(),
                KeyCode::Esc => self.git_panel.cancel_diff_search(),
                KeyCode::Backspace => self.git_panel.pop_diff_search_char(),
                KeyCode::Char('n') => {
                    self.git_panel.diff_search_next();
                }
                KeyCode::Char('N') => {
                    self.git_panel.diff_search_prev();
                }
                KeyCode::Char(ch) => {
                    self.git_panel.push_diff_search_char(ch);
                }
                _ => {}
            }
            self.status = format!(
                "diff search: {} ({} matches)",
                self.git_panel.diff_search_query,
                self.git_panel.diff_search_matches.len()
            );
            return;
        }
        match key.code {
            // Esc also clears a committed search (bar closed by Enter but
            // matches kept): the webui Esc dismisses the highlight too.
            KeyCode::Esc
                if self.git_panel.view == GitView::Changes
                    && !self.git_panel.diff_search_matches.is_empty() =>
            {
                self.git_panel.cancel_diff_search();
            }
            // Webui Ctrl+F in the diff: open the incremental search
            // while the Changes diff pane is the target.
            KeyCode::Char('/') if self.git_panel.view == GitView::Changes => {
                self.git_panel.start_diff_search();
                self.status = "diff search: type to match, n/N cycle, Esc closes".to_string();
            }
            KeyCode::Char('n') if self.git_panel.view == GitView::Changes => {
                if !self.git_panel.diff_search_next() {
                    self.status = "no diff search matches".to_string();
                }
            }
            KeyCode::Char('N') if self.git_panel.view == GitView::Changes => {
                if !self.git_panel.diff_search_prev() {
                    self.status = "no diff search matches".to_string();
                }
            }
            KeyCode::Char('j') | KeyCode::Down => self.git_panel.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.git_panel.move_selection(-1),
            // Hunk actions (gap 14, webui per-hunk stage/unstage
            // buttons): J/K walk the `@@` headers of the loaded Changes
            // diff (wrapping), H applies the hunk action — stage when
            // the diff is working-tree scope, unstage when staged.
            KeyCode::Char('J') if self.git_panel.view == GitView::Changes => {
                if !self.git_panel.move_hunk_selection(1) {
                    self.status = "no hunks in the loaded diff".to_string();
                } else {
                    self.status = format!("hunk {}", self.git_panel.diff_hunk_selected + 1);
                }
            }
            KeyCode::Char('K') if self.git_panel.view == GitView::Changes => {
                if !self.git_panel.move_hunk_selection(-1) {
                    self.status = "no hunks in the loaded diff".to_string();
                } else {
                    self.status = format!("hunk {}", self.git_panel.diff_hunk_selected + 1);
                }
            }
            KeyCode::Char('H') if self.git_panel.view == GitView::Changes => {
                match self.git_panel.apply_hunk_action(&self.web_api) {
                    Ok(()) => self.status = "hunk applied".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Tab => {
                self.git_panel.view = match self.git_panel.view {
                    GitView::Changes => GitView::Log,
                    GitView::Log => GitView::Branches,
                    GitView::Branches => GitView::Stash,
                    GitView::Stash => GitView::History,
                    GitView::History => GitView::Conflicts,
                    GitView::Conflicts => GitView::Cleanup,
                    GitView::Cleanup => GitView::Changes,
                };
                self.refresh_active_screen();
            }
            // Webui `selectLogCommit` shift-click arm (gap 11 two-commit
            // compare): Space marks up to two commits, `c` compares the
            // pair ordered by log position (newest = target).
            KeyCode::Char(' ') if self.git_panel.view == GitView::Log => {
                if let Some(hash) = self.git_panel.selected_commit_hash().map(str::to_string) {
                    self.git_panel.log_toggle_selection(&hash);
                    self.status = format!("selected: {:?}", self.git_panel.log_selected);
                } else {
                    self.error = Some("no commit selected".to_string());
                }
            }
            KeyCode::Char('c')
                if self.git_panel.view == GitView::Log
                    && self.git_panel.log_selected.len() == 2 =>
            {
                match self.git_panel.log_compare_selection(&self.web_api) {
                    Ok(()) => self.status = "compare loaded".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            // Log view actions (webui log toolbar). All guarded to Log so
            // the shared git keys keep their meaning elsewhere. `s` (stage)
            // has no use in Log, so it cycles the log scope here.
            KeyCode::Char('s') if self.git_panel.view == GitView::Log => {
                self.git_panel.cycle_log_scope();
                if let Err(err) = self.git_panel.refresh_log(&self.web_api) {
                    self.error = Some(err.to_string());
                } else {
                    self.status = format!("log scope: {}", self.git_panel.log_scope.label());
                }
            }
            KeyCode::Char('+') if self.git_panel.view == GitView::Log => {
                if self.git_panel.log_load_more() {
                    if let Err(err) = self.git_panel.refresh_log(&self.web_api) {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = format!("log limit: {}", self.git_panel.log_limit);
                    }
                } else {
                    self.status = "no more commits".to_string();
                }
            }
            KeyCode::Char('t') if self.git_panel.view == GitView::Log => {
                if self.git_panel.selected_commit_hash().is_some() {
                    self.prompt_input = Some(PromptInput::new(PromptKind::CreateTag));
                    self.status = PromptKind::CreateTag.title().to_string();
                } else {
                    self.error = Some("no commit selected".to_string());
                }
            }
            KeyCode::Char('R') if self.git_panel.view == GitView::Log => {
                if self.git_panel.selected_commit_hash().is_some() {
                    self.prompt_input = Some(PromptInput::new(PromptKind::ResetMode));
                    self.status = PromptKind::ResetMode.title().to_string();
                } else {
                    self.error = Some("no commit selected".to_string());
                }
            }
            KeyCode::Char('b') if self.git_panel.view == GitView::Log => {
                if self.git_panel.selected_commit_hash().is_some() {
                    self.prompt_input = Some(PromptInput::new(PromptKind::RebaseUpstream));
                    self.status = PromptKind::RebaseUpstream.title().to_string();
                } else {
                    self.error = Some("no commit selected".to_string());
                }
            }
            // Webui "worktree from branch": reuse the two-step worktree
            // creation prompt chain (branch, then checkout path).
            KeyCode::Char('w') if self.git_panel.view == GitView::Log => {
                self.worktree_create_stage = None;
                self.prompt_input = Some(PromptInput::new(PromptKind::CreateWorktreeBranch));
                self.status = PromptKind::CreateWorktreeBranch.title().to_string();
            }
            KeyCode::Char('s') => {
                if let Err(err) = self.git_panel.stage_selected(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            KeyCode::Char('d') => {
                // Discarding the file under edit would make the dirty
                // buffer diverge from disk with no reload prompt; the
                // 409-style guard belongs here too.
                let selected_path = self
                    .git_panel
                    .selected_file()
                    .map(|entry| entry.path.clone());
                if self.file_explorer.preview.dirty
                    && selected_path.is_some_and(|path| {
                        self.file_explorer.preview.path.as_deref() == Some(path.as_str())
                    })
                {
                    self.error = Some(
                        "unsaved edits: save or reload before discarding this file".to_string(),
                    );
                } else if let Err(err) = self.git_panel.discard_selected(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            KeyCode::Char('f') => {
                if let Err(err) = self.git_panel.fetch(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            KeyCode::Char('p') => {
                if let Err(err) = self.git_panel.pull(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            KeyCode::Char('P') => {
                if let Err(err) = self.git_panel.push(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            // Webui branch creation: in the Branches view `c` prompts
            // for a new branch name (git_switch create: true). Elsewhere
            // `c` keeps opening the commit modal.
            KeyCode::Char('c') if self.git_panel.view == GitView::Branches => {
                self.prompt_input = Some(PromptInput::new(PromptKind::CreateBranch));
                self.status = PromptKind::CreateBranch.title().to_string();
            }
            KeyCode::Char('c') => {
                self.commit_input = Some(CommitInput {
                    text: String::new(),
                    amend: false,
                });
            }
            KeyCode::Char('a') => {
                if self.git_panel.view == GitView::Stash {
                    // Stash view: a applies the selected stash (webui
                    // stash apply button; Enter is the diff preview now).
                    if let Err(err) = self.git_panel.stash_apply(&self.web_api) {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = "stash applied".to_string();
                    }
                } else {
                    self.commit_input = Some(CommitInput {
                        text: String::new(),
                        amend: true,
                    });
                }
            }
            KeyCode::Char('r') => self.refresh_active_screen(),
            KeyCode::Char('D') => match self.git_panel.view {
                GitView::Branches => {
                    let selected = self.git_panel.branches.get(self.git_panel.branch_selected);
                    match selected {
                        Some(entry) if entry.current => {
                            self.error = Some("cannot delete the current branch".to_string());
                        }
                        Some(_) => {
                            self.prompt_input = Some(PromptInput {
                                kind: PromptKind::ConfirmDeleteBranch,
                                text: String::new(),
                            });
                        }
                        None => self.error = Some("no branch selected".to_string()),
                    }
                }
                GitView::Stash => {
                    if self
                        .git_panel
                        .stashes
                        .get(self.git_panel.stash_selected)
                        .is_some()
                    {
                        self.prompt_input = Some(PromptInput {
                            kind: PromptKind::ConfirmDropStash,
                            text: String::new(),
                        });
                    } else {
                        self.error = Some("no stash selected".to_string());
                    }
                }
                _ => {}
            },
            KeyCode::Enter => match self.git_panel.view {
                GitView::Changes => {
                    if let Err(err) = self.git_panel.refresh_diff(&self.web_api) {
                        self.error = Some(err.to_string());
                    }
                }
                // Stash split view: Enter loads the selected stash's diff
                // (webui stash view preview).
                GitView::Stash => {
                    if let Err(err) = self.git_panel.load_stash_diff(&self.web_api) {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = "stash diff loaded".to_string();
                    }
                }
                // History rows are commits: Enter loads the selected commit's
                // diff (webui `showHistoryCommit`) into the History diff
                // pane; the view itself stays so the file context is kept.
                GitView::History => {
                    let hash = self
                        .git_panel
                        .commits
                        .get(self.git_panel.commit_selected)
                        .map(|commit| commit.hash.clone());
                    match hash {
                        Some(hash) => {
                            let file = self.git_panel.history_file.clone();
                            match self.git_panel.load_commit_diff(&self.web_api, &hash) {
                                Ok(()) => {
                                    self.status = format!(
                                        "commit {hash}{}",
                                        file.map(|f| format!(" · {f}")).unwrap_or_default()
                                    );
                                }
                                Err(err) => self.error = Some(err.to_string()),
                            }
                        }
                        None => self.error = Some("no commit selected".to_string()),
                    }
                }
                GitView::Branches => {
                    if let Err(err) = self.git_panel.switch_selected(&self.web_api) {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = format!(
                            "switched to {}",
                            self.git_panel
                                .branches
                                .get(self.git_panel.branch_selected)
                                .map(|entry| entry.name.clone())
                                .unwrap_or_default()
                        );
                    }
                }
                GitView::Log => {
                    // Webui log commit preview: compare the selected
                    // commit with its parent into the Log diff pane.
                    let hash = self.git_panel.selected_commit_hash().map(str::to_string);
                    match hash {
                        Some(hash) => {
                            match self.git_panel.log_compare_parent(&self.web_api, &hash) {
                                Ok(()) => self.status = format!("compare {hash}^..{hash}"),
                                Err(err) => self.error = Some(err.to_string()),
                            }
                        }
                        None => self.error = Some("no commit selected".to_string()),
                    }
                }
                GitView::Conflicts | GitView::Cleanup => {}
            },
            // Conflicts view actions (webui conflicts tab buttons).
            // Keys avoid the shared git actions: o/e/t/m for resolve modes
            // (p is pull and r is refresh in every git view), R/S/A for the
            // operation continue/skip/abort.
            KeyCode::Char('o') if self.git_panel.view == GitView::Conflicts => {
                match self
                    .git_panel
                    .resolve_selected_conflict(&self.web_api, ConflictResolveMode::Ours)
                {
                    Ok(()) => self.status = "resolved with HEAD".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('e') if self.git_panel.view == GitView::Conflicts => {
                match self
                    .git_panel
                    .resolve_selected_conflict(&self.web_api, ConflictResolveMode::Parent)
                {
                    Ok(()) => self.status = "resolved with parent".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('t') if self.git_panel.view == GitView::Conflicts => {
                match self
                    .git_panel
                    .resolve_selected_conflict(&self.web_api, ConflictResolveMode::Remote)
                {
                    Ok(()) => self.status = "resolved with remote".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('m') if self.git_panel.view == GitView::Conflicts => {
                match self
                    .git_panel
                    .resolve_selected_conflict(&self.web_api, ConflictResolveMode::MarkResolved)
                {
                    Ok(()) => self.status = "marked resolved".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('R') if self.git_panel.view == GitView::Conflicts => {
                let action = if self.git_panel.rebase_in_progress {
                    ConflictAction::RebaseContinue
                } else {
                    ConflictAction::MergeContinue
                };
                match self.git_panel.conflict_action(&self.web_api, action) {
                    Ok(()) => self.status = "operation continued".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('S') if self.git_panel.view == GitView::Conflicts => {
                match self
                    .git_panel
                    .conflict_action(&self.web_api, ConflictAction::RebaseSkip)
                {
                    Ok(()) => self.status = "rebase commit skipped".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            KeyCode::Char('A') if self.git_panel.view == GitView::Conflicts => {
                let action = if self.git_panel.rebase_in_progress {
                    ConflictAction::RebaseAbort
                } else {
                    ConflictAction::MergeAbort
                };
                match self.git_panel.conflict_action(&self.web_api, action) {
                    Ok(()) => self.status = "operation aborted".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            // Cleanup view actions (webui cleanup tab: delete + prune).
            KeyCode::Char('x') if self.git_panel.view == GitView::Cleanup => {
                match self.git_panel.selected_cleanup_item() {
                    Some(_) => {
                        self.prompt_input =
                            Some(PromptInput::new(PromptKind::ConfirmCleanupDelete));
                    }
                    None => self.error = Some("no cleanup item selected".to_string()),
                }
            }
            KeyCode::Char('B') if self.git_panel.view == GitView::Cleanup => {
                match self.git_panel.cleanup_prune(&self.web_api) {
                    Ok(()) => self.status = "worktrees pruned".to_string(),
                    Err(err) => self.error = Some(err.to_string()),
                }
            }
            // Plain ? opens the help overlay from any git view (the
            // footer advertises Ctrl+B ?; a bare ? is the natural reflex).
            KeyCode::Char('?') => self.mode = TuiMode::Help,
            KeyCode::Esc | KeyCode::Char('q') => self.screen = TuiScreen::Terminal,
            _ => {}
        }
    }

    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    pub fn take_dirty(&mut self) -> bool {
        let dirty = self.dirty;
        self.dirty = false;
        dirty
    }

    pub fn text_snapshot(&self) -> String {
        let mut out = Vec::new();
        out.push(format!("Herdr WebUI TUI · {}", self.status));
        if let Some(error) = &self.error {
            out.push(format!("error: {error}"));
        }
        out.push(format!(
            "workspaces={} tabs={} panes={} agents={} screen={}",
            self.snapshot.workspaces.len(),
            self.snapshot.tabs.len(),
            self.snapshot.panes.len(),
            self.snapshot.agents.len(),
            self.screen.title(),
        ));
        if let Some(cwd) = self.active_cwd() {
            out.push(format!("active cwd {cwd}"));
        }
        if let Some(workspace) = self.selected_workspace() {
            out.push(format!(
                "workspace {} · {} · {} · {} panes",
                workspace.id, workspace.label, workspace.agent_status, workspace.pane_count
            ));
        }
        if let Some(agent) = self.selected_agent() {
            let name = agent
                .display_agent
                .as_deref()
                .or(agent.agent.as_deref())
                .unwrap_or("agent");
            out.push(format!(
                "agent {name} · {} · pane {} · terminal {}",
                agent.status, agent.pane_id, agent.terminal_id
            ));
        }
        if let Some(pane) = self.selected_pane() {
            out.push(format!(
                "pane {} · terminal {} · {}",
                pane.id, pane.terminal_id, pane.agent_status
            ));
        }
        if !self.pane_tail.is_empty() {
            out.push("--- pane output ---".to_string());
            out.extend(self.pane_tail.iter().cloned());
        }
        out.join("\n")
    }

    pub fn ingest_terminal_output(&mut self, output: &TerminalOutput) {
        let selected_terminal_id = self.selected_terminal_id().map(str::to_string);
        if output.full || self.terminal_raw_terminal_id != selected_terminal_id {
            self.terminal_raw_output.clear();
            self.terminal_raw_terminal_id = selected_terminal_id;
        }
        self.terminal_raw_output
            .push_str(&String::from_utf8_lossy(&output.bytes));
        trim_terminal_raw_output(&mut self.terminal_raw_output);
        let lines = terminal_output_styled_lines_lossy(&self.terminal_raw_output);
        self.set_pane_tail_from_styled_lines(lines);
        self.mark_dirty();
    }

    fn handle_navigation_key(&mut self, key: KeyEvent) {
        // The Files and Git screens own their keys in Navigate mode too;
        // only the Terminal screen keeps the workspace/agent list keys.
        if self.screen != TuiScreen::Terminal {
            self.handle_panel_key(key);
            return;
        }
        match key.code {
            // Only the Terminal screen reaches this handler; Files and Git
            // delegate to their panel handlers above.
            KeyCode::Char('q') | KeyCode::Esc => self.request_quit(),
            KeyCode::Char('?') => self.mode = TuiMode::Help,
            KeyCode::Char('r') => self.refresh_active_screen(),
            KeyCode::Char('j') | KeyCode::Down => self.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_selection(-1),
            KeyCode::Tab | KeyCode::BackTab => self.toggle_sidebar_focus(),
            KeyCode::Char('a') => self.sidebar_focus = SidebarFocus::Agents,
            KeyCode::Char('w') => self.sidebar_focus = SidebarFocus::Workspaces,
            KeyCode::Enter => self.attach_selected(),
            _ => {}
        }
    }

    fn handle_attach_key(&mut self, key: KeyEvent) {
        // Note: menu keys (Ctrl+B) never reach this handler; the prefix
        // feed in `handle_key` consumes them first to arm the overlay.
        if key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('g') {
            self.mode = TuiMode::Navigate;
            self.status = "detached".to_string();
            return;
        }
        let Some(terminal_id) = self.selected_terminal_id().map(str::to_string) else {
            self.mode = TuiMode::Navigate;
            self.error = Some("selected pane has no terminal".to_string());
            return;
        };
        if let Some(bytes) = key_to_terminal_bytes(key) {
            match self.client.attach_terminal(&terminal_id, 120, 32) {
                Ok(mut terminal) => {
                    let send = terminal.send_input(&bytes).and_then(|_| terminal.detach());
                    if let Err(err) = send {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = "sent input".to_string();
                    }
                    self.refresh_tail();
                }
                Err(err) => self.error = Some(err.to_string()),
            }
        }
    }

    fn attach_selected(&mut self) {
        if self.selected_terminal_id().is_some() {
            self.mode = TuiMode::Attach;
            self.status = "attach mode: Ctrl-G detach".to_string();
            self.refresh_tail();
            self.load_selected_terminal_history(120, 32);
        } else {
            self.error = Some("no terminal selected".to_string());
        }
    }

    pub fn load_selected_terminal_history(&mut self, cols: u16, rows: u16) {
        let Some(terminal_id) = self.selected_terminal_id().map(str::to_string) else {
            return;
        };
        match self.client.attach_terminal(&terminal_id, cols, rows) {
            Ok(mut terminal) => {
                match terminal.read_output() {
                    Ok(output) => self.ingest_terminal_output(&output),
                    Err(err) => self.error = Some(err.to_string()),
                }
                if let Err(err) = terminal.detach() {
                    self.error = Some(err.to_string());
                }
            }
            Err(err) => self.error = Some(err.to_string()),
        }
        self.mark_dirty();
    }

    fn toggle_sidebar_focus(&mut self) {
        self.sidebar_focus = match self.sidebar_focus {
            SidebarFocus::Workspaces => SidebarFocus::Agents,
            SidebarFocus::Agents => SidebarFocus::Workspaces,
        };
    }

    fn move_selection(&mut self, delta: isize) {
        match self.sidebar_focus {
            SidebarFocus::Workspaces => {
                self.selected_workspace = move_index(
                    self.selected_workspace,
                    self.snapshot.workspaces.len(),
                    delta,
                );
                self.refresh_tail();
            }
            SidebarFocus::Agents => {
                self.selected_agent =
                    move_index(self.selected_agent, self.snapshot.agents.len(), delta);
                self.refresh_tail();
            }
        }
    }

    fn clamp_selection(&mut self) {
        self.selected_workspace = self
            .selected_workspace
            .min(self.snapshot.workspaces.len().saturating_sub(1));
        self.selected_agent = self
            .selected_agent
            .min(self.snapshot.agents.len().saturating_sub(1));
    }

    fn select_focused_items(&mut self) {
        if let Some(index) = self
            .snapshot
            .workspaces
            .iter()
            .position(|workspace| workspace.focused)
        {
            self.selected_workspace = index;
        }
        if let Some(index) = self.snapshot.agents.iter().position(|agent| agent.focused) {
            self.selected_agent = index;
        }
        if !self.snapshot.agents.is_empty() {
            self.sidebar_focus = SidebarFocus::Agents;
        }
    }

    pub fn selected_workspace(&self) -> Option<&TuiWorkspace> {
        self.snapshot.workspaces.get(self.selected_workspace)
    }

    pub fn selected_agent(&self) -> Option<&TuiAgent> {
        self.snapshot.agents.get(self.selected_agent)
    }

    pub fn selected_pane(&self) -> Option<&TuiPane> {
        if self.sidebar_focus == SidebarFocus::Agents {
            if let Some(agent) = self.selected_agent() {
                return self
                    .snapshot
                    .panes
                    .iter()
                    .find(|pane| pane.id == agent.pane_id);
            }
        }
        let workspace_id = &self.selected_workspace()?.id;
        let active_tab_id = self.selected_workspace()?.active_tab_id.as_deref();
        self.snapshot
            .panes
            .iter()
            .find(|pane| {
                pane.workspace_id == *workspace_id
                    && active_tab_id
                        .map(|tab_id| tab_id == pane.tab_id)
                        .unwrap_or(true)
            })
            .or_else(|| {
                self.snapshot
                    .panes
                    .iter()
                    .find(|pane| pane.workspace_id == *workspace_id)
            })
    }

    pub fn selected_terminal_id(&self) -> Option<&str> {
        self.selected_pane().map(|pane| pane.terminal_id.as_str())
    }

    pub fn refresh_tail(&mut self) {
        let Some(pane_id) = self.selected_pane().map(|pane| pane.id.clone()) else {
            self.pane_tail.clear();
            self.pane_tail_styles.clear();
            self.reset_terminal_output_buffer();
            return;
        };
        match self.client.read_pane(&pane_id) {
            Ok(value) => {
                let text = value
                    .get("read")
                    .and_then(|read| read.get("text"))
                    .and_then(Value::as_str)
                    .or_else(|| value.get("text").and_then(Value::as_str))
                    .unwrap_or("");
                self.reset_terminal_output_buffer();
                self.set_pane_tail_from_text(&strip_ansi_lossy(text));
                self.mark_dirty();
            }
            Err(err) => {
                self.error = Some(err.to_string());
                self.mark_dirty();
            }
        }
    }

    fn reset_terminal_output_buffer(&mut self) {
        self.terminal_raw_output.clear();
        self.terminal_raw_terminal_id = None;
    }

    fn set_pane_tail_from_text(&mut self, text: &str) {
        self.pane_tail = text
            .lines()
            .rev()
            .take(TAIL_LINES)
            .map(str::to_string)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        self.pane_tail_styles = vec![Vec::new(); self.pane_tail.len()];
    }

    fn set_pane_tail_from_styled_lines(&mut self, lines: Vec<Vec<TuiTextSpan>>) {
        let start = lines.len().saturating_sub(TAIL_LINES);
        self.pane_tail_styles = lines[start..].to_vec();
        self.pane_tail = self
            .pane_tail_styles
            .iter()
            .map(|line| {
                line.iter()
                    .map(|span| span.text.as_str())
                    .collect::<String>()
            })
            .collect();
    }

    pub fn should_quit(&self) -> bool {
        self.status == "quit"
    }
}

pub fn build_client(options: &TuiOptions) -> BackendClient {
    match (&options.api_socket, &options.terminal_socket) {
        (Some(api), Some(terminal)) => BackendClient::new(api, terminal),
        _ => BackendClient::builtin_session(options.session.as_deref()),
    }
}

pub use terminal::input::{is_menu_key, key_to_terminal_bytes};

fn move_index(current: usize, len: usize, delta: isize) -> usize {
    if len == 0 {
        return 0;
    }
    let current = current.min(len - 1) as isize;
    (current + delta).clamp(0, len as isize - 1) as usize
}

fn strip_ansi_lossy(value: &str) -> String {
    terminal_text::strip_ansi_lossy(value, StripCarriageReturn::Drop)
}

fn trim_terminal_raw_output(value: &mut String) {
    let excess = value.len().saturating_sub(TERMINAL_RAW_BUFFER_BYTES);
    if excess == 0 {
        return;
    }
    let drain_to = value
        .char_indices()
        .find_map(|(index, _)| (index >= excess).then_some(index))
        .unwrap_or(value.len());
    value.drain(..drain_to);
}
