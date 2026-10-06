(function () {
  const {
    escapeHtml,
    createTerminalInputGate,
    forgetSessionState,
    inputAttrs,
    jsArg,
    parseRoutePath,
    pathBasename,
    readSessionBackend,
    readSessionSelection,
    samePath,
    sameScopedId,
    saveSessionSelection,
    selectionPath: mobileSelectionPath,
    sessionPrefix,
    writeSessionBackend,
  } = globalThis.HerdrMobileCore;
  const { createFaviconNotifier } = globalThis.HerdrAppHelpers;
  const MORE_SCREENS = ["agents", "panels", "worktrees", "files", "git", "settings", "sessions"];

  const state = {
    session: "default",
    backendMode: "",
    // Built-in sessions are the default; /api/server-settings confirms the
    // server's configured backend mode on first load.
    // Per-session pin (see sessionBackendKey in mobile/core.js); the boot
    // path calls parseRoute() before this matters, so read the pin for the
    // default session here and let every switch path re-read for its own.
    sessionBackend: readSessionBackend("default"),
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
    terminalConnecting: false,
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
    // True until the first refresh() succeeds; screens that wait on
    // connectivity render skeleton placeholders instead of empty rows
    // (see shared/skeleton.js).
    booting: true,
  };

  let refreshSeq = 0,
    browserFavicon = createFaviconNotifier(document),
    browserFaviconError = false,
    // Cached .mobile-nav button list; null means re-query on next render.
    navButtons = null,
    // One-shot Ctrl state for the terminal key bar. Cleared whenever the
    // terminal screen re-renders the bar (markup resets aria-pressed), and
    // after every key send.
    keyBarCtrlArmed = false,
    mobileAttention,
    mobileSettings,
    mobileTerminal,
    mobileTempTerminal,
    mobileFileBrowser,
    mobileWorktrees,
    mobileSearch,
    mobileGit,
    mobileComposer,
    mobileEvents,
    mobileSessions,
    mobileScreens,
    mobilePanels,
    mobileWorkmeta,
    mobileTheme,
    mobileActions,
    mobileBackend;

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
    await mobileBackend.loadServerSettings();
  }

  async function loadSessions() {
    await mobileBackend.loadSessions();
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
  function handleHerdrErrorFrame(raw) {
    return mobileBackend.handleHerdrErrorFrame(raw);
  }

  function currentSessionBackend() {
    return mobileBackend.currentSessionBackend();
  }
  // True when the server settings allow the given backend. Unknown (null,
  // from an older server that omits enabled_backends) never disables anything.
  function backendEnabled(backend) {
    return mobileBackend.backendEnabled(backend);
  }
  // Re-validate the pinned backend against the server's enabled backends:
  // a tab that pinned a backend before it was disabled mid-session must
  // retarget instead of silently rerouting every request. Prefer the
  // server's default backend (from /api/versions or the settings-change
  // broadcast) when still enabled, then built-in, then whichever remains
  // enabled (the server enforces at least one enabled backend).
  function syncSessionBackendFromServer() {
    mobileBackend.syncSessionBackendFromServer();
  }
  function sessionBackendLabel(backend) {
    return mobileBackend.sessionBackendLabel(backend);
  }
  function sessionBackendClass(backend) {
    return mobileBackend.sessionBackendClass(backend);
  }

  function handleServerSettingsChanged(msg) {
    mobileBackend.handleServerSettingsChanged(msg);
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

  // Styled in-app confirm sheet. Replaces raw window.confirm in the mobile
  // bundle (the desktop parity gap): one promise-based surface, mounted in
  // the shell so screen re-renders never destroy it.
  const confirmQueue = [];
  let pendingConfirmResolve = null;

  function mobileConfirm(message) {
    return new Promise((resolve) => {
      // Shell may not exist yet (module init before first renderShell).
      const sheet = el("mobileConfirmSheet");
      const backdrop = el("mobileConfirmBackdrop");
      if (!sheet || !backdrop) {
        resolve(window.confirm(message));
        return;
      }
      confirmQueue.push({ message: String(message || ""), resolve });
      if (!pendingConfirmResolve) showNextConfirm();
    });
  }

  function showNextConfirm() {
    const next = confirmQueue.shift();
    if (!next) return;
    const sheet = el("mobileConfirmSheet");
    const backdrop = el("mobileConfirmBackdrop");
    if (!sheet || !backdrop) {
      next.resolve(window.confirm(next.message));
      showNextConfirm();
      return;
    }
    pendingConfirmResolve = next.resolve;
    const message = sheet.querySelector("#mobileConfirmMessage");
    if (message) message.textContent = next.message;
    sheet.hidden = false;
    backdrop.hidden = false;
  }

  function resolveConfirm(value) {
    const sheet = el("mobileConfirmSheet");
    const backdrop = el("mobileConfirmBackdrop");
    if (sheet) sheet.hidden = true;
    if (backdrop) backdrop.hidden = true;
    const resolve = pendingConfirmResolve;
    pendingConfirmResolve = null;
    if (resolve) resolve(!!value);
    showNextConfirm();
  }

  function renderShell() {
    // Shell rebuild recreates the nav bar, so the cached button list from a
    // previous shell is stale.
    navButtons = null;
    document.body.innerHTML = `
      <div id="mobileApp" class="mobile-app">
        <header class="mobile-header">
          <button class="mobile-btn" id="mobileBack" title="Home" aria-label="Back to home">←</button>
          <div class="mobile-context"><strong id="mobileTitle">Herdr</strong><span class="mobile-context-meta" role="status" aria-live="polite"><span id="mobileMeta">Loading</span><span class="mobile-connection-dot" id="mobileConnectionDot" data-state="connecting" title="Connecting: events stream retrying" aria-hidden="true"></span><button type="button" id="mobileBackendBadge" class="mobile-backend-badge backend-builtin" title="Sessions" aria-label="Sessions">built-in</button></span></div>
          <button class="mobile-btn" id="mobileSearch" title="Search" aria-label="Search">⌕</button>
        </header>
        <main class="mobile-screen" id="mobileScreen"></main>
        <div class="mobile-search-sheet" id="mobileSearchSheet" hidden>
          <div class="mobile-search-card">
            <div class="mobile-search-head"><input id="mobileSearchInput"${inputAttrs("search")} placeholder="Search workspaces, files, folders, content" /><button class="mobile-btn" id="mobileSearchClose">✕</button></div>
            <div class="mobile-search-results" id="mobileSearchResults"></div>
            <div class="mobile-help">Enter opens · Alt+F files · Alt+D folders · Esc closes</div>
          </div>
        </div>
        <nav class="mobile-nav">
          <button data-screen="home">Home</button>
          <button data-screen="search">Search</button>
          <button data-screen="terminal">Terminal</button>
          <button data-screen="more" aria-haspopup="dialog">More</button>
        </nav>
        <div class="mobile-drawer-backdrop" id="mobileDrawerBackdrop" hidden onclick="HerdrMobile.closeDrawer()"></div>
        <aside class="mobile-drawer" id="mobileDrawer" hidden role="dialog" aria-modal="true" aria-label="Tools menu"><div class="mobile-drawer-items" id="mobileDrawerItems"></div></aside>
        <div class="mobile-sheet-backdrop" id="mobileConfirmBackdrop" hidden onclick="HerdrMobile.resolveConfirm(false)"></div>
        <div class="mobile-sheet mobile-confirm-sheet" id="mobileConfirmSheet" hidden role="alertdialog" aria-modal="true" aria-label="Confirm"><div class="mobile-sheet-handle"></div><div class="mobile-sheet-title" id="mobileConfirmMessage"></div><div class="mobile-sheet-actions"><button class="mobile-btn" id="mobileConfirmCancel" onclick="HerdrMobile.resolveConfirm(false)">Cancel</button><button class="mobile-btn primary" id="mobileConfirmOk" onclick="HerdrMobile.resolveConfirm(true)">Confirm</button></div></div>
      </div>
      </div>`;
    el("mobileBack").onclick = () => showScreen("home");
    el("mobileSearch").onclick = () => mobileSearch && mobileSearch.open();
    document.querySelectorAll(".mobile-nav button").forEach((button) => {
      button.onclick = () => {
        if (button.dataset.screen === "more") {
          openDrawer();
          return;
        }
        showScreen(button.dataset.screen);
      };
    });
    el("mobileDrawerBackdrop").onclick = () => closeDrawer();
    bindDrawerEdgeSwipe();
  }

  function drawerItemsEl() {
    return el("mobileDrawerItems");
  }

  function openDrawer() {
    const drawer = el("mobileDrawer");
    const backdrop = el("mobileDrawerBackdrop");
    if (!drawer || !backdrop) return;
    drawerItemsEl().innerHTML = mobileScreens.renderDrawerItems();
    drawer.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add("mobile-drawer-open");
  }

  function closeDrawer() {
    const drawer = el("mobileDrawer");
    const backdrop = el("mobileDrawerBackdrop");
    if (drawer) drawer.hidden = true;
    if (backdrop) backdrop.hidden = true;
    document.body.classList.remove("mobile-drawer-open");
  }

  function openDrawerTarget(screen) {
    closeDrawer();
    showScreen(screen);
  }

  function bindDrawerEdgeSwipe() {
    // Edge swipe: 24px open travel from the left edge opens the drawer,
    // 56px close travel from anywhere closes it. Passive tracking; the
    // actual open/close only happens on touchend so drags on interactive
    // content never trigger navigation mid-gesture.
    if (typeof document.addEventListener !== "function") return;
    let startX = null, startY = null, tracking = false;
    document.addEventListener("touchstart", (event) => {
      const touch = event.touches && event.touches[0];
      if (!touch) return;
      startX = touch.clientX;
      startY = touch.clientY;
      tracking = true;
    }, { passive: true });
    document.addEventListener("touchend", (event) => {
      if (!tracking) return;
      tracking = false;
      const touch = event.changedTouches && event.changedTouches[0];
      if (!touch || startX === null || startY === null) return;
      const dx = touch.clientX - startX;
      const dy = Math.abs(touch.clientY - startY);
      startX = startY = null;
      if (dy > 48) return;
      const drawerOpen = el("mobileDrawer") && !el("mobileDrawer").hidden;
      if (!drawerOpen && startX <= 24 && dx >= 24) openDrawer();
      else if (drawerOpen && dx <= -56) closeDrawer();
    }, { passive: true });
  }

  function showScreen(screen) {
    if (screen === "search") {
      mobileSearch.open();
      return;
    }
    const wasTerminal = state.screen === "terminal";
    const wasSettings = state.screen === "settings";
    state.screen = screen;
    if (wasTerminal && screen !== "terminal") {
      mobileTerminal.destroy(false);
      keyBarCtrlArmed = false;
    }
    if (!wasSettings && screen === "settings" && mobileSettings.resetSettingBaselines)
      mobileSettings.resetSettingBaselines();
    if (screen === "settings" && mobileSettings.loadNoSleep) mobileSettings.loadNoSleep();
    if (screen === "sessions" && !state.sessionBusy) mobileSessions.refreshSessions();
    if (screen === "worktrees" && mobileWorktrees.loadRecent) mobileWorktrees.loadRecent();
    if (screen === "terminal") state.terminalConnecting = true;
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
    // Cache the nav button list once: querySelectorAll ran on every render,
    // and each render is triggered by every events-WS refresh.
    if (!navButtons) {
      navButtons = Array.from(
        document.querySelectorAll(".mobile-nav button"),
      );
    }
    for (const button of navButtons) {
      const searchNavDisabled = button.dataset.screen === "search" && headerSearchDisabled();
      button.hidden = searchNavDisabled;
      button.disabled = searchNavDisabled;
      button.classList.toggle("active", mobileScreens.mobileNavActive(button.dataset.screen));
      // Only rewrite the label when it actually changed; innerHTML writes
      // invalidate the whole nav bar on every refresh otherwise.
      const label = mobileScreens.mobileNavLabel(button.dataset.screen);
      if (button.__navLabel !== label) {
        button.innerHTML = label;
        button.__navLabel = label;
      }
    }
    const screen = el("mobileScreen");
    screen.classList.toggle("terminal-active", state.screen === "terminal");
    if (state.error) {
      syncBrowserFavicon();
      screen.innerHTML = `<div class="mobile-error">${escapeHtml(state.error)}</div>`;
      // The error markup bypasses the memo; drop it so the next clean
      // render (same screen, unchanged data) repaints instead of comparing
      // against stale pre-error HTML.
      screen.__lastScreenHtml = undefined;
      screen.__lastScreenName = null;
      return;
    }
    // Build the screen HTML, then only write innerHTML when it actually
    // changed. Every events-WS refresh calls render(); most carry unchanged
    // data, and rewriting the screen DOM needlessly reparses hundreds of
    // nodes (and would drop any focus inside the screen).
    // The memo is keyed to the screen that produced it: the git and
    // terminal surfaces write screen.innerHTML directly (they manage their
    // own partial updates), so the memo must never compare HTML built for
    // one screen against DOM content left by another.
    let html = null;
    if (state.screen === "agents") html = mobileScreens.renderAgents();
    else if (state.screen === "panels") html = renderPanels();
    else if (state.screen === "worktrees") html = mobileWorktrees.renderScreen();
    else if (state.screen === "files") html = mobileFileBrowser.renderScreen();
    else if (state.screen === "git") mobileGit.renderGitScreen(screen);
    else if (state.screen === "settings") html = mobileSettings.render();
    else if (state.screen === "sessions") html = mobileSessions.renderSessions();
    else if (state.screen === "terminal") renderTerminalScreen(screen);
    else if (state.screen === "more") html = mobileScreens.renderMore();
    else html = mobileScreens.renderHome();
    if (state.screen !== screen.__lastScreenName) {
      screen.__lastScreenHtml = undefined;
      screen.__lastScreenName = state.screen;
    }
    if (html !== null && screen.__lastScreenHtml !== html) {
      screen.innerHTML = html;
      screen.__lastScreenHtml = html;
    }
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
        const selectedTab = state.tabs.find((tab) => sameScopedId(state.ws, tab.tab_id, state.tab));
        if (!selectedTab) {
          const focused = state.tabs.find((tab) => tab.focused);
          state.tab = (focused || state.tabs[0] || {}).tab_id || null;
        } else {
          state.tab = selectedTab.tab_id;
        }
        const selectedPane = state.panes.find(
          (pane) =>
            sameScopedId(state.ws, pane.pane_id, state.pane) &&
            sameScopedId(state.ws, pane.tab_id, state.tab),
        );
        if (!selectedPane) {
          const pane =
            state.panes.find(
              (item) => sameScopedId(state.ws, item.tab_id, state.tab) && item.focused,
            ) ||
            state.panes.find((item) => sameScopedId(state.ws, item.tab_id, state.tab)) ||
            null;
          state.pane = pane && pane.pane_id;
        } else {
          state.pane = selectedPane.pane_id;
        }
        const pane = currentPane();
        state.terminalId = pane && pane.terminal_id;
        if (
          routeWs &&
          (routeWs !== state.ws ||
            !sameScopedId(state.ws, routeTab, state.tab) ||
            !sameScopedId(state.ws, routePane, state.pane))
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
      // Clear the boot flag BEFORE the final render so the first successful
      // render paints real rows, not the boot skeletons.
      state.booting = false;
      render();
      if (state.screen === "terminal") mobileTerminal.connect();
    } catch (error) {
      browserFaviconError = true;
      state.booting = false;
      state.error = error.message || String(error);
      render();
    }
  }

  function selectWorkspace(id) {
    mobileActions.selectWorkspace(id);
  }

  function selectAgent(ws, tab, pane) {
    mobileActions.selectAgent(ws, tab, pane);
  }

  function selectTab(tab) {
    mobileActions.selectTab(tab);
  }

  async function createPanel() {
    await mobileActions.createPanel();
  }

  async function closeCurrentPanel() {
    await mobileActions.closeCurrentPanel();
  }

  function currentScreen() {
    return mobileActions.currentScreen();
  }

  function currentSelection() {
    return mobileActions.currentSelection();
  }


  function runMobileAction(action) {
    mobileActions.runMobileAction(action);
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
    onAttentionAlert: (agents) => {
      const card = globalThis.HerdrAlertCard;
      if (!card || !state) return;
      const agent = agents[0];
      if (!agent) return;
      const status = mobileAttention.statusClass(agent.agent_status);
      const name = agent.name || agent.display_agent || agent.agent || agent.terminal_id || "agent";
      card.show({
        key: agent.terminal_id || `${agent.workspace_id}:${agent.tab_id}:${agent.pane_id}`,
        status,
        title: status === "blocked" ? "Agent blocked" : "Agent done",
        subtitle: `${name} in ${agent.workspace_id || "workspace"}`,
        onOpen: () => selectAgent(agent.workspace_id, agent.tab_id, agent.pane_id),
      });
    },
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
  mobileActions = globalThis.HerdrMobileActionsModule.create({
    state,
    api,
    confirmFn: (...args) => mobileConfirm(...args),
    refresh,
    render,
    showScreen,
    selectionPath,
    currentSessionBackend,
    sameScopedId,
    saveSessionSelection,
    currentWorkspaceCwd,
    tabTitle,
    getMobileFileBrowser: () => mobileFileBrowser,
    getMobileTerminal: () => mobileTerminal,
    getMobileSearch: () => mobileSearch,
    getMobileWorktrees: () => mobileWorktrees,
    getMobileTempTerminal: () => mobileTempTerminal,
    getMobileTheme: () => mobileTheme,
  });
  mobileBackend = globalThis.HerdrMobileBackendModule.create({
    state,
    api,
    confirmFn: (...args) => mobileConfirm(...args),
    localStorage,
    refresh,
    getMobileEvents: () => mobileEvents,
    readSessionBackend,
    writeSessionBackend,
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
  mobileTerminal = globalThis.HerdrMobileTerminal.create({
    el,
    state,
    wsUrl,
    onHerdrError: handleHerdrErrorFrame,
    onTerminalOutput: (...args) => mobileScreens.clearDismissedWorkingForTerminal(...args),
    onConnectionState: (connecting) => {
      state.terminalConnecting = !!connecting;
      const loading = el("mobileTerminalLoading");
      if (loading) loading.hidden = !connecting;
    },
  });
  mobileTempTerminal = globalThis.HerdrTempTerminal.create({
    el,
    state,
    wsUrl,
    api,
    modalId: "tempTerminalModal",
    onHerdrError: handleHerdrErrorFrame,
    // Navigate from the HTTP response: the backend already focused the
    // promoted workspace/tab/pane. selectAgent mirrors that surface and
    // persists the selection like any other explicit navigation.
    onPromoted: (workspace, tab, pane) => {
      const wsId = workspace && workspace.workspace_id;
      const tabId = tab && tab.tab_id;
      const paneId = pane && pane.pane_id;
      if (!wsId) return;
      mobileActions.selectAgent(wsId, tabId || null, paneId || null);
    },
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
      // Merge the shared --term-* token palette so ANSI colors follow the
      // CSS palette on mobile too (same helper the desktop uses).
      const tokenPalette = globalThis.HerdrAppHelpers && globalThis.HerdrAppHelpers.readTerminalThemeTokens
        ? globalThis.HerdrAppHelpers.readTerminalThemeTokens()
        : null;
      return {
        background: theme.background || (light ? "#ffffff" : "#1e1e2e"),
        foreground: theme.foreground || (light ? "#4c4f69" : "#cdd6f4"),
        cursor: theme.cursor || (light ? "#4c4f69" : "#cdd6f4"),
        selectionBackground: theme.selectionBackground || (light ? "#dce0f8" : "#45475a"),
        ...(tokenPalette || {}),
      };
    },
    defaultFolderFn: () => state.defaultFolder || "",
    workspaceIdFn: () => state.ws || (state.workspaces && state.workspaces.length === 1 ? state.workspaces[0].workspace_id : "") || "",
    inputGateFactory: createTerminalInputGate,
  });
  window.addEventListener("resize", () => mobileTempTerminal.handleResize());
  mobileSettings = globalThis.HerdrMobileSettings.create({
    api,
    applyTheme,
    escapeHtml,
    inputAttrs,
    localStorage,
    state,
    confirmFn: (...args) => mobileConfirm(...args),
  });
  mobileWorktrees = globalThis.HerdrMobileWorktrees.create({
    api,
    currentSessionBackend,
    defaultFolderFn: () => state.defaultFolder || "",
    destroyTerminal: mobileTerminal.destroy,
    escapeHtml,
    inputAttrs,
    jsArg,
    refresh,
    render,
    saveSessionSelection,
    selectionPath,
    state,
  });
  mobileFileBrowser = globalThis.HerdrMobileFileBrowser.create({
    api,
    confirm: (...args) => mobileConfirm(...args),
    currentWorkspaceCwd,
    escapeHtml,
    inputAttrs,
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
    inputAttrs,
    jsArg,
    pathBasename,
    currentWorkspaceCwd,
    confirmFn: (...args) => mobileConfirm(...args),
  });

  mobileComposer = globalThis.HerdrMobileComposerModule.create({
    state,
    api,
    render,
    escapeHtml,
    inputAttrs,
    statusClassFn: (status) => mobileAttention.statusClass(status),
    getTerminal: () => mobileTerminal.getTerm(),
  });
  // panels.js reads these through a global dep hook: it has no direct
  // reference to the composer module (load order would flip otherwise).
  globalThis.HerdrMobileComposerDeps = {
    renderComposerBar: (...args) => mobileComposer.renderComposerBar(...args),
    renderComposerNote: (...args) => mobileComposer.renderComposerNote(...args),
    renderPromptCard: (...args) => mobileComposer.renderPromptCard(...args),
    draftValue: (...args) => mobileComposer.draftValue(...args),
  };

  mobileEvents = globalThis.HerdrMobileEventsModule.create({
    document,
    globalThisWebSocket: globalThis.WebSocket,
    wsUrl,
    refresh,
    handleServerSettingsChanged,
    getTempTerminal: () => mobileTempTerminal,
  });
  // Connection dot in the header context: reflects the events stream state.
  mobileEvents.onEventState((connected) => {
    const dot = el("mobileConnectionDot");
    if (dot) {
      dot.dataset.state = connected ? "connected" : "connecting";
      dot.title = connected ? "Connected: events stream live" : "Connecting: events stream retrying";
    }
  });

  mobileSessions = globalThis.HerdrMobileSessionsModule.create({
    state,
    api,
    render,
    escapeHtml,
    inputAttrs,
    jsArg,
    localStorage,
    confirmFn: (...args) => mobileConfirm(...args),
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
    readSessionBackend,
    readSessionSelection,
    writeSessionBackend,
    forgetSessionState,
    saveSessionSelection,
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
    confirmFn: (...args) => mobileConfirm(...args),
    getWorkingDismissals: () => workingDismissals,
    getMobileTempTerminal: () => mobileTempTerminal,
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
    currentSessionBackend,
    dismissWorkingAgent: (...args) => mobileScreens.dismissWorkingAgent(...args),
    restoreWorkingAgent: (...args) => mobileScreens.restoreWorkingAgent(...args),
    loadGitStatus: (...args) => mobileGit.loadGitStatus(...args),
    selectGitFile: (...args) => mobileGit.selectGitFile(...args),
    backGitFiles: (...args) => mobileGit.backGitFiles(...args),
    gitStageFile: (...args) => mobileGit.gitStageFile(...args),
    gitUnstageFile: (...args) => mobileGit.gitUnstageFile(...args),
    gitDiscardFile: (...args) => mobileGit.gitDiscardFile(...args),
    openCommitSheet: (...args) => mobileGit.openCommitSheet(...args),
    closeCommitSheet: (...args) => mobileGit.closeCommitSheet(...args),
    setCommitField: (...args) => mobileGit.setCommitField(...args),
    submitCommit: (...args) => mobileGit.submitCommit(...args),
    dismissCommitDone: (...args) => mobileGit.dismissCommitDone(...args),
    composerInput: (...args) => mobileComposer.setDraft(...args),
    composerSubmit: (...args) => mobileComposer.submit(...args),
    renameWorkspace: (...args) => mobileScreens.startRenameWorkspace(...args),
    setRenameWorkspaceValue: (...args) => mobileScreens.setRenameWorkspaceValue(...args),
    submitRenameWorkspace: (...args) => mobileScreens.submitRenameWorkspace(...args),
    cancelRenameWorkspace: (...args) => mobileScreens.cancelRenameWorkspace(...args),
    closeWorkspace: (...args) => mobileScreens.closeWorkspaceById(...args),
    resolveConfirm,
    promptAnswer: (...args) => mobileComposer.promptAnswer(...args),
    promptAnswerText: (...args) => mobileComposer.promptAnswerText(...args),
    promptDismiss: (...args) => mobileComposer.promptDismiss(...args),
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
    logout: mobileSettings.logout,
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
    toggleSearchSection: mobileSettings.toggleSearchSection,
    setTerminalCore: mobileSettings.setTerminalCore,
    setFileContentSearchDefaultExpanded: mobileSettings.setFileContentSearchDefaultExpanded,
    setFileContentSearchMatchCase: mobileSettings.setFileContentSearchMatchCase,
    setFileContentSearchRegex: mobileSettings.setFileContentSearchRegex,
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
    openDrawer,
    closeDrawer,
    openDrawerTarget,
    keyBarKey(_event, button) {
      const key = button && button.dataset ? button.dataset.key : null;
      if (!key || !mobileTerminal || !mobileTerminal.sendControlKey) return;
      const PLAIN = { esc: "\x1b", tab: "\t", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D" };
      const CTRL = { up: "\x1b[1;5A", down: "\x1b[1;5B", right: "\x1b[1;5C", left: "\x1b[1;5D" };
      // Mirror the armed state onto the button for CSS (aria-pressed); the
      // source of truth is the module-level flag so DOM stubs can't desync.
      const setArmed = (armed) => {
        keyBarCtrlArmed = !!armed;
        if (button && button.setAttribute) button.setAttribute("aria-pressed", armed ? "true" : "false");
      };
      if (key === "ctrl") {
        setArmed(!keyBarCtrlArmed);
        return;
      }
      if (key === "ctrl-c") {
        mobileTerminal.sendControlKey("\x03");
        setArmed(false);
        return;
      }
      mobileTerminal.sendControlKey(keyBarCtrlArmed && CTRL[key] ? CTRL[key] : PLAIN[key]);
      setArmed(false);
    },
    currentScreen,
    currentSelection,
    refresh,
    runAction: runMobileAction,
    showScreen,
    refreshSessions: (...args) => mobileSessions.refreshSessions(...args),
    updateSessionField: (...args) => mobileSessions.updateSessionField(...args),
    setSessionCreateExpanded: (...args) => mobileSessions.setSessionCreateExpanded(...args),
    setSessionCleanupExpanded: (...args) => mobileSessions.setSessionCleanupExpanded(...args),
    newSession: (...args) => mobileSessions.newSession(...args),
    selectSession: (...args) => mobileSessions.selectSession(...args),
    closeSession: (...args) => mobileSessions.closeSession(...args),
    closeSessionRow: (...args) => mobileSessions.closeSessionRow(...args),
    cleanupSessions: (...args) => mobileSessions.cleanupSessions(...args),
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
  // Deep-URL boots land straight on a routed session (/session/work/...);
  // re-read that session's pin instead of keeping the default session's pin
  // read during state init (a stale default pin would target the wrong
  // backend for the routed session). Fresh boots on "/" keep the default
  // pin; nothing auto-opens either way.
  state.sessionBackend = readSessionBackend(state.session || "default");
  render();
  loadServerSettings().then(render);
  refresh();
  mobileEvents.connectEvents();
  // Popstate (Back/Forward) handler (mobile parity with the desktop
  // handleSessionPopState). refresh() alone re-parses the URL and restores
  // the workspace selection from it, but it cannot fix the session-level
  // hazards of history navigation:
  // 1. The backend pin is per session: re-read it for the session the
  //    history entry points at (a stale in-memory value must not leak the
  //    previous session's backend into the target).
  // 2. The events socket is bound to the session+backend captured at connect
  //    time; after a cross-session Back it is a zombie. Cycle it.
  // 3. Terminal/workspace state describes the previous session's target;
  //    reset it on a session change so nothing from the old session leaks.
  // Workspace/tab/pane restoration comes from the URL itself via refresh();
  // bare session entries stay bare (no auto-open), per the boot-clean rule.
  function handleSessionPopState() {
    const fromSession = state.session || "default";
    const fromBackend = mobileBackend.currentSessionBackend();
    parseRoute(true);
    const toSession = state.session || "default";
    state.sessionBackend = readSessionBackend(toSession);
    const sessionChanged = toSession !== fromSession;
    const backendChanged = mobileBackend.currentSessionBackend() !== fromBackend;
    if (sessionChanged) {
      state.ws = null;
      state.tab = null;
      state.pane = null;
      state.terminalId = null;
      state.workspaces = [];
      state.tabs = [];
      state.allTabs = [];
      state.panes = [];
      mobileTerminal.destroy(true);
    }
    // Re-subscribe the events socket only when what it is bound to actually
    // changed; Back within one session keeps the live subscription, and the
    // re-validation below only matters for a switch.
    if (sessionChanged || backendChanged) {
      mobileEvents.closeEventWs();
      mobileEvents.scheduleEventReconnect();
      // Re-validate the re-pinned backend against the server's enabled
      // backends (syncSessionBackendFromServer inside retargets and cycles
      // again if the pin is now disabled). serverBackendConfirmed stays true
      // after boot, so the user's explicit per-session choice is preserved.
      mobileBackend.loadServerSettings();
    }
    syncBackendBadge();
    refresh();
  }
  window.addEventListener("popstate", handleSessionPopState);
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
