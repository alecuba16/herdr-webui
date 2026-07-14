document.addEventListener("click", (e) => {
  if (state.panelMenuOpen && (!e.target || !e.target.closest || !e.target.closest(".panel-field"))) {
    state.panelMenuOpen = false;
    render();
  }
  const workspaceAction = e.target && e.target.closest && e.target.closest("[data-workspace-action]");
  if (workspaceAction) {
    e.preventDefault();
    e.stopPropagation();
    runWorkspaceContextAction(workspaceAction.dataset.workspaceAction, workspaceAction);
    return;
  }
  const option = e.target && e.target.closest && e.target.closest(".no-sleep-menu [data-mode]");
  if (option) {
    closeNoSleepMenus();
    setNoSleepMode(option.dataset.mode || "off");
    return;
  }
  const control = e.target && e.target.closest && e.target.closest(".no-sleep-control");
  if (control) {
    const wrap = control.closest(".no-sleep-wrap");
    const menu = wrap && wrap.querySelector(".no-sleep-menu");
    if (menu) {
      const nextHidden = !menu.hidden;
      closeNoSleepMenus(menu);
      menu.hidden = nextHidden;
    }
    return;
  }
  if (!e.target || !e.target.closest || !e.target.closest(".no-sleep-wrap")) closeNoSleepMenus();
});
if (window.matchMedia) {
  try {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    if (media.addEventListener)
      media.addEventListener("change", () => {
        if (themeMode === "auto") applyTheme();
      });
    else if (media.addListener)
      media.addListener(() => {
        if (themeMode === "auto") applyTheme();
      });
  } catch (e) {}
}
document.addEventListener("visibilitychange", () => {
  syncBrowserFavicon();
});
setInterval(pollAutoTheme, 2000);
let settingsBackdropDown = false,
  shortcutsBackdropDown = false;
el("settingsToggle").onclick = () => {
  el("settingsModal").style.display = "grid";
  prepareSettingsModalOpen();
};
el("settingsClose").onclick = () => {
  el("settingsModal").style.display = "none";
};
el("settingsModal").addEventListener("pointerdown", (e) => {
  settingsBackdropDown = e.target === el("settingsModal");
});
el("settingsModal").addEventListener("click", (e) => {
  if (settingsBackdropDown && e.target === el("settingsModal"))
    el("settingsModal").style.display = "none";
  settingsBackdropDown = false;
});
el("shortcutsToggle").onclick = () => {
  applyOptions();
  el("shortcutsModal").style.display = "grid";
};
el("shortcutsClose").onclick = () => {
  el("shortcutsModal").style.display = "none";
};
el("shortcutsCloseTop").onclick = () => {
  el("shortcutsModal").style.display = "none";
};
el("searchPaletteClose").onclick = closeSearchPalette;
el("searchPaletteInput").oninput = scheduleSearch;
el("searchPaletteInput").onkeydown = searchPaletteKeydown;
el("searchPalette").addEventListener("click", (e) => {
  if (e.target === el("searchPalette")) closeSearchPalette();
});
el("shortcutsModal").addEventListener("pointerdown", (e) => {
  shortcutsBackdropDown = e.target === el("shortcutsModal");
});
el("shortcutsModal").addEventListener("click", (e) => {
  const record = e.target && e.target.closest && e.target.closest("[data-shortcut-record]");
  if (record) {
    e.preventDefault();
    const [scope, action] = record.dataset.shortcutRecord.split(":");
    recordShortcut(scope, action, record);
    shortcutsBackdropDown = false;
    return;
  }
  const reset = e.target && e.target.closest && e.target.closest("[data-shortcut-reset]");
  if (reset) {
    e.preventDefault();
    const [scope, action] = reset.dataset.shortcutReset.split(":");
    resetShortcut(scope, action);
    shortcutsBackdropDown = false;
    return;
  }
  if (shortcutsBackdropDown && e.target === el("shortcutsModal"))
    el("shortcutsModal").style.display = "none";
  shortcutsBackdropDown = false;
});
el("optTheme").onchange = () => {
  themeMode = normalizeThemeMode(el("optTheme").value);
  applyTheme();
};
el("themeColorsApply").onclick = applyThemeColorsFromSettings;
el("themeColorsReset").onclick = () => applyThemeColorProfile("default");
el("themeColorsApplyProfile").onclick = () => {
  applyThemeColorProfile(el("themeColorProfile").value);
};
el("serverSettingsLoad").onclick = loadServerSettings;
el("serverSettingsApply").onclick = applyServerSettings;
el("optOverflow").onchange = () => {
  options.overflow = el("optOverflow").checked;
  options.terminalOverflowOptIn = true;
  saveOptions();
  applyOptions();
  const refitTerminal = () => {
    if (typeof fitTerminalShell === "function") fitTerminalShell();
    if (typeof fitTerminalSurface === "function") fitTerminalSurface();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(refitTerminal);
  else refitTerminal();
};
el("optFit").onchange = () => {
  options.fitToBrowser = el("optFit").checked;
  saveOptions();
  applyOptions();
};
el("optShiftEnterNewline").onchange = () => {
  options.shiftEnterNewline = el("optShiftEnterNewline").checked;
  saveOptions();
  applyOptions();
};
el("optCloseShortcut").oninput = saveCloseShortcutOption;
el("optCloseShortcut").onchange = saveCloseShortcutOption;
el("optGlobalShortcutsEnabled").onchange = () => {
  options.globalShortcutsEnabled = el("optGlobalShortcutsEnabled").checked;
  saveOptions();
  applyOptions();
};
el("optGlobalShortcutPrefixCapture").onclick = () => {
  const button = el("optGlobalShortcutPrefixCapture"),
    input = el("optGlobalShortcutPrefix");
  button.textContent = "Press keys...";
  if (input) input.value = "Press keys...";
  const capture = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    const prefix = shortcutPrefixFromEvent(e);
    if (prefix) {
      options.globalShortcutPrefix = prefix;
      saveOptions();
    }
    button.textContent = "Record";
    applyOptions();
  };
  window.addEventListener("keydown", capture, { once: true, capture: true });
};
el("optTerminalFontFamily").oninput = () => {
  options.terminalFontFamily = el("optTerminalFontFamily").value;
  saveOptions();
  applyTerminalFont();
  fitTerminalShell();
};
el("optTerminalLinks").onchange = () => {
  options.terminalLinks = el("optTerminalLinks").checked;
  saveOptions();
  applyTerminalLinks();
};
el("optAgentSortMode").onchange = () => {
  options.agentSortMode = el("optAgentSortMode").value;
  if (options.agentSortMode === "attention_inverted")
    options.agentStatusOrder = normalizeAgentStatusOrder(workingFirstAgentStatusOrder);
  saveOptions();
  applyOptions();
  render();
};
const optSidebarWorkspacePercent = el("optSidebarWorkspacePercent");
if (optSidebarWorkspacePercent)
  optSidebarWorkspacePercent.oninput = () => {
    setSidebarWorkspacePercent(optSidebarWorkspacePercent.value);
  };
