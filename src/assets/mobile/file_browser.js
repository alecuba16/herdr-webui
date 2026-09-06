(function () {
  function create(deps) {
    const Tree = globalThis.HerdrFileTree;
    const Editor = globalThis.HerdrEditor;
    const DEFAULT_CONTENT_SEARCH_MIN_CHARS = 3;
    const state = deps.state;
    function createContentSearchState() {
      return { active: false, query: "", timer: null, files: [], expanded: {}, loading: false, error: "", offset: 0, done: true, totalFiles: 0, totalMatches: 0, visited: 0, truncated: false, contextLines: 2, maxMatchesPerFile: 5, autoCollapseFiles: 0, defaultExpanded: true };
    }
    const local = { path: "", entries: [], selected: "", file: null, error: "", loading: false, filter: "", filterVisible: false, filterTimer: null, filterOffset: 0, filterDone: true, filterKind: "file", scrollTop: 0, cwdOverride: "", gitStatus: null, editing: false, draft: "", dirty: false, saving: false, saveError: "", actionSheet: null, rename: null, newFile: null, mutating: false, contentSearch: createContentSearchState() };

    function cwd() {
      return local.cwdOverride || deps.currentWorkspaceCwd() || "";
    }

    function gitStatusEnabled() {
      try {
        const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
        return parsed.fileBrowserGitStatus !== false;
      } catch (_) { return true; }
    }

    function lineNumbersEnabled() {
      try {
        const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
        return parsed.fileBrowserLineNumbers !== false;
      } catch (_) { return true; }
    }

    // Desktop parity (B4): the same editor options the desktop file browser
    // applies, so word wrap / tab size / folding behave identically on mobile.
    function editorOptions() {
      try {
        const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
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
        const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
        return parsed.fileBrowserAllowParent === true;
      } catch (_) { return false; }
    }

    // ---- Language server integration (IDE-review B4) ----
    // Desktop parity: opt-in LSP diagnostics rendered under the mobile editor.
    // Default off; enabled from Settings like on desktop (same lspEnabled key).

    function lspEnabled() {
      const Lsp = globalThis.HerdrLsp;
      if (!Lsp) return false;
      try {
        const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
        return parsed.lspEnabled === true;
      } catch (_) {
        return false;
      }
    }

    function lspWorkspace() {
      const Lsp = globalThis.HerdrLsp;
      if (!Lsp) return null;
      const root = cwd();
      if (!root) return null;
      return Lsp.workspaceFor(root);
    }

    function lspDidOpen(file) {
      if (!lspEnabled() || !file || file.binary || file.truncated) return;
      const Lsp = globalThis.HerdrLsp;
      const ws = lspWorkspace();
      if (!Lsp || !ws) return;
      Lsp.didOpen(ws, file.path, local.editing ? local.draft : file.content || "").catch(() => {});
      setTimeout(() => lspRenderDiagnostics(file.path), 0);
    }

    function lspDidChange(path, value) {
      if (!lspEnabled()) return;
      const Lsp = globalThis.HerdrLsp;
      const ws = lspWorkspace();
      if (!Lsp || !ws) return;
      Lsp.didChange(ws, path, value);
    }

    function lspDidClose(path) {
      if (!lspEnabled()) return;
      const Lsp = globalThis.HerdrLsp;
      const ws = lspWorkspace();
      if (!Lsp || !ws) return;
      Lsp.didClose(ws, path).catch(() => {});
    }

    function lspDiagnosticsFor(path) {
      if (!lspEnabled()) return [];
      const Lsp = globalThis.HerdrLsp;
      const ws = lspWorkspace();
      if (!Lsp || !ws) return [];
      return Lsp.diagnosticsFor(ws, path) || [];
    }

    function lspRenderDiagnostics(path) {
      if (typeof document.querySelectorAll !== "function") return;
      const mount = document.getElementById("mobileFilePreview");
      if (!mount) return;
      const diagnostics = lspDiagnosticsFor(path);
      lspRenderDiagnosticsInto(mount, diagnostics);
    }

    // Rendered as a plain list under the editor: tapping an item is a no-op on
    // mobile (no editor view handle reachable), the message is the value.
    function lspRenderDiagnosticsInto(mount, diagnostics) {
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
        .map((diagnostic) => {
          const severity = Number(diagnostic.severity) === 1 ? "error" : Number(diagnostic.severity) === 2 ? "warning" : "info";
          const line = diagnostic.range && diagnostic.range.start ? (Number(diagnostic.range.start.line) || 0) + 1 : 0;
          const where = line ? `:${line}` : "";
          const message = String(diagnostic.message || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
          return `<div class="herdr-lsp-diagnostic ${severity}">${severity === "error" ? "●" : severity === "warning" ? "▲" : "ℹ"} ${where ? `<strong>${where}</strong> ` : ""}${message}</div>`;
        })
        .join("");
    }

    function pathSearchOptions() {
      try {
        const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
        return { pageSize: Math.max(10, Math.min(500, Number(parsed.fileBrowserSearchPageSize) || 100)) };
      } catch (_) { return { pageSize: 100 }; }
    }

    function contentSearchOptions() {
      try {
        const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
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

    function clearContentSearchResults() {
      local.contentSearch.files = [];
      local.contentSearch.expanded = {};
      local.contentSearch.error = "";
      local.contentSearch.done = true;
      local.contentSearch.offset = 0;
      local.contentSearch.totalFiles = 0;
      local.contentSearch.totalMatches = 0;
      local.contentSearch.visited = 0;
      local.contentSearch.truncated = false;
    }

    async function load(path, preserveFocus = false) {
      const root = cwd();
      if (!root) {
        local.error = "No workspace path available";
        deps.render();
        return;
      }
      local.loading = true;
      local.error = "";
      if (preserveFocus) renderPreservingFocus();
      else deps.render();
      try {
        const depth = fileBrowserDepth();
        const data = await deps.api(`/api/file-browser/tree?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(path || "")}&depth=${depth}${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
        local.path = data.path || "";
        local.entries = data.entries || [];
        local.gitStatus = data.git_status || null;
        local.file = null;
        local.filterOffset = 0;
        local.filterDone = !local.filter.trim();
      } catch (error) {
        local.error = error.message || String(error);
      }
      local.loading = false;
      if (preserveFocus) renderPreservingFocus();
      else deps.render();
    }

    async function loadFiltered(append = false) {
      const root = cwd();
      if (!root || !local.filter.trim() || local.filterKind === "content") return;
      local.loading = true;
      renderPreservingFocus();
      try {
        const offset = append ? local.filterOffset : 0;
        const pageSize = pathSearchOptions().pageSize;
        const data = await deps.api(`/api/file-browser/tree?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(local.path || "")}&q=${encodeURIComponent(local.filter.trim())}&${Tree.searchKindQuery(local.filterKind)}&offset=${offset}&limit=${pageSize}${gitStatusEnabled() ? "&include_git_status=true" : ""}`);
        const entries = data.entries || [];
        local.entries = append ? local.entries.concat(entries) : entries;
        local.gitStatus = data.git_status || null;
        local.filterOffset = offset + entries.length;
        local.filterDone = !data.truncated || entries.length === 0;
        local.error = "";
      } catch (error) {
        local.error = error.message || String(error);
        local.filterDone = true;
      }
      local.loading = false;
      renderPreservingFocus();
    }

    async function openFile(path, searchHighlight) {
      const root = cwd();
      if (local.file && local.file.path && local.file.path !== path) lspDidClose(local.file.path);
      local.selected = path;
      local.file = null;
      local.editing = false;
      local.draft = "";
      local.dirty = false;
      local.saving = false;
      local.saveError = "";
      local.loading = true;
      deps.render();
      try {
        local.error = "";
        local.file = await deps.api(`/api/file-browser/file?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}&render=lines`);
        local.file.searchHighlight = searchHighlight || null;
        local.file.linesHtml = local.file.lines_gutter_html != null && local.file.lines_code_html != null ? { gutter: local.file.lines_gutter_html, code: local.file.lines_code_html } : null;
      } catch (error) {
        local.error = error.message || String(error);
      }
      local.loading = false;
      deps.render();
    }

    function canEditFile(file) {
      return !!(file && !file.binary && !file.truncated);
    }

    function confirmDiscardDraft() {
      if (!local.editing || !local.dirty) return true;
      const ok = deps.confirm(`Discard unsaved changes to ${local.file ? local.file.path : "this file"}?`);
      if (!ok) return false;
      local.draft = local.file ? local.file.content || "" : "";
      local.dirty = false;
      return true;
    }

    function startEdit() {
      const file = local.file;
      if (!canEditFile(file) || local.editing) return;
      if (file.searchHighlight) file.searchHighlight = null;
      local.editing = true;
      local.draft = file.content || "";
      local.dirty = false;
      local.saveError = "";
      deps.render();
    }

    function cancelEdit() {
      if (!local.editing) return;
      if (!confirmDiscardDraft()) return;
      local.editing = false;
      local.saveError = "";
      deps.render();
    }

    async function saveFile() {
      const file = local.file;
      if (!file || !local.editing || local.saving) return;
      local.saving = true;
      local.saveError = "";
      deps.render();
      try {
        const result = await deps.api("/api/file-browser/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: cwd(), path: file.path, content: local.draft, expected_hash: file.hash || "" }),
        });
        file.content = local.draft;
        file.hash = result.hash || file.hash;
        local.dirty = false;
        local.editing = false;
        local.draft = "";
      } catch (error) {
        local.saveError = error.message || String(error);
      }
      local.saving = false;
      deps.render();
    }

    // ---- Row actions: rename / delete / new file (IDE-review B2) ----

    function openActionSheet(encodedPath, kind) {
      if (local.editing && !confirmDiscardDraft()) return;
      const path = decodeURIComponent(encodedPath);
      local.actionSheet = { path, kind: kind === "dir" ? "dir" : "file" };
      deps.render();
    }

    function closeActionSheet() {
      if (!local.actionSheet) return;
      local.actionSheet = null;
      deps.render();
    }

    function openRename(encodedPath) {
      const path = decodeURIComponent(encodedPath);
      const name = Tree.basename(path);
      local.actionSheet = null;
      local.rename = { path, name, value: name, error: "" };
      deps.render();
    }

    function setRenameValue(value) {
      if (!local.rename) return;
      local.rename.value = String(value || "");
      syncSheetInputState();
    }

    function cancelRename() {
      if (!local.rename) return;
      local.rename = null;
      deps.render();
    }

    async function submitRename() {
      const rename = local.rename;
      if (!rename || local.mutating) return;
      const nextName = rename.value.trim();
      if (!nextName || nextName === rename.name) { cancelRename(); return; }
      local.mutating = true;
      rename.error = "";
      deps.render();
      try {
        await deps.api("/api/file-browser/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: cwd(), path: rename.path, new_name: nextName }),
        });
        local.rename = null;
        await load(local.path || "");
      } catch (error) {
        rename.error = error.message || String(error);
      }
      local.mutating = false;
      deps.render();
    }

    async function deletePath(encodedPath) {
      const path = decodeURIComponent(encodedPath);
      local.actionSheet = null;
      if (!deps.confirm(`Delete ${path}? This cannot be undone.`)) return;
      local.mutating = true;
      deps.render();
      try {
        await deps.api("/api/file-browser/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: cwd(), path }),
        });
        if (local.file && (local.file.path === path || local.file.path.startsWith(`${path}/`))) {
          local.file = null;
          local.editing = false;
          local.draft = "";
          local.dirty = false;
        }
        if (local.selected === path || local.selected.startsWith(`${path}/`)) local.selected = "";
        await load(local.path || "");
      } catch (error) {
        local.error = error.message || String(error);
      }
      local.mutating = false;
      deps.render();
    }

    function openNewFile() {
      local.actionSheet = null;
      local.newFile = { value: "", error: "" };
      deps.render();
    }

    function setNewFileValue(value) {
      if (!local.newFile) return;
      local.newFile.value = String(value || "");
      syncSheetInputState();
    }

    function cancelNewFile() {
      if (!local.newFile) return;
      local.newFile = null;
      deps.render();
    }

    async function submitNewFile() {
      const draft = local.newFile;
      if (!draft || local.mutating) return;
      const name = draft.value.trim();
      if (!name) return;
      local.mutating = true;
      draft.error = "";
      deps.render();
      try {
        await deps.api("/api/file-browser/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cwd: cwd(), path: joinPath(local.path || "", name), content: "" }),
        });
        local.newFile = null;
        await load(local.path || "");
      } catch (error) {
        draft.error = error.message || String(error);
      }
      local.mutating = false;
      deps.render();
    }

    function joinPath(parent, name) {
      const clean = String(name || "").replace(/^\/+/, "");
      return parent ? `${parent.replace(/\/+$/, "")}/${clean}` : clean;
    }

    function syncSheetInputState() {
      // Keep the submit buttons' disabled state in sync without re-rendering
      // (a re-render would drop focus and the mobile keyboard).
      const renameOk = document.getElementById("mobileFileRenameSubmit");
      if (renameOk) renameOk.disabled = !local.rename || local.mutating;
      const newFileOk = document.getElementById("mobileFileNewSubmit");
      if (newFileOk) newFileOk.disabled = !local.newFile || !local.newFile.value.trim() || local.mutating;
    }

    function renderActionSheet() {
      const sheet = local.actionSheet;
      if (!sheet) return "";
      const isDir = sheet.kind === "dir";
      const name = Tree.basename(sheet.path) || sheet.path;
      return `<div class="mobile-sheet-backdrop" onclick="HerdrMobile.filesCloseActionSheet()"></div><div class="mobile-sheet" role="dialog" aria-modal="true" aria-label="Actions for ${deps.escapeHtml(name)}"><div class="mobile-sheet-handle"></div><p class="mobile-sheet-title">${deps.escapeHtml(name)}</p><button class="mobile-sheet-action" onclick="HerdrMobile.filesOpenRename(${JSON.stringify(encodeURIComponent(sheet.path))})">Rename</button><button class="mobile-sheet-action danger" onclick="HerdrMobile.filesDeletePath(${JSON.stringify(encodeURIComponent(sheet.path))})">Delete</button>${isDir ? `<button class="mobile-sheet-action" onclick="HerdrMobile.filesOpenNewFile()">New file here</button>` : ""}<button class="mobile-sheet-action" onclick="HerdrMobile.filesCloseActionSheet()">Cancel</button></div>`;
    }

    function renderRenameModal() {
      const rename = local.rename;
      if (!rename) return "";
      return `<div class="mobile-sheet-backdrop" onclick="HerdrMobile.filesCancelRename()"></div><div class="mobile-sheet" role="dialog" aria-modal="true" aria-label="Rename ${deps.escapeHtml(rename.name)}"><div class="mobile-sheet-handle"></div><p class="mobile-sheet-title">Rename ${deps.escapeHtml(rename.name)}</p><input id="mobileFileRenameInput" class="mobile-sheet-input" type="text" value="${deps.escapeHtml(rename.value)}" oninput="HerdrMobile.filesSetRenameValue(this.value)" onkeydown="if (event.key === 'Enter') { event.preventDefault(); HerdrMobile.filesSubmitRename(); } if (event.key === 'Escape') { event.preventDefault(); HerdrMobile.filesCancelRename(); }" autocomplete="off" spellcheck="false" />${rename.error ? `<div class="mobile-error">${deps.escapeHtml(rename.error)}</div>` : ""}<div class="mobile-sheet-actions"><button class="mobile-btn" onclick="HerdrMobile.filesCancelRename()">Cancel</button><button class="mobile-btn primary" id="mobileFileRenameSubmit" ${local.mutating ? "disabled" : ""} onclick="HerdrMobile.filesSubmitRename()">${local.mutating ? "Renaming…" : "Rename"}</button></div></div>`;
    }

    function renderNewFileModal() {
      const draft = local.newFile;
      if (!draft) return "";
      return `<div class="mobile-sheet-backdrop" onclick="HerdrMobile.filesCancelNewFile()"></div><div class="mobile-sheet" role="dialog" aria-modal="true" aria-label="New file"><div class="mobile-sheet-handle"></div><p class="mobile-sheet-title">New file in ${deps.escapeHtml(local.path || Tree.basename(cwd()) || "workspace")}</p><input id="mobileFileNewInput" class="mobile-sheet-input" type="text" placeholder="file name (e.g. notes.md)" value="${deps.escapeHtml(draft.value)}" oninput="HerdrMobile.filesSetNewFileValue(this.value)" onkeydown="if (event.key === 'Enter') { event.preventDefault(); HerdrMobile.filesSubmitNewFile(); } if (event.key === 'Escape') { event.preventDefault(); HerdrMobile.filesCancelNewFile(); }" autocomplete="off" spellcheck="false" />${draft.error ? `<div class="mobile-error">${deps.escapeHtml(draft.error)}</div>` : ""}<div class="mobile-sheet-actions"><button class="mobile-btn" onclick="HerdrMobile.filesCancelNewFile()">Cancel</button><button class="mobile-btn primary" id="mobileFileNewSubmit" ${local.mutating || !draft.value.trim() ? "disabled" : ""} onclick="HerdrMobile.filesSubmitNewFile()">${local.mutating ? "Creating…" : "Create"}</button></div></div>`;
    }

    function syncContentSearchOptions() {
      const opts = contentSearchOptions();
      local.contentSearch.minChars = opts.minChars;
      local.contentSearch.pageSize = opts.pageSize;
      local.contentSearch.contextLines = opts.contextLines;
      local.contentSearch.maxMatchesPerFile = opts.maxMatchesPerFile;
      local.contentSearch.autoCollapseFiles = opts.autoCollapseFiles;
      local.contentSearch.defaultExpanded = opts.defaultExpanded;
      local.contentSearch.matchCase = opts.matchCase;
      local.contentSearch.regex = opts.regex;
    }

    async function runContentSearch(append = false) {
      const root = cwd();
      const content = local.contentSearch;
      content.query = local.filter;
      syncContentSearchOptions();
      if (!root || content.query.trim().length < content.minChars) {
        content.active = true;
        clearContentSearchResults();
        content.done = true;
        content.error = content.query.trim() ? `Type at least ${content.minChars} characters to search file contents.` : "";
        deps.render();
        return;
      }
      content.active = true;
      const offset = append ? content.offset : 0;
      content.loading = true;
      content.error = "";
      deps.render();
      try {
        const data = await deps.api(`/api/file-browser/content-search?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(local.path || "")}&q=${encodeURIComponent(content.query.trim())}&offset=${offset}&limit=${content.pageSize}&context_lines=${content.contextLines}&max_matches_per_file=${content.maxMatchesPerFile}&match_case=${content.matchCase ? "true" : "false"}&regex=${content.regex ? "true" : "false"}`);
        const files = data.files || [];
        content.files = append ? content.files.concat(files) : files;
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
        content.error = error.message || String(error);
        content.done = true;
      }
      content.loading = false;
      deps.render();
    }

    function runUnifiedSearch(append = false) {
      if (!local.filter.trim()) {
        if (local.filterKind === "content") {
          local.contentSearch.query = "";
          clearContentSearchResults();
          deps.render();
        } else {
          load(local.path, true);
        }
        return;
      }
      if (local.filterKind === "content") {
        local.contentSearch.query = local.filter;
        local.contentSearch.active = true;
        runContentSearch(append);
      } else {
        loadFiltered(append);
      }
    }

    function contentFile(path) {
      return local.contentSearch.files.find((file) => file.path === path) || null;
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
      const root = cwd();
      const content = local.contentSearch;
      if (!root || !content.query.trim()) return;
      syncContentSearchOptions();
      const contextLines = Math.max(content.contextLines, Number(extraContext) || content.contextLines);
      const data = await deps.api(`/api/file-browser/content-search/file?cwd=${encodeURIComponent(root)}&file=${encodeURIComponent(path)}&q=${encodeURIComponent(content.query.trim())}&context_lines=${contextLines}&max_matches_per_file=500&match_case=${content.matchCase ? "true" : "false"}&regex=${content.regex ? "true" : "false"}`);
      if (!data.file) return;
      const index = local.contentSearch.files.findIndex((file) => file.path === path);
      if (index >= 0) local.contentSearch.files[index] = data.file;
      local.contentSearch.expanded[path] = true;
    }

    function renderScreen() {
      if (!cwd()) return '<div class="mobile-loading">Select workspace with path first</div>';
      if (!local.entries.length && !local.loading && !local.error) load(local.path || "");
      if (local.file) return renderPreview();
      const currentRow = Tree.renderCurrentDirectoryRow({ callback: "HerdrMobileFiles", canGoUp: canGoUp(), path: currentDirectoryPath(), label: currentDirectoryLabel(), title: currentDirectoryTitle() });
      const tree = currentRow + Tree.renderEntries(treeEntries(), { selectedPath: local.selected, callback: "HerdrMobileFiles", showMeta: true, rowActionMethod: "rowActions", rowActionLabel: "⋯" });
      const body = `<div class="mobile-files-list-head"><div class="mobile-help mobile-file-result-count">Use header search (⌕) to find workspaces, files, folders, or file contents.</div></div>${local.loading ? '<div class="mobile-loading">Loading</div>' : tree}`;
      return `<section class="mobile-section mobile-files" tabindex="0"><div class="mobile-files-head"><div><h2>Files</h2><p class="mobile-help">${deps.escapeHtml(local.path || cwd())}</p></div><div class="mobile-actions"><button class="mobile-btn" onclick="HerdrMobile.filesRefresh()">Refresh</button><button class="mobile-btn" onclick="HerdrMobile.filesOpenNewFile()">+ File</button></div></div>${local.error ? `<div class="mobile-error">${deps.escapeHtml(local.error)}</div>` : ""}${body}${renderActionSheet()}${renderRenameModal()}${renderNewFileModal()}</section>`;
    }

    function renderPreservingFocus() {
      const active = document.activeElement;
      const section = active && active.closest ? active.closest(".mobile-files") : null;
      const refocusFilter = active && active.id === "mobileFileFilter";
      const refocusSection = section && active === section;
      deps.render();
      setTimeout(() => {
        const nextInput = document.getElementById("mobileFileFilter");
        const nextSection = document.querySelector(".mobile-files");
        if (refocusFilter && nextInput) {
          nextInput.focus({ preventScroll: true });
        } else if (refocusSection && nextSection) {
          nextSection.focus({ preventScroll: true });
        }
      }, 0);
    }

    globalThis.HerdrMobileFilesContent = {
      setQuery(value) {
        local.filter = String(value || "");
        local.contentSearch.query = local.filter;
        clearTimeout(local.contentSearch.timer);
        local.contentSearch.timer = setTimeout(() => runContentSearch(false), 350);
      },
      inputKeydown(event) {
        if (!event) return;
        if (event.key === "Enter") { event.preventDefault(); runContentSearch(false); }
        if (event.key === "Escape") { event.preventDefault(); this.clear(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault();
      },
      run() { runContentSearch(false); },
      clear() {
        local.filter = "";
        local.contentSearch.query = "";
        local.contentSearch.files = [];
        local.contentSearch.expanded = {};
        local.contentSearch.error = "";
        local.contentSearch.done = true;
        local.contentSearch.offset = 0;
        deps.render();
      },
      loadMore() { runContentSearch(true); },
      toggleFile(encodedPath) {
        const path = decodeURIComponent(encodedPath);
        local.contentSearch.expanded[path] = !local.contentSearch.expanded[path];
        deps.render();
      },
      async loadFile(encodedPath) {
        const path = decodeURIComponent(encodedPath);
        try {
          await loadContentSearchFile(path);
          deps.render();
        } catch (error) {
          local.contentSearch.error = error.message || String(error);
          deps.render();
        }
      },
      openFile(encodedPath) { openFile(decodeURIComponent(encodedPath)); },
      openMatch(encodedPath, encodedMatchId) {
        const path = decodeURIComponent(encodedPath);
        const file = contentFile(path);
        const match = globalThis.HerdrContentSearch && globalThis.HerdrContentSearch.findMatch(file, decodeURIComponent(encodedMatchId));
        openFile(path, matchHighlight(match, local.contentSearch.query));
      },
      expandAll() {
        for (const file of local.contentSearch.files || []) local.contentSearch.expanded[file.path] = true;
        deps.render();
      },
      collapseAll() {
        for (const file of local.contentSearch.files || []) local.contentSearch.expanded[file.path] = false;
        deps.render();
      },
      async expandSnippet(encodedPath, _index, direction) {
        const path = decodeURIComponent(encodedPath);
        const currentContext = Number(local.contentSearch.contextLines || contentSearchOptions().contextLines || 2);
        const extra = globalThis.HerdrLineContext && globalThis.HerdrLineContext.nextContextSize
          ? globalThis.HerdrLineContext.nextContextSize(currentContext, { min: 3, max: 20 })
          : Math.min(20, currentContext < 3 ? 3 : currentContext * 2);
        try {
          await loadContentSearchFile(path, extra);
          local.contentSearch.contextLines = extra;
          deps.render();
        } catch (error) {
          local.contentSearch.error = error.message || String(error);
          deps.render();
        }
      },
    };

    function treeEntries() {
      const entries = local.entries.map((entry) => Object.assign({}, entry));
      return Tree.applyGitStatus(entries, local.gitStatus);
    }

    function currentDirectoryRoot() {
      return local.cwdOverride || deps.currentWorkspaceCwd() || "";
    }

    function currentDirectoryPath() {
      return local.path || currentDirectoryRoot();
    }

    function currentDirectoryLabel() {
      if (local.path) return Tree.basename(local.path);
      const root = currentDirectoryRoot();
      return Tree.basename(root) || root || "Files";
    }

    function currentDirectoryTitle() {
      const root = currentDirectoryRoot();
      return local.path ? `${root.replace(/\/+$/, "")}/${local.path}` : root;
    }

    function canGoUp() {
      const root = currentDirectoryRoot();
      return !!(local.path || (parentFoldersEnabled() && root && Tree.parentDirectory(root) !== root));
    }

    function fileBrowserDepth() {
      try {
        const parsed = globalThis.HerdrOptions ? globalThis.HerdrOptions.read() : {};
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
      const editing = local.editing;
      const editActions = editing
        ? `<button class="mobile-btn" onclick="HerdrMobile.filesCancelEdit()">Cancel</button><button class="mobile-btn primary" id="mobileFileSaveButton" ${local.saving ? "disabled" : ""} onclick="HerdrMobile.filesSaveFile()">${local.saving ? "Saving…" : "Save"}${local.dirty ? " ●" : ""}</button>`
        : canEditFile(file)
          ? `<button class="mobile-btn" onclick="HerdrMobile.filesStartEdit()">Edit</button>`
          : "";
      setTimeout(() => {
        const parent = document.getElementById("mobileFilePreview");
        if (parent && local.file) {
          const configured = editorOptions();
          if (local.editing) {
            Editor.create({ parent, path: local.file.path, content: local.draft || local.file.content || "", readonly: false, hideHeader: true, lineNumbers: lineNumbersEnabled(), wordWrap: configured.wordWrap, tabSize: configured.tabSize, bracketMatching: configured.bracketMatching, folding: configured.folding, activeLine: configured.activeLine, whitespace: configured.whitespace, markdownPreview: false, onChange(value) { local.draft = value; local.dirty = value !== (local.file.content || ""); syncPreviewDirtyState(); lspDidChange(local.file.path, value); } });
          } else {
            Editor.create({ parent, path: local.file.path, content: local.file.content || "", readonly: true, hideHeader: true, lineNumbers: lineNumbersEnabled(), wordWrap: configured.wordWrap, tabSize: configured.tabSize, bracketMatching: configured.bracketMatching, folding: configured.folding, activeLine: configured.activeLine, whitespace: configured.whitespace, markdownPreview: !local.file.searchHighlight, searchHighlight: local.file.searchHighlight || null, linesHtml: local.file.linesHtml || null, size: local.file.size });
          }
          lspDidOpen(local.file);
        }
      }, 0);
      return `<section class="mobile-section mobile-files"><h2>Files</h2><div class="mobile-actions"><button class="mobile-btn" onclick="HerdrMobile.filesBackToTree()">Back</button><button class="mobile-btn" onclick="HerdrMobile.filesRefreshFile()">Refresh</button>${editActions}<button class="mobile-btn" onclick="HerdrMobile.filesOpenActionSheet(${JSON.stringify(encodeURIComponent(file.path))}, 'file')">⋯</button></div><p class="mobile-help">${deps.escapeHtml(file.path || "")}${editing && local.dirty ? " — unsaved changes" : ""}</p>${local.error ? `<div class="mobile-error">${deps.escapeHtml(local.error)}</div>` : ""}${local.saveError ? `<div class="mobile-error">${deps.escapeHtml(local.saveError)}</div>` : ""}${body}${renderActionSheet()}${renderRenameModal()}${renderNewFileModal()}</section>`;
    }

    function syncPreviewDirtyState() {
      const saveButton = document.getElementById("mobileFileSaveButton");
      if (!saveButton) return;
      saveButton.textContent = local.saving ? "Saving…" : `Save${local.dirty ? " ●" : ""}`;
    }

    return {
      load,
      renderScreen,
      reset() {
        if (local.file && local.file.path) lspDidClose(local.file.path);
        local.path = "";
        local.entries = [];
        local.selected = "";
        local.file = null;
        local.error = "";
        local.filter = "";
        local.filterVisible = false;
        local.filterKind = "file";
        local.cwdOverride = "";
        local.editing = false;
        local.draft = "";
        local.dirty = false;
        local.saving = false;
        local.saveError = "";
        local.actionSheet = null;
        local.rename = null;
        local.newFile = null;
        local.mutating = false;
        local.contentSearch = createContentSearchState();
      },
      toggle(encodedPath) {
        if (!confirmDiscardDraft()) return;
        load(decodeURIComponent(encodedPath));
      },
      async select(encodedPath) {
        if (local.file && local.file.path === decodeURIComponent(encodedPath)) return;
        if (!confirmDiscardDraft()) return;
        await openFile(decodeURIComponent(encodedPath));
      },
        setFilterKind(kind) {
          local.filterKind = normalizeSearchScope(kind);
          local.filterVisible = true;
          if (local.filterKind === "content") local.contentSearch.active = !!local.filter.trim() || local.contentSearch.active;
          if (local.filter.trim()) runUnifiedSearch(false);
          else renderPreservingFocus();
        },
      toggleFilterKind() { this.setFilterKind(nextSearchScope(local.filterKind)); },
      up() {
        if (local.path) { load(Tree.parentPath(local.path)); return; }
        const wsCwd = deps.currentWorkspaceCwd() || "";
        const currentRoot = local.cwdOverride || wsCwd;
        if (!parentFoldersEnabled()) return;
        if (!currentRoot) return;
        const parent = Tree.parentDirectory(currentRoot);
        if (!parent || parent === currentRoot) return;
        local.cwdOverride = parent;
        local.path = "";
        local.entries = [];
        local.selected = "";
        load("");
      },
      refresh() { load(local.path); },
        filter(value) {
          local.filter = String(value || "");
          local.filterVisible = true;
          if (local.filterKind === "content") local.contentSearch.query = local.filter;
          clearTimeout(local.filterTimer);
          local.filterTimer = setTimeout(() => runUnifiedSearch(false), local.filterKind === "content" ? 350 : 500);
        },
        searchKeydown(event) {
          if (!event) return;
          if (event.key === "Enter") { event.preventDefault(); clearTimeout(local.filterTimer); runUnifiedSearch(false); }
          if (event.key === "Escape") { event.preventDefault(); this.clearFilter(); }
          if ((event.ctrlKey || event.metaKey) && event.key && event.key.toLowerCase() === "s") event.preventDefault();
        },
        clearFilter() {
          local.filter = "";
          local.contentSearch.query = "";
          clearContentSearchResults();
          local.filterVisible = local.contentSearch.active;
          clearTimeout(local.filterTimer);
          if (local.filterKind === "content") deps.render();
          else load(local.path, true);
        },
        showSearch() {
          local.filterVisible = true;
          renderPreservingFocus();
          setTimeout(() => document.getElementById("mobileFileFilter")?.focus(), 0);
        },
        focusTree() {
          local.filterVisible = true;
          renderPreservingFocus();
        },
        blurTree() {
          if (local.contentSearch.active || local.filter.trim()) return;
          local.filterVisible = false;
          deps.render();
        },
        toggleContentSearch() {
          this.setFilterKind("content");
          this.showSearch();
        },
        closeContentSearch() {
          local.contentSearch.active = false;
          deps.render();
        },
        loadMore() { runUnifiedSearch(true); },
      scroll(node) {
        local.scrollTop = node.scrollTop;
        if (local.filterKind === "content" || !local.filter.trim() || local.loading || local.filterDone) return;
        if (node.scrollTop + node.clientHeight >= node.scrollHeight - 80) loadFiltered(true);
      },
        typeToFilter(event) {
          if (!event || event.metaKey || event.ctrlKey || event.defaultPrevented) return;
          if (event.altKey && event.key && event.key.toLowerCase() === "f") { event.preventDefault(); this.setFilterKind("file"); return; }
          if (event.altKey && event.key && event.key.toLowerCase() === "d") { event.preventDefault(); this.setFilterKind("dir"); return; }
          if (event.altKey && event.key && event.key.toLowerCase() === "c") { event.preventDefault(); this.setFilterKind("content"); return; }
          if (event.altKey || event.defaultPrevented) return;
          if (event.target && event.target.closest && event.target.closest("input, textarea, select")) return;
          if (event.key === "Escape") {
            if (local.filter.trim()) {
              event.preventDefault();
              this.clearFilter();
            }
            return;
          }
          if (event.key === "Backspace") {
            event.preventDefault();
            this.filter(local.filter.slice(0, -1));
            return;
          }
          if (event.key.length !== 1) return;
          event.preventDefault();
          this.filter(local.filter + event.key);
        },
      async openAt(path, opts) {
        const options = opts || {};
        if (options.kind !== "dir" && local.file && local.file.path === path) return;
        if (!confirmDiscardDraft()) return;
        const preserveContext = options.preserveContext === true && options.kind !== "dir";
        if (!preserveContext) {
          local.filter = "";
          local.filterVisible = false;
          local.filterKind = "file";
          local.contentSearch.active = false;
          clearContentSearchResults();
        }
        if (options.kind === "dir") {
          await load(path || "");
          return;
        }
        if (!preserveContext) {
          const parent = Tree.parentPath(path || "");
          await load(parent || "");
        }
        if (path) await openFile(path, options.highlight || null);
      },
      backToTree() {
        if (!confirmDiscardDraft()) return;
        if (local.file && local.file.path) lspDidClose(local.file.path);
        local.file = null;
        local.editing = false;
        local.draft = "";
        local.dirty = false;
        deps.render();
      },
      refreshFile() {
        if (!local.file) return;
        if (!confirmDiscardDraft()) return;
        local.editing = false;
        openFile(local.file.path);
      },
      startEdit,
      cancelEdit,
      saveFile,
      rowActions: openActionSheet,
      closeActionSheet,
      openRename,
      setRenameValue,
      cancelRename,
      submitRename,
      deletePath,
      openNewFile,
      setNewFileValue,
      cancelNewFile,
      submitNewFile,
    };
  }

  globalThis.HerdrMobileFileBrowser = { create };
})();
