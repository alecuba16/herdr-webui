//! Panel unit tests shared by files and git modules.
//!
//! Both `files.rs` and `git.rs` previously lived in one module, so their
//! tests reference items from both via `super::*` re-exports.

use super::files::parse_entries;
use super::git::{
    parse_blame_authors, parse_branch, parse_cleanup_repos, parse_commit,
    parse_diff_lines_with_meta, parse_git_files, CleanupItemKind, CleanupRepo, LogScope,
    LOG_MAX_LIMIT, LOG_PAGE_SIZE,
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

fn one_shot_json_server<F>(handler: F) -> (WebApiClient, std::thread::JoinHandle<()>)
where
    F: FnOnce(String, String) -> serde_json::Value + Send + 'static,
{
    use std::io::{BufRead as _, Read as _, Write as _};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
        let mut request = String::new();
        reader.read_line(&mut request).unwrap();
        let mut content_length = 0usize;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            let trimmed = header.trim();
            if trimmed.is_empty() {
                break;
            }
            if let Some(value) = trimmed.to_ascii_lowercase().strip_prefix("content-length:") {
                content_length = value.trim().parse().unwrap();
            }
        }
        let mut body = vec![0; content_length];
        if content_length > 0 {
            reader.read_exact(&mut body).unwrap();
        }
        let response = handler(request, String::from_utf8(body).unwrap());
        let body = response.to_string();
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    });
    (WebApiClient::new("127.0.0.1", port), handle)
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
    let authors = parse_blame_authors("0123456789abcdef0123456789abcdef01234567 9\nauthor Frank\n");
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
fn file_entries_parse_git_status_map() {
    let data = json!({
        "entries": [
            {"name": "readme.md", "path": "readme.md", "kind": "file", "level": 0},
            {"name": "src", "path": "src", "kind": "dir", "level": 0},
        ],
        "git_status": {
            "readme.md": "modified",
            "src": "untracked"
        }
    });
    let entries = parse_entries(&data);
    assert_eq!(entries[0].git_status.as_deref(), Some("modified"));
    assert_eq!(entries[1].git_status.as_deref(), Some("untracked"));
}

#[test]
fn search_kind_cycles_files_folders_content() {
    use super::files::SearchKind;
    let mut explorer = FileExplorer::new("/repo");
    assert_eq!(explorer.search_kind, SearchKind::File);
    explorer.cycle_search_kind();
    assert_eq!(explorer.search_kind, SearchKind::Dir);
    explorer.cycle_search_kind();
    assert_eq!(explorer.search_kind, SearchKind::Content);
    // Cycling resets the content-search results.
    explorer.content_search.total_matches = 7;
    explorer.cycle_search_kind();
    assert_eq!(explorer.search_kind, SearchKind::File);
    assert_eq!(explorer.content_search.total_matches, 0);
    assert_eq!(SearchKind::Dir.label(), "Folders");
}

