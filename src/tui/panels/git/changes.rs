//! Changes view: diff loading, blame, staging, commit, push/pull/fetch.

use serde_json::Value;

use crate::tui::web_api::{WebApiClient, WebApiError};

use super::{
    parse_blame_authors, parse_diff_lines_with_meta, parse_diff_old_path, GitFileStatus, GitPanel,
};

/// Diff context lines, matching the webui default (`diffContext: 3`)
/// and the server-side clamp (0..=200). Hunk applies resend it so the
/// server regenerates the identical diff the cursor was rendered from.
const DIFF_CONTEXT: usize = 3;

impl GitPanel {
    pub fn refresh_diff(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let file = self
            .files
            .get(self.file_selected)
            .map(|entry| entry.path.clone());
        // The server scopes diffs as `working`, `staged`, or `all` (HEAD).
        let scope = match self
            .files
            .get(self.file_selected)
            .map(|entry| entry.status.clone())
        {
            Some(GitFileStatus::Staged) => "staged",
            _ => "working",
        };
        // Remember the scope the diff was rendered with: hunk applies
        // resend it so the server regenerates the identical diff.
        self.diff_scope = scope.to_string();
        let data = api.git_diff(&self.cwd, scope, file.as_deref())?;
        let (lines, meta) = parse_diff_lines_with_meta(&data);
        self.diff_lines = lines;
        self.diff_meta = meta;
        self.diff_title = file.clone().unwrap_or_else(|| "working tree".to_string());
        // Hunk actions need the `a/` side for the apply-patch header
        // (webui hunkPatch); only a per-file diff carries it.
        self.diff_old_path = file.as_deref().and_then(|_| parse_diff_old_path(&data));
        // A new diff shifts hunk boundaries: reset the hunk cursor.
        self.diff_hunk_selected = 0;
        // A new diff invalidates the diff search matches (line indices
        // shifted); keep the query so re-running `/` resumes it.
        self.diff_search_matches.clear();
        self.diff_search_selected = 0;
        if !self.diff_search_query.trim().is_empty() {
            self.refresh_diff_search_matches();
        }
        // A new diff target invalidates the blame cache (webui keeps
        // blame per file path).
        if self.blame_path != file {
            self.blame_authors.clear();
        }
        // Blame follows the loaded diff (the webui keeps blame per file
        // path); reload it whenever a diff refreshes with blame shown.
        let Some(file) = file.as_deref().filter(|_| self.show_blame) else {
            return Ok(());
        };
        self.load_blame(api, file)
    }

    /// Toggle blame annotation (webui `gitShortcuts.blame`, prefix `m`).
    /// Blame follows the diff being shown (webui `view.file`), not the
    /// raw selection: in the TUI the selection can move after Enter
    /// loaded a diff, and webui blame annotates the shown file.
    /// Toggling off keeps the cache in case blame is re-enabled.
    pub fn toggle_blame(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        self.show_blame = !self.show_blame;
        if !self.show_blame {
            return Ok(());
        }
        // The shown file is the diff target if one is loaded, else the
        // selection (Enter will load that diff next).
        let shown = self.diff_title.trim();
        let known = shown != "working tree" && self.files.iter().any(|entry| entry.path == shown);
        let file = if known {
            shown.to_string()
        } else {
            self.files
                .get(self.file_selected)
                .map(|entry| entry.path.clone())
                .ok_or_else(|| {
                    self.show_blame = false;
                    WebApiError::Io("no file selected".to_string())
                })?
        };
        // A failed blame load must not leave the toggle on with no
        // annotations: revert like the webui's lazy blame never turned on.
        if let Err(err) = self.load_blame(api, &file) {
            self.show_blame = false;
            return Err(err);
        }
        Ok(())
    }

