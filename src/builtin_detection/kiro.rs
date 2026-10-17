//! Screen-scrape status detection for Kiro.

use crate::builtin_detection::scrape::contains_any;

pub(crate) fn detect_kiro_status(lower: &str) -> &'static str {
    if (lower.contains("requires approval")
        && contains_any(
            lower,
            &[
                "yes, single permission",
                "trust, always allow",
                "no (tab to edit)",
                "esc to close",
            ],
        ))
        || (lower.contains("pending from subagents")
            && (lower.contains("tool approval") || lower.contains("tool approvals"))
            && contains_any(
                lower,
                &[
                    "approve all pending",
                    "configure individually",
                    "exit (cancel subagents)",
                ],
            ))
    {
        return "blocked";
    }
    if lower.contains("kiro is working")
        || (lower.contains("esc to cancel")
            && lower.lines().any(|line| {
                let line = line.trim_start();
                matches!(line.chars().next(), Some('◔' | '◑' | '◕' | '●'))
                    && line.chars().skip(1).any(char::is_alphabetic)
            }))
    {
        return "working";
    }
    // Idle: composer prompt with "ask a question or describe a task" and
    // "/copy to clipboard", without working markers. Mirrors herdr kiro.toml.
    if lower.contains("ask a question or describe a task")
        && lower.contains("/copy to clipboard")
        && !lower.contains("kiro is working")
        && !lower.contains("esc to cancel")
    {
        return "idle";
    }
    "unknown"
}
