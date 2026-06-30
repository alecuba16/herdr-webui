(function () {
  function create(deps) {
    const Tree = globalThis.HerdrFileTree;
    const Editor = globalThis.HerdrEditor;
    const state = deps.state;
    const local = { path: "", entries: [], selected: "", file: null, error: "", loading: false, editor: null, editorKey: "" };

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
        destroyEditor();
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
      destroyEditor();
      local.file = null;
      local.loading = true;
      deps.render();
      try {
        local.error = "";
        local.file = normalizeFile(await deps.api(`/api/file-browser/file?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`));
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
      const canEdit = file && !file.binary && !file.truncated;
      let body = '<div class="mobile-loading">No preview</div>';
      if (file.binary) body = '<div class="mobile-loading">Binary file preview unavailable</div>';
      else if (file.truncated) body = `<div class="mobile-loading">File too large to preview (${Tree.formatBytes(file.size)})</div>`;
      else body = `<div id="mobileFilePreview"></div>`;
      setTimeout(() => {
        const parent = document.getElementById("mobileFilePreview");
        if (!parent || !local.file) return;
        const editorKey = `${local.file.path}:${local.file.editing ? "edit" : "view"}`;
        if (local.editor && local.editorKey === editorKey) return;
        if (local.editor && local.editor.destroy) local.editor.destroy();
        local.editorKey = editorKey;
        local.editor = Editor.create({
          parent,
          path: local.file.path,
          content: local.file.editing ? local.file.draft : local.file.content || "",
          readonly: !local.file.editing,
          hideHeader: true,
          onChange(value) {
            local.file.draft = value;
            local.file.dirty = value !== (local.file.content || "");
          },
          onSave() {
            if (local.file.editing && !local.file.saving) saveFile();
          },
        });
      }, 0);
      const editControls = canEdit && file.editing
        ? `<button class="mobile-btn primary" ${file.saving ? "disabled" : ""} onclick="HerdrMobile.filesSave()">${file.saving ? "Saving" : "Save"}</button><button class="mobile-btn" onclick="HerdrMobile.filesCancelEdit()">Cancel</button>`
        : canEdit
          ? `<button class="mobile-btn primary" onclick="HerdrMobile.filesEdit()">Edit</button>`
          : "";
      const dirty = file.dirty ? " · modified" : "";
      return `<section class="mobile-section mobile-files"><h2>Files</h2><div class="mobile-actions mobile-actions-wrap"><button class="mobile-btn" onclick="HerdrMobile.filesBackToTree()">Back</button>${editControls}<button class="mobile-btn" onclick="HerdrMobile.filesRefreshFile()">Refresh</button><button class="mobile-btn" onclick="HerdrMobile.filesRename()">Rename</button><button class="mobile-btn danger" onclick="HerdrMobile.filesDelete()">Delete</button></div><p class="mobile-help">${deps.escapeHtml(file.path || "")}${dirty}</p>${file.error ? `<div class="mobile-error">${deps.escapeHtml(file.error)}</div>` : ""}${local.error ? `<div class="mobile-error">${deps.escapeHtml(local.error)}</div>` : ""}${body}</section>`;
    }

    function normalizeFile(file) {
      return Object.assign({}, file, {
        draft: (file && file.content) || "",
        editing: false,
        dirty: false,
        saving: false,
        error: "",
      });
    }

    function destroyEditor() {
      if (local.editor && local.editor.destroy) local.editor.destroy();
      local.editor = null;
      local.editorKey = "";
    }

    function fileName(path) {
      const parts = String(path || "").split("/").filter(Boolean);
      return parts[parts.length - 1] || path || "";
    }

    async function saveFile() {
      const file = local.file;
      if (!file || file.saving) return;
      file.saving = true;
      file.error = "";
      deps.render();
      try {
        const result = await deps.api("/api/file-browser/file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: cwd(), path: file.path, content: file.draft, expected_hash: file.hash || "" }),
        });
        file.content = file.draft;
        file.hash = result.hash || file.hash;
        file.dirty = false;
        file.editing = false;
        destroyEditor();
      } catch (error) {
        file.error = error.message || String(error);
      }
      file.saving = false;
      deps.render();
    }

    async function renameFile() {
      const file = local.file;
      if (!file) return;
      const nextName = prompt("Rename to", fileName(file.path));
      if (!nextName || nextName === fileName(file.path)) return;
      if (!confirm(`Rename ${file.path} to ${nextName}?`)) return;
      try {
        local.error = "";
        await deps.api("/api/file-browser/rename", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: cwd(), path: file.path, new_name: nextName }),
        });
        local.file = null;
        destroyEditor();
        await load(local.path);
      } catch (error) {
        local.error = error.message || String(error);
        deps.render();
      }
    }

    async function deleteFile() {
      const file = local.file;
      if (!file || !confirm(`Delete ${file.path}? This cannot be undone.`)) return;
      try {
        local.error = "";
        await deps.api("/api/file-browser/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cwd: cwd(), path: file.path }),
        });
        local.file = null;
        destroyEditor();
        await load(local.path);
      } catch (error) {
        local.error = error.message || String(error);
        deps.render();
      }
    }

    return {
      load,
      renderScreen,
      reset() {
        destroyEditor();
        local.path = "";
        local.entries = [];
        local.selected = "";
        local.file = null;
        local.error = "";
      },
      toggle(encodedPath) { return load(decodeURIComponent(encodedPath)); },
      select(encodedPath) { return openFile(decodeURIComponent(encodedPath)); },
      up() { return load(parentPath(local.path)); },
      refresh() { return load(local.path); },
      backToTree() { destroyEditor(); local.file = null; deps.render(); },
      refreshFile() { if (local.file) openFile(local.file.path); },
      edit() {
        if (!local.file || local.file.binary || local.file.truncated) return;
        local.file.editing = true;
        local.file.draft = local.file.content || "";
        local.file.dirty = false;
        destroyEditor();
        deps.render();
      },
      cancelEdit() {
        if (!local.file) return;
        local.file.editing = false;
        local.file.draft = local.file.content || "";
        local.file.dirty = false;
        destroyEditor();
        deps.render();
      },
      save: saveFile,
      rename: renameFile,
      delete: deleteFile,
    };
  }

  globalThis.HerdrMobileFileBrowser = { create };
})();
