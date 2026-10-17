//! Screen-scrape status detection for Maki.

use crate::builtin_detection::scrape::{bottom_non_empty_lines, contains_any, starts_with_braille};

pub(crate) fn detect_maki_status(lower: &str) -> &'static str {
    if (lower.contains("permission required")
        && contains_any(
            lower,
            &[
                "y allow",
                "n deny",
                "confirm allow",
                "confirm deny",
                "enter deny",
                "esc cancel",
            ],
        ))
        || (lower.contains("plan complete")
            && lower.contains("enter confirm")
            && contains_any(lower, &["space toggle parallel", "edit plan"]))
    {
        return "blocked";
    }
    let bottom1 = bottom_non_empty_lines(lower, 1);
    if bottom1.lines().any(maki_spinner_status_line) {
        return "working";
    }
    if bottom1.lines().any(maki_idle_status_line)
        || (bottom_non_empty_lines(lower, 3)
            .lines()
            .any(|line| line.starts_with("❯ "))
            && !lower.contains("queue another prompt"))
    {
        return "idle";
    }
    "unknown"
}

pub(crate) fn maki_spinner_status_line(line: &str) -> bool {
    let line = line.trim_start();
    starts_with_braille(line) && contains_any(line, &["[build]", "[plan]", "[bash]"])
}

pub(crate) fn maki_idle_status_line(line: &str) -> bool {
    let line = line.trim_start();
    contains_any(line, &["[build]", "[plan]", "[bash]"]) && !starts_with_braille(line)
}
