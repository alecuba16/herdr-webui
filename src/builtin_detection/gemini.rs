//! Screen-scrape status detection for Gemini CLI.

use crate::builtin_detection::scrape::contains_any;

pub(crate) fn detect_gemini_status(lower: &str) -> &'static str {
    if lower.contains("│ apply this change")
        || lower.contains("│ allow execution")
        || (lower.contains("yes")
            && contains_any(
                lower,
                &[
                    "waiting for user confirmation",
                    "│ do you want to proceed",
                    "do you want to proceed?",
                ],
            ))
        || lower.lines().any(|line| {
            let line = line.trim_start();
            line.starts_with('❯') && (line.contains("yes") || line.contains("allow"))
        })
    {
        return "blocked";
    }
    if lower.contains("esc to cancel") {
        return "working";
    }
    "unknown"
}
