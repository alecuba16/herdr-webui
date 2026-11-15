//! Split-panel rendering for the Terminal screen (design:
//! docs/ux/tui-split-panels-design.md).
//!
//! `layout_tiles` turns the split tree into tile rects; each tile
//! renders its own identity block (status dot + label + workspace +
//! folder on focus) plus its tail. The focused tile keeps the full
//! single-pane pipeline (styled tail, scroll); non-focused tiles
//! render the plain-text tail from the tile-tail cache. Ghost and
//! move-mode indicators draw per the approved mock.

use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph, Wrap};
use ratatui::Frame;

use crate::tui::split::{Side, SplitDir, SplitNode, TileRect};
use crate::tui::theme::Palette;
use crate::tui::TuiApp;

use super::{status_dot, status_style, styled_terminal_line, truncate, workspace_branch_token};

/// One laid-out tile: pane id plus its rect and focus flag.
pub(crate) struct Tile {
    pub pane_id: String,
    pub rect: Rect,
    pub focused: bool,
}

/// Lay the split tree out over `area` (reading order). The focused
/// pane's flag is set from `focus`. Equal ratios in v1: every child of
/// a split gets an equal share via `Constraint::Ratio`.
pub(crate) fn layout_tiles(tree: &SplitNode, area: Rect, focus: Option<&str>) -> Vec<Tile> {
    let mut tiles = Vec::new();
    layout_node(tree, area, focus, &mut tiles);
    tiles
}

fn layout_node(node: &SplitNode, area: Rect, focus: Option<&str>, out: &mut Vec<Tile>) {
    match node {
        SplitNode::Leaf { pane_id } => {
            if !area.is_empty() {
                out.push(Tile {
                    pane_id: pane_id.clone(),
                    rect: area,
                    focused: focus == Some(pane_id.as_str()),
                });
            }
        }
        SplitNode::Split {
            dir,
            weights,
            children,
        } => {
            if children.is_empty() || area.is_empty() {
                return;
            }
            // Per-child flex weights (WebUI `sizes` parity): equal
            // seeds render equal shares, resize mode moves weight
            // between siblings. A missing weight falls back to the
            // equal share so a hand-built tree never panics layout.
            let total: u32 = weights.iter().copied().sum();
            let constraints = children
                .iter()
                .enumerate()
                .map(|(index, _)| {
                    let weight = weights.get(index).copied().unwrap_or(1).max(1);
                    Constraint::Ratio(weight, total.max(weight))
                })
                .collect::<Vec<_>>();
            let areas = match dir {
                SplitDir::Row => Layout::horizontal(constraints).split(area),
                SplitDir::Col => Layout::vertical(constraints).split(area),
            };
            for (child, child_area) in children.iter().zip(areas.iter()) {
                layout_node(child, *child_area, focus, out);
            }
        }
    }
}

/// Convert laid-out tiles to walk-scoring inputs. The ids borrow from
/// the tiles (which own them), so no raw pointers.
#[allow(dead_code)]
pub(crate) fn tile_rects(tiles: &[Tile]) -> Vec<TileRect<'_>> {
    tiles
        .iter()
        .map(|tile| {
            TileRect::new(
                tile.pane_id.as_str(),
                tile.rect.x,
                tile.rect.y,
                tile.rect.width,
                tile.rect.height,
            )
        })
        .collect()
}

/// Record the laid-out tile geometry into the app so key walks score
/// against what is on screen, not a synthetic grid. Render holds only
/// `&TuiApp`, so the cache lives behind a RefCell: geometry is render
/// output, never read by render itself.
pub(crate) fn record_tile_geometry(app: &TuiApp, tiles: &[Tile]) {
    let rects = tiles
        .iter()
        .map(|tile| TileRectOwned {
            pane_id: tile.pane_id.clone(),
            x: tile.rect.x,
            y: tile.rect.y,
            width: tile.rect.width,
            height: tile.rect.height,
        })
        .collect();
    *app.tile_geometry.borrow_mut() = rects;
}

