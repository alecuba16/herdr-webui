/**
 * Shared temporary Files/Git overlay controller.
 *
 * Mirrors the temporary terminal overlay: a modal that opens a Files or Git
 * surface for a specific folder without creating a workspace or session.
 * The host layout provides per-tool callbacks that render the surface into
 * the overlay body; this module owns the chrome (title, folder, picker,
 * minimize/restore, close), the shared folder-picker flow, and the overlay
 * lifecycle.
 *
 * Multiple temporary surfaces can be minimized simultaneously. The restore
 * bar reuses the temporary terminal pill style so both overlay families
 * look alike. Used by both desktop and mobile layouts.
 */
(function () {
  function lastPathLevel(path) {
    if (!path) return "";
    var cleaned = String(path).replace(/\/+$/, "");
    if (!cleaned) return "";
    var parts = cleaned.split("/");
    return parts[parts.length - 1] || "";
  }

  function escapeHtmlAttr(text) {
    return String(text == null ? "" : text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function normalizeFolder(folder) {
    var text = String(folder || "").trim();
    if (!text || text === "/") return "/";
    return text.replace(/\/+$/, "") || "/";
  }

  var toolLabels = { files: "Files", git: "Git" };
  var toolHints = {
    files: "Temporary Files · browse any folder without opening a workspace",
    git: "Temporary Git · review any repository without opening a workspace",
  };

  // Document-level Escape capture, mirroring the temporary terminal's
  // input trap: while a temporary overlay is visible, Escape closes the
  // topmost one. The modal-subtree keydown alone cannot do this because
  // nothing focuses the overlay chrome on open (the terminal focuses its
  // surface; the drawers own focus once mounted). Capturing at document
  // level, after the drawers' own capture handlers, lets in-panel Esc
  // paths (context menus, commit modal, filters) consume the key first:
  // defaultPrevented events are ignored here.
  var escapeStack = [];
  var escapeTrapBound = false;

  function escapeTargetEditable(target) {
    if (!target || !target.tagName) return false;
    var tag = String(target.tagName).toLowerCase();
    return tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable === true;
  }

  function escapeTrap(event) {
    if (!escapeStack.length) return;
    if (event.defaultPrevented) return;
    if (event.key !== "Escape") return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (escapeTargetEditable(event.target)) return;
    // A stacked modal that is not one of ours (folder picker, workspace
    // modal) owns Escape: the overlays stay, the top modal dismisses.
    if (foreignModalVisible()) return;
    // Only a visible (not minimized) overlay owns Escape: a minimized pill
    // must let the key reach whatever the user is actually doing.
    var target = visibleTopmost();
    if (!target) return;
    // A visible temporary terminal stacked above the overlay (same
    // z-index, later in DOM) owns Escape: it forwards the key to the
    // shell, and registration order of the two document traps must not
    // decide this.
    if (tempTerminalAbove(target)) return;
    event.preventDefault();
    event.stopPropagation();
    if (target.close) target.close();
  }

  function overlayModalEl(entry) {
    if (!entry || !entry.modalId) return null;
    var d = globalThis.document;
    if (!d || !d.getElementById) return null;
    return d.getElementById(entry.modalId);
  }

  function tempTerminalAbove(entry) {
    var d = globalThis.document;
    if (!d || !d.querySelectorAll) return false;
    var terminals = d.querySelectorAll(".temp-terminal-backdrop");
    if (!terminals || !terminals.length) return false;
    var overlayModal = overlayModalEl(entry);
    for (var i = 0; i < terminals.length; i += 1) {
      var terminal = terminals[i];
      var display = terminal.style && terminal.style.display;
      if (!display || display === "none") continue;
      if (overlayModal && overlayModal.compareDocumentPosition) {
        // Node.DOCUMENT_POSITION_FOLLOWING (4): terminal is after the
        // overlay in DOM order, so with equal z-index it renders on top.
        var rel = overlayModal.compareDocumentPosition(terminal);
        if (rel & 4) return true;
      }
    }
    return false;
  }

  // Any visible modal that is not a temporary overlay: the key belongs to
  // that top modal instead. App modals (workspace/settings/terminal) open
  // with inline display "grid" and close with "none", so the inline style
  // is their visibility signal. The two folder pickers instead create and
  // remove their modal node per session, so node existence is their open
  // signal (the desktop picker never sets an inline display style).
  function foreignModalVisible() {
    var d = globalThis.document;
    if (!d || !d.querySelectorAll) return false;
    if (d.getElementById && (d.getElementById("directoryPickerModal") || d.getElementById("tempOverlayPickerModal"))) return true;
    var modals = d.querySelectorAll(".modal-backdrop, .temp-overlay-picker-backdrop, .directory-picker-backdrop");
    for (var i = 0; i < modals.length; i += 1) {
      var modal = modals[i];
      if (modal.id === "tempFilesOverlayModal" || modal.id === "tempGitOverlayModal") continue;
      if (modal.id === "tempTerminalModal" || (modal.id || "").indexOf("tempTerminalModal") === 0) continue;
      var display = modal.style && modal.style.display;
      if (display && display !== "none") return true;
    }
    return false;
  }

  function bindEscapeTrap() {
    if (escapeTrapBound) return;
    escapeTrapBound = true;
    var d = globalThis.document;
    if (d && d.addEventListener) d.addEventListener("keydown", escapeTrap, true);
  }

  function pushEscapeEntry(entry) {
    var index = escapeStack.indexOf(entry);
    if (index >= 0) escapeStack.splice(index, 1);
    escapeStack.push(entry);
    bindEscapeTrap();
  }

  function removeEscapeEntry(entry) {
    var index = escapeStack.indexOf(entry);
    if (index >= 0) escapeStack.splice(index, 1);
  }

  // The topmost entry must be a visible (not minimized) overlay. Stacking
  // is DOM order (equal z-index): the visible overlay whose modal is last
  // in document.body owns Escape. Minimized overlays never capture the key.
  function visibleTopmost() {
    var d = globalThis.document;
    var body = d && d.body;
    var children = (body && body.children) || [];
    // body.children is an HTMLCollection in a real browser (no indexOf).
    var indexOf = Array.prototype.indexOf;
    var top = null;
    var topIndex = -1;
    for (var i = 0; i < escapeStack.length; i += 1) {
      var entry = escapeStack[i];
      if (!entry.isVisible()) continue;
      var modal = overlayModalEl(entry);
      var index = modal ? indexOf.call(children, modal) : -1;
      if (index > topIndex) {
        top = entry;
        topIndex = index;
      }
    }
    return top;
  }

  function toolLabel(tool) {
    return toolLabels[tool] || "Files";
  }

  function toolHint(tool) {
    return toolHints[tool] || toolHints.files;
  }

  /**
   * Manager for one tool kind ("files" or "git").  Host options:
   * - openSurface(folder, surfaceEl, session): render the tool surface for
   *   folder into surfaceEl. Returns an optional handle; closeSurface gets
   *   it on teardown. `session` is an opaque token unique per open.
   * - closeSurface(session, handle): optional host cleanup hook.
   * - pickFolder(): open the host folder picker (returns a promise-like
   *   with .then, or a promise) resolving to a folder path or "".
   * - defaultFolderFn(): starting folder for a fresh surface.
   * - titleFn(folder): overlay title shown in the head.
   * - shortcutLabelFn(): label for restore-pill tooltips ("" allowed).
   * - modalIdPrefix: DOM id prefix, unique per layout.
   */
  function createTempOverlayTool(opts) {
    var tool = opts.tool || "files";
    var modalIdPrefix = opts.modalIdPrefix || "tempOverlay";
    var openSurface = opts.openSurface;
    var closeSurface = opts.closeSurface || null;
    var pickFolder = opts.pickFolder || null;
    var defaultFolderFn = opts.defaultFolderFn || function () { return ""; };
    var titleFn = opts.titleFn || function (folder) { return "Temporary " + toolLabel(tool) + (lastPathLevel(folder) ? " · " + lastPathLevel(folder) : ""); };
    var shortcutLabelFn = opts.shortcutLabelFn || function () { return ""; };

    var active = null;
    var restoreBar = null;
    var sessionCounter = 0;
    var escapeEntry = null;

    function doc() {
      return globalThis.document;
    }

    function isOpen() {
      return !!(active && active.open);
    }

    function isMinimized() {
      return !!(active && active.open && active.minimized);
    }

    function shortcutTitle(base) {
      var label = "";
      try { label = shortcutLabelFn() || ""; } catch (e) {}
      return label ? base + " (" + label + ")" : base;
    }

    function ensureRestoreBar() {
      var d = doc();
      if (!d || !d.createElement || !d.body) return null;
      if (restoreBar && restoreBar.parentNode === d.body) return restoreBar;
      restoreBar = d.createElement("div");
      restoreBar.className = "temp-overlay-restore-bar";
      restoreBar.style.display = "none";
      d.body.appendChild(restoreBar);
      return restoreBar;
    }

    function refreshRestoreBar() {
      var bar = ensureRestoreBar();
      if (!bar) return;
      if (!active || !active.open || !active.minimized) {
        bar.style.display = "none";
        bar.innerHTML = "";
        return;
      }
      bar.style.display = "flex";
      var title = escapeHtmlAttr(shortcutTitle("Show temporary " + toolLabel(tool).toLowerCase()));
      var label = escapeHtmlAttr(titleFn(active.folder));
      bar.innerHTML =
        '<button type="button" class="temp-overlay-restore" title="' + title + '" aria-label="' + title + '">' +
        '<span class="temp-overlay-restore-icon" aria-hidden="true">' + (tool === "git" ? "⑂" : "▤") + '</span>' +
        '<span class="temp-overlay-restore-label">' + label + '</span></button>';
      var button = bar.querySelector(".temp-overlay-restore");
      if (button) button.onclick = function () { restore(); };
    }

    function ensureModal() {
      var d = doc();
      var modal = d.getElementById(modalIdPrefix + "Modal");
      if (modal) return modal;
      modal = d.createElement("div");
      modal.id = modalIdPrefix + "Modal";
      modal.className = "modal-backdrop temp-overlay-backdrop";
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
      modal.innerHTML =
        '<div class="temp-overlay-modal" role="dialog" aria-modal="true" tabindex="-1">' +
        '<div class="temp-overlay-head">' +
        '<div class="temp-overlay-head-main">' +
        '<h2 class="temp-overlay-title"></h2>' +
        '<span class="temp-overlay-folder" title=""></span>' +
        '</div>' +
        '<div class="temp-overlay-head-actions">' +
        '<span class="temp-overlay-hint"></span>' +
        '<button class="temp-overlay-folder-btn" type="button">Change folder</button>' +
        '<button class="temp-overlay-minimize" type="button" title="Minimize">−</button>' +
        '<button class="temp-overlay-close" type="button" title="Close">✕</button>' +
        '</div></div>' +
        '<div class="temp-overlay-body"></div>' +
        '</div>';
      d.body.appendChild(modal);
      modal.querySelector(".temp-overlay-folder-btn").onclick = function () { chooseFolder(); };
      var minimizeBtn = modal.querySelector(".temp-overlay-minimize");
      minimizeBtn.onclick = function () { minimize(); };
      minimizeBtn.title = shortcutTitle("Minimize temporary " + toolLabel(tool).toLowerCase());
      minimizeBtn.setAttribute("aria-label", minimizeBtn.title);
      var closeBtn = modal.querySelector(".temp-overlay-close");
      closeBtn.onclick = function () { close(); };
      modal.addEventListener("keydown", function (event) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }, true);
      return modal;
    }

    function syncHead() {
      var modal = ensureModal();
      if (!active) return;
      var title = titleFn(active.folder);
      var titleEl = modal.querySelector(".temp-overlay-title");
      if (titleEl) titleEl.textContent = title;
      var folderEl = modal.querySelector(".temp-overlay-folder");
      if (folderEl) {
        folderEl.textContent = active.folder || "";
        folderEl.title = active.folder || "";
      }
      var hint = modal.querySelector(".temp-overlay-hint");
      if (hint) {
        var text = active.error ? "Cannot open this folder: " + active.error : toolHint(tool);
        hint.textContent = text;
        hint.classList.toggle("temp-overlay-hint-error", !!active.error);
      }
    }

    // Escape stack entry for this manager: while visible, document-level
    // Escape closes this overlay (see escapeTrap above).
    function ensureEscapeEntry() {
      if (!escapeEntry) {
        escapeEntry = {
          modalId: modalIdPrefix + "Modal",
          isVisible: function () { return isOpen() && !isMinimized(); },
          close: function () { close(); },
        };
      }
      pushEscapeEntry(escapeEntry);
    }

    // Open (or replace the folder of) the temporary surface. With no
    // folder argument: restore the minimized surface when one exists,
    // otherwise open a fresh one on the default folder.
    function open(folder) {
      var target = folder ? normalizeFolder(folder) : "";
      if (active && active.open) {
        if (active.minimized) restore();
        if (target && active.folder !== target) {
          swapFolder(target);
        }
        return active;
      }
      if (!target) target = normalizeFolder(defaultFolderFn());
      return createActive(target);
    }

    // Both overlays share z-index: appendChild re-raises this modal so the
    // most recently opened/restored overlay always stacks above the other.
    function raiseModal(modal) {
      if (!modal || !modal.parentNode || !modal.parentNode.appendChild) return;
      modal.parentNode.appendChild(modal);
    }

    // Terminal parity: the temporary terminal focuses its surface on open
    // so keyboard input lands inside the overlay; the overlay focuses its
    // dialog chrome the same way (Esc is handled at document level, focus
    // only restores a sane tab stop after close).
    function focusModal(modal) {
      var dialog = modal.querySelector(".temp-overlay-modal");
      if (dialog && typeof dialog.focus === "function") {
        try { dialog.focus(); } catch (e) {}
      }
    }

    // Release keyboard focus when the surface hides (minimize) or unmounts
    // (close): a focused node inside a display:none modal would leave the
    // app without a key target. Mirrors the terminal's blurTerminalFocus.
    function blurModalFocus(modal) {
      var d = doc();
      var focused = d && d.activeElement;
      if (!focused || !modal || !modal.contains || !modal.contains(focused)) return;
      if (focused && typeof focused.blur === "function") {
        try { focused.blur(); } catch (e) {}
      }
    }

    function createActive(folder) {
      var modal = ensureModal();
      active = { open: true, minimized: false, folder: folder, session: ++sessionCounter, handle: null, error: "" };
      ensureEscapeEntry();
      raiseModal(modal);
      modal.style.display = "grid";
      modal.removeAttribute("aria-hidden");
      syncHead();
      refreshRestoreBar();
      renderSurface();
      focusModal(modal);
      return active;
    }

    function renderSurface() {
      var modal = ensureModal();
      var body = modal.querySelector(".temp-overlay-body");
      if (!active || !body || !openSurface) return;
      body.innerHTML = "";
      active.error = "";
      var handle;
      var token = active.session;
      try {
        handle = openSurface(active.folder, body, token);
      } catch (e) {
        active.error = (e && e.message) || String(e);
        body.innerHTML = "";
        syncHead();
        return;
      }
      if (handle && typeof handle.then === "function") {
        handle.then(function (resolved) {
          if (!active || !active.open || active.session !== token) return;
          active.handle = resolved;
        }, function (err) {
          if (!active || !active.open || active.session !== token) return;
          active.error = (err && err.message) || String(err);
          syncHead();
        });
        return;
      }
      active.handle = handle === undefined ? null : handle;
    }
    function swapFolder(folder) {
      if (!active || !active.open) return;
      teardownSurface();
      active.folder = folder;
      active.error = "";
      syncHead();
      refreshRestoreBar();
      renderSurface();
    }

    function teardownSurface() {
      if (!active) return;
      if (closeSurface) {
        try { closeSurface(active.session, active.handle); } catch (e) {}
      }
      active.handle = null;
    }

    function minimize() {
      if (!active || !active.open || active.minimized) return;
      active.minimized = true;
      var modal = ensureModal();
      blurModalFocus(modal);
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
      refreshRestoreBar();
    }

    function restore() {
      if (!active || !active.open || !active.minimized) return;
      active.minimized = false;
      var modal = ensureModal();
      raiseModal(modal);
      modal.style.display = "grid";
      modal.removeAttribute("aria-hidden");
      ensureEscapeEntry();
      refreshRestoreBar();
      focusModal(modal);
    }

    function close() {
      if (!active || !active.open) return;
      teardownSurface();
      active.open = false;
      active = null;
      removeEscapeEntry(escapeEntry);
      var modal = ensureModal();
      blurModalFocus(modal);
      var body = modal.querySelector(".temp-overlay-body");
      if (body) body.innerHTML = "";
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
      refreshRestoreBar();
    }

    function chooseFolder() {
      if (!pickFolder) return;
      var picked;
      try {
        picked = pickFolder();
      } catch (e) {
        return;
      }
      if (!picked || typeof picked.then !== "function") {
        if (typeof picked === "string" && picked) swapFolder(normalizeFolder(picked));
        return;
      }
      picked.then(function (folder) {
        if (typeof folder === "string" && folder && active && active.open) swapFolder(normalizeFolder(folder));
      }, function () {});
    }

    function toggle(folder) {
      if (isOpen() && !isMinimized()) {
        minimize();
        return null;
      }
      return open(folder);
    }

    return {
      tool: tool,
      open: open,
      close: close,
      minimize: minimize,
      restore: restore,
      toggle: toggle,
      isOpen: isOpen,
      isMinimized: isMinimized,
      chooseFolder: chooseFolder,
      // Drawer-side folder change (the Git path title picker): the overlay
      // chrome must follow the surface it hosts, without re-rendering the
      // surface itself (the drawer already reset its own view).
      applyFolder: function (folder) {
        var text = String(folder || "").trim();
        if (!text) return;
        var target = normalizeFolder(text);
        if (!active || !active.open || active.folder === target) return;
        active.folder = target;
        active.error = "";
        syncHead();
        refreshRestoreBar();
      },
      currentFolder: function () { return active ? active.folder : ""; },
    };
  }

  globalThis.HerdrTempOverlay = {
    create: createTempOverlayTool,
    normalizeFolder: normalizeFolder,
    lastPathLevel: lastPathLevel,
    toolLabel: toolLabel,
    toolHint: toolHint,
    // True when a non-overlay modal (folder picker, workspace modal) is
    // visible: Escape belongs to that modal, not to a temporary overlay.
    // The desktop Git drawer needs this because its window-capture key
    // handler runs before the shared document-level escapeTrap.
    isForeignModalVisible: function () {
      return foreignModalVisible();
    },
    // Close the topmost visible temporary overlay. The desktop Git drawer
    // swallows every key at window-capture while its panel is mounted in
    // the Git overlay, so the shared document-level escapeTrap never sees
    // that key; git_ui's own Escape fallback calls this instead.
    closeTopmost: function () {
      var target = visibleTopmost();
      if (target && target.close) {
        target.close();
        return true;
      }
      return false;
    },
  };
})();
