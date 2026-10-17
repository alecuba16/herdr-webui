//! Shared text-scrape primitives for the per-agent detection modules.
//!
//! These helpers used to live inline in `builtin_backend.rs`; they now back
//! every `builtin_detection::<agent>` module. Keep them free of agent-specific
//! logic so they stay useful across agents.

/// True if any trimmed line starts with a Braille pattern char followed by
/// whitespace (the common `⠋ working` spinner shape).
pub(crate) fn has_braille_spinner_line(text: &str) -> bool {
    text.lines().any(|line| {
        let mut chars = line.trim_start().chars();
        matches!(chars.next(), Some(first) if is_braille(first))
            && matches!(chars.next(), Some(second) if second.is_whitespace())
    })
}

/// True if any trimmed line starts with Braille and contains a word ending
/// in `ing` (for example `⠙ thinking`).
pub(crate) fn has_braille_ing_line(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim_start();
        starts_with_braille(line) && line.split_whitespace().any(|word| word.ends_with("ing"))
    })
}

pub(crate) fn starts_with_braille(text: &str) -> bool {
    text.chars().next().is_some_and(is_braille)
}

/// Returns true if the text contains any Braille pattern character (U+2800-U+28FF).
pub(crate) fn contains_braille(text: &str) -> bool {
    text.contains(is_braille)
}

pub(crate) fn is_braille(ch: char) -> bool {
    ('\u{2800}'..='\u{28ff}').contains(&ch)
}

pub(crate) fn bottom_non_empty_lines(text: &str, count: usize) -> String {
    let mut lines = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .rev()
        .take(count)
        .map(str::to_string)
        .collect::<Vec<_>>();
    lines.reverse();
    lines.join("\n")
}

/// First `count` non-empty lines (trimmed). Mirrors `bottom_non_empty_lines`
/// but from the top of the text. Used by manifest rules with
/// `region = "top_non_empty_lines(N)"`.
pub(crate) fn top_non_empty_lines(text: &str, count: usize) -> String {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .take(count)
        .map(str::to_string)
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}