/// Owned twin of `TileRect` stored in the app between frames.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TileRectOwned {
    pub pane_id: String,
    pub x: u16,
    pub y: u16,
    pub width: u16,
    pub height: u16,
}

impl TuiApp {
    /// Owned copy of the last frame's tile geometry; key walks build
    /// their borrowed scoring inputs from it.
    pub(crate) fn tile_geometry_snapshot(&self) -> Vec<TileRectOwned> {
        self.tile_geometry.borrow().clone()
    }
}

/// Render the whole split view into `pane_area`: tiles first, then the
/// ghost overlay (split mode), then the move-mode rings.
pub(crate) fn render_split_view(frame: &mut Frame<'_>, pane_area: Rect, app: &TuiApp, p: &Palette) {
    if pane_area.is_empty() {
        return;
    }
    let focus = app.focused_pane_id();
    let tiles = layout_tiles(&app.split_tree, pane_area, focus.as_deref());
    // Zoom: only the focused tile draws; the rest stay alive undrawn.
    let visible: Vec<&Tile> = if app.split_zoomed {
        Vec::from_iter(tiles.iter().filter(|tile| tile.focused))
    } else {
        Vec::from_iter(tiles.iter())
    };
    if visible.is_empty() {
        return;
    }
    for tile in &visible {
        render_tile(frame, tile, app, p);
    }
    if let Some(preview) = &app.split_mode {
        if let Some(neighbor) = tiles.iter().find(|t| t.pane_id == preview.neighbor) {
            // Ghost covers the exact half of the neighbor the new
            // pane takes (insert_beside splits the neighbor 50/50).
            let ghost_rect = ghost_half_rect(neighbor.rect, preview.side);
            render_ghost(frame, ghost_rect, &preview.pane, p);
        }
    }
    if let Some(state) = &app.move_mode {
        for tile in &tiles {
            if tile.pane_id == state.picked {
                render_double_border(frame, tile.rect, "⇄ moving", p);
            } else if tile.pane_id == state.target {
                if state.insert {
                    let ghost_rect = ghost_half_rect(tile.rect, state.side);
                    render_ghost(frame, ghost_rect, &format!("{} lands", state.picked), p);
                } else {
                    render_double_border(frame, tile.rect, "⇄ target", p);
                }
            }
        }
    }
}

/// The half of `area` a new/moved pane takes at `side`: a 50/50 split
/// of the neighbor, matching `insert_beside`'s geometry exactly.
fn ghost_half_rect(area: Rect, side: Side) -> Rect {
    let halves = split_rect_half(area, side.dir());
    match side {
        Side::Right => halves[1],
        Side::Below => halves[1],
        Side::Left => halves[0],
        Side::Above => halves[0],
    }
}

fn split_rect_half(area: Rect, dir: SplitDir) -> [Rect; 2] {
    let constraints = [Constraint::Ratio(1, 2), Constraint::Ratio(1, 2)];
    match dir {
        SplitDir::Row => Layout::horizontal(constraints).areas(area),
        SplitDir::Col => Layout::vertical(constraints).areas(area),
    }
}

/// Ghost preview: accent rounded border, tinted background, title
/// names the pane that would open.
fn render_ghost(frame: &mut Frame<'_>, rect: Rect, pane_title: &str, p: &Palette) {
    if rect.is_empty() {
        return;
    }
    let block = Block::default()
        .title(format!(" + {} ", pane_title))
        .borders(Borders::ALL)
        .border_type(ratatui::widgets::BorderType::Rounded)
        .border_style(Style::default().fg(p.accent))
        .style(Style::default().bg(p.accent_dim()));
    frame.render_widget(block, rect);
}

/// Double border ring for the picked/target tile in move mode.
fn render_double_border(frame: &mut Frame<'_>, rect: Rect, title: &str, p: &Palette) {
    if rect.is_empty() {
        return;
    }
    let block = Block::default()
        .title(format!(" {} ", title))
        .borders(Borders::ALL)
        .border_type(ratatui::widgets::BorderType::Double)
        .border_style(Style::default().fg(p.accent))
        .style(Style::default().bg(p.panel_bg));
    frame.render_widget(block, rect);
}

