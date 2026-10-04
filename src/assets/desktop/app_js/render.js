function render() {
  cleanupWorkingDismissals();
  const wsById = Object.fromEntries(
    state.workspaces.map((w) => [w.workspace_id, w]),
  );
  const tabById = Object.fromEntries(
    state.allTabs.concat(state.tabs).map((t) => [t.tab_id, t]),
  );
  const panesByTab = panesByTabIndex();
  const agentsByTab = agentsByTabIndex();
  updateTabActivity(panesByTab, agentsByTab);
  const tabCountsByWorkspace = new Map();
  for (const tab of state.allTabs)
    tabCountsByWorkspace.set(
      tab.workspace_id,
      (tabCountsByWorkspace.get(tab.workspace_id) || 0) + 1,
    );
  const workspacesHtml = renderSpacesCached();
  // The rename-input queries only matter while a rename is in flight; skip
  // the two querySelector calls on every poll when nothing is being edited.
  const workspaceRenameActive =
    !!state.editingWorkspace &&
    !!document.querySelector(".workspace-rename-input");
  const tabRenameActive =
    !!state.editingTab && !!document.querySelector(".tab-rename-input");
  if (
    workspacesHtml !== lastWorkspacesHtml &&
    !(state.editingWorkspace && workspaceRenameActive) &&
    !(state.editingTab && tabRenameActive)
  ) {
    workspaces.innerHTML = workspacesHtml;
    lastWorkspacesHtml = workspacesHtml;
  }
  const workspaceContextActions = el("workspaceContextActions"),
    workspaceContextHtml = renderWorkspaceContextActions();
  if (
    workspaceContextActions &&
    workspaceContextActions.innerHTML !== workspaceContextHtml
  )
    workspaceContextActions.innerHTML = workspaceContextHtml;
  syncWorkspacePanelMenuSize();
  const agentsHtml = renderAgents(wsById, tabById, tabCountsByWorkspace);
  if (agentsHtml !== lastAgentsHtml) {
    agents.innerHTML = agentsHtml;
    lastAgentsHtml = agentsHtml;
  }
  applySidebarCollapsed();
  syncGitWorkspaceToggle();
  syncFileWorkspaceToggle();
  // Both of these rebuild static icon markup on every render. Cache the last
  // written string and only touch the DOM when the theme/icon actually
  // changed; innerHTML writes here invalidate the head chrome on every poll.
  const themeHead = el("themeToggleHead");
  if (themeHead) {
    const iconHtml = themeToggleIcon();
    if (lastThemeHeadIcon !== iconHtml) {
      themeHead.innerHTML = iconHtml;
      lastThemeHeadIcon = iconHtml;
    }
  }
  const pane = state.panes.find((p) => p.pane_id === state.pane);
  const tabsHtml = "";
  if (tabsHtml !== lastTabsHtml && !(state.editingTab && tabRenameActive)) {
    tabs.innerHTML = tabsHtml;
    lastTabsHtml = tabsHtml;
    syncNoSleepControls();
  }
  updateTitle(wsById, tabById, tabCountsByWorkspace, pane);
  syncBrowserFavicon();
  syncProjectDashboard();
  if (state.editingTab) {
    const input = document.querySelector(".tab-rename-input");
    if (input && document.activeElement !== input) {
      input.focus();
    }
  }
  if (state.editingWorkspace) {
    const input = document.querySelector(".workspace-rename-input");
    if (input && document.activeElement !== input) {
      input.focus();
    }
  }
  // Terminal layout fit is driven by the dedicated resize scheduler
  // (scheduleTerminalResize, the shell ResizeObserver, and the layout.updated
  // event). Re-running the fit here forced getComputedStyle + clientHeight +
  // getBoundingClientRect reads on every refresh (every poll/event), which
  // interleaved layout reads with the DOM writes above (layout thrash) and
  // duplicated work the ResizeObserver already does when the DOM actually
  // changes. If no observer is available, keep the old behavior so the
  // terminal still fits on constrained engines.
  if (!terminalShellResizeObserverActive) {
    fitTerminalShell();
    if (typeof fitTerminalSurface === "function") fitTerminalSurface();
  }
}
// Tracks whether the dedicated shell ResizeObserver owns terminal fitting.
let terminalShellResizeObserverActive = false;
// Last innerHTML written to #themeToggleHead, so render() can skip the
// write when the theme icon did not change.
let lastThemeHeadIcon = null;

function panesByTabIndex() {
  const map = new Map();
  for (const pane of state.panes) {
    pushMapList(map, pane.tab_id, pane);
  }
  return map;
}
function agentsByTabIndex() {
  const map = new Map();
  for (const agent of state.agents) {
    pushMapList(map, workspaceTabKey(agent.workspace_id, agent.tab_id), agent);
  }
  return map;
}

