// Shell-level folder-change flow, shared by the location bar (bar path
// chip, worktree popover rows) and the file browser's "Open workspace
// here" context action. Extracted from file_browser.js openWorkspaceHere
// so both surfaces run the same navigation.
//
// Flow (plan docs/ux/location-bar-plan.md):
// 1. an open workspace already lives on the folder: go(that workspace)
// 2. /api/worktrees?cwd=<dir> lists a row with path == dir (a git
//    checkout): POST /api/worktrees/open, which focuses an open
//    workspace instead of duplicating it
// 3. plain folder: POST /api/workspaces (create) + recents record
// Every path lands on a live terminal panel through navigateToOpenedWorkspace.
(function () {
  function samePathValue(a, b) {
    const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
    const left = norm(a);
    const right = norm(b);
    return !!left && !!right && left === right;
  }

  function pathBasenameOf(path) {
    const parts = String(path || "").replace(/\\/g, "/").split("/").filter(Boolean);
    return parts.length ? parts[parts.length - 1] : "";
  }

  function workspacePathOf(workspace) {
    if (typeof window.HerdrWorkspacePath === "function")
      return window.HerdrWorkspacePath(workspace);
    return (workspace && (workspace.cwd || workspace.path)) || "";
  }

  function goFn() {
    return typeof go === "function" ? go : window.go;
  }

  // worktree.open and workspace.create answer with the workspace plus its
  // focused tab and root pane; navigating with all three lands directly on
  // a live terminal panel instead of waiting for the next refresh.
  function navigateToOpenedWorkspace(response) {
    const navigate = goFn();
    if (!navigate) return;
    const result = (response && response.result) || {};
    navigate(
      result.workspace && result.workspace.workspace_id,
      result.tab && result.tab.tab_id,
      result.root_pane && result.root_pane.pane_id,
    );
  }

  // Same HTTP contract as core.js api() and file_browser.js api(): the
  // shared HerdrHttp client when the shell provided it, else plain fetch.
  // Harnesses that load this module standalone provide only fetch.
  async function api(url, opt) {
    if (globalThis.HerdrHttp) return globalThis.HerdrHttp.request(url, opt);
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    const body = await res.json();
    if (!res.ok || body.error) {
      const error = Error(body.error || res.statusText);
      error.details = body || {};
      throw error;
    }
    return body;
  }

  async function postJson(url, body) {
    return api(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function terminalFlag() {
    return typeof workspaceOpenTerminalFlag === "function" && workspaceOpenTerminalFlag();
  }

  // A bar folder change moves the user to another workspace; the one left
  // behind should not linger empty. After a successful navigation, close
  // the previously selected workspace when it holds no tabs. Panel truth
  // comes from the server counts (workspaceCounts), with the tab lists as
  // the fallback for older servers. Failures leave the workspace open;
  // the next shell refresh re-syncs state anyway.
  // All desktop app files concatenate into one script, so the shell's
  // closeWorkspaceById (worktrees.js) is visible here directly. Harnesses
  // that load this module standalone expose it on window instead.
  function closerFn() {
    return typeof closeWorkspaceById === "function"
      ? closeWorkspaceById
      : window.HerdrWorkspaces && window.HerdrWorkspaces.closeWorkspaceById;
  }

  async function autoCloseLeftWorkspace(previousWorkspaceId) {
    if (!previousWorkspaceId) return;
    const closer = closerFn();
    if (typeof closer !== "function") return;
    if (previousWorkspaceId === state.ws) return;
    const workspace = (state.workspaces || []).find(
      (candidate) => candidate.workspace_id === previousWorkspaceId,
    );
    if (!workspace) return;
    const serverCount = (state.workspaceCounts || {})[previousWorkspaceId] || {};
    const hasPanels = Number.isFinite(serverCount.tabs)
      ? serverCount.tabs > 0
      : (state.allTabs || [])
          .concat(state.tabs || [])
          .some((tab) => tab.workspace_id === previousWorkspaceId);
    if (hasPanels) return;
    try {
      await closer(previousWorkspaceId);
    } catch (_) {}
  }

  // Change the shell's workspace folder: open (or focus) the workspace at
  // dir. Returns true when navigation happened.
  async function openFolderAsWorkspace(dir) {
    const target = String(dir || "").replace(/\/+$/, "") || "/";
    const navigate = goFn();
    const previousWorkspaceId = state.ws;
    const sameFolder = !!(state.workspaces || []).find(
      (w) => previousWorkspaceId && w.workspace_id === previousWorkspaceId &&
        samePathValue(workspacePathOf(w), target),
    );
    // Step 1: an open workspace already lives on this folder. Plain
    // folders have no worktree row, so the worktree.open fallback below
    // cannot focus them; go() does.
    const existing = (state.workspaces || []).find((w) =>
      samePathValue(workspacePathOf(w), target),
    );
    if (existing) {
      if (navigate && existing.workspace_id !== state.ws) navigate(existing.workspace_id, null, null);
      if (!sameFolder) await autoCloseLeftWorkspace(previousWorkspaceId);
      return true;
    }
    if (typeof showBlocking === "function") showBlocking("Opening folder...");
    try {
      // Step 2: git checkout. /api/worktrees?cwd=<dir> returns the
      // worktree rows of the repo that contains the dir (empty for plain
      // folders), so the dir is a checkout only when a row's path matches.
      const data = await api(`/api/worktrees?cwd=${encodeURIComponent(target)}`);
      const rows = ((data && data.result) || {}).worktrees || [];
      const row = rows.find((candidate) => samePathValue(candidate.path, target)) || null;
      if (row) {
        const response = await postJson("/api/worktrees/open", {
          workspace_id: null,
          cwd: null,
          path: row.path,
          label: null,
          branch: null,
          open_terminal: terminalFlag(),
        });
        navigateToOpenedWorkspace(response);
        await autoCloseLeftWorkspace(previousWorkspaceId);
        return true;
      }
      // Step 3: plain folder, create a workspace on it.
      const created = await postJson("/api/workspaces", {
        label: pathBasenameOf(target) || target,
        cwd: target,
        open_terminal: terminalFlag(),
      });
      try {
        await postJson("/api/recent-workspaces/record", {
          path: target,
          label: pathBasenameOf(target) || target,
        });
      } catch (_) {} // recents are a nice-to-have; the workspace is open
      navigateToOpenedWorkspace(created);
      await autoCloseLeftWorkspace(previousWorkspaceId);
      return true;
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
  }

  window.HerdrOpenFolder = { openFolderAsWorkspace, navigateToOpenedWorkspace, autoCloseLeftWorkspace };
})();
