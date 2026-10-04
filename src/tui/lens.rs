//! Chat lens over the terminal screen (ux overhaul 2/3, TUI port).
//!
//! The webui lens renders the pane transcript as a reading column over
//! the still-attached terminal surface. The TUI counterpart is an
//! overlay over the terminal pane: the transcript is read from
//! `TuiApp::pane_tail` (the ANSI-stripped tail `refresh_tail()` keeps
//! fresh on every navigation and refresh tick) — the same source the
//! prompt-card parser reads — so no second connection is created and
//! protocol 22 stays frozen.
//!
//! Turn heuristics mirror the webui lens: a line that starts with a
//! shell prompt marker (`❯`, `›`, `➜`, or `$ `) is a user turn
//! (accent-highlighted), consecutive blank lines fold to a single gap,
//! everything else is plain output. Wrapped typed input degrades to a
//! plain output line — better to under-card than to swallow command
//! output into the user's card.
//!
//! Auto-follow mirrors the webui scroller: the view sticks to the tail
//! while the user has not scrolled up; scrolling up stops following
//! and the footer shows the resume hint instead (the webui's "New
//! output" pill).

/// Lens gate outcome for the selected pane (design section 6): the
/// webui Chat/Terminal switch is hidden for panes without a provider,
/// so the TUI shortcut must not open the overlay there either.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LensGate {
    /// `agent_session` present with a supported kind: the lens may open.
    Supported,
    /// No `agent_session` at all (shell pane, or old backend without
    /// the field): the lens stays closed.
    NoSession,
    /// `agent_session` with a kind that has no transcript provider.
    UnsupportedKind,
}

/// Refusal copy for the lens hint (design section 6: "reason drives
/// the lens hint text"). Same strings as the webui
/// `refusalReasonCopy` (lens.js) so both surfaces show the same words.
pub fn refusal_reason_copy(reason: &str) -> String {
    match reason {
        "no_session_path" => "No jcode conversation found for this panel yet".to_string(),
        "ambiguous" => {
            "Multiple jcode conversations match this panel; open one in the terminal to disambiguate"
                .to_string()
        }
        _ => "Conversation unavailable right now".to_string(),
    }
}

/// A shaped transcript line for rendering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LensLine {
    /// Shell prompt line: the user's turn.
    User(String),
    /// Agent/shell output line.
    Output(String),
    /// A folded gap between output blocks.
    Gap,
}

/// Live state of the lens overlay. Owned by `TuiApp`; the render reads
/// it and the key handler updates it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LensState {
    /// Whether the lens overlay is open.
    pub active: bool,
    /// Follow the tail (webui `follow`): true while the view sits at
    /// the bottom; scrolling up stops following.
    pub follow: bool,
    /// New output arrived while the reader scrolled up (webui
    /// `unread`): the footer shows the resume hint until the view
    /// returns to the bottom.
    pub unread: bool,
    /// Line offset from the transcript tail while not following.
    /// 0 = pinned to the newest line (the follow position).
    pub scroll_up: usize,
    /// Last rendered line count, to detect new output for `unread`.
    last_len: usize,
}

impl LensState {
    /// Open the lens: follow the tail, no unread output.
    pub fn open(&mut self) {
        self.active = true;
        self.follow = true;
        self.unread = false;
        self.scroll_up = 0;
        self.last_len = 0;
    }

    /// Close the lens.
    pub fn close(&mut self) {
        self.active = false;
        self.follow = true;
        self.unread = false;
        self.scroll_up = 0;
        self.last_len = 0;
    }

    /// Toggle per the webui Chat/Terminal segmented switch.
    pub fn toggle(&mut self) {
        if self.active {
            self.close();
        } else {
            self.open();
        }
    }

    /// Feed the current transcript length after every tail refresh so
    /// `unread` tracks new output while the reader is scrolled up
    /// (webui `render()`'s length check).
    pub fn observe_len(&mut self, len: usize) {
        if self.active && !self.follow && len > self.last_len {
            self.unread = true;
        }
        self.last_len = len;
    }