function syncWorkspacePanelMenuSize() {
  const workspacePane = el("workspacePane"),
    menu = workspacePane && workspacePane.querySelector && workspacePane.querySelector(".panel-menu");
  if (!workspacePane) return;
  if (!menu) {
    // Skip the class/style writes when the pane is already in the closed
    // state; this runs on every render so unchanged writes are pure recalc.
    if (workspacePane.classList.contains("panel-menu-open")) {
      workspacePane.classList.remove("panel-menu-open");
      if (workspacePane.style.removeProperty)
        workspacePane.style.removeProperty("--workspace-panel-menu-min-height");
      else workspacePane.style.setProperty("--workspace-panel-menu-min-height", "0px");
    }
    return;
  }
  workspacePane.classList.add("panel-menu-open");
  const paneRect = workspacePane.getBoundingClientRect ? workspacePane.getBoundingClientRect() : null,
    menuRect = menu.getBoundingClientRect ? menu.getBoundingClientRect() : null;
  if (!paneRect || !menuRect) return;
  const minHeight = Math.max(0, Math.ceil(menuRect.bottom - paneRect.top + 10));
  // Setting the property to the same value still dirties style; only write
  // when the measured min-height actually moved. The typeof guard keeps
  // DOM-stub test environments (style objects without getPropertyValue) happy.
  if (
    typeof workspacePane.style.getPropertyValue !== "function" ||
    `${minHeight}px` !== workspacePane.style.getPropertyValue("--workspace-panel-menu-min-height")
  )
    workspacePane.style.setProperty("--workspace-panel-menu-min-height", `${minHeight}px`);
}
window.HerdrDesktopRender = render;
function syncProjectDashboard() {
  const dashboard = el("projectDashboard"),
    shell = el("terminalShell");
  if (!dashboard) return;
  const showDashboard = state.workspaces.length === 0 && !state.ws && !drawerSurfaceVisible();
  dashboard.hidden = !showDashboard;
  if (shell) shell.hidden = showDashboard;
  if (!showDashboard) return;
  dashboard.innerHTML = renderProjectDashboard();
}
function drawerSurfaceVisible() {
  return !!(
    (window.HerdrGitUi && window.HerdrGitUi.isVisible && window.HerdrGitUi.isVisible()) ||
    (window.HerdrFileBrowser && window.HerdrFileBrowser.isVisible && window.HerdrFileBrowser.isVisible())
  );
}
function renderProjectDashboard() {
  const actionsMenu = window.HerdrActionRegistry.action("actions-menu");
  return `<div class="project-dashboard-card"><div class="project-dashboard-hero"><h1>Start with a project</h1><p>Open one project first. Less-used actions stay in one menu and the command palette.</p></div><div class="project-dashboard-actions"><button class="project-dashboard-action primary" onclick="runSearchAction('open-workspace')"><strong>Open workspace or worktree</strong><span>Pick a folder, discover linked worktrees, and open the checkout.</span></button><button class="project-dashboard-action" onclick="openSearchPalette()"><strong>${escapeHtml(actionsMenu.title)}</strong><span>${escapeHtml(actionsMenu.subtitle)}</span></button></div></div>`;
}
function updateTitle(wsById, tabById, tabCountsByWorkspace, pane) {
  const w = wsById[state.ws];
  const t = tabById[state.tab];
  const workspace = w
    ? w.worktree
      ? worktreeDisplayName(w)
      : w.label
    : state.ws || state.session || "herdr";
  const panel = t
    ? agentTabLabel(state.ws, t, tabCountsByWorkspace) || tabTitle(t)
    : pane
      ? pane.pane_id
      : "panel";
  document.title = `${workspace} • ${panel}`;
}
function tabActivityKey(workspaceId, tabId) {
  return `${state.session || "default"}|${workspaceId || ""}|${tabId || ""}`;
}
function workspaceTabKey(workspaceId, tabId) {
  return `${workspaceId || ""}|${tabId || ""}`;
}
function pushMapList(map, key, value) {
  const rows = map.get(key) || [];
  rows.push(value);
  map.set(key, rows);
}
function tabActivitySignature(t, panesByTab, agentsByTab) {
  const panes = (panesByTab.get(t.tab_id) || [])
    .map((p) => [p.pane_id, p.terminal_id, !!p.focused]);
  const agents = (agentsByTab.get(workspaceTabKey(t.workspace_id, t.tab_id)) || [])
    .map((a) => [
      a.pane_id,
      a.terminal_id,
      a.name || a.display_agent || a.agent || "",
      statusClass(a.agent_status),
    ]);
  return JSON.stringify([
    t.workspace_id,
    t.tab_id,
    t.label || "",
    t.number || 0,
    !!t.focused,
    panes,
    agents,
  ]);
}
function updateTabActivity(panesByTab = new Map(), agentsByTab = new Map()) {
  // The activity timestamps only feed the optional tab activity labels
  // (options.showTabActivity, off by default). Building the per-tab
  // JSON.stringify signature for every tab on every render/poll is pure
  // waste when the labels are disabled, so skip the whole pass then.
  if (!options.showTabActivity) {
    if (!tabActivityPassRecorded) {
      tabActivity = {};
      tabActivityPassRecorded = true;
    }
    return;
  }
  tabActivityPassRecorded = false;
  const now = Date.now(),
    seen = new Set();
  for (const t of state.allTabs.concat(state.tabs)) {
    const key = tabActivityKey(t.workspace_id, t.tab_id),
      signature = tabActivitySignature(t, panesByTab, agentsByTab),
      current = tabActivity[key];
    seen.add(key);
    if (!current || current.signature !== signature)
      tabActivity[key] = { signature, updatedAt: now };
  }
  for (const key of Object.keys(tabActivity)) {
    if (key.startsWith(`${state.session || "default"}|`) && !seen.has(key))
      delete tabActivity[key];
  }
}
// Whether the disabled-showTabActivity branch already cleared the table,
// so repeated renders skip even the cleanup.
let tabActivityPassRecorded = false;
function tabHoverInfo(t, panesByTab) {
  const panes = panesByTab.get(t.tab_id) || [];
  const pane = panes.find((p) => p.pane_id === state.pane) || panes[0];
  if (!pane) return tabTitle(t);
  const size =
    t.tab_id === state.tab && state.termCols && state.termRows
      ? ` · ${state.termCols}x${state.termRows}`
      : "";
  return `${tabTitle(t)} · ${pane.pane_id} · ${pane.terminal_id}${size}`;
}
function renderTabButton(t, panesByTab) {
  if (state.editingTab === t.tab_id)
    return `<span class="tab ${t.tab_id === state.tab ? "active" : ""}"><input class="tab-rename-input" value="${escapeAttr(state.editingTabValue)}" onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitTabRename('${t.tab_id}')" oninput="state.editingTabValue=this.value" onkeydown="tabRenameKey(event,'${t.tab_id}')"></span>`;
  const activity = tabActivity[tabActivityKey(t.workspace_id, t.tab_id)],
    activityLabel =
      options.showTabActivity && activity
        ? tabActivityLabel(activity.updatedAt, Date.now())
        : "";
  return `<a class="tab ${t.tab_id === state.tab ? "active" : ""}"${t.tab_id === state.tab ? ' aria-current="page"' : ""} title="${escapeAttr(tabHoverInfo(t, panesByTab))}" href="${escapeAttr(selectionPath(t.workspace_id, t.tab_id))}" target="herdr-selection" onclick="return navigateSelection(event,'${t.workspace_id}','${t.tab_id}')" ondblclick="event.preventDefault();event.stopPropagation();startTabRename('${t.tab_id}','${escapeAttr(tabTitle(t))}')"><span class="tab-label">${escapeHtml(tabTitle(t))}</span>${activityLabel ? `<span class="tab-activity">${escapeHtml(activityLabel)}</span>` : ""}<span class="tab-actions"><span class="mini warn" title="Close panel" role="button" tabindex="0" aria-label="Close panel" onclick="event.preventDefault();event.stopPropagation();closeTab('${t.tab_id}')">✕</span></span></a>`;
}
function renderSpaces() {
  const groups = new Map(),
    usedParents = new Set(),
    linkedIds = new Set();
  for (const w of state.workspaces) {
    if (!isLinkedWorktree(w)) continue;
    const k = worktreeGroupKey(w);
    linkedIds.add(w.workspace_id);
    if (!groups.has(k))
      groups.set(k, {
        type: "group",
        key: k,
        label: w.worktree.repo_name || w.label,
        children: [],
        parent: null,
      });
    groups.get(k).children.push(w);
  }
  for (const g of groups.values()) {
    g.parent = findWorktreeParent(g);
    if (g.parent) usedParents.add(g.parent.workspace_id);
  }
  let items = [];
  for (const w of state.workspaces) {
    if (linkedIds.has(w.workspace_id) || usedParents.has(w.workspace_id))
      continue;
    items.push({ type: "single", workspace: w });
  }
  for (const g of groups.values()) items.push(g);
  items = sortWorkspaceItems(items);
  const selectedIndex = items.findIndex((item) =>
    workspaceItemIds(item).includes(state.ws),
  );
  if (selectedIndex > 0) items.unshift(items.splice(selectedIndex, 1)[0]);
  let html = "";
  for (const item of items) {
    if (item.type === "single") {
      html += renderWorkspaceCard(item.workspace, "");
      continue;
    }
    const children = sortGroupChildren(item.children);
    const selectedChildIndex = children.findIndex((w) => w.workspace_id === state.ws);
    if (selectedChildIndex > 0) children.unshift(children.splice(selectedChildIndex, 1)[0]);
    if (!item.parent) html += renderRepoHeader(item);
    if (item.parent)
      html += renderWorkspaceCard(item.parent, "workspace-group-main");
    const selectedChild = children.find((w) => w.workspace_id === state.ws);
    if (selectedChild)
      html += renderWorkspaceCard(selectedChild, "workspace-child selected-pin");
    html += children
      .filter((w) => w.workspace_id !== state.ws)
      .map((w, i, list) =>
        renderWorkspaceCard(
          w,
          "workspace-child " + (i === list.length - 1 ? "last" : ""),
        ),
      )
      .join("");
  }
  return html;
}

