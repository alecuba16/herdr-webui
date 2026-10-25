(function () {
  const DEFAULT_GIT_SHORTCUTS = {
    changes: "Digit1",
    commit: "Digit2",
    log: "Digit3",
    stash: "Digit4",
    commitAlt: "KeyC",
    logAlt: "KeyL",
    refresh: "KeyR",
    stageAll: "KeyG",
    stageFile: "KeyY",
    unstageFile: "KeyU",
    discardFile: "KeyD",
    stashFile: "KeyZ",
    history: "KeyH",
    blame: "KeyM",
    edit: "KeyE",
    compare: "KeyO",
    branch: "KeyV",
    focusFile: "KeyI",
    help: "Digit0",
  };

  function createGitUiShortcuts({
    state,
    render,
    active,
    currentMode,
    gitUiOptions,
    explorationDefaultDirectory,
    canSearchDiff,
    canEditCurrentFile,
    saveDraftFromDom,
    hide,
    confirmFn,
    alertFn,
    getGitUi,
  }) {
    function globalModalOpen() {
      // app-level overlays (question/settings/create/palette) live outside
      // this bundle; their open state is readable from the DOM without
      // importing app symbols. git-ui modals use .git-ui-modal-backdrop,
      // a different class, so they never trip this guard.
      return Array.prototype.some.call(
        document.querySelectorAll(".modal-backdrop"),
        (m) => m.style.display && m.style.display !== "none",
      );
    }
    function handleKeydown(event) {
      if (!state.visible || !event) return;
      // a global app overlay (confirm dialogs, settings, palette) owns the
      // keyboard while it is up; muting keys here would strand Escape and
      // lock the user inside the overlay.
      if (globalModalOpen()) return;
      const view = active();
      if (!view) return;
      // Keys this handler consumes are stopped so terminal/global shortcuts
      // behind the drawer do not double-fire. Keys aimed outside the git UI
      // (terminal behind it, page body) are muted unconditionally, same as
      // before. Keys inside the git UI propagate when unconsumed: tree rows,
      // stash entries and log commits carry inline keydown handlers that
      // only run at target phase, after this capture handler returns.
      // The git UI has two hosting roots: the right-sidebar #gitUiPanel and
      // the workspace pane .pane-git-container mount. Log rows render in
      // whichever root hosts the current view.
      const consume = () => {
        event.stopPropagation();
        if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      };
      const targetInGitUi = !!(
        event.target &&
        event.target.closest &&
        (event.target.closest("#gitUiPanel") || event.target.closest(".pane-git-container"))
      );
      if (!targetInGitUi) consume();
      if (handleDiffSearchShortcut(event, view)) { consume(); return; }
      if (isGitShortcutPrefix(event)) {
        consume();
        state.shortcutPrefixUntil = Date.now() + 5000;
        event.preventDefault();
        return;
      }
      if (handleGitShortcut(event, view)) { consume(); return; }
      if (event.key === "Escape" && isDiffSearchTarget(event.target)) {
        consume();
        event.preventDefault();
        getGitUi().clearDiffSearch();
        return;
      }
      if (event.key !== "Escape") return;
      consume();
      event.preventDefault();
      if (state.contextMenu || state.logContextMenu || state.headerMenu) {
        state.contextMenu = null;
        state.logContextMenu = null;
        state.headerMenu = null;
        render();
        return;
      }
      if (state.branchList) {
        state.branchList = null;
        render();
        return;
      }
      if (state.worktreeList) {
        state.worktreeList = null;
        render();
        return;
      }
      if (state.branchModal) {
        state.branchModal = null;
        render();
        return;
      }
      if (state.gitOpModal) {
        state.gitOpModal = null;
        render();
        return;
      }
      if (state.commitModal) {
        saveDraftFromDom();
        state.commitModal = null;
        render();
        return;
      }
      if (state.compareSelectedModal) {
        state.compareSelectedModal = null;
        render();
        return;
      }
      if (state.resetSelectedModal) {
        state.resetSelectedModal = null;
        render();
        return;
      }
      if (state.tagSelectedModal) {
        state.tagSelectedModal = null;
        render();
        return;
      }
      if (state.cleanupConfirm) {
        state.cleanupConfirm = null;
        render();
        return;
      }
      if ((view.navigationStack || []).length) {
        getGitUi().goBack();
        return;
      }
      if (isChangesListView(view)) {
        if (confirmFn("Hide Git UI?")) hide();
      } else {
        getGitUi().showChangesList();
      }
    }

    function isChangesListView(view) {
      return !!(view && view.tab === "changes" && currentMode() === "changes" && !view.file && !view.sideEditor);
    }

    function handleDiffSearchShortcut(event, view) {
      if (!event || editableTarget(event.target)) return false;
      const key = String(event.key || "").toLowerCase();
      if (key !== "f" || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return false;
      if (!canSearchDiff(view)) return false;
      event.preventDefault();
      getGitUi().openDiffSearch();
      return true;
    }

    function isDiffSearchTarget(target) {
      return !!(target && target.closest && target.closest("#gitUiDiffSearch"));
    }

    function handleGitShortcut(event, view) {
      if (event.defaultPrevented || state.shortcutPrefixUntil <= Date.now()) return false;
      state.shortcutPrefixUntil = 0;
      if (event.metaKey || event.ctrlKey || event.altKey) return false;
      if (event.key === "Escape" || editableTarget(event.target)) return false;
      const key = shortcutKey(event);
      const shortcutMap = gitShortcutMap();
      const actions = {
        changes: () => getGitUi().showChangesList(),
        commit: () => getGitUi().openCommitModal(),
        log: () => getGitUi().tab("log"),
        stash: () => getGitUi().tab("stash"),
        commitAlt: () => getGitUi().openCommitModal(),
        logAlt: () => getGitUi().tab("log"),
        refresh: () => getGitUi().refresh(),
        stageAll: () => getGitUi().toggleStageAll(),
        history: () => { if (view.file) getGitUi().tab("history"); },
        blame: () => { if (view.file) getGitUi().toggleBlame(); },
        edit: () => { if (view.file && canEditCurrentFile(view)) getGitUi().editFile(); },
        stageFile: () => { const path = shortcutFilePath(event, view); if (path) getGitUi().stageFile(encodeURIComponent(path)); },
        unstageFile: () => { const path = shortcutFilePath(event, view); if (path) getGitUi().unstageFile(encodeURIComponent(path)); },
        discardFile: () => { const path = shortcutFilePath(event, view); if (path) getGitUi().discardFile(encodeURIComponent(path)); },
        stashFile: () => { const path = shortcutFilePath(event, view); if (path) getGitUi().stashFile(encodeURIComponent(path)); },
        compare: () => getGitUi().compareCurrent(),
        branch: () => getGitUi().openBranchModal(),
        focusFile: () => focusFirstGitFile(),
        help: () => showGitKeyboardHelp(),
      };
      const match = Object.entries(shortcutMap).find(([, value]) => value === key);
      const action = match && actions[match[0]];
      if (!action) return false;
      event.preventDefault();
      action();
      // Same learn-by-use echo as the WebUI prefix dispatch; the toast
      // helper is a desktop-bundle global, guarded because the git UI can
      // outlive module reshuffles in tests.
      if (typeof showShortcutHintToast === "function")
        showShortcutHintToast("gitShortcuts", match[0]);
      return true;
    }

    function isGitShortcutPrefix(event) {
      return shortcutPrefixFromEvent(event) === gitShortcutPrefixLabel();
    }

    function gitShortcutPrefixLabel() {
      return normalizeShortcutPrefix(gitUiOptions().globalShortcutPrefix || "Ctrl+B");
    }

    function gitShortcutMap() {
      const configured = gitUiOptions().gitShortcuts || {};
      return Object.assign({}, DEFAULT_GIT_SHORTCUTS, configured);
    }

    function shortcutKey(event) {
      return `${event.shiftKey ? "Shift+" : ""}${event.code || event.key}`;
    }

    function normalizeShortcutPrefix(value) {
      const text = String(value || "Ctrl+B").trim();
      if (!text) return "Ctrl+B";
      const parts = text.split("+").map((part) => part.trim()).filter(Boolean);
      const key = parts.pop() || "B";
      const mods = [];
      if (parts.some((part) => /^ctrl|control$/i.test(part))) mods.push("Ctrl");
      if (parts.some((part) => /^alt|option$/i.test(part))) mods.push("Alt");
      if (parts.some((part) => /^shift$/i.test(part))) mods.push("Shift");
      if (parts.some((part) => /^meta|cmd|command$/i.test(part))) mods.push("Meta");
      if (!mods.length) mods.push("Ctrl");
      return mods.concat(key.length === 1 ? key.toUpperCase() : key).join("+");
    }

    function shortcutPrefixFromEvent(event) {
      const mods = [];
      if (event.ctrlKey) mods.push("Ctrl");
      if (event.altKey) mods.push("Alt");
      if (event.shiftKey) mods.push("Shift");
      if (event.metaKey) mods.push("Meta");
      const key = event.key === " " ? "Space" : String(event.key || "");
      if (!key || ["Control", "Alt", "Shift", "Meta"].includes(key)) return "";
      return mods.concat(key.length === 1 ? key.toUpperCase() : key).join("+");
    }

    function editableTarget(target) {
      return !!(target && target.closest && target.closest("input, textarea, select, [contenteditable='true']"));
    }

    function shortcutFilePath(event, view) {
      const row = event.target && event.target.closest && event.target.closest(".git-ui-file[data-git-path]");
      return (row && row.dataset.gitPath) || (view && view.file) || "";
    }

    function focusFirstGitFile() {
      const node = document.querySelector(".git-ui-file[role='treeitem'], .git-ui-btn, .git-ui-file-action");
      if (node && node.focus) node.focus();
    }

    function showGitKeyboardHelp() {
      const map = gitShortcutMap();
      alertFn(`${gitShortcutPrefixLabel()} then:\n${shortcutDisplay(map.changes)} Changes list\n${shortcutDisplay(map.commit)} Commit modal\n${shortcutDisplay(map.log)} Log\n${shortcutDisplay(map.stash)} Stash\n${shortcutDisplay(map.refresh)} Refresh\n${shortcutDisplay(map.stageAll)} Stage/unstage all\n${shortcutDisplay(map.stageFile)} Stage file\n${shortcutDisplay(map.unstageFile)} Unstage file\n${shortcutDisplay(map.discardFile)} Discard file\n${shortcutDisplay(map.stashFile)} Stash file\n${shortcutDisplay(map.history)} File history\n${shortcutDisplay(map.blame)} Toggle blame\n${shortcutDisplay(map.edit)} Edit file\n${shortcutDisplay(map.compare)} Return to current changes\n${shortcutDisplay(map.branch)} Git directory / branch dialog\n${shortcutDisplay(map.focusFile)} Focus file list\n${shortcutDisplay(map.help)} Git shortcut help\n\nFolder picker: selected folder becomes the Git panel directory immediately.\n↩ beside Refresh: return Git to the current workspace/worktree folder.\nLog view: graph, description, date, and author columns; hover a commit for exact date/details; filter description/date/author; Load more changes fetches older commits.\nEsc Back / hide`);
    }

    function shortcutDisplay(value) {
      return String(value || "")
        .replace(/(^|\+)Key/g, "$1")
        .replace(/(^|\+)Digit/g, "$1")
        .replace("BracketLeft", "[")
        .replace("BracketRight", "]")
        .replace("Slash", "/")
        .replace("Period", ".")
        .replace("Comma", ",");
    }

    function gitShortcutLabel(action) {
      const key = gitShortcutMap()[action];
      return key ? `${gitShortcutPrefixLabel()} then ${shortcutDisplay(key)}` : "";
    }

    function titleWithGitShortcut(title, action) {
      const label = gitShortcutLabel(action);
      return label ? `${title} (${label})` : title;
    }

    return {
      handleKeydown,
      titleWithGitShortcut,
    };
  }

  globalThis.HerdrGitUiShortcuts = {
    create: createGitUiShortcuts,
    DEFAULT_GIT_SHORTCUTS,
  };
})();