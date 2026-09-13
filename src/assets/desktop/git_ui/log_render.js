(function () {
  function createGitUiLogRender({active, api, esc, arg, gitLogDefaultBranch, normalizeLogScope, GIT_LOG_PAGE_SIZE, GIT_LOG_MAX_LIMIT, isNoGitRepositoryView, renderFileToolbar, renderCleanup, renderStashDiff, renderConflictResolutionButtons, renderDiff, replaceContent, render}) {
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
    return {
      renderLog,
      updateGitLogStickyOffsets,
      renderHistory,
      renderConflictOperationActions,
      renderConflicts,
      renderMain,
    };
  }
  globalThis.HerdrGitUiLogRenderModule = { create: createGitUiLogRender };
})();
