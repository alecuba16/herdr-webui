(function () {
  function createMobileScreens({
    state,
    render,
    escapeHtml,
    inputAttrs,
    jsArg,
    MORE_SCREENS,
    currentWorkspace,
    workspaceTitle,
    workspaceMeta,
    contextMeta,
    sessionBackendLabel,
    currentSessionBackend,
    mobileAttention,
    api,
    refresh,
    confirmFn,
    getWorkingDismissals,
    workspacesById,
    tabsById,
    tabCountsByWorkspace,
    parentWorkspaceName,
    worktreeDisplayName,
    agentTabLabel,
  }) {
    function renderHome() {
      return `${renderTaskHub()}<section class="mobile-section"><h2>Workspaces</h2>${renderWorkspaces()}</section><section class="mobile-section"><h2>Agents needing attention</h2>${renderAttentionAgents()}</section>${renderRenameSheet()}`;
    }

    function renderTaskHub() {
      const active = currentWorkspace();
      // Single primary card: the old second card opened the search sheet,
      // which duplicated the persistent nav Search tab (reviewer-audited
      // duplicate flow). Search stays reachable from the nav bar.
      const activeAction = active
        ? `<button class="mobile-task-card primary" onclick="HerdrMobile.showScreen('terminal')"><strong>Continue ${escapeHtml(workspaceTitle(active))}</strong><span>${escapeHtml(contextMeta(active))}</span></button>`
        : `<button class="mobile-task-card primary" onclick="HerdrMobile.runAction('open-workspace')"><strong>Open workspace or worktree</strong><span>Pick a folder, discover worktrees, or create a checkout.</span></button>`;
      return `<section class="mobile-section mobile-task-hub"><h2>Start</h2><div class="mobile-task-grid">${activeAction}</div></section>`;
    }

    function renderAttentionAgents() {
      const attention = mobileAttention
        .sortAgents(state.agents)
        .filter((agent) => ["blocked", "done"].includes(mobileAttention.statusClass(agent.agent_status)));
      if (!attention.length) {
        // During boot the agents fetch is still pending: show the skeleton
        // (same row shape) instead of "No blocked or done agents".
        const bootSkeleton = skeleton("agents", 2);
        if (bootSkeleton) return bootSkeleton;
        return '<div class="mobile-loading">No blocked or done agents</div>';
      }
      const previousAgents = state.agents;
      state.agents = attention;
      try {
        return renderAgentsRows();
      } finally {
        state.agents = previousAgents;
      }
    }

    // Workspace rows (mobile parity with the desktop workspace list).
    // Skeleton placeholder (same row shape as the real content) shown while
    // the first refresh fetch / websocket connect is still pending at boot.
    function skeleton(kind, count) {
      const helper = globalThis.HerdrSkeleton;
      if (!helper || !state.booting) return null;
      return kind === "agents" ? helper.agents(count) : helper.workspaces(count);
    }

    function renderWorkspaces() {
      const bootSkeleton = skeleton("workspaces", 3);
      if (bootSkeleton) return bootSkeleton;
      if (!state.workspaces.length)
        return '<div class="mobile-loading">No workspaces</div>';
      return state.workspaces
        .map((workspace) => {
          const active = workspace.workspace_id === state.ws ? " active" : "";
          return `<div class="mobile-workspace-row"><button class="mobile-row${active}" onclick="HerdrMobile.selectWorkspace(${jsArg(workspace.workspace_id)})"><strong>${escapeHtml(workspaceTitle(workspace))}</strong><span>${escapeHtml(workspaceMeta(workspace))}</span></button><span class="mobile-row-actions"><button class="mobile-btn mini" aria-label="Rename workspace" onclick="HerdrMobile.renameWorkspace(${jsArg(workspace.workspace_id)}, ${jsArg(workspaceTitle(workspace))})">✎</button><button class="mobile-btn mini danger" aria-label="Close workspace" onclick="HerdrMobile.closeWorkspace(${jsArg(workspace.workspace_id)})">✕</button></span></div>`;
        })
        .join("");
    }

    // Workspace switcher rows (header title sheet): same data as the Home
    // list, minus rename/close actions. Selecting switches and the sheet
    // closes (app.js owns that part).
    function renderWorkspacesSheetList() {
      if (!state.workspaces.length)
        return '<div class="mobile-loading">No workspaces</div>';
      return state.workspaces
        .map((workspace) => {
          const active = workspace.workspace_id === state.ws;
          return `<button class="mobile-row${active ? " active" : ""}" onclick="HerdrMobile.selectWorkspaceFromSheet(${jsArg(workspace.workspace_id)})"><strong>${escapeHtml(workspaceTitle(workspace))}${active ? " · current" : ""}</strong><span>${escapeHtml(workspaceMeta(workspace))}</span></button>`;
        })
        .join("");
    }

    function renderRenameSheet() {
      if (!state.renameWorkspaceId) return "";
      return `<div class="mobile-sheet-backdrop" onclick="HerdrMobile.cancelRenameWorkspace()"></div><div class="mobile-sheet" role="dialog" aria-label="Rename workspace"><div class="mobile-sheet-handle"></div><div class="mobile-sheet-title">Rename workspace</div><input id="mobileRenameInput" class="mobile-sheet-input" type="text"${inputAttrs("done")} value="${escapeHtml(state.renameWorkspaceValue)}" placeholder="Workspace name" oninput="HerdrMobile.setRenameWorkspaceValue(this.value)" onkeydown="if (event.key === 'Enter') { event.preventDefault(); HerdrMobile.submitRenameWorkspace(); } if (event.key === 'Escape') { event.preventDefault(); HerdrMobile.cancelRenameWorkspace(); }">${state.renameWorkspaceError ? `<div class="mobile-error">${escapeHtml(state.renameWorkspaceError)}</div>` : ""}<div class="mobile-sheet-actions"><button class="mobile-btn" onclick="HerdrMobile.cancelRenameWorkspace()">Cancel</button><button class="mobile-btn primary" onclick="HerdrMobile.submitRenameWorkspace()">Save</button></div></div>`;
    }

    function startRenameWorkspace(workspaceId, currentTitle) {
      state.renameWorkspaceId = workspaceId;
      state.renameWorkspaceValue = currentTitle || "";
      state.renameWorkspaceError = "";
      render();
    }

    function setRenameWorkspaceValue(value) {
      state.renameWorkspaceValue = String(value || "");
    }

    async function submitRenameWorkspace() {
      const workspaceId = state.renameWorkspaceId;
      if (!workspaceId) return;
      const label = String(state.renameWorkspaceValue || "").trim();
      if (!label) {
        state.renameWorkspaceError = "Name cannot be empty.";
        render();
        return;
      }
      try {
        await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/rename`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label }),
        });
        state.renameWorkspaceId = null;
        state.renameWorkspaceError = "";
        await refresh();
      } catch (error) {
        state.renameWorkspaceError = error.message || String(error);
        render();
      }
    }

    function cancelRenameWorkspace() {
      state.renameWorkspaceId = null;
      state.renameWorkspaceError = "";
      render();
    }

    async function closeWorkspaceById(workspaceId) {
      if (!(await confirmFn(`Close workspace ${workspaceId}? Unsaved work in its agents may be lost.`))) return;
      try {
        await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/close`, {
          method: "POST",
        });
        await refresh();
      } catch (error) {
        state.renameWorkspaceError = error.message || String(error);
        render();
      }
    }

    function renderAgents() {
      return `<section class="mobile-section"><h2>Agents</h2>${renderAgentsRows()}</section>`;
    }

    function renderAgentsRows() {
      const bootSkeleton = skeleton("agents", 2);
      if (bootSkeleton) return bootSkeleton;
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
      if (screen === "git") return "Git";
      if (screen === "files") return "Files";
      if (screen !== "more") return screen;
      // Only surface attention pills for statuses the CSS styles; an unknown
      // agent status would render an unstyled "unknown" pill permanently.
      const status = mobileAttention.topStatus();
      const pill = ["blocked", "done", "idle", "working"].includes(status)
        ? ` <span class="mobile-nav-status ${escapeHtml(status)}">${escapeHtml(status)}</span>`
        : "";
      return `More${pill}`;
    }

    function mobileNavActive(screen) {
      if (screen === "more") return MORE_SCREENS.includes(state.screen);
      return screen === state.screen;
    }

    function renderDrawerItems() {
      // Secondary screens live in the drawer instead of the More grid. Keep
      // the same meta lines so the drawer carries the live counts.
      const attention = state.agents.filter((agent) => ["blocked", "done"].includes(mobileAttention.statusClass(agent.agent_status))).length;
      const workspace = currentWorkspace();
      const items = [
        { screen: "agents", title: "Agents", meta: attention ? `${attention} need attention` : `${state.agents.length} active`, icon: "●" },
        { screen: "panels", title: "Panels", meta: workspace ? `${state.tabs.length} terminal tabs` : "No workspace open", icon: "▦" },
        { screen: "worktrees", title: "Worktrees", meta: "Discover, open, or create Git worktrees", icon: "wt" },
        { screen: "sessions", title: "Sessions", meta: `${state.session || "default"} · ${sessionBackendLabel(currentSessionBackend())}`, icon: "se" },
        { screen: "settings", title: "Settings", meta: "Appearance, search, alerts, terminal", icon: "⚙" },
      ];
      return items.map((item) => `<button class="mobile-drawer-item" onclick="HerdrMobile.openDrawerTarget('${item.screen}')"><span class="mobile-drawer-icon" aria-hidden="true">${escapeHtml(item.icon)}</span><span class="mobile-drawer-text"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.meta)}</small></span></button>`).join("");
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
      renderDrawerItems,
      renderAgents,
      renderWorkspaces,
      renderWorkspacesSheetList,
      startRenameWorkspace,
      setRenameWorkspaceValue,
      submitRenameWorkspace,
      cancelRenameWorkspace,
      closeWorkspaceById,
      renderRenameSheet,
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