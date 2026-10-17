//! Screen-scrape status detection for Cursor CLI.

use crate::builtin_detection::scrape::{bottom_non_empty_lines, contains_any, starts_with_braille};

pub(crate) fn detect_cursor_status(lower: &str) -> &'static str {
    let bottom8 = bottom_non_empty_lines(lower, 8);
    if (bottom8.contains("write to this file?")
        && bottom8.contains("proceed (y)")
        && contains_any(
            &bottom8,
            &["reject & propose changes", "esc or n or p", "add write("],
        ))
        || (lower.contains("waiting for approval")
            && lower.contains("run this command?")
            && contains_any(lower, &["run (once) (y)", "skip (esc or n)"]))
        || contains_any(lower, &["(y) (enter)", "keep (n)", "skip (esc or n)"])
        || lower.lines().any(|line| {
            let line = line.trim_start();
            // "allow ... (y)" or "run ... (y)" with optional → prefix.
            let line = line.strip_prefix("→").map(str::trim_start).unwrap_or(line);
            (line.starts_with("allow ") || line.starts_with("run ")) && line.contains("(y)")
        })
    {
        return "blocked";
    }
    let bottom6 = bottom_non_empty_lines(lower, 6);
    let bottom5 = bottom_non_empty_lines(lower, 5);
    if bottom6.contains("ctrl+c to stop")
        || background_tasks_line(&bottom5)
        || has_cursor_spinner(&bottom8)
    {
        return "working";
    }
    "unknown"
}

pub(crate) fn has_cursor_spinner(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start();
        if line.starts_with('⬡') || line.starts_with('⬢') || starts_with_braille(line) {
            line.split_whitespace().any(|word| word.ends_with("ing"))
        } else {
            false
        }
    })
}

pub(crate) fn background_tasks_line(text: &str) -> bool {
    text.lines().any(|line| {
        let words = line.split_whitespace().collect::<Vec<_>>();
        words.windows(3).any(|window| {
            window[0].parse::<usize>().is_ok()
                && window[1].starts_with("background")
                && window[2].starts_with("task")
        })
    })
}
