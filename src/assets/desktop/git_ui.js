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
    syncPaneTabFromView,
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
  const viewCrumbs = workspaceNav.viewCrumbs;
  const captureNavigationSnapshot = workspaceNav.captureNavigationSnapshot;
  const pushNavigationSnapshot = workspaceNav.pushNavigationSnapshot;
  const restoreNavigationSnapshot = workspaceNav.restoreNavigationSnapshot;
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
    // Phase 3c heal: cleanup is the only valid view on a non-Git folder;
    // the pane tree may sit on any other git tab from an earlier repo
    // state. Sync the strip so the active tab names what renders.
    syncPaneTabFromView();
    view.file = "";
    view.diff = { files: [] };
    view.status = {
      state: "cleanup only",
      repo_path: view.cwd || "",
      branch: "No Git repository",
      not_git_repository: true,
      // __probed marks this status fresh: the shell probe and the rail
      // resync read the same cache, an unmarked nogit status would
      // refetch the failing endpoint on every shell render while the
      // drawer stays open on the non-git folder.
      __probed: true,
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
    activeToggleKind,
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

  const logRender = globalThis.HerdrGitUiLogRenderModule.create({
    active,
    api,
    esc,
    arg,
    gitLogDefaultBranch,
    normalizeLogScope,
    GIT_LOG_PAGE_SIZE,
    GIT_LOG_MAX_LIMIT,
    isNoGitRepositoryView,
    renderFileToolbar,
    renderCleanup,
    renderStashDiff,
    renderConflictResolutionButtons,
    renderDiff,
    replaceContent,
    render,
  });
  const renderLog = logRender.renderLog;
  const updateGitLogStickyOffsets = logRender.updateGitLogStickyOffsets;
  const renderHistory = logRender.renderHistory;
  const renderConflictOperationActions = logRender.renderConflictOperationActions;
  const renderConflicts = logRender.renderConflicts;
  const renderMain = logRender.renderMain;

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

  function showPanel(show, hosted = panelIsHosted()) {
    const panel = ensurePanel();
    panel.style.display = show ? (hosted ? "flex" : "grid") : "none";
    if (!show) {
      state.renderVersion++;
      panel.innerHTML = "";
    }
  }

  function panelIsHosted() {
    return !!(window.HerdrRightSidebar && window.HerdrRightSidebar.isHosted("gitUiPanel"));
  }

  // ---- center git tab bridge (Phase 3c) -------------------------------
  // workspace_panes owns tab identity and the container node; git_ui owns
  // per-view state and markup. openViewTab applies the view-key to the
  // workspace view state, ensures the container exists in the pane content
  // slot, activates the pane tab, and renders.
  function applyViewKeyToState(view, viewKey) {
    const key = String(viewKey || "");
    if (!key) return false;
    if (key === "changes") {
      if (currentMode() !== "changes") resetToChangesMode(view);
      view.sideEditor = null;
      view.diffKind = view.diffKind || "";
      view.diffScope = "all";
      view.tab = "changes";
      return true;
    }
    if (key === "log" || key === "stash" || key === "cleanup" || key === "conflicts") {
      view.tab = key;
      return true;
    }
    if (key.startsWith("history@")) {
      view.file = key.slice("history@".length);
      view.diffKind = "";
      view.tab = "history";
      return true;
    }
    if (key.startsWith("diff@")) {
      view.file = key.slice("diff@".length);
      view.diffKind = "";
      resetToChangesMode(view);
      view.tab = "changes";
      return true;
    }
    if (key.startsWith("compare@")) {
      const target = key.slice("compare@".length);
      const sep = target.indexOf("..");
      view.compareBase = sep > 0 ? target.slice(0, sep) : target;
      // "current" in the view-key names the working tree (the tab title
      // spells it out; the API keeps taking ".").
      const rawTarget = sep > 0 ? target.slice(sep + 2) : "";
      view.compareTarget = rawTarget === "current" ? "." : rawTarget;
      view.mode = rawTarget === "current" ? "current-compare" : "readonly-compare";
      view.tab = "changes";
      return true;
    }
    return false;
  }

  // Creates or reuses the tab's container node in the active pane content
  // slot (createElement contract). Returns the container, or null when no
  // pane tree exists (standalone harnesses render into the panel).
  function ensureViewTabContainer(viewKey) {
    const panes = window.HerdrWorkspacePanes;
    if (!panes || !panes.paneGitMountId) return null;
    // The container follows the tab's owning pane: the open path focuses
    // the owning leaf before mounting, and the container must land there.
    const tabId = panes.gitTabId ? panes.gitTabId(String(viewKey)) : null;
    const pane = (tabId && panes.paneElementForTab && panes.paneElementForTab(tabId))
      || (panes.activePaneElement && panes.activePaneElement())
      || document.querySelector("#workspacePanes .workspace-pane");
    const content = pane && pane.querySelector(".pane-content");
    if (!content) return null;
    let container = document.getElementById(panes.paneGitMountId(String(viewKey)));
    if (!container) {
      container = document.createElement("section");
      container.id = panes.paneGitMountId(String(viewKey));
      container.className = "pane-git-container";
      container.dataset.viewKey = String(viewKey);
    }
    if (container.parentElement !== content) content.appendChild(container);
    content.querySelectorAll(".pane-editor-container, .pane-git-container").forEach((node) => {
      if (node !== container) node.style.display = "none";
      else node.style.display = "";
    });
    return container;
  }

  async function openViewTab(viewKey) {
    if (!state.visible) return;
    const view = active();
    if (!view) return;
    if (!applyViewKeyToState(view, viewKey)) return;
    const panes = window.HerdrWorkspacePanes;
    const container = ensureViewTabContainer(viewKey);
    if (!container) { render(); return; }
    if (panes && panes.setActivePaneTab) panes.setActivePaneTab(panes.gitTabId(String(viewKey)));
    // Whole-tree views refetch their body: log pages in, stash pulls the
    // stash list, and the changes tree reloads the working diff. Focused
    // views (per-file diff, compare) keep the loaded diff while the
    // signature matches; the stash body loads from renderStash, matching
    // refresh(). The workspace view state is shared by every git tab of
    // one workspace, so view.diff can hold another tab's result: the
    // signature mismatch is what tells a fresh or foreign focused tab
    // (must refetch, or it renders a stale diff) from a focus re-click of
    // the same view (keep the loaded diff). A returning focused tab first
    // restores its parked diff from the side cache; the restore misses on
    // a foreign or mutated view state and the staleness path refetches.
    if (view.tab !== "stash") restoreFocusedDiff(view, String(viewKey));
    const focusedStale = focusedDiffView(view)
      && view.diffSignature !== diffSignatureFor(view);
    if (view.tab === "log" || (view.tab === "stash" && !view.stashData)
      || (view.tab === "changes" && !view.file && view.mode !== "readonly-compare" && view.mode !== "current-compare")
      || focusedStale) {
      // The whole-tree refetch is best-effort: a repo error renders the
      // in-panel error surface instead of leaving the tab container blank
      // (the unhandled rejection would skip the render below).
      try {
        if (view.tab !== "stash") await loadDiff();
      } catch (e) {
        view.error = e && e.message ? e.message : String(e);
      }
    }
    render();
  }

  // workspace_panes calls this after a tab close dropped the tab id: the
  // container node is gone, so nothing left references the view-key.
  // Per-view git state stays in the workspace cache (cheap to refetch).
  function releaseViewTab() {}

  // Heals the pane tree after an internal state flip (refresh dropped the
  // stash view, the repo turned out to not be Git). The pane tree may sit
  // on the now-invalid tab; without healing, the strip highlight names one
  // view while the state renders another. Only touches the tree when a git
  // tab is active, so a terminal/editor session is never hijacked. Best
  // effort: callers render right after, and openGitTab owns the tab id.
  function syncPaneTabFromView() {
    const panes = window.HerdrWorkspacePanes;
    if (!panes || !panes.paneRoot || !panes.isGitTab || !panes.gitTabViewKey || !panes.paneActiveTab) return;
    const activeTabId = panes.paneActiveTab();
    if (!panes.isGitTab(activeTabId)) return;
    const activeViewKey = panes.gitTabViewKey(activeTabId);
    const viewKey = mainViewKeyFor(active());
    if (!viewKey || activeViewKey === viewKey) return;
    if (panes.openGitTab) void panes.openGitTab(viewKey);
  }

  async function open(workspace, options) {
    const openOptions = options || {};
    const key = workspaceKey(workspace);
    const nextWorkspaceCwd = workspaceCwd(workspace);
    if (state.visible && state.activeKey === key && !openOptions.forceOpen) {
      hide();
      return;
    }
    // Any reopen of an already-loaded view is a resync point. forceOpen
    // onto a visible same-key drawer is a re-focus (re-selecting a git
    // workspace whose drawer is up), and a plain open after hide() is a
    // rail-click reopen. Both may sit on a full load that went stale after
    // an out-of-band commit, so refresh even when needsLoad below says
    // false. First opens stay on the needsLoad path.
    const reopenResync = !!(state.cache[key] && state.cache[key].status && (openOptions.forceOpen || !state.visible));
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
        committedFile: null,
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
    // Desktop host takes the panel into the right sidebar column before
    // the first render. Test harnesses keep the fallback host; forceOpen
    // only bypasses the rail's collapse toggle in the render.js wrapper,
    // not the mount decision.
    let hostedResult = "legacy";
    if (window.HerdrRightSidebar)
      hostedResult = await window.HerdrRightSidebar.openView("git", state.ws, ensurePanel);
    showPanel(true, hostedResult === "hosted");
    requestAnimationFrame(() => ensurePanel().focus({ preventScroll: true }));
    // A center git tab the pane tree restored (reload with a git tab
    // active) reopens its view so the strip highlight matches the
    // rendered surface. Without an active git tab the sidebar opens
    // alone, same as a fresh rail click.
    const panes = window.HerdrWorkspacePanes;
    const activeTab = panes && panes.paneActiveTab ? panes.paneActiveTab() : "";
    const restoredViewKey = panes && panes.isGitTab && panes.isGitTab(activeTab) ? panes.gitTabViewKey(activeTab) : "";
    // A status parked by the rail probe is a hint, not a load: it never
    // ran through refresh(), so no diff came with it. Treat the view as
    // unloaded and let open() do the real fetch.
    const needsLoad = (view) => !view || !view.status || view.status.__probedOnly;
    if (restoredViewKey && applyViewKeyToState(active() || {}, restoredViewKey)) {
      await ensureViewTabContainer(restoredViewKey);
      if (reopenResync || needsLoad(active())) await refresh();
    } else {
      if (reopenResync || needsLoad(active())) await refresh();
    }
    render();
  }

  function hide() {
    saveDraftFromDom();
    saveSideEditorFromDom();
    state.visible = false;
    showPanel(false);
    if (window.HerdrRightSidebar) window.HerdrRightSidebar.afterDrawerRender();
  }

  function close() {
    saveDraftFromDom();
    saveSideEditorFromDom();
    if (state.activeKey) delete state.cache[state.activeKey];
    state.open = false;
    state.visible = false;
    showPanel(false);
    if (window.HerdrRightSidebar) window.HerdrRightSidebar.afterDrawerRender();
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
    // A refresh means the repo moved (commit, stash, switch, pull):
    // every parked focused diff from before the mutation is stale, so
    // drop the side cache before the reload refills it.
    view.focusedDiffCache = {};
    if (state.visible) render();
    try {
      view.status = Object.assign({}, await api(`/api/git-ui/status?cwd=${encodeURIComponent(view.cwd)}`), { __probed: true });
      // The rail tint reads this cached status. Without a resync a commit
      // made here leaves the rail dirty until some unrelated shell render
      // happens to run; refresh is where the cache changes, so resync here.
      // __probed marks the status fresh so the resync does not refetch it.
      if (window.syncGitWorkspaceToggle) window.syncGitWorkspaceToggle();
      // The status endpoint answers a non-git folder as a payload
      // (not_git_repository) instead of an error, so a plain api() success
      // can still mean nogit. markNoGitRepository parks the cleanup-only
      // view exactly like the old error path; without it loadDiff() would
      // run (empty diff on a nogit cwd) and render changes UI over a
      // status that says there is no repo.
      if (isNoGitRepositoryView(view)) {
        markNoGitRepository(view);
        if (state.visible) render();
        return;
      }
      // Phase 3c heal: with stashes gone the stash view is invalid. The
      // pane tree may still sit on git:stash; sync the strip before the
      // render so the active tab matches what the view renders.
      if (view.tab === "stash" && !canOpenStashView(view)) {
        view.tab = "changes";
        syncPaneTabFromView();
      }
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

  function diffContextOf(view) {
    return Math.max(0, Math.min(200, Number(view.diffContext || 3)));
  }

  // What view.diff currently holds, as a comparable string. loadDiff
  // records it after every load; openViewTab compares it against what
  // the focused pane tab needs. The workspace view state is shared by
  // every git tab of one workspace, so visiting another tab can leave a
  // foreign diff in view.diff; the signature is what tells a fresh
  // compare tab (stale signature, must refetch) from a focus re-click of
  // the same compare (signature matches, keep the loaded diff).
  function diffSignatureFor(view) {
    const mode = view.mode || "changes";
    const compare = mode !== "changes";
    return [
      mode,
      compare ? (view.compareBase || "") : (view.diffScope || "all"),
      compare ? (view.compareTarget || "") : "",
      view.file || "",
      view.cwd || "",
      diffContextOf(view),
    ].join("|");
  }

  // Focused-view diff side cache, one entry per pane tab view-key. The
  // shared view.diff slot holds only the latest focused diff, so
  // compare@A..B → compare@C..D → compare@A..B refetched A on the return
  // even though its diff was loaded moments ago. Every loadDiff for a
  // focused view (compare, per-file) parks the result under its view-key;
  // openViewTab restores before the staleness check so a returning tab
  // keeps its loaded diff. refresh() drops the cache: a repo mutation
  // (commit, stash, switch) invalidates every cached diff.
  function focusedDiffCacheFor(view) {
    if (!view) return null;
    if (!view.focusedDiffCache) view.focusedDiffCache = {};
    return view.focusedDiffCache;
  }

  // Which views count as a focused diff view: the compare modes and the
  // per-file changes view. openViewTab's staleness check, save and
  // restore must agree on this set or the cache writes and reads
  // different view-keys.
  function focusedDiffView(view) {
    const mode = view.mode || "changes";
    return mode === "readonly-compare" || mode === "current-compare" || (view.tab === "changes" && view.file);
  }

  function saveFocusedDiff(view) {
    if (!focusedDiffView(view) || !view.diff) return;
    const cache = focusedDiffCacheFor(view);
    const viewKey = mainViewKeyFor(view);
    if (cache && viewKey) cache[viewKey] = { diff: view.diff, signature: view.diffSignature, compareFilePaths: view.compareFilePaths };
  }

  function restoreFocusedDiff(view, viewKey) {
    if (!focusedDiffView(view)) return false;
    const cache = focusedDiffCacheFor(view);
    const entry = cache && viewKey ? cache[viewKey] : null;
    if (!entry || !entry.diff || entry.signature !== diffSignatureFor(view)) return false;
    view.diff = entry.diff;
    view.diffSignature = entry.signature;
    if (entry.compareFilePaths) view.compareFilePaths = entry.compareFilePaths;
    return true;
  }

  async function loadDiff() {
    const view = active();
    if (!view) return;
    const context = diffContextOf(view);
    if (currentMode() !== "changes") {
      const mergeBase = currentMode() === "current-compare" ? "&merge_base=true" : "";
      const file = view.file ? `&file=${encodeURIComponent(view.file)}` : "";
      view.diff = await api(`/api/git-ui/compare?cwd=${encodeURIComponent(view.cwd)}&base=${encodeURIComponent(view.compareBase || "HEAD")}&target=${encodeURIComponent(view.compareTarget || "HEAD")}&context=${context}${mergeBase}${file}`);
      view.diffSignature = diffSignatureFor(view);
      if (!view.file) view.compareFilePaths = ((view.diff && view.diff.files) || []).map((file) => file.path);
      saveFocusedDiff(view);
      if (state.visible) render();
      return;
    }
    const scope = view.file ? (view.diffScope || "all") : "all";
    const changeLimit = largeChangeFileLimit();
    const changeCount = changeSetFileCount(view.status || {});
    if (!view.file && changeLimit > 0 && changeCount > changeLimit && !view.loadLargeChangeSet) {
      view.diff = { files: [], skipped_large_change_set: true, file_count: changeCount, file_limit: changeLimit };
      view.diffSignature = diffSignatureFor(view);
      if (state.visible) render();
      return;
    }
    const url = `/api/git-ui/diff?cwd=${encodeURIComponent(view.cwd)}&scope=${encodeURIComponent(scope)}&context=${context}` + (view.file ? `&file=${encodeURIComponent(view.file)}` : "");
    view.diff = await api(url);
    view.diffSignature = diffSignatureFor(view);
    saveFocusedDiff(view);
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

  // The toggle row highlights the view the pane tree actually renders, not
  // the workspace view state: focus buttons light up when their tab is
  // active, whatever the shared view state last held. Falls back to the
  // view tab when no pane tree is mounted (standalone harnesses).
  function activeToggleKind() {
    const panes = window.HerdrWorkspacePanes;
    if (panes && panes.paneActiveTab && panes.isGitTab && panes.gitTabViewKey) {
      const tabId = panes.paneActiveTab();
      if (panes.isGitTab(tabId)) {
        const key = panes.gitTabViewKey(tabId);
        if (key === "changes") return "changes";
        if (key === "log" || key === "stash" || key === "cleanup" || key === "conflicts") return key;
        // Focused views (history@, diff@, compare@) render inside the
        // changes view state, so the changes button stays lit.
        return "changes";
      }
    }
    return (active() || {}).tab || "changes";
  }

  function compareRefLabel(ref) {
    const value = String(ref || "").trim();
    if (!value || value === ".") return "working tree";
    return value;
  }

  function preserveContentScroll(tab) {
    return tab === "cleanup" || tab === "log" || tab === "stash";
  }

  // Snap the live content scroll before a re-render wipes it, so the
  // restore below can put it back. Runs on every render, covering menu
  // opens, selections, toasts, anything that re-renders while the user
  // scrolled. Views that do not preserve scroll keep their 0 default.
  function captureContentScroll(view) {
    if (!view || !preserveContentScroll(view.tab)) return;
    const container = gitMainContainer() || ensurePanel();
    const content = container && container.querySelector(".git-ui-content");
    if (content) view.contentScrollTop = content.scrollTop || 0;
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
    // Scroll capture must precede every innerHTML write below: the menu
    // open path sets state then re-renders, and the content node the
    // restore reads from is wiped a few lines down.
    captureContentScroll(activeView);
    const version = ++state.renderVersion;
    const panel = ensurePanel();
    panel.classList.toggle("mutating", !!activeView.mutating);
    // The git panel has one desktop surface: hosted in the right sidebar
    // column (Phase 3c). The side column renders the status sections; the
    // center pane tab owns the main view markup. Overlays (menus, modals,
    // toasts) are position: fixed, so they render from the panel host.
    const container = gitMainContainer();
    if (container) {
      panel.innerHTML = renderSide() + renderContextMenu() + renderLogContextMenu() + renderHeaderMenu() + renderBranchList() + renderCommitModal() + renderCompareSelectedModal() + renderResetSelectedModal() + renderTagSelectedModal() + renderBranchModal() + renderGitOpModal() + renderCleanupConfirm() + renderGitToast() + renderScopeCopyToast();
      const side = panel.querySelector(".git-ui-side");
      if (side) side.scrollTop = state.sideScrollTop || 0;
      if (window.HerdrRightSidebar) window.HerdrRightSidebar.afterDrawerRender();
      focusDiffSearchIfNeeded();
      renderMainIntoTab(version, container);
      return;
    }
    // Hosted with no center git tab (fresh rail click): the sidebar column
    // carries the status side alone, Phase 3b parity. The full diff would
    // break in the narrow column; a view toggle or status row opens the
    // center tab on demand. Overlays still render from the panel host.
    if (panelIsHosted()) {
      panel.innerHTML = renderSide() + renderContextMenu() + renderLogContextMenu() + renderHeaderMenu() + renderBranchList() + renderCommitModal() + renderCompareSelectedModal() + renderResetSelectedModal() + renderTagSelectedModal() + renderBranchModal() + renderGitOpModal() + renderCleanupConfirm() + renderGitToast() + renderScopeCopyToast();
      const side = panel.querySelector(".git-ui-side");
      if (side) side.scrollTop = state.sideScrollTop || 0;
      if (window.HerdrRightSidebar) window.HerdrRightSidebar.afterDrawerRender();
      focusDiffSearchIfNeeded();
      return;
    }
    // Standalone harness fallback: one panel holds side + main + overlays,
    // the Phase 2 single-surface contract behavioral tests assert on.
    panel.innerHTML = renderSide() + `<div class="git-ui-panel-main">${renderMain()}</div>` + renderContextMenu() + renderLogContextMenu() + renderHeaderMenu() + renderBranchList() + renderCommitModal() + renderCompareSelectedModal() + renderResetSelectedModal() + renderTagSelectedModal() + renderBranchModal() + renderGitOpModal() + renderCleanupConfirm() + renderGitToast() + renderScopeCopyToast();
    const side = panel.querySelector(".git-ui-side");
    if (side) side.scrollTop = state.sideScrollTop || 0;
    const nextContent = panel.querySelector(".git-ui-content");
    if (nextContent && preserveContentScroll(activeView.tab))
      nextContent.scrollTop = activeView.contentScrollTop || 0;
    setupDiffHunkScrollbars(panel);
    mountSideEditors();
    if (activeView.tab === "log") renderLog(version).catch((e) => { activeView.error = e.message; render(); });
    if (activeView.tab === "stash") renderStash(version).catch((e) => { activeView.error = e.message; render(); });
    if (activeView.tab === "history") renderHistory().then((html) => replaceContent(version, html)).catch((e) => { activeView.error = e.message; render(); });
    if (window.HerdrRightSidebar) window.HerdrRightSidebar.afterDrawerRender();
    focusDiffSearchIfNeeded();
  }

  // Phase 3c: the center git tab's container hosts renderMain. The pane
  // tree tells git_ui which view-key is active; the container is created
  // by workspace_panes (createElement contract) and git_ui only fills it.
  // Without a pane tree (standalone harnesses), renderMain falls back to
  // the panel host so behavioral tests keep a single surface to assert on.
  function gitMainContainer() {
    const viewKey = activeMainViewKey();
    if (!viewKey) return null;
    const panes = window.HerdrWorkspacePanes;
    if (!panes || !panes.paneGitMountId) return null;
    return document.getElementById(panes.paneGitMountId(viewKey));
  }

  function activeMainViewKey() {
    const view = active() || {};
    const panes = window.HerdrWorkspacePanes;
    const activeTab = panes && panes.paneActiveTab ? panes.paneActiveTab() : "";
    if (panes && panes.isGitTab && panes.isGitTab(activeTab)) return panes.gitTabViewKey(activeTab);
    return mainViewKeyFor(view);
  }

  // Maps the current view state to the center tab view-key. changes and
  // the per-file variants all ride the changes tab; log/stash/cleanup/
  // conflicts/history map 1:1.
  function mainViewKeyFor(view) {
    if (!view) return "";
    if (view.tab === "log") return "log";
    if (view.tab === "stash") return "stash";
    if (view.tab === "cleanup") return "cleanup";
    if (view.tab === "conflicts") return "conflicts";
    if (view.tab === "history") return view.file ? `history@${view.file}` : "history";
    if (view.mode === "readonly-compare" || view.mode === "current-compare") {
      const base = view.compareBase || "";
      // The against-working-tree compare owns the compare@<hash>..current
      // tab ("current" spells "." in the API); every other compare rides
      // compare@<base>..<target>.
      if (view.mode === "current-compare") return base ? `compare@${base}..current` : "changes";
      const target = view.compareTarget || "";
      return base || target ? `compare@${base}..${target}` : "changes";
    }
    return "changes";
  }

  // Snapshot-shaped mainViewKeyFor: navigation snapshots carry the same
  // tab/mode/file fields as the live view, so the goBack restore can pick
  // its center tab before the state lands.
  function mainViewKeyForCapture(view, snapshot) {
    return mainViewKeyFor(snapshot || view);
  }

  function renderMainIntoTab(version, container) {
    const view = active() || {};
    if (!container) return;
    container.innerHTML = renderMain();
    const nextContent = container.querySelector(".git-ui-content");
    if (nextContent && preserveContentScroll(view.tab))
      nextContent.scrollTop = view.contentScrollTop || 0;
    setupDiffHunkScrollbars(container);
    mountSideEditors();
    if (view.tab === "log") renderLog(version).catch((e) => { view.error = e.message; render(); });
    if (view.tab === "stash") renderStash(version).catch((e) => { view.error = e.message; render(); });
    if (view.tab === "history") renderHistory().then((html) => replaceContent(version, html)).catch((e) => { view.error = e.message; render(); });
  }

  function replaceContent(version, html) {
    if (!state.visible || version !== state.renderVersion) return;
    // The main content lives in the center git tab's container when the
    // pane tree is active, else in the panel fallback host.
    const container = gitMainContainer();
    const content = (container || ensurePanel()).querySelector(".git-ui-content");
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
    openViewTab,
    releaseViewTab,
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
    // Background prober for the rail tint: fetches /api/git-ui/status for
    // the workspace cwd into the view cache WITHOUT opening the drawer
    // (render stays untouched when the drawer is hidden). The shell calls
    // this per selected workspace; workspaceStatus then tints the rail.
    async probeWorkspaceStatus(workspace) {
      const key = workspaceKey(workspace);
      const cwd = workspaceCwd(workspace);
      if (!key || !cwd) return;
      let view = state.cache[key];
      if (!view) {
        // cwd/workspaceCwd match open()'s view shape so the landing guards
        // can tell a same-folder probe from one made stale by a worktree
        // switch, and so open() keeps its existing cwd-update semantics.
        view = { loading: false, tab: "changes", mode: "changes", file: "", navigationStack: [], cwd, workspaceCwd: cwd };
        state.cache[key] = view;
      }
      // The __probed skip is only valid while the parked status still
      // describes this folder. A default-folder change (settings) or a
      // worktree switch can leave the park on the old cwd; the stale park
      // (e.g. nogit) would then pin the rail disabled forever, because the
      // disabled button blocks the open() that would refresh the view.
      // Re-point the view and drop the stale park so this probe refetches;
      // open() treats a statusless view as unloaded and does the real load.
      if (view.status && view.status.__probed
        && (!samePath(view.workspaceCwd || "", cwd) || (view.cwd && !samePath(view.cwd, cwd)))) {
        view.cwd = cwd;
        view.workspaceCwd = cwd;
        view.status = null;
        view.error = "";
      }
      if (!view.status || !view.status.__probed) {
        // The fetch is async: the drawer may have opened (refresh loaded a
        // full status) or the cwd may have changed (worktree switch) while
        // it was in flight. Either way the probe is now stale. Park only
        // when the view is still probe-only and points at the same folder:
        // overwriting a real load would stale the cache, re-mark
        // __probedOnly (redundant reload on next open), or park the old
        // folder's result into the new folder's view (wrong tint).
        const probeCwd = cwd;
        const landedUnloaded = () => !view.status || view.status.__probedOnly;
        const landedSameFolder = () => view.workspaceCwd === probeCwd && samePath(view.cwd || "", probeCwd);
        let parked = false;
        try {
          const status = await api(`/api/git-ui/status?cwd=${encodeURIComponent(probeCwd)}`);
          // __probedOnly: this status only warms the rail tint. It never went
          // through refresh(), so open() must still do the real load (status
          // + diff) when the drawer actually opens.
          if (!landedUnloaded() || !landedSameFolder()) return;
          view.status = Object.assign({}, status, { __probed: true, __probedOnly: true });
          // A probe that proves this cwd serves status also clears any error
          // parked earlier (nogit probe, failed refresh): workspaceStatus
          // reads view.error before the status, a stale error would keep the
          // rail on nogit even with a repo status parked. A non-git folder
          // answers a not_git_repository payload here (not an error), so the
          // park carries the nogit marker and the tint reads it below.
          view.error = "";
          parked = true;
        } catch (err) {
          if (isNotGitRepositoryMessage(err && err.message)) {
            // Same landing guard as the success path.
            if (landedUnloaded() && landedSameFolder()) {
              view.error = err.message;
              // Park the probe result so a non-git folder is not refetched on
              // every shell render: the failure is permanent until something
              // calls refresh() (which clears the error and marks the view).
              view.status = Object.assign({}, view.status, { __probed: true, __probedOnly: true });
              parked = true;
            }
          }
          // A parked failure changed the rail inputs (nogit tint); sync it.
          // Unparked errors (transient network failure) leave the rail alone.
          if (!parked) return;
        }
        if (parked && window.syncGitWorkspaceToggle) window.syncGitWorkspaceToggle();
        else if (parked && state.visible) render();
      }
    },
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
      // Phase 3c: the toggle row switches the center git tab. The pane
      // tree owns the tab id; git_ui applies the view state and renders
      // into the tab container.
      const panes = window.HerdrWorkspacePanes;
      if (panes && panes.openGitTab) void panes.openGitTab(tab);
      else { active().tab = tab; render(); }
    },
    showChangesList(options) {
      const view = active();
      if (!view) return;
      if (isNoGitRepositoryView(view)) {
        view.tab = "cleanup";
        render();
        return;
      }
      // The changes toggle is a focus button: when the changes tab already
      // renders in the pane tree, the click only focuses it (no state
      // reset), matching log/stash/cleanup. Only a fresh open (or an
      // explicit request, e.g. the return-to-current-changes icon) resets
      // the focused file and compare state.
      const panes = window.HerdrWorkspacePanes;
      const focused = !!(panes && panes.paneActiveTab && panes.isGitTab
        && panes.isGitTab(panes.paneActiveTab())
        && panes.gitTabViewKey(panes.paneActiveTab()) === "changes");
      if (focused && !(options && options.forceReset)) {
        if (panes && panes.openGitTab) void panes.openGitTab("changes");
        else render();
        return;
      }
      resetToChangesMode(view);
      view.navigationStack = [];
      view.sideEditor = null;
      view.file = "";
      view.diffKind = "";
      view.diffScope = "all";
      view.logFilePath = "";
      view.tab = "changes";
      loadDiff().catch((e) => { view.error = e.message; render(); });
      if (panes && panes.openGitTab) void panes.openGitTab("changes");
    },
    selectFile(file, kind) {
      const view = active();
      const path = decodeURIComponent(file);
      view.file = path;
      view.diffKind = kind || "";
      view.expandedCompactDirs = {};
      if (view.sideEditor && view.sideEditor.path !== path) view.sideEditor = null;
      const panes = window.HerdrWorkspacePanes;
      const scrollAfter = (pending) => {
        void Promise.resolve(pending).then(() => requestAnimationFrame(() => scrollToDiffFile(view.file)))
          .catch(() => {});
      };
      // Phase 3c: a status row click opens/focuses the file's diff in the
      // center changes tab (m2 contract). The pane tree owns the tab id;
      // git_ui keeps the focused-file state on the workspace view. The
      // focused fetch itself rides openViewTab's signature check: the
      // file/scope change makes the loaded diff stale, so the open
      // refetches; re-focusing the same file keeps the loaded diff.
      if (panes && panes.openGitTab) {
        // A file from a commit preview (log/history "Committed files")
        // focuses inside that commit's compare tab, not a working-tree
        // diff tab.
        if (kind === "C" && view.selectedCommitPreview && view.selectedCommitPreview.hash) {
          const hash = view.selectedCommitPreview.hash;
          if (!view.committedFile) pushNavigationSnapshot(view);
          view.mode = "readonly-compare";
          view.compareBase = `${hash}^`;
          view.compareTarget = hash;
          view.committedFile = { hash, from: view.tab === "history" ? "history" : "log" };
          view.compareFilePaths = ((view.selectedCommitPreview.diff && view.selectedCommitPreview.diff.files) || []).map((file) => file.path);
          view.tab = "changes";
          scrollAfter(panes.openGitTab(mainViewKeyFor(view)));
          return;
        }
        // A file from the "Compared" section focuses inside the compare
        // the user is already looking at; the working-tree per-file tab
        // would reset the compare and answer a different question.
        if (currentMode() !== "changes") {
          scrollAfter(panes.openGitTab(mainViewKeyFor(view)));
          return;
        }
        view.diffScope = kind === "S" ? "staged" : kind === "M" || kind === "?" ? "working" : "all";
        scrollAfter(panes.openGitTab(`diff@${path}`));
        return;
      }
      if (kind === "C" && view.selectedCommitPreview && view.selectedCommitPreview.hash) {
        const hash = view.selectedCommitPreview.hash;
        if (!view.committedFile) pushNavigationSnapshot(view);
        view.mode = "readonly-compare";
        view.compareBase = `${hash}^`;
        view.compareTarget = hash;
        view.committedFile = { hash, from: view.tab === "history" ? "history" : "log" };
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
            if (window.rememberWorkspaceShellMode) window.rememberWorkspaceShellMode("files", state.ws);
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
      // Phase 3c: stash bodies render in the center stash tab. Selecting
      // a stash from the sidebar always focuses that tab; openGitTab is a
      // no-op re-activate when the stash tab is already active, and
      // openViewTab keeps the selected-stash state (only the tab field
      // moves), so the body load below still runs.
      const panes = window.HerdrWorkspacePanes;
      if (panes && panes.openGitTab) {
        void panes.openGitTab("stash");
        return;
      }
      view.tab = "stash";
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
    // Path title entry: opens the directory picker on the current Git folder.
    // The picker writes into a hidden input node and applies the selected
    // folder immediately, so no extra modal input has to live in the panel.
    openCwdPicker() {
      const view = active();
      if (!view) return;
      const picker = window.HerdrDirectoryPicker;
      if (!picker || typeof picker.open !== "function") return;
      const input = document.createElement("input");
      input.type = "text";
      input.style.display = "none";
      input.value = String(view.cwd || "");
      let closed = false;
      const onChange = () => {
        closed = true;
        cleanup();
        const cwd = normalizePathForCompare(input.value || "");
        if (!cwd) return;
        if (samePath(cwd, view.cwd)) return;
        resetGitViewForCwd(view, cwd);
        render();
        refresh();
      };
      function cleanup() {
        input.removeEventListener("change", onChange);
        if (input.parentNode) input.parentNode.removeChild(input);
      }
      input.addEventListener("change", onChange);
      document.body.appendChild(input);
      picker.open(input);
      // The picker close path (Close button) has no callback: poll for the
      // modal disappearing. selectCurrent() dispatches change before close,
      // so the change path wins; only a removal without change cleans up.
      const poll = (attempt) => {
        if (closed) return;
        if (!document.getElementById("directoryPickerModal")) {
          cleanup();
          return;
        }
        if (attempt > 600) {
          // Long picker session: keep the change listener armed so a late
          // Select still applies, just stop polling.
          return;
        }
        requestAnimationFrame(() => poll(attempt + 1));
      };
      poll(0);
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
      clearHistoryCompareState(view);
      view.tab = "changes";
      // Phase 3c: a commit-pair compare rides its own center compare
      // tab, same as showHistoryCommit. Without this the pane tree keeps
      // the old tab active while the view state renders a compare.
      const panes = window.HerdrWorkspacePanes;
      if (panes && panes.openGitTab) { await panes.openGitTab(`compare@${base}..${target}`); return; }
      await loadDiff();
    },
    async showHistoryCommit(hash) {
      hash = decodeURIComponent(hash);
      const view = active();
      if (!view || !hash) return;
      pushNavigationSnapshot(view);
      startHistoryCommitCompare(view, hash);
      // Phase 3c: a commit compare from history/log rides the compare
      // center tab.
      const panes = window.HerdrWorkspacePanes;
      if (panes && panes.openGitTab) { await panes.openGitTab(`compare@${view.compareBase}..${view.compareTarget}`); return; }
      view.tab = "changes";
      await loadDiff();
    },
    gotoLogCommit(hash) {
      hash = decodeURIComponent(hash);
      const view = active();
      if (!view || !hash) return;
      pushNavigationSnapshot(view);
      view.pendingLogScrollHash = hash;
      // Jumping from the file history keeps the file scope so the log answers
      // "history of this file", matching how the user arrived here.
      if (view.file) view.logFilePath = view.file;
      view.logAll = true;
      view.logScope = "all";
      // Phase 3c: the log center tab carries the jump.
      const panes = window.HerdrWorkspacePanes;
      if (panes && panes.openGitTab) void panes.openGitTab("log");
      else { view.tab = "log"; render(); }
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
        await open({ workspace_id: workspaceKey({ cwd }), cwd, label: compactPath(cwd) }, { forceOpen: true });
      }
      const view = active();
      if (!view) return;
      if (state.visible) pushNavigationSnapshot(view);
      view.file = path;
      view.diffKind = "";
      resetToChangesMode(view);
      // Phase 3c: file history opens as its own center git tab.
      const panes = window.HerdrWorkspacePanes;
      if (panes && panes.openGitTab) await panes.openGitTab(`history@${path}`);
      else { view.tab = "history"; render(); }
    },
    clearLogFileHistory() {
      const view = active();
      if (!view) return;
      view.logFilePath = "";
      view.logLimit = GIT_LOG_PAGE_SIZE;
      render();
    },
    latestChanges() {
      // Explicit return-to-current-changes: always reset the compare state,
      // even when the changes tab is already focused.
      this.showChangesList({ forceReset: true });
    },
    async goBack() {
      const view = active();
      if (!view || !(view.navigationStack || []).length) {
        this.showChangesList();
        return;
      }
      const snapshot = view.navigationStack.pop();
      // Phase 3c: the snapshot may land on a different center git tab
      // (history → changes, log → file history). Routing the restore
      // through openGitTab keeps the strip highlight and the pane tree's
      // active pointer on the tab the restored view actually renders.
      const panes = window.HerdrWorkspacePanes;
      if (panes && panes.openGitTab) {
        const apply = () => restoreNavigationSnapshot(view, snapshot);
        // applyViewKeyToState inside openViewTab runs first; the snapshot
        // restore then overwrites the full state before the render.
        const pending = panes.openGitTab(mainViewKeyForCapture(view, snapshot));
        void pending.then(apply).catch(apply);
        return;
      }
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
      clearHistoryCompareState(view);
      view.tab = "changes";
      // Same tab contract as commit-pair compares: the against-working-tree
      // compare rides its own center tab (compare@<hash>..current) so the
      // strip names it and re-clicking focuses instead of mutating the
      // shared changes tab in place.
      const panes = window.HerdrWorkspacePanes;
      if (panes && panes.openGitTab) { await panes.openGitTab(`compare@${hash}..current`); return; }
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
