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

  const primitives = globalThis.HerdrGitUiPrimitivesModule.create();
  const gitUiOptions = primitives.gitUiOptions;
  const explorationDefaultDirectory = primitives.explorationDefaultDirectory;
  const largeDiffLineLimit = primitives.largeDiffLineLimit;
  const largeChangeFileLimit = primitives.largeChangeFileLimit;
  const largeSectionFileLimit = primitives.largeSectionFileLimit;
  const fileListMode = primitives.fileListMode;
  const diffLayoutMode = primitives.diffLayoutMode;
  const gitLogDefaultBranch = primitives.gitLogDefaultBranch;
  const gitRemoteBranchPreload = primitives.gitRemoteBranchPreload;
  const normalizeLogScope = primitives.normalizeLogScope;
  const setGitUiOption = primitives.setGitUiOption;
  const diffLineCount = primitives.diffLineCount;
  const diffFileLineCount = primitives.diffFileLineCount;
  const loadedLargeDiffPreviewLimit = primitives.loadedLargeDiffPreviewLimit;
  const previewDiffFile = primitives.previewDiffFile;
  const diffFileKey = primitives.diffFileKey;
  const previewChunkLines = primitives.previewChunkLines;
  const changeSetFileCount = primitives.changeSetFileCount;
  const hashText = primitives.hashText;
  const esc = primitives.esc;
  const arg = primitives.arg;

  const diffSearch = globalThis.HerdrGitUiDiffSearchModule.create({
    active,
    Syntax: () => Syntax,
    diffLayoutMode,
    unifiedRows: (chunk) => unifiedRows(chunk),
    sideBySideRows: (chunk) => sideBySideRows(chunk),
  });
  const diffSearchQuery = diffSearch.diffSearchQuery;
  const highlight = (code, path) => Syntax.highlight(code, path);
  const highlightDiffText = diffSearch.highlightDiffText;
  const canSearchDiff = diffSearch.canSearchDiff;
  const countTextMatches = diffSearch.countTextMatches;
  const diffSearchMatchCount = diffSearch.diffSearchMatchCount;

  const workspaceNav = globalThis.HerdrGitUiWorkspaceNavModule.create({
    state,
    currentMode,
    normalizeLogScope,
    preserveContentScroll,
    loadDiff,
    loadSelectedCommitPreview,
    render,
    esc,
    GIT_LOG_PAGE_SIZE,
  });
  const workspaceCwd = workspaceNav.workspaceCwd;
  const workspaceTitle = workspaceNav.workspaceTitle;
  const workspaceKey = workspaceNav.workspaceKey;
  const normalizePathForCompare = workspaceNav.normalizePathForCompare;
  const samePath = workspaceNav.samePath;
  const gitCwdMatchesWorkspace = workspaceNav.gitCwdMatchesWorkspace;
  const resetGitViewForCwd = workspaceNav.resetGitViewForCwd;
  const clonePlain = workspaceNav.clonePlain;
  const currentNavigationLabel = workspaceNav.currentNavigationLabel;
  const captureNavigationSnapshot = workspaceNav.captureNavigationSnapshot;
  const pushNavigationSnapshot = workspaceNav.pushNavigationSnapshot;
  const restoreNavigationSnapshot = workspaceNav.restoreNavigationSnapshot;
  const renderNavigationTrail = workspaceNav.renderNavigationTrail;
  const workspaceStatus = workspaceNav.workspaceStatus;
  const compactPath = workspaceNav.compactPath;

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
    canEditCurrentFile: (...args) => canEditCurrentFile(...args),
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
    renderDiffFileBody: (...args) => renderDiffFileBody(...args),
    renderLargeDiffPlaceholder: (...args) => renderLargeDiffPlaceholder(...args),
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
    canMutateDiff: (...args) => canMutateDiff(...args),
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

  const toasts = globalThis.HerdrGitUiToastsModule.create({
    state,
    active,
    api,
    esc,
    arg,
    render,
    ensurePanel,
    navigator,
    setTimeoutFn: (...args) => setTimeout(...args),
  });
  const normalizeRemoteUrl = toasts.normalizeRemoteUrl;
  const branchPath = toasts.branchPath;
  const gitBranchUrl = toasts.gitBranchUrl;
  const gitPullRequestUrl = toasts.gitPullRequestUrl;
  const renderGitToast = toasts.renderGitToast;
  const showCommitToast = toasts.showCommitToast;
  const copyGitPermalink = toasts.copyGitPermalink;
  const copyCommitId = toasts.copyCommitId;
  const renderScopeCopyToast = toasts.renderScopeCopyToast;
  const copyScopeValue = toasts.copyScopeValue;

  const diffView = globalThis.HerdrGitUiDiffViewModule.create({
    state,
    active,
    currentMode,
    compareRefLabel,
    isNoGitRepositoryView,
    diffFile,
    diffFileKey,
    diffFileLineCount,
    diffLineCount,
    largeDiffLineLimit,
    loadedLargeDiffPreviewLimit,
    previewDiffFile,
    diffLayoutMode,
    hashText,
    esc,
    arg,
    canSearchDiff,
    diffSearchMatchCount,
    LARGE_FILE_DIFF_LINE_LIMIT,
    renderNavigationTrail,
    titleWithGitShortcut,
    renderDiffConflictResolutionButtons,
    renderSideEditor,
    ensureBlame,
    renderChunk,
    stashCount,
    canOpenStashView,
    section,
    commitPreviewSection,
    stashListHtml,
    stashFileSection,
    renderGitViewTabs,
    hasStagedChanges,
    filterFiles,
    sideFileCount,
    renderWorktreeActions,
    renderGitLocationSelector,
    renderDirContextMenu,
    gitCwdMatchesWorkspace,
    compactPath,
    appRefreshIconButton,
  });
  const canMutateDiff = diffView.canMutateDiff;
  const allFiles = diffView.allFiles;
  const renderContextMenu = diffView.renderContextMenu;
  const renderLogContextMenu = diffView.renderLogContextMenu;
  const historicalFileCommitLabel = diffView.historicalFileCommitLabel;
  const clearHistoryCompareState = diffView.clearHistoryCompareState;
  const resetToChangesMode = diffView.resetToChangesMode;
  const startHistoryCommitCompare = diffView.startHistoryCommitCompare;
  const fileViewStateLabel = diffView.fileViewStateLabel;
  const fileToolbarBackButton = diffView.fileToolbarBackButton;
  const renderSide = diffView.renderSide;
  const renderDiffLayoutSideToggle = diffView.renderDiffLayoutSideToggle;
  const renderFileToolbar = diffView.renderFileToolbar;
  const renderDiffSearchControl = diffView.renderDiffSearchControl;
  const canEditCurrentFile = diffView.canEditCurrentFile;
  const renderDiff = diffView.renderDiff;
  const largeChangeDiffShells = diffView.largeChangeDiffShells;
  const largeChangeFileItems = diffView.largeChangeFileItems;
  const largeChangeHiddenFile = diffView.largeChangeHiddenFile;
  const renderDiffFile = diffView.renderDiffFile;
  const renderDiffFileBody = diffView.renderDiffFileBody;
  const fileDiffLeftLabel = diffView.fileDiffLeftLabel;
  const renderLargeChangePlaceholder = diffView.renderLargeChangePlaceholder;
  const renderLargeDiffPlaceholder = diffView.renderLargeDiffPlaceholder;
  const scrollToDiffFile = diffView.scrollToDiffFile;

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
