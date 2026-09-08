(function () {
  window.HerdrSettingsModules = window.HerdrSettingsModules || [];
  window.HerdrSettingsModules.push({
    id: "gitUi",
    title: "Git UI",
    desc: "Enable the embedded Git drawer and tune file/diff rendering.",
    defaults: { gitUiEnabled: true, gitUiLargeDiffLineLimit: 2000, gitUiFileListMode: "tree", gitUiDiffLayout: "side-by-side", gitUiDefaultBranch: "master", gitUiRemoteBranchPreload: 10 },
    html: '<label class="option"><input type="checkbox" id="optGitUiEnabled"><span>Enable Git UI<small>Show embedded Git controls for workspace/worktree checkouts.</small></span></label><label class="option"><span>Git file list<small>Tree groups files by folders. Filename mode shows only the basename and keeps the full path in the hover tooltip.</small></span><select class="settings-select" id="optGitUiFileListMode"><option value="tree">File tree</option><option value="flat">Filename only</option></select></label><label class="option"><span>Git diff layout<small>Side-by-side is desktop default. Unified matches GitHub-style diffs. Mobile always uses unified.</small></span><select class="settings-select" id="optGitUiDiffLayout"><option value="side-by-side">Side-by-side</option><option value="unified">Unified (GitHub-style)</option></select></label><label class="option"><span>Git log default branch<small>Shown first in Git log before the current branch. Use master by default.</small></span><input id="optGitUiDefaultBranch" type="text" placeholder="master"></label><label class="option"><span>Git large diff line limit<small>Hide full diff rendering above this many changed/context lines. Select a file to render it. Set 0 to always render.</small></span><input id="optGitUiLargeDiffLineLimit" type="number" min="0" max="200000" step="100"></label><label class="option"><span>Git remote branches to preload<small>Number of remote branches shown initially. Main/master and related branches are prioritised. Filtering loads the complete remote list.</small></span><input id="optGitUiRemoteBranchPreload" type="number" min="1" max="100" step="1"></label>',
    ids: ["optGitUiEnabled", "optGitUiFileListMode", "optGitUiDiffLayout", "optGitUiDefaultBranch", "optGitUiLargeDiffLineLimit", "optGitUiRemoteBranchPreload"],
    normalize(options) {
      options.gitUiEnabled = options.gitUiEnabled !== false;
      options.gitUiFileListMode = options.gitUiFileListMode === "flat" ? "flat" : "tree";
      options.gitUiDiffLayout = options.gitUiDiffLayout === "unified" ? "unified" : "side-by-side";
      options.gitUiDefaultBranch = String(options.gitUiDefaultBranch || "master").trim() || "master";
      const limit = Number(options.gitUiLargeDiffLineLimit);
      options.gitUiLargeDiffLineLimit = Number.isFinite(limit) ? Math.max(0, Math.min(200000, limit)) : 2000;
      const preload = Number(options.gitUiRemoteBranchPreload);
      options.gitUiRemoteBranchPreload = Number.isFinite(preload) ? Math.max(1, Math.min(100, preload)) : 10;
    },
    apply(options) {
      const enabled = document.getElementById("optGitUiEnabled"); if (enabled) enabled.checked = options.gitUiEnabled !== false;
      const input = document.getElementById("optGitUiLargeDiffLineLimit"); if (input) input.value = String(options.gitUiLargeDiffLineLimit ?? 2000);
      const fileListMode = document.getElementById("optGitUiFileListMode"); if (fileListMode) fileListMode.value = options.gitUiFileListMode === "flat" ? "flat" : "tree";
      const diffLayout = document.getElementById("optGitUiDiffLayout"); if (diffLayout) diffLayout.value = options.gitUiDiffLayout === "unified" ? "unified" : "side-by-side";
      const defaultBranch = document.getElementById("optGitUiDefaultBranch"); if (defaultBranch) defaultBranch.value = options.gitUiDefaultBranch || "master";
      const preload = document.getElementById("optGitUiRemoteBranchPreload"); if (preload) preload.value = String(options.gitUiRemoteBranchPreload ?? 10);
    },
    bind(ctx) {
      const bind = (id, key, value) => { const el = document.getElementById(id); if (!el || el.dataset.bound === "1") return; el.dataset.bound = "1"; el.onchange = () => { ctx.setOption(key, value(el)); ctx.saveOptions(); ctx.applyOptions(); if (window.HerdrGitUi && window.HerdrGitUi.refreshVisible) window.HerdrGitUi.refreshVisible(); }; };
      bind("optGitUiEnabled", "gitUiEnabled", (el) => el.checked);
      bind("optGitUiFileListMode", "gitUiFileListMode", (el) => el.value === "flat" ? "flat" : "tree");
      bind("optGitUiDiffLayout", "gitUiDiffLayout", (el) => el.value === "unified" ? "unified" : "side-by-side");
      bind("optGitUiDefaultBranch", "gitUiDefaultBranch", (el) => el.value.trim() || "master");
      bind("optGitUiLargeDiffLineLimit", "gitUiLargeDiffLineLimit", (el) => Number(el.value) || 0);
      bind("optGitUiRemoteBranchPreload", "gitUiRemoteBranchPreload", (el) => Number(el.value) || 10);
    },
  });
})();
