//! Screen-scrape status detection for Factory Droid.

use crate::builtin_detection::scrape::contains_any;

pub(crate) fn detect_droid_status(lower: &str) -> &'static str {
    // execute_selection_blocker: enter to select + esc to cancel + ↑↓ to
    // navigate (or "use ↑↓ to navigate") + (> yes, allow or > no, cancel).
    if lower.contains("enter to select")
        && lower.contains("esc to cancel")
        && contains_any(lower, &["↑↓ to navigate", "use ↑↓ to navigate"])
        && contains_any(lower, &["> yes, allow", "> no, cancel"])
    {
        return "blocked";
    }
    // selection_menu_blocker: enter select + esc cancel + ↑/↓ navigate (or
    // ↑↓ navigate).
    if lower.contains("enter select")
        && lower.contains("esc cancel")
        && contains_any(lower, &["↑/↓ navigate", "↑↓ navigate"])
    {
        return "blocked";
    }
    if lower.contains("esc to stop") {
        return "working";
    }
    "unknown"
}