function renderSpacesCached() {
  const signature = workspaceSidebarSignature();
  if (signature === lastWorkspacesRenderSignature) return lastWorkspacesRenderedHtml;
  const html = renderSpaces();
  lastWorkspacesRenderSignature = signature;
  lastWorkspacesRenderedHtml = html;
  return html;
}

function workspaceSidebarSignature() {
  return JSON.stringify({
    session: state.session || "default",
    selected: [state.ws, state.tab, state.pane],
    editing: [state.editingWorkspace, state.editingWorkspaceValue, state.editingTab, state.editingTabValue],
    panelMenuOpen: !!state.panelMenuOpen,
    sort: [options.workspaceSort, state.workspaceOrder],
    shortcuts: [options.globalShortcutPrefix, options.webuiShortcuts || null],
    workspaces: (state.workspaces || []).map(workspaceSidebarRowSignature),
    worktrees: (state.worktrees || []).map(worktreeSidebarRowSignature),
    tabs: (state.tabs || []).map(tabSidebarRowSignature),
  });
}

function workspaceSidebarRowSignature(w) {
  const wt = (w && w.worktree) || {};
  return [
    w && w.workspace_id,
    w && w.label,
    w && w.pane_count,
    statusClass(w && w.agent_status),
    workspaceBranch(w),
    wt.is_linked_worktree === true,
    wt.repo_key || "",
    wt.repo_root || "",
    wt.repo_name || "",
    wt.checkout_path || "",
  ];
}

