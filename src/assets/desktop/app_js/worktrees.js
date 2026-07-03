function workspaceCloseName(id) {
  const w = state.workspaces.find((x) => x.workspace_id === id);
  if (!w) return id;
  const branch = workspaceBranch(w);
  return `${w.label}${branch ? " - " + branch : ""}`;
}
function workspaceBranch(w) {
  const wt = worktreeForWorkspace(w);
  return (
    (wt && (wt.branch || (wt.is_detached ? "detached" : ""))) ||
    state.workspaceBranches[w.workspace_id] ||
    ""
  );
}
function panelCloseName(id) {
  const t = state.allTabs.concat(state.tabs).find((x) => x.tab_id === id);
  if (!t) return id;
  return `${workspaceCloseName(t.workspace_id)} - ${tabTitle(t)}`;
}
function workspaceDragStart(e, id) {
  state.dragWorkspace = id;
  e.currentTarget.classList.add("workspace-drag");
  try {
    e.dataTransfer.setData("text/plain", id);
    e.dataTransfer.effectAllowed = "move";
  } catch (_) {}
}
function workspaceDragOver(e, id) {
  if (
    options.workspaceSort !== "drag" ||
    !state.dragWorkspace ||
    state.dragWorkspace === id
  )
    return;
  e.preventDefault();
  e.currentTarget.classList.add("workspace-drop");
}
function workspaceDragLeave(e) {
  e.currentTarget.classList.remove("workspace-drop");
}
function workspaceDragEnd(e) {
  e.currentTarget.classList.remove("workspace-drag");
  document
    .querySelectorAll(".workspace-drop")
    .forEach((x) => x.classList.remove("workspace-drop"));
  state.dragWorkspace = null;
}
async function workspaceDrop(e, targetId) {
  e.preventDefault();
  e.currentTarget.classList.remove("workspace-drop");
  const source = state.dragWorkspace;
  if (!source || source === targetId) return;
  const ids = orderedWorkspaceIds().filter((id) => id !== source);
  const index = Math.max(0, ids.indexOf(targetId));
  ids.splice(index, 0, source);
  state.workspaceOrder = ids;
  state.dragWorkspace = null;
  render();
  await api("/api/workspace-order", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ order: ids }),
  });
}
function orderedWorkspaceIds() {
  return Array.from(document.querySelectorAll("#workspaces .item"))
    .map((x) => x.dataset.workspaceId)
    .filter(Boolean);
}
function openWorktreeCreateModal(id) {
  const w = state.workspaces.find((x) => x.workspace_id === id);
  if (!w || isLinkedWorktree(w)) return;
  state.createWorktreeWorkspace = id;
  const sourcePath = workspacePath(w);
  state.createWorktreeOriginalSource = sourcePath;
  state.createWorktreeSource = null;
  state.createWorktreeDefaultPath = "";
  el("worktreeCreateSource").value = sourcePath;
  el("worktreeBranch").value = "";
  el("worktreeBase").value = "";
  el("worktreeLabel").value = "";
  el("worktreePath").value = "";
  el("worktreePullBase").checked = false;
  el("worktreeCreateError").textContent = "";
  setCreateWorktreeLoading(false);
  el("worktreeCreateModal").style.display = "grid";
  setTimeout(() => {
    el("worktreeBranch").focus();
  }, 0);
}
function closeWorktreeCreateModal() {
  const m = el("worktreeCreateModal");
  if (m) m.style.display = "none";
  clearTimeout(state.createWorktreeAutodiscoverTimer);
  state.createWorktreeWorkspace = null;
  state.createWorktreeOriginalSource = "";
  state.createWorktreeSource = null;
  state.createWorktreeDefaultPath = "";
  setCreateWorktreeLoading(false);
}
function setCreateWorktreeLoading(show) {
  const loading = el("worktreeCreateLoading");
  if (loading) loading.classList.toggle("show", !!show);
}
function setWorktreeLoading(show) {
  const loading = el("worktreeLoading");
  if (loading) loading.classList.toggle("show", !!show);
}
function closeWorktreeOpenModal() {
  clearTimeout(state.openWorktreeAutodiscoverTimer);
  state.openWorktreeSuggestionLocked = false;
  setWorktreeLoading(false);
  const m = el("worktreeOpenModal");
  if (m) m.style.display = "none";
}
function openWorktreeOpenModal() {
  state.openWorktreeSelected = null;
  state.openWorktreeSuggestionLocked = false;
  state.openWorktreeSource = null;
  state.openWorktreeDiscoveryError = "";
  state.openWorktreeRows = [];
  state.openWorktreeAllRows = [];
  state.openWorktreeBranches = [];
  state.openWorktreeBranchSourceKey = "";
  state.openWorktreeDefaultPath = "";
  state.openWorktreeBaseBranchName = "";
  el("worktreeDiscoverPath").value = explorationDefaultDirectoryOption();
  el("worktreeWorkspaceLabel").value = "";
  state.workspaceCreateSuggestedLabel = "";
  el("worktreeNewBranch").value = "";
  el("worktreeNewBase").value = "";
  el("worktreeNewLabel").value = "";
  el("worktreeNewPath").value = "";
  el("worktreeNewPullBase").checked = false;
  syncWorktreeBranchOptions([]);
  renderWorktreeOpenList();
  el("worktreeOpenError").textContent = "";
  el("worktreeOpenModal").style.display = "grid";
  setTimeout(() => {
    el("worktreeDiscoverPath").focus();
  }, 0);
}
function openWorktreesForRepo(keyToken) {
  const key = decodeURIComponent(keyToken),
    allRows = state.worktrees.filter((w) => worktreeRowGroupKey(w) === key),
    rows = allRows.filter((w) => w.is_linked_worktree);
  const source = allRows[0] || rows[0] || {};
  state.openWorktreeSelected = null;
  state.openWorktreeDiscoveryError = "";
  state.openWorktreeSource = {
    workspace_id: source.source_workspace_id || null,
    cwd: source.source_cwd || null,
    repo_name: source.source_repo_name || "",
    repo_root: source.source_repo_root || "",
    default_worktree_directory: source.default_worktree_directory || "",
  };
  state.openWorktreeAllRows = allRows.map((w) =>
    Object.assign({}, w, {
      path: textValue(w.path),
      label: textValue(w.label),
      branch: textValue(w.branch),
      source_cwd: textValue(w.source_cwd),
      source_repo_root: textValue(w.source_repo_root),
    }),
  );
  state.openWorktreeRows = rows.map((w) =>
    Object.assign({}, w, {
      path: textValue(w.path),
      label: textValue(w.label),
      branch: textValue(w.branch),
      source_cwd: textValue(w.source_cwd),
      source_repo_root: textValue(w.source_repo_root),
    }),
  );
  el("worktreeNewBranch").value = "";
  el("worktreeNewBase").value = "";
  el("worktreeNewLabel").value = "";
  el("worktreeNewPath").value = "";
  el("worktreeNewPullBase").checked = false;
  state.openWorktreeDefaultPath = "";
  state.openWorktreeBaseBranchName = "";
  state.openWorktreeBranchSourceKey = "";
  syncWorktreeBranchOptions([]);
  el("worktreeOpenError").textContent = "";
  el("worktreeDiscoverPath").value =
    source.source_cwd || source.source_repo_root || "";
  syncSmartWorkspaceLabel();
  renderWorktreeOpenList();
  el("worktreeOpenModal").style.display = "grid";
  loadWorktreeBranchOptions();
}
function validOpenWorktreeRows() {
  return (state.openWorktreeRows || state.worktrees || [])
    .map((w) =>
      Object.assign({}, w, {
        path: textValue(w.path),
        label: textValue(w.label),
        branch: textValue(w.branch),
        source_cwd: textValue(w.source_cwd),
      }),
    )
    .filter(
      (w) => w.is_linked_worktree && (w.source_workspace_id || w.source_cwd),
    );
}
function syncWorktreePathOptions(rows) {
  const seen = new Set(),
    items = [];
  for (const w of rows || []) {
    if (!w.path || seen.has(w.path)) continue;
    seen.add(w.path);
    items.push(
      `<option value="${escapeAttr(w.path)}">${escapeAttr(worktreeOpenRowTitle(w))}</option>`,
    );
  }
  renderPathOptions("worktreePathOptions", items);
}
function renderPathOptions(optionsId, items) {
  const optionsEl = el(optionsId);
  if (!optionsEl) return;
  optionsEl.innerHTML = items.join("");
}
function clearCreateWorktreeSuggestions() {
  renderPathOptions("worktreeCreatePathOptions", []);
}
async function discoverCreateWorktreeSource() {
  clearTimeout(state.createWorktreeAutodiscoverTimer);
  setCreateWorktreeLoading(true);
  const path = el("worktreeCreateSource").value.trim();
  el("worktreeCreateError").textContent = "";
  try {
    let url = "/api/worktrees";
    if (path) url += "?cwd=" + encodeURIComponent(path);
    const r = await api(url);
    const source = (r.result || {}).source || {};
    const sourceCwd = textValue(source.source_checkout_path) || path || null;
    state.createWorktreeSource = {
      workspace_id: source.source_workspace_id || null,
      cwd: sourceCwd,
      repo_name: textValue(source.repo_name),
      repo_root: textValue(source.repo_root),
      default_worktree_directory: textValue(source.default_worktree_directory),
    };
    syncCreateWorktreeCheckoutPath();
  } catch (ex) {
    state.createWorktreeSource = null;
    el("worktreeCreateError").textContent = ex.message || String(ex);
  } finally {
    setCreateWorktreeLoading(false);
  }
}
function scheduleCreateWorktreeAutodiscover() {
  clearTimeout(state.createWorktreeAutodiscoverTimer);
  const seconds = Number(options.worktreeAutoDiscoverSeconds) || 0;
  const value = el("worktreeCreateSource").value.trim();
  setCreateWorktreeLoading(false);
  if (!value) return;
  setCreateWorktreeLoading(true);
  state.createWorktreeAutodiscoverTimer = setTimeout(
    () => {
      if (
        el("worktreeCreateModal").style.display === "grid" &&
        el("worktreeCreateSource").value.trim() === value
      )
        discoverCreateWorktreeSource();
      else setCreateWorktreeLoading(false);
    },
    Math.max(0, seconds) * 1000,
  );
}
function syncCreateWorktreeCheckoutPath() {
  const input = el("worktreePath");
  if (!input) return;
  const source = state.createWorktreeSource || {},
    branch = el("worktreeBranch").value.trim(),
    root = worktreeRootForSource(source),
    repo = source.repo_name;
  if (!root || !repo || !branch) {
    const prev = state.createWorktreeDefaultPath || "";
    if (input.value.trim() === prev) input.value = "";
    state.createWorktreeDefaultPath = "";
    return;
  }
  const next = joinPath(root, repo, branchPathSlug(branch));
  if (!input.value.trim() || input.value.trim() === state.createWorktreeDefaultPath)
    input.value = next;
  state.createWorktreeDefaultPath = next;
}
function syncWorktreeBranchOptions(branches) {
  const optionsEl = el("worktreeBranchOptions");
  if (!optionsEl) return;
  optionsEl.innerHTML = (branches || [])
    .map((branch) => `<option value="${escapeAttr(branch)}"></option>`)
    .join("");
}
function worktreeSourceKey(source) {
  return source
    ? source.cwd || source.repo_root || source.workspace_id || ""
    : "";
}
async function loadWorktreeBranchOptions() {
  const source = state.openWorktreeSource;
  if (!source || !source.cwd) {
    state.openWorktreeBranches = [];
    syncWorktreeBranchOptions([]);
    state.openWorktreeBranchSourceKey = "";
    return;
  }
  const key = worktreeSourceKey(source);
  if (state.openWorktreeBranchSourceKey === key) return;
  state.openWorktreeBranchSourceKey = key;
  try {
    const r = await api(
      "/api/git-branches?cwd=" + encodeURIComponent(source.cwd),
    );
    state.openWorktreeBranches = r.branches || [];
    syncWorktreeBranchOptions(state.openWorktreeBranches);
  } catch (_) {
    state.openWorktreeBranches = [];
    state.openWorktreeBranchSourceKey = "";
    syncWorktreeBranchOptions([]);
  }
}
function joinPath(...parts) {
  const clean = parts.filter(Boolean).map((part, index) => {
    part = String(part);
    if (index === 0) return part.replace(/\/+$/g, "");
    return part.replace(/^\/+|\/+$/g, "");
  });
  return clean.join("/");
}
function worktreeRootForSource(source) {
  let root = worktreeDefaultDirectoryOption();
  if (!root) root = source.default_worktree_directory || "../worktrees";
  if (root.startsWith("~") || root.startsWith("/")) return root;
  return normalizeAbsolutePath(joinPath(source.repo_root, root));
}
function worktreeDefaultDirectoryOption() {
  return String(options.worktreeDefaultDirectory || "").trim();
}
function explorationDefaultDirectoryOption() {
  return String(options.explorationDefaultDirectory || "").trim();
}
function defaultWorktreeCheckoutPath() {
  const source = state.openWorktreeSource || {},
    branch = el("worktreeNewBranch").value.trim(),
    root = worktreeRootForSource(source),
    repo = source.repo_name;
  if (!root || !repo || !branch) return "";
  return joinPath(root, repo, branchPathSlug(branch));
}
function syncWorktreeCheckoutPath() {
  const input = el("worktreeNewPath");
  if (!input) return;
  const next = defaultWorktreeCheckoutPath();
  const previous = state.openWorktreeDefaultPath || "";
  if (!next) {
    if (input.value.trim() === previous) input.value = "";
    state.openWorktreeDefaultPath = "";
    return;
  }
  if (!input.value.trim() || input.value.trim() === previous)
    input.value = next;
  state.openWorktreeDefaultPath = next;
}
function checkedOutWorktreeForBranch(branch) {
  return checkedOutWorktreeForBranchHelper(branch, [
    state.openWorktreeAllRows || state.openWorktreeRows || [],
    state.worktrees || [],
  ]);
}
function resolveWorktreeSource(input) {
  return resolveWorktreeSourceHelper(input);
}
async function submitWorktreeCreate(input) {
  const errEl = input.errEl,
    submitEl = input.submitEl,
    closeFn = input.closeFn,
    source = input.source,
    branch = String(input.branch || "").trim(),
    base = String(input.base || "").trim(),
    label = String(input.label || "").trim(),
    path = String(input.path || "").trim(),
    pullBase = !!input.pullBase;
  errEl.textContent = "";
  const error = validateWorktreeCreateHelper({
    branch,
    generateWorktreeNames: options.generateWorktreeNames,
    worktreeLists: [
      state.openWorktreeAllRows || state.openWorktreeRows || [],
      state.worktrees || [],
    ],
  });
  if (error) {
    errEl.textContent = error;
    return;
  }
  submitEl.disabled = true;
  try {
    const r = await api("/api/worktrees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        buildWorktreeCreateBody({ source, branch, base, label, path, pullBase }),
      ),
    });
    closeFn();
    const result = r.result || {};
    go(
      result.workspace.workspace_id,
      result.tab && result.tab.tab_id,
      result.root_pane && result.root_pane.pane_id,
    );
  } catch (ex) {
    errEl.textContent = ex.message || String(ex);
  } finally {
    submitEl.disabled = false;
  }
}
function defaultBaseBranch() {
  const branches = state.openWorktreeBranches || [];
  if (branches.includes("main")) return "main";
  if (branches.includes("master")) return "master";
  return branches[0] || "";
}
function syncBranchNameFromBase() {
  const base = el("worktreeNewBase").value.trim(),
    branchInput = el("worktreeNewBranch");
  if (!base) return;
  if (base === defaultBaseBranch()) {
    if (branchInput.value.trim() === state.openWorktreeBaseBranchName)
      branchInput.value = "";
    state.openWorktreeBaseBranchName = "";
    syncWorktreeCheckoutPath();
    return;
  }
  if (
    branchInput.value.trim() &&
    branchInput.value.trim() !== state.openWorktreeBaseBranchName
  )
    return;
  branchInput.value = base;
  state.openWorktreeBaseBranchName = base;
  syncWorktreeCheckoutPath();
}
function scheduleWorktreeAutodiscover() {
  clearTimeout(state.openWorktreeAutodiscoverTimer);
  const seconds = Number(options.worktreeAutoDiscoverSeconds) || 0;
  const value = el("worktreeDiscoverPath").value.trim();
  setWorktreeLoading(false);
  if (!value) return;
  setWorktreeLoading(true);
  state.openWorktreeAutodiscoverTimer = setTimeout(
    () => {
      if (
        el("worktreeOpenModal").style.display === "grid" &&
        el("worktreeDiscoverPath").value.trim() === value
      )
        discoverWorktrees(true);
      else setWorktreeLoading(false);
    },
    Math.max(0, seconds) * 1000,
  );
}
function updateWorktreeNewVisibility() {
  const section = el("worktreeNewSection"),
    workspaceSection = el("worktreeWorkspaceSection"),
    hint = el("worktreeWorkspaceHint"),
    hasPath = !!el("worktreeDiscoverPath").value.trim();
  if (section)
    section.style.display = state.openWorktreeSource ? "block" : "none";
  if (workspaceSection)
    workspaceSection.style.display = hasPath ? "block" : "none";
  if (hint) {
    hint.textContent = state.openWorktreeSource
      ? "Opens this Git repo folder directly and ignores linked worktrees."
      : "Only workspace creation is available for non-Git folders.";
  }
}
function worktreeOpenRowTitle(w) {
  const pathName = (w.path || "").split(/[\\/]/).filter(Boolean).pop();
  return w.branch || pathName || w.label || "worktree";
}
function renderWorktreeOpenList() {
  const list = el("worktreeOpenList");
  if (!list) return;
  const rows = validOpenWorktreeRows();
  state.openWorktreeRows = rows;
  syncWorktreePathOptions(rows);
  updateWorktreeNewVisibility();
  if (!rows.length) {
    const path = el("worktreeDiscoverPath").value.trim();
    let message = "Enter a folder. Git repos are discovered automatically.";
    if (state.openWorktreeSource)
      message = "Git repo found. No linked worktrees found; create a new worktree or open the repo as a workspace.";
    else if (path)
      message = "No Git worktrees available for this folder. Create a workspace instead.";
    list.innerHTML = `<div class="worktree-open-empty">${message}</div>`;
    return;
  }
  list.innerHTML = rows
    .map(
      (w, i) =>
        `<div class="worktree-open-row ${state.openWorktreeSelected === i ? "selected" : ""}"><span><strong>${escapeHtml(worktreeOpenRowTitle(w))}</strong><small>${escapeHtml(w.branch || "detached")} · ${escapeHtml(w.path)}</small></span><span class="session-controls"><button class="mini danger" title="Remove worktree from disk" onclick="event.stopPropagation();removeDiscoveredWorktree(${i})">🗑</button><button class="btn" onclick="openDiscoveredWorktree(${i})">Open</button></span></div>`,
    )
    .join("");
}
async function discoverWorktrees() {
  clearTimeout(state.openWorktreeAutodiscoverTimer);
  setWorktreeLoading(true);
  const err = el("worktreeOpenError"),
    path = el("worktreeDiscoverPath").value.trim();
  err.textContent = "";
  state.openWorktreeSelected = null;
  try {
    let url = "/api/worktrees";
    if (path) url += "?cwd=" + encodeURIComponent(path);
    const r = await api(url);
    const source = (r.result || {}).source || {};
    const sourceCwd = textValue(source.source_checkout_path) || path || null;
    state.openWorktreeDiscoveryError = "";
    const previousSourceKey = worktreeSourceKey(state.openWorktreeSource);
    state.openWorktreeSource = {
      workspace_id: source.source_workspace_id || null,
      cwd: sourceCwd,
      repo_name: textValue(source.repo_name),
      repo_root: textValue(source.repo_root),
      default_worktree_directory: textValue(source.default_worktree_directory),
    };
    const nextSourceKey = worktreeSourceKey(state.openWorktreeSource);
    if (previousSourceKey !== nextSourceKey) {
      state.openWorktreeBranches = [];
      state.openWorktreeBranchSourceKey = "";
      syncWorktreeBranchOptions([]);
    }
    state.openWorktreeAllRows = ((r.result || {}).worktrees || []).map((w) =>
      Object.assign({}, w, {
        path: textValue(w.path),
        label: textValue(w.label),
        branch: textValue(w.branch),
        source_workspace_id: source.source_workspace_id,
        source_repo_name: textValue(source.repo_name),
        source_repo_root: textValue(source.repo_root),
        source_cwd: sourceCwd,
      }),
    );
    state.openWorktreeRows = state.openWorktreeAllRows;
    renderWorktreeOpenList();
    loadWorktreeBranchOptions();
    syncWorktreeCheckoutPath();
  } catch (ex) {
    state.openWorktreeSource = null;
    state.openWorktreeDiscoveryError = ex.message || String(ex);
    state.openWorktreeRows = [];
    state.openWorktreeAllRows = [];
    state.openWorktreeBranchSourceKey = "";
    syncWorktreeBranchOptions([]);
    renderWorktreeOpenList();
    err.textContent = "";
  } finally {
    setWorktreeLoading(false);
  }
}
function syncSmartWorkspaceLabel() {
  const pathInput = el("worktreeDiscoverPath"),
    labelInput = el("worktreeWorkspaceLabel");
  if (!pathInput || !labelInput) return;
  const previous = state.workspaceCreateSuggestedLabel || "",
    next = pathBasename(pathInput.value.trim()) || "workspace";
  if (!labelInput.value.trim() || labelInput.value.trim() === previous)
    labelInput.value = next;
  state.workspaceCreateSuggestedLabel = next;
}
async function createWorkspaceFromSmartModal() {
  const err = el("worktreeOpenError"),
    submit = el("worktreeWorkspaceSubmit"),
    cwd = el("worktreeDiscoverPath").value.trim(),
    label = el("worktreeWorkspaceLabel").value.trim();
  err.textContent = "";
  if (!cwd) {
    err.textContent = "Folder is required.";
    return;
  }
  if (!label) {
    err.textContent = "Workspace name is required.";
    return;
  }
  submit.disabled = true;
  try {
    const r = await api("/api/workspaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label, cwd }),
    });
    closeWorktreeOpenModal();
    go(r.result.workspace.workspace_id);
  } catch (ex) {
    err.textContent = ex.message || String(ex);
  } finally {
    submit.disabled = false;
  }
}
async function openDiscoveredWorktree(index) {
  const row = (state.openWorktreeRows || [])[index];
  if (!row || !row.is_linked_worktree) return;
  const err = el("worktreeOpenError");
  err.textContent = "";
  try {
    const r = await api("/api/worktrees/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: row.source_workspace_id || null,
        cwd: row.source_workspace_id ? null : row.source_cwd,
        path: row.path,
        label: null,
      }),
    });
    closeWorktreeOpenModal();
    const result = r.result || {};
    go(
      result.workspace.workspace_id,
      result.tab && result.tab.tab_id,
      result.root_pane && result.root_pane.pane_id,
    );
  } catch (ex) {
    err.textContent = ex.message || String(ex);
  }
}
async function removeDiscoveredWorktree(index) {
  const row = (state.openWorktreeRows || [])[index];
  if (!row || !row.is_linked_worktree) return;
  if (!(await askQuestion({
    title: "Remove worktree from disk?",
    message: `Remove worktree "${row.label || row.branch || row.path}" from disk?`,
    confirmText: "Remove",
    danger: true,
  })))
    return;
  const err = el("worktreeOpenError");
  err.textContent = "";
  try {
    if (row.open_workspace_id)
      await api(
        `/api/workspaces/${encodeURIComponent(row.open_workspace_id)}/worktree-remove`,
        { method: "POST" },
      );
    else
      await api("/api/worktrees/remove-path", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          repo_root: row.source_repo_root,
          path: row.path,
          force: false,
        }),
      });
    await discoverWorktrees();
    refresh();
  } catch (ex) {
    const message = ex.message || String(ex);
    if (await confirmForceWorktreeRemove(message)) {
      await forceRemoveDiscoveredWorktree(row);
      await discoverWorktrees();
      refresh();
      return;
    }
    err.textContent = message;
  }
}
async function confirmForceWorktreeRemove(message) {
  return askQuestion({
    title: "Force remove worktree?",
    message: `Git refused to remove this worktree:\n\n${message}\n\nForce delete it anyway?`,
    confirmText: "Force delete",
    danger: true,
  });
}
async function forceRemoveDiscoveredWorktree(row) {
  if (row.open_workspace_id)
    await api(
      `/api/workspaces/${encodeURIComponent(row.open_workspace_id)}/worktree-remove`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      },
    );
  else
    await api("/api/worktrees/remove-path", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repo_root: row.source_repo_root,
        path: row.path,
        force: true,
      }),
    });
}
async function createDiscoveredWorktree() {
  const err = el("worktreeOpenError"),
    sourcePath = el("worktreeDiscoverPath").value.trim(),
    branch = el("worktreeNewBranch").value.trim(),
    base = el("worktreeNewBase").value.trim(),
    label = el("worktreeNewLabel").value.trim(),
    path = el("worktreeNewPath").value.trim(),
    pullBase = el("worktreeNewPullBase").checked,
    submit = el("worktreeNewSubmit");
  err.textContent = "";
  if (!branch && !options.generateWorktreeNames) {
    err.textContent =
      "Branch name is required. Enable Generate worktree branch names in Settings to leave it blank.";
    return;
  }
  submit.disabled = true;
  try {
    if (sourcePath && !state.openWorktreeSource) await discoverWorktrees();
    const checkedOut = checkedOutWorktreeForBranch(branch);
    if (checkedOut) {
      err.textContent = `Branch "${branch}" is already checked out at ${textValue(checkedOut.path)}`;
      return;
    }
    const source = state.openWorktreeSource || {};
    const workspaceId = source.workspace_id || (!sourcePath ? state.ws : null),
      cwd = source.cwd || sourcePath || null;
    const r = await api("/api/worktrees", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspace_id: cwd ? null : workspaceId,
        cwd,
        branch: branch || null,
        base: base || null,
        label: label || null,
        path: path || null,
        pull_base: pullBase,
      }),
    });
    closeWorktreeOpenModal();
    const result = r.result || {};
    go(
      result.workspace.workspace_id,
      result.tab && result.tab.tab_id,
      result.root_pane && result.root_pane.pane_id,
    );
  } catch (ex) {
    err.textContent = ex.message || String(ex);
  } finally {
    submit.disabled = false;
  }
}
async function closeWorkspace(id) {
  const w = state.workspaces.find((x) => x.workspace_id === id),
    kind = isLinkedWorktree(w) ? "worktree" : "workspace";
  const hasLinkedWorktrees =
    w &&
    !isLinkedWorktree(w) &&
    state.workspaces.some(
      (x) =>
        isLinkedWorktree(x) && worktreeGroupKey(x) === worktreeGroupKey(w),
    );
  if (hasLinkedWorktrees) {
    const mode = options.parentCloseMode || "panels";
    if (mode === "close") {
      const linkedToReopen = state.workspaces
        .filter(
          (x) =>
            isLinkedWorktree(x) &&
            worktreeGroupKey(x) === worktreeGroupKey(w),
        )
        .map((x) => ({
          path: x.worktree && x.worktree.checkout_path,
          label: x.label,
        }))
        .filter((x) => x.path);
      let msg = `Close workspace "${workspaceCloseName(id)}"?`;
      if (linkedToReopen.length)
        msg += `\n\nThis will close ${linkedToReopen.length} linked worktree(s) and stop their processes. They will be re-opened with fresh shells.`;
      if (!(await askQuestion({ title: "Close workspace?", message: msg, confirmText: "Close", danger: true }))) return;
      await api(`/api/workspaces/${encodeURIComponent(id)}/close`, {
        method: "POST",
      });
      if (state.ws === id) {
        state.ws = null;
        state.tab = null;
        state.pane = null;
      }
      await refresh();
      for (const wt of linkedToReopen) {
        try {
          await api("/api/worktrees/open", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: wt.path, label: wt.label }),
          });
        } catch (e) {}
      }
      refresh();
      return;
    }
    if (!(await askQuestion({
      title: "Close workspace panels?",
      message: `Close panels in "${workspaceCloseName(id)}"? Linked worktrees will keep running.`,
      confirmText: "Close panels",
      danger: true,
    })))
      return;
    await closeWorkspaceById(id);
    refresh();
    return;
  }
  if (!(await askQuestion({
    title: `Close ${kind}?`,
    message: `Close ${kind} "${workspaceCloseName(id)}"?`,
    confirmText: "Close",
    danger: true,
  }))) return;
  await closeWorkspaceById(id);
  refresh();
}
function tabsForWorkspace(id) {
  return state.allTabs
    .concat(state.tabs)
    .filter((tab, index, tabs) =>
      tab.workspace_id === id &&
      tabs.findIndex((candidate) => candidate.tab_id === tab.tab_id) === index,
    );
}
function panesForTab(id) {
  return state.panes.filter((pane) => pane.tab_id === id);
}
async function closePaneById(id) {
  await api(`/api/panes/${encodeURIComponent(id)}/close`, { method: "POST" });
}
async function closeWorkspaceById(id) {
  await api(`/api/workspaces/${encodeURIComponent(id)}/close`, {
    method: "POST",
  });
  if (state.ws === id) {
    state.ws = null;
    state.tab = null;
    state.pane = null;
  }
}
async function removeWorktree(id) {
  if (!(await askQuestion({
    title: "Remove worktree from disk?",
    message: `Remove and close worktree "${workspaceCloseName(id)}"? This deletes the linked checkout directory.`,
    confirmText: "Remove",
    danger: true,
  })))
    return;
  try {
    await api(`/api/workspaces/${encodeURIComponent(id)}/worktree-remove`, {
      method: "POST",
    });
  } catch (ex) {
    const message = ex.message || String(ex);
    if (!(await confirmForceWorktreeRemove(message))) return;
    await api(`/api/workspaces/${encodeURIComponent(id)}/worktree-remove`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ force: true }),
    });
  }
  if (state.ws === id) {
    state.ws = null;
    state.tab = null;
    state.pane = null;
  }
  refresh();
}
async function newTab() {
  if (!state.ws) return;
  const r = await api("/api/tabs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspace_id: state.ws }),
  });
  const tab = r.result.tab.tab_id;
  go(state.ws, tab);
}
function startWorkspaceRename(id, label) {
  state.editingWorkspace = id;
  state.editingWorkspaceValue = label || "";
  render();
  setTimeout(() => {
    if (state.editingWorkspace !== id) return;
    const input = document.querySelector(".workspace-rename-input");
    if (input) input.select();
  }, 0);
}
function workspaceRenameKey(e, id) {
  if (e.key === "Enter") {
    e.preventDefault();
    commitWorkspaceRename(id);
  } else if (e.key === "Escape") {
    state.editingWorkspace = null;
    state.editingWorkspaceValue = "";
    render();
  }
}
async function commitWorkspaceRename(id) {
  if (state.editingWorkspace !== id) return;
  const label = String(state.editingWorkspaceValue || "").trim();
  state.editingWorkspace = null;
  state.editingWorkspaceValue = "";
  if (label)
    await api(`/api/workspaces/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
  refresh();
}
function startTabRename(id, label) {
  state.editingTab = id;
  state.editingTabValue = label || "";
  render();
  setTimeout(() => {
    if (state.editingTab !== id) return;
    const input = document.querySelector(".tab-rename-input");
    if (input) input.select();
  }, 0);
}
function tabRenameKey(e, id) {
  if (e.key === "Enter") {
    e.preventDefault();
    commitTabRename(id);
  } else if (e.key === "Escape") {
    state.editingTab = null;
    state.editingTabValue = "";
    render();
  }
}
async function commitTabRename(id) {
  if (state.editingTab !== id) return;
  const label = String(state.editingTabValue || "").trim();
  state.editingTab = null;
  state.editingTabValue = "";
  if (label)
    await api(`/api/tabs/${encodeURIComponent(id)}/rename`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
  refresh();
}
async function closeTab(id) {
  if (!confirm(`Close panel "${panelCloseName(id)}"?`)) return;
  const tab = state.allTabs.concat(state.tabs).find((t) => t.tab_id === id),
    workspaceId = tab && tab.workspace_id,
    workspaceTabs = workspaceId ? tabsForWorkspace(workspaceId) : [];
  if (workspaceTabs.length > 1) {
    await api(`/api/tabs/${encodeURIComponent(id)}/close`, { method: "POST" });
  } else if (workspaceId) {
    await closeWorkspaceById(workspaceId);
  } else {
    const panes = panesForTab(id);
    if (panes.length) await closePaneById(panes[0].pane_id);
  }
  if (typeof removeClosedTabFromState === "function") removeClosedTabFromState(id);
  if (state.tab === id && typeof selectFallbackTabAfterClosed === "function") {
    resetTerminalConnection(true);
    selectFallbackTabAfterClosed(id);
    replaceSelectionHistory();
    render();
    if (typeof Terminal !== "undefined") connectTerminal();
  } else if (state.tab === id) {
    state.tab = null;
    state.pane = null;
    render();
  }
  refresh();
}
