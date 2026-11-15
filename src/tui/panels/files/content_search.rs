//! Content search (`/api/file-browser/content-search`): grep-style
//! results grouped per file with pre-merged context chunks, webui
//! `HerdrContentSearch` parity.
//!
//! Webui behavior mirrored here:
//! - paging: `limit` files per request, `offset` grows with the appended
//!   count, `done` when the server reports `truncated: false`;
//! - state: query, match_case/regex toggles, per-file expanded map,
//!   `total_matches`/`total_files`/`visited` summary line;
//! - jump-to-line: Enter on a match row opens the file preview at that
//!   line with the match highlighted (webui double-click `openMatch`).

use serde_json::Value;

use crate::tui::model::value_str;
use crate::tui::web_api::{WebApiClient, WebApiError};

use super::FileExplorer;

/// Files per content-search request (webui `pageSize` default 50).
pub const CONTENT_SEARCH_PAGE_SIZE: usize = 50;

/// One rendered line of a context chunk.
#[derive(Debug, Clone, PartialEq)]
pub struct ContentSearchRow {
    /// 1-based line number in the file.
    pub line: usize,
    /// Line text (raw, not HTML-escaped).
    pub text: String,
    /// True when this line contains a match.
    pub matched: bool,
}

/// Pre-merged context chunk (server sends them merged already).
#[derive(Debug, Clone, PartialEq)]
pub struct ContentSearchChunk {
    pub start: usize,
    pub end: usize,
    pub rows: Vec<ContentSearchRow>,
}

/// One file group in the results.
#[derive(Debug, Clone, PartialEq)]
pub struct ContentSearchFile {
    pub path: String,
    pub name: String,
    pub match_count: usize,
    pub chunks: Vec<ContentSearchChunk>,
    /// The server capped this file's matches (`Load all matches`
    /// parity; the TUI shows the first match line when jumping).
    pub truncated: bool,
    /// First matched line (jump target when the file group is
    /// collapsed and Enter opens it).
    pub first_match_line: usize,
}

#[derive(Debug, Clone)]
pub struct ContentSearchState {
    pub query: String,
    pub match_case: bool,
    pub regex: bool,
    pub files: Vec<ContentSearchFile>,
    pub expanded: Vec<bool>,
    pub offset: usize,
    pub done: bool,
    pub total_files: usize,
    pub total_matches: usize,
    pub visited: usize,
    pub truncated: bool,
    /// Selected row across the flat render list (file headers and
    /// chunk rows interleaved), matching what the screen shows.
    pub selected: usize,
}

impl Default for ContentSearchState {
    fn default() -> Self {
        Self {
            query: String::new(),
            match_case: false,
            regex: false,
            files: Vec::new(),
            expanded: Vec::new(),
            offset: 0,
            done: true,
            total_files: 0,
            total_matches: 0,
            visited: 0,
            truncated: false,
            selected: 0,
        }
    }
}

impl ContentSearchState {
    pub fn has_results(&self) -> bool {
        !self.query.trim().is_empty() && !self.files.is_empty()
    }

    pub fn clear_results(&mut self) {
        self.files.clear();
        self.expanded.clear();
        self.offset = 0;
        self.done = true;
        self.total_files = 0;
        self.total_matches = 0;
        self.visited = 0;
        self.truncated = false;
        self.selected = 0;
    }
}

/// Parse a `/api/file-browser/content-search` response.
pub fn parse_content_search(data: &Value) -> Vec<ContentSearchFile> {
    data.get("files")
        .and_then(Value::as_array)
        .map(|files| files.iter().map(parse_content_file).collect())
        .unwrap_or_default()
}

fn parse_content_file(value: &Value) -> ContentSearchFile {
    let path = value_str(value, &["path"]).unwrap_or_default().to_string();
    let first_match_line = value
        .get("matches")
        .and_then(Value::as_array)
        .and_then(|matches| matches.first())
        .and_then(|m| {
            let line = m.get("line").and_then(Value::as_u64);
            let start = m.get("start_line").and_then(Value::as_u64);
            line.or(start).map(|n| n.max(1) as usize)
        })
        .unwrap_or(1);
    ContentSearchFile {
        name: value_str(value, &["name"]).unwrap_or_default().to_string(),
        path,
        match_count: value
            .get("match_count")
            .and_then(Value::as_u64)
            .unwrap_or(0) as usize,
        chunks: value
            .get("chunks")
            .and_then(Value::as_array)
            .map(|chunks| chunks.iter().map(parse_content_chunk).collect())
            .unwrap_or_default(),
        truncated: value
            .get("truncated")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        first_match_line,
    }
}

