//! Question-dialog parser for blocked agents, shared by the webui
//! `/api/panes/{pane_id}/prompt` endpoint.
//!
//! Protocol 22 is frozen, so there is no structured prompt payload:
//! the parser scrapes the pane tail for the shapes the backend's
//! blocked detectors already recognize (numbered option lists, ↑↓
//! select hints, "enter your response" free-text prompts), plus the
//! jcode Permissions viewer (`a approve · d deny · A approve all ·
//! D deny all`), whose options are letters, not numbers.
//!
//! The parse is pure and derived on every call: callers re-parse the
//! CURRENT tail before acting on a dialog, so a stale parse can never
//! send stale input. The interactive card UI lives in the webui only
//! (chat lens surfaces); the TUI has no card overlay.

use std::sync::LazyLock;

use regex::Regex;

/// One numbered option of a question dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptOption {
    /// The option key as typed back into the dialog ("1", "2", ...).
    pub key: String,
    /// The visible label.
    pub label: String,
}

/// A parsed question dialog.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptCard {
    /// "options" (numbered dialog) or "text" (free-text question).
    pub kind: PromptCardKind,
    /// Question title shown at the top of the card.
    pub title: String,
    /// Numbered options (options kind only).
    pub options: Vec<PromptOption>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptCardKind {
    Options,
    Text,
}

static OPTION_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[>\s]*([0-9]+)[.)]\s+(.+)$").unwrap());
static NAV_HINT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"↑↓\s*select|↑/↓").unwrap());
static FREE_TEXT: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)enter your response|type your answer|enter send").unwrap());
static QUESTION_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\s*(?:❯|›|➜|\$)\s*(.+?)(?:\?+)?\s*$|^\s*\?+\s*(.+)$").unwrap());
static NAV_CANCEL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)esc cancel|esc dismiss").unwrap());
static PERMISSION_WORDS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)allow|approve|yes|proceed|deny|reject|no|cancel").unwrap());
// jcode ask_user chooser (jcode-tui ui_inline.rs): hint lines "1-9 or ↑↓ +
// Enter to choose · type on Your answer · Esc dismisses", "Enter sends ·
// Shift/Alt+Enter newline · Esc dismisses", and the "N. Your answer" row.
// "Enter sends" matches FREE_TEXT, so without this guard the chooser tail
// parses as a free-text card with a scraped shell-prompt title.
static JCODE_CHOOSER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)1-9 or ↑↓ \+ Enter to choose|type on Your answer|\. Your answer").unwrap()
});
// jcode Permissions viewer markers, the same lines jcode_blocked
// (builtin_detection/jcode.rs) scrapes: the bordered help row and the
// waiting line. Both must be present so transcript text quoting the
// help row format (release notes, docs) does not trigger a card.
static JCODE_VIEWER_HELP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)a approve.*d deny.*A approve all.*D deny all").unwrap());
static JCODE_VIEWER_WAITING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)agent is waiting for this decision").unwrap());
static JCODE_VIEWER_TITLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)permissions? \((\d+) pending\)").unwrap());
static CONFIRM_HINT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)enter (?:to )?(?:confirm|select|choose|submit)|press enter|return to (?:confirm|select)")
        .unwrap()
});

/// Strip a leading prompt marker / question marks from a title candidate.
fn clean_title(raw: &str) -> String {
    let trimmed = raw
        .trim_start_matches(['❯', '›', '➜', '$', '?'])
        .trim_start();
    trimmed.trim_end_matches('?').trim().to_string()
}

fn is_noise_line(line: &str) -> bool {
    let t = line.trim();
    t.is_empty()
        || OPTION_LINE.is_match(t)
        || NAV_HINT.is_match(t)
        || FREE_TEXT.is_match(t)
        || t.to_ascii_lowercase().starts_with("esc ")
}

