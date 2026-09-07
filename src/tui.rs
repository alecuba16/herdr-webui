use std::path::PathBuf;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::Value;

use crate::backend_client::{BackendClient, BackendClientError, TerminalOutput};
use crate::terminal_text::{self, StripCarriageReturn};
pub use crate::tui_keys::{PrefixState, Shortcut};
pub use crate::tui_model::{
    snapshot_summary, SidebarFocus, TuiAgent, TuiMode, TuiPane, TuiSnapshot, TuiTab, TuiWorkspace,
};
use crate::tui_model::{value_str, value_u64};
use crate::tui_panels::{FileExplorer, GitPanel, GitView};
pub use crate::tui_render::render;
use crate::tui_terminal::{terminal_output_styled_lines_lossy, TuiTextSpan};
use crate::tui_theme::Palette;
pub use crate::tui_theme::TuiTheme;
use crate::tui_web_api::WebApiClient;

const TAIL_LINES: usize = 240;
const TERMINAL_RAW_BUFFER_BYTES: usize = 512 * 1024;

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
    pub mode: TuiMode,
    pub screen: TuiScreen,
    pub prefix: PrefixState,
    pub file_explorer: FileExplorer,
    pub git_panel: GitPanel,
    pub commit_input: Option<CommitInput>,
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
    dirty: bool,
}