#[test]
fn join_root_path_joins_under_current_root() {
    // The helper is private; exercise it through create_file's guard:
    // an empty name must be rejected without any API call.
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut explorer = FileExplorer::new("/repo");
    let err = explorer.create_file(&api, "").unwrap_err();
    assert!(err.to_string().contains("file name is required"));
    let err = explorer.create_directory(&api, "  ").unwrap_err();
    assert!(err.to_string().contains("directory name is required"));
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
            git_status: None,
        },
        FileEntry {
            name: "main.rs".to_string(),
            path: "src/main.rs".to_string(),
            is_dir: false,
            size: None,
            level: 1,
            expanded: false,
            git_status: None,
        },
        FileEntry {
            name: "tui".to_string(),
            path: "tui.rs".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
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
            git_status: None,
        },
        FileEntry {
            name: "b".to_string(),
            path: "b".to_string(),
            is_dir: false,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
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
    let text =
        "author Nobody\n\tsome content\n0123456789abcdef0123456789abcdef0123456789 not numbers\n";
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
        vec![
            "Changes",
            "Log",
            "Branches",
            "Stash",
            "History",
            "Conflicts",
            "Cleanup"
        ]
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
        git_status: None,
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
        git_status: None,
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

#[test]
fn parse_cleanup_repos_filters_current_branches_and_primary_worktrees() {
    let data = json!({
        "root": "/code",
        "truncated": false,
        "repos": [
            {
                "path": "/code/repo",
                "branches": [
                    {"name": "main", "current": true, "checked_out": false, "pushed": true},
                    {"name": "merged-feature", "current": false, "checked_out": false, "pushed": true}
                ],
                "worktrees": [
                    {"path": "/code/repo", "branch": "main", "detached": false, "prunable": false, "primary": true, "pushed": true},
                    {"path": "/code/wt-stale", "branch": null, "detached": true, "prunable": true, "primary": false, "pushed": null}
                ],
                "error": null
            },
            {"path": "/code/broken", "branches": [], "worktrees": [], "error": "no git"}
        ]
    });
    let repos = parse_cleanup_repos(&data);
    assert_eq!(repos.len(), 2);
    assert_eq!(repos[0].path, "/code/repo");
    // The current branch is never offered for deletion.
    assert_eq!(repos[0].branches, vec!["merged-feature"]);
    // The primary worktree (the repo itself) is not removable.
    assert_eq!(repos[0].worktrees, vec!["/code/wt-stale"]);
    assert!(repos[1].branches.is_empty());

    // Missing shapes parse to empty.
    assert!(parse_cleanup_repos(&json!({})).is_empty());
    assert!(parse_cleanup_repos(&json!({"repos": []})).is_empty());
}

#[test]
fn cleanup_items_flatten_branches_before_worktrees() {
    let mut panel = GitPanel::new("/repo");
    panel.cleanup_repos = vec![CleanupRepo {
        path: "/code/repo".to_string(),
        branches: vec!["one".to_string(), "two".to_string()],
        worktrees: vec!["/code/wt".to_string()],
    }];
    let items = panel.cleanup_items();
    assert_eq!(items.len(), 3);
    assert_eq!(items[0].kind, CleanupItemKind::Branch);
    assert_eq!(items[0].name, "one");
    assert_eq!(items[2].kind, CleanupItemKind::Worktree);
    assert_eq!(items[2].name, "/code/wt");

    panel.cleanup_selected = 2;
    let selected = panel.selected_cleanup_item().unwrap();
    assert_eq!(selected.kind, CleanupItemKind::Worktree);
}

#[test]
fn conflict_modes_and_actions_map_to_webui_api_names() {
    assert_eq!(ConflictResolveMode::Ours.api_name(), "ours");
    assert_eq!(ConflictResolveMode::Parent.api_name(), "base");
    assert_eq!(ConflictResolveMode::Remote.api_name(), "theirs");
    assert_eq!(ConflictResolveMode::MarkResolved.api_name(), "mark");
    for action in [
        ConflictAction::MergeAbort,
        ConflictAction::MergeContinue,
        ConflictAction::RebaseContinue,
        ConflictAction::RebaseSkip,
        ConflictAction::RebaseAbort,
        ConflictAction::CherryPickContinue,
        ConflictAction::CherryPickAbort,
    ] {
        assert!(
            action.api_name().starts_with(
                action
                    .label()
                    .split(' ')
                    .next_back()
                    .map(str::to_string)
                    .unwrap_or_default()
                    .as_str()
            ) || !action.api_name().is_empty()
        );
        assert!(!action.label().is_empty());
    }
}

#[test]
fn resolve_without_selected_conflict_errors() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut panel = GitPanel::new("/repo");
    panel.view = GitView::Conflicts;
    assert!(panel
        .resolve_selected_conflict(&api, ConflictResolveMode::Ours)
        .is_err());
    assert!(panel
        .conflict_action(&api, ConflictAction::RebaseContinue)
        .is_err());
}

#[test]
fn stash_diff_without_selection_errors() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut panel = GitPanel::new("/repo");
    panel.view = GitView::Stash;
    assert!(panel.load_stash_diff(&api).is_err());
}

#[test]
fn log_scope_cycles_in_webui_order() {
    // Webui `cycleLogScope`: all -> base-current -> base -> all.
    assert_eq!(LogScope::default(), LogScope::BaseCurrent);
    let mut scope = LogScope::All;
    assert_eq!(scope.api_name(), "all");
    scope = scope.next();
    assert_eq!(scope, LogScope::BaseCurrent);
    assert_eq!(scope.api_name(), "base-current");
    scope = scope.next();
    assert_eq!(scope, LogScope::Base);
    assert_eq!(scope.api_name(), "base");
    scope = scope.next();
    assert_eq!(scope, LogScope::All);
}

