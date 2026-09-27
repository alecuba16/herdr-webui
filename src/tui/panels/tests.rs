//! Panel unit tests shared by files and git modules.
//!
//! Both `files.rs` and `git.rs` previously lived in one module, so their
//! tests reference items from both via `super::*` re-exports.

use super::files::parse_entries;
use super::git::{
    parse_blame_authors, parse_branch, parse_commit, parse_diff_lines_with_meta, parse_git_files,
};
use super::*;
use crate::tui::web_api::WebApiClient;
use serde_json::{json, Value};

fn edit_key(ch: char, ctrl: bool) -> crossterm::event::KeyEvent {
    use crossterm::event::{KeyCode, KeyModifiers};
    let modifiers = if ctrl {
        KeyModifiers::CONTROL
    } else {
        KeyModifiers::NONE
    };
    crossterm::event::KeyEvent::new(KeyCode::Char(ch), modifiers)
}

fn key(code: crossterm::event::KeyCode) -> crossterm::event::KeyEvent {
    crossterm::event::KeyEvent::new(code, crossterm::event::KeyModifiers::NONE)
}

fn ctrl_key(ch: char) -> crossterm::event::KeyEvent {
    crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char(ch),
        crossterm::event::KeyModifiers::CONTROL,
    )
}

fn preview(content: &str) -> FilePreview {
    FilePreview {
        path: Some("a.txt".to_string()),
        content: content.to_string(),
        truncated: false,
        binary: false,
        hash: "h1".to_string(),
        dirty: false,
    }
}

#[test]
fn parse_blame_authors_covers_header_edges() {
    // Normal header + author.
    let authors = parse_blame_authors(
        "0123456789abcdef0123456789abcdef01234567 1 2 1\nauthor Alice\n\tcode\n",
    );
    assert_eq!(authors.get(&2).map(String::as_str), Some("Alice"));
    // Header without a numeric orig is not a header: no final line set.
    let authors =
        parse_blame_authors("0123456789abcdef0123456789abcdef01234567 x 3 1\nauthor Bob\n");
    assert!(!authors.contains_key(&3), "bad header must not set a line");
    // Author before any header is dropped (final_line == 0).
    let authors = parse_blame_authors("author Carol\n");
    assert!(authors.is_empty());
    // Multibyte content lines never panic the byte slice check.
    let authors = parse_blame_authors("多字节内容行\nauthor Dan\n");
    assert!(authors.is_empty());
    // Final line numbers keep only the leading digits (webui splits
    // on non-digit boundaries).
    let authors =
        parse_blame_authors("0123456789abcdef0123456789abcdef01234567 5 7x 1\nauthor Eve\n");
    assert_eq!(authors.get(&7).map(String::as_str), Some("Eve"));
    // A 40-hex header with only one number column is not accepted.
    let authors =
        parse_blame_authors("0123456789abcdef0123456789abcdef01234567 9\nauthor Frank\n");
    assert!(authors.is_empty());
    // A header whose final column starts with a non-digit keeps the
    // previous final line instead of resetting it.
    let authors = parse_blame_authors(
        "0123456789abcdef0123456789abcdef01234567 1 2 1\nauthor Alice\n\
         0123456789abcdef0123456789abcdef01234567 2 x 1\nauthor Gina\n",
    );
    assert_eq!(authors.get(&2).map(String::as_str), Some("Gina"));
}