    /// Fetch and parse `--line-porcelain` blame for the file, mirroring
    /// the webui `parseBlame` (final line number → author).
    fn load_blame(&mut self, api: &WebApiClient, file: &str) -> Result<(), WebApiError> {
        if self.blame_path.as_deref() == Some(file) && !self.blame_authors.is_empty() {
            return Ok(());
        }
        let data = api.git_blame(&self.cwd, file, "working")?;
        let text = data.get("text").and_then(Value::as_str).unwrap_or("");
        self.blame_authors = parse_blame_authors(text);
        self.blame_path = Some(file.to_string());
        Ok(())
    }

    /// Stage the selected file. The webui `stageFile` action always stages
    /// (no toggle), so this does too; unstage is the separate `u` shortcut.
    pub fn stage_selected(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let paths = self
            .selected_file()
            .map(|entry| vec![entry.path.clone()])
            .ok_or_else(|| WebApiError::Io("no file selected".to_string()))?;
        api.git_stage(&self.cwd, &paths)?;
        self.refresh_view(api)
    }

    /// Toggle all: if anything is staged, unstage it; otherwise stage
    /// every unstaged and untracked file. Mirrors the webui
    /// `toggleStageAll` behind prefix `G`.
    pub fn toggle_stage_all(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let staged: Vec<String> = self
            .files
            .iter()
            .filter(|entry| entry.status == GitFileStatus::Staged)
            .map(|entry| entry.path.clone())
            .collect();
        if !staged.is_empty() {
            api.git_unstage(&self.cwd, &staged)?;
            return self.refresh_view(api);
        }
        let paths = self
            .files
            .iter()
            .filter(|entry| entry.status != GitFileStatus::Staged)
            .map(|entry| entry.path.clone())
            .collect::<Vec<_>>();
        if paths.is_empty() {
            return Ok(());
        }
        api.git_stage(&self.cwd, &paths)?;
        self.refresh_view(api)
    }

    /// Unstage the selected file. The webui `unstageFile` action always
    /// unstages (no toggle), so this is the explicit counterpart to
    /// `stage_selected`.
    pub fn unstage_selected(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let paths = self
            .selected_file()
            .map(|entry| vec![entry.path.clone()])
            .ok_or_else(|| WebApiError::Io("no file selected".to_string()))?;
        api.git_unstage(&self.cwd, &paths)?;
        self.refresh_view(api)
    }

    /// Move the hunk cursor (gap 14). `J`/`K` parity with the webui
    /// per-hunk buttons: the cursor walks the `@@` headers of the
    /// loaded Changes diff, wrapping around. Returns false when the
    /// diff has no hunks (nothing selectable).
    pub fn move_hunk_selection(&mut self, delta: i32) -> bool {
        let hunks = self.hunk_headers();
        if hunks.is_empty() {
            return false;
        }
        let len = hunks.len();
        let current = self.diff_hunk_selected.min(len - 1);
        let next = if delta >= 0 {
            (current + delta.unsigned_abs() as usize) % len
        } else {
            (current + len - delta.unsigned_abs() as usize % len) % len
        };
        self.diff_hunk_selected = next;
        true
    }

    /// Indices of the `@@` chunk-header lines in the loaded diff.
    fn hunk_headers(&self) -> Vec<usize> {
        self.diff_meta
            .iter()
            .enumerate()
            .filter_map(|(index, meta)| meta.is_none().then_some(index))
            .collect()
    }

    /// Number of `@@` hunks in the loaded diff.
    pub fn hunk_count(&self) -> usize {
        self.hunk_headers().len()
    }

    /// Index (into `diff_lines`) of the `@@` header the hunk cursor
    /// sits on, for highlighting. None when the diff has no hunks.
    pub fn hunk_cursor_line(&self) -> Option<usize> {
        self.hunk_headers().get(self.diff_hunk_selected).copied()
    }

