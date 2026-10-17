//! Screen-scrape status detection for Qwen Code.

use crate::builtin_detection::scrape::{bottom_non_empty_lines, contains_any};

/// Screen-scrape detection for Qwen Code.
///
/// Qwen Code keeps its composer visible while responding, so the prompt box
/// is not idle evidence by itself. The screen fallbacks cover built-in
/// locales and narrow terminals. This mirrors the upstream herdr
/// `qwen.toml` detection manifest.
pub(crate) fn detect_qwen_status(lower: &str) -> &'static str {
    let bottom20 = bottom_non_empty_lines(lower, 20);
    let bottom8 = bottom_non_empty_lines(lower, 8);

    // Blocked: tool confirmation dialog with "yes, allow once".
    if lower.contains("yes, allow once")
        && contains_any(
            lower,
            &[
                "apply this change?",
                "allow execution of:",
                "allow execution of mcp tool",
                "do you want to proceed?",
                "shell command execution",
            ],
        )
    {
        return "blocked";
    }

    // Blocked: "waiting for user confirmation" spinner line, locale-aware.
    // Mirrors qwen.toml waiting_for_confirmation:
    //   line_regex: ^\s*⠏\s+.*\.\.\.\s*$
    //   any: 9 locale-specific "Waiting for user confirmation..." strings
    if bottom20.lines().any(|line| {
        let line = line.trim_start();
        // Must start with ⠏ followed by whitespace
        if !line.starts_with('⠏') {
            return false;
        }
        let rest = &line['⠏'.len_utf8()..];
        if !rest.starts_with(char::is_whitespace) {
            return false;
        }
        // Must end with "..." (possibly trailing whitespace)
        let trimmed_end = line.trim_end();
        if !trimmed_end.ends_with("...") {
            return false;
        }
        // Must contain one of the locale-specific confirmation messages
        contains_any(
            line,
            &[
                "waiting for user confirmation...",
                "等待用户确认...",
                "等待用戶確認...",
                "warten auf benutzerbestätigung...",
                "en attente de la confirmation de l'utilisateur...",
                "ユーザーの確認を待っています...",
                "aguardando confirmação do usuário...",
                "ожидание подтверждения от пользователя...",
                "esperant la confirmació de l'usuari...",
            ],
        )
    }) {
        return "blocked";
    }

    // Blocked: question dialog with numbered options or arrow navigation.
    // Mirrors qwen.toml question_dialog line_regex patterns:
    //   ^\s*[❯›]\s*(?:\[(?: |✓)\]\s*)?\d+\.\s+
    //   ^\s*↑/↓\s*:.*(?:Enter|Return)\s*:
    if bottom20.lines().any(|line| {
        let line = line.trim_start();
        let mut chars = line.chars().peekable();
        // Must start with ❯ or ›
        if !matches!(chars.next(), Some('❯') | Some('›')) {
            return false;
        }
        // Skip whitespace after marker
        while matches!(chars.peek(), Some(c) if c.is_whitespace()) {
            chars.next();
        }
        // Optional [ ] or [✓] marker
        if chars.peek() == Some(&'[') {
            chars.next();
            match chars.peek() {
                Some(' ') | Some('✓') => {
                    chars.next();
                    if chars.peek() == Some(&']') {
                        chars.next();
                    }
                    while matches!(chars.peek(), Some(c) if c.is_whitespace()) {
                        chars.next();
                    }
                }
                _ => return false,
            }
        }
        // Must be followed by a number and ". "
        let mut num = String::new();
        while matches!(chars.peek(), Some(c) if c.is_ascii_digit()) {
            num.push(chars.next().unwrap());
        }
        !num.is_empty() && chars.peek() == Some(&'.')
    }) || bottom20.lines().any(|line| {
        let line = line.trim_start();
        // Must start with ↑/↓ then : and contain Enter or Return followed by :
        if !line.starts_with("↑/↓") {
            return false;
        }
        let rest = &line["↑/↓".len()..];
        rest.contains(':') && (rest.contains("enter") || rest.contains("return"))
    }) {
        return "blocked";
    }

    // Blocked: folder trust dialog.
    if lower.contains("do you trust this folder?")
        && lower.contains("trust folder (")
        && lower.contains("don't trust (esc)")
    {
        return "blocked";
    }

    // Working: cancel hint with elapsed time ("esc to cancel").
    if bottom8.lines().any(|line| {
        let line = line.trim_start();
        // Mirrors qwen.toml cancel_hint_working:
        // ^\s*(?:[⠁-⣿]|\.{1,2})\s+.*\(\d+(?:m(?:\s+\d+s)?|s).*\s·\sesc to cancel\)\s*$
        // Braille (U+2801-U+28FF, excluding blank U+2800) or 1-2 dots,
        // then whitespace, text, time pattern, and " · esc to cancel)" at end.
        let first = line.chars().next();
        let is_braille = matches!(first, Some(c) if ('\u{2801}'..='\u{28ff}').contains(&c));
        let is_two_dots = line.starts_with("..");
        let is_one_dot = !is_two_dots && line.starts_with('.');
        if !(is_braille || is_two_dots || is_one_dot) {
            return false;
        }
        // Skip the spinner/dots using char-aware slicing
        let rest = if is_two_dots {
            &line[2..]
        } else if is_one_dot {
            &line[1..]
        } else {
            // Braille: skip first char (3 bytes)
            &line[first.map(|c| c.len_utf8()).unwrap_or(0)..]
        };
        // Must have whitespace after spinner
        if !rest.starts_with(char::is_whitespace) {
            return false;
        }
        // Must contain "(Nm" or "(Ns" time pattern and " · esc to cancel)"
        line.contains("esc to cancel)")
            && line.contains("·")
            && line.contains(|c: char| c.is_ascii_digit())
    }) {
        return "working";
    }

    // Working: narrow terminal cancel hint without spinner.
    // Mirrors qwen.toml narrow_cancel_hint_working:
    // ^\s*\(\d+(?:m(?:\s+\d+s)?|s)\s·\sesc to cancel\)\s*$
    if bottom8.lines().any(|line| {
        let trimmed = line.trim();
        // Must start with ( and end with )
        if !trimmed.starts_with('(') || !trimmed.ends_with(')') {
            return false;
        }
        // Strip outer parens
        let inner = &trimmed[1..trimmed.len() - 1];
        // Must contain " · esc to cancel" suffix
        if !inner.ends_with(" · esc to cancel") {
            return false;
        }
        // The part before " · " must be a time like "3m 12s" or "45s"
        let time_part = &inner[..inner.len() - " · esc to cancel".len()];
        // Must start with a digit
        time_part.starts_with(|c: char| c.is_ascii_digit())
    }) {
        return "working";
    }

    // Idle: composer prompt box with "> type your message" or "@path/to/file".
    // Mirrors qwen.toml composer_idle: line starts with ">", contains any of
    // the known message strings, or fragmented localized match.
    if bottom_non_empty_lines(lower, 30).lines().any(|line| {
        let line = line.trim_start();
        if !line.starts_with('>') {
            return false;
        }
        // English prompts
        line.contains("type your message")
            || line.contains("your message or @path/to/file")
            || line.contains("@path/to/file")
            // Fragmented localized match: all of these substrings present
            || (line.contains("type")
                && line.contains("mes")
                && line.contains("sage")
                && line.contains("@pat")
                && line.contains("h/to")
                && line.contains("/fil"))
    }) {
        return "idle";
    }

    "unknown"
}
