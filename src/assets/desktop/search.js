function openSearchPalette() {
  const modal = el("searchPalette"),
    input = el("searchPaletteInput");
  if (!modal || !input) return;
  searchResults = [];
  searchSelectedIndex = 0;
  input.value = "";
  modal.style.display = "grid";
  renderSearchResults(searchCandidates(""));
  setTimeout(() => input.focus(), 0);
}
function closeSearchPalette() {
  const modal = el("searchPalette");
  if (modal) modal.style.display = "none";
  searchResults = [];
  searchSelectedIndex = 0;
}
function textParts(...values) {
  return values.map((value) => textValue(value)).filter(Boolean);
}
function targetForWorkspace(wsId) {
  const tab =
    state.tabs.find((t) => t.workspace_id === wsId) ||
    state.allTabs.find((t) => t.workspace_id === wsId) ||
    null;
  const pane = tab && state.panes.find((p) => p.tab_id === tab.tab_id);
  return { ws: wsId, tab: tab && tab.tab_id, pane: pane && pane.pane_id };
}
function pushSearchCandidate(list, candidate) {
  if (!candidate || !candidate.ws) return;
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
      branch = workspaceBranch(w),
      repo = w.worktree && (w.worktree.repo_name || w.worktree.repo_root),
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
        branch,
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
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return candidates.slice(0, 30);
  return candidates
    .map((candidate) => ({
      ...candidate,
      score: searchScore(candidate.searchText, needle),
    }))
    .filter((candidate) => candidate.score >= 0)
    .sort((a, b) => a.score - b.score || a.title.localeCompare(b.title))
    .slice(0, 30);
}
function searchScore(text, needle) {
  const index = text.indexOf(needle);
  if (index < 0) return -1;
  if (text === needle) return 0;
  if (text.startsWith(needle)) return 1;
  return 10 + index;
}
function scheduleSearch() {
  if (searchFramePending) return;
  searchFramePending = true;
  requestAnimationFrame(() => {
    searchFramePending = false;
    renderSearchResults(searchCandidates(el("searchPaletteInput").value));
  });
}
function renderSearchResults(results) {
  searchResults = results || [];
  if (searchSelectedIndex >= searchResults.length)
    searchSelectedIndex = Math.max(0, searchResults.length - 1);
  const container = el("searchPaletteResults");
  if (!container) return;
  if (!searchResults.length) {
    container.innerHTML = '<div class="search-empty">No matching panel targets.</div>';
    return;
  }
  container.innerHTML = searchResults
    .map(
      (result, index) =>
        `<div class="search-result ${index === searchSelectedIndex ? "active" : ""}" onclick="chooseSearchResult(${index})"><span class="search-result-icon">${escapeHtml(result.icon)}</span><div><div class="search-result-title">${escapeHtml(result.title)}</div><div class="search-result-subtitle">${escapeHtml(result.subtitle || result.kind)}</div></div></div>`,
    )
    .join("");
}
function moveSearchSelection(delta) {
  if (!searchResults.length) return;
  searchSelectedIndex =
    (searchSelectedIndex + delta + searchResults.length) % searchResults.length;
  renderSearchResults(searchResults);
}
function chooseSearchResult(index = searchSelectedIndex) {
  const result = searchResults[index];
  if (!result) return;
  closeSearchPalette();
  go(result.ws, result.tab, result.pane);
}
function searchPaletteKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    closeSearchPalette();
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    moveSearchSelection(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    moveSearchSelection(-1);
  } else if (e.key === "Enter") {
    e.preventDefault();
    chooseSearchResult();
  }
}
