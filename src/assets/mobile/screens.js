(function () {
  function createMobileScreens({
    state,
    render,
    escapeHtml,
    jsArg,
    MORE_SCREENS,
    currentWorkspace,
    workspaceTitle,
    workspaceMeta,
    contextMeta,
    sessionBackendLabel,
    currentSessionBackend,
    mobileAttention,
    getWorkingDismissals,
    workspacesById,
    tabsById,
    tabCountsByWorkspace,
    parentWorkspaceName,
    worktreeDisplayName,
    agentTabLabel,
  }) {
    function renderHome() {
      return `${renderTaskHub()}<section class="mobile-section"><h2>Workspaces</h2>${renderWorkspaces()}</section><section class="mobile-section"><h2>Agents needing attention</h2>${renderAttentionAgents()}</section>`;
    }

    function renderTaskHub() {
      const active = currentWorkspace();
      const searchAction = globalThis.HerdrActionRegistry.action("search");
      const activeAction = active
        ? `<button class="mobile-task-card primary" onclick="HerdrMobile.showScreen('terminal')"><strong>Continue ${escapeHtml(workspaceTitle(active))}</strong><span>${escapeHtml(contextMeta(active))}</span></button>`
        : `<button class="mobile-task-card primary" onclick="HerdrMobile.runAction('open-workspace')"><strong>Open workspace or worktree</strong><span>Pick a folder, discover worktrees, or create a checkout.</span></button>`;
      return `<section class="mobile-section mobile-task-hub"><h2>Start</h2><div class="mobile-task-grid">${activeAction}<button class="mobile-task-card" onclick="HerdrMobile.runAction('search')"><strong>${escapeHtml(searchAction.title)}</strong><span>${escapeHtml(searchAction.subtitle)}</span></button></div></section>`;
    }

    function renderAttentionAgents() {
      const attention = mobileAttention
        .sortAgents(state.agents)
        .filter((agent) => ["blocked", "done"].includes(mobileAttention.statusClass(agent.agent_status)));
      if (!attention.length) return '<div class="mobile-loading">No blocked or done agents</div>';
      const previousAgents = state.agents;
      state.agents = attention;
      try {
        return renderAgentsRows();
      } finally {
        state.agents = previousAgents;
      }
    }

    function renderMore() {
      const attention = state.agents.filter((agent) => ["blocked", "done"].includes(mobileAttention.statusClass(agent.agent_status))).length;
      const workspace = currentWorkspace();
      const tools = [
        { screen: "agents", title: "Agents", meta: attention ? `${attention} need attention` : `${state.agents.length} active`, icon: "●" },
        { screen: "panels", title: "Panels", meta: workspace ? `${state.tabs.length} terminal tabs` : "Select workspace first", icon: "▦" },
        { screen: "worktrees", title: "Worktrees", meta: "Discover, open, or create Git worktrees", icon: "wt" },
        { screen: "files", title: "Files", meta: workspace ? "Browse current workspace" : "Select workspace first", icon: "fi" },
        { screen: "git", title: "Git", meta: workspace ? "Status, diff, branches, history" : "Select workspace first", icon: "git" },
        { screen: "settings", title: "Settings", meta: "Appearance, search, alerts, terminal", icon: "⚙" },
        { screen: "sessions", title: "Sessions", meta: `${state.session || "default"} · ${sessionBackendLabel(currentSessionBackend())}`, icon: "se" },
      ];
      return `<section class="mobile-section mobile-more"><h2>More tools</h2><p class="mobile-help">Less-used tools stay here so Home, Search, and Terminal remain fast.</p><div class="mobile-more-grid">${tools.map((tool) => `<button class="mobile-more-card" onclick="HerdrMobile.showScreen('${tool.screen}')"><span class="mobile-more-icon">${escapeHtml(tool.icon)}</span><strong>${escapeHtml(tool.title)}</strong><small>${escapeHtml(tool.meta)}</small></button>`).join("")}</div></section>`;
    }

    // Workspace rows (mobile parity with the desktop workspace list).
    function renderWorkspaces() {
      if (!state.workspaces.length)
        return '<div class="mobile-loading">No workspaces</div>';
      return state.workspaces
        .map((workspace) => {
          const active = workspace.workspace_id === state.ws ? " active" : "";
          return `<button class="mobile-row${active}" onclick="HerdrMobile.selectWorkspace(${jsArg(workspace.workspace_id)})"><strong>${escapeHtml(workspaceTitle(workspace))}</strong><span>${escapeHtml(workspaceMeta(workspace))}</span></button>`;
        })
        .join("");
    }

    function renderAgents() {
      return `<section class="mobile-section"><h2>Agents</h2>${renderAgentsRows()}</section>`;
    }

    function renderAgentsRows() {
      if (!state.agents.length)
        return '<div class="mobile-loading">No agents</div>';
      const workingDismissals = getWorkingDismissals();
      if (workingDismissals) workingDismissals.cleanup(state.agents);
      const byId = workspacesById();
      const byTab = tabsById();
      const counts = tabCountsByWorkspace();
      return mobileAttention
        .sortAgents(state.agents)
        .map((agent) => {
          const active =
            agent.workspace_id === state.ws &&
            agent.tab_id === state.tab &&
            agent.pane_id === state.pane
              ? " active"
              : "";
          const name =
            agent.name ||
            agent.display_agent ||
            agent.agent ||
            agent.terminal_id ||
            "agent";
          const status = mobileAttention.statusClass(agent.agent_status);
          const dismissed = workingDismissals && workingDismissals.isWorkingDismissed(agent);
          const displayStatus = dismissed ? "ignored" : status;
          const dismissAction =
            status === "working" && workingDismissals
              ? dismissed
                ? `<span class="mobile-btn mini agent-action" role="button" tabindex="0" title="Show this working agent again" onclick="event.stopPropagation();HerdrMobile.restoreWorkingAgent(${jsArg(agent.workspace_id)},${jsArg(agent.tab_id)},${jsArg(agent.pane_id)},${jsArg(agent.terminal_id || "")})">Undo</span>`
                : `<span class="mobile-btn mini agent-action" role="button" tabindex="0" title="Locally ignore this stuck working state" onclick="event.stopPropagation();HerdrMobile.dismissWorkingAgent(${jsArg(agent.workspace_id)},${jsArg(agent.tab_id)},${jsArg(agent.pane_id)},${jsArg(agent.terminal_id || "")})">Dismiss</span>`
              : "";
          const workspace = byId[agent.workspace_id];
          const repo =
            workspace && workspace.worktree
              ? parentWorkspaceName(workspace, byId)
              : null;
          const worktree =
            workspace && workspace.worktree
              ? worktreeDisplayName(workspace)
              : workspace
                ? workspace.label
                : agent.workspace_id;
          const panel = agentTabLabel(
            agent.workspace_id,
            byTab[agent.tab_id],
            counts,
          );
          const title = [repo, worktree, panel].filter(Boolean).join(" › ");
          return `<button class="mobile-row${active}${dismissed ? " agent-dismissed" : ""}" onclick="HerdrMobile.selectAgent(${jsArg(agent.workspace_id)},${jsArg(agent.tab_id)},${jsArg(agent.pane_id)})"><strong>${escapeHtml(title || name)}</strong><span><span class="mobile-chip">${escapeHtml(displayStatus)}</span> ${escapeHtml(name)}${dismissAction}</span></button>`;
        })
        .join("");
    }

    function mobileNavLabel(screen) {
      if (screen === "home") return "Home";
      if (screen === "search") return "Search";
      if (screen === "terminal") return "Terminal";
      if (screen !== "more") return screen;
      const status = mobileAttention.topStatus();
      return `More${status ? ` <span class="mobile-nav-status ${escapeHtml(status)}">${escapeHtml(status)}</span>` : ""}`;
    }

    function mobileNavActive(screen) {
      if (screen === "more") return state.screen === "more" || MORE_SCREENS.includes(state.screen);
      return screen === state.screen;
    }

    function dismissWorkingAgent(workspaceId, tabId, paneId, terminalId) {
      const workingDismissals = getWorkingDismissals();
      if (!workingDismissals) return;
      const agent = state.agents.find(
        (item) =>
          item.workspace_id === workspaceId &&
          item.tab_id === tabId &&
          item.pane_id === paneId &&
          (!terminalId || item.terminal_id === terminalId),
      );
      if (!agent) return;
      workingDismissals.dismiss(agent);
      render();
    }

    function restoreWorkingAgent(workspaceId, tabId, paneId, terminalId) {
      const workingDismissals = getWorkingDismissals();
      if (!workingDismissals) return;
      const agent = state.agents.find(
        (item) =>
          item.workspace_id === workspaceId &&
          item.tab_id === tabId &&
          item.pane_id === paneId &&
          (!terminalId || item.terminal_id === terminalId),
      );
      if (!agent) return;
      workingDismissals.restore(agent);
      render();
    }

    function clearDismissedWorkingForTerminal(terminalId) {
      const workingDismissals = getWorkingDismissals();
      if (!workingDismissals || !terminalId) return;
      workingDismissals.clearForTerminal(terminalId);
    }

    return {
      renderHome,
      renderMore,
      renderAgents,
      renderWorkspaces,
      renderAgentsRows,
      mobileNavLabel,
      mobileNavActive,
      dismissWorkingAgent,
      restoreWorkingAgent,
      clearDismissedWorkingForTerminal,
    };
  }

  globalThis.HerdrMobileScreensModule = { create: createMobileScreens };
})();