//! Prompt cards for blocked agents (ux overhaul 3/3, TUI port).
//!
//! When the selected pane's agent is blocked on a question dialog, the
//! card renders the question title plus selectable options (or a
//! free-text input) parsed from the pane tail — the same source the
//! chat lens reads. Protocol 22 is frozen, so there is no structured
//! prompt payload: the shapes match the dialogs the backend's blocked
//! detectors already recognize (numbered option lists, ↑↓ select
//! hints, "enter your response" free-text prompts).
//!
//! Answering is hybrid (user decision on the port):
//! - Numbered options always synthesize raw keystrokes through the
//!   terminal input path (`N\r`) — the webui semantics. The composer
//!   submit route is NOT used: `agent_prompt` refuses blocked panes by
//!   design, and an option answer must land in the dialog.
//! - Free text picks the transport by the pane's live status: an
//!   unblocked pane routes through the composer submit (a plain
//!   message to the agent), a blocked pane types the text + Enter
//!   into the dialog via raw input, like the webui.
//!
//! The card is derived state only: every refresh re-evaluates the parse
//! against the CURRENT tail before sending, so a stale card can never
//! send stale input.

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
    let joined = lines.join("\n");
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
    // Numbered confirmation without nav hint (permission dialogs).
    if options.len() >= 2 && PERMISSION_WORDS.is_match(&joined) {
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

/// Live state of the prompt-card overlay. Owned by `TuiApp`; the render
/// reads it, the refresh cycle re-evaluates it against the current
/// tail, and answer/dismiss keys update it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PromptCardState {
    /// Question (title + option keys) the user dismissed or answered.
    dismissed_for: Option<String>,
    /// Signature of the last rendered card (title|keys@tail-suffix), to
    /// re-render only on change.
    last_card_key: String,
    /// Blocked-episode tracking: false until the first blocked
    /// observation; a fresh transition INTO blocked clears the
    /// dismissal so a new question re-opens the card.
    was_blocked: bool,
    /// The most recent parsed card, kept for the answer path's
    /// stale-send guard.
    current: Option<PromptCard>,
    /// Whether the card is visible (parsed, not dismissed).
    pub visible: bool,
}

impl PromptCardState {
    /// Stable identity of a question: title + option keys. Two cards
    /// with the same identity are the same question.
    pub fn card_identity(card: &PromptCard) -> String {
        let keys = card
            .options
            .iter()
            .map(|option| option.key.as_str())
            .collect::<Vec<_>>()
            .join(",");
        format!("{}|{}", card.title, keys)
    }

    /// Re-evaluate the card against the pane status and tail (webui
    /// `evaluate`). Called on every refresh tick and status change:
    /// the card is derived state, never stale.
    pub fn evaluate(&mut self, blocked: bool, lines: &[String]) -> Option<&PromptCard> {
        // Blocked-episode tracking: a fresh transition INTO blocked
        // means a new question (even with identical text) — clear any
        // dismissal so the card re-opens. Within one episode,
        // dismissal sticks.
        if blocked && !self.was_blocked {
            self.dismissed_for = None;
            self.last_card_key = String::new();
        }
        self.was_blocked = blocked;
        let prompt = if blocked { parse_prompt(lines) } else { None };
        let Some(prompt) = prompt else {
            self.visible = false;
            self.last_card_key = String::new();
            self.current = None;
            return None;
        };
        // Dismissed: the user collapsed THIS question; keep it collapsed
        // until the question (title+options) changes.
        let identity = Self::card_identity(&prompt);
        if self.dismissed_for.as_deref() == Some(identity.as_str()) {
            self.visible = false;
            self.current = Some(prompt);
            return None;
        }
        // Tail signature: the joined tail's trailing characters, so a
        // dialog repaint with the same question but fresher context
        // still re-renders (webui keeps the same 120-char slice).
        let tail_signature: String = lines
            .join("§")
            .chars()
            .rev()
            .take(120)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let key = format!("{}@{}", identity, tail_signature);
        self.last_card_key = key;
        self.visible = true;
        self.current = Some(prompt);
        self.current.as_ref()
    }

    /// The current card, regardless of visibility (answer path guard).
    pub fn current_card(&self) -> Option<&PromptCard> {
        self.current.as_ref()
    }

