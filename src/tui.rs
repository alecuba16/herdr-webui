use std::path::PathBuf;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;
use serde_json::Value;

use crate::backend_client::{BackendClient, BackendClientError, TerminalOutput};
use crate::terminal_text::{self, StripCarriageReturn};
use crate::tui_terminal::{styled_terminal_line, terminal_output_styled_lines_lossy, TuiTextSpan};
use crate::tui_theme::Palette;
pub use crate::tui_theme::TuiTheme;

const SPINNERS: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const TAIL_LINES: usize = 240;
const TERMINAL_RAW_BUFFER_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TuiMode {
    Navigate,
    Attach,
    Help,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidebarFocus {
    Workspaces,
    Agents,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiWorkspace {
    pub id: String,
    pub label: String,
    pub cwd: String,
    pub focused: bool,
    pub agent_status: String,
    pub pane_count: usize,
    pub tab_count: usize,
    pub active_tab_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiTab {
    pub id: String,
    pub workspace_id: String,
    pub label: String,
    pub focused: bool,
    pub pane_count: usize,
    pub agent_status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiPane {
    pub id: String,
    pub terminal_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub label: Option<String>,
    pub agent: Option<String>,
    pub display_agent: Option<String>,
    pub agent_status: String,
    pub cwd: String,
    pub focused: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TuiAgent {
    pub pane_id: String,
    pub workspace_id: String,
    pub tab_id: String,
    pub terminal_id: String,
    pub agent: Option<String>,
    pub display_agent: Option<String>,
    pub status: String,
    pub title: Option<String>,
    pub cwd: String,
    pub focused: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TuiSnapshot {
    pub workspaces: Vec<TuiWorkspace>,
    pub tabs: Vec<TuiTab>,
    pub panes: Vec<TuiPane>,
    pub agents: Vec<TuiAgent>,
}

#[derive(Debug, Clone)]
pub struct TuiOptions {
    pub session: Option<String>,
    pub api_socket: Option<PathBuf>,
    pub terminal_socket: Option<PathBuf>,
    pub refresh_interval: Duration,
    pub theme: TuiTheme,
}

impl Default for TuiOptions {
    fn default() -> Self {
        Self {
            session: None,
            api_socket: None,
            terminal_socket: None,
            refresh_interval: Duration::from_millis(1000),
            theme: TuiTheme::from_env(),
        }
    }
}

#[derive(Debug)]
pub struct TuiApp {
    pub client: BackendClient,
    pub snapshot: TuiSnapshot,
    pub selected_workspace: usize,
    pub selected_agent: usize,
    pub sidebar_focus: SidebarFocus,
    pub mode: TuiMode,
    pub pane_tail: Vec<String>,
    pane_tail_styles: Vec<Vec<TuiTextSpan>>,
    terminal_raw_output: String,
    terminal_raw_terminal_id: Option<String>,
    pub status: String,
    pub error: Option<String>,
    pub last_refresh: Option<Instant>,
    pub refresh_interval: Duration,
    pub theme: TuiTheme,
    palette: Palette,
    pub tick: u64,
    dirty: bool,
}

impl TuiSnapshot {
    pub fn from_backend_response(value: &Value) -> Self {
        let snapshot = value.get("snapshot").unwrap_or(value);
        Self {
            workspaces: parse_array(snapshot, "workspaces", parse_workspace),
            tabs: parse_array(snapshot, "tabs", parse_tab),
            panes: parse_array(snapshot, "panes", parse_pane),
            agents: parse_array(snapshot, "agents", parse_agent),
        }
    }

    pub fn workspace_tabs(&self, workspace_id: &str) -> Vec<&TuiTab> {
        self.tabs
            .iter()
            .filter(|tab| tab.workspace_id == workspace_id)
            .collect()
    }

    pub fn workspace_panes(&self, workspace_id: &str) -> Vec<&TuiPane> {
        self.panes
            .iter()
            .filter(|pane| pane.workspace_id == workspace_id)
            .collect()
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
        Self {
            client,
            snapshot: TuiSnapshot::default(),
            selected_workspace: 0,
            selected_agent: 0,
            sidebar_focus: SidebarFocus::Workspaces,
            mode: TuiMode::Navigate,
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
        match self.mode {
            TuiMode::Help => match key.code {
                KeyCode::Esc | KeyCode::Char('?') | KeyCode::Char('q') => {
                    self.mode = TuiMode::Navigate
                }
                _ if is_menu_key(key) => self.mode = TuiMode::Navigate,
                _ => {}
            },
            TuiMode::Navigate => self.handle_navigation_key(key),
            TuiMode::Attach => self.handle_attach_key(key),
        }
        self.mark_dirty();
        false
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
            "workspaces={} tabs={} panes={} agents={}",
            self.snapshot.workspaces.len(),
            self.snapshot.tabs.len(),
            self.snapshot.panes.len(),
            self.snapshot.agents.len()
        ));
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
            KeyCode::Char('q') | KeyCode::Esc => self.status = "quit".to_string(),
            _ if is_menu_key(key) => self.mode = TuiMode::Help,
            KeyCode::Char('?') => self.mode = TuiMode::Help,
            KeyCode::Char('r') => {
                if let Err(err) = self.refresh() {
                    self.error = Some(err.to_string());
                    self.mark_dirty();
                }
            }
            KeyCode::Char('j') | KeyCode::Down => self.move_selection(1),
            KeyCode::Char('k') | KeyCode::Up => self.move_selection(-1),
            KeyCode::Tab => self.toggle_sidebar_focus(),
            KeyCode::BackTab => self.toggle_sidebar_focus(),
            KeyCode::Char('a') => self.sidebar_focus = SidebarFocus::Agents,
            KeyCode::Char('w') => self.sidebar_focus = SidebarFocus::Workspaces,
            KeyCode::Enter => self.attach_selected(),
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

pub fn render(frame: &mut Frame<'_>, app: &TuiApp) {
    let p = &app.palette;
    let area = frame.area();
    let [body, footer] = Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).areas(area);
    let sidebar_width = if body.width >= 100 {
        34
    } else {
        28.min(body.width / 2)
    };
    let [sidebar, main] =
        Layout::horizontal([Constraint::Length(sidebar_width), Constraint::Min(1)]).areas(body);
    render_sidebar(frame, sidebar, app, p);
    render_main(frame, main, app, p);
    render_footer(frame, footer, app, p);
    if app.mode == TuiMode::Help {
        render_help(frame, area, p);
    }
}

fn render_sidebar(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    if area.is_empty() {
        return;
    }
    let [workspaces, agents] =
        Layout::vertical([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(area);
    render_workspace_list(frame, workspaces, app, p);
    render_agent_list(frame, agents, app, p);
}

fn render_workspace_list(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let items = app
        .snapshot
        .workspaces
        .iter()
        .map(|workspace| {
            let (dot, style) = status_dot(&workspace.agent_status, p);
            let title = format!(
                "{} {}",
                if workspace.focused { "›" } else { " " },
                truncate(&workspace.label, area.width.saturating_sub(8) as usize)
            );
            let counts = format!("{}p {}t", workspace.pane_count, workspace.tab_count);
            ListItem::new(vec![Line::from(vec![
                Span::styled(dot, style),
                Span::raw(" "),
                Span::styled(title, Style::default().fg(p.text)),
                Span::styled(format!(" {counts}"), Style::default().fg(p.muted)),
            ])])
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(app.selected_workspace));
    }
    let title = if app.sidebar_focus == SidebarFocus::Workspaces {
        " Workspaces* "
    } else {
        " Workspaces "
    };
    let list = List::new(items)
        .block(panel(title, p))
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .highlight_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD))
        .highlight_symbol("▸ ");
    frame.render_stateful_widget(list, area, &mut state);
}

fn render_agent_list(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let items = app
        .snapshot
        .agents
        .iter()
        .map(|agent| {
            let (icon, style) = agent_icon(&agent.status, app.tick, p);
            let name = agent
                .display_agent
                .as_deref()
                .or(agent.agent.as_deref())
                .unwrap_or("agent");
            let title = agent.title.as_deref().unwrap_or(&agent.pane_id);
            ListItem::new(Line::from(vec![
                Span::styled(icon, style),
                Span::raw(" "),
                Span::styled(name.to_string(), Style::default().fg(p.text)),
                Span::styled(
                    format!(" · {}", truncate(title, 18)),
                    Style::default().fg(p.muted),
                ),
            ]))
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(app.selected_agent));
    }
    let title = if app.sidebar_focus == SidebarFocus::Agents {
        " Agents* "
    } else {
        " Agents "
    };
    let list = List::new(items)
        .block(panel(title, p))
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .highlight_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD))
        .highlight_symbol("▸ ");
    frame.render_stateful_widget(list, area, &mut state);
}

fn render_main(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    if area.is_empty() {
        return;
    }
    let [tab_bar, pane_area] =
        Layout::vertical([Constraint::Length(1), Constraint::Min(1)]).areas(area);
    render_tab_bar(frame, tab_bar, app, p);
    render_pane(frame, pane_area, app, p);
}

fn render_tab_bar(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let line = if let Some(workspace) = app.selected_workspace() {
        let tabs = app.snapshot.workspace_tabs(&workspace.id);
        if tabs.is_empty() {
            Line::from(vec![Span::styled(
                format!(" {} ", workspace.label),
                Style::default()
                    .fg(p.accent)
                    .bg(p.panel_alt)
                    .add_modifier(Modifier::BOLD),
            )])
        } else {
            let spans = tabs
                .iter()
                .flat_map(|tab| {
                    let active =
                        workspace.active_tab_id.as_deref() == Some(tab.id.as_str()) || tab.focused;
                    let style = if active {
                        Style::default()
                            .fg(p.panel_bg)
                            .bg(p.accent)
                            .add_modifier(Modifier::BOLD)
                    } else {
                        Style::default().fg(p.text).bg(p.panel_alt)
                    };
                    vec![
                        Span::styled(format!(" {} ", truncate(&tab.label, 16)), style),
                        Span::raw(" "),
                    ]
                })
                .collect::<Vec<_>>();
            Line::from(spans)
        }
    } else {
        Line::from(Span::styled(
            " no workspaces ",
            Style::default().fg(p.muted),
        ))
    };
    frame.render_widget(Paragraph::new(line).style(Style::default().bg(p.bg)), area);
}

fn render_pane(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let selected = app.selected_pane();
    let title = selected
        .map(|pane| {
            format!(
                " {} · {} ",
                pane.display_agent
                    .as_deref()
                    .or(pane.agent.as_deref())
                    .unwrap_or("shell"),
                pane.id
            )
        })
        .unwrap_or_else(|| " Pane ".to_string());
    let block = panel(&title, p).border_style(match app.mode {
        TuiMode::Attach => Style::default().fg(p.teal),
        _ => Style::default().fg(p.border),
    });
    let inner = block.inner(area);
    frame.render_widget(block, area);

    let mut lines = Vec::new();
    if let Some(pane) = selected {
        lines.push(Line::from(vec![
            Span::styled("cwd ", Style::default().fg(p.muted)),
            Span::styled(
                truncate(&pane.cwd, inner.width as usize),
                Style::default().fg(p.text),
            ),
        ]));
        lines.push(Line::from(vec![
            Span::styled("status ", Style::default().fg(p.muted)),
            Span::styled(&pane.agent_status, status_style(&pane.agent_status, p)),
            Span::styled(" · terminal ", Style::default().fg(p.muted)),
            Span::styled(&pane.terminal_id, Style::default().fg(p.text)),
        ]));
        lines.push(Line::from(""));
    }
    if app.pane_tail.is_empty() {
        lines.push(Line::from(Span::styled(
            "No pane output yet. Enter attaches, Ctrl-G detaches.",
            Style::default().fg(p.muted),
        )));
    } else {
        let max_tail = inner.height.saturating_sub(lines.len() as u16) as usize;
        let start = app.pane_tail.len().saturating_sub(max_tail);
        for index in start..app.pane_tail.len() {
            let width = inner.width as usize;
            let line = app
                .pane_tail_styles
                .get(index)
                .filter(|spans| !spans.is_empty())
                .map(|spans| styled_terminal_line(spans, width, p.text))
                .unwrap_or_else(|| {
                    Line::from(Span::styled(
                        truncate(&app.pane_tail[index], width),
                        Style::default().fg(p.text),
                    ))
                });
            lines.push(line);
        }
    }

    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .wrap(Wrap { trim: false }),
        inner,
    );
}

fn render_footer(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let mode = match app.mode {
        TuiMode::Navigate => "NAV",
        TuiMode::Attach => "ATTACH",
        TuiMode::Help => "HELP",
    };
    let help = match app.mode {
        TuiMode::Attach => " Ctrl-B menu · Ctrl-G detach · type sends input · q passthrough ",
        _ => " Ctrl-B menu · ↑/↓ j/k select · Enter attach · r refresh · q quit ",
    };
    let message = app.error.as_deref().unwrap_or(&app.status);
    let line = Line::from(vec![
        Span::styled(
            format!(" {mode} "),
            Style::default()
                .fg(p.panel_bg)
                .bg(p.accent)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(help, Style::default().fg(p.text).bg(p.panel_alt)),
        Span::styled(
            truncate(message, area.width.saturating_sub(40) as usize),
            Style::default()
                .fg(if app.error.is_some() { p.red } else { p.muted })
                .bg(p.panel_alt),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(line).style(Style::default().bg(p.panel_alt)),
        area,
    );
}

fn render_help(frame: &mut Frame<'_>, area: Rect, p: &Palette) {
    let width = area.width.min(72);
    let height = area.height.min(16);
    let rect = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    let lines = vec![
        Line::from(Span::styled(
            "Herdr WebUI TUI",
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        Line::from("Navigation"),
        Line::from("  j/k or ↑/↓      move selected workspace/agent"),
        Line::from("  Tab              switch workspace/agent list"),
        Line::from("  w / a            focus workspace or agent list"),
        Line::from("  r                refresh snapshot"),
        Line::from("  Enter            attach selected terminal"),
        Line::from("  Ctrl-B / ?       open or close this menu"),
        Line::from(""),
        Line::from("Attach mode"),
        Line::from("  keys             send to selected terminal"),
        Line::from("  Ctrl-B           open menu, not sent to terminal"),
        Line::from("  Ctrl-G           detach back to navigation"),
        Line::from("  q / Esc          quit only from navigation"),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .block(panel(" Help ", p))
            .style(Style::default().fg(p.text).bg(p.panel_bg)),
        rect,
    );
}

pub fn snapshot_summary(snapshot: &TuiSnapshot, ping: Option<&Value>) -> String {
    let version = ping
        .and_then(|value| value_str(value, &["version"]))
        .unwrap_or("unknown");
    let protocol = ping
        .and_then(|value| value_u64(value, &["protocol"]))
        .unwrap_or(0);
    format!(
        "Herdr WebUI TUI: backend {version} protocol {protocol}, {} workspaces, {} tabs, {} panes, {} agents",
        snapshot.workspaces.len(),
        snapshot.tabs.len(),
        snapshot.panes.len(),
        snapshot.agents.len()
    )
}

pub fn key_to_terminal_bytes(key: KeyEvent) -> Option<Vec<u8>> {
    if key.modifiers.contains(KeyModifiers::CONTROL) {
        if let KeyCode::Char(ch) = key.code {
            let lower = ch.to_ascii_lowercase();
            if lower.is_ascii_lowercase() {
                return Some(vec![(lower as u8) - b'a' + 1]);
            }
        }
    }
    match key.code {
        KeyCode::Char(ch) => Some(ch.to_string().into_bytes()),
        KeyCode::Enter => Some(b"\r".to_vec()),
        KeyCode::Backspace => Some(vec![0x7f]),
        KeyCode::Tab => Some(b"\t".to_vec()),
        KeyCode::Esc => Some(vec![0x1b]),
        KeyCode::Left => Some(b"\x1b[D".to_vec()),
        KeyCode::Right => Some(b"\x1b[C".to_vec()),
        KeyCode::Up => Some(b"\x1b[A".to_vec()),
        KeyCode::Down => Some(b"\x1b[B".to_vec()),
        KeyCode::Home => Some(b"\x1b[H".to_vec()),
        KeyCode::End => Some(b"\x1b[F".to_vec()),
        KeyCode::Delete => Some(b"\x1b[3~".to_vec()),
        _ => None,
    }
}

pub fn is_menu_key(key: KeyEvent) -> bool {
    key.modifiers.contains(KeyModifiers::CONTROL) && key.code == KeyCode::Char('b')
}

fn parse_array<T>(snapshot: &Value, key: &str, parse: fn(&Value) -> T) -> Vec<T> {
    snapshot
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().map(parse).collect())
        .unwrap_or_default()
}

fn parse_workspace(value: &Value) -> TuiWorkspace {
    TuiWorkspace {
        id: value_str(value, &["workspace_id"])
            .unwrap_or_default()
            .to_string(),
        label: value_str(value, &["label"])
            .unwrap_or("Workspace")
            .to_string(),
        cwd: value_str(value, &["cwd", "foreground_cwd"])
            .unwrap_or("")
            .to_string(),
        focused: value_bool(value, &["focused"]).unwrap_or(false),
        agent_status: value_str(value, &["agent_status"])
            .unwrap_or("unknown")
            .to_string(),
        pane_count: value_u64(value, &["pane_count"]).unwrap_or(0) as usize,
        tab_count: value_u64(value, &["tab_count"]).unwrap_or(0) as usize,
        active_tab_id: value_str(value, &["active_tab_id"]).map(str::to_string),
    }
}

fn parse_tab(value: &Value) -> TuiTab {
    TuiTab {
        id: value_str(value, &["tab_id"])
            .unwrap_or_default()
            .to_string(),
        workspace_id: value_str(value, &["workspace_id"])
            .unwrap_or_default()
            .to_string(),
        label: value_str(value, &["label"]).unwrap_or("Tab").to_string(),
        focused: value_bool(value, &["focused"]).unwrap_or(false),
        pane_count: value_u64(value, &["pane_count"]).unwrap_or(0) as usize,
        agent_status: value_str(value, &["agent_status"])
            .unwrap_or("unknown")
            .to_string(),
    }
}

fn parse_pane(value: &Value) -> TuiPane {
    TuiPane {
        id: value_str(value, &["pane_id"])
            .unwrap_or_default()
            .to_string(),
        terminal_id: value_str(value, &["terminal_id"])
            .unwrap_or_default()
            .to_string(),
        workspace_id: value_str(value, &["workspace_id"])
            .unwrap_or_default()
            .to_string(),
        tab_id: value_str(value, &["tab_id"])
            .unwrap_or_default()
            .to_string(),
        label: value_str(value, &["label"]).map(str::to_string),
        agent: value_str(value, &["agent"]).map(str::to_string),
        display_agent: value_str(value, &["display_agent"]).map(str::to_string),
        agent_status: value_str(value, &["agent_status"])
            .unwrap_or("unknown")
            .to_string(),
        cwd: value_str(value, &["foreground_cwd", "cwd"])
            .unwrap_or("")
            .to_string(),
        focused: value_bool(value, &["focused"]).unwrap_or(false),
    }
}

fn parse_agent(value: &Value) -> TuiAgent {
    TuiAgent {
        pane_id: value_str(value, &["pane_id"])
            .unwrap_or_default()
            .to_string(),
        workspace_id: value_str(value, &["workspace_id"])
            .unwrap_or_default()
            .to_string(),
        tab_id: value_str(value, &["tab_id"])
            .unwrap_or_default()
            .to_string(),
        terminal_id: value_str(value, &["terminal_id"])
            .unwrap_or_default()
            .to_string(),
        agent: value_str(value, &["agent"]).map(str::to_string),
        display_agent: value_str(value, &["display_agent"]).map(str::to_string),
        status: value_str(value, &["agent_status"])
            .unwrap_or("unknown")
            .to_string(),
        title: value_str(value, &["title", "name"]).map(str::to_string),
        cwd: value_str(value, &["foreground_cwd", "cwd"])
            .unwrap_or("")
            .to_string(),
        focused: value_bool(value, &["focused"]).unwrap_or(false),
    }
}

fn value_str<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_str))
        .filter(|value| !value.is_empty())
}

fn value_u64(value: &Value, keys: &[&str]) -> Option<u64> {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_u64))
}

fn value_bool(value: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| value.get(key).and_then(Value::as_bool))
}

fn move_index(current: usize, len: usize, delta: isize) -> usize {
    if len == 0 {
        return 0;
    }
    let current = current.min(len - 1) as isize;
    (current + delta).clamp(0, len as isize - 1) as usize
}

fn panel<'a>(title: &'a str, p: &Palette) -> Block<'a> {
    Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(p.border))
        .style(Style::default().fg(p.text).bg(p.panel_bg))
}

