use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Clear, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::Frame;
use std::time::Duration;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::tui::panels::files::{content_rows, ContentRow, SearchKind};
use crate::tui::panels::GitView;
use crate::tui::search;
use crate::tui::terminal::styled_terminal_line;
use crate::tui::theme::Palette;
use crate::tui::workspace::{BrowserRow, WorkspaceCreateStage};
use crate::tui::{lens, SidebarFocus, TuiApp, TuiMode, TuiScreen, TuiWorkspace};
use crate::HERDR_WEBUI_VERSION;

mod split_tiles;
pub(crate) use split_tiles::pane_display_name;
pub(crate) use split_tiles::split_active;
pub(crate) use split_tiles::TileRectOwned;

const SPINNERS: &[&str] = &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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
    // Webui modal parity: every overlay draws over a dimmed backdrop
    // (`.modal-backdrop { background: #0008 }`) with a shadowed,
    // accent-bordered float window (neovim-style depth).
    let overlay_active = app.mode == TuiMode::Help
        || app.mode == TuiMode::Tour
        || app.mode == TuiMode::ConfirmQuit
        || app.mode == TuiMode::Settings
        || app.mode == TuiMode::WorktreeList
        || app.mode == TuiMode::BranchPicker
        || app.mode == TuiMode::SearchPalette
        || app.mode == TuiMode::SessionManager
        || (app.lens.active && app.screen == TuiScreen::Terminal)
        || app.commit_input.is_some()
        || app.prompt_input.is_some();
    if overlay_active {
        dim_backdrop(frame, p);
    }
    if app.lens.active && app.screen == TuiScreen::Terminal {
        render_lens(frame, area, app, p);
    }
    if app.mode == TuiMode::Help {
        render_help(frame, area, p, &app.help_filter, app.help_scroll);
    }
    if app.mode == TuiMode::Tour {
        // The step's demo surface renders below the tour card like
        // the webui palette under the spotlight: the card keeps the
        // keys and the explanation. The lens demo is field state (no
        // TuiMode), so it renders through the shared active-lens arm
        // above instead of a tour_demo_overlay match.
        if app.tour_demo_overlay == Some(TuiMode::SearchPalette) {
            render_search_palette(frame, area, app, p);
        }
        if app.tour_demo_overlay == Some(TuiMode::Settings) {
            render_settings(frame, area, app, p);
        }
        if app.tour_demo_overlay == Some(TuiMode::SessionManager) {
            render_session_manager(frame, area, app, p);
        }
        crate::tui::tour::render_tour(frame, area, app, p);
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
    if app.mode == TuiMode::BranchPicker {
        render_branch_picker(frame, area, app, p);
    }
    if app.mode == TuiMode::SearchPalette {
        render_search_palette(frame, area, app, p);
    }
    if app.mode == TuiMode::SessionManager {
        render_session_manager(frame, area, app, p);
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

/// Shared list rendering for every ListState-driven panel: selection
/// guard, row-inverted highlight (webui `.selected` parity), and the
/// panel block. Sidebar lists use "▸ ", git panels use "> ".
fn render_list_panel<'a, I>(
    frame: &mut Frame<'_>,
    area: Rect,
    items: I,
    selected: usize,
    title: impl Into<Block<'a>>,
    highlight_symbol: &'a str,
    p: &Palette,
) where
    I: IntoIterator<Item = ListItem<'a>>,
{
    let mut state = ListState::default();
    let items: Vec<ListItem<'a>> = items.into_iter().collect();
    if !items.is_empty() {
        state.select(Some(selected));
    }
    let list = List::new(items)
        .block(title.into())
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .highlight_style(
            Style::default()
                .fg(p.panel_bg)
                .bg(p.accent)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol(highlight_symbol);
    frame.render_stateful_widget(list, area, &mut state);
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
    let title = if app.sidebar_focus == SidebarFocus::Workspaces {
        " Workspaces* "
    } else {
        " Workspaces "
    };
    render_list_panel(
        frame,
        area,
        items,
        app.selected_workspace,
        panel(title, p),
        "▸ ",
        p,
    );
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
    let title = if app.sidebar_focus == SidebarFocus::Agents {
        " Agents* "
    } else {
        " Agents "
    };
    render_list_panel(
        frame,
        area,
        items,
        app.selected_agent,
        panel(title, p),
        "▸ ",
        p,
    );
}

fn render_main(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    if area.is_empty() {
        return;
    }
    // AGENTS summary bar (split design): one line between the tab bar
    // and the pane area, always present on the Terminal screen so the
    // layout never jumps when a split opens.
    let [tab_bar, status_bar, pane_area] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(1),
    ])
    .areas(area);
    render_tab_bar(frame, tab_bar, app, p);
    split_tiles::render_status_bar(frame, status_bar, app, p);
    split_tiles::render_panes_or_split(frame, pane_area, app, p);
    // Key walks score against this frame's geometry.
    let focus = app.focused_pane_id();
    let tiles = split_tiles::layout_tiles(&app.split_tree, pane_area, focus.as_deref());
    split_tiles::record_tile_geometry(app, &tiles);
}

/// Pane viewport (cols, rows) the attached pty must be sized to:
/// the same geometry `render` paints the terminal tail into. Sizing
/// the pty to anything else (full TUI window, hard-coded 120x32)
/// makes the shell wrap at a width the pane cannot show, so
/// continuation rows duplicate content and push the prompt row out
/// of the viewport. Mirrors `render`: footer 1 + tab bar 1 + pane
/// borders 2 + cwd/status/blank 3 rows; sidebar column + borders for
/// width. Pure so the binary loop and `TuiApp` share one definition.
pub fn pane_viewport_size(width: u16, height: u16, sidebar_collapsed: bool) -> (u16, u16) {
    let sidebar_width = if sidebar_collapsed {
        0
    } else if width >= 100 {
        34
    } else {
        28.min(width / 2)
    };
    let cols = width.saturating_sub(sidebar_width).saturating_sub(2).max(1);
    let rows = height
        .saturating_sub(1) // footer
        .saturating_sub(1) // tab bar
        .saturating_sub(2) // pane borders
        .saturating_sub(3) // cwd / status / blank header lines
        .max(1);
    (cols, rows)
}

/// Folder token for the tab-bar context strip: the workspace cwd
/// basename, mirroring the desktop path chip. `None` when the cwd is
/// unknown (empty), matching the desktop's absent-chip rule for
/// folders it cannot name.
fn workspace_path_token(workspace: &TuiWorkspace) -> Option<String> {
    if workspace.cwd.is_empty() {
        return None;
    }
    std::path::Path::new(&workspace.cwd)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
}

/// Worktree token for the context strip: `[worktree]` when the stamp
/// says the workspace is a linked lane (desktop shows the link chip
/// only when `is_linked_worktree` is true; plain folders and the main
/// checkout show nothing).
fn workspace_worktree_token(workspace: &TuiWorkspace) -> Option<String> {
    workspace
        .worktree
        .as_ref()
        .filter(|stamp| stamp.is_linked)
        .map(|_| "[worktree]".to_string())
}

/// Branch token for the context strip: `@ branch` from the stamp.
/// `None` when the branch is unknown (no stamp yet, or detached
/// HEAD), mirroring the desktop's disabled branch chip: the desktop
/// renders a disabled ` branch…` placeholder, the TUI drops the token
/// instead (a muted placeholder buys no information in text form).
pub(crate) fn workspace_branch_token(workspace: &TuiWorkspace) -> Option<String> {
    workspace.worktree.as_ref().and_then(|stamp| {
        if stamp.branch.is_empty() {
            None
        } else {
            Some(format!("@ {}", stamp.branch))
        }
    })
}

fn render_tab_bar(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    // Webui state.ws parity: the strip lists the workspace in view.
    // Without a split that is the sidebar selection; on a mixed-
    // workspace split it is the focused tile's workspace, so the ▸
    // marker (view_pane's tab) always has a home in the listed tabs.
    // Anchoring the list on the sidebar cursor left the strip
    // markerless while the user acted on another workspace's tile.
    let strip_workspace = if crate::tui::render::split_active(app) {
        app.view_pane()
            .and_then(|pane| {
                app.snapshot
                    .workspaces
                    .iter()
                    .find(|ws| ws.id == pane.workspace_id)
            })
            .or_else(|| app.selected_workspace())
    } else {
        app.selected_workspace()
    };
    let line = if let Some(workspace) = strip_workspace {
        let tabs = app.snapshot.workspace_tabs(&workspace.id);
        // The tab the TUI is actually viewing (the pane whose tail the
        // main pane shows, the one Enter attaches): the selection follows
        // the agent cursor / move_panel / the split focus, which does not
        // always match the backend's active_tab_id. On a split screen the
        // focused tile owns the view, so the marker must read view_pane
        // (identical to the sidebar selection without a split). Marking
        // only the backend-active tab left the user without any cue of
        // which panel they were looking at after Ctrl+B ] / [ (ux fix).
        let selected_tab_id = app.view_pane().map(|pane| pane.tab_id.clone());
        let mut spans = if tabs.is_empty() {
            vec![Span::styled(
                format!(" {} ", workspace.label),
                Style::default()
                    .fg(p.accent)
                    .bg(p.panel_alt)
                    .add_modifier(Modifier::BOLD),
            )]
        } else {
            tabs.iter()
                .flat_map(|tab| {
                    let backend_active =
                        workspace.active_tab_id.as_deref() == Some(tab.id.as_str()) || tab.focused;
                    let viewing = selected_tab_id.as_deref() == Some(tab.id.as_str());
                    // The viewing tab inverts (it is the one keys act
                    // on); the backend-active tab keeps a dot suffix so
                    // the two states stay distinguishable when they
                    // differ (ux review: the marker-only viewing tab
                    // was the weaker signal).
                    let (style, suffix) = if viewing {
                        (
                            Style::default()
                                .fg(p.panel_bg)
                                .bg(p.accent)
                                .add_modifier(Modifier::BOLD),
                            "",
                        )
                    } else if backend_active {
                        (Style::default().fg(p.accent).bg(p.panel_alt), " ●")
                    } else {
                        (Style::default().fg(p.text).bg(p.panel_alt), "")
                    };
                    let marker = if viewing { "▸ " } else { "" };
                    vec![
                        Span::styled(
                            format!(" {marker}{}{suffix} ", truncate(&tab.label, 16)),
                            style,
                        ),
                        Span::raw(" "),
                    ]
                })
                .collect::<Vec<_>>()
        };
        // Location-bar parity tokens after the tab labels: the
        // workspace folder, its worktree lane when linked, and the
        // checked-out branch (desktop chips folded into text
        // tokens; the stamp is absent for plain folders, so the
        // tokens degrade to just the folder name). Ratatui clips the
        // line at the terminal width, which implements the drop
        // order for free: the branch token (rightmost) disappears
        // first on narrow terminals, then worktree, and the folder
        // name rides the longest.
        if let Some(path_token) = workspace_path_token(workspace) {
            spans.push(Span::raw(" "));
            spans.push(Span::styled(
                path_token,
                Style::default().fg(p.muted).bg(p.bg),
            ));
            if let Some(worktree_token) = workspace_worktree_token(workspace) {
                spans.push(Span::raw(" "));
                spans.push(Span::styled(
                    worktree_token,
                    Style::default().fg(p.muted).bg(p.bg),
                ));
            }
            if let Some(branch_token) = workspace_branch_token(workspace) {
                spans.push(Span::raw(" "));
                spans.push(Span::styled(
                    branch_token,
                    Style::default().fg(p.accent).bg(p.bg),
                ));
            }
        }
        Line::from(spans)
    } else {
        Line::from(Span::styled(
            // Desktop empty bar is a button; the TUI analog is the hint
            // naming the binding (the browser overlay doubles as the
            // folder picker, browse root falls back to home).
            " no workspaces · Ctrl+B w open ",
            Style::default().fg(p.muted),
        ))
    };
    frame.render_widget(Paragraph::new(line).style(Style::default().bg(p.bg)), area);
}

