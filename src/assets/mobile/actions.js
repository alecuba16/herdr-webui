(function () {
  function createMobileActions({
    state,
    api,
    confirmFn,
    refresh,
    render,
    showScreen,
    selectionPath,
    currentWorkspaceCwd,
    tabTitle,
    getMobileFileBrowser,
    getMobileTerminal,
    getMobileSearch,
    getMobileWorktrees,
    getMobileTempTerminal,
  }) {
    function selectWorkspace(id) {
      state.ws = id;
      state.tab = null;
      state.pane = null;
      state.screen = "terminal";
      state.gitStatus = null;
      state.gitError = "";
      state.gitFile = "";
      state.gitDiff = null;
      state.gitDiffError = "";
      getMobileFileBrowser().reset();
      history.pushState(null, "", selectionPath(id));
      getMobileTerminal().destroy(true);
      refresh();
    }

    function selectAgent(ws, tab, pane) {
      state.ws = ws;
      state.tab = tab;
      state.pane = pane;
      state.screen = "terminal";
      history.pushState(null, "", selectionPath(ws, tab, pane));
      getMobileTerminal().destroy(true);
      refresh();
    }

    function selectTab(tab) {
      state.tab = tab;
      const pane =
        state.panes.find((item) => item.tab_id === tab) || state.panes[0];
      state.pane = pane && pane.pane_id;
      state.terminalId = pane && pane.terminal_id;
      state.screen = "terminal";
      history.pushState(null, "", selectionPath(state.ws, state.tab, state.pane));
      getMobileTerminal().destroy(true);
      render();
      getMobileTerminal().connect();
    }

    async function createPanel() {
      if (!state.ws) return;
      try {
        const response = await api("/api/tabs", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ workspace_id: state.ws }),
        });
        const tab = ((response.result || {}).tab || {}).tab_id;
        if (tab) {
          state.tab = tab;
          state.pane = null;
          state.screen = "terminal";
          history.pushState(null, "", selectionPath(state.ws, tab));
          getMobileTerminal().destroy(true);
        }
        refresh();
      } catch (error) {
        state.error = error.message || String(error);
        render();
      }
    }

    async function closeCurrentPanel() {
      if (!state.tab) return;
      const tab = state.tabs.find((item) => item.tab_id === state.tab) || { tab_id: state.tab, workspace_id: state.ws };
      const label = tabTitle(tab);
      if (!confirmFn(`Close panel "${label}"?`)) return;
      try {
        const workspaceTabs = state.tabs.filter((item) => item.workspace_id === state.ws);
        if (workspaceTabs.length > 1) {
          await api(`/api/tabs/${encodeURIComponent(state.tab)}/close`, { method: "POST" });
        } else if (state.ws) {
          await api(`/api/workspaces/${encodeURIComponent(state.ws)}/close`, { method: "POST" });
        }
        state.tab = null;
        state.pane = null;
        getMobileTerminal().destroy(true);
        await refresh();
      } catch (error) {
        state.error = error.message || String(error);
        render();
      }
    }

    function currentScreen() {
      return state.screen;
    }

    function currentSelection() {
      return { ws: state.ws, tab: state.tab, pane: state.pane };
    }

    function runMobileAction(action) {
      if (action === "search") {
        getMobileSearch().open();
        return;
      }
      if (action === "open-workspace" || action === "discover-worktrees") {
        showScreen("worktrees");
        if (action === "discover-worktrees") getMobileWorktrees().load();
        else getMobileWorktrees().loadRecent();
        return;
      }
      if (action === "create-worktree") {
        state.worktreeCreateExpanded = true;
        showScreen("worktrees");
        return;
      }
      if (action === "temp-terminal") {
        if (getMobileTempTerminal()) getMobileTempTerminal().open(currentWorkspaceCwd());
        return;
      }
      if (action === "sessions") {
        showScreen("sessions");
        return;
      }
      if (["terminal", "files", "git", "settings"].includes(action)) showScreen(action);
    }

    return {
      selectWorkspace,
      selectAgent,
      selectTab,
      createPanel,
      closeCurrentPanel,
      currentScreen,
      currentSelection,
      runMobileAction,
    };
  }

  globalThis.HerdrMobileActionsModule = { create: createMobileActions };
})();