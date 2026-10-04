//! End-to-end tests driving the real axum server with the TUI client.
//! End-to-end tests driving the real axum server with the TUI's
//! `WebApiClient`, `FileExplorer`, and `GitPanel` against a real
//! temp git repository. These verify the loopback contract the TUI
//! depends on: loopback + `localhost_no_auth` auth, and the exact
//! request/response shapes the TUI parsers expect.
use super::*;
use crate::lsp::LspRegistry;
use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use herdr_webui::tui::panels::{FileExplorer, GitFileStatus, GitPanel, GitView};
use herdr_webui::tui::web_api::WebApiClient;

fn temp_git_repo() -> PathBuf {
    // Fixture dirs must be unique per call even when tests run in
    // parallel inside one process: the macOS clock has ~1us resolution,
    // so pid + timestamp alone can collide (two tokio worker threads
    // sampled the same microsecond on a CI runner and shared one repo:
    // "remote origin already exists" / half-mutated file status). The
    // atomic counter is unique per call within the process; the pid
    // keeps separate processes apart.
    static FIXTURE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = FIXTURE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "herdr-tui-e2e-repo-{}-{}-{}",
        std::process::id(),
        seq,
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let run = |args: &[&str]| {
        let mut attempt = 0;
        loop {
            let output = Command::new("git").arg("-C").arg(&dir).args(args).output();
            let detail = match &output {
                Ok(out) if out.status.success() => return,
                Ok(out) => format!(
                    "exit={:?} stderr={}",
                    out.status.code(),
                    String::from_utf8_lossy(&out.stderr).trim()
                ),
                Err(err) => err.to_string(),
            };
            attempt += 1;
            if attempt >= 3 {
                panic!("git {args:?} failed in test repo: {detail}");
            }
            std::thread::sleep(std::time::Duration::from_millis(100 * attempt as u64));
        }
    };
    run(&["init", "-q"]);
    run(&["config", "user.email", "tui@test.local"]);
    run(&["config", "user.name", "TUI Test"]);
    std::fs::write(dir.join("readme.md"), "hello\n").unwrap();
    run(&["add", "."]);
    run(&["commit", "-q", "-m", "init"]);
    std::fs::write(dir.join("readme.md"), "hello\nworld\n").unwrap();
    std::fs::write(dir.join("new_file.rs"), "fn main() {}\n").unwrap();
    // A bare sibling repo acts as "origin" so fetch/pull/push have a
    // real remote to talk to in the round-trip test. It derives from the
    // repo dir name, so it is unique per fixture call exactly like the
    // repo itself.
    let bare = std::env::temp_dir().join(
        dir.file_name()
            .unwrap()
            .to_string_lossy()
            .replace("herdr-tui-e2e-repo-", "herdr-tui-e2e-bare-"),
    );
    let bare_str = bare.to_string_lossy().to_string();
    // The runner environment can hit transient git failures (packfile
    // refresh races right after the commit above). Retry like the other
    // setup commands instead of failing the whole matrix job.
    let mut bare_attempt = 0;
    loop {
        let output = Command::new("git")
            .arg("clone")
            .arg("-q")
            .arg("--bare")
            .arg(&dir)
            .arg(&bare)
            .output();
        match output {
            Ok(out) if out.status.success() => break,
            Ok(out) => {
                bare_attempt += 1;
                if bare_attempt >= 3 {
                    panic!(
                        "git clone --bare failed in test setup: {}",
                        String::from_utf8_lossy(&out.stderr).trim()
                    );
                }
            }
            Err(err) => {
                bare_attempt += 1;
                if bare_attempt >= 3 {
                    panic!("git clone --bare failed in test setup: {err}");
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(100 * bare_attempt as u64));
    }
    run(&["remote", "add", "origin", &bare_str]);
    run(&["push", "-q", "-u", "origin", "HEAD"]);
    run(&["config", "pull.rebase", "true"]);
    std::thread::sleep(std::time::Duration::from_millis(1));
    dir
}

fn localhost_no_auth_state(default_folder: PathBuf) -> WebState {
    let bind = DEFAULT_BIND.parse::<SocketAddr>().unwrap();
    let (rebind_tx, _) = tokio::sync::watch::channel(ListenEndpoint {
        bind,
        tls_mode: TlsMode::Auto,
    });
    let (settings_tx, _) = tokio::sync::broadcast::channel(16);
    WebState {
        api_socket: Some(PathBuf::from("/tmp/default-api.sock")),
        client_socket: Some(PathBuf::from("/tmp/default-client.sock")),
        session_name: None,
        backend_mode: BackendMode::ExternalHerdr,
        _builtin_backend: None,
        builtin_sessions: Arc::new(Mutex::new(HashMap::new())),
        closed_builtin_sessions: Arc::new(Mutex::new(HashSet::new())),
        promoted_temporary_tabs: Arc::new(Mutex::new(HashMap::new())),
        builtin_start_lock: Arc::new(Mutex::new(())),
        herdr_bin: "herdr".to_string(),
        auth: Arc::new(Mutex::new(AuthConfig {
            user: None,
            password: None,
            localhost_no_auth: true,
            token: "e2e-token".to_string(),
            token_expires_at: crate::auth::never_expires_at(),
            session_expiration_minutes: crate::auth::DEFAULT_SESSION_EXPIRATION_MINUTES,
        })),
        login_limiter: Arc::new(LoginRateLimiter::new()),
        server_settings: Arc::new(Mutex::new(RuntimeServerSettings {
            bind,
            tls_mode: TlsMode::Auto,
            user: None,
            password: None,
            localhost_no_auth: true,
            session_expiration_minutes: crate::auth::DEFAULT_SESSION_EXPIRATION_MINUTES,
            no_sleep_auto_cooldown_seconds: 60,
            backend_mode: BackendMode::ExternalHerdr,
            builtin_shell: None,
            default_folder: default_folder.to_string_lossy().to_string(),
            builtin_backend_enabled: true,
            external_herdr_backend_enabled: true,
            jcode_detection_variant: JcodeDetectionVariant::default(),
            log_level: LogLevel::default(),
            lsp: lsp::LspSettings::default(),
            recent_workspaces: Vec::new(),
        })),
        no_sleep: Arc::new(Mutex::new(NoSleepState::default())),
        rebind_tx,
        settings_tx,
        workspace_orders: Arc::new(Mutex::new(HashMap::new())),
        lsp: Arc::new(LspRegistry::new(Default::default())),
        terminal_hub: Arc::new(crate::terminal_hub::TerminalHub::new()),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tui_web_api_client_round_trips_file_tree_and_git_panels() {
    let repo = temp_git_repo();
    let state = localhost_no_auth_state(repo.clone());
    let app = app_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let api = WebApiClient::new("127.0.0.1", addr.port());
    let cwd = repo.to_string_lossy().to_string();

    // The TUI client is blocking; run it on the blocking pool so the
    // async server keeps making progress while it waits.
    let result = tokio::task::spawn_blocking(move || tui_round_trip_assertions(&api, &cwd))
        .await
        .unwrap();
    result.unwrap_or_else(|err| panic!("tui round trip failed: {err}"));
    server.abort();
    let _ = std::fs::remove_dir_all(&repo);
    // The bare "origin" sibling shares the repo's timestamped name.
    let bare = std::env::temp_dir().join(
        repo.file_name()
            .unwrap()
            .to_string_lossy()
            .replace("herdr-tui-e2e-repo-", "herdr-tui-e2e-bare-"),
    );
    let _ = std::fs::remove_dir_all(&bare);
}

fn tui_round_trip_assertions(api: &WebApiClient, cwd: &str) -> Result<(), String> {
    // FileExplorer: tree listing via the TUI parser.
    let mut explorer = FileExplorer::new(cwd);
    explorer.refresh(api).unwrap();
    let names: Vec<&str> = explorer.entries.iter().map(|e| e.name.as_str()).collect();
    assert!(
        names.contains(&"readme.md"),
        "tree missing readme.md: {names:?}"
    );
    assert!(
        names.contains(&"new_file.rs"),
        "tree missing new_file.rs: {names:?}"
    );
    assert!(names.contains(&".git"), "tree missing .git: {names:?}");

    // FileExplorer: file preview.
    explorer.selected = names.iter().position(|n| *n == "readme.md").unwrap();
    explorer.open_preview(api).unwrap();
    let preview = explorer.preview.clone();
    assert_eq!(preview.path.as_deref(), Some("readme.md"));
    assert!(preview.content.contains("world"));
    assert!(!preview.binary);

    // GitPanel: status parses into staged/unstaged/untracked lists.
    let mut panel = GitPanel::new(cwd);
    panel.refresh(api).unwrap();
    assert_eq!(panel.state, "dirty");
    let has_readme = panel
        .files
        .iter()
        .any(|entry| entry.path == "readme.md" && entry.status == GitFileStatus::Unstaged);
    assert!(
        has_readme,
        "expected unstaged readme.md, got {:?}",
        panel
            .files
            .iter()
            .map(|f| (&f.path, &f.status))
            .collect::<Vec<_>>()
    );
    assert!(
        panel.files.iter().any(|entry| entry.path == "new_file.rs"),
        "expected untracked new_file.rs"
    );

    // GitPanel: diff for the modified file renders add/delete lines.
    panel.file_selected = panel
        .files
        .iter()
        .position(|entry| entry.path == "readme.md")
        .unwrap();
    panel.refresh_diff(api).unwrap();
    assert!(
        panel
            .diff_lines
            .iter()
            .any(|line| line.starts_with('+') && line.contains("world")),
        "diff missing +world line: {:?}",
        panel.diff_lines
    );

    // GitPanel: blame toggle (webui blame: KeyM) fetches the author
    // map for the diff target from /api/git-ui/blame, keyed by the
    // new-side line number of the +world line.
    assert!(!panel.show_blame);
    panel.toggle_blame(api).unwrap();
    assert!(panel.show_blame);
    assert_eq!(panel.blame_path.as_deref(), Some("readme.md"));
    // readme.md is "hello\nworld\n". With ref "working" the server
    // blames `--contents <file>`: uncommitted lines attribute to the
    // synthetic "External file (--contents)" author, committed
    // lines to the repo author. Line 2 ("world") is the local
    // edit; line 1 ("hello") comes from the init commit.
    assert_eq!(
        panel.blame_authors.get(&2).map(String::as_str),
        Some("External file (--contents)"),
        "blame must attribute the uncommitted line 2 to the working-tree author: {:?}",
        panel.blame_authors
    );
    assert_eq!(
        panel.blame_authors.get(&1).map(String::as_str),
        Some("TUI Test"),
        "blame must attribute committed line 1 to the repo author: {:?}",
        panel.blame_authors
    );
    assert!(
        panel
            .diff_meta
            .iter()
            .any(|meta| meta.as_ref().is_some_and(|m| m.new_line == Some(2))),
        "diff meta must carry new_line numbers for blame: {:?}",
        panel.diff_meta
    );
    // Toggle off: state flips, cache is kept for the same file.
    panel.toggle_blame(api).unwrap();
    assert!(!panel.show_blame);
    assert_eq!(panel.blame_authors.len(), 2);

    // GitPanel: stage the modified file, then status shows it staged.
    panel.stage_selected(api).unwrap();
    assert!(panel
        .files
        .iter()
        .any(|entry| entry.path == "readme.md" && matches!(entry.status, GitFileStatus::Staged)));

    // GitPanel: unstageSelected always unstages (webui parity, no
    // toggle), and stageSelected always stages.
    panel.unstage_selected(api).unwrap();
    assert!(panel
        .files
        .iter()
        .any(|entry| entry.path == "readme.md" && matches!(entry.status, GitFileStatus::Unstaged)));
    panel.stage_selected(api).unwrap();
    assert!(panel
        .files
        .iter()
        .any(|entry| entry.path == "readme.md" && matches!(entry.status, GitFileStatus::Staged)));

    // GitPanel: toggleStageAll unstages everything when something is
    // staged, then stages everything when nothing is (webui G).
    panel.toggle_stage_all(api).unwrap();
    assert!(
        !panel
            .files
            .iter()
            .any(|entry| matches!(entry.status, GitFileStatus::Staged)),
        "toggle with staged entries must unstage them"
    );
    panel.toggle_stage_all(api).unwrap();
    assert!(
        panel
            .files
            .iter()
            .all(|entry| matches!(entry.status, GitFileStatus::Staged)),
        "toggle with nothing staged must stage all"
    );
    panel.toggle_stage_all(api).unwrap();

    // GitPanel: per-file history lists commits touching readme.md.
    panel.view = GitView::Changes;
    panel.refresh_view(api).unwrap();
    panel.file_selected = panel
        .files
        .iter()
        .position(|entry| entry.path == "readme.md")
        .unwrap();
    panel.view = GitView::History;
    panel.refresh_view(api).unwrap();
    assert!(
        !panel.commits.is_empty(),
        "file history for readme.md must list the init commit"
    );
    assert_eq!(panel.commits[0].message, "init");
    assert!(panel.commits[0]
        .hash
        .chars()
        .all(|ch| ch.is_ascii_hexdigit()));
    assert!(panel
        .history_file
        .as_deref()
        .is_some_and(|f| f == "readme.md"));

    // History Enter loads the selected commit's diff (webui
    // showHistoryCommit): the root commit shows the full file as
    // additions, scoped to the history file.
    let init_hash = panel.commits[0].hash.clone();
    panel.load_commit_diff(api, &init_hash).unwrap();
    assert!(
        panel
            .diff_lines
            .iter()
            .any(|line| line.starts_with('+') && line.contains("hello")),
        "commit diff missing +hello line: {:?}",
        panel.diff_lines
    );
    assert!(panel.diff_title.contains(&panel.commits[0].hash));
    assert!(panel.diff_title.contains("readme.md"));

    // GitPanel: log shows the init commit.
    panel.view = GitView::Log;
    panel.refresh_view(api).unwrap();
    assert_eq!(panel.commits.len(), 1);
    assert_eq!(panel.commits[0].message, "init");

    // GitPanel: branches list contains the current branch.
    panel.view = GitView::Branches;
    panel.refresh_view(api).unwrap();
    assert!(
        panel.branches.iter().any(|b| b.current),
        "expected a current branch: {:?}",
        panel
            .branches
            .iter()
            .map(|b| (&b.name, b.current))
            .collect::<Vec<_>>()
    );

    // WebApiClient: rename a file through the browser API.
    api.file_rename(cwd, "new_file.rs", "renamed.rs").unwrap();
    explorer.refresh(api).unwrap();
    let names: Vec<&str> = explorer.entries.iter().map(|e| e.name.as_str()).collect();
    assert!(
        names.contains(&"renamed.rs"),
        "rename missing from tree: {names:?}"
    );
    assert!(
        !names.contains(&"new_file.rs"),
        "old name still in tree: {names:?}"
    );

    // WebApiClient: delete the renamed file.
    api.file_delete(cwd, "renamed.rs").unwrap();
    explorer.refresh(api).unwrap();
    let names: Vec<&str> = explorer.entries.iter().map(|e| e.name.as_str()).collect();
    assert!(
        !names.contains(&"renamed.rs"),
        "deleted file still in tree: {names:?}"
    );

    // WebApiClient: create and delete a branch (stays on main).
    let default_branch = panel
        .branches
        .iter()
        .find(|b| b.current)
        .map(|b| b.name.clone())
        .unwrap_or_else(|| "master".to_string());
    api.git_switch(cwd, "tui-e2e-tmp", true).unwrap();
    api.git_switch(cwd, &default_branch, false).unwrap();
    panel.view = GitView::Branches;
    panel.refresh_view(api).unwrap();
    assert!(
        panel.branches.iter().any(|b| b.name == "tui-e2e-tmp"),
        "temp branch missing: {:?}",
        panel.branches.iter().map(|b| &b.name).collect::<Vec<_>>()
    );
    panel.branch_selected = panel
        .branches
        .iter()
        .position(|b| b.name == "tui-e2e-tmp")
        .unwrap();
    panel.delete_branch(api, "tui-e2e-tmp", false).unwrap();
    panel.refresh_view(api).unwrap();
    assert!(
        !panel.branches.iter().any(|b| b.name == "tui-e2e-tmp"),
        "deleted branch still listed"
    );

    // WebApiClient: stash the unstaged change, list, apply (keeps the
    // entry), then drop until the list is empty.
    api.git_stash(cwd).unwrap();
    panel.view = GitView::Stash;
    panel.refresh_view(api).unwrap();
    assert_eq!(panel.stashes.len(), 1, "expected one stash entry");
    panel.stash_apply(api).unwrap();
    panel.refresh_view(api).unwrap();
    assert!(
        !panel.stashes.is_empty(),
        "apply is keep-by-default so the entry must remain",
    );
    assert!(
        panel.files.iter().any(|e| e.path == "readme.md"),
        "stash apply lost the modified file"
    );
    // Re-stash with a different tree. A stash whose commit would be
    // bit-identical to stash@{0} (same tree, message, and second) is
    // a no-op ref update in git, so no entry would be created; the
    // extra line guarantees a distinct commit and a second entry.
    std::fs::write(
        std::path::Path::new(cwd).join("readme.md"),
        "hello\nworld\nmore\n",
    )
    .unwrap();
    api.git_stash(cwd).unwrap();
    panel.refresh_view(api).unwrap();
    assert_eq!(panel.stashes.len(), 2, "expected two stash entries");
    panel.stash_drop(api).unwrap();
    panel.refresh_view(api).unwrap();
    assert_eq!(panel.stashes.len(), 1, "drop must remove exactly one entry");
    panel.stash_drop(api).unwrap();
    panel.refresh_view(api).unwrap();
    assert!(panel.stashes.is_empty(), "stash list not empty after drops");

    // FileExplorer edit round trip: edit the file, save, re-read shows
    // the new content and the preview hash advanced.
    let mut editor = FileExplorer::new(cwd);
    editor.refresh(api).unwrap();
    let names: Vec<&str> = editor.entries.iter().map(|e| e.name.as_str()).collect();
    editor.selected = names
        .iter()
        .position(|n| *n == "readme.md")
        .expect("readme.md in tree");
    editor.open_preview(api).unwrap();
    let hash_before = editor.preview.hash.clone();
    editor.start_edit().expect("start edit");
    assert!(editor.edit_active);
    // Type a line: Enter inserts a line break (real terminals send
    // KeyCode::Enter, not Char('\n')), then text, then save with Ctrl-S.
    editor
        .edit_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE), api)
        .unwrap();
    for ch in "edited by tui".chars() {
        editor
            .edit_key(KeyEvent::new(KeyCode::Char(ch), KeyModifiers::NONE), api)
            .unwrap();
    }
    assert!(editor.preview.dirty, "typing must mark the preview dirty");
    editor
        .edit_key(
            KeyEvent::new(KeyCode::Char('s'), KeyModifiers::CONTROL),
            api,
        )
        .unwrap();
    assert!(!editor.preview.dirty, "save must clear dirty");
    assert!(editor.edit_active, "save keeps edit mode open");
    // Esc exits edit mode; a clean exit must not be dirty.
    editor
        .edit_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE), api)
        .unwrap();
    assert!(!editor.edit_active);
    // Re-read the file from the server: content and hash changed.
    editor.open_preview(api).unwrap();
    assert_eq!(
        editor.preview.path.as_deref(),
        Some("readme.md"),
        "preview path must survive the edit round trip"
    );
    assert!(
        editor.preview.content.contains("edited by tui"),
        "re-read content must contain the edit: {:?}",
        editor.preview.content
    );
    assert_ne!(
        editor.preview.hash, hash_before,
        "hash must change after a save"
    );

    // Refusing guards: binary/truncated previews cannot start editing.
    editor.preview.binary = true;
    assert!(editor.start_edit().is_err());
    editor.preview.binary = false;
    editor.preview.truncated = true;
    assert!(editor.start_edit().is_err());
    editor.preview.truncated = false;

    // Stale-hash save is rejected by the server (409).
    editor.preview.hash = "0000000000000000000000000000000000000000".to_string();
    editor.preview.content = "conflicting content\n".to_string();
    editor.preview.dirty = true;
    let save_err = editor.save_preview(api).unwrap_err();
    assert!(
        save_err.to_string().contains("409"),
        "stale hash save must fail with the server 409, got {save_err}"
    );
    assert!(
        save_err.to_string().contains("file changed on disk"),
        "stale hash save must surface the server conflict message, got {save_err}"
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tui_content_search_git_status_and_new_file_round_trip() {
    let repo = temp_git_repo();
    let state = localhost_no_auth_state(repo.clone());
    let app = app_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let api = WebApiClient::new("127.0.0.1", addr.port());
    let cwd = repo.to_string_lossy().to_string();

    let result = tokio::task::spawn_blocking(move || tui_phase3_assertions(&api, &cwd))
        .await
        .unwrap();
    result.unwrap_or_else(|err| panic!("tui phase3 round trip failed: {err}"));
    server.abort();
    let _ = std::fs::remove_dir_all(&repo);
    let bare = std::env::temp_dir().join(
        repo.file_name()
            .unwrap()
            .to_string_lossy()
            .replace("herdr-tui-e2e-repo-", "herdr-tui-e2e-bare-"),
    );
    let _ = std::fs::remove_dir_all(&bare);
}

fn tui_phase3_assertions(api: &WebApiClient, cwd: &str) -> Result<(), String> {
    use herdr_webui::tui::panels::files::{
        content_rows, run_content_search, ContentRow, SearchKind,
    };

    // Git status colors: the fixture has a modified readme.md and an
    // untracked new_file.rs, so the tree payload's git_status map
    // must reach the parsed entries.
    let mut explorer = FileExplorer::new(cwd);
    explorer.refresh(api).unwrap();
    let readme = explorer
        .entries
        .iter()
        .find(|entry| entry.name == "readme.md")
        .ok_or("tree missing readme.md")?;
    assert_eq!(readme.git_status.as_deref(), Some("modified"));
    let new_file = explorer
        .entries
        .iter()
        .find(|entry| entry.name == "new_file.rs")
        .ok_or("tree missing new_file.rs")?;
    assert_eq!(new_file.git_status.as_deref(), Some("untracked"));

    // Content search: the fixture readme contains "world"; the
    // grouped results must include the file with a matched line.
    explorer.filter = "world".to_string();
    explorer.search_mode = true;
    explorer.search_kind = SearchKind::Content;
    run_content_search(&mut explorer, api, false).unwrap();
    let state = &explorer.content_search;
    let readme_hit = state
        .files
        .iter()
        .find(|file| file.path == "readme.md")
        .ok_or(format!(
            "content search missing readme.md, files: {:?}",
            state
                .files
                .iter()
                .map(|f| f.path.clone())
                .collect::<Vec<_>>()
        ))?;
    assert!(readme_hit.match_count >= 1, "expected a match in readme.md");
    assert!(state.total_matches >= 1);
    // Flat rows: file header plus the chunk lines of the expanded
    // file; the matched line must appear.
    let rows = content_rows(state);
    assert!(matches!(rows[0], ContentRow::File(0)));
    let matched = rows.iter().any(|row| match row {
        ContentRow::Line { matched, .. } => *matched,
        _ => false,
    });
    assert!(matched, "no matched line in the flat rows");

    // Jump-to-line: open the matched line and verify the jump state
    // plus the preview content.
    let jump = rows
        .iter()
        .find_map(|row| match row {
            ContentRow::Line { file, line, .. } if *file == 0 => Some(*line),
            _ => None,
        })
        .ok_or("no chunk line for the first file")?;
    explorer
        .open_preview_at_line(api, "readme.md", jump)
        .map_err(|err| format!("jump to readme.md:{jump} failed: {err}"))?;
    assert_eq!(explorer.preview.path.as_deref(), Some("readme.md"));
    assert_eq!(explorer.preview_jump_line, Some(jump));

    // Match-case toggle: default is case-insensitive so "WORLD"
    // still matches "world"; with match_case on it must not.
    explorer.content_search.match_case = false;
    explorer.content_search.regex = false;
    explorer.filter = "WORLD".to_string();
    run_content_search(&mut explorer, api, false).unwrap();
    assert!(
        explorer
            .content_search
            .files
            .iter()
            .any(|file| file.path == "readme.md"),
        "case-insensitive search for WORLD must match readme.md"
    );
    explorer.content_search.match_case = true;
    run_content_search(&mut explorer, api, false).unwrap();
    assert!(
        explorer.content_search.files.is_empty(),
        "match-case search for WORLD must not match lowercase world"
    );
    // Regex toggle: `wor.d` matches "world" in both modes.
    explorer.content_search.match_case = false;
    explorer.content_search.regex = true;
    explorer.filter = "wor.d".to_string();
    run_content_search(&mut explorer, api, false).unwrap();
    assert!(
        explorer
            .content_search
            .files
            .iter()
            .any(|file| file.path == "readme.md"),
        "regex search must match readme.md"
    );

    // New file: empty write then preview, cursor lands on the file.
    explorer.search_mode = false;
    explorer.filter.clear();
    explorer.refresh(api).unwrap();
    explorer.create_file(api, "made_by_tui.rs").unwrap();
    let created = explorer
        .entries
        .iter()
        .find(|entry| entry.name == "made_by_tui.rs")
        .ok_or("created file missing from tree")?;
    assert_eq!(created.path, "made_by_tui.rs");
    assert_eq!(
        explorer.selected_entry().map(|e| e.name.clone()),
        Some("made_by_tui.rs".to_string())
    );
    assert!(repo_file_exists(cwd, "made_by_tui.rs"));

    // New directory: `.gitkeep` marker makes the dir visible.
    explorer
        .create_directory(api, "tui_new_dir")
        .map_err(|err| format!("create_directory failed: {err}"))?;
    assert!(repo_dir_exists(cwd, "tui_new_dir"));
    assert!(repo_file_exists(cwd, "tui_new_dir/.gitkeep"));

    Ok(())
}

fn repo_file_exists(root: &str, rel: &str) -> bool {
    std::path::Path::new(root).join(rel).is_file()
}

fn repo_dir_exists(root: &str, rel: &str) -> bool {
    std::path::Path::new(root).join(rel).is_dir()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tui_reveal_find_replace_and_tab_cycle_round_trip() {
    let repo = temp_git_repo();
    let state = localhost_no_auth_state(repo.clone());
    let app = app_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let api = WebApiClient::new("127.0.0.1", addr.port());
    let cwd = repo.to_string_lossy().to_string();

    let result = tokio::task::spawn_blocking(move || tui_phase4_assertions(&api, &cwd))
        .await
        .unwrap();
    result.unwrap_or_else(|err| panic!("tui phase4 round trip failed: {err}"));
    server.abort();
    let _ = std::fs::remove_dir_all(&repo);
    let bare = std::env::temp_dir().join(
        repo.file_name()
            .unwrap()
            .to_string_lossy()
            .replace("herdr-tui-e2e-repo-", "herdr-tui-e2e-bare-"),
    );
    let _ = std::fs::remove_dir_all(&bare);
}

fn tui_phase4_assertions(api: &WebApiClient, cwd: &str) -> Result<(), String> {
    // Reveal: a nested untracked file must be reachable through
    // expand-ancestors + select, starting from a flat tree.
    std::fs::create_dir_all(std::path::Path::new(cwd).join("nested/deep"))
        .map_err(|err| err.to_string())?;
    std::fs::write(
        std::path::Path::new(cwd).join("nested/deep/target.rs"),
        "fn target() {}\n",
    )
    .map_err(|err| err.to_string())?;
    let mut explorer = FileExplorer::new(cwd);
    explorer.refresh(api).unwrap();
    explorer
        .reveal_path(api, "nested/deep/target.rs")
        .map_err(|err| format!("reveal_path failed: {err}"))?;
    assert_eq!(
        explorer.selected_entry().map(|e| e.path.clone()),
        Some("nested/deep/target.rs".to_string()),
        "reveal must select the nested file"
    );

    // Editor find + replace: open the readme, find "world",
    // replace-all with "tui", verify the on-disk file after save.
    explorer
        .open_preview_at_line(api, "readme.md", 1)
        .map_err(|err| format!("open readme.md failed: {err}"))?;
    explorer.start_edit().unwrap();
    explorer.editor_find_open();
    for ch in "world".chars() {
        explorer.push_find_char(ch);
    }
    assert_eq!(explorer.editor_find.ranges.len(), 1, "expected one match");
    explorer
        .editor_replace("tui", true)
        .map_err(|err| format!("editor_replace failed: {err}"))?;
    assert!(explorer.preview.dirty);
    explorer
        .editor_save(api)
        .map_err(|err| format!("editor_save failed: {err}"))?;
    let saved = std::fs::read_to_string(std::path::Path::new(cwd).join("readme.md"))
        .map_err(|err| err.to_string())?;
    assert_eq!(saved, "hello\ntui\n", "replace-all + save must persist");
    explorer.editor_find_close();

    // Tab cycle: readme + new_file previews rotate round-robin.
    explorer
        .open_preview_at_line(api, "new_file.rs", 1)
        .map_err(|err| format!("open new_file.rs failed: {err}"))?;
    assert!(
        explorer.recent_previews.len() >= 2,
        "recents must track both files"
    );
    assert!(explorer.cycle_recent_preview(api).unwrap());
    let switched = explorer.preview.path.clone();
    assert_eq!(
        switched.as_deref(),
        Some("readme.md"),
        "Tab must rotate back to the previously opened file"
    );

    // Conflicts view: create a real merge conflict, refresh through
    // the panel, resolve with `theirs`, then abort the merge (the
    // resolve stage-marks the file so abort restores the pre-merge
    // state and later assertions keep a clean repo).
    let run_git = |args: &[&str]| -> Result<String, String> {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .map_err(|err| err.to_string())?;
        if !out.status.success() {
            return Err(format!(
                "git {args:?}: exit={} stdout={} stderr={}",
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stdout).trim(),
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    };
    run_git(&["checkout", "-q", "-b", "conflict-side"])?;
    std::fs::write(
        std::path::Path::new(cwd).join("readme.md"),
        "hello\nconflict-side\n",
    )
    .map_err(|err| err.to_string())?;
    run_git(&["commit", "-q", "-a", "-m", "conflict side"])?;
    run_git(&["checkout", "-q", "master"]).or_else(|_| run_git(&["checkout", "-q", "main"]))?;
    std::fs::write(
        std::path::Path::new(cwd).join("readme.md"),
        "hello\nmaster-side\n",
    )
    .map_err(|err| err.to_string())?;
    run_git(&["commit", "-q", "-a", "-m", "master side"])?;
    // The merge exits 1 with the conflict; that is the expected state.
    let merge_out = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["merge", "conflict-side"])
        .output()
        .map_err(|err| err.to_string())?;
    assert!(
        !merge_out.status.success(),
        "merge must conflict, got: {}",
        String::from_utf8_lossy(&merge_out.stdout)
    );
    let mut panel = herdr_webui::tui::panels::GitPanel::new(cwd);
    panel
        .refresh_conflicts(api)
        .map_err(|err| format!("refresh_conflicts failed: {err}"))?;
    assert_eq!(
        panel.conflict_files,
        vec!["readme.md".to_string()],
        "conflicts must list readme.md"
    );
    assert!(panel.merge_in_progress, "merge must be in progress");
    panel
        .resolve_selected_conflict(api, herdr_webui::tui::panels::ConflictResolveMode::Remote)
        .map_err(|err| format!("resolve_selected_conflict failed: {err}"))?;
    assert!(
        panel.conflict_files.is_empty(),
        "resolve must clear the conflict list"
    );
    panel
        .conflict_action(api, herdr_webui::tui::panels::ConflictAction::MergeAbort)
        .map_err(|err| format!("conflict_action failed: {err}"))?;
    assert!(
        !panel.merge_in_progress,
        "merge-abort must end the merge state"
    );

    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tui_app_prompt_and_git_actions_round_trip() {
    let repo = temp_git_repo();
    let state = localhost_no_auth_state(repo.clone());
    let app = app_router(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let port = addr.port();
    let cwd = repo.to_string_lossy().to_string();
    let result = tokio::task::spawn_blocking(move || tui_app_prompt_assertions(port, &cwd))
        .await
        .unwrap();
    result.unwrap_or_else(|err| panic!("tui app prompt round trip failed: {err}"));
    server.abort();
    let _ = std::fs::remove_dir_all(&repo);
    // The bare "origin" sibling shares the repo's timestamped name.
    let bare = std::env::temp_dir().join(
        repo.file_name()
            .unwrap()
            .to_string_lossy()
            .replace("herdr-tui-e2e-repo-", "herdr-tui-e2e-bare-"),
    );
    let _ = std::fs::remove_dir_all(&bare);
}

fn tui_app_prompt_assertions(port: u16, cwd: &str) -> Result<(), String> {
    use herdr_webui::backend_client::BackendClient;
    use herdr_webui::tui::{TuiApp, TuiMode, TuiScreen, TuiSnapshot, TuiTheme};

    let client = BackendClient::new("/tmp/unused-api.sock", "/tmp/unused-term.sock");
    let mut app = TuiApp::new_with_options(
        client,
        std::time::Duration::from_secs(1),
        TuiTheme::Dark,
        WebApiClient::new("127.0.0.1", port),
    );
    // Drive the app through prompt flows without a terminal: prompts are
    // pure app state, so handle_key is enough.
    app.snapshot = TuiSnapshot::default();
    app.screen = TuiScreen::Files;
    app.mode = TuiMode::Attach;
    app.file_explorer = herdr_webui::tui::panels::FileExplorer::new(cwd);
    app.file_explorer
        .refresh(&app.web_api)
        .map_err(|e| e.to_string())?;
    app.git_panel.set_cwd(cwd);
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;

    let press = |app: &mut TuiApp, ch: char| {
        app.handle_key(crossterm::event::KeyEvent::from(
            crossterm::event::KeyCode::Char(ch),
        ));
    };

    // --- Rename prompt: R opens, type new name, Enter confirms.
    // Select the file to rename deterministically (dirs sort first).
    let target_idx = app
        .file_explorer
        .entries
        .iter()
        .position(|e| e.name == "new_file.rs")
        .ok_or("new_file.rs missing from tree")?;
    app.file_explorer.selected = target_idx;
    press(&mut app, 'R');
    assert!(app.prompt_input.is_some(), "rename prompt did not open");
    // Type over the default text: Ctrl+U clears, then type the new name.
    app.handle_key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('u'),
        crossterm::event::KeyModifiers::CONTROL,
    ));
    press(&mut app, 'r');
    press(&mut app, 'e');
    press(&mut app, 'n');
    press(&mut app, 'a');
    press(&mut app, 'm');
    press(&mut app, 'e');
    press(&mut app, 'd');
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(app.prompt_input.is_none(), "rename prompt still open");
    assert_eq!(
        app.status, "renamed to renamed",
        "rename status wrong: {}",
        app.status
    );
    assert!(
        app.file_explorer
            .entries
            .iter()
            .any(|e| e.name == "renamed"),
        "renamed file missing from tree"
    );

    // --- Delete confirm: x opens, y confirms. Select the renamed file
    // explicitly so the delete target is deterministic.
    let doomed_idx = app
        .file_explorer
        .entries
        .iter()
        .position(|e| e.name == "renamed")
        .ok_or("renamed file missing before delete")?;
    app.file_explorer.selected = doomed_idx;
    let doomed = app
        .file_explorer
        .selected_entry()
        .map(|e| e.name.clone())
        .ok_or("no entry selected for delete")?;
    assert_eq!(doomed, "renamed");
    press(&mut app, 'x');
    assert!(app.prompt_input.is_some(), "delete prompt did not open");
    press(&mut app, 'y');
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(app.prompt_input.is_none(), "delete prompt still open");
    assert!(
        app.status.starts_with("deleted "),
        "delete status: {}",
        app.status
    );
    assert!(
        !app.file_explorer.entries.iter().any(|e| e.name == doomed),
        "deleted file {doomed} still in tree"
    );
    assert!(
        !app.file_explorer
            .entries
            .iter()
            .any(|e| e.name == "renamed"),
        "deleted file still in tree"
    );

    // --- Git branch delete via prompt: Tab to Branches, D opens, y confirms.
    app.screen = TuiScreen::Git;
    app.git_panel.view = herdr_webui::tui::panels::GitView::Branches;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    // Remember the default branch, create a temp branch, return to the
    // default, then delete the temp branch.
    let default_branch = app
        .git_panel
        .branches
        .iter()
        .find(|b| b.current)
        .map(|b| b.name.clone())
        .ok_or("no current branch")?;
    app.web_api
        .git_switch(cwd, "tui-app-branch", true)
        .map_err(|e| e.to_string())?;
    app.web_api
        .git_switch(cwd, &default_branch, false)
        .map_err(|e| e.to_string())?;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let idx = app
        .git_panel
        .branches
        .iter()
        .position(|b| b.name == "tui-app-branch")
        .ok_or("temp branch not listed")?;
    app.git_panel.branch_selected = idx;
    press(&mut app, 'D');
    assert!(app.prompt_input.is_some(), "branch delete prompt not open");
    press(&mut app, 'y');
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(app.prompt_input.is_none(), "branch prompt still open");
    assert!(
        app.status.starts_with("deleted branch"),
        "branch delete status: {}",
        app.status
    );

    // --- Stash drop via prompt: create a stash, Tab to Stash, D opens, y confirms.
    app.web_api.git_stash(cwd).map_err(|e| e.to_string())?;
    app.git_panel.view = herdr_webui::tui::panels::GitView::Stash;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    assert!(!app.git_panel.stashes.is_empty(), "stash list empty");
    press(&mut app, 'D');
    assert!(app.prompt_input.is_some(), "stash drop prompt not open");
    press(&mut app, 'y');
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(app.prompt_input.is_none(), "stash prompt still open");
    assert_eq!(app.status, "stash dropped", "stash status: {}", app.status);

    // --- Git fetch/pull/push round-trip against the bare "origin":
    // the remote exists, so each action succeeds and refresh_view runs.
    app.git_panel.view = herdr_webui::tui::panels::GitView::Branches;
    press(&mut app, 'f');
    assert!(
        app.error.is_none(),
        "fetch against origin failed: {:?}",
        app.error
    );
    press(&mut app, 'p');
    assert!(
        app.error.is_none(),
        "pull against origin failed: {:?}",
        app.error
    );
    press(&mut app, 'P');
    assert!(
        app.error.is_none(),
        "push against origin failed: {:?}",
        app.error
    );
    // And the error arms still exist: point the panel at a plain
    // directory outside the repo that has no remotes at all.
    static NOREMOTE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let no_remote_seq = NOREMOTE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let no_remote_dir = std::env::temp_dir().join(format!(
        "herdr-tui-e2e-noremote-{}-{}",
        std::process::id(),
        no_remote_seq
    ));
    std::fs::create_dir_all(&no_remote_dir).map_err(|e| e.to_string())?;
    app.git_panel.cwd = no_remote_dir.to_string_lossy().to_string();
    press(&mut app, 'f');
    press(&mut app, 'p');
    press(&mut app, 'P');
    assert!(
        app.error.is_some(),
        "fetch/pull/push without remotes should error"
    );
    app.git_panel.cwd = cwd.to_string();
    app.error = None;
    let _ = std::fs::remove_dir_all(&no_remote_dir);

    // --- Prefix e from the Git screen (EditFile): reads the file, opens
    // the Files screen in edit mode with the diff file loaded.
    // Re-dirty the working tree: the stash flow above consumed the
    // original unstaged change.
    std::fs::write(
        std::path::Path::new(cwd).join("edit_me.rs"),
        "fn edit() {}\n",
    )
    .map_err(|e| e.to_string())?;
    app.screen = TuiScreen::Git;
    app.git_panel.view = herdr_webui::tui::panels::GitView::Changes;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    // The unstaged readme.md change (from the earlier stash apply) or the
    // new_file entry must be present; select it explicitly.
    let edit_idx = app
        .git_panel
        .files
        .iter()
        .position(|f| f.path == "edit_me.rs")
        .ok_or("edit_me.rs not in git changes")?;
    app.git_panel.file_selected = edit_idx;
    let ctrl_b = crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('b'),
        crossterm::event::KeyModifiers::CONTROL,
    );
    app.handle_key(ctrl_b);
    press(&mut app, 'e');
    assert_eq!(
        app.screen,
        TuiScreen::Files,
        "prefix e from git opens the Files screen"
    );
    assert!(app.file_explorer.edit_active, "prefix e starts edit mode");

    // Edit arms: type a char, Ctrl-S saves, Esc stops editing.
    press(&mut app, 'z');
    app.handle_key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('s'),
        crossterm::event::KeyModifiers::CONTROL,
    ));
    assert_eq!(app.status, "saved", "Ctrl-S saves: {}", app.status);
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Esc,
    ));
    // Esc with no unsaved edits reports "edit mode closed".
    assert!(
        app.status.contains("edit mode"),
        "Esc after save reports edit close: {}",
        app.status
    );
    assert!(!app.file_explorer.edit_active);

    // --- Prefix e with a dirty preview of a DIFFERENT file is refused.
    // (Same-file dirty previews are allowed: the edit continues.)
    app.file_explorer.preview.path = Some("other_file.rs".to_string());
    app.file_explorer.preview.dirty = true;
    app.screen = TuiScreen::Git;
    app.handle_key(ctrl_b);
    press(&mut app, 'e');
    assert_eq!(
        app.status, "unsaved edits: save or reload before editing another file",
        "dirty preview of another file blocks prefix e"
    );
    app.file_explorer.preview.dirty = false;
    app.file_explorer.preview.path = None;
    app.error = None;

    // --- Commit the pending edit through the prefix-2 commit modal so a
    // tracked file (edit_me.rs) exists for the blame test.
    std::fs::write(
        std::path::Path::new(cwd).join("edit_me.rs"),
        "fn edit() { return 7 }\n",
    )
    .map_err(|e| e.to_string())?;
    app.screen = TuiScreen::Git;
    app.git_panel.view = herdr_webui::tui::panels::GitView::Changes;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let edit_idx = app
        .git_panel
        .files
        .iter()
        .position(|f| f.path == "edit_me.rs")
        .ok_or("edit_me.rs not in git changes")?;
    app.git_panel.file_selected = edit_idx;
    app.git_panel
        .stage_selected(&app.web_api)
        .map_err(|e| e.to_string())?;
    app.handle_key(ctrl_b);
    press(&mut app, '2');
    assert!(
        app.commit_input.is_some(),
        "prefix 2 opens the commit modal"
    );
    press(&mut app, 't');
    press(&mut app, 'e');
    press(&mut app, 's');
    press(&mut app, 't');
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(
        app.commit_input.is_none(),
        "commit modal closed after Enter"
    );
    assert_eq!(
        app.status, "committed: test",
        "commit status: {}",
        app.status
    );

    // --- Prefix git action arms against the live server: stage-all,
    // unstage, stage-file, and stash-file all run through the panel
    // wrappers (which refresh the view after each action).
    std::fs::write(
        std::path::Path::new(cwd).join("edit_me.rs"),
        "fn edit() { return 70 }\n",
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(
        std::path::Path::new(cwd).join("other.rs"),
        "fn other() {}\n",
    )
    .map_err(|e| e.to_string())?;
    app.screen = TuiScreen::Git;
    app.git_panel.view = herdr_webui::tui::panels::GitView::Changes;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;

    // Prefix G toggles stage-all: tracked changes stage (untracked files
    // stay untracked, like `git add -u`), then toggle back.
    app.handle_key(ctrl_b);
    app.handle_key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('G'),
        crossterm::event::KeyModifiers::SHIFT,
    ));
    assert!(
        app.git_panel
            .files
            .iter()
            .filter(|f| f.path != "other.rs")
            .all(|f| f.status == herdr_webui::tui::panels::GitFileStatus::Staged),
        "stage-all stages tracked changes: {:?}",
        app.git_panel
            .files
            .iter()
            .map(|f| (f.path.clone(), f.status.clone()))
            .collect::<Vec<_>>()
    );
    app.handle_key(ctrl_b);
    app.handle_key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Char('G'),
        crossterm::event::KeyModifiers::SHIFT,
    ));
    assert!(
        !app.git_panel
            .files
            .iter()
            .any(|f| f.status == herdr_webui::tui::panels::GitFileStatus::Staged),
        "stage-all toggles everything back"
    );

    // Prefix y stages the selected file; prefix u unstages it.
    let y_idx = app
        .git_panel
        .files
        .iter()
        .position(|f| f.path == "edit_me.rs")
        .ok_or("edit_me.rs missing before stage")?;
    app.git_panel.file_selected = y_idx;
    app.handle_key(ctrl_b);
    press(&mut app, 'y');
    assert!(
        app.git_panel.files.iter().any(|f| f.path == "edit_me.rs"
            && f.status == herdr_webui::tui::panels::GitFileStatus::Staged),
        "prefix y stages the selected file"
    );
    app.git_panel.file_selected = y_idx;
    app.handle_key(ctrl_b);
    press(&mut app, 'u');
    assert!(
        app.git_panel.files.iter().any(|f| f.path == "edit_me.rs"
            && f.status != herdr_webui::tui::panels::GitFileStatus::Staged),
        "prefix u unstages the selected file"
    );

    // Prefix z stashes the changes; the changes list empties.
    app.handle_key(ctrl_b);
    press(&mut app, 'z');
    assert!(
        app.git_panel.files.is_empty(),
        "prefix z stashes all changes: {:?}",
        app.git_panel.files
    );
    // Restore the stashed changes for the later sections.
    app.git_panel.view = herdr_webui::tui::panels::GitView::Stash;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(
        app.status, "stash diff loaded",
        "stash restore: {}",
        app.status
    );
    assert!(
        app.git_panel.stash_diff_lines.len() > 2,
        "stash diff has content lines"
    );
    // `a` applies the stash (Enter now previews the diff).
    press(&mut app, 'a');
    assert_eq!(app.status, "stash applied", "stash restore: {}", app.status);
    app.git_panel.view = herdr_webui::tui::panels::GitView::Changes;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;

    // --- Git blame toggle (prefix m) flips blame on and off. edit_me.rs is
    // committed now; dirty the working copy again so it appears in the
    // changes list, then blame it (with ref "working" the server blames
    // --contents, so uncommitted lines attribute to the synthetic
    // external-file author).
    std::fs::write(
        std::path::Path::new(cwd).join("edit_me.rs"),
        "fn edit() { return 8 }\n",
    )
    .map_err(|e| e.to_string())?;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let blame_idx = app
        .git_panel
        .files
        .iter()
        .position(|f| f.path == "edit_me.rs")
        .ok_or("edit_me.rs not in git changes after commit")?;
    app.git_panel.file_selected = blame_idx;
    app.handle_key(ctrl_b);
    press(&mut app, 'm');
    assert!(app.git_panel.show_blame, "prefix m enables blame");
    assert_eq!(app.status, "blame on", "blame status: {}", app.status);
    assert!(app.error.is_none(), "blame load error: {:?}", app.error);
    app.handle_key(ctrl_b);
    press(&mut app, 'm');
    assert!(!app.git_panel.show_blame, "prefix m toggles blame off");
    assert_eq!(app.status, "blame off", "blame off status: {}", app.status);

    // --- Prefix m from a non-Changes view resets to Changes first.
    app.git_panel.view = herdr_webui::tui::panels::GitView::Branches;
    app.git_panel.diff_title = "edit_me.rs".to_string();
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    // Keep the changes list for blame resolution while showing Branches.
    app.git_panel.files = vec![herdr_webui::tui::panels::GitFileEntry {
        path: "edit_me.rs".to_string(),
        status: herdr_webui::tui::panels::GitFileStatus::Unstaged,
    }];
    app.handle_key(ctrl_b);
    press(&mut app, 'm');
    assert_eq!(
        app.git_panel.view,
        herdr_webui::tui::panels::GitView::Changes,
        "prefix m resets the view to Changes"
    );
    assert!(app.git_panel.show_blame, "blame toggles on from Branches");
    // Toggle off again for the next sections.
    app.handle_key(ctrl_b);
    press(&mut app, 'm');
    assert!(!app.git_panel.show_blame);

    // --- Prefix e on a binary file is refused. edit_me.bin is untracked
    // but readable; the server flags it binary, so the edit guard fires.
    {
        let bin_path = std::path::Path::new(cwd).join("logo.bin");
        std::fs::write(&bin_path, [0u8, 159, 146, 150, 0, 7]).map_err(|e| e.to_string())?;
        app.git_panel
            .refresh_view(&app.web_api)
            .map_err(|e| e.to_string())?;
        let bin_idx = app
            .git_panel
            .files
            .iter()
            .position(|f| f.path == "logo.bin")
            .ok_or("logo.bin not in changes")?;
        app.git_panel.file_selected = bin_idx;
        app.handle_key(ctrl_b);
        press(&mut app, 'e');
        assert!(
            app.error
                .as_deref()
                .is_some_and(|e| e.contains("cannot be edited")),
            "binary file edit must be refused: {:?}",
            app.error
        );
        app.error = None;
        let _ = std::fs::remove_file(&bin_path);
    }

    // --- Prefix o returns to the changes view.
    app.handle_key(ctrl_b);
    press(&mut app, 'o');
    assert_eq!(
        app.git_panel.view,
        herdr_webui::tui::panels::GitView::Changes
    );

    // --- Prefix v with a non-current branch switches to it and back.
    app.git_panel.view = herdr_webui::tui::panels::GitView::Branches;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let default_branch = app
        .git_panel
        .branches
        .iter()
        .find(|b| b.current)
        .map(|b| b.name.clone())
        .ok_or("no current branch")?;
    app.web_api
        .git_switch(cwd, "tui-switch-tmp", true)
        .map_err(|e| e.to_string())?;
    app.web_api
        .git_switch(cwd, &default_branch, false)
        .map_err(|e| e.to_string())?;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let switch_idx = app
        .git_panel
        .branches
        .iter()
        .position(|b| b.name == "tui-switch-tmp")
        .ok_or("switch branch missing")?;
    app.git_panel.branch_selected = switch_idx;
    app.handle_key(ctrl_b);
    press(&mut app, 'v');
    assert!(
        app.status.starts_with("switched to tui-switch-tmp"),
        "prefix v switches: {}",
        app.status
    );

    // Switch back to the default branch for the discard test.
    let back_idx = app
        .git_panel
        .branches
        .iter()
        .position(|b| b.name == default_branch)
        .ok_or("default branch missing")?;
    app.git_panel.branch_selected = back_idx;
    app.handle_key(ctrl_b);
    press(&mut app, 'v');
    assert_eq!(
        app.status,
        format!("switched to {default_branch}"),
        "switch back: {}",
        app.status
    );

    // --- Prefix d with a dirty preview on the same file is refused first,
    // then the plain discard runs.
    app.git_panel.view = herdr_webui::tui::panels::GitView::Changes;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let edit_idx = app
        .git_panel
        .files
        .iter()
        .position(|f| f.path == "edit_me.rs")
        .ok_or("edit_me.rs not dirty before discard")?;
    app.git_panel.file_selected = edit_idx;
    // Dirty preview of the selected file blocks the discard.
    app.file_explorer.preview.path = Some("edit_me.rs".to_string());
    app.file_explorer.preview.dirty = true;
    app.handle_key(ctrl_b);
    press(&mut app, 'd');
    assert!(
        app.error
            .as_deref()
            .is_some_and(|e| e.contains("unsaved edits")),
        "dirty preview blocks discard: {:?}",
        app.error
    );
    // Without the dirty buffer the discard proceeds against the API.
    app.file_explorer.preview.dirty = false;
    app.file_explorer.preview.path = None;
    app.error = None;
    app.git_panel.file_selected = edit_idx;
    app.handle_key(ctrl_b);
    press(&mut app, 'd');
    assert!(app.error.is_none(), "discard failed: {:?}", app.error);

    // --- Git Enter success statuses: History commit diff, branch switch,
    // and stash apply.
    // History: Enter loads the selected commit's diff. Dirty the file
    // again so it is selectable in Changes (refresh_history resolves the
    // history file from the Changes selection).
    std::fs::write(
        std::path::Path::new(cwd).join("edit_me.rs"),
        "fn edit() { return 9 }\n",
    )
    .map_err(|e| e.to_string())?;
    app.screen = TuiScreen::Git;
    app.git_panel.view = herdr_webui::tui::panels::GitView::Changes;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let hist_idx = app
        .git_panel
        .files
        .iter()
        .position(|f| f.path == "edit_me.rs")
        .ok_or("edit_me.rs missing for history")?;
    app.git_panel.file_selected = hist_idx;
    app.git_panel.history_file = Some("edit_me.rs".to_string());

    // The Log view (prefix l) refreshes the commit list and clamps an
    // out-of-range selection the same way.
    app.git_panel.commit_selected = 99;
    app.handle_key(ctrl_b);
    press(&mut app, 'l');
    assert!(
        app.git_panel.view == herdr_webui::tui::panels::GitView::Log,
        "prefix l opens the Log view"
    );
    assert_eq!(
        app.git_panel.commit_selected,
        app.git_panel.commits.len().saturating_sub(1),
        "log refresh must clamp the selection"
    );

    // --- Log view actions (webui log toolbar parity).
    // Enter compares the selected commit with its parent.
    app.git_panel.commit_selected = 0;
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(
        !app.git_panel.diff_lines.is_empty(),
        "log Enter loads the parent compare diff"
    );
    assert!(app.error.is_none(), "log Enter error: {:?}", app.error);
    assert!(
        app.status.contains("compare"),
        "log Enter status: {}",
        app.status
    );

    // `s` cycles the log scope (all -> base-current -> base).
    let scope_before = app.git_panel.log_scope;
    press(&mut app, 's');
    assert_ne!(app.git_panel.log_scope, scope_before, "s cycles log scope");
    assert!(
        app.status.contains("log scope"),
        "scope status: {}",
        app.status
    );

    // `+` load-more is refused without more pages (or grows the limit
    // and refetches); both paths keep the view consistent.
    press(&mut app, '+');
    assert!(
        app.status.contains("log limit") || app.status.contains("no more"),
        "+ load more status: {}",
        app.status
    );

    // `t` opens the tag prompt; typing a name tags the selected commit.
    press(&mut app, 't');
    assert!(app.prompt_input.is_some(), "t opens the tag prompt");
    for ch in "v-e2e".chars() {
        press(&mut app, ch);
    }
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(app.status, "tagged v-e2e", "tag prompt: {}", app.status);

    // `R` opens the reset prompt; mixed mode resets the current
    // branch to the selected commit.
    press(&mut app, 'R');
    for ch in "mixed".chars() {
        press(&mut app, ch);
    }
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(app.status, "reset mixed", "reset prompt: {}", app.status);

    // `R` then "hard" chains into the typed-y confirm; non-y cancels
    // without touching the repo. The actual hard reset is not executed
    // here because it would wipe the working tree edits the later
    // sections of this test still need; the typed-y path is the same
    // `run_prompt_action` arm the mixed reset already exercised.
    press(&mut app, 'R');
    for ch in "hard".chars() {
        press(&mut app, ch);
    }
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(matches!(
        app.prompt_input.as_ref().map(|p| p.kind),
        Some(herdr_webui::tui::PromptKind::ConfirmResetHard)
    ));
    press(&mut app, 'n');
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(app.status, "cancelled", "non-y confirm cancels");

    app.git_panel.view = herdr_webui::tui::panels::GitView::History;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    assert!(
        !app.git_panel.commits.is_empty(),
        "history needs commits after the earlier commit"
    );
    app.git_panel.commit_selected = 0;
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(
        app.status.starts_with("commit "),
        "history Enter status: {}",
        app.status
    );
    assert!(app.error.is_none(), "history diff error: {:?}", app.error);

    // An out-of-range selection clamps to the last commit on refresh
    // (webui list guards behave the same after the list shrinks).
    app.git_panel.commit_selected = 99;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    assert_eq!(
        app.git_panel.commit_selected,
        app.git_panel.commits.len().saturating_sub(1),
        "commit selection must clamp on refresh"
    );
    // History without a file context: the commit diff title is the bare
    // hash, no " · file" suffix (webui `compareFilePaths` is empty).
    app.git_panel.history_file = None;
    app.git_panel.commit_selected = 0;
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(
        app.git_panel.diff_title, app.git_panel.commits[0].hash,
        "no-file history diff title is the bare hash"
    );
    app.git_panel.history_file = Some("edit_me.rs".to_string());

    // Branches: Enter switches to the selected non-current branch, then
    // back to the default branch.
    app.git_panel.view = herdr_webui::tui::panels::GitView::Branches;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let default_branch = app
        .git_panel
        .branches
        .iter()
        .find(|b| b.current)
        .map(|b| b.name.clone())
        .ok_or("no current branch")?;
    let switch_idx = app
        .git_panel
        .branches
        .iter()
        .position(|b| b.name == "tui-switch-tmp")
        .ok_or("tui-switch-tmp missing for Enter switch")?;
    app.git_panel.branch_selected = switch_idx;
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(
        app.status, "switched to tui-switch-tmp",
        "branch Enter status: {}",
        app.status
    );
    let back_idx = app
        .git_panel
        .branches
        .iter()
        .position(|b| b.name == default_branch)
        .ok_or("default branch missing after switch")?;
    app.git_panel.branch_selected = back_idx;
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(
        app.status,
        format!("switched to {default_branch}"),
        "branch Enter back: {}",
        app.status
    );

    // --- Branch create: Branches view `c` prompts, typed name creates
    // and switches (webui git_switch create: true).
    press(&mut app, 'c');
    assert!(
        app.prompt_input.is_some(),
        "branches c opens the create prompt"
    );
    for ch in "tui-created-branch".chars() {
        press(&mut app, ch);
    }
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(
        app.status, "switched to tui-created-branch",
        "branch create: {}",
        app.status
    );
    assert!(
        app.git_panel
            .branches
            .iter()
            .any(|b| b.name == "tui-created-branch" && b.current),
        "created branch is current after the switch"
    );
    // Switch back to the default branch for the later sections.
    let back_idx = app
        .git_panel
        .branches
        .iter()
        .position(|b| b.name == default_branch)
        .ok_or("default branch missing after create")?;
    app.git_panel.branch_selected = back_idx;
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));

    // --- Diff search in Changes (webui Ctrl+F): / opens, typing
    // matches incrementally, Enter commits, n/N cycle.
    app.git_panel.view = herdr_webui::tui::panels::GitView::Changes;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let edit_idx = app
        .git_panel
        .files
        .iter()
        .position(|f| f.path == "edit_me.rs")
        .ok_or("edit_me.rs missing for diff search")?;
    app.git_panel.file_selected = edit_idx;
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(!app.git_panel.diff_lines.is_empty(), "diff loaded");
    press(&mut app, '/');
    assert!(app.git_panel.diff_search_active, "/ opens the diff search");
    press(&mut app, 'e');
    press(&mut app, 'd');
    press(&mut app, 'i');
    press(&mut app, 't');
    assert!(
        !app.git_panel.diff_search_matches.is_empty(),
        "diff search matches after typing"
    );
    let first_match = app.git_panel.diff_search_active_line();
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(!app.git_panel.diff_search_active, "Enter closes the bar");
    assert!(
        !app.git_panel.diff_search_matches.is_empty(),
        "Enter keeps the matches"
    );
    press(&mut app, 'n');
    assert_ne!(
        app.git_panel.diff_search_active_line(),
        first_match,
        "n moves the active match"
    );
    press(&mut app, 'N');
    assert_eq!(
        app.git_panel.diff_search_active_line(),
        first_match,
        "N returns to the first match"
    );
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Esc,
    ));
    assert!(
        app.git_panel.diff_search_matches.is_empty(),
        "Esc clears the search"
    );

    // --- Git cwd picker (prefix I): type a path, the panel switches.
    app.handle_key(ctrl_b);
    press(&mut app, 'I');
    assert!(app.prompt_input.is_some(), "prefix I opens the cwd prompt");
    for ch in cwd.chars() {
        press(&mut app, ch);
    }
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(app.git_panel.cwd, cwd, "cwd prompt switches the git panel");
    assert!(app.error.is_none(), "cwd switch error: {:?}", app.error);

    // Stash: stash the dirty edit, Enter previews the diff, `a` applies it.
    app.web_api.git_stash(cwd).map_err(|e| e.to_string())?;
    app.git_panel.view = herdr_webui::tui::panels::GitView::Stash;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    assert!(!app.git_panel.stashes.is_empty(), "stash list empty");
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(
        app.status, "stash diff loaded",
        "stash Enter: {}",
        app.status
    );
    press(&mut app, 'a');
    assert_eq!(app.status, "stash applied", "stash apply: {}", app.status);
    assert!(app.error.is_none(), "stash apply error: {:?}", app.error);

    // --- Files navigation: j/k moves, Enter on a directory expands.
    app.screen = TuiScreen::Files;
    app.file_explorer
        .refresh(&app.web_api)
        .map_err(|e| e.to_string())?;
    let start = app.file_explorer.selected;
    press(&mut app, 'j');
    press(&mut app, 'k');
    assert_eq!(app.file_explorer.selected, start);
    let dir_idx = app
        .file_explorer
        .entries
        .iter()
        .position(|e| e.is_dir)
        .ok_or("no directory in tree")?;
    app.file_explorer.selected = dir_idx;
    let dir_path = app.file_explorer.entries[dir_idx].path.clone();
    // Enter toggles inline expansion (webui click parity): children merge
    // into the tree without changing the root.
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(
        app.file_explorer.entries[dir_idx].expanded,
        "Enter expands the directory inline"
    );
    assert!(
        app.file_explorer.entries.iter().any(|e| e.level > 0),
        "expanded children appear in the tree"
    );
    assert_eq!(
        app.file_explorer.root_path, "",
        "inline expansion keeps the root"
    );
    // Enter again collapses.
    app.file_explorer.selected = dir_idx;
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert!(
        !app.file_explorer.entries[dir_idx].expanded,
        "Enter collapses the directory"
    );
    assert!(
        !app.file_explorer.entries.iter().any(|e| e.level > 0),
        "collapsed children are gone"
    );

    // l enters the directory as the new root (double-click parity); h
    // goes back up to the repo root.
    app.file_explorer.selected = dir_idx;
    press(&mut app, 'l');
    assert_eq!(
        app.file_explorer.root_path, dir_path,
        "l enters the directory"
    );
    press(&mut app, 'h');
    assert!(
        app.file_explorer.root_path.is_empty(),
        "h returns to the repo root"
    );
    assert!(
        app.file_explorer
            .entries
            .iter()
            .any(|e| e.name == "readme.md" || e.name == "edit_me.rs"),
        "parent listing is restored"
    );

    // --- Prefix e from Git Changes on a file that no longer exists on
    // disk surfaces the read error instead of opening edit mode.
    app.screen = TuiScreen::Git;
    app.git_panel.view = herdr_webui::tui::panels::GitView::Changes;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let deleted = std::path::Path::new(cwd).join("vanish.rs");
    std::fs::write(&deleted, "fn gone() {}\n").map_err(|e| e.to_string())?;
    {
        let out = Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(["add", "vanish.rs"])
            .output()
            .map_err(|e| e.to_string())?;
        assert!(out.status.success(), "git add vanish.rs failed");
    }
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let vanish_idx = app
        .git_panel
        .files
        .iter()
        .position(|f| f.path == "vanish.rs")
        .ok_or("vanish.rs missing from git changes")?;
    app.git_panel.file_selected = vanish_idx;
    std::fs::remove_file(&deleted).map_err(|e| e.to_string())?;
    let ctrl_b = |app: &mut TuiApp| {
        app.handle_key(crossterm::event::KeyEvent::new(
            crossterm::event::KeyCode::Char('b'),
            crossterm::event::KeyModifiers::CONTROL,
        ));
    };
    ctrl_b(&mut app);
    press(&mut app, 'e');
    assert!(
        app.error.as_deref().is_some_and(|e| !e.is_empty()),
        "prefix e on a vanished file must surface an error"
    );
    assert_ne!(app.screen, TuiScreen::Files, "failed edit stays on Git");

    // --- Blame reloads when the diff target changes while blame is on.
    app.error = None;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let edit_idx = app
        .git_panel
        .files
        .iter()
        .position(|f| f.path == "edit_me.rs")
        .ok_or("edit_me.rs missing from changes")?;
    app.git_panel.file_selected = edit_idx;
    // Enter loads the edit_me.rs diff first so blame resolves the shown
    // file instead of the vanished one still in diff_title.
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(
        app.git_panel.diff_title, "edit_me.rs",
        "Enter should load the edit_me.rs diff"
    );
    ctrl_b(&mut app);
    press(&mut app, 'm');
    assert!(
        app.git_panel.show_blame,
        "blame should be on; error: {:?}, status: {}",
        app.error, app.status
    );
    assert!(
        !app.git_panel.blame_authors.is_empty(),
        "blame authors should be loaded"
    );
    let old_path = app.git_panel.blame_path.clone();
    assert_eq!(old_path.as_deref(), Some("edit_me.rs"));
    // Enter on a different changes row reloads the diff and, with blame
    // on, reloads the annotations for the newly shown file (webui blame
    // follows the shown file).
    std::fs::write(
        std::path::Path::new(cwd).join("readme.md"),
        "hello\nworld\nblame reload\n",
    )
    .map_err(|e| e.to_string())?;
    app.git_panel
        .refresh_view(&app.web_api)
        .map_err(|e| e.to_string())?;
    let readme_idx = app
        .git_panel
        .files
        .iter()
        .position(|f| f.path == "readme.md")
        .ok_or("readme.md missing from changes")?;
    app.git_panel.file_selected = readme_idx;
    app.handle_key(crossterm::event::KeyEvent::from(
        crossterm::event::KeyCode::Enter,
    ));
    assert_eq!(
        app.git_panel.diff_title, "readme.md",
        "Enter loads the readme.md diff"
    );
    assert_eq!(
        app.git_panel.blame_path.as_deref(),
        Some("readme.md"),
        "blame must reload when the diff target changes"
    );
    assert!(
        !app.git_panel.blame_authors.is_empty(),
        "reloaded blame has authors"
    );

    Ok(())
}