    /// Dismiss the current question (Esc): collapses the card until the
    /// question changes.
    pub fn dismiss(&mut self) {
        if let Some(card) = self.current.take() {
            self.dismissed_for = Some(Self::card_identity(&card));
        }
        self.visible = false;
    }

    /// Guard for the blocked answer path: re-parse the CURRENT tail
    /// and make sure the dialog is still the one the card rendered
    /// (webui `answer` stale-send guard). Returns the fresh card when
    /// it matches, None when the dialog moved on. Status is NOT part
    /// of the guard: the hybrid transport routes by status before
    /// this runs, and the raw path only fires for a blocked pane
    /// anyway.
    pub fn stale_guard(&self, lines: &[String]) -> Option<PromptCard> {
        let fresh = parse_prompt(lines)?;
        let current = self.current_card()?;
        (fresh.title == current.title).then_some(fresh)
    }

    /// Mark the question answered: the card collapses while the same
    /// dialog text is still on screen (real TUIs repaint it away; a
    // plain shell keeps the text).
    pub fn mark_answered(&mut self) {
        if let Some(card) = self.current.take() {
            self.dismissed_for = Some(Self::card_identity(&card));
        }
        self.visible = false;
        self.last_card_key = String::new();
    }
}

/// The payload a free-text answer sends, by pane status (hybrid
/// decision): raw typed text + Enter for a blocked dialog, composer
/// submit semantics for an unblocked pane.
pub fn free_text_via_composer(blocked: bool) -> bool {
    !blocked
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
    fn parse_rejects_single_option_without_permission_words() {
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
    fn state_opens_on_blocked_and_hides_when_unblocked() {
        let mut state = PromptCardState::default();
        let tail = lines(&["❯ Run it?", "1. Yes, allow once", "2. No, deny"]);
        assert!(state.evaluate(true, &tail).is_some());
        assert!(state.visible);
        assert!(state.evaluate(false, &tail).is_none());
        assert!(!state.visible);
    }

    #[test]
    fn dismissal_sticks_within_episode() {
        let mut state = PromptCardState::default();
        let tail = lines(&["❯ Run it?", "1. Yes, allow once", "2. No, deny"]);
        state.evaluate(true, &tail);
        state.dismiss();
        assert!(!state.visible);
        assert!(
            state.evaluate(true, &tail).is_none(),
            "same question stays collapsed"
        );
        // Fresh blocked episode re-opens even the identical question.
        assert!(state.evaluate(false, &tail).is_none());
        assert!(state.evaluate(true, &tail).is_some(), "new episode re-arms");
        assert!(state.visible);
    }

    #[test]
    fn stale_guard_blocks_answered_dialog_change() {
        let mut state = PromptCardState::default();
        let tail = lines(&["❯ Run it?", "1. Yes, allow once", "2. No, deny"]);
        state.evaluate(true, &tail);
        let other = lines(&["❯ Other question?", "1. Yes, allow once", "2. No, deny"]);
        assert!(state.stale_guard(&other).is_none());
        let fresh = state.stale_guard(&tail).expect("same dialog passes");
        assert_eq!(fresh.title, "Run it");
        // A tail that no longer parses is stale (dialog scrolled away).
        assert!(state.stale_guard(&lines(&["plain shell output"])).is_none());
    }

    #[test]
    fn answered_card_collapses_until_question_changes() {
        let mut state = PromptCardState::default();
        let tail = lines(&["❯ Run it?", "1. Yes, allow once", "2. No, deny"]);
        state.evaluate(true, &tail);
        state.mark_answered();
        assert!(!state.visible);
        assert!(
            state.evaluate(true, &tail).is_none(),
            "same dialog stays collapsed"
        );
        let changed = lines(&["❯ Another one?", "1. Yes, allow once", "2. No, deny"]);
        assert!(
            state.evaluate(true, &changed).is_some(),
            "new question re-opens"
        );
    }

    #[test]
    fn free_text_transport_follows_status() {
        assert!(
            free_text_via_composer(false),
            "unblocked -> composer submit"
        );
        assert!(!free_text_via_composer(true), "blocked -> raw keystrokes");
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
}
