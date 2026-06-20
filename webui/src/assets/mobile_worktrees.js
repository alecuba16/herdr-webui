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
    } = deps;

    function renderScreen() {
      const source = state.worktreeSource || {};
      const sourcePath =
        source.source_checkout_path || source.cwd || source.repo_root || "";
      const rows = state.worktreeRows || [];
      return `<section class="mobile-section mobile-form"><h2>Worktrees</h2><p class="mobile-help">Open linked worktrees for current workspace repo, or enter a repo/worktrees folder path.</p><label><span>Repo or worktrees folder</span><input value="${escapeHtml(state.worktreeDiscoverPath)}" oninput="HerdrMobile.updateWorktreeField('worktreeDiscoverPath', this.value)" placeholder="~/Documents/code/repo-or-worktrees"></label><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.loadWorktrees()">Discover worktrees</button>${state.worktreeError ? `<div class="mobile-error">${escapeHtml(state.worktreeError)}</div>` : ""}<div class="mobile-worktree-source"><strong>${escapeHtml(source.repo_name || "Current workspace repo")}</strong><span>${escapeHtml(sourcePath || "Select a workspace or enter a path to discover worktrees")}</span></div><div class="mobile-worktree-list">${rows.length ? rows.map((row, index) => renderRow(row, index)).join("") : '<div class="mobile-loading">No linked worktrees found yet</div>'}</div><h2>Create worktree</h2><label><span>Branch name</span><input value="${escapeHtml(state.worktreeBranch)}" oninput="HerdrMobile.updateWorktreeField('worktreeBranch', this.value)" placeholder="feature/my-branch"></label><label><span>Base branch</span><input value="${escapeHtml(state.worktreeBase)}" oninput="HerdrMobile.updateWorktreeField('worktreeBase', this.value)" placeholder="HEAD or main"></label><label><span>Label</span><input value="${escapeHtml(state.worktreeLabel)}" oninput="HerdrMobile.updateWorktreeField('worktreeLabel', this.value)" placeholder="optional"></label><label><span>Checkout path</span><input value="${escapeHtml(state.worktreePath)}" oninput="HerdrMobile.updateWorktreeField('worktreePath', this.value)" placeholder="backend default if blank"></label><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.createWorktree()">Create and open</button></section>`;
    }

    function renderRow(row, index) {
      const title = row.label || row.branch || row.path || "worktree";
      const meta = [
        row.branch || (row.is_detached ? "detached" : "branch"),
        row.path,
      ]
        .filter(Boolean)
        .join(" · ");
      return `<div class="mobile-worktree-row"><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(meta)}</small></span><button class="mobile-btn primary" onclick="HerdrMobile.openWorktree(${index})">Open</button></div>`;
    }

    function applyResult(response) {
      const result = (response && response.result) || {};
      const source = result.source || {};
      state.worktreeSource = source;
      state.worktreeRows = (result.worktrees || []).map((row) =>
        Object.assign({}, row, {
          source_workspace_id: source.source_workspace_id || null,
          source_cwd: source.source_checkout_path || source.repo_root || null,
        }),
      );
    }

    async function load() {
      if (!state.ws && !state.worktreeDiscoverPath.trim()) return;
      state.worktreeError = "";
      try {
        const path = state.worktreeDiscoverPath.trim();
        const query = path
          ? "cwd=" + encodeURIComponent(path)
          : "workspace_id=" + encodeURIComponent(state.ws);
        applyResult(await api("/api/worktrees?" + query));
      } catch (error) {
        state.worktreeError = error.message || String(error);
      }
      render();
    }

    function updateField(field, value) {
      state[field] = value;
    }

    async function open(index) {
      const row = state.worktreeRows[index];
      if (!row || !row.path) return;
      const sourcePath = state.worktreeDiscoverPath.trim();
      state.worktreeError = "";
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
        navigateToResult(response);
      } catch (error) {
        state.worktreeError = error.message || String(error);
        render();
      }
    }

    async function create() {
      state.worktreeError = "";
      const source = state.worktreeSource || {};
      const sourcePath = state.worktreeDiscoverPath.trim();
      const branch = state.worktreeBranch.trim();
      if (!branch) {
        state.worktreeError = "Branch name required on mobile for now.";
        render();
        return;
      }
      try {
        const response = await api("/api/worktrees", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            workspace_id:
              source.source_workspace_id || (sourcePath ? null : state.ws),
            cwd: source.source_workspace_id
              ? null
              : source.source_checkout_path ||
                source.repo_root ||
                sourcePath ||
                null,
            branch,
            base: state.worktreeBase.trim() || null,
            label: state.worktreeLabel.trim() || null,
            path: state.worktreePath.trim() || null,
          }),
        });
        state.worktreeBranch = "";
        state.worktreeBase = "";
        state.worktreeLabel = "";
        state.worktreePath = "";
        navigateToResult(response);
      } catch (error) {
        state.worktreeError = error.message || String(error);
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

    return { applyResult, create, load, open, renderScreen, updateField };
  }

  globalThis.HerdrMobileWorktrees = { create: createMobileWorktrees };
})();
