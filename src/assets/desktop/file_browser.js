(function () {
  const Tree = window.HerdrFileTree;
  const stateCache = {};
  let activeKey = "";
  let state = createState();

  function createContentSearchState() {
    return { active: false, query: "", timer: null, files: [], expanded: {}, snippets: {}, loading: false, error: "", offset: 0, done: true, totalFiles: 0, totalMatches: 0, contextLines: 2, maxMatchesPerFile: 5, autoCollapseFiles: 8 };
  }

  function createState(initial) {
    return Object.assign({ open: false, cwd: "", path: "", entries: [], children: {}, expanded: {}, loading: {}, selected: "", files: [], split: false, error: "", contextMenu: null, filter: "", filterTimer: null, filterVisible: false, filterLoading: false, filterOffset: 0, filterDone: true, filterScrollTop: 0, filterKind: "file", gitStatus: null, refreshing: false, contentSearch: createContentSearchState() }, initial || {});
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

  function contentSearchOptions() {
    try {
      const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
      const contextRaw = Number(parsed.fileContentSearchContextLines);
      const autoCollapseRaw = Number(parsed.fileContentSearchAutoCollapseFiles);
      return {
        contextLines: Math.max(0, Math.min(20, Number.isFinite(contextRaw) ? contextRaw : 2)),
        autoCollapseFiles: Math.max(0, Math.min(200, Number.isFinite(autoCollapseRaw) ? autoCollapseRaw : 8)),
        maxMatchesPerFile: Math.max(1, Math.min(50, Number(parsed.fileContentSearchMatchesPerFile) || 5)),
      };
    } catch (_) { return { contextLines: 2, autoCollapseFiles: 8, maxMatchesPerFile: 5 }; }
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
    if (!res.ok || body.error) throw Error(body.error || res.statusText);
    return body;
  }

  async function open(workspace) {
    const cwd = workspaceCwd(workspace);
    const key = workspaceKey(workspace);
    if (state.open && activeKey === key) {
      hide();
      return;
    }
    if (window.HerdrGitUi) window.HerdrGitUi.hide();
    activateState(key, cwd);
    state.open = true;
    render();
    if (state.filter.trim()) await fetchFilteredEntries(false);
    else await loadTree(state.path || "");
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
    if (!target.cwd || !target.filter.trim()) return;
    const offset = append ? target.filterOffset : 0;
    target.filterLoading = true;
    renderIfActive(target, true);
    try {
      const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(target.path || "")}&q=${encodeURIComponent(target.filter.trim())}&${Tree.searchKindQuery(target.filterKind)}&offset=${offset}&limit=100${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
      const entries = data.entries || [];
      target.entries = append ? target.entries.concat(entries) : entries;
      target.gitStatus = data.git_status || null;
      target.filterOffset = offset + entries.length;
      target.filterDone = !data.truncated || entries.length === 0;
      target.children = {};
      target.expanded = {};
      target.loading = {};
    } catch (error) {
      target.error = error.message || String(error);
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
      target.error = error.message || String(error);
    }
    target.refreshing = false;
    renderIfActive(target, preserveFocus);
  }

  function renderPreservingScroll() {
    const side = document.querySelector(".file-browser-side");
    const top = side ? side.scrollTop : state.filterScrollTop || 0;
    const active = document.activeElement;
    const refocusFilter = active && active.id === "fileBrowserFilter";
    const refocusSide = !refocusFilter && side && active === side;
    const selectionStart = refocusFilter ? active.selectionStart : null;
    const selectionEnd = refocusFilter ? active.selectionEnd : null;
    render();
    const next = document.querySelector(".file-browser-side");
    if (next) next.scrollTop = top;
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

  async function loadFile(path, mode) {
    const target = state;
    try {
      target.error = "";
      const replacePath = currentFilePathFor(target);
      target.selected = path;
      if (target.files.some((file) => file.path === path)) {
        renderIfActive(target);
        return;
      }
      renderIfActive(target);
      const file = await api(`/api/file-browser/file?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(path)}`);
      const nextFile = Object.assign(file, { draft: file.content || "", editing: false, dirty: false, saving: false, error: "" });
      if (mode === "split") {
        target.files.push(nextFile);
        target.split = true;
      } else {
        const index = Math.max(0, target.files.findIndex((file) => file.path === replacePath));
        if (target.files.length) target.files[index] = nextFile;
        else target.files.push(nextFile);
      }
    } catch (error) {
      target.error = error.message || String(error);
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
    target.contentSearch.contextLines = opts.contextLines;
    target.contentSearch.maxMatchesPerFile = opts.maxMatchesPerFile;
    target.contentSearch.autoCollapseFiles = opts.autoCollapseFiles;
  }

  async function runContentSearch(append = false) {
    const target = state;
    const content = target.contentSearch;
    if (!target.cwd || !content.query.trim()) return;
    syncContentSearchOptions(target);
    const offset = append ? content.offset : 0;
    content.loading = true;
    content.error = "";
    renderIfActive(target, true);
    try {
      const data = await api(`/api/file-browser/content-search?cwd=${encodeURIComponent(target.cwd)}&path=${encodeURIComponent(target.path || "")}&q=${encodeURIComponent(content.query.trim())}&offset=${offset}&limit=50&context_lines=${content.contextLines}&max_matches_per_file=${content.maxMatchesPerFile}`);
      const files = data.files || [];
      content.files = append ? content.files.concat(files) : files;
      content.totalFiles = data.total_files || files.length;
      content.totalMatches = data.total_matches || 0;
      content.offset = offset + files.length;
      content.done = !data.truncated || files.length === 0;
      if (!append) {
        content.expanded = {};
        const collapse = content.autoCollapseFiles > 0 && content.files.length > content.autoCollapseFiles;
        for (const file of content.files) content.expanded[file.path] = !collapse;
      }
    } catch (error) {
      content.error = error.message || String(error);
      content.done = true;
    }
    content.loading = false;
    renderIfActive(target, true);
  }

  function contentFile(path) {
    return state.contentSearch.files.find((file) => file.path === path) || null;
  }

  async function loadContentSearchFile(path, extraContext) {
    const content = state.contentSearch;
    if (!state.cwd || !content.query.trim()) return;
    syncContentSearchOptions(state);
    const contextLines = Math.max(content.contextLines, Number(extraContext) || content.contextLines);
    const data = await api(`/api/file-browser/content-search/file?cwd=${encodeURIComponent(state.cwd)}&file=${encodeURIComponent(path)}&q=${encodeURIComponent(content.query.trim())}&context_lines=${contextLines}&max_matches_per_file=500`);
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
    const resultCount = state.filter.trim() ? state.entries.length : entries.length;
    const noun = Tree.searchKindNoun(state.filterKind);
    const label = Tree.searchKindLabel(state.filterKind);
    const count = state.filter.trim() ? `<div class="file-browser-result-count">${resultCount} ${noun} result${resultCount === 1 ? "" : "s"}</div>` : `<div class="file-browser-result-count">Focus tree and type to filter</div>`;
    const filterVisible = state.filterVisible || state.filter.trim();
    const filter = filterVisible ? `<div class="file-browser-list-head"><div class="file-browser-filter-row"><span class="file-browser-filter"><span class="file-browser-search-icon ${state.filterLoading ? "searching" : ""}" aria-hidden="true"></span><span id="fileBrowserFilter" class="file-browser-filter-text">${esc(state.filter || `Type to search ${noun}s`)}</span></span><button class="file-browser-kind-toggle" title="Search ${noun}s. Alt+F files, Alt+D folders" onclick="HerdrFileBrowser.toggleFilterKind()">${label}</button><button class="file-browser-kind-toggle" title="Clear search" onclick="HerdrFileBrowser.clearFilter()">Clear</button></div>${count}</div>` : `<div class="file-browser-list-head compact"><div class="file-browser-result-count">Focus tree and type to filter files. Alt+D folders.</div></div>`;
    const sideBody = state.contentSearch.active ? window.HerdrContentSearch.render({ query: state.contentSearch.query, files: state.contentSearch.files, expanded: state.contentSearch.expanded, snippets: state.contentSearch.snippets, loading: state.contentSearch.loading, error: state.contentSearch.error, done: state.contentSearch.done, total_files: state.contentSearch.totalFiles, total_matches: state.contentSearch.totalMatches }, { callback: "HerdrFileBrowserContent", inputId: "fileContentSearchInput" }) : `${filter}${Tree.renderEntries(entries, { selectedPath: state.selected, callback: "HerdrFileBrowser", showMeta: true, dirClickMethod: "none", dirDoubleClickMethod: "enter", contextMethod: "menu", shiftSelectMode: true, filterTerm: state.filter })}${state.filterLoading ? `<div class="file-browser-searching">Searching...</div>` : ""}${state.filter.trim() && !state.filterDone ? `<button class="git-ui-btn file-browser-more" onclick="HerdrFileBrowser.loadMore()">Load more</button>` : ""}`;
    panel.innerHTML = `<aside class="file-browser-side ${activeFile ? "previewing" : ""} ${state.contentSearch.active ? "content-searching" : ""}" tabindex="0" onfocus="HerdrFileBrowser.focusTree()" onblur="HerdrFileBrowser.blurTree()" onkeydown="HerdrFileBrowser.typeToFilter(event)" onscroll="HerdrFileBrowser.sideScroll(this)"><div class="file-browser-head"><div class="file-browser-title-row"><div class="file-browser-title">Files</div><div class="file-browser-actions"><button class="file-browser-refresh ${state.contentSearch.active ? "active" : ""}" title="Search file contents" aria-label="Search file contents" onclick="HerdrFileBrowser.toggleContentSearch()"><span class="file-browser-search-icon" aria-hidden="true"></span></button>${appRefreshIconButton({ className: "file-browser-refresh", title: "Refresh", label: "Refresh files", spinning: !!state.refreshing, onclick: "HerdrFileBrowser.refresh()" })}</div></div><div class="file-browser-subtitle">${esc(state.path || state.cwd || "No workspace")}</div></div>${state.error ? `<div class="file-browser-error">${esc(state.error)}</div>` : ""}${sideBody}</aside><main class="file-browser-main"><div class="file-browser-toolbar">${renderToolbar(activeFile)}</div><div class="file-browser-preview ${state.split ? "split" : ""}" id="fileBrowserPreview">${renderPreviewShell()}</div></main>${renderContextMenu()}`;
    mountEditors();
    mountContentSearchEditors();
  }

  function syncTerminalVisibility() {
    const shell = document.getElementById("terminalShell");
    if (!shell) return;
    const git = document.getElementById("gitUiPanel");
    const gitOpen = !!(git && git.style.display !== "none");
    shell.style.display = state.open || gitOpen ? "none" : "";
    if (window.syncShellModeButtons) window.syncShellModeButtons();
  }

  function treeEntries() {
    if (state.filter.trim()) {
      const entries = Tree.searchTreeEntriesByKind(state.entries, state.filterKind, state.filter);
      return Tree.applyGitStatus(entries, state.gitStatus);
    }
    const entries = flattenEntries(state.entries, 0);
    if (state.path || Tree.parentDirectory(state.cwd) !== state.cwd) entries.unshift(Tree.upEntry(state.path, 0));
    return Tree.applyGitStatus(entries, state.gitStatus);
  }

  async function goUp() {
    if (state.path) {
      await loadTree(Tree.parentPath(state.path));
      return;
    }
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
    const dirty = file.dirty ? `<span class="file-browser-dirty">modified</span>` : "";
    return `<strong title="${esc(file.path)}">${esc(file.path)}</strong>${dirty}<span class="file-browser-toolbar-actions">${split}${edit}${save}<button class="git-ui-btn" onclick="HerdrFileBrowser.reload('${arg(file.path)}')">Reload</button><button class="git-ui-btn" onclick="HerdrFileBrowser.closeFile('${arg(file.path)}')">Close file</button></span>`;
  }

  function renderPreviewShell() {
    const files = state.split ? state.files : [currentFile()].filter(Boolean);
    if (!files.length) return previewPlaceholder(null);
    return files.map((file) => `<section class="file-browser-pane ${file.path === state.selected ? "active" : ""}"><div class="file-browser-pane-head"><button class="git-ui-btn ${file.path === state.selected ? "active" : ""}" onclick="HerdrFileBrowser.focusFile('${arg(file.path)}')">${esc(Tree.basename(file.path))}</button><span>${esc(file.path)}</span><button class="file-browser-pane-close" title="Close file" onclick="event.stopPropagation();HerdrFileBrowser.closeFile('${arg(file.path)}')">&times;</button></div><div class="file-browser-pane-body" id="fileBrowserEditor-${hashId(file.path)}">${previewPlaceholder(file)}</div>${file.error ? `<div class="file-browser-error">${esc(file.error)}</div>` : ""}</section>`).join("");
  }

  function renderContextMenu() {
    const menu = state.contextMenu;
    if (!menu) return "";
    const primary = menu.kind === "dir"
      ? `<button onclick="HerdrFileBrowser.menuAction('enter')">Enter folder</button>`
      : `<button onclick="HerdrFileBrowser.menuAction('open')">Open</button><button onclick="HerdrFileBrowser.menuAction('split')">Open in split</button>`;
    return `<div class="git-ui-menu file-browser-menu" style="left:${Math.max(0, menu.x)}px;top:${Math.max(0, menu.y)}px" onclick="event.stopPropagation()">${primary}<button onclick="HerdrFileBrowser.menuAction('rename')">Rename</button><button class="danger" onclick="HerdrFileBrowser.menuAction('delete')">Delete</button><button onclick="HerdrFileBrowser.menuAction('copyPath')">Copy path</button></div>`;
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
    if (state.filter.trim()) {
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

  window.HerdrFileBrowser = {
    open,
    close: hide,
    hide,
    forgetWorkspace,
    refresh() { loadTree(state.path); },
    setFilterKind(kind) {
      state.filterKind = Tree.normalizeSearchKind(kind);
      state.filterVisible = true;
      if (state.filter.trim()) fetchFilteredEntries(false);
      else renderPreservingScroll();
    },
    toggleFilterKind() { this.setFilterKind(Tree.toggleSearchKind(state.filterKind)); },
    filter(value) {
      state.filter = String(value || "");
      state.filterVisible = !!state.filter || state.filterVisible;
      clearTimeout(state.filterTimer);
      state.filterTimer = setTimeout(() => {
        if (state.filter.trim()) fetchFilteredEntries(false);
        else loadTree(state.path, true);
      }, 500);
    },
    clearFilter() {
      state.filter = "";
      state.filterVisible = false;
      clearTimeout(state.filterTimer);
      loadTree(state.path, true);
    },
    focusTree() { if (!state.contentSearch.active) { state.filterVisible = true; renderPreservingScroll(); } },
    blurTree() { if (!state.contentSearch.active && !state.filter.trim()) { state.filterVisible = false; renderPreservingScroll(); } },
    toggleContentSearch() {
      state.contentSearch.active = !state.contentSearch.active;
      state.filterVisible = false;
      render();
      if (state.contentSearch.active) setTimeout(() => document.getElementById("fileContentSearchInput")?.focus(), 0);
    },
    loadMore() { fetchFilteredEntries(true); },
    sideScroll(node) {
      state.filterScrollTop = node.scrollTop;
      if (!state.filter.trim() || state.filterLoading || state.filterDone) return;
      if (node.scrollTop + node.clientHeight >= node.scrollHeight - 80) fetchFilteredEntries(true);
    },
    typeToFilter(event) {
      if (!event || event.metaKey || event.ctrlKey || event.defaultPrevented) return;
      if (event.altKey && event.key && event.key.toLowerCase() === "f") { event.preventDefault(); this.setFilterKind("file"); return; }
      if (event.altKey && event.key && event.key.toLowerCase() === "d") { event.preventDefault(); this.setFilterKind("dir"); return; }
      if (event.altKey || event.defaultPrevented) return;
      if (event.target && event.target.closest && event.target.closest("input, textarea, select")) return;
      if (state.contentSearch.active) return;
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
    isVisible() { return state.open; },
    isWorkspaceVisible(workspace) { return state.open && activeKey === workspaceKey(workspace); },
    syncTerminalVisibility,
  };

  window.HerdrFileBrowserContent = {
    setQuery(value) {
      state.contentSearch.query = String(value || "");
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
      render();
    },
    async loadFile(encodedPath) {
      try { await loadContentSearchFile(decodeURIComponent(encodedPath)); }
      catch (error) { state.contentSearch.error = error.message || String(error); }
      render();
    },
    openFile(encodedPath) { loadFile(decodeURIComponent(encodedPath)); },
    expandAll() {
      for (const file of state.contentSearch.files || []) state.contentSearch.expanded[file.path] = true;
      render();
    },
    collapseAll() {
      state.contentSearch.expanded = {};
      render();
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
      const nextContext = Math.min(20, (state.contentSearch.contextLines || 2) + 1);
      state.contentSearch.contextLines = nextContext;
      try { await loadContentSearchFile(path, nextContext); }
      catch (error) { state.contentSearch.error = error.message || String(error); }
      render();
    },
  };
})();
