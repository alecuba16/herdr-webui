let searchPaletteState = createSearchPaletteState();

// The embedded search panel reuses the palette section renderers, which read
// the `searchPaletteState` lexical binding above. A window property swap
// cannot reach that binding, so the panel swaps it through here: pass a new
// state to install it for a render, pass nothing to read, and pass the
// previous value to restore.
window.resolveSearchPaletteState = function resolveSearchPaletteState(next) {
  const previous = searchPaletteState;
  if (next !== undefined) searchPaletteState = next;
  return previous;
};

function createSearchPaletteState() {
  return {
    query: "",
    selectedIndex: 0,
    results: [],
    requestSeq: 0,
    timer: null,
    pathKind: "file",
    // Per-query search mode toggles, shared by path and content search.
    // They default from the stored settings and flip live through the head
    // toggles (aA / .*), without rewriting the saved options.
    matchCase: searchSettings().matchCase === true,
    regex: searchSettings().regex === true,
    recent: [],
    recentLoaded: false,
    pathEntries: [],
    pathGitStatus: null,
    pathOffset: 0,
    pathDone: true,
    pathLoading: false,
    pathError: "",
    content: window.HerdrWorkspaceSearch ? window.HerdrWorkspaceSearch.createContentState() : { query: "", files: [], expanded: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0 },
    sectionsExpanded: { actions: true, workspaces: true, files: true, content: true },
  };
}

function openSearchPalette() {
  try {
    if ((window.HerdrOptions ? window.HerdrOptions.read() : {}).headerSearchEnabled === false) return false;
  } catch (_) {}
  const modal = el("searchPalette"),
    input = el("searchPaletteInput");
  if (!modal || !input) return false;
  const previousScope = searchPaletteState.pathKind || "file";
  searchPaletteState = createSearchPaletteState();
  searchPaletteState.pathKind = previousScope;
  input.value = "";
  modal.style.display = "grid";
  renderSearchPalette();
  loadRecentWorkspaces();
  setTimeout(() => input.focus(), 0);
  return true;
}

function closeSearchPalette() {
  const modal = el("searchPalette");
  if (modal) {
    modal.style.display = "none";
    if (window.HerdrModalDrag) window.HerdrModalDrag.resetByBackdrop(modal);
  }
  if (searchPaletteState.timer) clearTimeout(searchPaletteState.timer);
  searchPaletteState = createSearchPaletteState();
}

// Field-extraction helpers live in shared/workspace_search.js
// (HerdrWorkspaceSearch); the local copies were byte-level duplicates.
// textValue keeps desktop's richer fallbacks (path/display/label/name)
// via the shared core helper.
const sharedSearch = window.HerdrWorkspaceSearch || {};
const textParts = sharedSearch.textParts
  ? sharedSearch.textParts
  : (...values) => {
      const out = [];
      for (const value of values) {
        if (Array.isArray(value)) out.push(...textParts(...value));
        else if (value && typeof value === "object") out.push(...textParts(...Object.values(value)));
        else {
          const text = textValue(value);
          if (text) out.push(text);
        }
      }
      return out;
    };
