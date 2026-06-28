(function () {
  window.HerdrSettingsModules = window.HerdrSettingsModules || [];
  window.HerdrSettingsModules.push({
    id: "gitUi",
    title: "Git UI",
    desc: "Enable the embedded Git drawer and tune file/diff rendering.",
    defaults: { gitUiEnabled: true, gitUiLargeDiffLineLimit: 2000, gitUiFileListMode: "tree" },
    html: '<label class="option"><input type="checkbox" id="optGitUiEnabled"><span>Enable Git UI<small>Show embedded Git controls for workspace/worktree checkouts.</small></span></label><label class="option"><span>Git file list<small>Tree groups files by folders. Filename mode shows only the basename and keeps the full path in the hover tooltip.</small></span><select class="settings-select" id="optGitUiFileListMode"><option value="tree">File tree</option><option value="flat">Filename only</option></select></label><label class="option"><span>Git large diff line limit<small>Hide full diff rendering above this many changed/context lines. Select a file to render it. Set 0 to always render.</small></span><input id="optGitUiLargeDiffLineLimit" type="number" min="0" max="200000" step="100"></label>',
    ids: ["optGitUiEnabled", "optGitUiFileListMode", "optGitUiLargeDiffLineLimit"],
    normalize(options) {
      options.gitUiEnabled = options.gitUiEnabled !== false;
      options.gitUiFileListMode = options.gitUiFileListMode === "flat" ? "flat" : "tree";
      const limit = Number(options.gitUiLargeDiffLineLimit);
      options.gitUiLargeDiffLineLimit = Number.isFinite(limit) ? Math.max(0, Math.min(200000, limit)) : 2000;
    },
    apply(options) {
      const enabled = document.getElementById("optGitUiEnabled");
      if (enabled) enabled.checked = options.gitUiEnabled !== false;
      const input = document.getElementById("optGitUiLargeDiffLineLimit");
      if (input) input.value = String(options.gitUiLargeDiffLineLimit ?? 2000);
      const fileListMode = document.getElementById("optGitUiFileListMode");
      if (fileListMode) fileListMode.value = options.gitUiFileListMode === "flat" ? "flat" : "tree";
    },
    bind(ctx) {
      const enabled = document.getElementById("optGitUiEnabled");
      if (enabled && enabled.dataset.bound !== "1") {
        enabled.dataset.bound = "1";
        enabled.onchange = () => {
          ctx.setOption("gitUiEnabled", enabled.checked);
          ctx.saveOptions();
          ctx.applyOptions();
        };
      }
      const fileListMode = document.getElementById("optGitUiFileListMode");
      if (fileListMode && fileListMode.dataset.bound !== "1") {
        fileListMode.dataset.bound = "1";
        fileListMode.onchange = () => {
          ctx.setOption("gitUiFileListMode", fileListMode.value === "flat" ? "flat" : "tree");
          ctx.saveOptions();
          ctx.applyOptions();
          if (window.HerdrGitUi && window.HerdrGitUi.refreshVisible) window.HerdrGitUi.refreshVisible();
        };
      }
      const input = document.getElementById("optGitUiLargeDiffLineLimit");
      if (!input || input.dataset.bound === "1") return;
      input.dataset.bound = "1";
      input.onchange = () => {
        ctx.setOption("gitUiLargeDiffLineLimit", Number(input.value) || 0);
        ctx.saveOptions();
        ctx.applyOptions();
      };
    },
  });
})();
