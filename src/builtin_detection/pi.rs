//! Screen-scrape status detection for Pi coding agent.

pub(crate) fn detect_pi_status(lower: &str) -> &'static str {
    if lower.contains("working...") {
        "working"
    } else {
        "unknown"
    }
}
