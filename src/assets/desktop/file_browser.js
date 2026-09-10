(function () {
  const Tree = window.HerdrFileTree;
  const DEFAULT_CONTENT_SEARCH_MIN_CHARS = 3;
  const stateCache = {};
  // Per-workspace editor instance cache (IDE-review C4): CodeMirror views are
  // expensive to create, and render() rewrites panel.innerHTML on every pass,
  // so mountEditors() reattaches the cached editor DOM node when the file's
  // editor signature (content, editability, preview mode, search highlight,
  // editor options) is unchanged instead of recreating the instance.
  const editorCache = new Map();
  let activeKey = "";
  let state = createState();

  function createContentSearchState() {
    return { active: false, query: "", timer: null, files: [], expanded: {}, loading: false, error: "", offset: 0, done: true, totalFiles: 0, totalMatches: 0, visited: 0, truncated: false, contextLines: 2, maxMatchesPerFile: 5, autoCollapseFiles: 0, defaultExpanded: true };
  }

  function createState(initial) {
    return Object.assign({ open: false, cwd: "", root: "", home: "", path: "", entries: [], children: {}, expanded: {}, loading: {}, selected: "", files: [], split: false, error: "", permissionRequired: false, contextMenu: null, filter: "", filterTimer: null, filterVisible: false, filterLoading: false, filterOffset: 0, filterDone: true, filterScrollTop: 0, filterKind: "file", gitStatus: null, refreshing: false, contentSearch: createContentSearchState() }, initial || {});
  }

  function esc(value) { return Tree.esc(value); }
  const hashId = HerdrAppHelpers.hashId;
  function arg(value) { return Tree.arg(value); }

  function gitStatusEnabled() {
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      return parsed.fileBrowserGitStatus !== false;
    } catch (_) { return true; }
  }

  function lineNumbersEnabled() {
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      return parsed.fileBrowserLineNumbers !== false;
    } catch (_) { return true; }
  }

  function editorOptions() {
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      return {
        editorEnabled: parsed.editorEnabled !== false,
        wordWrap: parsed.editorEnabled !== false && parsed.editorWordWrap !== false,
        tabSize: Math.max(1, Math.min(8, Number(parsed.editorTabSize) || 2)),
        bracketMatching: parsed.editorEnabled !== false && parsed.editorBracketMatching !== false,
        folding: parsed.editorEnabled !== false && parsed.editorFolding !== false,
        activeLine: parsed.editorEnabled !== false && parsed.editorActiveLine !== false,
        whitespace: parsed.editorEnabled === true && parsed.editorWhitespace === true,
      };
    } catch (_) {
      return { editorEnabled: true, wordWrap: true, tabSize: 2, bracketMatching: true, folding: true, activeLine: true, whitespace: false };
    }
  }

  function parentFoldersEnabled() {
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      return parsed.fileBrowserAllowParent === true;
    } catch (_) { return false; }
  }

  function pathSearchOptions() {
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      return { pageSize: Math.max(10, Math.min(500, Number(parsed.fileBrowserSearchPageSize) || 100)) };
    } catch (_) { return { pageSize: 100 }; }
  }

  function contentSearchOptions() {
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
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

  function cacheTreeRoots(target, data) {
    if (!target || !data) return;
    if (data.root) target.root = String(data.root);
    if (data.home) target.home = String(data.home);
  }

  function normalizeDisplayPath(path) {
    return String(path || "").replace(/\/+/g, "/");
  }

  function absoluteFilePath(path) {
    const value = String(path || "");
    if (!value) return normalizeDisplayPath(state.root || state.cwd || "");
    if (value === "~" || value.startsWith("~/") || value.startsWith("/")) return normalizeDisplayPath(value);
    const root = String(state.root || state.cwd || "").replace(/\/+$/, "");
    if (!root || root === "/") return normalizeDisplayPath(`/${value.replace(/^\/+/, "")}`);
    return normalizeDisplayPath(`${root}/${value.replace(/^\/+/, "")}`);
  }

  function fileTabTooltipPath(path) {
    const absolute = absoluteFilePath(path);
    const home = normalizeDisplayPath(state.home || "").replace(/\/+$/, "");
    if (home && absolute === home) return "~";
    if (home && absolute.startsWith(`${home}/`)) return `~/${absolute.slice(home.length + 1)}`;
    return absolute;
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
    content.error = "";
    content.offset = 0;
    content.done = true;
    content.totalFiles = 0;
    content.totalMatches = 0;
    content.visited = 0;
    content.truncated = false;
  }

  document.addEventListener("click", () => {
    if (!state.contextMenu) return;
    state.contextMenu = null;
    if (state.open) render();
  });
  document.addEventListener("click", (event) => {
    const target = event.target && event.target.closest ? event.target : event.target && event.target.parentElement;
    const button = target && target.closest && target.closest(".file-browser-menu [data-file-menu-action]");
    if (!button) return undefined;
    event.preventDefault();
    event.stopPropagation();
    if (event.stopImmediatePropagation) event.stopImmediatePropagation();
    return handleMenuAction(button.dataset.fileMenuAction);
  }, true);
  window.addEventListener("keydown", (event) => {
    if (!state.open || !state.contextMenu || event.key !== "Escape") return;
    event.preventDefault();
    state.contextMenu = null;
    render();
  }, true);
  window.addEventListener("keydown", (event) => {
    if (!state.open || !state.contextMenu || !event || event.defaultPrevented) return;
    const key = event.key;
    if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
    const items = Array.from(document.querySelectorAll('.file-browser-menu [role="menuitem"]') || []);
    if (!items.length) return;
    event.preventDefault();
    const active = items.find((b) => b === document.activeElement);
    const delta = key === "ArrowDown" ? 1 : -1;
    const activeIndex = items.indexOf(active);
    let index;
    if (key === "Home") index = 0;
    else if (key === "End") index = items.length - 1;
    else if (activeIndex < 0) index = key === "ArrowDown" ? 0 : items.length - 1;
    else index = (activeIndex + delta + items.length) % items.length;
    const target = items[index];
    if (target && typeof target.focus === "function") target.focus();
  }, true);
  window.addEventListener("keydown", (event) => {
    if (!state.open || !event || event.defaultPrevented || event.altKey || event.shiftKey) return;
    const key = String(event.key || "").toLowerCase();
    if (key !== "s" || !(event.metaKey || event.ctrlKey)) return;
    const path = focusedFilePath(event.target);
    const file = path ? state.files.find((f) => f.path === path) : null;
    if (!file || file.binary || file.truncated) return;
    event.preventDefault();
    event.stopPropagation();
    if (file.saving) return;
    saveFile(file.path);
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
    if (window.rememberWorkspaceShellMode) window.rememberWorkspaceShellMode("files", state.ws, { minimized: false });
    if (window.syncShellModeButtons) window.syncShellModeButtons();
    activateState(key, cwd);
    state.open = true;
    const preserveContext = options.preserveContext === true && options.kind !== "dir";
    if (!preserveContext) {
      state.filter = "";
      state.filterVisible = false;
      state.filterKind = "file";
      state.contentSearch.active = false;
      clearContentSearchResults(state.contentSearch);
    }
    render();
    if (options.kind === "dir") {
      await loadTree(path || "");
      return;
    }
    if (!preserveContext) {
      const parent = Tree.parentPath(path || "");
      await loadTree(parent || "");
    }
    if (path) await loadFile(path, options.mode || (preserveContext ? "append" : undefined), options.highlight || null);
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
    for (const cacheKey of Array.from(editorCache.keys())) {
      if (cacheKey.startsWith(`${key}|`)) forgetEditor(cacheKey.slice(key.length + 1));
    }
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
    cacheTreeRoots(target, data);
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
      cacheTreeRoots(target, data);
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
      cacheTreeRoots(target, data);
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
        if (existing) {
          existing.searchHighlight = searchHighlight || null;
          // Content-search matches must remain usable when the markdown file
          // is already open in rendered preview mode. Force its source view
          // so the editor can show the highlighted line and scroll position.
          if (searchHighlight) existing.previewSource = true;
        }
        renderIfActive(target, true);
        return;
      }
      renderIfActive(target, true);
      const file = await api(`/api/file-browser/file?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(path)}&render=lines`);
      const linesHtml = file.lines_gutter_html != null && file.lines_code_html != null ? { gutter: file.lines_gutter_html, code: file.lines_code_html } : null;
      // Markdown opens read-only so the rendered preview engages; every other
      // file keeps the edit-by-default behavior. Search highlights force the
      // source view so the matches stay visible.
      const isMarkdown = markdownPath(path);
      const editing = !isMarkdown;
      const nextFile = Object.assign(file, { draft: file.content || "", editing, dirty: false, saving: false, error: "", searchHighlight: searchHighlight || null, previewSource: !!searchHighlight, linesHtml });
      if (mode === "split") {
        target.files.push(nextFile);
        target.split = true;
      } else if (mode === "append") {
        target.files.push(nextFile);
      } else {
        const index = Math.max(0, target.files.findIndex((file) => file.path === replacePath));
        if (target.files.length) target.files[index] = nextFile;
        else target.files.push(nextFile);
      }
    } catch (error) {
      setError(target, error);
    }
    renderIfActive(target, true);
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
      content.visited = Number(data.visited || 0);
      content.truncated = data.truncated === true;
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
    panel.innerHTML = `<aside class="file-browser-side ${activeFile ? "previewing" : ""} ${state.contentSearch.active ? "content-searching" : ""}" tabindex="0"><div class="file-browser-head"><div class="file-browser-title-row"><div class="file-browser-title">Files</div><div class="file-browser-actions">${appRefreshIconButton({ className: "file-browser-refresh", title: "Refresh", label: "Refresh files", spinning: !!state.refreshing, onclick: "HerdrFileBrowser.refresh()" })}</div></div><div class="file-browser-subtitle">${esc(state.path || state.cwd || "No workspace")}</div><div class="file-browser-result-count">Open a file, then use its ⌕ button or Cmd/Ctrl-F to search inside it.</div></div>${renderAccessError()}${sideBody}</aside><main class="file-browser-main"><div class="file-browser-toolbar">${renderToolbar(activeFile)}</div><div class="file-browser-preview ${state.split || state.contentSearch.active ? "split" : ""}" id="fileBrowserPreview">${renderPreviewShell()}</div></main>${renderContextMenu()}`;
    mountEditors();
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

  function markdownPath(path) {
    return !!(window.HerdrEditor && window.HerdrEditor.isMarkdownPath && window.HerdrEditor.isMarkdownPath(path));
  }

  function renderToolbar(file) {
    if (!file) return `<strong>Select a file</strong>`;
    const preview = markdownToggleHtml(file);
    const tabs = renderOpenFileTabs();
    const split = state.files.length > 1 ? `<button class="git-ui-btn ${state.split ? "active" : ""}" onclick="HerdrFileBrowser.toggleSplit()">Split</button>` : "";
    const canEdit = !file.binary && !file.truncated;
    const lock = canEdit ? lockToggleHtml(file) : "";
    const lspBadge = lspDiagnosticBadge(file.path);
    return `${tabs || singleTab(file)}<span class="file-browser-toolbar-actions">${lspBadge}${preview}${split}${lock}<button class="git-ui-btn" onclick="HerdrFileBrowser.toggleFind('${arg(file.path)}')">Find</button></span>`;
  }

  function lockToggleHtml(file) {
    const locked = !file.editing;
    const title = locked ? "Unlock to edit" : "Lock (read-only)";
    return `<button type="button" class="file-browser-lock-toggle ${locked ? "active" : ""}" title="${esc(title)}" aria-label="${esc(title)}" aria-pressed="${locked ? "true" : "false"}" onclick="HerdrFileBrowser.toggleLock('${arg(file.path)}')"><span></span></button>`;
  }

  // Markdown files get an eye toggle (styled like the editor find button)
  // that switches between the rendered preview and the CodeMirror source view.
  // Only offered while the file is locked (read-only): the rendered preview
  // needs a non-editable mount, and editing markdown keeps the source view.
  function markdownToggleHtml(file) {
    if (!markdownPath(file.path) || file.editing || file.binary || file.truncated) return "";
    const previewing = !file.previewSource;
    const title = previewing ? "Show markdown source" : "Show rendered markdown preview";
    return `<button type="button" class="file-browser-preview-toggle ${previewing ? "active" : ""}" title="${esc(title)}" aria-label="${esc(title)}" aria-pressed="${previewing ? "true" : "false"}" onclick="HerdrFileBrowser.toggleMarkdownView('${arg(file.path)}')"><span></span></button>`;
  }

  function singleTab(file) {
    const dirty = file.dirty ? `<span class="file-browser-tab-dirty" title="Modified">●</span>` : "";
    const tooltip = fileTabTooltipPath(file.path);
    return `<div class="file-browser-open-tabs" role="tablist" aria-label="Open files"><span class="file-browser-open-tab active" role="presentation" title="${esc(tooltip)}" oncontextmenu="event.preventDefault();event.stopPropagation();return HerdrFileBrowser.tabMenu(event,'${arg(file.path)}')"><button type="button" class="file-browser-open-tab-label" role="tab" aria-selected="true" title="${esc(tooltip)}" onclick="HerdrFileBrowser.focusFile('${arg(file.path)}')">${esc(Tree.basename(file.path))}${dirty}</button><button type="button" class="file-browser-open-tab-close" title="Close ${esc(Tree.basename(file.path))}" aria-label="Close ${esc(Tree.basename(file.path))}" onclick="event.stopPropagation();HerdrFileBrowser.closeFile('${arg(file.path)}')">&times;</button></span></div>`;
  }

  function renderPreviewShell() {
    const files = state.split ? state.files : [currentFile()].filter(Boolean);



    const panes = files.map((file) => {
      return `<section class="file-browser-pane ${file.path === state.selected ? "active" : ""}" data-path="${arg(file.path)}"><div class="file-browser-pane-body" id="fileBrowserEditor-${hashId(file.path)}">${previewPlaceholder(file)}</div>${file.error ? `<div class="file-browser-error">${esc(file.error)}</div>` : ""}</section>`;
    });



    if (state.contentSearch.active) panes.push(renderContentSearchPane());
    if (!panes.length) return previewPlaceholder(null);
    return panes.join("");
  }

  function renderOpenFileTabs() {
    if (state.files.length < 2) return "";
    const tabs = state.files.map((file) => {
      const active = file.path === state.selected;
      const dirty = file.dirty ? `<span class="file-browser-tab-dirty" title="Modified">●</span>` : "";
      const tooltip = fileTabTooltipPath(file.path);
      const ctxMenu = ` oncontextmenu="event.preventDefault();event.stopPropagation();return HerdrFileBrowser.tabMenu(event,'${arg(file.path)}')"`;
      return `<span class="file-browser-open-tab ${active ? "active" : ""}" role="presentation" title="${esc(tooltip)}"${ctxMenu}><button type="button" class="file-browser-open-tab-label" role="tab" aria-selected="${active ? "true" : "false"}" title="${esc(tooltip)}" onclick="HerdrFileBrowser.focusFile('${arg(file.path)}')">${esc(Tree.basename(file.path))}${dirty}</button><button type="button" class="file-browser-open-tab-close" title="Close ${esc(Tree.basename(file.path))}" aria-label="Close ${esc(Tree.basename(file.path))}" onclick="event.stopPropagation();HerdrFileBrowser.closeFile('${arg(file.path)}')">&times;</button></span>`;
    }).join("");
    return `<div class="file-browser-open-tabs" role="tablist" aria-label="Open files">${tabs}</div>`;
  }

  function renderContentSearchPane() {
    const content = state.contentSearch;
    const contentSearch = window.HerdrContentSearch;
    const body = contentSearch
      ? contentSearch.render({ query: content.query, files: content.files, expanded: content.expanded, loading: content.loading, error: content.error, done: content.done, total_files: content.totalFiles, total_matches: content.totalMatches, visited: content.visited, truncated: content.truncated }, { callback: "HerdrFileBrowserContent", inputId: "fileContentSearchInput", hideInput: true })
      : `<div class="file-browser-empty">Content search renderer unavailable.</div>`;

    return `<section class="file-browser-pane active file-browser-content-pane"><div class="file-browser-pane-body file-browser-content-pane-body"><div class="file-browser-content-actions"><span>Content search: ${esc(content.query || "No query")}</span><button class="git-ui-btn" onclick="event.stopPropagation();HerdrFileBrowser.closeContentSearch()">Close search</button></div>${body}</div></section>`;

  }

  function menuIcon(action, label, extra = "") {
    const icons = {
      open: "/assets/icons/file.svg",
      enter: "/assets/icons/folder-up.svg",
      split: "/assets/icons/columns.svg",
      focus: "/assets/icons/chevron-right.svg",
      find: "/assets/icons/search.svg",
      edit: "/assets/icons/pencil.svg",
      preview: "/assets/icons/eye.svg",
      source: "/assets/icons/eye-off.svg",
      cancelEdit: "/assets/icons/lock.svg",
      save: "/assets/icons/save.svg",
      history: "/assets/icons/clock.svg",
      reload: "/assets/icons/refresh.svg",
      copyPath: "/assets/icons/copy.svg",
      copyPathTab: "/assets/icons/copy.svg",
      copyPermalink: "/assets/icons/link.svg",
      rename: "/assets/icons/pencil.svg",
      delete: "/assets/icons/trash.svg",
      close: "/assets/icons/x.svg",
    };
    const src = icons[action];
    const icon = src ? ` style="mask-image:url('${src}');-webkit-mask-image:url('${src}')"` : "";
    const attrs = extra ? ` ${extra.trim()}` : "";
    return `<button type="button" role="menuitem"${attrs} data-file-menu-action="${action}"><span class="file-browser-menu-icon"${icon} aria-hidden="true"></span><span class="file-browser-menu-text">${esc(label)}</span></button>`;
  }

  function menuPos(menu) {
    const x = Math.max(0, Number(menu.x) || 0);
    const y = Math.max(0, Number(menu.y) || 0);
    const vw = (typeof window !== "undefined" && window.innerWidth) || 0;
    const vh = (typeof window !== "undefined" && window.innerHeight) || 0;
    const width = 240;
    const height = 320;
    let left = x;
    let top = y;
    if (vw && x + width > vw - 8) left = Math.max(8, vw - width - 8);
    if (vh && y + height > vh - 8) top = Math.max(8, vh - height - 8);
    return `left:${left}px;top:${top}px`;
  }

  function renderContextMenu() {
    const menu = state.contextMenu;
    if (!menu) return "";
    if (menu.type === "tab") return renderTabMenu(menu);
    const name = Tree.basename(menu.path) || menu.path;
    const title = `<span class="file-browser-menu-label" title="${arg(menu.path)}">${esc(name)}</span><span class="file-browser-menu-sep"></span>`;
    const primary = menu.kind === "dir"
      ? menuIcon("enter", "Enter folder")
      : `${menuIcon("open", "Open")}${menu.kind === "file" && markdownPath(menu.path) ? menuIcon("preview", "Preview") : ""}${menuIcon("split", "Open in split")}`;
    const history = menu.kind === "file" ? menuIcon("history", "Show history") : "";
    const permalink = menu.kind === "file" ? menuIcon("copyPermalink", "Copy permalink") : "";
    return `<div class="file-browser-menu" role="menu" style="${menuPos(menu)}" onclick="event.stopPropagation()">${title}<div class="file-browser-menu-section">${primary}${history}${permalink}</div><span class="file-browser-menu-sep"></span><div class="file-browser-menu-section">${menuIcon("rename", "Rename")}${menuIcon("copyPath", "Copy path")}</div><span class="file-browser-menu-sep"></span><div class="file-browser-menu-section">${menuIcon("delete", "Delete", ' class="danger"')}</div></div>`;
  }

  function renderTabMenu(menu) {
    const file = state.files.find((f) => f.path === menu.path);
    if (!file) return "";
    const canEdit = !file.binary && !file.truncated;
    const isActive = file.path === state.selected;
    const editing = !!file.editing;
    const hasMultiple = state.files.length > 1;
    const label = `<span class="file-browser-menu-label" title="${arg(file.path)}">${esc(Tree.basename(file.path))}</span><span class="file-browser-menu-sep"></span>`;
    const focus = !isActive ? menuIcon("focus", "Focus") : "";
    const split = hasMultiple ? menuIcon("split", "Open in split") : "";
    const find = canEdit ? menuIcon("find", "Find in file", ' title="Cmd/Ctrl-F"') : "";
    const lock = canEdit ? menuIcon(editing ? "cancelEdit" : "edit", editing ? "Lock (read-only)" : "Unlock to edit") : "";
    const markdownView = canEdit && markdownPath(file.path)
      ? (file.previewSource || file.editing
        ? menuIcon("preview", "Preview markdown")
        : menuIcon("source", "Show markdown source"))
      : "";
    const save = canEdit && editing && file.dirty ? menuIcon("save", "Save", ' title="Cmd/Ctrl-S"') : "";
    const history = menuIcon("history", "Show history");
    const reload = menuIcon("reload", "Reload");
    const copyPath = menuIcon("copyPathTab", "Copy path");
    const close = menuIcon("close", "Close file", ' class="danger"');
    const fileSection = `${focus}${split}${find}${markdownView}${lock}${save}`;
    const viewSection = `${history}${reload}${copyPath}`;
    return `<div class="file-browser-menu" role="menu" style="${menuPos(menu)}" onclick="event.stopPropagation()">${label}<div class="file-browser-menu-section">${fileSection}</div>${fileSection ? `<span class="file-browser-menu-sep"></span>` : ""}<div class="file-browser-menu-section">${viewSection}</div><span class="file-browser-menu-sep"></span><div class="file-browser-menu-section">${close}</div></div>`;
  }

  function syncDirtyDots() {
    if (typeof document.querySelectorAll !== "function") return;
    const tabs = document.querySelectorAll(".file-browser-open-tab");
    tabs.forEach((tab) => {
      const label = tab.querySelector(".file-browser-open-tab-label");
      if (!label) return;
      const path = tab.getAttribute("title") || "";
      const file = state.files.find((f) => fileTabTooltipPath(f.path) === path);
      if (!file) return;
      const showDot = !!file.dirty && !!file.editing;
      const hasDot = !!label.querySelector(".file-browser-tab-dirty");
      if (showDot === hasDot) return;
      if (showDot) {
        const dot = document.createElement("span");
        dot.className = "file-browser-tab-dirty";
        dot.title = "Modified";
        dot.textContent = "●";
        label.appendChild(dot);
      } else {
        const dot = label.querySelector(".file-browser-tab-dirty");
        if (dot) dot.remove();
      }
    });
  }

  function editorCacheKey(path) {
    return `${activeKey}|${path}`;
  }

  function editorSignature(file, configured) {
    return JSON.stringify({
      content: file.editing ? file.draft : file.content || "",
      editing: !!file.editing,
      previewSource: !!file.previewSource,
      searchHighlight: file.searchHighlight || null,
      lineNumbers: lineNumbersEnabled(),
      options: configured,
      linesHtml: file.linesHtml || null,
    });
  }

  function forgetEditor(path) {
    const key = editorCacheKey(path);
    const entry = editorCache.get(key);
    if (!entry) return;
    editorCache.delete(key);
    if (entry.api && entry.api.destroy) {
      try { entry.api.destroy(); } catch (_) {}
    }
  }

  // Drop cache entries for paths the current workspace no longer has open so
  // closed/renamed/deleted files release their editor instances' memory.
  // Other workspaces' entries are preserved for when the user switches back.
  function pruneEditorCache(openPaths) {
    const prefix = `${activeKey}|`;
    const keep = new Set(openPaths.map((path) => `${prefix}${path}`));
    for (const key of Array.from(editorCache.keys())) {
      if (key.startsWith(prefix) && !keep.has(key)) forgetEditor(key.slice(prefix.length));
    }
  }

  function mountEditors() {
    const configured = editorOptions();
    const files = state.split ? state.files : [currentFile()].filter(Boolean);
    pruneEditorCache(files.map((file) => file.path));
    for (const file of files) {
      const parent = document.getElementById(`fileBrowserEditor-${hashId(file.path)}`);
      if (!parent || file.binary) continue;
      // Truncated files never get an editable editor. A partial preview
      // (A4) renders read-only; a plain truncated file shows the
      // placeholder with the "Load first 256 KB" affordance.
      if (file.truncated && !file.partialPreview) continue;
      const signature = editorSignature(file, configured);
      const cacheKey = editorCacheKey(file.path);
      const cached = editorCache.get(cacheKey);
      if (cached && cached.signature === signature && cached.mount) {
        // Same content, editability, and options: reattach the existing
        // editor DOM (and its listeners) instead of recreating the instance.
        // Note: no destroy here; the cache entry is reused, not dropped.
        try { parent.appendChild(cached.mount); } catch (_) { editorCache.delete(cacheKey); continue; }
        parent._herdrEditorApi = cached.api;
        continue;
      }
      forgetEditor(file.path);
      const partialPreview = !!(file.truncated && file.partialPreview);
      window.HerdrEditor.create({
        parent,
        path: file.path,
        content: file.editing && !partialPreview ? file.draft : file.content || "",
        readonly: !file.editing || partialPreview,
        editorEnabled: configured.editorEnabled,
        hideHeader: true,
        lineNumbers: lineNumbersEnabled(),
        wordWrap: configured.wordWrap,
        tabSize: configured.tabSize,
        bracketMatching: configured.bracketMatching,
        folding: configured.folding,
        activeLine: configured.activeLine,
        whitespace: configured.whitespace,
        markdownPreview: !file.editing && !file.previewSource && !partialPreview,
        searchHighlight: file.searchHighlight || null,
        linesHtml: file.editing && !partialPreview ? null : file.linesHtml || null,
        size: file.size,
        onChange(value) {
          if (partialPreview) return; // read-only partial view; no draft tracking
          file.draft = value;
          file.dirty = value !== (file.content || "");
          syncDirtyDots();
          lspDidChange(file.path, value);
        },
      });
      // Cache the editor's own wrapper node (not the pane container) so the
      // next render can reattach it. When create() produced no wrapper (plain
      // fallback markup), there is no stable node to reattach; skip caching
      // instead of accidentally reattaching the container itself.
      const wrapper = parent.querySelector(".herdr-editor");
      if (wrapper) editorCache.set(editorCacheKey(file.path), { api: parent._herdrEditorApi, mount: wrapper, signature });
      lspDidOpen(file);
    }
  }

  // ── Language server integration ──────────────────────────────────────

  function lspEnabled() {
    if (!window.HerdrLsp) return false;
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      return parsed.lspEnabled === true;
    } catch (_) {
      return false;
    }
  }

  function lspDidChange(path, value) {
    if (!lspEnabled() || !window.HerdrLsp || !state.cwd) return;
    const ws = window.HerdrLsp.workspaceFor(state.cwd);
    window.HerdrLsp.didChange(ws, path, value);
  }

  function lspDidOpen(file) {
    if (!lspEnabled() || !window.HerdrLsp || !state.cwd || file.binary || file.truncated) return;
    const ws = window.HerdrLsp.workspaceFor(state.cwd);
    window.HerdrLsp.didOpen(ws, file.path, file.editing ? file.draft : file.content || "").catch(() => {});
    lspRenderDiagnostics(file.path);
  }

  function lspDidClose(path) {
    if (!lspEnabled() || !window.HerdrLsp || !state.cwd) return;
    const ws = window.HerdrLsp.workspaceFor(state.cwd);
    window.HerdrLsp.didClose(ws, path).catch(() => {});
  }

  function lspDiagnosticsFor(path) {
    if (!lspEnabled() || !window.HerdrLsp || !state.cwd) return [];
    const ws = window.HerdrLsp.workspaceFor(state.cwd);
    return window.HerdrLsp.diagnosticsFor(ws, path) || [];
  }

  function lspDiagnosticBadge(path) {
    const diagnostics = lspDiagnosticsFor(path);
    if (!diagnostics.length) return "";
    const errors = diagnostics.filter((d) => d.severity === 1).length;
    const warnings = diagnostics.filter((d) => d.severity === 2).length;
    const info = diagnostics.length - errors - warnings;
    const parts = [];
    if (errors) parts.push(`<span class="file-browser-lsp-count error">${errors} error${errors === 1 ? "" : "s"}</span>`);
    if (warnings) parts.push(`<span class="file-browser-lsp-count warning">${warnings} warning${warnings === 1 ? "" : "s"}</span>`);
    if (info > 0) parts.push(`<span class="file-browser-lsp-count info">${info} hint${info === 1 ? "" : "s"}</span>`);
    return `<span class="file-browser-lsp-badge" title="${diagnostics.map((d) => esc(d.message || "").replace(/"/g, "&quot;")).slice(0, 5).join("\n")}">${parts.join("")}</span>`;
  }

  function lspRenderDiagnostics(path) {
    if (typeof document.querySelectorAll !== "function") return;
    const diagnostics = lspDiagnosticsFor(path);
    const mount = document.getElementById(`fileBrowserEditor-${hashId(path)}`);
    if (!mount) return;
    const api = mount._herdrEditorApi;
    if (!api) return;
    const view = api._view;
    const effects = [];
    if (view && view.state) {
      const doc = view.state.doc;
      for (const diagnostic of diagnostics) {
        const range = diagnostic && diagnostic.range;
        if (!range || !range.start) continue;
        const line = Math.max(0, Number(range.start.line) || 0);
        if (line >= doc.lines) continue;
        const from = doc.line(line + 1).from;
        const to = doc.line(line + 1).to;
        const severity = Number(diagnostic.severity) === 1 ? "error" : Number(diagnostic.severity) === 2 ? "warning" : "info";
        effects.push({ from, to, severity, message: diagnostic.message || "" });
      }
    } else if (typeof api.getValue === "function") {
      // Fallback without a live view: approximate offsets by splitting lines.
      const text = String(api.getValue() || "");
      const lines = text.split("\n");
      let offset = 0;
      const lineOffsets = lines.map((text2) => {
        const start = offset;
        offset += text2.length + 1;
        return start;
      });
      for (const diagnostic of diagnostics) {
        const range = diagnostic && diagnostic.range;
        if (!range || !range.start) continue;
        const line = Math.max(0, Number(range.start.line) || 0);
        if (line >= lineOffsets.length) continue;
        const from = lineOffsets[line];
        const to = from + (lines[line] ? lines[line].length : 0);
        const severity = Number(diagnostic.severity) === 1 ? "error" : Number(diagnostic.severity) === 2 ? "warning" : "info";
        effects.push({ from, to, severity, message: diagnostic.message || "" });
      }
    } else {
      return;
    }
    renderDiagnosticsInline(mount, effects);
  }

  function renderDiagnosticsInline(mount, diagnostics) {
    let list = mount.querySelector(".herdr-lsp-diagnostics");
    if (!diagnostics.length) {
      if (list) list.remove();
      return;
    }
    if (!list) {
      list = document.createElement("div");
      list.className = "herdr-lsp-diagnostics";
      mount.appendChild(list);
    }
    list.innerHTML = diagnostics
      .slice(0, 50)
      .map((d) => `<div class="herdr-lsp-diagnostic ${esc(d.severity)}" data-from="${d.from}" data-to="${d.to}">${esc(d.message)}</div>`)
      .join("");
    list.querySelectorAll(".herdr-lsp-diagnostic").forEach((item) => {
      item.addEventListener("click", () => {
        const mount2 = item.closest(".herdr-editor-mount") || mount;
        const editorApi = (mount2.closest("[id^='fileBrowserEditor-']") || mount)._herdrEditorApi;
        if (!editorApi || !editorApi.selectRange) return;
        editorApi.selectRange(Number(item.dataset.from), Number(item.dataset.to));
      });
    });
  }

  function refreshLspDiagnostics() {
    if (!lspEnabled()) return;
    for (const file of state.files) {
      if (!file.binary && !file.truncated) lspRenderDiagnostics(file.path);
    }
    // Diagnostics changed the toolbar badge counts: re-render it in place.
    const current = currentFile();
    const toolbar = document.querySelector(".file-browser-toolbar");
    if (toolbar && current) toolbar.innerHTML = renderToolbar(current);
  }

  if (typeof window !== "undefined") {
    window.HerdrLspHooks = window.HerdrLspHooks || [];
    window.HerdrLspHooks.push(function lspFileBrowserHook() {
      refreshLspDiagnostics();
    });
  }

  function toggleFind(path) {
    const parent = document.getElementById(`fileBrowserEditor-${hashId(path)}`);
    if (!parent || !parent._herdrEditorApi || !parent._herdrEditorApi.toggleFind) return;
    state.selected = path;
    parent._herdrEditorApi.toggleFind(true);
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
    if (file.truncated) {
      // A4: oversize text files offer a backend partial read instead of a
      // dead end. Editing stays blocked (truncated implies no edit button).
      if (file.partialPreview) return "";
      return `<div class="file-browser-empty">File too large to preview (${Tree.formatBytes(file.size)}).<button class="git-ui-btn file-browser-load-partial" onclick="HerdrFileBrowser.loadPartial('${arg(file.path)}')">Load first 256 KB</button></div>`;
    }
    return "";
  }

  // A4: partial read of an oversized text file. The backend clamps the
  // budget (16 KB..1 MB) and returns truncated=true with the first N bytes;
  // the editor mounts read-only and the save path is unreachable (empty
  // hash can never satisfy the expected_hash check).
  async function loadPartial(path) {
    try {
      state.error = "";
      const file = await api(`/api/file-browser/file?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(path)}&max_bytes=262144`);
      const index = state.files.findIndex((entry) => entry.path === path);
      const partial = Object.assign(file, {
        draft: file.content || "",
        editing: true,
        dirty: false,
        saving: false,
        error: "",
        searchHighlight: null,
        previewSource: true,
        partialPreview: true,
      });
      partial.linesHtml = file.lines_gutter_html != null && file.lines_code_html != null ? { gutter: file.lines_gutter_html, code: file.lines_code_html } : null;
      if (index >= 0) state.files[index] = Object.assign({}, state.files[index], partial);
      else state.files.push(partial);
      state.selected = path;
      render();
    } catch (error) {
      setError(state, error);
      render();
    }
  }

  async function reloadFile(path) {
    const index = state.files.findIndex((file) => file.path === path);
    if (index < 0) return loadFile(path);
    const previous = state.files[index];
    const keepEditing = !!previous.editing;
    const keepPreviewSource = !!previous.previewSource;
    const next = await api(`/api/file-browser/file?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(path)}&render=lines`);
    const linesHtml = next.lines_gutter_html != null && next.lines_code_html != null ? { gutter: next.lines_gutter_html, code: next.lines_code_html } : null;
    state.files[index] = Object.assign(next, { draft: next.content || "", editing: keepEditing, dirty: false, saving: false, error: "", searchHighlight: previous.searchHighlight || null, previewSource: keepPreviewSource, linesHtml });
    state.selected = path;
    render();
  }

  async function saveFile(path) {
    const file = state.files.find((file) => file.path === path);
    if (!file || file.saving || !file.editing) return;
    file.saving = true;
    file.error = "";
    render();
    if (typeof showBlocking === "function") showBlocking("Saving file...");
    try {
      const result = await api("/api/file-browser/file", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: state.cwd, path: file.path, content: file.draft, expected_hash: file.hash || "" }),
      });
      file.content = file.draft;
      file.hash = result.hash || file.hash;
      file.dirty = false;
    } catch (error) {
      file.error = error.message || String(error);
    }
    file.saving = false;
    render();
    if (typeof hideBlocking === "function") hideBlocking();
  }

  function fileName(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    return parts[parts.length - 1] || path || "";
  }

  function mutateTreeForRename(from, to, nextName) {
    // Remap editor cache entries to the renamed path so the cached instance
    // is reused (not recreated) for the renamed file.
    for (const cacheKey of Array.from(editorCache.keys())) {
      if (!cacheKey.startsWith(`${activeKey}|`)) continue;
      const cachedPath = cacheKey.slice(activeKey.length + 1);
      const nextPath = Tree.replacePathPrefix(cachedPath, from, to);
      if (nextPath === cachedPath) continue;
      const entry = editorCache.get(cacheKey);
      editorCache.delete(cacheKey);
      editorCache.set(editorCacheKey(nextPath), entry);
    }
    state.entries = Tree.renamePathInEntries(state.entries, from, to, nextName);
    state.children = Tree.remapPathMap(state.children, from, to, (entries) => Tree.renamePathInEntries(entries, from, to, nextName));
    state.expanded = Tree.remapPathMap(state.expanded, from, to);
    state.loading = Tree.remapPathMap(state.loading, from, to);
    state.files = state.files.map((file) => Object.assign(file, { path: Tree.replacePathPrefix(file.path, from, to) }));
    if (state.selected) state.selected = Tree.replacePathPrefix(state.selected, from, to);
  }

  function mutateTreeForDelete(path) {
    for (const cacheKey of Array.from(editorCache.keys())) {
      const cachedPath = cacheKey.slice(activeKey.length + 1);
      if (cachedPath === path || cachedPath.startsWith(`${path}/`)) forgetEditor(cachedPath);
    }
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
    if (typeof showBlocking === "function") showBlocking("Renaming...");
    try {
      await api("/api/file-browser/rename", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: state.cwd, path, new_name: nextName }),
      });
      const parent = Tree.parentPath(path);
      const to = parent ? `${parent}/${nextName}` : nextName;
      mutateTreeForRename(path, to, nextName);
      await refreshParentAfterMutation(to);
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
  }

  async function deletePath(path) {
    if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
    if (typeof showBlocking === "function") showBlocking("Deleting...");
    try {
      await api("/api/file-browser/delete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: state.cwd, path }),
      });
      mutateTreeForDelete(path);
      await refreshParentAfterMutation(path);
    } finally {
      if (typeof hideBlocking === "function") hideBlocking();
    }
  }

  async function copyPermalink(path) {
    const data = await api(`/api/git-ui/permalink?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(path)}`);
    const url = data && data.url;
    if (!url) throw new Error("permalink URL was empty");
    await navigator.clipboard.writeText(url);
  }

  function showHistoryPath(path) {
    if (!path || !window.HerdrGitUi || !window.HerdrGitUi.openFileHistory) return;
    hide();
    window.HerdrGitUi.openFileHistory(encodeURIComponent(state.cwd), encodeURIComponent(path));
  }

  async function handleMenuAction(action) {
    const menu = state.contextMenu;
    if (!menu) return;
    state.contextMenu = null;
    try {
      if (action === "open") await loadFile(menu.path, "append");
      if (action === "split") { await loadFile(menu.path, "split"); if (state.split === false) state.split = true; }
      if (action === "enter") await loadTree(menu.path);
      if (action === "history") { showHistoryPath(menu.path); return; }
      if (action === "rename") await renamePath(menu.path);
      if (action === "delete") await deletePath(menu.path);
      if (action === "copyPermalink") await copyPermalink(menu.path);
      if (action === "copyPath") await navigator.clipboard.writeText(`${state.cwd}/${menu.path}`);
      if (action === "copyPathTab") await navigator.clipboard.writeText(absoluteFilePath(menu.path));
      if (action === "focus") { state.selected = menu.path; render(); return; }
      if (action === "find") { toggleFind(menu.path); return; }
      if (action === "preview" || action === "source") {
        const file = state.files.find((f) => f.path === menu.path);
        if (file) {
          if (file.editing) {
            if (file.dirty && !confirm(`Discard unsaved changes to ${menu.path}?`)) return;
            file.editing = false;
            file.draft = file.content || "";
            file.dirty = false;
          }
          file.previewSource = action === "source";
          state.selected = menu.path;
          render();
          return;
        }
        // Not open yet: loadFile opens markdown read-only in preview mode.
        await loadFile(menu.path, "append");
        return;
      }
      if (action === "edit") { const file = state.files.find((f) => f.path === menu.path); if (file) { file.editing = true; file.draft = file.content || ""; file.dirty = false; } state.selected = menu.path; render(); return; }
      if (action === "save") { state.selected = menu.path; render(); saveFile(menu.path); return; }
      if (action === "cancelEdit") { const file = state.files.find((f) => f.path === menu.path); if (file) { if (file.dirty && !confirm(`Discard unsaved changes to ${menu.path}?`)) return; file.editing = false; file.draft = file.content || ""; file.dirty = false; } state.selected = menu.path; render(); return; }
      if (action === "reload") { state.selected = menu.path; render(); await reloadFile(menu.path); return; }
      if (action === "close") { const file = state.files.find((f) => f.path === menu.path); if (file && file.dirty && !confirm(`Close ${menu.path} with unsaved changes?`)) return; state.files = state.files.filter((f) => f.path !== menu.path); if (state.selected === menu.path) state.selected = (state.files[state.files.length - 1] || {}).path || ""; if (state.files.length < 2) state.split = false; render(); return; }
    } catch (error) {
      state.error = error.message || String(error);
    } finally {
      if (state.open) render();
    }
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

  // ── A6: external-change awareness ────────────────────────────────────
  // When the window regains focus (tab refocus, Cmd+Tab back), re-hash the
  // open files via the cheap hash_only endpoint. If a file changed on disk
  // while we hold no local edits, offer a reload prompt. Dirty files are
  // skipped: their draft is newer than disk and the save path already
  // surfaces hash mismatches.
  let a6CheckInFlight = false;
  async function checkOpenFilesForExternalChanges() {
    if (a6CheckInFlight) return;
    const candidates = state.files.filter((file) => file && !file.dirty && !file.truncated && file.hash);
    if (!candidates.length) return;
    a6CheckInFlight = true;
    try {
      for (const file of candidates) {
        let remote = null;
        try {
          remote = await api(`/api/file-browser/file?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(file.path)}&hash_only=true`);
        } catch (_) { continue; } // deleted or unreadable: leave the tab alone
        const fresh = state.files.find((open) => open.path === file.path);
        if (!fresh || fresh.dirty) continue;
        if (remote && remote.hash && remote.hash !== fresh.hash) {
          if (confirm(`${file.path}\nchanged on disk. Reload?`)) await reloadFile(file.path);
        }
      }
    } finally {
      a6CheckInFlight = false;
    }
  }
  if (typeof document !== "undefined" && document.addEventListener && !document.__herdrA6FocusWatcher) {
    document.__herdrA6FocusWatcher = true;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") checkOpenFilesForExternalChanges();
    });
    window.addEventListener("focus", checkOpenFilesForExternalChanges);
  }

  window.HerdrFileBrowser = {
    open,
    openAt,
    close: hide,
    hide,
    forgetWorkspace,
    refresh() { loadTree(state.path); },
    refreshLsp() { refreshLspDiagnostics(); },
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
    select(encodedPath, mode) { loadFile(decodeURIComponent(encodedPath), mode || "append"); },
    checkOpenFilesForExternalChanges,
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
      lspDidClose(path);
      forgetEditor(path);
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
    tabMenu(event, encodedPath) {
      event.preventDefault();
      event.stopPropagation();
      state.contextMenu = { type: "tab", x: event.clientX, y: event.clientY, path: decodeURIComponent(encodedPath) };
      render();
      return false;
    },
    menuAction(action) { return handleMenuAction(action); },
    edit(encodedPath) {
      const file = state.files.find((file) => file.path === decodeURIComponent(encodedPath));
      if (!file || file.editing) return;
      file.editing = true;
      if (file.draft == null) file.draft = file.content || "";
      render();
    },
    cancelEdit(encodedPath) {
      const path = decodeURIComponent(encodedPath || "");
      const file = state.files.find((file) => file.path === path);
      if (!file || !file.editing) return;
      if (file.dirty && !confirm(`Discard unsaved changes to ${path}?`)) return;
      file.editing = false;
      file.draft = file.content || "";
      file.dirty = false;
      render();
    },
    save(encodedPath) { saveFile(decodeURIComponent(encodedPath)); },
    reload(encodedPath) { reloadFile(decodeURIComponent(encodedPath)).catch((error) => { state.error = error.message || String(error); render(); }); },
    loadPartial(encodedPath) { loadPartial(decodeURIComponent(encodedPath)); },
    toggleFind(encodedPath) { toggleFind(decodeURIComponent(encodedPath || "")); },
    toggleLock(encodedPath) {
      const path = decodeURIComponent(encodedPath || "");
      const file = state.files.find((file) => file.path === path);
      if (!file || file.binary || file.truncated) return;
      if (file.editing) {
        if (file.dirty && !confirm(`Discard unsaved changes to ${path}?`)) return;
        file.editing = false;
        file.draft = file.content || "";
        file.dirty = false;
      } else {
        file.editing = true;
        if (file.draft == null) file.draft = file.content || "";
      }
      state.selected = path;
      render();
    },
    togglePreview(encodedPath) {
      const file = state.files.find((file) => file.path === decodeURIComponent(encodedPath));
      if (!file) return;
      file.previewSource = false;
      render();
    },
    toggleSource(encodedPath) {
      const file = state.files.find((file) => file.path === decodeURIComponent(encodedPath));
      if (!file) return;
      file.previewSource = true;
      render();
    },
    toggleMarkdownView(encodedPath) {
      const file = state.files.find((file) => file.path === decodeURIComponent(encodedPath));
      if (!file) return;
      file.previewSource = !file.previewSource;
      render();
    },
    showHistory(encodedPath) {
      const path = decodeURIComponent(encodedPath || "");
      showHistoryPath(path);
    },
    isVisible() { return state.open; },
    activeWorkspaceId() { return state.open ? (activeKey || "") : ""; },
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
      content.error = "";
      content.offset = 0;
      content.done = true;
      content.totalFiles = 0;
      content.totalMatches = 0;
    content.visited = 0;
    content.truncated = false;
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
    openFile(encodedPath) { loadFile(decodeURIComponent(encodedPath), "append"); },
    openMatch(encodedPath, encodedMatchId) {
      const path = decodeURIComponent(encodedPath);
      const file = contentFile(path);
      const match = window.HerdrContentSearch.findMatch(file, decodeURIComponent(encodedMatchId));
      loadFile(path, "append", matchHighlight(match, state.contentSearch.query));
    },
    expandAll() {
      for (const file of state.contentSearch.files || []) state.contentSearch.expanded[file.path] = true;
      renderPreservingScroll();
    },
    collapseAll() {
      state.contentSearch.expanded = {};
      renderPreservingScroll();
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
