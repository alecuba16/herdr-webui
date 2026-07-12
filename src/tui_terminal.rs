use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};

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
    let mut remaining = max_width;
    let mut out = Vec::new();
    for span in spans {
        if remaining == 0 {
            break;
        }
        let truncated = truncate(&span.text, remaining + 1);
        let used = truncated.chars().count();
        remaining = remaining.saturating_sub(used);
        out.push(Span::styled(truncated, span.style.to_ratatui(fallback_fg)));
    }
    Line::from(out)
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

#[derive(Debug)]
struct StyledScreen {
    lines: Vec<Vec<StyledCell>>,
    row: usize,
    col: usize,
    style: TuiTextStyle,
}

impl Default for StyledScreen {
    fn default() -> Self {
        Self {
            lines: vec![Vec::new()],
            row: 0,
            col: 0,
            style: TuiTextStyle::default(),
        }
    }
}

impl StyledScreen {
    const MAX_LINES: usize = 400;

    fn lines(&self) -> Vec<Vec<TuiTextSpan>> {
        trim_empty_styled_edges(
            self.lines
                .iter()
                .map(|line| styled_cells_to_spans(line))
                .collect(),
        )
    }

    fn ensure_row(&mut self) {
        while self.lines.len() <= self.row {
            self.lines.push(Vec::new());
        }
    }

    fn trim_scrollback(&mut self) {
        let overflow = self.lines.len().saturating_sub(Self::MAX_LINES);
        if overflow > 0 {
            self.lines.drain(0..overflow);
            self.row = self.row.saturating_sub(overflow);
        }
    }

    fn put(&mut self, ch: char) {
        self.ensure_row();
        let line = &mut self.lines[self.row];
        while line.len() < self.col {
            line.push(StyledCell {
                ch: ' ',
                style: self.style,
            });
        }
        let cell = StyledCell {
            ch,
            style: self.style,
        };
        if self.col < line.len() {
            line[self.col] = cell;
        } else {
            line.push(cell);
        }
        self.col += 1;
    }

    fn carriage_return(&mut self) {
        self.col = 0;
    }

    fn new_line(&mut self) {
        self.row += 1;
        self.col = 0;
        self.ensure_row();
        self.trim_scrollback();
    }

    fn backspace(&mut self) {
        self.col = self.col.saturating_sub(1);
    }

    fn tab(&mut self) {
        let next_tab = ((self.col / 8) + 1) * 8;
        while self.col < next_tab {
            self.put(' ');
        }
    }

    fn apply_csi(&mut self, sequence: &str) {
        let Some(final_byte) = sequence.chars().last() else {
            return;
        };
        let params = &sequence[..sequence.len() - final_byte.len_utf8()];
        match final_byte {
            'm' => apply_sgr(&mut self.style, params),
            'K' => self.erase_line(csi_first_param(params)),
            'J' => self.erase_display(csi_first_param(params)),
            'A' => self.row = self.row.saturating_sub(csi_count(params)),
            'B' => {
                self.row += csi_count(params);
                self.ensure_row();
                self.trim_scrollback();
            }
            'C' => self.col += csi_count(params),
            'D' => self.col = self.col.saturating_sub(csi_count(params)),
            'G' => self.col = csi_count(params).saturating_sub(1),
            'H' | 'f' => self.move_cursor(params),
            _ => {}
        }
    }

    fn erase_line(&mut self, mode: usize) {
        self.ensure_row();
        let line = &mut self.lines[self.row];
        match mode {
            1 => {
                let end = self.col.min(line.len().saturating_sub(1));
                for cell in line.iter_mut().take(end + 1) {
                    *cell = StyledCell {
                        ch: ' ',
                        style: self.style,
                    };
                }
            }
            2 => line.clear(),
            _ => line.truncate(self.col.min(line.len())),
        }
    }

    fn erase_display(&mut self, mode: usize) {
        match mode {
            2 | 3 => {
                self.lines = vec![Vec::new()];
                self.row = 0;
                self.col = 0;
            }
            1 => {
                self.lines
                    .drain(..self.row.min(self.lines.len()))
                    .for_each(drop);
                self.row = 0;
                self.erase_line(1);
            }
            _ => {
                self.erase_line(0);
                self.lines.truncate((self.row + 1).min(self.lines.len()));
            }
        }
    }

    fn move_cursor(&mut self, params: &str) {
        let mut parts = params.split(';');
        let row = parts
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1);
        let col = parts
            .next()
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(1);
        self.row = row.saturating_sub(1);
        self.col = col.saturating_sub(1);
        self.ensure_row();
        self.trim_scrollback();
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

pub(crate) fn terminal_output_styled_lines_lossy(value: &str) -> Vec<Vec<TuiTextSpan>> {
    let mut screen = StyledScreen::default();
    let mut chars = value.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\u{1b}' => match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    let mut sequence = String::new();
                    for next in chars.by_ref() {
                        sequence.push(next);
                        if next.is_ascii_alphabetic() || matches!(next, '~' | '@') {
                            break;
                        }
                    }
                    screen.apply_csi(&sequence);
                }
                Some(']') => {
                    chars.next();
                    skip_osc(&mut chars);
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            },
            '\r' => screen.carriage_return(),
            '\n' => screen.new_line(),
            '\u{8}' => screen.backspace(),
            '\t' => screen.tab(),
            ch if ch.is_control() => {}
            ch => screen.put(ch),
        }
    }
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

fn csi_count(params: &str) -> usize {
    csi_first_param(params).max(1)
}

fn csi_first_param(params: &str) -> usize {
    params
        .trim_start_matches('?')
        .split(';')
        .next()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0)
}

fn skip_osc(chars: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    let mut previous_escape = false;
    for next in chars.by_ref() {
        if next == '\u{7}' || (previous_escape && next == '\\') {
            break;
        }
        previous_escape = next == '\u{1b}';
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

#[cfg(test)]
#[path = "tui_terminal_tests.rs"]
mod tests;
