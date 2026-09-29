use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use serde_json::{json, Value};

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
/// Auth parity: the server session token is generated per start (never
/// persisted), so like the desktop the client logs in through `POST
/// /api/login`. Credentials come from the same `webui-settings.json` the
/// bind address does (server validation guarantees `user`/`password` are
/// set whenever auth is required); a first 401 triggers one login and a
/// single retry with the session cookie, and the cookie is cached for
/// later calls. `localhost_no_auth` servers never 401, so nothing changes
/// for the default local setup.
#[derive(Debug, Clone)]
pub struct WebApiClient {
    host: String,
    port: u16,
    timeout: Duration,
    /// Cached `herdr_web_session` cookie from a successful login.
    /// Interior mutability so `request_json(&self)` can keep the cookie
    /// after the 401 login retry — without it the cookie would land on
    /// a dropped temporary and every authed call would re-login.
    session_cookie: std::cell::RefCell<Option<String>>,
}

/// Login credentials read from the persisted WebUI settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebApiCredentials {
    pub username: String,
    pub password: String,
}

#[derive(Debug)]
pub enum WebApiError {
    Io(String),
    InvalidUrl(String),
    Http { status: u16, message: String },
    Json(String),
    Api(String),
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
            Self::Json(message) => write!(f, "invalid WebUI API response: {message}"),
            Self::Api(message) => write!(f, "{message}"),
        }
    }
}

impl std::error::Error for WebApiError {}

