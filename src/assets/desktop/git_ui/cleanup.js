(function () {
  function createGitUiCleanup({ active, esc, arg, treeIcon, compactPath, api }) {
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

    function cleanupDefaultBranch(branch) {
      return branch === "main" || branch === "master";
    }

    function cleanupBranchSelectable(branch) {
      return !(branch.current && cleanupDefaultBranch(branch.name));
    }

    function cleanupPushedLabel(value) {
      if (value === true) return "pushed before";
      if (value === false) return "not pushed";
      return "push status unknown";
    }

    function renderCleanupGroupTitle(repoIndex, type, label) {
      const items = cleanupRepoItems(repoIndex, type);
      const state = cleanupSelectionState(items);
      return `<label class="git-ui-cleanup-group-title"><input type="checkbox" data-state="${state}" onchange="HerdrGitUi.toggleCleanupGroup('${repoIndex}','${type}',this.checked)" ${state === "checked" ? "checked" : ""} ${items.length ? "" : "disabled"}><span>${esc(label)}</span></label>`;
    }

    function renderCleanupBranch(repoIndex, branch) {
      const disabled = cleanupBranchSelectable(branch) ? "" : "disabled";
      const key = cleanupItemKey("branch", repoIndex, branch.name);
      const checked = cleanupSelected(key) ? "checked" : "";
      const current = branch.current
        ? cleanupDefaultBranch(branch.name) ? "current main/master" : "current · will checkout main/master first"
        : "";
      const meta = [current, branch.checked_out ? "checked out" : "", cleanupPushedLabel(branch.pushed)].filter(Boolean).join(" · ");
      return `<label class="git-ui-cleanup-row"><input type="checkbox" onchange="HerdrGitUi.toggleCleanupSelection('${arg(key)}',this.checked)" ${checked} ${disabled}><span class="git-ui-cleanup-indent"></span><span><strong>${esc(branch.name)}</strong>${meta ? `<small>${esc(meta)}</small>` : ""}</span></label>`;
    }

    function renderCleanupWorktree(repoIndex, index, worktree) {
      const meta = [worktree.branch || (worktree.detached ? "detached" : ""), worktree.prunable ? "prunable" : "", worktree.primary ? "primary" : "", cleanupPushedLabel(worktree.pushed)].filter(Boolean).join(" · ");
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
          if (cleanupBranchSelectable(branch)) items.push({ type: "branch", repo: repo.path, name: branch.name, key: `branch|${repo.path}|${branch.name}` });
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
          if (cleanupBranchSelectable(branch)) items.push({ type: "branch", repo: repo.path, name: branch.name, key: `branch|${repo.path}|${branch.name}` });
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

    return {
      renderCleanup,
      renderCleanupRepo,
      cleanupVisibleBranches,
      cleanupDefaultBranch,
      cleanupBranchSelectable,
      cleanupPushedLabel,
      renderCleanupGroupTitle,
      renderCleanupBranch,
      renderCleanupWorktree,
      cleanupItemKey,
      cleanupSelected,
      cleanupSelectionState,
      cleanupSelectableItems,
      cleanupRepoItems,
      cleanupSelectedItems,
      cleanupItemLabel,
      deleteCleanupItem,
      cleanupForceRetryLikelyNeeded,
    };
  }

  globalThis.HerdrGitUiCleanupModule = { create: createGitUiCleanup };
})();