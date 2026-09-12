(function () {
  const {
    escapeHtml,
    jsArg,
    parseRoutePath,
    pathBasename,
    samePath,
    selectionPath: mobileSelectionPath,
    sessionPrefix,
  } = globalThis.HerdrMobileCore;
  const { createFaviconNotifier } = globalThis.HerdrAppHelpers;
  const MORE_SCREENS = ["agents", "panels", "worktrees", "files", "git", "settings", "sessions"];

  const state = {
    session: "default",
    backendMode: "",
    // Built-in sessions are the default; /api/server-settings confirms the
    // server's configured backend mode on first load.
    sessionBackend: localStorage.getItem("herdr-session-backend") || "builtin",
    serverBackendConfirmed: false,
    // Backend enablement from the server's enabled_backends (settings). A
    // long-lived tab may outlive a settings change that disabled a backend;
    // null means "unknown yet" (older servers) and never gates anything.
    backendsEnabled: { builtin: null, "external-herdr": null },
    // The server's configured default backend (settings-change broadcast);
    // used to retarget when the pinned backend gets disabled.
    serverDefaultBackend: null,
    // Session manager screen state: the known session rows from
    // /api/sessions, the new-session name input, and its busy/error state.
    sessions: [],
    sessionsError: "",
    sessionNameInput: "",
    sessionBusy: false,
    sessionBusyLabel: "",
    sessionCreateExpanded: false,
    herdrAvailable: null,
    herdrCompatible: null,
    herdrVersion: null,
    workspaces: [],
    tabs: [],
    allTabs: [],
    panes: [],
    agents: [],
    worktreeRows: [],
    worktreeSource: null,
    ws: null,
    tab: null,
    pane: null,
    terminalId: null,
    screen: "home",
    error: "",
    worktreeError: "",
    worktreeDiscoverPath: "",
    worktreeBranch: "",
    worktreeBase: "",
    worktreeLabel: "",
    worktreePath: "",
    worktreeCreateExpanded: false,
    worktreeLoading: false,
    worktreeLoadingLabel: "",
    worktreeBusyIndex: null,
    gitCwd: "",
    gitStatus: null,
    gitError: "",
    gitFile: "",
    gitKind: "",
    gitDiff: null,
    gitDiffError: "",
    gitBranches: null,
    gitBranchesError: "",
    gitBusy: "",
    gitMutating: false,
    defaultFolder: "",
  };

  let eventWs,
    eventRefreshTimer = null,
    eventReconnectTimer = null,
    refreshSeq = 0,
    browserFavicon = createFaviconNotifier(document),
    browserFaviconError = false,
    mobileAttention,
    mobileSettings,
    mobileTerminal,
    mobileTempTerminal,
    mobileFileBrowser,
    mobileWorktrees,
    mobileSearch;

  function el(id) {
    return document.getElementById(id);
  }

  let largestVisualViewportHeight = 0,
    terminalResizeTimer = null;

  function updateMobileViewport() {
    const viewport = window.visualViewport;
    const height = Math.max(
      240,
      Math.floor(
        (viewport && viewport.height) ||
          window.innerHeight ||
          (document.documentElement && document.documentElement.clientHeight) ||
          0,
      ),
    );
    largestVisualViewportHeight = Math.max(largestVisualViewportHeight, height);
    document.body.style.setProperty("--herdr-mobile-viewport-height", `${height}px`);
    document.body.classList.toggle(
      "mobile-keyboard-open",
      state.screen === "terminal" && largestVisualViewportHeight - height > 120,
    );
  }

  function scheduleTerminalResize() {
    updateMobileViewport();
    if (terminalResizeTimer) clearTimeout(terminalResizeTimer);
    terminalResizeTimer = setTimeout(() => {
      terminalResizeTimer = null;
      if (state.screen === "terminal") mobileTerminal.connect();
    }, 80);
  }

  function selectionPath(ws, tab, pane) {
    return mobileSelectionPath(state.session, ws, tab, pane);
  }

  function parseRoute(syncScreen) {
    const route = parseRoutePath(location.pathname);
    state.session = route.session;
    state.ws = route.ws;
    state.tab = route.tab;
    state.pane = route.pane;
    if (syncScreen && (state.pane || state.tab)) state.screen = "terminal";
  }

  // All HTTP from mobile goes through the shared HerdrHttp client so both
  // layouts send identical session/backend headers and 401 handling.
  if (globalThis.HerdrHttp) {
    globalThis.HerdrHttp.configure(() => ({
      session: state.session,
      backend: currentSessionBackend(),
    }));
  }

  function apiOptions(opt) {
    return globalThis.HerdrHttp
      ? globalThis.HerdrHttp.options(opt)
      : Object.assign({ credentials: "same-origin" }, opt || {});
  }

  async function api(url, opt) {
    if (globalThis.HerdrHttp) return globalThis.HerdrHttp.request(url, opt);
    const response = await fetch(url, apiOptions(opt));
    if (response.status === 401) {
      location.href = "/";
      throw Error("unauthorized");
    }
    const body = await response.json();
    if (!response.ok || body.error)
      throw Error(apiErrorMessage(body, response.statusText));
    return body;
  }

  async function loadServerSettings() {
    try {
      const settings = await api("/api/server-settings");
      state.backendMode = settings.backend_mode || state.backendMode;
      state.defaultFolder = settings.default_folder || state.defaultFolder || "";
      // The server's default backend derives from its configured mode and
      // the enablement flags; record it before syncing so a disabled pin
      // retargets accurately.
      if (settings.backend_mode)
        state.serverDefaultBackend =
          settings.backend_mode === "external" || settings.backend_mode === "external-herdr"
            ? "external-herdr"
            : "builtin";
      // The server's enabled_backends is authoritative: a tab pinned before
      // a backend was disabled mid-session must retarget instead of
      // silently rerouting. Older servers omit the field; unknown never gates.
      if (settings.enabled_backends) {
        state.backendsEnabled = {
          builtin: settings.enabled_backends.builtin !== false,
          "external-herdr": settings.enabled_backends["external-herdr"] !== false,
        };
        syncSessionBackendFromServer();
      }
      // Built-in is the default backend. On first load adopt the server's
      // configured mode so stale localStorage cannot lock the browser into an
      // unexpected backend; afterwards keep the user's explicit choice.
      if (!state.serverBackendConfirmed && state.backendMode) {
        state.sessionBackend =
          state.backendMode === "external" || state.backendMode === "external-herdr"
            ? "external-herdr"
            : state.backendMode === "builtin"
              ? "builtin"
              : state.sessionBackend;
        localStorage.setItem("herdr-session-backend", state.sessionBackend);
      }
      state.serverBackendConfirmed = true;
    } catch (_) {}
    await loadSessions();
  }

  // Fetch the known sessions plus the herdr install/enablement state.
  // Shared by the init flow and the mobile sessions screen so the screen
  // always reflects the server's view.
  async function loadSessions() {
    try {
      const r = await api("/api/sessions");
      state.sessions = r.sessions || [];
      state.sessionsError = "";
      // External herdr sessions are only offered when a compatible herdr
      // install is detected. If it is missing or incompatible, fall back to
      // built-in instead of targeting a guaranteed-failed attach.
      state.herdrAvailable = !!r.herdr_available;
      state.herdrCompatible = !!r.herdr_compatible;
      state.herdrVersion = r.herdr_version || null;
      if (r.default_backend) state.serverDefaultBackend = r.default_backend;
      if (r.enabled_backends) {
        state.backendsEnabled = {
          builtin: r.enabled_backends.builtin !== false,
          "external-herdr": r.enabled_backends["external-herdr"] !== false,
        };
        syncSessionBackendFromServer();
      }
      if (currentSessionBackend() === "external-herdr" && !state.herdrCompatible) {
        state.sessionBackend = "builtin";
        localStorage.setItem("herdr-session-backend", "builtin");
      }
    } catch (e) {
      state.sessions = [
        { name: state.session || "default", backend: currentSessionBackend(), running: false },
      ];
      state.sessionsError = e.message || String(e);
    }
  }

  function apiErrorMessage(body, statusText) {
    const err = body && body.error;
    if (!err) return statusText;
    if (typeof err === "string") return err;
    return err.message || err.code || statusText;
  }

  function wsUrl(path) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const params = [];
    if (state.session && state.session !== "default")
      params.push("session=" + encodeURIComponent(state.session));
    if (currentSessionBackend())
      params.push("backend=" + encodeURIComponent(currentSessionBackend()));
    const suffix = params.length
      ? (path.includes("?") ? "&" : "?") + params.join("&")
      : "";
    return `${proto}//${location.host}${path}${suffix}`;
  }

  // Graceful degradation: the external herdr backend could not be attached
  // (protocol mismatch, unreachable...). Close the broken session and offer
  // a built-in session instead of leaving the terminal blocked.
  let herdrErrorOfferPending = false;
  function handleHerdrErrorFrame(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return false;
    }
    if (!msg || msg.type !== "herdr_error") return false;
    if (herdrErrorOfferPending) return true;
    herdrErrorOfferPending = true;
    (async () => {
      try {
        if (currentSessionBackend() === "external-herdr") {
          try {
            await api("/api/session/close", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ session: state.session || "default", backend: "external-herdr" }),
            });
          } catch (_) {}
        }
        const detail = msg.message ? ` (${msg.message})` : "";
        // The server reroutes disabled backends to the remaining enabled
        // one, so the frame may be about the backend actually serving this
        // browser, not the stale external pin. Say which backend failed.
        const failedBackend = msg.backend || currentSessionBackend();
        const failedLabel = sessionBackendLabel(failedBackend);
        // Only offer built-in when the settings allow it; otherwise fall
        // through to the manager so the user picks an enabled target
        // instead of silently rerouting to a disabled backend.
        const wantsBuiltin =
          backendEnabled("builtin") &&
          confirm(
            `The ${failedLabel} backend could not be attached${detail}. ` +
              "It has been disconnected. Start a built-in session instead?",
          );
        if (wantsBuiltin) {
          try {
            await api("/api/session/launch", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ session: state.session || "default", backend: "builtin" }),
            });
          } catch (_) {}
          state.sessionBackend = "builtin";
          localStorage.setItem("herdr-session-backend", "builtin");
          refresh();
        }
      } finally {
        herdrErrorOfferPending = false;
      }
    })();
    return true;
  }

  function currentSessionBackend() {
    if (state.sessionBackend === "external") return "external-herdr";
    if (state.sessionBackend === "builtin" || state.sessionBackend === "external-herdr")
      return state.sessionBackend;
    if (state.backendMode === "external" || state.backendMode === "external-herdr")
      return "external-herdr";
    if (state.backendMode === "builtin") return "builtin";
    return "";
  }
  // True when the server settings allow the given backend. Unknown (null,
  // from an older server that omits enabled_backends) never disables anything.
  function backendEnabled(backend) {
    const enabled = state.backendsEnabled && state.backendsEnabled[backend];
    return enabled !== false;
  }
  // Re-validate the pinned backend against the server's enabled backends:
  // a tab that pinned a backend before it was disabled mid-session must
  // retarget instead of silently rerouting every request. Prefer the
  // server's default backend (from /api/versions or the settings-change
  // broadcast) when still enabled, then built-in, then whichever remains
  // enabled (the server enforces at least one enabled backend).
  function syncSessionBackendFromServer() {
    if (!state.sessionBackend) return;
    if (backendEnabled(state.sessionBackend)) return;
    const fallback =
      state.serverDefaultBackend && backendEnabled(state.serverDefaultBackend)
        ? state.serverDefaultBackend
        : backendEnabled("builtin")
          ? "builtin"
          : "external-herdr";
    state.sessionBackend = fallback;
    localStorage.setItem("herdr-session-backend", fallback);
    // The events socket is bound to the disabled backend through its URL
    // query (?backend=...). Cycle it so the reconnect targets the fallback
    // backend instead of polling the dead one until a manual reload.
    if (eventWs) {
      eventWs.onclose = null;
      try {
        eventWs.close();
      } catch (e) {}
      eventWs = null;
      scheduleEventReconnect();
    }
  }
  function sessionBackendLabel(backend) {
    return backend === "external-herdr" ? "Herdr" : "built-in";
  }
  function sessionBackendClass(backend) {
    return backend === "external-herdr" ? "backend-herdr" : "backend-builtin";
  }

  function handleServerSettingsChanged(msg) {
    const enabled = msg.enabled_backends;
    if (!enabled) return;
    state.backendsEnabled = {
      builtin: enabled.builtin !== false,
      "external-herdr": enabled["external-herdr"] !== false,
    };
    if (msg.default_backend) state.serverDefaultBackend = msg.default_backend;
    syncSessionBackendFromServer();
    refresh();
  }

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

  // Backend badge: Herdr sessions get a distinct mauve hue; built-in keeps
  // the accent family. Rendered next to the header meta line.
  function syncBackendBadge() {
    const badge = el("mobileBackendBadge");
    if (!badge) return;
    const backend = currentSessionBackend() || "builtin";
    badge.className = `mobile-backend-badge ${sessionBackendClass(backend)}`;
    badge.textContent = `${sessionBackendLabel(backend)} · ${state.session || "default"}`;
    badge.title = "Sessions";
    badge.onclick = () => showScreen("sessions");
  }

  function renderShell() {
    document.body.innerHTML = `
      <div id="mobileApp" class="mobile-app">
        <header class="mobile-header">
          <button class="mobile-btn" id="mobileBack" title="Home">←</button>
          <div class="mobile-context"><strong id="mobileTitle">Herdr</strong><span id="mobileMeta">Loading</span><button type="button" id="mobileBackendBadge" class="mobile-backend-badge backend-builtin" title="Sessions" aria-label="Sessions">built-in</button></div>
          <button class="mobile-btn" id="mobileSearch" title="Search">⌕</button>
          <button class="mobile-btn" id="mobileSettings" title="Settings">⚙</button>
          <button class="mobile-btn temp-terminal-toggle" id="mobileTempTerminal" title="Temporary terminal" aria-label="Temporary terminal"><span class="temp-terminal-icon" aria-hidden="true"><span class="temp-terminal-icon-glyph"></span><span class="temp-terminal-icon-label">T</span></span></button>
        </header>
        <main class="mobile-screen" id="mobileScreen"></main>
        <div class="mobile-search-sheet" id="mobileSearchSheet" hidden>
          <div class="mobile-search-card">
            <div class="mobile-search-head"><input id="mobileSearchInput" placeholder="Search workspaces, files, folders, content" autocomplete="off" /><button class="mobile-btn" id="mobileSearchClose">✕</button></div>
            <div class="mobile-search-results" id="mobileSearchResults"></div>
            <div class="mobile-help">Enter opens · Alt+F files · Alt+D folders · Esc closes</div>
          </div>
        </div>
        <nav class="mobile-nav">
          <button data-screen="home">Home</button>
          <button data-screen="search">Search</button>
          <button data-screen="terminal">Terminal</button>
          <button data-screen="more">More</button>
        </nav>
      </div>
      </div>`;
    el("mobileBack").onclick = () => showScreen("home");
    el("mobileSearch").onclick = () => mobileSearch && mobileSearch.open();
    el("mobileSettings").onclick = () => showScreen("settings");
    el("mobileTempTerminal").onclick = () => mobileTempTerminal && mobileTempTerminal.open(currentWorkspaceCwd());
    document.querySelectorAll(".mobile-nav button").forEach((button) => {
      button.onclick = () => showScreen(button.dataset.screen);
    });
  }

  function showScreen(screen) {
    if (screen === "search") {
      mobileSearch.open();
      return;
    }
    const wasTerminal = state.screen === "terminal";
    const wasSettings = state.screen === "settings";
    state.screen = screen;
    if (wasTerminal && screen !== "terminal") mobileTerminal.destroy(false);
    if (!wasSettings && screen === "settings" && mobileSettings.resetSettingBaselines)
      mobileSettings.resetSettingBaselines();
    if (screen === "settings" && mobileSettings.loadNoSleep) mobileSettings.loadNoSleep();
    if (screen === "sessions" && !state.sessionBusy) refreshSessions();
    if (screen === "worktrees" && mobileWorktrees.loadRecent) mobileWorktrees.loadRecent();
    render();
    if (screen === "terminal") mobileTerminal.connect();
  }

  function render() {
    if (!el("mobileScreen")) renderShell();
    updateMobileViewport();
    applyTreeIndent();
    const workspace = currentWorkspace();
    el("mobileTitle").textContent = workspaceTitle(workspace);
    el("mobileMeta").textContent = contextMeta(workspace);
    syncBackendBadge();
    const searchButton = el("mobileSearch");
    if (searchButton) {
      const disabled = headerSearchDisabled();
      searchButton.hidden = disabled;
      searchButton.disabled = disabled;
    }
    document.querySelectorAll(".mobile-nav button").forEach((button) => {
      const searchNavDisabled = button.dataset.screen === "search" && headerSearchDisabled();
      button.hidden = searchNavDisabled;
      button.disabled = searchNavDisabled;
      button.classList.toggle("active", mobileNavActive(button.dataset.screen));
      button.innerHTML = mobileNavLabel(button.dataset.screen);
    });
    const screen = el("mobileScreen");
    screen.classList.toggle("terminal-active", state.screen === "terminal");
    if (state.error) {
      syncBrowserFavicon();
      screen.innerHTML = `<div class="mobile-error">${escapeHtml(state.error)}</div>`;
      return;
    }
    if (state.screen === "agents") screen.innerHTML = renderAgents();
    else if (state.screen === "panels") screen.innerHTML = renderPanels();
    else if (state.screen === "worktrees")
      screen.innerHTML = mobileWorktrees.renderScreen();
    else if (state.screen === "files")
      screen.innerHTML = mobileFileBrowser.renderScreen();
    else if (state.screen === "git") renderGitScreen(screen);
    else if (state.screen === "settings")
      screen.innerHTML = mobileSettings.render();
    else if (state.screen === "sessions")
      screen.innerHTML = renderSessions();
    else if (state.screen === "terminal") renderTerminalScreen(screen);
    else if (state.screen === "more") screen.innerHTML = renderMore();
    else screen.innerHTML = renderHome();
    syncBrowserFavicon();
  }

  function headerSearchDisabled() {
    try {
      return (globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {}).headerSearchEnabled === false;
    } catch (_) {
      return false;
    }
  }

  function applyTreeIndent() {
    try {
      const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
      const value = Math.max(0, Math.min(40, Number(parsed.treeIndentPx) || 14));
      document.body.style.setProperty("--herdr-tree-indent", `${value}px`);
    } catch (_) {}
  }

  function syncBrowserFavicon() {
    if (browserFaviconError) {
      browserFavicon.set("error");
      return;
    }
    const attention = state.agents.some((agent) => {
      const status = mobileAttention.statusClass(agent.agent_status);
      return status === "blocked" || status === "done";
    });
    browserFavicon.set(document.hidden && attention ? "attention" : "normal");
  }

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

  // Sessions screen: mobile parity with the desktop session manager.
  // Lists known sessions, creates built-in/Herdr sessions, switches the
  // browser target, and closes the active session.
  function renderSessions() {
    const busy = !!state.sessionBusy;
    const loading = busy ? `<div class="mobile-loading">${escapeHtml(state.sessionBusyLabel || "Working...")}</div>` : "";
    const error = state.sessionsError ? `<div class="mobile-error">${escapeHtml(state.sessionsError)}</div>` : "";
    const current = `${state.session || "default"} · ${sessionBackendLabel(currentSessionBackend())}`;
    const rows = (state.sessions || []).map((row) => {
      const backend = row.backend || (backendEnabled("external-herdr") ? "external-herdr" : "builtin");
      const active =
        row.name === state.session && backend === currentSessionBackend();
      const label = row.name || "default";
      const pill = `<span class="mobile-chip ${sessionBackendClass(backend)}">${escapeHtml(row.backend_label || sessionBackendLabel(backend))}</span>`;
      const status = row.running
        ? '<span class="mobile-chip">running</span>'
        : '<span class="mobile-chip">offline</span>';
      const controls = active
        ? `${pill}<span class="mobile-btn agent-action" role="button" tabindex="0" ${busy ? "data-disabled=\"1\"" : ""} onclick="event.stopPropagation();HerdrMobile.refreshSessions()">Retry</span><span class="mobile-btn danger agent-action" role="button" tabindex="0" ${busy ? "data-disabled=\"1\"" : ""} onclick="event.stopPropagation();HerdrMobile.closeSession()">Close</span>`
        : `${pill}${status}`;
      return `<button class="mobile-row${active ? " active" : ""}" onclick="HerdrMobile.selectSession(${jsArg(label)},${jsArg(backend)})"><strong>${escapeHtml(label)}${active ? " · current" : ""}</strong><span>${controls}</span></button>`;
    }).join("");
    const herdrUsable = state.herdrCompatible && backendEnabled("external-herdr");
    return `<section class="mobile-section mobile-form"><h2>Sessions</h2><p class="mobile-help">Current target: ${escapeHtml(current)}. Tap a session to switch, or create a new one.</p><div class="mobile-settings-group"><h3>Known sessions</h3>${rows ? rows : '<div class="mobile-loading">No sessions found yet</div>'}${loading}${error}</div><details class="mobile-settings-group mobile-disclosure" ${state.sessionCreateExpanded ? "open" : ""} onchange="HerdrMobile.setSessionCreateExpanded(this.open)"><summary>Create new session</summary><label><span>Session name</span><input value="${escapeHtml(state.sessionNameInput)}" oninput="HerdrMobile.updateSessionField('sessionNameInput', this.value)" placeholder="revolut"></label><div class="mobile-session-actions"><button class="mobile-btn primary" ${busy ? "disabled" : ""} onclick="HerdrMobile.newSession('builtin')">New built-in</button>${herdrUsable ? `<button class="mobile-btn" ${busy ? "disabled" : ""} onclick="HerdrMobile.newSession('external-herdr')">New Herdr</button>` : ""}</div></details></section>`;
  }

  async function refreshSessions() {
    if (state.sessionBusy) return;
    state.sessionBusy = true;
    state.sessionBusyLabel = "Loading sessions...";
    render();
    try {
      await loadSessions();
    } finally {
      state.sessionBusy = false;
      state.sessionBusyLabel = "";
      render();
    }
  }

  function updateSessionField(field, value) {
    state[field] = value;
  }

  function setSessionCreateExpanded(open) {
    state.sessionCreateExpanded = !!open;
  }

  // Launch a new session on the chosen backend and switch the browser to
  // it (mobile parity with the desktop newSessionTarget flow).
  async function newSession(backend) {
    const name = (state.sessionNameInput || "").trim();
    if (!name) {
      state.sessionsError = "Session name is required.";
      render();
      return;
    }
    if (backend === "external-herdr" && !backendEnabled("external-herdr")) {
      state.sessionsError = "External Herdr sessions are disabled in server settings.";
      render();
      return;
    }
    if (backend === "external-herdr" && !state.herdrCompatible) {
      state.sessionsError = state.herdrAvailable
        ? `Detected herdr ${state.herdrVersion || ""} is not compatible with this WebUI build. Upgrade herdr or use a built-in session.`
        : "No compatible herdr install detected. Install herdr to use external Herdr sessions.";
      render();
      return;
    }
    state.sessionBusy = true;
    state.sessionBusyLabel = "Launching session...";
    render();
    try {
      const r = await api("/api/session/launch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: name, backend }),
      });
      if (!r.ok) throw Error(r.error || "Launch failed");
      await switchSession(name, backend);
      state.sessionNameInput = "";
      state.sessionCreateExpanded = false;
    } catch (e) {
      state.sessionsError = e.message || String(e);
    } finally {
      state.sessionBusy = false;
      state.sessionBusyLabel = "";
      render();
      setTimeout(refreshSessions, 400);
    }
  }

  // Switch the browser target to a session (mobile parity with the desktop
  // goSession flow: route, terminal, events socket, and list refresh).
  function switchSession(name, backend) {
    if (backend === "external-herdr" && (!state.herdrCompatible || !backendEnabled("external-herdr")))
      backend = "builtin";
    state.session = name || "default";
    state.sessionBackend = backend || "builtin";
    localStorage.setItem("herdr-session-backend", state.sessionBackend);
    state.ws = null;
    state.tab = null;
    state.pane = null;
    state.terminalId = null;
    state.workspaces = [];
    state.tabs = [];
    state.allTabs = [];
    state.panes = [];
    mobileTerminal.destroy(true);
    if (eventWs) {
      eventWs.onclose = null;
      try {
        eventWs.close();
      } catch (e) {}
      eventWs = null;
    }
    history.pushState(null, "", sessionPrefix(state.session));
    syncBackendBadge();
    refresh();
    connectEvents();
  }

  async function selectSession(name, backend) {
    if (name === state.session && backend === currentSessionBackend()) {
      // Tapping the current row just refreshes the list.
      refreshSessions();
      return;
    }
    switchSession(name, backend);
  }

  // Close the active session (mobile parity with closeCurrentSession).
  async function closeSession() {
    if (state.sessionBusy) return;
    if (!confirm(`Close current ${sessionBackendLabel(currentSessionBackend())} session?`)) return;
    state.sessionBusy = true;
    state.sessionBusyLabel = "Closing session...";
    render();
    try {
      await api("/api/session/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session: state.session || "default", backend: currentSessionBackend() }),
      });
      // Retarget the server's default backend so the refresh below lands
      // on a working session (the server auto-starts built-in on demand).
      state.sessionBackend = state.serverDefaultBackend || "builtin";
      localStorage.setItem("herdr-session-backend", state.sessionBackend);
      state.ws = null;
      state.tab = null;
      state.pane = null;
      mobileTerminal.destroy(true);
      if (eventWs) {
        eventWs.onclose = null;
        try {
          eventWs.close();
        } catch (e) {}
        eventWs = null;
      }
      refresh();
      connectEvents();
    } catch (e) {
      state.sessionsError = e.message || String(e);
    } finally {
      state.sessionBusy = false;
      state.sessionBusyLabel = "";
      render();
      setTimeout(refreshSessions, 400);
    }
  }

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
    if (!workingDismissals || !terminalId) return;
    workingDismissals.clearForTerminal(terminalId);
  }

  function renderPanels() {
    if (!state.ws)
      return '<div class="mobile-loading">Select workspace first</div>';
    const close = state.tab ? `<button class="mobile-btn danger mobile-wide" onclick="HerdrMobile.closeCurrentPanel()">Close current panel</button>` : "";
    const rows = state.tabs.length
      ? state.tabs
          .map(
            (tab) =>
              `<button class="mobile-row${tab.tab_id === state.tab ? " active" : ""}" onclick="HerdrMobile.selectTab(${jsArg(tab.tab_id)})"><strong>${escapeHtml(tabTitle(tab))}${tab.tab_id === state.tab ? " · current" : ""}</strong><span>${escapeHtml((state.panes || []).filter((pane) => pane.tab_id === tab.tab_id).length)} panes · ${escapeHtml(tab.tab_id)}</span></button>`,
          )
          .join("")
      : '<div class="mobile-loading">No panels</div>';
    return `<section class="mobile-section"><h2>Panels</h2><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.createPanel()">New panel</button>${close}${rows}</section>`;
  }

  function renderTerminal() {
    if (!state.terminalId)
      return '<div class="mobile-loading">No terminal selected</div>';
    return `<div class="mobile-terminal-screen"><div class="mobile-tabs" id="mobileTerminalTabs">${renderTerminalTabsWithAdd()}</div><div class="mobile-terminal-shell" id="terminalShell"><button class="mobile-terminal-follow-button" id="mobileTerminalFollowButton" type="button" hidden title="Go to latest terminal output and resume follow" aria-label="Go to latest terminal output and resume follow" onclick="HerdrMobile.scrollTerminalToBottom()">↓ Tail</button><div class="mobile-terminal" id="terminal"></div></div></div>`;
  }

  function currentWorkspaceCwd() {
    const workspace = currentWorkspace();
    return (
      (workspace && workspace.worktree && workspace.worktree.checkout_path) ||
      (workspace && (workspace.cwd || workspace.path)) ||
      state.defaultFolder ||
      ""
    );
  }

  async function loadGitStatus() {
    const cwd = currentWorkspaceCwd();
    resetGitForCwd(cwd);
    if (!cwd) {
      state.gitError = "No checkout path for selected workspace";
      state.gitStatus = null;
      render();
      return;
    }
    try {
      state.gitError = "";
      state.gitStatus = await api(
        "/api/git-ui/status?cwd=" + encodeURIComponent(cwd),
      );
    } catch (error) {
      state.gitError = error.message || String(error);
      state.gitStatus = null;
    }
    render();
  }

  function resetGitForCwd(cwd) {
    if (state.gitCwd === cwd) return;
    state.gitCwd = cwd;
    state.gitStatus = null;
    state.gitError = "";
    state.gitFile = "";
    state.gitKind = "";
    state.gitDiff = null;
    state.gitDiffError = "";
    state.gitBranches = null;
    state.gitBranchesError = "";
    state.gitBusy = "";
    state.gitMutating = false;
  }

  async function selectGitFile(file, kind) {
    state.gitFile = file;
    state.gitKind = kind;
    state.gitDiff = null;
    state.gitDiffError = "";
    render();
    await loadGitDiff();
  }

  function backGitFiles() {
    state.gitFile = "";
    state.gitKind = "";
    state.gitDiff = null;
    state.gitDiffError = "";
    render();
  }

  async function loadGitDiff() {
    const cwd = currentWorkspaceCwd();
    resetGitForCwd(cwd);
    if (!cwd || !state.gitFile) return;
    const scope = state.gitKind === "S" ? "staged" : "working";
    try {
      state.gitDiffError = "";
      state.gitDiff = await api(
        `/api/git-ui/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(state.gitFile)}&scope=${encodeURIComponent(scope)}&context=3`,
      );
    } catch (error) {
      state.gitDiffError = error.message || String(error);
      state.gitDiff = null;
    }
    render();
  }

  async function gitMutate(label, run) {
    if (state.gitMutating) return;
    const cwd = currentWorkspaceCwd();
    if (!cwd) return;
    state.gitMutating = true;
    state.gitBusy = label;
    state.gitError = "";
    render();
    try {
      await run(cwd);
      await loadGitStatus();
    } catch (error) {
      state.gitError = error.message || String(error);
    }
    state.gitMutating = false;
    state.gitBusy = "";
    render();
  }

  async function gitStageFile() {
    if (!state.gitFile) return;
    await gitMutate("Staging", async (cwd) => {
      await api("/api/git-ui/stage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, paths: [state.gitFile] }),
      });
      state.gitKind = "S";
      state.gitDiff = null;
      state.gitDiffError = "";
      await loadGitDiff();
    });
  }

  async function gitUnstageFile() {
    if (!state.gitFile) return;
    await gitMutate("Unstaging", async (cwd) => {
      await api("/api/git-ui/unstage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, paths: [state.gitFile] }),
      });
      state.gitKind = "M";
      state.gitDiff = null;
      state.gitDiffError = "";
      await loadGitDiff();
    });
  }

  async function gitDiscardFile() {
    if (!state.gitFile) return;
    if (!confirm(`Discard all uncommitted changes to ${state.gitFile}? This cannot be undone.`)) return;
    await gitMutate("Discarding", async (cwd) => {
      await api("/api/git-ui/discard", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, paths: [state.gitFile], confirmed: true }),
      });
      backGitFiles();
    });
  }

  async function loadGitBranches() {
    const cwd = currentWorkspaceCwd();
    if (!cwd) return;
    try {
      state.gitBranchesError = "";
      state.gitBranches = await api(
        "/api/git-ui/branches?cwd=" + encodeURIComponent(cwd),
      );
    } catch (error) {
      state.gitBranchesError = error.message || String(error);
      state.gitBranches = null;
    }
    render();
  }

  async function gitSwitchBranch(name) {
    if (!name || state.gitMutating) return;
    if (!confirm(`Switch to branch ${name}?`)) return;
    await gitMutate("Switching branch", async (cwd) => {
      await api("/api/git-ui/switch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd, branch: name }),
      });
      state.gitBranches = null;
      await loadGitStatus();
      await loadGitBranches();
    });
  }

  async function toggleGitBranches() {
    if (state.gitBranches) {
      state.gitBranches = null;
      render();
      return;
    }
    await loadGitBranches();
  }

  function renderGitScreen(screen) {
    resetGitForCwd(currentWorkspaceCwd());
    const status = state.gitStatus;
    if (state.gitError) {
      screen.innerHTML = `<section class="mobile-section"><h2>Git</h2><div class="mobile-error">${escapeHtml(state.gitError)}</div><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.loadGitStatus()">Retry</button></section>`;
      return;
    }
    if (!status) {
      screen.innerHTML = `<section class="mobile-section"><h2>Git</h2><div class="mobile-loading">Loading Git status</div></section>`;
      loadGitStatus();
      return;
    }
    if (state.gitFile) {
      screen.innerHTML = renderGitFileDetail(status);
      if (!state.gitDiff && !state.gitDiffError) loadGitDiff();
      return;
    }
    const rows = [
      ["Conflicts", status.conflicted || [], "U"],
      ["Staged", status.staged || [], "S"],
      ["Unstaged", status.unstaged || [], "M"],
      ["Untracked", status.untracked || [], "?"],
    ]
      .map(
        ([title, files, kind]) =>
          `<h3>${escapeHtml(title)}</h3>${files.length ? files.map((file) => `<button class="mobile-row mobile-git-file" onclick="HerdrMobile.selectGitFile(${jsArg(file)},'${kind}')"><strong>${escapeHtml(pathBasename(file))}</strong><span>${escapeHtml(file)}</span></button>`).join("") : '<div class="mobile-loading">None</div>'}`,
      )
      .join("");
    const busy = state.gitMutating ? `<div class="mobile-loading">${escapeHtml(state.gitBusy || "Working")}…</div>` : "";
    const branchesBlock = state.gitBranches
      ? renderGitBranchList(state.gitBranches)
      : `<button class="mobile-btn mobile-wide" onclick="HerdrMobile.toggleGitBranches()">Branches</button>${state.gitBranchesError ? `<div class="mobile-error">${escapeHtml(state.gitBranchesError)}</div>` : ""}`;
    screen.innerHTML = `<section class="mobile-section mobile-git"><h2>Git</h2><p class="mobile-help">${escapeHtml(status.branch || "detached")} · ${escapeHtml(status.state || "")}</p><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.loadGitStatus()">Refresh</button>${busy}${state.gitError ? `<div class="mobile-error">${escapeHtml(state.gitError)}</div>` : ""}${rows}${branchesBlock}</section>`;
  }

  function renderGitBranchList(branchesData) {
    const local = (branchesData && branchesData.local) || [];
    const remote = (branchesData && branchesData.remote) || [];
    const row = (branch) => `<button class="mobile-row mobile-git-branch${branch.current ? " active" : ""}" ${branch.current ? "disabled" : `onclick="HerdrMobile.gitSwitchBranch(${jsArg(branch.name)})"`}><strong>${escapeHtml(branch.name)}</strong><span>${branch.current ? "current" : branch.remote ? "remote" : branch.upstream ? escapeHtml("upstream " + branch.upstream) : "local"}</span></button>`;
    return `<div class="mobile-git-branches"><button class="mobile-btn mobile-wide" onclick="HerdrMobile.toggleGitBranches()">Hide branches</button><h3>Local</h3>${local.length ? local.map(row).join("") : '<div class="mobile-loading">None</div>'}${remote.length ? `<h3>Remote</h3>${remote.map(row).join("")}` : ""}</div>`;
  }

  function renderGitFileDetail(status) {
    const file = currentGitDiffFile();
    const stats = file ? `+${file.additions || 0} -${file.deletions || 0}` : "No diff loaded";
    const error = state.gitDiffError ? `<div class="mobile-error">${escapeHtml(state.gitDiffError)}</div>` : "";
    const diff = file ? renderGitDiffFile(file) : `<div class="mobile-loading">${state.gitDiffError ? "No diff" : "Loading diff"}</div>`;
    const kind = state.gitKind;
    const canStage = kind === "M" || kind === "?";
    const canUnstage = kind === "S";
    const canDiscard = kind === "M" || kind === "S";
    const actions = `<div class="mobile-git-file-actions">${canStage ? `<button class="mobile-btn" ${state.gitMutating ? "disabled" : ""} onclick="HerdrMobile.gitStageFile()">Stage</button>` : ""}${canUnstage ? `<button class="mobile-btn" ${state.gitMutating ? "disabled" : ""} onclick="HerdrMobile.gitUnstageFile()">Unstage</button>` : ""}${canDiscard ? `<button class="mobile-btn danger" ${state.gitMutating ? "disabled" : ""} onclick="HerdrMobile.gitDiscardFile()">Discard</button>` : ""}</div>`;
    const busy = state.gitMutating ? `<div class="mobile-loading">${escapeHtml(state.gitBusy || "Working")}…</div>` : "";
    return `<section class="mobile-section mobile-git"><div class="mobile-git-file-head"><button class="mobile-btn" onclick="HerdrMobile.backGitFiles()">Files</button><div><strong>${escapeHtml(state.gitFile)}</strong><span>${escapeHtml((status.branch || "detached") + " · " + stats)}</span></div></div>${actions}${busy}${state.gitError ? `<div class="mobile-error">${escapeHtml(state.gitError)}</div>` : ""}${error}${diff}</section>`;
  }

  function currentGitDiffFile() {
    const files = (state.gitDiff && state.gitDiff.files) || [];
    return files.find((file) => file.path === state.gitFile) || files[0] || null;
  }

  function renderGitDiffFile(file) {
    const chunks = file.chunks || [];
    if (!chunks.length) return `<div class="mobile-loading">No diff hunks</div>`;
    return `<div class="mobile-diff">${chunks.map((chunk) => `<article class="mobile-hunk"><header><span>${escapeHtml(chunk.header || "hunk")}</span></header><pre>${(chunk.lines || []).map(renderGitDiffLine).join("\n")}</pre></article>`).join("")}</div>`;
  }

  function renderGitDiffLine(line) {
    const type = line.line_type || "normal";
    const prefix = type === "add" ? "+" : type === "delete" ? "-" : " ";
    return `<span class="${escapeHtml(type)}">${escapeHtml(prefix + (line.content || ""))}</span>`;
  }

  function renderTerminalTabsWithAdd() {
    const close = state.tab ? `<button class="mobile-tab mobile-tab-close" title="Close current panel" onclick="HerdrMobile.closeCurrentPanel()">✕</button>` : "";
    return `${renderTerminalTabs()}<button class="mobile-tab mobile-tab-add" title="New panel" onclick="HerdrMobile.createPanel()">+</button>${close}`;
  }

  function renderTerminalTabs() {
    return state.tabs
      .map(
        (tab) =>
          `<button class="mobile-tab${tab.tab_id === state.tab ? " active" : ""}" onclick="HerdrMobile.selectTab(${jsArg(tab.tab_id)})">${escapeHtml(tabTitle(tab))}</button>`,
      )
      .join("");
  }

  function renderTerminalScreen(screen) {
    if (!state.terminalId) {
      mobileTerminal.destroy(true);
      screen.innerHTML = renderTerminal();
      return;
    }
    if (!el("terminal")) {
      screen.innerHTML = renderTerminal();
      return;
    }
    const tabs = el("mobileTerminalTabs");
    if (tabs) tabs.innerHTML = renderTerminalTabsWithAdd();
  }

  async function refresh() {
    const seq = ++refreshSeq;
    state.error = "";
    parseRoute(false);
    const routeWs = state.ws,
      routeTab = state.tab,
      routePane = state.pane;
    try {
      const workspaces = await api("/api/workspaces");
      if (seq !== refreshSeq) return;
      state.workspaces = workspaces.result.workspaces || [];
      if (state.ws && !state.workspaces.some((workspace) => workspace.workspace_id === state.ws)) {
        state.ws = null;
        state.tab = null;
        state.pane = null;
      }
      if (!state.ws && state.workspaces[0])
        state.ws = state.workspaces[0].workspace_id;
      if (state.ws) {
        const [allTabs, tabs, panes, agents, worktrees] = await Promise.all([
          api("/api/tabs"),
          api("/api/tabs?workspace_id=" + encodeURIComponent(state.ws)),
          api("/api/panes?workspace_id=" + encodeURIComponent(state.ws)),
          api("/api/agents"),
          api(
            "/api/worktrees?workspace_id=" + encodeURIComponent(state.ws),
          ).catch(() => null),
        ]);
        if (seq !== refreshSeq) return;
        state.allTabs = allTabs.result.tabs || [];
        state.tabs = tabs.result.tabs || [];
        state.panes = panes.result.panes || [];
        state.agents = agents.result.agents || [];
        browserFaviconError = false;
        mobileAttention.handleSound();
        mobileWorktrees.applyResult(worktrees);
        if (!state.tabs.some((tab) => tab.tab_id === state.tab)) {
          const focused = state.tabs.find((tab) => tab.focused);
          state.tab = (focused || state.tabs[0] || {}).tab_id || null;
        }
        if (!state.panes.some((pane) => pane.pane_id === state.pane)) {
          const pane =
            state.panes.find((item) => item.tab_id === state.tab && item.focused) ||
            state.panes.find((item) => item.tab_id === state.tab) ||
            state.panes[0];
          state.pane = pane && pane.pane_id;
        }
        const pane = currentPane();
        state.terminalId = pane && pane.terminal_id;
        if (
          routeWs &&
          (routeWs !== state.ws || routeTab !== state.tab || routePane !== state.pane)
        ) {
          mobileTerminal.destroy(true);
        }
        if (state.ws && state.tab && state.pane)
          history.replaceState(
            null,
            "",
            selectionPath(state.ws, state.tab, state.pane),
          );
      }
      render();
      if (state.screen === "terminal") mobileTerminal.connect();
    } catch (error) {
      browserFaviconError = true;
      state.error = error.message || String(error);
      render();
    }
  }

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
    mobileFileBrowser.reset();
    history.pushState(null, "", selectionPath(id));
    mobileTerminal.destroy(true);
    refresh();
  }

  function selectAgent(ws, tab, pane) {
    state.ws = ws;
    state.tab = tab;
    state.pane = pane;
    state.screen = "terminal";
    history.pushState(null, "", selectionPath(ws, tab, pane));
    mobileTerminal.destroy(true);
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
    mobileTerminal.destroy(true);
    render();
    mobileTerminal.connect();
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
        mobileTerminal.destroy(true);
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
    if (!confirm(`Close panel "${label}"?`)) return;
    try {
      const workspaceTabs = state.tabs.filter((item) => item.workspace_id === state.ws);
      if (workspaceTabs.length > 1) {
        await api(`/api/tabs/${encodeURIComponent(state.tab)}/close`, { method: "POST" });
      } else if (state.ws) {
        await api(`/api/workspaces/${encodeURIComponent(state.ws)}/close`, { method: "POST" });
      }
      state.tab = null;
      state.pane = null;
      mobileTerminal.destroy(true);
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
      mobileSearch.open();
      return;
    }
    if (action === "open-workspace" || action === "discover-worktrees") {
      showScreen("worktrees");
      if (action === "discover-worktrees") mobileWorktrees.load();
      else mobileWorktrees.loadRecent();
      return;
    }
    if (action === "create-worktree") {
      state.worktreeCreateExpanded = true;
      showScreen("worktrees");
      return;
    }
    if (action === "temp-terminal") {
      if (mobileTempTerminal) mobileTempTerminal.open(currentWorkspaceCwd());
      return;
    }
    if (action === "sessions") {
      showScreen("sessions");
      return;
    }
    if (["terminal", "files", "git", "settings"].includes(action)) showScreen(action);
  }

  function scheduleEventRefresh() {
    if (eventRefreshTimer || document.hidden) return;
    eventRefreshTimer = setTimeout(() => {
      eventRefreshTimer = null;
      if (document.hidden) return;
      return refresh();
    }, 120);
  }

  function scheduleEventReconnect() {
    if (eventReconnectTimer || document.hidden) return;
    eventReconnectTimer = setTimeout(() => {
      eventReconnectTimer = null;
      if (document.hidden) return;
      connectEvents();
    }, 1500);
  }

  function connectEvents() {
    if (eventWs || !globalThis.WebSocket || document.hidden) return;
    const ws = new WebSocket(wsUrl("/ws/events"));
    eventWs = ws;
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg && msg.type === "server_settings_changed") {
          handleServerSettingsChanged(msg);
        }
        const evt = msg && msg.event;
        const kind = evt && (evt.event || evt.type);
        const data = (evt && evt.data) || {};
        if (kind === "pane.exited" && mobileTempTerminal && mobileTempTerminal.handlePaneExited)
          mobileTempTerminal.handlePaneExited(data.pane_id);
      } catch (_) {}
      scheduleEventRefresh();
    };
    ws.onclose = () => {
      if (eventWs === ws) eventWs = null;
      scheduleEventReconnect();
    };
  }

  function applyTheme() {
    const mode = localStorage.getItem("herdr-web-theme") || "auto";
    const light =
      mode === "light" ||
      (mode === "auto" &&
        window.matchMedia &&
        !window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.body.classList.toggle("light", light);
    document.documentElement.dataset.herdrTheme = light ? "light" : "dark";
  }
  if (window.matchMedia) {
    try {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const onSystemThemeChange = () => {
        if ((localStorage.getItem("herdr-web-theme") || "auto") === "auto")
          applyTheme();
      };
      if (media.addEventListener) media.addEventListener("change", onSystemThemeChange);
      else if (media.addListener) media.addListener(onSystemThemeChange);
    } catch (error) {}
  }

  mobileAttention = globalThis.HerdrMobileAttention.create({
    localStorage,
    state,
    window,
  });
  const workingDismissals = globalThis.HerdrAttention && globalThis.HerdrAttention.createDismissals
    ? globalThis.HerdrAttention.createDismissals({
        getOptions: () => {
          try {
            return globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
          } catch (_) {
            return {};
          }
        },
        localStorage,
        onRender: null,
      })
    : null;
  mobileTerminal = globalThis.HerdrMobileTerminal.create({ el, state, wsUrl, onHerdrError: handleHerdrErrorFrame, onTerminalOutput: clearDismissedWorkingForTerminal });
  mobileTempTerminal = globalThis.HerdrTempTerminal.create({
    el,
    state,
    wsUrl,
    api,
    modalId: "tempTerminalModal",
    onHerdrError: handleHerdrErrorFrame,
    fontFamilyFn: () => {
      try {
        const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
        return globalThis.HerdrAppHelpers.resolveTerminalFontFamily(parsed.terminalFontFamily);
      } catch (_) {
        return globalThis.HerdrAppHelpers.resolveTerminalFontFamily("");
      }
    },
    themeFn: () => {
      const light = document.body.classList.contains("light");
      const colors = (globalThis.HerdrAppHelpers && globalThis.HerdrAppHelpers.terminalThemeColors) || {};
      const theme = light ? (colors.light || {}) : (colors.dark || {});
      return {
        background: theme.background || (light ? "#ffffff" : "#1e1e2e"),
        foreground: theme.foreground || (light ? "#4c4f69" : "#cdd6f4"),
        cursor: theme.cursor || (light ? "#4c4f69" : "#cdd6f4"),
        selectionBackground: theme.selectionBackground || (light ? "#dce0f8" : "#45475a"),
      };
    },
    defaultFolderFn: () => state.defaultFolder || "",
    workspaceIdFn: () => state.ws || (state.workspaces && state.workspaces.length === 1 ? state.workspaces[0].workspace_id : "") || "",
  });
  window.addEventListener("resize", () => mobileTempTerminal.handleResize());
  mobileSettings = globalThis.HerdrMobileSettings.create({
    api,
    applyTheme,
    escapeHtml,
    localStorage,
    state,
  });
  mobileWorktrees = globalThis.HerdrMobileWorktrees.create({
    api,
    defaultFolderFn: () => state.defaultFolder || "",
    destroyTerminal: mobileTerminal.destroy,
    escapeHtml,
    jsArg,
    refresh,
    render,
    selectionPath,
    state,
  });
  mobileFileBrowser = globalThis.HerdrMobileFileBrowser.create({
    api,
    confirm: (...args) => confirm(...args),
    currentWorkspaceCwd,
    escapeHtml,
    render,
    state,
  });

  mobileSearch = globalThis.HerdrMobileSearchModule.create({
    el,
    state,
    escapeHtml,
    currentWorkspace,
    currentWorkspaceCwd,
    workspaceTitle,
    workspaceMeta,
    worktreeForWorkspace,
    tabTitle,
    selectWorkspace,
    selectAgent,
    showScreen,
    openAt: (...args) => mobileFileBrowser.openAt(...args),
    runAction: runMobileAction,
    searchDisabledFn: headerSearchDisabled,
  });

  globalThis.HerdrMobile = {
    selectWorkspace,
    selectAgent,
    selectTab,
    createPanel,
    closeCurrentPanel,
    dismissWorkingAgent,
    restoreWorkingAgent,
    loadGitStatus,
    selectGitFile,
    backGitFiles,
    gitStageFile,
    gitUnstageFile,
    gitDiscardFile,
    toggleGitBranches,
    gitSwitchBranch,
    filesToggle: mobileFileBrowser.toggle,
    filesSelect: mobileFileBrowser.select,
    filesOpenAt: mobileFileBrowser.openAt,
    filesUp: mobileFileBrowser.up,
    filesRefresh: mobileFileBrowser.refresh,
    filesBackToTree: mobileFileBrowser.backToTree,
    filesRefreshFile: mobileFileBrowser.refreshFile,
    filesStartEdit: mobileFileBrowser.startEdit,
    filesCancelEdit: mobileFileBrowser.cancelEdit,
    filesSaveFile: mobileFileBrowser.saveFile,
    filesRowActions: mobileFileBrowser.rowActions,
    filesOpenActionSheet: mobileFileBrowser.rowActions,
    filesCloseActionSheet: mobileFileBrowser.closeActionSheet,
    filesOpenRename: mobileFileBrowser.openRename,
    filesSetRenameValue: mobileFileBrowser.setRenameValue,
    filesCancelRename: mobileFileBrowser.cancelRename,
    filesSubmitRename: mobileFileBrowser.submitRename,
    filesDeletePath: mobileFileBrowser.deletePath,
    filesOpenNewFile: mobileFileBrowser.openNewFile,
    filesSetNewFileValue: mobileFileBrowser.setNewFileValue,
    filesCancelNewFile: mobileFileBrowser.cancelNewFile,
    filesSubmitNewFile: mobileFileBrowser.submitNewFile,
    filesFilter: mobileFileBrowser.filter,
    filesClearFilter: mobileFileBrowser.clearFilter,
    filesSearchKeydown: mobileFileBrowser.searchKeydown,
    filesShowSearch: mobileFileBrowser.showSearch,
    filesCloseContentSearch: mobileFileBrowser.closeContentSearch,
    filesLoadPartial: mobileFileBrowser.loadPartial,
    filesFocusTree: mobileFileBrowser.focusTree,
    filesBlurTree: mobileFileBrowser.blurTree,
    filesToggleContentSearch: mobileFileBrowser.toggleContentSearch,
    filesToggleFilterKind: mobileFileBrowser.toggleFilterKind,
    filesLoadMore: mobileFileBrowser.loadMore,
    filesScroll: mobileFileBrowser.scroll,
    filesTypeToFilter: mobileFileBrowser.typeToFilter,
    loadWorktrees: mobileWorktrees.load,
    openWorktree: mobileWorktrees.open,
    createWorktree: mobileWorktrees.create,
    loadRecentWorkspaces: mobileWorktrees.loadRecent,
    openRecentWorkspace: mobileWorktrees.openRecent,
    removeRecentWorkspace: mobileWorktrees.removeRecent,
    clearRecentWorkspaces: mobileWorktrees.clearRecent,
    setWorktreeCreateExpanded: mobileWorktrees.setCreateExpanded,
    updateWorktreeField: mobileWorktrees.updateField,
    setThemeMode: mobileSettings.setThemeMode,
    rollbackSetting: mobileSettings.rollbackSetting,
    resetSettingBaselines: mobileSettings.resetSettingBaselines,
    setBrowserNotifications: mobileSettings.setBrowserNotifications,
    setSoundScope: mobileSettings.setSoundScope,
    setAgentSortMode: mobileSettings.setAgentSortMode,
    setStuckWorkingEnabled: mobileSettings.setStuckWorkingEnabled,
    setWorkingDismissMinutes: mobileSettings.setWorkingDismissMinutes,
    setNoSleepMode: mobileSettings.setNoSleepMode,
    loadNoSleepState: mobileSettings.loadNoSleep,
    setEditorEnabled: mobileSettings.setEditorEnabled,
    setEditorWordWrap: mobileSettings.setEditorWordWrap,
    setEditorTabSize: mobileSettings.setEditorTabSize,
    setLspEnabled: mobileSettings.setLspEnabled,
    setExplorationDefaultDirectory: mobileSettings.setExplorationDefaultDirectory,
    setFileBrowserDepth: mobileSettings.setFileBrowserDepth,
    setFileBrowserLineNumbers: mobileSettings.setFileBrowserLineNumbers,
    setFileBrowserPathSearch: mobileSettings.setFileBrowserPathSearch,
    setFileBrowserSearchPageSize: mobileSettings.setFileBrowserSearchPageSize,
    setHeaderSearchEnabled: mobileSettings.setHeaderSearchEnabled,
    setSearchWorkspacesEnabled: mobileSettings.setSearchWorkspacesEnabled,
    setSearchFilesEnabled: mobileSettings.setSearchFilesEnabled,
    setSearchFoldersEnabled: mobileSettings.setSearchFoldersEnabled,
    setSearchContentEnabled: mobileSettings.setSearchContentEnabled,
    setSearchSectionOrder: mobileSettings.setSearchSectionOrder,
    setSettingsFilter: mobileSettings.setSettingsFilter,
    moveSearchSection: mobileSettings.moveSearchSection,
    setFileContentSearchMinChars: mobileSettings.setFileContentSearchMinChars,
    setFileContentSearchPageSize: mobileSettings.setFileContentSearchPageSize,
    setFileContentSearchAutoCollapseFiles: mobileSettings.setFileContentSearchAutoCollapseFiles,
    setFileContentSearchContextLines: mobileSettings.setFileContentSearchContextLines,
    setFileContentSearchMatchesPerFile: mobileSettings.setFileContentSearchMatchesPerFile,
    setLayoutPreference: mobileSettings.setLayoutPreference,
    setNotificationVolume: mobileSettings.setNotificationVolume,
    setTerminalFontFamily: mobileSettings.setTerminalFontFamily,
    setTerminalLinks: mobileSettings.setTerminalLinks,
    setTerminalMouseReporting: mobileSettings.setTerminalMouseReporting,
    setWorktreeDefaultDirectory: mobileSettings.setWorktreeDefaultDirectory,
    applyTerminalFontFamily: mobileTerminal.applyFontFamily,
    applyTerminalLinks: mobileTerminal.applyLinks,
    reloadTerminal() { mobileTerminal.destroy(false); scheduleTerminalResize(); },
    scrollTerminalToBottom: mobileTerminal.scrollToBottom,
    currentScreen,
    currentSelection,
    refresh,
    runAction: runMobileAction,
    showScreen,
    refreshSessions,
    updateSessionField,
    setSessionCreateExpanded,
    newSession,
    selectSession,
    closeSession,
  };

  globalThis.HerdrMobileFiles = {
    toggle: mobileFileBrowser.toggle,
    select: mobileFileBrowser.select,
    up: mobileFileBrowser.up,
    rowActions: mobileFileBrowser.rowActions,
  };

  renderShell();
  updateMobileViewport();
  applyTheme();
  parseRoute(true);
  render();
  loadServerSettings().then(render);
  refresh();
  connectEvents();
  window.addEventListener("popstate", () => {
    parseRoute(true);
    refresh();
  });
  window.addEventListener("resize", scheduleTerminalResize);
  if (window.visualViewport)
    window.visualViewport.addEventListener("resize", scheduleTerminalResize);
  document.addEventListener("visibilitychange", () => {
    syncBrowserFavicon();
    if (!document.hidden) {
      scheduleEventRefresh();
      scheduleEventReconnect();
    }
  });
  document.addEventListener("pointerdown", mobileAttention.unlockAudio, {
    once: true,
  });
  document.addEventListener("keydown", mobileAttention.unlockAudio, {
    once: true,
  });
})();