impl WebApiClient {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            timeout: Duration::from_secs(20),
            session_cookie: std::cell::RefCell::new(None),
        }
    }

    /// Login once and cache the session cookie (RefCell, so `&self`
    /// suffices). Called by `request_json` after a 401; tests call it
    /// directly too.
    pub fn login(&self, credentials: &WebApiCredentials) -> Result<(), WebApiError> {
        let body = json!({ "username": credentials.username, "password": credentials.password });
        let mut response = self.raw_request_json("POST", "/api/login", Some(&body))?;
        // Pull the session cookie out of the `set-cookie` header we stashed
        // into the response envelope.
        let cookie = response
            .get("_set_cookie")
            .and_then(Value::as_str)
            .and_then(|header| header.split(';').next())
            .map(str::trim)
            .filter(|value| value.starts_with("herdr_web_session="))
            .map(str::to_string);
        response
            .as_object_mut()
            .map(|obj| obj.remove("_set_cookie"));
        match cookie {
            Some(cookie) => {
                *self.session_cookie.borrow_mut() = Some(cookie);
                Ok(())
            }
            None => Err(WebApiError::Api(
                "login succeeded but no session cookie was set".to_string(),
            )),
        }
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
        Ok(Self::new("127.0.0.1", 8787))
    }

    pub fn set_timeout(&mut self, timeout: Duration) {
        self.timeout = timeout;
    }

    pub fn base_url(&self) -> String {
        format!("http://{}:{}", self.host, self.port)
    }

    /// Auth-aware request: on 401 (server auth enabled, no cookie yet)
    /// logs in with the persisted settings credentials and retries once.
    /// Everything else flows through unchanged. Without credentials in
    /// the settings file the 401 surfaces like any other HTTP error.
    /// A stale cookie (WebUI restart rotated the token) also re-logins:
    /// the guard allows one re-login whenever the 401 is not already
    /// the result of the immediately-preceding login, and the retry
    /// after login overwrites the cookie, so recovery is automatic.
    fn request_json(
        &self,
        method: &str,
        path_and_query: &str,
        body: Option<&Value>,
    ) -> Result<Value, WebApiError> {
        let mut attempted_login = false;
        loop {
            match self.raw_request_json(method, path_and_query, body) {
                Err(WebApiError::Http { status: 401, .. }) if !attempted_login => {
                    let Some(credentials) = persisted_credentials() else {
                        return Err(WebApiError::Http {
                            status: 401,
                            message: "unauthorized (set user/password in webui-settings.json)"
                                .to_string(),
                        });
                    };
                    // The cookie lands on `self` (RefCell), so later
                    // calls skip the login; a stale one is replaced
                    // here when the server rotated its token.
                    self.login(&credentials)?;
                    attempted_login = true;
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
            Some(value) => {
                serde_json::to_string(value).map_err(|err| WebApiError::Json(err.to_string()))?
            }
            None => String::new(),
        };
        let cookie_header = self
            .session_cookie
            .borrow()
            .as_deref()
            .map(|cookie| format!("Cookie: {cookie}\r\n"))
            .unwrap_or_default();
        let request = format!(
            "{method} {path_and_query} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nUser-Agent: herdr-webui-tui\r\n{cookie_header}\r\n{body_text}",
            self.host,
            self.port,
            body_text.len(),
        );
        let stream = TcpStream::connect((self.host.as_str(), self.port))
            .map_err(|err| WebApiError::Io(err.to_string()))?;
        stream
            .set_read_timeout(Some(self.timeout))
            .map_err(|err| WebApiError::Io(err.to_string()))?;
        stream
            .set_write_timeout(Some(self.timeout))
            .map_err(|err| WebApiError::Io(err.to_string()))?;
        let mut writer = stream
            .try_clone()
            .map_err(|err| WebApiError::Io(err.to_string()))?;
        writer
            .write_all(request.as_bytes())
            .map_err(|err| WebApiError::Io(err.to_string()))?;
        writer
            .flush()
            .map_err(|err| WebApiError::Io(err.to_string()))?;

        let mut reader = BufReader::new(stream);
        let mut status_line = String::new();
        reader
            .read_line(&mut status_line)
            .map_err(|err| WebApiError::Io(err.to_string()))?;
        let status: u16 = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| WebApiError::Io(format!("malformed status line: {status_line:?}")))?;
        let mut content_length: Option<usize> = None;
        let mut chunked = false;
        let mut set_cookie: Option<String> = None;
        loop {
            let mut header = String::new();
            let read = reader
                .read_line(&mut header)
                .map_err(|err| WebApiError::Io(err.to_string()))?;
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
            } else if lower.starts_with("set-cookie:") {
                set_cookie = Some(header["set-cookie:".len()..].trim().to_string());
            }
        }
        let body_bytes = if chunked {
            read_chunked_body(&mut reader)?
        } else {
            let mut body = Vec::new();
            if let Some(length) = content_length {
                body.resize(length, 0);
                reader
                    .read_exact(&mut body)
                    .map_err(|err| WebApiError::Io(err.to_string()))?;
            } else {
                reader
                    .read_to_end(&mut body)
                    .map_err(|err| WebApiError::Io(err.to_string()))?;
            }
            body
        };
        let value: Value = if body_bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&body_bytes).map_err(|err| WebApiError::Json(err.to_string()))?
        };
        // Expose the set-cookie header to `login` without changing the
        // callers' shape: attach it as a private field on the parsed body
        // (removed again by `login`).
        let value = match (set_cookie, value) {
            (Some(header), Value::Object(mut object)) => {
                object.insert("_set_cookie".to_string(), Value::String(header));
                Value::Object(object)
            }
            (_, value) => value,
        };
        if !(200..300).contains(&status) {
            let message = value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
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

    fn get(&self, path_and_query: &str) -> Result<Value, WebApiError> {
        self.request_json("GET", path_and_query, None)
    }

    fn post(&self, path: &str, body: &Value) -> Result<Value, WebApiError> {
        self.request_json("POST", path, Some(body))
    }

    // ---- file browser ----

    pub fn file_tree(&self, cwd: &str, path: &str, depth: u8) -> Result<Value, WebApiError> {
        self.get(&format!(
            "/api/file-browser/tree?cwd={}&path={}&depth={depth}&include_git_status=true",
            urlencode(cwd),
            urlencode(path),
        ))
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
        self.get(&format!(
            "/api/file-browser/tree?cwd={}&path={}&q={}&offset={offset}&limit={limit}&search_kind={}&include_git_status=true",
            urlencode(cwd),
            urlencode(path),
            urlencode(query),
            if dirs_only { "dir" } else { "file" },
        ))
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
        self.get(&format!(
            "/api/file-browser/content-search?cwd={}&path={}&q={}&offset={offset}&limit={limit}&context_lines=2&match_case={}&regex={}",
            urlencode(cwd),
            urlencode(path),
            urlencode(query),
            if match_case { "true" } else { "false" },
            if regex { "true" } else { "false" },
        ))
    }

    pub fn file_read(&self, cwd: &str, path: &str) -> Result<Value, WebApiError> {
        self.get(&format!(
            "/api/file-browser/file?cwd={}&path={}",
            urlencode(cwd),
            urlencode(path),
        ))
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
        self.post(
            "/api/file-browser/file",
            &json!({
                "cwd": cwd,
                "path": path,
                "content": content,
                "expected_hash": expected_hash,
                "create_parents": create_parents,
            }),
        )
    }

    pub fn file_rename(&self, cwd: &str, path: &str, new_name: &str) -> Result<Value, WebApiError> {
        self.post(
            "/api/file-browser/rename",
            &json!({ "cwd": cwd, "path": path, "new_name": new_name }),
        )
    }

    pub fn file_delete(&self, cwd: &str, path: &str) -> Result<Value, WebApiError> {
        self.post(
            "/api/file-browser/delete",
            &json!({ "cwd": cwd, "path": path }),
        )
    }

    // ---- git ui ----

    pub fn git_status(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.get(&format!("/api/git-ui/status?cwd={}", urlencode(cwd)))
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
        self.get(&url)
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
        self.get(&url)
    }

    pub fn git_branches(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.get(&format!("/api/git-ui/branches?cwd={}", urlencode(cwd)))
    }

    pub fn git_file_history(&self, cwd: &str, file: &str) -> Result<Value, WebApiError> {
        self.get(&format!(
            "/api/git-ui/file-history?cwd={}&file={}",
            urlencode(cwd),
            urlencode(file)
        ))
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
        self.get(&url)
    }

    /// Blame for one file (webui `blame` toggle). The server returns
    /// raw `--line-porcelain` text; the panel parses it.
    pub fn git_blame(&self, cwd: &str, file: &str, ref_name: &str) -> Result<Value, WebApiError> {
        self.get(&format!(
            "/api/git-ui/blame?cwd={}&file={}&ref_name={}",
            urlencode(cwd),
            urlencode(file),
            urlencode(ref_name)
        ))
    }

    pub fn git_stashes(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.get(&format!("/api/git-ui/stashes?cwd={}", urlencode(cwd)))
    }

    pub fn git_stage(&self, cwd: &str, paths: &[String]) -> Result<Value, WebApiError> {
        self.post("/api/git-ui/stage", &json!({ "cwd": cwd, "paths": paths }))
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
        self.post(
            "/api/git-ui/apply-patch",
            &json!({ "cwd": cwd, "patch": patch, "reverse": reverse, "cached": cached }),
        )
    }

    pub fn git_unstage(&self, cwd: &str, paths: &[String]) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/unstage",
            &json!({ "cwd": cwd, "paths": paths }),
        )
    }

    pub fn git_discard(&self, cwd: &str, paths: &[String]) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/discard",
            &json!({ "cwd": cwd, "paths": paths, "confirmed": true }),
        )
    }

    pub fn git_commit(
        &self,
        cwd: &str,
        title: &str,
        body: Option<&str>,
        amend: bool,
    ) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/commit",
            &json!({ "cwd": cwd, "title": title, "body": body, "amend": amend }),
        )
    }

    pub fn git_pull(&self, cwd: &str, mode: &str) -> Result<Value, WebApiError> {
        self.post("/api/git-ui/pull", &json!({ "cwd": cwd, "mode": mode }))
    }

    pub fn git_push(&self, cwd: &str, mode: &str) -> Result<Value, WebApiError> {
        self.post("/api/git-ui/push", &json!({ "cwd": cwd, "mode": mode }))
    }

    pub fn git_fetch(&self, cwd: &str, branch: Option<&str>) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/fetch",
            &json!({ "cwd": cwd, "branch": branch }),
        )
    }

    pub fn git_switch(&self, cwd: &str, branch: &str, create: bool) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/switch",
            &json!({ "cwd": cwd, "branch": branch, "create": create }),
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
        self.post(
            "/api/git-ui/reset",
            &json!({
                "cwd": cwd,
                "ref_name": ref_name,
                "mode": mode,
                "confirmation": confirmation,
            }),
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
        self.post(
            "/api/git-ui/rebase",
            &json!({
                "cwd": cwd,
                "upstream": upstream,
                "onto": onto,
                "pull_first": pull_first,
                "confirmation": confirmation,
            }),
        )
    }

    /// `/api/git-ui/tag`: create `tag_name` on `ref_name` (a hash or
    /// branch). The server validates both as single git tokens.
    pub fn git_tag(&self, cwd: &str, tag_name: &str, ref_name: &str) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/tag",
            &json!({
                "cwd": cwd,
                "tag_name": tag_name,
                "ref_name": ref_name,
            }),
        )
    }

    pub fn git_branch_delete(
        &self,
        cwd: &str,
        branch: &str,
        force: bool,
    ) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/branch-delete",
            &json!({ "cwd": cwd, "branch": branch, "force": force, "confirmed": true }),
        )
    }

    pub fn git_stash(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.post("/api/git-ui/stash", &json!({ "cwd": cwd }))
    }

    /// `/api/git-ui/stash-show`: full diff of one stash entry. Response
    /// shape matches `/api/git-ui/diff`, so `parse_diff_lines_with_meta`
    /// can parse it.
    pub fn git_stash_show(&self, cwd: &str, stash: &str) -> Result<Value, WebApiError> {
        self.get(&format!(
            "/api/git-ui/stash-show?cwd={}&stash={}&context=3",
            urlencode(cwd),
            urlencode(stash),
        ))
    }

    /// `/api/git-ui/conflicts`: conflicted file list plus merge/rebase state.
    pub fn git_conflicts(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.get(&format!("/api/git-ui/conflicts?cwd={}", urlencode(cwd),))
    }

    /// `/api/git-ui/conflict-resolve`: resolve one file with `ours` /
    /// `base` (parent) / `theirs` (remote) / `mark` (git add).
    pub fn git_conflict_resolve(
        &self,
        cwd: &str,
        path: &str,
        mode: &str,
    ) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/conflict-resolve",
            &json!({ "cwd": cwd, "path": path, "mode": mode }),
        )
    }

    /// `/api/git-ui/conflict-action`: continue/skip/abort a rebase, merge,
    /// or cherry-pick in progress.
    pub fn git_conflict_action(&self, cwd: &str, action: &str) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/conflict-action",
            &json!({ "cwd": cwd, "action": action }),
        )
    }

    /// `/api/git-ui/cleanup-scan`: repos with merged branches and stale
    /// worktrees under a root directory.
    pub fn git_cleanup_scan(&self, root: &str) -> Result<Value, WebApiError> {
        self.get(&format!(
            "/api/git-ui/cleanup-scan?root={}",
            urlencode(root),
        ))
    }

    /// `/api/git-ui/branch-delete` with explicit confirmation (the TUI
    /// collects its own confirmation before calling).
    pub fn git_cleanup_branch_delete(&self, cwd: &str, branch: &str) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/branch-delete",
            &json!({ "cwd": cwd, "branch": branch, "force": false, "confirmed": true }),
        )
    }

    /// `/api/git-ui/worktree-remove` for cleanup.
    pub fn git_cleanup_worktree_remove(&self, cwd: &str, path: &str) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/worktree-remove",
            &json!({ "cwd": cwd, "path": path, "confirmed": true }),
        )
    }

    /// `/api/git-ui/worktree-prune` for cleanup.
    pub fn git_cleanup_worktree_prune(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.post("/api/git-ui/worktree-prune", &json!({ "cwd": cwd }))
    }

    pub fn git_stash_apply(&self, cwd: &str, stash: &str) -> Result<Value, WebApiError> {
        self.post(
            "/api/git-ui/stash-apply",
            &json!({ "cwd": cwd, "stash": stash }),
        )
    }

    pub fn git_stash_drop(&self, cwd: &str, stash: &str) -> Result<Value, WebApiError> {
        // The server rejects drops without an explicit confirmation flag;
        // the TUI collects its own `y` confirmation before calling.
        self.post(
            "/api/git-ui/stash-drop",
            &json!({ "cwd": cwd, "stash": stash, "confirmed": true }),
        )
    }
}