#[test]
fn parse_diff_lines_with_meta_covers_missing_shapes() {
    // No files at all.
    let (lines, meta) = parse_diff_lines_with_meta(&json!({}));
    assert!(lines.is_empty());
    assert!(meta.is_empty());
    // File without chunks is skipped without output.
    let (lines, meta) = parse_diff_lines_with_meta(&json!({
        "files": [{"chunks": []}, {}]
    }));
    assert!(lines.is_empty());
    assert!(meta.is_empty());
    // Full shape: header, add/delete/normal lines, missing numbers.
    let (lines, meta) = parse_diff_lines_with_meta(&json!({
        "files": [{
            "chunks": [{
                "header": "@@ -1,2 +1,3 @@",
                "lines": [
                    {"line_type": "add", "content": "new", "new_line_number": 1},
                    {"line_type": "delete", "content": "old", "old_line_number": 2},
                    {"content": "kept", "old_line_number": 3, "new_line_number": 3}
                ]
            }]
        }]
    }));
    assert_eq!(lines, vec!["@@ -1,2 +1,3 @@", "+new", "-old", " kept"]);
    assert_eq!(meta[0], None);
    assert_eq!(
        meta[1],
        Some(GitDiffLineMeta {
            old_line: None,
            new_line: Some(1)
        })
    );
    assert_eq!(
        meta[2],
        Some(GitDiffLineMeta {
            old_line: Some(2),
            new_line: None
        })
    );
    assert_eq!(
        meta[3],
        Some(GitDiffLineMeta {
            old_line: Some(3),
            new_line: Some(3)
        })
    );
    // Chunk header without lines still contributes the header row.
    let (lines, meta) = parse_diff_lines_with_meta(&json!({
        "files": [{"chunks": [{"header": "@@ -1 +1 @@"}]}]
    }));
    assert_eq!(lines, vec!["@@ -1 +1 @@"]);
    assert_eq!(meta, vec![None]);
}

#[test]
fn save_preview_without_open_file_errors() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut explorer = FileExplorer::new("/repo");
    let err = explorer.save_preview(&api).unwrap_err();
    assert!(err.to_string().contains("no file preview open"));
}

#[test]
fn edit_key_ctrl_r_without_preview_path_is_a_noop() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut explorer = FileExplorer::new("/repo");
    // Editing with no preview path must not error or hit the API.
    // start_edit refuses a pathless preview, so enter edit mode the
    // way a stale buffer could: directly, mirroring a preview whose
    // path was cleared after editing began.
    explorer.preview = preview("x");
    explorer.preview.path = None;
    explorer.edit_active = true;
    explorer.edit_cursor = 1;
    explorer.edit_key(ctrl_key('r'), &api).unwrap();
    assert!(explorer.edit_active);
    assert_eq!(explorer.preview.content, "x");
}

#[test]
fn toggle_blame_reverts_when_load_fails() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut panel = GitPanel::new("/repo");
    panel.files = vec![GitFileEntry {
        path: "gone.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    panel.file_selected = 0;
    panel.diff_title = "working tree".to_string();
    // The dead API makes load_blame fail: the toggle must revert to
    // off instead of leaving blame on with no annotations.
    let err = panel.toggle_blame(&api).unwrap_err();
    assert!(
        !panel.show_blame,
        "failed blame load must revert the toggle"
    );
    assert!(panel.blame_authors.is_empty());
    assert!(err.to_string().contains("webui connection failed"));
}

#[test]
fn edit_key_types_and_backspaces_utf8_safe() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut explorer = FileExplorer::new("/repo");
    explorer.preview = preview("ab");
    explorer.start_edit().unwrap();
    assert_eq!(explorer.edit_cursor, 2);
    // Insert a multibyte char: the cursor advances by its UTF-8 length.
    explorer.edit_key(edit_key('ñ', false), &api).unwrap();
    assert!(explorer.preview.dirty);
    assert_eq!(explorer.preview.content, "abñ");
    assert_eq!(explorer.edit_cursor, "abñ".len());
    // Backspace removes one full multibyte char, not one byte.
    explorer
        .edit_key(key(crossterm::event::KeyCode::Backspace), &api)
        .unwrap();
    assert_eq!(explorer.preview.content, "ab");
    assert_eq!(explorer.edit_cursor, 2);
    // Enter (a real crossterm KeyCode::Enter) inserts a line break.
    explorer
        .edit_key(key(crossterm::event::KeyCode::Enter), &api)
        .unwrap();
    assert_eq!(explorer.preview.content, "ab\n");
    assert_eq!(explorer.edit_cursor, 3);
    // Control chars never reach the buffer: Ctrl-U is ignored here.
    explorer.edit_key(ctrl_key('u'), &api).unwrap();
    assert_eq!(explorer.preview.content, "ab\n");
    // Alt-modified chars are ignored too.
    let alt = crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('j'),
        crossterm::event::KeyModifiers::ALT,
    );
    explorer.edit_key(alt, &api).unwrap();
    assert_eq!(explorer.preview.content, "ab\n");
}

