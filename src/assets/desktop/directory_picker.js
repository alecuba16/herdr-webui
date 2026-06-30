(function () {
  const Tree = window.HerdrFileTree;
  const state = { input: null, root: "~", path: "", entries: [], error: "" };

  function esc(value) { return Tree.esc(value); }

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
    if (!res.ok || body.error) throw Error(body.error || res.statusText);
    return body;
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
    state.error = "";
    render();
    try {
      const data = await api(`/api/file-browser/tree?cwd=${encodeURIComponent(state.root)}&path=${encodeURIComponent(state.path)}&dirs_only=true`);
      state.path = data.path || "";
      state.entries = data.entries || [];
    } catch (error) {
      state.error = error.message || String(error);
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
    const entries = [
      ...(state.path ? [{ kind: "up", name: "..", path: parentPath(state.path), level: 0 }] : []),
      { kind: "dir", name: `Current: ${currentFolderName()}`, path: state.path, expanded: true, level: 0 },
      ...(state.entries || []).map((entry) => Object.assign({}, entry, { expanded: false, level: Number(entry.level || 0) + 1 })),
    ];
    modal.innerHTML = `<div class="directory-picker"><div class="directory-picker-head"><strong>Choose folder</strong><button class="git-ui-btn" onclick="HerdrDirectoryPicker.close()">Close</button></div><div class="directory-picker-path">${esc(joinPath(state.root, state.path))}</div><div class="directory-picker-actions"><button class="git-ui-btn" onclick="HerdrDirectoryPicker.home()">Home</button><button class="git-ui-btn" onclick="HerdrDirectoryPicker.root()">Root</button><button class="git-ui-btn" title="Go up to parent folder" ${state.path ? "" : "disabled"} onclick="HerdrDirectoryPicker.up()">↑ ..</button><button class="git-ui-btn primary" onclick="HerdrDirectoryPicker.selectCurrent()">Select this folder</button></div>${state.error ? `<div class="file-browser-error">${esc(state.error)}</div>` : ""}<div class="directory-picker-tree">${Tree.renderEntries(entries, { callback: "HerdrDirectoryPicker", selectedPath: state.path })}</div></div>`;
  }

  window.HerdrDirectoryPicker = {
    attach,
    openInput,
    close,
    selectCurrent,
    toggle(encodedPath) { load(decodeURIComponent(encodedPath)); },
    select(encodedPath) { load(decodeURIComponent(encodedPath)); },
    up() { load(parentPath(state.path)); },
    home() { state.root = "~"; load(""); },
    root() { state.root = "/"; load(""); },
  };
})();
