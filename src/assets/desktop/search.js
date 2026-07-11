let searchPaletteState = createSearchPaletteState();

function createSearchPaletteState() {
  return {
    query: "",
    selectedIndex: 0,
    results: [],
    requestSeq: 0,
    timer: null,
    pathKind: "file",
    pathEntries: [],
    pathGitStatus: null,
    pathOffset: 0,
    pathDone: true,
    pathLoading: false,
    pathError: "",
    content: window.HerdrWorkspaceSearch ? window.HerdrWorkspaceSearch.createContentState() : { query: "", files: [], expanded: {}, snippets: {}, loading: false, error: "", done: true, offset: 0, total_files: 0, total_matches: 0 },
    sectionsExpanded: { workspaces: true, files: true, content: true },
  };
}

function openSearchPalette() {
  const modal = el("searchPalette"),
    input = el("searchPaletteInput");
  if (!modal || !input) return;
  const previousScope = searchPaletteState.pathKind || "file";
  searchPaletteState = createSearchPaletteState();
  searchPaletteState.pathKind = previousScope;
  input.value = "";
  modal.style.display = "grid";
  renderSearchPalette();
  setTimeout(() => input.focus(), 0);
}

function closeSearchPalette() {
  const modal = el("searchPalette");
  if (modal) modal.style.display = "none";
  if (searchPaletteState.timer) clearTimeout(searchPaletteState.timer);
  searchPaletteState = createSearchPaletteState();
}

function textParts(...values) {
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
}

