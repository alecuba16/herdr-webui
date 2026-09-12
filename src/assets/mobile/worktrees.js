(function () {
  function createMobileWorktrees(deps) {
    const {
      api,
      destroyTerminal,
      escapeHtml,
      jsArg,
      refresh,
      render,
      selectionPath,
      state,
      defaultFolderFn,
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
      return `<section class="mobile-section mobile-form mobile-worktree-flow"><h2>Worktrees</h2><div class="mobile-settings-group"><h3>Open existing</h3><p class="mobile-help">Open linked worktrees for current workspace repo, or enter a repo/worktrees folder path.</p><label><span>Repo or worktrees folder</span><input value="${escapeHtml(state.worktreeDiscoverPath)}" oninput="HerdrMobile.updateWorktreeField('worktreeDiscoverPath', this.value)" placeholder="~/Documents/code/repo-or-worktrees"></label><button class="mobile-btn primary mobile-wide" ${busy ? "disabled" : ""} onclick="HerdrMobile.loadWorktrees()">${busy && state.worktreeLoadingLabel === "Discovering worktrees..." ? "Discovering..." : "Discover worktrees"}</button>${loading}${state.worktreeError ? `<div class="mobile-error">${escapeHtml(state.worktreeError)}</div>` : ""}<div class="mobile-worktree-source"><strong>${escapeHtml(source.repo_name || "Current workspace repo")}</strong><span>${escapeHtml(sourcePath || "Select a workspace or enter a path to discover worktrees")}</span></div><div class="mobile-worktree-list">${rows.length ? rows.map((row, index) => renderRow(row, index)).join("") : '<div class="mobile-loading">No linked worktrees found yet</div>'}</div></div><details class="mobile-settings-group mobile-disclosure"${createOpen} onchange="HerdrMobile.setWorktreeCreateExpanded(this.open)"><summary>Create new worktree</summary><label><span>Branch name</span><input value="${escapeHtml(state.worktreeBranch)}" oninput="HerdrMobile.updateWorktreeField('worktreeBranch', this.value)" placeholder="feature/my-branch"></label><label><span>Base branch</span><input value="${escapeHtml(state.worktreeBase)}" oninput="HerdrMobile.updateWorktreeField('worktreeBase', this.value)" placeholder="HEAD or main"></label><label><span>Label</span><input value="${escapeHtml(state.worktreeLabel)}" oninput="HerdrMobile.updateWorktreeField('worktreeLabel', this.value)" placeholder="optional"></label><label><span>Checkout path</span><input value="${escapeHtml(state.worktreePath)}" oninput="HerdrMobile.updateWorktreeField('worktreePath', this.value)" placeholder="backend default if blank"></label><button class="mobile-btn primary mobile-wide" ${busy ? "disabled" : ""} onclick="HerdrMobile.createWorktree()">${busy && state.worktreeLoadingLabel === "Creating worktree..." ? "Creating..." : "Create and open"}</button></details><details class="mobile-settings-group mobile-disclosure"><summary>Recent workspaces</summary><div class="mobile-worktree-list">${renderRecentSection()}</div></details></section>`;
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
      const paths = workspaces.map((workspace) =>
        (workspace.worktree && workspace.worktree.checkout_path) || "",
      );
      return new Set(paths.filter(Boolean));
    }

    function samePath(a, b) {
      return String(a || "").replace(/\/+$/, "") === String(b || "").replace(/\/+$/, "");
    }

    function recentCandidates() {
      const open = openPaths();
      return (recent || [])
        .filter((item) => item && item.path && !open.has(item.path.replace(/\/+$/, "")))
        .filter((item, index, list) => list.findIndex((other) => samePath(other.path, item.path)) === index)
        .slice(0, 8);
    }

    function renderRecentSection() {
      const rows = recentCandidates();
      if (!rows.length)
        return '<div class="mobile-loading">No recent workspaces yet</div>';
      return `${rows.map((item) => renderRecentRow(item)).join("")}<button class="mobile-btn mobile-wide" onclick="HerdrMobile.clearRecentWorkspaces()">Clear recent list</button>`;
    }

    function renderRecentRow(item) {
      const title = item.label || pathBasename(item.path) || item.path;
      const kind = item.kind === "worktree" ? "worktree" : "workspace";
      const meta = [kind, item.branch, item.path].filter(Boolean).join(" · ");
      const encoded = encodeURIComponent(item.path);
      return `<div class="mobile-worktree-row"><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(meta)}</small></span><span class="mobile-recent-actions"><button class="mobile-btn primary" onclick="HerdrMobile.openRecentWorkspace('${encoded}')">Open</button><button class="mobile-btn" title="Remove from recent list" onclick="HerdrMobile.removeRecentWorkspace('${encoded}')">✕</button></span></div>`;
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

    async function openRecent(encodedPath) {
      const path = decodeURIComponent(String(encodedPath || ""));
      const item = (recent || []).find((entry) => entry && entry.path === path);
      if (!path || !item) return;
      state.worktreeError = "";
      setLoading(true, "Opening workspace...");
      try {
        const response = await api("/api/recent-workspaces", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path, label: item.label || null }),
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

    async function removeRecent(encodedPath) {
      const path = decodeURIComponent(String(encodedPath || ""));
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

    function applyResult(response) {
      const result = (response && response.result) || {};
      const source = result.source || {};
      state.worktreeSource = source;
      state.worktreeRows = (result.worktrees || []).map((row) =>
        Object.assign({}, row, {
          source_workspace_id: source.source_workspace_id || null,
          source_cwd: source.source_checkout_path || source.repo_root || null,
          source_repo_name:
            source.repo_name || source.repo_key || source.repo_root || "",
        }),
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
      history.pushState(
        null,
        "",
        selectionPath(state.ws, state.tab, state.pane),
      );
      destroyTerminal(true);
      refresh();
    }

    return { applyResult, clearRecent, create, load, loadRecent, open, openRecent, removeRecent, renderScreen, setCreateExpanded, updateField };
  }

  globalThis.HerdrMobileWorktrees = { create: createMobileWorktrees };
})();
