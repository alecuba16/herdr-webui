use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;

use crate::tui::{SidebarFocus, TuiApp, TuiMode, TuiScreen};
use crate::tui_keys::help_rows;
use crate::tui_panels::GitView;
use crate::tui_terminal::styled_terminal_line;
use crate::tui_theme::Palette;

const SPINNERS: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_DIFF_LINES: usize = 400;

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
    match app.screen {
        TuiScreen::Terminal => render_main(frame, main, app, p),
        TuiScreen::Files => render_files_screen(frame, main, app, p),
        TuiScreen::Git => render_git_screen(frame, main, app, p),
    }
    render_footer(frame, footer, app, p);
    if app.mode == TuiMode::Help {
        render_help(frame, area, p);
    }
    if app.commit_input.is_some() {
        render_commit_input(frame, area, app, p);
    }
    if app.prompt_input.is_some() {
        render_prompt_input(frame, area, app, p);
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

fn render_files_screen(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    if area.is_empty() {
        return;
    }
    let [tree_area, preview_area] = if area.width >= 90 {
        let [tree, preview]: [Rect; 2] =
            Layout::horizontal([Constraint::Percentage(45), Constraint::Percentage(55)])
                .areas(area);
        [tree, preview]
    } else {
        [area, Rect::new(0, 0, 0, 0)]
    };
    render_file_tree(frame, tree_area, app, p);
    if !preview_area.is_empty() {
        render_file_preview(frame, preview_area, app, p);
    }
}

fn render_file_tree(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let explorer = &app.file_explorer;
    let title = format!(
        " Files · {} ",
        if explorer.root_path.is_empty() {
            truncate(&explorer.cwd, (area.width.saturating_sub(12)) as usize)
        } else {
            truncate(
                &explorer.root_path,
                (area.width.saturating_sub(12)) as usize,
            )
        }
    );
    let mut lines = Vec::new();
    if explorer.filter_active {
        lines.push(Line::from(vec![
            Span::styled("filter: ", Style::default().fg(p.muted)),
            Span::styled(
                format!("{}█", explorer.filter),
                Style::default().fg(p.accent),
            ),
        ]));
        lines.push(Line::from(Span::styled(
            "Enter applies · Esc cancels",
            Style::default().fg(p.muted),
        )));
    } else if explorer.search_mode {
        lines.push(Line::from(Span::styled(
            format!("search results for '{}'", explorer.filter),
            Style::default().fg(p.muted),
        )));
    }
    let header_height = lines.len() as u16;
    let block = panel(&title, p).border_style(Style::default().fg(p.accent));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let list_area = if header_height > 0 {
        let [header, rest] =
            Layout::vertical([Constraint::Length(header_height), Constraint::Min(1)]).areas(inner);
        frame.render_widget(Paragraph::new(lines), header);
        rest
    } else {
        inner
    };
    let visible_height = list_area.height as usize;
    let start = if explorer.entries.len() > visible_height && visible_height > 0 {
        explorer.selected.saturating_sub(visible_height / 2)
    } else {
        0
    };
    let mut rendered: Vec<Line> = Vec::new();
    for (index, entry) in explorer.entries.iter().enumerate().skip(start) {
        if rendered.len() >= visible_height {
            break;
        }
        let indent = "  ".repeat(entry.level);
        let icon = if entry.is_dir {
            if entry.expanded {
                "▾"
            } else {
                "▸"
            }
        } else {
            " "
        };
        let name_style = if entry.is_dir {
            Style::default().fg(p.accent)
        } else {
            Style::default().fg(p.text)
        };
        let prefix = if index == explorer.selected {
            "> "
        } else {
            "  "
        };
        rendered.push(Line::from(vec![
            Span::styled(prefix, Style::default().fg(p.accent)),
            Span::raw(indent),
            Span::styled(icon, Style::default().fg(p.muted)),
            Span::raw(" "),
            Span::styled(truncate(&entry.name, 48), name_style),
        ]));
    }
    frame.render_widget(Paragraph::new(rendered), list_area);
    if explorer.entries.is_empty() && !explorer.filter_active {
        let empty = Paragraph::new(Span::styled(
            "No entries. Ctrl+B r refreshes, Ctrl+B / filters.",
            Style::default().fg(p.muted),
        ));
        frame.render_widget(empty, inner);
    }
}

fn render_file_preview(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let explorer = &app.file_explorer;
    let preview = &explorer.preview;
    let dirty_marker = if preview.dirty { " *" } else { "" };
    let title = match &preview.path {
        Some(path) => {
            if explorer.edit_active {
                format!(" Editing · {}{dirty_marker} ", truncate(path, 44))
            } else {
                format!(" Preview · {} ", truncate(path, 48))
            }
        }
        None => " Preview ".to_string(),
    };
    let block = panel(&title, p);
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let mut lines = Vec::new();
    if preview.binary {
        lines.push(Line::from(Span::styled(
            "binary file",
            Style::default().fg(p.muted),
        )));
    } else if let Some(path) = &preview.path {
        // Cursor position decides the scrolled window while editing.
        let cursor_line = if explorer.edit_active {
            preview.content[..explorer.edit_cursor.min(preview.content.len())]
                .matches('\n')
                .count()
        } else {
            0
        };
        let visible = inner.height as usize;
        let start = if explorer.edit_active {
            cursor_line.saturating_sub(visible.saturating_sub(1))
        } else {
            0
        };
        for (index, line) in preview.content.lines().enumerate().skip(start) {
            let number = format!("{:>4} ", index + 1);
            let number_style = if explorer.edit_active && index == cursor_line {
                Style::default().fg(p.accent).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(p.muted)
            };
            lines.push(Line::from(vec![
                Span::styled(number, number_style),
                Span::styled(
                    truncate(line, (inner.width as usize).saturating_sub(6)),
                    Style::default().fg(p.text),
                ),
            ]));
            if lines.len() >= visible {
                break;
            }
        }
        if explorer.edit_active {
            lines.push(Line::from(Span::styled(
                "Ctrl-S save · Esc stop editing",
                Style::default().fg(p.accent),
            )));
        }
        if preview.truncated {
            lines.push(Line::from(Span::styled(
                "… file truncated",
                Style::default().fg(p.yellow),
            )));
        }
        if lines.is_empty() {
            lines.push(Line::from(Span::styled(
                format!("{path} is empty"),
                Style::default().fg(p.muted),
            )));
        }
    } else {
        lines.push(Line::from(Span::styled(
            "Select a file with j/k and press Enter to preview.",
            Style::default().fg(p.muted),
        )));
        lines.push(Line::from(Span::styled(
            "Enter on a folder expands it; on .. you go up.",
            Style::default().fg(p.muted),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .wrap(Wrap { trim: false }),
        inner,
    );
}

fn render_git_screen(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    if area.is_empty() {
        return;
    }
    let [tab_bar, content] =
        Layout::vertical([Constraint::Length(1), Constraint::Min(1)]).areas(area);
    render_git_tab_bar(frame, tab_bar, app, p);
    match app.git_panel.view {
        GitView::Changes => {
            let [list_area, diff_area] =
                Layout::horizontal([Constraint::Percentage(35), Constraint::Percentage(65)])
                    .areas(content);
            render_git_changes(frame, list_area, diff_area, app, p);
        }
        GitView::Log => render_git_log(frame, content, app, p),
        GitView::Branches => render_git_branches(frame, content, app, p),
        GitView::Stash => render_git_stash(frame, content, app, p),
        GitView::History => {
            let [list_area, diff_area] =
                Layout::horizontal([Constraint::Percentage(35), Constraint::Percentage(65)])
                    .areas(content);
            render_git_history(frame, list_area, diff_area, app, p);
        }
    }
}

/// Per-file history (webui history tab): commit list plus a diff pane
/// showing the selected commit's changes to the file (Enter).
fn render_git_history(
    frame: &mut Frame<'_>,
    list_area: Rect,
    diff_area: Rect,
    app: &TuiApp,
    p: &Palette,
) {
    let panel = &app.git_panel;
    let items = panel
        .commits
        .iter()
        .map(|commit| {
            ListItem::new(Line::from(vec![
                Span::styled(
                    format!("{} ", &commit.hash[..commit.hash.len().min(7)]),
                    Style::default().fg(p.yellow),
                ),
                Span::styled(truncate(&commit.message, 44), Style::default().fg(p.text)),
                Span::styled(
                    format!(" · {}", truncate(&commit.author, 12)),
                    Style::default().fg(p.muted),
                ),
            ]))
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(panel.commit_selected));
    }
    let file = panel.history_file.as_deref().unwrap_or("");
    let title = if file.is_empty() {
        " History ".to_string()
    } else {
        format!(" History · {} ", truncate(file, 40))
    };
    let list = List::new(items)
        .block(panel_block(&title, p))
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .highlight_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD))
        .highlight_symbol("> ");
    frame.render_stateful_widget(list, list_area, &mut state);

    let diff_title = format!(" Diff · {} ", truncate(&panel.diff_title, 40));
    render_diff_pane(
        frame,
        diff_area,
        &diff_title,
        &panel.diff_lines,
        p,
        "Select a commit to load its diff (Enter).",
    );
}

fn render_git_tab_bar(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let panel = &app.git_panel;
    let mut spans = vec![Span::styled(
        format!(" {} ", truncate(&panel.cwd, 28)),
        Style::default()
            .fg(p.panel_bg)
            .bg(p.accent)
            .add_modifier(Modifier::BOLD),
    )];
    spans.push(Span::raw(" "));
    for view in GitView::all() {
        let active = panel.view == view;
        let style = if active {
            Style::default()
                .fg(p.panel_bg)
                .bg(p.teal)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(p.muted).bg(p.panel_alt)
        };
        spans.push(Span::styled(format!(" {} ", view.title()), style));
        spans.push(Span::raw(" "));
    }
    let branch = if panel.branch.is_empty() {
        "(detached)"
    } else {
        &panel.branch
    };
    spans.push(Span::styled(
        format!(" {branch} ",),
        Style::default().fg(p.green).bg(p.panel_alt),
    ));
    if !panel.upstream.is_empty() {
        spans.push(Span::styled(
            format!(" ↑{} ↓{} ", panel.ahead, panel.behind),
            Style::default().fg(p.yellow).bg(p.panel_alt),
        ));
    }
    if !panel.state.is_empty() {
        let style = if panel.state == "clean" {
            Style::default().fg(p.green).bg(p.panel_alt)
        } else if panel.state == "conflicts" {
            Style::default()
                .fg(p.red)
                .bg(p.panel_alt)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(p.yellow).bg(p.panel_alt)
        };
        spans.push(Span::styled(format!(" {} ", panel.state), style));
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

fn render_git_changes(
    frame: &mut Frame<'_>,
    list_area: Rect,
    diff_area: Rect,
    app: &TuiApp,
    p: &Palette,
) {
    let panel = &app.git_panel;
    let items = panel
        .files
        .iter()
        .map(|entry| {
            let (letter, style) = match entry.status {
                crate::tui_panels::GitFileStatus::Staged => ('S', Style::default().fg(p.green)),
                crate::tui_panels::GitFileStatus::Unstaged => ('M', Style::default().fg(p.yellow)),
                crate::tui_panels::GitFileStatus::Untracked => ('U', Style::default().fg(p.teal)),
                crate::tui_panels::GitFileStatus::Conflicted => ('C', Style::default().fg(p.red)),
            };
            ListItem::new(Line::from(vec![
                Span::styled(format!("{letter} "), style.add_modifier(Modifier::BOLD)),
                Span::styled(
                    truncate(&entry.path, (list_area.width.saturating_sub(6)) as usize),
                    Style::default().fg(p.text),
                ),
            ]))
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(panel.file_selected));
    }
    let title = format!(" Changes · {} files ", panel.files.len());
    let list = List::new(items)
        .block(panel_block(&title, p))
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .highlight_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD))
        .highlight_symbol("> ");
    frame.render_stateful_widget(list, list_area, &mut state);

    let diff_title = if panel.show_blame {
        format!(" Diff · {} [blame] ", truncate(&panel.diff_title, 32))
    } else {
        format!(" Diff · {} ", truncate(&panel.diff_title, 40))
    };
    let blame = if panel.show_blame {
        panel
            .blame_path
            .as_deref()
            // Annotate only when the blamed file is the diff target,
            // mirroring the webui per-path blame cache.
            .filter(|path| panel.diff_title == *path)
            .map(|_| &panel.blame_authors)
    } else {
        None
    };
    render_diff_pane_full(
        frame,
        diff_area,
        &diff_title,
        &panel.diff_lines,
        Some(&panel.diff_meta),
        blame,
        p,
        "Select a file to load its diff (Enter).",
    );
}

/// Shared diff pane used by the Changes and History views. Lines keep
/// their git prefixes so the `+`/`-`/`@@` coloring applies.
fn render_diff_pane(
    frame: &mut Frame<'_>,
    diff_area: Rect,
    diff_title: &str,
    diff_lines: &[String],
    p: &Palette,
    empty_hint: &str,
) {
    render_diff_pane_full(
        frame, diff_area, diff_title, diff_lines, None, None, p, empty_hint,
    )
}

/// Full diff pane: with blame enabled, each line is prefixed with the
/// author of `new_line || old_line` like the webui blame view. The caller
/// passes the blame map only when it belongs to the file being shown.
#[allow(clippy::too_many_arguments)]
fn render_diff_pane_full(
    frame: &mut Frame<'_>,
    diff_area: Rect,
    diff_title: &str,
    diff_lines: &[String],
    diff_meta: Option<&[Option<crate::tui_panels::GitDiffLineMeta>]>,
    blame: Option<&std::collections::HashMap<usize, String>>,
    p: &Palette,
    empty_hint: &str,
) {
    let block = panel_block(diff_title, p);
    let inner = block.inner(diff_area);
    frame.render_widget(block, diff_area);
    let mut lines = Vec::new();
    for (index, line) in diff_lines.iter().take(MAX_DIFF_LINES).enumerate() {
        let style = match line.chars().next() {
            Some('+') => Style::default().fg(p.green),
            Some('-') => Style::default().fg(p.red),
            Some('@') => Style::default().fg(p.teal),
            _ => Style::default().fg(p.text),
        };
        // Blame annotation (webui `blameName`): the author for the line
        // number, first two words, shown when blame is toggled on for
        // the file the diff shows.
        let author_span = blame.and_then(|authors| {
            let meta = diff_meta.and_then(|meta| meta.get(index))?.as_ref()?;
            let line_no = meta.new_line.or(meta.old_line)?;
            let author = authors.get(&line_no)?;
            let short = author
                .split_whitespace()
                .take(2)
                .collect::<Vec<_>>()
                .join(" ");
            (!short.is_empty())
                .then(|| Span::styled(format!("{short:<12} "), Style::default().fg(p.muted)))
        });
        let mut spans = Vec::with_capacity(2);
        if let Some(span) = author_span {
            spans.push(span);
        }
        let visible_width = inner.width as usize;
        let text_len = spans.iter().map(|s| s.content.len()).sum::<usize>();
        spans.push(Span::styled(
            truncate(line, visible_width.saturating_sub(text_len)),
            style,
        ));
        lines.push(Line::from(spans));
    }
    if lines.is_empty() {
        lines.push(Line::from(Span::styled(
            empty_hint,
            Style::default().fg(p.muted),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .wrap(Wrap { trim: false }),
        inner,
    );
}

fn render_git_log(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let panel = &app.git_panel;
    let items = panel
        .commits
        .iter()
        .map(|commit| {
            let labels = if commit.labels.is_empty() {
                String::new()
            } else {
                format!(" ({})", commit.labels.join(", "))
            };
            ListItem::new(Line::from(vec![
                Span::styled(
                    format!("{} ", &commit.hash[..commit.hash.len().min(7)]),
                    Style::default().fg(p.yellow),
                ),
                Span::styled(truncate(&commit.message, 44), Style::default().fg(p.text)),
                Span::styled(labels, Style::default().fg(p.teal)),
                Span::styled(
                    format!(" · {}", truncate(&commit.author, 12)),
                    Style::default().fg(p.muted),
                ),
            ]))
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(panel.commit_selected));
    }
    let list = List::new(items)
        .block(panel_block(" Log ", p))
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .highlight_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD))
        .highlight_symbol("> ");
    frame.render_stateful_widget(list, area, &mut state);
}

fn render_git_branches(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let panel = &app.git_panel;
    let items = panel
        .branches
        .iter()
        .map(|branch| {
            let marker = if branch.current {
                "*"
            } else if branch.remote {
                "r"
            } else {
                " "
            };
            let style = if branch.current {
                Style::default().fg(p.accent).add_modifier(Modifier::BOLD)
            } else if branch.remote {
                Style::default().fg(p.muted)
            } else {
                Style::default().fg(p.text)
            };
            let pushed = if branch.current || branch.pushed {
                ""
            } else {
                " ·unpushed"
            };
            ListItem::new(Line::from(vec![
                Span::styled(format!("{marker} "), Style::default().fg(p.teal)),
                Span::styled(truncate(&branch.name, 40), style),
                Span::styled(pushed, Style::default().fg(p.red)),
            ]))
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(panel.branch_selected));
    }
    let list = List::new(items)
        .block(panel_block(
            " Branches · Enter switches · Ctrl+B v switches selected ",
            p,
        ))
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .highlight_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD))
        .highlight_symbol("> ");
    frame.render_stateful_widget(list, area, &mut state);
}

fn render_git_stash(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let panel = &app.git_panel;
    let items = panel
        .stashes
        .iter()
        .map(|stash| {
            ListItem::new(Line::from(vec![
                Span::styled(
                    format!("{} ", truncate(&stash.name, 14)),
                    Style::default().fg(p.yellow),
                ),
                Span::styled(truncate(&stash.message, 50), Style::default().fg(p.text)),
            ]))
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(panel.stash_selected));
    }
    let list = List::new(items)
        .block(panel_block(" Stash · a apply · x drop ", p))
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .highlight_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD))
        .highlight_symbol("> ");
    frame.render_stateful_widget(list, area, &mut state);
}

