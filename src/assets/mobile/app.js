(function () {
  const {
    escapeHtml,
    jsArg,
    parseRoutePath,
    pathBasename,
    samePath,
    selectionPath: mobileSelectionPath,
  } = globalThis.HerdrMobileCore;
  const { createFaviconNotifier } = globalThis.HerdrAppHelpers;
  const MORE_SCREENS = ["agents", "panels", "worktrees", "files", "git", "settings"];

  const state = {
    session: "default",
    backendMode: "",
    sessionBackend: localStorage.getItem("herdr-session-backend") || "",
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
    gitCwd: "",
    gitStatus: null,
    gitError: "",
    gitFile: "",
    gitKind: "",
    gitDiff: null,
    gitDiffError: "",
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
    mobileWorktrees;

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

  function apiOptions(opt) {
    const next = Object.assign({}, opt || {});
    next.headers = Object.assign(
      {},
      next.headers || {},
      state.session && state.session !== "default"
        ? { "x-herdr-session": state.session }
        : {},
      currentSessionBackend()
        ? { "x-herdr-backend": currentSessionBackend() }
        : {},
    );
    return next;
  }

  async function api(url, opt) {
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
    } catch (_) {}
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

  function currentSessionBackend() {
    if (state.sessionBackend === "external") return "external-herdr";
    if (state.sessionBackend === "builtin" || state.sessionBackend === "external-herdr")
      return state.sessionBackend;
    if (state.backendMode === "external" || state.backendMode === "external-herdr")
      return "external-herdr";
    if (state.backendMode === "builtin") return "builtin";
    return "";
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

  function renderShell() {
    document.body.innerHTML = `
      <div id="mobileApp" class="mobile-app">
        <header class="mobile-header">
          <button class="mobile-btn" id="mobileBack" title="Home">←</button>
          <div class="mobile-context"><strong id="mobileTitle">Herdr</strong><span id="mobileMeta">Loading</span></div>
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
      <div class="temp-terminal-backdrop" id="tempTerminalModal">
        <div class="temp-terminal-modal" role="dialog" aria-modal="true" aria-labelledby="tempTerminalTitle">
          <div class="temp-terminal-head">
            <h2 id="tempTerminalTitle">Temporary terminal</h2>
            <div class="temp-terminal-head-actions">
              <span class="temp-terminal-hint">Input captured · Ctrl+G detaches</span>
              <button class="temp-terminal-minimize" id="tempTerminalMinimize" title="Minimize temporary terminal" aria-label="Minimize temporary terminal">−</button>
              <button class="temp-terminal-close" id="tempTerminalClose" title="Detach temporary terminal" aria-label="Detach temporary terminal">✕</button>
            </div>
          </div>
          <div class="temp-terminal-body">
            <div class="terminal" id="tempTerminal"></div>
          </div>
        </div>
      </div>`;
    el("mobileBack").onclick = () => showScreen("home");
    el("mobileSearch").onclick = openMobileSearch;
    el("mobileSettings").onclick = () => showScreen("settings");
    el("mobileTempTerminal").onclick = () => mobileTempTerminal && mobileTempTerminal.open();
    const tempClose = el("tempTerminalClose");
    if (tempClose) tempClose.onclick = () => mobileTempTerminal && mobileTempTerminal.requestClose();
    document.querySelectorAll(".mobile-nav button").forEach((button) => {
      button.onclick = () => showScreen(button.dataset.screen);
    });
  }

  function showScreen(screen) {
    if (screen === "search") {
      openMobileSearch();
      return;
    }
    const wasTerminal = state.screen === "terminal";
    state.screen = screen;
    if (wasTerminal && screen !== "terminal") mobileTerminal.destroy(false);
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
    else if (state.screen === "terminal") renderTerminalScreen(screen);
    else if (state.screen === "more") screen.innerHTML = renderMore();
    else screen.innerHTML = renderHome();
    syncBrowserFavicon();
  }

  function headerSearchDisabled() {
    try {
      return JSON.parse(localStorage.getItem("herdr-web-options") || "{}").headerSearchEnabled === false;
    } catch (_) {
      return false;
    }
  }

  function applyTreeIndent() {
    try {
      const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
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
    ];
    return `<section class="mobile-section mobile-more"><h2>More tools</h2><p class="mobile-help">Less-used tools stay here so Home, Search, and Terminal remain fast.</p><div class="mobile-more-grid">${tools.map((tool) => `<button class="mobile-more-card" onclick="HerdrMobile.showScreen('${tool.screen}')"><span class="mobile-more-icon">${escapeHtml(tool.icon)}</span><strong>${escapeHtml(tool.title)}</strong><small>${escapeHtml(tool.meta)}</small></button>`).join("")}</div></section>`;
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
        return `<button class="mobile-row${active}" onclick="HerdrMobile.selectAgent(${jsArg(agent.workspace_id)},${jsArg(agent.tab_id)},${jsArg(agent.pane_id)})"><strong>${escapeHtml(title || name)}</strong><span><span class="mobile-chip">${escapeHtml(status)}</span> ${escapeHtml(name)}</span></button>`;
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
    screen.innerHTML = `<section class="mobile-section mobile-git"><h2>Git</h2><p class="mobile-help">${escapeHtml(status.branch || "detached")} · ${escapeHtml(status.state || "")}</p><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.loadGitStatus()">Refresh</button>${rows}</section>`;
  }

  function renderGitFileDetail(status) {
    const file = currentGitDiffFile();
    const stats = file ? `+${file.additions || 0} -${file.deletions || 0}` : "No diff loaded";
    const error = state.gitDiffError ? `<div class="mobile-error">${escapeHtml(state.gitDiffError)}</div>` : "";
    const diff = file ? renderGitDiffFile(file) : `<div class="mobile-loading">${state.gitDiffError ? "No diff" : "Loading diff"}</div>`;
    return `<section class="mobile-section mobile-git"><div class="mobile-git-file-head"><button class="mobile-btn" onclick="HerdrMobile.backGitFiles()">Files</button><div><strong>${escapeHtml(state.gitFile)}</strong><span>${escapeHtml((status.branch || "detached") + " · " + stats)}</span></div></div>${error}${diff}</section>`;
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
        if (!state.tabs.some((tab) => tab.tab_id === state.tab))
          state.tab = (state.tabs[0] || {}).tab_id || null;
        if (!state.panes.some((pane) => pane.pane_id === state.pane)) {
          const pane =
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

  const mobileSearch = {
    query: "",
    pathKind: "file",
    timer: null,
    requestSeq: 0,
    actions: [],
    targets: [],
    pathEntries: [],
    pathGitStatus: null,
    pathLoading: false,
    pathError: "",
    pathDone: true,
    pathOffset: 0,
    content: globalThis.HerdrWorkspaceSearch ? globalThis.HerdrWorkspaceSearch.createContentState() : { query: "", files: [], expanded: {}, snippets: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0 },
    sectionsExpanded: { actions: true, workspaces: true, files: true, content: true },
  };

  function openMobileSearch() {
    if (headerSearchDisabled()) return;
    const sheet = el("mobileSearchSheet");
    const input = el("mobileSearchInput");
    if (!sheet || !input) return;
    mobileSearch.query = "";
    mobileSearch.actions = mobileActionCandidates("");
    mobileSearch.targets = mobileSearchTargets("");
    mobileSearch.pathEntries = [];
    mobileSearch.pathError = "";
    if (globalThis.HerdrWorkspaceSearch) globalThis.HerdrWorkspaceSearch.resetContentState(mobileSearch.content, "");
    input.value = "";
    sheet.hidden = false;
    renderMobileSearch();
    input.oninput = scheduleMobileSearch;
    input.onkeydown = mobileSearchKeydown;
    el("mobileSearchClose").onclick = closeMobileSearch;
    setTimeout(() => input.focus(), 0);
  }

  function closeMobileSearch() {
    const sheet = el("mobileSearchSheet");
    if (sheet) sheet.hidden = true;
    if (mobileSearch.timer) clearTimeout(mobileSearch.timer);
  }

  function mobileSearchTargets(query) {
    const helper = globalThis.HerdrWorkspaceSearch;
    if (helper && helper.settings && helper.settings().searchWorkspacesEnabled === false) return [];
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return [];
    const rows = [];
    for (const workspace of state.workspaces) {
      const text = mobileSearchText(
        workspaceTitle(workspace),
        workspaceMeta(workspace),
        workspace.workspace_id,
        workspace.worktree && workspace.worktree.checkout_path,
        mobileWorkspaceRepoFields(workspace),
        mobileWorkspaceTagFields(workspace),
        mobileWorkspaceBranchFields(workspace),
        mobileWorkspacePanelFields(workspace.workspace_id),
      ).toLowerCase();
      if (text.includes(needle)) rows.push({ type: "workspace", workspace, title: workspaceTitle(workspace), subtitle: workspaceMeta(workspace) });
    }
    for (const agent of state.agents) {
      const title = agent.name || agent.display_agent || agent.agent || agent.terminal_id || "agent";
      const text = [title, agent.workspace_id, agent.tab_id, agent.pane_id].filter(Boolean).join(" ").toLowerCase();
      if (!needle || text.includes(needle)) rows.push({ type: "agent", agent, title, subtitle: agent.workspace_id || "agent" });
    }
    return rows.slice(0, 10);
  }

  function mobileActionCandidates(query) {
    return globalThis.HerdrActionRegistry.candidates(query, {
      platform: "mobile",
      hasWorkspace: !!currentWorkspace(),
    });
  }

  function mobileTextParts(...values) {
    const out = [];
    for (const value of values) {
      if (Array.isArray(value)) out.push(...mobileTextParts(...value));
      else if (value && typeof value === "object") out.push(...mobileTextParts(...Object.values(value)));
      else if (value != null && String(value).trim()) out.push(String(value).trim());
    }
    return out;
  }

  function mobileSearchText(...values) {
    return mobileTextParts(...values).join(" ");
  }

  function mobileUniqueTextParts(...values) {
    const seen = new Set();
    return mobileTextParts(...values).filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function mobileWorkspaceRepoFields(workspace) {
    const wt = workspace && workspace.worktree;
    return mobileUniqueTextParts(wt && wt.repo_name, wt && wt.repo_key, wt && wt.repo_root, wt && wt.source_repo_name, wt && wt.source_repo_key, wt && wt.source_repo_root);
  }

  function mobileWorkspaceTagFields(workspace) {
    const wt = workspace && workspace.worktree;
    return mobileUniqueTextParts(workspace && workspace.tags, workspace && workspace.tag, workspace && workspace.labels, wt && wt.tags, wt && wt.tag, wt && wt.labels);
  }

  function mobileWorkspaceBranchFields(workspace) {
    const wt = workspace && workspace.worktree;
    const row = worktreeForWorkspace(workspace);
    return mobileUniqueTextParts(
      row && (row.branch || (row.is_detached ? "detached" : "")),
      workspace && workspace.branch,
      wt && wt.branch,
      wt && wt.base_branch,
      row && row.base_branch,
      row && row.upstream_branch,
    );
  }

  function mobileWorkspacePanelFields(workspaceId) {
    return mobileUniqueTextParts(state.allTabs.concat(state.tabs).filter((tab) => tab && tab.workspace_id === workspaceId).map((tab) => [tabTitle(tab), tab.label, tab.title, tab.name, tab.tab_id]));
  }

  function mobileSearchSettings() {
    return globalThis.HerdrWorkspaceSearch && globalThis.HerdrWorkspaceSearch.settings
      ? globalThis.HerdrWorkspaceSearch.settings()
      : { searchSectionOrder: ["workspaces", "files", "content"], searchWorkspacesEnabled: true, searchFilesEnabled: true, searchFoldersEnabled: true, searchContentEnabled: true };
  }

  function mobilePathSearchAvailable(opts = mobileSearchSettings()) {
    const helper = globalThis.HerdrWorkspaceSearch;
    return helper && helper.pathSearchAvailable ? helper.pathSearchAvailable(opts) : opts.searchFilesEnabled !== false || opts.searchFoldersEnabled !== false;
  }

  function normalizeMobilePathKind(opts = mobileSearchSettings()) {
    const helper = globalThis.HerdrWorkspaceSearch;
    mobileSearch.pathKind = helper && helper.normalizePathKind
      ? helper.normalizePathKind(mobileSearch.pathKind, opts)
      : mobileSearch.pathKind === "dir" && opts.searchFoldersEnabled === false && opts.searchFilesEnabled !== false
        ? "file"
        : mobileSearch.pathKind !== "dir" && opts.searchFilesEnabled === false && opts.searchFoldersEnabled !== false
          ? "dir"
          : mobileSearch.pathKind === "dir" ? "dir" : "file";
  }

  function scheduleMobileSearch() {
    const input = el("mobileSearchInput");
    mobileSearch.query = input ? input.value : "";
    mobileSearch.actions = mobileActionCandidates(mobileSearch.query);
    mobileSearch.targets = mobileSearchTargets(mobileSearch.query);
    renderMobileSearch();
    if (mobileSearch.timer) clearTimeout(mobileSearch.timer);
    mobileSearch.timer = setTimeout(() => runMobileWorkspaceSearch(false), 180);
  }

  async function runMobileWorkspaceSearch(append) {
    const helper = globalThis.HerdrWorkspaceSearch;
    if (!helper) return;
    const query = String(mobileSearch.query || "").trim();
    const cwd = currentWorkspaceCwd();
    const seq = ++mobileSearch.requestSeq;
    const opts = helper.settings();
    normalizeMobilePathKind(opts);
    if (!query || !cwd) {
      mobileSearch.pathEntries = [];
      helper.resetContentState(mobileSearch.content, query);
      renderMobileSearch();
      return;
    }
    const tasks = [];
    if (mobilePathSearchAvailable(opts)) tasks.push(runMobilePathSearch(seq, query, cwd, append));
    else {
      mobileSearch.pathEntries = [];
      mobileSearch.pathGitStatus = null;
      mobileSearch.pathOffset = 0;
      mobileSearch.pathDone = true;
      mobileSearch.pathLoading = false;
      mobileSearch.pathError = "";
    }
    if (opts.searchContentEnabled !== false) tasks.push(runMobileContentSearch(seq, query, cwd, append));
    else helper.resetContentState(mobileSearch.content, query);
    await Promise.allSettled(tasks);
    if (seq === mobileSearch.requestSeq) renderMobileSearch();
  }

  async function runMobilePathSearch(seq, query, cwd, append) {
    const helper = globalThis.HerdrWorkspaceSearch;
    mobileSearch.pathLoading = true;
    mobileSearch.pathError = "";
    renderMobileSearch();
    try {
      const offset = append ? mobileSearch.pathOffset : 0;
      const data = await helper.searchPaths({ cwd, query, kind: mobileSearch.pathKind, offset });
      if (seq !== mobileSearch.requestSeq) return;
      const entries = data.entries || [];
      mobileSearch.pathEntries = append ? mobileSearch.pathEntries.concat(entries) : entries;
      mobileSearch.pathGitStatus = data.git_status || null;
      mobileSearch.pathOffset = offset + entries.length;
      mobileSearch.pathDone = !data.truncated || entries.length === 0;
      mobileSearch.pathError = "";
    } catch (error) {
      if (seq !== mobileSearch.requestSeq) return;
      mobileSearch.pathError = error.message || String(error);
      mobileSearch.pathDone = true;
    }
    if (seq === mobileSearch.requestSeq) mobileSearch.pathLoading = false;
  }

  function renderMobileSearchPreservingScroll() {
    const box = el("mobileSearchResults");
    const top = box ? box.scrollTop : 0;
    renderMobileSearch();
    const next = el("mobileSearchResults");
    if (next) next.scrollTop = top;
  }

  async function runMobileContentSearch(seq, query, cwd, append, options = {}) {
    const helper = globalThis.HerdrWorkspaceSearch;
    const opts = helper.settings();
    mobileSearch.content.query = query;
    if (query.length < opts.contentMinChars) {
      helper.resetContentState(mobileSearch.content, query);
      mobileSearch.content.error = query ? `Type at least ${opts.contentMinChars} characters to search contents.` : "";
      return;
    }
    mobileSearch.content.loading = true;
    mobileSearch.content.error = "";
    (options.preserveScroll ? renderMobileSearchPreservingScroll : renderMobileSearch)();
    try {
      const offset = append ? mobileSearch.content.offset : 0;
      const data = await helper.searchContent({ cwd, query, offset, contextLines: mobileSearch.content.contextLines });
      if (seq !== mobileSearch.requestSeq) return;
      helper.applyContentResults(mobileSearch.content, data, append, { preserveExpanded: !!options.preserveExpanded });
    } catch (error) {
      if (seq !== mobileSearch.requestSeq) return;
      mobileSearch.content.error = error.message || String(error);
      mobileSearch.content.done = true;
    }
    if (seq === mobileSearch.requestSeq) mobileSearch.content.loading = false;
  }

  function renderMobileSearch() {
    const box = el("mobileSearchResults");
    const helper = globalThis.HerdrWorkspaceSearch;
    if (!box || !helper) return;
    const opts = helper.settings();
    normalizeMobilePathKind(opts);
    const query = String(mobileSearch.query || "").trim();
    const actionRows = mobileSearch.actions.length
      ? mobileSearch.actions.map((row, index) => `<button class="mobile-row" onclick="HerdrMobileSearch.openAction(${index})"><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.subtitle)}</span></button>`).join("")
      : '<div class="mobile-loading">No matching actions.</div>';
    const targetRows = mobileSearch.targets.length
      ? mobileSearch.targets.map((row, index) => `<button class="mobile-row" onclick="HerdrMobileSearch.openTarget(${index})"><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.subtitle || row.type)}</span></button>`).join("")
      : '<div class="mobile-loading">No workspace or agent matches.</div>';
    const pathTree = query
      ? mobileSearch.pathEntries.length
        ? helper.renderPathTree(mobileSearch.pathEntries, { query, kind: mobileSearch.pathKind, gitStatus: mobileSearch.pathGitStatus, callback: "HerdrMobileSearchTree" })
        : `<div class="mobile-loading">${mobileSearch.pathLoading ? "Searching..." : "No files or folders found."}</div>`
      : '<div class="mobile-loading">Type to search files or folders.</div>';
    const contentBody = !opts.searchContentEnabled
      ? '<div class="mobile-loading">File content search is disabled in Settings.</div>'
      : query.length < opts.contentMinChars
        ? `<div class="mobile-loading">Type at least ${opts.contentMinChars} characters to search file contents.</div>`
        : helper.renderContentPicker(mobileSearch.content, { callback: "HerdrMobileSearchContent", idPrefix: "mobileUnifiedSearchContent", disableSnippetEditing: true });
    const sections = {
      actions: renderMobileSearchSection("actions", "Actions", String(mobileSearch.actions.length), actionRows),
      workspaces: opts.searchWorkspacesEnabled === false || !query ? "" : renderMobileSearchSection("workspaces", "Workspaces and agents", String(mobileSearch.targets.length), targetRows),
      files: mobilePathSearchAvailable(opts) ? renderMobileSearchSection("files", "Files and folders", mobileSearch.pathKind === "dir" ? "Folders" : "Files", `<div class="mobile-actions"><button class="mobile-btn ${mobileSearch.pathKind === "file" ? "active" : ""}" ${opts.searchFilesEnabled === false ? "disabled" : ""} onclick="HerdrMobileSearch.setPathKind('file')">Files</button><button class="mobile-btn ${mobileSearch.pathKind === "dir" ? "active" : ""}" ${opts.searchFoldersEnabled === false ? "disabled" : ""} onclick="HerdrMobileSearch.setPathKind('dir')">Folders</button></div>${mobileSearch.pathError ? `<div class="mobile-error">${escapeHtml(mobileSearch.pathError)}</div>` : ""}${pathTree}`) : "",
      content: opts.searchContentEnabled === false ? "" : renderMobileSearchSection("content", "File content", `${Number(mobileSearch.content.total_matches || 0)} matches`, contentBody),
    };
    box.innerHTML = sections.actions + opts.searchSectionOrder.map((key) => sections[key] || "").join("");
  }

  function renderMobileSearchSection(key, title, meta, body) {
    const expanded = mobileSearch.sectionsExpanded[key] !== false;
    return `<section class="mobile-search-section"><button class="mobile-search-section-toggle" onclick="HerdrMobileSearch.toggleSection('${key}')" aria-expanded="${expanded ? "true" : "false"}"><strong><span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>${escapeHtml(title)}</strong><span>${escapeHtml(meta || "")}</span></button>${expanded ? body : ""}</section>`;
  }

  function mobileSearchKeydown(event) {
    if (event.key === "Escape") { event.preventDefault(); closeMobileSearch(); }
    else if (event.altKey && (event.key === "1" || event.code === "Digit1")) { event.preventDefault(); HerdrMobileSearch.toggleSection("workspaces"); }
    else if (event.altKey && (event.key === "2" || event.code === "Digit2")) { event.preventDefault(); HerdrMobileSearch.toggleSection("files"); }
    else if (event.altKey && (event.key === "3" || event.code === "Digit3")) { event.preventDefault(); HerdrMobileSearch.toggleSection("content"); }
    else if (event.altKey && event.key === "ArrowUp") { event.preventDefault(); HerdrMobileSearchContent.expandSnippet("", "", "up"); }
    else if (event.altKey && event.key === "ArrowDown") { event.preventDefault(); HerdrMobileSearchContent.expandSnippet("", "", "down"); }
    else if (event.key === "Enter") { event.preventDefault(); openFirstMobileSearchResult(); }
    else if (event.altKey && event.key && event.key.toLowerCase() === "f") { event.preventDefault(); HerdrMobileSearch.setPathKind("file"); }
    else if (event.altKey && event.key && event.key.toLowerCase() === "d") { event.preventDefault(); HerdrMobileSearch.setPathKind("dir"); }
  }

  function openFirstMobileSearchResult() {
    const opts = mobileSearchSettings();
    if (mobileSearch.sectionsExpanded.actions !== false && mobileSearch.actions[0]) { HerdrMobileSearch.openAction(0); return; }
    for (const section of opts.searchSectionOrder || ["workspaces", "files", "content"]) {
      if (mobileSearch.sectionsExpanded[section] === false) continue;
      if (section === "workspaces" && opts.searchWorkspacesEnabled !== false && mobileSearch.targets[0]) { HerdrMobileSearch.openTarget(0); return; }
      if (section === "files" && mobilePathSearchAvailable(opts)) {
        const pathEntry = (mobileSearch.pathEntries || []).find((entry) => (entry.kind === "dir" ? "dir" : "file") === mobileSearch.pathKind);
        if (pathEntry) { HerdrMobileSearch.openPath(pathEntry.path, pathEntry.kind); return; }
      }
      if (section === "content" && opts.searchContentEnabled !== false) {
        const file = (mobileSearch.content.files || [])[0];
        const match = file && (file.matches || [])[0];
        if (file && match) { HerdrMobileSearch.openContent(file.path, match.id); return; }
      }
    }
  }

  function runMobileAction(action) {
    if (action === "search") {
      openMobileSearch();
      return;
    }
    if (action === "open-workspace" || action === "discover-worktrees") {
      showScreen("worktrees");
      if (action === "discover-worktrees") mobileWorktrees.load();
      return;
    }
    if (action === "create-worktree") {
      state.worktreeCreateExpanded = true;
      showScreen("worktrees");
      return;
    }
    if (action === "temp-terminal") {
      if (mobileTempTerminal) mobileTempTerminal.open();
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
        window.matchMedia("(prefers-color-scheme: light)").matches);
    document.body.classList.toggle("light", light);
  }

  mobileAttention = globalThis.HerdrMobileAttention.create({
    localStorage,
    state,
    window,
  });
  mobileTerminal = globalThis.HerdrMobileTerminal.create({ el, state, wsUrl });
  mobileTempTerminal = globalThis.HerdrTempTerminal.create({
    el,
    state,
    wsUrl,
    api,
    modalId: "tempTerminalModal",
    containerId: "tempTerminal",
    fontFamilyFn: () => {
      try {
        const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
        return globalThis.HerdrAppHelpers.resolveTerminalFontFamily(parsed.terminalFontFamily);
      } catch (_) {
        return globalThis.HerdrAppHelpers.resolveTerminalFontFamily("");
      }
    },
    defaultFolderFn: () => state.defaultFolder || "",
  });
  window.addEventListener("resize", () => mobileTempTerminal.handleResize());
  mobileSettings = globalThis.HerdrMobileSettings.create({
    applyTheme,
    escapeHtml,
    localStorage,
    state,
  });
  mobileWorktrees = globalThis.HerdrMobileWorktrees.create({
    api,
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
    currentWorkspaceCwd,
    escapeHtml,
    render,
    state,
  });

  globalThis.HerdrMobileSearch = {
    toggleSection(section) {
      if (!["actions", "workspaces", "files", "content"].includes(section)) return;
      mobileSearch.sectionsExpanded[section] = mobileSearch.sectionsExpanded[section] === false;
      renderMobileSearch();
    },
    openAction(index) {
      const row = mobileSearch.actions[index];
      if (!row) return;
      closeMobileSearch();
      runMobileAction(row.action);
    },
    setPathKind(kind) {
      const opts = mobileSearchSettings();
      if (kind === "dir" && opts.searchFoldersEnabled === false) return;
      if (kind !== "dir" && opts.searchFilesEnabled === false) return;
      mobileSearch.pathKind = kind === "dir" ? "dir" : "file";
      mobileSearch.pathEntries = [];
      mobileSearch.pathOffset = 0;
      renderMobileSearch();
      runMobileWorkspaceSearch(false);
    },
    openTarget(index) {
      const row = mobileSearch.targets[index];
      if (!row) return;
      closeMobileSearch();
      if (row.type === "workspace") selectWorkspace(row.workspace.workspace_id);
      else if (row.agent) selectAgent(row.agent.workspace_id, row.agent.tab_id, row.agent.pane_id);
    },
    openPath(path, kind) {
      closeMobileSearch();
      showScreen("files");
      mobileFileBrowser.openAt(path, { kind: kind === "dir" ? "dir" : "file" });
    },
    openContent(path, matchId) {
      const helper = globalThis.HerdrWorkspaceSearch;
      const file = (mobileSearch.content.files || []).find((item) => item.path === path);
      const match = globalThis.HerdrContentSearch && globalThis.HerdrContentSearch.findMatch(file, matchId);
      closeMobileSearch();
      showScreen("files");
      mobileFileBrowser.openAt(path, { kind: "file", highlight: helper && helper.matchHighlight(match, mobileSearch.query) });
    },
  };

  globalThis.HerdrMobileSearchTree = {
    select(encodedPath) {
      const path = decodeURIComponent(encodedPath);
      const entry = (mobileSearch.pathEntries || []).find((item) => item.path === path);
      globalThis.HerdrMobileSearch.openPath(path, entry && entry.kind === "dir" ? "dir" : mobileSearch.pathKind);
    },
  };

  globalThis.HerdrMobileSearchContent = {
    toggleFile(encodedPath) {
      const path = decodeURIComponent(encodedPath);
      mobileSearch.content.expanded[path] = !mobileSearch.content.expanded[path];
      renderMobileSearch();
    },
    openFile(encodedPath) { globalThis.HerdrMobileSearch.openPath(decodeURIComponent(encodedPath), "file"); },
    openMatch(encodedPath, encodedMatchId) { globalThis.HerdrMobileSearch.openContent(decodeURIComponent(encodedPath), decodeURIComponent(encodedMatchId)); },
    expandAll() { for (const file of mobileSearch.content.files || []) mobileSearch.content.expanded[file.path] = true; renderMobileSearch(); },
    collapseAll() { for (const file of mobileSearch.content.files || []) mobileSearch.content.expanded[file.path] = false; renderMobileSearch(); },
    loadMore() { runMobileContentSearch(++mobileSearch.requestSeq, mobileSearch.query, currentWorkspaceCwd(), true, { preserveScroll: true }).then(renderMobileSearchPreservingScroll); },
    loadFile(_path) {},
    expandSnippet(_path, _match, _direction) {
      const helper = globalThis.HerdrWorkspaceSearch;
      const opts = helper ? helper.settings() : { contextLines: 2 };
      const current = Number(mobileSearch.content.contextLines ?? opts.contextLines ?? 2);
      mobileSearch.content.contextLines = globalThis.HerdrLineContext && globalThis.HerdrLineContext.nextContextSize
        ? globalThis.HerdrLineContext.nextContextSize(current, { min: 3, max: 20 })
        : Math.min(20, current < 3 ? 3 : current * 2);
      const path = decodeURIComponent(_path || "");
      if (path) mobileSearch.content.expanded[path] = true;
      runMobileContentSearch(++mobileSearch.requestSeq, mobileSearch.query, currentWorkspaceCwd(), false, { preserveExpanded: true, preserveScroll: true }).then(renderMobileSearchPreservingScroll);
    },
  };

  globalThis.HerdrMobile = {
    selectWorkspace,
    selectAgent,
    selectTab,
    createPanel,
    closeCurrentPanel,
    loadGitStatus,
    selectGitFile,
    backGitFiles,
    filesToggle: mobileFileBrowser.toggle,
    filesSelect: mobileFileBrowser.select,
    filesOpenAt: mobileFileBrowser.openAt,
    filesUp: mobileFileBrowser.up,
    filesRefresh: mobileFileBrowser.refresh,
    filesBackToTree: mobileFileBrowser.backToTree,
    filesRefreshFile: mobileFileBrowser.refreshFile,
    filesFilter: mobileFileBrowser.filter,
    filesClearFilter: mobileFileBrowser.clearFilter,
    filesSearchKeydown: mobileFileBrowser.searchKeydown,
    filesShowSearch: mobileFileBrowser.showSearch,
    filesCloseContentSearch: mobileFileBrowser.closeContentSearch,
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
    setWorktreeCreateExpanded: mobileWorktrees.setCreateExpanded,
    updateWorktreeField: mobileWorktrees.updateField,
    setThemeMode: mobileSettings.setThemeMode,
    setBrowserNotifications: mobileSettings.setBrowserNotifications,
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
    setWorktreeDefaultDirectory: mobileSettings.setWorktreeDefaultDirectory,
    applyTerminalFontFamily: mobileTerminal.applyFontFamily,
    applyTerminalLinks: mobileTerminal.applyLinks,
    scrollTerminalToBottom: mobileTerminal.scrollToBottom,
    currentScreen,
    currentSelection,
    refresh,
    runAction: runMobileAction,
    showScreen,
  };

  globalThis.HerdrMobileFiles = {
    toggle: mobileFileBrowser.toggle,
    select: mobileFileBrowser.select,
    up: mobileFileBrowser.up,
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
