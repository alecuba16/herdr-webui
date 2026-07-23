(function () {
  function createMobileTerminal({ el, state, wsUrl }) {
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
        return JSON.parse((globalThis.localStorage && globalThis.localStorage.getItem("herdr-web-options")) || "{}");
      } catch (_) {
        return {};
      }
    }

    function terminalFontFamily() {
      return globalThis.HerdrAppHelpers.resolveTerminalFontFamily(options().terminalFontFamily);
    }

    function terminalCore() {
      return options().terminalCore === "ghostty" ? "ghostty" : "wterm";
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
      if (
        termWs &&
        termWs.readyState === 1 &&
        connectedTerminalKey === terminalKey &&
        connectedTerminalSize === terminalSizeKey
      ) return;
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
      const ws = new WebSocket(wsUrl(`/ws/terminal?terminal_id=${encodeURIComponent(state.terminalId)}&cols=${nextSize.cols}&rows=${nextSize.rows}`));
      termWs = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { if (termWs === ws) terminalAttachPending = true; };
      ws.onmessage = (event) => {
        if (termWs !== ws) return;
        enqueueTerminalFrame(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
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
      if (!term.usesNormalBuffer || !term.usesNormalBuffer()) return;
      event.preventDefault();
      const lines = Math.max(1, Math.round(Math.abs(event.deltaY) / Math.max(1, term.rowHeight ? term.rowHeight() : 17)));
      term.scrollLines(event.deltaY < 0 ? -lines : lines);
      setTerminalFollowPaused(!terminalAtBottom());
    }

    function disconnect(clear) {
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
      if (focus && term) term.focus();
    }

    function sendInputData(data, inputOptions = {}) {
      if (!termWs || termWs.readyState !== 1 || !data) return;
      if (globalThis.HerdrAppHelpers && globalThis.HerdrAppHelpers.stripTerminalMouseReports)
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

    return { connect, destroy, disconnect, applyFontFamily, applyLinks, scrollToBottom };
  }

  globalThis.HerdrMobileTerminal = { create: createMobileTerminal };
})();
