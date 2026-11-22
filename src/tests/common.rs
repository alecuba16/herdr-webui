//! Shared fixtures: test state, app router, env lock, temp dirs, fake sockets.

use super::*;

pub(crate) fn test_state() -> WebState {
    // ONE hash shared by auth and server_settings: a fresh salt per
    // hash_password call means two separate hashes of "pass" differ as
    // strings, and the identity-change detector compares stored strings,
    // so a mismatched pair would falsely rotate sessions on every save.
    let password_hash = crate::password_hashing::hash_password("pass").unwrap();
    let bind = DEFAULT_BIND.parse::<SocketAddr>().unwrap();
    let (rebind_tx, _) = tokio::sync::watch::channel(ListenEndpoint {
        bind,
        tls_mode: TlsMode::Auto,
    });
    let (settings_tx, _) = tokio::sync::broadcast::channel(16);
    let (notes_tx, _) = tokio::sync::broadcast::channel(16);
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
        herdr_install_cache: Arc::new(Mutex::new(None)),
        auth: Arc::new(Mutex::new(AuthConfig {
            user: Some("user".to_string()),
            // Stored form is a PHC hash of "pass", the same shape a real
            // deployment persists; login tests submit the plaintext.
            password: Some(password_hash.clone()),
            localhost_no_auth: false,
            sessions: vec![crate::auth::SessionRecord {
                token: "token-123".to_string(),
                expires_at: crate::auth::never_expires_at(),
            }],
            sessions_rev: 1,
            session_expiration_minutes: DEFAULT_SESSION_EXPIRATION_MINUTES,
        })),
        worktree_list_cache: Arc::new(WorktreeListCache::default()),
        login_limiter: Arc::new(LoginRateLimiter::new()),
        server_settings: Arc::new(Mutex::new(RuntimeServerSettings {
            bind,
            tls_mode: TlsMode::Auto,
            user: Some("user".to_string()),
            password: Some(password_hash),
            localhost_no_auth: false,
            session_expiration_minutes: DEFAULT_SESSION_EXPIRATION_MINUTES,
            no_sleep_auto_cooldown_seconds: 60,
            backend_mode: BackendMode::ExternalHerdr,
            builtin_shell: None,
            default_folder: std::env::temp_dir().to_string_lossy().to_string(),
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
        notes: Arc::new(Mutex::new(notes::NotesState::default())),
        notes_tx,
        panes_store: crate::workspace_panes_store::PanesStore::new(),
        workspace_orders: Arc::new(Mutex::new(HashMap::new())),
        lsp: Arc::new(lsp::LspRegistry::new(Default::default())),
        terminal_hub: Arc::new(terminal_hub::TerminalHub::new()),
    }
}

pub(crate) fn test_app() -> Router {
    app_router(test_state())
}

pub(crate) fn test_app_with_state(state: WebState) -> Router {
    app_router(state)
}

pub(crate) fn request(method: Method, uri: &str) -> axum::http::request::Builder {
    Request::builder()
        .method(method)
        .uri(uri)
        .extension(ConnectInfo("192.0.2.1:1234".parse::<SocketAddr>().unwrap()))
}

pub(crate) async fn response_json(response: Response) -> Value {
    let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// Create a unique temp dir for a test and remove it on scope exit, even
/// when the test panics (guard drop runs during unwind). Tests that build
/// a scratch tree must use this instead of a trailing remove_dir_all,
/// which a failed assert skips; that pattern leaked hundreds of dirs
/// into TMPDIR over repeated suite runs.
///
/// pid + nanos is not unique under the harness: parallel tests in one
/// process tie on nanos ~19% of the time (measured, ~21us clock
/// granularity), and a tie means two tests share one scratch dir. The
/// counter breaks the tie.
pub(crate) fn temp_guard(prefix: &str) -> (PathBuf, TempDirGuard) {
    sweep_dead_test_artifacts_once();
    static GUARD_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let id = GUARD_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "{prefix}-{}-{id}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    (dir.clone(), TempDirGuard(dir))
}

/// Retrying removal: pane children and language servers can hold handles
/// briefly past the test body, and a single failed remove would leak the
/// tree for good. 5s backstop mirrors the e2e RemoveTempDir guard.
pub(crate) struct TempDirGuard(PathBuf);

impl TempDirGuard {
    /// Wrap an already-created dir for scope-exit removal.
    pub(crate) fn new(path: PathBuf) -> Self {
        sweep_dead_test_artifacts_once();
        TempDirGuard(path)
    }
}

/// One-time-per-process sweep of stale `herdr-*` test artifacts (scratch
/// dirs and fake socket files) left in TMPDIR and /tmp by earlier runs.
/// They accumulated from panic-skipped trailing cleanups and fake socket
/// helpers whose accept threads never exit, reaching thousands of entries.
/// An artifact is stale only when the pid embedded in its name is dead
/// (one `ps ax -o pid=` batch), so artifacts owned by a concurrently
/// running test binary are never touched. Names without a parseable pid
/// (nanos-only) are skipped; pids are small, nanos are not.
pub(crate) fn sweep_dead_test_artifacts_once() {
    static SWEPT: OnceLock<()> = OnceLock::new();
    if SWEPT.set(()).is_err() {
        return;
    }
    let live: std::collections::HashSet<u32> = std::process::Command::new("ps")
        .arg("ax")
        .arg("-o")
        .arg("pid=")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|out| {
            out.lines()
                .filter_map(|line| line.trim().parse::<u32>().ok())
                .collect()
        })
        .unwrap_or_default();
    // When ps is unavailable, nothing is provably dead: skip the sweep
    // entirely rather than guess.
    if live.is_empty() {
        return;
    }
    let current = std::process::id();
    // Grace window: a test binary that started during this scan has not
    // created minute-old artifacts, so its fresh dirs and sockets are
    // never removed even if the ps snapshot raced its spawn.
    const GRACE: std::time::Duration = std::time::Duration::from_secs(60);
    let sweep_dir = |base: &Path| {
        let Ok(entries) = fs::read_dir(base) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !name.starts_with("herdr-") {
                continue;
            }
            // fake_socket_dir names have no dash: herdr-wui-t<pid>.
            if let Some(rest) = name.strip_prefix("herdr-wui-t") {
                if let Ok(pid) = rest.parse::<u32>() {
                    if pid != current && !live.contains(&pid) {
                        let path = entry.path();
                        let stale = entry
                            .metadata()
                            .and_then(|meta| meta.modified())
                            .map(|mtime| mtime.elapsed().map(|age| age >= GRACE).unwrap_or(true))
                            .unwrap_or(true);
                        if stale {
                            if path.is_dir() {
                                let _ = fs::remove_dir_all(&path);
                            } else {
                                let _ = fs::remove_file(&path);
                            }
                        }
                    }
                    continue;
                }
            }
            let Some(pid) = embedded_test_pid(name) else {
                continue;
            };
            if pid == current || live.contains(&pid) {
                continue;
            }
            let path = entry.path();
            let stale = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .map(|mtime| mtime.elapsed().map(|age| age >= GRACE).unwrap_or(true))
                .unwrap_or(true);
            if !stale {
                continue;
            }
            if path.is_dir() {
                let _ = fs::remove_dir_all(&path);
            } else {
                let _ = fs::remove_file(&path);
            }
        }
    };
    sweep_dir(&std::env::temp_dir());
    // fake_socket_dir uses /tmp directly, not TMPDIR.
    sweep_dir(Path::new("/tmp"));
}

/// Extract the owning pid from a herdr test artifact name: the first
/// all-digits dash component below 10 million (pids are small; nanos
/// timestamps never pass that bar).
pub(crate) fn embedded_test_pid(name: &str) -> Option<u32> {
    name.split('-')
        .filter_map(|part| part.parse::<u32>().ok())
        .find(|pid| *pid < 10_000_000)
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::fs::remove_dir_all(&self.0).is_err() && self.0.exists() {
            if std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
}

/// Monotonic suffix for fake-socket names. Timestamps alone can collide
/// when parallel tests start within the same clock tick on loaded CI
/// runners; a collision makes the second create clobber the first
/// listener and the first accept() fail (observed as flaky 502s in
/// proxy tests that never fail locally).
pub(crate) fn fake_socket_suffix() -> u64 {
    static COUNTER: OnceLock<std::sync::atomic::AtomicU64> = OnceLock::new();
    COUNTER
        .get_or_init(|| std::sync::atomic::AtomicU64::new(0))
        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

/// Deterministic directory for fake local-socket paths whose length must
/// stay under `SOCKET_PATH_LIMIT` even on CI runners whose TMPDIR is a
/// long per-job path (GitHub macOS runners use ~70+ byte temp dirs, so a
/// nanos-based name there would push the attach socket over the limit
/// and the relay would reject it before ever connecting).
#[cfg(unix)]
pub(crate) fn fake_socket_dir() -> PathBuf {
    static DIR: OnceLock<PathBuf> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = PathBuf::from("/tmp").join(format!("herdr-wui-t{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        dir
    })
    .clone()
}

#[cfg(unix)]
pub(crate) fn fake_api_socket(response: serde_json::Value) -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = std::env::temp_dir().join(format!(
        "herdr-webui-api-test-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let handle = thread::spawn(move || {
        let mut stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], "ping");
        stream
            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
            .unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    });
    (path, handle)
}

