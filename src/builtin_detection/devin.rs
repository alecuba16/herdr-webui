//! Screen-scrape status detection for Devin CLI.

pub(crate) fn detect_devin_status(lower: &str) -> &'static str {
    // workspace_trust_prompt: all three strings required.
    if lower.contains("do you trust the authors of this directory?")
        && lower.contains("with untrusted content.")
        && lower.contains("yes, trust ")
    {
        return "blocked";
    }
    // permission_prompt: all four strings required.
    if lower.contains("approve once")
        && lower.contains("select")
        && lower.contains("confirm")
        && lower.contains("esc cancel")
    {
        return "blocked";
    }
    // Working rules have not-gates for "approve once" + "esc cancel", but since
    // the blocked check above runs first, those are implicitly handled.
    if (lower.contains("running tools") && lower.contains("esc to interrupt"))
        || lower.contains("guide devin while it works")
        || (lower.contains("reading shell ") && lower.contains("timeout:"))
    {
        return "working";
    }
    if (lower.contains("ask devin to build")
        && lower.contains("features, fix bugs")
        && lower.contains("your code"))
        || (lower.contains("context:")
            && lower.lines().any(|line| line.trim_start().starts_with('❭')))
    {
        return "idle";
    }
    "unknown"
}
