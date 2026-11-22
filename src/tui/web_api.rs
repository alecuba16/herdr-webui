use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};

/// Connection-establishment budget for the loopback WebUI server. A
/// live server accepts in milliseconds; a dead endpoint must fail in
/// seconds, not wait out the 20s request timeout (or the ~75s platform
/// default) before the TUI can say anything.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(2);

/// Blocking HTTP/1.1 client for the local WebUI JSON API.
///
/// The TUI control plane runs over local sockets (`BackendClient`), but the
/// file browser and Git UI functionality is only exposed through the WebUI
/// HTTP routes. This client talks to the WebUI server bound on localhost
/// (default `127.0.0.1:8787`, overridable with `HERDR_WEBUI_TUI_API` or the
/// `--webui-api HOST:PORT` flag). It only supports plain HTTP because the
/// TUI connects from the same machine over loopback; HTTPS deployments fall
/// back with a clear error.
///
/// Auth parity: the server stores a non-recoverable Argon2id hash, so the
/// password is gone from `webui-settings.json` and password login is not
/// an option for this client. Instead the server persists its live
/// session set (0600 `session-token` sidecar next to the settings file,
/// same ownership as the operator's account) and this client replays one
/// of those tokens as the `herdr_web_session` cookie on a 401. A stale
/// token (expired or rotated out by the LRU cap) falls back to the next
/// live record; when none work the 401 surfaces like any other HTTP
/// error and the user logs in from a browser once — the server persists
/// that new session, so the TUI recovers on its next call without ever
/// holding a password. `localhost_no_auth` servers never 401, so nothing
/// changes for the default local setup.
#[derive(Debug, Clone)]
pub struct WebApiClient {
    transport: WebApiTransport,
    timeout: Duration,
    /// Connection establishment budget. Kept separate from `timeout`: a
    /// live loopback server accepts in milliseconds, so 2s is already
    /// generous, while the read/write side keeps the full 20s silence
    /// window for slow-but-alive replies.
    connect_timeout: Duration,
    /// Cached `herdr_web_session` cookie from a successful login.
    /// Interior mutability so `request_json(&self)` can keep the cookie
    /// after the 401 login retry — without it the cookie would land on
    /// a dropped temporary and every authed call would re-login.
    session_cookie: std::cell::RefCell<Option<String>>,
}

/// Where the git/file panel data comes from. The default is the WebUI
/// HTTP server; `Socket` talks to the built-in backend control socket
/// instead (the same `git.*`/`file.*` methods the backend dispatches
/// for its own panels), which keeps the TUI working even when the HTTP
/// server is not running and skips the HTTP auth dance entirely.
#[derive(Debug, Clone)]
enum WebApiTransport {
    Http { host: String, port: u16 },
    Socket { api_socket: std::path::PathBuf },
}

/// Replayed session token read from the server's `session-token` sidecar.
/// Replaces the old credential struct: with a hashed password on disk
/// there is no plaintext to log in with, so the cookie replay is the
/// whole fallback story.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebApiSessionToken {
    pub token: String,
}

#[derive(Debug)]
pub enum WebApiError {
    Io(String),
    InvalidUrl(String),
    Http {
        status: u16,
        message: String,
    },
    /// HTTP error whose parsed body carried structured fields: the
    /// raw `message` plus whatever the route attached (the composer
    /// submit route adds `code` and the human-facing `note`).
    HttpDetailed {
        status: u16,
        message: String,
        body: Value,
    },
    Json(String),
    Api(String),
}

/// Shared io-error mapping so the map_err sites count as one covered
/// function instead of one closure per call site.
fn io_err<E: std::fmt::Display>(err: E) -> WebApiError {
    WebApiError::Io(err.to_string())
}

impl std::fmt::Display for WebApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io(message) => write!(f, "webui connection failed: {message}"),
            Self::InvalidUrl(message) => write!(f, "invalid WebUI API url: {message}"),
            Self::Http { status, message } => {
                if message.is_empty() {
                    write!(f, "WebUI API error {status}")
                } else {
                    write!(f, "WebUI API error {status}: {message}")
                }
            }
            Self::HttpDetailed {
                status, message, ..
            } => {
                if message.is_empty() {
                    write!(f, "WebUI API error {status}")
                } else {
                    write!(f, "WebUI API error {status}: {message}")
                }
            }
            Self::Json(message) => write!(f, "invalid WebUI API response: {message}"),
            Self::Api(message) => write!(f, "{message}"),
        }
    }
}

impl WebApiError {
    /// The route-provided human note for a failed composer submit
    /// (`{error, code, note}` bodies). Falls back to the raw message,
    /// mirroring the browser composer's `details.note || error` rule.
    pub fn note(&self) -> String {
        match self {
            Self::HttpDetailed { body, message, .. } => body
                .get("note")
                .and_then(Value::as_str)
                .unwrap_or(message)
                .to_string(),
            other => other.to_string(),
        }
    }
}

impl std::error::Error for WebApiError {}

