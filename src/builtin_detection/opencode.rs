//! Screen-scrape status detection for OpenCode.

use crate::builtin_detection::scrape::contains_any;

pub(crate) fn detect_opencode_like_status(lower: &str) -> Option<&'static str> {
    if lower.contains("△ permission required")
        || (lower.contains("esc dismiss")
            && contains_any(lower, &["enter confirm", "enter submit", "enter toggle"])
            && contains_any(lower, &["↑↓ select", "⇆ tab"]))
    {
        return Some("blocked");
    }
    None
}

pub(crate) fn detect_opencode_status(lower: &str) -> &'static str {
    if let Some(status) = detect_opencode_like_status(lower) {
        return status;
    }
    if contains_any(
        lower,
        &[
            "esc to interrupt",
            "ctrl+c to interrupt",
            "press esc to interrupt",
        ],
    ) || lower.lines().any(has_opencode_interrupt_line)
        || has_opencode_progress(lower)
    {
        return "working";
    }
    "unknown"
}

pub(crate) fn has_opencode_interrupt_line(line: &str) -> bool {
    let Some(opencode_index) = line.find("opencode") else {
        return false;
    };
    let mut rest = &line[opencode_index + "opencode".len()..];
    while let Some(index) = rest.find("esc ") {
        let after_esc = &rest[index + "esc ".len()..];
        if after_esc.starts_with("interrupt") || after_esc.starts_with("again to interrupt") {
            return true;
        }
        rest = &rest[index + "esc".len()..];
    }
    false
}

pub(crate) fn has_opencode_progress(text: &str) -> bool {
    text.lines().any(|line| {
        let mut run = 0_usize;
        for ch in line.chars() {
            if ch == '■' || ch == '⬝' {
                run += 1;
                if run >= 4 {
                    return true;
                }
            } else {
                run = 0;
            }
        }
        false
    })
}
