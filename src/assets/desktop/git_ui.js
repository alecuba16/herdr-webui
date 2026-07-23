(function () {
  const state = {
    cache: {},
    activeKey: "",
    open: false,
    visible: false,
    renderVersion: 0,
    contextMenu: null,
    branchModal: null,
    gitOpModal: null,
    commitModal: null,
    compareSelectedModal: null,
    resetSelectedModal: null,
    tagSelectedModal: null,
    gitToast: null,
    cleanupConfirm: null,
    sideScrollTop: 0,
    shortcutPrefixUntil: 0,
  };
  const LARGE_FILE_DIFF_LINE_LIMIT = 500;
  const GIT_LOG_PAGE_SIZE = 80;
  const GIT_LOG_MAX_LIMIT = 2000;
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

  document.addEventListener("click", () => {
    if (!state.contextMenu) return;
    state.contextMenu = null;
    if (state.visible) render();
  });
  window.addEventListener("keydown", handleKeydown, true);

  function active() {
    return state.cache[state.activeKey] || null;
  }

  function handleKeydown(event) {
    if (!state.visible || !event) return;
    if (tempTerminalModalVisible()) return;
    const view = active();
    if (!view) return;
    // Git drawer owns keyboard while visible, so terminal/global shortcuts behind it do not receive input.
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (handleDiffSearchShortcut(event, view)) return;
    if (isGitShortcutPrefix(event)) {
      state.shortcutPrefixUntil = Date.now() + 5000;
      event.preventDefault();
      return;
    }
    if (handleGitShortcut(event, view)) return;
    if (event.key === "Escape" && isDiffSearchTarget(event.target)) {
      event.preventDefault();
      window.HerdrGitUi.clearDiffSearch();
      return;
    }
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (state.contextMenu) {
      state.contextMenu = null;
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
    if (isChangesListView(view)) {
      if (confirm("Hide Git UI?")) hide();
    } else {
      window.HerdrGitUi.showChangesList();
    }
  }

  function tempTerminalModalVisible() {
    const modal = document.getElementById && document.getElementById("tempTerminalModal");
    return !!(modal && modal.style.display && modal.style.display !== "none");
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
    window.HerdrGitUi.openDiffSearch();
    return true;
  }

  function isDiffSearchTarget(target) {
    return !!(target && target.closest && target.closest("#gitUiDiffSearch"));
  }

  function isNotGitRepositoryMessage(message) {
    return String(message || "").toLowerCase().includes("not a git repository");
  }

  function gitBranchModalDefaultCwd(cwd) {
    const path = String(cwd || "").trim();
    if (path && path !== "/") return path;
    if (typeof window.defaultFolderPath === "function") {
      const fallback = String(window.defaultFolderPath() || "").trim();
      if (fallback) return fallback;
    }
    return "~";
  }

  function isNoGitRepositoryView(view) {
    return !!(((view && view.status) || {}).not_git_repository);
  }

  function markNoGitRepository(view) {
    view.error = "";
    view.loading = false;
    view.tab = "cleanup";
    view.file = "";
    view.diff = { files: [] };
    view.status = {
      state: "cleanup only",
      repo_path: view.cwd || "",
      branch: "No Git repository",
      not_git_repository: true,
      conflicted: [],
      staged: [],
      unstaged: [],
      untracked: [],
    };
  }

  function handleGitShortcut(event, view) {
    if (event.defaultPrevented || state.shortcutPrefixUntil <= Date.now()) return false;
    state.shortcutPrefixUntil = 0;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === "Escape" || editableTarget(event.target)) return false;
    const key = shortcutKey(event);
    const shortcutMap = gitShortcutMap();
    const actions = {
      changes: () => window.HerdrGitUi.showChangesList(),
      commit: () => window.HerdrGitUi.openCommitModal(),
      log: () => window.HerdrGitUi.tab("log"),
      stash: () => window.HerdrGitUi.tab("stash"),
      commitAlt: () => window.HerdrGitUi.openCommitModal(),
      logAlt: () => window.HerdrGitUi.tab("log"),
      refresh: () => window.HerdrGitUi.refresh(),
      stageAll: () => window.HerdrGitUi.toggleStageAll(),
      history: () => { if (view.file) window.HerdrGitUi.tab("history"); },
      blame: () => { if (view.file) window.HerdrGitUi.toggleBlame(); },
      edit: () => { if (view.file && canEditCurrentFile(view)) window.HerdrGitUi.editSideBySide(); },
      stageFile: () => { const path = shortcutFilePath(event, view); if (path) window.HerdrGitUi.stageFile(encodeURIComponent(path)); },
      unstageFile: () => { const path = shortcutFilePath(event, view); if (path) window.HerdrGitUi.unstageFile(encodeURIComponent(path)); },
      discardFile: () => { const path = shortcutFilePath(event, view); if (path) window.HerdrGitUi.discardFile(encodeURIComponent(path)); },
      stashFile: () => { const path = shortcutFilePath(event, view); if (path) window.HerdrGitUi.stashFile(encodeURIComponent(path)); },
      compare: () => window.HerdrGitUi.compareCurrent(),
      branch: () => window.HerdrGitUi.openBranchModal(),
      focusFile: () => focusFirstGitFile(),
      help: () => showGitKeyboardHelp(),
    };
    const match = Object.entries(shortcutMap).find(([, value]) => value === key);
    const action = match && actions[match[0]];
    if (!action) return false;
    event.preventDefault();
    action();
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
    alert(`${gitShortcutPrefixLabel()} then:\n${shortcutDisplay(map.changes)} Changes list\n${shortcutDisplay(map.commit)} Commit modal\n${shortcutDisplay(map.log)} Log\n${shortcutDisplay(map.stash)} Stash\n${shortcutDisplay(map.refresh)} Refresh\n${shortcutDisplay(map.stageAll)} Stage/unstage all\n${shortcutDisplay(map.stageFile)} Stage file\n${shortcutDisplay(map.unstageFile)} Unstage file\n${shortcutDisplay(map.discardFile)} Discard file\n${shortcutDisplay(map.stashFile)} Stash file\n${shortcutDisplay(map.history)} File history\n${shortcutDisplay(map.blame)} Toggle blame\n${shortcutDisplay(map.edit)} Edit file\n${shortcutDisplay(map.compare)} Return to current changes\n${shortcutDisplay(map.branch)} Git directory / branch dialog\n${shortcutDisplay(map.focusFile)} Focus file list\n${shortcutDisplay(map.help)} Git shortcut help\n\nFolder picker: selected folder becomes the Git panel directory immediately.\n↩ beside Refresh: return Git to the current workspace/worktree folder.\nLog view: graph, description, date, and author columns; hover a commit for exact date/details; filter description/date/author; Load more changes fetches older commits.\nEsc Back / hide`);
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

  function gitUiOptions() {
    try {
      return JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
    } catch (_) {
      return {};
    }
  }

  function explorationDefaultDirectory() {
    return String(gitUiOptions().explorationDefaultDirectory || "").trim();
  }

  function largeDiffLineLimit() {
    const value = Number(gitUiOptions().gitUiLargeDiffLineLimit);
    return Number.isFinite(value) ? Math.max(0, value) : 2000;
  }

  function largeChangeFileLimit() {
    const value = Number(gitUiOptions().gitUiLargeChangeFileLimit);
    return Number.isFinite(value) ? Math.max(0, value) : 25;
  }

  function largeSectionFileLimit() {
    const value = Number(gitUiOptions().gitUiLargeSectionFileLimit);
    return Number.isFinite(value) ? Math.max(0, value) : 250;
  }

  function fileListMode() {
    return gitUiOptions().gitUiFileListMode === "flat" ? "flat" : "tree";
  }

  function diffLayoutMode() {
    return gitUiOptions().gitUiDiffLayout === "unified" ? "unified" : "side-by-side";
  }

  function gitLogDefaultBranch() {
    return String(gitUiOptions().gitUiDefaultBranch || "master").trim() || "master";
  }

  function normalizeLogScope(scope) {
    return ["all", "base-current", "base"].includes(scope) ? scope : "all";
  }

  function setGitUiOption(key, value) {
    const options = gitUiOptions();
    options[key] = value;
    try { localStorage.setItem("herdr-web-options", JSON.stringify(options)); } catch (_) {}
  }

  function diffLineCount(files) {
    return (files || []).reduce((total, file) => total + (file.chunks || []).reduce((sum, chunk) => sum + ((chunk.lines || []).length), 0), 0);
  }

  function diffFileLineCount(file) {
    return ((file && file.chunks) || []).reduce((sum, chunk) => sum + ((chunk.lines || []).length), 0);
  }

  function loadedLargeDiffPreviewLimit() {
    return 1200;
  }

  function previewDiffFile(file, limit) {
    let remaining = Math.max(0, limit);
    const chunks = [];
    for (const chunk of (file && file.chunks) || []) {
      if (remaining <= 0) break;
      const lines = previewChunkLines(chunk.lines || [], remaining);
      if (!lines.length) break;
      remaining -= lines.length;
      chunks.push(Object.assign({}, chunk, { lines }));
    }
    return Object.assign({}, file, { chunks, preview_large_diff: true });
  }

  function diffFileKey(fileOrPath, kind) {
    const path = typeof fileOrPath === "string" ? fileOrPath : (fileOrPath && fileOrPath.path) || "";
    const diffKind = typeof fileOrPath === "string" ? kind || "" : (fileOrPath && fileOrPath.diff_kind) || "";
    return `${diffKind}:${path}`;
  }

  function previewChunkLines(lines, limit) {
    const out = [];
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      const line = lines[i];
      if (line.line_type !== "delete") {
        out.push(line);
        continue;
      }
      const group = [];
      while (lines[i] && lines[i].line_type === "delete") group.push(lines[i++]);
      while (lines[i] && lines[i].line_type === "add") group.push(lines[i++]);
      i--;
      if (out.length + group.length > limit) break;
      out.push(...group);
    }
    return out;
  }

  function changeSetFileCount(status) {
    const seen = new Set([...(status.conflicted || []), ...(status.staged || []), ...(status.unstaged || []), ...(status.untracked || [])].filter(Boolean));
    return seen.size;
  }

  function hashText(value) {
    let hash = 0;
    const text = String(value || "");
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return Math.abs(hash).toString(16);
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function arg(value) {
    return encodeURIComponent(String(value == null ? "" : value)).replace(/'/g, "%27");
  }

  const Syntax = window.HerdrGitSyntax;
  const Actions = window.HerdrGitActions;
  const FileTree = window.HerdrFileTree;

  function highlight(code, path) {
    return Syntax.highlight(code, path);
  }

  function highlightDiffText(code, path) {
    const query = diffSearchQuery();
    if (!query) return highlight(code, path);
    const text = String(code == null ? "" : code);
    const lower = text.toLowerCase();
    const needle = query.toLowerCase();
    let index = 0;
    let html = "";
    while (index < text.length) {
      const found = lower.indexOf(needle, index);
      if (found < 0) break;
      if (found > index) html += highlight(text.slice(index, found), path);
      html += `<mark class="git-ui-search-match">${highlight(text.slice(found, found + query.length), path)}</mark>`;
      index = found + query.length;
    }
    return html + highlight(text.slice(index), path);
  }

  function diffSearchQuery() {
    const view = active() || {};
    return String(view.diffSearchQuery || "").trim();
  }

  function canSearchDiff(view) {
    if (!view || view.sideEditor) return false;
    if (["history", "log", "stash", "cleanup", "conflicts"].includes(view.tab)) return false;
    return !!(((view.diff || {}).files || []).length || view.file);
  }

  function countTextMatches(value, query) {
    const needle = String(query || "").trim().toLowerCase();
    if (!needle) return 0;
    const text = String(value == null ? "" : value).toLowerCase();
    let count = 0;
    let index = 0;
    while (index < text.length) {
      const found = text.indexOf(needle, index);
      if (found < 0) break;
      count++;
      index = found + needle.length;
    }
    return count;
  }

  function diffSearchMatchCount(view, query) {
    const needle = String(query || "").trim();
    if (!needle) return 0;
    const unified = diffLayoutMode() === "unified";
    return (((view && view.diff && view.diff.files) || [])).reduce((total, file) => {
      return total + ((file.chunks || []).reduce((fileTotal, chunk) => {
        const rows = unified ? unifiedRows(chunk) : sideBySideRows(chunk);
        return fileTotal + rows.reduce((lineTotal, row) => {
          if (unified) return lineTotal + countTextMatches((row.line || {}).content || "", needle);
          return lineTotal
            + countTextMatches((row.oldLine || {}).content || "", needle)
            + countTextMatches((row.newLine || {}).content || "", needle);
        }, 0);
      }, 0));
    }, 0);
  }

  async function api(url, opt) {
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    const body = await res.json();
    if (!res.ok || body.error) throw Error(body.error || res.statusText);
    return body;
  }

  function workspaceCwd(workspace) {
    if (!workspace) return "";
    if (window.HerdrWorkspacePath) return window.HerdrWorkspacePath(workspace);
    if (workspace.worktree && workspace.worktree.checkout_path) return workspace.worktree.checkout_path;
    if (workspace.cwd) return workspace.cwd;
    if (workspace.path) return workspace.path;
    return "";
  }

  function workspaceTitle(workspace) {
    if (!workspace) return "Git";
    if (workspace.worktree) {
      return workspace.worktree.branch || workspace.label || workspace.worktree.checkout_path || "worktree";
    }
    return workspace.label || "main/master";
  }

  function workspaceKey(workspace) {
    return (workspace && workspace.workspace_id) || workspaceCwd(workspace) || "default";
  }

  function normalizePathForCompare(path) {
    const text = String(path || "").trim();
    if (!text) return "";
    return text === "/" ? "/" : text.replace(/\/+$/, "");
  }

  function samePath(left, right) {
    return normalizePathForCompare(left) === normalizePathForCompare(right);
  }

  function gitCwdMatchesWorkspace(view) {
    if (!view || !view.workspaceCwd) return true;
    return samePath(view.cwd, view.workspaceCwd);
  }

  function resetGitViewForCwd(view, cwd) {
    view.cwd = cwd;
    view.file = "";
    view.status = null;
    view.diff = null;
    view.compareBase = "";
    view.compareTarget = "";
    view.compareFilePaths = [];
    view.selectedLogCommits = [];
    view.selectedCommitPreview = null;
    view.logFilePath = "";
    view.historyCommitHash = "";
    view.historySource = "";
    view.fileBackTarget = null;
    view.navigationStack = [];
    view.mode = "changes";
    view.tab = "changes";
  }

  function clonePlain(value, fallback) {
    try { return JSON.parse(JSON.stringify(value == null ? fallback : value)); }
    catch (_) { return fallback; }
  }

  function currentNavigationLabel(view) {
    if (!view) return "Git";
    if (view.tab === "history" && view.file) return `History · ${view.file}`;
    if (view.tab === "log" && view.logFilePath) return `Log · ${view.logFilePath}`;
    if (view.tab === "log") return "Log";
    if (view.tab === "stash") return "Stash";
    if (view.tab === "cleanup") return "Cleanup";
    if (view.fileBackTarget && view.fileBackTarget.type === "log") return `Committed file · ${view.file || "file"}`;
    if (view.temporaryHistoryCompare && view.file) return `Committed file · ${view.file}`;
    if (view.file) return currentMode() === "changes" ? `Current file · ${view.file}` : `Compared file · ${view.file}`;
    return currentMode() === "changes" ? "Current changes" : "Compared changes";
  }

  function captureNavigationSnapshot(view, label) {
    if (!view) return null;
    const content = document.querySelector(".git-ui-content");
    if (content && preserveContentScroll(view.tab)) view.contentScrollTop = content.scrollTop;
    return {
      label: label || currentNavigationLabel(view),
      tab: view.tab || "changes",
      mode: view.mode || "changes",
      file: view.file || "",
      diffKind: view.diffKind || "",
      diffScope: view.diffScope || "all",
      compareBase: view.compareBase || "",
      compareTarget: view.compareTarget || "",
      compareFilePaths: clonePlain(view.compareFilePaths, []),
      selectedLogCommits: clonePlain(view.selectedLogCommits, []),
      selectedCommitPreview: clonePlain(view.selectedCommitPreview, null),
      logFilePath: view.logFilePath || "",
      logLimit: view.logLimit || GIT_LOG_PAGE_SIZE,
      logScope: view.logScope || (view.logAll ? "all" : "base-current"),
      logAll: !!view.logAll,
      logFilters: clonePlain(view.logFilters, { description: "", date: "", author: "" }),
      fileFilter: view.fileFilter || "",
      temporaryHistoryCompare: !!view.temporaryHistoryCompare,
      historyCommitHash: view.historyCommitHash || "",
      historySource: view.historySource || "",
      fileBackTarget: clonePlain(view.fileBackTarget, null),
      contentScrollTop: view.contentScrollTop || 0,
      sideScrollTop: state.sideScrollTop || 0,
    };
  }

  function pushNavigationSnapshot(view, label) {
    const snapshot = captureNavigationSnapshot(view, label);
    if (!snapshot) return;
    const stack = (view.navigationStack || []).filter(Boolean);
    const last = stack[stack.length - 1];
    const signature = `${snapshot.tab}|${snapshot.mode}|${snapshot.file}|${snapshot.compareBase}|${snapshot.compareTarget}|${snapshot.selectedLogCommits.join(",")}|${snapshot.logFilePath}`;
    const lastSignature = last ? `${last.tab}|${last.mode}|${last.file}|${last.compareBase}|${last.compareTarget}|${(last.selectedLogCommits || []).join(",")}|${last.logFilePath}` : "";
    if (signature === lastSignature) return;
    view.navigationStack = stack.concat(snapshot).slice(-12);
  }

  async function restoreNavigationSnapshot(view, snapshot) {
    if (!view || !snapshot) return;
    view.tab = snapshot.tab || "changes";
    view.mode = snapshot.mode || "changes";
    view.file = snapshot.file || "";
    view.diffKind = snapshot.diffKind || "";
    view.diffScope = snapshot.diffScope || "all";
    view.compareBase = snapshot.compareBase || "";
    view.compareTarget = snapshot.compareTarget || "";
    view.compareFilePaths = clonePlain(snapshot.compareFilePaths, []);
    view.selectedLogCommits = clonePlain(snapshot.selectedLogCommits, []);
    view.selectedCommitPreview = clonePlain(snapshot.selectedCommitPreview, null);
    view.logFilePath = snapshot.logFilePath || "";
    view.logLimit = snapshot.logLimit || GIT_LOG_PAGE_SIZE;
    view.logScope = normalizeLogScope(snapshot.logScope || (snapshot.logAll ? "all" : "base-current"));
    view.logAll = view.logScope === "all";
    view.logFilters = clonePlain(snapshot.logFilters, { description: "", date: "", author: "" });
    view.fileFilter = snapshot.fileFilter || "";
    view.temporaryHistoryCompare = !!snapshot.temporaryHistoryCompare;
    view.historyCommitHash = snapshot.historyCommitHash || "";
    view.historySource = snapshot.historySource || "";
    view.fileBackTarget = clonePlain(snapshot.fileBackTarget, null);
    view.contentScrollTop = snapshot.contentScrollTop || 0;
    state.sideScrollTop = snapshot.sideScrollTop || 0;
    view.sideEditor = null;
    if (view.tab === "changes") {
      await loadDiff();
      return;
    }
    if (view.tab === "log" && view.selectedLogCommits.length === 1 && (!view.selectedCommitPreview || view.selectedCommitPreview.hash !== view.selectedLogCommits[0])) {
      loadSelectedCommitPreview(view, view.selectedLogCommits[0]);
    }
    render();
  }

  function renderNavigationTrail(view) {
    const stack = ((view && view.navigationStack) || []).filter(Boolean);
    if (!stack.length) return "";
    const labels = stack.map((item) => item.label || "Git").concat(currentNavigationLabel(view));
    const title = labels.join(" › ");
    const visible = stack.length > 2
      ? [stack[0], { label: "…", ellipsis: true }, stack[stack.length - 1]]
      : stack;
    const crumbs = visible.map((item) => item.ellipsis
      ? `<span class="git-ui-breadcrumb-ellipsis" title="${esc(title)}">…</span>`
      : `<span class="git-ui-breadcrumb-step" title="${esc(item.label || "Git")}">${esc(item.label || "Git")}</span>`)
      .join(`<span class="git-ui-breadcrumb-sep">›</span>`);
    return `<span class="git-ui-breadcrumbs" title="${esc(title)}"><button class="git-ui-btn" title="Go back to previous Git view" onclick="HerdrGitUi.goBack()">← Back</button>${crumbs}<span class="git-ui-breadcrumb-sep">›</span><strong title="${esc(currentNavigationLabel(view))}">${esc(currentNavigationLabel(view))}</strong></span>`;
  }

  function workspaceStatus(key, workspace) {
    if (!workspace || !workspaceCwd(workspace)) return "nogit";
    const view = state.cache[key || workspaceKey(workspace)];
    if (view && view.error) return "nogit";
    if (state.visible && state.activeKey === (key || workspaceKey(workspace))) return "open";
    return "closed";
  }

  function compactPath(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    if (parts.length <= 3) return path || "No repo path";
    return `.../${parts.slice(-3).join("/")}`;
  }

  function ensurePanel() {
    let panel = document.getElementById("gitUiPanel");
    if (panel) return panel;
    const shell = document.getElementById("terminalShell");
    panel = document.createElement("div");
    panel.id = "gitUiPanel";
    panel.className = "git-ui-panel";
    panel.tabIndex = -1;
    panel.style.display = "none";
    if (shell && shell.parentNode) shell.parentNode.appendChild(panel);
    return panel;
  }

  function showPanel(show) {
    const panel = ensurePanel();
    panel.style.display = show ? "grid" : "none";
    syncTerminalVisibility(show);
    if (!show) {
      state.renderVersion++;
      panel.innerHTML = "";
    }
  }

  function syncTerminalVisibility(show) {
    const shell = document.getElementById("terminalShell");
    if (!shell) return;
    const fileBrowser = window.HerdrFileBrowser;
    const fileVisible = !!(fileBrowser && fileBrowser.isVisible && fileBrowser.isVisible());
    shell.style.display = show || fileVisible ? "none" : "";
    if (window.syncShellModeButtons) window.syncShellModeButtons();
    // Refit the terminal surface when the shell reappears so the
    // terminal does not extend below the visible area.
    if (!show && !fileVisible && shell.style.display !== "none") {
      if (window.HerdrTerminalFit) window.HerdrTerminalFit.afterLayout(function () {
        if (typeof fitTerminalShell === "function") fitTerminalShell();
        if (typeof fitTerminalSurface === "function") fitTerminalSurface();
      });
    }
  }

  async function open(workspace, options) {
    const openOptions = options || {};
    const key = workspaceKey(workspace);
    const nextWorkspaceCwd = workspaceCwd(workspace);
    if (state.visible && state.activeKey === key && !openOptions.forceOpen) {
      hide();
      return;
    }
    saveDraftFromDom();
    state.activeKey = key;
    if (!state.cache[key]) {
      state.cache[key] = {
        cwd: nextWorkspaceCwd,
        workspaceCwd: nextWorkspaceCwd,
        title: workspaceTitle(workspace),
        titleKind: workspace.worktree ? "Worktree" : "Branch",
        tab: "changes",
        status: null,
        diff: null,
        diffScope: "all",
        file: "",
        error: "",
        loading: true,
        mode: "changes",
        diffContext: 3,
        compareBase: "",
        compareTarget: "",
        blame: {},
        showBlame: false,
        logAll: true,
        logScope: "all",
        logLimit: GIT_LOG_PAGE_SIZE,
        logLoadingMore: false,
        selectedLogCommits: [],
        selectedCommitPreview: null,
        logFilePath: "",
        compareFilePaths: [],
        collapsedSections: {},
        expandedLargeSections: {},
        collapsedFiles: {},
        loadedLargeDiffFiles: {},
        collapsedDirs: {},
        expandedCompactDirs: {},
        cleanupRoot: explorationDefaultDirectory() || workspaceCwd(workspace),
        cleanupResult: null,
        cleanupLoading: false,
        cleanupError: "",
        cleanupSelected: {},
        fileFilter: "",
        pendingLogScrollHash: "",
        logFilters: { description: "", date: "", author: "" },
        temporaryHistoryCompare: false,
        historyCommitHash: "",
        historySource: "",
        fileBackTarget: null,
        navigationStack: [],
        sideEditor: null,
      };
    } else {
      const view = state.cache[key];
      const previousWorkspaceCwd = view.workspaceCwd || "";
      view.workspaceCwd = nextWorkspaceCwd || previousWorkspaceCwd;
      if (!view.cwd || (previousWorkspaceCwd && samePath(view.cwd, previousWorkspaceCwd))) {
        view.cwd = nextWorkspaceCwd || view.cwd;
      }
      view.title = workspaceTitle(workspace);
      view.titleKind = workspace.worktree ? "Worktree" : "Branch";
    }
    state.open = true;
    state.visible = true;
    showPanel(true);
    requestAnimationFrame(() => ensurePanel().focus({ preventScroll: true }));
    render();
    if (!active().status) await refresh();
  }

  function hide() {
    saveDraftFromDom();
    saveSideEditorFromDom();
    state.visible = false;
    showPanel(false);
  }

  function close() {
    saveDraftFromDom();
    saveSideEditorFromDom();
    if (state.activeKey) delete state.cache[state.activeKey];
    state.open = false;
    state.visible = false;
    showPanel(false);
  }

  async function refresh() {
    const view = active();
    if (!view) return;
    saveSideEditorFromDom();
    if (!view.cwd) {
      view.error = "No checkout path found for this workspace. Open a linked worktree or add cwd metadata first.";
      view.loading = false;
      if (state.visible) render();
      return;
    }
    view.error = "";
    view.loading = true;
    if (state.visible) render();
    try {
      view.status = await api(`/api/git-ui/status?cwd=${encodeURIComponent(view.cwd)}`);
      if (view.tab === "stash" && !canOpenStashView(view)) view.tab = "changes";
      if (state.visible) render();
      await loadDiff();
      view.loading = false;
      if (state.visible) render();
    } catch (err) {
      if (isNotGitRepositoryMessage(err && err.message)) {
        markNoGitRepository(view);
        if (state.visible) render();
        return;
      }
      view.error = err.message || String(err);
      view.loading = false;
      if (state.visible) render();
    }
  }

  async function loadDiff() {
    const view = active();
    if (!view) return;
    const context = Math.max(0, Math.min(200, Number(view.diffContext || 3)));
    if (currentMode() !== "changes") {
      const mergeBase = currentMode() === "current-compare" ? "&merge_base=true" : "";
      const file = view.file ? `&file=${encodeURIComponent(view.file)}` : "";
      view.diff = await api(`/api/git-ui/compare?cwd=${encodeURIComponent(view.cwd)}&base=${encodeURIComponent(view.compareBase || "HEAD")}&target=${encodeURIComponent(view.compareTarget || "HEAD")}&context=${context}${mergeBase}${file}`);
      if (!view.file) view.compareFilePaths = ((view.diff && view.diff.files) || []).map((file) => file.path);
      if (state.visible) render();
      return;
    }
    const scope = view.file ? (view.diffScope || "all") : "all";
    const changeLimit = largeChangeFileLimit();
    const changeCount = changeSetFileCount(view.status || {});
    if (!view.file && changeLimit > 0 && changeCount > changeLimit && !view.loadLargeChangeSet) {
      view.diff = { files: [], skipped_large_change_set: true, file_count: changeCount, file_limit: changeLimit };
      if (state.visible) render();
      return;
    }
    const url = `/api/git-ui/diff?cwd=${encodeURIComponent(view.cwd)}&scope=${encodeURIComponent(scope)}&context=${context}` + (view.file ? `&file=${encodeURIComponent(view.file)}` : "");
    view.diff = await api(url);
    if (state.visible) render();
  }

  async function post(path, body, label) {
    const view = active();
    if (!view || view.mutating) return;
    view.mutating = true;
    view.mutatingLabel = label || "";
    if (state.visible) render();
    try {
      await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await refresh();
    } catch (err) {
      view.error = err.message || String(err);
      if (state.visible) render();
    } finally {
      view.mutating = false;
      view.mutatingLabel = "";
      if (state.visible) render();
    }
  }

  async function postJson(path, body, label) {
    const view = active();
    if (!view || view.mutating) return null;
    view.mutating = true;
    view.mutatingLabel = label || "";
    if (state.visible) render();
    try {
      const result = await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await refresh();
      return result;
    } catch (err) {
      view.error = err.message || String(err);
      if (state.visible) render();
      throw err;
    } finally {
      view.mutating = false;
      view.mutatingLabel = "";
      if (state.visible) render();
    }
  }

  function currentMode() {
    const view = active() || {};
    return view.mode || "changes";
  }

  function canMutateDiff() {
    return currentMode() === "changes" || currentMode() === "current-compare";
  }

  function allFiles() {
    const s = (active() && active().status) || {};
    return [...(s.conflicted || []), ...(s.staged || []), ...(s.unstaged || []), ...(s.untracked || [])].filter((v, i, a) => v && a.indexOf(v) === i);
  }

  function section(title, files, kind) {
    const view = active() || {};
    const list = files || [];
    const collapsed = !!((view.collapsedSections || {})[title]);
    const action = sectionBulkAction(title, kind, list);
    const limit = largeSectionFileLimit();
    const limited = limit > 0 && list.length > limit && !((view.expandedLargeSections || {})[title]);
    const visibleList = limited ? list.slice(0, limit) : list;
    const largeNote = limited ? `<div class="git-ui-large-file-diff"><button class="git-ui-large-file-load" type="button" onclick="HerdrGitUi.expandLargeSection('${arg(title)}')"><strong>Show all ${esc(title.toLowerCase())} files</strong></button><p>Showing first ${limit} of ${list.length} files to keep browser responsive.</p></div>` : "";
    return `<div class="git-ui-section"><div class="git-ui-section-head"><button class="git-ui-section-toggle" onclick="HerdrGitUi.toggleSection('${arg(title)}')"><span>${treeIcon(collapsed ? "chevron-right" : "chevron-down")}</span><strong>${esc(title)}</strong><em>${list.length}</em></button>${action}</div>${collapsed ? "" : `<div class="git-ui-list" role="tree" aria-label="${esc(title)} files">${visibleList.length ? renderFileTree(visibleList, kind, view) : `<div class="git-ui-empty-row">No ${esc(title.toLowerCase())} files</div>`}${largeNote}</div>`}</div>`;
  }

  function sectionBulkAction(title, kind, files) {
    if (!files || !files.length) return "";
    if (kind === "S") return `<button class="git-ui-section-action" title="${esc(titleWithGitShortcut(`Unstage all ${title.toLowerCase()} files`, "unstageFile"))}" onclick="event.stopPropagation();HerdrGitUi.bulkSectionAction('unstage','${arg(title)}')">−</button>`;
    if (kind === "M" || kind === "?") return `<button class="git-ui-section-action" title="${esc(titleWithGitShortcut(`Stage all ${title.toLowerCase()} files`, "stageFile"))}" onclick="event.stopPropagation();HerdrGitUi.bulkSectionAction('stage','${arg(title)}')">+</button>`;
    return "";
  }

  function treeIcon(name) {
    const safe = ["chevron-right", "chevron-down", "folder"].includes(name) ? name : "file";
    return `<span class="git-tree-icon git-tree-icon-${safe}" aria-hidden="true"></span>`;
  }

  function renderFileTree(files, kind, view) {
    if (FileTree && FileTree.renderPathTree) {
      return FileTree.renderPathTree(files, {
        callback: "HerdrGitUi",
        toggleMethod: "toggleDir",
        selectMethod: "selectFile",
        activateMethod: "activateTreeItem",
        contextMethod: "fileMenu",
        dataPrefix: "git",
        rowClass: "git-ui-file",
        dirClass: "git-ui-file git-ui-dir",
        kind,
        selectedPath: view.file,
        selectedKind: view.diffKind,
        collapsedDirs: view.collapsedDirs || {},
        expandedCompactDirs: view.expandedCompactDirs || {},
        expandCompactMethod: "expandCompactDir",
        filterTerm: view.fileFilter || "",
        metaForPath: fileSummary,
        statusForPath: fileTreeStatus,
      });
    }
    if (fileListMode() === "flat") return renderFlatFileList(files, kind, view);
    const root = { dirs: new Map(), files: [] };
    for (const file of files) {
      const parts = String(file).split("/").filter(Boolean);
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ name: parts[parts.length - 1] || file, path: file });
    }
    return renderTreeNode(root, "", kind, view, 0);
  }

  function renderFlatFileList(files, kind, view) {
    return (files || [])
      .slice()
      .sort((a, b) => pathBasename(a).localeCompare(pathBasename(b)) || String(a).localeCompare(String(b)))
      .map((file) => renderSideFile(file, pathBasename(file), kind, view, 0))
      .join("");
  }

  function pathBasename(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    return parts[parts.length - 1] || String(path || "");
  }

  function renderTreeNode(node, path, kind, view, level) {
    const entries = [
      ...Array.from(node.dirs.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([dir, child]) => ({ type: "dir", name: dir, child })),
      ...node.files.sort((a, b) => a.name.localeCompare(b.name)).map((file) => ({ type: "file", name: file.name, path: file.path })),
    ];
    return entries.map((entry) => {
      if (entry.type === "dir") {
        const dirPath = path ? `${path}/${entry.name}` : entry.name;
        const collapsed = !!((view.collapsedDirs || {})[dirPath]);
        return `<div class="git-ui-file git-ui-dir" role="treeitem" tabindex="0" aria-expanded="${collapsed ? "false" : "true"}" style="--level:${level}" onclick="HerdrGitUi.toggleDir('${arg(dirPath)}')" onkeydown="HerdrGitUi.activateTreeItem(event)"><span class="git-ui-tree-caret">${treeIcon(collapsed ? "chevron-right" : "chevron-down")}</span><span class="git-ui-tree-icon folder">${treeIcon("folder")}</span><span class="git-ui-path">${esc(entry.name)}</span></div>${collapsed ? "" : renderTreeNode(entry.child, dirPath, kind, view, level + 1)}`;
      }
      return renderSideFile(entry.path, entry.name, kind, view, level);
    }).join("");
  }

  function renderSideFile(file, name, kind, view, level) {
    const summary = fileSummary(file, kind);
    return `<div class="git-ui-file ${view.file === file && view.diffKind === kind ? "active" : ""}" role="treeitem" tabindex="0" data-git-path="${esc(file)}" data-git-kind="${esc(kind)}" style="--level:${level}" onclick="HerdrGitUi.selectFile('${arg(file)}','${kind}')" onkeydown="HerdrGitUi.activateTreeItem(event)" oncontextmenu="return HerdrGitUi.fileMenu(event,'${arg(file)}','${kind}')"><span class="git-ui-tree-caret"></span><span class="git-ui-tree-icon file">${treeIcon("file")}</span><span class="git-ui-path" title="${esc(file)}">${FileTree && FileTree.highlight ? FileTree.highlight(name, (active() || {}).fileFilter) : esc(name)}</span><span class="git-ui-file-meta">${summary}</span></div>`;
  }

  function renderContextMenu() {
    const menu = state.contextMenu;
    if (!menu) return "";
    const actions = [];
    actions.push(`<button onclick="HerdrGitUi.menuAction('copyPermalink')">Copy permalink</button>`);
    if (["S", "M", "?"].includes(menu.kind)) actions.push(`<button onclick="HerdrGitUi.menuAction('stash')">Stash file</button>`);
    if (["M", "?"].includes(menu.kind)) actions.push(`<button onclick="HerdrGitUi.menuAction('discard')">Discard file</button>`);
    if (["M", "?"].includes(menu.kind)) actions.push(`<button onclick="HerdrGitUi.menuAction('stage')">Stage file</button>`);
    if (menu.kind === "S") actions.push(`<button onclick="HerdrGitUi.menuAction('unstage')">Unstage file</button>`);
    return `<div class="git-ui-menu" style="left:${Math.max(0, menu.x)}px;top:${Math.max(0, menu.y)}px" onclick="event.stopPropagation()">${actions.join("")}</div>`;
  }
  function normalizeRemoteUrl(raw) {
    let value = String(raw || "").trim();
    if (!value) return "";
    const scp = value.match(/^git@([^:]+):(.+)$/);
    if (scp) value = `https://${scp[1]}/${scp[2]}`;
    if (value.startsWith("ssh://git@")) value = value.replace(/^ssh:\/\/git@/, "https://");
    value = value.replace(/\.git$/, "");
    try {
      const url = new URL(value);
      return /^https?:$/.test(url.protocol) ? url.toString().replace(/\/$/, "") : "";
    } catch (_) {
      return "";
    }
  }

  function branchPath(branch) {
    return String(branch || "").split("/").map(encodeURIComponent).join("/");
  }

  function gitBranchUrl(status) {
    const base = normalizeRemoteUrl(status && status.remote_url);
    const branch = status && status.branch;
    if (!base || !branch || branch === "(detached)") return "";
    if (base.includes("bitbucket.org/")) return `${base}/branch/${branchPath(branch)}`;
    return `${base}/tree/${branchPath(branch)}`;
  }

  function gitPullRequestUrl(status) {
    const base = normalizeRemoteUrl(status && status.remote_url);
    const branch = status && status.branch;
    if (!base || !branch || branch === "(detached)") return "";
    if (base.includes("github.com/")) return `${base}/pull/new/${branchPath(branch)}`;
    if (base.includes("bitbucket.org/")) return `${base}/pull-requests/new?source=${encodeURIComponent(branch)}`;
    return "";
  }

  function renderGitToast() {
    const toast = state.gitToast;
    if (!toast) return "";
    const branch = toast.branch ? `<span class="git-ui-toast-branch">${esc(toast.branch)}</span>` : "";
    const branchButton = toast.branchUrl ? `<button class="git-ui-btn" onclick="HerdrGitUi.openGitUrl('${arg(toast.branchUrl)}')">Open branch</button>` : "";
    const prButton = toast.prUrl ? `<button class="git-ui-btn primary" onclick="HerdrGitUi.openGitUrl('${arg(toast.prUrl)}')">Open PR</button>` : "";
    return `<div class="git-ui-toast" role="status"><span>${esc(toast.message || "Done")}</span>${branch}<span class="git-ui-toast-actions">${branchButton}${prButton}<button class="git-ui-btn" onclick="HerdrGitUi.closeGitToast()">Dismiss</button></span></div>`;
  }

  function showCommitToast(message) {
    const view = active() || {};
    const status = view.status || {};
    const id = Date.now();
    state.gitToast = {
      id,
      message,
      branch: status.branch || "",
      branchUrl: gitBranchUrl(status),
      prUrl: gitPullRequestUrl(status),
    };
    render();
    setTimeout(() => {
      if (state.gitToast && state.gitToast.id === id) {
        state.gitToast = null;
        if (state.visible) render();
      }
    }, 10000);
  }

  async function copyGitPermalink(path) {
    const view = active();
    if (!view) return;
    const data = await api(`/api/git-ui/permalink?cwd=${encodeURIComponent(view.cwd)}&path=${encodeURIComponent(path)}`);
    const url = data && data.url;
    if (!url) throw new Error("permalink URL was empty");
    await navigator.clipboard.writeText(url);
    const id = Date.now();
    state.gitToast = { id, message: "Permalink copied" };
    render();
    setTimeout(() => {
      if (state.gitToast && state.gitToast.id === id) {
        state.gitToast = null;
        if (state.visible) render();
      }
    }, 3500);
  }

  async function copyCommitId(hash) {
    const value = String(hash || "").trim();
    if (!value) return;
    await navigator.clipboard.writeText(value);
    const id = Date.now();
    state.gitToast = { id, message: "Commit id copied" };
    render();
    setTimeout(() => {
      if (state.gitToast && state.gitToast.id === id) {
        state.gitToast = null;
        if (state.visible) render();
      }
    }, 3500);
  }

  function renderCommitModal() {
    const modal = state.commitModal;
    if (!modal) return "";
    const view = active() || {};
    const key = draftKey(view);
    let draft = { title: "", body: "" };
    try { draft = Object.assign(draft, JSON.parse(localStorage.getItem(key) || "{}")); } catch (_) {}
    const includeBody = !!modal.includeBody;
    const body = includeBody ? `<label>Details<textarea id="gitCommitBody" class="git-ui-textarea" placeholder="Optional body">${esc(draft.body)}</textarea></label>` : "";
    return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal git-ui-commit-modal"><div class="git-ui-modal-head"><strong>Commit staged changes</strong></div><label>Summary<input id="gitCommitTitle" class="git-ui-input" value="${esc(draft.title)}" placeholder="Short imperative summary"></label><label class="git-ui-check-row"><input id="gitCommitIncludeBody" type="checkbox" ${includeBody ? "checked" : ""} onchange="HerdrGitUi.toggleCommitBody(this.checked)"><span>Add commit body</span></label>${body}<label class="git-ui-check-row"><input id="gitCommitAmend" type="checkbox"><span>Amend previous commit</span></label><div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeCommitModal()">Cancel</button><button class="git-ui-btn" onclick="HerdrGitUi.saveDraft()">Save draft</button><button class="git-ui-btn active" onclick="HerdrGitUi.commitFromModal(false)">Commit</button><button class="git-ui-btn primary" onclick="HerdrGitUi.commitFromModal(true)">Commit & Push</button></div></div></div>`;
  }

  function renderResetSelectedModal() {
    const modal = state.resetSelectedModal;
    if (!modal) return "";
    const label = esc((modal.ref || "").slice(0, 12));
    return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>Reset to selected commit</strong></div><p class="git-ui-muted">Choose how to reset the current branch to <strong>${label}</strong>.</p><div class="git-ui-actions"><button class="git-ui-btn" onclick="HerdrGitUi.resetSelected('soft')">Soft reset</button><button class="git-ui-btn danger" onclick="HerdrGitUi.resetSelected('hard')">Hard reset</button></div><div class="git-ui-muted">Soft keeps your changes staged. Hard discards working tree changes and requires confirmation.</div><div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeSelectedResetModal()">Cancel</button></div></div></div>`;
  }

  function renderCompareSelectedModal() {
    const modal = state.compareSelectedModal;
    if (!modal) return "";
    const label = esc((modal.ref || "").slice(0, 12));
    return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>Compare selected commit</strong></div><p class="git-ui-muted">Choose what to compare with <strong>${label}</strong>.</p><div class="git-ui-actions"><button class="git-ui-btn primary" onclick="HerdrGitUi.compareSelectedWithPrevious()">Previous version</button><button class="git-ui-btn" onclick="HerdrGitUi.compareSelectedWithCurrent()">Current changes</button></div><div class="git-ui-muted">Previous version shows the selected commit diff against its parent. Current changes compares the selected commit with your working tree.</div><div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeSelectedCompareModal()">Cancel</button></div></div></div>`;
  }

  function renderTagSelectedModal() {
    const modal = state.tagSelectedModal;
    if (!modal) return "";
    const label = esc((modal.ref || "").slice(0, 12));
    return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>Tag selected commit</strong></div><p class="git-ui-muted">Create a lightweight tag at <strong>${label}</strong>.</p><label>Tag name<input id="gitTagName" class="git-ui-input" value="${esc(modal.tag || "")}" placeholder="v1.2.3"></label><div class="git-ui-modal-actions"><button class="git-ui-btn primary" onclick="HerdrGitUi.createSelectedTag()">Create tag</button><button class="git-ui-btn" onclick="HerdrGitUi.closeSelectedTagModal()">Cancel</button></div></div></div>`;
  }

  function renderBranchModal() {
    const modal = state.branchModal;
    if (!modal) return "";
    const cwd = esc(modal.cwd || "");
    const body = modal.loading
      ? `<div class="git-ui-loading"><span></span><strong>Loading branches</strong></div>`
      : modal.error
        ? `<div class="git-ui-error">${esc(modal.error)}</div>`
        : `<label class="git-ui-branch-field"><span>Branch</span><select id="gitUiBranchSelect">${branchOptions("Local branches", modal.local || [])}${branchOptions("Remote branches", modal.remote || [])}</select></label>`;
    const dir = `<label class="git-ui-branch-field"><span>Git directory</span><div class="git-ui-inline-field"><input id="gitUiBranchCwd" value="${cwd}" placeholder="/path/to/repo" data-directory-picker-after-select="HerdrGitUi.applyBranchModalCwd"><button type="button" class="mini directory-picker-trigger" onclick="HerdrDirectoryPicker.openInput('gitUiBranchCwd')">Browse</button></div></label>`;
    return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>Switch branch</strong></div>${dir}${body}<div class="git-ui-muted">Choosing a folder moves the Git panel to that directory immediately. Use Switch branch only to checkout another branch in the current Git directory.</div><div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeBranchModal()">Cancel</button><button class="git-ui-btn primary" onclick="HerdrGitUi.switchBranchFromModal()" ${modal.loading || modal.error ? "disabled" : ""}>Switch branch</button></div></div></div>`;
  }

  function renderCleanupConfirm() {
    const modal = state.cleanupConfirm;
    if (!modal) return "";
    const items = modal.items || [];
    return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal git-ui-cleanup-modal"><div class="git-ui-modal-head"><strong>Delete ${items.length} Git cleanup item${items.length === 1 ? "" : "s"}?</strong></div><div class="git-ui-muted">Git will use safe delete first. If Git rejects that because force is required, Herdr retries with force.</div><pre class="git-ui-cleanup-confirm-list">${esc(items.map(cleanupItemLabel).join("\n"))}</pre><div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.cancelCleanupDelete()">Cancel</button><button class="git-ui-btn danger" onclick="HerdrGitUi.confirmCleanupDelete()">Delete selected</button></div></div></div>`;
  }

  function renderGitOpModal() {
    const modal = state.gitOpModal;
    if (!modal) return "";
    const branchSelect = renderGitOpBranchSelect(modal);
    const error = modal.error ? `<div class="git-ui-error">${esc(modal.error)}</div>` : "";
    const loading = modal.loading ? `<div class="git-ui-muted">Loading branches...</div>` : "";
    const common = `${loading}${branchSelect}`;
    if (modal.type === "pull") {
      return renderGitOpModalShell("Pull changes", `${common}${renderGitOpModeSelect("Pull option", [["regular", "Regular pull"], ["rebase", "Pull with rebase"], ["ff-only", "Fast-forward only"], ["no-ff", "No fast-forward"], ["force", "Force pull"]])}${error}`, "Pull", "primary", "runPullFromModal");
    }
    if (modal.type === "push" || modal.type === "force-push") {
      const force = modal.type === "force-push";
      const pushTags = `<label class="git-ui-check-row"><input id="gitUiPushTags" type="checkbox"><span>Push tags</span></label>`;
      const modeSelect = force
        ? renderGitOpModeSelect("Retry option", [["force-with-lease", "Force with lease"], ["force", "Force push"]], "force-with-lease")
        : "";
      const note = force ? `<div class="git-ui-muted">Regular push failed. Retry with force-with-lease unless you intentionally need --force.</div>` : "";
      const body = `${common}${modeSelect}${pushTags}${note}${error}`;
      return renderGitOpModalShell(force ? "Push failed" : "Push changes", body, force ? "Retry push" : "Push", force ? "danger" : "primary", "runPushFromModal");
    }
    if (modal.type === "rebase") {
      const body = `${common}<label class="git-ui-branch-field"><span>Rebase commits after</span><input id="gitUiRebaseUpstream" value="HEAD" placeholder="HEAD"></label><label class="git-ui-check-row"><input id="gitUiRebasePullFirst" type="checkbox" checked><span>Fetch selected branch before rebasing</span></label>${error}`;
      return renderGitOpModalShell("Rebase branch", body, "Rebase", "primary", "runRebaseFromModal");
    }
    return "";
  }

  function renderGitOpBranchSelect(modal) {
    const status = ((active() || {}).status) || {};
    const currentBranch = status.branch || "";
    const branchNames = (modal.branches || []).map((branch) => branch.name || branch).concat([currentBranch, status.upstream || "", "main", "master"]);
    const branches = branchNames.filter((value, index, array) => value && array.indexOf(value) === index);
    const defaultBranch = modal.type === "rebase" ? (branches.find((branch) => branch === "main" || branch === "master") || "") : modal.type && modal.type.includes("push") ? currentBranch : "";
    const options = branches.map((branch) => `<option value="${esc(branch)}" ${branch === defaultBranch ? "selected" : ""}>${esc(branch)}${branch === currentBranch ? " (current)" : ""}</option>`).join("");
    return `<label class="git-ui-branch-field"><span>Branch</span><select id="gitUiOpBranch"><option value="" ${defaultBranch ? "" : "selected"}>Current upstream</option>${options}</select></label>`;
  }

  function renderGitOpModeSelect(label, options, selected = "regular") {
    return `<label class="git-ui-branch-field"><span>${esc(label)}</span><select id="gitUiOpMode">${options.map(([value, text]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;
  }

  function renderGitOpModalShell(title, body, actionLabel, actionClass, actionMethod) {
    return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>${esc(title)}</strong></div>${body}<div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeGitOpModal()">Cancel</button><button class="git-ui-btn ${esc(actionClass)}" onclick="HerdrGitUi.${actionMethod}()">${esc(actionLabel)}</button></div></div></div>`;
  }

  function branchOptions(label, branches) {
    if (!branches.length) return "";
    return `<optgroup label="${esc(label)}">${branches.map((branch) => {
      const worktreePath = String(branch.worktree_path || "");
      const worktreeAttrs = worktreePath ? ` data-worktree-path="${esc(worktreePath)}" title="Checked out at ${esc(worktreePath)}"` : "";
      const worktreeLabel = worktreePath ? ` (worktree: ${esc(compactPath(worktreePath))})` : "";
      return `<option value="${branch.remote ? "remote:" : "local:"}${esc(branch.name)}"${worktreeAttrs} ${branch.current ? "selected" : ""}>${esc(branch.name)}${branch.current ? " (current)" : ""}${worktreeLabel}</option>`;
    }).join("")}</optgroup>`;
  }

  function localNameForRemote(remote) {
    const parts = String(remote || "").split("/");
    return parts.length > 1 ? parts.slice(1).join("/") : remote;
  }

  function fileSummary(path, kind) {
    const files = fileSummaryEntries(path, kind);
    const status = fileTreeStatus(path, kind);
    const icon = status === "added" || status === "untracked" ? "+" : status === "deleted" ? "−" : status === "conflict" ? "!" : "✎";
    const cls = status === "added" || status === "untracked" ? "add" : status === "deleted" ? "del" : status === "conflict" ? "conflict" : "edit";
    const totals = files.reduce((total, entry) => {
      const additions = Number(entry.additions);
      const deletions = Number(entry.deletions);
      if (Number.isFinite(additions)) total.additions += additions;
      if (Number.isFinite(deletions)) total.deletions += deletions;
      return total;
    }, { additions: 0, deletions: 0 });
    const hasCounts = files.some((entry) => Number.isFinite(Number(entry.additions)) || Number.isFinite(Number(entry.deletions)));
    const counts = hasCounts ? `<span class="git-ui-file-counts"><b>+${totals.additions}</b><i>-${totals.deletions}</i></span>` : "";
    return `<span class="git-ui-file-summary"><span class="git-ui-file-icon ${cls}">${icon}</span>${counts}</span>`;
  }

  function fileSummaryEntries(path, kind) {
    const exact = fileSummaryForPath(path, kind);
    if (exact) return [exact];
    const prefix = `${String(path || "").replace(/\/+$/, "")}/`;
    return filesForKind(kind)
      .filter((file) => String(file || "").startsWith(prefix))
      .map((file) => fileSummaryForPath(file, kind))
      .filter(Boolean);
  }

  function fileSummaryForPath(path, kind) {
    const view = active() || {};
    const statusSummaries = ((view.status || {}).summaries) || {};
    const summary = kind === "S" ? (statusSummaries.staged || {})[path] : kind === "M" ? (statusSummaries.unstaged || {})[path] : null;
    return (kind === "C" ? commitPreviewFile(path) : null) || diffFile(path) || summary || null;
  }

  function filesForKind(kind) {
    const view = active() || {};
    const status = view.status || {};
    if (kind === "S") return status.staged || [];
    if (kind === "M") return status.unstaged || [];
    if (kind === "?") return status.untracked || [];
    if (kind === "U") return status.conflicted || [];
    if (kind === "C") {
      if (view.tab === "log") return (((view.selectedCommitPreview || {}).diff || {}).files || []).map((file) => file.path);
      if (view.compareFilePaths && view.compareFilePaths.length) return view.compareFilePaths;
      return ((view.diff && view.diff.files) || []).map((file) => file.path);
    }
    return [];
  }

  function fileTreeStatus(path, kind) {
    const entries = fileSummaryEntries(path, kind);
    const statuses = entries.map((entry) => normalizeFileTreeStatus(entry.status, kind));
    if (!entries.length) statuses.push(normalizeFileTreeStatus("", kind));
    if (statuses.includes("conflict")) return "conflict";
    if (statuses.includes("deleted")) return "deleted";
    if (statuses.includes("modified")) return "modified";
    if (statuses.includes("changed")) return "changed";
    if (statuses.includes("untracked")) return "untracked";
    if (statuses.includes("added")) return "added";
    return statuses[0] || "modified";
  }

  function normalizeFileTreeStatus(status, kind) {
    const value = String(status || "").toLowerCase();
    if (kind === "U" || value.includes("conflict")) return "conflict";
    if (kind === "?" || value === "untracked") return "untracked";
    if (value === "added" || value === "new") return "added";
    if (value === "deleted" || value === "removed") return "deleted";
    if (value === "renamed" || value === "copied") return "changed";
    return "modified";
  }

  function renderGitViewTabs(tabs, activeTab) {
    return `<div class="git-ui-view-toggle-group" role="tablist" aria-label="Git views">${tabs.map((tab) => {
      const disabled = tab.disabled ? " disabled" : "";
      const title = tab.disabled ? ` title="${esc(tab.disabledReason || "Unavailable")}"` : "";
      const onclick = tab.disabled ? "" : ` onclick="HerdrGitUi.tab('${tab.id}')"`;
      return `<button class="git-ui-view-toggle ${tab.id === "cleanup" ? "git-ui-cleanup-tab" : ""} ${activeTab === tab.id ? "active" : ""}" type="button" role="tab" aria-selected="${activeTab === tab.id ? "true" : "false"}"${title}${onclick}${disabled}>${tab.label}</button>`;
    }).join("")}</div>`;
  }


  function hasStagedChanges(view) {
    const status = (view && view.status) || {};
    return (status.staged || []).length > 0;
  }

  function stashCount(view) {
    return Math.max(0, Number(((view && view.status) || {}).stashes || 0));
  }

  function canOpenStashView(view) {
    return stashCount(view) > 0;
  }

  function commitPreviewFile(path) {
    const preview = ((active() || {}).selectedCommitPreview) || {};
    return ((preview.diff && preview.diff.files) || []).find((file) => file.path === path);
  }

  function commitPreviewSection(view, filter) {
    const selected = view.selectedLogCommits || [];
    if (view.tab !== "log" || selected.length !== 1) return "";
    const preview = view.selectedCommitPreview || {};
    const label = selected[0].slice(0, 12);
    if (preview.loading) return `<div class="git-ui-section"><div class="git-ui-section-head"><strong>Committed files</strong><em>${esc(label)}</em></div><div class="git-ui-empty-row">Loading commit files…</div></div>`;
    if (preview.error) return `<div class="git-ui-section"><div class="git-ui-section-head"><strong>Committed files</strong><em>${esc(label)}</em></div><div class="git-ui-error">${esc(preview.error)}</div></div>`;
    const files = ((preview.diff && preview.diff.files) || []).map((file) => file.path);
    return section(`Committed files ${label}`, filterFiles(files, filter), "C");
  }

  function historicalFileCommitLabel(view) {
    const hash = view && (view.historyCommitHash || view.compareTarget || "");
    return hash ? String(hash).slice(0, 12) : "selected commit";
  }

  function clearHistoryCompareState(view, options = {}) {
    if (!view) return;
    view.temporaryHistoryCompare = false;
    view.historyCommitHash = "";
    if (options.clearSource) view.historySource = "";
    if (options.clearBackTarget) view.fileBackTarget = null;
  }

  function resetToChangesMode(view, options = {}) {
    if (!view) return;
    view.mode = "changes";
    view.compareBase = "";
    view.compareTarget = "";
    clearHistoryCompareState(view, options);
  }

  function startHistoryCommitCompare(view, hash) {
    if (!view || !hash) return;
    view.compareBase = `${hash}^`;
    view.compareTarget = hash;
    view.mode = "readonly-compare";
    view.temporaryHistoryCompare = !!view.file;
    view.historyCommitHash = hash;
    view.fileBackTarget = null;
    if (view.file) view.compareFilePaths = [view.file];
  }

  function fileViewStateLabel(view, activeTab) {
    if (activeTab === "history") return view.file ? `History · ${view.file}` : "File history";
    if (view.fileBackTarget && view.fileBackTarget.type === "log") return `Committed file · ${view.file || "file"} · ${historicalFileCommitLabel(view)}`;
    if (view.temporaryHistoryCompare) return `Committed file · ${view.file || "file"} · ${historicalFileCommitLabel(view)}`;
    if (view.file && currentMode() === "changes") return `Current file · ${view.file}`;
    if (view.file && currentMode() !== "changes") return `Compared file · ${view.file}`;
    if (currentMode() === "changes") return "Current changes";
    return "Compared changes";
  }

  function fileToolbarBackButton(view, activeTab) {
    if (activeTab === "history") return `<button class="git-ui-btn" title="Back to file view" onclick="HerdrGitUi.backToFileView()">← Back</button>`;
    if (view.temporaryHistoryCompare) return `<button class="git-ui-btn" title="Back to file history" onclick="HerdrGitUi.backToFileHistory()">← Back</button>`;
    if (view.fileBackTarget || currentMode() !== "changes") return `<button class="git-ui-btn" title="Back" onclick="HerdrGitUi.backFromFileView()">← Back</button>`;
    return "";
  }

  function aheadBehindHint(s) {
    const ahead = Number(s.ahead) || 0;
    const behind = Number(s.behind) || 0;
    const upstream = String(s.upstream || "").trim();
    if (!upstream) return "";
    const parts = [];
    if (ahead > 0) parts.push(`ahead ${ahead} (local has commits not on ${upstream})`);
    if (behind > 0) parts.push(`behind ${behind} (${upstream} has commits not on local)`);
    if (!parts.length) parts.push(`in sync with ${upstream}`);
    return parts.join(" · ");
  }

  function renderAheadBehind(s, esc) {
    const upstream = String(s.upstream || "").trim();
    if (!upstream) return "";
    const ahead = Number(s.ahead) || 0;
    const behind = Number(s.behind) || 0;
    const title = aheadBehindHint(s);
    const badges = [];
    if (ahead > 0) badges.push(`<span class="git-ui-ahead-behind ahead" title="${esc(title)}">↑${esc(String(ahead))}</span>`);
    if (behind > 0) badges.push(`<span class="git-ui-ahead-behind behind" title="${esc(title)}">↓${esc(String(behind))}</span>`);
    if (!badges.length) badges.push(`<span class="git-ui-ahead-behind synced" title="${esc(title)}">✓</span>`);
    return `<span class="git-ui-ahead-behind-group" title="${esc(title)}">${badges.join("")}</span>`;
  }

  function renderSide() {
    const view = active() || {};
    const s = view.status || {};
    const cleanupOnly = isNoGitRepositoryView(view);
    const disabledReason = "Open a Git repository to use this view";
    const tabs = cleanupOnly
      ? [{ id: "changes", label: "changes", disabled: true, disabledReason }, { id: "log", label: "log", disabled: true, disabledReason }, { id: "stash", label: "stash", disabled: true, disabledReason }, { id: "cleanup", label: "cleanup" }]
      : [{ id: "changes", label: "changes" }, { id: "log", label: "log" }, { id: "stash", label: stashCount(view) ? `stash (${stashCount(view)})` : "stash", disabled: !canOpenStashView(view), disabledReason: "No stashes stored. Refresh to rescan." }, { id: "cleanup", label: "cleanup" }];
    const filter = String(view.fileFilter || "").trim();
    const committedSelection = view.temporaryHistoryCompare || (view.fileBackTarget && view.fileBackTarget.type === "log");
    const fileSections = view.tab === "log"
      ? commitPreviewSection(view, filter)
      : committedSelection && view.file
        ? section(`Committed files ${historicalFileCommitLabel(view)}`, filterFiles(view.compareFilePaths && view.compareFilePaths.length ? view.compareFilePaths : [view.file], filter), "C")
      : currentMode() === "changes"
        ? `${(s.conflicted || []).length ? section("Conflicted", filterFiles(s.conflicted, filter), "U") : ""}${section("Staged", filterFiles(s.staged, filter), "S")}${section("Unstaged", filterFiles(s.unstaged, filter), "M")}${section("Untracked", filterFiles(s.untracked, filter), "?")}`
        : section("Compared", filterFiles(view.compareFilePaths && view.compareFilePaths.length ? view.compareFilePaths : ((view.diff && view.diff.files) || []).map((file) => file.path), filter), "C");
    const canCommit = hasStagedChanges(view);
    const commitHint = canCommit ? titleWithGitShortcut("Commit staged changes", "commit") : titleWithGitShortcut("Stage changes before committing", "commit");
    const commitDisabled = canCommit ? "" : " disabled";
    const branchLabel = `${view.titleKind || "Branch"}: ${s.branch || view.title || "No branch"}`;
    const error = view.error && !cleanupOnly ? `<div class="git-ui-error">${esc(view.error)}</div>` : "";
    const actions = cleanupOnly ? "" : `<div class="git-ui-toolbar"><div class="git-ui-toolbar-title">Worktree actions</div><div class="git-ui-actions"><button class="git-ui-btn primary" title="${esc(commitHint)}" onclick="HerdrGitUi.openCommitModal()"${commitDisabled}>Commit</button><button class="git-ui-btn" onclick="HerdrGitUi.openPullModal()">↓ Pull</button><button class="git-ui-btn" onclick="HerdrGitUi.openPushModal()">↑ Push</button><button class="git-ui-btn" onclick="HerdrGitUi.rebase()">Rebase</button><button class="git-ui-btn danger" onclick="HerdrGitUi.reset()">Reset</button></div></div>`;
    const filterInput = sideFileCount(view)
      ? `<label class="git-ui-file-filter"><span class="git-ui-file-filter-icon" aria-hidden="true"></span><input value="${esc(view.fileFilter || "")}" id="gitUiFileFilter" name="git-ui-file-filter" autocomplete="off" placeholder="Filter files" oninput="HerdrGitUi.filterFiles(this.value)"></label>`
      : "";
    const fileList = cleanupOnly ? "" : `${filterInput}${fileSections}`;
    const sideBottom = cleanupOnly ? "" : renderDiffLayoutSideToggle(view);
    const returnToWorkspace = !cleanupOnly && !gitCwdMatchesWorkspace(view)
      ? `<button class="git-ui-refresh-icon git-ui-return-cwd-icon" title="Return Git to current workspace folder" aria-label="Return Git to current workspace folder" onclick="HerdrGitUi.returnToWorkspaceCwd()"><span></span></button>`
      : "";
    const returnToCurrentChanges = !cleanupOnly && currentMode() !== "changes"
      ? `<button class="git-ui-refresh-icon git-ui-current-changes-icon" title="Return to current changes" aria-label="Return to current changes" onclick="HerdrGitUi.latestChanges()"><span></span></button>`
      : "";
    const refreshButton = appRefreshIconButton({ className: "git-ui-refresh-icon", title: titleWithGitShortcut("Refresh", "refresh"), label: titleWithGitShortcut("Refresh Git state", "refresh"), spinning: !!view.refreshAnimating, onclick: "HerdrGitUi.refreshWithSpin()" });
    const aheadBehind = cleanupOnly ? "" : renderAheadBehind(s, esc);
    const busy = view.mutating ? `<span class="git-ui-busy"><span class="git-ui-busy-spinner"></span>${esc(view.mutatingLabel || "Working...")}</span>` : "";
    return `<aside class="git-ui-side" onscroll="HerdrGitUi.sideScroll(this)"><div class="git-ui-head"><div class="git-ui-head-main"><div class="git-ui-title-row"><div class="git-ui-title">Git</div><div class="git-ui-title-actions">${busy}${returnToCurrentChanges}${returnToWorkspace}${refreshButton}</div></div><div class="git-ui-subtitle">${esc(s.state || "closed")} · ${esc(compactPath(s.repo_path))}</div><button class="git-ui-branch-pill" title="${esc(titleWithGitShortcut("Change Git directory or switch branch", "branch"))}" onclick="HerdrGitUi.openBranchModal()"><span>${esc(branchLabel)}</span>${aheadBehind}<b>↗</b></button></div></div>${error}<div class="git-ui-toolbar git-ui-view-toolbar">${renderGitViewTabs(tabs, view.tab)}</div>${actions}${fileList}${sideBottom}</aside>`;
  }

  function renderDiffLayoutSideToggle(view) {
    const layout = diffLayoutMode();
    const label = view && view.file ? "File view" : "Diff view";
    return `<div class="git-ui-side-bottom"><div class="git-ui-toolbar-title">${label}</div><div class="git-ui-view-toggle-group git-ui-diff-layout-toggle" role="group" aria-label="Diff layout"><button class="git-ui-view-toggle ${layout === "side-by-side" ? "active" : ""}" title="Show side-by-side diff" onclick="HerdrGitUi.setDiffLayout('side-by-side')">Side</button><button class="git-ui-view-toggle ${layout === "unified" ? "active" : ""}" title="Show unified diff" onclick="HerdrGitUi.setDiffLayout('unified')">Unified</button></div></div>`;
  }

  function filterFiles(files, filter) {
    const needle = String(filter || "").trim().toLowerCase();
    if (!needle) return files || [];
    return (files || []).filter((file) => String(file || "").toLowerCase().includes(needle));
  }

  function sideFileCount(view) {
    if (!view) return 0;
    const status = view.status || {};
    if (view.tab === "log") return (((view.selectedCommitPreview || {}).diff || {}).files || []).length;
    if (view.temporaryHistoryCompare && view.file) return 1;
    if (currentMode() === "changes") {
      return [status.conflicted, status.staged, status.unstaged, status.untracked]
        .reduce((total, list) => total + ((list || []).length), 0);
    }
    const compared = view.compareFilePaths && view.compareFilePaths.length
      ? view.compareFilePaths
      : ((view.diff && view.diff.files) || []).map((file) => file.path);
    return (compared || []).length;
  }

  function renderFileToolbar(activeTab) {
    const view = active() || {};
    const conflicts = ((((view.status || {}).conflicted) || []).length > 0);
    const breadcrumbs = renderNavigationTrail(view);
    const back = breadcrumbs ? "" : fileToolbarBackButton(view, activeTab);
    const viewStateLabel = fileViewStateLabel(view, activeTab);
    const stateLabel = breadcrumbs || `<span class="git-ui-compare-state git-ui-file-view-state" title="${esc(viewStateLabel)}">${esc(viewStateLabel)}</span>`;
    const compare = activeTab !== "history" && currentMode() !== "changes" && !view.temporaryHistoryCompare && !view.fileBackTarget
      ? `<span class="git-ui-compare-state">Comparing ${esc(view.compareBase || "base")} → ${esc(view.compareTarget || "target")}</span>`
      : "";
    const files = (view.diff && view.diff.files) || [];
    const collapsible = activeTab === "changes" && files.length > 0;
    const collapsed = files.filter((file) => view.collapsedFiles && view.collapsedFiles[file.path]).length;
    const collapse = collapsible ? `<button class="git-ui-btn" onclick="HerdrGitUi.${collapsed === files.length ? "expandAllFiles" : "collapseAllFiles"}()">${collapsed === files.length ? "Show all" : "Collapse all"}</button>` : "";
    const changes = currentMode() === "changes" ? `<button class="git-ui-btn ${activeTab === "changes" ? "active" : ""}" onclick="HerdrGitUi.latestChanges()">Changes</button>` : "";
    const history = view.file ? `<button class="git-ui-btn ${activeTab === "history" ? "active" : ""}" title="${esc(titleWithGitShortcut("File history", "history"))}" onclick="HerdrGitUi.tab('history')">History</button>` : "";
    const blame = activeTab === "changes" && view.file ? `<button class="git-ui-btn ${view.showBlame ? "active" : ""}" title="${esc(titleWithGitShortcut("Blame", "blame"))}" onclick="HerdrGitUi.toggleBlame()">Blame</button>` : "";
    const sideEditor = view.sideEditor && view.sideEditor.path === view.file
      ? `<button class="git-ui-btn primary" ${view.sideEditor.saving ? "disabled" : ""} onclick="HerdrGitUi.saveSideEditor()">${view.sideEditor.saving ? "Saving..." : "Save edits"}</button><button class="git-ui-btn" onclick="HerdrGitUi.cancelSideEditor()">Cancel edits</button>`
      : activeTab === "changes" && canEditCurrentFile(view)
        ? `<button class="git-ui-btn" title="${esc(titleWithGitShortcut("Edit side-by-side", "edit"))}" onclick="HerdrGitUi.editSideBySide()">Edit side-by-side</button>`
        : "";
    const search = renderDiffSearchControl(view);
    return `<div class="git-ui-log-head">${back}${stateLabel}${changes}${history}${blame}${sideEditor}${conflicts ? `<button class="git-ui-btn ${activeTab === "conflicts" ? "active" : ""}" onclick="HerdrGitUi.tab('conflicts')">Conflicts</button>` : ""}${collapse}${search}${compare}</div>`;
  }

  function renderDiffSearchControl(view) {
    if (!canSearchDiff(view)) return "";
    const query = String(view.diffSearchQuery || "");
    if (!view.diffSearchOpen && !query) return `<button class="git-ui-btn" title="Search compared text (Ctrl+F)" onclick="HerdrGitUi.openDiffSearch()">Search</button>`;
    const count = query.trim() ? diffSearchMatchCount(view, query) : 0;
    const countText = query.trim() ? `${count} match${count === 1 ? "" : "es"}` : "";
    return `<label class="git-ui-diff-search" title="Search compared text"><span>Search</span><input id="gitUiDiffSearch" value="${esc(query)}" autocomplete="off" spellcheck="false" placeholder="Search compared text" oninput="HerdrGitUi.setDiffSearch(this.value)"></label><span class="git-ui-diff-search-count">${esc(countText)}</span><button class="git-ui-btn" title="Clear diff search" onclick="HerdrGitUi.clearDiffSearch()">×</button>`;
  }

  function canEditCurrentFile(view) {
    if (!view || !view.file || view.file.endsWith("/")) return false;
    if (currentMode() === "readonly-compare" && view.compareTarget !== ".") return false;
    if (view.diffKind === "S" || view.diffScope === "staged") return false;
    const file = diffFile(view.file);
    return !file || file.status !== "deleted";
  }

  function renderDiff() {
    const view = active() || {};
    if (view.sideEditor && view.sideEditor.path === view.file) return `${renderFileToolbar("changes")}${renderSideEditor(view)}`;
    const files = (view.diff && view.diff.files) || [];
    const head = renderFileToolbar("changes");
    if (view.diff && view.diff.skipped_large_change_set) {
      const shells = largeChangeDiffShells(view);
      return `${head}${shells.length ? shells.map(renderDiffFile).join("") : `<div class="git-ui-muted">No diff.</div>`}`;
    }
    if (!files.length) return `${head}<div class="git-ui-muted">No diff.</div>`;
    const limit = largeDiffLineLimit();
    const count = diffLineCount(files);
    if (view.file && limit > 0 && count > limit && !((view.loadedLargeDiffFiles || {})[view.file])) {
      return `${head}<div class="git-ui-large-diff"><strong>Large diff hidden</strong><span>${count} lines exceed ${limit} line limit.</span><button class="git-ui-btn" onclick="HerdrGitUi.loadLargeDiff('${arg(view.file)}')">Load diff</button></div>`;
    }
    return `${head}${files.map(renderDiffFile).join("")}`;
  }

  function largeChangeDiffShells(view) {
    const loaded = (view.diff && view.diff.files) || [];
    const loadedByKey = new Map(loaded.map((file) => [`${file.diff_kind || ""}:${file.path}`, file]));
    return largeChangeFileItems(view).map((item) => loadedByKey.get(`${item.kind}:${item.path}`) || largeChangeHiddenFile(view, item));
  }

  function largeChangeFileItems(view) {
    const status = (view && view.status) || {};
    const items = [];
    const push = (paths, kind) => (paths || []).forEach((path) => items.push({ path, kind }));
    push(status.conflicted, "U");
    push(status.staged, "S");
    push(status.unstaged, "M");
    push(status.untracked, "?");
    return items.filter((item, index) => items.findIndex((other) => other.path === item.path && other.kind === item.kind) === index);
  }

  function largeChangeHiddenFile(view, item) {
    const statusSummaries = ((view.status || {}).summaries) || {};
    const summary = item.kind === "S" ? (statusSummaries.staged || {})[item.path] : item.kind === "M" ? (statusSummaries.unstaged || {})[item.path] : null;
    return Object.assign({ path: item.path, diff_kind: item.kind, hidden_large_change: true, chunks: [] }, summary || {});
  }

  function renderSideEditor(view) {
    const editor = view.sideEditor || {};
    if (editor.loading) return `<div class="git-ui-editor"><div class="git-ui-loading"><span></span><strong>Loading file editor</strong></div></div>`;
    const error = editor.error ? `<div class="git-ui-side-edit-note error">${esc(editor.error)}</div>` : `<div class="git-ui-side-edit-note">Edit current hunk text on right. Previous hunk stays read-only. Save merges hunk edits into file and recalculates diff.</div>`;
    const hunks = (editor.hunks || []).map(renderEditableHunk).join("") || `<div class="git-ui-muted">No editable hunks for this file.</div>`;
    return `${error}<div class="git-ui-hunk-editor-list">${hunks}</div>`;
  }

  function renderEditableHunk(hunk) {
    const oldText = hunk.oldText || "";
    const currentText = hunk.text || "";
    const readonly = hunk.newStart ? "" : " readonly";
    const meta = hunk.newStart ? `current lines ${hunk.newStart}-${hunk.newEnd}` : "no current lines";
    return `<div class="git-ui-hunk-editor"><div class="git-ui-hunk-head"><span>${esc(hunk.header || "hunk")}</span><span class="git-ui-muted">${esc(meta)}</span></div><div class="git-ui-hunk-editor-grid"><section><div class="git-ui-editor-head"><strong>Previous</strong><span class="git-ui-muted">read-only</span></div><div class="git-ui-hunk-edit-mount git-ui-hunk-old-mount" data-hunk-index="${hunk.index}" data-editor-side="old" data-readonly="true"></div><textarea class="git-ui-hunk-old git-ui-hunk-old-hidden git-ui-hunk-edit-hidden" data-hunk-index="${hunk.index}" spellcheck="false" readonly>${esc(oldText)}</textarea></section><section><div class="git-ui-editor-head"><strong>Current</strong><span class="git-ui-muted">editable hunk</span></div><div class="git-ui-hunk-edit-mount git-ui-hunk-current-mount" data-hunk-index="${hunk.index}" data-editor-side="current" data-readonly="${hunk.newStart ? "false" : "true"}"></div><textarea class="git-ui-hunk-edit git-ui-hunk-current-hidden git-ui-hunk-edit-hidden" data-hunk-index="${hunk.index}" spellcheck="false"${readonly}>${esc(currentText)}</textarea></section></div></div>`;
  }

  function buildEditableHunks(file) {
    return ((file && file.chunks) || []).map((chunk, index) => {
      const oldLines = [];
      const newLines = [];
      const newNumbers = [];
      const oldLineTypes = [];
      const newLineTypes = [];
      for (const line of chunk.lines || []) {
        if (line.line_type !== "add") {
          oldLines.push(line.content || "");
          oldLineTypes.push(line.line_type === "delete" ? "del" : "context");
        }
        if (line.line_type !== "delete") {
          newLines.push(line.content || "");
          newLineTypes.push(line.line_type === "add" ? "add" : "context");
          if (line.new_line_number) newNumbers.push(line.new_line_number);
        }
      }
      return {
        index,
        header: chunk.header,
        oldText: oldLines.join("\n"),
        text: newLines.join("\n"),
        oldLineTypes,
        newLineTypes,
        newStart: newNumbers.length ? Math.min.apply(null, newNumbers) : 0,
        newEnd: newNumbers.length ? Math.max.apply(null, newNumbers) : 0,
      };
    });
  }

  function sideEditorOriginalLineClasses(hunk, side) {
    const types = side === "old" ? (hunk.oldLineTypes || []) : (hunk.newLineTypes || []);
    const classForType = { del: "git-ui-side-line-del", add: "git-ui-side-line-add" };
    const result = [];
    let i = 0;
    while (i < types.length) {
      const className = classForType[types[i]] || "";
      if (!className) { i++; continue; }
      let j = i;
      while (j < types.length && classForType[types[j]] === className) j++;
      result.push({ fromLine: i + 1, toLine: j, className });
      i = j;
    }
    return result;
  }

  function changedLineClasses(baseText, currentText) {
    if (String(baseText || "") === String(currentText || "")) return [];
    const baseLines = String(baseText || "").split("\n");
    const currentLines = String(currentText || "").split("\n");
    const changed = changedCurrentLineIndexes(baseLines, currentLines);
    return lineIndexesToRanges(changed, "git-ui-side-line-edit");
  }

  function changedCurrentLineIndexes(baseLines, currentLines) {
    const maxCells = 40000;
    if (baseLines.length * currentLines.length > maxCells) return changedCurrentLineIndexesByBounds(baseLines, currentLines);
    const rows = baseLines.length + 1;
    const cols = currentLines.length + 1;
    const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));
    for (let i = baseLines.length - 1; i >= 0; i--) {
      for (let j = currentLines.length - 1; j >= 0; j--) {
        dp[i][j] = baseLines[i] === currentLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const matched = new Set();
    let i = 0;
    let j = 0;
    while (i < baseLines.length && j < currentLines.length) {
      if (baseLines[i] === currentLines[j]) {
        matched.add(j);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }
    const changed = [];
    for (let line = 0; line < currentLines.length; line++) {
      if (!matched.has(line)) changed.push(line);
    }
    return changed.length ? changed : changedCurrentLineIndexesByBounds(baseLines, currentLines);
  }

  function changedCurrentLineIndexesByBounds(baseLines, currentLines) {
    let start = 0;
    while (start < baseLines.length && start < currentLines.length && baseLines[start] === currentLines[start]) start++;
    let baseEnd = baseLines.length - 1;
    let currentEnd = currentLines.length - 1;
    while (baseEnd >= start && currentEnd >= start && baseLines[baseEnd] === currentLines[currentEnd]) {
      baseEnd--;
      currentEnd--;
    }
    const changed = [];
    if (currentEnd < start && currentLines.length) return [Math.min(start, currentLines.length - 1)];
    for (let line = start; line <= currentEnd; line++) changed.push(line);
    return changed;
  }

  function lineIndexesToRanges(indexes, className) {
    const result = [];
    let i = 0;
    while (i < indexes.length) {
      const start = indexes[i];
      let end = start;
      i++;
      while (i < indexes.length && indexes[i] === end + 1) {
        end = indexes[i];
        i++;
      }
      result.push({ fromLine: start + 1, toLine: end + 1, className });
    }
    return result;
  }

  function renderDiffFile(file) {
    const mode = currentMode();
    const view = active() || {};
    const collapsed = !!(view.collapsedFiles || {})[file.path];
    const lineCount = diffFileLineCount(file);
    const large = lineCount > LARGE_FILE_DIFF_LINE_LIMIT;
    const loadedLarge = !!(view.loadedLargeDiffFiles || {})[file.path];
    const renderFullLarge = !!(view.fullLargeDiffFiles || {})[diffFileKey(file)];
    const left = mode === "changes" ? fileDiffLeftLabel(file) : (view.compareBase || "base");
    const right = mode === "readonly-compare" ? (view.compareTarget || "target") : "current";
    if (view.showBlame && (!large || loadedLarge)) ensureBlame(file.path);
    const restore = mode === "changes"
      ? `<button class="git-ui-btn danger" title="Restore complete file" onclick="HerdrGitUi.discardFile('${arg(file.path)}')">Restore file</button>`
      : "";
    const body = collapsed
      ? ""
      : file.hidden_large_change
        ? renderLargeChangePlaceholder(file)
        : large && !loadedLarge
          ? renderLargeDiffPlaceholder(file)
          : renderDiffFileBody(file, lineCount, large, renderFullLarge);
    return `<div class="git-ui-diff-file" data-git-path="${esc(file.path)}"><div class="git-ui-diff-file-head"><button class="git-ui-file-collapse" title="${collapsed ? "Show file" : "Collapse file"}" onclick="HerdrGitUi.toggleFile('${arg(file.path)}')">${collapsed ? "+" : "−"}</button><strong>${esc(file.path)}</strong><span class="git-ui-muted">${esc(left)} → ${esc(right)}</span><span class="git-ui-diff-file-actions"><span class="git-ui-badge add">+${file.additions || 0}</span> <span class="git-ui-badge del">-${file.deletions || 0}</span>${restore}</span></div>${body}</div>`;
  }

  function renderDiffFileBody(file, lineCount, large, renderFullLarge) {
    const limit = loadedLargeDiffPreviewLimit();
    const preview = large && !renderFullLarge && lineCount > limit;
    const renderedFile = preview ? previewDiffFile(file, limit) : file;
    const body = (renderedFile.chunks || []).map((chunk, index) => renderChunk(renderedFile, chunk, index)).join("");
    if (!preview) return body;
    const renderedCount = diffFileLineCount(renderedFile);
    return `${body}<div class="git-ui-large-file-diff"><button class="git-ui-large-file-load" type="button" onclick="HerdrGitUi.renderFullLargeDiff('${arg(file.path)}','${arg(file.diff_kind || "")}')"><strong>Render full diff</strong></button><p>Showing ${renderedCount} preview lines from complete change groups out of ${lineCount} lines to reduce browser CPU and memory.</p></div>`;
  }

  function fileDiffLeftLabel(file) {
    if (file.diff_kind === "S") return "index";
    if (file.diff_kind === "?") return "new file";
    return "previous";
  }

  function renderLargeChangePlaceholder(file) {
    const id = `hidden-change-diff-reason-${hashText(`${file.diff_kind || ""}:${file.path}`)}`;
    return `<div class="git-ui-large-file-diff"><button aria-describedby="${id}" class="git-ui-large-file-load" type="button" onclick="HerdrGitUi.loadLargeDiff('${arg(file.path)}','${arg(file.diff_kind || "")}')"><strong>Load diff</strong></button><p id="${id}">Diff hidden to keep large change sets responsive.</p></div>`;
  }

  function renderLargeDiffPlaceholder(file) {
    const id = `hidden-diff-reason-${hashText(file.path)}`;
    return `<div class="git-ui-large-file-diff"><button aria-describedby="${id}" class="git-ui-large-file-load" type="button" onclick="HerdrGitUi.loadLargeDiff('${arg(file.path)}')"><strong>Load diff</strong></button><p id="${id}">Large diffs are not rendered by default.</p></div>`;
  }

  function scrollToDiffFile(path) {
    const nodes = Array.from(document.querySelectorAll(".git-ui-diff-file"));
    const target = nodes.find((node) => node.dataset.gitPath === path);
    if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function ensureBlame(path) {
    const view = active();
    if (!view || !path || view.blame[path] !== undefined || currentMode() === "readonly-compare") return;
    view.blame[path] = null;
    const ref = currentMode() === "changes" ? "working" : (view.compareTarget || "HEAD");
    api(`/api/git-ui/blame?cwd=${encodeURIComponent(view.cwd)}&file=${encodeURIComponent(path)}&ref_name=${encodeURIComponent(ref)}`)
      .then((data) => {
        view.blame[path] = parseBlame(data.text || "");
        if (state.visible) render();
      })
      .catch((err) => {
        view.blame[path] = { __error: err.message || String(err) };
        if (state.visible) render();
      });
  }

  function parseBlame(text) {
    const byLine = {};
    let author = "";
    let finalLine = 0;
    for (const line of String(text || "").split("\n")) {
      const header = line.match(/^[0-9a-f]{40}\s+\d+\s+(\d+)/);
      if (header) {
        finalLine = Number(header[1]) || 0;
        author = "";
        continue;
      }
      if (line.startsWith("author ")) {
        author = line.slice(7).trim();
        if (finalLine) byLine[finalLine] = author;
      }
    }
    return byLine;
  }

  function blameName(path, lineNumber) {
    const view = active() || {};
    if (!view.showBlame) return "";
    const blame = view.blame && view.blame[path];
    if (blame && blame.__error) return "blame unavailable";
    const name = blame && lineNumber ? blame[lineNumber] : "";
    if (!name) return "";
    return String(name).split(/\s+/).slice(0, 2).join(" ");
  }

  function renderChunk(file, chunk, index) {
    const path = file.path;
    const scope = (active() || {}).diffScope || "all";
    const hunkButton = file.preview_large_diff
      ? `<span class="git-ui-muted">render full diff for hunk actions</span>`
      : scope === "staged"
      ? `<button class="git-ui-btn" title="Unstage this hunk" onclick="HerdrGitUi.unstageHunk('${arg(path)}',${index})">Unstage hunk</button>`
      : scope === "working"
        ? `<button class="git-ui-btn" title="Stage this hunk" onclick="HerdrGitUi.stageHunk('${arg(path)}',${index})">Stage hunk</button>`
        : `<span class="git-ui-muted">select staged/unstaged file for hunk actions</span>`;
    const actions = canMutateDiff()
      ? `<span class="git-ui-hunk-actions">${hunkButton}</span>`
      : `<span class="git-ui-muted">read only</span>`;
    const rows = markChangeGroups(diffLayoutMode() === "unified" ? unifiedRows(chunk) : sideBySideRows(chunk));
    const contextArrows = contextArrowsForChunk(file.chunks || [], index);
    const body = diffLayoutMode() === "unified"
      ? rows.map((row, rowIndex) => renderUnifiedLine(row, path, index, rows, rowIndex, contextArrows)).join("")
      : rows.map((row, rowIndex) => renderLine(row, path, index, rows, rowIndex, contextArrows, !!file.preview_large_diff)).join("");
    return `<div class="git-ui-hunk ${diffLayoutMode() === "unified" ? "git-ui-hunk-unified" : ""}"><div class="git-ui-hunk-head"><span>${esc(chunk.header)}</span>${actions}</div><div class="git-ui-hunk-viewport">${body}</div><div class="git-ui-hunk-xscroll" aria-hidden="true"><div class="git-ui-hunk-xscroll-inner"></div></div></div>`;
  }

  function contextArrowsForChunk(chunks, index) {
    const chunk = chunks[index] || {};
    const prev = chunks[index - 1] || null;
    const next = chunks[index + 1] || null;
    const before = prev
      ? hiddenGap(prev, chunk)
      : (chunk.old_start || 0) > 1 || (chunk.new_start || 0) > 1;
    const after = next ? hiddenGap(chunk, next) : false;
    return { before, after };
  }

  function hiddenGap(left, right) {
    return ((right.old_start || 0) - hunkEnd(left, "old")) > 1 || ((right.new_start || 0) - hunkEnd(left, "new")) > 1;
  }

  function hunkEnd(chunk, side) {
    const start = side === "old" ? chunk.old_start : chunk.new_start;
    const count = side === "old" ? chunk.old_lines : chunk.new_lines;
    return (start || 0) + Math.max(0, (count || 0) - 1);
  }

  function unifiedRows(chunk) {
    return (chunk.lines || []).map((line) => ({ line }));
  }

  function sideBySideRows(chunk) {
    const lines = chunk.lines || [];
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.line_type === "delete") {
        const deletes = [];
        const adds = [];
        while (lines[i] && lines[i].line_type === "delete") deletes.push(lines[i++]);
        while (lines[i] && lines[i].line_type === "add") adds.push(lines[i++]);
        i--;
        const count = Math.max(deletes.length, adds.length);
        for (let j = 0; j < count; j++) rows.push({ oldLine: deletes[j] || null, newLine: adds[j] || null });
      } else if (line.line_type === "add") {
        rows.push({ oldLine: null, newLine: line });
      } else {
        rows.push({ oldLine: line, newLine: line });
      }
    }
    return rows;
  }

  function renderLine(row, path, hunkIndex, rows, rowIndex, contextArrows, previewLargeDiff) {
    const view = active() || {};
    const scope = view.diffScope || "all";
    const oldLine = row.oldLine;
    const newLine = row.newLine;
    const add = newLine && newLine.line_type === "add";
    const del = oldLine && oldLine.line_type === "delete";
    let cls = add && del ? "git-ui-change" : add ? "git-ui-add" : del ? "git-ui-del" : "";
    if (row.groupStart) cls += " git-ui-change-start";
    if (row.groupEnd) cls += " git-ui-change-end";
    const oldNo = oldLine && oldLine.old_line_number ? oldLine.old_line_number : "";
    const newNo = newLine && newLine.new_line_number ? newLine.new_line_number : "";
    const oldAuthor = blameName(path, oldNo);
    const newAuthor = blameName(path, newNo);
    const status = view.status || {};
    const canRestorePath = scope === "staged" || scope === "working" || (scope === "all" && ([...(status.staged || []), ...(status.unstaged || []), ...(status.untracked || [])].includes(path)));
    const blockButton = !previewLargeDiff && currentMode() === "changes" && canRestorePath && (add || del) && isFirstChange(rows, rowIndex)
      ? `<button class="git-ui-line-action" title="Restore this block" onclick="HerdrGitUi.restoreHunk('${arg(path)}',${hunkIndex})">&gt;&gt;</button>`
      : `<span class="git-ui-line-action-spacer"></span>`;
    const contextControls = rowIndex === 0 && contextArrows.before
      ? `<button class="git-ui-context-arrow" title="Expand lines before; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↑</button>`
      : rowIndex === rows.length - 1 && contextArrows.after
        ? `<button class="git-ui-context-arrow" title="Expand lines after; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↓</button>`
        : "";
    const oldCode = oldLine ? renderDiffCode(oldLine, newLine, path, "old") : "";
    const newCode = newLine ? renderDiffCode(oldLine, newLine, path, "new") : "";
    return `<div class="git-ui-diff-row ${cls}"><div class="git-ui-context-cell">${contextControls}</div><div class="git-ui-code git-ui-code-old"><span class="git-ui-code-text">${oldCode}</span></div><div class="git-ui-line-pair"><span class="git-ui-line-old"><em>${esc(oldAuthor)}</em>${oldNo}</span>${blockButton}<span class="git-ui-line-new"><em>${esc(newAuthor)}</em>${newNo}</span></div><div class="git-ui-code git-ui-code-new"><span class="git-ui-code-text">${newCode}</span></div></div>`;
  }

  function renderUnifiedLine(row, path, hunkIndex, rows, rowIndex, contextArrows) {
    const view = active() || {};
    const scope = view.diffScope || "all";
    const line = row.line || {};
    const add = line.line_type === "add";
    const del = line.line_type === "delete";
    let cls = add ? "git-ui-add" : del ? "git-ui-del" : "git-ui-context";
    if (row.groupStart) cls += " git-ui-change-start";
    if (row.groupEnd) cls += " git-ui-change-end";
    const oldNo = line.old_line_number || "";
    const newNo = line.new_line_number || "";
    const author = blameName(path, newNo || oldNo);
    const status = view.status || {};
    const canRestorePath = scope === "staged" || scope === "working" || (scope === "all" && ([...(status.staged || []), ...(status.unstaged || []), ...(status.untracked || [])].includes(path)));
    const blockButton = currentMode() === "changes" && canRestorePath && (add || del) && isFirstChange(rows, rowIndex)
      ? `<button class="git-ui-line-action" title="Restore this block" onclick="HerdrGitUi.restoreHunk('${arg(path)}',${hunkIndex})">↩</button>`
      : `<span class="git-ui-line-action-spacer"></span>`;
    const contextControls = rowIndex === 0 && contextArrows.before
      ? `<button class="git-ui-context-arrow" title="Expand lines before; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↑</button>`
      : rowIndex === rows.length - 1 && contextArrows.after
        ? `<button class="git-ui-context-arrow" title="Expand lines after; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↓</button>`
        : "";
    const sign = add ? "+" : del ? "-" : " ";
    const code = renderUnifiedDiffCode(line, rows, rowIndex, path);
    return `<div class="git-ui-unified-row ${cls}"><div class="git-ui-context-cell">${contextControls}</div><div class="git-ui-unified-lines"><span>${oldNo}</span><span>${newNo}</span></div><div class="git-ui-unified-action">${blockButton}</div><div class="git-ui-code git-ui-code-unified"><span class="git-ui-unified-author">${esc(author)}</span><span class="git-ui-unified-sign">${sign}</span><span class="git-ui-unified-text"><span class="git-ui-code-text">${code}</span></span></div></div>`;
  }

  function renderUnifiedDiffCode(line, rows, rowIndex, path) {
    if (!line || !["delete", "add"].includes(line.line_type)) return highlightDiffText((line && line.content) || "", path);
    const pair = unifiedChangePair(rows, rowIndex);
    if (!pair) return highlightDiffText(line.content || "", path);
    return renderDiffCode(pair.oldLine, pair.newLine, path, line.line_type === "delete" ? "old" : "new");
  }

  function unifiedChangePair(rows, rowIndex) {
    const line = rows[rowIndex] && rows[rowIndex].line;
    if (!line || !["delete", "add"].includes(line.line_type)) return null;
    let start = rowIndex;
    while (start > 0 && isChangedRow(rows[start - 1])) start--;
    let end = rowIndex;
    while (end + 1 < rows.length && isChangedRow(rows[end + 1])) end++;
    const deletes = [];
    const adds = [];
    for (let i = start; i <= end; i++) {
      const item = rows[i] && rows[i].line;
      if (item && item.line_type === "delete") deletes.push({ line: item, rowIndex: i });
      if (item && item.line_type === "add") adds.push({ line: item, rowIndex: i });
    }
    if (!deletes.length || !adds.length) return null;
    const list = line.line_type === "delete" ? deletes : adds;
    const index = Math.max(0, list.findIndex((item) => item.rowIndex === rowIndex));
    const otherIndex = Math.min(index, (line.line_type === "delete" ? adds : deletes).length - 1);
    return line.line_type === "delete"
      ? { oldLine: line, newLine: adds[otherIndex].line }
      : { oldLine: deletes[otherIndex].line, newLine: line };
  }

  function renderDiffCode(oldLine, newLine, path, side) {
    const line = side === "old" ? oldLine : newLine;
    if (!line) return "";
    if (!oldLine || !newLine || oldLine.line_type !== "delete" || newLine.line_type !== "add") {
      return highlightDiffText(line.content, path);
    }
    const parts = changedMiddle(oldLine.content || "", newLine.content || "");
    const content = side === "old" ? oldLine.content || "" : newLine.content || "";
    const changed = side === "old" ? parts.oldChanged : parts.newChanged;
    if (!changed.length) return highlightDiffText(content, path);
    return `${highlightDiffText(content.slice(0, changed.start), path)}<span class="git-ui-word-change">${highlightDiffText(content.slice(changed.start, changed.end), path)}</span>${highlightDiffText(content.slice(changed.end), path)}`;
  }

  function changedMiddle(oldText, newText) {
    let start = 0;
    while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    return { oldChanged: { start, end: oldEnd, length: oldEnd - start }, newChanged: { start, end: newEnd, length: newEnd - start } };
  }

  function markChangeGroups(rows) {
    for (let i = 0; i < rows.length; i++) {
      const changed = isChangedRow(rows[i]);
      if (!changed) continue;
      if (!isChangedRow(rows[i - 1])) rows[i].groupStart = true;
      if (!isChangedRow(rows[i + 1])) rows[i].groupEnd = true;
    }
    return rows;
  }

  function isChangedRow(row) {
    return !!(row && ((row.oldLine && row.oldLine.line_type === "delete") || (row.newLine && row.newLine.line_type === "add") || (row.line && (row.line.line_type === "add" || row.line.line_type === "delete"))));
  }

  function isFirstChange(rows, rowIndex) {
    return !!(rows[rowIndex] && rows[rowIndex].groupStart);
  }

  async function renderLog(version) {
    const view = active();
    const baseBranch = gitLogDefaultBranch();
    const logLimit = Math.max(1, Math.min(GIT_LOG_MAX_LIMIT, Number(view.logLimit || GIT_LOG_PAGE_SIZE)));
    view.logLimit = logLimit;
    view.logScope = normalizeLogScope(view.logScope || (view.logAll ? "all" : "base-current"));
    view.logAll = view.logScope === "all";
    const fileParam = view.logFilePath ? `&file=${encodeURIComponent(view.logFilePath)}` : "";
    const data = await api(`/api/git-ui/log?cwd=${encodeURIComponent(view.cwd)}&all=${view.logAll ? "true" : "false"}&scope=${encodeURIComponent(view.logScope)}&base=${encodeURIComponent(baseBranch)}&max=${logLimit}${fileParam}`);
    const selected = view.selectedLogCommits || [];
    view.logData = data;
    const selectedBranch = selected.length === 1 && window.HerdrGitLog && window.HerdrGitLog.selectedBranchForHash
      ? window.HerdrGitLog.selectedBranchForHash(data, selected[0], baseBranch)
      : "";
    view.selectedLogBranch = selectedBranch;
    const compare = Actions.selectedLogToolbar(selected, { allowRewrite: currentMode() === "changes", selectedBranch });
    replaceContent(version, window.HerdrGitLog.render({
      data,
      selected,
      logAll: view.logAll,
      logScope: view.logScope,
      logLimit: view.logLimit,
      logLoadingMore: !!view.logLoadingMore,
      baseBranch,
      filePath: view.logFilePath || "",
      actionsHtml: compare,
      filters: view.logFilters || {},
      esc,
      arg,
      status: view.status || {},
    }));
    updateGitLogStickyOffsets();
    if (view.pendingLogScrollHash) {
      const hash = view.pendingLogScrollHash;
      view.pendingLogScrollHash = "";
      requestAnimationFrame(() => window.HerdrGitLog.scrollToCommit(hash));
    }
  }

  function updateGitLogStickyOffsets() {
    requestAnimationFrame(() => {
      const content = document.querySelector(".git-ui-content");
      if (!content) return;
      const scope = content.querySelector(".git-ui-log-scope-head");
      const head = content.querySelector(".git-ui-log-table-head");
      const scopeHeight = scope ? Math.ceil(scope.getBoundingClientRect().height + 10) : 0;
      const headHeight = head ? Math.ceil(head.getBoundingClientRect().height) : 0;
      content.style.setProperty("--git-log-scope-sticky-height", `${scopeHeight}px`);
      content.style.setProperty("--git-log-table-head-sticky-height", `${headHeight}px`);
    });
  }

  async function renderStash(version) {
    const view = active();
    const data = await api(`/api/git-ui/stashes?cwd=${encodeURIComponent(view.cwd)}`);
    replaceContent(version, `<div class="git-ui-actions"><button class="git-ui-btn" onclick="HerdrGitUi.stash()">Stash push</button></div><div class="git-ui-list">${(data.stashes || []).map((s) => `<div class="git-ui-file"><span>${esc(s.name)} ${esc(s.message)}</span><span><button class="git-ui-btn" onclick="HerdrGitUi.applyStash('${arg(s.name)}',false)">Apply</button><button class="git-ui-btn" onclick="HerdrGitUi.applyStash('${arg(s.name)}',true)">Pop</button><button class="git-ui-btn danger" onclick="HerdrGitUi.dropStash('${arg(s.name)}')">Drop</button></span></div>`).join("")}</div>`);
  }

  function renderCleanup() {
    const view = active() || {};
    const root = esc(view.cleanupRoot || view.cwd || "");
    const result = view.cleanupResult || {};
    const repos = result.repos || [];
    const selected = cleanupSelectedItems(view);
    const truncated = result.truncated ? `<div class="git-ui-error">Scan stopped at safety limit; choose a smaller directory for complete results.</div>` : "";
    const bulk = repos.length
      ? `<div class="git-ui-actions git-ui-cleanup-bulk"><button class="git-ui-btn" onclick="HerdrGitUi.selectAllCleanup()">Check all</button><button class="git-ui-btn" onclick="HerdrGitUi.clearCleanupSelection()">Uncheck all</button><button class="git-ui-btn danger" onclick="HerdrGitUi.openCleanupDeleteConfirm()" ${selected.length ? "" : "disabled"}>Delete selected (${selected.length})</button></div>`
      : "";
    const body = view.cleanupLoading
      ? `<div class="git-ui-loading"><span></span><strong>Scanning Git repositories</strong></div>`
      : repos.length
        ? repos.map(renderCleanupRepo).join("")
        : `<div class="git-ui-empty-row">No scanned repositories yet. Choose a directory and scan.</div>`;
    return `<div class="git-ui-cleanup"><div class="git-ui-toolbar-title">Git branch and worktree cleanup</div><p class="git-ui-muted">Scan a folder for Git repositories, select local branches or linked worktrees, then delete them in one confirmed action. Herdr starts with safe delete and retries with force only when Git requires it.</p><label class="git-ui-branch-field"><span>Directory to scan</span><div class="git-ui-inline-field"><input id="gitUiCleanupRoot" value="${root}" placeholder="/path/to/projects" data-directory-picker-after-select="HerdrGitUi.scanCleanup"><button type="button" class="mini directory-picker-trigger" onclick="HerdrDirectoryPicker.openInput('gitUiCleanupRoot')">Browse</button><button class="git-ui-btn primary" onclick="HerdrGitUi.scanCleanup()" ${view.cleanupLoading ? "disabled" : ""}>Scan</button></div></label>${bulk}${view.cleanupError ? `<div class="git-ui-error">${esc(view.cleanupError)}</div>` : ""}${truncated}<div class="git-ui-list">${body}</div></div>`;
  }

  function renderCleanupRepo(repo, repoIndex) {
    const name = repo.path ? repo.path.split(/[\\/]+/).filter(Boolean).pop() || repo.path : "Repository";
    const repoItems = cleanupRepoItems(repoIndex);
    const repoState = cleanupSelectionState(repoItems);
    const title = `<label class="git-ui-cleanup-repo-title"><input type="checkbox" data-state="${repoState}" onchange="HerdrGitUi.toggleCleanupRepo('${repoIndex}',this.checked)" ${repoState === "checked" ? "checked" : ""} ${repoItems.length ? "" : "disabled"}><span>${treeIcon("folder")}</span><strong>${esc(name)}</strong><small title="${esc(repo.path || "")}">${esc(repo.path || "")}</small></label>`;
    if (repo.error) return `<section class="git-ui-cleanup-repo">${title}<div class="git-ui-error">${esc(repo.error)}</div></section>`;
    const branches = cleanupVisibleBranches(repo).map((branch) => renderCleanupBranch(repoIndex, branch)).join("") || `<div class="git-ui-empty-row git-ui-cleanup-empty">No removable local branches</div>`;
    const worktrees = (repo.worktrees || []).map((worktree, index) => worktree.primary ? "" : renderCleanupWorktree(repoIndex, index, worktree)).join("") || `<div class="git-ui-empty-row git-ui-cleanup-empty">No linked worktrees</div>`;
    return `<section class="git-ui-cleanup-repo">${title}<div class="git-ui-cleanup-group">${renderCleanupGroupTitle(repoIndex, "branch", "Branches")}${branches}</div><div class="git-ui-cleanup-group">${renderCleanupGroupTitle(repoIndex, "worktree", "Worktrees")}${worktrees}</div></section>`;
  }

  function cleanupVisibleBranches(repo) {
    return (repo.branches || []).filter((branch) => !branch.checked_out);
  }

  function renderCleanupGroupTitle(repoIndex, type, label) {
    const items = cleanupRepoItems(repoIndex, type);
    const state = cleanupSelectionState(items);
    return `<label class="git-ui-cleanup-group-title"><input type="checkbox" data-state="${state}" onchange="HerdrGitUi.toggleCleanupGroup('${repoIndex}','${type}',this.checked)" ${state === "checked" ? "checked" : ""} ${items.length ? "" : "disabled"}><span>${esc(label)}</span></label>`;
  }

  function renderCleanupBranch(repoIndex, branch) {
    const disabled = branch.current ? "disabled" : "";
    const key = cleanupItemKey("branch", repoIndex, branch.name);
    const checked = cleanupSelected(key) ? "checked" : "";
    const meta = [branch.current ? "current" : "", branch.checked_out ? "checked out" : ""].filter(Boolean).join(" · ");
    return `<label class="git-ui-cleanup-row"><input type="checkbox" onchange="HerdrGitUi.toggleCleanupSelection('${arg(key)}',this.checked)" ${checked} ${disabled}><span class="git-ui-cleanup-indent"></span><span><strong>${esc(branch.name)}</strong>${meta ? `<small>${esc(meta)}</small>` : ""}</span></label>`;
  }

  function renderCleanupWorktree(repoIndex, index, worktree) {
    const meta = [worktree.branch || (worktree.detached ? "detached" : ""), worktree.prunable ? "prunable" : "", worktree.primary ? "primary" : ""].filter(Boolean).join(" · ");
    const disabled = worktree.primary ? "disabled" : "";
    const key = cleanupItemKey("worktree", repoIndex, String(index));
    const checked = cleanupSelected(key) ? "checked" : "";
    return `<label class="git-ui-cleanup-row"><input type="checkbox" onchange="HerdrGitUi.toggleCleanupSelection('${arg(key)}',this.checked)" ${checked} ${disabled}><span class="git-ui-cleanup-indent"></span><span><strong>${esc(compactPath(worktree.path))}</strong>${meta ? `<small>${esc(meta)}</small>` : ""}</span></label>`;
  }

  function cleanupItemKey(type, repoIndex, id) {
    const repo = ((active() || {}).cleanupResult || {}).repos || [];
    const repoPath = repo[repoIndex] && repo[repoIndex].path || repoIndex;
    return `${type}|${repoPath}|${id}`;
  }

  function cleanupSelected(key) {
    const view = active() || {};
    return !!(view.cleanupSelected && view.cleanupSelected[key]);
  }

  function cleanupSelectionState(items) {
    if (!items || !items.length) return "unchecked";
    const selected = items.filter((item) => cleanupSelected(item.key)).length;
    if (selected === 0) return "unchecked";
    if (selected === items.length) return "checked";
    return "mixed";
  }

  function cleanupSelectableItems(view = active() || {}) {
    const items = [];
    for (const repo of (((view.cleanupResult || {}).repos) || [])) {
      if (repo.error) continue;
      for (const branch of cleanupVisibleBranches(repo)) {
        if (!branch.current) items.push({ type: "branch", repo: repo.path, name: branch.name, key: `branch|${repo.path}|${branch.name}` });
      }
      (repo.worktrees || []).forEach((worktree, index) => {
        if (!worktree.primary) items.push({ type: "worktree", repo: repo.path, path: worktree.path, key: `worktree|${repo.path}|${index}` });
      });
    }
    return items;
  }

  function cleanupRepoItems(repoIndex, type) {
    const view = active() || {};
    const repos = ((view.cleanupResult || {}).repos) || [];
    const repo = repos[Number(repoIndex)];
    if (!repo || repo.error) return [];
    const items = [];
    if (!type || type === "branch") {
      for (const branch of cleanupVisibleBranches(repo)) {
        if (!branch.current) items.push({ type: "branch", repo: repo.path, name: branch.name, key: `branch|${repo.path}|${branch.name}` });
      }
    }
    if (!type || type === "worktree") {
      (repo.worktrees || []).forEach((worktree, index) => {
        if (!worktree.primary) items.push({ type: "worktree", repo: repo.path, path: worktree.path, key: `worktree|${repo.path}|${index}` });
      });
    }
    return items;
  }

  function cleanupSelectedItems(view = active() || {}) {
    const selected = view.cleanupSelected || {};
    return cleanupSelectableItems(view).filter((item) => selected[item.key]);
  }

  function cleanupItemLabel(item) {
    return item.type === "branch" ? `${item.repo}:${item.name}` : `${item.repo}:${item.path}`;
  }

  async function deleteCleanupItem(item, force) {
    if (item.type === "branch") {
      return api("/api/git-ui/branch-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: item.repo, branch: item.name, force, confirmed: true }),
      });
    }
    return api("/api/git-ui/worktree-remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: item.repo, path: item.path, force, confirmed: true }),
    });
  }

  function cleanupForceRetryLikelyNeeded(err) {
    const text = String((err && err.message) || err || "").toLowerCase();
    return [
      "not fully merged",
      "is not fully merged",
      "contains modified or untracked files",
      "contains modified files",
      "contains untracked files",
      "use --force",
      "use -d to delete it anyway",
      "use -d to force",
      "remove untracked or ignored files",
    ].some((needle) => text.includes(needle));
  }

  async function renderHistory() {
    const view = active();
    if (!view.file) return `${renderFileToolbar("history")}<div class="git-ui-muted">Select file first.</div>`;
    const data = await api(`/api/git-ui/file-history?cwd=${encodeURIComponent(view.cwd)}&file=${encodeURIComponent(view.file)}`);
    return `${renderFileToolbar("history")}<div class="git-ui-list">${(data.commits || []).map((c) => `<div class="git-ui-file"><span><strong>${esc(c.hash)}</strong> ${esc(c.message)}</span><span class="git-ui-file-meta"><span class="git-ui-muted">${esc(c.author)} ${esc(c.date)}</span><button class="git-ui-file-action" onclick="event.stopPropagation();HerdrGitUi.showHistoryCommit('${arg(c.hash)}')">committed file</button><button class="git-ui-file-action" onclick="event.stopPropagation();HerdrGitUi.gotoLogCommit('${arg(c.hash)}')">log</button></span></div>`).join("") || `<div class="git-ui-empty-row">No history for selected file</div>`}</div>`;
  }

  function renderConflictOperationActions() {
    const action = (label, name, danger = false) =>
      `<button class="git-ui-btn ${danger ? "danger" : ""}" onclick="HerdrGitUi.conflictAction('${name}')">${label}</button>`;
    return `<div class="git-ui-actions git-ui-conflict-actions" aria-label="Conflict operation actions"><div class="git-ui-action-group"><span class="git-ui-action-label">Rebase</span>${action("Continue", "rebase-continue")}${action("Skip", "rebase-skip")}${action("Abort", "rebase-abort", true)}</div><div class="git-ui-action-group"><span class="git-ui-action-label">Merge</span>${action("Continue", "merge-continue")}${action("Abort", "merge-abort", true)}</div><div class="git-ui-action-group"><span class="git-ui-action-label">Cherry-pick</span>${action("Continue", "cherry-pick-continue")}${action("Abort", "cherry-pick-abort", true)}</div></div>`;
  }

  function renderConflicts() {
    const files = (((active() || {}).status || {}).conflicted || []);
    const operationActions = renderConflictOperationActions();
    const help = files.length ? `<div class="git-ui-muted git-ui-conflict-help">After editing a conflicted file manually, click <strong>Mark resolved (stage)</strong> to run git add. When all conflicted files are staged, continue the rebase, merge, or cherry-pick.</div>` : "";
    return `${renderFileToolbar("conflicts")}<div class="git-ui-section"><div class="git-ui-muted">Conflicts</div>${files.length ? operationActions : ""}${help}${files.map((file) => `<div class="git-ui-file git-ui-conflict-file"><span>${esc(file)}</span><span class="git-ui-conflict-file-actions"><button class="git-ui-btn" title="Use HEAD/current side" onclick="HerdrGitUi.resolve('${arg(file)}','ours')">Use HEAD</button><button class="git-ui-btn" title="Use parent/base version" onclick="HerdrGitUi.resolve('${arg(file)}','base')">Use parent</button><button class="git-ui-btn" title="Use remote/incoming side" onclick="HerdrGitUi.resolve('${arg(file)}','theirs')">Use remote</button><button class="git-ui-btn" title="Stage this manually edited file as resolved" onclick="HerdrGitUi.resolve('${arg(file)}','mark')">Mark resolved (stage)</button></span></div>`).join("") || `<div class="git-ui-empty-row">No conflicts</div>`}</div>`;
  }

  function renderMain() {
    const view = active() || {};
    if (view.loading) return `<main class="git-ui-main"><div class="git-ui-loading"><span></span><strong>Loading Git state</strong></div></main>`;
    if (isNoGitRepositoryView(view)) return `<main class="git-ui-main"><div class="git-ui-content">${renderCleanup()}</div></main>`;
    let body = "";
    if (view.tab === "changes") body = renderDiff();
    if (view.tab === "conflicts") body = renderConflicts();
    if (view.tab === "log") body = `<div class="git-ui-muted">Loading log...</div>`;
    if (view.tab === "stash") body = `<div class="git-ui-muted">Loading stashes...</div>`;
    if (view.tab === "cleanup") body = renderCleanup();
    if (view.tab === "history") body = `<div class="git-ui-muted">Loading history...</div>`;
    return `<main class="git-ui-main"><div class="git-ui-content">${body}</div></main>`;
  }

  function preserveContentScroll(tab) {
    return tab === "cleanup" || tab === "log";
  }

  function setupDiffHunkScrollbars(root) {
    const scope = root || document;
    scope.querySelectorAll(".git-ui-hunk").forEach((hunk) => {
      const scroll = hunk.querySelector(".git-ui-hunk-xscroll");
      const inner = scroll && scroll.querySelector(".git-ui-hunk-xscroll-inner");
      if (!scroll || !inner) return;
      const codeCells = Array.from(hunk.querySelectorAll(".git-ui-code, .git-ui-unified-text"));
      const maxScroll = codeCells.reduce((max, cell) => Math.max(max, Math.max(0, cell.scrollWidth - cell.clientWidth)), 0);
      scroll.classList.toggle("no-scroll", maxScroll < 2);
      inner.style.width = `${Math.max(scroll.clientWidth + maxScroll, scroll.clientWidth)}px`;
      const apply = () => hunk.style.setProperty("--git-ui-hunk-scroll-left", `${scroll.scrollLeft}px`);
      scroll.addEventListener("scroll", apply, { passive: true });
      codeCells.forEach((cell) => {
        cell.addEventListener("wheel", (event) => {
          if (!event.deltaX || Math.abs(event.deltaX) < Math.abs(event.deltaY)) return;
          if (maxScroll < 2) return;
          event.preventDefault();
          scroll.scrollLeft += event.deltaX;
        }, { passive: false });
      });
      apply();
    });
  }

  function render() {
    if (!state.visible) return;
    saveSideEditorFromDom();
    const activeView = active() || {};
    const currentContent = document.querySelector(".git-ui-content");
    if (currentContent && preserveContentScroll(activeView.tab))
      activeView.contentScrollTop = currentContent.scrollTop;
    const version = ++state.renderVersion;
    const panel = ensurePanel();
    panel.classList.toggle("mutating", !!activeView.mutating);
    panel.innerHTML = renderSide() + renderMain() + renderContextMenu() + renderCommitModal() + renderCompareSelectedModal() + renderResetSelectedModal() + renderTagSelectedModal() + renderBranchModal() + renderGitOpModal() + renderCleanupConfirm() + renderGitToast();
    const side = panel.querySelector(".git-ui-side");
    if (side) side.scrollTop = state.sideScrollTop || 0;
    const nextContent = panel.querySelector(".git-ui-content");
    if (nextContent && preserveContentScroll(activeView.tab))
      nextContent.scrollTop = activeView.contentScrollTop || 0;
    setupDiffHunkScrollbars(panel);
    mountSideEditors();
    focusDiffSearchIfNeeded();
    const view = activeView;
    if (view.tab === "log") renderLog(version).catch((e) => { view.error = e.message; render(); });
    if (view.tab === "stash") renderStash(version).catch((e) => { view.error = e.message; render(); });
    if (view.tab === "history") renderHistory().then((html) => replaceContent(version, html)).catch((e) => { view.error = e.message; render(); });
  }

  function replaceContent(version, html) {
    if (!state.visible || version !== state.renderVersion) return;
    const content = document.querySelector(".git-ui-content");
    if (!content) return;
    const view = active() || {};
    const scrollTop = preserveContentScroll(view.tab) ? (view.contentScrollTop || content.scrollTop || 0) : null;
    content.innerHTML = html;
    if (scrollTop !== null) content.scrollTop = scrollTop;
  }

  function focusDiffSearchIfNeeded() {
    if (!state.focusDiffSearch) return;
    state.focusDiffSearch = false;
    setTimeout(() => {
      const input = document.getElementById("gitUiDiffSearch");
      if (!input) return;
      input.focus();
      if (input.setSelectionRange) input.setSelectionRange(input.value.length, input.value.length);
    }, 0);
  }

  function setupSideEditorMountUi(root) {
    const scope = root || document;
    scope.querySelectorAll(".git-ui-hunk-editor").forEach((editor) => {
      // Sync horizontal scroll between previous/current CodeMirror scrollers.
      const scrollers = Array.from(editor.querySelectorAll(".git-ui-hunk-edit-mount .cm-scroller"));
      if (scrollers.length >= 2) {
        const sync = (source) => {
          if (source._gitUiSyncingSideEditorScroll) return;
          for (const scroller of scrollers) {
            if (scroller === source) continue;
            if (scroller.scrollLeft === source.scrollLeft) continue;
            scroller._gitUiSyncingSideEditorScroll = true;
            scroller.scrollLeft = source.scrollLeft;
            requestAnimationFrame(() => { scroller._gitUiSyncingSideEditorScroll = false; });
          }
        };
        scrollers.forEach((scroller) => {
          scroller.addEventListener("scroll", () => sync(scroller), { passive: true });
          scroller.addEventListener("wheel", (event) => {
            if (!event.deltaX || Math.abs(event.deltaX) < Math.abs(event.deltaY)) return;
            const next = scroller.scrollLeft + event.deltaX;
            if (next === scroller.scrollLeft) return;
            event.preventDefault();
            scroller.scrollLeft = next;
            sync(scroller);
          }, { passive: false });
        });
        sync(scrollers[0]);
      }
    });
  }

  function mountSideEditors() {
    const view = active() || {};
    if (!window.HerdrEditor || !view.sideEditor) return;
    const mounts = Array.from(document.querySelectorAll(".git-ui-hunk-edit-mount[data-hunk-index]"));
    const mountAll = () => {
      mounts.forEach((mount) => {
        const index = Number(mount.dataset.hunkIndex || 0);
        const side = mount.dataset.editorSide || "current";
        const sourceClass = side === "old" ? "git-ui-hunk-old-hidden" : "git-ui-hunk-current-hidden";
        const textarea = document.querySelector(`.${sourceClass}[data-hunk-index="${index}"]`);
        if (!textarea) return;
        const hunk = ((view.sideEditor || {}).hunks || [])[index] || {};
        const baseContent = textarea.value;
        window.HerdrEditor.create({
          parent: mount,
          path: view.file || view.sideEditor.path || "",
          content: textarea.value,
          readonly: mount.dataset.readonly === "true",
          hideFind: true,
          lineClasses: sideEditorOriginalLineClasses(hunk, side),
          dynamicLineClasses: side === "current" ? function (value) { return changedLineClasses(baseContent, value); } : null,
          onChange: side === "old" ? null : function (value) { textarea.value = value; },
        });
      });
      requestAnimationFrame(() => setupSideEditorMountUi(document));
    };
    if (!window.HerdrCodeMirror && window.HerdrEditor.ensureCodeMirror) {
      window.HerdrEditor.ensureCodeMirror().then(() => mountAll()).catch(() => mountAll());
      return;
    }
    mountAll();
  }

  function draftKey(view) {
    view = view || active() || {};
    return `herdr-web-git-commit-draft:${state.activeKey}:${view.cwd || ""}:${((view.status || {}).branch) || "HEAD"}`;
  }

  function saveDraftFromDom() {
    const title = document.getElementById("gitCommitTitle");
    const body = document.getElementById("gitCommitBody");
    if (!title || !state.activeKey) return;
    let existing = {};
    try { existing = JSON.parse(localStorage.getItem(draftKey()) || "{}"); } catch (_) {}
    try {
      localStorage.setItem(draftKey(), JSON.stringify({ title: title.value, body: body ? body.value : (existing.body || ""), updated_at: Date.now() }));
    } catch (_) {}
  }

  function sideEditorContent(editor) {
    if (!editor) return "";
    const lines = String(editor.content || "").split("\n");
    const edits = Array.from(document.querySelectorAll(".git-ui-hunk-edit[data-hunk-index]")).map((node) => {
      const index = Number(node.dataset.hunkIndex || 0);
      const hunk = (editor.hunks || [])[index];
      return hunk ? Object.assign({}, hunk, { text: node.value }) : null;
    }).filter(Boolean).sort((a, b) => b.newStart - a.newStart);
    for (const hunk of edits) {
      if (!hunk.newStart) continue;
      const replacement = String(hunk.text || "").split("\n");
      lines.splice(hunk.newStart - 1, hunk.newEnd - hunk.newStart + 1, ...replacement);
    }
    return lines.join("\n");
  }

  function saveSideEditorFromDom() {
    const view = active();
    const editor = view && view.sideEditor;
    if (!editor || editor.loading) return;
    document.querySelectorAll(".git-ui-hunk-edit[data-hunk-index]").forEach((node) => {
      const index = Number(node.dataset.hunkIndex || 0);
      if (editor.hunks && editor.hunks[index]) editor.hunks[index].text = node.value;
    });
  }

  function selectedPaths() {
    const view = active() || {};
    return view.file ? [view.file] : allFiles();
  }

  function diffFile(path) {
    const view = active() || {};
    return ((view.diff && view.diff.files) || []).find((file) => file.path === path);
  }

  function loadSelectedCommitPreview(view, hash) {
    if (!view || !hash) return;
    const current = view.selectedCommitPreview || {};
    if (current.hash === hash && (current.loading || current.diff || current.error)) return;
    view.selectedCommitPreview = { hash, loading: true, error: "", diff: null };
    const context = 0;
    api(`/api/git-ui/compare?cwd=${encodeURIComponent(view.cwd)}&base=${encodeURIComponent(`${hash}^`)}&target=${encodeURIComponent(hash)}&context=${context}`)
      .then((diff) => {
        if (!view.selectedCommitPreview || view.selectedCommitPreview.hash !== hash) return;
        view.selectedCommitPreview = { hash, loading: false, error: "", diff };
        if (state.visible) render();
      })
      .catch((err) => {
        if (!view.selectedCommitPreview || view.selectedCommitPreview.hash !== hash) return;
        view.selectedCommitPreview = { hash, loading: false, error: err.message || String(err), diff: null };
        if (state.visible) render();
      });
  }

  function hunkPatch(path, index) {
    const file = diffFile(path);
    if (!file || !file.chunks || !file.chunks[index]) return "";
    const chunk = file.chunks[index];
    const oldPath = file.old_path || file.path;
    const lines = [];
    lines.push(`diff --git a/${oldPath} b/${file.path}`);
    lines.push(`--- a/${oldPath}`);
    lines.push(`+++ b/${file.path}`);
    lines.push(chunk.header);
    for (const line of chunk.lines || []) {
      const prefix = line.line_type === "add" ? "+" : line.line_type === "delete" ? "-" : " ";
      lines.push(prefix + (line.content || ""));
    }
    return lines.join("\n") + "\n";
  }

  async function applyHunk(path, index, options) {
    const patch = hunkPatch(path, index);
    if (!patch) return;
    await post("/api/git-ui/apply-patch", Object.assign({ cwd: active().cwd, patch }, options || {}), options && options.reverse ? "Restoring hunk" : "Applying hunk");
  }

  window.HerdrGitUi = {
    open,
    hide,
    close,
    forgetWorkspace(workspace) {
      const key = typeof workspace === "string" ? workspace : workspaceKey(workspace);
      if (!key) return;
      if (state.activeKey === key) {
        close();
        return;
      }
      delete state.cache[key];
    },
    refresh,
    refreshWithSpin() {
      const view = active();
      if (!view) return;
      view.refreshAnimating = true;
      render();
      setTimeout(() => {
        const latest = active();
        if (latest) latest.refreshAnimating = false;
        if (state.visible) render();
      }, 2000);
      refresh();
    },
    refreshVisible() { if (state.visible) render(); },
    isVisible() { return state.visible; },
    activeWorkspaceId() { return state.visible ? (state.activeKey || "") : ""; },
    isWorkspaceVisible(key) { return state.visible && state.activeKey === key; },
    workspaceStatus,
    statusLabel() { return state.open ? (state.visible ? "open" : "hidden") : "closed"; },
    tab(tab) {
      if (!["changes", "log", "stash", "cleanup", "conflicts", "history"].includes(tab)) return;
      const view = active();
      if (isNoGitRepositoryView(view) && tab !== "cleanup") return;
      if (tab === "stash" && !canOpenStashView(view)) return;
      if (tab === "changes") {
        this.showChangesList();
        return;
      }
      active().tab = tab;
      render();
    },
    showChangesList() {
      const view = active();
      if (!view) return;
      if (isNoGitRepositoryView(view)) {
        view.tab = "cleanup";
        render();
        return;
      }
      resetToChangesMode(view, { clearSource: true, clearBackTarget: true });
      view.navigationStack = [];
      view.sideEditor = null;
      view.file = "";
      view.diffKind = "";
      view.diffScope = "all";
      view.tab = "changes";
      loadDiff().catch((e) => { view.error = e.message; render(); });
    },
    selectFile(file, kind) {
      const view = active();
      const path = decodeURIComponent(file);
      view.file = path;
      view.diffKind = kind || "";
      view.expandedCompactDirs = {};
      if (view.sideEditor && view.sideEditor.path !== path) view.sideEditor = null;
      if (kind === "C" && view.selectedCommitPreview && view.selectedCommitPreview.hash) {
        const hash = view.selectedCommitPreview.hash;
        if (!(view.fileBackTarget && view.fileBackTarget.type === "log")) pushNavigationSnapshot(view);
        view.mode = "readonly-compare";
        view.compareBase = `${hash}^`;
        view.compareTarget = hash;
        view.historyCommitHash = hash;
        view.fileBackTarget = { type: "log", hash };
        view.compareFilePaths = ((view.selectedCommitPreview.diff && view.selectedCommitPreview.diff.files) || []).map((file) => file.path);
        view.tab = "changes";
        loadDiff().then(() => requestAnimationFrame(() => scrollToDiffFile(view.file))).catch((e) => { view.error = e.message; render(); });
        return;
      }
      if (currentMode() !== "changes") {
        loadDiff().then(() => requestAnimationFrame(() => scrollToDiffFile(view.file))).catch((e) => { view.error = e.message; render(); });
        return;
      }
      view.diffScope = kind === "S" ? "staged" : kind === "M" || kind === "?" ? "working" : "all";
      loadDiff().then(() => requestAnimationFrame(() => scrollToDiffFile(view.file))).catch((e) => { view.error = e.message; render(); });
    },
    loadLargeDiff(file, kind) {
      const view = active();
      if (!view) return;
      const path = decodeURIComponent(file);
      if (path === "__all__") {
        view.loadLargeChangeSet = true;
        view.loading = true;
        render();
        loadDiff()
          .catch((e) => { view.error = e.message; })
          .finally(() => { view.loading = false; render(); });
        return;
      }
      if (view.diff && view.diff.skipped_large_change_set) {
        const diffKind = kind ? decodeURIComponent(kind) : "";
        const scope = diffKind === "S" ? "staged" : diffKind === "M" || diffKind === "?" ? "working" : "all";
        const context = Math.max(0, Math.min(200, Number(view.diffContext || 3)));
        api(`/api/git-ui/diff?cwd=${encodeURIComponent(view.cwd)}&scope=${encodeURIComponent(scope)}&context=${context}&file=${encodeURIComponent(path)}`)
          .then((data) => {
            const nextFiles = ((data && data.files) || []).map((diffFile) => Object.assign({}, diffFile, { diff_kind: diffKind }));
            const existing = (view.diff.files || []).filter((diffFile) => !(diffFile.path === path && (!diffKind || diffFile.diff_kind === diffKind)));
            view.diff.files = existing.concat(nextFiles);
            view.loadedLargeDiffFiles = Object.assign({}, view.loadedLargeDiffFiles || {}, { [path]: true });
          })
          .catch((e) => { view.error = e.message || String(e); })
          .finally(() => render());
        return;
      }
      view.loadedLargeDiffFiles = Object.assign({}, view.loadedLargeDiffFiles || {}, { [path]: true });
      render();
    },
    renderFullLargeDiff(file, kind) {
      const view = active();
      if (!view) return;
      const path = decodeURIComponent(file);
      const diffKind = kind ? decodeURIComponent(kind) : "";
      view.fullLargeDiffFiles = Object.assign({}, view.fullLargeDiffFiles || {}, { [diffFileKey(path, diffKind)]: true });
      render();
    },
    activateTreeItem(event) {
      if (!event || !["Enter", " ", "Spacebar"].includes(event.key)) return;
      event.preventDefault();
      event.currentTarget.click();
    },
    fileMenu(event, file, kind) {
      event.preventDefault();
      event.stopPropagation();
      state.contextMenu = { x: event.clientX, y: event.clientY, file: decodeURIComponent(file), kind };
      render();
      return false;
    },
    async menuAction(action) {
      const menu = state.contextMenu;
      if (!menu) return;
      state.contextMenu = null;
      if (action === "copyPermalink") {
        try {
          await copyGitPermalink(menu.file);
        } catch (err) {
          const view = active();
          if (view) view.error = err.message || String(err);
          render();
        }
        return;
      }
      if (action === "stash") this.stashFile(encodeURIComponent(menu.file));
      if (action === "discard") this.discardFile(encodeURIComponent(menu.file));
      if (action === "stage") this.stageFile(encodeURIComponent(menu.file));
      if (action === "unstage") this.unstageFile(encodeURIComponent(menu.file));
    },
    async copyCommitId(hash) {
      try {
        await copyCommitId(decodeURIComponent(hash || ""));
      } catch (err) {
        const view = active();
        if (view) view.error = err.message || String(err);
        render();
      }
    },
    toggleStageAll() {
      const view = active();
      const status = (view && view.status) || {};
      const staged = status.staged || [];
      if (staged.length) {
        post("/api/git-ui/unstage", { cwd: view.cwd, paths: staged }, "Unstaging all");
        return;
      }
      const paths = [...(status.unstaged || []), ...(status.untracked || [])];
      if (!paths.length) return;
      post("/api/git-ui/stage", { cwd: view.cwd, paths }, "Staging all");
    },
    bulkSectionAction(action, title) {
      const view = active();
      if (!view) return;
      const status = view.status || {};
      title = decodeURIComponent(title);
      const paths = title === "Staged"
        ? status.staged || []
        : title === "Unstaged"
          ? status.unstaged || []
          : title === "Untracked"
            ? status.untracked || []
            : [];
      if (!paths.length) return;
      const verb = action === "unstage" ? "Unstage" : "Stage";
      if (!confirm(`${verb} ${paths.length} ${title.toLowerCase()} file${paths.length === 1 ? "" : "s"}?`)) return;
      setTimeout(() => {
        post(action === "unstage" ? "/api/git-ui/unstage" : "/api/git-ui/stage", { cwd: view.cwd, paths }, action === "unstage" ? "Unstaging files" : "Staging files");
      }, 0);
    },
    stageFile(path) { post("/api/git-ui/stage", { cwd: active().cwd, paths: [decodeURIComponent(path)] }, "Staging file"); },
    unstageFile(path) { post("/api/git-ui/unstage", { cwd: active().cwd, paths: [decodeURIComponent(path)] }, "Unstaging file"); },
    restoreFile(path) { if (confirm("Restore this file change?")) post("/api/git-ui/discard", { cwd: active().cwd, paths: [decodeURIComponent(path)], confirmed: true }, "Restoring file"); },
    restoreHunk(path, index) {
      path = decodeURIComponent(path);
      const view = active() || {};
      const staged = (view.diffScope || "all") === "staged";
      if (confirm(staged ? "Restore this staged hunk? This discards it from the index." : "Restore this hunk?")) applyHunk(path, index, staged ? { reverse: true, cached: true } : { reverse: true });
    },
    discardFile(path) { path = decodeURIComponent(path); if (confirm(`Restore complete file ${path}? This discards staged and unstaged changes.`)) post("/api/git-ui/discard", { cwd: active().cwd, paths: [path], confirmed: true }, "Restoring file"); },
    toggleBlame() { const view = active(); if (!view) return; view.showBlame = !view.showBlame; render(); },
    toggleDiffLayout() {
      setGitUiOption("gitUiDiffLayout", diffLayoutMode() === "unified" ? "side-by-side" : "unified");
      render();
    },
    setDiffLayout(layout) {
      setGitUiOption("gitUiDiffLayout", layout === "unified" ? "unified" : "side-by-side");
      render();
    },
    async editSideBySide() {
      const view = active();
      if (!canEditCurrentFile(view)) return;
      const file = diffFile(view.file);
      const previousRef = "HEAD";
      view.sideEditor = { path: view.file, content: "", hunks: [], previousRef, hash: "", loading: true, saving: false, error: "" };
      render();
      try {
        const current = await api(`/api/git-ui/file?cwd=${encodeURIComponent(view.cwd)}&file=${encodeURIComponent(view.file)}&ref_name=working`);
        view.sideEditor = {
          path: current.path || view.file,
          content: current.content || "",
          hunks: buildEditableHunks(file),
          previousRef,
          hash: current.hash || "",
          loading: false,
          saving: false,
          error: "",
        };
      } catch (err) {
        view.sideEditor = { path: view.file, content: "", hunks: [], previousRef, hash: "", loading: false, saving: false, error: err.message || String(err) };
      }
      render();
    },
    cancelSideEditor() {
      const view = active();
      if (!view) return;
      view.sideEditor = null;
      render();
    },
    async saveSideEditor() {
      const view = active();
      const editor = view && view.sideEditor;
      if (!view || !editor || editor.loading || editor.saving) return;
      saveSideEditorFromDom();
      editor.saving = true;
      editor.error = "";
      render();
      try {
        await api("/api/git-ui/file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: view.cwd, path: editor.path || view.file, content: sideEditorContent(editor), expected_hash: editor.hash || "" }),
        });
        view.sideEditor = null;
        await refresh();
      } catch (err) {
        editor.saving = false;
        editor.error = err.message || String(err);
        render();
      }
    },
    toggleFile(path) {
      const view = active();
      if (!view) return;
      path = decodeURIComponent(path);
      view.collapsedFiles = view.collapsedFiles || {};
      view.collapsedFiles[path] = !view.collapsedFiles[path];
      render();
    },
    toggleDir(path) {
      const view = active();
      if (!view) return;
      path = decodeURIComponent(path);
      view.collapsedDirs = view.collapsedDirs || {};
      view.collapsedDirs[path] = !view.collapsedDirs[path];
      render();
    },
    expandCompactDir(path) {
      const view = active();
      if (!view) return;
      path = decodeURIComponent(path);
      view.expandedCompactDirs = view.expandedCompactDirs || {};
      let current = "";
      for (const part of path.split("/").filter(Boolean)) {
        current = current ? `${current}/${part}` : part;
        view.expandedCompactDirs[current] = true;
      }
      render();
    },
    toggleSection(title) {
      const view = active();
      if (!view) return;
      title = decodeURIComponent(title);
      view.collapsedSections = view.collapsedSections || {};
      view.collapsedSections[title] = !view.collapsedSections[title];
      render();
    },
    expandLargeSection(title) {
      const view = active();
      if (!view) return;
      title = decodeURIComponent(title);
      view.expandedLargeSections = view.expandedLargeSections || {};
      view.expandedLargeSections[title] = true;
      render();
    },
    collapseAllFiles() {
      const view = active();
      if (!view) return;
      view.collapsedFiles = {};
      for (const file of ((view.diff && view.diff.files) || [])) view.collapsedFiles[file.path] = true;
      render();
    },
    expandAllFiles() {
      const view = active();
      if (!view) return;
      view.collapsedFiles = {};
      render();
    },
    expandContext() {
      const view = active();
      if (!view) return;
      const current = Math.max(0, Number(view.diffContext || 3));
      view.diffContext = window.HerdrLineContext && window.HerdrLineContext.nextContextSize
        ? window.HerdrLineContext.nextContextSize(current, { min: 3, max: 200 })
        : Math.min(200, current < 3 ? 3 : current * 2);
      loadDiff();
    },
    unstageHunk(path, index) { path = decodeURIComponent(path); applyHunk(path, index, { reverse: true, cached: true }); },
    stageHunk(path, index) { path = decodeURIComponent(path); applyHunk(path, index, { cached: true }); },
    discardSelected() { if (confirm("Discard selected working tree changes?")) post("/api/git-ui/discard", { cwd: active().cwd, paths: selectedPaths(), confirmed: true }, "Discarding changes"); },
    stash() { const message = prompt("Stash message", "herdr-webui stash"); if (message !== null) post("/api/git-ui/stash", { cwd: active().cwd, message }, "Stashing"); },
    stashFile(path) {
      path = decodeURIComponent(path);
      if (!confirm(`Stash complete file ${path}?`)) return;
      const message = prompt(`Stash message for ${path}`, `herdr-webui stash ${path}`);
      if (message !== null) post("/api/git-ui/stash", { cwd: active().cwd, message, paths: [path] }, "Stashing file");
    },
    applyStash(stash, pop) { post("/api/git-ui/stash-apply", { cwd: active().cwd, stash: decodeURIComponent(stash), pop }, pop ? "Popping stash" : "Applying stash"); },
    dropStash(stash) { stash = decodeURIComponent(stash); if (confirm(`Drop ${stash}?`)) post("/api/git-ui/stash-drop", { cwd: active().cwd, stash, confirmed: true }, "Dropping stash"); },
    async scanCleanup() {
      const view = active();
      if (!view) return;
      const input = document.getElementById("gitUiCleanupRoot");
      const root = (input && input.value.trim()) || view.cleanupRoot || view.cwd;
      if (!root) return;
      view.cleanupRoot = root;
      view.cleanupLoading = true;
      view.cleanupError = "";
      render();
      try {
        view.cleanupResult = await api(`/api/git-ui/cleanup-scan?root=${encodeURIComponent(root)}`);
        view.cleanupSelected = {};
      } catch (err) {
        view.cleanupError = err.message || String(err);
      } finally {
        view.cleanupLoading = false;
        render();
      }
    },
    sideScroll(node) {
      state.sideScrollTop = node.scrollTop;
    },
    filterFiles(value) {
      const view = active();
      if (!view) return;
      const side = document.querySelector(".git-ui-side");
      state.sideScrollTop = side ? side.scrollTop : state.sideScrollTop;
      clearTimeout(view.fileFilterTimer);
      view.fileFilterTimer = setTimeout(() => {
        view.fileFilter = String(value || "");
        render();
      }, 300);
    },
    openDiffSearch() {
      const view = active();
      if (!canSearchDiff(view)) return;
      view.diffSearchOpen = true;
      state.focusDiffSearch = true;
      render();
    },
    setDiffSearch(value) {
      const view = active();
      if (!view) return;
      view.diffSearchOpen = true;
      view.diffSearchQuery = String(value || "");
      state.focusDiffSearch = true;
      render();
    },
    clearDiffSearch() {
      const view = active();
      if (!view) return;
      view.diffSearchOpen = false;
      view.diffSearchQuery = "";
      render();
    },
    toggleCleanupSelection(key, checked) {
      const view = active();
      if (!view) return;
      key = decodeURIComponent(key);
      view.cleanupSelected = Object.assign({}, view.cleanupSelected || {});
      if (checked) view.cleanupSelected[key] = true;
      else delete view.cleanupSelected[key];
      render();
    },
    toggleCleanupGroup(repoIndex, type, checked) {
      const view = active();
      if (!view) return;
      view.cleanupSelected = Object.assign({}, view.cleanupSelected || {});
      for (const item of cleanupRepoItems(repoIndex, type)) {
        if (checked) view.cleanupSelected[item.key] = true;
        else delete view.cleanupSelected[item.key];
      }
      render();
    },
    toggleCleanupRepo(repoIndex, checked) {
      const view = active();
      if (!view) return;
      view.cleanupSelected = Object.assign({}, view.cleanupSelected || {});
      for (const item of cleanupRepoItems(repoIndex)) {
        if (checked) view.cleanupSelected[item.key] = true;
        else delete view.cleanupSelected[item.key];
      }
      render();
    },
    selectAllCleanup() {
      const view = active();
      if (!view) return;
      view.cleanupSelected = {};
      for (const item of cleanupSelectableItems(view)) view.cleanupSelected[item.key] = true;
      render();
    },
    clearCleanupSelection() {
      const view = active();
      if (!view) return;
      view.cleanupSelected = {};
      render();
    },
    openCleanupDeleteConfirm() {
      const items = cleanupSelectedItems();
      if (!items.length) return;
      state.cleanupConfirm = { items };
      render();
    },
    cancelCleanupDelete() {
      state.cleanupConfirm = null;
      render();
    },
    async confirmCleanupDelete() {
      const view = active();
      const modal = state.cleanupConfirm;
      const items = (modal && modal.items) || [];
      if (!view || !items.length) return;
      state.cleanupConfirm = null;
      view.cleanupLoading = true;
      view.cleanupError = "";
      render();
      const failures = [];
      for (const item of items) {
        try {
          await deleteCleanupItem(item, false);
        } catch (err) {
          if (!cleanupForceRetryLikelyNeeded(err)) {
            failures.push(`${cleanupItemLabel(item)}: ${(err && err.message) || err}`);
            continue;
          }
          try {
            await deleteCleanupItem(item, true);
          } catch (forceErr) {
            failures.push(`${cleanupItemLabel(item)}: ${(forceErr && forceErr.message) || forceErr || err}`);
          }
        }
      }
      view.cleanupLoading = false;
      if (failures.length) view.cleanupError = failures.join("\n");
      await this.scanCleanup();
      if (failures.length) {
        const latest = active();
        if (latest) latest.cleanupError = failures.join("\n");
      }
      render();
    },
    async deleteCleanupBranch(repoIndex, branch, force) {
      const view = active();
      const repo = view && view.cleanupResult && (view.cleanupResult.repos || [])[repoIndex];
      branch = decodeURIComponent(branch);
      if (!repo || !branch) return;
      const label = force ? "force delete" : "delete";
      if (!confirm(`${label} branch ${branch} in ${repo.path}?`)) return;
      view.cleanupLoading = true;
      view.cleanupError = "";
      render();
      try {
        await api("/api/git-ui/branch-delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo.path, branch, force, confirmed: true }) });
        await this.scanCleanup();
      } catch (err) {
        view.cleanupError = err.message || String(err);
        render();
      } finally {
        const latest = active();
        if (latest) latest.cleanupLoading = false;
        render();
      }
    },
    async deleteCleanupWorktree(repoIndex, worktreeIndex, force) {
      const view = active();
      const repo = view && view.cleanupResult && (view.cleanupResult.repos || [])[repoIndex];
      const worktree = repo && (repo.worktrees || [])[worktreeIndex];
      if (!repo || !worktree || !worktree.path) return;
      const label = force ? "force remove" : "remove";
      if (!confirm(`${label} worktree ${worktree.path}?`)) return;
      view.cleanupLoading = true;
      view.cleanupError = "";
      render();
      try {
        await api("/api/git-ui/worktree-remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo.path, path: worktree.path, force, confirmed: true }) });
        await this.scanCleanup();
      } catch (err) {
        view.cleanupError = err.message || String(err);
        render();
      } finally {
        const latest = active();
        if (latest) latest.cleanupLoading = false;
        render();
      }
    },
    saveDraft() {
      saveDraftFromDom();
    },
    openCommitModal() {
      const view = active();
      if (!view) return;
      if (!hasStagedChanges(view)) {
        view.error = "Stage changes before committing.";
        render();
        return;
      }
      state.commitModal = { includeBody: false };
      render();
    },
    closeCommitModal() { saveDraftFromDom(); state.commitModal = null; render(); },
    closeGitToast() { state.gitToast = null; render(); },
    openGitUrl(url) { const decoded = decodeURIComponent(url || ""); if (decoded) window.open(decoded, "_blank", "noopener"); },
    toggleCommitBody(value) { saveDraftFromDom(); state.commitModal = Object.assign({}, state.commitModal || {}, { includeBody: !!value }); render(); },
    commitPayload(amend) {
      const view = active();
      const includeBody = !!((document.getElementById("gitCommitIncludeBody") || {}).checked);
      return {
        cwd: view.cwd,
        title: (document.getElementById("gitCommitTitle") || {}).value || "",
        body: includeBody ? ((document.getElementById("gitCommitBody") || {}).value || "") : "",
        amend: !!amend,
      };
    },
    async commitFromModal(pushAfter) {
      const view = active();
      if (!view) return;
      const amend = !!((document.getElementById("gitCommitAmend") || {}).checked);
      const payload = this.commitPayload(amend);
      saveDraftFromDom();
      state.commitModal = null;
      try {
        await postJson("/api/git-ui/commit", payload, "Committing");
        if (!pushAfter) {
          showCommitToast("Commit created");
          return;
        }
        await postJson("/api/git-ui/push", { cwd: view.cwd, mode: "regular", push_tags: false }, "Pushing");
        showCommitToast("Commit pushed");
      } catch (err) {
        if (pushAfter) state.gitOpModal = { type: "force-push", error: err.message || String(err) };
        render();
      }
    },
    commit(amend) { this.commitFromModal(false); },
    commitAndPush() { this.commitFromModal(true); },
    async openGitOpModal(type) {
      const view = active();
      if (!view) return;
      state.gitOpModal = { type, error: "", branches: [], loading: true };
      render();
      try {
        const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(view.cwd)}`);
        const branches = [...(data.local || []), ...(data.remote || [])].map((branch) => ({ name: branch.remote ? localNameForRemote(branch.name) : branch.name }));
        if (state.gitOpModal && state.gitOpModal.type === type) state.gitOpModal = { type, error: "", branches, loading: false };
      } catch (err) {
        if (state.gitOpModal && state.gitOpModal.type === type) state.gitOpModal = { type, error: err.message || String(err), branches: [], loading: false };
      }
      render();
    },
    openPullModal() { this.openGitOpModal("pull"); },
    openPushModal() { this.openGitOpModal("push"); },
    closeGitOpModal() { state.gitOpModal = null; render(); },
    async runPullFromModal() {
      const view = active();
      if (!view) return;
      const mode = (document.getElementById("gitUiOpMode") || {}).value || "regular";
      const branch = (document.getElementById("gitUiOpBranch") || {}).value || "";
      state.gitOpModal = null;
      await postJson("/api/git-ui/pull", { cwd: view.cwd, mode, branch }, "Pulling");
    },
    async runPushFromModal() {
      const view = active();
      if (!view) return;
      const mode = (document.getElementById("gitUiOpMode") || {}).value || "regular";
      const branch = (document.getElementById("gitUiOpBranch") || {}).value || "";
      const pushTags = !!((document.getElementById("gitUiPushTags") || {}).checked);
      state.gitOpModal = null;
      try {
        await postJson("/api/git-ui/push", { cwd: view.cwd, mode, branch, push_tags: pushTags }, "Pushing");
      } catch (err) {
        state.gitOpModal = { type: "force-push", error: err.message || String(err) };
        render();
      }
    },
    async runRebaseFromModal() {
      const view = active();
      if (!view) return;
      const modal = state.gitOpModal || { type: "rebase" };
      const upstream = ((document.getElementById("gitUiRebaseUpstream") || {}).value || "").trim();
      const branch = (document.getElementById("gitUiOpBranch") || {}).value || "";
      const pullFirst = !!((document.getElementById("gitUiRebasePullFirst") || {}).checked);
      if (!upstream) return;
      state.gitOpModal = null;
      try {
        await postJson("/api/git-ui/rebase", { cwd: view.cwd, upstream, onto: branch, pull_first: pullFirst, confirmation: "rebase selected" }, "Rebasing");
      } catch (err) {
        state.gitOpModal = Object.assign({}, modal, { type: "rebase", error: err.message || String(err) });
        render();
      }
    },
    resolve(path, mode) { post("/api/git-ui/conflict-resolve", { cwd: active().cwd, path: decodeURIComponent(path), mode }, "Resolving conflict"); },
    conflictAction(action) { post("/api/git-ui/conflict-action", { cwd: active().cwd, action }, "Continuing operation"); },
    async openBranchModal() {
      const view = active();
      if (!view) return;
      const cwd = gitBranchModalDefaultCwd(view.cwd);
      state.branchModal = { loading: true, error: "", local: [], remote: [], cwd };
      render();
      try {
        const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(cwd)}`);
        state.branchModal = { loading: false, error: "", local: data.local || [], remote: data.remote || [], cwd };
      } catch (err) {
        state.branchModal = { loading: false, error: err.message || String(err), local: [], remote: [], cwd };
      }
      render();
    },
    async loadBranchModalCwd() {
      const modal = state.branchModal;
      const input = document.getElementById("gitUiBranchCwd");
      const cwd = input ? input.value.trim() : "";
      if (!modal || !cwd) return;
      state.branchModal = Object.assign({}, modal, { loading: true, error: "", cwd });
      render();
      try {
        const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(cwd)}`);
        state.branchModal = { loading: false, error: "", local: data.local || [], remote: data.remote || [], cwd };
      } catch (err) {
        state.branchModal = { loading: false, error: err.message || String(err), local: [], remote: [], cwd };
      }
      render();
    },
    closeBranchModal() {
      state.branchModal = null;
      render();
    },
    applyBranchModalCwd() {
      const view = active();
      const input = document.getElementById("gitUiBranchCwd");
      const cwd = (input && input.value.trim()) || (state.branchModal && state.branchModal.cwd) || "";
      if (!view || !cwd) return;
      state.branchModal = null;
      resetGitViewForCwd(view, cwd);
      render();
      refresh();
    },
    returnToWorkspaceCwd() {
      const view = active();
      if (!view || !view.workspaceCwd || gitCwdMatchesWorkspace(view)) return;
      resetGitViewForCwd(view, view.workspaceCwd);
      render();
      refresh();
    },
    switchBranchFromModal() {
      const view = active();
      const select = document.getElementById("gitUiBranchSelect");
      if (!view || !select || !select.value) return;
      const [kind, ...rest] = select.value.split(":");
      const branch = rest.join(":");
      const selectedOption = select.options && select.options[select.selectedIndex];
      const worktreePath = selectedOption && selectedOption.dataset ? selectedOption.dataset.worktreePath : "";
      const input = document.getElementById("gitUiBranchCwd");
      const modalCwd = (input && input.value.trim()) || (state.branchModal && state.branchModal.cwd) || view.cwd;
      state.branchModal = null;
      if (worktreePath && !samePath(worktreePath, modalCwd)) {
        resetGitViewForCwd(view, worktreePath);
        render();
        refresh();
        return;
      }
      view.cwd = modalCwd;
      if (kind === "remote") post("/api/git-ui/switch", { cwd: view.cwd, branch: localNameForRemote(branch), create: true, base: branch }, "Switching branch");
      else post("/api/git-ui/switch", { cwd: view.cwd, branch }, "Switching branch");
    },
    async compareCurrent() {
      if (currentMode() !== "changes") this.latestChanges();
    },
    async compareCommits(base, target) {
      const view = active();
      if (!view) return;
      pushNavigationSnapshot(view);
      view.compareBase = base;
      view.compareTarget = target;
      view.mode = "readonly-compare";
      clearHistoryCompareState(view, { clearBackTarget: true });
      view.tab = "changes";
      await loadDiff();
    },
    async showHistoryCommit(hash) {
      hash = decodeURIComponent(hash);
      const view = active();
      if (!view || !hash) return;
      pushNavigationSnapshot(view);
      startHistoryCommitCompare(view, hash);
      view.tab = "changes";
      await loadDiff();
    },
    async backToFileHistory() {
      const view = active();
      if (!view || !view.file) return;
      resetToChangesMode(view, { clearBackTarget: true });
      view.tab = "history";
      render();
    },
    async backToFileView() {
      const view = active();
      if (!view || !view.file) return;
      const cwd = view.cwd;
      const path = view.file;
      resetToChangesMode(view, { clearBackTarget: true });
      view.tab = "changes";
      if (view.historySource === "file-browser" && window.HerdrFileBrowser && window.HerdrFileBrowser.openAt) {
        await window.HerdrFileBrowser.openAt({ workspace_id: state.activeKey || `git-file-history:${cwd}`, cwd, label: compactPath(cwd) }, path);
        return;
      }
      await loadDiff();
    },
    async backFromFileView() {
      const view = active();
      if (!view) return;
      if ((view.navigationStack || []).length) {
        const snapshot = view.navigationStack.pop();
        await restoreNavigationSnapshot(view, snapshot);
        return;
      }
      const backTarget = view.fileBackTarget;
      if (backTarget && backTarget.type === "log") {
        resetToChangesMode(view, { clearBackTarget: true });
        view.file = "";
        view.diffKind = "";
        view.tab = "log";
        if (backTarget.hash) {
          view.selectedLogCommits = [backTarget.hash];
          if (!view.selectedCommitPreview || view.selectedCommitPreview.hash !== backTarget.hash) loadSelectedCommitPreview(view, backTarget.hash);
        }
        render();
        return;
      }
      this.showChangesList();
    },
    gotoLogCommit(hash) {
      hash = decodeURIComponent(hash);
      const view = active();
      if (!view || !hash) return;
      view.pendingLogScrollHash = hash;
      view.logAll = true;
      view.logScope = "all";
      view.tab = "log";
      render();
    },
    async openFileHistory(cwd, path) {
      cwd = decodeURIComponent(cwd || "");
      path = decodeURIComponent(path || "");
      if (!cwd || !path) return;
      try {
        const info = await api(`/api/git-ui/path-info?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`);
        cwd = info.repo_root || cwd;
        path = info.file || path;
      } catch (err) {
        // Keep the existing best-effort behavior so non-git folders still surface the Git error in-panel.
      }
      if (!(state.visible && active() && samePath(active().cwd, cwd))) {
        await open({ workspace_id: `git-file-history:${cwd}`, cwd, label: compactPath(cwd) }, { forceOpen: true });
      }
      const view = active();
      if (!view) return;
      if (state.visible) pushNavigationSnapshot(view);
      view.file = path;
      view.diffKind = "";
      view.tab = "history";
      resetToChangesMode(view, { clearBackTarget: true });
      view.historySource = "file-browser";
      render();
    },
    clearLogFileHistory() {
      const view = active();
      if (!view) return;
      view.logFilePath = "";
      view.logLimit = GIT_LOG_PAGE_SIZE;
      render();
    },
    latestChanges() {
      this.showChangesList();
    },
    async goBack() {
      const view = active();
      if (!view || !(view.navigationStack || []).length) {
        this.showChangesList();
        return;
      }
      const snapshot = view.navigationStack.pop();
      await restoreNavigationSnapshot(view, snapshot);
    },
    selectLogCommit(event, hash) {
      hash = decodeURIComponent(hash);
      const view = active();
      if (!view || !hash) return;
      const selected = view.selectedLogCommits || [];
      if (event.shiftKey && selected.includes(hash)) {
        view.selectedLogCommits = selected.filter((value) => value !== hash);
      } else if (event.shiftKey) {
        view.selectedLogCommits = selected.concat(hash).slice(-2);
      } else {
        view.selectedLogCommits = selected.length === 1 && selected[0] === hash ? [] : [hash];
      }
      if (view.selectedLogCommits.length === 1) loadSelectedCommitPreview(view, view.selectedLogCommits[0]);
      else view.selectedCommitPreview = null;
      render();
    },
    clearLogSelection() {
      const view = active();
      if (!view) return;
      view.selectedLogCommits = [];
      view.selectedCommitPreview = null;
      render();
    },
    compareSelectedLog() {
      const selected = ((active() || {}).selectedLogCommits || []).slice(0, 2);
      if (selected.length === 1) this.openSelectedCompareModal();
      if (selected.length === 2) this.compareCommits(selected[0], selected[1]);
    },
    openSelectedCompareModal() {
      const selected = ((active() || {}).selectedLogCommits || []).slice(0, 1);
      if (!selected.length) return;
      state.compareSelectedModal = { ref: selected[0] };
      render();
    },
    closeSelectedCompareModal() {
      state.compareSelectedModal = null;
      render();
    },
    async compareSelectedWithPrevious() {
      const hash = state.compareSelectedModal && state.compareSelectedModal.ref;
      state.compareSelectedModal = null;
      if (!hash) return;
      await this.showHistoryCommit(hash);
    },
    async compareSelectedWithCurrent() {
      const hash = state.compareSelectedModal && state.compareSelectedModal.ref;
      state.compareSelectedModal = null;
      if (!hash) return;
      await this.compareCommits(hash, ".");
    },
    setLogAll(value) {
      const view = active();
      if (!view) return;
      view.logScope = value ? "all" : "base-current";
      view.logAll = view.logScope === "all";
      view.logLimit = GIT_LOG_PAGE_SIZE;
      render();
    },
    cycleLogScope() {
      const view = active();
      if (!view) return;
      const order = ["all", "base-current", "base"];
      const current = normalizeLogScope(view.logScope || (view.logAll ? "all" : "base-current"));
      view.logScope = order[(order.indexOf(current) + 1) % order.length];
      view.logAll = view.logScope === "all";
      view.logLimit = GIT_LOG_PAGE_SIZE;
      render();
    },
    async loadMoreLog() {
      const view = active();
      if (!view || view.logLoadingMore) return;
      view.logLimit = Math.min(GIT_LOG_MAX_LIMIT, Math.max(GIT_LOG_PAGE_SIZE, Number(view.logLimit || GIT_LOG_PAGE_SIZE)) + GIT_LOG_PAGE_SIZE);
      view.logLoadingMore = true;
      try {
        await renderLog(++state.renderVersion);
      } catch (err) {
        view.error = err.message || String(err);
      } finally {
        view.logLoadingMore = false;
        if (state.visible) render();
      }
    },
    setLogFilter(field, value) {
      const view = active();
      if (!view) return;
      if (!["description", "date", "author"].includes(field)) return;
      view.logFilters = view.logFilters || { description: "", date: "", author: "" };
      view.logFilters[field] = value || "";
      if (window.HerdrGitLog && window.HerdrGitLog.applyFilters) window.HerdrGitLog.applyFilters(view.logFilters);
    },
    reset() {
      const ref = prompt("Reset to ref", "HEAD");
      if (!ref) return;
      const mode = prompt("Mode: soft, mixed, hard", "soft");
      if (!mode) return;
      const confirmation = mode === "hard" ? prompt('Type "reset hard" to confirm') : "";
      post("/api/git-ui/reset", { cwd: active().cwd, ref_name: ref, mode, confirmation }, "Resetting");
    },
    rebase() { this.openGitOpModal("rebase"); },
    openSelectedResetModal() {
      const view = active();
      const ref = ((view && view.selectedLogCommits) || [])[0];
      if (!view || !ref || currentMode() !== "changes") return;
      state.resetSelectedModal = { ref };
      render();
    },
    closeSelectedResetModal() { state.resetSelectedModal = null; render(); },
    resetSelected(mode) {
      const view = active();
      const ref = ((view && view.selectedLogCommits) || [])[0];
      if (!ref || !["soft", "hard"].includes(mode)) return;
      const label = ref.slice(0, 12);
      const confirmation = mode === "hard" ? prompt(`Hard reset to ${label}. Type "reset hard" to confirm`) : (confirm(`Soft reset to ${label}?`) ? "" : null);
      if (confirmation === null) return;
      state.resetSelectedModal = null;
      post("/api/git-ui/reset", { cwd: view.cwd, ref_name: ref, mode, confirmation }, "Resetting");
    },
    openSelectedTagModal() {
      const view = active();
      const ref = ((view && view.selectedLogCommits) || [])[0];
      if (!view || !ref) return;
      state.tagSelectedModal = { ref, tag: "" };
      render();
    },
    closeSelectedTagModal() { state.tagSelectedModal = null; render(); },
    createSelectedTag() {
      const view = active();
      const ref = ((state.tagSelectedModal || {}).ref) || ((view && view.selectedLogCommits) || [])[0];
      const tag = ((document.getElementById("gitTagName") || {}).value || "").trim();
      if (!view || !ref || !tag) return;
      state.tagSelectedModal = null;
      post("/api/git-ui/tag", { cwd: view.cwd, ref_name: ref, tag_name: tag }, "Tagging");
    },
    async createWorktreeFromSelectedBranch() {
      const view = active();
      const branch = view && view.selectedLogBranch;
      if (!view || !branch) return;
      if (typeof openWorktreeCreateFromGitBranch !== "function") return;
      await openWorktreeCreateFromGitBranch(view.cwd, branch);
    },
    rebaseAfterSelected() {
      const view = active();
      const upstream = ((view && view.selectedLogCommits) || [])[0];
      if (!view || !upstream) return;
      const confirmation = prompt(`Rebase commits after ${upstream.slice(0, 12)} onto main/master. Type "rebase selected" to confirm`);
      if (confirmation === null) return;
      post("/api/git-ui/rebase", { cwd: view.cwd, upstream, confirmation }, "Rebasing");
    },
  };
})();
