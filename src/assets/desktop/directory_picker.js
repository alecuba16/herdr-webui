(function () {
  const Tree = window.HerdrFileTree;
  const state = { input: null, root: "~", path: "", entries: [], error: "", permissionRequired: false, filter: "", filterTimer: null, gitStatus: null };

  function esc(value) { return Tree.esc(value); }

  function gitStatusEnabled() {
    try {
      const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
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

  function joinPath(root, path) {
    const rel = String(path || "").replace(/^\/+/, "");
    if (root === "/") return "/" + rel;
    return rel ? `${root.replace(/\/+$/, "")}/${rel}` : root;
  }

  async function api(url) {
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
    state.input = input;
    const parts = splitPath(input.value);
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

  async function search() {
    if (!state.filter.trim()) { load(state.path); return; }
    try {
      const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(state.root)}&path=${encodeURIComponent(state.path)}&q=${encodeURIComponent(state.filter.trim())}&limit=100${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
      state.entries = data.entries || [];
      state.gitStatus = data.git_status || null;
    } catch (error) {
      setError(error);
      state.entries = [];
    }
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

  function selectCurrent() {
    if (!state.input) return;
    state.input.value = joinPath(state.root, state.path);
    state.input.dispatchEvent(new Event("input", { bubbles: true }));
    state.input.dispatchEvent(new Event("change", { bubbles: true }));
    close();
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
    const canGoUp = state.path || state.root !== "/";
    const entries = Tree.applyGitStatus(filtering
      ? Tree.searchTreeEntries(state.entries)
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
    modal.innerHTML = `<div class="directory-picker"><div class="directory-picker-head"><strong>Choose folder</strong><button class="git-ui-btn" onclick="HerdrDirectoryPicker.close()">Close</button></div><div class="directory-picker-path">${esc(currentPath)}</div><div class="directory-picker-actions"><button class="git-ui-btn" onclick="HerdrDirectoryPicker.home()">Home</button><button class="git-ui-btn primary" onclick="HerdrDirectoryPicker.selectCurrent()">Select this folder</button></div>${renderAccessError()}<div class="directory-picker-search"><input id="directoryPickerSearchInput" type="text" placeholder="Type to search..." value="${esc(state.filter)}" oninput="HerdrDirectoryPicker.filter(this.value)"></div><div class="directory-picker-tree">${currentRow}${Tree.renderEntries(entries, { callback: "HerdrDirectoryPicker", selectedPath: state.path })}</div></div>`;
    if (refocus) {
      const input = document.getElementById("directoryPickerSearchInput");
      if (input) {
        input.focus({ preventScroll: true });
        const start = selStart == null ? input.value.length : Math.min(selStart, input.value.length);
        const end = selEnd == null ? start : Math.min(selEnd, input.value.length);
        input.setSelectionRange(start, end);
      }
    }
  }

  function renderAccessError() {
    if (!state.error) return "";
    const action = state.permissionRequired ? `<button class="git-ui-btn primary" onclick="HerdrDirectoryPicker.requestAccess()">Grant folder access</button>` : "";
    return `<div class="file-browser-error"><span>${esc(state.error)}</span>${action}</div>`;
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
    attach,
    openInput,
    close,
    selectCurrent,
    requestAccess,
    toggle(encodedPath) { load(decodeURIComponent(encodedPath)); },
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
    root() { state.root = "/"; load(""); },
    filter(value) {
      state.filter = String(value || "");
      clearTimeout(state.filterTimer);
      state.filterTimer = setTimeout(() => search(), 200);
    },
  };
})();