/// Render the active prompt modal. Only called while `app.prompt_input`
/// is `Some` (the `render` entry point gates on it).
fn render_prompt_input(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let prompt = app
        .prompt_input
        .as_ref()
        .expect("render_prompt_input requires an active prompt");
    let width = area.width.min(64);
    let height = 6;
    let rect = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    // Show the subject of the action (file/branch/stash) above the input.
    let subject = match prompt.kind {
        crate::tui::PromptKind::RenameFile => app
            .file_explorer
            .selected_entry()
            .map(|entry| entry.path.clone())
            .unwrap_or_default(),
        crate::tui::PromptKind::ConfirmDeleteFile => app
            .file_explorer
            .selected_entry()
            .map(|entry| entry.path.clone())
            .unwrap_or_default(),
        crate::tui::PromptKind::ConfirmDeleteBranch => app
            .git_panel
            .branches
            .get(app.git_panel.branch_selected)
            .map(|entry| entry.name.clone())
            .unwrap_or_default(),
        crate::tui::PromptKind::ConfirmDropStash => app
            .git_panel
            .stashes
            .get(app.git_panel.stash_selected)
            .map(|entry| entry.name.clone())
            .unwrap_or_default(),
    };
    let title = format!(" {} ", prompt.kind.title());
    let lines = vec![
        Line::from(Span::styled(
            truncate(&subject, (width.saturating_sub(4)) as usize),
            Style::default().fg(p.muted),
        )),
        Line::from(Span::styled(
            format!("{}█", prompt.text),
            Style::default().fg(p.text),
        )),
        Line::from(Span::styled(
            prompt.kind.hint(),
            Style::default().fg(p.muted),
        )),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .block(panel(&title, p))
            .style(Style::default().fg(p.text).bg(p.panel_bg)),
        rect,
    );
}

