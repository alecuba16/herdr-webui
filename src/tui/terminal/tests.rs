use super::*;
use crate::tui::{is_menu_key, key_to_terminal_bytes};
use ratatui::style::{Color, Modifier};
use unicode_width::UnicodeWidthStr;

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
fn terminal_output_styled_lines_skip_kitty_and_sixel_payloads() {
    // Kitty APC upload + placement (the exact relay herdr 0.9.0 shells
    // receive) must leave no trace; Sixel DCS with an embedded BEL must
    // not terminate early.
    let kitty = "line\u{1b}_Ga=T,f=32,t=d,i=7,p=3,s=2,v=2,c=10,r=5,q=2;/wAA//8AAP//AAD//wAA/w==\u{1b}\\\u{1b}_Ga=p,i=7,c=10,r=5,q=2;\u{1b}\\end";
    assert_eq!(
        plain_lines(&terminal_output_styled_lines_lossy(kitty)),
        vec!["lineend"]
    );

    let sixel = "s\u{1b}P0;1q#0;2;0;0;0\u{7}!10~-\u{1b}\\t";
    assert_eq!(
        plain_lines(&terminal_output_styled_lines_lossy(sixel)),
        vec!["st"]
    );
}

#[test]
fn terminal_output_styled_lines_skip_unterminated_apc() {
    // Truncated Kitty chunk (m=1 without a final chunk) consumes the rest.
    assert_eq!(
        plain_lines(&terminal_output_styled_lines_lossy(
            "a\u{1b}_Gf=32,s=2,v=2,a=T,m=1;eJz7"
        )),
        vec!["a"]
    );
}

#[test]
fn terminal_output_styled_lines_cover_cursor_defaults_and_display_erase_modes() {
    let lines = terminal_output_styled_lines_lossy(
        "abc\x1b[2Bdown\x1b[?1Aup\x1b[2D!\x1b[5Gg\x1b[3;4Hxy\x1b[1Jhead\nnext",
    );
    assert_eq!(plain_lines(&lines), vec!["     head", "next"]);

    let cleared_to_end = terminal_output_styled_lines_lossy("first\nsecond\x1b[1Afir\x1b[Jtail");
    assert_eq!(plain_lines(&cleared_to_end), vec!["first firtail"]);

    let clear_three = terminal_output_styled_lines_lossy("gone\x1b[3Jback");
    assert_eq!(plain_lines(&clear_three), vec!["back"]);
}

#[test]
fn terminal_output_styled_lines_cover_sgr_defaults_and_invalid_extended_colors() {
    let lines = terminal_output_styled_lines_lossy(
        "\x1b[mreset\x1b[38;2;300;4;5;48;5;999mcolor\x1b[38;2;1mkeep\x1b[48;7mstill",
    );

    assert_eq!(lines[0][0].text, "reset");
    assert_eq!(lines[0][0].style, TuiTextStyle::default());
    assert_eq!(lines[0][1].text, "color");
    assert_eq!(lines[0][1].style.fg, Some(Color::Rgb(255, 4, 5)));
    assert_eq!(lines[0][1].style.bg, Some(Color::Indexed(255)));
    assert_eq!(lines[0][2].text, "keep");
    assert_eq!(lines[0][2].style.fg, None);
    assert_eq!(lines[0][2].style.bg, Some(Color::Indexed(255)));
    assert_eq!(lines[0][3].text, "still");
    assert_eq!(lines[0][3].style.fg, None);
    assert_eq!(lines[0][3].style.bg, None);
}

#[test]
fn terminal_output_styled_lines_cover_osc_bel_and_scrollback_trim() {
    let osc_bel = terminal_output_styled_lines_lossy("a\x1b]2;ignored\x07b\x1b7c");
    assert_eq!(plain_lines(&osc_bel), vec!["abc"]);

    let input = (0..405)
        .map(|index| index.to_string())
        .collect::<Vec<_>>()
        .join("\n");
    let lines = terminal_output_styled_lines_lossy(&input);
    let plain = plain_lines(&lines);
    assert_eq!(plain.len(), 400);
    assert_eq!(plain.first().map(String::as_str), Some("5"));
    assert_eq!(plain.last().map(String::as_str), Some("404"));
}

