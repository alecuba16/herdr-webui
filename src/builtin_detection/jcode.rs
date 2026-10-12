//! Jcode screen-scrape detection, derived from the real jcode TUI renderers.
//!
//! Two source trees are mirrored here (TEMPORARY: until jcode ships a final
//! output format, the two branches render slightly different Overview panels):
//!
//! - `Vanilla`: upstream jcode `master`. Detection is driven by the bottom
//!   chrome (`crates/jcode-tui/src/tui/ui_input.rs` + `ui.rs` in the jcode
//!   repo): numbered input prompt `N> `, spinner status line
//!   (`⠋ sending… 12s`, `⠋ running bash · …`), network retry line, and the
//!   Permissions viewer (`Permissions (N pending)` + `a approve`/`d deny`
//!   help row).
//! - `InfoFields`: the `fix/info_fields` branch. Adds an Overview panel whose
//!   Runtime section leads with the `🏠 model · effort` identity row
//!   (`info_widget_model.rs::runtime_rows`), plus `🐝`/`🧠` override rows.
//!   Everything else (input chrome, spinner, permissions) is identical to
//!   master, so the info_fields detector is the vanilla one plus the
//!   Overview markers.
//!
//! Both branches are also natively detectable via the terminal title
//! (` · work ~<dur>` while a turn runs, ` · last ~<dur>` after it ends;
//! mapped in `osc_title_status_for_agent` upstream, `last` is the live
//! post-turn idle signal), via OSC 9 progress payloads on the
//! `herdr_detectable` branch (`ESC]9;jcode:<state> BEL`), and via the
//! herdr CLI `pane report-agent` channel; those are handled in
//! `detect_agent_status_with_osc` upstream and always win over this
//! screen-scrape fallback.
//!
//! TEMPORARY SOLUTION: the variant selector exists only while the `fix/info_fields`
//! Overview layout diverges from upstream master. Once jcode includes a final
//! output format (OSC 9 by default, converged Overview), the two variants
//! should be merged back into a single `detect_jcode_status` and this selector
//! removed. See `docs/features.md` and `docs/technical-details.md`.

use crate::builtin_backend::{
    bottom_non_empty_lines, contains_any, has_jcode_spinner, jcode_numbered_prompt_line,
};
use crate::builtin_detection::JcodeDetectionVariant;

/// Screen-scrape detection for jcode, selected by variant.
///
/// `Auto` routes to the InfoFields detector rather than sniffing per pane:
/// the InfoFields detector is a strict superset of the vanilla one
/// (identical bottom-chrome matching, plus the 🏠 Overview idle markers),
/// so Auto and InfoFields are behaviourally identical. Keeping the arms
/// separate only matters for explicit user pinning; when in doubt pick Auto.
pub fn detect_jcode_status_with_variant(
    lower: &str,
    variant: JcodeDetectionVariant,
) -> &'static str {
    match variant {
        JcodeDetectionVariant::Vanilla => detect_jcode_status_vanilla(lower),
        JcodeDetectionVariant::Auto
        | JcodeDetectionVariant::Alecuba16Legacy
        | JcodeDetectionVariant::InfoFields => detect_jcode_status_info_fields(lower),
    }
}

/// Vanilla jcode screen-scrape detection (upstream master output format).
///
/// Mirrors jcode's bottom chrome (`ui_input.rs` in the jcode repo):
/// - Blocked: Permissions viewer `Permissions (N pending)` with its
///   `a approve`/`d deny`/`A approve all`/`D deny all` help row, or the
///   `⏳ Agent is waiting for this decision` line.
/// - Working: the spinner status line (`⠋ sending… 3s`, `⠋ thinking… 1m 02s`,
///   `⠋ streaming · 12.3 tps`, `⠋ running bash · server`), the rate-limit
///   auto-retry line, or the `↻ network disconnected, waiting to retry` line.
/// - Idle: the numbered input prompt `N> ` as the last non-empty line
///   (`input_prompt` returns `"> "` when not processing; `wrap_input_text`
///   prefixes the turn number). While processing the prompt becomes `N… `,
///   and shell mode renders `N$ ` with a `shell mode · Enter runs` hint.
/// - The overscroll status line (dir/branch/context/model facts) sits below
///   the input and is an idle-side marker: it is suppressed while a turn runs
///   only in the sense that the spinner line wins first, so it is used as a
///   weak idle signal, never over a working marker.
fn detect_jcode_status_vanilla(lower: &str) -> &'static str {
    let bottom12 = bottom_non_empty_lines(lower, 12);
    let bottom8 = bottom_non_empty_lines(lower, 8);
    let bottom4 = bottom_non_empty_lines(lower, 4);

    if jcode_blocked(&bottom8) {
        return "blocked";
    }

    if jcode_working(&bottom8) {
        return "working";
    }

    // Idle: last non-empty line is the input prompt `N> ` / `N$ ` (possibly
    // with typed text after it), or an idle hint row just below the input
    // (`↗ Next prompt opens a new session`, `shell mode · Enter runs…`),
    // or the overscroll status line under an empty prompt.
    if jcode_idle_chrome(&bottom12) {
        return "idle";
    }

    let _ = (bottom4,);
    "unknown"
}