/// Render one tile: identity block + tail. Focused tiles keep the
/// single-pane chrome (cwd/status header, styled scrollable tail);
/// others render the cached plain tail.
fn render_tile(frame: &mut Frame<'_>, tile: &Tile, app: &TuiApp, p: &Palette) {
    if tile.rect.is_empty() {
        return;
    }
    let Some(pane) = app
        .snapshot
        .panes
        .iter()
        .find(|pane| pane.id == tile.pane_id)
    else {
        // Pane left the snapshot between sync and render: neutral
        // placeholder until the next sync prunes it.
        let block = Block::default()
            .title(" … ".to_string())
            .borders(Borders::ALL)
            .border_style(Style::default().fg(p.border))
            .style(Style::default().fg(p.text).bg(p.panel_bg));
        frame.render_widget(block, tile.rect);
        return;
    };
    let (dot, _dot_style) = status_dot(&pane.agent_status, p);
    // Workspace identity per the design: human label (not the raw
    // ws id) plus the cwd basename on every tile, worktree/branch
    // chips when the workspace carries a git stamp. Focused keeps
    // the bold accent ring; the label parts stay the same shape so
    // scanning a row of tiles reads left to right: dot · agent ·
    // workspace · folder · chips.
    let workspace = app
        .snapshot
        .workspaces
        .iter()
        .find(|ws| ws.id == pane.workspace_id);
    let workspace_label = workspace
        .map(|ws| ws.label.clone())
        .unwrap_or_else(|| pane.workspace_id.clone());
    // Terminal title (OSC 0/2, stripped): the pane name slot falls
    // back through provisioned label -> agent -> title -> shell, and
    // a title distinct from the resolved name rides its own token
    // right of the workspace so the user sees what the pane shows.
    // A title usually carries the path, so the folder token yields
    // its width budget instead of crowding narrow tiles.
    let terminal_title = pane.terminal_title.as_deref();
    let name = pane
        .label
        .as_deref()
        .filter(|label| !label.is_empty())
        .or(pane.display_agent.as_deref())
        .or(pane.agent.as_deref())
        .or(terminal_title)
        .unwrap_or("shell");
    let title_token = terminal_title.filter(|title| *title != name);
    // Tile-title budgets from the tile rect: fixed 12/18 slots cut
    // titles with no marker on narrow tiles and wasted wide ones.
    // Floors match the old fixed budgets (18/12/12/24) so tiles at
    // any width render at least what they did before; wide tiles
    // gain. Saturating subtraction: a 3-way split on 80 cols gives
    // tiles narrower than 40, where the plain subtraction underflowed
    // (debug panic, release wraps to a huge budget).
    let title_width = tile.rect.width.saturating_sub(4) as usize;
    let name_budget = (title_width / 2).max(18);
    let ws_budget = (title_width.saturating_sub(name_budget) / 3).max(12);
    let term_budget = (title_width.saturating_sub(name_budget) / 3).max(12);
    let mut title = format!(
        " {} {} · {} ",
        dot,
        truncate(name, name_budget),
        truncate(&workspace_label, ws_budget),
    );
    if let Some(terminal_title) = title_token {
        title.push_str(&format!("· {} ", truncate(terminal_title, term_budget)));
    } else {
        let folder = std::path::Path::new(&pane.cwd)
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        if !folder.is_empty() {
            title.push_str(&format!("· {} ", truncate(&folder, term_budget)));
        }
    }
    if let Some(ws) = workspace {
        if ws.worktree.as_ref().is_some_and(|stamp| stamp.is_linked) {
            title.push_str("[worktree] ");
        }
        if let Some(branch) = workspace_branch_token(ws) {
            // Floor at the old fixed 24 so branch tokens render whole
            // at any tile width the tests draw.
            let branch_budget = ((title_width / 4).saturating_sub(4)).max(24);
            title.push_str(&format!("{} ", truncate(&branch, branch_budget)));
        }
    }
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(if tile.focused {
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(p.border)
        })
        .style(Style::default().fg(p.text).bg(p.panel_bg));
    let inner = block.inner(tile.rect);
    frame.render_widget(block, tile.rect);

    let mut lines = Vec::new();
    if tile.focused {
        lines.push(Line::from(vec![
            Span::styled("cwd ", Style::default().fg(p.muted)),
            Span::styled(
                truncate(&pane.cwd, inner.width as usize),
                Style::default().fg(p.text),
            ),
        ]));
        lines.push(Line::from(vec![
            Span::styled("status ", Style::default().fg(p.muted)),
            Span::styled(
                pane.agent_status.clone(),
                status_style(&pane.agent_status, p),
            ),
            Span::styled(" · terminal ", Style::default().fg(p.muted)),
            Span::styled(pane.terminal_id.clone(), Style::default().fg(p.text)),
        ]));
        lines.push(Line::from(""));
        push_focused_tail_lines(app, &mut lines, inner.height.saturating_sub(3), inner.width);
    } else {
        let text = app
            .tile_tails
            .get(&tile.pane_id)
            .map(String::as_str)
            .unwrap_or("");
        let tail_lines: Vec<&str> = text.split('\n').collect();
        let max_tail = inner.height as usize;
        let start = tail_lines.len().saturating_sub(max_tail);
        // `"".split('\n')` yields one empty row, so the placeholder
        // gate must check the source text, not the split vec.
        if text.is_empty() {
            lines.push(Line::from(Span::styled(
                if app.tile_tail_rx.is_some() {
                    "loading…"
                } else {
                    "no output"
                },
                Style::default().fg(p.muted),
            )));
        } else {
            for line_text in &tail_lines[start..] {
                lines.push(Line::from(Span::styled(
                    truncate(line_text, inner.width as usize),
                    Style::default().fg(p.text),
                )));
            }
        }
    }
    frame.render_widget(
        Paragraph::new(lines)
            .style(Style::default().fg(p.text).bg(p.panel_bg))
            .wrap(Wrap { trim: false }),
        inner,
    );
}

