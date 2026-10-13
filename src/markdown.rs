//! Markdown helpers shared by the TUI and the web API. Kept dependency-free:
/// Markdown header outline: every ATX heading (`#`…`######`) as
/// `(level, line_number, text)`, indented by level when rendered.
/// Fenced code blocks are skipped so `#` inside them is not a heading.
pub fn parse_markdown_outline(content: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut in_fence = false;
    for (index, line) in content.lines().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~") {
            in_fence = !in_fence;
            continue;
        }
        if in_fence {
            continue;
        }
        let Some(after) = trimmed.strip_prefix('#') else {
            continue;
        };
        let level = after.len() - after.trim_start_matches('#').len() + 1;
        if level > 6 {
            continue;
        }
        let text = after.trim_start_matches('#').trim();
        if text.is_empty() && level > 1 {
            continue;
        }
        out.push((level, index + 1, text.to_string()));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::parse_markdown_outline;

    #[test]
    fn outline_extracts_headings_and_skips_fences() {
        let content = "# Title\n\ntext\n```rust\n# not a heading\n```\n## Sub\n###### Deep\n####### Too deep\n#";
        let outline = parse_markdown_outline(content);
        assert_eq!(
            outline,
            vec![
                (1, 1, "Title".to_string()),
                (2, 7, "Sub".to_string()),
                (6, 8, "Deep".to_string()),
                (1, 10, "".to_string()),
            ]
        );
    }

    #[test]
    fn outline_is_empty_without_headings() {
        assert!(parse_markdown_outline("plain text only").is_empty());
    }
}