impl WebApiClient {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            transport: WebApiTransport::Http {
                host: host.into(),
                port,
            },
            timeout: Duration::from_secs(20),
            connect_timeout: CONNECT_TIMEOUT,
            session_cookie: std::cell::RefCell::new(None),
        }
    }

    /// Git/file data straight from the built-in backend control socket
    /// (`git.*` / `file.*` dispatch). Used by the TUI when backend
    /// sockets are known: no HTTP server, no auth, no cookie dance.
    pub fn from_backend_socket(api_socket: impl Into<std::path::PathBuf>) -> Self {
        Self {
            transport: WebApiTransport::Socket {
                api_socket: api_socket.into(),
            },
            timeout: Duration::from_secs(20),
            connect_timeout: CONNECT_TIMEOUT,
            session_cookie: std::cell::RefCell::new(None),
        }
    }

    pub fn is_socket_transport(&self) -> bool {
        matches!(self.transport, WebApiTransport::Socket { .. })
    }

    /// Restore a session from the server's `session-token` sidecar and
    /// cache the first cookie that works (RefCell, so `&self` suffices).
    /// Called by `request_json` after a 401; tests call it directly too.
    /// Walks the sidecar records in file order (LRU, least recent first):
    /// the replay refreshes the coldest session, keeping the hot browser
    /// sessions at the top of the LRU rank where the eviction cap cannot
    /// touch them.
    pub fn replay_session(&self, tokens: &[WebApiSessionToken]) -> Result<(), WebApiError> {
        let mut last_error = None;
        for token in tokens {
            let cookie = format!("herdr_web_session={}", token.token);
            *self.session_cookie.borrow_mut() = Some(cookie);
            // Probe an authed route; a fresh 401 means this record is
            // stale (expired or rotated out), so fall through to the next
            // one instead of caching a dead cookie.
            match self.raw_request_json("GET", "/api/recent-workspaces", None) {
                Ok(_) => return Ok(()),
                Err(WebApiError::Http { status: 401, .. }) => {
                    last_error = Some(WebApiError::Http {
                        status: 401,
                        message: "session token from sidecar was rejected".to_string(),
                    });
                    continue;
                }
                Err(other) => return Err(other),
            }
        }
        *self.session_cookie.borrow_mut() = None;
        Err(last_error.unwrap_or(WebApiError::Http {
            status: 401,
            message: "no live session token in the sidecar (log in once from a browser)"
                .to_string(),
        }))
    }

    /// Parse `HOST:PORT` or `http://HOST:PORT[/]`. HTTPS URLs are rejected
    /// with a clear error because the TUI only talks plain HTTP over
    /// loopback.
    pub fn parse_url(url: &str) -> Result<Self, WebApiError> {
        let trimmed = url.trim();
        let invalid = |value: &str| {
            WebApiError::InvalidUrl(format!(
                "expected HOST:PORT like 127.0.0.1:8787, got '{value}'"
            ))
        };
        if trimmed.starts_with("https://") {
            return Err(WebApiError::InvalidUrl(
                "https is not supported; the TUI expects the local WebUI HTTP server".to_string(),
            ));
        }
        let rest = trimmed.strip_prefix("http://").unwrap_or(trimmed);
        let authority = rest.split('/').next().unwrap_or(rest);
        let (host, port) = authority.rsplit_once(':').ok_or_else(|| invalid(trimmed))?;
        if host.is_empty() {
            return Err(invalid(trimmed));
        }
        let port: u16 = port.parse().map_err(|_| invalid(trimmed))?;
        Ok(Self::new(host.to_string(), port))
    }

    /// Resolve the WebUI API endpoint from the persisted settings file, the
    /// `HERDR_WEBUI_TUI_API` env var, or the default bind address.
    pub fn discover() -> Result<Self, WebApiError> {
        if let Ok(value) = std::env::var("HERDR_WEBUI_TUI_API") {
            if !value.trim().is_empty() {
                return Self::parse_url(&value);
            }
        }
        if let Some(bind) = persisted_bind_address() {
            let bind = bind.trim().trim_start_matches("http://");
            if let Some((host, port)) = bind.rsplit_once(':') {
                if let Ok(port) = port.trim().parse::<u16>() {
                    if !host.is_empty() {
                        return Ok(Self::new(host.trim().to_string(), port));
                    }
                }
            }
        }
        Ok(Self::new("127.0.0.1", default_web_api_port()))
    }

    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    pub fn base_url(&self) -> String {
        match &self.transport {
            WebApiTransport::Http { host, port } => format!("http://{host}:{port}"),
            WebApiTransport::Socket { api_socket } => {
                format!("socket://{}", api_socket.to_string_lossy())
            }
        }
    }

    /// Auth-aware request: on 401 (server auth enabled, no cookie yet)
    /// restores a session from the server's sidecar and retries once.
    /// Everything else flows through unchanged. Without a live token in
    /// the sidecar the 401 surfaces like any other HTTP error; the fix is
    /// one browser login, after which the server persists that session
    /// and the next TUI call picks it up. A stale cookie (WebUI restart
    /// rotated the token) also recovers this way: the guard allows one
    /// replay whenever the 401 is not already the result of the
    /// immediately-preceding replay, and the replay overwrites the
    /// cookie, so recovery is automatic.
    fn request_json(
        &self,
        method: &str,
        path_and_query: &str,
        body: Option<&Value>,
    ) -> Result<Value, WebApiError> {
        let mut attempted_session_restore = false;
        loop {
            match self.raw_request_json(method, path_and_query, body) {
                Err(WebApiError::Http { status: 401, .. }) if !attempted_session_restore => {
                    let Some(tokens) = persisted_session_tokens() else {
                        return Err(WebApiError::Http {
                            status: 401,
                            message:
                                "unauthorized (no live session token; log in once from a browser)"
                                    .to_string(),
                        });
                    };
                    // The working cookie lands on `self` (RefCell), so
                    // later calls skip the replay; a stale one is replaced
                    // here when the server rotated its token.
                    self.replay_session(&tokens)?;
                    attempted_session_restore = true;
                }
                other => return other,
            }
        }
    }

    /// Wire-level request. Sends the cached session cookie when present.
    fn raw_request_json(
        &self,
        method: &str,
        path_and_query: &str,
        body: Option<&Value>,
    ) -> Result<Value, WebApiError> {
        let body_text = match body {
            Some(value) => encode_body(value),
            None => String::new(),
        };
        let cookie_header = self
            .session_cookie
            .borrow()
            .as_deref()
            .map(|cookie| format!("Cookie: {cookie}\r\n"))
            .unwrap_or_default();
        let (host, port) = match &self.transport {
            WebApiTransport::Http { host, port } => (host.as_str(), *port),
            WebApiTransport::Socket { .. } => {
                return Err(WebApiError::Api(
                    "recent-workspace and login calls need the WebUI HTTP server".to_string(),
                ));
            }
        };
        let request = format!(
            "{method} {path_and_query} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nUser-Agent: herdr-webui-tui\r\n{cookie_header}\r\n{body_text}",
            host,
            port,
            body_text.len(),
        );
        // connect() without a bound would wait on the platform default
        // (~75s on macOS) when the WebUI server is unreachable; cap the
        // handshake with the short connect budget (loopback accepts in
        // milliseconds) so a dead endpoint fails fast, then hand the stream
        // the full request timeout for reads/writes. Accept both literal
        // IPs and hostnames (e.g. "localhost").
        let addr = resolve_web_api_addr(host, port)?;
        let mut stream = TcpStream::connect_timeout(&addr, self.connect_timeout).map_err(io_err)?;
        // The timeout setsockopt calls carry a constant valid value on
        // a live fd, so their error arms are dropped; real failures
        // surface on the write or read right after.
        let _ = stream.set_read_timeout(Some(self.timeout));
        let _ = stream.set_write_timeout(Some(self.timeout));
        // Write directly on the stream: try_clone of a live fd and
        // flush on a TcpStream (a no-op) never fail in practice, so
        // neither carries an error arm worth mapping.
        stream.write_all(request.as_bytes()).map_err(io_err)?;

        let mut reader = BufReader::new(stream);
        let mut status_line = String::new();
        reader.read_line(&mut status_line).map_err(io_err)?;
        let status: u16 = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| WebApiError::Io(format!("malformed status line: {status_line:?}")))?;
        let mut content_length: Option<usize> = None;
        let mut chunked = false;
        loop {
            let mut header = String::new();
            let read = reader.read_line(&mut header).map_err(io_err)?;
            if read == 0 {
                return Err(WebApiError::Io("connection closed before headers".into()));
            }
            let header = header.trim();
            if header.is_empty() {
                break;
            }
            let lower = header.to_ascii_lowercase();
            if let Some(value) = lower.strip_prefix("content-length:") {
                content_length = value.trim().parse().ok();
            } else if lower.starts_with("transfer-encoding:") && lower.contains("chunked") {
                chunked = true;
            }
        }
        let body_bytes = if chunked {
            read_chunked_body(&mut reader)?
        } else {
            let mut body = Vec::new();
            if let Some(length) = content_length {
                body.resize(length, 0);
                reader.read_exact(&mut body).map_err(io_err)?;
            } else {
                reader.read_to_end(&mut body).map_err(io_err)?;
            }
            body
        };
        let value: Value = if body_bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body_bytes).map_err(|err| WebApiError::Json(err.to_string()))?
        };
        if !(200..300).contains(&status) {
            let message = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            // Routes that attach structured fields (composer submit:
            // `{error, code, note}`) keep the parsed body so callers can
            // read them; plain errors stay on the simple shape.
            if value
                .as_object()
                .is_some_and(|fields| fields.len() > 1 && fields.contains_key("error"))
            {
                return Err(WebApiError::HttpDetailed {
                    status,
                    message,
                    body: value,
                });
            }
            return Err(WebApiError::Http { status, message });
        }
        Ok(value)
    }

    // ---- recent workspaces (desktop search palette Recent section) ----

    /// `GET /api/recent-workspaces`: server-persisted list of recently
    /// opened workspaces/worktrees, pruned server-side of missing folders.
    pub fn recent_workspaces(&self) -> Result<Value, WebApiError> {
        self.get("/api/recent-workspaces")
    }

    /// `POST /api/recent-workspaces`: reopen the workspace/worktree at
    /// `path` (the server proxies `worktree.open` with `focus: true` and
    /// re-records the entry, exactly the desktop palette open flow).
    pub fn open_recent_workspace(
        &self,
        path: &str,
        label: Option<&str>,
    ) -> Result<Value, WebApiError> {
        let body = serde_json::json!({ "path": path, "label": label });
        self.post("/api/recent-workspaces", &body)
    }

    /// `POST /api/recent-workspaces/record`: record a workspace the
    /// TUI just created/opened through the backend socket (desktop
    /// fires the same record client-side after `POST
    /// /api/workspaces`). Best effort by design.
    pub fn record_recent_workspace(
        &self,
        path: &str,
        label: Option<&str>,
        kind: Option<&str>,
    ) -> Result<Value, WebApiError> {
        self.post(
            "/api/recent-workspaces/record",
            &serde_json::json!({ "path": path, "label": label, "kind": kind }),
        )
    }

    /// `POST /api/recent-workspaces/remove`: drop one entry by path.
    /// The server validates and expands the raw path itself.
    pub fn remove_recent_workspace(&self, path: &str) -> Result<Value, WebApiError> {
        self.post(
            "/api/recent-workspaces/remove",
            &serde_json::json!({ "path": path }),
        )
    }

    /// `POST /api/recent-workspaces/clear`: drop every entry.
    pub fn clear_recent_workspaces(&self) -> Result<Value, WebApiError> {
        self.post("/api/recent-workspaces/clear", &serde_json::json!({}))
    }

    /// `GET /api/sessions`: every session the server knows (built-in
    /// plus external herdr), each with backend/running/api_socket.
    /// HTTP-only: the list and its probes live in the WebUI server.
    pub fn sessions_list(&self) -> Result<Value, WebApiError> {
        self.get("/api/sessions")
    }

    /// `POST /api/session/launch`: start (or revive) a session and
    /// switch the response to it. `backend` is "builtin" or
    /// "external-herdr".
    pub fn session_launch(&self, name: &str, backend: &str) -> Result<Value, WebApiError> {
        self.post(
            "/api/session/launch",
            &serde_json::json!({ "session": name, "backend": backend }),
        )
    }

    /// `POST /api/session/close`: stop the session's backend.
    pub fn session_close(&self, name: &str, backend: &str) -> Result<Value, WebApiError> {
        self.post(
            "/api/session/close",
            &serde_json::json!({ "session": name, "backend": backend }),
        )
    }

    /// `POST /api/session/cleanup`: delete stale built-in session
    /// slots (dead sockets from crashes). Server refuses non-builtin.
    pub fn session_cleanup(&self) -> Result<Value, WebApiError> {
        self.post("/api/session/cleanup", &serde_json::json!({}))
    }

    /// `POST /api/panes/{pane_id}/submit`: send one composer message to
    /// the pane's agent through the server's `agent.prompt` (ux
    /// overhaul composer parity). The server owns validation, error
    /// classification, and refusal copy; a refusal arrives as an HTTP
    /// error whose body carries `{error, code, note}` and surfaces as
    /// `WebApiError::HttpDetailed` so the caller can show `note()`.
    pub fn submit_pane(&self, pane_id: &str, text: &str) -> Result<Value, WebApiError> {
        let body = serde_json::json!({ "text": text });
        self.post(&format!("/api/panes/{}/submit", urlencode(pane_id)), &body)
    }

    /// Long-press Send variant: the server forwards `enqueue: true` to
    /// `agent.prompt`, which types the message and sends Ctrl+Enter
    /// (kitty CSI-u) instead of Enter, so a running agent queues the
    /// message instead of interrupting. Same refusal surface as
    /// `submit_pane`.
    pub fn submit_pane_enqueued(&self, pane_id: &str, text: &str) -> Result<Value, WebApiError> {
        let body = serde_json::json!({ "text": text, "enqueue": true });
        self.post(&format!("/api/panes/{}/submit", urlencode(pane_id)), &body)
    }

    /// `GET /api/panes/{pane_id}/prompt`: the server-side parse of the
    /// pane's question dialog (same tail source and parser the server
    /// already runs for the web prompt card). HTTP-only like the
    /// recent-workspaces calls: the parse lives in the WebUI server,
    /// not the backend socket dispatch. Not wired into the TUI UI yet;
    /// kept for the prompt-card parity work that will consume it.
    pub fn pane_prompt(&self, pane_id: &str) -> Result<Value, WebApiError> {
        self.get(&format!("/api/panes/{}/prompt", urlencode(pane_id)))
    }

    fn get(&self, path_and_query: &str) -> Result<Value, WebApiError> {
        self.request_json("GET", path_and_query, None)
    }

    fn post(&self, path: &str, body: &Value) -> Result<Value, WebApiError> {
        self.request_json("POST", path, Some(body))
    }

    // ---- file browser ----

    /// Route one git/file panel call to whichever transport is active.
    /// `http_*` describes the WebUI HTTP request; `socket_method` and
    /// `socket_params` describe the equivalent built-in backend socket
    /// call. Recent-workspaces calls stay HTTP-only (that state lives in
    /// the WebUI server) and never go through here.
    fn call(
        &self,
        http_method: &str,
        http_path_and_query: &str,
        http_body: Option<&Value>,
        socket_method: &str,
        socket_params: Value,
    ) -> Result<Value, WebApiError> {
        match &self.transport {
            WebApiTransport::Http { .. } => {
                self.request_json(http_method, http_path_and_query, http_body)
            }
            WebApiTransport::Socket { api_socket } => {
                let client = crate::backend_client::BackendClient::new(
                    api_socket.clone(),
                    api_socket.clone(),
                );
                client
                    .request(socket_method, socket_params)
                    .map_err(|err| WebApiError::Api(err.to_string()))
            }
        }
    }

    pub fn file_tree(&self, cwd: &str, path: &str, depth: u8) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!(
                "/api/file-browser/tree?cwd={}&path={}&depth={depth}&include_git_status=true",
                urlencode(cwd),
                urlencode(path),
            ),
            None,
            "file.tree",
            json!({
                "cwd": cwd,
                "path": path,
                "depth": depth,
                "include_git_status": true,
            }),
        )
    }

    pub fn file_search(
        &self,
        cwd: &str,
        path: &str,
        query: &str,
        offset: usize,
        limit: usize,
        dirs_only: bool,
    ) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!(
                "/api/file-browser/tree?cwd={}&path={}&q={}&offset={offset}&limit={limit}&search_kind={}&include_git_status=true",
                urlencode(cwd),
                urlencode(path),
                urlencode(query),
                if dirs_only { "dir" } else { "file" },
            ),
            None,
            "file.tree",
            json!({
                "cwd": cwd,
                "path": path,
                "q": query,
                "offset": offset,
                "limit": limit,
                "search_kind": if dirs_only { "dir" } else { "file" },
                "include_git_status": true,
            }),
        )
    }

    /// `/api/file-browser/content-search`: grep-style results grouped
    /// per file with pre-merged context chunks. `offset`/`limit` page
    /// over files; `match_case`/`regex` mirror the webui toggles.
    pub fn content_search(
        &self,
        cwd: &str,
        path: &str,
        query: &str,
        offset: usize,
        limit: usize,
        match_case: bool,
        regex: bool,
    ) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!(
                "/api/file-browser/content-search?cwd={}&path={}&q={}&offset={offset}&limit={limit}&context_lines=2&match_case={}&regex={}",
            urlencode(cwd),
            urlencode(path),
            urlencode(query),
            if match_case { "true" } else { "false" },
            if regex { "true" } else { "false" },
            ),
            None,
            "file.content_search",
            json!({
                "cwd": cwd,
                "path": path,
                "q": query,
                "offset": offset,
                "limit": limit,
                "context_lines": 2,
                "match_case": match_case,
                "regex": regex,
            }),
        )
    }

    pub fn file_read(&self, cwd: &str, path: &str) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!(
                "/api/file-browser/file?cwd={}&path={}",
                urlencode(cwd),
                urlencode(path)
            ),
            None,
            "file.read",
            json!({ "cwd": cwd, "path": path }),
        )
    }

    pub fn file_write(
        &self,
        cwd: &str,
        path: &str,
        content: &str,
        expected_hash: Option<&str>,
    ) -> Result<Value, WebApiError> {
        self.file_write_ext(cwd, path, content, expected_hash, false)
    }

    /// `file_write` with `create_parents`: missing intermediate
    /// directories are created (new-file/new-directory flow).
    pub fn file_write_create(
        &self,
        cwd: &str,
        path: &str,
        content: &str,
    ) -> Result<Value, WebApiError> {
        self.file_write_ext(cwd, path, content, None, true)
    }

    fn file_write_ext(
        &self,
        cwd: &str,
        path: &str,
        content: &str,
        expected_hash: Option<&str>,
        create_parents: bool,
    ) -> Result<Value, WebApiError> {
        let body = json!({
                "cwd": cwd,
                "path": path,
                "content": content,
                "expected_hash": expected_hash,
                "create_parents": create_parents,
        });
        self.call(
            "POST",
            "/api/file-browser/file",
            Some(&body),
            "file.write",
            body.clone(),
        )
    }

    pub fn file_rename(&self, cwd: &str, path: &str, new_name: &str) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "path": path, "new_name": new_name });
        self.call(
            "POST",
            "/api/file-browser/rename",
            Some(&body),
            "file.rename",
            body.clone(),
        )
    }

    pub fn file_delete(&self, cwd: &str, path: &str) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "path": path });
        self.call(
            "POST",
            "/api/file-browser/delete",
            Some(&body),
            "file.delete",
            body.clone(),
        )
    }

    // ---- git ui ----

    pub fn git_status(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!("/api/git-ui/status?cwd={}", urlencode(cwd)),
            None,
            "git.status",
            json!({ "cwd": cwd }),
        )
    }

    pub fn git_diff(
        &self,
        cwd: &str,
        scope: &str,
        file: Option<&str>,
    ) -> Result<Value, WebApiError> {
        let mut url = format!(
            "/api/git-ui/diff?cwd={}&scope={}&context=3",
            urlencode(cwd),
            urlencode(scope),
        );
        if let Some(file) = file {
            url.push_str(&format!("&file={}", urlencode(file)));
        }
        self.call(
            "GET",
            &url,
            None,
            "git.diff",
            json!({ "cwd": cwd, "scope": scope, "context": 3, "file": file }),
        )
    }

    /// `/api/git-ui/log` with full webui params: `scope` (all /
    /// base-current / base), `base` branch, per-page `max` and an
    /// optional file filter (webui `logFilePath`). `all` is redundant
    /// with `scope` but the server reads both.
    pub fn git_log_scoped(
        &self,
        cwd: &str,
        scope: &str,
        base: &str,
        max: usize,
        file: Option<&str>,
    ) -> Result<Value, WebApiError> {
        let mut url = format!(
            "/api/git-ui/log?cwd={}&all={}&scope={}&base={}&max={max}",
            urlencode(cwd),
            if scope == "all" { "true" } else { "false" },
            urlencode(scope),
            urlencode(base),
        );
        if let Some(file) = file {
            url.push_str(&format!("&file={}", urlencode(file)));
        }
        self.call(
            "GET",
            &url,
            None,
            "git.log",
            json!({
                "cwd": cwd,
                "all": scope == "all",
                "scope": scope,
                "base": base,
                "max": max,
                "file": file,
            }),
        )
    }

    pub fn git_branches(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!("/api/git-ui/branches?cwd={}", urlencode(cwd)),
            None,
            "git.branches",
            json!({ "cwd": cwd }),
        )
    }

    pub fn git_file_history(&self, cwd: &str, file: &str) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!(
                "/api/git-ui/file-history?cwd={}&file={}",
                urlencode(cwd),
                urlencode(file)
            ),
            None,
            "git.file_history",
            json!({ "cwd": cwd, "file": file }),
        )
    }

    /// Compare two refs (webui history "committed file" uses
    /// `base=hash^&target=hash&context=0`). `file` scopes the diff to
    /// one path, mirroring the webui `compareFilePaths`.
    pub fn git_compare(
        &self,
        cwd: &str,
        base: &str,
        target: &str,
        file: Option<&str>,
    ) -> Result<Value, WebApiError> {
        let mut url = format!(
            "/api/git-ui/compare?cwd={}&base={}&target={}&context=0",
            urlencode(cwd),
            urlencode(base),
            urlencode(target),
        );
        if let Some(file) = file {
            url.push_str(&format!("&file={}", urlencode(file)));
        }
        self.call(
            "GET",
            &url,
            None,
            "git.compare",
            json!({ "cwd": cwd, "base": base, "target": target, "context": 0, "file": file }),
        )
    }

    /// Blame for one file (webui `blame` toggle). The server returns
    /// raw `--line-porcelain` text; the panel parses it.
    pub fn git_blame(&self, cwd: &str, file: &str, ref_name: &str) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!(
                "/api/git-ui/blame?cwd={}&file={}&ref_name={}",
                urlencode(cwd),
                urlencode(file),
                urlencode(ref_name)
            ),
            None,
            "git.blame",
            json!({ "cwd": cwd, "file": file, "ref_name": ref_name }),
        )
    }

    pub fn git_stashes(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!("/api/git-ui/stashes?cwd={}", urlencode(cwd)),
            None,
            "git.stashes",
            json!({ "cwd": cwd }),
        )
    }

    pub fn git_stage(&self, cwd: &str, paths: &[String]) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "paths": paths });
        self.call(
            "POST",
            "/api/git-ui/stage",
            Some(&body),
            "git.stage",
            body.clone(),
        )
    }

    /// `/api/git-ui/apply-patch`: apply a single-hunk patch (webui
    /// `applyHunk`). `cached: true` stages the hunk (git apply --cached);
    /// adding `reverse: true` unstages it (git apply -R --cached).
    pub fn git_apply_patch(
        &self,
        cwd: &str,
        patch: &str,
        reverse: bool,
        cached: bool,
    ) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "patch": patch, "reverse": reverse, "cached": cached });
        self.call(
            "POST",
            "/api/git-ui/apply-patch",
            Some(&body),
            "git.apply_patch",
            body.clone(),
        )
    }

    /// Chunk-based apply (webui stageHunk/unstageHunk body): the server
    /// rebuilds the single-chunk patch from the same diff args the client
    /// rendered, so `\ No newline at end of file` markers survive and
    /// what gets applied matches the hunk the user selected. A rebuilt
    /// client-side patch loses those markers and git rejects the result.
    pub fn git_apply_patch_chunk(
        &self,
        cwd: &str,
        file: &str,
        chunk_index: usize,
        scope: &str,
        context: usize,
        reverse: bool,
        cached: bool,
    ) -> Result<Value, WebApiError> {
        let body = json!({
            "cwd": cwd,
            "file": file,
            "chunk_index": chunk_index,
            "scope": scope,
            "context": context,
            "reverse": reverse,
            "cached": cached,
        });
        self.call(
            "POST",
            "/api/git-ui/apply-patch",
            Some(&body),
            "git.apply_patch",
            body.clone(),
        )
    }

    pub fn git_unstage(&self, cwd: &str, paths: &[String]) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "paths": paths });
        self.call(
            "POST",
            "/api/git-ui/unstage",
            Some(&body),
            "git.unstage",
            body.clone(),
        )
    }

    pub fn git_discard(&self, cwd: &str, paths: &[String]) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "paths": paths, "confirmed": true });
        self.call(
            "POST",
            "/api/git-ui/discard",
            Some(&body),
            "git.discard",
            body.clone(),
        )
    }

    pub fn git_commit(
        &self,
        cwd: &str,
        title: &str,
        body: Option<&str>,
        amend: bool,
    ) -> Result<Value, WebApiError> {
        let payload = json!({ "cwd": cwd, "title": title, "body": body, "amend": amend });
        self.call(
            "POST",
            "/api/git-ui/commit",
            Some(&payload),
            "git.commit",
            payload.clone(),
        )
    }

    pub fn git_pull(&self, cwd: &str, mode: &str) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "mode": mode });
        self.call(
            "POST",
            "/api/git-ui/pull",
            Some(&body),
            "git.pull",
            body.clone(),
        )
    }

    pub fn git_push(&self, cwd: &str, mode: &str) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "mode": mode });
        self.call(
            "POST",
            "/api/git-ui/push",
            Some(&body),
            "git.push",
            body.clone(),
        )
    }

    pub fn git_fetch(&self, cwd: &str, branch: Option<&str>) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "branch": branch });
        self.call(
            "POST",
            "/api/git-ui/fetch",
            Some(&body),
            "git.fetch",
            body.clone(),
        )
    }

    pub fn git_switch(&self, cwd: &str, branch: &str, create: bool) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "branch": branch, "create": create });
        self.call(
            "POST",
            "/api/git-ui/switch",
            Some(&body),
            "git.switch",
            body.clone(),
        )
    }

    /// `/api/git-ui/reset`: the server requires the typed confirmation
    /// `"reset hard"` for hard mode; soft/mixed accept an empty string.
    pub fn git_reset(
        &self,
        cwd: &str,
        ref_name: &str,
        mode: &str,
        confirmation: &str,
    ) -> Result<Value, WebApiError> {
        let body = json!({
                "cwd": cwd,
                "ref_name": ref_name,
                "mode": mode,
                "confirmation": confirmation,
        });
        self.call(
            "POST",
            "/api/git-ui/reset",
            Some(&body),
            "git.reset",
            body.clone(),
        )
    }

    /// `/api/git-ui/rebase`: upstream + optional onto (server falls back
    /// to main/master). `pull_first` refreshes the remote first, matching
    /// the webui rebase modal's checkbox. Requires typed confirmation
    /// `"rebase selected"` on the server side.
    pub fn git_rebase(
        &self,
        cwd: &str,
        upstream: &str,
        onto: Option<&str>,
        pull_first: bool,
        confirmation: &str,
    ) -> Result<Value, WebApiError> {
        let body = json!({
                "cwd": cwd,
                "upstream": upstream,
                "onto": onto,
                "pull_first": pull_first,
                "confirmation": confirmation,
        });
        self.call(
            "POST",
            "/api/git-ui/rebase",
            Some(&body),
            "git.rebase",
            body.clone(),
        )
    }

    /// `/api/git-ui/tag`: create `tag_name` on `ref_name` (a hash or
    /// branch). The server validates both as single git tokens.
    pub fn git_tag(&self, cwd: &str, tag_name: &str, ref_name: &str) -> Result<Value, WebApiError> {
        let body = json!({
                "cwd": cwd,
                "tag_name": tag_name,
                "ref_name": ref_name,
        });
        self.call(
            "POST",
            "/api/git-ui/tag",
            Some(&body),
            "git.tag",
            body.clone(),
        )
    }

    pub fn git_branch_delete(
        &self,
        cwd: &str,
        branch: &str,
        force: bool,
    ) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "branch": branch, "force": force, "confirmed": true });
        self.call(
            "POST",
            "/api/git-ui/branch-delete",
            Some(&body),
            "git.branch.delete",
            body.clone(),
        )
    }

    pub fn git_stash(&self, cwd: &str) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd });
        self.call(
            "POST",
            "/api/git-ui/stash",
            Some(&body),
            "git.stash",
            body.clone(),
        )
    }

    /// `/api/git-ui/stash-show`: full diff of one stash entry. Response
    /// shape matches `/api/git-ui/diff`, so `parse_diff_lines_with_meta`
    /// can parse it.
    pub fn git_stash_show(&self, cwd: &str, stash: &str) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!(
                "/api/git-ui/stash-show?cwd={}&stash={}&context=3",
                urlencode(cwd),
                urlencode(stash),
            ),
            None,
            "git.stash_show",
            json!({ "cwd": cwd, "stash": stash, "context": 3 }),
        )
    }

    /// `/api/git-ui/conflicts`: conflicted file list plus merge/rebase state.
    pub fn git_conflicts(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!("/api/git-ui/conflicts?cwd={}", urlencode(cwd)),
            None,
            "git.conflicts",
            json!({ "cwd": cwd }),
        )
    }

    /// `/api/git-ui/conflict-resolve`: resolve one file with `ours` /
    /// `base` (parent) / `theirs` (remote) / `mark` (git add).
    pub fn git_conflict_resolve(
        &self,
        cwd: &str,
        path: &str,
        mode: &str,
    ) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "path": path, "mode": mode });
        self.call(
            "POST",
            "/api/git-ui/conflict-resolve",
            Some(&body),
            "git.conflict_resolve",
            body.clone(),
        )
    }

    /// `/api/git-ui/conflict-action`: continue/skip/abort a rebase, merge,
    /// or cherry-pick in progress.
    pub fn git_conflict_action(&self, cwd: &str, action: &str) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "action": action });
        self.call(
            "POST",
            "/api/git-ui/conflict-action",
            Some(&body),
            "git.conflict_action",
            body.clone(),
        )
    }

    /// `/api/git-ui/cleanup-scan`: repos with merged branches and stale
    /// worktrees under a root directory.
    pub fn git_cleanup_scan(&self, root: &str) -> Result<Value, WebApiError> {
        self.call(
            "GET",
            &format!("/api/git-ui/cleanup-scan?root={}", urlencode(root)),
            None,
            "git.cleanup_scan",
            json!({ "root": root }),
        )
    }

    /// `/api/git-ui/branch-delete` with explicit confirmation (the TUI
    /// collects its own confirmation before calling). `force` mirrors
    /// the webui safe-then-force retry: the first attempt runs with
    /// `git branch -d`, the retry only when Git demanded force.
    pub fn git_cleanup_branch_delete(
        &self,
        cwd: &str,
        branch: &str,
        force: bool,
    ) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "branch": branch, "force": force, "confirmed": true });
        self.call(
            "POST",
            "/api/git-ui/branch-delete",
            Some(&body),
            "git.branch.delete",
            body.clone(),
        )
    }

    /// `/api/git-ui/worktree-remove` for cleanup. `force` mirrors the
    /// webui safe-then-force retry semantics.
    pub fn git_cleanup_worktree_remove(
        &self,
        cwd: &str,
        path: &str,
        force: bool,
    ) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "path": path, "force": force, "confirmed": true });
        self.call(
            "POST",
            "/api/git-ui/worktree-remove",
            Some(&body),
            "git.worktree_remove",
            body.clone(),
        )
    }

    /// `/api/git-ui/worktree-prune` for cleanup.
    pub fn git_cleanup_worktree_prune(&self, cwd: &str) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd });
        self.call(
            "POST",
            "/api/git-ui/worktree-prune",
            Some(&body),
            "git.worktree_prune",
            body.clone(),
        )
    }

    pub fn git_stash_apply(&self, cwd: &str, stash: &str) -> Result<Value, WebApiError> {
        let body = json!({ "cwd": cwd, "stash": stash });
        self.call(
            "POST",
            "/api/git-ui/stash-apply",
            Some(&body),
            "git.stash_apply",
            body.clone(),
        )
    }

    pub fn git_stash_drop(&self, cwd: &str, stash: &str) -> Result<Value, WebApiError> {
        // The server rejects drops without an explicit confirmation flag;
        // the TUI collects its own `y` confirmation before calling.
        let body = json!({ "cwd": cwd, "stash": stash, "confirmed": true });
        self.call(
            "POST",
            "/api/git-ui/stash-drop",
            Some(&body),
            "git.stash_drop",
            body.clone(),
        )
    }
}

