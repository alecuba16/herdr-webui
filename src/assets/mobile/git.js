(function () {
  function createMobileGit({
    state,
    api,
    render,
    el,
    escapeHtml,
    inputAttrs,
    jsArg,
    pathBasename,
    currentWorkspaceCwd,
    confirmFn,
    // Routes a checked-out-elsewhere branch row to the sibling checkout:
    // the app wires this to openFolderAsWorkspace so the branch sheet can
    // hand the user to the worktree that already holds the branch.
    rerouteToWorktreeFn,
  }) {
    async function loadGitStatus() {
      const cwd = currentWorkspaceCwd();
      resetGitForCwd(cwd);
      if (!cwd) {
        state.gitError = "No checkout path for selected workspace";
        state.gitStatus = null;
        render();
        return;
      }
      try {
        state.gitError = "";
        state.gitStatus = await api(
          "/api/git-ui/status?cwd=" + encodeURIComponent(cwd),
        );
      } catch (error) {
        state.gitError = error.message || String(error);
        state.gitStatus = null;
      }
      render();
    }

    function resetGitForCwd(cwd) {
      if (state.gitCwd === cwd) return;
      state.gitCwd = cwd;
      state.gitStatus = null;
      state.gitError = "";
      state.gitFile = "";
      state.gitKind = "";
      state.gitDiff = null;
      state.gitDiffError = "";
      state.gitBranches = null;
      state.gitBranchesError = "";
      state.gitBusy = "";
      state.gitMutating = false;
      state.gitCommitSheet = null;
      state.gitCommitDone = false;
    }

    async function selectGitFile(file, kind) {
      state.gitFile = file;
      state.gitKind = kind;
      state.gitDiff = null;
      state.gitDiffError = "";
      render();
      await loadGitDiff();
    }

    function backGitFiles() {
      state.gitFile = "";
      state.gitKind = "";
      state.gitDiff = null;
      state.gitDiffError = "";
      render();
    }

    async function loadGitDiff() {
      const cwd = currentWorkspaceCwd();
      resetGitForCwd(cwd);
      if (!cwd || !state.gitFile) return;
      const scope = state.gitKind === "S" ? "staged" : "working";
      try {
        state.gitDiffError = "";
        // layout=side-by-side asks the backend to pair chunk lines into
        // rows server-side; the renderer falls back to the raw lines when
        // the field is absent.
        state.gitDiff = await api(
          `/api/git-ui/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(state.gitFile)}&scope=${encodeURIComponent(scope)}&context=3&layout=side-by-side`,
        );
      } catch (error) {
        state.gitDiffError = error.message || String(error);
        state.gitDiff = null;
      }
      render();
    }

    async function gitMutate(label, run) {
      if (state.gitMutating) return;
      const cwd = currentWorkspaceCwd();
      if (!cwd) return;
      state.gitMutating = true;
      state.gitBusy = label;
      state.gitError = "";
      render();
      try {
        await run(cwd);
        await loadGitStatus();
      } catch (error) {
        state.gitError = error.message || String(error);
      }
      state.gitMutating = false;
      state.gitBusy = "";
      render();
    }

    async function gitStageFile() {
      if (!state.gitFile) return;
      await gitMutate("Staging", async (cwd) => {
        await api("/api/git-ui/stage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, paths: [state.gitFile] }),
        });
        state.gitKind = "S";
        state.gitDiff = null;
        state.gitDiffError = "";
        await loadGitDiff();
      });
    }

    async function gitUnstageFile() {
      if (!state.gitFile) return;
      await gitMutate("Unstaging", async (cwd) => {
        await api("/api/git-ui/unstage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, paths: [state.gitFile] }),
        });
        state.gitKind = "M";
        state.gitDiff = null;
        state.gitDiffError = "";
        await loadGitDiff();
      });
    }

    async function gitDiscardFile() {
      if (!state.gitFile) return;
      if (!(await confirmFn(`Discard all uncommitted changes to ${state.gitFile}? This cannot be undone.`))) return;
      await gitMutate("Discarding", async (cwd) => {
        await api("/api/git-ui/discard", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, paths: [state.gitFile], confirmed: true }),
        });
        backGitFiles();
      });
    }

    // Commit: staged changes only, same contract as the desktop drawer.
    // POST /api/git-ui/commit with {cwd, title, body, amend}.
    function openCommitSheet() {
      const status = state.gitStatus;
      const staged = (status && status.staged) || [];
      if (!staged.length) {
        state.gitError = "Stage changes before committing.";
        render();
        return;
      }
      state.gitError = "";
      state.gitCommitSheet = { title: "", body: "" };
      render();
    }

    function closeCommitSheet() {
      state.gitCommitSheet = null;
      render();
    }

    function setCommitField(field, value) {
      if (!state.gitCommitSheet) return;
      state.gitCommitSheet[field] = String(value || "");
    }

    async function submitCommit() {
      const sheet = state.gitCommitSheet;
      if (!sheet || state.gitMutating) return;
      const title = (sheet.title || "").trim();
      if (!title) {
        state.gitError = "Commit title is required.";
        render();
        return;
      }
      const cwd = currentWorkspaceCwd();
      if (!cwd) return;
      state.gitMutating = true;
      state.gitBusy = "Committing";
      render();
      try {
        await api("/api/git-ui/commit", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, title, body: sheet.body || "", amend: false }),
        });
        state.gitCommitSheet = null;
        state.gitCommitDone = true;
      } catch (error) {
        state.gitError = error.message || String(error);
      }
      state.gitMutating = false;
      state.gitBusy = "";
      await loadGitStatus();
    }

    function dismissCommitDone() {
      state.gitCommitDone = false;
      render();
    }

    async function loadGitBranches() {
      const cwd = currentWorkspaceCwd();
      if (!cwd) return;
      try {
        state.gitBranchesError = "";
        state.gitBranches = await api(
          "/api/git-ui/branches?cwd=" + encodeURIComponent(cwd),
        );
      } catch (error) {
        state.gitBranchesError = error.message || String(error);
        state.gitBranches = null;
      }
      render();
    }

    async function gitSwitchBranch(name) {
      if (!name || state.gitMutating) return;
      if (!(await confirmFn(`Switch to branch ${name}?`))) return;
      await gitMutate("Switching branch", async (cwd) => {
        await api("/api/git-ui/switch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, branch: name }),
        });
        state.gitBranches = null;
        await loadGitStatus();
        await loadGitBranches();
      });
    }

    // ---- Branch sheet (location strip parity surface) ----
    // The strip's branch pill opens this sheet. It keeps its own state
    // separate from the Git screen's inline branch list: the sheet pins
    // the cwd it was opened for, so a workspace switch mid-flight can
    // never land a switch on the wrong checkout, and it carries the
    // create-branch draft the inline list does not have.
    const branchSheet = {
      open: false,
      cwd: "",
      loading: false,
      branches: null,
      error: "",
      newBranch: "",
      creating: false,
    };

    function branchSheetStale() {
      return !branchSheet.open || branchSheet.cwd !== currentWorkspaceCwd();
    }

    async function openBranchSheet() {
      const cwd = currentWorkspaceCwd();
      if (!cwd) return;
      branchSheet.open = true;
      branchSheet.cwd = cwd;
      branchSheet.loading = true;
      branchSheet.branches = null;
      branchSheet.error = "";
      branchSheet.newBranch = "";
      branchSheet.creating = false;
      render();
      try {
        branchSheet.branches = await api(
          "/api/git-ui/branches?cwd=" + encodeURIComponent(cwd),
        );
        branchSheet.loading = false;
      } catch (error) {
        branchSheet.error = error.message || String(error);
        branchSheet.loading = false;
      }
      // A workspace switch mid-flight dismisses the sheet on the next
      // render (pinned-cwd check below); landing data for the old
      // checkout then re-renders into a closed sheet, which is a no-op.
      render();
    }

    function closeBranchSheet() {
      branchSheet.open = false;
      branchSheet.branches = null;
      branchSheet.error = "";
      branchSheet.newBranch = "";
      branchSheet.creating = false;
      const container = el("mobileBranchSheet");
      const backdrop = el("mobileBranchBackdrop");
      if (container) container.hidden = true;
      if (backdrop) backdrop.hidden = true;
      render();
    }

    function setBranchCreateName(value) {
      branchSheet.newBranch = String(value || "");
    }

    // The branches payload stamps each branch with the worktree folder
    // it is checked out in. A folder other than the sheet's own cwd
    // means git will refuse a plain switch there; the row reroutes the
    // user to that checkout through the folder-change flow instead.
    function branchCheckoutPath(branches, localName) {
      const rows = (branches && branches.local) || [];
      for (const branch of rows) {
        if (!branch || branch.remote) continue;
        if (String(branch.name || "") !== String(localName)) continue;
        const path = String(branch.worktree_path || "");
        return path ? path : "";
      }
      return "";
    }

    function samePath(a, b) {
      return String(a || "").replace(/\/+$/, "") === String(b || "").replace(/\/+$/, "");
    }

    async function switchBranchFromSheet(name) {
      if (!name || state.gitMutating || branchSheetStale()) return;
      const localName = String(name);
      const current = String(((branchSheet.branches || {}).local || []).find((branch) => branch && branch.current && branch.name) || {}).name || "";
      if (localName === current) {
        closeBranchSheet();
        return;
      }
      const checkout = branchCheckoutPath(branchSheet.branches, localName);
      if (checkout && !samePath(checkout, branchSheet.cwd)) {
        // Checked out in another worktree: hand the user to that folder
        // through the same route the worktree sheet rows use. No switch
        // POST happens; git would refuse it anyway.
        const reroute = typeof rerouteToWorktreeFn === "function" ? rerouteToWorktreeFn : null;
        if (!reroute) {
          branchSheet.error = "Folder switching is unavailable.";
          render();
          return;
        }
        if (!(await confirmFn(`Switch to branch ${localName} in its worktree?`))) return;
        closeBranchSheet();
        try {
          await reroute(checkout);
        } catch (error) {
          state.gitError = error.message || String(error);
          render();
        }
        return;
      }
      if (!(await confirmFn(`Switch to branch ${localName}?`))) return;
      await gitMutate("Switching branch", async (cwd) => {
        await api("/api/git-ui/switch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd, branch: localName }),
        });
        state.gitBranches = null;
        closeBranchSheet();
        await loadGitStatus();
      });
    }

    // New branch stays in the same workspace: the switch endpoint with
    // create:true checks out a new branch at the given base, same
    // contract as the desktop bar's create row.
    async function createBranchFromSheet() {
      if (branchSheetStale() || branchSheet.creating || state.gitMutating) return;
      const name = String(branchSheet.newBranch || "").trim();
      if (!name) {
        branchSheet.error = "Branch name is required.";
        render();
        return;
      }
      // Base defaults to the branch the sheet itself marked current: the
      // status cache can lag a switch that just landed.
      const base = String(currentSheetBranch() || "HEAD");
      if (!(await confirmFn(`Create and switch to branch ${name} from ${base}?`))) return;
      branchSheet.creating = true;
      render();
      try {
        await api("/api/git-ui/switch", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: branchSheet.cwd, branch: name, create: true, base }),
        });
        state.gitBranches = null;
        branchSheet.creating = false;
        closeBranchSheet();
        await loadGitStatus();
      } catch (error) {
        branchSheet.creating = false;
        branchSheet.error = error.message || String(error);
        render();
      }
    }

    function isBranchSheetOpen() {
      return branchSheet.open && branchSheet.cwd === currentWorkspaceCwd();
    }

    function renderBranchSheet() {
      if (!branchSheet.open) return;
      const container = el("mobileBranchSheet");
      const backdrop = el("mobileBranchBackdrop");
      if (!container || !backdrop) return;
      // A workspace switch while the sheet is open must dismiss it: the
      // rows describe the old checkout and every action would refuse as
      // stale anyway.
      if (branchSheet.cwd !== currentWorkspaceCwd()) {
        closeBranchSheet();
        return;
      }
      container.hidden = false;
      backdrop.hidden = false;
      const html = branchSheetHtml();
      if (container.__lastBranchSheetHtml !== html) {
        container.innerHTML = html;
        container.__lastBranchSheetHtml = html;
      }
    }

    function branchSheetHtml() {
      const loading = branchSheet.loading
        ? '<div class="mobile-loading">Loading branches</div>'
        : "";
      const error = branchSheet.error
        ? `<div class="mobile-error">${escapeHtml(branchSheet.error)}</div>`
        : "";
      const branches = branchSheet.branches;
      const local = (branches && branches.local) || [];
      const remote = (branches && branches.remote) || [];
      const rows = (list) => list.map((branch) => {
        const name = String(branch && branch.name || "");
        const current = !!branch.current && !branch.remote;
        const checkout = current ? "" : branchCheckoutPath(branches, name);
        const elsewhere = checkout && !samePath(checkout, branchSheet.cwd);
        const meta = current ? "current" : branch.remote ? "remote" : elsewhere ? "checked out in " + checkout : "local";
        return `<button class="mobile-row mobile-git-branch${current ? " active" : ""}" ${current ? "disabled" : `onclick="HerdrMobile.switchBranchFromSheet(${jsArg(name)})"`}><strong>${escapeHtml(name)}</strong><span>${escapeHtml(meta)}</span></button>`;
      }).join("");
      const createLabel = branchSheet.creating ? "Creating..." : "Create";
      const busy = state.gitMutating && branchSheet.open
        ? `<div class="mobile-loading">${escapeHtml(state.gitBusy || "Working")}...</div>`
        : "";
      return `<div class="mobile-sheet-handle"></div><div class="mobile-sheet-title">Branches</div>${loading}${error}${busy}<div class="mobile-tabs-sheet-list"><h3>Local</h3>${local.length ? rows(local) : '<div class="mobile-empty"><span aria-hidden="true">◍</span>None</div>'}${remote.length ? `<h3>Remote</h3>${rows(remote)}` : ""}</div><label class="mobile-branch-create"><span>New branch from ${escapeHtml(currentSheetBranch() || "HEAD")}</span><input class="mobile-sheet-input" type="text" placeholder="branch-name" value="${escapeHtml(branchSheet.newBranch)}"${inputAttrs("done")} oninput="HerdrMobile.setBranchCreateName(this.value)" onkeydown="if (event.key === 'Enter') { event.preventDefault(); HerdrMobile.createBranchFromSheet(); }" /><button class="mobile-btn primary" type="button"${branchSheet.creating || state.gitMutating ? " disabled" : ""} onclick="HerdrMobile.createBranchFromSheet()">${createLabel}</button></label>`;
    }

    function currentSheetBranch() {
      const local = ((branchSheet.branches || {}).local) || [];
      const row = local.find((branch) => branch && branch.current && branch.name);
      return row ? String(row.name) : (state.gitStatus && state.gitCwd === branchSheet.cwd && state.gitStatus.branch) || "";
    }

    async function toggleGitBranches() {
      if (state.gitBranches) {
        state.gitBranches = null;
        render();
        return;
      }
      await loadGitBranches();
    }

    function renderGitScreen(screen) {
      resetGitForCwd(currentWorkspaceCwd());
      const status = state.gitStatus;
      if (state.gitError) {
        screen.innerHTML = `<section class="mobile-section"><h2>Git</h2><div class="mobile-error">${escapeHtml(state.gitError)}</div><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.loadGitStatus()">Retry</button></section>`;
        return;
      }
      if (!status) {
        screen.innerHTML = `<section class="mobile-section"><h2>Git</h2><div class="mobile-loading">Loading Git status</div></section>`;
        loadGitStatus();
        return;
      }
      if (state.gitFile) {
        screen.innerHTML = renderGitFileDetail(status);
        if (!state.gitDiff && !state.gitDiffError) loadGitDiff();
        return;
      }
      const rows = [
        ["Conflicts", status.conflicted || [], "U"],
        ["Staged", status.staged || [], "S"],
        ["Unstaged", status.unstaged || [], "M"],
        ["Untracked", status.untracked || [], "?"],
      ]
        .map(
          ([title, files, kind]) =>
            `<h3>${escapeHtml(title)}</h3>${files.length ? files.map((file) => `<button class="mobile-row mobile-git-file" onclick="HerdrMobile.selectGitFile(${jsArg(file)},'${kind}')"><strong>${escapeHtml(pathBasename(file))}</strong><span>${escapeHtml(file)}</span></button>`).join("") : '<div class="mobile-empty"><span aria-hidden="true">✓</span>None</div>'}`,
        )
        .join("");
      const busy = state.gitMutating ? `<div class="mobile-loading">${escapeHtml(state.gitBusy || "Working")}…</div>` : "";
      const branchesBlock = state.gitBranches
        ? renderGitBranchList(state.gitBranches)
        : `<button class="mobile-btn mobile-wide" onclick="HerdrMobile.toggleGitBranches()">Branches</button>${state.gitBranchesError ? `<div class="mobile-error">${escapeHtml(state.gitBranchesError)}</div>` : ""}`;
      const stagedCount = ((status.staged || []).length);
      const commitSheet = state.gitCommitSheet
        ? `<div class="mobile-sheet-backdrop" onclick="HerdrMobile.closeCommitSheet()"></div><div class="mobile-sheet" role="dialog" aria-modal="true" aria-label="Commit staged changes"><div class="mobile-sheet-handle"></div><p class="mobile-sheet-title">Commit ${stagedCount} staged file${stagedCount === 1 ? "" : "s"}</p><input id="mobileCommitTitle" class="mobile-sheet-input" type="text"${inputAttrs("done")} placeholder="commit title" value="${escapeHtml(state.gitCommitSheet.title)}" oninput="HerdrMobile.setCommitField('title', this.value)" onkeydown="if (event.key === 'Enter') { event.preventDefault(); HerdrMobile.submitCommit(); } if (event.key === 'Escape') { event.preventDefault(); HerdrMobile.closeCommitSheet(); }" /><textarea id="mobileCommitBody" class="mobile-sheet-input" rows="3"${inputAttrs()} placeholder="details (optional)" oninput="HerdrMobile.setCommitField('body', this.value)">${escapeHtml(state.gitCommitSheet.body)}</textarea><div class="mobile-sheet-actions"><button class="mobile-btn" ${state.gitMutating ? "disabled" : ""} onclick="HerdrMobile.closeCommitSheet()">Cancel</button><button class="mobile-btn primary" id="mobileCommitSubmit" ${state.gitMutating ? "disabled" : ""} onclick="HerdrMobile.submitCommit()">${state.gitMutating ? "Committing…" : "Commit"}</button></div></div>`
        : "";
      const commitDone = state.gitCommitDone
        ? `<div class="mobile-commit-done" role="status"><span>Commit created</span><button class="mobile-btn mini" onclick="HerdrMobile.dismissCommitDone()">Done</button></div>`
        : "";
      const commitButton = `<button class="mobile-btn primary mobile-wide" ${stagedCount ? "" : "disabled"} title="${stagedCount ? "Commit staged changes" : "Stage changes before committing"}" onclick="HerdrMobile.openCommitSheet()">Commit staged</button>`;
      screen.innerHTML = `<section class="mobile-section mobile-git"><h2>Git</h2><p class="mobile-help">${escapeHtml(status.branch || "detached")} · ${escapeHtml(status.state || "")}</p><button class="mobile-btn primary mobile-wide" onclick="HerdrMobile.loadGitStatus()">Refresh</button>${commitButton}${busy}${commitDone}${state.gitError ? `<div class="mobile-error">${escapeHtml(state.gitError)}</div>` : ""}${rows}${branchesBlock}${commitSheet}</section>`;
    }

    function renderGitBranchList(branchesData) {
      const local = (branchesData && branchesData.local) || [];
      const remote = (branchesData && branchesData.remote) || [];
      const row = (branch) => `<button class="mobile-row mobile-git-branch${branch.current ? " active" : ""}" ${branch.current ? "disabled" : `onclick="HerdrMobile.gitSwitchBranch(${jsArg(branch.name)})"`}><strong>${escapeHtml(branch.name)}</strong><span>${branch.current ? "current" : branch.remote ? "remote" : branch.upstream ? escapeHtml("upstream " + branch.upstream) : "local"}</span></button>`;
      return `<div class="mobile-git-branches"><button class="mobile-btn mobile-wide" onclick="HerdrMobile.toggleGitBranches()">Hide branches</button><h3>Local</h3>${local.length ? local.map(row).join("") : '<div class="mobile-empty"><span aria-hidden="true">◍</span>None</div>'}${remote.length ? `<h3>Remote</h3>${remote.map(row).join("")}` : ""}</div>`;
    }

    function renderGitFileDetail(status) {
      const file = currentGitDiffFile();
      const stats = file ? `+${file.additions || 0} -${file.deletions || 0}` : "No diff loaded";
      const error = state.gitDiffError ? `<div class="mobile-error">${escapeHtml(state.gitDiffError)}</div>` : "";
      const diff = file ? renderGitDiffFile(file) : `<div class="mobile-loading">${state.gitDiffError ? "No diff" : "Loading diff"}</div>`;
      const kind = state.gitKind;
      const canStage = kind === "M" || kind === "?";
      const canUnstage = kind === "S";
      const canDiscard = kind === "M" || kind === "S";
      const actions = `<div class="mobile-git-file-actions">${canStage ? `<button class="mobile-btn" ${state.gitMutating ? "disabled" : ""} onclick="HerdrMobile.gitStageFile()">Stage</button>` : ""}${canUnstage ? `<button class="mobile-btn" ${state.gitMutating ? "disabled" : ""} onclick="HerdrMobile.gitUnstageFile()">Unstage</button>` : ""}${canDiscard ? `<button class="mobile-btn danger" ${state.gitMutating ? "disabled" : ""} onclick="HerdrMobile.gitDiscardFile()">Discard</button>` : ""}</div>`;
      const busy = state.gitMutating ? `<div class="mobile-loading">${escapeHtml(state.gitBusy || "Working")}…</div>` : "";
      return `<section class="mobile-section mobile-git"><div class="mobile-git-file-head"><button class="mobile-btn" onclick="HerdrMobile.backGitFiles()">Files</button><div><strong>${escapeHtml(state.gitFile)}</strong><span>${escapeHtml((status.branch || "detached") + " · " + stats)}</span></div></div>${actions}${busy}${state.gitError ? `<div class="mobile-error">${escapeHtml(state.gitError)}</div>` : ""}${error}${diff}</section>`;
    }

    function currentGitDiffFile() {
      const files = (state.gitDiff && state.gitDiff.files) || [];
      return files.find((file) => file.path === state.gitFile) || files[0] || null;
    }

    function renderGitDiffFile(file) {
      const chunks = file.chunks || [];
      if (!chunks.length) return `<div class="mobile-loading">No diff hunks</div>`;
      return `<div class="mobile-diff">${chunks.map((chunk) => `<article class="mobile-hunk"><header><span>${escapeHtml(chunk.header || "hunk")}</header></header><pre>${renderGitDiffLines(chunk).join("\n")}</pre></article>`).join("")}</div>`;
    }

    // Backend layout=side-by-side pairs chunk.lines into rows server-side
    // (chunk.rows with old_line/new_line); when the field is absent
    // (older backend, unified-only response) fall back to rendering the
    // raw lines client-side, same as before the server-side pairing.
    function renderGitDiffLines(chunk) {
      if (Array.isArray(chunk.rows) && chunk.rows.length) {
        return chunk.rows.map((row) => {
          const oldLine = row && row.old_line ? row.old_line : null;
          const newLine = row && row.new_line ? row.new_line : null;
          return [
            oldLine ? renderGitDiffLine(oldLine) : renderGitDiffLine({ line_type: "normal", content: "" }),
            newLine ? renderGitDiffLine(newLine) : renderGitDiffLine({ line_type: "normal", content: "" }),
          ].join("\n");
        });
      }
      return (chunk.lines || []).map(renderGitDiffLine);
    }

    function renderGitDiffLine(line) {
      const type = line.line_type || "normal";
      const prefix = type === "add" ? "+" : type === "delete" ? "-" : " ";
      return `<span class="${escapeHtml(type)}">${escapeHtml(prefix + (line.content || ""))}</span>`;
    }

    return {
      loadGitStatus,
      selectGitFile,
      backGitFiles,
      gitStageFile,
      gitUnstageFile,
      gitDiscardFile,
      openCommitSheet,
      closeCommitSheet,
      setCommitField,
      submitCommit,
      dismissCommitDone,
      loadGitBranches,
      gitSwitchBranch,
      toggleGitBranches,
      openBranchSheet,
      closeBranchSheet,
      switchBranchFromSheet,
      setBranchCreateName,
      createBranchFromSheet,
      renderBranchSheet,
      isBranchSheetOpen,
      renderGitScreen,
    };
  }

  globalThis.HerdrMobileGitModule = { create: createMobileGit };
})();