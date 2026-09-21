(function () {
  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function jsArg(value) {
    return escapeHtml(JSON.stringify(String(value == null ? "" : value)));
  }

  function compactScopedId(ws, id) {
    if (!ws || !id) return id || null;
    const prefix = `${ws}:`;
    return id.startsWith(prefix) ? id.slice(prefix.length) : id;
  }

  function expandScopedId(ws, id) {
    if (!ws || !id) return id || null;
    return `${ws}:${id}`;
  }

  // Per-session storage keys (mobile parity with the desktop core helpers).
  // The backend pin used to be a single global `herdr-session-backend` value,
  // which leaked the last-used backend into every other session; each session
  // keeps its own pin now, and each session+backend pair keeps its own last
  // selection (workspace/tab/pane) so session rows restore the exact surface
  // the user left, per the no-auto-open-on-startup rule.
  function sessionBackendKey(session) {
    return "herdr-session-backend:" + (session || "default");
  }
  function sessionStateKey(backend, session) {
    return (
      "herdr-session-state:" + (backend || "builtin") + ":" + (session || "default")
    );
  }
  function readSessionBackend(session) {
    try {
      return localStorage.getItem(sessionBackendKey(session)) || "builtin";
    } catch (e) {
      return "builtin";
    }
  }
  function writeSessionBackend(session, backend) {
    try {
      localStorage.setItem(sessionBackendKey(session), backend || "builtin");
    } catch (e) {}
  }
  // Closed means closed: forget the stored backend pin and the saved
  // selections so no reopen path resurrects the closed surface.
  function forgetSessionState(session) {
    try {
      localStorage.removeItem(sessionBackendKey(session));
      localStorage.removeItem(sessionStateKey("builtin", session));
      localStorage.removeItem(sessionStateKey("external-herdr", session));
    } catch (e) {}
  }
  function saveSessionSelection(session, backend, { ws, tab, pane }) {
    try {
      localStorage.setItem(
        sessionStateKey(backend, session),
        JSON.stringify({ ws: ws || null, tab: tab || null, pane: pane || null }),
      );
    } catch (e) {}
  }
  function readSessionSelection(session, backend) {
    try {
      const raw = localStorage.getItem(sessionStateKey(backend, session));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      return { ws: parsed.ws || null, tab: parsed.tab || null, pane: parsed.pane || null };
    } catch (e) {
      return null;
    }
  }

  function sessionPrefix(session) {
    return "/session/" + encodeURIComponent(session || "default");
  }

  function selectionPath(session, ws, tab, pane) {
    let path = sessionPrefix(session) + "/workspace/" + encodeURIComponent(ws);
    if (tab) path += "/tab/" + encodeURIComponent(compactScopedId(ws, tab));
    if (pane) path += "/pane/" + encodeURIComponent(compactScopedId(ws, pane));
    return path;
  }

  function parseRoutePath(pathname) {
    const parts = String(pathname || "/")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    let index = 0;
    let session = "default";
    if (parts[0] === "session") {
      session = parts[1] || "default";
      index = 2;
    }
    const ws = parts[index] === "workspace" ? parts[index + 1] : null;
    return {
      session,
      ws,
      tab:
        parts[index + 2] === "tab"
          ? expandScopedId(ws, parts[index + 3])
          : null,
      pane:
        parts[index + 4] === "pane"
          ? expandScopedId(ws, parts[index + 5])
          : null,
    };
  }

  function pathBasename(path) {
    const parts = String(path || "")
      .replace(/\/+$/, "")
      .split("/")
      .filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function samePath(a, b) {
    return (
      String(a || "").replace(/\/+$/, "") ===
      String(b || "").replace(/\/+$/, "")
    );
  }

  globalThis.HerdrMobileCore = {
    compactScopedId,
    escapeHtml,
    forgetSessionState,
    jsArg,
    parseRoutePath,
    pathBasename,
    readSessionBackend,
    readSessionSelection,
    samePath,
    saveSessionSelection,
    selectionPath,
    sessionBackendKey,
    sessionPrefix,
    sessionStateKey,
    writeSessionBackend,
  };
})();