#[test]
fn log_load_more_grows_by_page_and_caps_at_webui_max() {
    let mut panel = GitPanel::new("/repo");
    assert_eq!(panel.log_limit, LOG_PAGE_SIZE);
    // Without has_more, load more is refused.
    assert!(!panel.log_load_more());
    assert_eq!(panel.log_limit, LOG_PAGE_SIZE);
    panel.log_has_more = true;
    assert!(panel.log_load_more());
    assert_eq!(panel.log_limit, LOG_PAGE_SIZE * 2);
    // Cycling the scope resets the page size (webui `cycleLogScope`).
    panel.cycle_log_scope();
    assert_eq!(panel.log_limit, LOG_PAGE_SIZE);
    // Default is BaseCurrent; one cycle advances to Base.
    assert_eq!(panel.log_scope, LogScope::Base);
    // Cap: the limit never passes LOG_MAX_LIMIT.
    panel.log_has_more = true;
    panel.log_limit = LOG_MAX_LIMIT;
    assert!(panel.log_load_more());
    assert_eq!(panel.log_limit, LOG_MAX_LIMIT);
}

#[test]
fn log_actions_without_selected_commit_error() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut panel = GitPanel::new("/repo");
    panel.view = GitView::Log;
    assert!(panel.selected_commit_hash().is_none());
    assert!(panel.log_tag(&api, "v1").is_err());
    assert!(panel.log_reset(&api, "soft").is_err());
}

#[test]
fn selected_commit_hash_tracks_selection() {
    let mut panel = GitPanel::new("/repo");
    panel.commits = vec![
        GitCommitEntry {
            hash: "aaaa1111".to_string(),
            author: "a".to_string(),
            date: "d".to_string(),
            message: "first".to_string(),
            labels: Vec::new(),
        },
        GitCommitEntry {
            hash: "bbbb2222".to_string(),
            author: "b".to_string(),
            date: "d".to_string(),
            message: "second".to_string(),
            labels: Vec::new(),
        },
    ];
    panel.commit_selected = 1;
    assert_eq!(panel.selected_commit_hash(), Some("bbbb2222"));
}

#[test]
fn diff_search_matches_incrementally_and_cycles() {
    let mut panel = GitPanel::new("/repo");
    panel.diff_lines = vec![
        "+fn alpha() {}".to_string(),
        " context line".to_string(),
        "-fn beta() {}".to_string(),
        "+fn gamma() {}".to_string(),
    ];
    panel.start_diff_search();
    assert!(panel.diff_search_active);
    // Incremental: "fn" matches all three code lines.
    panel.push_diff_search_char('f');
    panel.push_diff_search_char('n');
    assert_eq!(panel.diff_search_matches, vec![0, 2, 3]);
    // Narrowing to "fn g" keeps only the gamma line (case-insensitive).
    panel.push_diff_search_char(' ');
    panel.push_diff_search_char('g');
    assert_eq!(panel.diff_search_matches, vec![3]);
    assert_eq!(panel.diff_search_active_line(), Some(3));
    // Backspace restores the broader match set.
    panel.pop_diff_search_char();
    panel.pop_diff_search_char();
    assert_eq!(panel.diff_search_matches, vec![0, 2, 3]);
    // n/N wrap around.
    assert!(panel.diff_search_next());
    assert_eq!(panel.diff_search_active_line(), Some(2));
    assert!(panel.diff_search_next());
    assert_eq!(panel.diff_search_active_line(), Some(3));
    assert!(panel.diff_search_next());
    assert_eq!(panel.diff_search_active_line(), Some(0));
    assert!(panel.diff_search_prev());
    assert_eq!(panel.diff_search_active_line(), Some(3));
    // Enter keeps the matches so n/N keep working after the bar closes.
    panel.end_diff_search();
    assert!(!panel.diff_search_active);
    assert_eq!(panel.diff_search_matches, vec![0, 2, 3]);
    // Esc forgets the search entirely.
    panel.cancel_diff_search();
    assert!(panel.diff_search_matches.is_empty());
    assert!(panel.diff_search_query.is_empty());
    assert_eq!(panel.diff_search_active_line(), None);
}

#[test]
fn diff_search_without_matches_fails_navigation() {
    let mut panel = GitPanel::new("/repo");
    panel.diff_lines = vec!["+fn alpha() {}".to_string()];
    panel.diff_search_matches.clear();
    assert!(!panel.diff_search_next());
    assert!(!panel.diff_search_prev());
    // Empty query never matches.
    panel.start_diff_search();
    panel.refresh_diff_search_matches();
    assert!(panel.diff_search_matches.is_empty());
}