/// InfoFields variant (`fix/info_fields` branch output format).
///
/// Identical bottom chrome to vanilla, plus the Overview panel markers the
/// branch adds: the `🏠 model · effort` Runtime identity row, `🐝`/`🧠`
/// agent-override rows, and the `Overview` / `Overview · todos` /
/// `Overview · plan` / `Overview · memory` border titles. When the Overview
/// is visible without any working/blocked marker, the pane is idle.
fn detect_jcode_status_info_fields(lower: &str) -> &'static str {
    let status = detect_jcode_status_vanilla(lower);
    if status != "unknown" {
        return status;
    }
    if has_info_fields_overview_markers(lower) {
        return "idle";
    }
    "unknown"
}

/// Working markers from jcode's status line (`draw_status` in `ui_input.rs`)
/// plus the background-task progress boxes (`ui_messages.rs`).
///
/// Status-line markers, rendered at the bottom chrome while a turn runs:
/// - braille spinner + phase label: `⠋ sending… 3s`, `⠋ thinking… 1m 02s`,
///   `⠋ streaming · ↑1.2k ↓4.5k`, `⠋ running bash · detail`, `⠋ refreshing auth…`,
///   `⠋ connecting…`, `⠋ retrying 2/3`
/// - `⠋ Rate limited. Auto-retry in 1m 30s...`
/// - `↻ network disconnected, waiting to retry · listener · 12s`
/// - queued rows above the status line: `N ⏳ <text>` / `N ↻ <text>`
///
/// Background-task markers: while a `bg` task runs, jcode still shows the
/// input prompt, but the transcript carries the `Jcode is running this in
/// the background` banner and a live `◌ bg <label> · <task-id>` progress
/// box (`render_background_task_message`). The `✓`/`✗` completion boxes do
/// not count: only a still-running box does.
fn jcode_working(bottom8: &str) -> bool {
    if has_jcode_spinner(bottom8) {
        return true;
    }
    if is_jcode_active_background_line(bottom8) {
        return true;
    }
    bottom8.lines().any(|line| {
        let line = line.trim();
        // `draw_status` renders the network-retry line with a leading `↻ `.
        line.starts_with("↻ network disconnected")
            // Rate-limit line: spinner + `Rate limited. Auto-retry in ...`.
            || line.contains("rate limited. auto-retry in")
            // Queued-message preview rows (`draw_queued`): `4 ⏳ continue tests`
            // or `4 ↻ stop after this tool`. Only rendered while processing.
            || is_jcode_queued_row(line)
            // Connection-phase labels from `connection_phase_label`, always
            // prefixed by the spinner; matched as a suffix so the spinner
            // variant does not matter.
            || line.contains(" sending context")
            || line.contains(" waiting for response")
            || line.contains(" refreshing auth")
    })
}

/// A live background-task line: the `◌ bg <label>` progress box title, its
/// `Latest status: bg action="status"` hint, or the task-started banner
/// (jcode-base `background.rs`). Completion boxes render `✓`/`✗` instead of
/// `◌`, so they fall through to the idle path.
pub(crate) fn is_jcode_active_background_line(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim();
        (line.contains('◌') && line.contains(" bg "))
            || line.contains("jcode is running this in the background")
            || line.contains("latest status: bg action=\"status\"")
            || (line.contains("progress, checkpoints")
                && line.contains("completion will appear here"))
    })
}

/// A queued-preview row from `draw_queued`: `<number> <glyph> <text>` where
/// the glyph is ⏳ (queued), ↻ (pending soft interrupt), or ⚡ (interleave).
/// While processing the TUI renders up to three of these above the status
/// line, so seeing one is a working signal.
fn is_jcode_queued_row(line: &str) -> bool {
    let mut chars = line.chars();
    if !chars.next().is_some_and(|ch| ch.is_ascii_digit()) {
        return false;
    }
    let rest = line[line.find(|ch: char| !ch.is_ascii_digit()).unwrap_or(0)..].trim_start();
    if !matches!(rest.chars().next(), Some('⏳' | '↻' | '⚡')) {
        return false;
    }
    let text = rest[rest
        .find(|ch: char| ch.is_whitespace())
        .unwrap_or(rest.len())..]
        .trim();
    !text.is_empty()
}