    /// Apply the webui hunk action to the hunk under the cursor
    /// (`stageHunk` when the shown diff is working-tree scope,
    /// `unstageHunk` reverse-cached when it is staged). Uses the webui
    /// chunk selector ({file, chunk_index, scope, context}) instead of a
    /// client-rebuilt patch: the server regenerates the diff with the
    /// same args and rebuilds the exact chunk, preserving markers like
    /// `\ No newline at end of file` that line-by-line rebuilds drop.
    pub fn apply_hunk_action(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let file = self.diff_title.trim().to_string();
        if file.is_empty() || file == "working tree" {
            return Err(WebApiError::Io(
                "select a file to load its diff".to_string(),
            ));
        }
        let hunks = self.hunk_headers();
        if hunks.is_empty() {
            return Err(WebApiError::Io("no hunk selected".to_string()));
        }
        let index = self.diff_hunk_selected.min(hunks.len() - 1);
        // Working-tree diff stages the hunk; a staged diff unstages it
        // (webui renders exactly one button per scope, never a toggle).
        let staged = self
            .files
            .iter()
            .find(|entry| entry.path == file)
            .is_some_and(|entry| entry.status == GitFileStatus::Staged);
        api.git_apply_patch_chunk(
            &self.cwd,
            &file,
            index,
            &self.diff_scope,
            DIFF_CONTEXT,
            staged,
            true,
        )?;
        self.refresh_view(api)?;
        self.refresh_diff(api)
    }

    pub fn discard_selected(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        let paths = self
            .selected_file()
            .map(|entry| vec![entry.path.clone()])
            .ok_or_else(|| WebApiError::Io("no file selected".to_string()))?;
        api.git_discard(&self.cwd, &paths)?;
        self.refresh_view(api)
    }

    pub fn stash_changes(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        api.git_stash(&self.cwd)?;
        self.refresh_view(api)
    }

    pub fn commit(
        &mut self,
        api: &WebApiClient,
        title: &str,
        amend: bool,
    ) -> Result<(), WebApiError> {
        api.git_commit(&self.cwd, title, None, amend)?;
        self.refresh_view(api)
    }

    pub fn pull(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        api.git_pull(&self.cwd, "rebase")?;
        self.refresh_view(api)
    }

    pub fn push(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        api.git_push(&self.cwd, "regular")?;
        self.refresh_view(api)
    }

    pub fn fetch(&mut self, api: &WebApiClient) -> Result<(), WebApiError> {
        api.git_fetch(&self.cwd, None)?;
        self.refresh_view(api)
    }
}

#[cfg(test)]
mod coverage_tests {
    use super::*;
    use crate::tui::panels::git::GitDiffLineMeta;
    use serde_json::json;

    /// Read one HTTP request (request line + headers) off `reader`,
    /// draining any Content-Length body so the next request starts
    /// clean. Shared by the probe and real-request connections so the
    /// body-drain arm has a single site (the bodied probe fires it).
    fn read_request(reader: &mut std::io::BufReader<std::net::TcpStream>) -> String {
        use std::io::{BufRead as _, Read as _};
        let mut request = String::new();
        reader.read_line(&mut request).unwrap();
        let mut content_length = 0usize;
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
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
        request
    }

