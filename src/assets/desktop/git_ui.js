(function () {
  const state = {
    cache: {},
    activeKey: "",
    open: false,
    visible: false,
    renderVersion: 0,
    contextMenu: null,
    logContextMenu: null,
    branchModal: null,
    worktreeList: null,
    gitOpModal: null,
    commitModal: null,
    compareSelectedModal: null,
    resetSelectedModal: null,
    tagSelectedModal: null,
    gitToast: null,
    scopeCopyToast: null,
    cleanupConfirm: null,
    sideScrollTop: 0,
    shortcutPrefixUntil: 0,
  };
  const LARGE_FILE_DIFF_LINE_LIMIT = 500;
  const GIT_LOG_PAGE_SIZE = 80;
  const GIT_LOG_MAX_LIMIT = 2000;

  document.addEventListener("click", (event) => {
    let hadMenu = !!(state.contextMenu || state.logContextMenu || state.headerMenu || state.branchList || state.worktreeList);
    state.contextMenu = null;
    state.logContextMenu = null;
    state.headerMenu = null;
    if ((state.branchList || state.worktreeList) && !eventInsideBranchList(event)) {
      state.branchList = null;
      state.worktreeList = null;
      hadMenu = true;
    }
    if (hadMenu && state.visible) render();
  });
  function eventInsideBranchList(event) {
    let target = event && event.target;
    while (target && target.classList) {
      if (target.classList.contains("git-ui-branch-list") || target.classList.contains("git-ui-branch-chip")) return true;
      target = target.parentNode;
    }
    return false;
  }

  function active() {
    return state.cache[state.activeKey] || null;
  }

  const shortcuts = globalThis.HerdrGitUiShortcuts.create({
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
    confirmFn: (...args) => confirm(...args),
    alertFn: (...args) => alert(...args),
    getGitUi: () => window.HerdrGitUi,
  });
  const stash = globalThis.HerdrGitUiStashModule.create({
    state,
    active,
    api,
    esc,
    arg,
    render,
    replaceContent,
    renderDiffFileBody,
    renderLargeDiffPlaceholder,
    diffFileLineCount,
    diffFileKey,
    largeFileDiffLineLimit: () => LARGE_FILE_DIFF_LINE_LIMIT,
  });
  const renderStash = stash.renderStash;
  const renderStashDiff = stash.renderStashDiff;
  const renderStashDiffFile = stash.renderStashDiffFile;
  const loadStashDiff = stash.loadStashDiff;

  const cleanup = globalThis.HerdrGitUiCleanupModule.create({
    active,
    esc,
    arg,
    treeIcon: (...args) => treeIcon(...args),
    compactPath,
    api,
  });
  const renderCleanup = cleanup.renderCleanup;
  const renderCleanupRepo = cleanup.renderCleanupRepo;
  const cleanupVisibleBranches = cleanup.cleanupVisibleBranches;
  const cleanupDefaultBranch = cleanup.cleanupDefaultBranch;
  const cleanupBranchSelectable = cleanup.cleanupBranchSelectable;
  const cleanupPushedLabel = cleanup.cleanupPushedLabel;
  const renderCleanupGroupTitle = cleanup.renderCleanupGroupTitle;
  const renderCleanupBranch = cleanup.renderCleanupBranch;
  const renderCleanupWorktree = cleanup.renderCleanupWorktree;
  const cleanupItemKey = cleanup.cleanupItemKey;
  const cleanupSelected = cleanup.cleanupSelected;
  const cleanupSelectionState = cleanup.cleanupSelectionState;
  const cleanupSelectableItems = cleanup.cleanupSelectableItems;
  const cleanupRepoItems = cleanup.cleanupRepoItems;
  const cleanupSelectedItems = cleanup.cleanupSelectedItems;
  const cleanupItemLabel = cleanup.cleanupItemLabel;
  const deleteCleanupItem = cleanup.deleteCleanupItem;
  const cleanupForceRetryLikelyNeeded = cleanup.cleanupForceRetryLikelyNeeded;

  const diffRender = globalThis.HerdrGitUiDiffRenderModule.create({
    state,
    active,
    api,
    render,
    esc,
    arg,
    currentMode,
    canMutateDiff,
    diffLayoutMode,
    highlightDiffText,
  });
  const ensureBlame = diffRender.ensureBlame;
  const parseBlame = diffRender.parseBlame;
  const blameName = diffRender.blameName;
  const renderChunk = diffRender.renderChunk;
  const contextArrowsForChunk = diffRender.contextArrowsForChunk;
  const hiddenGap = diffRender.hiddenGap;
  const hunkEnd = diffRender.hunkEnd;
  const unifiedRows = diffRender.unifiedRows;
  const sideBySideRows = diffRender.sideBySideRows;
  const renderLine = diffRender.renderLine;
  const renderUnifiedLine = diffRender.renderUnifiedLine;
  const renderUnifiedDiffCode = diffRender.renderUnifiedDiffCode;
  const unifiedChangePair = diffRender.unifiedChangePair;
  const renderDiffCode = diffRender.renderDiffCode;
  const changedMiddle = diffRender.changedMiddle;
  const markChangeGroups = diffRender.markChangeGroups;
  const isChangedRow = diffRender.isChangedRow;
  const isFirstChange = diffRender.isFirstChange;

  const conflicts = globalThis.HerdrGitUiConflictsModule.create({
    active,
    esc,
    arg,
    currentMode,
    diffLayoutMode,
  });
  const renderSideEditor = conflicts.renderSideEditor;
  const editNoteForLayout = conflicts.editNoteForLayout;
  const renderEditableHunk = conflicts.renderEditableHunk;
  const renderEditableHunkUnified = conflicts.renderEditableHunkUnified;
  const renderEditableHunkConflictControls = conflicts.renderEditableHunkConflictControls;
  const conflictBlocksInText = conflicts.conflictBlocksInText;
  const resolveConflictBlockText = conflicts.resolveConflictBlockText;
  const buildEditableHunks = conflicts.buildEditableHunks;
  const isConflictPath = conflicts.isConflictPath;
  const renderConflictResolutionButtons = conflicts.renderConflictResolutionButtons;
  const renderDiffConflictResolutionButtons = conflicts.renderDiffConflictResolutionButtons;
  const sideEditorOriginalLineClasses = conflicts.sideEditorOriginalLineClasses;
  const changedLineClasses = conflicts.changedLineClasses;
  const changedCurrentLineIndexes = conflicts.changedCurrentLineIndexes;
  const changedCurrentLineIndexesByBounds = conflicts.changedCurrentLineIndexesByBounds;
  const lineIndexesToRanges = conflicts.lineIndexesToRanges;

  const handleKeydown = shortcuts.handleKeydown;
  const titleWithGitShortcut = shortcuts.titleWithGitShortcut;
  window.addEventListener("keydown", handleKeydown, true);

  function isNotGitRepositoryMessage(message) {
    return String(message || "").toLowerCase().includes("not a git repository");
  }

  function gitBranchModalDefaultCwd(cwd) {
    const path = String(cwd || "").trim();
    if (path && path !== "/") return path;
    if (typeof window.defaultFolderPath === "function") {
      const fallback = String(window.defaultFolderPath() || "").trim();
      if (fallback && fallback !== "/") return fallback;
    }
    const exploration = explorationDefaultDirectory();
    if (exploration && exploration !== "/") return exploration;
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

  function gitUiOptions() {
    try {
      return window.HerdrOptions ? window.HerdrOptions.read() : {};
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

  function gitRemoteBranchPreload() {
    const value = Number(gitUiOptions().gitUiRemoteBranchPreload);
    return Number.isFinite(value) ? Math.max(1, Math.min(100, value)) : 10;
  }

  function normalizeLogScope(scope) {
    return ["all", "base-current", "base"].includes(scope) ? scope : "all";
  }

  function setGitUiOption(key, value) {
    try { window.HerdrOptions.update(function (options) { options[key] = value; }); } catch (_) {}
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
  const FileTree = window.HerdrFileTree;

  const sideTree = globalThis.HerdrGitUiSideTreeModule.create({
    active,
    esc,
    arg,
    currentMode,
    diffFile,
    fileListMode,
    largeSectionFileLimit,
    titleWithGitShortcut,
    FileTree,
  });
  const section = sideTree.section;
  const sectionBulkAction = sideTree.sectionBulkAction;
  const treeIcon = sideTree.treeIcon;
  const renderFileTree = sideTree.renderFileTree;
  const renderFlatFileList = sideTree.renderFlatFileList;
  const pathBasename = sideTree.pathBasename;
  const renderTreeNode = sideTree.renderTreeNode;
  const renderSideFile = sideTree.renderSideFile;
  const dirMenuTargetPaths = sideTree.dirMenuTargetPaths;
  const renderDirContextMenu = sideTree.renderDirContextMenu;
  const renderGitViewTabs = sideTree.renderGitViewTabs;
  const hasStagedChanges = sideTree.hasStagedChanges;
  const stashCount = sideTree.stashCount;
  const canOpenStashView = sideTree.canOpenStashView;
  const commitPreviewFile = sideTree.commitPreviewFile;
  const commitPreviewSection = sideTree.commitPreviewSection;
  const stashListHtml = sideTree.stashListHtml;
  const stashFileSection = sideTree.stashFileSection;
  const stashFileSectionList = sideTree.stashFileSectionList;
  const fileSummary = sideTree.fileSummary;
  const fileSummaryEntries = sideTree.fileSummaryEntries;
  const fileSummaryForPath = sideTree.fileSummaryForPath;
  const filesForKind = sideTree.filesForKind;
  const fileTreeStatus = sideTree.fileTreeStatus;
  const normalizeFileTreeStatus = sideTree.normalizeFileTreeStatus;
  const filterFiles = sideTree.filterFiles;
  const sideFileCount = sideTree.sideFileCount;

  const modals = globalThis.HerdrGitUiModalsModule.create({
    state,
    active,
    esc,
    draftKey,
    cleanupItemLabel,
    compactPath,
    localStorage,
  });
  const renderCommitModal = modals.renderCommitModal;
  const renderResetSelectedModal = modals.renderResetSelectedModal;
  const renderCompareSelectedModal = modals.renderCompareSelectedModal;
  const renderTagSelectedModal = modals.renderTagSelectedModal;
  const renderBranchModal = modals.renderBranchModal;
  const renderCleanupConfirm = modals.renderCleanupConfirm;
  const renderGitOpModal = modals.renderGitOpModal;
  const renderGitOpBranchSelect = modals.renderGitOpBranchSelect;
  const renderGitOpModeSelect = modals.renderGitOpModeSelect;
  const renderGitOpModalShell = modals.renderGitOpModalShell;
  const branchOptions = modals.branchOptions;
  const localNameForRemote = modals.localNameForRemote;

  const branchList = globalThis.HerdrGitUiBranchListModule.create({
    state,
    esc,
    arg,
    titleWithGitShortcut,
    samePath,
    compactPath,
    pathBasename,
    gitRemoteBranchPreload,
  });
  const renderWorktreeActions = branchList.renderWorktreeActions;
  const renderGitLocationSelector = branchList.renderGitLocationSelector;
  const renderWorktreeList = branchList.renderWorktreeList;
  const renderHeaderMenu = branchList.renderHeaderMenu;
  const branchRelativeTime = branchList.branchRelativeTime;
  const branchListRow = branchList.branchListRow;
  const renderBranchList = branchList.renderBranchList;
  const refocusBranchFilter = branchList.refocusBranchFilter;

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
    // Shared client: sends x-herdr-session/x-herdr-backend (the Git drawer
    // calls session-scoped routes like /api/worktrees) and handles 401.
    if (globalThis.HerdrHttp) return globalThis.HerdrHttp.request(url, opt);
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    const body = await res.json();
    if (!res.ok || body.error) {
      const error = Error(body.error || res.statusText);
      error.details = body || {};
      throw error;
    }
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
    view.selectedStash = "";
    view.selectedStashDiff = null;
    view.stashFile = "";
    view.stashData = null;
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
    if (view.tab === "stash" && view.selectedStash) return `Stash · ${view.selectedStash}`;
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
        selectedStash: "",
        selectedStashDiff: null,
        stashFile: "",
        stashData: null,
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
    if (view.tab === "stash") view.selectedStashDiff = null;
    if (state.visible) render();
    try {
      view.status = await api(`/api/git-ui/status?cwd=${encodeURIComponent(view.cwd)}`);
      if (view.tab === "stash" && !canOpenStashView(view)) view.tab = "changes";
      if (state.visible) render();
      if (view.tab !== "stash") await loadDiff();
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
    if (typeof showBlocking === "function") showBlocking(label || "Working...");
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
      if (typeof hideBlocking === "function") hideBlocking();
    }
  }

  async function postJson(path, body, label) {
    const view = active();
    if (!view || view.mutating) return null;
    view.mutating = true;
    view.mutatingLabel = label || "";
    if (state.visible) render();
    if (typeof showBlocking === "function") showBlocking(label || "Working...");
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
      if (typeof hideBlocking === "function") hideBlocking();
    }
  }

  function currentMode() {
    const view = active() || {};
    return view.mode || "changes";
  }

  function compareRefLabel(ref) {
    const value = String(ref || "").trim();
    if (!value || value === ".") return "working tree";
    return value;
  }

  function canMutateDiff() {
    const view = active() || {};
    if (view.tab === "stash") return false;
    return currentMode() === "changes" || currentMode() === "current-compare";
  }

  function allFiles() {
    const s = (active() && active().status) || {};
    return [...(s.conflicted || []), ...(s.staged || []), ...(s.unstaged || []), ...(s.untracked || [])].filter((v, i, a) => v && a.indexOf(v) === i);
  }

  function renderContextMenu() {
    const menu = state.contextMenu;
    if (!menu) return "";
    if (menu.kind === "dir") return renderDirContextMenu(menu);
    const actions = [];
    actions.push(`<button onclick="HerdrGitUi.menuAction('showInExplorer')">Show in file explorer</button>`);
    actions.push(`<button onclick="HerdrGitUi.menuAction('showHistory')">Show history</button>`);
    actions.push(`<button onclick="HerdrGitUi.menuAction('copyPermalink')">Copy permalink</button>`);
    if (["S", "M", "?"].includes(menu.kind)) actions.push(`<button onclick="HerdrGitUi.menuAction('stash')">Stash file</button>`);
    if (["M", "?"].includes(menu.kind)) actions.push(`<button onclick="HerdrGitUi.menuAction('discard')">Discard file</button>`);
    if (["M", "?"].includes(menu.kind)) actions.push(`<button onclick="HerdrGitUi.menuAction('stage')">Stage file</button>`);
    if (menu.kind === "S") actions.push(`<button onclick="HerdrGitUi.menuAction('unstage')">Unstage file</button>`);
    return `<div class="git-ui-menu" style="left:${Math.max(0, menu.x)}px;top:${Math.max(0, menu.y)}px" onclick="event.stopPropagation()">${actions.join("")}</div>`;
  }

  function renderLogContextMenu() {
    const menu = state.logContextMenu;
    if (!menu) return "";
    const view = active();
    const selected = (view && view.selectedLogCommits) || [];
    const hasSelection = selected.length > 0;
    const mutable = currentMode() === "changes";
    const item = (label, handler, disabled) => `<button${disabled ? " disabled" : ""} onclick="HerdrGitUi.${handler}">${label}</button>`;
    return `<div class="git-ui-menu git-ui-log-context-menu" style="left:${Math.max(0, menu.x)}px;top:${Math.max(0, menu.y)}px" onclick="event.stopPropagation()">${item("Compare", "compareSelectedLog()", !hasSelection)}${item("Tag", "openSelectedTagModal()", !hasSelection)}${item("Worktree", "createWorktreeFromSelectedBranch()", !view || !view.selectedLogBranch)}${item("Reset", "openSelectedResetModal()", !hasSelection || !mutable)}${item("Rebase", "rebaseAfterSelected()", !hasSelection)}${item("Clear selection", "clearLogSelection()", !hasSelection)}</div>`;
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

  function renderScopeCopyToast() {
    const toast = state.scopeCopyToast;
    if (!toast) return "";
    return `<div class="git-ui-scope-copy-toast" role="status" style="left:${Math.max(8, toast.x)}px;top:${Math.max(8, toast.y)}px">${esc(toast.message)}</div>`;
  }

  async function copyScopeValue(event, value, kind) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const text = decodeURIComponent(String(value || ""));
    if (!text) return;
    await navigator.clipboard.writeText(text);
    const id = Date.now();
    state.scopeCopyToast = { id, x: Number(event && event.clientX) || 16, y: Number(event && event.clientY) || 16, message: `${kind} copied` };
    const panel = ensurePanel();
    const existing = panel.querySelector(".git-ui-scope-copy-toast");
    if (existing) existing.remove();
    panel.insertAdjacentHTML("beforeend", renderScopeCopyToast());
    setTimeout(() => {
      if (state.scopeCopyToast && state.scopeCopyToast.id === id) {
        state.scopeCopyToast = null;
        const current = panel.querySelector(".git-ui-scope-copy-toast");
        if (current) current.remove();
      }
    }, 1800);
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
      : view.tab === "stash"
        ? stashListHtml(view) + stashFileSection(view, filter)
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
    const actions = cleanupOnly ? "" : renderWorktreeActions({ s, esc, commitHint, commitDisabled, cwd: view.cwd, workspaceCwd: view.workspaceCwd, worktreeName: view.title });
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
    const busy = view.mutating ? `<span class="git-ui-busy"><span class="git-ui-busy-spinner"></span>${esc(view.mutatingLabel || "Working...")}</span>` : "";
    const statusIcon = `<span class="git-ui-status-icon git-ui-status-${esc(String(s.state || "closed").replace(/[^a-z0-9_-]/gi, "-"))}" title="${esc(s.state || "closed")}" aria-label="${esc(s.state || "closed")}"></span>`;
    const location = cleanupOnly ? "" : renderGitLocationSelector({ s, esc, cwd: view.cwd, workspaceCwd: view.workspaceCwd, worktreeName: view.title });
    return `<aside class="git-ui-side" onscroll="HerdrGitUi.sideScroll(this)"><div class="git-ui-head"><div class="git-ui-head-main"><div class="git-ui-title-row"><div class="git-ui-title">Git ${statusIcon}</div><div class="git-ui-title-actions">${busy}${returnToCurrentChanges}${returnToWorkspace}${refreshButton}</div></div><div class="git-ui-subtitle">${location}</div></div></div>${error}<div class="git-ui-toolbar git-ui-view-toolbar">${renderGitViewTabs(tabs, view.tab)}</div>${actions}${fileList}${sideBottom}</aside>`;
  }

  function renderDiffLayoutSideToggle(view) {
    const layout = diffLayoutMode();
    const label = view && view.file ? "File view" : "Diff view";
    const cwd = String((view && view.cwd) || "");
    return `<div class="git-ui-side-bottom"><div class="git-ui-path-title" title="${esc(cwd)}">${esc(compactPath(cwd))}</div><div class="git-ui-toolbar-title">${esc(label)}</div><div class="git-ui-view-toggle-group git-ui-diff-layout-toggle" role="group" aria-label="Diff layout"><button class="git-ui-view-toggle ${layout === "side-by-side" ? "active" : ""}" title="Show side-by-side diff" onclick="HerdrGitUi.setDiffLayout('side-by-side')">Side</button><button class="git-ui-view-toggle ${layout === "unified" ? "active" : ""}" title="Show unified diff" onclick="HerdrGitUi.setDiffLayout('unified')">Unified</button></div></div>`;
  }

  function renderFileToolbar(activeTab) {
    const view = active() || {};
    const conflicts = ((((view.status || {}).conflicted) || []).length > 0);
    const breadcrumbs = renderNavigationTrail(view);
    const back = breadcrumbs ? "" : fileToolbarBackButton(view, activeTab);
    const viewStateLabel = fileViewStateLabel(view, activeTab);
    const stateLabel = breadcrumbs || `<span class="git-ui-compare-state git-ui-file-view-state" title="${esc(viewStateLabel)}">${esc(viewStateLabel)}</span>`;
    const compare = activeTab !== "history" && currentMode() !== "changes" && !view.temporaryHistoryCompare && !view.fileBackTarget
      ? `<span class="git-ui-compare-state">Comparing ${esc(compareRefLabel(view.compareBase))} → ${esc(compareRefLabel(view.compareTarget))}</span>`
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
        ? `<button class="git-ui-btn" title="${esc(titleWithGitShortcut("Edit file", "edit"))}" onclick="HerdrGitUi.editFile()">Edit</button>`
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
    if (currentMode() === "readonly-compare") return false;
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

  function renderDiffFile(file) {
    const mode = currentMode();
    const view = active() || {};
    const collapsed = !!(view.collapsedFiles || {})[file.path];
    const lineCount = diffFileLineCount(file);
    const large = lineCount > LARGE_FILE_DIFF_LINE_LIMIT;
    const loadedLarge = !!(view.loadedLargeDiffFiles || {})[file.path];
    const renderFullLarge = !!(view.fullLargeDiffFiles || {})[diffFileKey(file)];
    const left = mode === "changes" ? fileDiffLeftLabel(file) : compareRefLabel(view.compareBase);
    const right = mode === "changes" ? "current" : compareRefLabel(view.compareTarget);
    if (view.showBlame && (!large || loadedLarge)) ensureBlame(file.path);
    const conflictActions = renderDiffConflictResolutionButtons(file);
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
    return `<div class="git-ui-diff-file" data-git-path="${esc(file.path)}"><div class="git-ui-diff-file-head"><button class="git-ui-file-collapse" title="${collapsed ? "Show file" : "Collapse file"}" onclick="HerdrGitUi.toggleFile('${arg(file.path)}')">${collapsed ? "+" : "−"}</button><strong>${esc(file.path)}</strong><span class="git-ui-muted">${esc(left)} → ${esc(right)}</span><span class="git-ui-diff-file-actions"><span class="git-ui-badge add">+${file.additions || 0}</span> <span class="git-ui-badge del">-${file.deletions || 0}</span>${conflictActions}${restore}</span></div>${body}</div>`;
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
    replaceContent(version, window.HerdrGitLog.render({
      data,
      selected,
      logAll: view.logAll,
      logScope: view.logScope,
      logLimit: view.logLimit,
      logLoadingMore: !!view.logLoadingMore,
      baseBranch,
      filePath: view.logFilePath || "",
      actionsHtml: "",
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
    return `${renderFileToolbar("conflicts")}<div class="git-ui-section"><div class="git-ui-muted">Conflicts</div>${files.length ? operationActions : ""}${help}${files.map((file) => `<div class="git-ui-file git-ui-conflict-file"><span>${esc(file)}</span>${renderConflictResolutionButtons(file)}</div>`).join("") || `<div class="git-ui-empty-row">No conflicts</div>`}</div>`;
  }

  function renderMain() {
    const view = active() || {};
    if (view.loading) return `<main class="git-ui-main"><div class="git-ui-loading"><span></span><strong>Loading Git state</strong></div></main>`;
    if (isNoGitRepositoryView(view)) return `<main class="git-ui-main"><div class="git-ui-content">${renderCleanup()}</div></main>`;
    let body = "";
    if (view.tab === "changes") body = renderDiff();
    if (view.tab === "conflicts") body = renderConflicts();
    if (view.tab === "log") body = `<div class="git-ui-muted">Loading log...</div>`;
    if (view.tab === "stash") body = renderStashDiff();
    if (view.tab === "cleanup") body = renderCleanup();
    if (view.tab === "history") body = `<div class="git-ui-muted">Loading history...</div>`;
    return `<main class="git-ui-main"><div class="git-ui-content">${body}</div></main>`;
  }

  function preserveContentScroll(tab) {
    return tab === "cleanup" || tab === "log" || tab === "stash";
  }

  function setupDiffHunkScrollbars(root) {
    const scope = root || document;
    scope.querySelectorAll(".git-ui-hunk").forEach((hunk) => {
      const scroll = hunk.querySelector(".git-ui-hunk-xscroll");
      const inner = scroll && scroll.querySelector(".git-ui-hunk-xscroll-inner");
      if (!scroll || !inner) return;
      // Measure the actual rendered width of code-text elements (inside overflow:hidden
      // parents) rather than relying on scrollWidth, which can under-report when the
      // cell uses min-width:0 in a CSS grid and the child is inline-block with transform.
      const textNodes = Array.from(hunk.querySelectorAll(".git-ui-code-text"));
      const codeCells = Array.from(hunk.querySelectorAll(".git-ui-code, .git-ui-unified-text"));
      const maxScroll = textNodes.reduce((max, text) => {
        const parent = text.parentElement;
        if (!parent) return max;
        const cs = getComputedStyle(parent);
        const padL = parseFloat(cs.paddingLeft) || 0;
        const padR = parseFloat(cs.paddingRight) || 0;
        const innerWidth = parent.clientWidth - padL - padR;
        const overflow = Math.max(0, text.offsetWidth - innerWidth);
        return Math.max(max, overflow);
      }, 0);
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
    panel.innerHTML = renderSide() + renderMain() + renderContextMenu() + renderLogContextMenu() + renderHeaderMenu() + renderBranchList() + renderCommitModal() + renderCompareSelectedModal() + renderResetSelectedModal() + renderTagSelectedModal() + renderBranchModal() + renderGitOpModal() + renderCleanupConfirm() + renderGitToast() + renderScopeCopyToast();
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
          markdownPreview: false,
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
      if (view.tab === "stash") {
        view.loadedLargeDiffFiles = Object.assign({}, view.loadedLargeDiffFiles || {}, { [path]: true });
        render();
        return;
      }
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
    fileMenu(event, file, kind, rowKind) {
      event.preventDefault();
      event.stopPropagation();
      state.contextMenu = { x: event.clientX, y: event.clientY, file: decodeURIComponent(file), kind: rowKind === "dir" ? "dir" : kind };
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
      if (action === "showInExplorer") {
        const parentDir = menu.kind === "dir" ? menu.file.replace(/\/+$/, "") : menu.file.split("/").slice(0, -1).join("/");
        if (window.HerdrFileBrowser && window.HerdrFileBrowser.openAt) {
          const view = active();
          if (view) {
            if (window.rememberWorkspaceShellMode) window.rememberWorkspaceShellMode("files", state.ws, { minimized: false });
            if (window.syncShellModeButtons) window.syncShellModeButtons();
            await window.HerdrFileBrowser.openAt(
              { workspace_id: `git-file-explorer:${view.cwd}`, cwd: view.cwd, label: compactPath(view.cwd) },
              parentDir,
              { kind: "dir" }
            );
          }
        }
        return;
      }
      if (action === "showHistory") {
        const view = active();
        if (view) {
          await window.HerdrGitUi.openFileHistory(encodeURIComponent(view.cwd), encodeURIComponent(menu.file));
        }
        return;
      }
      if (menu.kind === "dir") {
        if (currentMode() !== "changes") return;
        const path = menu.file.replace(/\/+$/, "");
        const targets = dirMenuTargetPaths(menu);
        if (!targets.length) return;
        if (action === "stage" && confirm(`Stage ${targets.length} file${targets.length === 1 ? "" : "s"} under ${path}?`)) {
          post("/api/git-ui/stage", { cwd: active().cwd, paths: targets }, `Staging ${path}`);
        } else if (action === "unstage" && confirm(`Unstage ${targets.length} file${targets.length === 1 ? "" : "s"} under ${path}?`)) {
          post("/api/git-ui/unstage", { cwd: active().cwd, paths: targets }, `Unstaging ${path}`);
        } else if (action === "discard" && confirm(`Discard all changes under ${path}? This restores ${targets.length} file${targets.length === 1 ? "" : "s"} and deletes untracked ones. This cannot be undone.`)) {
          post("/api/git-ui/discard", { cwd: active().cwd, paths: [path], confirmed: true }, `Discarding ${path}`);
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
    async copyScopeValue(event, value, kind) {
      try {
        await copyScopeValue(event, value, kind);
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
    async editFile() {
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
      if (typeof showBlocking === "function") showBlocking("Saving file...");
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
      } finally {
        if (typeof hideBlocking === "function") hideBlocking();
      }
    },
    resolveEditorConflictBlock(hunkIndex, blockIndex, mode) {
      const view = active();
      const editor = view && view.sideEditor;
      if (!editor || editor.loading || editor.saving) return;
      saveSideEditorFromDom();
      hunkIndex = Number(hunkIndex || 0);
      blockIndex = Number(blockIndex || 0);
      const hunk = (editor.hunks || [])[hunkIndex];
      if (!hunk) return;
      const next = resolveConflictBlockText(hunk.text || "", blockIndex, mode);
      if (next === hunk.text) return;
      hunk.text = next;
      render();
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
      const files = view.tab === "stash"
        ? ((view.selectedStashDiff && view.selectedStashDiff.diff && view.selectedStashDiff.diff.files) || [])
        : ((view.diff && view.diff.files) || []);
      for (const file of files) view.collapsedFiles[file.path] = true;
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
      if (view.tab === "stash" && view.selectedStash) {
        view.selectedStashDiff = null;
        render();
        loadStashDiff(view, view.selectedStash);
        return;
      }
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
    applyStash(stash, pop) {
      stash = decodeURIComponent(stash);
      post("/api/git-ui/stash-apply", { cwd: active().cwd, stash, pop }, pop ? "Popping stash" : "Applying stash");
    },
    dropStash(stash) {
      stash = decodeURIComponent(stash);
      if (confirm(`Drop ${stash}?`)) post("/api/git-ui/stash-drop", { cwd: active().cwd, stash, confirmed: true }, "Dropping stash");
    },
    selectStash(name) {
      const view = active();
      if (!view) return;
      name = decodeURIComponent(name);
      view.selectedStash = name;
      view.selectedStashDiff = null;
      view.stashFile = "";
      render();
      loadStashDiff(view, name);
    },
    selectStashFile(path) {
      const view = active();
      if (!view) return;
      path = decodeURIComponent(path);
      view.stashFile = path;
      render();
      requestAnimationFrame(() => {
        const node = document.querySelector(`.git-ui-diff-file[data-git-path="${CSS.escape(path)}"]`);
        if (node) node.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    },
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
      if (typeof showBlocking === "function") showBlocking("Deleting items...");
      const failures = [];
      try {
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
      } finally {
        view.cleanupLoading = false;
        if (typeof hideBlocking === "function") hideBlocking();
      }
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
      if (typeof showBlocking === "function") showBlocking("Deleting branch...");
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
        if (typeof hideBlocking === "function") hideBlocking();
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
      if (typeof showBlocking === "function") showBlocking("Removing worktree...");
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
        if (typeof hideBlocking === "function") hideBlocking();
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
    // Status button actions: Pull (fetch + ff-only) when behind, Push when
    // ahead, plain Fetch otherwise. Chosen from status state at click time.
    async pullUpdateFromUpstream() {
      const view = active();
      if (!view || view.mutating) return;
      await postJson("/api/git-ui/pull", { cwd: view.cwd, mode: "update" }, "Updating from upstream");
    },
    async pushNow() {
      const view = active();
      if (!view || view.mutating) return;
      await postJson("/api/git-ui/push", { cwd: view.cwd, mode: "regular", push_tags: false }, "Pushing");
    },
    async runStatusAction() {
      const view = active();
      if (!view || view.mutating) return;
      const s = view.status || {};
      const ahead = Number(s.ahead) || 0;
      const behind = Number(s.behind) || 0;
      const upstream = String(s.upstream || "").trim();
      if (upstream && behind > 0) return this.pullUpdateFromUpstream();
      if (upstream && ahead > 0) return this.pushNow();
      return this.fetchOrigin();
    },
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
    async runFetchFromFromModal() {
      const view = active();
      if (!view) return;
      const modal = state.gitOpModal || { type: "fetch-from" };
      const branch = (document.getElementById("gitUiOpBranch") || {}).value || "";
      state.gitOpModal = null;
      try {
        await postJson("/api/git-ui/fetch", { cwd: view.cwd, branch }, `Fetching ${branch || "origin"}`);
      } catch (err) {
        state.gitOpModal = Object.assign({}, modal, { type: "fetch-from", error: err.message || String(err) });
        render();
      }
    },
    async runPushToFromModal() {
      const view = active();
      if (!view) return;
      const modal = state.gitOpModal || { type: "push-to" };
      const branch = (document.getElementById("gitUiOpBranch") || {}).value || "";
      const pushTags = !!((document.getElementById("gitUiPushTags") || {}).checked);
      state.gitOpModal = null;
      try {
        await postJson("/api/git-ui/push", { cwd: view.cwd, mode: "regular", branch, push_tags: pushTags }, `Pushing to ${branch || "upstream"}`);
      } catch (err) {
        state.gitOpModal = Object.assign({}, modal, { type: "push-to", error: err.message || String(err) });
        render();
      }
    },
    resolve(path, mode) { post("/api/git-ui/conflict-resolve", { cwd: active().cwd, path: decodeURIComponent(path), mode }, "Resolving conflict"); },
    conflictAction(action) { post("/api/git-ui/conflict-action", { cwd: active().cwd, action }, "Continuing operation"); },
    async openBranchList(event) {
      const view = active();
      if (!view) return;
      if (event && event.stopPropagation) event.stopPropagation();
      // Re-open toggle: clicking the chip again closes the list.
      if (state.branchList && !state.branchList.loading) {
        state.branchList = null;
        render();
        return;
      }
      const currentBranch = ((view.status || {}).branch) || "";
      state.branchList = { loading: true, error: "", local: [], remote: [], filter: "", currentBranch, remoteLoaded: false };
      render();
      try {
        const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(view.cwd)}`);
        if (!state.branchList) return; // closed while loading
        state.branchList = { loading: false, error: "", local: data.local || [], remote: data.remote || [], filter: state.branchList.filter || "", currentBranch, remoteLoaded: false };
      } catch (err) {
        if (!state.branchList) return;
        state.branchList = { loading: false, error: err.message || String(err), local: [], remote: [], filter: state.branchList.filter || "", currentBranch, remoteLoaded: false };
      }
      render();
    },
    async openWorktreeList(event) {
      const view = active();
      if (!view) return;
      if (event && event.stopPropagation) event.stopPropagation();
      if (state.worktreeList) { state.worktreeList = null; render(); return; }
      state.worktreeList = { loading: true, error: "", worktrees: [], currentPath: view.cwd };
      render();
      try {
        const data = await api(`/api/worktrees?cwd=${encodeURIComponent(view.workspaceCwd || view.cwd)}`);
        const result = data.result || data;
        state.worktreeList = { loading: false, error: "", worktrees: result.worktrees || [], currentPath: view.cwd };
      } catch (err) {
        state.worktreeList = { loading: false, error: err.message || String(err), worktrees: [] };
      }
      render();
    },
    selectWorktree(encodedPath) {
      const view = active();
      const path = decodeURIComponent(encodedPath || "");
      if (!view || !path || samePath(path, view.cwd)) return;
      if (!window.confirm(`Switch Git to worktree folder "${path}"?`)) return;
      state.worktreeList = null;
      resetGitViewForCwd(view, path);
      render();
      refresh();
    },
    createWorktreeFromSelector() {
      const view = active();
      state.worktreeList = null;
      render();
      if (view && typeof openWorktreeCreateFromGitBranch === "function") openWorktreeCreateFromGitBranch(view.cwd, ((view.status || {}).branch || ""));
      else if (typeof openWorktreeOpenModal === "function") openWorktreeOpenModal(view && view.cwd, true);
    },
    closeBranchList() {
      if (!state.branchList) return;
      state.branchList = null;
      render();
    },
    branchListFilter(value) {
      if (!state.branchList) return;
      state.branchList.filter = String(value || "");
      if (state.branchList.filter.trim()) {
        state.branchList.remoteLoaded = true;
        state.branchList.remoteLoading = true;
        const requestId = Date.now();
        state.branchList.remoteRequestId = requestId;
        render();
        refocusBranchFilter(state.branchList.filter);
        api(`/api/git-ui/branches?cwd=${encodeURIComponent((active() || {}).cwd || "")}`).then((data) => {
          if (!state.branchList || state.branchList.remoteRequestId !== requestId) return;
          const existing = new Map((state.branchList.remote || []).map((branch) => [branch.name, branch]));
          (data.remote || []).forEach((branch) => existing.set(branch.name, branch));
          state.branchList.remote = [...existing.values()];
        }).catch(() => {}).finally(() => {
          if (state.branchList && state.branchList.remoteRequestId === requestId) {
            state.branchList.remoteLoading = false;
            render();
            refocusBranchFilter(state.branchList.filter);
          }
        });
        return;
      }
      state.branchList.remoteLoading = false;
      // Re-render only the list, not the whole panel: the filter input
      // would lose focus otherwise.
      const panel = document.getElementById("gitUiPanel");
      const existing = panel && panel.querySelector(".git-ui-branch-list");
      if (!existing) { render(); return; }
      const template = document.createElement("div");
      template.innerHTML = renderBranchList();
      const next = template.firstElementChild;
      if (!next) { render(); return; } // DOM without real parsing (tests): full re-render
      existing.replaceWith(next);
      const input = next.querySelector("input");
      if (input && typeof input.focus === "function") {
        input.focus();
        try { input.setSelectionRange(String(value || "").length, String(value || "").length); } catch (_) {}
      }
    },
    loadMoreBranches() {
      if (!state.branchList) return;
      state.branchList.remoteLoaded = true;
      render();
    },
    async switchFromBranchList(encodedName, isRemote) {
      const name = decodeURIComponent(String(encodedName || ""));
      const view = active();
      if (!view || !name) return;
      state.branchList = null;
      render();
      const localName = isRemote ? name.split("/").slice(1).join("/") : name;
      if (!localName) return;
      const currentBranch = ((view.status || {}).branch) || "";
      if (localName === currentBranch) return;
      if (!window.confirm(`Switch Git to branch "${name}"?`)) return;
      await postJson("/api/git-ui/switch", { cwd: view.cwd, branch: localName }, `Switching to ${name}`);
    },
    // Trash icon in a branch-list row: deletes the branch through the same
    // endpoint the cleanup view uses. Remote rows and the current branch
    // are refused (the backend also refuses the checked-out branch).
    async deleteFromBranchList(encodedName, isRemote) {
      const name = decodeURIComponent(String(encodedName || ""));
      const view = active();
      if (!view || !name) return;
      if (isRemote) {
        if (state.branchList) {
          state.branchList.error = "Deleting remote branches is not supported here";
          render();
        }
        return;
      }
      const currentBranch = String(((view.status || {}).branch) || "");
      if (name === currentBranch) return;
      if (!window.confirm(`Delete branch "${name}"?`)) return;
      const filter = String((state.branchList && state.branchList.filter) || "");
      state.branchList = { loading: true, error: "", local: [], remote: [], filter, currentBranch };
      render();
      try {
        await api("/api/git-ui/branch-delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: view.cwd, branch: name, force: false, confirmed: true }),
        });
        const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(view.cwd)}`);
        state.branchList = { loading: false, error: "", local: data.local || [], remote: data.remote || [], filter, currentBranch };
      } catch (err) {
        state.branchList = { loading: false, error: err.message || String(err), local: [], remote: [], filter, currentBranch };
      }
      render();
      await refresh();
    },
    toggleHeaderMenu(event) {
      if (event && event.stopPropagation) event.stopPropagation();
      if (state.headerMenu) { state.headerMenu = null; render(); return; }
      const rect = event && event.currentTarget && event.currentTarget.getBoundingClientRect ? event.currentTarget.getBoundingClientRect() : null;
      state.headerMenu = { x: rect ? rect.left : (event && event.clientX) || 0, y: rect ? rect.bottom + 4 : (event && event.clientY) || 0 };
      render();
    },
    async fetchOrigin() {
      state.headerMenu = null;
      const view = active();
      if (!view) return;
      await postJson("/api/git-ui/fetch", { cwd: view.cwd }, "Fetching origin");
    },
    openFetchFromModal() { state.headerMenu = null; this.openGitOpModal("fetch-from"); },
    async pullWithRebase() {
      state.headerMenu = null;
      const view = active();
      if (!view) return;
      await postJson("/api/git-ui/pull", { cwd: view.cwd, mode: "rebase" }, "Pulling with rebase");
    },
    openPushToModal() { state.headerMenu = null; this.openGitOpModal("push-to"); },
    openForcePushModal() { state.headerMenu = null; state.gitOpModal = { type: "force-push", error: "", branches: [], loading: false }; render(); },
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
    openLogContextMenu(event, hash) {
      if (event) {
        event.preventDefault();
        event.stopPropagation();
      }
      const view = active();
      hash = decodeURIComponent(hash || "");
      if (!view || !hash) return false;
      view.selectedLogCommits = [hash];
      view.selectedCommitPreview = null;
      state.contextMenu = null;
      state.headerMenu = null;
      state.logContextMenu = {
        x: Number(event && event.clientX) || 0,
        y: Number(event && event.clientY) || 0,
      };
      render();
      return false;
    },
    clearLogSelection() {
      const view = active();
      if (!view) return;
      view.selectedLogCommits = [];
      view.selectedCommitPreview = null;
      state.logContextMenu = null;
      render();
    },
    compareSelectedLog() {
      const view = active();
      const selected = ((view && view.selectedLogCommits) || []).slice(0, 2);
      if (selected.length === 1) this.openSelectedCompareModal();
      if (selected.length !== 2) return;
      // The right side must always show the newest ref: order the pair by
      // position in the commit log, not by click order. logData.commits[0] is
      // the newest commit, so the ascending sort puts the newest first and it
      // becomes the compare target (right side).
      const order = new Map((((view.logData || {}).commits) || []).map((commit, index) => [String(commit.hash || ""), index]));
      const rank = (hash) => (order.has(hash) ? order.get(hash) : Number.MAX_SAFE_INTEGER);
      const [target, base] = selected.slice().sort((a, b) => rank(a) - rank(b));
      this.compareCommits(base, target);
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
      const view = active();
      if (!view) return;
      pushNavigationSnapshot(view);
      view.compareBase = hash;
      view.compareTarget = ".";
      view.mode = "current-compare";
      clearHistoryCompareState(view, { clearBackTarget: true });
      view.tab = "changes";
      await loadDiff();
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
