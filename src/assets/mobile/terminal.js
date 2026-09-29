(function () {
  function createMobileTerminal({ el, state, wsUrl, onHerdrError, onTerminalOutput }) {
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
      terminalAttachPending = false;

    const IMMEDIATE_WRITE_THRESHOLD = 8192;
    const LARGE_FRAME_THRESHOLD = 32768;

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
        minCols: 40,
        minRows: 10,
      });
    }

    async function connect() {
      const terminal = el("terminal");
      if (!terminal || !state.terminalId || !globalThis.HerdrTerminalRenderer) return;
      if (term && openedTerminalElement && openedTerminalElement !== terminal) destroy(false);
      const nextSize = size();
      const terminalKey = `${state.session}|${state.ws}|${state.tab}|${state.pane}|${state.terminalId}|${terminalCore()}`;
      const terminalSizeKey = `${nextSize.cols}x${nextSize.rows}`;
      if (termWs && termWs.readyState === 1 && connectedTerminalKey === terminalKey) {
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
      connectedTerminalKey = terminalKey;
      connectedTerminalSize = terminalSizeKey;
      if (!term) {
        term = await globalThis.HerdrTerminalRenderer.create(terminal, {
          cols: nextSize.cols,
          rows: nextSize.rows,
          core: terminalCore(),
          fontFamily: terminalFontFamily(),
          links: terminalLinksEnabled(),
          scrollback: 10000,
          onData: sendInputData,
          onWheelMouseReport: (report) => sendInputData(report, { allowMouseReports: true }),
          // Mobile input model: the terminal surface never takes keyboard
          // focus.  All input goes through the pencil-button input sheet.
          inputGate: () => true,
        });
        openedTerminalElement = terminal;
      }
      if (!terminalScrollBound) {
        terminal.addEventListener("paste", handlePaste, true);
        terminal.addEventListener("wheel", handleWheel, { passive: false });
        terminal.addEventListener("scroll", () => setTerminalFollowPaused(!terminalAtBottom()), { passive: true });
        terminalScrollBound = true;
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
      ws.onopen = () => { if (termWs === ws) terminalAttachPending = true; };
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
      ws.onclose = () => {
        if (termWs === ws) {
          termWs = null;
          connectedTerminalKey = "";
          connectedTerminalSize = "";
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
      openedTerminalElement = null;
      terminalScrollBound = false;
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
      // On mobile the terminal surface never takes keyboard focus (the
      // input gate denies it); focusing here would only fight the gate.
      if (focus && term && !term._inputGate) term.focus();
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

    // ---- Pencil button + input sheet (mobile input model) ------------------
    // The terminal surface never accepts direct keyboard input: wterm's
    // hidden textarea is gated (readonly + focus reverted), so touching or
    // typing at the terminal can never pop the on-screen keyboard.  All
    // input goes through the input sheet opened from the floating pencil
    // button, which keeps IME composition in a real, visible input field
    // (no corruption) and only opens the keyboard when the user asks.

    function isInputSheetOpen() {
      const sheet = el("mobileTerminalInputSheet");
      return !!(sheet && !sheet.hidden);
    }

    function openInputSheet() {
      const shell = el("terminalShell");
      if (!shell) return;
      // Anchor to the terminal screen: the shell scrolls and has paint
      // containment, so it cannot host the overlay.
      const host = shell.closest(".mobile-terminal-screen") || shell;
      let sheet = el("mobileTerminalInputSheet");
      if (!sheet) {
        sheet = document.createElement("div");
        sheet.className = "mobile-terminal-input-sheet";
        sheet.id = "mobileTerminalInputSheet";
        sheet.setAttribute("role", "dialog");
        sheet.setAttribute("aria-modal", "false");
        sheet.setAttribute("aria-label", "Terminal input");
        sheet.innerHTML =
          '<div class="mobile-sheet-handle" aria-hidden="true"></div>' +
          '<div class="mobile-terminal-input-row">' +
          '<input id="mobileTerminalInput" class="mobile-sheet-input" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="send" placeholder="Type a command and press Enter" />' +
          '<button type="button" class="mobile-terminal-input-send" id="mobileTerminalInputSend" aria-label="Send to terminal">↵</button>' +
          '<button type="button" class="mobile-terminal-input-close" id="mobileTerminalInputClose" aria-label="Close input">✕</button>' +
          '</div>';
        host.appendChild(sheet);
        const input = sheet.querySelector("#mobileTerminalInput");
        const sendButton = sheet.querySelector("#mobileTerminalInputSend");
        const closeButton = sheet.querySelector("#mobileTerminalInputClose");
        if (input) {
          input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submitInputSheet();
            } else if (event.key === "Escape") {
              event.preventDefault();
              closeInputSheet();
            } else if (event.key === "Backspace" && input.value === "") {
              // Backspace with an empty field sends DEL to the terminal, so
              // the prompt line can be edited without a control-key row.
              event.preventDefault();
              sendInputData("\x7f");
            }
          });
          input.addEventListener("paste", (event) => {
            const text = event.clipboardData && event.clipboardData.getData("text/plain");
            if (text) {
              event.preventDefault();
              sendPasteToTerminal(text);
            }
          });
        }
        if (sendButton) sendButton.addEventListener("click", submitInputSheet);
        if (closeButton) closeButton.addEventListener("click", closeInputSheet);
      }
      sheet.hidden = false;
      const input = el("mobileTerminalInput");
      if (input) {
        // Keep any half-typed draft; the user may have closed the sheet
        // by accident and reopened it.
        try { input.focus(); } catch (_) {}
      }
    }

    function closeInputSheet() {
      const sheet = el("mobileTerminalInputSheet");
      if (sheet) sheet.hidden = true;
      const input = el("mobileTerminalInput");
      if (input) { try { input.blur(); } catch (_) {} }
    }

    function submitInputSheet() {
      const input = el("mobileTerminalInput");
      if (!input) return;
      const value = input.value;
      if (!value) return;
      // Send each line with a trailing CR so multi-line pastes behave like
      // typing them one by one; single-line typing sends one Enter.
      // User input goes through the default query-reply stripping (no
      // allowTerminalReplies): typed text must not smuggle terminal
      // reply sequences into the PTY.
      const lines = value.replace(/\r\n|\r/g, "\n").split("\n");
      for (const line of lines) {
        if (line) sendInputData(line);
        sendInputData("\r");
      }
      input.value = "";
      if (!termWs || termWs.readyState !== 1) return;
      setTerminalFollowPaused(false);
      try { if (term) term.scrollToBottom(); } catch (_) {}
    }

    return { connect, destroy, disconnect, applyFontFamily, applyLinks, scrollToBottom, openInputSheet, closeInputSheet, isInputSheetOpen };
  }

  globalThis.HerdrMobileTerminal = { create: createMobileTerminal };
})();
