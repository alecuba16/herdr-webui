// Per-workspace shell view (terminal/git/files/search) for the right sidebar
// column. The mode lives only for open workspaces during this page session.
// The rail toggle (Files/Git/Search/terminal) changes the mode; the column's
// collapse state is a separate global flag (core.js owns it).
// "terminal" is the pane-tab contract, not a sidebar view: expanding the
// column while the mode is terminal falls back to a hosted view
// (resolveHostedShellMode) so the extended column never renders empty.
const WORKSPACE_SHELL_STORAGE_KEY = "herdr-web-workspace-shell";
const WORKSPACE_SHELL_PATH_PREFIX = "path:";
const WORKSPACE_SHELL_PATH_LIMIT = 20;

function normalizeShellPath(path) {
  const text = String(path || "").trim();
  if (!text) return "";
  return text === "/" ? "/" : text.replace(/\/+$/, "");
}

function shellPathKey(path) {
  const normalized = normalizeShellPath(path);
  return normalized ? WORKSPACE_SHELL_PATH_PREFIX + normalized : "";
}

function workspaceForShellId(id) {
  if (id && typeof id === "object") return id;
  return (state.workspaces || []).find((w) => w && w.workspace_id === id) || null;
}

function shellPathForId(id) {
  const workspace = workspaceForShellId(id);
  if (!workspace || workspace.default_folder) return "";
  return workspacePath(workspace);
}

function isHostedShellMode(mode) {
  return mode === "git" || mode === "files" || mode === "search";
}

function loadWorkspaceShellStates() {
  try {
    // A reload starts with clean view state. The store is only a temporary
    // write-through while this page keeps workspaces open.
    localStorage.removeItem(WORKSPACE_SHELL_STORAGE_KEY);
  } catch (_) {}
}

function trimWorkspaceShellPathEntries(limit = WORKSPACE_SHELL_PATH_LIMIT) {
  const pathEntries = Object.entries(state.workspaceShell).filter(([key]) => key.startsWith(WORKSPACE_SHELL_PATH_PREFIX));
  if (pathEntries.length <= limit) return;
  pathEntries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  for (const [key] of pathEntries.slice(limit)) delete state.workspaceShell[key];
}

function syncWorkspaceShellPathEntry(id, shell) {
  const pathKey = shellPathKey(shellPathForId(id));
  if (!pathKey) return;
  state.workspaceShell[pathKey] = { mode: shell.mode, at: Date.now() };
  trimWorkspaceShellPathEntries();
}

function saveWorkspaceShellStates() {
  try {
    const keep = new Set();
    for (const workspace of state.workspaces || []) {
      keep.add(workspaceShellKey(workspace));
      const pathKey = shellPathKey(workspacePath(workspace));
      if (pathKey) keep.add(pathKey);
    }
    if (state.ws) keep.add(workspaceShellKey(state.ws));
    const live = Object.fromEntries(
      Object.entries(state.workspaceShell || {}).filter(([key]) => keep.has(key)),
    );
    if (Object.keys(live).length) localStorage.setItem(WORKSPACE_SHELL_STORAGE_KEY, JSON.stringify(live));
    else localStorage.removeItem(WORKSPACE_SHELL_STORAGE_KEY);
  } catch (_) {}
}

loadWorkspaceShellStates();

function workspaceShellKey(id = state.ws) {
  if (id && typeof id === "object") return id.workspace_id || workspacePath(id) || "__default_folder__";
  if (id) return id;
  const workspace = selectedOrDefaultWorkspace(id);
  return (workspace && workspace.workspace_id) || "__default_folder__";
}
function workspaceShellState(id = state.ws) {
  const key = workspaceShellKey(id);
  if (!state.workspaceShell[key]) {
    // A path entry can bridge a backend id change while the workspace stays open.
    // Close cleanup removes it before a later reopen can see it.
    const pathKey = shellPathKey(shellPathForId(id));
    const remembered = pathKey ? state.workspaceShell[pathKey] : null;
    state.workspaceShell[key] = remembered && isHostedShellMode(remembered.mode)
      ? { mode: remembered.mode }
      : { mode: "terminal" };
  }
  return state.workspaceShell[key];
}
function currentWorkspaceShellMode(id = state.ws) {
  const value = workspaceShellState(id).mode;
  return isHostedShellMode(value) ? value : "terminal";
}
function rememberWorkspaceShellMode(mode, id = state.ws) {
  const shell = workspaceShellState(id);
  shell.mode = isHostedShellMode(mode) ? mode : "terminal";
  syncWorkspaceShellPathEntry(id, shell);
  saveWorkspaceShellStates();
  syncShellModeButtons();
}
window.rememberWorkspaceShellMode = rememberWorkspaceShellMode;
function forgetWorkspaceShell(id) {
  delete state.workspaceShell[workspaceShellKey(id)];
  const pathKey = shellPathKey(shellPathForId(id));
  if (pathKey) delete state.workspaceShell[pathKey];
  saveWorkspaceShellStates();
  const closingId = id && typeof id === "object" ? id.workspace_id : id;
  if (state.ws !== closingId) syncShellModeButtons();
}
function pruneWorkspaceShellStates() {
  const keep = new Set();
  for (const workspace of state.workspaces || []) {
    keep.add(workspaceShellKey(workspace));
    const pathKey = shellPathKey(workspacePath(workspace));
    if (pathKey) keep.add(pathKey);
  }
  let removed = false;
  for (const key of Object.keys(state.workspaceShell)) {
    if (!keep.has(key)) {
      delete state.workspaceShell[key];
      removed = true;
    }
  }
  // prune runs on every poll; only touch storage when something changed.
  if (removed) saveWorkspaceShellStates();
}
function applyWorkspaceShellForSelection(id = state.ws) {
  const shell = workspaceShellState(id);
  if (shell.mode === "git") openWorkspaceGitUi(id, { forceOpen: true });
  else if (shell.mode === "files") openWorkspaceFileBrowser(id, { forceOpen: true });
  else if (shell.mode === "search") openWorkspaceSearchPanel(id, { forceOpen: true });
  else showTerminalShellMode({ forceOpen: true });
}
// The extended column always hosts one of Files/Git/Search. "terminal" is
// the pane-tab contract; expanding it picks the last hosted view this
// workspace used in this page session or files when nothing was ever hosted.
// Callers pass the result to the matching
// openWorkspace* so the panel mounts before the column expands.
function resolveHostedShellMode(id = state.ws) {
  const shell = workspaceShellState(id);
  if (isHostedShellMode(shell.mode)) return shell.mode;
  const pathKey = shellPathKey(shellPathForId(id));
  const remembered = pathKey ? state.workspaceShell[pathKey] : null;
  if (remembered && isHostedShellMode(remembered.mode)) return remembered.mode;
  return "files";
}
window.resolveHostedShellMode = resolveHostedShellMode;