/// Fake herdr client socket for a terminal attach: answers the
/// TerminalHello handshake, records the AttachTerminal target, and
/// relays every forwarded ClientMessage (input etc.) to `received` so
/// tests can assert what the WS layer actually forwarded. The stream
/// stays open until the test drops the socket, keeping the relay loop
/// in its Ok(_) => {} steady state.
#[cfg(unix)]
pub(crate) fn fake_terminal_attach_socket(
    received: std::sync::mpsc::Sender<String>,
) -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = fake_socket_dir().join(format!(
        "attach-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let handle = thread::spawn(move || {
        // Every WS scenario opens its own attach connection; serve each
        // accepted stream on its own thread so several sequential
        // terminal sockets can handshake against one listener.
        while let Ok(mut stream) = listener.accept() {
            let received = received.clone();
            thread::spawn(move || {
                let mut writer = stream.try_clone().unwrap();
                // TerminalHello -> Welcome(error: None). Not sending
                // further frames keeps the WS relay loop idle and
                // teardown in the caller's control.
                let _ = read_message::<_, ClientMessage>(&mut stream, MAX_FRAME_SIZE);
                let _ = write_message(
                    &mut writer,
                    &ServerMessage::Welcome {
                        version: PROTOCOL_VERSION,
                        encoding: RenderEncoding::TerminalAnsi,
                        error: None,
                    },
                );
                let _ = read_message::<_, ClientMessage>(&mut stream, MAX_FRAME_SIZE);
                loop {
                    match read_message::<_, ClientMessage>(&mut stream, MAX_FRAME_SIZE) {
                        Ok(ClientMessage::Detach) => break,
                        Ok(message) => {
                            let _ = received.send(format!("{message:?}"));
                        }
                        Err(_) => break,
                    }
                }
            });
        }
    });
    (path, handle)
}

