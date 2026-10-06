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
    var closing = false;
    var sessionCounter = 0;

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
        '<div class="temp-overlay-modal" role="dialog" aria-modal="true">' +
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

    function createActive(folder) {
      var modal = ensureModal();
      active = { open: true, minimized: false, folder: folder, session: ++sessionCounter, handle: null, error: "" };
      modal.style.display = "grid";
      modal.removeAttribute("aria-hidden");
      closing = false;
      syncHead();
      refreshRestoreBar();
      renderSurface();
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
      modal.style.display = "none";
      modal.setAttribute("aria-hidden", "true");
      refreshRestoreBar();
    }

    function restore() {
      if (!active || !active.open || !active.minimized) return;
      active.minimized = false;
      var modal = ensureModal();
      modal.style.display = "grid";
      modal.removeAttribute("aria-hidden");
      refreshRestoreBar();
      if (active.onRestored) {
        var cb = active.onRestored;
        active.onRestored = null;
        try { cb(); } catch (e) {}
      }
    }

    function close() {
      if (!active || !active.open) return;
      closing = true;
      teardownSurface();
      active.open = false;
      active = null;
      var modal = ensureModal();
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
      currentFolder: function () { return active ? active.folder : ""; },
    };
  }

  globalThis.HerdrTempOverlay = {
    create: createTempOverlayTool,
    normalizeFolder: normalizeFolder,
    lastPathLevel: lastPathLevel,
    toolLabel: toolLabel,
    toolHint: toolHint,
  };
})();