/**
 * Mobile directory picker.
 *
 * Bottom sheet over the shared tree API (/api/file-browser/tree?dirs_only=1):
 * tap through folders, filter, jump Home / default dir, and either fill a
 * target input (worktree discover/create paths) or open the folder straight
 * as a workspace (POST /api/recent-workspaces, same route the recents list
 * uses). Parity piece for the desktop HerdrDirectoryPicker: the mobile
 * layout had only raw path text inputs, no way to browse the disk.
 */
(function () {
  function createMobileDirectoryPicker({
    api,
    escapeHtml,
    inputAttrs,
    jsArg,
    state,
    render,
    defaultFolderFn,
    // Optional: called with the folder path when the picker opened in
    // "workspace" mode and the user confirmed. Default implementation posts
    // the open-workspace request itself.
    openWorkspaceFn,
    // Optional: called with (field, folder) after a field-mode confirm;
    // lets the app chain a follow-up action (worktree discovery) so the
    // merged Choose-folder flow needs no second tap.
    onFieldPickFn,
  }) {
    const picker = {
      active: false,
      mode: "field", // "field" (write into state field) | "workspace" (open folder)
      field: "",
      root: "~",
      path: "",
      entries: [],
      loading: false,
      error: "",
      permissionRequired: false,
      filter: "",
      filterTimer: null,
    };
    // Guards the tree fetch against out-of-order responses: tapping folder A
    // then B quickly must never let A's slow reply overwrite B's listing.
    let loadSeq = 0;

    // ---- Path helpers (mirrors of the desktop split/join rules) ----

    function splitPath(value) {
      const text = String(value || "").trim();
      if (!text || text === "~" || text.startsWith("~/"))
        return { root: "~", path: text.replace(/^~\/?/, "") };
      if (text.startsWith("/")) return { root: "/", path: text.replace(/^\/+/, "") };
      return { root: "~", path: text };
    }

    function joinPath(root, path) {
      const rel = String(path || "").replace(/^\/+/, "");
      if (root === "/") return "/" + rel;
      return rel ? `${root.replace(/\/+$/, "")}/${rel}` : root;
    }

    function currentPath() {
      return joinPath(picker.root, picker.path);
    }

    function configuredDefaultFolder() {
      const fromState = typeof defaultFolderFn === "function" ? String(defaultFolderFn() || "").trim() : "";
      if (fromState && fromState !== "/") return fromState;
      try {
        const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
        const exploration = String(parsed.explorationDefaultDirectory || "").trim();
        if (exploration && exploration !== "/") return exploration;
      } catch (_) {}
      return "~";
    }

    function initialPath() {
      if (picker.mode === "workspace") return configuredDefaultFolder();
      const text = String(state[picker.field] || "").trim();
      return text && text !== "/" ? text : configuredDefaultFolder();
    }

    // ---- Open/close ----

    function openForField(field) {
      picker.active = true;
      picker.mode = "field";
      picker.field = String(field || "");
      openAt(initialPath());
    }

    function openForWorkspace() {
      picker.active = true;
      picker.mode = "workspace";
      picker.field = "";
      openAt(initialPath());
    }

    function openAt(value) {
      const parts = splitPath(value);
      picker.root = parts.root;
      picker.filter = "";
      clearTimeout(picker.filterTimer);
      pickerRender();
      load(parts.path || "");
    }

    function close() {
      picker.active = false;
      clearTimeout(picker.filterTimer);
      // The sheet is a body sibling of the backdrop, so remove both.
      for (const id of ["mobileDirectoryPickerBackdrop", "mobileDirectoryPickerSheet"]) {
        const node = document.getElementById(id);
        if (node && node.remove) node.remove();
        else if (node && node.parentNode) node.parentNode.removeChild(node);
      }
    }

    // ---- Data ----

    async function load(path) {
      picker.path = path || "";
      picker.error = "";
      picker.permissionRequired = false;
      picker.loading = true;
      const seq = ++loadSeq;
      pickerRender();
      try {
        const data = await api(
          `/api/file-browser/tree?cwd=${encodeURIComponent(picker.root)}&path=${encodeURIComponent(picker.path)}&dirs_only=true`,
        );
        if (seq !== loadSeq) return; // a newer navigation already landed
        picker.entries = data.entries || [];
      } catch (error) {
        if (seq !== loadSeq) return; // a newer navigation already landed
        picker.entries = [];
        picker.error = (error && error.message) || String(error);
        picker.permissionRequired = !!(error && error.details && error.details.permission_required);
      }
      picker.loading = false;
      pickerRender();
    }

    async function requestAccess() {
      try {
        const data = await api("/api/file-browser/request-access", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: picker.root, path: picker.path || "" }),
        });
        if (data.path) {
          const parts = splitPath(data.path);
          picker.root = parts.root;
        }
        await load(picker.path || "");
      } catch (error) {
        picker.error = (error && error.message) || String(error);
        picker.permissionRequired = false;
        pickerRender();
      }
    }

    // ---- Navigation ----

    function enter(encodedPath) {
      load(decodeURIComponent(encodedPath || ""));
    }

    function up() {
      if (picker.root === "~" && !picker.path) {
        picker.root = "/";
        picker.entries = [];
        load("");
        return;
      }
      if (picker.root === "/" && !picker.path) return;
      const parts = String(picker.path || "").split("/").filter(Boolean);
      parts.pop();
      load(parts.join("/"));
    }

    function home() {
      picker.root = "~";
      load("");
    }

    function defaultFolder() {
      const target = splitPath(configuredDefaultFolder());
      picker.root = target.root;
      load(target.path || "");
    }

    // ---- Filter ----

    function filter(value) {
      picker.filter = String(value || "");
      clearTimeout(picker.filterTimer);
      picker.filterTimer = setTimeout(() => pickerRender(), 180);
    }

    // ---- Confirm ----

    async function selectCurrent() {
      const folder = currentPath();
      if (picker.mode === "workspace") {
        const open = typeof openWorkspaceFn === "function" ? openWorkspaceFn : defaultOpenWorkspace;
        close();
        await open(folder);
        return;
      }
      const field = picker.field;
      close();
      if (!field) return;
      state[field] = folder;
      render();
      if (typeof onFieldPickFn === "function") onFieldPickFn(field, folder);
    }

    async function defaultOpenWorkspace(folder) {
      const path = String(folder || "").trim();
      if (!path) return;
      state.worktreeError = "";
      state.worktreeLoading = true;
      state.worktreeLoadingLabel = "Opening workspace...";
      render();
      try {
        const response = await api("/api/recent-workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, label: null }),
        });
        state.worktreeLoading = false;
        state.worktreeLoadingLabel = "";
        navigateToWorkspaceResult(response);
      } catch (error) {
        state.worktreeLoading = false;
        state.worktreeLoadingLabel = "";
        state.worktreeError = (error && error.message) || String(error);
        render();
      }
    }

    // worktree.open returns workspace + focused tab + root pane; navigate like
    // the recents open flow does (worktrees.js navigateToResult owns the
    // canonical version; this local copy keeps the picker self-contained for
    // unit tests while the app wires openWorkspaceFn in production).
    function navigateToWorkspaceResult(response) {
      const result = (response && response.result) || {};
      const workspace = result.workspace || {};
      const tab = result.tab || {};
      const pane = result.root_pane || {};
      if (!workspace.workspace_id) {
        render();
        return;
      }
      state.ws = workspace.workspace_id;
      state.tab = tab.tab_id || null;
      state.pane = pane.pane_id || null;
      state.screen = "terminal";
      try {
        const core = globalThis.HerdrMobileCore;
        if (core && globalThis.HerdrMobileSessionBackend) {
          // The app exposes the current backend through HerdrMobile;
          // fall back to the stored pin when unavailable (tests).
          const backend = (globalThis.HerdrMobile && globalThis.HerdrMobile.currentSessionBackend && globalThis.HerdrMobile.currentSessionBackend()) || core.readSessionBackend(state.session || "default");
          core.saveSessionSelection(state.session || "default", backend, {
            ws: state.ws,
            tab: state.tab,
            pane: state.pane,
          });
          history.pushState(null, "", core.selectionPath(state.session || "default", state.ws, state.tab, state.pane));
        }
      } catch (_) {}
      render();
    }

    // ---- Render ----

    function folderName() {
      const parts = String(picker.path || "").split("/").filter(Boolean);
      return parts[parts.length - 1] || picker.root;
    }

    function filterMatches(entry) {
      const needle = String(picker.filter || "").trim().toLowerCase();
      if (!needle) return true;
      return (
        String(entry.name || "").toLowerCase().includes(needle) ||
        String(entry.path || "").toLowerCase().includes(needle)
      );
    }

    function pickerRender() {
      if (!picker.active) return;
      let backdrop = document.getElementById("mobileDirectoryPickerBackdrop");
      if (!backdrop) {
        backdrop = document.createElement("div");
        backdrop.id = "mobileDirectoryPickerBackdrop";
        backdrop.className = "mobile-sheet-backdrop";
        backdrop.onclick = close;
        document.body.appendChild(backdrop);
      }
      let sheet = document.getElementById("mobileDirectoryPickerSheet");
      if (!sheet) {
        sheet = document.createElement("div");
        sheet.id = "mobileDirectoryPickerSheet";
        sheet.className = "mobile-sheet mobile-directory-picker";
        sheet.setAttribute("role", "dialog");
        sheet.setAttribute("aria-modal", "true");
        sheet.setAttribute("aria-label", "Choose folder");
        // Sibling of the backdrop, NOT its child: clicks inside the sheet
        // must not bubble into backdrop.onclick = close, or every row tap
        // would dismiss the picker before enter/selectCurrent can run.
        document.body.appendChild(sheet);
      }
      const canGoUp = !!picker.path || picker.root !== "/";
      const entries = (picker.entries || []).filter(filterMatches);
      const rows = entries
        .map((entry) => {
          const encoded = encodeURIComponent(entry.path || "");
          return `<button class="mobile-sheet-action mobile-directory-row" onclick="HerdrMobileDirectoryPicker.enter(${jsArg(encoded)})"><strong>${escapeHtml(entry.name || entry.path)}</strong><span>${escapeHtml(joinPath(picker.root, entry.path))}</span></button>`;
        })
        .join("");
      const loading = picker.loading ? '<div class="mobile-loading">Loading folders</div>' : "";
      const errorBlock = picker.error
        ? `<div class="mobile-error">${escapeHtml(picker.error)}${picker.permissionRequired ? `<button class="mobile-btn primary mobile-wide" onclick="HerdrMobileDirectoryPicker.requestAccess()">Grant folder access</button>` : ""}</div>`
        : "";
      const empty = !picker.loading && !entries.length && !picker.error
        ? '<div class="mobile-loading">No subfolders</div>'
        : "";
      const confirmLabel = picker.mode === "workspace" ? "Open folder as workspace" : "Use this folder";
      const title = picker.mode === "workspace" ? "Open folder" : `Choose folder for ${picker.field}`;
      // The rebuild below replaces the filter input node; remember focus and
      // caret so a re-render mid-typing (filter debounce, load finishing)
      // does not drop the mobile keyboard.
      const priorFilter = document.getElementById("mobileDirectoryPickerFilter");
      const hadFilterFocus = !!(priorFilter && document.activeElement === priorFilter);
      const priorCaret = hadFilterFocus && typeof priorFilter.selectionStart === "number" ? priorFilter.selectionStart : null;
      sheet.innerHTML =
        `<div class="mobile-sheet-handle"></div>` +
        `<div class="mobile-sheet-title">${escapeHtml(title)}</div>` +
        `<div class="mobile-directory-picker-path">${escapeHtml(currentPath())}</div>` +
        `<div class="mobile-directory-picker-actions">` +
        `<button class="mobile-btn" ${canGoUp ? "" : "disabled"} onclick="HerdrMobileDirectoryPicker.up()">Up</button>` +
        `<button class="mobile-btn" onclick="HerdrMobileDirectoryPicker.home()">Home</button>` +
        `<button class="mobile-btn" onclick="HerdrMobileDirectoryPicker.defaultFolder()">Default dir</button>` +
        `<button class="mobile-btn danger" onclick="HerdrMobileDirectoryPicker.close()">Cancel</button>` +
        `<button class="mobile-btn primary" onclick="HerdrMobileDirectoryPicker.selectCurrent()">${confirmLabel}</button>` +
        `</div>` +
        errorBlock +
        `<input id="mobileDirectoryPickerFilter" class="mobile-sheet-input" type="text" placeholder="Filter folders..." value="${escapeHtml(picker.filter)}"${inputAttrs("search")} oninput="HerdrMobileDirectoryPicker.filter(this.value)">` +
        `<div class="mobile-directory-picker-tree">${loading}${rows}${empty}</div>`;
      if (hadFilterFocus) {
        const nextFilter = document.getElementById("mobileDirectoryPickerFilter");
        if (nextFilter && typeof nextFilter.focus === "function") {
          nextFilter.focus({ preventScroll: true });
          if (priorCaret != null && typeof nextFilter.setSelectionRange === "function") {
            try {
              nextFilter.setSelectionRange(priorCaret, priorCaret);
            } catch (_) {}
          }
        }
      }
    }

    return {
      openForField,
      openForWorkspace,
      close,
      enter,
      up,
      home,
      defaultFolder,
      filter,
      selectCurrent,
      requestAccess,
      // test surface
      _picker: picker,
      currentPath,
      splitPath,
      joinPath,
    };
  }

  globalThis.HerdrMobileDirectoryPickerModule = { create: createMobileDirectoryPicker };
})();