#[test]
fn reveal_path_expands_ancestors_and_selects_file() {
    let (port, _server) = fake_file_browser_server();
    let api = WebApiClient::new("127.0.0.1", port);
    let mut explorer = FileExplorer::new("/repo");
    explorer.entries = vec![
        FileEntry {
            name: "src".to_string(),
            path: "src".to_string(),
            is_dir: true,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
        FileEntry {
            name: "docs".to_string(),
            path: "docs".to_string(),
            is_dir: true,
            size: None,
            level: 0,
            expanded: false,
            git_status: None,
        },
    ];
    explorer.reveal_path(&api, "src/lib.rs").unwrap();
    // The tree now holds src -> lib.rs (docs stays after the insert) and
    // lib.rs is selected.
    let paths: Vec<&str> = explorer.entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, vec!["src", "src/lib.rs", "docs"]);
    assert_eq!(explorer.selected_entry().unwrap().path, "src/lib.rs");
    assert!(explorer.entries[0].expanded);

    // Missing ancestor fails instead of guessing.
    let err = explorer.reveal_path(&api, "nope/lib.rs").unwrap_err();
    assert!(err.to_string().contains("cannot reveal"));

    // Leading slash is tolerated (git paths are relative to the repo
    // root; the tree joins them onto root_path the same way).
    explorer.reveal_path(&api, "/src/lib.rs").unwrap();
    assert_eq!(explorer.selected_entry().unwrap().path, "src/lib.rs");
}

#[test]
fn recent_previews_dedupe_and_cycle_rotates() {
    let (port, _server) = fake_file_browser_server();
    let api = WebApiClient::new("127.0.0.1", port);
    let mut explorer = FileExplorer::new("/repo");
    // Simulate opening two files in order.
    explorer.open_preview_path(&api, "src/lib.rs").unwrap();
    explorer.open_preview_path(&api, "docs/readme.md").unwrap();
    assert_eq!(
        explorer.recent_previews,
        vec!["docs/readme.md".to_string(), "src/lib.rs".to_string()]
    );
    // Re-opening moves it to the front without duplicating.
    explorer.open_preview_path(&api, "src/lib.rs").unwrap();
    assert_eq!(
        explorer.recent_previews,
        vec!["src/lib.rs".to_string(), "docs/readme.md".to_string()]
    );
    // Tab cycles back to the other preview.
    assert!(explorer.cycle_recent_preview(&api).unwrap());
    assert_eq!(explorer.preview.path.as_deref(), Some("docs/readme.md"));
    // Cycling rotates the whole list round-robin.
    assert!(explorer.cycle_recent_preview(&api).unwrap());
    assert_eq!(explorer.preview.path.as_deref(), Some("src/lib.rs"));

    // A dirty buffer blocks switching files.
    explorer.preview.dirty = true;
    assert!(!explorer.cycle_recent_preview(&api).unwrap());
    assert_eq!(explorer.preview.path.as_deref(), Some("src/lib.rs"));

    // With a single preview there is nothing to cycle to.
    explorer.preview.dirty = false;
    explorer.recent_previews.truncate(1);
    assert!(!explorer.cycle_recent_preview(&api).unwrap());
}

#[test]
fn parse_diff_old_path_prefers_rename_source() {
    use super::git::parse_diff_old_path;
    // Rename: old_path is the `a/` side.
    let data = json!({"files": [
        {"path": "new-name.rs", "old_path": "old-name.rs", "chunks": []}
    ]});
    assert_eq!(parse_diff_old_path(&data).as_deref(), Some("old-name.rs"));
    // Plain modification: falls back to path like the webui
    // `file.old_path || file.path`.
    let data = json!({"files": [{"path": "src/lib.rs", "chunks": []}]});
    assert_eq!(parse_diff_old_path(&data).as_deref(), Some("src/lib.rs"));
    // Empty array / missing shape: None.
    assert_eq!(parse_diff_old_path(&json!({"files": []})), None);
    assert_eq!(parse_diff_old_path(&json!({})), None);
}

#[test]
fn hunk_cursor_walks_headers_and_wraps() {
    let mut panel = GitPanel::new("/repo");
    // No diff: nothing to select.
    assert!(!panel.move_hunk_selection(1));
    assert!(!panel.move_hunk_selection(-1));

    // Two hunks: header (meta None) + one line each.
    panel.diff_lines = vec![
        "@@ -1,2 +1,3 @@".to_string(),
        "+added".to_string(),
        "@@ -9,1 +9,2 @@".to_string(),
        "-removed".to_string(),
    ];
    panel.diff_meta = vec![
        None,
        Some(GitDiffLineMeta::default()),
        None,
        Some(GitDiffLineMeta::default()),
    ];
    assert!(panel.move_hunk_selection(1));
    assert_eq!(panel.diff_hunk_selected, 1);
    assert_eq!(panel.hunk_cursor_line(), Some(2));
    // Wrap forward past the end...
    assert!(panel.move_hunk_selection(1));
    assert_eq!(panel.diff_hunk_selected, 0);
    // ...and backward past the start.
    assert!(panel.move_hunk_selection(-1));
    assert_eq!(panel.diff_hunk_selected, 1);
}

