(function () {
  const Tree = window.HerdrFileTree;
  const SEARCH_PAGE_SIZE = 100;
  const state = { input: null, root: "~", path: "", entries: [], error: "", permissionRequired: false, filter: "", filterTimer: null, filterOffset: 0, filterDone: true, filterLoading: false, filterCollapsed: {}, gitStatus: null };

  function esc(value) { return Tree.esc(value); }

  function gitStatusEnabled() {
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      return parsed.fileBrowserGitStatus !== false;
    } catch (_) { return true; }
  }

  function splitPath(value) {
    const text = String(value || "").trim();
    if (!text || text.startsWith("~/")) return { root: "~", path: text.replace(/^~\/?/, "") };
    if (text === "~") return { root: "~", path: "" };
    if (text.startsWith("/")) return { root: "/", path: text.replace(/^\/+/, "") };
    return { root: "~", path: text };
  }

  function configuredDefaultFolder() {
    if (typeof window.defaultFolderPath === "function") {
      const value = String(window.defaultFolderPath() || "").trim();
      if (value && value !== "/") return value;
    }
    try {
      const parsed = window.HerdrOptions ? window.HerdrOptions.read() : {};
      const exploration = String(parsed.explorationDefaultDirectory || "").trim();
      if (exploration && exploration !== "/") return exploration;
    } catch (_) { /* fall through */ }
    return "~";
  }

  function initialPickerPath(input) {
    const text = String((input && input.value) || "").trim();
    if (!text || text === "/") return configuredDefaultFolder();
    return text;
  }

  function joinPath(root, path) {
    const rel = String(path || "").replace(/^\/+/, "");
    if (root === "/") return "/" + rel;
    return rel ? `${root.replace(/\/+$/, "")}/${rel}` : root;
  }

  function ensureStyles() {
    const href = "/assets/desktop/directory-picker.css";
    if (window.HerdrLoadCss) {
      window.HerdrLoadCss(href);
      return;
    }
    if (document.querySelector && document.querySelector(`link[href="${href}"]`)) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  async function api(url) {
    // Shared client keeps session/backend headers and 401 handling uniform.
    if (globalThis.HerdrHttp) return globalThis.HerdrHttp.request(url);
    const res = await fetch(url, { credentials: "same-origin" });
    const body = await res.json();
    if (!res.ok || body.error) {
      const error = Error(body.error || res.statusText);
      error.details = body || {};
      throw error;
    }
    return body;
  }

  async function postJson(url, payload) {
    // Shared client keeps session/backend headers and 401 handling uniform.
    if (globalThis.HerdrHttp)
      return globalThis.HerdrHttp.request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      });
    const res = await fetch(url, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload || {}) });
    const body = await res.json();
    if (!res.ok || body.error) {
      const error = Error(body.error || res.statusText);
      error.details = body || {};
      throw error;
    }
    return body;
  }

  function setError(error) {
    state.error = error.message || String(error);
    state.permissionRequired = !!(error.details && error.details.permission_required);
  }

  function attach(inputId) {
    const input = document.getElementById(inputId);
    if (!input || document.getElementById(`${inputId}Browse`)) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = `${inputId}Browse`;
    button.className = "mini directory-picker-trigger";
    button.textContent = "Browse";
    button.onclick = () => open(input);
    input.insertAdjacentElement("afterend", button);
  }

  function open(input) {
    ensureStyles();
    state.input = input;
    const parts = splitPath(initialPickerPath(input));
    state.root = parts.root;
    load(parts.path || "");
  }

  function openInput(inputId) {
    const input = document.getElementById(inputId);
    if (input) open(input);
  }

  async function load(path) {
    state.path = path || "";
    state.filter = "";
    state.filterOffset = 0;
    state.filterDone = true;
    state.filterLoading = false;
    clearTimeout(state.filterTimer);
    state.error = "";
    state.permissionRequired = false;
    render();
    try {
      const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(state.root)}&path=${encodeURIComponent(state.path)}&dirs_only=true${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
      state.path = data.path || "";
      state.entries = data.entries || [];
      state.gitStatus = data.git_status || null;
    } catch (error) {
      setError(error);
      state.entries = [];
    }
    render();
  }

  async function search(append = false) {
    const term = state.filter.trim();
    if (!term) { load(state.path); return; }
    const offset = append ? state.filterOffset : 0;
    if (append && state.filterLoading) return;
    state.filterLoading = true;
    // A fresh term restarts the result tree, so per-folder collapse
    // choices from the previous term must not leak into the new one.
    if (!append) state.filterCollapsed = {};
    // Re-render before the fetch so the loading hint shows while paging in
    // more results; skip when appending so the scroll position survives.
    if (!append) render();
    try {
      // search_kind=dir keeps the picker folder-only while searching;
      // without it the backend returns files too because q= drives the
      // search branch, where dirs_only does not apply.
      const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(state.root)}&path=${encodeURIComponent(state.path)}&q=${encodeURIComponent(term)}&search_kind=dir&offset=${offset}&limit=${SEARCH_PAGE_SIZE}${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
      const entries = data.entries || [];
      state.entries = append ? state.entries.concat(entries) : entries;
      state.gitStatus = data.git_status || null;
      state.filterOffset = offset + entries.length;
      // The server walks the tree with a visit cap, so `truncated` can be
      // true even when a page comes back short. Keep paging available as
      // long as the server reports more matches.
      state.filterDone = !data.truncated || entries.length === 0;
      state.error = "";
      state.permissionRequired = false;
    } catch (error) {
      setError(error);
      if (!append) state.entries = [];
      state.filterDone = true;
    }
    state.filterLoading = false;
    render();
  }

  function close() {
    const node = document.getElementById("directoryPickerModal");
    if (node) node.remove();
    state.input = null;
  }

  function parentPath(path) {
    const parts = String(path || "").split("/").filter(Boolean);
    parts.pop();
    return parts.join("/");
  }

  function currentFolderName() {
    const parts = String(state.path || "").split("/").filter(Boolean);
    return parts[parts.length - 1] || state.root;
  }

  function afterSelectCallback(input) {
    const name = input && input.dataset && input.dataset.directoryPickerAfterSelect;
    if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*(\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(name)) return null;
    let owner = window;
    const parts = name.split(".");
    const method = parts.pop();
    for (const part of parts) owner = owner && owner[part];
    const fn = owner && owner[method];
    return typeof fn === "function" ? () => fn.call(owner) : null;
  }

  function selectCurrent() {
    if (!state.input) return;
    const input = state.input;
    input.value = joinPath(state.root, state.path);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const callback = afterSelectCallback(input);
    close();
    if (callback) callback();
  }

  function goToDefaultFolder() {
    const target = splitPath(configuredDefaultFolder());
    state.root = target.root;
    load(target.path || "");
  }

  function isFilterCollapsed(path) {
    return !!state.filterCollapsed[String(path || "")];
  }

  // Hide descendants of collapsed folders in the filtered result tree;
  // dir carets stay open only while a descendant row is still visible.
  function applyFilterCollapse(rows) {
    const list = rows || [];
    const parents = new Set();
    for (const row of list) {
      const parts = String(row.path || "").split("/").filter(Boolean);
      parts.pop();
      let prefix = "";
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        parents.add(prefix);
      }
    }
    return list.filter((row) => {
      const parts = String(row.path || "").split("/").filter(Boolean);
      for (let i = 1; i < parts.length; i++) {
        if (isFilterCollapsed(parts.slice(0, i).join("/"))) return false;
      }
      return true;
    }).map((row) => row.kind !== "dir" ? row : Object.assign({}, row, { expanded: parents.has(String(row.path || "")) && !isFilterCollapsed(row.path) }));
  }

  function toggleFilter(encodedPath) {
    const path = decodeURIComponent(encodedPath);
    // Only dir rows call this, and only while a filter term is active.
    state.filterCollapsed[path] = !state.filterCollapsed[path];
    render();
  }

  function render() {
    let modal = document.getElementById("directoryPickerModal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "directoryPickerModal";
      modal.className = "directory-picker-backdrop";
      document.body.appendChild(modal);
    }
    const active = document.activeElement;
    const refocus = active && active.id === "directoryPickerSearchInput";
    const selStart = refocus ? active.selectionStart : null;
    const selEnd = refocus ? active.selectionEnd : null;
    const filtering = !!state.filter.trim();
    const appending = filtering && state.filterLoading && state.filterOffset > 0;
    const tree = modal.querySelector(".directory-picker-tree");
    const previousScroll = appending && tree ? tree.scrollTop : null;
    const canGoUp = state.path || state.root !== "/";
    const entries = Tree.applyGitStatus(filtering
      ? applyFilterCollapse(Tree.searchTreeEntries(state.entries))
      : [
          ...(state.entries || []).map((entry) => Object.assign({}, entry, { expanded: false, level: Number(entry.level || 0) + 1 })),
        ], state.gitStatus);
    const currentPath = joinPath(state.root, state.path);
    const currentRow = filtering ? "" : Tree.renderCurrentDirectoryRow({
      callback: "HerdrDirectoryPicker",
      path: currentPath,
      label: currentFolderName(),
      title: currentPath,
      canGoUp,
    });
    const moreRow = filtering && !state.filterDone
      ? `<div class="directory-picker-more"><button class="git-ui-btn" ${state.filterLoading ? "disabled" : ""} onclick="HerdrDirectoryPicker.loadMore()">${state.filterLoading ? "Loading…" : "Load more"}</button></div>`
      : "";
    modal.innerHTML = `<div class="directory-picker"><div class="directory-picker-head"><strong>Choose folder</strong><button class="git-ui-btn" onclick="HerdrDirectoryPicker.close()">Close</button></div><div class="directory-picker-path">${esc(currentPath)}</div><div class="directory-picker-actions"><button class="git-ui-btn" onclick="HerdrDirectoryPicker.home()">Home</button><button class="git-ui-btn" onclick="HerdrDirectoryPicker.defaultFolder()">Default dir</button><button class="git-ui-btn primary" onclick="HerdrDirectoryPicker.selectCurrent()">Select this folder</button></div>${renderAccessError()}<div class="directory-picker-search"><input id="directoryPickerSearchInput" type="text" placeholder="Type to search..." value="${esc(state.filter)}"${inputAttrs("search")} oninput="HerdrDirectoryPicker.filter(this.value)"></div><div class="directory-picker-tree" onscroll="HerdrDirectoryPicker.treeScroll(this)">${currentRow}${Tree.renderEntries(entries, { callback: "HerdrDirectoryPicker", selectedPath: state.path, toggleMethod: filtering ? "toggleFilter" : "toggle", dirDoubleClickMethod: filtering ? "select" : "" })}${moreRow}</div></div>`;
    if (refocus) {
      const input = document.getElementById("directoryPickerSearchInput");
      if (input) {
        input.focus({ preventScroll: true });
        const start = selStart == null ? input.value.length : Math.min(selStart, input.value.length);
        const end = selEnd == null ? start : Math.min(selEnd, input.value.length);
        input.setSelectionRange(start, end);
      }
    }
    if (previousScroll != null) {
      const nextTree = modal.querySelector(".directory-picker-tree");
      if (nextTree) nextTree.scrollTop = previousScroll;
    }
  }

  function renderAccessError() {
    if (!state.error) return "";
    const action = state.permissionRequired ? `<button class="git-ui-btn primary" onclick="HerdrDirectoryPicker.requestAccess()">Grant folder access</button>` : "";
    return `<div class="directory-picker-error"><span>${esc(state.error)}</span>${action}</div>`;
  }

  async function requestAccess() {
    try {
      const data = await postJson("/api/file-browser/request-access", { cwd: state.root, path: state.path || "" });
      if (data.path) {
        const parts = splitPath(data.path);
        state.root = parts.root;
        state.path = parts.path;
      }
      await load(state.path || "");
    } catch (error) {
      setError(error);
      state.entries = [];
      render();
    }
  }

  window.HerdrDirectoryPicker = {
    // open(inputNode) is the node-based entry the temporary overlays use
    // (the host passes a detached hidden input carrying the current folder).
    open,
    attach,
    openInput,
    close,
    selectCurrent,
    requestAccess,
    toggle(encodedPath) { load(decodeURIComponent(encodedPath)); },
    // While filtering, dir rows collapse their block in the results instead
    // of navigating; double-click still enters the folder (select).
    toggleFilter,
    select(encodedPath) { load(decodeURIComponent(encodedPath)); },
    up(encodedPath) {
      const target = decodeURIComponent(encodedPath || "");
      if (target) { load(target); return; }
      if (state.root === "~" && !state.path) {
        state.root = "/";
        state.path = "";
        state.entries = [];
        load("");
        return;
      }
      if (state.root === "/" && !state.path) return;
      load(parentPath(state.path));
    },
    home() { state.root = "~"; load(""); },
    defaultFolder: goToDefaultFolder,
    root() { state.root = "/"; load(""); },
    filter(value) {
      state.filter = String(value || "");
      clearTimeout(state.filterTimer);
      state.filterTimer = setTimeout(() => search(), 200);
    },
    loadMore() { search(true); },
    treeScroll(node) {
      // Infinite scroll: when the user nears the bottom of the result
      // list, fetch the next page of matches and append it.
      if (!state.filter.trim() || state.filterLoading || state.filterDone) return;
      if (node.scrollTop + node.clientHeight < node.scrollHeight - 80) return;
      search(true);
    },
  };
})();
