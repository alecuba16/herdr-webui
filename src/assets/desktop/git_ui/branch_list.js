(function () {
  function createGitUiBranchList({ state, esc, arg, titleWithGitShortcut, samePath, compactPath, pathBasename, gitRemoteBranchPreload }) {
      // ── Worktree actions row (Zed-style selector rework) ─────────────────
      // Branch chip left-justified next to Commit: just the name (opens the
      // branch list popover). Status split button right-justified: Pull ↓N
      // when behind, Push ↑N when ahead, plain Fetch when in sync; the ▾
      // triangle opens the git-flow menu.
      function renderWorktreeActions(ctx) {
        const s = ctx.s || {};
        const esc = ctx.esc;
        const commitHint = ctx.commitHint || "Commit";
        const commitDisabled = ctx.commitDisabled || "";
        const branch = String(s.branch || "");
        const ahead = Number(s.ahead) || 0;
        const behind = Number(s.behind) || 0;
        const upstream = String(s.upstream || "").trim();
        // Status label mirrors the sync state: incoming → Pull ↓N, outgoing →
        // Push ↑N, otherwise plain Fetch with no arrows or counts.
        let statusMethod = "fetchOrigin";
        let statusLabel = "Fetch";
        let statusHint = "git fetch origin";
        if (upstream && behind > 0) {
          statusMethod = "pullUpdateFromUpstream";
          statusLabel = `Pull ↓${behind}`;
          statusHint = "Fetch and fast-forward from the upstream (never creates a merge commit)";
        } else if (upstream && ahead > 0) {
          statusMethod = "pushNow";
          statusLabel = `Push ↑${ahead}`;
          statusHint = "Push local commits to the upstream";
        }
        const menuOpen = state.headerMenu ? "true" : "false";
        const statusButton = `<button class="git-ui-btn git-ui-status-label" data-method="${esc(statusMethod)}" title="${esc(statusHint)}" onclick="HerdrGitUi.runStatusAction()">${esc(statusLabel)}</button>`;
        const statusCaret = `<button class="git-ui-btn git-ui-status-caret" title="Pull, fetch and push options" aria-haspopup="menu" aria-expanded="${menuOpen}" onclick="HerdrGitUi.toggleHeaderMenu(event)"><b class="git-ui-chip-caret">▾</b></button>`;
        return `<div class="git-ui-toolbar git-ui-worktree-row"><div class="git-ui-actions git-ui-worktree-left"><button class="git-ui-btn primary" title="${esc(commitHint)}" onclick="HerdrGitUi.openCommitModal()"${commitDisabled}>Commit</button></div><div class="git-ui-actions git-ui-worktree-right">${statusButton}${statusCaret}</div></div>${renderWorktreeList()}`;
      }

      function renderGitLocationSelector(ctx) {
        const s = ctx.s || {};
        const esc = ctx.esc;
        const worktreeName = String(ctx.worktreeName || pathBasename(ctx.cwd || "") || "worktree");
        const branch = String(s.branch || "");
        const worktreeChip = `<button class="git-ui-branch-chip git-ui-worktree-chip" title="Choose worktree" onclick="HerdrGitUi.openWorktreeList(event)"><span class="git-ui-branch-chip-name">${esc(worktreeName)}</span><b class="git-ui-chip-caret">▾</b></button>`;
        const branchChip = branch ? `<button class="git-ui-branch-chip" title="${esc(titleWithGitShortcut("Switch branch", "branch"))}" onclick="HerdrGitUi.openBranchList(event)"><span class="git-ui-branch-chip-name">${esc(branch)}</span><b class="git-ui-chip-caret">▾</b></button>` : "";
        const folderDiffers = ctx.workspaceCwd && !samePath(ctx.cwd, ctx.workspaceCwd);
        const pathNotice = folderDiffers ? `<span class="git-ui-folder-different" title="Git is operating in a different folder than the current workspace: ${esc(ctx.cwd)}">${esc(compactPath(ctx.cwd))}</span><button class="git-ui-btn git-ui-return-cwd" title="Return Git to the current workspace folder" onclick="HerdrGitUi.returnToWorkspaceCwd()">↩</button>` : "";
        return `${worktreeChip}<span class="git-ui-selector-separator">/</span>${branchChip}${pathNotice}`;
      }

      function renderWorktreeList() {
        const list = state.worktreeList;
        if (!list) return "";
        if (list.loading) return `<div class="git-ui-branch-list git-ui-worktree-list" onclick="event.stopPropagation()"><div class="git-ui-loading"><span></span><strong>Loading worktrees</strong></div></div>`;
        if (list.error) return `<div class="git-ui-branch-list git-ui-worktree-list" onclick="event.stopPropagation()"><div class="git-ui-error">${esc(list.error)}</div></div>`;
        const rows = (list.worktrees || []).map((wt) => {
          const current = samePath(wt.path, list.currentPath);
          return `<button class="git-ui-worktree-option${current ? " current" : ""}" onclick="HerdrGitUi.selectWorktree('${arg(wt.path)}')"><strong>${current ? `<b class="git-ui-worktree-check" title="Current worktree">✓</b>` : ""}${esc(wt.label || pathBasename(wt.path))}</strong><small>${esc(wt.branch || "detached")} · ${esc(wt.path)}</small></button>`;
        }).join("");
        return `<div class="git-ui-branch-list git-ui-worktree-list" onclick="event.stopPropagation()">${rows || `<div class="git-ui-muted git-ui-branch-list-empty">No worktrees detected</div>`}<button class="git-ui-worktree-create" onclick="HerdrGitUi.createWorktreeFromSelector()">＋ Create worktree</button></div>`;
      }

      // Dropdown next to the status button, exactly seven items: Fetch /
      // Fetch From / Pull / Pull (rebase) / Push / Push to / Force push.
      function renderHeaderMenu() {
        const menu = state.headerMenu;
        if (!menu) return "";
        const item = (label, method, hint) => `<button onclick="HerdrGitUi.${method}()">${esc(label)}${hint ? `<span class="git-ui-menu-hint">${esc(hint)}</span>` : ""}</button>`;
        return `<div class="git-ui-menu git-ui-header-menu" style="left:${Math.max(0, menu.x)}px;top:${Math.max(0, menu.y)}px" onclick="event.stopPropagation()">${item("Fetch", "fetchOrigin", "git fetch origin")}${item("Fetch From", "openFetchFromModal", "choose a branch")}${item("Pull", "openPullModal", "opens pull options")}${item("Pull (rebase)", "pullWithRebase", "git pull --rebase")}${item("Push", "openPushModal", "opens push options")}${item("Push to", "openPushToModal", "choose a branch")}${item("Force push", "openForcePushModal", "force-with-lease first")}</div>`;
      }

      // Branch list popover: opens from the branch chip. Local section first
      // (current branch pinned at the top with a ✓), then remote; filterable
      // from the bottom. Each row is two lines: branch name, then author +
      // relative time; hover reveals a trash icon on the right to delete the
      // branch, and the row title carries the exact time and commit subject.
      function branchRelativeTime(isoDate) {
        const then = Date.parse(String(isoDate || ""));
        if (!then || Number.isNaN(then)) return "";
        const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
        if (seconds < 60) return "just now";
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
        const days = Math.floor(hours / 24);
        if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
        const months = Math.floor(days / 30);
        if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
        const years = Math.floor(days / 365);
        return `${years} year${years === 1 ? "" : "s"} ago`;
      }

      function branchListRow(branch, currentBranch) {
        const name = String(branch.name || "");
        const isCurrent = !branch.remote && name === currentBranch;
        const author = String(branch.author || "");
        const date = String(branch.date || "");
        const subject = String(branch.subject || "");
        const exact = date ? new Date(date).toLocaleString() : "";
        const hover = [author && `${author}`, exact, subject && `"${subject}"`].filter(Boolean).join(" · ");
        // Two lines: name line (✓ for the current branch, branch icon
        // otherwise) and a meta line with author + relative time. The trash
        // icon only appears on hover; it stops propagation so the row click
        // (switch) does not fire.
        const icon = isCurrent ? `<b class="git-ui-branch-row-check" title="Current branch">✓</b>` : `<b class="git-ui-branch-row-icon" aria-hidden="true"></b>`;
        const meta = [author, branchRelativeTime(date)].filter(Boolean).join(" · ");
        const trash = isCurrent
          ? "" // deleting the checked-out branch from the list makes no sense
          : `<button class="git-ui-branch-row-trash" title="Delete branch" aria-label="Delete branch ${esc(name)}" onclick="event.stopPropagation();HerdrGitUi.deleteFromBranchList(\'${arg(name)}\',${branch.remote ? "true" : "false"})"><span></span></button>`;
        return `<div class="git-ui-branch-row${isCurrent ? " current" : ""}" title="${esc(hover)}">
          <button class="git-ui-branch-row-main" onclick="HerdrGitUi.switchFromBranchList(\'${arg(name)}\',${branch.remote ? "true" : "false"})">
            <span class="git-ui-branch-row-name">${icon}<span class="git-ui-branch-row-name-text">${esc(name)}</span>${branch.remote ? `<i class="git-ui-branch-row-remote">remote</i>` : ""}</span>
            <span class="git-ui-branch-row-meta">${esc(meta)}</span>
          </button>${trash}
        </div>`;
      }

      function renderBranchList() {
        const list = state.branchList;
        if (!list) return "";
        if (list.loading) return `<div class="git-ui-branch-list" onclick="event.stopPropagation()"><div class="git-ui-loading"><span></span><strong>Loading branches</strong></div></div>`;
        if (list.error) return `<div class="git-ui-branch-list" onclick="event.stopPropagation()"><div class="git-ui-error">${esc(list.error)}</div></div>`;
        const filter = String(list.filter || "").toLowerCase();
        const currentBranch = String(list.currentBranch || "");
        const matches = (branch) => !filter || String(branch.name || "").toLowerCase().includes(filter);
        // Current branch stays pinned at the top of the local section.
        const localAll = (list.local || []).filter(matches);
        const currentRows = localAll.filter((branch) => !branch.remote && branch.name === currentBranch);
        const local = currentRows.concat(localAll.filter((branch) => !currentRows.includes(branch)));
        const remoteAll = (list.remote || []).filter(matches);
        const preferred = (branch) => {
          const name = String(branch.name || "").replace(/^origin\//, "");
          if (name === "main" || name === "master" || name === currentBranch) return 0;
          if (name.startsWith(`${currentBranch}/`) || currentBranch.startsWith(`${name}/`)) return 1;
          return 2;
        };
        const remoteOrdered = remoteAll.slice().sort((left, right) => preferred(left) - preferred(right));
        const remote = list.remoteLoaded ? remoteAll : remoteOrdered.slice(0, gitRemoteBranchPreload());
        const rows = (branches, label) => !branches.length ? "" : `<div class="git-ui-branch-list-section">${label}</div>${branches.map((branch) => branchListRow(branch, currentBranch)).join("")}`;
        const empty = !local.length && !remote.length ? `<div class="git-ui-muted git-ui-branch-list-empty">No branches match</div>` : "";
        // Filter input lives at the bottom, below the scrollable rows, so the
        // list reads top-down like Zed's branch popover.
        const loadingRemote = list.remoteLoading ? `<div class="git-ui-branch-loading">Loading remote branches…</div>` : "";
        const loadMore = !list.remoteLoading && !list.remoteLoaded && remoteAll.length > remote.length
          ? `<button class="git-ui-branch-load-more" onclick="HerdrGitUi.loadMoreBranches()">Load more branches (${remoteAll.length - remote.length} more)</button>`
          : "";
        return `<div class="git-ui-branch-list" onclick="event.stopPropagation()"><div class="git-ui-branch-list-scroll">${rows(local, "Local branches")}${rows(remote, "Remote branches")}${loadingRemote}${loadMore}${empty}</div><label class="git-ui-branch-list-filter"><span>Filter</span><input value="${esc(list.filter || "")}" placeholder="Type to filter" oninput="HerdrGitUi.branchListFilter(this.value)"></label></div>`;
      }

      function refocusBranchFilter(value) {
        requestAnimationFrame(() => {
          const input = document.querySelector(".git-ui-branch-list-filter input");
          if (!input) return;
          input.focus();
          try { input.setSelectionRange(String(value || "").length, String(value || "").length); } catch (_) {}
        });
      }

    return {
      renderWorktreeActions,
      renderGitLocationSelector,
      renderWorktreeList,
      renderHeaderMenu,
      branchRelativeTime,
      branchListRow,
      renderBranchList,
      refocusBranchFilter,
    };
  }

  globalThis.HerdrGitUiBranchListModule = { create: createGitUiBranchList };
})();
