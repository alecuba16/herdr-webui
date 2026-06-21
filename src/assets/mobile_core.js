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
    jsArg,
    parseRoutePath,
    pathBasename,
    samePath,
    selectionPath,
  };
})();