/// Extract the question title from the dialog lines (webui
/// `questionTitle`): prefer the last line that reads like a question,
/// then prompt-marked captures, then the first non-noise line.
fn question_title(lines: &[String]) -> String {
    for line in lines.iter().rev() {
        let t = line.trim();
        if is_noise_line(t) {
            continue;
        }
        if t.ends_with('?') || t.starts_with("? ") {
            return clean_title(t);
        }
    }
    for line in lines.iter().rev() {
        if let Some(captures) = QUESTION_LINE.captures(line) {
            let captured = captures.get(1).or_else(|| captures.get(2)).and_then(|m| {
                let text = m.as_str().trim();
                (!text.is_empty()).then_some(text)
            });
            if let Some(title) = captured {
                return clean_title(title);
            }
        }
    }
    for line in lines {
        let t = line.trim();
        if !is_noise_line(t) && t.chars().count() > 3 {
            return clean_title(t);
        }
    }
    String::new()
}

/// Parse a question dialog from the tail lines (webui `parsePrompt`).
/// Returns `None` when the tail does not match any known blocked
/// question shape.
pub fn parse_prompt(lines: &[String]) -> Option<PromptCard> {
    if lines.is_empty() {
        return None;
    }
    // Unicode whitespace parity: JS `\s` and Rust regex `\s` disagree on
    // BOM and NEL, and `trim()` sets differ too. Normalize the exotic
    // spaces to plain space so all three parser copies match identically
    // on terminals that emit NBSP/NEL/U+3000/BOM/LS/PS.
    let normalized: Vec<String> = lines
        .iter()
        .map(|line| {
            line.chars()
                .map(|c| match c {
                    '\u{a0}' | '\u{85}' | '\u{3000}' | '\u{feff}' | '\u{2028}' | '\u{2029}' => ' ',
                    other => other,
                })
                .collect()
        })
        .collect();
    let lines = &normalized[..];
    let joined = lines.join("\n");
    // jcode ask_user chooser: its hint lines would otherwise fall through
    // to the free-text branch ("Enter sends ..." matches FREE_TEXT) and
    // pick a shell-prompt line as the title. The chooser is its own
    // answer surface (chat lens decision part), never a prompt card.
    if JCODE_CHOOSER.is_match(&joined) {
        return None;
    }
    // Take the LAST contiguous numbered block: an older dialog may still
    // be on screen above; the active one is the newest.
    let mut blocks: Vec<Vec<PromptOption>> = Vec::new();
    let mut current: Vec<PromptOption> = Vec::new();
    for line in lines {
        if let Some(captures) = OPTION_LINE.captures(line) {
            let key = captures.get(1).map(|m| m.as_str().to_string());
            let label = captures.get(2).map(|m| m.as_str().trim().to_string());
            if let (Some(key), Some(label)) = (key, label) {
                current.push(PromptOption { key, label });
            }
        } else if !current.is_empty() {
            blocks.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }
    let options = blocks.last().cloned().unwrap_or_default();

    // jcode Permissions viewer: help row + waiting line (fullscreen alt
    // screen; the tail arrives via the server-side pane.read path). Letter
    // options go straight to the viewer: `a` approve, `d` deny, `A`/`D`
    // bulk approve/deny. Checked first: the viewer's tail also contains
    // "approve" and "deny" words that would otherwise fall through to
    // the weaker numbered branch.
    if JCODE_VIEWER_HELP.is_match(&joined) && JCODE_VIEWER_WAITING.is_match(&joined) {
        let pending = JCODE_VIEWER_TITLE
            .captures(&joined)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str().to_string())
            .unwrap_or_else(|| "?".to_string());
        return Some(PromptCard {
            kind: PromptCardKind::Options,
            title: format!("jcode permissions ({pending} pending)"),
            options: vec![
                PromptOption {
                    key: "a".to_string(),
                    label: "Approve".to_string(),
                },
                PromptOption {
                    key: "d".to_string(),
                    label: "Deny".to_string(),
                },
                PromptOption {
                    key: "A".to_string(),
                    label: "Approve all".to_string(),
                },
                PromptOption {
                    key: "D".to_string(),
                    label: "Deny all".to_string(),
                },
            ],
        });
    }

    // Free-text prompt: a question line + "enter your response" hint.
    if FREE_TEXT.is_match(&joined) {
        let title = question_title(lines);
        if !title.is_empty() {
            return Some(PromptCard {
                kind: PromptCardKind::Text,
                title,
                options: Vec::new(),
            });
        }
        return None;
    }
    // Navigation dialog: ↑↓ hint + numbered options (Kimi/jcode-style).
    if NAV_HINT.is_match(&joined) || NAV_CANCEL.is_match(&joined) {
        if options.len() >= 2 {
            let title = question_title(lines);
            let title = if title.is_empty() {
                "Select an option".to_string()
            } else {
                title
            };
            return Some(PromptCard {
                kind: PromptCardKind::Options,
                title,
                options,
            });
        }
        return None;
    }
    // Numbered confirmation without nav hint (permission dialogs). The
    // option block must sit at the tail end or be followed by a confirm
    // hint line: a numbered transcript list above newer output must not
    // open a card during the sub-second stale-blocked window (the only
    // real false positive found by the FP simulation).
    if options.len() >= 2
        && PERMISSION_WORDS.is_match(&joined)
        && options_at_tail_or_confirmed(lines, &options)
    {
        let title = question_title(lines);
        let title = if title.is_empty() {
            "Confirm action".to_string()
        } else {
            title
        };
        return Some(PromptCard {
            kind: PromptCardKind::Options,
            title,
            options,
        });
    }
    None
}