/// Commit message input state. Opened with the commit shortcut; typed text
/// becomes the commit title until Enter commits it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitInput {
    pub text: String,
    pub amend: bool,
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
            mode: TuiMode::Navigate,
            screen: TuiScreen::Terminal,
            prefix: PrefixState::new(),
            file_explorer: FileExplorer::new(cwd),
            git_panel: GitPanel::new(cwd),
            commit_input: None,
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
        match self.mode {
            TuiMode::Help => match key.code {
                KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q') => {
                    self.mode = TuiMode::Navigate
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
            Shortcut::Help => self.mode = TuiMode::Help,
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
            Shortcut::Quit => self.status = "quit".to_string(),
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
            Shortcut::GitAmend => {
                self.open_git_screen();
                self.commit_input = Some(CommitInput {
                    text: String::new(),
                    amend: true,
                });
                self.status = "amend: type message, Enter amends".to_string();
            }
            Shortcut::GitLog => {
                self.open_git_screen();
                self.git_panel.view = GitView::Log;
                self.refresh_active_screen();
            }
            Shortcut::GitStash => {
                self.open_git_screen();
                self.git_panel.view = GitView::Stash;
                self.refresh_active_screen();
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
            Shortcut::GitStageAll => self.run_git_action(|panel, api| panel.stage_all(api)),
            Shortcut::GitStageFile => self.run_git_action(|panel, api| panel.stage_selected(api)),
            Shortcut::GitUnstageFile => self.run_git_action(|panel, api| panel.stage_selected(api)),
            Shortcut::GitDiscardFile => {
                self.run_git_action(|panel, api| panel.discard_selected(api))
            }
            Shortcut::GitStashFile => self.run_git_action(|panel, api| panel.stash_changes(api)),
            Shortcut::GitPull => self.run_git_action(|panel, api| panel.pull(api)),
            Shortcut::GitPush => self.run_git_action(|panel, api| panel.push(api)),
            Shortcut::GitFetch => self.run_git_action(|panel, api| panel.fetch(api)),
        }
    }

    fn run_git_action(
        &mut self,
        action: impl FnOnce(&mut GitPanel, &WebApiClient) -> Result<(), crate::tui_web_api::WebApiError>,
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
        match self
            .client
            .request("tab.close", serde_json::json!({ "tab_id": tab_id }))
        {
            Ok(_) => {
                self.status = "tab closed".to_string();
                if let Err(err) = self.refresh() {
                    self.error = Some(err.to_string());
                }
            }
            Err(err) => self.error = Some(err.to_string()),
        }
    }

    fn open_files_screen(&mut self) {
        if self.screen != TuiScreen::Files {
            self.screen = TuiScreen::Files;
            if let Some(cwd) = self.active_cwd() {
                self.file_explorer = FileExplorer::new(&cwd);
                if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
        }
    }

    fn open_git_screen(&mut self) {
        if self.screen != TuiScreen::Git {
            self.screen = TuiScreen::Git;
            if let Some(cwd) = self.active_cwd() {
                self.git_panel.set_cwd(&cwd);
                if let Err(err) = self.git_panel.refresh_view(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
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
            if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                self.error = Some(err.to_string());
            }
            return;
        }
        match key.code {
            KeyCode::Char('j') | KeyCode::Down => self.file_explorer.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.file_explorer.move_selection(-1),
            KeyCode::Enter => {
                if self.file_explorer.enter_directory() {
                    if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                        self.error = Some(err.to_string());
                    }
                } else if let Err(err) = self.file_explorer.toggle_expand(&self.web_api) {
                    self.error = Some(err.to_string());
                } else if let Err(err) = self.file_explorer.open_preview(&self.web_api) {
                    self.error = Some(err.to_string());
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
            KeyCode::Char('h') | KeyCode::Left => {
                if self.file_explorer.go_up() {
                    if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                        self.error = Some(err.to_string());
                    }
                }
            }
            KeyCode::Char('u') => {
                if self.file_explorer.go_up() {
                    if let Err(err) = self.file_explorer.refresh(&self.web_api) {
                        self.error = Some(err.to_string());
                    }
                }
            }
            KeyCode::Char('r') => self.refresh_active_screen(),
            KeyCode::Esc | KeyCode::Char('q') => self.screen = TuiScreen::Terminal,
            _ => {}
        }
    }

    fn handle_git_key(&mut self, key: KeyEvent) {
        match key.code {
            KeyCode::Char('j') | KeyCode::Down => self.git_panel.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.git_panel.move_selection(-1),
            KeyCode::Tab => {
                self.git_panel.view = match self.git_panel.view {
                    GitView::Changes => GitView::Log,
                    GitView::Log => GitView::Branches,
                    GitView::Branches => GitView::Stash,
                    GitView::Stash => GitView::Changes,
                };
                self.refresh_active_screen();
            }
            KeyCode::Char('s') => {
                if let Err(err) = self.git_panel.stage_selected(&self.web_api) {
                    self.error = Some(err.to_string());
                }
            }
            KeyCode::Char('d') => {
                if let Err(err) = self.git_panel.discard_selected(&self.web_api) {
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
            KeyCode::Char('c') => {
                self.commit_input = Some(CommitInput {
                    text: String::new(),
                    amend: false,
                });
            }
            KeyCode::Char('a') => {
                self.commit_input = Some(CommitInput {
                    text: String::new(),
                    amend: true,
                });
            }
            KeyCode::Char('r') => self.refresh_active_screen(),
            KeyCode::Enter => match self.git_panel.view {
                GitView::Changes => {
                    if let Err(err) = self.git_panel.refresh_diff(&self.web_api) {
                        self.error = Some(err.to_string());
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
                GitView::Stash => {
                    if let Err(err) = self.git_panel.stash_apply(&self.web_api) {
                        self.error = Some(err.to_string());
                    } else {
                        self.status = "stash applied".to_string();
                    }
                }
                GitView::Log => {}
            },
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
        match key.code {
            KeyCode::Char('q') | KeyCode::Esc => {
                if self.screen == TuiScreen::Terminal {
                    self.status = "quit".to_string();
                } else {
                    self.screen = TuiScreen::Terminal;
                }
            }
            KeyCode::Char('?') => self.mode = TuiMode::Help,
            KeyCode::Char('r') => self.refresh_active_screen(),
            KeyCode::Char('j') | KeyCode::Down => self.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_selection(-1),
            KeyCode::Tab | KeyCode::BackTab => self.toggle_sidebar_focus(),
            KeyCode::Char('a') => self.sidebar_focus = SidebarFocus::Agents,
            KeyCode::Char('w') => self.sidebar_focus = SidebarFocus::Workspaces,
            KeyCode::Enter if self.screen == TuiScreen::Terminal => self.attach_selected(),
            _ => {}
        }
    }

    fn handle_attach_key(&mut self, key: KeyEvent) {
        if is_menu_key(key) {
            self.mode = TuiMode::Help;
            self.status = "menu: Esc/Ctrl-B closes".to_string();
            return;
        }
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

pub use crate::tui_input::{is_menu_key, key_to_terminal_bytes};

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

#[cfg(test)]
#[path = "tui_tests.rs"]
mod tests;
