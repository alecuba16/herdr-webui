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

    function agentTabLabel(wsId, tab, counts) {
      if (!tab) return "";
      return (counts.get(wsId) || 0) > 1 || tab.label ? tabTitle(tab) : "";
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
      const key =
        workspace.worktree.repo_key ||
        workspace.worktree.repo_root ||
        workspace.worktree.repo_name;
      const match =
        Object.values(byId).find(
          (item) =>
            item.workspace_id !== workspace.workspace_id &&
            item.worktree &&
            (item.worktree.repo_key ||
              item.worktree.repo_root ||
              item.worktree.repo_name) === key &&
            !item.worktree.is_linked_worktree,
        ) ||
        Object.values(byId).find(
          (item) =>
            item.workspace_id !== workspace.workspace_id &&
            !item.worktree &&
            item.label === workspace.worktree.repo_name,
        );
      return match ? match.label : workspace.worktree.repo_name;
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

    function contextMeta(workspace) {
      if (!workspace) return "Select workspace or agent";
      const tab = currentTab();
      const parts = [];
      if (workspace.worktree) {
        const parent = parentWorkspaceName(workspace, workspacesById());
        if (parent) parts.push(parent);
      }
      parts.push(workspaceMeta(workspace));
      if (tab) parts.push(tabTitle(tab));
      return parts.filter(Boolean).join(" · ");
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
      contextMeta,
    };
  }

  globalThis.HerdrMobileWorkmetaModule = { create: createMobileWorkmeta };
})();