/// Tightening for the no-nav-hint numbered branch: the option block
/// must sit at the tail end (its last option is one of the final
/// non-empty lines) or be followed by a confirm-hint line. A numbered
/// transcript list with permission words followed by newer output
/// must not open a card during the stale-blocked window.
fn options_at_tail_or_confirmed(lines: &[String], options: &[PromptOption]) -> bool {
    let last_key = match options.last() {
        Some(option) => option.key.as_str(),
        None => return false,
    };
    // Index of the line carrying the block's last option.
    let last_option_idx = match lines.iter().rposition(|line| {
        OPTION_LINE
            .captures(line)
            .and_then(|c| c.get(1))
            .map(|m| m.as_str() == last_key)
            .unwrap_or(false)
    }) {
        Some(idx) => idx,
        None => return false,
    };
    // Confirm-hint lines a real dialog may print under its options.
    for line in lines.iter().skip(last_option_idx + 1) {
        if CONFIRM_HINT.is_match(line) {
            return true;
        }
    }
    // Tail-end check: nothing but blank lines after the block.
    lines
        .iter()
        .skip(last_option_idx + 1)
        .all(|l| l.trim().is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn parse_numbered_options_with_nav_hint() {
        let tail = lines(&[
            "❯ Run this command?",
            "↑↓ select · enter confirm",
            "> 1. Yes, allow once",
            "> 2. Yes, always allow",
            "> 3. No, deny",
            "esc cancel",
        ]);
        let card = parse_prompt(&tail).expect("nav dialog parses");
        assert_eq!(card.kind, PromptCardKind::Options);
        assert_eq!(card.title, "Run this command");
        assert_eq!(card.options.len(), 3);
        assert_eq!(card.options[0].key, "1");
        assert_eq!(card.options[1].label, "Yes, always allow");
    }

    #[test]
    fn parse_permission_confirmation_without_nav_hint() {
        let tail = lines(&["Bash command approval", "1. Yes, allow once", "2. No, deny"]);
        let card = parse_prompt(&tail).expect("permission dialog parses");
        assert_eq!(card.kind, PromptCardKind::Options);
        assert_eq!(card.options.len(), 2);
        assert!(card.title.contains("approval") || !card.title.is_empty());
    }

    #[test]
    fn parse_free_text_prompt() {
        let tail = lines(&["❯ Describe the fix", "enter your response"]);
        let card = parse_prompt(&tail).expect("free-text parses");
        assert_eq!(card.kind, PromptCardKind::Text);
        assert_eq!(card.title, "Describe the fix");
        assert!(card.options.is_empty());
    }

    #[test]
    fn parse_takes_last_contiguous_block() {
        let tail = lines(&[
            "older dialog",
            "1. Yes",
            "2. No",
            "",
            "new dialog",
            "1. Proceed",
            "2. Cancel",
        ]);
        let card = parse_prompt(&tail).expect("permission dialog parses");
        assert_eq!(card.options[0].label, "Proceed");
    }

    #[test]
    fn parse_rejects_plain_output() {
        let tail = lines(&["build finished", "0 errors"]);
        assert!(parse_prompt(&tail).is_none());
    }

    #[test]
    fn parse_rejects_empty_tail() {
        assert!(parse_prompt(&[]).is_none(), "no tail, no card");
    }

    #[test]
    fn parse_rejects_free_text_shape_without_a_question_title() {
        // Free-text hint alone (options text can appear mid-output):
        // nothing reads like a question, no prompt-marked line, no
        // non-noise line => no title => no card. A stray "enter your
        // response" echo must not float a card.
        let tail = lines(&["", "enter your response"]);
        assert!(
            parse_prompt(&tail).is_none(),
            "free-text hint without a question is not a prompt"
        );
    }

    #[test]
    fn parse_rejects_nav_hint_with_a_single_option() {
        // ↑↓ hint but only one numbered line: a single-option dialog is
        // not a real question (the webui requires 2+ options).
        let tail = lines(&["↑↓ select", "1. Yes, allow once"]);
        assert!(
            parse_prompt(&tail).is_none(),
            "nav hint with fewer than two options is not a dialog"
        );
    }

    #[test]
    fn nav_dialog_without_a_title_falls_back_to_select_an_option() {
        // Nav-hint dialog whose lines are all noise (options + hint):
        // question_title finds nothing, the fallback title applies.
        let tail = lines(&["↑↓ select", "1. Yes", "2. No"]);
        let card = parse_prompt(&tail).expect("nav dialog parses");
        assert_eq!(card.kind, PromptCardKind::Options);
        assert_eq!(card.title, "Select an option");
        assert_eq!(card.options.len(), 2);
    }

    #[test]
    fn title_uses_prompt_marker_when_no_line_reads_like_a_question() {
        // No line ends with "?", but a prompt-marked line exists: the
        // second questionTitle pass captures its text as the title.
        let tail = lines(&["❯ choose the runtime", "enter your response"]);
        let card = parse_prompt(&tail).expect("free-text parses");
        assert_eq!(card.kind, PromptCardKind::Text);
        assert_eq!(card.title, "choose the runtime");
    }

    #[test]
    fn title_uses_bare_question_mark_line_as_last_resort() {
        // "? Something" shapes (the second QUESTION_LINE alternative):
        // a bare question-mark line captures through group 2 when no
        // prompt-marker line exists.
        let tail = lines(&["?? which package manager", "enter your response"]);
        let card = parse_prompt(&tail).expect("free-text parses");
        assert_eq!(card.title, "which package manager");
    }

    #[test]
    fn parse_rejects_numbered_output_without_permission_words() {
        // Two numbered lines could look like a dialog, but without a
        // nav hint or permission words it is just numbered output.
        let tail = lines(&["1. something", "2. other"]);
        assert!(
            parse_prompt(&tail).is_none(),
            "no permission words, no card"
        );
    }

    #[test]
    fn title_prefers_last_question_line() {
        let tail = lines(&[
            "❯ First question?",
            "what about this",
            "enter your response",
        ]);
        let card = parse_prompt(&tail).expect("free-text parses");
        // The first pass prefers the last line that reads like a question
        // (ends with ?): "First question?" wins over the later plain line
        // (verified against the webui oracle: questionTitle gives
        // "First question" for this exact tail).
        assert_eq!(card.title, "First question");
    }

    #[test]
    fn parse_jcode_permissions_viewer() {
        // The real jcode Permissions viewer tail (jcode-tui-permissions):
        // letter options, waiting line, pending count in the title.
        let tail = lines(&[
            "│ Permissions (2 pending)                                                    │",
            "│ a approve · d deny · A approve all · D deny all · s skip                    │",
            "│ ⏳ Agent is waiting for this decision                                        │",
            "│ Tool: Bash (rm -rf work)                                                  │",
        ]);
        let card = parse_prompt(&tail).expect("jcode viewer parses");
        assert_eq!(card.kind, PromptCardKind::Options);
        assert!(card.title.contains("jcode permissions"));
        assert!(card.title.contains("2"));
        let keys: Vec<&str> = card.options.iter().map(|o| o.key.as_str()).collect();
        assert_eq!(keys, ["a", "d", "A", "D"]);
        assert_eq!(card.options[0].label, "Approve");
        assert_eq!(card.options[3].label, "Deny all");
    }

    #[test]
    fn parse_jcode_viewer_requires_both_markers() {
        // Help row without the waiting line (docs quoting the row
        // format) is not a live viewer: no card.
        let help_only = lines(&[
            "a approve · d deny · A approve all · D deny all",
            "Release notes mention the shortcuts above.",
        ]);
        assert!(parse_prompt(&help_only).is_none());
        // Waiting line alone (transcript quote) is not a viewer either.
        // The numbered list below also sits above newer output, so the
        // tightened branch rejects it too.
        let waiting_only = lines(&[
            "earlier: ⏳ Agent is waiting for this decision",
            "1. do not parse this",
            "2. yes",
            "task finished, exit 0",
        ]);
        assert!(parse_prompt(&waiting_only).is_none());
    }

    #[test]
    fn parse_jcode_ask_user_chooser_is_not_a_card() {
        // The jcode ask_user chooser (ui_inline.rs) has its own answer
        // surface (chat lens decision parts). Its hint lines contain
        // "Enter sends ..." which matches FREE_TEXT, so without the
        // guard the hint tail would parse as a free-text card with a
        // scraped shell-prompt title.
        let tail = lines(&[
            "Where should the new workspace live?",
            "❯ 1. ~/Documents/projects/new-space",
            "  2. /tmp/scratch",
            "  3. Your answer",
            "1-9 or ↑↓ + Enter to choose · type on Your answer · Esc dismisses",
            "Enter sends · Shift/Alt+Enter newline · Esc dismisses",
        ]);
        assert!(
            parse_prompt(&tail).is_none(),
            "chooser tail is never a card"
        );
    }

    #[test]
    fn stale_window_numbered_list_above_newer_output_is_not_a_card() {
        // The FP simulation case: a numbered transcript list containing
        // permission words, followed by newer output, during the
        // sub-second stale-blocked window. Tightened branch says no.
        let tail = lines(&[
            "plan:",
            "1. allow port",
            "2. deny stale entry",
            "done, task finished",
        ]);
        assert!(parse_prompt(&tail).is_none());
    }

    #[test]
    fn numbered_block_at_tail_still_parses() {
        // Tightening must not break real dialogs: options at the very
        // end of the tail (with trailing blank lines) still parse.
        let tail = lines(&["❯ Run it?", "1. Yes, allow once", "2. No, deny", "", ""]);
        let card = parse_prompt(&tail).expect("tail-end options parse");
        assert_eq!(card.title, "Run it");
    }

    #[test]
    fn numbered_block_with_confirm_hint_below_parses() {
        // Dialogs that print a confirm hint under the options.
        let tail = lines(&[
            "❯ Apply migration?",
            "1. yes, allow",
            "2. no, cancel",
            "press enter to confirm",
            "(applying soon)",
        ]);
        let card = parse_prompt(&tail).expect("confirm-hint options parse");
        assert_eq!(card.title, "Apply migration");
        assert_eq!(card.options.len(), 2);
    }

    // Parity cases pinned against the webui oracle (prompt_cards.js
    // run under node for the same tails). The exact outputs are the
    // contract; if either side changes, the card behavior diverges.
    #[test]
    fn parity_with_webui_oracle() {
        // Unnumbered option words do not parse: no numbered block.
        assert!(parse_prompt(&lines(&[
            "Do you want to run this command?",
            "Yes, allow once",
            "No, deny",
        ]))
        .is_none());
        assert!(parse_prompt(&lines(&[
            "Do you trust this folder?",
            "Yes, allow this session",
            "No, deny",
        ]))
        .is_none());
        // Nav dialog with ↑/↓ hint, > prefixed options.
        let card = parse_prompt(&lines(&[
            "❯ Approve deployment?",
            "↑/↓ to select",
            "> 1. Yes",
            "> 2. No",
            "esc dismiss",
        ]))
        .expect("nav dialog parses");
        assert_eq!(card.title, "Approve deployment");
        assert_eq!(card.options.len(), 2);
        assert_eq!(card.options[0].label, "Yes");
        // ? -prefixed question title.
        let card = parse_prompt(&lines(&["? pick one", "1. allow", "2. deny"]))
            .expect("permission dialog parses");
        assert_eq!(card.title, "pick one");
        // Plain options without permission words: no card.
        assert!(parse_prompt(&lines(&["plain", "1. first", "2. second"])).is_none());
        // > prefixed options with permission words: titled card.
        let card = parse_prompt(&lines(&[
            "run tests",
            "> 1. yes, allow once",
            "> 2. no, deny",
        ]))
        .expect("permission dialog parses");
        assert_eq!(card.title, "run tests");
        // No title line at all: fallback title.
        let card =
            parse_prompt(&lines(&["", "1. allow", "2. deny"])).expect("permission dialog parses");
        assert_eq!(card.title, "Confirm action");
    }

    #[test]
    fn exotic_unicode_whitespace_parses_like_plain_spaces() {
        // NBSP/NEL/U+3000/BOM inside the title and option rows must read
        // as plain spaces: JS `\s` and Rust `\s` disagree on BOM and
        // NEL, so both sides normalize before matching.
        let nbsp = "\u{a0}pick\u{a0}one\u{a0}";
        let card = parse_prompt(&lines(&[nbsp, "1.\u{85}allow", "2.\u{3000}deny"]))
            .expect("permission dialog parses");
        assert_eq!(card.title, "pick one");
        assert_eq!(card.options[0].label, "allow");
        assert_eq!(card.options[1].label, "deny");
        // A BOM before the title must not survive into the card title.
        let card = parse_prompt(&lines(&["\u{feff}ALLOW now?", "enter your response"]))
            .expect("free-text permission parses");
        assert_eq!(card.title, "ALLOW now");
        // LS/PS in a title row also collapse.
        let card = parse_prompt(&lines(&["allow\u{2028}it?", "enter your response"]))
            .expect("free-text parses");
        assert_eq!(card.title, "allow it");
    }

    #[test]
    fn prompt_marker_capture_that_trims_to_nothing_is_skipped() {
        // A marker line of only spaces ("❯   ": the lazy capture is a
        // bare space that trims to empty) falls through the prompt-marked
        // pass instead of producing an empty title; the title comes from
        // the next real line.
        let lines = lines(&["❯   ", "esc cancel", "1. Postgres", "2. MySQL"]);
        let card = parse_prompt(&lines).expect("dialog parses");
        // Every other line is noise (cancel hint, options): the empty
        // capture must not leak as the title, the dialog default applies.
        assert_eq!(
            card.title, "Select an option",
            "an empty capture never becomes the title; the default applies"
        );
    }
}