/// Render the commit modal. Only called while `app.commit_input` is
/// `Some` (the `render` entry point gates on it).
fn render_commit_input(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let commit = app
        .commit_input
        .as_ref()
        .expect("render_commit_input requires an active commit");
    let width = area.width.min(64);
    let height = 7;
    let rect = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    let title = if commit.amend {
        " Amend commit message "
    } else {
        " Commit message "
    };
    let lines = vec![
        Line::from(Span::styled(
            format!("{}█", commit.text),
            Style::default().fg(p.text),
        )),
        Line::from(""),
        Line::from(Span::styled(
            "Enter commit · Esc cancel · Ctrl-U clear",
            Style::default().fg(p.muted),
        )),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .block(panel(title, p))
            .style(Style::default().fg(p.text).bg(p.panel_bg)),
        rect,
    );
}

fn panel_block<'a>(title: &'a str, p: &Palette) -> Block<'a> {
    panel(title, p).border_style(Style::default().fg(p.accent))
}

fn render_footer(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let mode = match app.mode {
        TuiMode::Navigate => "NAV",
        TuiMode::Attach => "ATTACH",
        TuiMode::Help => "HELP",
    };
    let prefix = if app.prefix.is_armed() {
        "Ctrl+B> "
    } else {
        ""
    };
    let help = match (app.mode, app.screen) {
        (TuiMode::Attach, TuiScreen::Terminal) => {
            " Ctrl+B prefix · Ctrl-G detach · type sends input "
        }
        (_, TuiScreen::Files) => " Ctrl+B prefix · j/k move · Enter open · h/u up · q terminal ",
        (_, TuiScreen::Git) => {
            " Ctrl+B prefix · Tab view · s stage · d discard · c commit · p pull · P push "
        }
        (TuiMode::Navigate, _) => " Ctrl+B prefix · ↑/↓ j/k select · Enter attach · q quit ",
        (TuiMode::Help, _) => " Esc closes help ",
    };
    let message = app.error.as_deref().unwrap_or(&app.status);
    let line = Line::from(vec![
        Span::styled(
            format!(" {mode}·{} ", app.screen.title()),
            Style::default()
                .fg(p.panel_bg)
                .bg(p.accent)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("{prefix}{help}"),
            Style::default().fg(p.text).bg(p.panel_alt),
        ),
        Span::styled(
            truncate(message, area.width.saturating_sub(52) as usize),
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
    let rows = help_rows();
    let width = area.width.min(72);
    let height = area.height.min((rows.len() as u16 + 4).min(30));
    let rect = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    let mut lines = vec![Line::from(Span::styled(
        "Herdr WebUI TUI",
        Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
    ))];
    for (keys, description) in rows {
        if keys.is_empty() {
            lines.push(Line::from(""));
        } else {
            lines.push(Line::from(vec![
                Span::styled(format!("  {keys:<16}"), Style::default().fg(p.accent)),
                Span::raw(description),
            ]));
        }
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(panel(" Help · Esc closes ", p))
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
