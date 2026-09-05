(function () {
  // Shared Language Server Protocol client for the browser editor.
  // Talks to the Rust backend bridge at /api/lsp/* and keeps per-workspace
  // state: which servers are started, which documents are open, and the
  // latest diagnostics. Modeled on Zed's per-workspace language runtime.

  const DIAGNOSTICS_POLL_MS = 2000;
  const DID_CHANGE_DEBOUNCE_MS = 600;
  const MAX_DIAGNOSTICS = 200;

  const workspaces = new Map();
  let diagnosticsTimer = null;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function api(url, opt) {
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    let body = null;
    try {
      body = await res.json();
    } catch (_) {
      body = null;
    }
    if (!res.ok || (body && body.error)) {
      const error = Error((body && body.error) || res.statusText);
      error.status = res.status;
      error.details = body || {};
      throw error;
    }
    return body || {};
  }

  function post(url, payload) {
    return api(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
  }

  function workspaceFor(cwd) {
    const key = String(cwd || "");
    let ws = workspaces.get(key);
    if (!ws) {
      ws = {
        cwd: key,
        language: "",
        initialized: false,
        capabilities: null,
        documents: new Map(), // uri -> relative path
        diagnostics: new Map(),
        docVersions: new Map(), // uri -> current textDocument.version
        changeTimers: new Map(),
      };
      workspaces.set(key, ws);
    }
    return ws;
  }

  function languageFor(path) {
    if (!path) return "";
    const ext = path.split(".").pop().toLowerCase();
    const map = {
      json: "json",
      yml: "yaml",
      yaml: "yaml",
      ts: "typescript",
      mts: "typescript",
      cts: "typescript",
      tsx: "typescript",
      js: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      jsx: "javascript",
      rs: "rust",
      py: "python",
      pyi: "python",
      css: "css",
      scss: "css",
      less: "css",
      html: "html",
      htm: "html",
      md: "markdown",
      markdown: "markdown",
      go: "go",
      java: "java",
    };
    return map[ext] || "";
  }

  async function getConfig() {
    return api("/api/lsp/config");
  }

  async function updateConfig(settings) {
    return post("/api/lsp/config", { settings });
  }

  async function detect() {
    const body = await api("/api/lsp/detect");
    return body.servers || [];
  }

  async function status() {
    const body = await api("/api/lsp/status");
    return body.servers || [];
  }

  function serverRunning(ws, language) {
    return !!(ws.capabilities && ws.language === language);
  }

  // Start the language server for a workspace and initialize it.
  async function ensureServer(ws, language) {
    if (!language || serverRunning(ws, language)) return ws.capabilities;
    try {
      const startBody = await post("/api/lsp/start", { language, cwd: ws.cwd });
      if (!startBody.ok) return null;
      const languageId = language === "javascript" || language === "typescript"
        ? "typescript"
        : language;
      const init = await post("/api/lsp/request", {
        language: languageId,
        cwd: ws.cwd,
        method: "initialize",
        params: {
          processId: null,
          rootUri: "file://" + ws.cwd,
          capabilities: {
            textDocument: {
              synchronization: { didSave: true },
              hover: { contentFormat: ["plaintext", "markdown"] },
              completion: {
                completionItem: { snippetSupport: false, documentationFormat: ["plaintext", "markdown"] },
              },
              publishDiagnostics: { relatedInformation: false },
            },
            workspace: { workspaceFolders: false, configuration: false },
          },
          workspaceFolders: null,
        },
      });
      ws.capabilities = (init && init.result && init.result.capabilities) || {};
      ws.language = language;
      ws.initialized = true;
      await post("/api/lsp/notify", {
        language: languageId,
        cwd: ws.cwd,
        method: "initialized",
        params: {},
      });
    } catch (err) {
      ws.capabilities = null;
      ws.language = "";
      throw err;
    }
    return ws.capabilities;
  }

  function fileUri(ws, path) {
    const abs = path && path.startsWith("/") ? path : ws.cwd.replace(/\/$/, "") + "/" + String(path || "").replace(/^\//, "");
    return "file://" + abs;
  }

  async function didOpen(ws, path, content) {
    const language = languageFor(path);
    if (!language) return;
    try {
      await ensureServer(ws, language);
    } catch (_) {
      return;
    }
    const languageId = language === "javascript" ? "typescript" : language;
    const uri = fileUri(ws, path);
    ws.documents.set(uri, path);
    ws.docVersions.set(uri, 1); // didOpen starts every document at version 1
    await post("/api/lsp/notify", {
      language: languageId,
      cwd: ws.cwd,
      method: "textDocument/didOpen",
      params: {
        textDocument: {
          uri,
          languageId: language,
          version: 1,
          text: String(content == null ? "" : content),
        },
      },
    }).catch(() => {});
    startDiagnosticsPolling();
  }

  function didChange(ws, path, content) {
    const uri = fileUri(ws, path);
    if (!ws.documents.has(uri)) return;
    const language = languageFor(path);
    const languageId = language === "javascript" ? "typescript" : language;
    clearTimeout(ws.changeTimers.get(uri));
    // Language servers drop didChange notifications whose version is not
    // strictly greater than the document's current version (LSP spec), so
    // track the version per document: first change after didOpen is 2.
    const version = (ws.docVersions.get(uri) || 1) + 1;
    ws.docVersions.set(uri, version);
    ws.changeTimers.set(
      uri,
      setTimeout(() => {
        ws.changeTimers.delete(uri);
        post("/api/lsp/notify", {
          language: languageId,
          cwd: ws.cwd,
          method: "textDocument/didChange",
          params: {
            textDocument: { uri, version },
            contentChanges: [{ text: String(content == null ? "" : content) }],
          },
        }).catch(() => {});
      }, DID_CHANGE_DEBOUNCE_MS),
    );
  }

  async function didClose(ws, path) {
    const uri = fileUri(ws, path);
    if (!ws.documents.has(uri)) return;
    ws.documents.delete(uri);
    ws.diagnostics.delete(uri);
    ws.docVersions.delete(uri);
    clearTimeout(ws.changeTimers.get(uri));
    ws.changeTimers.delete(uri);
    const language = languageFor(path);
    const languageId = language === "javascript" ? "typescript" : language;
    await post("/api/lsp/notify", {
      language: languageId,
      cwd: ws.cwd,
      method: "textDocument/didClose",
      params: { textDocument: { uri } },
    }).catch(() => {});
  }

  async function request(ws, path, method, params) {
    const language = languageFor(path);
    if (!language) return null;
    const languageId = language === "javascript" ? "typescript" : language;
    try {
      const body = await post("/api/lsp/request", Object.assign({
        language: languageId,
        cwd: ws.cwd,
        method,
      }, params ? { params } : {}));
      return body && body.result !== undefined ? body.result : null;
    } catch (_) {
      return null;
    }
  }

  async function hover(ws, path, line, character) {
    return request(ws, path, "textDocument/hover", {
      textDocument: { uri: fileUri(ws, path) },
      position: { line, character },
    });
  }

  async function completion(ws, path, line, character) {
    return request(ws, path, "textDocument/completion", {
      textDocument: { uri: fileUri(ws, path) },
      position: { line, character },
    });
  }

  async function definition(ws, path, line, character) {
    return request(ws, path, "textDocument/definition", {
      textDocument: { uri: fileUri(ws, path) },
      position: { line, character },
    });
  }

  async function formatting(ws, path) {
    return request(ws, path, "textDocument/formatting", {
      textDocument: { uri: fileUri(ws, path) },
      options: { tabSize: 2, insertSpaces: true },
    });
  }

  async function documentSymbols(ws, path) {
    return request(ws, path, "textDocument/documentSymbol", {
      textDocument: { uri: fileUri(ws, path) },
    });
  }

  function startDiagnosticsPolling() {
    if (diagnosticsTimer != null) return;
    diagnosticsTimer = setInterval(async () => {
      let anyDocuments = false;
      for (const ws of workspaces.values()) {
        if (ws.documents.size) anyDocuments = true;
      }
      if (!anyDocuments) {
        clearInterval(diagnosticsTimer);
        diagnosticsTimer = null;
        return;
      }
      try {
        const body = await api("/api/lsp/notifications");
        applyNotifications(body.notifications || []);
      } catch (_) {
        // Server unreachable; keep polling while documents stay open.
      }
    }, DIAGNOSTICS_POLL_MS);
  }

  function applyNotifications(notifications) {
    for (const message of notifications) {
      if (!message || message.method !== "textDocument/publishDiagnostics") continue;
      const params = message.params || {};
      const uri = params.uri || "";
      if (!uri) continue;
      const ws = workspaceForUri(uri);
      if (!ws) continue;
      const diagnostics = (params.diagnostics || []).slice(0, MAX_DIAGNOSTICS);
      const changed = JSON.stringify(diagnostics) !== JSON.stringify(ws.diagnostics.get(uri));
      if (!diagnostics.length) {
        ws.diagnostics.delete(uri);
      } else {
        ws.diagnostics.set(uri, diagnostics);
      }
      if (changed && typeof window.HerdrLspHooks !== "undefined") {
        for (const hook of window.HerdrLspHooks) {
          try {
            hook(ws, uri, diagnostics);
          } catch (_) {}
        }
      }
    }
  }

  function workspaceForUri(uri) {
    const path = uri.replace(/^file:\/\//, "");
    for (const ws of workspaces.values()) {
      const prefix = ws.cwd.replace(/\/$/, "") + "/";
      if (path.startsWith(prefix) || ws.documents.has(uri)) return ws;
    }
    return null;
  }

  function diagnosticsFor(ws, path) {
    const uri = fileUri(ws, path);
    return ws.diagnostics.get(uri) || [];
  }

  async function stopServer(language, cwd) {
    await post("/api/lsp/stop", { language, cwd }).catch(() => {});
  }

  window.HerdrLsp = {
    languageFor,
    workspaceFor,
    getConfig,
    updateConfig,
    detect,
    status,
    ensureServer,
    didOpen,
    didChange,
    didClose,
    hover,
    completion,
    definition,
    formatting,
    documentSymbols,
    diagnosticsFor,
    stopServer,
  };
})();