const uniqueTextParts = sharedSearch.uniqueTextParts
  ? sharedSearch.uniqueTextParts
  : (...values) => {
      const seen = new Set();
      return textParts(...values).filter((value) => {
        const key = value.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };

function workspaceRepoFields(w) {
  const wt = w && w.worktree;
  return uniqueTextParts(
    wt && wt.repo_name,
    wt && wt.repo_key,
    wt && wt.repo_root,
    wt && wt.source_repo_name,
    wt && wt.source_repo_key,
    wt && wt.source_repo_root,
  );
}

function workspaceTagFields(w) {
  const wt = w && w.worktree;
  return uniqueTextParts(
    w && w.tags,
    w && w.tag,
    w && w.labels,
    wt && wt.tags,
    wt && wt.tag,
    wt && wt.labels,
  );
}

function workspaceBranchFields(w) {
  const wt = w && w.worktree;
  const path = wt && (wt.checkout_path || wt.path);
  const linked = (state.worktrees || []).filter((item) =>
    item && (item.open_workspace_id === w.workspace_id || (path && item.path === path))
  );
  return uniqueTextParts(
    workspaceBranch(w),
    w && w.branch,
    state.workspaceBranches && state.workspaceBranches[w.workspace_id],
    wt && wt.branch,
    wt && wt.base_branch,
    linked.map((item) => [item.branch, item.base_branch, item.upstream_branch]),
  );
}

function workspacePanelFields(wsId) {
  return uniqueTextParts(
    state.allTabs.concat(state.tabs)
      .filter((tab) => tab && tab.workspace_id === wsId)
      .map((tab) => [tabTitle(tab), tab.label, tab.title, tab.name, tab.tab_id])
  );
}

function targetForWorkspace(wsId) {
  const tab =
    state.tabs.find((t) => t.workspace_id === wsId) ||
    state.allTabs.find((t) => t.workspace_id === wsId) ||
    null;
  const pane = tab && state.panes.find((p) => p.tab_id === tab.tab_id);
  return { ws: wsId, tab: tab && tab.tab_id, pane: pane && pane.pane_id };
}

// The palette's file and content search root: the default folder from
// settings, falling back to ~. Workspace scoping belongs to the sidebar
// panel (search_panel.js).
function paletteSearchRoot() {
  return defaultFolderPath() || "~";
}

function paletteSearchWorkspace() {
  if (typeof defaultFolderWorkspace === "function") {
    const workspace = defaultFolderWorkspace();
    if (workspace) return workspace;
  }
  const cwd = paletteSearchRoot();
  if (!cwd) return null;
  return { workspace_id: "__default_folder__", label: "Default folder", cwd, default_folder: true };
}

function currentSearchWorkspace() {
  return state.workspaces.find((workspace) => workspace.workspace_id === state.ws) || null;
}

function pushSearchCandidate(list, candidate) {
  if (!candidate || !candidate.ws) return;
  candidate.type = candidate.type || "target";
  candidate.searchText = textParts(
    candidate.kind,
    candidate.title,
    candidate.subtitle,
    candidate.extra,
  )
    .join(" ")
    .toLowerCase();
  list.push(candidate);
}

function searchCandidates(query) {
  const helper = window.HerdrWorkspaceSearch;
  if (helper && helper.settings && helper.settings().searchWorkspacesEnabled === false) return [];
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [];
  const candidates = [],
    wsById = Object.fromEntries(
      state.workspaces.map((w) => [w.workspace_id, w]),
    ),
    tabById = Object.fromEntries(
      state.allTabs.concat(state.tabs).map((t) => [t.tab_id, t]),
    ),
    tabCountsByWorkspace = new Map();
  for (const tab of state.allTabs)
    tabCountsByWorkspace.set(
      tab.workspace_id,
      (tabCountsByWorkspace.get(tab.workspace_id) || 0) + 1,
    );
  for (const w of state.workspaces) {
    const target = targetForWorkspace(w.workspace_id),
      branches = workspaceBranchFields(w),
      branch = branches[0] || "",
      repos = workspaceRepoFields(w),
      repo = repos[0] || "",
      tags = workspaceTagFields(w),
      panels = workspacePanelFields(w.workspace_id),
      label = isLinkedWorktree(w) ? worktreeCustomLabel(w) : w.label;
    pushSearchCandidate(candidates, {
      kind: isLinkedWorktree(w) ? "worktree" : "workspace",
      icon: isLinkedWorktree(w) ? "wt" : "ws",
      title: isLinkedWorktree(w) ? workspaceDisplayTitle(w) : w.label,
      subtitle: textParts(
        repo,
        label && isLinkedWorktree(w) ? `label ${label}` : "",
        branch && !isLinkedWorktree(w) ? `branch ${branch}` : "",
      ).join(" · "),
      extra: textParts(
        w.workspace_id,
        repos,
        tags,
        branches,
        panels,
        w.worktree && w.worktree.checkout_path,
      ).join(" "),
      ...target,
    });
  }
  for (const t of state.tabs) {
    const pane = state.panes.find((p) => p.tab_id === t.tab_id),
      w = wsById[t.workspace_id];
    pushSearchCandidate(candidates, {
      kind: "panel",
      icon: "pn",
      title: tabTitle(t),
      subtitle: textParts(
        w && workspaceDisplayTitle(w),
        w && w.worktree && w.worktree.repo_name,
      ).join(" · "),
      extra: textParts(t.tab_id, t.workspace_id).join(" "),
      ws: t.workspace_id,
      tab: t.tab_id,
      pane: pane && pane.pane_id,
    });
  }
  for (const agent of state.agents) {
    const w = wsById[agent.workspace_id],
      tab = tabById[agent.tab_id],
      label =
        agent.name ||
        agent.display_agent ||
        agent.agent ||
        agent.terminal_id ||
        "agent";
    pushSearchCandidate(candidates, {
      kind: "agent",
      icon: "ag",
      title: label,
      subtitle: textParts(
        statusClass(agent.agent_status),
        w && parentWorkspaceName(w, wsById),
        w && (w.worktree ? agentWorktreeDisplayName(w) : w.label),
        agentTabLabel(agent.workspace_id, tab, tabCountsByWorkspace),
      ).join(" · "),
      extra: textParts(
        agent.terminal_id,
        agent.workspace_id,
        agent.tab_id,
        agent.pane_id,
      ).join(" "),
      ws: agent.workspace_id,
      tab: agent.tab_id,
      pane: agent.pane_id,
    });
  }
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: searchScore(candidate.searchText, needle),
    }))
    .filter((candidate) => candidate.score >= 0)
    .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
    .slice(0, 12);
}

function searchScore(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) return -1;
  if (text === needle) return 0;
  if (text.startsWith(needle)) return 1;
  return 10 + index;
}

function searchActionCandidates(query) {
  return window.HerdrActionRegistry.candidates(query, {
    platform: "desktop",
    hasWorkspace: !!currentSearchWorkspace(),
  });
}

function searchActionHints(actions) {
  if (!actions.length || !window.HerdrActionRegistry || !window.HerdrActionRegistry.kbdHint) return "";
  const withHint = actions.filter((action) => window.HerdrActionRegistry.hasHint(action)).slice(0, 4);
  if (!withHint.length) return "";
  return `<div class="search-help">Type <span class="kbd">&gt;</span> to browse actions only. Shortcuts: ${withHint.map((action) => window.HerdrActionRegistry.kbdHint(action)).join(" ")}</div>`;
}

function actionsOnlyQuery(query) {
  return String(query || "").trimStart().startsWith(">");
}

function searchSettings() {
  return window.HerdrWorkspaceSearch && window.HerdrWorkspaceSearch.settings
    ? window.HerdrWorkspaceSearch.settings()
    : { searchSectionOrder: ["workspaces", "files", "content"], searchWorkspacesEnabled: true, searchFilesEnabled: true, searchFoldersEnabled: true, searchContentEnabled: true };
}

function pathSearchAvailable(opts = searchSettings()) {
  const helper = window.HerdrWorkspaceSearch;
  return helper && helper.pathSearchAvailable ? helper.pathSearchAvailable(opts) : opts.searchFilesEnabled !== false || opts.searchFoldersEnabled !== false;
}

function normalizePalettePathKind(opts = searchSettings()) {
  const helper = window.HerdrWorkspaceSearch;
  searchPaletteState.pathKind = helper && helper.normalizePathKind
    ? helper.normalizePathKind(searchPaletteState.pathKind, opts)
    : searchPaletteState.pathKind === "dir" && opts.searchFoldersEnabled === false && opts.searchFilesEnabled !== false
      ? "file"
      : searchPaletteState.pathKind !== "dir" && opts.searchFilesEnabled === false && opts.searchFoldersEnabled !== false
        ? "dir"
        : searchPaletteState.pathKind === "dir" ? "dir" : "file";
}

