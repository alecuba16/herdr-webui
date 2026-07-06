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
    var focusGuardsInstalled = false;
    var wheelBound = false;
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
      installFocusGuards();
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
      removeFocusGuards();
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
      var cols = 80, rows = 24;
      if (container.clientWidth && container.clientHeight) {
        cols = Math.max(40, Math.floor(container.clientWidth / 9));
        rows = Math.max(10, Math.floor(container.clientHeight / 18));
      }
      if (!term) {
        term = new Terminal({
          convertEol: false,
          fontFamily: fontFamilyFn(),
          scrollback: 5000,
          theme: themeFn(),
        });
        term.open(container);
        if (term.attachCustomKeyEventHandler) {
          term.attachCustomKeyEventHandler(handleTerminalKeyEvent);
        }
        term.onData(function (data) { sendInput(data); });
        bindScrollHandlers(container);
        try { term.focus(); } catch (e) {}
      }
      try { term.resize(cols, rows); } catch (e) {}
      var url = wsUrl(
        "/ws/terminal?terminal_id=" + encodeURIComponent(terminalId) +
        "&cols=" + cols + "&rows=" + rows +
        "&temporary_tab_id=" + encodeURIComponent(createdTabId || "")
      );
      var ws = new WebSocket(url);
      termWs = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = function () {
        if (termWs === ws && term) try { term.focus(); } catch (e) {}
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

    function handleTerminalKeyEvent(event) {
      if (!event || event.type !== "keydown") return true;
      if (confirmVisible) return false;
      if (event.altKey || event.ctrlKey || event.metaKey) return true;
      var key = event.key || "";
      var code = event.code || "";
      if (key === "Tab" || code === "Tab") {
        sendTerminalOwnedKey(event, event.shiftKey ? "\x1b[Z" : "\t");
        return false;
      }
      if (!event.shiftKey && (key === "Delete" || code === "Delete")) {
        sendTerminalOwnedKey(event, "\x1b[3~");
        return false;
      }
      if (!event.shiftKey && (key === "PageUp" || key === "PageDown")) {
        preventTerminalBrowserKey(event);
        scrollTerminalLines(key === "PageUp" ? -Math.max(1, (term && term.rows) || 24) : Math.max(1, (term && term.rows) || 24));
        return false;
      }
      return true;
    }

    function sendTerminalOwnedKey(event, data) {
      preventTerminalBrowserKey(event);
      focusTerminalSoon();
      sendInput(data);
    }

    function preventTerminalBrowserKey(event) {
      try { event.preventDefault(); } catch (e) {}
      try { event.stopPropagation(); } catch (e) {}
      if (event.stopImmediatePropagation) {
        try { event.stopImmediatePropagation(); } catch (e) {}
      }
    }

    function installFocusGuards() {
      if (focusGuardsInstalled) return;
      focusGuardsInstalled = true;
      document.addEventListener("keydown", captureTempTerminalKeydown, true);
      document.addEventListener("focusin", captureTempTerminalFocusIn, true);
      document.addEventListener("pointerdown", captureTempTerminalPointerDown, true);
    }

    function removeFocusGuards() {
      if (!focusGuardsInstalled) return;
      focusGuardsInstalled = false;
      document.removeEventListener("keydown", captureTempTerminalKeydown, true);
      document.removeEventListener("focusin", captureTempTerminalFocusIn, true);
      document.removeEventListener("pointerdown", captureTempTerminalPointerDown, true);
    }

    function tempModal() { return el(modalId); }

    function targetInCloseConfirm(target) {
      return !!(target && target.closest && target.closest(".temp-terminal-confirm"));
    }

    function targetIsCloseButton(target) {
      return !!(target && target.closest && target.closest("#" + closeId));
    }

    function targetInTerminal(target) {
      var container = el(containerId);
      return !!(container && target && container.contains(target));
    }

    function shouldTerminalOwnDocumentKey(event) {
      if (!isOpen || confirmVisible || !event || event.type !== "keydown") return false;
      if (event.altKey || event.ctrlKey || event.metaKey) return false;
      var target = event.target;
      if (targetInCloseConfirm(target) || targetIsCloseButton(target)) return false;
      if (targetInTerminal(target)) return false;
      var key = event.key || "";
      var code = event.code || "";
      return key === "Tab" || code === "Tab" || (!event.shiftKey && (key === "Delete" || code === "Delete"));
    }

    function captureTempTerminalKeydown(event) {
      if (!shouldTerminalOwnDocumentKey(event)) return;
      if ((event.key || event.code) === "Tab" || event.code === "Tab")
        sendTerminalOwnedKey(event, event.shiftKey ? "\x1b[Z" : "\t");
      else
        sendTerminalOwnedKey(event, "\x1b[3~");
    }

    function captureTempTerminalFocusIn(event) {
      if (!isOpen || confirmVisible) return;
      var modal = tempModal();
      if (!modal || !event.target || modal.contains(event.target)) return;
      focusTerminalSoon();
    }

    function captureTempTerminalPointerDown(event) {
      if (!isOpen || confirmVisible) return;
      var modal = tempModal();
      if (!modal || !event.target) return;
      if (targetIsCloseButton(event.target) || targetInTerminal(event.target)) return;
      if (!modal.contains(event.target) || event.target === modal || (event.target.closest && event.target.closest(".temp-terminal-head"))) {
        preventTerminalBrowserKey(event);
        focusTerminalSoon();
      }
    }

    function focusTerminalSoon() {
      if (!term) return;
      setTimeout(function () { if (isOpen && term && !confirmVisible) try { term.focus(); } catch (e) {} }, 0);
    }

    function bindScrollHandlers(container) {
      if (!container || wheelBound) return;
      wheelBound = true;
      container.addEventListener("wheel", handleTerminalWheel, { passive: false, capture: true });
      container.addEventListener("touchstart", handleTerminalTouchStart, { passive: true, capture: true });
      container.addEventListener("touchmove", handleTerminalTouchMove, { passive: false, capture: true });
      container.addEventListener("touchend", handleTerminalTouchEnd, { passive: true, capture: true });
      container.addEventListener("touchcancel", handleTerminalTouchEnd, { passive: true, capture: true });
    }

    function terminalCellHeight() {
      var dims = term && term._core && term._core._renderService && term._core._renderService.dimensions && term._core._renderService.dimensions.css && term._core._renderService.dimensions.css.cell;
      return Math.max(1, (dims && dims.height) || 17);
    }

    function wheelLines(event) {
      if (event.deltaMode === 1) return event.deltaY > 0 ? 3 : -3;
      if (event.deltaMode === 2) return event.deltaY > 0 ? ((term && term.rows) || 24) : -((term && term.rows) || 24);
      var lines = event.deltaY / terminalCellHeight();
      if (Math.abs(lines) < 1) return lines > 0 ? 1 : -1;
      return lines > 0 ? Math.ceil(lines) : Math.floor(lines);
    }

    function handleTerminalWheel(event) {
      if (!isOpen || !term || event.ctrlKey || event.metaKey) return;
      if (!scrollTerminalLines(wheelLines(event))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      focusTerminalSoon();
    }

    function handleTerminalTouchStart(event) {
      touchLastY = event.touches && event.touches.length === 1 ? event.touches[0].clientY : null;
    }

    function handleTerminalTouchMove(event) {
      if (!event.touches || event.touches.length !== 1 || touchLastY === null) return;
      var y = event.touches[0].clientY;
      var deltaY = touchLastY - y;
      touchLastY = y;
      var lines = deltaY / terminalCellHeight();
      var signed = lines > 0 ? Math.max(1, Math.ceil(lines)) : Math.min(-1, Math.floor(lines));
      if (!scrollTerminalLines(signed)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }

    function handleTerminalTouchEnd() {
      touchLastY = null;
    }

    function scrollTerminalLines(lines) {
      if (!term || !Number.isFinite(lines) || lines === 0) return false;
      var count = Math.max(1, Math.abs(Math.trunc(lines)));
      var sent = false;
      if (termWs && termWs.readyState === 1) {
        try {
          termWs.send(JSON.stringify({ type: "scroll", direction: lines < 0 ? "up" : "down", lines: count }));
          sent = true;
        } catch (e) {}
      }
      try { term.scrollLines(lines < 0 ? -count : count); } catch (e) {}
      return sent || true;
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
      touchLastY = null;
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
        var container = el(containerId);
        if (!container) return;
        var cols = Math.max(40, Math.floor(container.clientWidth / 9));
        var rows = Math.max(10, Math.floor(container.clientHeight / 18));
        try { term.resize(cols, rows); } catch (e) {}
        if (termWs && termWs.readyState === 1) {
          try {
            termWs.send(JSON.stringify({ type: "resize", cols: cols, rows: rows }));
          } catch (e) {}
        }
      }, 100);
    }

    return { open: open, requestClose: requestClose, close: close, isVisible: isVisible, handleResize: handleResize, handlePaneExited: handlePaneExited };
  }

  globalThis.HerdrTempTerminal = { create: createTempTerminal };
})();
