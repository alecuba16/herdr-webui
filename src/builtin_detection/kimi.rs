//! Screen-scrape status detection for Kimi CLI.

use crate::builtin_detection::scrape::{bottom_non_empty_lines, contains_any, starts_with_braille};

pub(crate) fn detect_kimi_status(lower: &str) -> &'static str {
    // current_approval_panel: ↵ confirm AND any question AND all(" choose" +
    // approve/reject/revise).
    if lower.contains("↵ confirm")
        && (contains_any(
            lower,
            &[
                "run this command?",
                "write this file?",
                "apply these edits?",
                "stop this task?",
                "ready to build with this plan?",
            ],
        ) || lower.lines().any(|line| {
            let line = line.trim_start();
            let line = line.trim_start_matches('▶');
            line.starts_with("approve ") && line.ends_with('?')
        }))
        && lower.contains(" choose")
        && contains_any(lower, &["approve", "reject", "revise"])
    {
        return "blocked";
    }
    // question_panel: ↑↓ select + esc cancel + line "question" or "? " + any
    // ↵ choose/toggle/save.
    if lower.contains("↑↓ select")
        && lower.contains("esc cancel")
        && (lower.lines().any(|line| line.trim() == "question")
            || lower
                .lines()
                .any(|line| line.trim_start().starts_with("? ")))
        && contains_any(lower, &["↵ choose", "↵ toggle", "↵ save"])
    {
        return "blocked";
    }
    // legacy_approval_panel: requesting approval + reject + approve once/session
    // + 1/2/3/4 choose or ↵ confirm.
    if lower.contains("requesting approval")
        && lower.contains("reject")
        && contains_any(lower, &["approve once", "approve for this session"])
        && contains_any(lower, &["1/2/3/4 choose", "↵ confirm"])
    {
        return "blocked";
    }
    // background_agent_status_working: bottom 3 non-empty lines.
    let bottom3 = bottom_non_empty_lines(lower, 3);
    if bottom3.lines().any(kimi_background_agents_line)
        // moon_spinner_working and braille_spinner_working: whole_recent.
        || lower.lines().any(|line| {
            matches!(
                line.trim(),
                "🌕" | "🌖" | "🌗" | "🌘" | "🌑" | "🌒" | "🌓" | "🌔"
            )
        })
        || lower.lines().any(|line| {
            let line = line.trim_start();
            starts_with_braille(line)
                && contains_any(line, &["thinking...", "working...", "using "])
        })
    {
        return "working";
    }
    "unknown"
}

pub(crate) fn kimi_background_agents_line(line: &str) -> bool {
    // Manifest: (?i)\bkimi[-\w.]*\s+thinking\b.*\[[1-9][0-9]*\s+agents?\s+running\]
    line.contains("kimi")
        && line.contains("thinking")
        && line.contains("[")
        && line.contains("agent")
        && line.contains("running]")
        && line.split('[').any(|after_bracket| {
            // Must have a positive number before "agent(s) running]"
            let trimmed = after_bracket.trim_start();
            let digits_end = trimmed.find(|c: char| !c.is_ascii_digit()).unwrap_or(0);
            digits_end > 0 && !trimmed[..digits_end].starts_with('0')
        })
}
