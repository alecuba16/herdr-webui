(function () {
  // Mobile core delegates the escape helpers and the per-session storage
  // helpers to the shared core (HerdrAppHelpers): both bundles concat the
  // shared file first (see assets.rs / app_boot.js load order), so the local
  // copies here were byte-level duplicates of shared/core.js.
  const shared = globalThis.HerdrAppHelpers || {};
  const escapeHtml = shared.escapeHtml
    ? shared.escapeHtml
    : (value) => String(value == null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
  const pathBasename = shared.pathBasename
    ? shared.pathBasename
    : (path) => {
        const parts = String(path || "").split("/").filter(Boolean);
        return parts[parts.length - 1] || String(path || "");
      };
  const sessionBackendKey = shared.sessionBackendKey
    ? shared.sessionBackendKey
    : (session) => "herdr-session-backend:" + (session || "default");
  const sessionStateKey = shared.sessionStateKey
    ? shared.sessionStateKey
    : (backend, session) =>
        "herdr-session-state:" + (backend || "builtin") + ":" + (session || "default");
  const readSessionBackend = shared.readSessionBackend
    ? shared.readSessionBackend
    : () => "builtin";
  const writeSessionBackend = shared.writeSessionBackend
    ? shared.writeSessionBackend
    : () => {};
  const forgetSessionState = shared.forgetSessionState
    ? shared.forgetSessionState
    : () => {};
  const saveSessionSelection = shared.saveSessionSelection
    ? shared.saveSessionSelection
    : () => {};
  const readSessionSelection = shared.readSessionSelection
    ? shared.readSessionSelection
    : () => null;

  function jsArg(value) {
    return escapeHtml(JSON.stringify(String(value == null ? "" : value)));
  }

  // Android/iOS keyboard guards: without these, Gboard grammar checker,
  // autocorrect, and text suggestions rewrite terminal commands, branch
  // names, and paths typed into mobile inputs. `writingsuggestions="false"`
  // is the attribute Gboard's writing/grammar layer respects on Android;
  // `autocapitalize="none"` (not "off") is the valid value for iOS/Safari;
  // `autocorrect="off"` is the iOS-specific spell-replace switch;
  // `spellcheck="false"` kills the red squiggles + browser replace on
  // desktop and Android Chrome; `autocomplete="off"` stops suggestions
  // from the browser's own dictionary.
  function inputAttrs(enterkeyhint) {
    const attrs =
      ' autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" writingsuggestions="false" translate="no"';
    return enterkeyhint
      ? attrs + ` enterkeyhint="${escapeHtml(enterkeyhint)}"`
      : attrs;
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

  function sameScopedId(ws, left, right) {
    if (left == null || right == null) return left === right;
    return compactScopedId(ws, String(left)) === compactScopedId(ws, String(right));
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

  function samePath(a, b) {
    return (
      String(a || "").replace(/\/+$/, "") ===
      String(b || "").replace(/\/+$/, "")
    );
  }

  function createTerminalInputGate() {
    // wterm owns the hidden textarea and IME lifecycle. Keep it inactive until
    // the user taps the terminal, then let wterm handle all text and control
    // keys directly.
    let enabled = false;
    const gate = () => !enabled;
    gate.enable = () => { enabled = true; };
    return gate;
  }

  globalThis.HerdrMobileCore = {
    compactScopedId,
    createTerminalInputGate,
    escapeHtml,
    forgetSessionState,
    inputAttrs,
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
    sameScopedId,
    sessionStateKey,
    writeSessionBackend,
  };
})();
