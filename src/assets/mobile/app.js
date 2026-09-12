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

  let refreshSeq = 0,
    browserFavicon = createFaviconNotifier(document),
    browserFaviconError = false,
    mobileAttention,
    mobileSettings,
    mobileTerminal,
    mobileTempTerminal,
    mobileFileBrowser,
    mobileWorktrees,
    mobileSearch,
    mobileGit,
    mobileEvents,
    mobileSessions,
    mobileScreens,
    mobilePanels,
    mobileWorkmeta,
    mobileTheme;

  function el(id) {
    return document.getElementById(id);
  }

  function updateMobileViewport() {
    mobileTheme.updateMobileViewport();
  }

  function scheduleTerminalResize() {
    mobileTheme.scheduleTerminalResize();
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
    if (mobileEvents) {
      mobileEvents.closeEventWs();
      mobileEvents.scheduleEventReconnect();
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
    return mobileWorkmeta.currentWorkspace();
  }

  function currentTab() {
    return mobileWorkmeta.currentTab();
  }

  function currentPane() {
    return mobileWorkmeta.currentPane();
  }

  function workspacesById() {
    return mobileWorkmeta.workspacesById();
  }

  function tabsById() {
    return mobileWorkmeta.tabsById();
  }

  function tabCountsByWorkspace() {
    return mobileWorkmeta.tabCountsByWorkspace();
  }

  function tabTitle(tab) {
    return mobileWorkmeta.tabTitle(tab);
  }

  function agentTabLabel(wsId, tab, counts) {
    return mobileWorkmeta.agentTabLabel(wsId, tab, counts);
  }

  function worktreeForWorkspace(workspace) {
    return mobileWorkmeta.worktreeForWorkspace(workspace);
  }

  function workspaceTitle(workspace) {
    return mobileWorkmeta.workspaceTitle(workspace);
  }

  function worktreeDisplayName(workspace) {
    return mobileWorkmeta.worktreeDisplayName(workspace);
  }

  function parentWorkspaceName(workspace, byId) {
    return mobileWorkmeta.parentWorkspaceName(workspace, byId);
  }

  function workspaceMeta(workspace) {
    return mobileWorkmeta.workspaceMeta(workspace);
  }

  function contextMeta(workspace) {
    return mobileWorkmeta.contextMeta(workspace);
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
    if (screen === "sessions" && !state.sessionBusy) mobileSessions.refreshSessions();
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
      button.classList.toggle("active", mobileScreens.mobileNavActive(button.dataset.screen));
      button.innerHTML = mobileScreens.mobileNavLabel(button.dataset.screen);
    });
    const screen = el("mobileScreen");
    screen.classList.toggle("terminal-active", state.screen === "terminal");
    if (state.error) {
      syncBrowserFavicon();
      screen.innerHTML = `<div class="mobile-error">${escapeHtml(state.error)}</div>`;
      return;
    }
    if (state.screen === "agents") screen.innerHTML = mobileScreens.renderAgents();
    else if (state.screen === "panels") screen.innerHTML = renderPanels();
    else if (state.screen === "worktrees")
      screen.innerHTML = mobileWorktrees.renderScreen();
    else if (state.screen === "files")
      screen.innerHTML = mobileFileBrowser.renderScreen();
    else if (state.screen === "git") mobileGit.renderGitScreen(screen);
    else if (state.screen === "settings")
      screen.innerHTML = mobileSettings.render();
    else if (state.screen === "sessions")
      screen.innerHTML = mobileSessions.renderSessions();
    else if (state.screen === "terminal") renderTerminalScreen(screen);
    else if (state.screen === "more") screen.innerHTML = mobileScreens.renderMore();
    else screen.innerHTML = mobileScreens.renderHome();
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
    mobileTheme.applyTreeIndent();
  }

  function syncBrowserFavicon() {
    mobileTheme.syncBrowserFavicon();
  }













  function renderPanels() {
    return mobilePanels.renderPanels();
  }

  function renderTerminal() {
    return mobilePanels.renderTerminal();
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

  function renderTerminalTabsWithAdd() {
    return mobilePanels.renderTerminalTabsWithAdd();
  }

  function renderTerminalTabs() {
    return mobilePanels.renderTerminalTabs();
  }

  function renderTerminalScreen(screen) {
    mobilePanels.renderTerminalScreen(screen);
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

  function applyTheme() {
    mobileTheme.applyTheme();
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
  mobileWorkmeta = globalThis.HerdrMobileWorkmetaModule.create({
    state,
    samePath,
    pathBasename,
  });
  mobileTheme = globalThis.HerdrMobileThemeModule.create({
    state,
    documentRef: document,
    windowRef: window,
    localStorage,
    getMobileAttention: () => mobileAttention,
    getMobileTerminal: () => mobileTerminal,
    browserFavicon,
    getBrowserFaviconError: () => browserFaviconError,
    applyThemeToBody: null,
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
  mobileTerminal = globalThis.HerdrMobileTerminal.create({ el, state, wsUrl, onHerdrError: handleHerdrErrorFrame, onTerminalOutput: (...args) => mobileScreens.clearDismissedWorkingForTerminal(...args) });
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

  mobileGit = globalThis.HerdrMobileGitModule.create({
    state,
    api,
    render,
    escapeHtml,
    jsArg,
    pathBasename,
    currentWorkspaceCwd,
    confirmFn: (...args) => confirm(...args),
  });

  mobileEvents = globalThis.HerdrMobileEventsModule.create({
    document,
    globalThisWebSocket: globalThis.WebSocket,
    wsUrl,
    refresh,
    handleServerSettingsChanged,
    getTempTerminal: () => mobileTempTerminal,
  });

  mobileSessions = globalThis.HerdrMobileSessionsModule.create({
    state,
    api,
    render,
    escapeHtml,
    jsArg,
    localStorage,
    confirmFn: (...args) => confirm(...args),
    loadSessions,
    refresh,
    connectEvents: (...args) => mobileEvents.connectEvents(...args),
    destroyTerminal: (...args) => mobileTerminal.destroy(...args),
    sessionPrefix,
    pushState: (...args) => history.pushState(...args),
    syncBackendBadge,
    closeEventWs: (...args) => mobileEvents.closeEventWs(...args),
    currentSessionBackend,
    backendEnabled,
    sessionBackendLabel,
    sessionBackendClass,
  });

  mobilePanels = globalThis.HerdrMobilePanelsModule.create({
    state,
    el,
    escapeHtml,
    jsArg,
    tabTitle,
    getMobileTerminal: () => mobileTerminal,
    getBrowserFaviconError: () => browserFaviconError,
    setBrowserFaviconError: (value) => {
      browserFaviconError = value;
    },
  });

  mobileScreens = globalThis.HerdrMobileScreensModule.create({
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
    getWorkingDismissals: () => workingDismissals,
    workspacesById,
    tabsById,
    tabCountsByWorkspace,
    parentWorkspaceName,
    worktreeDisplayName,
    agentTabLabel,
  });

  globalThis.HerdrMobile = {
    selectWorkspace,
    selectAgent,
    selectTab,
    createPanel,
    closeCurrentPanel,
    dismissWorkingAgent: (...args) => mobileScreens.dismissWorkingAgent(...args),
    restoreWorkingAgent: (...args) => mobileScreens.restoreWorkingAgent(...args),
    loadGitStatus: (...args) => mobileGit.loadGitStatus(...args),
    selectGitFile: (...args) => mobileGit.selectGitFile(...args),
    backGitFiles: (...args) => mobileGit.backGitFiles(...args),
    gitStageFile: (...args) => mobileGit.gitStageFile(...args),
    gitUnstageFile: (...args) => mobileGit.gitUnstageFile(...args),
    gitDiscardFile: (...args) => mobileGit.gitDiscardFile(...args),
    toggleGitBranches: (...args) => mobileGit.toggleGitBranches(...args),
    gitSwitchBranch: (...args) => mobileGit.gitSwitchBranch(...args),
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
    refreshSessions: (...args) => mobileSessions.refreshSessions(...args),
    updateSessionField: (...args) => mobileSessions.updateSessionField(...args),
    setSessionCreateExpanded: (...args) => mobileSessions.setSessionCreateExpanded(...args),
    newSession: (...args) => mobileSessions.newSession(...args),
    selectSession: (...args) => mobileSessions.selectSession(...args),
    closeSession: (...args) => mobileSessions.closeSession(...args),
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
  mobileEvents.connectEvents();
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
      mobileEvents.scheduleEventRefresh();
      mobileEvents.scheduleEventReconnect();
    }
  });
  document.addEventListener("pointerdown", mobileAttention.unlockAudio, {
    once: true,
  });
  document.addEventListener("keydown", mobileAttention.unlockAudio, {
    once: true,
  });
})();
