//! Screen-scrape status detection for Claude Code.

use crate::builtin_detection::scrape::{contains_any, has_braille_spinner_line};

/// Detects Claude's half-circle busy spinner frames (U+25D0 to U+25D3).
/// Claude 2.1.228+ uses ◐◓◑◒ instead of braille for its busy spinner.
/// The spinner appears as the first character of a line followed by a space.
pub(crate) fn has_claude_half_circle_spinner(text: &str) -> bool {
    text.lines().any(|line| {
        let mut chars = line.trim_start().chars();
        matches!(
            chars.next(),
            Some(first) if matches!(first, '◐' | '◓' | '◑' | '◒')
        ) && matches!(chars.next(), Some(second) if second.is_whitespace())
    })
}

pub(crate) fn detect_claude_status(lower: &str) -> &'static str {
    if (lower.contains("enter to select")
        && lower.contains("esc to cancel")
        && contains_any(
            lower,
            &[
                "tab/arrow keys to navigate",
                "arrow keys to navigate",
                "arrows to navigate",
                "↑/↓ to navigate",
                "↑↓ to navigate",
            ],
        ))
        // Claude 2.1.228+ confirmation prompts: "Enter to confirm · Esc to cancel"
        || (lower.contains("enter to confirm") && lower.contains("esc to cancel"))
        || (lower.contains("run a dynamic workflow?") && lower.contains("esc to cancel"))
        || (lower.contains("do you want to proceed?")
            && contains_any(
                lower,
                &[
                    "bash command",
                    "bash(",
                    "contains expansion",
                    "tab to amend",
                    "ctrl+e to explain",
                    "esc to cancel",
                ],
            ))
        || contains_any(
            lower,
            &[
                "waiting for permission",
                "do you want to allow this connection?",
                "review your answers",
                "skip interview and plan immediately",
            ],
        )
    {
        return "blocked";
    }
    if has_braille_spinner_line(lower)
        || has_claude_half_circle_spinner(lower)
        || lower
            .lines()
            .any(|line| line.trim_start().starts_with("/btw"))
        || lower.contains("esc to close")
    {
        return "working";
    }
    if lower.lines().any(|line| line.trim_start().starts_with('❯'))
        && !contains_any(
            lower,
            &[
                "enter to select",
                "esc to cancel",
                "tab/arrow keys",
                "arrow keys to navigate",
                "↑/↓ to navigate",
            ],
        )
    {
        return "idle";
    }
    "unknown"
}
