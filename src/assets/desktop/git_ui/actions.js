(function () {
  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  window.HerdrGitActions = {
    selectedLogToolbar(selected) {
      selected = selected || [];
      if (!selected.length) return `<span class="git-ui-muted">Click a commit to select. Shift-click two commits to compare.</span>`;
      const shortHash = esc(selected[0].slice(0, 12));
      const compare = selected.length === 1 ? "Compare with current changes" : "Compare selected";
      const rewrite = selected.length === 1
        ? `<span class="git-ui-log-actions-separator"></span><span class="git-ui-muted">Selected ${shortHash}</span><button class="git-ui-btn" onclick="HerdrGitUi.resetSelected('soft')">Reset soft</button><button class="git-ui-btn danger" onclick="HerdrGitUi.resetSelected('hard')">Reset hard</button><button class="git-ui-btn" onclick="HerdrGitUi.rebaseAfterSelected()">Rebase after selected onto main/master</button>`
        : "";
      return `<button class="git-ui-btn active" onclick="HerdrGitUi.compareSelectedLog()">${compare}</button><button class="git-ui-btn" onclick="HerdrGitUi.clearLogSelection()">Clear</button>${rewrite}`;
    },
  };
})();