function scheduleSearch() {
  const input = el("searchPaletteInput");
  const query = input ? input.value : "";
  searchPaletteState.query = query;
  searchPaletteState.selectedIndex = 0;
  renderSearchPalette();
  if (searchPaletteState.timer) clearTimeout(searchPaletteState.timer);
  searchPaletteState.timer = setTimeout(() => runWorkspaceSearch(false), 180);
}

async function runWorkspaceSearch(append = false) {
  const helper = window.HerdrWorkspaceSearch;
  if (!helper) return;
  const seq = ++searchPaletteState.requestSeq;
  const query = String(searchPaletteState.query || "").trim();
  // `>`-prefixed queries browse actions only; skip workspace file/content search.
  if (actionsOnlyQuery(query)) {
    searchPaletteState.pathEntries = [];
    searchPaletteState.pathGitStatus = null;
    searchPaletteState.pathDone = true;
    searchPaletteState.pathLoading = false;
    searchPaletteState.pathError = "";
    helper.resetContentState(searchPaletteState.content, "");
    renderSearchPalette();
    return;
  }
  // The palette's file and content search root is always the default
  // folder (settings) with ~ as the last resort. It is the global
  // action-triggered surface; the workspace-scoped root belongs to the
  // search panel (see search_panel.js).
  const workspace = paletteSearchWorkspace();
  const cwd = helper.workspaceCwd(workspace);
  const opts = helper.settings();
  normalizePalettePathKind(opts);
  if (!query || !cwd) {
    searchPaletteState.pathEntries = [];
    searchPaletteState.pathGitStatus = null;
    searchPaletteState.pathDone = true;
    searchPaletteState.pathLoading = false;
    helper.resetContentState(searchPaletteState.content, query);
    renderSearchPalette();
    return;
  }
  const tasks = [];
  if (pathSearchAvailable(opts)) tasks.push(runPathSearch(seq, query, cwd, append && searchPaletteState.pathLoading === false));
  else {
    searchPaletteState.pathEntries = [];
    searchPaletteState.pathGitStatus = null;
    searchPaletteState.pathDone = true;
    searchPaletteState.pathLoading = false;
    searchPaletteState.pathError = "";
  }
  if (opts.searchContentEnabled !== false) tasks.push(runContentSearchForPalette(seq, query, cwd, append && searchPaletteState.content.loading === false));
  else helper.resetContentState(searchPaletteState.content, query);
  await Promise.allSettled(tasks);
  if (seq === searchPaletteState.requestSeq) renderSearchPalette();
}

async function runPathSearch(seq, query, cwd, append) {
  const helper = window.HerdrWorkspaceSearch;
  const offset = append ? searchPaletteState.pathOffset : 0;
  searchPaletteState.pathLoading = true;
  searchPaletteState.pathError = "";
  renderSearchPalette();
  try {
    const data = await helper.searchPaths({ cwd, query, kind: searchPaletteState.pathKind, offset, matchCase: searchPaletteState.matchCase, regex: searchPaletteState.regex });
    if (seq !== searchPaletteState.requestSeq) return;
    const entries = data.entries || [];
    searchPaletteState.pathEntries = append ? searchPaletteState.pathEntries.concat(entries) : entries;
    searchPaletteState.pathGitStatus = data.git_status || null;
    searchPaletteState.pathOffset = offset + entries.length;
    // Offset-only pagination: the backend re-walks and re-ranks the same
    // match set for every page, so truncated=false is the natural end. One
    // guard stays: a page with zero entries cannot advance the offset, so
    // paging on would replay the same empty page forever (a walk past the
    // collect cap with no new matches). No progress means done.
    searchPaletteState.pathDone = !data.truncated || entries.length === 0;
    searchPaletteState.pathError = "";
  } catch (error) {
    if (seq !== searchPaletteState.requestSeq) return;
    searchPaletteState.pathError = error.message || String(error);
    searchPaletteState.pathDone = true;
  } finally {
    if (seq === searchPaletteState.requestSeq) searchPaletteState.pathLoading = false;
  }
}

function renderSearchPalettePreservingScroll() {
  const container = el("searchPaletteResults");
  const top = container ? container.scrollTop : 0;
  renderSearchPalette();
  const next = el("searchPaletteResults");
  if (next) next.scrollTop = top;
}

async function runContentSearchForPalette(seq, query, cwd, append, options = {}) {
  const helper = window.HerdrWorkspaceSearch;
  const opts = helper.settings();
  searchPaletteState.content.query = query;
  if (query.length < opts.contentMinChars) {
    helper.resetContentState(searchPaletteState.content, query);
    searchPaletteState.content.error = query ? `Type at least ${opts.contentMinChars} characters to search contents.` : "";
    return;
  }
  const offset = append ? searchPaletteState.content.offset : 0;
  searchPaletteState.content.loading = true;
  searchPaletteState.content.error = "";
  (options.preserveScroll ? renderSearchPalettePreservingScroll : renderSearchPalette)();
  try {
    const data = await helper.searchContent({ cwd, query, offset, contextLines: searchPaletteState.content.contextLines, matchCase: searchPaletteState.matchCase, regex: searchPaletteState.regex });
    if (seq !== searchPaletteState.requestSeq) return;
    helper.applyContentResults(searchPaletteState.content, data, append, { preserveExpanded: !!options.preserveExpanded });
  } catch (error) {
    if (seq !== searchPaletteState.requestSeq) return;
    searchPaletteState.content.error = error.message || String(error);
    searchPaletteState.content.done = true;
  } finally {
    if (seq === searchPaletteState.requestSeq) searchPaletteState.content.loading = false;
  }
}