    /// Scroll up by `delta` transcript lines, stopping the follow
    /// (webui scroller: any upward scroll leaves the bottom).
    pub fn scroll_up(&mut self, delta: usize, len: usize) {
        self.follow = false;
        self.scroll_up = (self.scroll_up + delta).min(len.saturating_sub(1));
    }

    /// Scroll back down; reaching the bottom re-arms the follow and
    /// clears `unread` (webui `atBottom`). `len` is accepted for call
    /// symmetry with `scroll_up` (callers pass the transcript length
    /// to both).
    pub fn scroll_down(&mut self, delta: usize, _len: usize) {
        self.scroll_up = self.scroll_up.saturating_sub(delta);
        if self.scroll_up == 0 {
            self.follow = true;
            self.unread = false;
        }
    }
}

/// Prompt markers the webui lens recognizes as the start of a user
/// turn. `$` requires a trailing space so `ls $FOO` output does not
/// read as a prompt.
pub fn is_prompt_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    for marker in ["❯", "›", "➜"] {
        if let Some(rest) = trimmed.strip_prefix(marker) {
            // The marker alone (no argument typed yet) still counts as
            // the prompt line, matching the webui `(?:❯|›|➜)\s+|\$\s+`
            // which accepts an empty command.
            if rest.is_empty() || rest.starts_with(' ') {
                return true;
            }
        }
    }
    trimmed.starts_with("$ ")
}

/// Shape the pane tail into lens lines. Port of the webui
/// `transcriptHtml` heuristics.
pub fn transcript_lines(tail: &[String]) -> Vec<LensLine> {
    let mut out = Vec::new();
    for line in tail {
        if is_prompt_line(line) {
            out.push(LensLine::User(line.trim_start().to_string()));
        } else if line.trim().is_empty() {
            if !matches!(out.last(), Some(LensLine::Gap)) && !out.is_empty() {
                out.push(LensLine::Gap);
            }
        } else {
            out.push(LensLine::Output(line.to_string()));
        }
    }
    out
}