/// Focused-tile tail: the same scroll-window math as `render_pane`
/// (deep history + styled live tail, bottom-anchored, `pane_scroll`
/// lines above the end).
fn push_focused_tail_lines(app: &TuiApp, lines: &mut Vec<Line<'_>>, max_tail: u16, width: u16) {
    if app.pane_tail.is_empty() {
        lines.push(Line::from(Span::styled(
            "No pane output yet. Enter attaches, Ctrl-G detaches.",
            Style::default().fg(p_muted(app)),
        )));
        return;
    }
    let lines_ref = app.pane_scrollback_lines();
    let max_tail = max_tail as usize;
    let scroll = app
        .pane_scroll
        .min(lines_ref.len().saturating_sub(max_tail));
    let end = lines_ref.len().saturating_sub(scroll);
    let start = end.saturating_sub(max_tail);
    let tail_offset = lines_ref.len().saturating_sub(app.pane_tail.len());
    for (window_index, line_text) in lines_ref[start..end].iter().enumerate() {
        let styled_index = start + window_index;
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
                    .map(|spans| styled_terminal_line(spans, width as usize, p_muted(app)))
            })
            .unwrap_or_else(|| {
                Line::from(Span::styled(
                    truncate(line_text, width as usize),
                    Style::default().fg(p_muted(app)),
                ))
            });
        lines.push(line);
    }
}

fn p_muted(app: &TuiApp) -> ratatui::style::Color {
    app.palette.muted
}

