(function () {
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  window.HerdrGitActions = {
    selectedLogToolbar(selected, options) {
      selected = selected || [];
      options = options || {};
      if (!selected.length) return `<span class="git-ui-muted">Click a commit to select. Shift-click two commits to compare.</span>`;
      const shortHash = esc(selected[0].slice(0, 12));
      const selectedLabel = `<span class="git-ui-muted">Selected ${shortHash}</span><span class="git-ui-log-actions-separator"></span>`;
      const compare = selected.length === 1 ? "Compare" : "Compare selected";
      const tag = selected.length === 1 ? `<button class="git-ui-btn" onclick="HerdrGitUi.openSelectedTagModal()" title="Create a tag on the selected commit">Tag</button>` : "";
      const branch = selected.length === 1
        ? options.selectedBranch
          ? `<button class="git-ui-btn" onclick="HerdrGitUi.createWorktreeFromSelectedBranch()" title="Create a worktree from ${esc(options.selectedBranch)}">Worktree…</button>`
          : `<button class="git-ui-btn" disabled title="Selected commit has no branch label">Worktree…</button>`
        : "";
      const rewrite = selected.length === 1 && options.allowRewrite
        ? `<button class="git-ui-btn danger" onclick="HerdrGitUi.openSelectedResetModal()" title="Reset current branch to the selected commit">Reset</button><button class="git-ui-btn" onclick="HerdrGitUi.rebaseAfterSelected()" title="Rebase current changes over the selected commit">Rebase…</button>`
        : "";
      return `${selectedLabel}<button class="git-ui-btn active" onclick="HerdrGitUi.compareSelectedLog()">${compare}</button>${tag}${branch}${rewrite}<button class="git-ui-btn" onclick="HerdrGitUi.clearLogSelection()">Clear</button>`;
    },
  };
})();
