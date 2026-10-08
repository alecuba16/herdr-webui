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
      terminalInputBound = false;

    const IMMEDIATE_WRITE_THRESHOLD = 8192;
    const LARGE_FRAME_THRESHOLD = 32768;

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
      if (term && openedTerminalElement && openedTerminalElement !== terminal) destroy(false);
      const nextSize = size();
      const terminalKey = `${state.session}|${state.ws}|${state.tab}|${state.pane}|${state.terminalId}|${terminalCore()}`;
      const terminalSizeKey = `${nextSize.cols}x${nextSize.rows}`;
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
          fontSize: options().terminalFontSize || 14,
          theme: terminalTheme(),
          links: terminalLinksEnabled(),
          scrollback: 10000,
          onData: sendInputData,
          onWheelMouseReport: (report) => sendInputData(report, { allowMouseReports: true }),
          inputGate: terminalInputGate,
        });
        openedTerminalElement = terminal;
      }
      if (!terminalScrollBound) {
        terminal.addEventListener("paste", handlePaste, true);
        terminal.addEventListener("wheel", handleWheel, { passive: false });
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
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        if (termWs === ws) {
          setConnectionState(false);
          terminalAttachPending = true;
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
        }
      };
    }

    function handlePaste(event) {
      const text = event.clipboardData && event.clipboardData.getData("text/plain");
      if (!text || !termWs || termWs.readyState !== 1) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      sendPasteToTerminal(text);
    }

    function handleWheel(event) {
      if (event.ctrlKey || event.metaKey || !term) return;
      // Alt screen + mouse tracking: the adapter already forwarded the wheel as
      // SGR mouse reports, so local scrollback scrolling must not happen.
      if (!term.usesNormalBuffer || !term.usesNormalBuffer()) return;
      event.preventDefault();
      const lines = Math.max(1, Math.round(Math.abs(event.deltaY) / Math.max(1, term.rowHeight ? term.rowHeight() : 17)));
      term.scrollLines(event.deltaY < 0 ? -lines : lines);
      setTerminalFollowPaused(!terminalAtBottom());
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