    /// Drive `refresh_diff` against a one-shot JSON server returning
    /// `body` for the git diff call, then check the panel state.
    fn refresh_with(body: serde_json::Value) -> (GitPanel, std::thread::JoinHandle<()>) {
        use std::io::Write as _;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            // Connection 0 is a bodied probe (sent by the main thread
            // below): it drives the payload read_exact, which the
            // bodyless diff GET never does.
            let (probe, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(probe.try_clone().unwrap());
            let _ = read_request(&mut reader);
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let request = read_request(&mut reader);
            assert!(request.starts_with("GET /api/git-ui/diff"), "{request}");
            let response = body.to_string();
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                response.len(),
                response
            )
            .unwrap();
        });
        // The probe connection: send the bodied request, hold briefly
        // so the server's reader parks in the header loop before the
        // drop (a pre-accept close can be discarded on macOS).
        {
            use std::io::Write as _;
            let mut probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            probe
                .write_all(b"POST /probe HTTP/1.1\r\nContent-Length: 4\r\n\r\nbody")
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let api = WebApiClient::new("127.0.0.1", port);
        let mut panel = GitPanel::new("/repo");
        panel.diff_search_active = true;
        panel.diff_search_query = "needle".into();
        panel.diff_search_matches = vec![2, 7];
        panel.diff_search_selected = 1;
        panel.diff_hunk_selected = 3;
        panel.show_blame = false;
        panel.blame_path = Some("stale.rs".into());
        panel.files.push(crate::tui::panels::git::GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Unstaged,
        });
        panel.refresh_diff(&api).unwrap();
        (panel, handle)
    }

    #[test]
    fn refresh_diff_resumes_the_search_and_clears_stale_blame() {
        let body = json!({
            "files": [{
                "path": "a.rs",
                "chunks": [{
                    "header": "@@ -1,2 +1,2 @@",
                    "lines": [
                        {"line_type": "context", "content": " needle", "new_line_number": 1},
                        {"line_type": "add", "content": " added", "new_line_number": 2}
                    ]
                }]
            }]
        });
        let (panel, handle) = refresh_with(body);
        handle.join().unwrap();
        assert!(panel.diff_search_active, "bar stays open");
        assert_eq!(panel.diff_search_query, "needle", "query kept for resume");
        assert_eq!(panel.diff_search_matches, vec![1], "matches recomputed");
        assert_eq!(panel.diff_search_selected, 0);
        assert_eq!(panel.diff_hunk_selected, 0, "hunk cursor reset");
        assert_eq!(panel.diff_title, "a.rs");
        assert!(panel.blame_authors.is_empty(), "blame cache dropped");
    }

    #[test]
    fn refresh_with_an_empty_diff_response_keeps_the_selected_title() {
        // git_diff is a GET, so the fake server sees no request body:
        // its reader drains straight to the blank line and skips the
        // payload read. An empty diff response keeps the selected
        // file's title and zeroes the lines without panicking.
        let (panel, handle) = refresh_with(json!({ "files": [] }));
        handle.join().unwrap();
        assert_eq!(panel.diff_title, "a.rs", "selected file keeps its title");
        assert_eq!(panel.diff_lines.len(), 0);
    }

    #[test]
    fn fetch_posts_a_bodied_request_then_refreshes_status_and_diff() {
        // fetch() = POST git_fetch (request body drives the server's
        // read_exact) + GET status + GET diff. One loop server answers
        // all three, keyed by the request line.
        use std::io::{BufRead as _, Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                if reader.read_line(&mut request).unwrap_or(0) == 0 {
                    continue;
                }
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
                // The probe socket is closed by now: its 100ms hold
                // ended and the header-loop EOF break fired, so writing
                // a response races the close and can EPIPE on macOS
                // loopback (first write after FIN usually squeaks
                // through, sometimes not). The probe only drives the
                // EOF break, it never reads a response — skip the write.
                if request.starts_with("POST /probe") {
                    continue;
                }
                let response = if request.starts_with("POST /api/git-ui/fetch") {
                    "{\"ok\":true}".to_string()
                } else if request.starts_with("GET /api/git-ui/status") {
                    "{\"branch\":\"main\",\"files\":[]}".to_string()
                } else {
                    "{\"files\":[]}".to_string()
                };
                write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    response.len(),
                    response
                )
                .unwrap();
            }
        });
        // Probe A: connect, hold, drop with no bytes: the request-line
        // read returns 0 and the continue arm runs.
        {
            let probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
            drop(probe);
        }
        // Probe B: headers without the blank line; the hold parks the
        // reader in the header loop so the drop fires the EOF break.
        {
            use std::io::Write as _;
            let mut probe = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            probe
                .write_all(b"POST /probe HTTP/1.1\r\nX-Hang: up")
                .unwrap();
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        let api = WebApiClient::new("127.0.0.1", port);
        let mut panel = GitPanel::new("/repo");
        panel.fetch(&api).unwrap();
        assert_eq!(panel.branch, "main");
        assert_eq!(panel.files.len(), 0);
        assert_eq!(panel.diff_title, "working tree");
    }

    #[test]
    fn apply_hunk_action_without_hunks_reports_no_selection() {
        let api = WebApiClient::new("127.0.0.1", 1);
        let mut panel = GitPanel::new("/repo");
        // A working-tree target has no file to patch.
        panel.diff_title = "working tree".into();
        let err = panel.apply_hunk_action(&api).unwrap_err();
        assert!(err.to_string().contains("select a file"));
        // A file target with no hunks (context-only diff) is refused.
        panel.diff_title = "flat.rs".into();
        panel.diff_lines = vec![" no hunks here".into()];
        panel.diff_meta = vec![Some(GitDiffLineMeta {
            old_line: Some(1),
            new_line: Some(1),
        })];
        let err = panel.apply_hunk_action(&api).unwrap_err();
        assert!(matches!(err, WebApiError::Io(ref msg) if msg == "no hunk selected"));
    }

    #[test]
    fn apply_hunk_action_sends_the_chunk_selector_body() {
        // Hunk applies use the webui chunk selector so the server
        // regenerates the patch (preserving `\ No newline at end of
        // file`); the client must send file, chunk_index, scope, and
        // context in the apply-patch body.
        use std::io::{BufRead as _, Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                if reader.read_line(&mut request).unwrap_or(0) == 0 {
                    continue;
                }
                let mut content_length = 0usize;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
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
                let full = format!("{request}{}", String::from_utf8_lossy(&payload));
                let _ = tx.send(full);
                let response = if request.starts_with("POST /api/git-ui/apply-patch") {
                    "{\"ok\":true}".to_string()
                } else if request.starts_with("GET /api/git-ui/status") {
                    "{\"branch\":\"main\",\"files\":[]}".to_string()
                } else {
                    "{\"files\":[]}".to_string()
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    response.len(),
                    response
                );
            }
        });
        // A dropped connection exercises the accept loop's EOF continue
        // arm before the real request arrives.
        let ghost = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        drop(ghost);
        let api = WebApiClient::new("127.0.0.1", port);
        let mut panel = GitPanel::new("/repo");
        panel.diff_title = "a.rs".into();
        panel.diff_scope = "working".into();
        panel.diff_lines = vec![
            "@@ -1,2 +1,3 @@".into(),
            " ctx".into(),
            "@@ -9,2 +9,3 @@".into(),
            " tail".into(),
        ];
        panel.diff_meta = vec![None, None, None, None];
        panel.diff_hunk_selected = 1;
        panel.files.push(crate::tui::panels::git::GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Unstaged,
        });
        panel.apply_hunk_action(&api).unwrap();
        let apply_request = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert!(
            apply_request.starts_with("POST /api/git-ui/apply-patch"),
            "{apply_request}"
        );
        assert!(apply_request.contains("\"file\":\"a.rs\""));
        assert!(apply_request.contains("\"chunk_index\":1"));
        assert!(apply_request.contains("\"scope\":\"working\""));
        assert!(apply_request.contains("\"context\":3"));
        // Unstaged file: stage the hunk (cached, not reverse).
        assert!(apply_request.contains("\"cached\":true"));
        assert!(apply_request.contains("\"reverse\":false"));
        assert!(
            !apply_request.contains("\"patch\""),
            "no rebuilt patch text"
        );
    }
}

