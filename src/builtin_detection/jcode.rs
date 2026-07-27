//! Jcode detection variants: vanilla (upstream) and alecuba16 (fork Overview panel).
//!
//! The `detect_jcode_status_with_variant` function selects the pattern set based on
//! the `JcodeDetectionVariant` setting. OSC 9 progress payloads (emitted by vanilla's
//! `herdr_detectable` branch) are handled upstream in `detect_agent_status_with_osc` and
//! take precedence; this module only provides the screen-scrape fallback.

use crate::builtin_backend::{
    bottom_non_empty_lines, contains_any, has_jcode_spinner, has_jcode_tool_bar, jcode_blocked,
    jcode_idle_line, jcode_numbered_prompt_line, jcode_question_blocked,
};
use crate::builtin_detection::JcodeDetectionVariant;

/// Screen-scrape detection for jcode, selected by variant.
pub fn detect_jcode_status_with_variant(
    lower: &str,
    variant: JcodeDetectionVariant,
) -> &'static str {
    match variant {
        JcodeDetectionVariant::Vanilla => detect_jcode_status_vanilla(lower),
        JcodeDetectionVariant::Alecuba16 => detect_jcode_status_alecuba16(lower),
    }
}

/// Vanilla jcode screen-scrape detection (upstream master output format).
/// Matches: numbered prompts like `1> `, `❯` idle caret, `Session ready`,
/// braille spinners `⠋ thinking…`, tool bar `··● bash ●··`.
fn detect_jcode_status_vanilla(lower: &str) -> &'static str {
    let bottom8 = bottom_non_empty_lines(lower, 8);
    let bottom6 = bottom_non_empty_lines(lower, 6);
    let bottom4 = bottom_non_empty_lines(lower, 4);
    let bottom3 = bottom_non_empty_lines(lower, 3);

    if jcode_blocked(&bottom8) || jcode_question_blocked(&bottom6) {
        return "blocked";
    }
    if bottom3
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .is_some_and(jcode_idle_line)
    {
        return "idle";
    }
    if has_jcode_spinner(&bottom3)
        || has_jcode_tool_bar(&bottom4)
        || contains_any(
            &bottom4,
            &[
                "running tool",
                "executing tool",
                "network disconnected, waiting to retry",
            ],
        )
    {
        return "working";
    }
    if (contains_any(&bottom3, &["session ready", "ready for input"])
        || bottom3.lines().any(|line| line.trim() == "❯"))
        && !contains_any(
            &bottom3,
            &["processing", "embedding", "running tool", "executing"],
        )
    {
        return "idle";
    }
    "unknown"
}

