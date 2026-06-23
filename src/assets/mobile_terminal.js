(function () {
  function createMobileTerminal({ el, state, wsUrl }) {
    let term,
      termWs,
      openedTerminalElement = null,
      connectedTerminalKey = "",
      connectedTerminalSize = "";

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
          fontFamily: "ui-monospace,SFMono-Regular,Menlo,monospace",
          scrollback: 10000,
        });
        term.onData((data) => {
          if (termWs && termWs.readyState === 1) termWs.send(data);
        });
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
            termWs.send(paste);
          },
          true,
        );
        terminal.dataset.pasteHandler = "1";
      }
      openedTerminalElement = terminal;
      try {
        term.resize(nextSize.cols, nextSize.rows);
      } catch (_) {}
      const ws = new WebSocket(
        wsUrl(
          `/ws/terminal?terminal_id=${encodeURIComponent(state.terminalId)}&cols=${nextSize.cols}&rows=${nextSize.rows}`,
        ),
      );
      termWs = ws;
      ws.binaryType = "arraybuffer";
      ws.onmessage = (event) => {
        if (termWs !== ws) return;
        if (typeof event.data === "string") term.write(event.data);
        else term.write(new Uint8Array(event.data));
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
      if (clear && term) term.clear();
    }

    function destroy(clear) {
      disconnect(clear);
      if (term) {
        try {
          term.dispose();
        } catch (_) {}
        term = null;
      }
      openedTerminalElement = null;
    }

    return { connect, destroy, disconnect };
  }

  globalThis.HerdrMobileTerminal = { create: createMobileTerminal };
})();