#[test]
fn styled_terminal_line_truncates_empty_and_wide_chars_without_overflow() {
    let spans = vec![TuiTextSpan {
        text: "界a".to_string(),
        style: TuiTextStyle::default(),
    }];

    let one_col = styled_terminal_line(&spans, 1, Color::White);
    assert_eq!(one_col.spans[0].content.as_ref(), "…");

    // Two columns: the wide char fills the whole budget, so the
    // shared truncate reserves 1 column for the ellipsis, cannot
    // fit the 2-wide char in what is left, and degrades to a bare
    // ellipsis. Still width-exact: 1 column, no Wrap spill.
    let two_cols = styled_terminal_line(&spans, 2, Color::White);
    assert_eq!(two_cols.spans[0].content.as_ref(), "…");

    // Three columns: "界a" is exactly 3 columns (2+1) and fits the
    // budget, so it renders in full; the ellipsis only appears on
    // actual overflow now, not when the value merely meets the budget.
    let three_cols = styled_terminal_line(&spans, 3, Color::White);
    assert_eq!(three_cols.spans[0].content.as_ref(), "界a");

    // Exact fit: a value whose display width equals the budget
    // renders in full, no phantom ellipsis column. The old truncate
    // always reserved an ellipsis column, so a full-width pane row
    // (e.g. 64 X's in a 64-column pane) lost its last column to "…".
    let exact = styled_terminal_line(
        &[TuiTextSpan {
            text: "X".repeat(64),
            style: TuiTextStyle::default(),
        }],
        64,
        Color::White,
    );
    assert_eq!(exact.spans[0].content.len(), 64);
    assert!(exact.spans[0].content.ends_with('X'));
    assert!(!exact.spans[0].content.contains('…'));
}

#[test]
fn styled_terminal_line_never_exceeds_max_width_across_spans() {
    // Regression for the "doubled last character" artifact: the old
    // budget subtracted CHARS and truncated to remaining + 1, so a
    // full-width span rendered one column wider than the pane and
    // ratatui's Wrap re-printed the overflow column on the next
    // row. The rendered width must be exactly max_width at most.
    //
    // Deterministic pseudo-random sweep (xorshift): mixed ASCII,
    // CJK, emoji, zero-width and combining spans against many
    // budgets, so the invariant is exercised far beyond a few
    // hand-picked shapes without a fuzzing dependency.
    let mut seed: u64 = 0x9E37_79B9_7F4A_7C15;
    let mut next = move || {
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        seed
    };
    let alphabet: [&str; 8] = [
        "a",
        "ab",
        "W",
        "世",
        "\u{1F600}",
        "\u{0301}",
        "\u{200B}",
        "…",
    ];
    for _case in 0..2000 {
        let span_count = (next() % 5 + 1) as usize;
        let spans: Vec<TuiTextSpan> = (0..span_count)
            .map(|_| {
                let len = (next() % 24 + 1) as usize;
                let text: String = (0..len)
                    .map(|_| alphabet[(next() % alphabet.len() as u64) as usize])
                    .collect();
                TuiTextSpan {
                    text,
                    style: TuiTextStyle::default(),
                }
            })
            .collect();
        let max_width = (next() % 40 + 1) as usize;
        let line = styled_terminal_line(&spans, max_width, Color::White);
        let rendered: usize = line
            .spans
            .iter()
            .map(|span| span.content.as_ref().width())
            .sum();
        assert!(
            rendered <= max_width,
            "case {_case}: width {rendered} exceeds budget {max_width} for {spans:?}"
        );
    }
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
    // "abc" uses 3 of 5 columns, leaving 2: "d" + "…" fits exactly.
    // The old expectation "de…" was 3 columns for a 2-column budget
    // (the one-column Wrap spill this suite now guards against).
    assert_eq!(line.spans[1].content.as_ref(), "d…");
    assert_eq!(line.spans[1].style.fg, Some(Color::White));
}

fn plain_lines(lines: &[Vec<TuiTextSpan>]) -> Vec<String> {
    lines
        .iter()
        .map(|line| line.iter().map(|span| span.text.as_str()).collect())
        .collect()
}