#[test]
fn web_api_socket_transport_serves_git_and_file_panels() {
    let repo = temp_git_repo();
    let cwd = repo.to_string_lossy().to_string();
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let base = format!("/tmp/herdr-webapi-socket-{now_ms}-{}", std::process::id());
    let api_socket = PathBuf::from(format!("{base}-api.sock"));
    let client_socket = PathBuf::from(format!("{base}-client.sock"));
    let _handle = crate::builtin_backend::BuiltinBackendHandle::start(
        crate::builtin_backend::BuiltinBackendConfig {
            api_socket: api_socket.clone(),
            client_socket,
            cwd: std::env::temp_dir(),
            shell: None,
            jcode_detection_variant: crate::builtin_detection::JcodeDetectionVariant::Vanilla,
        },
    )
    .unwrap();

    let api = WebApiClient::from_backend_socket(&api_socket);
    assert!(api.is_socket_transport());

    // git panel: status, stage, commit, log
    let status = api.git_status(&cwd).unwrap();
    assert!(status["branch"].is_string(), "status payload: {status}");
    std::fs::write(repo.join("socket-new.txt"), "content\n").unwrap();
    api.git_stage(&cwd, &["socket-new.txt".to_string()])
        .unwrap();
    api.git_commit(&cwd, "add socket-new", None, false).unwrap();
    let log = api.git_log_scoped(&cwd, "all", "", 10, None).unwrap();
    assert!(
        log["commits"].as_array().map(Vec::len) >= Some(2),
        "log payload: {log}"
    );

    // file panel: tree, read, write with hash, write with stale hash
    let tree = api.file_tree(&cwd, "", 1).unwrap();
    assert!(tree["entries"].as_array().is_some(), "tree payload: {tree}");
    let read = api.file_read(&cwd, "readme.md").unwrap();
    let hash = read["hash"].as_str().unwrap().to_string();
    api.file_write(&cwd, "readme.md", "hello\nsocket\n", Some(&hash))
        .unwrap();
    let stale = api.file_write(&cwd, "readme.md", "conflict\n", Some("stale-hash"));
    assert!(stale.is_err());
    assert!(stale
        .unwrap_err()
        .to_string()
        .contains("file changed on disk"));

    // HTTP-only endpoints reject cleanly on socket transport.
    assert!(api.recent_workspaces().is_err());
}