const sidebarSplitHandle = el("sidebarSplitHandle");
if (sidebarSplitHandle) {
  let pendingSidebarWorkspacePercent = null;
  const resizeFromClientY = (clientY) => {
    const split = sidebarSplitHandle.parentElement;
    if (!split) return;
    const rect = split.getBoundingClientRect();
    const percent = ((clientY - rect.top) / rect.height) * 100;
    pendingSidebarWorkspacePercent = previewSidebarWorkspacePercent(percent);
  };
  sidebarSplitHandle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sidebarSplitHandle.setPointerCapture(e.pointerId);
    sidebarSplitHandle.classList.add("dragging");
    resizeFromClientY(e.clientY);
  });
  sidebarSplitHandle.addEventListener("pointermove", (e) => {
    if (!sidebarSplitHandle.hasPointerCapture(e.pointerId)) return;
    resizeFromClientY(e.clientY);
  });
  const stopResize = (e) => {
    if (sidebarSplitHandle.hasPointerCapture(e.pointerId))
      sidebarSplitHandle.releasePointerCapture(e.pointerId);
    sidebarSplitHandle.classList.remove("dragging");
    if (pendingSidebarWorkspacePercent !== null) {
      setSidebarWorkspacePercent(pendingSidebarWorkspacePercent);
      pendingSidebarWorkspacePercent = null;
    }
  };
  sidebarSplitHandle.addEventListener("pointerup", stopResize);
  sidebarSplitHandle.addEventListener("pointercancel", stopResize);
  sidebarSplitHandle.addEventListener("keydown", (e) => {
    if (!["ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    setSidebarWorkspacePercent(
      (options.sidebarWorkspacePercent || 68) + (e.key === "ArrowDown" ? 2 : -2),
    );
  });
}
el("optParentCloseMode").onchange = () => {
  options.parentCloseMode = el("optParentCloseMode").value;
  saveOptions();
  applyOptions();
};
el("optStuckWorkingEnabled").onchange = () => {
  options.stuckWorkingEnabled = el("optStuckWorkingEnabled").checked;
  saveOptions();
  applyOptions();
  render();
};
el("optWorkingDismissMinutes").oninput = () => {
  options.workingDismissMinutes = Math.max(
    1,
    Math.min(1440, Number(el("optWorkingDismissMinutes").value) || 30),
  );
  saveOptions();
  applyOptions();
  render();
};
el("optShowTabActivity").onchange = () => {
  options.showTabActivity = el("optShowTabActivity").checked;
  saveOptions();
  applyOptions();
  render();
};
el("optWorkspaceSort").onchange = () => {
  options.workspaceSort = el("optWorkspaceSort").value;
  saveOptions();
  applyOptions();
  render();
};
el("optSoundScope").onchange = () => {
  options.soundScope = el("optSoundScope").value;
  saveOptions();
  applyOptions();
};
const optNotificationVolume = el("optNotificationVolume");
if (optNotificationVolume)
  optNotificationVolume.oninput = () => {
    options.notificationVolume = Math.max(
      0,
      Math.min(100, Number(optNotificationVolume.value) || 0),
    ) / 100;
    saveOptions();
    applyOptions();
  };