fn parse_content_chunk(value: &Value) -> ContentSearchChunk {
    ContentSearchChunk {
        start: value.get("start").and_then(Value::as_u64).unwrap_or(0) as usize,
        end: value.get("end").and_then(Value::as_u64).unwrap_or(0) as usize,
        rows: value
            .get("rows")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| {
                        let line = row.get("line").and_then(Value::as_u64)?;
                        if line == 0 {
                            return None;
                        }
                        Some(ContentSearchRow {
                            line: line as usize,
                            text: value_str(row, &["text"]).unwrap_or_default().to_string(),
                            matched: row.get("matched").and_then(Value::as_bool)?,
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// Flat rows for rendering and selection: each row is either a file
/// header or a content line of an expanded file.
#[derive(Debug, Clone, PartialEq)]
pub enum ContentRow {
    File(usize),
    Line {
        file: usize,
        line: usize,
        matched: bool,
    },
}

/// Build the flat render list for the current expanded map. Webui
/// defaults to expanded files, so fresh results start expanded.
pub fn content_rows(state: &ContentSearchState) -> Vec<ContentRow> {
    let mut rows = Vec::new();
    for (index, file) in state.files.iter().enumerate() {
        rows.push(ContentRow::File(index));
        if state.expanded.get(index).copied().unwrap_or(true) {
            for chunk in &file.chunks {
                for row in &chunk.rows {
                    rows.push(ContentRow::Line {
                        file: index,
                        line: row.line,
                        matched: row.matched,
                    });
                }
            }
        }
    }
    rows
}

/// Run a fresh content search (webui `runContentSearch(append: false)`).
/// `path` scopes the search like the webui location bar.
pub fn run_content_search(
    explorer: &mut FileExplorer,
    api: &WebApiClient,
    append: bool,
) -> Result<(), WebApiError> {
    let query = explorer.filter.trim().to_string();
    let state = &mut explorer.content_search;
    state.query = query.clone();
    if query.is_empty() {
        state.clear_results();
        return Ok(());
    }
    let offset = if append { state.offset } else { 0 };
    let data = api.content_search(
        &explorer.cwd,
        &explorer.root_path,
        &query,
        offset,
        CONTENT_SEARCH_PAGE_SIZE,
        state.match_case,
        state.regex,
    )?;
    let files = parse_content_search(&data);
    state.total_files = data
        .get("total_files")
        .and_then(Value::as_u64)
        .unwrap_or(files.len() as u64) as usize;
    state.total_matches = data
        .get("total_matches")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    state.visited = data.get("visited").and_then(Value::as_u64).unwrap_or(0) as usize;
    state.truncated = data
        .get("truncated")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    state.offset = offset + files.len();
    state.done = !state.truncated || files.is_empty();
    if append {
        state.files.extend(files);
        // Webui keeps the prior expanded state for old files and
        // defaults new ones to expanded.
        state.expanded.resize(state.files.len(), true);
    } else {
        state.files = files;
        state.expanded = vec![true; state.files.len()];
    }
    state.selected = 0;
    Ok(())
}

/// Toggle the expanded state of the file at `index`.
pub fn toggle_content_file(state: &mut ContentSearchState, index: usize) {
    if index < state.files.len() {
        let expanded = state.expanded.get(index).copied().unwrap_or(true);
        set_expanded(state, index, !expanded);
    }
}

fn set_expanded(state: &mut ContentSearchState, index: usize, value: bool) {
    if state.expanded.len() < state.files.len() {
        state.expanded.resize(state.files.len(), true);
    }
    if let Some(slot) = state.expanded.get_mut(index) {
        *slot = value;
    }
}

/// Selected row helper: resolve `ContentRow` at the cursor.
pub fn selected_row(state: &ContentSearchState) -> Option<ContentRow> {
    content_rows(state).into_iter().nth(state.selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_content_search_response() {
        let data = json!({
            "files": [{
                "path": "src/app.rs",
                "name": "app.rs",
                "match_count": 2,
                "truncated": false,
                "matches": [{"id": "m1", "line": 3, "match_start": 0, "match_end": 4}],
                "chunks": [{
                    "start": 2,
                    "end": 4,
                    "match_ids": ["m1"],
                    "rows": [
                        {"line": 2, "matched": false, "text": "before", "match_start": 0, "match_end": 0},
                        {"line": 3, "matched": true, "text": "match here", "match_start": 0, "match_end": 5},
                        {"line": 4, "matched": false, "text": "after", "match_start": 0, "match_end": 0}
                    ]
                }]
            }],
            "total_files": 1,
            "total_matches": 2,
            "visited": 40,
            "truncated": false
        });
        let files = parse_content_search(&data);
        assert_eq!(files.len(), 1);
        let file = &files[0];
        assert_eq!(file.path, "src/app.rs");
        assert_eq!(file.match_count, 2);
        assert_eq!(file.first_match_line, 3);
        assert_eq!(file.chunks.len(), 1);
        assert_eq!(file.chunks[0].rows.len(), 3);
        assert!(file.chunks[0].rows[1].matched);
        assert_eq!(file.chunks[0].rows[1].text, "match here");
    }

    #[test]
    fn content_rows_interleave_headers_and_lines() {
        let mut state = ContentSearchState {
            files: vec![ContentSearchFile {
                path: "a.txt".into(),
                name: "a.txt".into(),
                match_count: 1,
                chunks: vec![ContentSearchChunk {
                    start: 1,
                    end: 1,
                    rows: vec![ContentSearchRow {
                        line: 1,
                        text: "hit".into(),
                        matched: true,
                    }],
                }],
                truncated: false,
                first_match_line: 1,
            }],
            expanded: vec![true],
            ..Default::default()
        };
        let rows = content_rows(&state);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], ContentRow::File(0));
        assert_eq!(
            rows[1],
            ContentRow::Line {
                file: 0,
                line: 1,
                matched: true
            }
        );

        state.expanded = vec![false];
        assert_eq!(content_rows(&state).len(), 1);
    }

    #[test]
    fn toggle_expanded_flips_state() {
        let mut state = ContentSearchState {
            files: vec![ContentSearchFile {
                path: "a.txt".into(),
                name: "a.txt".into(),
                match_count: 1,
                chunks: vec![],
                truncated: false,
                first_match_line: 1,
            }],
            expanded: vec![true],
            ..Default::default()
        };
        toggle_content_file(&mut state, 0);
        assert!(!state.expanded[0]);
        toggle_content_file(&mut state, 0);
        assert!(state.expanded[0]);
        assert_eq!(selected_row(&state), Some(ContentRow::File(0)));
    }

    #[test]
    fn run_content_search_empty_query_clears_without_api() {
        let api = WebApiClient::new("127.0.0.1", 1);
        let mut explorer = FileExplorer::new("/repo");
        explorer.filter = "   ".to_string();
        explorer.content_search.files.push(ContentSearchFile {
            path: "old".into(),
            name: "old".into(),
            match_count: 1,
            chunks: vec![],
            truncated: true,
            first_match_line: 9,
        });
        run_content_search(&mut explorer, &api, false).unwrap();
        assert!(explorer.content_search.files.is_empty());
        assert!(explorer.content_search.done);
    }

    #[test]
    fn run_content_search_replaces_and_appends_results() {
        use std::io::{BufRead as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            for index in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                loop {
                    let mut header = String::new();
                    reader.read_line(&mut header).unwrap();
                    if header.trim().is_empty() {
                        break;
                    }
                }
                assert!(request.contains("/api/file-browser/content-search"));
                let body = if index == 0 {
                    json!({"files":[{"path":"a.rs","name":"a.rs","match_count":1,"matches":[{"start_line":2}],"chunks":[]}],"total_files":2,"total_matches":3,"visited":8,"truncated":true})
                } else {
                    assert!(request.contains("offset=1"));
                    json!({"files":[{"path":"b.rs","name":"b.rs","match_count":2,"matches":[{"line":4}],"chunks":[]}],"truncated":false})
                };
                let body = body.to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
        });
        let api = WebApiClient::new("127.0.0.1", port);
        let mut explorer = FileExplorer::new("/repo");
        explorer.filter = "needle".to_string();
        run_content_search(&mut explorer, &api, false).unwrap();
        assert_eq!(explorer.content_search.offset, 1);
        assert!(!explorer.content_search.done);
        assert_eq!(explorer.content_search.total_files, 2);
        run_content_search(&mut explorer, &api, true).unwrap();
        handle.join().unwrap();
        assert_eq!(explorer.content_search.files.len(), 2);
        assert_eq!(explorer.content_search.expanded, vec![true, true]);
        assert!(explorer.content_search.done);
    }

    #[test]
    fn run_content_search_propagates_a_server_error() {
        use std::io::{BufRead as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header.trim().is_empty() {
                    break;
                }
            }
            let _ = request;
            let body = "{\"error\":\"grep exploded\"}";
            write!(
                stream,
                "HTTP/1.1 500 Internal Server Error\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
        });
        let api = WebApiClient::new("127.0.0.1", port);
        let mut explorer = FileExplorer::new("/repo");
        explorer.filter = "needle".to_string();
        assert!(run_content_search(&mut explorer, &api, false).is_err());
    }
}

#[cfg(test)]
mod coverage_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_drops_rows_with_line_zero_or_missing_matched() {
        let data = json!({
            "files": [{
                "path": "a.txt",
                "name": "a.txt",
                "chunks": [{
                    "rows": [
                        {"line": 0, "matched": true, "text": "line zero drops"},
                        {"line": 5, "matched": true, "text": "kept"},
                        {"line": 6, "text": "missing matched drops"}
                    ]
                }]
            }]
        });
        let files = parse_content_search(&data);
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].chunks[0].rows.len(), 1);
        assert_eq!(files[0].chunks[0].rows[0].line, 5);
    }

    #[test]
    fn run_content_search_append_expands_the_file_list() {
        // The reader's defensive arms: connection 0 hangs up mid-
        // headers (EOF break), connection 1 carries a body
        // (read_exact), connections 2 and 3 are the fresh search and
        // the append. After those four the thread self-flips its
        // listener nonblocking so the next accept returns WouldBlock
        // and the Err arm runs.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            use std::io::{BufRead as _, Read as _, Write as _};
            // Open-ended: after the four expected connections the
            // thread flips its own listener nonblocking between
            // accept calls, so the next accept returns WouldBlock and
            // the Err arm runs. The flip must happen inside the
            // thread: a parked accept never re-checks the flag, and
            // an external flip would deadlock the join below.
            let mut round = 0usize;
            loop {
                if round == 4 {
                    let _ = listener.set_nonblocking(true);
                }
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = std::io::BufReader::new(&stream);
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                let mut content_length = 0usize;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    if header.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = header
                        .trim()
                        .to_ascii_lowercase()
                        .strip_prefix("content-length:")
                    {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut payload = vec![0u8; content_length];
                if content_length > 0 {
                    reader.read_exact(&mut payload).unwrap();
                }
                if round < 2 {
                    // Probes get no answer: 0 already hung up, 1
                    // delivered a bodied request and is dropped.
                    round += 1;
                    continue;
                }
                // Rounds 2 and 3 are the two real responses; index
                // back so the fresh search is truncated and the
                // append closes.
                let served = round - 2;
                let body = json!({
                    "files": [{
                        "path": format!("f{served}.txt"),
                        "name": format!("f{served}.txt"),
                        "chunks": [],
                        "truncated": served == 0,
                        "total_files": 2,
                        "total_matches": 2
                    }],
                    "total_files": 2,
                    "total_matches": 2,
                    "visited": 10,
                    "truncated": served == 0
                })
                .to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
                round += 1;
            }
        });
        // Probe 0: headers without the blank line; hold so the reader
        // parks in the header loop before the drop (a pre-accept
        // close can be discarded from the backlog on macOS).
        use std::io::Write as _;
        {
            let mut probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            probe
                .write_all(b"POST /probe HTTP/1.1\r\nX-Hang: up")
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        // Probe 1: a bodied request so read_exact drains a payload.
        {
            let mut probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            probe
                .write_all(b"POST /probe HTTP/1.1\r\nContent-Length: 4\r\n\r\nbody")
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let api = WebApiClient::new("127.0.0.1", port);
        let mut explorer = FileExplorer::new("/repo");
        explorer.filter = "needle".to_string();
        run_content_search(&mut explorer, &api, false).unwrap();
        let first_files = explorer.content_search.files.len();
        assert_eq!(first_files, 1);
        assert!(!explorer.content_search.done, "truncated continues");
        // Collapse the fresh file, then append: old state survives.
        explorer.content_search.expanded = vec![false];
        run_content_search(&mut explorer, &api, true).unwrap();
        assert_eq!(explorer.content_search.files.len(), 2);
        assert_eq!(explorer.content_search.expanded, vec![false, true]);
        assert!(explorer.content_search.done, "untruncated append closes");
        // The thread self-flipped after connection 4: it exits through
        // the accept-Err arm, so the join returns instead of leaking.
        handle.join().unwrap();
    }

    #[test]
    fn run_content_search_survives_a_probe_and_a_bodied_request() {
        // The reader's defensive arms: connection 0 hangs up mid-headers
        // (EOF break), connection 1 carries a real Content-Length + body
        // (read_exact), connection 2 is the real content-search GET.
        // After those three the thread self-flips its listener
        // nonblocking so the next accept returns WouldBlock and the
        // Err arm runs.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            use std::io::{BufRead as _, Read as _, Write as _};
            let mut kind = 0usize;
            loop {
                if kind == 3 {
                    let _ = listener.set_nonblocking(true);
                }
                let Ok((mut stream, _)) = listener.accept() else {
                    return;
                };
                let mut reader = std::io::BufReader::new(&stream);
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                let mut content_length = 0usize;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    if header.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = header
                        .trim()
                        .to_ascii_lowercase()
                        .strip_prefix("content-length:")
                    {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut payload = vec![0u8; content_length];
                if content_length > 0 {
                    reader.read_exact(&mut payload).unwrap();
                }
                if kind < 2 {
                    // Probes get no answer: connection 0 already hung
                    // up (EOF break fired), connection 1 delivered a
                    // well-formed bodied request and is dropped.
                    kind += 1;
                    continue;
                }
                let body = json!({
                    "files": [],
                    "total_files": 0,
                    "total_matches": 0,
                    "truncated": false
                })
                .to_string();
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
                kind += 1;
            }
        });
        // Probe 0: headers without the blank line; the hold ensures
        // the server parks in the header loop before the drop, so the
        // next read_line returns 0 (EOF break). An immediate close can
        // be discarded from the backlog pre-accept on macOS.
        use std::io::Write as _;
        {
            let mut probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            probe
                .write_all(b"POST /probe HTTP/1.1\r\nX-Hang: up")
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        // Probe 1: a well-formed bodied request so read_exact consumes
        // a real payload.
        {
            let mut probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            probe
                .write_all(b"POST /probe HTTP/1.1\r\nContent-Length: 4\r\n\r\nbody")
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let api = WebApiClient::new("127.0.0.1", port);
        let mut explorer = FileExplorer::new("/repo");
        explorer.filter = "needle".to_string();
        run_content_search(&mut explorer, &api, false).unwrap();
        assert_eq!(explorer.content_search.files.len(), 0);
        assert!(
            explorer.content_search.done,
            "empty untruncated result closes"
        );
        // The thread self-flipped after connection 3: it exits through
        // the accept-Err arm, so the join returns instead of leaking.
        handle.join().unwrap();
    }

    #[test]
    fn set_expanded_grows_a_short_expanded_vector() {
        let mut state = ContentSearchState {
            files: vec![
                ContentSearchFile {
                    path: "a".into(),
                    name: "a".into(),
                    match_count: 0,
                    chunks: vec![],
                    truncated: false,
                    first_match_line: 1,
                },
                ContentSearchFile {
                    path: "b".into(),
                    name: "b".into(),
                    match_count: 0,
                    chunks: vec![],
                    truncated: false,
                    first_match_line: 1,
                },
            ],
            expanded: vec![true],
            ..Default::default()
        };
        // Toggle file 1: the shorter vector must grow first.
        toggle_content_file(&mut state, 1);
        assert_eq!(state.expanded, vec![true, false]);
    }
}

#[cfg(test)]
mod coverage_tests_round2 {
    use super::*;
    use serde_json::json;

    /// Same one-shot server shape as the earlier coverage tests, but
    /// the body omits the total_files/total_matches summary so the
    /// fallbacks (files.len() / 0) run.
    fn search_once(
        body: serde_json::Value,
    ) -> (
        crate::tui::panels::FileExplorer,
        crate::tui::web_api::WebApiClient,
    ) {
        use std::io::{BufRead as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            loop {
                let mut header = String::new();
                reader.read_line(&mut header).unwrap();
                if header.trim().is_empty() {
                    break;
                }
            }
            let response = body.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                response.len(),
                response
            );
        });
        let explorer = FileExplorer::new("/repo");
        let client = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
        (explorer, client)
    }

    #[test]
    fn run_content_search_falls_back_when_the_summary_is_missing() {
        let (mut explorer, client) = search_once(json!({
            "files": [{
                "path": "a.rs",
                "name": "a.rs",
                "match_count": 1,
                "matches": [{"start_line": 2}],
                "chunks": []
            }]
        }));
        explorer.filter = "needle".into();
        run_content_search(&mut explorer, &client, false).unwrap();
        assert_eq!(
            explorer.content_search.total_files, 1,
            "falls back to files.len()"
        );
        assert_eq!(
            explorer.content_search.total_matches, 0,
            "missing matches default 0"
        );
    }
}