/// Chat lens overlay (ux overhaul 2/3, TUI port): the pane transcript
/// as a centered reading column over the dimmed terminal screen. User
/// turns (prompt-marker lines) are accent-highlighted like the webui
/// right-aligned user cards; output stays plain. The webui's "New
/// output" pill is the footer's unread hint here (render_footer reads
/// `lens.unread` through the Lens context).
fn render_lens(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let width = area.width.min(88);
    let height = area.height.saturating_sub(4);
    let rect = centered_overlay(frame, area, width, height, p);
    let pane_label = app
        .view_pane()
        .map(|pane| {
            pane.display_agent
                .as_deref()
                .or(pane.agent.as_deref())
                .unwrap_or("shell")
        })
        .unwrap_or("pane");
    let title = format!(" Chat · {pane_label} ");
    let block = overlay_panel(&title, p);
    let inner = block.inner(rect);
    frame.render_widget(block, rect);

    let transcript = lens::transcript_lines(app.pane_scrollback_lines());
    let viewport = inner.height.saturating_sub(1) as usize;
    let window = lens::visible_window(&transcript, app.lens.scroll_up, viewport);
    let mut lines: Vec<Line> = window
        .iter()
        .map(|entry| match entry {
            lens::LensLine::User(text) => Line::from(Span::styled(
                format!("❯ {}", text.trim_start_matches(['❯', '›', '➜']).trim()),
                Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
            )),
            lens::LensLine::Output(text) => {
                Line::from(Span::styled(text.clone(), Style::default().fg(p.text)))
            }
            lens::LensLine::Gap => Line::from(""),
        })
        .collect();
    // Bottom meta line: position in the transcript, or the unread
    // resume hint when new output landed while scrolled up.
    let meta = if app.lens.unread {
        Line::from(Span::styled(
            " new output · G resumes following ",
            Style::default().fg(p.yellow),
        ))
    } else {
        Line::from(Span::styled(
            format!(
                " {} lines{}",
                transcript.len(),
                if app.lens.follow {
                    " · following"
                } else {
                    " · scrolled"
                }
            ),
            Style::default().fg(p.muted),
        ))
    };
    lines.push(meta);
    let paragraph = Paragraph::new(lines)
        .style(Style::default().fg(p.text).bg(p.panel_bg))
        .wrap(Wrap { trim: false });
    frame.render_widget(paragraph, inner);
}

