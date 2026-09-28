use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;

use crate::tui::panels::files::{content_rows, ContentRow, SearchKind};
use crate::tui::panels::GitView;
use crate::tui::terminal::styled_terminal_line;
use crate::tui::theme::Palette;
use crate::tui::workspace::WorkspaceCreateStage;
use crate::tui::{SidebarFocus, TuiApp, TuiMode, TuiScreen};

const SPINNERS: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_DIFF_LINES: usize = 400;

pub fn render(frame: &mut Frame<'_>, app: &TuiApp) {
    let p = &app.palette;
    let area = frame.area();
    let [body, footer] = Layout::vertical([Constraint::Min(1), Constraint::Length(1)]).areas(area);
    // Webui sidebar (KeyB) collapse: when hidden, the main screen takes
    // the full body width and the sidebar column is not rendered.
    let [sidebar, main] = if app.sidebar_collapsed {
        Layout::horizontal([Constraint::Length(0), Constraint::Min(1)]).areas(body)
    } else {
        let sidebar_width = if body.width >= 100 {
            34
        } else {
            28.min(body.width / 2)
        };
        Layout::horizontal([Constraint::Length(sidebar_width), Constraint::Min(1)]).areas(body)
    };
    if !app.sidebar_collapsed {
        render_sidebar(frame, sidebar, app, p);
    }
    match app.screen {
        TuiScreen::Terminal => render_main(frame, main, app, p),
        TuiScreen::Files => render_files_screen(frame, main, app, p),
        TuiScreen::Git => render_git_screen(frame, main, app, p),
    }
    render_footer(frame, footer, app, p);
    if app.mode == TuiMode::Help {
        render_help(frame, area, p, &app.help_filter, app.help_scroll);
    }
    if app.mode == TuiMode::ConfirmQuit {
        render_confirm_quit(frame, area, p);
    }
    if app.mode == TuiMode::Settings {
        render_settings(frame, area, app, p);
    }
    if app.mode == TuiMode::WorktreeList {
        render_worktree_list(frame, area, app, p);
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
    // Content-search results replace the tree while visible (webui
    // switches the browser body to the HerdrContentSearch view).
    if explorer.search_mode && explorer.search_kind == SearchKind::Content {
        render_content_search(frame, area, app, p);
        return;
    }
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
        lines.push(Line::from(vec![
            Span::styled(
                format!("searching {} · ", explorer.search_kind.label()),
                Style::default().fg(p.teal),
            ),
            Span::styled("Enter applies · Esc cancels", Style::default().fg(p.muted)),
        ]));
    } else if explorer.search_mode {
        lines.push(Line::from(Span::styled(
            format!(
                "search results for '{}' in {}",
                explorer.filter,
                explorer.search_kind.label()
            ),
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
        let name_style = if let Some(status) = entry.git_status.as_deref() {
            // Webui `git-{status}` classes: modified yellow, deleted red,
            // added/untracked green, conflict orange (yellow reads clearer
            // on both TUI themes).
            match status {
                "deleted" | "conflict" => Style::default().fg(p.red),
                "modified" => Style::default().fg(p.yellow),
                "added" | "untracked" => Style::default().fg(p.green),
                _ => Style::default().fg(p.text),
            }
        } else if entry.is_dir {
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

/// Content-search results view (webui `HerdrContentSearch.render`):
/// summary line, file groups with match counts, context chunks with
/// matched lines highlighted, selection over the flat row list.
fn render_content_search(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let state = &app.file_explorer.content_search;
    let toggles = format!(
        "{}match-case{} · {}regex{}",
        if state.match_case { "[" } else { " " },
        if state.match_case { "]" } else { " " },
        if state.regex { "[" } else { " " },
        if state.regex { "]" } else { " " }
    );
    let title = format!(
        " Search {} · '{}' · {} matches in {} files ",
        app.file_explorer.search_kind.label(),
        truncate(&state.query, 24),
        state.total_matches,
        state.total_files
    );
    let block = panel(&title, p).border_style(Style::default().fg(p.accent));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    let rows = content_rows(state);
    let mut lines: Vec<Line> = Vec::new();
    // Header: summary like the webui tools line (`N matches in M files,
    // searched K files`), plus the toggle state and the pager hint.
    let more = if state.done { "" } else { " · + loads more" };
    lines.push(Line::from(vec![
        Span::styled(
            format!(
                "searched {} files{}{}",
                state.visited,
                if state.truncated {
                    " (stopped at limit)"
                } else {
                    ""
                },
                more
            ),
            Style::default().fg(p.muted),
        ),
        Span::raw("  "),
        Span::styled(toggles, Style::default().fg(p.teal)),
    ]));
    let header_height = lines.len() as u16;
    let [header_area, list_area] =
        Layout::vertical([Constraint::Length(header_height), Constraint::Min(1)]).areas(inner);
    frame.render_widget(Paragraph::new(lines), header_area);

    let visible = list_area.height as usize;
    if rows.is_empty() {
        let empty = Paragraph::new(Span::styled(
            "No content matches.",
            Style::default().fg(p.muted),
        ));
        frame.render_widget(empty, list_area);
        return;
    }
    // Keep the selection centered in view like the tree list.
    let start = if rows.len() > visible && visible > 0 {
        state.selected.saturating_sub(visible / 2)
    } else {
        0
    };
    let mut rendered: Vec<Line> = Vec::new();
    for (index, row) in rows.iter().enumerate().skip(start) {
        if rendered.len() >= visible {
            break;
        }
        let selected = index == state.selected;
        let line = match row {
            ContentRow::File(file_index) => {
                let file = &state.files[*file_index];
                let expanded = state.expanded.get(*file_index).copied().unwrap_or(true);
                let caret = if expanded { "▾" } else { "▸" };
                let trunc = if file.truncated { " …" } else { "" };
                Line::from(vec![
                    Span::styled(
                        if selected { "> " } else { "  " },
                        Style::default().fg(p.accent),
                    ),
                    Span::styled(caret, Style::default().fg(p.muted)),
                    Span::raw(" "),
                    Span::styled(
                        truncate(&file.path, 52),
                        Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
                    ),
                    Span::styled(
                        format!(
                            " {} match{}{}",
                            file.match_count,
                            if file.match_count == 1 { "" } else { "es" },
                            trunc
                        ),
                        Style::default().fg(p.muted),
                    ),
                ])
            }
            ContentRow::Line {
                file: file_index,
                line,
                matched,
            } => {
                let file = &state.files[*file_index];
                let text = file
                    .chunks
                    .iter()
                    .flat_map(|chunk| chunk.rows.iter())
                    .find(|row| row.line == *line)
                    .map(|row| row.text.clone())
                    .unwrap_or_default();
                let number = format!("{line:>5} ");
                Line::from(vec![
                    Span::styled(
                        if selected { "> " } else { "  " },
                        Style::default().fg(p.accent),
                    ),
                    Span::styled(number, Style::default().fg(p.muted)),
                    Span::styled(
                        truncate(&text, (list_area.width.saturating_sub(9)) as usize),
                        if *matched {
                            Style::default().fg(p.yellow).add_modifier(Modifier::BOLD)
                        } else {
                            Style::default().fg(p.text)
                        },
                    ),
                ])
            }
        };
        rendered.push(line);
    }
    frame.render_widget(Paragraph::new(rendered), list_area);
}

fn render_file_preview(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let explorer = &app.file_explorer;
    let preview = &explorer.preview;
    let dirty_marker = if preview.dirty { " *" } else { "" };
    // Markdown outline flip (gap 22): the webui eye toggle renders the
    // header outline; the TUI shows it in place of the raw source.
    let outline_mode = explorer.markdown_outline
        && !preview.binary
        && preview
            .path
            .as_deref()
            .is_some_and(|path| path.ends_with(".md") || path.ends_with(".markdown"));
    let title = match &preview.path {
        Some(path) => {
            if explorer.edit_active {
                format!(" Editing · {}{dirty_marker} ", truncate(path, 44))
            } else if outline_mode {
                format!(" Outline · {} ", truncate(path, 44))
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
    } else if outline_mode {
        // Header outline: level-indented headings with source line
        // numbers; an empty state explains the toggle when the file has
        // no ATX headings.
        let outline = crate::tui::panels::files::parse_markdown_outline(&preview.content);
        if outline.is_empty() {
            lines.push(Line::from(Span::styled(
                "no headings (M shows the source)",
                Style::default().fg(p.muted),
            )));
        }
        for (level, line_no, text) in outline {
            let indent = "  ".repeat(level.saturating_sub(1));
            let marker = match level {
                1 => "#",
                2 => "##",
                3 => "###",
                _ => "-",
            };
            let style = if level <= 2 {
                Style::default().fg(p.accent).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(p.text)
            };
            lines.push(Line::from(vec![
                Span::styled(format!("{line_no:>4} "), Style::default().fg(p.muted)),
                Span::styled(format!("{indent}{marker} {text}"), style),
            ]));
        }
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
        } else if let Some(jump) = explorer.preview_jump_line {
            // Content-search jump: center the target line in view.
            jump.saturating_sub(1).saturating_sub(visible / 2)
        } else {
            0
        };
        for (index, line) in preview.content.lines().enumerate().skip(start) {
            let number = format!("{:>4} ", index + 1);
            let jump_hit = !explorer.edit_active && explorer.preview_jump_line == Some(index + 1);
            let number_style = if jump_hit {
                Style::default().fg(p.yellow).add_modifier(Modifier::BOLD)
            } else if explorer.edit_active && index == cursor_line {
                Style::default().fg(p.accent).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(p.muted)
            };
            let line_style = if jump_hit {
                Style::default().fg(p.yellow).add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(p.text)
            };
            lines.push(Line::from(vec![
                Span::styled(number, number_style),
                Span::styled(
                    truncate(line, (inner.width as usize).saturating_sub(6)),
                    line_style,
                ),
            ]));
            if lines.len() >= visible {
                break;
            }
        }
        if explorer.edit_active {
            // Find bar (webui Ctrl+F toolbar): query, toggles, count.
            if explorer.editor_find.active {
                let find = &explorer.editor_find;
                let count = find.ranges.len();
                let position = if count == 0 {
                    "no matches".to_string()
                } else {
                    format!("match {}/{}", find.selected + 1, count)
                };
                let mut spans = vec![
                    Span::styled("find ".to_string(), Style::default().fg(p.muted)),
                    Span::styled(find.query.clone(), Style::default().fg(p.accent)),
                ];
                if find.match_case {
                    spans.push(Span::styled(" A", Style::default().fg(p.green)));
                }
                if find.regex {
                    spans.push(Span::styled(" X", Style::default().fg(p.green)));
                }
                spans.push(Span::styled(
                    format!("  {position}  (Enter next, Shift+Enter prev, Esc close)"),
                    Style::default().fg(p.muted),
                ));
                lines.push(Line::from(spans));
            } else {
                lines.push(Line::from(Span::styled(
                    "Ctrl-S save · Ctrl-F find · Ctrl-H replace · Esc stop editing",
                    Style::default().fg(p.accent),
                )));
            }
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
        GitView::Stash => {
            // Webui stash split view: stash list left, selected stash's
            // full diff right (Enter loads it via stash-show).
            let [list_area, diff_area] =
                Layout::horizontal([Constraint::Percentage(35), Constraint::Percentage(65)])
                    .areas(content);
            render_git_stash(frame, list_area, diff_area, app, p);
        }
        GitView::History => {
            let [list_area, diff_area] =
                Layout::horizontal([Constraint::Percentage(35), Constraint::Percentage(65)])
                    .areas(content);
            render_git_history(frame, list_area, diff_area, app, p);
        }
        GitView::Conflicts => render_git_conflicts(frame, content, app, p),
        GitView::Cleanup => render_git_cleanup(frame, content, app, p),
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
    // Yellow badge when the git cwd drifted from the workspace cwd
    // (prefix I location bar parity).
    if let Some(workspace_cwd) = app.active_cwd() {
        if workspace_cwd != panel.cwd {
            spans.push(Span::styled(
                " ≠ workspace ",
                Style::default().fg(p.yellow).bg(p.panel_alt),
            ));
            spans.push(Span::raw(" "));
        }
    }
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
                crate::tui::panels::GitFileStatus::Staged => ('S', Style::default().fg(p.green)),
                crate::tui::panels::GitFileStatus::Unstaged => ('M', Style::default().fg(p.yellow)),
                crate::tui::panels::GitFileStatus::Untracked => ('U', Style::default().fg(p.teal)),
                crate::tui::panels::GitFileStatus::Conflicted => ('C', Style::default().fg(p.red)),
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

    let diff_title = if panel.diff_search_active {
        format!(
            " Diff · {} · /{} ({}/{}) ",
            truncate(&panel.diff_title, 24),
            truncate(&panel.diff_search_query, 12),
            if panel.diff_search_matches.is_empty() {
                0
            } else {
                panel.diff_search_selected + 1
            },
            panel.diff_search_matches.len()
        )
    } else if panel.show_blame {
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
        panel.diff_search_active_line(),
        panel.hunk_cursor_line(),
        p,
        "Select a file to load its diff (Enter). J/K hunk, H applies.",
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
        frame, diff_area, diff_title, diff_lines, None, None, None, None, p, empty_hint,
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
    diff_meta: Option<&[Option<crate::tui::panels::GitDiffLineMeta>]>,
    blame: Option<&std::collections::HashMap<usize, String>>,
    // Diff search: index (into `diff_lines`) of the active match, if a
    // search is running. The whole line gets the accent background so it
    // stands out among the +/- colored lines.
    active_match: Option<usize>,
    // Hunk cursor: index (into `diff_lines`) of the `@@` header the
    // hunk cursor sits on (gap 14); the header gets the accent
    // background like the webui hunk head the buttons live in.
    active_hunk: Option<usize>,
    p: &Palette,
    empty_hint: &str,
) {
    let block = panel_block(diff_title, p);
    let inner = block.inner(diff_area);
    frame.render_widget(block, diff_area);
    let mut lines = Vec::new();
    for (index, line) in diff_lines.iter().take(MAX_DIFF_LINES).enumerate() {
        let mut style = match line.chars().next() {
            Some('+') => Style::default().fg(p.green),
            Some('-') => Style::default().fg(p.red),
            Some('@') => Style::default().fg(p.teal),
            _ => Style::default().fg(p.text),
        };
        // Diff search highlight: the active match line inverts the usual
        // coloring (webui highlights the find bar hit).
        if active_match == Some(index) {
            style = Style::default().fg(p.panel_bg).bg(p.accent);
        }
        // Hunk cursor highlight (gap 14): the selected `@@` header gets
        // the accent treatment, matching the search hit emphasis.
        if active_hunk == Some(index) {
            style = Style::default().fg(p.accent).add_modifier(Modifier::BOLD);
        }
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
    // Webui log layout: commit list plus the compare-with-parent diff
    // pane (Enter / `c` compare the selected commit with its parent).
    let [list_area, diff_area] =
        Layout::horizontal([Constraint::Percentage(45), Constraint::Percentage(55)]).areas(area);
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
            // Webui shift-click selection marker (gap 11): marked
            // commits show `*` before the hash.
            let mark = if panel.log_selected.contains(&commit.hash) {
                Span::styled(
                    "* ",
                    Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
                )
            } else {
                Span::styled("  ", Style::default().fg(p.muted))
            };
            ListItem::new(Line::from(vec![
                mark,
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
    // Title mirrors the webui log toolbar: scope, load-more hint and
    // the file filter when the log is file-scoped.
    let scope = panel.log_scope.label();
    let more = if panel.log_has_more {
        format!(" · +more {}", panel.log_limit)
    } else {
        String::new()
    };
    let title = match panel.log_file.as_deref() {
        Some(file) if !file.is_empty() => {
            format!(" Log · {scope} · {}{more} ", truncate(file, 24))
        }
        _ => format!(" Log · {scope}{more} "),
    };
    let list = List::new(items)
        .block(panel_block(&title, p))
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .highlight_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD))
        .highlight_symbol("> ");
    frame.render_stateful_widget(list, list_area, &mut state);

    let diff_title = format!(" Compare · {} ", truncate(&panel.diff_title, 40));
    render_diff_pane(
        frame,
        diff_area,
        &diff_title,
        &panel.diff_lines,
        p,
        "Select a commit to compare with its parent (Enter).",
    );
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

fn render_git_stash(
    frame: &mut Frame<'_>,
    list_area: Rect,
    diff_area: Rect,
    app: &TuiApp,
    p: &Palette,
) {
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
        .block(panel_block(" Stash · Enter diff · a apply · x drop ", p))
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .highlight_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD))
        .highlight_symbol("> ");
    frame.render_stateful_widget(list, list_area, &mut state);

    let title = if panel.stash_diff_title.is_empty() {
        " Stash diff ".to_string()
    } else {
        format!(" Stash diff · {} ", truncate(&panel.stash_diff_title, 36))
    };
    render_diff_pane(
        frame,
        diff_area,
        &title,
        &panel.stash_diff_lines,
        p,
        "Select a stash and press Enter to load its diff.",
    );
}

/// Conflicts view (webui conflicts tab): operation state line, conflicted
/// file list, and per-file resolve action hints in the footer keys line.
fn render_git_conflicts(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let panel = &app.git_panel;
    let [head_area, list_area] =
        Layout::vertical([Constraint::Length(2), Constraint::Min(1)]).areas(area);

    // Operation state mirrors the webui action toolbar: which operation
    // is in progress drives the continue/skip/abort hints.
    let state_line = if panel.rebase_in_progress {
        "rebase in progress · R continue · S skip · A abort"
    } else if panel.merge_in_progress {
        "merge in progress · R continue · A abort"
    } else {
        "no merge/rebase in progress"
    };
    let spans = vec![
        Span::styled(state_line.to_string(), Style::default().fg(p.yellow)),
        Span::raw("   "),
        Span::styled(
            "o ours · e parent · t remote · m mark resolved",
            Style::default().fg(p.muted),
        ),
    ];
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().fg(p.text).bg(p.panel_bg)),
        head_area,
    );

    let items = panel
        .conflict_files
        .iter()
        .map(|file| {
            ListItem::new(Line::from(Span::styled(
                truncate(file, 80),
                Style::default().fg(p.text),
            )))
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(panel.conflict_selected));
    }
    let list = List::new(items)
        .block(panel_block(" Conflicts ", p))
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .highlight_style(Style::default().fg(p.accent).add_modifier(Modifier::BOLD))
        .highlight_symbol("> ");
    frame.render_stateful_widget(list, list_area, &mut state);
}

/// Cleanup view (webui cleanup tab): repos with merged branches and
/// stale worktrees; x deletes the selected entry after a y-confirm,
/// p prunes the selected repo's worktree metadata.
fn render_git_cleanup(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let panel = &app.git_panel;
    let items = panel
        .cleanup_items()
        .into_iter()
        .map(|item| {
            ListItem::new(Line::from(vec![
                Span::styled(
                    format!("{} ", item.kind.label()),
                    Style::default().fg(p.teal),
                ),
                Span::styled(
                    format!("{} ", truncate(&item.name, 46)),
                    Style::default().fg(p.text),
                ),
                Span::styled(
                    format!("· {}", truncate(&item.repo, 28)),
                    Style::default().fg(p.muted),
                ),
            ]))
        })
        .collect::<Vec<_>>();
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(panel.cleanup_selected));
    }
    let root = panel.cleanup_root.as_deref().unwrap_or("");
    let title = if root.is_empty() {
        " Cleanup · x delete · B prune ".to_string()
    } else {
        format!(" Cleanup · {} · x delete · B prune ", truncate(root, 32))
    };
    let list = List::new(items)
        .block(panel_block(&title, p))
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
        crate::tui::PromptKind::NewWorkspace
        | crate::tui::PromptKind::CreateWorktreeBranch
        | crate::tui::PromptKind::CreateWorktreePath => String::new(),
        // Name step of the new-workspace flow: show the staged folder
        // as the subject (webui modal shows the Folder field above the
        // Workspace name field).
        crate::tui::PromptKind::NewWorkspaceName => app
            .workspace_create_stage
            .as_ref()
            .map(|stage| match stage {
                WorkspaceCreateStage::Path(path) => path.clone(),
            })
            .unwrap_or_default(),
        crate::tui::PromptKind::RenameWorkspace => app
            .selected_workspace()
            .map(|workspace| workspace.label.clone())
            .unwrap_or_default(),
        crate::tui::PromptKind::RenamePanel => app
            .snapshot
            .workspace_tabs(
                &app.selected_workspace()
                    .map(|ws| ws.id.clone())
                    .unwrap_or_default(),
            )
            .into_iter()
            .find(|tab| {
                Some(&tab.id)
                    == app
                        .selected_workspace()
                        .and_then(|ws| ws.active_tab_id.as_ref())
            })
            .map(|tab| tab.label.clone())
            .unwrap_or_default(),
        crate::tui::PromptKind::ConfirmCloseWorkspace => app
            .selected_workspace()
            .map(|workspace| workspace.label.clone())
            .unwrap_or_default(),
        crate::tui::PromptKind::ConfirmCleanupDelete => app
            .git_panel
            .selected_cleanup_item()
            .map(|item| format!("{} {}", item.kind.label(), item.name))
            .unwrap_or_default(),
        // Log action prompts: show the selected commit as the subject.
        crate::tui::PromptKind::CreateTag
        | crate::tui::PromptKind::ResetMode
        | crate::tui::PromptKind::ConfirmResetHard
        | crate::tui::PromptKind::RebaseUpstream
        | crate::tui::PromptKind::ConfirmRebase => {
            let hash = app
                .git_panel
                .selected_commit_hash()
                .unwrap_or_default()
                .to_string();
            let short = &hash[..hash.len().min(7)];
            let message = app
                .git_panel
                .commits
                .get(app.git_panel.commit_selected)
                .map(|commit| truncate(&commit.message, 30))
                .unwrap_or_default();
            format!("{short} {message}")
        }
        // Git cwd: show the current git panel cwd as the starting point.
        crate::tui::PromptKind::GitCwd => app.git_panel.cwd.clone(),
        // Branch create: runs on the repo, no subject line.
        crate::tui::PromptKind::CreateBranch => String::new(),
        // New file/directory: show the root the name joins under.
        crate::tui::PromptKind::CreateFile | crate::tui::PromptKind::CreateDirectory => {
            if app.file_explorer.root_path.is_empty() {
                "(workspace root)".to_string()
            } else {
                app.file_explorer.root_path.clone()
            }
        }
        // Replace: show the current find query and match position.
        crate::tui::PromptKind::ReplaceInFile => {
            let find = &app.file_explorer.editor_find;
            if find.ranges.is_empty() {
                format!("find: {} (no matches)", find.query)
            } else {
                format!(
                    "find: {} (match {}/{})",
                    find.query,
                    find.selected + 1,
                    find.ranges.len()
                )
            }
        }
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
        TuiMode::ConfirmQuit => "QUIT?",
        TuiMode::Settings => "SET",
        TuiMode::WorktreeList => "WORKTREES",
    };
    let prefix = if app.prefix.is_armed() {
        "Ctrl+B> "
    } else {
        ""
    };
    let context = app.footer_context();
    let help = context.hint();
    // On narrow terminals (the classic 80x24) the full hint would push the
    // discovery tail off-screen: the mode label alone eats 14+ columns and
    // the status message needs room. Drop the middle actions first and keep
    // the `Ctrl+B ? help` tail, which is the one hint every screen needs.
    let label_width = 3 + app.screen.title().len() + 3;
    // 8 columns of status message minimum; below that the hint shrinks too.
    let hint_budget = area
        .width
        .saturating_sub(label_width as u16)
        .saturating_sub(prefix.chars().count() as u16)
        .saturating_sub(8) as usize;
    let help = if help.chars().count() <= hint_budget {
        help.to_string()
    } else {
        fit_hint(context.compact_hint(), hint_budget)
    };
    let message = app.error.as_deref().unwrap_or(&app.status);
    let used = label_width + help.chars().count() + prefix.chars().count();
    let status_budget = area.width.saturating_sub(used as u16) as usize;
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
            truncate(message, status_budget),
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

/// Narrow-terminal footer hints: same information, fewer actions listed.
/// Every compact hint keeps the `Ctrl+B ? help` discovery tail, which is
/// what a cramped statusbar must never lose.
/// Shrink a footer hint from the front, dropping whole `·`-separated
/// segments until it fits `budget`. The `Ctrl+B ? help` tail is the
/// discovery hint and is always the last segment kept.
fn fit_hint(hint: &str, budget: usize) -> String {
    let width = |segs: &[&str]| {
        segs.iter().map(|s| s.chars().count()).sum::<usize>() + 3 * segs.len().saturating_sub(1) + 2
    };
    let mut segments: Vec<&str> = hint.trim().split(" · ").collect();
    while width(&segments) > budget && segments.len() > 1 {
        segments.remove(0);
    }
    let joined = format!(" {} ", segments.join(" · "));
    if joined.chars().count() > budget {
        // A single segment still too wide (very narrow terminal): keep its
        // tail, which is where the discovery hint lives.
        let skip = joined.chars().count().saturating_sub(budget);
        joined.chars().skip(skip).collect()
    } else {
        joined
    }
}

fn render_help(frame: &mut Frame<'_>, area: Rect, p: &Palette, filter: &str, scroll: usize) {
    let rows = crate::tui::filtered_help_rows(filter);
    let width = area.width.min(72);
    // One extra line for the filter query while it is active.
    let filter_height = if filter.is_empty() { 0 } else { 1 };
    let height = area
        .height
        .min((rows.len() as u16 + 4 + filter_height).min(50));
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
    // Webui settings-search counterpart: show the active query so the
    // user sees why the list shrank.
    if !filter.is_empty() {
        lines.push(Line::from(vec![
            Span::styled(" filter: ", Style::default().fg(p.muted)),
            Span::styled(format!("{filter}_"), Style::default().fg(p.accent)),
            Span::styled(
                format!("  {}/{}", rows.len(), crate::tui::keys::help_rows().len()),
                Style::default().fg(p.muted),
            ),
        ]));
    }
    if rows.is_empty() {
        // Same message as the webui settings search empty state.
        lines.push(Line::from(Span::styled(
            " No shortcuts match your search ",
            Style::default().fg(p.muted),
        )));
    }
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
    let title = if filter.is_empty() {
        " Help · ? closes · type to filter · j/k scrolls "
    } else {
        " Help · Esc clears the filter "
    };
    frame.render_widget(
        Paragraph::new(lines)
            .block(panel(title, p))
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .scroll((scroll as u16, 0)),
        rect,
    );
}

/// Worktree browser overlay (webui worktree open modal, prefix `W`):
/// discovered checkouts of the discovery root, the typed filter query,
/// j/k cursor, and Enter-open. Mirrors the webui rows: title (path +
/// label), branch, linked badge.
fn render_worktree_list(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let rows = app.filtered_worktree_rows();
    let filter_height = if app.worktree_filter.is_empty() { 0 } else { 1 };
    let height = area
        .height
        .min((rows.len() as u16 + 5 + filter_height).min(24))
        .max(7 + filter_height);
    let width = area.width.min(80);
    let rect = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    let mut lines = vec![Line::from(vec![
        Span::styled(
            " Worktrees ",
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("in {} ", app.worktree_root),
            Style::default().fg(p.muted),
        ),
    ])];
    if !app.worktree_filter.is_empty() {
        lines.push(Line::from(vec![
            Span::styled(" filter: ", Style::default().fg(p.muted)),
            Span::styled(
                format!("{}_", app.worktree_filter),
                Style::default().fg(p.accent),
            ),
            Span::styled(
                format!("  {}/{}", rows.len(), app.worktree_rows.len()),
                Style::default().fg(p.muted),
            ),
        ]));
    }
    if rows.is_empty() {
        lines.push(Line::from(Span::styled(
            if app.worktree_rows.is_empty() {
                " No worktrees discovered in this folder "
            } else {
                " No worktrees match your search "
            },
            Style::default().fg(p.muted),
        )));
    }
    for (index, row) in rows.iter().enumerate() {
        let selected = index == app.worktree_selected;
        let cursor = if selected { "▸ " } else { "  " };
        let title_style = if selected {
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(p.text)
        };
        let linked = if row.is_linked {
            " [linked]"
        } else {
            " [main]"
        };
        lines.push(Line::from(vec![
            Span::styled(cursor, Style::default().fg(p.accent)),
            Span::styled(row.title(), title_style),
            Span::styled(
                if row.branch.is_empty() {
                    linked.to_string()
                } else {
                    format!("  {}{}", row.branch, linked)
                },
                Style::default().fg(p.muted),
            ),
        ]));
    }
    // Keep the cursor inside the window when the list outgrows the
    // overlay (webui modal scrolls the selected row into view).
    let header_lines = 2 + filter_height; // border + title (+ filter line)
    let visible_rows = height.saturating_sub(header_lines + 1).max(1) as usize;
    let scroll = app
        .worktree_selected
        .saturating_sub(visible_rows.saturating_sub(1));
    let title = if app.worktree_filter.is_empty() {
        " Worktrees · Enter opens · j/k moves · type to filter · Esc closes "
    } else {
        " Worktrees · Esc clears the filter "
    };
    frame.render_widget(
        Paragraph::new(lines)
            .block(panel(title, p))
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .scroll((scroll as u16, 0)),
        rect,
    );
}

/// Settings overlay (webui Settings modal, prefix `s`): read-only
/// display of the discovered API base, theme mode, refresh interval,
/// and the git/exploration roots. `t` cycles the theme; the rest is
/// informational (webui stores the rest in browser storage, which has
/// no TUI equivalent yet).
fn render_settings(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let width = area.width.min(64);
    let height = 12;
    let rect = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    let git_cwd = app.git_panel.cwd.clone();
    let files_cwd = app.file_explorer.cwd.clone();
    let row = |key: &str, value: &str| {
        Line::from(vec![
            Span::styled(format!("  {key:<16}"), Style::default().fg(p.muted)),
            Span::styled(value.to_string(), Style::default().fg(p.text)),
        ])
    };
    let lines = vec![
        Line::from(Span::styled(
            "Settings",
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
        )),
        row("web api base", &app.web_api.base_url()),
        row(
            "refresh interval",
            &format!("{}s", app.refresh_interval.as_secs()),
        ),
        row("theme", app.theme.label()),
        row("git cwd", &git_cwd),
        row("files cwd", &files_cwd),
        Line::from(""),
        Line::from(Span::styled(
            " t cycles the theme · Esc closes ",
            Style::default().fg(p.accent),
        )),
        Line::from(Span::styled(
            " other options live in the webui Settings modal ",
            Style::default().fg(p.muted),
        )),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .block(panel(" Settings · Esc closes ", p))
            .style(Style::default().fg(p.text).bg(p.panel_bg)),
        rect,
    );
}

/// Quit confirmation overlay. Every quit path opens this first; unlike
/// the destructive typed-`y` prompts, this one stays light: y/Enter
/// quits, n/Esc (or any other key) stays, Ctrl+C also quits.
fn render_confirm_quit(frame: &mut Frame<'_>, area: Rect, p: &Palette) {
    let width = area.width.min(48);
    let height = 7;
    let rect = Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    );
    let highlight = Style::default().fg(p.accent).add_modifier(Modifier::BOLD);
    let lines = vec![
        Line::from(Span::styled(
            " Quit herdr-webui-tui? ",
            Style::default().fg(p.red).add_modifier(Modifier::BOLD),
        )),
        Line::from(Span::styled(
            " the terminal UI will close, the session keeps running ",
            Style::default().fg(p.muted),
        )),
        Line::from(""),
        Line::from(vec![
            Span::styled(" y ", highlight),
            Span::styled("quit          ", Style::default().fg(p.text)),
            Span::styled(" n ", highlight),
            Span::styled("stay", Style::default().fg(p.text)),
        ]),
        Line::from(Span::styled(
            " Esc also stays · Ctrl+C also quits ",
            Style::default().fg(p.muted),
        )),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .block(panel(" Quit? ", p))
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .wrap(Wrap { trim: false }),
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