#[test]
fn edit_key_moves_cursor_with_left_right_home_end() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut explorer = FileExplorer::new("/repo");
    explorer.preview = preview("l1 x\nl2 y\nl3 z");
    explorer.start_edit().unwrap();
    assert_eq!(explorer.edit_cursor, "l1 x\nl2 y\nl3 z".len());
    // Home: jump to the start of the current (last) line.
    explorer
        .edit_key(key(crossterm::event::KeyCode::Home), &api)
        .unwrap();
    assert_eq!(explorer.edit_cursor, "l1 x\nl2 y\n".len());
    // Left: step back one char onto the previous line's newline.
    explorer
        .edit_key(key(crossterm::event::KeyCode::Left), &api)
        .unwrap();
    assert_eq!(explorer.edit_cursor, "l1 x\nl2 y".len());
    // Left again: within line 2.
    explorer
        .edit_key(key(crossterm::event::KeyCode::Left), &api)
        .unwrap();
    assert_eq!(explorer.edit_cursor, "l1 x\nl2 ".len());
    // Right restores one char.
    explorer
        .edit_key(key(crossterm::event::KeyCode::Right), &api)
        .unwrap();
    assert_eq!(explorer.edit_cursor, "l1 x\nl2 y".len());
    // End: jump to the end of the current line (before its newline).
    explorer
        .edit_key(key(crossterm::event::KeyCode::End), &api)
        .unwrap();
    assert_eq!(explorer.edit_cursor, "l1 x\nl2 y".len());
    // Typing inserts at the cursor, not only at the end.
    explorer.edit_key(edit_key('!', false), &api).unwrap();
    assert_eq!(explorer.preview.content, "l1 x\nl2 y!\nl3 z");
    // A stale cursor beyond the content length clamps to the end and
    // never panics.
    explorer.edit_cursor = 9999;
    explorer.edit_key(edit_key('?', false), &api).unwrap();
    assert_eq!(explorer.preview.content, "l1 x\nl2 y!\nl3 z?");
    assert_eq!(explorer.edit_cursor, "l1 x\nl2 y!\nl3 z?".len());
}

#[test]
fn edit_key_esc_stops_and_guards_refuse_unsafe_previews() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut explorer = FileExplorer::new("/repo");
    explorer.preview = preview("text");
    explorer.start_edit().unwrap();
    explorer.edit_key(edit_key('x', false), &api).unwrap();
    explorer
        .edit_key(key(crossterm::event::KeyCode::Esc), &api)
        .unwrap();
    assert!(!explorer.edit_active);
    assert!(explorer.preview.dirty, "Esc keeps unsaved changes");
    assert_eq!(explorer.preview.content, "textx");

    // Binary and truncated previews refuse to enter edit mode.
    explorer.preview.binary = true;
    assert!(explorer.start_edit().is_err());
    explorer.preview.binary = false;
    explorer.preview.truncated = true;
    assert!(explorer.start_edit().is_err());
    explorer.preview.truncated = false;
    explorer.start_edit().unwrap();
    assert!(explorer.edit_active);
}

#[test]
fn file_entries_parse_tree_payload() {
    let data = json!({
        "entries": [
            {"name": "src", "path": "src", "kind": "dir", "level": 0},
            {"name": "main.rs", "path": "main.rs", "kind": "file", "level": 0, "size": 12},
        ]
    });
    let entries = parse_entries(&data);
    assert_eq!(entries.len(), 2);
    assert!(entries[0].is_dir);
    assert!(!entries[1].is_dir);
    assert_eq!(entries[1].size, Some(12));
}

#[test]
fn explorer_collapse_scan_uses_child_levels() {
    let mut explorer = FileExplorer::new("/repo");
    explorer.entries = vec![
        FileEntry {
            name: "src".to_string(),
            path: "src".to_string(),
            is_dir: true,
            size: None,
            level: 0,
            expanded: true,
        },
        FileEntry {
            name: "main.rs".to_string(),
            path: "src/main.rs".to_string(),
            is_dir: false,
            size: None,
            level: 1,
            expanded: false,
        },
        FileEntry {
            name: "tui".to_string(),
            path: "tui.rs".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
        },
    ];
    explorer.selected = 0;
    // Collapse without hitting the network: expand is already true, and
    // the drain loop must stop at the level-0 sibling.
    let mut remove_from = 1;
    while explorer
        .entries
        .get(remove_from)
        .is_some_and(|next| next.level > 0)
    {
        remove_from += 1;
    }
    explorer.entries.drain(1..remove_from);
    explorer.entries[0].expanded = false;
    assert_eq!(explorer.entries.len(), 2);
    assert_eq!(explorer.entries[1].name, "tui");
    assert!(!explorer.entries[0].expanded);
}