#[cfg(test)]
mod coverage_tests_round2 {
    use super::super::GitFileEntry;
    use super::*;

    fn panel() -> GitPanel {
        let mut p = GitPanel::new("/repo");
        p.files = vec![
            GitFileEntry {
                path: "a.rs".into(),
                status: GitFileStatus::Staged,
            },
            GitFileEntry {
                path: "b.rs".into(),
                status: GitFileStatus::Unstaged,
            },
        ];
        p
    }

    fn dead_client() -> crate::tui::web_api::WebApiClient {
        // Port 1 refuses connections: every api call errors without a
        // server thread.
        crate::tui::web_api::WebApiClient::new("127.0.0.1", 1)
    }

    /// One-shot server that records the request line before answering
    /// the diff call with `body`.
    fn diff_server(
        body: serde_json::Value,
    ) -> (
        crate::tui::web_api::WebApiClient,
        std::sync::mpsc::Receiver<String>,
    ) {
        use std::io::{BufRead as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
            for _ in 0..64 {
                let mut header = String::new();
                if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                    break;
                }
            }
            let _ = tx.send(request);
            let response = body.to_string();
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                response.len(),
                response
            );
        });
        (
            crate::tui::web_api::WebApiClient::new("127.0.0.1", port),
            rx,
        )
    }

    #[test]
    fn refresh_diff_scopes_a_staged_file_as_staged() {
        let (api, request_rx) = diff_server(serde_json::json!({"files": []}));
        let mut p = panel();
        p.file_selected = 0;
        p.refresh_diff(&api).unwrap();
        let request = request_rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        assert!(
            request.contains("scope=staged"),
            "staged file diffs staged: {request}"
        );
        assert_eq!(p.diff_title, "a.rs");
    }

    #[test]
    fn stage_unstage_and_toggle_guards_fire_without_selection() {
        let api = dead_client();
        let mut p = panel();
        p.file_selected = 99;
        assert!(p.stage_selected(&api).is_err());
        assert!(p.unstage_selected(&api).is_err());
        assert!(p.discard_selected(&api).is_err());
    }

    #[test]
    fn toggle_all_unstages_when_anything_is_staged() {
        let api = dead_client();
        let mut p = panel();
        p.file_selected = 0;
        // Staged file present: toggle-all takes the unstage branch,
        // which fails against the dead api.
        let result = p.toggle_stage_all(&api);
        assert!(result.is_err());
    }

    #[test]
    fn toggle_all_stages_when_nothing_is_staged() {
        let api = dead_client();
        let mut p = panel();
        p.files[0].status = GitFileStatus::Unstaged;
        let result = p.toggle_stage_all(&api);
        assert!(result.is_err(), "dead api fails the stage call");
    }

    #[test]
    fn stash_commit_pull_push_fetch_and_discard_hit_the_api() {
        let api = dead_client();
        let mut p = panel();
        p.file_selected = 1;
        assert!(p.stash_changes(&api).is_err());
        assert!(p.commit(&api, "title", false).is_err());
        assert!(p.commit(&api, "title", true).is_err());
        assert!(p.pull(&api).is_err());
        assert!(p.push(&api).is_err());
        assert!(p.fetch(&api).is_err());
        assert!(p.discard_selected(&api).is_err());
    }

    #[test]
    fn toggle_blame_off_keeps_the_cache_and_on_hits_the_api() {
        let api = dead_client();
        let mut p = panel();
        p.show_blame = true;
        p.blame_authors = std::collections::HashMap::from([(0usize, "alice".to_string())]);
        // Toggling off returns before any api call.
        p.toggle_blame(&api).unwrap();
        assert!(!p.show_blame);
        assert_eq!(
            p.blame_authors.get(&0).map(String::as_str),
            Some("alice"),
            "cache kept"
        );
        // Toggling on hits the api; the dead client fails and blame
        // resets so the panel does not show a half-loaded state.
        assert!(p.toggle_blame(&api).is_err());
        assert!(!p.show_blame, "failed blame load resets the flag");
    }
}

