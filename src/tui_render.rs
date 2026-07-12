use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;

use crate::tui::{SidebarFocus, TuiApp, TuiMode};
use crate::tui_terminal::styled_terminal_line;
use crate::tui_theme::Palette;

const SPINNERS: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