#[test]
fn styled_lines_wrap_at_the_reported_pty_width() {
    // A pty of 20 columns wraps a 25-char line: the styled parser
    // must reproduce that wrap (20 + 5) so the tail keeps the pty's
    // row count. Without it the renderer re-wraps at the pane edge
    // and the rendered row count drifts (prompt row falls off).
    let lines = terminal_output_styled_lines_for_width("a".repeat(25).as_str(), 20);
    assert_eq!(plain_lines(&lines), vec!["a".repeat(20), "a".repeat(5)]);

    // Wide characters wrap before they would straddle the edge. The
    // screen stores one cell per column with the wide char's shadow
    // column as a blank ("世 " is one 2-col char + its shadow).
    let lines = terminal_output_styled_lines_for_width("世世世世", 5);
    assert_eq!(plain_lines(&lines), vec!["世 世", "世 世"]);

    // Width 0 (unknown) keeps the legacy unwrapped behavior.
    let lines = terminal_output_styled_lines_for_width(&"a".repeat(25), 0);
    assert_eq!(plain_lines(&lines), vec!["a".repeat(25)]);
}

#[test]
fn styled_lines_wrap_keeps_wide_char_from_straddling_the_edge() {
    // After "aa" only 1 of 3 columns remains: the 2-wide char wraps
    // whole to the next row (its shadow column shows as a blank) and
    // "b" follows it there.
    let lines = terminal_output_styled_lines_for_width("aa世b", 3);
    assert_eq!(plain_lines(&lines), vec!["aa", "世 b"]);
}

#[test]
fn terminal_input_maps_control_printable_and_navigation_keys() {
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Char('x'))),
        Some(b"x".to_vec())
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::new(KeyCode::Char('C'), KeyModifiers::CONTROL)),
        Some(vec![3])
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Enter)),
        Some(b"\r".to_vec())
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Backspace)),
        Some(vec![0x7f])
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Tab)),
        Some(b"\t".to_vec())
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Esc)),
        Some(vec![0x1b])
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Left)),
        Some(b"\x1b[D".to_vec())
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Right)),
        Some(b"\x1b[C".to_vec())
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Up)),
        Some(b"\x1b[A".to_vec())
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Down)),
        Some(b"\x1b[B".to_vec())
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Home)),
        Some(b"\x1b[H".to_vec())
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::End)),
        Some(b"\x1b[F".to_vec())
    );
    assert_eq!(
        key_to_terminal_bytes(KeyEvent::from(KeyCode::Delete)),
        Some(b"\x1b[3~".to_vec())
    );
    assert_eq!(key_to_terminal_bytes(KeyEvent::from(KeyCode::F(1))), None);
}

#[test]
fn terminal_input_detects_menu_prefix_only() {
    use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

    assert!(is_menu_key(KeyEvent::new(
        KeyCode::Char('b'),
        KeyModifiers::CONTROL
    )));
    assert!(!is_menu_key(KeyEvent::from(KeyCode::Char('b'))));
    assert!(!is_menu_key(KeyEvent::new(
        KeyCode::Char('x'),
        KeyModifiers::CONTROL
    )));
}

#[test]
fn styled_terminal_line_handles_emoji_width_correctly() {
    let spans = vec![TuiTextSpan {
        text: "✅done🐝".to_string(),
        style: TuiTextStyle::default(),
    }];
    // Emoji ✅ and 🐝 are 2 columns wide each
    // "done" is 4 columns
    // Total width = 2 + 4 + 2 = 8 columns
    let line = styled_terminal_line(&spans, 10, Color::White);
    assert_eq!(line.spans[0].content.as_ref(), "✅done🐝");

    // Truncate at 5 columns: ✅(2) + "do"(2) + "…"(1) = 5 exactly.
    // The width-exact budget reserves the ellipsis its own column;
    // the old expectation "✅don…" was 6 columns wide, one over
    // budget (the Wrap-spill root cause).
    let line = styled_terminal_line(&spans, 5, Color::White);
    let content = line.spans[0].content.as_ref();
    assert_eq!(content, "✅do…");
}
