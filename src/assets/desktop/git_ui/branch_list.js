(function () {
  function createGitUiBranchList({ state, esc }) {
      // ── Worktree actions row (Zed-style selector rework) ─────────────────
      // Commit button left-justified. Status split button right-justified:
      // Pull ↓N when behind, Push ↑N when ahead, plain Fetch when in sync;
      // the ▾ triangle opens the git-flow menu.
      function renderWorktreeActions(ctx) {
        const s = ctx.s || {};
        const esc = ctx.esc;
        const commitHint = ctx.commitHint || "Commit";
        const commitDisabled = ctx.commitDisabled || "";
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
        return `<div class="git-ui-toolbar git-ui-worktree-row"><div class="git-ui-actions git-ui-worktree-left"><button class="git-ui-btn primary" title="${esc(commitHint)}" onclick="HerdrGitUi.openCommitModal()"${commitDisabled}>Commit</button></div><div class="git-ui-actions git-ui-worktree-right">${statusButton}${statusCaret}</div></div>`;
      }

      // Dropdown next to the status button, exactly seven items: Fetch /
      // Fetch From / Pull / Pull (rebase) / Push / Push to / Force push.
      function renderHeaderMenu() {
        const menu = state.headerMenu;
        if (!menu) return "";
        const item = (label, method, hint) => `<button onclick="HerdrGitUi.${method}()">${esc(label)}${hint ? `<span class="git-ui-menu-hint">${esc(hint)}</span>` : ""}</button>`;
        return `<div class="git-ui-menu git-ui-header-menu" style="left:${Math.max(0, menu.x)}px;top:${Math.max(0, menu.y)}px" onclick="event.stopPropagation()">${item("Fetch", "fetchOrigin", "git fetch origin")}${item("Fetch From", "openFetchFromModal", "choose a branch")}${item("Pull", "openPullModal", "opens pull options")}${item("Pull (rebase)", "pullWithRebase", "git pull --rebase")}${item("Push", "openPushModal", "opens push options")}${item("Push to", "openPushToModal", "choose a branch")}${item("Force push", "openForcePushModal", "force-with-lease first")}</div>`;
      }

    return {
      renderWorktreeActions,
      renderHeaderMenu,
    };
  }

  globalThis.HerdrGitUiBranchListModule = { create: createGitUiBranchList };
})();
