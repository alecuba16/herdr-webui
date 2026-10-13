//! Shared `git blame --line-porcelain` parser. Lives in the lib crate so
//! the TUI (`tui::panels::git::parse`) and the WebUI binary's
//! `/api/git-ui/blame` route parse identically.

use std::collections::HashMap;

/// Parse `git blame --line-porcelain` output into final-line → author,
/// mirroring the webui `parseBlame`: each header line
/// `<sha> <orig> <final> [<num>]` sets the current line, the following
/// `author <name>` fills it.
pub fn parse_blame_authors(text: &str) -> HashMap<usize, String> {
    let mut by_line = HashMap::new();
    let mut final_line = 0usize;
    for line in text.lines() {
        // Header shape (webui regex `^[0-9a-f]{40}\s+\d+\s+(\d+)`):
        // exactly 40 hex chars, then orig and final line numbers. The
        // check is byte-based via as_bytes so multibyte content lines
        // can never panic a slice at a non-char boundary.
        let is_header = line.len() > 41
            && line.as_bytes()[..40].iter().all(u8::is_ascii_hexdigit)
            && line.as_bytes()[40] == b' ';
        if is_header {
            let nums = line[41..].split_whitespace().collect::<Vec<_>>();
            if nums.len() >= 2 && nums[0].chars().all(|ch| ch.is_ascii_digit()) {
                let final_num = nums[1]
                    .split(|ch: char| !ch.is_ascii_digit())
                    .next()
                    .unwrap_or("");
                if !final_num.is_empty() {
                    final_line = final_num.parse().unwrap_or(0);
                    continue;
                }
            }
        }
        if let Some(name) = line.strip_prefix("author ") {
            if final_line > 0 {
                by_line.insert(final_line, name.trim().to_string());
            }
        }
    }
    by_line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_line_porcelain_authors_by_final_line() {
        let text = "0000000000000000000000000000000000000000 2 1 1\n\
                    author Alice Example\n\
                    author-mail <alice@example.com>\n\
                    summary first\n\
                    filename src/a.rs\n\
                    1111111111111111111111111111111111111111 3 2 2\n\
                    author Bob Other\n\
                    author-mail <bob@example.com>\n\
                    summary second\n\
                    filename src/a.rs\n";
        let authors = parse_blame_authors(text);
        assert_eq!(authors.get(&1).map(String::as_str), Some("Alice Example"));
        assert_eq!(authors.get(&2).map(String::as_str), Some("Bob Other"));
    }

    #[test]
    fn ignores_author_lines_without_a_header() {
        // Content lines can also start with "author "; only the header's
        // current line may be filled.
        let text = "author stray\n";
        assert!(parse_blame_authors(text).is_empty());
    }
}
