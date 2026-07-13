function shortcutW(e) {
  return String(e.key || "").toLowerCase() === "w" || e.code === "KeyW";
}
function shortcutSpace(e) {
  return e.code === "Space" || e.key === " " || e.key === "Spacebar";
}
function handleCloseShortcut(e) {
  const mode = options.closeShortcut || "off";
  if (
    mode === "altw" &&
    e.altKey &&
    !e.metaKey &&
    !e.ctrlKey &&
    !e.shiftKey &&
    shortcutW(e)
  )
    return closeCurrentPanelShortcut();
  if (mode === "shiftspacew") {
    const now = Date.now();
    if (
      e.shiftKey &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      shortcutSpace(e)
    ) {
      closeChordUntil = now + 1500;
      return true;
    }
    if (
      closeChordUntil > now &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      shortcutW(e)
    ) {
      closeChordUntil = 0;
      return closeCurrentPanelShortcut();
    }
    if (!e.shiftKey && !shortcutW(e)) closeChordUntil = 0;
  }
  return false;
}
function closeCurrentPanelShortcut(force = false) {
  if ((!force && (options.closeShortcut || "off") === "off") || !state.tab)
    return false;
  closeTab(state.tab);
  return true;
}
function tempTerminalModalOpen() {
  const modal = el("tempTerminalModal");
  return !!(modal && modal.style.display && modal.style.display !== "none");
}
function closeShortcutKeydown(e) {
  if (tempTerminalModalOpen()) return false;
  if (!handleCloseShortcut(e)) return false;
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  return true;
}
function showShortcutsModal() {
  applyOptions();
  el("shortcutsModal").style.display = "grid";
}
function showSettingsModal() {
  el("settingsModal").style.display = "grid";
  prepareSettingsModalOpen();
}
function currentWorkspace() {
  return state.workspaces.find((w) => w.workspace_id === state.ws) || null;
}
function orderedWorkspaceIds() {
  return state.workspaces.map((w) => w.workspace_id).filter(Boolean);
}
function selectRelativeWorkspace(delta) {
  const ids = orderedWorkspaceIds();
  if (!ids.length) return false;
  const current = Math.max(0, ids.indexOf(state.ws));
  const next = ids[(current + delta + ids.length) % ids.length];
  go(next);
  return true;
}
function selectRelativePanel(delta) {
  const tabs = state.tabs.map((t) => t.tab_id).filter(Boolean);
  if (!tabs.length) return false;
  const current = Math.max(0, tabs.indexOf(state.tab));
  const next = tabs[(current + delta + tabs.length) % tabs.length];
  go(state.ws, next);
  return true;
}
function agentCycleRank(agent) {
  const status = isWorkingDismissed(agent)
    ? "idle"
    : statusClass(agent.agent_status);
  return { blocked: 0, done: 1, idle: 2, working: 3 }[status] ?? 4;
}
function agentCycleList() {
  return state.agents
    .filter((agent) => agentCycleRank(agent) < 4)
    .slice()
    .sort((a, b) => agentCycleRank(a) - agentCycleRank(b));
}
function selectRelativeAgent(delta) {
  const list = agentCycleList();
  if (!list.length) return false;
  const current = list.findIndex(
    (a) =>
      a.workspace_id === state.ws &&
      a.tab_id === state.tab &&
      a.pane_id === state.pane,
  );
  const agent = list[(current + delta + list.length) % list.length];
  go(agent.workspace_id, agent.tab_id, agent.pane_id);
  return true;
}
function removeCurrentWorktreeShortcut() {
  const workspace = currentWorkspace();
  if (!isLinkedWorktree(workspace)) return false;
  removeWorktree(workspace.workspace_id);
  return true;
}
function focusRelativeControl(delta) {
  const controls = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter((node) => {
      if (node.disabled || node.getAttribute("aria-hidden") === "true")
        return false;
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  if (!controls.length) return false;
  const current = controls.indexOf(document.activeElement);
  controls[(current + delta + controls.length) % controls.length].focus();
  return true;
}
function editableShortcutTarget(target) {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return !!target.closest("input, textarea, select, [contenteditable='true']");
}
function terminalShortcutTarget(target) {
  return !!(target && target.closest && target.closest(".xterm"));
}
function shortcutKey(e) {
  const shift = e.shiftKey ? "Shift+" : "";
  return `${shift}${e.code || e.key}`;
}
function keyNameFromEvent(e) {
  const key = String(e.key || "");
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key || String(e.code || "").replace(/^Key/, "");
}
function shortcutPrefixFromEvent(e) {
  const mods = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push("Meta");
  const key = keyNameFromEvent(e);
  if (!key || ["Control", "Alt", "Shift", "Meta"].includes(key)) return "";
  return mods.concat(key).join("+");
}
function globalShortcutPrefixLabel() {
  try {
    return normalizeShortcutPrefix(
      options && options.globalShortcutPrefix,
      DEFAULT_GLOBAL_SHORTCUT_PREFIX,
    );
  } catch (_) {
    return DEFAULT_GLOBAL_SHORTCUT_PREFIX;
  }
}
function searchShortcutLabel() {
  return options.searchShortcut === "off" ? "Disabled" : options.searchShortcut;
}
function isShortcutPrefix(e) {
  return shortcutPrefixFromEvent(e) === globalShortcutPrefixLabel();
}
function isSearchShortcut(e) {
  return options.searchShortcut !== "off" && shortcutPrefixFromEvent(e) === options.searchShortcut;
}
function showShortcutPrefixOverlay() {
  shortcutPrefixUntil = Date.now() + 5000;
  const overlay = el("shortcutPrefixOverlay");
  if (overlay) overlay.hidden = false;
  clearTimeout(shortcutPrefixTimer);
  shortcutPrefixTimer = setTimeout(hideShortcutPrefixOverlay, 5000);
}
function hideShortcutPrefixOverlay() {
  shortcutPrefixUntil = 0;
  clearTimeout(shortcutPrefixTimer);
  shortcutPrefixTimer = null;
  const overlay = el("shortcutPrefixOverlay");
  if (overlay) overlay.hidden = true;
}
function runPrefixedShortcut(e) {
  const actions = {
    search: () => {
      openSearchPalette();
      return true;
    },
    help: () => {
      showShortcutsModal();
      return true;
    },
    settings: () => {
      showSettingsModal();
      return true;
    },
    sidebar: () => {
      sidebarToggle && sidebarToggle.click();
      return true;
    },
    newWorkspace: () => {
      openWorktreeOpenModal();
      return true;
    },
    newPanel: () => {
      if (state.ws) newTab();
      return true;
    },
    openWorktrees: () => {
      openWorktreeOpenModal();
      return true;
    },
    createWorktree: () => {
      if (state.ws) openWorktreeCreateModal(state.ws);
      return true;
    },
    closePanel: () => {
      return closeCurrentPanelShortcut(true);
    },
    closeWorkspace: () => {
      if (state.ws) closeWorkspace(state.ws);
      return true;
    },
    removeWorktree: () => {
      return removeCurrentWorktreeShortcut();
    },
    removeWorktreeAlt: () => {
      return removeCurrentWorktreeShortcut();
    },
    nextAgent: () => {
      return selectRelativeAgent(1);
    },
    prevAgent: () => {
      return selectRelativeAgent(-1);
    },
    nextWorkspace: () => {
      return selectRelativeWorkspace(1);
    },
    prevWorkspace: () => {
      return selectRelativeWorkspace(-1);
    },
    nextPanel: () => {
      return selectRelativePanel(1);
    },
    prevPanel: () => {
      return selectRelativePanel(-1);
    },
    focusTerminal: () => {
      focusTerminal(true);
      return true;
    },
    focusNext: () => {
      return focusRelativeControl(1);
    },
    focusPrev: () => {
      return focusRelativeControl(-1);
    },
  };
  const key = shortcutKey(e);
  const entry = Object.entries(options.webuiShortcuts || {}).find(([, value]) => value === key);
  if (entry && actions[entry[0]]) return actions[entry[0]]();
  return false;
}
function consumeShortcutEvent(e) {
  e.preventDefault();
  e.stopPropagation();
  if (e.stopImmediatePropagation) e.stopImmediatePropagation();
  return true;
}
function handleGlobalShortcut(e) {
  if (e.defaultPrevented || options.globalShortcutsEnabled === false) return false;
  if (modalOpen()) {
    hideShortcutPrefixOverlay();
    return false;
  }
  if (isSearchShortcut(e)) {
    if (editableShortcutTarget(e.target) && !terminalShortcutTarget(e.target))
      return false;
    openSearchPalette();
    return consumeShortcutEvent(e);
  }
  const prefixActive = shortcutPrefixUntil > Date.now();
  if (prefixActive) {
    hideShortcutPrefixOverlay();
    if (e.key === "Escape") return consumeShortcutEvent(e);
    runPrefixedShortcut(e);
    return consumeShortcutEvent(e);
  }
  if (!isShortcutPrefix(e)) return false;
  if (editableShortcutTarget(e.target) && !terminalShortcutTarget(e.target))
    return false;
  showShortcutPrefixOverlay();
  return consumeShortcutEvent(e);
}
