//! Screen-scrape status detection for Kilo.

use super::opencode::detect_opencode_like_status;

pub(crate) fn detect_kilo_status(lower: &str) -> &'static str {
    if let Some(status) = detect_opencode_like_status(lower) {
        return status;
    }
    if lower.contains("esc interrupt") {
        return "working";
    }
    "unknown"
}
