//! Screen-scrape status detection for Antigravity (agent label `agy`).

use crate::builtin_detection::scrape::{bottom_non_empty_lines, has_braille_ing_line};

pub(crate) fn detect_antigravity_status(lower: &str) -> &'static str {
    if lower.contains("requesting permission for:")
        && (lower.contains("do you want to proceed?")
            || (lower.contains("tab amend") && lower.contains("edit command")))
    {
        return "blocked";
    }
    // background_tasks_working: "· <N> task" where N >= 1 (no leading zero).
    let bottom5 = bottom_non_empty_lines(lower, 5);
    if has_braille_ing_line(lower)
        || bottom5.lines().any(|line| {
            let line = line.trim_start();
            line.contains('·')
                && line.split_whitespace().any(|word| {
                    !word.is_empty()
                        && word.chars().all(|c| c.is_ascii_digit())
                        && !word.starts_with('0')
                })
                && line.contains("task")
        })
    {
        return "working";
    }
    "unknown"
}
