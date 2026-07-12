use super::*;
use ratatui::style::{Color, Modifier};

#[test]
fn terminal_output_styled_lines_parse_sgr_colors_and_styles() {
    let lines = terminal_output_styled_lines_lossy(
        "plain \x1b[31;1mred\x1b[0m \x1b[38;5;42;48;2;1;2;3;4mhi\x1b[0m",
    );
    assert_eq!(lines.len(), 1);
    assert_eq!(lines[0][0].text, "plain ");
    assert_eq!(lines[0][1].text, "red");
    assert_eq!(lines[0][1].style.fg, Some(Color::Indexed(1)));
    assert!(lines[0][1].style.bold);
    assert_eq!(lines[0][2].text, " ");
    assert_eq!(lines[0][3].text, "hi");
    assert_eq!(lines[0][3].style.fg, Some(Color::Indexed(42)));
    assert_eq!(lines[0][3].style.bg, Some(Color::Rgb(1, 2, 3)));
    assert!(lines[0][3].style.underlined);
}

#[test]
fn terminal_output_styled_lines_apply_cursor_and_erase_sequences() {
    let lines = terminal_output_styled_lines_lossy(
        "alpha\nbeta\x1b[1A\x1b[3GZZ\x1b[1B\x1b[1G!\x1b[K\ntrim\x1b[2K\n\x1b[2Jafter",
    );

    assert_eq!(plain_lines(&lines), vec!["after"]);

    let lines = terminal_output_styled_lines_lossy("abcdef\x1b[3DXY\x1b[1K\x1b[2Gz");
    assert_eq!(plain_lines(&lines), vec![" z"]);
}

#[test]
fn terminal_output_styled_lines_handle_tabs_backspace_osc_and_empty_edges() {
    let lines =
        terminal_output_styled_lines_lossy("\n\tX\u{8}Y\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\\n\n");

    assert_eq!(plain_lines(&lines), vec!["        Y"]);
}

#[test]
fn terminal_output_styled_lines_support_style_resets_and_bright_colors() {
    let lines =
        terminal_output_styled_lines_lossy("\x1b[2;3;4;94;104mbright\x1b[22;23;24;39;49mplain");

    let bright = &lines[0][0];
    assert_eq!(bright.text, "bright");
    assert!(bright.style.dim);
    assert!(bright.style.italic);
    assert!(bright.style.underlined);
    assert_eq!(bright.style.fg, Some(Color::Indexed(12)));
    assert_eq!(bright.style.bg, Some(Color::Indexed(12)));

    let plain = &lines[0][1];
    assert_eq!(plain.text, "plain");
    assert!(!plain.style.bold);
    assert!(!plain.style.dim);
    assert!(!plain.style.italic);
    assert!(!plain.style.underlined);
    assert_eq!(plain.style.fg, None);
    assert_eq!(plain.style.bg, None);
}

#[test]
fn styled_terminal_line_truncates_and_applies_ratatui_styles() {
    let spans = vec![
        TuiTextSpan {
            text: "abc".to_string(),
            style: TuiTextStyle {
                fg: Some(Color::Red),
                bg: Some(Color::Blue),
                bold: true,
                dim: true,
                italic: true,
                underlined: true,
            },
        },
        TuiTextSpan {
            text: "def".to_string(),
            style: TuiTextStyle::default(),
        },
    ];

    let empty = styled_terminal_line(&spans, 0, Color::White);
    assert_eq!(empty.spans[0].content.as_ref(), "");

    let line = styled_terminal_line(&spans, 5, Color::White);
    assert_eq!(line.spans[0].content.as_ref(), "abc");
    assert_eq!(line.spans[0].style.fg, Some(Color::Red));
    assert_eq!(line.spans[0].style.bg, Some(Color::Blue));
    assert!(line.spans[0].style.add_modifier.contains(Modifier::BOLD));
    assert!(line.spans[0].style.add_modifier.contains(Modifier::DIM));
    assert!(line.spans[0].style.add_modifier.contains(Modifier::ITALIC));
    assert!(line.spans[0]
        .style
        .add_modifier
        .contains(Modifier::UNDERLINED));
    assert_eq!(line.spans[1].content.as_ref(), "de…");
    assert_eq!(line.spans[1].style.fg, Some(Color::White));
}

fn plain_lines(lines: &[Vec<TuiTextSpan>]) -> Vec<String> {
    lines
        .iter()
        .map(|line| line.iter().map(|span| span.text.as_str()).collect())
        .collect()
}