#[test]
fn apply_hunk_action_builds_webui_hunk_patch() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::sync::mpsc::Receiver;

    // Fake server: answers the diff with two chunks (renamed file so
    // old_path is exercised), records the apply-patch body.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx): (_, Receiver<String>) = std::sync::mpsc::channel();
    let handle = std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            // Read headers, then the Content-Length body.
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 {
                    break;
                }
                if line == "\r\n" {
                    break;
                }
                headers.push_str(&line);
            }
            let length: usize = headers
                .lines()
                .find_map(|line| line.strip_prefix("Content-Length: "))
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            let mut body = vec![0u8; length];
            if length > 0 {
                reader.read_exact(&mut body).unwrap();
            }
            let target = headers.split(' ').nth(1).unwrap_or_default().to_string();
            let response = if target.starts_with("/api/git-ui/diff") {
                json!({"files": [{
                    "path": "new.rs",
                    "old_path": "old.rs",
                    "chunks": [
                        {"header": "@@ -1,2 +1,3 @@", "lines": [
                            {"line_type": "normal", "content": "ctx", "old_line_number": 1, "new_line_number": 1},
                            {"line_type": "add", "content": "added", "new_line_number": 2}
                        ]},
                        {"header": "@@ -9,1 +9,2 @@", "lines": [
                            {"line_type": "delete", "content": "gone", "old_line_number": 9}
                        ]}
                    ]
                }]})
            } else if target.starts_with("/api/git-ui/apply-patch") {
                tx.send(String::from_utf8_lossy(&body).to_string()).ok();
                json!({"ok": true})
            } else if target.starts_with("/api/git-ui/status") {
                json!({"branch": "main", "state": "dirty", "unstaged": ["new.rs"]})
            } else {
                json!({"ok": true})
            };
            let text = response.to_string();
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    text.len(),
                    text
                )
                .as_bytes(),
            );
        }
    });

    let api = WebApiClient::new("127.0.0.1", port);
    let mut panel = GitPanel::new("/repo");
    panel.view = GitView::Changes;
    panel.files = vec![GitFileEntry {
        path: "new.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    panel.file_selected = 0;
    panel.refresh_diff(&api).unwrap();
    assert_eq!(panel.diff_old_path.as_deref(), Some("old.rs"));
    assert_eq!(panel.hunk_count(), 2);

    // H applies the webui stageHunk for an unstaged file: cached, not
    // reverse, and the patch carries the second hunk after J.
    assert!(panel.move_hunk_selection(1));
    panel.apply_hunk_action(&api).unwrap();
    let body = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    let request: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(request["cwd"], "/repo");
    assert_eq!(request["cached"], true);
    assert_eq!(request["reverse"], false);
    let patch = request["patch"].as_str().unwrap();
    assert_eq!(
        patch,
        "diff --git a/old.rs b/new.rs\n--- a/old.rs\n+++ b/new.rs\n@@ -9,1 +9,2 @@\n-gone\n"
    );

    // Unstaged scope unstage arm: a staged file sends reverse + cached.
    panel.files[0].status = GitFileStatus::Staged;
    panel.diff_hunk_selected = 0;
    panel.apply_hunk_action(&api).unwrap();
    let body = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    let request: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(request["cached"], true);
    assert_eq!(request["reverse"], true);
    let patch = request["patch"].as_str().unwrap();
    assert!(patch.starts_with("diff --git a/old.rs b/new.rs\n"));
    assert!(patch.contains("@@ -1,2 +1,3 @@\n ctx\n+added\n"));

    // No per-file diff: the guard errors instead of calling the API.
    panel.diff_title = "working tree".to_string();
    assert!(panel.apply_hunk_action(&api).is_err());
    drop(handle);
}

#[test]
fn log_selection_toggles_and_caps_at_two() {
    let mut panel = GitPanel::new("/repo");
    // Mark three commits: the oldest is evicted like the webui slice(-2).
    panel.log_toggle_selection("a");
    panel.log_toggle_selection("b");
    panel.log_toggle_selection("c");
    assert_eq!(panel.log_selected, vec!["b".to_string(), "c".to_string()]);
    // Toggle off removes; toggle on re-adds.
    panel.log_toggle_selection("b");
    assert_eq!(panel.log_selected, vec!["c".to_string()]);
    panel.log_toggle_selection("b");
    assert_eq!(panel.log_selected, vec!["c".to_string(), "b".to_string()]);

    // Comparing with fewer than two selected errors without an API call.
    panel.log_selected.truncate(1);
    let api = WebApiClient::new("127.0.0.1", 1);
    assert!(panel.log_compare_selection(&api).is_err());
}

#[test]
fn log_compare_selection_orders_by_log_position() {
    use std::io::{BufRead, BufReader, Write};
    use std::sync::mpsc::Receiver;

    // Fake server: answers the compare call, records base/target.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx): (_, Receiver<String>) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request_line = String::new();
            if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                continue;
            }
            tx.send(request_line.clone()).ok();
            let body = "{\"ok\":true}";
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
                .as_bytes(),
            );
        }
    });

    let api = WebApiClient::new("127.0.0.1", port);
    let mut panel = GitPanel::new("/repo");
    panel.commits = vec![
        GitCommitEntry {
            hash: "newest".to_string(),
            message: "n".to_string(),
            author: "a".to_string(),
            labels: vec![],
            date: String::new(),
        },
        GitCommitEntry {
            hash: "middle".to_string(),
            message: "m".to_string(),
            author: "a".to_string(),
            labels: vec![],
            date: String::new(),
        },
        GitCommitEntry {
            hash: "oldest".to_string(),
            message: "o".to_string(),
            author: "a".to_string(),
            labels: vec![],
            date: String::new(),
        },
    ];
    // Click order must not matter: newest is always the target.
    panel.log_selected = vec!["oldest".to_string(), "newest".to_string()];
    panel.log_compare_selection(&api).unwrap();
    let request = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert!(
        request.contains("base=oldest"),
        "base is the oldest: {request}"
    );
    assert!(
        request.contains("target=newest"),
        "newest is target: {request}"
    );
    assert_eq!(panel.diff_title, "oldest..newest");
}