/// Window of transcript lines to render: the last `viewport` lines
/// ending `scroll_up` lines above the tail (the follow position is
/// the tail). Mirrors the webui's bottom-anchored scroller. Over-scroll
/// clamps inside this helper so the first viewport is always shown
/// even if a stale `scroll_up` outlives a transcript shrink.
pub fn visible_window(lines: &[LensLine], scroll_up: usize, viewport: usize) -> &[LensLine] {
    // Clamp so the window never sits above the transcript start: over-
    // scroll lands on the FIRST viewport (start of transcript), the
    // webui scroller's top position.
    let max_scroll_up = lines.len().saturating_sub(viewport.min(lines.len()));
    let scroll_up = scroll_up.min(max_scroll_up);
    let end = lines.len().saturating_sub(scroll_up);
    &lines[end.saturating_sub(viewport)..end]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tail(lines: &[&str]) -> Vec<String> {
        lines.iter().map(|line| line.to_string()).collect()
    }

    #[test]
    fn prompt_markers_start_user_turns() {
        assert!(is_prompt_line("❯ ls"));
        assert!(is_prompt_line("  ❯ cargo build"));
        assert!(is_prompt_line("➜ echo hi"));
        assert!(is_prompt_line("$ whoami"));
        assert!(is_prompt_line("❯"));
        // A bare `$` without space, and output containing `$`, are not
        // prompt lines (the webui regex requires `\$\s+`).
        assert!(!is_prompt_line("$"));
        assert!(!is_prompt_line("total 4 $ foo"));
        assert!(!is_prompt_line("price: $5"));
        assert!(!is_prompt_line("❯nospace"));
    }

    #[test]
    fn transcript_shapes_user_output_and_gaps() {
        let lines = transcript_lines(&tail(&[
            "❯ cargo test",
            "running 3 tests",
            "test result: ok",
            "",
            "",
            "❯ git status",
            "nothing to commit",
        ]));
        assert_eq!(
            lines,
            vec![
                LensLine::User("❯ cargo test".into()),
                LensLine::Output("running 3 tests".into()),
                LensLine::Output("test result: ok".into()),
                LensLine::Gap,
                LensLine::User("❯ git status".into()),
                LensLine::Output("nothing to commit".into()),
            ]
        );
    }

    #[test]
    fn blank_leading_lines_do_not_open_with_a_gap() {
        let lines = transcript_lines(&tail(&["", "", "output"]));
        assert_eq!(lines, vec![LensLine::Output("output".into())]);
    }

    #[test]
    fn trailing_blank_lines_fold_to_one_gap() {
        let lines = transcript_lines(&tail(&["out", "", "", ""]));
        assert_eq!(lines, vec![LensLine::Output("out".into()), LensLine::Gap]);
    }

    #[test]
    fn wrapped_input_degrades_to_output() {
        // Continuation of a typed command wraps without a prompt
        // marker; it must not join a new user card.
        let lines = transcript_lines(&tail(&["❯ long command", "continues here"]));
        assert!(matches!(lines[0], LensLine::User(_)));
        assert!(matches!(lines[1], LensLine::Output(_)));
    }

    #[test]
    fn lens_open_follows_and_close_resets() {
        let mut lens = LensState::default();
        assert!(!lens.active);
        lens.open();
        assert!(lens.active);
        assert!(lens.follow);
        assert!(!lens.unread);
        lens.close();
        assert!(!lens.active);
    }

    #[test]
    fn toggle_flips_both_directions_like_the_segmented_switch() {
        // The webui Chat/Terminal segmented switch: one control, both
        // directions. The prefix dispatch calls toggle(), so both arms
        // must work without a separate close key.
        let mut lens = LensState::default();
        lens.toggle();
        assert!(lens.active, "toggle opens the lens");
        assert!(lens.follow);
        lens.toggle();
        assert!(!lens.active, "toggle closes the lens");
        // Close must also reset the reading position so the next open
        // starts at the tail, not at a stale scroll.
        lens.open();
        lens.scroll_up(3, 10);
        lens.toggle();
        assert!(!lens.active);
        assert_eq!(lens.scroll_up, 0);
    }

    #[test]
    fn scrolling_up_stops_follow_and_marks_unread() {
        let mut lens = LensState::default();
        lens.open();
        lens.observe_len(10);
        lens.scroll_up(3, 12);
        assert!(!lens.follow);
        assert_eq!(lens.scroll_up, 3);
        // New output while scrolled up surfaces the unread hint.
        lens.observe_len(15);
        assert!(lens.unread);
        // Back to the bottom re-arms follow and clears unread.
        lens.scroll_down(10, 15);
        assert!(lens.follow);
        assert!(!lens.unread);
    }

    #[test]
    fn scroll_up_clamps_to_first_line() {
        let mut lens = LensState::default();
        lens.open();
        lens.scroll_up(100, 10);
        assert_eq!(lens.scroll_up, 9);
    }

    #[test]
    fn visible_window_anchors_to_tail() {
        let lines: Vec<LensLine> = (0..20)
            .map(|index| LensLine::Output(format!("line {index}")))
            .collect();
        // Following: the last 5 lines.
        let window = visible_window(&lines, 0, 5);
        assert_eq!(window.len(), 5);
        assert_eq!(window.last().unwrap(), &LensLine::Output("line 19".into()));
        // Scrolled up 7: window ends at line 12 (index 20-7-1).
        let window = visible_window(&lines, 7, 5);
        assert_eq!(window.last().unwrap(), &LensLine::Output("line 12".into()));
        // Over-scroll clamps at the start (empty window only when the
        // transcript itself is empty).
        let window = visible_window(&lines, 100, 5);
        assert_eq!(window.len(), 5, "clamp still shows the first viewport");
        assert_eq!(window.first().unwrap(), &LensLine::Output("line 0".into()));
    }
}