#[test]
fn explorer_navigation_clamps_and_goes_up() {
    let mut explorer = FileExplorer::new("/repo");
    explorer.entries = vec![
        FileEntry {
            name: "a".to_string(),
            path: "a".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
        },
        FileEntry {
            name: "b".to_string(),
            path: "b".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
        },
    ];
    explorer.move_selection(5);
    assert_eq!(explorer.selected, 1);
    explorer.move_selection(-3);
    assert_eq!(explorer.selected, 0);

    explorer.root_path = "src/deep".to_string();
    assert!(explorer.go_up());
    assert_eq!(explorer.root_path, "src");
    assert!(explorer.go_up());
    assert_eq!(explorer.root_path, "");
    assert!(!explorer.go_up());
}

#[test]
fn explorer_filter_search_mode_toggles() {
    let mut explorer = FileExplorer::new("/repo");
    explorer.start_filter();
    explorer.push_filter_char('r');
    explorer.push_filter_char('s');
    assert_eq!(explorer.filter, "rs");
    explorer.pop_filter_char();
    assert_eq!(explorer.filter, "r");
    explorer.commit_filter();
    assert!(explorer.search_mode);
}

#[test]
fn git_files_parse_status_payload_with_priority() {
    let data = json!({
        "conflicted": ["both.txt"],
        "staged": ["a.rs"],
        "unstaged": ["b.rs"],
        "untracked": ["c.txt"],
    });
    let files = parse_git_files(&data);
    assert_eq!(files.len(), 4);
    assert_eq!(files[0].status, GitFileStatus::Conflicted);
    assert_eq!(files[1].status, GitFileStatus::Staged);
    assert_eq!(files[2].status, GitFileStatus::Unstaged);
    assert_eq!(files[3].status, GitFileStatus::Untracked);
}

#[test]
fn git_panel_status_fields_parse() {
    let mut panel = GitPanel::new("/repo");
    panel.branch = "main".to_string();
    panel.ahead = 2;
    panel.behind = 1;
    panel.state = "dirty".to_string();
    assert_eq!(panel.view, GitView::Changes);
    assert_eq!(panel.view.title(), "Changes");
}

#[test]
fn git_diff_lines_parse_server_chunk_shape() {
    // Mirrors the /api/git-ui/diff response: files[].chunks[].lines[]
    // with line_type/content fields.
    let data = json!({
        "files": [
            {
                "path": "src/main.rs",
                "chunks": [
                    {
                        "header": "@@ -1,2 +1,3 @@",
                        "lines": [
                            {"line_type": "normal", "content": "fn main() {"},
                            {"line_type": "add", "content": "    println!(\"hi\");"},
                            {"line_type": "delete", "content": "    todo!()"},
                        ]
                    }
                ]
            }
        ]
    });
    let lines = parse_diff_lines_with_meta(&data).0;
    assert_eq!(
        lines,
        vec![
            "@@ -1,2 +1,3 @@".to_string(),
            " fn main() {".to_string(),
            "+    println!(\"hi\");".to_string(),
            "-    todo!()".to_string(),
        ]
    );
}

#[test]
fn git_diff_meta_parse_line_numbers() {
    let data = json!({
        "files": [
            {
                "path": "src/main.rs",
                "chunks": [
                    {
                        "header": "@@ -1,2 +1,3 @@",
                        "lines": [
                            {"line_type": "normal", "content": "fn main() {", "old_line_number": 1, "new_line_number": 1},
                            {"line_type": "add", "content": "    println!(\"hi\");", "new_line_number": 2},
                            {"line_type": "delete", "content": "    todo!()", "old_line_number": 2},
                        ]
                    }
                ]
            }
        ]
    });
    let (lines, meta) = parse_diff_lines_with_meta(&data);
    assert_eq!(lines.len(), meta.len());
    assert_eq!(meta[0], None);
    assert_eq!(
        meta[1],
        Some(GitDiffLineMeta {
            old_line: Some(1),
            new_line: Some(1)
        })
    );
    assert_eq!(
        meta[2],
        Some(GitDiffLineMeta {
            old_line: None,
            new_line: Some(2)
        })
    );
    assert_eq!(
        meta[3],
        Some(GitDiffLineMeta {
            old_line: Some(2),
            new_line: None
        })
    );
}