#[test]
fn file_api_workflows_cover_create_save_reveal_and_open_line() {
    let (api, handle) = one_shot_json_server(|request, body| {
        assert!(request.starts_with("POST /api/file-browser/file "));
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["path"], "src/new.rs");
        assert_eq!(body["create_parents"], true);
        json!({"ok": true})
    });
    let mut explorer = FileExplorer::new("/repo");
    explorer.root_path = "src".to_string();
    let err = explorer.create_file(&api, "new.rs").unwrap_err();
    assert!(err.to_string().contains("webui connection failed"));
    handle.join().unwrap();

    explorer.entries.push(FileEntry {
        name: "new.rs".to_string(),
        path: "src/new.rs".to_string(),
        is_dir: false,
        size: None,
        level: 0,
        expanded: false,
        git_status: None,
    });
    explorer.select_path("src/new.rs");
    assert_eq!(explorer.selected, 0);

    let (api, handle) = one_shot_json_server(|request, body| {
        assert!(request.starts_with("POST /api/file-browser/file "));
        let body: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(body["expected_hash"], "old-hash");
        json!({"hash": "new-hash"})
    });
    explorer.preview = FilePreview {
        path: Some("src/new.rs".to_string()),
        content: "changed".to_string(),
        truncated: false,
        binary: false,
        hash: "old-hash".to_string(),
        dirty: true,
    };
    explorer.save_preview(&api).unwrap();
    handle.join().unwrap();
    assert_eq!(explorer.preview.hash, "new-hash");
    assert!(!explorer.preview.dirty);

    let (api, handle) = one_shot_json_server(|request, _| {
        assert!(request.starts_with("GET /api/file-browser/file?cwd=%2Frepo&path=src%2Fnew.rs "));
        json!({"content": "a\nb", "hash": "h2"})
    });
    explorer
        .open_preview_at_line(&api, "src/new.rs", 0)
        .unwrap();
    handle.join().unwrap();
    assert_eq!(explorer.preview_jump_line, Some(1));
}

