(function () {
  function createMobileWorktrees(deps) {
    const {
      api,
      currentSessionBackend,
      destroyTerminal,
      escapeHtml,
      inputAttrs,
      jsArg,
      refresh,
      render,
      saveSessionSelection,
      selectionPath,
      state,
      defaultFolderFn,
      // Confirm sheet for the worktree sheet's open action.
      confirmFn,
      // Selected workspace checkout path; pins the worktree sheet to
      // the repo it was opened for.
      currentCwdFn,
      // Routes the sheet's create button to the worktrees screen.
      showScreenFn,
    } = deps;
    const worktreeHelpers = globalThis.HerdrAppHelpers || {};
    const worktreeActivityLabel = worktreeHelpers.worktreeActivityLabel || (() => "Latest commit unknown");
    let recent = [];

    function renderScreen() {
      const source = state.worktreeSource || {};
      const sourcePath =
        source.source_checkout_path || source.cwd || source.repo_root || "";
      const rows = state.worktreeRows || [];
      if (!state.worktreeDiscoverPath && explorationDefaultDirectoryOption())
        state.worktreeDiscoverPath = explorationDefaultDirectoryOption();
      const createOpen = state.worktreeCreateExpanded ? " open" : "";
      const busy = !!state.worktreeLoading;
      const loading = busy ? `<div class="mobile-loading">${escapeHtml(state.worktreeLoadingLabel || "Working...")}</div>` : "";
      const pickFolder = (field, label) => `<button type="button" class="mobile-btn mobile-browse-btn" ${busy ? "disabled" : ""} onclick="HerdrMobile.browseDirectory(${jsArg(field)})" aria-label="Browse ${escapeHtml(label)}">Browse</button>`;
      const discovered = !!(state.worktreeDiscoverPath.trim() && (rows.length || state.worktreeSource));
      return `<section class="mobile-section mobile-form mobile-worktree-flow"><h2>Worktrees</h2><div class="mobile-settings-group"><h3>Choose folder</h3><p class="mobile-help">Pick any repo or worktrees folder. herdr discovers linked worktrees inside it and offers to open the folder, open a worktree, or create a new checkout.</p><label><span>Repo or worktrees folder</span><input value="${escapeHtml(state.worktreeDiscoverPath)}"${inputAttrs()} oninput="HerdrMobile.updateWorktreeField('worktreeDiscoverPath', this.value)" placeholder="~/Documents/code/repo-or-worktrees">${pickFolder("worktreeDiscoverPath", "repo or worktrees folder")}</label><button class="mobile-btn primary mobile-wide" ${busy ? "disabled" : ""} onclick="HerdrMobile.loadWorktrees()">${busy && state.worktreeLoadingLabel === "Discovering worktrees..." ? "Discovering..." : "Find worktrees"}</button>${loading}${state.worktreeError ? `<div class="mobile-error">${escapeHtml(state.worktreeError)}</div>` : ""}</div>${discovered || state.worktreeError ? `<div class="mobile-settings-group"><h3>Results</h3><div class="mobile-worktree-source"><strong>${escapeHtml(source.repo_name || "Current workspace repo")}</strong><span>${escapeHtml(sourcePath || state.worktreeDiscoverPath)}</span><button class="mobile-btn primary" ${busy ? "disabled" : ""} onclick="HerdrMobile.openFolderAsWorkspace(${jsArg(state.worktreeDiscoverPath)})">${busy && state.worktreeLoadingLabel === "Opening workspace..." ? "Opening..." : "Open as workspace"}</button></div><div class="mobile-worktree-list">${rows.length ? rows.map((row, index) => renderRow(row, index)).join("" ) : '<div class="mobile-loading">No linked worktrees found in this folder</div>'}</div></div>` : ""}<details class="mobile-settings-group mobile-disclosure"${createOpen} onchange="HerdrMobile.setWorktreeCreateExpanded(this.open)"><summary>Create new worktree</summary><label><span>Branch name</span><input value="${escapeHtml(state.worktreeBranch)}"${inputAttrs()} oninput="HerdrMobile.updateWorktreeField('worktreeBranch', this.value)" placeholder="feature/my-branch"></label><label><span>Base branch</span><input value="${escapeHtml(state.worktreeBase)}"${inputAttrs()} oninput="HerdrMobile.updateWorktreeField('worktreeBase', this.value)" placeholder="HEAD or main"></label><label><span>Label</span><input value="${escapeHtml(state.worktreeLabel)}"${inputAttrs()} oninput="HerdrMobile.updateWorktreeField('worktreeLabel', this.value)" placeholder="optional"></label><label><span>Checkout path</span><input value="${escapeHtml(state.worktreePath)}"${inputAttrs()} oninput="HerdrMobile.updateWorktreeField('worktreePath', this.value)" placeholder="backend default if blank">${pickFolder("worktreePath", "checkout path")}</label><button class="mobile-btn primary mobile-wide" ${busy ? "disabled" : ""} onclick="HerdrMobile.createWorktree()">${busy && state.worktreeLoadingLabel === "Creating worktree..." ? "Creating..." : "Create and open"}</button></details><details class="mobile-settings-group mobile-disclosure"><summary>Recent workspaces</summary><div class="mobile-worktree-list">${renderRecentSection()}</div></details></section>`;
    }

    function renderRow(row, index) {
      const title =
        pathBasename(row.path) || row.label || row.branch || "worktree";
      const meta = `${repoLabel(row)} · ${worktreeActivityLabel(row)}`;
      const busy = !!state.worktreeLoading;
      const opening = state.worktreeBusyIndex === index && state.worktreeLoadingLabel === "Opening worktree...";
      return `<div class="mobile-worktree-row"><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(meta)}</small></span><button class="mobile-btn primary" ${busy ? "disabled" : ""} onclick="HerdrMobile.openWorktree(${index})">${opening ? "Opening..." : "Open"}</button></div>`;
    }

    function openPaths() {
      const workspaces = state.workspaces || [];
      const paths = workspaces.map(
        (workspace) =>
          (workspace.worktree && workspace.worktree.checkout_path) ||
          workspace.cwd ||
          workspace.path ||
          "",
      );
      return new Set(paths.filter(Boolean));
    }

    function samePath(a, b) {
      return String(a || "").replace(/\/+$/, "") === String(b || "").replace(/\/+$/, "");
    }

    function recentCandidates() {
      const open = openPaths();
      return (recent || [])
        .filter((item) => item && item.path)
        .filter((item, index, list) => list.findIndex((other) => samePath(other.path, item.path)) === index)
        .map((item) => ({ ...item, isOpen: recentIsOpen(open, item.path) }))
        .slice(0, 8);
    }

    function recentIsOpen(open, path) {
      for (const candidate of open) {
        if (samePath(candidate, path)) return true;
      }
      return false;
    }

    function renderRecentSection() {
      const rows = recentCandidates();
      if (!rows.length)
        return '<div class="mobile-loading">No recent workspaces yet</div>';
      return `${rows.map((item) => renderRecentRow(item)).join("")}<button class="mobile-btn mobile-wide" onclick="HerdrMobile.clearRecentWorkspaces()">Clear recent list</button>`;
    }

    function renderRecentRow(item) {
      // The server stamps title/kind_label on recent rows (the wrapper's
      // recent-workspaces enrichment); the local derivations stay as the
      // fallback for rows from an older server.
      const title =
        item.title || item.label || pathBasename(item.path) || item.path;
      const kind =
        item.kind_label ||
        (item.kind === "worktree" ? "worktree" : "workspace");
      const meta = [kind, item.branch, item.path].filter(Boolean).join(" · ");
      const open = !!item.isOpen;
      return `<div class="mobile-worktree-row${open ? " mobile-recent-open" : ""}"><span><strong>${escapeHtml(title)}${open ? " (already open)" : ""}</strong><small>${escapeHtml(meta)}</small></span><span class="mobile-recent-actions"><button class="mobile-btn primary"${open ? ' title="This workspace is already open" disabled' : ""} onclick="HerdrMobile.openRecentWorkspace(${jsArg(item.path)})">Open</button><button class="mobile-btn" title="Remove from recent list" onclick="HerdrMobile.removeRecentWorkspace(${jsArg(item.path)})">✕</button></span></div>`;
    }

    async function loadRecent() {
      if (loadRecent.inflight) return;
      loadRecent.inflight = true;
      try {
        const data = await api("/api/recent-workspaces");
        recent = Array.isArray(data.recent) ? data.recent : [];
      } catch (_) {
        recent = [];
      } finally {
        loadRecent.inflight = false;
      }
      if (state.screen === "worktrees") render();
    }

    async function openRecent(pathArg) {
      const path = String(pathArg || "");
      const item = (recent || []).find((entry) => entry && entry.path === path);
      if (!path || !item) return;
      state.worktreeError = "";
      setLoading(true, "Opening workspace...");
      try {
        const response = await api("/api/recent-workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, label: item.label || null, open_terminal: workspaceOpenTerminalFlag() }),
        });
        recent = [];
        navigateToResult(response);
        loadRecent();
      } catch (error) {
        state.worktreeError = error.message || String(error);
        setLoading(false);
        render();
      }
    }

    async function removeRecent(pathArg) {
      const path = String(pathArg || "");
      if (!path) return;
      try {
        await api("/api/recent-workspaces/remove", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path }),
        });
      } catch (_) {}
      recent = (recent || []).filter((item) => !samePath(item && item.path, path));
      render();
    }

    async function clearRecent() {
      try {
        await api("/api/recent-workspaces/clear", { method: "POST" });
      } catch (_) {}
      recent = [];
      render();
    }

    function setLoading(show, label = "Working...", index = null) {
      state.worktreeLoading = !!show;
      state.worktreeLoadingLabel = show ? label : "";
      state.worktreeBusyIndex = Number.isInteger(index) ? index : null;
      render();
    }

    function repoLabel(row) {
      const value =
        row.source_repo_name || row.repo_name || row.source_repo_root || "";
      return pathBasename(value) || value || "repo";
    }

    function pathBasename(path) {
      const parts = String(path || "")
        .replace(/\/+$/, "")
        .split("/")
        .filter(Boolean);
      return parts.length ? parts[parts.length - 1] : "";
    }

    function explorationDefaultDirectoryOption() {
      const defaultFolder = typeof defaultFolderFn === "function" ? String(defaultFolderFn() || "").trim() : "";
      if (defaultFolder) return defaultFolder;
      try {
        const parsed = globalThis.HerdrOptions
          ? globalThis.HerdrOptions.read()
          : {};
        return String(parsed.explorationDefaultDirectory || "").trim() || "~";
      } catch (_) {
        return "~";
      }
    }

    // Shared flag for every workspace-open call from this screen: the
    // workspace opens with a terminal only when the desktop/mobile option
    // says so (default off).
    function workspaceOpenTerminalFlag() {
      try {
        const parsed = globalThis.HerdrOptions
          ? globalThis.HerdrOptions.read()
          : {};
        return parsed.workspaceOpenTerminal === true;
      } catch (_) {
        return false;
      }
    }

    // Desktop parity: close the workspace once its last terminal panel
    // closes. Default on; only an explicit false opts out.
    function closeWorkspaceOnLastTerminalFlag() {
      try {
        const parsed = globalThis.HerdrOptions
          ? globalThis.HerdrOptions.read()
          : {};
        return parsed.closeWorkspaceOnLastTerminal !== false;
      } catch (_) {
        return true;
      }
    }

    function applyResult(response) {
      const result = (response && response.result) || {};
      const source = result.source || {};
      state.worktreeSource = source;
      // Rows arrive pre-stamped server-side (normalize_worktree_response
      // copies source_workspace_id / source_repo_name / source_cwd onto
      // each row). The envelope merge below only fills rows an older
      // server sent unstamped.
      const envelopeStamps = {
        source_workspace_id: source.source_workspace_id || null,
        source_cwd: source.source_checkout_path || source.repo_root || null,
        source_repo_name:
          source.repo_name || source.repo_key || source.repo_root || "",
      };
      state.worktreeRows = (result.worktrees || []).map((row) =>
        row.source_workspace_id != null || row.source_cwd != null
          ? row
          : Object.assign({}, row, envelopeStamps),
      );
    }

    async function load() {
      if (!state.ws && !state.worktreeDiscoverPath.trim()) return;
      state.worktreeError = "";
      setLoading(true, "Discovering worktrees...");
      try {
        const path = state.worktreeDiscoverPath.trim();
        const query = path
          ? "cwd=" + encodeURIComponent(path)
          : "workspace_id=" + encodeURIComponent(state.ws);
        applyResult(await api("/api/worktrees?" + query));
      } catch (error) {
        state.worktreeError = error.message || String(error);
      } finally {
        setLoading(false);
      }
    }

    function updateField(field, value) {
      state[field] = value;
    }

    function setCreateExpanded(open) {
      state.worktreeCreateExpanded = !!open;
    }

    async function open(index) {
      const row = state.worktreeRows[index];
      if (!row || !row.path) return;
      const sourcePath = state.worktreeDiscoverPath.trim();
      state.worktreeError = "";
      setLoading(true, "Opening worktree...", index);
      try {
        const response = await api("/api/worktrees/open", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspace_id:
              row.source_workspace_id || (sourcePath ? null : state.ws),
            cwd: row.source_workspace_id
              ? null
              : row.source_cwd || sourcePath || null,
            path: row.path,
            label: null,
            open_terminal: workspaceOpenTerminalFlag(),
          }),
        });
        state.worktreeLoading = false;
        state.worktreeLoadingLabel = "";
        state.worktreeBusyIndex = null;
        navigateToResult(response);
      } catch (error) {
        state.worktreeError = error.message || String(error);
        setLoading(false);
        render();
      }
    }

    async function create() {
      state.worktreeError = "";
      const helpers = globalThis.HerdrAppHelpers || {},
        source = state.worktreeSource || {},
        sourcePath = state.worktreeDiscoverPath.trim(),
        branch = state.worktreeBranch.trim();
      let generateWorktreeNames = false;
      try {
        const parsed = globalThis.HerdrOptions
          ? globalThis.HerdrOptions.read()
          : {};
        generateWorktreeNames = !!parsed.generateWorktreeNames;
      } catch (_) {}
      const resolved = helpers.resolveWorktreeSource({
        discoveredSource: {
          workspace_id: source.source_workspace_id,
          cwd: source.source_checkout_path || source.repo_root,
        },
        sourcePath,
        fallbackWorkspaceId: state.ws,
      });
      const error = helpers.validateWorktreeCreate({
        branch,
        generateWorktreeNames,
        worktreeLists: [state.worktreeRows || []],
      });
      if (error) {
        state.worktreeError = error;
        render();
        return;
      }
      setLoading(true, "Creating worktree...");
      try {
        const response = await api("/api/worktrees", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            helpers.buildWorktreeCreateBody({
              source: resolved,
              branch,
              base: state.worktreeBase,
              label: state.worktreeLabel,
              path: state.worktreePath,
              pullBase: false,
            }),
          ),
        });
        state.worktreeBranch = "";
        state.worktreeBase = "";
        state.worktreeLabel = "";
        state.worktreePath = "";
        state.worktreeLoading = false;
        state.worktreeLoadingLabel = "";
        state.worktreeBusyIndex = null;
        navigateToResult(response);
      } catch (err) {
        state.worktreeError = err.message || String(err);
        setLoading(false);
        render();
      }
    }

    // ---- Worktree sheet (location strip parity surface) ----
    // The strip's worktree pill opens this sheet: sibling checkouts of
    // the current repo, fetched on open with the pinned cwd, one tap to
    // reroute. Module-local state, same isolation rule as the branch
    // sheet: rows and actions always describe the checkout the sheet
    // was opened for.
    const worktreeSheet = {
      open: false,
      cwd: "",
      loading: false,
      rows: [],
      error: "",
    };

    function worktreeSheetStale() {
      return !worktreeSheet.open || worktreeSheet.cwd !== currentCwdFn();
    }

    async function openWorktreeSheet() {
      const cwd = currentCwdFn();
      if (!cwd) return;
      worktreeSheet.open = true;
      worktreeSheet.cwd = cwd;
      worktreeSheet.loading = true;
      worktreeSheet.rows = [];
      worktreeSheet.error = "";
      render();
      try {
        const data = await api(
          "/api/worktrees?cwd=" + encodeURIComponent(cwd),
        );
        // The endpoint returns the bare {source, worktrees} envelope;
        // the app-wide fallback path wraps it in {result} the same way
        // applyResult accepts both.
        const envelope = data && data.result ? data.result : data;
        worktreeSheet.rows = (envelope && envelope.worktrees) || [];
        worktreeSheet.loading = false;
      } catch (error) {
        worktreeSheet.error = (error && error.message) || String(error);
        worktreeSheet.loading = false;
      }
      // A workspace switch mid-flight dismisses the sheet on the next
      // render (pinned-cwd check below); landing rows for the old
      // checkout then re-render into a closed sheet, a no-op.
      render();
    }

    function closeWorktreeSheet() {
      worktreeSheet.open = false;
      worktreeSheet.rows = [];
      worktreeSheet.error = "";
      const container = document.getElementById("mobileWorktreeSheet");
      const backdrop = document.getElementById("mobileWorktreeSheetBackdrop");
      if (container) container.hidden = true;
      if (backdrop) backdrop.hidden = true;
      render();
    }

    async function openWorktreeFromSheet(index) {
      if (worktreeSheetStale()) return;
      const row = worktreeSheet.rows[index];
      const path = row && String(row.path || "");
      if (!path) return;
      if (samePath(path, worktreeSheet.cwd)) {
        closeWorktreeSheet();
        return;
      }
      if (!(await confirmFn(`Open ${pathBasename(path)}?`))) return;
      closeWorktreeSheet();
      try {
        await openFolderAsWorkspace(path);
      } catch (_) {
        // openFolderAsWorkspace already surfaced its error on the
        // worktrees screen state; the sheet stays closed.
      }
    }

    function routeToCreateFromSheet() {
      // Creating a worktree needs the full form (branch, base, label,
      // checkout path): route to the worktrees screen with the create
      // disclosure open instead of duplicating the form in the sheet.
      const discoverSeed = worktreeSheet.cwd;
      closeWorktreeSheet();
      if (discoverSeed && state.worktreeDiscoverPath !== undefined)
        state.worktreeDiscoverPath = discoverSeed;
      state.worktreeCreateExpanded = true;
      if (typeof showScreenFn === "function") showScreenFn("worktrees");
      render();
    }

    function isWorktreeSheetOpen() {
      return worktreeSheet.open && worktreeSheet.cwd === currentCwdFn();
    }

    function renderWorktreeSheet() {
      if (!worktreeSheet.open) return;
      const container = document.getElementById("mobileWorktreeSheet");
      const backdrop = document.getElementById("mobileWorktreeSheetBackdrop");
      if (!container || !backdrop) return;
      // A workspace switch while the sheet is open dismisses it: the
      // rows describe the abandoned checkout.
      if (worktreeSheet.cwd !== currentCwdFn()) {
        closeWorktreeSheet();
        return;
      }
      container.hidden = false;
      backdrop.hidden = false;
      const html = worktreeSheetHtml();
      if (container.__lastWorktreeSheetHtml !== html) {
        container.innerHTML = html;
        container.__lastWorktreeSheetHtml = html;
      }
    }

    function worktreeSheetHtml() {
      const loading = worktreeSheet.loading
        ? '<div class="mobile-loading">Loading worktrees</div>'
        : "";
      const error = worktreeSheet.error
        ? `<div class="mobile-error">${escapeHtml(worktreeSheet.error)}</div>`
        : "";
      const rows = worktreeSheet.rows.length
        ? worktreeSheet.rows
            .map((row, index) => {
              const path = String(row.path || "");
              const current = samePath(path, worktreeSheet.cwd);
              const title =
                pathBasename(path) || row.label || row.branch || "worktree";
              const meta = [row.branch, path].filter(Boolean).join(" · ");
              return `<button class="mobile-row mobile-git-branch${current ? " active" : ""}" ${current ? "disabled" : `onclick="HerdrMobile.openWorktreeFromSheet(${index})"`}><strong>${escapeHtml(title)}${current ? " (current)" : ""}</strong><span>${escapeHtml(meta)}</span></button>`;
            })
            .join("")
        : '<div class="mobile-loading">No linked worktrees found in this folder</div>';
      return `<div class="mobile-sheet-handle"></div><div class="mobile-sheet-title">Worktrees</div>${loading}${error}<div class="mobile-tabs-sheet-list">${rows}</div><button class="mobile-btn primary mobile-wide" type="button" onclick="HerdrMobile.routeToCreateFromSheet()">Create worktree</button>`;
    }

    async function openFolderAsWorkspace(pathArg) {
      const path = String(pathArg || "").trim();
      if (!path) return;
      state.worktreeError = "";
      setLoading(true, "Opening workspace...");
      try {
        const response = await api("/api/recent-workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, label: null, open_terminal: workspaceOpenTerminalFlag() }),
        });
        recent = [];
        setLoading(false);
        navigateToResult(response);
        loadRecent();
      } catch (error) {
        state.worktreeError = error.message || String(error);
        setLoading(false);
        render();
      }
    }

    function navigateToResult(response) {
      const result = response.result || {};
      const workspace = result.workspace || {};
      const tab = result.tab || {};
      const pane = result.root_pane || {};
      if (!workspace.workspace_id) return refresh();
      state.ws = workspace.workspace_id;
      state.tab = tab.tab_id || null;
      state.pane = pane.pane_id || null;
      state.screen = "terminal";
      // Landing on a fresh worktree surface is an explicit selection: store
      // it so reopening this session restores the same surface.
      saveSessionSelection(state.session, currentSessionBackend(), {
        ws: state.ws,
        tab: state.tab,
        pane: state.pane,
      });
      history.pushState(
        null,
        "",
        selectionPath(state.ws, state.tab, state.pane),
      );
      destroyTerminal(true);
      refresh();
    }

    return { applyResult, clearRecent, closeWorkspaceOnLastTerminalFlag, closeWorktreeSheet, create, isWorktreeSheetOpen, load, loadRecent, open, openFolderAsWorkspace, openRecent, openWorktreeSheet, openWorktreeFromSheet, removeRecent, renderScreen, renderWorktreeSheet, routeToCreateFromSheet, setCreateExpanded, updateField };
  }

  globalThis.HerdrMobileWorktrees = { create: createMobileWorktrees };
})();