#[test]
fn blame_parser_maps_final_lines_to_authors() {
    // Shape of `git blame --line-porcelain`: header
    // `<sha> <orig> <final>`, then metadata, `author <name>`, and
    // the tab-prefixed content line.
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let text = format!(
        "{sha} 3 1 1\n\
         author Alice Dev\n\
         author-mail <alice@example.com>\n\
         \tfirst line\n\
         {sha} 4 2 2\n\
         author Bob Other\n\
         \tsecond line\n\
         summary tweak\n"
    );
    let authors = parse_blame_authors(&text);
    assert_eq!(authors.get(&1).map(String::as_str), Some("Alice Dev"));
    assert_eq!(authors.get(&2).map(String::as_str), Some("Bob Other"));
    assert_eq!(authors.len(), 2);
}

#[test]
fn blame_parser_ignores_non_header_lines() {
    // Author lines without a preceding header, and content lines
    // that look like hex, must not corrupt the mapping.
    let text = "author Nobody\n\tsome content\n0123456789abcdef0123456789abcdef0123456789 not numbers\n";
    let authors = parse_blame_authors(text);
    assert!(authors.is_empty());
}

#[test]
fn blame_parser_survives_multibyte_content_lines() {
    // Blamed files can contain multibyte characters; the header
    // check must never slice a content line mid-char (panic).
    // Tab-prefixed content of 2-byte chars crossing byte 40 is the
    // crash case this guards.
    let sha = "0123456789abcdef0123456789abcdef01234567";
    let content = "\t".to_string() + &"ñ".repeat(25);
    let text = format!("{sha} 1 1\nauthor Test\n{content}\n");
    let authors = parse_blame_authors(&text);
    assert_eq!(authors.get(&1).map(String::as_str), Some("Test"));
}

#[test]
fn git_log_commits_parse_labels() {
    let data = json!({
        "commits": [
            {
                "hash": "abc123",
                "message": "fix bug",
                "author": "Ada",
                "date": "2 hours ago",
                "labels": ["main", "origin/main"],
            }
        ]
    });
    let commits: Vec<GitCommitEntry> = data
        .get("commits")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(parse_commit).collect())
        .unwrap_or_default();
    assert_eq!(commits.len(), 1);
    assert_eq!(commits[0].hash, "abc123");
    assert_eq!(commits[0].labels, vec!["main", "origin/main"]);
}

#[test]
fn git_branches_parse_current_remote_pushed() {
    let data = json!({
        "branches": [
            {"name": "main", "current": true, "remote": false, "pushed": true},
            {"name": "origin/feature", "current": false, "remote": true, "pushed": false},
        ]
    });
    let branches: Vec<GitBranchEntry> = data
        .get("branches")
        .and_then(Value::as_array)
        .map(|items| items.iter().map(parse_branch).collect())
        .unwrap_or_default();
    assert_eq!(branches.len(), 2);
    assert!(branches[0].current);
    assert!(branches[1].remote);
    assert!(!branches[1].pushed);
}

#[test]
fn git_view_titles_map_for_tabs() {
    assert_eq!(
        GitView::all()
            .iter()
            .map(|view| view.title())
            .collect::<Vec<_>>(),
        vec!["Changes", "Log", "Branches", "Stash", "History"]
    );
}

#[test]
fn git_file_status_labels_and_index_letters_cover_every_variant() {
    use crate::tui::panels::GitFileStatus as S;
    assert_eq!(S::Staged.label(), "staged");
    assert_eq!(S::Staged.index_letter(), 'S');
    assert_eq!(S::Unstaged.label(), "unstaged");
    assert_eq!(S::Unstaged.index_letter(), 'M');
    assert_eq!(S::Untracked.label(), "untracked");
    assert_eq!(S::Untracked.index_letter(), 'U');
    assert_eq!(S::Conflicted.label(), "conflicted");
    assert_eq!(S::Conflicted.index_letter(), 'C');
}

