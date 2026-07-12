#![allow(dead_code)]

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum StripCarriageReturn {
    Drop,
    Newline,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct TerminalTextOptions {
    max_lines: usize,
    trim_empty_edges: bool,
}

impl TerminalTextOptions {
    const DEFAULT_MAX_LINES: usize = 400;

    pub(crate) const fn backend_tail() -> Self {
        Self {
            max_lines: Self::DEFAULT_MAX_LINES,
            trim_empty_edges: false,
        }
    }

    pub(crate) const fn tui_tail() -> Self {
        Self {
            max_lines: Self::DEFAULT_MAX_LINES,
            trim_empty_edges: true,
        }
    }
}

pub(crate) fn terminal_text_lossy(input: &str, options: TerminalTextOptions) -> String {
    let mut screen = TextScreen::new(options);
    let mut chars = input.chars().peekable();
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
    screen.text()
}

pub(crate) fn strip_ansi_lossy(input: &str, carriage_return: StripCarriageReturn) -> String {
    let mut output = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            match chars.peek().copied() {
                Some('[') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    skip_osc(&mut chars);
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
            continue;
        }

        match (ch, carriage_return) {
            ('\r', StripCarriageReturn::Drop) => {}
            ('\r', StripCarriageReturn::Newline) => output.push('\n'),
            ('\n' | '\t', _) => output.push(ch),
            (ch, _) if !ch.is_control() => output.push(ch),
            _ => {}
        }
    }
    output
}

#[derive(Debug)]
struct TextScreen {
    lines: Vec<Vec<char>>,
    row: usize,
    col: usize,
    options: TerminalTextOptions,
}

impl TextScreen {
    fn new(options: TerminalTextOptions) -> Self {
        Self {
            lines: vec![Vec::new()],
            row: 0,
            col: 0,
            options,
        }
    }

    fn text(&self) -> String {
        let text = self
            .lines
            .iter()
            .map(|line| line.iter().collect::<String>().trim_end().to_string())
            .collect::<Vec<_>>()
            .join("\n");
        if self.options.trim_empty_edges {
            text.trim_matches('\n').to_string()
        } else {
            text
        }
    }

    fn ensure_row(&mut self) {
        while self.lines.len() <= self.row {
            self.lines.push(Vec::new());
        }
    }

    fn trim_scrollback(&mut self) {
        let max_lines = self.options.max_lines.max(1);
        let overflow = self.lines.len().saturating_sub(max_lines);
        if overflow > 0 {
            self.lines.drain(0..overflow);
            self.row = self.row.saturating_sub(overflow);
        }
    }

    fn put(&mut self, ch: char) {
        self.ensure_row();
        let line = &mut self.lines[self.row];
        while line.len() < self.col {
            line.push(' ');
        }
        if self.col < line.len() {
            line[self.col] = ch;
        } else {
            line.push(ch);
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
                for ch in line.iter_mut().take(end + 1) {
                    *ch = ' ';
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_text_applies_common_rewrites() {
        let raw = "one\rtwo\nthree\u{1b}[2Kfour\u{1b}[1G!\u{1b}]0;title\u{7}";
        assert_eq!(
            terminal_text_lossy(raw, TerminalTextOptions::tui_tail()),
            "two\n!    four"
        );
        assert_eq!(
            terminal_text_lossy(raw, TerminalTextOptions::backend_tail()),
            "two\n!    four"
        );
    }

    #[test]
    fn terminal_text_trim_option_keeps_backend_edges() {
        let raw = "\nbody\n";
        assert_eq!(
            terminal_text_lossy(raw, TerminalTextOptions::tui_tail()),
            "body"
        );
        assert_eq!(
            terminal_text_lossy(raw, TerminalTextOptions::backend_tail()),
            "\nbody\n"
        );
    }

    #[test]
    fn strip_ansi_supports_carriage_return_modes() {
        let raw = "a\r\u{1b}[31mb\u{1b}[0m\u{1b}]0;t\u{7}";
        assert_eq!(strip_ansi_lossy(raw, StripCarriageReturn::Drop), "ab");
        assert_eq!(strip_ansi_lossy(raw, StripCarriageReturn::Newline), "a\nb");
    }
}