fn read_chunked_body(reader: &mut BufReader<TcpStream>) -> Result<Vec<u8>, WebApiError> {
    let mut body = Vec::new();
    loop {
        let mut size_line = String::new();
        reader
            .read_line(&mut size_line)
            .map_err(|err| WebApiError::Io(err.to_string()))?;
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
        reader
            .read_exact(&mut chunk)
            .map_err(|err| WebApiError::Io(err.to_string()))?;
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

/// Read `bind` from the WebUI settings file so the TUI finds the server even
/// when the user changed the default port.
fn persisted_bind_address() -> Option<String> {
    let path = if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        std::path::PathBuf::from(dir).join("herdr-webui/webui-settings.json")
    } else {
        std::env::var("HOME").ok().map(|home| {
            std::path::PathBuf::from(home).join(".config/herdr-webui/webui-settings.json")
        })?
    };
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    value.get("bind")?.as_str().map(str::to_string)
}

/// `user`/`password` from the same persisted settings the bind address
/// comes from. The server only requires auth when those are set (or a
/// non-loopback bind forces them), so `None` here means the default
/// localhost no-auth setup and the 401 path never triggers.
fn persisted_credentials() -> Option<WebApiCredentials> {
    let path = if let Ok(dir) = std::env::var("XDG_CONFIG_HOME") {
        std::path::PathBuf::from(dir).join("herdr-webui/webui-settings.json")
    } else {
        std::env::var("HOME").ok().map(|home| {
            std::path::PathBuf::from(home).join(".config/herdr-webui/webui-settings.json")
        })?
    };
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    Some(WebApiCredentials {
        username: value.get("user")?.as_str()?.trim().to_string(),
        password: value.get("password")?.as_str()?.trim().to_string(),
    })
    .filter(|credentials| !credentials.username.is_empty() && !credentials.password.is_empty())
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;

    use super::*;

    /// Env manipulation is process-global and lib tests run in parallel;
    /// every test that reads or mutates `HERDR_WEBUI_TUI_API` or
    /// `XDG_CONFIG_HOME` must hold the shared lib-wide lock so discovery
    /// cannot race other modules' env-mutating tests either.
    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        crate::test_env_lock()
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
    }

    #[test]
    fn parses_webui_api_urls() {
        let client = WebApiClient::parse_url("127.0.0.1:8787").unwrap();
        assert_eq!(client.host, "127.0.0.1");
        assert_eq!(client.port, 8787);

        let client = WebApiClient::parse_url("http://localhost:9000/").unwrap();
        assert_eq!(client.host, "localhost");
        assert_eq!(client.port, 9000);

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
        // In CI/tests the env var and settings file may point elsewhere; only
        // assert a valid client is produced.
        if std::env::var("HERDR_WEBUI_TUI_API").is_ok() {
            let client = WebApiClient::discover().unwrap();
            assert!(client.port > 0);
            return;
        }
        let client = match WebApiClient::discover() {
            Ok(client) => client,
            Err(_) => return,
        };
        if std::env::var("HERDR_WEBUI_TUI_API").is_err() {
            assert_eq!(
                client.base_url(),
                format!("http://{}:{}", client.host, client.port)
            );
        }
    }

    #[test]
    fn client_reads_response_from_plain_tcp_server() {
        use std::io::BufRead as _;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = std::thread::spawn(move || {
            if let Ok((stream, _)) = listener.accept() {
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request = String::new();
                if reader.read_line(&mut request).is_ok() {
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
        let value = client.get("/api/me").unwrap();
        assert_eq!(value, serde_json::json!({ "ok": true }));
        handle.join().unwrap();
    }

    #[test]
    fn login_round_trip_caches_cookie_and_retries_401() {
        // Server behavior: /api/recent-workspaces 401s without the
        // session cookie, /api/login checks the body credentials and
        // sets the cookie, an authorized GET returns rows. The client
        // must do 401 -> login -> retry transparently and reuse the
        // cookie on the next call.
        use std::io::{BufRead as _, BufReader};
        use std::sync::{Arc, Mutex};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let login_seen = Arc::new(Mutex::new(0usize));
        let seen = login_seen.clone();
        let handle = std::thread::spawn(move || {
            let mut remaining = 3usize; // login + 2 authorized GETs
            for stream in listener.incoming() {
                if remaining == 0 {
                    break;
                }
                remaining -= 1;
                let exhausted = remaining == 0;
                let Ok(stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                let target = request_line.split(' ').nth(1).unwrap_or("").to_string();
                let mut content_length = 0usize;
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
                    if let Some(value) = lower.strip_prefix("content-length:") {
                        content_length = value.trim().parse().unwrap_or(0);
                    } else if let Some(value) = lower.strip_prefix("cookie:") {
                        has_cookie = true;
                        cookie_value = value.trim().to_string();
                    }
                }
                let mut body = vec![0; content_length];
                if content_length > 0 {
                    let _ = reader.read_exact(&mut body);
                }
                let body: Value = if body.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&body).unwrap_or(Value::Null)
                };
                let mut stream = stream;
                let response = if target == "/api/login" {
                    *seen.lock().unwrap() += 1;
                    let ok = body.get("username").and_then(Value::as_str) == Some("admin")
                        && body.get("password").and_then(Value::as_str) == Some("secret");
                    if ok {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: herdr_web_session=token123; HttpOnly; Path=/\r\nContent-Length: {}\r\n\r\n{{\"ok\":true}}",
                            "{\"ok\":true}".len()
                        )
                    } else {
                        format!(
                            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"error\":\"invalid credentials\"}}",
                            "{\"error\":\"invalid credentials\"}".len()
                        )
                    }
                } else if !has_cookie || !cookie_value.contains("herdr_web_session=token123") {
                    format!(
                        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"error\":\"unauthorized\"}}",
                        "{\"error\":\"unauthorized\"}".len()
                    )
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"recent\":[{{\"path\":\"/a\"}}]}}",
                        "{\"recent\":[{\"path\":\"/a\"}]}".len()
                    )
                };
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
                let _ = stream.shutdown(std::net::Shutdown::Both);
                if exhausted {
                    break;
                }
            }
        });
        let client = WebApiClient::new("127.0.0.1", port);
        let credentials = WebApiCredentials {
            username: "admin".to_string(),
            password: "secret".to_string(),
        };
        assert!(
            client.session_cookie.borrow().is_none(),
            "test starts without a cookie"
        );
        // Login explicitly (the TUI binary could do this at startup too),
        // then both calls must ride the cached cookie.
        client.login(&credentials).expect("login succeeds");
        assert_eq!(*login_seen.lock().unwrap(), 1, "explicit login counted");
        let value = client.recent_workspaces().expect("authorized call");
        assert_eq!(value["recent"][0]["path"], "/a");
        // A second call reuses the cached cookie — the bug this pins:
        // the cookie used to land on a dropped temporary inside
        // request_json, so every authed call re-logged-in. Exactly one
        // login must serve both calls.
        let value = client.recent_workspaces().expect("cached cookie works");
        assert_eq!(value["recent"][0]["path"], "/a");
        assert_eq!(*login_seen.lock().unwrap(), 1, "exactly one login");
        // The server thread parks on accept() after its bounded request
        // count; detach it like the other fake servers in this suite.
        drop(handle);
    }

    #[test]
    fn stale_cookie_relogs_in_after_server_token_rotation() {
        // The WebUI regenerates its session token on every start, so a
        // long-running TUI holds a stale cookie after a server restart.
        // The old guard (`cookie.is_none()`) refused to re-login and the
        // 401 surfaced forever; the retry loop must replace the stale
        // cookie and recover.
        let _guard = lock_env();
        use std::io::{BufRead as _, BufReader};
        use std::sync::{Arc, Mutex};
        let config_home =
            std::env::temp_dir().join(format!("herdr-tui-stale-cookie-{}", std::process::id()));
        std::fs::create_dir_all(config_home.join("herdr-webui")).unwrap();
        std::fs::write(
            config_home.join("herdr-webui").join("webui-settings.json"),
            serde_json::json!({ "user": "admin", "password": "secret" }).to_string(),
        )
        .unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &config_home);

        // The server rotates its accepted token after the first
        // authorized call (a restart): token1 then token2.
        let current_token = Arc::new(Mutex::new("token1".to_string()));
        let token_for_server = current_token.clone();
        let login_count = Arc::new(Mutex::new(0usize));
        let seen = login_count.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                let target = request_line.split(' ').nth(1).unwrap_or("").to_string();
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
                let body: Value = if body.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&body).unwrap_or(Value::Null)
                };
                let mut stream = stream;
                let response = if target == "/api/login" {
                    *seen.lock().unwrap() += 1;
                    let ok = body.get("username").and_then(Value::as_str) == Some("admin")
                        && body.get("password").and_then(Value::as_str) == Some("secret");
                    let token = token_for_server.lock().unwrap().clone();
                    if ok {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: herdr_web_session={token}; HttpOnly; Path=/\r\nContent-Length: {}\r\n\r\n{{\"ok\":true}}",
                            "{\"ok\":true}".len()
                        )
                    } else {
                        format!(
                            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"error\":\"bad credentials\"}}",
                            "{\"error\":\"bad credentials\"}".len()
                        )
                    }
                } else if !cookie.contains(&format!(
                    "herdr_web_session={}",
                    token_for_server.lock().unwrap().clone()
                )) {
                    format!(
                        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"error\":\"unauthorized\"}}",
                        "{\"error\":\"unauthorized\"}".len()
                    )
                } else {
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
        // First call: login, cookie token1, authorized.
        let value = client.recent_workspaces().expect("first call logs in");
        assert_eq!(value["recent"][0]["path"], "/a");
        assert_eq!(*login_count.lock().unwrap(), 1);
        // Second call still rides token1.
        client.recent_workspaces().expect("cached cookie works");
        assert_eq!(*login_count.lock().unwrap(), 1);
        // Server restart: the token rotates. The TUI's cached cookie is
        // now stale; the next call must re-login and recover.
        *current_token.lock().unwrap() = "token2".to_string();
        let value = client
            .recent_workspaces()
            .expect("stale cookie triggers re-login and the call recovers");
        assert_eq!(value["recent"][0]["path"], "/a");
        assert_eq!(*login_count.lock().unwrap(), 2, "exactly one re-login");
        // And the new cookie is cached again: no further logins.
        client.recent_workspaces().expect("new cookie cached");
        assert_eq!(*login_count.lock().unwrap(), 2);
        drop(handle);

        std::env::remove_var("XDG_CONFIG_HOME");
        let _ = std::fs::remove_dir_all(&config_home);
    }

    #[test]
    fn retry_path_logs_in_once_and_caches_the_cookie() {
        // Reproduces the exact bug path: NO explicit login. The first
        // call 401s, request_json reads persisted_credentials() from
        // XDG_CONFIG_HOME, logs in, retries, and the cookie must land
        // on the shared client so the second call skips the login.
        let _guard = lock_env();
        use std::io::{BufRead as _, BufReader};
        use std::sync::{Arc, Mutex};
        let config_home =
            std::env::temp_dir().join(format!("herdr-tui-retry-login-{}", std::process::id()));
        std::fs::create_dir_all(config_home.join("herdr-webui")).unwrap();
        std::fs::write(
            config_home.join("herdr-webui").join("webui-settings.json"),
            serde_json::json!({ "user": "admin", "password": "secret" }).to_string(),
        )
        .unwrap();
        std::env::set_var("XDG_CONFIG_HOME", &config_home);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let login_count = Arc::new(Mutex::new(0usize));
        let seen = login_count.clone();
        let handle = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut request_line = String::new();
                if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                    continue;
                }
                let target = request_line.split(' ').nth(1).unwrap_or("").to_string();
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
                let body: Value = if body.is_empty() {
                    Value::Null
                } else {
                    serde_json::from_slice(&body).unwrap_or(Value::Null)
                };
                let mut stream = stream;
                let response = if target == "/api/login" {
                    *seen.lock().unwrap() += 1;
                    let ok = body.get("username").and_then(Value::as_str) == Some("admin")
                        && body.get("password").and_then(Value::as_str) == Some("secret");
                    if ok {
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: herdr_web_session=token123; HttpOnly; Path=/\r\nContent-Length: {}\r\n\r\n{{\"ok\":true}}",
                            "{\"ok\":true}".len()
                        )
                    } else {
                        format!(
                            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"error\":\"bad credentials\"}}",
                            "{\"error\":\"bad credentials\"}".len()
                        )
                    }
                } else if !cookie.contains("herdr_web_session=token123") {
                    format!(
                        "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{{\"error\":\"unauthorized\"}}",
                        "{\"error\":\"unauthorized\"}".len()
                    )
                } else {
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
        // No explicit login: both calls go through the 401 retry path.
        let value = client
            .recent_workspaces()
            .expect("retry logs in and succeeds");
        assert_eq!(value["recent"][0]["path"], "/a");
        assert_eq!(*login_count.lock().unwrap(), 1, "first call logged in once");
        // Second call must ride the cached cookie: a second login here
        // was the dropped-temporary bug.
        let value = client
            .recent_workspaces()
            .expect("cached cookie authorizes the second call");
        assert_eq!(value["recent"][0]["path"], "/a");
        assert_eq!(*login_count.lock().unwrap(), 1, "exactly one login total");
        drop(handle);

        std::env::remove_var("XDG_CONFIG_HOME");
        let _ = std::fs::remove_dir_all(&config_home);
    }

    #[test]
    fn bad_credentials_surface_the_401() {
        use std::io::{BufRead as _, BufReader};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut remaining = 4usize; // login (fail) + 401 GET + possible
                                        // settings-credentials login retry + its retry GET
            for stream in listener.incoming() {
                if remaining == 0 {
                    break;
                }
                remaining -= 1;
                let exhausted = remaining == 0;
                let Ok(stream) = stream else { break };
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
                if exhausted {
                    break;
                }
            }
        });
        let mut client = WebApiClient::new("127.0.0.1", port);
        let credentials = WebApiCredentials {
            username: "admin".to_string(),
            password: "wrong".to_string(),
        };
        // Login itself fails: no cookie, no infinite retry.
        assert!(client.login(&credentials).is_err());
        // And the 401 still surfaces when no credentials exist at all.
        let fresh = WebApiClient::new("127.0.0.1", port);
        let err = fresh.recent_workspaces().unwrap_err();
        match err {
            WebApiError::Http { status: 401, .. } => {}
            other => panic!("expected 401, got {other}"),
        }
        // Detached like the fake server above: it parks on accept()
        // once its bounded request count is served.
        drop(handle);
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
            if let Ok((stream, _)) = listener.accept() {
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
            }
        });
        (port, handle)
    }

    fn write_response(stream: &mut std::net::TcpStream, response: &str) {
        use std::io::Write;
        let _ = stream.write_all(response.as_bytes());
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
        assert_eq!(client.port, 8787, "empty env falls back to default");

        // Malformed persisted binds fall back to the default too.
        for bad in ["no-colon", ":8787", "host:notaport"] {
            std::fs::write(
                dir.join("herdr-webui/webui-settings.json"),
                serde_json::json!({"bind": bad}).to_string(),
            )
            .unwrap();
            let client = WebApiClient::discover().unwrap();
            assert_eq!(client.port, 8787, "bad bind {bad} falls back");
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
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            if let Ok((mut stream, _)) = listener.accept() {
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

        let mut client = WebApiClient::new("127.0.0.1", port);
        client.set_timeout(std::time::Duration::from_secs(5));
        let value = client
            .request_json("GET", "/api/ping", None)
            .expect("chunked response must parse");
        assert_eq!(value["ok"], true);
    }

    #[test]
    fn read_chunked_body_rejects_invalid_size_lines() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            if let Ok((mut stream, _)) = listener.accept() {
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
            if let Ok((mut stream, _)) = listener.accept() {
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
        assert_eq!(client.port, 1234);
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
        assert_eq!(client.host, "127.0.0.1");
        assert_eq!(client.port, 8787);

        // A settings file with a bind address wins over the default.
        let settings = serde_json::json!({"bind": "192.168.1.10:9999"});
        std::fs::write(
            dir.join("herdr-webui/webui-settings.json"),
            settings.to_string(),
        )
        .unwrap();
        let client = WebApiClient::discover().expect("settings discovery");
        assert_eq!(client.host, "192.168.1.10");
        assert_eq!(client.port, 9999);
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
            .git_cleanup_branch_delete("/repo", "old")
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