function worktreeSidebarRowSignature(w) {
  return [
    w && w.open_workspace_id,
    w && w.path,
    textValue(w && w.branch),
    textValue(w && w.label),
    w && w.source_repo_key,
    w && w.source_repo_root,
    w && w.source_repo_name,
    w && w.is_prunable,
  ];
}

function tabSidebarRowSignature(t) {
  return [t && t.workspace_id, t && t.tab_id, t && t.label, t && t.number];
}
function selectedWorkspace() {
  return state.workspaces.find((w) => w.workspace_id === state.ws) || null;
}
function selectedWorkspaceRepoPath() {
  const w = selectedWorkspace();
  if (!w) return "";
  if (w.worktree && w.worktree.repo_root) return w.worktree.repo_root;
  return workspacePath(w) || "";
}
function worktreeRowsForKey(key) {
  if (!key) return [];
  return state.worktrees.filter((w) => worktreeRowGroupKey(w) === key);
}
function selectedWorkspaceWorktreeKey(w = selectedWorkspace()) {
  return worktreeGroupKey(w);
}
function renderWorkspaceContextActions() {
  return "";
}
function selectedWorkspaceActionButtons(w) {
  if (!w) return "";
  const linked = isLinkedWorktree(w);
  const isSelected = w.workspace_id === state.ws;
  const buttons = [];
  buttons.push(
    `<span class="mini warn" data-workspace-action="close" title="${escapeAttr(titleWithWebuiShortcut(`Close ${linked ? "worktree" : "workspace"} and its panels`, "closeWorkspace"))}" onclick="event.preventDefault();event.stopPropagation();runWorkspaceContextAction('close', this, '${escapeAttr(w.workspace_id)}')">✕</span>`,
  );
  if (linked)
    buttons.push(
      `<span class="mini danger" data-workspace-action="remove-worktree" title="${escapeAttr(titleWithWebuiShortcut("Remove worktree from disk after confirmation", "removeWorktree"))}" onclick="event.preventDefault();event.stopPropagation();runWorkspaceContextAction('remove-worktree', this, '${escapeAttr(w.workspace_id)}')">🗑</span>`,
    );
  const className = isSelected ? "selected-space-actions" : "space-actions";
  return `<span class="space-actions ${className}">${buttons.join("")}</span>`;
}
function renderRepoHeader(group) {
  return `<div class="repo-header workspace-orphan-header"><span>${escapeHtml(group.label)}</span></div>`;
}
function workspaceItemIds(item) {
  return item.type === "single"
    ? [item.workspace.workspace_id]
    : [
        (item.parent && item.parent.workspace_id) || "",
        ...item.children.map((w) => w.workspace_id),
      ].filter(Boolean);
}
function workspaceOrderIndex(id) {
  const i = state.workspaceOrder.indexOf(id);
  return i < 0 ? 999999 : i;
}
function workspaceItemOrder(item) {
  return Math.min(...workspaceItemIds(item).map(workspaceOrderIndex));
}
function workspacePriority(w) {
  return (
    { blocked: 0, done: 1, unknown: 2, idle: 3, working: 4 }[
      statusClass(w.agent_status)
    ] ?? 2
  );
}
function workspaceItemPriority(item) {
  const all =
    item.type === "single"
      ? [item.workspace]
      : [item.parent, ...item.children].filter(Boolean);
  return Math.min(...all.map(workspacePriority));
}
function sortWorkspaceItems(items) {
  if (options.workspaceSort === "state")
    return items
      .slice()
      .sort((a, b) => workspaceItemPriority(a) - workspaceItemPriority(b));
  if (options.workspaceSort === "drag")
    return items
      .slice()
      .sort((a, b) => workspaceItemOrder(a) - workspaceItemOrder(b));
  return items;
}
function sortGroupChildren(children) {
  if (options.workspaceSort === "state")
    return children
      .slice()
      .sort((a, b) => workspacePriority(a) - workspacePriority(b));
  if (options.workspaceSort === "drag")
    return children
      .slice()
      .sort(
        (a, b) =>
          workspaceOrderIndex(a.workspace_id) -
          workspaceOrderIndex(b.workspace_id),
      );
  return children;
}
function renderWorkspaceCard(w, extraClass) {
  const editing = state.editingWorkspace === w.workspace_id;
  const title = workspaceDisplayTitle(w);
  const label = editing
    ? `<input class="workspace-rename-input" value="${escapeAttr(state.editingWorkspaceValue)}" onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitWorkspaceRename('${w.workspace_id}')" oninput="state.editingWorkspaceValue=this.value" onkeydown="workspaceRenameKey(event,'${w.workspace_id}')">`
    : `<span class="label">${escapeHtml(title)}</span>`;
  const drag =
    options.workspaceSort === "drag"
      ? ' draggable="true" ondragstart="workspaceDragStart(event,\'' +
        w.workspace_id +
        "')\" ondragover=\"workspaceDragOver(event,'" +
        w.workspace_id +
        '\')" ondragleave="workspaceDragLeave(event)" ondrop="workspaceDrop(event,\'' +
        w.workspace_id +
        '\')" ondragend="workspaceDragEnd(event)"'
      : "";
  const selected = w.workspace_id === state.ws;
  const meta = selected ? selectedSpaceMeta(w) : spaceMeta(w);
  const panelControls = selected ? renderPanelField() : "";
  const body = `<div class="space-title"><span>${statusDot(w.agent_status)}</span>${label}${selectedWorkspaceActionButtons(w)}</div><div class="muted space-meta-line">${panelControls}${meta}</div>`;
  if (selected)
    return `<div class="item active ${extraClass || ""}" data-workspace-id="${escapeAttr(w.workspace_id)}"${drag} ondblclick="event.preventDefault();event.stopPropagation();startWorkspaceRename('${w.workspace_id}','${escapeAttr(w.label)}')">${body}</div>`;
  return `<a class="item ${extraClass || ""}" data-workspace-id="${escapeAttr(w.workspace_id)}" href="${escapeAttr(selectionPath(w.workspace_id))}" target="herdr-selection"${drag} onclick="if(state.editingWorkspace){event.preventDefault();return false}return navigateSelection(event,'${w.workspace_id}')" ondblclick="event.preventDefault();event.stopPropagation();startWorkspaceRename('${w.workspace_id}','${escapeAttr(w.label)}')">${body}</a>`;
}