#[cfg(test)]
mod coverage_tests_round3 {
    use super::super::GitFileEntry;
    use super::*;

    pub(super) fn panel_with_hunks() -> GitPanel {
        use crate::tui::panels::git::parse_diff_lines_with_meta;
        let mut p = GitPanel::new("/repo");
        p.files = vec![GitFileEntry {
            path: "a.rs".into(),
            status: GitFileStatus::Staged,
        }];
        p.file_selected = 0;
        p.diff_title = "a.rs".to_string();
        let diff = serde_json::json!({
            "files": [{
                "path": "a.rs",
                "chunks": [{
                    "header": "@@ -1,2 +1,3 @@",
                    "lines": [
                        {"line_type": "normal", "content": " context", "new_line_number": 1},
                        {"line_type": "delete", "content": "-old", "old_line_number": 2},
                        {"line_type": "add", "content": "+new", "new_line_number": 2}
                    ]
                }]
            }]
        });
        let (lines, meta) = parse_diff_lines_with_meta(&diff);
        p.diff_lines = lines;
        p.diff_meta = meta;
        assert!(p.hunk_count() >= 1, "diff parses into at least one hunk");
        p
    }

    #[test]
    fn apply_hunk_action_refreshes_view_and_diff_after_the_apply() {
        // A one-shot server that answers every request with an empty
        // payload: the apply call, the refresh, and the diff reload
        // all ride the same connection sequence (apply_hunk_action
        // chains refresh_view + refresh_diff after a successful apply).
        use std::io::{BufRead as _, Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                reader.read_line(&mut request).unwrap();
                let mut content_length = 0usize;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                        break;
                    }
                    if let Some(value) = header.trim().strip_prefix("Content-Length:") {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let response = if request.contains("apply-patch") {
                    "{}"
                } else {
                    r#"{"diff":[]}"#
                };
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    response.len(),
                    response
                );
                let _ = stream.flush();
            }
        });
        let api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
        let mut p = panel_with_hunks();
        p.apply_hunk_action(&api).unwrap();
        assert_eq!(
            p.diff_title, "working tree",
            "diff reloaded after the apply"
        );
    }
}