#[test]
fn reveal_path_covers_compacted_and_error_branches() {
    let mut explorer = FileExplorer::new("/repo");
    let api = WebApiClient::new("127.0.0.1", 1);
    assert!(explorer.reveal_path(&api, "").is_err());
    explorer.entries = vec![
        FileEntry {
            name: "nested/deep".to_string(),
            path: "nested/deep".to_string(),
            is_dir: true,
            size: None,
            level: 0,
            expanded: true,
            git_status: None,
        },
        FileEntry {
            name: "file.rs".to_string(),
            path: "nested/deep/file.rs".to_string(),
            is_dir: false,
            size: None,
            level: 1,
            expanded: false,
            git_status: None,
        },
    ];
    explorer.reveal_path(&api, "nested/deep/file.rs").unwrap();
    assert_eq!(explorer.selected, 1);
    let err = explorer.reveal_path(&api, "missing/file.rs").unwrap_err();
    assert!(err.to_string().contains("missing is not in the tree"));
    let err = explorer
        .reveal_path(&api, "nested/deep/absent.rs")
        .unwrap_err();
    assert!(err.to_string().contains("not found"));
}

#[test]
fn markdown_outline_parses_headings_and_skips_fences() {
    use crate::tui::panels::files::parse_markdown_outline;
    let content = "# Title\n\ntext\n\n## Section\n\n```rust\n# not a heading\n```\n\n### Deep\n\n####### seven hashes skipped\nplain text\n";
    let outline = parse_markdown_outline(content);
    let summaries: Vec<_> = outline
        .iter()
        .map(|(level, line, text)| (*level, *line, text.as_str()))
        .collect();
    assert_eq!(
        summaries,
        vec![(1, 1, "Title"), (2, 5, "Section"), (3, 11, "Deep")],
        "fenced # and >6 hashes skipped"
    );
    // No headings: empty outline.
    assert!(parse_markdown_outline("plain text only").is_empty());
}

#[test]
fn git_log_history_and_actions_cover_http_success_paths() {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::sync::mpsc::Receiver;

    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx): (_, Receiver<(String, String)>) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            if reader.read_line(&mut request).unwrap_or(0) == 0 {
                continue;
            }
            let mut len = 0usize;
            loop {
                let mut line = String::new();
                if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                    break;
                }
                if let Some(value) = line.strip_prefix("Content-Length: ") {
                    len = value.trim().parse().unwrap_or(0);
                }
            }
            let mut bytes = vec![0; len];
            if len > 0 {
                reader.read_exact(&mut bytes).unwrap();
            }
            let target = request.split(' ').nth(1).unwrap_or_default().to_string();
            tx.send((target.clone(), String::from_utf8_lossy(&bytes).to_string()))
                .ok();
            let body = if target.starts_with("/api/git-ui/log") {
                json!({"commits":[{"hash":"new","message":"n","author":"a","date":"d","labels":["main"]},{"hash":"old","message":"o","author":"b","date":"d","labels":[]}],"has_more":true})
            } else if target.starts_with("/api/git-ui/file-history") {
                json!({"commits":[{"hash":"hist","message":"h","author":"a","date":"d","labels":[]}]})
            } else if target.starts_with("/api/git-ui/compare") {
                json!({"files":[{"path":"src/lib.rs","chunks":[{"header":"@@ -1 +1 @@","lines":[{"line_type":"add","content":"new","new_line_number":1}]}]}]})
            } else {
                json!({"ok":true})
            };
            let text = body.to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                text.len(),
                text
            )
            .unwrap();
        }
    });
    let api = WebApiClient::new("127.0.0.1", port);
    let mut panel = GitPanel::new("/repo");
    panel.log_scope = LogScope::All;
    panel.log_file = Some("src/lib.rs".to_string());
    panel.commit_selected = 99;
    panel.refresh_log(&api).unwrap();
    let (target, _) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert!(target.contains("all=true"));
    assert!(target.contains("file=src%2Flib.rs"));
    assert_eq!(panel.commit_selected, 1);
    assert!(panel.log_has_more);

    panel.files = vec![GitFileEntry {
        path: "src/lib.rs".to_string(),
        status: GitFileStatus::Unstaged,
    }];
    panel.diff_lines = vec!["stale".to_string()];
    panel.diff_meta = vec![None];
    panel.refresh_history(&api).unwrap();
    assert!(rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap()
        .0
        .contains("file-history"));
    assert_eq!(panel.history_file.as_deref(), Some("src/lib.rs"));
    assert!(panel.diff_lines.is_empty());
    panel.load_commit_diff(&api, "hist").unwrap();
    let (target, _) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert!(target.contains("base=hist%5E"));
    assert_eq!(panel.diff_title, "hist · src/lib.rs");
    panel.log_compare_parent(&api, "new").unwrap();
    assert!(rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .unwrap()
        .0
        .contains("target=new"));

    panel.log_tag(&api, "v1").unwrap();
    let (_, body) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["ref_name"],
        "hist"
    );
    panel.log_reset(&api, "hard").unwrap();
    let (_, body) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["confirmation"],
        "reset hard"
    );
    panel.log_rebase(&api, "origin/main").unwrap();
    let (_, body) = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap()["upstream"],
        "origin/main"
    );
}