/// AGENTS summary bar between the tab bar and the pane area (design
/// section "Tile identity and status"): per-tile listing up to 5
/// tiles, aggregate counts beyond that, focused label accent.
pub(crate) fn render_status_bar(frame: &mut Frame<'_>, area: Rect, app: &TuiApp, p: &Palette) {
    if area.is_empty() {
        return;
    }
    let focus = app.focused_pane_id();
    let tiles = app.split_tree.leaves();
    let mut spans: Vec<Span> = vec![Span::styled("AGENTS ", Style::default().fg(p.muted))];
    // Counts aggregate over every tile on the tree, not only the
    // listed ones (design: "Counts aggregate by status").
    let mut counts: Vec<(&str, usize)> = Vec::new();
    let listed = tiles.len().min(5);
    // Bar-width budget per pane chip instead of a fixed 12 that cut
    // labels with no marker on narrow bars and wasted wide ones.
    let label_budget = ((area.width / (5 + tiles.len()) as u16).saturating_sub(2)).max(6) as usize;
    for pane_id in tiles.iter().take(listed) {
        let Some(pane) = app.snapshot.panes.iter().find(|pane| pane.id == *pane_id) else {
            continue;
        };
        let (dot, dot_style) = status_dot(&pane.agent_status, p);
        let label = pane
            .display_agent
            .as_deref()
            .or(pane.agent.as_deref())
            .unwrap_or("shell");
        let label_style = if Some(*pane_id) == focus.as_deref() {
            Style::default().fg(p.accent).add_modifier(Modifier::BOLD)
        } else {
            Style::default().fg(p.text)
        };
        spans.push(Span::styled(dot.to_string(), dot_style));
        spans.push(Span::raw(" "));
        spans.push(Span::styled(truncate(label, label_budget), label_style));
        let workspace = app
            .snapshot
            .workspaces
            .iter()
            .find(|ws| ws.id == pane.workspace_id)
            .map(|ws| ws.label.clone())
            .unwrap_or_default();
        spans.push(Span::styled(
            format!(
                " ({}) ",
                truncate(&workspace, label_budget.saturating_sub(2).max(4))
            ),
            Style::default().fg(p.muted),
        ));
    }
    for pane_id in tiles.iter() {
        if let Some(pane) = app.snapshot.panes.iter().find(|pane| pane.id == *pane_id) {
            match counts
                .iter_mut()
                .find(|(status, _)| *status == pane.agent_status.as_str())
            {
                Some(entry) => entry.1 += 1,
                None => counts.push((pane.agent_status.as_str(), 1)),
            }
        }
    }
    if tiles.len() > listed {
        spans.push(Span::styled(
            format!("· {} more ", tiles.len() - listed),
            Style::default().fg(p.muted),
        ));
    }
    if !counts.is_empty() {
        spans.push(Span::styled("· ", Style::default().fg(p.muted)));
        for (status, count) in &counts {
            let (dot, dot_style) = status_dot(status, p);
            spans.push(Span::styled(format!("{dot}{count} "), dot_style));
        }
    }
    frame.render_widget(
        Paragraph::new(Line::from(spans)).style(Style::default().bg(p.panel_bg)),
        area,
    );
}

/// Expose for render_main: split view when the tree has more than one
/// tile (or zoom forces the single-tile full-area path).
pub(crate) fn split_active(app: &TuiApp) -> bool {
    app.split_tree.leaves().len() > 1 || app.split_zoomed
}

/// Mode-hint text for the footer when split/move/resize mode is open.
pub(crate) fn mode_hint(app: &TuiApp) -> Option<String> {
    if let Some(preview) = &app.split_mode {
        return Some(format!(
            "SPLIT · open {} · hjkl move · Tab flip · p pane · Enter confirm · Esc cancel",
            truncate(&preview.pane, 24),
        ));
    }
    if let Some(state) = &app.move_mode {
        let verb = if state.insert { "insert" } else { "swap" };
        return Some(format!(
            "MOVE · {} · hjkl target · Tab verb (now {}) · Enter confirm · Esc cancel",
            truncate(&state.picked, 24),
            verb,
        ));
    }
    if let Some(state) = &app.resize_mode {
        return Some(format!(
            "RESIZE · {} · h/l narrower/wider · j/k shorter/taller · Enter/Esc done",
            truncate(&state.pane, 24),
        ));
    }
    if app.split_zoomed {
        return Some("ZOOM · Ctrl+B z off · hjkl walk".to_string());
    }
    None
}