function syncGitWorkspaceToggle() {
  const button = el("gitWorkspaceToggle");
  if (!gitUiEnabled()) {
    if (button) button.remove();
    if (window.HerdrGitUi) window.HerdrGitUi.hide();
    return;
  }
  if (!button) {
    setupSessionChrome();
    return;
  }
  const workspace = selectedOrDefaultWorkspace();
  const status = window.HerdrGitUi && window.HerdrGitUi.workspaceStatus ? window.HerdrGitUi.workspaceStatus(state.ws, workspace) : "unknown";
  const className = `btn worktree-open-trigger shell-action shell-icon-button git-workspace-toggle ${status}`;
  if (button.className !== className) button.className = className;
  // The icon markup is static per status; skip the innerHTML rebuild (which
  // reparses SVG on every render/poll) unless the status class changed it.
  const iconHtml = appIcon("git");
  if (button.__herdrGitIcon !== iconHtml || button.__herdrGitIconStatus !== status) {
    button.innerHTML = iconHtml;
    button.__herdrGitIcon = iconHtml;
    button.__herdrGitIconStatus = status;
  }
  const ariaLabel = status === "nogit" ? "No Git repository detected" : "Show or hide Git drawer";
  const title = status === "nogit" ? "No Git repository detected" : "Show or hide Git drawer";
  if (typeof button.getAttribute === "function" && button.getAttribute("aria-label") !== ariaLabel)
    button.setAttribute("aria-label", ariaLabel);
  if (button.title !== title) button.title = title;
  syncShellModeButtons();
}