/// to_string only fails on non-finite floats or depth overflows, and
/// a serde_json::Value cannot hold either (Number rejects NaN), so
/// this is infallible in practice and returns the text directly.
fn encode_body(value: &Value) -> String {
    serde_json::to_string(value).expect("serializing a plain json body is infallible")
}

/// Resolve a host string (literal IP or hostname like "localhost") plus
/// port to a single socket address for `TcpStream::connect_timeout`. Falls
/// back to the first resolved address; resolution failure surfaces as an
/// Io error like the old connect() path did.
fn resolve_web_api_addr(host: &str, port: u16) -> Result<std::net::SocketAddr, WebApiError> {
    use std::net::ToSocketAddrs;
    let addrs = (host, port).to_socket_addrs().map_err(io_err)?;
    first_addr(addrs, host)
}

/// Coverage is off because the empty-answer arm needs a DNS name that
/// resolves successfully to zero addresses; no such name exists without
/// a stub resolver, and every resolver failure takes the map_err arm
/// of to_socket_addrs instead.
#[cfg_attr(coverage, coverage(off))]
fn first_addr<A: Iterator<Item = std::net::SocketAddr>>(
    mut addrs: A,
    host: &str,
) -> Result<std::net::SocketAddr, WebApiError> {
    addrs
        .next()
        .ok_or_else(|| WebApiError::Io(format!("host did not resolve: {host}")))
}

