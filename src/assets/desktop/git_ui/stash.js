(function () {
  function createGitUiStash({
    state,
    active,
    api,
    esc,
    arg,
    render,
    replaceContent,
    renderDiffFileBody,
    renderLargeDiffPlaceholder,
    diffFileLineCount,
    diffFileKey,
    largeFileDiffLineLimit,
  }) {
    async function renderStash(version) {
      const view = active();
      const data = await api(`/api/git-ui/stashes?cwd=${encodeURIComponent(view.cwd)}`);
      view.stashData = data;
      const stashes = data.stashes || [];
      if (!view.selectedStash && stashes.length) view.selectedStash = String(stashes[0].name || "");
      if (view.selectedStash && !stashes.some((s) => s.name === view.selectedStash)) view.selectedStash = stashes.length ? String(stashes[0].name || "") : "";
      replaceContent(version, renderStashDiff());
      if (view.selectedStash) loadStashDiff(view, view.selectedStash);
    }

    function renderStashDiff() {
      const view = active() || {};
      const stashes = (view.stashData && view.stashData.stashes) ? view.stashData.stashes : [];
      const name = view.selectedStash;
      const stashActions = `<div class="git-ui-actions git-ui-stash-actions"><button class="git-ui-btn primary" onclick="HerdrGitUi.stash()">Stash push</button></div>`;
      if (!stashes.length) return `${stashActions}<div class="git-ui-muted">No stashes found.</div>`;
      if (!name) return `${stashActions}<div class="git-ui-muted">Select a stash to view its changes.</div>`;
      const preview = view.selectedStashDiff || {};
      const stashActionsForEntry = `<div class="git-ui-actions git-ui-stash-entry-actions"><button class="git-ui-btn primary" title="Apply stash without removing it" onclick="HerdrGitUi.applyStash('${arg(name)}',false)">Apply</button><button class="git-ui-btn" title="Pop stash (apply and remove)" onclick="HerdrGitUi.applyStash('${arg(name)}',true)">Pop</button><button class="git-ui-btn danger" title="Drop stash" onclick="HerdrGitUi.dropStash('${arg(name)}')">Drop</button></div>`;
      if (preview.loading) return `${stashActions}<div class="git-ui-loading"><span></span><strong>Loading stash diff</strong></div>`;
      if (preview.error) return `${stashActions}${stashActionsForEntry}<div class="git-ui-error">${esc(preview.error)}</div>`;
      const files = (preview.diff && preview.diff.files) || [];
      const filteredFiles = view.stashFile ? files.filter((f) => f.path === view.stashFile) : files;
      if (!filteredFiles.length) return `${stashActions}${stashActionsForEntry}<div class="git-ui-muted">No changes in this stash.</div>`;
      return `${stashActions}${stashActionsForEntry}${filteredFiles.map(renderStashDiffFile).join("")}`;
    }

    function renderStashDiffFile(file) {
      const view = active() || {};
      const collapsed = !!(view.collapsedFiles || {})[file.path];
      const lineCount = diffFileLineCount(file);
      const large = lineCount > largeFileDiffLineLimit;
      const loadedLarge = !!(view.loadedLargeDiffFiles || {})[file.path];
      const renderFullLarge = !!(view.fullLargeDiffFiles || {})[diffFileKey(file)];
      const body = collapsed
        ? ""
        : large && !loadedLarge
          ? renderLargeDiffPlaceholder(file)
          : renderDiffFileBody(file, lineCount, large, renderFullLarge);
      const stashName = view.selectedStash || "stash@{0}";
      return `<div class="git-ui-diff-file" data-git-path="${esc(file.path)}"><div class="git-ui-diff-file-head"><button class="git-ui-file-collapse" title="${collapsed ? "Show file" : "Collapse file"}" onclick="HerdrGitUi.toggleFile('${arg(file.path)}')">${collapsed ? "+" : "−"}</button><strong>${esc(file.path)}</strong><span class="git-ui-muted">${esc(stashName)} → working tree</span><span class="git-ui-diff-file-actions"><span class="git-ui-badge add">+${file.additions || 0}</span> <span class="git-ui-badge del">-${file.deletions || 0}</span></span></div>${body}</div>`;
    }

    function loadStashDiff(view, name) {
      if (!view || !name) return;
      const current = view.selectedStashDiff || {};
      if (current.name === name && (current.loading || current.diff)) return;
      view.selectedStashDiff = { name, loading: true, error: "", diff: null };
      const context = Math.max(0, Math.min(200, Number(view.diffContext || 3)));
      api(`/api/git-ui/stash-show?cwd=${encodeURIComponent(view.cwd)}&stash=${encodeURIComponent(name)}&context=${context}`)
        .then((diff) => {
          if (!view.selectedStashDiff || view.selectedStashDiff.name !== name) return;
          view.selectedStashDiff = { name, loading: false, error: "", diff };
          if (state.visible) render();
        })
        .catch((err) => {
          if (!view.selectedStashDiff || view.selectedStashDiff.name !== name) return;
          view.selectedStashDiff = { name, loading: false, error: err.message || String(err), diff: null };
          if (state.visible) render();
        });
    }

    return {
      renderStash,
      renderStashDiff,
      renderStashDiffFile,
      loadStashDiff,
    };
  }

  globalThis.HerdrGitUiStashModule = { create: createGitUiStash };
})();