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
    var defaultFolderFn = opts.defaultFolderFn || function () { return ""; };

    var term = null;
    var termWs = null;
    var createdTabId = null;
    var createdPaneId = null;
    var createdWorkspaceId = null;
    var ownsWorkspace = false;
    var isOpen = false;
    var closing = false;
    var inputEncoder = new TextEncoder();
    var writeQueue = [];
    var writeFlushPending = false;
    var resizeTimer = null;
    var linkProvider = null;
    var confirmVisible = false;

    function open() {
      if (isOpen) return;
      if (!state.ws && !defaultFolderFn()) return;
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
      if (ownsWorkspace) closeWorkspaceById(createdWorkspaceId);
      createdWorkspaceId = null;
      ownsWorkspace = false;
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
      ensureWorkspaceForTempTerminal().then(function (workspaceId) {
        if (!workspaceId) { close(); return null; }
        return api("/api/tabs", {
        method: "POST",
        headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace_id: workspaceId, label: "temp" }),
        });
      }).then(function (res) {
        if (!res) return null;
        var tab = res && res.result && res.result.tab;
        if (!tab || !tab.tab_id) { close(); return; }
        if (!isOpen) {
          closeTabById(tab.tab_id);
          return;
        }
        createdTabId = tab.tab_id;
        createdWorkspaceId = createdWorkspaceId || state.ws;
        return findCreatedPane(0);
      }).then(function (pane) {
        if (!isOpen || !pane) return;
        if (!pane.terminal_id) { close(); return; }
        createdPaneId = pane.pane_id || null;
        connectTerminalWs(pane.terminal_id);
      }).catch(function () { close(); });
    }

    function ensureWorkspaceForTempTerminal() {
      if (state.ws) {
        createdWorkspaceId = state.ws;
        ownsWorkspace = false;
        return Promise.resolve(state.ws);
      }
      var cwd = defaultFolderFn();
      if (!cwd) return Promise.resolve(null);
      return api("/api/workspaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "temp", cwd: cwd }),
      }).then(function (res) {
        var workspace = res && res.result && res.result.workspace;
        createdWorkspaceId = workspace && workspace.workspace_id;
        ownsWorkspace = !!createdWorkspaceId;
        return createdWorkspaceId;
      });
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
        term.onData(function (data) { sendInput(data); });
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

    function closeWorkspaceById(workspaceId) {
      if (!workspaceId) return;
      api("/api/workspaces/" + encodeURIComponent(workspaceId) + "/close", { method: "POST" })
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