#[cfg(test)]
mod coverage_tests_round4 {
    use super::*;

    #[test]
    fn fake_server_accept_loop_survives_a_closed_connection() {
        // A client that connects and drops without a request line hits
        // the read_line == 0 arm; the loop must continue to the next
        // accept so the real request still gets served.
        use std::io::{BufRead as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            while let Ok((mut stream, _)) = listener.accept() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                if reader.read_line(&mut request).unwrap_or(0) == 0 {
                    continue;
                }
                for _ in 0..64 {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                        break;
                    }
                }
                let body = r#"{"files":[]}"#;
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.flush();
            }
        });
        // Connect and drop immediately: the accept loop sees EOF.
        let ghost = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        drop(ghost);
        // The next client still gets served.
        let api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
        let mut p = GitPanel::new("/repo");
        p.refresh_diff(&api).unwrap();
        assert_eq!(p.diff_title, "working tree");
    }
}

#[cfg(test)]
mod coverage_tests_round7 {

    #[test]
    fn apply_hunk_action_surfaces_apply_and_refresh_errors() {
        // Dead API: the apply request itself fails.
        let mut p = super::coverage_tests_round3::panel_with_hunks();
        let dead = crate::tui::web_api::WebApiClient::new("127.0.0.1", 1);
        assert!(p.apply_hunk_action(&dead).is_err());

        // One-shot server answers the apply, then the listener drops:
        // the follow-up refresh_view fails.
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
                if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                    break;
                }
            }
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{}}"
            );
            let _ = stream.flush();
        });
        let api = crate::tui::web_api::WebApiClient::new("127.0.0.1", port);
        let mut p = super::coverage_tests_round3::panel_with_hunks();
        assert!(p.apply_hunk_action(&api).is_err());
    }
}
