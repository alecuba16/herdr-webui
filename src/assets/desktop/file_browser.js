(function () {
  const Tree = window.HerdrFileTree;
  const state = { open: false, cwd: "", path: "", entries: [], children: {}, expanded: {}, loading: {}, selected: "", files: [], split: false, error: "", contextMenu: null, search: { query: "", results: [], searching: false, error: "", timer: null, inFlight: "", pending: "" } };

  function esc(value) { return Tree.esc(value); }
  function arg(value) { return Tree.arg(value); }

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
    if (workspace.worktree && workspace.worktree.checkout_path) return workspace.worktree.checkout_path;
    return workspace.cwd || workspace.path || "";
  }

  function fileBrowserOptions() {
    try { return options || {}; } catch (_) { return {}; }
  }

  function allowParentBrowse() {
    return fileBrowserOptions().fileBrowserAllowParent === true;
  }

  function parentDirectory(path) {
    const value = String(path || "").replace(/\/+$/, "");
    if (!value || value === "/") return value || "/";
    const index = value.lastIndexOf("/");
    if (index <= 0) return "/";
    return value.slice(0, index);
  }

  async function api(url, opt) {
    const res = await fetch(url, Object.assign({ credentials: "same-origin" }, opt || {}));
    const body = await res.json();
    if (!res.ok || body.error) throw Error(body.error || res.statusText);
    return body;
  }

  async function open(workspace) {
    const cwd = workspaceCwd(workspace);
    if (state.open && state.cwd === cwd) {
      hide();
      return;
    }
    showForCwd(cwd);
    await loadTree("");
  }

  async function openPath(cwd, path) {
    if (!cwd || !path) return;
    showForCwd(cwd);
    await loadTree(parentPath(path));
    await loadFile(path);
  }

  function showForCwd(cwd) {
    if (window.HerdrGitUi) window.HerdrGitUi.hide();
    state.cwd = cwd;
    state.path = "";
    state.selected = "";
    state.files = [];
    state.split = false;
    state.children = {};
    state.expanded = {};
    state.loading = {};
    state.contextMenu = null;
    resetSearch();
    state.open = true;
    render();
  }

  function hide() {
    state.open = false;
    const panel = document.getElementById("fileBrowserPanel");
    if (panel) panel.remove();
    syncTerminalVisibility();
  }

  async function fetchEntries(path) {
    if (!state.cwd) return;
    const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(path || "")}&depth=0`);
    return data.entries || [];
  }

  async function loadTree(path) {
    if (!state.cwd) return;
    try {
      state.error = "";
      const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(path || "")}&depth=0`);
      state.path = data.path || "";
      state.entries = data.entries || [];
      state.children = {};
      state.expanded = {};
      state.loading = {};
      resetSearch();
    } catch (error) {
      state.error = error.message || String(error);
    }
    render();
  }

  function resetSearch() {
    if (state.search.timer) clearTimeout(state.search.timer);
    state.search = { query: "", results: [], searching: false, error: "", timer: null, inFlight: "", pending: "" };
  }

  function updateSearch(value) {
    state.search.query = String(value || "");
    state.search.error = "";
    if (state.search.timer) clearTimeout(state.search.timer);
    if (!state.search.query.trim()) {
      state.search.results = [];
      state.search.searching = false;
      state.search.pending = "";
      render();
      return;
    }
    state.search.searching = true;
    state.search.timer = setTimeout(() => runSearch(state.search.query), 220);
    render();
  }

  async function runSearch(query) {
    const next = String(query || "").trim();
    if (!next) return;
    if (state.search.inFlight) {
      state.search.pending = next;
      return;
    }
    state.search.inFlight = next;
    state.search.searching = true;
    render();
    try {
      const data = await api(`/api/file-browser/search?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(state.path || "")}&q=${encodeURIComponent(next)}&limit=200`);
      if (state.search.query.trim() === next) {
        state.search.results = data.entries || [];
        state.search.error = data.truncated ? "Results truncated" : "";
      }
    } catch (error) {
      if (state.search.query.trim() === next) state.search.error = error.message || String(error);
    } finally {
      state.search.inFlight = "";
      state.search.searching = false;
      const pending = state.search.pending;
      state.search.pending = "";
      render();
      if (pending && pending !== next && pending === state.search.query.trim()) runSearch(pending);
    }
  }

  async function loadFile(path, mode) {
    try {
      state.error = "";
      const replacePath = currentFilePath();
      state.selected = path;
      if (state.files.some((file) => file.path === path)) {
        render();
        return;
      }
      render();
      const file = await api(`/api/file-browser/file?cwd=${encodeURIComponent(state.cwd)}&path=${encodeURIComponent(path)}`);
      const nextFile = Object.assign(file, { draft: file.content || "", editing: false, dirty: false, saving: false, error: "" });
      if (mode === "split") {
        state.files.push(nextFile);
        state.split = true;
      } else {
        const index = Math.max(0, state.files.findIndex((file) => file.path === replacePath));
        if (state.files.length) state.files[index] = nextFile;
        else state.files.push(nextFile);
      }
    } catch (error) {
      state.error = error.message || String(error);
    }
    render();
  }

  function currentFile() {
    return state.files.find((file) => file.path === state.selected) || state.files[state.files.length - 1] || null;
  }

  function currentFilePath() {
    const file = currentFile();
    return file ? file.path : "";
  }

  function parentPath(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
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
    const oldSide = panel.querySelector && panel.querySelector(".file-browser-side");
    const oldScrollTop = oldSide ? oldSide.scrollTop : 0;
    const activeFile = currentFile();
    const entries = treeEntries();
    const search = state.search;
    const searching = search.query.trim();
    const treeHtml = searching
      ? Tree.renderEntries(search.results, { selectedPath: state.selected, callback: "HerdrFileBrowser", showMeta: true, dirClickMethod: "none", dirDoubleClickMethod: "enter", contextMethod: "menu", shiftSelectMode: true, highlightQuery: search.query })
      : Tree.renderEntries(entries, { selectedPath: state.selected, callback: "HerdrFileBrowser", showMeta: true, dirClickMethod: "none", dirDoubleClickMethod: "enter", contextMethod: "menu", shiftSelectMode: true });
    panel.innerHTML = `<aside class="file-browser-side ${activeFile ? "previewing" : ""}"><div class="file-browser-head"><div class="file-browser-title">Files</div><div class="file-browser-subtitle">${esc(state.path || state.cwd || "No workspace")}</div><div class="file-browser-actions"><button class="git-ui-btn" onclick="HerdrFileBrowser.refresh()">Refresh</button><button class="git-ui-btn" onclick="HerdrFileBrowser.close()">Close</button></div><label class="file-browser-search"><input id="fileBrowserSearch" value="${esc(search.query)}" placeholder="Search files" oninput="HerdrFileBrowser.search(this.value)">${search.searching ? '<span class="file-tree-spinner" title="Searching"></span>' : ""}</label></div>${state.error ? `<div class="file-browser-error">${esc(state.error)}</div>` : ""}${search.error ? `<div class="file-browser-error">${esc(search.error)}</div>` : ""}${treeHtml}</aside><main class="file-browser-main"><div class="file-browser-toolbar">${renderToolbar(activeFile)}</div><div class="file-browser-preview ${state.split ? "split" : ""}" id="fileBrowserPreview">${renderPreviewShell()}</div></main>${renderContextMenu()}`;
    const nextSide = panel.querySelector && panel.querySelector(".file-browser-side");
    if (nextSide) nextSide.scrollTop = oldScrollTop;
    mountEditors();
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
    const entries = flattenEntries(state.entries, 0);
    if (state.path || (allowParentBrowse() && parentDirectory(state.cwd) !== state.cwd)) entries.unshift({ kind: "up", name: "...", path: parentPath(state.path), expanded: false });
    return entries;
  }

  async function goUp() {
    if (state.path) {
      await loadTree(parentPath(state.path));
      return;
    }
    if (!allowParentBrowse()) return;
    const parent = parentDirectory(state.cwd);
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
    if (state.expanded[path]) {
      state.expanded[path] = false;
      render();
      return;
    }
    state.expanded[path] = true;
    if (!state.children[path] && !state.loading[path]) {
      state.loading[path] = true;
      render();
      try {
        state.children[path] = await fetchEntries(path);
      } catch (error) {
        state.error = error.message || String(error);
        state.expanded[path] = false;
      }
      delete state.loading[path];
    }
    render();
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
        onChange(value) {
          file.draft = value;
          file.dirty = value !== (file.content || "");
        },
        onSave() {
          if (file.editing && !file.saving) save(file.path);
        },
      });
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

  async function renamePath(path) {
    const nextName = prompt("Rename to", fileName(path));
    if (!nextName || nextName === fileName(path)) return;
    if (!confirm(`Rename ${path} to ${nextName}?`)) return;
    await api("/api/file-browser/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: state.cwd, path, new_name: nextName }),
    });
    state.files = state.files.filter((file) => file.path !== path && !file.path.startsWith(`${path}/`));
    if (state.selected === path || state.selected.startsWith(`${path}/`)) state.selected = "";
    await loadTree(state.path);
  }

  async function deletePath(path) {
    if (!confirm(`Delete ${path}? This cannot be undone.`)) return;
    await api("/api/file-browser/delete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: state.cwd, path }),
    });
    state.files = state.files.filter((file) => file.path !== path && !file.path.startsWith(`${path}/`));
    if (state.selected === path || state.selected.startsWith(`${path}/`)) state.selected = "";
    await loadTree(state.path);
  }

  window.HerdrFileBrowser = {
    open,
    openPath,
    close: hide,
    hide,
    search: updateSearch,
    refresh() { loadTree(state.path); },
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
      const path = decodeURIComponent(encodedPath);
      state.selected = path;
      state.contextMenu = { x: event.clientX, y: event.clientY, path, kind };
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
    isOpen() { return state.open; },
    isWorkspaceVisible(workspace) { return state.open && state.cwd === workspaceCwd(workspace); },
    syncTerminalVisibility,
  };
})();