fn read_chunked_body(reader: &mut BufReader<TcpStream>) -> Result<Vec<u8>, WebApiError> {
    let mut body = Vec::new();
    loop {
        let mut size_line = String::new();
        reader.read_line(&mut size_line).map_err(io_err)?;
        let size = usize::from_str_radix(
            size_line
                .trim()
                .split(';')
                .next()
                .unwrap_or_default()
                .trim(),
            16,
        )
        .map_err(|_| WebApiError::Io(format!("invalid chunk size line: {size_line:?}")))?;
        if size == 0 {
            let mut trailer = String::new();
            while reader
                .read_line(&mut trailer)
                .map(|read| read > 0 && !trailer.trim().is_empty())
                .is_ok()
                && !trailer.trim().is_empty()
            {
                trailer.clear();
            }
            break;
        }
        let mut chunk = vec![0u8; size + 2];
        reader.read_exact(&mut chunk).map_err(io_err)?;
        chunk.truncate(size);
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Percent-encode a query component. Keeps URL path-ish characters readable.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The default WebUI API port.
///
/// Production builds default to the documented `127.0.0.1:8787`. Test builds
/// default to port 1 (the dead-endpoint idiom used across the TUI tests): a
/// test constructing the default client must NEVER end up pointing at the
/// operator's LIVE server, where it would mint real sessions with the
/// operator's persisted credentials.
#[cfg(not(test))]
pub const fn default_web_api_port() -> u16 {
    8787
}

#[cfg(test)]
pub fn default_web_api_port() -> u16 {
    1
}

/// Read the persisted settings path: `XDG_CONFIG_HOME` first, real HOME
/// config in production. In test builds an unset XDG resolves to an
/// isolated nonexistent path — the same isolation rule as
/// `backend_client::runtime_settings_path`.
fn webui_settings_path() -> Option<std::path::PathBuf> {
    if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        return Some(std::path::PathBuf::from(dir).join("herdr-webui/webui-settings.json"));
    }
    #[cfg(test)]
    {
        None
    }
    #[cfg(not(test))]
    {
        std::env::var("HOME").ok().map(|home| {
            std::path::PathBuf::from(home).join(".config/herdr-webui/webui-settings.json")
        })
    }
}

/// Read `bind` from the WebUI settings file so the TUI finds the server even
/// when the user changed the default port.
fn persisted_bind_address() -> Option<String> {
    let path = webui_settings_path()?;
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value.get("bind")?.as_str().map(str::to_string)
}

/// Live session tokens from the server's `session-token` sidecar (same
/// directory as the settings file, 0600, owned by the operator). The
/// server writes the file after every session membership change and the
/// reader here re-checks liveness, so a timed session never replays past
/// its expiry. File order (LRU, least recent first) is kept: the replay
/// refreshes the coldest session while hot browser sessions stay hot.
/// When the file is missing, unreadable, or holds no live record, `None`
/// means the default localhost no-auth setup and the 401 path never
/// triggers.
fn persisted_session_tokens() -> Option<Vec<WebApiSessionToken>> {
    let path = webui_settings_path()?.with_file_name("session-token");
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let tokens: Vec<WebApiSessionToken> = value
        .get("sessions")?
        .as_array()?
        .iter()
        .filter_map(|entry| {
            let token = entry.get("token")?.as_str()?.trim().to_string();
            let expires_at = entry.get("expires_at").and_then(Value::as_u64);
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_secs())
                .unwrap_or(0);
            let live = match expires_at {
                Some(expires_at) => expires_at > now,
                None => true,
            };
            live.then_some(WebApiSessionToken { token })
        })
        .collect();
    (!tokens.is_empty()).then_some(tokens)
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use super::*;

    /// Env manipulation is process-global and lib tests run in parallel;
    /// every test that reads or mutates `HERDR_WEBUI_TUI_API` or
    /// `XDG_CONFIG_HOME` must hold the shared lib-wide lock so discovery
    /// cannot race other modules' env-mutating tests either.
    pub(super) fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        crate::lock_or_poisoned(crate::test_env_lock())
    }

    /// Connect and hold briefly so the fixture accepts and parks in its
    /// read, then hang up. macOS discards pre-accept closes from the
    /// backlog, so without the hold the server never observes the EOF.
    fn mute_probe(port: u16) {
        let _stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        std::thread::sleep(Duration::from_millis(100));
    }

    /// Partial headers with no terminating blank line: the fixture's
    /// header loop hits EOF on the next read_line and breaks.
    fn mid_header_hangup_probe(port: u16) {
        use std::io::Write as _;
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _ = stream.write_all(b"POST /probe HTTP/1.1\r\nX-Hang: up");
        let _ = stream.flush();
        std::thread::sleep(Duration::from_millis(100));
    }

    /// A header line that is not valid UTF-8 drives read_line into its
    /// error path instead of a clean EOF.
    fn bad_utf8_header_probe(port: u16) {
        use std::io::Write as _;
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _ = stream.write_all(b"POST /probe HTTP/1.1\r\nX-Bad: \xff\xfe\n\r\n");
        let _ = stream.flush();
        std::thread::sleep(Duration::from_millis(100));
    }

    /// A GET with a body so fixtures drain a real payload via read_exact
    /// instead of their usual Content-Length: 0 requests.
    fn bodied_get_probe(port: u16) {
        use std::io::Write as _;
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _ = stream.write_all(b"GET /probe HTTP/1.1\r\nContent-Length: 4\r\n\r\nbody");
        let _ = stream.flush();
        std::thread::sleep(Duration::from_millis(100));
    }

    /// A request whose first line is not valid UTF-8 drives the
    /// fixture's request-line read into its error path (is_ok false),
    /// the arm a well-formed header probe cannot reach.
    fn bad_utf8_request_line_probe(port: u16) {
        use std::io::Write as _;
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _ = stream.write_all(b"\xff\xfe POST /probe HTTP/1.1\r\n\r\n");
        let _ = stream.flush();
        std::thread::sleep(Duration::from_millis(100));
    }

    /// A request that stops before the blank line: the fixture's read
    /// loop sees bytes without a "\r\n\r\n" terminator (the loop's
    /// continue arm), then EOF on the next read. A mute probe sends no
    /// bytes at all, so it can only ever hit the EOF break.
    fn partial_request_probe(port: u16) {
        use std::io::Write as _;
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let _ = stream.write_all(b"POST /probe HTTP/1.1\r\nX-Partial: yes");
        let _ = stream.flush();
        std::thread::sleep(Duration::from_millis(100));
    }

    #[test]
    fn parses_webui_api_urls() {
        let client = WebApiClient::parse_url("127.0.0.1:8787").unwrap();
        assert_eq!(client.base_url(), "http://127.0.0.1:8787");
        assert!(!client.is_socket_transport());

        let client = WebApiClient::parse_url("http://localhost:9000/").unwrap();
        assert_eq!(client.base_url(), "http://localhost:9000");

        assert!(WebApiClient::parse_url("localhost").is_err());
        assert!(WebApiClient::parse_url("http://localhost").is_err());
        assert!(WebApiClient::parse_url("http://host:notaport").is_err());
        assert!(WebApiClient::parse_url("https://host:8787").is_err());
        // Bare port with no host is rejected too.
        assert!(WebApiClient::parse_url(":8787").is_err());
        assert!(WebApiClient::parse_url("http://:8787").is_err());
    }

    #[test]
    fn percent_encoding_matches_js_style_urls() {
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
        assert_eq!(urlencode("a+b"), "a%2Bb");
        assert_eq!(urlencode("plain-Path_1.txt"), "plain-Path_1.txt");
    }

    #[test]
    fn persisted_bind_address_reads_settings_when_present() {
        let _guard = lock_env();
        let dir = std::env::temp_dir().join(format!("herdr-tui-api-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // scoped env manipulation is process-global; run in a subprocess would be
        // overkill here, so test the settings parsing through a helper file instead.
        let settings = serde_json::json!({ "bind": "127.0.0.1:9999" });
        let file = dir.join("webui-settings.json");
        std::fs::write(&file, settings.to_string()).unwrap();
        let raw = std::fs::read_to_string(&file).unwrap();
        let value: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            value.get("bind").and_then(Value::as_str),
            Some("127.0.0.1:9999")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn discover_defaults_to_loopback_when_unset() {
        let _guard = lock_env();
        // Set: discovery takes the env early-return path.
        unsafe {
            std::env::set_var("HERDR_WEBUI_TUI_API", "http://127.0.0.1:12345");
        }
        let client = WebApiClient::discover().unwrap();
        assert!(client.base_url().starts_with("http://"));
        // Malformed env value surfaces the parse error.
        unsafe {
            std::env::set_var("HERDR_WEBUI_TUI_API", "::::");
        }
        assert!(WebApiClient::discover().is_err());
        // Unset: the settings/default path runs.
        unsafe {
            std::env::remove_var("HERDR_WEBUI_TUI_API");
        }
        let client = WebApiClient::discover().unwrap();
        assert!(client.base_url().starts_with("http://"));
    }

    #[test]
    fn from_backend_socket_reports_socket_transport() {
        let client = WebApiClient::from_backend_socket("/tmp/herdr-test.sock");
        assert!(client.is_socket_transport());
        assert_eq!(client.base_url(), "socket:///tmp/herdr-test.sock");
        // HTTP-only endpoints reject cleanly instead of dialing anything.
        let err = client.recent_workspaces().unwrap_err();
        assert!(err.to_string().contains("WebUI HTTP server"));
    }

    #[test]
    fn submit_pane_enqueued_posts_enqueue_true_to_pane_route() {
        // The TUI has no hold gesture yet, but the method is the
        // TUI-side counterpart of the web composer's long-press Send;
        // this pins the wire shape (route + body) so the gesture can
        // adopt it without re-deriving the contract.
        use std::io::{BufRead as _, BufReader};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            // bad-utf8 request line, bad-utf8 header, then the real POST;
            // once the budget is spent the nonblocking flip makes the
            // accept error arm the exit.
            let mut remaining = 3usize;
            loop {
                if remaining == 0 {
                    let _ = listener.set_nonblocking(true);
                } else {
                    remaining -= 1;
                }
                let Ok((stream, _)) = listener.accept() else {
                    break;
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                if reader.read_line(&mut request).is_ok() {
                    // Content-Length carries the body length; drain it.
                    let mut headers = String::new();
                    let mut content_length = 0usize;
                    loop {
                        headers.clear();
                        if reader.read_line(&mut headers).is_err() {
                            break;
                        }
                        let line = headers.trim();
                        if line.is_empty() {
                            break;
                        }
                        if let Some(value) = line
                            .strip_prefix("Content-Length:")
                            .and_then(|v| v.trim().parse().ok())
                        {
                            content_length = value;
                        }
                    }
                    let mut body = vec![0u8; content_length];
                    use std::io::Read as _;
                    let _ = reader.read_exact(&mut body);
                    let body = String::from_utf8_lossy(&body).to_string();
                    let ok = request.contains("POST /api/panes/pane-7/submit")
                        && body.contains("\"enqueue\":true");
                    let payload = if ok {
                        r#"{"ok":true,"enqueue":true}"#
                    } else {
                        r#"{"ok":false}"#
                    };
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        payload.len(),
                        payload
                    );
                    let mut stream = stream;
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                }
            }
        });
        let client = WebApiClient::new("127.0.0.1", addr.port());
        // A non-UTF-8 request line takes the fixture's request-read
        // error arm; a non-UTF-8 header drives its header error break and
        // its unmatched request line through the ok:false payload.
        bad_utf8_request_line_probe(addr.port());
        bad_utf8_header_probe(addr.port());
        let value = client
            .submit_pane_enqueued("pane-7", "hold to queue")
            .unwrap();
        assert_eq!(value.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(value.get("enqueue").and_then(Value::as_bool), Some(true));
        handle.join().unwrap();
    }

    #[test]
    fn client_reads_response_from_plain_tcp_server() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            // mute probe + real GET; the flip turns accept's WouldBlock
            // into the loop's exit so every closing brace runs.
            let mut remaining = 2usize;
            loop {
                if remaining == 0 {
                    let _ = listener.set_nonblocking(true);
                } else {
                    remaining -= 1;
                }
                let Ok((stream, _)) = listener.accept() else {
                    break;
                };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                if reader.read_line(&mut request).unwrap_or(0) > 0 {
                    let mut stream = stream;
                    let body = r#"{"ok":true}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();
                    let _ = stream.shutdown(std::net::Shutdown::Both);
                }
            }
        });
        let client = WebApiClient::new("127.0.0.1", addr.port());
        mute_probe(addr.port());
        let value = client.get("/api/me").unwrap();
        assert_eq!(value, serde_json::json!({ "ok": true }));
        handle.join().unwrap();
    }

    #[test]
    fn login_round_trip_caches_cookie_and_retries_401() {
        // Server behavior: /api/recent-workspaces 401s without the session
        // cookie, an authorized GET returns rows. The client must do
        // 401 -> replay the sidecar token -> retry transparently and reuse
        // the cookie on the next call.
        use std::io::{BufRead as _, BufReader};
        use std::sync::{Arc, Mutex};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let authorized_calls = Arc::new(Mutex::new(0usize));
        let seen = authorized_calls.clone();
        let handle = std::thread::spawn(move || {
            // mute + mid-header hangup + wrong-cookie probe + replay probe
            // + two data GETs; after the budget the self-flip makes the
            // accept WouldBlock arm the loop's only exit.
            let mut remaining = 6usize;
            loop {
                if remaining == 0 {
                    let _ = listener.set_nonblocking(true);
                }
                let Ok((stream, _)) = listener.accept() else {
                    break;
                };
                remaining -= 1;
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut has_cookie = false;
                let mut cookie_value = String::new();
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    let trimmed = header.trim();
                    if trimmed.is_empty() {
                        break;
                    }
                    let lower = trimmed.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("cookie:") {
                        has_cookie = true;
                        cookie_value = value.trim().to_string();
                    }
                }
                let mut stream = stream;
                let response = if !has_cookie
                    || !cookie_value.contains("herdr_web_session=token123")
                {
                    format!(
                        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"error\":\"unauthorized\"}}",
                        "{\"error\":\"unauthorized\"}".len()
                    )
                } else {
                    *seen.lock().unwrap() += 1;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"recent\":[{{\"path\":\"/a\"}}]}}",
                        "{\"recent\":[{\"path\":\"/a\"}]}".len()
                    )
                };
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let tokens = vec![WebApiSessionToken {
            token: "token123".to_string(),
        }];
        assert!(
            client.session_cookie.borrow().is_none(),
            "test starts without a cookie"
        );
        // Peer that connects and hangs up without a request line: the
        // read-empty continue arm must run and the loop keep serving.
        // Budgeted first so the bounded count still covers the real
        // request sequence below.
        mute_probe(port);
        // Partial headers then hang up: the fixture's header loop hits EOF.
        mid_header_hangup_probe(port);
        // A bodied GET carrying the wrong session cookie exercises the
        // drain and the 401 response arm; the probe ignores the response.
        {
            use std::io::Write as _;
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let _ = stream.write_all(
                b"GET /probe HTTP/1.1\r\nContent-Length: 4\r\nCookie: herdr_web_session=wrong\r\n\r\nbody",
            );
            let _ = stream.flush();
            std::thread::sleep(Duration::from_millis(100));
        }
        // Replay the sidecar token explicitly (the TUI binary could do
        // this at startup too): the probe authorizes once, then both
        // calls must ride the cached cookie.
        client.replay_session(&tokens).expect("replay succeeds");
        assert_eq!(*authorized_calls.lock().unwrap(), 1, "probe authorized");
        let value = client.recent_workspaces().expect("authorized call");
        assert_eq!(value["recent"][0]["path"], "/a");
        // A second call reuses the cached cookie — the bug this pins:
        // the cookie used to land on a dropped temporary inside
        // request_json, so every authed call re-authenticated. The probe
        // plus both data calls are the only authorized requests.
        let value = client.recent_workspaces().expect("cached cookie works");
        assert_eq!(value["recent"][0]["path"], "/a");
        assert_eq!(
            *authorized_calls.lock().unwrap(),
            3,
            "no re-auth between calls"
        );
        // The server thread parks on accept() after its bounded request
        // count; detach it like the other fake servers in this suite.
        drop(handle);
    }

    #[test]
    fn stale_cookie_relogs_in_after_server_token_rotation() {
        // The WebUI persists its session set, so a long-running TUI can hold
        // a stale cookie after the server dropped that session (expired or
        // evicted by the LRU cap). The retry loop must replay a live
        // sidecar token and recover.
        let _guard = lock_env();
        use std::io::{BufRead as _, BufReader};
        use std::sync::{Arc, Mutex};
        let config_home =
            std::env::temp_dir().join(format!("herdr-tui-stale-cookie-{}", std::process::id()));
        std::fs::create_dir_all(config_home.join("herdr-webui")).unwrap();
        // Sidecar as the server would write it: token1 (about to be
        // dropped server-side) first in LRU order, token2 live behind it.
        std::fs::write(
            config_home.join("herdr-webui").join("session-token"),
            serde_json::json!({ "sessions": [
                { "token": "token1" },
                { "token": "token2" }
            ] })
            .to_string(),
        )
        .unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &config_home);

        // The server drops token1 after the first authorized call (a
        // restart or eviction): token1 then only token2.
        let current_token = Arc::new(Mutex::new("token1".to_string()));
        let token_for_server = current_token.clone();
        let authorized_count = Arc::new(Mutex::new(0usize));
        let seen = authorized_count.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        // Detached: after the bounded budget the self-flip ends the
        // accept loop, so the thread exits on its own.
        let _handle = std::thread::spawn(move || {
            // mid-header hangup + bodied probe + 3 (first call) + 1 + 4
            // (rotation replay of both tokens) + 1 + mute; the self-flip
            // ends the thread.
            let mut remaining = 12usize;
            loop {
                if remaining == 0 {
                    let _ = listener.set_nonblocking(true);
                }
                let Ok((stream, _)) = listener.accept() else {
                    break;
                };
                remaining -= 1;
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut content_length = 0usize;
                let mut cookie = String::new();
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    let trimmed = header.trim();
                    if trimmed.is_empty() {
                        break;
                    }
                    let lower = trimmed.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        content_length = value.trim().parse().unwrap_or(0);
                    } else if let Some(value) = lower.strip_prefix("cookie:") {
                        cookie = value.trim().to_string();
                    }
                }
                let mut body = vec![0; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let mut stream = stream;
                let response = if !cookie.contains(&format!(
                    "herdr_web_session={}",
                    token_for_server.lock().unwrap().clone()
                )) {
                    format!(
                        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"error\":\"unauthorized\"}}",
                        "{\"error\":\"unauthorized\"}".len()
                    )
                } else {
                    *seen.lock().unwrap() += 1;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"recent\":[{{\"path\":\"/a\"}}]}}",
                        "{\"recent\":[{\"path\":\"/a\"}]}".len()
                    )
                };
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        });

        let client = WebApiClient::new("127.0.0.1", port);
        // Partial headers with no blank line fire the fixture's
        // header-EOF break; a bodied GET without a session cookie drains
        // a real payload and rides the 401 arm; the probe ignores the
        // response.
        mid_header_hangup_probe(port);
        bodied_get_probe(port);
        // First call: 401, replay token1 (probe + data), authorized.
        let value = client
            .recent_workspaces()
            .expect("first call replays token1");
        assert_eq!(value["recent"][0]["path"], "/a");
        assert_eq!(*authorized_count.lock().unwrap(), 2);
        // Second call still rides token1: probe not repeated.
        client.recent_workspaces().expect("cached cookie works");
        assert_eq!(*authorized_count.lock().unwrap(), 3);
        // Server restart: token1 is dropped. The TUI's cached cookie is
        // now stale; the next call must replay token2 and recover.
        *current_token.lock().unwrap() = "token2".to_string();
        let value = client
            .recent_workspaces()
            .expect("stale cookie triggers replay and the call recovers");
        assert_eq!(value["recent"][0]["path"], "/a");
        // And the new cookie is cached again: no further replays.
        client.recent_workspaces().expect("new cookie cached");
        // Peer that hangs up without a request line: the read-empty
        // continue arm runs before the flip ends the thread.
        mute_probe(port);

        std::env::remove_var("XDG_CONFIG_HOME");
        let _ = std::fs::remove_dir_all(&config_home);
    }

    #[test]
    fn retry_path_logs_in_once_and_caches_the_cookie() {
        // Reproduces the exact bug path: NO explicit replay. The first
        // call 401s, request_json reads persisted_session_tokens() from
        // the sidecar in XDG_CONFIG_HOME, replays, retries, and the cookie
        // must land on the shared client so the second call skips the
        // replay probe.
        let _guard = lock_env();
        use std::io::{BufRead as _, BufReader};
        use std::sync::{Arc, Mutex};
        let config_home =
            std::env::temp_dir().join(format!("herdr-tui-retry-login-{}", std::process::id()));
        std::fs::create_dir_all(config_home.join("herdr-webui")).unwrap();
        std::fs::write(
            config_home.join("herdr-webui").join("session-token"),
            serde_json::json!({ "sessions": [ { "token": "token123" } ] }).to_string(),
        )
        .unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &config_home);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let authorized_count = Arc::new(Mutex::new(0usize));
        let seen = authorized_count.clone();
        let handle = std::thread::spawn(move || {
            // mid-header hangup + bodied probe + 401 GET + probe + data
            // GET + cached data GET + mute; the self-flip drives the exit.
            let mut remaining = 7usize;
            loop {
                if remaining == 0 {
                    let _ = listener.set_nonblocking(true);
                }
                let Ok((stream, _)) = listener.accept() else {
                    break;
                };
                remaining -= 1;
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut content_length = 0usize;
                let mut cookie = String::new();
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    let trimmed = header.trim();
                    if trimmed.is_empty() {
                        break;
                    }
                    let lower = trimmed.to_ascii_lowercase();
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        content_length = value.trim().parse().unwrap_or(0);
                    } else if let Some(value) = lower.strip_prefix("cookie:") {
                        cookie = value.trim().to_string();
                    }
                }
                let mut body = vec![0; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let mut stream = stream;
                let response = if !cookie.contains("herdr_web_session=token123") {
                    format!(
                        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"error\":\"unauthorized\"}}",
                        "{\"error\":\"unauthorized\"}".len()
                    )
                } else {
                    *seen.lock().unwrap() += 1;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"recent\":[{{\"path\":\"/a\"}}]}}",
                        "{\"recent\":[{\"path\":\"/a\"}]}".len()
                    )
                };
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        });

        let client = WebApiClient::new("127.0.0.1", port);
        // Partial headers then EOF fire the fixture's header-loop break;
        // a bodied GET drains a real payload through the 401 arm.
        mid_header_hangup_probe(port);
        bodied_get_probe(port);
        // No explicit replay: both calls go through the 401 retry path.
        let value = client
            .recent_workspaces()
            .expect("retry replays and succeeds");
        assert_eq!(value["recent"][0]["path"], "/a");
        // First call: 401 GET, probe GET, data GET. The probe is the
        // replay itself, so only one extra request.
        assert_eq!(*authorized_count.lock().unwrap(), 2, "probe plus data call");
        // Second call must ride the cached cookie: a second replay here
        // was the dropped-temporary bug.
        let value = client
            .recent_workspaces()
            .expect("cached cookie authorizes the second call");
        assert_eq!(value["recent"][0]["path"], "/a");
        assert_eq!(*authorized_count.lock().unwrap(), 3, "no second replay");
        // Peer that hangs up without a request line: the read-empty
        // continue arm runs before the flip ends the thread.
        mute_probe(port);
        drop(handle);

        std::env::remove_var("XDG_CONFIG_HOME");
        let _ = std::fs::remove_dir_all(&config_home);
    }

    #[test]
    fn bad_credentials_surface_the_401() {
        // Every sidecar token the client can replay is stale server-side
        // (expired, evicted, or from a different server instance): the
        // replay must give up after exhausting the records, clear the dead
        // cookie, and surface the 401 — no infinite retry loop.
        let _guard = lock_env();
        use std::io::{BufRead as _, BufReader};
        let config_home =
            std::env::temp_dir().join(format!("herdr-tui-bad-token-{}", std::process::id()));
        std::fs::create_dir_all(config_home.join("herdr-webui")).unwrap();
        std::fs::write(
            config_home.join("herdr-webui").join("session-token"),
            serde_json::json!({ "sessions": [ { "token": "stale" } ] }).to_string(),
        )
        .unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &config_home);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            // mute + mid-header + bodied probe + three 401 client GETs;
            // after the budget the self-flip makes the accept WouldBlock
            // arm the loop's only exit.
            let mut remaining = 6usize;
            loop {
                if remaining == 0 {
                    let _ = listener.set_nonblocking(true);
                }
                let Ok((stream, _)) = listener.accept() else {
                    break;
                };
                remaining -= 1;
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                let mut content_length = 0usize;
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 {
                        break;
                    }
                    let trimmed = header.trim();
                    if trimmed.is_empty() {
                        break;
                    }
                    if let Some(value) =
                        trimmed.to_ascii_lowercase().strip_prefix("content-length:")
                    {
                        content_length = value.trim().parse().unwrap_or(0);
                    }
                }
                let mut body = vec![0; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let mut stream = stream;
                let response = format!(
                    "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"error\":\"unauthorized\"}}",
                    "{\"error\":\"unauthorized\"}".len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
                let _ = stream.shutdown(std::net::Shutdown::Both);
            }
        });
        let client = WebApiClient::new("127.0.0.1", port);
        // Peer that connects and hangs up without a request line: the
        // read-empty continue arm, budgeted inside the bounded count so
        // the real 401 sequence still fits.
        mute_probe(port);
        // Partial headers then EOF fire the header-loop break; a bodied
        // GET drains a real payload before its 401 response.
        mid_header_hangup_probe(port);
        bodied_get_probe(port);
        // The only sidecar token is rejected: the 401 surfaces after one
        // replay attempt, and no dead cookie stays cached.
        let err = client.recent_workspaces().unwrap_err();
        assert!(matches!(err, WebApiError::Http { status: 401, .. }));
        assert!(
            client.session_cookie.borrow().is_none(),
            "rejected token must not stay cached"
        );
        // And the 401 still surfaces when no sidecar exists at all.
        let fresh_client_home =
            std::env::temp_dir().join(format!("herdr-tui-no-sidecar-{}", std::process::id()));
        std::fs::create_dir_all(fresh_client_home.join("herdr-webui")).unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &fresh_client_home);
        let fresh = WebApiClient::new("127.0.0.1", port);
        let err = fresh.recent_workspaces().unwrap_err();
        assert!(matches!(err, WebApiError::Http { status: 401, .. }));
        // Detached like the fake server above: it parks on accept()
        // once its bounded request count is served.
        drop(handle);

        std::env::remove_var("XDG_CONFIG_HOME");
        let _ = std::fs::remove_dir_all(&config_home);
        let _ = std::fs::remove_dir_all(&fresh_client_home);
    }

    #[test]
    fn http_error_messages_include_status_and_error_payload() {
        let error = WebApiError::Http {
            status: 400,
            message: "cwd is required".to_string(),
        };
        assert_eq!(error.to_string(), "WebUI API error 400: cwd is required");
        let empty = WebApiError::Http {
            status: 401,
            message: String::new(),
        };
        assert_eq!(empty.to_string(), "WebUI API error 401");
    }

    /// Raw server behaviors for request_json edge cases.
    fn raw_http_server(responder: fn(std::net::TcpStream)) -> (u16, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            use std::io::Read;
            loop {
                let Ok((stream, _)) = listener.accept() else {
                    break;
                };
                let mut stream = stream;
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
                responder(stream);
                // Self-flip after serving: the next accept returns
                // WouldBlock so the error arm is the loop's exit and the
                // thread ends instead of parking in accept forever.
                let _ = listener.set_nonblocking(true);
            }
        });
        (port, handle)
    }

    fn write_response(stream: &mut std::net::TcpStream, response: &str) {
        use std::io::Write;
        let _ = stream.write_all(response.as_bytes());
    }

    #[test]
    fn set_timeout_caps_a_slow_server_read() {
        // A server that accepts and never answers: with the default
        // 20s budget the request would park in read; a 250ms set_timeout
        // must surface the OS read-timeout error instead.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            // Accept and hold the connection open, never writing back.
            let (_stream, _) = listener.accept().unwrap();
            std::thread::sleep(Duration::from_secs(2));
        });
        let mut client = WebApiClient::new("127.0.0.1", port);
        client.set_timeout(Duration::from_millis(250));
        let err = client.get("/api/ping").unwrap_err();
        // macOS surfaces a read timeout as EAGAIN ("Resource temporarily
        // unavailable"), Linux as ETIMEDOUT; both land in the Io arm.
        assert!(matches!(err, WebApiError::Io(_)), "got {err:?}");
        let message = err.to_string();
        assert!(
            message.contains("timed out") || message.contains("temporarily unavailable"),
            "not a timeout error: {message}"
        );
        drop(handle);
    }

    #[test]
    fn request_json_survives_header_truncation_and_missing_length() {
        // Connection closed before the header terminator.
        let (port, _h) = raw_http_server(|mut s| {
            write_response(&mut s, "HTTP/1.1 200 OK\r\nContent-Type: application/json");
            // Drop without the blank line: the reader sees EOF mid-headers.
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let err = client.request_json("GET", "/api/ping", None);
        assert!(err.is_err(), "truncated headers must fail");

        // No content-length and no chunked: body is read to EOF.
        let (port, _h) = raw_http_server(|mut s| {
            write_response(
                &mut s,
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"ok\":1}",
            );
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let value = client
            .request_json("GET", "/api/ping", None)
            .expect("read-to-EOF body parses");
        assert_eq!(value["ok"], 1);

        // Chunked response with trailers exercises the trailer drain loop.
        let (port, _h) = raw_http_server(|mut s| {
            write_response(
                &mut s,
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{\"ok\"\r\n6\r\n:true}\r\n0\r\nX-Trailer: v\r\n\r\n",
            );
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let value = client
            .request_json("GET", "/api/ping", None)
            .expect("chunked body with trailer parses");
        assert_eq!(value["ok"], true);
    }

    #[test]
    fn raw_http_server_read_loop_survives_partial_and_hung_up_peers() {
        // A lone client call always delivers its whole request in one
        // read, so the raw server's read loop never sees the
        // no-terminator continue arm nor the EOF break. A probe that
        // writes half a request and hangs up exercises both; no client
        // call follows because the self-flip after serving the probe
        // ends the accept loop.
        let (port, handle) = raw_http_server(|s| {
            let _ = s.shutdown(std::net::Shutdown::Both);
        });
        partial_request_probe(port);
        handle.join().unwrap();
    }

    #[test]
    fn web_api_error_display_covers_json_and_invalid_url() {
        let _guard = lock_env();
        let err = WebApiError::Json("bad payload".to_string());
        assert_eq!(err.to_string(), "invalid WebUI API response: bad payload");
        let err = WebApiClient::parse_url("localhost").unwrap_err();
        assert!(err.to_string().contains("expected HOST:PORT"));

        // Empty env value falls through to the settings/default path.
        unsafe {
            std::env::set_var("HERDR_WEBUI_TUI_API", "   ");
        }
        let dir = std::env::temp_dir().join(format!("herdr-tui-empty-env-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("herdr-webui")).unwrap();
        unsafe {
            std::env::set_var("XDG_CONFIG_HOME", &dir);
        }
        let client = WebApiClient::discover().unwrap();
        assert_eq!(
            client.base_url(),
            format!("http://127.0.0.1:{}", default_web_api_port()),
            "empty env falls back to default"
        );

        // Malformed persisted binds fall back to the default too.
        for bad in ["no-colon", ":8787", "host:notaport"] {
            std::fs::write(
                dir.join("herdr-webui/webui-settings.json"),
                serde_json::json!({"bind": bad}).to_string(),
            )
            .unwrap();
            let client = WebApiClient::discover().unwrap();
            assert_eq!(
                client.base_url(),
                format!("http://127.0.0.1:{}", default_web_api_port()),
                "bad bind {bad} falls back"
            );
        }
        unsafe {
            std::env::remove_var("HERDR_WEBUI_TUI_API");
            std::env::remove_var("XDG_CONFIG_HOME");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn request_json_parses_chunked_responses() {
        // Chunked body with a split payload (two chunks) and trailer-less
        // termination, served by a raw TCP listener on an ephemeral port.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            use std::io::{Read, Write};
            // partial probe + real GET; after the budget the self-flip makes
            // the accept WouldBlock arm the loop's only exit.
            let mut remaining = 2usize;
            loop {
                if remaining == 0 {
                    let _ = listener.set_nonblocking(true);
                }
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                remaining -= 1;
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
                let head = "{\"ok\":";
                let tail = "true}";
                let body = format!(
                    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n{:x}\r\n{}\r\n0\r\n\r\n",
                    head.len(),
                    head,
                    tail.len(),
                    tail
                );
                let _ = stream.write_all(body.as_bytes());
                let _ = stream.flush();
            }
        });

        let client = WebApiClient::new("127.0.0.1", port);
        // Partial request then hang up: the fixture's read loop takes
        // the no-terminator continue arm, then its n == 0 break.
        partial_request_probe(port);
        let value = client
            .request_json("GET", "/api/ping", None)
            .expect("chunked response must parse");
        assert_eq!(value["ok"], true);
        handle.join().unwrap();
    }

    #[test]
    fn read_chunked_body_rejects_invalid_size_lines() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            // partial probe + real GET; after the budget the self-flip makes
            // the accept WouldBlock arm the loop's only exit.
            let mut remaining = 2usize;
            loop {
                if remaining == 0 {
                    let _ = listener.set_nonblocking(true);
                }
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                remaining -= 1;
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
                let body = "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nnot-a-size\r\n";
                let _ = stream.write_all(body.as_bytes());
                let _ = stream.flush();
            }
        });

        let client = WebApiClient::new("127.0.0.1", port);
        // Partial request then hang up: the fixture's read loop takes
        // the no-terminator continue arm, then its n == 0 break.
        partial_request_probe(port);
        let err = client
            .request_json("GET", "/api/ping", None)
            .expect_err("invalid chunk size must fail");
        assert!(
            err.to_string().contains("invalid chunk size"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn request_json_reports_empty_and_json_bodies() {
        // Empty body parses to Value::Null via the chunked termination only,
        // so use a content-length 0 response here.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            // partial probe + real GET; after the budget the self-flip makes
            // the accept WouldBlock arm the loop's only exit.
            let mut remaining = 2usize;
            loop {
                if remaining == 0 {
                    let _ = listener.set_nonblocking(true);
                }
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                remaining -= 1;
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
                let body = "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n";
                let _ = stream.write_all(body.as_bytes());
                let _ = stream.flush();
            }
        });

        let client = WebApiClient::new("127.0.0.1", port);
        // Partial request then hang up: the fixture's read loop takes
        // the no-terminator continue arm, then its n == 0 break.
        partial_request_probe(port);
        let value = client
            .request_json("GET", "/api/ping", None)
            .expect("empty body must parse as null");
        assert!(value.is_null());
    }

    #[test]
    fn discover_prefers_env_over_settings_and_default() {
        let _guard = lock_env();
        // The env var wins when present. Env manipulation is process-global
        // but nothing else in this test binary reads these variables.
        unsafe {
            std::env::set_var("HERDR_WEBUI_TUI_API", "127.0.0.1:1234");
        }
        let client = WebApiClient::discover().expect("env discovery");
        assert_eq!(client.base_url(), "http://127.0.0.1:1234");
        unsafe {
            std::env::remove_var("HERDR_WEBUI_TUI_API");
        }

        // With XDG_CONFIG_HOME scoped to an empty temp dir there is no
        // settings file, so the default bind is used.
        let dir = std::env::temp_dir().join(format!(
            "herdr-tui-discover-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("herdr-webui")).unwrap();
        unsafe {
            std::env::set_var("XDG_CONFIG_HOME", &dir);
        }
        let client = WebApiClient::discover().expect("default discovery");
        assert_eq!(
            client.base_url(),
            format!("http://127.0.0.1:{}", default_web_api_port())
        );

        // A settings file with a bind address wins over the default.
        let settings = serde_json::json!({"bind": "192.168.1.10:9999"});
        std::fs::write(
            dir.join("herdr-webui/webui-settings.json"),
            settings.to_string(),
        )
        .unwrap();
        let client = WebApiClient::discover().expect("settings discovery");
        assert_eq!(client.base_url(), "http://192.168.1.10:9999");
        unsafe {
            std::env::remove_var("XDG_CONFIG_HOME");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn http_error_extracts_payload_and_request_helpers_cover_cleanup_routes() {
        let (port, handle) = raw_http_server(|mut s| {
            write_response(
                &mut s,
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 22\r\n\r\n{\"error\":\"bad things\"}",
            );
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let err = client.git_cleanup_scan("/root dir").unwrap_err();
        assert_eq!(err.to_string(), "WebUI API error 500: bad things");
        handle.join().unwrap();

        let (port, handle) = raw_http_server(|mut s| {
            write_response(
                &mut s,
                "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}",
            );
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let err = client
            .git_cleanup_branch_delete("/repo", "old", false)
            .unwrap_err();
        assert_eq!(err.to_string(), "WebUI API error 404");
        handle.join().unwrap();
    }

    #[test]
    fn request_json_rejects_malformed_status_truncated_body_and_bad_json() {
        let (port, handle) = raw_http_server(|mut s| {
            write_response(&mut s, "NOTHTTP\r\n\r\n{}");
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let err = client.get("/bad").unwrap_err();
        assert!(err.to_string().contains("malformed status line"));
        handle.join().unwrap();

        let (port, handle) = raw_http_server(|mut s| {
            write_response(&mut s, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nshort");
        });
        let client = WebApiClient::new("127.0.0.1", port);
        assert!(client
            .get("/short")
            .unwrap_err()
            .to_string()
            .contains("failed"));
        handle.join().unwrap();

        let (port, handle) = raw_http_server(|mut s| {
            write_response(
                &mut s,
                "HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\nnot json",
            );
        });
        let client = WebApiClient::new("127.0.0.1", port);
        assert!(client
            .get("/json")
            .unwrap_err()
            .to_string()
            .contains("invalid WebUI API response"));
        handle.join().unwrap();
    }

    #[test]
    fn round4_http_json_errors_resets_and_conflict_resolve_post() {
        assert_eq!(
            WebApiError::Api("server said no".to_string()).to_string(),
            "server said no"
        );

        let (port, handle) = raw_http_server(|mut s| {
            write_response(
                &mut s,
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 23\r\n\r\n{\"error\":\"boom failed\"}",
            );
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let err = client.get("/api/fail").unwrap_err();
        assert_eq!(err.to_string(), "WebUI API error 500: boom failed");
        handle.join().unwrap();

        let (port, handle) = raw_http_server(|mut s| {
            write_response(
                &mut s,
                "HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\nnotjson",
            );
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let err = client.get("/api/bad-error").unwrap_err();
        assert!(
            err.to_string().contains("invalid WebUI API response"),
            "malformed json error body fails while parsing response: {err}"
        );
        handle.join().unwrap();

        let (port, handle) = raw_http_server(|s| {
            let _ = s.shutdown(std::net::Shutdown::Both);
        });
        let client = WebApiClient::new("127.0.0.1", port);
        assert!(client
            .get("/api/reset")
            .unwrap_err()
            .to_string()
            .contains("webui connection failed"));
        handle.join().unwrap();

        let (port, handle) = raw_http_server(|mut s| {
            write_response(&mut s, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
        });
        let client = WebApiClient::new("127.0.0.1", port);
        assert_eq!(
            client
                .git_conflict_resolve("/repo", "a.rs", "ours")
                .unwrap(),
            json!({})
        );
        handle.join().unwrap();
    }
}

#[cfg(test)]
mod coverage_tests {
    use super::tests::lock_env;
    use super::*;
    use std::net::TcpListener;

    fn display_cases() {
        // Http with empty message and HttpDetailed with empty note both
        // use the short form.
        let err = WebApiError::Http {
            status: 500,
            message: String::new(),
        };
        assert_eq!(err.to_string(), "WebUI API error 500");
        let detailed = WebApiError::HttpDetailed {
            status: 502,
            message: String::new(),
            body: serde_json::json!({}),
        };
        assert_eq!(detailed.to_string(), "WebUI API error 502");
        // A detailed error with a message renders the long form.
        let detailed = WebApiError::HttpDetailed {
            status: 503,
            message: "upstream gone".to_string(),
            body: serde_json::json!({"error": "upstream gone"}),
        };
        assert_eq!(detailed.to_string(), "WebUI API error 503: upstream gone");
    }

    #[test]
    fn webapi_error_display_short_forms() {
        display_cases();
        // note() falls back to Display when the error is not detailed.
        let err = WebApiError::Api("server said no".to_string());
        assert_eq!(err.note(), "server said no");
    }

    #[test]
    fn replay_session_walks_rejected_tokens_and_reports_the_last_401() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            use std::io::{Read as _, Write as _};
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let body = "{\"error\":\"unauthorized\"}";
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                        body.len(),
                        body
                    )
                    .as_bytes(),
                );
                let _ = stream.flush();
            }
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let tokens = vec![
            WebApiSessionToken {
                token: "dead1".to_string(),
            },
            WebApiSessionToken {
                token: "dead2".to_string(),
            },
        ];
        let result = client.replay_session(&tokens);
        assert!(result.is_err());
        assert_eq!(
            result.unwrap_err().to_string(),
            "WebUI API error 401: session token from sidecar was rejected"
        );
        assert!(
            client.session_cookie.borrow().is_none(),
            "no dead cookie cached"
        );
        drop(handle);
    }

    #[test]
    fn replay_session_with_no_tokens_reports_the_missing_sidecar_401() {
        let client = WebApiClient::new("127.0.0.1", 1);
        let result = client.replay_session(&[]);
        assert_eq!(
            result.unwrap_err().to_string(),
            "WebUI API error 401: no live session token in the sidecar (log in once from a browser)"
        );
    }

    #[test]
    fn replay_session_surfaces_non_401_errors_immediately() {
        // Port 1 refuses connections: the probe dies with an Io error
        // before any HTTP status, which must abort the walk.
        let client = WebApiClient::new("127.0.0.1", 1);
        let tokens = vec![WebApiSessionToken {
            token: "tok".to_string(),
        }];
        let result = client.replay_session(&tokens);
        assert!(matches!(result, Err(WebApiError::Io(_))));
    }

    #[test]
    fn persisted_session_tokens_filters_expired_records_and_keeps_open_ended_ones() {
        let dir =
            std::env::temp_dir().join(format!("herdr-webapi-token-test-{}", std::process::id()));
        let config = dir.join("herdr-webui");
        std::fs::create_dir_all(&config).unwrap();
        let root = config.join("webui-settings.json");
        std::fs::write(&root, "{}").unwrap();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let sidecar = serde_json::json!({
            "sessions": [
                {"token": "expired", "expires_at": now - 10},
                {"token": "live", "expires_at": now + 3600},
                {"token": "open-ended"}
            ]
        });
        std::fs::write(
            root.with_file_name("session-token"),
            serde_json::to_string(&sidecar).unwrap(),
        )
        .unwrap();

        // webui_settings_path() reads XDG_CONFIG_HOME; point it at the
        // temp dir and restore the env var afterwards. The env lock
        // keeps parallel tests from racing the settings discovery.
        let _env = lock_env();
        std::env::set_var("XDG_CONFIG_HOME", &dir);
        let tokens = persisted_session_tokens().expect("sidecar parses");
        std::env::remove_var("XDG_CONFIG_HOME");
        assert_eq!(tokens.len(), 2, "expired record dropped");
        assert_eq!(tokens[0].token, "live");
        assert_eq!(tokens[1].token, "open-ended");

        // A sidecar with only expired records yields None (the empty
        // vec collapses so callers skip the replay entirely).
        let only_expired = serde_json::json!({
            "sessions": [{"token": "expired", "expires_at": now - 10}]
        });
        std::fs::write(
            root.with_file_name("session-token"),
            serde_json::to_string(&only_expired).unwrap(),
        )
        .unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &dir);
        let tokens = persisted_session_tokens();
        std::env::remove_var("XDG_CONFIG_HOME");
        assert!(tokens.is_none());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

#[cfg(test)]
mod coverage_tests_socket {
    use super::*;

    #[test]
    fn socket_transport_dispatches_git_verbs_over_the_backend_socket() {
        // Socket transport: git/file verbs dispatch to the backend
        // control socket instead of HTTP. A nonexistent socket path
        // fails without ever touching a TCP port.
        let client = WebApiClient::from_backend_socket("/nonexistent-tui-cov.sock");
        assert!(client.is_socket_transport());
        let err = client.git_status("/repo").unwrap_err();
        assert!(
            matches!(err, WebApiError::Api(message) if !message.is_empty()),
            "socket failure maps to Api error"
        );
    }
}

#[cfg(test)]
mod coverage_tests_round3 {
    use super::*;

    /// Coverage is off for this fn because the one-shot server thread's
    /// accept-failure else arm only runs when the listener drops, which
    /// the one-request flow never triggers; the request-side logic is
    /// asserted directly.
    #[cfg_attr(coverage, coverage(off))]
    #[test]
    fn http_transport_recent_workspaces_parses_the_json_body() {
        // WebApiClient::new builds the Http transport; recent_workspaces
        // is one of the few routes pinned to it, so driving it against a
        // one-shot server exercises the HTTP arm of request_json
        // (request formatting, Content-Length, response parse).
        use std::io::{BufRead as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                let _ = reader.read_line(&mut request);
                loop {
                    let mut header = String::new();
                    if reader.read_line(&mut header).unwrap_or(0) == 0 || header.trim().is_empty() {
                        break;
                    }
                }
                assert!(
                    request.starts_with("GET /api/recent-workspaces HTTP/1.1"),
                    "request line: {request}"
                );
                let body = r#"{"workspaces":["/repo"]}"#;
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.flush();
            }
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let data = client.recent_workspaces().unwrap();
        assert_eq!(
            data.get("workspaces").unwrap()[0].as_str().unwrap(),
            "/repo"
        );
    }
}

#[cfg(test)]
mod coverage_tests_round4 {
    use super::*;

    /// Coverage is off for this fn because the server thread only sees
    /// POSTs with a body, so its zero-content-length guard never runs;
    /// the recorded request line asserts the body flow directly.
    #[cfg_attr(coverage, coverage(off))]
    #[test]
    fn git_apply_patch_sends_the_full_body_and_passes_the_response_through() {
        // git_apply_patch (the pre-chunk single-hunk route) must POST
        // cwd/patch/reverse/cached and return the server's JSON body.
        use std::io::{BufRead as _, Read as _, Write as _};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = std::io::BufReader::new(stream.try_clone().unwrap());
            let mut request = String::new();
            reader.read_line(&mut request).unwrap();
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
            tx.send(format!("{request}{}", String::from_utf8_lossy(&payload)))
                .unwrap();
            let body = r#"{"ok":true,"applied":1}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            let _ = stream.flush();
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let result = client
            .git_apply_patch("/repo", "@@ -1 +1 @@\n-old\n+new\n", true, false)
            .unwrap();
        assert_eq!(result.get("applied").unwrap(), 1);
        let request = rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap();
        assert!(
            request.starts_with("POST /api/git-ui/apply-patch"),
            "{request}"
        );
        assert!(request.contains("\"cwd\":\"/repo\""));
        assert!(request.contains("\"reverse\":true"));
        assert!(request.contains("\"cached\":false"));
        assert!(request.contains("\"patch\":\"@@ -1 +1 @@\\n-old\\n+new\\n\""));
    }
}

#[cfg(test)]
mod coverage_tests_round5 {
    use super::tests::lock_env;
    use super::*;
    use std::time::Duration;

    #[test]
    fn dead_endpoint_error_arms_report_io_errors_for_every_call_family() {
        // A closed port makes every request path fail at connect time,
        // which exercises the error mapping arms (map_err closures)
        // that a successful fake-server request never runs.
        let mut client = WebApiClient::new("127.0.0.1", 1);
        client.set_timeout(Duration::from_millis(200));
        assert!(client.recent_workspaces().is_err());
        assert!(client.open_recent_workspace("/repo", Some("l")).is_err());
        assert!(client
            .record_recent_workspace("/repo", None, Some("workspace"))
            .is_err());
        assert!(client.remove_recent_workspace("/repo").is_err());
        assert!(client.clear_recent_workspaces().is_err());
        assert!(client.sessions_list().is_err());
        assert!(client.session_launch("s", "builtin").is_err());
        assert!(client.session_close("s", "builtin").is_err());
        assert!(client.session_cleanup().is_err());
        assert!(client.submit_pane("p1", "hi").is_err());
        assert!(client.submit_pane_enqueued("p1", "hi").is_err());
        assert!(client.pane_prompt("p1").is_err());
        assert!(client.file_tree("/repo", ".", 2).is_err());
        assert!(client.file_search("/repo", ".", "q", 0, 10, false).is_err());
        assert!(client.file_search("/repo", ".", "q", 0, 10, true).is_err());
        assert!(client
            .content_search("/repo", ".", "needle", 0, 20, false, false)
            .is_err());
        assert!(client.file_read("/repo", "a.rs").is_err());
        assert!(client.file_write("/repo", "a.rs", "x", None).is_err());
        assert!(client.file_write_create("/repo", "a.rs", "x").is_err());
        assert!(client.file_rename("/repo", "a.rs", "b.rs").is_err());
        assert!(client.file_delete("/repo", "a.rs").is_err());
        assert!(client.git_status("/repo").is_err());
        assert!(client.git_diff("/repo", "unstaged", None).is_err());
        assert!(client.git_log_scoped("/repo", "all", "", 50, None).is_err());
        assert!(client.git_branches("/repo").is_err());
        assert!(client.git_file_history("/repo", "a.rs").is_err());
        assert!(client.git_compare("/repo", "main", "HEAD", None).is_err());
        assert!(client
            .git_compare("/repo", "main", "HEAD", Some("a.rs"))
            .is_err());
        assert!(client.git_blame("/repo", "a.rs", "HEAD").is_err());
        assert!(client.git_stashes("/repo").is_err());
        assert!(client.git_stage("/repo", &["a.rs".into()]).is_err());
        assert!(client.git_unstage("/repo", &["a.rs".into()]).is_err());
        assert!(client.git_discard("/repo", &["a.rs".into()]).is_err());
        assert!(client.git_commit("/repo", "msg", None, false).is_err());
        assert!(client.git_pull("/repo", "ff").is_err());
        assert!(client.git_push("/repo", "up").is_err());
        assert!(client.git_fetch("/repo", Some("main")).is_err());
        assert!(client.git_fetch("/repo", None).is_err());
        assert!(client.git_switch("/repo", "b", false).is_err());
        assert!(client.git_switch("/repo", "b", true).is_err());
        assert!(client.git_reset("/repo", "abc", "soft", "RESET").is_err());
        assert!(client
            .git_rebase("/repo", "main", None, false, "REBASE")
            .is_err());
        assert!(client
            .git_rebase("/repo", "main", Some("topic"), true, "REBASE")
            .is_err());
        assert!(client.git_tag("/repo", "v1", "abc").is_err());
        assert!(client.git_branch_delete("/repo", "b", true).is_err());
        assert!(client.git_branch_delete("/repo", "b", false).is_err());
        assert!(client.git_stash("/repo").is_err());
        assert!(client.git_stash_show("/repo", "stash@{0}").is_err());
        assert!(client.git_conflicts("/repo").is_err());
        assert!(client
            .git_conflict_resolve("/repo", "a.rs", "ours")
            .is_err());
        assert!(client.git_conflict_action("/repo", "continue").is_err());
        assert!(client.git_conflict_action("/repo", "abort").is_err());
        assert!(client.git_cleanup_scan("/repo").is_err());
        assert!(client
            .git_cleanup_branch_delete("/repo", "b", false)
            .is_err());
        assert!(client
            .git_cleanup_worktree_remove("/repo", "/wt", false)
            .is_err());
        assert!(client.git_cleanup_worktree_prune("/repo").is_err());
    }

    #[test]
    fn unresolvable_host_and_empty_resolution_report_io_errors() {
        // A hostname that never resolves covers the resolve_web_api_addr
        // error arm; a literal that resolves to nothing would need a
        // DNS stub, so the map_err arm of to_socket_addrs is the target.
        let mut client = WebApiClient::new("host.invalid.invalid", 80);
        client.set_timeout(Duration::from_millis(300));
        assert!(client.git_status("/repo").is_err());
    }

    #[test]
    fn chunked_body_with_invalid_size_and_short_read_reports_io_errors() {
        // A server speaking a corrupt chunked body covers the size-line
        // and read_exact error arms of read_chunked_body.
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
            let _ =
                stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzzzz\r\n");
            let _ = stream.flush();
        });
        let mut client = WebApiClient::new("127.0.0.1", port);
        client.set_timeout(Duration::from_millis(500));
        assert!(client.git_status("/repo").is_err());

        // Second server sends a chunk size then closes mid-chunk: the
        // read_exact arm runs.
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
            let _ = stream
                .write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n10\r\nshort");
            let _ = stream.flush();
        });
        let mut client = WebApiClient::new("127.0.0.1", port);
        client.set_timeout(Duration::from_millis(500));
        assert!(client.git_status("/repo").is_err());
    }

    #[test]
    fn stalled_servers_surface_the_read_io_arms() {
        // A server that stalls mid-line (instead of closing) makes the
        // reads time out: read errors, not clean EOFs, so the map_err
        // arms of the header loop, the body read, and the chunked size
        // line all run.
        use std::io::{BufRead as _, Write as _};
        let stall = Duration::from_secs(5);

        // Partial header line, then stall: the header read_line errors.
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
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Le");
            let _ = stream.flush();
            std::thread::sleep(stall);
        });
        let mut client = WebApiClient::new("127.0.0.1", port);
        client.set_timeout(Duration::from_millis(300));
        assert!(client.git_status("/repo").is_err());

        // Headers done, no content-length, partial body, then stall:
        // read_to_end errors.
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
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: x\r\n\r\npartial");
            let _ = stream.flush();
            std::thread::sleep(stall);
        });
        let mut client = WebApiClient::new("127.0.0.1", port);
        client.set_timeout(Duration::from_millis(300));
        assert!(client.git_status("/repo").is_err());

        // Chunked response stalling mid-size-line: read_chunked's
        // read_line errors.
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
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1");
            let _ = stream.flush();
            std::thread::sleep(stall);
        });
        let mut client = WebApiClient::new("127.0.0.1", port);
        client.set_timeout(Duration::from_millis(300));
        assert!(client.git_status("/repo").is_err());
    }

    #[test]
    fn oversized_patch_write_times_out_against_a_silent_server() {
        // A server that accepts but never reads: a multi-MB patch body
        // fills the socket buffers, so the client's write_all blocks
        // past its write timeout and the write error arm runs.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            // Never read; hold the socket open so the client blocks.
            std::thread::sleep(Duration::from_secs(10));
            drop(stream);
        });
        let mut client = WebApiClient::new("127.0.0.1", port);
        client.set_timeout(Duration::from_millis(300));
        let patch = "@@ -1 +1 @@\n".repeat(200_000);
        assert!(client
            .git_apply_patch("/repo", &patch, false, false)
            .is_err());
    }

    #[test]
    fn persisted_readers_cover_missing_files_garbage_and_tokenless_rows() {
        let _guard = lock_env();
        let dir = std::env::temp_dir().join(format!("herdr-webui-missing-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // No XDG at all: both readers fall through at the path step.
        std::env::remove_var("XDG_CONFIG_HOME");
        assert!(persisted_bind_address().is_none());
        assert!(persisted_session_tokens().is_none());

        // XDG set, files missing: the read arms fall through.
        std::env::set_var("XDG_CONFIG_HOME", &dir);
        assert!(persisted_bind_address().is_none());
        assert!(persisted_session_tokens().is_none());

        // Garbage settings file: the bind parse arm falls through.
        let settings = dir.join("herdr-webui/webui-settings.json");
        std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
        std::fs::write(&settings, "{ nope").unwrap();
        assert!(persisted_bind_address().is_none());

        // Session file with tokenless and non-string token rows: both
        // filter_map ? arms run and the row is skipped.
        std::fs::write(
            settings.parent().unwrap().join("session-token"),
            "{\"sessions\":[{\"expires_at\":1},{\"token\":5}]}",
        )
        .unwrap();
        assert!(persisted_session_tokens().is_none());

        std::env::remove_var("XDG_CONFIG_HOME");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn header_read_error_maps_to_io_error() {
        // A server that accepts and immediately closes covers the
        // header read_line error / connection-closed arms.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            drop(stream);
        });
        let mut client = WebApiClient::new("127.0.0.1", port);
        client.set_timeout(Duration::from_millis(500));
        assert!(client.git_status("/repo").is_err());
    }

    #[test]
    fn content_length_without_valid_header_closes_connection() {
        // Content-Length promised but the connection drops before the
        // body: the read_to_end error arm runs.
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
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\npartial");
            let _ = stream.flush();
        });
        let mut client = WebApiClient::new("127.0.0.1", port);
        client.set_timeout(Duration::from_millis(500));
        assert!(client.git_status("/repo").is_err());
    }

    #[test]
    fn persisted_session_tokens_read_garbage_and_missing_sessions() {
        // Garbage JSON and a sessions-less object both yield None
        // without panicking, covering the parse fall-through arms.
        let _guard = lock_env();
        let dir = std::env::temp_dir().join(format!("herdr-webui-tokens-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Force the None-arm of the env restore: capture with XDG
        // unset so the tail remove_var runs (the Some-arm runs in the
        // bind-address twin, which presets XDG first).
        std::env::remove_var("XDG_CONFIG_HOME");
        let prior_xdg = std::env::var("XDG_CONFIG_HOME").ok();
        assert!(prior_xdg.is_none());
        std::env::set_var("XDG_CONFIG_HOME", &dir);
        std::fs::create_dir_all(dir.join("herdr-webui")).unwrap();
        std::fs::write(dir.join("herdr-webui/webui-settings.json"), "{ bad json").unwrap();
        assert!(persisted_session_tokens().is_none());
        // Garbage in the token sidecar itself: the parse fails.
        std::fs::write(dir.join("herdr-webui/session-token"), "{ also bad").unwrap();
        assert!(persisted_session_tokens().is_none());
        // Valid json without a sessions key: None.
        std::fs::write(dir.join("herdr-webui/session-token"), "{\"other\":1}").unwrap();
        assert!(persisted_session_tokens().is_none());
        std::fs::write(
            dir.join("herdr-webui/session-token"),
            "{\"sessions\":\"not-an-array\"}",
        )
        .unwrap();
        assert!(persisted_session_tokens().is_none());
        std::fs::write(
            dir.join("herdr-webui/session-token"),
            "{\"sessions\":[{\"token\":\"t\",\"expires_at\":\"not-a-number\",\"cookie\":\"c\"}]}",
        )
        .unwrap();
        let tokens = persisted_session_tokens().expect("open-ended entry survives");
        assert_eq!(tokens.len(), 1);
        assert_eq!(tokens[0].token, "t");
        restore_xdg(prior_xdg);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn persisted_bind_address_reads_settings_when_present() {
        // The bind key parses out of the shared settings file; the
        // missing-key path returns None.
        let _guard = lock_env();
        let dir = std::env::temp_dir().join(format!("herdr-webui-bind-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // Force the Some-arm of the env restore: preset XDG so the tail
        // set_var round-trips (the None-arm runs in the token twin).
        std::env::set_var("XDG_CONFIG_HOME", "/tmp");
        let prior_xdg = std::env::var("XDG_CONFIG_HOME").ok();
        assert!(prior_xdg.is_some());
        std::env::set_var("XDG_CONFIG_HOME", &dir);
        assert!(persisted_bind_address().is_none());
        std::fs::create_dir_all(dir.join("herdr-webui")).unwrap();
        // Valid settings without a bind key: the default applies.
        std::fs::write(dir.join("herdr-webui/webui-settings.json"), "{\"other\":1}").unwrap();
        assert!(persisted_bind_address().is_none());
        std::fs::write(
            dir.join("herdr-webui/webui-settings.json"),
            "{\"bind\":\"127.0.0.1:8099\",\"other\":1}",
        )
        .unwrap();
        assert_eq!(persisted_bind_address().as_deref(), Some("127.0.0.1:8099"));
        restore_xdg(prior_xdg);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Restore XDG_CONFIG_HOME: both arms run across the token test
    /// (prior unset) and the bind test (prior set), so the restore
    /// lives in one place instead of per-test matches.
    fn restore_xdg(prior: Option<String>) {
        match prior {
            Some(v) => std::env::set_var("XDG_CONFIG_HOME", v),
            None => std::env::remove_var("XDG_CONFIG_HOME"),
        }
    }
}
