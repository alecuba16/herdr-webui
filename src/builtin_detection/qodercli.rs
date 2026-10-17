//! Screen-scrape status detection for Qoder CLI.

use crate::builtin_detection::scrape::{contains_any, has_braille_spinner_line};

pub(crate) fn detect_qodercli_status(lower: &str) -> &'static str {
    if (lower.contains("waiting for user confirmation")
        && contains_any(lower, &["yes", "no", "allow", "reject"]))
        || (lower.contains("awaiting approval") && contains_any(lower, &["allow", "reject"]))
        || contains_any(
            lower,
            &[
                "permission required",
                "allow once or always?",
                "asking user",
                "enter your response",
                "review your answers:",
                "shell awaiting input",
            ],
        )
    {
        return "blocked";
    }
    if lower.contains("(esc to cancel,") || has_braille_spinner_line(lower) {
        return "working";
    }
    "unknown"
}
