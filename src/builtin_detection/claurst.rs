//! Screen-scrape detection for Claurst (https://github.com/Kuberwastaken/claurst).
//!
//! Claurst is a multi-provider terminal coding agent built in Rust. Its TUI
//! renders a Ratatui-based interface with:
//!
//! - **Idle**: `❯` (`\u{276f}`) prompt pointer on the last non-empty line, or a
//!   `BUILD` / `PLAN` agent-mode status line above the prompt with no spinner.
//! - **Working**: A spinner character from the set `·✳✻✽✾❃❄❅❆❇❈❉❊` (the
//!   non-Windows `SPINNER` const in claurst's `render.rs`) followed by a verb
//!   and `…`, e.g. `· Thinking…` or `✻ Brewing…`. Also: `esc to cancel`.
//! - **Blocked**: Permission dialog with labels like `Yes, allow once`,
//!   `Yes, allow this session`, `Yes, always allow`, `No, deny`.

use crate::builtin_backend::{bottom_non_empty_lines, contains_any, is_braille};

/// Screen-scrape detection for Claurst agent status.
pub fn detect_claurst_status(lower: &str) -> &'static str {
    let bottom8 = bottom_non_empty_lines(lower, 8);
    let bottom3 = bottom_non_empty_lines(lower, 3);
    let bottom1 = bottom_non_empty_lines(lower, 1);

    // Blocked: permission dialog with canonical Claurst option labels.
    if (lower.contains("yes, allow once")
        || lower.contains("yes, allow this session")
        || lower.contains("yes, always allow")
        || lower.contains("no, deny"))
        && contains_any(
            lower,
            &[
                "yes, allow once",
                "yes, allow this session",
                "yes, always allow (persistent)",
                "yes, always allow for this project",
                "no, deny",
                "allow commands matching",
            ],
        )
    {
        return "blocked";
    }

    // Working: Claurst spinner chars followed by a verb + ellipsis.
    // The spinner set is: · ✳ ✻ ✽ ✾ ❃ ❄ ❅ ❆ ❇ ❈ ❉ ❊
    if bottom3.lines().any(|line| {
        let line = line.trim_start();
        let mut chars = line.chars();
        let Some(first) = chars.next() else {
            return false;
        };
        is_claurst_spinner(first)
            && chars.next().is_some_and(|c| c.is_whitespace())
            && line.contains('…')
    }) {
        return "working";
    }

    // Working: "esc to cancel" indicator (shown during streaming).
    if lower.contains("esc to cancel") {
        return "working";
    }

    // Working: braille spinner (claurst falls back to braille on some terminals).
    if bottom3.lines().any(|line| {
        let line = line.trim_start();
        line.chars().next().is_some_and(is_braille)
            && (line.split_whitespace().any(|word| word.ends_with("ing")) || line.contains('…'))
    }) {
        return "working";
    }

    // Idle: last non-empty line is the ❯ prompt pointer.
    if bottom1
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| line.trim() == "❯" || line.trim().starts_with("❯ "))
    {
        return "idle";
    }

    // Idle: BUILD or PLAN agent-mode status line (shown above the prompt when
    // not streaming and no permission dialog is open).
    if bottom8
        .lines()
        .any(|line| line.trim() == "build" || line.trim() == "plan")
        && !lower.contains("esc to cancel")
    {
        return "idle";
    }

    "unknown"
}

