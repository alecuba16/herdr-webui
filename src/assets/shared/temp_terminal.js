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
    var closeId = opts.closeId;
    var fontFamilyFn = opts.fontFamilyFn || function () { return "monospace"; };
    var themeFn = opts.themeFn || function () { return {}; };
    var defaultFolderFn = opts.defaultFolderFn || function () { return ""; };
    var shortcutLabelFn = opts.shortcutLabelFn || function () { return ""; };

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
    var terminalQueryReplyState = {};
    var resizeTimer = null;
    var linkProvider = null;
    var confirmVisible = false;
    var keyTrapBound = false;
    var isMinimized = false;
    var restoreButton = null;

    function open() {
      if (isOpen) {
        if (isMinimized) restore();
        return;
      }
      if (!state.ws && !defaultFolderFn()) return;
      isOpen = true;
      closing = false;
      isMinimized = false;
      hideRestoreControl();
      var modal = el(modalId);
      if (modal) {
        modal.style.display = "grid";
        modal.removeAttribute && modal.removeAttribute("aria-hidden");
      }
      var container = el(containerId);
      if (container) container.innerHTML = "";
      installMinimizeControl();
      installInputTrap();
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
      isMinimized = false;
      closing = true;
      removeInputTrap();
      hideRestoreControl();
      disconnectWs();
      disposeTerm();
      var modal = el(modalId);
      if (modal) {
        modal.style.display = "none";
        modal.setAttribute && modal.setAttribute("aria-hidden", "true");
      }
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

    function installInputTrap() {
      if (keyTrapBound) return;
      keyTrapBound = true;
      document.addEventListener("keydown", tempTerminalKeydown, true);
      var modal = el(modalId);
      if (modal) {
        modal.addEventListener("pointerdown", focusTerminalFromEvent, true);
        modal.addEventListener("focusin", focusTerminalFromEvent, true);
      }
    }

    function removeInputTrap() {
      if (!keyTrapBound) return;
      keyTrapBound = false;
      document.removeEventListener("keydown", tempTerminalKeydown, true);
      var modal = el(modalId);
      if (modal) {
        modal.removeEventListener("pointerdown", focusTerminalFromEvent, true);
        modal.removeEventListener("focusin", focusTerminalFromEvent, true);
      }
    }

    function tempTerminalKeydown(event) {
      if (!isOpen) return;
      // Never let Backspace trigger browser "back" navigation or Tab steal focus
      // while the temp terminal is open, even if a confirm/minimized state would
      // otherwise drop the event. These two keys are the reported focus-loss bug.
      var key = String(event.key || "");
      if (key === "Backspace" && !event.metaKey && !event.altKey && !event.ctrlKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!isMinimized && !confirmVisible && term) sendInput("\x7f");
        return;
      }
      if (key === "Tab" && !event.metaKey && !event.altKey && !event.ctrlKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!isMinimized && !confirmVisible && term) sendInput(event.shiftKey ? "\x1b[Z" : "\t");
        return;
      }
      if (isMinimized || confirmVisible) return;
      if (event.ctrlKey && !event.altKey && !event.metaKey && String(event.key || "").toLowerCase() === "g") {
        event.preventDefault();
        event.stopImmediatePropagation();
        showCloseConfirm();
        return;
      }
      if (isCloseControl(event.target)) return;
      if (tempTerminalOwnsEventTarget(event.target)) {
        var ownedInput = terminalFocusRetainingInputForKey(event);
        if (ownedInput == null) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        focusTerminalSoon();
        sendInput(ownedInput);
        return;
      }
      var input = terminalInputForKey(event);
      if (input == null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      focusTerminalSoon();
      sendInput(input);
    }

    function isCloseControl(target) {
      return !!(target && target.closest && target.closest(".temp-terminal-close, .temp-terminal-minimize, .temp-terminal-restore, .temp-terminal-confirm"));
    }

    function tempTerminalOwnsEventTarget(target) {
      if (!target || !term) return false;
      var termElement = term.element || (el(containerId) && el(containerId).querySelector && el(containerId).querySelector(".xterm"));
      return !!(termElement && termElement.contains && termElement.contains(target));
    }

    function focusTerminalFromEvent(event) {
      if (isCloseControl(event && event.target)) return;
      focusTerminalSoon();
    }

    function focusTerminalSoon() {
      setTimeout(function () {
        if (!isOpen || isMinimized || confirmVisible || !term) return;
        try { term.focus(); } catch (e) {}
      }, 0);
    }

    function terminalFocusRetainingInputForKey(event) {
      if (event.metaKey || event.altKey || event.ctrlKey) return null;
      if (event.key === "Backspace") return "\x7f";
      if (event.key === "Tab") return event.shiftKey ? "\x1b[Z" : "\t";
      return null;
    }

    function terminalInputForKey(event) {
      if (event.metaKey || event.altKey) return null;
      if (event.ctrlKey) return null;
      switch (event.key) {
        case "Backspace": return "\x7f";
        case "Tab": return event.shiftKey ? "\x1b[Z" : "\t";
        case "Enter": return "\r";
        case "Escape": return "\x1b";
        case "Delete": return "\x1b[3~";
        case "ArrowUp": return "\x1b[A";
        case "ArrowDown": return "\x1b[B";
        case "ArrowRight": return "\x1b[C";
        case "ArrowLeft": return "\x1b[D";
        case "Home": return "\x1b[H";
        case "End": return "\x1b[F";
        case "PageUp": return "\x1b[5~";
        case "PageDown": return "\x1b[6~";
        default:
          return String(event.key || "").length === 1 ? event.key : null;
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
        connectTerminalWsAfterLayout(pane.terminal_id, 0);
      }).catch(function () { close(); });
    }

    function connectTerminalWsAfterLayout(terminalId, attempt) {
      afterBrowserLayout(function () {
        if (!isOpen) return;
        var container = el(containerId);
        var rect = container && container.getBoundingClientRect ? container.getBoundingClientRect() : null;
        var width = Math.max(0, (container && container.clientWidth) || (rect && rect.width) || 0);
        var height = Math.max(0, (container && container.clientHeight) || (rect && rect.height) || 0);
        if ((width < 320 || height < 120) && attempt < 8) {
          setTimeout(function () { connectTerminalWsAfterLayout(terminalId, attempt + 1); }, 50);
          return;
        }
        connectTerminalWs(terminalId);
        setTimeout(handleResize, 50);
        setTimeout(handleResize, 250);
      });
    }

    function afterBrowserLayout(callback) {
      HerdrTerminalFit.afterLayout(callback);
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

    function terminalGridSize(container) {
      return HerdrTerminalFit.gridSize(container, term, {
        fallbackWidth: 720,
        fallbackHeight: 420,
        fallbackCell: { width: 9, height: 20 },
        minCols: 40,
        minRows: 8,
        rowReserve: 1,
      });
    }

    function connectTerminalWs(terminalId) {
      var container = el(containerId);
      if (!container) return;
      ensureTerminalSurface(container);
      waitForTerminalFit(container, 0, function (size) {
        if (!isOpen || !term) return;
        var cols = size.cols, rows = size.rows;
        resizeTerminalSurface(container, cols, rows);
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
      });
    }

    function ensureTerminalSurface(container) {
      if (term) return;
      term = new Terminal({
        convertEol: false,
        fontFamily: fontFamilyFn(),
        scrollback: 5000,
        theme: themeFn(),
      });
      term.open(container);
      term.onData(function (data) { sendInput(data); });
      try { term.focus(); } catch (e) {}
      // xterm can blur its helper textarea during resize/write; re-grab focus
      // synchronously so Backspace/Tab never fall through to the background.
      var helperTextarea = term.textarea;
      if (helperTextarea && helperTextarea.addEventListener) {
        helperTextarea.addEventListener("blur", function () {
          if (!isOpen || isMinimized || confirmVisible || closing) return;
          // Don't steal focus back from the close-confirm buttons.
          var active = document.activeElement;
          if (active && isCloseControl(active)) return;
          if (active && active.closest && active.closest(".temp-terminal-confirm")) return;
          try { term.focus(); } catch (e) {}
        }, true);
      }
      refreshTerminalFitAfterFontLoad();
    }

    function waitForTerminalFit(container, attempt, callback) {
      afterBrowserLayout(function () {
        if (!isOpen || !term) return;
        var size = terminalGridSize(container);
        if (!terminalFitReady(container, size) && attempt < 10) {
          setTimeout(function () { waitForTerminalFit(container, attempt + 1, callback); }, 50);
          return;
        }
        callback(size);
      });
    }

    function terminalFitReady(container, size) {
      var box = HerdrTerminalFit.visibleBox(container, { width: 0, height: 0 }) || { width: 0, height: 0 };
      var cell = HerdrTerminalFit.cellSize(term, container, { width: 9, height: 20 });
      return box.width >= 320 && box.height >= 120 && cell.width >= 4 && cell.height >= 8 && size.cols >= 40;
    }

    function refreshTerminalFitAfterFontLoad() {
      var fonts = globalThis.document && globalThis.document.fonts;
      if (!fonts || !fonts.ready) return;
      fonts.ready.then(function () {
        if (!isOpen || isMinimized || !term) return;
        handleResize();
      }).catch(function () {});
    }

    function installMinimizeControl() {
      var modal = el(modalId);
      var button = modal && modal.querySelector && modal.querySelector(".temp-terminal-minimize");
      setShortcutTitle(button, "Minimize temporary terminal");
      if (button && !button.__herdrTempTerminalMinimizeBound) {
        button.__herdrTempTerminalMinimizeBound = true;
        button.onclick = minimize;
      }
      ensureRestoreControl();
    }

    function shortcutTitle(action) {
      var label = "";
      try { label = shortcutLabelFn() || ""; } catch (e) {}
      return label ? action + " (" + label + ")" : action;
    }

    function setShortcutTitle(node, action) {
      if (!node) return;
      var title = shortcutTitle(action);
      node.title = title;
      node.setAttribute && node.setAttribute("aria-label", title);
    }

    function ensureRestoreControl() {
      if (restoreButton) return restoreButton;
      var doc = globalThis.document;
      if (!doc || !doc.createElement || !doc.body) return null;
      restoreButton = doc.createElement("button");
      restoreButton.type = "button";
      restoreButton.className = "temp-terminal-restore";
      setShortcutTitle(restoreButton, "Show temporary terminal");
      restoreButton.innerHTML = '<span class="temp-terminal-restore-icon" aria-hidden="true">▣</span><span class="temp-terminal-restore-label">Terminal</span>';
      restoreButton.onclick = restore;
      restoreButton.style.display = "none";
      doc.body.appendChild(restoreButton);
      return restoreButton;
    }

    function showRestoreControl() {
      var button = ensureRestoreControl();
      if (button) {
        setShortcutTitle(button, "Show temporary terminal");
        button.style.display = "inline-flex";
      }
    }

    function hideRestoreControl() {
      if (restoreButton) restoreButton.style.display = "none";
    }

    function blurTerminalFocus() {
      var doc = globalThis.document;
      var active = doc && doc.activeElement;
      if (!active || !tempTerminalOwnsEventTarget(active) || !active.blur) return;
      try { active.blur(); } catch (e) {}
    }

    function minimize() {
      if (!isOpen || isMinimized || confirmVisible) return;
      isMinimized = true;
      removeInputTrap();
      blurTerminalFocus();
      var modal = el(modalId);
      if (modal) {
        modal.style.display = "none";
        modal.setAttribute && modal.setAttribute("aria-hidden", "true");
      }
      showRestoreControl();
    }

    function restore() {
      if (!isOpen) return;
      isMinimized = false;
      hideRestoreControl();
      var modal = el(modalId);
      if (modal) {
        modal.style.display = "grid";
        modal.removeAttribute && modal.removeAttribute("aria-hidden");
      }
      installInputTrap();
      HerdrTerminalFit.afterLayout(function () {
        handleResize();
        focusTerminalSoon();
      });
    }

    function disconnectWs() {
      terminalQueryReplyState = {};
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

    function terminalMouseReportingEnabled() {
      try {
        var storage = globalThis.localStorage;
        var parsed = JSON.parse((storage && storage.getItem("herdr-web-options")) || "{}");
        return parsed.terminalMouseReporting === true;
      } catch (e) {
        return false;
      }
    }

    function sendInput(data) {
      if (!termWs || termWs.readyState !== 1 || !data) return;
      if (globalThis.HerdrAppHelpers && globalThis.HerdrAppHelpers.stripTerminalMouseReports)
        data = globalThis.HerdrAppHelpers.stripTerminalMouseReports(data, terminalMouseReportingEnabled());
      if (globalThis.HerdrAppHelpers && globalThis.HerdrAppHelpers.stripTerminalQueryReplies)
        data = globalThis.HerdrAppHelpers.stripTerminalQueryReplies(data, terminalQueryReplyState);
      if (!data) return;
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
      resetMouseTrackingIfDisabled();
    }

    function resetMouseTrackingIfDisabled() {
      var helpers = globalThis.HerdrAppHelpers || {};
      if (typeof helpers.resetTerminalMouseTracking !== "function") return false;
      return helpers.resetTerminalMouseTracking(term, terminalMouseReportingEnabled());
    }

    function isVisible() { return isOpen && !isMinimized; }

    function handlePaneExited(paneId) {
      if (isOpen && paneId && createdPaneId === paneId) close();
    }

    function handleResize() {
      if (!isOpen || isMinimized || !term) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        resizeTimer = null;
        if (!isOpen || isMinimized || !term) return;
        var container = el(containerId);
        if (!container) return;
        var size = terminalGridSize(container);
        var cols = size.cols, rows = size.rows;
        resizeTerminalSurface(container, cols, rows);
        if (termWs && termWs.readyState === 1) {
          try {
            termWs.send(JSON.stringify({ type: "resize", cols: cols, rows: rows }));
          } catch (e) {}
        }
        if (!confirmVisible) { try { term.focus(); } catch (e) {} }
      }, 100);
    }

    function resizeTerminalSurface(container, cols, rows) {
      try { term.resize(cols, rows); } catch (e) {}
      fitTerminalDomToContainer(container);
    }

    function fitTerminalDomToContainer(container) {
      HerdrTerminalFit.fitXtermToContainer(container);
    }

    return { open: open, requestClose: requestClose, close: close, minimize: minimize, restore: restore, isVisible: isVisible, handleResize: handleResize, handlePaneExited: handlePaneExited };
  }

  globalThis.HerdrTempTerminal = { create: createTempTerminal };
})();
