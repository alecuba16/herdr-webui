// Per-workspace shell mode (terminal/git/files) survives page reloads AND
// workspace reopens: the mode is remembered per workspace id (live sessions)
// and per folder path (recents), mirroring the server-persisted recents list.
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

function loadWorkspaceShellStates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACE_SHELL_STORAGE_KEY) || "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (!value || typeof value !== "object") continue;
        const mode = value.mode === "git" || value.mode === "files" ? value.mode : "terminal";
        state.workspaceShell[key] = { mode, minimized: !!value.minimized, at: value.at || 0 };
      }
    }
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
  state.workspaceShell[pathKey] = { mode: shell.mode, minimized: !!shell.minimized, at: Date.now() };
  trimWorkspaceShellPathEntries();
}

function saveWorkspaceShellStates() {
  try {
    localStorage.setItem(WORKSPACE_SHELL_STORAGE_KEY, JSON.stringify(state.workspaceShell));
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
    // A reopened recent workspace gets a fresh workspace id, so fall back to
    // the shell mode remembered for the same folder. Reopens always start
    // un-minimized: the user asked to open the workspace, not hide it.
    const pathKey = shellPathKey(shellPathForId(id));
    const remembered = pathKey ? state.workspaceShell[pathKey] : null;
    state.workspaceShell[key] = remembered
      ? { mode: remembered.mode === "git" || remembered.mode === "files" ? remembered.mode : "terminal", minimized: false }
      : { mode: "terminal", minimized: false };
  }
  return state.workspaceShell[key];
}
function currentWorkspaceShellMode(id = state.ws) {
  const value = workspaceShellState(id).mode;
  return value === "git" || value === "files" ? value : "terminal";
}
function rememberWorkspaceShellMode(mode, id = state.ws, options = {}) {
  const shell = workspaceShellState(id);
  shell.mode = mode === "git" || mode === "files" ? mode : "terminal";
  if (Object.prototype.hasOwnProperty.call(options, "minimized")) shell.minimized = !!options.minimized;
  syncWorkspaceShellPathEntry(id, shell);
  saveWorkspaceShellStates();
  syncWorkspaceShellRestoreControl();
  syncShellModeButtons();
}
window.rememberWorkspaceShellMode = rememberWorkspaceShellMode;
function isWorkspaceShellMinimized(id = state.ws) {
  return !!workspaceShellState(id).minimized;
}
function hideWorkspaceShellSurfaces() {
  if (window.HerdrGitUi) window.HerdrGitUi.hide();
  if (window.HerdrFileBrowser) window.HerdrFileBrowser.hide();
  const shell = el("terminalShell");
  if (shell) shell.style.display = "none";
}
function minimizeWorkspaceShell(id = state.ws) {
  const shell = workspaceShellState(id);
  shell.minimized = true;
  syncWorkspaceShellPathEntry(id, shell);
  saveWorkspaceShellStates();
  hideWorkspaceShellSurfaces();
  syncWorkspaceShellRestoreControl();
  syncShellModeButtons();
}
function workspaceShellRestoreLabel(mode) {
  if (mode === "git") return "Show Git";
  if (mode === "files") return "Show Files";
  return "Show terminal";
}
function syncWorkspaceShellRestoreControl() {
  let button = el("workspaceShellRestore");
  const shell = workspaceShellState();
  if (!shell.minimized) {
    if (button) button.remove();
    return;
  }
  if (!button) {
    button = document.createElement("button");
    button.id = "workspaceShellRestore";
    button.className = "workspace-shell-restore";
    button.onclick = () => restoreWorkspaceShell();
    document.body.appendChild(button);
  }
  const label = workspaceShellRestoreLabel(shell.mode);
  button.textContent = label;
  button.title = `${label} for this workspace`;
  button.setAttribute("aria-label", button.title);
}
function forgetWorkspaceShell(id) {
  delete state.workspaceShell[workspaceShellKey(id)];
  saveWorkspaceShellStates();
  syncWorkspaceShellRestoreControl();
  syncShellModeButtons();
}
function pruneWorkspaceShellStates() {
  const keep = new Set((state.workspaces || []).map((workspace) => workspace.workspace_id));
  keep.add("__default_folder__");
  // path: entries survive closes so a recent reopen can restore the mode;
  // they are bounded by trimWorkspaceShellPathEntries instead of pruned here.
  let removed = false;
  for (const key of Object.keys(state.workspaceShell))
    if (!key.startsWith(WORKSPACE_SHELL_PATH_PREFIX) && !keep.has(key)) {
      delete state.workspaceShell[key];
      removed = true;
    }
  // prune runs on every poll; only touch storage when something changed.
  if (removed) saveWorkspaceShellStates();
  syncWorkspaceShellRestoreControl();
}
async function restoreWorkspaceShell(id = state.ws) {
  const shell = workspaceShellState(id);
  shell.minimized = false;
  syncWorkspaceShellPathEntry(id, shell);
  saveWorkspaceShellStates();
  syncWorkspaceShellRestoreControl();
  if (shell.mode === "git") await openWorkspaceGitUi(id, { forceOpen: true });
  else if (shell.mode === "files") await openWorkspaceFileBrowser(id, { forceOpen: true });
  else showTerminalShellMode({ forceOpen: true });
}
function applyWorkspaceShellForSelection(id = state.ws) {
  const shell = workspaceShellState(id);
  if (shell.minimized) {
    hideWorkspaceShellSurfaces();
    syncWorkspaceShellRestoreControl();
    syncShellModeButtons();
    return;
  }
  if (shell.mode === "git") openWorkspaceGitUi(id, { forceOpen: true });
  else if (shell.mode === "files") openWorkspaceFileBrowser(id, { forceOpen: true });
  else showTerminalShellMode({ forceOpen: true });
}
