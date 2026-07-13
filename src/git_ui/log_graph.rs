use serde_json::{json, Value};

pub(super) const LOG_FORMAT: &str = "%H%x00%an%x00%ar%x00%D%x00%s";

pub(super) fn reconstruct_log_line(line: &str) -> String {
    match parse_log_row(line) {
        Some(row) if !row.hash.is_empty() => {
            format!("{}{} {}", row.graph, short_hash(&row.hash), row.title)
        }
        Some(row) => row.graph,
        None => line.to_owned(),
    }
}

pub(super) fn parse_log_row_json(line: &str) -> Option<Value> {
    let row = parse_log_row(line)?;
    Some(json!({
        "graph": row.graph,
        "hash": row.hash,
        "author": row.author,
        "date": row.date,
        "title": row.title,
        "labels": row.labels,
        "lane": row.lane,
        "current": row.current,
    }))
}

#[derive(Debug, PartialEq, Eq)]
struct LogRow {
    graph: String,
    hash: String,
    author: String,
    date: String,
    title: String,
    labels: Vec<String>,
    lane: usize,
    current: bool,
}

fn parse_log_row(line: &str) -> Option<LogRow> {
    let raw = line.trim_end();
    if raw.trim().is_empty() {
        return None;
    }
    let Some(start) = raw.find(|c: char| c.is_ascii_hexdigit()) else {
        return graph_only_row(raw);
    };
    let end = raw[start..]
        .find(|c: char| !c.is_ascii_hexdigit())
        .map(|offset| start + offset)
        .unwrap_or(raw.len());
    if end - start < 7 {
        return graph_only_row(raw);
    }

    let graph = raw[..start].to_string();
    let hash = raw[start..end].to_string();
    let parts: Vec<&str> = raw[end..].split('\0').collect();
    let author = parts.get(1).map(|s| s.trim()).unwrap_or("").to_string();
    let date = parts.get(2).map(|s| s.trim()).unwrap_or("").to_string();
    let labels = split_decorations(parts.get(3).copied().unwrap_or(""));
    let title = parts.get(4).map(|s| s.trim()).unwrap_or("").to_string();
    let current = labels
        .iter()
        .any(|label| label == "HEAD" || label.starts_with("HEAD -> "));
    let lane = graph_lane(&graph);
    Some(LogRow {
        graph,
        hash,
        author,
        date,
        title,
        labels,
        lane,
        current,
    })
}

fn graph_only_row(raw: &str) -> Option<LogRow> {
    let trimmed = raw.trim();
    if !trimmed.chars().all(is_graph_char) {
        return None;
    }
    Some(LogRow {
        graph: raw.to_string(),
        hash: String::new(),
        author: String::new(),
        date: String::new(),
        title: String::new(),
        labels: Vec::new(),
        lane: graph_lane(raw),
        current: false,
    })
}

fn is_graph_char(c: char) -> bool {
    matches!(c, '|' | '\\' | '/' | '*' | ' ' | '_' | '-' | '.')
}

fn graph_lane(graph: &str) -> usize {
    graph
        .chars()
        .position(|c| c == '*')
        .unwrap_or_else(|| graph.chars().position(|c| c == '|').unwrap_or(0))
}

fn split_decorations(value: &str) -> Vec<String> {
    value
        .trim()
        .trim_start_matches('(')
        .trim_end_matches(')')
        .split(',')
        .map(normalize_label)
        .filter(|label| !label.is_empty())
        .collect()
}

fn normalize_label(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("refs/heads/")
        .trim_start_matches("refs/remotes/")
        .to_string()
}

fn short_hash(hash: &str) -> &str {
    &hash[..8.min(hash.len())]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commit_row_with_refs_date_author_and_lane() {
        let row = parse_log_row(
            "| * abcdef123456\0Alice\02 hours ago\0HEAD -> feature, tag: v1\0Add graph view",
        )
        .unwrap();
        assert_eq!(row.graph, "| * ");
        assert_eq!(row.hash, "abcdef123456");
        assert_eq!(row.author, "Alice");
        assert_eq!(row.date, "2 hours ago");
        assert_eq!(row.title, "Add graph view");
        assert_eq!(row.labels, vec!["HEAD -> feature", "tag: v1"]);
        assert_eq!(row.lane, 2);
        assert!(row.current);
    }

    #[test]
    fn parses_graph_only_rows_and_reconstructs_legacy_line() {
        let row = parse_log_row("|/  ").unwrap();
        assert_eq!(row.graph, "|/");
        assert!(row.hash.is_empty());
        assert_eq!(
            reconstruct_log_line("* abcdef123456\0Bob\0yesterday\0origin/main\0Fix bug"),
            "* abcdef12 Fix bug"
        );
    }
}