async function loadDesktopFeature(src) {
  if (window.HerdrLoadScript) {
    await window.HerdrLoadScript(src);
    return;
  }
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = src;
    script.onload = resolve;
    script.onerror = () => reject(Error("Failed to load " + src));
    document.body.appendChild(script);
  });
}

function loadDesktopFeatureCss(href) {
  if (window.HerdrLoadCss) {
    window.HerdrLoadCss(href);
    return;
  }
  if (document.querySelector && document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

async function ensureGitUiLoaded() {
  if (window.HerdrGitUi) return;
  loadDesktopFeatureCss("/assets/desktop/git-ui.css");
  await loadDesktopFeature("/assets/desktop/directory-picker.js");
  await loadDesktopFeature("/assets/desktop/git-ui.js");
}

async function ensureFileBrowserLoaded() {
  if (window.HerdrFileBrowser) return;
  loadDesktopFeatureCss("/assets/desktop/file-browser.css");
  await loadDesktopFeature("/assets/desktop/file-browser.js");
}

async function openWorkspaceGitUi(id, options) {
  if (!gitUiEnabled()) return;
  const openOptions = options || {};
  const workspace = selectedOrDefaultWorkspace(id);
  if (!workspace) return;
  try {
    await ensureGitUiLoaded();
  } catch (error) {
    alert(error.message || String(error));
    return;
  }
  if (!openOptions.forceOpen && currentWorkspaceShellMode(id) === "git" && !isWorkspaceShellMinimized(id) && window.HerdrGitUi.isWorkspaceVisible(workspaceShellKey(workspace))) {
    minimizeWorkspaceShell(id);
    return;
  }
  if (window.HerdrFileBrowser) window.HerdrFileBrowser.hide();
  rememberWorkspaceShellMode("git", id, { minimized: false });
  window.HerdrGitUi.open(workspace, openOptions);
  render();
}

function syncFileWorkspaceToggle() {
  const button = el("fileWorkspaceToggle");
  if (!button) {
    setupSessionChrome();
    return;
  }
  const workspace = selectedOrDefaultWorkspace();
  const hasPath = !!workspacePath(workspace);
  button.disabled = !hasPath;
  button.title = hasPath ? "Show file browser" : "No workspace or default folder available";
  syncShellModeButtons();
}

async function openWorkspaceFileBrowser(id, options) {
  const openOptions = options || {};
  const workspace = selectedOrDefaultWorkspace(id);
  if (!workspace) return;
  try {
    await ensureFileBrowserLoaded();
  } catch (error) {
    alert(error.message || String(error));
    return;
  }
  if (!openOptions.forceOpen && currentWorkspaceShellMode(id) === "files" && !isWorkspaceShellMinimized(id) && window.HerdrFileBrowser.isWorkspaceVisible(workspace)) {
    minimizeWorkspaceShell(id);
    return;
  }
  if (window.HerdrGitUi) window.HerdrGitUi.hide();
  rememberWorkspaceShellMode("files", id, { minimized: false });
  window.HerdrFileBrowser.open(workspace, openOptions).catch((error) => alert(error.message || String(error)));
  render();
}
function runWorkspaceContextAction(action, button, workspaceId) {
  const w = workspaceId
    ? state.workspaces.find((x) => x.workspace_id === workspaceId)
    : selectedWorkspace();
  if (!w) return;
  if (action === "create-worktree") openWorktreeCreateModal(w.workspace_id);
  else if (action === "open-worktrees") openWorktreesForWorkspace(w, button.dataset.key || "");
  else if (action === "close") closeWorkspace(w.workspace_id);
  else if (action === "remove-worktree") removeWorktree(w.workspace_id);
}
async function renameCurrentPanel() {
  const tab = state.allTabs.concat(state.tabs).find((t) => t.tab_id === state.tab);
  if (!tab) return;
  const label = prompt("Rename panel", tabTitle(tab));
  if (label === null) return;
  const trimmed = String(label || "").trim();
  if (!trimmed) return;
  await api(`/api/tabs/${encodeURIComponent(tab.tab_id)}/rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: trimmed }),
  });
  refresh();
}
function workspaceDisplayTitle(w) {
  if (!isLinkedWorktree(w)) return w.label;
  return workspaceBranch(w) || worktreeDisplayName(w) || w.label;
}
function spaceMeta(w) {
  const wt = worktreeForWorkspace(w);
  const parts = [`${w.pane_count} panes`];
  if (isLinkedWorktree(w)) {
    const label = worktreeCustomLabel(w, wt);
    if (label)
      parts.push(`<span class="chip label"><span class="chip-icon" aria-hidden="true">🏷</span>${escapeHtml(label)}</span>`);
  } else {
    const branch = workspaceBranch(w);
    if (branch)
      parts.push(`<span class="chip branch">${escapeHtml(branch)}</span>`);
  }
  return parts.join(" ");
}
function selectedSpaceMeta(w) {
  const wt = worktreeForWorkspace(w),
    parts = [];
  if (isLinkedWorktree(w)) {
    const label = worktreeCustomLabel(w, wt);
    if (label)
      parts.push(`<span class="chip label"><span class="chip-icon" aria-hidden="true">🏷</span>${escapeHtml(label)}</span>`);
  } else {
    const branch = workspaceBranch(w);
    if (branch)
      parts.push(`<span class="chip branch">${escapeHtml(branch)}</span>`);
  }
  return parts.join(" ");
}
function worktreeCustomLabel(w, wt = worktreeForWorkspace(w)) {
  const label = textValue(w.label || (wt && wt.label));
  if (!label) return "";
  const branch = workspaceBranch(w);
  const folder = pathBasename((wt && wt.path) || (w.worktree && w.worktree.checkout_path));
  if (label === branch || label === folder) return "";
  return label;
}
function isLinkedWorktree(w) {
  return !!(w && w.worktree && w.worktree.is_linked_worktree);
}
function worktreeSourceWorkspaceIds() {
  const idsByKey = new Map();
  for (const w of state.workspaces) {
    if (!w || !w.workspace_id) continue;
    const key = worktreeGroupKey(w);
    if (!idsByKey.has(key) || (w.worktree && !w.worktree.is_linked_worktree))
      idsByKey.set(key, w.workspace_id);
  }
  return [...idsByKey.values()];
}
function worktreeGroupKey(w) {
  // Identity must come from an absolute repo path. The bare repo folder
  // name (repo_name) is display-only: two repos in different parent
  // folders can share it, so using it here merges unrelated projects
  // into one sidebar group. When no path is available the workspace
  // gets a unique per-workspace key instead of a colliding one.
  return (
    (w &&
      w.worktree &&
      (w.worktree.repo_key || w.worktree.repo_root)) ||
    (w && w.workspace_id ? `workspace:${w.workspace_id}` : "")
  );
}
function worktreeRowGroupKey(w) {
  // Rows are discovered per repo, so identity is the absolute source repo
  // path. The bare source_repo_name is display-only and collides across
  // same-named repos in different parent folders.
  return (w && (w.source_repo_key || w.source_repo_root)) || "";
}
function findWorktreeParent(group) {
  // The parent is the open main checkout of the SAME repo, matched by
  // the absolute repo path only. Falling back to a bare workspace-label
  // comparison adopted same-named folders from other projects as the
  // parent, so that fallback is gone.
  const childKey = group.children[0]
    ? worktreeGroupKey(group.children[0])
    : "";
  if (!childKey || childKey.startsWith("workspace:")) return null;
  return (
    state.workspaces.find(
      (w) =>
        w.worktree &&
        !w.worktree.is_linked_worktree &&
        worktreeGroupKey(w) === childKey,
    ) || null
  );
}
function worktreeForWorkspace(w) {
  if (!w.worktree) return null;
  return (
    state.worktrees.find((t) => t.open_workspace_id === w.workspace_id) ||
    state.worktrees.find((t) => samePath(t.path, w.worktree.checkout_path)) ||
    null
  );
}
function samePath(a, b) {
  return (
    String(a || "").replace(/\/+$/, "") === String(b || "").replace(/\/+$/, "")
  );
}
function renderAgents(wsById, tabById, tabCountsByWorkspace) {
  const list = state.agents.slice();
  if (options.agentSortMode !== "off") {
    // Hoist the normalized order out of the comparator: sorting n agents
    // used to rebuild it O(n log n) times via normalizeAgentStatusOrder.
    const order = normalizeAgentStatusOrder(options.agentStatusOrder),
      orderMap = new Map(),
      rankOf = (a) => agentAttentionRank(a, order, orderMap);
    list.sort((a, b) => agentAttentionCompare(a, b, rankOf));
  }
  return list
    .map((a) => renderAgentRow(a, wsById, tabById, tabCountsByWorkspace))
    .join("");
}
function agentAttentionCompare(a, b, rankOf) {
  // rankOf is injected by renderAgents so the normalized order is built once
  // per sort; direct 2-arg callers (tests) fall back to building it here.
  if (!rankOf) {
    const order = normalizeAgentStatusOrder(options.agentStatusOrder),
      orderMap = new Map();
    rankOf = (x) => agentAttentionRank(x, order, orderMap);
  }
  return rankOf(a) - rankOf(b);
}
function agentAttentionRank(a, order, orderMap) {
  const status = isWorkingDismissed(a) ? "idle" : statusClass(a.agent_status);
  const group = ["idle", "working", "blocked", "done"].includes(status)
    ? status
    : "other";
  // orderMap caches the group -> rank lookup so the sort comparator does not
  // rebuild the normalized order array per comparison.
  if (orderMap) {
    let rank = orderMap.get(group);
    if (rank === undefined) {
      rank = order.indexOf(group);
      rank = rank >= 0 ? rank : order.length;
      orderMap.set(group, rank);
    }
    return rank;
  }
  const rank = order.indexOf(group);
  return rank >= 0 ? rank : order.length;
}
function agentToken(cls, value) {
  const s = String(value || "");
  return `<span class="agent-token ${cls}" title="${escapeAttr(s)}">${escapeHtml(s)}</span>`;
}
function renderAgentRow(a, wsById, tabById, tabCountsByWorkspace) {
  const w = wsById[a.workspace_id];
  const repo = w && w.worktree ? parentWorkspaceName(w, wsById) : null;
  const worktree =
    w && w.worktree ? agentWorktreeDisplayName(w) : w ? w.label : a.workspace_id;
  const t = tabById[a.tab_id];
  const tab = agentTabLabel(a.workspace_id, t, tabCountsByWorkspace);
  const fullTitle =
    (repo ? `${repo} › ${worktree}` : worktree) + (tab ? ` › ${tab}` : "");
  const titleParts = repo
    ? [
        agentToken("agent-repo", repo),
        `<span class="agent-sep">›</span>`,
        agentToken("agent-worktree", worktree),
      ]
    : [agentToken("agent-worktree", worktree)];
  if (tab)
    titleParts.push(
      `<span class="agent-sep">›</span>${agentToken("agent-panel", tab)}`,
    );
  const label = a.name || a.display_agent || a.agent || a.terminal_id;
  const status = statusClass(a.agent_status);
  const dismissed = isWorkingDismissed(a);
  const displayStatus = dismissed ? "ignored" : status;
  const action =
    status === "working" && options.stuckWorkingEnabled
      ? dismissed
        ? `<span class="mini agent-action" title="Show this working agent again" onclick="event.preventDefault();event.stopPropagation();restoreWorkingAgent('${a.workspace_id}','${a.tab_id}','${a.pane_id}','${a.terminal_id || ""}')">Undo</span>`
        : `<span class="mini agent-action" title="Locally ignore this stuck working state" onclick="event.preventDefault();event.stopPropagation();dismissWorkingAgent('${a.workspace_id}','${a.tab_id}','${a.pane_id}','${a.terminal_id || ""}')">Dismiss</span>`
      : "";
  const active =
    a.workspace_id === state.ws &&
    a.tab_id === state.tab &&
    a.pane_id === state.pane;
  return `<a class="item ${active ? "active" : ""} ${dismissed ? "agent-dismissed" : ""}" title="${escapeAttr(fullTitle)}" href="${escapeAttr(selectionPath(a.workspace_id, a.tab_id, a.pane_id))}" target="herdr-selection" onclick="return navigateSelection(event,'${a.workspace_id}','${a.tab_id}','${a.pane_id}')"><div class="agent-title">${statusMark(displayStatus, status === "blocked")}${titleParts.join("")}</div><div class="agent-meta"><span class="agent-status ${displayStatus}">${escapeHtml(displayStatus)}</span><span>•</span><span class="agent-name">${escapeHtml(label)}</span>${action}</div></a>`;
}
function agentWorktreeDisplayName(w) {
  if (!isLinkedWorktree(w)) return worktreeDisplayName(w);
  return worktreeCustomLabel(w) || worktreeDisplayName(w);
}
function agentTabLabel(wsId, t, tabCountsByWorkspace) {
  if (!t) return "";
  const count = tabCountsByWorkspace.get(wsId) || 0;
  // Single-panel workspaces need no disambiguation. With several panels show
  // the custom name, or the panel number when the label is a default like
  // "Shell" (isDefaultPanelTitle treats "Shell"/"Terminal"/"tab N" as defaults).
  if (count <= 1) return "";
  const label = String(t.label || "").trim();
  return isDefaultPanelTitle(label) ? `#${panelNumberLabel(t)}` : label;
}
function pathBasename(path) {
  const parts = String(path || "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
function worktreeDisplayName(w) {
  if (!w) return "worktree";
  const wt = worktreeForWorkspace(w);
  return (
    workspaceBranch(w) ||
    pathBasename((wt && wt.path) || (w.worktree && w.worktree.checkout_path)) ||
    (wt && wt.label) ||
    w.label
  );
}
function parentWorkspaceName(w, wsById) {
  if (!w || !w.worktree) return "workspace";
  // Match the main checkout of the same repo by absolute path only.
  // repo_name (bare folder name) is display-only: same-named repos in
  // different parent folders must never adopt each other as parent, so
  // the old workspace-label fallback is gone.
  const key = w.worktree.repo_key || w.worktree.repo_root;
  if (!key) return w.worktree.repo_name || w.label || "workspace";
  const match = Object.values(wsById).find(
    (x) =>
      x.workspace_id !== w.workspace_id &&
      x.worktree &&
      !x.worktree.is_linked_worktree &&
      (x.worktree.repo_key || x.worktree.repo_root) === key,
  );
  return match ? match.label : w.worktree.repo_name || "workspace";
}
