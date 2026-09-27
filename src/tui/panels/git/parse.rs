//! Parsers for `/api/git-ui/*` JSON responses.

use serde_json::Value;
use std::collections::HashMap;

use crate::tui::model::value_str;

use super::{GitBranchEntry, GitCommitEntry, GitFileEntry, GitFileStatus, GitStashEntry};

/// Git line numbers for one parsed diff line, used to attach blame
/// authors (`new_line_number || old_line_number`, mirroring the webui).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GitDiffLineMeta {
    pub old_line: Option<usize>,
    pub new_line: Option<usize>,
}

/// Parse `git blame --line-porcelain` output into final-line → author,
/// mirroring the webui `parseBlame`: each header line
/// `<sha> <orig> <final> [<num>]` sets the current line, the following
/// `author <name>` fills it.
pub(crate) fn parse_blame_authors(text: &str) -> HashMap<usize, String> {
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

/// Parse the `/api/git-ui/diff` response (`files[].chunks[].lines[]`
/// with `line_type`/`content`) into display lines plus line-number
/// metadata parallel to them (`None` for chunk headers). Chunk headers
/// keep their `@@` prefix so the renderer colors them teal.
pub(crate) fn parse_diff_lines_with_meta(
    data: &Value,
) -> (Vec<String>, Vec<Option<GitDiffLineMeta>>) {
    let mut out = Vec::new();
    let mut meta = Vec::new();
    let Some(files) = data.get("files").and_then(Value::as_array) else {
        return (out, meta);
    };
    for git_file in files {
        let Some(chunks) = git_file.get("chunks").and_then(Value::as_array) else {
            continue;
        };
        for chunk in chunks {
            if let Some(header) = chunk.get("header").and_then(Value::as_str) {
                out.push(header.to_string());
                meta.push(None);
            }
            if let Some(lines) = chunk.get("lines").and_then(Value::as_array) {
                for line in lines {
                    let kind = line
                        .get("line_type")
                        .and_then(Value::as_str)
                        .unwrap_or("normal");
                    let content = line
                        .get("content")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let prefix = match kind {
                        "add" => '+',
                        "delete" => '-',
                        _ => ' ',
                    };
                    out.push(format!("{prefix}{content}"));
                    meta.push(Some(GitDiffLineMeta {
                        old_line: line
                            .get("old_line_number")
                            .and_then(Value::as_u64)
                            .map(|v| v as usize),
                        new_line: line
                            .get("new_line_number")
                            .and_then(Value::as_u64)
                            .map(|v| v as usize),
                    }));
                }
            }
        }
    }
    (out, meta)
}

pub(crate) fn parse_git_files(data: &Value) -> Vec<GitFileEntry> {
    let mut files = Vec::new();
    let mut push = |list: &[Value], status: GitFileStatus| {
        for value in list {
            if let Some(path) = value.as_str() {
                files.push(GitFileEntry {
                    path: path.to_string(),
                    status: status.clone(),
                });
            }
        }
    };
    if let Some(list) = data.get("conflicted").and_then(Value::as_array) {
        push(list, GitFileStatus::Conflicted);
    }
    if let Some(list) = data.get("staged").and_then(Value::as_array) {
        push(list, GitFileStatus::Staged);
    }
    if let Some(list) = data.get("unstaged").and_then(Value::as_array) {
        push(list, GitFileStatus::Unstaged);
    }
    if let Some(list) = data.get("untracked").and_then(Value::as_array) {
        push(list, GitFileStatus::Untracked);
    }
    files
}

pub(crate) fn parse_commit(value: &Value) -> GitCommitEntry {
    GitCommitEntry {
        hash: value_str(value, &["hash"]).unwrap_or_default().to_string(),
        message: value_str(value, &["message"])
            .unwrap_or_default()
            .to_string(),
        author: value_str(value, &["author"])
            .unwrap_or_default()
            .to_string(),
        date: value_str(value, &["date"]).unwrap_or_default().to_string(),
        labels: value
            .get("labels")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    }
}

pub(crate) fn parse_branch(value: &Value) -> GitBranchEntry {
    GitBranchEntry {
        name: value_str(value, &["name"]).unwrap_or_default().to_string(),
        current: value
            .get("current")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        remote: value
            .get("remote")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        pushed: value
            .get("pushed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    }
}

pub(crate) fn parse_stash(value: &Value) -> GitStashEntry {
    GitStashEntry {
        name: value_str(value, &["name", "stash"])
            .unwrap_or_default()
            .to_string(),
        message: value_str(value, &["message", "subject"])
            .unwrap_or_default()
            .to_string(),
    }
}