/// alecuba16 fork screen-scrape detection (Overview panel output format).
/// Distinct markers from the redesigned Overview widget:
/// - Line 1: `N sessions · branch_name` (session count header)
/// - Dashed separators: `- - - -` (repeated `- ` filling panel width)
/// - Cost/tok footer: `💰 $X.XXXX  ↓k ↑k tok  ⌀N.N t/s`
/// - Memory line: `🧠 N memories` (or `🧠 Memory disabled`)
/// - Swarm line: `🐝 N sessions` (shown even when no swarm active: `🐝 0 sessions`)
fn detect_jcode_status_alecuba16(lower: &str) -> &'static str {
    let bottom8 = bottom_non_empty_lines(lower, 8);
    let bottom6 = bottom_non_empty_lines(lower, 6);
    let bottom4 = bottom_non_empty_lines(lower, 4);
    let bottom3 = bottom_non_empty_lines(lower, 3);

    // Blocked patterns (permission prompts, confirmations) — same as vanilla
    if jcode_blocked(&bottom8) || jcode_question_blocked(&bottom6) {
        return "blocked";
    }

    // Idle: last non-empty line is a prompt (`❯`, `1> `, `session ready`, `ready for input`)
    if bottom3
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .is_some_and(|line| {
            let line = line.trim();
            line == "❯"
                || jcode_numbered_prompt_line(line)
                || line.contains("session ready")
                || line.contains("ready for input")
        })
    {
        return "idle";
    }

    // Working: spinner, tool bar, or explicit tool execution lines
    if has_jcode_spinner(&bottom8)
        || has_jcode_spinner(&bottom6)
        || has_jcode_tool_bar(&bottom4)
        || contains_any(
            &bottom4,
            &[
                "running tool",
                "executing tool",
                "network disconnected, waiting to retry",
            ],
        )
    {
        return "working";
    }

    // Alecuba16-specific Overview panel markers that indicate an idle/waiting state:
    // - Session count header (`N sessions`)
    // - Dashed separator lines (`- - -`)
    // - Cost/tok line with t/s footer (`⌀`)
    // - Memory icon (`🧠`)
    // - Swarm icon (`🐝`)
    // If we see these Overview markers without a spinner/tool bar, the pane is idle.
    let has_overview_markers = bottom8.lines().any(|line| {
        let line = line.trim();
        // Session count header: "N sessions" or "N sessions · branch"
        (line.contains(" sessions") && line.split_whitespace().next().is_some_and(|w| w.parse::<usize>().is_ok()))
        // Dashed separator: "- - -" (at least 2 dash-space pairs)
        || line.starts_with("- ") && line.matches("- ").count() >= 2
        // Cost/tok line with t/s: contains "⌀" and "tok"
        || (line.contains("⌀") && line.contains("tok"))
        // Memory icon
        || line.starts_with("🧠 ")
        // Swarm icon
        || line.starts_with("🐝 ")
    });

    if has_overview_markers {
        return "idle";
    }

    // Fallback: vanilla idle heuristics (prompt-like lines without working indicators)
    if (contains_any(&bottom3, &["session ready", "ready for input"])
        || bottom3.lines().any(|line| line.trim() == "❯"))
        && !contains_any(
            &bottom3,
            &["processing", "embedding", "running tool", "executing"],
        )
    {
        return "idle";
    }

    "unknown"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin_detection::JcodeDetectionVariant;

    #[test]
    fn vanilla_idle_prompt() {
        assert_eq!(
            detect_jcode_status_with_variant("❯", JcodeDetectionVariant::Vanilla),
            "idle"
        );
        assert_eq!(
            detect_jcode_status_with_variant("1> ", JcodeDetectionVariant::Vanilla),
            "idle"
        );
        assert_eq!(
            detect_jcode_status_with_variant("Session ready\n❯", JcodeDetectionVariant::Vanilla),
            "idle"
        );
    }

    #[test]
    fn vanilla_working_spinner() {
        assert_eq!(
            detect_jcode_status_with_variant("⠋ thinking…", JcodeDetectionVariant::Vanilla),
            "working"
        );
        assert_eq!(
            detect_jcode_status_with_variant("··● bash ●·· · 12s", JcodeDetectionVariant::Vanilla),
            "working"
        );
    }

    #[test]
    fn vanilla_blocked() {
        let blocked = "Permission request\n❯ Allow once\n  Deny";
        assert_eq!(
            detect_jcode_status_with_variant(
                &blocked.to_lowercase(),
                JcodeDetectionVariant::Vanilla
            ),
            "blocked"
        );
    }

    #[test]
    fn alecuba16_overview_idle() {
        // Overview panel with session count, separator, cost line, memory, swarm
        let overview = "3 sessions · fix/info_fields\n\
- - - - - - - - - - - - - - - - - - - - - -\n\
💰 $0.0012  ↓45k ↑12k tok  ⌀38.2 t/s\n\
🧠 47 memories\n\
🐝 3 sessions\n❯";
        assert_eq!(
            detect_jcode_status_with_variant(overview, JcodeDetectionVariant::Alecuba16),
            "idle"
        );
    }

    #[test]
    fn alecuba16_overview_idle_no_prompt() {
        // Overview panel visible, no prompt at bottom yet (still idle)
        let overview = "1 session · main\n\
- - - - - - - - - - - - - - - - - - - - - -\n\
💰 $0.0000  ↓0 ↑0 tok  ⌀0.0 t/s\n\
🧠 0 memories\n\
🐝 0 sessions";
        assert_eq!(
            detect_jcode_status_with_variant(overview, JcodeDetectionVariant::Alecuba16),
            "idle"
        );
    }

    #[test]
    fn alecuba16_working_spinner() {
        let working = "⠋ sending… 0.3s\n\
3 sessions · main\n\
- - - - - - - - - - - - - - - - - - - - - -\n\
💰 $0.0012  ↓45k ↑12k tok  ⌀38.2 t/s\n\
🧠 47 memories\n\
🐝 3 sessions";
        assert_eq!(
            detect_jcode_status_with_variant(
                &working.to_lowercase(),
                JcodeDetectionVariant::Alecuba16
            ),
            "working"
        );
    }

    #[test]
    fn alecuba16_blocked() {
        let blocked = "Permission request\n❯ Allow once\n  Deny\n\
3 sessions · main\n\
- - - - - - - - - - - - - - - - - - - - - -\n\
💰 $0.0012  ↓45k ↑12k tok  ⌀38.2 t/s\n\
🧠 47 memories\n\
🐝 3 sessions";
        assert_eq!(
            detect_jcode_status_with_variant(
                &blocked.to_lowercase(),
                JcodeDetectionVariant::Alecuba16
            ),
            "blocked"
        );
    }

    #[test]
    fn variant_dispatch_vanilla_default() {
        assert_eq!(
            detect_jcode_status_with_variant("❯", JcodeDetectionVariant::Vanilla),
            "idle"
        );
    }

    #[test]
    fn variant_dispatch_alecuba16() {
        let overview = "1 session · main\n- - - - \n💰 $0.00  ↓0 ↑0 tok  ⌀0.0 t/s\n🧠 0 memories\n🐝 0 sessions";
        assert_eq!(
            detect_jcode_status_with_variant(overview, JcodeDetectionVariant::Alecuba16),
            "idle"
        );
        // Same input with vanilla variant should be unknown (no vanilla markers)
        assert_eq!(
            detect_jcode_status_with_variant(overview, JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }
}