fn status_dot(status: &str, p: &Palette) -> (&'static str, Style) {
    match status {
        "blocked" => ("●", Style::default().fg(p.red)),
        "working" => ("●", Style::default().fg(p.yellow)),
        "idle" => ("○", Style::default().fg(p.green)),
        "done" => ("●", Style::default().fg(p.teal)),
        _ => ("·", Style::default().fg(p.muted)),
    }
}

fn agent_icon(status: &str, tick: u64, p: &Palette) -> (&'static str, Style) {
    match status {
        "blocked" => ("◉", Style::default().fg(p.red)),
        "working" => (
            SPINNERS[((tick / 2) as usize) % SPINNERS.len()],
            Style::default().fg(p.yellow),
        ),
        "idle" => ("✓", Style::default().fg(p.green)),
        "done" => ("●", Style::default().fg(p.teal)),
        _ => ("○", Style::default().fg(p.muted)),
    }
}

fn status_style(status: &str, p: &Palette) -> Style {
    match status {
        "blocked" => Style::default().fg(p.red).add_modifier(Modifier::BOLD),
        "working" => Style::default().fg(p.yellow).add_modifier(Modifier::BOLD),
        "idle" => Style::default().fg(p.green),
        "done" => Style::default().fg(p.teal),
        _ => Style::default().fg(p.muted),
    }
}

