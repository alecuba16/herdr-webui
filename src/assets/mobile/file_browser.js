(function () {
  function create(deps) {
    const Tree = globalThis.HerdrFileTree;
    const Editor = globalThis.HerdrEditor;
    const state = deps.state;
    const local = { path: "", entries: [], selected: "", file: null, error: "", loading: false };

    function cwd() {
      return deps.currentWorkspaceCwd() || "";
    }

    async function load(path) {
      const root = cwd();
      if (!root) {
        local.error = "No workspace path available";
        deps.render();
        return;
      }
      local.loading = true;
      local.error = "";
      deps.render();
      try {
        const depth = fileBrowserDepth();
        const data = await deps.api(`/api/file-browser/tree?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(path || "")}&depth=${depth}`);
        local.path = data.path || "";
        local.entries = data.entries || [];
        local.file = null;
      } catch (error) {
        local.error = error.message || String(error);
      }
      local.loading = false;
      deps.render();
    }

    async function openFile(path) {
      const root = cwd();
      local.selected = path;
      local.file = null;
      local.loading = true;
      deps.render();
      try {
        local.error = "";
        local.file = await deps.api(`/api/file-browser/file?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`);
      } catch (error) {
        local.error = error.message || String(error);
      }
      local.loading = false;
      deps.render();
    }

    function parentPath(path) {
      const parts = String(path || "").split("/").filter(Boolean);
      parts.pop();
      return parts.join("/");
    }

    function renderScreen() {
      if (!cwd()) return '<div class="mobile-loading">Select workspace with path first</div>';
      if (!local.entries.length && !local.loading && !local.error) load(local.path || "");
      if (local.file) return renderPreview();
      const tree = Tree.renderEntries(treeEntries(), { selectedPath: local.selected, callback: "HerdrMobileFiles", showMeta: true });
      return `<section class="mobile-section mobile-files"><h2>Files</h2><p class="mobile-help">${deps.escapeHtml(local.path || cwd())}</p><div class="mobile-actions"><button class="mobile-btn" onclick="HerdrMobile.filesRefresh()">Refresh</button></div>${local.error ? `<div class="mobile-error">${deps.escapeHtml(local.error)}</div>` : ""}${local.loading ? '<div class="mobile-loading">Loading</div>' : tree}</section>`;
    }

    function treeEntries() {
      const entries = local.entries.map((entry) => Object.assign({}, entry));
      if (local.path) entries.unshift({ kind: "up", name: "...", path: parentPath(local.path), expanded: false });
      return entries;
    }

    function fileBrowserDepth() {
      try {
        const parsed = JSON.parse(localStorage.getItem("herdr-web-options") || "{}");
        const value = Number(parsed.fileBrowserDepth);
        return Math.max(0, Math.min(8, Number.isFinite(value) ? value : 3));
      } catch (_) {
        return 3;
      }
    }

    function renderPreview() {
      const file = local.file;
      let body = '<div class="mobile-loading">No preview</div>';
      if (file.binary) body = '<div class="mobile-loading">Binary file preview unavailable</div>';
      else if (file.truncated) body = `<div class="mobile-loading">File too large to preview (${Tree.formatBytes(file.size)})</div>`;
      else body = `<div id="mobileFilePreview"></div>`;
      setTimeout(() => {
        const parent = document.getElementById("mobileFilePreview");
        if (parent && local.file) Editor.create({ parent, path: local.file.path, content: local.file.content || "", readonly: true, hideHeader: true });
      }, 0);
      return `<section class="mobile-section mobile-files"><h2>Files</h2><div class="mobile-actions"><button class="mobile-btn" onclick="HerdrMobile.filesBackToTree()">Back</button><button class="mobile-btn" onclick="HerdrMobile.filesRefreshFile()">Refresh</button></div><p class="mobile-help">${deps.escapeHtml(file.path || "")}</p>${local.error ? `<div class="mobile-error">${deps.escapeHtml(local.error)}</div>` : ""}${body}</section>`;
    }

    return {
      load,
      renderScreen,
      reset() {
        local.path = "";
        local.entries = [];
        local.selected = "";
        local.file = null;
        local.error = "";
      },
      toggle(encodedPath) { load(decodeURIComponent(encodedPath)); },
      select(encodedPath) { openFile(decodeURIComponent(encodedPath)); },
      up() { load(parentPath(local.path)); },
      refresh() { load(local.path); },
      backToTree() { local.file = null; deps.render(); },
      refreshFile() { if (local.file) openFile(local.file.path); },
    };
  }

  globalThis.HerdrMobileFileBrowser = { create };
})();
