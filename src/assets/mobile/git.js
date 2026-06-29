(function () {
  function createMobileGit(deps) {
    const { api, currentWorkspaceCwd, escapeHtml, jsArg, render } = deps;
    const state = {
      status: null,
      diff: null,
      branches: null,
      log: null,
      stashes: null,
      file: "",
      kind: "",
      scope: "all",
      tab: "changes",
      loading: false,
      error: "",
      selectedLogCommits: [],
      compareBase: "",
      compareTarget: "",
      commitTitle: "",
      commitBody: "",
      showActions: "",
      cwd: "",
      fileMode: "diff",
      history: null,
      blame: {},
      editor: null,
    };

    function cwd() {
      return currentWorkspaceCwd() || "";
    }

    function resetForCwd(nextCwd) {
      if (state.cwd === nextCwd) return;
      state.cwd = nextCwd;
      state.status = null;
      state.diff = null;
      state.branches = null;
      state.log = null;
      state.stashes = null;
      state.file = "";
      state.kind = "";
      state.scope = "all";
      state.error = "";
      state.selectedLogCommits = [];
      state.compareBase = "";
      state.compareTarget = "";
      state.fileMode = "diff";
      state.history = null;
      state.blame = {};
      state.editor = null;
    }

    function query(path, params) {
      const search = new URLSearchParams(Object.assign({ cwd: cwd() }, params || {}));
      return path + "?" + search.toString();
    }

    async function refresh() {
      const currentCwd = cwd();
      resetForCwd(currentCwd);
      if (!currentCwd) {
        state.error = "No checkout path for selected workspace";
        state.status = null;
        state.diff = null;
        render();
        return;
      }
      state.loading = true;
      state.error = "";
      render();
      try {
        state.status = await api(query("/api/git-ui/status"));
        await loadDiff();
        if (state.tab === "log") await loadLog();
        if (state.tab === "stash") await loadStashes();
        if (state.tab === "branch") await loadBranches();
        state.loading = false;
      } catch (error) {
        state.error = error.message || String(error);
        state.loading = false;
      }
      render();
    }

    async function loadDiff() {
      const params = { context: "3", scope: state.scope || "all" };
      if (state.file) params.file = state.file;
      if (state.compareBase || state.compareTarget) {
        params.base = state.compareBase || "HEAD";
        params.target = state.compareTarget || ".";
        state.diff = await api(query("/api/git-ui/compare", params));
      } else {
        state.diff = await api(query("/api/git-ui/diff", params));
      }
    }

    async function post(path, body) {
      await api(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.assign({ cwd: cwd() }, body || {})),
      });
      await refresh();
    }

    function renderScreen() {
      resetForCwd(cwd());
      if (!cwd()) return `<section class="mobile-section"><h2>Git</h2><div class="mobile-loading">Select workspace with checkout path</div></section>`;
      if (!state.status && !state.loading && !state.error) refresh();
      if (state.error) return `<section class="mobile-section"><h2>Git</h2><div class="mobile-error">${escapeHtml(state.error)}</div><button class="mobile-btn primary mobile-wide" onclick="HerdrMobileGit.refresh()">Retry</button></section>`;
      if (state.loading && !state.status) return `<section class="mobile-section"><h2>Git</h2><div class="mobile-loading">Loading Git</div></section>`;
      return `<section class="mobile-git"><div class="mobile-git-summary">${renderSummary()}</div>${renderTabs()}${renderActiveTab()}</section>`;
    }

    function renderSummary() {
      const s = state.status || {};
      const dirty = countFiles();
      return `<div><h2>Git</h2><strong>${escapeHtml(s.branch || "detached")}</strong><span>${escapeHtml(s.state || "clean")} · ${dirty} changed</span></div><button class="mobile-btn" onclick="HerdrMobileGit.refresh()">Refresh</button>`;
    }

    function renderTabs() {
      return `<div class="mobile-git-tabs">${[
        ["changes", "Changes"],
        ["commit", "Commit"],
        ["log", "Log"],
        ["stash", "Stash"],
        ["branch", "Branch"],
      ].map(([id, label]) => `<button class="mobile-tab${state.tab === id ? " active" : ""}" onclick="HerdrMobileGit.tab('${id}')">${label}</button>`).join("")}</div>`;
    }

    function renderActiveTab() {
      if (state.tab === "commit") return renderCommit();
      if (state.tab === "log") return renderLog();
      if (state.tab === "stash") return renderStash();
      if (state.tab === "branch") return renderBranch();
      return renderChanges();
    }

    function countFiles() {
      const s = state.status || {};
      return [s.conflicted, s.staged, s.unstaged, s.untracked].reduce((sum, files) => sum + ((files || []).length), 0);
    }

    function renderChanges() {
      if (state.file) return renderFileDetail();
      const s = state.status || {};
      const stageAll = (s.unstaged || []).length + (s.untracked || []).length;
      const unstageAll = (s.staged || []).length;
      return `<div class="mobile-git-actions">${stageAll ? `<button class="mobile-btn primary" onclick="HerdrMobileGit.stageAll()">Stage all</button>` : ""}${unstageAll ? `<button class="mobile-btn" onclick="HerdrMobileGit.unstageAll()">Unstage all</button>` : ""}<button class="mobile-btn" onclick="HerdrMobileGit.stashPush()">Stash</button><button class="mobile-btn" onclick="HerdrMobileGit.rebase()">Rebase</button><button class="mobile-btn danger" onclick="HerdrMobileGit.reset()">Reset</button></div>${renderSection("Conflicted", s.conflicted, "U")}${renderSection("Staged", s.staged, "S")}${renderSection("Unstaged", s.unstaged, "M")}${renderSection("Untracked", s.untracked, "?")}`;
    }

    function renderSection(title, files, kind) {
      files = files || [];
      return `<div class="mobile-git-section"><h3>${escapeHtml(title)} <span>${files.length}</span></h3>${files.length ? files.map((file) => renderFileRow(file, kind)).join("") : `<div class="mobile-loading">None</div>`}</div>`;
    }

    function renderFileRow(file, kind) {
      return `<button class="mobile-row mobile-git-file" onclick="HerdrMobileGit.selectFile(${jsArg(file)},'${kind}')"><strong>${escapeHtml(pathBase(file))}</strong><span>${escapeHtml(file)}</span></button>`;
    }

    function renderFileDetail() {
      const file = currentDiffFile();
      const actions = state.kind === "S"
        ? `<button class="mobile-btn" onclick="HerdrMobileGit.unstageFile()">Unstage</button>`
        : `<button class="mobile-btn primary" onclick="HerdrMobileGit.stageFile()">Stage</button><button class="mobile-btn danger" onclick="HerdrMobileGit.discardFile()">Discard</button>`;
      return `<div class="mobile-git-file-head"><button class="mobile-btn" onclick="HerdrMobileGit.backToFiles()">Files</button><div><strong>${escapeHtml(state.file)}</strong><span>${file ? `+${file.additions || 0} -${file.deletions || 0}` : "No diff"}</span></div></div><div class="mobile-git-actions"><button class="mobile-btn${state.fileMode === "diff" ? " active" : ""}" onclick="HerdrMobileGit.fileMode('diff')">Diff</button><button class="mobile-btn${state.fileMode === "history" ? " active" : ""}" onclick="HerdrMobileGit.fileMode('history')">History</button><button class="mobile-btn${state.fileMode === "blame" ? " active" : ""}" onclick="HerdrMobileGit.fileMode('blame')">Blame</button><button class="mobile-btn${state.fileMode === "edit" ? " active" : ""}" onclick="HerdrMobileGit.fileMode('edit')">Edit</button>${actions}<button class="mobile-btn" onclick="HerdrMobileGit.stashFile()">Stash file</button></div>${renderFileMode(file)}`;
    }

    function renderFileMode(file) {
      if (state.fileMode === "history") return renderFileHistory();
      if (state.fileMode === "blame") return renderBlame();
      if (state.fileMode === "edit") return renderEditor();
      return file ? renderDiffFile(file) : `<div class="mobile-loading">No diff for file</div>`;
    }

    function renderEditor() {
      if (!state.editor || state.editor.path !== state.file) loadEditor().then(render).catch(setError);
      const editor = state.editor;
      if (!editor || editor.path !== state.file || editor.loading) return `<div class="mobile-loading">Loading editor</div>`;
      const error = editor.error ? `<div class="mobile-error">${escapeHtml(editor.error)}</div>` : "";
      return `<div class="mobile-form mobile-git-editor">${error}<p class="mobile-help">Editing working tree file. Save checks file hash to avoid overwriting newer changes.</p><textarea spellcheck="false" oninput="HerdrMobileGit.updateEditor(this.value)">${escapeHtml(editor.content || "")}</textarea><button class="mobile-btn primary mobile-wide" onclick="HerdrMobileGit.saveEditor()">Save file</button></div>`;
    }

    function renderFileHistory() {
      if (!state.history || state.history.file !== state.file) loadHistory().then(render).catch(setError);
      const commits = (state.history && state.history.file === state.file && state.history.commits) || [];
      return `<div class="mobile-git-list">${commits.map((commit) => `<button class="mobile-row" onclick="HerdrMobileGit.showHistoryCommit(${jsArg(commit.hash)})"><strong>${escapeHtml(commit.hash)} ${escapeHtml(commit.message || "")}</strong><span>${escapeHtml(commit.author || "")} ${escapeHtml(commit.date || "")}</span></button>`).join("") || `<div class="mobile-loading">Loading history</div>`}</div>`;
    }

    function renderBlame() {
      const blame = state.blame[state.file];
      if (blame === undefined) loadBlame().then(render).catch(setError);
      if (!blame) return `<div class="mobile-loading">Loading blame</div>`;
      return `<div class="mobile-blame">${Object.keys(blame).map((line) => `<div><span>${escapeHtml(line)}</span><strong>${escapeHtml(blame[line])}</strong></div>`).join("") || `<div class="mobile-loading">No blame data</div>`}</div>`;
    }

    function renderDiffFile(file) {
      return `<div class="mobile-diff">${(file.chunks || []).map((chunk, index) => `<article class="mobile-hunk"><header><span>${escapeHtml(chunk.header)}</span>${state.kind === "S" ? `<button onclick="HerdrMobileGit.unstageHunk(${index})">Unstage hunk</button>` : `<button onclick="HerdrMobileGit.stageHunk(${index})">Stage hunk</button>`}</header><pre>${(chunk.lines || []).map(renderDiffLine).join("\n")}</pre></article>`).join("")}</div>`;
    }

    function renderDiffLine(line) {
      const prefix = line.line_type === "add" ? "+" : line.line_type === "delete" ? "-" : " ";
      return `<span class="${line.line_type || "context"}">${escapeHtml(prefix + (line.content || ""))}</span>`;
    }

    function renderCommit() {
      const staged = ((state.status || {}).staged || []).length;
      return `<div class="mobile-form mobile-git-form"><p class="mobile-help">${staged} staged files</p><label><span>Summary</span><input value="${escapeHtml(state.commitTitle)}" oninput="HerdrMobileGit.updateCommit('commitTitle', this.value)" placeholder="Short imperative summary"></label><label><span>Details</span><textarea oninput="HerdrMobileGit.updateCommit('commitBody', this.value)" placeholder="Optional body">${escapeHtml(state.commitBody)}</textarea></label><button class="mobile-btn primary mobile-wide" onclick="HerdrMobileGit.commit(false)">Commit</button><button class="mobile-btn mobile-wide" onclick="HerdrMobileGit.commit(true)">Amend previous</button>${renderConflicts()}</div>`;
    }

    function renderConflicts() {
      const files = ((state.status || {}).conflicted || []);
      if (!files.length) return "";
      return `<h3>Conflicts</h3>${files.map((file) => `<div class="mobile-git-conflict"><strong>${escapeHtml(file)}</strong><button onclick="HerdrMobileGit.resolve(${jsArg(file)},'ours')">Ours</button><button onclick="HerdrMobileGit.resolve(${jsArg(file)},'theirs')">Theirs</button><button onclick="HerdrMobileGit.resolve(${jsArg(file)},'mark')">Mark</button></div>`).join("")}<div class="mobile-git-actions"><button class="mobile-btn" onclick="HerdrMobileGit.conflictAction('rebase-continue')">Rebase continue</button><button class="mobile-btn danger" onclick="HerdrMobileGit.conflictAction('rebase-abort')">Rebase abort</button><button class="mobile-btn danger" onclick="HerdrMobileGit.conflictAction('merge-abort')">Merge abort</button></div>`;
    }

    function renderLog() {
      if (!state.log) loadLog().then(render).catch(setError);
      const selected = state.selectedLogCommits;
      const compare = selected.length ? `<div class="mobile-git-actions"><button class="mobile-btn primary" onclick="HerdrMobileGit.compareSelected()">Compare</button><button class="mobile-btn" onclick="HerdrMobileGit.clearLogSelection()">Clear</button></div>` : "";
      return `${compare}<div class="mobile-git-list">${((state.log && state.log.lines) || []).map(renderLogLine).join("") || `<div class="mobile-loading">Loading log</div>`}</div>`;
    }

    function renderLogLine(line) {
      const hash = (String(line).match(/[a-f0-9]{7,}/i) || [""])[0];
      const selected = state.selectedLogCommits.includes(hash) ? " active" : "";
      return `<button class="mobile-row${selected}" onclick="HerdrMobileGit.selectLog(${jsArg(hash)})"><strong>${escapeHtml(hash || "graph")}</strong><span>${escapeHtml(String(line).replace(hash, "").trim())}</span></button>`;
    }

    function renderStash() {
      if (!state.stashes) loadStashes().then(render).catch(setError);
      const stashes = (state.stashes && state.stashes.stashes) || [];
      return `<div class="mobile-git-actions"><button class="mobile-btn primary" onclick="HerdrMobileGit.stashPush()">Stash push</button></div>${stashes.map((stash) => `<div class="mobile-git-stash"><strong>${escapeHtml(stash.name)}</strong><span>${escapeHtml(stash.message || "")}</span><button onclick="HerdrMobileGit.applyStash(${jsArg(stash.name)},false)">Apply</button><button onclick="HerdrMobileGit.applyStash(${jsArg(stash.name)},true)">Pop</button><button class="danger" onclick="HerdrMobileGit.dropStash(${jsArg(stash.name)})">Drop</button></div>`).join("") || `<div class="mobile-loading">No stashes</div>`}`;
    }

    function renderBranch() {
      if (!state.branches) loadBranches().then(render).catch(setError);
      const local = ((state.branches && state.branches.local) || []).map((b) => renderBranchRow(b.name, false, b.current)).join("");
      const remote = ((state.branches && state.branches.remote) || []).map((b) => renderBranchRow(b.name, true, b.current)).join("");
      return `<div class="mobile-git-section"><h3>Local</h3>${local || `<div class="mobile-loading">Loading branches</div>`}</div><div class="mobile-git-section"><h3>Remote</h3>${remote || `<div class="mobile-loading">No remote branches</div>`}</div>`;
    }

    function renderBranchRow(name, remote, current) {
      return `<button class="mobile-row${current ? " active" : ""}" onclick="HerdrMobileGit.switchBranch(${jsArg(name)},${remote})"><strong>${escapeHtml(name)}</strong><span>${remote ? "remote" : current ? "current" : "local"}</span></button>`;
    }

    async function loadLog() { state.log = await api(query("/api/git-ui/log", { all: "true" })); }
    async function loadStashes() { state.stashes = await api(query("/api/git-ui/stashes")); }
    async function loadBranches() { state.branches = await api(query("/api/git-ui/branches")); }
    async function loadHistory() {
      const data = await api(query("/api/git-ui/file-history", { file: state.file }));
      state.history = Object.assign({ file: state.file }, data);
    }
    async function loadBlame() {
      const data = await api(query("/api/git-ui/blame", { file: state.file }));
      state.blame[state.file] = parseBlame(data.text || "");
    }
    async function loadEditor() {
      state.editor = { path: state.file, content: "", hash: "", loading: true, error: "" };
      const data = await api(query("/api/git-ui/file", { file: state.file, ref_name: "working" }));
      state.editor = { path: state.file, content: data.content || "", hash: data.hash || "", loading: false, error: "" };
    }

    function parseBlame(text) {
      const byLine = {};
      let author = "";
      let finalLine = 0;
      for (const line of String(text || "").split("\n")) {
        const header = line.match(/^[0-9a-f]{40}\s+\d+\s+(\d+)/);
        if (header) {
          finalLine = Number(header[1]) || 0;
          author = "";
          continue;
        }
        if (line.startsWith("author ")) {
          author = line.slice(7).trim();
          if (finalLine) byLine[finalLine] = author;
        }
      }
      return byLine;
    }

    function currentDiffFile() {
      return ((state.diff && state.diff.files) || []).find((file) => file.path === state.file) || null;
    }

    function pathBase(path) {
      const parts = String(path || "").split("/").filter(Boolean);
      return parts[parts.length - 1] || path;
    }

    function hunkPatch(index) {
      const file = currentDiffFile();
      const chunk = file && file.chunks && file.chunks[index];
      if (!file || !chunk) return "";
      const oldPath = file.old_path || file.path;
      const lines = [`diff --git a/${oldPath} b/${file.path}`, `--- a/${oldPath}`, `+++ b/${file.path}`, chunk.header];
      for (const line of chunk.lines || []) lines.push((line.line_type === "add" ? "+" : line.line_type === "delete" ? "-" : " ") + (line.content || ""));
      return lines.join("\n") + "\n";
    }

    function localNameForRemote(remote) {
      const parts = String(remote || "").split("/");
      return parts.length > 1 ? parts.slice(1).join("/") : remote;
    }

    function setError(error) {
      state.error = error.message || String(error);
      render();
    }

    const apiObject = {
      refresh,
      renderScreen,
      async tab(tab) {
        state.tab = tab;
        state.error = "";
        if (tab === "log" && !state.log) await loadLog().catch(setError);
        if (tab === "stash" && !state.stashes) await loadStashes().catch(setError);
        if (tab === "branch" && !state.branches) await loadBranches().catch(setError);
        render();
      },
      selectFile(file, kind) {
        state.file = file;
        state.kind = kind;
        state.fileMode = "diff";
        state.history = null;
        state.editor = null;
        state.scope = kind === "S" ? "staged" : kind === "M" || kind === "?" ? "working" : "all";
        loadDiff().then(render).catch(setError);
      },
      backToFiles() { state.file = ""; state.scope = "all"; state.compareBase = ""; state.compareTarget = ""; loadDiff().then(render).catch(setError); },
      stageAll() { const s = state.status || {}; post("/api/git-ui/stage", { paths: [...(s.unstaged || []), ...(s.untracked || [])] }); },
      unstageAll() { post("/api/git-ui/unstage", { paths: (state.status || {}).staged || [] }); },
      stageFile() { post("/api/git-ui/stage", { paths: [state.file] }); },
      unstageFile() { post("/api/git-ui/unstage", { paths: [state.file] }); },
      discardFile() { if (confirm(`Discard ${state.file}?`)) post("/api/git-ui/discard", { paths: [state.file], confirmed: true }); },
      stashFile() { const message = prompt("Stash message", `herdr-webui stash ${state.file}`); if (message !== null) post("/api/git-ui/stash", { message, paths: [state.file] }); },
      stashPush() { const message = prompt("Stash message", "herdr-webui stash"); if (message !== null) post("/api/git-ui/stash", { message }); },
      stageHunk(index) { post("/api/git-ui/apply-patch", { patch: hunkPatch(index), cached: true }); },
      unstageHunk(index) { post("/api/git-ui/apply-patch", { patch: hunkPatch(index), cached: true, reverse: true }); },
      updateCommit(field, value) { state[field] = value; },
      async commit(amend) {
        await post("/api/git-ui/commit", { title: state.commitTitle, body: state.commitBody, amend });
        state.commitTitle = "";
        state.commitBody = "";
        render();
      },
      resolve(path, mode) { post("/api/git-ui/conflict-resolve", { path, mode }); },
      conflictAction(action) { post("/api/git-ui/conflict-action", { action }); },
      selectLog(hash) { if (!hash) return; state.selectedLogCommits = state.selectedLogCommits.includes(hash) ? state.selectedLogCommits.filter((item) => item !== hash) : state.selectedLogCommits.concat(hash).slice(-2); render(); },
      clearLogSelection() { state.selectedLogCommits = []; render(); },
      compareSelected() { const s = state.selectedLogCommits; state.compareBase = s[0] || "HEAD"; state.compareTarget = s[1] || "."; state.file = ""; state.scope = "all"; state.tab = "changes"; loadDiff().then(render).catch(setError); },
      fileMode(mode) { state.fileMode = mode; render(); },
      updateEditor(value) { if (state.editor) state.editor.content = value; },
      async saveEditor() {
        if (!state.editor || state.editor.loading) return;
        try {
          await api("/api/git-ui/file", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd: cwd(), path: state.file, content: state.editor.content || "", expected_hash: state.editor.hash || "" }),
          });
          state.editor = null;
          state.fileMode = "diff";
          await refresh();
        } catch (error) {
          state.editor.error = error.message || String(error);
          render();
        }
      },
      showHistoryCommit(hash) { state.compareBase = `${hash}^`; state.compareTarget = hash; state.fileMode = "diff"; state.tab = "changes"; loadDiff().then(render).catch(setError); },
      applyStash(stash, pop) { post("/api/git-ui/stash-apply", { stash, pop }); },
      dropStash(stash) { if (confirm(`Drop ${stash}?`)) post("/api/git-ui/stash-drop", { stash, confirmed: true }); },
      switchBranch(name, remote) { if (remote) post("/api/git-ui/switch", { branch: localNameForRemote(name), create: true, base: name }); else post("/api/git-ui/switch", { branch: name }); state.branches = null; },
      reset() {
        const ref = prompt("Reset to ref", "HEAD");
        if (!ref) return;
        const mode = prompt("Mode: soft, mixed, hard", "soft");
        if (!mode) return;
        const confirmation = mode === "hard" ? prompt('Type "reset hard" to confirm') : "";
        post("/api/git-ui/reset", { ref_name: ref, mode, confirmation });
      },
      rebase() {
        const upstream = prompt("Rebase commits after ref", "HEAD~1");
        if (!upstream) return;
        const onto = prompt("Onto ref. Leave blank for main/master", "");
        if (onto === null) return;
        const confirmation = prompt(`Rebase commits after ${upstream} onto ${onto || "main/master"}. Type "rebase selected" to confirm`);
        if (confirmation === null) return;
        post("/api/git-ui/rebase", { upstream, onto, confirmation });
      },
      resetForWorkspace() { state.status = null; state.diff = null; state.file = ""; state.error = ""; },
    };
    return apiObject;
  }

  globalThis.HerdrMobileGit = { create: createMobileGit };
})();