/// Idle markers from jcode's input chrome: the numbered prompt (`1> `,
/// `2$ ` shell mode, `3… ` is working-only so excluded), the hint rows
/// `draw_input` adds below the prompt, and the overscroll status line under it.
///
/// The overscroll status line (`draw_overscroll_status`) renders compact
/// facts such as ` ~/repo branch ±6 ↑1 74k/256k ▰▰▰▱▱ 29% OAuth claude
/// gpt-5.3 high`. It exists on both branches and appears only when the
/// transcript overflows, so it is a weak idle signal on its own.
fn jcode_idle_chrome(bottom12: &str) -> bool {
    let lines: Vec<&str> = bottom12.lines().collect();
    let Some(last) = lines.iter().rev().find(|l| !l.trim().is_empty()) else {
        return false;
    };
    let last = last.trim();
    // Input prompt: `<turn-number>> ` optionally followed by typed text;
    // shell mode renders `<turn-number>$ ` (input_prompt + send_mode_indicator).
    if jcode_numbered_prompt_line(last) || jcode_shell_prompt_line(last) {
        return true;
    }
    // Hint rows below the prompt (`draw_input`).
    if last.starts_with("↗ next prompt opens a new session")
        || last.starts_with("shell mode · enter runs")
    {
        return true;
    }
    // Overscroll status line: fact groups joined by single spaces, where the
    // model fact is the final group. Accept the two always-rendered shapes:
    // a trailing context percentage, or the model group at line end.
    // The context bar is `▰` filled + `▱` empty segments
    // (`overscroll_context_bar` in jcode's ui_input.rs); at low context use
    // (e.g. 2% on a fresh session) every segment is empty, so the line
    // carries `▱▱▱▱` and no `▰`. Both glyphs identify the bar.
    if last.contains('▰') || last.contains('▱') || is_overscroll_status_line(last) {
        return true;
    }
    false
}

/// Shell-mode input prompt: `<turn-number>$ ` (`input_prompt` returns "$ "
/// when the composer is in shell mode, still prefixed by the turn number).
pub(crate) fn jcode_shell_prompt_line(line: &str) -> bool {
    let line = line.trim_start();
    let digit_count = line.chars().take_while(|ch| ch.is_ascii_digit()).count();
    digit_count > 0
        && line[digit_count..]
            .chars()
            .next()
            .is_some_and(|ch| ch == '$')
}

/// Heuristic for the overscroll status line: it is built from compact fact
/// groups (`dir branch git context auth provider model`), fits one row, and
/// always contains a token-count ratio like `74k/256k` or a trailing context
/// percentage. A bare ratio in prose ("74k/256k tokens used") is not enough:
/// the real line also carries the context bar (`▰` filled and/or `▱` empty
/// segments; a fresh session at 2% renders only `▱`) or trailing model
/// facts, so require one of those alongside the ratio.
fn is_overscroll_status_line(line: &str) -> bool {
    let has_token_ratio = line.split_whitespace().any(|word| {
        let Some((used, limit)) = word.split_once('/') else {
            return false;
        };
        compact_number(used) && compact_number(limit)
    });
    // No ratio: the only other always-rendered shape ends in a context
    // percentage behind the context bar. At zero filled segments the bar
    // is only `▱`, so accept either glyph.
    if !has_token_ratio {
        return line.ends_with('%') && (line.contains('▰') || line.contains('▱'));
    }
    // The real line always pairs the ratio with the context bar. A ratio in
    // prose ("74k/256k tokens used") must not match.
    line.contains('▰') || line.contains('▱')
}

/// `74k`, `256k`, `1.2m`, or a plain number, as `overscroll_format_tokens`
/// and `overscroll_format_tokens` render them.
fn compact_number(text: &str) -> bool {
    let Some(last) = text.chars().last() else {
        return false;
    };
    let digits = match last {
        'k' | 'm' => &text[..text.len() - 1],
        _ => text,
    };
    !digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit() || ch == '.')
}

