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

  const state = {
    session: "default",
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
    gitCwd: "",
    gitStatus: null,
    gitError: "",
    gitFile: "",
    gitKind: "",
    gitDiff: null,
    gitDiffError: "",
  };

  let eventWs,
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

  function apiErrorMessage(body, statusText) {
    const err = body && body.error;
    if (!err) return statusText;
    if (typeof err === "string") return err;
    return err.message || err.code || statusText;
  }

  function wsUrl(path) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const sep = path.includes("?") ? "&" : "?";
    const session =
      state.session && state.session !== "default"
        ? sep + "session=" + encodeURIComponent(state.session)
        : "";
    return `${proto}//${location.host}${path}${session}`;
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
          <button class="mobile-btn" id="mobileSettings" title="Settings">⚙</button>
          <button class="mobile-btn" id="mobileTempTerminal" title="Temporary terminal">▢</button>
        </header>
        <main class="mobile-screen" id="mobileScreen"></main>
        <nav class="mobile-nav">
          <button data-screen="home">Workspaces</button>
          <button data-screen="agents">Agents</button>
          <button data-screen="panels">Panels</button>
          <button data-screen="worktrees">Worktrees</button>
          <button data-screen="files">Files</button>
          <button data-screen="git">Git</button>
          <button data-screen="terminal">Terminal</button>
        </nav>
      </div>
      <div class="temp-terminal-backdrop" id="tempTerminalModal">
        <div class="temp-terminal-modal" role="dialog" aria-modal="true" aria-labelledby="tempTerminalTitle">
          <div class="temp-terminal-head">
            <h2 id="tempTerminalTitle">Temporary terminal</h2>
            <button class="temp-terminal-close" id="tempTerminalClose" title="Close" aria-label="Close temporary terminal">✕</button>
          </div>
          <div class="temp-terminal-body">
            <div class="terminal" id="tempTerminal"></div>
          </div>
        </div>
      </div>`;
    el("mobileBack").onclick = () => showScreen("home");
    el("mobileSettings").onclick = () => showScreen("settings");
    el("mobileTempTerminal").onclick = () => mobileTempTerminal && mobileTempTerminal.open();
    const tempClose = el("tempTerminalClose");
    if (tempClose) tempClose.onclick = () => mobileTempTerminal && mobileTempTerminal.requestClose();
    document.querySelectorAll(".mobile-nav button").forEach((button) => {
      button.onclick = () => showScreen(button.dataset.screen);
    });
  }

  function showScreen(screen) {
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
    document.querySelectorAll(".mobile-nav button").forEach((button) => {
      button.classList.toggle("active", button.dataset.screen === state.screen);
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
    else screen.innerHTML = renderHome();
    syncBrowserFavicon();
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
    return `<section class="mobile-section"><h2>Workspaces</h2>${renderWorkspaces()}</section><section class="mobile-section"><h2>Agents</h2>${renderAgentsRows()}</section>`;
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
    if (screen !== "agents")
      return (
        {
          home: "Workspaces",
          panels: "Panels",
          worktrees: "Worktrees",
          files: "Files",
          git: "Git",
          terminal: "Terminal",
        }[screen] || screen
      );
    const status = mobileAttention.topStatus();
    return `Agents${status ? ` <span class="mobile-nav-status ${escapeHtml(status)}">${escapeHtml(status)}</span>` : ""}`;
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

  function connectEvents() {
    if (eventWs || !globalThis.WebSocket) return;
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
      refresh();
    };
    ws.onclose = () => {
      if (eventWs === ws) eventWs = null;
      setTimeout(connectEvents, 1500);
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
    filesUp: mobileFileBrowser.up,
    filesRefresh: mobileFileBrowser.refresh,
    filesBackToTree: mobileFileBrowser.backToTree,
    filesRefreshFile: mobileFileBrowser.refreshFile,
    filesFilter: mobileFileBrowser.filter,
    filesToggleFilterKind: mobileFileBrowser.toggleFilterKind,
    filesLoadMore: mobileFileBrowser.loadMore,
    filesScroll: mobileFileBrowser.scroll,
    filesTypeToFilter: mobileFileBrowser.typeToFilter,
    loadWorktrees: mobileWorktrees.load,
    openWorktree: mobileWorktrees.open,
    createWorktree: mobileWorktrees.create,
    updateWorktreeField: mobileWorktrees.updateField,
    setThemeMode: mobileSettings.setThemeMode,
    setBrowserNotifications: mobileSettings.setBrowserNotifications,
    setExplorationDefaultDirectory: mobileSettings.setExplorationDefaultDirectory,
    setFileBrowserDepth: mobileSettings.setFileBrowserDepth,
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
  refresh();
  connectEvents();
  window.addEventListener("popstate", () => {
    parseRoute(true);
    refresh();
  });
  window.addEventListener("resize", scheduleTerminalResize);
  if (window.visualViewport)
    window.visualViewport.addEventListener("resize", scheduleTerminalResize);
  document.addEventListener("visibilitychange", syncBrowserFavicon);
  document.addEventListener("pointerdown", mobileAttention.unlockAudio, {
    once: true,
  });
  document.addEventListener("keydown", mobileAttention.unlockAudio, {
    once: true,
  });
})();