function activeWorkspaceLabel() {
  // Section header shows where this surface searches. The palette (and the
  // panel, which borrows this renderer) both reach here while
  // searchPaletteState points at the calling surface's state, so tag the
  // panel state with its own scope: the panel searches the selected
  // workspace, the palette the default folder.
  if (searchPaletteState.panelScope && typeof currentSearchWorkspace === "function") {
    const workspace = currentSearchWorkspace();
    return workspace ? workspaceDisplayTitle(workspace) : "No workspace selected";
  }
  const root = paletteSearchRoot();
  return root ? `Searching ${root}` : "No default folder";
}

async function loadRecentWorkspaces() {
  if (!window.HerdrActionRegistry || !window.HerdrActionRegistry.loadRecent) return;
  const recent = await window.HerdrActionRegistry.loadRecent();
  if (recent !== searchPaletteState.recent || !searchPaletteState.recentLoaded) {
    searchPaletteState.recent = recent;
    searchPaletteState.recentLoaded = true;
    if (el("searchPalette") && el("searchPalette").style.display !== "none") renderSearchPalette();
  }
}

function recentWorkspaceIsOpen(path) {
  const target = String(path || "");
  if (!target) return false;
  const openPaths = (state.workspaces || []).map((workspace) => workspacePath(workspace));
  const openWorktrees = (state.worktrees || [])
    .filter((worktree) => worktree && worktree.open_workspace_id && worktree.path)
    .map((worktree) => worktree.path);
  return openPaths.concat(openWorktrees).some((candidate) => samePath(candidate, target));
}

function recentWorkspaceCandidates(recent) {
  const needle = String(searchPaletteState.query || "").trim().toLowerCase();
  return (recent || [])
    .map((item) => {
      const title = item.label || (item.path || "").split("/").filter(Boolean).pop() || item.path || "";
      const subtitle = [item.kind === "worktree" ? "worktree" : "workspace", item.branch, item.path].filter(Boolean).join(" · ");
      return {
        type: "recent",
        icon: item.kind === "worktree" ? "wt" : "ws",
        title,
        subtitle,
        path: item.path,
        label: item.label,
        isOpen: recentWorkspaceIsOpen(item.path),
        searchText: `${title} ${subtitle}`.toLowerCase(),
      };
    })
    .filter((item) => !needle || item.searchText.includes(needle))
    .slice(0, 8);
}

function buildSearchSelectionRows(actions, targets, order, opts) {
  const rows = [];
  if (searchPaletteState.sectionsExpanded.actions !== false) rows.push(...actions);
  const recent = recentWorkspaceCandidates(searchPaletteState.recent);
  if (searchPaletteState.sectionsExpanded.recent !== false) rows.push(...recent);
  if (!order || !order.length) order = ["workspaces", "files", "content"];
  for (const section of order) {
    if (section === "workspaces" && opts.searchWorkspacesEnabled !== false && searchPaletteState.sectionsExpanded.workspaces !== false) rows.push(...targets);
    if (section === "files" && pathSearchAvailable(opts) && searchPaletteState.sectionsExpanded.files !== false) {
      for (const entry of searchPaletteState.pathEntries || []) {
        const kind = entry.kind === "dir" ? "dir" : "file";
        if (kind !== searchPaletteState.pathKind) continue;
        rows.push({ type: "path", kind, path: entry.path, title: entry.name || entry.path });
      }
    }
    if (section === "content" && opts.searchContentEnabled !== false && searchPaletteState.sectionsExpanded.content !== false) {
      for (const item of (window.HerdrWorkspaceSearch ? window.HerdrWorkspaceSearch.flattenContentMatches(searchPaletteState.content.files) : [])) {
        rows.push({ type: "content", file: item.file, match: item.match, title: item.file.path });
      }
    }
  }
  return rows;
}

function selectedSearchRow() {
  return searchPaletteState.results[searchPaletteState.selectedIndex] || null;
}

function expandSelectedSearchContent(direction) {
  const result = selectedSearchRow();
  if (!result || result.type !== "content" || !result.file || !result.match) return false;
  HerdrSearchPaletteContent.expandSnippet(result.file.path, result.match.id, direction);
  return true;
}

function syncSearchModeToggles() {
  // The palette and the panel share the same look: a pressed toggle lights
  // up through .mini.active. aria-pressed mirrors the state for screen
  // readers. The palette owns its own buttons; the panel renders inline.
  const caseToggle = el("searchPaletteCaseToggle");
  const regexToggle = el("searchPaletteRegexToggle");
  if (caseToggle) {
    caseToggle.classList.toggle("active", searchPaletteState.matchCase === true);
    caseToggle.setAttribute("aria-pressed", searchPaletteState.matchCase === true ? "true" : "false");
  }
  if (regexToggle) {
    regexToggle.classList.toggle("active", searchPaletteState.regex === true);
    regexToggle.setAttribute("aria-pressed", searchPaletteState.regex === true ? "true" : "false");
  }
}

