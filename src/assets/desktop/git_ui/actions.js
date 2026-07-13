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
      const compare = selected.length === 1 ? "Compare with current changes" : "Compare selected";
      const rewrite = selected.length === 1 && options.allowRewrite
        ? `<span class="git-ui-log-actions-separator"></span><span class="git-ui-muted">Selected ${shortHash}</span><button class="git-ui-btn danger" onclick="HerdrGitUi.openSelectedResetModal()">Reset</button><button class="git-ui-btn" onclick="HerdrGitUi.rebaseAfterSelected()">Rebase current changes over selected commit</button>`
        : "";
      return `<button class="git-ui-btn active" onclick="HerdrGitUi.compareSelectedLog()">${compare}</button><button class="git-ui-btn" onclick="HerdrGitUi.clearLogSelection()">Clear</button>${rewrite}`;
    },
  };
})();
