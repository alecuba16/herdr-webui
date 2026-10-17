//! Screen-scrape status detection for Codex CLI.

use crate::builtin_detection::scrape::{bottom_non_empty_lines, top_non_empty_lines};

pub(crate) fn detect_codex_status(lower: &str) -> &'static str {
    // Trust directory prompt: "> You are in ..." + "Do you trust the contents
    // of this directory?" in the top 20 non-empty lines.
    let top20 = top_non_empty_lines(lower, 20);
    if top20.contains("> you are in ")
        && top20.contains("do you trust the contents of this directory?")
    {
        return "blocked";
    }
    if lower.contains("action required")
        || lower.contains("press enter to confirm or esc to cancel")
        || lower.contains("enter to submit answer")
        || lower.contains("enter to submit all")
        || lower.contains("allow command?")
        || lower.contains("[y/n]")
        || lower.contains("yes (y)")
        || ((lower.contains("do you want to") || lower.contains("would you like to"))
            && (lower.contains("yes") || lower.contains('❯')))
    {
        return "blocked";
    }
    if has_codex_spinner(lower) {
        return "working";
    }
    // Screen working fallback: "• Working (esc to interrupt)" without
    // "■ Conversation interrupted". Mirrors herdr codex.toml.
    let bottom3 = bottom_non_empty_lines(lower, 3);
    if bottom3.lines().any(|line| {
        let line = line.trim_start();
        (line.starts_with("• ") || line.starts_with("◦ "))
            && line.contains("working")
            && line.contains("esc to interrupt")
    }) && !lower.contains("conversation interrupted")
    {
        return "working";
    }
    if !lower.trim().is_empty() {
        return "idle";
    }
    "unknown"
}

pub(crate) fn has_codex_spinner(text: &str) -> bool {
    text.chars().any(|ch| {
        matches!(
            ch,
            '⠋' | '⠙' | '⠹' | '⠸' | '⠼' | '⠴' | '⠦' | '⠧' | '⠇' | '⠏'
        )
    })
}