el("optScrollLines").oninput = () => {
  options.scrollLines = Math.max(
    1,
    Math.min(20, Number(el("optScrollLines").value) || 3),
  );
  saveOptions();
  applyOptions();
};
el("optTreeIndentPx").oninput = () => {
  options.treeIndentPx = Math.max(0, Math.min(40, Number(el("optTreeIndentPx").value) || 0));
  saveOptions();
  applyOptions();
  render();
};
el("optFileBrowserAllowParent").onchange = () => {
  options.fileBrowserAllowParent = el("optFileBrowserAllowParent").checked;
  saveOptions();
  applyOptions();
};
el("optFileBrowserGitStatus").onchange = () => {
  options.fileBrowserGitStatus = el("optFileBrowserGitStatus").checked;
  saveOptions();
};
el("optFileBrowserLineNumbers").onchange = () => {
  options.fileBrowserLineNumbers = el("optFileBrowserLineNumbers").checked;
  saveOptions();
};
el("optHeaderSearchEnabled").onchange = () => {
  options.headerSearchEnabled = el("optHeaderSearchEnabled").checked;
  saveOptions();
  applyOptions();
};
el("optFileBrowserSearchPageSize").oninput = () => {
  options.fileBrowserSearchPageSize = Math.max(10, Math.min(500, Number(el("optFileBrowserSearchPageSize").value) || 100));
  saveOptions();
};
el("optFileContentSearchMinChars").oninput = () => {
  options.fileContentSearchMinChars = Math.max(1, Math.min(20, Number(el("optFileContentSearchMinChars").value) || 3));
  saveOptions();
};
el("optFileContentSearchPageSize").oninput = () => {
  options.fileContentSearchPageSize = Math.max(10, Math.min(500, Number(el("optFileContentSearchPageSize").value) || 50));
  saveOptions();
};
el("optFileContentSearchContextLines").oninput = () => {
  const value = Number(el("optFileContentSearchContextLines").value);
  options.fileContentSearchContextLines = Math.max(0, Math.min(20, Number.isFinite(value) ? value : 2));
  saveOptions();
};
el("optFileContentSearchAutoCollapseFiles").oninput = () => {
  options.fileContentSearchAutoCollapseFiles = Math.max(0, Math.min(200, Number(el("optFileContentSearchAutoCollapseFiles").value) || 0));
  saveOptions();
};
el("optFileContentSearchDefaultExpanded").onchange = () => {
  options.fileContentSearchDefaultExpanded = el("optFileContentSearchDefaultExpanded").checked;
  saveOptions();
};
el("optFileContentSearchMatchesPerFile").oninput = () => {
  options.fileContentSearchMatchesPerFile = Math.max(1, Math.min(50, Number(el("optFileContentSearchMatchesPerFile").value) || 5));
  saveOptions();
};
el("optFileContentSearchMatchCase").onchange = () => {
  options.fileContentSearchMatchCase = el("optFileContentSearchMatchCase").checked;
  saveOptions();
};
el("optFileContentSearchRegex").onchange = () => {
  options.fileContentSearchRegex = el("optFileContentSearchRegex").checked;
  saveOptions();
};
el("optWorktreeAutoDiscover").oninput = () => {
  options.worktreeAutoDiscoverSeconds = Math.max(
    0,
    Math.min(30, Number(el("optWorktreeAutoDiscover").value) || 0),
  );
  saveOptions();
  applyOptions();
  scheduleWorktreeAutodiscover();
};
el("optGenerateWorktreeNames").onchange = () => {
  options.generateWorktreeNames = el("optGenerateWorktreeNames").checked;
  saveOptions();
  applyOptions();
};
el("optWorktreeDefaultDirectory").oninput = () => {
  options.worktreeDefaultDirectory = el("optWorktreeDefaultDirectory").value.trim();
  saveOptions();
  syncWorktreeCheckoutPath();
};
el("optExplorationDefaultDirectory").oninput = () => {
  options.explorationDefaultDirectory = el("optExplorationDefaultDirectory").value.trim();
  saveOptions();
};
el("optSound").onchange = () => {
  options.sound = el("optSound").checked;
  saveOptions();
  applyOptions();
};
el("optBrowserNotifications").onchange = () => {
  setBrowserNotifications(el("optBrowserNotifications").checked);
};
for (const module of settingsModules) {
  if (typeof module.bind === "function") {
    module.bind({
      el,
      saveOptions,
      applyOptions,
      setOption(key, value) {
        options[key] = value;
      },
      getOption(key) {
        return options[key];
      },
    });
  }
}
el("worktreeCreateClose").onclick = closeWorktreeCreateModal;
el("worktreeCreateCancel").onclick = closeWorktreeCreateModal;
el("worktreeCreateSource").oninput = () => {
  scheduleCreateWorktreeAutodiscover();
};
el("worktreeCreateSource").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearCreateWorktreeSuggestions();
    discoverCreateWorktreeSource();
  }
});
el("worktreeBranch").addEventListener("input", syncCreateWorktreeCheckoutPath);
el("worktreeBranch").addEventListener("change", syncCreateWorktreeCheckoutPath);
el("worktreeCreateForm").onsubmit = async (e) => {
  e.preventDefault();
  const source = resolveWorktreeSource({
    workspaceId: state.createWorktreeWorkspace,
    sourcePath: el("worktreeCreateSource").value,
    originalSource: state.createWorktreeOriginalSource,
  });
  const pullBase = el("worktreePullBase").checked;
  if (pullBase && el("worktreeCreateSource").value.trim()) {
    source.workspace_id = null;
    source.cwd = el("worktreeCreateSource").value.trim();
  }
  await submitWorktreeCreate({
    errEl: el("worktreeCreateError"),
    submitEl: el("worktreeCreateSubmit"),
    closeFn: closeWorktreeCreateModal,
    source,
    branch: el("worktreeBranch").value,
    base: el("worktreeBase").value,
    label: el("worktreeLabel").value,
    path: el("worktreePath").value,
    pullBase,
  });
};
el("worktreeOpenClose").onclick = closeWorktreeOpenModal;
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Escape") return;
    if (el("workspaceCreateModal").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeWorkspaceCreateModal();
    } else if (el("worktreeOpenModal").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeWorktreeOpenModal();
    } else if (el("worktreeCreateModal").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeWorktreeCreateModal();
    } else if (el("searchPalette").style.display === "grid") {
      e.preventDefault();
      e.stopPropagation();
      closeSearchPalette();
    }
  },
  true,
);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Tab") return;
  const modalIds = [
    "settingsModal",
    "worktreeCreateModal",
    "worktreeOpenModal",
    "workspaceCreateModal",
    "shortcutsModal",
    "searchPalette",
  ];
  const modal = modalIds
    .map((id) => el(id))
    .find((m) => m && m.style.display === "grid");
  if (!modal) return;
  const focusable = modal.querySelectorAll(
    'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  if (!focusable.length) {
    e.preventDefault();
    return;
  }
  const filtered = Array.from(focusable).filter(
    (f) => f.offsetParent !== null || f === document.activeElement,
  );
  if (!filtered.length) return;
  const active = document.activeElement;
  const first = filtered[0],
    last = filtered[filtered.length - 1];
  if (e.shiftKey) {
    if (active === first || !modal.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else {
    if (active === last || !modal.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }
});
el("worktreeOpenRefresh").onclick = async () => {
  await refresh();
  if (el("worktreeDiscoverPath").value.trim()) await discoverWorktrees();
  else {
    syncWorktreePathOptions(validOpenWorktreeRows());
    renderWorktreeOpenList();
  }
};
el("worktreeNewForm").onsubmit = (e) => {
  e.preventDefault();
  createDiscoveredWorktree();
};
el("worktreeWorkspaceSubmit").onclick = createWorkspaceFromSmartModal;
el("worktreeWorkspaceLabel").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    createWorkspaceFromSmartModal();
  }
});
el("worktreeNewBase").addEventListener("input", syncBranchNameFromBase);
el("worktreeNewBase").addEventListener("change", syncBranchNameFromBase);
el("worktreeFetchRemotes").onclick = fetchWorktreeRemoteBranches;
el("worktreeNewBranch").addEventListener("input", () => {
  if (el("worktreeNewBranch").value.trim() !== state.openWorktreeBaseBranchName)
    state.openWorktreeBaseBranchName = "";
  syncWorktreeCheckoutPath();
});
el("worktreeNewBranch").addEventListener("change", syncWorktreeCheckoutPath);
function worktreePathInputChanged() {
  if (state.openWorktreeSuggestionLocked) {
    state.openWorktreeSuggestionLocked = false;
    return;
  }
  syncSmartWorkspaceLabel();
  const value = el("worktreeDiscoverPath").value.trim();
  const currentSource = worktreeSourceKey(state.openWorktreeSource);
  if (currentSource && currentSource !== value) {
    state.openWorktreeSource = null;
    state.openWorktreeRows = [];
    state.openWorktreeAllRows = [];
    state.openWorktreeBranchSourceKey = "";
    syncWorktreeBranchOptions([]);
  }
  const idx = (state.openWorktreeRows || []).findIndex(
    (w) => textValue(w.path) === value && w.is_linked_worktree,
  );
  state.openWorktreeSelected = idx >= 0 ? idx : null;
  renderWorktreeOpenList();
  scheduleWorktreeAutodiscover();
}
el("worktreeDiscoverPath").addEventListener("input", worktreePathInputChanged);
el("worktreeDiscoverPath").addEventListener("change", worktreePathInputChanged);
el("worktreeDiscoverPath").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    state.openWorktreeSuggestionLocked = true;
    renderPathOptions("worktreePathOptions", []);
    syncSmartWorkspaceLabel();
    discoverWorktrees();
  }
});
if (window.HerdrDirectoryPicker) {
  [
    "workspaceCreatePath",
    "worktreeDiscoverPath",
    "worktreeCreateSource",
    "worktreePath",
    "worktreeNewPath",
  ].forEach((id) => window.HerdrDirectoryPicker.attach(id));
}
const terminalFollowButton = el("terminalFollowButton");
if (terminalFollowButton) terminalFollowButton.onclick = scrollTerminalToBottom;
function editableEventTarget(e) {
  const t = e.target;
  return (
    t &&
    (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))
  );
}
el("copyMenu").onclick = copySelection;
el("pasteMenu").onclick = pasteClipboard;
document.addEventListener("click", (e) => {
  const menu = el("clipboardMenu");
  if (menu && !menu.contains(e.target)) hideClipboardMenu();
});
window.addEventListener("keydown", closeShortcutKeydown, true);
window.addEventListener("keydown", handleGlobalShortcut, true);
document.addEventListener("keydown", (e) => {
  if (editableEventTarget(e)) return;
  const copyKey =
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey &&
    e.key.toLowerCase() === "c";
  const pasteKey =
    (e.metaKey || e.ctrlKey) &&
    !e.shiftKey &&
    !e.altKey &&
    e.key.toLowerCase() === "v";
  if (copyKey && term && term.getSelection && term.getSelection()) {
    e.preventDefault();
    copySelection();
  } else if (pasteKey) {
    e.preventDefault();
    pasteClipboard();
  }
});
window.onpopstate = refresh;
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(noSleepPollTimer);
    hiddenTimer = setTimeout(() => {
      if (eventWs) eventWs.close();
      if (termWs) termWs.close();
    }, 1000);
  } else {
    clearTimeout(hiddenTimer);
    loadVersions();
    refresh();
    connectEvents();
    loadNoSleep();
  }
});
window.addEventListener("focus", loadNoSleep);
document.addEventListener("pointerdown", unlockAudio, { once: true });
document.addEventListener("keydown", unlockAudio, { once: true });
setupSessionChrome();
applyTheme();
applyOptions();
syncNoSleepControls();
loadNoSleep();
loadVersions();
loadServerSettings();
refresh();
connectEvents();

// Ephemeral temporary terminal overlay.
if (globalThis.HerdrTempTerminal && el("tempTerminalModal")) {
  tempTerminal = globalThis.HerdrTempTerminal.create({
    el,
    state,
    wsUrl,
    api,
    modalId: "tempTerminalModal",
    containerId: "tempTerminal",
    closeId: "tempTerminalClose",
    fontFamilyFn: terminalFontFamily,
    themeFn: terminalTheme,
    defaultFolderFn: defaultFolderPath,
  });
  const tempTerminalClose = el("tempTerminalClose");
  const tempTerminalModal = el("tempTerminalModal");
  if (tempTerminalClose) tempTerminalClose.onclick = () => tempTerminal.requestClose();
  window.addEventListener("resize", () => tempTerminal.handleResize());
}