/// Check if a character is in Claurst's non-Windows spinner set.
fn is_claurst_spinner(ch: char) -> bool {
    matches!(
        ch,
        '·' | '✳' | '✻' | '✽' | '✾' | '❃' | '❄' | '❅' | '❆' | '❇' | '❈' | '❉' | '❊'
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_prompt_pointer() {
        assert_eq!(detect_claurst_status("❯"), "idle");
        assert_eq!(detect_claurst_status("some output\n❯"), "idle");
        assert_eq!(detect_claurst_status("❯ type here"), "idle");
    }

    #[test]
    fn idle_build_status_line() {
        assert_eq!(detect_claurst_status("build\n❯"), "idle");
        assert_eq!(detect_claurst_status("plan\n❯"), "idle");
    }

    #[test]
    fn working_spinner_with_verb() {
        assert_eq!(detect_claurst_status("· thinking…"), "working");
        assert_eq!(detect_claurst_status("✻ brewing…"), "working");
        assert_eq!(detect_claurst_status("✽ working…"), "working");
        assert_eq!(detect_claurst_status("❄ contemplating…"), "working");
    }

    #[test]
    fn working_braille_spinner() {
        assert_eq!(detect_claurst_status("⠋ thinking…"), "working");
        assert_eq!(detect_claurst_status("⠙ streaming…"), "working");
    }

    #[test]
    fn working_esc_to_cancel() {
        assert_eq!(
            detect_claurst_status("✻ brewing…\n\nesc to cancel"),
            "working"
        );
    }

    #[test]
    fn blocked_permission_dialog() {
        let blocked = "Bash command\n\n\
            Yes, allow once\n\
            Yes, allow this session\n\
            Yes, always allow (persistent)\n\
            No, deny";
        assert_eq!(detect_claurst_status(&blocked.to_lowercase()), "blocked");
    }

    #[test]
    fn blocked_file_write_dialog() {
        let blocked = "Write to file\n\
            Yes, allow once\n\
            Yes, allow this session\n\
            Yes, always allow for this project\n\
            No, deny";
        assert_eq!(detect_claurst_status(&blocked.to_lowercase()), "blocked");
    }

    #[test]
    fn blocked_bash_prefix_dialog() {
        let blocked = "Bash command\n\
            Yes, allow once\n\
            Yes, allow this session\n\
            Allow commands matching git*\n\
            No, deny";
        assert_eq!(detect_claurst_status(&blocked.to_lowercase()), "blocked");
    }

    #[test]
    fn unknown_for_plain_shell() {
        assert_eq!(detect_claurst_status("$ ls\n"), "unknown");
        assert_eq!(detect_claurst_status("hello world"), "unknown");
    }

    #[test]
    fn working_takes_priority_over_idle() {
        // Spinner at bottom should be working even if ❯ is elsewhere
        let mixed = "❯\n· thinking…";
        assert_eq!(detect_claurst_status(mixed), "working");
    }

    #[test]
    fn blocked_takes_priority_over_working() {
        let blocked = "· brewing…\n\
            Yes, allow once\n\
            No, deny";
        assert_eq!(detect_claurst_status(&blocked.to_lowercase()), "blocked");
    }

    #[test]
    fn all_claurst_spinner_chars_detected() {
        // Every char in is_claurst_spinner should trigger working.
        for ch in [
            '·', '✳', '✻', '✽', '✾', '❃', '❄', '❅', '❆', '❇', '❈', '❉', '❊',
        ] {
            let line = format!("{ch} thinking…");
            assert_eq!(
                detect_claurst_status(&line),
                "working",
                "spinner char {ch:?} should be detected as working"
            );
        }
    }

    #[test]
    fn spinner_without_space_falls_through() {
        // No whitespace after spinner char → should NOT match the claurst
        // spinner branch.
        assert_eq!(detect_claurst_status("·thinking…"), "unknown");
    }

    #[test]
    fn spinner_without_ellipsis_falls_through() {
        // Spinner + space + verb but no ellipsis → should NOT match the
        // claurst spinner branch (braille fallback also requires ing/…).
        assert_eq!(detect_claurst_status("· thinking"), "unknown");
    }

    #[test]
    fn braille_spinner_with_ing_no_ellipsis() {
        // Exercises the word.ends_with("ing") path without relying on …
        assert_eq!(detect_claurst_status("⠋ thinking"), "working");
    }

    #[test]
    fn build_plan_with_esc_to_cancel_is_not_idle() {
        // "esc to cancel" suppresses the BUILD/PLAN idle branch.
        assert_eq!(detect_claurst_status("build\nesc to cancel"), "working");
        assert_eq!(detect_claurst_status("plan\nesc to cancel"), "working");
    }

    #[test]
    fn blocked_takes_priority_over_idle() {
        let blocked = "yes, allow once\nyes, allow this session\nno, deny";
        // Even though ❯ is present, blocked should win.
        assert_eq!(detect_claurst_status(&blocked.to_lowercase()), "blocked");
    }

    #[test]
    fn always_allow_alone_does_not_block() {
        // "yes, always allow" without "(persistent)" or "for this project"
        // passes the outer OR but fails contains_any → not blocked.
        assert_eq!(detect_claurst_status("yes, always allow"), "unknown");
    }
}