/// Info_fields Overview markers (`info_widget_model.rs::runtime_rows` on the
/// `fix/info_fields` branch). The branch's Overview Runtime section leads
/// with the `🏠 <model> · <effort>` identity row; master's Runtime section
/// never renders 🏠 (its first possible row is `⚡ <tier> tier`). The border
/// title (`Overview`, `Overview · todos`, `Overview · plan`,
/// `Overview · memory`) and the `◆ <name> · N sessions` row exist on both
/// branches, so they are not used to pin the variant; only 🏠 does.
fn has_info_fields_overview_markers(lower: &str) -> bool {
    lower.lines().any(|line| {
        let line = line.trim();
        // Panel rows sit inside a `│ ` border, so match after any leading
        // border characters. The effort-only override rows (`🐝 · <effort>`,
        // `🧠 · <effort>`) exist only on the branch; the plain `🐝 <model>`
        // swarm row exists on master too, so it does not pin the variant.
        let row = line.trim_start_matches(['│', ' ']);
        row.starts_with("🏠 ") || row.starts_with("🐝 · ") || row.starts_with("🧠 · ")
    })
}

/// Blocked markers from jcode's Permissions viewer
/// (`crates/jcode-tui-permissions/src/lib.rs`): border title
/// `Permissions (N pending)`, the help row `a approve · d deny · A approve
/// all · D deny all`, and the `⏳ Agent is waiting for this decision` line.
pub(crate) fn jcode_blocked(bottom8: &str) -> bool {
    bottom8.lines().any(|line| {
        let line = line.trim();
        (line.contains("permissions (") && line.contains("pending"))
            || (line.contains("agent is waiting for this decision"))
            || (line.contains("approve all") && line.contains("deny all"))
            || (line.contains("a approve") && line.contains("d deny"))
    }) || contains_any(bottom8, &["approve? allow once", "confirm action"])
        && contains_any(bottom8, &["deny", "reject", "cancel"])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::builtin_detection::JcodeDetectionVariant;

    fn detect(lower: &str, variant: JcodeDetectionVariant) -> &'static str {
        detect_jcode_status_with_variant(&lower.to_lowercase(), variant)
    }

    // ---- vanilla idle ----

    #[test]
    fn vanilla_idle_numbered_prompt() {
        assert_eq!(detect("1> ", JcodeDetectionVariant::Vanilla), "idle");
        assert_eq!(
            detect("3> fix the bug", JcodeDetectionVariant::Vanilla),
            "idle"
        );
        // Shell mode prompt `N$ `.
        assert_eq!(detect("2$ ", JcodeDetectionVariant::Vanilla), "idle");
    }

    #[test]
    fn vanilla_idle_with_overscroll_status_line() {
        let tail = "user message text\n\
                    1> \n\
                    ~/projects/app main ±6 ↑1 74k/256k ▰▰▰▱▱▱▱▱▱▱ 29% oauth claude gpt-5.3 high";
        assert_eq!(detect(tail, JcodeDetectionVariant::Vanilla), "idle");
    }

    #[test]
    fn vanilla_idle_with_empty_context_bar() {
        // Fresh session at 2% context: `overscroll_context_bar` rounds to
        // zero filled segments, so the compact bar renders `▱▱▱▱` with no
        // `▰` (live capture from a real jcode boot in a PTY).
        let tail = "skills: 17 loaded\n\
                    ~/projects/app (main)\n\
                    1>\n\
                    ~/…/app main… ±37 ▱▱▱▱ 2% llmg-coding together/revolut glm 5 2 nvfp4 max";
        assert_eq!(detect(tail, JcodeDetectionVariant::Vanilla), "idle");
        assert_eq!(detect(tail, JcodeDetectionVariant::InfoFields), "idle");
    }

    #[test]
    fn vanilla_idle_hint_rows() {
        assert_eq!(
            detect(
                "1> \n↗ next prompt opens a new session",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
        assert_eq!(
            detect(
                "2$ \nshell mode · enter runs locally",
                JcodeDetectionVariant::Vanilla
            ),
            "idle"
        );
    }

    // ---- vanilla working ----

    #[test]
    fn vanilla_working_spinner_status_line() {
        for line in [
            "⠋ sending… 3s",
            "⠙ thinking… 1m 02s",
            "⠹ streaming · 12.3 tps · ↑1.2k ↓4.5k",
            "⠸ running bash · npm test",
            "⠼ refreshing auth… 4s",
            "⠴ connecting… 2s",
            "⠦ retrying 2/3… 8s",
        ] {
            assert_eq!(
                detect(line, JcodeDetectionVariant::Vanilla),
                "working",
                "{line}"
            );
        }
    }

    #[test]
    fn vanilla_working_rate_limit_and_network() {
        assert_eq!(
            detect(
                "⠋ rate limited. auto-retry in 1m 30s...",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
        assert_eq!(
            detect(
                "↻ network disconnected, waiting to retry · ws · 12s",
                JcodeDetectionVariant::Vanilla
            ),
            "working"
        );
    }

    #[test]
    fn vanilla_working_queued_rows() {
        assert_eq!(
            detect("4 ⏳ continue the tests", JcodeDetectionVariant::Vanilla),
            "working"
        );
        assert_eq!(
            detect("2 ↻ stop after this tool", JcodeDetectionVariant::Vanilla),
            "working"
        );
    }

    // ---- vanilla blocked ----

    #[test]
    fn vanilla_blocked_permissions_viewer() {
        let blocked = "Run this command?\n\
                       ┌ Permissions (1 pending) ─────┐\n\
                       │ ⏳ Agent is waiting for this decision │\n\
                       └──────────────┘\n\
                       a approve · d deny · A approve all · D deny all";
        assert_eq!(detect(blocked, JcodeDetectionVariant::Vanilla), "blocked");
    }

    #[test]
    fn vanilla_blocked_legacy_permission_dialog() {
        let blocked = "approve? allow once\n  deny";
        assert_eq!(detect(blocked, JcodeDetectionVariant::Vanilla), "blocked");
    }

    // ---- vanilla unknown ----

    #[test]
    fn vanilla_plain_text_is_unknown() {
        assert_eq!(
            detect("hello world\nplain text", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    // ---- info_fields variant ----

    #[test]
    fn info_fields_overview_idle() {
        let tail = "╭ overview ─────────╮\n\
                    │ 🏠 gpt-5.3-codex · high      │\n\
                    │ ⚡ fast tier                │\n\
                    │ ⏱ 62 tok/s                 │\n\
                    ╰──────────────╯\n\
                    1> ";
        assert_eq!(detect(tail, JcodeDetectionVariant::InfoFields), "idle");
        // Vanilla must not claim the Overview panel as its own idle marker:
        // the prompt line already gives idle, but with the prompt cropped out
        // of the tail, vanilla reports unknown while info_fields stays idle.
        let without_prompt = tail.replace("1> ", "");
        assert_eq!(
            detect(&without_prompt, JcodeDetectionVariant::Vanilla),
            "unknown"
        );
        assert_eq!(
            detect(&without_prompt, JcodeDetectionVariant::InfoFields),
            "idle"
        );
    }

    #[test]
    fn info_fields_working_spinner_wins_over_overview() {
        let tail = "⠋ thinking… 12s\n\
                    ╭ overview ─────────╮\n\
                    │ 🏠 gpt-5.3-codex · high      │\n\
                    ╰──────────────╯";
        assert_eq!(detect(tail, JcodeDetectionVariant::InfoFields), "working");
    }

    // ---- auto variant ----

    #[test]
    fn auto_detects_info_fields_from_overview_row() {
        let info_fields_tail = "🏠 gpt-5.3-codex · high\n1> ";
        assert_eq!(
            detect(info_fields_tail, JcodeDetectionVariant::Auto),
            "idle"
        );
    }

    #[test]
    fn auto_falls_back_to_vanilla_without_overview() {
        // No 🏠 row: same answer as vanilla on the working spinner.
        assert_eq!(
            detect("⠋ sending… 3s", JcodeDetectionVariant::Auto),
            "working"
        );
        // Vanilla-only tail with prompt → idle via vanilla rules.
        assert_eq!(detect("1> ", JcodeDetectionVariant::Auto), "idle");
    }

    // ---- guards ----

    #[test]
    fn spinner_without_label_is_not_working() {
        // A bare braille char (e.g. a stray pattern in transcript text) must
        // not read as working: `has_jcode_spinner` requires the spinner to be
        // followed by a space and alphabetic text, and the queued-row check
        // requires the ⏳/↻/⚡ glyphs.
        assert_eq!(
            detect("⠋\nplain transcript text", JcodeDetectionVariant::Vanilla),
            "unknown"
        );
    }

    #[test]
    fn transcript_token_counts_do_not_read_as_idle() {
        // A transcript line with a token ratio is not the overscroll status
        // line: without the ▰ context bar or the trailing model facts it
        // must stay unknown instead of flipping the pane to idle.
        assert_eq!(
            detect(
                "usage: 74k/256k tokens used",
                JcodeDetectionVariant::Vanilla
            ),
            "unknown"
        );
    }
}
