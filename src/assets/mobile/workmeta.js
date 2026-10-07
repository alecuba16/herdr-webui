(function () {
  function createMobileWorkmeta({ state, samePath, pathBasename }) {
    function currentWorkspace() {
      return state.workspaces.find((w) => w.workspace_id === state.ws) || null;
    }

    function currentTab() {
      return state.tabs.find((t) => t.tab_id === state.tab) || null;
    }

    function currentPane() {
      return state.panes.find((p) => p.pane_id === state.pane) || null;
    }

    function workspacesById() {
      return Object.fromEntries(state.workspaces.map((w) => [w.workspace_id, w]));
    }

    function tabsById() {
      return Object.fromEntries(
        state.allTabs.concat(state.tabs).map((t) => [t.tab_id, t]),
      );
    }

    function tabCountsByWorkspace() {
      const counts = new Map();
      for (const tab of state.allTabs)
        counts.set(tab.workspace_id, (counts.get(tab.workspace_id) || 0) + 1);
      return counts;
    }

    function tabTitle(tab) {
      return (tab && (tab.label || `tab ${tab.number}`)) || "panel";
    }

    function isDefaultTabTitle(label) {
      const value = String(label || "").trim().toLowerCase();
      return !value || value === "shell" || value === "terminal" || /^tab\s+\d+$/.test(value);
    }

    function tabNumberLabel(tab) {
      const number = Number(tab && tab.number);
      if (Number.isFinite(number) && number > 0) return String(number);
      return "1";
    }

    function agentTabLabel(wsId, tab, counts) {
      if (!tab) return "";
      // Mirrors the desktop agents panel: hide the token for single-panel
      // workspaces, show the custom name when several panels exist, else the
      // panel number (default labels are "Shell"/"Terminal"/"tab N").
      if ((counts.get(wsId) || 0) <= 1) return "";
      const label = String(tab.label || "").trim();
      return isDefaultTabTitle(label) ? `#${tabNumberLabel(tab)}` : label;
    }

    function worktreeForWorkspace(workspace) {
      if (!workspace || !workspace.worktree) return null;
      return (
        state.worktreeRows.find(
          (row) => row.open_workspace_id === workspace.workspace_id,
        ) ||
        state.worktreeRows.find((row) =>
          samePath(row.path, workspace.worktree.checkout_path),
        ) ||
        null
      );
    }

    function workspaceTitle(workspace) {
      if (!workspace) return state.session || "Herdr";
      if (workspace.worktree) return worktreeDisplayName(workspace);
      return workspace.label || workspace.workspace_id;
    }

    function worktreeDisplayName(workspace) {
      if (!workspace) return "worktree";
      const worktree = worktreeForWorkspace(workspace);
      return (
        pathBasename(
          (worktree && worktree.path) ||
            (workspace.worktree && workspace.worktree.checkout_path),
        ) ||
        (worktree && worktree.label) ||
        workspace.label ||
        "worktree"
      );
    }

    function parentWorkspaceName(workspace, byId) {
      if (!workspace || !workspace.worktree) return "workspace";
      // Match the main checkout of the same repo by absolute path only.
      // The bare repo folder name (repo_name) is display-only: same-named
      // repos in different parent folders must never adopt each other as
      // parent, so the old workspace-label fallback is gone.
      const key =
        workspace.worktree.repo_key || workspace.worktree.repo_root;
      if (!key)
        return workspace.worktree.repo_name || workspace.label || "workspace";
      const match = Object.values(byId).find(
        (item) =>
          item.workspace_id !== workspace.workspace_id &&
          item.worktree &&
          !item.worktree.is_linked_worktree &&
          (item.worktree.repo_key || item.worktree.repo_root) === key,
      );
      return match ? match.label : workspace.worktree.repo_name || "workspace";
    }

    function workspaceMeta(workspace) {
      if (!workspace) return "Select workspace or agent";
      const worktree = worktreeForWorkspace(workspace);
      const parts = [`${workspace.pane_count || 0} panes`];
      const branch =
        (worktree &&
          (worktree.branch || (worktree.is_detached ? "detached" : ""))) ||
        (workspace.worktree && workspace.worktree.branch);
      if (branch) parts.push(branch);
      return parts.join(" · ");
    }

    // Structured header meta. The leading context (repo parent, branch) is
    // plain text; the panel segment is interactive in the header. It shows
    // the custom panel name when one exists, otherwise just the pane
    // count, and the caller renders it as a chip opening the panels dialog.
    function contextMetaParts(workspace) {
      if (!workspace) return null;
      const leading = [];
      if (workspace.worktree) {
        const parent = parentWorkspaceName(workspace, workspacesById());
        if (parent) leading.push(parent);
      }
      const worktree = worktreeForWorkspace(workspace);
      const branch =
        (worktree &&
          (worktree.branch || (worktree.is_detached ? "detached" : ""))) ||
        (workspace.worktree && workspace.worktree.branch);
      if (branch) leading.push(branch);
      const tab = currentTab();
      const label = tab ? String(tab.label || "").trim() : "";
      return {
        leading,
        panelLabel: label && !isDefaultTabTitle(label) ? label : "",
        paneCount: workspace.pane_count || 0,
      };
    }

    function contextMeta(workspace) {
      const parts = contextMetaParts(workspace);
      if (!parts) return "Select workspace or agent";
      const panel = parts.panelLabel || `${parts.paneCount} panes`;
      return [...parts.leading, panel].filter(Boolean).join(" · ");
    }

    return {
      currentWorkspace,
      currentTab,
      currentPane,
      workspacesById,
      tabsById,
      tabCountsByWorkspace,
      tabTitle,
      agentTabLabel,
      worktreeForWorkspace,
      workspaceTitle,
      worktreeDisplayName,
      parentWorkspaceName,
      workspaceMeta,
      contextMetaParts,
      contextMeta,
    };
  }

  globalThis.HerdrMobileWorkmetaModule = { create: createMobileWorkmeta };
})();