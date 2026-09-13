(function () {
  function createGitUiDiffView({state, active, currentMode, compareRefLabel, isNoGitRepositoryView, diffFile, diffFileKey, diffFileLineCount, diffLineCount, largeDiffLineLimit, loadedLargeDiffPreviewLimit, previewDiffFile, diffLayoutMode, hashText, esc, arg, canSearchDiff, diffSearchMatchCount, LARGE_FILE_DIFF_LINE_LIMIT, renderNavigationTrail, titleWithGitShortcut, renderDiffConflictResolutionButtons, renderSideEditor, ensureBlame, renderChunk, stashCount, canOpenStashView, section, commitPreviewSection, stashListHtml, stashFileSection, renderGitViewTabs, hasStagedChanges, filterFiles, sideFileCount, renderWorktreeActions, renderGitLocationSelector, renderDirContextMenu, gitCwdMatchesWorkspace, compactPath, appRefreshIconButton}) {
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
    return {
      canMutateDiff,
      allFiles,
      renderContextMenu,
      renderLogContextMenu,
      historicalFileCommitLabel,
      clearHistoryCompareState,
      resetToChangesMode,
      startHistoryCommitCompare,
      fileViewStateLabel,
      fileToolbarBackButton,
      renderSide,
      renderDiffLayoutSideToggle,
      renderFileToolbar,
      renderDiffSearchControl,
      canEditCurrentFile,
      renderDiff,
      largeChangeDiffShells,
      largeChangeFileItems,
      largeChangeHiddenFile,
      renderDiffFile,
      renderDiffFileBody,
      fileDiffLeftLabel,
      renderLargeChangePlaceholder,
      renderLargeDiffPlaceholder,
      scrollToDiffFile,
    };
  }
  globalThis.HerdrGitUiDiffViewModule = { create: createGitUiDiffView };
})();