fn truncate(value: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    let mut out = String::new();
    for ch in value.chars() {
        if out.chars().count() + 1 >= max_width {
            out.push('…');
            return out;
        }
        out.push(ch);
    }
    out
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
mod tests {
    use super::*;
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
    use ratatui::backend::TestBackend;
    use ratatui::style::Color;
    use ratatui::Terminal;
    use serde_json::json;

    #[test]
    fn parses_snapshot_for_tui_lists() {
        let snapshot = TuiSnapshot::from_backend_response(&json!({
            "type": "session_snapshot",
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"working","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"working"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"working","foreground_cwd":"/repo","focused":true}],
                "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"working","cwd":"/repo","focused":true}]
            }
        }));

        assert_eq!(snapshot.workspaces[0].label, "Repo");
        assert_eq!(snapshot.workspace_tabs("ws_1").len(), 1);
        assert_eq!(snapshot.workspace_panes("ws_1")[0].terminal_id, "term_1");
        assert_eq!(snapshot.agents[0].display_agent.as_deref(), Some("jcode"));
    }

    #[test]
    fn maps_keys_to_terminal_bytes() {
        assert_eq!(
            key_to_terminal_bytes(KeyEvent::from(KeyCode::Char('x'))),
            Some(b"x".to_vec())
        );
        assert_eq!(
            key_to_terminal_bytes(KeyEvent::from(KeyCode::Enter)),
            Some(b"\r".to_vec())
        );
        assert_eq!(
            key_to_terminal_bytes(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)),
            Some(vec![3])
        );
    }

    #[test]
    fn ctrl_b_toggles_menu_and_is_detectable_before_terminal_input() {
        let key = KeyEvent::new(KeyCode::Char('b'), KeyModifiers::CONTROL);
        assert!(is_menu_key(key));

        let client = BackendClient::builtin_session(None);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.handle_key(key);
        assert_eq!(app.mode, TuiMode::Help);
        app.handle_key(key);
        assert_eq!(app.mode, TuiMode::Navigate);

        app.mode = TuiMode::Attach;
        app.handle_key(key);
        assert_eq!(app.mode, TuiMode::Help);
    }

    #[test]
    fn render_smoke_contains_herdr_chrome() {
        let backend = TestBackend::new(100, 28);
        let mut terminal = Terminal::new(backend).unwrap();
        let client = BackendClient::builtin_session(None);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = TuiSnapshot::from_backend_response(&json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"idle","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"idle"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}],
                "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"idle","cwd":"/repo","focused":true}]
            }
        }));
        app.pane_tail = vec!["Session ready".to_string()];

        terminal.draw(|frame| render(frame, &app)).unwrap();
        let rendered = format!("{:?}", terminal.backend().buffer());
        assert!(rendered.contains("Workspaces"));
        assert!(rendered.contains("Agents"));
        assert!(rendered.contains("Session ready"));
    }

    #[test]
    fn snapshot_summary_reports_counts() {
        let snapshot = TuiSnapshot {
            workspaces: vec![TuiWorkspace {
                id: "ws".to_string(),
                label: "Repo".to_string(),
                cwd: "/repo".to_string(),
                focused: true,
                agent_status: "idle".to_string(),
                pane_count: 1,
                tab_count: 1,
                active_tab_id: Some("tab".to_string()),
            }],
            tabs: vec![],
            panes: vec![],
            agents: vec![],
        };
        let summary = snapshot_summary(
            &snapshot,
            Some(&json!({"version":"builtin-0.1.0","protocol":16})),
        );
        assert!(summary.contains("backend builtin-0.1.0 protocol 16"));
        assert!(summary.contains("1 workspaces"));
    }

    #[test]
    fn text_snapshot_includes_selected_agent_and_terminal_output() {
        let client = BackendClient::builtin_session(None);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        app.snapshot = TuiSnapshot::from_backend_response(&json!({
            "snapshot": {
                "workspaces": [{"workspace_id":"ws_1","label":"Repo","cwd":"/repo","focused":true,"agent_status":"working","pane_count":1,"tab_count":1,"active_tab_id":"tab_1"}],
                "tabs": [{"tab_id":"tab_1","workspace_id":"ws_1","label":"Shell","focused":true,"pane_count":1,"agent_status":"working"}],
                "panes": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"working","cwd":"/repo","focused":true}],
                "agents": [{"pane_id":"pane_1","terminal_id":"term_1","workspace_id":"ws_1","tab_id":"tab_1","agent":"jcode","display_agent":"jcode","agent_status":"working","cwd":"/repo","focused":true}]
            }
        }));
        app.pane_tail = vec![
            "Session ready".to_string(),
            "··● bash ●·· · 12s".to_string(),
        ];

        let snapshot = app.text_snapshot();
        assert!(snapshot.contains("workspaces=1 tabs=1 panes=1 agents=1"));
        assert!(snapshot.contains("agent jcode · working"));
        assert!(snapshot.contains("terminal term_1"));
        assert!(snapshot.contains("··● bash ●·· · 12s"));
    }

    #[test]
    fn terminal_output_ingest_replaces_full_frame_and_appends_delta() {
        let client = BackendClient::builtin_session(None);
        let mut app = TuiApp::new(client, Duration::from_secs(1));
        assert!(app.take_dirty());
        assert!(!app.take_dirty());

        app.ingest_terminal_output(&TerminalOutput {
            seq: 1,
            width: 120,
            height: 32,
            full: true,
            bytes: b"old\r\x1b[2KSession ready\n\x1b[33mworking\x1b[0m".to_vec(),
        });
        assert_eq!(app.pane_tail, vec!["Session ready", "working"]);
        assert!(app.take_dirty());

        app.ingest_terminal_output(&TerminalOutput {
            seq: 2,
            width: 120,
            height: 32,
            full: false,
            bytes: b"\nnext line".to_vec(),
        });
        assert_eq!(app.pane_tail, vec!["Session ready", "working", "next line"]);
    }

    #[test]
    fn terminal_output_ingest_merges_character_deltas_on_same_line() {
        let client = BackendClient::builtin_session(None);
        let mut app = TuiApp::new(client, Duration::from_secs(1));

        app.ingest_terminal_output(&TerminalOutput {
            seq: 1,
            width: 120,
            height: 32,
            full: true,
            bytes: b"prompt ".to_vec(),
        });
        app.ingest_terminal_output(&TerminalOutput {
            seq: 2,
            width: 120,
            height: 32,
            full: false,
            bytes: b"a".to_vec(),
        });
        app.ingest_terminal_output(&TerminalOutput {
            seq: 3,
            width: 120,
            height: 32,
            full: false,
            bytes: b"b".to_vec(),
        });
        app.ingest_terminal_output(&TerminalOutput {
            seq: 4,
            width: 120,
            height: 32,
            full: false,
            bytes: b"\rprompt abc".to_vec(),
        });

        assert_eq!(app.pane_tail, vec!["prompt abc"]);
    }

    #[test]
    fn terminal_output_styled_lines_parse_sgr_colors_and_styles() {
        let lines = terminal_output_styled_lines_lossy(
            "plain \u{1b}[31;1mred\u{1b}[0m \u{1b}[38;5;42midx\u{1b}[0m \u{1b}[48;2;1;2;3mbg\u{1b}[0m",
        );
        assert_eq!(lines.len(), 1);
        let spans = &lines[0];
        assert_eq!(
            spans
                .iter()
                .map(|span| span.text.as_str())
                .collect::<Vec<_>>(),
            vec!["plain ", "red", " ", "idx", " ", "bg"]
        );
        assert_eq!(spans[1].style.fg, Some(Color::Indexed(1)));
        assert!(spans[1].style.bold);
        assert_eq!(spans[3].style.fg, Some(Color::Indexed(42)));
        assert_eq!(spans[5].style.bg, Some(Color::Rgb(1, 2, 3)));
    }

    #[test]
    fn terminal_output_ingest_preserves_color_spans_for_rendering() {
        let client = BackendClient::builtin_session(None);
        let mut app = TuiApp::new(client, Duration::from_secs(1));

        app.ingest_terminal_output(&TerminalOutput {
            seq: 1,
            width: 120,
            height: 32,
            full: true,
            bytes: b"ok \x1b[32mgreen\x1b[0m".to_vec(),
        });

        assert_eq!(app.pane_tail, vec!["ok green"]);
        assert_eq!(app.pane_tail_styles[0][1].text, "green");
        assert_eq!(app.pane_tail_styles[0][1].style.fg, Some(Color::Indexed(2)));
    }
}