function renderSearchPalette() {
  const query = searchPaletteState.query || "";
  const actionsOnly = actionsOnlyQuery(query);
  const opts = searchSettings();
  normalizePalettePathKind(opts);
  syncSearchModeToggles();
  const order = opts.searchSectionOrder || ["workspaces", "files", "content"];
  const actions = searchActionCandidates(query);
  const targets = actionsOnly ? [] : searchCandidates(query);
  searchPaletteState.results = buildSearchSelectionRows(actions, targets, actionsOnly ? [] : order, opts);
  if (searchPaletteState.selectedIndex >= searchPaletteState.results.length)
    searchPaletteState.selectedIndex = Math.max(0, searchPaletteState.results.length - 1);
  if (searchResultDisabled(searchPaletteState.results[searchPaletteState.selectedIndex])) {
    const next = selectableSearchResults()[0];
    searchPaletteState.selectedIndex = next ? searchPaletteState.results.indexOf(next) : 0;
  }
  const container = el("searchPaletteResults");
  if (!container) return;
  const sections = {
    actions: renderActionSection(actions, { actionsOnly }),
    workspaces: actionsOnly || opts.searchWorkspacesEnabled === false || !query.trim() ? "" : renderTargetSection(targets),
    files: actionsOnly || !pathSearchAvailable(opts) ? "" : renderWorkspacePathSection(opts),
    content: actionsOnly || opts.searchContentEnabled === false ? "" : renderWorkspaceContentSection(),
  };
  const recent = actionsOnly ? [] : recentWorkspaceCandidates(searchPaletteState.recent);
  container.innerHTML = sections.actions + searchActionHints(actions) + (actionsOnly ? "" : renderRecentSection(recent)) + (actionsOnly ? "" : order.map((key) => sections[key] || "").join(""));
}

function renderRecentSection(recent, callbacks = {}) {
  const api = callbacks.panel || "HerdrSearchPalette";
  const expanded = searchPaletteState.sectionsExpanded.recent !== false;
  // While the recent-workspaces fetch (/api/recent-workspaces) is still in
  // flight (palette just opened), show a skeleton with the same row shape
  // instead of no section at all.
  if (!recent.length && !searchPaletteState.recentLoaded && window.HerdrSkeleton)
    return `<section class="search-section"><div class="search-section-head"><strong><span class="herdr-tree-icon herdr-tree-icon-chevron-down" aria-hidden="true"></span>Recent workspaces</strong><span>…</span></div>${window.HerdrSkeleton.workspaces(2)}</section>`;
  if (!recent.length) return "";
  const rows = recent.map((result) => renderRecentRowResult(result, undefined, callbacks)).join("");
  const clear = `<button class="git-ui-btn" onclick="${api}.clearRecent(event)" title="Clear recent workspaces">Clear</button>`;
  return `<section class="search-section"><div class="search-section-head"><button class="search-section-toggle search-section-head-toggle" onclick="${api}.toggleSection('recent')" aria-expanded="${expanded ? "true" : "false"}"><strong><span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>Recent workspaces</strong><span>${recent.length}</span></button>${clear}</div>${expanded ? rows : ""}</section>`;
}

function renderActionSection(actions, opts = {}, callbacks = {}) {
  const api = callbacks.panel || "HerdrSearchPalette";
  const expanded = searchPaletteState.sectionsExpanded.actions !== false;
  if (!actions.length && (searchPaletteState.query.trim() || opts.actionsOnly))
    return opts.actionsOnly
      ? '<section class="search-section"><div class="search-empty">No matching actions.</div></section>'
      : "";
  const body = actions.length
    ? actions.map((result) => renderSearchRowResult(result, callbacks)).join("")
    : '<div class="search-empty">No matching actions.</div>';
  return `<section class="search-section"><button class="search-section-head search-section-toggle" onclick="${api}.toggleSection('actions')" aria-expanded="${expanded ? "true" : "false"}"><strong><span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>Actions</strong><span>${actions.length}</span></button>${expanded ? body : ""}</section>`;
}

function renderTargetSection(targets, callbacks = {}) {
  const api = callbacks.panel || "HerdrSearchPalette";
  const expanded = searchPaletteState.sectionsExpanded.workspaces !== false;
  const body = targets.length
    ? targets.map((result) => renderSearchRowResult(result, callbacks)).join("")
    : '<div class="search-empty">No matching workspace, worktree, panel, or agent.</div>';
  return `<section class="search-section"><button class="search-section-head search-section-toggle" onclick="${api}.toggleSection('workspaces')" aria-expanded="${expanded ? "true" : "false"}"><strong><span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>Workspaces, worktrees, panels</strong><span>${targets.length}</span></button>${expanded ? body : ""}</section>`;
}

function searchResultKey(result) {
  if (!result) return "";
  if (result.type === "action") return `action:${result.action}`;
  if (result.type === "path") return `path:${result.kind}:${result.path}`;
  if (result.type === "content") return `content:${result.file && result.file.path}:${result.match && result.match.id}`;
  if (result.type === "recent") return `recent:${result.path}`;
  return `target:${result.ws}:${result.tab}:${result.pane}`;
}

function renderSearchRowResult(result) {
  const callbacks = arguments[1] || {};
  const key = searchResultKey(result);
  const index = searchPaletteState.results.findIndex((row) => row === result || searchResultKey(row) === key);
  return renderTargetResult(result, index, result.type === "action" && window.HerdrActionRegistry && window.HerdrActionRegistry.kbdHint ? window.HerdrActionRegistry.kbdHint(result) : "", callbacks);
}

function renderRecentRowResult(result, index, callbacks = {}) {
  if (!result.path) return renderTargetResult(result, index, "", callbacks);
  const key = searchResultKey(result);
  const absoluteIndex = searchPaletteState.results.findIndex((row) => row === result || searchResultKey(row) === key);
  const api = callbacks.panel || "HerdrSearchPalette";
  const remove = `<button class="search-result-remove" type="button" title="Remove this recent workspace" aria-label="Remove ${escapeAttr(result.title)} from recent workspaces" onclick="${api}.removeRecent(event, '${escapeAttr(result.path)}')"><span class="app-icon app-icon-trash" aria-hidden="true"></span></button>`;
  return renderTargetResult(result, Number.isInteger(index) ? index : absoluteIndex, remove, callbacks);
}

