//! Screen-scrape status detection for Grok CLI.

use crate::builtin_detection::scrape::{bottom_non_empty_lines, contains_any, starts_with_braille, top_non_empty_lines};

pub(crate) fn detect_grok_status(lower: &str) -> &'static str {
    let bottom2 = bottom_non_empty_lines(lower, 2);
    if lower.lines().any(grok_option_dialog_line)
        || (bottom2.contains(":select")
            && bottom2.contains("ctrl+o:yolo")
            && bottom2.contains("ctrl+c:cancel"))
        || (bottom2.contains("tab:scrollback") && bottom2.contains("shift+x:dismiss"))
        || (lower.contains("yes, proceed")
            && lower.contains("no, reject")
            && contains_any(
                lower,
                &["use ← → to choose permission whitelist scope", "←/→:scope"],
            ))
    {
        return "blocked";
    }
    // Background work chip: pinned top line shows animated chip + count + │.
    // Mirrors grok.toml background_work_chip_working.
    let top1 = top_non_empty_lines(lower, 1);
    if top1.lines().any(grok_background_work_chip_line) {
        return "working";
    }
    if lower.lines().any(grok_spinner_stop_line)
        || (bottom2.contains("esc:cancel") && bottom2.contains("ctrl+.:shortcuts"))
        || (lower.contains("ctrl+c:cancel")
            && lower.contains("ctrl+enter:interject")
            && lower.contains("waiting"))
        || lower.lines().any(grok_tool_line)
    {
        return "working";
    }
    if bottom2.contains("ctrl+.:shortcuts")
        && !bottom2.contains("esc:cancel")
        && !bottom2.contains("ctrl+c:cancel")
    {
        return "idle";
    }
    "unknown"
}

pub(crate) fn grok_option_dialog_line(line: &str) -> bool {
    let mut words = line.trim_start_matches('┃').split_whitespace();
    let Some(label) = words.next() else {
        return false;
    };
    let Some(choice) = words.next() else {
        return false;
    };
    !label.is_empty()
        && label.chars().all(|ch| ch.is_ascii_alphanumeric())
        && matches!(choice, "(●)" | "(○)")
}

pub(crate) fn grok_spinner_stop_line(line: &str) -> bool {
    let line = line.trim_start();
    starts_with_braille(line) && line.ends_with("[stop]")
}

/// Grok pinned top-line background work chip: one of the chip glyphs followed
/// by a space, a positive number, a space, and a │ pipe. Mirrors
/// grok.toml background_work_chip_working line_regex.
pub(crate) fn grok_background_work_chip_line(line: &str) -> bool {
    let line = line.trim_start();
    let Some(first) = line.chars().next() else {
        return false;
    };
    if !matches!(first, '⋅' | ':' | '⸬' | '⁙' | '.' | '·') {
        return false;
    }
    let rest = line[first.len_utf8()..].trim_start();
    // Parse a positive integer (at least one digit, no leading zero).
    let digits_end = rest
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(rest.len());
    if digits_end == 0 {
        return false;
    }
    let num = &rest[..digits_end];
    if num == "0" || num.starts_with('0') {
        return false;
    }
    rest[digits_end..].trim_start().starts_with('│')
}

pub(crate) fn grok_tool_line(line: &str) -> bool {
    let line = line.trim_start();
    if !starts_with_braille(line) {
        return false;
    }
    let lower = line.to_lowercase();
    contains_any(&lower, &[" run", " read", " search", " list"])
}