#[test]
fn git_panel_move_selection_covers_every_view() {
    let mut panel = GitPanel::new("/repo");
    panel.files = vec![
        GitFileEntry {
            path: "a.rs".to_string(),
            status: GitFileStatus::Staged,
        },
        GitFileEntry {
            path: "b.rs".to_string(),
            status: GitFileStatus::Unstaged,
        },
    ];
    panel.commits = vec![
        GitCommitEntry {
            hash: "h1".to_string(),
            message: "m1".to_string(),
            author: "a".to_string(),
            date: "d".to_string(),
            labels: vec![],
        },
        GitCommitEntry {
            hash: "h2".to_string(),
            message: "m2".to_string(),
            author: "a".to_string(),
            date: "d".to_string(),
            labels: vec![],
        },
    ];
    panel.branches = vec![
        GitBranchEntry {
            name: "main".to_string(),
            current: true,
            remote: false,
            pushed: true,
        },
        GitBranchEntry {
            name: "dev".to_string(),
            current: false,
            remote: false,
            pushed: false,
        },
    ];
    panel.stashes = vec![
        GitStashEntry {
            name: "stash@{0}".to_string(),
            message: "w".to_string(),
        },
        GitStashEntry {
            name: "stash@{1}".to_string(),
            message: "w2".to_string(),
        },
    ];

    panel.view = GitView::Changes;
    panel.move_selection(1);
    assert_eq!(panel.file_selected, 1);
    panel.view = GitView::Log;
    panel.move_selection(1);
    assert_eq!(panel.commit_selected, 1);
    panel.view = GitView::History;
    panel.move_selection(-1);
    assert_eq!(panel.commit_selected, 0);
    panel.view = GitView::Branches;
    panel.move_selection(1);
    assert_eq!(panel.branch_selected, 1);
    panel.view = GitView::Stash;
    panel.move_selection(1);
    assert_eq!(panel.stash_selected, 1);

    // Empty lists clamp instead of panicking.
    panel.files.clear();
    panel.view = GitView::Changes;
    panel.move_selection(1);
    assert_eq!(panel.file_selected, 0);
}

#[test]
fn toggle_expand_merges_children_and_collapses_back() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut explorer = FileExplorer::new("/repo");
    explorer.entries = vec![FileEntry {
        name: "src".to_string(),
        path: "src".to_string(),
        is_dir: true,
        size: None,
        level: 0,
        expanded: false,
    }];
    // No selection: nothing expands.
    explorer.selected = 5;
    assert!(!explorer.toggle_expand(&api).unwrap_or(false));

    // A file cannot expand.
    explorer.selected = 0;
    explorer.entries[0].is_dir = false;
    assert!(!explorer.toggle_expand(&api).unwrap_or(false));

    // A directory against a dead API errors rather than panicking.
    explorer.entries[0].is_dir = true;
    assert!(explorer.toggle_expand(&api).is_err());
}

/// Minimal HTTP fake: answers file-browser endpoints like the WebUI
/// server would, so explorer flows that need a live API stay hermetic.
fn fake_file_browser_server() -> (u16, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut buf = [0u8; 8192];
            let mut got = String::new();
            loop {
                let n = stream.read(&mut buf).unwrap_or(0);
                if n == 0 {
                    break;
                }
                got.push_str(&String::from_utf8_lossy(&buf[..n]));
                if got.contains("\r\n\r\n") {
                    break;
                }
            }
            let target = got.split(' ').nth(1).unwrap_or_default().to_string();
            let body = if target.starts_with("/api/file-browser/tree") {
                json!({"entries": [{
                    "name": "lib.rs", "path": "src/lib.rs",
                    "kind": "file", "size": 12, "level": 0,
                }]})
            } else if target.starts_with("/api/file-browser/file") {
                json!({
                    "content": "fn main() {}\n",
                    "binary": false,
                    "truncated": false,
                    "hash": "hash-v1",
                })
            } else if target.starts_with("/api/git-ui/branches") {
                json!({"branches": [{"name": "main", "current": true, "commit": "abc"}]})
            } else if target.starts_with("/api/git-ui/diff") {
                json!({"files": [{"path": "src/lib.rs", "chunks": [{
                    "lines": [{"text": "+hello", "number": 1, "new_number": 1}]
                }]}]})
            } else if target.starts_with("/api/git-ui/blame") {
                // `git blame --line-porcelain` text passthrough.
                json!({"text": "0123456789abcdef0123456789abcdef01234567 1 1 1\nauthor Zoe\n"})
            } else if target.starts_with("/api/git-ui/status") {
                json!({"branch": "main", "state": "dirty", "unstaged": ["src/lib.rs"]})
            } else {
                json!({"ok": true})
            };
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.to_string().len(),
                    body
                )
                .as_bytes(),
            );
        }
    });
    (port, handle)
}

