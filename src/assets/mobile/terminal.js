(function () {
  function createMobileTerminal({ el, state, wsUrl }) {
    let term,
      termWs,
      openedTerminalElement = null,
      connectedTerminalKey = "",
      connectedTerminalSize = "",
      terminalFollowPaused = false,
      terminalScrollFollowBound = false,
      documentPasteBound = false,
      terminalLinkProvider = null,
      inputFlushTimer = null,
      inputQueue = [],
      writeQueue = [],
      writeFlushPending = false,
      terminalOutputControlCarry = "",
      outputDecoder = new TextDecoder(),
      inputEncoder = new TextEncoder();

    // Below this size, a frame is written immediately instead of waiting for
    // the next requestAnimationFrame. Small frames have negligible render
    // cost and the RAF delay adds ~16ms of latency for no benefit.
    const IMMEDIATE_WRITE_THRESHOLD = 8192;
    // Frames above this size are full-screen repaints from the backend
    // (the initial attach frame). xterm.js parses these in 12ms time-slices
    // with setTimeout(0) between slices, causing visible line-by-line
    // repaints. We suppress the terminal reveal until the write callback fires.
    const LARGE_FRAME_THRESHOLD = 32768;
    // Set true on WS open, cleared after the first large frame is fully written.
    let terminalAttachPending = false;

    function terminalFontFamily() {
      try {
        const parsed = JSON.parse(
          (globalThis.localStorage &&
            globalThis.localStorage.getItem("herdr-web-options")) ||
            "{}",
        );
        return globalThis.HerdrAppHelpers.resolveTerminalFontFamily(
          parsed && parsed.terminalFontFamily,
        );
      } catch (_) {
        return globalThis.HerdrAppHelpers.resolveTerminalFontFamily("");
      }
    }
    function applyFontFamily() {
      if (!term) return;
      const family = terminalFontFamily();
      try {
        term.options.fontFamily = family;
      } catch (e) {
        try {
          term.setOption("fontFamily", family);
        } catch (_) {}
      }
      try {
        term.refresh(0, Math.max(0, (term.rows || 1) - 1));
      } catch (_) {}
    }

function terminalLinksEnabled() {
      try {
        const parsed = JSON.parse((globalThis.localStorage && globalThis.localStorage.getItem("herdr-web-options")) || "{}");
        return parsed.terminalLinks !== false;
      } catch (_) {
        return true;
      }
    }

    function applyLinks() {
      if (terminalLinkProvider && terminalLinkProvider.dispose) {
        try { terminalLinkProvider.dispose(); } catch (_) {}
      }
      terminalLinkProvider = null;
      if (!term || !terminalLinksEnabled() || !term.registerLinkProvider) return;
      terminalLinkProvider = term.registerLinkProvider({ provideLinks });
    }

    function provideLinks(lineNumber, callback) {
      try {
        const buffer = term && term.buffer && term.buffer.active;
        const y = buffer ? Math.max(0, (buffer.viewportY || 0) + lineNumber - 1) : 0;
        const line = buffer && (buffer.getLine(y) || buffer.getLine(lineNumber - 1) || buffer.getLine(lineNumber));
        const text = line && line.translateToString ? line.translateToString(true) : "";
        const links = [];
        const re = /https?:\/\/[^\s<>"]+/g;
        let match;
        while ((match = re.exec(text))) {
          const url = match[0].replace(/[),.;]+$/g, "");
          if (!url) continue;
          links.push({ range: { start: { x: match.index + 1, y: lineNumber }, end: { x: match.index + url.length, y: lineNumber } }, text: url, activate: (_event, text) => globalThis.open(text, "_blank", "noopener,noreferrer") });
        }
        callback(links);
      } catch (_) {
        callback([]);
      }
    }

    function refreshAfterFontLoad(terminalKey) {
      const fonts = globalThis.document && globalThis.document.fonts;
      if (!fonts || !fonts.load) return;
      Promise.all([
        fonts.load('14px "Herdr JetBrainsMono Nerd Font Mono"'),
        fonts.ready,
      ])
        .then(() => {
          if (!term || connectedTerminalKey !== terminalKey) return;
          applyFontFamily();
        })
        .catch(() => {});
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

    function connect() {
      const terminal = el("terminal");
      if (!terminal || !state.terminalId || !globalThis.Terminal) return;
      if (term && openedTerminalElement && openedTerminalElement !== terminal)
        destroy(false);
      const nextSize = size();
      const terminalKey = `${state.session}|${state.ws}|${state.tab}|${state.pane}|${state.terminalId}`;
      const terminalSizeKey = `${nextSize.cols}x${nextSize.rows}`;
      if (
        termWs &&
        termWs.readyState === 1 &&
        connectedTerminalKey === terminalKey &&
        connectedTerminalSize === terminalSizeKey
      )
        return;
      disconnect(false);
      connectedTerminalKey = terminalKey;
      connectedTerminalSize = terminalSizeKey;
      if (!term) {
        term = new Terminal({
          convertEol: false,
          fontFamily: terminalFontFamily(),
          scrollback: 10000,
        });
        term.onData((data) => {
          sendInputData(data);
        });
        applyLinks();
        if (!terminalScrollFollowBound && term.onScroll) {
          term.onScroll(() => {
            setTerminalFollowPaused(!terminalAtBottom());
          });
          terminalScrollFollowBound = true;
        }
      }
      terminal.innerHTML = "";
      term.open(terminal);
      refreshAfterFontLoad(terminalKey);
      if (!terminal.dataset.pasteHandler) {
        terminal.addEventListener(
          "paste",
          (event) => handleTerminalPasteEvent(event, { force: true, stopImmediate: true }),
          true,
        );
        terminal.dataset.pasteHandler = "1";
      }
      if (!documentPasteBound && globalThis.document && globalThis.document.addEventListener) {
        globalThis.document.addEventListener("paste", (event) => handleTerminalPasteEvent(event));
        documentPasteBound = true;
      }
      if (!terminal.dataset.scrollHandler) {
        terminal.addEventListener("wheel", handleWheel, { passive: false });
        terminal.addEventListener("touchstart", handleTouchStart, { passive: true });
        terminal.addEventListener("touchmove", handleTouchMove, { passive: false });
        terminal.dataset.scrollHandler = "1";
      }
      openedTerminalElement = terminal;
      try {
        term.resize(nextSize.cols, nextSize.rows);
        HerdrTerminalFit.fitXtermToContainer(terminal);
      } catch (_) {}
      updateTerminalFollowButton();
      const ws = new WebSocket(
        wsUrl(
          `/ws/terminal?terminal_id=${encodeURIComponent(state.terminalId)}&cols=${nextSize.cols}&rows=${nextSize.rows}`,
        ),
      );
      termWs = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        if (termWs === ws) {
          terminalAttachPending = true;
        }
      };
      ws.onmessage = (event) => {
        if (termWs !== ws) return;
        enqueueTerminalFrame(
          typeof event.data === "string" ? event.data : new Uint8Array(event.data),
        );
      };
      ws.onclose = () => {
        if (termWs === ws) {
          termWs = null;
          connectedTerminalKey = "";
          connectedTerminalSize = "";
        }
      };
    }

    function disconnect(clear) {
      if (termWs) {
        termWs.onclose = null;
        try {
          termWs.close();
        } catch (_) {}
        termWs = null;
      }
      connectedTerminalKey = "";
      connectedTerminalSize = "";
      inputQueue = [];
      writeQueue = [];
      writeFlushPending = false;
      terminalOutputControlCarry = "";
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
        if (terminalLinkProvider && terminalLinkProvider.dispose) {
          try { terminalLinkProvider.dispose(); } catch (_) {}
        }
        terminalLinkProvider = null;
        try {
          term.dispose();
        } catch (_) {}
        term = null;
      }
      openedTerminalElement = null;
      terminalScrollFollowBound = false;
      setTerminalFollowPaused(false);
    }

    function terminalAtBottom() {
      try {
        const buffer = term && term.buffer && term.buffer.active;
        if (!buffer) return true;
        return Math.max(0, buffer.baseY - buffer.viewportY) <= 1;
      } catch (_) {
        return true;
      }
    }

    function terminalUsesNormalBuffer() {
      return HerdrTerminalScroll.usesNormalBuffer(term);
    }

    function scrollLocalTerminal(direction, lines) {
      return HerdrTerminalScroll.scrollLocal(term, direction, lines, () => {
        setTerminalFollowPaused(!terminalAtBottom());
      });
    }

    function handleWheel(event) {
      if (!event || event.altKey || !event.deltaY || !terminalUsesNormalBuffer()) return;
      const lines = HerdrTerminalScroll.wheelLines(
        term,
        event,
        (term && term.rows) || 24,
      );
      if (scrollLocalTerminal(event.deltaY < 0 ? "up" : "down", lines)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    function handleTouchStart(event) {
      const touch = event && event.touches && event.touches[0];
      handleTouchStart.lastY = touch ? touch.clientY : null;
    }

    function handleTouchMove(event) {
      const touch = event && event.touches && event.touches[0];
      if (!touch || !terminalUsesNormalBuffer()) return;
      const lastY = handleTouchStart.lastY;
      handleTouchStart.lastY = touch.clientY;
      if (!Number.isFinite(lastY)) return;
      const dy = lastY - touch.clientY;
      if (Math.abs(dy) < 4) return;
      const lines = HerdrTerminalScroll.touchLines(term, dy);
      if (scrollLocalTerminal(dy < 0 ? "up" : "down", lines)) {
        event.preventDefault();
        event.stopPropagation();
      }
    }

    function setTerminalFollowPaused(paused) {
      terminalFollowPaused = !!paused;
      updateTerminalFollowButton();
    }

    function updateTerminalFollowButton() {
      const button = el("mobileTerminalFollowButton");
      if (!button) return;
      button.hidden = !terminalFollowPaused;
      button.setAttribute &&
        button.setAttribute("aria-hidden", terminalFollowPaused ? "false" : "true");
    }

    function enqueueTerminalFrame(data) {
      const size = typeof data === "string" ? data.length : data.length;
      // Attach frame path: the first large frame after connecting is a
      // full-screen repaint. Queue it via RAF and use the write callback
      // to reveal only when parsing completes, avoiding line-by-line repaint.
      const isAttachFrame = terminalAttachPending && size >= LARGE_FRAME_THRESHOLD;
      if (isAttachFrame) {
        writeQueue.push(data);
        if (writeFlushPending) return;
        writeFlushPending = true;
        requestAnimationFrame(flushTerminalFrames);
        return;
      }
      // Clear the attach flag for small initial frames (e.g. empty terminal)
      if (terminalAttachPending) terminalAttachPending = false;
      // Fast path: when no flush is pending and the frame is small, write it
      // directly. This avoids the requestAnimationFrame round-trip (~16ms).
      if (
        !writeFlushPending &&
        writeQueue.length === 0 &&
        term &&
        size <= IMMEDIATE_WRITE_THRESHOLD
      ) {
        writeTerminalFrame(data);
        return;
      }
      writeQueue.push(data);
      if (writeFlushPending) return;
      writeFlushPending = true;
      requestAnimationFrame(flushTerminalFrames);
    }

    function flushTerminalFrames() {
      writeFlushPending = false;
      if (!writeQueue.length || !term) return;
      const frames = writeQueue;
      writeQueue = [];
      const data = coalesceTerminalFrames(frames);
      const isAttachBatch = terminalAttachPending && (typeof data === "string" ? data.length : data.length) >= LARGE_FRAME_THRESHOLD;
      if (isAttachBatch) {
        terminalAttachPending = false;
        // Use write callback to reveal only after parsing completes
        const done = () => {
          requestAnimationFrame(() => {
            scrollToBottom();
          });
        };
        const filtered = handleTerminalOutputControlSequences(data);
        if (!filtered) {
          done();
          return;
        }
        try {
          term.write(filtered, done);
        } catch (_) {
          term.write(filtered);
          done();
        }
        return;
      }
      // Clear attach flag if it was set but the coalesced frame ended up small
      if (terminalAttachPending) terminalAttachPending = false;
      writeTerminalFrame(data);
    }

    function coalesceTerminalFrames(frames) {
      if (frames.every((frame) => typeof frame === "string")) return frames.join("");
      const bytes = frames.map((frame) =>
        typeof frame === "string" ? inputEncoder.encode(frame) : frame,
      );
      const size = bytes.reduce((sum, frame) => sum + frame.length, 0);
      const merged = new Uint8Array(size);
      let offset = 0;
      for (const frame of bytes) {
        merged.set(frame, offset);
        offset += frame.length;
      }
      return merged;
    }

    function writeTerminalFrame(data) {
      data = handleTerminalOutputControlSequences(data);
      if (!data) return;
      // Only use the scroll-preserving callback when follow is actually
      // paused (user scrolled up). When following the bottom, skip the
      // callback entirely to avoid per-write overhead.
      const shouldPreserve = terminalFollowPaused && !terminalAtBottom();
      const viewportY =
        shouldPreserve && term && term.buffer ? term.buffer.active.viewportY : null;
      const done = shouldPreserve
        ? () => {
            if (Number.isFinite(viewportY)) {
              try {
                term.scrollToLine(viewportY);
              } catch (_) {}
            }
            setTerminalFollowPaused(!terminalAtBottom());
          }
        : null;
      try {
        if (done) term.write(data, done);
        else term.write(data);
      } catch (_) {
        term.write(data);
        if (done) done();
      }
    }

    function decodeBase64Utf8(value) {
      try {
        const binary = atob(String(value || ""));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return outputDecoder.decode(bytes);
      } catch (_) {
        return "";
      }
    }

    function copyOsc52ClipboardPayload(encoded) {
      const text = decodeBase64Utf8(encoded);
      if (!text) return;
      const clipboard = globalThis.navigator && globalThis.navigator.clipboard;
      if (!clipboard || typeof clipboard.writeText !== "function") return;
      Promise.resolve(clipboard.writeText(text)).catch(() => {
        console.warn("mobile terminal OSC 52 clipboard write was blocked by the browser");
      });
    }

    function handleTerminalOutputControlSequences(data) {
      const text = typeof data === "string" ? data : outputDecoder.decode(data);
      let combined = terminalOutputControlCarry ? terminalOutputControlCarry + text : text;
      terminalOutputControlCarry = "";
      let changed = combined !== text;
      combined = combined.replace(/\x1b\]52;[A-Za-z0-9]*;([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g, (_seq, encoded) => {
        changed = true;
        copyOsc52ClipboardPayload(encoded);
        return "";
      });
      const pending = combined.lastIndexOf("\x1b]52;");
      if (pending >= 0 && combined.indexOf("\x07", pending) < 0 && combined.indexOf("\x1b\\", pending) < 0) {
        terminalOutputControlCarry = combined.slice(pending).slice(0, 8192);
        combined = combined.slice(0, pending);
        changed = true;
      }
      return changed ? combined : data;
    }

    function scrollToBottom() {
      setTerminalFollowPaused(false);
      try {
        if (term) term.scrollToBottom();
      } catch (_) {}
      try {
        if (term) term.focus();
      } catch (_) {}
    }

    function stripTerminalQueryReplies(data) {
      const filter = globalThis.HerdrTerminalFilter;
      return filter && filter.stripTerminalQueryReplies
        ? filter.stripTerminalQueryReplies(data)
        : String(data || "");
    }

    function editableClipboardTarget(target) {
      return (
        target &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      );
    }

    function handleTerminalPasteEvent(event, options = {}) {
      if (!event || event.defaultPrevented) return false;
      if (!options.force && editableClipboardTarget(event.target)) return false;
      const text = event.clipboardData && event.clipboardData.getData("text/plain");
      if (!text || !termWs || termWs.readyState !== 1) return false;
      event.preventDefault();
      if (options.stopImmediate && event.stopImmediatePropagation) event.stopImmediatePropagation();
      else if (event.stopPropagation) event.stopPropagation();
      sendPasteToTerminal(text);
      return true;
    }

    function sendInputData(data, options = {}) {
      if (!termWs || termWs.readyState !== 1 || !data) return;
      if (typeof data === "string" && !options.allowTerminalReplies)
        data = stripTerminalQueryReplies(data);
      if (!data) return;
      const bytes = typeof data === "string" ? inputEncoder.encode(data) : data;
      const chunkSize = 16 * 1024;
      if (
        bytes.length <= 64 * 1024 &&
        inputQueue.length === 0 &&
        termWs.bufferedAmount < 1024 * 1024
      ) {
        termWs.send(bytes);
        return;
      }
      for (let i = 0; i < bytes.length; i += chunkSize)
        inputQueue.push(bytes.slice(i, i + chunkSize));
      scheduleInputFlush();
    }

    function sendPasteToTerminal(text) {
      if (!termWs || termWs.readyState !== 1 || !text) return;
      const helpers = globalThis.HerdrAppHelpers || {};
      const pasteInput = helpers.terminalPasteInput
        ? helpers.terminalPasteInput(text, false)
        : String(text || "").replace(/\r\n?/g, "\n");
      sendInputData(pasteInput, { allowTerminalReplies: true });
    }

    function scheduleInputFlush() {
      if (inputFlushTimer) return;
      inputFlushTimer = setTimeout(flushInputQueue, 4);
    }

    function flushInputQueue() {
      inputFlushTimer = null;
      if (!termWs || termWs.readyState !== 1) {
        inputQueue = [];
        return;
      }
      while (inputQueue.length && termWs.bufferedAmount < 65536)
        termWs.send(inputQueue.shift());
      if (inputQueue.length) scheduleInputFlush();
    }

    return { connect, destroy, disconnect, applyFontFamily, applyLinks, scrollToBottom };
  }

  globalThis.HerdrMobileTerminal = { create: createMobileTerminal };
})();
