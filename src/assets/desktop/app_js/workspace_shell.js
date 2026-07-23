function workspaceShellKey(id = state.ws) {
  if (id && typeof id === "object") return id.workspace_id || workspacePath(id) || "__default_folder__";
  if (id) return id;
  const workspace = selectedOrDefaultWorkspace(id);
  return (workspace && workspace.workspace_id) || "__default_folder__";
}
function workspaceShellState(id = state.ws) {
  const key = workspaceShellKey(id);
  if (!state.workspaceShell[key]) state.workspaceShell[key] = { mode: "terminal", minimized: false };
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
  syncWorkspaceShellRestoreControl();
  syncShellModeButtons();
}
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
  syncWorkspaceShellRestoreControl();
  syncShellModeButtons();
}
function pruneWorkspaceShellStates() {
  const keep = new Set((state.workspaces || []).map((workspace) => workspace.workspace_id));
  keep.add("__default_folder__");
  for (const key of Object.keys(state.workspaceShell)) if (!keep.has(key)) delete state.workspaceShell[key];
  syncWorkspaceShellRestoreControl();
}
async function restoreWorkspaceShell(id = state.ws) {
  const shell = workspaceShellState(id);
  shell.minimized = false;
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