function renderTargetResult(result, index, trailingHtml = "", callbacks = {}) {
  const disabled = result.type === "recent" && result.isOpen;
  const cls = `search-result${index === searchPaletteState.selectedIndex ? " active" : ""}${disabled ? " search-result-disabled" : ""}`;
  const title = disabled ? `${escapeHtml(result.title)} <span class="search-result-open-hint">(already open)</span>` : escapeHtml(result.title);
  const choose = callbacks.choose || "chooseSearchResult";
  return `<div class="${cls}" role="option"${disabled ? ' aria-disabled="true"' : ""}${disabled ? "" : ` onclick="${choose}(${index})"`}><span class="search-result-icon">${escapeHtml(result.icon)}</span><div class="search-result-body"><div class="search-result-title">${title}</div><div class="search-result-subtitle">${escapeHtml(result.subtitle || result.kind)}</div></div>${trailingHtml}</div>`;
}

function renderWorkspacePathSection(opts = searchSettings(), callbacks = {}) {
  const helper = window.HerdrWorkspaceSearch;
  if (!helper) return "";
  normalizePalettePathKind(opts);
  const selected = selectedSearchRow();
  const selectedPath = selected && selected.type === "path" ? selected.path : "";
  const query = String(searchPaletteState.query || "").trim();
  const expanded = searchPaletteState.sectionsExpanded.files !== false;
  const kind = searchPaletteState.pathKind;
  const noun = kind === "dir" ? "folders" : "files";
  const tree = query
    ? searchPaletteState.pathEntries.length
      ? helper.renderPathTree(searchPaletteState.pathEntries, { query, kind, gitStatus: searchPaletteState.pathGitStatus, selectedPath, callback: callbacks.tree || "HerdrSearchPaletteTree" })
      : `<div class="search-empty">${searchPaletteState.pathLoading ? "Searching..." : `No ${noun} found.`}</div>`
    : `<div class="search-empty">${searchPaletteState.panelScope ? "Type to search files or folders in this workspace." : "Type to search files or folders in the default folder."}</div>`;
  const api = callbacks.panel || "HerdrSearchPalette";
  const more = query && !searchPaletteState.pathDone ? `<button class="git-ui-btn search-more" onclick="${api}.loadMorePaths()">Load more ${noun}</button>` : "";
  return `<section class="search-section search-path-section"><button class="search-section-head search-section-toggle" onclick="${api}.toggleSection('files')" aria-expanded="${expanded ? "true" : "false"}"><strong><span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>Files and folders</strong><span>${escapeHtml(activeWorkspaceLabel())}</span></button>${expanded ? `<div class="search-scope-tabs"><button class="git-ui-btn ${kind === "file" ? "active" : ""}" ${opts.searchFilesEnabled === false ? "disabled" : ""} onclick="${api}.setPathKind('file')">Files</button><button class="git-ui-btn ${kind === "dir" ? "active" : ""}" ${opts.searchFoldersEnabled === false ? "disabled" : ""} onclick="${api}.setPathKind('dir')">Folders</button></div>${searchPaletteState.pathError ? `<div class="file-browser-error">${escapeHtml(searchPaletteState.pathError)}</div>` : ""}${tree}${searchPaletteState.pathLoading ? '<div class="file-browser-searching">Searching...</div>' : ""}${more}` : ""}</section>`;
}

function renderWorkspaceContentSection(callbacks = {}) {
  const helper = window.HerdrWorkspaceSearch;
  if (!helper) return "";
  const opts = helper.settings();
  const query = String(searchPaletteState.query || "").trim();
  const expanded = searchPaletteState.sectionsExpanded.content !== false;
  const api = callbacks.panel || "HerdrSearchPalette";
  const body = !opts.searchContentEnabled
    ? '<div class="search-empty">File content search is disabled in Settings.</div>'
    : query.length < opts.contentMinChars
      ? `<div class="search-empty">Type at least ${opts.contentMinChars} characters to search file contents.</div>`
      : helper.renderContentPicker(searchPaletteState.content, { callback: callbacks.content || "HerdrSearchPaletteContent", idPrefix: callbacks.idPrefix || "searchPaletteContent", disableSnippetEditing: true });
  return `<section class="search-section search-content-section"><button class="search-section-head search-section-toggle" onclick="${api}.toggleSection('content')" aria-expanded="${expanded ? "true" : "false"}"><strong><span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>File content</strong><span>${Number(searchPaletteState.content.total_matches || 0)} matches</span></button>${expanded ? body : ""}</section>`;
}

function selectableSearchResults() {
  return searchPaletteState.results.filter((row) => !searchResultDisabled(row));
}

function searchResultDisabled(result) {
  return !!result && result.type === "recent" && !!result.isOpen;
}

function moveSearchSelection(delta) {
  const selectable = selectableSearchResults();
  if (!selectable.length) return;
  const current = searchResultDisabled(searchPaletteState.results[searchPaletteState.selectedIndex])
    ? null
    : searchPaletteState.results[searchPaletteState.selectedIndex];
  let position = current ? selectable.indexOf(current) : -1;
  if (position === -1) position = delta > 0 ? -1 : 0;
  const next = selectable[(position + delta + selectable.length) % selectable.length];
  searchPaletteState.selectedIndex = searchPaletteState.results.indexOf(next);
  renderSearchPalette();
}

function chooseSearchResult(index = searchPaletteState.selectedIndex) {
  const result = searchPaletteState.results[index];
  if (!result || searchResultDisabled(result)) return;
  if (result.type === "path") {
    openWorkspaceSearchPath(result.path, result.kind);
    return;
  }
  if (result.type === "content") {
    openWorkspaceSearchContent(result.file, result.match);
    return;
  }
  if (result.type === "action") {
    runSearchAction(result.action);
    return;
  }
  if (result.type === "recent") {
    openRecentWorkspace(result.path, result.label);
    return;
  }
  closeSearchPalette();
  go(result.ws, result.tab, result.pane);
}

