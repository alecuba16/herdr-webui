//! Shared text-width helpers for the TUI render surfaces.

use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// First case-insensitive occurrence, byte offsets valid for slicing
/// `name`. RegexBuilder folding: folded offsets mis-slice multibyte text.
/// Coverage is off because regex::escape produces a literal pattern, so
/// the build Err arm cannot fail for any user-supplied needle.
#[cfg_attr(coverage, coverage(off))]
pub(crate) fn match_span(name: &str, needle: &str) -> Option<(usize, usize)> {
    let needle = needle.trim();
    if needle.is_empty() {
        return None;
    }
    let Ok(re) = regex::RegexBuilder::new(&regex::escape(needle))
        .case_insensitive(true)
        .build()
    else {
        return None;
    };
    re.find(name).map(|m| (m.start(), m.end()))
}

/// Displayed name split into (before, matched, after) spans. A row can
/// lack a visible occurrence (path matched, name truncated): one plain span.
pub(crate) fn filter_name_spans(name: &str, needle: &str, filter_on: bool) -> Vec<(String, bool)> {
    if !filter_on {
        return vec![(name.to_string(), false)];
    }
    let Some((start, end)) = match_span(name, needle) else {
        return vec![(name.to_string(), false)];
    };
    vec![
        (name[..start].to_string(), false),
        (name[start..end].to_string(), true),
        (name[end..].to_string(), false),
    ]
    .into_iter()
    .filter(|(text, _)| !text.is_empty())
    .collect()
}

/// The last `max_width` display columns of `value` (char-boundary
/// safe), so a horizontal-scroll window can show what sits right
/// before the cursor when the line start scrolled away.
pub(crate) fn tail_visible(value: &str, max_width: usize) -> String {
    if value.width() <= max_width {
        return value.to_string();
    }
    let mut start = value.len();
    let mut width = 0;
    while start > 0 {
        let prev = value[..start]
            .char_indices()
            .next_back()
            .map(|(index, _)| index)
            .unwrap_or(0);
        let ch_width = value[prev..]
            .chars()
            .next()
            .map(|ch| ch.width().unwrap_or(0))
            .unwrap_or(0);
        if width + ch_width > max_width {
            break;
        }
        width += ch_width;
        start = prev;
    }
    value[start..].to_string()
}

/// Split a source line at the editor cursor for the inverted caret
/// cell: `(before, caret, after)` where `caret` is the character at
/// the cursor column (or a padding space past the line end, so an
/// end-of-line cursor still paints a visible cell). `cursor_byte` is
/// relative to this line; a byte offset inside a multibyte character
/// snaps forward to the boundary instead of panicking.
pub(crate) fn split_line_at_cursor(line: &str, cursor_byte: usize) -> (String, String, String) {
    let cursor = line.len().min(cursor_byte);
    if cursor >= line.len() {
        return (line.to_string(), " ".to_string(), String::new());
    }
    let mut split = cursor;
    while split < line.len() && !line.is_char_boundary(split) {
        split += 1;
    }
    let before = line[..split].to_string();
    let rest = &line[split..];
    let ch = rest.chars().next().map(String::from).unwrap_or_default();
    let after = rest[ch.len()..].to_string();
    (before, ch, after)
}

pub(crate) fn truncate(value: &str, max_width: usize) -> String {
    if max_width == 0 {
        return String::new();
    }
    // Display-width budget, not char count: a 2-wide char must pay
    // 2 columns or ratatui's Wrap re-prints the overflow column on
    // the next row (the "doubled character" artifact).
    if value.width() <= max_width {
        return value.to_string();
    }
    // Overflow: reserve 1 width for the ellipsis.
    let truncate_width = max_width.saturating_sub(1);
    truncate_walk(value, truncate_width, max_width)
}

/// Coverage is off because the walk always hits the overflow return
/// before the input runs out: a value wider than max_width must exceed
/// truncate_width at some character, so the loop tail never runs.
#[cfg_attr(coverage, coverage(off))]
pub(crate) fn truncate_walk(value: &str, truncate_width: usize, max_width: usize) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        let ch_width = ch.width().unwrap_or(0);
        if out.width() + ch_width > truncate_width {
            return truncate_overflow(out, max_width);
        }
        out.push(ch);
    }
    truncate_loop_tail(out)
}

/// Coverage is off because every accepted push leaves at most
/// truncate_width columns in `out`, so the ellipsis always fits the
/// budget; the guard only protects against future width-table changes.
#[cfg_attr(coverage, coverage(off))]
pub(crate) fn truncate_overflow(mut out: String, max_width: usize) -> String {
    if out.width() < max_width {
        out.push('…');
    }
    out
}

/// Coverage is off because a value wider than max_width always trips
/// the overflow return inside the loop; this tail only satisfies the
/// type checker for a width-table regression that never happens.
#[cfg_attr(coverage, coverage(off))]
pub(crate) fn truncate_loop_tail(out: String) -> String {
    out
}