/// Entry point from render_main: tiles when split (or zoomed), else the
/// single-pane renderer unchanged.
pub(crate) fn render_panes_or_split(
    frame: &mut Frame<'_>,
    pane_area: Rect,
    app: &TuiApp,
    p: &Palette,
) {
    if split_active(app) {
        render_split_view(frame, pane_area, app, p);
    } else {
        super::render_pane(frame, pane_area, app, p);
    }
}

#[cfg(test)]
mod coverage_tests {
    use super::*;

    fn rect(x: u16, y: u16, width: u16, height: u16) -> Rect {
        Rect::new(x, y, width, height)
    }

    #[test]
    fn layout_handles_empty_children_and_missing_weights() {
        // A hand-built split with no children renders nothing.
        let empty = SplitNode::Split {
            dir: SplitDir::Row,
            weights: vec![],
            children: vec![],
        };
        assert!(layout_tiles(&empty, rect(0, 0, 80, 24), None).is_empty());

        // A weights vec shorter than the children falls back to the
        // equal-share default per missing slot; layout never panics.
        let sparse = SplitNode::Split {
            dir: SplitDir::Row,
            weights: vec![],
            children: vec![SplitNode::leaf("a"), SplitNode::leaf("b")],
        };
        let tiles = layout_tiles(&sparse, rect(0, 0, 80, 24), Some("b"));
        assert_eq!(tiles.len(), 2);
        assert_eq!(tiles[0].pane_id, "a");
        assert_eq!(tiles[1].pane_id, "b");
        assert!(tiles[1].focused);
        assert!(!tiles[0].focused);
        // Equal fallback shares: both halves of the 80-col area.
        assert_eq!(tiles[0].rect.width, 40);
        assert_eq!(tiles[1].rect.width, 40);

        // tile_rects mirrors the laid-out geometry for walk scoring.
        let rects = tile_rects(&tiles);
        assert_eq!(rects.len(), 2);
        assert_eq!(rects[0].pane_id, "a");
        assert_eq!(rects[0].width, 40);

        // A zero-size area drops every tile (empty-rect guard).
        assert!(layout_tiles(&sparse, rect(0, 0, 0, 0), None).is_empty());
    }

    #[test]
    fn render_tile_skips_an_empty_rect_without_touching_the_frame() {
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;

        let client =
            crate::backend_client::BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
        let app = TuiApp::new(client, std::time::Duration::from_secs(1));
        let p = Palette::default();
        let tile = Tile {
            pane_id: "pane_1".into(),
            rect: rect(0, 0, 0, 5),
            focused: true,
        };

        let backend = TestBackend::new(10, 5);
        let mut terminal = Terminal::new(backend).unwrap();
        let before = format!("{:?}", terminal.backend().buffer());
        terminal
            .draw(|frame| render_tile(frame, &tile, &app, &p))
            .unwrap();
        let after = format!("{:?}", terminal.backend().buffer());
        assert_eq!(before, after, "empty rect draws nothing");
    }

    #[test]
    fn render_split_view_with_an_empty_pane_area_returns_early() {
        // The pane_area.is_empty guard: render_main cannot produce an
        // empty pane area through the layout solver (its own area
        // guard fires first and the pane column holds Min(1)), so the
        // direct call is the only deterministic route.
        use ratatui::backend::TestBackend;
        use ratatui::Terminal;

        let client =
            crate::backend_client::BackendClient::new("/nonexistent.sock", "/nonexistent.sock");
        let app = TuiApp::new(client, std::time::Duration::from_secs(1));
        let p = Palette::default();

        let backend = TestBackend::new(20, 10);
        let mut terminal = Terminal::new(backend).unwrap();
        let before = format!("{:?}", terminal.backend().buffer());
        terminal
            .draw(|frame| render_split_view(frame, rect(0, 0, 0, 0), &app, &p))
            .unwrap();
        let after = format!("{:?}", terminal.backend().buffer());
        assert_eq!(before, after, "empty pane area draws nothing");
    }
}
