/**
 * Ephemeral temporary terminal overlay with multi-session support.
 *
 * Opens a modal with a fresh terminal renderer that connects to a new
 * Herdr tab/pane created via the existing tab.create API.  The terminal
 * is purely ephemeral: when the modal closes (X button, websocket drop,
 * or server-side pane.exited event) the tab is closed via tab.close and
 * all local state is discarded.  No server-side persistence is needed.
 *
 * Multiple temporary terminals can be open simultaneously.  Each gets
 * its own modal container and restore button.  When minimized, a
 * floating restore button appears showing Temp.[last_path_level]
 * (clamped to a configurable max length).
 *
 * Used by both desktop and mobile layouts.
 */
(function () {
  function tempTerminalLabelMaxChars() {
    try {
      var storage = globalThis.localStorage;
      var parsed = JSON.parse((storage && storage.getItem("herdr-web-options")) || "{}");
      return Math.max(4, Math.min(80, Number(parsed.tempTerminalLabelMaxChars) || 20));
    } catch (e) {
      return 20;
    }
  }

  function lastPathLevel(path) {
    if (!path) return "Terminal";
    var cleaned = String(path).replace(/\/+$/, "");
    if (!cleaned) return "Terminal";
    var parts = cleaned.split("/");
    return parts[parts.length - 1] || "Terminal";
  }

  function clampLabel(text, maxChars) {
    var max = maxChars || 20;
    if (!text) return "Terminal";
    if (text.length <= max) return text;
    return text.slice(0, max - 1) + "…";
  }

  function restoreLabelText(folder) {
    return clampLabel("Temp." + lastPathLevel(folder), tempTerminalLabelMaxChars());
  }

  function escapeHtmlAttr(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Manager that tracks all temporary terminal sessions and their
   * shared workspace.  Each session is created by createSession() and
   * owns its own DOM container, WebSocket, and tab state.
   */
  function createTempTerminalManager(opts) {
    var el = opts.el;
    var state = opts.state;
    var wsUrl = opts.wsUrl;
    var api = opts.api;
    var modalId = opts.modalId;
    var fontFamilyFn = opts.fontFamilyFn || function () { return "monospace"; };
    var themeFn = opts.themeFn || function () { return {}; };
    var defaultFolderFn = opts.defaultFolderFn || function () { return ""; };
    var workspaceIdFn = opts.workspaceIdFn || function () {
      if (state.ws) return state.ws;
      var workspaces = state.workspaces || [];
      return workspaces.length === 1 && workspaces[0] ? (workspaces[0].workspace_id || "") : "";
    };
    var shortcutLabelFn = opts.shortcutLabelFn || function () { return ""; };

    // Shared workspace state across all temp terminals.
    var sharedWorkspaceId = null;
    var sharedWorkspaceOwned = false;

    // Active sessions keyed by session id.
    var sessions = {};
    var sessionCounter = 0;
    var activeSessionId = null;

    // Restore buttons container.
    var restoreContainer = null;

    function ensureRestoreContainer() {
      if (restoreContainer) return restoreContainer;
      var doc = globalThis.document;
      if (!doc || !doc.createElement || !doc.body) return null;
      restoreContainer = doc.createElement("div");
      restoreContainer.className = "temp-terminal-restore-bar";
      restoreContainer.style.display = "none";
      doc.body.appendChild(restoreContainer);
      return restoreContainer;
    }

    function refreshRestoreContainer() {
      var container = ensureRestoreContainer();
      if (!container) return;
      var minimized = getMinimizedSessions();
      if (!minimized.length) {
        container.style.display = "none";
        container.innerHTML = "";
        return;
      }
      container.style.display = "flex";
      container.innerHTML = minimized.map(function (sess) {
        var label = escapeHtmlAttr(sess.restoreLabel());
        var title = escapeHtmlAttr(sess.shortcutTitle("Show temporary terminal"));
        return '<button type="button" class="temp-terminal-restore" data-session="' +
          escapeHtmlAttr(sess.id) + '" title="' + title + '" aria-label="' + title + '">' +
          '<span class="temp-terminal-restore-icon" aria-hidden="true">▣</span>' +
          '<span class="temp-terminal-restore-label">' + label + '</span></button>';
      }).join("");
      var buttons = container.querySelectorAll(".temp-terminal-restore");
      for (var i = 0; i < buttons.length; i++) {
        (function (btn) {
          btn.onclick = function () {
            var sid = btn.getAttribute("data-session");
            var sess = sessions[sid];
            if (sess) sess.restore();
          };
        })(buttons[i]);
      }
    }

    function getMinimizedSessions() {
      return Object.keys(sessions)
        .map(function (id) { return sessions[id]; })
        .filter(function (s) { return s.isOpen && s.isMinimized; })
        .sort(function (a, b) { return a.createdAt - b.createdAt; });
    }

    function getVisibleSession() {
      return Object.keys(sessions)
        .map(function (id) { return sessions[id]; })
        .filter(function (s) { return s.isOpen && !s.isMinimized; })
        .sort(function (a, b) { return b.createdAt - a.createdAt; })[0] || null;
    }

    function hasAnyOpen() {
      return Object.keys(sessions).some(function (id) { return sessions[id].isOpen; });
    }

    // ---- Session class (one per temporary terminal) ----

    function createSession(folder) {
      var sessionId = "tt-" + (++sessionCounter);
      var sess = createSessionInstance(sessionId, folder);
      sessions[sessionId] = sess;
      return sess;
    }

    function createSessionInstance(sessionId, folder) {
      var id = sessionId;
      var sess = null;
      var targetFolder = folder || "";
      var term = null;
      var termWs = null;
      var createdTabId = null;
      var createdPaneId = null;
      var isOpen = false;
      var isMinimized = false;
      var closing = false;
      var inputEncoder = new TextEncoder();
      var writeQueue = [];
      var writeFlushPending = false;
      var terminalQueryReplyState = {};
      var resizeTimer = null;
      var linkProvider = null;
      var confirmVisible = false;
      var keyTrapBound = false;
      var followPaused = false;
      var scrollBound = false;
      var createdAt = Date.now();
      var cdSent = false;

      // Each session creates its own modal and container DOM.
      var modal = null;
      var container = null;

      function ensureDom() {
        var doc = globalThis.document;
        if (!doc) return;
        // Create a session-specific modal element.
        modal = doc.createElement("div");
        modal.className = "modal-backdrop temp-terminal-backdrop";
        modal.id = modalId + "-" + id;
        modal.setAttribute("aria-hidden", "true");
        modal.innerHTML =
          '<div class="temp-terminal-modal" role="dialog" aria-modal="true">' +
          '<div class="temp-terminal-head">' +
          '<h2 id="tempTerminalTitle-' + id + '">Temporary terminal</h2>' +
          '<div class="temp-terminal-head-actions">' +
          '<span class="temp-terminal-hint">Input captured · Ctrl+G detaches</span>' +
          '<button class="temp-terminal-minimize" type="button">−</button>' +
          '<button class="temp-terminal-close" type="button">✕</button>' +
          '</div></div>' +
          '<div class="temp-terminal-body">' +
          '<button class="terminal-follow-button temp-terminal-follow" type="button" hidden>↓ Tail</button>' +
          '<div class="terminal"></div>' +
          '</div></div>';
        doc.body.appendChild(modal);

        container = modal.querySelector(".terminal");

        var minimizeBtn = modal.querySelector(".temp-terminal-minimize");
        if (minimizeBtn) minimizeBtn.onclick = minimize;
        setShortcutTitle(minimizeBtn, "Minimize temporary terminal");

        var closeBtn = modal.querySelector(".temp-terminal-close");
        if (closeBtn) closeBtn.onclick = requestClose;
      }

      function open() {
        if (isOpen) {
          if (isMinimized) restore();
          return;
        }
        // If another session is visible, minimize it first.
        var visible = getVisibleSession();
        if (visible && visible !== sess) visible.minimize();

        isOpen = true;
        closing = false;
        isMinimized = false;
        activeSessionId = id;
        ensureDom();
        if (modal) {
          modal.style.display = "grid";
          modal.removeAttribute("aria-hidden");
        }
        if (container) container.innerHTML = "";
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
        setFollowPaused(false);
        removeInputTrap();
        disconnectWs();
        disposeTerm();
        if (modal) {
          modal.style.display = "none";
          modal.setAttribute("aria-hidden", "true");
        }
        closeTab();
        createdTabId = null;
        createdPaneId = null;
        refreshRestoreContainer();
        if (activeSessionId === id) activeSessionId = null;
        // Remove session from registry after cleanup.
        delete sessions[id];
        // Remove modal DOM after a delay to allow closing animations.
        if (modal) {
          var modalRef = modal;
          setTimeout(function () {
            if (modalRef && modalRef.parentNode) modalRef.parentNode.removeChild(modalRef);
          }, 200);
        }
      }

      function showCloseConfirm() {
        if (!modal) return;
        var confirm = modal.querySelector(".temp-terminal-confirm");
        if (!confirm) {
          confirm = globalThis.document.createElement("div");
          confirm.className = "temp-terminal-confirm";
          confirm.innerHTML =
            '<div class="temp-terminal-confirm-card" role="alertdialog" aria-modal="true">' +
            '<h3>Close temporary terminal?</h3>' +
            '<p>This will stop the temporary terminal session.</p>' +
            '<div class="temp-terminal-confirm-actions">' +
            '<button type="button" class="tab add temp-terminal-confirm-cancel">Cancel</button>' +
            '<button type="button" class="btn temp-terminal-confirm-close">Close</button>' +
            '</div></div>';
          modal.appendChild(confirm);
          confirm.querySelector(".temp-terminal-confirm-close").onclick = close;
          confirm.querySelector(".temp-terminal-confirm-cancel").onclick = hideCloseConfirm;
        }
        confirmVisible = true;
        confirm.style.display = "grid";
        globalThis.document.addEventListener("keydown", closeConfirmKeydown, true);
        var closeButton = confirm.querySelector(".temp-terminal-confirm-close");
        if (closeButton) closeButton.focus();
      }

      function hideCloseConfirm() {
        if (!confirmVisible) return;
        confirmVisible = false;
        globalThis.document.removeEventListener("keydown", closeConfirmKeydown, true);
        if (modal) {
          var confirm = modal.querySelector(".temp-terminal-confirm");
          if (confirm) confirm.style.display = "none";
        }
        if (term) { try { term.focus(); } catch (e) {} }
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
        globalThis.document.addEventListener("keydown", tempTerminalKeydown, true);
        if (modal) {
          if (window.HerdrTerminalRenderer && window.HerdrTerminalRenderer.attachClickFocus) {
            window.HerdrTerminalRenderer.attachClickFocus(
              modal, focusTerminalSoon,
              function (event) { return isCloseControl(event && event.target); }
            );
          } else {
            modal.addEventListener("pointerdown", focusTerminalFromEvent, true);
          }
          modal.addEventListener("focusin", focusTerminalFromEvent, true);
        }
      }

      function removeInputTrap() {
        if (!keyTrapBound) return;
        keyTrapBound = false;
        globalThis.document.removeEventListener("keydown", tempTerminalKeydown, true);
        if (modal) {
          if (!window.HerdrTerminalRenderer || !window.HerdrTerminalRenderer.attachClickFocus) {
            modal.removeEventListener("pointerdown", focusTerminalFromEvent, true);
          }
          modal.removeEventListener("focusin", focusTerminalFromEvent, true);
        }
      }

      function tempTerminalKeydown(event) {
        if (!isOpen) return;
        var key = String(event.key || "");
        if (key === "Backspace" && !event.metaKey && !event.altKey && !event.ctrlKey) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!isMinimized && !confirmVisible && term) {
            focusTerminalSoon();
            sendInput("\x7f");
          }
          return;
        }
        if (key === "Tab" && !event.metaKey && !event.altKey && !event.ctrlKey) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!isMinimized && !confirmVisible && term) {
            focusTerminalSoon();
            sendInput(event.shiftKey ? "\x1b[Z" : "\t");
          }
          return;
        }
        if (key === "Escape" && !event.metaKey && !event.altKey && !event.ctrlKey && !confirmVisible) {
          event.preventDefault();
          event.stopImmediatePropagation();
          if (!isMinimized && term) {
            focusTerminalSoon();
            sendInput("\x1b");
          }
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
        var termElement = term.element || container;
        return !!(termElement && termElement.contains && termElement.contains(target));
      }

      function focusTerminalFromEvent(event) {
        if (isCloseControl(event && event.target)) return;
        if (event.type === "pointerdown" && event.button === 0 && !event.shiftKey) {
          var startX = event.clientX, startY = event.clientY;
          var dragged = false;
          var onMove = function (ev) {
            if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3)
              dragged = true;
          };
          var onUp = function () {
            globalThis.document.removeEventListener("mousemove", onMove);
            globalThis.document.removeEventListener("mouseup", onUp);
            if (!dragged) focusTerminalSoon();
          };
          globalThis.document.addEventListener("mousemove", onMove);
          globalThis.document.addEventListener("mouseup", onUp);
          return;
        }
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
          if (!isOpen) { closeTabById(tab.tab_id); return; }
          createdTabId = tab.tab_id;
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
        // Reuse the shared temp workspace if one already exists.
        if (sharedWorkspaceId) {
          return Promise.resolve(sharedWorkspaceId);
        }
        var workspaceId = preferredWorkspaceId();
        if (workspaceId) {
          sharedWorkspaceId = workspaceId;
          sharedWorkspaceOwned = false;
          return Promise.resolve(workspaceId);
        }
        var cwd = defaultFolderFn();
        if (!cwd) return Promise.resolve(null);
        return api("/api/workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label: "temp", cwd: cwd }),
        }).then(function (res) {
          var workspace = res && res.result && res.result.workspace;
          sharedWorkspaceId = workspace && workspace.workspace_id;
          sharedWorkspaceOwned = !!sharedWorkspaceId;
          return sharedWorkspaceId;
        });
      }

      function preferredWorkspaceId() {
        try { return workspaceIdFn() || ""; } catch (e) { return state.ws || ""; }
      }

      function findCreatedPane(attempt) {
        return api("/api/panes?workspace_id=" + encodeURIComponent(sharedWorkspaceId || state.ws))
          .then(function (res) {
            var panes = (res.result && res.result.panes) || [];
            var pane = panes.find(function (p) { return p.tab_id === createdTabId; });
            if (pane || attempt >= 8) return pane || null;
            return new Promise(function (resolve) {
              setTimeout(function () { resolve(findCreatedPane(attempt + 1)); }, 100);
            });
          });
      }

      function terminalGridSize(containerEl) {
        var measureTarget = containerEl.parentElement || containerEl;
        return HerdrTerminalFit.gridSize(measureTarget, term, {
          fallbackWidth: 720,
          fallbackHeight: 420,
          fallbackCell: { width: 9, height: 20 },
          minCols: 40,
          minRows: 8,
          rowReserve: 0,
        });
      }

      function connectTerminalWs(terminalId) {
        if (!container) return;
        ensureTerminalSurface(container).then(function () {
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
              // Send cd command if a specific folder was requested and
              // it differs from the workspace cwd.
              if (!cdSent && targetFolder) {
                cdSent = true;
                sendInput("cd " + shellQuote(targetFolder) + "\r");
              }
            };
            ws.onmessage = function (event) {
              if (termWs !== ws) return;
              enqueueFrame(typeof event.data === "string" ? event.data : new Uint8Array(event.data));
            };
            ws.onclose = function () {
              if (termWs === ws) termWs = null;
              if (isOpen && !closing) close();
            };
          });
        });
      }

      function shellQuote(path) {
        // Simple shell quoting: wrap in single quotes, escape internal quotes.
        var s = String(path);
        if (!s) return "''";
        if (/^[A-Za-z0-9_\-\/.:@+=,]+$/.test(s)) return s;
        return "'" + s.replace(/'/g, "'\\''") + "'";
      }

      function ensureTerminalSurface(containerEl) {
        if (term) return Promise.resolve(term);
        if (!globalThis.HerdrTerminalRenderer) return Promise.reject(new Error("terminal renderer unavailable"));
        return globalThis.HerdrTerminalRenderer.create(containerEl, {
          cols: 80,
          rows: 24,
          core: tempTerminalCore(),
          fontFamily: fontFamilyFn(),
          theme: themeFn(),
          links: true,
          scrollback: 5000,
          onData: function (data) { sendInput(data); },
        }).then(function (created) {
          term = created;
          bindTerminalScrollEvents(containerEl);
          try { term.focus(); } catch (e) {}
          refreshTerminalFitAfterFontLoad();
          return term;
        });
      }

      function waitForTerminalFit(containerEl, attempt, callback) {
        afterBrowserLayout(function () {
          if (!isOpen || !term) return;
          var size = terminalGridSize(containerEl);
          if (!terminalFitReady(containerEl, size) && attempt < 10) {
            setTimeout(function () { waitForTerminalFit(containerEl, attempt + 1, callback); }, 50);
            return;
          }
          callback(size);
        });
      }

      function terminalFitReady(containerEl, size) {
        var measureTarget = containerEl.parentElement || containerEl;
        var box = HerdrTerminalFit.visibleBox(measureTarget, { width: 0, height: 0 }) || { width: 0, height: 0 };
        var cell = HerdrTerminalFit.cellSize(term, containerEl, { width: 9, height: 20 });
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

      function setShortcutTitle(node, action) {
        if (!node) return;
        var title = shortcutTitle(action);
        node.title = title;
        node.setAttribute && node.setAttribute("aria-label", title);
      }

      function shortcutTitle(action) {
        var label = "";
        try { label = shortcutLabelFn() || ""; } catch (e) {}
        return label ? action + " (" + label + ")" : action;
      }

      function restoreLabel() {
        return restoreLabelText(targetFolder || defaultFolderFn());
      }

      function shortcutTitle(action) {
        var label = "";
        try { label = shortcutLabelFn() || ""; } catch (e) {}
        return label ? action + " (" + label + ")" : action;
      }

      function minimize() {
        if (!isOpen || isMinimized || confirmVisible) return;
        isMinimized = true;
        removeInputTrap();
        blurTerminalFocus();
        if (modal) {
          modal.style.display = "none";
          modal.setAttribute("aria-hidden", "true");
        }
        activeSessionId = null;
        refreshRestoreContainer();
      }

      function restore() {
        if (!isOpen) return;
        // Minimize any other visible session first.
        var visible = getVisibleSession();
        if (visible && visible !== sess) visible.minimize();
        isMinimized = false;
        activeSessionId = id;
        refreshRestoreContainer();
        if (modal) {
          modal.style.display = "grid";
          modal.removeAttribute("aria-hidden");
        }
        installInputTrap();
        HerdrTerminalFit.afterLayout(function () {
          handleResize();
          focusTerminalSoon();
        });
      }

      function blurTerminalFocus() {
        var doc = globalThis.document;
        var active = doc && doc.activeElement;
        if (!active || !tempTerminalOwnsEventTarget(active) || !active.blur) return;
        try { active.blur(); } catch (e) {}
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
        linkProvider = null;
        scrollBound = false;
        followPaused = false;
        if (term) {
          try { term.destroy(); } catch (e) {}
          term = null;
        }
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

      function tempTerminalCore() {
        try {
          var storage = globalThis.localStorage;
          var parsed = JSON.parse((storage && storage.getItem("herdr-web-options")) || "{}");
          return parsed.terminalCore === "ghostty" ? "ghostty" : "wterm";
        } catch (e) {
          return "wterm";
        }
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

      function terminalAtBottom() {
        try { return !term || !term.atBottom || term.atBottom(); }
        catch (e) { return true; }
      }

      function setFollowPaused(paused) {
        followPaused = !!paused;
        var button = modal && modal.querySelector(".terminal-follow-button");
        if (!button) return;
        button.hidden = !followPaused;
        button.setAttribute && button.setAttribute("aria-hidden", followPaused ? "false" : "true");
      }

      function scrollToTail() {
        setFollowPaused(false);
        try { if (term) term.scrollToBottom(); } catch (e) {}
        try { term.focus(); } catch (e) {}
      }

      function bindTerminalScrollEvents(containerEl) {
        if (scrollBound || !term || !term.element) return;
        scrollBound = true;
        var termEl = term.element;
        termEl.addEventListener("wheel", function (event) {
          if (event.ctrlKey || event.metaKey || !term) return;
          if (term.usesNormalBuffer && !term.usesNormalBuffer()) return;
          event.preventDefault();
          var rowH = term.rowHeight ? term.rowHeight() : 17;
          var lines = Math.max(1, Math.round(Math.abs(event.deltaY) / Math.max(1, rowH)));
          try { term.scrollLines(event.deltaY < 0 ? -lines : lines); } catch (e) {}
          setFollowPaused(!terminalAtBottom());
        }, { passive: false });
        termEl.addEventListener("scroll", function () {
          setFollowPaused(!terminalAtBottom());
        }, { passive: true });
        var button = modal && modal.querySelector(".terminal-follow-button");
        if (button) button.onclick = scrollToTail;
      }

      function maybeAutoScrollToBottom() {
        if (followPaused) return;
        try { if (term) term.scrollToBottom(); } catch (e) {}
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
        try { term.write(data, maybeAutoScrollToBottom); } catch (e) { try { term.write(data); maybeAutoScrollToBottom(); } catch (e2) {} }
        if (typeof globalThis.requestAnimationFrame === "function") {
          globalThis.requestAnimationFrame(maybeAutoScrollToBottom);
        }
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

      function resizeTerminalSurface(containerEl, cols, rows) {
        try { term.resize(cols, rows); } catch (e) {}
        fitTerminalDomToContainer(containerEl, cols, rows);
      }

      function fitTerminalDomToContainer(containerEl, cols, rows) {
        // Measure the parent (.temp-terminal-body) for available space, then
        // apply the available height to the terminal element so it fills
        // the full vertical space.  Critically, we align the DOM height to
        // rows * cellHeight to prevent the last row (where the cursor/input
        // lives) from being partially clipped or shifted below the visible
        // area.  This was the root cause of the input shifting bug.
        var parent = containerEl.parentElement;
        var box = HerdrTerminalFit.visibleBox(parent || containerEl, { width: 0, height: 0 }) || { width: 0, height: 0 };
        var cell = HerdrTerminalFit.cellSize(term, containerEl, { width: 9, height: 20 });
        // Compute the exact pixel height for the number of rows, so the
        // terminal DOM height matches the grid dimensions exactly.
        var alignedHeight = rows > 0 && cell.height > 0
          ? rows * cell.height
          : Math.floor(box.height || 0);
        var termEl = term && term.element ? term.element : containerEl.querySelector && containerEl.querySelector(".wterm");
        if (!termEl) termEl = containerEl;
        HerdrTerminalFit.fitTerminalToContainer(termEl, { height: alignedHeight });
      }

      return sess = {
        id: id,
        createdAt: createdAt,
        get isOpen() { return isOpen; },
        get isMinimized() { return isMinimized; },
        open: open,
        requestClose: requestClose,
        close: close,
        minimize: minimize,
        restore: restore,
        isVisible: isVisible,
        handleResize: handleResize,
        handlePaneExited: handlePaneExited,
        restoreLabel: restoreLabel,
        shortcutTitle: shortcutTitle,
      };
    }

    // ---- Manager-level public API ----

    function open(folder) {
      if (folder) {
        var sess = createSession(folder);
        sess.open();
        return sess;
      }
      // Without a specific folder: if a session is already visible, keep it.
      var visible = getVisibleSession();
      if (visible) return visible;
      // Otherwise, restore a minimized session or create new.
      var minimized = getMinimizedSessions();
      if (minimized.length) {
        minimized[minimized.length - 1].restore();
        return minimized[minimized.length - 1];
      }
      var sess2 = createSession("");
      sess2.open();
      return sess2;
    }

    function requestClose() {
      var sess = activeSessionId ? sessions[activeSessionId] : getVisibleSession();
      if (sess) sess.requestClose();
    }

    function close() {
      var sess = activeSessionId ? sessions[activeSessionId] : getVisibleSession();
      if (sess) sess.close();
    }

    function minimize() {
      var sess = getVisibleSession();
      if (sess) sess.minimize();
    }

    function restore() {
      // Restore the most recently minimized session.
      var minimized = getMinimizedSessions();
      if (minimized.length) minimized[minimized.length - 1].restore();
    }

    function isVisible() {
      return !!getVisibleSession();
    }

    function handleResize() {
      for (var id in sessions) {
        if (sessions[id].handleResize) sessions[id].handleResize();
      }
    }

    function handlePaneExited(paneId) {
      for (var id in sessions) {
        if (sessions[id].handlePaneExited) sessions[id].handlePaneExited(paneId);
      }
    }

    // Toggle: if a visible session exists, minimize it; otherwise open a new one.
    function toggle(folder) {
      var visible = getVisibleSession();
      if (visible) {
        visible.minimize();
        return null;
      }
      return open(folder);
    }

    return {
      open: open,
      requestClose: requestClose,
      close: close,
      minimize: minimize,
      restore: restore,
      isVisible: isVisible,
      handleResize: handleResize,
      handlePaneExited: handlePaneExited,
      toggle: toggle,
    };
  }

  globalThis.HerdrTempTerminal = {
    create: createTempTerminalManager,
    restoreLabelText: restoreLabelText,
    lastPathLevel: lastPathLevel,
    clampLabel: clampLabel,
  };
})();