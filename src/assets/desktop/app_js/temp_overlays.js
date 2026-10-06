/**
 * Temporary Files/Git overlay hosts (desktop layout).
 *
 * Bridges the shared overlay controller (shared/temp_overlay.js) with the
 * desktop singleton drawers (file_browser.js, git_ui.js). The drawers render
 * into #fileBrowserPanel/#gitUiPanel; the host re-parents that panel into the
 * overlay body and points the drawer at a pseudo workspace keyed by the
 * temporary ids, so no real workspace or session is ever created. Closing the
 * overlay calls forgetWorkspace(pseudo) which drops the drawer cache entry and
 * discards all state (temporary-terminal parity).
 *
 * The drawers hide/refit the main terminal shell through their
 * syncTerminalVisibility; while a temporary surface is mounted, a suppression
 * flag keeps the shell untouched (the overlay owns the viewport).
 */
(function () {
  const TEMP_FILES_KEY = "__temp_files__";
  const TEMP_GIT_KEY = "__temp_git__";

  let suppression = { files: false, git: false };
  let pendingPicker = null;

  function overlayManager() {
    return globalThis.HerdrTempOverlay;
  }

  function normalizeFolder(folder) {
    return overlayManager().normalizeFolder(folder);
  }

  function titleFor(tool, folder) {
    const last = overlayManager().lastPathLevel(folder);
    const label = overlayManager().toolLabel(tool);
    return last ? "Temporary " + label + " · " + last : "Temporary " + label;
  }

  /**
   * The pseudo workspace the drawers receive. Both drawer workspaceKey
   * helpers prefer workspace_id, so the temporary key caches apart from
   * every real workspace; workspaceCwd (HerdrWorkspacePath) returns the
   * chosen folder. A `label` keeps titles readable in drawer chrome.
   */
  function pseudoWorkspace(tool, folder) {
    return {
      workspace_id: tool === "git" ? TEMP_GIT_KEY : TEMP_FILES_KEY,
      label: "temp " + (tool === "git" ? "git" : "files"),
      cwd: folder,
    };
  }

  function drawerEnabled(tool) {
    if (tool === "git") {
      return typeof gitUiEnabled === "function" ? gitUiEnabled() !== false : true;
    }
    return true;
  }

  /**
   * Promise-based folder picker around the IIFE directory picker: a hidden
   * input carries the starting folder, the picker's change event resolves
   * the promise. The picker modal is created and removed per call, so no
   * state leaks between opens.
   */
  function pickFolder(startFolder) {
    const picker = window.HerdrDirectoryPicker;
    if (!picker) return Promise.resolve("");
    return new Promise((resolve) => {
      const previous = pendingPicker;
      pendingPicker = resolve;
      if (previous) previous("");
      const input = document.createElement("input");
      input.type = "text";
      input.style.display = "none";
      input.value = String(startFolder || "");
      const onChange = () => {
        cleanup();
        const value = normalizeFolder(input.value || "");
        const done = pendingPicker;
        pendingPicker = null;
        if (done) done(value);
      };
      const onRemoved = () => {
        // Picker closed without selecting (Close button or Esc path):
        // resolve empty so the overlay keeps its current folder.
        cleanup();
        const done = pendingPicker;
        pendingPicker = null;
        if (done) done("");
      };
      function cleanup() {
        input.removeEventListener("change", onChange);
        window.removeEventListener("herdrTempOverlayPickerClosed", onRemoved);
        if (input.parentNode) input.parentNode.removeChild(input);
      }
      input.addEventListener("change", onChange);
      window.addEventListener("herdrTempOverlayPickerClosed", onRemoved);
      document.body.appendChild(input);
      picker.open(input);
      // The picker has no close callback; poll for the modal disappearing
      // without a select so the promise always resolves.
      pollPickerGone("directoryPickerModal", onRemoved, 0);
    });
  }

  function pollPickerGone(id, onGone, attempt) {
    const modal = document.getElementById(id);
    if (!modal) {
      onRemovedResolved();
      return;
    }
    if (attempt > 600) {
      onRemovedResolved();
      return;
    }
    requestAnimationFrame(() => pollPickerGone(id, onGone, attempt + 1));
    function onRemovedResolved() {
      // Defer a tick: selectCurrent() dispatches change before close(), so
      // the change path must win; only a removal without change resolves "".
      setTimeout(onGone, 0);
    }
  }

  function tempOverlayPickerClosed() {
    window.dispatchEvent(new Event("herdrTempOverlayPickerClosed"));
  }

  // Signal from the directory picker close path (patched in below): lets the
  // promise resolve on the plain Close button too.
  if (window.HerdrDirectoryPicker) {
    const rawClose = window.HerdrDirectoryPicker.close;
    window.HerdrDirectoryPicker.close = function (...args) {
      const result = rawClose.apply(this, args);
      tempOverlayPickerClosed();
      return result;
    };
  }

  function sharedHostOptions(tool) {
    const actions = () => (tool === "git" ? window.HerdrGitUi : window.HerdrFileBrowser);
    const modalIdPrefix = tool === "git" ? "tempGitOverlay" : "tempFilesOverlay";
    return {
      tool,
      modalIdPrefix,
      defaultFolderFn() {
        const ws = selectedOrDefaultWorkspace();
        return (ws && workspacePath(ws)) || (typeof defaultFolderPath === "function" ? defaultFolderPath() : "") || "";
      },
      titleFn(folder) { return titleFor(tool, folder); },
      shortcutLabelFn() {
        const action = tool === "git" ? "tempGitToggle" : "tempFilesToggle";
        try { return shortcutLabel("webuiShortcuts", action) || ""; } catch (e) { return ""; }
      },
      pickFolder() {
        const active = managers[tool];
        return pickFolder(active ? active.currentFolder() : "");
      },
      async openSurface(folder, surfaceEl, session) {
        if (!drawerEnabled(tool)) throw new Error(tool === "git" ? "Git UI is disabled in settings" : "Files are disabled");
        const workspace = pseudoWorkspace(tool, folder);
        if (!workspace.cwd) throw new Error("no folder selected");
        const other = tool === "git" ? window.HerdrFileBrowser : window.HerdrGitUi;
        if (other && other.hide) other.hide();
        if (tool === "git") await ensureGitUiLoaded();
        else await ensureFileBrowserLoaded();
        const drawer = actions();
        if (!drawer) throw new Error("could not load the " + (tool === "git" ? "Git UI" : "file browser"));
        suppression[tool] = true;
        const result = drawer.open(workspace, { forceOpen: true });
        const panel = document.getElementById(tool === "git" ? "gitUiPanel" : "fileBrowserPanel");
        if (panel) surfaceEl.appendChild(panel);
        await result;
        // Both panels carry their own layout CSS (grid); just make sure a
        // previous hide() inline style is cleared.
        if (panel) panel.style.display = "";
        return { session, panel };
      },
      closeSurface(session, handle) {
        suppression[tool] = false;
        const drawer = actions();
        if (drawer && drawer.forgetWorkspace) {
          try { drawer.forgetWorkspace(pseudoWorkspace(tool, "").workspace_id); } catch (e) {}
        }
        if (handle && handle.panel && handle.panel.parentNode) {
          handle.panel.parentNode.removeChild(handle.panel);
        }
      },
    };
  }

  const managers = { files: null, git: null };

  function createManagers() {
    if (!overlayManager()) return managers;
    if (!managers.files) managers.files = overlayManager().create(sharedHostOptions("files"));
    if (!managers.git) managers.git = overlayManager().create(sharedHostOptions("git"));
    return managers;
  }

  function tempFilesOverlay() { return managers.files; }
  function tempGitOverlay() { return managers.git; }

  function anyTempOverlayOpen() {
    return !!(managers.files && managers.files.isOpen()) || !!(managers.git && managers.git.isOpen());
  }

  function anyTempOverlayVisible() {
    const open = (manager) => !!(manager && manager.isOpen && manager.isOpen());
    const minimized = (manager) => !!(manager && manager.isMinimized && manager.isMinimized());
    return !!(managers.files && open(managers.files) && !minimized(managers.files)) ||
      !!(managers.git && open(managers.git) && !minimized(managers.git));
  }

  // Suppression hooks consumed by the drawers' syncTerminalVisibility (the
  // patched bodies call these first): while a temporary surface is mounted
  // the main terminal shell stays untouched.
  function tempOverlaySuppressing() {
    return !!(suppression.files || suppression.git) || anyTempOverlayVisible();
  }

  function tempFilesSuppressing() { return !!suppression.files; }
  function tempGitSuppressing() { return !!suppression.git; }

  globalThis.HerdrTempOverlays = {
    create: createManagers,
    files: tempFilesOverlay,
    git: tempGitOverlay,
    openFiles(folder) { createManagers(); return managers.files ? managers.files.open(folder) : null; },
    openGit(folder) { createManagers(); return managers.git ? managers.git.open(folder) : null; },
    toggleFiles(folder) { createManagers(); return managers.files ? managers.files.toggle(folder) : null; },
    toggleGit(folder) { createManagers(); return managers.git ? managers.git.toggle(folder) : null; },
    closeFiles() { if (managers.files) managers.files.close(); },
    closeGit() { if (managers.git) managers.git.close(); },
    isOpen: anyTempOverlayOpen,
    isVisible: anyTempOverlayVisible,
    isMinimized() {
      const minimized = (manager) => !!(manager && manager.isMinimized && manager.isMinimized());
      return minimized(managers.files) || minimized(managers.git);
    },
    currentFolder(tool) {
      const manager = tool === "git" ? managers.git : managers.files;
      return manager ? manager.currentFolder() : "";
    },
    pickFolder,
    suppressing: tempOverlaySuppressing,
    suppressingFiles: tempFilesSuppressing,
    suppressingGit: tempGitSuppressing,
  };
})();