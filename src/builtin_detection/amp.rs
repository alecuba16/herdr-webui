//! Screen-scrape status detection for Amp.

use crate::builtin_detection::scrape::{contains_any, has_braille_spinner_line};

pub(crate) fn detect_amp_status(lower: &str) -> &'static str {
    if contains_any(
        lower,
        &[
            "plugin confirmation needed",
            "waiting for approval",
            "invoke tool",
            "run this command?",
            "allow editing file:",
            "allow creating file:",
            "confirm tool call",
        ],
    ) || (lower.contains("approve")
        && contains_any(
            lower,
            &[
                "allow all for this session",
                "allow all for every session",
                "allow file for every session",
                "deny with feedback",
            ],
        ))
    {
        return "blocked";
    }
    if has_braille_spinner_line(lower)
        || lower.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with('╰')
                && contains_any(line, &["thinking", "streaming", "running tools", "waiting"])
                && line.contains('─')
        })
        || lower.contains("esc to cancel")
    {
        return "working";
    }
    if lower.contains(" - amp - ") {
        return "idle";
    }
    "unknown"
}