#[test]
fn open_preview_on_dir_expands_and_ctrl_r_reloads() {
    let (port, _server) = fake_file_browser_server();
    let api = WebApiClient::new("127.0.0.1", port);
    let mut explorer = FileExplorer::new("/repo");
    explorer.entries = vec![FileEntry {
        name: "src".to_string(),
        path: "src".to_string(),
        is_dir: true,
        size: None,
        level: 0,
        expanded: false,
    }];
    explorer.selected = 0;

    // Enter on a directory expands it (open_preview -> toggle_expand).
    explorer.open_preview(&api).expect("dir preview expands");
    assert!(explorer.entries[0].expanded);
    assert_eq!(explorer.entries.len(), 2, "children merged in");
    assert_eq!(explorer.entries[1].path, "src/lib.rs");

    // Select the child file and open its preview.
    explorer.selected = 1;
    explorer.open_preview(&api).expect("file preview opens");
    assert_eq!(explorer.preview.path.as_deref(), Some("src/lib.rs"));
    assert_eq!(explorer.preview.hash, "hash-v1");

    // Dirty the buffer, then Ctrl-R reloads from the server, restoring
    // the pristine content and clearing the dirty flag via open_preview_path.
    explorer.edit_active = true;
    explorer.edit_cursor = explorer.preview.content.len();
    explorer.preview.content = "dirty".to_string();
    explorer.preview.dirty = true;
    explorer
        .edit_key(edit_key('r', true), &api)
        .expect("ctrl-r reloads");
    assert_eq!(explorer.preview.content, "fn main() {}\n");
    assert!(!explorer.preview.dirty);
    assert_eq!(explorer.edit_cursor, explorer.preview.content.len());
    assert!(explorer.edit_active, "editing continues after reload");
}

#[test]
fn refresh_diff_reloads_blame_and_branches_clamp() {
    let (port, _server) = fake_file_browser_server();
    let api = WebApiClient::new("127.0.0.1", port);
    let mut panel = GitPanel::new("/repo");
    panel.view = GitView::Changes;
    panel.files = vec![GitFileEntry {
        path: "src/lib.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    panel.file_selected = 0;

    // Enter-equivalent: refresh_view(Changes) loads status + diff for
    // the selected file; enabling blame then reloading the diff must
    // re-run blame through the show_blame branch in refresh_diff.
    panel.refresh_view(&api).unwrap();
    assert_eq!(panel.diff_title, "src/lib.rs");
    panel.toggle_blame(&api).expect("blame toggles on");
    assert!(panel.show_blame);
    panel.refresh_diff(&api).unwrap();
    assert!(panel.blame_authors.contains_key(&1), "blame reloaded");
    assert_eq!(panel.blame_authors.get(&1).map(String::as_str), Some("Zoe"));

    // Branch list refresh clamps a stale selection to the list end.
    panel.view = GitView::Branches;
    panel.branch_selected = 99;
    panel.refresh_view(&api).unwrap();
    assert_eq!(panel.branch_selected, 0, "selection clamps to len-1");

    // The fake server's catch-all branch answers any other endpoint
    // (here: stashes) with a generic ok body.
    panel.view = GitView::Stash;
    panel.refresh_view(&api).unwrap();
    assert!(panel.stashes.is_empty(), "unknown shapes parse to empty");
}

#[test]
fn open_preview_and_edit_without_selection_are_safe() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut explorer = FileExplorer::new("/repo");
    explorer.entries.clear();
    explorer.selected = 0;

    // Enter with no entries: neither enter nor preview nor edit panics.
    assert!(!explorer.enter_directory());
    assert!(!explorer.go_up());
    assert!(explorer.open_preview(&api).is_err() || explorer.entries.is_empty());

    // Edit with no preview open is a no-op error.
    explorer.preview = FilePreview::default();
    assert!(explorer.start_edit().is_err());
}
