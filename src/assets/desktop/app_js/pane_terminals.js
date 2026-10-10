// Auxiliary terminal surfaces for split panes. The desktop shell keeps
// one primary surface (#terminalShell + one term + one attach socket)
// owned by a single leaf, so a split with two terminal panels rendered
// only the owner's content and left the sibling slot blank. Each panel
// is a distinct backend pty though, and the attach hub already fans one
// backend attach out to every browser socket, so a non-owner leaf can
// host its own small surface: own wterm instance, own /ws/terminal
// socket, frames written straight through. The registry keys surfaces
// by workspace+tab and disposes entries whose leaf stopped rendering,
// whose tab moved to the owner (the primary shell takes over), or
// whose workspace switched (terminals behind repeated tab ids differ).

(function () {
  // key -> { key, tabId, terminalId, container, term, ws }
  const surfaces = new Map();
  const inputEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

  function tabKey(tabId) {
    return `${state.ws || "__default__"}|${tabId}`;
  }

  function wsUrlFor(path) {
    if (typeof wsUrl === "function") return wsUrl(path);
    const params = [];
    if (state.session && state.session !== "default")
      params.push("session=" + encodeURIComponent(state.session));
    if (typeof currentSessionBackend === "function" && currentSessionBackend())
      params.push("backend=" + encodeURIComponent(currentSessionBackend()));
    const suffix = params.length
      ? (path.includes("?") ? "&" : "?") + params.join("&")
      : "";
    return (
      (location.protocol === "https:" ? "wss://" : "ws://") +
      location.host +
      path +
      suffix
    );
  }

  function terminalIdForTab(tabId) {
    const panes = state.panes || [];
    const focused = panes.find((p) => p.tab_id === tabId && p.focused);
    const any = focused || panes.find((p) => p.tab_id === tabId);
    return any ? any.terminal_id : null;
  }

  // Grid from the slot's box: the aux surface has no resize renegotiation
  // with the backend, so it renders at whatever grid fits the leaf and
  // scrolls. Backspaces and full-screen apps still work; they just see a
  // smaller pty than the primary surface when the divider sits elsewhere.
  function gridSizeFor(container) {
    const width = (container && container.clientWidth) || 400;
    const height = (container && container.clientHeight) || 300;
    const cell = window.HerdrTerminalFit && window.HerdrTerminalFit.cellSize
      ? window.HerdrTerminalFit.cellSize(null, container, { width: 9, height: 20 })
      : { width: 9, height: 20 };
    const cols = Math.max(20, Math.min(400, Math.floor(width / (cell.width || 9))));
    const rows = Math.max(6, Math.min(160, Math.floor(height / (cell.height || 20))));
    return { cols, rows };
  }

  function dispose(entry) {
    if (!entry) return;
    try {
      if (entry.ws) {
        entry.ws.onclose = null;
        entry.ws.onmessage = null;
        entry.ws.close();
      }
    } catch (e) {}
    try {
      if (entry.term && typeof entry.term.dispose === "function") entry.term.dispose();
    } catch (e) {}
    try {
      if (entry.container && entry.container.remove) entry.container.remove();
      else if (entry.container && entry.container.parentNode)
        entry.container.parentNode.removeChild(entry.container);
    } catch (e) {}
    if (surfaces.get(entry.key) === entry) surfaces.delete(entry.key);
  }

  async function createSurface(pane, leaf, activeTab) {
    const renderer = window.HerdrTerminalRenderer;
    if (!renderer || typeof renderer.create !== "function") return null;
    const content = pane.querySelector(".pane-content");
    if (!content) return null;
    const terminalId = terminalIdForTab(activeTab);
    if (!terminalId) return null;
    const key = tabKey(activeTab);
    const container = document.createElement("div");
    container.className = "pane-terminal-aux";
    container.dataset.paneId = leaf.paneId || "";
    container.dataset.tabId = activeTab;
    content.appendChild(container);
    const size = gridSizeFor(container);
    // Placeholder entry first: onData resolves the socket through it, so
    // early keystrokes queue on the entry even before the socket exists.
    const entry = { key, tabId: activeTab, terminalId, container, term: null, ws: null };
    surfaces.set(key, entry);
    const sendInput = (data) => {
      if (!data || !entry.ws || entry.ws.readyState !== 1) return;
      if (globalThis.HerdrAppHelpers && globalThis.HerdrAppHelpers.stripTerminalMouseReports)
        data = globalThis.HerdrAppHelpers.stripTerminalMouseReports(
          data,
          options.terminalMouseReporting === true,
        );
      if (!data) return;
      try {
        entry.ws.send(inputEncoder ? inputEncoder.encode(data) : data);
      } catch (e) {}
    };
    let term = null;
    try {
      term = await renderer.create(container, {
        cols: size.cols,
        rows: size.rows,
        core: options.terminalCore,
        theme: typeof terminalTheme === "function" ? terminalTheme() : {},
        fontFamily: typeof terminalFontFamily === "function" ? terminalFontFamily() : "monospace",
        fontSize: options.terminalFontSize || 14,
        links: options.terminalLinks !== false,
        scrollback: 4000,
        onData: sendInput,
      });
    } catch (e) {
      dispose(entry);
      return null;
    }
    // The leaf may have re-rendered while the async create ran (split
    // flip, close): the registry entry must still be ours and the pane
    // element still must host our container.
    if (surfaces.get(key) !== entry || container.parentElement !== content) {
      dispose(entry);
      return null;
    }
    entry.term = term;
    const ws = new WebSocket(
      wsUrlFor(
        `/ws/terminal?terminal_id=${encodeURIComponent(terminalId)}&cols=${size.cols}&rows=${size.rows}`,
      ),
    );
    entry.ws = ws;
    ws.binaryType = "arraybuffer";
    ws.onmessage = (e) => {
      if (entry.ws !== ws) return;
      if (typeof e.data === "string" && e.data.indexOf("herdr_error") !== -1) {
        // Structured attach errors carry no render payload for an aux
        // surface; drop the socket so the next render pass retries.
        try { ws.close(); } catch (err) {}
        return;
      }
      try {
        term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
      } catch (err) {}
    };
    ws.onclose = () => {
      if (entry.ws === ws) {
        entry.ws = null;
        entry.closedAt = Date.now();
      }
    };
    return entry;
  }

  function ensureForLeaf(pane, leaf) {
    const activeTab = leaf && leaf.active;
    if (!activeTab) return null;
    if (typeof isEditorTab === "function" && isEditorTab(activeTab)) return null;
    if (typeof isGitTab === "function" && isGitTab(activeTab)) return null;
    if (
      activeTab ===
      (typeof TERMINAL_TAB_PLACEHOLDER !== "undefined" ? TERMINAL_TAB_PLACEHOLDER : "__terminal__")
    )
      return null;
    const existing = surfaces.get(tabKey(activeTab));
    if (existing) {
      // Reuse, with one bounded retry: a surface whose socket died
      // (backend outage, stall close) must not freeze the pane silently,
      // but recreating on every render pass would churn sockets at poll
      // cadence. Wait out the backoff window, then rebuild once more.
      if (
        !existing.ws &&
        existing.term &&
        existing.closedAt &&
        Date.now() - existing.closedAt > 4000
      ) {
        dispose(existing);
        return createSurface(pane, leaf, activeTab);
      }
      // Re-parent into this leaf's slot if a reshape moved it (rescue
      // parks surfaces in #workspacePanes hidden). Un-hide either way.
      const content = pane.querySelector(".pane-content");
      if (content) {
        if (existing.container.parentElement !== content) content.appendChild(existing.container);
        if (existing.container.style) existing.container.style.display = "";
      }
      existing.container.dataset.paneId = leaf.paneId || "";
      return existing;
    }
    return createSurface(pane, leaf, activeTab);
  }

  function fitAll() {
    for (const [, entry] of surfaces) {
      if (!entry.term || !entry.container) continue;
      const size = gridSizeFor(entry.container);
      try {
        entry.term.resize(size.cols, size.rows);
      } catch (e) {}
    }
  }

  // Re-theme open aux surfaces on theme switch. Panes are the
  // replacement for the old temp-terminal modal, so the desktop
  // parity promise (open terminals recolor without a restart)
  // must cover them, not only the primary shell.
  function applyThemeAll() {
    const theme = typeof terminalTheme === "function" ? terminalTheme() : {};
    for (const [, entry] of surfaces) {
      if (entry.term && entry.term.setTheme) {
        try {
          entry.term.setTheme(theme);
        } catch (e) {}
      }
    }
  }

  function releaseForTab(tabId) {
    dispose(surfaces.get(tabKey(tabId)));
  }

  // Drop every surface whose tab is not in the rendered keep set (leaf
  // closed or promoted, tab moved to the owner leaf). Called at the end
  // of every pane render with the still-on-screen tab ids.
  function releaseStale(renderedTabIds) {
    const keep = new Set(renderedTabIds.map((tabId) => tabKey(tabId)));
    for (const [key, entry] of [...surfaces]) {
      if (!keep.has(key)) dispose(entry);
    }
  }

  function releaseAll() {
    for (const [, entry] of [...surfaces]) dispose(entry);
  }

  window.HerdrPaneTerminals = {
    ensureForLeaf,
    releaseForTab,
    releaseStale,
    releaseAll,
    fitAll,
    applyThemeAll,
    count: () => surfaces.size,
    tabKey,
  };
})();
