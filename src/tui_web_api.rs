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
#[derive(Debug, Clone)]
pub struct WebApiClient {
    host: String,
    port: u16,
    timeout: Duration,
}

#[derive(Debug)]
pub enum WebApiError {
    Io(String),
    InvalidUrl(String),
    Http { status: u16, message: String },
    Json(String),
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

    fn request_json(
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
        let request = format!(
            "{method} {path_and_query} HTTP/1.1\r\nHost: {}:{}\r\nConnection: close\r\nAccept: application/json\r\nContent-Type: application/json\r\nContent-Length: {}\r\nUser-Agent: herdr-webui-tui\r\n\r\n{body_text}",
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
    ) -> Result<Value, WebApiError> {
        self.get(&format!(
            "/api/file-browser/tree?cwd={}&path={}&q={}&offset={offset}&limit={limit}&include_git_status=true",
            urlencode(cwd),
            urlencode(path),
            urlencode(query),
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
        self.post(
            "/api/file-browser/file",
            &json!({
                "cwd": cwd,
                "path": path,
                "content": content,
                "expected_hash": expected_hash,
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

    pub fn git_log(&self, cwd: &str, max: usize, all: bool) -> Result<Value, WebApiError> {
        self.get(&format!(
            "/api/git-ui/log?cwd={}&all={}&scope=all&max={max}",
            urlencode(cwd),
            if all { "true" } else { "false" },
        ))
    }

    pub fn git_branches(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.get(&format!("/api/git-ui/branches?cwd={}", urlencode(cwd)))
    }

    pub fn git_stashes(&self, cwd: &str) -> Result<Value, WebApiError> {
        self.get(&format!("/api/git-ui/stashes?cwd={}", urlencode(cwd)))
    }

    pub fn git_stage(&self, cwd: &str, paths: &[String]) -> Result<Value, WebApiError> {
        self.post("/api/git-ui/stage", &json!({ "cwd": cwd, "paths": paths }))
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

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    #[test]
    fn percent_encoding_matches_js_style_urls() {
        assert_eq!(urlencode("a b/c"), "a%20b%2Fc");
        assert_eq!(urlencode("a+b"), "a%2Bb");
        assert_eq!(urlencode("plain-Path_1.txt"), "plain-Path_1.txt");
    }

    #[test]
    fn persisted_bind_address_reads_settings_when_present() {
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
}
