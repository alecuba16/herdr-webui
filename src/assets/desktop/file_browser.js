(function () {
  const Tree = window.HerdrFileTree;
  const DEFAULT_CONTENT_SEARCH_MIN_CHARS = 3;
  const stateCache = {};
  let activeKey = "";
  let state = createState();

  function createContentSearchState() {
    return { active: false, query: "", timer: null, files: [], expanded: {}, snippets: {}, loading: false, error: "", offset: 0, done: true, totalFiles: 0, totalMatches: 0, contextLines: 2, maxMatchesPerFile: 5, autoCollapseFiles: 0, defaultExpanded: true };
  }

  function createState(initial) {
    return Object.assign({ open: false, cwd: "", path: "", entries: [], children: {}, expanded: {}, loading: {}, selected: "", files: [], split: false, error: "", permissionRequired: false, contextMenu: null, filter: "", filterTimer: null, filterVisible: false, filterLoading: false, filterOffset: 0, filterDone: true, filterScrollTop: 0, filterKind: "file", gitStatus: null, refreshing: false, contentSearch: createContentSearchState() }, initial || {});
  }

  function esc(value) { return Tree.esc(value); }
  function arg(value) { return Tree.arg(value); }

  function gitStatusEnabled() {
    try {
      const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
      return parsed.fileBrowserGitStatus !== false;
    } catch (_) { return true; }
  }

  function lineNumbersEnabled() {
    try {
      const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
      return parsed.fileBrowserLineNumbers !== false;
    } catch (_) { return true; }
  }

  function parentFoldersEnabled() {
    try {
      const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
      return parsed.fileBrowserAllowParent === true;
    } catch (_) { return false; }
  }

  function pathSearchOptions() {
    try {
      const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
      return { pageSize: Math.max(10, Math.min(500, Number(parsed.fileBrowserSearchPageSize) || 100)) };
    } catch (_) { return { pageSize: 100 }; }
  }

  function contentSearchOptions() {
    try {
      const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
      const contextRaw = Number(parsed.fileContentSearchContextLines);
      const autoCollapseRaw = Number(parsed.fileContentSearchAutoCollapseFiles);
      return {
        minChars: Math.max(1, Math.min(20, Number(parsed.fileContentSearchMinChars) || DEFAULT_CONTENT_SEARCH_MIN_CHARS)),
        pageSize: Math.max(10, Math.min(500, Number(parsed.fileContentSearchPageSize) || 50)),
        contextLines: Math.max(0, Math.min(20, Number.isFinite(contextRaw) ? contextRaw : 2)),
        autoCollapseFiles: Math.max(0, Math.min(200, Number.isFinite(autoCollapseRaw) ? autoCollapseRaw : 0)),
        defaultExpanded: parsed.fileContentSearchDefaultExpanded !== false,
        maxMatchesPerFile: Math.max(1, Math.min(50, Number(parsed.fileContentSearchMatchesPerFile) || 5)),
        matchCase: parsed.fileContentSearchMatchCase === true,
        regex: parsed.fileContentSearchRegex === true,
      };
    } catch (_) { return { minChars: DEFAULT_CONTENT_SEARCH_MIN_CHARS, pageSize: 50, contextLines: 2, autoCollapseFiles: 0, defaultExpanded: true, maxMatchesPerFile: 5, matchCase: false, regex: false }; }
  }

  function defaultContentExpanded(content, fileCount) {
    return !!(content.defaultExpanded && !(content.autoCollapseFiles > 0 && fileCount > content.autoCollapseFiles));
  }

  function normalizeSearchScope(kind) {
    if (kind === "content") return "content";
    return Tree.normalizeSearchKind(kind);
  }

  function searchScopeLabel(kind) {
    if (kind === "content") return "Content";
    return Tree.searchKindLabel(kind);
  }

  function searchScopeNoun(kind) {
    if (kind === "content") return "content";
    return Tree.searchKindNoun(kind);
  }

  function nextSearchScope(kind) {
    if (kind === "file") return "dir";
    if (kind === "dir") return "content";
    return "file";
  }

  function clearContentSearchResults(content = state.contentSearch) {
    content.files = [];
    content.expanded = {};
    content.snippets = {};
    content.error = "";
    content.offset = 0;
    content.done = true;
    content.totalFiles = 0;
    content.totalMatches = 0;
  }

  document.addEventListener("click", () => {
    if (!state.contextMenu) return;
    state.contextMenu = null;
    if (state.open) render();
  });
  window.addEventListener("keydown", (event) => {
    if (!state.open || !state.contextMenu || event.key !== "Escape") return;
    event.preventDefault();
    state.contextMenu = null;
    render();
  }, true);

  function workspaceCwd(workspace) {
    if (!workspace) return "";
    if (window.HerdrWorkspacePath) return window.HerdrWorkspacePath(workspace);
    if (workspace.worktree && workspace.worktree.checkout_path) return workspace.worktree.checkout_path;
    return workspace.cwd || workspace.path || "";
  }

  function workspaceKey(workspace) {
    if (typeof workspace === "string") return workspace;
    return (workspace && workspace.workspace_id) || workspaceCwd(workspace) || "default";
  }

  function stopTransientWork(stateToStop) {
    if (!stateToStop) return;
    if (stateToStop.filterTimer) clearTimeout(stateToStop.filterTimer);
    stateToStop.filterTimer = null;
    stateToStop.filterLoading = false;
    stateToStop.refreshing = false;
    stateToStop.loading = {};
    stateToStop.contextMenu = null;
  }

  function activateState(key, cwd) {
    stopTransientWork(state);
    if (activeKey && activeKey !== key && stateCache[activeKey]) stateCache[activeKey].open = false;
    activeKey = key;
    if (!stateCache[key]) stateCache[key] = createState({ cwd });
    state = stateCache[key];
    state.cwd = cwd || state.cwd;
    stopTransientWork(state);
  }

  function renderIfActive(target, preserveScroll) {
    if (state !== target || !target.open) return;
    if (preserveScroll) renderPreservingScroll();
    else render();
  }

  async function api(url, opt) {
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    const body = await res.json();
    if (!res.ok || body.error) {
      const error = Error(body.error || res.statusText);
      error.details = body || {};
      throw error;
    }
    return body;
  }

  function setError(target, error) {
    const permissionRequired = !!(error.details && error.details.permission_required);
    target.permissionRequired = permissionRequired;
    target.error = permissionRequired
      ? "Herdr needs folder access to browse or search this folder."
      : error.message || String(error);
  }

  async function open(workspace, options) {
    const openOptions = options || {};
    const cwd = workspaceCwd(workspace);
    const key = workspaceKey(workspace);
    if (state.open && activeKey === key && !openOptions.forceOpen) {
      hide();
      return;
    }
    if (window.HerdrGitUi) window.HerdrGitUi.hide();
    activateState(key, cwd);
    state.open = true;
    render();
    await loadTree(state.path || "");
  }

  async function openAt(workspace, path, opts) {
    const options = opts || {};
    const cwd = workspaceCwd(workspace);
    const key = workspaceKey(workspace);
    if (!cwd) return;
    if (window.HerdrGitUi) window.HerdrGitUi.hide();
    activateState(key, cwd);
    state.open = true;
    state.filter = "";
    state.filterVisible = false;
    state.filterKind = "file";
    state.contentSearch.active = false;
    clearContentSearchResults(state.contentSearch);
    render();
    if (options.kind === "dir") {
      await loadTree(path || "");
      return;
    }
    const parent = Tree.parentPath(path || "");
    await loadTree(parent || "");
    if (path) await loadFile(path, options.mode, options.highlight || null);
  }

  function hide() {
    stopTransientWork(state);
    state.open = false;
    const panel = document.getElementById("fileBrowserPanel");
    if (panel) panel.remove();
    syncTerminalVisibility();
  }

  function forgetWorkspace(workspace) {
    const key = workspaceKey(workspace);
    const cached = stateCache[key];
    stopTransientWork(cached);
    delete stateCache[key];
    if (activeKey !== key) return;
    state.open = false;
    activeKey = "";
    state = createState();
    const panel = document.getElementById("fileBrowserPanel");
    if (panel) panel.remove();
    syncTerminalVisibility();
  }

  async function fetchEntries(path, target = state) {
    if (!target.cwd) return;
    const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(path || "")}&depth=0${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
    return data.entries || [];
  }

  async function fetchFilteredEntries(append = false) {
    const target = state;
    if (!target.cwd || !target.filter.trim() || target.filterKind === "content") return;
    const offset = append ? target.filterOffset : 0;
    const pageSize = pathSearchOptions().pageSize;
    target.filterLoading = true;
    renderIfActive(target, true);
    try {
      const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(target.path || "")}&q=${encodeURIComponent(target.filter.trim())}&${Tree.searchKindQuery(target.filterKind)}&offset=${offset}&limit=${pageSize}${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
      const entries = data.entries || [];
      target.entries = append ? target.entries.concat(entries) : entries;
      target.gitStatus = data.git_status || null;
      target.error = "";
      target.permissionRequired = false;
      target.filterOffset = offset + entries.length;
      target.filterDone = !data.truncated || entries.length === 0;
      target.children = {};
      target.expanded = {};
      target.loading = {};
    } catch (error) {
      setError(target, error);
      target.filterDone = true;
    }
    target.filterLoading = false;
    renderIfActive(target, true);
  }

  async function loadTree(path, preserveFocus = false) {
    const target = state;
    if (!target.cwd) return;
    target.refreshing = true;
    renderIfActive(target);
    try {
      target.error = "";
      target.permissionRequired = false;
      const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(path || "")}&depth=0${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
      target.path = data.path || "";
      target.entries = data.entries || [];
      target.gitStatus = data.git_status || null;
      target.children = {};
      target.expanded = {};
      target.loading = {};
      target.filterOffset = 0;
      target.filterDone = !target.filter.trim();
    } catch (error) {
      setError(target, error);
    }
    target.refreshing = false;
    renderIfActive(target, preserveFocus);
  }

  function renderPreservingScroll() {
    const side = document.querySelector(".file-browser-side");
    const top = side ? side.scrollTop : state.filterScrollTop || 0;
    const contentPane = document.querySelector(".file-browser-content-pane-body");
    const contentTop = contentPane ? contentPane.scrollTop : 0;
    const active = document.activeElement;
    const refocusFilter = active && active.id === "fileBrowserFilter";
    const refocusSide = !refocusFilter && side && active === side;
    const selectionStart = refocusFilter ? active.selectionStart : null;
    const selectionEnd = refocusFilter ? active.selectionEnd : null;
    render();
    const next = document.querySelector(".file-browser-side");
    if (next) next.scrollTop = top;
    const nextContentPane = document.querySelector(".file-browser-content-pane-body");
    if (nextContentPane) nextContentPane.scrollTop = contentTop;
    if (refocusFilter) {
      const input = document.getElementById("fileBrowserFilter");
      if (input) {
        input.focus({ preventScroll: true });
        const start = selectionStart == null ? input.value.length : Math.min(selectionStart, input.value.length);
        const end = selectionEnd == null ? start : Math.min(selectionEnd, input.value.length);
        input.setSelectionRange(start, end);
      }
    } else if (refocusSide && next) {
      next.focus({ preventScroll: true });
    }
  }

  async function loadFile(path, mode, searchHighlight) {
    const target = state;
    try {
      target.error = "";
      target.permissionRequired = false;
      const replacePath = currentFilePathFor(target);
      target.selected = path;
      if (target.files.some((file) => file.path === path)) {
        const existing = target.files.find((file) => file.path === path);
        if (existing) existing.searchHighlight = searchHighlight || null;
        renderIfActive(target);
        return;
      }
      renderIfActive(target);
      const file = await api(`/api/file-browser/file?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(path)}`);
      const nextFile = Object.assign(file, { draft: file.content || "", editing: false, dirty: false, saving: false, error: "", searchHighlight: searchHighlight || null });
      if (mode === "split") {
        target.files.push(nextFile);
        target.split = true;
      } else if (mode === "replace") {
        const index = Math.max(0, target.files.findIndex((file) => file.path === replacePath));
        if (target.files.length) target.files[index] = nextFile;
        else target.files.push(nextFile);
      } else {
        target.files.push(nextFile);
      }
    } catch (error) {
      setError(target, error);
    }
    renderIfActive(target);
  }

  function currentFileFor(target) {
    return target.files.find((file) => file.path === target.selected) || target.files[target.files.length - 1] || null;
  }

  function currentFilePathFor(target) {
    const file = currentFileFor(target);
    return file ? file.path : "";
  }

  function currentFile() {
    return currentFileFor(state);
  }

  function currentFilePath() {
    return currentFilePathFor(state);
  }

  function syncContentSearchOptions(target = state) {
    const opts = contentSearchOptions();
    target.contentSearch.minChars = opts.minChars;
    target.contentSearch.pageSize = opts.pageSize;
    target.contentSearch.contextLines = opts.contextLines;
    target.contentSearch.maxMatchesPerFile = opts.maxMatchesPerFile;
    target.contentSearch.autoCollapseFiles = opts.autoCollapseFiles;
    target.contentSearch.defaultExpanded = opts.defaultExpanded;
    target.contentSearch.matchCase = opts.matchCase;
    target.contentSearch.regex = opts.regex;
  }

  async function runContentSearch(append = false) {
    const target = state;
    const content = target.contentSearch;
    content.query = target.filter;
    syncContentSearchOptions(target);
    if (!target.cwd || content.query.trim().length < content.minChars) {
      content.active = true;
      clearContentSearchResults(content);
      content.done = true;
      content.error = content.query.trim() ? `Type at least ${content.minChars} characters to search file contents.` : "";
      renderIfActive(target, true);
      return;
    }
    content.active = true;
    const offset = append ? content.offset : 0;
    content.loading = true;
    content.error = "";
    renderIfActive(target, true);
    try {
      const data = await api(`/api/file-browser/content-search?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(target.path || "")}&q=${encodeURIComponent(content.query.trim())}&offset=${offset}&limit=${content.pageSize}&context_lines=${content.contextLines}&max_matches_per_file=${content.maxMatchesPerFile}&match_case=${content.matchCase ? "true" : "false"}&regex=${content.regex ? "true" : "false"}`);
      const files = data.files || [];
      content.files = append ? content.files.concat(files) : files;
      target.error = "";
      target.permissionRequired = false;
      content.totalFiles = data.total_files || files.length;
      content.totalMatches = data.total_matches || 0;
      content.offset = offset + files.length;
      content.done = !data.truncated || files.length === 0;
      if (!append) {
        content.expanded = {};
        const expanded = defaultContentExpanded(content, content.files.length);
        for (const file of content.files) content.expanded[file.path] = expanded;
      } else {
        const expanded = defaultContentExpanded(content, content.files.length);
        for (const file of files) if (!Object.prototype.hasOwnProperty.call(content.expanded, file.path)) content.expanded[file.path] = expanded;
      }
    } catch (error) {
      setError(target, error);
      content.error = target.permissionRequired ? "Folder access is required to search file contents." : error.message || String(error);
      content.done = true;
    }
    content.loading = false;
    renderIfActive(target, true);
  }

  function contentFile(path) {
    return state.contentSearch.files.find((file) => file.path === path) || null;
  }

  function matchHighlight(match, query) {
    if (!match) return null;
    return {
      line: Math.max(1, Number(match.line || match.start_line || 1)),
      from: Math.max(0, Number(match.match_start) || 0),
      to: Math.max(0, Number(match.match_end) || 0),
      query: String(query || ""),
    };
  }

  async function loadContentSearchFile(path, extraContext) {
    const content = state.contentSearch;
    if (!state.cwd || !content.query.trim()) return;
    syncContentSearchOptions(state);
    const contextLines = Math.max(content.contextLines, Number(extraContext) || content.contextLines);
    const data = await api(`/api/file-browser/content-search/file?cwd=${encodeURIComponent(state.cwd)}&file=${encodeURIComponent(path)}&q=${encodeURIComponent(content.query.trim())}&context_lines=${contextLines}&max_matches_per_file=500&match_case=${content.matchCase ? "true" : "false"}&regex=${content.regex ? "true" : "false"}`);
    if (!data.file) return;
    const index = state.contentSearch.files.findIndex((file) => file.path === path);
    if (index >= 0) state.contentSearch.files[index] = data.file;
    state.contentSearch.expanded[path] = true;
  }

  function render() {
    if (!state.open) return;
    let panel = document.getElementById("fileBrowserPanel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "fileBrowserPanel";
      panel.className = "file-browser-panel";
      const shell = document.getElementById("terminalShell");
      (shell && shell.parentNode ? shell.parentNode : document.body).appendChild(panel);
    }
    syncTerminalVisibility();
    const activeFile = currentFile();
    const entries = treeEntries();
    const currentRow = Tree.renderCurrentDirectoryRow({ callback: "HerdrFileBrowser", canGoUp: canGoUp(), path: currentDirectoryPath(), label: currentDirectoryLabel(), title: currentDirectoryTitle() });
    const sideBody = `${currentRow}${Tree.renderEntries(entries, { selectedPath: state.selected, callback: "HerdrFileBrowser", showMeta: true, dirClickMethod: "none", dirDoubleClickMethod: "enter", contextMethod: "menu", shiftSelectMode: true })}`;
    panel.innerHTML = `<aside class="file-browser-side ${activeFile ? "previewing" : ""} ${state.contentSearch.active ? "content-searching" : ""}" tabindex="0"><div class="file-browser-head"><div class="file-browser-title-row"><div class="file-browser-title">Files</div><div class="file-browser-actions">${appRefreshIconButton({ className: "file-browser-refresh", title: "Refresh", label: "Refresh files", spinning: !!state.refreshing, onclick: "HerdrFileBrowser.refresh()" })}</div></div><div class="file-browser-subtitle">${esc(state.path || state.cwd || "No workspace")}</div><div class="file-browser-result-count">Use header search (⌕) to find workspaces, files, folders, or file contents.</div></div>${renderAccessError()}${sideBody}</aside><main class="file-browser-main"><div class="file-browser-toolbar">${renderToolbar(activeFile)}</div><div class="file-browser-preview ${state.split || state.contentSearch.active ? "split" : ""}" id="fileBrowserPreview">${renderPreviewShell()}</div></main>${renderContextMenu()}`;
    mountEditors();
    mountContentSearchEditors();
  }

  function renderAccessError() {
    if (!state.error) return "";
    const action = state.permissionRequired ? `<button class="git-ui-btn primary" onclick="HerdrFileBrowser.requestAccess()">Grant folder access</button>` : "";
    return `<div class="file-browser-error"><span>${esc(state.error)}</span>${action}</div>`;
  }

  async function requestAccess() {
    try {
      const data = await api("/api/file-browser/request-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: state.cwd, path: state.path || "" }),
      });
      if (data.path) {
        state.cwd = data.path;
        state.path = "";
      }
      await loadTree(state.path || "");
    } catch (error) {
      setError(state, error);
      renderIfActive(state);
    }
  }

  function syncTerminalVisibility() {
    const shell = document.getElementById("terminalShell");
    if (!shell) return;
    const git = document.getElementById("gitUiPanel");
    const gitOpen = !!(git && git.style.display !== "none");
    shell.style.display = state.open || gitOpen ? "none" : "";
    if (window.syncShellModeButtons) window.syncShellModeButtons();
    // Refit the terminal surface when the shell reappears so the
    // terminal does not extend below the visible area.
    if (!state.open && !gitOpen && shell.style.display !== "none") {
      if (window.HerdrTerminalFit) window.HerdrTerminalFit.afterLayout(function () {
        if (typeof fitTerminalShell === "function") fitTerminalShell();
        if (typeof fitTerminalSurface === "function") fitTerminalSurface();
      });
    }
  }

  function treeEntries() {
    const entries = flattenEntries(state.entries, 0);
    return Tree.applyGitStatus(entries, state.gitStatus);
  }

  function currentDirectoryPath() {
    return state.path || state.cwd || "";
  }

  function currentDirectoryLabel() {
    if (state.path) return Tree.basename(state.path);
    return Tree.basename(state.cwd) || state.cwd || "Files";
  }

  function currentDirectoryTitle() {
    return state.path ? `${state.cwd.replace(/\/+$/, "")}/${state.path}` : state.cwd;
  }

  function canGoUp() {
    return !!(state.path || (parentFoldersEnabled() && state.cwd && Tree.parentDirectory(state.cwd) !== state.cwd));
  }

  async function goUp() {
    if (state.path) {
      await loadTree(Tree.parentPath(state.path));
      return;
    }
    if (!parentFoldersEnabled()) return;
    const parent = Tree.parentDirectory(state.cwd);
    if (!parent || parent === state.cwd) return;
    state.cwd = parent;
    state.selected = "";
    state.files = [];
    state.split = false;
    await loadTree("");
  }

  function flattenEntries(entries, level) {
    const rows = [];
    for (const entry of entries || []) {
      const row = Object.assign({}, entry, { level, expanded: !!state.expanded[entry.path] });
      rows.push(row);
      if (entry.kind === "dir" && state.expanded[entry.path] && state.children[entry.path])
        rows.push(...flattenEntries(state.children[entry.path], level + 1));
    }
    return rows;
  }

  async function toggleDir(path) {
    const target = state;
    if (target.expanded[path]) {
      target.expanded[path] = false;
      renderIfActive(target, true);
      return;
    }
    target.expanded[path] = true;
    if (!target.children[path] && !target.loading[path]) {
      target.loading[path] = true;
      renderIfActive(target, true);
      try {
        target.children[path] = await fetchEntries(path, target);
      } catch (error) {
        target.error = error.message || String(error);
        target.expanded[path] = false;
      }
      delete target.loading[path];
    }
    renderIfActive(target, true);
  }

  function renderToolbar(file) {
    if (!file) return `<strong>Select a file</strong>`;
    const canEdit = !file.binary && !file.truncated;
    const split = state.files.length > 1 ? `<button class="git-ui-btn ${state.split ? "active" : ""}" onclick="HerdrFileBrowser.toggleSplit()">Split</button>` : "";
    const edit = canEdit && !file.editing ? `<button class="git-ui-btn" onclick="HerdrFileBrowser.edit('${arg(file.path)}')">Edit</button>` : "";
    const save = canEdit && file.editing ? `<button class="git-ui-btn primary" ${file.saving ? "disabled" : ""} onclick="HerdrFileBrowser.save('${arg(file.path)}')">${file.saving ? "Saving..." : "Save"}</button><button class="git-ui-btn" onclick="HerdrFileBrowser.cancelEdit('${arg(file.path)}')">Cancel</button>` : "";
    return `<div class="file-browser-toolbar-main">${renderFileTabs()}</div><span class="file-browser-toolbar-actions">${split}${edit}${save}<button class="git-ui-btn" onclick="HerdrFileBrowser.showHistory('${arg(file.path)}')">Show history</button><button class="git-ui-btn" onclick="HerdrFileBrowser.reload('${arg(file.path)}')">Reload</button><button class="git-ui-btn" onclick="HerdrFileBrowser.closeFile('${arg(file.path)}')">Close file</button></span>`;
  }

  function renderFileTabs() {
    if (!state.files.length) return "";
    const tabs = state.files.map((file) => {
      const active = file.path === state.selected;
      const dirty = file.dirty ? `<span class="file-browser-tab-dirty" title="Modified">●</span>` : "";
      return `<button class="file-browser-file-tab ${active ? "active" : ""}" role="tab" aria-selected="${active ? "true" : "false"}" title="${esc(file.path)}" onclick="HerdrFileBrowser.focusFile('${arg(file.path)}')"><span>${esc(Tree.basename(file.path))}</span>${dirty}<span class="file-browser-tab-close" title="Close" onclick="event.stopPropagation();HerdrFileBrowser.closeFile('${arg(file.path)}')">×</span></button>`;
    }).join("");
    return `<div class="file-browser-file-tabs" role="tablist" aria-label="Open files">${tabs}</div>`;
  }

  function renderPreviewShell() {
    const files = state.split ? state.files : [currentFile()].filter(Boolean);
    const panes = files.map((file) => `<section class="file-browser-pane ${file.path === state.selected ? "active" : ""}" data-path="${arg(file.path)}"><div class="file-browser-pane-head"><button class="git-ui-btn file-browser-pane-path-button ${file.path === state.selected ? "active" : ""}" title="${esc(file.path)}" onclick="HerdrFileBrowser.focusFile('${arg(file.path)}')"><span class="file-browser-pane-path">${esc(file.path)}</span></button><button class="file-browser-pane-find" title="Find / replace (Ctrl+F)" aria-label="Find / replace" onclick="event.stopPropagation();HerdrFileBrowser.findInFile('${arg(file.path)}')">⌕</button><button class="file-browser-pane-close" title="Close file" onclick="event.stopPropagation();HerdrFileBrowser.closeFile('${arg(file.path)}')">&times;</button></div><div class="file-browser-pane-body" id="fileBrowserEditor-${hashId(file.path)}">${previewPlaceholder(file)}</div>${file.error ? `<div class="file-browser-error">${esc(file.error)}</div>` : ""}</section>`);
    if (state.contentSearch.active) panes.push(renderContentSearchPane());
    if (!panes.length) return previewPlaceholder(null);
    return panes.join("");
  }

  function renderContentSearchPane() {
    const content = state.contentSearch;
    const contentSearch = window.HerdrContentSearch;
    const body = contentSearch
      ? contentSearch.render({ query: content.query, files: content.files, expanded: content.expanded, snippets: content.snippets, loading: content.loading, error: content.error, done: content.done, total_files: content.totalFiles, total_matches: content.totalMatches }, { callback: "HerdrFileBrowserContent", inputId: "fileContentSearchInput", hideInput: true })
      : `<div class="file-browser-empty">Content search renderer unavailable.</div>`;
    return `<section class="file-browser-pane active file-browser-content-pane"><div class="file-browser-pane-head"><button class="git-ui-btn active">Content search</button><span class="file-browser-pane-subtitle">${esc(content.query || "No query")}</span><button class="file-browser-pane-close" title="Close content search" onclick="event.stopPropagation();HerdrFileBrowser.closeContentSearch()">&times;</button></div><div class="file-browser-pane-body file-browser-content-pane-body">${body}</div></section>`;
  }

  function renderContextMenu() {
    const menu = state.contextMenu;
    if (!menu) return "";
    const primary = menu.kind === "dir"
      ? `<button onclick="HerdrFileBrowser.menuAction('enter')">Enter folder</button>`
      : `<button onclick="HerdrFileBrowser.menuAction('open')">Open</button><button onclick="HerdrFileBrowser.menuAction('split')">Open in split</button>`;
    const history = menu.kind === "file" ? `<button onclick="HerdrFileBrowser.menuAction('history')">Show history</button>` : "";
    return `<div class="git-ui-menu file-browser-menu" style="left:${Math.max(0, menu.x)}px;top:${Math.max(0, menu.y)}px" onclick="event.stopPropagation()">${primary}${history}<button onclick="HerdrFileBrowser.menuAction('rename')">Rename</button><button class="danger" onclick="HerdrFileBrowser.menuAction('delete')">Delete</button><button onclick="HerdrFileBrowser.menuAction('copyPath')">Copy path</button></div>`;
  }

  function mountEditors() {
    const files = state.split ? state.files : [currentFile()].filter(Boolean);
    for (const file of files) {
      const parent = document.getElementById(`fileBrowserEditor-${hashId(file.path)}`);
      if (!parent || file.binary || file.truncated) continue;
      window.HerdrEditor.create({
        parent,
        path: file.path,
        content: file.editing ? file.draft : file.content || "",
        readonly: !file.editing,
        hideHeader: true,
        lineNumbers: lineNumbersEnabled(),
        searchHighlight: file.searchHighlight || null,
        onChange(value) {
          file.draft = value;
          file.dirty = value !== (file.content || "");
        },
      });
    }
  }

  function mountContentSearchEditors() {
    if (!state.contentSearch.active) return;
    for (const file of state.contentSearch.files || []) {
      for (const match of file.matches || []) {
        const key = window.HerdrContentSearch.snippetKey(file.path, match);
        const snippet = state.contentSearch.snippets[key];
        if (!snippet || !snippet.editing) continue;
        const editorId = `contentSearchSnippet-${window.HerdrContentSearch.hashId(key)}`;
        const parent = document.getElementById(editorId);
        if (!parent) continue;
        window.HerdrEditor.create({
          parent,
          path: file.path,
          content: snippet.draft == null ? match.content || "" : snippet.draft,
          readonly: false,
          hideHeader: true,
          lineNumbers: lineNumbersEnabled(),
          onChange(value) {
            snippet.draft = value;
            snippet.dirty = value !== (match.content || "");
          },
        });
      }
    }
  }

  function openFindForPath(path) {
    if (!path) return false;
    const parent = document.getElementById(`fileBrowserEditor-${hashId(path)}`);
    if (window.HerdrEditor && window.HerdrEditor.openFind && window.HerdrEditor.openFind(parent)) return true;
    const file = state.files.find((file) => file.path === path);
    if (!file) return false;
    state.selected = path;
    render();
    setTimeout(() => {
      const nextParent = document.getElementById(`fileBrowserEditor-${hashId(path)}`);
      if (window.HerdrEditor && window.HerdrEditor.openFind) window.HerdrEditor.openFind(nextParent);
    }, 0);
    return true;
  }

  function focusedFilePath(target) {
    if (!state.open) return "";
    const pane = target && target.closest && target.closest(".file-browser-pane");
    if (pane && pane.classList && pane.classList.contains("file-browser-content-pane")) return "";
    if (pane && pane.getAttribute) {
      try { return decodeURIComponent(pane.getAttribute("data-path") || ""); }
      catch (_) { return ""; }
    }
    const panel = document.getElementById("fileBrowserPanel");
    const active = document.activeElement;
    const targetInside = !!(panel && target && panel.contains && panel.contains(target));
    const activeInside = !!(panel && active && panel.contains && panel.contains(active));
    if (targetInside || activeInside || target === document.body) return currentFilePath();
    return "";
  }

  function previewPlaceholder(file) {
    if (!file) return '<div class="file-browser-empty">Choose a file to preview.</div>';
    if (file.binary) return '<div class="file-browser-empty">Binary file preview unavailable.</div>';
    if (file.truncated) return `<div class="file-browser-empty">File too large to preview (${Tree.formatBytes(file.size)}).</div>`;
    return "";
  }

  function hashId(path) {
    let hash = 0;
    for (const ch of String(path || "")) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
    return Math.abs(hash).toString(36);
  }

  async function reloadFile(path) {
    const index = state.files.findIndex((file) => file.path === path);
    if (index < 0) return loadFile(path);
    const next = await api(`/api/file-browser/file?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(path)}`);
    state.files[index] = Object.assign(next, { draft: next.content || "", editing: false, dirty: false, saving: false, error: "" });
    state.selected = path;
    render();
  }

  async function saveFile(path) {
    const file = state.files.find((file) => file.path === path);
    if (!file || file.saving) return;
    file.saving = true;
    file.error = "";
    render();
    try {
      const result = await api("/api/file-browser/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: state.cwd, path: file.path, content: file.draft, expected_hash: file.hash || "" }),
      });
      file.content = file.draft;
      file.hash = result.hash || file.hash;
      file.dirty = false;
      file.editing = false;
    } catch (error) {
      file.error = error.message || String(error);
    }
    file.saving = false;
    render();
  }

  function fileName(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    return parts[parts.length - 1] || path || "";
  }

  function mutateTreeForRename(from, to, nextName) {
    state.entries = Tree.renamePathInEntries(state.entries, from, to, nextName);
    state.children = Tree.remapPathMap(state.children, from, to, (entries) => Tree.renamePathInEntries(entries, from, to, nextName));
    state.expanded = Tree.remapPathMap(state.expanded, from, to);
    state.loading = Tree.remapPathMap(state.loading, from, to);
    state.files = state.files.map((file) => Object.assign(file, { path: Tree.replacePathPrefix(file.path, from, to) }));
    if (state.selected) state.selected = Tree.replacePathPrefix(state.selected, from, to);
  }

  function mutateTreeForDelete(path) {
    state.entries = Tree.removePathFromEntries(state.entries, path);
    state.children = Tree.prunePathMap(state.children, path, (entries) => Tree.removePathFromEntries(entries, path));
    state.expanded = Tree.prunePathMap(state.expanded, path);
    state.loading = Tree.prunePathMap(state.loading, path);
    state.files = state.files.filter((file) => file.path !== path && !file.path.startsWith(`${path}/`));
    if (state.selected === path || state.selected.startsWith(`${path}/`)) state.selected = (state.files[state.files.length - 1] || {}).path || "";
    if (state.files.length < 2) state.split = false;
  }

  async function refreshParentAfterMutation(path) {
    if (state.filter.trim() && state.filterKind !== "content") {
      await fetchFilteredEntries(false);
      return;
    }
    const parent = Tree.parentPath(path);
    if (parent === state.path) {
      renderPreservingScroll();
      return;
    }
    if (state.expanded[parent]) {
      try { state.children[parent] = await fetchEntries(parent); }
      catch (error) { state.error = error.message || String(error); }
    }
    renderPreservingScroll();
  }

  async function renamePath(path) {
    const nextName = prompt("Rename to", fileName(path));
    if (!nextName || nextName === fileName(path)) return;
    if (!confirm(`Rename ${path} to ${nextName}?`)) return;
    await api("/api/file-browser/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: state.cwd, path, new_name: nextName }),
    });
    const parent = Tree.parentPath(path);
    const to = parent ? `${parent}/${nextName}` : nextName;
    mutateTreeForRename(path, to, nextName);
    await refreshParentAfterMutation(to);
  }

  async function deletePath(path) {
    if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
    await api("/api/file-browser/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: state.cwd, path }),
    });
    mutateTreeForDelete(path);
    await refreshParentAfterMutation(path);
  }

  function runUnifiedSearch(append = false) {
    if (!state.filter.trim()) {
      if (state.filterKind === "content") {
        state.contentSearch.query = "";
        clearContentSearchResults(state.contentSearch);
        renderPreservingScroll();
      } else {
        loadTree(state.path, true);
      }
      return;
    }
    if (state.filterKind === "content") {
      state.contentSearch.query = state.filter;
      state.contentSearch.active = true;
      runContentSearch(append);
    } else {
      fetchFilteredEntries(append);
    }
  }

  window.HerdrFileBrowser = {
    open,
    openAt,
    close: hide,
    hide,
    forgetWorkspace,
    refresh() { loadTree(state.path); },
    requestAccess,
    setFilterKind(kind) {
      state.filterKind = normalizeSearchScope(kind);
      state.filterVisible = true;
      if (state.filterKind === "content") state.contentSearch.active = !!state.filter.trim() || state.contentSearch.active;
      if (state.filter.trim()) runUnifiedSearch(false);
      else renderPreservingScroll();
    },
    toggleFilterKind() { this.setFilterKind(nextSearchScope(state.filterKind)); },
    filter(value) {
      state.filter = String(value || "");
      state.filterVisible = !!state.filter || state.filterVisible;
      if (state.filterKind === "content") state.contentSearch.query = state.filter;
      clearTimeout(state.filterTimer);
      state.filterTimer = setTimeout(() => runUnifiedSearch(false), state.filterKind === "content" ? 350 : 500);
    },
    searchKeydown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key && event.key.toLowerCase() === "s") return;
      if (event.key === "Enter") { event.preventDefault(); clearTimeout(state.filterTimer); runUnifiedSearch(false); }
      if (event.key === "Escape") { event.preventDefault(); this.clearFilter(); }
    },
    showSearch() {
      state.filterVisible = true;
      renderPreservingScroll();
      setTimeout(() => document.getElementById("fileBrowserFilter")?.focus(), 0);
    },
    clearFilter() {
      state.filter = "";
      state.contentSearch.query = "";
      clearContentSearchResults(state.contentSearch);
      state.filterVisible = state.contentSearch.active;
      clearTimeout(state.filterTimer);
      if (state.filterKind === "content") renderPreservingScroll();
      else loadTree(state.path, true);
    },
    focusTree() { state.filterVisible = true; renderPreservingScroll(); },
    blurTree() { if (!state.filter.trim() && !state.contentSearch.active) { state.filterVisible = false; renderPreservingScroll(); } },
    toggleContentSearch() {
      this.setFilterKind("content");
      this.showSearch();
    },
    closeContentSearch() {
      state.contentSearch.active = false;
      render();
    },
    loadMore() { runUnifiedSearch(true); },
    sideScroll(node) {
      state.filterScrollTop = node.scrollTop;
      if (state.filterKind === "content" || !state.filter.trim() || state.filterLoading || state.filterDone) return;
      if (node.scrollTop + node.clientHeight >= node.scrollHeight - 80) fetchFilteredEntries(true);
    },
    typeToFilter(event) {
      if (!event || event.metaKey || event.ctrlKey || event.defaultPrevented) return;
      if (event.altKey && event.key && event.key.toLowerCase() === "f") { event.preventDefault(); this.setFilterKind("file"); return; }
      if (event.altKey && event.key && event.key.toLowerCase() === "d") { event.preventDefault(); this.setFilterKind("dir"); return; }
      if (event.altKey && event.key && event.key.toLowerCase() === "c") { event.preventDefault(); this.setFilterKind("content"); return; }
      if (event.altKey || event.defaultPrevented) return;
      if (event.target && event.target.closest && event.target.closest("input, textarea, select")) return;
      if (event.key === "Escape") { event.preventDefault(); this.clearFilter(); return; }
      if (event.key === "Backspace") {
        event.preventDefault();
        this.filter(state.filter.slice(0, -1));
        renderPreservingScroll();
        return;
      }
      if (event.key.length !== 1) return;
      event.preventDefault();
      this.filter(state.filter + event.key);
      renderPreservingScroll();
    },
    up() { goUp(); },
    toggle(encodedPath) { toggleDir(decodeURIComponent(encodedPath)); },
    enter(encodedPath) { loadTree(decodeURIComponent(encodedPath)); },
    select(encodedPath, mode) { loadFile(decodeURIComponent(encodedPath), mode); },
    focusFile(encodedPath) { state.selected = decodeURIComponent(encodedPath); render(); },
    findInFile(encodedPath) {
      return openFindForPath(decodeURIComponent(encodedPath));
    },
    openFocusedFind(target) {
      return openFindForPath(focusedFilePath(target));
    },
    closeFile(encodedPath) {
      const path = decodeURIComponent(encodedPath);
      const file = state.files.find((file) => file.path === path);
      if (file && file.dirty && !confirm(`Close ${path} with unsaved changes?`)) return;
      state.files = state.files.filter((file) => file.path !== path);
      if (state.selected === path) state.selected = (state.files[state.files.length - 1] || {}).path || "";
      if (state.files.length < 2) state.split = false;
      render();
    },
    toggleSplit() { state.split = !state.split; render(); },
    menu(event, encodedPath, kind) {
      event.preventDefault();
      event.stopPropagation();
      state.contextMenu = { x: event.clientX, y: event.clientY, path: decodeURIComponent(encodedPath), kind };
      render();
      return false;
    },
    async menuAction(action) {
      const menu = state.contextMenu;
      if (!menu) return;
      state.contextMenu = null;
      try {
        if (action === "open") await loadFile(menu.path);
        if (action === "split") await loadFile(menu.path, "split");
        if (action === "enter") await loadTree(menu.path);
        if (action === "history") { this.showHistory(encodeURIComponent(menu.path)); return; }
        if (action === "rename") await renamePath(menu.path);
        if (action === "delete") await deletePath(menu.path);
        if (action === "copyPath") {
          await navigator.clipboard.writeText(`${state.cwd}/${menu.path}`);
          render();
        }
      } catch (error) {
        state.error = error.message || String(error);
        render();
      }
    },
    edit(encodedPath) {
      const file = state.files.find((file) => file.path === decodeURIComponent(encodedPath));
      if (!file) return;
      file.editing = true;
      file.draft = file.content || "";
      file.dirty = false;
      render();
    },
    cancelEdit(encodedPath) {
      const file = state.files.find((file) => file.path === decodeURIComponent(encodedPath));
      if (!file) return;
      file.editing = false;
      file.draft = file.content || "";
      file.dirty = false;
      render();
    },
    save(encodedPath) { saveFile(decodeURIComponent(encodedPath)); },
    reload(encodedPath) { reloadFile(decodeURIComponent(encodedPath)).catch((error) => { state.error = error.message || String(error); render(); }); },
    showHistory(encodedPath) {
      const path = decodeURIComponent(encodedPath || "");
      if (!path || !window.HerdrGitUi || !window.HerdrGitUi.openFileHistory) return;
      hide();
      window.HerdrGitUi.openFileHistory(encodeURIComponent(state.cwd), encodeURIComponent(path));
    },
    isVisible() { return state.open; },
    isWorkspaceVisible(workspace) { return state.open && activeKey === workspaceKey(workspace); },
    syncTerminalVisibility,
  };

  window.HerdrFileBrowserContent = {
    setQuery(value) {
      state.filter = String(value || "");
      state.contentSearch.query = state.filter;
      clearTimeout(state.contentSearch.timer);
      state.contentSearch.timer = setTimeout(() => runContentSearch(false), 350);
    },
    inputKeydown(event) {
      if ((event.metaKey || event.ctrlKey) && event.key && event.key.toLowerCase() === "s") {
        event.preventDefault();
        return;
      }
      if (event.key === "Enter") { event.preventDefault(); runContentSearch(false); }
      if (event.key === "Escape") { event.preventDefault(); this.clear(); }
    },
    run() { runContentSearch(false); },
    clear() {
      const content = state.contentSearch;
      state.filter = "";
      content.query = "";
      content.files = [];
      content.expanded = {};
      content.snippets = {};
      content.error = "";
      content.offset = 0;
      content.done = true;
      content.totalFiles = 0;
      content.totalMatches = 0;
      render();
    },
    loadMore() { runContentSearch(true); },
    toggleFile(encodedPath) {
      const path = decodeURIComponent(encodedPath);
      state.contentSearch.expanded[path] = !state.contentSearch.expanded[path];
      renderPreservingScroll();
    },
    async loadFile(encodedPath) {
      try { await loadContentSearchFile(decodeURIComponent(encodedPath)); }
      catch (error) { state.contentSearch.error = error.message || String(error); }
      renderPreservingScroll();
    },
    openFile(encodedPath) { loadFile(decodeURIComponent(encodedPath)); },
    openMatch(encodedPath, encodedMatchId) {
      const path = decodeURIComponent(encodedPath);
      const file = contentFile(path);
      const match = window.HerdrContentSearch.findMatch(file, decodeURIComponent(encodedMatchId));
      loadFile(path, undefined, matchHighlight(match, state.contentSearch.query));
    },
    expandAll() {
      for (const file of state.contentSearch.files || []) state.contentSearch.expanded[file.path] = true;
      renderPreservingScroll();
    },
    collapseAll() {
      state.contentSearch.expanded = {};
      renderPreservingScroll();
    },
    editSnippet(encodedPath, encodedMatchId) {
      const path = decodeURIComponent(encodedPath);
      const matchId = decodeURIComponent(encodedMatchId);
      const file = contentFile(path);
      const match = window.HerdrContentSearch.findMatch(file, matchId);
      if (!file || !match) return;
      const key = window.HerdrContentSearch.snippetKey(path, match);
      state.contentSearch.snippets[key] = { editing: true, draft: match.content || "", dirty: false, saving: false, error: "" };
      render();
    },
    cancelSnippet(encodedPath, encodedMatchId) {
      const path = decodeURIComponent(encodedPath);
      const matchId = decodeURIComponent(encodedMatchId);
      const file = contentFile(path);
      const match = window.HerdrContentSearch.findMatch(file, matchId);
      if (!match) return;
      delete state.contentSearch.snippets[window.HerdrContentSearch.snippetKey(path, match)];
      render();
    },
    async saveSnippet(encodedPath, encodedMatchId) {
      const path = decodeURIComponent(encodedPath);
      const matchId = decodeURIComponent(encodedMatchId);
      const file = contentFile(path);
      const match = window.HerdrContentSearch.findMatch(file, matchId);
      if (!file || !match) return;
      const key = window.HerdrContentSearch.snippetKey(path, match);
      const snippet = state.contentSearch.snippets[key];
      if (!snippet || snippet.saving) return;
      snippet.saving = true;
      snippet.error = "";
      render();
      try {
        const result = await api("/api/file-browser/content-search/snippet", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: state.cwd, path, expected_hash: file.hash || "", start_line: match.start_line, end_line: match.end_line, content: snippet.draft || "" }),
        });
        file.hash = result.hash || file.hash;
        delete state.contentSearch.snippets[key];
        await loadContentSearchFile(path);
      } catch (error) {
        snippet.error = error.message || String(error);
      }
      if (snippet) snippet.saving = false;
      render();
    },
    async expandSnippet(encodedPath, _encodedMatchId, _direction) {
      const path = decodeURIComponent(encodedPath);
      const currentContext = Number(state.contentSearch.contextLines || contentSearchOptions().contextLines || 2);
      const nextContext = window.HerdrLineContext && window.HerdrLineContext.nextContextSize
        ? window.HerdrLineContext.nextContextSize(currentContext, { min: 3, max: 20 })
        : Math.min(20, currentContext < 3 ? 3 : currentContext * 2);
      state.contentSearch.contextLines = nextContext;
      try { await loadContentSearchFile(path, nextContext); }
      catch (error) { state.contentSearch.error = error.message || String(error); }
      renderPreservingScroll();
    },
  };
})();