#[test]
fn git_conflict_cleanup_stash_and_parse_edges() {
    let api = WebApiClient::new("127.0.0.1", 1);
    let mut panel = GitPanel::new("/repo");
    assert!(panel
        .refresh_log(&api)
        .unwrap_err()
        .to_string()
        .contains("webui connection failed"));
    panel.refresh_history(&api).unwrap();
    assert!(panel.commits.is_empty());
    assert!(panel
        .cleanup_prune(&api)
        .unwrap_err()
        .to_string()
        .contains("no cleanup item"));
    assert!(panel.stash_apply(&api).is_err());
    assert!(panel.stash_drop(&api).is_err());
    assert_eq!(ConflictResolveMode::MarkResolved.label(), "mark resolved");
    assert_eq!(ConflictResolveMode::Parent.label(), "use parent");
    assert_eq!(CleanupItemKind::Branch.label(), "branch");
    assert_eq!(CleanupItemKind::Worktree.label(), "worktree");
    let commit = parse_commit(&json!({}));
    assert!(commit.hash.is_empty());
    let branch = parse_branch(&json!({}));
    assert!(branch.name.is_empty());
    let stash = super::git::parse_stash(&json!({}));
    assert!(stash.name.is_empty());
    panel.diff_lines = vec!["Alpha".to_string()];
    panel.start_diff_search();
    panel.push_diff_search_char('z');
    assert_eq!(panel.diff_search_active_line(), None);
}

#[test]
fn git_simple_refreshers_parse_success_payloads() {
    let (api, handle) = one_shot_json_server(|request, _| {
        assert!(request.starts_with("GET /api/git-ui/conflicts?cwd=%2Frepo "));
        json!({"files":["a.txt","b.txt"],"merge":true,"rebase":false})
    });
    let mut panel = GitPanel::new("/repo");
    panel.conflict_selected = 99;
    panel.refresh_conflicts(&api).unwrap();
    handle.join().unwrap();
    assert_eq!(panel.selected_conflict().map(String::as_str), Some("b.txt"));
    assert!(panel.merge_in_progress);
    assert!(!panel.rebase_in_progress);

    let (api, handle) = one_shot_json_server(|request, _| {
        assert!(request.starts_with("GET /api/git-ui/cleanup-scan?root=%2Froot "));
        json!({"repos":[{"path":"/repo","branches":[{"name":"gone","current":false}],"worktrees":[{"path":"/wt","primary":false}]}]})
    });
    panel.cleanup_scan(&api, "/root").unwrap();
    handle.join().unwrap();
    assert_eq!(panel.cleanup_root.as_deref(), Some("/root"));
    assert_eq!(panel.cleanup_items().len(), 2);

    let (api, handle) = one_shot_json_server(|request, _| {
        assert!(request.starts_with("GET /api/git-ui/stashes?cwd=%2Frepo "));
        json!({"stashes":[{"name":"stash@{0}","message":"wip"}]})
    });
    panel.stash_selected = 99;
    panel.refresh_stashes(&api).unwrap();
    handle.join().unwrap();
    assert_eq!(panel.stash_selected, 0);
    assert_eq!(panel.stashes[0].message, "wip");
}

#[test]
fn file_explorer_markdown_outline_toggles_only_for_markdown_preview() {
    let mut explorer = crate::tui::panels::files::FileExplorer::new("/repo");
    // No preview open: refused.
    assert_eq!(explorer.toggle_markdown_outline(), None);
    // Non-markdown preview: refused.
    explorer.preview.path = Some("src/lib.rs".to_string());
    assert_eq!(explorer.toggle_markdown_outline(), None);
    assert!(!explorer.markdown_outline);
    // Markdown preview: toggles on and back off.
    explorer.preview.path = Some("docs/plan.md".to_string());
    assert_eq!(explorer.toggle_markdown_outline(), Some(true));
    assert!(explorer.markdown_outline);
    assert_eq!(explorer.toggle_markdown_outline(), Some(false));
    assert!(!explorer.markdown_outline);
    // .markdown suffix counts too.
    explorer.preview.path = Some("notes.markdown".to_string());
    assert_eq!(explorer.toggle_markdown_outline(), Some(true));
    // Editing refuses the flip (outline of a shifting buffer).
    explorer.edit_active = true;
    assert_eq!(explorer.toggle_markdown_outline(), None);
}