/// Composer submit e2e: the TUI's `WebApiClient::submit_pane` against the
/// real axum route backed by a real built-in session. Covers the loopback
/// contract the TUI composer depends on: the echo round-trip (message
/// lands in the pane), and the blocked refusal (server-owned note with
/// the 409 `{error, code, note}` shape).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tui_composer_submit_round_trips_and_refuses_when_blocked() {
    // A shell that echoes its input line by line, so the pane tail shows
    // the submitted message deterministically (a plain shell prompt is
    // not guaranteed to echo before the read timeout). The second read
    // line makes it a Claurst-style permission dialog, which the real
    // blocked-detector + status sweeper must catch, flipping the pane
    // to blocked for the refusal half of the test.
    let repo = temp_git_repo();
    let echo_script = repo.join("echo-pane.sh");
    std::fs::write(
        &echo_script,
        "#!/bin/sh\ncount=0\nwhile IFS= read -r line; do\n  count=$((count+1))\n  if [ \"$count\" -eq 1 ]; then\n    echo \"got: $line\"\n  else\n    printf 'Do you want to run this command?\\nYes, allow once\\nNo, deny\\n'\n  fi\ndone\n",
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&echo_script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let state = localhost_no_auth_state(repo.clone());
    // Target the built-in backend so the submit route auto-starts a
    // built-in session in the redirected config tree.
    {
        let mut settings = state.server_settings.lock().unwrap();
        settings.backend_mode = BackendMode::Builtin;
    }
    let state = WebState {
        backend_mode: BackendMode::Builtin,
        ..state
    };
    let app = app_router(state);

    // Sync bind: the listener is up before the env redirect below, so no
    // await is ever needed while the env lock is held (clippy:
    // await_holding_lock). from_std requires nonblocking mode, set it
    // on the std socket before handing it to tokio.
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = std_listener.local_addr().unwrap();
    std_listener.set_nonblocking(true).unwrap();
    let listener = tokio::net::TcpListener::from_std(std_listener).unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });

    let api = WebApiClient::new("127.0.0.1", addr.port());
    let echo = echo_script.to_string_lossy().to_string();
    let result = tokio::task::spawn_blocking(move || {
        // The settings-tree redirect and the env lock both live inside
        // this sync closure: the route derives builtin socket paths from
        // XDG_CONFIG_HOME at request time, so the redirect must cover
        // every request made here, and the lock keeps the other
        // env-sensitive tests from observing it (or flipping it mid-run).
        let _env_guard = crate::tests::lock_env();
        let config_home = std::env::temp_dir().join(format!(
            "herdr-composer-e2e-config-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&config_home).unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &config_home);
        // Drop-restore so a failing assertion cannot leak the redirect
        // into later tests in the same process.
        let _restore = EnvRedirectGuard(config_home);
        composer_submit_assertions(&api, &echo)
    })
    .await;
    result
        .unwrap()
        .unwrap_or_else(|err| panic!("composer e2e failed: {err}"));

    server.abort();
    let _ = std::fs::remove_dir_all(&repo);
    let bare = std::env::temp_dir().join(
        repo.file_name()
            .unwrap()
            .to_string_lossy()
            .replace("herdr-tui-e2e-repo-", "herdr-tui-e2e-bare-"),
    );
    let _ = std::fs::remove_dir_all(&bare);
}

/// Restores `XDG_CONFIG_HOME` and removes the redirected config tree
/// when dropped, even when the guarded assertions panic.
struct EnvRedirectGuard(PathBuf);

impl Drop for EnvRedirectGuard {
    fn drop(&mut self) {
        std::env::remove_var("XDG_CONFIG_HOME");
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn composer_submit_assertions(api: &WebApiClient, echo: &str) -> Result<(), String> {
    // Warm-up: the submit route auto-starts the built-in session on its
    // first call, so a submit to a pane that does not exist yet both
    // verifies the agent_not_found refusal shape and leaves the backend
    // ready for the raw socket connection below.
    let missing = api
        .submit_pane("pane_missing", "warm-up")
        .expect_err("missing pane must refuse");
    assert!(
        missing.to_string().contains("agent_not_found"),
        "expected an agent_not_found refusal, got: {missing}"
    );

    // One agent pane running the echo script through the backend socket
    // (the submit route's agent.prompt targets panes the backend owns).
    let (api_socket, _) = builtin_socket_paths(Some("default"));
    let backend = herdr_webui::backend_client::BackendClient::new(api_socket, PathBuf::new());
    let mut pane_id = None;
    for _ in 0..50 {
        if let Ok(started) = backend.request("agent.start", json!({ "name": echo, "argv": [echo] }))
        {
            pane_id = started["agent"]["pane_id"].as_str().map(str::to_string);
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let pane_id = pane_id.ok_or("agent.start never succeeded")?;

    // Round trip: submit a message, the echo script prints it back into
    // the pane tail. The Enter gap is 300ms server-side, so allow a few
    // polls for the line to land.
    api.submit_pane(&pane_id, "hello from the tui composer")
        .map_err(|err| format!("submit failed: {err}"))?;
    let mut tail = String::new();
    for _ in 0..40 {
        let read = backend
            .request("pane.read", json!({ "pane_id": pane_id }))
            .map_err(|err| format!("pane.read failed: {err}"))?;
        tail = read["read"]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        if tail.contains("hello from the tui composer") {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
    assert!(
        tail.contains("hello from the tui composer"),
        "echoed message never landed in the pane tail: {tail:?}"
    );

    // Blocked refusal: the second submitted line makes the echo script
    // print a Claurst-style permission dialog, and further submits must
    // refuse with the server-owned note. The refusal gate runs the
    // detection core fresh on every submit (not just the cached status),
    // so a starved sweeper cannot extend the window; poll the submit
    // itself until it refuses, since the dialog only becomes visible in
    // the tail after the paste+Enter round trip completes.
    api.submit_pane(&pane_id, "please print the dialog")
        .map_err(|err| format!("dialog submit failed: {err}"))?;
    let mut refusal = None;
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        match api.submit_pane(&pane_id, "should refuse") {
            Err(err) if err.to_string().contains("agent_blocked") => {
                refusal = Some(err);
                break;
            }
            // Not refused yet: the cached status has not caught up with
            // the dialog in the tail. Keep going.
            Ok(_) => continue,
            Err(other) => return Err(format!("submit errored unexpectedly: {other}")),
        }
    }
    let err = refusal.expect("blocked pane must refuse the submit");
    assert_eq!(
        err.to_string(),
        "WebUI API error 409: agent_blocked: the agent is waiting for an answer in the terminal"
    );
    assert_eq!(
        err.note(),
        "Not sent: the agent is waiting for an answer in the terminal. Answer it first."
    );
    Ok(())
}
