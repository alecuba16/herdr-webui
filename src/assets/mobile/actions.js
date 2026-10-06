(function () {
  function createMobileActions({
    state,
    api,
    confirmFn,
    refresh,
    render,
    showScreen,
    selectionPath,
    currentSessionBackend,
    saveSessionSelection,
    sameScopedId,
    currentWorkspaceCwd,
    tabTitle,
    getMobileFileBrowser,
    getMobileTerminal,
    getMobileSearch,
    getMobileWorktrees,
    getMobileTempTerminal,
    getMobileTheme,
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
      // Persist the explicit selection (per session+backend) so reopening
      // this session restores exactly this surface; the history entry and
      // the stored selection stay in sync.
      saveSessionSelection(state.session, currentSessionBackend(), {
        ws: state.ws,
        tab: null,
        pane: null,
      });
      history.pushState(null, "", selectionPath(id));
      getMobileTerminal().destroy(true);
      refresh();
    }

    function selectAgent(ws, tab, pane) {
      state.ws = ws;
      state.tab = tab;
      state.pane = pane;
      state.screen = "terminal";
      saveSessionSelection(state.session, currentSessionBackend(), {
        ws: state.ws,
        tab: state.tab,
        pane: state.pane,
      });
      history.pushState(null, "", selectionPath(ws, tab, pane));
      getMobileTerminal().destroy(true);
      refresh();
    }

    function selectTab(tab) {
      const selectedTab = state.tabs.find((item) => sameScopedId(state.ws, item.tab_id, tab));
      state.tab = selectedTab ? selectedTab.tab_id : tab;
      const pane =
        state.panes.find((item) => sameScopedId(state.ws, item.tab_id, state.tab)) || null;
      state.pane = pane && pane.pane_id;
      state.terminalId = pane && pane.terminal_id;
      state.screen = "terminal";
      saveSessionSelection(state.session, currentSessionBackend(), {
        ws: state.ws,
        tab: state.tab,
        pane: state.pane,
      });
      history.pushState(null, "", selectionPath(state.ws, state.tab, state.pane));
      getMobileTerminal().destroy(true);
      render();
      getMobileTerminal().connect();
    }

    let createPanelInFlight = false;
    async function createPanel() {
      if (!state.ws) return;
      // Guard: rapid re-taps must not POST one tab.create per event.
      if (createPanelInFlight) return;
      createPanelInFlight = true;
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
          saveSessionSelection(state.session, currentSessionBackend(), {
            ws: state.ws,
            tab: state.tab,
            pane: null,
          });
          history.pushState(null, "", selectionPath(state.ws, tab));
          getMobileTerminal().destroy(true);
        }
        refresh();
      } catch (error) {
        state.error = error.message || String(error);
        render();
      } finally {
        createPanelInFlight = false;
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
      if (action === "toggle-theme") {
        const modes = ["auto", "dark", "light"];
        const current = localStorage.getItem("herdr-web-theme") || "auto";
        const next = modes[(modes.indexOf(current) + 1) % modes.length];
        if (next === "auto") localStorage.removeItem("herdr-web-theme");
        else localStorage.setItem("herdr-web-theme", next);
        const theme = getMobileTheme();
        if (theme && theme.applyTheme) theme.applyTheme();
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
        const tempTerminal = getMobileTempTerminal();
        if (!tempTerminal) return;
        // Restore-first: a minimized session comes back on the card click
        // (the More grid meta text promises exactly that). Only open a new
        // one when nothing is live yet. The manager restore() picks the
        // most recently minimized session and hides the restore bar.
        if (tempTerminal.isVisible && tempTerminal.isVisible()) return;
        if (tempTerminal.restore) tempTerminal.restore();
        if (tempTerminal.isVisible && tempTerminal.isVisible()) return;
        tempTerminal.open(currentWorkspaceCwd());
        return;
      }
      if (action === "temp-files") {
        const overlays = globalThis.HerdrMobileTempOverlays;
        if (!overlays) return;
        // Same restore-first contract as the temporary terminal card.
        const files = overlays.files && overlays.files();
        if (files && files.isOpen && files.isOpen()) { if (files.isMinimized()) files.restore(); return; }
        overlays.openFiles(currentWorkspaceCwd());
        return;
      }
      if (action === "temp-git") {
        const overlays = globalThis.HerdrMobileTempOverlays;
        if (!overlays) return;
        const git = overlays.git && overlays.git();
        if (git && git.isOpen && git.isOpen()) { if (git.isMinimized()) git.restore(); return; }
        overlays.openGit(currentWorkspaceCwd());
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