/// Fake API socket that records every tab.close request into `closed`
/// and answers with an empty result. Unlike `fake_api_socket_multi` it
/// accepts any number of connections until the channel receiver is
/// dropped, so several teardown scenarios can share one listener.
#[cfg(unix)]
pub(crate) fn fake_api_socket_recording(
    closed: tokio::sync::mpsc::UnboundedSender<String>,
) -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = fake_socket_dir().join(format!(
        "close-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let handle = thread::spawn(move || {
        while let Ok(mut stream) = listener.accept() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                break;
            }
            let Ok(request) = serde_json::from_str::<serde_json::Value>(&line) else {
                break;
            };
            if request["method"] == "tab.close" {
                if let Some(tab_id) = request["params"]["tab_id"].as_str() {
                    let _ = closed.send(tab_id.to_string());
                }
            }
            let _ = stream.write_all(
                serde_json::to_string(&json!({ "id": request["id"], "result": {} }))
                    .unwrap()
                    .as_bytes(),
            );
            let _ = stream.write_all(b"\n");
            let _ = stream.flush();
        }
    });
    (path, handle)
}

/// Fake API socket that reads one request then closes the connection
/// without responding, simulating a backend that shuts down on server.stop.
#[cfg(unix)]
pub(crate) fn fake_api_socket_drop_on_stop() -> (
    PathBuf,
    std::sync::Arc<std::sync::Mutex<bool>>,
    thread::JoinHandle<()>,
) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};
    use std::sync::Arc;
    use std::sync::Mutex;

    let path = std::env::temp_dir().join(format!(
        "herdr-webui-stop-test-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let saw_stop = Arc::new(Mutex::new(false));
    let saw_stop_clone = saw_stop.clone();
    let handle = thread::spawn(move || {
        let stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        if request["method"] == "server.stop" {
            *saw_stop_clone.lock().unwrap() = true;
            // Drop the connection without responding, simulating backend shutdown.
            drop(stream);
        }
    });
    (path, saw_stop, handle)
}

// ────────────────────────────────────────────────────────────────────
// Flexible fake socket helpers for testing spawn_blocking handlers
// ────────────────────────────────────────────────────────────────────

/// Fake API socket that accepts a request, checks the method, and
/// responds with the given JSON value.  Handles any method (not just
/// "ping" like `fake_api_socket`).
#[cfg(unix)]
pub(crate) fn fake_api_socket_for_method(
    expected_method: &str,
    response: serde_json::Value,
) -> (PathBuf, thread::JoinHandle<()>) {
    let path = std::env::temp_dir().join(format!(
        "herdr-webui-test-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    fake_api_socket_for_method_at(path, expected_method, response)
}

/// Binds the fake API socket at an explicit path instead of temp_dir.
/// Use when the test needs the fake at a location outside temp_dir:
/// rename(2) across filesystems fails with EXDEV (cross-device link)
/// inside sandboxes where TMPDIR and the target dir differ in device.
#[cfg(unix)]
pub(crate) fn fake_api_socket_for_method_at(
    path: PathBuf,
    expected_method: &str,
    response: serde_json::Value,
) -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let expected = expected_method.to_string();
    let handle = thread::spawn(move || {
        let mut stream = listener.accept().unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let request: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(request["method"], expected, "unexpected method");
        stream
            .write_all(serde_json::to_string(&response).unwrap().as_bytes())
            .unwrap();
        stream.write_all(b"\n").unwrap();
        stream.flush().unwrap();
    });
    (path, handle)
}

/// Fake API socket that accepts multiple sequential requests, responding
/// to each with the corresponding value in `responses`.
#[cfg(unix)]
pub(crate) fn fake_api_socket_multi(
    responses: Vec<serde_json::Value>,
) -> (PathBuf, thread::JoinHandle<()>) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = std::env::temp_dir().join(format!(
        "herdr-webui-multi-test-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let handle = thread::spawn(move || {
        for resp in responses {
            let mut stream = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            stream
                .write_all(serde_json::to_string(&resp).unwrap().as_bytes())
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
        }
    });
    (path, handle)
}

pub(crate) fn authed_request(method: Method, uri: &str) -> axum::http::request::Builder {
    request(method, uri).header(header::COOKIE, "herdr_web_session=token-123")
}

// Fake API socket that answers any number of requests: one queued response
// per connection, echoing the request id, and records every request line for
// assertions. match_cwd-marked worktree.list replies route by params.cwd
// (marker stripped); the listener exits once the queue drains so join() completes.
#[cfg(unix)]
pub(crate) fn fake_api_socket_multi_recording(
    responses: Vec<serde_json::Value>,
) -> (
    PathBuf,
    thread::JoinHandle<()>,
    std::sync::mpsc::Receiver<String>,
) {
    use interprocess::local_socket::{prelude::*, GenericFilePath, ListenerOptions};

    let path = std::env::temp_dir().join(format!(
        "herdr-webui-multi-rec-{}-{}.sock",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        fake_socket_suffix()
    ));
    let _ = fs::remove_file(&path);
    let name = path.clone().to_fs_name::<GenericFilePath>().unwrap();
    let listener = ListenerOptions::new()
        .name(name)
        .try_overwrite(true)
        .create_sync()
        .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let handle = thread::spawn(move || {
        let mut remaining = responses;
        for conn in listener.incoming() {
            let Ok(mut stream) = conn else {
                break;
            };
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            if reader.read_line(&mut line).is_err() {
                break;
            }
            let _ = tx.send(line.clone());
            if remaining.is_empty() {
                break;
            }
            let request = serde_json::from_str::<serde_json::Value>(&line).ok();
            let requested_cwd = request
                .as_ref()
                .and_then(|request| request["params"]["cwd"].as_str())
                .map(str::to_string);
            // worktree.list fetches run in parallel: pick the queued
            // response by its cwd marker when one matches, everything else
            // takes the first queued response (legacy positional order).
            let index = remaining
                .iter()
                .position(|resp| {
                    if request
                        .as_ref()
                        .is_some_and(|request| request["method"] == "worktree.list")
                    {
                        resp.get("match_cwd")
                            .and_then(serde_json::Value::as_str)
                            .map(|cwd| Some(cwd) == requested_cwd.as_deref())
                            .unwrap_or(false)
                    } else {
                        !resp.get("match_cwd").is_some()
                    }
                })
                .unwrap_or(0);
            let mut resp = remaining.remove(index);
            if let Some(request) = &request {
                resp["id"] = request["id"].clone();
            }
            if let Some(object) = resp.as_object_mut() {
                object.remove("match_cwd");
            }
            stream
                .write_all(serde_json::to_string(&resp).unwrap().as_bytes())
                .unwrap();
            stream.write_all(b"\n").unwrap();
            stream.flush().unwrap();
            if remaining.is_empty() {
                break;
            }
        }
    });
    (path, handle, rx)
}