function uniqueTextParts(...values) {
  const seen = new Set();
  return textParts(...values).filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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

function searchSettings() {
  return window.HerdrWorkspaceSearch && window.HerdrWorkspaceSearch.settings
    ? window.HerdrWorkspaceSearch.settings()
    : { searchSectionOrder: ["workspaces", "files", "content"], searchWorkspacesEnabled: true, searchFilesEnabled: true, searchFoldersEnabled: true, searchContentEnabled: true, pathSearchEnabled: true };
}

function pathSearchAvailable(opts = searchSettings()) {
  return opts.pathSearchEnabled !== false && (opts.searchFilesEnabled !== false || opts.searchFoldersEnabled !== false);
}

function normalizePalettePathKind(opts = searchSettings()) {
  if (searchPaletteState.pathKind === "dir" && opts.searchFoldersEnabled === false && opts.searchFilesEnabled !== false)
    searchPaletteState.pathKind = "file";
  if (searchPaletteState.pathKind !== "dir" && opts.searchFilesEnabled === false && opts.searchFoldersEnabled !== false)
    searchPaletteState.pathKind = "dir";
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
  const workspace = currentSearchWorkspace();
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
  await Promise.allSettled([runPathSearch(seq, query, cwd, append && searchPaletteState.pathLoading === false), runContentSearchForPalette(seq, query, cwd, append && searchPaletteState.content.loading === false)]);
  if (seq === searchPaletteState.requestSeq) renderSearchPalette();
}

async function runPathSearch(seq, query, cwd, append) {
  const helper = window.HerdrWorkspaceSearch;
  const offset = append ? searchPaletteState.pathOffset : 0;
  searchPaletteState.pathLoading = true;
  searchPaletteState.pathError = "";
  renderSearchPalette();
  try {
    const data = await helper.searchPaths({ cwd, query, kind: searchPaletteState.pathKind, offset });
    if (seq !== searchPaletteState.requestSeq) return;
    const entries = data.entries || [];
    searchPaletteState.pathEntries = append ? searchPaletteState.pathEntries.concat(entries) : entries;
    searchPaletteState.pathGitStatus = data.git_status || null;
    searchPaletteState.pathOffset = offset + entries.length;
    searchPaletteState.pathDone = data.disabled || !data.truncated || entries.length === 0;
    searchPaletteState.pathError = data.disabled ? "File and folder search is disabled in Settings." : "";
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
    const data = await helper.searchContent({ cwd, query, offset, contextLines: searchPaletteState.content.contextLines });
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
  const workspace = currentSearchWorkspace();
  return workspace ? workspaceDisplayTitle(workspace) : "No workspace selected";
}

function buildSearchSelectionRows(targets, order, opts) {
  const rows = [];
  if (!order || !order.length) order = ["workspaces", "files", "content"];
  for (const section of order) {
    if (section === "workspaces" && opts.searchWorkspacesEnabled !== false && searchPaletteState.sectionsExpanded.workspaces !== false) rows.push(...targets);
    if (section === "files" && pathSearchAvailable(opts) && searchPaletteState.sectionsExpanded.files !== false) {
      for (const entry of searchPaletteState.pathEntries || []) {
        const kind = entry.kind === "dir" ? "dir" : "file";
        if (kind !== searchPaletteState.pathKind) continue;
        rows.push({ type: "path", kind, path: entry.path, title: entry.name || entry.path, workspace: currentSearchWorkspace() });
      }
    }
    if (section === "content" && opts.searchContentEnabled !== false && searchPaletteState.sectionsExpanded.content !== false) {
      for (const item of (window.HerdrWorkspaceSearch ? window.HerdrWorkspaceSearch.flattenContentMatches(searchPaletteState.content.files) : [])) {
        rows.push({ type: "content", file: item.file, match: item.match, title: item.file.path, workspace: currentSearchWorkspace() });
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

function renderSearchPalette() {
  const query = searchPaletteState.query || "";
  const opts = searchSettings();
  normalizePalettePathKind(opts);
  const order = opts.searchSectionOrder || ["workspaces", "files", "content"];
  const targets = searchCandidates(query);
  searchPaletteState.results = buildSearchSelectionRows(targets, order, opts);
  if (searchPaletteState.selectedIndex >= searchPaletteState.results.length)
    searchPaletteState.selectedIndex = Math.max(0, searchPaletteState.results.length - 1);
  const container = el("searchPaletteResults");
  if (!container) return;
  const sections = {
    workspaces: opts.searchWorkspacesEnabled === false || !query.trim() ? "" : renderTargetSection(targets),
    files: pathSearchAvailable(opts) ? renderWorkspacePathSection(opts) : "",
    content: opts.searchContentEnabled === false ? "" : renderWorkspaceContentSection(),
  };
  container.innerHTML = order.map((key) => sections[key] || "").join("");
}

function renderTargetSection(targets) {
  const expanded = searchPaletteState.sectionsExpanded.workspaces !== false;
  const body = targets.length
    ? targets.map((result) => renderTargetResult(result, searchPaletteState.results.indexOf(result))).join("")
    : '<div class="search-empty">No matching workspace, worktree, panel, or agent.</div>';
  return `<section class="search-section"><button class="search-section-head search-section-toggle" onclick="HerdrSearchPalette.toggleSection('workspaces')" aria-expanded="${expanded ? "true" : "false"}"><strong><span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>Workspaces, worktrees, panels</strong><span>${targets.length}</span></button>${expanded ? body : ""}</section>`;
}

function renderTargetResult(result, index) {
  return `<div class="search-result ${index === searchPaletteState.selectedIndex ? "active" : ""}" onclick="chooseSearchResult(${index})"><span class="search-result-icon">${escapeHtml(result.icon)}</span><div><div class="search-result-title">${escapeHtml(result.title)}</div><div class="search-result-subtitle">${escapeHtml(result.subtitle || result.kind)}</div></div></div>`;
}

function renderWorkspacePathSection(opts = searchSettings()) {
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
      ? helper.renderPathTree(searchPaletteState.pathEntries, { query, kind, gitStatus: searchPaletteState.pathGitStatus, selectedPath, callback: "HerdrSearchPaletteTree" })
      : `<div class="search-empty">${searchPaletteState.pathLoading ? "Searching..." : `No ${noun} found.`}</div>`
    : '<div class="search-empty">Type to search files or folders in current workspace.</div>';
  const more = query && !searchPaletteState.pathDone ? `<button class="git-ui-btn search-more" onclick="HerdrSearchPalette.loadMorePaths()">Load more ${noun}</button>` : "";
  return `<section class="search-section search-path-section"><button class="search-section-head search-section-toggle" onclick="HerdrSearchPalette.toggleSection('files')" aria-expanded="${expanded ? "true" : "false"}"><strong><span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>Files and folders</strong><span>${escapeHtml(activeWorkspaceLabel())}</span></button>${expanded ? `<div class="search-scope-tabs"><button class="git-ui-btn ${kind === "file" ? "active" : ""}" ${opts.searchFilesEnabled === false ? "disabled" : ""} onclick="HerdrSearchPalette.setPathKind('file')">Files</button><button class="git-ui-btn ${kind === "dir" ? "active" : ""}" ${opts.searchFoldersEnabled === false ? "disabled" : ""} onclick="HerdrSearchPalette.setPathKind('dir')">Folders</button></div>${searchPaletteState.pathError ? `<div class="file-browser-error">${escapeHtml(searchPaletteState.pathError)}</div>` : ""}${tree}${searchPaletteState.pathLoading ? '<div class="file-browser-searching">Searching...</div>' : ""}${more}` : ""}</section>`;
}

function renderWorkspaceContentSection() {
  const helper = window.HerdrWorkspaceSearch;
  if (!helper) return "";
  const opts = helper.settings();
  const query = String(searchPaletteState.query || "").trim();
  const expanded = searchPaletteState.sectionsExpanded.content !== false;
  const body = !opts.searchContentEnabled
    ? '<div class="search-empty">File content search is disabled in Settings.</div>'
    : query.length < opts.contentMinChars
      ? `<div class="search-empty">Type at least ${opts.contentMinChars} characters to search file contents.</div>`
      : helper.renderContentPicker(searchPaletteState.content, { callback: "HerdrSearchPaletteContent", idPrefix: "searchPaletteContent", disableSnippetEditing: true });
  return `<section class="search-section search-content-section"><button class="search-section-head search-section-toggle" onclick="HerdrSearchPalette.toggleSection('content')" aria-expanded="${expanded ? "true" : "false"}"><strong><span class="herdr-tree-icon herdr-tree-icon-${expanded ? "chevron-down" : "chevron-right"}" aria-hidden="true"></span>File content</strong><span>${Number(searchPaletteState.content.total_matches || 0)} matches</span></button>${expanded ? body : ""}</section>`;
}

function moveSearchSelection(delta) {
  if (!searchPaletteState.results.length) return;
  searchPaletteState.selectedIndex =
    (searchPaletteState.selectedIndex + delta + searchPaletteState.results.length) % searchPaletteState.results.length;
  renderSearchPalette();
}

function chooseSearchResult(index = searchPaletteState.selectedIndex) {
  const result = searchPaletteState.results[index];
  if (!result) return;
  if (result.type === "path") {
    openWorkspaceSearchPath(result.path, result.kind);
    return;
  }
  if (result.type === "content") {
    openWorkspaceSearchContent(result.file, result.match);
    return;
  }
  closeSearchPalette();
  go(result.ws, result.tab, result.pane);
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
  }
}

function openWorkspaceSearchPath(path, kind) {
  const workspace = currentSearchWorkspace();
  closeSearchPalette();
  if (!workspace || !window.HerdrFileBrowser || !window.HerdrFileBrowser.openAt) return;
  window.HerdrFileBrowser.openAt(workspace, path, { kind });
}

function openWorkspaceSearchContent(file, match) {
  const helper = window.HerdrWorkspaceSearch;
  const workspace = currentSearchWorkspace();
  closeSearchPalette();
  if (!workspace || !file || !window.HerdrFileBrowser || !window.HerdrFileBrowser.openAt) return;
  window.HerdrFileBrowser.openAt(workspace, file.path, { kind: "file", highlight: helper.matchHighlight(match, searchPaletteState.query) });
}

const HerdrSearchPalette = {
  toggleSection(section) {
    if (!["workspaces", "files", "content"].includes(section)) return;
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
  loadMorePaths() { runPathSearch(++searchPaletteState.requestSeq, searchPaletteState.query, window.HerdrWorkspaceSearch.workspaceCwd(currentSearchWorkspace()), true).then(renderSearchPalette); },
  loadMoreContent() { runContentSearchForPalette(++searchPaletteState.requestSeq, searchPaletteState.query, window.HerdrWorkspaceSearch.workspaceCwd(currentSearchWorkspace()), true, { preserveScroll: true }).then(renderSearchPalettePreservingScroll); },
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
  expandAll() {
    for (const file of searchPaletteState.content.files || []) searchPaletteState.content.expanded[file.path] = true;
    renderSearchPalette();
  },
  collapseAll() {
    for (const file of searchPaletteState.content.files || []) searchPaletteState.content.expanded[file.path] = false;
    renderSearchPalette();
  },
  loadMore() { HerdrSearchPalette.loadMoreContent(); },
  loadFile(_encodedPath) {},
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
    runContentSearchForPalette(++searchPaletteState.requestSeq, searchPaletteState.query, helper.workspaceCwd(currentSearchWorkspace()), false, { preserveExpanded: true, preserveScroll: true }).then(renderSearchPalettePreservingScroll);
  },
};

window.HerdrSearchPalette = HerdrSearchPalette;
window.HerdrSearchPaletteTree = HerdrSearchPaletteTree;
window.HerdrSearchPaletteContent = HerdrSearchPaletteContent;
