(function () {
  const state = {
    cache: {},
    activeKey: "",
    open: false,
    visible: false,
    renderVersion: 0,
    contextMenu: null,
    branchModal: null,
    gitOpModal: null,
    cleanupConfirm: null,
    sideScrollTop: 0,
    shortcutPrefixUntil: 0,
  };
  const LARGE_FILE_DIFF_LINE_LIMIT = 500;
  const DEFAULT_GIT_SHORTCUTS = {
    changes: "Digit1",
    commit: "Digit2",
    log: "Digit3",
    stash: "Digit4",
    commitAlt: "KeyC",
    logAlt: "KeyL",
    refresh: "KeyR",
    stageFile: "KeyY",
    unstageFile: "KeyU",
    discardFile: "KeyD",
    stashFile: "KeyZ",
    history: "KeyH",
    blame: "KeyM",
    edit: "KeyE",
    compare: "KeyO",
    branch: "KeyV",
    focusFile: "KeyI",
    help: "Digit0",
  };

  document.addEventListener("click", () => {
    if (!state.contextMenu) return;
    state.contextMenu = null;
    if (state.visible) render();
  });
  window.addEventListener("keydown", handleKeydown, true);

  function active() {
    return state.cache[state.activeKey] || null;
  }

  function handleKeydown(event) {
    if (!state.visible || !event) return;
    const view = active();
    if (!view) return;
    // Git drawer owns keyboard while visible, so terminal/global shortcuts behind it do not receive input.
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    if (isGitShortcutPrefix(event)) {
      state.shortcutPrefixUntil = Date.now() + 5000;
      event.preventDefault();
      return;
    }
    if (handleGitShortcut(event, view)) return;
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (state.contextMenu) {
      state.contextMenu = null;
      render();
      return;
    }
    if (state.branchModal) {
      state.branchModal = null;
      render();
      return;
    }
    if (state.gitOpModal) {
      state.gitOpModal = null;
      render();
      return;
    }
    if (state.cleanupConfirm) {
      state.cleanupConfirm = null;
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

  function handleGitShortcut(event, view) {
    if (event.defaultPrevented || state.shortcutPrefixUntil <= Date.now()) return false;
    state.shortcutPrefixUntil = 0;
    if (event.metaKey || event.ctrlKey || event.altKey) return false;
    if (event.key === "Escape" || editableTarget(event.target)) return false;
    const key = shortcutKey(event);
    const shortcutMap = gitShortcutMap();
    const actions = {
      changes: () => window.HerdrGitUi.showChangesList(),
      commit: () => window.HerdrGitUi.tab("commit"),
      log: () => window.HerdrGitUi.tab("log"),
      stash: () => window.HerdrGitUi.tab("stash"),
      commitAlt: () => window.HerdrGitUi.tab("commit"),
      logAlt: () => window.HerdrGitUi.tab("log"),
      refresh: () => window.HerdrGitUi.refresh(),
      history: () => { if (view.file) window.HerdrGitUi.tab("history"); },
      blame: () => { if (view.file) window.HerdrGitUi.toggleBlame(); },
      edit: () => { if (view.file && canEditCurrentFile(view)) window.HerdrGitUi.editSideBySide(); },
      stageFile: () => { const path = shortcutFilePath(event, view); if (path) window.HerdrGitUi.stageFile(encodeURIComponent(path)); },
      unstageFile: () => { const path = shortcutFilePath(event, view); if (path) window.HerdrGitUi.unstageFile(encodeURIComponent(path)); },
      discardFile: () => { const path = shortcutFilePath(event, view); if (path) window.HerdrGitUi.discardFile(encodeURIComponent(path)); },
      stashFile: () => { const path = shortcutFilePath(event, view); if (path) window.HerdrGitUi.stashFile(encodeURIComponent(path)); },
      compare: () => { if (currentMode() !== "changes") window.HerdrGitUi.compareCurrent(); },
      branch: () => window.HerdrGitUi.openBranchModal(),
      focusFile: () => focusFirstGitFile(),
      help: () => showGitKeyboardHelp(),
    };
    const match = Object.entries(shortcutMap).find(([, value]) => value === key);
    const action = match && actions[match[0]];
    if (!action) return false;
    event.preventDefault();
    action();
    return true;
  }

  function isGitShortcutPrefix(event) {
    return shortcutPrefixFromEvent(event) === gitShortcutPrefixLabel();
  }

  function gitShortcutPrefixLabel() {
    return normalizeShortcutPrefix(gitUiOptions().globalShortcutPrefix || "Ctrl+B");
  }

  function gitShortcutMap() {
    const configured = gitUiOptions().gitShortcuts || {};
    return Object.assign({}, DEFAULT_GIT_SHORTCUTS, configured);
  }

  function shortcutKey(event) {
    return `${event.shiftKey ? "Shift+" : ""}${event.code || event.key}`;
  }

  function normalizeShortcutPrefix(value) {
    const text = String(value || "Ctrl+B").trim();
    if (!text) return "Ctrl+B";
    const parts = text.split("+").map((part) => part.trim()).filter(Boolean);
    const key = parts.pop() || "B";
    const mods = [];
    if (parts.some((part) => /^ctrl|control$/i.test(part))) mods.push("Ctrl");
    if (parts.some((part) => /^alt|option$/i.test(part))) mods.push("Alt");
    if (parts.some((part) => /^shift$/i.test(part))) mods.push("Shift");
    if (parts.some((part) => /^meta|cmd|command$/i.test(part))) mods.push("Meta");
    if (!mods.length) mods.push("Ctrl");
    return mods.concat(key.length === 1 ? key.toUpperCase() : key).join("+");
  }

  function shortcutPrefixFromEvent(event) {
    const mods = [];
    if (event.ctrlKey) mods.push("Ctrl");
    if (event.altKey) mods.push("Alt");
    if (event.shiftKey) mods.push("Shift");
    if (event.metaKey) mods.push("Meta");
    const key = event.key === " " ? "Space" : String(event.key || "");
    if (!key || ["Control", "Alt", "Shift", "Meta"].includes(key)) return "";
    return mods.concat(key.length === 1 ? key.toUpperCase() : key).join("+");
  }

  function editableTarget(target) {
    return !!(target && target.closest && target.closest("input, textarea, select, [contenteditable='true']"));
  }

  function shortcutFilePath(event, view) {
    const row = event.target && event.target.closest && event.target.closest(".git-ui-file[data-git-path]");
    return (row && row.dataset.gitPath) || (view && view.file) || "";
  }

  function focusFirstGitFile() {
    const node = document.querySelector(".git-ui-file[role='treeitem'], .git-ui-btn, .git-ui-file-action");
    if (node && node.focus) node.focus();
  }

  function showGitKeyboardHelp() {
    const map = gitShortcutMap();
    alert(`${gitShortcutPrefixLabel()} then:\n${shortcutDisplay(map.changes)} Changes list\n${shortcutDisplay(map.commit)} Commit\n${shortcutDisplay(map.log)} Log\n${shortcutDisplay(map.stash)} Stash\n${shortcutDisplay(map.refresh)} Refresh\n${shortcutDisplay(map.stageFile)} Stage file\n${shortcutDisplay(map.unstageFile)} Unstage file\n${shortcutDisplay(map.discardFile)} Discard file\n${shortcutDisplay(map.stashFile)} Stash file\n${shortcutDisplay(map.history)} File history\n${shortcutDisplay(map.blame)} Toggle blame\n${shortcutDisplay(map.edit)} Edit file\n${shortcutDisplay(map.compare)} Return to current changes\n${shortcutDisplay(map.branch)} Branch switch\n${shortcutDisplay(map.focusFile)} Focus file list\n${shortcutDisplay(map.help)} Git shortcut help\nEsc Back / hide`);
  }

  function shortcutDisplay(value) {
    return String(value || "")
      .replace(/^Key/, "")
      .replace(/^Digit/, "")
      .replace("BracketLeft", "[")
      .replace("BracketRight", "]")
      .replace("Slash", "/")
      .replace("Period", ".")
      .replace("Comma", ",");
  }

  function gitUiOptions() {
    try {
      return JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
    } catch (_) {
      return {};
    }
  }

  function explorationDefaultDirectory() {
    return String(gitUiOptions().explorationDefaultDirectory || "").trim();
  }

  function largeDiffLineLimit() {
    const value = Number(gitUiOptions().gitUiLargeDiffLineLimit);
    return Number.isFinite(value) ? Math.max(0, value) : 2000;
  }

  function largeChangeFileLimit() {
    const value = Number(gitUiOptions().gitUiLargeChangeFileLimit);
    return Number.isFinite(value) ? Math.max(0, value) : 25;
  }

  function largeSectionFileLimit() {
    const value = Number(gitUiOptions().gitUiLargeSectionFileLimit);
    return Number.isFinite(value) ? Math.max(0, value) : 250;
  }

  function fileListMode() {
    return gitUiOptions().gitUiFileListMode === "flat" ? "flat" : "tree";
  }

  function diffLayoutMode() {
    return gitUiOptions().gitUiDiffLayout === "unified" ? "unified" : "side-by-side";
  }

  function setGitUiOption(key, value) {
    const options = gitUiOptions();
    options[key] = value;
    try { localStorage.setItem("herdr-web-options", JSON.stringify(options)); } catch (_) {}
  }

  function diffLineCount(files) {
    return (files || []).reduce((total, file) => total + (file.chunks || []).reduce((sum, chunk) => sum + ((chunk.lines || []).length), 0), 0);
  }

  function diffFileLineCount(file) {
    return ((file && file.chunks) || []).reduce((sum, chunk) => sum + ((chunk.lines || []).length), 0);
  }

  function loadedLargeDiffPreviewLimit() {
    return 1200;
  }

  function previewDiffFile(file, limit) {
    let remaining = Math.max(0, limit);
    const chunks = [];
    for (const chunk of (file && file.chunks) || []) {
      if (remaining <= 0) break;
      const lines = previewChunkLines(chunk.lines || [], remaining);
      if (!lines.length) break;
      remaining -= lines.length;
      chunks.push(Object.assign({}, chunk, { lines }));
    }
    return Object.assign({}, file, { chunks, preview_large_diff: true });
  }

  function diffFileKey(fileOrPath, kind) {
    const path = typeof fileOrPath === "string" ? fileOrPath : (fileOrPath && fileOrPath.path) || "";
    const diffKind = typeof fileOrPath === "string" ? kind || "" : (fileOrPath && fileOrPath.diff_kind) || "";
    return `${diffKind}:${path}`;
  }

  function previewChunkLines(lines, limit) {
    const out = [];
    for (let i = 0; i < lines.length && out.length < limit; i++) {
      const line = lines[i];
      if (line.line_type !== "delete") {
        out.push(line);
        continue;
      }
      const group = [];
      while (lines[i] && lines[i].line_type === "delete") group.push(lines[i++]);
      while (lines[i] && lines[i].line_type === "add") group.push(lines[i++]);
      i--;
      if (out.length + group.length > limit) break;
      out.push(...group);
    }
    return out;
  }

  function changeSetFileCount(status) {
    const seen = new Set([...(status.conflicted || []), ...(status.staged || []), ...(status.unstaged || []), ...(status.untracked || [])].filter(Boolean));
    return seen.size;
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
  const FileTree = window.HerdrFileTree;

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
    if (window.HerdrWorkspacePath) return window.HerdrWorkspacePath(workspace);
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
    panel.tabIndex = -1;
    panel.style.display = "none";
    if (shell && shell.parentNode) shell.parentNode.appendChild(panel);
    return panel;
  }

  function showPanel(show) {
    const panel = ensurePanel();
    panel.style.display = show ? "grid" : "none";
    syncTerminalVisibility(show);
    if (!show) {
      state.renderVersion++;
      panel.innerHTML = "";
    }
  }

  function syncTerminalVisibility(show) {
    const shell = document.getElementById("terminalShell");
    if (!shell) return;
    const fileBrowser = window.HerdrFileBrowser;
    const fileVisible = !!(fileBrowser && fileBrowser.isVisible && fileBrowser.isVisible());
    shell.style.display = show || fileVisible ? "none" : "";
    if (window.syncShellModeButtons) window.syncShellModeButtons();
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
        titleKind: workspace.worktree ? "Worktree" : "Branch",
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
        expandedLargeSections: {},
        collapsedFiles: {},
        loadedLargeDiffFiles: {},
        collapsedDirs: {},
        expandedCompactDirs: {},
        cleanupRoot: explorationDefaultDirectory() || workspaceCwd(workspace),
        cleanupResult: null,
        cleanupLoading: false,
        cleanupError: "",
        cleanupSelected: {},
        fileFilter: "",
        pendingLogScrollHash: "",
        temporaryHistoryCompare: false,
        sideEditor: null,
      };
    } else {
      state.cache[key].cwd = workspaceCwd(workspace) || state.cache[key].cwd;
      state.cache[key].title = workspaceTitle(workspace);
      state.cache[key].titleKind = workspace.worktree ? "Worktree" : "Branch";
    }
    state.open = true;
    state.visible = true;
    showPanel(true);
    requestAnimationFrame(() => ensurePanel().focus({ preventScroll: true }));
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
      if (state.visible) render();
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
    const changeLimit = largeChangeFileLimit();
    const changeCount = changeSetFileCount(view.status || {});
    if (!view.file && changeLimit > 0 && changeCount > changeLimit && !view.loadLargeChangeSet) {
      view.diff = { files: [], skipped_large_change_set: true, file_count: changeCount, file_limit: changeLimit };
      if (state.visible) render();
      return;
    }
    const url = `/api/git-ui/diff?cwd=${encodeURIComponent(view.cwd)}&scope=${encodeURIComponent(scope)}&context=${context}` + (view.file ? `&file=${encodeURIComponent(view.file)}` : "");
    view.diff = await api(url);
    if (state.visible) render();
  }

  async function post(path, body) {
    const view = active();
    if (!view || view.mutating) return;
    view.mutating = true;
    if (state.visible) render();
    try {
      await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await refresh();
    } catch (err) {
      view.error = err.message || String(err);
      if (state.visible) render();
    } finally {
      view.mutating = false;
      if (state.visible) render();
    }
  }

  async function postJson(path, body) {
    const view = active();
    if (!view || view.mutating) return null;
    view.mutating = true;
    if (state.visible) render();
    try {
      const result = await api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await refresh();
      return result;
    } catch (err) {
      view.error = err.message || String(err);
      if (state.visible) render();
      throw err;
    } finally {
      view.mutating = false;
      if (state.visible) render();
    }
  }

  function currentMode() {
    const view = active() || {};
    return view.mode || "changes";
  }

  function canMutateDiff() {
    return currentMode() === "changes" || currentMode() === "current-compare";
  }

  function hasCommittableChanges(status) {
    const s = status || {};
    return [s.conflicted, s.staged, s.unstaged, s.untracked].some((files) => Array.isArray(files) && files.length > 0);
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
    const limit = largeSectionFileLimit();
    const limited = limit > 0 && list.length > limit && !((view.expandedLargeSections || {})[title]);
    const visibleList = limited ? list.slice(0, limit) : list;
    const largeNote = limited ? `<div class="git-ui-large-file-diff"><button class="git-ui-large-file-load" type="button" onclick="HerdrGitUi.expandLargeSection('${arg(title)}')"><strong>Show all ${esc(title.toLowerCase())} files</strong></button><p>Showing first ${limit} of ${list.length} files to keep browser responsive.</p></div>` : "";
    return `<div class="git-ui-section"><div class="git-ui-section-head"><div class="git-ui-section-toggle"><button class="git-ui-section-collapse" type="button" onclick="HerdrGitUi.toggleSection('${arg(title)}')"><span>${treeIcon(collapsed ? "chevron-right" : "chevron-down")}</span><strong>${esc(title)}</strong></button>${action}<em>${list.length}</em></div></div>${collapsed ? "" : `<div class="git-ui-list" role="tree" aria-label="${esc(title)} files">${visibleList.length ? renderFileTree(visibleList, kind, view) : `<div class="git-ui-empty-row">No ${esc(title.toLowerCase())} files</div>`}${largeNote}</div>`}</div>`;
  }

  function sectionBulkAction(title, kind, files) {
    if (!files || !files.length) return "";
    if (kind === "S") return `<button class="git-ui-section-action" type="button" title="Unstage all ${esc(title.toLowerCase())} files" onclick="event.stopPropagation();HerdrGitUi.bulkSectionAction('unstage','${arg(title)}')">remove all</button>`;
    if (kind === "M" || kind === "?") return `<button class="git-ui-section-action" type="button" title="Stage all ${esc(title.toLowerCase())} files" onclick="event.stopPropagation();HerdrGitUi.bulkSectionAction('stage','${arg(title)}')">add all</button>`;
    return "";
  }

  function treeIcon(name) {
    const safe = ["chevron-right", "chevron-down", "folder"].includes(name) ? name : "file";
    return `<span class="git-tree-icon git-tree-icon-${safe}" aria-hidden="true"></span>`;
  }

  function renderFileTree(files, kind, view) {
    if (FileTree && FileTree.renderPathTree) {
      return FileTree.renderPathTree(files, {
        callback: "HerdrGitUi",
        toggleMethod: "toggleDir",
        selectMethod: "selectFile",
        activateMethod: "activateTreeItem",
        contextMethod: "fileMenu",
        dataPrefix: "git",
        rowClass: "git-ui-file",
        dirClass: "git-ui-file git-ui-dir",
        kind,
        selectedPath: view.file,
        selectedKind: view.diffKind,
        collapsedDirs: view.collapsedDirs || {},
        expandedCompactDirs: view.expandedCompactDirs || {},
        expandCompactMethod: "expandCompactDir",
        filterTerm: view.fileFilter || "",
        metaForPath: fileSummary,
      });
    }
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
        return `<div class="git-ui-file git-ui-dir" role="treeitem" tabindex="0" aria-expanded="${collapsed ? "false" : "true"}" style="--level:${level}" onclick="HerdrGitUi.toggleDir('${arg(dirPath)}')" onkeydown="HerdrGitUi.activateTreeItem(event)"><span class="git-ui-tree-caret">${treeIcon(collapsed ? "chevron-right" : "chevron-down")}</span><span class="git-ui-tree-icon folder">${treeIcon("folder")}</span><span class="git-ui-path">${esc(entry.name)}</span></div>${collapsed ? "" : renderTreeNode(entry.child, dirPath, kind, view, level + 1)}`;
      }
      return renderSideFile(entry.path, entry.name, kind, view, level);
    }).join("");
  }

  function renderSideFile(file, name, kind, view, level) {
    const summary = fileSummary(file, kind);
    return `<div class="git-ui-file ${view.file === file && view.diffKind === kind ? "active" : ""}" role="treeitem" tabindex="0" data-git-path="${esc(file)}" data-git-kind="${esc(kind)}" style="--level:${level}" onclick="HerdrGitUi.selectFile('${arg(file)}','${kind}')" onkeydown="HerdrGitUi.activateTreeItem(event)" oncontextmenu="return HerdrGitUi.fileMenu(event,'${arg(file)}','${kind}')"><span class="git-ui-tree-caret"></span><span class="git-ui-tree-icon file">${treeIcon("file")}</span><span class="git-ui-path" title="${esc(file)}">${FileTree && FileTree.highlight ? FileTree.highlight(name, (active() || {}).fileFilter) : esc(name)}</span><span class="git-ui-file-meta">${summary}</span></div>`;
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
    const cwd = esc(modal.cwd || "");
    const body = modal.loading
      ? `<div class="git-ui-loading"><span></span><strong>Loading branches</strong></div>`
      : modal.error
        ? `<div class="git-ui-error">${esc(modal.error)}</div>`
        : `<label class="git-ui-branch-field"><span>Branch</span><select id="gitUiBranchSelect">${branchOptions("Local branches", modal.local || [])}${branchOptions("Remote branches", modal.remote || [])}</select></label>`;
    const dir = `<label class="git-ui-branch-field"><span>Git directory</span><div class="git-ui-inline-field"><input id="gitUiBranchCwd" value="${cwd}" placeholder="/path/to/repo"><button class="git-ui-btn" onclick="HerdrDirectoryPicker.openInput('gitUiBranchCwd')">Browse</button><button class="git-ui-btn" onclick="HerdrGitUi.loadBranchModalCwd()" ${modal.loading ? "disabled" : ""}>Load</button></div></label>`;
    return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>Switch branch</strong></div>${dir}${body}<div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeBranchModal()">Cancel</button><button class="git-ui-btn" onclick="HerdrGitUi.applyBranchModalCwd()" ${modal.loading || modal.error ? "disabled" : ""}>Use directory</button><button class="git-ui-btn primary" onclick="HerdrGitUi.switchBranchFromModal()" ${modal.loading || modal.error ? "disabled" : ""}>Switch to</button></div></div></div>`;
  }

  function renderCleanupConfirm() {
    const modal = state.cleanupConfirm;
    if (!modal) return "";
    const items = modal.items || [];
    return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal git-ui-cleanup-modal"><div class="git-ui-modal-head"><strong>Delete ${items.length} Git cleanup item${items.length === 1 ? "" : "s"}?</strong></div><div class="git-ui-muted">Git will use safe delete first. If Git rejects that because force is required, Herdr retries with force.</div><pre class="git-ui-cleanup-confirm-list">${esc(items.map(cleanupItemLabel).join("\n"))}</pre><div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.cancelCleanupDelete()">Cancel</button><button class="git-ui-btn danger" onclick="HerdrGitUi.confirmCleanupDelete()">Delete selected</button></div></div></div>`;
  }

  function renderGitOpModal() {
    const modal = state.gitOpModal;
    if (!modal) return "";
    const branchSelect = renderGitOpBranchSelect(modal);
    const error = modal.error ? `<div class="git-ui-error">${esc(modal.error)}</div>` : "";
    const loading = modal.loading ? `<div class="git-ui-muted">Loading branches...</div>` : "";
    const common = `${loading}${branchSelect}`;
    if (modal.type === "pull") {
      return renderGitOpModalShell("Pull changes", `${common}${renderGitOpModeSelect("Pull option", [["regular", "Regular pull"], ["rebase", "Pull with rebase"], ["ff-only", "Fast-forward only"], ["no-ff", "No fast-forward"], ["force", "Force pull"]])}${error}`, "Pull", "primary", "runPullFromModal");
    }
    if (modal.type === "push" || modal.type === "force-push") {
      const force = modal.type === "force-push";
      const note = force ? `<div class="git-ui-muted">Use force-with-lease unless you intentionally overwrite remote history.</div>` : "";
      const body = `${common}${renderGitOpModeSelect("Push option", [["regular", "Regular push"], ["force-with-lease", "Force with lease"], ["force", "Force push"]], force ? "force-with-lease" : "regular")}${note}${error}`;
      return renderGitOpModalShell(force ? "Force push" : "Push changes", body, force ? "Force push" : "Push", force ? "danger" : "primary", "runPushFromModal");
    }
    if (modal.type === "rebase") {
      const body = `${common}<label class="git-ui-branch-field"><span>Rebase commits after</span><input id="gitUiRebaseUpstream" value="HEAD" placeholder="HEAD"></label><label class="git-ui-check-row"><input id="gitUiRebasePullFirst" type="checkbox" checked><span>First pull selected branch before rebasing</span></label>${error}`;
      return renderGitOpModalShell("Rebase branch", body, "Rebase", "primary", "runRebaseFromModal");
    }
    return "";
  }

  function renderGitOpBranchSelect(modal) {
    const status = ((active() || {}).status) || {};
    const currentBranch = status.branch || "";
    const branchNames = (modal.branches || []).map((branch) => branch.name || branch).concat([currentBranch, status.upstream || "", "main", "master"]);
    const branches = branchNames.filter((value, index, array) => value && array.indexOf(value) === index);
    const defaultBranch = modal.type === "rebase" ? (branches.find((branch) => branch === "main" || branch === "master") || "") : modal.type && modal.type.includes("push") ? currentBranch : "";
    const options = branches.map((branch) => `<option value="${esc(branch)}" ${branch === defaultBranch ? "selected" : ""}>${esc(branch)}${branch === currentBranch ? " (current)" : ""}</option>`).join("");
    return `<label class="git-ui-branch-field"><span>Branch</span><select id="gitUiOpBranch"><option value="" ${defaultBranch ? "" : "selected"}>Current upstream</option>${options}</select></label>`;
  }

  function renderGitOpModeSelect(label, options, selected = "regular") {
    return `<label class="git-ui-branch-field"><span>${esc(label)}</span><select id="gitUiOpMode">${options.map(([value, text]) => `<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(text)}</option>`).join("")}</select></label>`;
  }

  function renderGitOpModalShell(title, body, actionLabel, actionClass, actionMethod) {
    return `<div class="git-ui-modal-backdrop"><div class="git-ui-modal"><div class="git-ui-modal-head"><strong>${esc(title)}</strong></div>${body}<div class="git-ui-modal-actions"><button class="git-ui-btn" onclick="HerdrGitUi.closeGitOpModal()">Cancel</button><button class="git-ui-btn ${esc(actionClass)}" onclick="HerdrGitUi.${actionMethod}()">${esc(actionLabel)}</button></div></div></div>`;
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
    const view = active() || {};
    const statusSummaries = ((view.status || {}).summaries) || {};
    const summary = kind === "S" ? (statusSummaries.staged || {})[path] : kind === "M" ? (statusSummaries.unstaged || {})[path] : null;
    const file = diffFile(path) || summary || {};
    const status = file.status || (kind === "?" ? "added" : "modified");
    const icon = status === "added" ? "+" : status === "deleted" ? "−" : "✎";
    const cls = status === "added" ? "add" : status === "deleted" ? "del" : "edit";
    const hasCounts = Number.isFinite(Number(file.additions)) && Number.isFinite(Number(file.deletions));
    const counts = hasCounts ? `<span class="git-ui-file-counts"><b>+${Number(file.additions)}</b><i>-${Number(file.deletions)}</i></span>` : "";
    return `<span class="git-ui-file-summary"><span class="git-ui-file-icon ${cls}">${icon}</span>${counts}</span>`;
  }

  function renderGitViewTabs(tabs, activeTab) {
    return `<div class="git-ui-view-toggle-group" role="tablist" aria-label="Git views">${tabs.map((tab) => `<button class="git-ui-view-toggle ${tab.id === "cleanup" ? "git-ui-cleanup-tab" : ""} ${activeTab === tab.id ? "active" : ""}" type="button" role="tab" aria-selected="${activeTab === tab.id ? "true" : "false"}" onclick="HerdrGitUi.tab('${tab.id}')">${tab.label}</button>`).join("")}</div>`;
  }

  function renderSide() {
    const view = active() || {};
    const s = view.status || {};
    const tabs = [{ id: "changes", label: "changes" }, { id: "log", label: "log" }, { id: "stash", label: "stash" }, { id: "cleanup", label: "cleanup" }];
    const filter = String(view.fileFilter || "").trim();
    const fileSections = currentMode() === "changes"
      ? `${(s.conflicted || []).length ? section("Conflicted", filterFiles(s.conflicted, filter), "U") : ""}${section("Staged", filterFiles(s.staged, filter), "S")}${section("Unstaged", filterFiles(s.unstaged, filter), "M")}${section("Untracked", filterFiles(s.untracked, filter), "?")}`
      : section("Compared", filterFiles(view.compareFilePaths && view.compareFilePaths.length ? view.compareFilePaths : ((view.diff && view.diff.files) || []).map((file) => file.path), filter), "C");
    const branchLabel = `${view.titleKind || "Branch"}: ${s.branch || view.title || "No branch"}`;
    const currentChangesButton = currentMode() !== "changes" ? `<button class="git-ui-btn" title="Return to current working tree changes" onclick="HerdrGitUi.compareCurrent()">↩ Current changes</button>` : "";
    const commitButton = hasCommittableChanges(s) ? `<button class="git-ui-btn primary" onclick="HerdrGitUi.tab('commit')">Commit</button>` : "";
    return `<aside class="git-ui-side" onscroll="HerdrGitUi.sideScroll(this)"><div class="git-ui-head"><div class="git-ui-head-main"><div class="git-ui-title-row"><div class="git-ui-title">Git</div>${appRefreshIconButton({ className: "git-ui-refresh-icon", title: "Refresh", label: "Refresh Git state", spinning: !!view.refreshAnimating, onclick: "HerdrGitUi.refreshWithSpin()" })}</div><div class="git-ui-subtitle">${esc(s.state || "closed")} · ${esc(compactPath(s.repo_path))}</div><button class="git-ui-branch-pill" title="Change Git directory or switch branch" onclick="HerdrGitUi.openBranchModal()"><span>${esc(branchLabel)}</span><b>↗</b></button></div></div>${view.error ? `<div class="git-ui-error">${esc(view.error)}</div>` : ""}<div class="git-ui-toolbar git-ui-view-toolbar">${renderGitViewTabs(tabs, view.tab)}</div><div class="git-ui-toolbar"><div class="git-ui-toolbar-title">Worktree actions</div><div class="git-ui-actions">${commitButton}<button class="git-ui-btn" onclick="HerdrGitUi.openPullModal()">Pull</button><button class="git-ui-btn" onclick="HerdrGitUi.openPushModal()">Push</button><button class="git-ui-btn danger" onclick="HerdrGitUi.openForcePushModal()">Force push</button>${currentChangesButton}<button class="git-ui-btn" onclick="HerdrGitUi.rebase()">Rebase</button><button class="git-ui-btn danger" onclick="HerdrGitUi.reset()">Reset</button></div></div><label class="git-ui-file-filter"><span class="git-ui-file-filter-icon" aria-hidden="true"></span><input value="${esc(view.fileFilter || "")}" placeholder="Filter files" oninput="HerdrGitUi.filterFiles(this.value)"></label>${fileSections}</aside>`;
  }

  function filterFiles(files, filter) {
    const needle = String(filter || "").trim().toLowerCase();
    if (!needle) return files || [];
    return (files || []).filter((file) => String(file || "").toLowerCase().includes(needle));
  }

  function renderFileToolbar(activeTab) {
    const view = active() || {};
    const conflicts = ((((view.status || {}).conflicted) || []).length > 0);
    const compare = currentMode() !== "changes"
      ? `<span class="git-ui-compare-state">Comparing ${esc(view.compareBase || "base")} → ${esc(view.compareTarget || "target")}</span><button class="git-ui-btn" onclick="HerdrGitUi.latestChanges()">Return to current changes</button>`
      : "";
    const files = (view.diff && view.diff.files) || [];
    const collapsible = activeTab === "changes" && files.length > 0;
    const collapsed = files.filter((file) => view.collapsedFiles && view.collapsedFiles[file.path]).length;
    const collapse = collapsible ? `<button class="git-ui-btn" onclick="HerdrGitUi.${collapsed === files.length ? "expandAllFiles" : "collapseAllFiles"}()">${collapsed === files.length ? "Show all" : "Collapse all"}</button>` : "";
    const changes = currentMode() === "changes" ? `<button class="git-ui-btn ${activeTab === "changes" ? "active" : ""}" onclick="HerdrGitUi.latestChanges()">Changes</button>` : "";
    const history = view.file ? `<button class="git-ui-btn ${activeTab === "history" ? "active" : ""}" onclick="HerdrGitUi.tab('history')">History</button>` : "";
    const blame = activeTab === "changes" && view.file ? `<button class="git-ui-btn ${view.showBlame ? "active" : ""}" onclick="HerdrGitUi.toggleBlame()">Blame</button>` : "";
    const layout = diffLayoutMode();
    const layoutToggle = `<button class="git-ui-btn" title="Switch diff layout" onclick="HerdrGitUi.toggleDiffLayout()">${layout === "unified" ? "Side-by-side" : "Unified"}</button>`;
    const sideEditor = view.sideEditor && view.sideEditor.path === view.file
      ? `<button class="git-ui-btn primary" ${view.sideEditor.saving ? "disabled" : ""} onclick="HerdrGitUi.saveSideEditor()">${view.sideEditor.saving ? "Saving..." : "Save edits"}</button><button class="git-ui-btn" onclick="HerdrGitUi.cancelSideEditor()">Cancel edits</button>`
      : activeTab === "changes" && canEditCurrentFile(view)
        ? `<button class="git-ui-btn" onclick="HerdrGitUi.editSideBySide()">Edit side-by-side</button>`
        : "";
    return `<div class="git-ui-log-head"><span class="git-ui-toolbar-title">${view.file ? "File view" : "Diff view"}</span>${changes}${history}${blame}${layoutToggle}${sideEditor}${conflicts ? `<button class="git-ui-btn ${activeTab === "conflicts" ? "active" : ""}" onclick="HerdrGitUi.tab('conflicts')">Conflicts</button>` : ""}${collapse}${compare}</div>`;
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
    if (view.diff && view.diff.skipped_large_change_set) {
      const shells = largeChangeDiffShells(view);
      return `${head}${shells.length ? shells.map(renderDiffFile).join("") : `<div class="git-ui-muted">No diff.</div>`}`;
    }
    if (!files.length) return `${head}<div class="git-ui-muted">No diff.</div>`;
    const limit = largeDiffLineLimit();
    const count = diffLineCount(files);
    if (view.file && limit > 0 && count > limit && !((view.loadedLargeDiffFiles || {})[view.file])) {
      return `${head}<div class="git-ui-large-diff"><strong>Large diff hidden</strong><span>${count} lines exceed ${limit} line limit.</span><button class="git-ui-btn" onclick="HerdrGitUi.loadLargeDiff('${arg(view.file)}')">Load diff</button></div>`;
    }
    return `${head}${files.map(renderDiffFile).join("")}`;
  }

  function largeChangeDiffShells(view) {
    const loaded = (view.diff && view.diff.files) || [];
    const loadedByKey = new Map(loaded.map((file) => [`${file.diff_kind || ""}:${file.path}`, file]));
    return largeChangeFileItems(view).map((item) => loadedByKey.get(`${item.kind}:${item.path}`) || largeChangeHiddenFile(view, item));
  }

  function largeChangeFileItems(view) {
    const status = (view && view.status) || {};
    const items = [];
    const push = (paths, kind) => (paths || []).forEach((path) => items.push({ path, kind }));
    push(status.conflicted, "U");
    push(status.staged, "S");
    push(status.unstaged, "M");
    push(status.untracked, "?");
    return items.filter((item, index) => items.findIndex((other) => other.path === item.path && other.kind === item.kind) === index);
  }

  function largeChangeHiddenFile(view, item) {
    const statusSummaries = ((view.status || {}).summaries) || {};
    const summary = item.kind === "S" ? (statusSummaries.staged || {})[item.path] : item.kind === "M" ? (statusSummaries.unstaged || {})[item.path] : null;
    return Object.assign({ path: item.path, diff_kind: item.kind, hidden_large_change: true, chunks: [] }, summary || {});
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
    return `<div class="git-ui-hunk-editor"><div class="git-ui-hunk-head"><span>${esc(hunk.header || "hunk")}</span><span class="git-ui-muted">${esc(meta)}</span></div><div class="git-ui-hunk-editor-grid"><section><div class="git-ui-editor-head"><strong>Previous</strong><span class="git-ui-muted">read-only</span></div><div class="git-ui-hunk-edit-mount git-ui-hunk-old-mount" data-hunk-index="${hunk.index}" data-editor-side="old" data-readonly="true"></div><textarea class="git-ui-hunk-old git-ui-hunk-old-hidden git-ui-hunk-edit-hidden" data-hunk-index="${hunk.index}" spellcheck="false" readonly>${esc(oldText)}</textarea></section><section><div class="git-ui-editor-head"><strong>Current</strong><span class="git-ui-muted">editable hunk</span></div><div class="git-ui-hunk-edit-mount git-ui-hunk-current-mount" data-hunk-index="${hunk.index}" data-editor-side="current" data-readonly="${hunk.newStart ? "false" : "true"}"></div><textarea class="git-ui-hunk-edit git-ui-hunk-current-hidden git-ui-hunk-edit-hidden" data-hunk-index="${hunk.index}" spellcheck="false"${readonly}>${esc(currentText)}</textarea></section></div></div>`;
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
    const lineCount = diffFileLineCount(file);
    const large = lineCount > LARGE_FILE_DIFF_LINE_LIMIT;
    const loadedLarge = !!(view.loadedLargeDiffFiles || {})[file.path];
    const renderFullLarge = !!(view.fullLargeDiffFiles || {})[diffFileKey(file)];
    const left = mode === "changes" ? fileDiffLeftLabel(file) : (view.compareBase || "base");
    const right = mode === "readonly-compare" ? (view.compareTarget || "target") : "current";
    if (view.showBlame && (!large || loadedLarge)) ensureBlame(file.path);
    const restore = mode === "changes"
      ? `<button class="git-ui-btn danger" title="Restore complete file" onclick="HerdrGitUi.discardFile('${arg(file.path)}')">Restore file</button>`
      : "";
    const body = collapsed
      ? ""
      : file.hidden_large_change
        ? renderLargeChangePlaceholder(file)
        : large && !loadedLarge
          ? renderLargeDiffPlaceholder(file)
          : renderDiffFileBody(file, lineCount, large, renderFullLarge);
    return `<div class="git-ui-diff-file" data-git-path="${esc(file.path)}"><div class="git-ui-diff-file-head"><button class="git-ui-file-collapse" title="${collapsed ? "Show file" : "Collapse file"}" onclick="HerdrGitUi.toggleFile('${arg(file.path)}')">${collapsed ? "+" : "−"}</button><strong>${esc(file.path)}</strong><span class="git-ui-muted">${esc(left)} → ${esc(right)}</span><span class="git-ui-diff-file-actions"><span class="git-ui-badge add">+${file.additions || 0}</span> <span class="git-ui-badge del">-${file.deletions || 0}</span>${restore}</span></div>${body}</div>`;
  }

  function renderDiffFileBody(file, lineCount, large, renderFullLarge) {
    const limit = loadedLargeDiffPreviewLimit();
    const preview = large && !renderFullLarge && lineCount > limit;
    const renderedFile = preview ? previewDiffFile(file, limit) : file;
    const body = (renderedFile.chunks || []).map((chunk, index) => renderChunk(renderedFile, chunk, index)).join("");
    if (!preview) return body;
    const renderedCount = diffFileLineCount(renderedFile);
    return `${body}<div class="git-ui-large-file-diff"><button class="git-ui-large-file-load" type="button" onclick="HerdrGitUi.renderFullLargeDiff('${arg(file.path)}','${arg(file.diff_kind || "")}')"><strong>Render full diff</strong></button><p>Showing ${renderedCount} preview lines from complete change groups out of ${lineCount} lines to reduce browser CPU and memory.</p></div>`;
  }

  function fileDiffLeftLabel(file) {
    if (file.diff_kind === "S") return "index";
    if (file.diff_kind === "?") return "new file";
    return "previous";
  }

  function renderLargeChangePlaceholder(file) {
    const id = `hidden-change-diff-reason-${hashText(`${file.diff_kind || ""}:${file.path}`)}`;
    return `<div class="git-ui-large-file-diff"><button aria-describedby="${id}" class="git-ui-large-file-load" type="button" onclick="HerdrGitUi.loadLargeDiff('${arg(file.path)}','${arg(file.diff_kind || "")}')"><strong>Load diff</strong></button><p id="${id}">Diff hidden to keep large change sets responsive.</p></div>`;
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
    const hunkButton = file.preview_large_diff
      ? `<span class="git-ui-muted">render full diff for hunk actions</span>`
      : scope === "staged"
      ? `<button class="git-ui-btn" title="Unstage this hunk" onclick="HerdrGitUi.unstageHunk('${arg(path)}',${index})">Unstage hunk</button>`
      : scope === "working"
        ? `<button class="git-ui-btn" title="Stage this hunk" onclick="HerdrGitUi.stageHunk('${arg(path)}',${index})">Stage hunk</button>`
        : `<span class="git-ui-muted">select staged/unstaged file for hunk actions</span>`;
    const actions = canMutateDiff()
      ? `<span class="git-ui-hunk-actions">${hunkButton}</span>`
      : `<span class="git-ui-muted">read only</span>`;
    const rows = markChangeGroups(diffLayoutMode() === "unified" ? unifiedRows(chunk) : sideBySideRows(chunk));
    const contextArrows = contextArrowsForChunk(file.chunks || [], index);
    const body = diffLayoutMode() === "unified"
      ? rows.map((row, rowIndex) => renderUnifiedLine(row, path, index, rows, rowIndex, contextArrows)).join("")
      : rows.map((row, rowIndex) => renderLine(row, path, index, rows, rowIndex, contextArrows, !!file.preview_large_diff)).join("");
    return `<div class="git-ui-hunk ${diffLayoutMode() === "unified" ? "git-ui-hunk-unified" : ""}"><div class="git-ui-hunk-head"><span>${esc(chunk.header)}</span>${actions}</div>${body}</div>`;
  }

  function contextArrowsForChunk(chunks, index) {
    const chunk = chunks[index] || {};
    const prev = chunks[index - 1] || null;
    const next = chunks[index + 1] || null;
    const before = prev
      ? hiddenGap(prev, chunk)
      : (chunk.old_start || 0) > 1 || (chunk.new_start || 0) > 1;
    const after = next ? hiddenGap(chunk, next) : false;
    return { before, after };
  }

  function hiddenGap(left, right) {
    return ((right.old_start || 0) - hunkEnd(left, "old")) > 1 || ((right.new_start || 0) - hunkEnd(left, "new")) > 1;
  }

  function hunkEnd(chunk, side) {
    const start = side === "old" ? chunk.old_start : chunk.new_start;
    const count = side === "old" ? chunk.old_lines : chunk.new_lines;
    return (start || 0) + Math.max(0, (count || 0) - 1);
  }

  function unifiedRows(chunk) {
    return (chunk.lines || []).map((line) => ({ line }));
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

  function renderLine(row, path, hunkIndex, rows, rowIndex, contextArrows, previewLargeDiff) {
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
    const canRestorePath = scope === "staged" || scope === "working" || (scope === "all" && ([...(status.staged || []), ...(status.unstaged || []), ...(status.untracked || [])].includes(path)));
    const blockButton = !previewLargeDiff && currentMode() === "changes" && canRestorePath && (add || del) && isFirstChange(rows, rowIndex)
      ? `<button class="git-ui-line-action" title="Restore this block" onclick="HerdrGitUi.restoreHunk('${arg(path)}',${hunkIndex})">&gt;&gt;</button>`
      : `<span class="git-ui-line-action-spacer"></span>`;
    const contextControls = rowIndex === 0 && contextArrows.before
      ? `<button class="git-ui-context-arrow" title="Expand lines before; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↑</button>`
      : rowIndex === rows.length - 1 && contextArrows.after
        ? `<button class="git-ui-context-arrow" title="Expand lines after; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↓</button>`
        : "";
    const oldCode = oldLine ? renderDiffCode(oldLine, newLine, path, "old") : "";
    const newCode = newLine ? renderDiffCode(oldLine, newLine, path, "new") : "";
    return `<div class="git-ui-diff-row ${cls}"><div class="git-ui-context-cell">${contextControls}</div><div class="git-ui-code git-ui-code-old">${oldCode}</div><div class="git-ui-line-pair"><span class="git-ui-line-old"><em>${esc(oldAuthor)}</em>${oldNo}</span>${blockButton}<span class="git-ui-line-new"><em>${esc(newAuthor)}</em>${newNo}</span></div><div class="git-ui-code git-ui-code-new">${newCode}</div></div>`;
  }

  function renderUnifiedLine(row, path, hunkIndex, rows, rowIndex, contextArrows) {
    const view = active() || {};
    const scope = view.diffScope || "all";
    const line = row.line || {};
    const add = line.line_type === "add";
    const del = line.line_type === "delete";
    let cls = add ? "git-ui-add" : del ? "git-ui-del" : "git-ui-context";
    if (row.groupStart) cls += " git-ui-change-start";
    if (row.groupEnd) cls += " git-ui-change-end";
    const oldNo = line.old_line_number || "";
    const newNo = line.new_line_number || "";
    const author = blameName(path, newNo || oldNo);
    const status = view.status || {};
    const canRestorePath = scope === "staged" || scope === "working" || (scope === "all" && ([...(status.staged || []), ...(status.unstaged || []), ...(status.untracked || [])].includes(path)));
    const blockButton = currentMode() === "changes" && canRestorePath && (add || del) && isFirstChange(rows, rowIndex)
      ? `<button class="git-ui-line-action" title="Restore this block" onclick="HerdrGitUi.restoreHunk('${arg(path)}',${hunkIndex})">↩</button>`
      : `<span class="git-ui-line-action-spacer"></span>`;
    const contextControls = rowIndex === 0 && contextArrows.before
      ? `<button class="git-ui-context-arrow" title="Expand lines before; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↑</button>`
      : rowIndex === rows.length - 1 && contextArrows.after
        ? `<button class="git-ui-context-arrow" title="Expand lines after; hunks merge when context overlaps" onclick="HerdrGitUi.expandContext()">↓</button>`
        : "";
    const sign = add ? "+" : del ? "-" : " ";
    const code = renderUnifiedDiffCode(line, rows, rowIndex, path);
    return `<div class="git-ui-unified-row ${cls}"><div class="git-ui-context-cell">${contextControls}</div><div class="git-ui-unified-lines"><span>${oldNo}</span><span>${newNo}</span></div><div class="git-ui-unified-action">${blockButton}</div><div class="git-ui-code git-ui-code-unified"><span class="git-ui-unified-author">${esc(author)}</span><span class="git-ui-unified-sign">${sign}</span><span class="git-ui-unified-text">${code}</span></div></div>`;
  }

  function renderUnifiedDiffCode(line, rows, rowIndex, path) {
    if (!line || !["delete", "add"].includes(line.line_type)) return highlight((line && line.content) || "", path);
    const pair = unifiedChangePair(rows, rowIndex);
    if (!pair) return highlight(line.content || "", path);
    return renderDiffCode(pair.oldLine, pair.newLine, path, line.line_type === "delete" ? "old" : "new");
  }

  function unifiedChangePair(rows, rowIndex) {
    const line = rows[rowIndex] && rows[rowIndex].line;
    if (!line || !["delete", "add"].includes(line.line_type)) return null;
    let start = rowIndex;
    while (start > 0 && isChangedRow(rows[start - 1])) start--;
    let end = rowIndex;
    while (end + 1 < rows.length && isChangedRow(rows[end + 1])) end++;
    const deletes = [];
    const adds = [];
    for (let i = start; i <= end; i++) {
      const item = rows[i] && rows[i].line;
      if (item && item.line_type === "delete") deletes.push({ line: item, rowIndex: i });
      if (item && item.line_type === "add") adds.push({ line: item, rowIndex: i });
    }
    if (!deletes.length || !adds.length) return null;
    const list = line.line_type === "delete" ? deletes : adds;
    const index = Math.max(0, list.findIndex((item) => item.rowIndex === rowIndex));
    const otherIndex = Math.min(index, (line.line_type === "delete" ? adds : deletes).length - 1);
    return line.line_type === "delete"
      ? { oldLine: line, newLine: adds[otherIndex].line }
      : { oldLine: deletes[otherIndex].line, newLine: line };
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
    return !!(row && ((row.oldLine && row.oldLine.line_type === "delete") || (row.newLine && row.newLine.line_type === "add") || (row.line && (row.line.line_type === "add" || row.line.line_type === "delete"))));
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

  function renderCleanup() {
    const view = active() || {};
    const root = esc(view.cleanupRoot || view.cwd || "");
    const result = view.cleanupResult || {};
    const repos = result.repos || [];
    const selected = cleanupSelectedItems(view);
    const truncated = result.truncated ? `<div class="git-ui-error">Scan stopped at safety limit; choose a smaller directory for complete results.</div>` : "";
    const bulk = repos.length
      ? `<div class="git-ui-actions git-ui-cleanup-bulk"><button class="git-ui-btn" onclick="HerdrGitUi.selectAllCleanup()">Check all</button><button class="git-ui-btn" onclick="HerdrGitUi.clearCleanupSelection()">Uncheck all</button><button class="git-ui-btn danger" onclick="HerdrGitUi.openCleanupDeleteConfirm()" ${selected.length ? "" : "disabled"}>Delete selected (${selected.length})</button></div>`
      : "";
    const body = view.cleanupLoading
      ? `<div class="git-ui-loading"><span></span><strong>Scanning Git repositories</strong></div>`
      : repos.length
        ? repos.map(renderCleanupRepo).join("")
        : `<div class="git-ui-empty-row">No scanned repositories yet. Choose a directory and scan.</div>`;
    return `<div class="git-ui-cleanup"><div class="git-ui-toolbar-title">Git branch and worktree cleanup</div><p class="git-ui-muted">Scan a folder for Git repositories, select local branches or linked worktrees, then delete them in one confirmed action. Herdr starts with safe delete and retries with force only when Git requires it.</p><label class="git-ui-branch-field"><span>Directory to scan</span><div class="git-ui-inline-field"><input id="gitUiCleanupRoot" value="${root}" placeholder="/path/to/projects"><button class="git-ui-btn" onclick="HerdrDirectoryPicker.openInput('gitUiCleanupRoot')">Browse</button><button class="git-ui-btn primary" onclick="HerdrGitUi.scanCleanup()" ${view.cleanupLoading ? "disabled" : ""}>Scan</button></div></label>${bulk}${view.cleanupError ? `<div class="git-ui-error">${esc(view.cleanupError)}</div>` : ""}${truncated}<div class="git-ui-list">${body}</div></div>`;
  }

  function renderCleanupRepo(repo, repoIndex) {
    const name = repo.path ? repo.path.split(/[\\/]+/).filter(Boolean).pop() || repo.path : "Repository";
    const repoItems = cleanupRepoItems(repoIndex);
    const repoState = cleanupSelectionState(repoItems);
    const title = `<label class="git-ui-cleanup-repo-title"><input type="checkbox" data-state="${repoState}" onchange="HerdrGitUi.toggleCleanupRepo('${repoIndex}',this.checked)" ${repoState === "checked" ? "checked" : ""} ${repoItems.length ? "" : "disabled"}><span>${treeIcon("folder")}</span><strong>${esc(name)}</strong><small title="${esc(repo.path || "")}">${esc(repo.path || "")}</small></label>`;
    if (repo.error) return `<section class="git-ui-cleanup-repo">${title}<div class="git-ui-error">${esc(repo.error)}</div></section>`;
    const branches = (repo.branches || []).map((branch) => renderCleanupBranch(repoIndex, branch)).join("") || `<div class="git-ui-empty-row git-ui-cleanup-empty">No local branches</div>`;
    const worktrees = (repo.worktrees || []).map((worktree, index) => worktree.primary ? "" : renderCleanupWorktree(repoIndex, index, worktree)).join("") || `<div class="git-ui-empty-row git-ui-cleanup-empty">No linked worktrees</div>`;
    return `<section class="git-ui-cleanup-repo">${title}<div class="git-ui-cleanup-group">${renderCleanupGroupTitle(repoIndex, "branch", "Branches")}${branches}</div><div class="git-ui-cleanup-group">${renderCleanupGroupTitle(repoIndex, "worktree", "Worktrees")}${worktrees}</div></section>`;
  }

  function renderCleanupGroupTitle(repoIndex, type, label) {
    const items = cleanupRepoItems(repoIndex, type);
    const state = cleanupSelectionState(items);
    return `<label class="git-ui-cleanup-group-title"><input type="checkbox" data-state="${state}" onchange="HerdrGitUi.toggleCleanupGroup('${repoIndex}','${type}',this.checked)" ${state === "checked" ? "checked" : ""} ${items.length ? "" : "disabled"}><span>${esc(label)}</span></label>`;
  }

  function renderCleanupBranch(repoIndex, branch) {
    const disabled = branch.current ? "disabled" : "";
    const key = cleanupItemKey("branch", repoIndex, branch.name);
    const checked = cleanupSelected(key) ? "checked" : "";
    const meta = [branch.current ? "current" : "", branch.checked_out ? "checked out" : ""].filter(Boolean).join(" · ");
    return `<label class="git-ui-cleanup-row"><input type="checkbox" onchange="HerdrGitUi.toggleCleanupSelection('${arg(key)}',this.checked)" ${checked} ${disabled}><span class="git-ui-cleanup-indent"></span><span><strong>${esc(branch.name)}</strong>${meta ? `<small>${esc(meta)}</small>` : ""}</span></label>`;
  }

  function renderCleanupWorktree(repoIndex, index, worktree) {
    const meta = [worktree.branch || (worktree.detached ? "detached" : ""), worktree.prunable ? "prunable" : "", worktree.primary ? "primary" : ""].filter(Boolean).join(" · ");
    const disabled = worktree.primary ? "disabled" : "";
    const key = cleanupItemKey("worktree", repoIndex, String(index));
    const checked = cleanupSelected(key) ? "checked" : "";
    return `<label class="git-ui-cleanup-row"><input type="checkbox" onchange="HerdrGitUi.toggleCleanupSelection('${arg(key)}',this.checked)" ${checked} ${disabled}><span class="git-ui-cleanup-indent"></span><span><strong>${esc(compactPath(worktree.path))}</strong>${meta ? `<small>${esc(meta)}</small>` : ""}</span></label>`;
  }

  function cleanupItemKey(type, repoIndex, id) {
    const repo = ((active() || {}).cleanupResult || {}).repos || [];
    const repoPath = repo[repoIndex] && repo[repoIndex].path || repoIndex;
    return `${type}|${repoPath}|${id}`;
  }

  function cleanupSelected(key) {
    const view = active() || {};
    return !!(view.cleanupSelected && view.cleanupSelected[key]);
  }

  function cleanupSelectionState(items) {
    if (!items || !items.length) return "unchecked";
    const selected = items.filter((item) => cleanupSelected(item.key)).length;
    if (selected === 0) return "unchecked";
    if (selected === items.length) return "checked";
    return "mixed";
  }

  function cleanupSelectableItems(view = active() || {}) {
    const items = [];
    for (const repo of (((view.cleanupResult || {}).repos) || [])) {
      if (repo.error) continue;
      for (const branch of repo.branches || []) {
        if (!branch.current) items.push({ type: "branch", repo: repo.path, name: branch.name, key: `branch|${repo.path}|${branch.name}` });
      }
      (repo.worktrees || []).forEach((worktree, index) => {
        if (!worktree.primary) items.push({ type: "worktree", repo: repo.path, path: worktree.path, key: `worktree|${repo.path}|${index}` });
      });
    }
    return items;
  }

  function cleanupRepoItems(repoIndex, type) {
    const view = active() || {};
    const repos = ((view.cleanupResult || {}).repos) || [];
    const repo = repos[Number(repoIndex)];
    if (!repo || repo.error) return [];
    const items = [];
    if (!type || type === "branch") {
      for (const branch of repo.branches || []) {
        if (!branch.current) items.push({ type: "branch", repo: repo.path, name: branch.name, key: `branch|${repo.path}|${branch.name}` });
      }
    }
    if (!type || type === "worktree") {
      (repo.worktrees || []).forEach((worktree, index) => {
        if (!worktree.primary) items.push({ type: "worktree", repo: repo.path, path: worktree.path, key: `worktree|${repo.path}|${index}` });
      });
    }
    return items;
  }

  function cleanupSelectedItems(view = active() || {}) {
    const selected = view.cleanupSelected || {};
    return cleanupSelectableItems(view).filter((item) => selected[item.key]);
  }

  function cleanupItemLabel(item) {
    return item.type === "branch" ? `${item.repo}:${item.name}` : `${item.repo}:${item.path}`;
  }

  async function deleteCleanupItem(item, force) {
    if (item.type === "branch") {
      return api("/api/git-ui/branch-delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: item.repo, branch: item.name, force, confirmed: true }),
      });
    }
    return api("/api/git-ui/worktree-remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: item.repo, path: item.path, force, confirmed: true }),
    });
  }

  function cleanupForceRetryLikelyNeeded(err) {
    const text = String((err && err.message) || err || "").toLowerCase();
    return [
      "not fully merged",
      "is not fully merged",
      "contains modified or untracked files",
      "contains modified files",
      "contains untracked files",
      "use --force",
      "use -d to delete it anyway",
      "use -d to force",
      "remove untracked or ignored files",
    ].some((needle) => text.includes(needle));
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
    return `<div class="git-ui-commit"><div class="git-ui-toolbar-title">Commit staged changes</div><label>Summary<input id="gitCommitTitle" class="git-ui-input" value="${esc(draft.title)}" placeholder="Short imperative summary"></label><label>Details<textarea id="gitCommitBody" class="git-ui-textarea" placeholder="Optional body">${esc(draft.body)}</textarea></label><div class="git-ui-actions"><span class="git-ui-action-group"><button class="git-ui-btn" onclick="HerdrGitUi.saveDraft()">Save draft</button><button class="git-ui-btn active" onclick="HerdrGitUi.commit(false)">Commit</button><button class="git-ui-btn primary" onclick="HerdrGitUi.commitAndPush()">Commit & Push</button><button class="git-ui-btn" onclick="HerdrGitUi.commit(true)">Amend previous</button></span></div></div>`;
  }

  function renderConflicts() {
    const files = (((active() || {}).status || {}).conflicted || []);
    const rebaseActions = `<div class="git-ui-actions git-ui-conflict-actions"><button class="git-ui-btn primary" onclick="HerdrGitUi.conflictAction('rebase-continue')">Rebase continue</button><button class="git-ui-btn" onclick="HerdrGitUi.conflictAction('rebase-skip')">Rebase skip</button><button class="git-ui-btn danger" onclick="HerdrGitUi.conflictAction('rebase-abort')">Rebase abort</button></div>`;
    return `${renderFileToolbar("conflicts")}<div class="git-ui-section"><div class="git-ui-muted">Conflicts</div>${files.length ? rebaseActions : ""}${files.map((file) => `<div class="git-ui-file"><span>${esc(file)}</span><span><button class="git-ui-btn" title="Use HEAD/current side" onclick="HerdrGitUi.resolve('${arg(file)}','ours')">Use HEAD</button><button class="git-ui-btn" title="Use incoming branch side" onclick="HerdrGitUi.resolve('${arg(file)}','theirs')">Use branch</button><button class="git-ui-btn" onclick="HerdrGitUi.resolve('${arg(file)}','mark')">Mark resolved</button></span></div>`).join("") || `<div class="git-ui-empty-row">No conflicts</div>`}</div>`;
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
    if (view.tab === "cleanup") body = renderCleanup();
    if (view.tab === "history") body = `<div class="git-ui-muted">Loading history...</div>`;
    return `<main class="git-ui-main"><div class="git-ui-content">${body}</div></main>`;
  }

  function render() {
    if (!state.visible) return;
    saveSideEditorFromDom();
    const activeView = active() || {};
    const currentContent = document.querySelector(".git-ui-content");
    if (currentContent && activeView.tab === "cleanup")
      activeView.contentScrollTop = currentContent.scrollTop;
    const version = ++state.renderVersion;
    const panel = ensurePanel();
    panel.classList.toggle("mutating", !!activeView.mutating);
    panel.innerHTML = renderSide() + renderMain() + renderContextMenu() + renderBranchModal() + renderGitOpModal() + renderCleanupConfirm();
    const side = panel.querySelector(".git-ui-side");
    if (side) side.scrollTop = state.sideScrollTop || 0;
    const nextContent = panel.querySelector(".git-ui-content");
    if (nextContent && activeView.tab === "cleanup")
      nextContent.scrollTop = activeView.contentScrollTop || 0;
    mountSideEditors();
    const view = activeView;
    if (view.tab === "log") renderLog(version).catch((e) => { view.error = e.message; render(); });
    if (view.tab === "stash") renderStash(version).catch((e) => { view.error = e.message; render(); });
    if (view.tab === "history") renderHistory().then((html) => replaceContent(version, html)).catch((e) => { view.error = e.message; render(); });
  }

  function replaceContent(version, html) {
    if (!state.visible || version !== state.renderVersion) return;
    const content = document.querySelector(".git-ui-content");
    if (content) content.innerHTML = html;
  }

  function mountSideEditors() {
    const view = active() || {};
    if (!window.HerdrEditor || !view.sideEditor) return;
    const mounts = Array.from(document.querySelectorAll(".git-ui-hunk-edit-mount[data-hunk-index]"));
    const mountAll = () => mounts.forEach((mount) => {
      const index = Number(mount.dataset.hunkIndex || 0);
      const side = mount.dataset.editorSide || "current";
      const sourceClass = side === "old" ? "git-ui-hunk-old-hidden" : "git-ui-hunk-current-hidden";
      const textarea = document.querySelector(`.${sourceClass}[data-hunk-index="${index}"]`);
      if (!textarea) return;
      window.HerdrEditor.create({
        parent: mount,
        path: view.file || view.sideEditor.path || "",
        content: textarea.value,
        readonly: mount.dataset.readonly === "true",
        hideFind: true,
        onChange: side === "old" ? null : function (value) { textarea.value = value; },
      });
    });
    if (!window.HerdrCodeMirror && window.HerdrEditor.ensureCodeMirror) {
      window.HerdrEditor.ensureCodeMirror().then(() => mountAll()).catch(() => mountAll());
      return;
    }
    mountAll();
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
    forgetWorkspace(workspace) {
      const key = typeof workspace === "string" ? workspace : workspaceKey(workspace);
      if (!key) return;
      if (state.activeKey === key) {
        close();
        return;
      }
      delete state.cache[key];
    },
    refresh,
    refreshWithSpin() {
      const view = active();
      if (!view) return;
      view.refreshAnimating = true;
      render();
      setTimeout(() => {
        const latest = active();
        if (latest) latest.refreshAnimating = false;
        if (state.visible) render();
      }, 2000);
      refresh();
    },
    refreshVisible() { if (state.visible) render(); },
    isVisible() { return state.visible; },
    isWorkspaceVisible(key) { return state.visible && state.activeKey === key; },
    workspaceStatus,
    statusLabel() { return state.open ? (state.visible ? "open" : "hidden") : "closed"; },
    tab(tab) {
      if (!["changes", "log", "stash", "cleanup", "commit", "conflicts", "history"].includes(tab)) return;
      const view = active();
      if (!view) return;
      if (tab === "commit" && !hasCommittableChanges(view.status)) return;
      saveDraftFromDom();
      if (tab === "changes") {
        this.showChangesList();
        return;
      }
      view.tab = tab;
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
      view.expandedCompactDirs = {};
      if (view.sideEditor && view.sideEditor.path !== path) view.sideEditor = null;
      if (currentMode() !== "changes") {
        loadDiff().then(() => requestAnimationFrame(() => scrollToDiffFile(view.file))).catch((e) => { view.error = e.message; render(); });
        return;
      }
      view.diffScope = kind === "S" ? "staged" : kind === "M" || kind === "?" ? "working" : "all";
      loadDiff().then(() => requestAnimationFrame(() => scrollToDiffFile(view.file))).catch((e) => { view.error = e.message; render(); });
    },
    loadLargeDiff(file, kind) {
      const view = active();
      if (!view) return;
      const path = decodeURIComponent(file);
      if (path === "__all__") {
        view.loadLargeChangeSet = true;
        view.loading = true;
        render();
        loadDiff()
          .catch((e) => { view.error = e.message; })
          .finally(() => { view.loading = false; render(); });
        return;
      }
      if (view.diff && view.diff.skipped_large_change_set) {
        const diffKind = kind ? decodeURIComponent(kind) : "";
        const scope = diffKind === "S" ? "staged" : diffKind === "M" || diffKind === "?" ? "working" : "all";
        const context = Math.max(0, Math.min(200, Number(view.diffContext || 3)));
        api(`/api/git-ui/diff?cwd=${encodeURIComponent(view.cwd)}&scope=${encodeURIComponent(scope)}&context=${context}&file=${encodeURIComponent(path)}`)
          .then((data) => {
            const nextFiles = ((data && data.files) || []).map((diffFile) => Object.assign({}, diffFile, { diff_kind: diffKind }));
            const existing = (view.diff.files || []).filter((diffFile) => !(diffFile.path === path && (!diffKind || diffFile.diff_kind === diffKind)));
            view.diff.files = existing.concat(nextFiles);
            view.loadedLargeDiffFiles = Object.assign({}, view.loadedLargeDiffFiles || {}, { [path]: true });
          })
          .catch((e) => { view.error = e.message || String(e); })
          .finally(() => render());
        return;
      }
      view.loadedLargeDiffFiles = Object.assign({}, view.loadedLargeDiffFiles || {}, { [path]: true });
      render();
    },
    renderFullLargeDiff(file, kind) {
      const view = active();
      if (!view) return;
      const path = decodeURIComponent(file);
      const diffKind = kind ? decodeURIComponent(kind) : "";
      view.fullLargeDiffFiles = Object.assign({}, view.fullLargeDiffFiles || {}, { [diffFileKey(path, diffKind)]: true });
      render();
    },
    activateTreeItem(event) {
      if (!event || !["Enter", " ", "Spacebar"].includes(event.key)) return;
      event.preventDefault();
      event.currentTarget.click();
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
      setTimeout(() => {
        post(action === "unstage" ? "/api/git-ui/unstage" : "/api/git-ui/stage", { cwd: view.cwd, paths });
      }, 0);
    },
    stageFile(path) { post("/api/git-ui/stage", { cwd: active().cwd, paths: [decodeURIComponent(path)] }); },
    unstageFile(path) { post("/api/git-ui/unstage", { cwd: active().cwd, paths: [decodeURIComponent(path)] }); },
    restoreFile(path) { if (confirm("Restore this file change?")) post("/api/git-ui/discard", { cwd: active().cwd, paths: [decodeURIComponent(path)], confirmed: true }); },
    restoreHunk(path, index) {
      path = decodeURIComponent(path);
      const view = active() || {};
      const staged = (view.diffScope || "all") === "staged";
      if (confirm(staged ? "Restore this staged hunk? This discards it from the index." : "Restore this hunk?")) applyHunk(path, index, staged ? { reverse: true, cached: true } : { reverse: true });
    },
    discardFile(path) { path = decodeURIComponent(path); if (confirm(`Restore complete file ${path}? This discards staged and unstaged changes.`)) post("/api/git-ui/discard", { cwd: active().cwd, paths: [path], confirmed: true }); },
    toggleBlame() { const view = active(); if (!view) return; view.showBlame = !view.showBlame; render(); },
    toggleDiffLayout() {
      setGitUiOption("gitUiDiffLayout", diffLayoutMode() === "unified" ? "side-by-side" : "unified");
      render();
    },
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
    expandCompactDir(path) {
      const view = active();
      if (!view) return;
      path = decodeURIComponent(path);
      view.expandedCompactDirs = view.expandedCompactDirs || {};
      let current = "";
      for (const part of path.split("/").filter(Boolean)) {
        current = current ? `${current}/${part}` : part;
        view.expandedCompactDirs[current] = true;
      }
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
    expandLargeSection(title) {
      const view = active();
      if (!view) return;
      title = decodeURIComponent(title);
      view.expandedLargeSections = view.expandedLargeSections || {};
      view.expandedLargeSections[title] = true;
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
      view.diffContext = window.HerdrLineContext && window.HerdrLineContext.nextContextSize
        ? window.HerdrLineContext.nextContextSize(current, { min: 3, max: 200 })
        : Math.min(200, current < 3 ? 3 : current * 2);
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
    async scanCleanup() {
      const view = active();
      if (!view) return;
      const input = document.getElementById("gitUiCleanupRoot");
      const root = (input && input.value.trim()) || view.cleanupRoot || view.cwd;
      if (!root) return;
      view.cleanupRoot = root;
      view.cleanupLoading = true;
      view.cleanupError = "";
      render();
      try {
        view.cleanupResult = await api(`/api/git-ui/cleanup-scan?root=${encodeURIComponent(root)}`);
        view.cleanupSelected = {};
      } catch (err) {
        view.cleanupError = err.message || String(err);
      } finally {
        view.cleanupLoading = false;
        render();
      }
    },
    sideScroll(node) {
      state.sideScrollTop = node.scrollTop;
    },
    filterFiles(value) {
      const view = active();
      if (!view) return;
      const side = document.querySelector(".git-ui-side");
      state.sideScrollTop = side ? side.scrollTop : state.sideScrollTop;
      clearTimeout(view.fileFilterTimer);
      view.fileFilterTimer = setTimeout(() => {
        view.fileFilter = String(value || "");
        render();
      }, 300);
    },
    toggleCleanupSelection(key, checked) {
      const view = active();
      if (!view) return;
      key = decodeURIComponent(key);
      view.cleanupSelected = Object.assign({}, view.cleanupSelected || {});
      if (checked) view.cleanupSelected[key] = true;
      else delete view.cleanupSelected[key];
      render();
    },
    toggleCleanupGroup(repoIndex, type, checked) {
      const view = active();
      if (!view) return;
      view.cleanupSelected = Object.assign({}, view.cleanupSelected || {});
      for (const item of cleanupRepoItems(repoIndex, type)) {
        if (checked) view.cleanupSelected[item.key] = true;
        else delete view.cleanupSelected[item.key];
      }
      render();
    },
    toggleCleanupRepo(repoIndex, checked) {
      const view = active();
      if (!view) return;
      view.cleanupSelected = Object.assign({}, view.cleanupSelected || {});
      for (const item of cleanupRepoItems(repoIndex)) {
        if (checked) view.cleanupSelected[item.key] = true;
        else delete view.cleanupSelected[item.key];
      }
      render();
    },
    selectAllCleanup() {
      const view = active();
      if (!view) return;
      view.cleanupSelected = {};
      for (const item of cleanupSelectableItems(view)) view.cleanupSelected[item.key] = true;
      render();
    },
    clearCleanupSelection() {
      const view = active();
      if (!view) return;
      view.cleanupSelected = {};
      render();
    },
    openCleanupDeleteConfirm() {
      const items = cleanupSelectedItems();
      if (!items.length) return;
      state.cleanupConfirm = { items };
      render();
    },
    cancelCleanupDelete() {
      state.cleanupConfirm = null;
      render();
    },
    async confirmCleanupDelete() {
      const view = active();
      const modal = state.cleanupConfirm;
      const items = (modal && modal.items) || [];
      if (!view || !items.length) return;
      state.cleanupConfirm = null;
      view.cleanupLoading = true;
      view.cleanupError = "";
      render();
      const failures = [];
      for (const item of items) {
        try {
          await deleteCleanupItem(item, false);
        } catch (err) {
          if (!cleanupForceRetryLikelyNeeded(err)) {
            failures.push(`${cleanupItemLabel(item)}: ${(err && err.message) || err}`);
            continue;
          }
          try {
            await deleteCleanupItem(item, true);
          } catch (forceErr) {
            failures.push(`${cleanupItemLabel(item)}: ${(forceErr && forceErr.message) || forceErr || err}`);
          }
        }
      }
      view.cleanupLoading = false;
      if (failures.length) view.cleanupError = failures.join("\n");
      await this.scanCleanup();
      if (failures.length) {
        const latest = active();
        if (latest) latest.cleanupError = failures.join("\n");
      }
      render();
    },
    async deleteCleanupBranch(repoIndex, branch, force) {
      const view = active();
      const repo = view && view.cleanupResult && (view.cleanupResult.repos || [])[repoIndex];
      branch = decodeURIComponent(branch);
      if (!repo || !branch) return;
      const label = force ? "force delete" : "delete";
      if (!confirm(`${label} branch ${branch} in ${repo.path}?`)) return;
      try {
        await api("/api/git-ui/branch-delete", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo.path, branch, force, confirmed: true }) });
        await this.scanCleanup();
      } catch (err) {
        view.cleanupError = err.message || String(err);
        render();
      }
    },
    async deleteCleanupWorktree(repoIndex, worktreeIndex, force) {
      const view = active();
      const repo = view && view.cleanupResult && (view.cleanupResult.repos || [])[repoIndex];
      const worktree = repo && (repo.worktrees || [])[worktreeIndex];
      if (!repo || !worktree || !worktree.path) return;
      const label = force ? "force remove" : "remove";
      if (!confirm(`${label} worktree ${worktree.path}?`)) return;
      try {
        await api("/api/git-ui/worktree-remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd: repo.path, path: worktree.path, force, confirmed: true }) });
        await this.scanCleanup();
      } catch (err) {
        view.cleanupError = err.message || String(err);
        render();
      }
    },
    saveDraft() {
      saveDraftFromDom();
    },
    commit(amend) { post("/api/git-ui/commit", { cwd: active().cwd, title: document.getElementById("gitCommitTitle").value, body: document.getElementById("gitCommitBody").value, amend }); },
    async commitAndPush() {
      const view = active();
      if (!view) return;
      try {
        await postJson("/api/git-ui/commit", { cwd: view.cwd, title: document.getElementById("gitCommitTitle").value, body: document.getElementById("gitCommitBody").value, amend: false });
        await postJson("/api/git-ui/push", { cwd: view.cwd, mode: "regular" });
      } catch (err) {
        state.gitOpModal = { type: "force-push", error: err.message || String(err) };
        render();
      }
    },
    async openGitOpModal(type) {
      const view = active();
      if (!view) return;
      state.gitOpModal = { type, error: "", branches: [], loading: true };
      render();
      try {
        const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(view.cwd)}`);
        const branches = [...(data.local || []), ...(data.remote || [])].map((branch) => ({ name: branch.remote ? localNameForRemote(branch.name) : branch.name }));
        if (state.gitOpModal && state.gitOpModal.type === type) state.gitOpModal = { type, error: "", branches, loading: false };
      } catch (err) {
        if (state.gitOpModal && state.gitOpModal.type === type) state.gitOpModal = { type, error: err.message || String(err), branches: [], loading: false };
      }
      render();
    },
    openPullModal() { this.openGitOpModal("pull"); },
    openPushModal() { this.openGitOpModal("push"); },
    openForcePushModal() { this.openGitOpModal("force-push"); },
    closeGitOpModal() { state.gitOpModal = null; render(); },
    async runPullFromModal() {
      const view = active();
      if (!view) return;
      const mode = (document.getElementById("gitUiOpMode") || {}).value || "regular";
      const branch = (document.getElementById("gitUiOpBranch") || {}).value || "";
      state.gitOpModal = null;
      await postJson("/api/git-ui/pull", { cwd: view.cwd, mode, branch });
    },
    async runPushFromModal() {
      const view = active();
      if (!view) return;
      const mode = (document.getElementById("gitUiOpMode") || {}).value || "regular";
      const branch = (document.getElementById("gitUiOpBranch") || {}).value || "";
      state.gitOpModal = null;
      try {
        await postJson("/api/git-ui/push", { cwd: view.cwd, mode, branch });
      } catch (err) {
        state.gitOpModal = { type: "force-push", error: err.message || String(err) };
        render();
      }
    },
    async runRebaseFromModal() {
      const view = active();
      if (!view) return;
      const upstream = ((document.getElementById("gitUiRebaseUpstream") || {}).value || "").trim();
      const branch = (document.getElementById("gitUiOpBranch") || {}).value || "";
      const pullFirst = !!((document.getElementById("gitUiRebasePullFirst") || {}).checked);
      if (!upstream) return;
      state.gitOpModal = null;
      if (pullFirst) await postJson("/api/git-ui/pull", { cwd: view.cwd, mode: "ff-only", branch });
      await postJson("/api/git-ui/rebase", { cwd: view.cwd, upstream, onto: branch, confirmation: "rebase selected" });
    },
    resolve(path, mode) { post("/api/git-ui/conflict-resolve", { cwd: active().cwd, path: decodeURIComponent(path), mode }); },
    conflictAction(action) { post("/api/git-ui/conflict-action", { cwd: active().cwd, action }); },
    async openBranchModal() {
      const view = active();
      if (!view) return;
      state.branchModal = { loading: true, error: "", local: [], remote: [], cwd: view.cwd };
      render();
      try {
        const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(view.cwd)}`);
        state.branchModal = { loading: false, error: "", local: data.local || [], remote: data.remote || [], cwd: view.cwd };
      } catch (err) {
        state.branchModal = { loading: false, error: err.message || String(err), local: [], remote: [], cwd: view.cwd };
      }
      render();
    },
    async loadBranchModalCwd() {
      const modal = state.branchModal;
      const input = document.getElementById("gitUiBranchCwd");
      const cwd = input ? input.value.trim() : "";
      if (!modal || !cwd) return;
      state.branchModal = Object.assign({}, modal, { loading: true, error: "", cwd });
      render();
      try {
        const data = await api(`/api/git-ui/branches?cwd=${encodeURIComponent(cwd)}`);
        state.branchModal = { loading: false, error: "", local: data.local || [], remote: data.remote || [], cwd };
      } catch (err) {
        state.branchModal = { loading: false, error: err.message || String(err), local: [], remote: [], cwd };
      }
      render();
    },
    closeBranchModal() {
      state.branchModal = null;
      render();
    },
    applyBranchModalCwd() {
      const view = active();
      const input = document.getElementById("gitUiBranchCwd");
      const cwd = (input && input.value.trim()) || (state.branchModal && state.branchModal.cwd) || "";
      if (!view || !cwd) return;
      state.branchModal = null;
      view.cwd = cwd;
      view.file = "";
      view.status = null;
      view.diff = null;
      render();
      refresh();
    },
    switchBranchFromModal() {
      const view = active();
      const select = document.getElementById("gitUiBranchSelect");
      if (!view || !select || !select.value) return;
      const [kind, ...rest] = select.value.split(":");
      const branch = rest.join(":");
      const input = document.getElementById("gitUiBranchCwd");
      const modalCwd = (input && input.value.trim()) || (state.branchModal && state.branchModal.cwd) || view.cwd;
      state.branchModal = null;
      view.cwd = modalCwd;
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
    rebase() { this.openGitOpModal("rebase"); },
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
