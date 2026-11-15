// Auxiliary terminal surfaces for split panes. The desktop shell keeps
// one primary surface (#terminalShell + one term + one attach socket)
// owned by a single leaf, so a split with two terminal panels rendered
// only the owner's content and left the sibling slot blank. Each panel
// is a distinct backend pty though, and the attach hub already fans one
// backend attach out to every browser socket, so a non-owner leaf can
// host its own small surface: own wterm instance, own /ws/terminal
// socket, frames written straight through.
//
// The registry is a session-scoped cache (D8), keyed by tab id. A leaf
// stopping rendering (maximize, editor stint, tab moved to the owner)
// parks its surface hidden with the socket detached (no sockets for
// non-visible surfaces) instead of destroying it, so scrollback and
// the wterm instance survive the flip back and a re-attach replays the
// view. Only a closed tab disposes for real, plus cap eviction
// (least-recently-focused first).

(function () {
  // key -> { key, tabId, terminalId, container, term, ws, lastFocusedAt }
  const surfaces = new Map();
  const inputEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

  // Rendered aux surfaces cost one live WS plus a hub replay ring plus a
  // fan-out slot each, so tmux pane counts do not apply. Eight aux
  // surfaces on top of the singleton owner is beyond any sane visible
  // layout; parked entries count too because each keeps a wterm
  // instance and its scrollback buffer in memory.
  const AUX_SURFACE_CAP = 8;
  // A surface whose socket died while visible (backend outage, stall
  // close) waits out this window before the next render pass re-attaches;
  // below the window the wait keeps a down backend from churning sockets
  // at poll cadence.
  const SOCKET_RETRY_BACKOFF_MS = 4000;

  function tabKey(tabId) {
    // Session-global tree: the key is the tab id alone. The old
    // workspace|tab keying broke the mixed tree: a foreign workspace's
    // tab would collide with a same-id local tab across keys, and the
    // registry could never tell which surface a leaf was re-rendering.
    // Builtin backend ids come from one global counter (next_id in
    // builtin_backend.rs), unique across workspaces; the external
    // backend's ids come from the daemon's own generator.
    return `${tabId}`;
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
    // Session-global tree: resolve from every pane row the snapshot
    // ships (state.panes is workspace-filtered, panesById carries the
    // rest). One row names the terminal either way.
    const panes = state.panes || [];
    const focused = panes.find((p) => p.tab_id === tabId && p.focused);
    const any = focused || panes.find((p) => p.tab_id === tabId);
    if (any) return any.terminal_id;
    const mapRows = (state.panesById && state.panesById[tabId]) || [];
    const mapFocused = mapRows.find((p) => p && p.focused);
    const mapAny = mapFocused || mapRows[0];
    return mapAny ? mapAny.terminal_id : null;
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
    entry.disposed = true;
    const pending = ptyResizeTimers.get(entry.key);
    if (pending) {
      clearTimeout(pending);
      ptyResizeTimers.delete(entry.key);
    }
    try {
      if (entry.observer && typeof entry.observer.disconnect === "function")
        entry.observer.disconnect();
    } catch (e) {}
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
    surfaces.delete(entry.key);
  }

  // D8: a leaf that stopped rendering this tab parks its surface instead
  // of disposing it. Parked means hidden, out of the pane slots, and its
  // socket detached (no sockets for non-visible surfaces: the hub replay
  // ring rehydrates the view when the tab returns). The wterm instance
  // stays, so scrollback survives a maximize, an editor stint, or an
  // owner flip. Only a closed tab or cap eviction disposes.
  function park(entry) {
    if (!entry) return;
    // Recording focus order on park: lastFocusedAt drives LRU eviction,
    // so every exit from a pane slot must touch it or the order rots.
    entry.lastFocusedAt = Date.now();
    if (entry.observer && typeof entry.observer.disconnect === "function") {
      try { entry.observer.disconnect(); } catch (e) {}
      entry.observer = null;
    }
    detachSocket(entry);
    if (entry.term && typeof entry.term.setRenderingPaused === "function") {
      try { entry.term.setRenderingPaused(true); } catch (e) {}
    }
    const home = document.getElementById("workspacePanes");
    if (home) {
      if (entry.container.parentElement !== home) home.appendChild(entry.container);
      if (entry.container.style) entry.container.style.display = "none";
    } else if (entry.container.parentNode) {
      entry.container.parentNode.removeChild(entry.container);
    }
    entry.container.dataset.paneId = "";
  }

  // D8 socket rule: no sockets for non-visible surfaces. Detaching
  // drops the hub replay ring and the fan-out slot a parked surface
  // would otherwise hold; re-attach replays the scrollback back into
  // the same wterm instance, so nothing visible is lost.
  function detachSocket(entry) {
    if (!entry || !entry.ws) return;
    const ws = entry.ws;
    entry.ws = null;
    try {
      ws.onclose = null;
      ws.onmessage = null;
      ws.close();
    } catch (e) {}
  }

  // Visibility pause for aux surfaces: not intersecting means not
  // visible, wterm buffers the frames, one repaint when the leaf shows
  // again. Parked surfaces pause explicitly in park(); this observer
  // covers a surface still attached but covered by an overlay (a
  // blocking dialog over the pane area). The callback checks the
  // disposed flag because the initial visibility report can land after
  // the surface was torn down.
  function watchVisibility(entry, container) {
    if (typeof IntersectionObserver !== "function") return null;
    const observer = new IntersectionObserver((entries) => {
      if (entry.disposed || !entry.term) return;
      const io = entries.find((candidate) => candidate.target === container);
      const paused = !io || !io.isIntersecting;
      if (typeof entry.term.setRenderingPaused === "function")
        entry.term.setRenderingPaused(paused);
    });
    observer.observe(container);
    // The observer's first report is async: a surface that mounts already
    // hidden (rescued into #workspacePanes before its first paint) would
    // render one frame unpauseed. offsetParent is null for display:none
    // subtrees, so it covers the parking case synchronously; a live
    // surface leaves rendering on and the first report confirms it.
    if (
      entry.term &&
      typeof entry.term.setRenderingPaused === "function" &&
      container.offsetParent === null
    ) {
      entry.term.setRenderingPaused(true);
    }
    return observer;
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
    const entry = { key, tabId: activeTab, terminalId, container, term: null, ws: null, lastFocusedAt: Date.now() };
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
        // Same reporting gate as the primary surface: without the option the
        // adapter disables wterm's mouse interception so split-pane output
        // stays selectable (sendInput strips the bytes otherwise).
        mouseReporting: options.terminalMouseReporting === true,
        scrollback: 4000,
        onData: sendInput,
        // Wheel parity with the primary surface: split panes hosting an
        // SGR-tracking TUI (jcode, tmux `mouse on`) otherwise have a dead
        // wheel, the same bug terminal.js fixed for the main surface.
        onWheelMouseReport: (report) => sendInput(report),
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
    entry.observer = watchVisibility(entry, container);
    // Input follows focus for aux surfaces too: a click inside this
    // terminal must give its wterm the DOM focus (typing lands here, not
    // in the primary shell behind it). attachClickFocus keeps native text
    // selection working: the focus call only fires on a real click, not
    // on a selection drag, same contract as the primary shell's focus.
    if (renderer.attachClickFocus && typeof term.focus === "function") {
      renderer.attachClickFocus(container, () => {
        if (entry.disposed || entry.term !== term) return;
        entry.lastFocusedAt = Date.now();
        try { term.focus(); } catch (e) {}
      });
    }
    attachSocket(entry);
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
      // A cached entry (parked or live) coming back: re-parent into
      // this leaf's slot, un-hide, un-pause, re-observe, re-attach.
      // The dead-socket backoff lives inside entryBackToLeaf so every
      // visible render pass converges on the same decision.
      entryBackToLeaf(existing, pane, leaf);
      return existing;
    }
    return createSurface(pane, leaf, activeTab);
  }

  // Attach (or re-attach) the entry's /ws/terminal socket. Frames
  // write straight through into the wterm instance; the server's
  // replay rehydrates the view after a park detached the socket.
  function attachSocket(entry) {
    // A create still awaiting its wterm instance attaches from its own
    // tail; a socket before the term exists would drop early frames.
    if (!entry.term) return null;
    if (entry.ws) return entry.ws;
    const ws = new WebSocket(
      wsUrlFor(
        `/ws/terminal?terminal_id=${encodeURIComponent(entry.terminalId)}&cols=${gridSizeFor(entry.container).cols}&rows=${gridSizeFor(entry.container).rows}`,
      ),
    );
    entry.ws = ws;
    // A fresh socket clears the death mark: a later park+return must
    // re-attach immediately, not wait out this socket's old backoff.
    entry.closedAt = null;
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
        entry.term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
      } catch (err) {}
    };
    ws.onclose = () => {
      if (entry.ws === ws) {
        entry.ws = null;
        entry.closedAt = Date.now();
      }
    };
    return ws;
  }

  function entryBackToLeaf(entry, pane, leaf) {
    const content = pane.querySelector(".pane-content");
    if (content) {
      if (entry.container.parentElement !== content) content.appendChild(entry.container);
      if (entry.container.style) entry.container.style.display = "";
    }
    entry.container.dataset.paneId = leaf.paneId || "";
    entry.lastFocusedAt = Date.now();
    // Parked surfaces lost their socket by design (no sockets for
    // non-visible); a dead-while-visible socket carries closedAt. One
    // re-attach attempt per backoff window keeps a down backend from
    // churning sockets at render-pass cadence; the hub replay fills
    // the same wterm instance either way, scrollback intact.
    const deadWithinBackoff =
      entry.closedAt && Date.now() - entry.closedAt < SOCKET_RETRY_BACKOFF_MS;
    if (!deadWithinBackoff) attachSocket(entry);
    if (!entry.observer && entry.term && typeof IntersectionObserver === "function") {
      entry.observer = watchVisibility(entry, entry.container);
    }
    if (entry.term && typeof entry.term.setRenderingPaused === "function") {
      try { entry.term.setRenderingPaused(false); } catch (e) {}
    }
  }

  function fitAll() {
    for (const [, entry] of surfaces) {
      if (!entry.term || !entry.container) continue;
      // Parked containers sit display:none in #workspacePanes: their
      // box is empty, the fit would floor the grid to the minimum, and
      // entryBackToLeaf refits with real dimensions on the return.
      if (entry.container.dataset.paneId === "") continue;
      const size = gridSizeFor(entry.container);
      try {
        entry.term.resize(size.cols, size.rows);
      } catch (e) {}
      // D9 resize-in-place: the wterm grid change must reach the pty
      // too, or full-screen TUIs (vim, htop, agent TUIs) keep drawing the
      // pre-drag grid after a divider drag. The socket accepts the same
      // {type:"resize"} text message the primary surface sends
      // (terminal_text_messages maps it to ClientMessage::Resize).
      // Debounced: divider drags fire fitAll per pointerup and window
      // resizes fire bursts; the pty only needs the final grid.
      schedulePtyResize(entry, size.cols, size.rows);
    }
  }

  // One pending resize per entry; the trailing timer carries the latest
  // grid. A disposed entry cancels itself: the timer callback checks the
  // registry and the disposed flag before sending.
  const ptyResizeTimers = new Map();
  function schedulePtyResize(entry, cols, rows) {
    if (!entry || !entry.key) return;
    const pending = ptyResizeTimers.get(entry.key);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      ptyResizeTimers.delete(entry.key);
      if (entry.disposed) return;
      const ws = entry.ws;
      if (!ws || ws.readyState !== 1) return;
      try {
        ws.send(JSON.stringify({ type: "resize", cols, rows }));
      } catch (e) {}
    }, 200);
    ptyResizeTimers.set(entry.key, timer);
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

  // D8: park one tab's surface on demand (an owner flip or an editor
  // stint reclaims the slot but the tab stays open). No-op when the
  // tab has no surface.
  function parkForTab(tabId) {
    const entry = surfaces.get(tabKey(tabId));
    if (entry) park(entry);
  }

  // D8 cache lifecycle: a tab leaving the rendered set parks its surface
  // (socket detached, wterm and scrollback kept) instead of disposing it.
  // Real disposal stays on closeTab and cap eviction (LRF first).
  function releaseStale(renderedTabIds) {
    const keep = new Set(renderedTabIds.map((tabId) => tabKey(tabId)));
    for (const [key, entry] of [...surfaces]) {
      if (keep.has(key)) continue;
      park(entry);
    }
    evictBeyondCap();
  }

  // Cap eviction: beyond AUX_SURFACE_CAP entries, dispose
  // least-recently-focused first until back at cap. Parked entries
  // count: each holds a wterm instance plus its scrollback buffer.
  function evictBeyondCap() {
    if (surfaces.size <= AUX_SURFACE_CAP) return;
    const byFocus = [...surfaces.values()].sort(
      (a, b) => (a.lastFocusedAt || 0) - (b.lastFocusedAt || 0),
    );
    let over = surfaces.size - AUX_SURFACE_CAP;
    for (const entry of byFocus) {
      if (over <= 0) break;
      dispose(entry);
      over -= 1;
    }
  }

  function releaseAll() {
    for (const [, entry] of [...surfaces]) dispose(entry);
  }

  window.HerdrPaneTerminals = {
    ensureForLeaf,
    releaseForTab,
    parkForTab,
    releaseStale,
    releaseAll,
    fitAll,
    applyThemeAll,
    count: () => surfaces.size,
    parked: () => [...surfaces.values()].filter((entry) => entry.container.dataset.paneId === "").length,
    cap: () => AUX_SURFACE_CAP,
    evictBeyondCap,
    tabKey,
  };
})();
