(function () {
  function createMobileTerminal({ el, state, wsUrl, onHerdrError, onTerminalOutput, onConnectionState }) {
    let term = null,
      termWs = null,
      openedTerminalElement = null,
      connectedTerminalKey = "",
      connectedTerminalSize = "",
      terminalFollowPaused = false,
      terminalScrollBound = false,
      inputFlushTimer = null,
      inputQueue = [],
      writeQueue = [],
      writeFlushPending = false,
      terminalQueryReplyState = {},
      inputEncoder = new TextEncoder(),
      terminalAttachPending = false,
      terminalInputGate = null,
      terminalInputBound = false,
      pendingTerminalResize = null,
      terminalShellResizeObserver = null,
      observedTerminalShell = null,
      terminalShellResizeTimer = null,
      terminalWheelDeltaPixels = 0;

    const IMMEDIATE_WRITE_THRESHOLD = 8192;
    const LARGE_FRAME_THRESHOLD = 32768;

    // Reconnect backoff (desktop terminal.js parity, same constants): after
    // a failed attach (backend outage, herdr_error teardown), suppress the
    // teardown-and-reattach path until the backoff window elapses. Resize
    // frames during a drag would otherwise reattach at frame cadence
    // (~60/s), and each failure schedules a refresh burst that re-enters
    // connect(): the storm. A scheduled reconnect is already pending; the
    // success path resets the delay. Deliberate teardowns (navigation, tab
    // close) null onclose first, so they never count as failures.
    const TERMINAL_RECONNECT_BASE_MS = 500;
    const TERMINAL_RECONNECT_MAX_MS = 8000;
    let terminalReconnectNotBefore = 0;
    let terminalReconnectDelay = TERMINAL_RECONNECT_BASE_MS;
    let terminalReconnectTimer = null;
    // Target (session|ws|tab|pane|terminalId|core) whose attach failed:
    // the backoff only gates the SAME target. Navigating to a different
    // pane or tab must attach immediately (its backend may be alive).
    let terminalReconnectTarget = null;
    // Socket of the in-flight backoff-recovery attempt for the failed
    // target. While it exists and is still open/connecting, resize frames
    // must not tear it down and open a fresh one per frame.
    let terminalReconnectAttemptWs = null;

    // Monotonic-ish clock for the backoff window; Date.now() is a fine
    // fallback because only elapsed deltas matter.
    function terminalReconnectNow() {
      if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
        return performance.now();
      }
      return Date.now();
    }

    function terminalAttemptInFlight() {
      return !!(terminalReconnectAttemptWs && terminalReconnectAttemptWs.readyState <= 1);
    }

    function terminalAttachInBackoff(target) {
      return (
        (terminalReconnectNow() < terminalReconnectNotBefore || terminalAttemptInFlight()) &&
        terminalReconnectTarget === target
      );
    }

    // Schedules a connect attempt once the backoff window elapses, so
    // recovery does not depend on the next resize/poll event arriving.
    function scheduleTerminalReconnect() {
      if (terminalReconnectTimer) clearTimeout(terminalReconnectTimer);
      const delay = terminalReconnectDelay;
      terminalReconnectTimer = setTimeout(() => {
        terminalReconnectTimer = null;
        // Skip if an attempt for the failed target is still settling: its
        // own failure callback re-arms the timer.
        if (terminalReconnectTarget && !terminalAttemptInFlight()) {
          connect();
        }
      }, delay);
      terminalReconnectNotBefore = terminalReconnectNow() + delay;
      terminalReconnectDelay = Math.min(TERMINAL_RECONNECT_MAX_MS, terminalReconnectDelay * 2);
    }

    function noteTerminalAttachFailure(target) {
      terminalReconnectTarget = target;
      terminalReconnectAttemptWs = null;
      scheduleTerminalReconnect();
    }

    function noteTerminalAttachSuccess() {
      terminalReconnectTarget = null;
      terminalReconnectAttemptWs = null;
      terminalReconnectDelay = TERMINAL_RECONNECT_BASE_MS;
      if (terminalReconnectTimer) {
        clearTimeout(terminalReconnectTimer);
        terminalReconnectTimer = null;
      }
    }

    function setConnectionState(connecting) {
      state.terminalConnecting = !!connecting;
      if (typeof onConnectionState === "function") onConnectionState(!!connecting);
    }

    function options() {
      try {
        return globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
      } catch (_) {
        return {};
      }
    }

    function terminalFontFamily() {
      return globalThis.HerdrAppHelpers.resolveTerminalFontFamily(options().terminalFontFamily);
    }

    function terminalCore() {
      const parsed = options();
      return globalThis.HerdrAppHelpers.resolveTerminalCoreChoice(
        parsed.terminalCore,
        parsed.terminalCoreGhosttyMigrated === true,
      );
    }

    function applyFontFamily() {
      if (term && term.setFontFamily) term.setFontFamily(terminalFontFamily());
      scheduleTerminalShellResize();
    }

    function terminalFontSize() {
      const value = Number(options().terminalFontSize);
      // Mobile has less horizontal space than the desktop terminal. A 12px
      // default gives the shell several more columns without changing an
      // explicit stored preference.
      if (!Number.isFinite(value) || value <= 0) return 12;
      return Math.max(10, Math.min(22, Math.round(value)));
    }

    // Theme tokens (shared --term-* + body.light overrides) resolve fresh on
    // every call, so pushing the theme again is enough to recolor an open
    // terminal after a manual switch or a prefers-color-scheme change.
    function terminalTheme() {
      const light = document.body.classList.contains("light");
      const helpers = globalThis.HerdrAppHelpers || {};
      const colors = helpers.terminalThemeColors
        ? helpers.terminalThemeColors()
        : {};
      const theme = light ? colors.light || {} : colors.dark || {};
      // Merge the shared --term-* token palette so ANSI colors follow the
      // CSS palette (same helper the desktop uses).
      const tokenPalette = helpers.readTerminalThemeTokens
        ? helpers.readTerminalThemeTokens()
        : null;
      return {
        background: theme.background || (light ? "#ffffff" : "#1e1e2e"),
        foreground: theme.foreground || (light ? "#4c4f69" : "#cdd6f4"),
        cursor: theme.cursor || (light ? "#4c4f69" : "#cdd6f4"),
        selectionBackground: theme.selectionBackground || (light ? "#dce0f8" : "#45475a"),
        ...(tokenPalette || {}),
      };
    }

    function applyTheme() {
      if (term && term.setTheme) {
        try { term.setTheme(terminalTheme()); } catch (_) {}
      }
    }

    function terminalLinksEnabled() {
      return options().terminalLinks !== false;
    }

    function applyLinks() {
      if (term && term.setLinksEnabled) term.setLinksEnabled(terminalLinksEnabled());
    }

    function terminalMouseReportingEnabled() {
      return options().terminalMouseReporting === true;
    }

    function scheduleTerminalShellResize() {
      if (!term || !termWs || termWs.readyState !== 1) return;
      if (terminalShellResizeTimer) clearTimeout(terminalShellResizeTimer);
      terminalShellResizeTimer = setTimeout(() => {
        terminalShellResizeTimer = null;
        if (state.screen === "terminal") connect();
      }, 80);
    }

    function observeTerminalShell(shell) {
      if (!shell || observedTerminalShell === shell) return;
      if (terminalShellResizeObserver && terminalShellResizeObserver.disconnect)
        terminalShellResizeObserver.disconnect();
      terminalShellResizeObserver = null;
      observedTerminalShell = shell;
      if (typeof ResizeObserver !== "function") return;
      terminalShellResizeObserver = new ResizeObserver(() => scheduleTerminalShellResize());
      terminalShellResizeObserver.observe(shell);
    }

    function clearTerminalShellObserver() {
      if (terminalShellResizeTimer) {
        clearTimeout(terminalShellResizeTimer);
        terminalShellResizeTimer = null;
      }
      if (terminalShellResizeObserver && terminalShellResizeObserver.disconnect)
        terminalShellResizeObserver.disconnect();
      terminalShellResizeObserver = null;
      observedTerminalShell = null;
    }

    function refreshTerminalAfterFontLoad(terminalKey) {
      const fonts = globalThis.document && globalThis.document.fonts;
      if (!fonts || !fonts.load) return;
      Promise.all([
        fonts.load(`${terminalFontSize()}px "Herdr JetBrainsMono Nerd Font Mono"`),
        fonts.ready,
      ])
        .then(() => {
          if (!term || connectedTerminalKey !== terminalKey) return;
          if (term.invalidateCellMetrics) term.invalidateCellMetrics();
          if (globalThis.HerdrTerminalFit && globalThis.HerdrTerminalFit.invalidateCellSizeCache)
            globalThis.HerdrTerminalFit.invalidateCellSizeCache();
          scheduleTerminalShellResize();
        })
        .catch(() => {});
    }

    function size() {
      const shell = el("terminalShell");
      if (!shell) return { cols: 80, rows: 24 };
      return HerdrTerminalFit.gridSize(shell, term, {
        fallbackCell: { width: 9, height: 18 },
        // 320px-class viewports leave ~304px of shell content width; the
        // shared default floor of 40 cols needs ~336px and would force the
        // grid wider than the shell. Fit the real width instead of the
        // floor so narrow phones scroll inside the shell, never the app.
        minCols: 20,
        minRows: 10,
      });
    }

    async function connect() {
      const terminal = el("terminal");
      if (!terminal || !state.terminalId || !globalThis.HerdrTerminalRenderer) {
        setConnectionState(false);
        return;
      }
      observeTerminalShell(el("terminalShell"));
      if (term && openedTerminalElement && openedTerminalElement !== terminal) destroy(false);
      const nextSize = size();
      const terminalKey = `${state.session}|${state.ws}|${state.tab}|${state.pane}|${state.terminalId}|${terminalCore()}`;
      const terminalSizeKey = `${nextSize.cols}x${nextSize.rows}`;
      if (termWs && termWs.readyState === 0 && connectedTerminalKey === terminalKey) {
        setConnectionState(false);
        if (connectedTerminalSize !== terminalSizeKey) {
          connectedTerminalSize = terminalSizeKey;
          pendingTerminalResize = nextSize;
          try { term.resize(nextSize.cols, nextSize.rows); } catch (_) {}
        }
        return;
      }
      if (termWs && termWs.readyState === 1 && connectedTerminalKey === terminalKey) {
        setConnectionState(false);
        if (connectedTerminalSize === terminalSizeKey) return;
        connectedTerminalSize = terminalSizeKey;
        try { term.resize(nextSize.cols, nextSize.rows); } catch (_) {}
        const bridge = globalThis.HerdrGraphicsBridge;
        if (bridge) bridge.resize({ cols: nextSize.cols, rows: nextSize.rows });
        try {
          termWs.send(JSON.stringify({ type: "resize", cols: nextSize.cols, rows: nextSize.rows }));
        } catch (_) {}
        return;
      }
      // Reconnect backoff: same-target early return. Resize frames during
      // a drag must not tear down and reattach a failed target at frame
      // cadence; the scheduled reconnect above already owns recovery.
      if (terminalAttachInBackoff(terminalKey)) {
        setConnectionState(false);
        return;
      }
      disconnect(false);
      setConnectionState(true);
      connectedTerminalKey = terminalKey;
      connectedTerminalSize = terminalSizeKey;
      if (!term) {
        terminalInputGate = globalThis.HerdrMobileCore.createTerminalInputGate();
        term = await globalThis.HerdrTerminalRenderer.create(terminal, {
          cols: nextSize.cols,
          rows: nextSize.rows,
          core: terminalCore(),
          fontFamily: terminalFontFamily(),
          fontSize: terminalFontSize(),
          theme: terminalTheme(),
          links: terminalLinksEnabled(),
          scrollback: 10000,
          onData: sendInputData,
          onWheelMouseReport: (report) => sendInputData(report, { allowMouseReports: true }),
          inputGate: terminalInputGate,
        });
        openedTerminalElement = terminal;
        refreshTerminalAfterFontLoad(terminalKey);
      }
      if (!terminalScrollBound) {
        terminal.addEventListener("paste", handlePaste, true);
        // Desktop parity: capture registration so this handler runs at
        // target-capture phase, before the adapter's bubble-phase wheel
        // fallback, and stopImmediatePropagation inside keeps that fallback
        // from adding its own row on top of the scrollLines step.
        terminal.addEventListener("wheel", handleWheel, { passive: false, capture: true });
        terminal.addEventListener("scroll", () => setTerminalFollowPaused(!terminalAtBottom()), { passive: true });
        terminalScrollBound = true;
      }
      if (!terminalInputBound) {
        const enableDirectInput = () => {
          if (term && term.enableInput) term.enableInput();
        };
        terminal.addEventListener("pointerdown", enableDirectInput, true);
        terminal.addEventListener("mousedown", enableDirectInput, true);
        terminalInputBound = true;
      }
      try { term.resize(nextSize.cols, nextSize.rows); } catch (_) {}
      // External-backend Kitty graphics: open the parallel shell-graphics
      // bridge pinned to this tab (parity with the desktop terminal).
      // No-op in builtin mode or when the adapter is unavailable.
      const bridge = globalThis.HerdrGraphicsBridge;
      if (bridge) {
        bridge.connect(state, { terminal: term, wsUrl });
        bridge.resize({ cols: nextSize.cols, rows: nextSize.rows });
      }
      const ws = new WebSocket(wsUrl(`/ws/terminal?terminal_id=${encodeURIComponent(state.terminalId)}&cols=${nextSize.cols}&rows=${nextSize.rows}`));
      termWs = ws;
      // Recovery attempt for a previously failed target: remember the socket
      // so resize frames arriving while it is still connecting cannot tear
      // it down and churn a fresh one per frame. Cleared on settle (success
      // note, failure note, or the socket's own readyState going past OPEN).
      if (terminalReconnectTarget === terminalKey) {
        terminalReconnectAttemptWs = ws;
      }
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        if (termWs === ws) {
          setConnectionState(false);
          terminalAttachPending = true;
          if (pendingTerminalResize) {
            const resize = pendingTerminalResize;
            pendingTerminalResize = null;
            try { term.resize(resize.cols, resize.rows); } catch (_) {}
            try {
              ws.send(JSON.stringify({ type: "resize", cols: resize.cols, rows: resize.rows }));
            } catch (_) {}
          }
          scheduleTerminalShellResize();
        }
      };
      ws.onmessage = (event) => {
        if (termWs !== ws) return;
        if (
          typeof event.data === "string" &&
          onHerdrError &&
          onHerdrError(event.data)
        ) {
          // Backend attach failed (e.g. protocol mismatch): the host app
          // offered recovery, drop this socket for a clean reconnect.
          ws.close();
          return;
        }
        // Reset on the first successful data frame: the structured
        // herdr_error never reaches this path (the branch above drops the
        // socket), so no raw preamble can be mistaken for terminal data
        // and reset the backoff mid-cycle.
        noteTerminalAttachSuccess();
        enqueueTerminalFrame(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
        if (onTerminalOutput && state.terminalId) onTerminalOutput(state.terminalId);
      };
      ws.onclose = (event) => {
        if (termWs === ws) {
          termWs = null;
          connectedTerminalKey = "";
          connectedTerminalSize = "";
          setConnectionState(false);
          // Explicit stall close (4404) from the server: banner it through
          // the shared alert card instead of hanging on a dead stream.
          if (event && event.code === 4404 && globalThis.HerdrAlertCard) {
            globalThis.HerdrAlertCard.show({
              key: `terminal-stall:${state.terminalId}`,
              status: "blocked",
              title: "Terminal stream stalled",
              subtitle: "The backend closed this panel stream. Reconnect to resume.",
              onOpen: () => connect(),
            });
          }
          // Attach failed (backend unreachable or herdr_error teardown):
          // start the reconnect backoff so resize frames cannot reattach at
          // frame cadence. Deliberate teardowns null onclose first, so they
          // skip this path.
          noteTerminalAttachFailure(terminalKey);
        }
      };
    }

    function handlePaste(event) {
      // PR #333 parity (desktop terminalFocusBlocked): while the chat lens
      // covers the shell, a paste landing on the covered wterm textarea
      // must not reach the hidden pty. The composer and lens scroller sit
      // outside #terminal so their pastes never arrive here; this guard
      // only fires for the covered surface itself.
      const lens = globalThis.HerdrMobileLens;
      if (lens && lens.isActive && lens.isActive()) return;
      const text = event.clipboardData && event.clipboardData.getData("text/plain");
      if (!text || !termWs || termWs.readyState !== 1) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      sendPasteToTerminal(text);
    }

    function handleWheel(event) {
      if (event.ctrlKey || event.metaKey || !term) return;
      // Mouse tracking (SGR) or alt screen: the adapter already forwarded
      // the wheel as SGR mouse reports, so local scrollback scrolling must
      // not happen. The SGR check covers normal buffer too: inline TUIs
      // (jcode, tmux `mouse on`) never enter the alt screen.
      if (
        (typeof term.wheelForwardedToProgram === "function" && term.wheelForwardedToProgram()) ||
        !term.usesNormalBuffer ||
        !term.usesNormalBuffer()
      )
        return;
      event.preventDefault();
      // Desktop parity (handleTerminalWheel): once this handler scrolls,
      // the adapter's own fallback wheel listener must not run too, or
      // every step scrolls scrollLines rows plus one extra row from the
      // adapter's default wheelLines math. stopImmediatePropagation on the
      // capture registration below kills that second scroll.
      const stepLines = Math.max(1, Number(options().scrollLines) || 3);
      const rowHeight = Math.max(1, term.rowHeight ? term.rowHeight() : 17);
      if (event.deltaMode === 1) {
        term.scrollLines(event.deltaY < 0 ? -stepLines : stepLines);
        setTerminalFollowPaused(!terminalAtBottom());
        event.stopImmediatePropagation();
        return;
      }
      if (event.deltaMode === 2) {
        const pageRows = Math.max(1, term.rows || 24);
        term.scrollLines(event.deltaY < 0 ? -pageRows : pageRows);
        setTerminalFollowPaused(!terminalAtBottom());
        event.stopImmediatePropagation();
        return;
      }
      terminalWheelDeltaPixels += event.deltaY;
      if (Math.abs(terminalWheelDeltaPixels) < rowHeight) return;
      const steps = Math.trunc(terminalWheelDeltaPixels / rowHeight);
      terminalWheelDeltaPixels -= steps * rowHeight;
      const lines = steps * stepLines;
      term.scrollLines(lines);
      setTerminalFollowPaused(!terminalAtBottom());
      event.stopImmediatePropagation();
    }

    function disconnect(clear) {
      if (globalThis.HerdrGraphicsBridge) globalThis.HerdrGraphicsBridge.disconnect();
      if (termWs) {
        termWs.onclose = null;
        try { termWs.close(); } catch (_) {}
        termWs = null;
      }
      connectedTerminalKey = "";
      connectedTerminalSize = "";
      pendingTerminalResize = null;
      setConnectionState(false);
      inputQueue = [];
      terminalQueryReplyState = {};
      writeQueue = [];
      writeFlushPending = false;
      terminalAttachPending = false;
      if (inputFlushTimer) {
        clearTimeout(inputFlushTimer);
        inputFlushTimer = null;
      }
      if (clear && term) term.clear();
    }

    function destroy(clear) {
      disconnect(clear);
      clearTerminalShellObserver();
      if (term) {
        try { term.destroy(); } catch (_) {}
        term = null;
      }
      terminalInputGate = null;
      openedTerminalElement = null;
      terminalScrollBound = false;
      terminalInputBound = false;
      setTerminalFollowPaused(false);
    }

    function terminalAtBottom() {
      try { return !term || !term.atBottom || term.atBottom(); }
      catch (_) { return true; }
    }

    function setTerminalFollowPaused(paused) {
      terminalFollowPaused = !!paused;
      updateTerminalFollowButton();
    }

    function updateTerminalFollowButton() {
      const button = el("mobileTerminalFollowButton") || el("terminalFollowButton");
      if (!button) return;
      button.hidden = !terminalFollowPaused;
      button.setAttribute("aria-hidden", terminalFollowPaused ? "false" : "true");
    }

    function enqueueTerminalFrame(data) {
      const isAttachFrame = terminalAttachPending && frameSize(data) >= LARGE_FRAME_THRESHOLD;
      if (!isAttachFrame && !writeFlushPending && writeQueue.length === 0 && term && frameSize(data) <= IMMEDIATE_WRITE_THRESHOLD) {
        if (terminalAttachPending) terminalAttachPending = false;
        writeTerminalFrame(data);
        return;
      }
      writeQueue.push(data);
      if (writeFlushPending) return;
      writeFlushPending = true;
      requestAnimationFrame(flushTerminalFrames);
    }

    function frameSize(data) { return typeof data === "string" ? data.length : data.length; }

    function flushTerminalFrames() {
      writeFlushPending = false;
      if (!writeQueue.length || !term) return;
      const data = coalesceTerminalFrames(writeQueue);
      writeQueue = [];
      const done = () => {
        terminalAttachPending = false;
        if (!terminalFollowPaused) scrollToBottom(false);
      };
      writeTerminalFrame(data, terminalAttachPending && frameSize(data) >= LARGE_FRAME_THRESHOLD ? done : null);
      if (!(terminalAttachPending && frameSize(data) >= LARGE_FRAME_THRESHOLD) && !terminalFollowPaused)
        requestAnimationFrame(() => scrollToBottom(false));
    }

    function coalesceTerminalFrames(frames) {
      if (frames.every((frame) => typeof frame === "string")) return frames.join("");
      const bytes = frames.map((frame) => typeof frame === "string" ? inputEncoder.encode(frame) : frame);
      const size = bytes.reduce((sum, frame) => sum + frame.length, 0);
      const merged = new Uint8Array(size);
      let offset = 0;
      for (const frame of bytes) { merged.set(frame, offset); offset += frame.length; }
      return merged;
    }

    function writeTerminalFrame(data, done) {
      if (!term) return;
      try { term.write(data, done || undefined); } catch (_) { try { term.write(data); } catch (_) {} if (done) done(); }
    }

    function scrollToBottom(focus = true) {
      setTerminalFollowPaused(false);
      try { if (term) term.scrollToBottom(); } catch (_) {}
      if (focus && term) {
        if (term.focus) term.focus();
      }
    }

    function sendInputData(data, inputOptions = {}) {
      if (!termWs || termWs.readyState !== 1 || !data) return;
      if (!inputOptions.allowMouseReports && globalThis.HerdrAppHelpers && globalThis.HerdrAppHelpers.stripTerminalMouseReports)
        data = globalThis.HerdrAppHelpers.stripTerminalMouseReports(data, terminalMouseReportingEnabled());
      if (!inputOptions.allowTerminalReplies && globalThis.HerdrAppHelpers && globalThis.HerdrAppHelpers.stripTerminalQueryReplies)
        data = globalThis.HerdrAppHelpers.stripTerminalQueryReplies(data, terminalQueryReplyState);
      if (!data) return;
      const bytes = inputEncoder.encode(data);
      const chunkSize = inputOptions.chunkSize || 16 * 1024;
      if (bytes.length <= chunkSize && inputQueue.length === 0 && termWs.bufferedAmount < 65536) {
        termWs.send(bytes);
        return;
      }
      for (let i = 0; i < bytes.length; i += chunkSize) inputQueue.push(bytes.slice(i, i + chunkSize));
      flushInputQueue();
    }

    function sendPasteToTerminal(text) {
      const normalized = String(text || "").replace(/\r\n|\r/g, "\n");
      sendInputData(normalized, { chunkSize: 16 * 1024, maxBufferedAmount: 64 * 1024 });
    }

    function flushInputQueue() {
      if (!termWs || termWs.readyState !== 1) { inputQueue = []; return; }
      while (inputQueue.length && termWs.bufferedAmount < 65536) termWs.send(inputQueue.shift());
      if (inputQueue.length && !inputFlushTimer) inputFlushTimer = setTimeout(() => { inputFlushTimer = null; flushInputQueue(); }, 4);
    }

    function sendControlKey(data) {
      // Key-bar bytes bypass the wterm textarea: send directly through the
      // input WS path. Strip helpers stay applied (they leave bare control
      // bytes and arrow escapes untouched).
      sendInputData(String(data || ""));
    }

    return {
      connect,
      destroy,
      disconnect,
      applyFontFamily,
      applyLinks,
      applyTheme,
      scrollToBottom,
      sendControlKey,
      // Composer/prompt-card support: the wterm adapter exposes .wterm
      // (with .bridge for grid reads), and paste is the safest text path
      // (normalizes newlines, strips reports/replies like typed input).
      getTerm: () => term,
      sendPasteToTerminal,
    };
  }

  globalThis.HerdrMobileTerminal = { create: createMobileTerminal };
})();