async function openRecentWorkspace(path, label) {
  closeSearchPalette();
  if (!path) return;
  showBlocking("Opening workspace...");
  try {
    const r = await api("/api/recent-workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, label, open_terminal: workspaceOpenTerminalFlag() }),
    });
    if (window.HerdrActionRegistry && window.HerdrActionRegistry.invalidateRecent) window.HerdrActionRegistry.invalidateRecent();
    const result = (r && r.result) || {};
    // worktree.open returns the workspace plus its focused tab and root pane;
    // navigating with all three lands directly on a live terminal panel
    // instead of leaving the selection unresolvable until the next refresh.
    go(
      result.workspace && result.workspace.workspace_id,
      result.tab && result.tab.tab_id,
      result.root_pane && result.root_pane.pane_id,
    );
  } catch (error) {
    alert(error.message || String(error));
  } finally {
    hideBlocking();
  }
}

function runSearchAction(action) {
  closeSearchPalette();
  // Palette rows mirror prefix actions; echo the matching chord so the
  // same learn-by-use toast covers palette-triggered actions.
  const hintAction = {
    "open-workspace": "newWorkspace",
    "discover-worktrees": "openWorktrees",
    "create-worktree": "createWorktree",
    settings: "settings",
    "toggle-sidebar": "sidebar",
  }[action];
  if (hintAction) showShortcutHintToast("webuiShortcuts", hintAction);
  if (action === "open-workspace" || action === "discover-worktrees") openWorktreeOpenModal(selectedWorkspaceRepoPath(), true);
  else if (action === "create-worktree") {
    if (state.ws) openWorktreeCreateModal(state.ws);
    else openWorktreeOpenModal(selectedWorkspaceRepoPath(), true);
  } else if (action === "sessions") showSessionManager();
  else if (action === "files") openWorkspaceFileBrowser(state.ws);
  else if (action === "git") openWorkspaceGitUi(state.ws);
  else if (action === "settings") showSettingsModal();
  else if (action === "toggle-sidebar") sidebarToggle && sidebarToggle.click();
  else if (action === "toggle-theme") {
    themeMode = themeMode === "auto" ? "dark" : themeMode === "dark" ? "light" : "auto";
    applyTheme();
    render();
  }
}

function searchPaletteKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearchPalette();
  } else if (e.altKey && (e.key === "1" || e.code === "Digit1")) {
    e.preventDefault();
    HerdrSearchPalette.toggleSection("workspaces");
  } else if (e.altKey && (e.key === "2" || e.code === "Digit2")) {
    e.preventDefault();
    HerdrSearchPalette.toggleSection("files");
  } else if (e.altKey && (e.key === "3" || e.code === "Digit3")) {
    e.preventDefault();
    HerdrSearchPalette.toggleSection("content");
  } else if (e.altKey && e.key === "ArrowUp") {
    if (expandSelectedSearchContent("up")) e.preventDefault();
  } else if (e.altKey && e.key === "ArrowDown") {
    if (expandSelectedSearchContent("down")) e.preventDefault();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveSearchSelection(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveSearchSelection(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    chooseSearchResult();
  } else if (e.altKey && e.key && e.key.toLowerCase() === "f") {
    e.preventDefault();
    HerdrSearchPalette.setPathKind("file");
  } else if (e.altKey && e.key && e.key.toLowerCase() === "d") {
    e.preventDefault();
    HerdrSearchPalette.setPathKind("dir");
  } else if (e.altKey && e.key && e.key.toLowerCase() === "c") {
    e.preventDefault();
    HerdrSearchPalette.setSearchMode("matchCase");
  } else if (e.altKey && e.key && e.key.toLowerCase() === "r") {
    e.preventDefault();
    HerdrSearchPalette.setSearchMode("regex");
  }
}

async function openWorkspaceSearchPath(path, kind) {
  // Results come from the default-folder root (see runPaletteSearches),
  // so they open in the default folder even when no workspace is
  // selected.
  const workspace = paletteSearchWorkspace();
  closeSearchPalette();
  if (!workspace) return;
  try {
    if (typeof ensureFileBrowserLoaded === "function") await ensureFileBrowserLoaded();
    if (!window.HerdrFileBrowser || !window.HerdrFileBrowser.openAt) return;
    const isFile = kind !== "dir";
    await window.HerdrFileBrowser.openAt(workspace, path, { kind, preserveContext: isFile, mode: isFile ? "append" : undefined });
    if (typeof rememberWorkspaceShellMode === "function") rememberWorkspaceShellMode("files", workspace);
  } catch (error) {
    alert(error.message || String(error));
  }
}

async function openWorkspaceSearchContent(file, match) {
  const helper = window.HerdrWorkspaceSearch;
  // Same default-folder root as openWorkspaceSearchPath: content matches
  // from a default-folder search open in the default folder.
  const workspace = paletteSearchWorkspace();
  closeSearchPalette();
  if (!workspace || !file) return;
  try {
    if (typeof ensureFileBrowserLoaded === "function") await ensureFileBrowserLoaded();
    if (!window.HerdrFileBrowser || !window.HerdrFileBrowser.openAt) return;
    await window.HerdrFileBrowser.openAt(workspace, file.path, { kind: "file", preserveContext: true, mode: "append", highlight: helper.matchHighlight(match, searchPaletteState.query) });
    if (typeof rememberWorkspaceShellMode === "function") rememberWorkspaceShellMode("files", workspace);
  } catch (error) {
    alert(error.message || String(error));
  }
}

const HerdrSearchPalette = {
  async clearRecent(event) {
    if (event) event.stopPropagation();
    try {
      await api("/api/recent-workspaces/clear", { method: "POST" });
    } catch (_) {}
    searchPaletteState.recent = [];
    if (window.HerdrActionRegistry && window.HerdrActionRegistry.invalidateRecent) window.HerdrActionRegistry.invalidateRecent();
    renderSearchPalette();
  },
  async removeRecent(event, path) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (!path) return;
    try {
      await api("/api/recent-workspaces/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
    } catch (error) {
      alert(error.message || String(error));
      return;
    }
    searchPaletteState.recent = (searchPaletteState.recent || []).filter(
      (item) => (item && item.path) !== path,
    );
    if (window.HerdrActionRegistry && window.HerdrActionRegistry.invalidateRecent) window.HerdrActionRegistry.invalidateRecent();
    renderSearchPalette();
  },
  toggleSection(section) {
    if (!["actions", "recent", "workspaces", "files", "content"].includes(section)) return;
    searchPaletteState.sectionsExpanded[section] = searchPaletteState.sectionsExpanded[section] === false;
    renderSearchPalette();
  },
  setPathKind(kind) {
    const opts = searchSettings();
    if (kind === "dir" && opts.searchFoldersEnabled === false) return;
    if (kind !== "dir" && opts.searchFilesEnabled === false) return;
    searchPaletteState.pathKind = kind === "dir" ? "dir" : "file";
    searchPaletteState.pathEntries = [];
    searchPaletteState.pathOffset = 0;
    searchPaletteState.pathDone = true;
    renderSearchPalette();
    runWorkspaceSearch(false);
  },
  // Flip the per-query match mode (aA) or regex (.*). Both path and content
  // search rerun with the new mode; the saved settings stay untouched.
  setSearchMode(mode) {
    if (mode !== "matchCase" && mode !== "regex") return;
    searchPaletteState[mode] = !searchPaletteState[mode];
    searchPaletteState.pathEntries = [];
    searchPaletteState.pathOffset = 0;
    searchPaletteState.pathDone = true;
    renderSearchPalette();
    runWorkspaceSearch(false);
  },
  // Ignore repeat clicks while a page is in flight or the ranked list is
  // exhausted, or two appends can duplicate rows.
  loadMorePaths() {
    if (searchPaletteState.pathLoading || searchPaletteState.pathDone) return;
    runPathSearch(++searchPaletteState.requestSeq, searchPaletteState.query, window.HerdrWorkspaceSearch.workspaceCwd(paletteSearchWorkspace()), true).then(renderSearchPalette);
  },
  loadMoreContent() {
    if (searchPaletteState.content.loading || searchPaletteState.content.done) return;
    runContentSearchForPalette(++searchPaletteState.requestSeq, searchPaletteState.query, window.HerdrWorkspaceSearch.workspaceCwd(paletteSearchWorkspace()), true, { preserveScroll: true }).then(renderSearchPalettePreservingScroll);
  },
};

const HerdrSearchPaletteTree = {
  select(encodedPath) {
    const path = decodeURIComponent(encodedPath);
    const entry = (searchPaletteState.pathEntries || []).find((item) => item.path === path);
    openWorkspaceSearchPath(path, entry && entry.kind === "dir" ? "dir" : searchPaletteState.pathKind);
  },
};

const HerdrSearchPaletteContent = {
  toggleFile(encodedPath) {
    const path = decodeURIComponent(encodedPath);
    searchPaletteState.content.expanded[path] = !searchPaletteState.content.expanded[path];
    renderSearchPalette();
  },
  openFile(encodedPath) {
    const path = decodeURIComponent(encodedPath);
    openWorkspaceSearchPath(path, "file");
  },
  openMatch(encodedPath, encodedMatchId) {
    const path = decodeURIComponent(encodedPath);
    const file = (searchPaletteState.content.files || []).find((item) => item.path === path);
    const match = window.HerdrContentSearch && window.HerdrContentSearch.findMatch(file, decodeURIComponent(encodedMatchId));
    openWorkspaceSearchContent(file, match);
  },
  loadMore() { HerdrSearchPalette.loadMoreContent(); },
  async loadFile(encodedPath) {
    const helper = window.HerdrWorkspaceSearch;
    const workspace = paletteSearchWorkspace();
    const path = decodeURIComponent(encodedPath || "");
    const query = String(searchPaletteState.query || "").trim();
    const cwd = helper && helper.workspaceCwd(workspace);
    if (!helper || !path || !query || !cwd || !helper.searchContentFile) return;
    const seq = ++searchPaletteState.requestSeq;
    try {
      const data = await helper.searchContentFile({ cwd, file: path, query, contextLines: searchPaletteState.content.contextLines, matchesPerFile: 500, matchCase: searchPaletteState.matchCase, regex: searchPaletteState.regex });
      if (seq !== searchPaletteState.requestSeq || !data.file) return;
      const index = searchPaletteState.content.files.findIndex((file) => file.path === path);
      if (index >= 0) searchPaletteState.content.files[index] = data.file;
      searchPaletteState.content.expanded[path] = true;
      renderSearchPalettePreservingScroll();
    } catch (error) {
      if (seq !== searchPaletteState.requestSeq) return;
      searchPaletteState.content.error = error.message || String(error);
      renderSearchPalettePreservingScroll();
    }
  },
  expandSnippet(_path, _match, _direction) {
    const helper = window.HerdrWorkspaceSearch;
    if (!helper) return;
    const path = decodeURIComponent(_path || "");
    const opts = helper ? helper.settings() : { contextLines: 2 };
    const current = Number(searchPaletteState.content.contextLines ?? opts.contextLines ?? 2);
    searchPaletteState.content.contextLines = window.HerdrLineContext && window.HerdrLineContext.nextContextSize
      ? window.HerdrLineContext.nextContextSize(current, { min: 3, max: 20 })
      : Math.min(20, current < 3 ? 3 : current * 2);
    if (path) searchPaletteState.content.expanded[path] = true;
    runContentSearchForPalette(++searchPaletteState.requestSeq, searchPaletteState.query, helper.workspaceCwd(paletteSearchWorkspace()), false, { preserveExpanded: true, preserveScroll: true }).then(renderSearchPalettePreservingScroll);
  },
};

window.HerdrSearchPalette = HerdrSearchPalette;
window.HerdrSearchPaletteTree = HerdrSearchPaletteTree;
window.HerdrSearchPaletteContent = HerdrSearchPaletteContent;
