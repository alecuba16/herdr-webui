(function () {
  function createMobileTerminal({ el, state, wsUrl }) {
    let term,
      termWs,
      openedTerminalElement = null,
      connectedTerminalKey = "",
      connectedTerminalSize = "",
      terminalFollowPaused = false,
      terminalScrollFollowBound = false,
      terminalLinkProvider = null,
      inputFlushTimer = null,
      inputQueue = [];
    const inputEncoder = new TextEncoder();

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

    function size() {
      const shell = el("terminalShell");
      if (!shell) return { cols: 80, rows: 24 };
      return {
        cols: Math.max(40, Math.floor(shell.clientWidth / 9)),
        rows: Math.max(10, Math.floor(shell.clientHeight / 18)),
      };
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
      if (!terminal.dataset.pasteHandler) {
        terminal.addEventListener(
          "paste",
          (event) => {
            const text =
              event.clipboardData && event.clipboardData.getData("text/plain");
            if (!text || !termWs || termWs.readyState !== 1) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            const paste = globalThis.HerdrAppHelpers.terminalPasteInput(
              text,
              !!(term && term.modes && term.modes.bracketedPasteMode),
            );
            sendInputData(paste);
          },
          true,
        );
        terminal.dataset.pasteHandler = "1";
      }
      openedTerminalElement = terminal;
      try {
        term.resize(nextSize.cols, nextSize.rows);
      } catch (_) {}
      updateTerminalFollowButton();
      const ws = new WebSocket(
        wsUrl(
          `/ws/terminal?terminal_id=${encodeURIComponent(state.terminalId)}&cols=${nextSize.cols}&rows=${nextSize.rows}`,
        ),
      );
      termWs = ws;
      ws.binaryType = "arraybuffer";
      ws.onmessage = (event) => {
        if (termWs !== ws) return;
        writeTerminalFrame(
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

    function writeTerminalFrame(data) {
      const shouldPreserve = terminalFollowPaused && !terminalAtBottom();
      const viewportY =
        shouldPreserve && term && term.buffer ? term.buffer.active.viewportY : null;
      const done = () => {
        if (shouldPreserve && Number.isFinite(viewportY)) {
          try {
            term.scrollToLine(viewportY);
          } catch (_) {}
        }
        setTerminalFollowPaused(!terminalAtBottom());
      };
      try {
        term.write(data, done);
      } catch (_) {
        term.write(data);
        done();
      }
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

    function sendInputData(data) {
      if (!termWs || termWs.readyState !== 1 || !data) return;
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
