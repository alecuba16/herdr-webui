(function () {
  const state = {
    cache: {},
    activeKey: "",
    open: false,
    visible: false,
    renderVersion: 0,
    contextMenu: null,
    branchModal: null,
  };
  const LARGE_FILE_DIFF_LINE_LIMIT = 500;

  document.addEventListener("click", () => {
    if (!state.contextMenu) return;
    state.contextMenu = null;
    if (state.visible) render();
  });
  document.addEventListener("keydown", handleKeydown);

  function active() {
    return state.cache[state.activeKey] || null;
  }

  function handleKeydown(event) {
    if (!state.visible || !event || event.key !== "Escape") return;
    const view = active();
    if (!view) return;
    event.preventDefault();
    event.stopPropagation();
    if (state.contextMenu) {
      state.contextMenu = null;
      render();
      return;
    }
    if (view.tab === "commit") {
      if (!confirm("Leave commit editor and return to changes? Draft is saved locally.")) return;
      saveDraftFromDom();
      window.HerdrGitUi.showChangesList();
    } else if (isChangesListView(view)) {
      if (confirm("Hide Git UI?")) hide();
    } else {
      window.HerdrGitUi.showChangesList();
    }
  }

  function isChangesListView(view) {
    return !!(view && view.tab === "changes" && currentMode() === "changes" && !view.file && !view.sideEditor);
  }

  function gitUiOptions() {
    try {
      return JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
    } catch (_) {
      return {};
    }
  }

  function largeDiffLineLimit() {
    const value = Number(gitUiOptions().gitUiLargeDiffLineLimit);
    return Number.isFinite(value) ? Math.max(0, value) : 2000;
  }

  function fileListMode() {
    return gitUiOptions().gitUiFileListMode === "flat" ? "flat" : "tree";
  }

  function diffLineCount(files) {
    return (files || []).reduce((total, file) => total + (file.chunks || []).reduce((sum, chunk) => sum + ((chunk.lines || []).length), 0), 0);
  }

  function diffFileLineCount(file) {
    return ((file && file.chunks) || []).reduce((sum, chunk) => sum + ((chunk.lines || []).length), 0);
  }

  function hashText(value) {
    let hash = 0;
    const text = String(value || "");
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
    return Math.abs(hash).toString(16);
  }

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function arg(value) {
    return encodeURIComponent(String(value == null ? "" : value)).replace(/'/g, "%27");
  }

  const Syntax = window.HerdrGitSyntax;
  const Actions = window.HerdrGitActions;

  function highlight(code, path) {
    return Syntax.highlight(code, path);
  }

  async function api(url, opt) {
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    const body = await res.json();
    if (!res.ok || body.error) throw Error(body.error || res.statusText);
    return body;
  }

  function workspaceCwd(workspace) {
    if (!workspace) return "";
    if (workspace.worktree && workspace.worktree.checkout_path) return workspace.worktree.checkout_path;
    if (workspace.cwd) return workspace.cwd;
    if (workspace.path) return workspace.path;
    return "";
  }

  function workspaceTitle(workspace) {
    if (!workspace) return "Git";
    if (workspace.worktree) {
      return workspace.worktree.branch || workspace.label || workspace.worktree.checkout_path || "worktree";
    }
    return workspace.label || "main/master";
  }

  function workspaceKey(workspace) {
    return (workspace && workspace.workspace_id) || workspaceCwd(workspace) || "default";
  }

  function workspaceStatus(key, workspace) {
    if (!workspace || !workspaceCwd(workspace)) return "nogit";
    const view = state.cache[key || workspaceKey(workspace)];
    if (view && view.error) return "nogit";
    if (state.visible && state.activeKey === (key || workspaceKey(workspace))) return "open";
    return "closed";
  }

  function compactPath(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    if (parts.length <= 3) return path || "No repo path";
    return `.../${parts.slice(-3).join("/")}`;
  }

  function ensurePanel() {
    let panel = document.getElementById("gitUiPanel");
    if (panel) return panel;
    const shell = document.getElementById("terminalShell");
    panel = document.createElement("div");
    panel.id = "gitUiPanel";
    panel.className = "git-ui-panel";
    panel.style.display = "none";
    if (shell && shell.parentNode) shell.parentNode.appendChild(panel);
    return panel;
  }

  function showPanel(show) {
    const panel = ensurePanel();
    panel.style.display = show ? "grid" : "none";
    if (!show) {
      state.renderVersion++;
      panel.innerHTML = "";
    }
  }

  async function open(workspace) {
    const key = workspaceKey(workspace);
    if (state.visible && state.activeKey === key) {
      hide();
      return;
    }
    saveDraftFromDom();
    state.activeKey = key;
    if (!state.cache[key]) {
      state.cache[key] = {
        cwd: workspaceCwd(workspace),
        title: workspaceTitle(workspace),
        tab: "changes",
        status: null,
        diff: null,
        diffScope: "all",
        file: "",
        error: "",
        loading: true,
        mode: "changes",
        diffContext: 3,
        compareBase: "",
        compareTarget: "",
        blame: {},
        showBlame: false,
        logAll: false,
        selectedLogCommits: [],
        compareFilePaths: [],
        collapsedSections: {},
        collapsedFiles: {},
        loadedLargeDiffFiles: {},
        collapsedDirs: {},
        pendingLogScrollHash: "",
        temporaryHistoryCompare: false,
        sideEditor: null,
      };
    } else {
      state.cache[key].cwd = workspaceCwd(workspace) || state.cache[key].cwd;
      state.cache[key].title = workspaceTitle(workspace);
    }
    state.open = true;
    state.visible = true;
    showPanel(true);
    render();
    if (!active().status) await refresh();
  }

  function hide() {
    saveDraftFromDom();
    saveSideEditorFromDom();
    state.visible = false;
    showPanel(false);
  }

  function close() {
    saveDraftFromDom();
    saveSideEditorFromDom();
    if (state.activeKey) delete state.cache[state.activeKey];
    state.open = false;
    state.visible = false;
    showPanel(false);
  }

  async function refresh() {
    const view = active();
    if (!view) return;
    saveSideEditorFromDom();
    if (!view.cwd) {
      view.error = "No checkout path found for this workspace. Open a linked worktree or add cwd metadata first.";
      view.loading = false;
      if (state.visible) render();
      return;
    }
    view.error = "";
    view.loading = true;
    if (state.visible) render();
    try {
      view.status = await api(`/api/git-ui/status?cwd=${encodeURIComponent(view.cwd)}`);
      await loadDiff();
      view.loading = false;
      if (state.visible) render();
    } catch (err) {
      view.error = err.message || String(err);
      view.loading = false;
      if (state.visible) render();
    }
  }

  async function loadDiff() {
    const view = active();
    if (!view) return;
    const context = Math.max(0, Math.min(200, Number(view.diffContext || 3)));
    if (currentMode() !== "changes") {
      const mergeBase = currentMode() === "current-compare" ? "&merge_base=true" : "";
      const file = view.file ? `&file=${encodeURIComponent(view.file)}` : "";
      view.diff = await api(`/api/git-ui/compare?cwd=${encodeURIComponent(view.cwd)}&base=${encodeURIComponent(view.compareBase || "HEAD")}&target=${encodeURIComponent(view.compareTarget || "HEAD")}&context=${context}${mergeBase}${file}`);
      if (!view.file) view.compareFilePaths = ((view.diff && view.diff.files) || []).map((file) => file.path);
      if (state.visible) render();
      return;
    }
    const scope = view.file ? (view.diffScope || "all") : "all";
    const url = `/api/git-ui/diff?cwd=${encodeURIComponent(view.cwd)}&scope=${encodeURIComponent(scope)}&context=${context}` + (view.file ? `&file=${encodeURIComponent(view.file)}` : "");
    view.diff = await api(url);
    if (state.visible) render();
  }

  async function post(path, body) {
    await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await refresh();
  }

  function currentMode() {
    const view = active() || {};
    return view.mode || "changes";
  }

  function canMutateDiff() {
    return currentMode() === "changes" || currentMode() === "current-compare";
  }

  function allFiles() {
    const s = (active() && active().status) || {};
    return [...(s.conflicted || []), ...(s.staged || []), ...(s.unstaged || []), ...(s.untracked || [])].filter((v, i, a) => v && a.indexOf(v) === i);
  }

  function section(title, files, kind) {
    const view = active() || {};
    const list = files || [];
    const collapsed = !!((view.collapsedSections || {})[title]);
    const action = sectionBulkAction(title, kind, list);
    return `<div class="git-ui-section"><div class="git-ui-section-head"><button class="git-ui-section-toggle" onclick="HerdrGitUi.toggleSection('${arg(title)}')"><span>${treeIcon(collapsed ? "chevron-right" : "chevron-down")}</span><strong>${esc(title)}</strong><em>${list.length}</em></button>${action}</div>${collapsed ? "" : `<div class="git-ui-list" role="tree" aria-label="${esc(title)} files">${list.length ? renderFileTree(list, kind, view) : `<div class="git-ui-empty-row">No ${esc(title.toLowerCase())} files</div>`}</div>`}</div>`;
  }

  function sectionBulkAction(title, kind, files) {
    if (!files || !files.length) return "";
    if (kind === "S") return `<button class="git-ui-section-action" title="Unstage all ${esc(title.toLowerCase())} files" onclick="event.stopPropagation();HerdrGitUi.bulkSectionAction('unstage','${arg(title)}')">−</button>`;
    if (kind === "M" || kind === "?") return `<button class="git-ui-section-action" title="Stage all ${esc(title.toLowerCase())} files" onclick="event.stopPropagation();HerdrGitUi.bulkSectionAction('stage','${arg(title)}')">+</button>`;
    return "";
  }

  function treeIcon(name) {
    const safe = ["chevron-right", "chevron-down", "folder"].includes(name) ? name : "file";
    return `<span class="git-tree-icon git-tree-icon-${safe}" aria-hidden="true"></span>`;
  }

  function renderFileTree(files, kind, view) {
    if (fileListMode() === "flat") return renderFlatFileList(files, kind, view);
    const root = { dirs: new Map(), files: [] };
    for (const file of files) {
      const parts = String(file).split("/").filter(Boolean);
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ name: parts[parts.length - 1] || file, path: file });
    }
    return renderTreeNode(root, "", kind, view, 0);
  }

  function renderFlatFileList(files, kind, view) {
    return (files || [])
      .slice()
      .sort((a, b) => pathBasename(a).localeCompare(pathBasename(b)) || String(a).localeCompare(String(b)))
      .map((file) => renderSideFile(file, pathBasename(file), kind, view, 0))
      .join("");
  }

  function pathBasename(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    return parts[parts.length - 1] || String(path || "");
  }

  function renderTreeNode(node, path, kind, view, level) {
    const entries = [
      ...Array.from(node.dirs.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([dir, child]) => ({ type: "dir", name: dir, child })),
      ...node.files.sort((a, b) => a.name.localeCompare(b.name)).map((file) => ({ type: "file", name: file.name, path: file.path })),
    ];
    return entries.map((entry) => {
      if (entry.type === "dir") {
        const dirPath = path ? `${path}/${entry.name}` : entry.name;
        const collapsed = !!((view.collapsedDirs || {})[dirPath]);
        return `<div class="git-ui-file git-ui-dir" role="treeitem" aria-expanded="${collapsed ? "false" : "true"}" style="--level:${level}" onclick="HerdrGitUi.toggleDir('${arg(dirPath)}')"><span class="git-ui-tree-caret">${treeIcon(collapsed ? "chevron-right" : "chevron-down")}</span><span class="git-ui-tree-icon folder">${treeIcon("folder")}</span><span class="git-ui-path">${esc(entry.name)}</span></div>${collapsed ? "" : renderTreeNode(entry.child, dirPath, kind, view, level + 1)}`;
      }
      return renderSideFile(entry.path, entry.name, kind, view, level);
    }).join("");
  }

  function renderSideFile(file, name, kind, view, level) {
    const summary = fileSummary(file, kind);
    return `<div class="git-ui-file ${view.file === file && view.diffKind === kind ? "active" : ""}" role="treeitem" style="--level:${level}" onclick="HerdrGitUi.selectFile('${arg(file)}','${kind}')" oncontextmenu="return HerdrGitUi.fileMenu(event,'${arg(file)}','${kind}')"><span class="git-ui-tree-caret"></span><span class="git-ui-tree-icon file">${treeIcon("file")}</span><span class="git-ui-path" title="${esc(file)}">${esc(name)}</span><span class="git-ui-file-meta">${summary}</span></div>`;
  }

  function renderContextMenu() {
    const menu = state.contextMenu;
    if (!menu) return "";
    const actions = [];
    if (["S", "M", "?"].includes(menu.kind)) actions.push(`<button onclick="HerdrGitUi.menuAction('stash')">Stash file</button>`);
    if (["M", "?"].includes(menu.kind)) actions.push(`<button onclick="HerdrGitUi.menuAction('discard')">Discard file</button>`);
    if (["M", "?"].includes(menu.kind)) actions.push(`<button onclick="HerdrGitUi.menuAction('stage')">Stage file</button>`);
    if (menu.kind === "S") actions.push(`<button onclick="HerdrGitUi.menuAction('unstage')">Unstage file</button>`);
    if (!actions.length) actions.push(`<span>No file actions</span>`);
    return `<div class="git-ui-menu" style="left:${Math.max(0, menu.x)}px;top:${Math.max(0, menu.y)}px" onclick="event.stopPropagation()">${actions.join("")}</div>`;
  }

  function renderBranchModal() {
    const modal = state.branchModal;
    if (!modal) return "";
    const body = modal.loading
      ? `<div class="git-ui-loading"><span></span><strong>Loading branches</strong></div>`
      : modal.error
        ? `<div class="git-ui-error">${esc(modal.error)}</div>`
        : `<label class="git-ui-branch-field"><span>Branch</span><select id="gitUiBranchSelect">${branchOptions("Local branches", modal.local || [])}${branchOptions("Remote branches", modal.remote || [])}</select></label>`;
    return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>Switch branch</strong><button class="git-ui-btn" onclick="HerdrGitUi.closeBranchModal()">Cancel</button></div>${body}<div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeBranchModal()">Cancel</button><button class="git-ui-btn primary" onclick="HerdrGitUi.switchBranchFromModal()" ${modal.loading || modal.error ? "disabled" : ""}>Switch to</button></div></div></div>`;
  }

  function branchOptions(label, branches) {
    if (!branches.length) return "";
    return `<optgroup label="${esc(label)}">${branches.map((branch) => `<option value="${branch.remote ? "remote:" : "local:"}${esc(branch.name)}" ${branch.current ? "selected" : ""}>${esc(branch.name)}${branch.current ? " (current)" : ""}</option>`).join("")}</optgroup>`;
  }

  function localNameForRemote(remote) {
    const parts = String(remote || "").split("/");
    return parts.length > 1 ? parts.slice(1).join("/") : remote;
  }

  function fileSummary(path, kind) {
    const file = diffFile(path) || {};
    const status = file.status || (kind === "?" ? "added" : "modified");
    const icon = status === "added" ? "+" : status === "deleted" ? "−" : "✎";
    const cls = status === "added" ? "add" : status === "deleted" ? "del" : "edit";
    const additions = Number(file.additions || 0);
    const deletions = Number(file.deletions || 0);
    const counts = `<span class="git-ui-file-counts"><b>+${additions}</b><i>-${deletions}</i></span>`;
    return `<span class="git-ui-file-summary"><span class="git-ui-file-icon ${cls}">${icon}</span>${counts}</span>`;
  }

  function renderSide() {
    const view = active() || {};
    const s = view.status || {};
    const tabs = [{ id: "changes", label: "changes" }, { id: "log", label: "log" }, { id: "stash", label: "stash" }];
    const fileSections = currentMode() === "changes"
      ? `${(s.conflicted || []).length ? section("Conflicted", s.conflicted, "U") : ""}${section("Staged", s.staged, "S")}${section("Unstaged", s.unstaged, "M")}${section("Untracked", s.untracked, "?")}`
      : section("Compared", view.compareFilePaths && view.compareFilePaths.length ? view.compareFilePaths : ((view.diff && view.diff.files) || []).map((file) => file.path), "C");
    const stageLabel = (s.staged || []).length ? "Unstage all" : "Stage all";
    return `<aside class="git-ui-side"><div class="git-ui-head"><div><div class="git-ui-title">Git</div><div class="git-ui-subtitle">${esc(s.state || "closed")} · ${esc(compactPath(s.repo_path))}</div><button class="git-ui-branch-pill" onclick="HerdrGitUi.openBranchModal()">${esc(s.branch || view.title || "No branch")}</button></div></div>${view.error ? `<div class="git-ui-error">${esc(view.error)}</div>` : ""}<div class="git-ui-toolbar"><div class="git-ui-tabs">${tabs.map((tab) => `<button class="git-ui-btn ${view.tab === tab.id ? "active" : ""}" onclick="HerdrGitUi.tab('${tab.id}')">${tab.label}</button>`).join("")}</div></div><div class="git-ui-toolbar"><div class="git-ui-toolbar-title">Worktree actions</div><div class="git-ui-actions"><button class="git-ui-btn primary" onclick="HerdrGitUi.tab('commit')">Commit</button><button class="git-ui-btn" onclick="HerdrGitUi.refresh()">Refresh</button><button class="git-ui-btn" onclick="HerdrGitUi.toggleStageAll()">${stageLabel}</button><button class="git-ui-btn" onclick="HerdrGitUi.compareCurrent()">Current changes</button><button class="git-ui-btn" onclick="HerdrGitUi.rebase()">Rebase</button><button class="git-ui-btn danger" onclick="HerdrGitUi.reset()">Reset</button></div></div>${fileSections}</aside>`;
  }

  function renderFileToolbar(activeTab) {
    const view = active() || {};
    if (!view.file) return "";
    const conflicts = ((((view.status || {}).conflicted) || []).length > 0);
    const compare = currentMode() !== "changes"
      ? `<span class="git-ui-compare-state">Comparing ${esc(view.compareBase || "base")} → ${esc(view.compareTarget || "target")}</span><button class="git-ui-btn" onclick="HerdrGitUi.latestChanges()">Back to latest changes</button>`
      : "";
    const files = (view.diff && view.diff.files) || [];
    const collapsible = activeTab === "changes" && files.length > 0;
    const collapsed = files.filter((file) => view.collapsedFiles && view.collapsedFiles[file.path]).length;
    const collapse = collapsible ? `<button class="git-ui-btn" onclick="HerdrGitUi.${collapsed === files.length ? "expandAllFiles" : "collapseAllFiles"}()">${collapsed === files.length ? "Show all" : "Collapse all"}</button>` : "";
    const blame = activeTab === "changes" ? `<button class="git-ui-btn ${view.showBlame ? "active" : ""}" onclick="HerdrGitUi.toggleBlame()">Blame</button>` : "";
    const sideEditor = view.sideEditor && view.sideEditor.path === view.file
      ? `<button class="git-ui-btn primary" ${view.sideEditor.saving ? "disabled" : ""} onclick="HerdrGitUi.saveSideEditor()">${view.sideEditor.saving ? "Saving..." : "Save edits"}</button><button class="git-ui-btn" onclick="HerdrGitUi.cancelSideEditor()">Cancel edits</button>`
      : activeTab === "changes" && canEditCurrentFile(view)
        ? `<button class="git-ui-btn" onclick="HerdrGitUi.editSideBySide()">Edit side-by-side</button>`
        : "";
    return `<div class="git-ui-log-head"><span class="git-ui-toolbar-title">File view</span><button class="git-ui-btn ${activeTab === "changes" ? "active" : ""}" onclick="HerdrGitUi.latestChanges()">Changes</button><button class="git-ui-btn ${activeTab === "history" ? "active" : ""}" onclick="HerdrGitUi.tab('history')">History</button>${blame}${sideEditor}${conflicts ? `<button class="git-ui-btn ${activeTab === "conflicts" ? "active" : ""}" onclick="HerdrGitUi.tab('conflicts')">Conflicts</button>` : ""}${collapse}${compare}</div>`;
  }

  function canEditCurrentFile(view) {
    if (!view || !view.file || view.file.endsWith("/")) return false;
    if (currentMode() === "readonly-compare" && view.compareTarget !== ".") return false;
    if (view.diffKind === "S" || view.diffScope === "staged") return false;
    const file = diffFile(view.file);
    return !file || file.status !== "deleted";
  }

  function renderDiff() {
    const view = active() || {};
    if (view.sideEditor && view.sideEditor.path === view.file) return `${renderFileToolbar("changes")}${renderSideEditor(view)}`;
    const files = (view.diff && view.diff.files) || [];
    const head = renderFileToolbar("changes");
    if (!files.length) return `${head}<div class="git-ui-muted">No diff.</div>`;
    const limit = largeDiffLineLimit();
    const count = diffLineCount(files);
    if (view.file && limit > 0 && count > limit && !((view.loadedLargeDiffFiles || {})[view.file])) {
      return `${head}<div class="git-ui-large-diff"><strong>Large diff hidden</strong><span>${count} lines exceed ${limit} line limit.</span><button class="git-ui-btn" onclick="HerdrGitUi.loadLargeDiff('${arg(view.file)}')">Load diff</button></div>`;
    }
    return `${head}${files.map(renderDiffFile).join("")}`;
  }

  function renderSideEditor(view) {
    const editor = view.sideEditor || {};
    if (editor.loading) return `<div class="git-ui-editor"><div class="git-ui-loading"><span></span><strong>Loading file editor</strong></div></div>`;
    const error = editor.error ? `<div class="git-ui-side-edit-note error">${esc(editor.error)}</div>` : `<div class="git-ui-side-edit-note">Edit current hunk text on right. Previous hunk stays read-only. Save merges hunk edits into file and recalculates diff.</div>`;
    const hunks = (editor.hunks || []).map(renderEditableHunk).join("") || `<div class="git-ui-muted">No editable hunks for this file.</div>`;
    return `${error}<div class="git-ui-hunk-editor-list">${hunks}</div>`;
  }

  function renderEditableHunk(hunk) {
    const oldText = hunk.oldText || "";
    const currentText = hunk.text || "";
    const readonly = hunk.newStart ? "" : " readonly";
    const meta = hunk.newStart ? `current lines ${hunk.newStart}-${hunk.newEnd}` : "no current lines";
    return `<div class="git-ui-hunk-editor"><div class="git-ui-hunk-head"><span>${esc(hunk.header || "hunk")}</span><span class="git-ui-muted">${esc(meta)}</span></div><div class="git-ui-hunk-editor-grid"><section><div class="git-ui-editor-head"><strong>Previous</strong><span class="git-ui-muted">read-only</span></div><pre class="git-ui-editor-preview del"><code>${renderEditorLines(oldText, "old")}</code></pre></section><section><div class="git-ui-editor-head"><strong>Current</strong><span class="git-ui-muted">editable hunk</span></div><textarea class="git-ui-hunk-edit" data-hunk-index="${hunk.index}" spellcheck="false"${readonly}>${esc(currentText)}</textarea></section></div></div>`;
  }

  function renderEditorLines(content, side) {
    return String(content || "").split("\n").map((line) => `<span class="git-ui-editor-line ${side}">${highlight(line, active().file) || "\n"}</span>`).join("\n");
  }

  function buildEditableHunks(file) {
    return ((file && file.chunks) || []).map((chunk, index) => {
      const oldLines = [];
      const newLines = [];
      const newNumbers = [];
      for (const line of chunk.lines || []) {
        if (line.line_type !== "add") oldLines.push(line.content || "");
        if (line.line_type !== "delete") {
          newLines.push(line.content || "");
          if (line.new_line_number) newNumbers.push(line.new_line_number);
        }
      }
      return {
        index,
        header: chunk.header,
        oldText: oldLines.join("\n"),
        text: newLines.join("\n"),
        newStart: newNumbers.length ? Math.min.apply(null, newNumbers) : 0,
        newEnd: newNumbers.length ? Math.max.apply(null, newNumbers) : 0,
      };
    });
  }

  function renderDiffFile(file) {
    const mode = currentMode();
    const view = active() || {};
    const collapsed = !!(view.collapsedFiles || {})[file.path];
    const large = diffFileLineCount(file) > LARGE_FILE_DIFF_LINE_LIMIT;
    const loadedLarge = !!(view.loadedLargeDiffFiles || {})[file.path];
    const left = mode === "changes" ? "previous" : (view.compareBase || "base");
    const right = mode === "readonly-compare" ? (view.compareTarget || "target") : "current";
    if (view.showBlame && (!large || loadedLarge)) ensureBlame(file.path);
    const restore = mode === "changes" && (view.diffScope || "all") !== "staged"
      ? `<button class="git-ui-btn danger" title="Restore complete file" onclick="HerdrGitUi.discardFile('${arg(file.path)}')">Restore file</button>`
      : "";
    const body = collapsed ? "" : large && !loadedLarge ? renderLargeDiffPlaceholder(file) : (file.chunks || []).map((chunk, index) => renderChunk(file, chunk, index)).join("");
    return `<div class="git-ui-diff-file" data-git-path="${esc(file.path)}"><div class="git-ui-diff-file-head"><button class="git-ui-file-collapse" title="${collapsed ? "Show file" : "Collapse file"}" onclick="HerdrGitUi.toggleFile('${arg(file.path)}')">${collapsed ? "+" : "−"}</button><strong>${esc(file.path)}</strong><span class="git-ui-muted">${esc(left)} → ${esc(right)}</span><span class="git-ui-diff-file-actions"><span class="git-ui-badge add">+${file.additions || 0}</span> <span class="git-ui-badge del">-${file.deletions || 0}</span>${restore}</span></div>${body}</div>`;
  }

  function renderLargeDiffPlaceholder(file) {
    const id = `hidden-diff-reason-${hashText(file.path)}`;
    return `<div class="git-ui-large-file-diff"><button aria-describedby="${id}" class="git-ui-large-file-load" type="button" onclick="HerdrGitUi.loadLargeDiff('${arg(file.path)}')"><strong>Load diff</strong></button><p id="${id}">Large diffs are not rendered by default.</p></div>`;
  }

  function scrollToDiffFile(path) {
    const nodes = Array.from(document.querySelectorAll(".git-ui-diff-file"));
    const target = nodes.find((node) => node.dataset.gitPath === path);
    if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  function ensureBlame(path) {
    const view = active();
    if (!view || !path || view.blame[path] !== undefined || currentMode() === "readonly-compare") return;
    view.blame[path] = null;
    api(`/api/git-ui/blame?cwd=${encodeURIComponent(view.cwd)}&file=${encodeURIComponent(path)}`)
      .then((data) => {
        view.blame[path] = parseBlame(data.text || "");
        if (state.visible) render();
      })
      .catch(() => {
        view.blame[path] = {};
      });
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

  function blameName(path, lineNumber) {
    const view = active() || {};
    if (!view.showBlame) return "";
    const blame = view.blame && view.blame[path];
    const name = blame && lineNumber ? blame[lineNumber] : "";
    if (!name) return "";
    return String(name).split(/\s+/).slice(0, 2).join(" ");
  }

  function renderChunk(file, chunk, index) {
    const path = file.path;
    const scope = (active() || {}).diffScope || "all";
    const hunkButton = scope === "staged"
      ? `<button class="git-ui-btn" title="Unstage this hunk" onclick="HerdrGitUi.unstageHunk('${arg(path)}',${index})">Unstage hunk</button>`
      : scope === "working"
        ? `<button class="git-ui-btn" title="Stage this hunk" onclick="HerdrGitUi.stageHunk('${arg(path)}',${index})">Stage hunk</button>`
        : `<span class="git-ui-muted">select staged/unstaged file for hunk actions</span>`;
    const actions = canMutateDiff()
      ? `<span class="git-ui-hunk-actions">${hunkButton}</span>`
      : `<span class="git-ui-muted">read only</span>`;
    const rows = markChangeGroups(sideBySideRows(chunk));
    return `<div class="git-ui-hunk"><div class="git-ui-hunk-head"><span>${esc(chunk.header)}</span>${actions}</div>${rows.map((row, rowIndex) => renderLine(row, path, index, rows, rowIndex)).join("")}</div>`;
  }

  function sideBySideRows(chunk) {
    const lines = chunk.lines || [];
    const rows = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.line_type === "delete") {
        const deletes = [];
        const adds = [];
        while (lines[i] && lines[i].line_type === "delete") deletes.push(lines[i++]);
        while (lines[i] && lines[i].line_type === "add") adds.push(lines[i++]);
        i--;
        const count = Math.max(deletes.length, adds.length);
        for (let j = 0; j < count; j++) rows.push({ oldLine: deletes[j] || null, newLine: adds[j] || null });
      } else if (line.line_type === "add") {
        rows.push({ oldLine: null, newLine: line });
      } else {
        rows.push({ oldLine: line, newLine: line });
      }
    }
    return rows;
  }

  function renderLine(row, path, hunkIndex, rows, rowIndex) {
    const view = active() || {};
    const scope = view.diffScope || "all";
    const oldLine = row.oldLine;
    const newLine = row.newLine;
    const add = newLine && newLine.line_type === "add";
    const del = oldLine && oldLine.line_type === "delete";
    let cls = add && del ? "git-ui-change" : add ? "git-ui-add" : del ? "git-ui-del" : "";
    if (row.groupStart) cls += " git-ui-change-start";
    if (row.groupEnd) cls += " git-ui-change-end";
    const oldNo = oldLine && oldLine.old_line_number ? oldLine.old_line_number : "";
    const newNo = newLine && newLine.new_line_number ? newLine.new_line_number : "";
    const oldAuthor = blameName(path, oldNo);
    const newAuthor = blameName(path, newNo);
    const status = view.status || {};
    const hasWorkingPath = scope === "working" || (scope === "all" && ([...(status.unstaged || []), ...(status.untracked || [])].includes(path)));
    const blockButton = currentMode() === "changes" && hasWorkingPath && (add || del) && isFirstChange(rows, rowIndex)
      ? `<button class="git-ui-line-action" title="Restore this block" onclick="HerdrGitUi.restoreHunk('${arg(path)}',${hunkIndex})">&gt;&gt;</button>`
      : `<span class="git-ui-line-action-spacer"></span>`;
    const contextControls = rowIndex === 0
      ? `<button class="git-ui-context-arrow" title="Expand lines before; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↑</button>`
      : rowIndex === rows.length - 1
        ? `<button class="git-ui-context-arrow" title="Expand lines after; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↓</button>`
        : "";
    const oldCode = oldLine ? renderDiffCode(oldLine, newLine, path, "old") : "";
    const newCode = newLine ? renderDiffCode(oldLine, newLine, path, "new") : "";
    return `<div class="git-ui-diff-row ${cls}"><div class="git-ui-context-cell">${contextControls}</div><div class="git-ui-code git-ui-code-old">${oldCode}</div><div class="git-ui-line-pair"><span class="git-ui-line-old"><em>${esc(oldAuthor)}</em>${oldNo}</span>${blockButton}<span class="git-ui-line-new"><em>${esc(newAuthor)}</em>${newNo}</span></div><div class="git-ui-code git-ui-code-new">${newCode}</div></div>`;
  }

  function renderDiffCode(oldLine, newLine, path, side) {
    const line = side === "old" ? oldLine : newLine;
    if (!line) return "";
    if (!oldLine || !newLine || oldLine.line_type !== "delete" || newLine.line_type !== "add") {
      return highlight(line.content, path);
    }
    const parts = changedMiddle(oldLine.content || "", newLine.content || "");
    const content = side === "old" ? oldLine.content || "" : newLine.content || "";
    const changed = side === "old" ? parts.oldChanged : parts.newChanged;
    if (!changed.length) return highlight(content, path);
    return `${highlight(content.slice(0, changed.start), path)}<span class="git-ui-word-change">${highlight(content.slice(changed.start, changed.end), path)}</span>${highlight(content.slice(changed.end), path)}`;
  }

  function changedMiddle(oldText, newText) {
    let start = 0;
    while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start++;
    let oldEnd = oldText.length;
    let newEnd = newText.length;
    while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }
    return { oldChanged: { start, end: oldEnd, length: oldEnd - start }, newChanged: { start, end: newEnd, length: newEnd - start } };
  }

  function markChangeGroups(rows) {
    for (let i = 0; i < rows.length; i++) {
      const changed = isChangedRow(rows[i]);
      if (!changed) continue;
      if (!isChangedRow(rows[i - 1])) rows[i].groupStart = true;
      if (!isChangedRow(rows[i + 1])) rows[i].groupEnd = true;
    }
    return rows;
  }

  function isChangedRow(row) {
    return !!(row && ((row.oldLine && row.oldLine.line_type === "delete") || (row.newLine && row.newLine.line_type === "add")));
  }

  function isFirstChange(rows, rowIndex) {
    return !!(rows[rowIndex] && rows[rowIndex].groupStart);
  }

  async function renderLog(version) {
    const view = active();
    const data = await api(`/api/git-ui/log?cwd=${encodeURIComponent(view.cwd)}&all=${view.logAll ? "true" : "false"}`);
    const selected = view.selectedLogCommits || [];
    const compare = Actions.selectedLogToolbar(selected);
    replaceContent(version, `<div class="git-ui-log-scope-head"><span class="git-ui-toolbar-title">History scope</span><button class="git-ui-btn ${!view.logAll ? "active" : ""}" onclick="HerdrGitUi.setLogAll(false)">Current branch</button><button class="git-ui-btn ${view.logAll ? "active" : ""}" onclick="HerdrGitUi.setLogAll(true)">All branches</button>${compare}</div><div class="git-ui-log">${(data.lines || []).map(renderLogLine).join("")}</div>`);
    if (view.pendingLogScrollHash) {
      const hash = view.pendingLogScrollHash;
      view.pendingLogScrollHash = "";
      requestAnimationFrame(() => scrollToLogCommit(hash));
    }
  }

  function renderLogLine(line) {
    const parsed = parseLogGraphLine(line);
    const graph = parsed.graph;
    const hash = parsed.hash;
    const detail = splitLogDecorations(parsed.message);
    const labels = detail.labels.map((label) => `<span>${esc(label)}</span>`).join("");
    const selected = hash && (((active() || {}).selectedLogCommits || []).includes(hash));
    const click = hash ? ` onclick="HerdrGitUi.selectLogCommit(event,'${arg(hash)}')"` : "";
    const cls = hash ? (selected ? " selected" : "") : " graph-only";
    return `<div class="git-ui-log-row${cls}" data-log-hash="${esc(hash)}" title="${esc(detail.message)}"${click}>${renderGraph(graph, !!hash)}<span class="git-ui-log-msg">${hash ? `<strong>${esc(hash)}</strong> ` : ""}${esc(detail.message)}</span><span class="git-ui-log-labels">${labels}</span></div>`;
  }

  function scrollToLogCommit(hash) {
    const nodes = Array.from(document.querySelectorAll(".git-ui-log-row[data-log-hash]"));
    const target = nodes.find((node) => (node.dataset.logHash || "").startsWith(hash));
    if (target) target.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  function parseLogGraphLine(line) {
    const raw = String(line || "");
    const hash = raw.match(/[a-f0-9]{7,}/i);
    if (hash) {
      return {
        graph: raw.slice(0, hash.index),
        hash: hash[0],
        message: cleanLogMessage(raw.slice((hash.index || 0) + hash[0].length)),
      };
    }
    if (/^[|\\/ *._-]+$/.test(raw)) return { graph: raw, hash: "", message: "" };
    return { graph: "* ", hash: "", message: cleanLogMessage(raw) };
  }

  function cleanLogMessage(value) {
    return String(value || "")
      .replace(/^[\s|\\/_.*-]+/, "")
      .trim();
  }

  function splitLogDecorations(value) {
    const text = String(value || "").trim();
    const match = text.match(/^\(([^)]+)\)\s*(.*)$/);
    if (!match) return { labels: [], message: text };
    return {
      labels: match[1].split(",").map((label) => label.trim()).filter(Boolean),
      message: match[2].trim(),
    };
  }

  function renderGraph(graph, hasCommit) {
    const chars = String(graph || "* ").split("");
    const cells = [];
    for (let i = 0; i < Math.min(chars.length, 18); i++) {
      const ch = chars[i];
      let cls = "git-ui-lane";
      let mark = "";
      if (ch === "*") {
        cls += " commit";
        mark = '<i class="git-ui-log-dot"></i>';
      } else if (ch === "|") cls += " vertical";
      else if (ch === "/") cls += " merge-left";
      else if (ch === "\\") cls += " merge-right";
      else if (ch === "_" || ch === "-" || ch === ".") cls += " horizontal";
      cells.push(`<span class="${cls}" style="--lane:${laneColor(i)}">${mark}</span>`);
    }
    if (hasCommit && !graph.includes("*")) cells.unshift('<span class="git-ui-lane commit" style="--lane:var(--accent)"><i class="git-ui-log-dot"></i></span>');
    return `<span class="git-ui-log-graph" aria-hidden="true">${cells.join("")}</span>`;
  }

  function laneColor(index) {
    return ["var(--accent)", "var(--muted)", "var(--border2)", "var(--fg)", "var(--border)", "var(--panel2)"][index % 6];
  }

  async function renderStash(version) {
    const view = active();
    const data = await api(`/api/git-ui/stashes?cwd=${encodeURIComponent(view.cwd)}`);
    replaceContent(version, `<div class="git-ui-actions"><button class="git-ui-btn" onclick="HerdrGitUi.stash()">Stash push</button></div><div class="git-ui-list">${(data.stashes || []).map((s) => `<div class="git-ui-file"><span>${esc(s.name)} ${esc(s.message)}</span><span><button class="git-ui-btn" onclick="HerdrGitUi.applyStash('${arg(s.name)}',false)">Apply</button><button class="git-ui-btn" onclick="HerdrGitUi.applyStash('${arg(s.name)}',true)">Pop</button><button class="git-ui-btn danger" onclick="HerdrGitUi.dropStash('${arg(s.name)}')">Drop</button></span></div>`).join("")}</div>`);
  }

  async function renderHistory() {
    const view = active();
    if (!view.file) return `${renderFileToolbar("history")}<div class="git-ui-muted">Select file first.</div>`;
    const data = await api(`/api/git-ui/file-history?cwd=${encodeURIComponent(view.cwd)}&file=${encodeURIComponent(view.file)}`);
    return `${renderFileToolbar("history")}<div class="git-ui-list">${(data.commits || []).map((c) => `<div class="git-ui-file"><span><strong>${esc(c.hash)}</strong> ${esc(c.message)}</span><span class="git-ui-file-meta"><span class="git-ui-muted">${esc(c.author)} ${esc(c.date)}</span><button class="git-ui-file-action" onclick="event.stopPropagation();HerdrGitUi.showHistoryCommit('${arg(c.hash)}')">changes</button><button class="git-ui-file-action" onclick="event.stopPropagation();HerdrGitUi.gotoLogCommit('${arg(c.hash)}')">log</button></span></div>`).join("") || `<div class="git-ui-empty-row">No history for selected file</div>`}</div>`;
  }

  function renderCommit() {
    const view = active() || {};
    const key = draftKey(view);
    let draft = { title: "", body: "" };
    try { draft = Object.assign(draft, JSON.parse(localStorage.getItem(key) || "{}")); } catch (_) {}
    return `<div class="git-ui-commit"><div class="git-ui-toolbar-title">Commit staged changes</div><label>Summary<input id="gitCommitTitle" class="git-ui-input" value="${esc(draft.title)}" placeholder="Short imperative summary"></label><label>Details<textarea id="gitCommitBody" class="git-ui-textarea" placeholder="Optional body">${esc(draft.body)}</textarea></label><div class="git-ui-actions"><span class="git-ui-action-group"><button class="git-ui-btn" onclick="HerdrGitUi.saveDraft()">Save draft</button><button class="git-ui-btn active" onclick="HerdrGitUi.commit(false)">Commit</button><button class="git-ui-btn" onclick="HerdrGitUi.commit(true)">Amend previous</button></span></div></div>`;
  }

  function renderConflicts() {
    const files = (((active() || {}).status || {}).conflicted || []);
    return `${renderFileToolbar("conflicts")}<div class="git-ui-section"><div class="git-ui-muted">Conflicts</div>${files.map((file) => `<div class="git-ui-file"><span>${esc(file)}</span><span><button class="git-ui-btn" onclick="HerdrGitUi.resolve('${arg(file)}','ours')">Ours</button><button class="git-ui-btn" onclick="HerdrGitUi.resolve('${arg(file)}','theirs')">Theirs</button><button class="git-ui-btn" onclick="HerdrGitUi.resolve('${arg(file)}','mark')">Mark</button></span></div>`).join("") || `<div class="git-ui-empty-row">No conflicts</div>`}</div>`;
  }

  function renderMain() {
    const view = active() || {};
    if (view.loading) return `<main class="git-ui-main"><div class="git-ui-loading"><span></span><strong>Loading Git state</strong></div></main>`;
    let body = "";
    if (view.tab === "changes") body = renderDiff();
    if (view.tab === "commit") body = renderCommit();
    if (view.tab === "conflicts") body = renderConflicts();
    if (view.tab === "log") body = `<div class="git-ui-muted">Loading log...</div>`;
    if (view.tab === "stash") body = `<div class="git-ui-muted">Loading stashes...</div>`;
    if (view.tab === "history") body = `<div class="git-ui-muted">Loading history...</div>`;
    return `<main class="git-ui-main"><div class="git-ui-content">${body}</div></main>`;
  }

  function render() {
    if (!state.visible) return;
    saveSideEditorFromDom();
    const version = ++state.renderVersion;
    const panel = ensurePanel();
    panel.innerHTML = renderSide() + renderMain() + renderContextMenu() + renderBranchModal();
    const view = active() || {};
    if (view.tab === "log") renderLog(version).catch((e) => { view.error = e.message; render(); });
    if (view.tab === "stash") renderStash(version).catch((e) => { view.error = e.message; render(); });
    if (view.tab === "history") renderHistory().then((html) => replaceContent(version, html)).catch((e) => { view.error = e.message; render(); });
  }

  function replaceContent(version, html) {
    if (!state.visible || version !== state.renderVersion) return;
    const content = document.querySelector(".git-ui-content");
    if (content) content.innerHTML = html;
  }

  function draftKey(view) {
    view = view || active() || {};
    return `herdr-web-git-commit-draft:${state.activeKey}:${view.cwd || ""}:${((view.status || {}).branch) || "HEAD"}`;
  }

  function saveDraftFromDom() {
    const title = document.getElementById("gitCommitTitle");
    const body = document.getElementById("gitCommitBody");
    if (!title || !body || !state.activeKey) return;
    try {
      localStorage.setItem(draftKey(), JSON.stringify({ title: title.value, body: body.value, updated_at: Date.now() }));
    } catch (_) {}
  }

  function sideEditorContent(editor) {
    if (!editor) return "";
    const lines = String(editor.content || "").split("\n");
    const edits = Array.from(document.querySelectorAll(".git-ui-hunk-edit[data-hunk-index]")).map((node) => {
      const index = Number(node.dataset.hunkIndex || 0);
      const hunk = (editor.hunks || [])[index];
      return hunk ? Object.assign({}, hunk, { text: node.value }) : null;
    }).filter(Boolean).sort((a, b) => b.newStart - a.newStart);
    for (const hunk of edits) {
      if (!hunk.newStart) continue;
      const replacement = String(hunk.text || "").split("\n");
      lines.splice(hunk.newStart - 1, hunk.newEnd - hunk.newStart + 1, ...replacement);
    }
    return lines.join("\n");
  }

  function saveSideEditorFromDom() {
    const view = active();
    const editor = view && view.sideEditor;
    if (!editor || editor.loading) return;
    document.querySelectorAll(".git-ui-hunk-edit[data-hunk-index]").forEach((node) => {
      const index = Number(node.dataset.hunkIndex || 0);
      if (editor.hunks && editor.hunks[index]) editor.hunks[index].text = node.value;
    });
  }

  function selectedPaths() {
    const view = active() || {};
    return view.file ? [view.file] : allFiles();
  }

  function diffFile(path) {
    const view = active() || {};
    return ((view.diff && view.diff.files) || []).find((file) => file.path === path);
  }

  function hunkPatch(path, index) {
    const file = diffFile(path);
    if (!file || !file.chunks || !file.chunks[index]) return "";
    const chunk = file.chunks[index];
    const oldPath = file.old_path || file.path;
    const lines = [];
    lines.push(`diff --git a/${oldPath} b/${file.path}`);
    lines.push(`--- a/${oldPath}`);
    lines.push(`+++ b/${file.path}`);
    lines.push(chunk.header);
    for (const line of chunk.lines || []) {
      const prefix = line.line_type === "add" ? "+" : line.line_type === "delete" ? "-" : " ";
      lines.push(prefix + (line.content || ""));
    }
    return lines.join("\n") + "\n";
  }

  async function applyHunk(path, index, options) {
    const patch = hunkPatch(path, index);
    if (!patch) return;
    await post("/api/git-ui/apply-patch", Object.assign({ cwd: active().cwd, patch }, options || {}));
  }

  window.HerdrGitUi = {
    open,
    hide,
    close,
    refresh,
    refreshVisible() { if (state.visible) render(); },
    isOpen() { return state.open; },
    isVisible() { return state.visible; },
    isWorkspaceVisible(key) { return state.visible && state.activeKey === key; },
    workspaceStatus,
    statusLabel() { return state.open ? (state.visible ? "open" : "hidden") : "closed"; },
    tab(tab) {
      if (!["changes", "log", "stash", "commit", "conflicts", "history"].includes(tab)) return;
      saveDraftFromDom();
      if (tab === "changes") {
        this.showChangesList();
        return;
      }
      active().tab = tab;
      render();
    },
    showChangesList() {
      const view = active();
      if (!view) return;
      view.mode = "changes";
      view.compareBase = "";
      view.compareTarget = "";
      view.temporaryHistoryCompare = false;
      view.sideEditor = null;
      view.file = "";
      view.diffKind = "";
      view.diffScope = "all";
      view.tab = "changes";
      loadDiff().catch((e) => { view.error = e.message; render(); });
    },
    selectFile(file, kind) {
      const view = active();
      const path = decodeURIComponent(file);
      view.file = path;
      view.diffKind = kind || "";
      if (view.sideEditor && view.sideEditor.path !== path) view.sideEditor = null;
      if (currentMode() !== "changes") {
        loadDiff().then(() => requestAnimationFrame(() => scrollToDiffFile(view.file))).catch((e) => { view.error = e.message; render(); });
        return;
      }
      view.diffScope = kind === "S" ? "staged" : kind === "M" || kind === "?" ? "working" : "all";
      loadDiff().then(() => requestAnimationFrame(() => scrollToDiffFile(view.file))).catch((e) => { view.error = e.message; render(); });
    },
    loadLargeDiff(file) {
      const view = active();
      if (!view) return;
      const path = decodeURIComponent(file);
      view.loadedLargeDiffFiles = Object.assign({}, view.loadedLargeDiffFiles || {}, { [path]: true });
      render();
    },
    fileMenu(event, file, kind) {
      event.preventDefault();
      event.stopPropagation();
      state.contextMenu = { x: event.clientX, y: event.clientY, file: decodeURIComponent(file), kind };
      render();
      return false;
    },
    menuAction(action) {
      const menu = state.contextMenu;
      if (!menu) return;
      state.contextMenu = null;
      if (action === "stash") this.stashFile(encodeURIComponent(menu.file));
      if (action === "discard") this.discardFile(encodeURIComponent(menu.file));
      if (action === "stage") this.stageFile(encodeURIComponent(menu.file));
      if (action === "unstage") this.unstageFile(encodeURIComponent(menu.file));
    },
    toggleStageAll() {
      const view = active();
      const status = (view && view.status) || {};
      const staged = status.staged || [];
      if (staged.length) {
        post("/api/git-ui/unstage", { cwd: view.cwd, paths: staged });
        return;
      }
      const paths = [...(status.unstaged || []), ...(status.untracked || [])];
      if (!paths.length) return;
      post("/api/git-ui/stage", { cwd: view.cwd, paths });
    },
    bulkSectionAction(action, title) {
      const view = active();
      if (!view) return;
      const status = view.status || {};
      title = decodeURIComponent(title);
      const paths = title === "Staged"
        ? status.staged || []
        : title === "Unstaged"
          ? status.unstaged || []
          : title === "Untracked"
            ? status.untracked || []
            : [];
      if (!paths.length) return;
      const verb = action === "unstage" ? "Unstage" : "Stage";
      if (!confirm(`${verb} ${paths.length} ${title.toLowerCase()} file${paths.length === 1 ? "" : "s"}?`)) return;
      post(action === "unstage" ? "/api/git-ui/unstage" : "/api/git-ui/stage", { cwd: view.cwd, paths });
    },
    stageFile(path) { post("/api/git-ui/stage", { cwd: active().cwd, paths: [decodeURIComponent(path)] }); },
    unstageFile(path) { post("/api/git-ui/unstage", { cwd: active().cwd, paths: [decodeURIComponent(path)] }); },
    restoreFile(path) { if (confirm("Restore this file change?")) post("/api/git-ui/discard", { cwd: active().cwd, paths: [decodeURIComponent(path)], confirmed: true }); },
    restoreHunk(path, index) { path = decodeURIComponent(path); if (confirm("Restore this hunk?")) applyHunk(path, index, { reverse: true }); },
    discardFile(path) { path = decodeURIComponent(path); if (confirm(`Restore complete file ${path}?`)) post("/api/git-ui/discard", { cwd: active().cwd, paths: [path], confirmed: true }); },
    toggleBlame() { const view = active(); if (!view) return; view.showBlame = !view.showBlame; render(); },
    async editSideBySide() {
      const view = active();
      if (!canEditCurrentFile(view)) return;
      const file = diffFile(view.file);
      const previousRef = "HEAD";
      view.sideEditor = { path: view.file, content: "", hunks: [], previousRef, hash: "", loading: true, saving: false, error: "" };
      render();
      try {
        const current = await api(`/api/git-ui/file?cwd=${encodeURIComponent(view.cwd)}&file=${encodeURIComponent(view.file)}&ref_name=working`);
        view.sideEditor = {
          path: current.path || view.file,
          content: current.content || "",
          hunks: buildEditableHunks(file),
          previousRef,
          hash: current.hash || "",
          loading: false,
          saving: false,
          error: "",
        };
      } catch (err) {
        view.sideEditor = { path: view.file, content: "", hunks: [], previousRef, hash: "", loading: false, saving: false, error: err.message || String(err) };
      }
      render();
    },
    cancelSideEditor() {
      const view = active();
      if (!view) return;
      view.sideEditor = null;
      render();
    },
    async saveSideEditor() {
      const view = active();
      const editor = view && view.sideEditor;
      if (!view || !editor || editor.loading || editor.saving) return;
      saveSideEditorFromDom();
      editor.saving = true;
      editor.error = "";
      render();
      try {
        await api("/api/git-ui/file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: view.cwd, path: editor.path || view.file, content: sideEditorContent(editor), expected_hash: editor.hash || "" }),
        });
        view.sideEditor = null;
        await refresh();
      } catch (err) {
        editor.saving = false;
        editor.error = err.message || String(err);
        render();
      }
    },
    toggleFile(path) {
      const view = active();
      if (!view) return;
      path = decodeURIComponent(path);
      view.collapsedFiles = view.collapsedFiles || {};
      view.collapsedFiles[path] = !view.collapsedFiles[path];
      render();
    },
    toggleDir(path) {
      const view = active();
      if (!view) return;
      path = decodeURIComponent(path);
      view.collapsedDirs = view.collapsedDirs || {};
      view.collapsedDirs[path] = !view.collapsedDirs[path];
      render();
    },
    toggleSection(title) {
      const view = active();
      if (!view) return;
      title = decodeURIComponent(title);
      view.collapsedSections = view.collapsedSections || {};
      view.collapsedSections[title] = !view.collapsedSections[title];
      render();
    },
    collapseAllFiles() {
      const view = active();
      if (!view) return;
      view.collapsedFiles = {};
      for (const file of ((view.diff && view.diff.files) || [])) view.collapsedFiles[file.path] = true;
      render();
    },
    expandAllFiles() {
      const view = active();
      if (!view) return;
      view.collapsedFiles = {};
      render();
    },
    expandContext() {
      const view = active();
      if (!view) return;
      const current = Math.max(0, Number(view.diffContext || 3));
      view.diffContext = Math.min(200, current < 3 ? 3 : current * 2);
      loadDiff();
    },
    unstageHunk(path, index) { path = decodeURIComponent(path); applyHunk(path, index, { reverse: true, cached: true }); },
    stageHunk(path, index) { path = decodeURIComponent(path); applyHunk(path, index, { cached: true }); },
    discardSelected() { if (confirm("Discard selected working tree changes?")) post("/api/git-ui/discard", { cwd: active().cwd, paths: selectedPaths(), confirmed: true }); },
    stash() { const message = prompt("Stash message", "herdr-webui stash"); if (message !== null) post("/api/git-ui/stash", { cwd: active().cwd, message }); },
    stashFile(path) {
      path = decodeURIComponent(path);
      if (!confirm(`Stash complete file ${path}?`)) return;
      const message = prompt(`Stash message for ${path}`, `herdr-webui stash ${path}`);
      if (message !== null) post("/api/git-ui/stash", { cwd: active().cwd, message, paths: [path] });
    },
    applyStash(stash, pop) { post("/api/git-ui/stash-apply", { cwd: active().cwd, stash: decodeURIComponent(stash), pop }); },
    dropStash(stash) { stash = decodeURIComponent(stash); if (confirm(`Drop ${stash}?`)) post("/api/git-ui/stash-drop", { cwd: active().cwd, stash, confirmed: true }); },
    saveDraft() {
      saveDraftFromDom();
    },
    commit(amend) { post("/api/git-ui/commit", { cwd: active().cwd, title: document.getElementById("gitCommitTitle").value, body: document.getElementById("gitCommitBody").value, amend }); },
    resolve(path, mode) { post("/api/git-ui/conflict-resolve", { cwd: active().cwd, path: decodeURIComponent(path), mode }); },
    async openBranchModal() {
      const view = active();
      if (!view) return;
      state.branchModal = { loading: true, error: "", local: [], remote: [] };
      render();
      try {
        const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(view.cwd)}`);
        state.branchModal = { loading: false, error: "", local: data.local || [], remote: data.remote || [] };
      } catch (err) {
        state.branchModal = { loading: false, error: err.message || String(err), local: [], remote: [] };
      }
      render();
    },
    closeBranchModal() {
      state.branchModal = null;
      render();
    },
    switchBranchFromModal() {
      const view = active();
      const select = document.getElementById("gitUiBranchSelect");
      if (!view || !select || !select.value) return;
      const [kind, ...rest] = select.value.split(":");
      const branch = rest.join(":");
      state.branchModal = null;
      if (kind === "remote") post("/api/git-ui/switch", { cwd: view.cwd, branch: localNameForRemote(branch), create: true, base: branch });
      else post("/api/git-ui/switch", { cwd: view.cwd, branch });
    },
    async compareCurrent() {
      this.latestChanges();
    },
    async compareCommits(base, target) {
      active().compareBase = base;
      active().compareTarget = target;
      active().mode = "readonly-compare";
      active().temporaryHistoryCompare = false;
      active().tab = "changes";
      await loadDiff();
    },
    async showHistoryCommit(hash) {
      hash = decodeURIComponent(hash);
      const view = active();
      if (!view || !hash) return;
      view.compareBase = `${hash}^`;
      view.compareTarget = hash;
      view.mode = "readonly-compare";
      view.temporaryHistoryCompare = true;
      view.tab = "changes";
      await loadDiff();
    },
    gotoLogCommit(hash) {
      hash = decodeURIComponent(hash);
      const view = active();
      if (!view || !hash) return;
      view.pendingLogScrollHash = hash;
      view.logAll = true;
      view.tab = "log";
      render();
    },
    latestChanges() {
      this.showChangesList();
    },
    selectLogCommit(event, hash) {
      hash = decodeURIComponent(hash);
      const view = active();
      if (!view || !hash) return;
      const selected = view.selectedLogCommits || [];
      if (event.shiftKey && selected.includes(hash)) {
        view.selectedLogCommits = selected.filter((value) => value !== hash);
      } else if (event.shiftKey) {
        view.selectedLogCommits = selected.concat(hash).slice(-2);
      } else {
        view.selectedLogCommits = selected.length === 1 && selected[0] === hash ? [] : [hash];
      }
      render();
    },
    clearLogSelection() {
      const view = active();
      if (!view) return;
      view.selectedLogCommits = [];
      render();
    },
    compareSelectedLog() {
      const selected = ((active() || {}).selectedLogCommits || []).slice(0, 2);
      if (selected.length === 1) this.compareCommits(selected[0], ".");
      if (selected.length === 2) this.compareCommits(selected[0], selected[1]);
    },
    setLogAll(value) { active().logAll = !!value; render(); },
    reset() {
      const ref = prompt("Reset to ref", "HEAD");
      if (!ref) return;
      const mode = prompt("Mode: soft, mixed, hard", "soft");
      if (!mode) return;
      const confirmation = mode === "hard" ? prompt('Type "reset hard" to confirm') : "";
      post("/api/git-ui/reset", { cwd: active().cwd, ref_name: ref, mode, confirmation });
    },
    rebase() {
      const view = active();
      if (!view) return;
      const upstream = prompt("Rebase commits after ref", "HEAD~1");
      if (!upstream) return;
      const onto = prompt("Onto ref. Leave blank for main/master", "");
      if (onto === null) return;
      const confirmation = prompt(`Rebase commits after ${upstream} onto ${onto || "main/master"}. Type "rebase selected" to confirm`);
      if (confirmation === null) return;
      post("/api/git-ui/rebase", { cwd: view.cwd, upstream, onto, confirmation });
    },
    resetSelected(mode) {
      const view = active();
      const ref = ((view && view.selectedLogCommits) || [])[0];
      if (!ref || !["soft", "hard"].includes(mode)) return;
      const label = ref.slice(0, 12);
      const confirmation = mode === "hard" ? prompt(`Hard reset to ${label}. Type "reset hard" to confirm`) : (confirm(`Soft reset to ${label}?`) ? "" : null);
      if (confirmation === null) return;
      post("/api/git-ui/reset", { cwd: view.cwd, ref_name: ref, mode, confirmation });
    },
    rebaseAfterSelected() {
      const view = active();
      const upstream = ((view && view.selectedLogCommits) || [])[0];
      if (!view || !upstream) return;
      const confirmation = prompt(`Rebase commits after ${upstream.slice(0, 12)} onto main/master. Type "rebase selected" to confirm`);
      if (confirmation === null) return;
      post("/api/git-ui/rebase", { cwd: view.cwd, upstream, confirmation });
    },
  };
})();
