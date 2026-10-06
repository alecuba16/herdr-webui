/**
 * Temporary Files/Git overlays (mobile layout).
 *
 * Hosts for the shared overlay controller (shared/temp_overlay.js). The
 * mobile drawers are factories, so each open creates a fresh instance with
 * `currentWorkspaceCwd` pinned to the chosen folder; closing the overlay drops
 * the instance, discarding all state without touching any workspace/session.
 *
 * The drawer markup calls three callback namespaces:
 * - `HerdrMobile.filesXxx` (screens and modals rendered by renderScreen),
 * - `HerdrMobileFiles.xxx` (tree rows, via Tree.renderEntries),
 * - git: `HerdrMobile.gitXxx` (same names the git factory emits).
 * `renderSurface` rewrites the first two to overlay-scoped namespaces
 * (`HerdrMobileTempFiles`/`HerdrMobileTempFilesTree`) so the main mobile
 * globals stay untouched; the git side reuses the exact factory names bound
 * to the fresh instance.
 *
 * The "Change folder" flow opens a small directory picker over the shared
 * tree API (/api/file-browser/tree?dirs_only=true).
 */
(function () {
  // renderScreen markup: HerdrMobile.<name> -> instance method (destructured
  // deps in app.js map filesXxx onto these).
  const FILES_METHODS = {
    filesToggle: "toggle",
    filesSelect: "select",
    filesUp: "up",
    filesRefresh: "refresh",
    filesBackToTree: "backToTree",
    filesRefreshFile: "refreshFile",
    filesStartEdit: "startEdit",
    filesCancelEdit: "cancelEdit",
    filesSaveFile: "saveFile",
    filesLoadPartial: "loadPartial",
    filesRowActions: "rowActions",
    filesOpenActionSheet: "rowActions",
    filesCloseActionSheet: "closeActionSheet",
    filesOpenRename: "openRename",
    filesSetRenameValue: "setRenameValue",
    filesCancelRename: "cancelRename",
    filesSubmitRename: "submitRename",
    filesDeletePath: "deletePath",
    filesOpenNewFile: "openNewFile",
    filesSetNewFileValue: "setNewFileValue",
    filesCancelNewFile: "cancelNewFile",
    filesSubmitNewFile: "submitNewFile",
    filesFilter: "filter",
    filesClearFilter: "clearFilter",
    filesSearchKeydown: "searchKeydown",
    filesShowSearch: "showSearch",
    filesCloseContentSearch: "closeContentSearch",
    filesLoadMore: "loadMore",
    filesFocusTree: "focusTree",
    filesBlurTree: "blurTree",
    filesToggleContentSearch: "toggleContentSearch",
    filesToggleFilterKind: "toggleFilterKind",
    filesTypeToFilter: "typeToFilter",
    filesScroll: "scroll",
  };
  // Tree row markup: HerdrMobileFiles.<name> -> instance method.
  const FILES_TREE_METHODS = ["toggle", "select", "up", "rowActions"];
  // Git markup: HerdrMobile.<name> -> instance method (names match exactly).
  const GIT_METHODS = [
    "loadGitStatus", "selectGitFile", "backGitFiles", "gitStageFile",
    "gitUnstageFile", "gitDiscardFile", "loadGitBranches", "gitSwitchBranch",
    "toggleGitBranches",
  ];

  function overlayManager() {
    return globalThis.HerdrTempOverlay;
  }

  function normalizeFolder(folder) {
    return overlayManager().normalizeFolder(folder);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Keyboard-guard attrs for template text inputs (shared/core.js owns the
  // same helper; this module renders before the app helpers may be present
  // in unit contexts, so keep a local copy with the same rules).
  function inputAttrs() {
    return ' autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" writingsuggestions="false" translate="no" enterkeyhint="search"';
  }

  function titleFor(tool, folder) {
    const last = overlayManager().lastPathLevel(folder);
    const label = overlayManager().toolLabel(tool);
    return last ? "Temporary " + label + " · " + last : "Temporary " + label;
  }

  /**
   * Point one callback namespace at the fresh drawer instance. Only names
   * that exist as functions on the instance get bound.
   */
  function bindNamespace(name, methods, instance) {
    const ns = {};
    if (Array.isArray(methods)) {
      for (const method of methods) {
        if (typeof instance[method] === "function") ns[method] = (...args) => instance[method](...args);
      }
    } else {
      for (const [name2, method] of Object.entries(methods)) {
        if (typeof instance[method] === "function") ns[name2] = (...args) => instance[method](...args);
      }
    }
    globalThis[name] = ns;
    return function unbind() {
      try { delete globalThis[name]; } catch (e) { globalThis[name] = undefined; }
    };
  }

  // Late-bound shared helpers (app.js installs the real implementations
  // after this module loads; these accessors read them at call time).
  function appApi(...args) { return globalThis.HerdrMobileApi(...args); }
  function appConfirm(...args) { return globalThis.HerdrMobileConfirm(...args); }
  function appJsArg(...args) { return globalThis.HerdrMobileJsArg(...args); }
  function appPathBasename(...args) { return globalThis.HerdrMobilePathBasename(...args); }

  function surfaceApi(url) {
    const http = globalThis.HerdrHttp;
    if (http) return http.request(url);
    return fetch(url, { credentials: "same-origin" }).then((res) => res.json());
  }

  // ---- Folder picker (small directory tree over the shared API) ----

  const picker = { active: false, resolve: null, cwd: "", path: "", entries: [], loading: false, error: "", filter: "" };

  function pickerCurrentPath() {
    const rel = String(picker.path || "").replace(/^\/+/, "");
    if (!picker.cwd) return rel ? "/" + rel : "/";
    return (picker.cwd.replace(/\/+$/, "") + "/" + rel).replace(/\/+$/, "") || "/";
  }

  function pickerJoin(path) {
    const text = String(path || "").trim();
    if (!text || text === "/") return "/";
    return normalizeFolder(text);
  }

  async function pickerLoad(path) {
    picker.path = path || "";
    picker.loading = true;
    picker.error = "";
    pickerRender();
    try {
      const data = await surfaceApi(
        "/api/file-browser/tree?cwd=" + encodeURIComponent(picker.cwd || "/") +
        "&path=" + encodeURIComponent(picker.path || "") + "&dirs_only=true",
      );
      picker.entries = (data && data.entries) || [];
      picker.loading = false;
    } catch (error) {
      picker.error = (error && error.message) || String(error);
      picker.entries = [];
      picker.loading = false;
    }
    pickerRender();
  }

  function pickerMatches(entry) {
    const needle = String(picker.filter || "").trim().toLowerCase();
    if (!needle) return true;
    return String(entry.path || "").toLowerCase().includes(needle)
      || String(entry.name || "").toLowerCase().includes(needle);
  }

  function pickerRender() {
    let modal = document.getElementById("tempOverlayPickerModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "tempOverlayPickerModal";
      modal.className = "temp-overlay-picker-backdrop";
      document.body.appendChild(modal);
    }
    modal.style.display = "grid";
    const currentPath = pickerCurrentPath();
    const entries = (picker.entries || []).filter(pickerMatches);
    const rows = entries.map((entry) => {
      const encoded = encodeURIComponent(entry.path || "");
      return `<button type="button" class="temp-overlay-picker-row" onclick="HerdrMobileTempOverlays.pickerEnter(${JSON.stringify(encoded)})"><strong>${escapeHtml(entry.name || entry.path)}</strong><span>${escapeHtml(entry.path || "")}</span></button>`;
    }).join("");
    const loading = picker.loading ? '<div class="mobile-loading">Loading</div>' : "";
    const error = picker.error ? `<div class="mobile-error">${escapeHtml(picker.error)}</div>` : "";
    const empty = !picker.loading && !entries.length && !picker.error ? '<div class="mobile-loading">No subfolders</div>' : "";
    modal.innerHTML =
      '<div class="temp-overlay-picker" role="dialog" aria-modal="true">' +
      '<div class="temp-overlay-picker-head"><strong>Choose folder</strong>' +
      '<button class="mobile-btn" onclick="HerdrMobileTempOverlays.pickerClose()">Close</button></div>' +
      `<div class="temp-overlay-picker-path">${escapeHtml(currentPath)}</div>` +
      '<div class="temp-overlay-picker-actions">' +
      '<button class="mobile-btn" onclick="HerdrMobileTempOverlays.pickerUp()">Up</button>' +
      `<button class="mobile-btn primary" onclick="HerdrMobileTempOverlays.pickerSelect()">Use this folder</button>` +
      "</div>" +
      error +
      '<div class="temp-overlay-picker-search"><input type="text" placeholder="Filter folders..."' + inputAttrs() + ' value="' + escapeHtml(picker.filter) + '" oninput="HerdrMobileTempOverlays.pickerFilter(this.value)"></div>' +
      `<div class="temp-overlay-picker-tree">${loading}${rows}${empty}</div>` +
      "</div>";
  }

  function pickerOpen(startFolder, resolve) {
    picker.active = true;
    picker.resolve = resolve;
    picker.cwd = normalizeFolder(startFolder || "/");
    picker.path = "";
    picker.filter = "";
    picker.entries = [];
    pickerLoad("");
  }

  function pickerDone(value) {
    picker.active = false;
    const resolve = picker.resolve;
    picker.resolve = null;
    const modal = document.getElementById("tempOverlayPickerModal");
    if (modal) modal.remove();
    if (resolve) resolve(value);
  }

  // ---- Overlay hosts ----

  const managers = { files: null, git: null };
  const surfaceState = {
    files: { instance: null, unbind: null, unbindTree: null },
    git: { instance: null, unbind: null },
  };

  function renderSurface(tool, bodyEl) {
    const surface = surfaceState[tool];
    if (!surface.instance || !bodyEl) return;
    // Render into a detached node, rewrite the callback namespaces in the
    // markup, then mount. The git screen renders itself into its argument,
    // so hand it the detached node and read back its innerHTML.
    const staging = document.createElement("div");
    let html;
    if (tool === "git") {
      surface.instance.renderGitScreen(staging);
      html = staging.innerHTML;
      bodyEl.innerHTML = String(html || "").replace(/HerdrMobile\./g, "HerdrMobileTempGit.");
      return;
    }
    html = surface.instance.renderScreen();
    bodyEl.innerHTML = String(html || "")
      .replace(/HerdrMobileFiles\./g, "HerdrMobileTempFilesTree.")
      .replace(/HerdrMobile\./g, "HerdrMobileTempFiles.");
  }

  function hostOptions(tool) {
    const isGit = tool === "git";
    return {
      tool,
      modalIdPrefix: isGit ? "tempGitOverlay" : "tempFilesOverlay",
      defaultFolderFn() {
        // Same fallback the temp terminal uses on mobile: the exploration
        // default folder from the shared state.
        const depsState = (globalThis.HerdrMobileAppDeps && globalThis.HerdrMobileAppDeps.state) || null;
        if (depsState && depsState.defaultFolder) return depsState.defaultFolder;
        return "";
      },
      titleFn(folder) { return titleFor(tool, folder); },
      shortcutLabelFn() { return ""; },
      pickFolder() {
        const active = managers[tool];
        return new Promise((resolve) => {
          pickerOpen(active ? active.currentFolder() : "/", resolve);
        });
      },
      openSurface(folder, surfaceEl) {
        const surface = surfaceState[tool];
        if (surface.instance) {
          if (surface.unbind) surface.unbind();
          if (surface.unbindTree) surface.unbindTree();
          surface.instance = null;
          surface.unbind = null;
          surface.unbindTree = null;
        }
        // Fresh state slice per overlay: the drawers mutate `state.gitStatus`
        // etc. directly, so give each surface its own object and never the
        // shared mobile state.
        const state = {};
        const bodyEl = document.createElement("div");
        bodyEl.className = "temp-overlay-surface";
        surfaceEl.appendChild(bodyEl);
        const render = () => renderSurface(tool, bodyEl);
        if (isGit) {
          surface.instance = globalThis.HerdrMobileGitModule.create({
            state,
            api: appApi,
            render,
            escapeHtml,
            jsArg: appJsArg,
            pathBasename: appPathBasename,
            currentWorkspaceCwd: () => folder,
            confirmFn: appConfirm,
          });
          surface.unbind = bindNamespace("HerdrMobileTempGit", GIT_METHODS, surface.instance);
        } else {
          surface.instance = globalThis.HerdrMobileFileBrowser.create({
            state,
            api: appApi,
            confirm: appConfirm,
            currentWorkspaceCwd: () => folder,
            escapeHtml,
            render,
          });
          surface.unbind = bindNamespace("HerdrMobileTempFiles", FILES_METHODS, surface.instance);
          surface.unbindTree = bindNamespace("HerdrMobileTempFilesTree", FILES_TREE_METHODS, surface.instance);
        }
        render();
        return null;
      },
      closeSurface() {
        const surface = surfaceState[tool];
        if (surface.unbind) surface.unbind();
        if (surface.unbindTree) surface.unbindTree();
        surface.unbind = null;
        surface.unbindTree = null;
        surface.instance = null;
      },
    };
  }

  function createManagers() {
    if (!overlayManager()) return managers;
    if (!managers.files) managers.files = overlayManager().create(hostOptions("files"));
    if (!managers.git) managers.git = overlayManager().create(hostOptions("git"));
    return managers;
  }

  function openFiles(folder) { createManagers(); return managers.files ? managers.files.open(folder) : null; }
  function openGit(folder) { createManagers(); return managers.git ? managers.git.open(folder) : null; }

  // app.js installs the shared helper globals (HerdrMobileApi etc.) after
  // this module loads; nothing to do here beyond staying order-independent.
  function bindAppHelpers() {}

  globalThis.HerdrMobileTempOverlays = {
    pickerClose: () => pickerDone(""),
    pickerEnter: (encodedPath) => pickerLoad(decodeURIComponent(encodedPath || "")),
    pickerUp: () => {
      const parent = pickerCurrentPath().replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/";
      picker.cwd = parent;
      picker.path = "";
      pickerLoad("");
    },
    pickerSelect: () => pickerDone(pickerJoin(pickerCurrentPath())),
    pickerFilter: (value) => {
      picker.filter = String(value || "");
      pickerRender();
    },
    create: createManagers,
    openFiles,
    openGit,
    closeFiles: () => { if (managers.files) managers.files.close(); },
    closeGit: () => { if (managers.git) managers.git.close(); },
    toggleFiles: (folder) => { createManagers(); return managers.files ? managers.files.toggle(folder) : null; },
    toggleGit: (folder) => { createManagers(); return managers.git ? managers.git.toggle(folder) : null; },
    bindAppHelpers,
    files: () => managers.files,
    git: () => managers.git,
  };
})();