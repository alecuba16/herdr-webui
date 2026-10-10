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
      if (!state.ws) {
        // No workspace yet: a panel cannot exist. Route the tap to the
        // worktree discovery flow seeded with the default folder, the
        // mobile twin of the desktop + fallback.
        state.worktreeDiscoverPath = state.defaultFolder || "";
        runMobileAction("discover-worktrees");
        return;
      }
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
      // Refreshes re-scope state.tab from the route mid-flight (ws:id form),
      // so a strict === lookup against the bare ids in state.tabs can miss
      // and the confirm would name or close the wrong panel. Resolve through
      // sameScopedId and freeze the bare id before the confirm await: the
      // POST must target the panel the user saw, even if a refresh lands
      // while the sheet is open.
      const current = state.tabs.find((item) => sameScopedId(state.ws, item.tab_id, state.tab));
      if (!current) return;
      const tabId = current.tab_id;
      const label = tabTitle(current);
      if (!(await confirmFn(`Close panel "${label}"?`))) return;
      try {
        // One close call: the workspace survives its last panel, the
        // terminal screen falls back to its no-terminal state. A
        // not-found race (the tab closed elsewhere while the sheet was
        // open) is the outcome we wanted: keep the post-close flow.
        try {
          await api(`/api/tabs/${encodeURIComponent(tabId)}/close`, { method: "POST" });
        } catch (error) {
          if (!String(error.message || error).includes("not found")) throw error;
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
