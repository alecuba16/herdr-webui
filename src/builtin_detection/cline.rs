//! Screen-scrape status detection for Cline.

pub(crate) fn detect_cline_status(lower: &str) -> &'static str {
    if lower.contains("let cline use this tool")
        || (lower.contains("[act mode]")
            && (lower.contains("execute command?") || lower.contains("use this tool?"))
            && lower.contains("yes"))
        || (lower.contains("[plan mode]")
            && (lower.contains("execute command?") || lower.contains("use this tool?"))
            && lower.contains("yes"))
    {
        "blocked"
    } else if lower.trim().is_empty() {
        "unknown"
    } else {
        "working"
    }
}
