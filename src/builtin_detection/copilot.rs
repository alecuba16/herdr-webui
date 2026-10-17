//! Screen-scrape status detection for GitHub Copilot CLI.

use crate::builtin_detection::scrape::contains_any;

pub(crate) fn detect_copilot_status(lower: &str) -> &'static str {
    // selection_blocker: requires both an cancel hint AND an enter hint.
    if contains_any(lower, &["esc to cancel", "esc cancel"])
        && contains_any(
            lower,
            &[
                "enter to select",
                "enter to confirm",
                "enter to submit",
                "enter accept",
            ],
        )
    {
        return "blocked";
    }
    if contains_any(
        lower,
        &[
            "esc to cancel",
            "esc cancel",
            "esc again to cancel",
            "esc interrupt",
        ],
    ) {
        return "working";
    }
    "unknown"
}
