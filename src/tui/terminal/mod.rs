use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

use crate::terminal_text::{vt_drive, VtCell, VtCore, VtSink};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct TuiTextStyle {
    pub(crate) fg: Option<Color>,
    pub(crate) bg: Option<Color>,
    pub(crate) bold: bool,
    pub(crate) dim: bool,
    pub(crate) italic: bool,
    pub(crate) underlined: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TuiTextSpan {
    pub(crate) text: String,
    pub(crate) style: TuiTextStyle,
}

pub(crate) fn styled_terminal_line(
    spans: &[TuiTextSpan],
    max_width: usize,
    fallback_fg: Color,
) -> Line<'static> {
    if max_width == 0 {
        return Line::from(Span::raw(""));
    }
    // Width-exact budget across spans: each span is truncated to the
    // columns it may still occupy, and the consumed columns are
    // subtracted by DISPLAY width. The old version passed
    // `remaining + 1` and counted chars, so a full-width span made the
    // rendered line one column wider than the pane and ratatui's Wrap
    // re-printed that last column on the next row (the "doubled last
    // character" artifact).
    let mut remaining = max_width;
    let mut out = Vec::new();
    for span in spans {
        if remaining == 0 {
            break;
        }
        let truncated = truncate(&span.text, remaining);
        let used = truncate_width_units(&truncated);
        remaining = remaining.saturating_sub(used);
        out.push(Span::styled(truncated, span.style.to_ratatui(fallback_fg)));
    }
    Line::from(out)
}

/// Display columns of a string, treating combining marks as zero-width
/// (their base character already paid for the cell in `truncate`).
fn truncate_width_units(value: &str) -> usize {
    value.chars().map(|ch| ch.width().unwrap_or(0)).sum()
}

