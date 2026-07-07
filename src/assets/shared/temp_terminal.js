/**
 * Ephemeral temporary terminal overlay.
 *
 * Opens a modal with a fresh xterm.js Terminal that connects to a new
 * Herdr tab/pane created via the existing tab.create API.  The terminal
 * is purely ephemeral: when the modal closes (X button, websocket drop,
 * or server-side pane.exited event) the tab is closed via tab.close and
 * all local state is discarded.  No server-side persistence is needed.
 *
 * Used by both desktop and mobile layouts.
 */
(function () {
  function createTempTerminal(opts) {
    var el = opts.el;
    var state = opts.state;
    var wsUrl = opts.wsUrl;
    var api = opts.api;
    var modalId = opts.modalId;
    var containerId = opts.containerId;
    var buttonId = opts.buttonId;
    var closeId = opts.closeId;
    var fontFamilyFn = opts.fontFamilyFn || function () { return "monospace"; };
    var themeFn = opts.themeFn || function () { return {}; };

    var term = null;
    var termWs = null;
    var createdTabId = null;
    var createdPaneId = null;
    var createdWorkspaceId = null;
    var isOpen = false;
    var closing = false;
    var inputEncoder = new TextEncoder();
    var writeQueue = [];
    var writeFlushPending = false;
    var resizeTimer = null;
    var linkProvider = null;
    var confirmVisible = false;
    var scrollBound = false;
    var touchLastY = null;

    function open() {
      if (isOpen) return;
      if (!state.ws) return;
      isOpen = true;
      closing = false;
      var modal = el(modalId);
      if (modal) modal.style.display = "grid";
      var container = el(containerId);
      if (container) container.innerHTML = "";
      createTerminalSession();
    }

    function requestClose() {
      if (!isOpen) return;
      showCloseConfirm();
    }

    function close() {
      if (!isOpen) return;
      hideCloseConfirm();
      isOpen = false;
      closing = true;
      disconnectWs();
      disposeTerm();
      var modal = el(modalId);
      if (modal) modal.style.display = "none";
      closeTab();
      createdTabId = null;
      createdPaneId = null;
      createdWorkspaceId = null;
    }

    function showCloseConfirm() {
      var modal = el(modalId);
      if (!modal) return;
      var confirm = modal.querySelector(".temp-terminal-confirm");
      if (!confirm) {
        confirm = document.createElement("div");
        confirm.className = "temp-terminal-confirm";
        confirm.innerHTML =
          '<div class="temp-terminal-confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="tempTerminalConfirmTitle" aria-describedby="tempTerminalConfirmMessage">' +
          '<h3 id="tempTerminalConfirmTitle">Close temporary terminal?</h3>' +
          '<p id="tempTerminalConfirmMessage">This will stop the temporary terminal session.</p>' +
          '<div class="temp-terminal-confirm-actions">' +
          '<button type="button" class="tab add temp-terminal-confirm-cancel">Cancel</button>' +
          '<button type="button" class="btn temp-terminal-confirm-close">Close</button>' +
          '</div></div>';
        modal.appendChild(confirm);
        confirm.querySelector(".temp-terminal-confirm-close").onclick = function () { close(); };
        confirm.querySelector(".temp-terminal-confirm-cancel").onclick = hideCloseConfirm;
      }
      confirmVisible = true;
      confirm.style.display = "grid";
      document.addEventListener("keydown", closeConfirmKeydown, true);
      var closeButton = confirm.querySelector(".temp-terminal-confirm-close");
      if (closeButton) closeButton.focus();
    }

    function hideCloseConfirm() {
      if (!confirmVisible) return;
      confirmVisible = false;
      document.removeEventListener("keydown", closeConfirmKeydown, true);
      var modal = el(modalId);
      var confirm = modal && modal.querySelector(".temp-terminal-confirm");
      if (confirm) confirm.style.display = "none";
      if (term) {
        try { term.focus(); } catch (e) {}
      }
    }

    function closeConfirmKeydown(event) {
      if (!confirmVisible) return;
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        hideCloseConfirm();
      }
    }

    function createTerminalSession() {
      if (!state.ws) { close(); return; }
      api("/api/tabs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspace_id: state.ws, label: "temp" }),
      }).then(function (res) {
        var tab = res && res.result && res.result.tab;
        if (!tab || !tab.tab_id) { close(); return; }
        if (!isOpen) {
          closeTabById(tab.tab_id);
          return;
        }
        createdTabId = tab.tab_id;
        createdWorkspaceId = state.ws;
        return findCreatedPane(0);
      }).then(function (pane) {
        if (!isOpen || !pane) return;
        if (!pane.terminal_id) { close(); return; }
        createdPaneId = pane.pane_id || null;
        connectTerminalWs(pane.terminal_id);
      }).catch(function () { close(); });
    }

    function findCreatedPane(attempt) {
      return api("/api/panes?workspace_id=" + encodeURIComponent(createdWorkspaceId || state.ws))
        .then(function (res) {
          var panes = (res.result && res.result.panes) || [];
          var pane = panes.find(function (p) { return p.tab_id === createdTabId; });
          if (pane || attempt >= 8) return pane || null;
          return new Promise(function (resolve) {
            setTimeout(function () { resolve(findCreatedPane(attempt + 1)); }, 100);
          });
        });
    }

    function connectTerminalWs(terminalId) {
      var container = el(containerId);
      if (!container) return;
      if (!term) {
        term = new Terminal({
          convertEol: false,
          cursorBlink: false,
          cursorInactiveStyle: "block",
          cursorStyle: "block",
          fontFamily: fontFamilyFn(),
          scrollback: 5000,
          theme: themeFn(),
        });
        term.open(container);
        term.onData(function (data) { sendInput(data); });
        if (term.attachCustomKeyEventHandler) {
          term.attachCustomKeyEventHandler(function (event) {
            if (
              event.type === "keydown" &&
              !event.altKey &&
              !event.ctrlKey &&
              !event.metaKey &&
              (event.key === "PageUp" || event.key === "PageDown")
            ) {
              scrollLines(
                event.key === "PageUp"
                  ? -Math.max(1, ((term && term.rows) || 24) - 1)
                  : Math.max(1, ((term && term.rows) || 24) - 1)
              );
              return false;
            }
            return true;
          });
        }
        bindScrollHandlers(container);
        try { term.focus(); } catch (e) {}
        refreshAfterFontLoad();
      }
      var size = fitTerminalToContainer(false);
      var cols = size.cols, rows = size.rows;
      var url = wsUrl(
        "/ws/terminal?terminal_id=" + encodeURIComponent(terminalId) +
        "&cols=" + cols + "&rows=" + rows +
        "&temporary_tab_id=" + encodeURIComponent(createdTabId || "")
      );
      var ws = new WebSocket(url);
      termWs = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = function () {
        if (termWs === ws && term) {
          fitTerminalToContainer(true);
          try { term.focus(); } catch (e) {}
        }
      };
      ws.onmessage = function (event) {
        if (termWs !== ws) return;
        enqueueFrame(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
      };
      ws.onclose = function () {
        if (termWs === ws) termWs = null;
        if (isOpen && !closing) {
          // Server-side terminal exited (e.g. user typed exit) or connection dropped.
          close();
        }
      };
    }

    function terminalFitSize() {
      var container = el(containerId);
      if (!container || !globalThis.HerdrTerminalScroll) return { cols: 80, rows: 24 };
      return globalThis.HerdrTerminalScroll.fitSize(container, term, { minCols: 1, minRows: 1 });
    }

    function fitTerminalToContainer(sendResize) {
      var size = terminalFitSize();
      if (term) {
        try { term.resize(size.cols, size.rows); } catch (e) {}
      }
      if (sendResize && termWs && termWs.readyState === 1) {
        try {
          termWs.send(JSON.stringify({ type: "resize", cols: size.cols, rows: size.rows }));
        } catch (e) {}
      }
      return size;
    }

    function refreshAfterFontLoad() {
      var fonts = globalThis.document && globalThis.document.fonts;
      if (!fonts || !fonts.load) return;
      Promise.all([
        fonts.load('14px "Herdr JetBrainsMono Nerd Font Mono"'),
        fonts.ready,
      ]).then(function () {
        if (!term || !isOpen) return;
        fitTerminalToContainer(true);
      }).catch(function () {});
    }

    function bindScrollHandlers(container) {
      if (scrollBound || !container) return;
      container.addEventListener("wheel", handleWheel, { passive: false, capture: true });
      container.addEventListener("touchstart", handleTouchStart, { passive: true, capture: true });
      container.addEventListener("touchmove", handleTouchMove, { passive: false, capture: true });
      container.addEventListener("touchend", handleTouchEnd, { passive: true, capture: true });
      container.addEventListener("touchcancel", handleTouchEnd, { passive: true, capture: true });
      scrollBound = true;
    }

    function sendBackendScroll(lines) {
      if (!termWs || termWs.readyState !== 1 || !Number.isFinite(lines) || lines === 0) return false;
      try {
        termWs.send(JSON.stringify({
          type: "scroll",
          direction: lines < 0 ? "up" : "down",
          lines: Math.max(1, Math.abs(Math.trunc(lines))),
        }));
        return true;
      } catch (e) {
        return false;
      }
    }

    function terminalUsesNormalBuffer() {
      return globalThis.HerdrTerminalScroll && globalThis.HerdrTerminalScroll.usesNormalBuffer(term);
    }

    function scrollLocal(direction, lines) {
      return !!(
        globalThis.HerdrTerminalScroll &&
        terminalUsesNormalBuffer() &&
        globalThis.HerdrTerminalScroll.scrollLocal(term, direction, lines)
      );
    }

    function scrollLines(lines) {
      if (!term || !Number.isFinite(lines) || lines === 0) return false;
      var signedLines = lines > 0 ? Math.max(1, Math.ceil(lines)) : Math.min(-1, Math.floor(lines));
      if (sendBackendScroll(signedLines)) return true;
      return scrollLocal(signedLines < 0 ? "up" : "down", Math.max(1, Math.abs(signedLines)));
    }

    function handleWheel(event) {
      if (!event || event.ctrlKey || event.metaKey || !event.deltaY) return;
      var helper = globalThis.HerdrTerminalScroll;
      if (!helper) return;
      var lines = helper.wheelLines(term, event, (term && term.rows) || 24);
      if (!scrollLines(event.deltaY < 0 ? -lines : lines)) return;
      event.preventDefault();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      else event.stopPropagation();
    }

    function handleTouchStart(event) {
      var touch = event && event.touches && event.touches.length === 1 ? event.touches[0] : null;
      touchLastY = touch ? touch.clientY : null;
    }

    function handleTouchMove(event) {
      var touch = event && event.touches && event.touches.length === 1 ? event.touches[0] : null;
      if (!touch || touchLastY === null) return;
      var deltaY = touchLastY - touch.clientY;
      touchLastY = touch.clientY;
      if (Math.abs(deltaY) < 4 || !globalThis.HerdrTerminalScroll) return;
      var lines = globalThis.HerdrTerminalScroll.touchLines(term, deltaY);
      if (!scrollLines(deltaY < 0 ? -lines : lines)) return;
      event.preventDefault();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      else event.stopPropagation();
    }

    function handleTouchEnd() {
      touchLastY = null;
    }

    function disconnectWs() {
      if (termWs) {
        termWs.onclose = null;
        try { termWs.close(); } catch (e) {}
        termWs = null;
      }
    }

    function disposeTerm() {
      writeQueue = [];
      writeFlushPending = false;
      if (linkProvider && linkProvider.dispose) {
        try { linkProvider.dispose(); } catch (e) {}
      }
      linkProvider = null;
      if (term) {
        try { term.dispose(); } catch (e) {}
        term = null;
      }
      var container = el(containerId);
      if (container) container.innerHTML = "";
    }

    function closeTab() {
      if (!createdTabId) return;
      var tabId = createdTabId;
      createdTabId = null;
      closeTabById(tabId);
    }

    function closeTabById(tabId) {
      if (!tabId) return;
      api("/api/tabs/" + encodeURIComponent(tabId) + "/close", { method: "POST" })
        .catch(function () {});
    }

    function sendInput(data) {
      if (!termWs || termWs.readyState !== 1 || !data) return;
      var bytes = inputEncoder.encode(data);
      if (bytes.length <= 64 * 1024 && termWs.bufferedAmount < 65536) {
        termWs.send(bytes);
        return;
      }
      var chunkSize = 16 * 1024;
      for (var i = 0; i < bytes.length; i += chunkSize)
        termWs.send(bytes.slice(i, i + chunkSize));
    }

    function enqueueFrame(data) {
      var size = typeof data === "string" ? data.length : data.length;
      if (!writeFlushPending && writeQueue.length === 0 && term && size <= 8192) {
        writeFrame(data);
        return;
      }
      writeQueue.push(data);
      if (writeFlushPending) return;
      writeFlushPending = true;
      requestAnimationFrame(flushFrames);
    }

    function flushFrames() {
      writeFlushPending = false;
      if (!writeQueue.length || !term) return;
      var frames = writeQueue;
      writeQueue = [];
      var data = frames.every(function (f) { return typeof f === "string"; })
        ? frames.join("")
        : coalesceBytes(frames);
      writeFrame(data);
    }

    function coalesceBytes(frames) {
      var encoded = frames.map(function (f) {
        return typeof f === "string" ? inputEncoder.encode(f) : f;
      });
      var total = encoded.reduce(function (s, f) { return s + f.length; }, 0);
      var merged = new Uint8Array(total);
      var off = 0;
      for (var i = 0; i < encoded.length; i++) {
        merged.set(encoded[i], off);
        off += encoded[i].length;
      }
      return merged;
    }

    function writeFrame(data) {
      if (!term) return;
      try { term.write(data); } catch (e) { try { term.write(data); } catch (e2) {} }
    }

    function isVisible() { return isOpen; }

    function handlePaneExited(paneId) {
      if (isOpen && paneId && createdPaneId === paneId) close();
    }

    function handleResize() {
      if (!isOpen || !term) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        if (!isOpen || !term) return;
        fitTerminalToContainer(true);
      }, 100);
    }

    return { open: open, requestClose: requestClose, close: close, isVisible: isVisible, handleResize: handleResize, handlePaneExited: handlePaneExited };
  }

  globalThis.HerdrTempTerminal = { create: createTempTerminal };
})();
