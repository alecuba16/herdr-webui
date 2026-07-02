function render() {
  cleanupWorkingDismissals();
  updateTabActivity();
  const wsById = Object.fromEntries(
    state.workspaces.map((w) => [w.workspace_id, w]),
  );
  const tabById = Object.fromEntries(
    state.allTabs.concat(state.tabs).map((t) => [t.tab_id, t]),
  );
  const panesByTab = new Map();
  for (const pane of state.panes) {
    const panes = panesByTab.get(pane.tab_id) || [];
    panes.push(pane);
    panesByTab.set(pane.tab_id, panes);
  }
  const tabCountsByWorkspace = new Map();
  for (const tab of state.allTabs)
    tabCountsByWorkspace.set(
      tab.workspace_id,
      (tabCountsByWorkspace.get(tab.workspace_id) || 0) + 1,
    );
  const workspacesHtml = renderSpaces();
  const workspaceRenameActive = !!document.querySelector(
    ".workspace-rename-input",
  );
  const tabRenameActive = !!document.querySelector(".tab-rename-input");
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
  const agentsHtml = renderAgents(wsById, tabById, tabCountsByWorkspace);
  if (agentsHtml !== lastAgentsHtml) {
    agents.innerHTML = agentsHtml;
    lastAgentsHtml = agentsHtml;
  }
  applySidebarCollapsed();
  syncGitWorkspaceToggle();
  syncFileWorkspaceToggle();
  const themeHead = el("themeToggleHead");
  if (themeHead) themeHead.innerHTML = themeToggleIcon();
  const pane = state.panes.find((p) => p.pane_id === state.pane);
  const tabsHtml = "";
  if (tabsHtml !== lastTabsHtml && !(state.editingTab && tabRenameActive)) {
    tabs.innerHTML = tabsHtml;
    lastTabsHtml = tabsHtml;
    syncNoSleepControls();
  }
  updateTitle(wsById, tabById, tabCountsByWorkspace, pane);
  syncBrowserFavicon();
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
  fitTerminalShell();
}
window.HerdrDesktopRender = render;
function updateTitle(wsById, tabById, tabCountsByWorkspace, pane) {
  const w = wsById[state.ws];
  const t = tabById[state.tab];
  const workspace = w
    ? w.worktree
      ? worktreeDisplayName(w)
      : w.label
    : state.ws || state.session || "herdr";
  const panel = t
    ? agentTabLabel(state.ws, t, tabCountsByWorkspace)
    : pane
      ? pane.pane_id
      : "panel";
  document.title = `${workspace} • ${panel}`;
}
function tabActivityKey(workspaceId, tabId) {
  return `${state.session || "default"}|${workspaceId || ""}|${tabId || ""}`;
}
function tabActivitySignature(t) {
  const panes = state.panes
    .filter((p) => p.tab_id === t.tab_id)
    .map((p) => [p.pane_id, p.terminal_id, !!p.focused]);
  const agents = state.agents
    .filter((a) => a.workspace_id === t.workspace_id && a.tab_id === t.tab_id)
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
function updateTabActivity() {
  const now = Date.now(),
    seen = new Set();
  for (const t of state.allTabs.concat(state.tabs)) {
    const key = tabActivityKey(t.workspace_id, t.tab_id),
      signature = tabActivitySignature(t),
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
  return `<a class="tab ${t.tab_id === state.tab ? "active" : ""}" title="${escapeAttr(tabHoverInfo(t, panesByTab))}" href="${escapeAttr(selectionPath(t.workspace_id, t.tab_id))}" target="herdr-selection" onclick="return navigateSelection(event,'${t.workspace_id}','${t.tab_id}')" ondblclick="event.preventDefault();event.stopPropagation();startTabRename('${t.tab_id}','${escapeAttr(tabTitle(t))}')"><span class="tab-label">${escapeHtml(tabTitle(t))}</span>${activityLabel ? `<span class="tab-activity">${escapeHtml(activityLabel)}</span>` : ""}<span class="tab-actions"><span class="mini warn" title="Close panel" onclick="event.preventDefault();event.stopPropagation();closeTab('${t.tab_id}')">✕</span></span></a>`;
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
function selectedWorkspace() {
  return state.workspaces.find((w) => w.workspace_id === state.ws) || null;
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
  if (!w || w.workspace_id !== state.ws) return "";
  const key = selectedWorkspaceWorktreeKey(w),
    rows = worktreeRowsForKey(key),
    linked = isLinkedWorktree(w),
    hasOtherWorktrees = rows.some(
      (row) => row.open_workspace_id !== w.workspace_id,
    ),
    label = escapeHtml(workspaceDisplayTitle(w));
  const buttons = [];
  if (!linked)
    buttons.push(
      `<span class="mini tree" data-workspace-action="create-worktree" title="Create a linked worktree from ${label}" onclick="event.preventDefault();event.stopPropagation();runWorkspaceContextAction('create-worktree',this)">♧+</span>`,
    );
  if (key && hasOtherWorktrees)
    buttons.push(
      `<span class="mini tree" data-workspace-action="open-worktrees" data-key="${escapeAttr(encodeURIComponent(key))}" title="Open or create other worktrees for this repo" onclick="event.preventDefault();event.stopPropagation();runWorkspaceContextAction('open-worktrees',this)">↗</span>`,
    );
  buttons.push(
    `<span class="mini warn" data-workspace-action="close" title="Close selected ${linked ? "worktree" : "workspace"} and its panels" onclick="event.preventDefault();event.stopPropagation();runWorkspaceContextAction('close',this)">✕</span>`,
  );
  if (linked)
    buttons.push(
      `<span class="mini danger" data-workspace-action="remove-worktree" title="Remove selected worktree from disk after confirmation" onclick="event.preventDefault();event.stopPropagation();runWorkspaceContextAction('remove-worktree',this)">🗑</span>`,
    );
  return `<span class="space-actions selected-space-actions">${buttons.join("")}</span>`;
}
function renderPanelField() {
  if (!state.ws)
    return '<span class="panel-field-empty">No panel</span>';
  const tabs = state.tabs || [],
    current = tabs.find((t) => t.tab_id === state.tab) || tabs[0] || null,
    currentLabel = current ? tabTitle(current) : "No panel";
  const hasSwitcher = tabs.length > 1;
  if (current && state.editingTab === current.tab_id)
    return `<div class="panel-field"><input class="panel-label panel-rename-input tab-rename-input" value="${escapeAttr(state.editingTabValue)}" onmousedown="event.stopPropagation()" onclick="event.stopPropagation()" onblur="commitTabRename('${current.tab_id}')" oninput="state.editingTabValue=this.value" onkeydown="tabRenameKey(event,'${current.tab_id}')"><button class="mini panel-add" title="New panel" onclick="event.preventDefault();event.stopPropagation();newTab()">+</button><button class="mini warn panel-close" title="Close current panel" onclick="event.preventDefault();event.stopPropagation();closeTab('${current.tab_id}')">✕</button></div>`;
  const menu = hasSwitcher && state.panelMenuOpen ? `<div class="panel-menu">${tabs.map((tab) => `<button class="panel-menu-item${tab.tab_id === state.tab ? " active" : ""}" onclick="event.preventDefault();event.stopPropagation();state.panelMenuOpen=false;go(state.ws,decodeURIComponent('${encodeURIComponent(tab.tab_id)}'))">${escapeHtml(tabTitle(tab))}</button>`).join("")}</div>` : "";
  const caret = hasSwitcher ? '<span class="panel-caret">▼</span>' : "";
  const click = hasSwitcher ? "togglePanelMenu()" : "";
  const close = current ? `<button class="mini warn panel-close" title="Close current panel" onclick="event.preventDefault();event.stopPropagation();closeTab('${current.tab_id}')">✕</button>` : "";
  return `<div class="panel-field"><button class="panel-label" title="Current panel: ${escapeAttr(currentLabel)}. Double-click to rename." onclick="event.preventDefault();event.stopPropagation();${click}" ondblclick="event.preventDefault();event.stopPropagation();state.panelMenuOpen=false;${current ? `startTabRename('${current.tab_id}','${escapeAttr(currentLabel)}')` : ""}"><span>${escapeHtml(currentLabel)}</span>${caret}</button>${menu}<button class="mini panel-add" title="New panel" onclick="event.preventDefault();event.stopPropagation();newTab()">+</button>${close}</div>`;
}

function togglePanelMenu() {
  state.panelMenuOpen = !state.panelMenuOpen;
  render();
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
  const workspace = state.workspaces.find((w) => w.workspace_id === state.ws);
  const status = window.HerdrGitUi && window.HerdrGitUi.workspaceStatus ? window.HerdrGitUi.workspaceStatus(state.ws, workspace) : "unknown";
  button.className = `btn worktree-open-trigger shell-action shell-icon-button git-workspace-toggle ${status}`;
  button.innerHTML = appIcon("git");
  button.setAttribute("aria-label", status === "nogit" ? "No Git repository detected" : "Show or hide Git drawer");
  button.title = status === "nogit" ? "No Git repository detected" : "Show or hide Git drawer";
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

async function ensureGitUiLoaded() {
  if (window.HerdrGitUi) return;
  await loadDesktopFeature("/assets/desktop/directory-picker.js");
  await loadDesktopFeature("/assets/desktop/git-ui.js");
}

async function ensureFileBrowserLoaded() {
  if (window.HerdrFileBrowser) return;
  await loadDesktopFeature("/assets/desktop/file-browser.js");
}

async function openWorkspaceGitUi(id) {
  if (!gitUiEnabled()) return;
  const workspace = state.workspaces.find((w) => w.workspace_id === id);
  if (!workspace) return;
  try {
    await ensureGitUiLoaded();
  } catch (error) {
    alert(error.message || String(error));
    return;
  }
  if (window.HerdrFileBrowser) window.HerdrFileBrowser.hide();
  window.HerdrGitUi.open(workspace);
  render();
}

function syncFileWorkspaceToggle() {
  const button = el("fileWorkspaceToggle");
  if (!button) {
    setupSessionChrome();
    return;
  }
  const workspace = state.workspaces.find((w) => w.workspace_id === state.ws);
  const hasPath = !!workspacePath(workspace);
  button.disabled = !hasPath;
  button.title = hasPath ? "Show file browser" : "No workspace path available";
  syncShellModeButtons();
}

async function openWorkspaceFileBrowser(id) {
  const workspace = state.workspaces.find((w) => w.workspace_id === id);
  if (!workspace) return;
  try {
    await ensureFileBrowserLoaded();
  } catch (error) {
    alert(error.message || String(error));
    return;
  }
  if (window.HerdrGitUi) window.HerdrGitUi.hide();
  window.HerdrFileBrowser.open(workspace).catch((error) => alert(error.message || String(error)));
  render();
}
function runWorkspaceContextAction(action, button) {
  const w = selectedWorkspace();
  if (!w) return;
  if (action === "create-worktree") openWorktreeCreateModal(w.workspace_id);
  else if (action === "open-worktrees") openWorktreesForRepo(button.dataset.key || "");
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
    const key = worktreeGroupKey(w) || `workspace:${w.workspace_id}`;
    if (!idsByKey.has(key) || (w.worktree && !w.worktree.is_linked_worktree))
      idsByKey.set(key, w.workspace_id);
  }
  return [...idsByKey.values()];
}
function worktreeGroupKey(w) {
  return (
    (w &&
      w.worktree &&
      (w.worktree.repo_key || w.worktree.repo_root || w.worktree.repo_name)) ||
    ""
  );
}
function worktreeRowGroupKey(w) {
  return (
    (w && (w.source_repo_key || w.source_repo_root || w.source_repo_name)) || ""
  );
}
function findWorktreeParent(group) {
  return (
    state.workspaces.find(
      (w) =>
        w.worktree &&
        !w.worktree.is_linked_worktree &&
        worktreeGroupKey(w) ===
          (group.children[0] ? worktreeGroupKey(group.children[0]) : ""),
    ) ||
    state.workspaces.find((w) => !w.worktree && w.label === group.label) ||
    null
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
  if (options.agentSortMode !== "off")
    list.sort(agentAttentionCompare);
  return list
    .map((a) => renderAgentRow(a, wsById, tabById, tabCountsByWorkspace))
    .join("");
}
function agentAttentionCompare(a, b) {
  const aRank = agentAttentionRank(a),
    bRank = agentAttentionRank(b);
  return aRank - bRank;
}
function agentAttentionRank(a) {
  const status = statusClass(a.agent_status);
  if (status === "blocked") return 0;
  if (options.agentSortMode === "attention_inverted") {
    if (isWorkingDismissed(a)) return 2;
    return { working: 1, unknown: 3, done: 4, idle: 5 }[status] ?? 3;
  }
  if (isWorkingDismissed(a)) return 4;
  return { idle: 1, done: 2, unknown: 3, working: 5 }[status] ?? 3;
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
  return count > 1 || t.label ? tabTitle(t) : "";
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
  const key =
    w.worktree.repo_key || w.worktree.repo_root || w.worktree.repo_name;
  const match =
    Object.values(wsById).find(
      (x) =>
        x.workspace_id !== w.workspace_id &&
        x.worktree &&
        (x.worktree.repo_key ||
          x.worktree.repo_root ||
          x.worktree.repo_name) === key &&
        !x.worktree.is_linked_worktree,
    ) ||
    Object.values(wsById).find(
      (x) =>
        x.workspace_id !== w.workspace_id &&
        !x.worktree &&
        x.label === w.worktree.repo_name,
    );
  return match ? match.label : w.worktree.repo_name;
}