impl TuiTextStyle {
    fn to_ratatui(self, fallback_fg: Color) -> Style {
        let mut style = Style::default().fg(self.fg.unwrap_or(fallback_fg));
        if let Some(bg) = self.bg {
            style = style.bg(bg);
        }
        if self.bold {
            style = style.add_modifier(Modifier::BOLD);
        }
        if self.dim {
            style = style.add_modifier(Modifier::DIM);
        }
        if self.italic {
            style = style.add_modifier(Modifier::ITALIC);
        }
        if self.underlined {
            style = style.add_modifier(Modifier::UNDERLINED);
        }
        style
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StyledCell {
    ch: char,
    style: TuiTextStyle,
}

impl VtCell for StyledCell {
    type Style = TuiTextStyle;
    fn from_char(ch: char, style: &TuiTextStyle) -> Self {
        Self { ch, style: *style }
    }
    fn blank(style: &TuiTextStyle) -> Self {
        Self {
            ch: ' ',
            style: *style,
        }
    }
}

/// Styled screen over the shared VT core: cells carry the SGR style
/// active when they were written, so colors survive later rewrites.
struct StyledScreen {
    core: VtCore<StyledCell>,
}

impl StyledScreen {
    const MAX_LINES: usize = 400;

    fn new(cols: usize) -> Self {
        Self {
            core: VtCore::new_with_cols(Self::MAX_LINES, cols),
        }
    }

    fn lines(&self) -> Vec<Vec<TuiTextSpan>> {
        trim_empty_styled_edges(
            self.core
                .lines
                .iter()
                .map(|line| styled_cells_to_spans(line))
                .collect(),
        )
    }
}

impl VtSink for StyledScreen {
    fn apply_csi(&mut self, sequence: &str) {
        // SGR updates the style the core stamps on every new cell; all
        // other sequences (cursor moves, erases) delegate to the core.
        let Some(final_byte) = sequence.chars().last() else {
            return;
        };
        if final_byte == 'm' {
            let params = &sequence[..sequence.len() - final_byte.len_utf8()];
            apply_sgr(&mut self.core.style, params);
            return;
        }
        self.core.apply_csi(sequence);
    }
    fn carriage_return(&mut self) {
        self.core.carriage_return();
    }
    fn new_line(&mut self) {
        self.core.new_line();
    }
    fn backspace(&mut self) {
        self.core.backspace();
    }
    fn tab(&mut self) {
        self.core.tab();
    }
    fn put(&mut self, ch: char) {
        self.core.put(ch);
    }
}

fn trim_empty_styled_edges(mut lines: Vec<Vec<TuiTextSpan>>) -> Vec<Vec<TuiTextSpan>> {
    while lines.first().is_some_and(|line| line.is_empty()) {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines
}

fn styled_cells_to_spans(cells: &[StyledCell]) -> Vec<TuiTextSpan> {
    let trimmed_len = cells
        .iter()
        .rposition(|cell| cell.ch != ' ')
        .map(|index| index + 1)
        .unwrap_or(0);
    let mut spans: Vec<TuiTextSpan> = Vec::new();
    for cell in cells.iter().take(trimmed_len) {
        if let Some(last) = spans.last_mut() {
            if last.style == cell.style {
                last.text.push(cell.ch);
                continue;
            }
        }
        spans.push(TuiTextSpan {
            text: cell.ch.to_string(),
            style: cell.style,
        });
    }
    spans
}

/// Styled lines with NO autowrap: legacy entry point for callers
/// without a known width (text tails, direct tests). Lines here can
/// be wider than the viewport; the renderer truncates them.
/// Test-only now: production always knows the pty width.
#[cfg(test)]
pub(crate) fn terminal_output_styled_lines_lossy(value: &str) -> Vec<Vec<TuiTextSpan>> {
    terminal_output_styled_lines_for_width(value, 0)
}

/// Styled lines for a terminal of `cols` columns: over-wide output
/// wraps onto continuation rows exactly like the pty-side terminal
/// the bytes came from, so the line count matches the pty screen and
/// the renderer's last visible row is the prompt row.
pub(crate) fn terminal_output_styled_lines_for_width(
    value: &str,
    cols: usize,
) -> Vec<Vec<TuiTextSpan>> {
    let mut screen = StyledScreen::new(cols);
    vt_drive(&mut screen, value);
    screen.lines()
}

fn apply_sgr(style: &mut TuiTextStyle, params: &str) {
    let mut codes = params
        .split(';')
        .filter(|value| !value.is_empty())
        .map(|value| value.parse::<u16>().unwrap_or(0))
        .peekable();
    if codes.peek().is_none() {
        *style = TuiTextStyle::default();
        return;
    }
    while let Some(code) = codes.next() {
        match code {
            0 => *style = TuiTextStyle::default(),
            1 => style.bold = true,
            2 => style.dim = true,
            3 => style.italic = true,
            4 => style.underlined = true,
            22 => {
                style.bold = false;
                style.dim = false;
            }
            23 => style.italic = false,
            24 => style.underlined = false,
            30..=37 => style.fg = Some(ansi_basic_color(code - 30, false)),
            39 => style.fg = None,
            40..=47 => style.bg = Some(ansi_basic_color(code - 40, false)),
            49 => style.bg = None,
            90..=97 => style.fg = Some(ansi_basic_color(code - 90, true)),
            100..=107 => style.bg = Some(ansi_basic_color(code - 100, true)),
            38 => style.fg = parse_extended_color(&mut codes),
            48 => style.bg = parse_extended_color(&mut codes),
            _ => {}
        }
    }
}

fn parse_extended_color(codes: &mut impl Iterator<Item = u16>) -> Option<Color> {
    match codes.next() {
        Some(5) => codes
            .next()
            .map(|value| Color::Indexed(value.min(255) as u8)),
        Some(2) => {
            let r = codes.next()?;
            let g = codes.next()?;
            let b = codes.next()?;
            Some(Color::Rgb(
                r.min(255) as u8,
                g.min(255) as u8,
                b.min(255) as u8,
            ))
        }
        _ => None,
    }
}

fn ansi_basic_color(code: u16, bright: bool) -> Color {
    let base = if bright { 8 } else { 0 };
    Color::Indexed((base + code.min(7)) as u8)
}

fn truncate(value: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    if value.width() <= max_width {
        return value.to_string();
    }
    // Reserve 1 width for the ellipsis if we need to truncate
    let truncate_width = max_width.saturating_sub(1);
    let mut out = String::new();
    for ch in value.chars() {
        let ch_width = ch.width().unwrap_or(0);
        if out.width() + ch_width > truncate_width {
            if out.width() < max_width {
                out.push('…');
            }
            return out;
        }
        out.push(ch);
    }
    out
}

#[cfg(test)]
mod tests;

pub mod input;