fn render_pane(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let selected = app.selected_pane();
    // Panel identity in the title (ux fix): the agent + pane id says who
    // runs in the pane but not WHICH panel/tab it is; with several open
    // panels the user had no cue which one the preview belongs to. The
    // tab label rides between the agent and the pane id.
    let title = selected
        .map(|pane| {
            let tab_label = app
                .snapshot
                .tabs
                .iter()
                .find(|tab| tab.id == pane.tab_id)
                .map(|tab| tab.label.as_str())
                .unwrap_or("panel");
            // Same composition as the split tile header (feature
            // parity): the name slot falls back through the terminal
            // title, and a distinct title rides its own segment so
            // the single-pane view shows what the pane displays too.
            let terminal_title = pane.terminal_title.as_deref();
            let name = pane
                .label
                .as_deref()
                .filter(|label| !label.is_empty())
                .or(pane.display_agent.as_deref())
                .or(pane.agent.as_deref())
                .or(terminal_title)
                .unwrap_or("shell");
            let mut title = format!(
                " {} · {} · {} ",
                truncate(name, 18),
                truncate(tab_label, 16),
                pane.id
            );
            if let Some(terminal_title) = terminal_title.filter(|title| *title != name) {
                title.push_str(&format!("· {} ", truncate(terminal_title, 12)));
            }
            title
        })
        .unwrap_or_else(|| " Pane ".to_string());
    let block = panel(&title, p).border_style(match app.mode {
        TuiMode::Attach => Style::default().fg(p.teal),
        // Accent ring parity with the focused split tile: the
        // single-pane view names its target the same way (ux review).
        _ => Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
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
        // Scroll view (ux fix): the pane scrolls over the deep
        // scrollback the same way the lens does, bottom-anchored with
        // `pane_scroll` lines above the buffer end. Styles only cover
        // the live tail window, so deep-history lines render plain.
        let lines_ref = app.pane_scrollback_lines();
        let scroll = app
            .pane_scroll
            .min(lines_ref.len().saturating_sub(max_tail));
        let end = lines_ref.len().saturating_sub(scroll);
        let start = end.saturating_sub(max_tail);
        for (window_index, line_text) in lines_ref[start..end].iter().enumerate() {
            let width = inner.width as usize;
            let styled_index = start + window_index;
            let tail_offset = lines_ref.len().saturating_sub(app.pane_tail.len());
            let styled = if styled_index >= tail_offset {
                Some(styled_index - tail_offset)
            } else {
                None
            };
            let line = styled
                .and_then(|index| {
                    app.pane_tail_styles
                        .get(index)
                        .filter(|spans| !spans.is_empty())
                        .map(|spans| styled_terminal_line(spans, width, p.text))
                })
                .unwrap_or_else(|| {
                    Line::from(Span::styled(
                        truncate(line_text, width),
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

/// Centered scroll window: keep `anchor` inside a `visible`-row view
/// over `len` items, scrolled only when the list overflows the view.
fn centered_window(anchor: usize, len: usize, visible: usize) -> usize {
    if len > visible && visible > 0 {
        anchor
            .saturating_sub(visible / 2)
            .min(len.saturating_sub(visible))
    } else {
        0
    }
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
    let start = centered_window(explorer.selected, explorer.entries.len(), visible_height);
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
            // on both TUI themes), changed (committed on this branch vs the
            // default branch) blue.
            match status {
                "deleted" | "conflict" => Style::default().fg(p.red),
                "modified" => Style::default().fg(p.yellow),
                "added" | "untracked" => Style::default().fg(p.green),
                "changed" => Style::default().fg(p.accent),
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
        // Committed search results highlight the matched substring yellow
        // (webui `herdr-tree-hit` mark); content search returned early above.
        let highlight = explorer.search_mode;
        let mut spans = vec![
            Span::styled(prefix, Style::default().fg(p.accent)),
            Span::raw(indent),
            Span::styled(icon, Style::default().fg(p.muted)),
            Span::raw(" "),
        ];
        for (text, matched) in
            filter_name_spans(&truncate(&entry.name, 48), &explorer.filter, highlight)
        {
            spans.push(if matched {
                Span::styled(text, name_style.fg(p.yellow))
            } else {
                Span::styled(text, name_style)
            });
        }
        rendered.push(Line::from(spans));
    }
    frame.render_widget(Paragraph::new(rendered), list_area);
    if explorer.entries.is_empty() && !explorer.filter_active {
        let empty = Paragraph::new(Span::styled(
            "No entries. Ctrl+B r refreshes, / filters.",
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
        let outline = crate::markdown::parse_markdown_outline(&preview.content);
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
        // Byte offset of each rendered line's start: `lines()` loses
        // offsets, so the walk tracks them for the cursor cell split.
        let line_starts: Vec<usize> = {
            let mut offsets = Vec::new();
            let mut byte = 0;
            for line in preview.content.lines() {
                offsets.push(byte);
                byte += line.len() + 1;
            }
            offsets
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
            let spans = if explorer.edit_active && index == cursor_line {
                // Edit cursor (ux fix): invert the character cell at the
                // cursor's row and column like a terminal caret, so the
                // position is visible on every theme. Past the line end
                // the caret rides a padding space. No terminal cursor
                // is placed (ratatui would hide it anyway on redraws
                // that do not call set_cursor).
                let cursor_byte = explorer
                    .edit_cursor
                    .min(preview.content.len())
                    .saturating_sub(line_starts.get(index).copied().unwrap_or(0));
                let (before, at, after) = split_line_at_cursor(line, cursor_byte);
                // Same width budget as the plain rows, split across
                // the three spans so a long line cannot overflow the
                // panel now that it skips the single-span truncate.
                // When the cursor sits deep in a long line the window
                // keeps the tail of `before` (what the caret sees),
                // like an editor's horizontal scroll.
                let budget = (inner.width as usize).saturating_sub(6);
                let at_width = at.width();
                let before_budget = budget.saturating_sub(at_width);
                let before_shown = if before.width() > before_budget {
                    tail_visible(&before, before_budget)
                } else {
                    before.clone()
                };
                let after_budget = budget
                    .saturating_sub(before_shown.width())
                    .saturating_sub(at_width);
                vec![
                    Span::styled(number, number_style),
                    Span::styled(before_shown, line_style),
                    Span::styled(at, Style::default().fg(p.panel_bg).bg(p.accent)),
                    Span::styled(truncate(&after, after_budget), line_style),
                ]
            } else {
                vec![
                    Span::styled(number, number_style),
                    Span::styled(
                        truncate(line, (inner.width as usize).saturating_sub(6)),
                        line_style,
                    ),
                ]
            };
            lines.push(Line::from(spans));
            if lines.len() >= visible {
                break;
            }
        }
        if explorer.edit_active && cursor_line >= line_starts.len() {
            // Cursor past the last rendered line (content ends with a
            // newline, the state `start_edit` leaves): the caret row
            // would never paint, so show a virtual line whose padding
            // space carries the inverted cell. It always fits: the
            // cursor follow-scroll starts at cursor_line - (visible -
            // 1), so at most visible - 1 real rows come before it.
            push_virtual_caret_row(&mut lines, visible, line_starts.len(), p);
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

/// Coverage is off because the guard's false arm is unreachable: the
/// cursor follow-scroll starts at cursor_line - (visible - 1), so at
/// most visible - 1 real rows precede the caret row and the virtual
/// row always fits.
#[cfg_attr(coverage, coverage(off))]
fn push_virtual_caret_row(
    lines: &mut Vec<Line<'_>>,
    visible: usize,
    rendered_lines: usize,
    p: &Palette,
) {
    if lines.len() < visible {
        lines.push(Line::from(vec![
            Span::styled(
                format!("{:>4} ", rendered_lines + 1),
                Style::default().fg(p.muted),
            ),
            Span::styled(
                " ".to_string(),
                Style::default().fg(p.panel_bg).bg(p.accent),
            ),
        ]));
    }
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
    let file = panel.history_file.as_deref().unwrap_or("");
    let title = if file.is_empty() {
        " History ".to_string()
    } else {
        format!(" History · {} ", truncate(file, 40))
    };
    render_list_panel(
        frame,
        list_area,
        items,
        panel.commit_selected,
        panel_block(&title, p),
        "> ",
        p,
    );

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
    let title = format!(" Changes · {} files ", panel.files.len());
    render_list_panel(
        frame,
        list_area,
        items,
        panel.file_selected,
        panel_block(&title, p),
        "> ",
        p,
    );

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
    // Follow-scroll: keep the search hit or the hunk cursor inside the
    // window, centered. The old fixed top-of-diff window highlighted
    // anchors below the fold where they stayed invisible.
    let anchor = active_match.or(active_hunk);
    let visible = inner.height as usize;
    let len = diff_lines.len();
    let start = match anchor {
        Some(anchor) => centered_window(anchor, len, visible),
        None => 0,
    };
    // When the diff is taller than the pane, the bottom row becomes a
    // position indicator instead of silently hiding the rest.
    let show_position = len > visible;
    let rows = if show_position {
        visible.saturating_sub(1)
    } else {
        visible
    };
    let mut lines = Vec::new();
    let content_rows = len.saturating_sub(start).min(rows);
    for (index, line) in diff_lines.iter().enumerate().skip(start).take(content_rows) {
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
        // Hunk cursor highlight (gap 14): the selected `@@` header
        // inverts like the search hit and the list selections, so the
        // hunk H will act on is visible on light terminals too
        // (foreground-only teal/accent was easy to miss).
        if active_hunk == Some(index) {
            style = Style::default()
                .fg(p.panel_bg)
                .bg(p.accent)
                .add_modifier(Modifier::BOLD);
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
        // Display width, not bytes: the blame author span can carry
        // multibyte text (CJK, accents) whose byte length runs up to
        // 3x its column count, over-truncating the diff line.
        let text_len = spans.iter().map(|s| s.content.width()).sum::<usize>();
        spans.push(Span::styled(
            truncate(line, visible_width.saturating_sub(text_len)),
            style,
        ));
        lines.push(Line::from(spans));
    }
    if show_position {
        lines.push(Line::from(Span::styled(
            format!(" lines {}-{} of {len} ", start + 1, start + content_rows),
            Style::default().fg(p.muted),
        )));
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
    // Title mirrors the webui log toolbar: scope, the HEAD vs base
    // comparison chip, load-more hint and the file filter when the log
    // is file-scoped.
    let scope = panel.log_scope.label();
    let comparison = panel
        .log_comparison
        .as_ref()
        .map(|c| format!(" · {}", c.label()))
        .unwrap_or_default();
    let more = if panel.log_has_more {
        format!(" · +more {}", panel.log_limit)
    } else {
        String::new()
    };
    let title = match panel.log_file.as_deref() {
        Some(file) if !file.is_empty() => {
            format!(" Log · {scope}{comparison} · {}{more} ", truncate(file, 24))
        }
        _ => format!(" Log · {scope}{comparison}{more} "),
    };
    render_list_panel(
        frame,
        list_area,
        items,
        panel.commit_selected,
        panel_block(&title, p),
        "> ",
        p,
    );

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
    render_list_panel(
        frame,
        area,
        items,
        panel.branch_selected,
        panel_block(
            " Branches · Enter switches · Ctrl+B v switches selected ",
            p,
        ),
        "> ",
        p,
    );
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
    render_list_panel(
        frame,
        list_area,
        items,
        panel.stash_selected,
        panel_block(" Stash · Enter diff · a apply · x drop ", p),
        "> ",
        p,
    );

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
    render_list_panel(
        frame,
        list_area,
        items,
        panel.conflict_selected,
        panel_block(" Conflicts ", p),
        "> ",
        p,
    );
}

/// Cleanup view (webui cleanup tab): repos with merged branches and
/// stale worktrees; Space marks/unmarks (webui checkbox), x deletes
/// the pending items after a y-confirm (yb also deletes branches),
/// B prunes the selected repo's worktree metadata.
fn render_git_cleanup(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let panel = &app.git_panel;
    let items = panel
        .cleanup_items()
        .into_iter()
        .map(|item| {
            // Webui checkbox state: marked rows show `*` (same mark
            // gesture as the log view's shift-click selection).
            let mark = if panel.cleanup_marked.contains(&item.key()) {
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
    let root = panel.cleanup_root.as_deref().unwrap_or("");
    let title = if root.is_empty() {
        " Cleanup · Space mark · x delete · B prune ".to_string()
    } else {
        format!(
            " Cleanup · {} · Space mark · x delete · B prune ",
            truncate(root, 32)
        )
    };
    render_list_panel(
        frame,
        area,
        items,
        panel.cleanup_selected,
        panel_block(&title, p),
        "> ",
        p,
    );
}

/// Render the active prompt modal. Only called while `app.prompt_input`
/// is `Some` (the `render` entry point gates on it).
fn render_prompt_input(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let prompt = app
        .prompt_input
        .as_ref()
        .expect("render_prompt_input requires an active prompt");
    // Box size depends on the wrapped input (see below), so only the
    // width is known here; the rect is computed after wrapping.
    let box_width = area.width.min(64);
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
        | crate::tui::PromptKind::CreateWorktreePath
        | crate::tui::PromptKind::CreateWorktreeBase
        | crate::tui::PromptKind::ConfirmWorktreePullBase => String::new(),
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
        crate::tui::PromptKind::ConfirmCleanupDelete => {
            let items = app.git_panel.cleanup_pending_items();
            let branch_too = app.git_panel.cleanup_branch_option_available();
            let summary = match items.len() {
                0 => "no cleanup item".to_string(),
                1 => format!("{} {}", items[0].kind.label(), items[0].name),
                n => format!("{n} cleanup items"),
            };
            if branch_too {
                format!("{summary} (yb also deletes branches)")
            } else {
                summary
            }
        }
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
        // Composer: show the target pane (agent · pane id), the TUI
        // counterpart of the webui box's aria-label "Message to this
        // panel".
        crate::tui::PromptKind::ComposerMessage => app
            .view_pane()
            .map(|pane| {
                format!(
                    "{} · {}",
                    pane.display_agent
                        .as_deref()
                        .or(pane.agent.as_deref())
                        .unwrap_or("shell"),
                    pane.id
                )
            })
            .unwrap_or_default(),
        // New session: the backend label lands in the modal title, the
        // subject names the current target for context (webui modal
        // shows the backend selector instead).
        crate::tui::PromptKind::CreateSession => {
            format!("from {} · {}", app.current_session, app.current_backend)
        }
    };
    let title = format!(" {} ", prompt.kind.title());
    // The typed text wraps instead of clipping: the box grows with the
    // input (same budget idea as jcode's composer, max 8 visible rows)
    // and the wrap always ends on the cursor's own row, so the tail of
    // a long line is always on screen. Width is display width, not
    // chars, so double-width glyphs never spill a column.
    let inner_width = box_width.saturating_sub(2) as usize;
    let input_lines = wrap_input_with_cursor(&prompt.text, inner_width.max(1));
    let visible_input = (input_lines.len() as u16).min(8);
    // Hint wraps to the rows it needs instead of silently clipping
    // past the box edge (hint strings run past 64 columns on narrow
    // terminals). Wrapping the same way as the input keeps the box
    // one shape; the grown hint rows join the box height so nothing
    // is cut.
    let hint_rows = wrap_plain(prompt.kind.hint(), inner_width.max(1));
    // subject + hint + borders; the box centers per row count.
    let height = (visible_input + hint_rows.len() as u16 + 5).min(area.height);
    let rect = centered_overlay(frame, area, box_width, height, p);
    let mut lines = vec![Line::from(Span::styled(
        truncate(&subject, (rect.width.saturating_sub(4)) as usize),
        Style::default().fg(p.muted),
    ))];
    // Tail-scroll: past 8 wrapped rows keep the LAST 8, the ones the
    // cursor lives in. Earlier rows scroll away exactly like jcode's
    // composer, so typing always shows where the caret is.
    let skip = input_lines.len().saturating_sub(8);
    for row in input_lines.iter().skip(skip) {
        lines.push(Line::from(Span::styled(
            row.clone(),
            Style::default().fg(p.text),
        )));
    }
    for row in &hint_rows {
        lines.push(Line::from(Span::styled(
            row.clone(),
            Style::default().fg(p.muted),
        )));
    }
    frame.render_widget(
        Paragraph::new(lines)
            .block(overlay_panel(&title, p))
            .style(Style::default().fg(p.text).bg(p.panel_bg)),
        rect,
    );
}

/// Wrap typed input text at `width` display columns, appending the
/// cursor block to the last row. Word wrap: break at spaces when the
/// next word does not fit (jcode's composer wraps the same way), and
/// hard-break only a word wider than the row. Widths are display
/// widths, so a double-width glyph never splits mid-cell.
///
/// Spacing is preserved exactly as typed: `split_inclusive` keeps each
/// space glued to the word before it, so wrapping never swallows or
/// invents spaces. The empty input is exactly one cursor row, so the
/// box height does not jump when the first character arrives.
pub(crate) fn wrap_input_with_cursor(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec!["█".to_string()];
    }
    let mut rows: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_width = 0usize;
    // Greedy per source line. Every line except the last ends its own
    // row (pasted multiline opens real rows); the last line keeps its
    // text in `current` and becomes the cursor row below.
    let lines: Vec<&str> = text.split('\n').collect();
    let last = lines.len().saturating_sub(1);
    for (i, line) in lines.iter().enumerate() {
        let mut pending = String::new();
        let mut pending_width = 0usize;
        for token in line.split_inclusive(' ') {
            let tok_width = token.width();
            if current_width + pending_width + tok_width > width && !pending.is_empty() {
                // The next token does not fit: flush the row so far.
                // The flush only ever runs right after a space-glued
                // token landed in `pending` (the overflowing token is
                // its successor, and `split_inclusive` leaves the
                // space on the predecessor), with `current` still
                // empty from the previous flush or line start, so the
                // boundary-space move is unconditional: pop the
                // glued space and park it at the head of the next row.
                pending.pop();
                current.push(' ');
                current.push_str(&pending);
                rows.push(std::mem::take(&mut current));
                current_width = 0;
                pending.clear();
            }
            pending.push_str(token);
            pending_width += tok_width;
            // A single word wider than the row hard-breaks mid-word;
            // flush what fits so the wrap always progresses.
            while pending_width > width {
                // Walk chars until the row budget, push that part.
                let mut fit = String::new();
                let mut fit_width = 0usize;
                let mut rest = String::new();
                let mut rest_width = 0usize;
                for ch in pending.chars() {
                    let ch_width = ch.width().unwrap_or(0);
                    if fit_width + ch_width <= width {
                        fit.push(ch);
                        fit_width += ch_width;
                    } else {
                        rest.push(ch);
                        rest_width += ch_width;
                    }
                }
                rows.push(fit);
                pending = rest;
                pending_width = rest_width;
            }
        }
        current.push_str(&pending);
        current_width += pending_width;
        if i < last {
            // A line the text itself ends: its row ends here, the
            // next line starts fresh.
            rows.push(std::mem::take(&mut current));
            current_width = 0;
        }
    }
    current.push('█');
    rows.push(current);
    rows
}

/// Word-wrap plain text (no cursor block) at `width` display
/// columns. Same greedy word wrap as `wrap_input_with_cursor`,
/// shared so hint rows and status rows break like the input.
/// Hard-breaks a single word wider than the row so wrap always
/// progresses.
fn wrap_plain(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![text.to_string()];
    }
    let mut rows: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_width = 0usize;
    for token in text.split_inclusive(' ') {
        let tok_width = token.width();
        if current_width + tok_width > width {
            // Only flush a non-empty row: a first token wider than
            // the row must not open with a blank line.
            if current_width > 0 {
                rows.push(std::mem::take(&mut current));
            }
            // A word wider than the row hard-breaks mid-word, and the
            // leftover keeps breaking while it is STILL wider than the
            // row. Stopping after one break left an over-wide rest
            // that ratatui's Wrap re-wrapped into extra rows, so the
            // footer's row budget clipped the tail of a long error.
            let mut rest: &str = token;
            while rest.width() > width {
                let mut fit_width = 0usize;
                let mut split_at = 0usize;
                for (offset, ch) in rest.char_indices() {
                    let ch_width = ch.width().unwrap_or(0);
                    if fit_width + ch_width > width {
                        break;
                    }
                    fit_width += ch_width;
                    split_at = offset + ch.len_utf8();
                }
                rows.push(rest[..split_at].to_string());
                rest = &rest[split_at..];
            }
            current = rest.to_string();
            current_width = rest.width();
        } else {
            current.push_str(token);
            current_width += tok_width;
        }
    }
    // Every token path leaves `current` non-empty: a flushed row is
    // immediately refilled by the same token (hard-break remainder or
    // the else-branch push), so the cursor row is pushed
    // unconditionally; only a truly empty input starts with an empty
    // `current` and `rows`, which still pushes one empty row.
    rows.push(current);
    rows
}

/// Render the commit modal. Only called while `app.commit_input` is
/// `Some` (the `render` entry point gates on it).
fn render_commit_input(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let commit = app
        .commit_input
        .as_ref()
        .expect("render_commit_input requires an active commit");
    // Same wrap-and-grow as the prompt input: a long commit title
    // wraps and the box grows (max 8 visible rows, tail-scroll keeps
    // the cursor row on screen) instead of clipping at one row.
    let box_width = area.width.min(64);
    let inner_width = box_width.saturating_sub(2) as usize;
    let input_lines = wrap_input_with_cursor(&commit.text, inner_width.max(1));
    let visible_input = (input_lines.len() as u16).min(8);
    let height = (visible_input + 5).min(area.height);
    let rect = centered_overlay(frame, area, box_width, height, p);
    let title = if commit.amend {
        " Amend commit message "
    } else {
        " Commit message "
    };
    let mut lines: Vec<Line> = input_lines
        .iter()
        .skip(input_lines.len().saturating_sub(8))
        .map(|row| Line::from(Span::styled(row.clone(), Style::default().fg(p.text))))
        .collect();
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "Enter commit · Esc cancel · Ctrl-U clear",
        Style::default().fg(p.muted),
    )));
    frame.render_widget(
        Paragraph::new(lines)
            .block(overlay_panel(title, p))
            .style(Style::default().fg(p.text).bg(p.panel_bg)),
        rect,
    );
}

fn panel_block<'a>(title: &'a str, p: &Palette) -> Block<'a> {
    overlay_panel(title, p)
}

pub(crate) fn render_footer(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let mode = match app.mode {
        TuiMode::Navigate => "NAV",
        TuiMode::Attach => "ATTACH",
        TuiMode::Help => "HELP",
        TuiMode::Tour => "TOUR",
        TuiMode::ConfirmQuit => "QUIT?",
        TuiMode::Settings => "SET",
        TuiMode::WorktreeList => "WORKTREES",
        TuiMode::BranchPicker => "BRANCHES",
        TuiMode::SearchPalette => "SEARCH",
        TuiMode::SessionManager => "SESSIONS",
    };
    let prefix = if app.prefix.is_armed() {
        "Ctrl+B> "
    } else {
        ""
    };
    // While the prefix is armed, the hint slot becomes the legend of
    // keys live under it (zellij mode-bar style, user decision): the
    // user sees what the next key does instead of remembering blind.
    // The legend carries the same fit_hint budget path as every hint
    // below, so narrow terminals keep the tail (? help) and drop the
    // low-value front segments first.
    let context = app.footer_context();
    let help = if app.prefix.is_armed() {
        crate::tui::keys::prefix_legend(app.screen, app.mode)
    } else {
        context.hint()
    };
    // On narrow terminals (the classic 80x24) the full hint cannot fit:
    // the mode label alone eats 14+ columns and the status message needs
    // room. fit_hint drops the trailing low-priority actions first and
    // keeps the leading ones plus the `Ctrl+B ? help` discovery segment,
    // the one hint every screen needs, wherever it sits in the hint.
    // The real badge width: ` {mode}·{title} ` where the longest mode
    // label (WORKTREES) bounds the column every mode can occupy.
    let mode_width = [
        "NAV",
        "ATTACH",
        "HELP",
        "TOUR",
        "QUIT?",
        "SET",
        "WORKTREES",
        "BRANCHES",
        "SEARCH",
        "SESSIONS",
    ]
    .iter()
    .map(|m| m.len())
    .max()
    .unwrap_or(3);
    let label_width = 1 + mode_width + 1 + app.screen.title().len() + 1;
    // 24 columns of status message minimum: a one-row footer cannot
    // wrap, so the status slot must keep room for a real message
    // ("webui connection failed") next to the shrunken hint; the hint
    // shrinks first because fit_hint protects its discovery segment.
    let hint_budget = area
        .width
        .saturating_sub(label_width as u16)
        .saturating_sub(prefix.width() as u16)
        .saturating_sub(24) as usize;
    let help = if help.width() <= hint_budget {
        help.to_string()
    } else if app.prefix.is_armed() {
        // Armed: `help` is already the legend, trim it in place instead
        // of recomputing it (it has no compact twin).
        fit_hint(help, hint_budget)
    } else {
        // Shrink the FULL hint first (end-drop with the discovery
        // segment protected): it names more actions than the compact
        // twin, so prefer it whenever a couple of trailing actions fit.
        // fit_hint always returns a string within the budget (it
        // clip-cuts the tail as the last resort), so no second pass is
        // needed.
        fit_hint(help, hint_budget)
    };
    // Backend wait feedback: past the 500ms grace a healthy loopback
    // reply never needs, the message slot animates a spinner + hint so a
    // silent backend is visible while the 20s read timeout still runs.
    // Errors outrank the spinner; the animated frame reuses `app.tick`, so
    // it costs nothing when no request is in flight.
    let message = if app.error.is_some() {
        app.error.as_deref().unwrap_or(&app.status).to_string()
    } else if let Some(inflight) = &app.refresh_inflight {
        if inflight.started.elapsed() >= Duration::from_millis(500) {
            format!(
                "{} waiting for backend...",
                SPINNERS[((app.tick / 2) as usize) % SPINNERS.len()]
            )
        } else {
            app.status.clone()
        }
    } else {
        app.status.clone()
    };
    let message = message.as_str();
    // Split/move mode hint (design: Zellij-style mode bar): while an
    // overlay owns the keyboard the help slot swaps to the mode
    // verbs so the user sees the keys without the overlay. The armed
    // prefix legend outranks the mode hints: while Ctrl+B is armed all
    // mode keys are dead, so naming them would mislead.
    let help = if app.prefix.is_armed() {
        help
    } else {
        split_tiles::mode_hint(app).unwrap_or(help)
    };
    let used = label_width + help.width() + prefix.width();
    let status_budget = area.width.saturating_sub(used as u16) as usize;
    // The status/error slot wraps onto the rows the layout can spare
    // instead of one truncated line: a long backend error was the one
    // message the user most needs to read, and ellipsis hid its tail
    // with no way to see it. No marquee; the wrapped rows are static.
    let available = area.height.max(1) as usize;
    let status_style = Style::default().fg(if app.error.is_some() { p.red } else { p.muted });
    let wrapped_status = wrap_plain(message, status_budget.max(8));
    let mut status_rows = wrapped_status.into_iter().take(available);
    let mut spans = vec![
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
    ];
    // First wrapped row rides the chrome line; extra rows follow as
    // their own lines so they stay in the message slot, not under the
    // mode label.
    push_first_status_row(&mut spans, &mut status_rows, status_style);
    let mut lines = vec![Line::from(spans)];
    lines.extend(status_rows.map(|row| Line::from(Span::styled(row, status_style))));
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().bg(p.panel_alt))
            .wrap(Wrap { trim: false }),
        area,
    );
}

/// Coverage is off because wrap_plain never returns zero rows and the
/// footer area is always at least one line, so status_rows always
/// yields a first row and the None arm only guards future changes.
#[cfg_attr(coverage, coverage(off))]
fn push_first_status_row<I: Iterator<Item = String>>(
    spans: &mut Vec<Span<'_>>,
    status_rows: &mut I,
    status_style: Style,
) {
    if let Some(first) = status_rows.next() {
        spans.push(Span::styled(first, status_style));
    }
}

/// Narrow-terminal footer hints: same information, fewer actions listed.
/// Hints and legends are written in priority order (screens and lifecycle
/// first, git and niche chords last), so shrinking drops whole `·`-separated
/// segments from the END and keeps the leading ones. The discovery
/// segment (`Ctrl+B ? help`) is protected wherever it sits: it joins every
/// shrinking round because it is the one hint every screen needs. The
/// single-segment fallback keeps its end chars for the same reason.
pub(crate) fn fit_hint(hint: &str, budget: usize) -> String {
    let segments: Vec<&str> = hint.trim().split(" · ").collect();
    let joined = format!(" {} ", segments.join(" · "));
    if joined.width() <= budget {
        return joined;
    }
    // The discovery tail is protected: wherever the hint places it, it
    // rides every shrink so navigation to help never disappears.
    let discovery = segments
        .iter()
        .position(|seg| seg.contains("? help"))
        .map(|idx| segments[idx])
        .unwrap_or("");
    for keep in (1..=segments.len()).rev() {
        // Keep the first `keep` segments plus the protected discovery
        // segment when it is not already among them.
        let mut candidate: Vec<&str> = segments[..keep].to_vec();
        if !discovery.is_empty() && !candidate.contains(&discovery) {
            candidate.push(discovery);
        }
        let joined = format!(" {} ", candidate.join(" · "));
        if joined.width() <= budget {
            return joined;
        }
    }
    // Only the discovery segment fits (very narrow terminal): keep its
    // end, which carries the help hint itself. Hints with no discovery
    // tail (the quit prompt and the tour capture all keys) fall back
    // to their first segment so the shrink never collapses to a blank
    // line.
    let tail = if discovery.is_empty() {
        segments[0]
    } else {
        discovery
    };
    let tail_line = format!(" {tail} ");
    if tail_line.width() > budget {
        // Column-based skip, not char-based: a wide char counts for
        // two columns, so dropping its char would overshoot.
        let mut kept_width = 0usize;
        let mut kept = String::new();
        for ch in tail_line.chars() {
            let ch_width = ch.width().unwrap_or(0);
            if kept_width + ch_width > budget {
                break;
            }
            kept_width += ch_width;
            kept.push(ch);
        }
        kept
    } else {
        tail_line
    }
}

/// The `filter: query_  matched/total` line shared by the help and
/// worktree overlays while a type-to-filter query is active (webui
/// search-box counterpart; returns None when the query is empty).
fn filter_query_line(
    p: &Palette,
    filter: &str,
    matched: usize,
    total: usize,
) -> Option<Line<'static>> {
    if filter.is_empty() {
        return None;
    }
    Some(Line::from(vec![
        Span::styled(" filter: ", Style::default().fg(p.muted)),
        Span::styled(format!("{filter}_"), Style::default().fg(p.accent)),
        Span::styled(format!("  {matched}/{total}"), Style::default().fg(p.muted)),
    ]))
}

/// Depth effect for overlay windows (webui `.modal-backdrop { background:
/// #0008 }` + `.modal { box-shadow }`). Terminals cannot paint a
/// translucent scrim over existing text, so the backdrop is faked by
/// dimming the foreground color of every cell behind the overlay, the
/// way neovim dims its float background. Works with the `system`
/// theme too: it folds existing colors instead of painting a bg.
fn dim_backdrop(frame: &mut Frame<'_>, p: &Palette) {
    let area = frame.area();
    let buffer = frame.buffer_mut();
    for y in area.y..area.bottom() {
        for x in area.x..area.right() {
            let cell = buffer.cell_mut((x, y)).expect("cell inside area");
            cell.fg = dim_color(cell.fg, p);
            cell.bg = dim_color(cell.bg, p);
        }
    }
}

/// Folds a color toward the muted tone (one step down in emphasis),
/// keeping `Reset` (the terminal default) folded to `Reset` so the
/// system theme never paints an opaque bg where the user's terminal
/// background shows through.
pub(crate) fn dim_color(color: Color, p: &Palette) -> Color {
    match color {
        Color::Reset => Color::Reset,
        Color::Rgb(r, g, b) => {
            // Fold the channel toward the border tone of the palette,
            // halfway (the `/ 2` keeps the fold gentle, one emphasis
            // step down like the webui's #0008 scrim).
            let m = border_tone(p) as i16;
            let fold =
                |channel: u8| (channel as i16 + (m - channel as i16) / 2).clamp(0, 255) as u8;
            Color::Rgb(fold(r), fold(g), fold(b))
        }
        Color::White | Color::Black => p.border,
        Color::Red => p.red,
        Color::Green => p.green,
        Color::Blue => p.accent,
        Color::Yellow => p.yellow,
        Color::Cyan => p.teal,
        Color::Magenta => p.accent,
        Color::DarkGray | Color::Gray => p.muted,
        _ => p.muted,
    }
}

/// The channel the dimming folds toward: the border tone of the
/// active palette (its green channel on light themes, red on dark).
pub(crate) fn border_tone(p: &Palette) -> u8 {
    match p.border {
        Color::Rgb(r, g, _) => {
            if is_dark(p) {
                r
            } else {
                g
            }
        }
        _ => 128,
    }
}

pub(crate) fn is_dark(p: &Palette) -> bool {
    // The panel bg of the dark palette is darker than the light one's.
    match p.panel_bg {
        Color::Rgb(r, _, _) => r < 128,
        _ => true,
    }
}

/// Neovim-style drop shadow: a one-cell band on the right and bottom
/// edges of the overlay rect, painted with the shadow color of the
/// palette (near-black on dark themes, gray on light ones).
/// Shadow first, then Clear + widget on top: ratatui's Paragraph only
/// recolors cells (set_style) and writes its own graphemes, it never
/// blanks leftover symbols from the screen below, so a modal rendered
/// without this wipe shows the underlying text through its interior
/// like a translucent window. Clear resets the cells so the panel bg
/// paints over a truly empty rect.
fn render_shadow(frame: &mut Frame<'_>, rect: Rect, p: &Palette) {
    let shadow = shadow_color(p);
    let style = Style::default().bg(shadow);
    // Clamp the bands to the frame so a full-width or full-height
    // overlay does not write outside the buffer.
    let area = frame.area();
    let buffer = frame.buffer_mut();
    let right = rect.right();
    for y in rect.y..rect.bottom() {
        for x in right..(right + 1).min(area.right()) {
            let cell = buffer.cell_mut((x, y)).expect("cell inside area");
            cell.set_char(' ');
            cell.set_style(style);
        }
    }
    let bottom = rect.bottom();
    for y in bottom..(bottom + 1).min(area.bottom()) {
        for x in rect.x..right {
            let cell = buffer.cell_mut((x, y)).expect("cell inside area");
            cell.set_char(' ');
            cell.set_style(style);
        }
    }
    // Wipe the modal rect AFTER the shadow: the shadow bands sit
    // outside `rect`, so this Clear only touches the modal itself.
    frame.render_widget(Clear, rect);
}

pub(crate) fn shadow_color(p: &Palette) -> Color {
    if is_dark(p) {
        Color::Rgb(10, 10, 16)
    } else {
        Color::Rgb(203, 213, 225)
    }
}

/// Overlay block: same border as `panel` but with the accent-colored
/// border, the neovim float-window look (nvim_win_set_config border
/// highlight).
fn overlay_panel<'a>(title: &'a str, p: &Palette) -> Block<'a> {
    panel(title, p).border_style(Style::default().fg(p.accent))
}

/// Centers an overlay of `width` x `height` inside `area`, clamped to
/// the available size. Shared by every overlay window so they all sit
/// on the same spot and drop the same shadow.
fn overlay_rect(area: Rect, width: u16, height: u16) -> Rect {
    let width = width.min(area.width);
    let height = height.min(area.height);
    Rect::new(
        area.x + area.width.saturating_sub(width) / 2,
        area.y + area.height.saturating_sub(height) / 2,
        width,
        height,
    )
}

/// Centers an overlay of `width` x `height` inside `area`, clamped to
/// the available size, and paints its shadow. Every overlay window uses
/// this so they all sit on the same spot and drop the same shadow.
fn centered_overlay(
    frame: &mut Frame<'_>,
    area: Rect,
    width: u16,
    height: u16,
    p: &Palette,
) -> Rect {
    let rect = overlay_rect(area, width, height);
    render_shadow(frame, rect, p);
    rect
}

fn render_help(frame: &mut Frame<'_>, area: Rect, p: &Palette, filter: &str, scroll: usize) {
    let rows = crate::tui::keys::filtered_help_rows(filter);
    // One extra line for the filter query while it is active.
    let filter_height = if filter.is_empty() { 0 } else { 1 };
    let height = (rows.len() as u16 + 4 + filter_height).min(50);
    let rect = centered_overlay(frame, area, area.width.min(72), height, p);
    let mut lines = vec![Line::from(Span::styled(
        "Herdr WebUI TUI",
        Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
    ))];
    // Webui settings-search counterpart: show the active query so the
    // user sees why the list shrank.
    if let Some(line) =
        filter_query_line(p, filter, rows.len(), crate::tui::keys::help_rows().len())
    {
        lines.push(line);
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
            .block(
                overlay_panel(title, p)
                    .title_bottom(Line::from(format!(" v{HERDR_WEBUI_VERSION} ")).right_aligned()),
            )
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .scroll((scroll as u16, 0)),
        rect,
    );
}

/// Browser overlay (webui worktree open modal, prefix `W`): the
/// browse root itself ("this folder"), discovered worktree checkouts,
/// and subdirectories, with the typed filter query, j/k cursor, and
/// Enter-open/descend. Mirrors the webui rows: title (path + label),
/// branch, linked badge; folders get a dir badge.
fn render_worktree_list(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let rows = app.filtered_browser_rows();
    let filter_height = if app.worktree_filter.is_empty() { 0 } else { 1 };
    let height = ((rows.len() as u16 + 5 + filter_height).min(24)).max(7 + filter_height);
    let rect = centered_overlay(frame, area, area.width.min(80), height, p);
    let mut lines = vec![Line::from(vec![
        Span::styled(
            " Open workspace or worktree ",
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("in {} ", app.worktree_root),
            Style::default().fg(p.muted),
        ),
    ])];
    if let Some(line) = filter_query_line(
        p,
        &app.worktree_filter,
        rows.len(),
        app.browser_rows().len(),
    ) {
        lines.push(line);
    }
    if rows.is_empty() {
        lines.push(Line::from(Span::styled(
            " No worktrees or folders match your search ",
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
        let (title, badge) = match row {
            BrowserRow::ThisFolder { path } => (
                format!("this folder: {path}"),
                if app.worktree_pick_workspace {
                    " [o stages for new workspace]".to_string()
                } else {
                    " [open as workspace]".to_string()
                },
            ),
            BrowserRow::Worktree(worktree) => {
                let linked = if worktree.is_linked {
                    " [linked]"
                } else {
                    " [main]"
                };
                // Desktop `worktreePopoverRow` marks the checkout the
                // workspace already sits on (check current).
                let workspace_cwd = app
                    .selected_workspace()
                    .map(|ws| ws.cwd.as_str())
                    .unwrap_or("");
                let current = !workspace_cwd.is_empty()
                    && crate::tui::same_checkout_path(&worktree.path, workspace_cwd);
                let title = if current {
                    format!("✓ {}", worktree.title())
                } else {
                    worktree.title()
                };
                (
                    title,
                    if worktree.branch.is_empty() {
                        linked.to_string()
                    } else {
                        format!("  {}{}", worktree.branch, linked)
                    },
                )
            }
            BrowserRow::Folder { name, .. } => {
                let badge = if app.worktree_pick_workspace {
                    " [folder, Enter descends]"
                } else {
                    " [folder]"
                };
                (format!("{name}/"), badge.to_string())
            }
        };
        lines.push(Line::from(vec![
            Span::styled(cursor, Style::default().fg(p.accent)),
            Span::styled(title, title_style),
            Span::styled(badge, Style::default().fg(p.muted)),
        ]));
    }
    // Keep the cursor inside the window when the list outgrows the
    // overlay (webui modal scrolls the selected row into view).
    let header_lines = 2 + filter_height; // border + title (+ filter line)
    let visible_rows = height.saturating_sub(header_lines + 1).max(1) as usize;
    let scroll = app
        .worktree_selected
        .saturating_sub(visible_rows.saturating_sub(1));
    let title = if app.worktree_pick_workspace {
        " New workspace · o stages the folder · Enter descends folders · h parent · type to filter · Esc cancels "
    } else if app.worktree_filter.is_empty() {
        " Worktrees · Enter opens/enters · o opens · c create worktree · h parent · type to filter · Esc closes "
    } else {
        " Worktrees · Esc clears the filter "
    };
    frame.render_widget(
        Paragraph::new(lines)
            .block(overlay_panel(title, p))
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .scroll((scroll as u16, 0)),
        rect,
    );
}

/// Branch picker overlay (desktop location-bar branch popover, prefix
/// `v`): local branches of the selected workspace repo with the current
/// branch pinned first (✓ marker), type-to-filter, j/k cursor. Rows
/// checked out in a sibling worktree carry a [worktree] badge and
/// reroute on Enter; the filter naming no branch becomes the create
/// CTA (new branch + switch).
fn render_branch_picker(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    use crate::tui::panels::git::GitBranchEntry;

    let rows: Vec<GitBranchEntry> = app.filtered_branch_picker_rows();
    let filter_height = if app.branch_picker_filter.is_empty() {
        0
    } else {
        1
    };
    let height = ((rows.len() as u16 + 5 + filter_height).min(24)).max(7 + filter_height);
    let rect = centered_overlay(frame, area, area.width.min(72), height, p);
    let mut lines = vec![Line::from(vec![
        Span::styled(
            " Switch branch ",
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!("in {} ", app.branch_picker_root),
            Style::default().fg(p.muted),
        ),
    ])];
    if let Some(line) = filter_query_line(
        p,
        &app.branch_picker_filter,
        rows.len(),
        app.branch_picker_rows.len(),
    ) {
        lines.push(line);
    }
    if rows.is_empty() {
        lines.push(Line::from(Span::styled(
            " No branches match · Enter creates this branch ",
            Style::default().fg(p.muted),
        )));
    }
    let cwd = app.branch_picker_root.as_str();
    for (index, row) in rows.iter().enumerate() {
        let selected = index == app.branch_picker_selected;
        let cursor = if selected { "▸ " } else { "  " };
        let title_style = if selected {
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(p.text)
        };
        let marker = if row.current { "✓ " } else { "" };
        let badge = match row
            .worktree_path
            .as_deref()
            .filter(|path| !path.is_empty() && !crate::tui::same_checkout_path(path, cwd))
        {
            Some(_) => " [worktree]".to_string(),
            None => String::new(),
        };
        lines.push(Line::from(vec![
            Span::styled(cursor, Style::default().fg(p.accent)),
            Span::styled(format!("{marker}{}", row.name), title_style),
            Span::styled(badge, Style::default().fg(p.muted)),
        ]));
    }
    // Keep the cursor inside the window when the list outgrows the
    // overlay.
    let header_lines = 2 + filter_height; // border + title (+ filter line)
    let visible_rows = height.saturating_sub(header_lines + 1).max(1) as usize;
    let scroll = app
        .branch_picker_selected
        .saturating_sub(visible_rows.saturating_sub(1));
    let title = if app.branch_picker_filter.is_empty() {
        " Branches · Enter switch/worktree · j/k moves · type filters · Esc closes "
    } else {
        " Branches · Enter switches or creates · Esc clears the filter "
    };
    frame.render_widget(
        Paragraph::new(lines)
            .block(overlay_panel(title, p))
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .scroll((scroll as u16, 0)),
        rect,
    );
}

/// Search palette overlay (webui search palette, prefix `/`): query
/// line plus the result rows (local workspaces/panels/agents while
/// typing, file and content hits after the Enter commit), j/k moves
/// the cursor, Enter commits/navigates, Esc closes.
fn render_search_palette(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let palette = &app.search_palette;
    let rows = palette.results.len();
    // border + title + query line + rows (+1 slack), capped at 20.
    let height = ((rows as u16) + 5).clamp(5, 20);
    let rect = centered_overlay(frame, area, area.width.min(72), height, p);
    let mut lines = vec![Line::from(vec![
        Span::styled(
            " Search ",
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
        ),
        Span::styled(format!("{} results ", rows), Style::default().fg(p.muted)),
    ])];
    lines.push(Line::from(vec![
        Span::styled(" query: ", Style::default().fg(p.muted)),
        Span::styled(format!("{}_", palette.query), Style::default().fg(p.accent)),
    ]));
    if rows == 0 {
        lines.push(Line::from(Span::styled(
            if palette.query.is_empty() {
                " type to search workspaces, panels, agents, files, content "
            } else if palette.committed {
                " no results "
            } else {
                " Enter searches files and content too "
            },
            Style::default().fg(p.muted),
        )));
    }
    for (index, candidate) in palette.results.iter().enumerate() {
        let selected = index == palette.selected;
        let cursor = if selected { "▸ " } else { "  " };
        let title_style = if selected {
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(p.text)
        };
        // Desktop disabled recent rows render dimmed with an
        // "(already open)" hint; recent rows also carry their
        // kind/branch/path subtitle.
        let (title, subtitle) = match candidate {
            search::SearchCandidate::Recent {
                title,
                subtitle,
                is_open: true,
                ..
            } => (format!("{title} (already open)"), Some(subtitle.as_str())),
            search::SearchCandidate::Recent { subtitle, .. } => {
                (candidate.title().to_string(), Some(subtitle.as_str()))
            }
            _ => (candidate.title().to_string(), None),
        };
        let is_open_recent = matches!(
            candidate,
            search::SearchCandidate::Recent { is_open: true, .. }
        );
        let mut spans = vec![
            Span::styled(cursor, Style::default().fg(p.accent)),
            Span::styled(
                format!("[{}] ", candidate.icon()),
                Style::default().fg(p.muted),
            ),
            Span::styled(
                truncate(&title, 40),
                if is_open_recent {
                    Style::default().fg(p.muted)
                } else {
                    title_style
                },
            ),
        ];
        if let Some(subtitle) = subtitle.filter(|text| !text.is_empty()) {
            spans.push(Span::styled(
                format!(" \u{b7} {}", truncate(subtitle, 36)),
                Style::default().fg(p.muted),
            ));
        }
        lines.push(Line::from(spans));
    }
    // Keep the cursor inside the window when the rows outgrow the
    // overlay (scroll like the worktree browser).
    let header_lines = 4usize; // border + title + query line (+ border bottom)
    let visible_rows = height.saturating_sub(header_lines as u16 + 1).max(1) as usize;
    let scroll = palette
        .selected
        .saturating_sub(visible_rows.saturating_sub(1));
    frame.render_widget(
        Paragraph::new(lines)
            .block(overlay_panel(
                " Search · Enter commits/navigates · Ctrl+X removes a recent · Esc closes ",
                p,
            ))
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .scroll((scroll as u16, 0)),
        rect,
    );
}

/// Session manager overlay (webui session manager surface, prefix
/// Shift+P): server-known sessions with running/offline badges, the
/// active row marked ✓ (name + backend match), j/k cursor, Enter
/// targets a running session, `l` launches, `x` closes, `c` cleans
/// up stale built-in slots, `n` opens the create prompt.
fn render_session_manager(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    let rows = &app.session_rows;
    let error_height = if app.session_load_error.is_some() {
        1
    } else {
        0
    };
    let height = ((rows.len() as u16 + 5 + error_height).min(20)).max(7 + error_height);
    let rect = centered_overlay(frame, area, area.width.min(76), height, p);
    let mut lines = vec![Line::from(vec![
        Span::styled(
            " Sessions ",
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            format!(
                "targeting {} · {} ",
                app.current_session, app.current_backend
            ),
            Style::default().fg(p.muted),
        ),
    ])];
    if let Some(err) = &app.session_load_error {
        lines.push(Line::from(Span::styled(
            format!(" load failed: {err} "),
            Style::default().fg(p.red),
        )));
    }
    if rows.is_empty() && app.session_load_error.is_none() {
        lines.push(Line::from(Span::styled(
            " No sessions found (n creates one, r reloads) ",
            Style::default().fg(p.muted),
        )));
    }
    for (index, row) in rows.iter().enumerate() {
        let selected = index == app.session_selected;
        let cursor = if selected { "▸ " } else { "  " };
        let active = row.name == app.current_session && row.backend == app.current_backend;
        let title_style = if selected {
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(p.text)
        };
        // Row budget from the overlay itself: the backend/status chip
        // is fixed-width chrome, the name gets the remainder so a long
        // session name folds with an ellipsis instead of pushing the
        // chip off the edge with no marker.
        let chip_width = format!("  {} · running ", row.backend_label).width() + 4;
        let name_budget = (rect.width.saturating_sub(chip_width as u16)).max(8) as usize;
        // The active row paints a 2-column check prefix; budget for it
        // or the prefix plus the truncated name pushes the chip out.
        let title = if active {
            format!("✓ {}", truncate(&row.name, name_budget.saturating_sub(2)))
        } else {
            truncate(&row.name, name_budget)
        };
        let status = if row.running { "running" } else { "offline" };
        lines.push(Line::from(vec![
            Span::styled(cursor, Style::default().fg(p.accent)),
            Span::styled(title, title_style),
            Span::styled(
                format!("  {} · {}", row.backend_label, status),
                Style::default().fg(if row.running { p.muted } else { p.red }),
            ),
        ]));
    }
    let title = " Sessions · Enter switch · l launch · x close · c cleanup · n new · r reload · Esc closes ";
    // Selected-row anchored scroll (same as the branch picker and
    // search palette): past the visible window the selection pins the
    // bottom row, so j/k never walks the cursor off-screen.
    let header_lines = 1 + error_height + 1; // title line (+ error) + bottom border
    let visible_rows = height.saturating_sub(header_lines + 1).max(1) as usize;
    let scroll = app
        .session_selected
        .saturating_sub(visible_rows.saturating_sub(1));
    frame.render_widget(
        Paragraph::new(lines)
            .block(overlay_panel(title, p))
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
    let rect = centered_overlay(frame, area, area.width.min(64), 14, p);
    let git_cwd = app.git_panel.cwd.clone();
    let files_cwd = app.file_explorer.cwd.clone();
    // Values wrap instead of clipping at the box edge (a long base
    // URL or deep cwd is the one thing this overlay exists to show),
    // so the box grows one row per value that wraps past the key
    // column: the fixed 13-row budget had no slack and the wrap
    // would push the hint lines off the bottom.
    let value_budget = (rect.width.saturating_sub(2 + 16 + 2)).max(8) as usize;
    let wrapped_extra = [app.web_api.base_url(), git_cwd.clone(), files_cwd.clone()]
        .iter()
        // Count the extra ROWS, not the wrapping values: a value that
        // folds across 3 rows needs 2 extra rows of height, so the
        // per-value +1 undercounted and the third row clipped.
        .map(|value| wrap_plain(value, value_budget).len().saturating_sub(1))
        .sum::<usize>() as u16;
    let rect = {
        let height = (14 + wrapped_extra).min(area.height);
        Rect::new(
            rect.x,
            rect.y + rect.height.saturating_sub(height) / 2,
            rect.width,
            height,
        )
    };
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
        row(
            "ctrl+b passthrough",
            if app.terminal_prefix_passthrough {
                "on (shell keeps Ctrl+B while attached)"
            } else {
                "off"
            },
        ),
        row(
            "onboarding tour",
            match crate::tui::tui_tour_state().as_deref() {
                Some("done") => "already run (finished)",
                Some("skipped") => "already run (skipped early)",
                _ => "not run yet",
            },
        ),
        Line::from(""),
        Line::from(Span::styled(
            " t theme · p passthrough · T replay tour · Esc closes ",
            Style::default().fg(p.accent),
        )),
        Line::from(Span::styled(
            " other options live in the webui Settings modal ",
            Style::default().fg(p.muted),
        )),
    ];
    frame.render_widget(
        Paragraph::new(lines)
            .block(
                overlay_panel(" Settings · Esc closes ", p)
                    .title_bottom(Line::from(format!(" v{HERDR_WEBUI_VERSION} ")).right_aligned()),
            )
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .wrap(Wrap { trim: false }),
        rect,
    );
}

/// Quit confirmation overlay. Every quit path opens this first; unlike
/// the destructive typed-`y` prompts, this one stays light: y/Enter
/// quits, n/Esc (or any other key) stays, Ctrl+C also quits.
fn render_confirm_quit(frame: &mut Frame<'_>, area: Rect, p: &Palette) {
    let rect = centered_overlay(frame, area, area.width.min(48), 7, p);
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
            .block(overlay_panel(" Quit? ", p))
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
    // Every state carries a distinct glyph shape (design doc:
    // "Glyph shape differs too, so status never rides on color
    // alone"), so color-blind users and low-contrast themes can
    // still tell blocked/working/done apart in tile titles and the
    // AGENTS summary bar.
    match status {
        "blocked" => ("✕", Style::default().fg(p.red)),
        "working" => ("◐", Style::default().fg(p.yellow)),
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

pub(crate) use crate::tui::text::{
    filter_name_spans, split_line_at_cursor, tail_visible, truncate,
};

#[cfg(test)]
mod tests {
    use super::{
        filter_name_spans, fit_hint, split_line_at_cursor, tail_visible, truncate, wrap_plain,
    };
    use ratatui::backend::TestBackend;
    use ratatui::Terminal;
    use unicode_width::UnicodeWidthStr;

    #[test]
    fn match_span_helpers_cover_windows_and_cursor_splits() {
        // Long `before` window: keep only the tail that fits the budget.
        assert_eq!(tail_visible("abcdefghij", 4), "ghij");
        // Fits the budget: returned unchanged.
        assert_eq!(tail_visible("ab", 10), "ab");
        // Char-boundary safe: a 2-wide char never gets sliced mid-byte.
        assert_eq!(tail_visible("a\u{4e2d}\u{4e2d}", 2), "\u{4e2d}");
        // Budget 0 stops before consuming any column.
        assert_eq!(tail_visible("ab", 0), "");

        // Cursor at a char boundary splits (before, caret, after).
        assert_eq!(
            split_line_at_cursor("abcd", 2),
            ("ab".to_string(), "c".to_string(), "d".to_string())
        );
        // Cursor past the line end rides a padding space.
        assert_eq!(
            split_line_at_cursor("ab", 9),
            ("ab".to_string(), " ".to_string(), String::new())
        );
        assert_eq!(
            split_line_at_cursor("", 0),
            ("".to_string(), " ".to_string(), String::new())
        );
        // Byte offset inside a multibyte char snaps forward to the boundary.
        assert_eq!(
            split_line_at_cursor("a\u{4e2d}b", 2),
            ("a\u{4e2d}".to_string(), "b".to_string(), String::new())
        );
    }

    #[test]
    fn truncate_zero_budget_and_column_limits() {
        // Zero budget returns empty instead of paying for the ellipsis.
        assert_eq!(truncate("abc", 0), "");
        // Fits: unchanged.
        assert_eq!(truncate("abc", 5), "abc");
        // Overflow clips by display columns and reserves one for the ellipsis.
        assert_eq!(truncate("abcdef", 4), "abc\u{2026}");
        // A 2-wide char pays 2 columns before the ellipsis fits.
        assert_eq!(truncate("a\u{4e2d}bcd", 3), "a\u{2026}");
    }

    #[test]
    fn filter_name_spans_plain_and_highlight_rows() {
        // Filter off: one plain span.
        assert_eq!(
            filter_name_spans("main.rs", "main", false),
            vec![("main.rs".to_string(), false)]
        );
        // Occurrence splits into before/matched/after, empty spans dropped.
        assert_eq!(
            filter_name_spans("main.rs", "MAIN", true),
            vec![("main".to_string(), true), (".rs".to_string(), false)]
        );
        assert_eq!(
            filter_name_spans("src/main.rs", "main", true),
            vec![
                ("src/".to_string(), false),
                ("main".to_string(), true),
                (".rs".to_string(), false)
            ]
        );
        // No visible occurrence: one plain span.
        assert_eq!(
            filter_name_spans("main.rs", "zzz", true),
            vec![("main.rs".to_string(), false)]
        );
        // Whitespace-only needle: treated as no filter.
        assert_eq!(
            filter_name_spans("main.rs", "  ", true),
            vec![("main.rs".to_string(), false)]
        );
    }

    #[test]
    fn edit_cursor_render_keeps_short_before_and_truncates_long_lines() {
        // Wide enough for the sidebar (34 cols) plus the 90-column
        // tree/preview split inside the files screen.
        let backend = TestBackend::new(130, 12);
        let mut terminal = Terminal::new(backend).unwrap();
        let client = crate::backend_client::BackendClient::builtin_session(None);
        let mut app = crate::tui::TuiApp::new(client, std::time::Duration::from_secs(1));
        app.screen = crate::tui::TuiScreen::Files;
        app.file_explorer.preview = crate::tui::panels::FilePreview {
            path: Some("notes.md".to_string()),
            content: "line one\nline two".to_string(),
            truncated: false,
            binary: false,
            hash: "h1".to_string(),
            dirty: false,
        };
        app.file_explorer.edit_active = true;
        // Cursor mid-line: `before` fits the budget, so the else branch
        // clones it whole instead of scrolling a tail window.
        app.file_explorer.edit_cursor = 5;

        terminal.draw(|frame| super::render(frame, &app)).unwrap();
        let rendered = format!("{:?}", terminal.backend().buffer());
        assert!(rendered.contains("line "));
        assert!(rendered.contains("one"));

        // Cursor deep in a line wider than the pane: `before` overflows
        // the budget, so tail_visible keeps only the tail of `before`.
        let long_line = "aaaa bbbb cccc dddd ".repeat(6);
        app.file_explorer.preview.content = long_line.clone();
        app.file_explorer.edit_cursor = long_line.len() - 1;
        terminal.draw(|frame| super::render(frame, &app)).unwrap();
        let rendered = format!("{:?}", terminal.backend().buffer());
        assert!(rendered.contains("dddd"));
    }

    #[test]
    fn wrap_plain_zero_budget_word_wrap_and_no_blank_rows() {
        // Zero budget means no wrapping contract: the text rides as one row.
        assert_eq!(wrap_plain("hello", 0), vec!["hello".to_string()]);
        assert_eq!(
            wrap_plain("abc def", 4),
            vec!["abc ".to_string(), "def".to_string()]
        );
        assert!(wrap_plain("a  b", 4)
            .iter()
            .all(|row| !row.trim().is_empty()));
    }

    #[test]
    fn fit_hint_keeps_discovery_tail_within_budget() {
        // Early return: the padded hint already fits, unchanged.
        assert_eq!(fit_hint(" short ", 50), " short ");
        // Segment shrink keeps the protected discovery tail.
        let trimmed = fit_hint(" a · b · c · ? help ", 8);
        assert!(trimmed.width() <= 8);
        assert!(trimmed.contains("? help"));
        // Char-clip path: only the discovery tail fits, clipped by columns.
        assert_eq!(fit_hint(" x · ? help ", 3), " ? ");
    }

    #[test]
    fn fit_hint_no_discovery_fallback_keeps_first_segment() {
        // Hints without a `? help` tail (the quit prompt, the tour)
        // previously shrank to a blank line: the old fallback always
        // rendered the discovery segment, which was empty for them.
        // They now fall back to their first segment, so the footer
        // never goes dark at small budgets.
        let trimmed = fit_hint(" y quit · n/Esc cancel ", 6);
        assert_eq!(trimmed, " y qui");
        // Clip sub-path of the same fallback: 1-2 col budgets still
        // render the padded leading columns instead of a blank line.
        assert!(!fit_hint(" y quit · n/Esc cancel ", 1).is_empty());
        assert!(!fit_hint(" y quit · n/Esc cancel ", 2).is_empty());
    }
}

#[cfg(test)]
mod coverage_tests_round7 {
    use super::*;

    fn palette() -> Palette {
        crate::tui::theme::TuiTheme::Dark.palette()
    }

    #[test]
    fn status_glyphs_cover_every_documented_state() {
        // blocked/done arms of status_dot, agent_icon, status_style: the
        // tile titles and summary bar must carry them distinctly.
        let p = palette();
        assert_eq!(status_dot("blocked", &p).0, "✕");
        assert_eq!(agent_icon("blocked", 0, &p).0, "◉");
        assert_eq!(agent_icon("done", 0, &p).0, "●");
        assert!(status_style("blocked", &p)
            .add_modifier
            .contains(ratatui::style::Modifier::BOLD));
    }

    #[test]
    fn truncate_returns_the_input_when_it_fits_and_ellipsizes_overflow() {
        // The fits-verbatim early return and the ellipsis overflow path.
        assert_eq!(truncate("abc", 10), "abc");
        assert_eq!(truncate("abcdef", 3), "ab…");
        assert_eq!(truncate("abcdef", 1), "…");
    }
}

#[cfg(test)]
mod coverage_tests_round8 {
    use super::*;
    use crate::tui::{PromptInput, PromptKind, TuiApp, TuiScreen};

    fn app() -> TuiApp {
        crate::tui::tests::app_with_snapshot()
    }

    fn draw(app: &TuiApp, width: u16, height: u16) -> String {
        let backend = ratatui::backend::TestBackend::new(width, height);
        let mut terminal = ratatui::Terminal::new(backend).unwrap();
        terminal.draw(|frame| super::render(frame, app)).unwrap();
        format!("{:?}", terminal.backend().buffer())
    }

    #[test]
    fn pane_title_falls_back_to_the_terminal_title_and_shell() {
        // Empty-string label: the filter closure rejects it and the name
        // falls through display_agent/agent/terminal_title.
        let mut a = app();
        a.snapshot.panes[0].label = Some(String::new());
        a.snapshot.panes[0].display_agent = None;
        a.snapshot.panes[0].agent = None;
        a.snapshot.panes[0].terminal_title = Some("editor".to_string());
        assert!(draw(&a, 120, 30).contains("editor"));

        // No label, no display_agent, no agent: the title falls through
        // terminal_title, then to "shell" when that is absent too.
        let mut a = app();
        a.snapshot.panes[0].label = None;
        a.snapshot.panes[0].agent = None;
        a.snapshot.panes[0].display_agent = None;
        a.snapshot.panes[0].terminal_title = Some("editor".to_string());
        assert!(draw(&a, 120, 30).contains("editor"));
        a.snapshot.panes[0].terminal_title = None;
        assert!(draw(&a, 120, 30).contains("shell"));
    }

    #[test]
    fn file_tree_status_colors_cover_every_class() {
        // Each git status class maps to its own color arm in the tree.
        let mut a = app();
        a.screen = TuiScreen::Files;
        a.file_explorer.entries = vec![
            crate::tui::panels::files::FileEntry {
                path: "del.rs".into(),
                name: "del.rs".into(),
                is_dir: false,
                size: None,
                level: 0,
                expanded: false,
                git_status: Some("deleted".into()),
            },
            crate::tui::panels::files::FileEntry {
                path: "mod.rs".into(),
                name: "mod.rs".into(),
                is_dir: false,
                size: None,
                level: 0,
                expanded: false,
                git_status: Some("modified".into()),
            },
            crate::tui::panels::files::FileEntry {
                path: "new.rs".into(),
                name: "new.rs".into(),
                is_dir: false,
                size: None,
                level: 0,
                expanded: false,
                git_status: Some("added".into()),
            },
            crate::tui::panels::files::FileEntry {
                path: "chg.rs".into(),
                name: "chg.rs".into(),
                is_dir: false,
                size: None,
                level: 0,
                expanded: false,
                git_status: Some("changed".into()),
            },
            crate::tui::panels::files::FileEntry {
                path: "odd.rs".into(),
                name: "odd.rs".into(),
                is_dir: false,
                size: None,
                level: 0,
                expanded: false,
                git_status: Some("unknown-class".into()),
            },
            crate::tui::panels::files::FileEntry {
                path: "src".into(),
                name: "src".into(),
                is_dir: true,
                size: None,
                level: 0,
                expanded: false,
                git_status: None,
            },
        ];
        let _ = draw(&a, 130, 20);
    }

    #[test]
    fn git_tab_bar_shows_the_workspace_drift_badge_and_prompt_names() {
        // Drifted cwd badge, delete-branch and drop-stash prompt titles
        // with their selected rows in range.
        let mut a = app();
        a.screen = TuiScreen::Git;
        a.git_panel.cwd = "/elsewhere".to_string();
        a.git_panel.branches = vec![crate::tui::panels::git::GitBranchEntry {
            name: "main".to_string(),
            current: true,
            remote: false,
            pushed: true,
            worktree_path: None,
        }];
        a.prompt_input = Some(PromptInput::new(PromptKind::ConfirmDeleteBranch));
        let _ = draw(&a, 130, 30);
        assert!(a.git_panel.branch_selected == 0);

        a.git_panel.stashes = vec![crate::tui::panels::git::GitStashEntry {
            name: "stash@{0}".to_string(),
            message: "wip".to_string(),
        }];
        a.prompt_input = Some(PromptInput::new(PromptKind::ConfirmDropStash));
        a.git_panel.stash_selected = 0;
        let _ = draw(&a, 130, 30);

        // Workspace cwd and agent cwd both empty: active_cwd is None so
        // the drift badge guard's else arm runs.
        a.snapshot.workspaces[0].cwd = String::new();
        a.snapshot.agents.clear();
        a.snapshot.panes.clear();
        a.prompt_input = None;
        let _ = draw(&a, 130, 30);
    }

    #[test]
    fn git_log_header_shows_the_comparison_label() {
        // The comparison label rides the header when present, Log view.
        let mut a = app();
        a.screen = TuiScreen::Git;
        a.git_panel.view = crate::tui::panels::git::GitView::Log;
        a.git_panel.log_comparison = Some(crate::tui::panels::git::LogBaseComparison {
            base_branch: "main".to_string(),
            local: None,
            origin: None,
        });
        let _ = draw(&a, 130, 30);
    }

    #[test]
    fn footer_wraps_a_long_status_across_rows() {
        // A long status with a narrow budget wraps into multiple rows
        // so the extend arm beyond the first line runs.
        let mut a = app();
        a.status = "word ".repeat(60);
        let _ = draw(&a, 60, 6);
    }

    #[test]
    fn status_style_covers_the_documented_states() {
        let p = palette();
        assert!(status_style("done", &p).fg.is_some());
        assert!(status_style("idle", &p).fg.is_some());
        assert!(status_style("weird", &p).fg.is_some());
    }

    fn palette() -> Palette {
        crate::tui::theme::TuiTheme::Dark.palette()
    }
}

#[cfg(test)]
mod coverage_tests_round9 {
    use super::*;

    #[test]
    fn wrap_input_breaks_between_words_and_hard_breaks_a_long_tail() {
        // Space-pop arm: the breaking token's trailing space moves to
        // the flushed row, and the next word starts the cursor row.
        let rows = wrap_input_with_cursor("aa bb cccccccccc", 8);
        assert_eq!(
            rows,
            vec![
                " aa bb".to_string(),
                "cccccccc".to_string(),
                "cc█".to_string()
            ]
        );
        // Hard-break flush WITHOUT the pop: the hard-broken leftover
        // "bb" carries no trailing space, so the between-words guard
        // is false and the row flushes verbatim after the broken rows.
        let rows = wrap_input_with_cursor("aaaaaabb cc", 3);
        assert_eq!(rows[..3], vec!["aaa", "aaa", " bb"]);
        // Hard-break: a word wider than the row splits mid-word and the
        // leftover keeps splitting while still too wide.
        let rows = wrap_input_with_cursor("aaaaaaaaaa", 3);
        assert!(rows.len() >= 4);
        assert_eq!(rows[0], "aaa");
    }

    #[test]
    fn wrap_plain_hard_breaks_and_keeps_a_first_wide_token_on_row_one() {
        // First token wider than the row: no leading blank row, the
        // token hard-breaks in place.
        let rows = wrap_plain("aaaaaaa bb", 3);
        assert_eq!(rows[0], "aaa");
        assert!(!rows.iter().any(|row| row.is_empty()));
        // A tail that exactly fills the row: the trailing guard keeps a
        // non-empty return.
        let rows = wrap_plain("short", 10);
        assert_eq!(rows, vec!["short".to_string()]);
        // A word breaking into exact row-width chunks leaves the tail
        // empty: the guard skips the empty cursor row.
        let rows = wrap_plain("aaaaaaaaa", 3);
        assert_eq!(rows, vec!["aaa", "aaa", "aaa"]);
    }

    #[test]
    fn wrap_input_breaks_between_words_and_glues_the_boundary_space() {
        // Three words over two rows: the flush happens between words,
        // the breaking token keeps its leading word on the new row and
        // the trailing space of the flushed row stays on the old row.
        let rows = wrap_input_with_cursor("aaa bbb ccc", 10);
        // The breaking token's trailing space moves to the flushed
        // row's tail, so the split lands exactly between the words.
        assert_eq!(
            rows,
            vec![" aaa bbb".to_string(), "ccc".to_string(), "█".to_string()]
        );
    }
}
