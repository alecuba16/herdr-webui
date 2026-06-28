function openWorkspaceCreateModal() {
  clearTimeout(state.workspaceCreatePathSuggestTimer);
  state.workspaceCreateSuggestedLabel = "";
  el("workspaceCreatePath").value = "";
  el("workspaceCreateLabel").value = "";
  el("workspaceCreateError").textContent = "";
  syncDirectoryPathOptions("workspacePathOptions", []);
  el("workspaceCreateModal").style.display = "grid";
  setTimeout(() => el("workspaceCreatePath").focus(), 0);
}
function closeWorkspaceCreateModal() {
  clearTimeout(state.workspaceCreatePathSuggestTimer);
  el("workspaceCreateModal").style.display = "none";
}
function focusWorkspaceCreateLabel() {
  syncWorkspaceCreateLabel();
  el("workspaceCreateLabel").focus();
  el("workspaceCreateLabel").select();
}
function suggestedWorkspaceLabel(path) {
  return pathBasename(path) || "workspace";
}
function syncWorkspaceCreateLabel() {
  const pathInput = el("workspaceCreatePath"),
    labelInput = el("workspaceCreateLabel"),
    previous = state.workspaceCreateSuggestedLabel || "",
    next = suggestedWorkspaceLabel(pathInput.value.trim());
  if (!labelInput.value.trim() || labelInput.value.trim() === previous)
    labelInput.value = next;
  state.workspaceCreateSuggestedLabel = next;
}
async function loadWorkspacePathSuggestions() {
  await loadDirectoryPathSuggestions(
    "workspaceCreatePath",
    (items) => syncDirectoryPathOptions("workspacePathOptions", items),
  );
}
async function createWorkspaceFromModal() {
  const err = el("workspaceCreateError"),
    submit = el("workspaceCreateSubmit"),
    cwd = el("workspaceCreatePath").value.trim(),
    label = el("workspaceCreateLabel").value.trim();
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
    closeWorkspaceCreateModal();
    const ws = r.result.workspace.workspace_id;
    go(ws);
  } catch (ex) {
    err.textContent = ex.message || String(ex);
  } finally {
    submit.disabled = false;
  }
}
newWs.onclick = () => {
  openWorkspaceCreateModal();
};
el("workspaceCreateClose").onclick = closeWorkspaceCreateModal;
el("workspaceCreateCancel").onclick = closeWorkspaceCreateModal;
el("questionClose").onclick = () => closeQuestion(false);
el("questionCancel").onclick = () => closeQuestion(false);
el("questionConfirm").onclick = () => closeQuestion(true);
el("workspaceCreateForm").onsubmit = (e) => {
  e.preventDefault();
  if (document.activeElement === el("workspaceCreatePath")) {
    focusWorkspaceCreateLabel();
    return;
  }
  createWorkspaceFromModal();
};
function workspaceCreatePathChanged() {
  syncWorkspaceCreateLabel();
  scheduleWorkspacePathSuggestions();
}
el("workspaceCreatePath").addEventListener("input", workspaceCreatePathChanged);
el("workspaceCreatePath").addEventListener("change", workspaceCreatePathChanged);
el("themeToggle").onclick = () => {
  themeMode =
    themeMode === "auto" ? "dark" : themeMode === "dark" ? "light" : "auto";
  applyTheme();
};
